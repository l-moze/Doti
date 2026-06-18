import { createLLMClient, LLMClient, type LLMGenerationOptions, type RuntimeProviderProfile } from '../../llm/client';
import { RefinedContext } from '../memory/refine';
import {
    PreservedMarkdownStreamRestorer,
    restorePreservedMarkdownFragments,
} from '../../markdown-table-utils';
import { ThinkingTagStripper } from './thinking-stripper';

export class ActModule {
    private client: LLMClient;
    private model: string;

    constructor(providerId: string, model: string, runtimeProfile?: RuntimeProviderProfile) {
        this.client = createLLMClient(providerId, model, runtimeProfile);
        this.model = (runtimeProfile?.model || model || '').toLowerCase();
    }

    /**
     * Generates the System Prompt based on refined context.
     */
    private buildPrompt(context: RefinedContext, targetLang: string): string {
        const termTable = context.relevantTerms.length > 0
            ? `<glossary>
Here is a glossary of terms to be used in the translation:
| Source | Target |
|--------|--------|
${context.relevantTerms.map(t => `| ${t.source} | ${t.target} |`).join('\n')}
</glossary>`
            : "";

        const prevContext = context.previousContext
            ? `<context>
The following is the end of the immediately preceding translation. Ensure your translation flows naturally from this:
"...${context.previousContext}"
</context>`
            : "";

        return `
<role>You are a professional academic translator translating from English to ${targetLang}.</role>

<instruction>
Translate the content inside the <source_text> tags.
- Translate faithfully with minimal paraphrasing.
- Preserve strict Markdown structure (headers, lists, code blocks).
- Preserve HTML tags and attributes (especially IDs and classes).
- Preserve every placeholder token such as @@DOTI_HTML_TABLE_BLOCK_0001@@, @@DOTI_CODE_BLOCK_0002@@, or @@DOTI_MATH_INLINE_0003@@ exactly as-is, in the same order, with no added quotes, backticks, escaping, or punctuation changes.
- Do NOT translate, rewrite, reformat, reorder, or delete protected placeholders.
- Do NOT add any new section titles, bullet lists, code snippets, citations, tables, examples, or explanations that are not present in the source.
- Keep each heading level and heading count aligned with the source chunk.
- Use proper academic terminology.
- Do NOT output the <source_text> tags themselves.
- Return ONLY the translated Markdown content.
</instruction>

${termTable}

${prevContext}

<source_text>
${context.sourceText}
</source_text>
`;
    }

    private getTranslationGenerationOptions(): LLMGenerationOptions {
        const looksLikeSmallModel =
            /(?:^|[-_/])(1b|2b|3b|4b|6b|7b|8b|9b|10b|11b|12b|13b|14b)(?:$|[-_/.:])/i.test(this.model) ||
            this.model.includes('mini') ||
            this.model.includes('small');

        if (looksLikeSmallModel) {
            return { temperature: 0, topP: 1 };
        }

        return { temperature: 0.1, topP: 1 };
    }

    async translate(context: RefinedContext, targetLang: string = "Chinese"): Promise<string> {
        if (context.isReference) {
            console.log(`[Act] Skipping translation for reference chunk: ${context.chunkId}`);
            return restorePreservedMarkdownFragments(context.sourceText, context.preservedFragments);
        }

        const prompt = this.buildPrompt(context, targetLang);
        const restorer = new PreservedMarkdownStreamRestorer(context.preservedFragments);
        const stripper = new ThinkingTagStripper();
        const generationOptions = this.getTranslationGenerationOptions();

        let result = "";
        for await (const text of this.client.generateStream(prompt, generationOptions)) {
            const strippedText = stripper.consume(text);
            if (strippedText) {
                result += restorer.consume(strippedText);
            }
        }
        result += restorer.consume(stripper.consume("", true), true);
        return restorePreservedMarkdownFragments(result, context.preservedFragments);
    }

    // Streaming version for real-time display
    async * translateStream(context: RefinedContext, targetLang: string = "Chinese"): AsyncGenerator<string, void, unknown> {
        if (context.isReference) {
            yield restorePreservedMarkdownFragments(context.sourceText, context.preservedFragments);
            return;
        }

        const prompt = this.buildPrompt(context, targetLang);
        const restorer = new PreservedMarkdownStreamRestorer(context.preservedFragments);
        const stripper = new ThinkingTagStripper();
        const generationOptions = this.getTranslationGenerationOptions();

        for await (const text of this.client.generateStream(prompt, generationOptions)) {
            const strippedText = stripper.consume(text);
            if (!strippedText) continue;

            const restoredText = restorer.consume(strippedText);
            if (!restoredText) continue;

            // Rule-based formatting fix: Ensure headers have newlines before them
            const fixedText = restoredText.replace(/([^\n])\s*(#{1,6}\s)/g, '$1\n\n$2');
            yield fixedText;
        }

        const flushedText = restorer.consume(stripper.consume("", true), true);
        if (flushedText) {
            yield flushedText.replace(/([^\n])\s*(#{1,6}\s)/g, '$1\n\n$2');
        }
    }
}

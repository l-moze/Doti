import { createLLMClient, LLMClient, type RuntimeProviderProfile } from '../../llm/client';
import { RefinedContext } from '../memory/refine';
import {
    PreservedMarkdownStreamRestorer,
    restorePreservedMarkdownFragments,
} from '../../markdown-table-utils';

export class ActModule {
    private client: LLMClient;

    constructor(providerId: string, model: string, runtimeProfile?: RuntimeProviderProfile) {
        this.client = createLLMClient(providerId, model, runtimeProfile);
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
- Preserve strict Markdown structure (headers, lists, code blocks).
- Preserve HTML tags and attributes (especially IDs and classes).
- Preserve every placeholder token such as @@DOTI_HTML_TABLE_BLOCK_0001@@, @@DOTI_CODE_BLOCK_0002@@, or @@DOTI_MATH_INLINE_0003@@ exactly as-is, in the same order, with no added quotes, backticks, escaping, or punctuation changes.
- Do NOT translate, rewrite, reformat, reorder, or delete protected placeholders.
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

    async translate(context: RefinedContext, targetLang: string = "Chinese"): Promise<string> {
        if (context.isReference) {
            console.log(`[Act] Skipping translation for reference chunk: ${context.chunkId}`);
            return restorePreservedMarkdownFragments(context.sourceText, context.preservedFragments);
        }

        const prompt = this.buildPrompt(context, targetLang);
        const restorer = new PreservedMarkdownStreamRestorer(context.preservedFragments);

        let result = "";
        for await (const text of this.client.generateStream(prompt)) {
            result += restorer.consume(text);
        }
        result += restorer.consume("", true);
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

        for await (const text of this.client.generateStream(prompt)) {
            const restoredText = restorer.consume(text);
            if (!restoredText) continue;

            // Rule-based formatting fix: Ensure headers have newlines before them
            const fixedText = restoredText.replace(/([^\n])\s*(#{1,6}\s)/g, '$1\n\n$2');
            yield fixedText;
        }

        const flushedText = restorer.consume("", true);
        if (flushedText) {
            yield flushedText.replace(/([^\n])\s*(#{1,6}\s)/g, '$1\n\n$2');
        }
    }
}

import { Chunk } from '../think/chunker';
import { terminologyStore, Term } from './terminology-store';
import {
    protectMarkdownFragments,
    type PreservedMarkdownFragment,
} from '../../markdown-table-utils';

export interface RefinedContext {
    chunkId: string;
    sourceText: string;
    relevantTerms: Term[];
    previousContext: string; // Tail of previous translation
    isReference: boolean;
    preservedFragments: PreservedMarkdownFragment[];
}

export class RefineModule {

    /**
     * Prepares the context for translating a specific chunk.
     * @param chunk The identifying chunk.
     * @param previousTranslation The full or partial translated text of the previous chunk.
     */
    async process(chunk: Chunk, previousTranslation: string, extraTerms: Term[] = []): Promise<RefinedContext> {
        // 1. Retrieve Terminology
        // We ensure terms are loaded (lazy load check)
        await terminologyStore.load();
        const builtInTerms = terminologyStore.findTerms(chunk.content);
        const matchedExtraTerms = extraTerms.filter((term) =>
            chunk.content.toLowerCase().includes(term.source.toLowerCase())
        );
        const terms = dedupeTerms([...matchedExtraTerms, ...builtInTerms]);
        const { text: protectedSourceText, fragments: preservedFragments } = protectMarkdownFragments(chunk.content);

        // 2. Extract Previous Context
        // Take the last 500 characters of the previous translation to help with flow
        const contextLength = 500;
        const prevContextSnippet = previousTranslation
            ? previousTranslation.slice(-contextLength)
            : "";

        return {
            chunkId: chunk.id,
            sourceText: protectedSourceText,
            relevantTerms: terms,
            previousContext: prevContextSnippet,
            isReference: chunk.type === 'references',
            preservedFragments,
        };
    }
}

export const refineModule = new RefineModule();

function dedupeTerms(terms: Term[]): Term[] {
    const seen = new Set<string>();
    const result: Term[] = [];

    for (const term of terms) {
        const key = `${term.source.toLowerCase()}::${term.target.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(term);
    }

    return result;
}

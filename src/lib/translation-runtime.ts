export type TranslationBlockKind = 'text' | 'references';
export type TranslationBlockState = 'planned' | 'streaming' | 'completed' | 'cached';

export interface TranslationChunkPlan {
    id: string;
    index: number;
    title?: string;
    kind: TranslationBlockKind;
}

export interface TranslationMarkdownBlock extends TranslationChunkPlan {
    text: string;
    state: TranslationBlockState;
}

export function normalizeTranslationBlockText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function createTranslationBlocksFromPlan(
    plan: TranslationChunkPlan[],
    initialState: TranslationBlockState = 'planned'
): TranslationMarkdownBlock[] {
    return plan.map((chunk) => ({
        ...chunk,
        text: '',
        state: initialState,
    }));
}

export function buildMarkdownFromTranslationBlocks(blocks: TranslationMarkdownBlock[]): string {
    return blocks
        .map((block) => ({
            ...block,
            text: normalizeTranslationBlockText(block.text),
        }))
        .filter((block) => block.text.length > 0)
        .sort((a, b) => a.index - b.index)
        .map((block) => block.text)
        .join('\n\n');
}

export function createSingleTranslationBlock(text: string, title = 'Document'): TranslationMarkdownBlock[] {
    const normalizedText = normalizeTranslationBlockText(text);
    if (!normalizedText) return [];

    return [{
        id: 'full-document',
        index: 0,
        title,
        kind: 'text',
        text: normalizedText,
        state: 'completed',
    }];
}

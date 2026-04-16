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
        .filter((block) => block.text.trim().length > 0)
        .sort((a, b) => a.index - b.index)
        .map((block) => block.text)
        .join('\n\n');
}

export function createSingleTranslationBlock(text: string, title = 'Document'): TranslationMarkdownBlock[] {
    if (!text.trim()) return [];

    return [{
        id: 'full-document',
        index: 0,
        title,
        kind: 'text',
        text,
        state: 'completed',
    }];
}

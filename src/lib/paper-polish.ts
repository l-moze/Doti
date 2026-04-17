import { repairDanglingHtmlTables } from '@/lib/markdown-table-utils';

export type PaperPolishMode = 'light' | 'deep';
export type PaperPolishSource = 'content-list-v2' | 'layout' | 'markdown';

export type PaperPolishIssue =
    | 'blank-lines'
    | 'heading-spacing'
    | 'list-spacing'
    | 'soft-line-breaks'
    | 'media-interruptions'
    | 'figure-grouping'
    | 'algorithm-blocks'
    | 'dangling-tables'
    | 'ocr-noise';

export type PaperPolishStructuredBlockKind =
    | 'heading'
    | 'paragraph'
    | 'image'
    | 'table'
    | 'equation'
    | 'list'
    | 'footnote'
    | 'code'
    | 'other';

export type PaperPolishStructuredBlock = {
    id: string;
    kind: PaperPolishStructuredBlockKind;
    rawType: string;
    order: number;
    pageIndex: number;
    text: string;
    markdown: string;
    headingLevel?: number;
    captionText?: string;
    subfigureCaption?: string;
    groupCaption?: string;
    assetPath?: string | null;
    tableHtml?: string;
    children?: PaperPolishStructuredBlock[];
    sourceBlockIds?: string[];
};

export type PaperPolishResidualIssueKind =
    | 'media-interruption'
    | 'figure-grouping'
    | 'table-attachment'
    | 'unsupported-structure';

export type PaperPolishResidualIssue = {
    id: string;
    kind: PaperPolishResidualIssueKind;
    message: string;
    headingText?: string;
    blockIds: string[];
};

export type PaperPolishIssueWindow = {
    id: string;
    issueKind: PaperPolishResidualIssueKind;
    headingText?: string;
    currentMarkdown: string;
    contextMarkdown: string;
    structuredMarkdown: string;
    sourceBlockIds: string[];
};

export type PaperPolishResult = {
    markdown: string;
    changed: boolean;
    issues: PaperPolishIssue[];
    summary: string[];
    usedSource?: PaperPolishSource;
    residualIssues?: PaperPolishResidualIssue[];
    issueWindows?: PaperPolishIssueWindow[];
    canUseAiFallback?: boolean;
};

export type PaperPolishAnalysisResult = PaperPolishResult & {
    usedSource: PaperPolishSource;
    residualIssues: PaperPolishResidualIssue[];
    issueWindows: PaperPolishIssueWindow[];
    canUseAiFallback: boolean;
};

type MarkdownBlockKind =
    | 'blank'
    | 'paragraph'
    | 'heading'
    | 'list'
    | 'quote'
    | 'code'
    | 'figure'
    | 'table'
    | 'math'
    | 'html'
    | 'other';

type MarkdownBlock = {
    kind: MarkdownBlockKind;
    text: string;
};

type FigureGroupItem = {
    mediaHtml: string;
    caption: string;
    groupCaption?: string;
};

const BLOCK_BOUNDARY_PATTERN = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|!\[|<table\b|<\/?(?:figure|figcaption|table|thead|tbody|tfoot|tr|td|th|div|img)\b|```|~~~|\$\$|\\\[|\\begin\{|(?:Figure|Fig\.?|Table|图|表)\s*[\dA-Za-z]+(?:\s*[:：.-]|\s*$)|\([a-z]\)\s+)/i;
const SENTENCE_END_PATTERN = /[。！？!?;；:：.)\]）】"'`]\s*$/;
const CONTINUATION_START_PATTERN = /^(?:[a-z(（\[【"'`]|[0-9]+(?:[.)]|%|×)|et al\.|i\.e\.|e\.g\.|vs\.|[,:;)\]）】])/i;
const POSSIBLE_OCR_NOISE_PATTERN = /(?:^|\s)(?:[Il1|]{4,}|[A-Z0-9]{10,}|[^\s\p{L}\p{N}]{5,})(?:\s|$)/u;
const FIGURE_CAPTION_PATTERN = /^(?:Figure|Fig\.?|图)\s*[\dA-Za-z]+(?:\s*[\(:：.-]\s*[a-z]\)?)?/i;
const TABLE_CAPTION_PATTERN = /^(?:Table|TABLE|表)\s*[\dA-Za-z]+(?:\s*[:：.-]|\s*$)/i;
const SUBFIGURE_CAPTION_PATTERN = /^\([a-z]\)\s+/i;
const CODE_LIKE_PATTERN = /(?:^\s{4,}\S)|(?:\b(?:algorithm|procedure|input|output|initialize|repeat|until|return)\b)|(?:←|:=|=>|->)/i;
const MARKDOWN_IMAGE_LINE_PATTERN = /^!\[(.*?)\]\((\S+?)(?:\s+["'](.*?)["'])?\)\s*$/;
const SIMPLE_FORMAT_ISSUES = new Set<PaperPolishIssue>([
    'blank-lines',
    'heading-spacing',
    'list-spacing',
    'soft-line-breaks',
    'dangling-tables',
]);

function uniqueIssues(issues: PaperPolishIssue[]): PaperPolishIssue[] {
    return Array.from(new Set(issues));
}

function normalizeNewlines(markdown: string): string {
    return markdown.replace(/\r\n?/g, '\n');
}

function normalizeHeadingSpacing(markdown: string, issues: PaperPolishIssue[]): string {
    const next = markdown.replace(/^(#{1,6})([^\s#])/gm, '$1 $2');
    if (next !== markdown) {
        issues.push('heading-spacing');
    }
    return next;
}

function normalizeListSpacing(markdown: string, issues: PaperPolishIssue[]): string {
    const next = markdown
        .replace(/^(\s*[-*+])([^\s])/gm, '$1 $2')
        .replace(/^(\s*\d+[.)])([^\s])/gm, '$1 $2');

    if (next !== markdown) {
        issues.push('list-spacing');
    }

    return next;
}

function collapseBlankLines(markdown: string, issues: PaperPolishIssue[]): string {
    const next = markdown.replace(/\n{3,}/g, '\n\n').trim();
    if (next !== markdown.trim()) {
        issues.push('blank-lines');
    }
    return next;
}

function isFenceLine(line: string): boolean {
    return /^\s*(```|~~~)/.test(line);
}

function isMathFenceLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed === '$$' || trimmed === '\\[' || trimmed === '\\]';
}

function classifyBlock(text: string): MarkdownBlockKind {
    const trimmed = text.trim();
    if (!trimmed) return 'blank';
    if (/^\s*#{1,6}\s/.test(trimmed)) return 'heading';
    if (/^\s*(```|~~~)/.test(trimmed)) return 'code';
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(trimmed)) return 'list';
    if (/^\s*>\s+/.test(trimmed)) return 'quote';
    if (MARKDOWN_IMAGE_LINE_PATTERN.test(trimmed) || FIGURE_CAPTION_PATTERN.test(trimmed) || SUBFIGURE_CAPTION_PATTERN.test(trimmed)) return 'figure';
    if (TABLE_CAPTION_PATTERN.test(trimmed) || /^\s*<table\b/i.test(trimmed) || /^\s*\|/.test(trimmed)) return 'table';
    if (/^\s*<\/?(?:figure|figcaption|img)\b/i.test(trimmed)) return 'figure';
    if (/^\s*<\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col)\b/i.test(trimmed)) return 'table';
    if (/^\s*(?:\$\$|\\\[|\\begin\{)/.test(trimmed)) return 'math';
    if (/^\s*<\/?[a-z][^>]*>/i.test(trimmed)) return 'html';
    return 'paragraph';
}

function splitIntoBlocks(markdown: string): MarkdownBlock[] {
    const lines = normalizeNewlines(markdown).split('\n');
    const blocks: MarkdownBlock[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();

        if (!trimmed) {
            blocks.push({ kind: 'blank', text: '' });
            index += 1;
            continue;
        }

        if (isFenceLine(line)) {
            const blockLines = [line];
            const opener = line.trim().slice(0, 3);
            index += 1;

            while (index < lines.length) {
                blockLines.push(lines[index]);
                if (lines[index].trim().startsWith(opener)) {
                    index += 1;
                    break;
                }
                index += 1;
            }

            blocks.push({ kind: 'code', text: blockLines.join('\n') });
            continue;
        }

        if (isMathFenceLine(line)) {
            const blockLines = [line];
            const fence = line.trim();
            index += 1;

            while (index < lines.length) {
                blockLines.push(lines[index]);
                if (lines[index].trim() === (fence === '\\[' ? '\\]' : '$$')) {
                    index += 1;
                    break;
                }
                index += 1;
            }

            blocks.push({ kind: 'math', text: blockLines.join('\n') });
            continue;
        }

        const nextKind = classifyBlock(line);
        if (nextKind !== 'paragraph') {
            const blockLines = [line];
            index += 1;

            while (index < lines.length && lines[index].trim() && classifyBlock(lines[index]) === nextKind) {
                blockLines.push(lines[index]);
                index += 1;
            }

            blocks.push({ kind: nextKind, text: blockLines.join('\n') });
            continue;
        }

        const paragraphLines = [line];
        index += 1;

        while (index < lines.length) {
            const nextLine = lines[index];
            if (!nextLine.trim()) break;
            if (BLOCK_BOUNDARY_PATTERN.test(nextLine.trim())) break;
            paragraphLines.push(nextLine);
            index += 1;
        }

        blocks.push({ kind: 'paragraph', text: paragraphLines.join('\n') });
    }

    return blocks;
}

function normalizeParagraphLineBreaks(blockText: string): string {
    return blockText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function normalizeSoftLineBreaks(blocks: MarkdownBlock[], issues: PaperPolishIssue[]): MarkdownBlock[] {
    let changed = false;
    const next = blocks.map((block) => {
        if (block.kind !== 'paragraph') return block;
        const normalized = normalizeParagraphLineBreaks(block.text);
        if (normalized !== block.text.trim()) {
            changed = true;
        }
        return { ...block, text: normalized };
    });

    if (changed) {
        issues.push('soft-line-breaks');
    }

    return next;
}

function looksLikeParagraphContinuation(previous: string, next: string): boolean {
    const left = previous.trim();
    const right = next.trim();

    if (!left || !right) return false;
    if (SENTENCE_END_PATTERN.test(left)) return false;
    if (!CONTINUATION_START_PATTERN.test(right)) return false;
    if (right.length < 2) return false;
    return true;
}

function findNextNonBlankIndex(blocks: MarkdownBlock[], start: number): number {
    for (let index = start; index < blocks.length; index += 1) {
        if (blocks[index]?.kind !== 'blank') {
            return index;
        }
    }
    return -1;
}

function isFigureLikeBlock(block: MarkdownBlock | undefined): boolean {
    if (!block) return false;
    if (block.kind === 'figure') return true;
    if (block.kind === 'html' && /<(?:img|figure|figcaption)\b/i.test(block.text)) return true;
    return false;
}

function isTableLikeBlock(block: MarkdownBlock | undefined): boolean {
    if (!block) return false;
    if (block.kind === 'table') return true;
    if (block.kind === 'html' && /<(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col)\b/i.test(block.text)) return true;
    return false;
}

function isMediaRelatedBlock(block: MarkdownBlock | undefined): boolean {
    return isFigureLikeBlock(block) || isTableLikeBlock(block);
}

function findMediaClusterEnd(blocks: MarkdownBlock[], start: number): number {
    let cursor = start;
    let lastMediaIndex = -1;

    while (cursor < blocks.length) {
        const current = blocks[cursor];
        if (current.kind === 'blank') {
            cursor += 1;
            continue;
        }

        if (!isMediaRelatedBlock(current)) {
            break;
        }

        lastMediaIndex = cursor;
        cursor += 1;
    }

    return lastMediaIndex;
}

function mergeInterruptedParagraphs(blocks: MarkdownBlock[], issues: PaperPolishIssue[]): MarkdownBlock[] {
    const merged: MarkdownBlock[] = [];
    let changed = false;

    for (let index = 0; index < blocks.length; index += 1) {
        const current = blocks[index];
        if (current.kind !== 'paragraph') {
            merged.push({ ...current });
            continue;
        }

        const mediaClusterStart = findNextNonBlankIndex(blocks, index + 1);
        if (mediaClusterStart < 0 || !isMediaRelatedBlock(blocks[mediaClusterStart])) {
            merged.push({ ...current });
            continue;
        }

        const mediaClusterEnd = findMediaClusterEnd(blocks, mediaClusterStart);
        const nextParagraphIndex = mediaClusterEnd >= 0
            ? findNextNonBlankIndex(blocks, mediaClusterEnd + 1)
            : -1;
        const nextParagraph = nextParagraphIndex >= 0 ? blocks[nextParagraphIndex] : undefined;

        if (nextParagraph?.kind !== 'paragraph' || !looksLikeParagraphContinuation(current.text, nextParagraph.text)) {
            merged.push({ ...current });
            continue;
        }

        changed = true;
        merged.push({
            ...current,
            text: `${current.text} ${nextParagraph.text}`.replace(/\s{2,}/g, ' ').trim(),
        });

        for (let cursor = index + 1; cursor <= mediaClusterEnd; cursor += 1) {
            merged.push({ ...blocks[cursor] });
        }

        index = nextParagraphIndex;
    }

    if (changed) {
        issues.push('media-interruptions');
    }

    return merged;
}

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function markdownImageToHtml(line: string): string | null {
    const match = line.trim().match(MARKDOWN_IMAGE_LINE_PATTERN);
    if (!match) return null;

    const [, alt = '', src = '', title = ''] = match;
    return `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}"${title ? ` title="${escapeHtmlAttribute(title)}"` : ''} />`;
}

function parseFigureGroupItem(block: MarkdownBlock): FigureGroupItem | null {
    const trimmed = block.text.trim();
    if (!trimmed) return null;

    const lines = block.text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length === 0) return null;

    const imageHtml = markdownImageToHtml(lines[0]);
    if (imageHtml) {
        const captionLines = lines.slice(1);
        const groupCaptionIndex = captionLines.findIndex((line) => FIGURE_CAPTION_PATTERN.test(line));
        return {
            mediaHtml: imageHtml,
            caption: (groupCaptionIndex >= 0 ? captionLines.slice(0, groupCaptionIndex) : captionLines).join(' ').trim(),
            groupCaption: groupCaptionIndex >= 0 ? captionLines.slice(groupCaptionIndex).join(' ').trim() : '',
        };
    }

    if (/<img\b/i.test(trimmed) && !FIGURE_CAPTION_PATTERN.test(trimmed)) {
        return {
            mediaHtml: trimmed,
            caption: '',
        };
    }

    return null;
}

function renderFigureGroup(items: FigureGroupItem[], caption: string): string {
    const groupedItems = items
        .map((item) => `
<div data-doti-subfigure="true">
${item.mediaHtml}
${item.caption ? `<p data-doti-subcaption="true">${item.caption}</p>` : ''}
</div>`.trim())
        .join('\n');

    return `
<figure data-doti-figure-group="true">
<div data-doti-figure-grid="true">
${groupedItems}
</div>
${caption ? `<figcaption>${caption}</figcaption>` : ''}
</figure>`.trim();
}

function mergeFigureGroups(blocks: MarkdownBlock[], issues: PaperPolishIssue[]): MarkdownBlock[] {
    const merged: MarkdownBlock[] = [];
    let changed = false;

    for (let index = 0; index < blocks.length; index += 1) {
        const current = blocks[index];
        if (!isFigureLikeBlock(current)) {
            merged.push({ ...current });
            continue;
        }

        const figureBlocks: MarkdownBlock[] = [];
        let cursor = index;
        let clusterEnd = index;

        while (cursor < blocks.length) {
            const next = blocks[cursor];
            if (next.kind === 'blank') {
                clusterEnd = cursor;
                cursor += 1;
                continue;
            }
            if (!isFigureLikeBlock(next)) break;
            figureBlocks.push(next);
            clusterEnd = cursor;
            cursor += 1;
        }

        const items: FigureGroupItem[] = [];
        const groupCaptions: string[] = [];

        for (const figureBlock of figureBlocks) {
            const item = parseFigureGroupItem(figureBlock);
            if (item) {
                items.push(item);
                if (item.groupCaption) {
                    groupCaptions.push(item.groupCaption);
                }
                continue;
            }

            const trimmed = figureBlock.text.trim();
            if (SUBFIGURE_CAPTION_PATTERN.test(trimmed) && items.length > 0) {
                const previous = items[items.length - 1];
                previous.caption = previous.caption ? `${previous.caption} ${trimmed}` : trimmed;
                continue;
            }

            if (FIGURE_CAPTION_PATTERN.test(trimmed)) {
                groupCaptions.push(trimmed);
            }
        }

        const hasSubfigureCaptions = items.some((item) => Boolean(item.caption));
        if (items.length >= 2 && (groupCaptions.length > 0 || hasSubfigureCaptions)) {
            changed = true;
            merged.push({
                kind: 'figure',
                text: renderFigureGroup(items, groupCaptions.join(' ').trim()),
            });
            index = clusterEnd;
            continue;
        }

        merged.push({ ...current });
    }

    if (changed) {
        issues.push('figure-grouping');
    }

    return merged;
}

function normalizeAlgorithmBlocks(blocks: MarkdownBlock[], issues: PaperPolishIssue[]): MarkdownBlock[] {
    let changed = false;
    const next = blocks.map((block) => {
        if (block.kind !== 'paragraph') return block;
        const lines = block.text.split('\n');
        const looksLikeCode = lines.length > 1 && lines.every((line) => !line.trim() || CODE_LIKE_PATTERN.test(line));
        if (!looksLikeCode) return block;
        changed = true;
        return {
            kind: 'code' as const,
            text: `\`\`\`text\n${lines.map((line) => line.trimEnd()).join('\n')}\n\`\`\``,
        };
    });

    if (changed) {
        issues.push('algorithm-blocks');
    }

    return next;
}

function removeObviousOcrNoise(blocks: MarkdownBlock[], issues: PaperPolishIssue[]): MarkdownBlock[] {
    const filtered: MarkdownBlock[] = [];
    let changed = false;

    for (let index = 0; index < blocks.length; index += 1) {
        const current = blocks[index];
        if (current.kind !== 'paragraph') {
            filtered.push(current);
            continue;
        }

        const neighborKinds = [blocks[index - 1]?.kind, blocks[index + 1]?.kind];
        const isNearMedia = neighborKinds.includes('figure') || neighborKinds.includes('table');
        const normalized = current.text.trim();

        if (
            isNearMedia &&
            normalized.length <= 48 &&
            POSSIBLE_OCR_NOISE_PATTERN.test(normalized) &&
            !/[。！？!?]/.test(normalized)
        ) {
            changed = true;
            continue;
        }

        filtered.push(current);
    }

    if (changed) {
        issues.push('ocr-noise');
    }

    return filtered;
}

function joinBlocks(blocks: MarkdownBlock[]): string {
    const parts: string[] = [];

    for (const block of blocks) {
        if (block.kind === 'blank') {
            if (parts.at(-1) !== '') {
                parts.push('');
            }
            continue;
        }

        if (parts.length > 0 && parts.at(-1) !== '') {
            parts.push('');
        }

        parts.push(block.text.trimEnd());
    }

    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildSummary(issues: PaperPolishIssue[], changed: boolean): string[] {
    if (!changed) {
        return ['未发现需要大幅调整的格式问题，已完成一次安全整理。'];
    }

    const messages: Record<PaperPolishIssue, string> = {
        'blank-lines': '收紧了多余空行，让章节和正文间距更稳定。',
        'heading-spacing': '修正了标题标记后的缺失空格。',
        'list-spacing': '整理了列表项缩进和序号后的空格。',
        'soft-line-breaks': '合并了被 PDF 强行切断的软换行段落。',
        'media-interruptions': '合并了被图片或表格打断的连续段落。',
        'figure-grouping': '尝试把连续子图组合收拢为同一 Figure 块。',
        'algorithm-blocks': '把疑似算法/伪代码段规范成代码块。',
        'dangling-tables': '修复了不完整的 HTML 表格闭合。',
        'ocr-noise': '清理了紧邻图表的明显 OCR 噪声片段。',
    };

    return uniqueIssues(issues).map((issue) => messages[issue]);
}

export function runPaperPolishRules(markdown: string, mode: PaperPolishMode = 'light'): PaperPolishResult {
    const normalizedMarkdown = normalizeNewlines(markdown).trim();
    if (!normalizedMarkdown) {
        return {
            markdown: '',
            changed: false,
            issues: [],
            summary: ['当前文档为空，跳过格式整理。'],
        };
    }

    const issues: PaperPolishIssue[] = [];
    let nextMarkdown = normalizeHeadingSpacing(normalizedMarkdown, issues);
    nextMarkdown = normalizeListSpacing(nextMarkdown, issues);

    let blocks = splitIntoBlocks(nextMarkdown);
    blocks = normalizeSoftLineBreaks(blocks, issues);
    blocks = mergeInterruptedParagraphs(blocks, issues);
    blocks = mergeFigureGroups(blocks, issues);

    if (mode === 'deep') {
        blocks = normalizeAlgorithmBlocks(blocks, issues);
    }

    blocks = removeObviousOcrNoise(blocks, issues);

    nextMarkdown = joinBlocks(blocks);

    const repairedTables = repairDanglingHtmlTables(nextMarkdown);
    if (repairedTables !== nextMarkdown) {
        issues.push('dangling-tables');
        nextMarkdown = repairedTables;
    }

    nextMarkdown = collapseBlankLines(nextMarkdown, issues);

    const changed = nextMarkdown !== normalizedMarkdown;
    const unique = uniqueIssues(issues);

    return {
        markdown: nextMarkdown,
        changed,
        issues: unique,
        summary: buildSummary(unique, changed),
    };
}

type PaperPolishPromptInput = {
    issueWindow: PaperPolishIssueWindow;
    targetLang?: string;
    extraTerms?: Array<{ source: string; target: string; category?: string }>;
};

export function buildPaperPolishPrompt(input: PaperPolishPromptInput): string {
    const termLines = (input.extraTerms || [])
        .slice(0, 12)
        .map((term) => `- ${term.source} => ${term.target}${term.category ? ` (${term.category})` : ''}`)
        .join('\n');

    return [
        'You are PaperPolish, a markdown structure repair assistant for MinerU output.',
        'Repair only the target markdown window.',
        'Do not translate, summarize, or rewrite the paper semantics.',
        'Preserve formulas, tables, code, citations, terminology, and figure/table numbering exactly when possible.',
        'Output only the repaired markdown fragment with no explanation and no code fence.',
        'If the current target window is already acceptable, return it unchanged.',
        '',
        `Issue kind: ${input.issueWindow.issueKind}`,
        `Section: ${input.issueWindow.headingText || 'Unknown section'}`,
        input.targetLang ? `Document language target: ${input.targetLang}` : '',
        termLines ? 'Prefer these terminology mappings if you must touch adjacent prose:\n' + termLines : '',
        '',
        'Target window:',
        input.issueWindow.currentMarkdown,
        '',
        'Local context:',
        input.issueWindow.contextMarkdown,
        '',
        'Structured reference window:',
        input.issueWindow.structuredMarkdown,
    ].filter(Boolean).join('\n');
}

export function sanitizePaperPolishOutput(text: string): string {
    const normalized = text.trim();
    if (!normalized) return '';

    const fencedMatch = normalized.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
        return fencedMatch[1].trim();
    }

    const taggedMatch = normalized.match(/<(?:answer|result|markdown)>\s*([\s\S]*?)<\/(?:answer|result|markdown)>/i);
    if (taggedMatch?.[1]) {
        return taggedMatch[1].trim();
    }

    return normalized
        .replace(/^Here is the repaired markdown:\s*/i, '')
        .replace(/^Repaired markdown:\s*/i, '')
        .trim();
}

function buildStructuredBlocksFromContentList(contentList: unknown, assetPathPrefix?: string): PaperPolishStructuredBlock[] {
    const blocks: PaperPolishStructuredBlock[] = [];
    let order = 0;

    for (const [pageIndex, page] of asArray(contentList).entries()) {
        for (const item of asArray(page)) {
            if (!item || typeof item !== 'object') continue;
            const typedItem = item as { type?: unknown; content?: unknown };
            const rawType = typeof typedItem.type === 'string' ? typedItem.type : 'unknown';
            const content = typedItem.content && typeof typedItem.content === 'object'
                ? typedItem.content as Record<string, unknown>
                : {};

            if (rawType === 'page_number' || rawType === 'page_footer') {
                continue;
            }

            if (rawType === 'title') {
                const text = renderInlineNodes(content.title_content);
                if (!text) continue;
                const headingLevel = Math.min(6, Math.max(1, Number(content.level) || 1));
                blocks.push({
                    id: `pp-${pageIndex}-${order}`,
                    kind: 'heading',
                    rawType,
                    order: order++,
                    pageIndex,
                    text,
                    markdown: `${'#'.repeat(headingLevel)} ${text}`,
                    headingLevel,
                });
                continue;
            }

            if (rawType === 'paragraph' || rawType === 'page_aside_text' || rawType === 'page_footnote') {
                const sourceKey = rawType === 'paragraph'
                    ? 'paragraph_content'
                    : rawType === 'page_aside_text'
                        ? 'page_aside_text_content'
                        : 'page_footnote_content';
                const text = renderInlineNodes(content[sourceKey]);
                if (!text) continue;
                blocks.push({
                    id: `pp-${pageIndex}-${order}`,
                    kind: rawType === 'page_footnote' ? 'footnote' : 'paragraph',
                    rawType,
                    order: order++,
                    pageIndex,
                    text,
                    markdown: text,
                });
                continue;
            }

            if (rawType === 'list') {
                const markdown = asArray(content.list_items)
                    .map((item) => {
                        if (!item || typeof item !== 'object') return '';
                        const itemContent = renderInlineNodes((item as { item_content?: unknown }).item_content);
                        const normalized = itemContent.replace(/^[•\-*]\s*/, '').trim();
                        return normalized ? `- ${normalized}` : '';
                    })
                    .filter(Boolean)
                    .join('\n');
                if (!markdown) continue;
                blocks.push({
                    id: `pp-${pageIndex}-${order}`,
                    kind: 'list',
                    rawType,
                    order: order++,
                    pageIndex,
                    text: markdown.replace(/^- /gm, '').trim(),
                    markdown,
                });
                continue;
            }

            if (rawType === 'equation_interline') {
                const mathContent = typeof content.math_content === 'string' ? content.math_content.trim() : '';
                if (!mathContent) continue;
                blocks.push({
                    id: `pp-${pageIndex}-${order}`,
                    kind: 'equation',
                    rawType,
                    order: order++,
                    pageIndex,
                    text: mathContent,
                    markdown: `$$\n${mathContent}\n$$`,
                });
                continue;
            }

            if (rawType === 'code') {
                const codeContent = renderInlineNodes(content.code_content).replace(/\r\n?/g, '\n').trimEnd();
                if (!codeContent) continue;
                const captionText = renderInlineNodes(content.code_caption);
                const language = typeof content.code_language === 'string' ? content.code_language.trim() : '';
                const markdown = `${captionText ? `${captionText}\n\n` : ''}\`\`\`${language}\n${codeContent}\n\`\`\``;
                blocks.push({
                    id: `pp-${pageIndex}-${order}`,
                    kind: 'code',
                    rawType,
                    order: order++,
                    pageIndex,
                    text: codeContent,
                    markdown,
                    captionText,
                });
                continue;
            }

            if (rawType === 'image') {
                const captionText = renderInlineNodes(content.image_caption);
                const { subfigureCaption, groupCaption } = splitFigureCaption(captionText);
                const assetPath = resolveAssetPath(
                    (content.image_source as { path?: unknown } | undefined)?.path as string | undefined,
                    assetPathPrefix
                );
                const markdown = `${assetPath ? `![](${assetPath})` : ''}${captionText ? `  \n${captionText}` : ''}`.trim();
                blocks.push({
                    id: `pp-${pageIndex}-${order}`,
                    kind: 'image',
                    rawType,
                    order: order++,
                    pageIndex,
                    text: captionText,
                    markdown,
                    captionText,
                    subfigureCaption,
                    groupCaption,
                    assetPath,
                });
                continue;
            }

            if (rawType === 'table') {
                const captionText = renderInlineNodes(content.table_caption);
                const tableHtml = typeof content.html === 'string' ? content.html.trim() : '';
                const markdown = [captionText, tableHtml].filter(Boolean).join('\n\n').trim();
                if (!markdown) continue;
                blocks.push({
                    id: `pp-${pageIndex}-${order}`,
                    kind: 'table',
                    rawType,
                    order: order++,
                    pageIndex,
                    text: captionText,
                    markdown,
                    captionText,
                    tableHtml,
                });
                continue;
            }

            const fallbackText = renderInlineNodes(Object.values(content)[0]);
            if (!fallbackText) continue;
            blocks.push({
                id: `pp-${pageIndex}-${order}`,
                kind: 'other',
                rawType,
                order: order++,
                pageIndex,
                text: fallbackText,
                markdown: fallbackText,
            });
        }
    }

    return blocks;
}

function buildStructuredBlocksFromLayout(layout: unknown): PaperPolishStructuredBlock[] {
    const blocks: PaperPolishStructuredBlock[] = [];
    let order = 0;

    const visit = (node: unknown, pageIndex = 0) => {
        if (Array.isArray(node)) {
            for (const entry of node) {
                visit(entry, pageIndex);
            }
            return;
        }

        if (!node || typeof node !== 'object') return;

        const typedNode = node as {
            type?: unknown;
            spans?: unknown;
            content?: unknown;
            blocks?: unknown;
        };
        const rawType = typeof typedNode.type === 'string' ? typedNode.type : '';
        const spanText = asArray(typedNode.spans)
            .map((span) => extractNodeContent(span))
            .join(' ')
            .replace(/\s{2,}/g, ' ')
            .trim();

        if (rawType === 'image_caption' || rawType === 'table_caption') {
            if (spanText) {
                blocks.push({
                    id: `pp-${pageIndex}-${order}`,
                    kind: rawType === 'image_caption' ? 'image' : 'table',
                    rawType,
                    order: order++,
                    pageIndex,
                    text: spanText,
                    markdown: spanText,
                    captionText: spanText,
                    groupCaption: rawType === 'image_caption' ? spanText : undefined,
                });
            }
        } else if (rawType === 'text' || rawType === 'title') {
            if (spanText) {
                blocks.push({
                    id: `pp-${pageIndex}-${order}`,
                    kind: rawType === 'title' ? 'heading' : 'paragraph',
                    rawType,
                    order: order++,
                    pageIndex,
                    text: spanText,
                    markdown: rawType === 'title' ? `## ${spanText}` : spanText,
                    headingLevel: rawType === 'title' ? 2 : undefined,
                });
            }
        }

        visit(typedNode.blocks, pageIndex);
        for (const value of Object.values(typedNode)) {
            if (value !== typedNode.blocks && value !== typedNode.spans) {
                visit(value, pageIndex);
            }
        }
    };

    visit(layout);
    return blocks;
}

function asArray<T = unknown>(value: unknown): T[] {
    return Array.isArray(value) ? value as T[] : [];
}

function extractNodeContent(node: unknown): string {
    if (!node || typeof node !== 'object') return '';
    const content = 'content' in node ? (node as { content?: unknown }).content : undefined;
    return typeof content === 'string' ? content : '';
}

function renderInlineNodes(nodes: unknown): string {
    return asArray(nodes)
        .map((node) => {
            if (!node || typeof node !== 'object') return '';
            const typedNode = node as { type?: unknown; content?: unknown };
            const content = typeof typedNode.content === 'string' ? typedNode.content : '';
            if (!content) return '';
            if (typedNode.type === 'equation_inline') {
                return `$${content.trim()}$`;
            }
            return content;
        })
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function resolveAssetPath(assetPath: string | null | undefined, assetPathPrefix?: string): string {
    if (!assetPath) return '';
    const trimmed = assetPath.trim().replace(/\\/g, '/');
    if (!trimmed) return '';
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(trimmed) || trimmed.startsWith('/')) {
        return trimmed;
    }
    const normalizedPrefix = assetPathPrefix?.replace(/\/+$/, '') || '';
    const normalizedPath = trimmed.replace(/^\.?\//, '').replace(/^\/+/, '');
    return normalizedPrefix ? `${normalizedPrefix}/${normalizedPath}` : normalizedPath;
}

function splitFigureCaption(captionText: string): { subfigureCaption: string; groupCaption: string } {
    const normalized = captionText.trim();
    if (!normalized) {
        return { subfigureCaption: '', groupCaption: '' };
    }

    const groupCaptionIndex = normalized.search(/(?:Figure|Fig\.?|图)\s*[\dA-Za-z]+(?:\s*[:：.-])/i);
    if (groupCaptionIndex > 0) {
        return {
            subfigureCaption: normalized.slice(0, groupCaptionIndex).trim(),
            groupCaption: normalized.slice(groupCaptionIndex).trim(),
        };
    }

    if (SUBFIGURE_CAPTION_PATTERN.test(normalized)) {
        return { subfigureCaption: normalized, groupCaption: '' };
    }

    if (FIGURE_CAPTION_PATTERN.test(normalized)) {
        return { subfigureCaption: '', groupCaption: normalized };
    }

    return { subfigureCaption: normalized, groupCaption: '' };
}

function buildStructuredFigureHtml(items: PaperPolishStructuredBlock[], caption: string): string {
    return renderFigureGroup(
        items.map((item) => ({
            mediaHtml: item.assetPath ? `<img src="${escapeHtmlAttribute(item.assetPath)}" alt="" />` : '',
            caption: item.subfigureCaption || item.captionText || '',
        })),
        caption
    );
}

function mergeStructuredFigureGroups(blocks: PaperPolishStructuredBlock[], issues: PaperPolishIssue[]): PaperPolishStructuredBlock[] {
    const merged: PaperPolishStructuredBlock[] = [];
    let changed = false;

    for (let index = 0; index < blocks.length; index += 1) {
        const current = blocks[index];
        if (current.kind !== 'image' || current.rawType === 'figure_group') {
            merged.push(current);
            continue;
        }

        const cluster: PaperPolishStructuredBlock[] = [];
        let cursor = index;
        let clusterEnd = index;

        while (cursor < blocks.length && blocks[cursor].kind === 'image' && blocks[cursor].rawType !== 'figure_group') {
            cluster.push(blocks[cursor]);
            clusterEnd = cursor;
            cursor += 1;
        }

        const totalCaption = cluster.map((block) => block.groupCaption || '').find(Boolean) || '';
        const subfigureCount = cluster.filter((block) => Boolean(block.subfigureCaption)).length;

        if (cluster.length >= 2 && (Boolean(totalCaption) || subfigureCount >= 2)) {
            changed = true;
            const first = cluster[0];
            merged.push({
                ...first,
                id: `${first.id}-group`,
                rawType: 'figure_group',
                text: totalCaption || cluster.map((block) => block.subfigureCaption || block.captionText || '').join(' ').trim(),
                markdown: buildStructuredFigureHtml(cluster, totalCaption),
                captionText: totalCaption,
                groupCaption: totalCaption,
                children: cluster,
                sourceBlockIds: cluster.map((block) => block.id),
            });
            index = clusterEnd;
            continue;
        }

        merged.push(...cluster);
        index = clusterEnd;
    }

    if (changed) {
        issues.push('figure-grouping');
    }

    return merged;
}

function isStructuredMediaBlock(block: PaperPolishStructuredBlock | undefined): boolean {
    return Boolean(block && (block.kind === 'image' || block.kind === 'table'));
}

function mergeStructuredMediaInterruptedParagraphs(blocks: PaperPolishStructuredBlock[], issues: PaperPolishIssue[]): PaperPolishStructuredBlock[] {
    const merged: PaperPolishStructuredBlock[] = [];
    let changed = false;

    for (let index = 0; index < blocks.length; index += 1) {
        const current = blocks[index];
        if (current.kind !== 'paragraph') {
            merged.push(current);
            continue;
        }

        const clusterStart = index + 1;
        if (!isStructuredMediaBlock(blocks[clusterStart])) {
            merged.push(current);
            continue;
        }

        let clusterEnd = clusterStart;
        while (clusterEnd + 1 < blocks.length && isStructuredMediaBlock(blocks[clusterEnd + 1])) {
            clusterEnd += 1;
        }

        const nextParagraph = blocks[clusterEnd + 1];
        if (nextParagraph?.kind !== 'paragraph' || !looksLikeParagraphContinuation(current.text, nextParagraph.text)) {
            merged.push(current);
            continue;
        }

        changed = true;
        merged.push({
            ...current,
            text: `${current.text} ${nextParagraph.text}`.replace(/\s{2,}/g, ' ').trim(),
            markdown: `${current.text} ${nextParagraph.text}`.replace(/\s{2,}/g, ' ').trim(),
        });
        for (let cursor = clusterStart; cursor <= clusterEnd; cursor += 1) {
            merged.push(blocks[cursor]);
        }
        index = clusterEnd + 1;
    }

    if (changed) {
        issues.push('media-interruptions');
    }

    return merged;
}

function joinStructuredBlocks(blocks: PaperPolishStructuredBlock[]): string {
    return blocks
        .map((block) => block.markdown.trim())
        .filter(Boolean)
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getNearestHeadingText(blocks: PaperPolishStructuredBlock[], index: number): string | undefined {
    for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (blocks[cursor]?.kind === 'heading') {
            return blocks[cursor].text;
        }
    }
    return undefined;
}

function collectStructuredResidualIssues(
    blocks: PaperPolishStructuredBlock[],
    source: PaperPolishSource,
    markdownFallbackIssues: PaperPolishIssue[]
): PaperPolishResidualIssue[] {
    const residualIssues: PaperPolishResidualIssue[] = [];

    for (let index = 0; index < blocks.length; index += 1) {
        const current = blocks[index];
        if (current.kind === 'image' && current.rawType !== 'figure_group') {
            const cluster: PaperPolishStructuredBlock[] = [];
            let cursor = index;
            while (cursor < blocks.length && blocks[cursor].kind === 'image' && blocks[cursor].rawType !== 'figure_group') {
                cluster.push(blocks[cursor]);
                cursor += 1;
            }

            const subfigureLike = cluster.filter((block) => Boolean(block.subfigureCaption || block.groupCaption)).length;
            if (cluster.length >= 2 && subfigureLike >= 2) {
                residualIssues.push({
                    id: `figure-${current.id}`,
                    kind: 'figure-grouping',
                    message: '存在连续子图但仍未稳定收拢为同一组图。',
                    headingText: getNearestHeadingText(blocks, index),
                    blockIds: cluster.map((block) => block.id),
                });
            }
            index = cursor - 1;
        }

        if (current.kind === 'paragraph' && isStructuredMediaBlock(blocks[index + 1])) {
            let clusterEnd = index + 1;
            while (clusterEnd + 1 < blocks.length && isStructuredMediaBlock(blocks[clusterEnd + 1])) {
                clusterEnd += 1;
            }
            const nextParagraph = blocks[clusterEnd + 1];
            if (nextParagraph?.kind === 'paragraph' && looksLikeParagraphContinuation(current.text, nextParagraph.text)) {
                residualIssues.push({
                    id: `interrupt-${current.id}`,
                    kind: 'media-interruption',
                    message: '图表簇之间仍存在疑似跨页续句未闭合。',
                    headingText: getNearestHeadingText(blocks, index),
                    blockIds: [current.id, ...blocks.slice(index + 1, clusterEnd + 1).map((block) => block.id), nextParagraph.id],
                });
            }
        }
    }

    if (source === 'layout' && blocks.length > 0) {
        residualIssues.push({
            id: 'layout-fallback',
            kind: 'unsupported-structure',
            message: '当前仅拿到 layout.json，已保留最小结构信息，复杂块仍建议局部 AI 兜底。',
            headingText: getNearestHeadingText(blocks, Math.min(2, blocks.length - 1)),
            blockIds: blocks.slice(0, Math.min(3, blocks.length)).map((block) => block.id),
        });
    }

    if (source === 'markdown' && markdownFallbackIssues.some((issue) => !SIMPLE_FORMAT_ISSUES.has(issue))) {
        residualIssues.push({
            id: 'markdown-fallback',
            kind: 'unsupported-structure',
            message: '缺少结构化 JSON，当前仅完成纯 Markdown 规则整理。',
            blockIds: [],
        });
    }

    return residualIssues;
}

function buildIssueWindows(blocks: PaperPolishStructuredBlock[], residualIssues: PaperPolishResidualIssue[]): PaperPolishIssueWindow[] {
    return residualIssues.map((issue) => {
        const blockIndexes = issue.blockIds
            .map((blockId) => blocks.findIndex((block) => block.id === blockId))
            .filter((index) => index >= 0);
        const startIndex = blockIndexes.length > 0 ? Math.max(0, Math.min(...blockIndexes) - 1) : 0;
        const endIndex = blockIndexes.length > 0 ? Math.min(blocks.length - 1, Math.max(...blockIndexes) + 1) : Math.min(blocks.length - 1, 1);
        const currentStart = blockIndexes.length > 0 ? Math.min(...blockIndexes) : startIndex;
        const currentEnd = blockIndexes.length > 0 ? Math.max(...blockIndexes) : endIndex;
        const currentBlocks = blocks.slice(currentStart, currentEnd + 1);
        const contextBlocks = blocks.slice(startIndex, endIndex + 1);

        return {
            id: issue.id,
            issueKind: issue.kind,
            headingText: issue.headingText,
            currentMarkdown: joinStructuredBlocks(currentBlocks),
            contextMarkdown: joinStructuredBlocks(contextBlocks),
            structuredMarkdown: joinStructuredBlocks(currentBlocks),
            sourceBlockIds: currentBlocks.map((block) => block.id),
        };
    }).filter((window) => Boolean(window.currentMarkdown.trim()));
}

function buildStructuredSummary(
    issues: PaperPolishIssue[],
    changed: boolean,
    source: PaperPolishSource,
    residualIssues: PaperPolishResidualIssue[]
): string[] {
    const summary = buildSummary(issues, changed);
    if (source === 'content-list-v2') {
        summary.unshift('已优先利用 MinerU 的结构化 JSON 修复图表、标题与正文顺序。');
    } else if (source === 'layout') {
        summary.unshift('当前缺少 content_list_v2，已尽量利用 layout.json 做结构修复。');
    }

    if (residualIssues.length > 0) {
        summary.push(`发现 ${residualIssues.length} 处疑难结构，已保留 AI 深修兜底能力。`);
    }

    return Array.from(new Set(summary.filter(Boolean)));
}

export function runPaperPolishAnalysis(input: {
    markdown: string;
    mode?: PaperPolishMode;
    contentList?: unknown;
    layout?: unknown;
    assetPathPrefix?: string;
}): PaperPolishAnalysisResult {
    const mode = input.mode || 'light';
    const normalizedMarkdown = normalizeNewlines(input.markdown).trim();

    if (input.contentList) {
        const rawBlocks = buildStructuredBlocksFromContentList(input.contentList, input.assetPathPrefix);
        const issues: PaperPolishIssue[] = [];
        const blocks = mergeStructuredMediaInterruptedParagraphs(
            mergeStructuredFigureGroups(rawBlocks, issues),
            issues
        );
        const markdown = joinStructuredBlocks(blocks);
        const residualIssues = collectStructuredResidualIssues(blocks, 'content-list-v2', []);
        const issueWindows = buildIssueWindows(blocks, residualIssues);
        return {
            markdown,
            changed: markdown !== normalizedMarkdown,
            issues: uniqueIssues(issues),
            summary: buildStructuredSummary(uniqueIssues(issues), markdown !== normalizedMarkdown, 'content-list-v2', residualIssues),
            usedSource: 'content-list-v2',
            residualIssues,
            issueWindows,
            canUseAiFallback: issueWindows.length > 0,
        };
    }

    if (input.layout) {
        const blocks = buildStructuredBlocksFromLayout(input.layout);
        if (blocks.length > 0) {
            const markdown = joinStructuredBlocks(blocks);
            const fallback = runPaperPolishRules(markdown || normalizedMarkdown, mode);
            const residualIssues = collectStructuredResidualIssues(blocks, 'layout', fallback.issues);
            const issueWindows = buildIssueWindows(blocks, residualIssues);
            return {
                markdown: fallback.markdown,
                changed: fallback.markdown !== normalizedMarkdown,
                issues: fallback.issues,
                summary: buildStructuredSummary(fallback.issues, fallback.changed, 'layout', residualIssues),
                usedSource: 'layout',
                residualIssues,
                issueWindows,
                canUseAiFallback: issueWindows.length > 0,
            };
        }
    }

    const fallback = runPaperPolishRules(normalizedMarkdown, mode);
    const residualIssues = collectStructuredResidualIssues([], 'markdown', fallback.issues);
    return {
        markdown: fallback.markdown,
        changed: fallback.changed,
        issues: fallback.issues,
        summary: buildStructuredSummary(fallback.issues, fallback.changed, 'markdown', residualIssues),
        usedSource: 'markdown',
        residualIssues,
        issueWindows: [],
        canUseAiFallback: false,
    };
}

export function shouldUsePaperPolishModel(input: {
    analysis: Pick<PaperPolishAnalysisResult, 'canUseAiFallback' | 'issueWindows' | 'residualIssues'>;
}): { useModel: boolean; reason: string } {
    if (!input.analysis.canUseAiFallback) {
        return { useModel: false, reason: 'no-residual-issues' };
    }

    if (input.analysis.issueWindows.length === 0) {
        return { useModel: false, reason: 'no-issue-windows' };
    }

    return {
        useModel: true,
        reason: input.analysis.residualIssues[0]?.kind || 'local-analysis-requested-fallback',
    };
}

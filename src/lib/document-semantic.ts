import { repairDanglingHtmlTables } from '@/lib/markdown-table-utils';

export type DocumentStructureSource = 'content-list-v2' | 'layout' | 'markdown';

export type DocumentSemanticKind =
    | 'heading'
    | 'paragraph'
    | 'figure'
    | 'table'
    | 'equation'
    | 'list'
    | 'code'
    | 'footnote'
    | 'other';

export type DocumentSemanticContentType =
    | 'title'
    | 'text'
    | 'image'
    | 'table'
    | 'formula'
    | 'list'
    | 'code';

export type DocumentSemanticBBox = [number, number, number, number];

export type DocumentSemanticChild = {
    id: string;
    pageIndex: number;
    bbox: DocumentSemanticBBox | null;
    assetPath?: string | null;
    captionText?: string;
    subfigureCaption?: string;
    groupCaption?: string;
    markdown: string;
    sourceRefs: string[];
};

export type DocumentSemanticAnchor = {
    id: string;
    semanticId: string;
    blockId: string;
    pageIndex: number;
    bbox: DocumentSemanticBBox;
    kind: DocumentSemanticKind;
    rawType: string;
    sourceRefs: string[];
};

export type DocumentSemanticBlock = {
    id: string;
    semanticId: string;
    kind: DocumentSemanticKind;
    semanticType: DocumentSemanticContentType;
    sectionIndex: number;
    orderInSection: number;
    pageIndex: number;
    bbox: DocumentSemanticBBox | null;
    markdown: string;
    text: string;
    headingLevel?: number;
    captionText?: string;
    subfigureCaption?: string;
    groupCaption?: string;
    assetPath?: string | null;
    tableHtml?: string;
    children: DocumentSemanticChild[];
    sourceRefs: string[];
    anchorIds: string[];
};

export type DocumentSemanticTocItem = {
    level: number;
    text: string;
    semanticId: string;
};

export type DocumentSemanticProjection = {
    source: DocumentStructureSource;
    lowFidelity: boolean;
    blocks: DocumentSemanticBlock[];
    anchors: DocumentSemanticAnchor[];
    toc: DocumentSemanticTocItem[];
    pageSizes: Record<number, [number, number]>;
};

type RawSemanticAnchor = {
    pageIndex: number;
    bbox: DocumentSemanticBBox | null;
    rawType: string;
    sourceRefs: string[];
};

type RawSemanticBlock = {
    id: string;
    kind: DocumentSemanticKind;
    rawType: string;
    pageIndex: number;
    text: string;
    markdown: string;
    bbox: DocumentSemanticBBox | null;
    headingLevel?: number;
    captionText?: string;
    subfigureCaption?: string;
    groupCaption?: string;
    assetPath?: string | null;
    tableHtml?: string;
    children: DocumentSemanticChild[];
    sourceRefs: string[];
    anchors: RawSemanticAnchor[];
};

type MarkdownFallbackBlockKind =
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

type MarkdownFallbackBlock = {
    kind: MarkdownFallbackBlockKind;
    text: string;
};

const BLOCK_BOUNDARY_PATTERN = /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|!\[|<table\b|<\/?(?:figure|figcaption|table|thead|tbody|tfoot|tr|td|th|div|img)\b|```|~~~|\$\$|\\\[|\\begin\{|(?:Figure|Fig\.?|Table|图|表)\s*[\dA-Za-z]+(?:\s*[:：.-]|\s*$)|\([a-z]\)\s+)/i;
const SENTENCE_END_PATTERN = /[。！？!?;；:：.)\]）】"'`]\s*$/;
const CONTINUATION_START_PATTERN = /^(?:[a-z(（\[【"'`]|[0-9]+(?:[.)]|%|×)|et al\.|i\.e\.|e\.g\.|vs\.|[,:;)\]）】])/i;
const FIGURE_CAPTION_PATTERN = /^(?:Figure|Fig\.?|图)\s*[\dA-Za-z]+(?:\s*[\(:：.-]\s*[a-z]\)?)?/i;
const TABLE_CAPTION_PATTERN = /^(?:Table|TABLE|表)\s*[\dA-Za-z]+(?:\s*[:：.-]|\s*$)/i;
const SUBFIGURE_CAPTION_PATTERN = /^\([a-z]\)\s+/i;
const MARKDOWN_IMAGE_LINE_PATTERN = /^!\[(.*?)\]\((\S+?)(?:\s+["'](.*?)["'])?\)\s*$/;

function asArray<T = unknown>(value: unknown): T[] {
    return Array.isArray(value) ? value as T[] : [];
}

function normalizeNewlines(value: string): string {
    return value.replace(/\r\n?/g, '\n');
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function toBBox(value: unknown): DocumentSemanticBBox | null {
    if (!Array.isArray(value) || value.length < 4) return null;
    const bbox = value.slice(0, 4).map((entry) => Number(entry));
    if (bbox.some((entry) => !Number.isFinite(entry))) return null;
    return [bbox[0], bbox[1], bbox[2], bbox[3]];
}

function mergeBBox(a: DocumentSemanticBBox | null, b: DocumentSemanticBBox | null): DocumentSemanticBBox | null {
    if (!a) return b;
    if (!b) return a;
    return [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[2], b[2]),
        Math.max(a[3], b[3]),
    ];
}

function unionBBox(boxes: Array<DocumentSemanticBBox | null | undefined>): DocumentSemanticBBox | null {
    let merged: DocumentSemanticBBox | null = null;
    for (const box of boxes) {
        merged = mergeBBox(merged, box || null);
    }
    return merged;
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

function semanticTypeForKind(kind: DocumentSemanticKind): DocumentSemanticContentType {
    if (kind === 'heading') return 'title';
    if (kind === 'figure') return 'image';
    if (kind === 'table') return 'table';
    if (kind === 'equation') return 'formula';
    if (kind === 'list') return 'list';
    if (kind === 'code') return 'code';
    return 'text';
}

function buildSemanticId(
    sectionIndex: number,
    semanticType: DocumentSemanticContentType,
    counters: Record<DocumentSemanticContentType, number>
): string {
    if (semanticType === 'title') {
        return `sec-${sectionIndex}-title-0`;
    }

    const count = counters[semanticType];
    counters[semanticType] = count + 1;
    return `sec-${sectionIndex}-${semanticType}-${count}`;
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

function classifyMarkdownFallbackBlock(text: string): MarkdownFallbackBlockKind {
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

function isFenceLine(line: string): boolean {
    return /^\s*(```|~~~)/.test(line);
}

function isMathFenceLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed === '$$' || trimmed === '\\[' || trimmed === '\\]';
}

function splitMarkdownIntoFallbackBlocks(markdown: string): MarkdownFallbackBlock[] {
    const lines = normalizeNewlines(repairDanglingHtmlTables(markdown)).split('\n');
    const blocks: MarkdownFallbackBlock[] = [];
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
            const opener = line.trim().slice(0, 3);
            const blockLines = [line];
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
            const fence = line.trim();
            const blockLines = [line];
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

        const kind = classifyMarkdownFallbackBlock(line);
        if (kind !== 'paragraph') {
            const blockLines = [line];
            index += 1;
            while (index < lines.length && lines[index].trim() && classifyMarkdownFallbackBlock(lines[index]) === kind) {
                blockLines.push(lines[index]);
                index += 1;
            }
            blocks.push({ kind, text: blockLines.join('\n') });
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

function buildRawBlocksFromMarkdown(markdown: string): RawSemanticBlock[] {
    const fallbackBlocks = splitMarkdownIntoFallbackBlocks(markdown);
    const rawBlocks: RawSemanticBlock[] = [];
    let order = 0;

    for (const block of fallbackBlocks) {
        if (!block.text.trim()) continue;
        const id = `md-${order}`;

        if (block.kind === 'heading') {
            const match = block.text.trim().match(/^(#{1,6})\s+(.+)$/);
            const text = match?.[2]?.trim() || block.text.trim();
            rawBlocks.push({
                id,
                kind: 'heading',
                rawType: 'heading',
                pageIndex: 0,
                text,
                markdown: block.text.trim(),
                bbox: null,
                headingLevel: match ? match[1].length : 2,
                children: [],
                sourceRefs: [id],
                anchors: [],
            });
            order += 1;
            continue;
        }

        if (block.kind === 'figure') {
            const lines = block.text.split('\n').map((line) => line.trim()).filter(Boolean);
            const imageLine = lines.find((line) => MARKDOWN_IMAGE_LINE_PATTERN.test(line));
            const captionText = lines.filter((line) => !MARKDOWN_IMAGE_LINE_PATTERN.test(line)).join(' ').trim();
            const assetPath = imageLine?.match(MARKDOWN_IMAGE_LINE_PATTERN)?.[2] || '';
            const { subfigureCaption, groupCaption } = splitFigureCaption(captionText);
            rawBlocks.push({
                id,
                kind: 'figure',
                rawType: 'figure',
                pageIndex: 0,
                text: captionText || normalizeWhitespace(block.text),
                markdown: block.text.trim(),
                bbox: null,
                captionText,
                subfigureCaption,
                groupCaption,
                assetPath: assetPath || null,
                children: [],
                sourceRefs: [id],
                anchors: [],
            });
            order += 1;
            continue;
        }

        if (block.kind === 'table') {
            const normalized = block.text.trim();
            const captionMatch = normalized.split('\n').find((line) => TABLE_CAPTION_PATTERN.test(line.trim())) || '';
            rawBlocks.push({
                id,
                kind: 'table',
                rawType: 'table',
                pageIndex: 0,
                text: captionMatch.trim(),
                markdown: normalized,
                bbox: null,
                captionText: captionMatch.trim(),
                tableHtml: /^\s*<table\b/i.test(normalized) ? normalized : undefined,
                children: [],
                sourceRefs: [id],
                anchors: [],
            });
            order += 1;
            continue;
        }

        if (block.kind === 'list') {
            rawBlocks.push({
                id,
                kind: 'list',
                rawType: 'list',
                pageIndex: 0,
                text: normalizeWhitespace(block.text.replace(/^[-*+]\s+/gm, '')),
                markdown: block.text.trim(),
                bbox: null,
                children: [],
                sourceRefs: [id],
                anchors: [],
            });
            order += 1;
            continue;
        }

        if (block.kind === 'code') {
            rawBlocks.push({
                id,
                kind: 'code',
                rawType: 'code',
                pageIndex: 0,
                text: block.text.trim(),
                markdown: block.text.trim(),
                bbox: null,
                children: [],
                sourceRefs: [id],
                anchors: [],
            });
            order += 1;
            continue;
        }

        if (block.kind === 'math') {
            rawBlocks.push({
                id,
                kind: 'equation',
                rawType: 'equation',
                pageIndex: 0,
                text: block.text.trim(),
                markdown: block.text.trim(),
                bbox: null,
                children: [],
                sourceRefs: [id],
                anchors: [],
            });
            order += 1;
            continue;
        }

        rawBlocks.push({
            id,
            kind: block.kind === 'quote' ? 'other' : 'paragraph',
            rawType: block.kind,
            pageIndex: 0,
            text: normalizeWhitespace(block.text),
            markdown: block.kind === 'paragraph' ? normalizeWhitespace(block.text) : block.text.trim(),
            bbox: null,
            children: [],
            sourceRefs: [id],
            anchors: [],
        });
        order += 1;
    }

    return mergeMediaInterruptedParagraphs(mergeFigureGroups(rawBlocks));
}

function buildRawBlocksFromContentList(contentList: unknown, assetPathPrefix?: string): RawSemanticBlock[] {
    const blocks: RawSemanticBlock[] = [];
    let order = 0;

    for (const [pageIndex, page] of asArray(contentList).entries()) {
        for (const item of asArray(page)) {
            if (!item || typeof item !== 'object') continue;
            const typedItem = item as { type?: unknown; content?: unknown; bbox?: unknown };
            const rawType = typeof typedItem.type === 'string' ? typedItem.type : 'unknown';
            const content = typedItem.content && typeof typedItem.content === 'object'
                ? typedItem.content as Record<string, unknown>
                : {};
            const bbox = toBBox(typedItem.bbox);
            const sourceId = `cl-${pageIndex}-${order}`;
            const anchors = bbox ? [{ pageIndex, bbox, rawType, sourceRefs: [sourceId] }] : [];

            if (rawType === 'page_number' || rawType === 'page_footer' || rawType === 'header' || rawType === 'footer') {
                order += 1;
                continue;
            }

            if (rawType === 'title') {
                const text = renderInlineNodes(content.title_content);
                if (!text) {
                    order += 1;
                    continue;
                }
                const headingLevel = Math.min(6, Math.max(1, Number(content.level) || 1));
                blocks.push({
                    id: sourceId,
                    kind: 'heading',
                    rawType,
                    pageIndex,
                    text,
                    markdown: `${'#'.repeat(headingLevel)} ${text}`,
                    bbox,
                    headingLevel,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'paragraph' || rawType === 'page_aside_text' || rawType === 'page_footnote') {
                const sourceKey = rawType === 'paragraph'
                    ? 'paragraph_content'
                    : rawType === 'page_aside_text'
                        ? 'page_aside_text_content'
                        : 'page_footnote_content';
                const text = renderInlineNodes(content[sourceKey]);
                if (!text) {
                    order += 1;
                    continue;
                }
                blocks.push({
                    id: sourceId,
                    kind: rawType === 'page_footnote' ? 'footnote' : 'paragraph',
                    rawType,
                    pageIndex,
                    text,
                    markdown: text,
                    bbox,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'list') {
                const markdown = asArray(content.list_items)
                    .map((entry) => {
                        if (!entry || typeof entry !== 'object') return '';
                        const itemContent = renderInlineNodes((entry as { item_content?: unknown }).item_content);
                        const normalized = itemContent.replace(/^[•\-*]\s*/, '').trim();
                        return normalized ? `- ${normalized}` : '';
                    })
                    .filter(Boolean)
                    .join('\n');
                if (!markdown) {
                    order += 1;
                    continue;
                }
                blocks.push({
                    id: sourceId,
                    kind: 'list',
                    rawType,
                    pageIndex,
                    text: markdown.replace(/^- /gm, '').trim(),
                    markdown,
                    bbox,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'equation_interline') {
                const mathContent = typeof content.math_content === 'string' ? content.math_content.trim() : '';
                if (!mathContent) {
                    order += 1;
                    continue;
                }
                blocks.push({
                    id: sourceId,
                    kind: 'equation',
                    rawType,
                    pageIndex,
                    text: mathContent,
                    markdown: `$$\n${mathContent}\n$$`,
                    bbox,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'code') {
                const codeContent = renderInlineNodes(content.code_content).replace(/\r\n?/g, '\n').trimEnd();
                if (!codeContent) {
                    order += 1;
                    continue;
                }
                const captionText = renderInlineNodes(content.code_caption);
                const language = typeof content.code_language === 'string' ? content.code_language.trim() : '';
                const markdown = `${captionText ? `${captionText}\n\n` : ''}\`\`\`${language}\n${codeContent}\n\`\`\``;
                blocks.push({
                    id: sourceId,
                    kind: 'code',
                    rawType,
                    pageIndex,
                    text: codeContent,
                    markdown,
                    bbox,
                    captionText,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'image') {
                const captionText = renderInlineNodes(content.image_caption);
                const { subfigureCaption, groupCaption } = splitFigureCaption(captionText);
                const assetPath = resolveAssetPath(
                    (content.image_source as { path?: unknown } | undefined)?.path as string | undefined,
                    assetPathPrefix
                );
                blocks.push({
                    id: sourceId,
                    kind: 'figure',
                    rawType,
                    pageIndex,
                    text: captionText,
                    markdown: `${assetPath ? `![](${assetPath})` : ''}${captionText ? `\n\n${captionText}` : ''}`.trim(),
                    bbox,
                    captionText,
                    subfigureCaption,
                    groupCaption,
                    assetPath: assetPath || null,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'table') {
                const captionText = renderInlineNodes(content.table_caption);
                const tableHtml = typeof content.html === 'string' ? content.html.trim() : '';
                const markdown = [captionText, tableHtml].filter(Boolean).join('\n\n').trim();
                if (!markdown) {
                    order += 1;
                    continue;
                }
                blocks.push({
                    id: sourceId,
                    kind: 'table',
                    rawType,
                    pageIndex,
                    text: captionText,
                    markdown,
                    bbox,
                    captionText,
                    tableHtml,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            const fallbackText = renderInlineNodes(Object.values(content)[0]);
            if (fallbackText) {
                blocks.push({
                    id: sourceId,
                    kind: 'other',
                    rawType,
                    pageIndex,
                    text: fallbackText,
                    markdown: fallbackText,
                    bbox,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
            }
            order += 1;
        }
    }

    return mergeMediaInterruptedParagraphs(mergeFigureGroups(blocks));
}

function extractLayoutSpanText(block: unknown): string {
    if (!block || typeof block !== 'object') return '';
    const typedBlock = block as { lines?: unknown };
    return asArray(typedBlock.lines)
        .flatMap((line) => asArray((line as { spans?: unknown }).spans))
        .map((span) => {
            if (!span || typeof span !== 'object') return '';
            const content = (span as { content?: unknown }).content;
            return typeof content === 'string' ? content : '';
        })
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function extractLayoutImagePath(block: unknown): string {
    if (!block || typeof block !== 'object') return '';
    const typedBlock = block as { lines?: unknown };
    for (const line of asArray(typedBlock.lines)) {
        for (const span of asArray((line as { spans?: unknown }).spans)) {
            if (!span || typeof span !== 'object') continue;
            const imagePath = (span as { image_path?: unknown }).image_path;
            if (typeof imagePath === 'string' && imagePath.trim()) {
                return imagePath.trim();
            }
        }
    }
    return '';
}

function buildRawBlocksFromLayout(layout: unknown, assetPathPrefix?: string): RawSemanticBlock[] {
    const root = layout && typeof layout === 'object' ? layout as { pdf_info?: unknown } : null;
    const pages = asArray(root?.pdf_info);
    const blocks: RawSemanticBlock[] = [];
    let order = 0;

    for (const page of pages) {
        if (!page || typeof page !== 'object') continue;
        const typedPage = page as { page_idx?: unknown; para_blocks?: unknown };
        const pageIndex = Number(typedPage.page_idx);
        const safePageIndex = Number.isFinite(pageIndex) ? pageIndex : 0;

        for (const block of asArray(typedPage.para_blocks)) {
            if (!block || typeof block !== 'object') continue;
            const typedBlock = block as { type?: unknown; bbox?: unknown; blocks?: unknown };
            const rawType = typeof typedBlock.type === 'string' ? typedBlock.type : 'unknown';
            const bbox = toBBox(typedBlock.bbox);
            const sourceId = `layout-${safePageIndex}-${order}`;
            const anchors = bbox ? [{ pageIndex: safePageIndex, bbox, rawType, sourceRefs: [sourceId] }] : [];

            if (['header', 'footer', 'page_number', 'discarded'].includes(rawType)) {
                order += 1;
                continue;
            }

            if (rawType === 'title') {
                const text = extractLayoutSpanText(block);
                if (!text) {
                    order += 1;
                    continue;
                }
                blocks.push({
                    id: sourceId,
                    kind: 'heading',
                    rawType,
                    pageIndex: safePageIndex,
                    text,
                    markdown: `## ${text}`,
                    bbox,
                    headingLevel: 2,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'image') {
                const nestedBlocks = asArray(typedBlock.blocks);
                const captionBlock = nestedBlocks.find((entry) => (entry as { type?: unknown }).type === 'image_caption');
                const captionText = extractLayoutSpanText(captionBlock);
                const imageBody = nestedBlocks.find((entry) => (entry as { type?: unknown }).type === 'image_body') || block;
                const imagePath = resolveAssetPath(extractLayoutImagePath(imageBody), assetPathPrefix);
                const { subfigureCaption, groupCaption } = splitFigureCaption(captionText);
                blocks.push({
                    id: sourceId,
                    kind: 'figure',
                    rawType,
                    pageIndex: safePageIndex,
                    text: captionText,
                    markdown: `${imagePath ? `![](${imagePath})` : ''}${captionText ? `\n\n${captionText}` : ''}`.trim(),
                    bbox,
                    captionText,
                    subfigureCaption,
                    groupCaption,
                    assetPath: imagePath || null,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'table') {
                const nestedBlocks = asArray(typedBlock.blocks);
                const captionBlock = nestedBlocks.find((entry) => (entry as { type?: unknown }).type === 'table_caption');
                const captionText = extractLayoutSpanText(captionBlock);
                blocks.push({
                    id: sourceId,
                    kind: 'table',
                    rawType,
                    pageIndex: safePageIndex,
                    text: captionText,
                    markdown: captionText || '',
                    bbox,
                    captionText,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'interline_equation' || rawType === 'equation') {
                const text = extractLayoutSpanText(block);
                if (!text) {
                    order += 1;
                    continue;
                }
                blocks.push({
                    id: sourceId,
                    kind: 'equation',
                    rawType,
                    pageIndex: safePageIndex,
                    text,
                    markdown: `$$\n${text}\n$$`,
                    bbox,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'list') {
                const text = extractLayoutSpanText(block);
                if (!text) {
                    order += 1;
                    continue;
                }
                blocks.push({
                    id: sourceId,
                    kind: 'list',
                    rawType,
                    pageIndex: safePageIndex,
                    text,
                    markdown: text
                        .split(/\s{2,}|\n/)
                        .map((entry) => entry.trim())
                        .filter(Boolean)
                        .map((entry) => `- ${entry}`)
                        .join('\n'),
                    bbox,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'page_footnote') {
                const text = extractLayoutSpanText(block);
                if (!text) {
                    order += 1;
                    continue;
                }
                blocks.push({
                    id: sourceId,
                    kind: 'footnote',
                    rawType,
                    pageIndex: safePageIndex,
                    text,
                    markdown: text,
                    bbox,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
                order += 1;
                continue;
            }

            if (rawType === 'text') {
                const text = extractLayoutSpanText(block);
                if (!text) {
                    order += 1;
                    continue;
                }
                const captionLike = normalizeWhitespace(text);
                if (FIGURE_CAPTION_PATTERN.test(captionLike)) {
                    blocks.push({
                        id: sourceId,
                        kind: 'figure',
                        rawType: 'image_caption',
                        pageIndex: safePageIndex,
                        text: captionLike,
                        markdown: captionLike,
                        bbox,
                        captionText: captionLike,
                        groupCaption: captionLike,
                        children: [],
                        sourceRefs: [sourceId],
                        anchors,
                    });
                } else if (TABLE_CAPTION_PATTERN.test(captionLike)) {
                    blocks.push({
                        id: sourceId,
                        kind: 'table',
                        rawType: 'table_caption',
                        pageIndex: safePageIndex,
                        text: captionLike,
                        markdown: captionLike,
                        bbox,
                        captionText: captionLike,
                        children: [],
                        sourceRefs: [sourceId],
                        anchors,
                    });
                } else {
                    blocks.push({
                        id: sourceId,
                        kind: 'paragraph',
                        rawType,
                        pageIndex: safePageIndex,
                        text: captionLike,
                        markdown: captionLike,
                        bbox,
                        children: [],
                        sourceRefs: [sourceId],
                        anchors,
                    });
                }
                order += 1;
                continue;
            }

            const fallbackText = extractLayoutSpanText(block);
            if (fallbackText) {
                blocks.push({
                    id: sourceId,
                    kind: 'other',
                    rawType,
                    pageIndex: safePageIndex,
                    text: fallbackText,
                    markdown: fallbackText,
                    bbox,
                    children: [],
                    sourceRefs: [sourceId],
                    anchors,
                });
            }
            order += 1;
        }
    }

    return mergeMediaInterruptedParagraphs(mergeFigureGroups(blocks));
}

function mergeFigureGroups(blocks: RawSemanticBlock[]): RawSemanticBlock[] {
    const merged: RawSemanticBlock[] = [];

    for (let index = 0; index < blocks.length; index += 1) {
        const current = blocks[index];
        if (current.kind !== 'figure') {
            merged.push(current);
            continue;
        }

        const cluster: RawSemanticBlock[] = [];
        let cursor = index;
        let clusterEnd = index;
        while (cursor < blocks.length && blocks[cursor].kind === 'figure') {
            cluster.push(blocks[cursor]);
            clusterEnd = cursor;
            cursor += 1;
        }

        const totalCaption = cluster.map((block) => block.groupCaption || '').find(Boolean) || '';
        const subfigureCount = cluster.filter((block) => Boolean(block.subfigureCaption)).length;

        if (cluster.length >= 2 && (Boolean(totalCaption) || subfigureCount >= 2)) {
            const first = cluster[0];
            const children: DocumentSemanticChild[] = cluster.map((block) => ({
                id: `${block.id}:child`,
                pageIndex: block.pageIndex,
                bbox: block.bbox,
                assetPath: block.assetPath,
                captionText: block.captionText,
                subfigureCaption: block.subfigureCaption,
                groupCaption: block.groupCaption,
                markdown: block.markdown,
                sourceRefs: [...block.sourceRefs],
            }));
            merged.push({
                ...first,
                id: `${first.id}-group`,
                rawType: 'figure_group',
                text: totalCaption || cluster.map((block) => block.subfigureCaption || block.captionText || '').join(' ').trim(),
                markdown: cluster.map((block) => block.markdown).filter(Boolean).join('\n\n'),
                bbox: unionBBox(cluster.map((block) => block.bbox)),
                captionText: totalCaption,
                groupCaption: totalCaption,
                assetPath: null,
                children,
                sourceRefs: cluster.flatMap((block) => block.sourceRefs),
                anchors: cluster.flatMap((block) => block.anchors),
            });
            index = clusterEnd;
            continue;
        }

        merged.push(...cluster);
        index = clusterEnd;
    }

    return merged;
}

function isMediaBlock(block: RawSemanticBlock | undefined): boolean {
    return Boolean(block && (block.kind === 'figure' || block.kind === 'table'));
}

function mergeMediaInterruptedParagraphs(blocks: RawSemanticBlock[]): RawSemanticBlock[] {
    const merged: RawSemanticBlock[] = [];

    for (let index = 0; index < blocks.length; index += 1) {
        const current = blocks[index];
        if (current.kind !== 'paragraph') {
            merged.push(current);
            continue;
        }

        const clusterStart = index + 1;
        if (!isMediaBlock(blocks[clusterStart])) {
            merged.push(current);
            continue;
        }

        let clusterEnd = clusterStart;
        while (clusterEnd + 1 < blocks.length && isMediaBlock(blocks[clusterEnd + 1])) {
            clusterEnd += 1;
        }

        const nextParagraph = blocks[clusterEnd + 1];
        if (nextParagraph?.kind !== 'paragraph' || !looksLikeParagraphContinuation(current.text, nextParagraph.text)) {
            merged.push(current);
            continue;
        }

        merged.push({
            ...current,
            text: `${current.text} ${nextParagraph.text}`.replace(/\s{2,}/g, ' ').trim(),
            markdown: `${current.markdown} ${nextParagraph.markdown}`.replace(/\s{2,}/g, ' ').trim(),
            bbox: unionBBox([current.bbox, nextParagraph.bbox]),
            sourceRefs: [...current.sourceRefs, ...nextParagraph.sourceRefs],
            anchors: [...current.anchors, ...nextParagraph.anchors],
        });

        for (let cursor = clusterStart; cursor <= clusterEnd; cursor += 1) {
            merged.push(blocks[cursor]);
        }

        index = clusterEnd + 1;
    }

    return merged;
}

function assignSemanticMetadata(blocks: RawSemanticBlock[]): DocumentSemanticProjection {
    const semanticBlocks: DocumentSemanticBlock[] = [];
    const anchors: DocumentSemanticAnchor[] = [];
    const toc: DocumentSemanticTocItem[] = [];
    let sectionIndex = -1;
    let orderInSection = 0;
    let counters: Record<DocumentSemanticContentType, number> = {
        title: 0,
        text: 0,
        image: 0,
        table: 0,
        formula: 0,
        list: 0,
        code: 0,
    };

    for (const block of blocks) {
        if (block.kind === 'heading') {
            sectionIndex += 1;
            orderInSection = 0;
            counters = { title: 0, text: 0, image: 0, table: 0, formula: 0, list: 0, code: 0 };
            const semanticId = `sec-${sectionIndex}-title-0`;
            const anchorIds = block.anchors.flatMap((anchor, index) => {
                if (!anchor.bbox) return [];
                const anchorId = `${block.id}:anchor:${index}`;
                anchors.push({
                    id: anchorId,
                    semanticId,
                    blockId: block.id,
                    pageIndex: anchor.pageIndex,
                    bbox: anchor.bbox,
                    kind: block.kind,
                    rawType: anchor.rawType,
                    sourceRefs: [...anchor.sourceRefs],
                });
                return [anchorId];
            });
            semanticBlocks.push({
                id: block.id,
                semanticId,
                kind: block.kind,
                semanticType: 'title',
                sectionIndex: Math.max(sectionIndex, 0),
                orderInSection,
                pageIndex: block.pageIndex,
                bbox: block.bbox,
                markdown: block.markdown,
                text: block.text,
                headingLevel: block.headingLevel || 2,
                children: block.children,
                sourceRefs: [...block.sourceRefs],
                anchorIds,
            });
            toc.push({
                level: block.headingLevel || 2,
                text: block.text,
                semanticId,
            });
            orderInSection += 1;
            continue;
        }

        const safeSectionIndex = Math.max(sectionIndex, 0);
        const semanticType = semanticTypeForKind(block.kind);
        const semanticId = buildSemanticId(safeSectionIndex, semanticType, counters);
        const anchorIds = block.anchors.flatMap((anchor, index) => {
            if (!anchor.bbox) return [];
            const anchorId = `${block.id}:anchor:${index}`;
            anchors.push({
                id: anchorId,
                semanticId,
                blockId: block.id,
                pageIndex: anchor.pageIndex,
                bbox: anchor.bbox,
                kind: block.kind,
                rawType: anchor.rawType,
                sourceRefs: [...anchor.sourceRefs],
            });
            return [anchorId];
        });

        semanticBlocks.push({
            id: block.id,
            semanticId,
            kind: block.kind,
            semanticType,
            sectionIndex: safeSectionIndex,
            orderInSection,
            pageIndex: block.pageIndex,
            bbox: block.bbox,
            markdown: block.markdown,
            text: block.text,
            captionText: block.captionText,
            subfigureCaption: block.subfigureCaption,
            groupCaption: block.groupCaption,
            assetPath: block.assetPath,
            tableHtml: block.tableHtml,
            children: block.children,
            sourceRefs: [...block.sourceRefs],
            anchorIds,
        });
        orderInSection += 1;
    }

    return {
        source: 'markdown',
        lowFidelity: true,
        blocks: semanticBlocks,
        anchors,
        toc,
        pageSizes: {},
    };
}

export function extractPageSizes(layout: unknown): Record<number, [number, number]> {
    const pageSizes: Record<number, [number, number]> = {};
    const root = layout && typeof layout === 'object' ? layout as { pdf_info?: unknown } : null;

    for (const page of asArray(root?.pdf_info)) {
        if (!page || typeof page !== 'object') continue;
        const typedPage = page as { page_idx?: unknown; page_size?: unknown };
        const pageIndex = Number(typedPage.page_idx);
        const size = Array.isArray(typedPage.page_size) && typedPage.page_size.length >= 2
            ? [Number(typedPage.page_size[0]), Number(typedPage.page_size[1])]
            : null;

        if (!Number.isFinite(pageIndex) || !size || size.some((entry) => !Number.isFinite(entry))) {
            continue;
        }

        pageSizes[pageIndex] = [size[0], size[1]];
    }

    return pageSizes;
}

function inferPageSizesFromAnchors(anchors: DocumentSemanticAnchor[]): Record<number, [number, number]> {
    const pageSizes: Record<number, [number, number]> = {};

    for (const anchor of anchors) {
        const current = pageSizes[anchor.pageIndex] || [0, 0];
        pageSizes[anchor.pageIndex] = [
            Math.max(current[0], anchor.bbox[2] + 24),
            Math.max(current[1], anchor.bbox[3] + 24),
        ];
    }

    return pageSizes;
}

export function buildDocumentSemanticProjection(input: {
    contentList?: unknown;
    layout?: unknown;
    markdown?: string;
    assetPathPrefix?: string;
}): DocumentSemanticProjection {
    const pageSizes = input.layout ? extractPageSizes(input.layout) : {};

    if (input.contentList) {
        const base = assignSemanticMetadata(buildRawBlocksFromContentList(input.contentList, input.assetPathPrefix));
        return {
            ...base,
            source: 'content-list-v2',
            lowFidelity: false,
            pageSizes: Object.keys(pageSizes).length > 0 ? pageSizes : inferPageSizesFromAnchors(base.anchors),
        };
    }

    if (input.layout) {
        const base = assignSemanticMetadata(buildRawBlocksFromLayout(input.layout, input.assetPathPrefix));
        return {
            ...base,
            source: 'layout',
            lowFidelity: false,
            pageSizes: Object.keys(pageSizes).length > 0 ? pageSizes : inferPageSizesFromAnchors(base.anchors),
        };
    }

    const base = assignSemanticMetadata(buildRawBlocksFromMarkdown(input.markdown || ''));
    return {
        ...base,
        source: 'markdown',
        lowFidelity: true,
        pageSizes: Object.keys(pageSizes).length > 0 ? pageSizes : inferPageSizesFromAnchors(base.anchors),
    };
}

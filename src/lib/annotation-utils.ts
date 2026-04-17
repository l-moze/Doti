import type { AnnotationAnchorRecord, AnnotationRecord } from './db';

export type EditorTab = 'translation' | 'source';

export interface SelectionSnapshot {
    text: string;
    tab: EditorTab;
    documentId: string;
    anchor: AnnotationAnchorRecord;
    contextText: string;
    top: number;
    left: number;
}

const MARK_SELECTOR = '[data-annotation-highlight="true"]';

export interface MarkdownDecorationState {
    sectionIndex: number;
    headingIndex: number;
    counters: Record<string, number>;
}

export type SemanticBlockType =
    | 'title'
    | 'text'
    | 'image'
    | 'table'
    | 'formula'
    | 'list'
    | 'code';

export type SemanticContentBlockType = Exclude<SemanticBlockType, 'title'>;

const MARKDOWN_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,blockquote,pre,.markdown-table-wrap,ul,ol,.katex-display';
const CAPTION_TYPE_PATTERNS: Array<{ type: Extract<SemanticBlockType, 'image' | 'table'>; pattern: RegExp }> = [
    { type: 'image', pattern: /^(figure|fig\.?)\s*\d+[\s:：.-]*/i },
    { type: 'image', pattern: /^图\s*\d+[\s:：.-]*/i },
    { type: 'table', pattern: /^table\s*\d+[\s:：.-]*/i },
    { type: 'table', pattern: /^表\s*\d+[\s:：.-]*/i },
];
const LIST_ITEM_PREFIX_PATTERN = /^(?:[-*+•▪◦]\s+|\d+[.)]\s+|[A-Za-z][.)]\s+)/;
const INLINE_LIST_MARKER_PATTERN = /(?:^|\s)(?:[-*+•▪◦]|\d+[.)]|[A-Za-z][.)])\s+/g;

export function getDocumentId(fileHash: string, targetLang: string, tab: EditorTab): string {
    return tab === 'translation'
        ? `${fileHash}::translation::${targetLang}`
        : `${fileHash}::source`;
}

export function getMarkdownBodies(container: HTMLElement | null): HTMLElement[] {
    if (!container) return [];
    return Array.from(container.querySelectorAll<HTMLElement>('.markdown-body'));
}

export function getMarkdownBody(container: HTMLElement | null): HTMLElement | null {
    return getMarkdownBodies(container)[0] || null;
}

export function getPlainText(container: HTMLElement): string {
    return container.textContent || '';
}

export function buildSemanticBlockId(
    sectionIndex: number,
    type: SemanticContentBlockType,
    blockIndex: number
): string {
    return `sec-${sectionIndex}-${type}-${blockIndex}`;
}

export function detectCaptionBlockType(text: string): Extract<SemanticBlockType, 'image' | 'table'> | null {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return null;

    for (const candidate of CAPTION_TYPE_PATTERNS) {
        if (candidate.pattern.test(normalized)) {
            return candidate.type;
        }
    }

    return null;
}

function getMarkdownElementText(element: HTMLElement): string {
    return element.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function isStandaloneListParagraph(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return false;

    if (LIST_ITEM_PREFIX_PATTERN.test(normalized)) {
        return true;
    }

    const inlineMarkers = normalized.match(INLINE_LIST_MARKER_PATTERN);
    return (inlineMarkers?.length || 0) > 1;
}

function getMarkdownSemanticType(element: HTMLElement): SemanticContentBlockType {
    const tagName = element.tagName.toLowerCase();
    const text = getMarkdownElementText(element);

    if (element.classList.contains('markdown-table-wrap')) return 'table';
    if (element.classList.contains('katex-display')) return 'formula';
    if (tagName === 'pre') return 'code';
    if (tagName === 'ul' || tagName === 'ol') return 'list';
    if (tagName === 'p' && element.querySelector('img')) return 'image';
    if (tagName === 'p' && isStandaloneListParagraph(text)) return 'list';

    return 'text';
}

function findAdjacentSemanticElement(
    elements: HTMLElement[],
    startIndex: number,
    direction: -1 | 1
): HTMLElement | null {
    let cursor = startIndex + direction;

    while (cursor >= 0 && cursor < elements.length) {
        const candidate = elements[cursor];
        const tagName = candidate.tagName.toLowerCase();
        if (!tagName.startsWith('h')) {
            return candidate;
        }
        cursor += direction;
    }

    return null;
}

function getAssignedSemanticId(
    element: HTMLElement | null,
    reservedSemanticIds: Map<HTMLElement, string>
): string | null {
    if (!element) return null;
    return element.dataset.semanticBlockId || reservedSemanticIds.get(element) || null;
}

function getSelectionOffsets(container: HTMLElement, range: Range): { start: number; end: number } {
    const preRange = range.cloneRange();
    preRange.selectNodeContents(container);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end = start + range.toString().length;
    return { start, end };
}

function getContextWindow(text: string, start: number, end: number, radius = 1200): string {
    return text.slice(Math.max(0, start - radius), Math.min(text.length, end + radius));
}

export function resolveSelectionSnapshot(
    body: HTMLElement,
    tab: EditorTab,
    documentId: string
): SelectionSnapshot | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    const range = selection.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) {
        return null;
    }

    const text = selection.toString().trim();
    if (!text) return null;

    const { start, end } = getSelectionOffsets(body, range);
    const fullText = getPlainText(body);
    const rect = range.getBoundingClientRect();
    const semanticBlockId = (range.startContainer instanceof HTMLElement
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest('[data-semantic-block-id]')?.getAttribute('data-semantic-block-id') || undefined;

    return {
        text,
        tab,
        documentId,
        anchor: {
            semanticBlockId,
            quote: {
                exact: text,
                prefix: fullText.slice(Math.max(0, start - 40), start),
                suffix: fullText.slice(end, Math.min(fullText.length, end + 40)),
            },
            position: { start, end },
        },
        contextText: getContextWindow(fullText, start, end),
        top: Math.max(16, rect.top - 54),
        left: rect.left + rect.width / 2,
    };
}

function createRangeFromOffsets(container: HTMLElement, start: number, end: number): Range | null {
    const range = document.createRange();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let currentNode = walker.nextNode();
    let currentIndex = 0;
    let startNode: Node | null = null;
    let endNode: Node | null = null;
    let startOffset = 0;
    let endOffset = 0;

    while (currentNode) {
        const textLength = currentNode.textContent?.length || 0;
        const nextIndex = currentIndex + textLength;

        if (!startNode && start >= currentIndex && start <= nextIndex) {
            startNode = currentNode;
            startOffset = start - currentIndex;
        }

        if (!endNode && end >= currentIndex && end <= nextIndex) {
            endNode = currentNode;
            endOffset = end - currentIndex;
            break;
        }

        currentIndex = nextIndex;
        currentNode = walker.nextNode();
    }

    if (!startNode || !endNode) return null;

    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
}

function findRangeFromQuote(container: HTMLElement, annotation: AnnotationRecord): Range | null {
    const exact = annotation.anchor.quote?.exact;
    if (!exact) return null;

    const text = getPlainText(container);
    const index = text.indexOf(exact);
    if (index === -1) return null;

    return createRangeFromOffsets(container, index, index + exact.length);
}

export function findRangeForAnnotation(container: HTMLElement, annotation: AnnotationRecord): Range | null {
    const start = annotation.anchor.position?.start;
    const end = annotation.anchor.position?.end;
    const exact = annotation.anchor.quote?.exact?.trim();

    if (typeof start === 'number' && typeof end === 'number') {
        const positionedRange = createRangeFromOffsets(container, start, end);
        if (positionedRange) {
            if (!exact || positionedRange.toString().trim() === exact) {
                return positionedRange;
            }
        }
        return findRangeFromQuote(container, annotation);
    }

    return findRangeFromQuote(container, annotation);
}

function clearAnnotationHighlights(container: HTMLElement) {
    const marks = Array.from(container.querySelectorAll<HTMLElement>(MARK_SELECTOR));
    for (const mark of marks) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) {
            parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
        parent.normalize();
    }
}

export function applyAnnotationHighlights(container: HTMLElement, annotations: AnnotationRecord[]): void {
    clearAnnotationHighlights(container);

    const ordered = [...annotations]
        .filter((annotation) => {
            const start = annotation.anchor.position?.start;
            const end = annotation.anchor.position?.end;
            return typeof start === 'number' && typeof end === 'number' && end > start;
        })
        .sort((a, b) => (b.anchor.position?.start || 0) - (a.anchor.position?.start || 0));

    for (const annotation of ordered) {
        const range = findRangeForAnnotation(container, annotation);
        if (!range || range.collapsed) continue;

        const wrapper = document.createElement('mark');
        wrapper.dataset.annotationHighlight = 'true';
        wrapper.dataset.annotationId = annotation.id;
        wrapper.className = 'annotation-highlight rounded px-0.5';
        const fragment = range.extractContents();
        wrapper.appendChild(fragment);
        range.insertNode(wrapper);
    }
}

export function createMarkdownDecorationState(): MarkdownDecorationState {
    return {
        sectionIndex: -1,
        headingIndex: -1,
        counters: { text: 0, image: 0, table: 0, formula: 0, list: 0, code: 0 },
    };
}

export function decorateMarkdownBody(
    body: HTMLElement,
    initialState: MarkdownDecorationState = createMarkdownDecorationState()
): MarkdownDecorationState {
    const elements = Array.from(
        body.querySelectorAll<HTMLElement>(MARKDOWN_BLOCK_SELECTOR)
    );
    let { sectionIndex, headingIndex } = initialState;
    let counters = { ...initialState.counters };
    const reservedSemanticIds = new Map<HTMLElement, string>();

    for (const [index, element] of elements.entries()) {
        const ancestor = element.parentElement?.closest('[data-semantic-block-id]');
        if (ancestor && ancestor !== element && body.contains(ancestor)) {
            continue;
        }

        const tagName = element.tagName.toLowerCase();
        if (tagName.startsWith('h')) {
            sectionIndex += 1;
            headingIndex += 1;
            counters = { text: 0, image: 0, table: 0, formula: 0, list: 0, code: 0 };
            const semanticId = `sec-${sectionIndex}-title-0`;
            element.dataset.semanticBlockId = semanticId;
            element.dataset.headingIndex = headingIndex.toString();
            element.id = semanticId;
            continue;
        }

        const activeSection = Math.max(sectionIndex, 0);
        const reservedSemanticId = reservedSemanticIds.get(element);

        if (reservedSemanticId) {
            element.dataset.semanticBlockId = reservedSemanticId;
            reservedSemanticIds.delete(element);
            continue;
        }

        if (tagName === 'p') {
            const captionType = detectCaptionBlockType(getMarkdownElementText(element));
            if (captionType) {
                const previousElement = findAdjacentSemanticElement(elements, index, -1);
                const nextElement = findAdjacentSemanticElement(elements, index, 1);
                const previousType = previousElement ? getMarkdownSemanticType(previousElement) : null;
                const nextType = nextElement ? getMarkdownSemanticType(nextElement) : null;

                if (previousElement && previousType === captionType) {
                    const previousSemanticId = getAssignedSemanticId(previousElement, reservedSemanticIds);
                    if (previousSemanticId) {
                        element.dataset.semanticBlockId = previousSemanticId;
                        continue;
                    }
                }

                if (nextElement && nextType === captionType) {
                    let semanticId = getAssignedSemanticId(nextElement, reservedSemanticIds);
                    if (!semanticId) {
                        const count = counters[captionType] || 0;
                        counters[captionType] = count + 1;
                        semanticId = buildSemanticBlockId(activeSection, captionType, count);
                        reservedSemanticIds.set(nextElement, semanticId);
                    }
                    element.dataset.semanticBlockId = semanticId;
                    continue;
                }
            }
        }

        const typeKey = getMarkdownSemanticType(element);
        if (typeKey === 'list') {
            const previousElement = findAdjacentSemanticElement(elements, index, -1);
            const nextElement = findAdjacentSemanticElement(elements, index, 1);
            const previousType = previousElement ? getMarkdownSemanticType(previousElement) : null;
            const nextType = nextElement ? getMarkdownSemanticType(nextElement) : null;

            if (previousElement && previousType === 'list') {
                const previousSemanticId = getAssignedSemanticId(previousElement, reservedSemanticIds);
                if (previousSemanticId) {
                    element.dataset.semanticBlockId = previousSemanticId;
                    continue;
                }
            }

            if (nextElement && nextType === 'list') {
                let semanticId = getAssignedSemanticId(nextElement, reservedSemanticIds);
                if (!semanticId) {
                    const count = counters.list || 0;
                    counters.list = count + 1;
                    semanticId = buildSemanticBlockId(activeSection, 'list', count);
                    reservedSemanticIds.set(nextElement, semanticId);
                }
                element.dataset.semanticBlockId = semanticId;
                continue;
            }
        }

        const count = counters[typeKey] || 0;
        counters[typeKey] = count + 1;
        element.dataset.semanticBlockId = buildSemanticBlockId(activeSection, typeKey, count);
    }

    return {
        sectionIndex,
        headingIndex,
        counters,
    };
}

export function annotationListToMarkdown(annotations: AnnotationRecord[]): string {
    if (annotations.length === 0) return '_No annotations_';

    return annotations.map((annotation) => {
        const header = `### ${new Date(annotation.createdAt).toLocaleString()}`;
        const selected = `> ${annotation.selectedText}`;
        const tags = annotation.tags?.length ? `\n\nTags: ${annotation.tags.join(', ')}` : '';
        const note = annotation.note.trim() || '_Empty note_';
        return `${header}\n\n${selected}\n\n${note}${tags}`;
    }).join('\n\n');
}

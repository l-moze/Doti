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

    if (typeof start === 'number' && typeof end === 'number') {
        return createRangeFromOffsets(container, start, end) || findRangeFromQuote(container, annotation);
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
        counters: { text: 0, table: 0, formula: 0, code: 0 },
    };
}

export function decorateMarkdownBody(
    body: HTMLElement,
    initialState: MarkdownDecorationState = createMarkdownDecorationState()
): MarkdownDecorationState {
    const elements = Array.from(
        body.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,.katex-display')
    );
    let { sectionIndex, headingIndex } = initialState;
    let counters = { ...initialState.counters };

    for (const element of elements) {
        const ancestor = element.parentElement?.closest('[data-semantic-block-id]');
        if (ancestor && ancestor !== element && body.contains(ancestor)) {
            continue;
        }

        const tagName = element.tagName.toLowerCase();
        if (tagName.startsWith('h')) {
            sectionIndex += 1;
            headingIndex += 1;
            counters = { text: 0, table: 0, formula: 0, code: 0 };
            const semanticId = `sec-${sectionIndex}-title-0`;
            element.dataset.semanticBlockId = semanticId;
            element.dataset.headingIndex = headingIndex.toString();
            element.id = semanticId;
            continue;
        }

        const activeSection = Math.max(sectionIndex, 0);
        let typeKey = 'text';
        if (tagName === 'table') typeKey = 'table';
        if (tagName === 'pre') typeKey = 'code';
        if (element.classList.contains('katex-display')) typeKey = 'formula';

        const count = counters[typeKey] || 0;
        counters[typeKey] = count + 1;

        element.dataset.semanticBlockId = `sec-${activeSection}-${typeKey}-${count}`;
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

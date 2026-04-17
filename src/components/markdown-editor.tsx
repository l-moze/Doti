'use client';

import {
    deleteAnnotationRecord,
    deleteConversationRecord,
    getProviderProfile,
    listAnnotationsForDocument,
    listConversationsForDocument,
    listUserGlossaryRecords,
    saveAnnotation,
    saveConversation,
    type AnnotationAnchorRecord,
    type AnnotationRecord,
    type ConversationRecord,
} from '@/lib/db';
import { fetchWithRetry } from '@/lib/fetch-with-retry';
import { buildMarkdownFromTranslationBlocks } from '@/lib/translation-runtime';
import { normalizeMarkdownMathForDisplay } from '@/lib/markdown-normalizer';
import { useTranslationStore } from '@/lib/store';
import { emitSyncEvent, subscribeSyncEvents } from '@/lib/sync-channel';
import {
    annotationListToMarkdown,
    applyAnnotationHighlights,
    createMarkdownDecorationState,
    decorateMarkdownBody,
    findRangeForAnnotation,
    getDocumentId,
    getMarkdownBodies,
    resolveSelectionSnapshot,
    type EditorTab,
    type SelectionSnapshot,
} from '@/lib/annotation-utils';
import type { DocumentSemanticProjection } from '@/lib/document-semantic';
import { MarkdownView } from '@/components/markdown-view';
import { StructuredSourceView } from '@/components/structured-source-view';
import { ModelSelector } from '@/components/model-selector';
import { StreamingTranslationPane } from '@/components/streaming-translation-pane';
import type { TranslationStreamFrame } from '@/components/translation-stream';
import { CheckCircle2, Loader2, MessageSquarePlus, NotebookPen, RotateCcw, Search, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

type SidePanelTab = 'notes' | 'ai';
type AssistAction = 'explain' | 'summarize' | 'rewrite' | 'extract' | 'qa';
const COLLAPSE_LIMITS = {
    panelPreview: 180,
    annotationQuote: 180,
    annotationNote: 220,
    conversationResponse: 420,
};

function useVlookStyle() {
    const [loaded, setLoaded] = useState(() =>
        typeof document !== 'undefined' && Boolean(document.querySelector<HTMLLinkElement>('link[href="/vlook-fancy.css"]')?.sheet)
    );

    useEffect(() => {
        if (typeof document === 'undefined') return;

        const existing = document.querySelector<HTMLLinkElement>('link[href="/vlook-fancy.css"]');
        if (existing) {
            if (!existing.sheet) {
                const onLoad = () => setLoaded(true);
                existing.addEventListener('load', onLoad);
                return () => existing.removeEventListener('load', onLoad);
            }
            return;
        }

        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/vlook-fancy.css';
        const onLoad = () => setLoaded(true);
        link.addEventListener('load', onLoad);
        document.head.appendChild(link);

        return () => {
            link.removeEventListener('load', onLoad);
        };
    }, []);

    return loaded;
}

function downloadTextFile(name: string, content: string) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
}

function buildAssistPromptLabel(action: AssistAction, question: string): string {
    if (action === 'qa') {
        return question.trim() ? `问答: ${question.trim()}` : '问答';
    }
    if (action === 'explain') return '解释术语';
    if (action === 'summarize') return '总结内容';
    if (action === 'rewrite') return '风格改写';
    return '提取关键信息';
}

function isTextCollapsible(text: string | null | undefined, maxChars: number): boolean {
    return (text?.trim().length || 0) > maxChars;
}

function getCollapsedText(text: string | null | undefined, maxChars: number): string {
    const normalized = text?.trim() || '';
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars).trimEnd()}...`;
}

function isSameSelection(a: SelectionSnapshot | null, b: SelectionSnapshot | null): boolean {
    if (!a || !b) return false;

    return (
        a.documentId === b.documentId &&
        a.text === b.text &&
        a.anchor.position?.start === b.anchor.position?.start &&
        a.anchor.position?.end === b.anchor.position?.end
    );
}

function getSelectionIdentity(selection: SelectionSnapshot | null): string {
    if (!selection) return 'none';

    return [
        selection.documentId,
        selection.anchor.position?.start ?? '',
        selection.anchor.position?.end ?? '',
        selection.text,
    ].join('::');
}

function hasActiveTextSelection(): boolean {
    if (typeof window === 'undefined') return false;

    const selection = window.getSelection();
    return Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed && selection.toString().trim());
}

function getConversationSessionId(conversation: ConversationRecord): string {
    return conversation.sessionId || 'legacy-session';
}

function formatSemanticBlockLabel(semanticBlockId?: string): string {
    if (!semanticBlockId) return '片段';

    const match = semanticBlockId.match(/^sec-(\d+)-([a-z]+)-(\d+)$/i);
    if (!match) return semanticBlockId;

    const [, section, rawType, index] = match;
    const typeMap: Record<string, string> = {
        title: '标题',
        text: '段',
        image: '图',
        table: '表',
        formula: '式',
        list: '列表',
        code: '码',
    };
    const typeLabel = typeMap[rawType.toLowerCase()] || '片段';

    if (rawType.toLowerCase() === 'title') {
        return `${typeLabel}${Number(section) + 1}`;
    }

    return `${typeLabel}${Number(section) + 1}-${Number(index) + 1}`;
}

function buildSelectionReferenceLabel(anchor?: AnnotationAnchorRecord | null): string | null {
    if (!anchor) return null;

    const blockLabel = formatSemanticBlockLabel(anchor.semanticBlockId);
    return `@${blockLabel}`;
}

type TranslationBlockCandidate = {
    id: string;
    index: number;
    text: string;
};

function getTranslationBlockIdFromBody(body: HTMLElement): string | null {
    return body.closest<HTMLElement>('[data-translation-block-id]')?.dataset.translationBlockId || null;
}

function getSemanticBlockElementFromRange(range: Range | null): HTMLElement | null {
    if (!range) return null;

    const rangeContainer = range.startContainer instanceof HTMLElement
        ? range.startContainer
        : range.startContainer.parentElement;

    return rangeContainer?.closest<HTMLElement>('[data-semantic-block-id]') || null;
}

interface CollapsibleTextProps {
    text: string | null | undefined;
    expanded: boolean;
    maxChars: number;
    className: string;
    onToggle: () => void;
    buttonClassName?: string;
    showToggle?: boolean;
}

function CollapsibleText({
    text,
    expanded,
    maxChars,
    className,
    onToggle,
    buttonClassName,
    showToggle = true,
}: CollapsibleTextProps) {
    const normalized = text?.trim() || '';
    const collapsible = isTextCollapsible(normalized, maxChars);
    const displayText = collapsible && !expanded ? getCollapsedText(normalized, maxChars) : normalized;

    if (!normalized) return null;

    return (
        <>
            <div className={className}>{displayText}</div>
            {collapsible && showToggle ? (
                <button
                    type="button"
                    onClick={onToggle}
                    className={buttonClassName || 'mt-2 text-xs font-medium text-slate-500 transition hover:text-slate-900'}
                >
                    {expanded ? '收起' : '展开'}
                </button>
            ) : null}
        </>
    );
}

interface MarkdownEditorProps {
    onTranslationWorkspaceContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
    sourceProjection?: DocumentSemanticProjection | null;
}

export function MarkdownEditor({ onTranslationWorkspaceContextMenu, sourceProjection = null }: MarkdownEditorProps) {
    const sourceMarkdown = useTranslationStore((state) => state.sourceMarkdown);
    const status = useTranslationStore((state) => state.status);
    const progress = useTranslationStore((state) => state.progress);
    const highlightedBlockId = useTranslationStore((state) => state.highlightedBlockId);
    const setHighlightedBlock = useTranslationStore((state) => state.setHighlightedBlock);
    const fileHash = useTranslationStore((state) => state.fileHash);
    const targetLang = useTranslationStore((state) => state.targetLang);
    const assistProviderId = useTranslationStore((state) => state.assistProviderId);
    const assistModel = useTranslationStore((state) => state.assistModel);
    const paperPolishStatus = useTranslationStore((state) => state.paperPolishStatus);
    const paperPolishMode = useTranslationStore((state) => state.paperPolishMode);
    const paperPolishProgress = useTranslationStore((state) => state.paperPolishProgress);
    const paperPolishMessage = useTranslationStore((state) => state.paperPolishMessage);
    const paperPolishSummary = useTranslationStore((state) => state.paperPolishSummary);
    const paperPolishResidualCount = useTranslationStore((state) => state.paperPolishIssueWindows.length);
    const paperPolishCanUseAiFallback = useTranslationStore((state) => state.paperPolishCanUseAiFallback);
    const paperPolishAutoEnabled = useTranslationStore((state) => state.paperPolishAutoEnabled);
    const paperPolishUndoExpiresAt = useTranslationStore((state) => state.paperPolishUndoExpiresAt);
    const paperPolishRevealKey = useTranslationStore((state) => state.paperPolishRevealKey);
    const setPaperPolishAutoEnabled = useTranslationStore((state) => state.setPaperPolishAutoEnabled);
    const runPaperPolish = useTranslationStore((state) => state.runPaperPolish);
    const runPaperPolishAiFallback = useTranslationStore((state) => state.runPaperPolishAiFallback);
    const cancelPaperPolish = useTranslationStore((state) => state.cancelPaperPolish);
    const undoPaperPolish = useTranslationStore((state) => state.undoPaperPolish);
    const translationStatus = useTranslationStore((state) => state.translationStatus);
    const translationPhase = useTranslationStore((state) => state.translationPhase);
    const translationConcurrency = useTranslationStore((state) => state.translationConcurrency);
    const error = useTranslationStore((state) => state.error);
    const hasTranslationContent = useTranslationStore((state) =>
        state.translationBlocks.length > 0 || Boolean(state.targetMarkdown.trim())
    );
    const translationDecorationVersion = useTranslationStore((state) => {
        const completedBlockCount = state.translationBlocks.reduce((count, block) => (
            block.state === 'completed' || block.state === 'cached'
                ? count + 1
                : count
        ), 0);
        return `${completedBlockCount}:${state.targetMarkdown.trim().length > 0 ? 1 : 0}`;
    });

    const vlookLoaded = useVlookStyle();
    const [manualTab, setManualTab] = useState<EditorTab | null>(null);
    const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>('notes');
    const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
    const [conversations, setConversations] = useState<ConversationRecord[]>([]);
    const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
    const [selectionMemory, setSelectionMemory] = useState<SelectionSnapshot | null>(null);
    const [noteTarget, setNoteTarget] = useState<SelectionSnapshot | null>(null);
    const [assistTarget, setAssistTarget] = useState<SelectionSnapshot | null>(null);
    const [noteDraft, setNoteDraft] = useState('');
    const [noteTags, setNoteTags] = useState('');
    const [noteSearch, setNoteSearch] = useState('');
    const [assistQuestion, setAssistQuestion] = useState('');
    const [assistLoading, setAssistLoading] = useState(false);
    const [assistError, setAssistError] = useState<string | null>(null);
    const [assistSessionId, setAssistSessionId] = useState<string | null>(null);
    const [pendingAssistExchange, setPendingAssistExchange] = useState<{
        sessionId: string;
        prompt: string;
        selectionText?: string;
        contextLabel?: string;
        contextTab?: EditorTab;
        contextAnchor?: AnnotationAnchorRecord;
        createdAt: number;
    } | null>(null);
    const [noteTargetExpanded, setNoteTargetExpanded] = useState(false);
    const [expandedAnnotationIds, setExpandedAnnotationIds] = useState<Record<string, boolean>>({});
    const [expandedConversationIds, setExpandedConversationIds] = useState<Record<string, boolean>>({});
    const [displayedSourceMarkdown, setDisplayedSourceMarkdown] = useState('');
    const [paperPolishVisualState, setPaperPolishVisualState] = useState<'idle' | 'processing' | 'fading' | 'revealing'>('idle');
    const [paperPolishUndoVisible, setPaperPolishUndoVisible] = useState(false);

    const translationPaneRef = useRef<HTMLDivElement | null>(null);
    const sourcePaneRef = useRef<HTMLDivElement | null>(null);
    const conversationListRef = useRef<HTMLDivElement | null>(null);
    const assistQuestionRef = useRef<HTMLTextAreaElement | null>(null);
    const previousHighlightedBlockIdRef = useRef<string | null>(null);
    const translationFrameMapRef = useRef<Record<string, TranslationStreamFrame>>({});
    const pointerSelectionActiveRef = useRef(false);
    const pointerSelectionCommitRef = useRef<number | null>(null);
    const paperPolishTimersRef = useRef<number[]>([]);

    const renderedSourceMarkdown = useMemo(() => normalizeMarkdownMathForDisplay(sourceMarkdown), [sourceMarkdown]);
    const activeTab: EditorTab = manualTab ?? (status === 'parsed' && !hasTranslationContent ? 'source' : 'translation');
    const activeDocumentId = fileHash ? getDocumentId(fileHash, targetLang, activeTab) : null;
    const translationHeaderLabel = translationConcurrency > 1 ? `并发翻译中 · ${translationConcurrency} 路` : '翻译进行中';

    useEffect(() => {
        return () => {
            for (const timer of paperPolishTimersRef.current) {
                window.clearTimeout(timer);
            }
            paperPolishTimersRef.current = [];
        };
    }, []);

    useEffect(() => {
        if (!displayedSourceMarkdown) {
            setDisplayedSourceMarkdown(renderedSourceMarkdown);
        }
    }, [displayedSourceMarkdown, renderedSourceMarkdown]);

    useEffect(() => {
        if (paperPolishStatus === 'processing') {
            for (const timer of paperPolishTimersRef.current) {
                window.clearTimeout(timer);
            }
            paperPolishTimersRef.current = [];
            setPaperPolishVisualState('processing');
            startTransition(() => setManualTab('source'));
            return;
        }

        if (paperPolishVisualState === 'processing') {
            setPaperPolishVisualState('idle');
        }
    }, [paperPolishStatus, paperPolishVisualState]);

    useEffect(() => {
        if (paperPolishRevealKey <= 0) {
            return;
        }

        for (const timer of paperPolishTimersRef.current) {
            window.clearTimeout(timer);
        }
        paperPolishTimersRef.current = [];
        setPaperPolishVisualState('fading');

        const swapTimer = window.setTimeout(() => {
            setDisplayedSourceMarkdown(renderedSourceMarkdown);
            setPaperPolishVisualState('revealing');
        }, 360);
        const settleTimer = window.setTimeout(() => {
            setPaperPolishVisualState('idle');
        }, 1320);

        paperPolishTimersRef.current = [swapTimer, settleTimer];
    }, [paperPolishRevealKey, renderedSourceMarkdown]);

    useEffect(() => {
        if (paperPolishStatus !== 'processing' && paperPolishVisualState === 'idle') {
            setDisplayedSourceMarkdown(renderedSourceMarkdown);
        }
    }, [paperPolishStatus, paperPolishVisualState, renderedSourceMarkdown]);

    useEffect(() => {
        if (!paperPolishUndoExpiresAt) {
            setPaperPolishUndoVisible(false);
            return;
        }

        const remaining = paperPolishUndoExpiresAt - Date.now();
        if (remaining <= 0) {
            setPaperPolishUndoVisible(false);
            return;
        }

        setPaperPolishUndoVisible(true);
        const timer = window.setTimeout(() => {
            setPaperPolishUndoVisible(false);
        }, remaining);

        return () => window.clearTimeout(timer);
    }, [paperPolishUndoExpiresAt]);

    const handleTranslationFramesChange = useCallback((frames: TranslationStreamFrame[]) => {
        translationFrameMapRef.current = Object.fromEntries(
            frames.map((frame) => [frame.blockId, frame])
        );
    }, []);

    const getTranslationBlockCandidates = useCallback((): TranslationBlockCandidate[] => {
        return [...useTranslationStore.getState().translationBlocks]
            .filter((block) => block.text.length > 0)
            .sort((a, b) => a.index - b.index)
            .map((block) => ({
                id: block.id,
                index: block.index,
                text: block.text,
            }));
    }, []);

    const resolveTranslationBlockIdForAnchor = useCallback((
        anchor?: AnnotationAnchorRecord | null,
        selectedText?: string
    ): string | null => {
        if (!anchor) return null;

        const probeText = anchor.quote?.exact?.trim() || selectedText?.trim();
        if (!probeText) return null;

        return getTranslationBlockCandidates().find((offset) => offset.text.includes(probeText))?.id || null;
    }, [getTranslationBlockCandidates]);

    const localizeAnnotationForBody = useCallback((
        body: HTMLElement,
        annotation: AnnotationRecord
    ): AnnotationRecord | null => {
        const bodyBlockId = getTranslationBlockIdFromBody(body);
        const targetBlockId = resolveTranslationBlockIdForAnchor(annotation.anchor, annotation.selectedText);
        if (bodyBlockId && targetBlockId && bodyBlockId !== targetBlockId) {
            return null;
        }

        const probeText = annotation.anchor.quote?.exact?.trim() || annotation.selectedText.trim();
        if (probeText && !body.textContent?.includes(probeText)) {
            return null;
        }

        return annotation;
    }, [resolveTranslationBlockIdForAnchor]);

    const scrollTranslationPaneToBlock = useCallback((blockId: string): boolean => {
        const container = translationPaneRef.current;
        const frame = translationFrameMapRef.current[blockId];
        if (!container || !frame) return false;

        container.scrollTo({
            top: Math.max(0, frame.top - 120),
            behavior: 'smooth',
        });
        return true;
    }, []);

    const findAnnotationLocation = useCallback((target: {
        tab: EditorTab;
        anchor: AnnotationAnchorRecord;
        selectedText?: string;
    }) => {
        if (!fileHash) return null;

        const container = target.tab === 'translation' ? translationPaneRef.current : sourcePaneRef.current;
        if (!container) return null;

        const probe: AnnotationRecord = {
            id: 'context-reference',
            documentId: getDocumentId(fileHash, targetLang, target.tab),
            fileHash,
            targetLang: target.tab === 'translation' ? targetLang : undefined,
            selectedText: target.selectedText || target.anchor.quote?.exact || '',
            anchor: target.anchor,
            note: '',
            createdAt: 0,
            updatedAt: 0,
        };

        const preferredBlockId = target.tab === 'translation'
            ? resolveTranslationBlockIdForAnchor(target.anchor, target.selectedText)
            : null;

        const bodies = getMarkdownBodies(container);
        const orderedBodies = preferredBlockId
            ? [...bodies].sort((left, right) => {
                const leftScore = getTranslationBlockIdFromBody(left) === preferredBlockId ? 0 : 1;
                const rightScore = getTranslationBlockIdFromBody(right) === preferredBlockId ? 0 : 1;
                return leftScore - rightScore;
            })
            : bodies;

        for (const body of orderedBodies) {
            const localizedProbe = target.tab === 'translation'
                ? localizeAnnotationForBody(body, probe)
                : probe;
            if (!localizedProbe) continue;

            const range = findRangeForAnnotation(body, localizedProbe);
            const block = getSemanticBlockElementFromRange(range)
                || (target.anchor.semanticBlockId
                    ? body.querySelector<HTMLElement>(`[data-semantic-block-id="${target.anchor.semanticBlockId}"]`)
                    : null);

            if (!range && !block) continue;

            return {
                block,
                range,
                preferredBlockId,
            };
        }

        return {
            block: null,
            range: null,
            preferredBlockId,
        };
    }, [fileHash, localizeAnnotationForBody, resolveTranslationBlockIdForAnchor, targetLang]);

    const focusAnnotationLocation = useCallback((target: {
        tab: EditorTab;
        anchor?: AnnotationAnchorRecord;
        selectedText?: string;
    }) => {
        if (!target.anchor) return () => undefined;

        startTransition(() => setManualTab(target.tab));

        let retryTimer: number | null = null;
        const initialTimer = window.setTimeout(() => {
            const tryLocate = (attempt: number) => {
                const located = findAnnotationLocation({
                    tab: target.tab,
                    anchor: target.anchor!,
                    selectedText: target.selectedText,
                });

                if (located?.block) {
                    const semanticId = located.block.dataset.semanticBlockId || null;
                    if (semanticId) {
                        setHighlightedBlock(semanticId);
                    }

                    located.block.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    located.block.classList.add('highlight-flash');
                    window.setTimeout(() => located.block?.classList.remove('highlight-flash'), 2000);
                    return;
                }

                if (attempt === 0 && target.tab === 'translation' && located?.preferredBlockId) {
                    scrollTranslationPaneToBlock(located.preferredBlockId);
                }

                if (attempt >= 6) return;

                retryTimer = window.setTimeout(() => {
                    tryLocate(attempt + 1);
                }, attempt === 0 ? 220 : 140);
            };

            tryLocate(0);
        }, 120);

        return () => {
            window.clearTimeout(initialTimer);
            if (retryTimer !== null) {
                window.clearTimeout(retryTimer);
            }
        };
    }, [findAnnotationLocation, scrollTranslationPaneToBlock, setHighlightedBlock]);

    const loadWorkspaceData = useCallback(async () => {
        if (!fileHash) {
            setAnnotations([]);
            setConversations([]);
            return;
        }

        const [nextAnnotations, nextConversations] = await Promise.all([
            listAnnotationsForDocument(fileHash),
            listConversationsForDocument(fileHash),
        ]);

        setAnnotations(nextAnnotations);
        setConversations(nextConversations);
    }, [fileHash]);

    useEffect(() => {
        void loadWorkspaceData();
    }, [loadWorkspaceData]);

    useEffect(() => {
        setSelection(null);
        setSelectionMemory(null);
        setNoteTarget(null);
        setAssistTarget(null);
        setNoteDraft('');
        setNoteTags('');
        setAssistQuestion('');
        setAssistError(null);
        setAssistSessionId(null);
        setPendingAssistExchange(null);
        setNoteTargetExpanded(false);
        setExpandedAnnotationIds({});
        setExpandedConversationIds({});
    }, [fileHash, activeTab]);

    useEffect(() => {
        return subscribeSyncEvents((event) => {
            if (
                event.type === 'storage-updated' ||
                ((event.type === 'annotation-updated' || event.type === 'conversation-updated') &&
                    (!event.fileHash || event.fileHash === fileHash))
            ) {
                void loadWorkspaceData();
            }
        });
    }, [fileHash, loadWorkspaceData]);

    const decorateVisibleBodies = useCallback(() => {
        const translationAnnotations = fileHash
            ? annotations.filter((annotation) => annotation.documentId === getDocumentId(fileHash, targetLang, 'translation'))
            : [];
        const sourceAnnotations = fileHash
            ? annotations.filter((annotation) => annotation.documentId === getDocumentId(fileHash, targetLang, 'source'))
            : [];

        const applyDecorations = (
            bodies: HTMLElement[],
            paneAnnotations: AnnotationRecord[],
            tab: EditorTab
        ) => {
            let decorationState = createMarkdownDecorationState();

            for (const body of bodies) {
                if (tab === 'translation') {
                    decorationState = decorateMarkdownBody(body, decorationState);
                }
                const annotationsForBody = tab === 'translation'
                    ? paneAnnotations
                        .map((annotation) => localizeAnnotationForBody(body, annotation))
                        .filter((annotation): annotation is AnnotationRecord => Boolean(annotation))
                    : paneAnnotations;
                applyAnnotationHighlights(body, annotationsForBody);
            }
        };

        applyDecorations(getMarkdownBodies(translationPaneRef.current), translationAnnotations, 'translation');
        applyDecorations(getMarkdownBodies(sourcePaneRef.current), sourceAnnotations, 'source');
    }, [annotations, fileHash, localizeAnnotationForBody, targetLang]);

    useEffect(() => {
        let frame = 0;
        const timer = window.setTimeout(() => {
            decorateVisibleBodies();
        }, 80);

        const scheduleDecorate = () => {
            if (frame !== 0) {
                window.cancelAnimationFrame(frame);
            }
            frame = window.requestAnimationFrame(() => {
                decorateVisibleBodies();
            });
        };

        const translationContainer = translationPaneRef.current;
        const sourceContainer = sourcePaneRef.current;
        translationContainer?.addEventListener('scroll', scheduleDecorate, { passive: true });
        sourceContainer?.addEventListener('scroll', scheduleDecorate, { passive: true });

        return () => {
            window.clearTimeout(timer);
            if (frame !== 0) {
                window.cancelAnimationFrame(frame);
            }
            translationContainer?.removeEventListener('scroll', scheduleDecorate);
            sourceContainer?.removeEventListener('scroll', scheduleDecorate);
        };
    }, [decorateVisibleBodies, renderedSourceMarkdown, translationDecorationVersion]);

    useEffect(() => {
        const attachHashNavigation = (container: HTMLDivElement | null) => {
            if (!container) return () => undefined;

            const handleClick = (event: MouseEvent) => {
                const target = event.target as HTMLElement | null;
                const anchor = target?.closest<HTMLAnchorElement>('a[href^="#"]');
                if (!anchor) return;

                const rawHash = anchor.getAttribute('href')?.slice(1);
                if (!rawHash) return;

                event.preventDefault();

                const decodedHash = decodeURIComponent(rawHash);
                const escapedHash = typeof CSS !== 'undefined' && CSS.escape
                    ? CSS.escape(decodedHash)
                    : decodedHash.replace(/"/g, '\\"');

                const nextTarget = container.querySelector<HTMLElement>(
                    `[data-semantic-block-id="${escapedHash}"], #${escapedHash}`
                );

                if (nextTarget) {
                    nextTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const semanticId = nextTarget.getAttribute('data-semantic-block-id') || decodedHash;
                    setHighlightedBlock(semanticId);
                    return;
                }

                setHighlightedBlock(decodedHash);
            };

            container.addEventListener('click', handleClick);
            return () => container.removeEventListener('click', handleClick);
        };

        const cleanups = [
            attachHashNavigation(translationPaneRef.current),
            attachHashNavigation(sourcePaneRef.current),
        ];

        return () => {
            for (const cleanup of cleanups) {
                cleanup();
            }
        };
    }, [renderedSourceMarkdown, setHighlightedBlock, translationDecorationVersion]);

    useEffect(() => {
        if (!highlightedBlockId) {
            previousHighlightedBlockIdRef.current = null;
            return;
        }
        if (previousHighlightedBlockIdRef.current === highlightedBlockId) return;
        previousHighlightedBlockIdRef.current = highlightedBlockId;

        const findTarget = (tab: EditorTab) => {
            const bodies = getMarkdownBodies(tab === 'translation' ? translationPaneRef.current : sourcePaneRef.current);
            if (bodies.length === 0) return null;

            const selector = highlightedBlockId.startsWith('sec-')
                ? `[data-semantic-block-id="${highlightedBlockId}"]`
                : `[data-heading-index="${highlightedBlockId}"]`;

            for (const body of bodies) {
                const element = body.querySelector<HTMLElement>(selector);
                if (element) {
                    return { tab, element };
                }
            }

            return null;
        };

        const found = findTarget(activeTab) || findTarget(activeTab === 'translation' ? 'source' : 'translation');
        if (!found) return;

        if (found.tab !== activeTab) {
            startTransition(() => setManualTab(found.tab));
        }

        const timer = window.setTimeout(() => {
            found.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            found.element.classList.add('highlight-flash');
            window.setTimeout(() => found.element.classList.remove('highlight-flash'), 2000);
        }, 120);

        return () => window.clearTimeout(timer);
    }, [activeTab, highlightedBlockId]);

    useEffect(() => {
        const commitSelectionSnapshot = () => {
            if (!fileHash || !activeDocumentId) {
                setSelection(null);
                return;
            }

            const selectionInstance = window.getSelection();
            if (!selectionInstance || selectionInstance.rangeCount === 0 || selectionInstance.isCollapsed) {
                setSelection(null);
                return;
            }

            const range = selectionInstance.getRangeAt(0);
            const bodies = getMarkdownBodies(activeTab === 'translation' ? translationPaneRef.current : sourcePaneRef.current);
            const body = bodies.find((candidate) => candidate.contains(range.commonAncestorContainer));
            if (!body) {
                setSelection(null);
                return;
            }

            const nextSelection = resolveSelectionSnapshot(body, activeTab, activeDocumentId);
            setSelection(nextSelection);
            if (nextSelection) {
                setSelectionMemory(nextSelection);
            }
        };

        const handleSelectionChange = () => {
            if (pointerSelectionActiveRef.current) return;
            commitSelectionSnapshot();
        };

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            const activeContainer = activeTab === 'translation' ? translationPaneRef.current : sourcePaneRef.current;
            pointerSelectionActiveRef.current = Boolean(target && activeContainer?.contains(target));
        };

        const handlePointerUp = () => {
            if (!pointerSelectionActiveRef.current) return;

            pointerSelectionActiveRef.current = false;
            if (pointerSelectionCommitRef.current !== null) {
                window.cancelAnimationFrame(pointerSelectionCommitRef.current);
            }
            pointerSelectionCommitRef.current = window.requestAnimationFrame(() => {
                commitSelectionSnapshot();
                pointerSelectionCommitRef.current = null;
            });
        };

        document.addEventListener('selectionchange', handleSelectionChange);
        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('pointerup', handlePointerUp, true);

        return () => {
            document.removeEventListener('selectionchange', handleSelectionChange);
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('pointerup', handlePointerUp, true);
            pointerSelectionActiveRef.current = false;
            if (pointerSelectionCommitRef.current !== null) {
                window.cancelAnimationFrame(pointerSelectionCommitRef.current);
                pointerSelectionCommitRef.current = null;
            }
        };
    }, [activeDocumentId, activeTab, fileHash]);

    useEffect(() => {
        if (!selection) return;

        setNoteTarget((current) => {
            if (current && (noteDraft.trim() || noteTags.trim())) {
                return current;
            }
            return selection;
        });
    }, [selection, noteDraft, noteTags]);

    const filteredAnnotations = useMemo(() => {
        const keyword = noteSearch.trim().toLowerCase();
        return annotations.filter((annotation) => {
            if (!keyword) return true;
            return [
                annotation.selectedText,
                annotation.note,
                annotation.tags?.join(' ') || '',
                annotation.targetLang ? 'translation' : 'source',
            ].join(' ').toLowerCase().includes(keyword);
        });
    }, [annotations, noteSearch]);

    const sortedAnnotations = useMemo(
        () => [...filteredAnnotations].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt),
        [filteredAnnotations]
    );

    const sortedConversationPool = useMemo(
        () => [...conversations].sort((a, b) => a.createdAt - b.createdAt),
        [conversations]
    );

    const availableAssistSessions = useMemo(() => {
        const sessionMap = new Map<string, { id: string; count: number; createdAt: number }>();

        for (const conversation of sortedConversationPool) {
            const sessionId = getConversationSessionId(conversation);
            const existing = sessionMap.get(sessionId);
            if (existing) {
                existing.count += 1;
                existing.createdAt = Math.max(existing.createdAt, conversation.createdAt);
            } else {
                sessionMap.set(sessionId, {
                    id: sessionId,
                    count: 1,
                    createdAt: conversation.createdAt,
                });
            }
        }

        return [...sessionMap.values()].sort((a, b) => b.createdAt - a.createdAt);
    }, [sortedConversationPool]);

    useEffect(() => {
        if (availableAssistSessions.length === 0) {
            setAssistSessionId((current) => current);
            return;
        }

        setAssistSessionId((current) => {
            if (current) {
                return current;
            }
            return availableAssistSessions[0]?.id || null;
        });
    }, [availableAssistSessions]);

    useEffect(() => {
        if (!assistSessionId || assistSessionId === 'draft-session') {
            return;
        }

        const exists = availableAssistSessions.some((session) => session.id === assistSessionId);
        if (exists) return;

        setAssistSessionId(availableAssistSessions[0]?.id || 'draft-session');
    }, [assistSessionId, availableAssistSessions]);

    const activeConversations = useMemo(
        () => conversations.filter((conversation) => getConversationSessionId(conversation) === (assistSessionId || availableAssistSessions[0]?.id || 'legacy-session')),
        [assistSessionId, availableAssistSessions, conversations]
    );

    const currentAssistSessionId = assistSessionId || availableAssistSessions[0]?.id || 'draft-session';
    const visibleConversationCount = activeConversations.length;

    const sortedConversations = useMemo(
        () => [...activeConversations].sort((a, b) => a.createdAt - b.createdAt),
        [activeConversations]
    );

    const assistSessionSummaries = useMemo(
        () => availableAssistSessions.map((session) => {
            const sessionConversations = sortedConversationPool.filter((conversation) => getConversationSessionId(conversation) === session.id);
            const firstConversation = sessionConversations[0];
            const latestConversation = sessionConversations.at(-1);

            return {
                id: session.id,
                count: sessionConversations.length,
                title: (firstConversation?.prompt || latestConversation?.prompt || '新对话').trim(),
                preview: (latestConversation?.response || latestConversation?.selectionText || '').trim(),
                updatedAt: latestConversation?.createdAt || session.createdAt,
            };
        }),
        [availableAssistSessions, sortedConversationPool]
    );

    const assistHistory = useMemo(
        () => sortedConversations.slice(-6).map((conversation) => ({
            prompt: conversation.prompt,
            response: conversation.response,
            selectionText: conversation.selectionText,
            scope: conversation.scope,
        })),
        [sortedConversations]
    );

    const activeNoteTarget = noteTarget || selection;
    const currentAssistSelection = selection || selectionMemory;
    const activeAssistContext = assistTarget || currentAssistSelection;
    const assistTargetLocked = Boolean(assistTarget);
    const canRefreshAssistTarget = Boolean(assistTarget && currentAssistSelection && !isSameSelection(assistTarget, currentAssistSelection));
    const canSaveNote = Boolean(fileHash && activeNoteTarget && noteDraft.trim());
    const canSubmitAssistQuestion = Boolean(fileHash && assistQuestion.trim() && !assistLoading);
    const activeAssistContextLabel = buildSelectionReferenceLabel(activeAssistContext?.anchor);
    const pendingExchangeVisible = Boolean(
        pendingAssistExchange &&
        (pendingAssistExchange.sessionId === currentAssistSessionId || currentAssistSessionId === 'draft-session')
    );
    const activeNoteTargetKey = getSelectionIdentity(activeNoteTarget);
    useEffect(() => {
        setNoteTargetExpanded(false);
    }, [activeNoteTargetKey]);

    useEffect(() => {
        if (sidePanelTab !== 'ai') return;
        const element = conversationListRef.current;
        if (!element) return;
        element.scrollTop = element.scrollHeight;
    }, [sidePanelTab, visibleConversationCount, pendingExchangeVisible]);

    useEffect(() => {
        if (sidePanelTab !== 'ai') return;
        if (hasActiveTextSelection()) return;

        const timer = window.setTimeout(() => {
            if (hasActiveTextSelection()) return;
            assistQuestionRef.current?.focus();
        }, 50);

        return () => window.clearTimeout(timer);
    }, [sidePanelTab]);

    const clearEditorSelection = useCallback(() => {
        window.getSelection()?.removeAllRanges();
        setSelection(null);
    }, []);

    const focusContextReference = useCallback((target: {
        tab: EditorTab;
        anchor?: AnnotationAnchorRecord;
        selectedText?: string;
    }) => {
        return focusAnnotationLocation(target);
    }, [focusAnnotationLocation]);

    const toggleAnnotationExpanded = useCallback((id: string) => {
        setExpandedAnnotationIds((current) => ({ ...current, [id]: !current[id] }));
    }, []);

    const toggleConversationExpanded = useCallback((id: string) => {
        setExpandedConversationIds((current) => ({ ...current, [id]: !current[id] }));
    }, []);

    const saveCurrentNote = async () => {
        if (!fileHash || !activeNoteTarget || !noteDraft.trim()) return;

        await saveAnnotation({
            id: crypto.randomUUID(),
            documentId: activeNoteTarget.documentId,
            fileHash,
            targetLang: activeNoteTarget.tab === 'translation' ? targetLang : undefined,
            selectedText: activeNoteTarget.text,
            anchor: activeNoteTarget.anchor,
            note: noteDraft.trim(),
            tags: noteTags.split(',').map((tag) => tag.trim()).filter(Boolean),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });

        emitSyncEvent({ type: 'annotation-updated', fileHash });
        await loadWorkspaceData();
        setNoteDraft('');
        setNoteTags('');
        setNoteTarget(null);
        clearEditorSelection();
    };

    const runAssist = async (action: AssistAction, targetOverride?: SelectionSnapshot | null) => {
        if (!fileHash) return;

        const contextTarget = targetOverride || assistTarget || currentAssistSelection;
        const sessionIdForRequest = currentAssistSessionId === 'draft-session'
            ? crypto.randomUUID()
            : currentAssistSessionId;
        const userTerms = await listUserGlossaryRecords();
        const providerProfile = assistProviderId.startsWith('custom:')
            ? await getProviderProfile(assistProviderId.slice('custom:'.length))
            : undefined;
        const enabledTerms = userTerms
            .filter((term) => term.enabled)
            .map((term) => ({ source: term.source, target: term.target, category: term.category }));

        const currentTranslationState = useTranslationStore.getState();
        const currentActiveMarkdown = activeTab === 'translation'
            ? (currentTranslationState.targetMarkdown.trim()
                ? currentTranslationState.targetMarkdown
                : buildMarkdownFromTranslationBlocks(currentTranslationState.translationBlocks))
            : currentTranslationState.sourceMarkdown;
        const selectionText = contextTarget?.text || currentActiveMarkdown.slice(0, 2400);
        const contextText = contextTarget?.contextText || currentActiveMarkdown;
        const promptLabel = buildAssistPromptLabel(action, assistQuestion);
        const contextLabel = buildSelectionReferenceLabel(contextTarget?.anchor);

        if (!selectionText.trim()) return;

        setAssistLoading(true);
        setAssistError(null);
        setAssistSessionId(sessionIdForRequest);
        setPendingAssistExchange({
            sessionId: sessionIdForRequest,
            prompt: promptLabel,
            selectionText: contextTarget?.text || undefined,
            contextLabel: contextLabel || undefined,
            contextTab: contextTarget?.tab,
            contextAnchor: contextTarget?.anchor,
            createdAt: Date.now(),
        });
        if (contextTarget) {
            setAssistTarget(contextTarget);
            setSelectionMemory(contextTarget);
        }
        startTransition(() => setSidePanelTab('ai'));

        try {
            const response = await fetchWithRetry('/api/assist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action,
                    selection: selectionText,
                    documentText: contextText,
                    question: action === 'qa' ? assistQuestion.trim() : undefined,
                    history: assistHistory,
                    providerId: assistProviderId,
                    model: assistModel,
                    providerProfile,
                    targetLang,
                    extraTerms: enabledTerms,
                }),
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'AI 辅助请求失败');
            }

            await saveConversation({
                id: crypto.randomUUID(),
                fileHash,
                sessionId: sessionIdForRequest,
                targetLang: contextTarget?.tab === 'translation' ? targetLang : undefined,
                scope: contextTarget ? 'selection' : 'document',
                prompt: promptLabel,
                selectionText: contextTarget?.text || undefined,
                contextLabel: contextLabel || undefined,
                contextTab: contextTarget?.tab,
                contextAnchor: contextTarget?.anchor,
                response: data.text || '',
                providerId: assistProviderId,
                model: assistModel,
                createdAt: Date.now(),
            });

            emitSyncEvent({ type: 'conversation-updated', fileHash });
            await loadWorkspaceData();

            if (action === 'qa') {
                setAssistQuestion('');
            }
        } catch (assistRequestError) {
            setAssistError(assistRequestError instanceof Error ? assistRequestError.message : 'AI 辅助请求失败');
        } finally {
            setAssistLoading(false);
            setPendingAssistExchange(null);
        }
    };

    const submitAssistQuestion = () => {
        if (!canSubmitAssistQuestion) return;
        void runAssist('qa');
    };

    const canRunPaperPolish = Boolean(sourceMarkdown.trim()) && status !== 'uploading' && status !== 'parsing' && status !== 'translating';
    const paperPolishProcessing = paperPolishStatus === 'processing';
    const handleRunPaperPolish = () => {
        if (!canRunPaperPolish) return;
        void runPaperPolish('light');
    };

    const handleRunPaperPolishAiFallback = () => {
        if (!paperPolishCanUseAiFallback || paperPolishProcessing) return;
        void runPaperPolishAiFallback();
    };

    const handleUndoPaperPolish = () => {
        if (!paperPolishUndoVisible) return;
        void undoPaperPolish();
    };

    const sourcePanePolishClass = paperPolishVisualState === 'processing'
        ? 'paper-polish-shell is-processing'
        : paperPolishVisualState === 'fading'
            ? 'paper-polish-shell is-fading'
            : paperPolishVisualState === 'revealing'
                ? 'paper-polish-shell is-revealing'
                : 'paper-polish-shell';

    const locateAnnotation = (annotation: AnnotationRecord) => {
        const targetTab: EditorTab = annotation.targetLang ? 'translation' : 'source';
        return focusAnnotationLocation({
            tab: targetTab,
            anchor: annotation.anchor,
            selectedText: annotation.selectedText,
        });
    };

    const sharedStyles = `
        .markdown-body { background: transparent; color: inherit; font-family: inherit; }
        .markdown-body img { margin: 1.5rem auto; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); border-radius: 0.75rem; }
        .markdown-body figure[data-doti-figure-group] { margin: 1.75rem 0; }
        .markdown-body [data-doti-figure-grid] { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; align-items: start; }
        .markdown-body [data-doti-subfigure] { border: 1px solid rgba(226, 232, 240, 0.95); border-radius: 1rem; background: rgba(248, 250, 252, 0.85); padding: 0.9rem; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8); }
        .markdown-body [data-doti-subfigure] img { margin: 0 auto 0.75rem; width: 100%; }
        .markdown-body [data-doti-subcaption] { margin: 0; text-align: center; font-size: 0.92rem; line-height: 1.6; color: #334155; }
        .markdown-body figure[data-doti-figure-group] > figcaption { margin-top: 0.9rem; text-align: center; font-size: 0.95rem; line-height: 1.7; color: #475569; }
        .markdown-body .markdown-table-wrap { margin: 1.5rem 0; width: 100%; overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 0.95rem; background: #ffffff; box-shadow: inset 0 1px 0 rgba(255,255,255,0.75); }
        .markdown-body table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; table-layout: auto; }
        .markdown-body table th, .markdown-body table td { border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; padding: 8px 14px; vertical-align: top; line-height: 1.65; }
        .markdown-body table th { background: #f8fafc; font-weight: 600; color: #0f172a; }
        .markdown-body table tr:nth-child(2n) td { background-color: #fcfdff; }
        .markdown-body table tr > *:last-child { border-right: none; }
        .markdown-body table tbody tr:last-child > * { border-bottom: none; }
        .vlook-doc .markdown-body { font-size: 15px; line-height: 1.8; }
        .vlook-doc h1, .vlook-doc h2, .vlook-doc h3 { margin-top: 1.5em; margin-bottom: 0.5em; }
        .annotation-highlight { background: rgba(251, 191, 36, 0.4); box-shadow: inset 0 -1px 0 rgba(245, 158, 11, 0.25); }
        .workspace-scroll {
            scrollbar-width: thin;
            scrollbar-color: rgba(71, 85, 105, 0.9) rgba(226, 232, 240, 0.9);
            scrollbar-gutter: stable both-edges;
        }
        .workspace-scroll::-webkit-scrollbar {
            width: 12px;
            height: 12px;
        }
        .workspace-scroll::-webkit-scrollbar-track {
            background: rgba(226, 232, 240, 0.9);
            border-radius: 9999px;
        }
        .workspace-scroll::-webkit-scrollbar-thumb {
            border-radius: 9999px;
            background: rgba(100, 116, 139, 0.95);
            border: 2px solid transparent;
            background-clip: padding-box;
        }
        .workspace-scroll:hover::-webkit-scrollbar-thumb {
            background: rgba(51, 65, 85, 0.98);
            border: 2px solid transparent;
            background-clip: padding-box;
        }
        .paper-polish-shell {
            position: relative;
            min-height: 100%;
        }
        .paper-polish-shell.is-processing::before,
        .paper-polish-shell.is-fading::before {
            content: '';
            position: absolute;
            inset: 0;
            pointer-events: none;
            background:
                radial-gradient(circle at top left, rgba(125, 211, 252, 0.16), transparent 24%),
                radial-gradient(circle at top right, rgba(251, 191, 36, 0.16), transparent 22%),
                radial-gradient(circle at bottom left, rgba(192, 132, 252, 0.14), transparent 24%);
            opacity: 1;
            transition: opacity 280ms ease;
        }
        .paper-polish-shell.is-fading::before {
            opacity: 0.4;
        }
        .paper-polish-shell.is-processing .markdown-body > *,
        .paper-polish-shell.is-fading .markdown-body > * {
            position: relative;
            border: 1px solid rgba(255, 255, 255, 0.26);
            background: rgba(255, 255, 255, 0.14);
            backdrop-filter: blur(12px);
            box-shadow: 0 0 18px rgba(125, 211, 252, 0.24);
            text-shadow: 0 0 14px rgba(255, 255, 255, 0.18);
            border-radius: 1.1rem;
            transform: scale(1.02);
            transition: opacity 360ms ease, transform 360ms ease, filter 360ms ease;
            animation: paperPolishPulse 1.9s ease-in-out infinite;
            padding: 0.55rem 0.8rem;
        }
        .paper-polish-shell.is-processing .markdown-body > *:nth-child(4n + 1),
        .paper-polish-shell.is-fading .markdown-body > *:nth-child(4n + 1) {
            background: rgba(191, 219, 254, 0.16);
        }
        .paper-polish-shell.is-processing .markdown-body > *:nth-child(4n + 2),
        .paper-polish-shell.is-fading .markdown-body > *:nth-child(4n + 2) {
            background: rgba(254, 215, 170, 0.15);
        }
        .paper-polish-shell.is-processing .markdown-body > *:nth-child(4n + 3),
        .paper-polish-shell.is-fading .markdown-body > *:nth-child(4n + 3) {
            background: rgba(216, 180, 254, 0.14);
        }
        .paper-polish-shell.is-processing .markdown-body > *:nth-child(4n + 4),
        .paper-polish-shell.is-fading .markdown-body > *:nth-child(4n + 4) {
            background: rgba(134, 239, 172, 0.14);
        }
        .paper-polish-shell.is-fading .markdown-body > * {
            opacity: 0.28;
            transform: scale(0.92);
            filter: blur(6px);
        }
        .paper-polish-shell.is-revealing .markdown-body > * {
            opacity: 0;
            filter: blur(8px);
            transform: translateY(20px) scale(0.85);
            animation: paperPolishReveal 760ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(1) { animation-delay: 40ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(2) { animation-delay: 80ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(3) { animation-delay: 120ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(4) { animation-delay: 160ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(5) { animation-delay: 200ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(6) { animation-delay: 240ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(7) { animation-delay: 280ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(8) { animation-delay: 320ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(9) { animation-delay: 360ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(10) { animation-delay: 400ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(11) { animation-delay: 440ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(12) { animation-delay: 480ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(13) { animation-delay: 520ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(14) { animation-delay: 560ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(15) { animation-delay: 600ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(16) { animation-delay: 640ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(17) { animation-delay: 680ms; }
        .paper-polish-shell.is-revealing .markdown-body > *:nth-child(18) { animation-delay: 720ms; }
        .paper-polish-wand {
            position: relative;
            overflow: hidden;
        }
        .paper-polish-wand::after {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(120deg, transparent 0%, rgba(255,255,255,0.34) 40%, transparent 75%);
            transform: translateX(-120%);
            transition: transform 360ms ease;
        }
        .paper-polish-wand:hover::after {
            transform: translateX(120%);
        }
        .paper-polish-wand.is-idle {
            animation: paperPolishPulse 2.8s ease-in-out infinite;
        }
        @keyframes paperPolishPulse {
            0%, 100% { transform: scale(1); box-shadow: 0 0 0 rgba(56, 189, 248, 0.12); }
            50% { transform: scale(1.02); box-shadow: 0 0 22px rgba(56, 189, 248, 0.24); }
        }
        @keyframes paperPolishReveal {
            0% {
                opacity: 0;
                filter: blur(8px);
                transform: translateY(20px) scale(0.85);
                box-shadow: 0 0 18px rgba(96, 165, 250, 0.28);
            }
            60% {
                opacity: 1;
                filter: blur(0px);
                transform: translateY(0px) scale(1.01);
                box-shadow: 0 0 20px rgba(96, 165, 250, 0.18);
            }
            100% {
                opacity: 1;
                filter: blur(0px);
                transform: translateY(0px) scale(1);
                box-shadow: 0 0 0 rgba(96, 165, 250, 0);
            }
        }
        @keyframes highlightFlash {
            0% { background-color: transparent; }
            25% { background-color: rgba(59, 130, 246, 0.24); }
            100% { background-color: transparent; }
        }
        .highlight-flash { animation: highlightFlash 2s ease-out; border-radius: 8px; }
    `;

    if (status === 'idle' || status === 'uploading' || status === 'parsing') {
        return (
            <div className="flex h-full items-center justify-center rounded-[28px] border-2 border-dashed border-slate-300 bg-white/80 p-8 text-slate-500">
                {status === 'parsing' ? (
                    <div className="flex flex-col items-center gap-3">
                        <Loader2 className="animate-spin text-slate-900" size={32} />
                        <p>MinerU 正在解析 PDF...</p>
                        <span className="text-xs text-slate-400">{Math.round(progress)}%</span>
                    </div>
                ) : (
                    <p>上传或导入 PDF 后，这里会变成可批注的 Markdown 工作区。</p>
                )}
            </div>
        );
    }

    return (
        <div className="relative flex h-full flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
            <style>{sharedStyles}</style>

            {selection && (
                <div
                    onMouseDown={(event) => event.preventDefault()}
                    className="pointer-events-auto fixed z-40 -translate-x-1/2 rounded-full border border-slate-200 bg-white/95 px-2 py-2 shadow-xl backdrop-blur"
                    style={{ top: selection.top, left: selection.left }}
                >
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => {
                                setNoteTarget(selection);
                                startTransition(() => setSidePanelTab('notes'));
                            }}
                            className="rounded-full px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                        >
                            记笔记
                        </button>
                        <button
                            type="button"
                            onClick={() => void runAssist('explain', selection)}
                            className="rounded-full px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                        >
                            解释
                        </button>
                        <button
                            type="button"
                            onClick={() => void runAssist('summarize', selection)}
                            className="rounded-full px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                        >
                            总结
                        </button>
                        <button
                            type="button"
                            onClick={() => void runAssist('rewrite', selection)}
                            className="rounded-full px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                        >
                            改写
                        </button>
                        <button
                            type="button"
                            onClick={() => void runAssist('extract', selection)}
                            className="rounded-full px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                        >
                            提取
                        </button>
                    </div>
                </div>
            )}

            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 px-4 py-3">
                <div className="grid w-[220px] grid-cols-2 rounded-full bg-slate-200/70 p-1">
                    <button
                        type="button"
                        onClick={() => startTransition(() => setManualTab('translation'))}
                        className={`rounded-full px-3 py-1.5 text-sm transition ${activeTab === 'translation' ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
                    >
                        Translation
                    </button>
                    <button
                        type="button"
                        onClick={() => startTransition(() => setManualTab('source'))}
                        className={`rounded-full px-3 py-1.5 text-sm transition ${activeTab === 'source' ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
                    >
                        Source
                    </button>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-slate-500">
                    <label className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
                        <span className={`inline-flex h-2.5 w-2.5 rounded-full ${paperPolishAutoEnabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                        自动整理
                        <input
                            type="checkbox"
                            checked={paperPolishAutoEnabled}
                            onChange={(event) => setPaperPolishAutoEnabled(event.target.checked)}
                            className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900"
                        />
                    </label>

                    <button
                        type="button"
                        onClick={handleRunPaperPolish}
                        disabled={!canRunPaperPolish || paperPolishProcessing}
                        className={`paper-polish-wand inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${paperPolishProcessing
                            ? 'border-sky-200 bg-sky-50 text-sky-700'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700'
                            } ${!paperPolishProcessing ? 'is-idle' : ''}`}
                        title="先用本地结构信息快速修复当前 Markdown"
                    >
                        {paperPolishProcessing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                        <span>{paperPolishProcessing ? (paperPolishMode === 'deep' ? 'AI 深修中…' : '正在修复格式…') : '清理格式'}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${paperPolishProcessing ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-500'}`}>
                            {paperPolishProcessing ? `${Math.round(paperPolishProgress)}%` : paperPolishCanUseAiFallback ? `局部 ${paperPolishResidualCount}` : 'PaperPolish'}
                        </span>
                    </button>

                    {paperPolishCanUseAiFallback && !paperPolishProcessing ? (
                        <button
                            type="button"
                            onClick={handleRunPaperPolishAiFallback}
                            className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-700 transition hover:border-amber-300 hover:bg-amber-100"
                            title="仅对残留的少量疑难窗口进行 AI 兜底"
                        >
                            <Sparkles size={14} />
                            AI 深修
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                                {paperPolishResidualCount}
                            </span>
                        </button>
                    ) : null}

                    {paperPolishProcessing ? (
                        <button
                            type="button"
                            onClick={cancelPaperPolish}
                            className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
                        >
                            <X size={12} />
                            取消
                        </button>
                    ) : null}

                    {paperPolishUndoVisible ? (
                        <button
                            type="button"
                            onClick={handleUndoPaperPolish}
                            className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100"
                        >
                            <RotateCcw size={12} />
                            撤销
                        </button>
                    ) : null}

                    {paperPolishStatus === 'completed' && paperPolishSummary[0] ? (
                        <span className="hidden rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] text-sky-700 xl:inline-flex">
                            <CheckCircle2 size={12} className="mr-1" />
                            {paperPolishSummary[0]}
                        </span>
                    ) : null}

                    {status === 'parsed' && <span className="font-medium text-sky-600">可开始翻译</span>}
                    {status === 'translating' && (
                        <>
                            <Loader2 className="h-3 w-3 animate-spin text-slate-900" />
                            <span>{error ? '翻译中断' : translationHeaderLabel}</span>
                            {translationStatus ? (
                                <span className={`hidden rounded-full px-2.5 py-1 xl:inline ${translationPhase === 'stalled'
                                    ? 'bg-red-50 text-red-600'
                                    : 'bg-amber-50 text-amber-700'
                                    }`}>
                                    {translationStatus}
                                </span>
                            ) : null}
                        </>
                    )}
                    {status === 'completed' && <span className="font-medium text-emerald-600">译文已完成</span>}
                    {status === 'error' && <span className="font-medium text-red-600">翻译异常</span>}
                </div>
            </div>

            {(paperPolishProcessing || (paperPolishStatus === 'completed' && paperPolishMessage) || (paperPolishStatus === 'error' && error)) ? (
                <div className="border-b border-slate-200 bg-white/80 px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                            {paperPolishProcessing ? <Loader2 size={14} className="animate-spin text-sky-600" /> : <Sparkles size={14} className="text-sky-600" />}
                            <span>{paperPolishMessage || 'PaperPolish 已就绪'}</span>
                        </div>
                        {paperPolishProcessing ? (
                            <div className="flex min-w-[220px] flex-1 items-center gap-3">
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                                    <div
                                        className="h-full rounded-full bg-[linear-gradient(90deg,#38bdf8,#60a5fa,#f59e0b)] transition-all duration-500"
                                        style={{ width: `${Math.min(100, Math.max(paperPolishProgress, 0))}%` }}
                                    />
                                </div>
                                <span className="text-xs font-semibold text-sky-700">{Math.round(paperPolishProgress)}%</span>
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="relative min-h-0 overflow-hidden">
                    <div
                        ref={translationPaneRef}
                        onContextMenu={onTranslationWorkspaceContextMenu}
                        className={`workspace-scroll absolute inset-0 overflow-auto p-6 ${vlookLoaded ? 'vlook-doc' : 'prose prose-slate max-w-none'} ${activeTab === 'translation' ? 'visible' : 'invisible'}`}
                    >
                        <StreamingTranslationPane
                            viewportRef={translationPaneRef}
                            onFramesChange={handleTranslationFramesChange}
                        />
                    </div>

                    <div
                        ref={sourcePaneRef}
                        className={`workspace-scroll absolute inset-0 overflow-auto p-6 ${vlookLoaded ? 'vlook-doc' : 'prose prose-slate max-w-none'} ${activeTab === 'source' ? 'visible' : 'invisible'}`}
                    >
                        <div className={sourcePanePolishClass}>
                            {sourceProjection ? (
                                <StructuredSourceView projection={sourceProjection} />
                            ) : (
                                <MarkdownView value={displayedSourceMarkdown || renderedSourceMarkdown || '_No source content available_'} />
                            )}
                        </div>
                    </div>
                </div>

                <aside className="flex min-h-0 flex-col overflow-hidden border-t border-slate-200 bg-slate-50/60 lg:border-l lg:border-t-0">
                    <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
                        <button
                            type="button"
                            onClick={() => startTransition(() => setSidePanelTab('notes'))}
                            className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition ${sidePanelTab === 'notes' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:text-slate-900'}`}
                        >
                            <NotebookPen size={14} />
                            笔记
                        </button>
                        <button
                            type="button"
                            onClick={() => startTransition(() => setSidePanelTab('ai'))}
                            className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition ${sidePanelTab === 'ai' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:text-slate-900'}`}
                        >
                            <Sparkles size={14} />
                            AI 辅助
                        </button>
                    </div>
                    {sidePanelTab === 'notes' ? (
                        <div className="flex min-h-0 flex-1 flex-col">
                            <div className="shrink-0 border-b border-slate-200 bg-white/90 px-4 py-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium text-slate-900">笔记时间线</div>
                                        <p className="mt-1 text-xs text-slate-500">
                                            划线后直接记录，下面按时间倒序查看和回跳。
                                        </p>
                                    </div>
                                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                                        {sortedAnnotations.length} 条
                                    </span>
                                </div>
                                <div className="mt-3 flex items-center gap-2">
                                    <div className="relative min-w-0 flex-1">
                                        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                        <input
                                            type="search"
                                            value={noteSearch}
                                            onChange={(event) => setNoteSearch(event.target.value)}
                                            placeholder="搜索正文、笔记或标签"
                                            className="w-full rounded-2xl border border-slate-200 py-3 pl-9 pr-3 text-sm outline-none transition focus:border-slate-400"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => downloadTextFile(`${fileHash || 'document'}-annotations.md`, annotationListToMarkdown(sortedAnnotations))}
                                        className="shrink-0 rounded-2xl border border-slate-200 px-3 py-3 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                    >
                                        导出
                                    </button>
                                </div>
                            </div>

                            <div className="workspace-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
                                <div className="space-y-4">
                                    <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="text-sm font-medium text-slate-900">新建笔记</div>
                                                <p className="mt-1 text-xs text-slate-500">
                                                    当前划选会自动带入，保存后可随时回跳定位。
                                                </p>
                                            </div>
                                            {activeNoteTarget ? (
                                                <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                                                    已捕获选区
                                                </span>
                                            ) : null}
                                        </div>

                                        <div className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-3 py-3 text-sm leading-6 text-slate-600">
                                            {activeNoteTarget ? (
                                                <CollapsibleText
                                                    text={activeNoteTarget.text}
                                                    expanded={noteTargetExpanded}
                                                    onToggle={() => setNoteTargetExpanded((current) => !current)}
                                                    maxChars={COLLAPSE_LIMITS.panelPreview}
                                                    className="whitespace-pre-wrap"
                                                />
                                            ) : (
                                                <div className="text-slate-500">
                                                    在左侧正文中选中内容后，这里会显示你要记录的原文片段。
                                                </div>
                                            )}
                                        </div>

                                        <textarea
                                            value={noteDraft}
                                            onChange={(event) => setNoteDraft(event.target.value)}
                                            rows={4}
                                            placeholder="记录你的理解、疑问或待办"
                                            className="mt-3 w-full rounded-2xl border border-slate-200 px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                                        />
                                        <input
                                            type="text"
                                            value={noteTags}
                                            onChange={(event) => setNoteTags(event.target.value)}
                                            placeholder="标签，用逗号分隔，如 proof, todo"
                                            className="mt-3 w-full rounded-2xl border border-slate-200 px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                                        />
                                        <div className="mt-3 flex gap-2">
                                            <button
                                                type="button"
                                                onClick={() => void saveCurrentNote()}
                                                disabled={!canSaveNote}
                                                className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                <MessageSquarePlus size={15} />
                                                保存笔记
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setNoteTarget(null);
                                                    setNoteDraft('');
                                                    setNoteTags('');
                                                    clearEditorSelection();
                                                }}
                                                className="rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                            >
                                                清空
                                            </button>
                                        </div>
                                    </section>

                                    {sortedAnnotations.length > 0 ? (
                                        <div className="space-y-3">
                                            {sortedAnnotations.map((annotation) => {
                                                const expanded = Boolean(expandedAnnotationIds[annotation.id]);
                                                const quoteExpandable = isTextCollapsible(annotation.selectedText, COLLAPSE_LIMITS.annotationQuote);
                                                const noteExpandable = isTextCollapsible(annotation.note, COLLAPSE_LIMITS.annotationNote);

                                                return (
                                                    <article key={annotation.id} className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="min-w-0 flex-1">
                                                                <div className="text-xs uppercase tracking-[0.14em] text-slate-400">
                                                                    {annotation.targetLang ? 'Translation' : 'Source'} · {new Date(annotation.createdAt).toLocaleString()}
                                                                </div>
                                                                <div className="mt-2 rounded-2xl bg-slate-50 px-3 py-3">
                                                                    <CollapsibleText
                                                                        text={annotation.selectedText}
                                                                        expanded={expanded}
                                                                        onToggle={() => toggleAnnotationExpanded(annotation.id)}
                                                                        maxChars={COLLAPSE_LIMITS.annotationQuote}
                                                                        className="whitespace-pre-wrap text-sm leading-6 text-slate-700"
                                                                        showToggle={false}
                                                                    />
                                                                </div>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={() => void deleteAnnotationRecord(annotation.id).then(async () => {
                                                                    emitSyncEvent({ type: 'annotation-updated', fileHash: fileHash || undefined });
                                                                    await loadWorkspaceData();
                                                                })}
                                                                className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                                                                aria-label="Delete annotation"
                                                            >
                                                                <Trash2 size={14} />
                                                            </button>
                                                        </div>
                                                        <CollapsibleText
                                                            text={annotation.note}
                                                            expanded={expanded}
                                                            onToggle={() => toggleAnnotationExpanded(annotation.id)}
                                                            maxChars={COLLAPSE_LIMITS.annotationNote}
                                                            className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600"
                                                            showToggle={false}
                                                        />
                                                        {(quoteExpandable || noteExpandable) ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleAnnotationExpanded(annotation.id)}
                                                                className="mt-2 text-xs font-medium text-slate-500 transition hover:text-slate-900"
                                                            >
                                                                {expanded ? '收起' : '展开'}
                                                            </button>
                                                        ) : null}
                                                        {annotation.tags?.length ? (
                                                            <div className="mt-3 flex flex-wrap gap-2">
                                                                {annotation.tags.map((tag) => (
                                                                    <span key={tag} className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-500">
                                                                        {tag}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        ) : null}
                                                        <div className="mt-4 flex gap-2">
                                                            <button
                                                                type="button"
                                                                onClick={() => locateAnnotation(annotation)}
                                                                className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                                            >
                                                                回到原文
                                                            </button>
                                                        </div>
                                                    </article>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
                                            还没有笔记，先在正文中选一段文字试试。
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="flex min-h-0 flex-1 flex-col bg-white">
                            <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-2">
                                <div className="flex items-center gap-2">
                                    <label className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                                        <select
                                            value={currentAssistSessionId}
                                            onChange={(event) => {
                                                setAssistSessionId(event.target.value);
                                                setAssistError(null);
                                            }}
                                            className="min-w-0 flex-1 bg-transparent text-xs font-medium text-slate-700 outline-none"
                                        >
                                            <option value="draft-session">当前新对话</option>
                                            {assistSessionSummaries.map((session) => (
                                                <option key={session.id} value={session.id}>
                                                    {session.title} · {session.count} 轮
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <ModelSelector mode="assist" compact />
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setAssistSessionId('draft-session');
                                            setAssistQuestion('');
                                            setAssistError(null);
                                            setPendingAssistExchange(null);
                                        }}
                                        className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                        aria-label="新建对话"
                                        title="新建对话"
                                    >
                                        新建
                                    </button>
                                </div>
                            </div>

                            <div ref={conversationListRef} className="workspace-scroll min-h-0 flex-1 overflow-y-auto bg-slate-50/50 px-3 py-3">
                                {sortedConversations.length > 0 || pendingExchangeVisible ? (
                                    <div className="space-y-4">
                                        {sortedConversations.map((conversation) => {
                                            const expanded = Boolean(expandedConversationIds[conversation.id]);
                                            const responseExpandable = isTextCollapsible(conversation.response, COLLAPSE_LIMITS.conversationResponse);
                                            const contextLabel = conversation.contextLabel || buildSelectionReferenceLabel(conversation.contextAnchor);
                                            const contextTab = conversation.contextTab || (conversation.contextAnchor
                                                ? (conversation.targetLang ? 'translation' : 'source')
                                                : undefined);

                                            return (
                                                <div key={conversation.id} className="space-y-2">
                                                    <div className="ml-auto max-w-[88%] rounded-[24px] bg-slate-900 px-4 py-3 text-white shadow-sm">
                                                        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
                                                            <span className="truncate">{conversation.prompt}</span>
                                                            <span className="shrink-0">
                                                                {new Date(conversation.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                            </span>
                                                        </div>
                                                        {contextLabel ? (
                                                            <div className="mt-2 flex items-center">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        if (!contextTab || !conversation.contextAnchor) return;
                                                                        focusContextReference({
                                                                            tab: contextTab,
                                                                            anchor: conversation.contextAnchor,
                                                                            selectedText: conversation.selectionText,
                                                                        });
                                                                    }}
                                                                    className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium transition ${
                                                                        contextTab && conversation.contextAnchor
                                                                            ? 'bg-white/10 text-white hover:bg-white/15'
                                                                            : 'bg-white/10 text-slate-300'
                                                                    }`}
                                                                >
                                                                    {contextLabel}
                                                                </button>
                                                            </div>
                                                        ) : null}
                                                    </div>

                                                    <div className="max-w-[92%] rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-3 shadow-sm">
                                                        <div className="flex items-center justify-between gap-2">
                                                            <div className="text-[11px] uppercase tracking-[0.14em] text-slate-400">
                                                                Assistant
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={() => void deleteConversationRecord(conversation.id).then(async () => {
                                                                    emitSyncEvent({ type: 'conversation-updated', fileHash: fileHash || undefined });
                                                                    await loadWorkspaceData();
                                                                })}
                                                                className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                                                                aria-label="Delete conversation"
                                                            >
                                                                <Trash2 size={14} />
                                                            </button>
                                                        </div>
                                                        <CollapsibleText
                                                            text={conversation.response}
                                                            expanded={expanded}
                                                            onToggle={() => toggleConversationExpanded(conversation.id)}
                                                            maxChars={COLLAPSE_LIMITS.conversationResponse}
                                                            className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700"
                                                            showToggle={false}
                                                        />
                                                        {responseExpandable ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleConversationExpanded(conversation.id)}
                                                                className="mt-2 text-xs font-medium text-slate-500 transition hover:text-slate-900"
                                                            >
                                                                {expanded ? '收起回答' : '展开回答'}
                                                            </button>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        {pendingAssistExchange && pendingExchangeVisible ? (
                                            <div className="space-y-2">
                                                <div className="ml-auto max-w-[88%] rounded-[24px] bg-slate-900 px-4 py-3 text-white shadow-sm ring-1 ring-slate-800/10">
                                                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
                                                        <span className="truncate">{pendingAssistExchange.prompt}</span>
                                                        <span className="shrink-0">
                                                            {new Date(pendingAssistExchange.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </span>
                                                    </div>
                                                    {pendingAssistExchange.contextLabel ? (
                                                        <div className="mt-2 flex items-center">
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    if (!pendingAssistExchange.contextTab || !pendingAssistExchange.contextAnchor) return;
                                                                    focusContextReference({
                                                                        tab: pendingAssistExchange.contextTab,
                                                                        anchor: pendingAssistExchange.contextAnchor,
                                                                        selectedText: pendingAssistExchange.selectionText,
                                                                    });
                                                                }}
                                                                className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium transition ${
                                                                    pendingAssistExchange.contextTab && pendingAssistExchange.contextAnchor
                                                                        ? 'bg-white/10 text-white hover:bg-white/15'
                                                                        : 'bg-white/10 text-slate-300'
                                                                }`}
                                                            >
                                                                {pendingAssistExchange.contextLabel}
                                                            </button>
                                                        </div>
                                                    ) : null}
                                                </div>
                                                <div className="max-w-[92%] rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-3 shadow-sm">
                                                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-slate-400">
                                                        <Loader2 size={13} className="animate-spin" />
                                                        Assistant 正在回复
                                                    </div>
                                                    <div className="mt-2 text-sm leading-6 text-slate-500">
                                                        请求已经发出，正在生成回答...
                                                    </div>
                                                </div>
                                            </div>
                                        ) : null}
                                    </div>
                                ) : (
                                    <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-10 text-center text-sm text-slate-500">
                                        <div className="font-medium text-slate-700">当前会话还没有消息</div>
                                        <p className="mt-2 leading-6">
                                            先在左侧选中一段文字，或者直接输入问题开始对话。
                                        </p>
                                        {assistSessionSummaries.length > 0 ? (
                                            <p className="mt-2 text-xs text-slate-400">
                                                上方会话下拉框可以随时切回之前的聊天记录。
                                            </p>
                                        ) : null}
                                    </div>
                                )}
                            </div>

                            <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-2">
                                <div className="rounded-[22px] border border-slate-200 bg-white px-2.5 py-2">
                                    <div className="workspace-scroll -mx-0.5 flex items-center gap-2 overflow-x-auto px-0.5 pb-1">
                                        {activeAssistContext && activeAssistContextLabel ? (
                                            <button
                                                type="button"
                                                onClick={() => focusContextReference({
                                                    tab: activeAssistContext.tab,
                                                    anchor: activeAssistContext.anchor,
                                                    selectedText: activeAssistContext.text,
                                                })}
                                                className="inline-flex shrink-0 items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white transition hover:bg-slate-800"
                                            >
                                                <span>{activeAssistContextLabel}</span>
                                                <span className="text-slate-300">{assistTargetLocked ? '锁定' : '跟随'}</span>
                                            </button>
                                        ) : (
                                            <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                                                全文模式
                                            </span>
                                        )}
                                        {currentAssistSelection && !assistTargetLocked ? (
                                            <button
                                                type="button"
                                                onClick={() => setAssistTarget(currentAssistSelection)}
                                                className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                            >
                                                锁定
                                            </button>
                                        ) : null}
                                        {assistTargetLocked && canRefreshAssistTarget ? (
                                            <button
                                                type="button"
                                                onClick={() => currentAssistSelection && setAssistTarget(currentAssistSelection)}
                                                className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                            >
                                                更新
                                            </button>
                                        ) : null}
                                        {assistTargetLocked ? (
                                            <button
                                                type="button"
                                                onClick={() => setAssistTarget(null)}
                                                className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                            >
                                                解锁
                                            </button>
                                        ) : null}
                                        {activeAssistContext ? (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setAssistTarget(null);
                                                    setSelectionMemory(null);
                                                }}
                                                className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                            >
                                                全文
                                            </button>
                                        ) : null}
                                        <button
                                            type="button"
                                            onClick={() => void runAssist('explain')}
                                            className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                        >
                                            解释
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void runAssist('summarize')}
                                            className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                        >
                                            总结
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void runAssist('rewrite')}
                                            className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                        >
                                            改写
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void runAssist('extract')}
                                            className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                        >
                                            提取
                                        </button>
                                    </div>

                                    <div className="mt-1.5 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                                        <textarea
                                            ref={assistQuestionRef}
                                            value={assistQuestion}
                                            onChange={(event) => setAssistQuestion(event.target.value)}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                                                    event.preventDefault();
                                                    submitAssistQuestion();
                                                }
                                            }}
                                            rows={3}
                                            placeholder={activeAssistContextLabel ? `围绕 ${activeAssistContextLabel} 继续追问...` : '输入问题，直接开始对话...'}
                                            className="min-h-[52px] w-full resize-none bg-transparent text-sm outline-none placeholder:text-slate-400"
                                        />
                                        <div className="mt-1.5 flex items-center justify-end gap-3 border-t border-slate-200 pt-1.5">
                                            <button
                                                type="button"
                                                onClick={submitAssistQuestion}
                                                disabled={!canSubmitAssistQuestion}
                                                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {assistLoading ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
                                                发送
                                            </button>
                                        </div>
                                    </div>

                                    {assistError ? (
                                        <p className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                                            {assistError}
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    )}
                </aside>
            </div>
        </div>
    );
}

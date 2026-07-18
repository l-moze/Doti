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
import { getUserFacingErrorMessage, useTranslationStore } from '@/lib/store';
import { emitSyncEvent, subscribeSyncEvents } from '@/lib/sync-channel';
import {
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
import { CheckCircle2, Loader2, MessageSquarePlus, NotebookPen, Plus, RotateCcw, Search, Settings2, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';

type SidePanelTab = 'notes' | 'ai';
type AssistAction = 'explain' | 'summarize' | 'rewrite' | 'extract' | 'qa';
export type ReaderView = EditorTab | 'compare';
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
    if (!semanticBlockId) return '所选片段';

    const match = semanticBlockId.match(/^sec-(\d+)-([a-z]+)-(\d+)$/i);
    if (!match) return '所选片段';

    const [, section, rawType, index] = match;
    const sectionNumber = Number(section) + 1;
    const itemNumber = Number(index) + 1;
    const typeKey = rawType.toLowerCase();

    if (typeKey === 'title') {
        return `第 ${sectionNumber} 节标题`;
    }
    if (typeKey === 'text') return `第 ${sectionNumber} 节，第 ${itemNumber} 段`;
    if (typeKey === 'image') return `第 ${sectionNumber} 节，第 ${itemNumber} 张图`;
    if (typeKey === 'table') return `第 ${sectionNumber} 节，第 ${itemNumber} 个表格`;
    if (typeKey === 'formula') return `第 ${sectionNumber} 节，第 ${itemNumber} 个公式`;
    if (typeKey === 'list') return `第 ${sectionNumber} 节，第 ${itemNumber} 个列表`;
    if (typeKey === 'code') return `第 ${sectionNumber} 节，第 ${itemNumber} 段代码`;

    return `第 ${sectionNumber} 节，所选片段`;
}

function buildSelectionReferenceLabel(anchor?: AnnotationAnchorRecord | null): string | null {
    if (!anchor) return null;

    return formatSemanticBlockLabel(anchor.semanticBlockId);
}

function getEditorTabLabel(tab?: EditorTab | null): string {
    if (tab === 'translation') return '译文';
    if (tab === 'source') return '原文';
    return '全文';
}

function buildContextLabelFromParts(tab?: EditorTab | null, referenceLabel?: string | null): string {
    const trimmed = referenceLabel?.trim();
    if (trimmed) {
        return tab ? `${getEditorTabLabel(tab)} · ${trimmed}` : trimmed;
    }

    return getEditorTabLabel(tab);
}

function buildAssistContextLabel(selection?: SelectionSnapshot | null): string {
    const referenceLabel = buildSelectionReferenceLabel(selection?.anchor);
    return buildContextLabelFromParts(selection?.tab, referenceLabel);
}

function buildConversationContextLabel(
    savedLabel?: string | null,
    tab?: EditorTab | null,
    anchor?: AnnotationAnchorRecord | null
): string | null {
    const trimmed = savedLabel?.trim();
    if (trimmed) {
        const withoutPrefix = trimmed.replace(/^来自\s*/, '');
        if (withoutPrefix.includes('·')) return withoutPrefix;
        return tab ? `${getEditorTabLabel(tab)} · ${withoutPrefix}` : withoutPrefix;
    }

    const referenceLabel = buildSelectionReferenceLabel(anchor);
    return referenceLabel || tab ? buildContextLabelFromParts(tab, referenceLabel) : null;
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
    onReaderViewChange?: (view: ReaderView) => void;
    onExportNotes: () => void;
    onVisibleExportModeChange?: (mode: 'translation-notes' | 'source-notes' | 'bilingual-notes' | null) => void;
    sourceProjection?: DocumentSemanticProjection | null;
}

export function MarkdownEditor({
    onReaderViewChange,
    onExportNotes,
    onVisibleExportModeChange,
    sourceProjection = null,
}: MarkdownEditorProps) {
    const {
        sourceMarkdown,
        targetMarkdown,
        translationBlocks,
        batchId,
        status,
        progress,
        highlightedBlockId,
        fileHash,
        targetLang,
        assistProviderId,
        assistModel,
        paperPolishStatus,
        paperPolishMode,
        paperPolishProgress,
        paperPolishMessage,
        paperPolishSummary,
        paperPolishResidualCount,
        paperPolishCanUseAiFallback,
        paperPolishAutoEnabled,
        paperPolishUndoExpiresAt,
        paperPolishRevealKey,
        translationStatus,
        translationPhase,
        translationConcurrency,
        error,
        hasTranslationContent,
        translationDecorationVersion,
    } = useTranslationStore(useShallow((state) => {
        const completedBlockCount = state.translationBlocks.reduce((count, block) => (
            block.state === 'completed' || block.state === 'cached'
                ? count + 1
                : count
        ), 0);
        const isRecoverableParseTask = Boolean(
            state.batchId &&
            state.fileHash &&
            (state.status === 'parsing' || (state.status === 'error' && !state.sourceMarkdown.trim()))
        );

        return {
            sourceMarkdown: state.sourceMarkdown,
            targetMarkdown: state.targetMarkdown,
            translationBlocks: state.translationBlocks,
            batchId: state.batchId,
            status: state.status,
            progress: state.progress,
            highlightedBlockId: state.highlightedBlockId,
            fileHash: state.fileHash,
            targetLang: state.targetLang,
            assistProviderId: state.assistProviderId,
            assistModel: state.assistModel,
            paperPolishStatus: state.paperPolishStatus,
            paperPolishMode: state.paperPolishMode,
            paperPolishProgress: state.paperPolishProgress,
            paperPolishMessage: state.paperPolishMessage,
            paperPolishSummary: state.paperPolishSummary,
            paperPolishResidualCount: state.paperPolishIssueWindows.length,
            paperPolishCanUseAiFallback: state.paperPolishCanUseAiFallback,
            paperPolishAutoEnabled: state.paperPolishAutoEnabled,
            paperPolishUndoExpiresAt: state.paperPolishUndoExpiresAt,
            paperPolishRevealKey: state.paperPolishRevealKey,
            translationStatus: state.translationStatus,
            translationPhase: state.translationPhase,
            translationConcurrency: state.translationConcurrency,
            error: state.error,
            hasTranslationContent: isRecoverableParseTask
                ? false
                : state.translationBlocks.length > 0 || Boolean(state.targetMarkdown.trim()),
            translationDecorationVersion: isRecoverableParseTask
                ? `${completedBlockCount}:0`
                : `${completedBlockCount}:${state.targetMarkdown.trim().length > 0 ? 1 : 0}`,
        };
    }));
    const {
        setHighlightedBlock,
        setPaperPolishAutoEnabled,
        runPaperPolish,
        runPaperPolishAiFallback,
        cancelPaperPolish,
        undoPaperPolish,
        saveEditedTranslation,
    } = useTranslationStore(useShallow((state) => ({
        setHighlightedBlock: state.setHighlightedBlock,
        setPaperPolishAutoEnabled: state.setPaperPolishAutoEnabled,
        runPaperPolish: state.runPaperPolish,
        runPaperPolishAiFallback: state.runPaperPolishAiFallback,
        cancelPaperPolish: state.cancelPaperPolish,
        undoPaperPolish: state.undoPaperPolish,
        saveEditedTranslation: state.saveEditedTranslation,
    })));

    const vlookLoaded = useVlookStyle();
    const [manualView, setManualView] = useState<ReaderView | null>(null);
    const [sidePanelOpen, setSidePanelOpen] = useState(false);
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
    const [assistAdvancedOpen, setAssistAdvancedOpen] = useState(false);
    const [assistSuggestionsOpen, setAssistSuggestionsOpen] = useState(false);
    const [formatMenuOpen, setFormatMenuOpen] = useState(false);
    const [translationEditMode, setTranslationEditMode] = useState(false);
    const [translationEditDraft, setTranslationEditDraft] = useState('');
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
    const comparePaneRef = useRef<HTMLDivElement | null>(null);
    const compareTranslationPaneRef = useRef<HTMLDivElement | null>(null);
    const compareSourcePaneRef = useRef<HTMLDivElement | null>(null);
    const conversationListRef = useRef<HTMLDivElement | null>(null);
    const assistQuestionRef = useRef<HTMLTextAreaElement | null>(null);
    const previousHighlightedBlockIdRef = useRef<string | null>(null);
    const translationFrameMapRef = useRef<Record<string, TranslationStreamFrame>>({});
    const pointerSelectionActiveRef = useRef(false);
    const pointerSelectionCommitRef = useRef<number | null>(null);
    const paperPolishTimersRef = useRef<number[]>([]);

    const isRecoverableParseTask = Boolean(
        batchId &&
        fileHash &&
        (status === 'parsing' || (status === 'error' && !sourceMarkdown.trim()))
    );
    const effectiveSourceMarkdown = isRecoverableParseTask ? '' : sourceMarkdown;
    const renderedSourceMarkdown = useMemo(() => normalizeMarkdownMathForDisplay(effectiveSourceMarkdown), [effectiveSourceMarkdown]);
    const activeView: ReaderView = manualView ?? (status === 'parsed' && !hasTranslationContent ? 'source' : 'translation');
    const activeDocumentTab: EditorTab = activeView === 'source' ? 'source' : 'translation';
    const translationHeaderLabel = translationConcurrency > 1 ? `正在生成译文 · ${translationConcurrency} 路` : '正在生成译文';
    const editableTranslationMarkdown = useMemo(() => (
        targetMarkdown.trim()
            ? targetMarkdown
            : buildMarkdownFromTranslationBlocks(translationBlocks)
    ), [targetMarkdown, translationBlocks]);

    useEffect(() => {
        onReaderViewChange?.(activeView);
    }, [activeView, onReaderViewChange]);

    useEffect(() => {
        setManualView(null);
    }, [fileHash, targetLang]);

    useEffect(() => {
        if (!onVisibleExportModeChange) return;

        const nextMode = sidePanelOpen && sidePanelTab === 'notes'
            ? activeView === 'compare'
                ? 'bilingual-notes'
                : activeView === 'source'
                    ? 'source-notes'
                    : activeView === 'translation'
                        ? 'translation-notes'
                        : 'translation-notes'
            : null;

        onVisibleExportModeChange(nextMode);

        return () => onVisibleExportModeChange(null);
    }, [activeView, onVisibleExportModeChange, sidePanelOpen, sidePanelTab]);

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
            startTransition(() => setManualView('source'));
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

        const container = activeView === 'compare'
            ? (target.tab === 'translation' ? compareTranslationPaneRef.current : compareSourcePaneRef.current)
            : (target.tab === 'translation' ? translationPaneRef.current : sourcePaneRef.current);
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
    }, [activeView, fileHash, localizeAnnotationForBody, resolveTranslationBlockIdForAnchor, targetLang]);

    const focusAnnotationLocation = useCallback((target: {
        tab: EditorTab;
        anchor?: AnnotationAnchorRecord;
        selectedText?: string;
    }) => {
        if (!target.anchor) return () => undefined;

        if (activeView !== 'compare') {
            startTransition(() => setManualView(target.tab));
        }

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
    }, [activeView, findAnnotationLocation, scrollTranslationPaneToBlock, setHighlightedBlock]);

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
        setAssistAdvancedOpen(false);
        setAssistSuggestionsOpen(false);
        setSidePanelOpen(false);
        setFormatMenuOpen(false);
        setTranslationEditMode(false);
        setTranslationEditDraft('');
        setAssistError(null);
        setAssistSessionId(null);
        setPendingAssistExchange(null);
        setNoteTargetExpanded(false);
        setExpandedAnnotationIds({});
        setExpandedConversationIds({});
    }, [fileHash, activeDocumentTab]);

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

        applyDecorations([
            ...getMarkdownBodies(translationPaneRef.current),
            ...getMarkdownBodies(compareTranslationPaneRef.current),
        ], translationAnnotations, 'translation');
        applyDecorations([
            ...getMarkdownBodies(sourcePaneRef.current),
            ...getMarkdownBodies(compareSourcePaneRef.current),
        ], sourceAnnotations, 'source');
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
        const compareTranslationContainer = compareTranslationPaneRef.current;
        const compareSourceContainer = compareSourcePaneRef.current;
        translationContainer?.addEventListener('scroll', scheduleDecorate, { passive: true });
        sourceContainer?.addEventListener('scroll', scheduleDecorate, { passive: true });
        compareTranslationContainer?.addEventListener('scroll', scheduleDecorate, { passive: true });
        compareSourceContainer?.addEventListener('scroll', scheduleDecorate, { passive: true });

        return () => {
            window.clearTimeout(timer);
            if (frame !== 0) {
                window.cancelAnimationFrame(frame);
            }
            translationContainer?.removeEventListener('scroll', scheduleDecorate);
            sourceContainer?.removeEventListener('scroll', scheduleDecorate);
            compareTranslationContainer?.removeEventListener('scroll', scheduleDecorate);
            compareSourceContainer?.removeEventListener('scroll', scheduleDecorate);
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
            attachHashNavigation(compareTranslationPaneRef.current),
            attachHashNavigation(compareSourcePaneRef.current),
        ];

        return () => {
            for (const cleanup of cleanups) {
                cleanup();
            }
        };
    }, [renderedSourceMarkdown, setHighlightedBlock, translationDecorationVersion]);

    const handleSemanticBlockClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('a,button,textarea,input,select')) return;

        const block = target?.closest<HTMLElement>('[data-semantic-block-id]');
        const semanticId = block?.dataset.semanticBlockId;
        if (!semanticId) return;

        setHighlightedBlock(semanticId);
    }, [setHighlightedBlock]);

    useEffect(() => {
        if (!highlightedBlockId) {
            previousHighlightedBlockIdRef.current = null;
            return;
        }
        if (previousHighlightedBlockIdRef.current === highlightedBlockId) return;
        previousHighlightedBlockIdRef.current = highlightedBlockId;

        const parentSemanticId = highlightedBlockId.match(/^(sec-\d+-[a-z]+-\d+)-child-\d+$/)?.[1] || null;
        const semanticSelectors = highlightedBlockId.startsWith('sec-')
            ? [
                `[data-semantic-block-id="${highlightedBlockId}"]`,
                ...(parentSemanticId ? [`[data-semantic-block-id="${parentSemanticId}"]`] : []),
            ]
            : [`[data-heading-index="${highlightedBlockId}"]`];

        const findTarget = (tab: EditorTab) => {
            const container = activeView === 'compare'
                ? (tab === 'translation' ? compareTranslationPaneRef.current : compareSourcePaneRef.current)
                : (tab === 'translation' ? translationPaneRef.current : sourcePaneRef.current);
            if (!container) return null;

            const roots = [container, ...getMarkdownBodies(container)];
            for (const body of roots) {
                for (const selector of semanticSelectors) {
                    const element = body.querySelector<HTMLElement>(selector);
                    if (element) {
                        return { tab, element };
                    }
                }
            }

            return null;
        };

        const preferredTab = activeView === 'source' ? 'source' : 'translation';
        const fallbackTab = preferredTab === 'translation' ? 'source' : 'translation';
        const found = findTarget(preferredTab) || findTarget(fallbackTab);
        if (!found) return;

        if (activeView !== 'compare' && found.tab !== activeDocumentTab) {
            startTransition(() => setManualView(found.tab));
        }

        const timer = window.setTimeout(() => {
            found.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            found.element.classList.add('highlight-flash');
            window.setTimeout(() => found.element.classList.remove('highlight-flash'), 2000);
        }, 120);

        return () => window.clearTimeout(timer);
    }, [activeDocumentTab, activeView, highlightedBlockId]);

    useEffect(() => {
        const resolveActiveSelectionPane = (target?: Node | null): { tab: EditorTab; container: HTMLDivElement | null } | null => {
            const panes: Array<{ tab: EditorTab; container: HTMLDivElement | null }> = [
                { tab: 'translation', container: translationPaneRef.current },
                { tab: 'source', container: sourcePaneRef.current },
                { tab: 'translation', container: compareTranslationPaneRef.current },
                { tab: 'source', container: compareSourcePaneRef.current },
            ];

            return panes.find((pane) => Boolean(target && pane.container?.contains(target))) || null;
        };

        const commitSelectionSnapshot = () => {
            if (!fileHash) {
                setSelection(null);
                return;
            }

            const selectionInstance = window.getSelection();
            if (!selectionInstance || selectionInstance.rangeCount === 0 || selectionInstance.isCollapsed) {
                setSelection(null);
                return;
            }

            const range = selectionInstance.getRangeAt(0);
            const pane = resolveActiveSelectionPane(range.commonAncestorContainer);
            if (!pane) {
                setSelection(null);
                return;
            }

            const selectionDocumentId = getDocumentId(fileHash, targetLang, pane.tab);
            const bodies = getMarkdownBodies(pane.container);
            const body = bodies.find((candidate) => candidate.contains(range.commonAncestorContainer));
            if (!body) {
                setSelection(null);
                return;
            }

            const nextSelection = resolveSelectionSnapshot(body, pane.tab, selectionDocumentId);
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
            pointerSelectionActiveRef.current = Boolean(resolveActiveSelectionPane(target));
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
    }, [fileHash, targetLang, translationDecorationVersion]);

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
    const activeAssistContext = currentAssistSelection || assistTarget;
    const canSaveNote = Boolean(fileHash && activeNoteTarget && noteDraft.trim());
    const canSubmitAssistQuestion = Boolean(fileHash && assistQuestion.trim() && !assistLoading);
    const activeAssistContextLabel = activeAssistContext ? buildAssistContextLabel(activeAssistContext) : null;
    const activeAssistContextSourceLabel = activeAssistContextLabel ? `来自 ${activeAssistContextLabel}` : '来自全文';
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

        const contextTarget = targetOverride || currentAssistSelection || assistTarget;
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
        const currentActiveMarkdown = activeDocumentTab === 'translation'
            ? (currentTranslationState.targetMarkdown.trim()
                ? currentTranslationState.targetMarkdown
                : buildMarkdownFromTranslationBlocks(currentTranslationState.translationBlocks))
            : currentTranslationState.sourceMarkdown;
        const selectionText = contextTarget?.text || currentActiveMarkdown.slice(0, 2400);
        const contextText = contextTarget?.contextText || currentActiveMarkdown;
        const promptLabel = buildAssistPromptLabel(action, assistQuestion);
        const contextLabel = contextTarget ? buildAssistContextLabel(contextTarget) : undefined;

        if (!selectionText.trim()) return;

        setAssistLoading(true);
        setAssistError(null);
        setAssistSessionId(sessionIdForRequest);
        setSidePanelOpen(true);
        setPendingAssistExchange({
            sessionId: sessionIdForRequest,
            prompt: promptLabel,
            selectionText: contextTarget?.text || undefined,
            contextLabel,
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
                throw new Error(data.error || '回答生成失败');
            }

            await saveConversation({
                id: crypto.randomUUID(),
                fileHash,
                sessionId: sessionIdForRequest,
                targetLang: contextTarget?.tab === 'translation' ? targetLang : undefined,
                scope: contextTarget ? 'selection' : 'document',
                prompt: promptLabel,
                selectionText: contextTarget?.text || undefined,
                contextLabel,
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
            const message = assistRequestError instanceof Error ? assistRequestError.message : '回答生成失败';
            setAssistError(getUserFacingErrorMessage(message));
        } finally {
            setAssistLoading(false);
            setPendingAssistExchange(null);
        }
    };

    const submitAssistQuestion = () => {
        if (!canSubmitAssistQuestion) return;
        void runAssist('qa');
    };

    const canRunPaperPolish =
        Boolean(effectiveSourceMarkdown.trim()) &&
        !isRecoverableParseTask &&
        status !== 'uploading' &&
        status !== 'parsing' &&
        status !== 'translating';
    const paperPolishProcessing = paperPolishStatus === 'processing';
    const handleRunPaperPolish = () => {
        if (!canRunPaperPolish) return;
        setFormatMenuOpen(false);
        void runPaperPolish('light');
    };

    const handleRunPaperPolishAiFallback = () => {
        if (!paperPolishCanUseAiFallback || paperPolishProcessing) return;
        setFormatMenuOpen(false);
        void runPaperPolishAiFallback();
    };

    const handleUndoPaperPolish = () => {
        if (!paperPolishUndoVisible) return;
        setFormatMenuOpen(false);
        void undoPaperPolish();
    };

    const openTranslationEditMode = () => {
        setTranslationEditDraft(editableTranslationMarkdown);
        setTranslationEditMode(true);
        startTransition(() => setManualView('translation'));
    };

    const closeTranslationEditMode = () => {
        setTranslationEditMode(false);
    };

    const saveTranslationEditDraft = () => {
        saveEditedTranslation(translationEditDraft);
        setTranslationEditMode(false);
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
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white/80 p-8 text-slate-500">
                {status === 'parsing' ? (
                    <div className="flex flex-col items-center gap-3">
                        <Loader2 className="animate-spin text-slate-900" size={32} />
                        <p>正在整理阅读稿...</p>
                        <span className="text-xs text-slate-400">{Math.round(progress)}%</span>
                    </div>
                ) : (
                    <p>导入 PDF 后，这里会显示阅读内容和笔记。</p>
                )}
            </div>
        );
    }

    return (
        <div className="relative flex h-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
            <style>{sharedStyles}</style>

            {selection && (
                <div
                    onMouseDown={(event) => event.preventDefault()}
                    className="pointer-events-auto fixed z-40 -translate-x-1/2 rounded-lg border border-slate-200 bg-white/95 px-2 py-2 shadow-lg backdrop-blur"
                    style={{ top: selection.top, left: selection.left }}
                >
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => void runAssist('explain', selection)}
                            className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                        >
                            解释
                        </button>
                        <button
                            type="button"
                            onClick={() => void runAssist('rewrite', selection)}
                            className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                        >
                            改写
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setNoteTarget(selection);
                                setSidePanelOpen(true);
                                startTransition(() => setSidePanelTab('notes'));
                            }}
                            className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                        >
                            记笔记
                        </button>
                    </div>
                </div>
            )}

            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 px-4 py-3">
                <div className="grid w-[300px] grid-cols-3 rounded-lg bg-slate-200/70 p-1">
                    <button
                        type="button"
                        onClick={() => startTransition(() => setManualView('translation'))}
                        className={`rounded-md px-3 py-1.5 text-sm transition ${activeView === 'translation' ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
                    >
                        译文
                    </button>
                    <button
                        type="button"
                        onClick={() => startTransition(() => setManualView('compare'))}
                        className={`rounded-md px-3 py-1.5 text-sm transition ${activeView === 'compare' ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
                    >
                        对照
                    </button>
                    <button
                        type="button"
                        onClick={() => startTransition(() => setManualView('source'))}
                        className={`rounded-md px-3 py-1.5 text-sm transition ${activeView === 'source' ? 'bg-white font-medium text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
                    >
                        原文
                    </button>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-slate-500">
                    {hasTranslationContent ? (
                        <button
                            type="button"
                            onClick={openTranslationEditMode}
                            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${translationEditMode
                                ? 'border-slate-900 bg-slate-900 text-white'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-slate-900'
                                }`}
                        >
                            编辑译文
                        </button>
                    ) : null}
                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => setFormatMenuOpen((open) => !open)}
                            className={`inline-flex h-9 min-w-9 items-center justify-center gap-2 rounded-lg border px-2.5 text-sm font-medium transition ${paperPolishProcessing
                                ? 'border-sky-200 bg-sky-50 text-sky-700'
                                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-slate-900'
                                }`}
                            aria-expanded={formatMenuOpen}
                            aria-label="整理阅读稿"
                            title={paperPolishProcessing ? `正在整理阅读稿 ${Math.round(paperPolishProgress)}%` : '整理阅读稿'}
                        >
                            {paperPolishProcessing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                            {paperPolishProcessing ? (
                                <span className="text-xs">{Math.round(paperPolishProgress)}%</span>
                            ) : (
                                <span className="sr-only">整理阅读稿</span>
                            )}
                            {paperPolishCanUseAiFallback && !paperPolishProcessing ? (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                                    {paperPolishResidualCount}
                                </span>
                            ) : null}
                        </button>

                        {formatMenuOpen ? (
                            <div className="absolute right-0 top-full z-30 mt-2 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white p-2 text-sm shadow-lg">
                                <label className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-slate-700 transition hover:bg-slate-50">
                                    <span className="inline-flex items-center gap-2">
                                        <span className={`inline-flex h-2.5 w-2.5 rounded-full ${paperPolishAutoEnabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                                        自动整理阅读稿
                                    </span>
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
                                    className="paper-polish-wand flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-slate-700 transition hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:text-slate-300"
                                >
                                    <span className="inline-flex items-center gap-2">
                                        <Wand2 size={14} />
                                        清理格式
                                    </span>
                                    <span className="text-xs text-slate-400">本地</span>
                                </button>

                                {paperPolishCanUseAiFallback && !paperPolishProcessing ? (
                                    <button
                                        type="button"
                                        onClick={handleRunPaperPolishAiFallback}
                                        className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-amber-700 transition hover:bg-amber-50"
                                    >
                                        <span className="inline-flex items-center gap-2">
                                            <Sparkles size={14} />
                                            深度修复
                                        </span>
                                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                                            {paperPolishResidualCount}
                                        </span>
                                    </button>
                                ) : null}

                                {paperPolishProcessing ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setFormatMenuOpen(false);
                                            cancelPaperPolish();
                                        }}
                                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-rose-600 transition hover:bg-rose-50"
                                    >
                                        <X size={14} />
                                        取消整理
                                    </button>
                                ) : null}

                                {paperPolishUndoVisible ? (
                                    <button
                                        type="button"
                                        onClick={handleUndoPaperPolish}
                                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-emerald-700 transition hover:bg-emerald-50"
                                    >
                                        <RotateCcw size={14} />
                                        撤销整理
                                    </button>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

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
                            <span>{error ? '生成译文遇到问题' : translationHeaderLabel}</span>
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
                    {status === 'error' && (
                        <span className="font-medium text-red-600">
                            {isRecoverableParseTask ? '整理遇到问题' : '生成译文遇到问题'}
                        </span>
                    )}
                </div>
            </div>

            {(paperPolishProcessing || (paperPolishStatus === 'completed' && paperPolishMessage) || (paperPolishStatus === 'error' && error)) ? (
                <div className="border-b border-slate-200 bg-white/80 px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                            {paperPolishProcessing ? <Loader2 size={14} className="animate-spin text-sky-600" /> : <Sparkles size={14} className="text-sky-600" />}
                            <span>{paperPolishMessage || '阅读稿已整理'}</span>
                        </div>
                        {paperPolishProcessing ? (
                            <div className="flex min-w-[220px] flex-1 items-center gap-3">
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                                    <div
                                        className="h-full rounded-full bg-slate-900 transition-all duration-500"
                                        style={{ width: `${Math.min(100, Math.max(paperPolishProgress, 0))}%` }}
                                    />
                                </div>
                                <span className="text-xs font-semibold text-sky-700">{Math.round(paperPolishProgress)}%</span>
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            <div className={`grid min-h-0 flex-1 grid-cols-1 overflow-hidden ${sidePanelOpen ? 'lg:grid-cols-[minmax(0,1fr)_360px]' : 'lg:grid-cols-1'}`}>
                <div className="relative min-h-0 overflow-hidden">
                    <div
                        ref={translationPaneRef}
                        onClick={handleSemanticBlockClick}
                        className={`workspace-scroll absolute inset-0 overflow-auto p-6 ${vlookLoaded ? 'vlook-doc' : 'prose prose-slate max-w-none'} ${activeView === 'translation' ? 'visible' : 'invisible'}`}
                    >
                        {translationEditMode ? (
                            <div className="not-prose flex h-full min-h-[520px] flex-col rounded-lg border border-slate-200 bg-white">
                                <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                                    <div>
                                        <div className="text-sm font-semibold text-slate-900">编辑当前译文</div>
                                        <div className="mt-0.5 text-xs text-slate-500">保存后，阅读区和导出当前视图会使用这版译文。</div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={saveTranslationEditDraft}
                                            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
                                        >
                                            保存编辑
                                        </button>
                                        <button
                                            type="button"
                                            onClick={closeTranslationEditMode}
                                            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
                                        >
                                            退出编辑
                                        </button>
                                    </div>
                                </div>
                                <textarea
                                    value={translationEditDraft}
                                    onChange={(event) => setTranslationEditDraft(event.target.value)}
                                    aria-label="编辑当前译文"
                                    className="min-h-0 flex-1 resize-none bg-white px-4 py-4 text-sm leading-7 text-slate-800 outline-none"
                                />
                            </div>
                        ) : (
                            <StreamingTranslationPane
                                viewportRef={translationPaneRef}
                                onFramesChange={handleTranslationFramesChange}
                            />
                        )}
                    </div>

                    <div
                        ref={sourcePaneRef}
                        onClick={handleSemanticBlockClick}
                        className={`workspace-scroll absolute inset-0 overflow-auto p-6 ${vlookLoaded ? 'vlook-doc' : 'prose prose-slate max-w-none'} ${activeView === 'source' ? 'visible' : 'invisible'}`}
                    >
                        <div className={sourcePanePolishClass}>
                            {sourceProjection ? (
                                <StructuredSourceView
                                    projection={sourceProjection}
                                    highlightedBlockId={highlightedBlockId}
                                />
                            ) : (
                                <MarkdownView value={displayedSourceMarkdown || renderedSourceMarkdown || '_暂无原文内容_'} />
                            )}
                        </div>
                    </div>

                    <div
                        ref={comparePaneRef}
                        className={`absolute inset-0 min-h-0 bg-white ${activeView === 'compare' ? 'visible' : 'invisible'}`}
                    >
                        <div className="grid h-full min-h-0 grid-cols-1 divide-y divide-slate-200 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
                            <section className="flex min-h-0 flex-col overflow-hidden">
                                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-2 text-xs font-semibold text-slate-500">
                                    <span>译文</span>
                                    {hasTranslationContent ? (
                                        <button
                                            type="button"
                                            onClick={openTranslationEditMode}
                                            className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                        >
                                            编辑译文
                                        </button>
                                    ) : null}
                                </div>
                                <div
                                    ref={compareTranslationPaneRef}
                                    onClick={handleSemanticBlockClick}
                                    className={`workspace-scroll min-h-0 flex-1 overflow-auto p-5 ${vlookLoaded ? 'vlook-doc' : 'prose prose-slate max-w-none'}`}
                                >
                                    <StreamingTranslationPane viewportRef={compareTranslationPaneRef} />
                                </div>
                            </section>

                            <section className="flex min-h-0 flex-col overflow-hidden">
                                <div className="shrink-0 border-b border-slate-200 bg-slate-50/80 px-4 py-2 text-xs font-semibold text-slate-500">
                                    原文
                                </div>
                                <div
                                    ref={compareSourcePaneRef}
                                    onClick={handleSemanticBlockClick}
                                    className={`workspace-scroll min-h-0 flex-1 overflow-auto p-5 ${vlookLoaded ? 'vlook-doc' : 'prose prose-slate max-w-none'}`}
                                >
                                    <div className={sourcePanePolishClass}>
                                        {sourceProjection ? (
                                            <StructuredSourceView
                                                projection={sourceProjection}
                                                highlightedBlockId={highlightedBlockId}
                                            />
                                        ) : (
                                            <MarkdownView value={displayedSourceMarkdown || renderedSourceMarkdown || '_暂无原文内容_'} />
                                        )}
                                    </div>
                                </div>
                            </section>
                        </div>
                    </div>
                </div>

                {sidePanelOpen ? (
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
                            提问
                        </button>
                        <button
                            type="button"
                            onClick={() => setSidePanelOpen(false)}
                            className="ml-auto rounded-full border border-slate-200 bg-white p-2 text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
                            aria-label="关闭笔记和提问面板"
                        >
                            <X size={14} />
                        </button>
                    </div>
                    {sidePanelTab === 'notes' ? (
                        <div className="flex min-h-0 flex-1 flex-col">
                            <div className="shrink-0 border-b border-slate-200 bg-white/90 px-4 py-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium text-slate-900">阅读笔记</div>
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
                                            className="w-full rounded-lg border border-slate-200 py-3 pl-9 pr-3 text-sm outline-none transition focus:border-slate-400"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        onClick={onExportNotes}
                                        className="shrink-0 rounded-lg border border-slate-200 px-3 py-3 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                    >
                                        导出笔记
                                    </button>
                                </div>
                            </div>

                            <div className="workspace-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
                                <div className="space-y-4">
                                    {activeNoteTarget ? (
                                    <section className="rounded-lg border border-slate-200 bg-white p-4">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="text-sm font-medium text-slate-900">新建笔记</div>
                                            </div>
                                            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                                                已捕获选区
                                            </span>
                                        </div>

                                        <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/70 px-3 py-3 text-sm leading-6 text-slate-600">
                                            <CollapsibleText
                                                text={activeNoteTarget.text}
                                                expanded={noteTargetExpanded}
                                                onToggle={() => setNoteTargetExpanded((current) => !current)}
                                                maxChars={COLLAPSE_LIMITS.panelPreview}
                                                className="whitespace-pre-wrap"
                                            />
                                        </div>

                                        <textarea
                                            value={noteDraft}
                                            onChange={(event) => setNoteDraft(event.target.value)}
                                            rows={4}
                                            placeholder="记录你的理解、疑问或待办"
                                            className="mt-3 w-full rounded-lg border border-slate-200 px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                                        />
                                        <input
                                            type="text"
                                            value={noteTags}
                                            onChange={(event) => setNoteTags(event.target.value)}
                                            placeholder="标签，用逗号分隔，如 证明、待办"
                                            className="mt-3 w-full rounded-lg border border-slate-200 px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                                        />
                                        <div className="mt-3 flex gap-2">
                                            <button
                                                type="button"
                                                onClick={() => void saveCurrentNote()}
                                                disabled={!canSaveNote}
                                                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
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
                                                className="rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                            >
                                                清空
                                            </button>
                                        </div>
                                    </section>
                                    ) : null}

                                    {sortedAnnotations.length > 0 ? (
                                        <div className="space-y-3">
                                            {sortedAnnotations.map((annotation) => {
                                                const expanded = Boolean(expandedAnnotationIds[annotation.id]);
                                                const quoteExpandable = isTextCollapsible(annotation.selectedText, COLLAPSE_LIMITS.annotationQuote);
                                                const noteExpandable = isTextCollapsible(annotation.note, COLLAPSE_LIMITS.annotationNote);

                                                return (
                                                    <article key={annotation.id} className="rounded-lg border border-slate-200 bg-white p-4">
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="min-w-0 flex-1">
                                                                <div className="text-xs uppercase tracking-[0.14em] text-slate-400">
                                                                    {annotation.targetLang ? '译文' : '原文'} · {new Date(annotation.createdAt).toLocaleString()}
                                                                </div>
                                                                <div className="mt-2 rounded-lg bg-slate-50 px-3 py-3">
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
                                                                aria-label="删除笔记"
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
                                                                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                                            >
                                                                回到位置
                                                            </button>
                                                        </div>
                                                    </article>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
                                            <div className="font-medium text-slate-700">还没有笔记</div>
                                            <p className="mt-2 leading-6">
                                                在正文中选中内容后，可以直接保存阅读笔记。
                                            </p>
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
                                    <button
                                        type="button"
                                        onClick={() => setAssistAdvancedOpen((open) => !open)}
                                        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-slate-600 transition ${assistAdvancedOpen
                                            ? 'border-slate-900 bg-slate-900 text-white'
                                            : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900'
                                            }`}
                                        aria-expanded={assistAdvancedOpen}
                                        aria-label="回答设置"
                                        title="回答设置"
                                    >
                                        <Settings2 size={14} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setAssistSessionId('draft-session');
                                            setAssistQuestion('');
                                            setAssistError(null);
                                            setPendingAssistExchange(null);
                                        }}
                                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                        aria-label="新建对话"
                                        title="新建对话"
                                    >
                                        <Plus size={14} />
                                    </button>
                                </div>
                                {assistAdvancedOpen ? (
                                    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                                        <div className="mb-1 text-[11px] font-medium text-slate-500">回答服务</div>
                                        <ModelSelector mode="assist" compact />
                                    </div>
                                ) : null}
                            </div>

                            <div ref={conversationListRef} className="workspace-scroll min-h-0 flex-1 overflow-y-auto bg-slate-50/50 px-3 py-3">
                                {sortedConversations.length > 0 || pendingExchangeVisible ? (
                                    <div className="space-y-4">
                                        {sortedConversations.map((conversation) => {
                                            const expanded = Boolean(expandedConversationIds[conversation.id]);
                                            const responseExpandable = isTextCollapsible(conversation.response, COLLAPSE_LIMITS.conversationResponse);
                                            const contextTab = conversation.contextTab || (conversation.contextAnchor
                                                ? (conversation.targetLang ? 'translation' : 'source')
                                                : undefined);
                                            const contextLabel = buildConversationContextLabel(conversation.contextLabel, contextTab, conversation.contextAnchor);

                                            return (
                                                <div key={conversation.id} className="space-y-2">
                                                    <div className="ml-auto max-w-[88%] rounded-lg bg-slate-900 px-4 py-3 text-white">
                                                        <div className="flex items-center justify-end gap-2 text-[11px] text-slate-300">
                                                            <span className="shrink-0">
                                                                {new Date(conversation.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                            </span>
                                                        </div>
                                                        <div className="mt-1 whitespace-pre-wrap text-sm leading-6">{conversation.prompt}</div>
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
                                                                    来自 {contextLabel}
                                                                </button>
                                                            </div>
                                                        ) : null}
                                                    </div>

                                                    <div className="max-w-[92%] rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                                                        <div className="flex items-center justify-between gap-2">
                                                            <div className="text-[11px] uppercase tracking-[0.14em] text-slate-400">
                                                                回答
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={() => void deleteConversationRecord(conversation.id).then(async () => {
                                                                    emitSyncEvent({ type: 'conversation-updated', fileHash: fileHash || undefined });
                                                                    await loadWorkspaceData();
                                                                })}
                                                                className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                                                                aria-label="删除对话"
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
                                                <div className="ml-auto max-w-[88%] rounded-lg bg-slate-900 px-4 py-3 text-white">
                                                    <div className="flex items-center justify-end gap-2 text-[11px] text-slate-300">
                                                        <span className="shrink-0">
                                                            {new Date(pendingAssistExchange.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </span>
                                                    </div>
                                                    <div className="mt-1 whitespace-pre-wrap text-sm leading-6">{pendingAssistExchange.prompt}</div>
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
                                                                来自 {pendingAssistExchange.contextLabel}
                                                            </button>
                                                        </div>
                                                    ) : null}
                                                </div>
                                                <div className="max-w-[92%] rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                                                    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-slate-400">
                                                        <Loader2 size={13} className="animate-spin" />
                                                        回答正在生成
                                                    </div>
                                                    <div className="mt-2 text-sm leading-6 text-slate-500">
                                                        正在根据当前上下文生成回答...
                                                    </div>
                                                </div>
                                            </div>
                                        ) : null}
                                    </div>
                                ) : (
                                    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-4 py-10 text-center text-sm text-slate-500">
                                        <div className="font-medium text-slate-700">当前会话还没有消息</div>
                                        <p className="mt-2 leading-6">
                                            先在正文中选中一段文字，或者直接输入问题开始对话。
                                        </p>
                                    </div>
                                )}
                            </div>

                            <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-2">
                                <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                                    <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                                        <span className="shrink-0 font-medium text-slate-700">当前上下文</span>
                                        <span className="truncate">
                                            {activeAssistContextSourceLabel}
                                        </span>
                                    </div>
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
                                            </button>
                                        ) : (
                                            <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                                                全文模式
                                            </span>
                                        )}
                                        {activeAssistContext ? (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setAssistTarget(null);
                                                    setSelectionMemory(null);
                                                    clearEditorSelection();
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
                                            onClick={() => void runAssist('rewrite')}
                                            className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                        >
                                            改写
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setAssistSuggestionsOpen((open) => !open)}
                                            aria-expanded={assistSuggestionsOpen}
                                            className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                        >
                                            建议
                                        </button>
                                    </div>
                                    {assistSuggestionsOpen ? (
                                        <div className="mt-2 flex flex-wrap gap-2 px-0.5">
                                            <button
                                                type="button"
                                                onClick={() => void runAssist('summarize')}
                                                className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                            >
                                                总结
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void runAssist('extract')}
                                                className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                                            >
                                                提取
                                            </button>
                                        </div>
                                    ) : null}

                                    <div className="mt-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
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
                                                className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {assistLoading ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
                                                发送
                                            </button>
                                        </div>
                                    </div>

                                    {assistError ? (
                                        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                                            {assistError}
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    )}
                </aside>
                ) : (
                    <div className="pointer-events-none absolute right-4 top-20 z-20 flex">
                        <button
                            type="button"
                            onClick={() => {
                                setSidePanelOpen(true);
                                startTransition(() => setSidePanelTab('notes'));
                            }}
                            className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 text-sm font-medium text-slate-700 shadow-sm backdrop-blur transition hover:border-slate-300 hover:text-slate-900"
                            aria-label="打开笔记和提问面板"
                        >
                            <NotebookPen size={15} />
                            笔记和提问
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

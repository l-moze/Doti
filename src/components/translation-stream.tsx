'use client';

import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { MarkdownView } from '@/components/markdown-view';
import { useDocumentLayoutProfile } from '@/hooks/use-document-layout-profile';
import { normalizeMarkdownMathForDisplay } from '@/lib/markdown-normalizer';
import { getPretextLayoutSnapshotFromPrepared } from '@/lib/pretext';
import {
    buildStreamingRenderBlocks,
    STREAM_DRAFT_BLOCK_GAP,
    STREAM_DRAFT_LINE_HEIGHT,
    type StreamingRenderBlock,
} from '@/lib/streaming-draft';
import type { TranslationMarkdownBlock } from '@/lib/translation-runtime';

type TranslationStreamProps = {
    blocks: TranslationMarkdownBlock[];
    viewportRef: RefObject<HTMLDivElement | null>;
    onFramesChange?: (frames: TranslationStreamFrame[]) => void;
};

type TranslationStreamBlockProps = {
    block: StreamingRenderBlock;
    top: number;
    onHeightChange: (blockId: string, height: number) => void;
    debug: boolean;
};

type ViewTransitionDocument = Document & {
    startViewTransition?: (update: () => void) => {
        finished: Promise<void>;
        ready?: Promise<void>;
        updateCallbackDone?: Promise<void>;
    };
};

type DraftVisual = {
    draftState: 'planned' | 'streaming';
    title: string;
    rawText: string;
    textWidth: number;
    paragraphs: StreamingRenderBlock['paragraphs'];
    estimatedHeight: number;
    totalLineCount: number;
    maxLineWidth: number;
};

export type TranslationStreamFrame = {
    blockId: string;
    index: number;
    top: number;
    bottom: number;
    height: number;
};

const MORPH_DURATION_MS = 360;

function isIgnorableViewTransitionError(error: unknown): boolean {
    if (error instanceof DOMException) {
        return error.name === 'AbortError' || error.name === 'InvalidStateError';
    }

    if (error instanceof Error) {
        return (
            error.name === 'AbortError' ||
            error.name === 'InvalidStateError' ||
            error.message.includes('Transition was skipped') ||
            error.message.includes('Transition was aborted')
        );
    }

    return false;
}

function sanitizeTransitionName(id: string): string {
    return `translation-block-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function renderDraftVisual(
    draft: DraftVisual,
    debug: boolean,
    isOverlay = false
) {
    const isStreaming = draft.draftState === 'streaming';
    const projectedParagraphs = draft.paragraphs.map((paragraph) => ({
        ...paragraph,
        lines: paragraph.prepared
            ? (getPretextLayoutSnapshotFromPrepared(
                paragraph.prepared,
                draft.textWidth,
                STREAM_DRAFT_LINE_HEIGHT
            )?.lines ?? [])
            : paragraph.lines,
    }));

    return (
        <div
            className={`not-prose rounded-3xl border px-5 py-4 shadow-sm transition-[min-height,background-color,border-color,box-shadow,opacity,transform,filter] duration-300 ease-out ${isOverlay ? 'h-full' : ''} ${isStreaming
                ? 'border-sky-100 bg-sky-50/80'
                : 'border-slate-200 bg-slate-50/90'
                }`}
            style={{ minHeight: draft.estimatedHeight }}
        >
            <div className={`flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] ${isStreaming ? 'text-sky-700' : 'text-slate-500'
                }`}>
                <Loader2 size={13} className="animate-spin" />
                <span>{draft.title}</span>
                {debug ? (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal ${isStreaming
                        ? 'bg-white/70 text-sky-700'
                        : 'bg-white text-slate-500'
                        }`}>
                        {draft.totalLineCount} 行 · {Math.round(draft.maxLineWidth)}px
                    </span>
                ) : null}
            </div>

            {draft.paragraphs.length > 0 ? (
                <div className="mt-3 space-y-3">
                    {projectedParagraphs.map((paragraph) => (
                        <div
                            key={paragraph.id}
                            className={paragraph.stage === 'stabilized-block' ? 'opacity-75' : ''}
                        >
                            {paragraph.lines.length > 0 ? (
                                paragraph.lines.map((line, index) => (
                                    <div
                                        key={`${paragraph.id}:line:${index}`}
                                        className={`overflow-hidden whitespace-pre ${isStreaming ? 'text-slate-700' : 'text-slate-500'}`}
                                        style={{
                                            lineHeight: `${STREAM_DRAFT_LINE_HEIGHT}px`,
                                            minHeight: `${STREAM_DRAFT_LINE_HEIGHT}px`,
                                        }}
                                    >
                                        {line.text || '\u00A0'}
                                    </div>
                                ))
                            ) : (
                                <div className={`whitespace-pre-wrap break-words text-[15px] leading-7 ${isStreaming ? 'text-slate-700' : 'text-slate-500'
                                    }`}>
                                    {paragraph.text || '正在生成这一段内容...'}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            ) : (
                <div className={`mt-3 text-sm leading-6 ${isStreaming ? 'text-slate-700' : 'text-slate-500'}`}>
                    {isStreaming ? '正在生成这一段内容...' : '正在拆分队列或等待模型返回这一段内容...'}
                </div>
            )}
        </div>
    );
}

function TranslationStreamBlock({
    block,
    top,
    onHeightChange,
    debug,
}: TranslationStreamBlockProps) {
    const blockRef = useRef<HTMLElement | null>(null);
    const [isFinalized, setIsFinalized] = useState(() => block.stage === 'final-rich');
    const [overlayDraft, setOverlayDraft] = useState<DraftVisual | null>(null);
    const [overlayLeaving, setOverlayLeaving] = useState(false);
    const overlayTimerRef = useRef<number | null>(null);
    const rafRef = useRef<number | null>(null);
    const lastDraftRef = useRef<DraftVisual | null>(null);
    const viewTransitionInFlightRef = useRef(false);
    const normalizedMarkdown = useMemo(
        () => normalizeMarkdownMathForDisplay(block.rawText),
        [block.rawText]
    );
    const transitionName = useMemo(() => sanitizeTransitionName(block.id), [block.id]);

    const activeDraft = useMemo<DraftVisual>(() => ({
        draftState: block.draftState,
        title: block.title,
        rawText: block.rawText,
        textWidth: block.textWidth,
        paragraphs: block.paragraphs,
        estimatedHeight: block.estimatedHeight,
        totalLineCount: block.totalLineCount,
        maxLineWidth: block.maxLineWidth,
    }), [
        block.draftState,
        block.estimatedHeight,
        block.maxLineWidth,
        block.paragraphs,
        block.rawText,
        block.textWidth,
        block.title,
        block.totalLineCount,
    ]);

    useEffect(() => {
        return () => {
            if (overlayTimerRef.current !== null) window.clearTimeout(overlayTimerRef.current);
            if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
        };
    }, []);

    useEffect(() => {
        const element = blockRef.current;
        if (!element) return;

        const observer = new ResizeObserver((entries) => {
            const nextHeight = Math.ceil(entries[0]?.contentRect.height || 0);
            if (nextHeight > 0) {
                onHeightChange(block.id, nextHeight);
            }
        });

        observer.observe(element);
        return () => observer.disconnect();
    }, [block.id, onHeightChange]);

    useEffect(() => {
        if (block.stage !== 'final-rich') {
            lastDraftRef.current = activeDraft;
            return;
        }

        if (isFinalized) return;

        const previousDraft = lastDraftRef.current;

        if (overlayTimerRef.current !== null) window.clearTimeout(overlayTimerRef.current);
        if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);

        const finalizeWithOverlayFallback = () => {
            if (previousDraft?.rawText.trim()) {
                setOverlayDraft(previousDraft);
                setOverlayLeaving(false);
            }

            setIsFinalized(true);

            if (previousDraft?.rawText.trim()) {
                rafRef.current = window.requestAnimationFrame(() => {
                    setOverlayLeaving(true);
                });

                overlayTimerRef.current = window.setTimeout(() => {
                    setOverlayDraft(null);
                    setOverlayLeaving(false);
                }, MORPH_DURATION_MS);
            }
        };

        const doc = document as ViewTransitionDocument;
        const canUseNativeTransition = (
            typeof doc.startViewTransition === 'function'
            && document.visibilityState === 'visible'
            && !viewTransitionInFlightRef.current
        );

        if (!canUseNativeTransition) {
            finalizeWithOverlayFallback();
            return;
        }

        try {
            viewTransitionInFlightRef.current = true;
            const transition = doc.startViewTransition(() => {
                flushSync(() => {
                    setIsFinalized(true);
                    setOverlayDraft(null);
                    setOverlayLeaving(false);
                });
            });

            void transition.ready?.catch((error) => {
                if (!isIgnorableViewTransitionError(error)) {
                    console.warn('[TranslationStream] View Transition ready() failed:', error);
                }
            });

            void transition.updateCallbackDone?.catch((error) => {
                if (!isIgnorableViewTransitionError(error)) {
                    console.warn('[TranslationStream] View Transition updateCallbackDone() failed:', error);
                }
            });

            void transition.finished
                .catch((error) => {
                    if (!isIgnorableViewTransitionError(error)) {
                        console.warn('[TranslationStream] View Transition finished() failed:', error);
                    }
                })
                .finally(() => {
                    viewTransitionInFlightRef.current = false;
                });
            return;
        } catch (error) {
            viewTransitionInFlightRef.current = false;
            if (!isIgnorableViewTransitionError(error)) {
                console.warn('[TranslationStream] Failed to start View Transition:', error);
            }
            finalizeWithOverlayFallback();
        }
    }, [activeDraft, block.stage, isFinalized]);

    const sectionStyle = useMemo(() => ({
        position: 'absolute',
        top,
        left: 0,
        right: 0,
        viewTransitionName: transitionName,
    } satisfies CSSProperties), [top, transitionName]);

    if (isFinalized || block.stage === 'final-rich') {
        return (
            <section
                ref={blockRef}
                data-translation-block-id={block.id}
                className="translation-block relative isolate overflow-hidden transition-[transform,opacity] duration-300 ease-out"
                style={sectionStyle}
            >
                <div className="transition-[opacity,transform,filter] duration-300 ease-out">
                    <MarkdownView value={normalizedMarkdown} />
                </div>
                {overlayDraft ? (
                    <div
                        className={`pointer-events-none absolute inset-0 z-10 transition-[opacity,transform,filter] duration-300 ease-out ${overlayLeaving
                            ? 'translate-y-1 scale-[0.995] opacity-0 blur-[1px]'
                            : 'translate-y-0 scale-100 opacity-100 blur-0'
                            }`}
                    >
                        {renderDraftVisual(overlayDraft, debug, true)}
                    </div>
                ) : null}
            </section>
        );
    }

    return (
        <section
            ref={blockRef}
            data-translation-block-id={block.id}
            className="translation-block relative isolate overflow-hidden transition-[transform,opacity] duration-300 ease-out"
            style={sectionStyle}
        >
            {renderDraftVisual(activeDraft, debug)}
        </section>
    );
}

const MemoizedTranslationStreamBlock = memo(TranslationStreamBlock);

function TranslationStreamComponent({ blocks, viewportRef, onFramesChange }: TranslationStreamProps) {
    const layoutProfile = useDocumentLayoutProfile(viewportRef);
    const [viewportTop, setViewportTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [measuredState, setMeasuredState] = useState<{
        profileVersion: number;
        heights: Record<string, number>;
    }>({
        profileVersion: 0,
        heights: {},
    });

    useEffect(() => {
        const element = viewportRef.current;
        if (!element || typeof window === 'undefined') return;

        const updateViewport = () => {
            setViewportTop(element.scrollTop);
            setViewportHeight(element.clientHeight);
        };

        const handleScroll = () => updateViewport();
        const observer = new ResizeObserver(() => updateViewport());

        updateViewport();
        element.addEventListener('scroll', handleScroll, { passive: true });
        observer.observe(element);

        return () => {
            element.removeEventListener('scroll', handleScroll);
            observer.disconnect();
        };
    }, [viewportRef]);

    const renderBlocks = useMemo(
        () => buildStreamingRenderBlocks(blocks, layoutProfile),
        [blocks, layoutProfile]
    );

    const frames = useMemo(() => {
        const measuredHeights = measuredState.profileVersion === layoutProfile.profileVersion
            ? measuredState.heights
            : {};
        const result: Array<{
            block: StreamingRenderBlock;
            top: number;
            height: number;
            bottom: number;
        }> = [];

        renderBlocks.reduce((currentTop, block, index) => {
            const measuredHeight = measuredHeights[block.id];
            const height = measuredHeight && measuredHeight > 0
                ? measuredHeight
                : block.estimatedHeight;
            const top = currentTop;
            const bottom = top + height;

            result.push({
                block,
                top,
                height,
                bottom,
            });

            return bottom + (index < renderBlocks.length - 1 ? STREAM_DRAFT_BLOCK_GAP : 0);
        }, 0);

        return result;
    }, [layoutProfile.profileVersion, measuredState.heights, measuredState.profileVersion, renderBlocks]);

    useEffect(() => {
        if (!onFramesChange) return;

        onFramesChange(frames.map((frame) => ({
            blockId: frame.block.id,
            index: frame.block.index,
            top: frame.top,
            bottom: frame.bottom,
            height: frame.height,
        })));
    }, [frames, onFramesChange]);

    useEffect(() => {
        if (!onFramesChange) return;
        return () => {
            onFramesChange([]);
        };
    }, [onFramesChange]);

    const totalHeight = useMemo(() => {
        const lastFrame = frames[frames.length - 1];
        return lastFrame ? lastFrame.bottom : 0;
    }, [frames]);

    const overscan = Math.max(viewportHeight, 480);
    const visibleFrames = useMemo(() => {
        const minY = Math.max(0, viewportTop - overscan);
        const maxY = viewportTop + viewportHeight + overscan;

        return frames.filter((frame) => frame.bottom >= minY && frame.top <= maxY);
    }, [frames, overscan, viewportHeight, viewportTop]);

    const handleHeightChange = useCallback((blockId: string, height: number) => {
        setMeasuredState((current) => {
            if (current.profileVersion !== layoutProfile.profileVersion) {
                return {
                    profileVersion: layoutProfile.profileVersion,
                    heights: { [blockId]: height },
                };
            }

            if (current.heights[blockId] === height) return current;
            return {
                profileVersion: current.profileVersion,
                heights: {
                    ...current.heights,
                    [blockId]: height,
                },
            };
        });
    }, [layoutProfile.profileVersion]);

    return (
        <div
            className="relative"
            style={{ minHeight: totalHeight || 0, height: totalHeight || undefined }}
        >
            {visibleFrames.map((frame) => (
                <MemoizedTranslationStreamBlock
                    key={frame.block.id}
                    block={frame.block}
                    top={frame.top}
                    onHeightChange={handleHeightChange}
                    debug={layoutProfile.debug}
                />
            ))}
        </div>
    );
}

export const TranslationStream = memo(TranslationStreamComponent);

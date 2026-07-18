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
import { Loader2 } from 'lucide-react';
import { MarkdownView } from '@/components/markdown-view';
import { useDocumentLayoutProfile } from '@/hooks/use-document-layout-profile';
import { normalizeMarkdownMathForDisplay } from '@/lib/markdown-normalizer';
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
    highlightedBlockId?: string | null;
};

type TranslationStreamBlockProps = {
    block: StreamingRenderBlock;
    top: number;
    onHeightChange: (blockId: string, height: number) => void;
    debug: boolean;
    highlightedBlockId?: string | null;
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

function sanitizeTransitionName(id: string): string {
    return `translation-block-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function renderDraftVisual(
    draft: DraftVisual,
    debug: boolean,
    isOverlay = false
) {
    const isStreaming = draft.draftState === 'streaming';

    return (
        <div
            className={`not-prose rounded-lg border px-5 py-4 duration-300 ease-out ${isOverlay ? 'h-full' : ''} ${isStreaming
                ? 'border-sky-100 bg-sky-50/80 transition-[background-color,border-color]'
                : 'border-slate-200 bg-slate-50/90 transition-[min-height,background-color,border-color,box-shadow,opacity,transform,filter]'
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
                    {draft.paragraphs.map((paragraph) => (
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
                    {isStreaming ? '正在生成这一段内容...' : '正在准备这一段译文...'}
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
    highlightedBlockId,
}: TranslationStreamBlockProps) {
    const blockRef = useRef<HTMLElement | null>(null);
    const [isFinalized, setIsFinalized] = useState(() => block.stage === 'final-rich');
    const [overlayDraft, setOverlayDraft] = useState<DraftVisual | null>(null);
    const [overlayLeaving, setOverlayLeaving] = useState(false);
    const overlayTimerRef = useRef<number | null>(null);
    const rafRef = useRef<number | null>(null);
    const lastDraftRef = useRef<DraftVisual | null>(null);

    // 惰性正规化：streaming 阶段 rawText 每 ~120ms 变化一次，此时 MarkdownView
    // 尚未挂载，提前执行 normalizeMarkdownMathForDisplay 是纯浪费。
    // 仅在 block 进入 final-rich 时执行一次并持久化到 ref，避免重复计算。
    const finalizedMarkdownRef = useRef<string | null>(
        block.stage === 'final-rich' ? normalizeMarkdownMathForDisplay(block.rawText) : null
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

        if (previousDraft?.rawText.trim()) {
            setOverlayDraft(previousDraft);
            setOverlayLeaving(false);
        }

        // 此处是 block 生命周期内唯一一次执行正规化的时机：文本已稳定，
        // MarkdownView 即将挂载。函数本身带 LRU 缓存，重复调用成本极低。
        finalizedMarkdownRef.current = normalizeMarkdownMathForDisplay(block.rawText);
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
    }, [activeDraft, block.rawText, block.stage, isFinalized]);

    const sectionStyle = useMemo(() => ({
        position: 'absolute',
        top,
        left: 0,
        right: 0,
        viewTransitionName: transitionName,
    } satisfies CSSProperties), [top, transitionName]);
    const isHighlighted = block.id === highlightedBlockId || Boolean(highlightedBlockId?.startsWith(`${block.id}-child-`));
    const blockClassName = `translation-block relative isolate overflow-hidden rounded-lg transition-[transform,opacity,background-color,box-shadow] duration-300 ease-out ${
        isHighlighted ? 'bg-sky-50/70 shadow-[0_0_0_3px_rgba(56,189,248,0.16)]' : ''
    }`.trim();

    if (isFinalized || block.stage === 'final-rich') {
        return (
            <section
                ref={blockRef}
                data-translation-block-id={block.id}
                data-semantic-block-id={block.id}
                data-semantic-active={isHighlighted ? 'true' : undefined}
                className={blockClassName}
                style={sectionStyle}
            >
                <div className="transition-[opacity,transform,filter] duration-300 ease-out">
                    {/* finalizedMarkdownRef 在 block 进入 final-rich 时写入，
                        内容稳定后才触发 MarkdownView 渲染，streaming 期间不执行正规化。 */}
                    <MarkdownView value={finalizedMarkdownRef.current ?? block.rawText} />
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
            data-semantic-block-id={block.id}
            data-semantic-active={isHighlighted ? 'true' : undefined}
            className={blockClassName}
            style={sectionStyle}
        >
            {renderDraftVisual(activeDraft, debug)}
        </section>
    );
}

const MemoizedTranslationStreamBlock = memo(TranslationStreamBlock);

function TranslationStreamComponent({ blocks, viewportRef, onFramesChange, highlightedBlockId }: TranslationStreamProps) {
    const layoutProfile = useDocumentLayoutProfile(viewportRef);

    // 合并 top 和 height 为单一 state，这样每次 scroll 只触发一次渲染而非两次。
    const [viewportState, setViewportState] = useState({ top: 0, height: 0 });
    const viewportTop = viewportState.top;
    const viewportHeight = viewportState.height;

    // RAF 节流 ref：记录 pending 的动画帧 ID，避免高速滚动时多帧重复排队。
    const pendingViewportRafRef = useRef<number | null>(null);

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

        const readAndCommit = () => {
            pendingViewportRafRef.current = null;
            const nextTop = element.scrollTop;
            const nextHeight = element.clientHeight;
            setViewportState((current) => {
                if (current.top === nextTop && current.height === nextHeight) return current;
                return { top: nextTop, height: nextHeight };
            });
        };

        // scroll 事件改为 rAF 节流：每个动画帧最多排队一次，避免高频 scroll 事件
        // 每次都触发 setState，与浏览器刷新率对齐。
        const handleScroll = () => {
            if (pendingViewportRafRef.current !== null) return;
            pendingViewportRafRef.current = window.requestAnimationFrame(readAndCommit);
        };

        const observer = new ResizeObserver(readAndCommit);

        readAndCommit();
        element.addEventListener('scroll', handleScroll, { passive: true });
        observer.observe(element);

        return () => {
            if (pendingViewportRafRef.current !== null) {
                window.cancelAnimationFrame(pendingViewportRafRef.current);
            }
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
                    highlightedBlockId={highlightedBlockId}
                />
            ))}
        </div>
    );
}

export const TranslationStream = memo(TranslationStreamComponent);

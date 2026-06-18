import type { PreparedTextWithSegments } from "@chenglou/pretext";
import {
    getPreparedPretextText,
    getPretextLayoutSnapshotFromPrepared,
    type PretextLayoutLineSnapshot,
    type PretextOptions,
} from "@/lib/pretext";
import type { TranslationMarkdownBlock } from "@/lib/translation-runtime";

export type DraftRenderStage = "draft-stream" | "stabilized-block" | "final-rich";

export type DocumentLayoutProfile = {
    outerWidth: number;
    contentWidth: number;
    contentPaddingX: number;
    draftFont: string;
    draftLineHeight: number;
    fontReady: boolean;
    profileVersion: number;
    debug: boolean;
};

export type StreamingParagraph = {
    id: string;
    text: string;
    isLive: boolean;
    stage: Exclude<DraftRenderStage, "final-rich">;
    prepared: PreparedTextWithSegments | null;
    lines: PretextLayoutLineSnapshot[];
    estimatedHeight: number;
    lineCount: number;
    maxLineWidth: number;
};

export type StreamingRenderBlock = {
    id: string;
    index: number;
    title: string;
    rawText: string;
    stage: DraftRenderStage;
    draftState: "planned" | "streaming";
    textWidth: number;
    paragraphs: StreamingParagraph[];
    estimatedHeight: number;
    totalLineCount: number;
    maxLineWidth: number;
};

export const STREAM_DRAFT_FONT =
    '400 15px Geist, "Noto Sans SC", "Microsoft YaHei", sans-serif';
export const STREAM_DRAFT_LINE_HEIGHT = 28;
export const STREAM_DRAFT_BLOCK_GAP = 24;
export const STREAM_DRAFT_BLOCK_MIN_HEIGHT = 96;
export const STREAM_DRAFT_BLOCK_HEADER_HEIGHT = 24;
export const STREAM_DRAFT_BLOCK_HORIZONTAL_PADDING = 40;
export const STREAM_DRAFT_BLOCK_VERTICAL_PADDING = 32;
export const STREAM_DRAFT_PARAGRAPH_GAP = 14;

const PRETEXT_OPTIONS: PretextOptions = {
    whiteSpace: "pre-wrap",
    wordBreak: "normal",
};
const streamingRenderBlockCache = new Map<string, {
    signature: string;
    block: StreamingRenderBlock;
}>();
const MAX_STREAMING_RENDER_BLOCK_CACHE_SIZE = 240;

// 模块级引用稳定化：若本次结果与上次所有元素引用相同，则返回上次数组，
// 避免 useMemo 因引用变化而触发下游 frames 的无谓重算。
let _lastStableRenderBlocks: StreamingRenderBlock[] = [];

// Paragraph-level cache: avoids recomputing layout for stabilized paragraphs
// within a live block whose block-level cache is always invalid (text grows each tick).
const streamingParagraphLayoutCache = new Map<string, StreamingParagraph>();
const MAX_PARAGRAPH_LAYOUT_CACHE_SIZE = 1200;

function computeTextHash(value: string): number {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}

function buildStreamingRenderBlockSignature(
    block: TranslationMarkdownBlock,
    layoutProfile: DocumentLayoutProfile
): string {
    return [
        layoutProfile.profileVersion,
        layoutProfile.fontReady ? 1 : 0,
        Math.round(layoutProfile.contentWidth),
        block.index,
        block.state,
        computeTextHash(block.title || ""),
        computeTextHash(block.text),
        block.text.length,
    ].join(":");
}

function rememberStreamingRenderBlock(
    blockId: string,
    signature: string,
    block: StreamingRenderBlock
): StreamingRenderBlock {
    streamingRenderBlockCache.set(blockId, { signature, block });

    if (streamingRenderBlockCache.size > MAX_STREAMING_RENDER_BLOCK_CACHE_SIZE) {
        const oldestKey = streamingRenderBlockCache.keys().next().value as string | undefined;
        if (oldestKey) {
            streamingRenderBlockCache.delete(oldestKey);
        }
    }

    return block;
}

function estimateFallbackLineCount(text: string): number {
    const physicalLineCount = text.split(/\r?\n/).length;
    const approximateWrappedLineCount = Math.ceil(text.length / 30);
    return Math.max(physicalLineCount, approximateWrappedLineCount, 1);
}

function estimateFallbackHeight(text: string, lineHeight: number): number {
    return estimateFallbackLineCount(text) * lineHeight;
}

function splitDraftParagraphs(text: string): string[] {
    if (!text.trim()) return [];

    const lines = text.replace(/\r/g, "").split("\n");
    const paragraphs: string[] = [];
    let current: string[] = [];
    let activeFence: "code" | "math" | null = null;
    let codeFenceMarker = "";
    let currentLength = 0;

    const flushCurrent = () => {
        const paragraph = current.join("\n");
        if (paragraph.trim()) {
            paragraphs.push(paragraph);
        }
        current = [];
        currentLength = 0;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        const codeFenceMatch = trimmed.match(/^(```+|~~~+)/);
        const isMathFence = trimmed === "$$";

        if (codeFenceMatch) {
            if (activeFence === "code" && codeFenceMarker === codeFenceMatch[1]) {
                current.push(line);
                flushCurrent();
                activeFence = null;
                codeFenceMarker = "";
                continue;
            }

            if (!activeFence) {
                flushCurrent();
                activeFence = "code";
                codeFenceMarker = codeFenceMatch[1];
            }

            current.push(line);
            currentLength += line.length;
            continue;
        }

        if (isMathFence) {
            if (activeFence === "math") {
                current.push(line);
                flushCurrent();
                activeFence = null;
                continue;
            }

            if (!activeFence) {
                flushCurrent();
                activeFence = "math";
            }

            current.push(line);
            currentLength += line.length;
            continue;
        }

        if (!activeFence && trimmed === "") {
            flushCurrent();
            continue;
        }

        current.push(line);
        currentLength += line.length;

        // Max String Length Sectioning: Prevent infinite accumulation of lines into a single paragraph
        if (!activeFence && currentLength > 1000) {
            flushCurrent();
        }
    }

    flushCurrent();
    return paragraphs;
}

function buildStreamingParagraph(
    blockId: string,
    paragraphIndex: number,
    text: string,
    isLive: boolean,
    layoutProfile: DocumentLayoutProfile
): StreamingParagraph {
    const maxWidth = Math.max(
        120,
        layoutProfile.contentWidth - STREAM_DRAFT_BLOCK_HORIZONTAL_PADDING
    );

    // Fallback: Skip expensive layout only if the font is not ready yet.
    if (!layoutProfile.fontReady) {
        const estimatedHeight = estimateFallbackHeight(text, layoutProfile.draftLineHeight);
        return {
            id: `${blockId}:paragraph:${paragraphIndex}`,
            text,
            isLive,
            stage: isLive ? "draft-stream" : "stabilized-block",
            prepared: null,
            lines: [],
            estimatedHeight,
            lineCount: Math.max(1, Math.ceil(estimatedHeight / layoutProfile.draftLineHeight)),
            maxLineWidth: maxWidth,
        };
    }

    // For stabilized paragraphs, check the paragraph-level cache before doing layout.
    const paragraphCacheKey = `${blockId}:${paragraphIndex}:${layoutProfile.profileVersion}:${Math.round(layoutProfile.contentWidth)}:${computeTextHash(text)}`;
    const cachedParagraph = streamingParagraphLayoutCache.get(paragraphCacheKey);
    if (cachedParagraph) {
        return cachedParagraph;
    }

    const prepared = getPreparedPretextText(text, layoutProfile.draftFont, PRETEXT_OPTIONS);
    const snapshot = prepared
        ? getPretextLayoutSnapshotFromPrepared(
            prepared,
            maxWidth,
            layoutProfile.draftLineHeight
        )
        : null;

    const paragraph: StreamingParagraph = {
        id: `${blockId}:paragraph:${paragraphIndex}`,
        text,
        isLive,
        stage: "stabilized-block",
        prepared,
        lines: snapshot?.lines ?? [],
        estimatedHeight:
            snapshot
                ? snapshot.estimatedHeight
                : estimateFallbackHeight(text, layoutProfile.draftLineHeight),
        lineCount:
            snapshot?.lineCount ??
            Math.max(1, Math.ceil(estimateFallbackHeight(text, layoutProfile.draftLineHeight) / layoutProfile.draftLineHeight)),
        maxLineWidth: snapshot?.maxLineWidth ?? maxWidth,
    };

    streamingParagraphLayoutCache.set(paragraphCacheKey, paragraph);
    if (streamingParagraphLayoutCache.size > MAX_PARAGRAPH_LAYOUT_CACHE_SIZE) {
        const oldestKey = streamingParagraphLayoutCache.keys().next().value as string | undefined;
        if (oldestKey) streamingParagraphLayoutCache.delete(oldestKey);
    }

    return paragraph;
}

export function buildStreamingRenderBlocks(
    blocks: TranslationMarkdownBlock[],
    layoutProfile: DocumentLayoutProfile
): StreamingRenderBlock[] {
    const results = [...blocks]
        .sort((a, b) => a.index - b.index)
        .map((block) => {
            const signature = buildStreamingRenderBlockSignature(block, layoutProfile);
            const cached = streamingRenderBlockCache.get(block.id);
            if (cached?.signature === signature) {
                return cached.block;
            }

            const textWidth = Math.max(
                120,
                layoutProfile.contentWidth - STREAM_DRAFT_BLOCK_HORIZONTAL_PADDING
            );
            const paragraphTexts = splitDraftParagraphs(block.text);
            const isFinal = block.state === "completed" || block.state === "cached";
            const liveParagraphIndex =
                !isFinal && paragraphTexts.length > 0 ? paragraphTexts.length - 1 : -1;

            const paragraphs = paragraphTexts.map((paragraphText, paragraphIndex) =>
                buildStreamingParagraph(
                    block.id,
                    paragraphIndex,
                    paragraphText,
                    paragraphIndex === liveParagraphIndex,
                    layoutProfile
                )
            );

            const bodyHeight = paragraphs.reduce((sum, paragraph, index) => {
                return (
                    sum +
                    paragraph.estimatedHeight +
                    (index < paragraphs.length - 1 ? STREAM_DRAFT_PARAGRAPH_GAP : 0)
                );
            }, 0);

            const totalLineCount = paragraphs.reduce(
                (sum, paragraph) => sum + paragraph.lineCount,
                0
            );
            const maxLineWidth = paragraphs.reduce(
                (maxWidth, paragraph) => Math.max(maxWidth, paragraph.maxLineWidth),
                0
            );

            return rememberStreamingRenderBlock(block.id, signature, {
                id: block.id,
                index: block.index,
                title: block.title || `Chunk ${block.index + 1}`,
                rawText: block.text,
                stage: isFinal
                    ? "final-rich"
                    : paragraphs.some((paragraph) => !paragraph.isLive)
                        ? "stabilized-block"
                        : "draft-stream",
                draftState: block.state === "planned" ? "planned" : "streaming",
                textWidth,
                paragraphs,
                estimatedHeight: Math.max(
                    STREAM_DRAFT_BLOCK_MIN_HEIGHT,
                    STREAM_DRAFT_BLOCK_VERTICAL_PADDING +
                        STREAM_DRAFT_BLOCK_HEADER_HEIGHT +
                        bodyHeight
                ),
                totalLineCount,
                maxLineWidth,
            } satisfies StreamingRenderBlock);
        });

    // 引用稳定化：若所有元素的对象引用与上次完全相同，返回上次数组。
    // 这使得 translation-stream.tsx 内依赖 renderBlocks 的 useMemo 可识别出
    // "内容没有实质变化"，跳过 frames 和 visibleFrames 的重算，减少无谓重渲染。
    if (
        results.length === _lastStableRenderBlocks.length &&
        results.every((block, i) => block === _lastStableRenderBlocks[i])
    ) {
        return _lastStableRenderBlocks;
    }

    _lastStableRenderBlocks = results;
    return results;
}

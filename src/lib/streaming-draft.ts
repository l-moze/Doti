import type { PreparedTextWithSegments } from "@chenglou/pretext";
import {
    getPreparedPretextText,
    getPretextStatsFromPrepared,
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

    const flushCurrent = () => {
        const paragraph = current.join("\n");
        if (paragraph.trim()) {
            paragraphs.push(paragraph);
        }
        current = [];
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
            continue;
        }

        if (!activeFence && trimmed === "") {
            flushCurrent();
            continue;
        }

        current.push(line);
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

    const prepared = getPreparedPretextText(text, layoutProfile.draftFont, PRETEXT_OPTIONS);
    const stats = prepared
        ? getPretextStatsFromPrepared(prepared, maxWidth)
        : null;

    return {
        id: `${blockId}:paragraph:${paragraphIndex}`,
        text,
        isLive,
        stage: isLive ? "draft-stream" : "stabilized-block",
        prepared,
        lines: [],
        estimatedHeight:
            stats
                ? Math.max(layoutProfile.draftLineHeight, Math.ceil(stats.lineCount * layoutProfile.draftLineHeight))
                : estimateFallbackHeight(text, layoutProfile.draftLineHeight),
        lineCount:
            stats?.lineCount ??
            Math.max(1, Math.ceil(estimateFallbackHeight(text, layoutProfile.draftLineHeight) / layoutProfile.draftLineHeight)),
        maxLineWidth: stats?.maxLineWidth ?? maxWidth,
    };
}

export function buildStreamingRenderBlocks(
    blocks: TranslationMarkdownBlock[],
    layoutProfile: DocumentLayoutProfile
): StreamingRenderBlock[] {
    const textWidth = Math.max(
        120,
        layoutProfile.contentWidth - STREAM_DRAFT_BLOCK_HORIZONTAL_PADDING
    );

    return [...blocks]
        .sort((a, b) => a.index - b.index)
        .map((block) => {
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

            return {
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
            } satisfies StreamingRenderBlock;
        });
}

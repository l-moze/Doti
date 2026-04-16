import {
    layoutNextLineRange,
    layoutWithLines,
    materializeLineRange,
    measureLineStats,
    prepareWithSegments,
    type PreparedTextWithSegments,
} from "@chenglou/pretext";

export type PretextOptions = {
    whiteSpace?: "normal" | "pre-wrap";
    wordBreak?: "normal" | "keep-all";
};

export type PretextStats = {
    lineCount: number;
    maxLineWidth: number;
};

export type PretextLayoutLineSnapshot = {
    text: string;
    width: number;
};

export type PretextBlockMetrics = PretextStats & {
    estimatedHeight: number;
};

export type PretextLayoutSnapshot = PretextBlockMetrics & {
    height: number;
    lines: PretextLayoutLineSnapshot[];
};

export type PretextMeasureRequestItem = {
    id: string;
    text: string;
    maxWidth: number;
    font: string;
    lineHeight: number;
    options?: PretextOptions;
};

export type PretextMeasureResponseItem = {
    id: string;
    snapshot: PretextLayoutSnapshot | null;
};

const preparedCache = new Map<string, PreparedTextWithSegments>();
const MAX_CACHE_SIZE = 30;

function buildCacheKey(text: string, font: string, options: PretextOptions): string {
    const whiteSpace = options.whiteSpace ?? "normal";
    const wordBreak = options.wordBreak ?? "normal";
    return `${font}::${whiteSpace}::${wordBreak}::${text}`;
}

function getOrPrepare(text: string, font: string, options: PretextOptions): PreparedTextWithSegments {
    const cacheKey = buildCacheKey(text, font, options);
    const cached = preparedCache.get(cacheKey);
    if (cached) return cached;

    const prepared = prepareWithSegments(text, font, options);
    preparedCache.set(cacheKey, prepared);

    // Keep a small FIFO cache to avoid unbounded memory growth.
    if (preparedCache.size > MAX_CACHE_SIZE) {
        const oldestKey = preparedCache.keys().next().value as string | undefined;
        if (oldestKey) preparedCache.delete(oldestKey);
    }

    return prepared;
}

export function getPretextStats(
    text: string,
    maxWidth: number,
    font: string,
    options: PretextOptions = { whiteSpace: "pre-wrap", wordBreak: "normal" }
): PretextStats | null {
    if (!text.trim() || maxWidth <= 0) return null;

    const prepared = getOrPrepare(text, font, options);
    return measureLineStats(prepared, maxWidth);
}

export function getPreparedPretextText(
    text: string,
    font: string,
    options: PretextOptions = { whiteSpace: "pre-wrap", wordBreak: "normal" }
): PreparedTextWithSegments | null {
    if (!text.trim()) return null;
    return getOrPrepare(text, font, options);
}

export function getPretextStatsFromPrepared(
    prepared: PreparedTextWithSegments,
    maxWidth: number
): PretextStats | null {
    if (maxWidth <= 0) return null;
    return measureLineStats(prepared, maxWidth);
}

export function materializePreparedPretextLines(
    prepared: PreparedTextWithSegments,
    maxWidth: number
): PretextLayoutLineSnapshot[] {
    if (maxWidth <= 0) return [];

    const lines: PretextLayoutLineSnapshot[] = [];
    let cursor = { segmentIndex: 0, graphemeIndex: 0 };

    while (true) {
        const range = layoutNextLineRange(prepared, cursor, maxWidth);
        if (!range) break;

        const line = materializeLineRange(prepared, range);
        lines.push({
            text: line.text,
            width: line.width,
        });

        cursor = range.end;
    }

    return lines;
}

export function getPretextLayoutSnapshotFromPrepared(
    prepared: PreparedTextWithSegments,
    maxWidth: number,
    lineHeight: number
): PretextLayoutSnapshot | null {
    if (maxWidth <= 0) return null;

    const stats = measureLineStats(prepared, maxWidth);
    const lines = materializePreparedPretextLines(prepared, maxWidth);
    const estimatedHeight = Math.max(lineHeight, Math.ceil(stats.lineCount * lineHeight));

    return {
        ...stats,
        height: estimatedHeight,
        estimatedHeight,
        lines,
    };
}

export function getPretextBlockMetrics(
    text: string,
    maxWidth: number,
    font: string,
    lineHeight: number,
    options: PretextOptions = { whiteSpace: "pre-wrap", wordBreak: "normal" }
): PretextBlockMetrics | null {
    const stats = getPretextStats(text, maxWidth, font, options);
    if (!stats) return null;

    return {
        ...stats,
        estimatedHeight: Math.max(lineHeight, Math.ceil(stats.lineCount * lineHeight)),
    };
}

export function getPretextLayoutSnapshot(
    text: string,
    maxWidth: number,
    font: string,
    lineHeight: number,
    options: PretextOptions = { whiteSpace: "pre-wrap", wordBreak: "normal" }
): PretextLayoutSnapshot | null {
    if (!text.trim() || maxWidth <= 0) return null;

    const prepared = getOrPrepare(text, font, options);
    const stats = measureLineStats(prepared, maxWidth);
    const layout = layoutWithLines(prepared, maxWidth, lineHeight);

    return {
        ...stats,
        height: layout.height,
        estimatedHeight: Math.max(lineHeight, Math.ceil(layout.height)),
        lines: layout.lines.map((line) => ({
            text: line.text,
            width: line.width,
        })),
    };
}

export function measurePretextLayoutBatch(
    items: PretextMeasureRequestItem[]
): PretextMeasureResponseItem[] {
    return items.map((item) => ({
        id: item.id,
        snapshot: getPretextLayoutSnapshot(
            item.text,
            item.maxWidth,
            item.font,
            item.lineHeight,
            item.options
        ),
    }));
}

export function clearPretextStatsCache(): void {
    preparedCache.clear();
}

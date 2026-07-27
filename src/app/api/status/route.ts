import { NextRequest, NextResponse } from "next/server";
import { isMinerUUpstreamError, MinerUClient } from "@/lib/mineru-client";
import { setCache } from "@/lib/cache";
import {
    buildMediaDeliveryUrl,
    buildRawMediaUrl,
    signInternalMediaUrlsInMarkdown,
} from "@/lib/media-access";
import { grantFileHashAccess } from "@/lib/media-session";
import { normalizeMarkdownMathForDisplay } from "@/lib/markdown-normalizer";
import { findUploadArtifactPaths, readTextFileIfExists } from "@/lib/upload-artifacts";
import { isSafeFileHash, resolveUploadDir } from "@/lib/server/runtime-paths";
import JSZip from "jszip";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

interface MarkdownCandidate {
    relativePath: string;
    content: string;
}

type StoredExtractionResult = {
    markdown: string;
    layoutUrl: string | null;
    layoutJsonUrl: string | null;
};

type ArtifactErrorCode =
    | "ZIP_DOWNLOAD_FAILED"
    | "ZIP_EXTRACT_FAILED"
    | "MARKDOWN_NOT_FOUND"
    | "ARTIFACT_TOO_LARGE";

const DEFAULT_MAX_ZIP_DOWNLOAD_BYTES = 120 * 1024 * 1024;
const DEFAULT_MAX_ZIP_ENTRY_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_ZIP_TOTAL_BYTES = 220 * 1024 * 1024;
const DEFAULT_MAX_ZIP_FILE_COUNT = 500;

class ArtifactProcessingError extends Error {
    code: ArtifactErrorCode;

    constructor(code: ArtifactErrorCode, message: string, options?: { cause?: unknown }) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "ArtifactProcessingError";
        this.code = code;
    }
}

function readPositiveIntEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getZipDownloadLimitBytes(): number {
    return readPositiveIntEnv("MAX_STATUS_ZIP_DOWNLOAD_BYTES", DEFAULT_MAX_ZIP_DOWNLOAD_BYTES);
}

function getZipEntryLimitBytes(): number {
    return readPositiveIntEnv("MAX_STATUS_ARTIFACT_FILE_BYTES", DEFAULT_MAX_ZIP_ENTRY_BYTES);
}

function getZipTotalLimitBytes(): number {
    return readPositiveIntEnv("MAX_STATUS_ARTIFACT_TOTAL_BYTES", DEFAULT_MAX_ZIP_TOTAL_BYTES);
}

function getZipFileCountLimit(): number {
    return readPositiveIntEnv("MAX_STATUS_ARTIFACT_FILE_COUNT", DEFAULT_MAX_ZIP_FILE_COUNT);
}

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function compareRelativePaths(a: string, b: string): number {
    const depthDiff = a.split("/").length - b.split("/").length;
    if (depthDiff !== 0) return depthDiff;

    const lengthDiff = a.length - b.length;
    if (lengthDiff !== 0) return lengthDiff;

    return a.localeCompare(b);
}

function scoreMarkdownCandidate(relativePath: string): number {
    const normalized = normalizeRelativePath(relativePath).toLowerCase();
    const baseName = path.posix.basename(normalized);
    let score = 0;

    if (normalized === "full.md") score += 1000;
    if (baseName === "full.md") score += 900;
    if (baseName.includes("full")) score += 180;
    if (baseName.includes("translation")) score += 140;
    if (baseName.includes("content")) score += 80;

    score -= normalized.split("/").length * 10;
    score -= normalized.length / 100;

    return score;
}

function pickPrimaryMarkdownCandidate(candidates: MarkdownCandidate[]): MarkdownCandidate | null {
    if (candidates.length === 0) return null;

    return [...candidates].sort((a, b) => {
        const scoreDiff = scoreMarkdownCandidate(b.relativePath) - scoreMarkdownCandidate(a.relativePath);
        if (scoreDiff !== 0) return scoreDiff;
        return compareRelativePaths(a.relativePath, b.relativePath);
    })[0] ?? null;
}

function prepareMarkdownForClient(markdown: string, safeHash: string): string {
    return signInternalMediaUrlsInMarkdown(
        normalizeMarkdownMathForDisplay(markdown),
        safeHash
    );
}

function resolveRelativeAssetApiPath(markdownPath: string, assetPath: string, safeHash: string): string | null {
    const trimmed = assetPath.trim().replace(/\\/g, "/");
    if (!trimmed) return null;
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(trimmed)) return null;
    if (trimmed.startsWith("data:") || trimmed.startsWith("#") || trimmed.startsWith("/")) return null;

    const normalizedMarkdownPath = normalizeRelativePath(markdownPath);
    const resolvedPath = path.posix.normalize(path.posix.join(path.posix.dirname(normalizedMarkdownPath), trimmed));

    if (!resolvedPath || resolvedPath.startsWith("..")) {
        return null;
    }

    return buildRawMediaUrl(safeHash, resolvedPath);
}

function rewriteMarkdownAssetUrls(markdown: string, markdownPath: string, safeHash: string): string {
    return markdown
        .replace(/!\[(.*?)\]\((?![a-z][a-z0-9+.-]*:|\/\/|#|\/)(.*?)\)/gi, (match, alt, assetPath) => {
            const resolvedUrl = resolveRelativeAssetApiPath(markdownPath, assetPath, safeHash);
            return resolvedUrl ? `![${alt}](${resolvedUrl})` : match;
        })
        .replace(/<img([^>]*?)src=["']([^"']+)["']([^>]*)>/gi, (match, before, assetPath, after) => {
            const resolvedUrl = resolveRelativeAssetApiPath(markdownPath, assetPath, safeHash);
            return resolvedUrl ? `<img${before}src="${resolvedUrl}"${after}>` : match;
        });
}

function createRetryDelay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getZipEntrySizeHint(zipEntry: JSZip.JSZipObject): number | null {
    const entryData = (zipEntry as unknown as { _data?: { uncompressedSize?: number } })._data;
    const size = entryData?.uncompressedSize;
    return typeof size === "number" && Number.isFinite(size) ? size : null;
}

async function downloadZipWithRetry(url: string, attempts = 3): Promise<Buffer> {
    let lastError: unknown = null;
    const maxZipBytes = getZipDownloadLimitBytes();

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(20_000),
            });
            if (!response.ok) {
                throw new ArtifactProcessingError(
                    "ZIP_DOWNLOAD_FAILED",
                    `Failed to download ZIP artifact: HTTP ${response.status}`
                );
            }

            const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
            if (Number.isFinite(contentLength) && contentLength > maxZipBytes) {
                throw new ArtifactProcessingError(
                    "ARTIFACT_TOO_LARGE",
                    `ZIP artifact exceeds the ${Math.floor(maxZipBytes / (1024 * 1024))}MB download limit`
                );
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new ArtifactProcessingError("ZIP_DOWNLOAD_FAILED", "ZIP response body is unavailable");
            }

            const chunks: Buffer[] = [];
            let totalBytes = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;

                totalBytes += value.byteLength;
                if (totalBytes > maxZipBytes) {
                    throw new ArtifactProcessingError(
                        "ARTIFACT_TOO_LARGE",
                        `ZIP artifact exceeds the ${Math.floor(maxZipBytes / (1024 * 1024))}MB download limit`
                    );
                }

                chunks.push(Buffer.from(value));
            }

            return Buffer.concat(chunks, totalBytes);
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                await createRetryDelay(700 * attempt);
            }
        }
    }

    if (lastError instanceof ArtifactProcessingError) {
        throw lastError;
    }

    throw new ArtifactProcessingError(
        "ZIP_DOWNLOAD_FAILED",
        lastError instanceof Error ? lastError.message : "Failed to download ZIP artifact",
        { cause: lastError }
    );
}

function resolveUploadDestinationPath(uploadDir: string, relativePath: string): string {
    const normalizedRelativePath = normalizeRelativePath(relativePath);
    if (!normalizedRelativePath || normalizedRelativePath.startsWith("..")) {
        throw new ArtifactProcessingError("ZIP_EXTRACT_FAILED", `Unsafe artifact path: ${relativePath}`);
    }

    const resolvedPath = path.resolve(uploadDir, normalizedRelativePath);
    const normalizedUploadDir = path.resolve(uploadDir);
    if (resolvedPath !== normalizedUploadDir && !resolvedPath.startsWith(`${normalizedUploadDir}${path.sep}`)) {
        throw new ArtifactProcessingError("ZIP_EXTRACT_FAILED", `Artifact path escapes upload directory: ${relativePath}`);
    }

    return resolvedPath;
}

async function readStoredExtractionResult(uploadDir: string, safeHash: string): Promise<StoredExtractionResult | null> {
    const { markdownRelativePath, layoutPdfRelativePath, layoutJsonRelativePath } = await findUploadArtifactPaths(uploadDir);
    const markdown = await readTextFileIfExists(markdownRelativePath ? path.join(uploadDir, markdownRelativePath) : null);

    if (!markdown.trim()) {
        return null;
    }

    return {
        markdown: prepareMarkdownForClient(markdown, safeHash),
        layoutUrl: layoutPdfRelativePath ? buildMediaDeliveryUrl(safeHash, layoutPdfRelativePath) : null,
        layoutJsonUrl: layoutJsonRelativePath ? buildMediaDeliveryUrl(safeHash, layoutJsonRelativePath) : null,
    };
}

async function readStoredRawMarkdown(uploadDir: string): Promise<string> {
    const { markdownRelativePath } = await findUploadArtifactPaths(uploadDir);
    return readTextFileIfExists(markdownRelativePath ? path.join(uploadDir, markdownRelativePath) : null);
}

function buildFailedStatusResponse(code: ArtifactErrorCode, message: string): NextResponse {
    return NextResponse.json({
        state: "failed",
        progress: 0,
        errorCode: code,
        error: message,
    });
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const batchId = searchParams.get("batchId");
    const fileHash = searchParams.get("fileHash");
    const fileName = searchParams.get("fileName");

    if (!batchId) {
        return NextResponse.json({ error: "Missing batchId" }, { status: 400 });
    }

    if (!isSafeFileHash(batchId) || (fileHash !== null && !isSafeFileHash(fileHash))) {
        return NextResponse.json({ error: "Invalid batchId or fileHash" }, { status: 400 });
    }

    const apiKey = process.env.MINERU_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "Server misconfigured: MINERU_API_KEY missing" }, { status: 500 });
    }

    try {
        const client = new MinerUClient({ apiKey });
        const statusData = await client.getBatchStatus(batchId);
        const fileResult = statusData.extract_result[0];

        if (!fileResult) {
            return NextResponse.json({ state: "pending", progress: 0 });
        }

        const responseBase = {
            state: fileResult.state,
            progress: 0,
        };

        if (fileResult.state === "running" && fileResult.extract_progress) {
            const { extracted_pages, total_pages } = fileResult.extract_progress;
            const progress = total_pages > 0 ? Math.round((extracted_pages / total_pages) * 100) : 10;
            return NextResponse.json({ ...responseBase, progress });
        }

        if (fileResult.state === "done") {
            const safeHash = fileHash || batchId;
            const uploadDir = resolveUploadDir(safeHash);

            if (!uploadDir) {
                return NextResponse.json({ error: "Invalid batchId or fileHash" }, { status: 400 });
            }

            await mkdir(uploadDir, { recursive: true });

            const existingResult = await readStoredExtractionResult(uploadDir, safeHash);
            if (existingResult) {
                if (fileHash) {
                    const rawMarkdown = await readStoredRawMarkdown(uploadDir);
                    await setCache(fileHash, rawMarkdown, fileName || "unknown.pdf", batchId);
                }

                const cachedResponse = NextResponse.json({
                    ...responseBase,
                    progress: 100,
                    markdown: existingResult.markdown,
                    layoutUrl: existingResult.layoutUrl,
                    layoutJsonUrl: existingResult.layoutJsonUrl,
                });
                if (fileHash) {
                    grantFileHashAccess(request, cachedResponse, fileHash);
                }
                return cachedResponse;
            }

            if (!fileResult.full_zip_url) {
                return buildFailedStatusResponse(
                    "ZIP_DOWNLOAD_FAILED",
                    "MinerU reported completion but did not provide a downloadable ZIP artifact."
                );
            }

            try {
                const zipBuffer = await downloadZipWithRetry(fileResult.full_zip_url);
                const zip = await JSZip.loadAsync(zipBuffer);
                const maxFiles = getZipFileCountLimit();
                const maxEntryBytes = getZipEntryLimitBytes();
                const maxTotalBytes = getZipTotalLimitBytes();

                const entries = Object.entries(zip.files).filter(([filePath, zipEntry]) => (
                    Boolean(zipEntry) &&
                    !zipEntry.dir &&
                    !filePath.startsWith("__MACOSX")
                ));

                if (entries.length > maxFiles) {
                    throw new ArtifactProcessingError(
                        "ARTIFACT_TOO_LARGE",
                        `ZIP artifact contains too many files (${entries.length}/${maxFiles}).`
                    );
                }

                const markdownCandidates: MarkdownCandidate[] = [];
                let totalExtractedBytes = 0;

                for (const [filePath, zipEntry] of entries) {
                    const relativePath = normalizeRelativePath(filePath);
                    if (!relativePath) continue;

                    const sizeHint = getZipEntrySizeHint(zipEntry);
                    if (sizeHint !== null && sizeHint > maxEntryBytes) {
                        throw new ArtifactProcessingError(
                            "ARTIFACT_TOO_LARGE",
                            `Artifact file ${relativePath} exceeds the ${Math.floor(maxEntryBytes / (1024 * 1024))}MB limit.`
                        );
                    }

                    const fileData = await zipEntry.async("nodebuffer");
                    totalExtractedBytes += fileData.byteLength;

                    if (fileData.byteLength > maxEntryBytes || totalExtractedBytes > maxTotalBytes) {
                        throw new ArtifactProcessingError(
                            "ARTIFACT_TOO_LARGE",
                            "Extracted artifacts exceed the configured safety limits."
                        );
                    }

                    const lowerRelativePath = relativePath.toLowerCase();

                    if (lowerRelativePath.endsWith(".md")) {
                        const storedMarkdown = rewriteMarkdownAssetUrls(fileData.toString("utf-8"), relativePath, safeHash);
                        const markdownPath = resolveUploadDestinationPath(uploadDir, relativePath);
                        await mkdir(path.dirname(markdownPath), { recursive: true });
                        await writeFile(markdownPath, storedMarkdown, "utf-8");
                        markdownCandidates.push({ relativePath, content: storedMarkdown });
                        continue;
                    }

                    let destinationRelativePath = relativePath;
                    if (lowerRelativePath.endsWith(".pdf")) {
                        const baseName = path.posix.basename(lowerRelativePath);
                        if (baseName === "origin.pdf" || baseName.endsWith("_origin.pdf")) {
                            destinationRelativePath = "original.pdf";
                        }
                    }

                    const destinationPath = resolveUploadDestinationPath(uploadDir, destinationRelativePath);
                    await mkdir(path.dirname(destinationPath), { recursive: true });
                    await writeFile(destinationPath, fileData);
                }

                const primaryMarkdown = pickPrimaryMarkdownCandidate(markdownCandidates);
                if (!primaryMarkdown) {
                    throw new ArtifactProcessingError(
                        "MARKDOWN_NOT_FOUND",
                        "No markdown file was found inside the MinerU ZIP artifact."
                    );
                }

                const primaryMarkdownPath = normalizeRelativePath(primaryMarkdown.relativePath);
                if (primaryMarkdownPath !== "full.md") {
                    await writeFile(resolveUploadDestinationPath(uploadDir, "full.md"), primaryMarkdown.content, "utf-8");
                }

                const { layoutPdfRelativePath, layoutJsonRelativePath } = await findUploadArtifactPaths(uploadDir);
                const clientMarkdown = prepareMarkdownForClient(primaryMarkdown.content, safeHash);

                if (fileHash) {
                    await setCache(fileHash, primaryMarkdown.content, fileName || "unknown.pdf", batchId);
                }

                const successResponse = NextResponse.json({
                    ...responseBase,
                    progress: 100,
                    markdown: clientMarkdown,
                    layoutUrl: layoutPdfRelativePath ? buildMediaDeliveryUrl(safeHash, layoutPdfRelativePath) : null,
                    layoutJsonUrl: layoutJsonRelativePath ? buildMediaDeliveryUrl(safeHash, layoutJsonRelativePath) : null,
                });
                if (fileHash) {
                    grantFileHashAccess(request, successResponse, fileHash);
                }
                return successResponse;
            } catch (zipError) {
                if (zipError instanceof ArtifactProcessingError) {
                    return buildFailedStatusResponse(zipError.code, zipError.message);
                }

                console.error("Artifact extraction failed:", zipError instanceof Error ? zipError.message : zipError);
                return buildFailedStatusResponse(
                    "ZIP_EXTRACT_FAILED",
                    zipError instanceof Error ? zipError.message : "Failed to extract MinerU ZIP artifact"
                );
            }
        }

        if (fileResult.state === "failed") {
            return NextResponse.json({
                state: "failed",
                error: fileResult.err_msg || "Extraction failed",
            });
        }

        return NextResponse.json(responseBase);
    } catch (error: unknown) {
        console.error("Status handler error:", error instanceof Error ? error.message : error);

        if (isMinerUUpstreamError(error) && error.retryable) {
            return NextResponse.json({
                state: "running",
                progress: 95,
                transientError: error.message,
            });
        }

        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal Server Error" },
            { status: 500 }
        );
    }
}

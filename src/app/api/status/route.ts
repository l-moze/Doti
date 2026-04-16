import { NextRequest, NextResponse } from "next/server";
import { MinerUClient } from "@/lib/mineru-client";
import { setCache } from "@/lib/cache";
import { normalizeMarkdownMathForDisplay } from "@/lib/markdown-normalizer";
import { findPreferredRelativeFilePath } from "@/lib/upload-artifacts";
import JSZip from "jszip";
import fs from "fs";
import path from "path";

interface MarkdownCandidate {
    relativePath: string;
    content: string;
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

    return `/api/media/${safeHash}/${resolvedPath}`;
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

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const batchId = searchParams.get("batchId");
    const fileHash = searchParams.get("fileHash");
    const fileName = searchParams.get("fileName");

    if (!batchId) {
        return NextResponse.json({ error: "Missing batchId" }, { status: 400 });
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
            return NextResponse.json({ status: "pending", progress: 0 });
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

        if (fileResult.state === "done" && fileResult.full_zip_url) {
            try {
                const zipRes = await fetch(fileResult.full_zip_url);
                if (!zipRes.ok) {
                    throw new Error("Failed to download zip");
                }

                const zipBuffer = await zipRes.arrayBuffer();
                const zip = await JSZip.loadAsync(zipBuffer);

                const uploadsRoot = path.join(process.cwd(), "uploads");
                const safeHash = fileHash || batchId;
                const uploadDir = path.join(uploadsRoot, safeHash);
                fs.mkdirSync(uploadDir, { recursive: true });

                const markdownCandidates: MarkdownCandidate[] = [];

                for (const filePath of Object.keys(zip.files)) {
                    const zipEntry = zip.files[filePath];
                    if (!zipEntry || zipEntry.dir || filePath.startsWith("__MACOSX")) {
                        continue;
                    }

                    const relativePath = normalizeRelativePath(filePath);
                    if (!relativePath) continue;

                    const fileData = await zipEntry.async("nodebuffer");
                    const lowerRelativePath = relativePath.toLowerCase();

                    if (lowerRelativePath.endsWith(".md")) {
                        const processedMarkdown = normalizeMarkdownMathForDisplay(
                            rewriteMarkdownAssetUrls(fileData.toString("utf-8"), relativePath, safeHash)
                        );
                        const markdownPath = path.join(uploadDir, relativePath);
                        fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
                        fs.writeFileSync(markdownPath, processedMarkdown);
                        markdownCandidates.push({ relativePath, content: processedMarkdown });
                        continue;
                    }

                    let destinationRelativePath = relativePath;
                    if (lowerRelativePath.endsWith(".pdf")) {
                        const baseName = path.posix.basename(lowerRelativePath);
                        if (baseName === "origin.pdf" || baseName.endsWith("_origin.pdf")) {
                            const originalPdfPath = path.join(uploadDir, "original.pdf");
                            if (fs.existsSync(originalPdfPath)) {
                                continue;
                            }
                            destinationRelativePath = "original.pdf";
                        }
                    }

                    const destinationPath = path.join(uploadDir, destinationRelativePath);
                    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                    fs.writeFileSync(destinationPath, fileData);
                }

                const primaryMarkdown = pickPrimaryMarkdownCandidate(markdownCandidates);
                if (!primaryMarkdown) {
                    return NextResponse.json({
                        ...responseBase,
                        state: "failed",
                        error: "No markdown file found in ZIP",
                    });
                }

                const primaryMarkdownPath = normalizeRelativePath(primaryMarkdown.relativePath);
                if (primaryMarkdownPath !== "full.md") {
                    fs.writeFileSync(path.join(uploadDir, "full.md"), primaryMarkdown.content);
                }

                const layoutPdfRelativePath = findPreferredRelativeFilePath(
                    uploadDir,
                    (relativePath, fileNameInDir) =>
                        fileNameInDir === "layout.pdf" ||
                        fileNameInDir.endsWith("_layout.pdf") ||
                        relativePath.endsWith("/layout.pdf")
                );
                const layoutJsonRelativePath = findPreferredRelativeFilePath(
                    uploadDir,
                    (relativePath, fileNameInDir) =>
                        fileNameInDir === "layout.json" || relativePath.endsWith("/layout.json")
                );

                if (fileHash) {
                    await setCache(fileHash, primaryMarkdown.content, fileName || "unknown.pdf", batchId);
                }

                return NextResponse.json({
                    ...responseBase,
                    progress: 100,
                    markdown: primaryMarkdown.content,
                    layoutUrl: layoutPdfRelativePath ? `/api/media/${safeHash}/${layoutPdfRelativePath}` : null,
                    layoutJsonUrl: layoutJsonRelativePath ? `/api/media/${safeHash}/${layoutJsonRelativePath}` : null,
                });
            } catch (zipError) {
                console.error("Zip extraction failed:", zipError);
                return NextResponse.json({
                    ...responseBase,
                    state: "failed",
                    error: "Result processing failed",
                });
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
        console.error("Status handler error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal Server Error" },
            { status: 500 }
        );
    }
}

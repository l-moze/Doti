import { NextRequest, NextResponse } from "next/server";
import {
    buildMinerUFileEntry,
    getMinerUBatchUploadOptionsFromEnv,
    isMinerUUpstreamError,
    MinerUClient,
} from "@/lib/mineru-client";
import { computeFileHash } from "@/lib/cache";
import { normalizeMarkdownMathForDisplay } from "@/lib/markdown-normalizer";
import { buildMediaDeliveryUrl, signInternalMediaUrlsInMarkdown } from "@/lib/media-access";
import { grantFileHashAccess } from "@/lib/media-session";
import { findUploadArtifactPaths } from "@/lib/upload-artifacts";
import { getUploadsRoot } from "@/lib/server/runtime-paths";
import { readPositiveIntEnv } from "@/lib/env-utils";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function getMaxPdfUploadBytes(): number {
    return readPositiveIntEnv("MAX_PDF_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES);
}

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get("file") as File;

        if (!file) {
            return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
        }

        if (file.type && file.type !== "application/pdf") {
            return NextResponse.json({ error: "Only PDF files are supported" }, { status: 400 });
        }

        const maxUploadBytes = getMaxPdfUploadBytes();
        if (file.size > maxUploadBytes) {
            return NextResponse.json({
                error: `PDF is too large. Maximum allowed size is ${Math.floor(maxUploadBytes / (1024 * 1024))}MB.`,
                errorCode: "FILE_TOO_LARGE",
                maxUploadBytes,
                actualBytes: file.size,
            }, { status: 413 });
        }

        // 读取文件内容并计算哈希
        const arrayBuffer = await file.arrayBuffer();
        const fileHash = computeFileHash(arrayBuffer);

        // Check for existing files in uploads/[hash]
        const uploadsRoot = getUploadsRoot();
        // Need to calculate hash earlier to check cache (already done above)

        const uploadDir = path.join(uploadsRoot, fileHash);

        // Ensure directory exists
        await mkdir(uploadDir, { recursive: true });

        // 1. IMPROVEMENT: Immediate Persistence
        // Save original file immediately as 'original.pdf'
        // This ensures frontend can access /api/media/[hash]/original.pdf right away
        const originalPdfPath = path.join(uploadDir, 'original.pdf');
        try {
            const buffer = Buffer.from(arrayBuffer);
            await writeFile(originalPdfPath, buffer, { flag: "wx" });
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }

        const mdPath = path.join(uploadDir, 'full.md');

        try {
            const cachedMarkdown = signInternalMediaUrlsInMarkdown(
                normalizeMarkdownMathForDisplay(await readFile(mdPath, "utf-8")),
                fileHash
            );

            // Check for layout.json in filesystem (preferred for client-side rendering)
            let layoutJsonUrl = null;
            let layoutUrl = null;

            const { layoutJsonRelativePath, layoutPdfRelativePath } = await findUploadArtifactPaths(uploadDir);
            if (layoutJsonRelativePath) {
                layoutJsonUrl = buildMediaDeliveryUrl(fileHash, layoutJsonRelativePath);
            }

            if (layoutPdfRelativePath) {
                layoutUrl = buildMediaDeliveryUrl(fileHash, layoutPdfRelativePath);
            }

            const response = NextResponse.json({
                status: "cached",
                fileHash,
                markdown: cachedMarkdown,
                layoutUrl,
                layoutJsonUrl
            });
            grantFileHashAccess(request, response, fileHash);
            return response;
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }

        // 无缓存，执行 MinerU 上传流程
        const apiKey = process.env.MINERU_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "Server misconfigured: MINERU_API_KEY missing" }, { status: 500 });
        }

        const client = new MinerUClient({ apiKey });

        // Step 1: Apply for batch upload URL
        const batchResult = await client.applyBatchUpload(
            [buildMinerUFileEntry(file.name, fileHash)],
            getMinerUBatchUploadOptionsFromEnv()
        );

        const { batch_id, file_urls } = batchResult;

        if (!file_urls || file_urls.length === 0) {
            return NextResponse.json({ error: "Failed to get upload URL from MinerU" }, { status: 500 });
        }

        const uploadUrl = file_urls[0];

        // Step 2: Upload file to signed URL
        await client.uploadFileToUrl(uploadUrl, arrayBuffer);

        // Return batch_id and fileHash for polling and caching
        const response = NextResponse.json({
            batchId: batch_id,
            fileHash,
            fileName: file.name,
            status: "uploaded"
        });
        grantFileHashAccess(request, response, fileHash);
        return response;

    } catch (error: unknown) {
        console.error("Upload handler error:", error instanceof Error ? error.message : error);

        if (isMinerUUpstreamError(error)) {
            return NextResponse.json(
                {
                    error: error.message,
                    retryable: error.retryable,
                },
                { status: error.retryable ? 502 : (error.statusCode || 500) }
            );
        }

        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal Server Error" },
            { status: 500 }
        );
    }
}

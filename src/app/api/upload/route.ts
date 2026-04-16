import { NextRequest, NextResponse } from "next/server";
import {
    buildMinerUFileEntry,
    getMinerUBatchUploadOptionsFromEnv,
    MinerUClient,
} from "@/lib/mineru-client";
import { computeFileHash } from "@/lib/cache";
import { normalizeMarkdownMathForDisplay } from "@/lib/markdown-normalizer";
import { findPreferredRelativeFilePath } from "@/lib/upload-artifacts";
import fs from "fs";
import path from "path";

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get("file") as File;

        if (!file) {
            return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
        }

        // 读取文件内容并计算哈希
        const arrayBuffer = await file.arrayBuffer();
        const fileHash = computeFileHash(arrayBuffer);

        console.log(`File: ${file.name}, Hash: ${fileHash} `);

        // Check for existing files in uploads/[hash]
        const uploadsRoot = path.join(process.cwd(), 'uploads');
        // Need to calculate hash earlier to check cache (already done above)

        const uploadDir = path.join(uploadsRoot, fileHash);

        // Ensure directory exists
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        // 1. IMPROVEMENT: Immediate Persistence
        // Save original file immediately as 'original.pdf'
        // This ensures frontend can access /api/media/[hash]/original.pdf right away
        const originalPdfPath = path.join(uploadDir, 'original.pdf');
        if (!fs.existsSync(originalPdfPath)) {
            const buffer = Buffer.from(arrayBuffer);
            fs.writeFileSync(originalPdfPath, buffer);
            console.log(`Saved original.pdf to ${originalPdfPath}`);
        }

        const mdPath = path.join(uploadDir, 'full.md');

        if (fs.existsSync(mdPath)) {
            console.log(`Cache hit (filesystem) for ${file.name} (${fileHash})`);
            const cachedMarkdown = normalizeMarkdownMathForDisplay(fs.readFileSync(mdPath, 'utf-8'));

            // Check for layout.json in filesystem (preferred for client-side rendering)
            let layoutJsonUrl = null;
            let layoutUrl = null;

            const layoutJsonPath = findPreferredRelativeFilePath(
                uploadDir,
                (relativePath, fileName) => fileName === "layout.json" || relativePath.endsWith("/layout.json")
            );
            if (layoutJsonPath) {
                layoutJsonUrl = `/api/media/${fileHash}/${layoutJsonPath}`;
            }

            const layoutPdfPath = findPreferredRelativeFilePath(
                uploadDir,
                (relativePath, fileName) => fileName === "layout.pdf" || fileName.endsWith("_layout.pdf") || relativePath.endsWith("/layout.pdf")
            );
            if (layoutPdfPath) {
                layoutUrl = `/api/media/${fileHash}/${layoutPdfPath}`;
            }

            return NextResponse.json({
                status: "cached",
                fileHash,
                markdown: cachedMarkdown,
                layoutUrl,
                layoutJsonUrl
            });
        }

        console.log(`Cache miss for ${file.name}, uploading to MinerU...`);

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

        console.log("MinerU applyBatchUpload response:", JSON.stringify(batchResult, null, 2));

        const { batch_id, file_urls } = batchResult;

        if (!file_urls || file_urls.length === 0) {
            return NextResponse.json({ error: "Failed to get upload URL from MinerU" }, { status: 500 });
        }

        const uploadUrl = file_urls[0];
        console.log("Upload URL:", uploadUrl);

        // Step 2: Upload file to signed URL
        await client.uploadFileToUrl(uploadUrl, arrayBuffer);

        // Return batch_id and fileHash for polling and caching
        return NextResponse.json({
            batchId: batch_id,
            fileHash,
            fileName: file.name,
            status: "uploaded"
        });

    } catch (error: unknown) {
        console.error("Upload handler error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal Server Error" },
            { status: 500 }
        );
    }
}

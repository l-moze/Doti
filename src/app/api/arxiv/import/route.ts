import { NextRequest, NextResponse } from "next/server";
import {
    buildMinerUFileEntry,
    getMinerUBatchUploadOptionsFromEnv,
    isMinerUUpstreamError,
    MinerUClient,
} from "@/lib/mineru-client";
import { computeFileHash } from "@/lib/cache";
import { buildMediaDeliveryUrl, signInternalMediaUrlsInMarkdown } from "@/lib/media-access";
import { grantFileHashAccess } from "@/lib/media-session";
import { normalizeMarkdownMathForDisplay } from "@/lib/markdown-normalizer";
import { findUploadArtifactPaths, readTextFileIfExists } from "@/lib/upload-artifacts";
import { getUploadsRoot } from "@/lib/server/runtime-paths";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

interface ArxivMetadata {
    arxivId: string;
    version?: string;
    title?: string;
    summary?: string;
    authors: string[];
    pdfUrl: string;
}

function normalizeArxivInput(input: string): { id: string; version?: string } {
    const trimmed = input.trim();
    const withoutPrefix = trimmed.replace(/^arxiv:/i, "");
    const absMatch = withoutPrefix.match(/arxiv\.org\/abs\/([^/?#]+)/i);
    const pdfMatch = withoutPrefix.match(/arxiv\.org\/pdf\/([^/?#]+?)(?:\.pdf)?$/i);
    const candidate = absMatch?.[1] || pdfMatch?.[1] || withoutPrefix;
    const cleaned = candidate.replace(/\.pdf$/i, "");
    const versionMatch = cleaned.match(/^(.*?)(v\d+)$/i);

    if (versionMatch) {
        return { id: versionMatch[1], version: versionMatch[2] };
    }

    return { id: cleaned };
}

async function fetchArxivMetadata(input: string): Promise<ArxivMetadata> {
    const normalized = normalizeArxivInput(input);
    const queryId = `${normalized.id}${normalized.version || ""}`;
    const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(queryId)}`;
    const response = await fetch(apiUrl, { cache: "no-store" });

    if (!response.ok) {
        throw new Error(`arXiv metadata request failed (${response.status})`);
    }

    const xml = await response.text();
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];
    if (!entry) {
        throw new Error("No arXiv entry found for this identifier");
    }

    const title = entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.replace(/\s+/g, " ").trim();
    const idText = entry.match(/<id>([\s\S]*?)<\/id>/i)?.[1]?.trim() || queryId;
    const idMatch = idText.match(/\/abs\/([^/?#]+)$/i);
    const resolved = idMatch?.[1] || queryId;
    const resolvedVersion = resolved.match(/(v\d+)$/i)?.[1];
    const baseId = resolvedVersion ? resolved.replace(/v\d+$/i, "") : resolved;
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((match) => match[1].replace(/\s+/g, " ").trim());

    return {
        arxivId: baseId,
        version: resolvedVersion,
        title,
        summary,
        authors,
        pdfUrl: `https://arxiv.org/pdf/${resolved}.pdf`,
    };
}

function safePdfFileName(metadata: ArxivMetadata): string {
    const fallback = `${metadata.arxivId}${metadata.version || ""}`.replace(/[^\w.-]+/g, "_");
    const title = metadata.title?.replace(/[<>:"/\\|?*\x00-\x1F]+/g, " ").replace(/\s+/g, " ").trim();
    if (!title) return `${fallback}.pdf`;
    return `${title.slice(0, 80)}.pdf`;
}

export async function POST(request: NextRequest) {
    try {
        const { input, preview } = await request.json();
        if (!input || typeof input !== "string") {
            return NextResponse.json({ error: "Missing arXiv input" }, { status: 400 });
        }

        const metadata = await fetchArxivMetadata(input);
        if (preview === true) {
            return NextResponse.json({
                status: "preview",
                canonicalId: `${metadata.arxivId}${metadata.version || ""}`,
                metadata,
            });
        }

        const pdfResponse = await fetch(metadata.pdfUrl, { cache: "no-store" });
        if (!pdfResponse.ok) {
            return NextResponse.json({ error: `Failed to download arXiv PDF (${pdfResponse.status})` }, { status: 502 });
        }

        const arrayBuffer = await pdfResponse.arrayBuffer();
        const fileHash = computeFileHash(arrayBuffer);
        const uploadsRoot = getUploadsRoot();
        const uploadDir = path.join(uploadsRoot, fileHash);
        await mkdir(uploadDir, { recursive: true });

        const originalPdfPath = path.join(uploadDir, "original.pdf");
        try {
            await writeFile(originalPdfPath, Buffer.from(arrayBuffer), { flag: "wx" });
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }

        const { markdownRelativePath, layoutJsonRelativePath, layoutPdfRelativePath } = await findUploadArtifactPaths(uploadDir);
        const cachedMarkdownRaw = await readTextFileIfExists(
            markdownRelativePath ? path.join(uploadDir, markdownRelativePath) : null
        );

        if (cachedMarkdownRaw.trim()) {
            const cachedMarkdown = signInternalMediaUrlsInMarkdown(
                normalizeMarkdownMathForDisplay(cachedMarkdownRaw),
                fileHash
            );
            const layoutJsonUrl = layoutJsonRelativePath ? buildMediaDeliveryUrl(fileHash, layoutJsonRelativePath) : null;
            const layoutUrl = layoutPdfRelativePath ? buildMediaDeliveryUrl(fileHash, layoutPdfRelativePath) : null;

            const response = NextResponse.json({
                status: "cached",
                fileHash,
                fileName: safePdfFileName(metadata),
                markdown: cachedMarkdown,
                layoutUrl,
                layoutJsonUrl,
                metadata,
            });
            grantFileHashAccess(request, response, fileHash);
            return response;
        }

        const apiKey = process.env.MINERU_API_KEY;
        if (!apiKey) {
            return NextResponse.json({ error: "Server misconfigured: MINERU_API_KEY missing" }, { status: 500 });
        }

        const client = new MinerUClient({ apiKey });
        const fileName = safePdfFileName(metadata);
        const batchResult = await client.applyBatchUpload(
            [buildMinerUFileEntry(fileName, fileHash)],
            getMinerUBatchUploadOptionsFromEnv()
        );
        const uploadUrl = batchResult.file_urls?.[0];

        if (!uploadUrl) {
            return NextResponse.json({ error: "Failed to get upload URL from MinerU" }, { status: 500 });
        }

        await client.uploadFileToUrl(uploadUrl, arrayBuffer);

        const response = NextResponse.json({
            status: "uploaded",
            batchId: batchResult.batch_id,
            fileHash,
            fileName,
            metadata,
        });
        grantFileHashAccess(request, response, fileHash);
        return response;
    } catch (error) {
        if (isMinerUUpstreamError(error)) {
            return NextResponse.json(
                {
                    error: error.message,
                    retryable: error.retryable,
                },
                { status: error.retryable ? 502 : (error.statusCode || 500) }
            );
        }

        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

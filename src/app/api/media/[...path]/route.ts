import { NextRequest, NextResponse } from "next/server";
import { access, open, readdir, readFile } from "fs/promises";
import path from "path";
import mime from "mime";
import {
    normalizeMediaRelativePath,
    requiresSignedMediaAccess,
    signInternalMediaUrlsInMarkdown,
    verifyMediaAccessToken,
} from "@/lib/media-access";
import { hasFileHashAccess } from "@/lib/media-session";
import { normalizeMarkdownMathForDisplay } from "@/lib/markdown-normalizer";
import { getUploadsRoot } from "@/lib/server/runtime-paths";

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

function isWithinRoot(rootDir: string, candidatePath: string): boolean {
    return candidatePath === rootDir || candidatePath.startsWith(`${rootDir}${path.sep}`);
}

function getRelativePathFromSegments(pathSegments: string[]): string {
    return normalizeMediaRelativePath(pathSegments.slice(1).join("/"));
}

function assertMediaAccess(request: NextRequest, fileHash: string, relativePath: string): NextResponse | null {
    if (!requiresSignedMediaAccess()) {
        return null;
    }

    if (!hasFileHashAccess(request, fileHash)) {
        return new NextResponse("Forbidden", { status: 403 });
    }

    const token = request.nextUrl.searchParams.get("token");
    const expiresAt = request.nextUrl.searchParams.get("expires");

    if (!verifyMediaAccessToken({
        fileHash,
        relativePath,
        token,
        expiresAt,
    })) {
        return new NextResponse("Invalid or expired media token", { status: 403 });
    }

    return null;
}

async function streamFile(filePath: string, contentType: string): Promise<NextResponse> {
    const handle = await open(filePath, "r");
    const stat = await handle.stat();
    const stream = handle.readableWebStream({ type: "bytes" });

    return new NextResponse(stream as unknown as BodyInit, {
        headers: {
            "Content-Type": contentType,
            "Content-Length": stat.size.toString(),
            "Cache-Control": "private, max-age=300",
        },
    });
}

async function resolveMediaFilePath(fileHash: string, relativePath: string): Promise<string | null> {
    const uploadsRoot = path.resolve(getUploadsRoot());
    let filePath = path.resolve(uploadsRoot, fileHash, relativePath);

    if (!isWithinRoot(uploadsRoot, filePath)) {
        return null;
    }

    if (await pathExists(filePath)) {
        return filePath;
    }

    if (relativePath === "original.pdf") {
        const dir = path.dirname(filePath);
        if (await pathExists(dir)) {
            const files = await readdir(dir);
            const legacyOrigin = files.find((fileName) => fileName.endsWith("_origin.pdf"));
            if (legacyOrigin) {
                return path.join(dir, legacyOrigin);
            }
        }
    }

    return null;
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
) {
    try {
        const { path: pathSegments } = await params;

        if (!pathSegments || pathSegments.length < 2) {
            return new NextResponse("Invalid path", { status: 400 });
        }

        const fileHash = pathSegments[0]?.trim();
        if (!fileHash) {
            return new NextResponse("Invalid file hash", { status: 400 });
        }

        const relativePath = getRelativePathFromSegments(pathSegments);
        const accessError = assertMediaAccess(request, fileHash, relativePath);
        if (accessError) {
            return accessError;
        }

        const filePath = await resolveMediaFilePath(fileHash, relativePath);
        if (!filePath) {
            return new NextResponse("File not found", { status: 404 });
        }

        const contentType = mime.getType(filePath) || "application/octet-stream";

        if (filePath.endsWith(".md")) {
            const markdown = await readFile(filePath, "utf-8");
            const normalizedMarkdown = signInternalMediaUrlsInMarkdown(
                normalizeMarkdownMathForDisplay(markdown),
                fileHash
            );

            return new NextResponse(normalizedMarkdown, {
                headers: {
                    "Content-Type": "text/markdown; charset=utf-8",
                    "Content-Length": Buffer.byteLength(normalizedMarkdown, "utf-8").toString(),
                    "Cache-Control": "private, max-age=300",
                },
            });
        }

        return await streamFile(filePath, contentType);
    } catch (error: unknown) {
        console.error("Media handler error:", error instanceof Error ? error.message : error);
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}

export async function HEAD(
    request: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
) {
    try {
        const { path: pathSegments } = await params;

        if (!pathSegments || pathSegments.length < 2) {
            return new NextResponse(null, { status: 400 });
        }

        const fileHash = pathSegments[0]?.trim();
        if (!fileHash) {
            return new NextResponse(null, { status: 400 });
        }

        const relativePath = getRelativePathFromSegments(pathSegments);
        const accessError = assertMediaAccess(request, fileHash, relativePath);
        if (accessError) {
            return accessError;
        }

        const filePath = await resolveMediaFilePath(fileHash, relativePath);
        if (!filePath) {
            return new NextResponse(null, { status: 404 });
        }

        const contentType = mime.getType(filePath) || "application/octet-stream";
        return new NextResponse(null, {
            headers: {
                "Content-Type": contentType,
                "Cache-Control": "private, max-age=300",
            },
        });
    } catch {
        return new NextResponse(null, { status: 500 });
    }
}

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import mime from "mime";
import { normalizeMarkdownMathForDisplay } from "@/lib/markdown-normalizer";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ path: string[] }> }
) {
    try {
        // Await params correctly in Next.js 15+
        const { path: pathSegments } = await params;

        if (!pathSegments || pathSegments.length === 0) {
            return new NextResponse("Invalid path", { status: 400 });
        }

        // pathSegments will be like ['fileHash', 'layout.pdf'] or ['fileHash', 'images', '001.jpg']
        // We map this to <repo>/uploads/fileHash/layout.pdf
        const uploadsRoot = path.join(process.cwd(), "uploads");
        let filePath = path.join(uploadsRoot, ...pathSegments);

        console.log(`[Media API] Request: ${pathSegments.join('/')}`);

        // Use resolve to normalize path
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(uploadsRoot)) {
            return new NextResponse("Access denied", { status: 403 });
        }

        if (!fs.existsSync(filePath)) {
            // Minimal Legacy Support: If original.pdf missing, try _origin.pdf
            // This handles files from before the Unified Strategy was deployed
            if (pathSegments[pathSegments.length - 1] === 'original.pdf') {
                const dir = path.dirname(filePath);
                if (fs.existsSync(dir)) {
                    const files = fs.readdirSync(dir);
                    const legacyOrigin = files.find(f => f.endsWith('_origin.pdf'));
                    if (legacyOrigin) {
                        filePath = path.join(dir, legacyOrigin);
                        console.log(`[Media API] Serving legacy origin: ${filePath}`);
                    } else {
                        return new NextResponse("File not found", { status: 404 });
                    }
                } else {
                    return new NextResponse("File not found", { status: 404 });
                }
            } else {
                return new NextResponse("File not found", { status: 404 });
            }
        }

        const stats = fs.statSync(filePath);
        const contentType = mime.getType(filePath) || "application/octet-stream";

        if (filePath.endsWith('.md')) {
            const markdown = fs.readFileSync(filePath, 'utf-8');
            const normalizedMarkdown = normalizeMarkdownMathForDisplay(markdown);

            return new NextResponse(normalizedMarkdown, {
                headers: {
                    "Content-Type": "text/markdown; charset=utf-8",
                    "Content-Length": Buffer.byteLength(normalizedMarkdown, 'utf-8').toString(),
                    "Cache-Control": "public, max-age=31536000, immutable",
                },
            });
        }

        // Use fs.createReadStream for better performance with large files (like PDFs)
        // But Next.js NextResponse body expects a BodyInit, which can be a stream.
        // Node.js readable streams need to be converted to Web Streams for NextResponse

        // Simpler approach for now: read file. For very large files, might want stream.
        const fileBuffer = fs.readFileSync(filePath);

        return new NextResponse(fileBuffer, {
            headers: {
                "Content-Type": contentType,
                "Content-Length": stats.size.toString(),
                // Cache control - cache effective for a while since hash-based paths are immutable-ish
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        });

    } catch (error: unknown) {
        console.error("Media handler error:", error);
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}

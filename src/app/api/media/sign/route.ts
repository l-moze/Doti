import { NextRequest, NextResponse } from "next/server";
import {
    buildMediaDeliveryUrl,
    buildRawMediaUrl,
    normalizeMediaRelativePath,
    requiresSignedMediaAccess,
} from "@/lib/media-access";
import { hasFileHashAccess } from "@/lib/media-session";

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const fileHash = searchParams.get("fileHash")?.trim();
        const relativePath = searchParams.get("path")?.trim();

        if (!fileHash || !relativePath) {
            return NextResponse.json({ error: "Missing fileHash or path" }, { status: 400 });
        }

        const normalizedPath = normalizeMediaRelativePath(relativePath);

        if (requiresSignedMediaAccess() && !hasFileHashAccess(request, fileHash)) {
            return NextResponse.json({ error: "Media access denied" }, { status: 403 });
        }

        return NextResponse.json({
            url: requiresSignedMediaAccess()
                ? buildMediaDeliveryUrl(fileHash, normalizedPath)
                : buildRawMediaUrl(fileHash, normalizedPath),
        });
    } catch (error: unknown) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to sign media URL" },
            { status: 500 }
        );
    }
}

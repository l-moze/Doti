import crypto from "crypto";
import type { NextRequest, NextResponse } from "next/server";
import { isPublicDeploymentMode } from "@/lib/media-access";

const MEDIA_ACCESS_COOKIE_NAME = "doti_media_access";
const MEDIA_ACCESS_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

type MediaAccessCookiePayload = {
    fileHashes: string[];
    updatedAt: number;
};

function getMediaAccessCookieSecret(): string {
    const secret = process.env.MEDIA_ACCESS_COOKIE_SECRET?.trim()
        || process.env.MEDIA_TOKEN_SECRET?.trim()
        || process.env.MEDIA_URL_SIGNING_SECRET?.trim()
        || process.env.NEXTAUTH_SECRET?.trim();

    if (!secret) {
        throw new Error("Media access cookie secret is missing");
    }

    return secret;
}

function signCookiePayload(serializedPayload: string): string {
    return crypto
        .createHmac("sha256", getMediaAccessCookieSecret())
        .update(serializedPayload)
        .digest("base64url");
}

function encodeCookiePayload(payload: MediaAccessCookiePayload): string {
    const serializedPayload = JSON.stringify(payload);
    return `${Buffer.from(serializedPayload).toString("base64url")}.${signCookiePayload(serializedPayload)}`;
}

function decodeCookiePayload(rawValue: string | undefined): MediaAccessCookiePayload | null {
    if (!rawValue) {
        return null;
    }

    const [encodedPayload, signature] = rawValue.split(".");
    if (!encodedPayload || !signature) {
        return null;
    }

    try {
        const serializedPayload = Buffer.from(encodedPayload, "base64url").toString("utf-8");
        const expectedSignature = Buffer.from(signCookiePayload(serializedPayload), "base64url");
        const actualSignature = Buffer.from(signature, "base64url");

        if (
            actualSignature.length !== expectedSignature.length ||
            !crypto.timingSafeEqual(actualSignature, expectedSignature)
        ) {
            return null;
        }

        return JSON.parse(serializedPayload) as MediaAccessCookiePayload;
    } catch {
        return null;
    }
}

export function getAccessibleFileHashes(request: NextRequest): Set<string> {
    const payload = decodeCookiePayload(request.cookies.get(MEDIA_ACCESS_COOKIE_NAME)?.value);
    return new Set(Array.isArray(payload?.fileHashes) ? payload.fileHashes.filter(Boolean) : []);
}

export function hasFileHashAccess(request: NextRequest, fileHash: string): boolean {
    if (!isPublicDeploymentMode()) {
        return true;
    }

    return getAccessibleFileHashes(request).has(fileHash);
}

export function grantFileHashAccess(
    request: NextRequest,
    response: NextResponse,
    fileHash: string
): void {
    if (!isPublicDeploymentMode()) {
        return;
    }

    const hashes = getAccessibleFileHashes(request);
    hashes.add(fileHash);

    response.cookies.set(MEDIA_ACCESS_COOKIE_NAME, encodeCookiePayload({
        fileHashes: Array.from(hashes).slice(-100),
        updatedAt: Date.now(),
    }), {
        httpOnly: true,
        sameSite: "lax",
        secure: isPublicDeploymentMode(),
        path: "/",
        maxAge: MEDIA_ACCESS_COOKIE_MAX_AGE_SECONDS,
    });
}

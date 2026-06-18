import crypto from "crypto";

const DEFAULT_MEDIA_TOKEN_TTL_SECONDS = 15 * 60;

function readBooleanEnv(name: string): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}

function base64UrlEncode(value: string | Buffer): string {
    return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
    return Buffer.from(value, "base64url").toString("utf-8");
}

function getMediaSigningSecret(): string {
    const secret = process.env.MEDIA_TOKEN_SECRET?.trim()
        || process.env.MEDIA_URL_SIGNING_SECRET?.trim()
        || process.env.NEXTAUTH_SECRET?.trim();

    if (!secret) {
        throw new Error("Media signing secret is missing");
    }

    return secret;
}

export function isPublicDeploymentMode(): boolean {
    return readBooleanEnv("PUBLIC_DEPLOYMENT");
}

export function requiresSignedMediaAccess(): boolean {
    return isPublicDeploymentMode();
}

export function getMediaTokenTtlSeconds(): number {
    const raw = Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS || "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MEDIA_TOKEN_TTL_SECONDS;
}

export function normalizeMediaRelativePath(value: string): string {
    const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!normalized) {
        throw new Error("Media path is empty");
    }

    const segments = normalized.split("/").filter(Boolean);
    if (segments.length === 0) {
        throw new Error("Media path is empty");
    }

    for (const segment of segments) {
        if (segment === "." || segment === "..") {
            throw new Error("Media path contains invalid traversal segment");
        }
    }

    return segments.join("/");
}

export function buildRawMediaUrl(fileHash: string, relativePath: string): string {
    const normalizedPath = normalizeMediaRelativePath(relativePath);
    const encodedPath = normalizedPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

    return `/api/media/${encodeURIComponent(fileHash)}/${encodedPath}`;
}

export function buildRawMediaPrefix(fileHash: string): string {
    return `/api/media/${encodeURIComponent(fileHash)}`;
}

type MediaTokenPayload = {
    fileHash: string;
    relativePath: string;
    expiresAt: number;
};

function signMediaTokenPayload(payload: MediaTokenPayload): string {
    const serializedPayload = JSON.stringify(payload);
    const signature = crypto
        .createHmac("sha256", getMediaSigningSecret())
        .update(serializedPayload)
        .digest("base64url");

    return `${base64UrlEncode(serializedPayload)}.${signature}`;
}

function parseMediaToken(token: string): MediaTokenPayload | null {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
        return null;
    }

    try {
        const serializedPayload = base64UrlDecode(encodedPayload);
        const expectedSignature = crypto
            .createHmac("sha256", getMediaSigningSecret())
            .update(serializedPayload)
            .digest();
        const actualSignature = Buffer.from(signature, "base64url");

        if (
            actualSignature.length !== expectedSignature.length ||
            !crypto.timingSafeEqual(actualSignature, expectedSignature)
        ) {
            return null;
        }

        return JSON.parse(serializedPayload) as MediaTokenPayload;
    } catch {
        return null;
    }
}

export function buildSignedMediaUrl(input: {
    fileHash: string;
    relativePath: string;
    expiresAt?: number;
    ttlSeconds?: number;
}): string {
    const normalizedPath = normalizeMediaRelativePath(input.relativePath);
    const expiresAt = input.expiresAt
        ?? (Date.now() + (input.ttlSeconds ?? getMediaTokenTtlSeconds()) * 1000);
    const token = signMediaTokenPayload({
        fileHash: input.fileHash,
        relativePath: normalizedPath,
        expiresAt,
    });
    const rawUrl = buildRawMediaUrl(input.fileHash, normalizedPath);
    const separator = rawUrl.includes("?") ? "&" : "?";

    return `${rawUrl}${separator}expires=${encodeURIComponent(String(expiresAt))}&token=${encodeURIComponent(token)}`;
}

export function buildMediaDeliveryUrl(fileHash: string, relativePath: string): string {
    if (!requiresSignedMediaAccess()) {
        return buildRawMediaUrl(fileHash, relativePath);
    }

    return buildSignedMediaUrl({
        fileHash,
        relativePath,
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeMediaPathComponent(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function signInternalMediaUrlsInMarkdown(markdown: string, fileHash: string): string {
    const mediaPrefixPattern = new RegExp(`/api/media/${escapeRegExp(fileHash)}/([^\\s)"'>?]+)`, "g");

    return markdown.replace(mediaPrefixPattern, (_match, encodedRelativePath) => {
        const relativePath = String(encodedRelativePath)
            .split("/")
            .map((segment) => decodeMediaPathComponent(segment))
            .join("/");

        return buildMediaDeliveryUrl(fileHash, relativePath);
    });
}

export function verifyMediaAccessToken(input: {
    fileHash: string;
    relativePath: string;
    token: string | null;
    expiresAt: string | null;
}): boolean {
    if (!input.token || !input.expiresAt) {
        return false;
    }

    const parsedExpiresAt = Number.parseInt(input.expiresAt, 10);
    if (!Number.isFinite(parsedExpiresAt) || parsedExpiresAt <= Date.now()) {
        return false;
    }

    const payload = parseMediaToken(input.token);
    if (!payload) {
        return false;
    }

    return (
        payload.fileHash === input.fileHash &&
        payload.relativePath === normalizeMediaRelativePath(input.relativePath) &&
        payload.expiresAt === parsedExpiresAt &&
        payload.expiresAt > Date.now()
    );
}

import path from "path";

export type RuntimePathEnv = Record<string, string | undefined>;

function resolveOverride(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? path.resolve(trimmed) : null;
}

export function getUploadsRoot(
    env: RuntimePathEnv = process.env,
    cwd = process.cwd()
): string {
    return resolveOverride(env.DESKTOP_UPLOADS_ROOT) ?? path.join(cwd, "uploads");
}

export function getCacheRoot(
    env: RuntimePathEnv = process.env,
    cwd = process.cwd()
): string {
    return resolveOverride(env.DESKTOP_CACHE_ROOT) ?? path.join(cwd, ".cache");
}

export function getPdfParseCacheDir(
    env: RuntimePathEnv = process.env,
    cwd = process.cwd()
): string {
    return path.join(getCacheRoot(env, cwd), "pdf-parse");
}

export function getConfigRoot(
    env: RuntimePathEnv = process.env,
    cwd = process.cwd()
): string {
    return resolveOverride(env.DESKTOP_CONFIG_ROOT) ?? path.join(getCacheRoot(env, cwd), "desktop-config");
}

export function getTermsRoot(
    env: RuntimePathEnv = process.env,
    cwd = process.cwd()
): string {
    return resolveOverride(env.DESKTOP_TERMS_ROOT) ?? path.join(cwd, "terms");
}

const FILE_HASH_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * File hashes are used as directory / cache file names, so they must never
 * contain path separators or traversal segments.
 */
export function isSafeFileHash(value: string | null | undefined): boolean {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") {
        return false;
    }

    return FILE_HASH_PATTERN.test(trimmed);
}

export function assertSafeFileHash(value: string | null | undefined): string {
    if (!isSafeFileHash(value)) {
        throw new Error("Invalid file hash");
    }

    return (value as string).trim();
}

export function resolveUploadDir(
    fileHash: string,
    env: RuntimePathEnv = process.env,
    cwd = process.cwd()
): string | null {
    const trimmedHash = fileHash.trim();
    if (!isSafeFileHash(trimmedHash)) {
        return null;
    }

    const uploadsRoot = path.resolve(getUploadsRoot(env, cwd));
    const uploadDir = path.resolve(uploadsRoot, trimmedHash);

    if (uploadDir === uploadsRoot || !uploadDir.startsWith(`${uploadsRoot}${path.sep}`)) {
        return null;
    }

    return uploadDir;
}

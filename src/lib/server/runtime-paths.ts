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

export function resolveUploadDir(
    fileHash: string,
    env: RuntimePathEnv = process.env,
    cwd = process.cwd()
): string | null {
    const trimmedHash = fileHash.trim();
    if (!trimmedHash) {
        return null;
    }

    const uploadsRoot = path.resolve(getUploadsRoot(env, cwd));
    const uploadDir = path.resolve(uploadsRoot, trimmedHash);

    if (uploadDir === uploadsRoot || !uploadDir.startsWith(`${uploadsRoot}${path.sep}`)) {
        return null;
    }

    return uploadDir;
}

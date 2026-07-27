import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import { getUploadsRoot } from "@/lib/server/runtime-paths";

export interface UploadArtifactPaths {
    contentListRelativePath: string | null;
    layoutJsonRelativePath: string | null;
    layoutPdfRelativePath: string | null;
    markdownRelativePath: string | null;
}

function compareRelativePaths(a: string, b: string): number {
    const depthDiff = a.split("/").length - b.split("/").length;
    if (depthDiff !== 0) return depthDiff;

    const lengthDiff = a.length - b.length;
    if (lengthDiff !== 0) return lengthDiff;

    return a.localeCompare(b);
}

async function walkRelativeFiles(
    rootDir: string,
    onFile: (relativePath: string, fileName: string) => void
): Promise<void> {
    const walk = async (currentDir: string): Promise<void> => {
        const entries = await readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const absolutePath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                await walk(absolutePath);
                continue;
            }

            const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
            onFile(relativePath, entry.name);
        }
    };

    await walk(rootDir);
}

export function resolveUploadDir(fileHash: string): string | null {
    const uploadsRoot = path.resolve(getUploadsRoot());
    const uploadDir = path.resolve(uploadsRoot, fileHash);

    if (uploadDir === uploadsRoot || !uploadDir.startsWith(`${uploadsRoot}${path.sep}`)) {
        return null;
    }

    return uploadDir;
}

export async function directoryExists(filePath: string): Promise<boolean> {
    try {
        return (await stat(filePath)).isDirectory();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
            throw error;
        }
        return false;
    }
}

export async function findPreferredRelativeFilePath(
    rootDir: string,
    matcher: (relativePath: string, fileName: string) => boolean
): Promise<string | null> {
    if (!(await directoryExists(rootDir))) {
        return null;
    }

    const matches: string[] = [];

    await walkRelativeFiles(rootDir, (relativePath, fileName) => {
        if (matcher(relativePath, fileName)) {
            matches.push(relativePath);
        }
    });

    matches.sort(compareRelativePaths);
    return matches[0] ?? null;
}

export async function findUploadArtifactPaths(rootDir: string): Promise<UploadArtifactPaths> {
    if (!(await directoryExists(rootDir))) {
        return {
            contentListRelativePath: null,
            layoutJsonRelativePath: null,
            layoutPdfRelativePath: null,
            markdownRelativePath: null,
        };
    }

    const matches = {
        contentListRelativePaths: [] as string[],
        layoutJsonRelativePaths: [] as string[],
        layoutPdfRelativePaths: [] as string[],
        markdownRelativePaths: [] as string[],
    };

    await walkRelativeFiles(rootDir, (relativePath, fileName) => {
        if (fileName === "content_list_v2.json" || relativePath.endsWith("/content_list_v2.json")) {
            matches.contentListRelativePaths.push(relativePath);
        }

        if (fileName === "layout.json" || relativePath.endsWith("/layout.json")) {
            matches.layoutJsonRelativePaths.push(relativePath);
        }

        if (
            fileName === "layout.pdf" ||
            fileName.endsWith("_layout.pdf") ||
            relativePath.endsWith("/layout.pdf")
        ) {
            matches.layoutPdfRelativePaths.push(relativePath);
        }

        if (fileName === "full.md" || relativePath.endsWith("/full.md")) {
            matches.markdownRelativePaths.push(relativePath);
        }
    });

    return {
        contentListRelativePath: matches.contentListRelativePaths.sort(compareRelativePaths)[0] ?? null,
        layoutJsonRelativePath: matches.layoutJsonRelativePaths.sort(compareRelativePaths)[0] ?? null,
        layoutPdfRelativePath: matches.layoutPdfRelativePaths.sort(compareRelativePaths)[0] ?? null,
        markdownRelativePath: matches.markdownRelativePaths.sort(compareRelativePaths)[0] ?? null,
    };
}

export async function readJsonFileIfExists<T = unknown>(filePath: string | null): Promise<T | null> {
    if (!filePath) return null;

    try {
        return JSON.parse(await readFile(filePath, "utf-8")) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }

        console.warn("[upload-artifacts] Failed to parse JSON:", filePath, error);
        return null;
    }
}

export async function readTextFileIfExists(filePath: string | null): Promise<string> {
    if (!filePath) return "";

    try {
        return await readFile(filePath, "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "";
        }

        console.warn("[upload-artifacts] Failed to read text:", filePath, error);
        return "";
    }
}

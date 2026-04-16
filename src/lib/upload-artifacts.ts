import fs from "fs";
import path from "path";

function compareRelativePaths(a: string, b: string): number {
    const depthDiff = a.split("/").length - b.split("/").length;
    if (depthDiff !== 0) return depthDiff;

    const lengthDiff = a.length - b.length;
    if (lengthDiff !== 0) return lengthDiff;

    return a.localeCompare(b);
}

export function findPreferredRelativeFilePath(
    rootDir: string,
    matcher: (relativePath: string, fileName: string) => boolean
): string | null {
    if (!fs.existsSync(rootDir)) return null;

    const matches: string[] = [];

    const walk = (currentDir: string) => {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const absolutePath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                walk(absolutePath);
                continue;
            }

            const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
            if (matcher(relativePath, entry.name)) {
                matches.push(relativePath);
            }
        }
    };

    walk(rootDir);
    matches.sort(compareRelativePaths);
    return matches[0] ?? null;
}

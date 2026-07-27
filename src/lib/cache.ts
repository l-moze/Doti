import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { getPdfParseCacheDir } from "@/lib/server/runtime-paths";

const getCacheDir = () => getPdfParseCacheDir();

/**
 * 确保缓存目录存在
 */
async function ensureCacheDir(): Promise<void> {
    // recursive mkdir 对已存在目录不会抛错，其余错误（权限、磁盘）必须向上传递
    await fs.mkdir(getCacheDir(), { recursive: true });
}

function isMissingEntryError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * 计算文件内容的 SHA256 哈希值作为缓存键
 */
export function computeFileHash(buffer: ArrayBuffer | Buffer): string {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * 获取缓存文件路径
 */
function getCachePath(hash: string): string {
    return path.join(getCacheDir(), `${hash}.md`);
}

/**
 * 获取缓存元数据文件路径
 */
function getMetaPath(hash: string): string {
    return path.join(getCacheDir(), `${hash}.meta.json`);
}

/**
 * 缓存元数据接口
 */
interface CacheMeta {
    originalFilename: string;
    hash: string;
    createdAt: string;
    batchId?: string;
}

/**
 * 检查缓存是否存在
 */
export async function hasCache(hash: string): Promise<boolean> {
    try {
        await fs.access(getCachePath(hash));
        return true;
    } catch (error) {
        if (!isMissingEntryError(error)) {
            throw error;
        }
        return false;
    }
}

/**
 * 从缓存读取 Markdown 内容
 */
export async function getCache(hash: string): Promise<string | null> {
    try {
        const content = await fs.readFile(getCachePath(hash), "utf-8");
        return content;
    } catch (error) {
        if (!isMissingEntryError(error)) {
            throw error;
        }
        return null;
    }
}

/**
 * 将 Markdown 内容保存到缓存
 */
export async function setCache(
    hash: string,
    markdown: string,
    originalFilename: string,
    batchId?: string
): Promise<void> {
    await ensureCacheDir();

    // 保存 Markdown 内容
    await fs.writeFile(getCachePath(hash), markdown, "utf-8");

    // 保存元数据
    const meta: CacheMeta = {
        originalFilename,
        hash,
        createdAt: new Date().toISOString(),
        batchId,
    };
    await fs.writeFile(getMetaPath(hash), JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * 获取缓存元数据
 */
export async function getCacheMeta(hash: string): Promise<CacheMeta | null> {
    try {
        const content = await fs.readFile(getMetaPath(hash), "utf-8");
        return JSON.parse(content);
    } catch (error) {
        if (!isMissingEntryError(error)) {
            console.error("[Cache] Failed to read cache metadata:", hash, error);
        }
        return null;
    }
}

/**
 * 列出所有缓存文件
 */
export async function listAllCaches(): Promise<CacheMeta[]> {
    try {
        await ensureCacheDir();
        const cacheDir = getCacheDir();
        const files = await fs.readdir(cacheDir);
        const metaFiles = files.filter(f => f.endsWith(".meta.json"));

        const metas: CacheMeta[] = [];
        for (const file of metaFiles) {
            try {
                const content = await fs.readFile(path.join(cacheDir, file), "utf-8");
                metas.push(JSON.parse(content));
            } catch (error) {
                // 跳过损坏的元数据文件，但记录原因
                console.warn("[Cache] Skipped unreadable cache metadata:", file, error);
            }
        }
        return metas;
    } catch (error) {
        if (!isMissingEntryError(error)) {
            throw error;
        }
        return [];
    }
}

/**
 * 清除指定缓存
 */
export async function deleteCache(hash: string): Promise<void> {
    await Promise.all([getCachePath(hash), getMetaPath(hash)].map(async (filePath) => {
        try {
            await fs.unlink(filePath);
        } catch (error) {
            // 文件不存在时视为已删除，其余错误向上传递
            if (!isMissingEntryError(error)) {
                throw error;
            }
        }
    }));
}

/**
 * 清除所有缓存
 */
export async function clearAllCaches(): Promise<void> {
    // force: true 已忽略“目录不存在”，删除失败必须让调用方知道
    await fs.rm(getCacheDir(), { recursive: true, force: true });
    await ensureCacheDir();
}

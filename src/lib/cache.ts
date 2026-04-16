import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

// 缓存目录（项目根目录下的 .cache 文件夹）
const CACHE_DIR = path.join(process.cwd(), ".cache", "pdf-parse");

/**
 * 确保缓存目录存在
 */
async function ensureCacheDir(): Promise<void> {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch {
        // 目录已存在，忽略错误
    }
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
    return path.join(CACHE_DIR, `${hash}.md`);
}

/**
 * 获取缓存元数据文件路径
 */
function getMetaPath(hash: string): string {
    return path.join(CACHE_DIR, `${hash}.meta.json`);
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
    } catch {
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
    } catch {
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
    } catch {
        return null;
    }
}

/**
 * 列出所有缓存文件
 */
export async function listAllCaches(): Promise<CacheMeta[]> {
    try {
        await ensureCacheDir();
        const files = await fs.readdir(CACHE_DIR);
        const metaFiles = files.filter(f => f.endsWith(".meta.json"));

        const metas: CacheMeta[] = [];
        for (const file of metaFiles) {
            try {
                const content = await fs.readFile(path.join(CACHE_DIR, file), "utf-8");
                metas.push(JSON.parse(content));
            } catch {
                // 跳过损坏的元数据文件
            }
        }
        return metas;
    } catch {
        return [];
    }
}

/**
 * 清除指定缓存
 */
export async function deleteCache(hash: string): Promise<void> {
    try {
        await fs.unlink(getCachePath(hash));
        await fs.unlink(getMetaPath(hash));
    } catch {
        // 文件不存在，忽略
    }
}

/**
 * 清除所有缓存
 */
export async function clearAllCaches(): Promise<void> {
    try {
        await fs.rm(CACHE_DIR, { recursive: true, force: true });
        await ensureCacheDir();
    } catch {
        // 目录不存在或删除失败，忽略
    }
}

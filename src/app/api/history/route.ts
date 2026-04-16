import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { findPreferredRelativeFilePath } from "@/lib/upload-artifacts";

/**
 * 历史记录项接口（与前端 HistoryItem 对应）
 */
interface HistoryItem {
    fileHash: string;
    fileName: string;
    status: 'idle' | 'uploading' | 'parsing' | 'parsed' | 'translating' | 'completed' | 'error';
    progress: number;
    updatedAt: number;
    targetLang?: string;
    layoutUrl?: string | null;
    layoutJsonUrl?: string | null;
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
 * GET /api/history
 * 
 * 通过扫描文件系统返回历史记录列表。
 * 
 * 状态推断规则：
 * - uploads/[hash]/translation-*.md 存在 → completed
 * - uploads/[hash]/full.md 存在 → parsed
 * - 目录存在但无 full.md → parsing（可能中断）
 */
export async function GET() {
    try {
        const uploadsDir = path.join(process.cwd(), 'uploads');
        const cacheDir = path.join(process.cwd(), '.cache', 'pdf-parse');

        // 检查 uploads 目录是否存在
        try {
            await fs.access(uploadsDir);
        } catch {
            // uploads 目录不存在，返回空列表
            return NextResponse.json([]);
        }

        // 获取所有 fileHash 目录
        const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
        const hashDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

        const historyItems: HistoryItem[] = [];

        for (const fileHash of hashDirs) {
            const uploadPath = path.join(uploadsDir, fileHash);
            const metaPath = path.join(cacheDir, `${fileHash}.meta.json`);

            // 读取元数据获取文件名和创建时间
            let fileName = 'Unknown.pdf';
            let createdAt = Date.now();

            try {
                const metaContent = await fs.readFile(metaPath, 'utf-8');
                const meta: CacheMeta = JSON.parse(metaContent);
                fileName = meta.originalFilename || fileName;
                createdAt = new Date(meta.createdAt).getTime();
            } catch {
                // 元数据文件不存在，尝试从目录内容推断
                // 或者使用目录修改时间
                try {
                    const stat = await fs.stat(uploadPath);
                    createdAt = stat.mtimeMs;
                } catch {
                    // 忽略
                }
            }

            // 检查目录内容推断状态
            let status: HistoryItem['status'] = 'parsing';
            let progress = 30;
            let targetLang: string | undefined;
            let layoutUrl: string | null = null;
            let layoutJsonUrl: string | null = null;

            try {
                const files = await fs.readdir(uploadPath);

                // 检查是否有完成的翻译文件
                // 注意：translation-Chinese.partial.md 是部分翻译，不算完成
                // 只有 translation-Chinese.md（不含 .partial）才算完成
                const completedTranslationFile = files.find(f => {
                    // 匹配 translation-*.md 但排除 translation-*.partial.md
                    return f.startsWith('translation-') &&
                        f.endsWith('.md') &&
                        !f.includes('.partial.');
                });

                // 检查是否有部分翻译文件（可恢复的翻译）
                const partialTranslationFile = files.find(f =>
                    f.startsWith('translation-') && f.includes('.partial.md')
                );

                if (completedTranslationFile) {
                    status = 'completed';
                    progress = 100;
                    // 提取目标语言，例如 translation-Chinese.md → Chinese
                    const match = completedTranslationFile.match(/^translation-(.+)\.md$/);
                    if (match) {
                        targetLang = match[1];
                    }
                } else if (partialTranslationFile) {
                    // 有部分翻译，状态为已解析（可以继续翻译）
                    status = 'parsed';
                    progress = 60;
                    // 提取目标语言
                    const match = partialTranslationFile.match(/^translation-(.+)\.partial\.md$/);
                    if (match) {
                        targetLang = match[1];
                    }
                } else if (files.includes('full.md')) {
                    // 有源 Markdown 但无翻译
                    status = 'parsed';
                    progress = 60;
                }

                const nestedLayoutJsonPath = findPreferredRelativeFilePath(
                    uploadPath,
                    (relativePath, fileNameInDir) =>
                        fileNameInDir === "layout.json" || relativePath.endsWith("/layout.json")
                );
                const nestedLayoutPdfPath = findPreferredRelativeFilePath(
                    uploadPath,
                    (relativePath, fileNameInDir) =>
                        fileNameInDir === "layout.pdf" ||
                        fileNameInDir.endsWith("_layout.pdf") ||
                        relativePath.endsWith("/layout.pdf")
                );

                layoutJsonUrl = nestedLayoutJsonPath ? `/api/media/${fileHash}/${nestedLayoutJsonPath}` : null;
                layoutUrl = nestedLayoutPdfPath ? `/api/media/${fileHash}/${nestedLayoutPdfPath}` : null;
                // 否则保持 parsing 状态（可能是中断的任务）
            } catch {
                // 无法读取目录，标记为错误
                status = 'error';
                progress = 0;
            }

            historyItems.push({
                fileHash,
                fileName,
                status,
                progress,
                updatedAt: createdAt,
                targetLang,
                layoutUrl,
                layoutJsonUrl,
            });
        }

        // 按更新时间降序排序（最新的在前）
        historyItems.sort((a, b) => b.updatedAt - a.updatedAt);

        return NextResponse.json(historyItems);

    } catch (error: unknown) {
        console.error("[History API] Error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to load history" },
            { status: 500 }
        );
    }
}

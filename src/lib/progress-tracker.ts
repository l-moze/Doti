import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * 翻译进度信息
 */
export interface TranslationProgress {
    version: string;
    targetLang: string;
    totalChunks: number;
    completedChunks: number;
    timestamp: string;
    sourceHash?: string; // MD5 hash of source markdown to detect changes
    chunks: ChunkProgress[];
}

export interface ChunkProgress {
    index: number;
    length: number;
    completed: boolean;
}

/**
 * 进度跟踪器 - 管理翻译断点续传
 */
export class ProgressTracker {
    private fileHash: string;
    private targetLang: string;
    private uploadsRoot: string;
    private fileDir: string;
    private progressPath: string;
    private partialCachePath: string;
    private finalCachePath: string;

    constructor(fileHash: string, targetLang: string) {
        this.fileHash = fileHash;
        this.targetLang = targetLang;
        this.uploadsRoot = path.join(process.cwd(), 'uploads');
        this.fileDir = path.join(this.uploadsRoot, fileHash);
        this.progressPath = path.join(this.fileDir, `translation-${targetLang}.progress.json`);
        this.partialCachePath = path.join(this.fileDir, `translation-${targetLang}.partial.md`);
        this.finalCachePath = path.join(this.fileDir, `translation-${targetLang}.md`);
    }

    /**
     * 检查是否存在完整缓存
     */
    hasFullCache(): boolean {
        return fs.existsSync(this.finalCachePath);
    }

    /**
     * 读取完整缓存
     */
    readFullCache(): string | null {
        if (this.hasFullCache()) {
            return fs.readFileSync(this.finalCachePath, 'utf-8');
        }
        return null;
    }

    /**
     * 检查是否存在部分翻译
     */
    hasPartialCache(): boolean {
        return fs.existsSync(this.progressPath) && fs.existsSync(this.partialCachePath);
    }

    /**
     * 读取进度信息
     */
    readProgress(): TranslationProgress | null {
        if (!fs.existsSync(this.progressPath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(this.progressPath, 'utf-8');
            return JSON.parse(content) as TranslationProgress;
        } catch (e) {
            console.error('[ProgressTracker] Failed to read progress file:', e);
            return null;
        }
    }

    /**
     * 读取部分缓存内容
     */
    readPartialCache(): string | null {
        if (!fs.existsSync(this.partialCachePath)) {
            return null;
        }
        return fs.readFileSync(this.partialCachePath, 'utf-8');
    }

    /**
     * 计算源Markdown的hash,用于检测内容变化
     */
    computeSourceHash(sourceMarkdown: string): string {
        return crypto.createHash('md5').update(sourceMarkdown).digest('hex');
    }

    /**
     * 验证部分缓存是否有效
     * @param sourceMarkdown 当前源Markdown
     * @returns true if valid, false if invalid or outdated
     */
    validatePartialCache(sourceMarkdown: string): boolean {
        const progress = this.readProgress();
        if (!progress) return false;

        // 检查源文件是否改变
        const currentHash = this.computeSourceHash(sourceMarkdown);
        if (progress.sourceHash && progress.sourceHash !== currentHash) {
            console.log('[ProgressTracker] Source markdown changed, invalidating cache');
            return false;
        }

        // 检查语言是否匹配
        if (progress.targetLang !== this.targetLang) {
            console.log('[ProgressTracker] Target language mismatch');
            return false;
        }

        return true;
    }

    /**
     * 初始化新的进度跟踪
     */
    initProgress(totalChunks: number, sourceMarkdown: string): void {
        const progress: TranslationProgress = {
            version: '1.0',
            targetLang: this.targetLang,
            totalChunks,
            completedChunks: 0,
            timestamp: new Date().toISOString(),
            sourceHash: this.computeSourceHash(sourceMarkdown),
            chunks: Array.from({ length: totalChunks }, (_, i) => ({
                index: i,
                length: 0,
                completed: false
            }))
        };

        // 确保目录存在
        if (!fs.existsSync(this.fileDir)) {
            fs.mkdirSync(this.fileDir, { recursive: true });
        }

        // 写入进度文件
        fs.writeFileSync(this.progressPath, JSON.stringify(progress, null, 2));

        // 创建空的部分缓存文件
        fs.writeFileSync(this.partialCachePath, '');

        console.log(`[ProgressTracker] Initialized progress for ${totalChunks} chunks`);
    }

    /**
     * 追加chunk到部分缓存
     */
    appendChunk(chunkIndex: number, content: string, isFirst: boolean): void {
        // 添加分隔符(第一个chunk不需要)
        const separator = isFirst ? '' : '\n\n';
        const contentToAppend = separator + content;

        fs.appendFileSync(this.partialCachePath, contentToAppend);

        // 更新进度
        this.updateProgress(chunkIndex, content.length);
    }

    /**
     * 更新进度信息
     */
    private updateProgress(chunkIndex: number, chunkLength: number): void {
        const progress = this.readProgress();
        if (!progress) {
            console.error('[ProgressTracker] Progress file not found');
            return;
        }

        // 更新chunk状态
        if (chunkIndex < progress.chunks.length) {
            progress.chunks[chunkIndex].completed = true;
            progress.chunks[chunkIndex].length = chunkLength;
        }

        // 更新完成数量
        progress.completedChunks = progress.chunks.filter(c => c.completed).length;
        progress.timestamp = new Date().toISOString();

        // 写入更新后的进度
        fs.writeFileSync(this.progressPath, JSON.stringify(progress, null, 2));
    }

    /**
     * 完成翻译,将部分缓存转为最终缓存
     */
    finalize(): void {
        if (!fs.existsSync(this.partialCachePath)) {
            console.error('[ProgressTracker] Partial cache not found');
            return;
        }

        // 重命名部分缓存为最终缓存
        fs.renameSync(this.partialCachePath, this.finalCachePath);

        // 删除进度文件
        if (fs.existsSync(this.progressPath)) {
            fs.unlinkSync(this.progressPath);
        }

        console.log('[ProgressTracker] Translation finalized');
    }

    /**
     * 清理部分缓存和进度文件(用于重新开始)
     */
    cleanup(): void {
        if (fs.existsSync(this.progressPath)) {
            fs.unlinkSync(this.progressPath);
        }
        if (fs.existsSync(this.partialCachePath)) {
            fs.unlinkSync(this.partialCachePath);
        }
        console.log('[ProgressTracker] Cleaned up partial cache and progress');
    }

    /**
     * 清理所有翻译缓存, 包括最终译文
     */
    reset(): void {
        this.cleanup();
        if (fs.existsSync(this.finalCachePath)) {
            fs.unlinkSync(this.finalCachePath);
        }
        console.log('[ProgressTracker] Reset full translation cache');
    }
}

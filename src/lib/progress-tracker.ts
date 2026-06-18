import {
    access,
    appendFile,
    mkdir,
    readFile,
    readdir,
    rename,
    unlink,
    writeFile,
} from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
    buildTranslationArtifactBaseName,
    buildTranslationCacheKey,
    type TranslationCacheKeyInput,
} from "@/lib/translation-cache-key";
import { getUploadsRoot } from "@/lib/server/runtime-paths";

const ACTIVE_TRANSLATION_JOB_STALE_MS = 15 * 60 * 1000;

/**
 * 翻译进度信息
 */
export interface TranslationProgress {
    version: string;
    cacheKey: string;
    jobId?: string;
    partialFileName?: string;
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

export interface ActiveTranslationJob {
    jobId: string;
    cacheKey: string;
    targetLang: string;
    status: "active";
    createdAt: string;
    updatedAt: string;
    heartbeatAt: string;
}

export interface AcquireActiveJobResult {
    acquired: boolean;
    activeJob?: ActiveTranslationJob;
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function removePathIfExists(filePath: string): Promise<void> {
    try {
        await unlink(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
}

/**
 * 进度跟踪器 - 管理翻译断点续传与本地文件锁
 */
export class ProgressTracker {
    private fileHash: string;
    private cacheKey: string;
    private targetLang: string;
    private uploadsRoot: string;
    private fileDir: string;
    private artifactBaseName: string;
    private activeJobPath: string;
    private progressPath: string;
    private finalCachePath: string;
    private currentJobId: string | null;

    constructor(cacheIdentity: TranslationCacheKeyInput, jobId?: string) {
        this.fileHash = cacheIdentity.fileHash;
        this.cacheKey = buildTranslationCacheKey(cacheIdentity);
        this.targetLang = cacheIdentity.targetLang;
        this.currentJobId = jobId || null;
        this.uploadsRoot = getUploadsRoot();
        this.fileDir = path.join(this.uploadsRoot, cacheIdentity.fileHash);
        this.artifactBaseName = buildTranslationArtifactBaseName(cacheIdentity);
        this.activeJobPath = path.join(this.fileDir, `${this.artifactBaseName}.active-job.json`);
        this.progressPath = path.join(this.fileDir, `${this.artifactBaseName}.progress.json`);
        this.finalCachePath = path.join(this.fileDir, `${this.artifactBaseName}.md`);
    }

    bindJob(jobId: string): void {
        this.currentJobId = jobId;
    }

    getJobId(): string | null {
        return this.currentJobId;
    }

    getCacheKey(): string {
        return this.cacheKey;
    }

    /**
     * 检查是否存在完整缓存
     */
    async hasFullCache(): Promise<boolean> {
        return pathExists(this.finalCachePath);
    }

    /**
     * 读取完整缓存
     */
    async readFullCache(): Promise<string | null> {
        try {
            return await readFile(this.finalCachePath, "utf-8");
        } catch {
            return null;
        }
    }

    async readActiveJob(options?: { pruneStale?: boolean }): Promise<ActiveTranslationJob | null> {
        const pruneStale = options?.pruneStale !== false;

        try {
            const content = await readFile(this.activeJobPath, "utf-8");
            const job = JSON.parse(content) as ActiveTranslationJob;

            if (!job.jobId || job.cacheKey !== this.cacheKey || job.targetLang !== this.targetLang) {
                if (pruneStale) {
                    await removePathIfExists(this.activeJobPath);
                }
                return null;
            }

            if (pruneStale && this.isActiveJobStale(job)) {
                await removePathIfExists(this.activeJobPath);
                return null;
            }

            return job;
        } catch (error) {
            const errno = (error as NodeJS.ErrnoException).code;
            if (errno === "ENOENT") {
                return null;
            }

            console.error("[ProgressTracker] Failed to read active job file:", error);
            if (pruneStale) {
                await removePathIfExists(this.activeJobPath);
            }
            return null;
        }
    }

    async acquireActiveJob(jobId: string): Promise<AcquireActiveJobResult> {
        await mkdir(this.fileDir, { recursive: true });

        const activeJob = this.createActiveJob(jobId);

        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await writeFile(
                    this.activeJobPath,
                    JSON.stringify(activeJob, null, 2),
                    { flag: "wx" }
                );
                this.bindJob(jobId);
                return { acquired: true };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw error;
                }

                const currentActiveJob = await this.readActiveJob({ pruneStale: true });
                if (currentActiveJob) {
                    return {
                        acquired: false,
                        activeJob: currentActiveJob,
                    };
                }

                await removePathIfExists(this.activeJobPath);
            }
        }

        return {
            acquired: false,
            activeJob: await this.readActiveJob({ pruneStale: false }) || undefined,
        };
    }

    async releaseActiveJob(): Promise<void> {
        if (!this.currentJobId) {
            return;
        }

        const activeJob = await this.readActiveJob({ pruneStale: false });
        if (!activeJob || activeJob.jobId !== this.currentJobId) {
            this.currentJobId = null;
            return;
        }

        await removePathIfExists(this.activeJobPath);
        this.currentJobId = null;
    }

    /**
     * 检查是否存在部分翻译
     */
    async hasPartialCache(): Promise<boolean> {
        const progress = await this.readProgress();
        if (!progress) return false;

        if (this.currentJobId && progress.jobId && progress.jobId !== this.currentJobId) {
            return false;
        }

        const partialCachePath = await this.resolvePartialCachePath(progress);
        return Boolean(partialCachePath && await pathExists(partialCachePath));
    }

    /**
     * 读取进度信息
     */
    async readProgress(): Promise<TranslationProgress | null> {
        try {
            const content = await readFile(this.progressPath, "utf-8");
            return JSON.parse(content) as TranslationProgress;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                console.error("[ProgressTracker] Failed to read progress file:", error);
            }
            return null;
        }
    }

    /**
     * 读取部分缓存内容
     */
    async readPartialCache(): Promise<string | null> {
        const progress = await this.readProgress();
        if (!progress) return null;

        if (this.currentJobId && progress.jobId && progress.jobId !== this.currentJobId) {
            return null;
        }

        const partialCachePath = await this.resolvePartialCachePath(progress);
        if (!partialCachePath) return null;

        try {
            return await readFile(partialCachePath, "utf-8");
        } catch {
            return null;
        }
    }

    /**
     * 计算源Markdown的hash,用于检测内容变化
     */
    computeSourceHash(sourceMarkdown: string): string {
        return crypto.createHash("md5").update(sourceMarkdown).digest("hex");
    }

    /**
     * 验证部分缓存是否有效
     * @param sourceMarkdown 当前源Markdown
     * @returns true if valid, false if invalid or outdated
     */
    async validatePartialCache(sourceMarkdown: string): Promise<boolean> {
        const progress = await this.readProgress();
        if (!progress) return false;

        if (progress.cacheKey !== this.cacheKey) {
            console.log("[ProgressTracker] Cache key mismatch");
            return false;
        }

        if (!progress.jobId) {
            console.log("[ProgressTracker] Legacy progress without jobId is not resumable");
            return false;
        }

        if (this.currentJobId && progress.jobId !== this.currentJobId) {
            console.log("[ProgressTracker] Job ID mismatch");
            return false;
        }

        // 检查源文件是否改变
        const currentHash = this.computeSourceHash(sourceMarkdown);
        if (progress.sourceHash && progress.sourceHash !== currentHash) {
            console.log("[ProgressTracker] Source markdown changed, invalidating cache");
            return false;
        }

        // 检查语言是否匹配
        if (progress.targetLang !== this.targetLang) {
            console.log("[ProgressTracker] Target language mismatch");
            return false;
        }

        const partialCachePath = await this.resolvePartialCachePath(progress);
        if (!partialCachePath || !(await pathExists(partialCachePath))) {
            console.log("[ProgressTracker] Partial cache file missing");
            return false;
        }

        return true;
    }

    /**
     * 初始化新的进度跟踪
     */
    async initProgress(totalChunks: number, sourceMarkdown: string): Promise<void> {
        const jobId = this.requireJobId();
        const partialFileName = this.buildPartialFileName(jobId);
        const progress: TranslationProgress = {
            version: "3.0",
            cacheKey: this.cacheKey,
            jobId,
            partialFileName,
            targetLang: this.targetLang,
            totalChunks,
            completedChunks: 0,
            timestamp: new Date().toISOString(),
            sourceHash: this.computeSourceHash(sourceMarkdown),
            chunks: Array.from({ length: totalChunks }, (_, i) => ({
                index: i,
                length: 0,
                completed: false,
            })),
        };

        await this.assertJobOwnership();
        await mkdir(this.fileDir, { recursive: true });
        await writeFile(this.progressPath, JSON.stringify(progress, null, 2));
        await writeFile(this.buildPartialCachePath(jobId), "");
        await this.touchActiveJob();

        console.log(`[ProgressTracker] Initialized progress for ${totalChunks} chunks (job ${jobId})`);
    }

    /**
     * 追加chunk到部分缓存
     */
    async appendChunk(chunkIndex: number, content: string, isFirst: boolean): Promise<void> {
        const jobId = this.requireJobId();
        await this.assertJobOwnership();

        const progress = await this.readProgress();
        if (!progress || progress.jobId !== jobId) {
            throw new Error("[ProgressTracker] Progress file missing or bound to another job");
        }

        const partialCachePath = await this.resolvePartialCachePath(progress);
        if (!partialCachePath) {
            throw new Error("[ProgressTracker] Partial cache path is unavailable");
        }

        const separator = isFirst ? "" : "\n\n";
        const contentToAppend = separator + content;

        await appendFile(partialCachePath, contentToAppend);
        await this.updateProgress(progress, chunkIndex, content.length);
    }

    /**
     * 完成翻译,将部分缓存转为最终缓存
     */
    async finalize(): Promise<void> {
        const jobId = this.requireJobId();
        await this.assertJobOwnership();

        const progress = await this.readProgress();
        if (!progress || progress.jobId !== jobId) {
            throw new Error("[ProgressTracker] Progress file missing or bound to another job");
        }

        if (progress.completedChunks < progress.totalChunks) {
            throw new Error("[ProgressTracker] Translation is incomplete and cannot be finalized");
        }

        const partialCachePath = await this.resolvePartialCachePath(progress);
        if (!partialCachePath || !(await pathExists(partialCachePath))) {
            throw new Error("[ProgressTracker] Partial cache not found");
        }

        const partialContent = await readFile(partialCachePath, "utf-8");
        const tempFinalPath = this.buildTempFinalCachePath(jobId);

        try {
            await writeFile(tempFinalPath, partialContent, "utf-8");
            const verifiedContent = await readFile(tempFinalPath, "utf-8");
            if (verifiedContent !== partialContent) {
                throw new Error("[ProgressTracker] Final cache integrity check failed");
            }

            if (await pathExists(this.finalCachePath)) {
                await removePathIfExists(this.finalCachePath);
            }

            await rename(tempFinalPath, this.finalCachePath);
            await removePathIfExists(this.progressPath);
            await removePathIfExists(partialCachePath);

            console.log(`[ProgressTracker] Translation finalized for job ${jobId}`);
        } finally {
            await removePathIfExists(tempFinalPath);
        }
    }

    /**
     * 清理当前进度缓存(用于重新开始)
     */
    async cleanup(): Promise<void> {
        const activeJob = await this.readActiveJob({ pruneStale: false });
        const progress = await this.readProgress();
        const partialCachePath = progress ? await this.resolvePartialCachePath(progress) : null;
        const canMutateCacheFiles = !activeJob || !this.currentJobId || activeJob.jobId === this.currentJobId;

        if (progress && canMutateCacheFiles) {
            await removePathIfExists(this.progressPath);
            if (partialCachePath) {
                await removePathIfExists(partialCachePath);
            }
        }

        await this.releaseActiveJob();
        console.log("[ProgressTracker] Cleaned up partial cache and progress");
    }

    /**
     * 清理所有翻译缓存, 包括最终译文
     */
    async reset(): Promise<void> {
        await this.cleanup();
        await removePathIfExists(this.finalCachePath);

        try {
            const files = await readdir(this.fileDir);
            const jobScopedPrefix = `${this.artifactBaseName}.`;

            await Promise.all(files.map(async (fileName) => {
                if (
                    fileName.startsWith(jobScopedPrefix) &&
                    (
                        fileName.endsWith(".partial.md") ||
                        fileName.endsWith(".final.tmp")
                    )
                ) {
                    await removePathIfExists(path.join(this.fileDir, fileName));
                }
            }));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }

        console.log("[ProgressTracker] Reset full translation cache");
    }

    private async updateProgress(
        progress: TranslationProgress,
        chunkIndex: number,
        chunkLength: number
    ): Promise<void> {
        if (chunkIndex < progress.chunks.length) {
            progress.chunks[chunkIndex].completed = true;
            progress.chunks[chunkIndex].length = chunkLength;
        }

        progress.completedChunks = progress.chunks.filter((chunk) => chunk.completed).length;
        progress.timestamp = new Date().toISOString();

        await writeFile(this.progressPath, JSON.stringify(progress, null, 2));
        await this.touchActiveJob();
    }

    private createActiveJob(jobId: string): ActiveTranslationJob {
        const now = new Date().toISOString();
        return {
            jobId,
            cacheKey: this.cacheKey,
            targetLang: this.targetLang,
            status: "active",
            createdAt: now,
            updatedAt: now,
            heartbeatAt: now,
        };
    }

    private isActiveJobStale(job: ActiveTranslationJob): boolean {
        const heartbeatAt = Date.parse(job.heartbeatAt || job.updatedAt || job.createdAt);
        if (!Number.isFinite(heartbeatAt)) {
            return true;
        }

        return Date.now() - heartbeatAt > ACTIVE_TRANSLATION_JOB_STALE_MS;
    }

    private requireJobId(): string {
        if (!this.currentJobId) {
            throw new Error("[ProgressTracker] Job ID is required for this operation");
        }

        return this.currentJobId;
    }

    private buildPartialFileName(jobId: string): string {
        return `${this.artifactBaseName}.${jobId}.partial.md`;
    }

    private buildPartialCachePath(jobId: string): string {
        return path.join(this.fileDir, this.buildPartialFileName(jobId));
    }

    private buildTempFinalCachePath(jobId: string): string {
        return path.join(this.fileDir, `${this.artifactBaseName}.${jobId}.final.tmp`);
    }

    private async resolvePartialCachePath(progress: TranslationProgress): Promise<string | null> {
        if (progress.partialFileName?.trim()) {
            return path.join(this.fileDir, progress.partialFileName.trim());
        }

        if (progress.jobId?.trim()) {
            return this.buildPartialCachePath(progress.jobId.trim());
        }

        const legacyPartialCachePath = path.join(this.fileDir, `${this.artifactBaseName}.partial.md`);
        return (await pathExists(legacyPartialCachePath)) ? legacyPartialCachePath : null;
    }

    private async assertJobOwnership(): Promise<void> {
        const jobId = this.requireJobId();
        const activeJob = await this.readActiveJob({ pruneStale: false });

        if (!activeJob || activeJob.jobId !== jobId) {
            throw new Error("[ProgressTracker] Active job lock is missing or owned by another job");
        }
    }

    private async touchActiveJob(): Promise<void> {
        const jobId = this.requireJobId();
        const activeJob = await this.readActiveJob({ pruneStale: false });

        if (!activeJob || activeJob.jobId !== jobId) {
            throw new Error("[ProgressTracker] Active job lock is missing or owned by another job");
        }

        const now = new Date().toISOString();
        activeJob.updatedAt = now;
        activeJob.heartbeatAt = now;

        await writeFile(this.activeJobPath, JSON.stringify(activeJob, null, 2));
    }
}

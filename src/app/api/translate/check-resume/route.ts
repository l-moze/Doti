import { NextRequest, NextResponse } from "next/server";
import { ProgressTracker } from "@/lib/progress-tracker";
import { buildTranslationCacheKeyInputFromRuntime } from "@/lib/translation-cache-key";

/**
 * GET /api/translate/check-resume
 * 
 * 检查是否存在可恢复的翻译进度
 * 
 * Query Params:
 *   - fileHash: string (required)
 *   - targetLang: string (required)
 *   - sourceMarkdown: string (required, for validation)
 */
export async function POST(request: NextRequest) {
    try {
        const {
            fileHash,
            targetLang,
            sourceMarkdown,
            providerId,
            model,
            providerProfile,
            extraTerms,
        } = await request.json();

        if (!fileHash || !targetLang || !sourceMarkdown || !providerId || !model) {
            return NextResponse.json({
                error: "Missing required parameters"
            }, { status: 400 });
        }

        const tracker = new ProgressTracker(buildTranslationCacheKeyInputFromRuntime({
            fileHash,
            targetLang,
            providerId,
            model,
            providerProfile: providerProfile?.providerType ? providerProfile : undefined,
            glossaryTerms: Array.isArray(extraTerms) ? extraTerms : [],
            translateMode: providerProfile?.providerType === "deeplx" ? "deeplx" : "default",
            outputMode: "plain",
        }));

        // Check if full translation exists
        if (await tracker.hasFullCache()) {
            return NextResponse.json({
                canResume: false,
                reason: 'complete',
                message: 'Translation already complete'
            });
        }

        const activeJob = await tracker.readActiveJob();
        if (activeJob) {
            const progress = await tracker.readProgress();
            return NextResponse.json({
                canResume: false,
                reason: 'active_job',
                message: 'Another translation job is still active for this cache key',
                activeJobId: activeJob.jobId,
                completedChunks: progress?.completedChunks ?? 0,
                totalChunks: progress?.totalChunks ?? 0,
                percentage: progress && progress.totalChunks > 0
                    ? Math.floor((progress.completedChunks / progress.totalChunks) * 100)
                    : 0,
            });
        }

        // Check for partial cache
        if (!await tracker.hasPartialCache()) {
            return NextResponse.json({
                canResume: false,
                reason: 'no_progress',
                message: 'No partial translation found'
            });
        }

        // Validate partial cache
        if (!await tracker.validatePartialCache(sourceMarkdown)) {
            return NextResponse.json({
                canResume: false,
                reason: 'invalid',
                message: 'Partial translation is outdated or invalid'
            });
        }

        // Get progress info
        const progress = await tracker.readProgress();
        if (!progress) {
            return NextResponse.json({
                canResume: false,
                reason: 'corrupted',
                message: 'Progress file is corrupted'
            });
        }

        return NextResponse.json({
            canResume: true,
            jobId: progress.jobId ?? null,
            completedChunks: progress.completedChunks,
            totalChunks: progress.totalChunks,
            percentage: Math.floor((progress.completedChunks / progress.totalChunks) * 100),
            timestamp: progress.timestamp
        });

    } catch (error: unknown) {
        console.error("[Check Resume] Error:", error);
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Internal Server Error"
        }, { status: 500 });
    }
}

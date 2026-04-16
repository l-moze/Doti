import { NextRequest, NextResponse } from "next/server";
import { ProgressTracker } from "@/lib/progress-tracker";

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
        const { fileHash, targetLang, sourceMarkdown } = await request.json();

        if (!fileHash || !targetLang || !sourceMarkdown) {
            return NextResponse.json({
                error: "Missing required parameters"
            }, { status: 400 });
        }

        const tracker = new ProgressTracker(fileHash, targetLang);

        // Check if full translation exists
        if (tracker.hasFullCache()) {
            return NextResponse.json({
                canResume: false,
                reason: 'complete',
                message: 'Translation already complete'
            });
        }

        // Check for partial cache
        if (!tracker.hasPartialCache()) {
            return NextResponse.json({
                canResume: false,
                reason: 'no_progress',
                message: 'No partial translation found'
            });
        }

        // Validate partial cache
        if (!tracker.validatePartialCache(sourceMarkdown)) {
            return NextResponse.json({
                canResume: false,
                reason: 'invalid',
                message: 'Partial translation is outdated or invalid'
            });
        }

        // Get progress info
        const progress = tracker.readProgress();
        if (!progress) {
            return NextResponse.json({
                canResume: false,
                reason: 'corrupted',
                message: 'Progress file is corrupted'
            });
        }

        return NextResponse.json({
            canResume: true,
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

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { buildRawMediaPrefix } from '@/lib/media-access';
import { createLLMClient, type RuntimeProviderProfile } from '@/lib/llm/client';
import type { Term } from '@/lib/agent/memory/terminology-store';
import {
    buildPaperPolishPrompt,
    runPaperPolishAnalysis,
    runPaperPolishRules,
    sanitizePaperPolishOutput,
    shouldUsePaperPolishModel,
    type PaperPolishIssueWindow,
    type PaperPolishMode,
} from '@/lib/paper-polish';
import {
    directoryExists,
    findUploadArtifactPaths,
    readJsonFileIfExists,
    readTextFileIfExists,
    resolveUploadDir,
} from '@/lib/upload-artifacts';

type PaperPolishRequest = {
    fileHash?: string;
    markdown?: string;
    mode?: PaperPolishMode;
    issueWindows?: PaperPolishIssueWindow[];
    providerId?: string;
    model?: string;
    providerProfile?: RuntimeProviderProfile;
    targetLang?: string;
    extraTerms?: Term[];
};

type LoadedPaperPolishSources = {
    markdown: string;
    contentList?: unknown;
    layout?: unknown;
    assetPathPrefix?: string;
};

async function loadPaperPolishSources(fileHash: string | undefined, fallbackMarkdown: string): Promise<LoadedPaperPolishSources> {
    if (!fileHash) {
        return { markdown: fallbackMarkdown.trim() };
    }

    const uploadDir = resolveUploadDir(fileHash);
    if (!uploadDir || !(await directoryExists(uploadDir))) {
        return {
            markdown: fallbackMarkdown.trim(),
            assetPathPrefix: buildRawMediaPrefix(fileHash),
        };
    }

    const { contentListRelativePath, layoutJsonRelativePath, markdownRelativePath } = await findUploadArtifactPaths(uploadDir);
    const [contentList, layout, markdownFromDisk] = await Promise.all([
        readJsonFileIfExists(contentListRelativePath ? path.join(uploadDir, contentListRelativePath) : null),
        readJsonFileIfExists(layoutJsonRelativePath ? path.join(uploadDir, layoutJsonRelativePath) : null),
        fallbackMarkdown.trim()
            ? Promise.resolve('')
            : readTextFileIfExists(markdownRelativePath ? path.join(uploadDir, markdownRelativePath) : null),
    ]);

    return {
        markdown: fallbackMarkdown.trim() || markdownFromDisk.trim(),
        contentList: contentList ?? undefined,
        layout: layout ?? undefined,
        assetPathPrefix: buildRawMediaPrefix(fileHash),
    };
}

function dedupeNonOverlappingWindows(issueWindows: PaperPolishIssueWindow[]): PaperPolishIssueWindow[] {
    const usedBlockIds = new Set<string>();
    const uniqueWindows: PaperPolishIssueWindow[] = [];

    for (const window of issueWindows) {
        if (!window.currentMarkdown.trim()) continue;

        const intersects = window.sourceBlockIds.some((blockId) => usedBlockIds.has(blockId));
        if (intersects) continue;

        for (const blockId of window.sourceBlockIds) {
            usedBlockIds.add(blockId);
        }

        uniqueWindows.push(window);
    }

    return uniqueWindows;
}

function replaceFirstExactWindow(markdown: string, currentWindow: string, repairedWindow: string): string {
    if (!currentWindow.trim()) return markdown;
    const index = markdown.indexOf(currentWindow);
    if (index < 0) return markdown;
    return `${markdown.slice(0, index)}${repairedWindow}${markdown.slice(index + currentWindow.length)}`;
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json() as PaperPolishRequest;
        const mode: PaperPolishMode = body.mode === 'deep' ? 'deep' : 'light';
        const fallbackMarkdown = typeof body.markdown === 'string' ? body.markdown : '';
        const sources = await loadPaperPolishSources(body.fileHash, fallbackMarkdown);

        if (!sources.markdown.trim()) {
            return NextResponse.json({ error: 'No markdown provided' }, { status: 400 });
        }

        const analysis = runPaperPolishAnalysis({
            markdown: sources.markdown,
            mode: 'light',
            contentList: sources.contentList,
            layout: sources.layout,
            assetPathPrefix: sources.assetPathPrefix,
        });

        if (mode === 'light') {
            return NextResponse.json({
                text: analysis.markdown,
                changed: analysis.changed,
                issues: analysis.issues,
                summary: analysis.summary,
                usedSource: analysis.usedSource,
                residualIssues: analysis.residualIssues,
                issueWindows: analysis.issueWindows,
                canUseAiFallback: analysis.canUseAiFallback,
                mode,
            });
        }

        const requestedIssueWindows = Array.isArray(body.issueWindows) && body.issueWindows.length > 0
            ? body.issueWindows
            : analysis.issueWindows;
        const candidateWindows = dedupeNonOverlappingWindows(requestedIssueWindows).slice(0, 3);
        const modelDecision = shouldUsePaperPolishModel({
            analysis: {
                canUseAiFallback: candidateWindows.length > 0,
                issueWindows: candidateWindows,
                residualIssues: analysis.residualIssues.filter((issue) =>
                    candidateWindows.some((window) => window.id === issue.id)
                ),
            },
        });

        if (!modelDecision.useModel || candidateWindows.length === 0) {
            return NextResponse.json({
                text: analysis.markdown,
                changed: analysis.changed,
                issues: analysis.issues,
                summary: [
                    ...analysis.summary,
                    '当前没有需要额外修复的段落，已保留本地整理结果。',
                ],
                usedSource: analysis.usedSource,
                residualIssues: analysis.residualIssues,
                issueWindows: analysis.issueWindows,
                canUseAiFallback: analysis.canUseAiFallback,
                mode,
            });
        }

        const providerId = body.providerId || 'groq';
        const model = body.model || 'llama-3.3-70b-versatile';
        const providerProfile = body.providerProfile?.providerType ? body.providerProfile : undefined;

        if (providerProfile?.providerType === 'deeplx') {
            return NextResponse.json({
                text: analysis.markdown,
                changed: analysis.changed,
                issues: analysis.issues,
                summary: [
                    ...analysis.summary,
                    '当前翻译服务不适合继续修复段落，已保留本地整理结果。',
                ],
                usedSource: analysis.usedSource,
                residualIssues: analysis.residualIssues,
                issueWindows: analysis.issueWindows,
                canUseAiFallback: analysis.canUseAiFallback,
                mode,
            });
        }

        const client = createLLMClient(providerId, model, providerProfile);
        const extraTerms = Array.isArray(body.extraTerms)
            ? body.extraTerms
                .map((term) => ({ source: term.source, target: term.target, category: term.category }))
            : [];

        const remainingWindows: PaperPolishIssueWindow[] = [];
        let finalMarkdown = analysis.markdown;
        let repairedWindowCount = 0;

        for (const issueWindow of candidateWindows) {
            const prompt = buildPaperPolishPrompt({
                issueWindow,
                targetLang: body.targetLang,
                extraTerms,
            });

            let llmText = '';
            for await (const chunk of client.generateStream(prompt)) {
                llmText += chunk;
            }

            const sanitized = sanitizePaperPolishOutput(llmText);
            const normalizedWindow = runPaperPolishRules(sanitized || issueWindow.currentMarkdown, 'deep').markdown.trim();
            const repairedWindow = normalizedWindow || issueWindow.currentMarkdown;
            const replacedMarkdown = replaceFirstExactWindow(finalMarkdown, issueWindow.currentMarkdown, repairedWindow);

            if (repairedWindow !== issueWindow.currentMarkdown && replacedMarkdown !== finalMarkdown) {
                finalMarkdown = replacedMarkdown;
                repairedWindowCount += 1;
                continue;
            }

            remainingWindows.push(issueWindow);
        }

        const remainingWindowIds = new Set(remainingWindows.map((window) => window.id));
        const remainingResidualIssues = analysis.residualIssues.filter((issue) => remainingWindowIds.has(issue.id));

        return NextResponse.json({
            text: finalMarkdown,
            changed: finalMarkdown.trim() !== sources.markdown.trim(),
            issues: analysis.issues,
            summary: Array.from(new Set([
                ...analysis.summary,
                repairedWindowCount > 0
                    ? `已修复 ${repairedWindowCount} 个难处理的段落。`
                    : '难处理的段落没有改动，已保留本地整理结果。',
                remainingWindows.length > 0
                    ? `仍有 ${remainingWindows.length} 处内容建议人工复核。`
                    : '当前难处理的段落已处理完毕。',
            ])),
            usedSource: analysis.usedSource,
            residualIssues: remainingResidualIssues,
            issueWindows: remainingWindows,
            canUseAiFallback: remainingWindows.length > 0,
            mode,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
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
import { findPreferredRelativeFilePath } from '@/lib/upload-artifacts';

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

function readJsonFile(filePath: string | null): unknown | undefined {
    if (!filePath || !fs.existsSync(filePath)) return undefined;

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
        console.warn('[PaperPolish] Failed to parse JSON:', filePath, error);
        return undefined;
    }
}

function readTextFile(filePath: string | null): string {
    if (!filePath || !fs.existsSync(filePath)) return '';

    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
        console.warn('[PaperPolish] Failed to read text:', filePath, error);
        return '';
    }
}

function resolveUploadFile(rootDir: string, matcher: (relativePath: string, fileName: string) => boolean): string | null {
    const relativePath = findPreferredRelativeFilePath(rootDir, matcher);
    return relativePath ? path.join(rootDir, relativePath) : null;
}

function loadPaperPolishSources(fileHash: string | undefined, fallbackMarkdown: string): LoadedPaperPolishSources {
    if (!fileHash) {
        return { markdown: fallbackMarkdown.trim() };
    }

    const uploadDir = path.join(process.cwd(), 'uploads', fileHash);
    if (!fs.existsSync(uploadDir)) {
        return {
            markdown: fallbackMarkdown.trim(),
            assetPathPrefix: `/api/media/${fileHash}`,
        };
    }

    const contentListPath = resolveUploadFile(
        uploadDir,
        (relativePath, fileName) => fileName === 'content_list_v2.json' || relativePath.endsWith('/content_list_v2.json')
    );
    const layoutPath = resolveUploadFile(
        uploadDir,
        (relativePath, fileName) => fileName === 'layout.json' || relativePath.endsWith('/layout.json')
    );
    const markdownPath = resolveUploadFile(
        uploadDir,
        (relativePath, fileName) => fileName === 'full.md' || relativePath.endsWith('/full.md')
    );

    return {
        markdown: fallbackMarkdown.trim() || readTextFile(markdownPath).trim(),
        contentList: readJsonFile(contentListPath),
        layout: readJsonFile(layoutPath),
        assetPathPrefix: `/api/media/${fileHash}`,
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
        const sources = loadPaperPolishSources(body.fileHash, fallbackMarkdown);

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
                    '当前没有需要 AI 深修的局部窗口，已保留本地结构修复结果。',
                ],
                usedSource: analysis.usedSource,
                residualIssues: analysis.residualIssues,
                issueWindows: analysis.issueWindows,
                canUseAiFallback: analysis.canUseAiFallback,
                mode,
            });
        }

        const providerId = body.providerId || 'gemini';
        const model = body.model || 'gemini-2.5-flash';
        const providerProfile = body.providerProfile?.providerType ? body.providerProfile : undefined;

        if (providerProfile?.providerType === 'deeplx') {
            return NextResponse.json({
                text: analysis.markdown,
                changed: analysis.changed,
                issues: analysis.issues,
                summary: [
                    ...analysis.summary,
                    '当前 AI 深修模型配置为 DeepLX，已跳过局部窗口兜底。',
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
                    ? `已完成 ${repairedWindowCount} 个疑难窗口的 AI 深修。`
                    : 'AI 深修未改动当前局部窗口，保留本地结构修复结果。',
                remainingWindows.length > 0
                    ? `仍有 ${remainingWindows.length} 个窗口建议人工复核。`
                    : '当前疑难窗口已处理完毕。',
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

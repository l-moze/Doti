import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
    getProviderProfile,
    getLatestSession,
    getDocumentSnapshot,
    listDocumentHistorySnapshots,
    listUserGlossaryRecords,
    markDocumentOpened,
    saveDocumentSnapshot,
    saveSessionSnapshot
} from './db';
import {
    buildMarkdownFromTranslationBlocks,
    createSingleTranslationBlock,
    createTranslationBlocksFromPlan,
    type TranslationChunkPlan,
    type TranslationMarkdownBlock,
} from './translation-runtime';
import {
    buildTranslationArtifactBaseName,
    buildTranslationCacheKeyInputFromRuntime,
} from './translation-cache-key';
import {
    runPaperPolishRules,
    type PaperPolishIssue,
    type PaperPolishIssueWindow,
    type PaperPolishMode,
    type PaperPolishResidualIssue,
} from './paper-polish';
import { clearPretextEngineCache } from './pretext';

export type TaskStatus = 'idle' | 'uploading' | 'parsing' | 'parsed' | 'translating' | 'completed' | 'error';
export type TranslationPhase = 'idle' | 'preparing' | 'chunking' | 'refining' | 'streaming' | 'stalled' | 'finalizing' | 'completed' | 'error';
export type PaperPolishStatus = 'idle' | 'processing' | 'completed' | 'error' | 'cancelled';
export type TranslationQualityPreset = 'fast' | 'balanced' | 'quality';

const TRANSLATION_STREAM_STALL_WARNING_MS = 45000;
const TRANSLATION_STREAM_HARD_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSIENT_TASK_STATUSES: TaskStatus[] = ['uploading', 'parsing', 'translating'];
const TRANSLATION_QUALITY_PRESETS: Record<TranslationQualityPreset, { providerId: string; model: string }> = {
    fast: { providerId: 'gemini', model: 'gemini-2.5-flash' },
    balanced: { providerId: 'gemini', model: 'gemini-2.5-flash' },
    quality: { providerId: 'gemini', model: 'gemini-2.5-pro' },
};

export interface HistoryItem {
    fileHash: string;
    fileName: string;
    status: TaskStatus;
    progress: number;
    updatedAt: number;
    targetLang?: string;
    layoutUrl?: string | null;
    layoutJsonUrl?: string | null;
}

type PaperPolishUndoSnapshot = {
    sourceMarkdown: string;
    rawSourceMarkdown: string;
    polishedSourceMarkdown: string;
    targetMarkdown: string;
    translationBlocks: TranslationMarkdownBlock[];
    status: TaskStatus;
    progress: number;
    resumableTranslation: TranslationState['resumableTranslation'];
};

export interface TranslationState {
    // Config
    mineruApiKey: string;
    googleApiKey: string;
    setKeys: (mineruKey: string, googleKey: string) => void;

    // Task Status
    status: TaskStatus;
    error: string | null;
    progress: number; // 0-100

    // Data
    file: File | null;
    fileUrl: string | null; // For PDF Viewer
    batchId: string | null;
    fileHash: string | null; // Cache key
    activeFileName: string | null;
    sourceMarkdown: string;
    rawSourceMarkdown: string;
    polishedSourceMarkdown: string;
    targetMarkdown: string;
    translationBlocks: TranslationMarkdownBlock[];
    translationRunId: string | null;
    targetLang: string;
    layoutUrl: string | null;
    layoutJsonUrl: string | null;
    translationQualityPreset: TranslationQualityPreset;
    providerId: string;  // 'gemini' | 'deepseek' | 'glm' | 'ollama' | 'openai'
    model: string;
    assistProviderId: string;
    assistModel: string;
    translationStatus: string; // Agent status (e.g., 'chunking', 'translating')
    translationPhase: TranslationPhase;
    translationLastEventAt: number | null;
    translationConcurrency: number;
    paperPolishStatus: PaperPolishStatus;
    paperPolishMode: PaperPolishMode | null;
    paperPolishProgress: number;
    paperPolishMessage: string;
    paperPolishSummary: string[];
    paperPolishIssues: PaperPolishIssue[];
    paperPolishResidualIssues: PaperPolishResidualIssue[];
    paperPolishIssueWindows: PaperPolishIssueWindow[];
    paperPolishCanUseAiFallback: boolean;
    paperPolishAutoEnabled: boolean;
    paperPolishUndoSnapshot: PaperPolishUndoSnapshot | null;
    paperPolishUndoExpiresAt: number | null;
    paperPolishRevealKey: number;

    // Resume Translation
    resumableTranslation: {
        canResume: boolean;
        completedChunks: number;
        totalChunks: number;
        percentage: number;
        jobId?: string | null;
        activeJobId?: string | null;
    } | null;
    checkResumable: () => Promise<void>;
    resumeTranslation: () => Promise<void>;
    restartTranslation: () => Promise<void>;
    retryParsing: () => Promise<void>;
    clearResumable: () => void;

    // History
    history: HistoryItem[];
    addToHistory: (item: Partial<HistoryItem> & { fileHash: string; fileName: string }) => void;
    loadFromHistory: (fileHash: string) => Promise<void>;
    hydrateStore: () => Promise<void>;

    // Highlighting (for tri-pane sync)
    highlightedBlockId: string | null;
    setHighlightedBlock: (blockId: string | null) => void;

    // View Mode
    isZenMode: boolean;
    toggleZenMode: () => void;

    // Actions
    setFile: (file: File | null) => void;
    importFromArxiv: (input: string) => Promise<void>;
    startUpload: () => Promise<void>;
    pollStatus: () => void;
    startTranslation: () => Promise<void>;
    performTranslation: (resume: boolean, forceFresh?: boolean) => Promise<void>;
    setPaperPolishAutoEnabled: (enabled: boolean) => void;
    runPaperPolish: (mode?: PaperPolishMode) => Promise<void>;
    runPaperPolishAiFallback: () => Promise<void>;
    cancelPaperPolish: () => void;
    undoPaperPolish: () => Promise<void>;
    reset: () => void;
    setTargetLang: (lang: string) => void;
    setTranslationQualityPreset: (preset: TranslationQualityPreset) => void;
    saveEditedTranslation: (editedMarkdown: string) => void;
    setProvider: (providerId: string, model: string) => void;
    setAssistProvider: (providerId: string, model: string) => void;
}

type PendingChunkMutation = {
    mode: 'append' | 'replace';
    text: string;
    title?: string;
};

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unexpected error';
}

function isTransientTaskStatus(status: TaskStatus): boolean {
    return TRANSIENT_TASK_STATUSES.includes(status);
}

function getRecoveredTaskStatus(input: {
    previousStatus: TaskStatus;
    hasSourceMarkdown: boolean;
    hasTargetMarkdown: boolean;
    historyStatus?: TaskStatus;
}): TaskStatus {
    if (!isTransientTaskStatus(input.previousStatus)) {
        return input.previousStatus;
    }

    if (input.historyStatus === 'completed') return 'completed';
    if (input.historyStatus === 'error') {
        if (input.hasTargetMarkdown) return 'completed';
        if (input.hasSourceMarkdown) return 'parsed';
        return 'error';
    }

    if (input.hasTargetMarkdown) return 'completed';
    if (input.hasSourceMarkdown) return 'parsed';
    return 'idle';
}

function getInterruptedTaskMessage(status: TaskStatus): string | null {
    if (status === 'translating') {
        return '上次翻译已中断，已切换为可恢复状态。';
    }
    if (status === 'parsing') {
        return '上次解析未正常结束，请重新发起解析。';
    }
    if (status === 'uploading') {
        return '上次上传未完成，请重新上传文件。';
    }
    return null;
}

function sanitizePersistedHistoryItem(item: HistoryItem): HistoryItem {
    if (item.status !== 'translating') {
        return item;
    }

    return {
        ...item,
        status: 'parsed',
    };
}

function createTranslationJobId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function deriveTranslationPhase(message: unknown): TranslationPhase {
    const normalized = typeof message === 'string' ? message.toLowerCase() : '';
    if (!normalized) return 'preparing';
    if (normalized.includes('chunking')) return 'chunking';
    if (normalized.includes('refining')) return 'refining';
    if (normalized.includes('parallel batch')) return 'streaming';
    if (normalized.includes('translating')) return 'streaming';
    if (normalized.includes('loading from cache')) return 'finalizing';
    if (normalized.includes('resume')) return 'refining';
    if (normalized.includes('skipping')) return 'streaming';
    if (normalized.includes('complete')) return 'completed';
    return 'preparing';
}

function localizeTranslationStatus(message: unknown, concurrency: number): string {
    if (typeof message !== 'string' || !message.trim()) return '准备中...';

    if (message.startsWith('Chunking document')) {
        return '正在拆分文档...';
    }

    if (message.startsWith('Loading from Cache')) {
        return '正在载入缓存译文...';
    }

    if (message.startsWith('Resuming from chunk')) {
        return message.replace('Resuming from chunk', '正在从分块继续恢复');
    }

    if (message.startsWith('Refining: ')) {
        return `正在整理上下文 · ${message.slice('Refining: '.length)}`;
    }

    if (message.startsWith('Translating: ')) {
        const label = concurrency > 1 ? `并发 ${concurrency} 路翻译` : '正在翻译';
        return `${label} · ${message.slice('Translating: '.length)}`;
    }

    if (message.startsWith('Parallel batch ')) {
        return message
            .replace('Parallel batch ', '并发批次 ')
            .replace(' agents', ' 路 worker');
    }

    if (message.startsWith('Skipping reference section')) {
        return '检测到参考文献区，跳过翻译';
    }

    if (message === 'Completed') {
        return '翻译已完成';
    }

    return message;
}

function isRateLimitErrorMessage(message: unknown): boolean {
    if (typeof message !== 'string') return false;

    const normalized = message.toLowerCase();
    return (
        normalized.includes('429') ||
        normalized.includes('rate limit') ||
        normalized.includes('too many requests') ||
        normalized.includes('status_code=429') ||
        normalized.includes('status code 429') ||
        normalized.includes('try again in') ||
        normalized.includes('retry after')
    );
}

function clampErrorProgress(progress: number): number {
    if (!Number.isFinite(progress)) return 0;
    return Math.max(0, Math.min(Math.floor(progress), 99));
}

function deriveSourceMarkdownState(markdown: string, autoEnabled: boolean) {
    const normalized = markdown.trim();
    if (!normalized) {
        return {
            sourceMarkdown: '',
            rawSourceMarkdown: '',
            polishedSourceMarkdown: '',
            summary: [] as string[],
            issues: [] as PaperPolishIssue[],
        };
    }

    if (!autoEnabled) {
        return {
            sourceMarkdown: normalized,
            rawSourceMarkdown: normalized,
            polishedSourceMarkdown: '',
            summary: [] as string[],
            issues: [] as PaperPolishIssue[],
        };
    }

    const result = runPaperPolishRules(normalized, 'light');
    return {
        sourceMarkdown: result.markdown,
        rawSourceMarkdown: normalized,
        polishedSourceMarkdown: result.markdown !== normalized ? result.markdown : '',
        summary: result.summary,
        issues: result.issues,
    };
}

function createEmptyDocumentWorkspaceState() {
    return {
        sourceMarkdown: '',
        rawSourceMarkdown: '',
        polishedSourceMarkdown: '',
        targetMarkdown: '',
        translationBlocks: [] as TranslationMarkdownBlock[],
        translationRunId: null,
        layoutUrl: null,
        layoutJsonUrl: null,
        resumableTranslation: null as TranslationState['resumableTranslation'],
        highlightedBlockId: null as string | null,
        translationStatus: '',
        translationPhase: 'idle' as TranslationPhase,
        translationLastEventAt: null as number | null,
        translationConcurrency: 1,
        error: null as string | null,
        paperPolishStatus: 'idle' as PaperPolishStatus,
        paperPolishMode: null as PaperPolishMode | null,
        paperPolishProgress: 0,
        paperPolishMessage: '',
        paperPolishSummary: [] as string[],
        paperPolishIssues: [] as PaperPolishIssue[],
        paperPolishResidualIssues: [] as PaperPolishResidualIssue[],
        paperPolishIssueWindows: [] as PaperPolishIssueWindow[],
        paperPolishCanUseAiFallback: false,
        paperPolishUndoSnapshot: null as PaperPolishUndoSnapshot | null,
        paperPolishUndoExpiresAt: null as number | null,
    };
}

type PaperPolishApiResponse = {
    text?: string;
    changed?: boolean;
    issues?: PaperPolishIssue[];
    summary?: string[];
    residualIssues?: PaperPolishResidualIssue[];
    issueWindows?: PaperPolishIssueWindow[];
    canUseAiFallback?: boolean;
    usedSource?: string;
    error?: string;
};

async function persistActiveDocumentSnapshot(input: {
    fileHash: string | null;
    fileName: string | null;
    status: TaskStatus;
    progress: number;
    targetLang: string;
    sourceMarkdown: string;
    rawSourceMarkdown: string;
    polishedSourceMarkdown: string;
    targetMarkdown: string;
    layoutJsonUrl: string | null;
}): Promise<void> {
    if (!input.fileHash) return;

    await saveDocumentSnapshot({
        fileHash: input.fileHash,
        fileName: input.fileName || 'unknown.pdf',
        status: input.status,
        progress: input.progress,
        updatedAt: Date.now(),
        targetLang: input.targetLang,
        sourceMarkdown: input.sourceMarkdown || undefined,
        rawSourceMarkdown: input.rawSourceMarkdown || undefined,
        polishedSourceMarkdown: input.polishedSourceMarkdown || undefined,
        targetMarkdown: input.targetMarkdown || undefined,
        layoutJsonUrl: input.layoutJsonUrl,
        lastOpenedAt: Date.now(),
    });
}

async function resolveMediaUrl(fileHash: string, relativePath: string): Promise<string> {
    const response = await fetch(
        `/api/media/sign?fileHash=${encodeURIComponent(fileHash)}&path=${encodeURIComponent(relativePath)}`
    );
    if (!response.ok) {
        throw new Error('Failed to resolve media URL');
    }

    const data = await response.json();
    if (!data?.url || typeof data.url !== 'string') {
        throw new Error('Media URL is missing');
    }

    return data.url;
}

async function resolveOptionalMediaUrl(fileHash: string | null, relativePath: string): Promise<string | null> {
    if (!fileHash) return null;

    try {
        return await resolveMediaUrl(fileHash, relativePath);
    } catch (error) {
        console.warn('[Media] Failed to resolve media URL:', error);
        return null;
    }
}

async function resolveTranslationRuntimeCacheState(input: {
    fileHash: string;
    targetLang: string;
    providerId: string;
    model: string;
}): Promise<{
    providerProfile: Awaited<ReturnType<typeof getProviderProfile>> | undefined;
    glossaryTerms: Array<{
        source: string;
        target: string;
        category?: string;
    }>;
    artifactBaseName: string;
}> {
    const providerProfile = input.providerId.startsWith('custom:')
        ? await getProviderProfile(input.providerId.slice('custom:'.length))
        : undefined;
    const glossaryTerms = (await listUserGlossaryRecords())
        .filter((term) => term.enabled)
        .map((term) => ({
            source: term.source,
            target: term.target,
            category: term.category,
        }));
    const cacheKeyInput = buildTranslationCacheKeyInputFromRuntime({
        fileHash: input.fileHash,
        targetLang: input.targetLang,
        providerId: input.providerId,
        model: input.model,
        providerProfile,
        glossaryTerms,
        translateMode: providerProfile?.providerType === 'deeplx' ? 'deeplx' : 'default',
        outputMode: 'plain',
    });

    return {
        providerProfile,
        glossaryTerms,
        artifactBaseName: buildTranslationArtifactBaseName(cacheKeyInput),
    };
}

async function fetchTranslationMarkdownByCandidates(fileHash: string, fileNames: string[]): Promise<string> {
    let lastError: unknown;

    for (const fileName of fileNames) {
        try {
            const mediaUrl = await resolveMediaUrl(fileHash, fileName);
            const response = await fetch(mediaUrl);
            if (!response.ok) {
                continue;
            }
            return await response.text();
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError) {
        console.warn('[Translation] Failed to load cached translation:', lastError);
    }

    return '';
}

async function fetchStoredTranslationMarkdown(input: {
    fileHash: string;
    targetLang: string;
    providerId: string;
    model: string;
}): Promise<string> {
    try {
        const { artifactBaseName } = await resolveTranslationRuntimeCacheState(input);
        return await fetchTranslationMarkdownByCandidates(input.fileHash, [
            `${artifactBaseName}.md`,
            `translation-${input.targetLang}.md`,
        ]);
    } catch (error) {
        console.warn('[Translation] Failed to load cached translation:', error);
        return '';
    }
}

export const useTranslationStore = create<TranslationState>()(
    persist(
        (set, get) => {
            let paperPolishAbortController: AbortController | null = null;
            let paperPolishProgressTimer: ReturnType<typeof setInterval> | null = null;
            let activeTranslationRequestToken: string | null = null;

            const clearPaperPolishProgressTimer = () => {
                if (!paperPolishProgressTimer) return;
                clearInterval(paperPolishProgressTimer);
                paperPolishProgressTimer = null;
            };

            const schedulePaperPolishProgress = () => {
                clearPaperPolishProgressTimer();
                const checkpoints = [
                    { progress: 14, message: '正在扫描段落边界...' },
                    { progress: 33, message: '正在整理标题、列表与空行...' },
                    { progress: 56, message: '正在合并跨页与图表打断片段...' },
                    { progress: 74, message: '正在重建伪代码与结构块...' },
                    { progress: 84, message: '正在等待模型返回整理结果...' },
                ];
                let pointer = 0;

                paperPolishProgressTimer = setInterval(() => {
                    const current = get();
                    if (current.paperPolishStatus !== 'processing') {
                        clearPaperPolishProgressTimer();
                        return;
                    }

                    const checkpoint = checkpoints[Math.min(pointer, checkpoints.length - 1)];
                    set({
                        paperPolishProgress: checkpoint.progress,
                        paperPolishMessage: checkpoint.message,
                    });

                    if (pointer < checkpoints.length - 1) {
                        pointer += 1;
                    }
                }, 550);
            };

            const persistCurrentSnapshot = async () => {
                const current = get();
                await persistActiveDocumentSnapshot({
                    fileHash: current.fileHash,
                    fileName: current.activeFileName || current.file?.name || 'unknown.pdf',
                    status: current.status,
                    progress: current.progress,
                    targetLang: current.targetLang,
                    sourceMarkdown: current.sourceMarkdown,
                    rawSourceMarkdown: current.rawSourceMarkdown,
                    polishedSourceMarkdown: current.polishedSourceMarkdown,
                    targetMarkdown: current.targetMarkdown,
                    layoutJsonUrl: current.layoutJsonUrl,
                });
            };

            const getParsedMarkdownState = (markdown: string) => deriveSourceMarkdownState(
                markdown,
                get().paperPolishAutoEnabled
            );

            const buildPaperPolishUndoSnapshot = (): PaperPolishUndoSnapshot => {
                const current = get();
                return {
                    sourceMarkdown: current.sourceMarkdown,
                    rawSourceMarkdown: current.rawSourceMarkdown,
                    polishedSourceMarkdown: current.polishedSourceMarkdown,
                    targetMarkdown: current.targetMarkdown,
                    translationBlocks: current.translationBlocks,
                    status: current.status,
                    progress: current.progress,
                    resumableTranslation: current.resumableTranslation,
                };
            };

            const syncTargetLanguageView = async (options?: {
                targetLang?: string;
                fallbackStatus?: TaskStatus;
                fallbackProgress?: number;
                clearError?: boolean;
            }) => {
                const snapshot = get();
                if (!snapshot.fileHash) {
                    set({
                        targetMarkdown: '',
                        translationBlocks: [],
                        resumableTranslation: null,
                    });
                    return;
                }

                const nextTargetLang = options?.targetLang ?? snapshot.targetLang;
                const knownCompletedTranslation = snapshot.history.some((item) =>
                    item.fileHash === snapshot.fileHash &&
                    item.status === 'completed' &&
                    item.targetLang === nextTargetLang
                );
                const shouldProbeStoredTranslation =
                    (snapshot.targetLang === nextTargetLang && Boolean(snapshot.targetMarkdown.trim())) ||
                    snapshot.status === 'completed' ||
                    options?.fallbackStatus === 'completed' ||
                    knownCompletedTranslation;
                const translationMarkdown =
                    snapshot.targetLang === nextTargetLang && snapshot.targetMarkdown.trim()
                        ? snapshot.targetMarkdown
                        : shouldProbeStoredTranslation
                            ? await fetchStoredTranslationMarkdown({
                                fileHash: snapshot.fileHash,
                                targetLang: nextTargetLang,
                                providerId: snapshot.providerId,
                                model: snapshot.model,
                            })
                            : '';
                const current = get();

                if (
                    current.fileHash !== snapshot.fileHash ||
                    current.targetLang !== nextTargetLang ||
                    current.providerId !== snapshot.providerId ||
                    current.model !== snapshot.model
                ) {
                    return;
                }

                const hasSourceMarkdown = Boolean(current.sourceMarkdown.trim());
                const hasTargetMarkdown = Boolean(translationMarkdown.trim());
                const sanitizedFallbackStatus = options?.fallbackStatus === 'completed' && !hasTargetMarkdown
                    ? (hasSourceMarkdown ? 'parsed' : current.status)
                    : options?.fallbackStatus;
                const nextStatus = current.status === 'translating'
                    ? current.status
                    : hasTargetMarkdown
                        ? 'completed'
                        : sanitizedFallbackStatus ?? (hasSourceMarkdown ? 'parsed' : current.status);
                const nextProgress = current.status === 'translating'
                    ? current.progress
                    : nextStatus === 'completed'
                        ? 100
                        : nextStatus === 'parsed'
                            ? Math.max(60, options?.fallbackProgress ?? current.progress)
                            : options?.fallbackProgress ?? (hasSourceMarkdown ? 60 : current.progress);

                set((state) => ({
                    targetMarkdown: translationMarkdown,
                    translationBlocks: hasTargetMarkdown
                        ? createSingleTranslationBlock(translationMarkdown, 'Recovered Translation')
                        : [],
                    status: nextStatus,
                    progress: nextProgress,
                    error: options?.clearError ? null : state.error,
                    translationStatus: nextStatus === 'translating' ? state.translationStatus : '',
                    translationPhase: nextStatus === 'translating' ? state.translationPhase : 'idle',
                    translationLastEventAt: nextStatus === 'translating' ? state.translationLastEventAt : null,
                    resumableTranslation: hasTargetMarkdown ? null : state.resumableTranslation,
                }));

                const persisted = get();
                void persistActiveDocumentSnapshot({
                    fileHash: persisted.fileHash,
                    fileName: persisted.activeFileName,
                    status: persisted.status,
                    progress: persisted.progress,
                    targetLang: persisted.targetLang,
                    sourceMarkdown: persisted.sourceMarkdown,
                    rawSourceMarkdown: persisted.rawSourceMarkdown,
                    polishedSourceMarkdown: persisted.polishedSourceMarkdown,
                    targetMarkdown: persisted.targetMarkdown,
                    layoutJsonUrl: persisted.layoutJsonUrl,
                });

                if (hasSourceMarkdown && !hasTargetMarkdown && nextStatus !== 'translating') {
                    await get().checkResumable();
                } else {
                    set({ resumableTranslation: null });
                }
            };

            return ({
            mineruApiKey: '',
            googleApiKey: '',
            status: 'idle',
            error: null,
            progress: 0,
            file: null,
            fileUrl: null,
            batchId: null,
            fileHash: null,
            activeFileName: null,
            sourceMarkdown: '',
            rawSourceMarkdown: '',
            polishedSourceMarkdown: '',
            targetMarkdown: '',
            translationBlocks: [],
            translationRunId: null,
            targetLang: 'Chinese',
            layoutUrl: null,
            layoutJsonUrl: null,
            translationQualityPreset: 'balanced',
            providerId: 'gemini',
            model: 'gemini-2.5-flash',
            assistProviderId: 'gemini',
            assistModel: 'gemini-2.5-flash',
            translationStatus: '',
            translationPhase: 'idle',
            translationLastEventAt: null,
            translationConcurrency: 1,
            paperPolishStatus: 'idle',
            paperPolishMode: null,
            paperPolishProgress: 0,
            paperPolishMessage: '',
            paperPolishSummary: [],
            paperPolishIssues: [],
            paperPolishResidualIssues: [],
            paperPolishIssueWindows: [],
            paperPolishCanUseAiFallback: false,
            paperPolishAutoEnabled: true,
            paperPolishUndoSnapshot: null,
            paperPolishUndoExpiresAt: null,
            paperPolishRevealKey: 0,
            highlightedBlockId: null,
            history: [],
            resumableTranslation: null,
            isZenMode: false,

            toggleZenMode: () => set((state) => ({ isZenMode: !state.isZenMode })),

            setPaperPolishAutoEnabled: (enabled) => {
                const current = get();
                const rawMarkdown = current.rawSourceMarkdown || current.sourceMarkdown;
                const nextState = enabled ? getParsedMarkdownState(rawMarkdown) : {
                    sourceMarkdown: rawMarkdown.trim(),
                    rawSourceMarkdown: rawMarkdown.trim(),
                    polishedSourceMarkdown: '',
                    summary: [] as string[],
                    issues: [] as PaperPolishIssue[],
                };
                const sourceChanged = nextState.sourceMarkdown !== current.sourceMarkdown;
                const hadTranslation = Boolean(current.targetMarkdown.trim()) || current.translationBlocks.length > 0;

                set({
                    paperPolishAutoEnabled: enabled,
                    sourceMarkdown: nextState.sourceMarkdown,
                    rawSourceMarkdown: nextState.rawSourceMarkdown,
                    polishedSourceMarkdown: nextState.polishedSourceMarkdown,
                    paperPolishSummary: nextState.summary,
                    paperPolishIssues: nextState.issues,
                    paperPolishResidualIssues: [],
                    paperPolishIssueWindows: [],
                    paperPolishCanUseAiFallback: false,
                    paperPolishStatus: 'idle',
                    paperPolishMode: null,
                    paperPolishProgress: 0,
                    paperPolishMessage: '',
                    paperPolishUndoSnapshot: null,
                    paperPolishUndoExpiresAt: null,
                    status: sourceChanged && hadTranslation ? 'parsed' : current.status,
                    progress: sourceChanged && hadTranslation ? 60 : current.progress,
                    targetMarkdown: sourceChanged && hadTranslation ? '' : current.targetMarkdown,
                    translationBlocks: sourceChanged && hadTranslation ? [] : current.translationBlocks,
                    translationStatus: sourceChanged && hadTranslation ? '源文结构已变化，请重新翻译。' : current.translationStatus,
                    translationPhase: sourceChanged && hadTranslation ? 'idle' : current.translationPhase,
                    translationLastEventAt: sourceChanged && hadTranslation ? null : current.translationLastEventAt,
                    resumableTranslation: sourceChanged && hadTranslation ? null : current.resumableTranslation,
                });

                void persistCurrentSnapshot();
            },

            runPaperPolish: async (mode = 'light') => {
                const current = get();
                if (!current.sourceMarkdown.trim() || current.paperPolishStatus === 'processing' || current.status === 'translating') {
                    return;
                }

                const undoSnapshot = buildPaperPolishUndoSnapshot();
                const baseMarkdown = current.sourceMarkdown.trim();
                const rawMarkdown = (current.rawSourceMarkdown || current.sourceMarkdown).trim();

                set({
                    paperPolishStatus: 'processing',
                    paperPolishMode: mode,
                    paperPolishProgress: mode === 'light' ? 18 : 8,
                    paperPolishMessage: mode === 'light' ? '正在基于结构信息快速修复...' : '正在对疑难窗口执行 AI 深修...',
                    paperPolishSummary: [],
                    paperPolishIssues: [],
                    paperPolishResidualIssues: mode === 'deep' ? current.paperPolishResidualIssues : [],
                    paperPolishIssueWindows: mode === 'deep' ? current.paperPolishIssueWindows : [],
                    paperPolishCanUseAiFallback: mode === 'deep' ? current.paperPolishCanUseAiFallback : false,
                    paperPolishUndoSnapshot: null,
                    paperPolishUndoExpiresAt: null,
                    error: null,
                });

                if (mode === 'deep') {
                    schedulePaperPolishProgress();
                }

                try {
                    const fallbackResult = runPaperPolishRules(baseMarkdown, mode);
                    const providerProfile = mode === 'deep' && current.assistProviderId.startsWith('custom:')
                        ? await getProviderProfile(current.assistProviderId.slice('custom:'.length))
                        : undefined;
                    const userTerms = mode === 'deep' ? await listUserGlossaryRecords() : [];
                    const enabledTerms = userTerms
                        .filter((term) => term.enabled)
                        .map((term) => ({ source: term.source, target: term.target, category: term.category }));

                    paperPolishAbortController = new AbortController();
                    const response = await fetch('/api/paper-polish', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: paperPolishAbortController.signal,
                        body: JSON.stringify({
                            fileHash: current.fileHash,
                            markdown: mode === 'deep' ? baseMarkdown : rawMarkdown,
                            mode,
                            issueWindows: mode === 'deep' ? current.paperPolishIssueWindows : undefined,
                            providerId: mode === 'deep' ? current.assistProviderId : undefined,
                            model: mode === 'deep' ? current.assistModel : undefined,
                            providerProfile,
                            targetLang: current.targetLang,
                            extraTerms: enabledTerms,
                        }),
                    });
                    const data = await response.json() as PaperPolishApiResponse;
                    if (!response.ok) {
                        throw new Error(data.error || 'PaperPolish 执行失败');
                    }

                    const result = {
                        markdown: typeof data.text === 'string' ? data.text : fallbackResult.markdown,
                        changed: typeof data.changed === 'boolean' ? data.changed : fallbackResult.changed,
                        issues: Array.isArray(data.issues) ? data.issues : fallbackResult.issues,
                        summary: Array.isArray(data.summary) ? data.summary : fallbackResult.summary,
                        residualIssues: Array.isArray(data.residualIssues) ? data.residualIssues : [],
                        issueWindows: Array.isArray(data.issueWindows) ? data.issueWindows : [],
                        canUseAiFallback: Boolean(data.canUseAiFallback),
                    };

                    clearPaperPolishProgressTimer();
                    paperPolishAbortController = null;

                    const nextSourceMarkdown = result.markdown.trim() || baseMarkdown;
                    const sourceChanged = nextSourceMarkdown !== current.sourceMarkdown.trim();
                    const hadTranslation = Boolean(current.targetMarkdown.trim()) || current.translationBlocks.length > 0;

                    set((state) => ({
                        sourceMarkdown: nextSourceMarkdown,
                        rawSourceMarkdown: rawMarkdown,
                        polishedSourceMarkdown: nextSourceMarkdown !== rawMarkdown ? nextSourceMarkdown : '',
                        paperPolishStatus: 'completed',
                        paperPolishMode: mode,
                        paperPolishProgress: 100,
                        paperPolishMessage: mode === 'deep'
                            ? (sourceChanged ? 'AI 深修完成' : 'AI 深修未改动正文')
                            : result.canUseAiFallback
                                ? `本地结构修复完成，发现 ${result.issueWindows.length} 处疑难结构`
                                : (sourceChanged ? '本地结构修复完成' : '正文结构已较稳定'),
                        paperPolishSummary: result.summary,
                        paperPolishIssues: result.issues,
                        paperPolishResidualIssues: result.residualIssues,
                        paperPolishIssueWindows: result.issueWindows,
                        paperPolishCanUseAiFallback: result.canUseAiFallback,
                        paperPolishUndoSnapshot: undoSnapshot,
                        paperPolishUndoExpiresAt: Date.now() + 3000,
                        paperPolishRevealKey: sourceChanged
                            ? state.paperPolishRevealKey + 1
                            : state.paperPolishRevealKey,
                        status: sourceChanged && hadTranslation ? 'parsed' : state.status,
                        progress: sourceChanged && hadTranslation ? 60 : state.progress,
                        targetMarkdown: sourceChanged && hadTranslation ? '' : state.targetMarkdown,
                        translationBlocks: sourceChanged && hadTranslation ? [] : state.translationBlocks,
                        translationStatus: sourceChanged && hadTranslation
                            ? '源文结构已整理，请重新翻译。'
                            : state.translationStatus,
                        translationPhase: sourceChanged && hadTranslation ? 'idle' : state.translationPhase,
                        translationLastEventAt: sourceChanged && hadTranslation ? null : state.translationLastEventAt,
                        resumableTranslation: sourceChanged && hadTranslation ? null : state.resumableTranslation,
                    }));

                    await persistCurrentSnapshot();
                } catch (error) {
                    clearPaperPolishProgressTimer();
                    paperPolishAbortController = null;

                    const isAbort = error instanceof DOMException && error.name === 'AbortError';
                    set({
                        paperPolishStatus: isAbort ? 'cancelled' : 'error',
                        paperPolishMode: mode,
                        paperPolishProgress: 0,
                        paperPolishMessage: isAbort ? '已取消本次整理' : '整理失败',
                        paperPolishSummary: [],
                        paperPolishIssues: [],
                        paperPolishResidualIssues: mode === 'deep' ? current.paperPolishResidualIssues : [],
                        paperPolishIssueWindows: mode === 'deep' ? current.paperPolishIssueWindows : [],
                        paperPolishCanUseAiFallback: mode === 'deep' ? current.paperPolishCanUseAiFallback : false,
                        error: isAbort ? null : getErrorMessage(error),
                    });
                }
            },

            runPaperPolishAiFallback: async () => {
                const current = get();
                if (current.paperPolishStatus === 'processing' || !current.paperPolishCanUseAiFallback || current.paperPolishIssueWindows.length === 0) {
                    return;
                }

                await get().runPaperPolish('deep');
            },

            cancelPaperPolish: () => {
                paperPolishAbortController?.abort();
                paperPolishAbortController = null;
                clearPaperPolishProgressTimer();
                set({
                    paperPolishStatus: 'cancelled',
                    paperPolishProgress: 0,
                    paperPolishMessage: '已取消本次整理',
                });
            },

            undoPaperPolish: async () => {
                const current = get();
                const snapshot = current.paperPolishUndoSnapshot;
                if (!snapshot) return;
                if (current.paperPolishUndoExpiresAt && current.paperPolishUndoExpiresAt < Date.now()) {
                    set({ paperPolishUndoSnapshot: null, paperPolishUndoExpiresAt: null });
                    return;
                }

                const sourceChanged = current.sourceMarkdown !== snapshot.sourceMarkdown;
                set((state) => ({
                    sourceMarkdown: snapshot.sourceMarkdown,
                    rawSourceMarkdown: snapshot.rawSourceMarkdown,
                    polishedSourceMarkdown: snapshot.polishedSourceMarkdown,
                    targetMarkdown: snapshot.targetMarkdown,
                    translationBlocks: snapshot.translationBlocks,
                    status: snapshot.status,
                    progress: snapshot.progress,
                    resumableTranslation: snapshot.resumableTranslation,
                    paperPolishStatus: 'idle',
                    paperPolishMode: null,
                    paperPolishProgress: 0,
                    paperPolishMessage: '已撤销上次整理',
                    paperPolishSummary: ['已恢复到整理前的版本。'],
                    paperPolishIssues: [],
                    paperPolishResidualIssues: [],
                    paperPolishIssueWindows: [],
                    paperPolishCanUseAiFallback: false,
                    paperPolishUndoSnapshot: null,
                    paperPolishUndoExpiresAt: null,
                    paperPolishRevealKey: sourceChanged
                        ? state.paperPolishRevealKey + 1
                        : state.paperPolishRevealKey,
                    translationStatus: snapshot.status === 'translating' ? '翻译已中断' : '',
                    translationPhase: snapshot.status === 'translating' ? 'stalled' : 'idle',
                    translationLastEventAt: snapshot.status === 'translating' ? Date.now() : null,
                }));

                await persistCurrentSnapshot();
            },

            addToHistory: (item) => {
                const currentHistory = get().history;
                const existingIndex = currentHistory.findIndex(h => h.fileHash === item.fileHash);
                const nextHistory = [...currentHistory];
                const existingItem = existingIndex !== -1 ? nextHistory[existingIndex] : undefined;
                const historyItem: HistoryItem = {
                    status: 'idle',
                    progress: 0,
                    updatedAt: Date.now(),
                    ...(existingItem ?? {}),
                    ...item
                };

                if (existingIndex !== -1) {
                    nextHistory[existingIndex] = historyItem;
                } else {
                    nextHistory.unshift(historyItem);
                }

                set({ history: nextHistory.slice(0, 20) });

                const current = get();
                void saveDocumentSnapshot({
                    fileHash: historyItem.fileHash,
                    fileName: historyItem.fileName,
                    status: historyItem.status,
                    progress: historyItem.progress,
                    updatedAt: historyItem.updatedAt,
                    targetLang: current.targetLang,
                    sourceMarkdown: current.sourceMarkdown || undefined,
                    rawSourceMarkdown: current.rawSourceMarkdown || undefined,
                    polishedSourceMarkdown: current.polishedSourceMarkdown || undefined,
                    targetMarkdown: current.targetMarkdown || undefined,
                    layoutJsonUrl: current.layoutJsonUrl,
                    lastOpenedAt: Date.now(),
                });

                void saveSessionSnapshot({
                    id: `${historyItem.fileHash}::${current.targetLang}`,
                    fileHash: historyItem.fileHash,
                    fileName: historyItem.fileName,
                    status: historyItem.status,
                    progress: historyItem.progress,
                    targetLang: current.targetLang,
                    providerId: current.providerId,
                    model: current.model,
                    updatedAt: Date.now(),
                });
            },

            loadFromHistory: async (hash: string) => {
                const item = get().history.find(h => h.fileHash === hash);
                if (!item) return;
                const originalPdfUrl = await resolveOptionalMediaUrl(hash, 'original.pdf');

                // Reset state first to show loading
                set({
                    fileHash: item.fileHash,
                    status: 'parsing',
                    progress: item.progress,
                    error: null,
                    translationStatus: '',
                    translationPhase: 'idle',
                    translationLastEventAt: null,
                    translationConcurrency: 1,
                    highlightedBlockId: null,
                    activeFileName: item.fileName,
                    fileUrl: originalPdfUrl,
                    sourceMarkdown: '',
                    rawSourceMarkdown: '',
                    polishedSourceMarkdown: '',
                    targetMarkdown: '',
                    translationBlocks: [],
                    translationRunId: null,
                    layoutUrl: item.layoutUrl || null,
                    layoutJsonUrl: item.layoutJsonUrl || null,
                    paperPolishStatus: 'idle',
                    paperPolishMode: null,
                    paperPolishProgress: 0,
                    paperPolishMessage: '',
                    paperPolishSummary: [],
                    paperPolishIssues: [],
                    paperPolishResidualIssues: [],
                    paperPolishIssueWindows: [],
                    paperPolishCanUseAiFallback: false,
                    paperPolishUndoSnapshot: null,
                    paperPolishUndoExpiresAt: null,
                });

                try {
                    const cachedSnapshot = await getDocumentSnapshot(hash);
                    const latestSession = await getLatestSession(hash);

                    if (latestSession) {
                        set({
                            targetLang: latestSession.targetLang,
                            providerId: latestSession.providerId,
                            model: latestSession.model,
                        });
                    }

                    if (cachedSnapshot) {
                        const parsedState = cachedSnapshot.rawSourceMarkdown
                            ? {
                                sourceMarkdown: cachedSnapshot.sourceMarkdown || cachedSnapshot.rawSourceMarkdown || '',
                                rawSourceMarkdown: cachedSnapshot.rawSourceMarkdown || '',
                                polishedSourceMarkdown: cachedSnapshot.polishedSourceMarkdown || '',
                            }
                            : getParsedMarkdownState(cachedSnapshot.sourceMarkdown || '');
                        set({
                            sourceMarkdown: parsedState.sourceMarkdown,
                            rawSourceMarkdown: parsedState.rawSourceMarkdown,
                            polishedSourceMarkdown: parsedState.polishedSourceMarkdown,
                            targetMarkdown: '',
                            translationBlocks: [],
                            layoutJsonUrl: cachedSnapshot.layoutJsonUrl || null,
                            layoutUrl: item.layoutUrl || null,
                        });
                        void markDocumentOpened(hash);
                    }

                    // Load source markdown (full.md)
                    const sourceUrl = await resolveMediaUrl(hash, 'full.md');
                    const sourceRes = await fetch(sourceUrl);
                    if (sourceRes.ok) {
                        const sourceText = await sourceRes.text();
                        const parsedState = getParsedMarkdownState(sourceText);
                        set({
                            sourceMarkdown: parsedState.sourceMarkdown,
                            rawSourceMarkdown: parsedState.rawSourceMarkdown,
                            polishedSourceMarkdown: parsedState.polishedSourceMarkdown,
                            paperPolishSummary: parsedState.summary,
                            paperPolishIssues: parsedState.issues,
                            paperPolishResidualIssues: [],
                            paperPolishIssueWindows: [],
                            paperPolishCanUseAiFallback: false,
                        });
                    }

                    // Check if layout files exist
                    const knownLayoutJsonUrl = get().layoutJsonUrl;
                    if (!knownLayoutJsonUrl) {
                        const layoutJsonUrl = await resolveMediaUrl(hash, 'layout.json');
                        const layoutPdfUrl = await resolveMediaUrl(hash, 'layout.pdf');
                        const layoutJsonRes = await fetch(layoutJsonUrl, { method: 'HEAD' });
                        if (layoutJsonRes.ok) {
                            set({
                                layoutUrl: layoutPdfUrl,
                                layoutJsonUrl: layoutJsonUrl,
                            });
                        }
                    }

                    const nextSourceMarkdown = get().sourceMarkdown;
                    const nextTargetMarkdown = get().targetMarkdown;
                    const recoveredStatus = getRecoveredTaskStatus({
                        previousStatus: item.status,
                        historyStatus: item.status,
                        hasSourceMarkdown: Boolean(nextSourceMarkdown.trim()),
                        hasTargetMarkdown: Boolean(nextTargetMarkdown.trim()),
                    });

                    // Restore final status
                    set({
                        status: recoveredStatus,
                        progress: recoveredStatus === 'completed' ? 100 : item.progress,
                        error: isTransientTaskStatus(item.status) ? getInterruptedTaskMessage(item.status) : null,
                        translationStatus: item.status === 'translating' ? '翻译已中断' : '',
                        translationPhase: item.status === 'translating' ? 'stalled' : 'idle',
                        translationLastEventAt: item.status === 'translating' ? Date.now() : null,
                    });
                    const current = get();
                    void persistActiveDocumentSnapshot({
                        fileHash: current.fileHash,
                        fileName: current.activeFileName,
                        status: current.status,
                        progress: current.progress,
                        targetLang: current.targetLang,
                        sourceMarkdown: current.sourceMarkdown,
                        rawSourceMarkdown: current.rawSourceMarkdown,
                        polishedSourceMarkdown: current.polishedSourceMarkdown,
                        targetMarkdown: current.targetMarkdown,
                        layoutJsonUrl: current.layoutJsonUrl,
                    });

                    await syncTargetLanguageView({
                        fallbackStatus: recoveredStatus,
                        fallbackProgress: recoveredStatus === 'completed' ? 100 : item.progress,
                    });

                } catch (e) {
                    console.error("Failed to load history item details", e);
                    const cachedSnapshot = await getDocumentSnapshot(hash);
                    if (cachedSnapshot?.sourceMarkdown || cachedSnapshot?.targetMarkdown) {
                        set({
                            status: cachedSnapshot?.sourceMarkdown ? 'parsed' : item.status,
                            error: null,
                            sourceMarkdown: cachedSnapshot.sourceMarkdown || '',
                            rawSourceMarkdown: cachedSnapshot.rawSourceMarkdown || cachedSnapshot.sourceMarkdown || '',
                            polishedSourceMarkdown: cachedSnapshot.polishedSourceMarkdown || '',
                            targetMarkdown: '',
                            translationBlocks: [],
                            layoutJsonUrl: cachedSnapshot.layoutJsonUrl || null,
                        });
                        return;
                    }
                    set({ status: 'error', error: 'Failed to load file content' });
                }
            },

            hydrateStore: async () => {
                // 从服务端获取历史列表并与本地状态合并
                try {
                    const indexedHistory = await listDocumentHistorySnapshots();
                    const response = await fetch('/api/history');
                    if (!response.ok) {
                        console.error('[Hydrate] Failed to fetch history from server');
                        if (indexedHistory.length > 0) {
                            set({ history: indexedHistory.map(sanitizePersistedHistoryItem).slice(0, 20) });
                        }
                        return;
                    }

                    const serverHistory: HistoryItem[] = await response.json();
                    let mergedHistorySnapshot: HistoryItem[] = [];

                    set((state) => {
                        // 创建一个 Map 用于快速查找
                        const localMap = new Map<string, HistoryItem>();
                        for (const localItem of [...indexedHistory, ...state.history]) {
                            const existing = localMap.get(localItem.fileHash);
                            if (!existing || localItem.updatedAt >= existing.updatedAt) {
                                localMap.set(localItem.fileHash, localItem);
                            }
                        }

                        // 合并策略：
                        // 1. 服务端历史为基准
                        // 2. 仅保留真正可恢复的本地上传/解析态；translating 不跨刷新保留，避免假活锁
                        const mergedHistory: HistoryItem[] = serverHistory.map(serverItem => {
                            const localItem = localMap.get(serverItem.fileHash);

                            // upload/parsing 可以暂时保留；translating 在刷新后没有活动流，不能直接沿用
                            if (localItem && ['uploading', 'parsing'].includes(localItem.status)) {
                                return localItem;
                            }

                            if (localItem && localItem.updatedAt > serverItem.updatedAt && localItem.status !== 'translating') {
                                return localItem;
                            }

                            // 否则使用服务端状态
                            return serverItem;
                        });

                        // 添加服务端没有但本地有的项（可能是刚上传还没同步的）
                        for (const localItem of state.history) {
                            if (!serverHistory.find(s => s.fileHash === localItem.fileHash)) {
                                mergedHistory.push(sanitizePersistedHistoryItem(localItem));
                            }
                        }

                        // 按更新时间降序排序
                        mergedHistory.sort((a, b) => b.updatedAt - a.updatedAt);
                        mergedHistorySnapshot = mergedHistory.slice(0, 20);

                        console.log('[Hydrate] Merged history:', mergedHistory.length, 'items');
                        return { history: mergedHistorySnapshot };
                    });

                    const current = get();
                    if (current.fileHash && isTransientTaskStatus(current.status)) {
                        const currentHistoryItem = mergedHistorySnapshot.find((item) => item.fileHash === current.fileHash);
                        const recoveredStatus = getRecoveredTaskStatus({
                            previousStatus: current.status,
                            historyStatus: currentHistoryItem?.status,
                            hasSourceMarkdown: Boolean(current.sourceMarkdown.trim()),
                            hasTargetMarkdown: Boolean(current.targetMarkdown.trim()),
                        });
                        const recoveredMessage = getInterruptedTaskMessage(current.status);

                        set({
                            status: recoveredStatus,
                            progress: recoveredStatus === 'completed' ? 100 : current.progress,
                            error: recoveredMessage,
                            translationStatus: current.status === 'translating' ? '翻译已中断' : '',
                            translationPhase: current.status === 'translating' ? 'stalled' : 'idle',
                            translationLastEventAt: current.status === 'translating' ? Date.now() : null,
                        });

                        if (current.fileHash) {
                            get().addToHistory({
                                fileHash: current.fileHash,
                                fileName: current.activeFileName || 'unknown.pdf',
                                status: recoveredStatus,
                                progress: recoveredStatus === 'completed' ? 100 : current.progress,
                            });
                        }
                    }

                    const latest = get();
                    if (latest.fileHash && latest.sourceMarkdown.trim()) {
                        void syncTargetLanguageView({
                            fallbackStatus: latest.status,
                            fallbackProgress: latest.progress,
                        });
                    }
                } catch (e) {
                    console.error('[Hydrate] Error fetching history:', e);
                }
            },

            setProvider: (providerId, model) => {
                const previous = get();
                const fallbackStatus = previous.sourceMarkdown.trim() ? 'parsed' : previous.status;
                const fallbackProgress = previous.sourceMarkdown.trim() ? 60 : previous.progress;

                set((state) => ({
                    providerId,
                    model,
                    ...(state.status === 'translating'
                        ? {}
                        : {
                            targetMarkdown: '',
                            translationBlocks: [],
                            resumableTranslation: null,
                            error: null,
                            translationStatus: '',
                            translationPhase: 'idle' as const,
                            translationLastEventAt: null,
                            status: fallbackStatus,
                            progress: fallbackProgress,
                        }),
                }));
                const current = get();
                if (!current.fileHash) return;

                void saveSessionSnapshot({
                    id: `${current.fileHash}::${current.targetLang}`,
                    fileHash: current.fileHash,
                    fileName: current.file?.name || 'unknown.pdf',
                    status: current.status,
                    progress: current.progress,
                    targetLang: current.targetLang,
                    providerId,
                    model,
                    updatedAt: Date.now(),
                });
                void persistActiveDocumentSnapshot({
                    fileHash: current.fileHash,
                    fileName: current.activeFileName,
                    status: current.status,
                    progress: current.progress,
                    targetLang: current.targetLang,
                    sourceMarkdown: current.sourceMarkdown,
                    rawSourceMarkdown: current.rawSourceMarkdown,
                    polishedSourceMarkdown: current.polishedSourceMarkdown,
                    targetMarkdown: current.targetMarkdown,
                    layoutJsonUrl: current.layoutJsonUrl,
                });

                if (current.status !== 'translating') {
                    void syncTargetLanguageView({
                        fallbackStatus,
                        fallbackProgress,
                        clearError: true,
                    });
                }
            },

            setTranslationQualityPreset: (preset) => {
                const nextPreset = TRANSLATION_QUALITY_PRESETS[preset];
                set({ translationQualityPreset: preset });
                get().setProvider(nextPreset.providerId, nextPreset.model);
            },

            setAssistProvider: (providerId, model) => {
                set({ assistProviderId: providerId, assistModel: model });
            },

            saveEditedTranslation: (editedMarkdown) => {
                const current = get();
                const nextStatus = current.sourceMarkdown.trim() ? 'completed' : current.status;
                const nextProgress = current.sourceMarkdown.trim() ? 100 : current.progress;

                set({
                    targetMarkdown: editedMarkdown,
                    translationBlocks: [],
                    error: null,
                    translationStatus: '已保存编辑',
                    translationPhase: 'completed',
                    translationLastEventAt: Date.now(),
                    status: current.status === 'translating' ? current.status : nextStatus,
                    progress: current.status === 'translating' ? current.progress : nextProgress,
                    resumableTranslation: null,
                });

                const latest = get();
                if (!latest.fileHash) return;

                void saveSessionSnapshot({
                    id: `${latest.fileHash}::${latest.targetLang}`,
                    fileHash: latest.fileHash,
                    fileName: latest.file?.name || latest.activeFileName || 'unknown.pdf',
                    status: latest.status,
                    progress: latest.progress,
                    targetLang: latest.targetLang,
                    providerId: latest.providerId,
                    model: latest.model,
                    updatedAt: Date.now(),
                });
                void persistActiveDocumentSnapshot({
                    fileHash: latest.fileHash,
                    fileName: latest.activeFileName,
                    status: latest.status,
                    progress: latest.progress,
                    targetLang: latest.targetLang,
                    sourceMarkdown: latest.sourceMarkdown,
                    rawSourceMarkdown: latest.rawSourceMarkdown,
                    polishedSourceMarkdown: latest.polishedSourceMarkdown,
                    targetMarkdown: editedMarkdown,
                    layoutJsonUrl: latest.layoutJsonUrl,
                });
            },

            setHighlightedBlock: (blockId) => set({ highlightedBlockId: blockId }),

            setKeys: (mineruKey, googleKey) => set({ mineruApiKey: mineruKey, googleApiKey: googleKey }),

            setTargetLang: (lang) => {
                const previous = get();
                const fallbackStatus = previous.sourceMarkdown.trim() ? 'parsed' : previous.status;
                const fallbackProgress = previous.sourceMarkdown.trim() ? 60 : previous.progress;

                set({
                    targetLang: lang,
                    targetMarkdown: '',
                    translationBlocks: [],
                    error: null,
                    translationStatus: '',
                    translationPhase: 'idle',
                    translationLastEventAt: null,
                    resumableTranslation: null,
                    status: previous.status === 'translating' ? previous.status : fallbackStatus,
                    progress: previous.status === 'translating' ? previous.progress : fallbackProgress,
                });
                const current = get();
                if (!current.fileHash) return;

                void saveSessionSnapshot({
                    id: `${current.fileHash}::${lang}`,
                    fileHash: current.fileHash,
                    fileName: current.file?.name || 'unknown.pdf',
                    status: current.status,
                    progress: current.progress,
                    targetLang: lang,
                    providerId: current.providerId,
                    model: current.model,
                    updatedAt: Date.now(),
                });
                void persistActiveDocumentSnapshot({
                    fileHash: current.fileHash,
                    fileName: current.activeFileName,
                    status: current.status,
                    progress: current.progress,
                    targetLang: lang,
                    sourceMarkdown: current.sourceMarkdown,
                    rawSourceMarkdown: current.rawSourceMarkdown,
                    polishedSourceMarkdown: current.polishedSourceMarkdown,
                    targetMarkdown: current.targetMarkdown,
                    layoutJsonUrl: current.layoutJsonUrl,
                });

                void syncTargetLanguageView({
                    targetLang: lang,
                    fallbackStatus,
                    fallbackProgress,
                    clearError: true,
                });
            },

            setFile: (file) => {
                paperPolishAbortController?.abort();
                paperPolishAbortController = null;
                clearPaperPolishProgressTimer();
                const previousUrl = get().fileUrl;
                if (previousUrl?.startsWith('blob:')) {
                    URL.revokeObjectURL(previousUrl);
                }

                const url = file ? URL.createObjectURL(file) : null;
                set({
                    file,
                    fileUrl: url,
                    activeFileName: file?.name || null,
                    status: 'idle',
                    error: null,
                    progress: 0,
                    translationStatus: '',
                    translationPhase: 'idle',
                    translationLastEventAt: null,
                    translationConcurrency: 1,
                    fileHash: null,
                    batchId: null,
                    layoutUrl: null,
                    layoutJsonUrl: null,
                    sourceMarkdown: '',
                    rawSourceMarkdown: '',
                    polishedSourceMarkdown: '',
                    targetMarkdown: '',
                    translationBlocks: [],
                    translationRunId: null,
                    paperPolishStatus: 'idle',
                    paperPolishMode: null,
                    paperPolishProgress: 0,
                    paperPolishMessage: '',
                    paperPolishSummary: [],
                    paperPolishIssues: [],
                    paperPolishResidualIssues: [],
                    paperPolishIssueWindows: [],
                    paperPolishCanUseAiFallback: false,
                    paperPolishUndoSnapshot: null,
                    paperPolishUndoExpiresAt: null,
                });
            },

            importFromArxiv: async (input: string) => {
                set({
                    ...createEmptyDocumentWorkspaceState(),
                    file: null,
                    fileUrl: null,
                    activeFileName: null,
                    fileHash: null,
                    batchId: null,
                    status: 'uploading',
                    progress: 5,
                });

                try {
                    const response = await fetch('/api/arxiv/import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ input }),
                    });

                    const data = await response.json();
                    if (!response.ok) {
                        throw new Error(data.error || 'Failed to import arXiv paper');
                    }

                    const importedFileName = data.fileName || `${data.metadata?.arxivId || 'arxiv-paper'}.pdf`;
                    const originalPdfUrl = await resolveOptionalMediaUrl(data.fileHash, 'original.pdf');

                    if (data.status === 'cached') {
                        const parsedState = getParsedMarkdownState(data.markdown || '');
                        set({
                            file: null,
                            activeFileName: importedFileName,
                            status: 'parsed',
                            translationStatus: '',
                            translationPhase: 'idle',
                            translationLastEventAt: null,
                            translationConcurrency: 1,
                            sourceMarkdown: parsedState.sourceMarkdown,
                            rawSourceMarkdown: parsedState.rawSourceMarkdown,
                            polishedSourceMarkdown: parsedState.polishedSourceMarkdown,
                            targetMarkdown: '',
                            translationBlocks: [],
                            translationRunId: null,
                            fileHash: data.fileHash,
                            fileUrl: originalPdfUrl,
                            progress: 60,
                            layoutUrl: data.layoutUrl || null,
                            layoutJsonUrl: data.layoutJsonUrl || null,
                            paperPolishStatus: 'idle',
                            paperPolishMode: null,
                            paperPolishProgress: 0,
                            paperPolishMessage: '',
                            paperPolishSummary: parsedState.summary,
                            paperPolishIssues: parsedState.issues,
                            paperPolishResidualIssues: [],
                            paperPolishIssueWindows: [],
                            paperPolishCanUseAiFallback: false,
                            paperPolishUndoSnapshot: null,
                            paperPolishUndoExpiresAt: null,
                        });
                        void persistActiveDocumentSnapshot({
                            fileHash: data.fileHash,
                            fileName: importedFileName,
                            status: 'parsed',
                            progress: 60,
                            targetLang: get().targetLang,
                            sourceMarkdown: parsedState.sourceMarkdown,
                            rawSourceMarkdown: parsedState.rawSourceMarkdown,
                            polishedSourceMarkdown: parsedState.polishedSourceMarkdown,
                            targetMarkdown: '',
                            layoutJsonUrl: data.layoutJsonUrl || null,
                        });

                        get().addToHistory({
                            fileHash: data.fileHash,
                            fileName: importedFileName,
                            status: 'parsed',
                            progress: 60
                        });
                        void syncTargetLanguageView({
                            fallbackStatus: 'parsed',
                            fallbackProgress: 60,
                            clearError: true,
                        });
                        return;
                    }

                    set({
                        ...createEmptyDocumentWorkspaceState(),
                        file: null,
                        activeFileName: importedFileName,
                        status: 'parsing',
                        batchId: data.batchId,
                        fileHash: data.fileHash,
                        fileUrl: originalPdfUrl,
                        progress: 30,
                    });
                    void persistActiveDocumentSnapshot({
                        fileHash: data.fileHash,
                        fileName: importedFileName,
                        status: 'parsing',
                        progress: 30,
                        targetLang: get().targetLang,
                        sourceMarkdown: '',
                        rawSourceMarkdown: '',
                        polishedSourceMarkdown: '',
                        targetMarkdown: '',
                        layoutJsonUrl: null,
                    });

                    get().addToHistory({
                        fileHash: data.fileHash,
                        fileName: importedFileName,
                        status: 'parsing',
                        progress: 30
                    });

                    get().pollStatus();
                } catch (e: unknown) {
                    const message = getErrorMessage(e);
                    set({ status: 'error', error: message });
                    throw new Error(message);
                }
            },

            startUpload: async () => {
                const { file } = get();
                if (!file) return;

                set({
                    ...createEmptyDocumentWorkspaceState(),
                    file,
                    fileUrl: get().fileUrl,
                    activeFileName: file.name,
                    status: 'uploading',
                    progress: 10,
                    fileHash: null,
                    batchId: null,
                });

                try {
                    const formData = new FormData();
                    formData.append('file', file);

                    const res = await fetch('/api/upload', {
                        method: 'POST',
                        body: formData,
                    });

                    const data = await res.json();

                    if (!res.ok) throw new Error(data.error || 'Upload failed');
                    const originalPdfUrl = await resolveOptionalMediaUrl(data.fileHash || null, 'original.pdf');

                    // Handle Cache Hit
                    if (data.status === 'cached') {
                        console.log('Cache hit! Skipping parsing.');
                        const parsedState = getParsedMarkdownState(data.markdown || '');
                        set({
                            status: 'parsed',
                            activeFileName: file.name,
                            translationStatus: '',
                            translationPhase: 'idle',
                            translationLastEventAt: null,
                            translationConcurrency: 1,
                            sourceMarkdown: parsedState.sourceMarkdown,
                            rawSourceMarkdown: parsedState.rawSourceMarkdown,
                            polishedSourceMarkdown: parsedState.polishedSourceMarkdown,
                            targetMarkdown: '',
                            translationBlocks: [],
                            translationRunId: null,
                            fileHash: data.fileHash,
                            fileUrl: originalPdfUrl,
                            progress: 60,
                            layoutUrl: data.layoutUrl || null,
                            layoutJsonUrl: data.layoutJsonUrl || null,
                            paperPolishStatus: 'idle',
                            paperPolishMode: null,
                            paperPolishProgress: 0,
                            paperPolishMessage: '',
                            paperPolishSummary: parsedState.summary,
                            paperPolishIssues: parsedState.issues,
                            paperPolishResidualIssues: [],
                            paperPolishIssueWindows: [],
                            paperPolishCanUseAiFallback: false,
                            paperPolishUndoSnapshot: null,
                            paperPolishUndoExpiresAt: null,
                        });
                        void persistActiveDocumentSnapshot({
                            fileHash: data.fileHash,
                            fileName: file.name,
                            status: 'parsed',
                            progress: 60,
                            targetLang: get().targetLang,
                            sourceMarkdown: parsedState.sourceMarkdown,
                            rawSourceMarkdown: parsedState.rawSourceMarkdown,
                            polishedSourceMarkdown: parsedState.polishedSourceMarkdown,
                            targetMarkdown: '',
                            layoutJsonUrl: data.layoutJsonUrl || null,
                        });

                        get().addToHistory({
                            fileHash: data.fileHash,
                            fileName: file.name,
                            status: 'parsed',
                            progress: 60
                        });
                        void syncTargetLanguageView({
                            fallbackStatus: 'parsed',
                            fallbackProgress: 60,
                            clearError: true,
                        });
                        return;
                    }

                    // Handle New Upload
                    set({
                        ...createEmptyDocumentWorkspaceState(),
                        file,
                        status: 'parsing',
                        activeFileName: file.name,
                        batchId: data.batchId,
                        fileHash: data.fileHash,
                        fileUrl: originalPdfUrl,
                        progress: 30,
                    });
                    void persistActiveDocumentSnapshot({
                        fileHash: data.fileHash,
                        fileName: file.name,
                        status: 'parsing',
                        progress: 30,
                        targetLang: get().targetLang,
                        sourceMarkdown: '',
                        rawSourceMarkdown: '',
                        polishedSourceMarkdown: '',
                        targetMarkdown: '',
                        layoutJsonUrl: null,
                    });

                    get().addToHistory({
                        fileHash: data.fileHash,
                        fileName: file.name, // Use file.name here as file is ensured not null
                        status: 'parsing',
                        progress: 30
                    });

                    // Start polling
                    get().pollStatus();

                } catch (e: unknown) {
                    set({ status: 'error', error: getErrorMessage(e) });
                }
            },

            pollStatus: async () => {
                const { batchId, file, fileHash, activeFileName } = get();
                if (!batchId) return;

                const interval = setInterval(async () => {
                    try {
                        const originalPdfUrl = await resolveOptionalMediaUrl(fileHash, 'original.pdf');
                        const params = new URLSearchParams({
                            batchId,
                            fileName: activeFileName || file?.name || 'unknown.pdf',
                        });
                        if (fileHash) params.append('fileHash', fileHash);

                        const res = await fetch(`/api/status?${params.toString()}`);
                        const data = await res.json();

                        if (data.state === 'running') {
                            const newProgress = 30 + (data.progress * 0.4);
                            set({ progress: newProgress });
                            const current = get();
                            void persistActiveDocumentSnapshot({
                                fileHash: current.fileHash,
                                fileName: current.activeFileName || current.file?.name || 'unknown.pdf',
                                status: 'parsing',
                                progress: newProgress,
                                targetLang: current.targetLang,
                                sourceMarkdown: current.sourceMarkdown,
                                rawSourceMarkdown: current.rawSourceMarkdown,
                                polishedSourceMarkdown: current.polishedSourceMarkdown,
                                targetMarkdown: current.targetMarkdown,
                                layoutJsonUrl: current.layoutJsonUrl,
                            });
                            if (fileHash) {
                                get().addToHistory({
                                    fileHash,
                                    fileName: activeFileName || file?.name || 'unknown.pdf',
                                    status: 'parsing',
                                    progress: newProgress
                                });
                            }
                        } else if (data.state === 'done') {
                            clearInterval(interval);
                            const parsedState = getParsedMarkdownState(data.markdown || '');
                            set({
                                status: 'parsed',
                                batchId: null,
                                sourceMarkdown: parsedState.sourceMarkdown,
                                rawSourceMarkdown: parsedState.rawSourceMarkdown,
                                polishedSourceMarkdown: parsedState.polishedSourceMarkdown,
                                progress: 60,
                                layoutUrl: data.layoutUrl || null,
                                layoutJsonUrl: data.layoutJsonUrl || null,
                                paperPolishStatus: 'idle',
                                paperPolishMode: null,
                                paperPolishProgress: 0,
                                paperPolishMessage: '',
                                paperPolishSummary: parsedState.summary,
                                paperPolishIssues: parsedState.issues,
                                paperPolishResidualIssues: [],
                                paperPolishIssueWindows: [],
                                paperPolishCanUseAiFallback: false,
                                paperPolishUndoSnapshot: null,
                                paperPolishUndoExpiresAt: null,
                            });
                            const current = get();
                            void persistActiveDocumentSnapshot({
                                fileHash: current.fileHash,
                                fileName: current.activeFileName || current.file?.name || 'unknown.pdf',
                                status: 'parsed',
                                progress: 60,
                                targetLang: current.targetLang,
                                sourceMarkdown: parsedState.sourceMarkdown,
                                rawSourceMarkdown: parsedState.rawSourceMarkdown,
                                polishedSourceMarkdown: parsedState.polishedSourceMarkdown,
                                targetMarkdown: current.targetMarkdown,
                                layoutJsonUrl: data.layoutJsonUrl || null,
                            });
                            if (fileHash) {
                                get().addToHistory({
                                    fileHash,
                                    fileName: activeFileName || file?.name || 'unknown.pdf',
                                    status: 'parsed',
                                    progress: 60
                                });
                            }
                            void syncTargetLanguageView({
                                fallbackStatus: 'parsed',
                                fallbackProgress: 60,
                                clearError: true,
                            });
                        } else if (data.state === 'failed') {
                            clearInterval(interval);
                            set({
                                ...createEmptyDocumentWorkspaceState(),
                                file,
                                fileHash,
                                batchId,
                                fileUrl: originalPdfUrl || get().fileUrl,
                                activeFileName: activeFileName || file?.name || null,
                                status: 'error',
                                error: data.error || 'Parsing failed',
                                progress: 0,
                            });
                            const current = get();
                            void persistActiveDocumentSnapshot({
                                fileHash: current.fileHash,
                                fileName: current.activeFileName || current.file?.name || 'unknown.pdf',
                                status: 'error',
                                progress: 0,
                                targetLang: current.targetLang,
                                sourceMarkdown: current.sourceMarkdown,
                                rawSourceMarkdown: current.rawSourceMarkdown,
                                polishedSourceMarkdown: current.polishedSourceMarkdown,
                                targetMarkdown: current.targetMarkdown,
                                layoutJsonUrl: current.layoutJsonUrl,
                            });
                            if (fileHash) {
                                get().addToHistory({
                                    fileHash,
                                    fileName: activeFileName || file?.name || 'unknown.pdf',
                                    status: 'error',
                                    progress: 0
                                });
                            }
                        }
                    } catch (e: unknown) {
                        clearInterval(interval);
                        const current = get();
                        set({
                            ...createEmptyDocumentWorkspaceState(),
                            file: current.file,
                            fileHash: current.fileHash,
                            batchId: current.batchId,
                            fileUrl: await resolveOptionalMediaUrl(current.fileHash, 'original.pdf') || current.fileUrl,
                            activeFileName: current.activeFileName,
                            status: 'error',
                            error: getErrorMessage(e),
                            progress: 0,
                        });
                    }
                }, 3000); // 3 seconds polling
            },

            checkResumable: async () => {
                const { sourceMarkdown, targetLang, fileHash, providerId, model } = get();
                if (!fileHash || !sourceMarkdown) {
                    set({ resumableTranslation: null });
                    return;
                }

                try {
                    const { providerProfile, glossaryTerms } = await resolveTranslationRuntimeCacheState({
                        fileHash,
                        targetLang,
                        providerId,
                        model,
                    });
                    const response = await fetch('/api/translate/check-resume', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            fileHash,
                            targetLang,
                            sourceMarkdown,
                            providerId,
                            model,
                            providerProfile,
                            extraTerms: glossaryTerms,
                        })
                    });

                    const data = await response.json();

                    if (data.canResume) {
                        set({
                            resumableTranslation: {
                                canResume: true,
                                completedChunks: data.completedChunks,
                                totalChunks: data.totalChunks,
                                percentage: data.percentage,
                                jobId: typeof data.jobId === 'string' ? data.jobId : null,
                            }
                        });
                    } else {
                        set({
                            resumableTranslation: data.reason === 'active_job'
                                ? {
                                    canResume: false,
                                    completedChunks: typeof data.completedChunks === 'number' ? data.completedChunks : 0,
                                    totalChunks: typeof data.totalChunks === 'number' ? data.totalChunks : 0,
                                    percentage: typeof data.percentage === 'number' ? data.percentage : 0,
                                    activeJobId: typeof data.activeJobId === 'string' ? data.activeJobId : null,
                                }
                                : null
                        });
                    }
                } catch (e) {
                    console.error('[CheckResumable] Error:', e);
                    set({ resumableTranslation: null });
                }
            },

            resumeTranslation: async () => {
                set({ resumableTranslation: null });
                await get().performTranslation(true);
            },

            restartTranslation: async () => {
                set({ resumableTranslation: null });
                await get().performTranslation(false, true);
            },

            retryParsing: async () => {
                const current = get();

                if (current.batchId && current.fileHash) {
                    const originalPdfUrl = await resolveOptionalMediaUrl(current.fileHash, 'original.pdf');
                    set({
                        ...createEmptyDocumentWorkspaceState(),
                        file: current.file,
                        activeFileName: current.activeFileName,
                        fileHash: current.fileHash,
                        batchId: current.batchId,
                        fileUrl: originalPdfUrl,
                        status: 'parsing',
                        progress: Math.max(30, current.progress || 30),
                    });
                    void persistActiveDocumentSnapshot({
                        fileHash: current.fileHash,
                        fileName: current.activeFileName || current.file?.name || 'unknown.pdf',
                        status: 'parsing',
                        progress: Math.max(30, current.progress || 30),
                        targetLang: current.targetLang,
                        sourceMarkdown: '',
                        rawSourceMarkdown: '',
                        polishedSourceMarkdown: '',
                        targetMarkdown: '',
                        layoutJsonUrl: null,
                    });
                    get().pollStatus();
                    return;
                }

                if (current.file) {
                    await get().startUpload();
                    return;
                }

                set({
                    status: 'error',
                    error: '当前任务没有可恢复的解析批次，请重新上传 PDF 或重新导入 arXiv。',
                });
            },

            clearResumable: () => {
                set({ resumableTranslation: null });
            },

            startTranslation: async () => {
                await get().performTranslation(false);
            },

            performTranslation: async (resume: boolean, forceFresh: boolean = false) => {
                const currentSnapshot = get();
                if (currentSnapshot.status === 'translating') {
                    console.warn('[Translation] Ignoring duplicate start while a translation stream is already active');
                    return;
                }

                const {
                    sourceMarkdown,
                    targetLang,
                    providerId,
                    model,
                    fileHash,
                    file,
                    activeFileName,
                    resumableTranslation,
                } = currentSnapshot;
                if (!sourceMarkdown) return;
                const requestedJobId = resume && resumableTranslation?.jobId
                    ? resumableTranslation.jobId
                    : createTranslationJobId();
                const requestToken = `${requestedJobId}:${Date.now()}`;
                activeTranslationRequestToken = requestToken;
                const isActiveRequest = () => activeTranslationRequestToken === requestToken;

                const userTerms = await listUserGlossaryRecords();
                const enabledUserTerms = userTerms
                    .filter((term) => term.enabled)
                    .map((term) => ({
                        source: term.source,
                        target: term.target,
                        category: term.category,
                    }));
                const providerProfile = providerId.startsWith('custom:')
                    ? await getProviderProfile(providerId.slice('custom:'.length))
                    : undefined;

                set({
                    status: 'translating',
                    progress: 0,
                    targetMarkdown: '',
                    translationBlocks: [],
                    translationRunId: requestedJobId,
                    translationStatus: resume
                        ? '正在恢复翻译任务...'
                        : (forceFresh ? '正在清理旧译文并重新翻译...' : '准备翻译任务...'),
                    translationPhase: 'preparing',
                    translationLastEventAt: Date.now(),
                    translationConcurrency: 1,
                    error: null,
                });
                void persistActiveDocumentSnapshot({
                    fileHash,
                    fileName: activeFileName || file?.name || 'unknown.pdf',
                    status: 'translating',
                    progress: 0,
                    targetLang,
                    sourceMarkdown,
                    rawSourceMarkdown: get().rawSourceMarkdown,
                    polishedSourceMarkdown: get().polishedSourceMarkdown,
                    targetMarkdown: '',
                    layoutJsonUrl: get().layoutJsonUrl,
                });

                if (fileHash) {
                    get().addToHistory({
                        fileHash,
                        fileName: activeFileName || file?.name || 'unknown.pdf',
                        status: 'translating',
                        progress: 0
                    });
                }

                const abortController = new AbortController();
                let stallWarningTimer: ReturnType<typeof setTimeout> | null = null;
                let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
                let markdownFlushTimer: ReturnType<typeof setTimeout> | null = null;
                let snapshotPersistTimer: ReturnType<typeof setTimeout> | null = null;
                let chunkStateFlushTimer: ReturnType<typeof setTimeout> | null = null;
                let sawTerminalEvent = false;
                let hardTimeoutTriggered = false;
                let lastTranslationHeartbeatAt = Date.now();
                const pendingChunkMutations = new Map<string, PendingChunkMutation>();

                const clearStreamTimers = () => {
                    if (stallWarningTimer) {
                        clearTimeout(stallWarningTimer);
                        stallWarningTimer = null;
                    }
                    if (hardTimeoutTimer) {
                        clearTimeout(hardTimeoutTimer);
                        hardTimeoutTimer = null;
                    }
                };

                const clearTranslationFlushTimers = () => {
                    if (markdownFlushTimer) {
                        clearTimeout(markdownFlushTimer);
                        markdownFlushTimer = null;
                    }
                    if (snapshotPersistTimer) {
                        clearTimeout(snapshotPersistTimer);
                        snapshotPersistTimer = null;
                    }
                    if (chunkStateFlushTimer) {
                        clearTimeout(chunkStateFlushTimer);
                        chunkStateFlushTimer = null;
                    }
                };

                const flushTargetMarkdownFromBlocks = () => {
                    const nextTargetMarkdown = buildMarkdownFromTranslationBlocks(get().translationBlocks);
                    if (get().targetMarkdown !== nextTargetMarkdown) {
                        set({ targetMarkdown: nextTargetMarkdown });
                    }
                    return nextTargetMarkdown;
                };

                const persistTranslationSnapshot = (
                    snapshotStatus: TaskStatus,
                    snapshotProgress: number,
                    nextTargetMarkdown?: string
                ) => {
                    void persistActiveDocumentSnapshot({
                        fileHash,
                        fileName: activeFileName || file?.name || 'unknown.pdf',
                        status: snapshotStatus,
                        progress: snapshotProgress,
                        targetLang,
                        sourceMarkdown,
                        rawSourceMarkdown: get().rawSourceMarkdown,
                        polishedSourceMarkdown: get().polishedSourceMarkdown,
                        targetMarkdown: nextTargetMarkdown ?? get().targetMarkdown,
                        layoutJsonUrl: get().layoutJsonUrl,
                    });
                };

                const scheduleTargetMarkdownFlush = () => {
                    if (markdownFlushTimer) return;

                    markdownFlushTimer = setTimeout(() => {
                        markdownFlushTimer = null;
                        flushTargetMarkdownFromBlocks();
                    }, 180);
                };

                const scheduleTranslationSnapshotPersist = () => {
                    if (snapshotPersistTimer) return;

                    snapshotPersistTimer = setTimeout(() => {
                        snapshotPersistTimer = null;
                        const nextTargetMarkdown = flushTargetMarkdownFromBlocks();
                        persistTranslationSnapshot('translating', get().progress, nextTargetMarkdown);
                    }, 2000);
                };

                const flushPendingChunkMutations = () => {
                    if (chunkStateFlushTimer) {
                        clearTimeout(chunkStateFlushTimer);
                        chunkStateFlushTimer = null;
                    }

                    if (pendingChunkMutations.size === 0) return;

                    const pendingEntries = Array.from(pendingChunkMutations.entries());
                    pendingChunkMutations.clear();

                    set((state) => {
                        let nextBlocks = state.translationBlocks;
                        let changed = false;

                        for (const [chunkId, mutation] of pendingEntries) {
                            const blockIndex = nextBlocks.findIndex((block) => block.id === chunkId);

                            if (blockIndex >= 0) {
                                const currentBlock = nextBlocks[blockIndex];
                                const nextText = mutation.mode === 'replace'
                                    ? mutation.text
                                    : currentBlock.text + mutation.text;

                                if (
                                    nextText === currentBlock.text &&
                                    currentBlock.state === 'streaming'
                                ) {
                                    continue;
                                }

                                if (!changed) {
                                    nextBlocks = [...nextBlocks];
                                    changed = true;
                                }

                                nextBlocks[blockIndex] = {
                                    ...currentBlock,
                                    text: nextText,
                                    state: currentBlock.state === 'cached' ? 'cached' : 'streaming',
                                };
                                continue;
                            }

                            const nextBlock: TranslationMarkdownBlock = {
                                id: chunkId,
                                index: nextBlocks.length,
                                title: mutation.title || `Chunk ${nextBlocks.length + 1}`,
                                kind: 'text',
                                text: mutation.text,
                                state: 'streaming',
                            };

                            nextBlocks = [...nextBlocks, nextBlock];
                            changed = true;
                        }

                        if (!changed) {
                            // blocks 无实质变化，整个 set 回调返回原 state 对象，
                            // Zustand 会跳过通知，下游订阅者完全不重渲染。
                            return state;
                        }

                        return {
                            translationBlocks: nextBlocks,
                            translationPhase: 'streaming' as const,
                            // 仅在 blocks 真正变化时才更新心跳时间戳，
                            // 避免无意义的 translationLastEventAt 写入触发额外订阅。
                            translationLastEventAt: lastTranslationHeartbeatAt,
                        };
                    });

                    scheduleTargetMarkdownFlush();
                    scheduleTranslationSnapshotPersist();
                };

                const scheduleChunkStateFlush = () => {
                    if (chunkStateFlushTimer) return;

                    chunkStateFlushTimer = setTimeout(() => {
                        chunkStateFlushTimer = null;
                        flushPendingChunkMutations();
                        // Clear the pretext layout engine cache every 120ms tick.
                        // During live streaming, non-spaced languages (like CJK or code) will force word segmenters
                        // to continuously allocate new segment width measurements. Over thousands of stream ticks,
                        // this causes massive memory leaks (GBs) if left unbounded.
                        clearPretextEngineCache();
                    }, 120);
                };

                const flushTranslationArtifacts = (snapshotStatus: TaskStatus, snapshotProgress: number) => {
                    flushPendingChunkMutations();
                    clearTranslationFlushTimers();
                    const nextTargetMarkdown = flushTargetMarkdownFromBlocks();
                    persistTranslationSnapshot(snapshotStatus, snapshotProgress, nextTargetMarkdown);
                    return nextTargetMarkdown;
                };

                const scheduleStreamTimers = () => {
                    clearStreamTimers();
                    stallWarningTimer = setTimeout(() => {
                        set((state) => ({
                            translationStatus: state.status === 'translating'
                                ? `翻译耗时较长（>${Math.round(TRANSLATION_STREAM_STALL_WARNING_MS / 1000)} 秒），仍在等待模型返回...`
                                : state.translationStatus,
                            translationLastEventAt: Date.now(),
                        }));
                    }, TRANSLATION_STREAM_STALL_WARNING_MS);
                    hardTimeoutTimer = setTimeout(() => {
                        hardTimeoutTriggered = true;
                        abortController.abort('translation-stream-hard-timeout');
                    }, TRANSLATION_STREAM_HARD_TIMEOUT_MS);
                };

                const markTranslationActivity = (updates?: Partial<Pick<TranslationState, 'translationStatus' | 'translationPhase' | 'translationConcurrency'>>) => {
                    const timestamp = Date.now();
                    lastTranslationHeartbeatAt = timestamp;

                    if (updates) {
                        set((state) => ({
                            translationLastEventAt: timestamp,
                            translationStatus: updates.translationStatus ?? state.translationStatus,
                            translationPhase: updates.translationPhase ?? state.translationPhase,
                            translationConcurrency: updates.translationConcurrency ?? state.translationConcurrency,
                        }));
                    }

                    scheduleStreamTimers();
                };

                try {
                    const response = await fetch('/api/translate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: abortController.signal,
                        body: JSON.stringify({
                            text: sourceMarkdown,
                            targetLang,
                            providerId,
                            model,
                            providerProfile,
                            fileHash,
                            resume,
                            forceFresh,
                            extraTerms: enabledUserTerms,
                            jobId: requestedJobId,
                        }),
                    });

                    if (!response.ok) {
                        try {
                            const errorData = await response.json();
                            throw new Error(errorData.error || 'Translation failed');
                        } catch {
                            throw new Error('Translation failed');
                        }
                    }

                    const reader = response.body?.getReader();
                    const decoder = new TextDecoder('utf-8');

                    if (!reader) {
                        throw new Error('Translation stream is unavailable');
                    }

                    let buffer = "";
                    scheduleStreamTimers();

                    while (true) {
                        if (!isActiveRequest()) {
                            await reader.cancel();
                            break;
                        }

                        const { done, value } = await reader.read();
                        if (done) break;

                        scheduleStreamTimers();
                        lastTranslationHeartbeatAt = Date.now();
                        buffer += decoder.decode(value, { stream: true });
                        const events = buffer.split('\n\n');
                        buffer = events.pop() || "";

                        for (const event of events) {
                            if (!event.startsWith('data: ')) continue;
                            const jsonStr = event.substring(6);
                            try {
                                if (!isActiveRequest()) {
                                    break;
                                }
                                const data = JSON.parse(jsonStr);
                                switch (data.type) {
                                    case 'run_started': {
                                        const plannedBlocks = Array.isArray(data.chunks)
                                            ? createTranslationBlocksFromPlan(data.chunks as TranslationChunkPlan[])
                                            : [];
                                        const concurrency = typeof data.concurrency === 'number' ? data.concurrency : 1;

                                        set({
                                            translationRunId: typeof data.runId === 'string' ? data.runId : null,
                                            translationBlocks: plannedBlocks,
                                            targetMarkdown: '',
                                            translationConcurrency: concurrency,
                                            translationPhase: plannedBlocks.length > 0 ? 'chunking' : 'preparing',
                                            translationStatus: plannedBlocks.length > 0
                                                ? `已拆分 ${plannedBlocks.length} 段，准备${concurrency > 1 ? `并发 ${concurrency} 路翻译` : '进入翻译'}`
                                                : '准备翻译任务...',
                                            translationLastEventAt: Date.now(),
                                        });
                                        break;
                                    }
                                    case 'hydrate_blocks': {
                                        const hydratedBlocks = Array.isArray(data.blocks)
                                            ? (data.blocks as TranslationMarkdownBlock[])
                                            : [];

                                        set((state) => {
                                            if (state.translationBlocks.length === 0) {
                                                return {
                                                    translationBlocks: hydratedBlocks,
                                                    targetMarkdown: buildMarkdownFromTranslationBlocks(hydratedBlocks),
                                                    translationLastEventAt: Date.now(),
                                                };
                                            }

                                            const hydratedMap = new Map(hydratedBlocks.map((block) => [block.id, block]));
                                            const nextBlocks = state.translationBlocks.map((block) => hydratedMap.get(block.id) || block);
                                            return {
                                                translationBlocks: nextBlocks,
                                                targetMarkdown: buildMarkdownFromTranslationBlocks(nextBlocks),
                                                translationLastEventAt: Date.now(),
                                            };
                                        });
                                        markTranslationActivity({
                                            translationStatus: '已恢复历史分块，继续翻译中...',
                                            translationPhase: 'refining',
                                        });
                                        break;
                                    }
                                    case 'status':
                                        markTranslationActivity({
                                            translationStatus: localizeTranslationStatus(data.message, get().translationConcurrency),
                                            translationPhase: deriveTranslationPhase(data.message),
                                        });
                                        break;
                                    case 'chunk_started':
                                        set((state) => ({
                                            translationBlocks: state.translationBlocks.map((block) => (
                                                block.id === data.chunkId
                                                    ? { ...block, state: block.state === 'cached' ? 'cached' : 'streaming' }
                                                    : block
                                            )),
                                            translationStatus: data.title
                                                ? `${state.translationConcurrency > 1 ? `并发 ${state.translationConcurrency} 路翻译` : '正在翻译'} · ${data.title}`
                                                : state.translationStatus,
                                            translationPhase: 'streaming',
                                            translationLastEventAt: Date.now(),
                                        }));
                                        break;
                                    case 'progress':
                                        markTranslationActivity();
                                        set({ progress: data.percentage });
                                        break;
                                    case 'chunk':
                                        {
                                            const chunkId = typeof data.chunkId === 'string' ? data.chunkId : 'streaming-translation';
                                            const existing = pendingChunkMutations.get(chunkId);
                                            pendingChunkMutations.set(chunkId, {
                                                mode: existing?.mode === 'replace' ? 'replace' : 'append',
                                                text: existing
                                                    ? existing.mode === 'replace'
                                                        ? existing.text + (data.text || '')
                                                        : existing.text + (data.text || '')
                                                    : (data.text || ''),
                                                title: typeof data.title === 'string' ? data.title : existing?.title,
                                            });
                                            scheduleChunkStateFlush();
                                        }
                                        break;
                                    case 'chunk_reset':
                                        flushPendingChunkMutations();
                                        set((state) => {
                                            const chunkId = typeof data.chunkId === 'string' ? data.chunkId : null;
                                            if (!chunkId) {
                                                return {
                                                    translationLastEventAt: Date.now(),
                                                };
                                            }

                                            const hasPlannedBlock = state.translationBlocks.some((block) => block.id === chunkId);
                                            const nextBlocks: TranslationMarkdownBlock[] = hasPlannedBlock
                                                ? state.translationBlocks.map((block) => (
                                                    block.id === chunkId
                                                        ? {
                                                            ...block,
                                                            text: typeof data.text === 'string' ? data.text : block.text,
                                                            state: block.state === 'cached' ? 'cached' as const : 'streaming' as const,
                                                        }
                                                        : block
                                                ))
                                                : state.translationBlocks;
                                            const issueCount = Array.isArray(data.issues) ? data.issues.length : 0;

                                            return {
                                                translationBlocks: nextBlocks,
                                                translationStatus: issueCount > 0
                                                    ? `已自动修复当前分块的 ${issueCount} 处结构问题`
                                                    : state.translationStatus,
                                                translationPhase: 'streaming',
                                                translationLastEventAt: Date.now(),
                                            };
                                        });
                                        scheduleTargetMarkdownFlush();
                                        scheduleTranslationSnapshotPersist();
                                        break;
                                    case 'chunk_completed':
                                        flushPendingChunkMutations();
                                        set((state) => {
                                            const nextBlocks: TranslationMarkdownBlock[] = state.translationBlocks.map((block) => (
                                                block.id === data.chunkId
                                                    ? { ...block, state: data.state === 'cached' ? 'cached' as const : 'completed' as const }
                                                    : block
                                            ));
                                            const completedCount = nextBlocks.filter((block) => block.state === 'completed' || block.state === 'cached').length;

                                            return {
                                                translationBlocks: nextBlocks,
                                                translationStatus: `已完成 ${completedCount}/${nextBlocks.length} 段`,
                                                translationPhase: 'streaming',
                                                translationLastEventAt: Date.now(),
                                            };
                                        });
                                        flushTranslationArtifacts('translating', get().progress);
                                        break;
                                    case 'done':
                                        sawTerminalEvent = true;
                                        clearStreamTimers();
                                        clearTranslationFlushTimers();
                                        set({
                                            status: 'completed',
                                            progress: 100,
                                            translationStatus: '翻译已完成',
                                            translationPhase: 'completed',
                                            translationLastEventAt: Date.now(),
                                        });
                                        flushTranslationArtifacts('completed', 100);
                                        if (fileHash) {
                                            get().addToHistory({
                                                fileHash,
                                                fileName: activeFileName || file?.name || 'unknown.pdf',
                                                status: 'completed',
                                                progress: 100
                                            });
                                        }
                                        break;
                                    case 'job_conflict':
                                        {
                                        sawTerminalEvent = true;
                                        clearStreamTimers();
                                        clearTranslationFlushTimers();
                                        const conflictMessage = typeof data.message === 'string' && data.message.trim()
                                            ? data.message
                                            : '相同配置的翻译任务已在其他标签页运行，请等待当前任务结束后再试。';
                                        const conflictJobId = typeof data.activeJob?.jobId === 'string'
                                            ? data.activeJob.jobId
                                            : null;
                                        const errorProgress = clampErrorProgress(get().progress);

                                        set({
                                            status: 'error',
                                            error: conflictMessage,
                                            progress: errorProgress,
                                            translationRunId: conflictJobId,
                                            translationStatus: '已有同配置翻译任务正在运行',
                                            translationPhase: 'stalled',
                                            translationLastEventAt: Date.now(),
                                        });
                                        flushTranslationArtifacts('error', errorProgress);
                                        await get().checkResumable();
                                        break;
                                        }
                                    case 'error':
                                        {
                                        const rawMessage = typeof data.message === 'string' && data.message.trim()
                                            ? data.message
                                            : '翻译失败';
                                        const isRateLimited = isRateLimitErrorMessage(rawMessage);
                                        const errorProgress = clampErrorProgress(get().progress);
                                        sawTerminalEvent = true;
                                        clearStreamTimers();
                                        clearTranslationFlushTimers();
                                        set({
                                            status: 'error',
                                            error: rawMessage,
                                            progress: errorProgress,
                                            translationStatus: isRateLimited
                                                ? '触发速率限制，翻译已暂停，可点击继续翻译'
                                                : '翻译失败',
                                            translationPhase: isRateLimited ? 'stalled' : 'error',
                                            translationLastEventAt: Date.now(),
                                        });
                                        flushTranslationArtifacts('error', errorProgress);
                                        await get().checkResumable();
                                        const canResume = Boolean(get().resumableTranslation?.canResume);
                                        if (isRateLimited && canResume) {
                                            set((state) => (
                                                state.status === 'error'
                                                    ? {
                                                        translationStatus: `速率受限（429），已暂停在 ${state.resumableTranslation?.percentage ?? errorProgress}%`,
                                                        translationPhase: 'stalled' as const,
                                                    }
                                                    : state
                                            ));
                                        }
                                        break;
                                        }
                                }
                            } catch (e) {
                                console.error('Error parsing SSE event:', e);
                            }
                        }
                    }

                    clearStreamTimers();
                    clearTranslationFlushTimers();

                    if (!sawTerminalEvent) {
                        const message = hardTimeoutTriggered
                            ? `翻译流长时间未返回数据（>${Math.round(TRANSLATION_STREAM_HARD_TIMEOUT_MS / 60000)} 分钟），已自动终止，请重试。`
                            : '翻译流意外中断，未收到完成信号，请重试。';
                        const errorProgress = clampErrorProgress(get().progress);
                        const isRateLimited = isRateLimitErrorMessage(message);

                        set({
                            status: 'error',
                            error: message,
                            progress: errorProgress,
                            translationStatus: hardTimeoutTriggered
                                ? '翻译流超时'
                                : (isRateLimited ? '触发速率限制，翻译已暂停' : '翻译连接已断开'),
                            translationPhase: hardTimeoutTriggered || isRateLimited ? 'stalled' : 'error',
                            translationLastEventAt: Date.now(),
                        });
                        flushTranslationArtifacts('error', errorProgress);
                        await get().checkResumable();
                        if (fileHash) {
                            get().addToHistory({
                                fileHash,
                                fileName: activeFileName || file?.name || 'unknown.pdf',
                                status: 'error',
                                progress: errorProgress
                            });
                        }
                    }
                } catch (e: unknown) {
                    clearStreamTimers();
                    clearTranslationFlushTimers();
                    const isAbort = e instanceof DOMException && e.name === 'AbortError';
                    const message = hardTimeoutTriggered
                        ? `翻译流长时间未返回数据（>${Math.round(TRANSLATION_STREAM_HARD_TIMEOUT_MS / 60000)} 分钟），已自动终止，请重试。`
                        : (isAbort ? '翻译请求已中止。' : getErrorMessage(e));
                    const isRateLimited = isRateLimitErrorMessage(message);
                    const errorProgress = clampErrorProgress(get().progress);

                    set({
                        status: 'error',
                        error: message,
                        progress: errorProgress,
                        translationStatus: hardTimeoutTriggered
                            ? '翻译流超时'
                            : (isRateLimited ? '触发速率限制，翻译已暂停' : '翻译失败'),
                        translationPhase: hardTimeoutTriggered || isRateLimited ? 'stalled' : 'error',
                        translationLastEventAt: Date.now(),
                    });
                    flushTranslationArtifacts('error', errorProgress);
                    await get().checkResumable();
                    const canResume = Boolean(get().resumableTranslation?.canResume);
                    if (isRateLimited && canResume) {
                        set((state) => (
                            state.status === 'error'
                                ? {
                                    translationStatus: `速率受限（429），已暂停在 ${state.resumableTranslation?.percentage ?? errorProgress}%`,
                                    translationPhase: 'stalled' as const,
                                }
                                : state
                        ));
                    }
                    if (fileHash) {
                        get().addToHistory({
                            fileHash,
                            fileName: activeFileName || file?.name || 'unknown.pdf',
                            status: 'error',
                            progress: errorProgress
                        });
                    }
                } finally {
                    if (isActiveRequest()) {
                        activeTranslationRequestToken = null;
                    }
                }
            },

            reset: () => {
                paperPolishAbortController?.abort();
                paperPolishAbortController = null;
                clearPaperPolishProgressTimer();
                const previousUrl = get().fileUrl;
                if (previousUrl?.startsWith('blob:')) {
                    URL.revokeObjectURL(previousUrl);
                }
                set({
                    file: null,
                    sourceMarkdown: '',
                    rawSourceMarkdown: '',
                    polishedSourceMarkdown: '',
                    targetMarkdown: '',
                    translationBlocks: [],
                    translationRunId: null,
                    translationStatus: '',
                    translationPhase: 'idle',
                    translationLastEventAt: null,
                    translationConcurrency: 1,
                    status: 'idle',
                    error: null,
                    progress: 0,
                    fileUrl: null,
                    batchId: null,
                    fileHash: null,
                    activeFileName: null,
                    layoutUrl: null,
                    layoutJsonUrl: null,
                    highlightedBlockId: null,
                    paperPolishStatus: 'idle',
                    paperPolishMode: null,
                    paperPolishProgress: 0,
                    paperPolishMessage: '',
                    paperPolishSummary: [],
                    paperPolishIssues: [],
                    paperPolishResidualIssues: [],
                    paperPolishIssueWindows: [],
                    paperPolishCanUseAiFallback: false,
                    paperPolishUndoSnapshot: null,
                    paperPolishUndoExpiresAt: null,
                });
            }
        });
        },
        {
            name: 'doti-storage',
            skipHydration: true,
            partialize: (state) => {
                const persistedStatus = getRecoveredTaskStatus({
                    previousStatus: state.status,
                    hasSourceMarkdown: Boolean(state.sourceMarkdown.trim()),
                    hasTargetMarkdown: Boolean(state.targetMarkdown.trim()),
                });

                return {
                    mineruApiKey: state.mineruApiKey,
                    googleApiKey: state.googleApiKey,
                    history: state.history.map(sanitizePersistedHistoryItem),
                    fileHash: state.fileHash,
                    batchId: state.batchId,
                    activeFileName: state.activeFileName,
                    status: persistedStatus,
                    progress: state.progress,
                    sourceMarkdown: state.sourceMarkdown,
                    rawSourceMarkdown: state.rawSourceMarkdown,
                    polishedSourceMarkdown: state.polishedSourceMarkdown,
                    targetMarkdown: state.targetMarkdown,
                    targetLang: state.targetLang,
                    translationQualityPreset: state.translationQualityPreset,
                    providerId: state.providerId,
                    model: state.model,
                    assistProviderId: state.assistProviderId,
                    assistModel: state.assistModel,
                    isZenMode: state.isZenMode,
                    paperPolishAutoEnabled: state.paperPolishAutoEnabled,
                    paperPolishSummary: state.paperPolishSummary,
                    paperPolishIssues: state.paperPolishIssues,
                    // fileUrl is reconstructed separately when needed
                    layoutUrl: state.layoutUrl,
                    layoutJsonUrl: state.layoutJsonUrl
                };
            },
        }
    )
);

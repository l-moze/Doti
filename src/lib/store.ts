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

export type TaskStatus = 'idle' | 'uploading' | 'parsing' | 'parsed' | 'translating' | 'completed' | 'error';
export type TranslationPhase = 'idle' | 'preparing' | 'chunking' | 'refining' | 'streaming' | 'stalled' | 'finalizing' | 'completed' | 'error';

const TRANSLATION_STREAM_STALL_WARNING_MS = 45000;
const TRANSLATION_STREAM_HARD_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSIENT_TASK_STATUSES: TaskStatus[] = ['uploading', 'parsing', 'translating'];

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
    targetMarkdown: string;
    translationBlocks: TranslationMarkdownBlock[];
    translationRunId: string | null;
    targetLang: string;
    layoutUrl: string | null;
    layoutJsonUrl: string | null;
    providerId: string;  // 'gemini' | 'deepseek' | 'glm' | 'ollama' | 'openai'
    model: string;
    assistProviderId: string;
    assistModel: string;
    translationStatus: string; // Agent status (e.g., 'chunking', 'translating')
    translationPhase: TranslationPhase;
    translationLastEventAt: number | null;
    translationConcurrency: number;

    // Resume Translation
    resumableTranslation: {
        canResume: boolean;
        completedChunks: number;
        totalChunks: number;
        percentage: number;
    } | null;
    checkResumable: () => Promise<void>;
    resumeTranslation: () => Promise<void>;
    restartTranslation: () => Promise<void>;
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
    reset: () => void;
    setTargetLang: (lang: string) => void;
    setProvider: (providerId: string, model: string) => void;
    setAssistProvider: (providerId: string, model: string) => void;
}

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

async function persistActiveDocumentSnapshot(input: {
    fileHash: string | null;
    fileName: string | null;
    status: TaskStatus;
    progress: number;
    targetLang: string;
    sourceMarkdown: string;
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
        targetMarkdown: input.targetMarkdown || undefined,
        layoutJsonUrl: input.layoutJsonUrl,
        lastOpenedAt: Date.now(),
    });
}

async function fetchStoredTranslationMarkdown(fileHash: string, targetLang: string): Promise<string> {
    try {
        const response = await fetch(`/api/media/${fileHash}/translation-${encodeURIComponent(targetLang)}.md`);
        if (!response.ok) return '';
        return await response.text();
    } catch (error) {
        console.warn('[Translation] Failed to load cached translation:', error);
        return '';
    }
}

export const useTranslationStore = create<TranslationState>()(
    persist(
        (set, get) => {
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
                const translationMarkdown = await fetchStoredTranslationMarkdown(snapshot.fileHash, nextTargetLang);
                const current = get();

                if (current.fileHash !== snapshot.fileHash || current.targetLang !== nextTargetLang) {
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
            targetMarkdown: '',
            translationBlocks: [],
            translationRunId: null,
            targetLang: 'Chinese',
            layoutUrl: null,
            layoutJsonUrl: null,
            providerId: 'gemini',
            model: 'gemini-2.5-flash',
            assistProviderId: 'gemini',
            assistModel: 'gemini-2.5-flash',
            translationStatus: '',
            translationPhase: 'idle',
            translationLastEventAt: null,
            translationConcurrency: 1,
            highlightedBlockId: null,
            history: [],
            resumableTranslation: null,
            isZenMode: false,

            toggleZenMode: () => set((state) => ({ isZenMode: !state.isZenMode })),

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
                    fileUrl: `/api/media/${hash}/original.pdf`,
                    sourceMarkdown: '',
                    targetMarkdown: '',
                    translationBlocks: [],
                    translationRunId: null,
                    layoutUrl: item.layoutUrl || null,
                    layoutJsonUrl: item.layoutJsonUrl || null,
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
                        set({
                            sourceMarkdown: cachedSnapshot.sourceMarkdown || '',
                            targetMarkdown: '',
                            translationBlocks: [],
                            layoutJsonUrl: cachedSnapshot.layoutJsonUrl || null,
                            layoutUrl: item.layoutUrl || null,
                        });
                        void markDocumentOpened(hash);
                    }

                    // Load source markdown (full.md)
                    const sourceRes = await fetch(`/api/media/${hash}/full.md`);
                    if (sourceRes.ok) {
                        const sourceText = await sourceRes.text();
                        set({ sourceMarkdown: sourceText });
                    }

                    // Check if layout files exist
                    const knownLayoutJsonUrl = get().layoutJsonUrl;
                    if (!knownLayoutJsonUrl) {
                        const layoutJsonRes = await fetch(`/api/media/${hash}/layout.json`, { method: 'HEAD' });
                        if (layoutJsonRes.ok) {
                            set({
                                layoutUrl: `/api/media/${hash}/layout.pdf`,
                                layoutJsonUrl: `/api/media/${hash}/layout.json`,
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
                set({ providerId, model });
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
                    targetMarkdown: current.targetMarkdown,
                    layoutJsonUrl: current.layoutJsonUrl,
                });
            },

            setAssistProvider: (providerId, model) => {
                set({ assistProviderId: providerId, assistModel: model });
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
                    targetMarkdown: '',
                    translationBlocks: [],
                    translationRunId: null,
                });
            },

            importFromArxiv: async (input: string) => {
                set({ status: 'uploading', progress: 5, error: null });

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

                    if (data.status === 'cached') {
                        set({
                            file: null,
                            activeFileName: importedFileName,
                            status: 'parsed',
                            translationStatus: '',
                            translationPhase: 'idle',
                            translationLastEventAt: null,
                            translationConcurrency: 1,
                            sourceMarkdown: data.markdown,
                            targetMarkdown: '',
                            translationBlocks: [],
                            translationRunId: null,
                            fileHash: data.fileHash,
                            fileUrl: `/api/media/${data.fileHash}/original.pdf`,
                            progress: 60,
                            layoutUrl: data.layoutUrl || null,
                            layoutJsonUrl: data.layoutJsonUrl || `/api/media/${data.fileHash}/layout.json`
                        });
                        void persistActiveDocumentSnapshot({
                            fileHash: data.fileHash,
                            fileName: importedFileName,
                            status: 'parsed',
                            progress: 60,
                            targetLang: get().targetLang,
                            sourceMarkdown: data.markdown,
                            targetMarkdown: '',
                            layoutJsonUrl: data.layoutJsonUrl || `/api/media/${data.fileHash}/layout.json`,
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
                        file: null,
                        activeFileName: importedFileName,
                        status: 'parsing',
                        translationStatus: '',
                        translationPhase: 'idle',
                        translationLastEventAt: null,
                        translationConcurrency: 1,
                        translationBlocks: [],
                        translationRunId: null,
                        batchId: data.batchId,
                        fileHash: data.fileHash,
                        fileUrl: `/api/media/${data.fileHash}/original.pdf`,
                        progress: 30,
                    });
                    void persistActiveDocumentSnapshot({
                        fileHash: data.fileHash,
                        fileName: importedFileName,
                        status: 'parsing',
                        progress: 30,
                        targetLang: get().targetLang,
                        sourceMarkdown: '',
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

                set({ status: 'uploading', progress: 10, error: null });

                try {
                    const formData = new FormData();
                    formData.append('file', file);

                    const res = await fetch('/api/upload', {
                        method: 'POST',
                        body: formData,
                    });

                    const data = await res.json();

                    if (!res.ok) throw new Error(data.error || 'Upload failed');

                    // Handle Cache Hit
                    if (data.status === 'cached') {
                        console.log('Cache hit! Skipping parsing.');
                        set({
                            status: 'parsed',
                            activeFileName: file.name,
                            translationStatus: '',
                            translationPhase: 'idle',
                            translationLastEventAt: null,
                            translationConcurrency: 1,
                            sourceMarkdown: data.markdown,
                            targetMarkdown: '',
                            translationBlocks: [],
                            translationRunId: null,
                            fileHash: data.fileHash,
                            fileUrl: `/api/media/${data.fileHash}/original.pdf`, // Switch to server URL
                            progress: 60,
                            layoutUrl: data.layoutUrl || null,
                            layoutJsonUrl: data.layoutJsonUrl || `/api/media/${data.fileHash}/layout.json`
                        });
                        void persistActiveDocumentSnapshot({
                            fileHash: data.fileHash,
                            fileName: file.name,
                            status: 'parsed',
                            progress: 60,
                            targetLang: get().targetLang,
                            sourceMarkdown: data.markdown,
                            targetMarkdown: '',
                            layoutJsonUrl: data.layoutJsonUrl || `/api/media/${data.fileHash}/layout.json`,
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
                        status: 'parsing',
                        activeFileName: file.name,
                        translationStatus: '',
                        translationPhase: 'idle',
                        translationLastEventAt: null,
                        translationConcurrency: 1,
                        translationBlocks: [],
                        translationRunId: null,
                        batchId: data.batchId,
                        fileHash: data.fileHash,
                        fileUrl: `/api/media/${data.fileHash}/original.pdf`, // Switch to server URL immediately
                        progress: 30
                    });
                    void persistActiveDocumentSnapshot({
                        fileHash: data.fileHash,
                        fileName: file.name,
                        status: 'parsing',
                        progress: 30,
                        targetLang: get().targetLang,
                        sourceMarkdown: '',
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
                            set({
                                status: 'parsed',
                                sourceMarkdown: data.markdown,
                                progress: 60,
                                layoutUrl: data.layoutUrl || null,
                                layoutJsonUrl: data.layoutJsonUrl || `/api/media/${fileHash}/layout.json`
                            });
                            const current = get();
                            void persistActiveDocumentSnapshot({
                                fileHash: current.fileHash,
                                fileName: current.activeFileName || current.file?.name || 'unknown.pdf',
                                status: 'parsed',
                                progress: 60,
                                targetLang: current.targetLang,
                                sourceMarkdown: data.markdown,
                                targetMarkdown: current.targetMarkdown,
                                layoutJsonUrl: data.layoutJsonUrl || `/api/media/${fileHash}/layout.json`,
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
                            set({ status: 'error', error: data.error || 'Parsing failed' });
                            const current = get();
                            void persistActiveDocumentSnapshot({
                                fileHash: current.fileHash,
                                fileName: current.activeFileName || current.file?.name || 'unknown.pdf',
                                status: 'error',
                                progress: 0,
                                targetLang: current.targetLang,
                                sourceMarkdown: current.sourceMarkdown,
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
                        set({ status: 'error', error: getErrorMessage(e) });
                    }
                }, 3000); // 3 seconds polling
            },

            checkResumable: async () => {
                const { sourceMarkdown, targetLang, fileHash } = get();
                if (!fileHash || !sourceMarkdown) {
                    set({ resumableTranslation: null });
                    return;
                }

                try {
                    const response = await fetch('/api/translate/check-resume', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            fileHash,
                            targetLang,
                            sourceMarkdown
                        })
                    });

                    const data = await response.json();

                    if (data.canResume) {
                        set({
                            resumableTranslation: {
                                canResume: true,
                                completedChunks: data.completedChunks,
                                totalChunks: data.totalChunks,
                                percentage: data.percentage
                            }
                        });
                    } else {
                        set({ resumableTranslation: null });
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

            clearResumable: () => {
                set({ resumableTranslation: null });
            },

            startTranslation: async () => {
                await get().performTranslation(false);
            },

            performTranslation: async (resume: boolean, forceFresh: boolean = false) => {
                const { sourceMarkdown, targetLang, providerId, model, fileHash, file, activeFileName } = get();
                if (!sourceMarkdown) return;

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
                    translationRunId: null,
                    translationStatus: forceFresh ? '正在清理旧译文并重新翻译...' : '准备翻译任务...',
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
                let sawTerminalEvent = false;
                let hardTimeoutTriggered = false;

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

                const flushTranslationArtifacts = (snapshotStatus: TaskStatus, snapshotProgress: number) => {
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
                    set((state) => ({
                        translationLastEventAt: timestamp,
                        translationStatus: updates?.translationStatus ?? state.translationStatus,
                        translationPhase: updates?.translationPhase ?? state.translationPhase,
                        translationConcurrency: updates?.translationConcurrency ?? state.translationConcurrency,
                    }));
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
                        const { done, value } = await reader.read();
                        if (done) break;

                        markTranslationActivity();
                        buffer += decoder.decode(value, { stream: true });
                        const events = buffer.split('\n\n');
                        buffer = events.pop() || "";

                        for (const event of events) {
                            if (!event.startsWith('data: ')) continue;
                            const jsonStr = event.substring(6);
                            try {
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
                                        set((state) => {
                                            const chunkId = typeof data.chunkId === 'string' ? data.chunkId : null;
                                            if (!chunkId) {
                                                return {
                                                    translationBlocks: state.translationBlocks.length > 0
                                                        ? state.translationBlocks.map((block, index) => (
                                                            index === state.translationBlocks.length - 1
                                                                ? {
                                                                    ...block,
                                                                    text: block.text + (data.text || ''),
                                                                    state: block.state === 'cached' ? 'cached' as const : 'streaming' as const,
                                                                }
                                                                : block
                                                        ))
                                                        : [{
                                                            id: 'streaming-translation',
                                                            index: 0,
                                                            title: 'Streaming Translation',
                                                            kind: 'text',
                                                            text: data.text || '',
                                                            state: 'streaming' as const,
                                                        }],
                                                    translationPhase: 'streaming',
                                                    translationLastEventAt: Date.now(),
                                                };
                                            }

                                            const hasPlannedBlock = state.translationBlocks.some((block) => block.id === chunkId);
                                            const nextBlocks: TranslationMarkdownBlock[] = hasPlannedBlock
                                                ? state.translationBlocks.map((block) => (
                                                    block.id === chunkId
                                                        ? {
                                                            ...block,
                                                            text: block.text + (data.text || ''),
                                                            state: block.state === 'cached' ? 'cached' as const : 'streaming' as const,
                                                        }
                                                        : block
                                                ))
                                                : [
                                                    ...state.translationBlocks,
                                                    {
                                                        id: chunkId,
                                                        index: state.translationBlocks.length,
                                                        title: typeof data.title === 'string' ? data.title : `Chunk ${state.translationBlocks.length + 1}`,
                                                        kind: 'text',
                                                        text: data.text || '',
                                                        state: 'streaming' as const,
                                                    },
                                                ];

                                            return {
                                                translationBlocks: nextBlocks,
                                                translationPhase: 'streaming',
                                                translationLastEventAt: Date.now(),
                                            };
                                        });
                                        scheduleTargetMarkdownFlush();
                                        scheduleTranslationSnapshotPersist();
                                        break;
                                    case 'chunk_completed':
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
                                    case 'error':
                                        sawTerminalEvent = true;
                                        clearStreamTimers();
                                        clearTranslationFlushTimers();
                                        set({
                                            status: 'error',
                                            error: data.message,
                                            translationStatus: '翻译失败',
                                            translationPhase: 'error',
                                            translationLastEventAt: Date.now(),
                                        });
                                        flushTranslationArtifacts('error', get().progress);
                                        break;
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

                        set({
                            status: 'error',
                            error: message,
                            translationStatus: hardTimeoutTriggered ? '翻译流超时' : '翻译连接已断开',
                            translationPhase: hardTimeoutTriggered ? 'stalled' : 'error',
                            translationLastEventAt: Date.now(),
                        });
                        flushTranslationArtifacts('error', get().progress);
                        if (fileHash) {
                            get().addToHistory({
                                fileHash,
                                fileName: activeFileName || file?.name || 'unknown.pdf',
                                status: 'error',
                                progress: get().progress
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

                    set({
                        status: 'error',
                        error: message,
                        translationStatus: hardTimeoutTriggered ? '翻译流超时' : '翻译失败',
                        translationPhase: hardTimeoutTriggered ? 'stalled' : 'error',
                        translationLastEventAt: Date.now(),
                    });
                    flushTranslationArtifacts('error', get().progress);
                    if (fileHash) {
                        get().addToHistory({
                            fileHash,
                            fileName: activeFileName || file?.name || 'unknown.pdf',
                            status: 'error',
                            progress: 0
                        });
                    }
                }
            },

            reset: () => {
                const previousUrl = get().fileUrl;
                if (previousUrl?.startsWith('blob:')) {
                    URL.revokeObjectURL(previousUrl);
                }
                set({
                    file: null,
                    sourceMarkdown: '',
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
                    highlightedBlockId: null
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
                    activeFileName: state.activeFileName,
                    status: persistedStatus,
                    progress: state.progress,
                    sourceMarkdown: state.sourceMarkdown,
                    targetMarkdown: state.targetMarkdown,
                    targetLang: state.targetLang,
                    providerId: state.providerId,
                    model: state.model,
                    assistProviderId: state.assistProviderId,
                    assistModel: state.assistModel,
                    isZenMode: state.isZenMode,
                    // fileUrl and batchId are not persisted or handled separately
                    layoutUrl: state.layoutUrl,
                    layoutJsonUrl: state.layoutJsonUrl
                };
            },
        }
    )
);

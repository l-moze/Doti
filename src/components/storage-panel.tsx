'use client';

import {
    clearAnnotationRecords,
    clearConversationRecords,
    clearDocumentSnapshots,
    clearGlossaryRecords,
    clearProviderProfiles,
    clearSessionSnapshots,
} from '@/lib/db';
import {
    estimateStorageUsage,
    isPersistentStorageGranted,
    requestPersistentStorage,
} from '@/lib/storage-manager';
import { emitSyncEvent } from '@/lib/sync-channel';
import { Database, HardDriveDownload, Loader2, ShieldCheck, Trash2, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ModalShell } from './modal-shell';

interface StoragePanelProps {
    open: boolean;
    onClose: () => void;
}

interface CacheInfo {
    names: string[];
    offlineReady: boolean;
}

function formatBytes(input?: number): string {
    if (!input && input !== 0) return '不可用';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = input;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function StoragePanel({ open, onClose }: StoragePanelProps) {
    const [loading, setLoading] = useState(false);
    const [estimate, setEstimate] = useState<Awaited<ReturnType<typeof estimateStorageUsage>>>(null);
    const [persistent, setPersistent] = useState(false);
    const [cacheInfo, setCacheInfo] = useState<CacheInfo>({ names: [], offlineReady: false });

    const refreshState = async () => {
        setLoading(true);
        try {
            const [nextEstimate, nextPersistent] = await Promise.all([
                estimateStorageUsage(),
                isPersistentStorageGranted(),
            ]);

            let cacheNames: string[] = [];
            if (typeof window !== 'undefined' && 'caches' in window) {
                cacheNames = await caches.keys();
            }

            let offlineReady = false;
            if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
                const registration = await navigator.serviceWorker.getRegistration();
                offlineReady = Boolean(registration?.active);
            }

            setEstimate(nextEstimate);
            setPersistent(nextPersistent);
            setCacheInfo({ names: cacheNames, offlineReady });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!open) return;
        void refreshState();
    }, [open]);

    const requestPersistence = async () => {
        const granted = await requestPersistentStorage();
        setPersistent(granted);
    };

    const clearRuntimeCaches = async () => {
        if (typeof window === 'undefined' || !('caches' in window)) return;
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
        emitSyncEvent({ type: 'storage-updated' });
        await refreshState();
    };

    const clearWorkspaceMirror = async () => {
        await Promise.all([clearDocumentSnapshots(), clearSessionSnapshots(), clearConversationRecords()]);
        emitSyncEvent({ type: 'storage-updated' });
        await refreshState();
    };

    const clearKnowledgeLayer = async () => {
        await Promise.all([clearAnnotationRecords(), clearGlossaryRecords(), clearProviderProfiles()]);
        emitSyncEvent({ type: 'storage-updated' });
        await refreshState();
    };

    return (
        <ModalShell
            open={open}
            title="本地数据"
            description="管理临时文件、阅读记录和个人设置。"
            widthClassName="max-w-3xl"
            onClose={onClose}
        >
            <div className="space-y-6 px-6 py-6">
                <div className="grid gap-4 md:grid-cols-3">
                    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="inline-flex rounded-2xl bg-slate-900 p-3 text-white">
                            <Database size={18} />
                        </div>
                        <div className="mt-4 text-sm text-slate-500">已占用空间</div>
                        <div className="mt-1 text-2xl font-semibold text-slate-900">
                            {formatBytes(estimate?.usage)}
                        </div>
                        <div className="mt-2 text-xs text-slate-500">
                            可用空间约 {formatBytes(estimate?.quota)}
                        </div>
                    </article>

                    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="inline-flex rounded-2xl bg-emerald-600 p-3 text-white">
                            <ShieldCheck size={18} />
                        </div>
                        <div className="mt-4 text-sm text-slate-500">重要数据保护</div>
                        <div className="mt-1 text-2xl font-semibold text-slate-900">
                            {persistent ? '已开启' : '未开启'}
                        </div>
                        <button
                            type="button"
                            onClick={() => void requestPersistence()}
                            className="mt-4 rounded-2xl border border-slate-200 px-4 py-2 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
                        >
                            开启保护
                        </button>
                    </article>

                    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="inline-flex rounded-2xl bg-amber-500 p-3 text-white">
                            <HardDriveDownload size={18} />
                        </div>
                        <div className="mt-4 text-sm text-slate-500">离线文件</div>
                        <div className="mt-1 text-2xl font-semibold text-slate-900">
                            {cacheInfo.names.length}
                        </div>
                        <div className="mt-2 text-xs text-slate-500">
                            {cacheInfo.offlineReady ? '可离线打开' : '需要联网准备'}
                        </div>
                    </article>
                </div>

                <section className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div>
                            <div className="text-sm font-medium text-slate-900">清理本地数据</div>
                            <p className="mt-1 text-sm leading-6 text-slate-500">
                                按影响范围清理，不会把所有内容一次性删掉。
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void refreshState()}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
                        >
                            {loading ? <Loader2 size={15} className="animate-spin" /> : <WifiOff size={15} />}
                            刷新状态
                        </button>
                    </div>

                    <div className="mt-5 grid gap-3 md:grid-cols-3">
                        <button
                            type="button"
                            onClick={() => void clearRuntimeCaches()}
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-slate-300"
                        >
                            <div className="inline-flex rounded-xl bg-slate-900 p-2 text-white">
                                <Trash2 size={15} />
                            </div>
                            <div className="mt-3 text-sm font-medium text-slate-900">清理临时文件</div>
                            <p className="mt-1 text-sm text-slate-500">清理可重新生成的离线文件和加载记录。</p>
                        </button>

                        <button
                            type="button"
                            onClick={() => void clearWorkspaceMirror()}
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-slate-300"
                        >
                            <div className="inline-flex rounded-xl bg-sky-600 p-2 text-white">
                                <Trash2 size={15} />
                            </div>
                            <div className="mt-3 text-sm font-medium text-slate-900">清理阅读记录</div>
                            <p className="mt-1 text-sm text-slate-500">清理最近文档、阅读进度和问答记录。</p>
                        </button>

                        <button
                            type="button"
                            onClick={() => void clearKnowledgeLayer()}
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-slate-300"
                        >
                            <div className="inline-flex rounded-xl bg-amber-500 p-2 text-white">
                                <Trash2 size={15} />
                            </div>
                            <div className="mt-3 text-sm font-medium text-slate-900">清理个人设置</div>
                            <p className="mt-1 text-sm text-slate-500">删除本机批注、高亮、术语和自定义翻译服务。</p>
                        </button>
                    </div>
                </section>

                <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="text-sm font-medium text-slate-900">离线文件详情</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {cacheInfo.names.length > 0 ? cacheInfo.names.map((cacheName, index) => (
                            <span
                                key={cacheName}
                                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
                            >
                                离线文件包 {index + 1}
                            </span>
                        )) : (
                            <span className="text-sm text-slate-500">当前没有可清理的离线文件。</span>
                        )}
                    </div>
                </section>
            </div>
        </ModalShell>
    );
}

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
    serviceWorkerReady: boolean;
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
    const [cacheInfo, setCacheInfo] = useState<CacheInfo>({ names: [], serviceWorkerReady: false });

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

            let serviceWorkerReady = false;
            if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
                const registration = await navigator.serviceWorker.getRegistration();
                serviceWorkerReady = Boolean(registration?.active);
            }

            setEstimate(nextEstimate);
            setPersistent(nextPersistent);
            setCacheInfo({ names: cacheNames, serviceWorkerReady });
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
            title="离线与存储"
            description="查看浏览器存储配额、持久化状态与离线缓存层。"
            widthClassName="max-w-3xl"
            onClose={onClose}
        >
            <div className="space-y-6 px-6 py-6">
                <div className="grid gap-4 md:grid-cols-3">
                    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="inline-flex rounded-2xl bg-slate-900 p-3 text-white">
                            <Database size={18} />
                        </div>
                        <div className="mt-4 text-sm text-slate-500">已使用存储</div>
                        <div className="mt-1 text-2xl font-semibold text-slate-900">
                            {formatBytes(estimate?.usage)}
                        </div>
                        <div className="mt-2 text-xs text-slate-500">
                            配额 {formatBytes(estimate?.quota)}
                        </div>
                    </article>

                    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="inline-flex rounded-2xl bg-emerald-600 p-3 text-white">
                            <ShieldCheck size={18} />
                        </div>
                        <div className="mt-4 text-sm text-slate-500">持久化状态</div>
                        <div className="mt-1 text-2xl font-semibold text-slate-900">
                            {persistent ? '已授予' : '未授予'}
                        </div>
                        <button
                            type="button"
                            onClick={() => void requestPersistence()}
                            className="mt-4 rounded-2xl border border-slate-200 px-4 py-2 text-sm text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
                        >
                            请求持久化
                        </button>
                    </article>

                    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="inline-flex rounded-2xl bg-amber-500 p-3 text-white">
                            <HardDriveDownload size={18} />
                        </div>
                        <div className="mt-4 text-sm text-slate-500">离线缓存</div>
                        <div className="mt-1 text-2xl font-semibold text-slate-900">
                            {cacheInfo.names.length}
                        </div>
                        <div className="mt-2 text-xs text-slate-500">
                            Service Worker {cacheInfo.serviceWorkerReady ? '已激活' : '未就绪'}
                        </div>
                    </article>
                </div>

                <section className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div>
                            <div className="text-sm font-medium text-slate-900">缓存与本地数据清理</div>
                            <p className="mt-1 text-sm leading-6 text-slate-500">
                                分级清理派生缓存、工作镜像和笔记知识层，避免误删全部内容。
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
                            <div className="mt-3 text-sm font-medium text-slate-900">清理派生缓存</div>
                            <p className="mt-1 text-sm text-slate-500">只清掉 Cache Storage 与 Service Worker 运行时缓存。</p>
                        </button>

                        <button
                            type="button"
                            onClick={() => void clearWorkspaceMirror()}
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-slate-300"
                        >
                            <div className="inline-flex rounded-xl bg-sky-600 p-2 text-white">
                                <Trash2 size={15} />
                            </div>
                            <div className="mt-3 text-sm font-medium text-slate-900">清理工作镜像</div>
                            <p className="mt-1 text-sm text-slate-500">清理本地历史镜像、会话快照与 AI 对话记录。</p>
                        </button>

                        <button
                            type="button"
                            onClick={() => void clearKnowledgeLayer()}
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left transition hover:border-slate-300"
                        >
                            <div className="inline-flex rounded-xl bg-amber-500 p-2 text-white">
                                <Trash2 size={15} />
                            </div>
                            <div className="mt-3 text-sm font-medium text-slate-900">清理知识层与模型配置</div>
                            <p className="mt-1 text-sm text-slate-500">会删除本地批注、高亮、用户术语和自定义 provider 配置。</p>
                        </button>
                    </div>
                </section>

                <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="text-sm font-medium text-slate-900">缓存容器</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {cacheInfo.names.length > 0 ? cacheInfo.names.map((cacheName) => (
                            <span
                                key={cacheName}
                                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
                            >
                                {cacheName}
                            </span>
                        )) : (
                            <span className="text-sm text-slate-500">当前没有可见的 Cache Storage 记录。</span>
                        )}
                    </div>
                </section>
            </div>
        </ModalShell>
    );
}

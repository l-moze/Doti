'use client';

import {
    deleteGlossaryRecord,
    listUserGlossaryRecords,
    saveGlossaryRecord,
    type GlossaryRecord,
} from '@/lib/db';
import { emitSyncEvent, subscribeSyncEvents } from '@/lib/sync-channel';
import { Download, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ModalShell } from './modal-shell';

function toCsv(records: GlossaryRecord[]): string {
    return [
        'source,target,category,enabled',
        ...records.map((record) =>
            [
                `"${record.source.replace(/"/g, '""')}"`,
                `"${record.target.replace(/"/g, '""')}"`,
                `"${(record.category || '').replace(/"/g, '""')}"`,
                String(record.enabled),
            ].join(',')
        ),
    ].join('\n');
}

async function parseCsvFile(file: File): Promise<Array<Pick<GlossaryRecord, 'source' | 'target' | 'category' | 'enabled'>>> {
    const text = await file.text();
    type ParsedGlossaryInput = Pick<GlossaryRecord, 'source' | 'target' | 'category' | 'enabled'> | null;

    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map<ParsedGlossaryInput>((line, index) => {
            const parts = line.split(',');
            if (index === 0 && parts[0]?.toLowerCase().includes('source')) {
                return null;
            }

            const [source = '', target = '', category = '', enabled = 'true'] = parts.map((part) =>
                part.trim().replace(/^"|"$/g, '')
            );

            if (!source || !target) {
                return null;
            }

            return {
                source,
                target,
                category: category || undefined,
                enabled: enabled !== 'false',
            };
        })
        .filter((item): item is Pick<GlossaryRecord, 'source' | 'target' | 'category' | 'enabled'> => item !== null);
}

interface GlossaryManagerProps {
    open: boolean;
    onClose: () => void;
}

export function GlossaryManager({ open, onClose }: GlossaryManagerProps) {
    const [records, setRecords] = useState<GlossaryRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [draft, setDraft] = useState({
        source: '',
        target: '',
        category: '',
        enabled: true,
    });

    const loadRecords = async () => {
        setLoading(true);
        try {
            const next = await listUserGlossaryRecords();
            setRecords(next.sort((a, b) => b.updatedAt - a.updatedAt));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!open) return;
        void loadRecords();
    }, [open]);

    useEffect(() => {
        if (!open) return;
        return subscribeSyncEvents((event) => {
            if (event.type === 'glossary-updated') {
                void loadRecords();
            }
        });
    }, [open]);

    const filteredRecords = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        if (!keyword) return records;
        return records.filter((record) =>
            [record.source, record.target, record.category || '']
                .join(' ')
                .toLowerCase()
                .includes(keyword)
        );
    }, [records, search]);

    const saveDraft = async () => {
        if (!draft.source.trim() || !draft.target.trim()) return;

        const source = draft.source.trim();
        const target = draft.target.trim();
        const existing = records.find((record) => record.source.toLowerCase() === source.toLowerCase());

        await saveGlossaryRecord({
            id: existing?.id || crypto.randomUUID(),
            source,
            target,
            category: draft.category.trim() || undefined,
            scope: 'user',
            enabled: draft.enabled,
            updatedAt: Date.now(),
        });

        emitSyncEvent({ type: 'glossary-updated' });
        setDraft({ source: '', target: '', category: '', enabled: true });
        await loadRecords();
    };

    const toggleRecord = async (record: GlossaryRecord) => {
        await saveGlossaryRecord({
            ...record,
            enabled: !record.enabled,
            updatedAt: Date.now(),
        });
        emitSyncEvent({ type: 'glossary-updated' });
        await loadRecords();
    };

    const removeRecord = async (id: string) => {
        await deleteGlossaryRecord(id);
        emitSyncEvent({ type: 'glossary-updated' });
        await loadRecords();
    };

    const exportJson = () => {
        const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'user-glossary.json';
        anchor.click();
        URL.revokeObjectURL(url);
    };

    const exportCsv = () => {
        const blob = new Blob([toCsv(records)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'user-glossary.csv';
        anchor.click();
        URL.revokeObjectURL(url);
    };

    const importCsv = async (file: File | null) => {
        if (!file) return;
        const imported = await parseCsvFile(file);
        for (const item of imported) {
            const existing = records.find((record) => record.source.toLowerCase() === item.source.toLowerCase());
            await saveGlossaryRecord({
                id: existing?.id || crypto.randomUUID(),
                source: item.source,
                target: item.target,
                category: item.category,
                scope: 'user',
                enabled: item.enabled,
                updatedAt: Date.now(),
            });
        }
        emitSyncEvent({ type: 'glossary-updated' });
        await loadRecords();
    };

    return (
        <ModalShell
            open={open}
            title="用户术语库"
            description="用户术语会覆盖内置词库，翻译时自动注入模型提示。"
            onClose={onClose}
        >
            <div className="space-y-6 px-6 py-6">
                <section className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                    <div className="grid gap-3 md:grid-cols-[1fr_1fr_180px_auto]">
                        <input
                            type="text"
                            value={draft.source}
                            onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))}
                            placeholder="原术语"
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                        />
                        <input
                            type="text"
                            value={draft.target}
                            onChange={(event) => setDraft((current) => ({ ...current, target: event.target.value }))}
                            placeholder="目标术语"
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                        />
                        <input
                            type="text"
                            value={draft.category}
                            onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
                            placeholder="分类，如 vision / math"
                            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                        />
                        <button
                            type="button"
                            onClick={saveDraft}
                            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
                        >
                            <Plus size={16} />
                            添加
                        </button>
                    </div>
                    <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-600">
                        <input
                            type="checkbox"
                            checked={draft.enabled}
                            onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
                            className="h-4 w-4 accent-slate-900"
                        />
                        新增术语默认启用
                    </label>
                </section>

                <section className="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:flex-row md:items-center md:justify-between">
                    <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="搜索术语、翻译或分类"
                        className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-slate-400 md:max-w-sm"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                        <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-700 transition hover:border-slate-300">
                            <Upload size={15} />
                            导入 CSV
                            <input
                                type="file"
                                accept=".csv,text/csv"
                                className="hidden"
                                onChange={(event) => void importCsv(event.target.files?.[0] || null)}
                            />
                        </label>
                        <button
                            type="button"
                            onClick={exportCsv}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-700 transition hover:border-slate-300"
                        >
                            <Download size={15} />
                            导出 CSV
                        </button>
                        <button
                            type="button"
                            onClick={exportJson}
                            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-700 transition hover:border-slate-300"
                        >
                            <Download size={15} />
                            导出 JSON
                        </button>
                    </div>
                </section>

                <section className="overflow-hidden rounded-3xl border border-slate-200">
                    <div className="grid grid-cols-[1.1fr_1.1fr_0.8fr_120px_80px] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                        <span>Source</span>
                        <span>Target</span>
                        <span>Category</span>
                        <span>Status</span>
                        <span className="text-right">Action</span>
                    </div>

                    <div className="max-h-[420px] overflow-auto bg-white">
                        {loading ? (
                            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-slate-500">
                                <Loader2 size={16} className="animate-spin" />
                                正在读取术语库
                            </div>
                        ) : filteredRecords.length > 0 ? filteredRecords.map((record) => (
                            <div
                                key={record.id}
                                className="grid grid-cols-[1.1fr_1.1fr_0.8fr_120px_80px] gap-3 border-b border-slate-100 px-4 py-4 text-sm text-slate-700"
                            >
                                <div className="font-medium text-slate-900">{record.source}</div>
                                <div>{record.target}</div>
                                <div>{record.category || '-'}</div>
                                <button
                                    type="button"
                                    onClick={() => void toggleRecord(record)}
                                    className={`inline-flex h-fit items-center justify-center rounded-full px-3 py-1 text-xs font-medium ${record.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                                        }`}
                                >
                                    {record.enabled ? '启用中' : '已停用'}
                                </button>
                                <div className="flex justify-end">
                                    <button
                                        type="button"
                                        onClick={() => void removeRecord(record.id)}
                                        className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                                        aria-label={`Delete ${record.source}`}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>
                        )) : (
                            <div className="px-4 py-10 text-center text-sm text-slate-500">
                                还没有用户术语，可以先手动添加或导入 CSV。
                            </div>
                        )}
                    </div>
                </section>
            </div>
        </ModalShell>
    );
}

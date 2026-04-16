'use client';

import { Loader2, Rocket, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ModalShell } from './modal-shell';
import { fetchWithRetry } from '@/lib/fetch-with-retry';

interface ArxivMetadataPreview {
    arxivId: string;
    version?: string;
    title?: string;
    summary?: string;
    authors: string[];
    pdfUrl: string;
}

interface ArxivImportDialogProps {
    open: boolean;
    status: string;
    onClose: () => void;
    onImport: (input: string) => Promise<void>;
}

export function ArxivImportDialog({
    open,
    status,
    onClose,
    onImport,
}: ArxivImportDialogProps) {
    const [input, setInput] = useState('');
    const [preview, setPreview] = useState<ArxivMetadataPreview | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) {
            setPreview(null);
            setError(null);
            setLoadingPreview(false);
            setImporting(false);
        }
    }, [open]);

    const previewLabel = useMemo(() => {
        if (!preview) return '';
        return `${preview.arxivId}${preview.version ?? ''}`;
    }, [preview]);

    const handlePreview = async () => {
        if (!input.trim()) return;

        setLoadingPreview(true);
        setError(null);

        try {
            const response = await fetchWithRetry('/api/arxiv/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input, preview: true }),
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || '预览 arXiv 信息失败');
            }

            setPreview(data.metadata as ArxivMetadataPreview);
        } catch (previewError) {
            setPreview(null);
            setError(previewError instanceof Error ? previewError.message : '预览 arXiv 信息失败');
        } finally {
            setLoadingPreview(false);
        }
    };

    const handleImport = async () => {
        if (!input.trim()) return;
        setImporting(true);
        setError(null);

        try {
            await onImport(input.trim());
            onClose();
        } catch (importError) {
            setError(importError instanceof Error ? importError.message : '导入 arXiv 失败');
        } finally {
            setImporting(false);
        }
    };

    return (
        <ModalShell
            open={open}
            title="导入 arXiv 论文"
            description="支持 arXiv ID、`arxiv:` 前缀、`/abs/` 和 `/pdf/` 链接。"
            widthClassName="max-w-3xl"
            onClose={onClose}
        >
            <div className="space-y-6 px-6 py-6">
                <div className="rounded-3xl border border-slate-200 bg-[linear-gradient(135deg,#eff6ff,#f8fafc_55%,#fff7ed)] p-5">
                    <label className="mb-3 block text-sm font-medium text-slate-900" htmlFor="arxiv-input">
                        论文入口
                    </label>
                    <div className="flex flex-col gap-3 md:flex-row">
                        <input
                            id="arxiv-input"
                            type="text"
                            value={input}
                            onChange={(event) => setInput(event.target.value)}
                            placeholder="例如 2501.01234 / arXiv:2501.01234v2 / https://arxiv.org/abs/2501.01234"
                            className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                        />
                        <button
                            type="button"
                            onClick={handlePreview}
                            disabled={!input.trim() || loadingPreview}
                            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {loadingPreview ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                            预览元数据
                        </button>
                        <button
                            type="button"
                            onClick={handleImport}
                            disabled={!input.trim() || importing || status === 'parsing' || status === 'uploading'}
                            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {importing ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
                            立即导入
                        </button>
                    </div>
                    {error && (
                        <p className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                            {error}
                        </p>
                    )}
                </div>

                {preview && (
                    <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                        <div className="mb-4 flex items-start justify-between gap-4">
                            <div>
                                <div className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white">
                                    <Sparkles size={12} />
                                    {previewLabel}
                                </div>
                                <h3 className="mt-3 text-xl font-semibold text-slate-900">
                                    {preview.title || '未获取到标题'}
                                </h3>
                            </div>
                            <a
                                href={preview.pdfUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-full border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                            >
                                打开 PDF
                            </a>
                        </div>

                        <div className="grid gap-4 md:grid-cols-[1.3fr_0.7fr]">
                            <div>
                                <div className="text-sm font-medium text-slate-900">摘要</div>
                                <p className="mt-2 text-sm leading-7 text-slate-600">
                                    {preview.summary || '暂无摘要'}
                                </p>
                            </div>
                            <div>
                                <div className="text-sm font-medium text-slate-900">作者</div>
                                <ul className="mt-2 space-y-2 text-sm text-slate-600">
                                    {preview.authors.length > 0 ? preview.authors.map((author) => (
                                        <li key={author}>{author}</li>
                                    )) : <li>暂无作者信息</li>}
                                </ul>
                            </div>
                        </div>
                    </article>
                )}
            </div>
        </ModalShell>
    );
}

'use client';

import { FileOutput, Languages, NotebookPen, ScrollText } from 'lucide-react';
import { ModalShell } from './modal-shell';

type ExportMode = 'translation' | 'bilingual' | 'notes' | 'bilingual-notes';

const EXPORT_OPTIONS: Array<{
    mode: ExportMode;
    icon: typeof ScrollText;
    title: string;
    description: string;
}> = [
    {
        mode: 'translation',
        icon: Languages,
        title: '仅导出译文',
        description: '适合提交、快速分享和移动端阅读。',
    },
    {
        mode: 'bilingual',
        icon: ScrollText,
        title: '原文 + 译文对照',
        description: '保留原文上下文，适合复核术语与公式。',
    },
    {
        mode: 'notes',
        icon: NotebookPen,
        title: '仅导出批注',
        description: '把你的阅读笔记整理成一份独立文档。',
    },
    {
        mode: 'bilingual-notes',
        icon: FileOutput,
        title: '译文 + 批注工作稿',
        description: '用于深度阅读、讨论与打印审阅。',
    },
];

interface ExportSheetProps {
    fileHash: string | null;
    fileName: string | null;
    open: boolean;
    targetLang: string;
    onClose: () => void;
}

export function ExportSheet({
    fileHash,
    fileName,
    open,
    targetLang,
    onClose,
}: ExportSheetProps) {
    const canExport = Boolean(fileHash);

    const openPrintPreview = (mode: ExportMode) => {
        if (!fileHash) return;

        const url = `/print?fileHash=${encodeURIComponent(fileHash)}&targetLang=${encodeURIComponent(targetLang)}&mode=${mode}`;
        window.open(url, '_blank', 'noopener,noreferrer');
        onClose();
    };

    return (
        <ModalShell
            open={open}
            title="导出与打印"
            description="使用浏览器打印路径生成阅读稿，支持对照与批注模式。"
            widthClassName="max-w-3xl"
            onClose={onClose}
        >
            <div className="space-y-5 px-6 py-6">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                    <div className="font-medium text-slate-900">{fileName || '当前文档'}</div>
                    <div className="mt-1">导出语言：{targetLang}</div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    {EXPORT_OPTIONS.map((option) => {
                        const Icon = option.icon;
                        return (
                            <button
                                key={option.mode}
                                type="button"
                                onClick={() => openPrintPreview(option.mode)}
                                disabled={!canExport}
                                className="rounded-3xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-slate-300 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <div className="mb-4 inline-flex rounded-2xl bg-slate-900 p-3 text-white">
                                    <Icon size={18} />
                                </div>
                                <div className="text-base font-semibold text-slate-900">{option.title}</div>
                                <p className="mt-2 text-sm leading-6 text-slate-500">{option.description}</p>
                            </button>
                        );
                    })}
                </div>
            </div>
        </ModalShell>
    );
}

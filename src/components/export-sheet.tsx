'use client';

import { FileOutput, Languages, NotebookPen, ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReaderView } from '@/components/markdown-editor';
import { getProviderProfile, listUserGlossaryRecords } from '@/lib/db';
import { useTranslationStore } from '@/lib/store';
import {
    buildTranslationArtifactBaseName,
    buildTranslationCacheKeyInputFromRuntime,
} from '@/lib/translation-cache-key';
import { ModalShell } from './modal-shell';

export type ExportMode =
    | 'translation'
    | 'source'
    | 'bilingual'
    | 'notes'
    | 'translation-notes'
    | 'source-notes'
    | 'bilingual-notes';

function modeIncludesTranslation(mode: ExportMode): boolean {
    return mode === 'translation' || mode === 'bilingual' || mode === 'translation-notes' || mode === 'bilingual-notes';
}

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
        title: '仅导出阅读笔记',
        description: '把你的阅读笔记整理成一份独立文档。',
    },
    {
        mode: 'translation-notes',
        icon: FileOutput,
        title: '译文 + 阅读笔记',
        description: '把译文和你的阅读笔记一起导出。',
    },
    {
        mode: 'bilingual-notes',
        icon: FileOutput,
        title: '对照 + 阅读笔记',
        description: '把原文、译文和阅读笔记一起导出。',
    },
];

interface ExportSheetProps {
    currentView: ReaderView;
    fileHash: string | null;
    fileName: string | null;
    open: boolean;
    preferredMode?: ExportMode | null;
    targetLang: string;
    targetLangLabel: string;
    onClose: () => void;
}

export function ExportSheet({
    currentView,
    fileHash,
    fileName,
    open,
    preferredMode,
    targetLang,
    targetLangLabel,
    onClose,
}: ExportSheetProps) {
    const [showMoreFormats, setShowMoreFormats] = useState(false);
    const providerId = useTranslationStore((state) => state.providerId);
    const model = useTranslationStore((state) => state.model);
    const canExport = Boolean(fileHash);
    const currentViewMode: ExportMode = currentView === 'compare'
        ? 'bilingual'
        : currentView === 'source'
            ? 'source'
            : 'translation';
    const currentMode = preferredMode ?? currentViewMode;
    const currentViewLabel = currentMode === 'bilingual'
        ? '对照视图'
        : currentMode === 'source'
            ? '原文视图'
            : currentMode === 'notes'
                ? '阅读笔记'
                : currentMode === 'translation-notes'
                    ? '译文 + 阅读笔记'
                    : currentMode === 'source-notes'
                        ? '原文 + 阅读笔记'
                        : currentMode === 'bilingual-notes'
                            ? '对照 + 阅读笔记'
                            : '译文视图';
    const currentViewMeta = {
        label: currentViewLabel,
        translationLabel: modeIncludesTranslation(currentMode) ? targetLangLabel : null,
    };

    useEffect(() => {
        if (!open) setShowMoreFormats(false);
    }, [open]);

    const openPrintPreview = async (mode: ExportMode) => {
        if (!fileHash) return;

        const previewWindow = window.open('about:blank', '_blank');
        if (previewWindow) {
            previewWindow.opener = null;
        }

        let translationArtifact = '';

        if (modeIncludesTranslation(mode)) {
            try {
                const providerProfile = providerId.startsWith('custom:')
                    ? await getProviderProfile(providerId.slice('custom:'.length))
                    : undefined;
                const glossaryTerms = (await listUserGlossaryRecords())
                    .filter((term) => term.enabled)
                    .map((term) => ({
                        source: term.source,
                        target: term.target,
                        category: term.category,
                    }));

                translationArtifact = buildTranslationArtifactBaseName(
                    buildTranslationCacheKeyInputFromRuntime({
                        fileHash,
                        targetLang,
                        providerId,
                        model,
                        providerProfile,
                        glossaryTerms,
                        translateMode: providerProfile?.providerType === 'deeplx' ? 'deeplx' : 'default',
                        outputMode: 'plain',
                    })
                );
            } catch (error) {
                console.warn('[Export] Failed to resolve translation artifact, falling back to legacy path:', error);
            }
        }

        const params = new URLSearchParams({
            fileHash,
            targetLang,
            mode,
        });
        if (translationArtifact) {
            params.set('translationArtifact', translationArtifact);
        }

        const url = `/print?${params.toString()}`;
        if (previewWindow) {
            previewWindow.location.href = url;
        } else {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
        onClose();
    };

    return (
        <ModalShell
            open={open}
            title="导出当前视图"
            description="默认导出你正在看的阅读视图，其他格式收在下方。"
            widthClassName="max-w-3xl"
            onClose={onClose}
        >
            <div className="space-y-5 px-6 py-6">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                    <div className="font-medium text-slate-900">{fileName || '当前文档'}</div>
                    <div className="mt-1">
                        当前视图：{currentViewMeta.label}
                        {currentViewMeta.translationLabel ? ` · 导出语言：${currentViewMeta.translationLabel}` : ''}
                    </div>
                </div>

                <button
                    type="button"
                    onClick={() => openPrintPreview(currentMode)}
                    disabled={!canExport}
                    className="flex w-full items-center justify-between gap-4 rounded-lg bg-slate-900 px-5 py-4 text-left text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <span>
                        <span className="block text-base font-semibold">导出当前视图</span>
                        <span className="mt-1 block text-sm text-slate-300">
                            按现在的 {currentViewLabel} 生成导出预览。
                        </span>
                    </span>
                    <FileOutput size={20} className="shrink-0" />
                </button>

                <div className="rounded-lg border border-slate-200 bg-white">
                    <button
                        type="button"
                        onClick={() => setShowMoreFormats((open) => !open)}
                        aria-expanded={showMoreFormats}
                        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left text-sm font-medium text-slate-700 transition hover:text-slate-950"
                    >
                        <span>更多导出方式</span>
                        <span className="text-xs text-slate-400">{showMoreFormats ? '收起' : '展开'}</span>
                    </button>

                    {showMoreFormats ? (
                        <div className="grid gap-4 border-t border-slate-200 p-4 md:grid-cols-2">
                            {EXPORT_OPTIONS.map((option) => {
                                const Icon = option.icon;
                                return (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        onClick={() => openPrintPreview(option.mode)}
                                        disabled={!canExport}
                                        className="rounded-lg border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <div className="mb-3 inline-flex rounded-lg bg-slate-900 p-2.5 text-white">
                                            <Icon size={16} />
                                        </div>
                                        <div className="text-sm font-semibold text-slate-900">{option.title}</div>
                                        <p className="mt-1.5 text-sm leading-6 text-slate-500">{option.description}</p>
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}
                </div>
            </div>
        </ModalShell>
    );
}

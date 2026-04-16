'use client';

import { useMemo, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { MarkdownView } from '@/components/markdown-view';
import { TranslationStream, type TranslationStreamFrame } from '@/components/translation-stream';
import { normalizeMarkdownMathForDisplay } from '@/lib/markdown-normalizer';
import { useTranslationStore } from '@/lib/store';

type StreamingTranslationPaneProps = {
    viewportRef: RefObject<HTMLDivElement | null>;
    onFramesChange?: (frames: TranslationStreamFrame[]) => void;
};

export function StreamingTranslationPane({ viewportRef, onFramesChange }: StreamingTranslationPaneProps) {
    const translationBlocks = useTranslationStore((state) => state.translationBlocks);
    const targetMarkdown = useTranslationStore((state) => state.targetMarkdown);
    const status = useTranslationStore((state) => state.status);
    const error = useTranslationStore((state) => state.error);
    const startTranslation = useTranslationStore((state) => state.startTranslation);
    const translationStatus = useTranslationStore((state) => state.translationStatus);
    const translationConcurrency = useTranslationStore((state) => state.translationConcurrency);
    const renderedTargetMarkdown = useMemo(
        () => normalizeMarkdownMathForDisplay(targetMarkdown),
        [targetMarkdown]
    );

    if (translationBlocks.length > 0) {
        return (
            <TranslationStream
                blocks={translationBlocks}
                viewportRef={viewportRef}
                onFramesChange={onFramesChange}
            />
        );
    }

    if (targetMarkdown) {
        return <MarkdownView value={renderedTargetMarkdown} />;
    }

    return (
        <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-slate-500">
            {status === 'parsed' && (
                <>
                    <p className="text-base font-medium text-slate-900">译文区已经准备好</p>
                    <p className="max-w-sm text-sm leading-6">
                        点击顶部的“开始翻译”，系统会边生成边把段落写入这里。
                    </p>
                </>
            )}
            {status === 'translating' && (
                <>
                    <Loader2 className="animate-spin text-slate-400" size={40} />
                    <p className="font-medium text-slate-900">
                        {translationConcurrency > 1 ? '正在并发生成译文...' : '正在生成译文...'}
                    </p>
                    {translationStatus ? (
                        <p className="max-w-md text-sm leading-6 text-slate-500">
                            {translationStatus}
                        </p>
                    ) : null}
                </>
            )}
            {status === 'error' && (
                <>
                    <p className="font-medium text-red-600">翻译失败</p>
                    <p className="max-w-md rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm leading-6 text-red-500">
                        {error || 'Unknown error'}
                    </p>
                    <button
                        type="button"
                        onClick={() => void startTranslation()}
                        className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
                    >
                        重试翻译
                    </button>
                </>
            )}
        </div>
    );
}

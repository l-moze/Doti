'use client';

import { useMemo, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { MarkdownView } from '@/components/markdown-view';
import { TranslationStream, type TranslationStreamFrame } from '@/components/translation-stream';
import { normalizeMarkdownMathForDisplay } from '@/lib/markdown-normalizer';
import { useTranslationStore } from '@/lib/store';

type StreamingTranslationPaneProps = {
    viewportRef: RefObject<HTMLDivElement | null>;
    onFramesChange?: (frames: TranslationStreamFrame[]) => void;
};

// 独立子组件：只读取 translationStatus 和 translationConcurrency。
// streaming 期间这两个字段频繁变化，下沉到此组件后，更新只触发
// TranslatingPlaceholder 重渲染，不会波及 StreamingTranslationPane 及
// TranslationStream 整棵组件树。
function TranslatingPlaceholder() {
    const translationStatus = useTranslationStore((state) => state.translationStatus);
    const translationConcurrency = useTranslationStore((state) => state.translationConcurrency);

    return (
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
    );
}

export function StreamingTranslationPane({ viewportRef, onFramesChange }: StreamingTranslationPaneProps) {
    // 核心渲染路径 selector：仅包含决定显示哪个主视图所必需的最小字段集。
    // translationStatus / translationConcurrency 已下沉至 TranslatingPlaceholder，
    // 不在此 selector 中，避免状态消息每次更新都触发整棵组件树重渲染。
    const {
        translationBlocks,
        targetMarkdown,
        sourceMarkdown,
        status,
        error,
        batchId,
        fileHash,
        resumableTranslation,
        startTranslation,
        resumeTranslation,
        retryParsing,
    } = useTranslationStore(useShallow((state) => ({
        translationBlocks: state.translationBlocks,
        targetMarkdown: state.targetMarkdown,
        sourceMarkdown: state.sourceMarkdown,
        status: state.status,
        error: state.error,
        batchId: state.batchId,
        fileHash: state.fileHash,
        resumableTranslation: state.resumableTranslation,
        startTranslation: state.startTranslation,
        resumeTranslation: state.resumeTranslation,
        retryParsing: state.retryParsing,
    })));

    const isRecoverableParseTask = Boolean(
        batchId &&
        fileHash &&
        (status === 'parsing' || (status === 'error' && !sourceMarkdown.trim()))
    );
    const canResumeTranslation = Boolean(resumableTranslation?.canResume);
    const effectiveTargetMarkdown = isRecoverableParseTask ? '' : targetMarkdown;
    const effectiveTranslationBlocks = isRecoverableParseTask ? [] : translationBlocks;
    const renderedTargetMarkdown = useMemo(
        () => normalizeMarkdownMathForDisplay(effectiveTargetMarkdown),
        [effectiveTargetMarkdown]
    );

    if (effectiveTranslationBlocks.length > 0) {
        return (
            <TranslationStream
                blocks={effectiveTranslationBlocks}
                viewportRef={viewportRef}
                onFramesChange={onFramesChange}
            />
        );
    }

    if (effectiveTargetMarkdown) {
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
            {status === 'translating' && <TranslatingPlaceholder />}
            {status === 'error' && !isRecoverableParseTask && (
                <>
                    <p className="font-medium text-red-600">翻译失败</p>
                    <p className="max-w-md rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm leading-6 text-red-500">
                        {error || 'Unknown error'}
                    </p>
                    <button
                        type="button"
                        onClick={() => void (canResumeTranslation ? resumeTranslation() : startTranslation())}
                        className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
                    >
                        {canResumeTranslation ? '继续翻译' : '重试翻译'}
                    </button>
                </>
            )}
            {status === 'error' && isRecoverableParseTask && (
                <>
                    <p className="font-medium text-red-600">解析尚未完成</p>
                    <p className="max-w-md rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm leading-6 text-red-500">
                        {error || '当前解析任务中断，请先继续解析或重新解析。'}
                    </p>
                    <button
                        type="button"
                        onClick={() => void retryParsing()}
                        className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
                    >
                        继续解析
                    </button>
                </>
            )}
        </div>
    );
}

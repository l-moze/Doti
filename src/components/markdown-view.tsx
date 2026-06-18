'use client';

import { memo, useMemo } from 'react';
import { normalizeMarkdownForRender, useMarkdownRuntime } from '@/lib/markdown-runtime';

type MarkdownViewProps = {
    value: string;
    className?: string;
};

function MarkdownViewComponent({ value, className }: MarkdownViewProps) {
    const {
        runtimeModules,
        loadFailed,
        remarkPlugins,
        rehypePlugins,
        components,
    } = useMarkdownRuntime();
    const normalizedValue = useMemo(
        () => normalizeMarkdownForRender(value),
        [value]
    );

    if (!runtimeModules) {
        return (
            <div className={`markdown-body whitespace-pre-wrap break-words ${className || ''}`.trim()}>
                {normalizedValue}
                {loadFailed ? (
                    <div className="mt-3 text-xs text-amber-600">
                        Markdown 渲染模块热更新失败，已退回纯文本显示。刷新页面后会恢复富文本渲染。
                    </div>
                ) : null}
            </div>
        );
    }

    const ReactMarkdown = runtimeModules.ReactMarkdown;

    return (
        <div className={`markdown-body ${className || ''}`.trim()}>
            <ReactMarkdown
                components={components}
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
            >
                {normalizedValue}
            </ReactMarkdown>
        </div>
    );
}

export const MarkdownView = memo(MarkdownViewComponent);

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
                        阅读内容暂时使用简化显示。刷新页面后会恢复完整排版。
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

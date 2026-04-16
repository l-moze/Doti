'use client';

import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { Options as ReactMarkdownOptions } from 'react-markdown';

type MarkdownViewProps = {
    value: string;
};

type MarkdownRuntimeModules = {
    ReactMarkdown: ComponentType<ReactMarkdownOptions>;
    remarkGfm: unknown;
    remarkMath: unknown;
    rehypeKatex: unknown;
};

type RemarkPluginList = NonNullable<ReactMarkdownOptions['remarkPlugins']>;
type RehypePluginList = NonNullable<ReactMarkdownOptions['rehypePlugins']>;

type MarkdownAstNode = {
    type?: string;
    value?: string;
    children?: MarkdownAstNode[];
};

const PLACEHOLDER_HTML_PATTERN = /^<\/?[A-Z][A-Z0-9_-]*(?: [A-Z0-9_-]+)*\s*\/?>$/;
const PLACEHOLDER_INLINE_HTML_PATTERN = /<{1,2}\/?[A-Z][A-Z0-9 _:-]{0,120}>{1,2}/g;
const LOAD_RETRY_DELAYS = [0, 250, 800];
const KATEX_OPTIONS = {
    throwOnError: false,
    strict: false,
    trust: true,
    output: 'html',
} as const;

function escapePlaceholderMatch(match: string): string {
    return match
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function sanitizePlaceholderHtmlInMarkdown(value: string): string {
    return value.replace(PLACEHOLDER_INLINE_HTML_PATTERN, escapePlaceholderMatch);
}

function rewritePlaceholderHtmlNodes(node: MarkdownAstNode): void {
    if (!Array.isArray(node.children)) return;

    for (const child of node.children) {
        if (child.type === 'html' && typeof child.value === 'string' && PLACEHOLDER_HTML_PATTERN.test(child.value.trim())) {
            child.type = 'text';
        }

        rewritePlaceholderHtmlNodes(child);
    }
}

function remarkEscapePlaceholderHtml() {
    return (tree: MarkdownAstNode) => {
        rewritePlaceholderHtmlNodes(tree);
    };
}

async function loadMarkdownRuntimeModules(): Promise<MarkdownRuntimeModules> {
    const [reactMarkdownModule, rehypeKatexModule, remarkGfmModule, remarkMathModule] = await Promise.all([
        import('react-markdown'),
        import('rehype-katex'),
        import('remark-gfm'),
        import('remark-math'),
    ]);

    return {
        ReactMarkdown: reactMarkdownModule.default,
        rehypeKatex: rehypeKatexModule.default,
        remarkGfm: remarkGfmModule.default,
        remarkMath: remarkMathModule.default,
    };
}

function MarkdownViewComponent({ value }: MarkdownViewProps) {
    const sanitizedValue = useMemo(
        () => sanitizePlaceholderHtmlInMarkdown(value),
        [value]
    );
    const [runtimeModules, setRuntimeModules] = useState<MarkdownRuntimeModules | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const retryTimeoutRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;

        const cleanupTimeout = () => {
            if (retryTimeoutRef.current !== null) {
                window.clearTimeout(retryTimeoutRef.current);
                retryTimeoutRef.current = null;
            }
        };

        const attemptLoad = async (attemptIndex: number) => {
            cleanupTimeout();

            try {
                const nextRuntimeModules = await loadMarkdownRuntimeModules();
                if (cancelled) return;
                setRuntimeModules(nextRuntimeModules);
                setLoadFailed(false);
            } catch {
                if (cancelled) return;

                if (attemptIndex >= LOAD_RETRY_DELAYS.length - 1) {
                    setLoadFailed(true);
                    return;
                }

                retryTimeoutRef.current = window.setTimeout(() => {
                    void attemptLoad(attemptIndex + 1);
                }, LOAD_RETRY_DELAYS[attemptIndex + 1]);
            }
        };

        void attemptLoad(0);

        return () => {
            cancelled = true;
            cleanupTimeout();
        };
    }, []);

    const remarkPlugins = useMemo(() => {
        if (!runtimeModules) return [] as RemarkPluginList;
        return [runtimeModules.remarkGfm, runtimeModules.remarkMath, remarkEscapePlaceholderHtml] as RemarkPluginList;
    }, [runtimeModules]);

    const rehypePlugins = useMemo(() => {
        if (!runtimeModules) return [] as RehypePluginList;
        return [[runtimeModules.rehypeKatex, KATEX_OPTIONS]] as RehypePluginList;
    }, [runtimeModules]);

    if (!runtimeModules) {
        return (
            <div className="markdown-body whitespace-pre-wrap break-words">
                {sanitizedValue}
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
        <div className="markdown-body">
            <ReactMarkdown
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
            >
                {sanitizedValue}
            </ReactMarkdown>
        </div>
    );
}

export const MarkdownView = memo(MarkdownViewComponent);

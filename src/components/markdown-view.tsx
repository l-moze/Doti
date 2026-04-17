'use client';

import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { Options as ReactMarkdownOptions } from 'react-markdown';
import { repairDanglingHtmlTables } from '@/lib/markdown-table-utils';

type MarkdownViewProps = {
    value: string;
    className?: string;
};

type MarkdownRuntimeModules = {
    ReactMarkdown: ComponentType<ReactMarkdownOptions>;
    remarkGfm: unknown;
    remarkMath: unknown;
    rehypeKatex: unknown;
    rehypeRaw: unknown;
    rehypeSanitize: unknown;
    sanitizeSchema: Record<string, unknown>;
};

type RemarkPluginList = NonNullable<ReactMarkdownOptions['remarkPlugins']>;
type RehypePluginList = NonNullable<ReactMarkdownOptions['rehypePlugins']>;
type MarkdownComponents = NonNullable<ReactMarkdownOptions['components']>;

type MarkdownAstNode = {
    type?: string;
    value?: string;
    children?: MarkdownAstNode[];
};

const ALLOWED_RAW_HTML_TAGS = new Set([
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
    'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li',
    'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub',
    'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'ul', 'var', 'wbr',
]);
const RAW_HTML_TAG_NAME_PATTERN = /^<\/?([a-zA-Z][a-zA-Z0-9:_-]*)\b/;
const LOAD_RETRY_DELAYS = [0, 250, 800];
const TABLE_HTML_TAG_PATTERN = /&lt;(\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col)\b[\s\S]*?)&gt;/gi;
const KATEX_OPTIONS = {
    throwOnError: false,
    strict: false,
    trust: true,
    output: 'html',
} as const;

function decodeHtmlAttributeEntities(value: string): string {
    return value
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, '&');
}

function normalizeEscapedTableHtml(markdown: string): string {
    if (!markdown.includes('&lt;') && !markdown.includes('"<table') && !markdown.includes("'&lt;table")) {
        return markdown;
    }

    const lines = markdown.split(/\r?\n/);
    let activeFence: string | null = null;

    const normalizedLines = lines.map((line) => {
        const trimmed = line.trim();
        const fenceMatch = trimmed.match(/^(```|~~~)/);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            activeFence = activeFence === marker ? null : marker;
            return line;
        }

        if (activeFence) {
            return line;
        }

        let nextLine = line;
        const trimmedLine = nextLine.trim();
        const hasWrappedQuotedTable = (
            /^["'](?:&lt;|<)table\b/i.test(trimmedLine)
            && /(?:&lt;|<)\/table(?:&gt;|>)["']$/i.test(trimmedLine)
            && trimmedLine[0] === trimmedLine[trimmedLine.length - 1]
        );

        if (hasWrappedQuotedTable) {
            const quote = trimmedLine[0];
            const firstQuoteIndex = nextLine.indexOf(quote);
            const lastQuoteIndex = nextLine.lastIndexOf(quote);
            if (firstQuoteIndex !== -1 && lastQuoteIndex > firstQuoteIndex) {
                nextLine = `${nextLine.slice(0, firstQuoteIndex)}${nextLine.slice(firstQuoteIndex + 1, lastQuoteIndex)}${nextLine.slice(lastQuoteIndex + 1)}`;
            }
        }

        return nextLine.replace(TABLE_HTML_TAG_PATTERN, (_match, tagContent: string) => {
            return `<${decodeHtmlAttributeEntities(tagContent)}>`;
        });
    });

    return normalizedLines.join('\n');
}

function isAllowedRawHtmlTag(rawTag: string): boolean {
    const match = rawTag.trim().match(RAW_HTML_TAG_NAME_PATTERN);
    if (!match) return false;
    return ALLOWED_RAW_HTML_TAGS.has(match[1].toLowerCase());
}

function rewriteDisallowedHtmlNodes(node: MarkdownAstNode): void {
    if (!Array.isArray(node.children)) return;

    for (const child of node.children) {
        if (child.type === 'html' && typeof child.value === 'string' && !isAllowedRawHtmlTag(child.value)) {
            child.type = 'text';
        }

        rewriteDisallowedHtmlNodes(child);
    }
}

function remarkEscapeDisallowedHtml() {
    return (tree: MarkdownAstNode) => {
        rewriteDisallowedHtmlNodes(tree);
    };
}

async function loadMarkdownRuntimeModules(): Promise<MarkdownRuntimeModules> {
    const [
        reactMarkdownModule,
        rehypeKatexModule,
        rehypeRawModule,
        rehypeSanitizeModule,
        remarkGfmModule,
        remarkMathModule,
    ] = await Promise.all([
        import('react-markdown'),
        import('rehype-katex'),
        import('rehype-raw'),
        import('rehype-sanitize'),
        import('remark-gfm'),
        import('remark-math'),
    ]);

    const defaultSchema = rehypeSanitizeModule.defaultSchema;
    const sharedAttributes = Array.isArray(defaultSchema.attributes?.['*'])
        ? [...defaultSchema.attributes['*']]
        : [];

    const sanitizeSchema = {
        ...defaultSchema,
        tagNames: [...new Set([...(defaultSchema.tagNames || []), 'col', 'colgroup'])],
        ancestors: {
            ...(defaultSchema.ancestors || {}),
            col: ['colgroup', 'table'],
            colgroup: ['table'],
        },
        attributes: {
            ...(defaultSchema.attributes || {}),
            '*': [...new Set([
                ...sharedAttributes,
                'colSpan',
                'rowSpan',
                'data-doti-figure-group',
                'data-doti-figure-grid',
                'data-doti-subfigure',
                'data-doti-subcaption',
            ])],
            col: ['span', 'width'],
            colgroup: ['span', 'width'],
        },
    };

    return {
        ReactMarkdown: reactMarkdownModule.default,
        rehypeKatex: rehypeKatexModule.default,
        rehypeRaw: rehypeRawModule.default,
        rehypeSanitize: rehypeSanitizeModule.default,
        remarkGfm: remarkGfmModule.default,
        remarkMath: remarkMathModule.default,
        sanitizeSchema,
    };
}

function MarkdownViewComponent({ value, className }: MarkdownViewProps) {
    const [runtimeModules, setRuntimeModules] = useState<MarkdownRuntimeModules | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const retryTimeoutRef = useRef<number | null>(null);
    const normalizedValue = useMemo(
        () => repairDanglingHtmlTables(normalizeEscapedTableHtml(value)),
        [value]
    );

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
        return [runtimeModules.remarkGfm, runtimeModules.remarkMath, remarkEscapeDisallowedHtml] as RemarkPluginList;
    }, [runtimeModules]);

    const rehypePlugins = useMemo(() => {
        if (!runtimeModules) return [] as RehypePluginList;
        return [
            runtimeModules.rehypeRaw,
            [runtimeModules.rehypeSanitize, runtimeModules.sanitizeSchema],
            [runtimeModules.rehypeKatex, KATEX_OPTIONS],
        ] as RehypePluginList;
    }, [runtimeModules]);

    const components = useMemo<MarkdownComponents>(() => ({
        table(props) {
            const { node, ...tableProps } = props;
            void node;
            return (
                <div className="markdown-table-wrap">
                    <table {...tableProps} />
                </div>
            );
        },
    }), []);

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

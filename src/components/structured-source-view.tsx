'use client';
/* eslint-disable @next/next/no-img-element */

import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { Options as ReactMarkdownOptions } from 'react-markdown';
import type { DocumentSemanticBlock, DocumentSemanticChild, DocumentSemanticProjection } from '@/lib/document-semantic';
import { repairDanglingHtmlTables } from '@/lib/markdown-table-utils';

type StructuredSourceViewProps = {
    projection: DocumentSemanticProjection;
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

function useMarkdownRuntime() {
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

    return {
        runtimeModules,
        loadFailed,
        remarkPlugins,
        rehypePlugins,
        components,
    };
}

function normalizeMarkdownFragment(value: string): string {
    return repairDanglingHtmlTables(normalizeEscapedTableHtml(value));
}

function MarkdownFragment({
    value,
    runtimeModules,
    remarkPlugins,
    rehypePlugins,
    components,
}: {
    value: string;
    runtimeModules: MarkdownRuntimeModules | null;
    remarkPlugins: RemarkPluginList;
    rehypePlugins: RehypePluginList;
    components: MarkdownComponents;
}) {
    const normalizedValue = useMemo(() => normalizeMarkdownFragment(value), [value]);

    if (!runtimeModules) {
        return <div className="whitespace-pre-wrap break-words">{normalizedValue}</div>;
    }

    const ReactMarkdown = runtimeModules.ReactMarkdown;

    return (
        <ReactMarkdown
            components={components}
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
        >
            {normalizedValue}
        </ReactMarkdown>
    );
}

function renderFigureGrid(children: DocumentSemanticChild[]) {
    return children.map((child) => (
        <figure
            key={child.id}
            className="flex min-w-0 flex-col gap-2 rounded-2xl border border-slate-200 bg-slate-50/70 p-3"
            data-doti-subfigure="true"
        >
            {child.assetPath ? (
                <img
                    src={child.assetPath}
                    alt={child.subfigureCaption || child.captionText || ''}
                    className="w-full rounded-xl border border-slate-200 bg-white object-contain"
                    loading="lazy"
                />
            ) : null}
            {child.subfigureCaption || child.captionText ? (
                <figcaption className="text-sm leading-6 text-slate-600" data-doti-subcaption="true">
                    {child.subfigureCaption || child.captionText}
                </figcaption>
            ) : null}
        </figure>
    ));
}

function FigureBlock({ block }: { block: DocumentSemanticBlock }) {
    if (block.children.length > 0) {
        return (
            <figure className="not-prose flex flex-col gap-4" data-doti-figure-group="true">
                <div
                    className={`grid gap-4 ${block.children.length >= 3 ? 'md:grid-cols-2 xl:grid-cols-3' : block.children.length === 2 ? 'md:grid-cols-2' : ''}`}
                    data-doti-figure-grid="true"
                >
                    {renderFigureGrid(block.children)}
                </div>
                {block.captionText ? (
                    <figcaption className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700">
                        {block.captionText}
                    </figcaption>
                ) : null}
            </figure>
        );
    }

    return (
        <figure className="not-prose flex flex-col gap-3 rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
            {block.assetPath ? (
                <img
                    src={block.assetPath}
                    alt={block.captionText || ''}
                    className="w-full rounded-2xl border border-slate-200 bg-white object-contain"
                    loading="lazy"
                />
            ) : null}
            {block.captionText ? (
                <figcaption className="text-sm leading-6 text-slate-700">
                    {block.captionText}
                </figcaption>
            ) : null}
        </figure>
    );
}

function blockWrapperClassName(block: DocumentSemanticBlock): string {
    if (block.kind === 'figure') return 'semantic-block semantic-block-figure';
    if (block.kind === 'table') return 'semantic-block semantic-block-table';
    if (block.kind === 'code') return 'semantic-block semantic-block-code';
    if (block.kind === 'equation') return 'semantic-block semantic-block-equation';
    return 'semantic-block';
}

function renderBlockContent(
    block: DocumentSemanticBlock,
    markdownRenderer: (value: string) => ReactNode
) {
    if (block.kind === 'figure') {
        return <FigureBlock block={block} />;
    }

    return markdownRenderer(block.markdown);
}

function StructuredSourceViewComponent({ projection, className }: StructuredSourceViewProps) {
    const {
        runtimeModules,
        loadFailed,
        remarkPlugins,
        rehypePlugins,
        components,
    } = useMarkdownRuntime();

    const renderMarkdown = (value: string) => (
        <MarkdownFragment
            value={value}
            runtimeModules={runtimeModules}
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={components}
        />
    );

    return (
        <div className={`markdown-body ${className || ''}`.trim()}>
            {loadFailed ? (
                <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                    Markdown 渲染模块热更新失败，当前已退回稳定渲染模式。刷新页面后会恢复完整富文本能力。
                </div>
            ) : null}

            {projection.blocks.map((block) => (
                <section
                    key={block.id}
                    id={block.semanticId}
                    data-semantic-block-id={block.semanticId}
                    data-semantic-kind={block.kind}
                    className={blockWrapperClassName(block)}
                >
                    {renderBlockContent(block, renderMarkdown)}
                </section>
            ))}
        </div>
    );
}

export const StructuredSourceView = memo(StructuredSourceViewComponent);
StructuredSourceView.displayName = 'StructuredSourceView';

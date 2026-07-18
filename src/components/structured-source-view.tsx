'use client';
/* eslint-disable @next/next/no-img-element */

import { memo, useMemo, type ReactNode } from 'react';
import type { DocumentSemanticBlock, DocumentSemanticChild, DocumentSemanticProjection } from '@/lib/document-semantic';
import { normalizeMarkdownForRender, useMarkdownRuntime, type MarkdownRuntimeState } from '@/lib/markdown-runtime';

type StructuredSourceViewProps = {
    projection: DocumentSemanticProjection;
    className?: string;
    highlightedBlockId?: string | null;
};
function MarkdownFragment({
    value,
    markdownRuntime,
}: {
    value: string;
    markdownRuntime: MarkdownRuntimeState;
}) {
    const normalizedValue = useMemo(() => normalizeMarkdownForRender(value), [value]);
    const {
        runtimeModules,
        remarkPlugins,
        rehypePlugins,
        components,
    } = markdownRuntime;

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

function renderFigureGrid(children: DocumentSemanticChild[], highlightedBlockId?: string | null) {
    return children.map((child) => (
        <figure
            key={child.id}
            id={child.semanticId}
            className={`flex min-w-0 flex-col gap-2 rounded-2xl border p-3 transition ${
                child.semanticId && highlightedBlockId === child.semanticId
                    ? 'border-sky-300 bg-sky-50/90 shadow-[0_0_0_3px_rgba(56,189,248,0.15)]'
                    : 'border-slate-200 bg-slate-50/70'
            }`}
            data-doti-subfigure="true"
            data-semantic-block-id={child.semanticId}
            data-semantic-kind="figure"
            data-semantic-active={child.semanticId && highlightedBlockId === child.semanticId ? 'true' : undefined}
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

function FigureBlock({
    block,
    highlightedBlockId,
}: {
    block: DocumentSemanticBlock;
    highlightedBlockId?: string | null;
}) {
    const childHighlighted = block.children.some((child) => child.semanticId === highlightedBlockId);
    const blockHighlighted = block.semanticId === highlightedBlockId;
    const figureFrameClassName = blockHighlighted || childHighlighted
        ? 'ring-2 ring-sky-200/80 ring-offset-2 ring-offset-white'
        : '';

    if (block.children.length > 0) {
        return (
            <figure
                className={`not-prose flex flex-col gap-4 rounded-lg transition ${figureFrameClassName}`.trim()}
                data-doti-figure-group="true"
                data-semantic-active={blockHighlighted || childHighlighted ? 'true' : undefined}
            >
                <div
                    className={`grid gap-4 ${block.children.length >= 3 ? 'md:grid-cols-2 xl:grid-cols-3' : block.children.length === 2 ? 'md:grid-cols-2' : ''}`}
                    data-doti-figure-grid="true"
                >
                    {renderFigureGrid(block.children, highlightedBlockId)}
                </div>
                {block.captionText ? (
                    <figcaption
                    className={`rounded-lg border px-4 py-3 text-sm leading-6 transition ${
                            blockHighlighted || childHighlighted
                                ? 'border-sky-200 bg-sky-50/80 text-slate-800'
                                : 'border-slate-200 bg-white text-slate-700'
                        }`}
                    >
                        {block.captionText}
                    </figcaption>
                ) : null}
            </figure>
        );
    }

    return (
        <figure
            className={`not-prose flex flex-col gap-3 rounded-lg border p-4 transition ${
                blockHighlighted
                    ? 'border-sky-300 bg-sky-50/80 shadow-[0_0_0_3px_rgba(56,189,248,0.15)]'
                    : 'border-slate-200 bg-slate-50/70'
            }`}
            data-semantic-active={blockHighlighted ? 'true' : undefined}
        >
            {block.assetPath ? (
                <img
                    src={block.assetPath}
                    alt={block.captionText || ''}
                    className="w-full rounded-lg border border-slate-200 bg-white object-contain"
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
    markdownRenderer: (value: string) => ReactNode,
    highlightedBlockId?: string | null
) {
    if (block.kind === 'figure') {
        return <FigureBlock block={block} highlightedBlockId={highlightedBlockId} />;
    }

    return markdownRenderer(block.markdown);
}

function StructuredSourceViewComponent({ projection, className, highlightedBlockId }: StructuredSourceViewProps) {
    const markdownRuntime = useMarkdownRuntime();
    const { loadFailed } = markdownRuntime;

    const renderMarkdown = (value: string) => (
        <MarkdownFragment
            value={value}
            markdownRuntime={markdownRuntime}
        />
    );

    return (
        <div className={`markdown-body ${className || ''}`.trim()}>
            {loadFailed ? (
                <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                    阅读内容暂时使用简化显示。刷新页面后会恢复完整排版。
                </div>
            ) : null}

            {projection.blocks.map((block) => {
                const blockHighlighted = block.semanticId === highlightedBlockId;
                const childHighlighted = block.children.some((child) => child.semanticId === highlightedBlockId);

                return (
                    <section
                        key={block.id}
                        id={block.semanticId}
                        data-semantic-block-id={block.semanticId}
                        data-semantic-kind={block.kind}
                        data-semantic-active={blockHighlighted || childHighlighted ? 'true' : undefined}
                        className={`${blockWrapperClassName(block)} transition ${
                            blockHighlighted
                                ? 'rounded-lg bg-sky-50/60'
                                : childHighlighted
                                    ? 'rounded-lg bg-slate-50/80'
                                    : ''
                        }`.trim()}
                    >
                        {renderBlockContent(block, renderMarkdown, highlightedBlockId)}
                    </section>
                );
            })}
        </div>
    );
}

export const StructuredSourceView = memo(StructuredSourceViewComponent);
StructuredSourceView.displayName = 'StructuredSourceView';

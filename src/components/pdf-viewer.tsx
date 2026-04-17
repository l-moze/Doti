'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect, useMemo } from 'react';
import { useTranslationStore } from '@/lib/store';
import type { DocumentSemanticAnchor, DocumentSemanticProjection } from '@/lib/document-semantic';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2, Layers } from 'lucide-react';

// 动态导入 react-pdf 组件，禁用 SSR 以避免 DOMMatrix 错误
const Document = dynamic(
    () => import('react-pdf').then((mod) => mod.Document),
    { ssr: false }
);

const Page = dynamic(
    () => import('react-pdf').then((mod) => mod.Page),
    { ssr: false }
);

// PDF Worker 配置组件（仅在客户端执行）
function PDFWorkerConfig() {
    if (typeof window !== 'undefined') {
        import('react-pdf').then((pdfjs) => {
            pdfjs.pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.pdfjs.version}/build/pdf.worker.min.mjs`;
        });
    }
    return null;
}

// 布局块类型对应的颜色
const BLOCK_TYPE_COLORS: Record<string, string> = {
    heading: 'rgba(59, 130, 246, 0.28)',
    paragraph: 'rgba(34, 197, 94, 0.18)',
    figure: 'rgba(234, 179, 8, 0.28)',
    table: 'rgba(168, 85, 247, 0.28)',
    equation: 'rgba(236, 72, 153, 0.28)',
    list: 'rgba(20, 184, 166, 0.2)',
    code: 'rgba(249, 115, 22, 0.28)',
    footnote: 'rgba(100, 116, 139, 0.18)',
    other: 'rgba(148, 163, 184, 0.2)',
};

function toOpaqueBorderColor(color: string): string {
    return color.replace(/rgba\(([^)]+),\s*(0?\.\d+)\)/i, 'rgba($1, 1)');
}

// 布局叠加层组件
function LayoutOverlay({
    anchors,
    pdfWidth,
    pdfHeight,
    pageIndex,
}: {
    anchors: DocumentSemanticAnchor[];
    pdfWidth: number;
    pdfHeight: number;
    pageIndex: number;
}) {
    const { setHighlightedBlock, highlightedBlockId } = useTranslationStore();

    return (
        <div
            className="absolute inset-0 z-10"
            // 使用 % 定位，容器尺寸跟随父级（PDF Page 容器）
            style={{ width: '100%', height: '100%' }}
        >
            {anchors.map((anchor) => {
                const [x0, y0, x1, y1] = anchor.bbox;
                const color = BLOCK_TYPE_COLORS[anchor.kind] || 'rgba(156, 163, 175, 0.3)';
                const borderColor = toOpaqueBorderColor(color);
                const semanticId = anchor.semanticId;

                // 检查是否被高亮
                const isHighlighted = semanticId === highlightedBlockId;

                // 计算百分比位置
                const left = (x0 / pdfWidth) * 100;
                const top = (y0 / pdfHeight) * 100;
                const width = ((x1 - x0) / pdfWidth) * 100;
                const height = ((y1 - y0) / pdfHeight) * 100;

                return (
                    <div
                        key={anchor.id}
                        className={`absolute cursor-pointer transition-all duration-200 group ${isHighlighted ? 'z-50' : 'hover:z-20'}`}
                        style={{
                            left: `${left}%`,
                            top: `${top}%`,
                            width: `${width}%`,
                            height: `${height}%`,
                            border: isHighlighted ? `3px solid ${borderColor}` : `1px solid transparent`, // 默认透明边框，避免视觉杂乱
                            boxShadow: isHighlighted ? `0 0 8px ${color}` : 'none',
                        }}
                        onClick={(e) => {
                            e.stopPropagation();
                            setHighlightedBlock(semanticId);
                            console.log('Clicked block:', semanticId, anchor.kind, 'page:', pageIndex);
                        }}
                    >
                        {/* 边框 Hover 效果 */}
                        <div className="absolute inset-0 border-2 border-transparent group-hover:border-current transition-colors" style={{ color: borderColor }} />

                        {/* Hover Overlay */}
                        <div
                            className={`absolute inset-0 transition-opacity ${isHighlighted ? 'opacity-30' : 'opacity-0 group-hover:opacity-20'}`}
                            style={{ backgroundColor: color }}
                        />

                        {/* Tooltip: 仅 Hover 显示 */}
                        <span
                            className={`absolute -top-6 left-0 text-[10px] px-2 py-0.5 rounded font-mono font-medium shadow-sm transition-opacity whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 z-50`}
                            style={{
                                backgroundColor: borderColor,
                                color: '#fff'
                            }}
                        >
                            {anchor.kind}
                            {semanticId ? ` (${semanticId})` : ''}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

export function PDFViewer({ projection = null }: { projection?: DocumentSemanticProjection | null }) {
    const { fileUrl, highlightedBlockId } = useTranslationStore();
    const [numPages, setNumPages] = useState<number>(0);
    const [pageNumber, setPageNumber] = useState<number>(1);
    const [scale, setScale] = useState<number>(1.0);
    const [showLayout, setShowLayout] = useState(false);

    const semanticToPage = useMemo(() => {
        const nextSemanticToPage: Record<string, number> = {};
        if (!projection) return nextSemanticToPage;

        for (const anchor of projection.anchors) {
            if (nextSemanticToPage[anchor.semanticId] === undefined) {
                nextSemanticToPage[anchor.semanticId] = anchor.pageIndex;
            }
        }

        for (const block of projection.blocks) {
            if (nextSemanticToPage[block.semanticId] === undefined) {
                nextSemanticToPage[block.semanticId] = block.pageIndex;
            }
        }

        return nextSemanticToPage;
    }, [projection]);

    // 监听 highlightedBlockId 变化，自动跳转页面
    useEffect(() => {
        if (highlightedBlockId && semanticToPage) {
            const targetPage = semanticToPage[highlightedBlockId];
            if (targetPage !== undefined) {
                const frame = window.requestAnimationFrame(() => {
                    setPageNumber(targetPage + 1);
                });
                return () => window.cancelAnimationFrame(frame);
            }
        }
    }, [highlightedBlockId, semanticToPage]);

    // 重置状态当文件改变时
    useEffect(() => {
        const frame = window.requestAnimationFrame(() => {
            setNumPages(0);
            setPageNumber(1);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [fileUrl]);

    function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
        setNumPages(numPages);
    }

    if (!fileUrl) {
        return (
            <div className="flex h-full items-center justify-center bg-muted/20 text-muted-foreground p-8 border-2 border-dashed rounded-lg">
                <p>No PDF loaded</p>
            </div>
        );
    }

    const currentAnchors = projection?.anchors.filter((anchor) => anchor.pageIndex === pageNumber - 1) || [];
    const pdfPageSize = projection?.pageSizes?.[pageNumber - 1] || [612, 792];
    const canShowLayout = currentAnchors.length > 0 || (projection?.anchors.length || 0) > 0;

    return (
        <div className="flex flex-col h-full bg-slate-50 border rounded-lg overflow-hidden">
            <PDFWorkerConfig />

            {/* Toolbar */}
            <div className="flex items-center justify-between p-2 border-b bg-white">
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setPageNumber(Math.max(1, pageNumber - 1))}
                        disabled={pageNumber <= 1}
                        className="p-1 hover:bg-slate-100 rounded disabled:opacity-50"
                    >
                        <ChevronLeft size={20} />
                    </button>
                    <span className="text-sm">
                        Page {pageNumber} of {numPages}
                    </span>
                    <button
                        onClick={() => setPageNumber(Math.min(numPages, pageNumber + 1))}
                        disabled={pageNumber >= numPages}
                        className="p-1 hover:bg-slate-100 rounded disabled:opacity-50"
                    >
                        <ChevronRight size={20} />
                    </button>
                </div>

                {canShowLayout && (
                    <div className="flex items-center gap-2">
                        <label className="text-xs font-medium cursor-pointer flex items-center gap-2 select-none">
                            <input
                                type="checkbox"
                                checked={showLayout}
                                onChange={(e) => setShowLayout(e.target.checked)}
                                className="accent-primary h-4 w-4"
                            />
                            <Layers size={14} />
                            Show Layout
                        </label>
                    </div>
                )}

                <div className="flex items-center gap-2">
                    <button onClick={() => setScale(s => Math.max(0.5, s - 0.1))} className="p-1 hover:bg-slate-100 rounded">
                        <ZoomOut size={20} />
                    </button>
                    <span className="text-sm w-12 text-center">{Math.round(scale * 100)}%</span>
                    <button onClick={() => setScale(s => Math.min(2.0, s + 0.1))} className="p-1 hover:bg-slate-100 rounded">
                        <ZoomIn size={20} />
                    </button>
                </div>
            </div>

            {/* Viewer */}
            <div className="flex-1 overflow-auto flex justify-center p-4">
                <div className="relative">
                    <Document
                        key={fileUrl}
                        file={fileUrl}
                        onLoadSuccess={onDocumentLoadSuccess}
                        className="shadow-lg"
                        loading={
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <Loader2 className="animate-spin" /> Loading PDF...
                            </div>
                        }
                        error={
                            <div className="flex flex-col items-center justify-center p-8 text-center h-full">
                                <p className="text-red-500 font-medium mb-2">Failed to load PDF</p>
                            </div>
                        }
                    >
                        <Page
                            pageNumber={pageNumber}
                            scale={scale}
                            renderTextLayer={false}
                            renderAnnotationLayer={false}
                            className="relative" // 确保 Page 是 relative 的，由于 react-pdf 的 Page 内部结构复杂，我们可能需要在外部包裹
                        >
                            {showLayout && currentAnchors.length > 0 && (
                                <LayoutOverlay
                                    anchors={currentAnchors}
                                    pdfWidth={pdfPageSize[0]}
                                    pdfHeight={pdfPageSize[1]}
                                    pageIndex={pageNumber - 1}
                                />
                            )}
                        </Page>
                    </Document>
                </div>
            </div>
        </div>
    );
}

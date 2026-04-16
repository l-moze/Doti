'use client';

import dynamic from 'next/dynamic';
import { useState, useEffect, useMemo } from 'react';
import { useTranslationStore } from '@/lib/store';
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
    'title': 'rgba(59, 130, 246, 0.3)',       // blue
    'text': 'rgba(34, 197, 94, 0.2)',          // green
    'image': 'rgba(234, 179, 8, 0.3)',         // yellow
    'table': 'rgba(168, 85, 247, 0.3)',        // purple
    'interline_equation': 'rgba(236, 72, 153, 0.3)', // pink
    'list': 'rgba(20, 184, 166, 0.2)',         // teal
    'code': 'rgba(249, 115, 22, 0.3)',         // orange
};

// Layout JSON 数据结构
interface LayoutBlock {
    bbox: number[];
    type: string;
    index?: number;
    lines?: Array<{
        spans?: Array<{
            content?: string;
        }>;
    }>;
}

interface PageLayout {
    page_idx: number;
    page_size: [number, number]; // [width, height]
    para_blocks: LayoutBlock[];
    discarded_blocks?: LayoutBlock[];
}

interface LayoutData {
    pdf_info: PageLayout[];
}

// 布局叠加层组件
function LayoutOverlay({
    layoutBlocks,
    pdfWidth,
    pdfHeight,
    pageIndex, // 传入当前页码
    semanticMap // 传入语义化 ID 映射 { "page-blockIdx": "semanticId" }
}: {
    layoutBlocks: LayoutBlock[];
    pdfWidth: number;
    pdfHeight: number;
    pageIndex: number;
    semanticMap: Record<string, string>;
}) {
    const { setHighlightedBlock, highlightedBlockId } = useTranslationStore();

    return (
        <div
            className="absolute inset-0 z-10"
            // 使用 % 定位，容器尺寸跟随父级（PDF Page 容器）
            style={{ width: '100%', height: '100%' }}
        >
            {layoutBlocks.map((block, idx) => {
                const [x0, y0, x1, y1] = block.bbox;
                const color = BLOCK_TYPE_COLORS[block.type] || 'rgba(156, 163, 175, 0.3)';
                const borderColor = color.replace('0.2', '1').replace('0.3', '1');

                // 获取语义化 ID
                const blockKey = `${pageIndex}-${idx}`;
                const semanticId = semanticMap[blockKey];

                // 检查是否被高亮
                const isHighlighted = semanticId === highlightedBlockId;

                // 计算百分比位置
                const left = (x0 / pdfWidth) * 100;
                const top = (y0 / pdfHeight) * 100;
                const width = ((x1 - x0) / pdfWidth) * 100;
                const height = ((y1 - y0) / pdfHeight) * 100;

                return (
                    <div
                        key={idx}
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
                            if (semanticId) {
                                setHighlightedBlock(semanticId);
                                console.log('Clicked block:', semanticId, block.type);
                            }
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
                            {/* 如果 block ID 是 image/table 但 type 是 text，说明是 Caption */}
                            {block.type === 'text' && (semanticId?.includes('image') || semanticId?.includes('table'))
                                ? 'caption'
                                : block.type}
                            {semanticId ? ` (${semanticId})` : ''}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

export function PDFViewer() {
    const { fileUrl, layoutJsonUrl, highlightedBlockId } = useTranslationStore();
    const [numPages, setNumPages] = useState<number>(0);
    const [pageNumber, setPageNumber] = useState<number>(1);
    const [scale, setScale] = useState<number>(1.0);
    const [showLayout, setShowLayout] = useState(false);
    const [layoutData, setLayoutData] = useState<LayoutData | null>(null);
    const [loadingLayout, setLoadingLayout] = useState(false);

    // 生成语义化映射表和反向查找表
    const { semanticMap, semanticToPage } = useMemo(() => {
        if (!layoutData?.pdf_info) return { semanticMap: {}, semanticToPage: {} };

        const semanticMap: Record<string, string> = {}; // "pageIdx-blockIdx" -> "sec-N-type-M"
        const semanticToPage: Record<string, number> = {}; // "sec-N-type-M" -> pageIdx

        let titleIdx = -1;
        let counters: Record<string, number> = { image: 0, table: 0, text: 0, formula: 0 };

        // 辅助函数：检测是否为 Caption
        const isCaption = (text: string) => /^(Figure|Fig\.|Table)\s*\d+/i.test(text);
        const getBlockText = (block: LayoutBlock) => block.lines?.[0]?.spans?.[0]?.content || '';

        layoutData.pdf_info.forEach((page) => {
            const blocks = page.para_blocks;

            blocks.forEach((block, blockIdx) => {
                const key = `${page.page_idx}-${blockIdx}`;

                if (block.type === 'title') {
                    titleIdx++;
                    counters = { image: 0, table: 0, text: 0, formula: 0 };

                    const sid = `sec-${titleIdx}-title-0`;
                    semanticMap[key] = sid;
                    semanticToPage[sid] = page.page_idx;
                } else {
                    // Caption 合并逻辑
                    let isMergedCaption = false;
                    let mergedId = '';

                    if (block.type === 'text') {
                        const text = getBlockText(block);
                        if (isCaption(text)) {
                            // 检查前一个或后一个是否是对应的媒体
                            const prev = blocks[blockIdx - 1];
                            const next = blocks[blockIdx + 1];

                            // 关联 Prev (Box BELOW Caption?) usually caption is below figure, above table.
                            if (prev && ['image', 'table', 'figure'].includes(prev.type)) {
                                const prevKey = `${page.page_idx}-${blockIdx - 1}`;
                                if (semanticMap[prevKey]) {
                                    mergedId = semanticMap[prevKey];
                                    isMergedCaption = true;
                                }
                            } else if (next && ['image', 'table', 'figure'].includes(next.type)) {
                                // 预判下一个是媒体：借用下一个即将生成的流水号
                                // 这是一个简化的假设：假设下一个 block 必然会按照常规逻辑生成 ID
                                let typeKey = 'image';
                                if (['table'].includes(next.type)) typeKey = 'table';

                                const currentTitleIdx = titleIdx;
                                const count = counters[typeKey] || 0;
                                // 注意：我们这是在"引用"媒体的 ID，真正的媒体处理时会生成它
                                mergedId = `sec-${currentTitleIdx}-${typeKey}-${count}`;
                                isMergedCaption = true;
                            }
                        }
                    }

                    if (isMergedCaption) {
                        semanticMap[key] = mergedId;
                        // 不更新 semanticToPage，因为这只是 caption，让页面跳转也尽量去主物体
                        // 但如果是 caption 先出现 (Table Caption)，那可能需要 map
                        if (!semanticToPage[mergedId]) {
                            semanticToPage[mergedId] = page.page_idx;
                        }
                    } else {
                        // 标准逻辑
                        let typeKey = 'text';
                        if (['image', 'figure'].includes(block.type)) typeKey = 'image';
                        else if (['table'].includes(block.type)) typeKey = 'table';
                        else if (['interline_equation', 'equation'].includes(block.type)) typeKey = 'formula';

                        const currentTitleIdx = titleIdx;
                        const count = counters[typeKey] || 0;
                        counters[typeKey] = count + 1;

                        const sid = `sec-${currentTitleIdx}-${typeKey}-${count}`;
                        semanticMap[key] = sid;
                        semanticToPage[sid] = page.page_idx;
                    }
                }
            });
        });

        return { semanticMap, semanticToPage };
    }, [layoutData]);

    // 监听 highlightedBlockId 变化，自动跳转页面
    useEffect(() => {
        if (highlightedBlockId && semanticToPage) {
            const targetPage = semanticToPage[highlightedBlockId];
            if (targetPage !== undefined) {
                setPageNumber(targetPage + 1);
            }
        }
    }, [highlightedBlockId, semanticToPage]);

    // 重置状态当文件改变时
    useEffect(() => {
        // 当fileUrl改变时,清理旧文件的状态
        setLayoutData(null);
        setNumPages(0);
        setPageNumber(1);
    }, [fileUrl]);

    // 加载布局数据
    useEffect(() => {
        if (showLayout && layoutJsonUrl && !layoutData) {
            setLoadingLayout(true);
            fetch(layoutJsonUrl)
                .then(res => res.json())
                .then(data => {
                    setLayoutData(data);
                    setLoadingLayout(false);
                })
                .catch(err => {
                    console.error('Failed to load layout data:', err);
                    setLoadingLayout(false);
                });
        }
    }, [showLayout, layoutJsonUrl, layoutData]);



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

    // 获取当前页面的布局信息
    const currentPageLayout = layoutData?.pdf_info?.find(p => p.page_idx === pageNumber - 1);
    const currentBlocks = currentPageLayout?.para_blocks || [];
    const pdfPageSize = currentPageLayout?.page_size || [612, 792]; // 默认 Letter 尺寸

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

                {/* Layout Toggle - Only show if layoutJsonUrl is available */}
                {layoutJsonUrl && (
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
                        {loadingLayout && <Loader2 size={14} className="animate-spin text-primary" />}
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
                            {/* Layout Overlay 作为 Page 的子元素（如果 Page 支持 children 渲染在最上层）或者使用绝对定位覆盖 */}
                            {/* 为了稳健，我们使用绝对定位覆盖在 Page 上。React-PDF Page 通常渲染一个 Canvas */}
                            {showLayout && currentBlocks.length > 0 && (
                                <LayoutOverlay
                                    layoutBlocks={currentBlocks}
                                    pdfWidth={pdfPageSize[0]}
                                    pdfHeight={pdfPageSize[1]}
                                    pageIndex={pageNumber - 1} // 0-indexed
                                    semanticMap={semanticMap}
                                />
                            )}
                        </Page>
                    </Document>
                </div>
            </div>
        </div>
    );
}

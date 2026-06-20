'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { listAnnotationsForDocument, type AnnotationRecord } from '@/lib/db';
import { MarkdownView } from '@/components/markdown-view';
import { normalizeMarkdownMathForDisplay } from '@/lib/markdown-normalizer';
import { useTranslationStore } from '@/lib/store';

const TARGET_LANG_LABELS: Record<string, string> = {
    Chinese: '中文',
    Japanese: '日文',
    Korean: '韩文',
    French: '法文',
    German: '德文',
    Spanish: '西班牙文',
    Italian: '意大利文',
    Portuguese: '葡萄牙文',
};

function getTargetLangLabel(value: string): string {
    return TARGET_LANG_LABELS[value] || value;
}

async function resolveMediaUrl(fileHash: string, relativePath: string): Promise<string | null> {
    try {
        const response = await fetch(
            `/api/media/sign?fileHash=${encodeURIComponent(fileHash)}&path=${encodeURIComponent(relativePath)}`
        );
        if (!response.ok) return null;
        const data = await response.json();
        return typeof data?.url === 'string' ? data.url : null;
    } catch {
        return null;
    }
}

function annotationToMarkdown(annotations: AnnotationRecord[]): string {
    if (annotations.length === 0) return '_暂无批注_';

    return annotations.map((annotation) => {
        const header = `### ${new Date(annotation.createdAt).toLocaleString()}`;
        const selected = `> ${annotation.selectedText}`;
        const note = annotation.note.trim() || '_空白笔记_';
        return `${header}\n\n${selected}\n\n${note}`;
    }).join('\n\n');
}

function PrintPageContent() {
    const searchParams = useSearchParams();
    const fileHash = searchParams.get('fileHash');
    const targetLang = searchParams.get('targetLang') || 'Chinese';
    const targetLangLabel = getTargetLangLabel(targetLang);
    const mode = searchParams.get('mode') || 'translation';
    const translationArtifact = searchParams.get('translationArtifact');
    const modeLabel =
        mode === 'source' ? '原文视图' :
            mode === 'bilingual' ? '对照视图' :
                mode === 'notes' ? '阅读笔记' :
                    mode === 'bilingual-notes' ? '译文 + 阅读笔记' :
                        '译文视图';
    const modeIncludesTranslation = mode === 'translation' || mode === 'bilingual' || mode === 'bilingual-notes';
    const printSubtitle = modeIncludesTranslation ? `${modeLabel} · ${targetLangLabel}` : modeLabel;

    const [sourceMarkdown, setSourceMarkdown] = useState('');
    const [targetMarkdown, setTargetMarkdown] = useState('');
    const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);

    useEffect(() => {
        if (!fileHash) return;

        void (async () => {
            await useTranslationStore.persist.rehydrate();
            const workspaceState = useTranslationStore.getState();
            const workspaceFileHash = workspaceState.fileHash;
            const workspaceTargetLang = workspaceState.targetLang;
            const workspaceSourceMarkdown = workspaceState.sourceMarkdown;
            const workspaceTargetMarkdown = workspaceState.targetMarkdown;

            if (workspaceFileHash === fileHash && workspaceSourceMarkdown.trim()) {
                setSourceMarkdown(workspaceSourceMarkdown);
            } else {
                const sourceUrl = await resolveMediaUrl(fileHash, 'full.md');
                if (sourceUrl) {
                    try {
                        const response = await fetch(sourceUrl);
                        setSourceMarkdown(response.ok ? await response.text() : '');
                    } catch {
                        setSourceMarkdown('');
                    }
                } else {
                    setSourceMarkdown('');
                }
            }

            if (
                workspaceFileHash === fileHash &&
                workspaceTargetLang === targetLang &&
                workspaceTargetMarkdown.trim()
            ) {
                setTargetMarkdown(workspaceTargetMarkdown);
                return;
            }

            const translationCandidates = [
                translationArtifact ? `${translationArtifact}.md` : null,
                `translation-${targetLang}.md`,
            ].filter((value): value is string => Boolean(value));

            for (const candidate of translationCandidates) {
                const signedUrl = await resolveMediaUrl(fileHash, candidate);
                if (!signedUrl) continue;

                try {
                    const response = await fetch(signedUrl);
                    if (!response.ok) continue;
                    setTargetMarkdown(await response.text());
                    return;
                } catch {
                    // Try next candidate.
                }
            }

            setTargetMarkdown('');
        })();

        void listAnnotationsForDocument(fileHash).then(setAnnotations);
    }, [fileHash, targetLang, translationArtifact]);

    const notesMarkdown = useMemo(() => annotationToMarkdown(annotations), [annotations]);
    const renderedSourceMarkdown = useMemo(() => normalizeMarkdownMathForDisplay(sourceMarkdown), [sourceMarkdown]);
    const renderedTargetMarkdown = useMemo(() => normalizeMarkdownMathForDisplay(targetMarkdown), [targetMarkdown]);
    const bilingualGridClassName = "print-bilingual grid gap-6 lg:grid-cols-2";

    if (!fileHash) {
        return <main className="min-h-screen p-10">缺少文档信息</main>;
    }

    return (
        <main className="min-h-screen bg-stone-100 text-stone-900">
            <style>{`
                @media print {
                    .print-toolbar { display: none !important; }
                    .print-bilingual { display: grid !important; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
                    body { background: white !important; }
                    main { background: white !important; }
                }

                .print-doc .markdown-body {
                    font-size: 14px;
                    line-height: 1.8;
                    color: #1f2937;
                }

                .print-doc .markdown-body h1,
                .print-doc .markdown-body h2,
                .print-doc .markdown-body h3 {
                    break-after: avoid-page;
                }
            `}</style>

            <div className="print-toolbar sticky top-0 z-20 flex items-center justify-between border-b bg-white/95 px-6 py-4 backdrop-blur">
                <div>
                    <h1 className="text-lg font-semibold">导出预览</h1>
                    <p className="text-sm text-stone-500">{printSubtitle}</p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => window.print()}
                        className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white"
                    >
                        打印或保存 PDF
                    </button>
                </div>
            </div>

            <div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
                {mode === 'bilingual' && (
                    <section className={bilingualGridClassName}>
                        <div className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                            <h2 className="mb-4 text-xl font-semibold">原文</h2>
                            <MarkdownView value={renderedSourceMarkdown || '_暂无原文内容_'} />
                        </div>
                        <div className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                            <h2 className="mb-4 text-xl font-semibold">译文</h2>
                            <MarkdownView value={renderedTargetMarkdown || '_暂无译文_'} />
                        </div>
                    </section>
                )}

                {mode === 'translation' && (
                    <section className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                        <h2 className="mb-4 text-xl font-semibold">译文</h2>
                        <MarkdownView value={renderedTargetMarkdown || '_暂无译文_'} />
                    </section>
                )}

                {mode === 'source' && (
                    <section className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                        <h2 className="mb-4 text-xl font-semibold">原文</h2>
                        <MarkdownView value={renderedSourceMarkdown || '_暂无原文内容_'} />
                    </section>
                )}

                {mode === 'bilingual-notes' && (
                    <section className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                        <h2 className="mb-4 text-xl font-semibold">译文</h2>
                        <MarkdownView value={renderedTargetMarkdown || '_暂无译文_'} />
                    </section>
                )}

                {(mode === 'notes' || mode === 'bilingual-notes') && (
                    <section className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                        <h2 className="mb-4 text-xl font-semibold">阅读笔记</h2>
                        <MarkdownView value={notesMarkdown} />
                    </section>
                )}
            </div>
        </main>
    );
}

function PrintPageFallback() {
    return (
        <main className="min-h-screen bg-stone-100 px-6 py-10 text-stone-500">
            正在加载打印预览...
        </main>
    );
}

export default function PrintPage() {
    return (
        <Suspense fallback={<PrintPageFallback />}>
            <PrintPageContent />
        </Suspense>
    );
}

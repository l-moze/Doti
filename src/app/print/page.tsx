'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { listAnnotationsForDocument, type AnnotationRecord } from '@/lib/db';
import { MarkdownView } from '@/components/markdown-view';
import { normalizeMarkdownMathForDisplay } from '@/lib/markdown-normalizer';

function annotationToMarkdown(annotations: AnnotationRecord[]): string {
    if (annotations.length === 0) return '_No annotations_';

    return annotations.map((annotation) => {
        const header = `### ${new Date(annotation.createdAt).toLocaleString()}`;
        const selected = `> ${annotation.selectedText}`;
        const note = annotation.note.trim() || '_Empty note_';
        return `${header}\n\n${selected}\n\n${note}`;
    }).join('\n\n');
}

function PrintPageContent() {
    const searchParams = useSearchParams();
    const fileHash = searchParams.get('fileHash');
    const targetLang = searchParams.get('targetLang') || 'Chinese';
    const mode = searchParams.get('mode') || 'translation';

    const [sourceMarkdown, setSourceMarkdown] = useState('');
    const [targetMarkdown, setTargetMarkdown] = useState('');
    const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);

    useEffect(() => {
        if (!fileHash) return;

        fetch(`/api/media/${fileHash}/full.md`)
            .then((res) => res.ok ? res.text() : '')
            .then(setSourceMarkdown)
            .catch(() => setSourceMarkdown(''));

        fetch(`/api/media/${fileHash}/translation-${targetLang}.md`)
            .then((res) => res.ok ? res.text() : '')
            .then(setTargetMarkdown)
            .catch(() => setTargetMarkdown(''));

        void listAnnotationsForDocument(fileHash).then(setAnnotations);
    }, [fileHash, targetLang]);

    const notesMarkdown = useMemo(() => annotationToMarkdown(annotations), [annotations]);
    const renderedSourceMarkdown = useMemo(() => normalizeMarkdownMathForDisplay(sourceMarkdown), [sourceMarkdown]);
    const renderedTargetMarkdown = useMemo(() => normalizeMarkdownMathForDisplay(targetMarkdown), [targetMarkdown]);

    if (!fileHash) {
        return <main className="min-h-screen p-10">Missing `fileHash`</main>;
    }

    return (
        <main className="min-h-screen bg-stone-100 text-stone-900">
            <style>{`
                @media print {
                    .print-toolbar { display: none !important; }
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
                    <h1 className="text-lg font-semibold">PDF Export Preview</h1>
                    <p className="text-sm text-stone-500">Mode: {mode} · Target: {targetLang}</p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => window.print()}
                        className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white"
                    >
                        Print / Save PDF
                    </button>
                </div>
            </div>

            <div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
                {(mode === 'translation' || mode === 'bilingual') && (
                    <section className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                        <h2 className="mb-4 text-xl font-semibold">Translation</h2>
                        <MarkdownView value={renderedTargetMarkdown || '_No translation available_'} />
                    </section>
                )}

                {mode === 'bilingual' && (
                    <section className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                        <h2 className="mb-4 text-xl font-semibold">Source</h2>
                        <MarkdownView value={renderedSourceMarkdown || '_No source content available_'} />
                    </section>
                )}

                {(mode === 'notes' || mode === 'bilingual-notes') && (
                    <section className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                        <h2 className="mb-4 text-xl font-semibold">Annotations</h2>
                        <MarkdownView value={notesMarkdown} />
                    </section>
                )}

                {mode === 'bilingual-notes' && (
                    <section className="rounded-2xl bg-white p-8 shadow-sm print-doc">
                        <h2 className="mb-4 text-xl font-semibold">Translation</h2>
                        <MarkdownView value={renderedTargetMarkdown || '_No translation available_'} />
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

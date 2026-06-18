'use client';

import { useEffect, useRef, useState } from 'react';
import type { DocumentSemanticProjection } from '@/lib/document-semantic';

type UseDocumentSemanticProjectionResult = {
    projection: DocumentSemanticProjection | null;
    loading: boolean;
    error: string | null;
};

export function useDocumentSemanticProjection(
    fileHash: string | null,
    sourceMarkdown: string
): UseDocumentSemanticProjectionResult {
    const [projection, setProjection] = useState<DocumentSemanticProjection | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const projectionCacheRef = useRef(new Map<string, {
        projection: DocumentSemanticProjection;
        markdownSignature: string | null;
    }>());

    useEffect(() => {
        const normalizedMarkdown = sourceMarkdown.trim();

        if (!fileHash) {
            setProjection(null);
            setLoading(false);
            setError(null);
            return;
        }

        const cachedEntry = projectionCacheRef.current.get(fileHash);
        if (cachedEntry) {
            const isStructuredProjection = cachedEntry.projection.source !== 'markdown';
            const sameMarkdown = cachedEntry.markdownSignature === normalizedMarkdown;

            if (isStructuredProjection || sameMarkdown) {
                setProjection((current) => current === cachedEntry.projection ? current : cachedEntry.projection);
                setLoading(false);
                setError(null);
                return;
            }
        }

        const controller = new AbortController();
        let cancelled = false;

        const loadProjection = async () => {
            setLoading(true);
            setError(null);

            try {
                const requestBody: {
                    fileHash: string;
                    sourceMarkdown?: string;
                } = { fileHash };

                if (normalizedMarkdown && (!cachedEntry || cachedEntry.projection.source === 'markdown')) {
                    requestBody.sourceMarkdown = normalizedMarkdown;
                }

                const response = await fetch('/api/document-semantic', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal,
                });

                if (!response.ok) {
                    throw new Error(`Projection request failed: ${response.status}`);
                }

                const nextProjection = await response.json() as DocumentSemanticProjection;
                if (cancelled) return;

                projectionCacheRef.current.set(fileHash, {
                    projection: nextProjection,
                    markdownSignature: nextProjection.source === 'markdown' ? normalizedMarkdown : null,
                });
                setProjection(nextProjection);
                setLoading(false);
            } catch (fetchError) {
                if (cancelled || controller.signal.aborted) return;
                setProjection(null);
                setLoading(false);
                setError(fetchError instanceof Error ? fetchError.message : 'Projection request failed');
            }
        };

        void loadProjection();

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [fileHash, sourceMarkdown]);

    return {
        projection,
        loading,
        error,
    };
}

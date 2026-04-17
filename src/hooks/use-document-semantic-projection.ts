'use client';

import { useEffect, useState } from 'react';
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

    useEffect(() => {
        if (!fileHash || !sourceMarkdown.trim()) {
            setProjection(null);
            setLoading(false);
            setError(null);
            return;
        }

        const controller = new AbortController();
        let cancelled = false;

        const loadProjection = async () => {
            setLoading(true);
            setError(null);

            try {
                const response = await fetch('/api/document-semantic', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        fileHash,
                        sourceMarkdown,
                    }),
                    signal: controller.signal,
                });

                if (!response.ok) {
                    throw new Error(`Projection request failed: ${response.status}`);
                }

                const nextProjection = await response.json() as DocumentSemanticProjection;
                if (cancelled) return;

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

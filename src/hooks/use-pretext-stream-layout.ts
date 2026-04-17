'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    measurePretextLayoutBatch,
    type PretextMeasureRequestItem,
    type PretextMeasureResponseItem,
    type PretextLayoutSnapshot,
} from '@/lib/pretext';
type PretextWorkerResponse = {
    type: 'measured';
    requestId: number;
    results: PretextMeasureResponseItem[];
};

type LayoutMap = Record<string, PretextLayoutSnapshot | null | undefined>;

export function usePretextStreamLayout(items: PretextMeasureRequestItem[]): LayoutMap {
    const [layoutMap, setLayoutMap] = useState<LayoutMap>({});
    const workerRef = useRef<Worker | null>(null);
    const requestIdRef = useRef(0);
    const supportsWorkerRef = useRef(true);

    const normalizedItems = useMemo(
        () => items.filter((item) => item.text.trim().length > 0 && item.maxWidth > 0),
        [items]
    );

    useEffect(() => {
        if (typeof window === 'undefined') return;

        try {
            const worker = new Worker(new URL('../workers/pretext-layout.worker.ts', import.meta.url), { type: 'module' });
            workerRef.current = worker;

            const handleMessage = (event: MessageEvent<PretextWorkerResponse>) => {
                const message = event.data;
                if (message.type !== 'measured' || message.requestId !== requestIdRef.current) {
                    return;
                }

                setLayoutMap((current) => {
                    const next = { ...current };
                    for (const result of message.results) {
                        next[result.id] = result.snapshot;
                    }
                    return next;
                });
            };

            worker.addEventListener('message', handleMessage);

            return () => {
                worker.removeEventListener('message', handleMessage);
                worker.terminate();
                workerRef.current = null;
            };
        } catch {
            supportsWorkerRef.current = false;
            return;
        }
    }, []);

    useEffect(() => {
        if (normalizedItems.length === 0) return;

        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;

        const timer = window.setTimeout(() => {
            if (supportsWorkerRef.current && workerRef.current) {
                workerRef.current.postMessage({
                    type: 'measure',
                    requestId,
                    items: normalizedItems,
                });
                return;
            }

            const results = measurePretextLayoutBatch(normalizedItems);
            setLayoutMap((current) => {
                const next = { ...current };
                for (const result of results) {
                    next[result.id] = result.snapshot;
                }
                return next;
            });
        }, 24);

        return () => window.clearTimeout(timer);
    }, [normalizedItems]);

    return layoutMap;
}

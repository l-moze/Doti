/// <reference lib="webworker" />

import {
    clearPretextStatsCache,
    measurePretextLayoutBatch,
    type PretextMeasureRequestItem,
    type PretextMeasureResponseItem,
} from '@/lib/pretext';

type PretextWorkerMeasureMessage = {
    type: 'measure';
    requestId: number;
    items: PretextMeasureRequestItem[];
};

type PretextWorkerClearMessage = {
    type: 'clear-cache';
};

type PretextWorkerRequest = PretextWorkerMeasureMessage | PretextWorkerClearMessage;

type PretextWorkerResponse = {
    type: 'measured';
    requestId: number;
    results: PretextMeasureResponseItem[];
};

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<PretextWorkerRequest>) => {
    const message = event.data;

    if (message.type === 'clear-cache') {
        clearPretextStatsCache();
        return;
    }

    const results = measurePretextLayoutBatch(message.items);
    const response: PretextWorkerResponse = {
        type: 'measured',
        requestId: message.requestId,
        results,
    };

    workerScope.postMessage(response);
};

export {};

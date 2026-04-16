'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegistration() {
    useEffect(() => {
        if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
            return;
        }

        void navigator.serviceWorker.register('/sw.js').catch((error) => {
            console.error('[ServiceWorker] Registration failed:', error);
        });
    }, []);

    return null;
}

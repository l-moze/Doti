'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import {
    STREAM_DRAFT_FONT,
    STREAM_DRAFT_LINE_HEIGHT,
    type DocumentLayoutProfile,
} from '@/lib/streaming-draft';

type LayoutProfileState = {
    outerWidth: number;
    contentWidth: number;
    contentPaddingX: number;
    fontReady: boolean;
};

function measureViewportBox(element: HTMLElement): Pick<LayoutProfileState, 'outerWidth' | 'contentWidth' | 'contentPaddingX'> {
    const computed = window.getComputedStyle(element);
    const paddingLeft = Number.parseFloat(computed.paddingLeft || '0') || 0;
    const paddingRight = Number.parseFloat(computed.paddingRight || '0') || 0;
    const outerWidth = element.clientWidth;
    const contentPaddingX = paddingLeft + paddingRight;
    const contentWidth = Math.max(0, outerWidth - contentPaddingX);

    return {
        outerWidth,
        contentWidth,
        contentPaddingX,
    };
}

export function useDocumentLayoutProfile(
    viewportRef: RefObject<HTMLElement | null>
): DocumentLayoutProfile {
    const [layoutState, setLayoutState] = useState<LayoutProfileState>(() => ({
        outerWidth: 0,
        contentWidth: 0,
        contentPaddingX: 0,
        fontReady: typeof document === 'undefined' || !('fonts' in document),
    }));

    useEffect(() => {
        const element = viewportRef.current;
        if (!element || typeof window === 'undefined') return;

        const updateMeasurements = () => {
            const nextBox = measureViewportBox(element);
            setLayoutState((current) => {
                if (
                    current.outerWidth === nextBox.outerWidth &&
                    current.contentWidth === nextBox.contentWidth &&
                    current.contentPaddingX === nextBox.contentPaddingX
                ) {
                    return current;
                }

                return {
                    ...current,
                    ...nextBox,
                };
            });
        };

        const observer = new ResizeObserver(() => {
            updateMeasurements();
        });

        updateMeasurements();
        observer.observe(element);

        const frame = window.requestAnimationFrame(updateMeasurements);

        return () => {
            window.cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [viewportRef]);

    useEffect(() => {
        if (typeof document === 'undefined' || !('fonts' in document)) {
            return;
        }

        let cancelled = false;

        const markFontsReady = async () => {
            try {
                await document.fonts.ready;
                if ('load' in document.fonts) {
                    await Promise.all([
                        document.fonts.load(STREAM_DRAFT_FONT, 'The quick brown fox 123'),
                        document.fonts.load(STREAM_DRAFT_FONT, '多语言排版 Latex 公式'),
                    ]);
                }
            } catch {
                // Fall back to browser layout if font loading probes fail.
            }

            if (cancelled) return;
            setLayoutState((current) => current.fontReady ? current : { ...current, fontReady: true });
        };

        void markFontsReady();

        return () => {
            cancelled = true;
        };
    }, []);

    return useMemo(() => {
        const debug =
            typeof window !== 'undefined' &&
            new URLSearchParams(window.location.search).get('debugPretext') === '1';

        return {
            outerWidth: layoutState.outerWidth,
            contentWidth: layoutState.contentWidth,
            contentPaddingX: layoutState.contentPaddingX,
            draftFont: STREAM_DRAFT_FONT,
            draftLineHeight: STREAM_DRAFT_LINE_HEIGHT,
            fontReady: layoutState.fontReady,
            profileVersion: Number(
                `${layoutState.fontReady ? 1 : 0}${Math.round(layoutState.contentWidth)}`
            ),
            debug,
        } satisfies DocumentLayoutProfile;
    }, [layoutState]);
}

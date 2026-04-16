'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ModalShellProps {
    open: boolean;
    title: string;
    description?: string;
    widthClassName?: string;
    children: ReactNode;
    onClose: () => void;
}

export function ModalShell({
    open,
    title,
    description,
    widthClassName,
    children,
    onClose,
}: ModalShellProps) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm">
            <div
                className="absolute inset-0"
                aria-hidden="true"
                onClick={onClose}
            />
            <section
                className={cn(
                    'relative z-10 max-h-[85vh] w-full overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl',
                    widthClassName ?? 'max-w-4xl'
                )}
            >
                <header className="flex items-start justify-between border-b border-slate-200 bg-slate-50/90 px-6 py-5">
                    <div className="space-y-1 pr-4">
                        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
                        {description && (
                            <p className="text-sm text-slate-500">{description}</p>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-slate-300 hover:bg-white hover:text-slate-900"
                        aria-label="Close"
                    >
                        <X size={16} />
                    </button>
                </header>
                <div className="max-h-[calc(85vh-88px)] overflow-auto">{children}</div>
            </section>
        </div>
    );
}

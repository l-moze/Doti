'use client';

import React, { type ReactNode } from 'react';

interface AppErrorBoundaryProps {
    title: string;
    description?: string;
    children: ReactNode;
}

interface AppErrorBoundaryState {
    hasError: boolean;
}

export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = {
        hasError: false,
    };

    static getDerivedStateFromError(): AppErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: Error) {
        console.error(`[${this.props.title}]`, error);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="flex h-full min-h-[240px] flex-col items-center justify-center rounded-2xl border border-red-200 bg-red-50 px-6 text-center">
                    <p className="text-base font-semibold text-red-700">{this.props.title}</p>
                    <p className="mt-2 max-w-md text-sm text-red-600">
                        {this.props.description || '面板发生错误，请刷新页面后重试。'}
                    </p>
                </div>
            );
        }

        return this.props.children;
    }
}

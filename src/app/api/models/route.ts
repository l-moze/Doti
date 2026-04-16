/**
 * Models API - 动态获取各提供商的可用模型列表
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { PROVIDERS, DEFAULT_MODELS } from '@/lib/llm/providers';

const modelCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function sortModels(list: string[]): string[] {
    return [...list].sort((a, b) => modelCollator.compare(a, b));
}

function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

export async function GET() {
    const models: Record<string, string[]> = {};
    const errors: Record<string, string> = {};

    for (const [id, provider] of Object.entries(PROVIDERS)) {
        try {
            if (id === 'gemini') {
                // Gemini: 使用预定义模型列表（动态获取需要复杂的 API 调用）
                const apiKey = process.env.GEMINI_API_KEY;
                if (apiKey) {
                    // 预定义的 Gemini 模型列表
                    models[id] = sortModels([
                        'gemini-2.5-flash',
                        'gemini-2.5-pro',
                        'gemini-2.0-flash',
                        'gemini-1.5-flash',
                        'gemini-1.5-pro',
                    ]);
                } else {
                    models[id] = [DEFAULT_MODELS[id]];
                    errors[id] = 'Missing GEMINI_API_KEY';
                }
            } else if (provider.isAnthropic) {
                const apiKey = process.env[provider.envKey];
                if (!apiKey) {
                    models[id] = [DEFAULT_MODELS[id]];
                    errors[id] = `Missing ${provider.envKey}`;
                } else {
                    try {
                        const anthropic = new Anthropic({
                            apiKey,
                            baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
                        });
                        const modelIds: string[] = [];
                        for await (const m of anthropic.models.list()) {
                            modelIds.push(m.id);
                        }
                        const defaultModel = DEFAULT_MODELS[id];
                        models[id] = modelIds.length > 0
                            ? sortModels(Array.from(new Set([...modelIds, defaultModel])))
                            : [defaultModel];
                    } catch (fetchError: unknown) {
                        models[id] = [DEFAULT_MODELS[id]];
                        errors[id] = getErrorMessage(fetchError, 'Anthropic models list failed');
                    }
                }
            } else if (provider.isOpenAICompat) {
                // OpenAI 兼容端点
                const apiKey = id === 'ollama' ? 'ollama' : process.env[provider.envKey];
                const baseUrl = id === 'ollama'
                    ? (process.env.OLLAMA_BASE_URL || provider.baseUrl)
                    : provider.baseUrl;

                if (apiKey || id === 'ollama') {
                    try {
                        const res = await fetch(`${baseUrl}/models`, {
                            headers: apiKey && id !== 'ollama'
                                ? { 'Authorization': `Bearer ${apiKey}` }
                                : {},
                            // 设置超时
                            signal: AbortSignal.timeout(5000),
                        });

                        if (res.ok) {
                            const data = await res.json();
                            const modelList = data.data?.map((m: { id: string }) => m.id) || [];
                            // 合并远程列表和默认模型，确保默认模型总是存在
                            const defaultModel = DEFAULT_MODELS[id];
                            const mergedList = sortModels(Array.from(new Set([...modelList, defaultModel])));
                            models[id] = mergedList.length > 0 ? mergedList : [defaultModel];
                        } else {
                            models[id] = [DEFAULT_MODELS[id]];
                            errors[id] = `API returned ${res.status}`;
                        }
                    } catch (fetchError: unknown) {
                        models[id] = [DEFAULT_MODELS[id]];
                        errors[id] = fetchError instanceof Error && fetchError.name === 'TimeoutError'
                            ? 'Connection timeout'
                            : getErrorMessage(fetchError, 'Fetch failed');
                    }
                } else {
                    models[id] = [DEFAULT_MODELS[id]];
                    errors[id] = `Missing ${provider.envKey}`;
                }
            }
        } catch (error: unknown) {
            console.error(`[Models API] Failed to fetch models for ${id}:`, error);
            models[id] = [DEFAULT_MODELS[id]];
            errors[id] = getErrorMessage(error, 'Unknown error');
        }
    }

    return NextResponse.json({
        providers: PROVIDERS,
        models,
        defaults: DEFAULT_MODELS,
        errors: Object.keys(errors).length > 0 ? errors : undefined,
    });
}

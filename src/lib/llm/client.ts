/**
 * Unified LLM Client Factory
 * 使用 openai SDK 作为统一客户端，通过 baseURL 配置兼容多个提供商
 * Anthropic 使用官方 @anthropic-ai/sdk（Messages 流式）
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { PROVIDERS } from './providers';

export interface RuntimeProviderProfile {
    id?: string;
    name?: string;
    providerType: 'openai-compatible' | 'deeplx';
    baseUrl: string;
    apiKey?: string;
    model?: string;
    sourceLang?: string;
    glossaryId?: string;
}

export interface LLMClient {
    generateStream(prompt: string): AsyncGenerator<string, void, unknown>;
}

function getErrorStatus(error: unknown): number | undefined {
    if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = (error as { status?: unknown }).status;
        return typeof status === 'number' ? status : undefined;
    }
    return undefined;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : '';
}

function isStreamingUnsupportedError(error: unknown): boolean {
    const status = getErrorStatus(error);
    const message = getErrorMessage(error).toLowerCase();

    if (status && ![400, 404, 405, 422, 501].includes(status)) {
        return false;
    }

    return (
        message.includes('stream') &&
        (
            message.includes('unsupported') ||
            message.includes('not support') ||
            message.includes('not supported') ||
            message.includes('invalid') ||
            message.includes('disabled')
        )
    );
}

function extractOpenAIMessageText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && 'type' in part && 'text' in part) {
                    const typedPart = part as { type?: unknown; text?: unknown };
                    if (typedPart.type === 'text' && typeof typedPart.text === 'string') {
                        return typedPart.text;
                    }
                }
                return '';
            })
            .join('');
    }

    return '';
}

/**
 * 创建 LLM 客户端
 * @param providerId 提供商 ID (gemini, deepseek, glm, ollama, openai)
 * @param model 模型名称
 * @returns LLMClient 实例
 */
export function createLLMClient(providerId: string, model: string, runtimeProfile?: RuntimeProviderProfile): LLMClient {
    if (runtimeProfile?.providerType === 'deeplx') {
        throw new Error('DeepLX profile cannot be used as a chat model');
    }

    if (runtimeProfile?.providerType === 'openai-compatible') {
        const client = new OpenAI({
            apiKey: runtimeProfile.apiKey || 'placeholder',
            baseURL: runtimeProfile.baseUrl,
        });

        return {
            async *generateStream(prompt: string): AsyncGenerator<string, void, unknown> {
                try {
                    const stream = await client.chat.completions.create({
                        model: runtimeProfile.model || model,
                        messages: [{ role: 'user', content: prompt }],
                        stream: true,
                    });

                    for await (const chunk of stream) {
                        const content = chunk.choices[0]?.delta?.content;
                        if (content) yield content;
                    }
                } catch (error: unknown) {
                    if (!isStreamingUnsupportedError(error)) {
                        throw error;
                    }

                    const completion = await client.chat.completions.create({
                        model: runtimeProfile.model || model,
                        messages: [{ role: 'user', content: prompt }],
                        stream: false,
                    });
                    const content = extractOpenAIMessageText(completion.choices[0]?.message?.content);
                    if (content) {
                        yield content;
                    }
                }
            }
        };
    }

    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    if (provider.isAnthropic) {
        const apiKey = process.env[provider.envKey];
        if (!apiKey) throw new Error(`Missing ${provider.envKey}`);

        const anthropic = new Anthropic({
            apiKey,
            baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
        });

        const maxOutputTokens = Math.min(
            200000,
            Math.max(1, parseInt(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS || '8192', 10) || 8192)
        );

        return {
            async *generateStream(prompt: string): AsyncGenerator<string, void, unknown> {
                let retries = 0;
                const maxRetries = 5;

                while (true) {
                    try {
                        const stream = anthropic.messages.stream({
                            model,
                            max_tokens: maxOutputTokens,
                            messages: [{ role: 'user', content: prompt }],
                        });

                        for await (const event of stream) {
                            if (event.type === 'content_block_delta') {
                                const d = event.delta;
                                if (d.type === 'text_delta' && d.text) {
                                    yield d.text;
                                }
                            }
                        }
                        return;
                    } catch (error: unknown) {
                        const status = getErrorStatus(error);
                        const message = getErrorMessage(error);
                        const isRateLimit = status === 429;
                        const isOverloaded = status === 529 || status === 503;
                        const isNetworkError = message.includes('fetch failed');

                        if (isRateLimit) {
                            throw new Error('API 配额已用完。请稍后再试。');
                        }

                        if ((isNetworkError || isOverloaded) && retries < maxRetries) {
                            retries++;
                            const delay = Math.min(2 * Math.pow(2, retries), 15);
                            console.log(`[Anthropic] ${isOverloaded ? 'overloaded' : 'Network'} error. Retry ${retries}/${maxRetries} in ${delay}s`);
                            await new Promise(r => setTimeout(r, delay * 1000));
                            continue;
                        }

                        throw error;
                    }
                }
            },
        };
    }

    if (provider.isOpenAICompat) {
        // 使用 openai SDK (兼容 DeepSeek, GLM, Ollama, OpenAI)
        const apiKey = providerId === 'ollama'
            ? 'ollama'  // Ollama 不需要真实 Key
            : process.env[provider.envKey];

        if (!apiKey && providerId !== 'ollama') {
            throw new Error(`Missing API key: ${provider.envKey}`);
        }

        const baseURL = providerId === 'ollama'
            ? (process.env.OLLAMA_BASE_URL || provider.baseUrl)
            : provider.baseUrl;

        const client = new OpenAI({ apiKey: apiKey || 'placeholder', baseURL });

        return {
            async *generateStream(prompt: string): AsyncGenerator<string, void, unknown> {
                let retries = 0;
                const maxRetries = 5;

                while (true) {
                    try {
                        const stream = await client.chat.completions.create({
                            model,
                            messages: [{ role: 'user', content: prompt }],
                            stream: true,
                        });

                        for await (const chunk of stream) {
                            const content = chunk.choices[0]?.delta?.content;
                            if (content) yield content;
                        }
                        return;
                    } catch (error: unknown) {
                        if (isStreamingUnsupportedError(error)) {
                            const completion = await client.chat.completions.create({
                                model,
                                messages: [{ role: 'user', content: prompt }],
                                stream: false,
                            });
                            const content = extractOpenAIMessageText(completion.choices[0]?.message?.content);
                            if (content) {
                                yield content;
                            }
                            return;
                        }

                        const status = getErrorStatus(error);
                        const message = getErrorMessage(error);
                        const isRateLimit = status === 429;
                        const isOverloaded = status === 503;
                        const isNetworkError = message.includes('fetch failed');

                        if (isRateLimit) {
                            throw new Error('API 配额已用完。请稍后再试。');
                        }

                        if ((isNetworkError || isOverloaded) && retries < maxRetries) {
                            retries++;
                            const delay = Math.min(2 * Math.pow(2, retries), 15);
                            console.log(`[LLM] ${isOverloaded ? '503' : 'Network'} error. Retry ${retries}/${maxRetries} in ${delay}s`);
                            await new Promise(r => setTimeout(r, delay * 1000));
                            continue;
                        }

                        throw error;
                    }
                }
            }
        };
    } else {
        // Google Gemini（@google/genai）
        const apiKey = process.env[provider.envKey];
        if (!apiKey) throw new Error(`Missing ${provider.envKey}`);

        const ai = new GoogleGenAI({ apiKey });

        return {
            async *generateStream(prompt: string): AsyncGenerator<string, void, unknown> {
                let retries = 0;
                const maxRetries = 5;

                while (true) {
                    try {
                        const response = await ai.models.generateContentStream({
                            model,
                            contents: prompt,
                        });

                        for await (const chunk of response) {
                            if (chunk.text) yield chunk.text;
                        }
                        return;
                    } catch (error: unknown) {
                        const status = getErrorStatus(error);
                        const message = getErrorMessage(error);
                        const isRateLimit = status === 429 || message.includes('Quota exceeded');
                        const isOverloaded = status === 503 || message.includes('overloaded');
                        const isNetworkError = message.includes('fetch failed');

                        if (isRateLimit) {
                            throw new Error('API 配额已用完。请稍后再试。');
                        }

                        if ((isNetworkError || isOverloaded) && retries < maxRetries) {
                            retries++;
                            const delay = Math.min(2 * Math.pow(2, retries), 15);
                            console.log(`[Gemini] ${isOverloaded ? '503' : 'Network'} error. Retry ${retries}/${maxRetries} in ${delay}s`);
                            await new Promise(r => setTimeout(r, delay * 1000));
                            continue;
                        }

                        throw error;
                    }
                }
            }
        };
    }
}

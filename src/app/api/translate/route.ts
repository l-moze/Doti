import { NextRequest, NextResponse } from "next/server";
import { Chunker } from "@/lib/agent/think/chunker";
import { refineModule } from "@/lib/agent/memory/refine";
import { ActModule } from "@/lib/agent/act/translate";
import { ProgressTracker, type TranslationProgress } from "@/lib/progress-tracker";
import type { Term } from "@/lib/agent/memory/terminology-store";
import type { Chunk } from "@/lib/agent/think/chunker";
import { DeepLXClient } from "@/lib/deeplx-client";
import type { RuntimeProviderProfile } from "@/lib/llm/client";
import type { TranslationChunkPlan, TranslationMarkdownBlock } from "@/lib/translation-runtime";
import crypto from "node:crypto";

type ChunkExecutionResult = {
    index: number;
    chunkId: string;
    title: string;
    content: string;
    state: "completed" | "cached";
};

// SSE Event Helper
function sseEvent(type: string, data: object | string): string {
    const payload = typeof data === 'string' ? { message: data } : data;
    return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Translation failed";
}

function clampTranslationConcurrency(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.min(4, Math.floor(value)));
}

function resolveTranslationConcurrency(requested?: number): number {
    const envValue = Number.parseInt(process.env.TRANSLATION_CONCURRENCY || "2", 10);
    const baseValue = Number.isFinite(requested) && requested ? requested : envValue;
    return clampTranslationConcurrency(baseValue);
}

function supportsIncrementalStreaming(runtimeProfile?: RuntimeProviderProfile): boolean {
    if (!runtimeProfile) {
        return true;
    }

    return runtimeProfile.providerType !== 'deeplx';
}

function serializeChunkPlan(chunks: Chunk[]): TranslationChunkPlan[] {
    const seenIds = new Map<string, number>();

    return chunks.map((chunk, index) => {
        const occurrence = seenIds.get(chunk.id) ?? 0;
        seenIds.set(chunk.id, occurrence + 1);

        return {
            id: occurrence === 0 ? chunk.id : `${chunk.id}-${occurrence}`,
            index,
            title: chunk.metadata.title,
            kind: chunk.type === 'references' ? 'references' : 'text',
        };
    });
}

function rebuildCompletedBlocks(
    plan: TranslationChunkPlan[],
    progress: TranslationProgress,
    partialContent: string
): TranslationMarkdownBlock[] {
    const completedChunks = progress.chunks
        .filter((chunk) => chunk.completed)
        .sort((a, b) => a.index - b.index);

    const blocks: TranslationMarkdownBlock[] = [];
    let cursor = 0;

    for (const chunkProgress of completedChunks) {
        const planItem = plan[chunkProgress.index];
        if (!planItem) continue;

        if (cursor > 0 && partialContent.slice(cursor, cursor + 2) === '\n\n') {
            cursor += 2;
        }

        const text = partialContent.slice(cursor, cursor + chunkProgress.length);
        cursor += chunkProgress.length;

        blocks.push({
            ...planItem,
            text,
            state: 'completed',
        });
    }

    return blocks;
}

async function translateChunkToCompletion(input: {
    chunk: Chunk;
    index: number;
    title: string;
    chunkId: string;
    previousTranslation: string;
    targetLang: string;
    actModule?: ActModule;
    runtimeProfile?: RuntimeProviderProfile;
    extraTerms: Term[];
}): Promise<ChunkExecutionResult> {
    const refinedContext = await refineModule.process(
        input.chunk,
        input.previousTranslation,
        input.extraTerms
    );

    if (refinedContext.isReference) {
        return {
            index: input.index,
            chunkId: input.chunkId,
            title: input.title,
            content: input.chunk.content,
            state: "completed",
        };
    }

    const content = input.runtimeProfile?.providerType === 'deeplx'
        ? await new DeepLXClient(input.runtimeProfile).translate(refinedContext.sourceText, input.targetLang)
        : await input.actModule!.translate(refinedContext, input.targetLang);
    return {
        index: input.index,
        chunkId: input.chunkId,
        title: input.title,
        content,
        state: "completed",
    };
}

function buildConcurrentBatches(startIndex: number, totalChunks: number, concurrency: number): number[][] {
    const batches: number[][] = [];

    for (let index = startIndex; index < totalChunks; index += concurrency) {
        batches.push(
            Array.from(
                { length: Math.min(concurrency, totalChunks - index) },
                (_, offset) => index + offset
            )
        );
    }

    return batches;
}

// Create a ReadableStream from the Agent's async generator
async function* agentTranslateGenerator(
    sourceMarkdown: string,
    targetLang: string,
    providerId: string,
    model: string,
    fileHash?: string,
    resume: boolean = false,
    forceFresh: boolean = false,
    extraTerms: Term[] = [],
    requestedConcurrency?: number,
    runtimeProfile?: RuntimeProviderProfile
) {
    const chunker = new Chunker();
    const actModule = runtimeProfile?.providerType === 'deeplx'
        ? undefined
        : new ActModule(providerId, model, runtimeProfile);
    const runId = crypto.randomUUID();
    const prefersIncrementalStreaming = supportsIncrementalStreaming(runtimeProfile);
    const requestedResolvedConcurrency = resolveTranslationConcurrency(requestedConcurrency);
    const translationConcurrency = prefersIncrementalStreaming
        ? 1
        : requestedResolvedConcurrency;

    // If no fileHash, cannot use caching
    if (!fileHash) {
        console.log('[Translation] No fileHash provided, cannot use cache');
        yield* translateWithoutCache(
            sourceMarkdown,
            targetLang,
            runId,
            chunker,
            actModule,
            extraTerms,
            translationConcurrency,
            runtimeProfile
        );
        return;
    }

    if (prefersIncrementalStreaming && requestedResolvedConcurrency > 1) {
        console.log(
            `[Translation] ${providerId}/${model} supports incremental streaming, forcing sequential delivery instead of concurrency=${requestedResolvedConcurrency}`
        );
    }

    const tracker = new ProgressTracker(fileHash, targetLang);

    if (forceFresh) {
        console.log('[Translation] Force fresh translation requested, clearing existing cache');
        tracker.reset();
    }

    // Check full cache first
    if (tracker.hasFullCache()) {
        console.log(`[Cache] Found complete translation`);
        yield sseEvent('status', { message: 'Loading from Cache...' });

        const cachedContent = tracker.readFullCache();
        yield sseEvent('run_started', {
            runId,
            source: 'cache',
            totalChunks: 1,
            concurrency: 1,
            chunks: [{
                id: 'cached-translation',
                index: 0,
                title: 'Cached Translation',
                kind: 'text',
            }],
        });
        yield sseEvent('chunk_started', {
            runId,
            chunkId: 'cached-translation',
            index: 0,
            title: 'Cached Translation',
        });
        yield sseEvent('progress', { percentage: 100 });
        yield sseEvent('chunk', { chunkId: 'cached-translation', text: cachedContent || '' });
        yield sseEvent('chunk_completed', { runId, chunkId: 'cached-translation', index: 0, state: 'cached' });
        yield sseEvent('done', { message: 'Loaded from cache.' });
        return;
    }

    // Step 1: Chunk the document
    yield sseEvent('status', { message: 'Chunking document...' });
    const chunks = chunker.split(sourceMarkdown);
    const totalChunks = chunks.length;
    const chunkPlan = serializeChunkPlan(chunks);

    yield sseEvent('run_started', {
        runId,
        source: resume ? 'resume' : 'fresh',
        totalChunks,
        concurrency: translationConcurrency,
        chunks: chunkPlan,
    });

    let startIndex = 0;
    let previousTranslation = "";

    // Check for partial cache if resume is requested
    if (resume && tracker.hasPartialCache()) {
        if (tracker.validatePartialCache(sourceMarkdown)) {
            const progress = tracker.readProgress();
            if (progress) {
                startIndex = progress.completedChunks;
                console.log(`[Resume] Continuing from chunk ${startIndex}/${totalChunks}`);

                // Load partial cache and send to client
                const partialContent = tracker.readPartialCache();
                if (partialContent) {
                    const hydratedBlocks = rebuildCompletedBlocks(chunkPlan, progress, partialContent);
                    yield sseEvent('status', { message: `Resuming from chunk ${startIndex}...` });
                    yield sseEvent('hydrate_blocks', { runId, blocks: hydratedBlocks });

                    // Get last chunk's translation for context
                    if (startIndex > 0) {
                        previousTranslation = hydratedBlocks.at(-1)?.text || '';
                    }
                }
            }
        } else {
            console.log('[Resume] Partial cache invalid, starting fresh');
            tracker.cleanup();
        }
    }

    // Initialize progress tracking if starting fresh
    if (startIndex === 0) {
        tracker.initProgress(totalChunks, sourceMarkdown);
        yield sseEvent('progress', { percentage: 0 });
    } else {
        const percentage = Math.floor((startIndex / totalChunks) * 100);
        yield sseEvent('progress', { percentage });
    }

    if (translationConcurrency > 1) {
        const batches = buildConcurrentBatches(startIndex, totalChunks, translationConcurrency);
        let previousTranslationForBatch = previousTranslation;
        let nextPersistIndex = startIndex;

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
            const currentBatch = batches[batchIndex];
            yield sseEvent('status', {
                message: `Parallel batch ${batchIndex + 1}/${batches.length} · ${currentBatch.length} agents`,
            });

            const batchPromises = currentBatch.map((chunkIndex) => {
                const chunk = chunks[chunkIndex];
                const planItem = chunkPlan[chunkIndex];
                const title = chunk.metadata.title || `chunk ${chunkIndex + 1}`;

                return translateChunkToCompletion({
                    chunk,
                    index: chunkIndex,
                    title,
                    chunkId: planItem?.id || chunk.id,
                    previousTranslation: previousTranslationForBatch,
                    targetLang,
                    actModule,
                    runtimeProfile,
                    extraTerms,
                });
            });

            for (const chunkIndex of currentBatch) {
                const chunk = chunks[chunkIndex];
                const planItem = chunkPlan[chunkIndex];
                yield sseEvent('chunk_started', {
                    runId,
                    chunkId: planItem?.id || chunk.id,
                    index: chunkIndex,
                    title: chunk.metadata.title || `chunk ${chunkIndex + 1}`,
                });
            }

            const batchResults = await Promise.all(batchPromises);
            batchResults.sort((a, b) => a.index - b.index);

            for (const result of batchResults) {
                yield sseEvent('chunk', { chunkId: result.chunkId, text: result.content });

                if (result.index === nextPersistIndex) {
                    tracker.appendChunk(result.index, result.content, nextPersistIndex === 0);
                    nextPersistIndex += 1;
                }

                yield sseEvent('chunk_completed', {
                    runId,
                    chunkId: result.chunkId,
                    index: result.index,
                    state: result.state,
                });

                const percentage = Math.floor(((result.index + 1) / totalChunks) * 100);
                yield sseEvent('progress', { percentage });
            }

            previousTranslationForBatch = batchResults.at(-1)?.content || previousTranslationForBatch;
        }

        tracker.finalize();
        yield sseEvent('done', { message: 'Translation complete.' });
        return;
    }

    // Translation loop
    for (let i = startIndex; i < totalChunks; i++) {
        const chunk = chunks[i];
        const currentChunkIndex = i + 1;
        const planItem = chunkPlan[i];

        yield sseEvent('chunk_started', {
            runId,
            chunkId: planItem?.id || chunk.id,
            index: i,
            title: chunk.metadata.title || `chunk ${currentChunkIndex}`,
        });

        // Step 2: Refine Context
        yield sseEvent('status', { message: `Refining: ${chunk.metadata.title || 'chunk ' + currentChunkIndex}` });
        const refinedContext = await refineModule.process(chunk, previousTranslation, extraTerms);

        let chunkContent = "";

        // Step 3: Act - Translate
        if (refinedContext.isReference) {
            yield sseEvent('status', { message: 'Skipping reference section' });
            chunkContent = chunk.content;
            yield sseEvent('chunk', { chunkId: planItem?.id || chunk.id, text: chunkContent });
            previousTranslation = chunkContent;
        } else {
            yield sseEvent('status', { message: `Translating: ${chunk.metadata.title || 'chunk ' + currentChunkIndex}` });

            // Stream the translated content
            let chunkTranslation = "";

            if (runtimeProfile?.providerType === 'deeplx') {
                const translated = await new DeepLXClient(runtimeProfile).translate(refinedContext.sourceText, targetLang);
                yield sseEvent('chunk', { chunkId: planItem?.id || chunk.id, text: translated });
                chunkTranslation = translated;
            } else {
                for await (const textPart of actModule!.translateStream(refinedContext, targetLang)) {
                    yield sseEvent('chunk', { chunkId: planItem?.id || chunk.id, text: textPart });
                    chunkTranslation += textPart;
                }
            }

            chunkContent = chunkTranslation;
            previousTranslation = chunkTranslation;
        }

        // Save chunk immediately to partial cache
        tracker.appendChunk(i, chunkContent, i === 0);
        yield sseEvent('chunk_completed', {
            runId,
            chunkId: planItem?.id || chunk.id,
            index: i,
            state: 'completed',
        });

        const percentage = Math.floor((currentChunkIndex / totalChunks) * 100);
        yield sseEvent('progress', { percentage });
    }

    // Finalize: convert partial cache to final cache
    tracker.finalize();

    yield sseEvent('done', { message: 'Translation complete.' });
}

// Fallback for non-cached translation
async function* translateWithoutCache(
    sourceMarkdown: string,
    targetLang: string,
    runId: string,
    chunker: Chunker,
    actModule: ActModule | undefined,
    extraTerms: Term[] = [],
    translationConcurrency: number = 1,
    runtimeProfile?: RuntimeProviderProfile
) {
    const chunks = chunker.split(sourceMarkdown);
    const chunkPlan = serializeChunkPlan(chunks);
    yield sseEvent('run_started', {
        runId,
        source: 'ephemeral',
        totalChunks: chunks.length,
        concurrency: translationConcurrency,
        chunks: chunkPlan,
    });
    yield sseEvent('progress', { percentage: 0 });

    let previousTranslation = "";

    if (translationConcurrency > 1) {
        const batches = buildConcurrentBatches(0, chunks.length, translationConcurrency);
        let previousTranslationForBatch = previousTranslation;

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
            const currentBatch = batches[batchIndex];
            yield sseEvent('status', {
                message: `Parallel batch ${batchIndex + 1}/${batches.length} · ${currentBatch.length} agents`,
            });

            const batchPromises = currentBatch.map((chunkIndex) => {
                const chunk = chunks[chunkIndex];
                const planItem = chunkPlan[chunkIndex];
                const title = chunk.metadata.title || `chunk ${chunkIndex + 1}`;

                return translateChunkToCompletion({
                    chunk,
                    index: chunkIndex,
                    title,
                    chunkId: planItem?.id || chunk.id,
                    previousTranslation: previousTranslationForBatch,
                    targetLang,
                    actModule,
                    runtimeProfile,
                    extraTerms,
                });
            });

            for (const chunkIndex of currentBatch) {
                const chunk = chunks[chunkIndex];
                const planItem = chunkPlan[chunkIndex];
                yield sseEvent('chunk_started', {
                    runId,
                    chunkId: planItem?.id || chunk.id,
                    index: chunkIndex,
                    title: chunk.metadata.title || `chunk ${chunkIndex + 1}`,
                });
            }

            const batchResults = await Promise.all(batchPromises);
            batchResults.sort((a, b) => a.index - b.index);

            for (const result of batchResults) {
                yield sseEvent('chunk', { chunkId: result.chunkId, text: result.content });
                yield sseEvent('chunk_completed', {
                    runId,
                    chunkId: result.chunkId,
                    index: result.index,
                    state: result.state,
                });

                const percentage = Math.floor(((result.index + 1) / chunks.length) * 100);
                yield sseEvent('progress', { percentage });
            }

            previousTranslationForBatch = batchResults.at(-1)?.content || previousTranslationForBatch;
        }

        yield sseEvent('done', { message: 'Translation complete.' });
        return;
    }

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const currentChunkIndex = i + 1;
        const planItem = chunkPlan[i];

        yield sseEvent('chunk_started', {
            runId,
            chunkId: planItem?.id || chunk.id,
            index: i,
            title: chunk.metadata.title || `chunk ${currentChunkIndex}`,
        });

        yield sseEvent('status', { message: `Translating: ${chunk.metadata.title || 'chunk ' + currentChunkIndex}` });
        const refinedContext = await refineModule.process(chunk, previousTranslation, extraTerms);

        if (refinedContext.isReference) {
            yield sseEvent('chunk', { chunkId: planItem?.id || chunk.id, text: chunk.content });
            previousTranslation = chunk.content;
        } else {
            let chunkTranslation = "";
            if (runtimeProfile?.providerType === 'deeplx') {
                const translated = await new DeepLXClient(runtimeProfile).translate(refinedContext.sourceText, targetLang);
                yield sseEvent('chunk', { chunkId: planItem?.id || chunk.id, text: translated });
                chunkTranslation = translated;
            } else {
                for await (const textPart of actModule!.translateStream(refinedContext, targetLang)) {
                    yield sseEvent('chunk', { chunkId: planItem?.id || chunk.id, text: textPart });
                    chunkTranslation += textPart;
                }
            }
            previousTranslation = chunkTranslation;
        }

        yield sseEvent('chunk_completed', {
            runId,
            chunkId: planItem?.id || chunk.id,
            index: i,
            state: 'completed',
        });

        const percentage = Math.floor((currentChunkIndex / chunks.length) * 100);
        yield sseEvent('progress', { percentage });
    }

    yield sseEvent('done', { message: 'Translation complete.' });
}

function agentIteratorToStream(iterator: AsyncGenerator<string, void, unknown>) {
    return new ReadableStream({
        async pull(controller) {
            try {
                const { value, done } = await iterator.next();
                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(new TextEncoder().encode(value));
                }
            } catch (error) {
                controller.enqueue(new TextEncoder().encode(
                    sseEvent('error', { message: getErrorMessage(error) })
                ));
                controller.close();
            }
        },
    });
}

export async function POST(request: NextRequest) {
    try {
        const { text, targetLang, providerId, model, providerProfile, fileHash, resume, forceFresh, extraTerms, concurrency } = await request.json();

        if (!text) {
            return NextResponse.json({ error: "No text provided" }, { status: 400 });
        }

        const providerIdToUse = providerId || 'gemini';
        const modelToUse = model || 'gemini-2.5-flash';
        const shouldResume = resume === true;
        const shouldForceFresh = forceFresh === true;

        console.log(`[Agent Translation] Provider: ${providerIdToUse}, Model: ${modelToUse}, Resume: ${shouldResume}, ForceFresh: ${shouldForceFresh}`);

        const generator = agentTranslateGenerator(
            text,
            targetLang,
            providerIdToUse,
            modelToUse,
            fileHash,
            shouldResume,
            shouldForceFresh,
            Array.isArray(extraTerms) ? extraTerms : [],
            typeof concurrency === 'number' ? concurrency : undefined,
            providerProfile?.providerType ? providerProfile : undefined
        );
        const readableStream = agentIteratorToStream(generator);

        return new NextResponse(readableStream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });

    } catch (error: unknown) {
        console.error("[Agent Translation] Error:", error);
        // For SSE, we might want to send an error event instead of JSON if the stream is open
        // But at this point, the stream hasn't started, so JSON is fine.
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

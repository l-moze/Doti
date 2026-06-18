import type { RuntimeProviderProfile } from "@/lib/llm/client";
import { PROVIDERS } from "@/lib/llm/providers";

export const TRANSLATION_CACHE_KEY_SCHEMA_VERSION = "v1";
export const TRANSLATION_PROMPT_VERSION = "translation-prompt-v1";
export const TRANSLATION_CHUNKER_VERSION = "chunker-v1";
export const DEFAULT_TRANSLATE_MODE = "default";
export const DEFAULT_TRANSLATION_OUTPUT_MODE = "plain";

export interface TranslationGlossaryTermInput {
    source: string;
    target: string;
    category?: string;
}

export interface TranslationCacheKeyInput {
    fileHash: string;
    targetLang: string;
    provider: string;
    model: string;
    baseUrl?: string | null;
    glossaryTerms?: TranslationGlossaryTermInput[];
    glossaryId?: string | null;
    glossarySourceLang?: string | null;
    promptVersion?: string;
    chunkerVersion?: string;
    translateMode?: string;
    outputMode?: string;
}

export interface TranslationCacheKeyDescriptor {
    version: string;
    fileHash: string;
    targetLang: string;
    provider: string;
    model: string;
    endpointHash: string;
    glossaryHash: string;
    promptVersion: string;
    chunkerVersion: string;
    translateMode: string;
    outputMode: string;
}

export function buildTranslationCacheKey(input: TranslationCacheKeyInput): string {
    const descriptor = buildTranslationCacheDescriptor(input);
    return stableHashHex(JSON.stringify(descriptor));
}

export function buildTranslationArtifactBaseName(input: TranslationCacheKeyInput): string {
    return `translation-${sanitizeFileSegment(input.targetLang)}--${buildTranslationCacheKey(input)}`;
}

export function buildTranslationCacheDescriptor(input: TranslationCacheKeyInput): TranslationCacheKeyDescriptor {
    const endpointBase = resolveTranslationProviderBaseUrl(input.provider, input.baseUrl);
    const glossaryHash = buildGlossaryHash({
        glossaryTerms: input.glossaryTerms || [],
        glossaryId: input.glossaryId,
        glossarySourceLang: input.glossarySourceLang,
    });

    return {
        version: TRANSLATION_CACHE_KEY_SCHEMA_VERSION,
        fileHash: normalizeComparableValue(input.fileHash),
        targetLang: input.targetLang.trim(),
        provider: input.provider.trim(),
        model: input.model.trim(),
        endpointHash: stableHashHex(endpointBase || "builtin-default"),
        glossaryHash,
        promptVersion: input.promptVersion?.trim() || TRANSLATION_PROMPT_VERSION,
        chunkerVersion: input.chunkerVersion?.trim() || TRANSLATION_CHUNKER_VERSION,
        translateMode: input.translateMode?.trim() || DEFAULT_TRANSLATE_MODE,
        outputMode: input.outputMode?.trim() || DEFAULT_TRANSLATION_OUTPUT_MODE,
    };
}

export function buildTranslationCacheKeyInputFromRuntime(input: {
    fileHash: string;
    targetLang: string;
    providerId: string;
    model: string;
    providerProfile?: RuntimeProviderProfile;
    glossaryTerms?: TranslationGlossaryTermInput[];
    promptVersion?: string;
    chunkerVersion?: string;
    translateMode?: string;
    outputMode?: string;
}): TranslationCacheKeyInput {
    return {
        fileHash: input.fileHash,
        targetLang: input.targetLang,
        provider: input.providerId,
        model: input.providerProfile?.model || input.model,
        baseUrl: input.providerProfile?.baseUrl || resolveTranslationProviderBaseUrl(input.providerId),
        glossaryTerms: input.glossaryTerms || [],
        glossaryId: input.providerProfile?.glossaryId,
        glossarySourceLang: input.providerProfile?.sourceLang,
        promptVersion: input.promptVersion || TRANSLATION_PROMPT_VERSION,
        chunkerVersion: input.chunkerVersion || TRANSLATION_CHUNKER_VERSION,
        translateMode: input.translateMode || (
            input.providerProfile?.providerType === "deeplx" ? "deeplx" : DEFAULT_TRANSLATE_MODE
        ),
        outputMode: input.outputMode || DEFAULT_TRANSLATION_OUTPUT_MODE,
    };
}

export function resolveTranslationProviderBaseUrl(providerId: string, explicitBaseUrl?: string | null): string {
    const normalizedExplicit = normalizeBaseUrl(explicitBaseUrl);
    if (normalizedExplicit) {
        return normalizedExplicit;
    }

    const provider = PROVIDERS[providerId];
    if (!provider) {
        return "";
    }

    return normalizeBaseUrl(provider.baseUrl);
}

export function parseTargetLangFromTranslationArtifactName(fileName: string): string | null {
    const keyedMatch = fileName.match(/^translation-(.+?)--[a-f0-9]+(?:\.partial)?\.md$/i);
    if (keyedMatch) {
        return restoreTargetLangFromFileSegment(keyedMatch[1]);
    }

    const legacyMatch = fileName.match(/^translation-(.+?)(?:\.partial)?\.md$/i);
    if (legacyMatch) {
        return legacyMatch[1];
    }

    return null;
}

function buildGlossaryHash(input: {
    glossaryTerms: TranslationGlossaryTermInput[];
    glossaryId?: string | null;
    glossarySourceLang?: string | null;
}): string {
    const normalizedTerms = [...input.glossaryTerms]
        .map((term) => ({
            source: term.source.trim(),
            target: term.target.trim(),
            category: term.category?.trim() || "",
        }))
        .filter((term) => term.source && term.target)
        .sort((left, right) => {
            const sourceCompare = left.source.localeCompare(right.source);
            if (sourceCompare !== 0) return sourceCompare;
            const targetCompare = left.target.localeCompare(right.target);
            if (targetCompare !== 0) return targetCompare;
            return left.category.localeCompare(right.category);
        });

    const payload = JSON.stringify({
        glossaryId: input.glossaryId?.trim() || "",
        glossarySourceLang: input.glossarySourceLang?.trim().toUpperCase() || "",
        terms: normalizedTerms,
    });

    return stableHashHex(payload);
}

function stableHashHex(value: string): string {
    let hash = BigInt("0xcbf29ce484222325");
    const prime = BigInt("0x100000001b3");

    for (let index = 0; index < value.length; index += 1) {
        hash ^= BigInt(value.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * prime);
    }

    return hash.toString(16).padStart(16, "0");
}

function normalizeComparableValue(value: string): string {
    return value.trim().toLowerCase();
}

function normalizeBaseUrl(baseUrl?: string | null): string {
    return baseUrl?.trim().replace(/\/+$/, "") || "";
}

function sanitizeFileSegment(value: string): string {
    return value
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        || "unknown";
}

function restoreTargetLangFromFileSegment(value: string): string {
    return value.replace(/_/g, " ");
}

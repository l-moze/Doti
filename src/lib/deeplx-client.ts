import type { RuntimeProviderProfile } from "@/lib/llm/client";

const TARGET_LANG_MAP: Record<string, string> = {
    chinese: "ZH",
    english: "EN",
    japanese: "JA",
    korean: "KO",
    french: "FR",
    german: "DE",
    spanish: "ES",
    italian: "IT",
    portuguese: "PT",
};

type DeepLXEndpointMode = "free" | "official";

type DeepLXRequestCandidate = {
    endpoint: string;
    headers: Record<string, string>;
    mode: DeepLXEndpointMode;
};

export interface DeepLXTranslateOptions {
    sourceLang?: string;
    glossaryId?: string;
}

const DEEPLX_SPAM_REDIRECT = "https://linux.do/t/topic/111737";

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "");
}

function resolveTargetLangCode(targetLang: string): string {
    const normalized = targetLang.trim().toLowerCase();
    return TARGET_LANG_MAP[normalized] || targetLang.trim().toUpperCase();
}

function normalizeLangCode(value: string | undefined): string | undefined {
    return value?.trim().toUpperCase() || undefined;
}

function extractDeepLXTranslation(data: unknown): string | null {
    if (!data || typeof data !== "object") return null;

    const payload = data as Record<string, unknown>;
    const directText = payload.data;
    if (typeof directText === "string" && directText.trim()) return directText;

    const translation = payload.translation;
    if (typeof translation === "string" && translation.trim()) return translation;

    const translations = payload.translations;
    if (Array.isArray(translations)) {
        const firstItem = translations[0];
        if (firstItem && typeof firstItem === "object") {
            const text = (firstItem as Record<string, unknown>).text;
            if (typeof text === "string" && text.trim()) return text;
        }
    }

    return null;
}

function resolveBaseTemplate(baseUrl: string, apiKey?: string): string {
    const trimmed = baseUrl.trim();
    if (!trimmed.includes("{{apiKey}}")) {
        return trimmed;
    }

    if (!apiKey?.trim()) {
        throw new Error("DeepLX endpoint uses {{apiKey}} but API Key is empty");
    }

    return trimmed.replaceAll("{{apiKey}}", encodeURIComponent(apiKey.trim()));
}

function isOfficialTranslateEndpoint(url: URL): boolean {
    return /\/v2\/translate$/i.test(url.pathname.replace(/\/+$/, ""));
}

function hasTranslateSuffix(url: URL): boolean {
    return /\/translate$/i.test(url.pathname.replace(/\/+$/, ""));
}

function withTranslateSuffix(url: URL, mode: DeepLXEndpointMode): string {
    const next = new URL(url.toString());
    const cleanPath = next.pathname.replace(/\/+$/, "");
    const targetSuffix = mode === "official" ? "/v2/translate" : "/translate";

    if (!cleanPath.toLowerCase().endsWith(targetSuffix.toLowerCase())) {
        if (mode === "official" && /\/translate$/i.test(cleanPath)) {
            next.pathname = cleanPath.replace(/\/translate$/i, targetSuffix);
        } else if (mode === "free" && /\/v2\/translate$/i.test(cleanPath)) {
            next.pathname = cleanPath.replace(/\/v2\/translate$/i, targetSuffix);
        } else {
            next.pathname = cleanPath ? `${cleanPath}${targetSuffix}` : targetSuffix;
        }
    }

    return next.toString();
}

function pathContainsSegment(url: URL, segment: string): boolean {
    return url.pathname.split("/").filter(Boolean).includes(segment);
}

function buildApiDeepLXOrgEndpoint(baseUrl: string, apiKey: string, mode: DeepLXEndpointMode): string {
    const url = new URL(baseUrl);
    url.pathname = `/${encodeURIComponent(apiKey)}${mode === "official" ? "/v2/translate" : "/translate"}`;
    url.search = "";
    url.hash = "";
    return url.toString();
}

function buildDirectPathEndpoint(baseUrl: string, mode: DeepLXEndpointMode): string {
    return withTranslateSuffix(new URL(baseUrl), mode);
}

function withTokenQuery(endpoint: string, apiKey: string): string {
    const url = new URL(endpoint);
    url.searchParams.set("token", apiKey);
    return url.toString();
}

function determineEndpointMode(baseUrl: string, options?: DeepLXTranslateOptions): DeepLXEndpointMode {
    const url = new URL(baseUrl);
    if (isOfficialTranslateEndpoint(url)) {
        return "official";
    }

    if (options?.glossaryId) {
        return "official";
    }

    return "free";
}

export function usesDeepLXOfficialEndpoint(profile: RuntimeProviderProfile): boolean {
    try {
        return isOfficialTranslateEndpoint(new URL(profile.baseUrl));
    } catch {
        return false;
    }
}

function buildDeepLXCandidates(
    baseUrl: string,
    apiKey: string | undefined,
    options?: DeepLXTranslateOptions
): DeepLXRequestCandidate[] {
    const resolvedBaseUrl = resolveBaseTemplate(baseUrl, apiKey);
    const url = new URL(resolvedBaseUrl);
    const mode = determineEndpointMode(resolvedBaseUrl, options);
    const candidates: DeepLXRequestCandidate[] = [];
    const normalizedApiKey = apiKey?.trim();

    const pushCandidate = (endpoint: string, headers: Record<string, string>, endpointMode = mode) => {
        if (!candidates.some((candidate) => (
            candidate.endpoint === endpoint &&
            candidate.mode === endpointMode &&
            JSON.stringify(candidate.headers) === JSON.stringify(headers)
        ))) {
            candidates.push({ endpoint, headers, mode: endpointMode });
        }
    };

    if (resolvedBaseUrl !== baseUrl.trim()) {
        pushCandidate(buildDirectPathEndpoint(resolvedBaseUrl, mode), { "Content-Type": "application/json" });
        return candidates;
    }

    if (normalizedApiKey && url.hostname === "api.deeplx.org") {
        pushCandidate(buildApiDeepLXOrgEndpoint(resolvedBaseUrl, normalizedApiKey, mode), { "Content-Type": "application/json" });
    }

    if (normalizedApiKey && pathContainsSegment(url, normalizedApiKey)) {
        pushCandidate(buildDirectPathEndpoint(resolvedBaseUrl, mode), { "Content-Type": "application/json" });
    }

    if (hasTranslateSuffix(url)) {
        pushCandidate(resolvedBaseUrl, {
            "Content-Type": "application/json",
            ...(normalizedApiKey ? { Authorization: `Bearer ${normalizedApiKey}` } : {}),
        }, isOfficialTranslateEndpoint(url) ? "official" : mode);
    } else {
        const standardEndpoint = buildDirectPathEndpoint(resolvedBaseUrl, mode);
        pushCandidate(standardEndpoint, {
            "Content-Type": "application/json",
            ...(normalizedApiKey ? { Authorization: `Bearer ${normalizedApiKey}` } : {}),
        });

        if (normalizedApiKey && mode === "free") {
            pushCandidate(withTokenQuery(standardEndpoint, normalizedApiKey), { "Content-Type": "application/json" });
            pushCandidate(standardEndpoint, { "Content-Type": "application/json" });
        }
    }

    return candidates;
}

function buildRequestBody(
    text: string,
    targetLang: string,
    mode: DeepLXEndpointMode,
    options?: DeepLXTranslateOptions
): string {
    const normalizedSourceLang = normalizeLangCode(options?.sourceLang);
    const normalizedGlossaryId = options?.glossaryId?.trim() || undefined;

    if (mode === "official") {
        if (normalizedGlossaryId && !normalizedSourceLang) {
            throw new Error("DeepLX official glossary requires source_lang");
        }

        return JSON.stringify({
            text: [text],
            target_lang: resolveTargetLangCode(targetLang),
            ...(normalizedSourceLang ? { source_lang: normalizedSourceLang } : {}),
            ...(normalizedGlossaryId ? { glossary_id: normalizedGlossaryId } : {}),
        });
    }

    return JSON.stringify({
        text,
        source_lang: "AUTO",
        target_lang: resolveTargetLangCode(targetLang),
    });
}

function isKnownSpamRedirect(value: string): boolean {
    return value.trim().startsWith(DEEPLX_SPAM_REDIRECT);
}

export function supportsDeepLXOfficialGlossary(profile: RuntimeProviderProfile): boolean {
    try {
        return usesDeepLXOfficialEndpoint(profile) && Boolean(profile.glossaryId?.trim() && profile.sourceLang?.trim());
    } catch {
        return false;
    }
}

export class DeepLXClient {
    private profile: RuntimeProviderProfile;

    constructor(profile: RuntimeProviderProfile) {
        this.profile = profile;
    }

    async translate(text: string, targetLang: string, options?: DeepLXTranslateOptions): Promise<string> {
        const mergedOptions: DeepLXTranslateOptions = {
            sourceLang: options?.sourceLang ?? this.profile.sourceLang,
            glossaryId: options?.glossaryId ?? this.profile.glossaryId,
        };
        const candidates = buildDeepLXCandidates(
            normalizeBaseUrl(this.profile.baseUrl),
            this.profile.apiKey,
            mergedOptions
        );

        let lastError: Error | null = null;

        for (const candidate of candidates) {
            try {
                const requestBody = buildRequestBody(text, targetLang, candidate.mode, mergedOptions);
                const response = await fetch(candidate.endpoint, {
                    method: "POST",
                    headers: candidate.headers,
                    body: requestBody,
                });

                if (!response.ok) {
                    throw new Error(`DeepLX request failed with ${response.status}`);
                }

                const data = await response.json();
                const translated = extractDeepLXTranslation(data);

                if (!translated) {
                    throw new Error("DeepLX response did not contain translated text");
                }

                if (isKnownSpamRedirect(translated)) {
                    throw new Error("DeepLX returned the known linux.do redirect, likely due to wrong auth mode");
                }

                return translated;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }
        }

        throw lastError || new Error("DeepLX request failed");
    }
}

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

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, "");
}

type DeepLXRequestCandidate = {
    endpoint: string;
    headers: Record<string, string>;
};

const DEEPLX_SPAM_REDIRECT = "https://linux.do/t/topic/111737";

function resolveTargetLangCode(targetLang: string): string {
    const normalized = targetLang.trim().toLowerCase();
    return TARGET_LANG_MAP[normalized] || targetLang.trim().toUpperCase();
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

function hasTranslateSuffix(url: URL): boolean {
    return /\/translate$/i.test(url.pathname.replace(/\/+$/, ""));
}

function withTranslateSuffix(url: URL): string {
    const next = new URL(url.toString());
    if (!hasTranslateSuffix(next)) {
        const cleanPath = next.pathname.replace(/\/+$/, "");
        next.pathname = cleanPath ? `${cleanPath}/translate` : "/translate";
    }

    return next.toString();
}

function pathContainsSegment(url: URL, segment: string): boolean {
    return url.pathname.split("/").filter(Boolean).includes(segment);
}

function buildApiDeepLXOrgEndpoint(baseUrl: string, apiKey: string): string {
    const url = new URL(baseUrl);
    url.pathname = `/${encodeURIComponent(apiKey)}/translate`;
    url.search = "";
    url.hash = "";
    return url.toString();
}

function buildDirectPathEndpoint(baseUrl: string): string {
    return withTranslateSuffix(new URL(baseUrl));
}

function withTokenQuery(endpoint: string, apiKey: string): string {
    const url = new URL(endpoint);
    url.searchParams.set("token", apiKey);
    return url.toString();
}

function buildDeepLXCandidates(baseUrl: string, apiKey?: string): DeepLXRequestCandidate[] {
    const resolvedBaseUrl = resolveBaseTemplate(baseUrl, apiKey);
    const url = new URL(resolvedBaseUrl);
    const candidates: DeepLXRequestCandidate[] = [];
    const normalizedApiKey = apiKey?.trim();

    const pushCandidate = (endpoint: string, headers: Record<string, string>) => {
        if (!candidates.some((candidate) => candidate.endpoint === endpoint && JSON.stringify(candidate.headers) === JSON.stringify(headers))) {
            candidates.push({ endpoint, headers });
        }
    };

    if (resolvedBaseUrl !== baseUrl.trim()) {
        pushCandidate(buildDirectPathEndpoint(resolvedBaseUrl), { "Content-Type": "application/json" });
        return candidates;
    }

    if (normalizedApiKey && url.hostname === "api.deeplx.org") {
        pushCandidate(buildApiDeepLXOrgEndpoint(resolvedBaseUrl, normalizedApiKey), { "Content-Type": "application/json" });
    }

    if (normalizedApiKey && pathContainsSegment(url, normalizedApiKey)) {
        pushCandidate(buildDirectPathEndpoint(resolvedBaseUrl), { "Content-Type": "application/json" });
    }

    const standardEndpoint = buildDirectPathEndpoint(resolvedBaseUrl);
    pushCandidate(standardEndpoint, {
        "Content-Type": "application/json",
        ...(normalizedApiKey ? { Authorization: `Bearer ${normalizedApiKey}` } : {}),
    });

    if (normalizedApiKey) {
        pushCandidate(withTokenQuery(standardEndpoint, normalizedApiKey), { "Content-Type": "application/json" });
        pushCandidate(standardEndpoint, { "Content-Type": "application/json" });
    }

    return candidates;
}

function isKnownSpamRedirect(value: string): boolean {
    return value.trim().startsWith(DEEPLX_SPAM_REDIRECT);
}

export class DeepLXClient {
    private profile: RuntimeProviderProfile;

    constructor(profile: RuntimeProviderProfile) {
        this.profile = profile;
    }

    async translate(text: string, targetLang: string): Promise<string> {
        const candidates = buildDeepLXCandidates(normalizeBaseUrl(this.profile.baseUrl), this.profile.apiKey);
        const requestBody = JSON.stringify({
            text,
            source_lang: "AUTO",
            target_lang: resolveTargetLangCode(targetLang),
        });

        let lastError: Error | null = null;

        for (const candidate of candidates) {
            try {
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

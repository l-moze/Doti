export type OutboundUrlGuardEnv = Record<string, string | undefined>;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const BLOCKED_HOSTNAME_SUFFIXES = [
    ".localhost",
    ".local",
    ".internal",
];

function isPublicDeployment(env: OutboundUrlGuardEnv): boolean {
    const value = env.PUBLIC_DEPLOYMENT?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeHostname(hostname: string): string {
    return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isPrivateIpv4(hostname: string): boolean {
    const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) {
        return false;
    }

    const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => !Number.isFinite(octet) || octet > 255)) {
        return true;
    }

    const [a, b] = octets;

    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224
    );
}

function isPrivateIpv6(hostname: string): boolean {
    if (!hostname.includes(":")) {
        return false;
    }

    const compact = hostname.replace(/%.*$/, "");

    return (
        compact === "::" ||
        compact === "::1" ||
        compact.startsWith("fc") ||
        compact.startsWith("fd") ||
        compact.startsWith("fe80") ||
        compact.startsWith("::ffff:")
    );
}

export function isPrivateNetworkHostname(hostname: string): boolean {
    const normalized = normalizeHostname(hostname);

    if (!normalized || normalized === "localhost") {
        return true;
    }

    if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
        return true;
    }

    return isPrivateIpv4(normalized) || isPrivateIpv6(normalized);
}

/**
 * Validates a user-supplied upstream URL before the server fetches it.
 *
 * Private / loopback / link-local targets are only rejected in public
 * deployment mode, because local-first setups legitimately point providers at
 * hosts such as a local Ollama instance.
 */
export function assertAllowedOutboundUrl(rawUrl: string, env: OutboundUrlGuardEnv = process.env): URL {
    let parsed: URL;

    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        throw new Error("Invalid upstream URL");
    }

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`Unsupported upstream URL protocol: ${parsed.protocol}`);
    }

    if (isPublicDeployment(env) && isPrivateNetworkHostname(parsed.hostname)) {
        throw new Error("Upstream URL targets a private network address");
    }

    return parsed;
}

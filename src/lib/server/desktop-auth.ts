export type DesktopAuthEnv = Record<string, string | undefined>;

function isDesktopModeEnabled(env: DesktopAuthEnv = process.env): boolean {
    const value = env.DESKTOP_MODE?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isDesktopApiAuthorized(
    headers: Headers,
    env: DesktopAuthEnv = process.env
): boolean {
    if (!isDesktopModeEnabled(env)) {
        return true;
    }

    const expectedToken = env.DESKTOP_AUTH_TOKEN?.trim();
    if (!expectedToken) {
        return false;
    }

    return headers.get("x-desktop-auth") === expectedToken;
}

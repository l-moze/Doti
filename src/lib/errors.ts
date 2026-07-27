/**
 * 错误处理相关的共享工具。
 */

export function getErrorMessage(error: unknown, fallback = ""): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

export function stringifyError(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? "");
}

export function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error ?? ""));
}

export function isAbortError(error: unknown): boolean {
    return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}

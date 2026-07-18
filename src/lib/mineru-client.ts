import axios, { type AxiosError, type AxiosInstance } from "axios";
import { Agent } from "node:https";

const DEFAULT_EXTRA_FORMATS = ["html", "latex"];

export interface MinerUConfig {
    apiKey: string;
    baseUrl?: string;
}

export interface FileEntry {
    name: string;
    data_id?: string;
    is_ocr?: boolean;
    page_ranges?: string;
}

export interface BatchUploadOptions {
    enableFormula?: boolean;
    enableTable?: boolean;
    language?: string;
    extraFormats?: string[];
    modelVersion?: string;
}

export interface BatchUploadResult {
    batch_id: string;
    file_urls: string[];
}

export interface ExtractStatusResult {
    batch_id: string;
    extract_result: {
        file_name: string;
        state: "done" | "pending" | "running" | "failed" | "converting" | "waiting-file";
        full_zip_url?: string;
        err_msg?: string;
        extract_progress?: {
            extracted_pages: number;
            total_pages: number;
            start_time: string;
        };
    }[];
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class MinerUUpstreamError extends Error {
    statusCode?: number;
    retryable: boolean;

    constructor(message: string, options?: { statusCode?: number; retryable?: boolean; cause?: unknown }) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "MinerUUpstreamError";
        this.statusCode = options?.statusCode;
        this.retryable = options?.retryable ?? false;
    }
}

export function isMinerUUpstreamError(error: unknown): error is MinerUUpstreamError {
    return error instanceof MinerUUpstreamError;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatusCode(statusCode?: number): boolean {
    if (!statusCode) return true;
    return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function extractAxiosErrorMessage(error: AxiosError): string {
    const responseData = error.response?.data;

    if (typeof responseData === "string" && responseData.trim()) {
        return responseData.trim();
    }

    if (responseData && typeof responseData === "object") {
        const maybeMessage = (responseData as Record<string, unknown>).msg
            ?? (responseData as Record<string, unknown>).message
            ?? (responseData as Record<string, unknown>).error;

        if (typeof maybeMessage === "string" && maybeMessage.trim()) {
            return maybeMessage.trim();
        }
    }

    return error.message;
}

function normalizeMinerUError(context: string, error: unknown): MinerUUpstreamError {
    if (error instanceof MinerUUpstreamError) {
        return error;
    }

    if (axios.isAxiosError(error)) {
        const statusCode = error.response?.status;
        const retryable = isRetryableStatusCode(statusCode)
            || ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(error.code || "");
        const detail = extractAxiosErrorMessage(error);
        return new MinerUUpstreamError(`${context}: ${detail}`, {
            statusCode,
            retryable,
            cause: error,
        });
    }

    const fallbackMessage = getErrorMessage(error);
    const retryable = /timeout|network|socket|connect|upstream error|request failed/i.test(fallbackMessage);
    return new MinerUUpstreamError(`${context}: ${fallbackMessage}`, {
        retryable,
        cause: error,
    });
}

async function withMinerURetry<T>(
    context: string,
    request: () => Promise<T>,
    options?: { attempts?: number; baseDelayMs?: number }
): Promise<T> {
    const attempts = options?.attempts ?? 3;
    const baseDelayMs = options?.baseDelayMs ?? 1200;
    let lastError: MinerUUpstreamError | null = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await request();
        } catch (error) {
            const normalizedError = normalizeMinerUError(context, error);
            lastError = normalizedError;

            if (!normalizedError.retryable || attempt === attempts) {
                throw normalizedError;
            }

            console.warn(
                `[MinerU] ${context} failed (attempt ${attempt}/${attempts}), retrying...`,
                normalizedError.message
            );
            await sleep(baseDelayMs * attempt);
        }
    }

    throw lastError ?? new MinerUUpstreamError(`${context}: Unknown error`, { retryable: false });
}

function readOptionalStringEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

function readBooleanEnv(name: string): boolean | undefined {
    const value = readOptionalStringEnv(name)?.toLowerCase();
    if (!value) return undefined;
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
    return undefined;
}

function readCsvEnv(name: string): string[] | undefined {
    const raw = readOptionalStringEnv(name);
    if (!raw) return undefined;

    const values = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    return values.length > 0 ? values : undefined;
}

function sanitizeExtraFormats(extraFormats?: string[]): string[] | undefined {
    if (!extraFormats?.length) return undefined;

    return Array.from(
        new Set(
            extraFormats
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean)
        )
    );
}

export function getMinerUBatchUploadOptionsFromEnv(): BatchUploadOptions {
    return {
        enableFormula: readBooleanEnv("MINERU_ENABLE_FORMULA") ?? true,
        enableTable: readBooleanEnv("MINERU_ENABLE_TABLE") ?? true,
        language: readOptionalStringEnv("MINERU_LANGUAGE"),
        extraFormats: sanitizeExtraFormats(readCsvEnv("MINERU_EXTRA_FORMATS")) ?? [...DEFAULT_EXTRA_FORMATS],
        modelVersion: readOptionalStringEnv("MINERU_MODEL_VERSION") ?? "vlm",
    };
}

export function buildMinerUFileEntry(name: string, dataId?: string): FileEntry {
    const entry: FileEntry = { name };
    const isOcr = readBooleanEnv("MINERU_IS_OCR");
    const pageRanges = readOptionalStringEnv("MINERU_PAGE_RANGES");

    if (dataId) {
        entry.data_id = dataId;
    }

    if (typeof isOcr === "boolean") {
        entry.is_ocr = isOcr;
    }

    if (pageRanges) {
        entry.page_ranges = pageRanges;
    }

    return entry;
}

export class MinerUClient {
    private client: AxiosInstance;

    constructor(config: MinerUConfig) {
        this.client = axios.create({
            baseURL: config.baseUrl || "https://mineru.net/api/v4",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
            },
            timeout: 120000,
            httpsAgent: new Agent({
                keepAlive: true,
                family: 4,
            }),
        });
    }

    /**
     * Step 1: 申请批量文件上传链接
     */
    async applyBatchUpload(files: FileEntry[], options: BatchUploadOptions = {}): Promise<BatchUploadResult> {
        const defaults = getMinerUBatchUploadOptionsFromEnv();
        const resolvedOptions: BatchUploadOptions = {
            enableFormula: options.enableFormula ?? defaults.enableFormula,
            enableTable: options.enableTable ?? defaults.enableTable,
            language: options.language ?? defaults.language,
            extraFormats: sanitizeExtraFormats(options.extraFormats) ?? sanitizeExtraFormats(defaults.extraFormats),
            modelVersion: options.modelVersion ?? defaults.modelVersion,
        };

        const payload: Record<string, unknown> = {
            files,
            model_version: resolvedOptions.modelVersion ?? "vlm",
            enable_formula: resolvedOptions.enableFormula ?? true,
            enable_table: resolvedOptions.enableTable ?? true,
        };

        if (resolvedOptions.language) {
            payload.language = resolvedOptions.language;
        }

        if (resolvedOptions.extraFormats?.length) {
            payload.extra_formats = resolvedOptions.extraFormats;
        }

        return withMinerURetry("Failed to apply batch upload", async () => {
            const { data } = await this.client.post("/file-urls/batch", payload);

            if (data.code !== 0) {
                throw new MinerUUpstreamError(`Failed to apply batch upload: MinerU API Error [${data.code}]: ${data.msg}`, {
                    retryable: false,
                });
            }

            return data.data;
        });
    }

    /**
     * Step 2: 上传文件到云端 (PUT Signed URL)
     * 注意：此请求不带 Authorization 头，且直接 PUT 二进制流
     * 使用原生 fetch 以精确控制请求头，避免 axios 自动添加额外头部
     */
    async uploadFileToUrl(url: string, fileBuffer: Buffer | ArrayBuffer | Blob): Promise<void> {
        const body = fileBuffer instanceof Blob
            ? fileBuffer
            : fileBuffer instanceof ArrayBuffer
                ? new Uint8Array(fileBuffer)
                : new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);

        await withMinerURetry("Failed to upload file to signed URL", async () => {
            const response = await fetch(url, {
                method: "PUT",
                body: body as BodyInit,
                signal: AbortSignal.timeout(60_000),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("Upload failed with response:", {
                    status: response.status,
                    statusText: response.statusText,
                    bodyPreview: errorText ? errorText.slice(0, 200) : "",
                });

                throw new MinerUUpstreamError(
                    `Failed to upload file to signed URL: HTTP ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
                    {
                        statusCode: response.status,
                        retryable: isRetryableStatusCode(response.status),
                    }
                );
            }
        }, { attempts: 3, baseDelayMs: 1500 });
    }

    /**
     * Step 3: 查询批量任务状态
     */
    async getBatchStatus(batchId: string): Promise<ExtractStatusResult> {
        return withMinerURetry("Failed to get batch status", async () => {
            const { data } = await this.client.get(`/extract-results/batch/${batchId}`);

            if (data.code !== 0) {
                throw new MinerUUpstreamError(`Failed to get batch status: MinerU API Error [${data.code}]: ${data.msg}`, {
                    retryable: false,
                });
            }

            return data.data;
        }, { attempts: 3, baseDelayMs: 2000 });
    }
}

import axios, { type AxiosInstance } from "axios";
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

        try {
            const { data } = await this.client.post("/file-urls/batch", payload);

            if (data.code !== 0) {
                throw new Error(`MinerU API Error [${data.code}]: ${data.msg}`);
            }

            return data.data;
        } catch (error: unknown) {
            throw new Error(`Failed to apply batch upload: ${getErrorMessage(error)}`);
        }
    }

    /**
     * Step 2: 上传文件到云端 (PUT Signed URL)
     * 注意：此请求不带 Authorization 头，且直接 PUT 二进制流
     * 使用原生 fetch 以精确控制请求头，避免 axios 自动添加额外头部
     */
    async uploadFileToUrl(url: string, fileBuffer: Buffer | ArrayBuffer | Blob): Promise<void> {
        try {
            const body = fileBuffer instanceof Blob
                ? fileBuffer
                : new Uint8Array(fileBuffer instanceof ArrayBuffer ? fileBuffer : fileBuffer.buffer);

            const response = await fetch(url, {
                method: "PUT",
                body: body as BodyInit,
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error("Upload failed with response:", {
                    status: response.status,
                    statusText: response.statusText,
                    body: errorText,
                });
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error: unknown) {
            throw new Error(`Failed to upload file to signed URL: ${getErrorMessage(error)}`);
        }
    }

    /**
     * Step 3: 查询批量任务状态
     */
    async getBatchStatus(batchId: string): Promise<ExtractStatusResult> {
        let retries = 3;
        while (retries > 0) {
            try {
                const { data } = await this.client.get(`/extract-results/batch/${batchId}`);

                if (data.code !== 0) {
                    throw new Error(`MinerU API Error [${data.code}]: ${data.msg}`);
                }

                return data.data;
            } catch (error: unknown) {
                retries--;
                if (retries === 0) {
                    throw new Error(`Failed to get batch status after 3 attempts: ${getErrorMessage(error)}`);
                }
                console.warn(`[MinerU] Status check failed, retrying... (${retries} attempts left)`);
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }
        throw new Error("Failed to get batch status: Unknown error");
    }
}

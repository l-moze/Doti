/**
 * LLM Provider Registry
 * 定义支持的模型提供商及其配置
 */

export interface ProviderDef {
    id: string;
    name: string;
    baseUrl: string;
    envKey: string;           // 环境变量名
    modelsEndpoint: string;   // GET /v1/models 或等效端点
    isOpenAICompat: boolean;  // 是否使用 openai SDK
    /** Anthropic 官方 Messages API（@anthropic-ai/sdk），与 isOpenAICompat 互斥 */
    isAnthropic?: boolean;
}

export const PROVIDERS: Record<string, ProviderDef> = {
    gemini: {
        id: 'gemini',
        name: 'Google Gemini',
        baseUrl: '',  // 使用 @google/genai
        envKey: 'GEMINI_API_KEY',
        modelsEndpoint: '', // Gemini 需要特殊处理
        isOpenAICompat: false,
    },
    deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        envKey: 'DEEPSEEK_API_KEY',
        modelsEndpoint: '/models',
        isOpenAICompat: true,
    },
    glm: {
        id: 'glm',
        name: '智谱 GLM',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        envKey: 'GLM_API_KEY',
        modelsEndpoint: '/models',
        isOpenAICompat: true,
    },
    ollama: {
        id: 'ollama',
        name: 'Ollama (本地)',
        baseUrl: 'http://localhost:11434/v1',
        envKey: 'OLLAMA_BASE_URL', // 特殊：存 URL 而非 Key
        modelsEndpoint: '/models',
        isOpenAICompat: true,
    },
    openai: {
        id: 'openai',
        name: 'OpenAI',
        baseUrl: 'http://127.0.0.1:3000/v1',
        envKey: 'OPENAI_API_KEY',
        modelsEndpoint: '/models',
        isOpenAICompat: true,
    },
    /**
     * Claude：Anthropic 官方 Messages API。
     * - Key: ANTHROPIC_API_KEY（与 @anthropic-ai/sdk 默认一致）
     * - 可选覆盖网关：ANTHROPIC_BASE_URL（企业代理等）
     * - 可选单次输出上限：ANTHROPIC_MAX_OUTPUT_TOKENS（默认 8192）
     */
    claude: {
        id: 'claude',
        name: 'Claude (Anthropic 官方)',
        baseUrl: 'https://api.anthropic.com',
        envKey: 'ANTHROPIC_API_KEY',
        modelsEndpoint: '/v1/models',
        isOpenAICompat: false,
        isAnthropic: true,
    },
};

// 默认模型配置
export const DEFAULT_MODELS: Record<string, string> = {
    gemini: 'gemini-2.5-flash',
    deepseek: 'deepseek-chat',
    glm: 'GLM-4.5-Flash',
    ollama: 'llama3.3',
    openai: 'gpt-4o-mini',
    /** 官方模型 ID，请以控制台 / 文档为准 */
    claude: 'claude-sonnet-4-20250514',
};

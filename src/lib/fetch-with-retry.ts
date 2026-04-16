type RetryPredicate = (response: Response | null, error: unknown, attempt: number) => boolean;

interface FetchWithRetryOptions extends RequestInit {
    retries?: number;
    retryDelayMs?: number;
    shouldRetry?: RetryPredicate;
}

const defaultShouldRetry: RetryPredicate = (response, error) => {
    if (error) return true;
    if (!response) return false;
    return response.status >= 500 || response.status === 429;
};

export async function fetchWithRetry(
    input: RequestInfo | URL,
    options: FetchWithRetryOptions = {}
): Promise<Response> {
    const {
        retries = 2,
        retryDelayMs = 1000,
        shouldRetry = defaultShouldRetry,
        ...init
    } = options;

    let attempt = 0;
    let lastError: unknown = null;

    while (attempt <= retries) {
        try {
            const response = await fetch(input, init);
            if (!shouldRetry(response, null, attempt) || attempt === retries) {
                return response;
            }
        } catch (error) {
            lastError = error;
            if (!shouldRetry(null, error, attempt) || attempt === retries) {
                throw error;
            }
        }

        const delay = retryDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
    }

    throw lastError instanceof Error ? lastError : new Error('Request failed');
}

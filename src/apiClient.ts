const BASE_URL = 'https://open.bigmodel.cn';

export interface TokenLimit {
    type: string;
    percentage: number;
    /** 5h 窗口重置后未产生新用量时，API 会缺失此字段 */
    nextResetTime?: number;
    currentValue?: number;
    usage?: number;
    usageDetails?: Array<{ modelCode: string; usage: number }>;
}

export interface QuotaLimitResponse {
    code: number;
    msg?: string;
    data?: {
        level: string;
        limits: TokenLimit[];
    };
}

export interface ModelUsageResponse {
    code: number;
    msg?: string;
    data?: {
        x_time: string[];
        totalUsage: {
            totalModelCallCount: number;
            totalTokensUsage: number;
        };
        modelCallCount: (number | null)[];
        tokensUsage: (number | null)[];
    };
}

export interface ToolUsageResponse {
    code: number;
    msg?: string;
    data?: {
        totalUsage: {
            totalNetworkSearchCount: number;
            totalWebReadMcpCount: number;
            totalZreadMcpCount: number;
            totalSearchMcpCount: number;
            toolDetails: Array<{ modelName: string; totalUsageCount: number }>;
        };
    };
}

async function httpRequest(path: string, apiKey: string, params?: Record<string, string>): Promise<string> {
    let url = BASE_URL + path;
    if (params) {
        const queryParts = Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        if (queryParts.length > 0) {
            url += '?' + queryParts.join('&');
        }
    }

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': apiKey,
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en',
        },
        redirect: 'follow',
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${path}`);
    }

    const text = await response.text();
    if (!text.trim()) {
        throw new Error(`Empty response from ${path} (HTTP ${response.status})`);
    }
    return text;
}

export async function getQuotaLimit(apiKey: string, startTime?: string, endTime?: string): Promise<QuotaLimitResponse> {
    const params: Record<string, string> = {};
    if (startTime) { params.startTime = startTime; }
    if (endTime) { params.endTime = endTime; }
    const raw = await httpRequest('/api/monitor/usage/quota/limit', apiKey, params);
    return JSON.parse(raw) as QuotaLimitResponse;
}

export async function getModelUsage(apiKey: string, startTime?: string, endTime?: string): Promise<ModelUsageResponse> {
    const params: Record<string, string> = {};
    if (startTime) { params.startTime = startTime; }
    if (endTime) { params.endTime = endTime; }
    const raw = await httpRequest('/api/monitor/usage/model-usage', apiKey, params);
    return JSON.parse(raw) as ModelUsageResponse;
}

export async function getToolUsage(apiKey: string, startTime?: string, endTime?: string): Promise<ToolUsageResponse> {
    const params: Record<string, string> = {};
    if (startTime) { params.startTime = startTime; }
    if (endTime) { params.endTime = endTime; }
    const raw = await httpRequest('/api/monitor/usage/tool-usage', apiKey, params);
    return JSON.parse(raw) as ToolUsageResponse;
}

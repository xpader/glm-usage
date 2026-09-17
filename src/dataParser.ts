import { TokenLimit } from './apiClient';

/** 单个窗口的配额数据 */
export interface WindowQuota {
    percentage: number;
    /** 窗口重置后无新用量时缺失 */
    nextResetTime?: number;
}

/** 包含 5h 窗口和周窗口的完整配额状态 */
export interface QuotaStatus {
    level: string;
    hourly: WindowQuota;
    weekly: WindowQuota;
    mcp: WindowQuota;
    /** 今日 Token 用量 */
    todayTokens?: number;
    /** 最近 7 天 Token 用量 */
    last7dTokens?: number;
    /** 最近 30 天 Token 用量 */
    last30dTokens?: number;
}

/** 从 API 返回的 limits 中提取完整配额状态 */
export function parseQuotaStatus(data: { level: string; limits: TokenLimit[] }): QuotaStatus | null {
    const tokenLimits = data.limits
        .filter(l => l.type === 'TOKENS_LIMIT')
        .sort((a, b) => (a.nextResetTime || 0) - (b.nextResetTime || 0));

    if (tokenLimits.length === 0) {
        return null;
    }

    const hourly: WindowQuota = {
        percentage: tokenLimits[0].percentage,
        nextResetTime: tokenLimits[0].nextResetTime,
    };

    const weekly: WindowQuota = tokenLimits.length > 1
        ? { percentage: tokenLimits[tokenLimits.length - 1].percentage, nextResetTime: tokenLimits[tokenLimits.length - 1].nextResetTime }
        : { percentage: -1, nextResetTime: 0 };

    const timeLimit = data.limits.find(l => l.type === 'TIME_LIMIT');

    return {
        level: data.level,
        hourly,
        weekly,
        mcp: {
            percentage: timeLimit ? timeLimit.percentage : -1,
            nextResetTime: timeLimit ? timeLimit.nextResetTime : 0,
        },
    };
}

/** 将时间戳格式化为重置时间点，同一天显示 HH:mm，跨天显示 MM/dd HH:mm，缺失时显示 --:-- */
export function formatResetTime(timestampMs?: number): string {
    // undefined/0/NaN 均为 falsy，统一显示占位符
    if (!timestampMs) {
        return '--:--';
    }
    const date = new Date(timestampMs);
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    if (date.toDateString() === now.toDateString()) {
        return time;
    }
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`;
}

/** 生成可视化进度条 */
function formatProgressBar(percentage: number, width: number = 10): string {
    if (percentage < 0) {
        return '--';
    }
    const clamped = Math.min(100, percentage);
    const filled = Math.round((clamped / 100) * width);
    const empty = width - filled;
    return '■'.repeat(filled) + '□'.repeat(empty);
}

/** 将模板字符串中的变量替换为实际值 */
export function renderTemplate(template: string, status: QuotaStatus): string {
    const isWeeklyValid = status.weekly.percentage >= 0;
    const isMcpValid = status.mcp.percentage >= 0;
    const replacements: Record<string, string> = {
        'HOURLY_PERCENT': status.hourly.percentage.toString(),
        'WEEKLY_PERCENT': isWeeklyValid ? status.weekly.percentage.toString() : '--',
        'MCP_PERCENT': isMcpValid ? status.mcp.percentage.toString() : '--',
        'HOURLY_RESET': formatResetTime(status.hourly.nextResetTime),
        'WEEKLY_RESET': isWeeklyValid ? formatResetTime(status.weekly.nextResetTime) : '--:--',
        'MCP_RESET': isMcpValid ? formatResetTime(status.mcp.nextResetTime) : '--:--',
        'HOURLY_BAR': formatProgressBar(status.hourly.percentage),
        'WEEKLY_BAR': isWeeklyValid ? formatProgressBar(status.weekly.percentage) : '--',
        'MCP_BAR': isMcpValid ? formatProgressBar(status.mcp.percentage) : '--',
    };

    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
        result = result.split(`\${${key}}`).join(value);
    }
    return result;
}

export function formatNumber(num: number): string {
    return num.toLocaleString('en-US');
}

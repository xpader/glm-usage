import * as vscode from 'vscode';
import { getKey, setKey, deleteKey } from './keyStorage';
import { getQuotaLimit, getModelUsage } from './apiClient';
import { parseQuotaStatus, QuotaStatus } from './dataParser';
import { createStatusBarItem, updateStatusBar } from './statusBar';
import { showUsageDetails } from './webviewPanel';

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let isLoading = false;
let lastQuotaStatus: QuotaStatus | null = null;
let statusBarItem: vscode.StatusBarItem | undefined;
let extContext: vscode.ExtensionContext | undefined;
let refreshGeneration = 0;

/** 获取状态栏模板配置 */
function getTemplate(): string {
    return vscode.workspace.getConfiguration('glmUsage').get<string>('statusBarTemplate', 'GLM: 5h ${HOURLY_PERCENT}% | 周 ${WEEKLY_PERCENT}%');
}

/** 使用缓存的配额数据刷新状态栏显示 */
function renderCachedStatus(): void {
    if (!lastQuotaStatus || !statusBarItem) {
        return;
    }
    updateStatusBar(statusBarItem, { type: 'quota', status: lastQuotaStatus, template: getTemplate() });
}

export async function activate(context: vscode.ExtensionContext) {
    extContext = context;
    statusBarItem = createStatusBarItem();
    statusBarItem.show();
    updateStatusBar(statusBarItem, { type: 'empty', message: '未设置 Key' });
    context.subscriptions.push(statusBarItem);

    // 检查已存储的 Key 并刷新
    const storedKey = await getKey(context);
    if (storedKey) {
        refreshQuota(context, statusBarItem);
    }

    // 注册命令：设置 API Key
    const setKeyCommand = vscode.commands.registerCommand('glmUsage.setKey', async () => {
        const input = await vscode.window.showInputBox({
            prompt: '请输入你的 GLM API Key',
            ignoreFocusOut: true,
            validateInput: (value) => value && value.trim().length > 0 ? undefined : 'API Key 不能为空'
        });
        if (input) {
            await setKey(context, input.trim());
            vscode.window.showInformationMessage('GLM API Key 已保存');
            refreshQuota(context, statusBarItem!);
        }
    });
    context.subscriptions.push(setKeyCommand);

    // 注册命令：刷新
    const refreshCommand = vscode.commands.registerCommand('glmUsage.refresh', () => {
        refreshQuota(context, statusBarItem!);
    });
    context.subscriptions.push(refreshCommand);

    // 注册命令：状态栏点击菜单
    const showMenuCommand = vscode.commands.registerCommand('glmUsage.showMenu', async () => {
        const picks: Array<vscode.QuickPickItem & { command?: string }> = [
            {
                label: 'Refresh Usage',
                description: 'Fetch the latest quota data from API',
                iconPath: new vscode.ThemeIcon('refresh'),
                command: 'glmUsage.refresh'
            },
            {
                label: 'Show Usage Details',
                description: 'Open the details panel',
                iconPath: new vscode.ThemeIcon('graph'),
                command: 'glmUsage.showUsageDetails'
            },
            {
                label: 'Set API Key',
                iconPath: new vscode.ThemeIcon('key'),
                command: 'glmUsage.setKey'
            },
            {
                label: 'Delete API Key',
                iconPath: new vscode.ThemeIcon('trash'),
                command: 'glmUsage.deleteKey'
            }
        ];
        const picked = await vscode.window.showQuickPick(picks, {
            placeHolder: 'GLM Usage — Select an action'
        });
        if (picked?.command) {
            vscode.commands.executeCommand(picked.command);
        }
    });
    context.subscriptions.push(showMenuCommand);

    // 注册命令：打开使用量详情面板
    const detailsCommand = vscode.commands.registerCommand('glmUsage.showUsageDetails', async () => {
        const apiKey = await getKey(context);
        await showUsageDetails(context, apiKey);
    });
    context.subscriptions.push(detailsCommand);

    // 注册命令：删除 API Key
    const deleteKeyCommand = vscode.commands.registerCommand('glmUsage.deleteKey', async () => {
        const confirm = await vscode.window.showWarningMessage(
            '确定要删除已保存的 GLM API Key 吗？',
            { modal: true },
            '删除'
        );
        if (confirm === '删除') {
            await deleteKey(context);
            vscode.window.showInformationMessage('GLM API Key 已删除');
            vscode.commands.executeCommand('glmUsage.clearStatus');
        }
    });
    context.subscriptions.push(deleteKeyCommand);

    // 注册命令：清除状态（Key 删除时调用）
    const clearStatusCommand = vscode.commands.registerCommand('glmUsage.clearStatus', () => {
        refreshGeneration++;
        lastQuotaStatus = null;
        isLoading = false;
        if (statusBarItem) {
            updateStatusBar(statusBarItem, { type: 'empty', message: '未设置 Key' });
        }
    });
    context.subscriptions.push(clearStatusCommand);

    // 启动自动刷新定时器
    startRefreshTimer(context, statusBarItem);

    // 启动倒计时定时器（检测窗口切换）
    startCountdownTimer();

    // 窗口聚焦时刷新
    const focusDisposable = vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) {
            refreshQuota(context, statusBarItem!);
        }
    });
    context.subscriptions.push(focusDisposable);

    // 配置变更监听
    const configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('glmUsage.refreshInterval')) {
            startRefreshTimer(context, statusBarItem!);
        }
        if (e.affectsConfiguration('glmUsage.statusBarTemplate')) {
            renderCachedStatus();
        }
        if (e.affectsConfiguration('glmUsage.apiKey')) {
            refreshQuota(context, statusBarItem!);
        }
    });
    context.subscriptions.push(configDisposable);
}

async function refreshQuota(context: vscode.ExtensionContext, item: vscode.StatusBarItem) {
    if (isLoading) {
        return;
    }

    const apiKey = await getKey(context);
    if (!apiKey) {
        updateStatusBar(item, { type: 'empty', message: '未设置 Key' });
        lastQuotaStatus = null;
        return;
    }

    isLoading = true;
    const thisGeneration = refreshGeneration;

    try {
        const result = await getQuotaLimit(apiKey);
        // 请求期间 Key 被删除，丢弃旧结果
        if (thisGeneration !== refreshGeneration) {
            return;
        }
        if (result.code === 200 && result.data) {
            const quotaStatus = parseQuotaStatus(result.data);
            if (quotaStatus) {
                lastQuotaStatus = quotaStatus;
                // 获取 Token 用量概览（失败不影响配额展示）
                await fetchTokenSummary(apiKey, quotaStatus);
                updateStatusBar(item, { type: 'quota', status: quotaStatus, template: getTemplate() });
            } else {
                updateStatusBar(item, { type: 'error', message: '无配额数据' });
            }
        } else {
            const msg = result.msg || 'Unknown error';
            if (msg.includes('unauthorized') || msg.includes('Unauthorized') || msg.includes('invalid')) {
                updateStatusBar(item, { type: 'error', message: 'Key 无效' });
            } else {
                updateStatusBar(item, { type: 'error', message: '查询失败' });
            }
        }
    } catch {
        if (thisGeneration !== refreshGeneration) {
            return;
        }
        updateStatusBar(item, { type: 'error', message: '查询失败' });
    } finally {
        isLoading = false;
    }
}

function startRefreshTimer(context: vscode.ExtensionContext, item: vscode.StatusBarItem) {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
    const interval = vscode.workspace.getConfiguration('glmUsage').get<number>('refreshInterval', 10);
    const intervalMs = Math.max(interval, 1) * 60 * 1000;
    refreshTimer = setInterval(() => refreshQuota(context, item), intervalMs);
}

/** 每 60s 检查窗口是否已切换并触发刷新 */
function startCountdownTimer() {
    countdownTimer = setInterval(() => {
        if (!lastQuotaStatus || isLoading || !extContext || !statusBarItem) {
            return;
        }
        const now = Date.now();
        // 5h 窗口已重置，触发 API 刷新获取新数据（无下次重置时间时跳过）
        if (lastQuotaStatus.hourly.nextResetTime && now >= lastQuotaStatus.hourly.nextResetTime) {
            refreshQuota(extContext, statusBarItem);
        }
    }, 60_000);
}

export function deactivate() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    }
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = undefined;
    }
}

/** 两位数补零 */
function pad2(n: number): string {
    return n.toString().padStart(2, '0');
}

/** 格式化日期为 YYYY-MM-DD HH:mm:ss */
function formatDateTime(date: Date): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 获取 Token 用量概览并附加到 quotaStatus */
async function fetchTokenSummary(apiKey: string, quotaStatus: import('./dataParser').QuotaStatus): Promise<void> {
    try {
        const now = new Date();
        const nowStr = formatDateTime(now);
        const todayStart = formatDateTime(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
        const sevenDaysAgo = formatDateTime(new Date(Date.now() - 7 * 86400000));
        const thirtyDaysAgo = formatDateTime(new Date(Date.now() - 30 * 86400000));

        const [todayUsage, last7dUsage, last30dUsage] = await Promise.all([
            getModelUsage(apiKey, todayStart, nowStr),
            getModelUsage(apiKey, sevenDaysAgo, nowStr),
            getModelUsage(apiKey, thirtyDaysAgo, nowStr),
        ]);

        quotaStatus.todayTokens = todayUsage.data?.totalUsage.totalTokensUsage;
        quotaStatus.last7dTokens = last7dUsage.data?.totalUsage.totalTokensUsage;
        quotaStatus.last30dTokens = last30dUsage.data?.totalUsage.totalTokensUsage;
    } catch {
        // Token 用量获取失败不影响配额展示
    }
}

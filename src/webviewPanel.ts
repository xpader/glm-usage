import * as vscode from 'vscode';
import { getQuotaLimit, getModelUsage, getToolUsage, TokenLimit } from './apiClient';
import { formatNumber, formatResetTime } from './dataParser';
import { getKey, setKey, deleteKey as deleteStoredKey } from './keyStorage';
import { runSpeedTest, DEFAULT_MODELS, SpeedTestResult, CONCURRENCY_OPTIONS } from './speedTest';

let currentPanel: vscode.WebviewPanel | undefined;
let panelContext: vscode.ExtensionContext | undefined;
let currentApiKey: string | undefined;
let panelDisposables: vscode.Disposable[] = [];
let speedTestAbort: AbortController | undefined;
let lastSpeedResults: SpeedTestResult[] = [];
let isSpeedTesting = false;
let speedTestProgress = { current: 0, total: 0, model: '', promptName: '' };

interface ModelConfig { name: string; selected: boolean; }

/** Token 用量概览（今日 / 7 天 / 30 天） */
interface TokenSummary {
    today: number;
    last7d: number;
    last30d: number;
}
const SPEED_MODELS_KEY = 'glm-speed-test-models';
let speedTestModels: ModelConfig[] = [];

async function loadSpeedTestModels(context: vscode.ExtensionContext): Promise<ModelConfig[]> {
    const saved = context.globalState.get<ModelConfig[]>(SPEED_MODELS_KEY);
    if (saved && saved.length > 0) {
        speedTestModels = saved;
    } else {
        speedTestModels = DEFAULT_MODELS.map(name => ({ name, selected: true }));
        await context.globalState.update(SPEED_MODELS_KEY, speedTestModels);
    }
    return speedTestModels;
}

async function saveSpeedTestModels() {
    if (panelContext) {
        await panelContext.globalState.update(SPEED_MODELS_KEY, speedTestModels);
    }
}

const INTERVAL_OPTIONS = [1, 3, 5, 10, 15, 30, 60];
const TIME_RANGE_OPTIONS = [24, 168, 720];
const TIME_RANGE_LABELS: Record<number, string> = { 24: '24 小时', 168: '7 天', 720: '30 天' };
let currentTimeRange = 24;

export async function showUsageDetails(context: vscode.ExtensionContext, apiKey?: string): Promise<void> {
    panelContext = context;
    if (apiKey) { currentApiKey = apiKey; }
    await loadSpeedTestModels(context);

    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Two);
        if (apiKey) {
            await loadUsageData(apiKey, currentTimeRange);
        } else {
            const currentInterval = vscode.workspace.getConfiguration('glmUsage').get<number>('refreshInterval', 10);
            currentPanel.webview.html = getNoKeyHtml(currentInterval);
        }
    } else {
        // 清理旧的 disposables
        panelDisposables.forEach(d => d.dispose());
        panelDisposables = [];

        currentPanel = vscode.window.createWebviewPanel(
            'glmUsageDetails',
            'GLM API 使用量报告',
            vscode.ViewColumn.Two,
            { enableScripts: true }
        );

        // 所有面板相关的 disposable 统一管理
        panelDisposables.push(currentPanel);
        panelDisposables.push(currentPanel.onDidDispose(() => {
            currentPanel = undefined;
            panelContext = undefined;
            panelDisposables.forEach(d => d.dispose());
            panelDisposables = [];
        }));

        // 监听 webview 消息
        panelDisposables.push(currentPanel.webview.onDidReceiveMessage(async (msg) => {
            if (!panelContext) { return; }

            if (msg.command === 'refresh') {
                const key = await getKey(panelContext);
                if (key) {
                    await loadUsageData(key, currentTimeRange);
                }
            } else if (msg.command === 'setKey') {
                const input = await vscode.window.showInputBox({
                    prompt: '请输入你的 GLM API Key',
                    ignoreFocusOut: true,
                    validateInput: (value) => value && value.trim().length > 0 ? undefined : 'API Key 不能为空'
                });
                if (input && panelContext) {
                    currentApiKey = input.trim();
                    await setKey(panelContext, input.trim());
                    vscode.window.showInformationMessage('GLM API Key 已保存');
                    await loadUsageData(input.trim(), currentTimeRange);
                    vscode.commands.executeCommand('glmUsage.refresh');
                }
            } else if (msg.command === 'deleteKey') {
                const confirm = await vscode.window.showWarningMessage(
                    '确定要删除已保存的 GLM API Key 吗？',
                    { modal: true },
                    '删除'
                );
                if (confirm === '删除' && panelContext) {
                    await deleteStoredKey(panelContext);
                    currentApiKey = undefined;
                    vscode.window.showInformationMessage('GLM API Key 已删除');
                    vscode.commands.executeCommand('glmUsage.clearStatus');
                    if (currentPanel) {
                        currentPanel.dispose();
                    }
                }
            } else if (msg.command === 'setInterval') {
                const minutes = msg.value as number;
                const config = vscode.workspace.getConfiguration('glmUsage');
                await config.update('refreshInterval', minutes, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`自动刷新间隔已设置为 ${minutes} 分钟`);
            } else if (msg.command === 'setTimeRange') {
                const hours = msg.value as number;
                currentTimeRange = hours;
                const key = await getKey(panelContext);
                if (key) {
                    await loadUsageData(key, hours);
                }
            } else if (msg.command === 'startSpeedTest') {
                const models: string[] = msg.models || DEFAULT_MODELS;
                const concurrency: number = msg.concurrency || 1;
                const key = currentApiKey || await getKey(panelContext);
                if (!key) { return; }
                isSpeedTesting = true;
                speedTestAbort = new AbortController();
                const startTime = Date.now();
                const ctx = panelContext;
                await runSpeedTest(key, models, (progress) => {
                    if (progress.type === 'progress') {
                        speedTestProgress = { current: progress.current, total: progress.total, model: progress.model, promptName: progress.promptName };
                        if (currentPanel) {
                            currentPanel.webview.postMessage({ command: 'speedProgress', current: progress.current, total: progress.total, model: progress.model, promptName: progress.promptName });
                        }
                    } else if (progress.type === 'result') {
                        if (currentPanel) {
                            currentPanel.webview.postMessage({ command: 'speedResult', result: progress.result, elapsed: ((Date.now() - startTime) / 1000).toFixed(1) });
                        }
                    } else if (progress.type === 'done') {
                        isSpeedTesting = false;
                        lastSpeedResults = progress.allResults || [];
                        if (currentPanel) {
                            currentPanel.webview.postMessage({ command: 'speedDone', results: progress.allResults, elapsed: ((Date.now() - startTime) / 1000).toFixed(1) });
                        } else {
                            vscode.window.showInformationMessage('🚀 模型测速已完成，点击查看结果', '查看').then(selection => {
                                if (selection === '查看' && ctx) {
                                    showUsageDetails(ctx, key);
                                }
                            });
                        }
                    } else if (progress.type === 'error') {
                        isSpeedTesting = false;
                        if (currentPanel) {
                            currentPanel.webview.postMessage({ command: 'speedError', error: progress.errorMsg });
                        } else {
                            vscode.window.showErrorMessage('🚀 模型测速失败: ' + (progress.errorMsg || 'Unknown'));
                        }
                    }
                }, speedTestAbort.signal, concurrency);
            } else if (msg.command === 'stopSpeedTest') {
                speedTestAbort?.abort();
                isSpeedTesting = false;
            } else if (msg.command === 'addSpeedModel') {
                const name = (msg.name as string).trim();
                if (name && !speedTestModels.some(m => m.name === name)) {
                    speedTestModels.push({ name, selected: true });
                    await saveSpeedTestModels();
                }
            } else if (msg.command === 'removeSpeedModel') {
                const name = msg.name as string;
                speedTestModels = speedTestModels.filter(m => m.name !== name);
                await saveSpeedTestModels();
            } else if (msg.command === 'toggleSpeedModel') {
                const name = msg.name as string;
                const m = speedTestModels.find(m => m.name === name);
                if (m) { m.selected = !m.selected; }
                await saveSpeedTestModels();
            }
        }));

        if (apiKey) {
            await loadUsageData(apiKey, currentTimeRange);
        } else {
            const currentInterval = vscode.workspace.getConfiguration('glmUsage').get<number>('refreshInterval', 10);
            currentPanel.webview.html = getNoKeyHtml(currentInterval);
        }
    }
}

async function loadUsageData(apiKey: string, timeRange: number = 24): Promise<void> {
    if (!currentPanel) { return; }

    const currentInterval = vscode.workspace.getConfiguration('glmUsage').get<number>('refreshInterval', 10);
    currentPanel.webview.html = getLoadingHtml(currentInterval, timeRange);

    try {
        const endTime = formatDateTime(new Date());
        const startTime = formatDateTime(new Date(Date.now() - timeRange * 60 * 60 * 1000));

        // 概览卡片的时间范围
        const nowStr = formatDateTime(new Date());
        const todayStart = getTodayStart();
        const sevenDaysAgo = formatDateTime(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
        const thirtyDaysAgo = formatDateTime(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

        const [quotaResult, modelResult, toolResult, todayUsage, last7dUsage, last30dUsage] = await Promise.all([
            getQuotaLimit(apiKey),
            getModelUsage(apiKey, startTime, endTime),
            getToolUsage(apiKey, startTime, endTime),
            getModelUsage(apiKey, todayStart, nowStr),
            getModelUsage(apiKey, sevenDaysAgo, nowStr),
            getModelUsage(apiKey, thirtyDaysAgo, nowStr)
        ]);

        const tokenSummary: TokenSummary = {
            today: todayUsage.code === 200 && todayUsage.data ? todayUsage.data.totalUsage.totalTokensUsage : -1,
            last7d: last7dUsage.code === 200 && last7dUsage.data ? last7dUsage.data.totalUsage.totalTokensUsage : -1,
            last30d: last30dUsage.code === 200 && last30dUsage.data ? last30dUsage.data.totalUsage.totalTokensUsage : -1,
        };

        if (currentPanel) {
            currentPanel.webview.html = generateReportHtml(quotaResult, modelResult, toolResult, currentInterval, timeRange, tokenSummary);
        }
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        if (currentPanel) {
            currentPanel.webview.html = getErrorHtml(errorMsg, currentInterval, timeRange);
        }
    }
}

// ==================== HTML 生成函数 ====================

function getBarColorClass(pct: number): string {
    if (pct >= 90) { return 'bar-red'; }
    if (pct >= 70) { return 'bar-yellow'; }
    return 'bar-green';
}

/** 生成可视化进度条 */
function progressBar(percentage: number, width: number = 12): string {
    const filled = Math.round((percentage / 100) * width);
    const actualFilled = percentage > 0 && filled === 0 ? 1 : filled;
    const empty = width - actualFilled;
    return '█'.repeat(actualFilled) + '░'.repeat(empty);
}

function maskKey(key?: string): string {
    if (!key) { return '未设置'; }
    if (key.length <= 10) { return key.slice(0, 3) + '****'; }
    return key.slice(0, 6) + '****' + key.slice(-4);
}

function wrapHtml(bodyContent: string, currentInterval: number = 10, timeRange: number = 24): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${getCommonStyles()}</style></head><body>
${getToolbarHtml(currentInterval, timeRange)}
${bodyContent}
${getScript()}
</body></html>`;
}

function getCommonStyles(): string {
    return `
  body { background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); font-family:var(--vscode-font-family); padding:20px; margin:0; }
  h1, h2, h3 { color:var(--vscode-editor-foreground); margin-top:24px; }
  .toolbar { display:flex; gap:8px; align-items:center; margin-bottom:16px; padding-bottom:12px; border-bottom:1px solid var(--vscode-panel-border); flex-wrap:wrap; }
  .btn { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:6px 14px; border-radius:3px; cursor:pointer; font-size:13px; }
  .btn:hover { background:var(--vscode-button-hoverBackground); }
  .btn-secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background:var(--vscode-button-secondaryHoverBackground); }
  .interval-group { display:flex; align-items:center; gap:4px; font-size:13px; color:var(--vscode-descriptionForeground); }
  .interval-group select { background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:3px; padding:3px 8px; font-size:13px; }
  .key-display { font-size:13px; color:var(--vscode-descriptionForeground); font-family:var(--vscode-editor-font-family); margin-left:auto; cursor:pointer; user-select:none; }
  .key-display:hover { color:var(--vscode-editor-foreground); }
  .section { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:16px; margin:12px 0; }
  .bar-container { background:var(--vscode-input-background); border-radius:4px; padding:2px; margin:4px 0; }
  .bar-fill { height:18px; border-radius:3px; transition:width 0.3s; }
  .bar-green { background:#4EC9B0; }
  .bar-yellow { background:#CE9178; }
  .bar-red { background:#F44747; }
  table { width:100%; border-collapse:collapse; margin:8px 0; }
  td, th { padding:6px 12px; border-bottom:1px solid var(--vscode-panel-border); text-align:left; }
  .label { color:var(--vscode-descriptionForeground); }
  .value { font-weight:bold; }
  .error { color:#F44747; }
  .spinner { display:inline-block; width:16px; height:16px; border:2px solid var(--vscode-descriptionForeground); border-top-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; vertical-align:middle; margin-right:8px; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .speed-section { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:16px; margin:12px 0; }
  .speed-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
  .speed-models { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:8px 0; }
  .model-tag { display:inline-flex; align-items:center; gap:4px; background:var(--vscode-input-background); border:1px solid var(--vscode-input-border); border-radius:3px; padding:3px 10px; font-size:12px; cursor:pointer; user-select:none; }
  .model-tag.selected { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:var(--vscode-button-background); }
  .model-tag .remove { cursor:pointer; margin-left:4px; opacity:0.7; font-weight:bold; }
  .model-tag .remove:hover { opacity:1; }
  .add-model-row { display:flex; gap:6px; align-items:center; margin:8px 0; }
  .add-model-row input { background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:3px; padding:4px 8px; font-size:12px; width:180px; }
  .speed-progress { color:var(--vscode-descriptionForeground); margin:8px 0; font-size:13px; }
  .speed-bar-outer { background:var(--vscode-input-background); border-radius:4px; height:8px; margin:6px 0; overflow:hidden; }
  .speed-bar-inner { height:100%; background:var(--vscode-button-background); border-radius:4px; transition:width 0.3s; }
  .speed-results { margin-top:12px; }
  .speed-summary td, .speed-summary th { font-size:13px; }
  .fastest { color:#4EC9B0; font-weight:bold; }
  .summary-cards { display:flex; gap:12px; margin-top:8px; }
  .summary-card { flex:1; text-align:center; padding:12px 8px; border:1px solid var(--vscode-panel-border); border-radius:6px; background:var(--vscode-editor-background); }
  .summary-label { font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:4px; }
  .summary-value { font-size:22px; font-weight:bold; }
  .summary-unit { font-size:12px; color:var(--vscode-descriptionForeground); margin-top:2px; }
`;
}

function getToolbarHtml(currentInterval: number, currentTimeRange: number = 24): string {
    const options = INTERVAL_OPTIONS.map(m =>
        `<option value="${m}" ${m === currentInterval ? 'selected' : ''}>${m} 分钟</option>`
    ).join('');

    const timeRangeOptions = TIME_RANGE_OPTIONS.map(h =>
        `<option value="${h}" ${h === currentTimeRange ? 'selected' : ''}>${TIME_RANGE_LABELS[h]}</option>`
    ).join('');

    const maskedKey = maskKey(currentApiKey);
    const fullKey = currentApiKey || '未设置';

    return `<div class="toolbar">
  <button class="btn" onclick="refresh()">🔄 刷新</button>
  <button class="btn btn-secondary" onclick="setKey()">🔑 设置 Key</button>
  <button class="btn btn-secondary" onclick="deleteKey()">🗑️ 删除 Key</button>
  <span class="key-display" onclick="toggleKey()" title="点击切换显示/隐藏 Key">Key: <span id="keyText">${maskedKey}</span><span id="keyIcon"> 👁</span></span>
  <input type="hidden" id="fullKey" value="${fullKey}">
  <input type="hidden" id="maskedKey" value="${maskedKey}">
  <div class="interval-group">
    <span>📅 查询范围:</span>
    <select onchange="changeTimeRange(this.value)">${timeRangeOptions}</select>
  </div>
  <div class="interval-group">
    <span>⏱ 自动刷新:</span>
    <select onchange="changeInterval(this.value)">${options}</select>
  </div>
</div>`;
}

function getScript(): string {
    return `<script>
const vscode = acquireVsCodeApi();
function refresh() { vscode.postMessage({ command: 'refresh' }); }
function setKey() { vscode.postMessage({ command: 'setKey' }); }
function deleteKey() { vscode.postMessage({ command: 'deleteKey' }); }
function changeInterval(val) { vscode.postMessage({ command: 'setInterval', value: parseInt(val) }); }
function changeTimeRange(val) { vscode.postMessage({ command: 'setTimeRange', value: parseInt(val) }); }
let keyVisible = false;
function toggleKey() {
  keyVisible = !keyVisible;
  document.getElementById('keyText').textContent = keyVisible ? document.getElementById('fullKey').value : document.getElementById('maskedKey').value;
  document.getElementById('keyIcon').textContent = keyVisible ? ' 🙈' : ' 👁';
}

// Speed test
function getSelectedModels() {
  return Array.from(document.querySelectorAll('.model-tag.selected')).map(el => el.dataset.model);
}
function toggleModel(el) {
  el.classList.toggle('selected');
  vscode.postMessage({ command: 'toggleSpeedModel', name: el.dataset.model });
}
function removeModel(name) {
  const el = document.querySelector('.model-tag[data-model="' + name + '"]');
  if (el) el.remove();
  vscode.postMessage({ command: 'removeSpeedModel', name: name });
}
function addModel() {
  const input = document.getElementById('newModelInput');
  const name = input.value.trim();
  if (!name) return;
  if (document.querySelector('.model-tag[data-model="' + name + '"]')) { input.value = ''; return; }
  const tags = document.getElementById('modelTags');
  const span = document.createElement('span');
  span.className = 'model-tag selected';
  span.dataset.model = name;
  span.innerHTML = name + ' <span class="remove" onclick="event.stopPropagation();removeModel(\\'' + name + '\\')">×</span>';
  span.onclick = function() { toggleModel(span); };
  tags.appendChild(span);
  input.value = '';
  vscode.postMessage({ command: 'addSpeedModel', name: name });
}
function startSpeedTest() {
  const btn = document.getElementById('speedTestBtn');
  if (btn.textContent.includes('停止')) {
    vscode.postMessage({ command: 'stopSpeedTest' });
    btn.textContent = '▶ 开始测速';
    document.getElementById('speedProgress').style.display = 'none';
    return;
  }
  const models = getSelectedModels();
  if (models.length === 0) { return; }
  const concurrency = parseInt(document.getElementById('concurrencySelect').value) || 1;
  vscode.postMessage({ command: 'startSpeedTest', models, concurrency });
  document.getElementById('speedProgress').style.display = 'block';
  document.getElementById('speedBar').style.width = '0%';
  document.getElementById('speedStatus').textContent = '准备中...';
  document.getElementById('speedResults').innerHTML = '';
  btn.textContent = '⏹ 停止';
}
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'speedProgress') {
    const pct = Math.round(msg.current / msg.total * 100);
    document.getElementById('speedBar').style.width = pct + '%';
    document.getElementById('speedStatus').textContent = '⏳ ' + msg.model + ' / ' + msg.promptName + ' (' + msg.current + '/' + msg.total + ')';
  } else if (msg.command === 'speedResult') {
    // Individual result received, can show live
  } else if (msg.command === 'speedDone') {
    document.getElementById('speedProgress').style.display = 'none';
    document.getElementById('speedTestBtn').textContent = '▶ 开始测速';
    document.getElementById('speedResults').innerHTML = buildResultsHtml(msg.results);
  } else if (msg.command === 'speedError') {
    document.getElementById('speedProgress').style.display = 'none';
    document.getElementById('speedTestBtn').textContent = '▶ 开始测速';
    document.getElementById('speedResults').innerHTML = '<p class="error">测速失败: ' + (msg.error || 'Unknown') + '</p>';
  }
});
function buildResultsHtml(results) {
  if (!results || results.length === 0) return '<p>无结果</p>';
  let html = '<p style="color:var(--vscode-descriptionForeground);font-size:13px;">✅ 测试完成</p>';
  html += '<table class="speed-summary"><tr><th>模型</th><th>场景</th><th>首Token</th><th>总耗时</th><th>生成速度</th><th>字符数</th></tr>';
  for (const r of results) {
    if (r.error) {
      html += '<tr><td>' + r.model + '</td><td>' + r.promptName + '</td><td colspan="4" class="error">ERROR: ' + r.error.slice(0, 60) + '</td></tr>';
    } else {
      html += '<tr><td>' + r.model + '</td><td>' + r.promptName + '</td><td>' + r.ttft + 's</td><td>' + r.totalTime + 's</td><td>' + r.tps + ' c/s</td><td>' + r.charCount + '</td></tr>';
    }
  }
  html += '</table>';
  // Summary
  var stats = {};
  for (var r of results) {
    if (r.error) continue;
    if (!stats[r.model]) stats[r.model] = {ttft:0,total:0,tps:0,n:0};
    stats[r.model].ttft += r.ttft;
    stats[r.model].total += r.totalTime;
    stats[r.model].tps += r.tps;
    stats[r.model].n++;
  }
  var sorted = Object.entries(stats).sort(function(a,b){ return (a[1].total/a[1].n) - (b[1].total/b[1].n); });
  if (sorted.length > 0) {
    html += '<h3>汇总对比</h3>';
    html += '<table class="speed-summary"><tr><th>模型</th><th>平均首Token</th><th>平均总耗时</th><th>平均生成速度</th></tr>';
    for (var i = 0; i < sorted.length; i++) {
      var m = sorted[i][0], s = sorted[i][1];
      var cls = i === 0 ? ' class="fastest"' : '';
      var icon = i === 0 ? '🏆 ' : '   ';
      html += '<tr' + cls + '><td>' + icon + m + '</td><td>' + (s.ttft/s.n).toFixed(3) + 's</td><td>' + (s.total/s.n).toFixed(3) + 's</td><td>' + (s.tps/s.n).toFixed(1) + ' c/s</td></tr>';
    }
    html += '</table>';
  }
  return html;
}
</script>`;
}

function getNoKeyHtml(currentInterval: number = 10): string {
    return wrapHtml(`<div class="section" style="text-align:center; padding:40px 20px;">
  <h2>🔑 未设置 API Key</h2>
  <p style="color:var(--vscode-descriptionForeground); margin:16px 0;">请先设置你的 GLM API Key 以查看使用量数据</p>
  <button class="btn" style="font-size:15px; padding:10px 24px;" onclick="setKey()">🔑 设置 API Key</button>
</div>`, currentInterval, currentTimeRange);
}

function getLoadingHtml(currentInterval: number = 10, timeRange: number = 24): string {
    return wrapHtml(`<p><span class="spinner"></span>正在加载使用量数据...</p>`, currentInterval, timeRange);
}

function getErrorHtml(error: string, currentInterval: number = 10, timeRange: number = 24): string {
    return wrapHtml(`<h2 class="error">查询失败</h2><p>${error}</p>`, currentInterval, timeRange);
}

function generateReportHtml(
    quota: { code: number; msg?: string; data?: { level: string; limits: TokenLimit[] } },
    model: { code: number; msg?: string; data?: any },
    tool: { code: number; msg?: string; data?: any },
    currentInterval: number = 10,
    timeRange: number = 24,
    tokenSummary?: TokenSummary
): string {
    let html = `<h1>GLM API 使用量报告</h1>`;

    // Token 用量概览卡片
    if (tokenSummary) {
        html += `<div class="section token-summary">`;
        html += `<h2>📊 Token 用量概览</h2>`;
        html += `<div class="summary-cards">`;
        const summaryItems = [
            { label: '今日', value: tokenSummary.today },
            { label: '最近 7 天', value: tokenSummary.last7d },
            { label: '最近 30 天', value: tokenSummary.last30d },
        ];
        for (const item of summaryItems) {
            const displayValue = item.value >= 0 ? formatNumber(item.value) : '--';
            html += `<div class="summary-card">
                <div class="summary-label">${item.label}</div>
                <div class="summary-value">${displayValue}</div>
                <div class="summary-unit">Tokens</div>
            </div>`;
        }
        html += `</div></div>`;
    }

    // Quota section
    if (quota.code === 200 && quota.data) {
        const { level, limits } = quota.data;
        html += `<div class="section"><h2>配额限制</h2>`;
        html += `<p><span class="label">账户等级:</span> <span class="value">${level}</span></p>`;

        const tokenLimits = limits.filter(l => l.type === 'TOKENS_LIMIT');
        if (tokenLimits.length > 0) {
            const current = tokenLimits.reduce((a, b) => (a.nextResetTime || 0) < (b.nextResetTime || 0) ? a : b);
            const pct = current.percentage;
            const barColor = getBarColorClass(pct);

            html += `<h3>Token 使用量 (5小时窗口)</h3>`;
            html += `<div class="bar-container"><div class="bar-fill ${barColor}" style="width:${Math.min(pct, 100)}%"></div></div>`;
            html += `<p>${progressBar(pct)} ${pct}% | 重置于 ${formatResetTime(current.nextResetTime)}</p>`;
        }

        for (const limit of limits) {
            if (limit.type === 'TIME_LIMIT') {
                const pct = limit.percentage;
                const barColor = getBarColorClass(pct);
                html += `<h3>MCP 使用量 (月度)</h3>`;
                html += `<div class="bar-container"><div class="bar-fill ${barColor}" style="width:${Math.min(pct, 100)}%"></div></div>`;
                html += `<p>${progressBar(pct)} ${pct}%</p>`;
                if (limit.usageDetails) {
                    html += `<table><tr><th>工具</th><th>使用次数</th></tr>`;
                    for (const d of limit.usageDetails) {
                        if (d.usage > 0) {
                            html += `<tr><td>${d.modelCode}</td><td>${formatNumber(d.usage)}</td></tr>`;
                        }
                    }
                    html += `</table>`;
                }
            }
        }
        html += `</div>`;
    } else {
        html += `<div class="section"><p class="error">配额查询失败: ${quota.msg || 'Unknown'}</p></div>`;
    }

    // Model usage section
    if (model.code === 200 && model.data) {
        const { totalUsage } = model.data;
        html += `<div class="section"><h2>模型使用量</h2>`;
        html += `<table>
          <tr><td class="label">总调用次数</td><td class="value">${formatNumber(totalUsage.totalModelCallCount)} 次</td></tr>
          <tr><td class="label">总Token消耗</td><td class="value">${formatNumber(totalUsage.totalTokensUsage)}</td></tr>
        </table></div>`;
    } else {
        html += `<div class="section"><p class="error">模型使用量查询失败: ${model.msg || 'Unknown'}</p></div>`;
    }

    // Tool usage section
    if (tool.code === 200 && tool.data) {
        const { totalUsage } = tool.data;
        html += `<div class="section"><h2>工具使用量</h2>`;
        html += `<table>
          <tr><td class="label">网络搜索</td><td class="value">${formatNumber(totalUsage.totalNetworkSearchCount)} 次</td></tr>
          <tr><td class="label">网页读取</td><td class="value">${formatNumber(totalUsage.totalWebReadMcpCount)} 次</td></tr>
          <tr><td class="label">ZRead 工具</td><td class="value">${formatNumber(totalUsage.totalZreadMcpCount)} 次</td></tr>
        </table>`;

        if (totalUsage.toolDetails && totalUsage.toolDetails.length > 0) {
            html += `<h3>工具明细</h3><table><tr><th>工具</th><th>使用次数</th></tr>`;
            for (const t of totalUsage.toolDetails) {
                html += `<tr><td>${t.modelName}</td><td>${formatNumber(t.totalUsageCount)}</td></tr>`;
            }
            html += `</table>`;
        }
        html += `</div>`;
    } else {
        html += `<div class="section"><p class="error">工具使用量查询失败: ${tool.msg || 'Unknown'}</p></div>`;
    }

    // Speed test section
    html += generateSpeedTestHtml();

    return wrapHtml(html, currentInterval, timeRange);
}

function generateSpeedTestHtml(): string {
    const models = speedTestModels.length > 0 ? speedTestModels : DEFAULT_MODELS.map(name => ({ name, selected: true }));
    const cachedResults = lastSpeedResults;
    const testing = isSpeedTesting;
    let html = `<div class="speed-section">`;
    html += `<div class="speed-header"><h2 style="margin:0">🚀 模型测速</h2>`;
    html += `<button class="btn" id="speedTestBtn" onclick="startSpeedTest()">${testing ? '⏹ 停止' : '▶ 开始测速'}</button></div>`;

    // Model selection
    html += `<p style="color:var(--vscode-descriptionForeground); font-size:13px; margin-bottom:4px;">选择模型:</p>`;
    html += `<div class="speed-models" id="modelTags">`;
    for (const m of models) {
        const cls = m.selected ? 'model-tag selected' : 'model-tag';
        html += `<span class="${cls}" data-model="${m.name}" onclick="toggleModel(this)">${m.name} <span class="remove" onclick="event.stopPropagation();removeModel('${m.name}')">×</span></span>`;
    }
    html += `</div>`;
    html += `<div class="add-model-row">`;
    html += `<input type="text" id="newModelInput" placeholder="输入模型名称" onkeydown="if(event.key==='Enter')addModel()">`;
    html += `<button class="btn btn-secondary" onclick="addModel()" style="font-size:12px; padding:4px 10px;">+ 添加</button>`;
    html += `</div>`;

    // Test prompts info
    html += `<p style="color:var(--vscode-descriptionForeground); font-size:12px; margin:4px 0;">测试场景: 代码生成、逻辑推理、长文本生成</p>`;

    // Concurrency selector
    const concurrencyOptions = CONCURRENCY_OPTIONS.map(n => `<option value="${n}">${n} 线程</option>`).join('');
    html += `<div class="interval-group" style="margin:6px 0;"><span>🔀 并发线程:</span><select id="concurrencySelect">${concurrencyOptions}</select></div>`;

    // Progress area
    const sp = speedTestProgress;
    const pct = sp.total > 0 ? Math.round(sp.current / sp.total * 100) : 0;
    const statusText = testing ? `⏳ ${sp.model} / ${sp.promptName} (${sp.current}/${sp.total})` : '';
    html += `<div id="speedProgress" style="display:${testing ? 'block' : 'none'}">`;
    html += `<div class="speed-bar-outer"><div class="speed-bar-inner" id="speedBar" style="width:${pct}%"></div></div>`;
    html += `<p class="speed-progress" id="speedStatus">${statusText}</p>`;
    html += `</div>`;

    // Results area
    html += `<div class="speed-results" id="speedResults">`;
    if (cachedResults.length > 0 && !testing) {
        html += buildSpeedResultsHtml(cachedResults);
    }
    html += `</div>`;

    html += `</div>`;
    return html;
}

function buildSpeedResultsHtml(results: SpeedTestResult[]): string {
    let html = `<p style="color:var(--vscode-descriptionForeground); font-size:13px;">✅ 测试完成</p>`;

    // Detail table
    html += `<table class="speed-summary"><tr><th>模型</th><th>场景</th><th>首Token</th><th>总耗时</th><th>生成速度</th><th>字符数</th></tr>`;
    for (const r of results) {
        if (r.error) {
            html += `<tr><td>${r.model}</td><td>${r.promptName}</td><td colspan="4" class="error">ERROR: ${r.error.slice(0, 60)}</td></tr>`;
        } else {
            html += `<tr><td>${r.model}</td><td>${r.promptName}</td><td>${r.ttft}s</td><td>${r.totalTime}s</td><td>${r.tps} c/s</td><td>${r.charCount}</td></tr>`;
        }
    }
    html += `</table>`;

    // Summary
    const modelStats: Record<string, { ttftSum: number; totalSum: number; tpsSum: number; count: number }> = {};
    for (const r of results) {
        if (r.error) { continue; }
        if (!modelStats[r.model]) { modelStats[r.model] = { ttftSum: 0, totalSum: 0, tpsSum: 0, count: 0 }; }
        modelStats[r.model].ttftSum += r.ttft;
        modelStats[r.model].totalSum += r.totalTime;
        modelStats[r.model].tpsSum += r.tps;
        modelStats[r.model].count++;
    }

    const sorted = Object.entries(modelStats).sort((a, b) => (a[1].totalSum / a[1].count) - (b[1].totalSum / b[1].count));
    if (sorted.length > 0) {
        html += `<h3>汇总对比</h3>`;
        html += `<table class="speed-summary"><tr><th>模型</th><th>平均首Token</th><th>平均总耗时</th><th>平均生成速度</th></tr>`;
        sorted.forEach(([model, s], i) => {
            const cls = i === 0 ? ' class="fastest"' : '';
            const icon = i === 0 ? '🏆 ' : '   ';
            html += `<tr${cls}><td>${icon}${model}</td><td>${(s.ttftSum / s.count).toFixed(3)}s</td><td>${(s.totalSum / s.count).toFixed(3)}s</td><td>${(s.tpsSum / s.count).toFixed(1)} c/s</td></tr>`;
        });
        html += `</table>`;
    }

    return html;
}

/** 两位数补零 */
function pad2(n: number): string {
    return n.toString().padStart(2, '0');
}

/** 格式化日期为 YYYY-MM-DD HH:mm:ss */
function formatDateTime(date: Date): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 获取今日零点的时间字符串 */
function getTodayStart(): string {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} 00:00:00`;
}

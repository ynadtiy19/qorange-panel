'use strict';

const $ = selector => document.querySelector(selector);
const loginView = $('#login');
const dashboard = $('#dashboard');
const notice = $('#notice');
const serviceDialog = $('#service-dialog');
const logsDialog = $('#logs-dialog');
const environmentDialog = $('#environment-dialog');
const variableDialog = $('#variable-dialog');
let csrfToken = '';
let editServiceId = null;
let environmentService = null;
let editVariableKey = null;
let repositories = [];
let githubAccounts = [];
let githubClientConfigured = false;
let availableBranches = [];
let branchRequestId = 0;
let devicePollTimer = null;

async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
    }
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
}

function showNotice(message, isError = false) {
    notice.textContent = message;
    notice.classList.toggle('error-notice', isError);
    notice.hidden = !message;
}

function parseEnvText(text) {
    const entries = [];
    const errors = [];
    const keys = new Set();
    text.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim() || line.trimStart().startsWith('#')) return;
        const separator = line.indexOf('=');
        if (separator < 1) {
            errors.push(`第 ${index + 1} 行：请使用 KEY=VALUE 格式。`);
            return;
        }
        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            errors.push(`第 ${index + 1} 行：变量名称无效。`);
            return;
        }
        if (keys.has(key)) {
            errors.push(`第 ${index + 1} 行：变量名称重复。`);
            return;
        }
        keys.add(key);
        entries.push({ key, value: line.slice(separator + 1) });
    });
    return { entries, errors };
}

function renderEnvRows() {
    const result = parseEnvText($('#env-text').value);
    const rows = $('#env-rows');
    rows.replaceChildren();
    $('#env-error').textContent = result.errors.join(' ');
    if (editServiceId) return;
    for (const [index, entry] of result.entries.entries()) {
        const row = document.createElement('div');
        row.className = 'env-row';
        const key = document.createElement('input');
        key.value = entry.key;
        key.setAttribute('aria-label', `第 ${index + 1} 个环境变量名称`);
        const value = document.createElement('input');
        value.value = entry.value;
        value.type = 'text';
        value.setAttribute('aria-label', `第 ${index + 1} 个环境变量值`);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `移除 ${entry.key}`);
        const updateText = () => {
            const next = parseEnvText($('#env-text').value).entries;
            if (next[index]) next[index] = { key: key.value, value: value.value };
            $('#env-text').value = next.map(item => `${item.key}=${item.value}`).join('\n');
            renderEnvRows();
        };
        key.addEventListener('change', updateText);
        value.addEventListener('change', updateText);
        remove.addEventListener('click', () => {
            const next = parseEnvText($('#env-text').value).entries;
            next.splice(index, 1);
            $('#env-text').value = next.map(item => `${item.key}=${item.value}`).join('\n');
            renderEnvRows();
        });
        row.append(key, value, remove);
        rows.append(row);
    }
}

function resetServiceDialog() {
    editServiceId = null;
    branchRequestId += 1;
    availableBranches = [];
    $('#service-form').reset();
    $('#env-text').value = '';
    $('#env-rows').replaceChildren();
    $('#env-rows').hidden = false;
    $('#env-error').textContent = '';
    $('#service-fields').hidden = false;
    $('#repo').required = true;
    $('#import-account').value = '';
    $('#public-repo').value = '';
    $('#branch-search').value = '';
    $('#branch-search').disabled = true;
    $('#branch').replaceChildren(new Option('先选择仓库', ''));
    $('#branch').disabled = true;
    $('#branch-status').textContent = '';
    $('#repo').replaceChildren(new Option('先选择 GitHub 账号', ''));
    $('#repo-select-label').hidden = false;
    $('#public-repo-label').hidden = true;
    $('#env-hint').textContent = '变量将保存在服务器的私有文件中，保存后不会再次显示。';
    $('#service-dialog-title').textContent = '导入仓库';
    $('#service-dialog-description').textContent = '选择访问账号和仓库，再从 GitHub 获取并选择实际部署的分支。';
    $('#save-service').textContent = '保存服务';
}

function renderGithubAccounts() {
    const list = $('#github-account-list');
    list.replaceChildren();
    $('#github-account-empty').hidden = githubAccounts.length > 0;
    for (const account of githubAccounts) {
        const row = document.createElement('div');
        row.className = 'environment-row';
        const identity = document.createElement('strong');
        identity.textContent = `${account.login}${account.name ? ` · ${account.name}` : ''}`;
        const disconnect = document.createElement('button');
        disconnect.type = 'button';
        disconnect.className = 'button danger';
        disconnect.textContent = '断开连接';
        disconnect.addEventListener('click', async () => {
            if (!window.confirm(`断开 ${account.login}？已保存的服务将保留该账号关联，但需要重新选择账号才能部署。`)) return;
            disconnect.disabled = true;
            try {
                await request(`/api/github/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
                await loadGithubAccounts();
                showNotice(`已断开 GitHub 账号 ${account.login}。`);
            } catch (error) {
                showNotice(error.message, true);
            } finally {
                disconnect.disabled = false;
            }
        });
        row.append(identity, disconnect);
        list.append(row);
    }
    const selector = $('#import-account');
    const prior = selector.value;
    selector.replaceChildren(new Option('未连接账号（仅公开仓库）', ''));
    for (const account of githubAccounts) selector.add(new Option(account.login, account.id));
    selector.value = githubAccounts.some(account => account.id === prior) ? prior : '';
}

async function loadGithubAccounts() {
    try {
        const data = await request('/api/github/accounts');
        githubAccounts = data.accounts || [];
        githubClientConfigured = data.clientConfigured;
        $('#connect-github').disabled = !githubClientConfigured;
        $('#github-config-notice').hidden = githubClientConfigured;
        renderGithubAccounts();
    } catch (error) {
        showNotice(error.message, true);
    }
}

async function loadRepositories() {
    const select = $('#repo');
    const accountId = $('#import-account').value;
    branchRequestId += 1;
    availableBranches = [];
    $('#branch').replaceChildren(new Option('先选择仓库', ''));
    $('#branch').disabled = true;
    $('#branch-search').disabled = true;
    $('#branch-status').textContent = '';
    if (!accountId) {
        repositories = [];
        $('#repo').required = false;
        $('#repo-select-label').hidden = true;
        $('#public-repo-label').hidden = false;
        $('#public-repo').required = true;
        return;
    }
    $('#repo').required = true;
    $('#repo-select-label').hidden = false;
    $('#public-repo-label').hidden = true;
    $('#public-repo').required = false;
    select.disabled = true;
    repositories = [];
    select.replaceChildren(new Option('正在加载仓库…', ''));
    try {
        const data = await request(`/api/github/accounts/${encodeURIComponent(accountId)}/repositories`);
        repositories = data.repos || [];
        select.replaceChildren(new Option('请选择仓库', ''));
        repositories.forEach((repo, index) => {
            select.add(new Option(`${repo.isPrivate ? '🔒' : '🌐'} ${repo.nameWithOwner}`, String(index)));
        });
        select.disabled = false;
        if (!repositories.length) $('#branch-status').textContent = '该账号未找到可访问的仓库。';
    } catch (error) {
        select.replaceChildren(new Option('无法加载仓库', ''));
        $('#branch-status').textContent = error.message;
        showNotice(error.message, true);
    }
}

async function loadBranches(repo, defaultBranch = '') {
    const requestId = ++branchRequestId;
    const accountId = $('#import-account').value;
    const branch = $('#branch');
    branch.disabled = true;
    branch.replaceChildren(new Option('正在加载分支…', ''));
    $('#branch-search').disabled = true;
    availableBranches = [];
    $('#branch-status').textContent = '正在从 GitHub 加载分支…';
    $('#branch-search').value = '';
    try {
        const params = new URLSearchParams({ repo });
        if (accountId) params.set('accountId', accountId);
        const data = await request(`/api/github/branches?${params}`);
        if (requestId !== branchRequestId) return;
        availableBranches = data.branches || [];
        renderBranchOptions();
        $('#branch-search').disabled = false;
        if (!availableBranches.length) {
            $('#branch-status').textContent = '此仓库没有可用分支。';
            return;
        }
        branch.disabled = false;
        branch.value = availableBranches.includes(defaultBranch) ? defaultBranch : availableBranches[0];
        $('#branch-status').textContent = `${availableBranches.length} 个分支可供选择。`;
    } catch (error) {
        if (requestId !== branchRequestId) return;
        availableBranches = [];
        branch.replaceChildren(new Option('无法加载分支', ''));
        $('#branch-search').disabled = false;
        $('#branch-status').textContent = `加载分支失败：${error.message}`;
    }
}

function renderBranchOptions() {
    const branch = $('#branch');
    const selected = branch.value;
    const query = $('#branch-search').value.trim().toLowerCase();
    const matches = availableBranches.filter(name => name.toLowerCase().includes(query));
    branch.replaceChildren(new Option(matches.length ? '选择分支' : '没有匹配的分支', ''));
    matches.forEach(name => branch.add(new Option(name, name)));
    if (matches.includes(selected)) branch.value = selected;
    else if (matches.length === 1) branch.value = matches[0];
    branch.disabled = availableBranches.length === 0 || matches.length === 0;
}

async function pollGithubDevice(deviceId, interval) {
    try {
        const result = await request(`/api/github/device/${encodeURIComponent(deviceId)}/poll`, {
            method: 'POST',
            body: '{}'
        });
        if (result.status === 'authorized') {
            $('#github-device-status').textContent = `已连接 ${result.account.login}。`;
            $('#github-user-code').textContent = '';
            await loadGithubAccounts();
            $('#connect-github').disabled = !githubClientConfigured;
            return;
        }
        if (result.status === 'expired' || result.status === 'denied') {
            $('#github-device-status').textContent = result.status === 'denied'
                ? 'GitHub 账号授权已拒绝。'
                : '授权代码已过期，请重新连接。';
            $('#github-user-code').textContent = '';
            $('#connect-github').disabled = !githubClientConfigured;
            return;
        }
        const wait = Math.max(interval, result.interval || interval, result.retryAfter || 0);
        $('#github-device-status').textContent = `等待 GitHub 确认；${wait} 秒后检查。`;
        devicePollTimer = setTimeout(() => pollGithubDevice(deviceId, wait), wait * 1000);
    } catch (error) {
        $('#github-device-status').textContent = error.message;
        $('#connect-github').disabled = !githubClientConfigured;
    }
}

async function loadSystem() {
    try {
        const data = await request('/api/system');
        renderSystem(data);
        renderServices(data.services);
    } catch (error) {
        showNotice(error.message, true);
    }
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '未知';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds % 86400 / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return days ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

function setProgress(id, percent) {
    const fill = $(`#${id}`);
    fill.style.width = `${Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0}%`;
}

function renderSystem(data) {
    const system = data.system;
    const cpu = system.cpu;
    const memory = system.memory;
    const disk = system.disk;
    $('#hostname').textContent = system.hostname || '未知主机';
    $('#os-summary').textContent = `${system.platform || '未知系统'} · ${system.architecture || '未知架构'}`;
    $('#panel-status').textContent = data.panel.status === 'running' ? '面板运行中' : `面板${data.panel.status}`;
    $('#panel-health').textContent = data.panel.status === 'running' ? '运行正常' : data.panel.status;
    $('#uptime').textContent = `运行时间 ${formatDuration(system.uptimeSeconds)}`;

    $('#cpu-usage').textContent = cpu.usagePercent === null ? '采样中' : `${cpu.usagePercent}%`;
    $('#cpu-detail').textContent = `${cpu.model} · ${cpu.cores} 核`;
    $('#cpu-load').textContent = `系统负载 ${cpu.loadAverage.map(value => Number(value).toFixed(2)).join(' / ')}`;
    setProgress('cpu-progress', cpu.usagePercent);

    $('#memory-usage').textContent = memory.percent === null ? '未知' : `${memory.percent}%`;
    $('#memory-detail').textContent = `${memory.used} / ${memory.total}`;
    setProgress('memory-progress', memory.percent);

    $('#disk-usage').textContent = disk.percent === null ? '未知' : `${disk.percent}%`;
    $('#disk-detail').textContent = disk.available ? `${disk.used} / ${disk.total}` : disk.error;
    setProgress('disk-progress', disk.percent);

    const platformNames = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', freebsd: 'FreeBSD' };
    $('#os-platform').textContent = `${platformNames[system.platform] || system.platform} ${system.osRelease}`;
    $('#kernel-version').textContent = system.osRelease || '未知';
    $('#architecture').textContent = system.architecture || '未知';
    $('#cpu-model').textContent = cpu.model || '未知';
    $('#cpu-cores').textContent = `${cpu.cores} 核`;
    $('#ipv4-addresses').textContent = system.ipv4Addresses.length ? system.ipv4Addresses.join('、') : '未检测到';

    const dockerOnline = data.docker.status === 'running';
    $('#docker-status').textContent = dockerOnline ? '运行中' : data.docker.error || '未知';
    $('#docker-version').textContent = data.docker.version || '未知';
    $('#docker-dot').classList.toggle('online', dockerOnline);
    renderManagedContainers(data.managedContainers, data.docker.status);
}

function renderManagedContainers(containers, dockerStatus) {
    const list = $('#managed-containers');
    list.replaceChildren();
    const empty = $('#empty-managed');
    empty.hidden = containers.length > 0;
    empty.textContent = dockerStatus === 'running'
        ? '尚未检测到 QOrange 托管容器。'
        : 'Docker 状态未知，暂时无法读取托管容器。';
    for (const container of containers) {
        const row = document.createElement('article');
        row.className = 'managed-row';
        const identity = document.createElement('div');
        identity.className = 'managed-identity';
        const name = document.createElement('strong');
        name.textContent = container.name;
        const status = document.createElement('span');
        status.className = `status ${container.running ? 'running' : 'stopped'}`;
        status.textContent = container.status;
        identity.append(name, status);
        const ports = document.createElement('code');
        ports.textContent = container.ports || '未映射';
        row.append(identity, ports);
        list.append(row);
    }
}

function selectView(view) {
    const selectedView = view === 'projects' ? 'projects' : 'server';
    $('#server-view').hidden = selectedView !== 'server';
    $('#projects-view').hidden = selectedView !== 'projects';
    document.querySelectorAll('.nav-tab').forEach(tab => {
        const selected = tab.dataset.view === selectedView;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-selected', String(selected));
    });
}

function actionButton(label, action, service, className = 'button subtle') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', () => runAction(action, service));
    return button;
}

function renderServices(services) {
    const list = $('#services');
    list.replaceChildren();
    $('#empty-services').hidden = services.length > 0;
    for (const service of services) {
        const card = document.createElement('article');
        card.className = 'service-card';
        const top = document.createElement('div');
        top.className = 'service-top';
        const info = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'service-title';
        const name = document.createElement('h3');
        name.textContent = service.name;
        const status = document.createElement('span');
        status.className = `status ${service.status}`;
        const labels = {
            running: '运行中',
            stopped: '已停止',
            uninstalled: '未部署',
            deploying: '部署中',
            failed: '部署失败',
            missing: '容器不存在',
            unknown: '状态未知'
        };
        status.textContent = labels[service.status] || service.statusRaw;
        title.append(name, status);
        if (['running', 'stopped'].includes(service.status) && service.deploymentStatus === 'failed') {
            const failed = document.createElement('span');
            failed.className = 'status failed';
            failed.textContent = '最近部署失败';
            title.append(failed);
        }
        const meta = document.createElement('div');
        meta.className = 'service-meta';
        const accountLabel = service.githubAccountId
            ? service.githubAccountLogin || 'GitHub 账号已断开'
            : '公开仓库';
        meta.textContent = `${service.id} · ${service.repo} · ${service.branch} · ${accountLabel}${service.port ? ` · 端口 ${service.port}` : ''}${service.containerPorts ? ` · Docker ${service.containerPorts}` : ''}`;
        const envMeta = document.createElement('div');
        envMeta.className = 'service-meta';
        envMeta.textContent = service.environmentConfigured
            ? `环境变量：已保存（${service.environmentVariableCount} 项）`
            : '环境变量：未配置';
        info.append(title, meta, envMeta);
        if (service.lastSuccessfulDeploymentAt) {
            const lastSuccess = document.createElement('div');
            lastSuccess.className = 'service-meta';
            lastSuccess.textContent = `上次成功部署：${new Date(service.lastSuccessfulDeploymentAt).toLocaleString()}`;
            info.append(lastSuccess);
        }
        const actions = document.createElement('div');
        actions.className = 'service-actions';
        const buildButton = actionButton(service.status === 'deploying' ? '部署中…' : '构建并部署', 'build', service, 'button primary');
        buildButton.disabled = service.status === 'deploying';
        actions.append(buildButton);
        if (service.status === 'running') {
            actions.append(actionButton('重启', 'restart', service), actionButton('停止', 'stop', service));
        } else if (service.status === 'stopped') {
            actions.append(actionButton('启动', 'start', service));
        }
        actions.append(actionButton('环境变量', 'environment', service));
        if (service.status !== 'uninstalled') actions.append(actionButton('日志', 'logs', service));
        const remove = actionButton('删除', 'delete', service, 'button danger');
        actions.append(remove);
        top.append(info, actions);
        card.append(top);
        list.append(card);
    }
}

async function runAction(action, service) {
    if (action === 'environment') {
        environmentService = service;
        $('#environment-title').textContent = `环境变量 · ${service.name}`;
        await loadEnvironmentVariables();
        if (environmentService === service) environmentDialog.showModal();
        return;
    }
    if (action === 'delete' && !window.confirm(`确定删除 ${service.name} 吗？其托管容器和私有环境变量文件将被移除，仓库源代码和镜像不会受影响。`)) return;
    if (action === 'logs') {
        $('#logs-title').textContent = `日志 · ${service.name}`;
        $('#logs-content').textContent = '正在加载…';
        logsDialog.showModal();
    } else {
        const actionName = { build: '部署', restart: '重启', stop: '停止', start: '启动', delete: '删除' }[action] || action;
        showNotice(`正在为 ${service.name} 执行${actionName}操作…`);
    }
    try {
        const result = await request(`/api/services/${encodeURIComponent(service.id)}/action`, {
            method: 'POST',
            body: JSON.stringify({ action })
        });
        if (action === 'logs') $('#logs-content').textContent = result.logs || '没有日志输出。';
        else showNotice(action === 'delete' ? `已删除 ${service.name}。` : result.logs || '操作已完成。');
        await loadSystem();
    } catch (error) {
        if (action === 'logs') $('#logs-content').textContent = error.message;
        else showNotice(error.message, true);
        if (action === 'build') await loadSystem();
    }
}

async function loadEnvironmentVariables() {
    if (!environmentService) return;
    try {
        const result = await request(`/api/services/${encodeURIComponent(environmentService.id)}/env`);
        const list = $('#environment-variables');
        list.replaceChildren();
        $('#environment-empty').hidden = result.variables.length > 0;
        for (const variable of result.variables) {
            const service = environmentService;
            const row = document.createElement('div');
            row.className = 'environment-row';
            row.setAttribute('role', 'row');
            const key = document.createElement('code');
            key.textContent = variable.key;
            key.setAttribute('role', 'cell');
            const value = document.createElement('span');
            value.textContent = variable.valuePresent ? variable.maskedValue : '（空值）';
            value.setAttribute('role', 'cell');
            const privacy = document.createElement('span');
            privacy.className = 'privacy-label';
            privacy.textContent = '私有';
            privacy.setAttribute('role', 'cell');
            const actions = document.createElement('div');
            actions.className = 'environment-actions';
            actions.setAttribute('role', 'cell');
            const reveal = document.createElement('button');
            reveal.type = 'button';
            reveal.className = 'button subtle';
            reveal.textContent = '显示原值';
            reveal.addEventListener('click', async () => {
                if (environmentService !== service) return;
                if (reveal.textContent === '隐藏') {
                    value.textContent = variable.valuePresent ? variable.maskedValue : '（空值）';
                    reveal.textContent = '显示原值';
                    return;
                }
                reveal.disabled = true;
                try {
                    const result = await request(`/api/services/${encodeURIComponent(service.id)}/env/reveal`, {
                        method: 'POST',
                        body: JSON.stringify({ key: variable.key })
                    });
                    if (environmentService !== service) return;
                    value.textContent = result.value || '（空值）';
                    reveal.textContent = '隐藏';
                } catch (error) {
                    showNotice(error.message, true);
                } finally {
                    reveal.disabled = false;
                }
            });
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'button subtle';
            edit.textContent = '更新值';
            edit.addEventListener('click', () => openVariableDialog(variable.key));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'button danger';
            remove.textContent = '删除';
            remove.addEventListener('click', () => deleteEnvironmentVariable(variable.key));
            actions.append(reveal, edit, remove);
            row.append(key, value, privacy, actions);
            list.append(row);
        }
    } catch (error) {
        showNotice(error.message, true);
        environmentDialog.close();
    }
}

function clearEnvironmentDialog() {
    $('#environment-variables').replaceChildren();
    $('#environment-empty').hidden = false;
    environmentService = null;
}

async function openRawEnvironmentEditor() {
    if (!environmentService) return;
    const service = environmentService;
    const button = $('#edit-raw-environment');
    button.disabled = true;
    try {
        const result = await request(`/api/services/${encodeURIComponent(service.id)}/env/export`, {
            method: 'POST',
            body: '{}'
        });
        if (environmentService !== service) return;
        resetServiceDialog();
        editServiceId = service.id;
        $('#service-fields').hidden = true;
        $('#repo').required = false;
        $('#service-dialog-title').textContent = `编辑原始环境变量 · ${service.name}`;
        $('#service-dialog-description').textContent = '原始环境变量包含明文。编辑不会自动保存，请确认后手动保存。';
        $('#env-hint').textContent = '仅在可信设备上查看或编辑；关闭窗口后文本会清除。保存后需重新构建并部署。';
        $('#save-service').textContent = '保存环境变量';
        $('#env-rows').hidden = true;
        $('#env-text').value = result.env;
        $('#env-error').textContent = '';
        environmentDialog.close();
        serviceDialog.showModal();
        $('#env-text').focus();
    } catch (error) {
        showNotice(error.message, true);
    } finally {
        button.disabled = false;
    }
}

async function copyAllEnvironmentVariables() {
    if (!environmentService) return;
    if (!window.confirm('全部环境变量原值将复制到剪贴板。请确认当前设备可信，且剪贴板内容不会被他人读取。继续？')) return;
    if (!window.isSecureContext || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        showNotice('复制需要安全上下文和 Clipboard API；请通过 HTTPS 或 SSH 隧道访问。', true);
        return;
    }
    const service = environmentService;
    let envText = '';
    const button = $('#copy-all-environment');
    button.disabled = true;
    try {
        const result = await request(`/api/services/${encodeURIComponent(service.id)}/env/export`, {
            method: 'POST',
            body: '{}'
        });
        if (environmentService !== service) return;
        envText = result.env;
        await navigator.clipboard.writeText(envText);
        showNotice('全部环境变量已复制到剪贴板。');
    } catch (error) {
        showNotice(`复制环境变量失败：${error.message}`, true);
    } finally {
        envText = '';
        button.disabled = false;
    }
}

function openVariableDialog(key = null) {
    editVariableKey = key;
    $('#variable-form').reset();
    $('#variable-error').textContent = '';
    $('#variable-dialog-title').textContent = key ? `更新变量 · ${key}` : '添加环境变量';
    $('#variable-dialog-description').textContent = key
        ? '当前值不会显示。输入新值后保存；如需保留当前值，请取消。'
        : '值不会预填或在保存后再次显示。';
    $('#variable-key').disabled = Boolean(key);
    $('#variable-key').value = key || '';
    $('#variable-value').value = '';
    variableDialog.showModal();
}

async function deleteEnvironmentVariable(key) {
    if (!environmentService || !window.confirm(`确定删除环境变量 ${key} 吗？`)) return;
    try {
        await request(`/api/services/${encodeURIComponent(environmentService.id)}/env/${encodeURIComponent(key)}`, {
            method: 'DELETE'
        });
        showNotice(`已删除环境变量 ${key}；如需应用到运行中的服务，请重新构建并部署。`);
        await Promise.all([loadEnvironmentVariables(), loadSystem()]);
    } catch (error) {
        showNotice(error.message, true);
    }
}

$('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#login-error').textContent = '';
    try {
        const result = await request('/api/login', {
            method: 'POST',
            body: JSON.stringify({ password: $('#password').value })
        });
        csrfToken = result.csrfToken;
        $('#password').value = '';
        showDashboard();
    } catch (error) {
        $('#login-error').textContent = error.message;
    }
});

$('#logout').addEventListener('click', async () => {
    try { await request('/api/logout', { method: 'POST', body: '{}' }); } catch { /* Clear the view even if the server has restarted. */ }
    csrfToken = '';
    serviceDialog.close();
    variableDialog.close();
    environmentDialog.close();
    logsDialog.close();
    $('#logs-content').textContent = '';
    dashboard.hidden = true;
    loginView.hidden = false;
});

$('#add-service').addEventListener('click', async () => {
    resetServiceDialog();
    serviceDialog.showModal();
    await loadGithubAccounts();
    await loadRepositories();
});

$('#import-account').addEventListener('change', loadRepositories);

async function repositorySelected(repo, defaultBranch = '') {
    if (!repo) return;
    const repoName = typeof repo === 'string' ? repo : repo.nameWithOwner;
    const name = typeof repo === 'string' ? repoName.split('/').pop() : repo.name;
    $('#name').value = name;
    $('#id').value = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 63);
    await loadBranches(repoName, defaultBranch);
}

$('#repo').addEventListener('change', async () => {
    if (!$('#repo').value) {
        branchRequestId += 1;
        availableBranches = [];
        $('#branch').replaceChildren(new Option('先选择仓库', ''));
        $('#branch').disabled = true;
        $('#branch-status').textContent = '';
        return;
    }
    const repo = repositories[Number($('#repo').value)];
    if (!repo) return;
    await repositorySelected(repo, repo.defaultBranch);
});

$('#public-repo').addEventListener('change', () => {
    const repo = $('#public-repo').value.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        branchRequestId += 1;
        availableBranches = [];
        $('#branch-status').textContent = '请按 owner/repository 格式输入公开仓库。';
        $('#branch').replaceChildren(new Option('仓库名称无效', ''));
        $('#branch').disabled = true;
        $('#branch-search').disabled = true;
        return;
    }
    repositorySelected(repo);
});

$('#branch-search').addEventListener('input', renderBranchOptions);

$('#env-text').addEventListener('input', renderEnvRows);

$('#service-form').addEventListener('submit', async event => {
    event.preventDefault();
    const parsed = parseEnvText($('#env-text').value);
    if (parsed.errors.length) {
        $('#env-error').textContent = parsed.errors.join(' ');
        return;
    }
    const env = $('#env-text').value;
    const saveButton = $('#save-service');
    saveButton.disabled = true;
    try {
        if (editServiceId) {
            await request(`/api/services/${encodeURIComponent(editServiceId)}/env`, { method: 'PUT', body: JSON.stringify({ env }) });
            showNotice('环境变量已替换；如需应用到运行中的服务，请重新构建并部署。');
        } else {
            const repo = repositories[Number($('#repo').value)];
            const accountId = $('#import-account').value || null;
            const repoName = accountId ? repo && repo.nameWithOwner : $('#public-repo').value.trim();
            if (!repoName) throw new Error('请选择或输入一个 GitHub 仓库。');
            if (!$('#branch').value) throw new Error('请选择 GitHub 返回的一个有效分支。');
            await request('/api/services', {
                method: 'POST',
                body: JSON.stringify({
                    id: $('#id').value,
                    name: $('#name').value,
                    repo: repoName,
                    branch: $('#branch').value,
                    githubAccountId: accountId,
                    port: $('#port').value,
                    env
                })
            });

            $('#github-accounts-button').addEventListener('click', async () => {
                $('#github-device-panel').hidden = true;
                $('#github-device-status').textContent = '';
                await loadGithubAccounts();
                $('#github-dialog').showModal();
            });

            $('#connect-github').addEventListener('click', async () => {
                const button = $('#connect-github');
                button.disabled = true;
                $('#github-device-status').textContent = '正在向 GitHub 请求设备代码…';
                try {
                    const authorization = await request('/api/github/device', { method: 'POST', body: '{}' });
                    const link = $('#github-verification-link');
                    link.href = authorization.verificationUri;
                    $('#github-user-code').textContent = authorization.userCode;
                    $('#github-device-panel').hidden = false;
                    $('#github-device-status').textContent = `代码有效约 ${Math.ceil(authorization.expiresIn / 60)} 分钟。`;
                    if (devicePollTimer) clearTimeout(devicePollTimer);
                    devicePollTimer = setTimeout(
                        () => pollGithubDevice(authorization.deviceId, authorization.interval),
                        authorization.interval * 1000
                    );
                } catch (error) {
                    $('#github-device-status').textContent = error.message;
                } finally {
                    if ($('#github-device-panel').hidden) button.disabled = !githubClientConfigured;
                }
            });
            showNotice('服务已保存。准备就绪后即可构建并部署。');
        }
        $('#env-text').value = '';
        $('#env-rows').replaceChildren();
        serviceDialog.close();
        await loadSystem();
    } catch (error) {
        showNotice(error.message, true);
    } finally {
        saveButton.disabled = false;
    }
});

$('#add-environment-variable').addEventListener('click', () => openVariableDialog());

$('#edit-raw-environment').addEventListener('click', openRawEnvironmentEditor);
$('#copy-all-environment').addEventListener('click', copyAllEnvironmentVariables);

$('#variable-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!environmentService) return;
    const key = $('#variable-key').value.trim();
    const value = $('#variable-value').value;
    const saveButton = $('#save-variable');
    saveButton.disabled = true;
    $('#variable-error').textContent = '';
    try {
        const url = editVariableKey
            ? `/api/services/${encodeURIComponent(environmentService.id)}/env/${encodeURIComponent(editVariableKey)}`
            : `/api/services/${encodeURIComponent(environmentService.id)}/env`;
        await request(url, {
            method: editVariableKey ? 'PUT' : 'POST',
            body: JSON.stringify(editVariableKey ? { value } : { key, value })
        });
        $('#variable-value').value = '';
        variableDialog.close();
        showNotice(editVariableKey
            ? `已更新环境变量 ${key}；如需应用到运行中的服务，请重新构建并部署。`
            : `已添加环境变量 ${key}；如需应用到运行中的服务，请重新构建并部署。`);
        await Promise.all([loadEnvironmentVariables(), loadSystem()]);
    } catch (error) {
        $('#variable-error').textContent = error.message;
    } finally {
        saveButton.disabled = false;
    }
});

$('#refresh').addEventListener('click', loadSystem);
document.querySelectorAll('.nav-tab').forEach(tab => tab.addEventListener('click', () => selectView(tab.dataset.view)));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    dialog.close();
}));
serviceDialog.addEventListener('close', resetServiceDialog);
$('#github-dialog').addEventListener('close', () => {
    if (devicePollTimer) clearTimeout(devicePollTimer);
    devicePollTimer = null;
    $('#github-device-panel').hidden = true;
    $('#github-user-code').textContent = '';
    $('#connect-github').disabled = !githubClientConfigured;
});
environmentDialog.addEventListener('close', clearEnvironmentDialog);
variableDialog.addEventListener('close', () => {
    $('#variable-value').value = '';
    $('#variable-error').textContent = '';
    editVariableKey = null;
});

async function showDashboard() {
    loginView.hidden = true;
    dashboard.hidden = false;
    selectView('server');
    showNotice('');
    await Promise.all([loadSystem(), loadGithubAccounts()]);
}

async function start() {
    try {
        const session = await request('/api/session');
        if (!session.authenticated) {
            loginView.hidden = false;
            return;
        }
        csrfToken = session.csrfToken;
        showDashboard();
        setInterval(loadSystem, 30000);
    } catch (error) {
        loginView.hidden = false;
        $('#login-error').textContent = error.message;
    }
}

start();

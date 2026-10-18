'use strict';

const $ = selector => document.querySelector(selector);
const loginView = $('#login');
const dashboard = $('#dashboard');
const notice = $('#notice');
const serviceDialog = $('#service-dialog');
const logsDialog = $('#logs-dialog');
let csrfToken = '';
let editServiceId = null;
let repositories = [];

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
    $('#service-form').reset();
    $('#env-text').value = '';
    $('#env-rows').replaceChildren();
    $('#env-error').textContent = '';
    $('#service-fields').hidden = false;
    $('#repo').required = true;
    $('#env-hint').textContent = '变量将保存在服务器的私有文件中，保存后不会再次显示。';
    $('#service-dialog-title').textContent = '导入仓库';
    $('#service-dialog-description').textContent = '选择一个 GitHub 仓库，系统会自动检测其默认分支。';
    $('#save-service').textContent = '保存服务';
}

async function loadRepositories() {
    const select = $('#repo');
    select.replaceChildren(new Option('正在加载仓库…', ''));
    try {
        const data = await request('/api/github/info');
        repositories = data.repos || [];
        $('#github-user').textContent = `GitHub：${data.user.login}`;
        $('#github-user').hidden = false;
        select.replaceChildren(new Option('请选择仓库', ''));
        repositories.forEach((repo, index) => {
            select.add(new Option(`${repo.isPrivate ? '🔒' : '🌐'} ${repo.nameWithOwner}`, String(index)));
        });
    } catch (error) {
        select.replaceChildren(new Option('无法加载仓库', ''));
        showNotice(`GitHub CLI：${error.message}。请在服务器上安装 gh 并运行 gh auth login。`, true);
    }
}

async function loadSystem() {
    try {
        const data = await request('/api/system');
        $('#cpu').textContent = data.cpu;
        $('#memory').textContent = data.memory;
        $('#disk').textContent = data.disk;
        renderServices(data.services);
    } catch (error) {
        showNotice(error.message, true);
    }
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
        status.textContent = service.status === 'running' ? '运行中' : service.status === 'stopped' ? '已停止' : service.status === 'uninstalled' ? '未部署' : service.statusRaw;
        title.append(name, status);
        const meta = document.createElement('div');
        meta.className = 'service-meta';
        meta.textContent = `${service.id} · ${service.repo} · ${service.branch}${service.port ? ` · 端口 ${service.port}` : ''}`;
        info.append(title, meta);
        const actions = document.createElement('div');
        actions.className = 'service-actions';
        actions.append(actionButton('构建并部署', 'build', service, 'button primary'));
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
        resetServiceDialog();
        editServiceId = service.id;
        $('#service-fields').hidden = true;
        $('#repo').required = false;
        $('#service-dialog-title').textContent = `替换环境变量 · ${service.name}`;
        $('#service-dialog-description').textContent = '系统不会读取或显示现有值。请输入完整的新变量列表；留空将清除所有变量。';
        $('#env-hint').textContent = '仅保存此处输入的变量值，保存后将全部隐藏。';
        $('#save-service').textContent = '替换环境变量';
        serviceDialog.showModal();
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
    dashboard.hidden = true;
    loginView.hidden = false;
});

$('#add-service').addEventListener('click', async () => {
    resetServiceDialog();
    serviceDialog.showModal();
    await loadRepositories();
});

$('#repo').addEventListener('change', () => {
    const repo = repositories[Number($('#repo').value)];
    if (!repo) return;
    $('#name').value = repo.name;
    $('#id').value = repo.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 63);
    $('#branch').value = repo.defaultBranchRef && repo.defaultBranchRef.name || 'main';
});

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
            showNotice('环境变量已替换。');
        } else {
            const repo = repositories[Number($('#repo').value)];
            if (!repo) throw new Error('请选择一个 GitHub 仓库。');
            await request('/api/services', {
                method: 'POST',
                body: JSON.stringify({
                    id: $('#id').value,
                    name: $('#name').value,
                    repo: repo.nameWithOwner,
                    branch: $('#branch').value,
                    port: $('#port').value,
                    env
                })
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

$('#refresh').addEventListener('click', loadSystem);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    if (dialog === serviceDialog) $('#env-text').value = '';
    dialog.close();
}));

async function showDashboard() {
    loginView.hidden = true;
    dashboard.hidden = false;
    showNotice('');
    await loadSystem();
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
        setInterval(loadSystem, 15000);
    } catch (error) {
        loginView.hidden = false;
        $('#login-error').textContent = error.message;
    }
}

start();

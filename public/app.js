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
let dockerResourcesLoaded = false;

async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
    }
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `请求失败（${response.status}）`);
        error.status = response.status;
        error.code = data.code;
        throw error;
    }
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
    $('#github-accounts-status').textContent = '正在加载 GitHub 账号…';
    try {
        const data = await request('/api/github/accounts');
        githubAccounts = data.accounts || [];
        githubClientConfigured = data.clientConfigured;
        $('#connect-github').disabled = !githubClientConfigured;
        $('#github-config-notice').hidden = githubClientConfigured;
        $('#github-accounts-status').textContent = '';
        renderGithubAccounts();
    } catch (error) {
        $('#github-accounts-status').textContent = `无法加载 GitHub 账号：${error.message}`;
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

function resourceSize(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return 'Docker 未提供';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let value = bytes;
    let unit = -1;
    do {
        value /= 1024;
        unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
}

function resourceField(label, value, parent) {
    const row = document.createElement('div');
    row.className = 'resource-field';
    const heading = document.createElement('strong');
    heading.textContent = label;
    const detail = document.createElement('span');
    detail.textContent = value === null || value === undefined || value === '' ? '未知' : String(value);
    row.append(heading, detail);
    parent.append(row);
}

function resourceLabels(labels) {
    return Object.entries(labels || {}).map(([key, value]) => `${key}=${value}`).join(' · ') || '无可展示的安全标签';
}

function resourceListMessage(list, result, emptyText) {
    list.replaceChildren();
    if (!result || !result.available) {
        const error = document.createElement('p');
        error.className = 'resource-unavailable';
        error.textContent = `不可用：${result && result.error ? result.error : '尚未加载'}`;
        list.append(error);
        return;
    }
    if (!result.items.length) {
        const empty = document.createElement('p');
        empty.className = 'muted resource-empty';
        empty.textContent = emptyText;
        list.append(empty);
    }
}

function resourceCard(title, resource, kind) {
    const card = document.createElement('article');
    card.className = 'resource-card-row';
    const header = document.createElement('div');
    header.className = 'resource-card-heading';
    const identity = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = title;
    const ownership = document.createElement('span');
    ownership.className = `ownership-badge ${resource.ownership === 'qorange' ? 'owned' : 'external'}`;
    ownership.textContent = resource.ownership === 'qorange' ? 'QOrange 托管' : '外部 / 非托管';
    identity.append(name, ownership);
    const id = document.createElement('code');
    id.textContent = resource.id || resource.name;
    header.append(identity, id);
    const details = document.createElement('div');
    details.className = 'resource-fields';
    card.append(header, details);
    return { card, details, kind };
}

function resourceActionButton(parent, label, action, id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action === 'remove' ? 'button danger' : 'button subtle';
    button.textContent = label;
    button.addEventListener('click', () => runDockerResourceAction(parent, action, id));
    parent.append(button);
}

function renderDockerResources(resources) {
    const containers = resources.containers;
    const images = resources.images;
    const volumes = resources.volumes;
    const containerList = $('#docker-container-list');
    const imageList = $('#docker-image-list');
    const volumeList = $('#docker-volume-list');
    resourceListMessage(containerList, containers, '没有容器。');
    resourceListMessage(imageList, images, '没有镜像。');
    resourceListMessage(volumeList, volumes, '没有卷。');

    if (containers && containers.available) {
        for (const container of containers.items) {
            const item = resourceCard(container.name || '(无名称)', container, 'container');
            const portMappings = Object.entries(container.ports || {}).flatMap(([port, bindings]) =>
                (bindings || []).map(binding => `${binding.HostIp || '0.0.0.0'}:${binding.HostPort}->${port}`));
            const mountDetails = container.mounts.map(mount =>
                `${mount.type}${mount.name ? ` ${mount.name}` : ''}: ${mount.source || '未知来源'} → ${mount.destination || '未知目标'}${mount.readWrite === null ? '' : mount.readWrite ? '（读写）' : '（只读）'}`);
            resourceField('状态', container.state, item.details);
            resourceField('镜像', `${container.image || '未知'} · ${container.imageId}`, item.details);
            resourceField('端口', portMappings.join('、') || '未映射', item.details);
            resourceField('容器可写层', resourceSize(container.size.writableBytes), item.details);
            resourceField('容器根文件系统', resourceSize(container.size.rootFilesystemBytes), item.details);
            resourceField('挂载', mountDetails.join('；') || '无挂载', item.details);
            resourceField('安全标签', resourceLabels(container.labels), item.details);
            if (/(mongo|mongodb|\/data\/mongo_data)/i.test(`${container.name} ${container.image} ${mountDetails.join(' ')}`)) {
                const warning = document.createElement('p');
                warning.className = 'resource-warning';
                warning.textContent = '检测到数据库名称或数据挂载特征。删除容器不会删除卷，但仍可能造成数据库停机或数据不可用；请先核实备份、挂载及依赖。';
                item.details.append(warning);
            }
            const actions = document.createElement('div');
            actions.className = 'resource-actions';
            if (container.running) resourceActionButton(actions, '停止', 'stop', container.id);
            resourceActionButton(actions, '停止并删除容器', 'remove', container.id);
            item.card.append(actions);
            containerList.append(item.card);
        }
    }
    if (images && images.available) {
        for (const image of images.items) {
            const item = resourceCard(image.tags.join(', ') || '(未标记镜像)', image, 'image');
            resourceField('镜像 ID', image.id, item.details);
            resourceField('镜像大小（共享层总计，非可回收量）', resourceSize(image.sizeBytes), item.details);
            resourceField('摘要', image.digests.join('、') || '无', item.details);
            resourceField('引用容器', image.referencedBy.map(container => `${container.name} (${container.state}) · ${container.id}`).join('；') || '无', item.details);
            resourceField('安全标签', resourceLabels(image.labels), item.details);
            const actions = document.createElement('div');
            actions.className = 'resource-actions';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'button danger';
            remove.textContent = image.referencedBy.length ? '镜像正在被容器引用' : '删除镜像';
            remove.disabled = image.referencedBy.length > 0;
            remove.addEventListener('click', () => runDockerResourceAction(actions, 'remove-image', image.id));
            actions.append(remove);
            item.card.append(actions);
            imageList.append(item.card);
        }
    }
    if (volumes && volumes.available) {
        for (const volume of volumes.items) {
            const item = resourceCard(volume.name, volume, 'volume');
            resourceField('驱动 / 范围', `${volume.driver} / ${volume.scope}`, item.details);
            resourceField('空间用量', resourceSize(volume.sizeBytes), item.details);
            resourceField('Docker 引用数', volume.refCount === null ? 'Docker 未提供' : volume.refCount, item.details);
            resourceField('挂载点', volume.mountpoint || 'Docker 未提供', item.details);
            resourceField('使用容器', volume.usedBy.map(container =>
                `${container.name} (${container.state}) · ${container.destination || '未知目标'}${container.readWrite === null ? '' : container.readWrite ? '（读写）' : '（只读）'}`).join('；') || '当前没有发现容器关联', item.details);
            resourceField('安全标签', resourceLabels(volume.labels), item.details);
            const readOnly = document.createElement('p');
            readOnly.className = 'resource-readonly';
            readOnly.textContent = '只读清单：此面板没有卷删除 API，卷及其数据不会随容器删除。';
            item.details.append(readOnly);
            volumeList.append(item.card);
        }
    }

    const available = [containers, images, volumes].filter(result => result && result.available).length;
    const sectionCount = [containers, images, volumes].filter(Boolean).length;
    $('#docker-resources-status').textContent = resources.status === 'available'
        ? `已加载 ${containers.totalCount} 个容器、${images.totalCount} 个镜像和 ${volumes.totalCount} 个卷。${[containers, images, volumes].some(result => result.truncated) ? '至少一个清单超过 200 项显示上限，已截断；请在主机侧进一步检查。' : ''}大小仅显示 Docker 实际提供的数据。`
        : `Docker 资源查询部分或全部不可用（${available}/${sectionCount} 个清单可用）。${resources.error || '请检查 Docker 状态和错误详情。'}`;
}

async function loadDockerResources() {
    $('#docker-resources-status').textContent = '正在读取 Docker 资源…';
    try {
        const resources = await request('/api/docker-resources');
        renderDockerResources(resources);
        dockerResourcesLoaded = true;
    } catch (error) {
        $('#docker-resources-status').textContent = `无法读取 Docker 资源：${error.message}`;
        for (const id of ['docker-container-list', 'docker-image-list', 'docker-volume-list']) {
            const list = $(`#${id}`);
            list.replaceChildren();
            const failure = document.createElement('p');
            failure.className = 'resource-unavailable';
            failure.textContent = `不可用：${error.message}`;
            list.append(failure);
        }
    }
}

async function runDockerResourceAction(parent, action, id) {
    const isImage = action === 'remove-image';
    const target = isImage ? 'image' : 'container';
    const effectiveAction = isImage ? 'remove' : action;
    const prompt = isImage
        ? `删除镜像 ${id}？这会移除此镜像 ID 的所有标签；只有未被任何（包括已停止）容器引用时才允许。共享层可能仍由其他镜像使用。`
        : action === 'stop'
            ? `停止容器 ${id}？这会立即中断该容器内的服务并造成停机。外部容器也可在此页操作。`
            : `停止并删除容器 ${id}？将删除容器及其可写层；镜像和所有卷（包括匿名卷、MongoDB 数据卷）会保留，但服务会停机。`;
    if (!window.confirm(prompt)) return;
    const confirmation = window.prompt(`为确认，请输入完整的 ${target} ID：\n${id}`);
    if (confirmation === null) return;
    if (confirmation.trim() !== id) {
        showNotice('确认 ID 不匹配，未执行操作。', true);
        return;
    }
    const buttons = parent.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    try {
        const result = await request(`/api/docker-resources/${isImage ? 'images' : 'containers'}/${encodeURIComponent(id)}/action`, {
            method: 'POST',
            body: JSON.stringify({ action: effectiveAction, confirmation: confirmation.trim() })
        });
        showNotice(isImage
            ? `已删除镜像 ${result.imageId}。标签：${(result.removedTags || []).join(', ') || '无'}。`
            : action === 'remove'
                ? `已停止并删除容器 ${result.containerId}；关联卷和镜像已保留。`
                : `已停止容器 ${result.containerId}。`);
        await loadDockerResources();
        await loadSystem();
    } catch (error) {
        showNotice(`${error.message}${error.code ? ` (${error.code})` : ''}`, true);
        buttons.forEach(button => { button.disabled = false; });
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
    const selectedView = ['projects', 'docker-resources'].includes(view) ? view : 'server';
    $('#server-view').hidden = selectedView !== 'server';
    $('#projects-view').hidden = selectedView !== 'projects';
    $('#docker-resources-view').hidden = selectedView !== 'docker-resources';
    document.querySelectorAll('.nav-tab').forEach(tab => {
        const selected = tab.dataset.view === selectedView;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-selected', String(selected));
    });
    if (selectedView === 'docker-resources' && !dockerResourcesLoaded) loadDockerResources();
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

$('#github-accounts-button').addEventListener('click', async () => {
    $('#github-device-panel').hidden = true;
    $('#github-device-status').textContent = '';
    $('#github-dialog').showModal();
    await loadGithubAccounts();
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

$('#refresh').addEventListener('click', () => Promise.all([loadSystem(), loadDockerResources()]));
$('#refresh-docker-resources').addEventListener('click', loadDockerResources);
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
    await Promise.all([loadSystem(), loadGithubAccounts(), loadDockerResources()]);
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

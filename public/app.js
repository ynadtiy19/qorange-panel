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
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
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
            errors.push(`Line ${index + 1}: use KEY=VALUE.`);
            return;
        }
        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            errors.push(`Line ${index + 1}: invalid variable name.`);
            return;
        }
        if (keys.has(key)) {
            errors.push(`Line ${index + 1}: duplicate variable name.`);
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
        key.setAttribute('aria-label', `Environment variable name ${index + 1}`);
        const value = document.createElement('input');
        value.value = entry.value;
        value.type = 'text';
        value.setAttribute('aria-label', `Environment variable value ${index + 1}`);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${entry.key}`);
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
    $('#env-hint').textContent = 'Values are saved in a private file on the server and are never shown again.';
    $('#service-dialog-title').textContent = 'Import repository';
    $('#service-dialog-description').textContent = 'Choose a GitHub repository. Its default branch will be detected automatically.';
    $('#save-service').textContent = 'Save service';
}

async function loadRepositories() {
    const select = $('#repo');
    select.replaceChildren(new Option('Loading repositories…', ''));
    try {
        const data = await request('/api/github/info');
        repositories = data.repos || [];
        $('#github-user').textContent = `GitHub: ${data.user.login}`;
        $('#github-user').hidden = false;
        select.replaceChildren(new Option('Choose a repository', ''));
        repositories.forEach((repo, index) => {
            select.add(new Option(`${repo.isPrivate ? '🔒' : '🌐'} ${repo.nameWithOwner}`, String(index)));
        });
    } catch (error) {
        select.replaceChildren(new Option('Could not load repositories', ''));
        showNotice(`GitHub CLI: ${error.message}. Install gh and run gh auth login on the server.`, true);
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
        status.textContent = service.status === 'running' ? 'Running' : service.status === 'stopped' ? 'Stopped' : service.statusRaw;
        title.append(name, status);
        const meta = document.createElement('div');
        meta.className = 'service-meta';
        meta.textContent = `${service.id} · ${service.repo} · ${service.branch}${service.port ? ` · port ${service.port}` : ''}`;
        info.append(title, meta);
        const actions = document.createElement('div');
        actions.className = 'service-actions';
        actions.append(actionButton('Build & deploy', 'build', service, 'button primary'));
        if (service.status === 'running') {
            actions.append(actionButton('Restart', 'restart', service), actionButton('Stop', 'stop', service));
        } else if (service.status === 'stopped') {
            actions.append(actionButton('Start', 'start', service));
        }
        actions.append(actionButton('Environment', 'environment', service));
        if (service.status !== 'uninstalled') actions.append(actionButton('Logs', 'logs', service));
        const remove = actionButton('Delete', 'delete', service, 'button danger');
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
        $('#service-dialog-title').textContent = `Replace environment · ${service.name}`;
        $('#service-dialog-description').textContent = 'Existing values are never retrieved or displayed. Enter the complete replacement set; an empty list clears all variables.';
        $('#env-hint').textContent = 'Only the values entered here will be stored. All values are hidden after saving.';
        $('#save-service').textContent = 'Replace environment';
        serviceDialog.showModal();
        return;
    }
    if (action === 'delete' && !window.confirm(`Delete ${service.name}? Its managed container and private environment file will be removed. Repository source and images are left untouched.`)) return;
    if (action === 'logs') {
        $('#logs-title').textContent = `Logs · ${service.name}`;
        $('#logs-content').textContent = 'Loading…';
        logsDialog.showModal();
    } else {
        showNotice(`${action === 'build' ? 'Deployment' : action} in progress for ${service.name}…`);
    }
    try {
        const result = await request(`/api/services/${encodeURIComponent(service.id)}/action`, {
            method: 'POST',
            body: JSON.stringify({ action })
        });
        if (action === 'logs') $('#logs-content').textContent = result.logs || 'No output.';
        else showNotice(action === 'delete' ? `${service.name} deleted.` : result.logs || `${action} completed.`);
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
            showNotice('Environment variables replaced.');
        } else {
            const repo = repositories[Number($('#repo').value)];
            if (!repo) throw new Error('Choose a GitHub repository.');
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
            showNotice('Service saved. Build and deploy it when ready.');
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

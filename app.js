'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
    downloadGithubArchiveForAccount,
    startDeviceAuthorization,
    pollDeviceAuthorization,
    githubCurrentUser,
    githubRepositories,
    githubBranches,
    githubRepositoryFiles,
    requireClientId
} = require('./lib/github');
const { collectSystemMetrics, sampleCpuUsage } = require('./lib/system');
const {
    parseEnv,
    validateService,
    validateServiceId,
    validateBranch,
    containerName,
    resolveServiceStatus,
    redactSecrets,
    detectRepositoryRecipe,
    previewDeploymentPlan
} = require('./lib/core');
const {
    createSession,
    verifySession,
    verifyPassword,
    sessionCookie,
    clearSessionCookie
} = require('./lib/auth');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT || 8888);
const BIND_ADDRESS = process.env.BIND_ADDRESS || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ENV_DIR = process.env.ENV_DIR || path.join(DATA_DIR, 'env');
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(os.tmpdir(), 'qorange-panel-builds');
const AUTH_FILE = process.env.AUTH_FILE || path.join(DATA_DIR, 'auth.json');
const SESSION_KEY_FILE = process.env.SESSION_KEY_FILE || path.join(DATA_DIR, 'session.key');
const SERVICE_FILE = path.join(DATA_DIR, 'services.json');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const MAX_ENV_BYTES = 64 * 1024;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_ACCOUNT_FILE = path.join(DATA_DIR, 'github-accounts.json');
const DOCKER_CLI_PATH = process.env.DOCKER_CLI_PATH || 'docker';
const loginAttempts = new Map();
const serviceOperations = new Map();
let previousCpuSnapshot = null;
const githubDeviceFlows = new Map();
let githubHttpFetch = (...args) => globalThis.fetch(...args);
const githubFetchOptions = () => ({ fetchImpl: githubHttpFetch });

function runFile(file, args, options = {}) {
    return execFileAsync(file, args, {
        cwd: options.cwd,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: options.timeout || 10 * 60 * 1000,
        windowsHide: true
    });
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
}

function readServices() {
    const config = readJson(SERVICE_FILE, { services: [] });
    if (!Array.isArray(config.services)) throw new Error('服务注册表无效');
    return config.services;
}

function writeServices(services) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const temp = `${SERVICE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ services }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, SERVICE_FILE);
    fs.chmodSync(SERVICE_FILE, 0o600);
}

function readGithubAccounts() {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(DATA_DIR, 0o700);
    try {
        const stat = fs.lstatSync(GITHUB_ACCOUNT_FILE);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('GitHub credential file is not a regular file');
        fs.chmodSync(GITHUB_ACCOUNT_FILE, 0o600);
        const store = JSON.parse(fs.readFileSync(GITHUB_ACCOUNT_FILE, 'utf8'));
        if (!store || !Array.isArray(store.accounts)) throw new Error('GitHub credential file is invalid');
        return store.accounts;
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function writeGithubAccounts(accounts) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(DATA_DIR, 0o700);
    const temp = `${GITHUB_ACCOUNT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ accounts }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, GITHUB_ACCOUNT_FILE);
    fs.chmodSync(GITHUB_ACCOUNT_FILE, 0o600);
}

function githubAccountFor(id) {
    if (id === undefined || id === null || id === '') return null;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) {
        const error = new Error('GitHub account selection is invalid.');
        error.statusCode = 400;
        throw error;
    }
    const account = readGithubAccounts().find(item => item.id === id);
    if (!account) {
        const error = new Error('The selected GitHub account is no longer linked. Select another account and update the service.');
        error.statusCode = 409;
        throw error;
    }
    if (typeof account.token !== 'string' || !account.token) {
        const error = new Error('The selected GitHub account is disconnected. Reconnect it or choose another account.');
        error.statusCode = 409;
        throw error;
    }
    return account;
}

function publicGithubAccount(account) {
    return { id: account.id, login: account.login, name: account.name || '', linkedAt: account.linkedAt };
}

function envFilePath(id) {
    return path.join(ENV_DIR, `${id}.env`);
}

function readServiceEnv(id) {
    const text = fs.readFileSync(envFilePath(id), 'utf8');
    return parseEnv(text);
}

function readServiceEnvIfPresent(id) {
    try {
        return readServiceEnv(id);
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

function environmentMetadata(id) {
    const count = Object.keys(readServiceEnvIfPresent(id)).length;
    return { environmentConfigured: count > 0, environmentVariableCount: count };
}

function setEnvironmentValue(env, key, value) {
    Object.defineProperty(env, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
    });
}

function writeServiceEnv(id, envText) {
    const env = parseEnv(envText);
    fs.mkdirSync(ENV_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(ENV_DIR, 0o700);
    const temp = `${envFilePath(id)}.${process.pid}.tmp`;
    fs.writeFileSync(temp, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + (Object.keys(env).length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(temp, envFilePath(id));
    fs.chmodSync(envFilePath(id), 0o600);
}

function serviceOr404(id, res) {
    const service = readServices().find(item => item.id === id);
    if (!service) {
        res.status(404).json({ error: '未找到该服务' });
        return null;
    }
    return service;
}

function safeError(error, secrets = []) {
    const values = Array.isArray(secrets) ? secrets : Object.values(secrets);
    return redactSecrets(error && (error.stderr || error.message) || String(error), values)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .slice(0, 4000);
}

function sendOperationError(res, error, secrets = {}) {
    const message = safeError(error, secrets);
    console.error(`Panel operation failed: ${message}`);
    const response = { error: message || '操作失败' };
    if (error.publicCode) response.code = error.publicCode;
    res.status(error.statusCode || error.status || 500).json(response);
}

function setSecurityHeaders(_req, res, next) {
    res.set({
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
}

function requestOriginMatches(req) {
    const origin = req.get('origin');
    if (!origin) return false;
    try {
        return new URL(origin).host === req.get('host');
    } catch {
        return false;
    }
}

function currentSession(req) {
    const token = (req.headers.cookie || '').split(';').map(part => part.trim())
        .find(part => part.startsWith('qorange_session='))
        ?.slice('qorange_session='.length);
    let decoded;
    try { decoded = token && decodeURIComponent(token); } catch { return null; }
    return decoded ? verifySession(decoded, fs.readFileSync(SESSION_KEY_FILE)) : null;
}

function requireAdmin(req, res, next) {
    try {
        req.panelSession = currentSession(req);
        if (!req.panelSession) return res.status(401).json({ error: '需要先登录' });
        next();
    } catch (error) {
        next(error);
    }
}

function requireSameOrigin(req, res, next) {
    if (!requestOriginMatches(req)) return res.status(403).json({ error: '请求来源验证失败' });
    next();
}

function requireCsrf(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (!requestOriginMatches(req)) return res.status(403).json({ error: '请求来源验证失败' });
    const token = req.get('x-csrf-token') || '';
    const expected = req.panelSession.csrf;
    if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
        return res.status(403).json({ error: 'CSRF 令牌验证失败' });
    }
    next();
}

function loginLimit(req, res, next) {
    const ip = req.socket.remoteAddress || 'unknown';
    const entry = loginAttempts.get(ip);
    const now = Date.now();
    if (entry && entry.blockedUntil > now) return res.status(429).json({ error: '登录尝试次数过多，请稍后重试' });
    if (!entry || entry.windowStart + 15 * 60 * 1000 < now) loginAttempts.set(ip, { count: 0, windowStart: now, blockedUntil: 0 });
    next();
}

function recordFailedLogin(req) {
    const ip = req.socket.remoteAddress || 'unknown';
    const entry = loginAttempts.get(ip) || { count: 0, windowStart: Date.now(), blockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= 5) entry.blockedUntil = Date.now() + 15 * 60 * 1000;
    loginAttempts.set(ip, entry);
}

function serviceSecrets(env) {
    return Object.values(env).filter(value => value.length > 0);
}

function limitOutput(text, maxLength = 120_000) {
    if (text.length <= maxLength) return text;
    return `[较早的输出已截断]\n${text.slice(-maxLength)}`;
}

async function inspectBranchRecipe(repo, branch, token) {
    const safeBranch = validateBranch(branch || 'main');
    const fileMap = await githubRepositoryFiles(repo, safeBranch, token, githubFetchOptions());
    const recipe = detectRepositoryRecipe(fileMap, { repo, branch: safeBranch });
    if (!recipe.supported) {
        const error = new Error(recipe.reason || '未找到受支持的部署方案');
        error.statusCode = 422;
        throw error;
    }
    return { recipe, preview: previewDeploymentPlan(recipe) };
}

function isContainerNotFound(error) {
    return /No such (?:object|container)(?::|\b)/i.test(`${error.stderr || ''}\n${error.message || ''}`);
}

function isContainerNameConflict(error) {
    return /container name .* is already in use/i.test(`${error.stderr || ''}\n${error.message || ''}`);
}

async function ownedContainerId(name, id) {
    try {
        const result = await runFile(DOCKER_CLI_PATH, [
            'container', 'inspect', '--format',
            '{{.Id}}|{{ index .Config.Labels "com.qorange.panel" }}|{{ index .Config.Labels "com.qorange.service" }}',
            name
        ], { timeout: 15000 });
        const [containerId, panelLabel, serviceLabel] = result.stdout.trim().split('|');
        if (!/^[a-f0-9]{64}$/i.test(containerId || '') || panelLabel !== 'true' || serviceLabel !== id) {
            const error = new Error('同名容器并非由 QOrange 管理，已保持原样且未作更改。请手动检查并重命名或移除该容器后重试；QOrange 不会覆盖非托管容器');
            error.statusCode = 409;
            error.publicCode = 'UNOWNED_CONTAINER';
            throw error;
        }
        return containerId;
    } catch (error) {
        if (error.statusCode) throw error;
        if (isContainerNotFound(error)) return null;
        throw error;
    }
}

async function removeOwnedContainer(containerId) {
    for (const action of ['stop', 'rm']) {
        try {
            await runFile(DOCKER_CLI_PATH, [action, containerId], { timeout: 60000 });
        } catch (error) {
            if (!isContainerNotFound(error)) throw error;
        }
    }
}

async function runContainer(name, id, args) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            return await runFile(DOCKER_CLI_PATH, args, { timeout: 60000 });
        } catch (error) {
            if (!isContainerNameConflict(error)) throw error;
            const existingContainerId = await ownedContainerId(name, id);
            if (existingContainerId) {
                const conflict = new Error('部署期间同名 QOrange 容器已出现，未对其作更改。请确认没有其他部署正在运行后重试');
                conflict.statusCode = 409;
                throw conflict;
            }
            if (attempt === 1) {
                const conflict = new Error('容器名称冲突，但重新检查时容器已消失。请稍后重试部署');
                conflict.statusCode = 409;
                throw conflict;
            }
        }
    }
}

async function withServiceLock(id, operation) {
    if (serviceOperations.has(id)) {
        const error = new Error('该服务的另一项操作正在进行中');
        error.statusCode = 409;
        throw error;
    }
    const pending = Promise.resolve().then(operation);
    serviceOperations.set(id, pending);
    try {
        return await pending;
    } finally {
        if (serviceOperations.get(id) === pending) serviceOperations.delete(id);
    }
}

async function performDeploy(service) {
    const env = readServiceEnv(service.id);
    const secrets = serviceSecrets(env);
    const name = containerName(service.id);
    const workspace = fs.mkdtempSync(path.join(WORKSPACE_DIR, `${service.id}-`));
    const archive = path.join(workspace, 'repository.tar.gz');
    const source = path.join(workspace, 'source');
    const logs = [`开始部署 ${service.name}。`];
    try {
        fs.mkdirSync(source);
        const account = githubAccountFor(service.githubAccountId);
        logs.push('正在下载所选 GitHub 分支。');
        await downloadGithubArchiveForAccount(service.repo, service.branch, account && account.token, archive, githubFetchOptions());
        await runFile('tar', ['-xzf', archive, '-C', source, '--strip-components=1'], { timeout: 5 * 60 * 1000 });
        logs.push('正在构建应用镜像。');
        const build = await runFile(DOCKER_CLI_PATH, [
            'build', '--tag', `qorange-${service.id}:latest`,
            '--label', 'com.qorange.panel=true',
            '--label', `com.qorange.service=${service.id}`,
            source
        ], { timeout: 30 * 60 * 1000 });
        if (build.stdout) logs.push(build.stdout);
        if (build.stderr) logs.push(build.stderr);

        const existingContainerId = await ownedContainerId(name, service.id);
        if (existingContainerId) await removeOwnedContainer(existingContainerId);
        const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped',
            '--label', 'com.qorange.panel=true',
            '--label', `com.qorange.service=${service.id}`];
        if (service.port) args.push('--publish', service.port);
        if (Object.keys(env).length) args.push('--env-file', envFilePath(service.id));
        args.push(`qorange-${service.id}:latest`);
        const run = await runContainer(name, service.id, args);
        logs.push(`容器已启动：${run.stdout.trim()}`);
        return limitOutput(redactSecrets(logs.join('\n'), secrets));
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

function updateDeploymentState(id, status) {
    const services = readServices();
    const service = services.find(item => item.id === id);
    if (!service) throw new Error('未找到该服务，无法保存部署状态');
    const previous = service.deployment && typeof service.deployment === 'object' ? service.deployment : {};
    const now = new Date().toISOString();
    service.deployment = {
        status,
        lastAttemptAt: status === 'deploying' ? now : (previous.lastAttemptAt || now),
        lastSuccessAt: status === 'succeeded' ? now : (previous.lastSuccessAt || null)
    };
    writeServices(services);
}

app.disable('x-powered-by');
app.use(setSecurityHeaders);
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
});
app.use(express.json({ limit: MAX_ENV_BYTES + 32 * 1024, type: 'application/json' }));
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    maxAge: 0,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'no-store');
    }
}));

app.get('/healthz', (_req, res) => res.status(200).type('text/plain').send('ok'));

app.get('/api/session', (req, res) => {
    try {
        const session = currentSession(req);
        res.json(session ? { authenticated: true, user: 'admin', csrfToken: session.csrf } : { authenticated: false });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.post('/api/login', requireSameOrigin, loginLimit, async (req, res, next) => {
    try {
        const password = req.body && req.body.password;
        if (typeof password !== 'string' || password.length > 1024 || !(await verifyPassword(password, readJson(AUTH_FILE)))) {
            recordFailedLogin(req);
            return             res.status(401).json({ error: '密码错误' });
        }
        loginAttempts.delete(req.socket.remoteAddress || 'unknown');
        const session = createSession(fs.readFileSync(SESSION_KEY_FILE));
        res.setHeader('Set-Cookie', sessionCookie(session.token, COOKIE_SECURE));
        res.json({ authenticated: true, user: 'admin', csrfToken: session.csrf });
    } catch (error) {
        next(error);
    }
});

app.use('/api', requireAdmin, requireCsrf);

app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie(COOKIE_SECURE));
    res.json({ success: true });
});

app.get('/api/github/accounts', (_req, res) => {
    try {
        res.json({
            clientConfigured: /^[A-Za-z0-9_]{20}$/.test(GITHUB_CLIENT_ID),
            accounts: readGithubAccounts().filter(account => account.token).map(publicGithubAccount)
        });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.post('/api/github/device', async (req, res) => {
    try {
        requireClientId(GITHUB_CLIENT_ID);
        const authorization = await startDeviceAuthorization(GITHUB_CLIENT_ID, githubFetchOptions());
        for (const [id, flow] of githubDeviceFlows) {
            if (flow.expiresAt <= Date.now()) githubDeviceFlows.delete(id);
        }
        const id = crypto.randomUUID();
        githubDeviceFlows.set(id, {
            deviceCode: authorization.deviceCode,
            interval: authorization.interval,
            nextPollAt: Date.now() + authorization.interval * 1000,
            expiresAt: Date.now() + authorization.expiresIn * 1000,
            csrf: req.panelSession.csrf
        });
        res.json({
            deviceId: id,
            userCode: authorization.userCode,
            verificationUri: authorization.verificationUri,
            interval: authorization.interval,
            expiresIn: authorization.expiresIn
        });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.post('/api/github/device/:id/poll', async (req, res) => {
    const flow = githubDeviceFlows.get(req.params.id);
    if (!flow || flow.csrf !== req.panelSession.csrf) return res.status(404).json({ error: 'Device authorization has expired or was not found.' });
    if (Date.now() >= flow.expiresAt) {
        githubDeviceFlows.delete(req.params.id);
        return res.json({ status: 'expired' });
    }
    if (Date.now() < flow.nextPollAt) {
        return res.json({ status: 'pending', interval: flow.interval, retryAfter: Math.ceil((flow.nextPollAt - Date.now()) / 1000) });
    }
    try {
        const result = await pollDeviceAuthorization(GITHUB_CLIENT_ID, flow.deviceCode, githubFetchOptions());
        if (result.status === 'slow_down') flow.interval += 5;
        flow.nextPollAt = Date.now() + flow.interval * 1000;
        if (result.status === 'authorized') {
            const identity = await githubCurrentUser(result.accessToken, githubFetchOptions());
            const accounts = readGithubAccounts();
            const existing = accounts.find(account => account.login.toLowerCase() === identity.login.toLowerCase());
            const account = {
                id: existing ? existing.id : crypto.randomUUID(),
                login: identity.login,
                name: identity.name,
                token: result.accessToken,
                linkedAt: existing ? existing.linkedAt : new Date().toISOString()
            };
            writeGithubAccounts(existing
                ? accounts.map(item => item.id === existing.id ? account : item)
                : [...accounts, account]);
            githubDeviceFlows.delete(req.params.id);
            return res.json({ status: 'authorized', account: publicGithubAccount(account) });
        }
        if (['expired', 'denied'].includes(result.status)) githubDeviceFlows.delete(req.params.id);
        return res.json({ status: result.status, interval: flow.interval });
    } catch (error) {
        githubDeviceFlows.delete(req.params.id);
        sendOperationError(res, error);
    }
});

app.delete('/api/github/accounts/:id', (req, res) => {
    try {
        const account = readGithubAccounts().find(item => item.id === req.params.id && item.token);
        if (!account) return res.status(404).json({ error: 'GitHub account not found.' });
        writeGithubAccounts(readGithubAccounts().map(item => {
            if (item.id !== account.id) return item;
            return { id: item.id, login: item.login, name: item.name || '', linkedAt: item.linkedAt };
        }));
        res.json({ success: true });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.get('/api/github/accounts/:id/repositories', async (req, res) => {
    try {
        const account = githubAccountFor(req.params.id);
        const repos = await githubRepositories(account.token, githubFetchOptions());
        res.json({ repos });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.get('/api/github/branches', async (req, res) => {
    try {
        const repo = typeof req.query.repo === 'string' ? req.query.repo : '';
        const account = githubAccountFor(req.query.accountId);
        const branches = await githubBranches(repo, account && account.token, githubFetchOptions());
        res.json({ branches });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.post('/api/repos/preview', async (req, res) => {
    try {
        const repo = typeof req.body.repo === 'string' ? req.body.repo.trim() : '';
        const branch = typeof req.body.branch === 'string' ? req.body.branch.trim() : 'main';
        const account = githubAccountFor(req.body.accountId);
        const preview = await inspectBranchRecipe(repo, branch, account && account.token);
        res.json(preview);
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.get('/api/system', async (_req, res) => {
    try {
        const cpus = os.cpus();
        const cpuSample = sampleCpuUsage(cpus, previousCpuSnapshot);
        previousCpuSnapshot = cpuSample.snapshot;
        const system = collectSystemMetrics({ cpus });
        system.cpu.usagePercent = cpuSample.percent;
        if (!system.disk.available) console.error('System disk probe failed: disk metrics unavailable');

        const [dockerPs, dockerVersion] = await Promise.allSettled([
            runFile(DOCKER_CLI_PATH, [
                'ps', '-a', '--filter', 'label=com.qorange.panel=true',
                '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'
            ], { timeout: 15000 }),
            runFile(DOCKER_CLI_PATH, ['version', '--format', '{{.Server.Version}}'], { timeout: 15000 })
        ]);
        const dockerAvailable = dockerPs.status === 'fulfilled';
        if (!dockerAvailable) {
            const code = dockerPs.reason && dockerPs.reason.code;
            console.error(`Docker status probe failed: ${code || 'command failed'}`);
        }
        if (dockerVersion.status === 'rejected') {
            const code = dockerVersion.reason && dockerVersion.reason.code;
            console.error(`Docker version probe failed: ${code || 'command failed'}`);
        }
        const containerMap = new Map();
        if (dockerAvailable) {
            for (const line of dockerPs.value.stdout.trim().split('\n').filter(Boolean)) {
                const [name, status, ports = ''] = line.split('\t');
                if (name) containerMap.set(name, { status: status || '未知', ports });
            }
        }
        const registeredServices = readServices();
        const githubAccounts = new Map(readGithubAccounts().filter(account => account.token).map(account => [account.id, account.login]));
        let registryChanged = false;
        const services = registeredServices.map(service => {
            let deployment = service.deployment && typeof service.deployment === 'object'
                ? service.deployment
                : { status: 'never', lastAttemptAt: null, lastSuccessAt: null };
            if (deployment.status === 'deploying' && !serviceOperations.has(service.id)) {
                deployment = {
                    status: 'failed',
                    lastAttemptAt: deployment.lastAttemptAt || null,
                    lastSuccessAt: deployment.lastSuccessAt || null
                };
                service.deployment = deployment;
                registryChanged = true;
            }
            const container = containerMap.get(containerName(service.id));
            const statusRaw = container ? container.status : null;
            const deploymentStatus = ['deploying', 'succeeded', 'failed'].includes(deployment.status)
                ? deployment.status
                : 'never';
            const hasContainer = statusRaw !== null;
            return {
                id: service.id,
                name: service.name,
                repo: service.repo,
                branch: service.branch,
                githubAccountId: service.githubAccountId || null,
                githubAccountLogin: service.githubAccountId ? githubAccounts.get(service.githubAccountId) || null : null,
                port: service.port,
                type: 'app',
                status: dockerAvailable
                    ? resolveServiceStatus(statusRaw, deploymentStatus, serviceOperations.has(service.id))
                    : 'unknown',
                statusRaw: dockerAvailable ? statusRaw || 'Not deployed' : 'Docker 不可用，状态未知',
                deploymentStatus,
                lastDeploymentAttemptAt: deployment.lastAttemptAt || null,
                lastSuccessfulDeploymentAt: deployment.lastSuccessAt || null,
                hasContainer,
                containerPorts: container ? container.ports : '',
                ...environmentMetadata(service.id)
            };
        });
        if (registryChanged) writeServices(registeredServices);
        const memory = `${system.memory.used}/${system.memory.total} (${system.memory.percent ?? '未知'}%)`;
        const disk = system.disk.available
            ? `${system.disk.used}/${system.disk.total} (${system.disk.percent}%)`
            : system.disk.error;
        const managedContainers = [...containerMap.entries()].map(([name, container]) => ({
            name,
            status: container.status,
            running: /^Up\b/i.test(container.status),
            ports: container.ports || '未映射'
        }));
        res.json({
            cpu: system.cpu.usagePercent === null
                ? `正在采样（${system.cpu.cores} 核）`
                : `${system.cpu.usagePercent}% (${system.cpu.cores} cores)`,
            memory,
            disk,
            system,
            panel: { status: 'running', uptimeSeconds: Math.floor(process.uptime()) },
            docker: {
                status: dockerAvailable ? 'running' : 'unavailable',
                version: dockerVersion.status === 'fulfilled' && dockerVersion.value.stdout.trim()
                    ? dockerVersion.value.stdout.trim()
                    : '未知',
                error: dockerAvailable ? null : '无法连接 Docker daemon'
            },
            managedContainers,
            services
        });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.post('/api/services', async (req, res) => {
    try {
        const input = req.body || {};
        const service = validateService(input);
        const services = readServices();
        if (services.some(item => item.id === service.id)) {
            return res.status(409).json({ error: '服务 ID 已存在；请使用列表中的现有服务，不要重复导入。' });
        }
        if (fs.existsSync(envFilePath(service.id))) return res.status(409).json({ error: '该服务 ID 对应的环境变量文件已存在，未覆盖任何数据。' });
        if (input.env !== undefined && typeof input.env !== 'string') return res.status(400).json({ error: '环境变量必须是文本' });
        const githubAccount = githubAccountFor(service.githubAccountId);
        const availableBranches = await githubBranches(service.repo, githubAccount && githubAccount.token, githubFetchOptions());
        if (!availableBranches.includes(service.branch)) {
            return res.status(400).json({ error: 'The selected branch is not available in the chosen repository.' });
        }
        writeServiceEnv(service.id, input.env || '');
        try {
            services.push(service);
            writeServices(services);
        } catch (error) {
            try { fs.unlinkSync(envFilePath(service.id)); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
            throw error;
        }
        res.status(201).json({ success: true, service });
    } catch (error) {
        res.status(error.statusCode || 400).json({ error: safeError(error) });
    }
});

app.put('/api/services/:id/env', async (req, res) => {
    try {
        const id = validateServiceId(req.params.id);
        if (!readServices().some(service => service.id === id)) return res.status(404).json({ error: '未找到该服务' });
        if (typeof req.body.env !== 'string' || Buffer.byteLength(req.body.env, 'utf8') > MAX_ENV_BYTES) {
            return res.status(400).json({ error: '环境变量必须是小于 64 KB 的文本' });
        }
        await withServiceLock(id, () => writeServiceEnv(id, req.body.env));
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: safeError(error) });
    }
});

app.get('/api/services/:id/env', (req, res) => {
    try {
        const id = validateServiceId(req.params.id);
        if (!readServices().some(service => service.id === id)) return res.status(404).json({ error: '未找到该服务' });
        const env = readServiceEnvIfPresent(id);
        const environmentVariableCount = Object.keys(env).length;
        res.json({
            environmentConfigured: environmentVariableCount > 0,
            environmentVariableCount,
            variables: Object.entries(env).map(([key, value]) => ({
                key,
                maskedValue: value.length ? '••••••' : '',
                valuePresent: value.length > 0,
                private: true
            }))
        });
    } catch (error) {
        res.status(error.code === 'ENOENT' ? 404 : 400).json({ error: safeError(error) });
    }
});

app.post('/api/services/:id/env/reveal', (req, res) => {
    try {
        const id = validateServiceId(req.params.id);
        if (!readServices().some(service => service.id === id)) return res.status(404).json({ error: '未找到该服务' });
        const key = req.body && req.body.key;
        if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            return res.status(400).json({ error: '环境变量名称无效' });
        }
        const env = readServiceEnvIfPresent(id);
        if (!Object.hasOwn(env, key)) return res.status(404).json({ error: '未找到该环境变量' });
        res.json({ value: env[key] });
    } catch {
        console.error('Environment secret reveal failed');
        res.status(500).json({ error: '无法读取环境变量' });
    }
});

app.post('/api/services/:id/env/export', (req, res) => {
    try {
        const id = validateServiceId(req.params.id);
        if (!readServices().some(service => service.id === id)) return res.status(404).json({ error: '未找到该服务' });
        const env = readServiceEnvIfPresent(id);
        const text = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
        res.json({ env: text ? `${text}\n` : '' });
    } catch {
        console.error('Environment secret export failed');
        res.status(500).json({ error: '无法导出环境变量' });
    }
});

app.post('/api/services/:id/env', async (req, res) => {
    try {
        const id = validateServiceId(req.params.id);
        if (!readServices().some(service => service.id === id)) return res.status(404).json({ error: '未找到该服务' });
        const body = req.body || {};
        const key = typeof body.key === 'string' ? body.key : '';
        const value = body.value;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ error: '环境变量名称无效' });
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_ENV_BYTES || /[\r\n\u0000]/.test(value)) {
            return res.status(400).json({ error: '环境变量值必须是单行且小于 64 KB 的文本' });
        }
        await withServiceLock(id, () => {
            const env = readServiceEnvIfPresent(id);
            if (Object.hasOwn(env, key)) return res.status(409).json({ error: '该环境变量已存在，请使用更新操作。' });
            setEnvironmentValue(env, key, value);
            const envText = Object.entries(env).map(([name, item]) => `${name}=${item}`).join('\n');
            if (Buffer.byteLength(envText, 'utf8') > MAX_ENV_BYTES) {
                return res.status(400).json({ error: '全部环境变量必须小于 64 KB' });
            }
            writeServiceEnv(id, envText);
            res.status(201).json({ success: true });
        });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.put('/api/services/:id/env/:key', async (req, res) => {
    try {
        const id = validateServiceId(req.params.id);
        if (!readServices().some(service => service.id === id)) return res.status(404).json({ error: '未找到该服务' });
        const key = req.params.key;
        const value = (req.body || {}).value;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ error: '环境变量名称无效' });
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_ENV_BYTES || /[\r\n\u0000]/.test(value)) {
            return res.status(400).json({ error: '环境变量值必须是单行且小于 64 KB 的文本' });
        }
        await withServiceLock(id, () => {
            const env = readServiceEnvIfPresent(id);
            if (!Object.hasOwn(env, key)) return res.status(404).json({ error: '未找到该环境变量' });
            setEnvironmentValue(env, key, value);
            const envText = Object.entries(env).map(([name, item]) => `${name}=${item}`).join('\n');
            if (Buffer.byteLength(envText, 'utf8') > MAX_ENV_BYTES) {
                return res.status(400).json({ error: '全部环境变量必须小于 64 KB' });
            }
            writeServiceEnv(id, envText);
            res.json({ success: true });
        });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.delete('/api/services/:id/env/:key', async (req, res) => {
    try {
        const id = validateServiceId(req.params.id);
        if (!readServices().some(service => service.id === id)) return res.status(404).json({ error: '未找到该服务' });
        const key = req.params.key;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ error: '环境变量名称无效' });
        await withServiceLock(id, () => {
            const env = readServiceEnvIfPresent(id);
            if (!Object.hasOwn(env, key)) return res.status(404).json({ error: '未找到该环境变量' });
            delete env[key];
            writeServiceEnv(id, Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n'));
            res.json({ success: true });
        });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.post('/api/services/:id/action', async (req, res) => {
    const id = req.params.id;
    let secrets = [];
    try {
        validateServiceId(id);
        const service = serviceOr404(id, res);
        if (!service) return;
        const action = req.body && req.body.action;
        if (!['build', 'delete', 'start', 'stop', 'restart', 'logs'].includes(action)) {
            return res.status(400).json({ error: '不支持此操作' });
        }
        await withServiceLock(id, async () => {
            secrets = action === 'delete' ? readServiceEnvIfPresent(id) : readServiceEnv(id);
            const name = containerName(id);
            if (action === 'build') {
                updateDeploymentState(id, 'deploying');
                try {
                    const logs = await performDeploy(service);
                    updateDeploymentState(id, 'succeeded');
                    res.json({ success: true, logs });
                } catch (error) {
                    try {
                        updateDeploymentState(id, 'failed');
                    } catch (stateError) {
                        throw new Error(`部署失败，且无法保存部署状态：${safeError(stateError, secrets)}`);
                    }
                    throw error;
                }
                return;
            }
            if (action === 'delete') {
                const preserveUnownedContainer = req.body && req.body.preserveUnownedContainer === true;
                let containerId;
                let preservedUnownedContainer = false;
                try {
                    containerId = await ownedContainerId(name, id);
                } catch (error) {
                    if (error.publicCode !== 'UNOWNED_CONTAINER' || !preserveUnownedContainer) throw error;
                    preservedUnownedContainer = true;
                }
                if (preserveUnownedContainer && containerId) {
                    const error = new Error('同名容器现已由 QOrange 管理；未移除服务记录或环境变量。请重新选择普通删除以移除托管容器');
                    error.statusCode = 409;
                    throw error;
                }
                if (containerId) await removeOwnedContainer(containerId);
                try { fs.unlinkSync(envFilePath(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                const services = readServices().filter(item => item.id !== id);
                writeServices(services);
                res.json({ success: true, containerPreserved: preservedUnownedContainer });
                return;
            }
            const containerId = await ownedContainerId(name, id);
            if (!containerId) {
                res.status(404).json({ error: '该服务尚未部署容器' });
                return;
            }
            if (action === 'logs') {
                const result = await runFile(DOCKER_CLI_PATH, ['logs', '--tail', '200', containerId], { timeout: 30000 });
                res.json({ logs: limitOutput(redactSecrets(`${result.stdout}${result.stderr}`, serviceSecrets(secrets))) });
                return;
            }
            const result = await runFile(DOCKER_CLI_PATH, [action, containerId], { timeout: 60000 });
            res.json({ success: true, logs: limitOutput(redactSecrets(`${result.stdout}${result.stderr}`, serviceSecrets(secrets))) });
        });
    } catch (error) {
        sendOperationError(res, error, secrets);
    }
});

app.use('/api', (_req, res) => res.status(404).json({ error: '未找到 API 路由' }));
app.use((error, _req, res, _next) => {
    sendOperationError(res, error);
});

if (require.main === module) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(ENV_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true, mode: 0o700 });
    app.listen(PORT, BIND_ADDRESS, () => {
        console.log(`QOrange Panel listening on ${BIND_ADDRESS}:${PORT}`);
    });
}

module.exports = {
    app,
    setGithubFetchForTests(fetchImpl) {
        githubHttpFetch = fetchImpl;
    }
};

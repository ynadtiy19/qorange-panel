'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { downloadGithubArchive } = require('./lib/github');
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
const GH_CLI_PATH = process.env.GH_CLI_PATH || 'gh';
const DOCKER_CLI_PATH = process.env.DOCKER_CLI_PATH || 'docker';
const loginAttempts = new Map();
const serviceOperations = new Map();
let previousCpuSnapshot = null;

function runFile(file, args, options = {}) {
    return execFileAsync(file, args, {
        cwd: options.cwd,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
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
    res.status(error.statusCode || error.status || 500).json({ error: message || '操作失败' });
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

async function githubInfo() {
    await runFile(GH_CLI_PATH, ['auth', 'status'], { timeout: 15000 });
    const [userResult, repoResult] = await Promise.all([
        runFile(GH_CLI_PATH, ['api', 'user', '--jq', '{login: .login, avatar_url: .avatar_url, name: .name}'], { timeout: 30000 }),
        runFile(GH_CLI_PATH, ['repo', 'list', '--limit', '1000', '--json', 'name,nameWithOwner,url,isPrivate,defaultBranchRef'], { timeout: 60000 })
    ]);
    return { user: JSON.parse(userResult.stdout), repos: JSON.parse(repoResult.stdout) };
}

async function inspectBranchRecipe(repo, branch) {
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        throw new Error('请从已登录的 GitHub 账户中选择一个仓库');
    }
    const safeBranch = validateBranch(branch || 'main');
    const treeResult = await runFile(GH_CLI_PATH, ['api', `repos/${repo}/git/trees/${safeBranch}?recursive=1`], { timeout: 30000 });
    const tree = JSON.parse(treeResult.stdout);
    const paths = Array.isArray(tree.tree) ? tree.tree.map(item => item.path).filter(Boolean) : [];
    const candidates = paths.filter(path => {
        const name = path.split('/').pop().toLowerCase();
        return ['dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'package.json', 'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'go.mod'].includes(name);
    });
    const fileMap = {};
    for (const candidate of candidates) {
        const endpoint = `repos/${repo}/contents/${candidate}?ref=${safeBranch}`;
        const details = JSON.parse((await runFile(GH_CLI_PATH, ['api', endpoint], { timeout: 30000 })).stdout);
        const content = details && details.content ? Buffer.from(details.content, 'base64').toString('utf8') : '';
        fileMap[candidate] = content;
    }
    const recipe = detectRepositoryRecipe(fileMap, { repo, branch: safeBranch });
    if (!recipe.supported) {
        const error = new Error(recipe.reason || '未找到受支持的部署方案');
        error.statusCode = 422;
        throw error;
    }
    return { recipe, preview: previewDeploymentPlan(recipe) };
}

async function assertOwnedContainer(name, id) {
    try {
        const result = await runFile(DOCKER_CLI_PATH, [
            'inspect', '--format',
            '{{ index .Config.Labels "com.qorange.panel" }}|{{ index .Config.Labels "com.qorange.service" }}',
            name
        ], { timeout: 15000 });
        if (result.stdout.trim() !== `true|${id}`) {
            const error = new Error('同名容器并非由 QOrange 管理，已保持原样且未作更改');
            error.statusCode = 409;
            throw error;
        }
        return true;
    } catch (error) {
        if (error.statusCode) throw error;
        if (/No such object|No such container|Error: No such object/i.test(error.stderr || error.message)) return false;
        throw error;
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
        try {
            await runFile(GH_CLI_PATH, ['auth', 'status'], { timeout: 15000 });
        } catch (error) {
            throw new Error(`GitHub CLI 不可用或尚未登录：${safeError(error, secrets)}`);
        }
        const endpoint = `repos/${service.repo}/tarball/${service.branch}`;
        logs.push('正在下载所选 GitHub 分支。');
        await downloadGithubArchive(GH_CLI_PATH, endpoint, archive, { secrets });
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

        const exists = await assertOwnedContainer(name, service.id);
        if (exists) {
            await runFile(DOCKER_CLI_PATH, ['stop', name], { timeout: 60000 });
            await runFile(DOCKER_CLI_PATH, ['rm', name], { timeout: 60000 });
        }
        const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped',
            '--label', 'com.qorange.panel=true',
            '--label', `com.qorange.service=${service.id}`];
        if (service.port) args.push('--publish', service.port);
        if (Object.keys(env).length) args.push('--env-file', envFilePath(service.id));
        args.push(`qorange-${service.id}:latest`);
        const run = await runFile(DOCKER_CLI_PATH, args, { timeout: 60000 });
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
app.use(express.json({ limit: MAX_ENV_BYTES + 32 * 1024, type: 'application/json' }));
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

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

app.get('/api/github/info', async (_req, res) => {
    try {
        res.json(await githubInfo());
    } catch (error) {
        sendOperationError(res, new Error(`GitHub CLI 不可用或尚未登录：${safeError(error)}`));
    }
});

app.post('/api/repos/preview', async (req, res) => {
    try {
        const repo = typeof req.body && typeof req.body.repo === 'string' ? req.body.repo.trim() : '';
        const branch = typeof req.body && typeof req.body.branch === 'string' ? req.body.branch.trim() : 'main';
        const preview = await inspectBranchRecipe(repo, branch);
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
            secrets = readServiceEnv(id);
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
                const exists = await assertOwnedContainer(name, id);
                if (exists) {
                    await runFile(DOCKER_CLI_PATH, ['stop', name], { timeout: 60000 });
                    await runFile(DOCKER_CLI_PATH, ['rm', name], { timeout: 60000 });
                }
                try { fs.unlinkSync(envFilePath(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                const services = readServices().filter(item => item.id !== id);
                writeServices(services);
                res.json({ success: true });
                return;
            }
            const exists = await assertOwnedContainer(name, id);
            if (!exists) {
                res.status(404).json({ error: '该服务尚未部署容器' });
                return;
            }
            if (action === 'logs') {
                const result = await runFile(DOCKER_CLI_PATH, ['logs', '--tail', '200', name], { timeout: 30000 });
                res.json({ logs: limitOutput(redactSecrets(`${result.stdout}${result.stderr}`, serviceSecrets(secrets))) });
                return;
            }
            const result = await runFile(DOCKER_CLI_PATH, [action, name], { timeout: 60000 });
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

module.exports = { app };

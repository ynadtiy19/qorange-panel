'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
    parseEnv,
    validateService,
    validateServiceId,
    containerName,
    redactSecrets
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
const loginAttempts = new Map();
const serviceOperations = new Map();
let previousCpuTimes = null;

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
    if (!Array.isArray(config.services)) throw new Error('Service registry is invalid');
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
        res.status(404).json({ error: 'Service not found' });
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
    res.status(error.statusCode || error.status || 500).json({ error: message || 'Operation failed' });
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
        if (!req.panelSession) return res.status(401).json({ error: 'Authentication required' });
        next();
    } catch (error) {
        next(error);
    }
}

function requireSameOrigin(req, res, next) {
    if (!requestOriginMatches(req)) return res.status(403).json({ error: 'Request origin rejected' });
    next();
}

function requireCsrf(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (!requestOriginMatches(req)) return res.status(403).json({ error: 'Request origin rejected' });
    const token = req.get('x-csrf-token') || '';
    const expected = req.panelSession.csrf;
    if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
        return res.status(403).json({ error: 'CSRF token rejected' });
    }
    next();
}

function loginLimit(req, res, next) {
    const ip = req.socket.remoteAddress || 'unknown';
    const entry = loginAttempts.get(ip);
    const now = Date.now();
    if (entry && entry.blockedUntil > now) return res.status(429).json({ error: 'Too many login attempts; try again later' });
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
    return `[Earlier output truncated]\n${text.slice(-maxLength)}`;
}

function cpuUsage() {
    const cpus = os.cpus();
    const current = cpus.reduce((total, cpu) => ({
        idle: total.idle + cpu.times.idle,
        total: total.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
    }), { idle: 0, total: 0 });
    const previous = previousCpuTimes;
    previousCpuTimes = current;
    if (!previous) return `Sampling (${cpus.length} cores)`;
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    const percent = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
    return `${percent}% (${cpus.length} cores)`;
}

async function githubInfo() {
    await runFile('gh', ['auth', 'status'], { timeout: 15000 });
    const [userResult, repoResult] = await Promise.all([
        runFile('gh', ['api', 'user', '--jq', '{login: .login, avatar_url: .avatar_url, name: .name}'], { timeout: 30000 }),
        runFile('gh', ['repo', 'list', '--limit', '1000', '--json', 'name,nameWithOwner,url,isPrivate,defaultBranchRef'], { timeout: 60000 })
    ]);
    return { user: JSON.parse(userResult.stdout), repos: JSON.parse(repoResult.stdout) };
}

async function assertOwnedContainer(name, id) {
    try {
        const result = await runFile('docker', [
            'inspect', '--format',
            '{{ index .Config.Labels "com.qorange.panel" }}|{{ index .Config.Labels "com.qorange.service" }}',
            name
        ], { timeout: 15000 });
        if (result.stdout.trim() !== `true|${id}`) {
            const error = new Error('A container with this name exists but is not managed by QOrange; it was left untouched');
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
        const error = new Error('Another operation for this service is already running');
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
    const logs = [`Starting deployment for ${service.name}.`];
    try {
        fs.mkdirSync(source);
        try {
            await runFile('gh', ['auth', 'status'], { timeout: 15000 });
        } catch (error) {
            throw new Error(`GitHub CLI unavailable or not authenticated: ${safeError(error, secrets)}`);
        }
        const endpoint = `repos/${service.repo}/tarball/${service.branch}`;
        logs.push('Downloading the selected GitHub branch.');
        await runFile('gh', ['api', '--header', 'Accept: application/vnd.github+json', '--output', archive, endpoint], { timeout: 5 * 60 * 1000 });
        await runFile('tar', ['-xzf', archive, '-C', source, '--strip-components=1'], { timeout: 5 * 60 * 1000 });
        logs.push('Building the application image.');
        const build = await runFile('docker', [
            'build', '--tag', `qorange-${service.id}:latest`,
            '--label', 'com.qorange.panel=true',
            '--label', `com.qorange.service=${service.id}`,
            source
        ], { timeout: 30 * 60 * 1000 });
        if (build.stdout) logs.push(build.stdout);
        if (build.stderr) logs.push(build.stderr);

        const exists = await assertOwnedContainer(name, service.id);
        if (exists) {
            await runFile('docker', ['stop', name], { timeout: 60000 });
            await runFile('docker', ['rm', name], { timeout: 60000 });
        }
        const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped',
            '--label', 'com.qorange.panel=true',
            '--label', `com.qorange.service=${service.id}`];
        if (service.port) args.push('--publish', service.port);
        if (Object.keys(env).length) args.push('--env-file', envFilePath(service.id));
        args.push(`qorange-${service.id}:latest`);
        const run = await runFile('docker', args, { timeout: 60000 });
        logs.push(`Container started: ${run.stdout.trim()}`);
        return limitOutput(redactSecrets(logs.join('\n'), secrets));
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
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
            return res.status(401).json({ error: 'Invalid password' });
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
        sendOperationError(res, new Error(`GitHub CLI unavailable or not authenticated: ${safeError(error)}`));
    }
});

app.get('/api/system', async (_req, res) => {
    try {
        const [dockerResult, diskResult] = await Promise.all([
            runFile('docker', ['ps', '-a', '--filter', 'label=com.qorange.panel=true', '--format', '{{.Names}}\t{{.Status}}']),
            runFile('df', ['-Pk', '/'], { timeout: 15000 })
        ]);
        const containerMap = new Map(dockerResult.stdout.trim().split('\n').filter(Boolean).map(line => {
            const [name, status] = line.split('\t');
            return [name, status];
        }));
        const services = readServices().map(service => {
            const statusRaw = containerMap.get(containerName(service.id)) || 'Not deployed';
            return {
                id: service.id,
                name: service.name,
                repo: service.repo,
                branch: service.branch,
                port: service.port,
                type: 'app',
                status: statusRaw === 'Not deployed' ? 'uninstalled' : statusRaw.startsWith('Up') ? 'running' : 'stopped',
                statusRaw
            };
        });
        const memoryTotal = os.totalmem();
        const memoryUsed = memoryTotal - os.freemem();
        const memory = `${Math.round(memoryUsed / 1024 / 1024)}/${Math.round(memoryTotal / 1024 / 1024)} MB (${Math.round(memoryUsed * 100 / memoryTotal)}%)`;
        const diskLines = diskResult.stdout.trim().split('\n');
        const disk = diskLines.length > 1 ? diskLines[1].trim().replace(/\s+/g, ' ') : 'Unavailable';
        res.json({ cpu: cpuUsage(), memory, disk, services });
    } catch (error) {
        sendOperationError(res, error);
    }
});

app.post('/api/services', async (req, res) => {
    try {
        const input = req.body || {};
        const service = validateService(input);
        const services = readServices();
        if (services.some(item => item.id === service.id)) return res.status(409).json({ error: 'Service ID already exists' });
        if (fs.existsSync(envFilePath(service.id))) return res.status(409).json({ error: 'An environment file already exists for this service ID' });
        if (input.env !== undefined && typeof input.env !== 'string') return res.status(400).json({ error: 'Environment variables must be text' });
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
        if (!readServices().some(service => service.id === id)) return res.status(404).json({ error: 'Service not found' });
        if (typeof req.body.env !== 'string' || Buffer.byteLength(req.body.env, 'utf8') > MAX_ENV_BYTES) {
            return res.status(400).json({ error: 'Environment variables must be text smaller than 64 KB' });
        }
        await withServiceLock(id, () => writeServiceEnv(id, req.body.env));
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ error: safeError(error) });
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
            return res.status(400).json({ error: 'Unsupported action' });
        }
        await withServiceLock(id, async () => {
            secrets = readServiceEnv(id);
            const name = containerName(id);
            if (action === 'build') {
                const logs = await performDeploy(service);
                res.json({ success: true, logs });
                return;
            }
            if (action === 'delete') {
                const exists = await assertOwnedContainer(name, id);
                if (exists) {
                    await runFile('docker', ['stop', name], { timeout: 60000 });
                    await runFile('docker', ['rm', name], { timeout: 60000 });
                }
                try { fs.unlinkSync(envFilePath(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                const services = readServices().filter(item => item.id !== id);
                writeServices(services);
                res.json({ success: true });
                return;
            }
            const exists = await assertOwnedContainer(name, id);
            if (!exists) {
                res.status(404).json({ error: 'Service container is not deployed' });
                return;
            }
            if (action === 'logs') {
                const result = await runFile('docker', ['logs', '--tail', '200', name], { timeout: 30000 });
                res.json({ logs: limitOutput(redactSecrets(`${result.stdout}${result.stderr}`, serviceSecrets(secrets))) });
                return;
            }
            const result = await runFile('docker', [action, name], { timeout: 60000 });
            res.json({ success: true, logs: limitOutput(redactSecrets(`${result.stdout}${result.stderr}`, serviceSecrets(secrets))) });
        });
    } catch (error) {
        sendOperationError(res, error, secrets);
    }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));
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

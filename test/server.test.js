'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qorange-server-test-'));
const dataDir = path.join(root, 'data');
const envDir = path.join(root, 'env');
const keyFile = path.join(root, 'session.key');
const authFile = path.join(root, 'auth.json');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(envDir, { recursive: true });
fs.writeFileSync(keyFile, crypto.randomBytes(32));
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync('test-admin-password-long-enough', salt, 64, { N: 16384, r: 8, p: 1 });
fs.writeFileSync(authFile, JSON.stringify({ algorithm: 'scrypt', salt: salt.toString('hex'), hash: hash.toString('hex') }), { mode: 0o600 });
process.env.DATA_DIR = dataDir;
process.env.ENV_DIR = envDir;
process.env.WORKSPACE_DIR = path.join(root, 'builds');
process.env.AUTH_FILE = authFile;
process.env.SESSION_KEY_FILE = keyFile;
process.env.BIND_ADDRESS = '127.0.0.1';
process.env.COOKIE_SECURE = '0';

const { app } = require('../app');
let server;
let baseUrl;

test('API authentication, origin, CSRF, and secret isolation', async t => {
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const origin = baseUrl;

    const unauthorized = await fetch(`${baseUrl}/api/github/info`);
    assert.equal(unauthorized.status, 401);

    const originRejected = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: JSON.stringify({ password: 'test-admin-password-long-enough' })
    });
    assert.equal(originRejected.status, 403);

    const failedLogin = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ password: 'incorrect password' })
    });
    assert.equal(failedLogin.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ password: 'test-admin-password-long-enough' })
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal(JSON.stringify(loginBody).includes('test-admin-password-long-enough'), false);

    const noCsrf = await fetch(`${baseUrl}/api/services`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'website', name: 'Website', repo: 'org/site', branch: 'main', env: 'TOKEN=do-not-return' })
    });
    assert.equal(noCsrf.status, 403);

    const invalidInput = await fetch(`${baseUrl}/api/services`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ id: 'website', name: 'Website', repo: 'org/site', branch: '../unsafe', env: 'TOKEN=not-echoed' })
    });
    const invalidInputBody = await invalidInput.json();
    assert.equal(invalidInput.status, 400);
    assert.match(invalidInputBody.error, /分支名称无效/);

    const secret = 'service-secret-never-in-response';
    const created = await fetch(`${baseUrl}/api/services`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ id: 'website', name: 'Website', repo: 'org/site', branch: 'main', env: `TOKEN=${secret}` })
    });
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    assert.equal(createdText.includes(secret), false);
    assert.equal(createdText.includes('env'), false);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'services.json'), 'utf8'));
    assert.equal(Object.hasOwn(stored.services[0], 'env'), false);
    assert.equal(fs.readFileSync(path.join(envDir, 'website.env'), 'utf8').includes(secret), true);
    assert.equal(fs.statSync(path.join(envDir, 'website.env')).mode & 0o777, 0o600);

    const replacementSecret = 'replacement-secret-never-returned';
    const replaced = await fetch(`${baseUrl}/api/services/website/env`, {
        method: 'PUT',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ env: `NEW_TOKEN=${replacementSecret}` })
    });
    const replacedText = await replaced.text();
    assert.equal(replaced.status, 200, replacedText);
    assert.equal(replacedText.includes(replacementSecret), false);
    const updatedEnv = fs.readFileSync(path.join(envDir, 'website.env'), 'utf8');
    assert.equal(updatedEnv.includes(replacementSecret), true);
    assert.equal(updatedEnv.includes(secret), false);

    const envListing = await fetch(`${baseUrl}/api/services/website/env`, { headers: { Cookie: cookie } });
    assert.equal(envListing.status, 404);
    assert.equal((await envListing.text()).includes(replacementSecret), false);

    const csrfFailure = await fetch(`${baseUrl}/api/services/website/action`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete' })
    });
    assert.equal(csrfFailure.status, 403);

    const staticPage = await fetch(`${baseUrl}/`);
    assert.equal(staticPage.status, 200);
    assert.match(staticPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await staticPage.text()).includes(secret), false);

    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
});

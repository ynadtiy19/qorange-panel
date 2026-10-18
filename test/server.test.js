'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
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
process.env.GITHUB_CLIENT_ID = 'QOrangeTestClientID1';
process.env.BIND_ADDRESS = '127.0.0.1';
process.env.COOKIE_SECURE = '0';
fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true });
const dockerStub = path.join(root, 'docker-stub.js');
fs.writeFileSync(dockerStub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (process.argv[2] === 'ps') {
    if (process.env.FAKE_DOCKER_FAIL === '1') {
        process.stderr.write('daemon unavailable');
        process.exit(1);
    }
    process.stdout.write(process.env.FAKE_DOCKER_PS || '');
}
if (process.argv[2] === 'version') process.stdout.write('27.0.3\\n');
if (process.argv[2] === 'inspect') {
    if (process.env.FAKE_DOCKER_INSPECT === 'missing') {
        process.stderr.write('Error response from daemon: No such container: ' + process.argv[5]);
        process.exit(1);
    }
    const owner = process.env.FAKE_DOCKER_INSPECT === 'unowned' ||
        (process.env.FAKE_DOCKER_UNOWNED_AFTER_RUN && fs.existsSync(process.env.FAKE_DOCKER_UNOWNED_AFTER_RUN))
        ? 'legacy'
        : process.env.FAKE_DOCKER_OWNER || 'website';
    process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|true|' + owner + '\\n');
}
if (['stop', 'rm'].includes(process.argv[2])) {
    if (process.env['FAKE_DOCKER_' + process.argv[2].toUpperCase() + '_MISSING'] === '1') {
        process.stderr.write('Error response from daemon: No such container: ' + process.argv[3]);
        process.exit(1);
    }
}
if (process.argv[2] === 'run') {
    if (process.env.FAKE_DOCKER_RUN_CONFLICT === '1') {
        if (process.env.FAKE_DOCKER_UNOWNED_AFTER_RUN) fs.writeFileSync(process.env.FAKE_DOCKER_UNOWNED_AFTER_RUN, 'unowned');
        process.stderr.write('Error response from daemon: Conflict. The container name "/' + process.argv[5] + '" is already in use.');
        process.exit(1);
    }
    process.stdout.write('fake-container-id\\n');
}
`);
fs.chmodSync(dockerStub, 0o700);
process.env.DOCKER_CLI_PATH = dockerStub;
const archiveSource = path.join(root, 'archive-source');
const archiveFile = path.join(root, 'repository.tar.gz');
fs.mkdirSync(archiveSource);
fs.writeFileSync(path.join(archiveSource, 'app.txt'), 'safe fixture source');
execFileSync('tar', ['-czf', archiveFile, '-C', archiveSource, '.']);
const githubApiCalls = [];
let deviceFlowNumber = 0;
const fakeGithubFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const authorization = options.headers && options.headers.Authorization;
    githubApiCalls.push({ url: parsed.href, authorization, method: options.method || 'GET' });
    if (parsed.pathname.endsWith('/login/oauth/device/code')) {
        deviceFlowNumber += 1;
        return new Response(JSON.stringify({
            device_code: `private-device-code-${deviceFlowNumber}`,
            user_code: `DEVICE-${deviceFlowNumber}`,
            verification_uri: 'https://github.com/login/device',
            expires_in: 600,
            interval: 1
        }));
    }
    if (parsed.pathname.endsWith('/login/oauth/access_token')) {
        if (process.env.FAKE_OAUTH_ERROR) {
            return new Response(JSON.stringify({ error: process.env.FAKE_OAUTH_ERROR }));
        }
        return new Response(JSON.stringify({ access_token: process.env.FAKE_OAUTH_TOKEN || '' }));
    }
    if (parsed.pathname === '/user') {
        const login = authorization && authorization.startsWith('Bearer alice-') ? 'alice'
            : authorization === 'Bearer bob-oauth-token-for-tests' ? 'bob' : 'public-user';
        return new Response(JSON.stringify({ login, name: login.toUpperCase() }));
    }
    if (parsed.pathname === '/user/repos') {
        const owner = authorization === 'Bearer bob-oauth-token-for-tests' ? 'bob' : 'alice';
        return new Response(JSON.stringify([{
            full_name: `${owner}/private-app`,
            name: 'private-app',
            html_url: `https://github.com/${owner}/private-app`,
            private: true,
            default_branch: 'main'
        }]));
    }
    if (/^\/repos\/[^/]+\/[^/]+\/branches$/.test(parsed.pathname)) {
        if (process.env.FAKE_BRANCH_FAIL === '1') return new Response('unavailable', { status: 503 });
        return new Response(JSON.stringify([{ name: 'main' }, { name: 'feature/pi' }]));
    }
    if (/^\/repos\/[^/]+\/[^/]+\/tarball\//.test(parsed.pathname)) {
        if (process.env.FAKE_GH_MODE === 'slow-success') await new Promise(resolve => setTimeout(resolve, 300));
        if (process.env.FAKE_GH_MODE === 'slow') {
            await new Promise(resolve => setTimeout(resolve, 300));
            return new Response(process.env.FAKE_GH_STDERR || 'archive download failed', { status: 503 });
        }
        if (process.env.FAKE_GH_MODE === 'success' || process.env.FAKE_GH_MODE === 'slow-success') {
            const stream = Readable.toWeb(fs.createReadStream(archiveFile));
            return new Response(stream, { headers: { 'Content-Length': String(fs.statSync(archiveFile).size) } });
        }
        return new Response('archive download failed', { status: 503 });
    }
    return new Response('not found', { status: 404 });
};

const { app, setGithubFetchForTests } = require('../app');
setGithubFetchForTests(fakeGithubFetch);
let server;
let baseUrl;

test('API authentication, origin, CSRF, and secret isolation', async t => {
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const origin = baseUrl;

    const unauthorized = await fetch(`${baseUrl}/api/github/accounts`);
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
    const protectedAccounts = await fetch(`${baseUrl}/api/github/accounts`);
    assert.equal(protectedAccounts.status, 401);
    assert.equal(protectedAccounts.headers.get('cache-control'), 'no-store');

    const csrfHeaders = {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': loginBody.csrfToken
    };
    const accountList = await fetch(`${baseUrl}/api/github/accounts`, { headers: { Cookie: cookie } });
    assert.equal(accountList.status, 200);
    assert.equal(accountList.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await accountList.json(), { clientConfigured: true, accounts: [] });
    const missingCsrfDevice = await fetch(`${baseUrl}/api/github/device`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal(missingCsrfDevice.status, 403);

    process.env.FAKE_OAUTH_TOKEN = 'alice-oauth-token-for-tests';
    const deviceResponse = await fetch(`${baseUrl}/api/github/device`, {
        method: 'POST',
        headers: csrfHeaders,
        body: '{}'
    });
    const deviceResponseText = await deviceResponse.text();
    assert.equal(deviceResponse.status, 200, deviceResponseText);
    assert.equal(deviceResponse.headers.get('cache-control'), 'no-store');
    const device = JSON.parse(deviceResponseText);
    assert.equal(device.userCode, 'DEVICE-1');
    assert.equal(device.verificationUri, 'https://github.com/login/device');
    assert.equal(deviceResponseText.includes('private-device-code'), false);
    assert.equal(deviceResponseText.includes('alice-oauth-token-for-tests'), false);
    const oauthCallsBeforePoll = githubApiCalls.filter(call => call.url.endsWith('/login/oauth/access_token')).length;
    const tooSoon = await fetch(`${baseUrl}/api/github/device/${device.deviceId}/poll`, {
        method: 'POST',
        headers: csrfHeaders,
        body: '{}'
    });
    assert.equal((await tooSoon.json()).status, 'pending');
    assert.equal(githubApiCalls.filter(call => call.url.endsWith('/login/oauth/access_token')).length, oauthCallsBeforePoll);
    await new Promise(resolve => setTimeout(resolve, 1050));
    const completedDevice = await fetch(`${baseUrl}/api/github/device/${device.deviceId}/poll`, {
        method: 'POST',
        headers: csrfHeaders,
        body: '{}'
    });
    const completedDeviceText = await completedDevice.text();
    assert.equal(completedDevice.status, 200, completedDeviceText);
    assert.match(completedDeviceText, /"login":"alice"/);
    assert.equal(completedDeviceText.includes('alice-oauth-token-for-tests'), false);
    const accountsFile = path.join(dataDir, 'github-accounts.json');
    const linkedAccountFile = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    assert.equal(fs.statSync(accountsFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(linkedAccountFile.accounts[0].token, 'alice-oauth-token-for-tests');
    const aliceAccountId = linkedAccountFile.accounts[0].id;
    const accountListing = await fetch(`${baseUrl}/api/github/accounts`, { headers: { Cookie: cookie } });
    const accountListingText = await accountListing.text();
    assert.equal(accountListingText.includes('alice-oauth-token-for-tests'), false);
    assert.match(accountListingText, /"login":"alice"/);

    const aliceRepositories = await fetch(`${baseUrl}/api/github/accounts/${aliceAccountId}/repositories`, {
        headers: { Cookie: cookie }
    });
    assert.deepEqual((await aliceRepositories.json()).repos.map(repo => repo.nameWithOwner), ['alice/private-app']);
    assert.equal(githubApiCalls.at(-1).authorization, 'Bearer alice-oauth-token-for-tests');
    const aliceBranches = await fetch(`${baseUrl}/api/github/branches?repo=alice%2Fprivate-app&accountId=${aliceAccountId}`, {
        headers: { Cookie: cookie }
    });
    assert.deepEqual((await aliceBranches.json()).branches, ['main', 'feature/pi']);
    assert.equal(githubApiCalls.at(-1).authorization, 'Bearer alice-oauth-token-for-tests');
    process.env.FAKE_BRANCH_FAIL = '1';
    const branchFailure = await fetch(`${baseUrl}/api/github/branches?repo=alice%2Fprivate-app&accountId=${aliceAccountId}`, {
        headers: { Cookie: cookie }
    });
    assert.equal(branchFailure.status, 502);
    assert.match((await branchFailure.json()).error, /503/);
    delete process.env.FAKE_BRANCH_FAIL;

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

    const aliceServiceResponse = await fetch(`${baseUrl}/api/services`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({
            id: 'private-alice',
            name: 'Alice Private App',
            repo: 'alice/private-app',
            branch: 'feature/pi',
            githubAccountId: aliceAccountId,
            env: ''
        })
    });
    assert.equal(aliceServiceResponse.status, 201, await aliceServiceResponse.text());
    let savedServices = JSON.parse(fs.readFileSync(path.join(dataDir, 'services.json'), 'utf8')).services;
    assert.equal(savedServices.find(service => service.id === 'private-alice').githubAccountId, aliceAccountId);
    assert.equal(githubApiCalls.at(-1).authorization, 'Bearer alice-oauth-token-for-tests');

    process.env.FAKE_OAUTH_TOKEN = 'bob-oauth-token-for-tests';
    const bobDeviceResponse = await fetch(`${baseUrl}/api/github/device`, {
        method: 'POST',
        headers: csrfHeaders,
        body: '{}'
    });
    const bobDevice = await bobDeviceResponse.json();
    await new Promise(resolve => setTimeout(resolve, 1050));
    const bobAuthorization = await fetch(`${baseUrl}/api/github/device/${bobDevice.deviceId}/poll`, {
        method: 'POST',
        headers: csrfHeaders,
        body: '{}'
    });
    const bobAuthorizationBody = await bobAuthorization.json();
    assert.equal(bobAuthorizationBody.account.login, 'bob');
    assert.equal(JSON.stringify(bobAuthorizationBody).includes('bob-oauth-token-for-tests'), false);
    const linkedAccounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8')).accounts;
    assert.equal(linkedAccounts.length, 2);
    const bobAccountId = linkedAccounts.find(account => account.login === 'bob').id;
    const bobServiceResponse = await fetch(`${baseUrl}/api/services`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({
            id: 'private-bob',
            name: 'Bob Private App',
            repo: 'bob/private-app',
            branch: 'main',
            githubAccountId: bobAccountId,
            env: ''
        })
    });
    assert.equal(bobServiceResponse.status, 201, await bobServiceResponse.text());
    savedServices = JSON.parse(fs.readFileSync(path.join(dataDir, 'services.json'), 'utf8')).services;
    assert.equal(savedServices.find(service => service.id === 'private-bob').githubAccountId, bobAccountId);
    assert.equal(githubApiCalls.at(-1).authorization, 'Bearer bob-oauth-token-for-tests');

    const duplicateService = await fetch(`${baseUrl}/api/services`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ id: 'website', name: 'Website copy', repo: 'org/site', branch: 'main', env: 'TOKEN=do-not-overwrite' })
    });
    const duplicateServiceBody = await duplicateService.json();
    assert.equal(duplicateService.status, 409);
    assert.match(duplicateServiceBody.error, /请使用列表中的现有服务/);
    assert.equal(fs.readFileSync(path.join(envDir, 'website.env'), 'utf8').includes('do-not-overwrite'), false);

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
    const envListingText = await envListing.text();
    assert.equal(envListing.status, 200);
    assert.equal(envListingText.includes(replacementSecret), false);
    assert.equal(envListingText.includes(secret), false);
    const envListingBody = JSON.parse(envListingText);
    assert.equal(envListingBody.environmentConfigured, true);
    assert.equal(envListingBody.environmentVariableCount, 1);
    assert.deepEqual(envListingBody.variables, [{
        key: 'NEW_TOKEN',
        maskedValue: '••••••',
        valuePresent: true,
        private: true
    }]);

    const revealUrl = `${baseUrl}/api/services/website/env/reveal`;
    const exportUrl = `${baseUrl}/api/services/website/env/export`;
    for (const url of [revealUrl, exportUrl]) {
        const unauthorizedSecretRead = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'NEW_TOKEN' })
        });
        assert.equal(unauthorizedSecretRead.status, 401);
        assert.equal(unauthorizedSecretRead.headers.get('cache-control'), 'no-store');

        const wrongOriginSecretRead = await fetch(url, {
            method: 'POST',
            headers: {
                Cookie: cookie,
                Origin: 'https://attacker.example',
                'Content-Type': 'application/json',
                'X-CSRF-Token': loginBody.csrfToken
            },
            body: JSON.stringify({ key: 'NEW_TOKEN' })
        });
        assert.equal(wrongOriginSecretRead.status, 403);

        const missingCsrfSecretRead = await fetch(url, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'NEW_TOKEN' })
        });
        assert.equal(missingCsrfSecretRead.status, 403);
    }

    const revealed = await fetch(revealUrl, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ key: 'NEW_TOKEN' })
    });
    assert.equal(revealed.status, 200);
    assert.equal(revealed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await revealed.json(), { value: replacementSecret });

    const exported = await fetch(exportUrl, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: '{}'
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await exported.json(), { env: `NEW_TOKEN=${replacementSecret}\n` });

    const addedSecret = 'new-variable-secret-never-returned';
    const added = await fetch(`${baseUrl}/api/services/website/env`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ key: 'EXTRA', value: addedSecret })
    });
    const addedText = await added.text();
    assert.equal(added.status, 201, addedText);
    assert.equal(addedText.includes(addedSecret), false);
    const duplicateVariable = await fetch(`${baseUrl}/api/services/website/env`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ key: 'EXTRA', value: 'duplicate-secret-never-returned' })
    });
    const duplicateVariableText = await duplicateVariable.text();
    assert.equal(duplicateVariable.status, 409);
    assert.equal(duplicateVariableText.includes('duplicate-secret-never-returned'), false);
    assert.match(duplicateVariableText, /已存在/);

    const keyUrl = `${baseUrl}/api/services/website/env/NEW_TOKEN`;
    const keyUpdated = await fetch(keyUrl, {
        method: 'PUT',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ value: 'updated-secret-never-returned' })
    });
    const keyUpdatedText = await keyUpdated.text();
    assert.equal(keyUpdated.status, 200, keyUpdatedText);
    assert.equal(keyUpdatedText.includes('updated-secret-never-returned'), false);
    const deleted = await fetch(`${baseUrl}/api/services/website/env/EXTRA`, {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': loginBody.csrfToken }
    });
    assert.equal(deleted.status, 200);
    assert.equal(fs.readFileSync(path.join(envDir, 'website.env'), 'utf8').includes(addedSecret), false);

    const systemRequest = () => fetch(`${baseUrl}/api/system`, { headers: { Cookie: cookie } });
    const initialSystem = await systemRequest();
    const initialSystemText = await initialSystem.text();
    assert.equal(initialSystem.status, 200, initialSystemText);
    const initialSystemBody = JSON.parse(initialSystemText);
    assert.equal(typeof initialSystemBody.system.hostname, 'string');
    assert.equal(typeof initialSystemBody.system.cpu.cores, 'number');
    assert.equal(typeof initialSystemBody.system.memory.percent, 'number');
    assert.equal(typeof initialSystemBody.system.disk.available, 'boolean');
    assert.equal(initialSystemBody.panel.status, 'running');
    assert.equal(initialSystemBody.docker.status, 'running');
    assert.equal(initialSystemBody.docker.version, '27.0.3');
    assert.equal(Array.isArray(initialSystemBody.managedContainers), true);
    assert.equal(initialSystemText.includes('process.env'), false);
    const initialService = initialSystemBody.services[0];
    assert.equal(initialService.status, 'uninstalled');
    assert.equal(initialService.environmentConfigured, true);
    assert.equal(initialService.environmentVariableCount, 1);
    assert.equal(initialSystemText.includes('updated-secret-never-returned'), false);
    assert.equal(initialSystemText.includes('replacement-secret-never-returned'), false);

    process.env.FAKE_DOCKER_FAIL = '1';
    const unavailableDocker = await systemRequest();
    const unavailableDockerBody = await unavailableDocker.json();
    assert.equal(unavailableDockerBody.docker.status, 'unavailable');
    assert.equal(unavailableDockerBody.services[0].status, 'unknown');
    assert.deepEqual(unavailableDockerBody.managedContainers, []);
    process.env.FAKE_DOCKER_FAIL = '0';

    const deploymentRegistry = path.join(dataDir, 'services.json');
    const registry = JSON.parse(fs.readFileSync(deploymentRegistry, 'utf8'));
    registry.services[0].deployment = {
        status: 'deploying',
        lastAttemptAt: '2026-10-18T09:59:00.000Z',
        lastSuccessAt: null
    };
    fs.writeFileSync(deploymentRegistry, JSON.stringify(registry));
    const interruptedSystem = await systemRequest();
    assert.equal((await interruptedSystem.json()).services[0].status, 'failed');
    assert.equal(JSON.parse(fs.readFileSync(deploymentRegistry, 'utf8')).services[0].deployment.status, 'failed');

    registry.services[0].deployment = {
        status: 'failed',
        lastAttemptAt: '2026-10-18T10:00:00.000Z',
        lastSuccessAt: null
    };
    fs.writeFileSync(deploymentRegistry, JSON.stringify(registry));
    process.env.FAKE_DOCKER_PS = '';
    const failedSystem = await systemRequest();
    assert.equal((await failedSystem.json()).services[0].status, 'failed');

    registry.services[0].deployment = {
        status: 'succeeded',
        lastAttemptAt: '2026-10-18T10:00:00.000Z',
        lastSuccessAt: '2026-10-18T10:01:00.000Z'
    };
    fs.writeFileSync(deploymentRegistry, JSON.stringify(registry));
    const missingSystem = await systemRequest();
    const missingService = (await missingSystem.json()).services[0];
    assert.equal(missingService.status, 'missing');
    assert.equal(missingService.lastSuccessfulDeploymentAt, '2026-10-18T10:01:00.000Z');

    process.env.FAKE_DOCKER_PS = 'qorange-website\tUp 2 minutes\t0.0.0.0:8080->3000/tcp\n';
    const runningSystem = await systemRequest();
    const runningSystemBody = await runningSystem.json();
    assert.equal(runningSystemBody.services[0].status, 'running');
    assert.equal(runningSystemBody.services[0].containerPorts, '0.0.0.0:8080->3000/tcp');
    assert.deepEqual(runningSystemBody.managedContainers, [{
        name: 'qorange-website',
        status: 'Up 2 minutes',
        running: true,
        ports: '0.0.0.0:8080->3000/tcp'
    }]);

    process.env.FAKE_DOCKER_PS = '';
    process.env.FAKE_GH_MODE = 'slow-success';
    const successfulBuildRequest = fetch(`${baseUrl}/api/services/website/action`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ action: 'build' })
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = JSON.parse(fs.readFileSync(deploymentRegistry, 'utf8')).services[0];
        if (current.deployment.status === 'deploying') break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const inProgressSystem = await systemRequest();
    assert.equal((await inProgressSystem.json()).services[0].status, 'deploying');
    const successfulBuildResponse = await successfulBuildRequest;
    const successfulBuildText = await successfulBuildResponse.text();
    assert.equal(successfulBuildResponse.status, 200, successfulBuildText);
    assert.equal(successfulBuildText.includes('updated-secret-never-returned'), false);
    const publicArchiveRequest = githubApiCalls.findLast(call =>
        call.url.includes('/repos/org/site/tarball/main'));
    assert.ok(publicArchiveRequest);
    assert.equal(publicArchiveRequest.authorization, undefined);
    const successfulDeployment = JSON.parse(fs.readFileSync(deploymentRegistry, 'utf8')).services[0].deployment;
    assert.equal(successfulDeployment.status, 'succeeded');
    assert.ok(Date.parse(successfulDeployment.lastSuccessAt));
    let successfulDeploymentAt = successfulDeployment.lastSuccessAt;
    process.env.FAKE_DOCKER_PS = 'qorange-website\tUp 2 minutes\n';
    const deployedSystem = await systemRequest();
    const deployedService = (await deployedSystem.json()).services[0];
    assert.equal(deployedService.status, 'running');
    assert.equal(deployedService.deploymentStatus, 'succeeded');
    assert.equal(deployedService.lastSuccessfulDeploymentAt, successfulDeploymentAt);

    const buildService = () => fetch(`${baseUrl}/api/services/website/action`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ action: 'build' })
    });
    const dockerLog = path.join(root, 'docker-operations.jsonl');
    process.env.FAKE_DOCKER_LOG = dockerLog;
    process.env.FAKE_DOCKER_INSPECT = 'missing';
    const deployWithoutExistingContainer = await buildService();
    const deployWithoutExistingContainerText = await deployWithoutExistingContainer.text();
    assert.equal(deployWithoutExistingContainer.status, 200, deployWithoutExistingContainerText);
    successfulDeploymentAt = JSON.parse(fs.readFileSync(deploymentRegistry, 'utf8')).services[0].deployment.lastSuccessAt;
    let dockerOperations = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dockerOperations.map(args => args[0]), ['build', 'inspect', 'run']);

    fs.writeFileSync(dockerLog, '');
    delete process.env.FAKE_DOCKER_INSPECT;
    process.env.FAKE_DOCKER_STOP_MISSING = '1';
    process.env.FAKE_DOCKER_RM_MISSING = '1';
    const deployAfterContainerDisappears = await buildService();
    const deployAfterContainerDisappearsText = await deployAfterContainerDisappears.text();
    assert.equal(deployAfterContainerDisappears.status, 200, deployAfterContainerDisappearsText);
    successfulDeploymentAt = JSON.parse(fs.readFileSync(deploymentRegistry, 'utf8')).services[0].deployment.lastSuccessAt;
    dockerOperations = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dockerOperations.map(args => args[0]), ['build', 'inspect', 'stop', 'rm', 'run']);
    assert.equal(dockerOperations[2][1], 'a'.repeat(64));
    assert.equal(dockerOperations[3][1], 'a'.repeat(64));
    delete process.env.FAKE_DOCKER_STOP_MISSING;
    delete process.env.FAKE_DOCKER_RM_MISSING;

    fs.writeFileSync(dockerLog, '');
    process.env.FAKE_DOCKER_INSPECT = 'unowned';
    const deployWithUnownedContainer = await buildService();
    const deployWithUnownedContainerText = await deployWithUnownedContainer.text();
    assert.equal(deployWithUnownedContainer.status, 409, deployWithUnownedContainerText);
    assert.match(deployWithUnownedContainerText, /手动检查并重命名或移除/);
    dockerOperations = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dockerOperations.map(args => args[0]), ['build', 'inspect']);

    fs.writeFileSync(dockerLog, '');
    const unownedAfterRunPath = path.join(root, 'unowned-after-run');
    delete process.env.FAKE_DOCKER_INSPECT;
    process.env.FAKE_DOCKER_RUN_CONFLICT = '1';
    process.env.FAKE_DOCKER_UNOWNED_AFTER_RUN = unownedAfterRunPath;
    const deployWithRacingUnownedContainer = await buildService();
    const deployWithRacingUnownedContainerText = await deployWithRacingUnownedContainer.text();
    assert.equal(deployWithRacingUnownedContainer.status, 409, deployWithRacingUnownedContainerText);
    assert.match(deployWithRacingUnownedContainerText, /手动检查并重命名或移除/);
    dockerOperations = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dockerOperations.map(args => args[0]), ['build', 'inspect', 'stop', 'rm', 'run', 'inspect']);
    assert.equal(fs.existsSync(unownedAfterRunPath), true);
    delete process.env.FAKE_DOCKER_RUN_CONFLICT;
    delete process.env.FAKE_DOCKER_UNOWNED_AFTER_RUN;
    fs.unlinkSync(unownedAfterRunPath);

    process.env.FAKE_GH_MODE = 'success';
    process.env.FAKE_DOCKER_OWNER = 'private-bob';
    const privateBuild = await fetch(`${baseUrl}/api/services/private-bob/action`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({ action: 'build' })
    });
    const privateBuildText = await privateBuild.text();
    assert.equal(privateBuild.status, 200, privateBuildText);
    const bobArchiveRequest = githubApiCalls.findLast(call =>
        call.url.includes('/repos/bob/private-app/tarball/main'));
    assert.ok(bobArchiveRequest);
    assert.equal(bobArchiveRequest.authorization, 'Bearer bob-oauth-token-for-tests');
    const selectedAccountSystem = await systemRequest();
    const selectedAccountServices = (await selectedAccountSystem.json()).services;
    assert.equal(selectedAccountServices.find(service => service.id === 'private-bob').githubAccountLogin, 'bob');
    assert.equal(selectedAccountServices.find(service => service.id === 'private-alice').githubAccountLogin, 'alice');

    const unlinkAlice = await fetch(`${baseUrl}/api/github/accounts/${aliceAccountId}`, {
        method: 'DELETE',
        headers: csrfHeaders
    });
    assert.equal(unlinkAlice.status, 200);
    const storedAccountsAfterUnlink = JSON.parse(fs.readFileSync(accountsFile, 'utf8')).accounts;
    const aliceDisconnected = storedAccountsAfterUnlink.find(account => account.id === aliceAccountId);
    assert.equal(Object.hasOwn(aliceDisconnected, 'token'), false);
    const accountsAfterUnlinkResponse = await fetch(`${baseUrl}/api/github/accounts`, { headers: { Cookie: cookie } });
    const accountsAfterUnlinkText = await accountsAfterUnlinkResponse.text();
    assert.equal(accountsAfterUnlinkText.includes('alice'), false);
    assert.equal(accountsAfterUnlinkText.includes('alice-oauth-token-for-tests'), false);
    const servicesAfterUnlink = JSON.parse(fs.readFileSync(path.join(dataDir, 'services.json'), 'utf8')).services;
    assert.equal(servicesAfterUnlink.find(service => service.id === 'private-alice').githubAccountId, aliceAccountId);
    const unlinkedServiceStatus = await systemRequest();
    const unlinkedService = (await unlinkedServiceStatus.json()).services.find(service => service.id === 'private-alice');
    assert.equal(unlinkedService.githubAccountId, aliceAccountId);
    assert.equal(unlinkedService.githubAccountLogin, null);
    process.env.FAKE_OAUTH_TOKEN = 'alice-reconnected-oauth-token';
    const reconnectDeviceResponse = await fetch(`${baseUrl}/api/github/device`, {
        method: 'POST',
        headers: csrfHeaders,
        body: '{}'
    });
    const reconnectDevice = await reconnectDeviceResponse.json();
    await new Promise(resolve => setTimeout(resolve, 1050));
    const reconnectResult = await fetch(`${baseUrl}/api/github/device/${reconnectDevice.deviceId}/poll`, {
        method: 'POST',
        headers: csrfHeaders,
        body: '{}'
    });
    const reconnectAccount = (await reconnectResult.json()).account;
    assert.equal(reconnectAccount.id, aliceAccountId);
    const reconnectedSystem = await systemRequest();
    const reconnectedService = (await reconnectedSystem.json()).services.find(service => service.id === 'private-alice');
    assert.equal(reconnectedService.githubAccountLogin, 'alice');

    process.env.FAKE_DOCKER_PS = '';
    process.env.FAKE_GH_MODE = 'slow';
    process.env.FAKE_GH_STDERR = `archive failed while using ${'updated-secret-never-returned'}`;
    const buildRequest = fetch(`${baseUrl}/api/services/website/action`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ action: 'build' })
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = JSON.parse(fs.readFileSync(deploymentRegistry, 'utf8')).services[0];
        if (current.deployment.status === 'deploying') break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const failingInProgressSystem = await systemRequest();
    assert.equal((await failingInProgressSystem.json()).services[0].status, 'deploying');
    const buildResponse = await buildRequest;
    const buildResponseText = await buildResponse.text();
    assert.equal(buildResponse.status, 502, buildResponseText);
    assert.equal(buildResponseText.includes('updated-secret-never-returned'), false);
    const failedBuild = JSON.parse(fs.readFileSync(deploymentRegistry, 'utf8')).services[0].deployment;
    assert.equal(failedBuild.status, 'failed');
    assert.equal(failedBuild.lastSuccessAt, successfulDeploymentAt);

    const deleteLastVariable = await fetch(`${baseUrl}/api/services/website/env/NEW_TOKEN`, {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': loginBody.csrfToken }
    });
    assert.equal(deleteLastVariable.status, 200);
    const emptyEnvironment = await fetch(`${baseUrl}/api/services/website/env`, { headers: { Cookie: cookie } });
    const emptyEnvironmentBody = await emptyEnvironment.json();
    assert.equal(emptyEnvironmentBody.environmentConfigured, false);
    assert.equal(emptyEnvironmentBody.environmentVariableCount, 0);
    assert.deepEqual(emptyEnvironmentBody.variables, []);

    const csrfFailure = await fetch(`${baseUrl}/api/services/website/action`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete' })
    });
    assert.equal(csrfFailure.status, 403);

    const deploymentRegistryPath = path.join(dataDir, 'services.json');
    const registerForDeleteTest = id => {
        const config = JSON.parse(fs.readFileSync(deploymentRegistryPath, 'utf8'));
        config.services.push({
            id,
            name: id,
            repo: 'org/site',
            branch: 'main',
            port: '',
            deployment: { status: 'failed', lastAttemptAt: '2026-10-18T10:00:00.000Z', lastSuccessAt: null }
        });
        fs.writeFileSync(deploymentRegistryPath, JSON.stringify(config));
        fs.writeFileSync(path.join(envDir, `${id}.env`), `TOKEN=${id}-secret\n`, { mode: 0o600 });
    };
    const deleteService = id => fetch(`${baseUrl}/api/services/${id}/action`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ action: 'delete' })
    });
    fs.writeFileSync(dockerLog, '');
    process.env.FAKE_DOCKER_OWNER = 'orphaned';
    process.env.FAKE_DOCKER_INSPECT = 'missing';
    registerForDeleteTest('orphaned');
    const missingContainerDelete = await deleteService('orphaned');
    const missingContainerDeleteText = await missingContainerDelete.text();
    assert.equal(missingContainerDelete.status, 200, missingContainerDeleteText);
    let deleteRecords = JSON.parse(fs.readFileSync(deploymentRegistryPath, 'utf8')).services;
    assert.equal(deleteRecords.some(service => service.id === 'orphaned'), false);
    assert.equal(fs.existsSync(path.join(envDir, 'orphaned.env')), false);
    dockerOperations = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dockerOperations.map(args => args[0]), ['inspect']);

    fs.writeFileSync(dockerLog, '');
    process.env.FAKE_DOCKER_OWNER = 'vanishing';
    process.env.FAKE_DOCKER_INSPECT = '';
    process.env.FAKE_DOCKER_STOP_MISSING = '1';
    process.env.FAKE_DOCKER_RM_MISSING = '1';
    registerForDeleteTest('vanishing');
    const vanishedContainerDelete = await deleteService('vanishing');
    const vanishedContainerDeleteText = await vanishedContainerDelete.text();
    assert.equal(vanishedContainerDelete.status, 200, vanishedContainerDeleteText);
    deleteRecords = JSON.parse(fs.readFileSync(deploymentRegistryPath, 'utf8')).services;
    assert.equal(deleteRecords.some(service => service.id === 'vanishing'), false);
    assert.equal(fs.existsSync(path.join(envDir, 'vanishing.env')), false);
    dockerOperations = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dockerOperations.map(args => args[0]), ['inspect', 'stop', 'rm']);
    assert.ok(dockerOperations.slice(1).every(args => args[1] === 'a'.repeat(64)));
    delete process.env.FAKE_DOCKER_STOP_MISSING;
    delete process.env.FAKE_DOCKER_RM_MISSING;

    fs.writeFileSync(dockerLog, '');
    process.env.FAKE_DOCKER_OWNER = 'protected';
    process.env.FAKE_DOCKER_INSPECT = 'unowned';
    registerForDeleteTest('protected');
    const mongoData = path.join(root, 'mongo-data');
    fs.mkdirSync(mongoData);
    fs.writeFileSync(path.join(mongoData, 'sentinel'), 'preserve existing database data');
    const protectedContainerDelete = await deleteService('protected');
    const protectedContainerDeleteText = await protectedContainerDelete.text();
    assert.equal(protectedContainerDelete.status, 409, protectedContainerDeleteText);
    assert.equal(JSON.parse(protectedContainerDeleteText).code, 'UNOWNED_CONTAINER');
    deleteRecords = JSON.parse(fs.readFileSync(deploymentRegistryPath, 'utf8')).services;
    assert.equal(deleteRecords.some(service => service.id === 'protected'), true);
    assert.equal(fs.existsSync(path.join(envDir, 'protected.env')), true);
    assert.equal(fs.readFileSync(path.join(mongoData, 'sentinel'), 'utf8'), 'preserve existing database data');
    dockerOperations = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dockerOperations.map(args => args[0]), ['inspect']);

    fs.writeFileSync(dockerLog, '');
    const confirmedUnownedContainerDelete = await fetch(`${baseUrl}/api/services/protected/action`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ action: 'delete', preserveUnownedContainer: true })
    });
    const confirmedUnownedContainerDeleteText = await confirmedUnownedContainerDelete.text();
    assert.equal(confirmedUnownedContainerDelete.status, 200, confirmedUnownedContainerDeleteText);
    assert.equal(JSON.parse(confirmedUnownedContainerDeleteText).containerPreserved, true);
    deleteRecords = JSON.parse(fs.readFileSync(deploymentRegistryPath, 'utf8')).services;
    assert.equal(deleteRecords.some(service => service.id === 'protected'), false);
    assert.equal(fs.existsSync(path.join(envDir, 'protected.env')), false);
    assert.equal(fs.readFileSync(path.join(mongoData, 'sentinel'), 'utf8'), 'preserve existing database data');
    dockerOperations = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dockerOperations.map(args => args[0]), ['inspect']);

    fs.writeFileSync(dockerLog, '');
    process.env.FAKE_DOCKER_OWNER = 'racing-owned';
    process.env.FAKE_DOCKER_INSPECT = '';
    registerForDeleteTest('racing-owned');
    const ownershipChangedDelete = await fetch(`${baseUrl}/api/services/racing-owned/action`, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
            'X-CSRF-Token': loginBody.csrfToken
        },
        body: JSON.stringify({ action: 'delete', preserveUnownedContainer: true })
    });
    const ownershipChangedDeleteText = await ownershipChangedDelete.text();
    assert.equal(ownershipChangedDelete.status, 409, ownershipChangedDeleteText);
    assert.match(ownershipChangedDeleteText, /现已由 QOrange 管理/);
    deleteRecords = JSON.parse(fs.readFileSync(deploymentRegistryPath, 'utf8')).services;
    assert.equal(deleteRecords.some(service => service.id === 'racing-owned'), true);
    assert.equal(fs.existsSync(path.join(envDir, 'racing-owned.env')), true);
    dockerOperations = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(dockerOperations.map(args => args[0]), ['inspect']);

    const staticPage = await fetch(`${baseUrl}/`);
    assert.equal(staticPage.status, 200);
    assert.match(staticPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const staticContent = await staticPage.text();
    assert.equal(staticContent.includes(secret), false);
    assert.deepEqual([...staticContent.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]), ['server', 'projects']);
    assert.match(staticContent, /id="server-view"/);
    assert.match(staticContent, /id="projects-view"/);
    assert.doesNotMatch(staticContent, /placeholder-view|data-view="(?:ssh|monitoring|status|upgrade|firewall|collaborators|settings)"/);
    const clientScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(clientScript, /const selectedView = view === 'projects' \? 'projects' : 'server'/);
    assert.match(clientScript, /preserveUnownedContainer: true/);
    assert.match(clientScript, /不会停止或删除该容器/);

});

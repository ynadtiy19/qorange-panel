'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    downloadGithubArchiveForAccount,
    startDeviceAuthorization,
    pollDeviceAuthorization,
    githubCurrentUser,
    githubRepositories,
    githubBranches,
    requireClientId
} = require('../lib/github');

const clientId = 'QOrangeTestClientID1';

test('requires an explicitly configured GitHub OAuth client ID', () => {
    assert.equal(requireClientId(clientId), clientId);
    assert.throws(() => requireClientId(''), /GITHUB_CLIENT_ID/);
    assert.throws(() => requireClientId('weak-default'), /GITHUB_CLIENT_ID/);
});

test('starts device flow with repo scope and validates the verification destination', async () => {
    let sent;
    const authorization = await startDeviceAuthorization(clientId, {
        fetchImpl: async (url, options) => {
            sent = {
                url,
                body: Object.fromEntries(new URLSearchParams(options.body)),
                method: options.method,
                contentType: options.headers['Content-Type'],
                accept: options.headers.Accept
            };
            return new Response(JSON.stringify({
                device_code: 'device-code-private',
                user_code: 'ABCD-EFGH',
                verification_uri: 'https://github.com/login/device',
                expires_in: 900,
                interval: 5
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
    });
    assert.equal(sent.url, 'https://github.com/login/oauth/device/code');
    assert.equal(sent.method, 'POST');
    assert.equal(sent.contentType, 'application/x-www-form-urlencoded');
    assert.equal(sent.accept, 'application/json');
    assert.deepEqual(sent.body, { client_id: clientId, scope: 'repo' });
    assert.deepEqual(authorization, {
        deviceCode: 'device-code-private',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5
    });

    await assert.rejects(startDeviceAuthorization(clientId, {
        fetchImpl: async () => new Response(JSON.stringify({
            device_code: 'private',
            user_code: 'ABCD',
            verification_uri: 'https://attacker.example/device',
            expires_in: 900,
            interval: 5
        }))
    }), /untrusted verification URI/);
});

test('maps device polling pending, slowdown, expired, denied, and authorized outcomes', async () => {
    const responses = [
        { error: 'authorization_pending' },
        { error: 'slow_down' },
        { error: 'expired_token' },
        { error: 'access_denied' },
        { access_token: 'gho_private_access_token_1234567890' }
    ];
    let index = 0;
    const fetchImpl = async (_url, options) => {
        assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
        const body = Object.fromEntries(new URLSearchParams(options.body));
        assert.equal(body.client_id, clientId);
        assert.equal(body.device_code, 'device-code');
        assert.equal(body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
        return new Response(JSON.stringify(responses[index++]));
    };
    assert.deepEqual(await pollDeviceAuthorization(clientId, 'device-code', { fetchImpl }), { status: 'pending' });
    assert.deepEqual(await pollDeviceAuthorization(clientId, 'device-code', { fetchImpl }), { status: 'slow_down' });
    assert.deepEqual(await pollDeviceAuthorization(clientId, 'device-code', { fetchImpl }), { status: 'expired' });
    assert.deepEqual(await pollDeviceAuthorization(clientId, 'device-code', { fetchImpl }), { status: 'denied' });
    assert.deepEqual(await pollDeviceAuthorization(clientId, 'device-code', { fetchImpl }), {
        status: 'authorized',
        accessToken: 'gho_private_access_token_1234567890'
    });
});

test('reports safe actionable OAuth errors for non-JSON and rejected responses', async () => {
    const privateResponseText = 'device_code=private-device-code client_secret=private-secret access_token=private-token';
    const cases = [
        {
            response: new Response(privateResponseText, { status: 502 }),
            expected: /non-JSON OAuth response \(HTTP 502\).*Device Flow.*GITHUB_CLIENT_ID/
        },
        {
            response: new Response(JSON.stringify({
                error: 'device_flow_disabled',
                error_description: privateResponseText
            }), { status: 200 }),
            expected: /Enable Device Flow.*GITHUB_CLIENT_ID/
        },
        {
            response: new Response(JSON.stringify({
                error: 'incorrect_client_credentials',
                error_description: privateResponseText
            }), { status: 401 }),
            expected: /rejected the OAuth Client ID \(HTTP 401\).*GITHUB_CLIENT_ID/
        },
        {
            response: new Response(JSON.stringify({ message: privateResponseText }), { status: 503 }),
            expected: /GitHub OAuth request failed \(HTTP 503\).*Device Flow/
        }
    ];
    for (const { response, expected } of cases) {
        await assert.rejects(
            startDeviceAuthorization(clientId, { fetchImpl: async () => response }),
            error => {
                assert.match(error.message, expected);
                assert.equal(error.message.includes('private-device-code'), false);
                assert.equal(error.message.includes('private-secret'), false);
                assert.equal(error.message.includes('private-token'), false);
                return true;
            }
        );
    }
});

test('repository and branch API requests use only their selected account token', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, authorization: options.headers.Authorization });
        if (url.includes('/user/repos?')) {
            return new Response(JSON.stringify([{
                full_name: 'private-owner/private-repo',
                name: 'private-repo',
                html_url: 'https://github.com/private-owner/private-repo',
                private: true,
                default_branch: 'release'
            }]));
        }
        if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'alice', name: 'Alice' }));
        return new Response(JSON.stringify([{ name: 'main' }, { name: 'release/2026' }]));
    };
    const repositories = await githubRepositories('account-one-token', { fetchImpl });
    const branches = await githubBranches('private-owner/private-repo', 'account-two-token', { fetchImpl });
    const identity = await githubCurrentUser('account-two-token', { fetchImpl });
    assert.deepEqual(repositories, [{
        nameWithOwner: 'private-owner/private-repo',
        name: 'private-repo',
        url: 'https://github.com/private-owner/private-repo',
        isPrivate: true,
        defaultBranch: 'release'
    }]);
    assert.deepEqual(branches, ['main', 'release/2026']);
    assert.deepEqual(identity, { login: 'alice', name: 'Alice' });
    assert.deepEqual(calls.map(call => call.authorization), [
        'Bearer account-one-token',
        'Bearer account-two-token',
        'Bearer account-two-token'
    ]);
    await assert.rejects(githubBranches('../private-repo', null, { fetchImpl }), /owner\/repository/);
});

test('downloads selected-account private archives to a bounded mode-0600 file without token leakage', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qorange-oauth-archive-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const archivePath = path.join(root, 'repository.tar.gz');
    let request;
    await downloadGithubArchiveForAccount('private-owner/private-repo', 'release/2026', 'selected-token-secret', archivePath, {
        fetchImpl: async (url, options) => {
            request = { url, authorization: options.headers.Authorization };
            return new Response(Buffer.from([0, 1, 2, 255]));
        }
    });
    assert.equal(request.url, 'https://api.github.com/repos/private-owner/private-repo/tarball/release%2F2026');
    assert.equal(request.authorization, 'Bearer selected-token-secret');
    assert.deepEqual(fs.readFileSync(archivePath), Buffer.from([0, 1, 2, 255]));
    assert.equal(fs.statSync(archivePath).mode & 0o777, 0o600);

    const failedPath = path.join(root, 'failed.tar.gz');
    const token = 'do-not-include-this-token';
    await assert.rejects(
        downloadGithubArchiveForAccount('owner/private', 'main', token, failedPath, {
            fetchImpl: async () => new Response(`failure with ${token}`, { status: 500 })
        }),
        error => {
            assert.match(error.message, /500/);
            assert.equal(error.message.includes(token), false);
            return true;
        }
    );
    assert.equal(fs.existsSync(failedPath), false);

    await assert.rejects(
        downloadGithubArchiveForAccount('owner/private', 'main', null, path.join(root, 'large.tar.gz'), {
            maxBytes: 2,
            fetchImpl: async () => new Response(Buffer.alloc(3))
        }),
        /exceeds the 2-byte limit/
    );

    const timedOutPath = path.join(root, 'timed-out.tar.gz');
    await assert.rejects(
        downloadGithubArchiveForAccount('owner/private', 'main', null, timedOutPath, {
            timeout: 20,
            fetchImpl: (_url, options) => new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
                setTimeout(() => resolve(new Response('late')), 100);
            })
        }),
        /timed out after 20ms/
    );
    assert.equal(fs.existsSync(timedOutPath), false);
});

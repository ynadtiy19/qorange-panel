'use strict';

const fs = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { validateBranch } = require('./core');

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const API_BASE = 'https://api.github.com';
const OAUTH_BASE = 'https://github.com/login/oauth';

function requireClientId(clientId) {
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_]{20}$/.test(clientId)) {
        const error = new Error('GitHub OAuth Client ID is not configured; set GITHUB_CLIENT_ID in the panel environment.');
        error.statusCode = 503;
        throw error;
    }
    return clientId;
}

async function responseJson(response) {
    try {
        return await response.json();
    } catch {
        throw new Error('GitHub returned an invalid response.');
    }
}

async function oauthPost(url, fields, options = {}) {
    const response = await (options.fetchImpl || globalThis.fetch)(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(options.timeout || 15000),
        redirect: 'error'
    });
    const data = await responseJson(response);
    if (!response.ok && !data.error) throw new Error(`GitHub OAuth request failed (${response.status}).`);
    return data;
}

async function startDeviceAuthorization(clientId, options = {}) {
    const data = await oauthPost(`${OAUTH_BASE}/device/code`, {
        client_id: requireClientId(clientId),
        scope: 'repo'
    }, options);
    if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string' ||
        typeof data.verification_uri !== 'string' || !Number.isFinite(data.expires_in) ||
        !Number.isFinite(data.interval)) {
        throw new Error('GitHub returned incomplete device authorization details.');
    }
    let verification;
    try {
        verification = new URL(data.verification_uri);
    } catch {
        throw new Error('GitHub returned an invalid verification URI.');
    }
    if (verification.protocol !== 'https:' || verification.hostname !== 'github.com') {
        throw new Error('GitHub returned an untrusted verification URI.');
    }
    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: verification.href,
        expiresIn: Math.min(Math.max(Math.floor(data.expires_in), 1), 1800),
        interval: Math.min(Math.max(Math.floor(data.interval), 1), 60)
    };
}

async function pollDeviceAuthorization(clientId, deviceCode, options = {}) {
    const data = await oauthPost(`${OAUTH_BASE}/access_token`, {
        client_id: requireClientId(clientId),
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    }, options);
    if (typeof data.access_token === 'string' && data.access_token.length >= 20) {
        return { status: 'authorized', accessToken: data.access_token };
    }
    if (data.error === 'authorization_pending') return { status: 'pending' };
    if (data.error === 'slow_down') return { status: 'slow_down' };
    if (data.error === 'expired_token') return { status: 'expired' };
    if (data.error === 'access_denied') return { status: 'denied' };
    throw new Error('GitHub device authorization failed.');
}

function validateRepositorySlug(repository) {
    if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
        repository.split('/').some(part => part === '.' || part === '..')) {
        const error = new Error('Repository name must be owner/repository.');
        error.statusCode = 400;
        throw error;
    }
    return repository;
}

async function githubRequest(endpoint, token, options = {}) {
    const response = await (options.fetchImpl || globalThis.fetch)(`${API_BASE}/${endpoint}`, {
        headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'QOrange-Panel',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        signal: AbortSignal.timeout(options.timeout || 30000),
        redirect: 'follow'
    });
    if (!response.ok) {
        const error = new Error(`GitHub API request failed (${response.status}).`);
        error.statusCode = response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 403 : 502;
        throw error;
    }
    return response;
}

async function githubJson(endpoint, token, options = {}) {
    return responseJson(await githubRequest(endpoint, token, options));
}

async function githubCurrentUser(token, options = {}) {
    const user = await githubJson('user', token, options);
    if (typeof user.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(user.login)) {
        throw new Error('GitHub returned an invalid account identity.');
    }
    return { login: user.login, name: typeof user.name === 'string' ? user.name.slice(0, 120) : '' };
}

async function githubRepositories(token, options = {}) {
    const repos = [];
    for (let page = 1; page <= 10; page += 1) {
        const data = await githubJson(`user/repos?per_page=100&page=${page}&affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated`, token, options);
        if (!Array.isArray(data)) throw new Error('GitHub returned an invalid repository list.');
        repos.push(...data.map(repo => ({
            nameWithOwner: typeof repo.full_name === 'string' ? repo.full_name : '',
            name: typeof repo.name === 'string' ? repo.name : '',
            url: typeof repo.html_url === 'string' ? repo.html_url : '',
            isPrivate: repo.private === true,
            defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : ''
        })).filter(repo => repo.nameWithOwner && repo.name));
        if (data.length < 100) break;
    }
    return repos;
}

async function githubBranches(repository, token, options = {}) {
    validateRepositorySlug(repository);
    const branches = [];
    for (let page = 1; page <= 10; page += 1) {
        const data = await githubJson(`repos/${repository}/branches?per_page=100&page=${page}`, token, options);
        if (!Array.isArray(data)) throw new Error('GitHub returned an invalid branch list.');
        branches.push(...data.map(branch => branch && branch.name).filter(name => typeof name === 'string'));
        if (data.length < 100) break;
    }
    return branches;
}

async function githubRepositoryFiles(repository, branch, token, options = {}) {
    validateRepositorySlug(repository);
    validateBranch(branch);
    const treeResponse = await githubJson(`repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token, options);
    if (!Array.isArray(treeResponse.tree)) throw new Error('GitHub returned an invalid repository tree.');
    const candidates = treeResponse.tree.map(item => item.path).filter(file => {
        if (typeof file !== 'string') return false;
        const name = file.split('/').pop().toLowerCase();
        return ['dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'package.json', 'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'go.mod'].includes(name);
    }).slice(0, 100);
    const fileMap = {};
    for (const candidate of candidates) {
        const endpoint = `repos/${repository}/contents/${candidate.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
        const details = await githubJson(endpoint, token, options);
        fileMap[candidate] = typeof details.content === 'string'
            ? Buffer.from(details.content.replace(/\s/g, ''), 'base64').toString('utf8')
            : '';
    }
    return fileMap;
}

async function downloadGithubArchiveForAccount(repository, branch, token, archivePath, options = {}) {
    validateRepositorySlug(repository);
    validateBranch(branch);
    const timeout = options.timeout ?? 5 * 60 * 1000;
    const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
    let archiveFd;
    let archiveCreated = false;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeout);
    timeoutHandle.unref();
    try {
        archiveFd = fs.openSync(archivePath, 'wx', 0o600);
        archiveCreated = true;
        const response = await (options.fetchImpl || globalThis.fetch)(
            `${API_BASE}/repos/${repository}/tarball/${encodeURIComponent(branch)}`,
            {
                headers: {
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'QOrange-Panel',
                    ...(token ? { Authorization: `Bearer ${token}` } : {})
                },
                signal: controller.signal,
                redirect: 'follow'
            }
        );
        if (!response.ok || !response.body) {
            const error = new Error(`GitHub archive request failed (${response.status}).`);
            error.statusCode = response.status === 404 ? 404 : response.status === 401 || response.status === 403 ? 403 : 502;
            throw error;
        }
        const size = Number(response.headers.get('content-length'));
        if (Number.isFinite(size) && size > maxBytes) throw new Error(`GitHub archive exceeds the ${maxBytes}-byte limit`);
        let receivedBytes = 0;
        const outputLimit = new Transform({
            transform(chunk, _encoding, callback) {
                receivedBytes += chunk.length;
                callback(receivedBytes > maxBytes
                    ? new Error(`GitHub archive exceeds the ${maxBytes}-byte limit`)
                    : null, receivedBytes > maxBytes ? undefined : chunk);
            }
        });
        await pipeline(
            Readable.fromWeb(response.body),
            outputLimit,
            fs.createWriteStream(archivePath, { fd: archiveFd, autoClose: true })
        );
        archiveFd = undefined;
    } catch (error) {
        if (archiveFd !== undefined) {
            try { fs.closeSync(archiveFd); } catch (closeError) { if (closeError.code !== 'EBADF') throw closeError; }
        }
        if (archiveCreated) {
            try { fs.rmSync(archivePath, { force: true }); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
        }
        if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error(`GitHub archive request timed out after ${timeout}ms`);
        throw error;
    } finally {
        clearTimeout(timeoutHandle);
    }
}

module.exports = {
    downloadGithubArchiveForAccount,
    startDeviceAuthorization,
    pollDeviceAuthorization,
    githubCurrentUser,
    githubRepositories,
    githubBranches,
    githubRepositoryFiles,
    validateRepositorySlug,
    requireClientId,
    MAX_ARCHIVE_BYTES
};

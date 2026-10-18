'use strict';

const SERVICE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function validateServiceId(id) {
    if (typeof id !== 'string' || !SERVICE_ID.test(id)) {
        throw new Error('Service ID must start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, or underscores');
    }
    return id;
}

function validateBranch(branch) {
    if (typeof branch !== 'string' || branch.length < 1 || branch.length > 255 ||
        branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') ||
        branch.endsWith('.') || branch.includes('..') || branch.includes('//') ||
        branch.includes('@{') || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) ||
        !/^[A-Za-z0-9._/-]+$/.test(branch)) {
        throw new Error('Branch name is invalid');
    }
    return branch;
}

function parseEnv(text) {
    if (typeof text !== 'string') throw new Error('Environment variables must be text');
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('Environment variables must be smaller than 64 KB');
    const result = {};
    for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const separator = rawLine.indexOf('=');
        if (separator < 1) throw new Error(`Invalid environment variable on line ${index + 1}; use KEY=VALUE`);
        const key = rawLine.slice(0, separator).trim();
        if (!ENV_KEY.test(key)) throw new Error(`Invalid environment variable name on line ${index + 1}`);
        if (Object.hasOwn(result, key)) throw new Error(`Duplicate environment variable name on line ${index + 1}`);
        result[key] = rawLine.slice(separator + 1);
    }
    return result;
}

function validateService(input) {
    const id = validateServiceId(input.id);
    const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
    if (!REPOSITORY.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
        throw new Error('Select a repository from the authenticated GitHub account');
    }
    const branch = validateBranch((typeof input.branch === 'string' && input.branch.trim()) || 'main');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('Service name must be 1–120 printable characters');
    }
    let port = '';
    if (input.port !== undefined && input.port !== null && input.port !== '') {
        if (typeof input.port !== 'string' && typeof input.port !== 'number') throw new Error('Port must be a number or host:container mapping');
        port = String(input.port).trim();
        const match = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(port);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 ||
            (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
            throw new Error('Port must be between 1 and 65535, optionally as host:container');
        }
        port = match[2] ? `${Number(match[1])}:${Number(match[2])}` : `${Number(match[1])}:${Number(match[1])}`;
    }
    return { id, name, repo, branch, port };
}

function containerName(id) {
    return `qorange-${validateServiceId(id)}`;
}

function redactSecrets(text, secrets) {
    let output = String(text);
    for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
        output = output.split(secret).join('[REDACTED]');
    }
    return output;
}

module.exports = {
    parseEnv,
    validateService,
    validateServiceId,
    validateBranch,
    containerName,
    redactSecrets
};

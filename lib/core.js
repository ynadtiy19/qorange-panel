'use strict';

const SERVICE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function validateServiceId(id) {
    if (typeof id !== 'string' || !SERVICE_ID.test(id)) {
        throw new Error('服务 ID 必须以小写字母或数字开头，且只能包含小写字母、数字、连字符或下划线');
    }
    return id;
}

function validateBranch(branch) {
    if (typeof branch !== 'string' || branch.length < 1 || branch.length > 255 ||
        branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') ||
        branch.endsWith('.') || branch.includes('..') || branch.includes('//') ||
        branch.includes('@{') || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) ||
        !/^[A-Za-z0-9._/-]+$/.test(branch)) {
        throw new Error('分支名称无效');
    }
    return branch;
}

function parseEnv(text) {
    if (typeof text !== 'string') throw new Error('环境变量必须是文本');
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('环境变量必须小于 64 KB');
    const result = {};
    for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const separator = rawLine.indexOf('=');
        if (separator < 1) throw new Error(`第 ${index + 1} 行的环境变量无效；请使用 KEY=VALUE 格式`);
        const key = rawLine.slice(0, separator).trim();
        if (!ENV_KEY.test(key)) throw new Error(`第 ${index + 1} 行的环境变量名称无效`);
        if (Object.hasOwn(result, key)) throw new Error(`第 ${index + 1} 行的环境变量名称重复`);
        result[key] = rawLine.slice(separator + 1);
    }
    return result;
}

function validateService(input) {
    const id = validateServiceId(input.id);
    const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
    if (!REPOSITORY.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
        throw new Error('请从已登录的 GitHub 账户中选择一个仓库');
    }
    const branch = validateBranch((typeof input.branch === 'string' && input.branch.trim()) || 'main');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('服务名称长度必须为 1–120 个可打印字符');
    }
    let port = '';
    if (input.port !== undefined && input.port !== null && input.port !== '') {
        if (typeof input.port !== 'string' && typeof input.port !== 'number') throw new Error('端口必须为数字或主机端口:容器端口映射');
        port = String(input.port).trim();
        const match = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(port);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 ||
            (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
            throw new Error('端口必须在 1 到 65535 之间，也可以使用主机端口:容器端口格式');
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

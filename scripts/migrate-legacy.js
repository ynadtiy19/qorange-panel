'use strict';

const fs = require('fs');
const path = require('path');
const { parseEnv, validateService } = require('../lib/core');

const [legacyFile, registryFile, envDirectory] = process.argv.slice(2);
const marker = path.join(path.dirname(registryFile), 'legacy-config-migrated');

function parseLegacyEnv(text) {
    if (!text || text.includes('\n') || text.includes('\r')) return parseEnv(text || '');
    const starts = [...text.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)];
    if (!starts.length && text.trim()) throw new Error('Legacy environment values could not be parsed safely');
    const entries = [];
    for (const [index, match] of starts.entries()) {
        const start = match.index + match[0].length;
        const end = index + 1 < starts.length ? starts[index + 1].index : text.length;
        const value = text.slice(start, end).replace(/\s+$/, '');
        entries.push(`${match[1]}=${value}`);
    }
    return parseEnv(entries.join('\n'));
}

function repositorySlug(value) {
    if (typeof value !== 'string') return '';
    try {
        const url = new URL(value);
        if (url.hostname !== 'github.com') return '';
        return url.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '');
    } catch {
        return value;
    }
}

if (!legacyFile || !registryFile || !envDirectory) {
    console.error('Legacy migration requires a config path, registry path, and env directory.');
    process.exit(2);
}
if (!fs.existsSync(legacyFile)) process.exit(0);

if (fs.existsSync(marker)) {
    fs.unlinkSync(legacyFile);
    process.exit(0);
}
if (fs.existsSync(registryFile)) {
    console.error('A service registry already exists; refusing to overwrite it during legacy migration.');
    process.exit(1);
}

try {
    const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    const services = [];
    const envFiles = [];
    for (const item of legacy.services || []) {
        if (item.type === 'database') continue;
        const service = validateService({
            id: item.id,
            name: item.name || item.id,
            repo: repositorySlug(item.repo),
            branch: item.branch || 'main',
            port: item.port || ''
        });
        const env = parseLegacyEnv(item.env || '');
        const filename = path.join(envDirectory, `${service.id}.env`);
        if (fs.existsSync(filename)) throw new Error(`Cannot migrate ${service.id}: its environment file already exists`);
        services.push(service);
        envFiles.push({ filename, env });
    }

    fs.mkdirSync(envDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(envDirectory, 0o700);
    for (const { filename, env } of envFiles) {
        const contents = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
        fs.writeFileSync(filename, contents ? `${contents}\n` : '', { mode: 0o600, flag: 'wx' });
    }
    fs.mkdirSync(path.dirname(registryFile), { recursive: true, mode: 0o700 });
    const temporary = `${registryFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ services }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, registryFile);
    fs.chmodSync(registryFile, 0o600);
    fs.writeFileSync(marker, 'Legacy QOrange secrets migrated to private environment files.\n', { mode: 0o600 });
    fs.unlinkSync(legacyFile);
    console.log(`Migrated ${services.length} application service(s); legacy credentials were discarded and MongoDB entries were not executed.`);
} catch (error) {
    console.error(`Legacy configuration migration failed: ${error.message}`);
    process.exit(1);
}

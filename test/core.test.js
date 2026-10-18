'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
    parseEnv,
    validateService,
    validateBranch,
    validateServiceId,
    containerName,
    redactSecrets
} = require('../lib/core');
const { createSession, verifySession, verifyPassword } = require('../lib/auth');

test('parses multiline KEY=VALUE input without splitting values at equals signs', () => {
    assert.deepEqual(parseEnv('PORT=8080\nDATABASE_URL=mongodb://host/db?x=a=b\n# note\n'), {
        PORT: '8080',
        DATABASE_URL: 'mongodb://host/db?x=a=b'
    });
});

test('rejects malformed and duplicate environment names without echoing values', () => {
    assert.throws(() => parseEnv('GOOD=first\nBAD-NAME=do-not-leak'), /Invalid environment variable name on line 2/);
    assert.throws(() => parseEnv('TOKEN=first\nTOKEN=secret-value'), /Duplicate environment variable name on line 2/);
    assert.throws(() => parseEnv('this is secret'), /use KEY=VALUE/);
});

test('validates repository services, ports, branches, and container identifiers', () => {
    assert.deepEqual(validateService({
        id: 'website_1',
        name: 'Website',
        repo: 'org/repo',
        branch: 'feature/release-2',
        port: '8080:3000'
    }), {
        id: 'website_1',
        name: 'Website',
        repo: 'org/repo',
        branch: 'feature/release-2',
        port: '8080:3000'
    });
    assert.equal(containerName('website_1'), 'qorange-website_1');
    assert.throws(() => validateServiceId('$(touch-pwned)'), /Service ID/);
    assert.throws(() => validateService({ id: 'app', name: 'App', repo: 'https://github.com/org/repo', branch: 'main' }), /Select a repository/);
    assert.throws(() => validateService({ id: 'app', name: 'App', repo: 'org/repo', branch: '../main' }), /Branch name/);
    assert.throws(() => validateService({ id: 'app', name: 'App', repo: 'org/repo', branch: 'main', port: '8080;id' }), /Port must/);
    assert.throws(() => validateBranch('-option'), /Branch name/);
});

test('redacts environment values from output', () => {
    assert.equal(redactSecrets('token=abc and token=abcdef', ['abc', 'abcdef']), 'token=[REDACTED] and token=[REDACTED]');
});

test('signs and verifies expiring sessions and verifies administrator passwords', async () => {
    const key = Buffer.from('session-test-key');
    const now = 1_800_000_000_000;
    const session = createSession(key, now);
    assert.equal(verifySession(session.token, key, now).csrf, session.csrf);
    assert.equal(verifySession(`${session.token}x`, key, now), null);
    assert.equal(verifySession(session.token, Buffer.from('other-key'), now), null);
    assert.equal(verifySession(session.token, key, now + 13 * 60 * 60 * 1000), null);
    const salt = Buffer.from('test-salt');
    const hash = require('node:crypto').scryptSync('correct horse battery staple', salt, 64, { N: 16384, r: 8, p: 1 });
    const auth = { algorithm: 'scrypt', salt: salt.toString('hex'), hash: hash.toString('hex') };
    assert.equal(await verifyPassword('correct horse battery staple', auth), true);
    assert.equal(await verifyPassword('wrong password', auth), false);
});

test('migrates only legacy application metadata and keeps secrets out of output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qorange-migrate-test-'));
    try {
        const legacyFile = path.join(root, 'config.json');
        const registryFile = path.join(root, 'state', 'services.json');
        const envDirectory = path.join(root, 'env');
        fs.mkdirSync(path.dirname(registryFile));
        const secret = 'migration-secret-value';
        fs.writeFileSync(legacyFile, JSON.stringify({
            authSecret: 'old-weak-auth-token',
            services: [
                { id: 'web', name: 'Web', type: 'app', repo: 'https://github.com/org/web.git', branch: 'main', port: '8080', env: `TOKEN=${secret} DATABASE_URL=mongodb://host/db` },
                { id: 'mongodb', name: 'Mongo', type: 'database', runCmd: 'docker run --name mongodb ...' }
            ]
        }));
        const script = path.join(__dirname, '..', 'scripts', 'migrate-legacy.js');
        const result = spawnSync(process.execPath, [script, legacyFile, registryFile, envDirectory], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.includes(secret), false);
        assert.equal(fs.existsSync(legacyFile), false);
        const services = JSON.parse(fs.readFileSync(registryFile, 'utf8')).services;
        assert.deepEqual(services.map(service => service.id), ['web']);
        assert.equal(Object.hasOwn(services[0], 'env'), false);
        const envFile = path.join(envDirectory, 'web.env');
        assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
        assert.equal(fs.readFileSync(envFile, 'utf8').includes(secret), true);
        assert.equal(fs.existsSync(path.join(envDirectory, 'mongodb.env')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('installer syntax and safety guards preserve MongoDB and user app data', () => {
    const installer = path.join(__dirname, '..', 'install.sh');
    const syntax = spawnSync('bash', ['-n', installer], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const source = fs.readFileSync(installer, 'utf8');
    assert.match(source, /docker info/);
    assert.match(source, /gh auth status/);
    assert.match(source, /\/data\/mongo_data/);
    assert.match(source, /\.qorange-panel-owned/);
    assert.match(source, /# QOrange Panel managed/);
    assert.match(source, /systemctl show -p FragmentPath/);
    assert.doesNotMatch(source, /rm\s+-rf\s+\/data\/apps/);
});

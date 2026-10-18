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
    resolveServiceStatus,
    redactSecrets,
    detectRepositoryRecipe,
    allocatePublicPort,
    buildMongoUri,
    normalizeMongoEnv,
    previewDeploymentPlan
} = require('../lib/core');
const { createSession, verifySession, verifyPassword } = require('../lib/auth');

test('parses multiline KEY=VALUE input without splitting values at equals signs', () => {
    assert.deepEqual(parseEnv('PORT=8080\nDATABASE_URL=mongodb://host/db?x=a=b\n# note\n'), {
        PORT: '8080',
        DATABASE_URL: 'mongodb://host/db?x=a=b'
    });
    const specialKey = parseEnv('__proto__=safe');
    assert.equal(Object.hasOwn(specialKey, '__proto__'), true);
    assert.equal(specialKey.__proto__, 'safe');
});

test('rejects malformed and duplicate environment names without echoing values', () => {
    assert.throws(() => parseEnv('GOOD=first\nBAD-NAME=do-not-leak'), /第 2 行的环境变量名称无效/);
    assert.throws(() => parseEnv('TOKEN=first\nTOKEN=secret-value'), /第 2 行的环境变量名称重复/);
    assert.throws(() => parseEnv('this is secret'), /请使用 KEY=VALUE 格式/);
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
    assert.equal(validateBranch('feature/日本語-release'), 'feature/日本語-release');
    assert.throws(() => validateServiceId('$(touch-pwned)'), /服务 ID/);
    assert.throws(() => validateService({ id: 'app', name: 'App', repo: 'https://github.com/org/repo', branch: 'main' }), /owner\/repository/);
    assert.throws(() => validateService({ id: 'app', name: 'App', repo: 'org/repo', branch: '../main' }), /分支名称/);
    assert.throws(() => validateService({ id: 'app', name: 'App', repo: 'org/repo', branch: 'main', port: '8080;id' }), /端口必须/);
    assert.equal(validateService({
        id: 'private-app',
        name: 'Private',
        repo: 'org/repo',
        branch: 'main',
        githubAccountId: '5b07a718-5ba2-4223-9337-50ddc9468112'
    }).githubAccountId, '5b07a718-5ba2-4223-9337-50ddc9468112');
    assert.throws(() => validateService({
        id: 'private-app',
        name: 'Private',
        repo: 'org/repo',
        branch: 'main',
        githubAccountId: 'not-an-account'
    }), /GitHub account selection/);
    assert.throws(() => validateBranch('-option'), /分支名称/);
    assert.throws(() => validateBranch('feature/name?query'), /分支名称/);
});

test('redacts environment values from output', () => {
    assert.equal(redactSecrets('token=abc and token=abcdef', ['abc', 'abcdef']), 'token=[REDACTED] and token=[REDACTED]');
});

test('resolves service availability without claiming a missing container is deployed', () => {
    assert.equal(resolveServiceStatus(null, 'never', false), 'uninstalled');
    assert.equal(resolveServiceStatus(null, 'deploying', true), 'deploying');
    assert.equal(resolveServiceStatus(null, 'failed', false), 'failed');
    assert.equal(resolveServiceStatus(null, 'succeeded', false), 'missing');
    assert.equal(resolveServiceStatus('Up 2 minutes', 'failed', false), 'running');
    assert.equal(resolveServiceStatus('Exited (1) 2 minutes ago', 'succeeded', false), 'stopped');
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
    assert.doesNotMatch(source, /gh auth status/);
    assert.match(source, /\/data\/mongo_data/);
    assert.match(source, /\.qorange-panel-owned/);
    assert.match(source, /# QOrange Panel managed/);
    assert.match(source, /systemctl show -p FragmentPath/);
    assert.doesNotMatch(source, /rm\s+-rf\s+\/data\/apps/);
    assert.match(source, /if \[\[ ! -e "\$PANEL_ENV" \]\]/);
    assert.match(source, /for state_file in "\$ETC_DIR\/session\.key" "\$ETC_DIR\/auth\.json"/);
    assert.match(source, /GITHUB_CLIENT_ID/);
});

test('updater validates the existing installation and retains rollback and user state', () => {
    const updater = path.join(__dirname, '..', 'update.sh');
    const syntax = spawnSync('bash', ['-n', updater], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const source = fs.readFileSync(updater, 'utf8');
    assert.match(source, /\/opt\/qorange-panel\.rollback\./);
    assert.match(source, /restoring the previous application files/);
    assert.match(source, /"\$ETC_DIR\/auth\.json"/);
    assert.match(source, /"\$ETC_DIR\/session\.key"/);
    assert.match(source, /"\$ETC_DIR\/panel\.env"/);
    assert.doesNotMatch(source, /create-auth\.js/);
    assert.doesNotMatch(source, /rm\s+-rf\s+\/data\/apps/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), /process\.env\.GITHUB_CLIENT_ID/);
});

test('detects a deterministic Dockerfile or Compose recipe without executing guessed commands', () => {
    const dockerRecipe = detectRepositoryRecipe({ Dockerfile: 'FROM node:20\nEXPOSE 3000\nENV PORT=3000\nCMD [\"node\", \"server.js\"]\n' }, { repo: 'org/app', branch: 'main' });
    assert.equal(dockerRecipe.supported, true);
    assert.equal(dockerRecipe.source, 'dockerfile');
    assert.equal(dockerRecipe.port, 3000);
    assert.equal(dockerRecipe.envDefaults.PORT, '3000');
    assert.equal(dockerRecipe.requiresConfirmation, true);
    assert.match(dockerRecipe.message, /requires review/i);

    const composeRecipe = detectRepositoryRecipe({
        'compose.yaml': 'services:\n  web:\n    image: nginx:stable\n    ports:\n      - "8080:80"\n'
    }, { repo: 'org/app', branch: 'main' });
    assert.equal(composeRecipe.supported, true);
    assert.equal(composeRecipe.source, 'compose');
    assert.equal(composeRecipe.port, 80);

    const preview = previewDeploymentPlan(composeRecipe);
    assert.equal(preview.supported, true);
    assert.match(preview.review, /review/i);
    assert.match(preview.publicAddress, /^http:\/\//);

    const unsafe = detectRepositoryRecipe({
        'compose.yaml': 'services:\n  web:\n    image: busybox\n    command: "sh -c \"echo hi\""\n    network_mode: host\n'
    }, { repo: 'org/app', branch: 'main' });
    assert.equal(unsafe.supported, false);
    assert.match(unsafe.reason, /unsupported|unsafe/i);
});

test('allocates a public host port while preserving explicit overrides and MongoDB private wiring', () => {
    assert.equal(allocatePublicPort(8080, [8080, 8081]), 8082);
    assert.equal(allocatePublicPort(5000, []), 5000);

    const uri = buildMongoUri({ host: 'mongodb', port: 27017, dbName: 'googlechat', username: 'root', password: 's3cret' });
    assert.equal(uri, 'mongodb://root:s3cret@mongodb:27017/googlechat');

    const env = normalizeMongoEnv({ DB_NAME: 'googlechat', MONGO_HOST: 'mongodb', MONGO_PORT: '27017' });
    assert.equal(env.MONGODB_URI, 'mongodb://mongodb:27017/googlechat');
    assert.equal(env.MONGODB_URI.includes('172.17.0.1'), false);
});

test('panel HTML declares Simplified Chinese and translated interface labels', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.match(page, /<html lang="zh-CN">/);
    assert.match(page, /管理员密码/);
    assert.match(page, /导入 GitHub 仓库/);
    assert.match(page, /环境变量/);
    assert.match(page, /编辑原始环境变量/);
    assert.match(page, /复制全部变量/);
    assert.match(page, /<textarea id="env-text"/);
});

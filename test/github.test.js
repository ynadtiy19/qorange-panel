'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { downloadGithubArchive } = require('../lib/github');

function createGhStub(root, script) {
    const file = path.join(root, 'gh-stub');
    fs.writeFileSync(file, `#!/usr/bin/env node\n${script}\n`, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
    return file;
}

test('downloads binary archives from gh api stdout without newer --output support', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qorange-gh-test-'));
    const previousArgsFile = process.env.GH_TEST_ARGS_FILE;
    try {
        const argsFile = path.join(root, 'args.json');
        const archive = path.join(root, 'repository.tar.gz');
        const gh = createGhStub(root, `
            require('node:fs').writeFileSync(process.env.GH_TEST_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
            process.stdout.write(Buffer.from([0, 1, 2, 255, 10]));
        `);
        process.env.GH_TEST_ARGS_FILE = argsFile;
        await downloadGithubArchive(gh, 'repos/example/app/tarball/main', archive);
        assert.deepEqual(fs.readFileSync(archive), Buffer.from([0, 1, 2, 255, 10]));
        assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), [
            'api', '--header', 'Accept: application/vnd.github+json', 'repos/example/app/tarball/main'
        ]);
        assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
    } finally {
        if (previousArgsFile === undefined) delete process.env.GH_TEST_ARGS_FILE;
        else process.env.GH_TEST_ARGS_FILE = previousArgsFile;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reports gh api exit status and stderr without exposing GitHub tokens', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qorange-gh-test-'));
    try {
        const archive = path.join(root, 'repository.tar.gz');
        const token = `ghp_${'1'.repeat(36)}`;
        const gh = createGhStub(root, `
            process.stderr.write('request failed using ${token}');
            process.exit(7);
        `);
        await assert.rejects(
            downloadGithubArchive(gh, 'repos/example/app/tarball/main', archive),
            error => {
                assert.match(error.message, /exit code 7/);
                assert.match(error.message, /request failed/);
                assert.equal(error.message.includes(token), false);
                return true;
            }
        );
        assert.equal(fs.existsSync(archive), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('rejects oversized or timed-out archive downloads and removes partial files', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qorange-gh-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const oversizedArchive = path.join(root, 'oversized.tar.gz');
    const oversizedGh = createGhStub(root, "process.stdout.write(Buffer.alloc(8));");
    await assert.rejects(
        downloadGithubArchive(oversizedGh, 'repos/example/app/tarball/main', oversizedArchive, { maxBytes: 4 }),
        /exceeds the 4-byte limit/
    );
    assert.equal(fs.existsSync(oversizedArchive), false);

    const existingArchive = path.join(root, 'existing.tar.gz');
    fs.writeFileSync(existingArchive, 'preserve existing file');
    await assert.rejects(
        downloadGithubArchive(oversizedGh, 'repos/example/app/tarball/main', existingArchive),
        /EEXIST/
    );
    assert.equal(fs.readFileSync(existingArchive, 'utf8'), 'preserve existing file');

    const timedOutArchive = path.join(root, 'timed-out.tar.gz');
    const slowGh = createGhStub(root, 'setTimeout(() => process.stdout.write("late"), 5000);');
    await assert.rejects(
        downloadGithubArchive(slowGh, 'repos/example/app/tarball/main', timedOutArchive, { timeout: 100 }),
        /timed out after 100ms/
    );
    assert.equal(fs.existsSync(timedOutArchive), false);
});

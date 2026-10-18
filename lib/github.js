'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { redactSecrets } = require('./core');

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function safeStderr(text, secrets) {
    return redactSecrets(text, [
        ...secrets,
        process.env.GH_TOKEN,
        process.env.GITHUB_TOKEN
    ].filter(Boolean))
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .trim();
}

async function downloadGithubArchive(cliPath, endpoint, archivePath, options = {}) {
    const timeout = options.timeout ?? 5 * 60 * 1000;
    const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
    let child;
    let archiveFd;
    let archiveCreated = false;
    let stderr = '';
    let stderrBytes = 0;
    let stderrTruncated = false;
    let outputError;
    let spawnError;
    let timeoutError;
    let timeoutHandle;
    let forceKillHandle;

    const stopChild = () => {
        if (!child.killed) child.kill('SIGTERM');
        if (!forceKillHandle) {
            forceKillHandle = setTimeout(() => child.kill('SIGKILL'), 5000);
            forceKillHandle.unref();
        }
    };

    try {
        archiveFd = fs.openSync(archivePath, 'wx', 0o600);
        archiveCreated = true;
        child = spawn(cliPath, [
            'api',
            '--header', 'Accept: application/vnd.github+json',
            endpoint
        ], {
            env: { ...process.env, GH_PROMPT_DISABLED: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        child.stderr.on('data', chunk => {
            const remaining = MAX_STDERR_BYTES - stderrBytes;
            if (remaining > 0) {
                const captured = chunk.subarray(0, remaining);
                stderr += captured.toString('utf8');
                stderrBytes += captured.length;
            }
            if (chunk.length > remaining) stderrTruncated = true;
        });
        child.once('error', error => { spawnError = error; });

        let receivedBytes = 0;
        const outputLimit = new Transform({
            transform(chunk, _encoding, callback) {
                receivedBytes += chunk.length;
                if (receivedBytes > maxBytes) {
                    callback(new Error(`GitHub archive exceeds the ${maxBytes}-byte limit`));
                    return;
                }
                callback(null, chunk);
            }
        });
        const output = pipeline(
            child.stdout,
            outputLimit,
            fs.createWriteStream(archivePath, { fd: archiveFd, autoClose: true })
        ).catch(error => {
            outputError = error;
            stopChild();
        });

        const exit = new Promise((resolve, reject) => {
            timeoutHandle = setTimeout(() => {
                timeoutError = new Error(`gh api timed out after ${timeout}ms`);
                stopChild();
            }, timeout);
            timeoutHandle.unref();

            child.once('close', async (code, signal) => {
                clearTimeout(timeoutHandle);
                clearTimeout(forceKillHandle);
                await output;
                const details = safeStderr(
                    `${stderr}${stderrTruncated ? '\n[stderr truncated]' : ''}`,
                    options.secrets || []
                );
                if (timeoutError) {
                    reject(new Error(`${timeoutError.message}${details ? `: ${details}` : ''}`));
                } else if (spawnError) {
                    reject(new Error(`Could not start gh api: ${spawnError.message}${details ? `: ${details}` : ''}`));
                } else if (outputError) {
                    reject(new Error(`${outputError.message}${details ? `: ${details}` : ''}`));
                } else if (code !== 0) {
                    reject(new Error(`gh api failed with exit code ${code === null ? signal : code}${details ? `: ${details}` : ''}`));
                } else {
                    resolve();
                }
            });
        });

        await exit;
    } catch (error) {
        clearTimeout(timeoutHandle);
        clearTimeout(forceKillHandle);
        if (archiveFd !== undefined) {
            try {
                fs.closeSync(archiveFd);
            } catch (closeError) {
                if (closeError.code !== 'EBADF') throw closeError;
            }
        }
        if (archiveCreated) {
            try {
                fs.rmSync(archivePath, { force: true });
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') throw cleanupError;
            }
        }
        throw error;
    }
}

module.exports = { downloadGithubArchive, MAX_ARCHIVE_BYTES };

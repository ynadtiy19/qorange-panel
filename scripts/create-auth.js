'use strict';

const crypto = require('crypto');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
    const password = input.replace(/\r?\n$/, '');
    if (password.length < 24 || password.length > 256) {
        console.error('Password must be between 24 and 256 characters.');
        process.exitCode = 1;
        return;
    }
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    process.stdout.write(`${JSON.stringify({ algorithm: 'scrypt', salt: salt.toString('hex'), hash: hash.toString('hex') })}\n`);
});

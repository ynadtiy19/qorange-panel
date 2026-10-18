'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_SECONDS = 12 * 60 * 60;

async function verifyPassword(password, auth) {
    if (!auth || auth.algorithm !== 'scrypt' || typeof auth.salt !== 'string' || typeof auth.hash !== 'string') return false;
    const expected = Buffer.from(auth.hash, 'hex');
    if (expected.length !== 64) return false;
    const actual = await scrypt(password, Buffer.from(auth.salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(actual, expected);
}

function createSession(key, now = Date.now()) {
    const value = {
        exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
        csrf: crypto.randomBytes(32).toString('base64url')
    };
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = crypto.createHmac('sha256', key).update(body).digest('base64url');
    return { ...value, token: `${body}.${signature}` };
}

function verifySession(token, key, now = Date.now()) {
    if (typeof token !== 'string') return null;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return null;
    const expected = crypto.createHmac('sha256', key).update(body).digest();
    let actual;
    try {
        actual = Buffer.from(signature, 'base64url');
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
        const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!Number.isSafeInteger(value.exp) || value.exp <= Math.floor(now / 1000) ||
            typeof value.csrf !== 'string' || value.csrf.length < 32) return null;
        return value;
    } catch {
        return null;
    }
}

function sessionCookie(token, secure) {
    return `qorange_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(secure) {
    return `qorange_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = {
    verifyPassword,
    createSession,
    verifySession,
    sessionCookie,
    clearSessionCookie
};

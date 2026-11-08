const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = server.indexOf('function consumeRateLimit(');
const end = server.indexOf('// 每60秒清理过期限流记录', begin);
assert.ok(begin >= 0 && end > begin);
const { consumeRateLimit, sweepRateLimitStore, resolveClientIp } = vm.runInNewContext(
    `${server.slice(begin, end)}; ({ consumeRateLimit, sweepRateLimitStore, resolveClientIp })`
);

const WINDOW = 3600000;
const now = 1700000000000;

test('requests within the window are allowed up to the limit then rejected', () => {
    const store = new Map();
    for (let i = 1; i <= 3; i++) {
        assert.equal(consumeRateLimit(store, 'a', now, WINDOW, 3).allowed, true, `request ${i}`);
    }
    assert.equal(consumeRateLimit(store, 'a', now, WINDOW, 3).allowed, false, 'request 4');
});

test('the counter resets once the window has elapsed', () => {
    const store = new Map();
    for (let i = 0; i < 3; i++) consumeRateLimit(store, 'a', now, WINDOW, 3);
    assert.equal(consumeRateLimit(store, 'a', now, WINDOW, 3).allowed, false);

    const later = now + WINDOW + 1;
    assert.equal(consumeRateLimit(store, 'a', later, WINDOW, 3).allowed, true, 'fresh window');
    assert.equal(consumeRateLimit(store, 'a', later, WINDOW, 3).allowed, true);
});

test('separate keys do not consume each other\'s quota', () => {
    const store = new Map();
    for (let i = 0; i < 3; i++) consumeRateLimit(store, 'ip1', now, WINDOW, 3);
    assert.equal(consumeRateLimit(store, 'ip1', now, WINDOW, 3).allowed, false);
    assert.equal(consumeRateLimit(store, 'ip2', now, WINDOW, 3).allowed, true);
});

// trust proxy makes req.ip the real address; this only guards the fallback path
test('the client ip falls back to the socket address and then to a placeholder', () => {
    assert.equal(resolveClientIp({ ip: '1.2.3.4' }), '1.2.3.4');
    assert.equal(resolveClientIp({ connection: { remoteAddress: '5.6.7.8' } }), '5.6.7.8');
    assert.equal(resolveClientIp({}), 'unknown');
});

// Without this, enabling trust proxy turns the limiter into an unbounded
// memory sink: one key per distinct client IP, never released.
test('sweeping drops stale keys and keeps live ones', () => {
    const store = new Map();
    consumeRateLimit(store, 'stale', now, WINDOW, 5);
    consumeRateLimit(store, 'fresh', now + WINDOW - 1, WINDOW, 5);

    // past the window, matching the strict ">" comparison the sweep uses
    sweepRateLimitStore(store, now + WINDOW + 1, WINDOW);

    assert.equal(store.has('stale'), false, 'expired key removed');
    assert.equal(store.has('fresh'), true, 'live key kept');
});

const executable = server
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');

// req.ip is 127.0.0.1 behind the reverse proxy unless trust proxy is enabled,
// which would silently collapse every client into one shared bucket.
test('the app trusts exactly one proxy hop', () => {
    assert.match(executable, /app\.set\('trust proxy',\s*1\)/);
    // `true` would let a direct client forge X-Forwarded-For and rotate IPs
    assert.equal(/app\.set\('trust proxy',\s*true\)/.test(executable), false);
});

test('a global error handler hides stack traces from oversized bodies', () => {
    const errAt = executable.indexOf('(err, req, res, next)');
    assert.ok(errAt > 0, 'error middleware exists');

    const jsonAt = executable.indexOf('express.json()');
    const staticAt = executable.indexOf('express.static');
    assert.ok(errAt > jsonAt, 'error handler must follow body-parser to catch 413');
    assert.ok(errAt < staticAt, 'error handler must precede the static routes');

    const handler = executable.slice(errAt, executable.indexOf('res.header', errAt));
    assert.equal(/err\.stack/.test(handler), false, 'must not echo err.stack');
    assert.match(handler, /413/, 'must handle payload-too-large explicitly');
});

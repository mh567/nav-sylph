const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// server.js starts the HTTP listener when loaded, so exercise the guards
// directly, the way paste-ttl.test.js does with the TTL whitelist.
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const begin = server.indexOf('const pasteRateLimitMap');
const end = server.indexOf('// 每60秒清理过期分享', begin);
assert.ok(begin >= 0 && end > begin, 'share guard helpers are present');

const guards = vm.runInNewContext(
    `${server.slice(begin, end)}; ({
        consumeRateLimit,
        sweepRateLimitStore,
        isOverPasteCapacity,
        resolveClientIp,
        PASTE_CODE_LIMIT,
        PASTE_CREATE_LIMIT,
        PASTE_MAX_ENTRIES,
        PASTE_MAX_BYTES
    })`
);

const { consumeRateLimit, sweepRateLimitStore, isOverPasteCapacity, resolveClientIp } = guards;

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

test('capacity is refused once either the entry count or byte budget is reached', () => {
    assert.equal(isOverPasteCapacity(0, 0), false);
    assert.equal(isOverPasteCapacity(guards.PASTE_MAX_ENTRIES - 1, 0), false);
    assert.equal(isOverPasteCapacity(guards.PASTE_MAX_ENTRIES, 0), true, 'entry cap');
    assert.equal(isOverPasteCapacity(0, guards.PASTE_MAX_BYTES), true, 'byte cap');
    assert.equal(isOverPasteCapacity(0, guards.PASTE_MAX_BYTES - 1), false);
});

test('the two creation entry points get independent budgets', () => {
    assert.equal(guards.PASTE_CODE_LIMIT, 10);
    assert.equal(guards.PASTE_CREATE_LIMIT, 20);
    // A share needs one code request plus one create, so create must allow more
    assert.ok(guards.PASTE_CREATE_LIMIT > guards.PASTE_CODE_LIMIT);
});

// ---- wiring assertions ----
// These guard the route layer, which the pure-function tests above cannot reach.
// POST /api/p once shipped without any rate limit, so pin it down here.

// Executable code only. A commented-out call must never satisfy a guard,
// otherwise any check can be defeated by prefixing the line with "//".
const executable = server
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');

// Slice a single route body: from its app.post( line to the next top-level
// route declaration, so later middleware cannot bleed into the match.
function routeBody(marker, nextMarker) {
    const start = executable.indexOf(marker);
    assert.ok(start > 0, `route ${marker} exists`);
    const end = nextMarker ? executable.indexOf(nextMarker, start + marker.length) : executable.length;
    assert.ok(end > start, `route ${marker} has a body`);
    return executable.slice(start, end);
}

test('POST /api/p applies its own creation rate limit', () => {
    const route = routeBody("app.post('/api/p',", "app.post('/api/p/:code'");

    assert.match(route, /consumeRateLimit\(/, 'create route must consume a rate-limit slot');
    assert.match(route, /paste:create/, 'create route must use its own quota key');
    assert.match(route, /status\(429\)/, 'over-limit creates must be refused');
});

test('POST /api/p/code keeps a separate quota from the create route', () => {
    const route = routeBody("app.post('/api/p/code'", "app.post('/api/p',");

    assert.match(route, /paste:code/, 'code route must use a distinct key');
    assert.match(route, /PASTE_CODE_LIMIT/, 'code route must apply the code limit');
});

test('the read route is limited independently as well', () => {
    const route = routeBody("app.post('/api/p/:code'", "app.get('/p/:code'");

    assert.match(route, /paste:get/, 'read route must use its own key');
});

test('the create route enforces the global capacity ceiling', () => {
    const route = routeBody("app.post('/api/p',", "app.post('/api/p/:code'");

    assert.match(route, /isOverPasteCapacity\(/, 'create route must check capacity');
    assert.match(route, /status\(503\)/, 'a full service must signal unavailability');
});

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

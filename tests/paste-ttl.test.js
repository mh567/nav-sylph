const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// server.js starts the HTTP listener when loaded, so exercise the TTL
// whitelist directly, the way api-boundary.test.js does with its helpers.
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = server.indexOf('const PASTE_TTL_OPTIONS');
const end = server.indexOf('// 词表用于生成易记的分享码', begin);
assert.ok(begin >= 0 && end > begin, 'paste TTL helpers are present');

const { PASTE_TTL_OPTIONS, PASTE_DEFAULT_TTL_MINUTES, resolvePasteTtlMinutes } = vm.runInNewContext(
    `${server.slice(begin, end)}; ({ PASTE_TTL_OPTIONS, PASTE_DEFAULT_TTL_MINUTES, resolvePasteTtlMinutes })`
);

const MINUTE = 60 * 1000;

test('the whitelist exposes exactly the four offered windows', () => {
    assert.equal(PASTE_TTL_OPTIONS[5], 5 * MINUTE);
    assert.equal(PASTE_TTL_OPTIONS[30], 30 * MINUTE);
    assert.equal(PASTE_TTL_OPTIONS[1440], 24 * 60 * MINUTE);
    assert.equal(PASTE_TTL_OPTIONS[10080], 7 * 24 * 60 * MINUTE);
    assert.equal(Object.keys(PASTE_TTL_OPTIONS).length, 4);
});

test('valid windows are accepted unchanged', () => {
    for (const minutes of [5, 30, 1440, 10080]) {
        assert.equal(resolvePasteTtlMinutes(minutes), minutes);
    }
});

test('missing and unknown windows fall back to the default', () => {
    for (const value of [undefined, null, 0, -5, 99999, 5.5, NaN, Infinity, '', 'abc', {}, []]) {
        assert.equal(resolvePasteTtlMinutes(value), PASTE_DEFAULT_TTL_MINUTES, `input: ${String(value)}`);
    }
});

// A bare object literal would let inherited keys through: PASTE_TTL_OPTIONS['constructor']
// yields a function, expiresAt becomes a string, and every expiry comparison is false
// against it, so the entry never expires and never gets cleaned up.
test('inherited object keys cannot poison the expiry timestamp', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
        const minutes = resolvePasteTtlMinutes(key);
        assert.equal(minutes, PASTE_DEFAULT_TTL_MINUTES, `key: ${key}`);

        const expiresAt = Date.now() + PASTE_TTL_OPTIONS[minutes];
        assert.equal(typeof expiresAt, 'number', `expiresAt for ${key} must stay numeric`);
        assert.ok(Number.isFinite(expiresAt), `expiresAt for ${key} must be finite`);
        // The cleaner and the read path both rely on this comparison being meaningful.
        assert.equal(expiresAt > Date.now(), true, `entry with ttl="${key}" must still expire`);
    }
});

test('a string that looks like a valid window is not silently accepted', () => {
    // JSON bodies may carry strings; the whitelist is keyed by number, so "5" is invalid
    assert.equal(resolvePasteTtlMinutes('5'), PASTE_DEFAULT_TTL_MINUTES);
    assert.equal(resolvePasteTtlMinutes('10080'), PASTE_DEFAULT_TTL_MINUTES);
});

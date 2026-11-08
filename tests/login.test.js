'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/login.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function loginPage({ session = {}, reduced = false } = {}) {
    const nodes = new Map();
    const document = {
        body: { classList: { add(name) { classes.add(name); } } },
        querySelector(selector) {
            if (!nodes.has(selector)) nodes.set(selector, {
                value: '', textContent: '', disabled: selector === '#controls', hidden: true,
                attributes: {}, events: {},
                setAttribute(key, value) { this.attributes[key] = value; },
                getAttribute(key) { return this.attributes[key]; },
                removeAttribute(key) { delete this.attributes[key]; },
                addEventListener(event, fn) { this.events[event] = fn; },
                focus() { focused = selector; }, select() {}
            });
            return nodes.get(selector);
        }
    };
    const classes = new Set(), requests = [], redirects = [], timers = [];
    let focused, respond = async () => ({ ok: true, json: async () => ({ valid: true }) });
    vm.runInNewContext(source, {
        document, window: { matchMedia: () => ({ matches: reduced }) },
        location: { replace: url => redirects.push(url) },
        setTimeout: (fn, ms) => timers.push({ fn, ms }), AbortSignal, TypeError, SyntaxError,
        fetch: async (url, options) => {
            if (url === '/api/session') return { ok: true, json: async () => session };
            requests.push({ url, options }); return respond();
        }
    });
    await tick();
    return {
        node: selector => document.querySelector(selector), classes, requests, redirects, timers,
        get focused() { return focused; },
        respond(fn) { respond = fn; },
        submit() { return document.querySelector('#loginForm').events.submit({ preventDefault() {} }); }
    };
}

test('login locks duplicate submits and enters only after verified response', async () => {
    const page = await loginPage();
    page.node('#password').value = 'Example123!pass';
    let resolve;
    page.respond(() => new Promise(r => { resolve = r; }));
    const submission = page.submit();
    await page.submit();
    assert.equal(page.requests.length, 1);
    assert.equal(page.node('#controls').disabled, true);
    assert.equal(page.redirects.length, 0);
    resolve({ ok: true, json: async () => ({ valid: true }) });
    await submission;
    assert.ok(page.classes.has('entering'));
    assert.equal(page.node('#controls').disabled, true);
    assert.equal(page.timers[0].ms, 380);
    page.timers[0].fn();
    assert.deepEqual(page.redirects, ['/']);
    assert.equal(page.requests[0].options.headers['X-Admin-Password'], 'Example123!pass');
});

test('invalid password and network errors leave a usable retry form', async () => {
    const page = await loginPage();
    page.respond(async () => ({ ok: true, json: async () => ({ valid: false }) }));
    await page.submit();
    assert.match(page.node('#message').textContent, /密码不正确/);
    assert.equal(page.focused, '#password');
    assert.equal(page.node('#controls').disabled, false);
    assert.equal(page.timers.length, 0);
    page.respond(async () => { throw new TypeError('Failed to fetch'); });
    await page.submit();
    assert.match(page.node('#message').textContent, /检查网络/);
    assert.equal(page.node('#controls').disabled, false);
    assert.equal(page.redirects.length, 0);
});

test('restricted session requires matching new passwords before change request', async () => {
    const page = await loginPage({ session: { passwordChangeRequired: true } });
    assert.equal(page.node('#changeFields').hidden, false);
    page.node('#password').value = 'admin123';
    page.node('#newPassword').value = 'StrongPass123!';
    page.node('#repeatPassword').value = 'different';
    await page.submit();
    assert.equal(page.requests.length, 0);
    assert.equal(page.focused, '#repeatPassword');
    page.node('#repeatPassword').value = 'StrongPass123!';
    page.respond(async () => ({ ok: true, json: async () => ({ success: true }) }));
    await page.submit();
    assert.equal(page.requests[0].url, '/api/change-password');
    assert.deepEqual(JSON.parse(page.requests[0].options.body), { currentPassword: 'admin123', newPassword: 'StrongPass123!' });
    assert.ok(page.classes.has('entering'));
});

test('weak-password login reveals change fields without entering', async () => {
    const page = await loginPage();
    page.respond(async () => ({ ok: true, json: async () => ({ valid: true, passwordChangeRequired: true }) }));
    await page.submit();
    assert.equal(page.node('#changeFields').hidden, false);
    assert.equal(page.focused, '#newPassword');
    assert.equal(page.redirects.length, 0);
    assert.equal(page.node('#controls').disabled, false);
});

test('existing sessions and reduced motion enter without artificial delay', async () => {
    const existing = await loginPage({ session: { authenticated: true } });
    assert.deepEqual(existing.redirects, ['/']);
    assert.equal(existing.timers.length, 0);
    const reduced = await loginPage({ reduced: true });
    await reduced.submit();
    assert.deepEqual(reduced.redirects, ['/']);
    assert.equal(reduced.timers.length, 0);
});

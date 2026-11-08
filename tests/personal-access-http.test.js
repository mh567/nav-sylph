'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { installation } = require('./helpers/installation');

test('personal workspace requires a normal session for pages and data', async t => {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    for (const route of ['/api/config', '/api/server-flags', '/api/modules/public', '/api/weibo-hot', '/api/version', '/api/changelog', '/api/favorites', '/API/CONFIG']) {
        const res = await app.request(route);
        assert.equal(res.status, 401, route);
        assert.match(res.headers.get('cache-control'), /no-store/);
    }
    for (const route of ['/', '/index', '/index.html', '/INDEX.HTML']) {
        const res = await fetch(app.base + route, { redirect: 'manual' });
        assert.equal(res.status, 302, route);
        assert.equal(res.headers.get('location'), '/login.html');
        assert.match(res.headers.get('cache-control'), /no-store/);
    }
    assert.equal((await app.request('/login.html')).status, 200);
    const login = await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await app.request('/', { cookie })).status, 200);
    assert.equal((await app.request('/api/config', { cookie })).status, 200);
    await app.request('/api/logout', { cookie, body: {} });
    assert.equal((await app.request('/api/config', { cookie })).status, 401);
});

test('restricted login cannot enter the workspace before changing password', async t => {
    const app = await installation(t);
    await app.start();
    const login = await app.request('/api/verify-password', { password: 'admin123', body: {} });
    assert.equal((await login.json()).passwordChangeRequired, true);
    const weak = login.headers.get('set-cookie').split(';')[0];
    for (const route of ['/api/config', '/api/modules/public']) {
        assert.equal((await app.request(route, { cookie: weak, ...(route.endsWith('/code') ? { body: {} } : {}) })).status, 401);
    }
    const changed = await app.request('/api/change-password', { cookie: weak, body: { currentPassword: 'admin123', newPassword: 'StrongPass123!' } });
    assert.equal(changed.status, 200);
    const cookie = changed.headers.get('set-cookie').split(';')[0];
    assert.equal((await app.request('/api/admin/navigation', { cookie })).status, 200);
});

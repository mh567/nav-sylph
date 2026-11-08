'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { installation } = require('./helpers/installation');

test('personal workspace removes passphrase spaces for visitors and administrators', async t => {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const Database = require('better-sqlite3');
    const db = new Database(path.join(app.dir, 'nav-sylph.db'), { readonly: true });
    try {
        assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'sync_*'").all(), []);
    } finally { db.close(); }
    const login = await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const auth of [{}, { cookie }]) {
        for (const [route, body] of [
            ['/api/sync/config', undefined], ['/api/sync/config', {}],
            ['/api/sync/space/check', {}], ['/api/sync/space/create', {}],
            ['/api/sync/space/connect', {}], ['/api/sync/space/delete', {}],
            ['/api/sync/device/reset', {}], ['/api/sync/device/revoke', {}],
            ['/api/admin/sync-invites', undefined], ['/api/admin/sync-invites/batch', {}],
            ['/api/admin/sync-spaces', undefined], ['/api/admin/sync-settings', {}]
        ]) assert.equal((await app.request(route, { ...auth, body })).status, 404, route);
    }
    const page = await (await app.request('/')).text();
    assert.doesNotMatch(page, /id="sync(?:Btn|Sep)"/);
    assert.equal((await app.request('/api/admin/navigation', { cookie })).status, 200);
    assert.equal((await app.request('/api/modules/config', { cookie })).status, 200);
    assert.equal((await app.request('/api/favorites', { cookie })).status, 200);
});

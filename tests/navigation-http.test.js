'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { installation } = require('./helpers/installation');
const personal = { theme: 'dark', showBookmarkIcons: false, searchEngine: 'one', searchEngines: [{ id: 'one', name: 'Example', url: 'https://example.com/?q=' }], categories: [{ id: 'c', name: 'Personal', bookmarks: [{ id: 'b', title: 'Link', url: 'https://example.com/' }] }], privacyMode: true, legacyPrivate: 'retain-me' };
async function login(app) {
    const res = await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie').split(';')[0];
}
test('HTTP: public template is independent from personal navigation, draft and published revisions survive restart', async t => {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify(personal));
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start(); const cookie = await login(app);
    const initial = await (await app.request('/api/config')).json();
    assert.equal(initial.legacyPrivate, undefined); assert.equal(initial.privacyMode, undefined);
    assert.deepEqual(await (await app.request('/api/config', { cookie })).json(), initial);
    assert.equal((await app.request('/api/admin/navigation')).status, 401);
    const admin = await (await app.request('/api/admin/navigation', { cookie })).json();
    assert.equal(admin.config.legacyPrivate, 'retain-me');
    assert.equal((await app.request('/api/config', { cookie, body: personal })).status, 409);
    const changed = structuredClone(admin.config); changed.categories[0].name = 'Private edit';
    let res = await app.request('/api/admin/navigation', { cookie, body: { config: changed, revision: admin.revision, operationId: 'personal-save-1' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await (await app.request('/api/config')).json(), initial);
    const template = await (await app.request('/api/admin/default-homepage', { cookie })).json();
    const draft = structuredClone(template.config); draft.categories[0].name = 'Public edit';
    res = await app.request('/api/admin/default-homepage/draft', { cookie, body: { config: draft, revision: template.revision, operationId: 'draft-save-1' } });
    assert.equal(res.status, 200); const saved = await res.json();
    assert.deepEqual(await (await app.request('/api/config')).json(), initial);
    const publish = { revision: saved.revision, publishedRevision: template.publishedRevision, operationId: 'publish-1' };
    res = await app.request('/api/admin/default-homepage/publish', { cookie, body: publish }); assert.equal(res.status, 200);
    const published = await res.json();
    assert.equal((await (await app.request('/api/config')).json()).categories[0].name, 'Public edit');
    assert.equal((await (await app.request('/api/admin/navigation', { cookie })).json()).config.categories[0].name, 'Private edit');
    await app.stop(); await app.start();
    assert.deepEqual(await (await app.request('/api/admin/default-homepage/publish', { cookie, body: publish })).json(), published);
    assert.equal((await app.request('/api/admin/navigation', { cookie, body: { config: changed, revision: admin.revision, operationId: 'stale' } })).status, 409);
    assert.equal((await app.request('/api/admin/default-homepage/draft', { cookie, body: { config: { ...draft, credentials: 'secret' }, revision: saved.revision, operationId: 'bad' } })).status, 400);
});

test('HTTP: invalid template writes and competing publishes cannot change public or personal configuration', async t => {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify(personal));
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start(); const cookie = await login(app);
    const base = await (await app.request('/api/admin/default-homepage', { cookie })).json();
    for (const mutate of [c => { c.categories[0].bookmarks[0].url = 'javascript:alert(1)'; }, c => { c.searchEngines = []; }, c => { c.searchEngines.push(c.searchEngines[0]); }, c => { c.searchEngines[0].url = 'file:///etc/passwd'; }, c => { c.modules = { enabledModules: ['memo'] }; }, c => { c.categories[0].password = 'secret'; }, c => { c.searchEngine = 'missing'; }, c => { c.searchEngines[0].url = 'https://example.com/{query}'; }]) {
        const config = structuredClone(base.config); mutate(config);
        const res = await app.request('/api/admin/default-homepage/draft', { cookie, body: { config, revision: base.revision, operationId: require('node:crypto').randomUUID() } });
        assert.equal(res.status, 400);
    }
    const writes = await Promise.all(['a', 'b'].map(name => {
        const config = structuredClone(base.config); config.categories[0].name = name;
        return app.request('/api/admin/default-homepage/draft', { cookie, body: { config, revision: base.revision, operationId: name } });
    }));
    assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);
    const current = await (await app.request('/api/admin/default-homepage', { cookie })).json();
    const body = { revision: current.revision, publishedRevision: current.publishedRevision, operationId: 'one' };
    assert.equal((await app.request('/api/admin/default-homepage/publish', { cookie, body })).status, 200);
    assert.equal((await app.request('/api/admin/default-homepage/publish', { cookie, body: { ...body, operationId: 'two' } })).status, 409);
    assert.equal((await app.request('/api/admin/default-homepage/publish', { cookie, body: { ...body, revision: 99 } })).status, 409);
    assert.equal((await app.request('/api/admin/navigation', { cookie, body: { config: { ...personal, credentials: 'new' }, revision: 1, operationId: 'inject' } })).status, 400);
    assert.equal((await (await app.request('/api/admin/navigation', { cookie })).json()).revision, 1);
    assert.equal((await app.request('/api/admin/default-homepage/draft', { body: { config: base.config, revision: 1, operationId: 'anon' } })).status, 401);
});

test('HTTP: upgrade snapshot preserves all private files and database; failed initialization is retryable', async t => {
    const app = await installation(t);
    const invalid = structuredClone(personal); invalid.categories[0].bookmarks[0].url = 'javascript:bad';
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify(invalid));
    fs.writeFileSync(path.join(app.dir, '.webdav-config.json'), '{"password":"original-secret"}');
    const { openDatabase } = require('../lib/db');
    const db = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    db.prepare('INSERT INTO memos VALUES (?, ?, ?, ?, ?, ?)').run('one', 'Private memo', 'Keep', 1, 1, 1); db.close();
    await assert.rejects(app.start());
    const snapshot = path.join(app.dir, '.navigation-upgrade-snapshot');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(snapshot, 'config.json'))), invalid);
    assert.equal(fs.readFileSync(path.join(snapshot, '.webdav-config.json'), 'utf8'), '{"password":"original-secret"}');
    assert.equal(fs.statSync(path.join(snapshot, '.webdav-config.json')).mode & 0o777, 0o600);
    const Database = require('better-sqlite3');
    const saved = new Database(path.join(snapshot, 'nav-sylph.db'), { readonly: true });
    assert.equal(saved.prepare('SELECT body FROM memos').get().body, 'Keep'); saved.close();
    const failed = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    assert.equal(failed.prepare('SELECT count(*) AS n FROM navigation_documents').get().n, 0); failed.close();
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify(personal));
    await app.start();
    assert.equal((await (await app.request('/api/config')).json()).categories[0].name, 'Personal');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(snapshot, 'config.json'))), invalid);
    const restarted = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    assert.equal(restarted.prepare('SELECT body FROM memos').get().body, 'Keep'); restarted.close();
});

test('HTTP: configured external database and password paths have a recoverable migration snapshot', async t => {
    const app = await installation(t);
    const external = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sylph-external-'));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    const database = path.join(external, 'custom.db');
    const password = path.join(external, 'custom-password.json');
    fs.copyFileSync(path.join(app.dir, '.admin-password.json'), password);
    fs.writeFileSync(path.join(app.dir, 'server-config.json'), JSON.stringify({ paths: { database }, security: { adminPasswordFile: password } }));
    const { openDatabase } = require('../lib/db'); const db = openDatabase(database);
    db.prepare('INSERT INTO memos VALUES (?, ?, ?, ?, ?, ?)').run('custom', 'Custom', 'External private data', 0, 1, 1); db.close();
    await app.start();
    const snapshot = path.join(app.dir, '.navigation-upgrade-snapshot');
    const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'RESTORE.json')));
    assert.ok(manifest.files.some(f => f.source === password));
    const entry = manifest.files.find(f => f.source === database); assert.ok(entry);
    const Database = require('better-sqlite3');
    const backup = new Database(path.join(snapshot, entry.snapshot), { readonly: true });
    assert.equal(backup.prepare('SELECT body FROM memos').get().body, 'External private data'); backup.close();
});

test('HTTP: factory initialization and supported legacy display defaults remain independent', async t => {
    const app = await installation(t);
    await app.start();
    const initial = await (await app.request('/api/config')).json();
    assert.equal(initial.theme, 'auto');
    assert.equal(initial.searchEngine, 'google');
    await app.stop();
    const legacy = { ...personal, bookmarks: personal.categories };
    delete legacy.categories; delete legacy.theme; delete legacy.showBookmarkIcons;
    // A separate installation models an old supported config, never resetting migrated data.
    const old = await installation(t);
    fs.writeFileSync(path.join(old.dir, 'config.json'), JSON.stringify(legacy));
    fs.writeFileSync(path.join(old.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await old.start(); const cookie = await login(old);
    const migrated = await (await old.request('/api/config')).json();
    assert.equal(migrated.theme, 'auto'); assert.equal(migrated.showBookmarkIcons, true);
    assert.equal(migrated.categories[0].name, 'Personal');
    assert.deepEqual((await (await old.request('/api/admin/navigation', { cookie })).json()).config, legacy);
});

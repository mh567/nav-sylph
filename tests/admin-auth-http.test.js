'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcrypt');
const { openDatabase } = require('../lib/db');
const { collectFingerprint } = require('../lib/session');
const ROOT = path.join(__dirname, '..');

async function installation(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-auth-'));
    for (const name of ['server.js', 'lib', 'server-config', 'public', 'version.json', 'CHANGELOG.json']) {
        fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('admin123', 4) }));
    fs.writeFileSync(path.join(dir, 'favorites.json'), JSON.stringify({ version: 1, favorites: [
        { id: 'open', title: 'formerly public', url: 'https://example.com/open', category: 'work' },
        { id: 'private', title: 'secret', url: 'https://example.com/secret', private: true }
    ] }));
    const net = require('node:net');
    const probe = net.createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise(r => probe.close(r));
    const base = `http://127.0.0.1:${port}`;
    let child, logs = '';
    async function start() {
        child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GEO_ENABLED: 'false', COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
            if (child.exitCode !== null) throw new Error(logs);
            await new Promise(r => setTimeout(r, 50));
        }
        throw new Error(logs);
    }
    async function stop() { if (child && child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); child.kill(); await done; } }
    t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
    async function request(route, { cookie, password, body, method, headers = {} } = {}) {
        return fetch(base + route, { method: method || (body ? 'POST' : 'GET'), headers: { 'User-Agent': 'sylph-auth-test', ...(cookie ? { Cookie: cookie } : {}), ...(password ? { 'X-Admin-Password': password } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Sylph-Request': '1', Origin: base } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    }
    return { dir, base, start, stop, request };
}
const cookieOf = res => res.headers.get('set-cookie').split(';')[0];

test('HTTP: weak login can only change password, strong login protects every favorite and persists', async t => {
    const app = await installation(t); await app.start();
    for (const route of ['/api/favorites', '/api/favorites/export', '/api/modules/config']) {
        assert.equal((await app.request(route)).status, 401);
        assert.equal((await app.request(route, { password: 'admin123' })).status, 401);
        assert.equal((await app.request(route, { cookie: 'nav_session=old' })).status, 401);
    }
    let res = await app.request('/api/verify-password', { password: 'admin123', body: {} });
    assert.equal((await res.json()).passwordChangeRequired, true);
    const weak = cookieOf(res);
    for (const route of ['/api/favorites', '/api/favorites/export', '/api/modules/config']) assert.equal((await app.request(route, { cookie: weak })).status, 401);
    assert.equal((await app.request('/api/trust-device', { cookie: weak, body: {} })).status, 401);
    for (const newPassword of ['Abcd123!', 'abcdefghijkl', 'abcdefghijk1']) {
        assert.equal((await app.request('/api/change-password', { cookie: weak, body: { currentPassword: 'admin123', newPassword } })).status, 400);
    }
    res = await app.request('/api/change-password', { cookie: weak, body: { currentPassword: 'admin123', newPassword: 'StrongPass123!' } });
    assert.equal(res.status, 200); assert.equal((await res.json()).success, true);
    const admin = cookieOf(res);
    assert.equal((await app.request('/api/favorites', { cookie: weak })).status, 401);
    res = await app.request('/api/favorites', { cookie: admin });
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.equal((await res.json()).favorites.length, 2);
    assert.equal((await app.request('/api/favorites/export', { cookie: admin })).status, 200);
    assert.equal((await app.request('/api/config', { cookie: admin, body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await app.request('/api/config', { cookie: admin, body: {}, headers: { 'X-Sylph-Request': '' } })).status, 403);
    await app.stop(); await app.start();
    assert.equal((await app.request('/api/favorites', { cookie: admin })).status, 200);
    await app.request('/api/logout', { cookie: admin, body: {} });
    assert.equal((await app.request('/api/favorites', { cookie: admin })).status, 401);
    assert.equal((await app.request('/api/config')).status, 200);
    assert.equal((await app.request('/api/p/code', { method: 'POST' })).status, 200);
});

test('HTTP: upgrade revokes legacy sessions and restricted credentials expire without renewal', async t => {
    const app = await installation(t);
    const Database = require('better-sqlite3');
    const { MIGRATIONS } = require('../lib/db');
    let db = new Database(path.join(app.dir, 'nav-sylph.db'));
    for (const migration of MIGRATIONS.slice(0, -1)) migration(db);
    db.pragma(`user_version = ${MIGRATIONS.length - 1}`);
    const old = 'a'.repeat(64);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(old, 0, Date.now() + 86400000,
        JSON.stringify(collectFingerprint({ headers: { 'user-agent': 'sylph-auth-test' } })), null);
    db.close();
    await app.start();
    assert.equal((await app.request('/api/favorites', { cookie: `nav_session=${old}` })).status, 401);
    let res = await app.request('/api/verify-password', { password: 'admin123', body: {} });
    const weak = cookieOf(res);
    db = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    const expiry = db.prepare('SELECT expires_at FROM sessions').get().expires_at;
    assert.ok(expiry <= Date.now() + 600000 && expiry > Date.now() + 590000);
    await app.request('/api/session', { cookie: weak });
    assert.equal(db.prepare('SELECT expires_at FROM sessions').get().expires_at, expiry);
    await app.stop(); await app.start();
    assert.equal((await (await app.request('/api/session', { cookie: weak })).json()).passwordChangeRequired, true);
    db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
    db.close();
    res = await app.request('/api/change-password', { cookie: weak, body: { currentPassword: 'admin123', newPassword: 'StrongPass123!' } });
    assert.equal(res.status, 401);
});

test('HTTP: credential re-encryption is verified and corrupt credentials fail without changing password', async t => {
    const app = await installation(t);
    const { encrypt, decrypt } = require('../lib/credentials');
    const passwordPath = path.join(app.dir, '.admin-password.json');
    const oldHash = JSON.parse(fs.readFileSync(passwordPath)).passwordHash;
    const webdavPath = path.join(app.dir, '.webdav-config.json');
    fs.writeFileSync(webdavPath, JSON.stringify({ password: encrypt('dav-secret', oldHash, 'webdav') }));
    const modulesPath = path.join(app.dir, '.modules.json');
    fs.writeFileSync(modulesPath, JSON.stringify({ servers: [{ id: 'test', token: encrypt('agent-secret', oldHash, 'modules') }] }));
    await app.start();
    let login = await app.request('/api/verify-password', { password: 'admin123', body: {} });
    let res = await app.request('/api/change-password', { cookie: cookieOf(login), body: { currentPassword: 'admin123', newPassword: 'StrongPass123!' } });
    assert.equal(res.status, 200);
    const admin = cookieOf(res);
    const newHash = JSON.parse(fs.readFileSync(passwordPath)).passwordHash;
    assert.equal(decrypt(JSON.parse(fs.readFileSync(webdavPath)).password, newHash, 'webdav'), 'dav-secret');
    assert.equal(decrypt(JSON.parse(fs.readFileSync(modulesPath)).servers[0].token, newHash, 'modules'), 'agent-secret');
    const corrupted = encrypt('dav-secret', 'wrong-hash', 'webdav');
    fs.writeFileSync(webdavPath, JSON.stringify({ password: corrupted }));
    res = await app.request('/api/change-password', { cookie: admin, body: { currentPassword: 'StrongPass123!', newPassword: 'AnotherPass123!' } });
    assert.equal(res.status, 500);
    assert.equal(JSON.parse(fs.readFileSync(passwordPath)).passwordHash, newHash);
    assert.equal((await app.request('/api/favorites', { cookie: admin })).status, 200);
});

test('HTTP: partial credential writes roll back, damaged JSON blocks rotation, restart recovers interrupted rotation', async t => {
    const app = await installation(t);
    const { encrypt, decrypt } = require('../lib/credentials');
    const passwordPath = path.join(app.dir, '.admin-password.json');
    const webdavPath = path.join(app.dir, '.webdav-config.json');
    const modulesPath = path.join(app.dir, '.modules.json');
    const originalPassword = fs.readFileSync(passwordPath, 'utf8');
    const oldHash = JSON.parse(originalPassword).passwordHash;
    const originalDav = JSON.stringify({ password: encrypt('dav-secret', oldHash, 'webdav') });
    fs.writeFileSync(webdavPath, originalDav);
    await app.start();
    const db = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    const now = Date.now();
    db.prepare(`INSERT INTO timeline_sources (id, provider_type, name, created_at, updated_at) VALUES ('broken-write', 'weibo', 'test', ?, ?)`).run(now, now);
    const originalEnvelope = JSON.stringify(encrypt('token', oldHash, 'timeline'));
    db.prepare('INSERT INTO timeline_credentials VALUES (?, ?)').run('broken-write', originalEnvelope);
    db.exec("CREATE TRIGGER fail_rotation BEFORE UPDATE ON timeline_credentials BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    const login = await app.request('/api/verify-password', { password: 'admin123', body: {} });
    const weak = cookieOf(login);
    let res = await app.request('/api/change-password', { cookie: weak, body: { currentPassword: 'admin123', newPassword: 'StrongPass123!' } });
    assert.equal(res.status, 500);
    assert.equal(fs.readFileSync(passwordPath, 'utf8'), originalPassword);
    assert.equal(fs.readFileSync(webdavPath, 'utf8'), originalDav);
    assert.equal(db.prepare('SELECT envelope_json FROM timeline_credentials').get().envelope_json, originalEnvelope);
    db.exec('DROP TRIGGER fail_rotation');
    const modules = fs.readFileSync(modulesPath, 'utf8');
    fs.writeFileSync(modulesPath, '{damaged');
    res = await app.request('/api/change-password', { cookie: weak, body: { currentPassword: 'admin123', newPassword: 'StrongPass123!' } });
    assert.equal(res.status, 500);
    assert.equal(fs.readFileSync(passwordPath, 'utf8'), originalPassword);
    fs.writeFileSync(modulesPath, modules);
    await app.stop();
    // Crash fixture: a durable recovery record and one already replaced file.
    fs.writeFileSync(path.join(app.dir, '.credential-rotation.json'), JSON.stringify({ files: [originalDav, modules, originalPassword], timeline: [{ source_id: 'broken-write', envelope_json: originalEnvelope }] }), { mode: 0o600 });
    fs.writeFileSync(webdavPath, JSON.stringify({ password: encrypt('dav-secret', 'uncommitted-hash', 'webdav') }));
    db.close();
    await app.start();
    assert.equal(fs.existsSync(path.join(app.dir, '.credential-rotation.json')), false);
    assert.equal(decrypt(JSON.parse(fs.readFileSync(webdavPath)).password, oldHash, 'webdav'), 'dav-secret');
    const recoveredLogin = await app.request('/api/verify-password', { password: 'admin123', body: {} });
    const recoveredCookie = cookieOf(recoveredLogin);
    assert.equal((await recoveredLogin.json()).valid, true);
    const rotated = await app.request('/api/change-password', { cookie: recoveredCookie, body: { currentPassword: 'admin123', newPassword: 'StrongPass123!' } });
    assert.equal(rotated.status, 200);
    const hash = JSON.parse(fs.readFileSync(passwordPath)).passwordHash;
    const verifiedDb = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    assert.equal(decrypt(JSON.parse(verifiedDb.prepare('SELECT envelope_json FROM timeline_credentials').get().envelope_json), hash, 'timeline'), 'token');
    verifiedDb.close();
    assert.equal((await app.request('/api/favorites', { cookie: recoveredCookie })).status, 401);
});

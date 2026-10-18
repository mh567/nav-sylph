'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcrypt');
const ROOT = path.join(__dirname, '../..');

async function installation(t, options = {}) {
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
        child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GEO_ENABLED: 'false', COOKIE_SECURE: 'false', ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

module.exports = { installation };

'use strict';

/**
 * #12 备份范围：**真实 HTTP + 真实 SQLite/文件 + 本地 WebDAV 桩**。
 *
 * 这里不做形状断言，全部走真实路径：
 *  安装目录里的 server.js 真的跑起来 → 真的读文件与库 → 真的把文件 PUT 到
 *  本地起的一个 WebDAV 桩上 → 用例再**直接向上游 GET 回来**逐个文件解析。
 *
 * 覆盖三件事：
 *  1. 产物逐字：文件集合、清单（domain / 文件字节 sha256 / counts / skipped）；
 *  2. 排除项**反向证明**：先在管理员导航与引擎里放独特字符串，再断言产物字节里
 *     根本不出现它们；顺便断言没有任何 AES-GCM 信封；
 *  3. 自动与手动同范围；恢复后备忘录 / 收藏 / 布局回来，而 `/api/config` 与
 *     `/api/admin/navigation` 一字未变。
 *
 * ⚠️ 不连真实 WebDAV：桩只实现 PROPFIND Depth:1 / GET / PUT / MKCOL / DELETE。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');

const { installation } = require('./helpers/installation');
const { openDatabase } = require('../lib/db.js');
const { encrypt } = require('../lib/credentials.js');
const { isEnvelope } = require('../lib/credentials.js');
const { sha256Bytes } = require('../lib/webdav-backup.js');

const PASSWORD = 'StrongPass123!';
// 反向证明用的独特字符串：只有这些字面量出现就说明「本该排除的域」被带进了备份。
const NAV_MARKER = 'NAV-MARKER-8f3a-私密分类';
const ENGINE_MARKER = 'ENGINE-MARKER-5c1d';
const MEMO_TITLE = 'MEMO-TITLE-2b7e 备忘正文标题';
const MEMO_BODY = 'MEMO-BODY-9a44 这是一段只有备份里才该出现的正文';
const TODO_MARKER = 'TODO-MARKER-51cf 待办一条';
const FAV_MARKER = 'FAV-MARKER-4d21 私密书签';
const TIMELINE_MARKER = 'TIMELINE-MARKER-77aa 一条事件';
const PUSH_SECRET_HASH = 'f'.repeat(64);
const ENROLL_TOKEN_HASH = 'e'.repeat(64);
const AGENT_TOKEN_PLAINTEXT = 'agent-token-plaintext-3c9d';

// ========== 本地 WebDAV 桩 ==========
function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createDavStub() {
    const files = new Map();       // '/backups/x.json' → 文本
    const dirs = new Set(['/']);
    const methods = [];
    const server = http.createServer((req, res) => {
        methods.push(req.method);
        const url = new URL(req.url, 'http://127.0.0.1');
        const filePath = decodeURIComponent(url.pathname);
        if (files.has(filePath)) {
            if (req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                res.end(files.get(filePath));
                return;
            }
            if (req.method === 'DELETE') {
                files.delete(filePath);
                res.writeHead(204);
                res.end();
                return;
            }
        }
        if (req.method === 'MKCOL') {
            dirs.add(filePath.endsWith('/') ? filePath : filePath + '/');
            res.writeHead(201);
            res.end();
            return;
        }
        if (req.method === 'PUT') {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                files.set(filePath, Buffer.concat(chunks).toString('utf8'));
                dirs.add(filePath.slice(0, filePath.lastIndexOf('/') + 1));
                res.writeHead(201);
                res.end();
            });
            return;
        }
        if (req.method === 'PROPFIND') {
            const dir = filePath.endsWith('/') ? filePath : filePath + '/';
            if (dir !== '/' && !dirs.has(dir)) {
                res.writeHead(404);
                res.end();
                return;
            }
            let xml = '<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">\n';
            xml += `<d:response><d:href>${escapeXml(dir)}</d:href><d:propstat><d:prop>`
                + '<d:resourcetype><d:collection/></d:resourcetype>'
                + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>\n';
            for (const [name, content] of files) {
                if (!name.startsWith(dir)) continue;
                xml += `<d:response><d:href>${escapeXml(name)}</d:href><d:propstat><d:prop>`
                    + '<d:resourcetype/>'
                    + `<d:getcontentlength>${Buffer.byteLength(content, 'utf8')}</d:getcontentlength>`
                    + '<d:getlastmodified>Wed, 08 Oct 2026 00:00:00 GMT</d:getlastmodified>'
                    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>\n';
            }
            xml += '</d:multistatus>';
            res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
            res.end(xml);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return { files, dirs, methods, server };
}

async function startStub(t) {
    const stub = createDavStub();
    await new Promise(resolve => stub.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${stub.server.address().port}`;
    t.after(() => new Promise(resolve => stub.server.close(resolve)));
    return { ...stub, base };
}

/** 直接向上游取回一个文件（与备份程序无关的一条独立路径）。 */
async function fetchUpstream(base, name) {
    const res = await fetch(`${base}${name}`);
    assert.equal(res.status, 200, `上游 GET ${name}`);
    return res.text();
}

/** 递归找 AES-GCM 信封。 */
function findEnvelopes(value, trail = '') {
    if (Array.isArray(value)) {
        return value.flatMap((item, i) => findEnvelopes(item, `${trail}[${i}]`));
    }
    if (!value || typeof value !== 'object') return [];
    if (isEnvelope(value)) return [trail || '<root>'];
    return Object.entries(value)
        .flatMap(([key, item]) => findEnvelopes(item, trail ? `${trail}.${key}` : key));
}

async function login(app) {
    const res = await app.request('/api/verify-password', { password: PASSWORD, body: {} });
    assert.equal(res.status, 200, '登录成功');
    return res.headers.get('set-cookie').split(';')[0];
}

// ========== 安装与种子数据 ==========

async function seedInstallation(t) {
    const app = await installation(t, { env: { NAV_AUTO_SYNC_DELAY_MS: '50' } });
    const hash = await bcrypt.hash(PASSWORD, 4);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: hash }));

    // 管理员导航与引擎：放独特字符串，备份完成后它们**一个字节都不该出现**。
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify({
        theme: 'dark',
        searchEngine: 'marker-engine',
        searchEngines: [{ id: 'marker-engine', name: ENGINE_MARKER, url: 'https://search.test/?q=' }],
        categories: [{ id: 'c1', name: NAV_MARKER, bookmarks: [{ id: 'b1', title: '导航项', url: 'https://nav.test/' }] }],
        privacyMode: true
    }));

    fs.writeFileSync(path.join(app.dir, 'favorites.json'), JSON.stringify({
        version: 1,
        favorites: [
            { id: 'fav1', title: FAV_MARKER, url: 'https://private.test/', category: '个人', private: true },
            { id: 'fav2', title: '公开书签', url: 'https://public.test/', category: '工作', private: false }
        ]
    }));

    // .modules.json：凭据、公开模块项、_sync 全在，投影后都应消失。
    fs.writeFileSync(path.join(app.dir, '.modules.json'), JSON.stringify({
        version: 1,
        enabledModules: ['server-monitor', 'memo', 'weibo-hot'],
        publicModules: ['weibo-hot'],
        widgets: [
            { id: 'weibo-hot', enabled: true, side: 'right', order: 0, collapsed: false },
            { id: 'server-monitor', enabled: true, side: 'left', order: 1, collapsed: false },
            { id: 'memo', enabled: false, side: 'left', order: 2, collapsed: true }
        ],
        servers: [{
            id: 'srv-home',
            name: '家里的机器',
            url: 'https://nas.test:8787',
            mode: 'push',
            reachable: true,
            token: encrypt(AGENT_TOKEN_PLAINTEXT, hash, 'modules'),
            pushSecretHash: PUSH_SECRET_HASH,
            enrollTokenHash: ENROLL_TOKEN_HASH,
            enrollTokenExpiresAt: 1893456000000,
            enrollTokenIp: '203.0.113.7',
            certPem: '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----',
            certFingerprint: 'a'.repeat(64),
            enrolledAt: 1767225600000,
            deployState: 'ready'
        }],
        socialAccounts: ['@alice-marker'],
        symbols: ['SYMBOL-MARKER'],
        pollInterval: 30,
        _sync: { revision: 3, receipts: {} }
    }));

    // SQLite：备忘录 + 时间线（真实库文件，恢复时也写这里）。
    const db = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    try {
        const now = Date.now();
        db.prepare('INSERT INTO memos (id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
            .run('memo-1', MEMO_TITLE, MEMO_BODY, now, now);
        db.prepare('INSERT INTO todos (id, text, done, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
            .run('todo-1', TODO_MARKER, now, now);
        db.prepare(`INSERT INTO timeline_sources
            (id, provider_type, name, external_key, settings_json, enabled, sync_cursor,
             sync_interval_ms, next_sync_at, last_attempt_at, last_success_at, last_error, created_at, updated_at)
            VALUES ('src-1','x','X · alice','alice','{}',1,NULL,900000,NULL,NULL,NULL,NULL,?,?)`)
            .run(now, now);
        db.prepare(`INSERT INTO timeline_events
            (id, source_id, event_type, provider_event_id, dedupe_key, occurred_at, ingested_at,
             author, title, summary, url, metadata_json)
            VALUES ('ev-1','src-1','social_post','p1','p1',?,?,'@alice',?,'摘要','https://x.test/p1','{}')`)
            .run(now, now, TIMELINE_MARKER);
        db.prepare('INSERT INTO timeline_event_state (event_id, archived_at, favorited_at) VALUES (?, ?, ?)')
            .run('ev-1', now, now);
    } finally {
        db.close();
    }

    await app.start();
    const cookie = await login(app);
    const dav = await startStub(t);
    const config = await app.request('/api/webdav/config', {
        cookie,
        body: {
            enabled: true,
            autoSync: false,
            url: dav.base,
            username: 'dav-user',
            password: 'dav-password',
            remotePath: '/backups/'
        }
    });
    assert.equal(config.status, 200, 'WebDAV 配置保存成功');
    return { app, cookie, dav };
}

/** 把上游 GET 回来的文件按 basename 索引。 */
async function upstreamFiles(dav, prefix = 'nav-sylph-') {
    // ⚠️ 桩里的键是**远端完整路径**（`/backups/nav-sylph-…`），前缀要按 basename 判：
    // 直接 startsWith 会得到空集合，断言就变成「空等于空」的假绿。
    const names = [...dav.files.keys()].filter(name => path.posix.basename(name).startsWith(prefix));
    const out = new Map();
    for (const name of names) out.set(path.posix.basename(name), await fetchUpstream(dav.base, name));
    return out;
}

// ========== 用例 ==========

test('真实 HTTP：备份产物只有一个清单声明的域集合，排除项在字节里根本不出现', async t => {
    const { app, cookie, dav } = await seedInstallation(t);

    const backup = await (await app.request('/api/webdav/backup', { cookie, body: {} })).json();
    assert.equal(backup.success, true, JSON.stringify(backup));

    const stored = await upstreamFiles(dav);
    const names = [...stored.keys()].sort();
    const ts = backup.timestamp;

    // 1) 文件集合逐字：五个域 + 清单，**没有 config**
    assert.deepEqual(names, [
        `nav-sylph-bookmarks-${ts}.html`,
        `nav-sylph-manifest-${ts}.json`,
        `nav-sylph-memos-${ts}.json`,
        `nav-sylph-modules-${ts}.json`,
        `nav-sylph-timeline-${ts}.json`,
        `nav-sylph-todos-${ts}.json`
    ]);
    assert.ok(!names.some(name => name.startsWith('nav-sylph-config')),
        '#12 起不再生成 nav-sylph-config-*.json');
    // 上游真的被 PUT 过这些名字（而不是本地拼出来的）
    assert.deepEqual([...dav.files.keys()].map(n => path.posix.basename(n)).sort(), names);

    // 2) 排除项反向证明：管理员导航与引擎的独特字符串一个字节都不出现
    for (const [name, content] of stored) {
        // 清单是**关于**排除项的文档（skipped 的原因里会点名这些字段），所以
        // 「字节里不出现」这条只对数据文件成立——数据文件才是被拷出去的东西。
        if (name.includes('manifest')) continue;
        for (const forbidden of [NAV_MARKER, ENGINE_MARKER, 'privacyMode',
            AGENT_TOKEN_PLAINTEXT, PUSH_SECRET_HASH, ENROLL_TOKEN_HASH,
            '203.0.113.7', '@alice-marker', 'SYMBOL-MARKER', 'weibo-hot',
            '"token"', 'pushSecretHash', 'enrollTokenHash', 'socialAccounts',
            'publicModules', 'symbols', '"_sync"', '"receipts"']) {
            assert.ok(!content.includes(forbidden),
                `${name} 里不得出现「${forbidden}」（排除项必须真的被挡住，不是文档里说说）`);
        }
        // 密码哈希更不该出现
        assert.ok(!content.includes('passwordHash'));
    }

    // 3) 每个 JSON 产物都不得含 AES-GCM 信封；HTML 也一样
    for (const [name, content] of stored) {
        if (name.endsWith('.html')) {
            assert.ok(!content.includes('"iv"'), 'HTML 里没有信封');
            continue;
        }
        const parsed = JSON.parse(content);
        assert.deepEqual(findEnvelopes(parsed), [], `${name} 里不得有信封`);
    }

    // 4) 保留项与应含项：凭据没了，公钥/注册信息与私人数据都在
    const modules = JSON.parse(stored.get(`nav-sylph-modules-${ts}.json`));
    assert.equal(modules.version, 2, '信封版本 1→2');
    assert.equal(modules.data.servers.length, 1);
    const server = modules.data.servers[0];
    assert.equal(server.id, 'srv-home');
    assert.equal(server.token, undefined, 'servers[].token 不进备份');
    assert.equal(server.certPem.startsWith('-----BEGIN CERTIFICATE-----'), true, 'certPem 保留（公钥不是凭据）');
    assert.equal(server.deployState, 'ready', 'deployState 保留');
    assert.equal(server.enrolledAt, 1767225600000, 'enrolledAt 保留');
    assert.equal(modules.data.servers[0].certFingerprint, 'a'.repeat(64), 'certFingerprint 保留');
    assert.deepEqual(modules.data.widgets.map(w => w.id), ['server-monitor', 'memo'],
        '公开模块的布局项不进备份，私人项在');
    assert.deepEqual(modules.data.enabledModules, ['server-monitor', 'memo']);

    const memos = JSON.parse(stored.get(`nav-sylph-memos-${ts}.json`));
    assert.equal(memos.data.memos.length, 1);
    assert.equal(memos.data.memos[0].body, MEMO_BODY, '备忘录正文进备份');
    assert.equal(memos.data.memos[0].pinned, true, '备忘录状态（置顶）进备份');

    const todos = JSON.parse(stored.get(`nav-sylph-todos-${ts}.json`));
    assert.equal(todos.data.todos.length, 1);
    assert.equal(todos.data.todos[0].text, TODO_MARKER, '待办文字进备份');
    assert.equal(todos.data.todos[0].done, true, '待办完成态进备份');

    const bookmarks = stored.get(`nav-sylph-bookmarks-${ts}.html`);
    assert.ok(bookmarks.includes(FAV_MARKER), '收藏进备份');
    assert.match(bookmarks, /DATA-SYLPH-PRIVATE="1"/, '隐私标签进备份');

    const timeline = JSON.parse(stored.get(`nav-sylph-timeline-${ts}.json`));
    assert.equal(timeline.data.events[0].title, TIMELINE_MARKER, '时间线事件进备份');
    assert.equal(timeline.data.eventState[0].favorited_at > 0, true, '收藏状态进备份');
    assert.equal(timeline.data.eventState[0].archived_at > 0, true, '归档状态进备份');

    // 5) 清单：included 的 sha256 必须等于**上游那份文件的字节**摘要
    const manifest = JSON.parse(stored.get(`nav-sylph-manifest-${ts}.json`));
    assert.equal(manifest.type, 'nav-sylph-manifest');
    assert.deepEqual(manifest.data.included.map(entry => entry.domain),
        ['favorites', 'memos', 'todos', 'modules', 'timeline']);
    for (const entry of manifest.data.included) {
        const bytes = stored.get(entry.file);
        assert.ok(bytes !== undefined, `清单里的 ${entry.file} 真的在上游`);
        assert.equal(entry.sha256, sha256Bytes(bytes), `${entry.domain} 的 sha256 与真实字节一致`);
    }
    const skippedDomains = manifest.data.skipped.map(item => item.domain);
    for (const domain of ['admin-navigation', 'default-template', 'sync-spaces', 'passwords-sessions',
        'metrics-cache', 'modules.publicModules', 'modules.socialAccounts', 'modules.symbols',
        'modules._sync', 'modules.servers[].token', 'modules.servers[].pushSecretHash',
        'modules.servers[].enrollTokenHash', 'timeline.credentials']) {
        assert.ok(skippedDomains.includes(domain), `清单必须写明跳过了 ${domain}`);
        assert.ok(manifest.data.skipped.find(i => i.domain === domain).reason.length > 4);
    }

    // 6) 幂等：内容没变时再点一次「立即备份」不重复上传
    const again = await (await app.request('/api/webdav/backup', { cookie, body: {} })).json();
    assert.equal(again.noChanges, true, '没有变化就不上传（否则每轮都在写远端）');
});

test('真实 HTTP：自动同步与手动备份的范围一致（同一组清单域）', async t => {
    const { app, cookie, dav } = await seedInstallation(t);

    const manual = await (await app.request('/api/webdav/backup', { cookie, body: {} })).json();
    assert.equal(manual.success, true);

    // 打开自动同步，然后改一条备忘录：备忘录在 SQLite 里，靠写路由自己排期
    const toggled = await (await app.request('/api/webdav/config', {
        cookie, body: { enabled: true, autoSync: true }
    })).json();
    assert.equal(toggled.success, true);

    const created = await (await app.request('/api/memos', {
        cookie, body: { title: '自动同步备忘录', body: 'AUTO-MEMO-BODY-1f2e' }
    })).json();
    assert.ok(created.memo.id);

    // 等自动槽位落地（NAV_AUTO_SYNC_DELAY_MS=50，给足余量）
    const autoNames = [`nav-sylph-manifest-auto.json`, 'nav-sylph-memos-auto.json'];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        if (autoNames.every(name => dav.files.has('/backups/' + name))) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(dav.files.has('/backups/nav-sylph-memos-auto.json'), '自动备份写出了备忘录文件');
    assert.ok(dav.files.has('/backups/nav-sylph-manifest-auto.json'), '自动备份写清单');
    assert.ok(!dav.files.has('/backups/nav-sylph-config-auto.json'), '自动备份也不再写 config');

    const manualManifest = JSON.parse(await fetchUpstream(dav.base, `/backups/${manual.manifestFilename}`));
    const autoManifest = JSON.parse(await fetchUpstream(dav.base, '/backups/nav-sylph-manifest-auto.json'));
    assert.deepEqual(autoManifest.data.included.map(e => e.domain),
        manualManifest.data.included.map(e => e.domain),
        '手动与自动遵守同一份范围');
    assert.deepEqual(autoManifest.data.skipped, manualManifest.data.skipped, '跳过项也一致');

    // 自动产物同样不得带凭据与导航
    const autoMemos = await fetchUpstream(dav.base, '/backups/nav-sylph-memos-auto.json');
    assert.ok(autoMemos.includes('AUTO-MEMO-BODY-1f2e'), '新改的备忘录进了自动备份');
    assert.ok(!autoMemos.includes(NAV_MARKER) && !autoMemos.includes(AGENT_TOKEN_PLAINTEXT));
    const autoModules = await fetchUpstream(dav.base, '/backups/nav-sylph-modules-auto.json');
    assert.ok(!autoModules.includes(AGENT_TOKEN_PLAINTEXT), '自动备份同样没有令牌');
    for (const entry of autoManifest.data.included) {
        const bytes = await fetchUpstream(dav.base, '/backups/' + entry.file);
        assert.equal(entry.sha256, sha256Bytes(bytes), `自动槽位 ${entry.domain} 的 sha256 也对得上`);
        if (entry.file.endsWith('.json')) assert.deepEqual(findEnvelopes(JSON.parse(bytes)), []);
    }
});

test('真实 HTTP：恢复让备忘录/收藏/布局回来，而导航与配置一字未变', async t => {
    const { app, cookie, dav } = await seedInstallation(t);

    // 恢复前的两组「不该被碰」的数据
    const configBefore = await (await app.request('/api/config', { cookie })).json();
    const adminNavBefore = await (await app.request('/api/admin/navigation', { cookie })).json();
    assert.equal(adminNavBefore.config.categories[0].name, NAV_MARKER, '种子导航在管理域里');

    const backup = await (await app.request('/api/webdav/backup', { cookie, body: {} })).json();
    assert.equal(backup.success, true);

    // 破坏现场：删备忘录与待办、换收藏、清掉模块布局
    const memos = await (await app.request('/api/memos', { cookie })).json();
    for (const memo of memos.memos) {
        assert.equal((await app.request(`/api/memos/${memo.id}`, { cookie, method: 'DELETE', body: {} })).status, 200);
    }
    const todosBefore = await (await app.request('/api/todos', { cookie })).json();
    for (const todo of todosBefore.todos) {
        assert.equal((await app.request(`/api/todos/${todo.id}`, { cookie, method: 'DELETE', body: {} })).status, 200);
    }
    const favs = await (await app.request('/api/favorites', { cookie })).json();
    for (const fav of favs.favorites) {
        await app.request(`/api/favorites/${fav.id}`, { cookie, method: 'DELETE', body: {} });
    }
    await app.request('/api/favorites', {
        cookie, body: { title: '恢复后应被抹掉的书签', url: 'https://gone.test/', category: '工作' }
    });
    // 模块：清掉机器与私人布局，但保留（并改变）本机公开模块的开放名单——
    // 恢复时这一项必须取本机的值，不能被备份里的「没有」抹掉。
    const modulesBefore = await (await app.request('/api/modules/config', { cookie })).json();
    const modulesWrite = await app.request('/api/modules/config', {
        cookie,
        body: {
            // 版本化写入：不带当前 revision 会被拒（409），真实客户端就是这么传的。
            revision: modulesBefore.revision,
            operationId: 'restore-test-modules-1',
            enabledModules: ['weibo-hot'],
            widgets: [{ id: 'weibo-hot', enabled: true, side: 'right', order: 0 }],
            servers: [],
            publicModules: ['weibo-hot'],
            socialAccounts: ['@after'],
            symbols: ['AFTER']
        }
    });
    assert.equal(modulesWrite.status, 200, JSON.stringify(await modulesWrite.clone().json()));

    assert.equal((await (await app.request('/api/memos', { cookie })).json()).memos.length, 0, '备忘录被清空');
    assert.equal((await (await app.request('/api/todos', { cookie })).json()).todos.length, 0, '待办被清空');

    // 真实恢复：文件按列表里的那组名字传
    const listed = await (await app.request('/api/webdav/list', { cookie })).json();
    const group = listed.backups.find(entry => !entry.isAuto);
    assert.ok(group, '列表里有一组手动备份');
    const restoreRes = await app.request('/api/webdav/restore', {
        cookie,
        body: {
            bookmarksFile: group.bookmarksFile,
            memosFile: group.memosFile,
            todosFile: group.todosFile,
            modulesFile: group.modulesFile,
            timelineFile: group.timelineFile,
            manifestFile: group.manifestFile
        }
    });
    const restored = await restoreRes.json();
    assert.equal(restoreRes.status, 200, JSON.stringify(restored));
    assert.equal(restored.success, true);
    assert.equal(restored.restoredMemos, true);
    assert.equal(restored.restoredTodos, true);
    assert.equal(restored.restoredBookmarks, true);
    assert.equal(restored.restoredModules, true);
    assert.equal(restored.restoredTimeline, true);
    assert.deepEqual(restored.skipped, [], '新备份里没有被跳过的域');

    // 备忘录回来了（正文与状态）
    const memosAfter = await (await app.request('/api/memos', { cookie })).json();
    assert.equal(memosAfter.memos.length, 1);
    assert.equal(memosAfter.memos[0].title, MEMO_TITLE);
    assert.equal(memosAfter.memos[0].body, MEMO_BODY);
    assert.equal(memosAfter.memos[0].pinned, true);

    // 待办回来了（文字与完成态）
    const todosAfter = await (await app.request('/api/todos', { cookie })).json();
    assert.equal(todosAfter.todos.length, 1);
    assert.equal(todosAfter.todos[0].text, TODO_MARKER);
    assert.equal(todosAfter.todos[0].done, true);

    // 收藏回来了，且隐私标签在
    const favsAfter = await (await app.request('/api/favorites', { cookie })).json();
    const titles = favsAfter.favorites.map(f => f.title);
    assert.ok(titles.includes(FAV_MARKER), '收藏回来了');
    assert.ok(!titles.includes('恢复后应被抹掉的书签'), '本地后来加的书签被这一组备份替换掉');
    assert.equal(favsAfter.favorites.find(f => f.title === FAV_MARKER).private, true, '隐私标签回位');

    // 布局回来了，凭据没有回填
    const modulesAfter = await (await app.request('/api/modules/config', { cookie })).json();
    assert.deepEqual(modulesAfter.widgets.map(w => w.id), ['weibo-hot', 'server-monitor', 'memo'],
        '私人布局回来，本机公开模块项保留在最前');
    assert.equal(modulesAfter.servers.length, 1);
    assert.equal(modulesAfter.servers[0].id, 'srv-home');
    assert.equal(modulesAfter.servers[0].hasToken, false, '凭据不回填');
    assert.equal(modulesAfter.servers[0].deployState, 'pending',
        '缺凭据的机器落到既有词表里的「等待部署」，而不是继续显示「已就绪」');
    assert.deepEqual(modulesAfter.publicModules, ['weibo-hot'], '本机对访客的开放名单没被抹掉');
    assert.deepEqual(modulesAfter.socialAccounts, ['@after'], '界面资料取本机');
    assert.deepEqual(modulesAfter.symbols, ['AFTER']);
    assert.deepEqual(restored.needsAuthorization.map(item => item.id), ['srv-home'],
        '响应里列出恢复后需重新授权的机器');

    // 时间线回来了。⚠️ 不走列表接口：种子把这条事件标成**已归档**，而列表默认不列
    // 归档项——查库才是这个断言的意图（事件与其归档/收藏状态都真的回到库里）。
    const dbAfter = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    try {
        const event = dbAfter.prepare('SELECT title FROM timeline_events WHERE id = ?').get('ev-1');
        assert.ok(event && event.title === TIMELINE_MARKER, '事件回位（库里）');
        const state = dbAfter.prepare('SELECT archived_at, favorited_at FROM timeline_event_state WHERE event_id = ?').get('ev-1');
        assert.ok(state && state.archived_at > 0 && state.favorited_at > 0, '归档与收藏状态也回来了');
    } finally {
        dbAfter.close();
    }

    // 导航与配置一字未变
    assert.deepEqual(await (await app.request('/api/config', { cookie })).json(), configBefore,
        '公开导航（含引擎）一字未变');
    assert.deepEqual(await (await app.request('/api/admin/navigation', { cookie })).json(), adminNavBefore,
        '管理员导航域一字未变（恢复不再碰它）');
});

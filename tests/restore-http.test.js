'use strict';

/**
 * #13 恢复：**真实 HTTP + 真实 SQLite/文件 + 本地 WebDAV 桩**。
 *
 * 覆盖（每条都走真实路径，不做源码形状断言）：
 *  1. 预览清单（将恢复 / 将跳过 / 凭据待授权 / 新版本号）+ 成功恢复 + 版本递增；
 *  2. `planDigest` 不一致 → 409（现场在预览之后变了）；
 *  3. **故障注入**：让时间线那一域写失败 → 已应用域按逆序全回滚、版本不变、文件逐字节一致；
 *  4. 恢复期间的并发写 → 503 `busy` + `Retry-After`，且那次写没有落地；
 *  5. 旧备份（`type:'nav-sylph-backup'`）**只恢复书签**，导航/模板一字未动。
 *
 * ⚠️ 不连真实 WebDAV：桩只实现 PROPFIND Depth:1 / GET / PUT / MKCOL / DELETE，
 * 与 #12（tests/backup-scope-http.test.js）那份等价。#12 的桩是内联在该文件里的
 * 局部函数、没有导出，而本轮的改动范围不允许新增 tests/helpers/*，所以这里复制一份
 * 而不是抽公共模块——两份的唯一差别是这里多了可控的 `delayMs`（用来撑开发恢复窗口）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');

const { installation } = require('./helpers/installation');
const { openDatabase } = require('../lib/db.js');
const { calculateChecksum } = require('../lib/webdav-backup.js');

const PASSWORD = 'StrongPass123!';
const FAV_MARKER = 'FAV-MARKER-13 私密书签';
const MEMO_TITLE = 'MEMO-13 恢复出来的备忘';
const MEMO_BODY = 'MEMO-BODY-13 正文';
const TODO_TEXT = 'TODO-13 恢复出来的待办';
const TIMELINE_TITLE = 'TIMELINE-13 一条事件';
const LOCAL_MARKER = 'LOCAL-13 本机后加的书签';

// ========== 本地 WebDAV 桩 ==========
function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createDavStub() {
    const files = new Map();
    const dirs = new Set(['/']);
    const stub = { delayMs: 0 };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const filePath = decodeURIComponent(url.pathname);
        // GET 是恢复流程里唯一有大段耗时的动作：加一个可控延迟，撑开「恢复进行中」的窗口
        const later = fn => (stub.delayMs ? setTimeout(fn, stub.delayMs) : fn());
        if (files.has(filePath)) {
            if (req.method === 'GET') {
                return later(() => {
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                    res.end(files.get(filePath));
                });
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
    return { files, dirs, server, stub };
}

async function startStub(t) {
    const dav = createDavStub();
    await new Promise(resolve => dav.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${dav.server.address().port}`;
    t.after(() => new Promise(resolve => dav.server.close(resolve)));
    return { ...dav, base };
}

// ========== 安装与种子数据 ==========

async function seed(t) {
    const app = await installation(t, { env: { NAV_AUTO_SYNC_DELAY_MS: '50' } });
    const hash = await bcrypt.hash(PASSWORD, 4);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: hash }));

    // 管理员导航/引擎：恢复**不得**触碰它们（旧备份的 config 域进 skip）。
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify({
        theme: 'dark',
        searchEngine: 'marker-engine',
        searchEngines: [{ id: 'marker-engine', name: 'ENGINE-13', url: 'https://search.test/?q=' }],
        categories: [{ id: 'c1', name: 'NAV-13 分类', bookmarks: [{ id: 'b1', title: '导航项', url: 'https://nav.test/' }] }]
    }));

    fs.writeFileSync(path.join(app.dir, 'favorites.json'), JSON.stringify({
        version: 1,
        favorites: [
            { id: 'fav1', title: FAV_MARKER, url: 'https://private.test/', category: '个人', private: true },
            { id: 'fav2', title: '公开书签', url: 'https://public.test/', category: '工作', private: false }
        ]
    }));

    fs.writeFileSync(path.join(app.dir, '.modules.json'), JSON.stringify({
        version: 1,
        enabledModules: ['server-monitor', 'memo'],
        publicModules: ['weibo-hot'],
        widgets: [
            { id: 'server-monitor', enabled: true, side: 'left', order: 0, collapsed: false },
            { id: 'memo', enabled: true, side: 'left', order: 1, collapsed: false }
        ],
        servers: [{
            id: 'srv-home', name: '家里的机器', url: 'https://nas.test:8787', mode: 'push', reachable: true,
            token: { iv: 'aXY=', data: 'ZGF0YQ==', tag: 'dGFn' }, pushSecretHash: 'f'.repeat(64),
            certPem: '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----', deployState: 'ready'
        }],
        pollInterval: 30,
        _sync: { revision: 3, receipts: {} }
    }));

    const db = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    try {
        const now = Date.now();
        db.prepare('INSERT INTO memos (id, title, body, pinned, created_at, updated_at) VALUES (?,?,?,1,?,?)')
            .run('memo-1', MEMO_TITLE, MEMO_BODY, now, now);
        db.prepare('INSERT INTO todos (id, text, done, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
            .run('todo-1', TODO_TEXT, now, now);
        db.prepare(`INSERT INTO timeline_sources
            (id, provider_type, name, external_key, settings_json, enabled, sync_cursor,
             sync_interval_ms, next_sync_at, last_attempt_at, last_success_at, last_error, created_at, updated_at)
            VALUES ('src-1','x','X · alice','alice','{}',1,NULL,900000,NULL,NULL,NULL,NULL,?,?)`).run(now, now);
        db.prepare(`INSERT INTO timeline_events
            (id, source_id, event_type, provider_event_id, dedupe_key, occurred_at, ingested_at,
             author, title, summary, url, metadata_json)
            VALUES ('ev-1','src-1','social_post','p1','p1',?,?,'@alice',?,'摘要','https://x.test/p1','{}')`)
            .run(now, now, TIMELINE_TITLE);
        // 凭据行：只在快照里，绝不进备份/日志/响应
        db.prepare('INSERT INTO timeline_credentials (source_id, envelope_json) VALUES (?, ?)')
            .run('src-1', JSON.stringify({ v: 1, purpose: 'timeline', iv: 'aXY=', data: 'ZGF0YQ==', tag: 'dGFn' }));
    } finally {
        db.close();
    }

    await app.start();
    const login = await app.request('/api/verify-password', { password: PASSWORD, body: {} });
    assert.equal(login.status, 200, '登录成功');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const dav = await startStub(t);
    const config = await app.request('/api/webdav/config', {
        cookie,
        body: { enabled: true, autoSync: false, url: dav.base, username: 'dav-user', password: 'dav-password', remotePath: '/backups/' }
    });
    assert.equal(config.status, 200, 'WebDAV 配置保存成功');
    return { app, cookie, dav };
}

/** 备份一次，返回列表里那一组手动备份的文件名（恢复要用它们，不用自己拼名字）。 */
async function backupOnce(t) {
    const { app, cookie, dav } = await seed(t);
    const backup = await (await app.request('/api/webdav/backup', { cookie, body: {} })).json();
    assert.equal(backup.success, true, JSON.stringify(backup));
    const listed = await (await app.request('/api/webdav/list', { cookie })).json();
    const group = listed.backups.find(entry => !entry.isAuto);
    assert.ok(group, '列表里有一组手动备份');
    const selection = {
        bookmarksFile: group.bookmarksFile,
        memosFile: group.memosFile,
        todosFile: group.todosFile,
        modulesFile: group.modulesFile,
        timelineFile: group.timelineFile,
        manifestFile: group.manifestFile
    };
    return { app, cookie, dav, group, selection };
}

function readJsonFile(dir, name) {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

function snapshotDirs(dir) {
    const root = path.join(dir, '.restore-snapshot');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root);
}

function readRestoreRecords(dir) {
    const db = openDatabase(path.join(dir, 'nav-sylph.db'));
    try {
        return db.prepare('SELECT * FROM restore_records ORDER BY created_at').all()
            .map(row => ({ ...row, applied: JSON.parse(row.applied_json), domains: JSON.parse(row.domains_json) }));
    } finally {
        db.close();
    }
}

// ========== 1. 预览 + 成功恢复 + 版本递增 ==========

test('真实 HTTP：预览出清单与 planDigest，恢复成功后版本递增、快照清理', async t => {
    const { app, cookie, selection } = await backupOnce(t);

    // 预览：只读，不写盘
    const previewRes = await app.request('/api/webdav/restore/preview', { cookie, body: selection });
    const preview = await previewRes.json();
    assert.equal(previewRes.status, 200, JSON.stringify(preview));
    assert.match(preview.planDigest, /^[0-9a-f]{64}$/);

    const plan = preview.plan;
    const restoreDomains = plan.domains.filter(entry => entry.action === 'restore').map(entry => entry.domain).sort();
    assert.deepEqual(restoreDomains, ['favorites', 'memos', 'modules', 'timeline', 'todos'], '五域都将恢复');
    // 派生域与「本机不恢复的域」都在 skip 里给了原因
    const skippedDomains = plan.domains.filter(entry => entry.action === 'skip').map(entry => entry.domain);
    assert.ok(skippedDomains.includes('metrics-cache'), '派生域进 skip');
    for (const entry of plan.domains.filter(item => item.action === 'skip')) assert.ok(entry.reason, `${entry.domain} 有原因`);
    // 新版本号：收藏与模块各 +1，管理员导航不动
    assert.equal(plan.versions.after.favorites, plan.versions.before.favorites + 1);
    assert.equal(plan.versions.after.modules, plan.versions.before.modules + 1);
    assert.equal(plan.versions.after['navigation-admin'], plan.versions.before['navigation-admin']);
    // 凭据待授权：备份里的机器在本机没有令牌 → pending；时间线外部来源 → pending_authorization
    // 本机已有令牌的机器（srv-home）不算待授权：它的凭据没随备份，但本机那份还在。
    // 时间线的外部来源没有凭据可留 → pending_authorization。
    const pendingIds = plan.pendingAuthorization.map(item => item.id).sort();
    assert.deepEqual(pendingIds, ['src-1']);
    assert.equal(plan.pendingAuthorization[0].state, 'pending_authorization');
    assert.deepEqual(plan.unknownModules, [], '备份里的模块本机都有实现');
    // 清单：有一份 manifest，且它列了五个域
    assert.ok(preview.manifest && Array.isArray(preview.manifest.included));
    assert.equal(preview.manifest.included.length, 5);
    assert.equal(snapshotDirs(app.dir).length, 0, '预览不落快照');

    // 破坏现场：加一个本机书签、清掉备忘录
    // 收藏接口是**批量**形状（`{favorites: [...]}`），与真实客户端一致
    const added = await app.request('/api/favorites', {
        cookie,
        body: { favorites: [{ id: 'local-13', title: LOCAL_MARKER, url: 'https://local.test/', category: '工作' }] }
    });
    assert.equal(added.status, 200);
    const db0 = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    db0.prepare('DELETE FROM memos').run();
    db0.prepare('DELETE FROM todos').run();
    db0.close();

    const restoreRes = await app.request('/api/webdav/restore', { cookie, body: { ...selection, planDigest: preview.planDigest } });
    const restored = await restoreRes.json();
    assert.equal(restoreRes.status, 200, JSON.stringify(restored));
    assert.equal(restored.restoredBookmarks, true);
    assert.equal(restored.restoredMemos, true);
    assert.equal(restored.restoredTodos, true);
    assert.equal(restored.restoredModules, true);
    assert.equal(restored.restoredTimeline, true);
    assert.equal(restored.restoreGeneration, 1, '成功恢复的代次从 1 开始');
    // 模块版本 +1（恢复成功了才递增）
    assert.equal(restored.modulesRevision, plan.versions.after.modules);
    // 同一台机器在本机仍有令牌 → 不需要重新授权（这不是缺陷，是「不该多问」）
    assert.deepEqual(restored.needsAuthorization, []);

    // 收藏：整份替换回备份那份，本机后加的不见了，隐私标签在位
    const favorites = readJsonFile(app.dir, 'favorites.json');
    const titles = favorites.favorites.map(item => item.title);
    assert.ok(titles.includes(FAV_MARKER));
    assert.ok(!titles.includes(LOCAL_MARKER));
    assert.equal(favorites.favorites.find(item => item.title === FAV_MARKER).private, true);
    assert.equal(favorites.revision, plan.versions.after.favorites, '收藏版本 +1（恢复代次印记）');

    // 模块：布局回来了，凭据仍是本机的（备份里没有它，也没被抹掉）
    const modules = readJsonFile(app.dir, '.modules.json');
    assert.deepEqual(modules.widgets.map(widget => widget.id), ['server-monitor', 'memo']);
    assert.deepEqual(modules.servers[0].token, { iv: 'aXY=', data: 'ZGF0YQ==', tag: 'dGFn' });

    // 备忘录回来了
    const memos = await (await app.request('/api/memos', { cookie })).json();
    assert.equal(memos.memos.length, 1);
    assert.equal(memos.memos[0].title, MEMO_TITLE);

    // 待办回来了（文字与完成态）
    const todos = await (await app.request('/api/todos', { cookie })).json();
    assert.equal(todos.todos.length, 1);
    assert.equal(todos.todos[0].text, TODO_TEXT);
    assert.equal(todos.todos[0].done, true);

    // 管理员导航/引擎：一字未动
    const navAfter = await (await app.request('/api/admin/navigation', { cookie })).json();
    assert.equal(navAfter.config.searchEngine, 'marker-engine');

    // 记录：一条 applied 记录，快照已清理
    const records = readRestoreRecords(app.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].phase, 'applied');
    assert.equal(records[0].generation, 1);
    assert.deepEqual(records[0].applied, ['memos', 'todos', 'favorites', 'modules', 'timeline']);
    assert.equal(records[0].snapshot_dir === null ? 0 : snapshotDirs(app.dir).length, 0, '快照被删除');

    // 时间线凭据：备份不带凭据 → 恢复后表是空的（来源待授权），而不是留着旧凭据
    const db1 = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    try {
        assert.equal(db1.prepare('SELECT COUNT(*) AS n FROM timeline_credentials').get().n, 0);
        assert.equal(db1.prepare('SELECT COUNT(*) AS n FROM memos').get().n, 1);
        assert.equal(db1.prepare('SELECT COUNT(*) AS n FROM todos').get().n, 1);
    } finally {
        db1.close();
    }
});

// ========== 2. digest 不一致 → 409 ==========

test('真实 HTTP：预览之后模块被改过 → 409 请重新预览，且什么都没写', async t => {
    const { app, cookie, selection } = await backupOnce(t);
    const preview = await (await app.request('/api/webdav/restore/preview', { cookie, body: selection })).json();
    assert.ok(preview.planDigest);

    // 现场变化：另一个标签页改了模块配置（版本 +1、多出一台待授权机器）
    const before = await (await app.request('/api/modules/config', { cookie })).json();
    const write = await app.request('/api/modules/config', {
        cookie,
        body: {
            revision: before.revision,
            operationId: 'restore-http-409-1',
            servers: before.servers.map(server => ({
                id: server.id, name: server.name, url: server.url, mode: server.mode
            })).concat([{ id: 'srv-other', name: '别的机器', url: 'https://other.test:8787', mode: 'pull' }])
        }
    });
    assert.equal(write.status, 200, '改动落地');
    const favoritesBefore = fs.readFileSync(path.join(app.dir, 'favorites.json'));

    const res = await app.request('/api/webdav/restore', { cookie, body: { ...selection, planDigest: preview.planDigest } });
    const body = await res.json();
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'stale_plan');
    assert.match(body.error, /重新预览/);

    // 什么都没写：收藏文件逐字节不变、没有恢复记录
    assert.deepEqual(fs.readFileSync(path.join(app.dir, 'favorites.json')), favoritesBefore);
    assert.deepEqual(readRestoreRecords(app.dir), []);
    assert.deepEqual(snapshotDirs(app.dir), [], '409 之前不落快照');
});

// ========== 3. 故障注入：某域写失败 → 逆序全回滚、版本不变、逐字节一致 ==========

test('真实 HTTP：故障注入（时间线写失败）→ 已应用域逆序全回滚，版本与文件逐字节不变', async t => {
    const { app, cookie, selection } = await backupOnce(t);
    const preview = await (await app.request('/api/webdav/restore/preview', { cookie, body: selection })).json();

    // 恢复前的现场（逐字节留证）
    const beforeFavorites = fs.readFileSync(path.join(app.dir, 'favorites.json'));
    const beforeModules = fs.readFileSync(path.join(app.dir, '.modules.json'));
    const db = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    let beforeMemos;
    let beforeTodos;
    let beforeSources;
    try {
        beforeMemos = db.prepare('SELECT * FROM memos ORDER BY id').all();
        beforeTodos = db.prepare('SELECT * FROM todos ORDER BY id').all();
        beforeSources = db.prepare('SELECT * FROM timeline_sources ORDER BY id').all();
        // 故障注入：把时间线表拆掉 → importTimeline 在**应用阶段**抛错（不是取回阶段）。
        // 此时 memos / todos / favorites / modules 四个域已经写完了，正好验证「逆序全回滚」。
        db.exec('DROP TABLE timeline_event_state; DROP TABLE timeline_events;');
    } finally {
        db.close();
    }

    const res = await app.request('/api/webdav/restore', { cookie, body: { ...selection, planDigest: preview.planDigest } });
    const body = await res.json();
    assert.equal(res.status, 500, JSON.stringify(body));
    assert.equal(body.code, 'restore_rolled_back');
    assert.deepEqual(body.rolledBack, ['modules', 'favorites', 'todos', 'memos'], '按应用顺序的逆序回滚');

    // 文件逐字节一致（含 `_sync.revision` 与回执）
    assert.deepEqual(fs.readFileSync(path.join(app.dir, 'favorites.json')), beforeFavorites, 'favorites.json 逐字节不变');
    assert.deepEqual(fs.readFileSync(path.join(app.dir, '.modules.json')), beforeModules, '.modules.json 逐字节不变');

    const after = readRestoreRecords(app.dir);
    assert.equal(after.length, 1);
    assert.equal(after[0].phase, 'rolled_back');
    assert.equal(after[0].generation, 0, '失败绝不递增代次');
    assert.match(after[0].failure, /恢复失败|失败/);
    assert.deepEqual(snapshotDirs(app.dir), [], '回滚成功后快照被删除');

    // 库里的行也回到原样
    const db2 = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    try {
        assert.deepEqual(db2.prepare('SELECT * FROM memos ORDER BY id').all(), beforeMemos);
        assert.deepEqual(db2.prepare('SELECT * FROM todos ORDER BY id').all(), beforeTodos);
        assert.deepEqual(db2.prepare('SELECT * FROM timeline_sources ORDER BY id').all(), beforeSources);
    } finally {
        db2.close();
    }
    // 版本没动：再预览一次，before 与刚才那次一致
    const again = await (await app.request('/api/webdav/restore/preview', { cookie, body: selection })).json();
    assert.equal(again.plan.versions.before.modules, preview.plan.versions.before.modules);
    assert.equal(again.plan.versions.before.favorites, preview.plan.versions.before.favorites);
});

// ========== 4. 恢复期间的并发写 → 503 busy ==========

test('真实 HTTP：恢复进行中，另一个标签页的保存被 503 busy 拒掉，且没有落地', async t => {
    const { app, cookie, dav, selection } = await backupOnce(t);
    // 撑开窗口：每个远端 GET 延迟 120ms（恢复要取清单 + 四个域）
    dav.stub.delayMs = 120;

    const restorePromise = app.request('/api/webdav/restore', { cookie, body: selection });
    const statuses = [];
    const deadline = Date.now() + 8000;
    let finished = false;
    restorePromise.then(() => { finished = true; }, () => { finished = true; });
    // 抢在恢复持锁期间反复尝试写
    while (!finished && Date.now() < deadline) {
        const attempt = await app.request('/api/favorites', {
            cookie,
            body: {
                favorites: [{
                    id: `concurrent-${statuses.length}`, title: `CONCURRENT-${statuses.length}`,
                    url: 'https://concurrent.test/', category: '工作'
                }]
            }
        });
        statuses.push({ status: attempt.status, retryAfter: attempt.headers.get('retry-after'), body: await attempt.json() });
        if (statuses.some(item => item.status === 503)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const restoreRes = await restorePromise;
    const restored = await restoreRes.json();
    assert.equal(restoreRes.status, 200, JSON.stringify(restored));

    const busy = statuses.filter(item => item.status === 503);
    assert.ok(busy.length >= 1, `至少一次写被锁拒掉（实际状态：${statuses.map(item => item.status).join(',')}）`);
    assert.equal(busy[0].body.code, 'busy');
    assert.ok(busy[0].retryAfter, '带 Retry-After');
    assert.match(busy[0].body.error, /正在恢复备份/);

    // 被拒的那次写没有落地：收藏是备份那一份（不含 CONCURRENT-*）
    const favorites = readJsonFile(app.dir, 'favorites.json');
    assert.ok(!favorites.favorites.some(item => String(item.title).startsWith('CONCURRENT-')));
    assert.ok(favorites.favorites.some(item => item.title === FAV_MARKER));
});

// ========== 5. 旧备份只恢复书签 ==========

test('真实 HTTP：旧备份（nav-sylph-backup）只恢复书签，导航/引擎/模板一字未动', async t => {
    const { app, cookie, dav } = await backupOnce(t);
    const configBefore = fs.readFileSync(path.join(app.dir, 'config.json'));

    const db0 = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    let navBefore;
    try {
        navBefore = {
            admin: db0.prepare("SELECT * FROM navigation_documents WHERE id = 'admin'").get(),
            draft: db0.prepare("SELECT * FROM navigation_documents WHERE id = 'draft'").get(),
            published: db0.prepare("SELECT * FROM navigation_documents WHERE id = 'published'").get()
        };
    } finally {
        db0.close();
    }

    // 造一份**旧格式**备份（type: nav-sylph-backup，带 config 与 favorites）
    const legacyData = {
        config: { theme: 'light', searchEngine: 'legacy-engine', categories: [{ id: 'cx', name: '旧分类', bookmarks: [] }] },
        favorites: {
            version: 1,
            favorites: [{ id: 'legacy-fav', title: 'LEGACY-13 旧备份里的书签', url: 'https://legacy.test/', category: '旧分类' }]
        }
    };
    const legacyName = 'nav-sylph-backup-20200101-000000.json';
    dav.files.set(`/backups/${legacyName}`, JSON.stringify({
        type: 'nav-sylph-backup',
        version: 1,
        createdAt: '2020-01-01T00:00:00.000Z',
        appVersion: '1.0.0',
        data: legacyData,
        checksum: calculateChecksum(legacyData)
    }));

    const selection = { legacyFile: legacyName };
    const preview = await (await app.request('/api/webdav/restore/preview', { cookie, body: selection })).json();
    assert.equal(preview.legacy, true);
    // 导航与模板都在 skip 里（界面据此提示「只恢复书签」）
    const skippedDomains = preview.plan.domains.filter(entry => entry.action === 'skip').map(entry => entry.domain);
    assert.ok(skippedDomains.includes('admin-navigation'));
    const restoreDomains = preview.plan.domains.filter(entry => entry.action === 'restore').map(entry => entry.domain);
    assert.deepEqual(restoreDomains, ['favorites'], '旧备份只恢复书签');

    const res = await app.request('/api/webdav/restore', { cookie, body: { ...selection, planDigest: preview.planDigest } });
    const restored = await res.json();
    assert.equal(res.status, 200, JSON.stringify(restored));
    assert.equal(restored.restoredBookmarks, true);
    assert.equal(restored.restoredMemos, false);
    assert.equal(restored.restoredModules, false);
    assert.equal(restored.restoredTimeline, false);
    assert.ok(restored.skipped.some(item => item.domain === 'admin-navigation' && item.reason));

    // 书签回来了
    const favorites = readJsonFile(app.dir, 'favorites.json');
    assert.deepEqual(favorites.favorites.map(item => item.title), ['LEGACY-13 旧备份里的书签']);

    // 导航 / 引擎 / 模板：一字未动
    assert.deepEqual(fs.readFileSync(path.join(app.dir, 'config.json')), configBefore);
    const db1 = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    try {
        assert.deepEqual(db1.prepare("SELECT * FROM navigation_documents WHERE id = 'admin'").get(), navBefore.admin);
        assert.deepEqual(db1.prepare("SELECT * FROM navigation_documents WHERE id = 'draft'").get(), navBefore.draft);
        assert.deepEqual(db1.prepare("SELECT * FROM navigation_documents WHERE id = 'published'").get(), navBefore.published);
    } finally {
        db1.close();
    }
});

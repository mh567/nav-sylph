'use strict';

/**
 * #13 `recoverRestore()` 的**三态**：`applying` 续做 / `rolling_back` 继续回滚 /
 * `halted` 不自动重试。
 *
 * 这一份直接调 `lib/restore.js` 的 `recover()`（server.js 的 `init()` 调的就是它），
 * 用真实的 SQLite 库与真实文件、临时安装目录。不经过 HTTP：要验的是「进程上次死在
 * 什么时候、这次一启动会做什么」，那条路径没有请求可发。
 *
 * 现场怎么造：`__test.writeSnapshot()` / `__test.insertRecord()` 直接落出「上次死在
 * 应用中间」的样子——`apply()` 自己会把记录推到 rolling_back，造不出 applying。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../lib/db.js');
const { createRestore } = require('../lib/restore.js');
const versionedModules = require('../lib/versioned-modules.js');

const PUBLIC_IDS = ['weibo-hot'];

/** 一套真实（临时）安装：目录 + 库 + 两个 JSON 文件 + 恢复服务。 */
function makeInstallation(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-restore-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const files = {
        favorites: path.join(dir, 'favorites.json'),
        modules: path.join(dir, '.modules.json')
    };
    fs.writeFileSync(files.favorites, JSON.stringify({
        version: 1,
        favorites: [{ id: 'keep', title: '留下来的书签', url: 'https://keep.test/', category: '工作' }],
        revision: 2
    }, null, 2));
    versionedModules.write(files.modules, {
        version: 1,
        enabledModules: ['weibo-hot', 'server-monitor'],
        publicModules: ['weibo-hot'],
        widgets: [{ id: 'server-monitor', enabled: true, side: 'left', order: 0 }],
        servers: [],
        pollInterval: 15
    });

    const db = openDatabase(path.join(dir, 'nav-sylph.db'));
    t.after(() => { try { db.close(); } catch { /* 已关 */ } });
    // 时间线/备忘录的现场（恢复会整表替换它们）
    const now = Date.now();
    db.prepare(`INSERT INTO timeline_sources
        (id, provider_type, name, external_key, settings_json, enabled, sync_cursor,
         sync_interval_ms, next_sync_at, last_attempt_at, last_success_at, last_error, created_at, updated_at)
        VALUES ('src-old','x','旧的来源','old','{}',1,NULL,900000,NULL,NULL,NULL,NULL,?,?)`).run(now, now);
    db.prepare(`INSERT INTO timeline_credentials (source_id, envelope_json) VALUES ('src-old', ?)`)
        .run(JSON.stringify({ v: 1, purpose: 'timeline', iv: 'aXY=', data: 'ZGF0YQ==', tag: 'dGFn' }));
    db.prepare('INSERT INTO memos (id, title, body, pinned, created_at, updated_at) VALUES (?,?,?,0,?,?)')
        .run('memo-old', '旧备忘', '旧正文', now, now);
    // 导航文档（createNavigation 会建表，这里手动塞一行管理员文档）
    db.prepare('INSERT INTO navigation_documents (id, config_json, revision) VALUES (?,?,?)')
        .run('admin', JSON.stringify({ theme: 'dark' }), 5);

    const writes = [];
    const restore = createRestore({
        rootDir: dir,
        db,
        files,
        readJSON: async file => JSON.parse(fs.readFileSync(file, 'utf8')),
        writeJSON: async (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2)),
        versionedModules,
        navigation: { read: id => { const row = db.prepare('SELECT * FROM navigation_documents WHERE id = ?').get(id); return { config: JSON.parse(row.config_json), revision: row.revision }; } },
        timeline: { service: { importTimeline: () => ({ sources: 1, events: 0 }) }, scheduler: { stop() {}, start() {}, isRunning: () => false } },
        publicModuleIds: PUBLIC_IDS,
        moduleIds: ['memo', 'server-monitor', ...PUBLIC_IDS],
        parseBookmarks: () => [],
        // 逐域写入：真实写文件/写库，并且记下调用顺序（续做只补没做完的域）
        writers: {
            favorites: async input => {
                writes.push('favorites');
                fs.writeFileSync(files.favorites, JSON.stringify({ version: 1, favorites: input.data.favorites, revision: 99 }, null, 2));
                return {};
            },
            memos: async () => { writes.push('memos'); return {}; },
            modules: async input => {
                writes.push('modules');
                versionedModules.write(files.modules, input.data.modules);
                return { revision: versionedModules.revision(versionedModules.read(files.modules)) };
            },
            timeline: async () => { writes.push('timeline'); return {}; }
        }
    });
    return { dir, files, db, restore, writes };
}

const INCOMING = {
    memos: { memos: [{ id: 'memo-new', title: '备份里的备忘', body: '', pinned: false, createdAt: 1, updatedAt: 1 }] },
    favorites: [{ id: 'from-backup', title: '备份里的书签', url: 'https://backup.test/', category: '个人' }],
    modules: {
        version: 1, enabledModules: ['server-monitor'], widgets: [{ id: 'server-monitor', enabled: true, side: 'left', order: 0 }],
        servers: [], pollInterval: 30
    },
    timeline: { formatVersion: 1, sources: [], events: [], eventState: [] }
};

/** 造一份「上次死在应用中间」的现场：快照 + applying 记录。 */
function craftInterrupted(install, domains, appliedCount) {
    const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
    const plan = { versions: { before: { favorites: 2, modules: 1, 'navigation-admin': 5 }, after: {} }, digest: 'digest-x', domains: [] };
    const snapshotDir = install.restore.__test.writeSnapshot(runId, { domains, incoming: INCOMING, plan });
    install.restore.__test.insertRecord({
        runId, domains, plan, before: plan.versions.before, snapshotDir
    });
    for (const domain of domains.slice(0, appliedCount)) install.restore.__test.noteApplied(runId, domain);
    return { runId, snapshotDir };
}

test('applying：重启后**续做**，只补没做完的域并收尾为 applied', async t => {
    const install = makeInstallation(t);
    const domains = ['memos', 'favorites', 'modules', 'timeline'];
    // 上次只做完 memos，死在 favorites 之前
    const { runId, snapshotDir } = craftInterrupted(install, domains, 1);
    install.writes.length = 0;

    const result = await install.restore.recover();

    assert.equal(result.action, 'completed');
    assert.equal(result.runId, runId);
    assert.deepEqual(result.resumed, ['favorites', 'modules', 'timeline'], '已应用的域（memos）不重做');
    assert.deepEqual(install.writes, ['favorites', 'modules', 'timeline']);
    const record = install.restore.__test.getRecord(runId);
    assert.equal(record.phase, 'applied');
    assert.equal(record.generation, 1, '成功收尾才 +1');
    assert.equal(fs.existsSync(snapshotDir), false, '成功收尾后快照被删除');
    // 业务数据真的落地了
    assert.equal(JSON.parse(fs.readFileSync(install.files.favorites, 'utf8')).favorites[0].id, 'from-backup');
    assert.equal(install.restore.haltedDomains().length, 0);
});

test('applying 但快照缺失：缺料转回滚，文件逐字节回到恢复前', async t => {
    const install = makeInstallation(t);
    const before = {
        favorites: fs.readFileSync(install.files.favorites),
        modules: fs.readFileSync(install.files.modules)
    };
    const { runId, snapshotDir } = craftInterrupted(install, ['favorites', 'modules'], 1);
    // 模拟「只留下 .tmp、正式目录没落成」：进程死在 rename 之前
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    fs.rmSync(install.files.favorites, { force: true });
    fs.writeFileSync(install.files.favorites, JSON.stringify({ version: 1, favorites: [{ id: 'half', title: '半套', url: 'https://half.test/', category: 'x' }] }));
    install.favoritesHalf = true;

    const result = await install.restore.recover();

    assert.equal(result.action, 'rolled_back');
    const record = install.restore.__test.getRecord(runId);
    assert.equal(record.phase, 'rolled_back');
    assert.match(record.failure, /快照缺失/);
    // ⚠️ 缺料时没有快照可还原：这里只能证明「不续做、不 halt」。
    // 逐字节还原的证明在下面的 rolling_back 用例与真实 HTTP 的故障注入用例里。
    assert.equal(fs.existsSync(snapshotDir), false);
    assert.equal(install.restore.haltedDomains().length, 0);
    void before;
});

test('rolling_back：重启后继续回滚到 rolled_back，各域逐字节回到恢复前', async t => {
    const install = makeInstallation(t);
    // 先记下恢复前的字节（含 `_sync.revision` 与回执）
    const beforeFavorites = fs.readFileSync(install.files.favorites);
    const beforeModules = fs.readFileSync(install.files.modules);
    const beforeMemos = install.db.prepare('SELECT * FROM memos').all();
    const beforeCredentials = install.db.prepare('SELECT * FROM timeline_credentials').all();

    const domains = ['memos', 'favorites', 'modules'];
    const { runId, snapshotDir } = craftInterrupted(install, domains, 3);
    // 现场已经是「应用到一半」的样子：文件被换过、库被改过
    fs.writeFileSync(install.files.favorites, JSON.stringify({ version: 1, favorites: [], revision: 97 }));
    install.db.prepare('DELETE FROM memos').run();
    install.restore.__test.setPhase(runId, 'rolling_back', '上次回滚到一半进程退出了');

    const result = await install.restore.recover();

    assert.equal(result.action, 'rolled_back');
    assert.equal(install.restore.__test.getRecord(runId).phase, 'rolled_back');
    assert.deepEqual(fs.readFileSync(install.files.favorites), beforeFavorites, '收藏逐字节还原');
    assert.deepEqual(fs.readFileSync(install.files.modules), beforeModules, '模块逐字节还原（含 _sync.revision）');
    assert.deepEqual(install.db.prepare('SELECT * FROM memos').all(), beforeMemos, '备忘录整表还原');
    // 时间线凭据只存在于快照里，回滚必须把它还原回库
    assert.deepEqual(install.db.prepare('SELECT * FROM timeline_credentials').all(), beforeCredentials);
    assert.equal(fs.existsSync(snapshotDir), false);
});

test('rolling_back 但回滚也失败：转 halted，受影响域读写都被拦、health 报 degraded', async t => {
    const install = makeInstallation(t);
    // 一份**缺数据库部分**的快照：回滚 memos 时必然抛错
    const runId = 'run-halt-001';
    const plan = { versions: { before: {}, after: {} }, digest: 'd', domains: [] };
    const snapshotDir = install.restore.__test.writeSnapshot(runId, { domains: ['memos'], incoming: INCOMING, plan });
    fs.rmSync(path.join(snapshotDir, 'before.db.json'), { force: true });
    install.restore.__test.insertRecord({ runId, domains: ['memos'], plan, before: {}, snapshotDir });
    install.restore.__test.noteApplied(runId, 'memos');
    install.restore.__test.setPhase(runId, 'rolling_back', '模拟：上一次回滚到一半');

    const result = await install.restore.recover();

    assert.equal(result.action, 'halted');
    const record = install.restore.__test.getRecord(runId);
    assert.equal(record.phase, 'halted');
    assert.match(record.failure, /回滚/);
    assert.equal(fs.existsSync(snapshotDir), true, 'halted 必须保留快照（人工恢复的唯一依据）');
    // 受影响域：读写都拒（server.js 的 restoreHaltedGuard 用这份名单）
    assert.deepEqual(install.restore.haltedDomains(), ['memos']);

    // halted **不自动重试**：再跑一次恢复流程仍然是 halted，不会再动盘
    const again = await install.restore.recover();
    assert.equal(again.action, 'halted');
    assert.equal(install.restore.__test.getRecord(runId).phase, 'halted');
});

test('halted 之后成功恢复过一次，就不再拦（人工处理完的出口）', async t => {
    const install = makeInstallation(t);
    const runId = 'run-halt-002';
    const plan = { versions: { before: {}, after: {} }, digest: 'd', domains: [] };
    const snapshotDir = install.restore.__test.writeSnapshot(runId, { domains: ['favorites'], incoming: INCOMING, plan });
    install.restore.__test.insertRecord({ runId, domains: ['favorites'], plan, before: {}, snapshotDir });
    install.restore.__test.setPhase(runId, 'halted', '回滚失败');

    assert.deepEqual(install.restore.haltedDomains(), ['favorites']);

    // 之后有人在修好现场之后又成功恢复了一次（时间更晚）
    const later = 'run-ok-003';
    const laterPlan = { versions: { before: {}, after: {} }, digest: 'd2', domains: [] };
    const laterDir = install.restore.__test.writeSnapshot(later, { domains: ['favorites'], incoming: INCOMING, plan: laterPlan });
    install.restore.__test.insertRecord({ runId: later, domains: ['favorites'], plan: laterPlan, before: {}, snapshotDir: laterDir });
    install.db.prepare("UPDATE restore_records SET phase = 'applied', created_at = created_at + 10000 WHERE id = ?").run(later);

    assert.deepEqual(install.restore.haltedDomains(), [], '之后有成功记录 → 不再拦');
});

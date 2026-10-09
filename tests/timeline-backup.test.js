'use strict';

/**
 * 时间线的 WebDAV 备份与恢复。
 *
 * 两个必须钉住的性质：
 *  1. **凭据不进备份**——密钥派生自管理员密码哈希，跨安装解不开，
 *     导出它只是把一个解不开的秘密多放一份在远端；恢复后来源标为「待授权」。
 *  2. **破坏性往返**——备份 → 清库 → 恢复，事件与用户状态都要回位，
 *     且没有时间线文件的旧备份仍然可恢复（向后兼容）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { openDatabase } = require(path.join(ROOT, 'lib', 'db.js'));
const { createService } = require(path.join(ROOT, 'lib', 'timeline', 'service.js'));
const { createRepository } = require(path.join(ROOT, 'lib', 'timeline', 'repository.js'));
const { WebDAVBackup } = require(path.join(ROOT, 'lib', 'webdav-backup.js'));
const { encrypt } = require(path.join(ROOT, 'lib', 'credentials.js'));

const HASH = '$2b$10$hashforbackuptest';

function tempDb() {
    const dir = fs.mkdtempSync(path.join(process.env.COMMANDCODE_SCRATCHPAD || os.tmpdir(), 'sylph-timeline-backup-'));
    return { dir, file: path.join(dir, 'timeline.db') };
}

/** 记录写入的假 WebDAV 客户端（不联网、不落盘）。 */
function recordingClient(files) {
    return {
        getDirectoryContents: async () => [...files.keys()].map(name => ({
            type: 'file',
            basename: path.posix.basename(name),
            filename: name,
            size: files.get(name).length,
            lastmod: '2026-10-08T00:00:00Z'
        })),
        putFileContents: async (name, content) => { files.set(name, content); },
        getFileContents: async name => {
            if (!files.has(name)) throw new Error('not found: ' + name);
            return files.get(name);
        },
        createDirectory: async () => {},
        deleteFile: async name => { files.delete(name); }
    };
}

function offlineBackup(config, client) {
    const b = new WebDAVBackup('/unused', 'unused');
    b.config = config;
    b.createClient = () => client;
    b.saveConfig = async data => { b.config = { ...b.config, ...data }; };
    return b;
}

/** 一个带来源、事件、用户状态与凭据的时间线。 */
async function seedService(db) {
    const repo = createRepository(db);
    repo.ensureManualSource();
    const service = createService(repo, { getPasswordHash: async () => HASH, fetchMeta: async () => ({}) });
    const src = repo.createSource({
        providerType: 'x', name: 'X · alice', externalKey: 'alice',
        settings: {}, syncIntervalMs: 900000, nextSyncAt: 0
    });
    repo.setCredentials(src.id, encrypt(JSON.stringify({ token: 'provider-secret' }), HASH, 'timeline'));
    repo.insertEvents(src.id, [
        {
            providerEventId: 'p1', eventType: 'social_post', dedupeKey: 'p1',
            occurredAt: 5000, author: '@alice', title: '一条推文', summary: '正文',
            url: 'https://x.com/alice/status/p1', metadata: { quote: '引用' }
        }
    ], Date.now());
    const ev = repo.listEvents({}).rows[0];
    repo.setFavorite(ev.id, true, Date.now());
    repo.setArchive(ev.id, true, Date.now());
    await service.saveArticle({ url: 'https://example.com/saved', title: '保存的文章' });
    return { repo, service, sourceId: src.id };
}

// ========== 导出内容 ==========

test('老备份（状态行只有 read_at、没有 favorited_at）也能导入：归档保留、收藏补 NULL', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const { service, repo } = await seedService(db);
        const dump = repo.exportAll();
        // v1.15.6 之前导出的形状：状态行是 (event_id, read_at, archived_at)
        const legacy = {
            formatVersion: 1,
            sources: dump.sources,
            events: dump.events,
            eventState: [{ event_id: dump.events[0].id, read_at: 12345, archived_at: 67890 }]
        };
        assert.ok(!('favorited_at' in legacy.eventState[0]), '老形状里确实没有 favorited_at');
        // ⚠️ better-sqlite3 对**缺**命名参数会抛 "Missing named parameter"，
        // 所以 importAll 必须自己补齐缺失的键——否则升级前的备份再也恢复不进来。
        assert.doesNotThrow(() => service.importTimeline(legacy), '导入不得因缺命名参数抛错');
        const archived = repo.listEvents({ view: 'archived' }).rows;
        assert.equal(archived.length, 1, '归档状态照原样回来');
        assert.equal(archived[0].archivedAt, 67890, '归档时刻原样保留');
        assert.equal(archived[0].favoritedAt, null, '收藏补齐为 NULL（老备份里没有这个概念）');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('备份文件是版本化时间线类型，且**不含凭据**（明文与密文都不含）', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const { service } = await seedService(db);
        const dump = service.exportTimeline();
        const text = JSON.stringify(dump);

        assert.ok(!text.includes('provider-secret'), '明文 token 不进导出');
        assert.ok(!text.includes('envelope'), '密文信封也不进导出');
        assert.ok(!text.includes(HASH), '密码哈希更不该出现');
        assert.deepEqual(dump.sources.map(s => Object.keys(s)).flat().filter(k => k === 'token'), [],
            '来源行里没有 token 字段');

        const files = new Map();
        const backup = offlineBackup({ remotePath: '/backups/' }, recordingClient(files));
        const result = await backup.createBackup(
            { theme: 'dark' }, { favorites: [] }, '1.1.0', null, null, { timelineData: dump });

        assert.match(result.timelineFilename, /^nav-sylph-timeline-\d{8}-\d{6}\.json$/);
        const stored = JSON.parse(files.get('/backups/' + result.timelineFilename));
        assert.equal(stored.type, 'nav-sylph-timeline', '有独立类型，恢复时据此校验');
        assert.equal(stored.version, 1);
        assert.ok(!JSON.stringify(stored).includes('provider-secret'));
        assert.equal(stored.checksum.length, 64, '带校验和');
        assert.equal(stored.data.events.length, dump.events.length);
        assert.equal(stored.data.eventState.length, dump.eventState.length, '用户状态（归档/收藏）也在');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('没有时间线内容时不生成该文件；有内容时独立参与「有无变化」判定', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const { service } = await seedService(db);
        const files = new Map();
        const backup = offlineBackup({ remotePath: '/backups/' }, recordingClient(files));

        // 1) 首次：有内容 -> 上传
        const dump = service.exportTimeline();
        const first = await backup.createBackup(
            { theme: 'dark' }, { favorites: [] }, '1.1.0', null, null, { timelineData: dump });
        assert.ok(first.timelineFilename, '有内容就上传');

        // 2) 同样的内容 -> noChanges（不重复上传）
        const repeat = await backup.createBackup(
            { theme: 'dark' }, { favorites: [] }, '1.1.0', null, null, { timelineData: dump });
        assert.equal(repeat.noChanges, true, '内容没变就不重复上传');

        // 3) 时间线变了 -> 必须重新上传（没有这一条，新事件永远不会进备份）
        const changed = { ...dump, events: dump.events.slice(0, dump.events.length - 1) };
        const again = await backup.createBackup(
            { theme: 'dark' }, { favorites: [] }, '1.1.0', null, null, { timelineData: changed });
        assert.equal(again.noChanges, undefined, '时间线变了就不是 noChanges');

        // 4) 完全没有时间线内容 -> 不生成文件（不为空模块在远端留垃圾）
        const none = await backup.createBackup(
            { theme: 'dark' }, { favorites: [] }, '1.1.0', null, null, { timelineData: null });
        assert.equal(none.timelineFilename, null);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ========== 列表 / 轮换 ==========

test('listBackups 把时间线文件与同组配置归在一起，自动槽位单独成组', async () => {
    const files = new Map();
    const client = recordingClient(files);
    const backup = offlineBackup({ remotePath: '/backups/' }, client);
    await backup.createBackup({ theme: 'dark' }, { favorites: [] }, '1.1.0', null, null,
        { timelineData: { formatVersion: 1, sources: [], events: [{ id: 'e' }], eventState: [] } });

    const listed = await backup.listBackups();
    assert.equal(listed.backups.length, 1);
    assert.ok(listed.backups[0].timelineFile, '同组里带上了时间线文件');
    assert.ok(listed.backups[0].configFile, '配置文件也在同一组');

    // 自动槽位：固定文件名、单独一组且排最前
    const autoBackup = offlineBackup({ remotePath: '/backups/' }, client);
    await autoBackup.createBackup({ theme: 'light' }, { favorites: [] }, '1.1.0', null, null,
        { auto: true, timelineData: { formatVersion: 1, sources: [], events: [{ id: 'e2' }], eventState: [] } });
    const listed2 = await autoBackup.listBackups();
    assert.equal(listed2.backups[0].isAuto, true, '自动槽位排最前');
    assert.equal(listed2.backups[0].timelineFile, 'nav-sylph-timeline-auto.json');
});

test('清理旧备份时时间线文件随组删除，自动槽位不参与轮换', async () => {
    const files = new Map();
    const client = recordingClient(files);
    const backup = offlineBackup({ remotePath: '/backups/' }, client);
    for (let i = 1; i <= 7; i++) {
        files.set(`/backups/nav-sylph-config-2026010${i}-010101.json`, JSON.stringify({ type: 'nav-sylph-config', data: { i } }));
        files.set(`/backups/nav-sylph-timeline-2026010${i}-010101.json`, JSON.stringify({ type: 'nav-sylph-timeline', data: { i } }));
        files.set(`/backups/nav-sylph-bookmarks-2026010${i}-010101.html`, '<html></html>');
    }
    files.set('/backups/nav-sylph-timeline-auto.json', JSON.stringify({ type: 'nav-sylph-timeline', data: {} }));

    const result = await backup.cleanupOldBackups(5);
    assert.equal(result.backupsRemoved, 2, '只从手动组里删两组');
    // 自动槽位是「最新一份」而不是历史还原点：它必须活下来。它永远排在最前，
    // 不排除在计数之外的话，反而会最先被当成最旧一组删掉。
    assert.ok(files.has('/backups/nav-sylph-timeline-auto.json'), '自动槽位不参与轮换');
    // 被删掉的那两组，三个文件都要走——孤儿文件会长期堆在 WebDAV 上
    assert.ok(!files.has('/backups/nav-sylph-timeline-20260101-010101.json'), '最旧一组的时间线文件也删了');
    assert.ok(!files.has('/backups/nav-sylph-timeline-20260102-010101.json'), '第二旧的一组同样');
    assert.ok(!files.has('/backups/nav-sylph-config-20260101-010101.json'), '同组的配置一起删');
    assert.ok(files.has('/backups/nav-sylph-timeline-20260103-010101.json'), '保留窗口内的一组不动');
    assert.ok(files.has('/backups/nav-sylph-timeline-20260107-010101.json'), '最新的保留');
});

test('删掉自动槽位的时间线文件会同时清掉那一组校验和（否则它再也不会被重建）', async () => {
    const files = new Map();
    const client = recordingClient(files);
    const backup = offlineBackup({ remotePath: '/backups/' }, client);
    await backup.createBackup({ theme: 'dark' }, { favorites: [] }, '1.1.0', null, null,
        { auto: true, timelineData: { formatVersion: 1, sources: [], events: [{ id: 'e' }], eventState: [] } });
    assert.ok(backup.config.lastAutoTimelineChecksum, '自动槽位的校验和已记录');

    await backup.deleteBackup('nav-sylph-timeline-auto.json');
    assert.equal(backup.config.lastAutoTimelineChecksum, undefined,
        '校验和要消失（赋 undefined），下一次比较才会不相等、才会重建');

    const again = await backup.createBackup({ theme: 'dark' }, { favorites: [] }, '1.1.0', null, null,
        { auto: true, timelineData: { formatVersion: 1, sources: [], events: [{ id: 'e' }], eventState: [] } });
    assert.equal(again.noChanges, undefined, '删掉之后必须能重新生成');
    assert.ok(files.has('/backups/nav-sylph-timeline-auto.json'));
});

// ========== 破坏性往返 ==========

test('破坏性往返：备份 → 清库 → 恢复，事件与用户状态回位、凭据为空', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const { service } = await seedService(db);
        const before = service.listTimeline({});
        const archivedBefore = service.listTimeline({ view: 'archived' }).events.length;
        const sourcesBefore = service.listSources().filter(s => s.providerType !== 'manual').length;
        // 默认视图不含已归档：种子里那条社交事件被归档了，所以这里只剩手动文章
        assert.equal(before.events.length, 1, '默认视图里是手动保存的那篇文章');
        assert.equal(archivedBefore, 1, '那条社交事件在归档视图里');
        assert.equal(sourcesBefore, 1);

        const files = new Map();
        const backup = offlineBackup({ remotePath: '/backups/' }, recordingClient(files));
        const result = await backup.createBackup(
            { theme: 'dark' }, { favorites: [] }, '1.1.0', null, null,
            { timelineData: service.exportTimeline() });

        // 清库（模拟换机器/数据丢失）
        service.importTimeline({ formatVersion: 1, sources: [], events: [], eventState: [] });
        assert.equal(service.listTimeline({}).events.length, 0, '清干净了');
        assert.equal(service.listSources().filter(s => s.providerType !== 'manual').length, 0);

        // 恢复
        const restored = await backup.restoreBackup({ timelineFile: result.timelineFilename });
        assert.ok(restored.data.timeline, '拿到了时间线数据');
        service.importTimeline(restored.data.timeline);

        const after = service.listTimeline({});
        assert.equal(after.events.length, before.events.length, '事件条数回位');
        assert.equal(service.listTimeline({ view: 'archived' }).events.length, archivedBefore,
            '用户状态（归档）也回位');
        // v6 起「已读」换成「收藏」：同一条既收藏又归档的事件只在「已归档」里可见，
        // 顺带证明状态行的 favorited_at 也过了备份往返。
        assert.equal(service.listTimeline({ view: 'archived' }).events[0].favorited, true,
            '收藏状态回位（同时归档的那条只出现在「已归档」，星标仍然亮着）');
        assert.equal(service.listTimeline({ view: 'favorited' }).events.length, 0,
            '既收藏又归档的不出现在「收藏」视图里');
        assert.equal(service.listSources().filter(s => s.providerType !== 'manual').length, sourcesBefore,
            '来源回位');
        assert.equal(service.listSources().filter(s => s.hasCredentials).length, 0,
            '凭据不随备份——恢复后来源是「待授权」，由用户重新填 token');
        assert.equal(service.getSourceView(service.listSources().find(s => s.providerType === 'x').id).status,
            'ok', 'X 恢复后无需凭据即可工作');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('前端恢复流程把时间线文件带上：列表项 → 选项 → 请求体 → 删除', () => {
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const src = appSource
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

    assert.match(src, /data-timeline="\$\{this\.esc\(b\.timelineFile \|\| ''\)\}"/,
        '备份列表项上挂着 timelineFile');
    assert.match(src, /const timelineFile = item\.dataset\.timeline;/, '恢复对话框读得到它');
    assert.match(src, /timelineFile: backup\.timelineFile,/, '恢复请求体带上它');
    assert.match(src, /const restoreTimeline = restoreType === 'all' \|\| restoreType === 'timeline';/,
        '恢复选项映射（全量与单恢复时间线）');
    assert.match(src, /\[configFile, bookmarksFile, modulesFile, timelineFile, legacyFile\]/,
        '删除整组时时间线文件一起删——否则远端留下半新半旧的分组');
    assert.match(src, /res\.timelineFilename\]/, '备份成功的提示里列出时间线文件');
});

test('恢复选项对话框：恰好一个单选框默认选中（否则点「确认恢复」无声失败）', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const src = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
    const header = 'showRestoreOptionsDialog(backup, parentDialog) {';
    const start = src.indexOf(header);
    assert.ok(start >= 0, '方法存在');
    let depth = 0;
    let end = -1;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const body = src.slice(start, end);
    assert.ok(body.length > 400, `方法体切出来了（${body.length}）`);

    /** 跑真实方法体，把生成的模板抓下来（html 是桩）。 */
    function templateFor(backup) {
        let captured = '';
        const stub = {
            mountLayer() {},
            closeLayer() {},
            confirmAction: async () => false,
            showToast() {}
        };
        const $stub = () => ({});                       // 只赋值 onclick，不读
        const htmlStub = tpl => { captured = tpl; return {}; };
        const fn = new Function('$', 'html', 'API', 'location', 'backup',
            `return ({ ${body} }).showRestoreOptionsDialog.call(this, backup, null);`);
        fn.call(stub, $stub, htmlStub, { post: async () => ({ success: true }) },
            { reload() {} }, backup);
        return captured;
    }

    const checkedValues = backup => {
        const radios = [...templateFor(backup).matchAll(/<input type="radio"[^>]*>/g)].map(m => m[0]);
        assert.ok(radios.length >= 1, '至少渲染出一个可选项');
        return radios.filter(r => /\schecked/.test(r))
            .map(r => (r.match(/value="([^"]+)"/) || [])[1]);
    };

    // 这就是那个缺陷的形状：判据写成「四项全无」时，这两个分组里
    // **一个 radio 都不会被选中**，`$(':checked').value` 于是抛在 handler 里。
    assert.deepEqual(checkedValues({ timelineFile: 'nav-sylph-timeline-auto.json' }), ['timeline'],
        '只含时间线的分组默认选中「只恢复时间线」');
    assert.deepEqual(checkedValues({ modulesFile: 'nav-sylph-modules-auto.json' }), ['modules'],
        '只含模块的分组默认选中「只恢复模块设置」');
    assert.deepEqual(checkedValues({ configFile: 'c.json', modulesFile: 'm.json' }), ['config'],
        '配置+模块时选中配置那一项');
    assert.deepEqual(checkedValues({ configFile: 'c.json', bookmarksFile: 'b.html' }), ['all'],
        '配置+书签时选中「同时恢复」');
    assert.deepEqual(
        checkedValues({ configFile: 'c.json', bookmarksFile: 'b.html', modulesFile: 'm.json', timelineFile: 't.json' }),
        ['all'], '四者俱全时仍恰好一个选中');
    for (const backup of [{ timelineFile: 't' }, { modulesFile: 'm' }]) {
        assert.equal(checkedValues(backup).length, 1, '不多不少，恰好一个');
    }
});

test('校验和不对的时间线备份拒绝恢复；没有时间线文件的旧备份仍可恢复', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const { service } = await seedService(db);
        const files = new Map();
        const backup = offlineBackup({ remotePath: '/backups/' }, recordingClient(files));
        const result = await backup.createBackup(
            { theme: 'dark' }, { favorites: [] }, '1.1.0', null, null,
            { timelineData: service.exportTimeline() });

        // 篡改一个字段 -> 校验和必须失败（否则「恢复」会静默写进坏数据）
        const stored = JSON.parse(files.get('/backups/' + result.timelineFilename));
        stored.data.events[0].title = '被改过的标题';
        files.set('/backups/' + result.timelineFilename, JSON.stringify(stored));
        await assert.rejects(
            () => backup.restoreBackup({ timelineFile: result.timelineFilename }),
            /checksum/i, '校验和不符就拒绝');

        // 类型不对也拒绝
        files.set('/backups/nav-sylph-timeline-20260101-010101.json',
            JSON.stringify({ type: 'nav-sylph-config', data: {}, checksum: 'x' }));
        await assert.rejects(
            () => backup.restoreBackup({ timelineFile: 'nav-sylph-timeline-20260101-010101.json' }),
            /timeline backup file format/i);

        // 向后兼容：旧备份里没有时间线文件，恢复时不该报错
        const legacyFiles = new Map([['/backups/nav-sylph-config-20260101-010101.json',
            JSON.stringify({ type: 'nav-sylph-config', createdAt: 'x', appVersion: '1.0.0', data: { theme: 'dark' }, checksum: 'y' })]]);
        const legacy = offlineBackup({ remotePath: '/backups/' }, recordingClient(legacyFiles));
        const restored = await legacy.restoreBackup({ timelineFile: null, configFile: null });
        assert.equal(restored.data.timeline, undefined, '旧备份没有时间线数据，恢复流程照常走完');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('恢复保留周期启停和历史状态，X 可无凭据同步，微博仍待授权且重新授权不启用暂停来源', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const original = globalThis.fetch;
    try {
        const { repo, service, sourceId } = await seedService(db);
        repo.updateSource(sourceId, { enabled: false, syncIntervalMs: 1800000 });
        const weibo = repo.createSource({ providerType: 'weibo', name: 'weibo', externalKey: 'alice', syncIntervalMs: 300000 });
        const activeX = repo.createSource({ providerType: 'x', name: 'active', externalKey: 'alice', syncIntervalMs: 900000, nextSyncAt: 0 });
        const snapshot = service.exportTimeline();
        service.importTimeline(snapshot);
        assert.equal(repo.getSource(sourceId).enabled, false);
        assert.equal(repo.getSource(sourceId).syncIntervalMs, 1800000);
        assert.equal(service.getSourceView(sourceId).status, 'paused');
        assert.equal(service.getSourceView(activeX.id).status, 'ok');
        assert.equal(service.getSourceView(weibo.id).status, 'pending');
        assert.equal((await service.syncSource(weibo.id)).code, 'auth');
        let calls = 0;
        globalThis.fetch = async url => {
            calls++;
            if (String(url).includes('weibo')) return Response.json({ id: '123' });
            return Response.json({ code: 200, results: [], cursor: { top: null, bottom: null } });
        };
        assert.equal((await service.syncSource(sourceId)).skipped, true);
        assert.equal(calls, 0);
        assert.equal((await service.syncSource(sourceId, { force: true })).ok, true);
        assert.equal(repo.getSource(sourceId).enabled, false);
        assert.equal((await service.syncSource(activeX.id)).ok, true);
        const history = repo.listEvents({ view: 'archived' }).rows[0];
        assert.ok(history.favoritedAt && history.archivedAt,
            '用户状态（收藏 + 归档）在强制同步后仍然保留');
        await service.updateSource(weibo.id, { enabled: false });
        await service.updateSource(weibo.id, { token: 'fresh' });
        assert.equal(repo.getSource(weibo.id).enabled, false);
        assert.equal(repo.getSource(weibo.id).nextSyncAt, null);
    } finally {
        globalThis.fetch = original;
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

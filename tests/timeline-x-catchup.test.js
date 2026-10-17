'use strict';

/**
 * X 订阅的增量追赶回归。
 *
 * 用户报的是「订阅 elonmusk 最初能同步，某天起一直提示未能覆盖所有新动态」。
 * 根因：`fetchEvents()` 只有「全中」或抛错两种结果——翻满单轮页数预算就把本轮
 * 已取到的消息整批丢掉，而失败又不推进水位，于是每轮从同一位置重来，永久卡死。
 *
 * 这里全部**执行真实实现**：适配器走 `lib/timeline/adapters/x.js`（只把
 * `globalThis.fetch` 换成合成上游），编排与持久化走真实 service + 真实临时 SQLite。
 * 此前的 X 适配器没有任何测试，这个缺陷正是那样漏掉的。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { openDatabase } = require(path.join(ROOT, 'lib', 'db.js'));
const { createRepository } = require(path.join(ROOT, 'lib', 'timeline', 'repository.js'));
const { createService, __test } = require(path.join(ROOT, 'lib', 'timeline', 'service.js'));
const { encrypt } = require(path.join(ROOT, 'lib', 'credentials.js'));
const xAdapter = require(path.join(ROOT, 'lib', 'timeline', 'adapters', 'x.js'));
const { X_MAX_PAGES, SOCIAL_RETENTION_DAYS, X_CATCHUP_MAX_ROUNDS } =
    require(path.join(ROOT, 'lib', 'timeline', 'constants.js'));

const OLD_HASH = '$2b$10$oldhashforunitcatchup';
const EPOCH = 1288834974657n;

function tempDb() {
    const dir = fs.mkdtempSync(path.join(process.env.COMMANDCODE_SCRATCHPAD || os.tmpdir(), 'sylph-x-catchup-'));
    return { dir, file: path.join(dir, 'timeline.db') };
}

/** 由毫秒时间戳反推一个雪花 id（`x.js` 的 `idTime` 是其逆运算），保证时间与 id 单调一致。 */
function idFor(ms) {
    return String((BigInt(Math.floor(ms) - Number(EPOCH)) << 22n) | 1n);
}

function fxStatus(id) {
    return {
        type: 'status', id, text: `post ${id}`,
        created_timestamp: Math.floor(idTimeOf(id) / 1000),
        // normalize 会校验作者名与订阅账号一致；少了这个字段整页都会被判为无效。
        author: { screen_name: 'elonmusk' }
    };
}

function idTimeOf(id) {
    return Number((BigInt(id) >> 22n) + EPOCH);
}

/**
 * 合成上游：把 `ids`（由新到旧）按每页 `perPage` 条切页，用 `c0/c1/...` 当翻页游标。
 * `cursorFor(idx)` 可覆写以模拟「上游把同一个游标还回来」。
 */
function upstream(ids, { perPage = 20, cursorFor = null, onStatuses = null } = {}) {
    const pages = [];
    for (let i = 0; i < ids.length; i += perPage) pages.push(ids.slice(i, i + perPage));
    const calls = [];
    const fetchStub = async url => {
        const u = String(url);
        if (!u.includes('/statuses')) {
            // 资料端点：本轮不依赖它，给一个形状正确的响应即可。
            return Response.json({ code: 200, user: { screen_name: 'elonmusk', id: '1' } });
        }
        const m = /[?&]cursor=([^&]*)/.exec(u);
        const cursor = m ? decodeURIComponent(m[1]) : null;
        calls.push(cursor);
        if (onStatuses) onStatuses(cursor);
        const idx = cursor === null ? 0 : Number(String(cursor).slice(1)) + 1;
        const results = (pages[idx] || []).map(fxStatus);
        const bottom = cursorFor
            ? cursorFor(idx)
            : (idx >= pages.length - 1 ? null : `c${idx}`);
        return Response.json({ code: 200, results, cursor: { top: null, bottom } });
    };
    return { fetchStub, calls, pages };
}

function withFetch(stub) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    return () => { globalThis.fetch = original; };
}

/** 建一个真实的 X 来源；`syncCursor` 即「上次完整覆盖到的水位」。 */
function makeSource(repo, { syncCursor = null, settings = {} } = {}) {
    const src = repo.createSource({
        providerType: 'x', name: 'X · elonmusk', externalKey: 'elonmusk',
        settings, syncIntervalMs: 300000, nextSyncAt: 0
    });
    if (syncCursor !== null) repo.recordSuccess(src.id, { cursor: syncCursor, at: 1, nextSyncAt: 0 });
    return repo.getSource(src.id);
}

// ===================== 适配器：单轮预算与部分进度 =====================

test('首次接入（无水位）一页即完成，不因「没翻满」而报错', async () => {
    const now = Date.now();
    const ids = Array.from({ length: 12 }, (_, i) => idFor(now - i * 60000));
    const up = upstream(ids);
    const restore = withFetch(up.fetchStub);
    try {
        const r = await xAdapter.fetchEvents({ externalKey: 'elonmusk', cursor: null });
        assert.equal(r.covered, true, '无水位时缺口本来就到头了');
        assert.equal(r.resumeCursor, null);
        assert.equal(r.events.length, 12);
        assert.equal(r.nextCursor, ids[0], '水位取最高 id');
        assert.equal(up.calls.length, 1, '只打一页');
    } finally { restore(); }
});

test('积压超过单轮预算：返回部分进度 + 续接游标，**不抛错**（旧实现在这里丢掉全部消息）', async () => {
    const now = Date.now();
    const ids = Array.from({ length: 240 }, (_, i) => idFor(now - i * 60000));
    const up = upstream(ids);
    const restore = withFetch(up.fetchStub);
    try {
        const watermark = ids[199];
        const r = await xAdapter.fetchEvents({
            externalKey: 'elonmusk', cursor: watermark,
            windowStartMs: now - SOCIAL_RETENTION_DAYS * 86400000
        });
        assert.equal(r.covered, false, '没追到水位（还需要后续轮次）');
        assert.equal(r.events.length, X_MAX_PAGES * 20, '本轮已取到的消息必须交出来，不能丢');
        assert.equal(r.resumeCursor, `c${X_MAX_PAGES - 1}`, '留下续接游标');
        assert.equal(up.calls.length, X_MAX_PAGES, '单轮请求量仍有界');
        assert.equal(r.nextCursor, ids[0], '未续接时 nextCursor 就是真正的最新 id');
        assert.equal(r.abandonedOldWatermark, false);
    } finally { restore(); }
});

test('从续接游标接着走能追平水位；续接轮的 nextCursor 不是全局最新（故水位要用 catchup.top）', async () => {
    const now = Date.now();
    const ids = Array.from({ length: 240 }, (_, i) => idFor(now - i * 60000));
    const up = upstream(ids);
    const restore = withFetch(up.fetchStub);
    try {
        const watermark = ids[199];
        const win = now - SOCIAL_RETENTION_DAYS * 86400000;
        const first = await xAdapter.fetchEvents({ externalKey: 'elonmusk', cursor: watermark, windowStartMs: win });
        const second = await xAdapter.fetchEvents({
            externalKey: 'elonmusk', cursor: watermark, resumeCursor: first.resumeCursor, windowStartMs: win
        });
        assert.equal(second.covered, true, '第二轮追到水位');
        assert.equal(second.resumeCursor, null, '已了结就没有续接游标');
        assert.deepEqual(up.calls.slice(X_MAX_PAGES), ['c4', 'c5', 'c6', 'c7', 'c8'],
            '第二轮从上一轮停下的下一页开始，不回到第一页');

        // 续接轮是从时间线中段开始的，它看到的最高 id 并非最新——这是 service
        // 必须用 settings.catchup.top 推进水位的原因，用 nextCursor 会把水位倒退。
        assert.equal(second.nextCursor, ids[100]);
        assert.notEqual(second.nextCursor, ids[0], '续接轮的 nextCursor 不是全局最新');
        const seen = new Set([...first.events, ...second.events].map(e => e.providerEventId));
        assert.equal(seen.size, first.events.length + second.events.length, '两轮之间不重复');
        // 第一轮到 ids[99]，第二轮把 ids[100..198] 补齐；ids[199] 正好是水位本身，不算新消息。
        assert.equal(first.events.length, 100);
        assert.equal(second.events.length, 99);
        assert.equal(seen.size, 199, '两轮合起来正好覆盖水位之上的每一条，一条不漏');
    } finally { restore(); }
});

test('上游把同一个分页游标还回来：独立错误码 pagination，且不会无限翻页', async () => {
    const now = Date.now();
    const ids = Array.from({ length: 240 }, (_, i) => idFor(now - i * 60000));
    // 重复游标要能被解析回同一页，否则会拿到空页、被当成「翻到头了」而合法收工。
    const up = upstream(ids, { cursorFor: () => 'c0' });
    const restore = withFetch(up.fetchStub);
    try {
        await assert.rejects(
            xAdapter.fetchEvents({ externalKey: 'elonmusk', cursor: ids[199], windowStartMs: 0 }),
            err => {
                assert.equal(err.code, 'pagination', '不再与「消息太多」共用同一个错误码');
                assert.match(err.message, /分页游标重复/);
                return true;
            }
        );
        assert.ok(up.calls.length <= X_MAX_PAGES, `请求页数有界（实测 ${up.calls.length}）`);
    } finally { restore(); }
});

test('已翻过保留窗口：判定缺口了结并放弃老水位（不为过期消息徒劳追赶）', async () => {
    const now = Date.now();
    // 全是 40 天前的消息：整段缺口都在 30 天保留期之外。
    const ids = Array.from({ length: 240 }, (_, i) => idFor(now - 40 * 86400000 - i * 60000));
    const up = upstream(ids);
    const restore = withFetch(up.fetchStub);
    try {
        const r = await xAdapter.fetchEvents({
            externalKey: 'elonmusk', cursor: ids[239],
            windowStartMs: now - SOCIAL_RETENTION_DAYS * 86400000
        });
        assert.equal(r.covered, true, '越过保留窗口即视为缺口了结，不再无限追赶');
        assert.equal(r.abandonedOldWatermark, true, '并且明确标出「放弃了老水位」');
        assert.equal(r.nextCursor, ids[0], '水位推进到本轮看到的最新 id');
    } finally { restore(); }
});

// ===================== 服务 + 持久化：跨轮追赶 =====================

test('多轮追赶：每轮都入库、水位不动；追平后才推进水位并清掉进度', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const now = Date.now();
    // 16 页（每页 20 条），水位落在第 14 页末——单轮 5 页预算下需要三轮。
    const ids = Array.from({ length: 320 }, (_, i) => idFor(now - i * 60000));
    const up = upstream(ids);
    const restore = withFetch(up.fetchStub);
    try {
        const repo = createRepository(db);
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH, log: { warn() {} } });
        const src = makeSource(repo, { syncCursor: ids[299] });
        const watermarkBefore = repo.getSource(src.id).syncCursor;

        const first = await service.syncSource(src.id);
        assert.equal(first.ok, true, '未追完不是失败');
        assert.equal(first.catchingUp, true, '标记为「正在追赶」');
        assert.equal(first.inserted, 100, '本轮已取到的 100 条先入库——旧实现这里是 0');
        assert.equal(repo.getSource(src.id).syncCursor, watermarkBefore, '水位不许中途推进');
        assert.equal(repo.countSourceEvents(src.id), 100);
        const mid = repo.getSource(src.id).settings.catchup;
        assert.equal(mid.target, ids[299], '记住要追到的边界');
        assert.equal(mid.top, ids[0], '记住开始追赶时看到的最新 id');
        assert.equal(mid.rounds, 1);

        const second = await service.syncSource(src.id);
        assert.equal(second.catchingUp, true);
        assert.equal(repo.countSourceEvents(src.id), 200, '跨轮累计，不丢消息也不重复');
        assert.equal(repo.getSource(src.id).syncCursor, watermarkBefore, '仍未追平，水位依旧不动');
        assert.equal(repo.getSource(src.id).settings.catchup.rounds, 2);

        const third = await service.syncSource(src.id);
        assert.equal(third.ok, true);
        assert.equal(third.catchingUp, undefined, '追平后不再是追赶轮');
        assert.equal(third.inserted, 99, '末轮补齐剩余部分；水位那条本身不算新消息');
        const done = repo.getSource(src.id);
        assert.equal(done.syncCursor, ids[0], '追平后水位推进到「开始追赶时看到的最新 id」');
        assert.equal(done.settings.catchup, undefined, '清掉追赶进度');
        assert.equal(done.lastError, null);
        assert.ok(done.lastSuccessAt > 1, '记录最后成功时间');
        assert.equal(repo.countSourceEvents(src.id), 299, '水位之上的每一条都入库，且不重复');
    } finally {
        restore(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('追赶轮按正常周期排期，不施加指数退避；真正的失败才退避', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const now = Date.now();
    const ids = Array.from({ length: 240 }, (_, i) => idFor(now - i * 60000));
    const up = upstream(ids);
    const restore = withFetch(up.fetchStub);
    try {
        const repo = createRepository(db);
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH, log: { warn() {} } });
        const src = makeSource(repo, { syncCursor: ids[199] });
        const interval = 300000;

        const attemptedAt = Date.now();
        await service.syncSource(src.id);
        const partial = repo.getSource(src.id);
        const partialDelay = partial.nextSyncAt - attemptedAt;
        assert.ok(partialDelay <= interval + 3000,
            `追赶轮按正常周期排期（实测 ${partialDelay}ms，周期 ${interval}ms）——退避会把追赶拖成数天`);

        // 换成必然失败的上游：连续两次，退避应翻倍。
        globalThis.fetch = async () => { throw new Error('boom'); };
        await service.syncSource(src.id);
        const second = await service.syncSource(src.id);
        const failedDelay = repo.getSource(src.id).nextSyncAt - Date.now();
        assert.ok(failedDelay > interval, `失败仍走退避（实测 ${failedDelay}ms > 周期 ${interval}ms）`);
        assert.equal(second.ok, false);
        const kept = repo.getSource(src.id).settings.catchup;
        assert.ok(kept && kept.cursor, '失败后**保留**追赶进度，下一轮接着走而不是回到第一页');
    } finally {
        restore(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('追赶期间不打上游做历史回填与译文补充（请求量上界）', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const now = Date.now();
    const ids = Array.from({ length: 240 }, (_, i) => idFor(now - i * 60000));
    const up = upstream(ids);
    const restore = withFetch(up.fetchStub);
    try {
        const repo = createRepository(db);
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH, log: { warn() {} } });
        const src = makeSource(repo, { syncCursor: ids[199] });
        const r = await service.syncSource(src.id);
        assert.equal(r.inserted, 100);
        assert.equal(up.calls.length, X_MAX_PAGES,
            `追赶轮只打增量那几步（实测 ${up.calls.length}）——回填最多 20 页、补充译文每条一次，跑起来请求量翻倍`);
        assert.equal(r.backfilled, 0);
        assert.equal(r.enriched, 0);
    } finally {
        restore(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('保留窗口之外的社交消息不入库，手动保存的文章不受影响', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const now = Date.now();
    // 全部落在 30 天之前。
    const old = Array.from({ length: 30 }, (_, i) => idFor(now - 40 * 86400000 - i * 60000));
    const up = upstream(old);
    const restore = withFetch(up.fetchStub);
    try {
        const repo = createRepository(db);
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH, log: { warn() {} } });
        const src = makeSource(repo);
        const r = await service.syncSource(src.id);
        assert.equal(r.ok, true);
        assert.equal(r.inserted, 0, '过期的社交消息不入库');
        assert.ok(r.skipped > 0, `计入 skipped（实测 ${r.skipped}）`);
        assert.equal(repo.countSourceEvents(src.id), 0);

        const article = await service.saveArticle({ url: 'https://example.com/keep', title: '手动保存' });
        assert.ok(article.id, '手动保存不受保留窗口影响');
        assert.equal(repo.countSourceEvents(src.id), 0);
    } finally {
        restore(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('追赶途中失败：进度保留，下一轮从同一位置续接而不是回到第一页', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const now = Date.now();
    const ids = Array.from({ length: 320 }, (_, i) => idFor(now - i * 60000));
    const up = upstream(ids);
    const original = globalThis.fetch;
    globalThis.fetch = up.fetchStub;
    try {
        const repo = createRepository(db);
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH, log: { warn() {} } });
        const src = makeSource(repo, { syncCursor: ids[299] });

        const first = await service.syncSource(src.id);
        assert.equal(first.catchingUp, true);
        const resumeAt = repo.getSource(src.id).settings.catchup.cursor;
        assert.equal(resumeAt, `c${X_MAX_PAGES - 1}`);
        const insertedBefore = repo.countSourceEvents(src.id);

        // 上游挂掉：失败保留进度，不把水位跳到最新（那会静默跳过缺口里的消息）。
        globalThis.fetch = async () => { throw new Error('upstream down'); };
        const failed = await service.syncSource(src.id);
        assert.equal(failed.ok, false);
        assert.equal(repo.getSource(src.id).settings.catchup.cursor, resumeAt, '失败不动进度');
        assert.equal(repo.getSource(src.id).syncCursor, ids[299], '失败不动水位');
        assert.equal(repo.countSourceEvents(src.id), insertedBefore, '失败不丢已入库的消息');

        // 恢复后必须从续接游标开始，而不是回到第一页。
        up.calls.length = 0;
        globalThis.fetch = up.fetchStub;
        const resumed = await service.syncSource(src.id);
        assert.equal(up.calls[0], resumeAt, `续接位置没有被丢弃（实测首请求 ${up.calls[0]}）`);
        assert.equal(resumed.ok, true);
        assert.ok(repo.countSourceEvents(src.id) > insertedBefore, '续接后继续入库');
    } finally {
        globalThis.fetch = original;
        db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('不支持追赶的适配器（微博形状，无 covered 字段）仍按完整覆盖处理，水位照常推进', async () => {
    // 回归：service 曾用 `if (result.covered)` 分流。微博的 fetchEvents 只返回
    // `{ events, nextCursor }`，于是每一轮都会被判成「未追完」——写追赶进度、
    // 水位永不推进、永远不会成功。新契约必须默认到旧行为。
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const original = globalThis.fetch;
    const now = Date.now();
    const ids = [idFor(now - 60000), idFor(now - 120000), idFor(now - 180000)];
    const calls = [];
    // 微博走 /statuses/user_timeline.json?since_id=...，正文用微博的字段形状。
    globalThis.fetch = async url => {
        const u = String(url);
        if (!u.includes('user_timeline')) return Response.json({ code: 200 });
        calls.push(/since_id=(\d+)/.exec(u)?.[1] || null);
        return Response.json({
            statuses: ids.map((id, i) => ({
                id, mid: id, text: `weibo ${i}`,
                created_at: new Date(now - (i + 1) * 60000).toUTCString(),
                user: { screen_name: 'someone' }
            }))
        });
    };
    try {
        const repo = createRepository(db);
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH, log: { warn() {} } });
        const src = repo.createSource({
            providerType: 'weibo', name: '微博 · someone', externalKey: 'someone',
            settings: {}, syncIntervalMs: 300000, nextSyncAt: 0
        });
        repo.setCredentials(src.id, encrypt(JSON.stringify({ token: 'stub-token' }), OLD_HASH, 'timeline'));
        const first = await service.syncSource(src.id);
        assert.equal(first.ok, true, '没有 covered 字段 = 完整覆盖');
        assert.equal(first.catchingUp, undefined, '不该被判成追赶');
        assert.ok(repo.countSourceEvents(src.id) > 0, '消息照常入库');
        assert.equal(repo.getSource(src.id).syncCursor, ids[0], '水位推进到最高 id');
        assert.equal(repo.getSource(src.id).settings.catchup, undefined, '不写追赶进度');
        assert.ok(calls.length > 0);
    } finally {
        globalThis.fetch = original;
        db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('置顶的老帖不参与「本页最旧」判断，不会被误判成越过窗口而跳过积压', async () => {
    // 回归（审查发现）：`oldestMs` 曾把置顶帖也算进去。一条 40 天前的置顶帖
    // 会让首轮就判 `passedWindow` → 水位跳到最新 → `(本页底, 水位]` 的积压消息
    // 被永久跳过（回填若已 done 就再也补不回来）。
    const now = Date.now();
    const pinnedOld = idFor(now - 40 * 86400000);
    const page0 = Array.from({ length: 20 }, (_, i) => idFor(now - i * 60000));
    const page1 = Array.from({ length: 5 }, (_, i) => idFor(now - 20 * 60000 - i * 60000));
    const watermark = idFor(now - 30 * 86400000);   // 远在窗口之外的水位，必须继续翻页
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async url => {
        const u = String(url);
        if (!u.includes('/statuses')) return Response.json({ code: 200, user: { screen_name: 'elonmusk', id: '1' } });
        const m = /[?&]cursor=([^&]*)/.exec(u);
        const cursor = m ? decodeURIComponent(m[1]) : null;
        calls.push(cursor);
        const rows = cursor === null
            ? [{ ...fxStatus(pinnedOld), is_pinned: true }, ...page0.map(fxStatus)]
            : page1.map(fxStatus);
        return Response.json({ code: 200, results: rows, cursor: { top: null, bottom: cursor === null ? 'c0' : null } });
    };
    try {
        const r = await xAdapter.fetchEvents({
            externalKey: 'elonmusk', cursor: watermark,
            windowStartMs: now - SOCIAL_RETENTION_DAYS * 86400000
        });
        assert.equal(r.abandonedOldWatermark, false, '置顶老帖不能把整页判成已越过窗口');
        assert.ok(calls.length >= 2, `必须继续翻页（实测 ${calls.length} 次请求）`);
        assert.equal(r.covered, true, '翻到没有下一页才收工');
        assert.ok(r.events.length >= page0.length, '积压消息要交出来');
    } finally { globalThis.fetch = original; }
});

test('sourceView：追赶中显示 catching_up（不是失败）；停滞报错时仍显示失败', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH, log: { warn() {} } });
        const src = makeSource(repo);
        const target = idFor(Date.now() - 3600000);
        repo.recordCatchup(src.id, {
            settings: { catchup: { target, top: idFor(Date.now()), cursor: 'c4', rounds: 2, startedAt: Date.now() } },
            at: Date.now(), nextSyncAt: Date.now() + 300000
        });
        const view = service.getSourceView(src.id);
        assert.equal(view.status, 'catching_up', '追赶中');
        assert.equal(view.catchup.rounds, 2);
        assert.equal(view.lastError, null);

        // 网页端只把 failed/expired 收进「同步未完成」，追赶中不该触发它。
        const listed = service.listTimeline({});
        assert.deepEqual(listed.sync.failed, [], '追赶中不进失败列表');
        assert.equal(listed.sync.state, 'ok');

        // 停滞会写 lastError：那时必须显示失败并给重试，而不是「正在追赶」。
        repo.recordFailure(src.id, { code: 'pagination', message: '上游分页可能异常', at: Date.now(), nextSyncAt: Date.now() });
        assert.equal(service.getSourceView(src.id).status, 'failed', '停滞优先显示为失败');
        assert.equal(service.listTimeline({}).sync.failed.length, 1);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ===================== 仓库：recordCatchup 的边界 =====================

test('recordCatchup 只写 settings / 排期，不动 sync_cursor 与 last_success_at', () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        const src = makeSource(repo);
        repo.recordSuccess(src.id, { cursor: 'watermark-1', at: 12345, nextSyncAt: 999 });
        const before = repo.getSource(src.id);
        assert.equal(before.syncCursor, 'watermark-1');
        assert.equal(before.lastSuccessAt, 12345);

        repo.recordCatchup(src.id, {
            settings: { history: { done: true }, catchup: { target: 'watermark-1', top: 'watermark-2', cursor: 'c9', rounds: 1, startedAt: 1, stalled: 0 } },
            at: 54321, nextSyncAt: 111
        });
        const after = repo.getSource(src.id);
        assert.equal(after.syncCursor, 'watermark-1', '水位不动——中途推进会把缺口里的消息永久跳过');
        assert.equal(after.lastSuccessAt, 12345, '最后成功时间不动（确实还没完整成功）');
        assert.equal(after.nextSyncAt, 111);
        assert.equal(after.lastError, null, '追赶不是错误');
        assert.deepEqual(after.settings.history, { done: true }, 'settings 的其它键保留');
        assert.equal(after.settings.catchup.cursor, 'c9');
        assert.equal(after.updatedAt, 54321);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recordSuccess 不传 settings 时保持原值；传了才覆盖（用于清掉追赶进度）', () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        const src = makeSource(repo, { settings: { history: { done: true } } });
        repo.recordSuccess(src.id, { cursor: 'a', at: 1, nextSyncAt: 2 });
        assert.deepEqual(repo.getSource(src.id).settings, { history: { done: true } }, '不传就保持原值');
        repo.recordSuccess(src.id, { cursor: 'b', at: 3, nextSyncAt: 4, settings: {} });
        assert.deepEqual(repo.getSource(src.id).settings, {}, '传了空对象就清空');
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ===================== 纯函数：追赶状态的校验与过期丢弃 =====================

test('normalizeCatchup：形状不符 / 轮数超限 / 缺口不成立一律丢弃', () => {
    const { normalizeCatchup, clearCatchup, retentionCutoff } = __test;
    const top = '200', target = '100';
    const good = { target, top, cursor: 'c4', rounds: 2, startedAt: 5 };
    const ok = normalizeCatchup(good);
    assert.equal(ok.target, target);
    assert.equal(ok.top, top);
    assert.equal(ok.rounds, 2);

    for (const bad of [
        null, undefined, 'x', [], 42,
        { target, top },                        // 缺 rounds
        { target: 'abc', top, rounds: 1 },      // target 不是数字串
        { target, top: 'abc', rounds: 1 },      // top 不是数字串
        { target: '200', top: '100', rounds: 1 }, // top 不新于 target：缺口不成立
        { target, top, rounds: -1 },
        { target, top, rounds: 1.5 },
        { target, top, rounds: X_CATCHUP_MAX_ROUNDS + 1 }   // 陈旧状态（很旧的备份）
    ]) {
        assert.equal(normalizeCatchup(bad), null, `${JSON.stringify(bad)} 应被丢弃`);
    }
    assert.equal(normalizeCatchup({ target, top, rounds: 0 }).rounds, 0, '轮数可以为 0');

    const cleared = clearCatchup({ history: { done: true }, catchup: good, other: 1 });
    assert.equal(cleared.catchup, undefined, '清掉追赶键');
    assert.deepEqual(cleared.history, { done: true }, '保留其它键');
    assert.equal(cleared.other, 1);
    assert.deepEqual(clearCatchup(null), {}, '空 settings 也能安全清理');

    const windowStart = retentionCutoff(1e12);
    assert.equal(1e12 - windowStart, SOCIAL_RETENTION_DAYS * 86400000, '保留窗口下界 = 当前时间减去保留天数');
});

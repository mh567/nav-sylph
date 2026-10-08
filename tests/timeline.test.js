'use strict';

/**
 * Special Line 时间线：数据层 + 服务层 + adapter + 路由形状 + 平台接线。
 *
 * 这里的原则与仓库其它测试一致：**能执行的就不只断言源码形状**——
 * 去重、分页、保留、重加密都真跑（临时库 / vm 执行真实函数）；
 * 只有「接线是否还在」这类没有返回值的东西才用形状断言。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const swSource = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const moduleSource = fs.readFileSync(path.join(ROOT, 'public', 'modules', 'special-line.js'), 'utf8');

const { openDatabase, MIGRATIONS } = require(path.join(ROOT, 'lib', 'db.js'));
const { createRepository } = require(path.join(ROOT, 'lib', 'timeline', 'repository.js'));
const { createService, ServiceError } = require(path.join(ROOT, 'lib', 'timeline', 'service.js'));
const { createTimeline } = require(path.join(ROOT, 'lib', 'timeline', 'index.js'));
const { getProvider, eventTypeLabel, isEventType } = require(path.join(ROOT, 'lib', 'timeline', 'registry.js'));
const xAdapter = require(path.join(ROOT, 'lib', 'timeline', 'adapters', 'x.js'));
const weiboAdapter = require(path.join(ROOT, 'lib', 'timeline', 'adapters', 'weibo.js'));
const { encrypt, decrypt } = require(path.join(ROOT, 'lib', 'credentials.js'));
const { MAX_EVENTS_PER_SOURCE, MANUAL_SOURCE_ID } = require(path.join(ROOT, 'lib', 'timeline', 'constants.js'));

const OLD_HASH = '$2b$10$oldhashforunittimeline';
const NEW_HASH = '$2b$10$newhashforunittimeline';

/** 去注释后再匹配：注释里的字符串会骗过形状断言（本仓库的老教训）。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-timeline-db-'));
    return { dir, file: path.join(dir, 'timeline.db') };
}

/**
 * 从源码里切出一个函数（按大括号配对，不按「下一个函数定义」——
 * 那样会在文件末尾或内部 catch 上切歪）。调用前先 stripComments。
 */
function extractFunction(src, header) {
    const start = src.indexOf(header);
    assert.ok(start >= 0, `能在源码中找到 ${header}`);
    let depth = 0;
    let end = -1;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
        }
    }
    assert.ok(end > start, `${header} 的大括号配对成功`);
    return src.slice(start, end);
}

/** 造一个带若干事件的来源。 */
function seedEvents(repo, sourceId, rows, now = Date.now()) {
    return repo.insertEvents(sourceId, rows, now);
}

function socialEvent(n, occurredAt) {
    return {
        providerEventId: `p${n}`,
        eventType: 'social_post',
        dedupeKey: `p${n}`,
        occurredAt,
        author: 'alice',
        title: `post ${n}`,
        summary: `body ${n}`,
        url: `https://example.com/${n}`,
        metadata: {}
    };
}

// ========== 迁移 ==========

test('v5 迁移建出四张时间线表与索引，且在数组尾部追加（不动已发布台阶）', () => {
    assert.ok(MIGRATIONS.length >= 5, `迁移台阶至少 5 级，当前 ${MIGRATIONS.length}`);

    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        for (const t of ['timeline_sources', 'timeline_credentials', 'timeline_events', 'timeline_event_state']) {
            assert.ok(tables.includes(t), `建出 ${t}`);
        }
        const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_timeline%'")
            .all().map(r => r.name);
        assert.deepEqual(idx.sort(), [
            'idx_timeline_events_source_time', 'idx_timeline_events_time', 'idx_timeline_sources_due'
        ]);

        // 外键 + 级联：删来源要带走它的事件/状态/凭据（应用层不手工清）
        const fks = db.prepare('PRAGMA foreign_key_list(timeline_events)').all();
        assert.ok(fks.some(f => f.table === 'timeline_sources' && f.on_delete === 'CASCADE'),
            'timeline_events 对来源是级联删除');

        // 去重落在数据库层
        const uniq = db.prepare('PRAGMA index_list(timeline_events)').all();
        assert.ok(uniq.some(i => i.unique === 1), 'timeline_events 有唯一约束（去重的兜底）');

        assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ========== 去重 / 状态 ==========

test('同一个 dedupe_key 二次摄入不重复，且不重置已读/归档', () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        repo.ensureManualSource();
        const src = repo.createSource({
            providerType: 'x', name: 'X · a', externalKey: 'a',
            settings: {}, syncIntervalMs: 900000, nextSyncAt: 0
        });

        assert.equal(seedEvents(repo, src.id, [socialEvent(1, 1000)]), 1);
        assert.equal(seedEvents(repo, src.id, [socialEvent(1, 1000)]), 0, '同一批重复拉回不新增');
        assert.equal(repo.countSourceEvents(src.id), 1);

        const first = repo.listEvents({}).rows[0];
        repo.setRead(first.id, true, Date.now());
        repo.setArchive(first.id, true, Date.now());

        // 再来一轮（模拟下一轮同步把同一条又拉回来）
        assert.equal(seedEvents(repo, src.id, [socialEvent(1, 1000)]), 0);
        const after = repo.listEvents({ view: 'archived' }).rows[0];
        assert.ok(after, '归档那条还在归档视图里');
        assert.ok(after.readAt && after.archivedAt,
            '重复摄入不得把用户标过的已读/归档重置回默认');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('手动保存：同一 URL 是更新而不是新增，且保留首次保存时间', () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const service = createService(createRepository(db), { getPasswordHash: async () => OLD_HASH });

        const first = service.saveArticle({ url: 'https://example.com/a', title: '标题一', summary: 's1' });
        const again = service.saveArticle({ url: 'https://example.com/a', title: '标题二' });
        assert.equal(service.listTimeline({}).events.length, 1, '同一链接只留一条');
        const only = service.listTimeline({}).events[0];
        assert.equal(only.title, '标题二', '再次保存更新标题');
        assert.equal(only.occurredAt, first.occurredAt, '首次保存时间保留（不因再次保存而浮到顶部）');
        assert.equal(only.summary, '', '第二次没给摘要就覆盖为空——这是「更新」的语义');
        assert.equal(again.id, first.id, '返回的是同一条');

        // 不同 URL 是两条
        service.saveArticle({ url: 'https://example.com/b', title: '另一篇' });
        assert.equal(service.listTimeline({}).events.length, 2);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ========== 分页 ==========

test('游标分页稳定：不重不漏，hasMore 与 nextCursor 一致', () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        repo.ensureManualSource();
        const src = repo.createSource({
            providerType: 'x', name: 'X · a', externalKey: 'a',
            settings: {}, syncIntervalMs: 900000, nextSyncAt: 0
        });
        // occurred_at 故意有重复值：排序键必须是 (occurred_at, id) 才稳定
        const rows = [];
        for (let i = 0; i < 7; i++) rows.push(socialEvent(i, 1000 + Math.floor(i / 2)));
        seedEvents(repo, src.id, rows);

        const seen = [];
        let cursor = null;
        let pages = 0;
        for (;;) {
            const page = repo.listEvents({ cursor, limit: 3 });
            pages++;
            assert.ok(pages <= 5, '分页不能无限循环');
            page.rows.forEach(r => seen.push(r.id));
            if (!page.hasMore) {
                // ⚠️ 这里曾写成 `assert.equal(page.nextCursor, page.rows.length ? page.nextCursor : null)`
                // ——右边就是它自己，恒真。末页只需要钉「没有更多」。
                assert.equal(page.hasMore, false);
                assert.ok(page.rows.length <= 3, '末页不超过页长');
                break;
            }
            assert.ok(page.nextCursor, 'hasMore 为真时必须给出下一游标');
            assert.equal(page.rows.length, 3, '还有更多时必须给满一页（否则会漏条）');
            cursor = page.nextCursor;
        }
        assert.equal(seen.length, 7, '七条正好走完，不漏');
        assert.equal(new Set(seen).size, 7, '不重');
        assert.ok(pages >= 3, `确实翻了页（${pages}）`);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('视图筛选：默认不含已归档，未读与归档各成一组', () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        repo.ensureManualSource();
        const src = repo.createSource({
            providerType: 'x', name: 'X · a', externalKey: 'a',
            settings: {}, syncIntervalMs: 900000, nextSyncAt: 0
        });
        seedEvents(repo, src.id, [socialEvent(1, 3000), socialEvent(2, 2000), socialEvent(3, 1000)]);
        const rows = repo.listEvents({}).rows;
        repo.setRead(rows[0].id, true, Date.now());
        repo.setArchive(rows[2].id, true, Date.now());

        assert.equal(repo.listEvents({ view: 'all' }).rows.length, 2, '默认视图排除已归档');
        assert.equal(repo.listEvents({ view: 'unread' }).rows.length, 1, '未读只剩一条');
        assert.equal(repo.listEvents({ view: 'archived' }).rows.length, 1, '归档视图只有那一条');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ========== 保留与容量 ==========

test('保留清扫只删过期的社交事件；手动保存的文章不按时限删', () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        repo.ensureManualSource();
        const src = repo.createSource({
            providerType: 'x', name: 'X · a', externalKey: 'a',
            settings: {}, syncIntervalMs: 900000, nextSyncAt: 0
        });
        const old = Date.now() - 200 * 86400000;
        seedEvents(repo, src.id, [socialEvent(1, old), socialEvent(2, Date.now())]);
        // 手动来源里放一条「很旧」的：它不是社交事件，不该被时限清掉
        repo.upsertManualEvent({
            dedupeKey: 'url:old', occurredAt: old, title: '很久以前保存的文章',
            summary: '', url: 'https://example.com/old', metadata: {}
        }, Date.now());

        const removed = repo.sweepRetention(Date.now() - 90 * 86400000);
        assert.equal(removed, 1, '只清掉那条过期的社交事件');

        const titles = repo.listEvents({}).rows.map(r => r.title);
        assert.ok(titles.includes('post 2'), '未过期的社交事件保留');
        assert.ok(titles.includes('很久以前保存的文章'), '手动文章不参与时限清理');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('容量触顶：停止入库并显式报错，不静默驱逐已有数据', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        repo.ensureManualSource();
        const src = repo.createSource({
            providerType: 'x', name: 'X · a', externalKey: 'a',
            settings: {}, syncIntervalMs: 900000, nextSyncAt: 0
        });
        const bulk = [];
        for (let i = 0; i < MAX_EVENTS_PER_SOURCE; i++) bulk.push(socialEvent(i, 1000 + i));
        seedEvents(repo, src.id, bulk);
        assert.equal(repo.countSourceEvents(src.id), MAX_EVENTS_PER_SOURCE);

        const service = createService(repo, {
            getPasswordHash: async () => OLD_HASH,
            log: { warn() {} }
        });
        // 用一个必然「有返回」的 provider 桩：把 x 换成返回空批次的假 adapter
        const { PROVIDERS } = require(path.join(ROOT, 'lib', 'timeline', 'registry.js'));
        const original = PROVIDERS.get('x');
        PROVIDERS.set('x', {
            id: 'x', label: 'X', symbol: 'X', minIntervalMs: 0,
            credentialLabel: 'Token', accountLabel: '账号',
            validateSettings: () => ({ ok: true }),
            testConnection: async () => ({ ok: true }),
            fetchEvents: async () => ({ events: [socialEvent(99999, Date.now())], nextCursor: 'z' }),
            normalize: r => r
        });
        try {
            repo.setCredentials(src.id, encrypt(JSON.stringify({ token: 'stub' }), OLD_HASH, 'timeline'));
            const result = await service.syncSource(src.id);
            assert.equal(result.ok, false);
            assert.equal(result.code, 'capacity');
            assert.equal(repo.countSourceEvents(src.id), MAX_EVENTS_PER_SOURCE, '一条都没删、也没多');
            assert.equal(repo.getSource(src.id).lastError.code, 'capacity', '容量错误要能被界面读到');
        } finally {
            PROVIDERS.set('x', original);
        }
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ========== 校验边界（不可信输入） ==========

test('校验边界：协议、长度、时间、事件类型、metadata 白名单', () => {
    const { clampText, safeHttpUrl, safeTime, sanitizeMetadata } = require(
        path.join(ROOT, 'lib', 'timeline', 'service.js')).__test;

    assert.equal(safeHttpUrl('javascript:alert(1)'), '', 'javascript: 被拒');
    assert.equal(safeHttpUrl('file:///etc/passwd'), '', 'file: 被拒');
    assert.equal(safeHttpUrl('data:text/html,x'), '', 'data: 被拒');
    assert.equal(safeHttpUrl('不是链接'), '', '非 URL 被拒');
    assert.equal(safeHttpUrl('https://example.com/a'), 'https://example.com/a', 'http(s) 通过');
    assert.equal(safeHttpUrl('https://example.com/' + 'x'.repeat(4000)).length, 2048, '超长 URL 被截断到上限');

    assert.equal(clampText('  a  ', 10), 'a');
    assert.equal(clampText('abcdef', 3), 'abc', '超长被裁');
    assert.equal(clampText(null, 10), '');

    const now = Date.now();
    assert.equal(safeTime(undefined, now), now, '缺失时间回落到摄入时刻（不丢整条）');
    assert.equal(safeTime('abc', now), now, '解析不出也回落到摄入时刻');
    assert.equal(safeTime(now + 10 * 3600 * 1000, now), now, '离谱的未来时间回落到摄入时刻');
    assert.equal(safeTime(1, now), now, '2000 年以前回落到摄入时刻');
    assert.equal(safeTime(now - 1000, now), now - 1000, '合理时间原样保留');

    assert.deepEqual(sanitizeMetadata({ quote: ' 引用 ', evil: '<script>' }), { quote: '引用' },
        'metadata 是白名单：只留 quote');
    assert.deepEqual(sanitizeMetadata('not an object'), {});

    assert.ok(isEventType('social_post') && isEventType('article_saved'));
    assert.ok(!isEventType('unknown_type'), '未知事件类型不认（会被跳过而不是入库）');
    assert.equal(eventTypeLabel('social_post', 'x'), '博主推文', '标签按 provider 细分');
    assert.equal(eventTypeLabel('social_post', 'weibo'), '微博动态');
    assert.equal(eventTypeLabel('weird_type', 'x'), 'weird_type', '未知类型回落原样，不猜');
});

// ========== adapter（fixture） ==========

test('x adapter：normalize 出稳定事件，错误分类可区分凭据与网络', async () => {
    const rec = {
        id: '1799999999999999999',
        text: '第一行是标题\n第二行以后是摘要',
        created_at: '2026-10-08T06:32:00.000Z',
        author_id: '42'
    };
    const ev = xAdapter.normalize(rec, { externalKey: '@alice' });
    assert.equal(ev.providerEventId, rec.id, 'provider 事件 id 原样保留（它就是去重键）');
    assert.equal(ev.eventType, 'social_post');
    assert.equal(ev.title, '第一行是标题');
    assert.equal(ev.summary, '第二行以后是摘要');
    assert.equal(ev.author, '@alice', '@ 前缀补回');
    assert.equal(ev.url, `https://x.com/alice/status/${rec.id}`);
    assert.equal(ev.occurredAt, Date.parse(rec.created_at));
    assert.equal(xAdapter.normalize({}, {}), null, '没有 id 的记录返回 null（会被跳过）');

    // 凭据缺失 -> auth（界面给「重新授权」，不是「稍后重试」）
    const noTok = await xAdapter.testConnection({ credentials: {}, externalKey: 'a' });
    assert.equal(noTok.ok, false);
    assert.equal(noTok.code, 'auth');

    // 网络层错误分类：注入一个必然失败的 fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw Object.assign(new Error('boom'), { name: 'TypeError' }); };
    try {
        const res = await xAdapter.testConnection({ credentials: { token: 't' }, externalKey: 'a' });
        assert.equal(res.ok, false);
        assert.equal(res.code, 'network', '网络错误不能被当成凭据错误');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('weibo adapter：normalize 与 error_code 分类（HTTP 200 里报错也要认出来）', async () => {
    const rec = {
        id: 4690140234550176,
        mid: 'u0K2AkFhB',
        text: '标题行\n摘要行',
        created_at: 'Tue Oct 08 14:32:00 +0800 2026',
        user: { screen_name: '城市观察员' }
    };
    const ev = weiboAdapter.normalize(rec, {});
    assert.equal(ev.providerEventId, String(rec.id));
    assert.equal(ev.author, '城市观察员');
    assert.equal(ev.url, `https://weibo.com/${encodeURIComponent('城市观察员')}/${rec.mid}`);
    assert.ok(Number.isFinite(ev.occurredAt), 'Twitter 风格时间能被解析');

    const originalFetch = globalThis.fetch;
    const respond = body => async () => ({
        ok: true, status: 200, json: async () => body
    });
    try {
        // token 过期：HTTP 200，错误在 body 里
        globalThis.fetch = respond({ error: 'Token expired', error_code: 21315 });
        const expired = await weiboAdapter.testConnection({ credentials: { token: 't' }, externalKey: 'a' });
        assert.equal(expired.code, 'auth', 'error_code 21315 归到 auth');

        // 限流：另一类，界面下一步不同
        globalThis.fetch = respond({ error: 'rate limited', error_code: 10023 });
        const rate = await weiboAdapter.fetchEvents({ credentials: { token: 't' }, externalKey: 'a' })
            .then(() => null, e => e);
        assert.equal(rate && rate.code, 'rate', 'error_code 10023 归到 rate');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ========== 路由形状 ==========

test('十条 /api/timeline 路由：全部 requireAdmin；读走轮询桶、写走管理桶', () => {
    const code = stripComments(server);
    const routes = [...code.matchAll(/app\.(get|post|put|delete)\('(\/api\/timeline[^']*)'/g)];
    assert.equal(routes.length, 10, `应有 10 条时间线路由，实测 ${routes.length}`);

    for (const m of routes) {
        const [, method, route] = m;
        const head = code.slice(m.index);
        const handlerAt = head.indexOf('=>');
        assert.ok(handlerAt > 0, `${method} ${route} 的处理函数可定位`);
        const chain = head.slice(0, handlerAt);
        assert.ok(chain.includes('requireAdmin'), `${method} ${route} 必须挂 requireAdmin：${chain.trim()}`);
        if (route === '/api/timeline/events') {
            // 只有它是 15 秒一轮的轮询：算进 30/分钟的管理桶会被多标签页自己
            // 打满（与 /api/memos 同一条教训）。/sources 是打开面板时读一次，
            // 按标签页数不增长，留在管理桶即可。
            assert.ok(chain.includes('modulePollLimit'),
                `GET ${route} 是轮询，必须走 modulePollLimit：${chain.trim()}`);
            assert.ok(!chain.includes('rateLimit,'),
                `GET ${route} 不得占用管理桶：${chain.trim()}`);
        } else {
            assert.ok(chain.includes('rateLimit'), `${method} ${route} 走管理桶：${chain.trim()}`);
            assert.ok(!chain.includes('modulePollLimit'),
                `${method} ${route} 不该占轮询配额：${chain.trim()}`);
        }
    }
});

test('api 层不回传凭据：列表只有 hasCredentials，任何响应形状都不含 envelope', () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        repo.ensureManualSource();
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH });
        const src = repo.createSource({
            providerType: 'x', name: 'X · a', externalKey: 'a',
            settings: {}, syncIntervalMs: 900000, nextSyncAt: 0
        });
        repo.setCredentials(src.id, encrypt(JSON.stringify({ token: 'super-secret' }), OLD_HASH, 'timeline'));

        const listed = service.listSources();
        const text = JSON.stringify(listed);
        assert.ok(!text.includes('super-secret'), '明文 token 不得出现在接口形状里');
        assert.ok(!text.includes('envelope'), '密文信封也不得回传');
        assert.ok(!/"token"/.test(text), '连 token 字段名都不下发');
        assert.ok(listed.find(s => s.id === src.id).hasCredentials === true, '只回「有没有」');

        // 连整份时间线读取（含来源状态）也不含
        assert.ok(!JSON.stringify(service.listTimeline({})).includes('super-secret'));
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ========== 改密码：凭据重加密（执行真实函数） ==========

test('改管理员密码时，时间线凭据被就地重加密（跑真实的 reencryptCredentials）', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const timeline = createTimeline(db, { getPasswordHash: async () => OLD_HASH });
        const src = timeline.repo.createSource({
            providerType: 'x', name: 'X · a', externalKey: 'a',
            settings: {}, syncIntervalMs: 900000, nextSyncAt: 0
        });
        timeline.repo.setCredentials(src.id,
            encrypt(JSON.stringify({ token: 'secret' }), OLD_HASH, 'timeline'));

        const body = extractFunction(stripComments(server), 'async function reencryptCredentials(oldHash, newHash)');
        const ENOENT = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
        const run = vm.runInNewContext(`(${body})`, {
            readJSON: async () => ENOENT(),
            writeJSON: async () => {},
            WEBDAV_CONFIG_FILE: '/unused/webdav.json',
            MODULES_FILE: '/unused/modules.json',
            isEnvelope: require(path.join(ROOT, 'lib', 'credentials.js')).isEnvelope,
            encrypt, decrypt,
            timeline,
            db,
            console
        });

        const result = await run(OLD_HASH, NEW_HASH);
        assert.equal(result.reencrypted, 1, '时间线凭据计入重加密条数');
        assert.ok(result.details.some(d => d.includes('时间线')), '详情里说得出是时间线凭据');

        const env = timeline.repo.getCredentials(src.id);
        assert.equal(JSON.parse(decrypt(env, NEW_HASH, 'timeline')).token, 'secret',
            '新密码哈希能解开');
        assert.throws(() => decrypt(env, OLD_HASH, 'timeline'), '旧密码哈希已解不开');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('单条凭据解不开不阻断改密码：保留原值并记进详情', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const timeline = createTimeline(db, { getPasswordHash: async () => OLD_HASH });
        const src = timeline.repo.createSource({
            providerType: 'x', name: 'X · a', externalKey: 'a',
            settings: {}, syncIntervalMs: 900000, nextSyncAt: 0
        });
        // 用**别的**哈希加密：模拟「上一轮改密码后已死的凭据」
        timeline.repo.setCredentials(src.id,
            encrypt(JSON.stringify({ token: 'dead' }), 'some-other-hash', 'timeline'));
        const before = JSON.stringify(timeline.repo.getCredentials(src.id));

        const body = extractFunction(stripComments(server), 'async function reencryptCredentials(oldHash, newHash)');
        const run = vm.runInNewContext(`(${body})`, {
            readJSON: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
            writeJSON: async () => {},
            WEBDAV_CONFIG_FILE: '/unused/webdav.json',
            MODULES_FILE: '/unused/modules.json',
            isEnvelope: require(path.join(ROOT, 'lib', 'credentials.js')).isEnvelope,
            encrypt, decrypt,
            timeline,
            db,
            console
        });
        const result = await run(OLD_HASH, NEW_HASH);

        assert.equal(result.reencrypted, 0);
        assert.ok(result.details.some(d => d.includes('无法解密')), '明确记下这条解不开');
        assert.equal(JSON.stringify(timeline.repo.getCredentials(src.id)), before,
            '解不开就原样保留，不能把凭据改成垃圾');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ========== 平台接线 ==========

test('模块清单与默认停靠：special-line 登记在册，且无已保存布局时回落 defaultSide', () => {
    const code = stripComments(appSource);
    assert.match(code, /static KNOWN_MODULES = \[[^\]]*'special-line'/,
        'KNOWN_MODULES 里必须有 special-line');

    // 读路径：applyWidgetLayout 用 sideOf → defaultSideOf
    const layout = extractFunction(code, 'applyWidgetLayout() {');
    assert.match(layout, /const defaultSideOf = key =>/, '有默认边回落');
    assert.match(layout, /def\.defaultSide === 'right' \? 'right' : 'left'/,
        '按模块定义的 defaultSide 决定默认边');
    // 写路径：新建布局条目时也用 defaultSide（否则右栏内拖自己会被记成 left）
    const drag = extractFunction(code, 'commitWidgetDrag(drag) {');
    assert.match(drag, /side: def && def\.defaultSide === 'right' \? 'right' : 'left'/,
        '新建条目用 defaultSide，不写死 left');

    // 模块自己声明了 defaultSide，且卡片有稳定 instanceId
    assert.match(moduleSource, /defaultSide: 'right'/, 'special-line 声明默认停靠右侧');
    assert.match(moduleSource, /dataset\.instanceId = 'special-line:main'/,
        '布局键是稳定域 id');
});

test('commitWidgetDrag 真的把 defaultSide 写进新条目（执行真实方法）', () => {
    const code = stripComments(appSource);
    const body = extractFunction(code, 'commitWidgetDrag(drag) {');

    const makeNode = (key, side) => ({
        dataset: { instanceId: key, moduleId: key.split(':')[0], side },
        classList: { remove() {} },
        style: { transform: '' }
    });
    const nodes = [makeNode('special-line:main', 'right')];
    const zone = {
        dataset: {},
        querySelectorAll: sel => (sel === '.module-widget' ? nodes : [])
    };
    const config = { widgets: [] };
    let layoutCalls = 0;
    const app = {
        modulesConfig: config,
        applyWidgetLayout() { layoutCalls++; },
        getModule: id => (id === 'special-line' ? { id, defaultSide: 'right' } : { id })
    };
    const invoke = new Function('$', 'drag', 'app',
        `return ({ ${body} }).commitWidgetDrag.call(app, drag);`);
    invoke(() => zone, { id: 'special-line:main', widget: nodes[0], targetSide: null }, app);

    const entry = config.widgets.find(w => w.id === 'special-line:main');
    assert.ok(entry, '为新卡片补了布局条目');
    assert.equal(entry.side, 'right', '默认边取自模块定义，而不是写死的 left');
    assert.equal(layoutCalls, 1, '写完 order 之后重排一次');
});

test('后台来源区块挂点：平台调用模块的 renderAdminSection 并注入 API', () => {
    const code = stripComments(appSource);
    assert.match(code, /def\.renderAdminSection\(el, \{ api: API \}\)/,
        '平台按模块提供的渲染函数挂后台区块，并把 API 注入进去');
    assert.match(code, /data-module-admin="\$\{this\.esc\(def\.id\)\}"/, '区块容器带模块 id');
    assert.match(moduleSource, /function renderAdminSection\(host, state\)/,
        '模块实现该渲染函数');
    assert.match(moduleSource, /renderAdminSection\b[\s\S]*registerModule|registerModule[\s\S]*renderAdminSection/,
        '并把它登记进模块定义');
});

test('模块脚本只用平台注入的 API，不摸 window.app 的内部方法', () => {
    const code = stripComments(moduleSource);
    assert.doesNotMatch(code, /\bAPI\.(get|post|request)\(/,
        '裸 API 是 app.js IIFE 内的 const，不是全局——必须走 state.api');
    assert.doesNotMatch(code, /window\.app\.stackWidgetsByHeight/,
        '重排走注入的 state.requestStack，不去摸平台内部方法');
    assert.match(code, /window\.app\?\.showToast|window\.app && window\.app\.showUiDialog/,
        'toast / 确认框这类平台服务走 window.app 的公开方法');
});

test('sw.js：新模块进预缓存清单（延后加载也要预缓存）且缓存名已升', () => {
    assert.match(swSource, /'\/modules\/special-line\.js'/, '模块脚本在 ASSETS 里');
    assert.match(swSource, /const CACHE = 'nav-v\d+';/);
    // 预缓存清单必须是可解析的数组（漏一个引号会让 install 整批失败）
    const list = swSource.slice(swSource.indexOf('const ASSETS = ['), swSource.indexOf('];', swSource.indexOf('const ASSETS = [')));
    assert.match(list, /'\/modules\/memo\.js'/, '既有模块仍在清单里');
});

// ========== 真跑路由处理器（不只断言源码形状） ==========

/** 抽出时间线那一节的**真实**处理器来跑：app.* 只记录路由，中间件一律放行。
 *  ⚠️ 锚点是注释行，所以必须切**未去注释**的源码——stripComments 会把它删掉，
 *  indexOf 返回 -1、slice(-1) 静默给出空串。 */
function loadTimelineRoutes(timeline) {
    const begin = server.indexOf('// ========== Special Line 时间线 API ==========');
    const end = server.indexOf('// ========== Paste API ==========', begin);
    assert.ok(begin >= 0 && end > begin, '时间线 API 小节存在');

    const routes = new Map();
    const record = method => (route, ...mw) => routes.set(`${method} ${route}`, mw);
    const pass = (req, res, next) => next();
    vm.runInNewContext(server.slice(begin, end), {
        app: {
            get: record('GET'), post: record('POST'),
            put: record('PUT'), delete: record('DELETE')
        },
        rateLimit: pass,
        modulePollLimit: pass,
        requireAdmin: pass,
        readPollInterval: async () => 15,
        console,
        ServiceError,
        timeline
    });
    return routes;
}

async function callRoute(routes, key, req = {}) {
    const mw = routes.get(key);
    assert.ok(mw, `路由存在：${key}`);
    const handler = mw[mw.length - 1];
    let body = null;
    let statusCode = 200;
    const res = {
        status(code) { statusCode = code; return this; },
        json(payload) { body = payload; return this; }
    };
    await handler(Object.assign({ query: {}, params: {}, body: {} }, req), res);
    return { statusCode, body };
}

test('真跑时间线路由处理器：读回完整载荷，写把校验错误映射成 400/404', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const timeline = createTimeline(db, { getPasswordHash: async () => OLD_HASH });
        timeline.service.saveArticle({ url: 'https://example.com/x', title: '一篇' });
        const routes = loadTimelineRoutes(timeline);

        const read = await callRoute(routes, 'GET /api/timeline/events');
        assert.equal(read.statusCode, 200);
        assert.equal(read.body.events.length, 1, '读到刚保存的那条');
        assert.equal(read.body.unreadCount, 1);
        assert.equal(read.body.pollInterval, 15, '轮询周期随响应下发（后台改过不必刷新页面）');
        assert.ok(read.body.sources.some(s => s.providerType === 'manual'), '含内置「稍后阅读」');
        assert.ok(!JSON.stringify(read.body).includes('token'), '响应里连凭据字段名都没有');

        // view 是白名单：非法值回落到 all，而不是 500 或空列表
        const weird = await callRoute(routes, 'GET /api/timeline/events', { query: { view: 'nonsense' } });
        assert.equal(weird.statusCode, 200);
        assert.equal(weird.body.events.length, 1);

        // service 抛的 ServiceError 的 status 必须被路由用上（不是一律 500）
        const badUrl = await callRoute(routes, 'POST /api/timeline/articles',
            { body: { url: 'javascript:alert(1)', title: 'x' } });
        assert.equal(badUrl.statusCode, 400);
        assert.match(badUrl.body.error, /http/);
        const noTitle = await callRoute(routes, 'POST /api/timeline/articles',
            { body: { url: 'https://example.com/y', title: '   ' } });
        assert.equal(noTitle.statusCode, 400);

        const missing = await callRoute(routes, 'POST /api/timeline/events/:id/read',
            { params: { id: 'nope' }, body: { read: true } });
        assert.equal(missing.statusCode, 404, '不存在的事件回 404 而不是静默成功');

        const delManual = await callRoute(routes, 'DELETE /api/timeline/sources/:id',
            { params: { id: 'manual' } });
        assert.equal(delManual.statusCode, 400, '内置来源不可删');

        // read 的布尔来自请求体，真的落库
        const id = read.body.events[0].id;
        const marked = await callRoute(routes, 'POST /api/timeline/events/:id/read',
            { params: { id }, body: { read: true } });
        assert.equal(marked.statusCode, 200);
        assert.equal(marked.body.unread, false);
        const after = await callRoute(routes, 'GET /api/timeline/events');
        assert.equal(after.body.unreadCount, 0);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('模块自己的元素 id 都带模块前缀，且不与页面既有 id 撞名', () => {
    // (?<![-\w]) 排除 data-id="…" 这类；模块 id 只认自己的那两种前缀。
    const ids = [...moduleSource.matchAll(/(?<![-\w])id="([^"]+)"/g)].map(m => m[1]);
    assert.ok(ids.length >= 5, `模块确实生成了 id（${ids.length} 个）`);
    for (const id of ids) {
        assert.ok(/^(specialLine|special-line)/.test(id), `模块 id 必须带模块前缀：${id}`);
    }
    // 撞名会让 querySelector('#x') 命中页面上另一个（往往是隐藏的）元素，
    // 表现为「点了没反应」。这条与 memo 的同款守卫对齐。
    const page = stripComments(appSource)
        + fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    for (const id of ids) {
        assert.ok(!page.includes(`id="${id}"`), `不得与页面既有 id 撞名：${id}`);
    }
});

test('错误文本落库前会剥掉像凭据的片段（微博的 token 就在 query string 里）', () => {
    const { scrubSecrets } = require(path.join(ROOT, 'lib', 'timeline', 'service.js')).__test;

    const weibo = 'HTTP 403: https://api.weibo.com/2/statuses/user_timeline.json?access_token=SECRET123&count=50';
    assert.ok(!scrubSecrets(weibo).includes('SECRET123'), 'query 里的 token 被剥掉');
    assert.match(scrubSecrets('access_token=abc'), /access_token=\*\*\*/);
    assert.match(scrubSecrets('Authorization: Bearer abcdefghijklmn'), /Bearer \*\*\*/i);
    assert.equal(scrubSecrets('普通错误文本'), '普通错误文本', '无关文本原样保留');
    assert.equal(scrubSecrets(null), '');
    assert.ok(scrubSecrets('x'.repeat(1000)).length <= 400, '长度有上限');
});

test('时间线没有自带限流 Map（复用既有桶，不必进 sweep 清单）', () => {
    // 扫描范围：时间线那一整节 + lib/timeline 全部源码。只扫路由开头几行
    // 是覆盖不到东西的（那时这条断言的实际窗口只有 timelineError 一个函数）。
    // 先按原文切（锚点是注释行），再去注释后做匹配
    const section = stripComments(server.slice(
        server.indexOf('// ========== Special Line 时间线 API =========='),
        server.indexOf('// ========== Paste API ==========')));
    assert.ok(section.length > 2000, `时间线那一节切出来了（${section.length} 字符）`);
    assert.doesNotMatch(section, /new Map\(/,
        '时间线自带一只新 Map 就会出现「只增不减、无人清扫」——复用既有桶即可。' +
        '（lib/timeline 里那两只 Map 不在限流路径上，见下条。）');

    // lib/timeline 里的可变集合都是「有界或被显式清理」的，逐只点出来：
    //  · service 的 failures：删来源时 delete，且只按来源计数
    //  · sync 的 inFlight：finally 里 delete
    //  · adapters/x 的 userIdCache：有 USER_ID_CACHE_MAX 上限
    // （registry 的 PROVIDERS 是 new Map([...]) 的字面量常量，不在扫描范围内。）
    const timelineDir = fs.readdirSync(path.join(ROOT, 'lib', 'timeline'));
    const files = timelineDir.filter(f => f.endsWith('.js'))
        .map(f => path.join(ROOT, 'lib', 'timeline', f))
        .concat(fs.readdirSync(path.join(ROOT, 'lib', 'timeline', 'adapters'))
            .filter(f => f.endsWith('.js'))
            .map(f => path.join(ROOT, 'lib', 'timeline', 'adapters', f)));
    const maps = [];
    for (const file of files) {
        // 只认**空构造**的可变集合：`new Map()` / `new Set()`
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        for (const m of src.matchAll(/const (\w+) = new (Map|Set)\(\)/g)) {
            maps.push(`${path.basename(file)}:${m[1]}`);
        }
    }
    assert.deepEqual(maps.sort(), ['service.js:failures', 'sync.js:inFlight', 'x.js:userIdCache'].sort(),
        `lib/timeline 里的可变集合就是这三只，每只都要有边界或显式清理（实测：${maps.join(', ')}）`);
});

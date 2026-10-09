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
const {
    MAX_EVENTS_PER_SOURCE, MANUAL_SOURCE_ID, SOCIAL_RETENTION_DAYS,
    MAX_TRANSLATIONS_PER_SYNC, PAGE_SIZE_DEFAULT
} = require(path.join(ROOT, 'lib', 'timeline', 'constants.js'));

const OLD_HASH = '$2b$10$oldhashforunittimeline';
const NEW_HASH = '$2b$10$newhashforunittimeline';

/** 去注释后再匹配：注释里的字符串会骗过形状断言（本仓库的老教训）。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function tempDb() {
    const dir = fs.mkdtempSync(path.join(process.env.COMMANDCODE_SCRATCHPAD || os.tmpdir(), 'sylph-timeline-db-'));
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

test('手动保存：同一 URL 是更新而不是新增，且保留首次保存时间', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const service = createService(createRepository(db), {
            getPasswordHash: async () => OLD_HASH, fetchMeta: async () => ({}) });

        const first = await service.saveArticle({ url: 'https://example.com/a', title: '标题一', summary: 's1' });
        const again = await service.saveArticle({ url: 'https://example.com/a', title: '标题二' });
        assert.equal(service.listTimeline({}).events.length, 1, '同一链接只留一条');
        const only = service.listTimeline({}).events[0];
        assert.equal(only.title, '标题二', '再次保存更新标题');
        assert.equal(only.occurredAt, first.occurredAt, '首次保存时间保留（不因再次保存而浮到顶部）');
        assert.equal(only.summary, '', '第二次没给摘要就覆盖为空——这是「更新」的语义');
        assert.equal(again.id, first.id, '返回的是同一条');

        // 不同 URL 是两条
        await service.saveArticle({ url: 'https://example.com/b', title: '另一篇' });
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
        // 保留期以常量为准（30 天）：边界内留、边界外删
        assert.equal(SOCIAL_RETENTION_DAYS, 30, '社交事件保留 30 天');
        const day = 86400000;
        const now = Date.now();
        const outside = now - 200 * day;
        const justOutside = now - 31 * day;
        const justInside = now - 29 * day;
        seedEvents(repo, src.id, [
            socialEvent(1, outside), socialEvent(2, justOutside),
            socialEvent(3, justInside), socialEvent(4, now)
        ]);
        // 手动来源里放一条「很旧」的：它不是社交事件，不该被时限清掉
        repo.upsertManualEvent({
            dedupeKey: 'url:old', occurredAt: outside, title: '很久以前保存的文章',
            summary: '', url: 'https://example.com/old', metadata: {}
        }, now);

        const removed = repo.sweepRetention(now - SOCIAL_RETENTION_DAYS * day);
        assert.equal(removed, 2, '只清掉超出一条（200 天前与 31 天前）');

        const titles = repo.listEvents({}).rows.map(r => r.title);
        assert.ok(titles.includes('post 3'), '保留期内的社交事件保留');
        assert.ok(titles.includes('post 4'), '刚发生的保留');
        assert.ok(!titles.includes('post 2'), '恰好超出 30 天的被清掉');
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

    // 作者名与译文进白名单；头像只接受 X 的图片主机
    assert.deepEqual(
        sanitizeMetadata({ authorName: ' jack ', translation: '中文', authorAvatar: 'https://pbs.twimg.com/a.jpg' }),
        { authorName: 'jack', translation: '中文', authorAvatar: 'https://pbs.twimg.com/a.jpg' },
        '作者名 / 译文 / 头像都保留');
    assert.deepEqual(sanitizeMetadata({ authorAvatar: 'https://evil.example.com/a.jpg' }), {},
        '头像主机不在白名单：整条丢掉（否则会变成浏览器直接请求任意地址）');
    assert.deepEqual(sanitizeMetadata({ authorAvatar: 'http://pbs.twimg.com/a.jpg' }), {},
        '头像只接受 https');
    assert.deepEqual(sanitizeMetadata({ authorAvatar: 'javascript:alert(1)' }), {},
        '非 http(s) 一律拒绝');

    assert.ok(isEventType('social_post') && isEventType('article_saved'));
    assert.ok(!isEventType('unknown_type'), '未知事件类型不认（会被跳过而不是入库）');
    assert.equal(eventTypeLabel('social_post', 'x'), '博主推文', '标签按 provider 细分');
    assert.equal(eventTypeLabel('social_post', 'weibo'), '微博动态');
    assert.equal(eventTypeLabel('weird_type', 'x'), 'weird_type', '未知类型回落原样，不猜');
});

// ========== adapter（fixture） ==========

function fxStatus(id, extra = {}) {
    return { type: 'status', id, text: '标题\n正文', author: { screen_name: 'alice' },
        created_timestamp: 1700000000, ...extra };
}

function fxResponse(results = [], bottom = null, code = 200) {
    return Response.json({ code, results, cursor: { top: null, bottom } });
}

test('FxEmbed normalize 校验作者、精度、原创与时间', () => {
    const row = fxStatus('1799999999999999999');
    const ev = xAdapter.normalize(row, { externalKey: '@alice' });
    assert.equal(ev.providerEventId, row.id);
    assert.equal(ev.author, '@alice');
    assert.equal(ev.occurredAt, 1700000000000);
    assert.equal(ev.url, `https://x.com/alice/status/${row.id}`);
    assert.deepEqual(ev.metadata, {});
    for (const extra of [{ replying_to: {} }, { reposted_by: {} }, { type: 'thread' },
        { author: { screen_name: 'bob' } }, { id: 1799999999999999999 }]) {
        assert.equal(xAdapter.normalize(fxStatus(row.id, extra), { externalKey: 'alice' }), null);
    }
    for (const handle of ['https://x.com/alice', 'id:123', 'a/b', 'a?b', '@@a', 'a'.repeat(16)]) {
        assert.throws(() => xAdapter.normalizeAccount(handle));
    }
});

test('FxEmbed：作者名与头像写进 metadata；译文只对非中文新条目取，且有上限、失败不影响入库', async () => {
    const original = globalThis.fetch;
    const mk = (id, lang, text) => ({
        type: 'status', id, text, lang,
        author: { screen_name: 'alice', name: 'Alice A', avatar_url: 'https://pbs.twimg.com/a.jpg' },
        created_timestamp: 1700000000
    });
    const translationCalls = [];
    globalThis.fetch = async url => {
        const u = String(url);
        if (u.includes('/status/')) {
            const id = u.split('/status/')[1].split('?')[0];
            translationCalls.push(id);
            if (id === '103') throw new Error('network down');   // 单条失败必须只跳过这一条
            return Response.json({
                code: 200, status: { id, translation: { text: '译文' + id, target_lang: 'zh-cn' } }
            });
        }
        return fxResponse([mk('101', 'en', 'hello'), mk('102', 'zh', '你好'), mk('103', 'en', 'world')], null);
    };
    try {
        const { events } = await xAdapter.fetchEvents({ externalKey: 'alice', cursor: null });
        assert.equal(events.length, 3, '三条都入库（译文失败不影响入库）');
        for (const ev of events) {
            assert.equal(ev.metadata.authorName, 'Alice A', '显示名进了 metadata');
            assert.equal(ev.metadata.authorAvatar, 'https://pbs.twimg.com/a.jpg', '头像进了 metadata');
        }
        const byId = Object.fromEntries(events.map(e => [e.providerEventId, e]));
        assert.equal(byId['101'].metadata.translation, '译文101', '英文条目取到译文');
        assert.equal(byId['102'].metadata.translation, undefined, '已是中文的不再取译文');
        assert.equal(byId['103'].metadata.translation, undefined, '取译文失败只跳过这一条');
        assert.deepEqual(translationCalls.sort(), ['101', '103'], '只对非中文条目请求译文');
    } finally {
        globalThis.fetch = original;
    }

    // 上限：一次刷出很多新条目时，译文请求数不超过 MAX_TRANSLATIONS_PER_SYNC
    const many = Array.from({ length: MAX_TRANSLATIONS_PER_SYNC + 8 },
        (_, i) => mk(String(2000 + i), 'en', 'text ' + i));
    const capped = [];
    globalThis.fetch = async url => {
        const u = String(url);
        if (u.includes('/status/')) {
            capped.push(u);
            return Response.json({ code: 200, status: { translation: { text: '中', target_lang: 'zh-cn' } } });
        }
        return fxResponse(many, null);
    };
    try {
        const { events } = await xAdapter.fetchEvents({ externalKey: 'alice', cursor: null });
        assert.equal(events.length, many.length, '全部条目照常入库');
        assert.equal(capped.length, MAX_TRANSLATIONS_PER_SYNC, `译文请求被限制在 ${MAX_TRANSLATIONS_PER_SYNC} 条`);
        const translated = events.filter(e => e.metadata.translation).length;
        assert.equal(translated, MAX_TRANSLATIONS_PER_SYNC, '超出上限的那部分保持原文，不影响入库');
    } finally {
        globalThis.fetch = original;
    }
});

test('恢复备份也要过 metadata 白名单：外部头像地址不能被「改一份备份」带进来', () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    try {
        const repo = createRepository(db);
        const service = createService(repo, {
            getPasswordHash: async () => OLD_HASH, log: { warn() {} }
        });
        const src = repo.createSource({
            providerType: 'x', name: 'X · alice', externalKey: 'alice',
            settings: {}, syncIntervalMs: 300000, nextSyncAt: 0
        });
        const result = service.importTimeline({
            sources: [repo.getSource(src.id)].map(s => ({
                id: s.id, provider_type: s.providerType, name: s.name, external_key: s.externalKey,
                settings_json: '{}', enabled: 1, sync_cursor: null, sync_interval_ms: 300000,
                next_sync_at: 0, last_attempt_at: null, last_success_at: null, last_error: null,
                created_at: 1, updated_at: 1
            })),
            events: [{
                id: 'evt-1', source_id: src.id, event_type: 'social_post', provider_event_id: 'p1',
                dedupe_key: 'p1', occurred_at: Date.now(), ingested_at: Date.now(),
                author: '@alice', title: '标题', summary: '', url: 'https://x.com/alice/status/1',
                metadata_json: JSON.stringify({
                    authorName: 'Alice', translation: '中文',
                    authorAvatar: 'https://evil.example.com/a.jpg', evil: '<script>'
                })
            }],
            eventState: []
        });
        assert.equal(result.events, 1, '事件被恢复');
        const row = repo.listEvents({}).rows[0];
        assert.deepEqual(row.metadata, { authorName: 'Alice', translation: '中文' },
            '非白名单主机与未知键在恢复时被丢掉');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('筛选行 / 头 / 底在卡片里不许被压缩（订阅后列表变长就会触发）', () => {
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));
    const ruleOf = sel => {
        const m = new RegExp(`\\${sel} \\{([\\s\\S]*?)\\n\\}`).exec(css);
        return m ? m[1] : '';
    };
    // 卡片是 flex 纵向 + max-height：这三段默认可收缩，一被压扁筛选行的文字就被上下裁掉
    for (const sel of ['.special-line-filters', '.special-line-head', '.special-line-foot']) {
        const body = ruleOf(sel);
        assert.ok(body, `找得到 ${sel} 的规则`);
        assert.match(body, /flex:\s*0 0 auto/, `${sel} 不许被压缩`);
    }
    // 懒加载哨兵必须在滚动容器内部才有意义——它的高度不能撑出可见空隙
    assert.match(ruleOf('.special-line-sentinel'), /height:\s*1px/, '哨兵是 1px 的占位');
});

test('FxEmbed 每轮从最新页开始，置顶不截断、过滤条目也推进字符串水位', async () => {
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push([String(url), options]);
        if (new URL(url).searchParams.has('cursor')) return fxResponse([fxStatus('102'), fxStatus('100')]);
        return fxResponse([fxStatus('10'), fxStatus('105'), fxStatus('106', { replying_to: {} })], 'next');
    };
    try {
        const result = await xAdapter.fetchEvents({ externalKey: 'alice', cursor: '100' });
        assert.deepEqual(result.events.map(e => e.providerEventId), ['105', '102']);
        assert.equal(result.nextCursor, '106');
        assert.equal(requests.length, 2);
        for (const [url, options] of requests) {
            assert.ok(url.startsWith('https://api.fxtwitter.com/2/profile/alice/statuses?'));
            assert.equal(new URL(url).searchParams.get('count'), '100');
            assert.equal(new URL(url).searchParams.has('since'), false);
            assert.equal(options.redirect, 'error');
            assert.equal(options.headers.authorization, undefined);
        }
        requests.length = 0;
        await xAdapter.fetchEvents({ externalKey: 'alice' });
        assert.equal(requests.length, 1);
    } finally { globalThis.fetch = original; }
});

test('FxEmbed 无 token 连接、空列表与 404 双义、错误 JSON/code/限流/超时', async () => {
    const original = globalThis.fetch;
    try {
        for (const [response, expected] of [
            [() => fxResponse(), true], [() => fxResponse([], null, 404), true],
            [() => new Response('html', { status: 404 }), false],
            [() => Response.json({ code: 404 }), false],
            [() => Response.json({ code: 200, results: null }), false],
            [() => Response.json(null), false], [() => new Response('<html>'), false],
            [() => fxResponse([], null, 500), false],
            [() => new Response('', { status: 429 }), false]
        ]) {
            globalThis.fetch = async url => String(url).includes('/statuses') ? response()
                : Response.json({ code: 200, user: { screen_name: 'alice', protected: false } });
            const result = await xAdapter.testConnection({ externalKey: 'alice' });
            assert.equal(result.ok, expected);
        }
        globalThis.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
        assert.equal((await xAdapter.testConnection({ externalKey: 'alice' })).code, 'timeout');
        globalThis.fetch = async () => Response.json({ code: 200, user: { screen_name: 'alice', protected: true } });
        assert.equal((await xAdapter.testConnection({ externalKey: 'alice' })).ok, false);
    } finally { globalThis.fetch = original; }
});

test('FxEmbed 重复游标、五页上限与中途故障拒绝成功', async () => {
    const original = globalThis.fetch;
    try {
        for (const mode of ['repeat', 'limit', 'failure']) {
            let n = 0;
            globalThis.fetch = async () => {
                n++;
                if (mode === 'failure' && n === 2) throw new Error('offline');
                return fxResponse([fxStatus(String(200 - n))], mode === 'repeat' ? 'same' : `page${n}`);
            };
            await assert.rejects(() => xAdapter.fetchEvents({ externalKey: 'alice', cursor: '100' }));
            assert.ok(n <= 5);
        }
    } finally { globalThis.fetch = original; }
});

test('有界 getJson 流式截停 2MiB、取消正文并保持微博默认解析', async () => {
    const { getJson } = require('../lib/timeline/http');
    const original = globalThis.fetch;
    let cancelled = false;
    let reads = 0;
    globalThis.fetch = async () => new Response(new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; }
    }));
    try {
        await assert.rejects(() => getJson('https://api.fxtwitter.com', { maxBytes: 2 * 1024 * 1024 }), /大小限制/);
        assert.equal(cancelled, true);
        assert.ok(reads <= 4);
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ statuses: [] }) });
        assert.deepEqual(await getJson('https://api.weibo.com'), { statuses: [] });
    } finally { globalThis.fetch = original; }
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
        const service = createService(repo, {
            getPasswordHash: async () => OLD_HASH, fetchMeta: async () => ({}) });
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

test('后台来源区块挂点：平台调用模块的 renderAdminSection 并注入服务包', () => {
    const code = stripComments(appSource);
    // ⚠️ 注入的不再只是 `{ api }`：模块的后台区块还需要写配置、提示、对话框、
    // 重渲染等能力（监控目标整块搬进模块后尤其明显）。契约见 architecture.md。
    assert.match(code, /def\.renderAdminSection\(el, this\.moduleServices\(\)\)/,
        '平台按模块提供的渲染函数挂后台区块，并注入服务包');
    const services = code.slice(code.indexOf('moduleServices() {'), code.indexOf('moduleServices() {') + 1200);
    // ⚠️ 每一项都要**各自**断言：早先写成 `includes(key + ':') || includes('get config')`，
    // 而那段切片里本来就有 `get config()`，于是 || 右边恒真、六项全是空转。
    for (const key of ['api', 'saveConfig', 'reloadConfig', 'toast', 'dialog', 'confirm',
        'notice', 'refreshAdmin', 'refreshHome', 'selfSigned', 'version']) {
        assert.ok(services.includes(key + ':'), `服务包里有 ${key}`);
    }
    assert.ok(services.includes('get config()'), 'config 是取值器（不是快照）');
    assert.match(code, /data-module-admin="\$\{this\.esc\(def\.id\)\}"/, '区块容器带模块 id');
    assert.match(moduleSource, /function renderAdminSection\(host, state\)/,
        '模块实现该渲染函数');
    assert.match(moduleSource, /renderAdminSection\b[\s\S]*registerModule|registerModule[\s\S]*renderAdminSection/,
        '并把它登记进模块定义');
});

test('后台来源表单与行：X 只填用户名与周期，微博才要求 Access Token（执行真实渲染函数）', () => {
    const code = stripComments(moduleSource);
    const providers = [
        { id: 'x', label: 'X', accountLabel: '账号名（不含 @）', credentialLabel: null,
            requiresCredentials: false, defaultSyncIntervalMs: 300000,
            syncIntervalsMs: [60000, 300000, 900000, 1800000, 3600000] },
        { id: 'weibo', label: '微博', accountLabel: '微博昵称', credentialLabel: 'Access Token',
            requiresCredentials: true, defaultSyncIntervalMs: 300000,
            syncIntervalsMs: [300000, 900000, 1800000, 3600000] }
    ];
    const providerFor = id => providers.find(p => p.id === id);
    const esc = value => String(value === null || value === undefined ? '' : value);
    const submitSrc = extractFunction(code, 'function submitText() {');
    const makeFormHTML = new Function('providers', 'providerFor', 'esc', 'submitText',
        'form', `return (${extractFunction(code, 'function formHTML() {')});`);
    const renderForm = form => makeFormHTML(providers, providerFor, esc,
        new Function('form', `return (${submitSrc});`)(form), form)();

    const xHtml = renderForm({ mode: 'add', providerType: 'x', externalKey: '', syncIntervalMs: 300000 });
    assert.doesNotMatch(xHtml, /name="token"/, 'X 表单不出现凭据输入框');
    assert.doesNotMatch(xHtml, /Access Token/, 'X 表单不出现凭据标签');
    assert.match(xHtml, /name="syncIntervalMs"/, 'X 表单有监控周期');
    assert.match(xHtml, /value="60000"/, 'X 支持 1 分钟档');
    assert.match(xHtml, /保存并测试/, '新增态按钮文案');

    const weiboHtml = renderForm({ mode: 'add', providerType: 'weibo', externalKey: 'someone', syncIntervalMs: 900000 });
    assert.match(weiboHtml, /name="token"/, '微博表单保留 Access Token 输入');
    assert.match(weiboHtml, /name="syncIntervalMs"[\s\S]*value="900000" selected/,
        '微博表单回显周期');
    assert.doesNotMatch(weiboHtml, /value="60000"/, '微博不提供 1 分钟档');

    const bumped = renderForm({ mode: 'add', providerType: 'weibo', externalKey: '', syncIntervalMs: 60000 });
    assert.doesNotMatch(bumped, /value="60000"/, '微博不接受 1 分钟档，回落到合法默认值');
    assert.match(bumped, /value="300000" selected/, '回落值即默认周期');

    const editHtml = renderForm({ mode: 'edit', id: 's1', providerType: 'x', externalKey: 'jack', syncIntervalMs: 900000 });
    assert.match(editHtml, /name="externalKey"[\s\S]*readonly/, '编辑态账号只读');
    assert.match(editHtml, /保存配置/, '编辑态按钮文案');

    const makeRowHTML = new Function('providerFor', 'esc', 'relTime', 'STATUS_TEXT',
        `return (${extractFunction(code, 'function rowHTML(s) {')});`);
    const row = makeRowHTML(providerFor, esc, () => '刚刚', { ok: '已连接', paused: '已暂停' })(
        { id: '1', providerType: 'x', providerLabel: 'X', providerSymbol: 'X', externalKey: 'jack',
            enabled: false, hasCredentials: false, status: 'paused', syncIntervalMs: 900000 });
    assert.match(row, /每 15 分钟 · 自动监控已停止/, '行显示周期与自动监控状态');
    assert.match(row, /data-act="toggle"[^>]*>启用监控</, '停止态给「启用监控」');
    assert.doesNotMatch(row, /未配置凭据/, 'X 没有凭据概念，不显示未配置');
    assert.doesNotMatch(row, /重新授权/, 'X 不出现重新授权');
});

test('打开菜单的整行由 JS 加类抬升，不用 :has()（不支持 :has() 的浏览器里菜单会被下一张卡盖住）', () => {
    const code = stripComments(moduleSource);
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));

    // ① 跑**真实的** adjustMenu（DOM 用桩）：按 details.open 加/摘 is-menu-open，
    //    并保留「超出容器底边就翻上去」的旧行为。
    //    这条机制此前写成 CSS 的 :has()，而不支持它的浏览器会整条忽略该规则，
    //    于是短条目（手动保存的文章）的菜单被下一张事件卡盖住——
    //    用户报的「被 specialline 模块本身遮挡」正是这个，真机复现过。
    // 每一处 getBoundingClientRect 依次取一个预置值（取完则复用最后一个），
    // 这样能分别模拟「朝下量」「上翻后量」两次测量。
    const makeDom = ({ open, menuRects, wrapTop = 100, wrapBottom = 500, detailsTop = 90 }) => {
        const state = { toggles: [], classes: [], style: {} };
        state.item = {
            set: new Set(),
            classList: {
                toggle: (name, on) => {
                    state.toggles.push([name, on]);
                    if (on) state.item.set.add(name); else state.item.set.delete(name);
                }
            }
        };
        const queue = menuRects.slice();
        const menu = {
            style: state.style,
            getBoundingClientRect: () => (queue.length > 1 ? queue.shift() : queue[0])
        };
        state.details = {
            open,
            classList: {
                add: c => state.classes.push(['add', c]),
                remove: c => state.classes.push(['remove', c])
            },
            closest: sel => (sel === '.special-line-item' ? state.item : null),
            querySelector: sel => (sel === '.special-line-actions' ? menu : null),
            getBoundingClientRect: () => ({ top: detailsTop })
        };
        state.listEl = { getBoundingClientRect: () => ({ top: wrapTop, bottom: wrapBottom }) };
        return state;
    };
    // adjustMenu 引用模块级的 MENU_EDGE，抽出来执行时必须把它一起注入——
    // 否则桩里 ReferenceError，守卫会「因为抛错」而不是「因为断言」变红（假红）。
    const edge = Number(/const MENU_EDGE = (\d+);/.exec(code)?.[1]);
    assert.ok(Number.isFinite(edge), '能从源码读出 MENU_EDGE');
    const run = state => new Function('listEl', 'MENU_EDGE',
        `${extractFunction(code, 'function hideMenuPopover(menu)')}
         ${extractFunction(code, 'function adjustMenu(details)')}; return adjustMenu;`)(state.listEl, edge)(state.details);

    const opened = makeDom({ open: true, menuRects: [{ top: 110, bottom: 180, height: 70 }] });
    run(opened);
    assert.deepEqual(opened.toggles, [['is-menu-open', true]], '打开时给所在行加上抬升类');
    assert.deepEqual(opened.classes.filter(c => c[0] === 'add'), [], '放得下时不翻上去');
    assert.equal(opened.style.top, '', '放得下时不做夹取');

    const closed = makeDom({ open: false, menuRects: [{ top: 110, bottom: 180, height: 70 }] });
    run(closed);
    assert.deepEqual(closed.toggles, [['is-menu-open', false]], '关闭时把抬升类摘掉');

    const overflow = makeDom({ open: true,
        menuRects: [{ top: 430, bottom: 500, height: 70 }, { top: 300, bottom: 370, height: 70 }] });
    run(overflow);
    assert.deepEqual(overflow.classes.filter(c => c[0] === 'add'), [['add', 'is-up']],
        '超出容器底边时仍然翻上去（滚动容器会裁掉朝下的菜单）');
    assert.equal(overflow.style.top, '', '上翻后放得下就不夹取');

    // ⭐ 用户报的形态：列表很矮时上翻也越出**顶边**，被滚动容器裁掉，
    //    而那条带正是「全部/未读/已归档」那行所在处（实测视口 1280×400）。
    //    这里模拟：容器 100..200，上翻后菜单 60..130 → 顶边越界，应被夹回容器内。
    const clamped = makeDom({ open: true, wrapTop: 100, wrapBottom: 200, detailsTop: 90,
        menuRects: [{ top: 140, bottom: 210, height: 70 }, { top: 60, bottom: 130, height: 70 }] });
    run(clamped);
    assert.equal(clamped.style.top, '14px',
        '上翻仍越出顶边时夹回容器内（容器顶 100+4=104，相对 details 顶 90 得 14px）');
    assert.equal(clamped.style.bottom, 'auto', '夹取时显式取消 bottom，避免 top/bottom 同时生效');

    // ② CSS 只消费这个类；菜单本身仍要压在卡片内容之上
    const rule = /\.special-line-item\.is-menu-open\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, '有 .special-line-item.is-menu-open 规则');
    assert.ok(Number(/z-index:\s*(\d+)/.exec(rule[1])?.[1]) > 0, '抬升到高于普通行的层级');
    const actions = /\.special-line-actions\s*\{([^}]*)\}/.exec(css);
    assert.ok(actions, '菜单容器 .special-line-actions 规则存在');
    assert.match(actions[1], /z-index:\s*3/, '菜单本身仍在卡片内容之上');

    // ③ 收起别的菜单时也要摘掉它们所在行的类。这一段同样**执行**（不只比源码）：
    //    closeMenus 是另一条关菜单的路径（切筛选、点开另一个菜单都走它），
    //    漏摘会让那一行一直停在 z-index:2。
    const mkRow = () => {
        const item = { set: new Set(['is-menu-open']),
            classList: { remove: name => item.set.delete(name) } };
        const style = { top: '14px', bottom: 'auto' };   // 假定上一轮留下了夹取
        const details = {
            open: true,
            closest: sel => (sel === '.special-line-item' ? item : null),
            querySelector: sel => (sel === '.special-line-actions' ? { style } : null)
        };
        return { item, style, details };
    };
    const rowA = mkRow();
    const rowB = mkRow();
    const listStub = { querySelectorAll: () => [rowA.details, rowB.details] };
    new Function('listEl',
        `${extractFunction(code, 'function hideMenuPopover(menu)')}
         ${extractFunction(code, 'function closeMenus(except)')}; return closeMenus;`)(listStub)(rowB.details);
    assert.equal(rowA.details.open, false, '别的菜单被收起');
    assert.equal(rowA.item.set.has('is-menu-open'), false, '收起的那一行摘掉了抬升类');
    assert.equal(rowA.style.top, '', '收起时也清掉夹取的 inline 定位');
    assert.equal(rowB.details.open, true, '被点的那一个不动');
    assert.equal(rowB.item.set.has('is-menu-open'), true, '被点的那一行保留抬升类');

    // ④ 不得退回 :has()：那是「只在支持的浏览器里成立」的机制，正是回归的来源。
    assert.doesNotMatch(css, /\.special-line-item:has\(/, '不用 :has()（老浏览器整条忽略）');
});

test('支持 popover 时菜单进 top layer：打开 showPopover、关闭 hidePopover', () => {
    const code = stripComments(moduleSource);
    const calls = [];
    const menu = {
        style: {},
        matches: () => true,
        showPopover: () => calls.push('show'),
        hidePopover: () => calls.push('hide'),
        getBoundingClientRect: () => ({ top: 130, bottom: 200, left: 100, right: 200, width: 100, height: 70 })
    };
    const details = {
        open: true,
        classList: { add: () => {}, remove: () => {} },
        closest: () => ({ classList: { toggle: () => {} } }),
        querySelector: () => menu,
        getBoundingClientRect: () => ({ top: 100, bottom: 120, right: 300 })
    };
    const listEl = { getBoundingClientRect: () => ({ top: 0, bottom: 500 }) };
    const win = { innerHeight: 800, innerWidth: 1200 };
    const run = d => new Function('listEl', 'MENU_EDGE', 'window',
        `${extractFunction(code, 'function hideMenuPopover(menu)')}
         ${extractFunction(code, 'function adjustMenu(details)')}; return adjustMenu;`)(listEl, 4, win)(d);

    run(details);
    assert.deepEqual(calls, ['show'], '打开时把菜单放进 top layer（任何祖先的 overflow 都裁不到）');
    details.open = false;
    run(details);
    assert.deepEqual(calls, ['show', 'hide'], '关闭时收起 popover');
});

test('外部点击与 Esc 关闭菜单：执行真实的文档级处理器', () => {
    const code = stripComments(moduleSource);
    const calls = [];
    const mkList = () => ({
        querySelector: () => ({ open: true }),          // 有一个开着的菜单
        closest: () => null
    });
    const run = (name, listEl) => new Function('listEl', 'closeMenus',
        `${extractFunction(code, `function ${name}(event)`)}; return ${name};`)(listEl, () => calls.push(name));

    // 点在菜单/按钮内部不关；点空白处关
    run('onDocPointerDown', mkList())({ target: { closest: sel => (sel === '.special-line-tools' ? {} : null) } });
    assert.deepEqual(calls, [], '点在 ⋯ 或菜单里不关闭');
    run('onDocPointerDown', mkList())({ target: { closest: () => null } });
    assert.deepEqual(calls, ['onDocPointerDown'], '点空白处关闭（用户报的「点击空白处也不会消失」）');

    calls.length = 0;
    run('onDocKeyDown', mkList())({ key: 'a' });
    assert.deepEqual(calls, [], '其它按键不关闭');
    run('onDocKeyDown', mkList())({ key: 'Escape' });
    assert.deepEqual(calls, ['onDocKeyDown'], 'Esc 关闭');

    // 接线：mountWidget 里真的挂上了这两个处理器（执行级断言之外的「有没有接上」）
    assert.match(code, /document\.addEventListener\('pointerdown', onDocPointerDown, true\)/, '挂了外部点击');
    assert.match(code, /document\.addEventListener\('keydown', onDocKeyDown\)/, '挂了 Esc');
});

test('筛选不先清空事件，进行中的筛选只补拉最后一次选择', async () => {
    const code = stripComments(moduleSource);
    const signature = code.indexOf('async function refresh(');
    assert.ok(signature >= 0, 'refresh 函数定义存在');
    // 参数包含解构对象与默认值；不能从签名里的第一个 `{` 开始配对，
    // 要从 `) {` 的方法体开括号开始（正是测试工具里反复踩过的括号边界）。
    const open = code.indexOf(') {', signature) + 2;
    assert.ok(open > signature, 'refresh 函数体开括号存在');
    let depth = 0, end = -1;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    assert.ok(end > open, 'refresh 函数体括号配对成功');
    const body = code.slice(signature, end);
    const apply = extractFunction(code, 'function applyPayload(data)');
    const resolvers = [];
    const rejectors = [];
    const requested = [];
    const initial = [{ id: 'manual-old-1' }, { id: 'manual-old-2' }];
    const refresh = new Function('initial', 'api', `
        const PAGE_SIZE = 20;
        const URLSearchParams = globalThis.URLSearchParams;
        let events = initial.slice(), sources = [], unreadCount = events.length;
        let nextCursor = 'old-cursor', hasMore = true, syncFailed = [], lastSync = null;
        let syncState = 'synced', listError = null, busy = false;
        let filterSource = 'manual', filterView = 'unread', inFlight = false;
        let appliedFilterSource = 'manual', appliedFilterView = 'unread';
        let filterTransition = false, filterRefreshPending = false;
        let lastKey = '', lastChipsKey = '', pollMs = 15000, pollTimer = null;
        const renderChips = () => {};
        const render = () => {};
        const console = { error() {} };
        ${apply}
        ${body}
        return {
            refresh,
            setFilter(source, view) { filterSource = source; filterView = view; },
            get events() { return events; },
            get pending() { return filterRefreshPending; },
            get transition() { return filterTransition; },
            get filters() { return [filterSource, filterView]; },
            get appliedFilters() { return [appliedFilterSource, appliedFilterView]; },
            get error() { return listError; },
            get cursor() { return nextCursor; }
        };
    `)(initial, { get: url => { requested.push(url); return new Promise((resolve, reject) => { resolvers.push(resolve); rejectors.push(reject); }); } });

    const first = refresh.refresh();
    await Promise.resolve();
    assert.deepEqual(refresh.events.map(e => e.id), ['manual-old-1', 'manual-old-2'],
        '筛选请求等待时不先清空旧数据');
    assert.match(requested[0], /source=manual/);
    assert.match(requested[0], /view=unread/);

    refresh.setFilter('source-x', 'all');
    await refresh.refresh({ filterChange: true });
    assert.equal(refresh.pending, true, '普通轮询在途时切筛选会排入最后条件');
    assert.equal(refresh.transition, true, '即便原请求不是筛选请求，也立即显示切换过渡态');
    assert.equal(requested.length, 1, '不并发重复打相同列表请求');
    assert.equal(refresh.cursor, 'old-cursor', '切换筛选时暂留原分页游标，失败可回到原结果继续翻页');

    resolvers[0]({ events: [{ id: 'stale-filter-response' }], unreadCount: 1, sources: [], sync: { failed: [] },
        nextCursor: null, hasMore: false, pollInterval: 15 });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requested.length, 2, '上一请求结束后自动补拉一次');
    assert.match(requested[1], /source=source-x/, '补拉使用最后选择的来源');
    assert.match(requested[1], /view=all/, '补拉使用最后选择的状态');
    assert.equal(refresh.transition, true, '中间过期结果不结束过渡态');

    resolvers[1]({ events: [{ id: 'latest-filter-result' }], unreadCount: 1, sources: [], sync: { failed: [] },
        nextCursor: 'latest-cursor', hasMore: true, pollInterval: 15 });
    await first;
    assert.deepEqual(refresh.events.map(e => e.id), ['latest-filter-result'], '最终采用最后筛选的响应');
    assert.equal(refresh.transition, false, '最终结果到达后清除过渡态');
    assert.deepEqual(refresh.appliedFilters, ['source-x', 'all'], '成功结果记录与内容匹配的筛选');
    refresh.setFilter('manual', 'unread');
    const failed = refresh.refresh({ filterChange: true });
    await Promise.resolve();
    rejectors[2](Object.assign(new Error('offline'), { status: 503 }));
    await failed;
    assert.deepEqual(refresh.filters, ['source-x', 'all'], '读取失败时恢复上一组已成功筛选');
    assert.deepEqual(refresh.appliedFilters, ['source-x', 'all']);
    assert.equal(refresh.cursor, 'latest-cursor', '失败时保留上一组结果的翻页游标');
    assert.ok(refresh.error, '失败状态可见');
    assert.equal(refresh.transition, false, '失败后结束过渡状态');
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));
    assert.match(css, /\.special-line-listwrap\.is-filtering \.special-line-list\s*\{[^}]*opacity:\s*\.42/,
        '过渡态降低旧结果的视觉权重');
    assert.match(css, /\.special-line-filtering\s*\{[^}]*pointer-events:\s*none/,
        '切换提示不拦截列表或筛选操作');

    const filterCases = [
        ["case 'filter-source':", "case 'filter-view':"],
        ["case 'filter-view':", "case 'reset-filters':"],
        ["case 'reset-filters':", "case 'read':"]
    ];
    for (const [start, end] of filterCases) {
        const from = code.indexOf(start);
        const to = code.indexOf(end, from + start.length);
        assert.ok(from >= 0 && to > from, `${start} / ${end} 分支边界存在`);
        const branch = code.slice(from, to);
        assert.match(branch, /refresh\(\{ filterChange: true \}\)/, `${start} 用筛选过渡请求`);
        assert.doesNotMatch(branch, /events\s*=\s*\[\]/, `${start} 不先清空事件造成闪空`);
    }
    assert.match(body, /if \(inFlight\) \{[\s\S]*?filterRefreshPending = true/,
        '切换请求进行中时记住新的筛选，当前请求结束后再拉最后一次');
    const renderBody = extractFunction(code, 'function render()');
    const transitionAt = renderBody.indexOf('if (filterTransition && listEl.querySelector(\'.special-line-list\'))');
    const replaceAt = renderBody.indexOf('listEl.innerHTML =');
    assert.ok(transitionAt > 0 && replaceAt > transitionAt,
        '筛选过渡分支必须在列表 innerHTML 重建之前');
    assert.match(renderBody.slice(transitionAt, replaceAt),
        /classList\.add\('is-filtering'\)[\s\S]*?setAttribute\('aria-busy', 'true'\)[\s\S]*?return;/,
        '过渡分支保留现有列表 DOM，只标记繁忙态后返回');
    assert.match(renderBody.slice(transitionAt, replaceAt), /正在切换…/,
        '过渡期间显示明确的切换状态');
});

test('时间线内联在首页那一列里：没有弹窗，形态与仿真一致（轨道 / 事件卡 / ⋯ / chips）', () => {
    const code = stripComments(moduleSource);

    // ① 不再有弹窗面板（用户的明确要求：「不是单独弹出一个框再显示」）
    assert.doesNotMatch(code, /module-overlay/, '不得再建遮罩层');
    assert.doesNotMatch(code, /module-panel/, '不得再建弹窗面板');
    assert.doesNotMatch(code, /openPanel/, '不得再实现 / 注册 openPanel');

    // ② 卡片本身就是时间线：四段都挂在 card 上
    assert.match(code, /card\.append\(head, chipsEl, listEl, footEl\)/, '头 / 筛选 / 列表 / 底部都在卡片里');

    // ③ 形态对齐仿真：日期轨道（time）+ 事件卡（article）+ chips 筛选 + 「⋯」菜单
    assert.match(code, /<time class="special-line-time">/, '左侧日期轨道');
    assert.match(code, /<article class="special-line-event">/, '事件卡');
    assert.match(code, /class="special-line-mark"/, '来源标记');
    // chips 的 data-action 由调用处的 kind 决定，所以钉调用处而不是拼出来的字面量
    assert.match(code, /data-action="\$\{kind\}"/, 'chips 的动作类型由调用处传入');
    assert.match(code, /chip\('', '全部来源', 'filter-source'\)/, '来源 chips（含「全部来源」）');
    assert.match(code, /chip\('manual', '稍后阅读', 'filter-source'\)/, '「稍后阅读」是固定入口');
    assert.match(code, /chip\('all', '全部', 'filter-view'\)/, '状态 chips');
    assert.match(code, /<details class="special-line-tools">/, '「⋯」菜单（与仿真同款）');
    assert.match(code, /<div class="special-line-actions"[^>]*popover="manual"/,
        '菜单里是操作列表，且是 top-layer 的 popover（不被滚动容器裁）');
    assert.match(code, /data-action="read"/, '标为已读 / 未读');
    assert.match(code, /data-action="archive"/, '归档 / 取消归档');

    // ④ 「⋯」菜单会被滚动容器裁掉，所以要有量一次、必要时往上弹的处理
    assert.match(code, /function adjustMenu\(details\)/, '有翻转逻辑');
    assert.match(code, /classList\.add\('is-up'\)/, '超出底边时往上弹');
    assert.match(code, /closeMenus\(/, '打开一个菜单时先收起别的');
});

test('宽栏分配：随可用宽度单调变化，左列不再被压到 132（真跑 railLayoutFor）', () => {
    const app = stripComments(appSource);
    const body = extractFunction(app, 'railLayoutFor(content) {');
    const layoutFor = new Function(`return ({ ${body} }).railLayoutFor;`)();

    // ⚠️ 这条断言直接对应用户报的那个现象：「缩窄一点窗口后，该模块宽度反而变大」。
    // 旧实现是写死的 CSS calc + 一个阈值，窗口缩 1px 会让时间线从 420 掉到 132、
    // 再缩一点又跳到 190。新实现是连续的：content 变大时三列都不缩小。
    let prev = null;
    let seen = 0;
    for (let content = 900; content <= 1700; content += 1) {
        const layout = layoutFor(content);
        if (!layout) { prev = null; continue; }
        seen++;
        if (prev) {
            assert.ok(layout.rail >= prev.rail, `${content}: 时间线不得随可用宽度增加而变窄（${prev.rail} → ${layout.rail}）`);
            assert.ok(layout.side >= prev.side, `${content}: 左列不得变窄`);
            assert.ok(layout.board >= prev.board, `${content}: 背板不得变窄`);
        }
        assert.ok(layout.side >= 180, `${content}: 左列不低于 180（132px 实测监控卡排版错乱）`);
        assert.ok(layout.rail >= 400, `${content}: 时间线不低于 400（不然仿真那套版式立不住）`);
        assert.ok(layout.board >= 600, `${content}: 背板不低于 600`);
        assert.ok(layout.side + layout.board + layout.rail + 40 <= content + 1,
            `${content}: 三列 + 两个间距不得超过可用宽度（${layout.side}+${layout.board}+${layout.rail}）`);
        prev = layout;
    }
    assert.ok(seen > 100, `大部分宽度档都应进入宽栏模式（实测 ${seen}/801）`);

    // 常见桌面宽度：时间线拿满、左列不被压
    const wide = layoutFor(1396);   // 1440 视口（#app 上限 1440，内容宽 = 1440 - 44）
    assert.ok(wide && wide.rail >= 400 && wide.side >= 180,
        `1440 视口下应进宽栏且两列都够：${JSON.stringify(wide)}`);
    // 放不下就返回 null——调用方退回普通布局，模块按容器宽度降级成窄版
    assert.equal(layoutFor(900), null, '放不下时不硬塞');
    // ⚠️ 阈值必须正好落在「三个下限 + 两个间距」上，不能更高。高出的那一段里
    // 时间线会退化成普通布局那个很窄的值（旧版就是 132px「内容显示不全」）。
    // 上半段只检查了非 null 档之间的单调性，单独加「阈值偏高」这个变异是不会红的。
    const need = 180 + 2 * 20 + 600 + 400;
    assert.equal(layoutFor(need - 1), null, `${need - 1} 还放不下`);
    assert.ok(layoutFor(need), `${need}（左列下限 + 两间距 + 背板下限 + 时间线下限）必须已经能进宽栏`);
    // 阈值附近不能有悬崖：进宽栏的第一档，时间线就已经 ≥400
    let firstWide = null;
    for (let c = 900; c <= 1700; c += 1) {
        const l = layoutFor(c);
        if (l) { firstWide = { c, l }; break; }
    }
    assert.ok(firstWide, '存在进入宽栏模式的宽度档');
    assert.ok(firstWide.l.rail >= 400,
        `进宽栏的第一档（content ${firstWide.c}）时间线就有 ${firstWide.l.rail}px（不得先给一个很窄的值）`);
});

test('首屏宽栏判定：模块定义必须在 syncRail 之前注册（真跑 renderModuleZone）', async () => {
    // 用户报的现象：「首页初次加载时该模块依然显示不全，需要手动缩窄再变宽才正常」。
    // 根因是顺序：宽栏判定读模块定义里的 wideRail，而定义由模块脚本执行时才注册，
    // 脚本又只有 mountModule 会加载——而 syncRail 排在 mountModule 前面，于是首屏
    // 第一次判定永远读到 undefined，时间线按普通窄卡出生；resize 触发第二次判定时
    // 定义已注册，才变宽。所以这条用例**执行** renderModuleZone，并断言 syncRail
    // 被调用那一刻定义已经存在——只断言「有 preloadModuleDefs」会漏掉顺序本身。
    const body = extractFunction(stripComments(appSource), 'async renderModuleZone() {');
    const defs = new Map();
    const seen = [];
    const fakeZone = () => ({
        hidden: true, dataset: {}, offsetHeight: 0,
        classList: { add() {}, remove() {} },
        replaceChildren() {}, appendChild() {}, querySelector: () => null
    });
    const loadModuleCalls = [];
    const ctx = {
        authenticated: true,
        modulesConfig: { enabledModules: ['special-line'], widgets: [] },
        modulesError: null,
        loadModulesConfig: async () => {},
        enabledModuleIds: () => ['special-line'],
        // 平台侧：脚本加载 = 定义注册（真实的注册就发生在脚本执行时）
        loadModule: async id => { loadModuleCalls.push(id); defs.set(id, { id, wideRail: true }); },
        getModule: id => defs.get(id),
        // 真实实现读 getModule，这里记下「判定那一刻定义在不在」
        wantsWideRail() { return [...defs.values()].some(d => d.wideRail === true); },
        syncRail() { seen.push({ at: 'syncRail', defRegistered: !!this.getModule('special-line') }); return true; },
        sideDockAvailable: () => true,
        mountModule: async () => fakeZone(),
        waitFirstRound: async () => {},
        applyWidgetLayout() {},
        playModuleEntrance() {}
    };
    // preloadModuleDefs 用**真实实现**（切出来接上），不能在测试里重写一遍——
    // 那样测的就是测试自己的逻辑，「先加载定义」这件事根本没被验证。
    const preloadBody = extractFunction(stripComments(appSource), 'async preloadModuleDefs(ids) {');
    ctx.preloadModuleDefs = new Function(`return ({ ${preloadBody} }).preloadModuleDefs;`)();
    // 方法体的两个自由名是 `$` 与 `document`（其余都挂在 this 上），一并注入。
    const method = new Function('$', 'document', `return ({ ${body} }).renderModuleZone;`)(
        () => fakeZone(), { createElement: fakeZone, head: { appendChild() {} } });
    await method.call(ctx);

    assert.deepEqual(loadModuleCalls, ['special-line'], '先加载了启用模块的脚本');
    assert.equal(seen.length, 1, 'syncRail 恰好被调用一次');
    assert.equal(seen[0].defRegistered, true,
        'syncRail 执行时模块定义必须已注册——否则首屏判定读不到 wideRail，时间线按窄卡出生');
    // 源码顺序是同一件事的第二道钉（行为断言已经覆盖它，这里只是让它更难被改回去）。
    // ⚠️ 只在**登录后那条路径**的窗口里比：整段方法体里 `this.syncRail()` 还出现在
    // 未登录分支（那处在 preload 之前），按首个匹配去比会得到相反的结论。
    const src = stripComments(appSource);
    const from = src.indexOf('if (!this.modulesConfig) await this.loadModulesConfig();');
    const to = src.indexOf('const sideDock = this.sideDockAvailable();');
    assert.ok(from > 0 && to > from, '切出登录后的那段路径');
    const path = src.slice(from, to);
    assert.ok(path.includes('this.preloadModuleDefs(ids)') && path.includes('this.syncRail()'),
        '这段路径里同时有 preload 与 syncRail');
    assert.ok(path.indexOf('this.preloadModuleDefs(ids)') < path.indexOf('this.syncRail()'),
        'preloadModuleDefs 必须排在 syncRail 之前');
});

test('平台宽栏机制：三列宽度由 JS 算出写进 #app 的变量，且让位发生在判停靠之前', () => {
    const app = stripComments(appSource);
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    // 模块声明它要一条宽列
    assert.match(stripComments(moduleSource), /wideRail: true/, '模块声明 wideRail');

    // 平台侧：判定 + 应用 + 顺序
    assert.match(app, /wantsWideRail\(\) \{/, '只看已启用且声明了 wideRail 的模块');
    assert.match(app, /railLayoutFor\(content\) \{/, '三列宽度由纯函数算');
    assert.match(app, /syncRail\(\) \{[\s\S]*?dataset\.rail = layout \? 'wide' : 'narrow'/, '把结论写到 #app');
    // 宽度写进 CSS 变量 → CSS 只消费、不再自己算（旧版写死 calc，出过阈值悬崖）
    for (const v of ['--rail-w', '--side-w', '--board-max']) {
        assert.ok(app.includes(`'${v}':`), `syncRail 的变量表里有 ${v}`);
        assert.ok(css.includes(`var(${v}`), `CSS 消费 ${v}`);
    }
    assert.match(app, /syncRail\(\) \{[\s\S]{0,700}?setProperty\(key,/, '变量由同一个循环写出');
    assert.match(app, /syncRail\(\) \{[\s\S]{0,700}?removeProperty\(key\)/, '不进宽栏时清掉');
    // ⚠️ 顺序：sideDockAvailable 读的是背板**实际**宽度，让位必须先发生。
    // ⚠️ 只在**登录后那条路径**里比：整段方法体里 `this.syncRail()` 还出现在未登录
    // 分支（那是第一处匹配），按首个匹配去比会恒真——把登录路径里的 syncRail 挪到
    // sideDockAvailable 之后，这条断言照样绿（实测）。两端都要有锚点。
    const from = app.indexOf('if (!this.modulesConfig) await this.loadModulesConfig();');
    const dockLine = 'const sideDock = this.sideDockAvailable();';
    const to = app.indexOf(dockLine) + dockLine.length;   // 含这一行，否则那个调用被切在外面
    assert.ok(from > 0 && to > from, '切出登录后的那段路径');
    const loginPath = app.slice(from, to);
    assert.ok(loginPath.includes('this.syncRail()') && loginPath.includes('this.sideDockAvailable()'),
        '这段路径里同时有 syncRail 与 sideDockAvailable');
    assert.ok(loginPath.indexOf('this.syncRail()') < loginPath.indexOf('this.sideDockAvailable()'),
        'syncRail 必须排在 sideDockAvailable 之前');
    // 未登录不该让背板一直窄着。复位走 syncRail 这一条路径（它自己判未登录、
    // 并清掉宽度变量），而不是在登出分支里手写第二份 'narrow'。
    assert.match(app, /if \(!this\.authenticated\) \{[\s\S]{0,260}?this\.syncRail\(\);/, '登出时走 syncRail 复位');
    assert.match(app, /const layout = \(this\.authenticated && this\.wantsWideRail\(\)\)/, '未登录一律不进宽栏');
    assert.match(app, /else app\.style\.removeProperty\(key\);/, '不进宽栏时清掉宽度变量，不留残留状态');

    // CSS 侧：背板让位 + 两列都用变量
    const board = /#app\[data-rail="wide"\] \.backboard \{([\s\S]*?)\n\}/.exec(css);
    assert.ok(board, '宽栏下背板有自己的规则');
    assert.match(board[1], /max-width: var\(--board-max/, '背板宽度取变量');
    // ⚠️ 必须改掉默认的居中：否则背板右半边会被时间线那一列压住（实测压 124px）
    // 而且左边要把**列间距**一起算进去（`--side-w + 20px`）：只写 --side-w 时
    // 左列与背板贴在一起，左右两处间距不对称（左边 0、右边 40）。
    assert.match(board[1], /margin-left: calc\(var\(--side-w[^)]*\) \+ 20px\)/,
        '背板靠左排，左边留出左侧那一列 + 一个列间距');
    assert.match(board[1], /margin-right: auto/, '右侧不再居中');
    assert.match(css, /#app\[data-rail="wide"\] \.module-widget\[data-side="right"\] \{ width: var\(--rail-w/,
        '右侧那一列取 --rail-w');
    assert.match(css, /#app\[data-rail="wide"\] \.module-widget\[data-side="left"\] \{ width: var\(--side-w/,
        '左侧那一列取 --side-w');
});

test('窄屏（below 停靠）纵向堆叠，不再左右横滑', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    const inner = /\.module-zone\[data-dock="below"\] \.module-zone-inner \{([^}]*)\}/.exec(css);
    assert.ok(inner, '切出 below 的 inner 规则');
    assert.match(inner[1], /display: grid/, '纵向堆叠（grid 单列）');
    assert.doesNotMatch(inner[1], /overflow-x: auto/, '不再是横向滑条');
    assert.doesNotMatch(inner[1], /scroll-snap-type/, '横滑的 snap 与淡出遮罩一并去掉');
    const widget = /\.module-zone\[data-dock="below"\] \.module-widget \{([^}]*)\}/.exec(css);
    assert.ok(widget, '切出 below 的卡片规则');
    assert.match(widget[1], /width: min\(100%, \d+px\)/, '每张卡拿到整行宽度（封顶并居中）');
    assert.doesNotMatch(widget[1], /width: 190px/, '不再固定 190px 的横滑卡');

    // ⚠️ 封顶值必须**等于宽栏的 RAIL_MIN**：两边相等时跨过边界只有位置变化
    // （右侧那一列 ↔ 导航下方），宽度是连续的。先前封顶 560，于是窗口缩到
    // 1263px 时模块从 400 跳到 560——正是用户报的「缩窄窗口后模块反而变宽」。
    const railMin = Number(/const RAIL_MIN = (\d+)/.exec(stripComments(appSource))?.[1]);
    const cap = Number(/width: min\(100%, (\d+)px\)/.exec(widget[1])?.[1]);
    assert.ok(Number.isFinite(railMin), '解析出 railLayoutFor 的 RAIL_MIN');
    assert.equal(cap, railMin, `窄屏卡片封顶（${cap}）必须等于宽栏下限（${railMin}），否则跨界时宽度会跳`);
    // 媒体块里那份重复声明也要同一个值（两处说法不一 = 死代码）
    const mediaCap = [...css.matchAll(/\.module-widget\[data-side\] \{ position: static; width: min\(100%, (\d+)px\)/g)];
    assert.ok(mediaCap.length >= 1, '媒体块里有窄屏卡片规则');
    for (const m of mediaCap) assert.equal(Number(m[1]), railMin, '媒体块的封顶值也要同值');
});

test('只填链接：解析网页标题与摘要（meta 属性顺序随意、解 HTML 实体、取不到给空串）', () => {
    const { parsePageMeta } = require('../lib/timeline/http');

    // og: 优先；同时演示 content 在 property 之前（真实网页两种顺序都有）
    const a = parsePageMeta(`<html><head>
        <title>页面标题</title>
        <meta name="description" content="普通描述">
        <meta property="og:title" content="OG 标题">
        <meta content="OG 描述" property="og:description">
        </head></html>`);
    assert.equal(a.title, 'OG 标题', 'og:title 优先于 <title>');
    assert.equal(a.summary, 'OG 描述', 'og:description 优先，且属性顺序不影响');

    // 退回 <title> 与 name=description；实体要解、空白要压
    const b = parsePageMeta('<title>A &amp; B\n   C</title><meta name="description" content="含 &quot;引号&quot; 的描述">');
    assert.equal(b.title, 'A & B C', '退回 title 且解实体、压空白');
    assert.equal(b.summary, '含 "引号" 的描述', '解 HTML 实体');

    // 取不到就是空串，由调用方决定怎么退（服务端会退回「用链接当标题」）
    const c = parsePageMeta('<html><body>什么都没有</body></html>');
    assert.deepEqual(c, { title: '', summary: '' }, '取不到给空串，不抛错');
});

test('顶部只留同步时间、底部只留按钮：旧的三段描述与页脚统计都不得回来', () => {
    const code = stripComments(moduleSource);
    // 顶部：稳态不给「已同步」，也不再显示未读数与副标题
    assert.doesNotMatch(code, /data-kind="ready"/, '不再渲染「已同步」胶囊');
    assert.doesNotMatch(code, /data-kind="unread"/, '不再渲染「未读 N」胶囊');
    assert.doesNotMatch(code, /动态 · 稍后阅读/, '不再渲染副标题');
    assert.doesNotMatch(code, /special-line-sub/, '副标题元素已删');
    // 但临时状态必须留着（它们带动作）
    assert.match(code, /data-kind="pending"[\s\S]*?同步中/, '同步中保留');
    assert.match(code, /data-kind="alert"[\s\S]*?data-action="retry"/, '同步失败 + 重试保留');
    assert.match(code, /special-line-time-note/, '同步时间保留');
    // 底部：说明行现在只说「保留窗口 / 自动加载」，旧统计（共 N 条、更新于）不得回来
    assert.doesNotMatch(code, /共 \$\{events\.length\} 条/, '不再显示条数');
    assert.doesNotMatch(code, /更新于/, '不再显示更新时间');
    assert.match(code, /仅保留最近 30 天/, '到底时说明只保留最近 30 天');

    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    assert.doesNotMatch(css, /\.special-line-sub\s*\{/, '副标题 CSS 也删了');
});

test('保存弹窗用平台那套（居中 + 遮罩），且标题与摘要都是选填', () => {
    const code = stripComments(moduleSource);
    assert.match(code, /className = 'ui-dialog-overlay'/, '外面是平台弹窗的遮罩层');
    assert.match(code, /class="ui-dialog" role="dialog" aria-modal="true"/, '面板用 .ui-dialog（与设置弹窗同一套观感）');
    assert.doesNotMatch(code, /class="special-line-dialog"/, '不再用自己那套 <dialog> 样式');
    assert.doesNotMatch(code, /showModal\(/, '不再用 showModal（那会自带另一套遮罩与定位）');
    // 只填链接：标题/摘要不得带 required，且提交前不再校验标题
    assert.match(code, /<input id="specialLineTitle"[^>]*>/, '标题输入框还在');
    assert.doesNotMatch(code, /id="specialLineTitle"[^>]*required/, '标题不再必填');
    assert.doesNotMatch(code, /请填写文章标题。/, '提交前不再卡标题');
    assert.match(code, /classList\.add\('is-filtering'\)[\s\S]*?正在切换…/,
        '（既有行为未受影响：筛选过渡仍在）');
    // ⚠️ 服务端把 titleFromUrl 挂在 `event` 上（见 server.js 的 res.json({event: …})）。
    // 写成 data.titleFromUrl 永远取不到，用户就永远收不到「未能自动获取标题」的提示。
    assert.match(code, /data\.event\.titleFromUrl/, '提示读的是 event 上的标记（不是 data 上的）');
    assert.doesNotMatch(code, /data\.titleFromUrl/, '不存在 data.titleFromUrl 这种形状');
});

test('底部只留「加载更早事件」：条数与更新时间已按用户要求去掉', () => {
    const code = stripComments(moduleSource);
    assert.match(code, /class="special-line-btn" type="button" data-action="more">加载更早事件</, '是真按钮、文案与仿真一致');
    assert.match(code, /class="special-line-footnote">向下滚动会自动加载更早事件</, '还有更早时给一行自动加载说明');
    assert.match(code, /class="special-line-footnote">已到最早一条 · 仅保留最近 30 天</, '到底时说明保留窗口');
    // ⚠️ 那句话只对社交订阅成立：「稍后阅读」不参与时限清理，空列表也谈不上「已到最早一条」
    assert.match(code, /const socialView = filterSource !== 'manual'/, '「稍后阅读」视图不算社交窗口');
    assert.match(code, /events\.length && socialView[\s\S]{0,80}仅保留最近 30 天/,
        '保留窗口说明只在社交视图且确实有内容时出现');
    assert.doesNotMatch(code, /共 \$\{events\.length\} 条/, '不再显示条数');
    assert.doesNotMatch(code, /更新于/, '不再显示更新时间');
    // 仿真里底部区每种状态各有一个真按钮：正常→加载更早事件（quiet）、
    // 筛选无结果→清除筛选（quiet）、空状态→＋保存文章（实心主按钮）。
    // 早先这三处都写成了下划线小链接。
    assert.match(code, /data-action="reset-filters">清除筛选</, '筛选无结果有清除筛选');
    assert.match(code, /class="special-line-btn special-line-btn--primary" type="button" data-action="save">＋ 保存文章</,
        '空状态的保存文章是实心主按钮');
    assert.doesNotMatch(code, /special-line-linkbtn/, '下划线小链接那套已删除（不留死类名）');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    const foot = /\.special-line-foot \{([\s\S]*?)\n\}/.exec(css);
    assert.match(foot[1], /flex-direction: column/, '按钮在上、说明在下');
    assert.match(foot[1], /align-items: center/, '居中（仿真里是居中的 quiet-button）');
    assert.match(css, /\.special-line-btn \{[\s\S]*?min-height: 34px/, '按钮有实体样式，不是下划线小链接');
    assert.match(css, /\.special-line-btn--primary \{[\s\S]*?color: #fff/, '主按钮是实心的');
    assert.doesNotMatch(css, /\.special-line-linkbtn/, '样式表里那套下划线按钮规则也要删掉，不留死规则');
});

test('宽版日期栏不侵入节点光圈，轨道居中且正文起点紧凑', () => {
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));
    const at = css.indexOf('@container (min-width: 360px) {');
    assert.ok(at >= 0, '宽版容器查询存在');
    const open = css.indexOf('{', at);
    let depth = 1;
    let end = open + 1;
    for (; end < css.length && depth; end++) {
        if (css[end] === '{') depth++;
        if (css[end] === '}') depth--;
    }
    assert.equal(depth, 0, '宽版容器查询完整闭合');
    const wide = css.slice(open + 1, end - 1);
    const rule = (source, selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matches = [...source.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
        assert.ok(matches.length, `${selector} 规则存在`);
        return Object.fromEntries(matches.flatMap(match => match[1].split(';')
            .map(declaration => /^\s*([\w-]+):\s*(.*?)\s*$/.exec(declaration))
            .filter(Boolean).map(declaration => [declaration[1], declaration[2]])));
    };
    const px = (declarations, property) => {
        const match = /^([\d.]+)px$/.exec(declarations[property]);
        assert.ok(match, `${property} 的有效 px 值存在`);
        return Number(match[1]);
    };
    const base = css.slice(0, at);
    const item = rule(wide, '.special-line-item');
    const column = /^([\d.]+)px minmax\(0, 1fr\)$/.exec(item['grid-template-columns']);
    assert.ok(column, '日期与正文使用两列网格');
    const timeWidth = Number(column[1]);
    const gap = px(item, 'gap');
    const track = px(rule(wide, '.special-line-list::before'), 'left');
    const node = { ...rule(base, '.special-line-item::before'), ...rule(wide, '.special-line-item::before') };
    const unread = { ...node, ...rule(base, '.special-line-item[data-unread="true"]::before'),
        ...rule(wide, '.special-line-item[data-unread="true"]::before') };
    for (const [name, declarations] of [['普通节点', node], ['未读节点', unread]]) {
        const halo = declarations['box-shadow'] ? /^0 0 0 ([\d.]+)px /.exec(declarations['box-shadow']) : null;
        if (declarations['box-shadow']) assert.ok(halo, `${name} 的有效光圈尺寸可解析`);
        const radius = px(declarations, 'width') / 2 + (halo ? Number(halo[1]) : 0);
        assert.equal(px(declarations, 'left'), track, `${name} 与轨道中心一致`);
        assert.equal(declarations.transform, 'translate(-50%, -50%)', `${name} 最终仍以中心定位`);
        assert.ok(track - radius - timeWidth >= 6, `${name} 光圈与日期框至少留 6px`);
        assert.ok(timeWidth + gap - track - radius >= 6, `${name} 光圈与正文卡至少留 6px`);
    }
    assert.equal(px(node, 'top'), px(unread, 'top'), '已读与未读节点不偏移');
    assert.ok(timeWidth + gap <= 80, '正文左起点不超过 80px');
    assert.equal(rule(wide, '.special-line-time')['white-space'], 'nowrap', '日期与时刻不被挤断');
    assert.ok(px(rule(wide, '.special-line-time strong'), 'font-size') <= 10,
        '紧凑日期栏保持 10px 日期字号，最长月日日期不会溢出');
});

test('内联卡片的 CSS：高度有上限、列表内滚动、两套版式按容器宽度切换', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    const card = /\.special-line-card \{([\s\S]*?)\n\}/.exec(css);
    assert.ok(card, '切出 .special-line-card 规则');
    assert.match(card[1], /max-height:/, '卡片必须有高度上限——右侧那一列不能无限长下去');
    // 版式按**卡片自己的宽度**切，而不是按视口：拖到左列、窗口变窄都不必重渲染
    assert.match(card[1], /container-type: inline-size/, '卡片是容器查询的容器');

    // 两套版式：宽列用仿真的桌面版（日期在左），窄列用仿真 ≤700px 那套（时间在卡上方）
    // ⚠️ 阈值按**内容盒**算，不是外框：容器查询量的是内容盒，而卡片有
    // 2×13px 内边距 + 2×1px 边框，所以 RAIL_MIN=400 那一档实际只有 372px 参与
    // 匹配——阈值写 400（甚至 390）都会让它误判成窄版（实测：1280 视口下卡片
    // 400 却渲染成窄版）。360 之下是手机竖屏那种整行卡片（约 323px）。
    const wide = /@container \(min-width: 360px\) \{([\s\S]*?)\n\}/.exec(css);
    assert.ok(wide, '有宽列版式');
    assert.match(wide[1], /grid-template-columns: 48px minmax\(0, 1fr\)/, '桌面版：紧凑日期栏 + 事件卡');
    assert.match(wide[1], /text-align: right/, '桌面版时间靠右（贴近竖线）');
    const narrow = /@container \(max-width: 359\.98px\) \{([\s\S]*?)\n\}/.exec(css);
    assert.ok(narrow, '有窄列版式');
    assert.match(narrow[1], /display: block/, '窄版：单列');
    assert.match(narrow[1], /margin-left: 24px/, '窄版：事件卡缩进让开竖线');
    assert.match(narrow[1], /\.special-line-time \{ display: block/, '<time> 必须显式 block，否则 padding 盒压到卡上沿');

    // 卡片必须自成一个包含块：它是第一个在卡片里用 .sr-only（绝对定位）的模块，
    // 而 below 停靠下卡片是 static——那些盒子会以 .module-zone（absolute）为
    // 包含块，溢出逃出横滑条的裁剪、把整个文档撑宽（实测 390 视口多出 338px）。
    // ⚠️ 这条规则的特异性必须 ≥ 平台那条 0-3-0 的 below 规则，否则被压掉。
    assert.match(css,
        /\.module-zone\[data-dock="below"\] \.module-widget\[data-module-id="special-line"\] \{ position: relative; \}/,
        '卡片必须是自身绝对定位后代的包含块（0-4-0 压得过平台的 below 规则）');
    // 且这条不得越过 dock 限定：不限定就是 0-3-0，会把 outside 模式的
    // `.module-widget[data-side="right"]`（0-2-0）的 absolute 也顶掉，宽屏那一列散架
    assert.doesNotMatch(css, /^\.module-zone \.module-widget\[data-module-id="special-line"\] \{ position: relative; \}/m,
        '不得写成不限 dock 的版本');

    const wrap = /\.special-line-listwrap \{([\s\S]*?)\n\}/.exec(css);
    assert.ok(wrap, '切出 .special-line-listwrap 规则');
    assert.match(wrap[1], /overflow-y: auto/, '列表自己滚');
    assert.match(wrap[1], /min-height: 0/, 'flex 子项必须 min-height:0 才会真的滚（否则被内容撑开）');

    // 「⋯」菜单在滚动容器里要能往上弹
    assert.match(css, /\.special-line-tools\.is-up \.special-line-actions \{ top: auto; bottom: calc\(100% \+ 4px\); \}/,
        '菜单贴底时往上弹');

    // 颜色 token：本仓库**没有** --danger / --warning / --success，
    // 引用它们不会报错，只会静默丢掉那条声明（观感像「样式没生效」）
    const admin = fs.readFileSync(path.join(ROOT, 'public', 'admin.css'), 'utf8');
    for (const [name, src] of [['styles.css', css], ['admin.css', admin]]) {
        const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const bad of ['--danger', '--warning', '--success']) {
            assert.ok(!new RegExp(`var\\(${bad}\\)`).test(stripped),
                `${name} 不得引用不存在的 token var(${bad})`);
        }
    }
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
        const timeline = createTimeline(db, {
            getPasswordHash: async () => OLD_HASH, fetchMeta: async () => ({}) });
        await timeline.service.saveArticle({ url: 'https://example.com/x', title: '一篇' });
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
        // 标题留空不再报错：「只填链接」现在是设计内的主路径——服务端自动取标题，
        // 抓不到就用链接本身当标题，并用 titleFromUrl 让界面提示用户。
        const noTitle = await callRoute(routes, 'POST /api/timeline/articles',
            { body: { url: 'https://example.com/y', title: '   ' } });
        assert.equal(noTitle.statusCode, 200, '留空标题也能保存');
        assert.equal(noTitle.body.event.titleFromUrl, true, '抓不到标题时回落用链接当标题');
        assert.match(noTitle.body.event.title, /example\.com\/y/, '标题取自链接');

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
        // 1 而不是 0：上面那条「留空标题」的保存现在会成功落一条（自动用链接当标题），
        // 它没被标为已读。这里钉的是「标已读只影响那一条」，所以期望值是剩下的未读数。
        assert.equal(after.body.unreadCount, 1, '只有被标记的那条变成已读');
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
        '（lib/timeline 的集合不在限流路径上，见下条。）');

    // lib/timeline 里的可变集合都是「有界或被显式清理」的，逐只点出来：
    //  · service 的 failures：删来源时 delete，且只按来源计数
    //  · sync 的 inFlight：finally 里 delete
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
    assert.deepEqual(maps.sort(), ['service.js:failures', 'sync.js:inFlight'].sort(),
        `lib/timeline 里的可变集合就是这两只，每只都要有边界或显式清理（实测：${maps.join(', ')}）`);
});

test('真实路由→服务→数据库：周期白名单、无 token、启停与调度恢复', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const original = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push([url, options]);
        return String(url).includes('/statuses') ? fxResponse([fxStatus('1799999999999999999', { created_timestamp: Math.floor(Date.now() / 1000) })])
            : Response.json({ code: 200, user: { screen_name: 'alice' } });
    };
    try {
        const timeline = createTimeline(db, {
            getPasswordHash: async () => { throw new Error('X must not decrypt'); }, log: { warn() {} }
        });
        const routes = loadTimelineRoutes(timeline);
        const providers = (await callRoute(routes, 'GET /api/timeline/sources')).body.providers;
        assert.deepEqual(Array.from(providers.find(p => p.id === 'x').syncIntervalsMs), [60000, 300000, 900000, 1800000, 3600000]);
        assert.equal(providers.find(p => p.id === 'x').requiresCredentials, false);
        assert.equal(providers.find(p => p.id === 'x').defaultSyncIntervalMs, 300000);
        assert.deepEqual(Array.from(providers.find(p => p.id === 'weibo').syncIntervalsMs), [300000, 900000, 1800000, 3600000]);
        assert.equal(providers.find(p => p.id === 'weibo').requiresCredentials, true);
        const create = await callRoute(routes, 'POST /api/timeline/sources', {
            body: { providerType: 'x', externalKey: ' @alice ', syncIntervalMs: 60000, token: 'ignore' }
        });
        assert.equal(create.statusCode, 200);
        const id = create.body.source.id;
        assert.equal(create.body.source.externalKey, 'alice');
        assert.equal(create.body.source.syncIntervalMs, 60000);
        assert.equal(timeline.repo.getCredentials(id), null);
        timeline.repo.setCredentials(id, { broken: true });
        assert.equal((await timeline.service.testSource(id)).ok, true);
        assert.equal((await timeline.service.syncSource(id)).inserted, 1);
        const event = timeline.repo.listEvents({ sourceId: id }).rows[0];
        timeline.service.markRead(event.id, true);
        timeline.service.archive(event.id, true);
        assert.equal((await timeline.service.syncSource(id)).inserted, 0);
        for (const interval of [60000, 300000, 900000, 1800000, 3600000]) {
            timeline.repo.recordAttempt(id, 1);
            const changed = await callRoute(routes, 'PUT /api/timeline/sources/:id', {
                params: { id }, body: { syncIntervalMs: interval }
            });
            assert.equal(changed.statusCode, 200);
            assert.equal(changed.body.source.syncIntervalMs, interval);
            assert.equal(timeline.repo.getSource(id).syncIntervalMs, interval);
            assert.ok(changed.body.source.nextSyncAt <= Date.now());
        }
        const unchanged = await callRoute(routes, 'PUT /api/timeline/sources/:id', { params: { id }, body: { name: 'renamed' } });
        assert.equal(unchanged.body.source.syncIntervalMs, 3600000);
        for (const invalid of [null, '60000', 120000, -1, {}, true]) {
            const bad = await callRoute(routes, 'PUT /api/timeline/sources/:id', { params: { id }, body: { syncIntervalMs: invalid } });
            assert.equal(bad.statusCode, 400);
            assert.equal(timeline.repo.getSource(id).syncIntervalMs, 3600000);
            const badCreate = await callRoute(routes, 'POST /api/timeline/sources', {
                body: { providerType: 'x', externalKey: 'alice', syncIntervalMs: invalid }
            });
            assert.equal(badCreate.statusCode, 400);
        }
        assert.equal((await callRoute(routes, 'PUT /api/timeline/sources/:id', {
            params: { id }, body: { enabled: 'false' }
        })).statusCode, 400);
        const stopped = await callRoute(routes, 'PUT /api/timeline/sources/:id', {
            params: { id }, body: { enabled: false }
        });
        assert.equal(stopped.body.source.enabled, false);
        const n = requests.length;
        await timeline.scheduler.tickNow();
        assert.equal((await timeline.service.syncSource(id)).skipped, true);
        assert.equal(requests.length, n);
        await callRoute(routes, 'PUT /api/timeline/sources/:id', {
            params: { id }, body: { syncIntervalMs: 300000, token: 'ignored' }
        });
        assert.equal(timeline.repo.getSource(id).enabled, false);
        assert.equal((await callRoute(routes, 'POST /api/timeline/sources/:id/sync', { params: { id } })).body.ok, true);
        assert.ok(requests.length > n);
        assert.equal(timeline.repo.getSource(id).enabled, false);
        assert.ok(timeline.repo.listEvents({ view: 'archived' }).rows[0].readAt);
        await callRoute(routes, 'PUT /api/timeline/sources/:id', { params: { id }, body: { enabled: true } });
        assert.equal(timeline.repo.dueSources(Date.now(), 10).length, 1);
        const before = requests.length;
        await timeline.scheduler.tickNow();
        while (timeline.scheduler.isRunning(id)) await new Promise(resolve => setImmediate(resolve));
        assert.ok(requests.length > before);
        assert.ok(timeline.repo.getSource(id).nextSyncAt >= timeline.repo.getSource(id).lastAttemptAt + 300000);
        assert.equal((await callRoute(routes, 'POST /api/timeline/sources', {
            body: { providerType: 'weibo', externalKey: 'alice' }
        })).statusCode, 400);
        const defaults = await timeline.service.createSource({ providerType: 'x', externalKey: 'alice' });
        assert.equal(defaults.syncIntervalMs, 300000);
        for (const [, options] of requests) assert.equal(options.headers.authorization, undefined);
    } finally {
        globalThis.fetch = original;
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('重新授权立即排一次同步，不被同一次提交里的周期字段挤掉；从未尝试过改周期仍然到期', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const original = globalThis.fetch;
    try {
        const repo = createRepository(db);
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH, log: { warn() {} } });

        // ① X：从未尝试过（lastAttemptAt 为空）时改周期，仍应「现在就该跑」
        const x = repo.createSource({ providerType: 'x', externalKey: 'alice', name: 'alice', syncIntervalMs: 300000 });
        const changed = await service.updateSource(x.id, { syncIntervalMs: 3600000 });
        assert.equal(changed.syncIntervalMs, 3600000);
        assert.ok(repo.getSource(x.id).nextSyncAt <= Date.now(), '从未尝试过，改周期后仍立即到期');

        // ② 微博：重新授权（token + syncIntervalMs 同一次提交）必须立刻排一次，
        //    而不是落到「上次尝试 + 新周期」那条分支上（那会让用户等满一个周期）
        globalThis.fetch = async () => Response.json({ id: 42, screen_name: 'someone' });
        const weibo = repo.createSource({ providerType: 'weibo', externalKey: 'someone', name: 'someone', syncIntervalMs: 300000 });
        repo.setCredentials(weibo.id, { stale: true });
        repo.recordAttempt(weibo.id, Date.now() - 10 * 60 * 1000);
        repo.setNextSyncAt(weibo.id, Date.now() + 300000);
        const reauth = await service.updateSource(weibo.id, { externalKey: 'someone', token: 'new-token', syncIntervalMs: 900000 });
        assert.equal(reauth.syncIntervalMs, 900000, '周期照常写入');
        assert.ok(repo.getSource(weibo.id).nextSyncAt <= Date.now(), '重新授权后立刻到期，不被周期分支推后');

        // ③ 未授权平台仍然必须带凭据创建
        await assert.rejects(() => service.createSource({ providerType: 'weibo', externalKey: 'someone' }),
            /Access Token|凭据/);
    } finally {
        globalThis.fetch = original;
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('真实同步中途失败不写事件或推进旧数字水位；旧 X 状态与周期保留', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const original = globalThis.fetch;
    try {
        const repo = createRepository(db);
        const source = repo.createSource({ providerType: 'x', externalKey: 'alice', name: 'alice', syncIntervalMs: 900000 });
        repo.recordSuccess(source.id, { cursor: '1799999999999999900', at: 1, nextSyncAt: 1 });
        repo.recordFailure(source.id, { code: 'auth', message: 'old token', at: 1, nextSyncAt: 1 });
        repo.setCredentials(source.id, { corrupt: true });
        const service = createService(repo, { getPasswordHash: async () => { throw new Error('unused'); }, log: { warn() {} } });
        assert.equal(service.getSourceView(source.id).status, 'failed');
        let n = 0;
        globalThis.fetch = async () => {
            if (++n === 2) throw new Error('offline');
            return fxResponse([fxStatus('1799999999999999999')], 'next');
        };
        assert.equal((await service.syncSource(source.id)).ok, false);
        assert.equal(repo.getSource(source.id).syncCursor, '1799999999999999900');
        assert.equal(repo.countSourceEvents(source.id), 0);
        assert.equal(repo.getSource(source.id).syncIntervalMs, 900000);
        globalThis.fetch = async () => fxResponse([fxStatus('1799999999999999999')]);
        assert.equal((await service.syncSource(source.id)).ok, true);
        assert.equal(repo.getSource(source.id).syncCursor, '1799999999999999999');
        assert.equal(service.getSourceView(source.id).status, 'ok');
    } finally {
        globalThis.fetch = original;
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('微博周期白名单最低五分钟，凭据依旧加密并且周期编辑不重新启用', async () => {
    const { dir, file } = tempDb();
    const db = openDatabase(file);
    const original = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ id: '123' });
    try {
        const repo = createRepository(db);
        const service = createService(repo, { getPasswordHash: async () => OLD_HASH });
        await assert.rejects(() => service.createSource({ providerType: 'weibo', externalKey: 'alice', token: 'secret', syncIntervalMs: 60000 }), { status: 400 });
        const src = await service.createSource({ providerType: 'weibo', externalKey: 'alice', token: 'secret' });
        assert.equal(src.syncIntervalMs, 300000);
        assert.equal(src.hasCredentials, true);
        assert.equal(JSON.parse(decrypt(repo.getCredentials(src.id), OLD_HASH, 'timeline')).token, 'secret');
        await service.updateSource(src.id, { enabled: false });
        for (const ms of [300000, 900000, 1800000, 3600000]) {
            const updated = await service.updateSource(src.id, { syncIntervalMs: ms });
            assert.equal(updated.syncIntervalMs, ms);
            assert.equal(updated.enabled, false);
            assert.equal(updated.nextSyncAt, null);
        }
        await assert.rejects(() => service.updateSource(src.id, { syncIntervalMs: 60000 }), { status: 400 });
        assert.equal(repo.getSource(src.id).syncIntervalMs, 3600000);
    } finally {
        globalThis.fetch = original;
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

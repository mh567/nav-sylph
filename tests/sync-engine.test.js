'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
}
function methodBodyOf(code, name) {
    const re = new RegExp(`\\n( {8}| {4})(?:async )?(?:function )?${name}\\([^()]*\\) \\{`);
    const match = re.exec(code);
    assert.ok(match, `切出 ${name}`);
    const indent = match[1];
    const rest = code.slice(match.index + 1);
    const next = rest.search(new RegExp(`\\n${indent}(?:async )?(?:function )?[a-zA-Z_][\\w$]*\\(`));
    return next > 0 ? rest.slice(0, next) : rest;
}

const cleanApp = stripComments(appSource);

// 调度参数一律**从源码解析**再注入：手写 500/2000 之类的字面量会让「改了真常量」
// 这类变异照样全绿（本仓库踩过）。
const CONST_NAMES = ['SYNC_DEBOUNCE_MS', 'SYNC_MAX_WAIT_MS', 'SYNC_POLL_MS', 'SYNC_BACKOFF_START_MS',
    'SYNC_BACKOFF_MAX_MS', 'SYNC_CLAIM_TTL_MS', 'SYNC_CLAIM_PING_MS', 'SYNC_RECEIPT_WINDOW_MS'];
const CONSTANTS = Object.fromEntries(CONST_NAMES.map(name => {
    const parsed = new RegExp(`const ${name} = (\\d+)`).exec(cleanApp);
    assert.ok(parsed, `解析出 ${name}`);
    return [name, Number(parsed[1])];
}));
const CONST_SOURCE = CONST_NAMES.map(name => `const ${name} = ${CONSTANTS[name]};`).join('\n');

const METHODS = [
    'hasLocalDraft', 'setSyncStatus', 'markSyncDirty', 'scheduleSyncUpload', 'startSyncUpload',
    'syncBackoffNext', 'scheduleSyncRetry', 'syncPayload', 'syncContentEqual', 'persistSyncRecord',
    'ensureSyncPending', 'acquireSyncClaim', 'releaseSyncClaim', 'uploadOnce', 'confirmSyncUpload',
    'handleSyncUploadFailure', 'handleSyncConflict', 'fetchSyncCloud', 'reconcileAgedPending',
    'syncPullCheck', 'applyCloudConfig', 'startSyncPolling', 'stopSyncPolling', 'stopSyncTimers',
    'syncSettledStatus', 'syncPayloadKey', 'syncClaimHeldElsewhere', 'loadSyncState', 'bindSyncChannel',
    'onSyncVisibilityChange', 'onSyncOnline', 'onSyncOffline', 'pauseSyncForAdmin', 'resumeSyncAfterAdmin', 'notifySyncPeers', 'resolveSyncConflict', 'clearSyncConnection'
];

/** 假时钟：定时器可推进，`advance` 会把到期的回调按时间顺序跑完。 */
function makeClock(start = 1000000) {
    let now = start;
    let seq = 0;
    const timers = new Map();
    const setTimeoutFn = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; };
    const clearTimeoutFn = id => { timers.delete(id); };
    const setIntervalFn = (fn, ms) => { const id = ++seq; const every = ms || 1; timers.set(id, { at: now + every, fn, every }); return id; };
    const clearIntervalFn = id => { timers.delete(id); };
    return {
        now: () => now,
        setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn,
        setInterval: setIntervalFn, clearInterval: clearIntervalFn,
        intervals: () => [...timers.values()].filter(t => t.every).length,
        pending: () => timers.size,
        async advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                const [id, timer] = due;
                now = Math.max(now, timer.at);
                if (timer.every) timer.at = now + timer.every; else timers.delete(id);
                // ⚠️ **不** await 回调：有的用例故意让上传卡在闸门上（在途状态就是
                // 用它构造的），await 会让 advance 永远不返回，症状是
                // 「Promise resolution is still pending but the event loop has already resolved」。
                // 给几个微任务让异步链先跑起来，需要更完整的推进时用例自己 flush()。
                timer.fn();
                await flush();
            }
            now = target;
        }
    };
}
// 一次「落盘 + POST + 收尾」的异步链要走十几跳微任务（每个 await 一跳），
// 刷新不够的症状是断言在链条还没跑完时就读状态（看起来像「上传没发生」）。
// 本地与云端的配置必须是**同一个形状**（publicConfig 的五个字段）才能比较相等；
// 夹具里给云端一个只有 theme 的对象会让「内容其实一致」被误判成冲突。
const FULL_CONFIG = {
    theme: 'auto', showBookmarkIcons: true, searchEngine: 'g',
    searchEngines: [{ id: 'g', name: 'G', url: 'https://g/?q=' }], categories: []
};
// modules 也照服务端 normalizeSyncModules 的输出形状给三个键：真服务端存的就是
// 「客户端发上去的那份」，少了键会让「内容其实一致」被误判成冲突。
const cloudOf = (over = {}) => ({ revision: 3, generation: 1, updatedAt: 900, config: structuredClone({ ...FULL_CONFIG, ...over }), modules: { enabled: [], widgets: [], settings: {} } });

const flush = async (ticks = 14) => { for (let i = 0; i < ticks; i++) await Promise.resolve(); };

/** 内存版同步记录：与 local-navigation.js 的 writeSync 同语义（补丁 + 缺席即保留）。 */
function makeLocalStore(seed = null) {
    let record = seed;
    return {
        snapshot: () => record,
        seed: value => { record = value; },
        async readSync() { return record ? { ...record } : undefined; },
        async writeSync(patch, revision) {
            const current = record || { revision: 0 };
            if ((current.revision || 0) !== revision) throw Object.assign(new Error('其他地方改过了'), { code: 'conflict' });
            const next = { schemaVersion: 1, revision: revision + 1 };
            // ⚠️ 这个列表必须与 local-navigation.js 的 SYNC_FIELDS 一致：
            // 漏一个字段的表现不是报错，而是真代码读到 undefined、状态判断悄悄走错。
            for (const key of ['connection', 'recovery', 'pending', 'claim', 'lastSuccessAt', 'uploadedPayloadKey']) {
                next[key] = Object.prototype.hasOwnProperty.call(patch || {}, key) ? (patch[key] ?? null) : (current[key] ?? null);
            }
            record = next;
            return { ...record };
        }
    };
}

/** 搭一个假 app：只放真代码确实会读到的字段，其余用桩。 */
function makeHarness(options = {}) {
    const clock = makeClock();
    const calls = { posts: [], gets: [], toasts: [], statuses: [], connected: 0 };
    // ⚠️ 默认就带一条**已连接**的记录，与真实状态一致：`persistSyncRecord` 会把
    // 记录里的字段覆盖回内存，而真程序只在已连接时才会走到上传。夹具里给一条
    // 空记录会造出「内存有连接、盘上没有」这种现实中不存在的状态，症状是
    // 上传时报 `Cannot read properties of null (reading 'generation')`。
    const localStore = makeLocalStore(options.record || seedRecord());
    const app = {
        authenticated: false,
        localUnavailable: false,
        localRevision: 7,
        localPending: 0,
        editLayout: false,
        config: structuredClone(FULL_CONFIG),
        syncConnection: { spaceId: 'space-1', deviceToken: 'tok'.repeat(20), generation: 1, revision: 3 },
        syncCloud: cloudOf(),
        syncPending: null,
        syncClaim: null,
        syncRecordRevision: 0,
        syncStatus: 'synced',
        syncConnEpoch: 0,
        syncUploadedPayloadKey: 'k7',   // 与当前内容指纹一致 = 内容已经传上去过
        syncUploadSettled: false,
        syncBackoffMs: 0,
        syncUploadInFlight: false,
        syncUploadAgain: false,
        syncChecking: false,
        syncAdopting: false,
        syncDebounceTimer: null,
        syncMaxWaitTimer: null,
        syncRetryTimer: null,
        syncPollTimer: null,
        syncTabId: 'tab-self',
        syncConflict: null,
        syncLastSuccessAt: null,
        syncError: '',
        localSettingsChanged: () => false,
        localModulePayload: () => ({ enabled: [], widgets: [], settings: {} }),
        markSyncEntry: () => {},
        renderSyncDialog: () => {},
        showToast: (message, kind) => calls.toasts.push({ message, kind }),
        // 这里**不再**用桩：clearSyncConnection 是「代次递增」这条不变式的落点，
        // 用桩就把它自己换掉了（本轮第一版就是这样，测试看不见真实现）。

        adoptCloudConfig: async cloud => { app.config = cloud.config; app.adopted = cloud.revision; },
        setSyncState: () => {}
    };
    const api = {
        async get(url, opts) {
            calls.gets.push({ url, opts });
            if (options.get) return options.get(url, calls.gets.length);
            return app.syncCloud;
        },
        async post(url, body, opts) {
            calls.posts.push({ url, body, opts });
            const result = options.post
                ? await options.post(body, calls.posts.length)
                : { success: true, revision: body.revision + 1, generation: 1, updatedAt: 1000 };
            // ⚠️ 不管自定义处理函数怎么写，写完都要让云端状态跟上：否则紧接着的
            // 「成功后再读一次」和「下一轮打包用的基线」都会拿到旧版本，而真服务端
            // 的 revision 只会往前走——夹具不许造出这种现实中不存在的状态。
            app.syncCloud = { revision: result.revision, generation: result.generation ?? 1, updatedAt: result.updatedAt ?? 1000, config: body.config, modules: body.modules };
            return result;
        }
    };
    const documentStub = { hidden: false, querySelector: () => (options.openDialog ? {} : null) };
    const navigatorStub = { onLine: options.onLine !== false };
    const windowStub = { NavigationSchema: { publicConfig: value => value, validate: () => {} }, BroadcastChannel: function () { return channel; } };
    const cryptoStub = { randomUUID: (() => { let n = 0; return () => `op-${++n}`; })() };
    // 假 BroadcastChannel：`holder` 非空时，收到 claim-check 就回一声「还活着」。
    const channel = {
        holder: null,
        posted: [],
        listeners: new Set(),
        postMessage(data) {
            this.posted.push(data);
            // `holder` = 那个认领真的还有人拿着（另一个活着的标签页）：收到询问就应答。
            if (data.type === 'claim-check' && this.holder === data.id) {
                for (const fn of [...this.listeners]) fn({ data: { type: 'claim-held', id: data.id } });
            }
        },
        // 模拟「别的标签页发来一条消息」。真 BroadcastChannel 不会把 postMessage
        // 回送给自己，所以这里需要一个显式的入口。
        receive(data) {
            if (typeof this.onmessage === 'function') this.onmessage({ data });
            for (const fn of [...this.listeners]) fn({ data });
        },
        addEventListener(type, fn) { this.listeners.add(fn); },
        removeEventListener(type, fn) { this.listeners.delete(fn); }
    };
    const factory = new Function('setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date',
        'API', 'crypto', 'document', 'navigator', 'window', 'BroadcastChannel',
        `${CONST_SOURCE}\nreturn { ${METHODS.map(name => methodBodyOf(cleanApp, name)).join(',')} };`);
    Object.assign(app, factory(clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval,
        { now: () => clock.now() }, api, cryptoStub, documentStub, navigatorStub, windowStub, function BroadcastChannelStub() { return channel; }));
    app.localStore = localStore;
    app.syncChannel = channel;
    // `'k7'` 是夹具里的哨兵：表示「当前内容已经确认上传过」。`syncPayloadKey` 用的是
    // 注入的真实现（这样指纹函数本身也被执行），所以这里把哨兵换成真实指纹。
    const seededRecord = localStore.snapshot();
    app.syncUploadedPayloadKey = app.syncPayloadKey();
    if (seededRecord && seededRecord.uploadedPayloadKey === 'k7') {
        localStore.seed({ ...seededRecord, uploadedPayloadKey: app.syncUploadedPayloadKey });
    }
    app.syncRecordRevision = localStore.snapshot()?.revision || 0;   // 必须从**实际那条记录**取，取错会造出假的 CAS 冲突
    return { app, clock, calls, localStore, flush, channel, document: documentStub };
}

const seedRecord = (over = {}) => ({
    schemaVersion: 1, revision: 1,
    connection: { spaceId: 'space-1', deviceToken: 'tok'.repeat(20), generation: 1, revision: 3, connectedAt: 1 },
    recovery: null, pending: null, claim: null, lastSuccessAt: null, uploadedPayloadKey: 'k7', ...over
});

test('防抖：500ms 内的连续改动只合并成一次上传', async () => {
    const h = makeHarness();
    h.app.markSyncDirty();
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS - 100);
    assert.equal(h.calls.posts.length, 0, '还没到窗口，不该发');
    h.app.markSyncDirty();
    await h.clock.advance(200);
    assert.equal(h.calls.posts.length, 0, '第二次改动把窗口重置了');
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS);
    await h.flush();
    assert.equal(h.calls.posts.length, 1, '窗口到期后只发一次');
});

test('2 秒上限：一直改也必须在 2 秒内发出一次，而不是等编辑停下来', async () => {
    const h = makeHarness();
    // 每 200ms 改一次，连改 3 秒（每次都会重置防抖窗口）
    for (let elapsed = 0; elapsed < 3000; elapsed += 200) {
        h.app.markSyncDirty();
        await h.clock.advance(200);
        if (h.calls.posts.length) break;
    }
    await h.flush();
    assert.equal(h.calls.posts.length, 1, '连续编辑期间必须已经发出一次');
    const startedAt = h.calls.posts[0].startedAt ?? null;
    // 时间点：从第一次脏起算，不晚于 MAX_WAIT（这里允许一个 200ms 的推进步长）
    assert.ok(h.clock.now() - 1000000 <= CONSTANTS.SYNC_MAX_WAIT_MS + 200,
        `第一次上传发生在 ${h.clock.now() - 1000000}ms，应不晚于 ${CONSTANTS.SYNC_MAX_WAIT_MS}ms`);
});

test('单飞：在途期间的改动只排下一轮，不开第二条连接', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = makeHarness({
        post: async body => { await gate; return { success: true, revision: body.revision + 1, generation: 1, updatedAt: 1000 }; }
    });
    h.app.markSyncDirty();
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush(2);
    assert.equal(h.calls.posts.length, 1, '第一次上传已发出且在途');

    // 在途期间又改两次：不能并发第二条
    h.app.syncPending = null;             // 模拟「下一批内容还没落盘」
    h.app.markSyncDirty();
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush(2);
    assert.equal(h.calls.posts.length, 1, '在途期间不得开第二条上传');
    assert.equal(h.app.syncUploadAgain, true, '但要记住「还有下一轮」');

    release();
    await h.flush();
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush();
    assert.equal(h.calls.posts.length, 2, '在途结束后排了下一轮');
});

test('退避：1s 起翻倍，封顶 5 分钟，成功后归零', async () => {
    const h = makeHarness({ post: async () => { throw Object.assign(new Error('网络不通'), { status: 0 }); } });
    const waits = [];
    for (let i = 0; i < 6; i++) {
        h.app.syncBackoffMs = i === 0 ? 0 : h.app.syncBackoffMs;
        waits.push(h.app.syncBackoffNext());
    }
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000].map((v, i) => Math.min(v, CONSTANTS.SYNC_BACKOFF_MAX_MS)));
    // 一直翻到上限就不再涨
    for (let i = 0; i < 20; i++) h.app.syncBackoffNext();
    assert.equal(h.app.syncBackoffMs, CONSTANTS.SYNC_BACKOFF_MAX_MS);

    // 失败一次后确实排了重试，且成功后归零
    const h2 = makeHarness({ post: async body => (h2.calls.posts.length === 1 ? Promise.reject(Object.assign(new Error('x'), { status: 0 })) : { success: true, revision: body.revision + 1, generation: 1 }) });
    h2.app.markSyncDirty();
    await h2.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h2.flush();
    assert.equal(h2.calls.posts.length, 1);
    assert.equal(h2.app.syncBackoffMs, CONSTANTS.SYNC_BACKOFF_START_MS, '失败后进入退避');
    await h2.clock.advance(h2.app.syncBackoffMs + 10);
    await h2.flush();
    assert.equal(h2.calls.posts.length, 2, '退避到期后自动重试');
    assert.equal(h2.app.syncBackoffMs, 0, '成功后归零');
});

test('采用云端期间不把自己触发成「本地改动」', async () => {
    // 采用云端也会走 saveLocalNavigation → markSyncDirty。不挡掉的话就是
    // 「刚采用云端 → 立刻把同一份内容再传回去」。判据是这次保存的**来源**。
    const h = makeHarness();
    const statusBefore = h.app.syncStatus;
    h.app.syncAdopting = true;
    h.app.markSyncDirty();
    await h.flush();
    assert.equal(h.app.syncStatus, statusBefore, '采用期间不该改状态');
    assert.equal(h.clock.pending(), 0, '也不该排上传');
    assert.equal(h.calls.posts.length, 0);
    // 正常改动照旧
    h.app.syncAdopting = false;
    h.app.config.theme = 'dark';
    h.app.markSyncDirty();
    assert.equal(h.app.syncStatus, 'syncing');
    assert.ok(h.clock.pending() > 0, '正常改动要排上传');
});

test('三个触发点：执行真实函数体（恢复可见 / 联网立即检查并取消退避，隐藏停轮询）', async () => {
    // ① 联网：取消退避 + 立即检查 + 把积压的排出去
    const online = makeHarness({ record: seedRecord({ pending: { operationId: 'op-p', payloadKey: 'k7', content: { config: cloudOf({ theme: 'dark' }).config, modules: {} }, baseRevision: 3, createdAt: 1000000 } }) });
    online.app.syncPending = online.localStore.snapshot().pending;
    online.app.syncBackoffMs = 60000;
    online.app.syncRetryTimer = 12345;
    online.app.onSyncOnline();
    await online.flush();
    assert.equal(online.app.syncBackoffMs, 0, '联网要取消退避');
    assert.ok(online.calls.gets.length >= 1, '联网要立即检查一次');

    // ② 恢复可见：取消退避 + 检查 + 起轮询
    const visible = makeHarness();
    visible.app.syncBackoffMs = 60000;
    visible.app.onSyncVisibilityChange();
    await visible.flush();
    assert.equal(visible.app.syncBackoffMs, 0, '恢复可见也要取消退避');
    assert.ok(visible.calls.gets.length >= 1, '恢复可见要立即检查');
    assert.equal(visible.clock.intervals(), 1, '恢复可见要起轮询');

    // ③ 隐藏：停轮询，且不再检查
    const hidden = makeHarness();
    hidden.app.startSyncPolling();                 // ⚠️ 先真的跑起来，否则「停轮询」断言恒真
    assert.equal(hidden.clock.intervals(), 1, '可见时有轮询');
    hidden.document.hidden = true;                 // 真正的「切走」
    hidden.app.onSyncVisibilityChange();
    assert.equal(hidden.clock.intervals(), 0, '隐藏后没有轮询在跑');
    const before = hidden.calls.gets.length;
    hidden.app.onSyncVisibilityChange();
    await hidden.clock.advance(CONSTANTS.SYNC_POLL_MS * 2);
    await hidden.flush();
    assert.equal(hidden.calls.gets.length, before, '隐藏期间不检查');
});

test('上传确认只认「实际发出去的那一版」：在途期间又改了就不能显示已同步', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = makeHarness({ post: async body => { await gate; return { success: true, revision: body.revision + 1, generation: 1 }; } });
    h.app.markSyncDirty();
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush(2);
    const sentPayloadKey = h.calls.posts[0] ? h.localStore.snapshot().pending.payloadKey : null;
    // 打包时的指纹 = 改内容**之前**的指纹（这是「确认的是哪一份内容」的落点）
    assert.equal(sentPayloadKey, h.app.syncPayloadKey(), '待上传里记的是打包那一刻的内容指纹');
    // 在途期间本机又改了（内容指纹跟着变）
    h.app.config.theme = 'dark';   // 真改内容：指纹跟着变
    release();
    await h.flush();
    const record = h.localStore.snapshot();
    // 已发出去的那一份清掉（它已经落上去了），期间产生的新内容由下一轮重新打包。
    // 留着旧 pending 换个基线会变成「同 ID 换内容」→ 服务端 409 operation_conflict；
    // 连基线都不换则会一直被当成重放，新内容永远传不上去（两个都踩过）。
    assert.equal(record.pending, null, '成功之后清掉已发送的那一份');
    // 六词表里没有「在线但有未上传改动」，那种情况用「同步中」（确实在等下一轮）
    assert.equal(h.app.syncStatus, 'syncing', '还有没传完的，就不能显示已同步');
    assert.equal(record.uploadedPayloadKey, sentPayloadKey, '记下这一次确认的是哪一份内容');
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush();
    assert.equal(h.calls.posts.length, 2, '新内容会再发一次');
    assert.notEqual(h.calls.posts[1].body.operationId, h.calls.posts[0].body.operationId,
        '必须换一个新的 operationId——同一个 ID 只能配同一份内容');
    assert.equal(h.calls.posts[1].body.revision, h.calls.posts[0].body.revision + 1, '基线是刚拿到的 revision');
    assert.equal(h.app.syncStatus, 'synced', '第二轮传完且没有新改动 → 已同步');

    // 对照：没有后续修改时清 pending 并置已同步
    const h2 = makeHarness();
    h2.app.markSyncDirty();
    await h2.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h2.flush();
    assert.equal(h2.localStore.snapshot().pending, null, '确认后清掉待上传');
    assert.equal(h2.app.syncStatus, 'synced');
    assert.ok(h2.localStore.snapshot().lastSuccessAt, '记下最近成功时间');
});

test('迟到响应不覆盖新修改：飞行期间本机改了就丢弃读结果', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = makeHarness({ get: async () => { await gate; return { revision: 9, generation: 1, updatedAt: 5000, config: { theme: 'dark' }, modules: {} }; } });
    const pulling = h.app.syncPullCheck();
    await h.flush(2);
    h.app.config.theme = 'light';         // 期间本机改了（内容指纹变了）
    release();
    await pulling;
    await h.flush();
    assert.equal(h.app.adopted, undefined, '不得采用云端内容');
    assert.notEqual(h.app.config.theme, 'dark');
});

test('多标签页：认领还活着就不动手；没人应答（标签页已关/刷新）就接手', async () => {
    // ① 另一个**活着**的标签页持有认领：问一声它会应答，本标签页不发。
    const held = makeHarness({ record: seedRecord({ claim: { id: 'tab-other', at: 1000000 } }) });
    held.channel.holder = 'tab-other';
    held.app.markSyncDirty();
    await held.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await held.flush(30);
    assert.equal(held.calls.posts.length, 0, '别人在传，我不发');
    assert.ok(held.channel.posted.some(m => m.type === 'claim-check'), '要先问一声而不是只看时间戳');

    // ② 认领新鲜但**没人应答**（那个标签页已经关了/刷新了）：等一小会儿就接手。
    //    这一条正是浏览器实测抓到的毛病：只看时间戳会让重开后白等最多 15 秒。
    const stale = makeHarness({ record: seedRecord({ claim: { id: 'tab-dead', at: 1000000 } }) });
    stale.app.markSyncDirty();
    await stale.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await stale.flush(4);
    assert.equal(stale.calls.posts.length, 0, '还在等应答');
    await stale.clock.advance(CONSTANTS.SYNC_CLAIM_PING_MS + 10);
    await stale.flush(30);
    assert.equal(stale.calls.posts.length, 1, '没人应答就接手，不必等满 TTL');
});

test('认领握手：持有者收到询问会应答「还是我的」', async () => {
    const h = makeHarness();
    h.app.bindSyncChannel();                     // 真实现
    h.app.syncClaim = { id: h.app.syncTabId, at: Date.now() };
    h.channel.receive({ type: 'claim-check', id: h.app.syncTabId });
    assert.ok(h.channel.posted.some(m => m.type === 'claim-held' && m.id === h.app.syncTabId), '持有者要应答');
    // 不是我的认领就不应答（否则两个标签页会互相把对方当成持有者）
    h.channel.posted.length = 0;
    h.channel.receive({ type: 'claim-check', id: 'tab-other' });
    assert.equal(h.channel.posted.length, 0, '不是我的认领不该应答');
});

test('有草稿时不采用云端内容，只提示', async () => {
    const h = makeHarness({ get: async () => ({ ...cloudOf({ theme: 'dark' }), revision: 9, updatedAt: 5000 }) });
    h.app.editLayout = true;
    await h.app.syncPullCheck();
    await h.flush();
    assert.equal(h.app.adopted, undefined, '有草稿就不覆盖');
    // 状态词说的是**已保存配置**的同步情况：本机这一版确实已经传上去了，
    // 未保存的草稿不在同步范围内（设计 §5「输入中的未完成文本不进入同步」），
    // 所以这里仍是「已同步」，但必须**说出来**云端更新过、编辑被保留了。
    assert.notEqual(h.app.syncStatus, 'conflict');
    assert.equal(h.app.syncStatus, 'synced');
    assert.ok(h.calls.toasts.some(t => /当前编辑已保留/.test(t.message)), '要说出来');
});

test('没有待上传也没有草稿时，较新的云端配置会被采用并落盘', async () => {
    const h = makeHarness({ record: seedRecord(), get: async () => ({ ...cloudOf({ theme: 'dark' }), revision: 9, updatedAt: 5000 }) });
    await h.app.syncPullCheck();
    await h.flush();
    assert.equal(h.app.adopted, 9, '采用云端');
    assert.equal(h.app.syncStatus, 'synced');
    assert.equal(h.localStore.snapshot().connection.revision, 9, '连接记录里的版本跟上');
    assert.ok(h.localStore.snapshot().recovery, '被替换的本机那一份要先留好');
});

test('24 小时之外的回执：先核对内容，一致就收工、不同才进冲突', async () => {
    const aged = { operationId: 'op-aged', content: { config: cloudOf({ theme: 'dark' }).config, modules: { enabled: [], widgets: [], settings: {} } }, localRevision: 7, baseRevision: 3, createdAt: 1000000 - CONSTANTS.SYNC_RECEIPT_WINDOW_MS - 1 };
    // ① 云端内容与待上传一致 → 视为已生效，清 pending
    const same = makeHarness({ record: seedRecord({ pending: aged }), get: async () => ({ ...cloudOf({ theme: 'dark' }), revision: 9, updatedAt: 1 }) });
    same.app.syncPending = aged;
    await same.app.uploadOnce();
    await same.flush();
    assert.equal(same.calls.posts.length, 0, '过期回执不盲目重提');
    assert.equal(same.localStore.snapshot().pending, null, '内容已经一致 → 当作已生效');
    assert.equal(same.app.syncStatus, 'synced');

    // ② 云端内容不同 → 进冲突，两边都保留
    const diff = makeHarness({ record: seedRecord({ pending: aged }), get: async () => ({ ...cloudOf({ theme: 'light' }), revision: 9, updatedAt: 1 }) });
    diff.app.syncPending = aged;
    await diff.app.uploadOnce();
    await diff.flush();
    assert.equal(diff.calls.posts.length, 0, '同样不重提');
    assert.equal(diff.app.syncStatus, 'conflict');
    assert.equal(diff.app.syncConflict.local.config.theme, 'dark', '本机候选保留');
    assert.equal(diff.app.syncConflict.cloud.config.theme, 'light', '云端候选保留');
});

test('409 先核对再报冲突：云端内容与我们正要发的一致时不算冲突', async () => {
    const h = makeHarness({
        post: async () => { throw Object.assign(new Error('配置已改变'), { status: 409, code: 'revision_conflict' }); },
        get: async () => ({ ...cloudOf(), revision: 9, updatedAt: 1 })
    });
    h.app.markSyncDirty();
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush();
    assert.equal(h.app.syncStatus, 'synced', '内容其实已经落上去了，不该弹冲突');
    assert.equal(h.localStore.snapshot().pending, null);

    // 内容不同 → 真的冲突
    const h2 = makeHarness({
        post: async () => { throw Object.assign(new Error('配置已改变'), { status: 409, code: 'revision_conflict' }); },
        get: async () => ({ ...cloudOf({ theme: 'light' }), revision: 9, updatedAt: 1 })
    });
    h2.app.markSyncDirty();
    await h2.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h2.flush();
    assert.equal(h2.app.syncStatus, 'conflict');
    assert.ok(h2.app.syncConflict.local && h2.app.syncConflict.cloud);
    assert.equal(h2.localStore.snapshot().pending.operationId, 'op-1', '冲突时 pending 仍留着');
});

test('同 operationId 换内容（operation_conflict）不静默重试，直接说出来', async () => {
    const h = makeHarness({ post: async () => { throw Object.assign(new Error('同一操作标识不能提交不同内容'), { status: 409, code: 'operation_conflict' }); } });
    h.app.markSyncDirty();
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush();
    assert.equal(h.app.syncStatus, 'failed');
    assert.equal(h.localStore.snapshot().pending, null, '丢弃这份自相矛盾的 pending');
    assert.ok(h.calls.toasts.some(t => /不一致/.test(t.message)));
    assert.equal(h.calls.posts.length, 1, '不得自动重试（重试只会一直 409）');
});

test('连接代次不再匹配 → 清连接并要求重新输入口令', async () => {
    const h = makeHarness({ post: async () => { throw Object.assign(new Error('设备授权已变化'), { status: 409, code: 'generation_mismatch' }); } });
    h.app.markSyncDirty();
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush();
    assert.equal(h.app.syncConnection, null, '连接被清掉');
    assert.equal(h.app.syncStatus, 'local');
    assert.ok(h.localStore.snapshot().connection === null, '盘上的连接也清了');
});

test('轮询：可见时按周期检查，隐藏时不跑，连接没了就停', async () => {
    const h = makeHarness();
    h.app.startSyncPolling();
    const before = h.calls.gets.length;
    await h.clock.advance(CONSTANTS.SYNC_POLL_MS * 3 + 10);
    await h.flush();
    assert.equal(h.calls.gets.length - before, 3, `可见时每 ${CONSTANTS.SYNC_POLL_MS}ms 一次`);
    h.app.stopSyncPolling();
    const stopped = h.calls.gets.length;
    await h.clock.advance(CONSTANTS.SYNC_POLL_MS * 3);
    await h.flush();
    assert.equal(h.calls.gets.length, stopped, '停掉之后不再检查');
});

test('管理员会话生效期间暂停调度；回到普通上下文再恢复', async () => {
    const h = makeHarness();
    h.app.startSyncPolling();
    assert.equal(h.clock.intervals(), 1, '有轮询在跑');
    h.app.pauseSyncForAdmin();
    assert.equal(h.clock.intervals(), 0, '暂停后没有定时器');
    h.app.authenticated = false;
    h.app.syncPending = null;
    h.app.resumeSyncAfterAdmin();
    assert.equal(h.clock.intervals(), 1, '恢复轮询');
});

test('冲突裁决：两个方向都会先保住被覆盖的那一份', async () => {
    const h = makeHarness({ get: async () => ({ ...cloudOf({ theme: 'dark' }), revision: 9, updatedAt: 1 }) });
    h.app.syncConflict = { local: { config: cloudOf({ theme: 'light' }).config, modules: {} }, cloud: { config: cloudOf().config, modules: {} }, baseRevision: 9, updatedAt: 1 };
    h.app.syncStatus = 'conflict';
    h.app.localRevision = 7;
    await h.app.resolveSyncConflict('cloud');
    await h.flush();
    assert.equal(h.app.adopted, 9, '采用云端');
    assert.ok(h.localStore.snapshot().recovery, '被替换的本机那一份留下来了');
    assert.equal(h.app.syncStatus, 'synced');
    assert.equal(h.calls.posts.length, 0, '采用云端是读方向，不发写请求');
});

test('冲突裁决「保留本机」：也要把被覆盖的云端那一份留在本机', async () => {
    const h = makeHarness({ record: seedRecord({ recovery: null }) });
    const cloudConfig = cloudOf({ theme: 'dark' }).config;
    h.app.syncConflict = { local: { config: cloudOf({ theme: 'light' }).config, modules: {} }, cloud: { config: cloudConfig, modules: { enabled: [], widgets: [], settings: {} } }, baseRevision: 9, updatedAt: 1 };
    h.app.syncStatus = 'conflict';
    h.app.localRevision = 7;
    await h.app.resolveSyncConflict('local');
    await h.flush();
    const recovery = h.localStore.snapshot().recovery;
    assert.ok(recovery, '必须留一份被替换的副本');
    assert.equal(recovery.direction, 'cloud', '被覆盖的是云端那一份');
    assert.equal(recovery.config.theme, 'dark');
    assert.equal(h.calls.posts.length, 1, '保留本机要走一次写');
    assert.equal(h.calls.posts[0].body.revision, 9, '基线用检查时拿到的云端 revision');
});

test('重开页面：已保存但没上传过的本地修订会被补传出去', async () => {
    // 夹具模拟「本地修订 9、上一次确认上传的是 7」（页面在防抖窗口里被关掉）
    const h = makeHarness({ record: seedRecord({ uploadedPayloadKey: 'k7' }) });
    const before = h.app.syncPayloadKey();
    h.app.config.theme = 'dark';            // 本地内容变了 → 指纹变
    assert.notEqual(h.app.syncPayloadKey(), before);
    h.app.syncPending = null;
    // 走**真实的** loadSyncState（重开页面的那条路径）：补传必须由它自己排出来，
    // 而不是用例替它排——手动调 scheduleSyncUpload 的话，这条分支删掉也照样绿。
    await h.app.loadSyncState();
    await h.flush();
    assert.equal(h.app.adopted, undefined, '云端没变就不该采用（那会把本地这次改动抹掉）');
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush();
    assert.equal(h.calls.posts.length, 1, '必须把没上传过的本地修订补传');
    assert.equal(h.app.syncStatus, 'synced');
});

test('云端版本比本机已知的更旧时不采用（revision 单调，更小只可能是过期响应）', async () => {
    const h = makeHarness({ get: async () => ({ ...cloudOf({ theme: 'dark' }), revision: 1, updatedAt: 1 }) });
    await h.app.syncPullCheck();
    await h.flush();
    assert.equal(h.app.adopted, undefined, '不得用更旧的版本覆盖本机');
    assert.equal(h.app.syncStatus, 'synced');
});

test('清除连接会递增本机连接代次，之后旧连接的响应一律作废', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = makeHarness({ post: async body => { await gate; return { success: true, revision: body.revision + 1, generation: 1 }; } });
    const epochBefore = h.app.syncConnEpoch;
    h.app.markSyncDirty();
    await h.clock.advance(CONSTANTS.SYNC_DEBOUNCE_MS + 10);
    await h.flush();
    assert.equal(h.calls.posts.length, 1, '上传在途');

    // 连接在这时被清掉（#9 的停止同步走同一条路）
    await h.app.clearSyncConnection('手动断开');
    assert.equal(h.app.syncConnEpoch, epochBefore + 1, '连接代次必须递增');
    assert.equal(h.app.syncConnection, null);

    // 旧连接的那次上传这时才回来：不得清 pending、不得改状态、不得写回记录
    const recordAfterClear = h.localStore.snapshot().revision;
    release();
    await h.flush(20);
    assert.equal(h.app.syncStatus, 'local', '旧响应不许把状态改回去');
    assert.equal(h.localStore.snapshot().revision, recordAfterClear, '旧响应不许再写记录');
});

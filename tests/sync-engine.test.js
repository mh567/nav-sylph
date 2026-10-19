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
    'SYNC_BACKOFF_MAX_MS', 'SYNC_CLAIM_TTL_MS', 'SYNC_CLAIM_PING_MS', 'SYNC_RECEIPT_WINDOW_MS',
    // #10：总暂停期间的轮询间隔。必须**从源码解析**并注入——不注入的话 applySyncHalt 在
    // 「总暂停」那条分支上会直接 ReferenceError，而「停用」那条因为是短路求值才躲过去。
    'SYNC_PAUSED_POLL_MS',
    'SYNC_PASSPHRASE_MIN', 'SYNC_PASSPHRASE_MAX'];
const CONSTANTS = Object.fromEntries(CONST_NAMES.map(name => {
    const parsed = new RegExp(`const ${name} = (\\d+)`).exec(cleanApp);
    assert.ok(parsed, `解析出 ${name}`);
    return [name, Number(parsed[1])];
}));
// 口令派生标签是字符串常量，但同样是「真代码读的东西」，一样从源码解析。
const CONNECT_LABEL = (() => {
    const parsed = /const CONNECT_LABEL = '([^']*)'/.exec(cleanApp);
    assert.ok(parsed, '解析出 CONNECT_LABEL');
    return parsed[1];
})();
const CONST_SOURCE = CONST_NAMES.map(name => `const ${name} = ${CONSTANTS[name]};`).join('\n')
    + `\nconst CONNECT_LABEL = ${JSON.stringify(CONNECT_LABEL)};`;

const METHODS = [
    'hasLocalDraft', 'setSyncStatus', 'markSyncDirty', 'scheduleSyncUpload', 'startSyncUpload',
    'syncBackoffNext', 'scheduleSyncRetry', 'syncPayload', 'syncContentEqual', 'persistSyncRecord',
    'ensureSyncPending', 'acquireSyncClaim', 'releaseSyncClaim', 'uploadOnce', 'confirmSyncUpload',
    'handleSyncUploadFailure', 'handleSyncConflict', 'fetchSyncCloud', 'reconcileAgedPending',
    'syncPullCheck', 'applyCloudConfig', 'startSyncPolling', 'stopSyncPolling', 'stopSyncTimers',
    'syncSettledStatus', 'syncPayloadKey', 'syncClaimHeldElsewhere', 'loadSyncState', 'bindSyncChannel',
    'onSyncVisibilityChange', 'onSyncOnline', 'onSyncOffline', 'pauseSyncForAdmin', 'resumeSyncAfterAdmin', 'notifySyncPeers', 'resolveSyncConflict', 'clearSyncConnection',
    'writeSyncWithEpochRetry', 'refreshSyncRecord', 'stopSyncLocal', 'syncTerminalOf', 'handleSyncTerminal', 'applySyncHalt', 'retrySyncAfterHalt',
    'canRunOrdinarySync', 'syncContextSnapshot', 'syncContextHeld', 'waitForSession', 'resumeOrdinarySync',
    'confirmStopSync', 'requestDeleteSpace', 'confirmDeleteSpace', 'openSyncDialog',
    'finishSyncConnection', 'persistSyncConnection', 'writeCloudConfig', 'syncCheckQuiet',
    'deriveSyncProof', 'validateSyncPassphrase'
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
        async writeSync(patch, revision, expectedEpoch) {
            const current = record || { revision: 0 };
            if ((current.revision || 0) !== revision) throw Object.assign(new Error('其他地方改过了'), { code: 'conflict' });
            // 连接代次的比较在**事务内**——与 local-navigation.js 同语义。夹具不建模
            // 这一条的话，「迟到的落盘被拒」这条验收在测试里根本不存在（假货比真货宽松）。
            if (expectedEpoch !== undefined && (current.connEpoch || 0) !== expectedEpoch) {
                throw Object.assign(new Error('连接状态已变化'), { code: 'epoch' });
            }
            const next = { schemaVersion: 1, revision: revision + 1,
                connEpoch: Object.prototype.hasOwnProperty.call(patch || {}, 'connEpoch') ? (patch.connEpoch || 0) : (current.connEpoch || 0) };
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
        // #11 身份上下文：夹具默认「身份已确认、不在管理员上下文、没有未决草稿」，
        // 这样普通同步能跑；要测门的用例自己把这几个字段改掉。
        identityPending: false,
        sessionProbe: null,
        privateEpoch: 0,
        suspendedAdministrator: null,
        // #9：删除挡板（删除期间暂停上传）与停用挡板（空间被管理员停用后不再自动重试）
        // #10：停用挡板记住的是**哪一种暂停**（`'disabled' | 'paused'`），未暂停时是 null
        // ——与 public/app.js 的初始值逐字一致，别在这里造出 `false` 这种真代码不会有的值。
        syncDeleting: false,
        syncHalted: null,
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
        syncState: 'disconnected',
        localSettingsChanged: () => false,
        localModulePayload: () => ({ enabled: [], widgets: [], settings: {} }),
        markSyncEntry: () => {},
        renderSyncDialog: () => {},
        showToast: (message, kind) => calls.toasts.push({ message, kind }),
        // 这里**不再**用桩：clearSyncConnection 是「代次递增」这条不变式的落点，
        // 用桩就把它自己换掉了（本轮第一版就是这样，测试看不见真实现）。

        adoptCloudConfig: async cloud => { app.config = cloud.config; app.adopted = cloud.revision; },
        // 忠实到能读回状态：桩成空函数的话，「连接到底建没建起来」在夹具里就看不见了
        // （本轮就是这么漏掉一个真缺陷的）。
        setSyncState: (state, message = '') => { app.syncState = state; app.syncError = message; }
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
    const documentStub = {
        hidden: false,
        querySelector: () => (options.openDialog ? {} : null),
        // 删除确认框里的口令输入：用例通过 `options.deletePassphrase` 提供。
        getElementById: id => (id === 'syncDeletePassphrase' && options.deletePassphrase !== undefined
            ? { value: options.deletePassphrase } : null)
    };
    const navigatorStub = { onLine: options.onLine !== false };
    // 口令派生走真实现（`deriveSyncProof` + 真的 SHA-256），所以 window.crypto
    // 给的是 Node 的 webcrypto——给个假 digest 就等于把「证明怎么算出来的」这条
    // 链路换掉了；这里只有它是真的，服务端的 proofId 才对得上。
    const windowStub = { NavigationSchema: { publicConfig: value => value, validate: () => {} }, crypto: require('node:crypto').webcrypto, BroadcastChannel: function () { return channel; } };
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
    schemaVersion: 1, revision: 1, connEpoch: 0,
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
    // #11 起恢复是「先协调云端、再续传、最后起轮询」的异步流程（顺序反了会对着
    // 已被别的设备推进过的基线白打一轮），所以这里要 await，不能同步断言。
    await h.app.resumeOrdinarySync();
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

// ==================== #9：停止同步与删除云端空间 ====================

test('停止同步：一次事务递增连接代次并清掉凭据与待上传，本地导航与替换前的副本留下', async () => {
    const recovery = { direction: 'cloud', savedAt: 5, config: { theme: 'dark' }, modules: { enabled: [], widgets: [], settings: {} } };
    const pending = { operationId: 'op-9', baseRevision: 3, createdAt: 1, payloadKey: 'k7', content: { config: FULL_CONFIG, modules: {} } };
    const h = makeHarness({ record: seedRecord({ recovery, pending }) });
    const before = h.localStore.snapshot();
    const localRevisionBefore = h.app.localRevision;
    const configBefore = JSON.stringify(h.app.config);
    // 先让定时器真的活着再停：不然「停下轮询」那条断言在空夹具上恒真
    // （本仓库对「守卫必须能变红」的要求）。
    h.app.startSyncPolling();
    h.app.scheduleSyncUpload();
    assert.ok(h.clock.intervals() > 0, '停止前轮询在跑');
    assert.ok(h.clock.pending() > 0, '停止前有排着的上传');

    const token = await h.app.stopSyncLocal();
    const after = h.localStore.snapshot();

    assert.equal(after.connEpoch, before.connEpoch + 1, '连接代次要 +1');
    assert.equal(after.revision, before.revision + 1, '整个断开只写一次事务（修订号只走一格）');
    assert.equal(after.connection, null, '凭据清掉');
    assert.equal(after.pending, null, '待上传任务清掉');
    assert.equal(after.claim, null, '跨标签页的认领清掉');
    assert.equal(after.uploadedPayloadKey, null);
    assert.deepEqual(after.recovery, recovery, '替换前的副本要留下（停止不是撤销替换）');
    assert.equal(after.config, undefined, '同步记录里不该有导航内容——本地导航根本不在这个存储里');
    assert.equal(h.app.localRevision, localRevisionBefore, '本地导航修订号不动');
    assert.equal(JSON.stringify(h.app.config), configBefore, '本地导航内容不动');
    assert.equal(h.app.syncStatus, 'local');
    assert.equal(h.clock.intervals(), 0, '轮询要停下来');
    assert.equal(h.clock.pending(), 0, '排着的上传定时器也要清掉');
    assert.ok(h.channel.posted.some(m => m.type === 'stopped'), '要通知其它标签页取消调度');
    assert.equal(token, 'tok'.repeat(20), '撤销用的是刚才那把令牌');
    assert.equal(h.calls.posts.filter(p => p.url === '/api/sync/device/revoke').length, 1, '在线时尽力撤销本设备令牌');
});

test('离线停止：撤销请求不发，但本地断开照样完成', async () => {
    const h = makeHarness({ onLine: false });
    await h.app.stopSyncLocal();
    assert.equal(h.localStore.snapshot().connection, null, '离线也必须能停止');
    assert.equal(h.calls.posts.filter(p => p.url === '/api/sync/device/revoke').length, 0, '离线不发撤销请求');
});

test('别的标签页停止后，本标签页迟到的落盘被拒，凭据不会被写回', async () => {
    // ① 真实情形：那边的停止推进了修订号，这一侧的每次落盘都会先撞上修订号 CAS。
    const h = makeHarness();
    const before = h.localStore.snapshot();
    h.localStore.seed({ ...before, revision: before.revision + 1, connEpoch: before.connEpoch + 1, connection: null, pending: null, claim: null });
    assert.equal(h.app.syncConnEpoch, 0, '本标签页内存里还停在旧代次（它不知道那边停了）');
    await assert.rejects(() => h.app.persistSyncRecord({
        connection: { spaceId: 'space-1', deviceToken: 'tok'.repeat(20), generation: 1, revision: 4 }
    }));
    let after = h.localStore.snapshot();
    assert.equal(after.connection, null, '存储里的连接没有被写回');
    assert.equal(after.revision, before.revision + 1, '被拒的写入没有推进修订号');

    // ② 修订号恰好一致的情形：这时**只有**连接代次能挡住它。这一条钉的是新守卫
    //    自己的契约——没有它的话，将来任何「代次变了但修订号没变」的路径都会
    //    静默把旧凭据写回去（本仓库对「守卫必须能变红」的要求）。
    const h2 = makeHarness();
    const seed2 = h2.localStore.snapshot();
    h2.localStore.seed({ ...seed2, connEpoch: seed2.connEpoch + 1, connection: null, pending: null, claim: null });
    await assert.rejects(() => h2.app.persistSyncRecord({
        connection: { spaceId: 'space-1', deviceToken: 'tok'.repeat(20), generation: 1, revision: 4 }
    }), error => error.code === 'epoch');
    assert.equal(h2.localStore.snapshot().connection, null);
    assert.equal(h2.localStore.snapshot().connEpoch, seed2.connEpoch + 1, '代次没有被倒回去');
});

test('删除期间暂停上传：脏标记与排程都不生效', async () => {
    const h = makeHarness();
    h.app.syncDeleting = true;
    h.app.markSyncDirty();
    h.app.scheduleSyncUpload();
    assert.equal(h.clock.pending(), 0, '删除期间不排任何上传定时器');
    await h.app.startSyncUpload();
    assert.equal(h.calls.posts.length, 0, '删除期间一次请求都不发');
});

test('删除/停用开始时已经排好的那一轮，到期也不许发出去', async () => {
    const h = makeHarness();
    // 先排一轮（模拟「用户刚改完，500ms 防抖还没到，接着点了删除」）
    h.app.markSyncDirty();
    const scheduled = h.clock.pending();
    assert.ok(scheduled > 0, '删除前确实排着上传');
    h.app.syncDeleting = true;
    // 让定时器到期：排程那一刻的守卫挡不住这一轮，得靠发请求那一处的守卫。
    await h.clock.advance(1000);
    assert.equal(h.calls.posts.length, 0, '删除期间到期的那一轮不许发请求');
    // 空间被停用同理（停用不停在排程那一刻，而是发请求那一刻）。
    const h2 = makeHarness();
    h2.app.markSyncDirty();
    assert.ok(h2.clock.pending() > 0);
    h2.app.syncHalted = true;
    await h2.clock.advance(1000);
    assert.equal(h2.calls.posts.length, 0, '空间停用后到期的那一轮不许发请求');
});

test('删除云端空间：第一次网络不确定，第二次拿到「已删除」就按删除收尾（不重建）', async () => {
    let attempt = 0;
    const recovery = { direction: 'local', savedAt: 11, config: { theme: 'light' }, modules: {} };
    const h = makeHarness({
        deletePassphrase: 'Correct-Passphrase-1',
        record: seedRecord({ recovery }),
        // 第 1 次网络错（结果不确定），第 2 次明确回答「空间已不存在」——
        // 这就是设计要求的那次核对，不需要额外的查询接口。
        post: () => {
            attempt++;
            if (attempt === 1) throw Object.assign(new Error('网络中断'), { status: 0 });
            throw Object.assign(new Error('云端空间已被删除'), { status: 410, code: 'space_deleted' });
        }
    });
    const localRevisionBefore = h.app.localRevision;
    await h.app.confirmDeleteSpace();
    assert.equal(attempt, 2, '结果不确定要再试一次');
    assert.equal(h.localStore.snapshot().connection, null, '核对确认已删除 → 本地断开');
    assert.deepEqual(h.localStore.snapshot().recovery, recovery, '本机保留的副本留下');
    assert.equal(h.app.localRevision, localRevisionBefore, '本地导航不动');
    assert.equal(h.calls.posts.filter(p => p.url === '/api/sync/space/create').length, 0, '任何路径都不重建空间');
    assert.equal(h.app.syncError, '', '收尾不留错误提示');
});

test('删除云端空间：口令不正确就保留连接，什么都不删', async () => {
    const h = makeHarness({
        deletePassphrase: 'Wrong-Passphrase-1',
        post: () => { throw Object.assign(new Error('口令不正确，未删除任何内容'), { status: 403, code: 'proof_mismatch' }); }
    });
    await h.app.confirmDeleteSpace();
    assert.equal(h.localStore.snapshot().connection !== null, true, '口令错不能断开连接');
    assert.match(h.app.syncError, /口令不正确/);
    assert.equal(h.calls.posts.filter(p => p.url === '/api/sync/space/delete').length, 1, '口令错不重试（重试没有意义）');
    assert.equal(h.app.syncDeleting, false, '失败后挡板要撤掉，否则上传永远停摆');
    // 失败分支**也不能**去建新空间（否则「拒绝创建就不该触发错误重建」这条就落空了）
    assert.equal(h.calls.posts.filter(p => p.url === '/api/sync/space/create').length, 0, '失败路径不重建空间');
});

test('空间被管理员停用：保留连接、停自动重试，本地编辑不再排上传', async () => {
    const h = makeHarness({ get: () => { throw Object.assign(new Error('空间已停用'), { status: 403, code: 'space_disabled' }); } });
    await h.app.syncPullCheck();
    assert.equal(h.localStore.snapshot().connection !== null, true, '停用不等于断开：连接与凭据都留着');
    // #10：`syncHalted` 从布尔升级成**原因字符串**（`'disabled' | 'paused'`）——停用与
    // 总暂停的对话框文案不同，必须记住是哪一种。真值语义不变（`if (this.syncHalted)`
    // 照旧成立），所以这里钉的是具体原因，不是「随便一个真值」。
    assert.equal(h.app.syncHalted, 'disabled');
    assert.equal(h.clock.intervals(), 0, '停自动重试');
    // 文案要点名「停用」这个**状态**（而不是笼统的「连接已失效」——那会让用户
    // 去重新输口令，而这里重新输口令根本没用）。注意断言用「停用」两字：
    // 实际文案是「已被管理员停用」，「已停用」并不是它的子串。
    const haltToast = h.calls.toasts.map(t => t.message).find(m => /停用/.test(m));
    assert.ok(haltToast, '要说清是停用，不是笼统的失败');
    assert.doesNotMatch(haltToast, /重新输入口令|连接已失效/);
    h.app.markSyncDirty();
    assert.equal(h.clock.pending(), 0, '停用后本地编辑不再排上传（否则对着 403 无限退避）');
});

test('空间已被删除：读路径判为终态 → 本地断开、保留本地导航、文案说清是删除', async () => {
    const h = makeHarness({ get: () => { throw Object.assign(new Error('云端空间已被删除'), { status: 410, code: 'space_deleted' }); } });
    const recovery = { direction: 'local', savedAt: 7, config: {}, modules: {} };
    await h.app.persistSyncRecord({ recovery });
    await h.app.syncPullCheck();
    assert.equal(h.localStore.snapshot().connection, null, '终态要断开');
    assert.deepEqual(h.localStore.snapshot().recovery, recovery, '本地保留的副本不能跟着被清');
    assert.ok(h.calls.toasts.some(t => /云端空间已被删除/.test(t.message)), '文案要区分「删除」与「连接失效」');
});

test('错误码映射：删除/撤销/过期/停用四种各有自己的话，且只有一处映射', () => {
    const h = makeHarness();
    assert.match(h.app.syncTerminalOf({ code: 'space_deleted' }).message, /已被删除/);
    assert.match(h.app.syncTerminalOf({ code: 'device_revoked' }).message, /这台设备/);
    assert.match(h.app.syncTerminalOf({ code: 'device_expired' }).message, /重新输入口令/);
    // #10：`halt` 是原因字符串而不是 `true`——停用与总暂停是两句不同的话。
    assert.equal(h.app.syncTerminalOf({ code: 'space_disabled' }).halt, 'disabled');
    assert.equal(h.app.syncTerminalOf({ code: 'sync_paused' }).halt, 'paused',
        '总暂停要与停用区分开（两者都真值，但不是同一件事）');
    assert.equal(h.app.syncTerminalOf({ status: 500 }), null, '普通失败不是终态，交给退避');
    // 「只有一处映射」由 tests/sync-client.test.js 的那条守卫拥有：它逐句统计
    // app.js 里的出现次数。这里不再重复，更不能用「>= 1」这种恒真的形式充当唯一性。
});

test('连接成功时，代次递增与写入连接必须在同一次落盘里（否则刚连上就「同步失败」）', async () => {
    // 这一条钉的是真实浏览器验收抓到的缺陷：finishSyncConnection 曾经只在**内存**里
    // 把代次 +1，记录里的还是旧值，于是连接建好之后每一次落盘都被事务拒掉
    // （症状：刚连上 → 立刻显示「同步失败」，而连接其实已经在盘上了）。
    const h = makeHarness({ record: seedRecord({ connection: null, pending: null, uploadedPayloadKey: null }) });
    h.app.syncConnection = null;
    h.app.syncConnEpoch = 0;
    await h.app.finishSyncConnection(
        { spaceId: 'space-1', deviceToken: 'tok'.repeat(20), generation: 1, revision: 4 },
        'local'
    );
    const record = h.localStore.snapshot();
    assert.equal(h.app.syncState, 'connected', '连接要真的建立');
    assert.equal(record.connEpoch, 1, '代次落盘了');
    assert.equal(h.app.syncConnEpoch, record.connEpoch, '内存与记录里的代次必须一致');
    // 连接之后的落盘不许再被代次挡住（这正是那个缺陷的症状）
    await h.app.persistSyncRecord({ uploadedPayloadKey: 'k7' });
    assert.equal(h.localStore.snapshot().uploadedPayloadKey, 'k7');
});

test('另一个标签页刚停止时，本标签页的连接不会被写回去（代次 CAS 拦住连接落盘）', async () => {
    const h = makeHarness({ record: seedRecord({ connection: null, pending: null, uploadedPayloadKey: null }) });
    h.app.syncConnection = null;
    h.app.syncConnEpoch = 0;
    // 另一个标签页在同一时刻停止了同步：记录里的代次推进到 1（修订号保持不变，
    // 这样撞上的必然是代次那一条守卫）。
    const seed = h.localStore.snapshot();
    h.localStore.seed({ ...seed, connEpoch: 1, connection: null });
    await h.app.finishSyncConnection(
        { spaceId: 'space-1', deviceToken: 'tok'.repeat(20), generation: 1, revision: 4 },
        'local'
    );
    assert.equal(h.localStore.snapshot().connection, null, '迟到的那份凭据不能写回记录');
    assert.equal(h.localStore.snapshot().connEpoch, 1, '代次没有被倒回去');
    assert.match(h.app.syncError, /其它标签页/, '要告诉用户重来一次，而不是笼统的失败');
});

test('删除时凭据已经失效：按终态断开，不是挂着一把死令牌反复报「删除失败」', async () => {
    const h = makeHarness({
        deletePassphrase: 'Correct-Passphrase-1',
        post: () => { throw Object.assign(new Error('设备凭据无效'), { status: 401, code: 'device_invalid' }); }
    });
    await h.app.confirmDeleteSpace();
    assert.equal(h.localStore.snapshot().connection, null, '死令牌要按终态断开');
    assert.ok(h.calls.toasts.some(t => /重新输入口令/.test(t.message)), '给的是能指导下一步的话');
    assert.equal(h.app.syncDeleting, false);
});

test('删除时空间被停用：保留连接、说清状态（不把「现在删不了」当成凭据失效）', async () => {
    const h = makeHarness({
        deletePassphrase: 'Correct-Passphrase-1',
        post: () => { throw Object.assign(new Error('该空间已停用'), { status: 403, code: 'space_disabled' }); }
    });
    await h.app.confirmDeleteSpace();
    assert.equal(h.localStore.snapshot().connection !== null, true, '停用不等于断开');
    assert.match(h.app.syncError, /停用/);
    assert.equal(h.app.syncHalted, 'disabled', '说了「已暂停」就要真的停下来（否则调度照常恢复，要等下一轮再撞 403）；#10 起还要记住是哪一种暂停');
    assert.equal(h.clock.intervals(), 0, '轮询也要停');
});

test('空间被停用后管理员恢复：点一次「立即同步」就解除挡板，停用期间的改动重新上传', async () => {
    let mode = 'disabled';
    const h = makeHarness({
        get: () => {
            if (mode === 'disabled') throw Object.assign(new Error('空间已停用'), { status: 403, code: 'space_disabled' });
            return h.app.syncCloud;
        }
    });
    h.app.syncUploadedPayloadKey = 'stale';   // 本机有一份还没传上去的内容
    await h.app.syncPullCheck();
    assert.equal(h.app.syncHalted, 'disabled', '停用要先落地，且记住是「停用」这一种');
    h.app.markSyncDirty();
    assert.equal(h.clock.pending(), 0, '停用期间本地编辑一次都不排上传');
    assert.equal(h.app.syncStatus, 'failed', '状态要说出来是停用');
    // 对话框要有自己的状态：落到 error 会渲染「口令 + 再输一次」表单，而这里输口令没用。
    assert.equal(h.app.syncState, 'halted');

    mode = 'ok';
    await h.app.retrySyncAfterHalt();     // 用户点「重试同步」
    assert.equal(h.app.syncHalted, null, '读成功 = 停用解除（挡板回到「没暂停」）');
    assert.ok(h.clock.intervals() > 0, '轮询接回来');
    assert.ok(h.clock.pending() > 0, '停用期间没排过的改动要补排');
    await h.clock.advance(1000);
    await flush();
    assert.ok(h.calls.posts.some(p => p.url === '/api/sync/config'), '补排的那一轮要真的发出去');
    assert.equal(h.app.syncState, 'connected', '解除停用后对话框回到已连接态');
});

test('代次被别的标签页推进过：认领时读回代次，上传不会卡死在「失败 + 退避」', async () => {
    const h = makeHarness();
    const seed = h.localStore.snapshot();
    h.localStore.seed({ ...seed, connEpoch: seed.connEpoch + 1 });   // 修订号对齐、只有代次变了
    assert.equal(h.app.syncConnEpoch, seed.connEpoch, '内存停在旧代次（广播没送达）');
    h.app.markSyncDirty();
    await h.clock.advance(1000);
    await flush();
    assert.equal(h.app.syncConnEpoch, seed.connEpoch + 1, '认领时要把代次读回内存');
    assert.notEqual(h.app.syncStatus, 'failed', '不该当成网络失败');
    assert.equal(h.app.syncRetryTimer, null, '不该排退避重试');
});

test('上传收尾遇到 epoch：重读记录并排下一轮，不当成网络失败去退避', async () => {
    const h = makeHarness();
    const seed = h.localStore.snapshot();
    h.localStore.seed({ ...seed, connEpoch: seed.connEpoch + 1 });
    await h.app.handleSyncUploadFailure(Object.assign(new Error('连接状态已变化'), { code: 'epoch' }));
    assert.equal(h.app.syncConnEpoch, seed.connEpoch + 1, '重读把代次同步回来');
    assert.equal(h.app.syncRetryTimer, null, '不走退避');
    assert.notEqual(h.app.syncStatus, 'failed');
});

test('本机断开落盘失败：不抛出去、明确说「断开未保存」，也不假装代次走过了', async () => {
    const h = makeHarness();
    const original = h.app.localStore.writeSync;
    h.app.localStore.writeSync = async () => { throw new Error('配额已满'); };
    const token = await h.app.stopSyncLocal();     // 不许 throw（调用点有 4 处，漏掉就是未处理的 rejection）
    h.app.localStore.writeSync = original;
    assert.equal(token, 'tok'.repeat(20));
    assert.match(h.app.syncError, /本机断开未保存/, '要说出来，别假装断开成功');
    assert.equal(h.app.syncConnEpoch, 0, '没写成功就不该动内存代次');
});

test('删除失败后把被清掉的那一轮上传接回来（否则页脚写「同步中」却没人传）', async () => {
    const h = makeHarness({
        deletePassphrase: 'Wrong-Passphrase-1',
        post: () => { throw Object.assign(new Error('口令不正确，未删除任何内容'), { status: 403, code: 'proof_mismatch' }); }
    });
    h.app.syncUploadedPayloadKey = 'stale';   // 本机有未上传内容
    await h.app.confirmDeleteSpace();
    // ⚠️ 断言要指名**上传**的定时器：`clock.pending()` 把轮询的 interval 也算进去，
    // 「只把轮询接回来、没补排上传」那种缺陷照样能通过（本仓库对守卫能变红的要求）。
    assert.ok(h.app.syncDebounceTimer || h.app.syncMaxWaitTimer, '失败后要按指纹补排一次上传');
});

test('收到别的标签页的停止通知：停表、回到未连接（不刷新页面）', async () => {
    const h = makeHarness();
    h.app.bindSyncChannel();      // 消息处理器是它装的；不调它就不是在测真实接线
    h.app.startSyncPolling();
    h.app.markSyncDirty();
    assert.ok(h.clock.intervals() > 0 && h.clock.pending() > 0, '先让调度真的活着');
    // 另一个标签页刚停止：记录里已经没有连接，随后投递 stopped 通知。
    const seed = h.localStore.snapshot();
    h.localStore.seed({ ...seed, revision: seed.revision + 1, connEpoch: seed.connEpoch + 1, connection: null, pending: null, claim: null });
    h.channel.receive({ type: 'stopped' });
    await flush(30);
    assert.equal(h.app.syncConnection, null, '内存里的连接清掉');
    assert.equal(h.app.syncPending, null);
    assert.equal(h.clock.intervals(), 0, '轮询停下');
    assert.equal(h.clock.pending(), 0, '排着的上传清掉');
    assert.equal(h.app.syncStatus, 'local');
    assert.equal(h.localStore.snapshot().connection, null);
});

test('总暂停：保留连接、换成 5 分钟慢轮询（不是停表），读成功即解除', async () => {
    // 为什么单独一条：`applySyncHalt('paused')` 若忘了传慢间隔（或干脆停表），
    // 恢复只能靠用户手动点——而设计要的是「暂停期间自己发现恢复」。
    const h = makeHarness();
    h.app.startSyncPolling();
    assert.equal(h.app.syncPollMs, CONSTANTS.SYNC_POLL_MS);
    h.app.applySyncHalt('paused', '同步服务已被管理员暂停，稍后会自动重试');
    assert.equal(h.app.syncHalted, 'paused');
    assert.equal(h.app.syncPollMs, CONSTANTS.SYNC_PAUSED_POLL_MS, '换成慢轮询');
    assert.ok(h.app.syncPollTimer, '不是把轮询停掉');
    assert.equal(h.localStore.snapshot().connection !== null, true, '总暂停不断开连接');

    // 读成功即解除（走真实 pull 路径）
    let paused = false;
    const h2 = makeHarness({ get: () => { if (paused) throw Object.assign(new Error('暂停'), { status: 503, code: 'sync_paused' }); return h2.app.syncCloud; } });
    paused = true;
    await h2.app.syncPullCheck();
    assert.equal(h2.app.syncHalted, 'paused', '503 让客户端进入暂停态');
    paused = false;
    await h2.app.syncPullCheck();
    assert.ok(!h2.app.syncHalted, '读成功即解除');
    assert.equal(h2.app.syncPollMs, CONSTANTS.SYNC_POLL_MS, '解除后回到正常轮询间隔');
});

test('额度拒绝（503 space_quota_exceeded）：不排退避、不丢 pending、不清连接', async () => {
    // 额度不会自己变松：对同一个 503 退避重试是白敲，而丢掉 pending 等于把
    // 用户还没传上去的修改扔了（那是最不该丢的东西）。正确做法是留住内容、
    // 说清「写满了」，等用户精简后的下一次改动自己重试。
    const h = makeHarness({
        post: () => { throw Object.assign(new Error('空间内容已达上限'), { status: 503, code: 'space_quota_exceeded' }); }
    });
    h.app.syncUploadedPayloadKey = 'stale';
    h.app.markSyncDirty();
    await h.clock.advance(1000);
    await flush();
    assert.ok(h.app.syncPending, '待上传内容要留着');
    assert.equal(h.app.syncRetryTimer, null, '不排退避重试');
    assert.equal(h.localStore.snapshot().connection !== null, true, '不清连接');
    assert.equal(h.app.syncStatus, 'failed');
    assert.ok(h.calls.toasts.some(t => /上限/.test(t.message)), '要告诉用户「写满了，先精简」');
    assert.ok(!h.calls.toasts.some(t => /同步失败/.test(t.message)), '不能塌成一句笼统的失败');
});

// ==================== #11：身份切换与上下文代次 ====================

test('迟到的拉取不能把管理员配置写进普通同步记录（落盘点要比上下文代次）', async () => {
    // 真实缺陷：只在**入口**判 authenticated，而响应回来时已经是管理员上下文——
    // 于是管理员个人导航被写进普通记录的 `recovery`（验收明令禁止的那一条）。
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = makeHarness({ get: async () => { await gate; return cloudOf({ theme: 'dark', revision: 9, categories: [{ id: 'admin', name: '管理员分类', bookmarks: [] }] }); } });
    // 本机没有未上传改动（否则会先被 `localDirty` 那条拦住，测不到上下文守卫）：
    // 云端更新 ⇒ 正常路径会采用云端并写 recovery。
    h.app.syncUploadedPayloadKey = h.app.syncPayloadKey();
    const recordBefore = JSON.stringify(h.localStore.snapshot());

    const pulling = h.app.syncPullCheck();
    // 拉取在飞期间登录管理员（真实的身份切换顺序：先处理草稿、再递增上下文代次）
    // 只切身份（`authenticated` + 上下文代次），**不**动 `this.config`：
    // 动它会先被「飞行期间本机又改了」那条指纹守卫拦住，测不到上下文守卫。
    h.app.authenticated = true;
    h.app.privateEpoch = (h.app.privateEpoch || 0) + 1;
    release();
    await pulling;

    assert.equal(JSON.stringify(h.localStore.snapshot()), recordBefore, '记录一个字都不能被写（尤其 recovery）');
    assert.equal(h.app.adopted, undefined, '更不能采用云端');
    assert.equal(h.app.syncConnection !== null, true, '连接本身不受影响');
});

test('本机有未上传改动（即使 pending 为空）时也不自动采用云端', async () => {
    const h = makeHarness({ get: async () => cloudOf({ theme: 'dark', revision: 9 }) });
    h.app.syncPending = null;                     // 没有待上传任务
    h.app.syncUploadedPayloadKey = 'stale';       // 但盘上的内容与云端不同
    await h.app.syncPullCheck();
    assert.equal(h.app.adopted, undefined, '不能静默覆盖本机改动');
    assert.notEqual(h.app.syncStatus, 'synced', '也不能说已同步');
    assert.ok(h.clock.pending() > 0, '应当排一次上传，走「先读后写/409 → 核对」的既有路径');
});

test('退出管理员：先协调云端、再续传、最后起轮询（顺序不可换）', async () => {
    const order = [];
    const h = makeHarness({
        get: async () => { order.push('get'); return h.app.syncCloud; }
    });
    const originalPost = h.calls.posts.length;
    h.app.authenticated = false;
    h.app.syncUploadedPayloadKey = 'stale';   // 有未上传内容
    const originalSchedule = h.app.scheduleSyncUpload.bind(h.app);
    h.app.scheduleSyncUpload = () => { order.push('post'); return originalSchedule(); };
    await h.app.resumeOrdinarySync();
    assert.deepEqual(order.slice(0, 2), ['get', 'post'], `顺序必须是先读后写，实际 ${order.join('→')}`);
    assert.ok(h.clock.intervals() > 0, '轮询接回来');
    assert.equal(h.calls.posts.length, originalPost, '这里只排程，不立刻发');
});

test('身份未确认（identityPending）时一个同步请求都不发、也不排上传', async () => {
    const h = makeHarness();
    h.app.identityPending = true;
    const before = { gets: h.calls.gets.length, posts: h.calls.posts.length };
    await h.app.syncPullCheck();
    h.app.markSyncDirty();
    await h.app.startSyncUpload();
    assert.deepEqual({ gets: h.calls.gets.length, posts: h.calls.posts.length }, before, '不发任何同步请求');
    assert.equal(h.clock.pending(), 0, '不排任何上传定时器');
});

test('未决草稿（suspendedAdministrator）期间：不采用云端、不上传', async () => {
    const h = makeHarness({ get: async () => cloudOf({ theme: 'dark', revision: 9 }) });
    h.app.suspendedAdministrator = { config: {} };
    await h.app.syncPullCheck();
    assert.equal(h.calls.gets.length, 0, '连读都不发（草稿未决时普通同步整体暂停）');
    assert.equal(h.app.adopted, undefined);
});

test('迟到的上传确认不能落到管理员上下文里（落盘点要比上下文代次）', async () => {
    // 与拉取那条对称：POST 在飞期间登录管理员，响应回来时不许再写记录。
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let h;
    // 快照取在**POST 发出的那一刻**（此前 pending 与 claim 已经按「先落盘再发」写好了），
    // 之后唯一允许写入的就是「确认成功」，而它在管理员上下文下必须被丢弃。
    let recordAtPost = null;
    h = makeHarness({ post: async () => { recordAtPost = JSON.stringify(h.localStore.snapshot()); await gate; return { success: true, revision: 4, generation: 1, updatedAt: 2 }; } });
    h.app.markSyncDirty();
    const uploading = (async () => { await h.clock.advance(1000); await flush(40); })();
    await flush(10);
    assert.ok(recordAtPost, 'POST 发出去了');
    h.app.authenticated = true;
    h.app.privateEpoch = (h.app.privateEpoch || 0) + 1;
    release();
    await uploading;
    await flush(20);
    assert.equal(JSON.stringify(h.localStore.snapshot()), recordAtPost, '迟到的确认不能写记录（尤其不能把 pending 当成已成功清掉）');
});

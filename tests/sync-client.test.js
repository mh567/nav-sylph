'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const localNavSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'local-navigation.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sync-store.js'), 'utf8');

/** 去掉整行注释与块注释：源码形状断言必须先剥注释（本仓库的老规矩）。 */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
}

/** 切出方法定义（含签名），返回 `name(args) { … }` 片段。 */
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
const cleanStore = stripComments(storeSource);

// 常量一律**从源码解析**再注入，不手写 6 / 128 / 标签字面量：
// 手写的桩会让「改了真常量」这类变异照样全绿（本仓库踩过）。
const MIN = Number(/const SYNC_PASSPHRASE_MIN = (\d+)/.exec(cleanApp)[1]);
const MAX = Number(/const SYNC_PASSPHRASE_MAX = (\d+)/.exec(cleanApp)[1]);
const CLIENT_LABEL = /const CONNECT_LABEL = '([^']+)'/.exec(cleanApp)[1];
const STORE_LABEL = /const CONNECT_LABEL = '([^']+)'/.exec(cleanStore)[1];
const STORE_SIDE_LABEL = /const STORE_LABEL = '([^']+)'/.exec(cleanStore)[1];

const webcrypto = nodeCrypto.webcrypto;

function buildMethod(body, deps) {
    const names = Object.keys(deps);
    const values = names.map(name => deps[name]);
    return new Function(...names, `return ({ ${body} });`)(...values);
}

test('连接证明的用途/版本标签在客户端与服务端逐字一致，且派生结果相同', async () => {
    // 两个常量分居两个文件：任一侧改了标签，服务端就定位不到空间，而症状只是
    // 「口令明明对，却说没有空间」。所以直接对拍，并再跑一遍真实派生做交叉验证。
    assert.equal(CLIENT_LABEL, STORE_LABEL, '客户端与服务端的证明标签必须一致');
    assert.match(CLIENT_LABEL, /-v\d+$/, '标签里必须带版本——换版本即换一代证明');
    assert.match(STORE_LABEL, /-v\d+$/, '服务端侧同样带版本');

    const body = methodBodyOf(cleanApp, 'deriveSyncProof');
    const { deriveSyncProof } = buildMethod(body, { window: { crypto: webcrypto }, TextEncoder, CONNECT_LABEL: CLIENT_LABEL });
    const passphrase = '跨设备口令 42';
    const client = await deriveSyncProof(passphrase);
    assert.match(client, /^[0-9a-f]{64}$/);
    // 服务端口径（同一个标签 + Node 的 webcrypto）算出来必须一模一样
    const server = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`${STORE_LABEL}\u0000${passphrase}`))).toString('hex');
    assert.equal(client, server, '两侧派生必须逐位相同');
    // 换用途/版本 → 证明不同（这一条就是「用途隔离」的可观测形式）
    const other = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`sylph-space-admin-v1\u0000${passphrase}`))).toString('hex');
    assert.notEqual(client, other);
});

test('口令按 Unicode 码点计数：6/128 边界、代理对与组合符都算 1 个', () => {
    const body = methodBodyOf(cleanApp, 'validateSyncPassphrase');
    const app = buildMethod(body, { SYNC_PASSPHRASE_MIN: MIN, SYNC_PASSPHRASE_MAX: MAX });
    const check = value => app.validateSyncPassphrase.call(null, value);
    assert.ok(MIN >= 6 && MAX >= 64, `解析到源码里的边界（${MIN}–${MAX}）`);

    assert.equal(check('x'.repeat(MIN)).ok, true, `${MIN} 个码点通过`);
    assert.equal(check('x'.repeat(MIN - 1)).ok, false, `${MIN - 1} 个拒绝`);
    assert.equal(check('x'.repeat(MAX)).ok, true, `${MAX} 个通过`);
    assert.equal(check('x'.repeat(MAX + 1)).ok, false, `${MAX + 1} 个拒绝`);
    // 码点而不是 UTF-16 长度：4 个 emoji + 2 个汉字 = 6 个码点，但 .length 是 10。
    const emoji = '😀😀😀😀中文';
    assert.equal(Array.from(emoji).length, MIN);
    assert.ok(emoji.length > MIN, '这个样例必须能区分码点与 UTF-16 长度');
    assert.equal(check(emoji).ok, true, 'emoji 按码点计数，不能被误判');
    // 这两条才是真正把「码点」与「.length」分开的断言：
    // MIN-1 个 emoji 的 .length 是 (MIN-1)*2 ≥ MIN，用长度判会**误放行**；
    // MAX 个 emoji 的 .length 是 2*MAX，用长度判会**误拒绝**。
    assert.equal(check('😀'.repeat(MIN - 1)).ok, false, `${MIN - 1} 个 emoji 只有 ${MIN - 1} 个码点，必须拒绝`);
    assert.equal(check('😀'.repeat(MAX)).ok, true, `${MAX} 个 emoji 是 ${MAX} 个码点，必须通过`);
    assert.equal(check('😀'.repeat(MAX + 1)).ok, false);
    // 组合符（e + 声调）同样是 1 个码点
    assert.equal(check('e\u0301'.repeat(MIN)).ok, true);

    assert.equal(check('       ').ok, false, '全空白拒绝');
    assert.equal(check('\t\n　　').ok, false, '全角空格与制表符也算空白');
    assert.equal(check('').ok, false);
    assert.equal(check(null).ok, false);
    assert.equal(check(undefined).ok, false);
    assert.equal(check(123456).ok, false, '非字符串拒绝');
});

test('口令既不裁空格也不做归一化：首尾空格与大小写都是它的一部分', async () => {
    const body = methodBodyOf(cleanApp, 'deriveSyncProof');
    const { deriveSyncProof } = buildMethod(body, { window: { crypto: webcrypto }, TextEncoder, CONNECT_LABEL: CLIENT_LABEL });
    const variants = ['口令abc123', '口令abc123 ', ' 口令abc123', '口令ABC123'];
    const proofs = await Promise.all(variants.map(variant => deriveSyncProof(variant)));
    assert.equal(new Set(proofs).size, variants.length, '四种写法必须派生出四个不同的证明');

    // 校验函数同样不裁：带首尾空格仍然通过（只要不是全空白）
    const app = buildMethod(methodBodyOf(cleanApp, 'validateSyncPassphrase'), { SYNC_PASSPHRASE_MIN: MIN, SYNC_PASSPHRASE_MAX: MAX });
    const padded = ` ${'口令abc123'} `;
    assert.equal(app.validateSyncPassphrase.call(null, padded).ok, true, '不静默裁空格——带空格的口令照收');
    assert.equal(Array.from(padded).length >= MIN, true);
    // 归一化：NFC/NFD 两种写法必须派生不同证明（不做归一化的可观测形式）
    const [composed, decomposed] = await Promise.all([deriveSyncProof('caf\u00e9口令x'), deriveSyncProof('cafe\u0301口令x')]);
    assert.notEqual(composed, decomposed, '不得做 Unicode 归一化');
});

test('凭据保存失败不能显示连接成功（真实 finishSyncConnection）', async () => {
    const body = methodBodyOf(cleanApp, 'finishSyncConnection');
    const states = [];
    const statuses = [];   // setSyncStatus 的轨迹：连接成功才允许出现 synced
    const persisted = [];
    const make = (failOnFirstWrite) => {
        let writes = 0;
        const app = {
            syncBusy: true,
            syncProof: 'proof',
            syncConnection: null,
            syncCloud: null,
            syncPending: null,
            syncStatus: 'local',
            syncConnEpoch: 0,
            syncBackoffMs: 0,
            config: { theme: 'auto' },
            localModulePayload: () => ({ enabled: [], widgets: [], settings: {} }),
            syncPayloadKey: () => 'key-1',
            setSyncState: (state, message) => states.push({ state, message: message || '' }),
            setSyncStatus: status => { app.syncStatus = status; statuses.push(status); },
            showToast: () => {},
            markSyncEntry: () => {},
            startSyncPolling: () => {},
            notifySyncPeers: () => {},
            syncPullCheck: async () => {},
            persistSyncConnection: async (snapshot) => {
                writes++;
                if (failOnFirstWrite && writes === 1) throw new Error('配额已满');
                persisted.push(snapshot);   // 连接时会写两次：凭据 + 内容指纹
                app.syncConnection = snapshot.connection;
                app.syncRecovery = snapshot.recovery;
                return { revision: writes };
            },
            writeCloudConfig: async () => ({ success: true, revision: 9 }),
            adoptCloudConfig: async () => {}
        };
        return app;
    };
    // 跑**真实的** finishSyncConnection：methodBodyOf 返回的是定义（含签名），
    // 嵌进对象字面量再 .call(app) —— this 就是那个假 app。
    const invoke = (app, material, direction) => new Function(
        'app', 'material', 'direction', 'window', 'Date',
        `return ({ ${body} }).finishSyncConnection.call(app, material, direction);`
    )(app, material, direction, { NavigationSchema: { publicConfig: value => value, validate: () => {} } }, Date);

    // ① 落盘失败 → 不得出现 connected
    states.length = 0;
    await invoke(make(true), { spaceId: 'space', deviceToken: 'tok'.repeat(20), generation: 1, revision: 1 }, 'local');
    assert.deepEqual(states.map(s => s.state), ['error'], '只允许一次 error，不能出现 connected');
    assert.equal(statuses.includes('synced'), false, '落盘失败时绝不能显示「已同步」');
    assert.match(states[0].message, /未能保存到本机/);

    // ② 新建空间（方向 local 且没有云端内容）→ 先落盘再 connected，且**不留**
    //    「替换前的副本」：云端本来就没有东西可替换。
    states.length = 0;
    const created = make(false);
    await invoke(created, { spaceId: 'space', deviceToken: 'tok'.repeat(20), generation: 1, revision: 1 }, 'local');
    assert.deepEqual(states.map(s => s.state), ['connected']);
    assert.equal(persisted.length >= 2, true, '凭据、版本与内容指纹都落了盘');
    assert.equal(persisted[0].connection.deviceToken, 'tok'.repeat(20));
    // 内容指纹必须**落盘**：只在内存里设的话，连接后一刷新就会被判成
    // 「这份内容没传过」，同一份内容再传一次（云端 revision 白 +1）。
    assert.ok(persisted.some(p => p.uploadedPayloadKey === 'key-1'), '连接时要把内容指纹写进记录');
    assert.equal(persisted[0].recovery, null, '新建不该声称保留了一份替换前的副本');
    assert.equal(created.syncCloud.revision, 9, '上传后状态行显示的是刚写下的版本，不是上传前的');

    // ③ 连接既有空间并「以本机配置替换云端」→ recovery 是**云端**那一份
    states.length = 0;
    const replaced = make(false);
    const cloudBefore = { config: { theme: 'auto' }, modules: { enabled: [] } };
    await invoke(replaced, { spaceId: 'space', deviceToken: 'tok'.repeat(20), generation: 1, revision: 3, cloud: cloudBefore }, 'local');
    assert.deepEqual(states.map(s => s.state), ['connected']);
    // 连接收尾会写两次（凭据 + 内容指纹），所以按**内容**找回那一份而不是取最后一条
    const replaceSnapshot = persisted.filter(p => p.recovery).pop();
    assert.equal(replaceSnapshot.recovery.direction, 'cloud');
    assert.deepEqual(replaceSnapshot.recovery.config, cloudBefore.config, '存的是被覆盖前的云端内容');

    // ④ 采用云端配置 → recovery 是**本机**那一份，且取自改动之前
    states.length = 0;
    const adopted = make(false);
    await invoke(adopted, { spaceId: 'space', deviceToken: 'tok'.repeat(20), generation: 1, revision: 3, cloud: { config: { theme: 'dark' }, modules: { enabled: [] } } }, 'cloud');
    assert.deepEqual(states.map(s => s.state), ['connected']);
    const adoptSnapshot = persisted.filter(p => p.recovery).pop();
    assert.equal(adoptSnapshot.recovery.direction, 'local');
    assert.equal(adoptSnapshot.recovery.config.theme, 'auto', '保存的是本机改前的配置');
});

test('设备令牌只走 Authorization 头，不进 URL', () => {
    const code = stripComments(appSource);
    const body = methodBodyOf(code, 'authOptions');
    const api = buildMethod(body, {});
    const withToken = api.authOptions.call(null, { token: 'abc123' });
    assert.equal(withToken.headers.Authorization, 'Bearer abc123');
    assert.equal(JSON.stringify(withToken).includes('abc123'), true, '令牌在头里');
    assert.equal(Object.keys(withToken).includes('token'), false, '不得把 token 当 fetch 选项传下去');
    assert.deepEqual(api.authOptions.call(null, {}), {}, '没有令牌时原样返回');

    // ⚠️ 对**每一处**读取都断言带令牌，而不是「有一处带」：
    // 后者会被另一处正确的调用点满足——实测就是这样漏掉了 loadSyncState 里
    // 漏传令牌的那一处，症状是「每次刷新都掉线」（恒 401 → 当成连接失效清凭据）。
    const reads = [...code.matchAll(/API\.get\('\/api\/sync\/config'([^)]*)/g)];
    assert.ok(reads.length >= 2, `读取云端配置的调用点（${reads.length}）`);
    for (const [, args] of reads) {
        assert.match(args, /\{\s*token:/, `每一处读取都要带设备令牌，这里是：${args.trim()}`);
    }
    assert.equal([...code.matchAll(/API\.get\('\/api\/sync\/config'\)/g)].length, 0,
        '不得存在不带令牌的读取（含 loadSyncState 的探活）');
});

test('服务端不记录口令、证明或设备令牌，也不从 URL 读它们', () => {
    const code = stripComments(serverSource);
    const logged = [...code.matchAll(/console\.(?:log|error|warn)\(([^\n]*)/g)].map(m => m[1]);
    assert.ok(logged.length > 3, `解析出日志调用（${logged.length}）`);
    for (const line of logged) {
        assert.doesNotMatch(line, /proof|deviceToken|passphrase|inviteCode/i,
            `日志里不得出现口令/证明/令牌：${line.trim()}`);
    }
    // 证明与令牌都不进 URL：路由里没有它们的位置参数或查询读取
    assert.doesNotMatch(code, /req\.query\.(?:proof|token|deviceToken)/);
    assert.doesNotMatch(code, /'\/api\/sync\/[^']*(?:proof|token)/);
    // 令牌只从 Authorization 头读
    assert.match(code, /\/\^Bearer\\s\+\(\\S\+\)\$\/\.exec\(header\)/, '令牌只从 Bearer 头解析');
});

test('每空间的签发上限接在 store 的回调上，且那只桶进清理定时器', () => {
    const code = stripComments(serverSource);
    // 与连接桶同值（都是设计文档的 30/分钟），但**层次不同**：连接桶按 IP 防猜口令，
    // 签发桶按空间防「口令已知的人无限换设备」。单 IP 下单空间的使用会被 IP 桶先挡住，
    // 所以这条上限只在多 IP（代理/多设备）下成为真正的那道闸——行为用例在
    // tests/sync-store.test.js 里直接驱动回调，这里只钉接线与回收。
    assert.match(code, /onIssue: syncIssueLimit/, 'store 的签发回调必须接上限流');
    assert.match(code, /const syncIssueLimitMap = new Map\(\)/, '签发桶已声明');
    assert.match(code, /sweepRateLimitStore\(syncIssueLimitMap, now, SYNC_ISSUE_WINDOW\)/, '签发桶已登记清理');
    // ⚠️ 这里**不**断言「回调排在 INSERT 之前」。试过：把它挪到 INSERT 之后，
    // 用例全绿——因为整段在同一个事务里，回调抛错时那次插入跟着回滚了，
    // 两种顺序在外部完全等价。钉一个没有可观察后果的位置只是把作者的想法写成断言；
    // 承重的事实是「签发会经过这只桶」（store 层的行为用例）与「桶在回收」（上面两条）。
});

test('自动同步的接线：触发点、监听器、状态词与刻意的取舍', () => {
    const code = stripComments(appSource);

    // ① 本地落盘后**唯一**的同步触发点：两处（导航、模块），且都在各自的保存路径里。
    //    多一处少一处都要红——散着挂会在「没保存成功」时也发出去。
    const dirty = [...code.matchAll(/this\.markSyncDirty\(\);/g)];
    assert.equal(dirty.length, 2, `markSyncDirty 的调用点应恰好 2 处，实际 ${dirty.length}`);
    assert.match(methodBodyOf(code, 'saveLocalNavigation'), /this\.markSyncDirty\(\)/, '导航保存后触发');
    assert.match(methodBodyOf(code, 'saveLocalModules'), /this\.markSyncDirty\(\)/, '模块保存后触发');

    // ② 三个事件监听器都在 bind() 里，而且**各自转发到各自的函数体**——
    //    只断言「bind 里有 syncPullCheck」会被另一处满足（审查抓到的：删掉任一处照样绿）。
    //    函数体抽成方法之后，行为由 tests/sync-engine.test.js 真的执行（假时钟推进）。
    const bind = methodBodyOf(code, 'bind()');
    assert.match(bind, /addEventListener\('visibilitychange'[\s\S]*?this\.onSyncVisibilityChange\(\)/, '可见性变化转发到 onSyncVisibilityChange');
    assert.match(bind, /addEventListener\('online'[\s\S]*?this\.onSyncOnline\(\)/, '联网转发到 onSyncOnline');
    assert.match(bind, /addEventListener\('offline'[\s\S]*?this\.onSyncOffline\(\)/, '断网转发到 onSyncOffline');
    // 行为的归属：隐藏停轮询在可见性方法里，立即检查在联网方法里
    const visibility = methodBodyOf(code, 'onSyncVisibilityChange()');
    assert.match(visibility, /this\.stopSyncPolling\(\)/, '隐藏时停轮询（在 onSyncVisibilityChange 里）');
    assert.match(visibility, /this\.syncPullCheck\(\)/, '恢复可见时立即检查');
    assert.match(methodBodyOf(code, 'onSyncOnline()'), /this\.syncPullCheck\(\)/, '联网时立即检查');
    assert.match(methodBodyOf(code, 'onSyncOnline()'), /this\.syncBackoffMs = 0/, '联网时取消退避');

    // ③ 管理员会话生效期间暂停普通同步调度（两处 authenticated = true 都要接上）
    const pauses = [...code.matchAll(/this\.pauseSyncForAdmin\(\);/g)];
    assert.equal(pauses.length, 2, `pauseSyncForAdmin 的调用点应恰好 2 处，实际 ${pauses.length}`);

    // ④ 状态词的**完整**文案就是设计文档 §5 的六个词——改词要连文档一起改。
    //    页脚那张短词表也要六个键都在（少一个 → 页脚回落到「同步」，看起来像没连上）。
    const text = /const SYNC_STATUS_TEXT = \{([^}]*)\}/.exec(code)[1];
    for (const word of ['仅保存在本机', '同步中', '已同步', '离线，待同步', '同步失败', '存在配置冲突']) {
        assert.ok(text.includes(word), `完整状态词表里要有「${word}」`);
    }
    const labels = /const SYNC_STATUS_LABEL = \{([^}]*)\}/.exec(code)[1];
    for (const key of ['local', 'syncing', 'synced', 'pending', 'failed', 'conflict']) {
        assert.match(labels, new RegExp(`\\b${key}:`), `页脚短词表里要有 ${key}`);
    }
    // 冲突态的**标题**用完整词，别用一句自造的话——界面词汇要与文档一致
    assert.match(methodBodyOf(code, 'renderSyncDialog()'), /<p class="sync-state">\$\{this\.esc\(SYNC_STATUS_TEXT\.conflict\)\}<\/p>/, '冲突标题用完整状态词');

    // ⑤ 刻意不用 navigator.locks：本仓库已有「乐观 revision + BroadcastChannel」，
    //    再加一把只有部分浏览器支持的锁会变成两套协调机制。这条断言把取舍写死，
    //    免得下一个人「顺手」再加一条路径。
    assert.doesNotMatch(code, /navigator\.locks/, '不要引入第二套多标签页协调机制');
    assert.match(code, /BroadcastChannel\('nav-sylph-space-sync'\)/, '用 BroadcastChannel 通知');
    // 写请求要带本机的连接代次：服务端在写事务里再比一次，不一致给明确的
    // 409 generation_mismatch（验收 3 的「代次事务校验」）。
    const upload = methodBodyOf(code, 'uploadOnce()');
    assert.match(upload, /generation: this\.syncConnection\.generation/, '写请求要带连接代次');
    // 单飞声明确实与待上传内容写在**同一次**记录写入里
    const claim = methodBodyOf(code, 'acquireSyncClaim()');
    assert.match(claim, /persistSyncRecord\(\{ pending: this\.syncPending, claim:/, '认领与待上传内容同一次写入');
});

test('本地同步记录的形状校验：坏字段只丢那个字段，不废整条记录', () => {
    // 真实现来自 public/local-navigation.js（4 空格缩进那份）。记录里同时住着
    // 凭据与用户唯一的「替换前副本」，因为 pending 少一个字段就让人重新输口令
    // 是得不偿失的——所以这条断言的重点是「坏字段只丢字段」。
    const code = stripComments(localNavSource);
    // ⚠️ 这里不能用 methodBodyOf：它的「下一个定义」锚点在 4 空格缩进的文件里
    // 会一路切到文件末尾（`class LocalNavigation {` 不带括号、不算边界），拼进
    // 对象字面量就是语法错误。按**大括号配对**切，并断言两端都在。
    const sliceFunction = (source, name) => {
        const re = new RegExp(`\\n( +)(?:async )?(?:function )?${name}\\([^()]*\\) \\{`);
        const found = re.exec(source);
        assert.ok(found, `切出 ${name}`);
        const start = found.index + 1;
        let depth = 0;
        for (let i = start; i < source.length; i++) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
        }
        throw new Error(`${name} 的大括号不配对`);
    };
    const body = sliceFunction(code, 'checkSync');
    assert.ok(body.length > 300, `切出 checkSync（${body.length}）`);
    // 首行是定义签名、末字符是大括号收尾——两端都断言，避免切片跑到文件末尾
    assert.match(body, /^\s*(?:function )?checkSync\(record\) \{/, '切到的是定义而不是调用');
    assert.match(body, /\}\s*$/, '切片以函数的收尾大括号结束');
    // ⚠️ 嵌进对象字面量前要把 `function ` 去掉：`{ function checkSync(…) {} }` 是语法错误
    // （这也是上一版报 "Unexpected identifier 'checkSync'" 的原因）。
    const member = body.replace(/^\s*function\s+/, '');
    const { checkSync } = new Function('SYNC_SCHEMA_VERSION', `return ({ ${member} });`)(1);
    const base = {
        schemaVersion: 1, revision: 3,
        connection: { spaceId: 'space', deviceToken: 'tok' }, recovery: { direction: 'local' },
        pending: null, claim: null, lastSuccessAt: 5, uploadedPayloadKey: 'k'
    };
    assert.equal(checkSync(base).connection.deviceToken, 'tok', '正常记录原样返回');
    // 坏 pending → 只丢 pending
    const badPending = checkSync({ ...base, pending: { operationId: 'op-1' } });
    assert.equal(badPending.pending, null);
    assert.equal(badPending.connection.deviceToken, 'tok', '凭据要保住');
    assert.ok(badPending.recovery, '恢复副本也要保住');
    // 好 pending → 留着（payloadKey 是新增的必填项）
    const goodPending = checkSync({ ...base, pending: { operationId: 'op-1', payloadKey: 'k', baseRevision: 3, createdAt: 1, content: { config: {}, modules: {} } } });
    assert.equal(goodPending.pending.operationId, 'op-1');
    assert.equal(checkSync({ ...base, pending: { ...goodPending.pending, payloadKey: undefined } }).pending, null, '缺 payloadKey 视为坏');
    // 坏 claim / 非字符串指纹 → 各自丢自己
    assert.equal(checkSync({ ...base, claim: { id: 1 } }).claim, null);
    assert.equal(checkSync({ ...base, uploadedPayloadKey: 7 }).uploadedPayloadKey, null);
    // 只有**版本**不对才整条报废（那时确实读不懂）
    assert.throws(() => checkSync({ ...base, schemaVersion: 2 }), /版本/);
});

test('访客的同步接口不受限流豁免，管理员邀请码接口必须带限流与管理员会话', () => {
    const code = stripComments(serverSource);
    const guestRoutes = [...code.matchAll(/app\.(get|post)\('(\/api\/sync[^']*)'([^,]*(?:,|\)))/g)];
    // 8 = #9 的 7 条 + #10 的 `POST /api/sync/device/reset`（「撤销全部旧设备并重新连接」）。
    // 这不是放宽：条数与路由名同时钉住，多一条少一条都红；下面还逐个点名挂桶。
    assert.equal(guestRoutes.length, 8, `访客侧应恰好 8 条，实际 ${guestRoutes.length}`);
    assert.ok(guestRoutes.some(([, , route]) => route === '/api/sync/device/reset'), '新那条是设备重置');
    for (const [, , route] of guestRoutes) {
        assert.doesNotMatch(code, new RegExp(`'${route.replace(/[/]/g, '\\/')}',\\s*requireAdmin`),
            `${route} 不能要求管理员会话——访客就是没有会话的那个人`);
    }
    // 会用到口令的入口都挂 IP 桶（防猜口令），包括 #9 的删除——它要求重新输口令；
    // 读写两条走设备令牌 + 按空间限流。
    for (const route of ['/api/sync/space/check', '/api/sync/space/create', '/api/sync/space/connect', '/api/sync/space/delete', '/api/sync/device/revoke', '/api/sync/device/reset']) {
        assert.match(code, new RegExp(`app\\.post\\('${route.replace(/[/]/g, '\\/')}', syncConnectLimit`), `${route} 挂连接桶`);
    }
    for (const kind of ['read', 'write']) {
        assert.match(code, new RegExp(`syncDeviceGuard\\('${kind}'\\)`), `${kind} 走设备令牌 + 按空间限流`);
    }

    // 5 条：列表 / 生成 / 单张撤销 / 批量生成 / 批量撤销（#10 之后加了空间治理界面要用的两条）。
    // 计数是让「新增一条未受保护的路由」变得可见——所以新增路由时必须同时改这里。
    const adminRoutes = [...code.matchAll(/app\.(get|post)\('(\/api\/admin\/sync-invites[^']*)'/g)].map(m => m[2]);
    assert.equal(adminRoutes.length, 5, `管理员侧应恰好 5 条，实际 ${adminRoutes.length}`);
    for (const route of adminRoutes) {
        assert.match(code, new RegExp(`'${route.replace(/[/]/g, '\\/')}', rateLimit, requireAdmin`),
            `${route} 必须走 rateLimit + requireAdmin`);
    }
});

// ==================== #9：停止同步与删除云端空间 ====================

test('停止与删除的控件都在对话框里，且只从名字就是后果的控件进入', () => {
    const dialog = methodBodyOf(cleanApp, 'renderSyncDialog');
    // 连接态：停止同步是普通按钮，删除云端空间单独落在危险区（它是唯一不可撤销的动作）。
    assert.match(dialog, /id="syncStop"/, '连接态有「停止同步」');
    assert.match(dialog, /id="syncDelete"/, '连接态有「删除云端空间」');
    assert.match(dialog, /class="sync-link sync-danger" id="syncDelete"/, '删除入口要带危险样式，不能和普通按钮混在一起');
    assert.ok(dialog.indexOf('sync-danger-zone') > dialog.indexOf('id="syncClose"'), '危险区落在按钮行**下方**，不占主操作位');
    assert.match(dialog, /id="syncStopConfirm"[^>]*>[\s\S]{0,80}确认停止同步/, '确认按钮的文案说清它做什么');
    assert.match(dialog, /id="syncDeleteConfirm"[^>]*>[\s\S]{0,80}确认删除云端空间/, '删除确认按钮的文案就是它的后果');
    // 确认态要有可返回的路，且删除确认要求**重新输入口令**。
    assert.match(dialog, /id="syncStopBack"/);
    assert.match(dialog, /id="syncDeleteBack"/);
    assert.match(dialog, /id="syncDeletePassphrase"[^>]*type="password"/, '删除要重新输口令（不是只点一下）');
    // 停止的确认文案必须说清「已到达服务端的上传可能已经完成」——这是设计要求的告知。
    assert.match(dialog, /已经到达服务端的上传可能已经完成/);
});

test('#9 的交互都接在对话框的点击委托上，没有孤儿控件', () => {
    const open = methodBodyOf(cleanApp, 'openSyncDialog');
    for (const id of ['syncStop', 'syncStopBack', 'syncStopConfirm', 'syncDelete', 'syncDeleteBack', 'syncDeleteConfirm']) {
        assert.match(open, new RegExp(`id === '${id}'`), `${id} 要有处理分支`);
    }
    // 删除确认框里回车 = 确认删除（口令框里回车是「检查并连接」，两处别混）
    assert.match(open, /event\.target\.id === 'syncDeletePassphrase'[\s\S]{0,60}confirmDeleteSpace/, '删除确认框回车 = 确认删除');
});

test('停止同步：清凭据与递增代次在**同一次**落盘里，随后才尽力撤销令牌', () => {
    const clear = methodBodyOf(cleanApp, 'clearSyncConnection');
    const call = clear.slice(clear.indexOf('writeSyncWithEpochRetry('));
    const oneWrite = call.slice(0, call.indexOf('});'));
    // 代次的递增由 `{ bumpEpoch: true }` 表达（**在重试循环内**重算，见下一条），
    // 与清凭据是同一次落盘；这里同时钉住「清掉哪些」与「不动哪些」。
    // 注意切片在 `});` **之前**截断，所以这里不能要求那个闭合花括号
    assert.match(oneWrite, /\{ bumpEpoch: true/, '代次递增与清凭据在同一次落盘里');
    assert.match(oneWrite, /connection: null/, '凭据要在同一个事务里清掉');
    assert.match(oneWrite, /pending: null/, '待上传任务同一个事务里清掉');
    assert.doesNotMatch(oneWrite, /recovery:/, '替换前的副本不能被停止清掉');
    assert.match(clear, /notifySyncPeers\('stopped'\)/, '断开后要通知其它标签页取消调度');

    const stop = methodBodyOf(cleanApp, 'stopSyncLocal');
    assert.ok(stop.indexOf('await this.clearSyncConnection()') < stop.indexOf('/api/sync/device/revoke'),
        '先本地断开、后尽力撤销——顺序反了会出现「撤销了但本地还有凭据」的中间态');
    assert.match(stop, /\.catch\(\(\) => \{\}\)/, '撤销是尽力而为，失败不能变成用户可见的错误');
});

test('删除云端空间：双要素、暂停上传、结果不确定再核对一次、任何路径都不重建', () => {
    const del = methodBodyOf(cleanApp, 'confirmDeleteSpace');
    assert.match(del, /API\.post\('\/api\/sync\/space\/delete', \{ proof \}, \{ token \}\)/, '请求要同时带口令证明与设备令牌（双要素）');
    assert.match(del, /this\.syncDeleting = true/, '删除期间要挡住上传');
    assert.match(del, /this\.stopSyncTimers\(\)/, '删除期间停掉调度');
    assert.match(del, /error\.code === 'space_deleted'[\s\S]{0,80}done = true/, '第二次拿到「已删除」就是确定答案（核对原空间）');
    assert.match(del, /error\.code === 'proof_mismatch'/, '口令错要单独分支（不能当网络错去重试）');
    assert.match(del, /attempt < 2/, '结果不确定只再试一次');
    assert.doesNotMatch(del, /\/api\/sync\/space\/create/, '删除路径绝不能调创建（不自动重建）');
    assert.match(del, /this\.syncDeleting = false/, '失败要把挡板撤掉');
    const request = methodBodyOf(cleanApp, 'requestDeleteSpace');
    assert.match(request, /navigator\.onLine === false[\s\S]{0,120}需要在线/, '离线时明确拒绝并说明原因');
});

test('停用有自己的对话框状态与重试入口（不能落到「重新输口令」的表单上）', () => {
    const dialog = methodBodyOf(cleanApp, 'renderSyncDialog');
    // 切片到该分支自己的 `return;` 为止（按字符数切会把模板截断，那种切片是恒真的）
    const haltedStart = dialog.indexOf("this.syncState === 'halted'");
    const halted = dialog.slice(haltedStart, dialog.indexOf('return;', haltedStart));
    assert.ok(halted.length > 200, '渲染分支切出来了');
    assert.match(halted, /id="syncRetry"/, '要有「重试同步」');
    assert.match(halted, /重新输入口令没有用/, '要明说输口令没用（否则用户会去重输口令）');
    assert.match(halted, /id="syncStop"/, '也要能直接停止');
    assert.match(halted, /id="syncClose"/, '也要能关掉');
    assert.match(methodBodyOf(cleanApp, 'openSyncDialog'), /id === 'syncRetry'[\s\S]{0,60}retrySyncAfterHalt/, '重试要接线');
});

test('错误码 → 文案只有一处映射，四类各说各的话', () => {
    const map = methodBodyOf(cleanApp, 'syncTerminalOf');
    assert.match(map, /space_deleted[\s\S]{0,80}已被删除/);
    assert.match(map, /device_revoked[\s\S]{0,80}这台设备/);
    assert.match(map, /code === 'device_expired' \|\| code === 'device_invalid'[\s\S]{0,80}重新输入口令/);
    // ⚠️ `halt` 在 #10 从布尔升级成**原因字符串**（`'disabled' | 'paused'`）：两种暂停
    // 用户的下一句话完全不同（等管理员重开这个空间 vs 整台服务停了），合成一个 true
    // 就没法区分。真值语义不变（`if (terminal.halt)` 照旧成立），所以这里钉具体值。
    assert.match(map, /code === 'space_disabled'[\s\S]{0,60}halt: 'disabled'/);
    assert.match(map, /code === 'sync_paused'[\s\S]{0,60}halt: 'paused'/);
    // 「只有一处」：这几句用户可见的话在 app.js 里各出现一次
    for (const message of ['云端空间已被删除，已转为仅保存在本机', '这台设备已断开同步', '该空间已被管理员停用']) {
        const hits = cleanApp.split(message).length - 1;
        assert.equal(hits, 1, `「${message}」只能出现在映射表里，实际 ${hits} 处`);
    }
    // 上传失败与读路径都必须先过这个映射（否则 410 会被当成普通失败去退避）
    assert.match(methodBodyOf(cleanApp, 'handleSyncUploadFailure'), /await this\.handleSyncTerminal\(error\)/);
    assert.match(methodBodyOf(cleanApp, 'syncPullCheck'), /await this.handleSyncTerminal\(error\)/);
});

test('暂停上传的两个挡板（删除中 / 空间停用）在每一处排程入口都挡着', () => {
    for (const name of ['markSyncDirty', 'scheduleSyncUpload', 'startSyncUpload']) {
        assert.match(methodBodyOf(cleanApp, name), /syncDeleting/, `${name} 要挡「删除中」`);
    }
    for (const name of ['markSyncDirty', 'scheduleSyncUpload', 'uploadOnce']) {
        assert.match(methodBodyOf(cleanApp, name), /syncHalted/, `${name} 要挡「空间已停用」`);
    }
    // 上传的唯一出口也要挡：单飞闩之后仍然早退（否则挡板只挡住了排程，没挡住已经在排的那个）
    assert.match(methodBodyOf(cleanApp, 'uploadOnce'), /this\.syncDeleting/);
});

test('落盘一律带期望代次；只有推进代次的那条路不带（它自己在换代次）', () => {
    const persist = methodBodyOf(cleanApp, 'persistSyncRecord');
    assert.match(persist, /writeSync\(patch, this\.syncRecordRevision, this\.syncConnEpoch \|\| 0\)/, '每次落盘都要比较连接代次');
    assert.match(persist, /this\.syncConnEpoch = record\.connEpoch/, '要把记录里的代次同步回内存');
    assert.match(methodBodyOf(cleanApp, 'writeSyncWithEpochRetry'), /options\.bumpEpoch \? \{ \.\.\.patch, connEpoch: \(this\.syncConnEpoch \|\| 0\) \+ 1 \}/,
        '代次必须在重试循环**内**重算：循环外求值一次，重读之后写回去就是代次回退');
    const store = methodBodyOf(stripComments(localNavSource), 'writeSync');
    assert.match(store, /expectedEpoch !== undefined && \(current\?\.connEpoch \|\| 0\) !== expectedEpoch/, '比较发生在写事务内');
    assert.match(store, /code: 'epoch'/, '要有可判别的错误码');
    // 打开页面与收到「别的标签页停止了」两处都要把代次读回内存：只读一处的话，
    // 另一处的内存代次会停旧值，之后每次落盘都被事务拒掉。
    assert.match(methodBodyOf(cleanApp, 'loadSyncState'), /this\.syncConnEpoch = record\?\.connEpoch \|\| 0/);
    assert.match(methodBodyOf(cleanApp, 'refreshSyncRecord'), /this\.syncConnEpoch = record\?\.connEpoch \|\| 0/);
    assert.match(cleanApp, /this\.syncChannel\.onmessage = event => \{[\s\S]{0,600}type === 'stopped'/, '收到停止通知要重读记录');
    assert.match(stripComments(localNavSource), /'connEpoch'\]/, 'local-navigation 的 SYNC_FIELDS 要含 connEpoch');
});

// ==================== #10：设备回收与空间资源治理的接线 ====================

test('#10 的管理员治理路由：四条（含 GET/POST 成对）都走 rateLimit + requireAdmin，且不读设备令牌', () => {
    const code = stripComments(serverSource);
    // 逐条点名而不是「统计到 5 条」：漏掉 requireAdmin 的那一条必须自己站起来报名字。
    const routes = [
        ["/api/admin/sync-spaces", 'get'],
        ["/api/admin/sync-spaces/:id/disable", 'post'],
        ["/api/admin/sync-spaces/:id/delete", 'post'],
        ["/api/admin/sync-settings", 'get'],
        ["/api/admin/sync-settings", 'post']
    ];
    for (const [route, method] of routes) {
        const pattern = new RegExp(`app\\.${method}\\('${route.replace(/[/:]/g, ch => '\\' + ch)}', rateLimit, requireAdmin`);
        assert.match(code, pattern, `${route} 必须走 rateLimit + requireAdmin`);
    }
    // 这一段路由**不读 Authorization 头**：设备令牌在这里没有任何入口（不是「漏了鉴权」，
    // 而是「这条通道根本不存在」）。越权行为由 tests/sync-http.test.js 真打 HTTP 验。
    const section = code.slice(code.indexOf("app.get('/api/admin/sync-spaces'"), code.indexOf("app.post('/api/verify-password'"));
    assert.ok(section.length > 500, '切出治理路由那一段');
    assert.doesNotMatch(section, /authorization/i, '治理路由不得读 Authorization 头');
    assert.doesNotMatch(section, /readDeviceToken/, '治理路由不得用设备令牌');
});

test('#10 的对话框与面板接线：新控件都有处理分支，没有孤儿按钮', () => {
    const open = methodBodyOf(cleanApp, 'openSyncDialog');
    // 撤销全部旧设备：入口 → 确认 → 返回 三个 id 都要有分支（少一个就是点不动的死按钮）。
    for (const id of ['syncResetDevices', 'syncResetBack', 'syncResetConfirm']) {
        assert.match(open, new RegExp(`id === '${id}'`), `${id} 要有处理分支`);
    }
    // 取消撤销要回到**来源那一屏**：已连接态回 connected，从「空间已存在」进来的回 exists
    // （回错一屏会让用户掉进一个自己没走过的表单）。
    assert.match(open, /id === 'syncResetBack'[\s\S]{0,120}this\.syncConnection \? 'connected' : 'exists'/);
    // 重试同步（停用 / 总暂停那一屏）走 retrySyncAfterHalt——它才是「读一次成功即解除」的落点。
    assert.match(open, /id === 'syncRetry'[\s\S]{0,60}retrySyncAfterHalt/);
    // 撤销确认框里回车 = 确认撤销（与删除确认框互不相同，两处不能混）。
    assert.match(open, /event\.target\.id === 'syncResetPassphrase'[\s\S]{0,60}confirmResetDevices/);
    const dialog = methodBodyOf(cleanApp, 'renderSyncDialog');
    for (const id of ['syncResetDevices', 'syncResetPassphrase', 'syncResetBack', 'syncResetConfirm', 'syncRetry']) {
        assert.match(dialog, new RegExp(`id="${id}"`), `渲染里要有 #${id}`);
    }
    // 撤销入口出现在**两个**地方：已连接态与「空间已存在」态（后者是「口令对但本机没连」）。
    const occurrences = dialog.split('id="syncResetDevices"').length - 1;
    assert.equal(occurrences, 2, `撤销入口应恰好出现在两屏，实际 ${occurrences}`);
});

test('#10 的管理面板治理区：两个总开关勾了即落盘，列表操作走事件委托，且首次进分区才拉接口', () => {
    const code = stripComments(appSource);
    // ① 渲染触发：只在「进入站点分区 且 还没渲染过」时拉一次，与邀请码块各自的闩锁分开。
    assert.match(code, /if \(panel === 'site' && !this\.syncSpacesRendered\) this\.renderSyncSpaces\(\)/,
        '进入站点分区要按闩锁拉一次（漏了就是永远停在「加载中…」）');
    // 面板每打开一次就会重画两块（列表 + 策略）。它们必须来自**同一条** GET：
    // 分成两条等于每次打开多打一条管理接口，而管理桶只有 30 次/分钟——本仓库
    // 已经因为「渲染里顺手预取」撞过 429（WebDAV 那次），浏览器回归也抓到过。
    const renderSpaces = methodBodyOf(cleanApp, 'renderSyncSpaces');
    assert.match(renderSpaces, /API\.get\('\/api\/admin\/sync-spaces'\)/, '要拉列表');
    assert.match(renderSpaces, /data\.settings/, '策略与列表来自同一个响应');
    assert.equal((renderSpaces.match(/API\.get\(/g) || []).length, 1,
        '面板重画只允许一条 GET（两条会攒进管理桶、撞 429）');
    // ② 两个总开关：onchange → saveSyncPolicy（勾了即落盘）。只在内存里改勾选态是最气人的那种 bug：
    //    界面显示「已暂停」而服务端根本没收到。所以这一条同时钉住「有 onchange」与「落到哪个 POST」。
    assert.match(code, /for \(const id of \['syncCreatingPaused', 'syncTotalPaused'\]\) \{\s*\n\s*\$\(`#\$\{id\}`\)\.onchange = \(\) => this\.saveSyncPolicy\(\)/,
        '两个总开关都要勾了即落盘');
    const save = methodBodyOf(cleanApp, 'saveSyncPolicy');
    assert.match(save, /API\.post\('\/api\/admin\/sync-settings'/);
    assert.match(save, /creatingPaused: !!\(creating && creating\.checked\)/, '暂停新建单独提交');
    assert.match(save, /syncPaused: !!\(total && total\.checked\)/, '总暂停单独提交');
    assert.match(save, /catch[\s\S]{0,200}this\.paintSyncPolicy\(\)/, '失败要把勾选态回滚成服务端确认过的值');
    // ③ 列表里的三个动作走**事件委托**（列表整块重画，逐项挂 onclick 会在重画后全丢）。
    assert.match(code, /\$\('#syncSpacesList'\)\.addEventListener\('click'/);
    for (const action of ['toggle-space', 'delete-space', 'retry-spaces']) {
        assert.match(code, new RegExp(`action === '${action}'`), `${action} 要有委托分支`);
    }
    assert.match(code, /action === 'toggle-space'[\s\S]{0,160}toggleSyncSpace\(event\.target\.dataset\.id, event\.target\.dataset\.disabled === '1'\)/,
        '停用/启用按 data-disabled 传布尔值（传字符串 "0" 会是真值 → 永远停用）');
    assert.match(code, /action === 'delete-space'[\s\S]{0,120}deleteSyncSpace\(/);
    assert.match(methodBodyOf(cleanApp, 'toggleSyncSpace'), /\/api\/admin\/sync-spaces\/\$\{encodeURIComponent\(id\)\}\/disable/);
    const deleteSpace = methodBodyOf(cleanApp, 'deleteSyncSpace');
    // 钉意图（删除不可撤销 → 先确认），不钉确认的**实现方式**：早先这里钉的是
    // `window.confirm(`，而原生对话框既阻塞脚本线程、样式又与项目不一致，
    // 自动化里还会被默认丢掉（等于按钮永远点不成）。现在走仓库自己的 `confirmAction`。
    assert.match(deleteSpace, /await this\.confirmAction\(/, '删除不可撤销，要先确认');
    assert.match(deleteSpace, /\/api\/admin\/sync-spaces\/\$\{encodeURIComponent\(id\)\}\/delete/);
    // ④ 面板是新建的 DOM：勾选态必须从服务端确认过的值重画一次（模板里的 checked 是写死的）。
    assert.match(code, /\$\('#syncSpacesList'\)[\s\S]{0,900}this\.paintSyncPolicy\(\)/);
    // ⑤ 列表里只画非敏感项：标识前 8 位 + 状态 + 体积 + 版本 + 代次 + 设备数。
    const paint = methodBodyOf(cleanApp, 'paintSyncSpaces');
    assert.match(paint, /String\(space\.id\)\.slice\(0, 8\)/, '标识只显示前 8 位');
    for (const field of ['contentBytes', 'revision', 'generation', 'activeDevices']) {
        assert.match(paint, new RegExp(`space\\.${field}`), `列表要显示 ${field}`);
    }
    for (const forbidden of ['space.config', 'configJson', 'modules', 'proof', 'deviceToken', 'token']) {
        assert.doesNotMatch(paint, new RegExp(forbidden), `列表不得画 ${forbidden}（服务端也不回，但界面这一层同样不许有落脚点）`);
    }
});

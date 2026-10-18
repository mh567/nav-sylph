'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
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
    const persisted = [];
    const make = (failOnFirstWrite) => {
        let writes = 0;
        const app = {
            syncBusy: true,
            syncProof: 'proof',
            syncConnection: null,
            syncCloud: null,
            config: { theme: 'auto' },
            localModulePayload: () => ({ enabled: [], widgets: [], settings: {} }),
            setSyncState: (state, message) => states.push({ state, message: message || '' }),
            showToast: () => {},
            persistSyncConnection: async (snapshot) => {
                writes++;
                if (failOnFirstWrite && writes === 1) throw new Error('配额已满');
                persisted.push(snapshot);
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
    assert.match(states[0].message, /未能保存到本机/);

    // ② 新建空间（方向 local 且没有云端内容）→ 先落盘再 connected，且**不留**
    //    「替换前的副本」：云端本来就没有东西可替换。
    states.length = 0;
    const created = make(false);
    await invoke(created, { spaceId: 'space', deviceToken: 'tok'.repeat(20), generation: 1, revision: 1 }, 'local');
    assert.deepEqual(states.map(s => s.state), ['connected']);
    assert.equal(persisted.length, 2, '凭据落盘 + 版本回写，两次都落盘成功');
    assert.equal(persisted[0].connection.deviceToken, 'tok'.repeat(20));
    assert.equal(persisted[0].recovery, null, '新建不该声称保留了一份替换前的副本');
    assert.equal(created.syncCloud.revision, 9, '上传后状态行显示的是刚写下的版本，不是上传前的');

    // ③ 连接既有空间并「以本机配置替换云端」→ recovery 是**云端**那一份
    states.length = 0;
    const replaced = make(false);
    const cloudBefore = { config: { theme: 'auto' }, modules: { enabled: [] } };
    await invoke(replaced, { spaceId: 'space', deviceToken: 'tok'.repeat(20), generation: 1, revision: 3, cloud: cloudBefore }, 'local');
    assert.deepEqual(states.map(s => s.state), ['connected']);
    const replaceSnapshot = persisted[persisted.length - 1];
    assert.equal(replaceSnapshot.recovery.direction, 'cloud');
    assert.deepEqual(replaceSnapshot.recovery.config, cloudBefore.config, '存的是被覆盖前的云端内容');

    // ④ 采用云端配置 → recovery 是**本机**那一份，且取自改动之前
    states.length = 0;
    const adopted = make(false);
    await invoke(adopted, { spaceId: 'space', deviceToken: 'tok'.repeat(20), generation: 1, revision: 3, cloud: { config: { theme: 'dark' }, modules: { enabled: [] } } }, 'cloud');
    assert.deepEqual(states.map(s => s.state), ['connected']);
    const adoptSnapshot = persisted[persisted.length - 1];
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

test('访客的同步接口不受限流豁免，管理员邀请码接口必须带限流与管理员会话', () => {
    const code = stripComments(serverSource);
    const guestRoutes = [...code.matchAll(/app\.(get|post)\('(\/api\/sync[^']*)'([^,]*(?:,|\)))/g)];
    assert.equal(guestRoutes.length, 5, `访客侧应恰好 5 条，实际 ${guestRoutes.length}`);
    for (const [, , route] of guestRoutes) {
        assert.doesNotMatch(code, new RegExp(`'${route.replace(/[/]/g, '\\/')}',\\s*requireAdmin`),
            `${route} 不能要求管理员会话——访客就是没有会话的那个人`);
    }
    // 连接类三条各挂 IP 桶；读写两条走设备令牌 + 按空间限流
    for (const route of ['/api/sync/space/check', '/api/sync/space/create', '/api/sync/space/connect']) {
        assert.match(code, new RegExp(`app\\.post\\('${route.replace(/[/]/g, '\\/')}', syncConnectLimit`), `${route} 挂连接桶`);
    }
    for (const kind of ['read', 'write']) {
        assert.match(code, new RegExp(`syncDeviceGuard\\('${kind}'\\)`), `${kind} 走设备令牌 + 按空间限流`);
    }

    const adminRoutes = [...code.matchAll(/app\.(get|post)\('(\/api\/admin\/sync-invites[^']*)'/g)].map(m => m[2]);
    assert.equal(adminRoutes.length, 3, `管理员侧应恰好 3 条，实际 ${adminRoutes.length}`);
    for (const route of adminRoutes) {
        assert.match(code, new RegExp(`'${route.replace(/[/]/g, '\\/')}', rateLimit, requireAdmin`),
            `${route} 必须走 rateLimit + requireAdmin`);
    }
});

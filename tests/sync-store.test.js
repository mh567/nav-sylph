'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { createHash } = require('node:crypto');
const { openDatabase, MIGRATIONS } = require('../lib/db');
const sync = require('../lib/sync-store');

// 口令 → 连接证明的派生**按浏览器那一侧的做法算**（Web Crypto + 同一个标签），
// 而不是在测试里另写一遍服务端口径。这样这组用例同时钉住了「两侧派生一致」：
// 标签一旦有一侧改动，证明就定位不到空间，用例立刻红。
async function spaceProof(passphrase) {
    const bytes = new TextEncoder().encode(`${sync.CONNECT_LABEL}\u0000${passphrase}`);
    const digest = await require('node:crypto').webcrypto.subtle.digest('SHA-256', bytes);
    return Buffer.from(digest).toString('hex');
}

const CONFIG = {
    theme: 'auto',
    showBookmarkIcons: true,
    searchEngine: 'g',
    searchEngines: [{ id: 'g', name: 'Google', url: 'https://www.google.com/search?q=' }],
    categories: [{ id: 'c1', name: '工作', bookmarks: [{ id: 'b1', title: 'Example', url: 'https://example.com/' }] }]
};
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function fixture(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-sync-'));
    const file = path.join(dir, 'nav-sylph.db');
    const db = openDatabase(file);
    let clock = Date.now();
    let hash = await bcrypt.hash('StrongPass123!', 4);
    const store = sync.createSyncStore(db, {
        now: () => clock,
        getPasswordHash: () => hash,
        publicModuleIds: () => options.modules || ['weibo-hot'],
        // #10：额度注入。缺省（undefined）时 store 自己回到 DIFFICULTY 的三个规格值——
        // 这正是「默认值」那条用例要验证的路径，所以这里**不能**替它写默认值。
        limits: options.limits
    });
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return {
        store, db, file,
        // 另外造一个 store 共用同一张库：用来表现「管理员事后把限额调小 / 调大」，
        // 因为额度是**每个 store 实例**在构造时解析的（与 server.js 从 env 读同一处）。
        storeWith: limits => sync.createSyncStore(db, {
            now: () => clock,
            getPasswordHash: () => hash,
            publicModuleIds: () => options.modules || ['weibo-hot'],
            limits
        }),
        now: () => clock,
        hash: () => hash,
        advance: (ms) => { clock += ms; },
        setHash: (next) => { hash = next; },
        create: async (passphrase, inviteCode, extra = {}) => store.createSpace({
            proof: await spaceProof(passphrase), inviteCode, operationId: `op-${Math.random().toString(36).slice(2)}`,
            config: CONFIG, modules: {}, ...extra
        }),
        connect: async (passphrase, operationId) => store.connectSpace({
            proof: await spaceProof(passphrase), operationId: operationId || `op-${Math.random().toString(36).slice(2)}`
        }),
        check: async (passphrase) => store.checkSpace({ proof: await spaceProof(passphrase) })
    };
}

/**
 * 造一份「config_json + modules_json 的 UTF-8 字节数」**逐字节等于** `target` 的载荷。
 *
 * 用书签的超长 URL 撑体积：URL 每多一个 ASCII 字符就多一个字节，所以能精确命中
 * 边界（`bytes > limit` 与 `bytes === limit` 是额度这条闸门的两个面）。一条 URL 最长
 * 4096，所以大载荷会摊到多条书签上，最后一条补差值——不做逐字节试探（20000 字节要跑
 * 两万轮 JSON.stringify）。
 */
function payloadAtExactBytes(target, modules = {}) {
    const bookmarks = [{ id: 'b1', title: 't', url: 'https://e.example/' }];
    const config = { ...CONFIG, categories: [{ id: 'c1', name: '工作', bookmarks }] };
    const PREFIX = 'https://e.example/';
    const ROOM = 4000;      // 单条 URL 的填充上限（PREFIX + 4000 = 4018 < 4096）
    for (let guard = 0; guard < 40; guard++) {
        const gap = target - payloadBytes({ ...config, categories: [{ ...config.categories[0], bookmarks }] }, modules);
        if (gap === 0) return { ...config, categories: [{ ...config.categories[0], bookmarks }] };
        assert.ok(gap > 0, `目标 ${target} 已经越过（差 ${gap}）：换更小的目标`);
        const last = bookmarks[bookmarks.length - 1];
        const room = ROOM - (last.url.length - PREFIX.length);
        if (room === 0) {
            bookmarks.push({ id: `b${bookmarks.length + 1}`, title: 't', url: PREFIX });
            continue;
        }
        last.url += 'a'.repeat(Math.min(room, gap));
    }
    throw new Error(`撑不到 ${target} 字节`);
}

/** 与 store 的 `contentBytes()` 同口径：**归一化之后**两段 JSON 的 UTF-8 字节数之和。 */
function payloadBytes(config, modules = {}) {
    return Buffer.byteLength(JSON.stringify(sync.validateSyncConfig(config)), 'utf8')
        + Buffer.byteLength(JSON.stringify(sync.normalizeSyncModules(modules, ['weibo-hot'])), 'utf8');
}


function expectStatus(fn, predicate) {
    try {
        fn();
    } catch (error) {
        assert.ok(predicate(error), `意外的错误：${error.code || error.status} ${error.message}`);
        return error;
    }
    throw new Error('期望抛错，但没有');
}

test('口令空间：邀请码 48 小时一次性，撤销与过期都拦住创建', async (t) => {
    const f = await fixture(t);
    const invite = f.store.createInvite().invite;
    assert.equal(invite.expiresAt - invite.createdAt, 48 * HOUR, '默认有效期 48 小时');
    assert.match(invite.code, /^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/, '展示形态是分组十六进制');

    const created = await f.create('口令 ABC 123', invite.code);
    assert.equal(created.success, true);
    assert.equal(created.revision, 1, '新空间从 revision 1 开始');
    assert.equal(created.generation, 1);
    assert.equal(created.entryCount, 1);

    // 一次性：同一张邀请码换个口令也不行（不能凭空多开一个空间）。
    expectStatus(() => f.store.createSpace({ proof: 'a'.repeat(64), inviteCode: invite.code, operationId: 'second', config: CONFIG }), (e) => e.code === 'invite_used');

    // 撤销。
    const revoked = f.store.createInvite().invite;
    f.store.revokeInvite(revoked.id);
    expectStatus(() => f.store.createSpace({ proof: 'b'.repeat(64), inviteCode: revoked.code, operationId: 'third', config: CONFIG }), (e) => e.code === 'invite_revoked');

    // 过期。
    const expiring = f.store.createInvite().invite;
    f.advance(48 * HOUR + 1);
    expectStatus(() => f.store.createSpace({ proof: 'c'.repeat(64), inviteCode: expiring.code, operationId: 'fourth', config: CONFIG }), (e) => e.code === 'invite_expired');

    // 列表如实反映三种状态。
    const listed = f.store.listInvites().invites;
    assert.equal(listed.find((i) => i.id === invite.id).used, true);
    assert.equal(listed.find((i) => i.id === revoked.id).revoked, true);
    assert.equal(listed.find((i) => i.id === expiring.id).expired, true);
    assert.equal(JSON.stringify(listed).includes(invite.code.replace(/-/g, '')), false, '列表不回传邀请码本身');
});

test('邀请码归一化：分隔符与大小写可容忍，长度不对直接拒绝', () => {
    const code = 'abcdef0123456789abcdef01';
    assert.equal(sync.normalizeInviteCode(sync.formatInviteCode(code)), code);
    assert.equal(sync.normalizeInviteCode(code.toUpperCase()), code);
    assert.equal(sync.normalizeInviteCode(` ${sync.formatInviteCode(code)} `), code);
    for (const bad of ['', 'xyz', 'a'.repeat(23), 'z'.repeat(24), 12, null, undefined]) {
        expectStatus(() => sync.normalizeInviteCode(bad), (e) => e.code === 'invite_invalid');
    }
});

test('口令空间：既有空间连接不消耗邀请码，口令不裁空格也不归一化', async (t) => {
    const f = await fixture(t);
    const invite = f.store.createInvite().invite;
    await f.create('口令 ABC 123', invite.code);
    const before = f.store.listInvites().invites.filter((i) => !i.used).length;
    assert.equal(before, 0, '只有那一张，已用掉');

    // 连接既有空间：不带邀请码照样成功，也不会消耗任何邀请码。
    const connected = await f.connect('口令 ABC 123');
    assert.equal(connected.success, true);
    assert.equal(f.store.listInvites().invites.filter((i) => !i.used).length, 0, '连接不新增、不消耗邀请码');

    // 首尾空格与大小写都是口令的一部分：派生出的证明不同 → 定位不到空间。
    for (const variant of ['口令 ABC 123 ', ' 口令 ABC 123', '口令 abc 123']) {
        const other = await f.store.checkSpace({ proof: await spaceProof(variant) });
        assert.equal(other.exists, false, `变体必须定位不到空间：${JSON.stringify(variant)}`);
    }
    assert.equal((await f.check('口令 ABC 123')).exists, true);
});

test('口令空间：并发创建只有一路成功，且只消耗一张邀请码', async (t) => {
    const f = await fixture(t);
    const invites = Array.from({ length: 5 }, () => f.store.createInvite().invite);
    const proof = await spaceProof('同一个口令');
    // better-sqlite3 同步执行，这里验证的是「连续 5 次只有一个赢」；
    // 真正的并发在 tests/sync-http.test.js 用真 HTTP 再验一次。
    const settled = invites.map((invite, index) => {
        try {
            return { ok: true, value: f.store.createSpace({ proof, inviteCode: invite.code, operationId: `race-${index}`, config: CONFIG }) };
        } catch (error) {
            return { ok: false, code: error.code };
        }
    });
    assert.equal(settled.filter((s) => s.ok).length, 1, '恰好一次成功');
    assert.deepEqual([...new Set(settled.filter((s) => !s.ok).map((s) => s.code))], ['space_exists']);
    const used = f.store.listInvites().invites.filter((i) => i.used);
    assert.equal(used.length, 1, '失败的创建不能烧掉邀请码');
});

test('口令空间：连接幂等（同 operationId 返回同一令牌、设备不新增）', async (t) => {
    const f = await fixture(t);
    await f.create('幂等口令', f.store.createInvite().invite.code);
    const first = await f.connect('幂等口令', 'stable-request');
    const second = await f.connect('幂等口令', 'stable-request');
    assert.equal(second.deviceToken, first.deviceToken, '重试拿回同一份材料');
    assert.equal(second.revision, first.revision);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sync_devices').get().n, 2, '创建 1 台 + 连接 1 台');

    const third = await f.connect('幂等口令', 'another-request');
    assert.notEqual(third.deviceToken, first.deviceToken);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sync_devices').get().n, 3, '新请求才新增设备');
});

test('口令空间：设备令牌只存哈希，库里任何地方都没有明文', async (t) => {
    const f = await fixture(t);
    const created = await f.create('明文检查口令', f.store.createInvite().invite.code);
    const token = created.deviceToken;
    assert.match(token, /^[0-9a-f]{64}$/, '32 字节安全随机');

    const row = f.db.prepare('SELECT * FROM sync_devices').get();
    assert.equal(row.token_hash, createHash('sha256').update(`sylph-device-token-v1\u0000${token}`).digest('hex'));
    assert.equal('token' in row, false, '设备表里没有明文令牌列');
    const receipt = f.db.prepare('SELECT * FROM sync_receipts').get();
    assert.equal(receipt.material.includes(token), false, '回执里是密文，不是明文令牌');
    assert.deepEqual(Object.keys(JSON.parse(receipt.material)).sort(), ['data', 'iv', 'tag'], '回执是 AES-GCM 信封');

    // 连库文件（含 WAL）里都不该出现令牌明文。
    const dump = [f.file, `${f.file}-wal`, `${f.file}-shm`]
        .filter((name) => fs.existsSync(name))
        .map((name) => fs.readFileSync(name).toString('latin1'))
        .join('');
    assert.equal(dump.includes(token), false, '磁盘文件里没有明文令牌');
    assert.equal(dump.includes('明文检查口令'), false, '磁盘文件里没有明文口令');
});

test('口令空间：代次递增后旧令牌与旧回执一律失效', async (t) => {
    const f = await fixture(t);
    await f.create('代次口令', f.store.createInvite().invite.code);
    const connected = await f.connect('代次口令', 'before-reset');
    assert.equal((await f.store.readConfig(connected.deviceToken)).revision, 1);

    // 模拟 #9 的「撤销全部旧设备并重新连接」：代次 +1。
    f.db.prepare('UPDATE sync_spaces SET generation = generation + 1').run();
    expectStatus(() => f.store.readConfig(connected.deviceToken), (e) => e.status === 401 && e.code === 'device_invalid');

    // 旧回执不能把刚作废的令牌要回来。
    await assert.rejects(f.connect('代次口令', 'before-reset'), (e) => e.code === 'receipt_stale');
    // 重新连接拿到的是当前代次。
    const reconnected = await f.connect('代次口令', 'after-reset');
    assert.equal(reconnected.generation, 2);
    assert.equal((await f.store.readConfig(reconnected.deviceToken)).generation, 2);
});

test('口令空间：令牌连续 90 天没成功鉴权即过期，清理时被删掉', async (t) => {
    const f = await fixture(t);
    await f.create('久置口令', f.store.createInvite().invite.code);
    const connected = await f.connect('久置口令', 'idle');
    f.advance(89 * DAY);
    assert.equal((await f.store.readConfig(connected.deviceToken)).revision, 1, '89 天内仍可用，并滑动续期');
    f.advance(89 * DAY);
    assert.equal((await f.store.readConfig(connected.deviceToken)).revision, 1, '续期后又能再用一段');
    f.advance(90 * DAY + 1);
    expectStatus(() => f.store.readConfig(connected.deviceToken), (e) => e.code === 'device_expired');
    f.store.sweep();
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sync_devices').get().n, 0, '清理删除长期没鉴权的设备');
});

test('口令空间：配置只收导航 schema，管理员字段、收藏、私人模块都进不来', async (t) => {
    const f = await fixture(t);
    const invite = f.store.createInvite().invite;
    const reject = (payload, expected) => {
        expectStatus(() => sync.validateSyncConfig(payload), (e) => e.status === 400 && new RegExp(expected).test(e.message));
    };
    reject({ ...CONFIG, privacyMode: true }, '不允许的字段');
    reject({ ...CONFIG, favorites: [] }, '不允许的字段');
    reject({ ...CONFIG, adminToken: 'x' }, '不允许的字段');
    reject({ ...CONFIG, searchEngine: 'missing' }, '搜索引擎');
    reject({ ...CONFIG, searchEngines: [{ id: 'g', name: 'Bad', url: 'javascript:alert(1)' }] }, '搜索引擎');
    reject({ ...CONFIG, searchEngines: [{ id: 'g', name: 'Bad', url: 'https://x/?q={q}' }] }, '搜索引擎');
    reject({ ...CONFIG, categories: [{ id: 'c1', name: 'c', bookmarks: new Array(2001).fill({ id: 'b', title: 't', url: 'https://x/' }) }] }, '数量|导航链接');
    reject({ ...CONFIG, theme: 'neon' }, '显示偏好');
    assert.equal(sync.validateSyncConfig(CONFIG).theme, CONFIG.theme);

    // 模块偏好：未知顶层键（servers / publicModules / pollInterval）直接拒绝。
    expectStatus(() => sync.normalizeSyncModules({ servers: [] }, ['weibo-hot']), (e) => e.status === 400);
    expectStatus(() => sync.normalizeSyncModules({ pollInterval: 30 }, ['weibo-hot']), (e) => e.status === 400);
    expectStatus(() => sync.normalizeSyncModules({ enabled: 'weibo-hot' }, ['weibo-hot']), (e) => e.status === 400);
    expectStatus(() => sync.normalizeSyncModules({ settings: { 'weibo-hot': { deep: { nested: 1 } } } }, ['weibo-hot']), (e) => e.status === 400);
    expectStatus(() => sync.normalizeSyncModules({ settings: { 'weibo-hot': { text: 'x'.repeat(201) } } }, ['weibo-hot']), (e) => e.status === 400);
    assert.deepEqual(sync.normalizeSyncModules({ enabled: ['weibo-hot'] }, ['weibo-hot']).enabled, ['weibo-hot']);

    // 私人模块 id 不会进库。
    const created = await f.store.createSpace({
        proof: await spaceProof('模块口令'), inviteCode: invite.code, operationId: 'modules-private',
        config: CONFIG, modules: { enabled: ['weibo-hot', 'memo', 'special-line'], widgets: [{ id: 'memo', side: 'left', order: 3 }], settings: { memo: { collapsed: true }, 'weibo-hot': { limit: 10 } } }
    });
    const stored = JSON.parse(f.db.prepare('SELECT modules_json FROM sync_spaces WHERE id = ?').get(created.spaceId).modules_json);
    assert.deepEqual(stored.enabled, ['weibo-hot'], '私人模块 id 不落库');
    assert.deepEqual(stored.widgets, [], '私人模块的布局项不落库');
    assert.deepEqual(Object.keys(stored.settings), ['weibo-hot'], '私人模块的偏好不落库');
    assert.deepEqual(stored.settings['weibo-hot'], { limit: 10 });
});

test('口令空间：读写走 revision 版本协议，冲突 409，回执幂等', async (t) => {
    const f = await fixture(t);
    await f.create('版本口令', f.store.createInvite().invite.code);
    const device = (await f.connect('版本口令', 'reader')).deviceToken;

    const read = await f.store.readConfig(device);
    assert.equal(read.revision, 1);
    assert.equal(read.generation, 1);
    assert.equal(read.config.categories.length, 1);

    const next = { ...CONFIG, theme: 'dark', categories: [{ id: 'c1', name: '工作', bookmarks: [{ id: 'b1', title: 'A', url: 'https://a.example/' }, { id: 'b2', title: 'B', url: 'https://b.example/' }] }] };
    const writeBody = { revision: 1, operationId: 'write-one', config: next, modules: { enabled: ['weibo-hot'] } };
    const saved = f.store.writeConfig(device, writeBody);
    // 写入响应带 revision + generation + updatedAt（客户端要落进连接记录与状态行，
    // 省掉一次「写完再问一遍」的往返），所以按字段断言而不是整对象 deepEqual。
    assert.equal(saved.success, true);
    assert.equal(saved.revision, 2);
    assert.equal(saved.generation, 1);
    assert.ok(Number.isSafeInteger(saved.updatedAt));
    assert.equal(f.store.readConfig(device).revision, 2);
    assert.equal(f.store.readConfig(device).config.theme, 'dark');
    assert.equal((await f.check('版本口令')).entryCount, 2, '检查接口的条目数跟着走');

    assert.deepEqual(f.store.writeConfig(device, writeBody), saved, '同 ID 同内容返回原结果');
    assert.equal(f.store.readConfig(device).revision, 2, '重放不重复写入');
    expectStatus(() => f.store.writeConfig(device, { ...writeBody, revision: 2, config: { ...next, theme: 'light' } }), (e) => e.code === 'operation_conflict');
    expectStatus(() => f.store.writeConfig(device, { revision: 1, operationId: 'stale-base', config: next }), (e) => e.code === 'revision_conflict');
    expectStatus(() => f.store.writeConfig(device, { operationId: 'no-revision', config: next }), (e) => e.code === 'revision_required');

    // 另一台设备用同一个基线写入也会撞上冲突，而不是覆盖。
    const other = (await f.connect('版本口令', 'writer-two')).deviceToken;
    expectStatus(() => f.store.writeConfig(other, { revision: 1, operationId: 'other-base', config: CONFIG }), (e) => e.code === 'revision_conflict');
    assert.equal(f.store.writeConfig(other, { revision: 2, operationId: 'other-ok', config: CONFIG }).revision, 3);
});

test('口令空间：证明与令牌的形状受严格校验', async (t) => {
    const f = await fixture(t);
    for (const bad of [undefined, null, '', 'not-hex', 'a'.repeat(63), 'a'.repeat(65), 12345, {}]) {
        expectStatus(() => f.store.checkSpace({ proof: bad }), (e) => e.status === 400 && e.code === 'proof_invalid');
    }
    for (const bad of [undefined, null, '', 'a'.repeat(63), 'Z'.repeat(64), {}]) {
        expectStatus(() => f.store.readConfig(bad), (e) => e.status === 401 && e.code === 'device_invalid');
    }
    // 形状合法但库里没有的令牌同样拒绝，且与「格式错」是同一种回答：
    // 不给探测者区分「这个令牌存不存在」的信息。
    expectStatus(() => f.store.readConfig('f'.repeat(64)), (e) => e.status === 401 && e.code === 'device_invalid');
});

test('口令空间：换用途/版本标签的证明定位不到空间', async (t) => {
    const f = await fixture(t);
    await f.create('标签口令', f.store.createInvite().invite.code);
    const otherPurpose = await (async () => {
        const bytes = new TextEncoder().encode('sylph-space-admin-v1\u0000标签口令');
        return Buffer.from(await require('node:crypto').webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
    })();
    assert.equal(f.store.checkSpace({ proof: otherPurpose }).exists, false);
    await assert.rejects(async () => f.store.connectSpace({ proof: otherPurpose, operationId: 'wrong-purpose' }), (e) => e.status === 404 && e.code === 'space_not_found');
});

test('口令空间：check 不存在 → 不存在就是不存在，不隐式创建', async (t) => {
    const f = await fixture(t);
    const missing = await f.check('还没有人用过的口令');
    assert.deepEqual(missing, { exists: false });
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sync_spaces').get().n, 0, '检查不会创建空间');
    const missingProof = await spaceProof('还没有人用过的口令');
    expectStatus(() => f.store.connectSpace({ proof: missingProof, operationId: 'nothing' }), (e) => e.status === 404 && e.code === 'space_not_found');

    const created = await f.create('还没有人用过的口令', f.store.createInvite().invite.code);
    const found = await f.check('还没有人用过的口令');
    assert.equal(found.exists, true);
    assert.equal(found.revision, created.revision);
    assert.equal(found.entryCount, 1);
    assert.ok(Number.isSafeInteger(found.updatedAt));
});

test('口令空间：改密码后旧回执解不开，重试改为要求重新输入口令', async (t) => {
    const f = await fixture(t);
    await f.create('改密口令', f.store.createInvite().invite.code);
    const first = await f.connect('改密口令', 'receipt-before-rotation');
    // 改密（模拟 server.js 的改密流程：哈希换了）。真实流程还会清表，
    // 这里故意不清，验证的是「解不开也不能把材料交出去」这道兜底。
    f.setHash(await bcrypt.hash('AnotherPass456!', 4));
    await assert.rejects(f.connect('改密口令', 'receipt-before-rotation'), (e) => e.code === 'receipt_expired');
    // 旧回执作废不影响已经签发的令牌本身。
    assert.equal((await f.store.readConfig(first.deviceToken)).revision, 1);
    // 新请求照常签发。
    assert.match((await f.connect('改密口令', 'receipt-after-rotation')).deviceToken, /^[0-9a-f]{64}$/);
});

test('口令空间：回执超过 24 小时后先按当前版本协调，不重复签发', async (t) => {
    const f = await fixture(t);
    await f.create('回执口令', f.store.createInvite().invite.code);
    const first = await f.connect('回执口令', 'aging-receipt');
    // 回执按 (scope, operationId) 一行。同 ID 重试不该多出一行——
    // 断言「恰好一行」而不是「不超过两行」：后者在 0 行时也成立，抓不到任何东西。
    const receiptsFor = () => f.db.prepare(`SELECT COUNT(*) AS n FROM sync_receipts WHERE scope = 'connect:' || (SELECT id FROM sync_spaces)`).get().n;
    assert.equal(receiptsFor(), 1, '一次连接只留一行回执');
    await f.connect('回执口令', 'aging-receipt');
    assert.equal(receiptsFor(), 1, '同 ID 重试不新增回执');
    f.advance(24 * HOUR + 1);
    const second = await f.connect('回执口令', 'aging-receipt');
    assert.notEqual(second.deviceToken, first.deviceToken, '回执过期后按正常流程重新签发');
    assert.equal(receiptsFor(), 1, '过期的那行被清掉，新的补上——仍然只有一行');
});

test('口令空间：签发新设备令牌按空间封顶（口令已知也不能无限换设备）', async (t) => {
    const f = await fixture(t);
    await f.create('签发口令', f.store.createInvite().invite.code);
    // store 不知道限流策略，只回调；这里用一个 3 次的桩把「回调确实在插入设备行之前被调用」钉住。
    const issued = [];
    let allow = 3;
    const limited = sync.createSyncStore(f.db, {
        now: () => Date.now(),
        getPasswordHash: () => 'hash',
        publicModuleIds: () => ['weibo-hot'],
        onIssue: (spaceId) => {
            issued.push(spaceId);
            if (issued.length > allow) throw Object.assign(new Error('签发过于频繁'), { status: 429, code: 'issue_limited' });
        }
    });
    const proof = await spaceProof('签发口令');
    for (let i = 0; i < allow; i++) limited.connectSpace({ proof, operationId: `issue-${i}` });
    assert.equal(issued.length, allow, '每次签发都回调了');
    expectStatus(() => limited.connectSpace({ proof, operationId: 'issue-over' }), (e) => e.status === 429 && e.code === 'issue_limited');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sync_devices').get().n, 4, '被限流的那次没有插入设备行');
    // 回执重放不签发新设备，因此也不该再吃一次签发额度。
    const before = issued.length;
    limited.connectSpace({ proof, operationId: 'issue-0' });
    assert.equal(issued.length, before, '重放不走签发回调');
});

test('口令空间：sweep 清理过期/已撤销的邀请码记录，但不丢刚建的', async (t) => {
    const f = await fixture(t);
    const unused = f.store.createInvite().invite;
    const revoked = f.store.createInvite().invite;
    f.store.revokeInvite(revoked.id);
    const consumed = f.store.createInvite().invite;
    await f.create('清理口令', consumed.code);

    // 一天后：三种状态都还在，管理界面能看到历史——「过期」不等于「消失」。
    f.advance(DAY);
    f.store.sweep();
    assert.equal(f.store.listInvites().invites.length, 3);
    assert.equal(f.store.listInvites().invites.every((i) => i.expired), false, '48 小时内还没过期');

    // 十五天后：老的三种记录（未用/已撤销/已使用）都过了保留窗口。
    f.advance(14 * DAY);
    f.store.sweep();
    const fresh = f.store.createInvite().invite;
    f.store.sweep();
    assert.deepEqual(f.store.listInvites().invites.map((i) => i.id), [fresh.id], '只留下刚建的那张');
    assert.equal(f.store.listInvites().invites[0].expired, false);
});

// ==================== #10：额度、总暂停、设备回收、清理顺序 ====================

test('额度：三个默认值与设计规格逐字相等，注入只覆盖传进来的那几项', async (t) => {
    // 只测注入路径的话，「默认值被改小」这类变异照样全绿（注入的用例全在传限额），
    // 所以这里把规格数**写死**对拍一次：1000 空间 / 1 MiB 每空间 / 1 GiB 全实例。
    assert.deepEqual(sync.DIFFICULTY, { spaceLimit: 1000, contentBytesLimit: 1048576, totalBytesLimit: 1073741824 });
    const f = await fixture(t);
    assert.deepEqual(f.store.limits, sync.DIFFICULTY, '不传 limits 时用的就是规格值');
    // 只有传进来的那一项被覆盖，其余仍回到规格值（`?? 规格` 而不是「全有或全无」）。
    assert.deepEqual(f.storeWith({ spaceLimit: 3 }).limits,
        { spaceLimit: 3, contentBytesLimit: 1048576, totalBytesLimit: 1073741824 });
});

test('额度：全实例空间数上限用 503 space_limit，被拒的创建既不消耗邀请码也不淘汰已有空间', async (t) => {
    const f = await fixture(t, { limits: { spaceLimit: 2 } });
    const invites = [f.store.createInvite().invite, f.store.createInvite().invite, f.store.createInvite().invite];
    const one = await f.create('上限口令甲', invites[0].code);
    const two = await f.create('上限口令乙', invites[1].code);
    const before = f.db.prepare('SELECT id, revision, config_json FROM sync_spaces WHERE deleted = 0 ORDER BY id').all();

    expectStatus(() => f.store.createSpace({
        proof: 'c'.repeat(64), inviteCode: invites[2].code, operationId: 'over-limit', config: CONFIG, modules: {}
    }), (e) => e.status === 503 && e.code === 'space_limit');

    assert.equal(f.store.listInvites().invites.find((i) => i.id === invites[2].id).used, false,
        '被额度拒绝的创建不能烧掉邀请码——那是用户唯一一张');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_spaces').get().n, 2, '没有偷偷多建一个');
    // **绝不淘汰**：额度满了只是拒绝新的，已有的两个空间一个字段都不许动。
    assert.deepEqual(f.db.prepare('SELECT id, revision, config_json FROM sync_spaces WHERE deleted = 0 ORDER BY id').all(), before);
    assert.equal(f.store.readConfig(one.deviceToken).revision, 1);
    assert.equal(f.store.readConfig(two.deviceToken).revision, 1);
});

test('额度：每空间上限口径是 config+modules 之和，物化字节数与 Buffer.byteLength 一致（含非 ASCII）', async (t) => {
    const f = await fixture(t, { limits: { contentBytesLimit: 4096 } });
    const created = await f.create('口径口令', f.store.createInvite().invite.code);
    const token = (await f.connect('口径口令', 'quota-device')).deviceToken;

    // 一份**非 ASCII**载荷：中文分类/书签 + emoji。没有它，下面「字节数 ≠ 字符数」
    // 那条断言在纯 ASCII 上也成立，等于没测（v11 的 CAST 就是为它写的）。
    const config = payloadAtExactBytes(3000);
    config.searchEngines[0].name = '谷歌';
    config.categories[0].bookmarks[0].title = '中文书签😀';
    const size = payloadBytes(config, { enabled: ['weibo-hot'] });
    assert.ok(size <= 4096, `这份载荷要在限额之内（${size}）`);
    f.store.writeConfig(token, { revision: 1, operationId: 'q-1', config, modules: { enabled: ['weibo-hot'] } });

    const row = f.db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(created.spaceId);
    const expected = Buffer.byteLength(row.config_json, 'utf8') + Buffer.byteLength(row.modules_json, 'utf8');
    assert.equal(row.content_bytes, expected, '物化值 = config_json 与 modules_json 的 UTF-8 字节数之和');
    assert.match(row.config_json, /[\u4e00-\u9fff]/, '载荷里必须真的有中文');
    assert.equal(row.content_bytes > row.config_json.length + row.modules_json.length, true,
        `字节数必须大于字符数（${row.content_bytes} vs ${row.config_json.length + row.modules_json.length}），否则这条口径没被区分开`);

    // 边界：`bytes > limit` 是判据，所以**恰好等于**上限必须放行。先缩到 4096 再写满。
    f.store.writeConfig(token, { revision: 2, operationId: 'q-shrink', config: payloadAtExactBytes(4096, { enabled: ['weibo-hot'] }), modules: { enabled: ['weibo-hot'] } });
    assert.equal(f.db.prepare('SELECT content_bytes FROM sync_spaces WHERE id = ?').get(created.spaceId).content_bytes, 4096);
    // 增长一格（4097）就必须被拒，而且拒绝之后内容与版本都不动。
    const atLimit = f.db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(created.spaceId);
    const error = expectStatus(() => f.store.writeConfig(token, {
        revision: atLimit.revision, operationId: 'q-over', config: payloadAtExactBytes(4097, { enabled: ['weibo-hot'] }), modules: { enabled: ['weibo-hot'] }
    }), (e) => e.status === 503 && e.code === 'space_quota_exceeded');
    assert.match(error.message, /1 MiB|上限/, '给用户的话要说清是「满了」');
    const after = f.db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(created.spaceId);
    assert.equal(after.revision, atLimit.revision, '被拒的写不推进版本');
    assert.equal(after.config_json, atLimit.config_json, '被拒的写不改内容');
    // 读取不受额度影响（读放行了才谈得上「先精简内容」）。
    assert.equal(f.store.readConfig(token).revision, atLimit.revision);
});

test('额度：缩减写入无条件放行——限额被调小之后，用户还能把自己超限的内容减下来', async (t) => {
    // 这一条是「不留这条，用户就被自己的数据锁在门外」的观测形式：先用宽限额写进 20 KB，
    // 再模拟「管理员事后把限额调小」（同一张库上换一个 4 KiB 的 store 实例）。
    const f = await fixture(t);
    const created = await f.create('缩减口令', f.store.createInvite().invite.code);
    const token = (await f.connect('缩减口令', 'shrink-device')).deviceToken;
    f.store.writeConfig(token, { revision: 1, operationId: 'big-1', config: payloadAtExactBytes(20000), modules: {} });

    const small = f.storeWith({ contentBytesLimit: 4096 });
    // 增长：既比现在大（25000 > 20000，所以不是缩减），又超过新限额 → 503
    expectStatus(() => small.writeConfig(token, { revision: 2, operationId: 'grow', config: payloadAtExactBytes(25000), modules: {} }),
        (e) => e.code === 'space_quota_exceeded');
    // 缩减：**仍然大于新限额**（4500 > 4096），但比现在小 → 必须放行
    const saved = small.writeConfig(token, { revision: 2, operationId: 'shrink', config: payloadAtExactBytes(4500), modules: {} });
    assert.equal(saved.success, true, '缩减写入必须无条件放行');
    assert.equal(saved.revision, 3);
    assert.equal(f.db.prepare('SELECT content_bytes FROM sync_spaces WHERE id = ?').get(created.spaceId).content_bytes, 4500);
    assert.equal(f.store.readConfig(token).revision, 3);
    // 缩减之后物化值跟着缩，于是**下一次增长又受正常额度约束**（不是一劳永逸的豁免）。
    expectStatus(() => small.writeConfig(token, { revision: 3, operationId: 'grow-again', config: payloadAtExactBytes(4600), modules: {} }),
        (e) => e.code === 'space_quota_exceeded');
});

test('额度：回执重放排在额度之前——额度满了也不能让「响应丢了」的重试时成时败', async (t) => {
    const f = await fixture(t);
    const invite = f.store.createInvite().invite;
    const proof = await spaceProof('重放额度口令');
    const first = f.store.createSpace({ proof, inviteCode: invite.code, operationId: 'replay-1', config: CONFIG, modules: {} });
    // 额度满了：上限 1 个空间，而它已经被占掉了。
    const full = f.storeWith({ spaceLimit: 1 });
    const replay = full.createSpace({ proof, inviteCode: invite.code, operationId: 'replay-1', config: CONFIG, modules: {} });
    assert.equal(replay.deviceToken, first.deviceToken, '同 ID 重放拿回同一份材料，即使此刻额度已满');
    assert.equal(replay.spaceId, first.spaceId);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_devices').get().n, 1, '重放不新增设备');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_spaces').get().n, 1);
    // 对照：换一个新 ID 的创建必须被额度拒掉——证明上面那条不是「额度根本没生效」。
    expectStatus(() => full.createSpace({ proof: 'd'.repeat(64), inviteCode: f.store.createInvite().invite.code, operationId: 'fresh', config: CONFIG, modules: {} }),
        (e) => e.status === 503 && e.code === 'space_limit');
});

test('总暂停：读/写/连/建/重签一律 503 sync_paused（带 Retry-After 时刻），删除与撤销照常可用', async (t) => {
    const f = await fixture(t);
    const spare = f.store.createInvite().invite;
    const created = await f.create('暂停口令', f.store.createInvite().invite.code);
    const other = (await f.connect('暂停口令', 'paused-device')).deviceToken;
    const proof = await spaceProof('暂停口令');
    assert.equal(f.store.updateSettings({ syncPaused: true }).settings.syncPaused, true);
    const at = f.now();

    // `retryAfter` 是**时刻**（与限流那几只桶同一种表达），server.js 的 syncFailure
    // 再把它折成秒放进 `Retry-After`。两侧同值这件事有一条 HTTP 用例钉着。
    const paused = (fn, label) => {
        const error = expectStatus(fn, (e) => e.status === 503 && e.code === 'sync_paused');
        assert.equal(error.retryAfter, at + sync.SYNC_PAUSED_RETRY_MS, `${label} 要带 Retry-After 时刻`);
        return error;
    };
    paused(() => f.store.readConfig(created.deviceToken), '读');
    paused(() => f.store.writeConfig(created.deviceToken, { revision: 1, operationId: 'paused-write', config: CONFIG, modules: {} }), '写');
    paused(() => f.store.connectSpace({ proof, operationId: 'paused-connect' }), '连接');
    paused(() => f.store.createSpace({ proof: 'e'.repeat(64), inviteCode: spare.code, operationId: 'paused-create', config: CONFIG, modules: {} }), '创建');
    paused(() => f.store.resetDevices({ proof, operationId: 'paused-reset' }), '重签（撤销全部旧设备）');
    // 连**回执重放**也拒：总暂停是「现在谁都别写」，包括重试（判定排在回执之前）。
    paused(() => f.store.connectSpace({ proof, operationId: 'paused-connect' }), '连接（同 operationId 重试）');
    // 数据面全挡：库里一个字段都没变，那张备用邀请码也没被烧掉。
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_spaces').get().n, 1);
    assert.equal(f.db.prepare('SELECT revision FROM sync_spaces').get().revision, 1);
    assert.equal(f.store.listInvites().invites.find((i) => i.id === spare.id).used, false);
    // checkSpace 只回 exists/revision/entryCount（元数据，不含内容），不在冻结清单里。
    assert.equal(f.store.checkSpace({ proof }).exists, true);

    // 「我要离开」与「我要删掉自己的东西」照常：挡住它们等于管理员一开总暂停就把用户锁在里面。
    assert.equal(f.store.revokeDevice(other).success, true, '暂停期间撤销本设备照常');
    expectStatus(() => f.store.readConfig(other), (e) => e.status === 401 && e.code === 'device_revoked', '撤销真的生效了');
    const removed = f.store.deleteSpace(created.deviceToken, { proof });
    assert.equal(removed.success, true, '暂停期间删除空间照常');
    assert.equal(removed.revoked, 1, '删除照常吊销该空间的设备');
    assert.equal(f.store.checkSpace({ proof }).exists, false);

    // 解除暂停后一切照旧。
    f.store.updateSettings({ syncPaused: false });
    assert.equal(f.store.readSettings().syncPaused, false);
    const again = await f.store.createSpace({ proof: 'e'.repeat(64), inviteCode: spare.code, operationId: 'after-pause', config: CONFIG, modules: {} });
    assert.equal(again.success, true);
    assert.equal(f.store.listInvites().invites.find((i) => i.id === spare.id).used, true, '暂停解除后那张邀请码照常可用');
    // 客户端轮询间隔与服务端 Retry-After 同值（两处常量，一条断言对拍）。
    assert.equal(sync.SYNC_PAUSED_RETRY_MS, 5 * 60 * 1000);
});

test('撤销全部旧设备：revision 与内容都不动、不消耗邀请码、同 operationId 只撤一次、旧令牌与旧回执一律作废', async (t) => {
    const f = await fixture(t);
    const created = await f.create('回收口令', f.store.createInvite().invite.code);
    const a = created.deviceToken;
    const b = (await f.connect('回收口令', 'device-b')).deviceToken;
    const proof = await spaceProof('回收口令');
    // 先写一版内容：重连**不动**内容与时间戳是这条设计里的硬要求。
    const written = f.store.writeConfig(a, { revision: 1, operationId: 'before-reset', config: { ...CONFIG, theme: 'dark' }, modules: { enabled: ['weibo-hot'] } });
    const before = f.db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(created.spaceId);
    const invitesBefore = f.store.listInvites().invites.map((i) => [i.id, i.usedAt]);
    const devicesBefore = f.db.prepare('SELECT COUNT(*) n FROM sync_devices').get().n;

    const reset = f.store.resetDevices({ proof, operationId: 'reset-1' });
    assert.equal(reset.success, true);
    assert.equal(reset.generation, 2, '代次 +1');
    assert.equal(reset.revoked, 2, '两台旧设备（含发起这台）全部吊销');
    assert.equal(reset.revision, written.revision, 'revision 不变——重连不是恢复，也不是覆盖配置');
    assert.equal(reset.updatedAt, before.updated_at, '时间戳也不动');
    const after = f.db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(created.spaceId);
    assert.equal(after.config_json, before.config_json, '内容逐字节不变');
    assert.equal(after.modules_json, before.modules_json);
    assert.equal(after.content_bytes, before.content_bytes);
    assert.equal(after.revision, before.revision);
    assert.equal(after.generation, 2);
    assert.deepEqual(f.store.listInvites().invites.map((i) => [i.id, i.usedAt]), invitesBefore, '不消耗邀请码');
    // 旧令牌一律失效。⚠️ 这里是 `device_revoked` 而不是 `device_invalid`：撤销会把
    // 设备**行**标成 revoked（保留 24 小时），所以客户端拿到的是「这台设备被踢了」；
    // 代次不符的那种（`device_invalid`）出现在「行还在、代次变了」的路径上（见文末）。
    for (const token of [a, b]) {
        expectStatus(() => f.store.readConfig(token), (e) => e.status === 401 && e.code === 'device_revoked');
    }
    // 新令牌可用，且读到的还是写下的那一版内容（内容没丢）。
    const read = f.store.readConfig(reset.deviceToken);
    assert.equal(read.generation, 2);
    assert.equal(read.revision, written.revision);
    assert.equal(read.config.theme, 'dark');
    assert.deepEqual(read.modules.enabled, ['weibo-hot']);
    // 同 operationId 只撤一次：重放拿回同一份材料，不新增设备、不推进代次，也不吊销新令牌。
    const replay = f.store.resetDevices({ proof, operationId: 'reset-1' });
    assert.equal(replay.deviceToken, reset.deviceToken, '重放拿回同一份材料');
    assert.equal(replay.generation, 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_devices').get().n, devicesBefore + 1, '重放不再签发设备');
    assert.equal(f.db.prepare('SELECT generation FROM sync_spaces WHERE id = ?').get(created.spaceId).generation, 2, '代次没有再 +1');
    assert.equal(f.store.readConfig(reset.deviceToken).generation, 2, '刚签发的那枚没有被吊销');
    // 换一个新 ID = 又撤一次（客户端刷新页面重来的代价：多一枚 90 天内清理的孤儿令牌）。
    const second = f.store.resetDevices({ proof, operationId: 'reset-2' });
    assert.equal(second.generation, 3);
    expectStatus(() => f.store.readConfig(reset.deviceToken), (e) => e.code === 'device_revoked', '上一次签发的令牌随之失效');
    assert.equal(f.store.readConfig(second.deviceToken).generation, 3);
    // 旧回执不能把一份作废的材料要回来：代次一变就明确要求重新输入口令
    // （把代次往前推一格来构造「材料已过期」，与 tests/sync-store.test.js 既有的那条同法）。
    f.db.prepare('UPDATE sync_spaces SET generation = generation + 1 WHERE id = ?').run(created.spaceId);
    expectStatus(() => f.store.resetDevices({ proof, operationId: 'reset-2' }), (e) => e.status === 409 && e.code === 'receipt_stale');
    // 回执被清掉之后重放同一个 ID 会当作**新请求**再撤一次（拿回的材料仍是当前代次，
    // 绝不是那一份已经作废的令牌——「不能把作废令牌当成功返回」这条不变量就在这里）。
    const third = f.store.resetDevices({ proof, operationId: 'reset-1' });
    assert.equal(third.generation, 5);
    assert.notEqual(third.deviceToken, reset.deviceToken);
    assert.equal(f.store.readConfig(third.deviceToken).generation, 5);
});

test('清理顺序：已撤销设备行保留 24 小时；墓碑**必须在设备行清掉之后**才清', async (t) => {
    const f = await fixture(t);
    const invite = f.store.createInvite().invite;
    const created = await f.create('清理口令', invite.code);
    const a = created.deviceToken;
    const b = (await f.connect('清理口令', 'device-b')).deviceToken;

    // ② 已撤销的设备行：窗口内还读得到「这台设备被踢了」，窗口外连行带信息一起没。
    // 判据是 `revoked_at` 而不是 `last_seen_at`（撤销之后客户端不会再打这个令牌，
    // 用 last_seen_at 会把刚撤销的行当场删掉，客户端的话术跟着变）。
    f.store.revokeDevice(b);
    f.advance(23 * HOUR);
    f.store.sweep();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_devices WHERE token_hash = ?').get(createHash('sha256').update(`sylph-device-token-v1\u0000${b}`).digest('hex')).n, 1,
        '24 小时内那一行还要留着');
    expectStatus(() => f.store.readConfig(b), (e) => e.status === 401 && e.code === 'device_revoked', '窗口内能区分「被踢」与「无效」');
    f.advance(2 * HOUR);
    f.store.sweep();
    expectStatus(() => f.store.readConfig(b), (e) => e.status === 401 && e.code === 'device_invalid', '过了 24 小时两种都归「无效」——那一行已经没有信息量');

    // ④ 墓碑的清理：**顺序**是这条用例的重点。
    // 用户删除空间（墓碑 + 全部设备被吊销）。
    assert.equal(f.store.deleteSpace(a, { proof: await spaceProof('清理口令') }).success, true);
    const spaceId = created.spaceId;
    assert.equal(f.db.prepare('SELECT deleted FROM sync_spaces WHERE id = ?').get(spaceId).deleted, 1);

    // 越过墓碑的 90 天窗口：这时墓碑已经「够老」，但那个空间**还留着一行设备**
    // （构造方式：那台设备在删除之后又被读过一次）。现实里最接近的情形是「先吊销后删除」
    // 的次序被打乱，或将来新增一条吊销路径漏了 —— 这正是 `NOT IN (SELECT space_id ...)`
    // 子句要防的：墓碑先没、设备行还在 → 客户端从 410「空间已删除」变成 401「令牌无效」。
    f.advance(91 * DAY);
    f.db.prepare('UPDATE sync_devices SET revoked = 0, revoked_at = NULL, last_seen_at = ? WHERE space_id = ?').run(f.now(), spaceId);
    const alive = f.db.prepare('SELECT token_hash FROM sync_devices WHERE space_id = ?').get(spaceId);
    assert.ok(alive, '场景：墓碑老了，但它名下还有设备行');
    f.store.sweep();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_spaces WHERE id = ?').get(spaceId).n, 1, '还有设备行指向它，墓碑就必须留着');
    // 可观测的后果：那台设备拿到的仍然是「空间已被删除」（410）——墓碑在，这条判定才可达。
    // 墓碑先没的话，同一台设备会变成「令牌无效」（401），客户端就会要求重新输口令，
    // 而那个口令对应的空间其实已经被删掉了。
    expectStatus(() => f.store.readConfig(a), (e) => e.status === 410 && e.code === 'space_deleted');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_devices WHERE space_id = ?').get(spaceId).n, 1);

    // 设备行终于到期（90 天没鉴权）→ 下一次清理才轮到墓碑。
    f.advance(91 * DAY);
    f.store.sweep();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_devices WHERE space_id = ?').get(spaceId).n, 0, '设备行先被清掉');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_spaces WHERE id = ?').get(spaceId).n, 0, '设备行清掉之后，墓碑才被清掉');
    // 两行都没了 → 401「令牌无效」。此时两种回答一致（空间确实不存在、设备也不存在），
    // 没有歧义可言——这正是「设备行先清、墓碑后清」这个顺序要保证的终态。
    expectStatus(() => f.store.readConfig(a), (e) => e.status === 401 && e.code === 'device_invalid');
});

test('迁移 v11 回填：物化字节数与 Buffer.byteLength 一致（含非 ASCII），并从 v10 台阶真实推进', async (t) => {
    const Database = require('better-sqlite3');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-v11-'));
    const file = path.join(dir, 'nav-sylph.db');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    // 建一个**真的 v10 老库**：只跑前 10 个台阶，再手写一行内容和一台已撤销设备。
    const legacy = new Database(file);
    for (let version = 0; version < 10; version++) MIGRATIONS[version](legacy);
    legacy.pragma('user_version = 10');
    const configJson = JSON.stringify({
        theme: 'dark', showBookmarkIcons: true, searchEngine: 'g',
        searchEngines: [{ id: 'g', name: '谷歌', url: 'https://example.com/?q=' }],
        categories: [{ id: 'c1', name: '工作', bookmarks: [{ id: 'b1', title: '中文书签😀', url: 'https://example.com/' }] }]
    });
    const modulesJson = JSON.stringify({ enabled: [], widgets: [], settings: { 'weibo-hot': { limit: 10 } } });
    legacy.prepare(`INSERT INTO sync_spaces (id, proof_id, generation, revision, config_json, modules_json, created_at, updated_at, disabled, deleted, deleted_proof_id)
                    VALUES (?, ?, 1, 3, ?, ?, 1000, 1000, 0, 0, NULL)`).run('space-1', 'a'.repeat(64), configJson, modulesJson);
    legacy.prepare(`INSERT INTO sync_devices (token_hash, space_id, generation, created_at, last_seen_at, revoked)
                    VALUES (?, 'space-1', 1, 1000, 777, 1)`).run('b'.repeat(64));
    legacy.close();

    // 真迁移：openDatabase 会跑 MIGRATIONS[10]（v10 → v11）。
    const db = openDatabase(file);
    t.after(() => db.close());
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length, '台阶推进到最新');

    const row = db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get('space-1');
    assert.equal(row.content_bytes, Buffer.byteLength(configJson, 'utf8') + Buffer.byteLength(modulesJson, 'utf8'),
        '回填口径 = 两段 JSON 的 UTF-8 字节数之和');
    // ⚠️ 非 ASCII 才是这条断言的意义所在：`LENGTH(TEXT)` 是**字符数**，回填不 CAST 就少算。
    const charCount = db.prepare('SELECT LENGTH(config_json) + LENGTH(modules_json) AS n FROM sync_spaces WHERE id = ?').get('space-1').n;
    const codePoints = [...(configJson + modulesJson)].length;   // emoji 在码点上算 1 个，在 UTF-16 里算 2 个
    assert.equal(charCount, codePoints, 'SQLite 的 LENGTH(TEXT) 返回字符（码点）数');
    assert.equal(row.content_bytes > charCount, true,
        `中文 + emoji 必须让字节数（${row.content_bytes}）严格大于字符数（${charCount}）——否则 CAST 写不写都一样`);
    assert.equal(row.content_bytes - charCount, Buffer.byteLength(configJson + modulesJson, 'utf8') - codePoints,
        '差值必须是「多字节字符多出来的那些字节」');
    // 反过来说：不 CAST 的写法算出来就是 charCount，与物化值不等（两者必须能区分开）。
    assert.notEqual(row.content_bytes, charCount);
    // 老库里已撤销的设备行补齐 `revoked_at`：清理按它算 24 小时窗口。
    const device = db.prepare('SELECT * FROM sync_devices WHERE token_hash = ?').get('b'.repeat(64));
    assert.equal(device.revoked_at, device.last_seen_at, '回填用 last_seen_at（老库只有这一个时间戳可用）');
    // sync_settings 是单行表，两个开关默认关。
    assert.deepEqual(db.prepare('SELECT id, creating_paused, sync_paused FROM sync_settings').all(), [{ id: 1, creating_paused: 0, sync_paused: 0 }]);
    // 迁移完的库能被 store 直接用（回填值就是运行时要用的那个值）。
    const store = sync.createSyncStore(db, { now: () => 1000, getPasswordHash: () => 'h', publicModuleIds: () => [] });
    // `updated_at = 0` 是 v11 的插入值，`readSettings` 把它归一化成 null（「从来没改过」）。
    assert.deepEqual(store.readSettings(), { creatingPaused: false, syncPaused: false, updatedAt: null });
    assert.equal(store.listSpaces().spaces[0].contentBytes, row.content_bytes);
    // 运行时的写入路径与回填口径必须一致：改写一次，物化值仍等于 Buffer.byteLength 之和。
    const device2 = db.prepare(`INSERT INTO sync_devices (token_hash, space_id, generation, created_at, last_seen_at, revoked)
                                VALUES (?, 'space-1', 1, 1000, 1000, 0)`).run('c'.repeat(64));
    assert.equal(device2.changes, 1);
    const token = 'f'.repeat(64);
    db.prepare('UPDATE sync_devices SET token_hash = ? WHERE token_hash = ?').run(createHash('sha256').update(`sylph-device-token-v1\u0000${token}`).digest('hex'), 'c'.repeat(64));
    const written = store.writeConfig(token, { revision: 3, operationId: 'm-1', config: JSON.parse(configJson), modules: JSON.parse(modulesJson) });
    assert.equal(written.success, true);
    const after = db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get('space-1');
    assert.equal(after.content_bytes, Buffer.byteLength(after.config_json, 'utf8') + Buffer.byteLength(after.modules_json, 'utf8'));
});

// ==================== 同步管理 tab 的服务端：分页/筛选/排序 + 批量邀请码 ====================

/**
 * 直接写行造数。列表的**分页边界**要有 100+ 行才有意义，而每造一行都要一张邀请码
 * （`createSpace` 一次性消耗一张），靠真路径造 105 行等于把这条用例变成一次压测。
 * 所以这里只借 `sync_spaces` 的列形状插行——列名与 `lib/db.js` 的 v11 一致，
 * 迁移改了列这里会立刻红（这正是想要的：造数代码是**照真表**写的）。
 */
const spaceIdOf = (i) => createHash('sha256').update(`space-${i}`).digest('hex').slice(0, 24);

function seedSpaces(db, count, at = 1000) {
    const insert = db.prepare(`INSERT INTO sync_spaces (id, proof_id, generation, revision, config_json, modules_json,
            content_bytes, created_at, updated_at, disabled, disabled_at, deleted, deleted_at)
        VALUES (?, ?, 1, 1, '{}', '{}', ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < count; i++) {
        insert.run(
            spaceIdOf(i), `proof-${i}`,
            (i + 1) * 10,                 // 体积随 i 单调递增：体积排序的期望顺序因此是「倒着的 id」
            at + i,                       // 创建时间随 i 递增
            at + i * 2,                   // 更新时间也递增（默认排序按它降序）
            i === 1 ? 1 : 0, i === 1 ? at : null,
            i === 2 ? 1 : 0, i === 2 ? at : null
        );
    }
}

/** 造一台设备行（只为「按设备数排序」有东西可排）。 */
function seedDevice(db, spaceId, n) {
    db.prepare('INSERT INTO sync_devices (token_hash, space_id, generation, created_at, last_seen_at, revoked) VALUES (?, ?, 1, 1000, 1000, 0)')
        .run(`${spaceId}-${n}`.padEnd(64, '0'), spaceId);
}

test('store：空间列表的分页/筛选/排序走白名单映射，非法取值回落默认', async (t) => {
    const f = await fixture(t);
    seedSpaces(f.db, 105);
    seedDevice(f.db, spaceIdOf(0), 1);
    seedDevice(f.db, spaceIdOf(3), 2);
    seedDevice(f.db, spaceIdOf(3), 3);

    // 默认：最近更新、每页 20、总数是**筛选后**的总数（不含 LIMIT）。
    const first = f.store.listSpaces();
    assert.deepEqual(first.page, { total: 105, offset: 0, limit: 20 });
    assert.equal(first.spaces.length, 20);
    assert.equal(first.spaces[0].id, spaceIdOf(104), '默认按最近更新降序');
    assert.equal(first.spaces.at(-1).id, spaceIdOf(85));
    // 行里只有那 11 个非敏感字段，一个不多（多一个字段就是多一条泄露面）。
    assert.deepEqual(Object.keys(first.spaces[0]).sort(), [
        'activeDevices', 'contentBytes', 'createdAt', 'deleted', 'deletedAt',
        'disabled', 'disabledAt', 'generation', 'id', 'revision', 'updatedAt'
    ].sort());

    // 第二页接着上一页：两页之间没有重叠、也没有缺口。
    const second = f.store.listSpaces({ offset: 20 });
    assert.deepEqual(second.page, { total: 105, offset: 20, limit: 20 });
    assert.equal(second.spaces[0].id, spaceIdOf(84));
    assert.equal(new Set([...first.spaces, ...second.spaces].map((s) => s.id)).size, 40);

    // 状态筛选：三个取值各自是一个**互斥**的子集（i=1 停用、i=2 删除）。
    assert.equal(f.store.listSpaces({ state: 'active' }).page.total, 103);
    assert.equal(f.store.listSpaces({ state: 'active' }).spaces.every((s) => !s.disabled && !s.deleted), true);
    const disabled = f.store.listSpaces({ state: 'disabled' });
    assert.deepEqual(disabled.spaces.map((s) => s.id), [spaceIdOf(1)]);
    assert.equal(disabled.spaces[0].disabled, true);
    assert.ok(disabled.spaces[0].disabledAt, '停用时间要带出来');
    const deleted = f.store.listSpaces({ state: 'deleted' });
    assert.deepEqual(deleted.spaces.map((s) => s.id), [spaceIdOf(2)]);
    assert.equal(deleted.spaces[0].deleted, true);
    // 非法状态回落 all（**不是**空页，也不是 400）：白名单查不到就用默认那一档。
    assert.equal(f.store.listSpaces({ state: 'nonsense' }).page.total, 105);
    assert.equal(f.store.listSpaces({ state: 'DROP TABLE sync_spaces' }).page.total, 105, '注入串只是查表失败');

    // 排序：三种取值给三种顺序，非法值回落到「最近更新」。
    const byBytes = f.store.listSpaces({ sort: 'bytes' });
    assert.equal(byBytes.spaces[0].id, spaceIdOf(104), '体积最大的排第一');
    assert.equal(byBytes.spaces[1].contentBytes <= byBytes.spaces[0].contentBytes, true);
    const byDevices = f.store.listSpaces({ sort: 'devices' });
    assert.equal(byDevices.spaces[0].id, spaceIdOf(3), '3 台设备的排第一');
    assert.equal(byDevices.spaces[0].activeDevices, 2);
    assert.deepEqual(f.store.listSpaces({ sort: 'nonsense' }).spaces.map((s) => s.id),
        first.spaces.map((s) => s.id), '非法排序 = 默认排序');

    // 前缀搜索：只认**开头**（`instr(...) = 1`），不是「包含」，更不查正文。
    const whole = f.store.listSpaces({ q: spaceIdOf(42) });
    assert.deepEqual(whole.spaces.map((s) => s.id), [spaceIdOf(42)]);
    assert.equal(whole.page.total, 1);
    const prefix = f.store.listSpaces({ q: spaceIdOf(42).slice(0, 10) });
    assert.equal(prefix.page.total, 1, '前 10 位也定位到同一个空间');
    assert.equal(f.store.listSpaces({ q: spaceIdOf(42).slice(-8) }).page.total, 0, '尾部片段不算前缀');
    assert.equal(f.store.listSpaces({ q: 'zzz' }).page.total, 0);
    assert.equal(f.store.listSpaces({ q: '  ' }).page.total, 105, '空白搜索词等于不筛');

    // 分页边界：limit 上限 100、非法值回落、offset 越界返回空页但 total 不变。
    const capped = f.store.listSpaces({ limit: 500 });
    assert.equal(capped.page.limit, 100, '单页上限 100');
    assert.equal(capped.spaces.length, 100);
    assert.equal(f.store.listSpaces({ limit: 0 }).page.limit, 20);
    assert.equal(f.store.listSpaces({ limit: -3 }).page.limit, 20);
    assert.equal(f.store.listSpaces({ limit: 'abc' }).page.limit, 20);
    assert.equal(f.store.listSpaces({ limit: 5 }).spaces.length, 5);
    const beyond = f.store.listSpaces({ offset: 500 });
    assert.deepEqual(beyond.spaces, [], '越界是空页而不是报错');
    assert.equal(beyond.page.total, 105, 'total 与偏移无关');
    assert.equal(beyond.page.offset, 500);
    assert.equal(f.store.listSpaces({ offset: -10 }).page.offset, 0, '负偏移回落 0');

    // 用量是**全实例**：与当前页无关，墓碑不算进去，设备只数未撤销的。
    const page = f.store.listSpaces({ limit: 2 });
    assert.equal(page.spaces.length, 2);
    assert.equal(page.usage.spaces, 104, '105 行里有一个墓碑');
    assert.equal(page.usage.bytes, 105 * 106 / 2 * 10 - 30, '墓碑那一行（i=2）的 30 字节不算');
    assert.equal(page.usage.devices, 3);
    assert.ok(page.usage.bytes > page.spaces.reduce((n, s) => n + s.contentBytes, 0),
        '全实例用量必须大于本页合计——两者相等就说明它被算成了当页合计');
});

test('store：邀请码列表的状态筛选、分页与计数（四个桶互不重叠）', async (t) => {
    const f = await fixture(t);
    const old = f.store.createInvites(3).invites;            // 会过期
    f.advance(48 * HOUR + 1);
    const fresh = f.store.createInvites(3).invites;          // 未过期
    // 用掉一张（真路径）、撤销一张（真路径），剩下 1 张未使用。
    await f.create('邀请码状态口令', fresh[0].code);
    const revokedTarget = f.store.listInvites({ state: 'unused' }).invites.find((i) => i.hint === fresh[2].hint);
    assert.equal(f.store.revokeInvites([revokedTarget.id]).revoked, 1);

    const all = f.store.listInvites();
    assert.equal(all.page.total, 6);
    assert.deepEqual(all.counts, { unused: 1, used: 1, expired: 3, revoked: 1 });
    assert.equal(Object.values(all.counts).reduce((a, b) => a + b, 0), all.page.total, '四个桶加起来等于总数');

    // 每种状态各自筛出对应条数，并且行上的 `state` 与桶一致。
    for (const [state, expected] of Object.entries(all.counts)) {
        const listed = f.store.listInvites({ state });
        assert.equal(listed.page.total, expected, `${state} 的条数`);
        assert.equal(listed.invites.length, expected);
        assert.equal(listed.invites.every((i) => i.state === state), true, `${state} 的行要自报同一个状态`);
    }
    // 非法状态回落 all，而不是空页。
    assert.equal(f.store.listInvites({ state: 'nope' }).page.total, 6);
    assert.equal(f.store.listInvites({ state: "'; DELETE FROM sync_invites; --" }).page.total, 6);

    // 分页：与空间列表同一套边界（上限 100、非法回落、越界空页）。
    const paged = f.store.listInvites({ limit: 2, offset: 2 });
    assert.deepEqual(paged.page, { total: 6, offset: 2, limit: 2 });
    assert.equal(paged.invites.length, 2);
    assert.deepEqual(f.store.listInvites({ offset: 99 }).invites, []);
    assert.equal(f.store.listInvites({ offset: 99 }).page.total, 6);
    assert.equal(f.store.listInvites({ limit: 500 }).page.limit, 100);

    // 列表里**没有完整码**：只有 4 位 hint。明文在库里也不存在（只有哈希）。
    const raw = JSON.stringify(f.store.listInvites());
    for (const invite of [...old, ...fresh]) {
        assert.equal(raw.includes(invite.code.replace(/-/g, '')), false, '列表不得回传完整码');
        assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_invites WHERE code_hash = ?').get(invite.code.replace(/-/g, '')).n, 0,
            '库里存的是哈希，不是码本身');
    }
    assert.equal(f.store.listInvites().invites.every((i) => /^[0-9a-f]{4}$/.test(i.hint)), true);
});

test('store：批量生成限 1–20 张、整批一个事务、响应之后库里没有明文', async (t) => {
    const f = await fixture(t);
    assert.equal(sync.INVITE_BATCH_MAX, 20, '上限是用户拍定的 20 张');

    const batch = f.store.createInvites(20);
    assert.equal(batch.invites.length, 20);
    assert.equal(new Set(batch.invites.map((i) => i.code)).size, 20, '20 张码互不相同');
    for (const invite of batch.invites) {
        assert.deepEqual(Object.keys(invite).sort(), ['code', 'createdAt', 'expiresAt', 'hint']);
        assert.match(invite.code, /^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/, '展示形态与单张一致');
        assert.equal(invite.hint, invite.code.slice(0, 4));
        assert.equal(invite.expiresAt - invite.createdAt, 48 * HOUR, 'TTL 复用 createInvite 的 48 小时');
    }
    // 库里 20 行、只有哈希与 hint：**响应之后明文就找不回来了**。
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_invites').get().n, 20);
    for (const invite of batch.invites) {
        const hex = invite.code.replace(/-/g, '');
        assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_invites WHERE code_hash = ?').get(hex).n, 0, '码本身不落库');
        assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_invites WHERE hint = ?').get(invite.hint).n >= 1, true);
    }
    // 每张都能真的开一个空间（不是「生成了但用不了」）。
    const space = await f.create('批量码口令', batch.invites[0].code);
    assert.equal(space.success, true);
    assert.equal(f.db.prepare('SELECT used_at IS NOT NULL AS used FROM sync_invites WHERE hint = ?').get(batch.invites[0].hint).used, 1);

    // 边界：0 / 21 / 非整数 / 字符串 / 缺省 一律拒绝（**在 store 判**，不靠界面）。
    for (const bad of [0, 21, 100, 2.5, -1, '5', null, undefined, {}]) {
        expectStatus(() => f.store.createInvites(bad), (e) => e.status === 400, `count=${JSON.stringify(bad)} 必须 400`);
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_invites').get().n, 20, '被拒的批次一张都不落库');

    // **单事务**：让第 3 条插入失败（触发器），整批必须回滚——不能留下半批。
    f.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON sync_invites
               WHEN (SELECT COUNT(*) FROM sync_invites) >= 22
               BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    expectStatus(() => f.store.createInvites(10), (e) => /boom/.test(e.message) && !e.status, '中途失败要原样抛出');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_invites').get().n, 20,
        '前 2 条插入被一起回滚——半批邀请码是最难解释的一类 bug');
    f.db.exec('DROP TRIGGER boom');
    assert.equal(f.store.createInvites(1).invites.length, 1, '库恢复后照旧可用');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_invites').get().n, 21);
});

test('store：批量撤销只撤「未使用且未过期」的，返回的计数是实际改动行数', async (t) => {
    const f = await fixture(t);
    const expired = f.store.createInvites(2).invites;        // 稍后过期
    f.advance(48 * HOUR + 1);
    const fresh = f.store.createInvites(3).invites;          // 未过期
    await f.create('批量撤销口令', fresh[0].code);            // 用掉一张
    const ids = () => f.store.listInvites({ limit: 100 }).invites;
    const idOf = (hint) => ids().find((i) => i.hint === hint).id;

    const result = f.store.revokeInvites([idOf(expired[0].hint), idOf(fresh[0].hint), idOf(fresh[1].hint)]);
    assert.equal(result.revoked, 1, '只有那张「未使用且未过期」的被撤——已过期与已使用都不算');
    const stateOf = (hint) => ids().find((i) => i.hint === hint).state;
    assert.equal(stateOf(expired[0].hint), 'expired', '已过期的仍是已过期（撤销那一列不该被动）');
    assert.equal(stateOf(fresh[0].hint), 'used', '已使用的不受影响');
    assert.equal(stateOf(fresh[1].hint), 'revoked');
    // 幂等：同一批再撤一次，改动 0 行（界面按钮点两下不会把数说大）。
    assert.equal(f.store.revokeInvites([idOf(fresh[1].hint)]).revoked, 0);
    // 重复 id 只算一次。
    assert.equal(f.store.revokeInvites([idOf(fresh[2].hint), idOf(fresh[2].hint)]).revoked, 1);

    // 边界：空数组 / 非数组 / 超过 100 个 / 坏 id 一律 400。
    for (const bad of [[], 'abc', null, undefined, Array.from({ length: 101 }, (_, i) => `id-${i}`), [''], [12]]) {
        expectStatus(() => f.store.revokeInvites(bad), (e) => e.status === 400, `ids=${String(JSON.stringify(bad)).slice(0, 40)} 必须 400`);
    }
    // 100 个 id 是允许的（上限本身不被拒）。
    assert.equal(f.store.revokeInvites(Array.from({ length: 100 }, (_, i) => `missing-${i}`)).revoked, 0,
        '不存在的 id 不算改动，也不报错');
});

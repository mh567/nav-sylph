'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { createHash } = require('node:crypto');
const { openDatabase } = require('../lib/db');
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
        publicModuleIds: () => options.modules || ['weibo-hot']
    });
    t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return {
        store, db, file,
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

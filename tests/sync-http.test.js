'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { createHash } = require('node:crypto');
const { installation } = require('./helpers/installation');

// 浏览器侧的派生（Web Crypto + 用途/版本标签），与 public/app.js 同一口径。
async function spaceProof(passphrase, label = 'sylph-space-connect-v1') {
    const bytes = new TextEncoder().encode(`${label}\u0000${passphrase}`);
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

async function ready(t) {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const admin = async () => (await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} })).headers.get('set-cookie').split(';')[0];
    const bearer = (token) => ({ Authorization: `Bearer ${token}` });
    return {
        app, admin,
        check: (proof) => app.request('/api/sync/space/check', { body: { proof } }),
        create: (proof, inviteCode, operationId = 'create-1') => app.request('/api/sync/space/create', { body: { proof, inviteCode, operationId, config: CONFIG, modules: {} } }),
        connect: (proof, operationId = `connect-${Math.random().toString(36).slice(2)}`) => app.request('/api/sync/space/connect', { body: { proof, operationId } }),
        read: (token) => app.request('/api/sync/config', { headers: bearer(token) }),
        write: (token, body) => app.request('/api/sync/config', { method: 'POST', headers: bearer(token), body }),
        remove: (token, proof) => app.request('/api/sync/space/delete', { method: 'POST', headers: bearer(token), body: { proof } }),
        revoke: (token) => app.request('/api/sync/device/revoke', { method: 'POST', headers: bearer(token), body: {} }),
        newInvite: async (cookie) => (await (await app.request('/api/admin/sync-invites', { cookie, body: {} })).json()).invite,
        // 服务端进程跑在自己的库文件上；只读打开一份看落库结果（WAL 下只读连接没问题）
        db: () => new (require('better-sqlite3'))(path.join(app.dir, 'nav-sylph.db'), { readonly: true })
    };
}

/** 空间的口令哈希：与 lib/sync-store.js 的 proofId 同一口径（用途标签 + 分隔符）。 */
function proofIdOf(proof) {
    return createHash('sha256').update(`sylph-space-store-v1\u0000${proof}`).digest('hex');
}

const ADMIN_ONLY = [
    ['/api/admin/sync-invites', 'GET'],
    ['/api/admin/sync-invites', 'POST'],
    ['/api/admin/sync-invites/whatever/revoke', 'POST']
];

test('HTTP: 邀请码接口只认管理员会话——匿名与设备令牌都是 401', async (t) => {
    const f = await ready(t);
    for (const [route, method] of ADMIN_ONLY) {
        const anonymous = await f.app.request(route, { method, body: method === 'POST' ? {} : undefined });
        assert.equal(anonymous.status, 401, `匿名访问 ${route} 必须 401`);
    }
    const cookie = await f.admin();
    const invite = await f.newInvite(cookie);
    const created = await (await f.create(await spaceProof('设备令牌越权口令'), invite.code)).json();
    assert.ok(created.deviceToken, '先拿到一枚合法设备令牌');

    // 关键：普通凭据（设备令牌）**不能**用于管理员接口。
    // 这不是「碰巧没写」——本段路由根本不读 Authorization 头。
    for (const [route, method] of ADMIN_ONLY) {
        const res = await f.app.request(route, { method, body: method === 'POST' ? {} : undefined, headers: { Authorization: `Bearer ${created.deviceToken}` } });
        assert.equal(res.status, 401, `设备令牌访问 ${route} 必须 401`);
    }
    const listing = await (await f.app.request('/api/admin/sync-invites', { cookie })).json();
    assert.equal(listing.invites.length, 1);
    assert.equal(listing.invites[0].used, true);
    assert.equal(JSON.stringify(listing).includes(invite.code.replace(/-/g, '')), false, '列表不回传邀请码明文');
});

test('HTTP: 检查→创建→两台设备连接→读写版本冲突→刷新复用同一设备', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const passphrase = '跨设备口令 42';
    const proof = await spaceProof(passphrase);

    const before = await (await f.check(proof)).json();
    assert.deepEqual(before, { exists: false }, '不存在时不隐式创建');

    const invite = await f.newInvite(cookie);
    const created = await (await f.create(proof, invite.code)).json();
    assert.equal(created.success, true);
    assert.equal(created.revision, 1);
    assert.match(created.deviceToken, /^[0-9a-f]{64}$/);

    const found = await (await f.check(proof)).json();
    assert.equal(found.exists, true);
    assert.equal(found.entryCount, 1, '检查接口给出条目数，供「云端还是本地」的选择');
    assert.ok(Number.isSafeInteger(found.updatedAt));

    // 第二台设备：不需要邀请码。
    const second = await (await f.connect(proof)).json();
    assert.equal(second.spaceId, created.spaceId, '同一个空间');
    assert.notEqual(second.deviceToken, created.deviceToken);
    assert.equal(second.generation, 1);

    // 第一台设备写入，第二台读到。
    const next = { ...CONFIG, theme: 'dark' };
    const saved = await (await f.write(created.deviceToken, { revision: 1, operationId: 'first-write', config: next, modules: { enabled: ['weibo-hot'] } })).json();
    assert.equal(saved.success, true);
    assert.equal(saved.revision, 2);
    assert.equal(saved.generation, created.generation, '响应带上代次');
    assert.ok(Number.isSafeInteger(saved.updatedAt), '响应带上写入时刻');
    const readBack = await (await f.read(second.deviceToken)).json();
    assert.equal(readBack.config.theme, 'dark');
    assert.equal(readBack.revision, 2);
    assert.deepEqual(readBack.modules.enabled, ['weibo-hot']);

    // 第二台设备拿旧基线写 → 409，不覆盖。
    const stale = await f.write(second.deviceToken, { revision: 1, operationId: 'stale-write', config: CONFIG, modules: {} });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'revision_conflict');

    // 刷新复用：同一枚令牌仍然有效，且不会因为刷新而多出设备。
    const again = await (await f.read(created.deviceToken)).json();
    assert.equal(again.revision, 2);
    const listing = await (await f.app.request('/api/admin/sync-invites', { cookie })).json();
    assert.equal(listing.invites.filter((i) => i.used).length, 1, '连接既有空间不消耗邀请码');
});

test('HTTP: 真并发创建——同一个口令只有一路成功，只烧掉一张邀请码', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('并发口令');
    const invites = await Promise.all(Array.from({ length: 5 }, () => f.newInvite(cookie)));
    const responses = await Promise.all(invites.map((invite, index) => f.create(proof, invite.code, `race-${index}`)));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409, 409], '恰好一路 200，其余 409');
    const listing = await (await f.app.request('/api/admin/sync-invites', { cookie })).json();
    assert.equal(listing.invites.filter((i) => i.used).length, 1, '失败的创建不能烧掉邀请码');

    // 邀请码竞争的另一种情形：同一张邀请码被两个人同时用。
    const shared = await f.newInvite(cookie);
    const both = await Promise.all([
        f.create(await spaceProof('甲的口令'), shared.code, 'shared-a'),
        f.create(await spaceProof('乙的口令'), shared.code, 'shared-b')
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 403], '一张邀请码只能开一个空间');
});

test('HTTP: 设备数量没有固定上限（连 20 台各拿一枚可用令牌）', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('多设备口令');
    const invite = await f.newInvite(cookie);
    const created = await (await f.create(proof, invite.code)).json();

    // 每台设备一个 operationId；批量并发，但注意连接桶是 30/分钟/IP。
    const devices = await Promise.all(Array.from({ length: 19 }, (_, i) => f.connect(proof, `device-${i}`).then((r) => r.json())));
    const tokens = [created.deviceToken, ...devices.map((d) => d.deviceToken)];
    assert.equal(new Set(tokens).size, 20, '20 枚互不相同');
    for (const token of tokens) {
        assert.equal((await f.read(token)).status, 200, '每一台都能读');
    }
});

test('HTTP: 读写桶按**空间**计数，一个空间打满不影响另一个', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const one = await (await f.create(await spaceProof('额度口令甲'), (await f.newInvite(cookie)).code, 'quota-a')).json();
    const two = await (await f.create(await spaceProof('额度口令乙'), (await f.newInvite(cookie)).code, 'quota-b')).json();

    // 读桶 240/分钟。逐条发到打满：第 240 次仍 200，第 241 次 429。
    let last;
    for (let i = 0; i < 240; i++) {
        last = await f.read(one.deviceToken);
        assert.equal(last.status, 200, `第 ${i + 1} 次读取仍应放行`);
    }
    const limited = await f.read(one.deviceToken);
    assert.equal(limited.status, 429, '第 241 次读取必须被限流');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1, '写操作也要带 Retry-After');
    // 关键：桶按空间而不是按 IP。同一个 IP 下的另一个空间照常可用。
    assert.equal((await f.read(two.deviceToken)).status, 200, '另一个空间不该被同一个 IP 连坐');
});

test('HTTP: 写配置——同基线并发只有一个成功，重放不重复写入，内容不同拒绝', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('并发写口令');
    const created = await (await f.create(proof, (await f.newInvite(cookie)).code)).json();
    const a = created.deviceToken;
    const b = (await (await f.connect(proof, 'writer-b')).json()).deviceToken;

    // ① 两台设备拿**同一个基线**同时写：事务比较 revision，只能有一个赢。
    const [first, second] = await Promise.all([
        f.write(a, { revision: 1, operationId: 'race-a', config: { ...CONFIG, theme: 'dark' }, modules: {} }),
        f.write(b, { revision: 1, operationId: 'race-b', config: { ...CONFIG, theme: 'light' }, modules: {} })
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409], '同基线并发写必须只有一个成功');
    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    assert.equal((await loser.json()).code, 'revision_conflict');
    const saved = await winner.json();
    assert.equal(saved.success, true);
    assert.equal(saved.revision, 2);
    assert.equal(typeof saved.generation, 'number', '响应要带代次，客户端不必再问一次');
    assert.ok(Number.isSafeInteger(saved.updatedAt), '响应要带写入时刻');

    // ② 同 ID 同内容重放：返回**原**结果，且不再写一次。
    const replayBody = first.status === 200
        ? { revision: 1, operationId: 'race-a', config: { ...CONFIG, theme: 'dark' }, modules: {} }
        : { revision: 1, operationId: 'race-b', config: { ...CONFIG, theme: 'light' }, modules: {} };
    const replay = await f.write(a, replayBody);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), saved, '重放返回原提交结果');
    assert.equal((await (await f.read(a)).json()).revision, 2, '重放不重复写入');

    // ③ 同 ID 换内容：明确拒绝，不能悄悄按新内容办。
    const conflict = await f.write(a, { ...replayBody, config: { ...CONFIG, theme: 'auto' } });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'operation_conflict');
    assert.equal((await (await f.read(a)).json()).config.theme, replayBody.config.theme, '被拒的写不能改内容');

    // ④ 响应丢失后重试：模拟「服务端已提交、客户端没收到」——同 ID 同内容再发一次。
    const beforeRetry = await (await f.read(a)).json();
    const retried = await f.write(a, replayBody);
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).revision, saved.revision, '同 ID 重试拿到同一次提交的结果');
    assert.deepEqual(await (await f.read(a)).json(), beforeRetry, '重试没有第二次写入');
});

test('HTTP: 写配置带错的空间代次 → 409 generation_mismatch；不带则照旧兼容', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('代次写口令');
    const created = await (await f.create(proof, (await f.newInvite(cookie)).code)).json();
    const body = { revision: 1, operationId: 'gen-write', config: { ...CONFIG, theme: 'dark' }, modules: {} };

    const mismatch = await f.write(created.deviceToken, { ...body, generation: 99 });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).code, 'generation_mismatch');
    assert.equal((await (await f.read(created.deviceToken)).json()).revision, 1, '被拒的写不能落库');

    // 正确的代次照常成功。
    const ok = await f.write(created.deviceToken, { ...body, generation: created.generation });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).revision, 2);

    // **不带** generation 仍然可用：已经在跑的旧客户端（v2.0.2）不能因为这次
    // 加字段而写不进去——它们的设备令牌在鉴权时已经比过代次。
    const legacy = await f.write(created.deviceToken, { revision: 2, operationId: 'gen-legacy', config: { ...CONFIG, theme: 'light' }, modules: {} });
    assert.equal(legacy.status, 200, '不带代次的旧客户端仍能写');
    assert.equal((await legacy.json()).revision, 3);
});

test('HTTP: 删除云端空间——双要素鉴权、墓碑、吊销全部设备、清空间回执', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('删除口令');
    const created = await (await f.create(proof, (await f.newInvite(cookie)).code)).json();
    const a = created.deviceToken;
    const b = (await (await f.connect(proof, 'device-b')).json()).deviceToken;
    await f.write(a, { revision: 1, operationId: 'before-delete', config: { ...CONFIG, theme: 'dark' }, modules: {} });
    // 删除前先留一份「管理员侧数据」的快照：删除只该动 sync_* 四张表。
    const configBefore = await (await f.app.request('/api/config')).json();
    const favoritesBefore = await (await f.app.request('/api/favorites', { cookie })).json();

    // ① 口令不对 → 403 proof_mismatch，且空间原样（这正是「双要素」要挡掉的歧义）
    const wrong = await f.remove(a, await spaceProof('不是这个口令'));
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).code, 'proof_mismatch');
    assert.equal((await f.read(b)).status, 200, '口令错不能动到空间');
    let db = f.db();
    assert.equal(db.prepare('SELECT deleted FROM sync_spaces WHERE id = ?').get(created.spaceId).deleted, 0);
    db.close();

    // ② 正确口令 + 有效令牌 → 删除
    const done = await f.remove(a, proof);
    assert.equal(done.status, 200);
    const doneBody = await done.json();
    assert.equal(doneBody.success, true);
    assert.equal(doneBody.revoked, 2, '响应里的吊销台数要如实（两台设备都在这个空间下）');

    db = f.db();
    const space = db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(created.spaceId);
    assert.equal(space.deleted, 1, '留墓碑而不是真删行（否则设备行会成孤儿 / 级联后分不清状态）');
    assert.match(space.proof_id, /^gone:/, '口令槽要释放（墓碑的 proof_id 换成不含口令的唯一值）');
    assert.equal(space.deleted_proof_id, proofIdOf(proof), '墓碑自己记住原口令哈希，供重建时取新代次');
    assert.equal(space.config_json, '{}', '内容要清掉，读路径永不返回墓碑内容');
    const devices = db.prepare('SELECT COUNT(*) n FROM sync_devices WHERE space_id = ? AND revoked = 1').get(created.spaceId).n;
    assert.equal(devices, 2, '该空间全部设备都吊销');
    const receipts = db.prepare('SELECT scope FROM sync_receipts WHERE scope IN (?, ?)').all(`config:${created.spaceId}`, `connect:${created.spaceId}`).length;
    assert.equal(receipts, 0, '空间作用域的回执要清掉');
    db.close();

    // ③ 两台旧设备都拿到 410 space_deleted（能与「令牌无效」区分）
    for (const token of [a, b]) {
        const res = await f.read(token);
        assert.equal(res.status, 410, '删除后旧设备必须是 410');
        assert.equal((await res.json()).code, 'space_deleted');
    }
    // ④ 重试删除（响应丢了的情形）→ 410，仍然是确定答案
    const retry = await f.remove(a, proof);
    assert.equal(retry.status, 410);
    assert.equal((await retry.json()).code, 'space_deleted');
    // ⑤ 删除不影响管理员配置与会话：不只看接口还活着，还比内容**逐字节一致**
    assert.equal((await f.app.request('/api/session', { cookie })).status, 200);
    assert.equal((await f.app.request('/api/admin/sync-invites', { cookie })).status, 200);
    assert.deepEqual(await (await f.app.request('/api/config')).json(), configBefore, '站点默认配置逐字节不变');
    assert.deepEqual(await (await f.app.request('/api/favorites', { cookie })).json(), favoritesBefore, '管理员收藏逐字节不变');
});

test('HTTP: 同口令重建用新 id 与新代次，旧令牌够不到新空间', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('重建口令');
    const old = await (await f.create(proof, (await f.newInvite(cookie)).code)).json();
    assert.equal(old.generation, 1, '第一次建空间是第 1 代');
    await f.remove(old.deviceToken, proof);

    const again = await (await f.create(proof, (await f.newInvite(cookie)).code, 'rebuild')).json();
    assert.equal(again.success, true, '同一个口令可以重建（口令槽已释放）');
    assert.notEqual(again.spaceId, old.spaceId, '新空间必须换 id');
    assert.equal(again.generation, 2, '代次要在墓碑的基础上 +1');
    assert.notEqual(again.deviceToken, old.deviceToken, '新令牌');
    // 旧令牌指向旧 id，永远够不到新空间
    assert.equal((await f.read(old.deviceToken)).status, 410);
    // 新令牌正常
    assert.equal((await f.read(again.deviceToken)).status, 200);
    const db = f.db();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_spaces WHERE deleted = 0').get().n, 1, '活动空间只有一个');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_spaces WHERE deleted = 1').get().n, 1, '墓碑留一行');
    db.close();
});

test('HTTP: 同一个口令反复「建 → 删 → 再建 → 再删」都成立（墓碑唯一性来自空间 id）', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('两轮口令');
    const first = await (await f.create(proof, (await f.newInvite(cookie)).code, 'cycle-1')).json();
    assert.equal((await f.remove(first.deviceToken, proof)).status, 200);

    // 第二轮：重建（同一口令 → 新 id、代次 +1），再删一次。
    const second = await (await f.create(proof, (await f.newInvite(cookie)).code, 'cycle-2')).json();
    assert.notEqual(second.spaceId, first.spaceId);
    assert.equal(second.generation, 2);
    const secondDelete = await f.remove(second.deviceToken, proof);
    assert.equal(secondDelete.status, 200, '第二次删除同一个口令的空间不能报错——墓碑只能靠空间 id 唯一');

    const db = f.db();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_spaces WHERE deleted = 1').get().n, 2, '两个墓碑各留一行');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_spaces WHERE deleted = 0').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(DISTINCT proof_id) n FROM sync_spaces').get().n, 2, '两个墓碑的 proof_id 必须不同');
    db.close();

    // 第三轮：还能再建，代次继续往上走
    const third = await (await f.create(proof, (await f.newInvite(cookie)).code, 'cycle-3')).json();
    assert.equal(third.generation, 3, '代次按最高墓碑 +1');
    assert.equal((await f.read(third.deviceToken)).status, 200);
});

test('HTTP: 删除与上传竞争——删除先完成时旧上传失败，且不会让空间复活', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('竞争口令');
    const created = await (await f.create(proof, (await f.newInvite(cookie)).code)).json();
    const token = created.deviceToken;

    // 同时发：一次写（合法基线）与一次删除。删除与上传都是单事务，谁先到谁生效。
    // ⚠️ 这一半是**并发**形式：本机 sqlite 是同步单线程，两种先后都可能发生，
    // 所以这里只允许两种结果，真正的不变式在下面的终态断言里（终态与顺序无关）。
    const [write, removal] = await Promise.all([
        f.write(token, { revision: 1, operationId: 'race-write', config: { ...CONFIG, theme: 'dark' }, modules: {} }),
        f.remove(token, proof)
    ]);
    assert.equal(removal.status, 200, '删除必须成功');
    assert.ok([200, 410].includes(write.status), `并发下写只能是 200（先到）或 410（删除先到），实际 ${write.status}`);
    if (write.status !== 200) assert.equal((await write.json()).code, 'space_deleted');

    const db = f.db();
    const space = db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(created.spaceId);
    assert.equal(space.deleted, 1, '写没有让空间复活');
    assert.equal(space.config_json, '{}', '内容仍是空的（删除赢，或写的成果被删除清掉）');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_spaces').get().n, 1, '没有偷偷新建第二个空间');
    db.close();
    assert.equal((await f.read(token)).status, 410);

    // 另一半是**确定性**的：删除先完成（顺序构造，不靠调度）时旧令牌的写必须失败，
    // 而且不能把空间写活。并发那一半盖的是交错，这一半钉的是「删除先完成」的必然后果。
    const second = await (await f.create(await spaceProof('竞争口令二'), (await f.newInvite(cookie)).code, 'race-2')).json();
    assert.equal((await f.remove(second.deviceToken, await spaceProof('竞争口令二'))).status, 200);
    const late = await f.write(second.deviceToken, { revision: 1, operationId: 'late-write', config: CONFIG, modules: {} });
    assert.equal(late.status, 410, '删除先完成之后，旧上传必须失败');
    assert.equal((await late.json()).code, 'space_deleted');
    const db2 = f.db();
    assert.equal(db2.prepare('SELECT deleted FROM sync_spaces WHERE id = ?').get(second.spaceId).deleted, 1, '写没有让空间复活');
    assert.equal(db2.prepare('SELECT config_json FROM sync_spaces WHERE id = ?').get(second.spaceId).config_json, '{}');
    assert.equal(db2.prepare('SELECT COUNT(*) n FROM sync_spaces').get().n, 2, '两次创建各留一行墓碑，没有多出来的行');
    assert.equal(db2.prepare('SELECT COUNT(*) n FROM sync_spaces WHERE deleted = 1').get().n, 2);
    db2.close();
});

test('HTTP: 停止同步撤销本设备令牌——只影响本设备，幂等，坏令牌也返回成功', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('停止口令');
    const created = await (await f.create(proof, (await f.newInvite(cookie)).code)).json();
    const a = created.deviceToken;
    const b = (await (await f.connect(proof, 'device-b')).json()).deviceToken;

    const revoked = await f.revoke(a);
    assert.equal(revoked.status, 200);
    const res = await f.read(a);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'device_revoked', '撤销与「空间已删」「令牌无效」要分开');
    assert.equal((await f.read(b)).status, 200, '停止只影响本设备');
    assert.equal((await f.revoke(a)).status, 200, '重复撤销幂等');
    assert.equal((await f.revoke('f'.repeat(64))).status, 200, '坏令牌也返回成功（本地断开不等它）');
    const db = f.db();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_devices WHERE space_id = ?').get(created.spaceId).n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_devices WHERE space_id = ? AND revoked = 1').get(created.spaceId).n, 1, '只吊销了一台');
    db.close();
});

test('HTTP: 429 带 Retry-After，且口令猜测受每 IP 桶约束', async (t) => {
    const f = await ready(t);
    let limited;
    for (let i = 0; i < 31; i++) {
        limited = await f.check(await spaceProof(`尝试-${i}`));
        if (limited.status === 429) break;
    }
    assert.equal(limited.status, 429, '第 31 次连接类请求必须被限流');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1, '必须带 Retry-After');
    assert.match((await limited.json()).error, /频繁/);
});

test('HTTP: 换用途/版本标签的证明定位不到空间，缺令牌读写一律 401', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const invite = await f.newInvite(cookie);
    await f.create(await spaceProof('标签口令'), invite.code);

    const wrongPurpose = await spaceProof('标签口令', 'sylph-space-admin-v1');
    assert.equal((await (await f.check(wrongPurpose)).json()).exists, false);
    assert.equal((await f.connect(wrongPurpose)).status, 404);
    assert.equal((await (await f.connect(wrongPurpose)).json()).code, 'space_not_found');

    assert.equal((await f.app.request('/api/sync/config')).status, 401, '无令牌读 → 401');
    assert.equal((await f.write('a'.repeat(64), { revision: 1, operationId: 'x', config: CONFIG })).status, 401, '无主令牌写 → 401');
    assert.equal((await f.app.request('/api/sync/config', { headers: { Authorization: 'Basic abc' } })).status, 401);
});

test('HTTP: 上传的配置受严格 schema 约束，管理员字段与私人模块进不来', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('越权口令');
    const invite = await f.newInvite(cookie);
    const created = await (await f.create(proof, invite.code)).json();

    const rejected = await f.write(created.deviceToken, { revision: 1, operationId: 'leak', config: { ...CONFIG, privacyMode: true }, modules: { servers: [{ id: 'x', url: 'https://127.0.0.1' }] } });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /不允许的字段|模块偏好/);

    const favorites = await f.write(created.deviceToken, { revision: 1, operationId: 'leak2', config: { ...CONFIG, favorites: [{ id: 'a' }] }, modules: {} });
    assert.equal(favorites.status, 400);

    const privateModule = await f.write(created.deviceToken, { revision: 1, operationId: 'private', config: CONFIG, modules: { enabled: ['memo'] } });
    assert.equal(privateModule.status, 200);
    assert.deepEqual((await (await f.read(created.deviceToken)).json()).modules.enabled, [], '私人模块被过滤，不落库');

    assert.equal((await f.write(created.deviceToken, { operationId: 'no-base', config: CONFIG })).status, 409);
});

test('HTTP: 改密码后旧签发回执作废，重试不会抢写也不会重复签发', async (t) => {
    const f = await ready(t);
    const cookie = await f.admin();
    const proof = await spaceProof('改密口令');
    const invite = await f.newInvite(cookie);
    const first = await (await f.create(proof, invite.code, 'receipt-op')).json();

    const changed = await f.app.request('/api/change-password', { cookie, body: { currentPassword: 'StrongPass123!', newPassword: 'AnotherPass456!' } });
    assert.equal(changed.status, 200);

    // 同 operationId 重放：回执已清空 → 不能返回旧令牌，也不能抢写已存在的空间。
    const replay = await f.create(proof, invite.code, 'receipt-op');
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, 'space_exists');
    // 已连接的设备令牌不受改密影响（它存的是哈希，与密码无关）。
    assert.equal((await f.read(first.deviceToken)).status, 200);
});

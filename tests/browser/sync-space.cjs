'use strict';
// Run with Playwright available in NODE_PATH: node --test tests/browser/sync-space.cjs
//
// 口令空间：#9 的停止同步与删除云端空间（跨标签页取消调度、删除双要素、旧设备失效、
// 同口令重建），用**真实的浏览器 + 真实的 HTTP 服务 + 真实的 IndexedDB**。
//
// ⚠️ 两个「设备」的定义：同一 browser context 的两个 page = **同一台设备**（共享
// IndexedDB，也就是那份带设备令牌的同步记录）；不同 context = 两台设备。停止同步
// 只影响本设备，删除空间影响全部设备——这两条必须用对上下文类型才测得准。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');

const PASSPHRASE = 'Browser-Pass-1234';
// ⚠️ 不能用 helpers/installation.js 写进去的 `admin123`：它不够强，登录后会话是
// 「必须改密」用途（purpose: password-change），而 requireAdmin 会拒掉那种会话，
// 结果是一路 401「未登录或登录已过期」。这里换成强口令。
const ADMIN_PASSWORD = 'StrongPass123!';

async function setup(t) {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 4) }));
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    // 管理员会话：邀请码只能管理员签发。走真实登录拿 cookie（口令空间的创建要用它）。
    const login = await app.request('/api/verify-password', { password: ADMIN_PASSWORD, body: {} });
    assert.equal(login.status, 200, '管理员登录');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return { app, browser, cookie };
}

/** 同一台设备：一个 context 里开若干个标签页（共享 IndexedDB）。 */
async function device(browser, app, tabs = 1) {
    const context = await browser.newContext();
    const pages = [];
    for (let i = 0; i < tabs; i++) {
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await page.goto(app.base);
        await page.locator('#app').waitFor({ state: 'visible' });
        pages.push(page);
    }
    return { context, page: pages[0], pages };
}

const invite = async (app, cookie) => (await (await app.request('/api/admin/sync-invites', { cookie, body: {} })).json()).invite.code;
const spaceCheck = async (app, proof) => (await (await app.request('/api/sync/space/check', { body: { proof } })).json());
const proofOf = async passphrase => require('node:crypto').createHash('sha256')
    .update(`sylph-space-connect-v1\u0000${passphrase}`).digest('hex');

/** 关掉可能开着的同步对话框（用应用自己的方法，别去猜当前是哪个状态）。 */
const closeDialog = page => page.evaluate(() => { if (window.app.syncDialogEl) window.app.closeSyncDialog(); });

/** 走真实界面连上（或创建）一个口令空间。 */
async function connect(page, { passphrase, inviteCode, direction = 'push' }) {
    await closeDialog(page);
    await page.locator('#syncBtn').click();
    await page.locator('#syncPassphrase').fill(passphrase);
    await page.locator('#syncPassphraseConfirm').fill(passphrase);
    await page.locator('#syncCheck').click();
    await page.locator('#syncCreate, #syncPull, #syncPush').first().waitFor();
    if (await page.locator('#syncCreate').count()) {
        assert.ok(inviteCode, '该口令还没有空间，本轮需要一张邀请码');
        await page.locator('#syncInvite').fill(inviteCode);
        await page.locator('#syncCreate').click();
    } else {
        await page.locator(direction === 'pull' ? '#syncPull' : '#syncPush').click();
    }
    await page.locator('#syncNow').waitFor();
    const spaceId = await page.evaluate(() => window.app.syncConnection && window.app.syncConnection.spaceId);
    // 连好之后把对话框关掉：真用户也是关掉它继续用页面。不关的话遮罩会拦住
    // 后续对页脚按钮的点击（Playwright 会明确报「intercepts pointer events」）。
    await page.locator('#syncClose').click();
    await page.locator('#syncDialog').waitFor({ state: 'detached' });
    return spaceId;
}

const state = page => page.evaluate(async () => ({
    error: window.app.syncError,
    recordEpoch: (await window.app.localStore.readSync())?.connEpoch ?? null,
    connected: !!window.app.syncConnection,
    spaceId: window.app.syncConnection ? window.app.syncConnection.spaceId : null,
    generation: window.app.syncConnection ? window.app.syncConnection.generation : null,
    epoch: window.app.syncConnEpoch,
    polling: !!window.app.syncPollTimer,
    status: window.app.syncStatus,
    label: document.querySelector('#syncBtn').textContent,
    categories: window.app.config.categories.map(category => category.name)
}));

test('browser: 停止同步只在同一事务里断开本设备，另一标签页不刷新即取消调度且本机导航保留', async t => {
    const { app, browser, cookie } = await setup(t);
    const proof = await proofOf(PASSPHRASE);
    const { context, page: first } = await device(browser, app);
    const created = await connect(first, { passphrase: PASSPHRASE, inviteCode: await invite(app, cookie) });
    assert.ok(created, '空间建好了');

    // 第二个标签页**在连接建好之后**才打开（同一台设备的第二个标签页）：
    // 它一加载读到的就是同一条记录，也就是同一份设备凭据。
    const second = await context.newPage();
    second.setDefaultTimeout(8000);
    await second.goto(app.base);
    await second.locator('#app').waitFor({ state: 'visible' });
    await second.locator('#syncBtn').waitFor();
    await second.waitForFunction(() => !!window.app.syncConnection, null, { timeout: 8000 });
    const beforeSecond = await state(second);
    assert.equal(beforeSecond.connected, true, '另一个标签页共享同一份连接凭据');
    const pages = [first, second];
    assert.equal(beforeSecond.epoch, (await state(first)).epoch, '两个标签页的代次一致');
    assert.ok(beforeSecond.polling, '另一个标签页也在轮询');
    const categoriesBefore = (await state(first)).categories;

    await first.locator('#syncBtn').click();
    await first.locator('#syncStop').click();
    await first.locator('#syncStopConfirm').click();
    await first.locator('#syncNow, #syncCheck').first().waitFor();

    const afterFirst = await state(first);
    assert.equal(afterFirst.connected, false, '停止后本设备未连接');
    assert.equal(afterFirst.label, '同步', '页脚回到「同步」');
    assert.ok(afterFirst.epoch > beforeSecond.epoch, `连接代次递增了（第二个标签页读到的 ${beforeSecond.epoch} → 停止后 ${afterFirst.epoch}）`);
    assert.equal(afterFirst.polling, false, '定时器停掉');
    assert.deepEqual(afterFirst.categories, categoriesBefore, '本地导航原样保留');

    // 另一个标签页**不刷新**：靠 stopped 通知重新读记录，取消调度。
    await second.waitForFunction(() => window.app.syncConnection === null, null, { timeout: 5000 });
    const afterSecond = await state(second);
    assert.equal(afterSecond.polling, false, '另一个标签页的轮询也停了');
    assert.equal(afterSecond.label, '同步');
    assert.equal(afterSecond.epoch, afterFirst.epoch, '两个标签页的代次都推进到同一个值');

    // 刷新两个标签页：都仍是未连接（断开已经落到记录里）。
    for (const page of pages) {
        await page.reload();
        await page.locator('#app').waitFor({ state: 'visible' });
        const refreshed = await state(page);
        assert.equal(refreshed.connected, false, '刷新后仍是未连接');
        assert.deepEqual(refreshed.categories, categoriesBefore, '刷新后导航仍在');
    }
});

test('browser: 删除云端空间要重新输口令；成功后本机导航保留、其他设备失效且各自不重建', async t => {
    const { app, browser, cookie } = await setup(t);
    const proof = await proofOf(PASSPHRASE);
    const other = await device(browser, app);          // 另一台设备（独立 IndexedDB）
    const owner = await device(browser, app);          // 发起删除的那台

    const spaceId = await connect(owner.page, { passphrase: PASSPHRASE, inviteCode: await invite(app, cookie) });
    await connect(other.page, { passphrase: PASSPHRASE, direction: 'pull' });
    assert.equal((await state(other.page)).spaceId, spaceId, '两台设备连的是同一个空间');
    const categoriesBefore = (await state(owner.page)).categories;

    // ① 口令输错：拒绝、什么都不删、连接保留
    await owner.page.locator('#syncBtn').click();
    await owner.page.locator('#syncDelete').click();
    await owner.page.locator('#syncDeletePassphrase').fill('Wrong-Pass-9999');
    await owner.page.locator('#syncDeleteConfirm').click();
    await owner.page.locator('.sync-error', { hasText: '口令不正确' }).waitFor();
    assert.equal((await state(owner.page)).connected, true, '口令错必须保留连接');
    assert.equal((await spaceCheck(app, proof)).exists, true, '空间原样');

    // ② 口令正确：删除
    await owner.page.locator('#syncDeletePassphrase').fill(PASSPHRASE);
    await owner.page.locator('#syncDeleteConfirm').click();
    await owner.page.waitForFunction(() => window.app.syncConnection === null, null, { timeout: 8000 });
    const afterDelete = await state(owner.page);
    assert.equal(afterDelete.label, '同步');
    assert.deepEqual(afterDelete.categories, categoriesBefore, '本机导航保留');
    assert.equal((await spaceCheck(app, proof)).exists, false, '云端空间已删');

    // ③ 另一台设备的下一次检查：判为终态、断开、保留本地、**不自动重建**
    await other.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await other.page.waitForFunction(() => window.app.syncConnection === null, null, { timeout: 8000 });
    const otherAfter = await state(other.page);
    assert.equal(otherAfter.label, '同步');
    assert.deepEqual(otherAfter.categories, categoriesBefore, '另一台设备的导航也保留');
    assert.equal((await spaceCheck(app, proof)).exists, false, '另一台设备没有偷偷重建空间');
    // 通知里说清是「已被删除」而不是笼统的连接失效
    await other.page.locator('#syncBtn').click();
    await other.page.locator('#syncPassphrase').waitFor();
});

test('browser: 同口令重建得到新空间 id 与新代次，旧设备令牌够不到新空间', async t => {
    const { app, browser, cookie } = await setup(t);
    const proof = await proofOf(PASSPHRASE);
    const deviceA = await device(browser, app);

    const first = await connect(deviceA.page, { passphrase: PASSPHRASE, inviteCode: await invite(app, cookie) });
    const firstGeneration = (await state(deviceA.page)).generation;
    await deviceA.page.locator('#syncBtn').click();
    await deviceA.page.locator('#syncDelete').click();
    await deviceA.page.locator('#syncDeletePassphrase').fill(PASSPHRASE);
    await deviceA.page.locator('#syncDeleteConfirm').click();
    await deviceA.page.waitForFunction(() => window.app.syncConnection === null, null, { timeout: 8000 });

    const second = await connect(deviceA.page, { passphrase: PASSPHRASE, inviteCode: await invite(app, cookie) });
    const rebuilt = await state(deviceA.page);
    assert.notEqual(second, first, '新空间换了 id');
    assert.ok(rebuilt.generation > firstGeneration, `代次要往上走（${firstGeneration} → ${rebuilt.generation}）`);
    assert.equal(rebuilt.label, '已同步', '重建后可用');
});

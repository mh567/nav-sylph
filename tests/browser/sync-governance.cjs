'use strict';
// Run with Playwright available in NODE_PATH: node --test tests/browser/sync-governance.cjs
//
// 口令空间的管理员治理（#10）：暂停新建 / 总暂停、空间列表与禁用删除、配额拒绝。
// 真实浏览器 + 真实 HTTP + 真实 SQLite。限额边界的数值部分在 tests/sync-http.test.js
// （那里能用 env 把限额压到边界上），这里验的是**界面这一层**：提示文案、暂停态、
// 停用态、删除后的失效，以及「被拒时本机内容不丢、不重建空间」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');

const PASSPHRASE = 'Governance-Pass-1';
// ⚠️ helpers/installation.js 写的 admin123 不够强 → 会话是「必须改密」用途，
// requireAdmin 会拒掉，一路 401。换成强口令。
const ADMIN_PASSWORD = 'StrongPass123!';

async function setup(t) {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 4) }));
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    const login = await app.request('/api/verify-password', { password: ADMIN_PASSWORD, body: {} });
    assert.equal(login.status, 200, '管理员登录');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return { app, browser, cookie };
}

const settings = async (app, cookie) => (await (await app.request('/api/admin/sync-settings', { cookie })).json()).settings;
const spaces = async (app, cookie) => (await (await app.request('/api/admin/sync-spaces', { cookie })).json());
const invite = async (app, cookie) => (await (await app.request('/api/admin/sync-invites', { cookie, body: {} })).json()).invite.code;
const proofOf = passphrase => require('node:crypto').createHash('sha256')
    .update(`sylph-space-connect-v1\u0000${passphrase}`).digest('hex');
const spaceCheck = async (app, proof) => (await (await app.request('/api/sync/space/check', { body: { proof } })).json());

async function page(browser, app) {
    const context = await browser.newContext();
    const p = await context.newPage();
    p.setDefaultTimeout(8000);
    await p.goto(app.base);
    await p.locator('#app').waitFor({ state: 'visible' });
    await p.locator('#syncBtn').waitFor();
    return p;
}

const state = p => p.evaluate(() => ({
    connected: !!window.app.syncConnection,
    halted: window.app.syncHalted,
    status: window.app.syncStatus,
    syncState: window.app.syncState,
    label: document.querySelector('#syncBtn').textContent,
    categories: window.app.config.categories.map(c => c.name),
    polling: !!window.app.syncPollTimer,
    pollMs: window.app.syncPollMs || null
}));

const closeDialog = p => p.evaluate(() => { if (window.app.syncDialogEl) window.app.closeSyncDialog(); });

/** 用真界面连上（创建）一个口令空间，然后关掉对话框。 */
async function connect(p, inviteCode) {
    await closeDialog(p);
    await p.locator('#syncBtn').click();
    await p.locator('#syncPassphrase').fill(PASSPHRASE);
    await p.locator('#syncPassphraseConfirm').fill(PASSPHRASE);
    await p.locator('#syncCheck').click();
    await p.locator('#syncCreate, #syncPull, #syncPush').first().waitFor();
    if (await p.locator('#syncCreate').count()) {
        await p.locator('#syncInvite').fill(inviteCode);
        await p.locator('#syncCreate').click();
    } else {
        await p.locator('#syncPush').click();
    }
    await p.locator('#syncNow').waitFor();
    const spaceId = await p.evaluate(() => window.app.syncConnection.spaceId);
    await p.locator('#syncClose').click();
    await p.locator('#syncDialog').waitFor({ state: 'detached' });
    return spaceId;
}

/**
 * 打开管理面板（如未登录先走真实登录），切到第 5 个页签「同步管理」。
 *
 * ⚠️ 同步相关的界面**不再在「首页导航」里**：概览（含两个总开关）、邀请码、空间治理
 * 全在 `#adminPanelSync` 内。返回整个面板的 locator——旧版返回的是 `#syncSpacesSection`，
 * 而两个总开关现在在概览区（治理区之前），拿那一块会点不到开关。
 */
async function adminPanel(p) {
    await p.locator('#adminBtn').click();
    if (await p.locator('.ui-dialog input[type="password"]').count()) {
        await p.locator('.ui-dialog input[type="password"]').fill(ADMIN_PASSWORD);
        await p.locator('.ui-dialog button[type="submit"]').click();
    }
    await p.locator('#modal').waitFor({ state: 'visible' });
    await p.locator('#adminTabSync').click();
    await p.locator('#syncSpacesSection').waitFor({ state: 'visible' });
    // 等这一页真的拉完：概览四块的「—」占位被真实数字换掉（列表、策略、用量来自
    // 同一条 GET）。不等的话紧接着读勾选态会读到模板里的默认值（`checked` 是写死的）。
    await p.waitForFunction(() => {
        const overview = document.querySelector('#syncOverview');
        return overview && !overview.textContent.includes('—');
    }, null, { timeout: 15000 });
    return p.locator('#adminPanelSync');
}

test('browser: 后台两个总开关勾了即落盘、刷新后仍生效，空间列表不泄露正文与凭据', async t => {
    const { app, browser, cookie } = await setup(t);
    const proof = await proofOf(PASSPHRASE);
    const owner = await page(browser, app);
    const spaceId = await connect(owner, await invite(app, cookie));

    const admin = await page(browser, app);
    const panel = await adminPanel(admin);
    await panel.locator('.sync-space-row').first().waitFor();
    const listText = await panel.locator('#syncSpacesList').innerText();
    assert.match(listText, new RegExp(spaceId.slice(0, 8)), '列表里有这个空间的内部标识');
    // 不泄露：列表里既没有空间正文（测试夹具的书签名），也没有任何令牌样式的长串
    assert.doesNotMatch(listText, /V2EX|Reddit|Hacker News/, '列表里不能出现空间正文');
    assert.doesNotMatch(listText, /[A-Za-z0-9_-]{40,}/, '列表里不能出现令牌/哈希样式的长串');

    // 真用户点的是开关（label + 滑块），不是那个被样式隐藏的 input：
    // 直接 check() 隐藏的复选框会卡在「element is not stable」。
    await panel.locator('label.sync-policy-item').filter({ hasText: '暂停新建' }).click();
    await panel.locator('label.sync-policy-item').filter({ hasText: '总暂停' }).click();
    // 勾了即落盘：等接口反映出来（不是只信界面）
    for (let i = 0; i < 20; i++) {
        const s = await settings(app, cookie);
        if (s.creatingPaused && s.syncPaused) break;
        await admin.waitForTimeout(150);
    }
    const saved = await settings(app, cookie);
    assert.deepEqual({ creating: saved.creatingPaused, total: saved.syncPaused }, { creating: true, total: true }, '两个开关落盘');

    // 刷新后重开面板：勾选状态还在（来自库，不是内存）
    await admin.reload();
    await admin.locator('#app').waitFor({ state: 'visible' });
    const panelAgain = await adminPanel(admin);
    assert.equal(await panelAgain.locator('#syncCreatingPaused').isChecked(), true, '刷新后「暂停新建」仍勾选');
    assert.equal(await panelAgain.locator('#syncTotalPaused').isChecked(), true, '刷新后「总暂停」仍勾选');
    assert.equal((await spaceCheck(app, proof)).exists, true, '暂停不影响已有空间');
});

test('browser: 暂停新建时访客创建被拒，界面说清原因且不重发创建', async t => {
    const { app, browser, cookie } = await setup(t);
    await app.request('/api/admin/sync-settings', { cookie, body: { creatingPaused: true } });
    const visitor = await page(browser, app);
    let creates = 0;
    visitor.on('request', request => { if (request.url().includes('/api/sync/space/create')) creates++; });

    await visitor.locator('#syncBtn').click();
    await visitor.locator('#syncPassphrase').fill(PASSPHRASE);
    await visitor.locator('#syncPassphraseConfirm').fill(PASSPHRASE);
    await visitor.locator('#syncCheck').click();
    await visitor.locator('#syncInvite').waitFor();
    await visitor.locator('#syncInvite').fill(await invite(app, cookie));
    await visitor.locator('#syncCreate').click();
    await visitor.locator('#syncDialogBody .sync-error').waitFor();

    const after = await state(visitor);
    assert.equal(after.connected, false, '没有建出空间');
    assert.equal(after.syncState, 'not_found', '停在原状态，让用户能改主意');
    const text = await visitor.locator('#syncDialogBody').innerText();
    assert.match(text, /暂停/, '说清是管理员暂停了新建');
    assert.doesNotMatch(text, /创建失败/, '不能报成笼统的失败');
    assert.equal(creates, 1, '只发了一次创建请求——被拒后不许回查或重发');
    assert.equal((await spaceCheck(app, await proofOf(PASSPHRASE))).exists, false, '确实没有空间被建出来');
});

test('browser: 总暂停让已连接访客进入暂停态，解除后点「重试同步」恢复', async t => {
    const { app, browser, cookie } = await setup(t);
    const owner = await page(browser, app);
    await connect(owner, await invite(app, cookie));
    const before = await state(owner);
    assert.equal(before.connected, true);

    await app.request('/api/admin/sync-settings', { cookie, body: { syncPaused: true } });
    await closeDialog(owner);
    await owner.locator('#syncBtn').click();
    await owner.locator('#syncNow').click();
    await owner.locator('#syncRetry').waitFor();
    const paused = await state(owner);
    assert.equal(paused.halted, 'paused', 'halt 原因是「总暂停」，与「停用」区分');
    assert.equal(paused.connected, true, '总暂停不断开连接');
    // 总暂停不是「停掉轮询」，而是换成 5 分钟一次的慢轮询（与 503 的 Retry-After 同值）：
    // 恢复后要能自己发现。
    assert.equal(paused.pollMs, 300000, '总暂停时轮询间隔是 5 分钟');
    const pausedText = await owner.locator('#syncDialogBody').innerText();
    assert.match(pausedText, /暂停/, '文案说清是暂停');
    assert.match(pausedText, /重新输入口令没有用/, '要明说输口令没用');

    await app.request('/api/admin/sync-settings', { cookie, body: { syncPaused: false } });
    await owner.locator('#syncRetry').click();
    await owner.locator('#syncNow').waitFor();
    const resumed = await state(owner);
    assert.ok(!resumed.halted, '读成功即解除（没有暂停原因；值是 null 还是 false 不是契约）');
    assert.equal(resumed.polling, true, '调度接回来');
    assert.equal(resumed.connected, true);
});

test('browser: 管理员停用某个空间 → 访客进停用态；重新启用后手动重试恢复', async t => {
    const { app, browser, cookie } = await setup(t);
    const owner = await page(browser, app);
    const spaceId = await connect(owner, await invite(app, cookie));

    const admin = await page(browser, app);
    const panel = await adminPanel(admin);
    const row = panel.locator('.sync-space-row').filter({ hasText: spaceId.slice(0, 8) });
    await row.waitFor();
    await row.locator('[data-action="toggle-space"]').click();
    let disabledNow = false;
    for (let i = 0; i < 20; i++) {
        const list = await spaces(app, cookie);
        if (list.spaces.find(s => s.id === spaceId).disabled) { disabledNow = true; break; }
        await admin.waitForTimeout(150);
    }
    assert.equal(disabledNow, true, '管理员点「停用」要真的落到库里');

    await closeDialog(owner);
    await owner.locator('#syncBtn').click();
    await owner.locator('#syncNow').click();
    await owner.locator('#syncRetry').waitFor();
    await owner.waitForFunction(() => window.app.syncHalted === 'disabled', null, { timeout: 8000 });
    const halted = await state(owner);
    assert.equal(halted.halted, 'disabled', 'halt 原因是「停用」');
    assert.equal(halted.connected, true, '停用保留连接与本地数据');

    await panel.locator('.sync-space-row').filter({ hasText: spaceId.slice(0, 8) }).locator('[data-action="toggle-space"]').click();
    let enabledAgain = false;
    for (let i = 0; i < 20; i++) {
        const list = await spaces(app, cookie);
        if (!list.spaces.find(s => s.id === spaceId).disabled) { enabledAgain = true; break; }
        await admin.waitForTimeout(150);
    }
    assert.equal(enabledAgain, true, '「重新启用」也要真的落到库里');
    await owner.locator('#syncRetry').click();
    await owner.locator('#syncNow').waitFor();
    const resumed = await state(owner);
    assert.ok(!resumed.halted, '重新启用 + 重试后解除停用');
    assert.equal(resumed.connected, true);
});

test('browser: 管理员删除空间 → 访客下次检查判为「已被删除」、导航保留、不自动重建', async t => {
    const { app, browser, cookie } = await setup(t);
    const owner = await page(browser, app);
    const spaceId = await connect(owner, await invite(app, cookie));
    const categoriesBefore = (await state(owner)).categories;
    let creates = 0;
    owner.on('request', request => { if (request.url().includes('/api/sync/space/create')) creates++; });

    const admin = await page(browser, app);
    const panel = await adminPanel(admin);
    const row = panel.locator('.sync-space-row').filter({ hasText: spaceId.slice(0, 8) });
    await row.waitFor();
    await row.locator('[data-action="delete-space"]').click();
    await admin.locator('.ui-dialog button[type="submit"]').click();   // 仓库自己的危险确认框
    let deletedNow = false;
    for (let i = 0; i < 20; i++) {
        const list = await spaces(app, cookie);
        const found = list.spaces.find(s => s.id === spaceId);
        if (found && found.deleted) { deletedNow = true; break; }
        await admin.waitForTimeout(150);
    }
    assert.equal(deletedNow, true, '删除要真的落到库里（墓碑）');

    await closeDialog(owner);
    await owner.locator('#syncBtn').click();
    await owner.locator('#syncNow').click();
    await owner.waitForFunction(() => window.app.syncConnection === null, null, { timeout: 8000 });
    const after = await state(owner);
    assert.equal(after.label, '同步');
    assert.deepEqual(after.categories, categoriesBefore, '本机导航保留');
    assert.equal(creates, 0, '没有任何自动重建');
    assert.equal((await spaceCheck(app, await proofOf(PASSPHRASE))).exists, false);
    // 提示要点名「已被删除」，不是笼统的连接失效
    await owner.waitForFunction(() => {
        const toast = document.querySelector('#toast');
        return toast && !toast.hidden && /已被删除/.test(toast.textContent);
    }, null, { timeout: 5000 });
});

test('browser: 写满被拒时本机内容不丢、不排退避；精简后「立即同步」成功', async t => {
    const { app, browser, cookie } = await setup(t);
    const owner = await page(browser, app);
    await connect(owner, await invite(app, cookie));
    const categoriesBefore = (await state(owner)).categories;
    let posts = 0;
    owner.on('request', request => { if (request.url().includes('/api/sync/config') && request.method() === 'POST') posts++; });

    // 服务端的额度拒绝在 tests/sync-http.test.js 用真实限额验；这里只验界面这一层：
    // 让写请求返回 503 space_quota_exceeded，断言提示、内容保留、不退避重试。
    await owner.route('**/api/sync/config', route => {
        if (route.request().method() === 'POST') {
            return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '空间内容已达上限', code: 'space_quota_exceeded' }) });
        }
        return route.continue();
    });
    // 真界面制造一次本地改动（新增分类）
    await owner.locator('#layoutBtn').click();
    await owner.getByRole('button', { name: '＋ 添加分类', exact: true }).click();
    await owner.locator('.ui-dialog input').fill('超限测试');
    await owner.locator('.ui-dialog button[type="submit"]').click();
    await owner.waitForFunction(() => {
        const toast = document.querySelector('#toast');
        return toast && !toast.hidden && /上限/.test(toast.textContent);
    }, null, { timeout: 8000 });

    const rejected = await state(owner);
    assert.equal(rejected.connected, true, '额度拒绝不清连接');
    assert.equal(rejected.status, 'failed', '状态说出来是失败');
    assert.ok(rejected.categories.includes('超限测试'), '本机内容没丢');
    const pendingKept = await owner.evaluate(async () => {
        const record = await window.app.localStore.readSync();
        return !!record.pending;
    });
    assert.equal(pendingKept, true, '待上传内容保留');
    const afterFirst = posts;
    await owner.waitForTimeout(2500);
    assert.equal(posts, afterFirst, '额度类 503 不排退避重试（不会对同一个拒绝反复敲）');

    // 精简：删掉刚加的分类 → 下一次改动放行 → 立即同步成功
    await owner.unroute('**/api/sync/config');
    await owner.locator('.category-del').last().click();
    await owner.locator('.ui-dialog button[type="submit"]').click();
    await owner.locator('#syncBtn').click();
    await owner.locator('#syncNow').click();
    await owner.waitForFunction(() => window.app.syncStatus === 'synced', null, { timeout: 8000 });
    const recovered = await state(owner);
    assert.ok(!recovered.categories.includes('超限测试'), '精简后的内容已同步出去');
    assert.deepEqual(recovered.categories, categoriesBefore, '回到精简前的分类集合');
});

test('browser: 同步管理 tab —— 批量生成 20 张、状态筛选、搜索、批量停用、少量空间不显示分页', async t => {
    const { app, browser, cookie } = await setup(t);
    // 先造一个空间：治理列表里有东西可看、可勾、可停用。
    const owner = await page(browser, app);
    const spaceId = await connect(owner, await invite(app, cookie));

    const admin = await page(browser, app);
    const panel = await adminPanel(admin);

    // ① 概览四块：空间总数 / 全实例有效配置字节 / 活跃设备数 / 同步服务状态
    const overview = await panel.locator('#syncOverview').innerText();
    assert.match(overview, /空间总数/, '概览有空间总数');
    assert.match(overview, /全实例有效配置字节/, '概览有字节数');
    assert.match(overview, /活跃设备数/, '概览有活跃设备数');
    assert.match(overview, /同步服务状态/, '概览有服务状态');
    // 字节按 KiB/MiB 说，不是一串原始字节
    assert.match(overview, /\d+(\.\d+)? (B|KiB|MiB)/, '字节要格式化');

    // ② 批量生成 20 张：下拉选「自定义…」→ 数字框填 20 → 生成。
    //    ⚠️ 上限 20 是界面与服务端共同的数，这里就走边界值。
    await panel.locator('#syncInviteCount').selectOption('custom');
    await panel.locator('#syncInviteCustomCount').fill('20');
    await panel.locator('#createInviteBtn').click();
    await panel.locator('.sync-code').first().waitFor({ timeout: 15000 });
    assert.equal(await panel.locator('.sync-code').count(), 20, '结果区出现 20 个码');
    const firstCode = (await panel.locator('.sync-code code').first().innerText()).trim();
    assert.match(firstCode, /^[0-9a-f]{4}(-[0-9a-f]{4}){5}$/, `完整码可读且是 6 段十六进制：${firstCode}`);
    const batchText = await panel.locator('#syncInviteBatch').innerText();
    assert.match(batchText, /本次生成/, '结果区说清是本次生成');
    assert.match(batchText, /复制全部/, '有复制全部');
    assert.match(batchText, /下载 \.txt/, '有下载 .txt');
    assert.match(batchText, /到期/, '每张带到期时间');
    // 结果区**只显示这一次**：关掉面板再打开就没了（走仓库自己的 closeAdmin，
    // 与用户点「取消」/ 遮罩同一条路径）
    await admin.evaluate(() => window.app.closeAdmin(true));
    await admin.locator('#modal').waitFor({ state: 'hidden' });
    const reopened = await adminPanel(admin);
    assert.equal(await reopened.locator('.sync-code').count(), 0, '重开面板后结果区不再显示');

    // ③ 状态筛选：未使用 / 已使用 各自成页，计数行来自服务端
    await reopened.locator('#syncInviteState').selectOption('unused');
    // 等列表**换成**筛选后的那一份（只等「有一行」会等到上一份，断言读到旧数据）
    await admin.waitForFunction(() => /有效至/.test(document.querySelector('#syncInviteList').textContent || ''), null, { timeout: 10000 });
    const unusedRows = await reopened.locator('.sync-invite-row').count();
    assert.ok(unusedRows >= 20, `未使用筛选里至少有刚生成的 20 张（实际 ${unusedRows}）`);
    assert.match(await reopened.locator('#syncInviteCounts').innerText(), /未使用 \d+ 张/, '计数行有未使用数');
    assert.match(await reopened.locator('#syncInviteList').innerText(), /48|有效至/, '未使用的行显示有效期');
    await reopened.locator('#syncInviteState').selectOption('used');
    await admin.waitForFunction(() => /已使用/.test(document.querySelector('#syncInviteList').textContent || ''), null, { timeout: 10000 });
    assert.match(await reopened.locator('#syncInviteList').innerText(), /已使用/, '已使用筛选里是已用的码');
    await reopened.locator('#syncInviteState').selectOption('all');

    // ④ 搜索：命中的那一行只剩自己；搜不到时给「没有匹配」空态
    const prefix = spaceId.slice(0, 8);
    await reopened.locator('#syncSpaceSearch').fill(prefix);
    await admin.waitForFunction(id => document.querySelectorAll('#syncSpacesList tr.sync-space-row').length === 1, prefix, { timeout: 8000 });
    assert.match(await reopened.locator('#syncSpacesList').innerText(), new RegExp(prefix), '搜到的是这个空间');
    await reopened.locator('#syncSpaceSearch').fill('ffffffff');
    await reopened.locator('#syncSpacesList .sync-empty').waitFor({ timeout: 8000 });
    assert.match(await reopened.locator('#syncSpacesList').innerText(), /没有匹配「ffffffff」的空间/, '空态点名搜索词');
    await reopened.locator('#syncSpaceSearch').fill('');
    await admin.waitForFunction(id => [...document.querySelectorAll('#syncSpacesList tr.sync-space-row')]
        .some(row => row.textContent.includes(id)), prefix, { timeout: 8000 });

    // ⑤ 只有少量空间时**不显示**上一页/下一页（那一行是噪音）
    assert.equal(await reopened.locator('#syncSpacesPager').isVisible(), false, '少量空间时不分页');
    assert.match(await reopened.locator('#syncSpacesSummary').innerText(), /第 1–\d+ 条，共 \d+ 条/, '计数行仍然说清范围');

    // ⑥ 批量停用：勾一行 → 批量停用 → 仓库自己的确认框 → 真的落到库里
    await reopened.locator(`#syncSpacesList [data-select-space="${spaceId}"]`).check();
    assert.equal(await reopened.locator('#disableSelectedSpaces').isEnabled(), true, '选中后批量停用可用');
    await reopened.locator('#disableSelectedSpaces').click();
    await admin.locator('.ui-dialog button[type="submit"]').click();
    let disabledNow = false;
    for (let i = 0; i < 20; i++) {
        const list = await spaces(app, cookie);
        const found = list.spaces.find(s => s.id === spaceId);
        if (found && found.disabled) { disabledNow = true; break; }
        await admin.waitForTimeout(150);
    }
    assert.equal(disabledNow, true, '批量停用要真的落到库里');
    assert.equal(await reopened.locator('#disableSelectedSpaces').isEnabled(), false, '停用后勾选清空、按钮回到禁用');
});

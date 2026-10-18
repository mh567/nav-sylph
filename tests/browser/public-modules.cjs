'use strict';
// Run with Playwright available in NODE_PATH:
//   NODE_PATH=<playwright 的 node_modules> node --test tests/browser/public-modules.cjs
//
// 本用例走**用户真实入口**，不用夹具替用户做掉那一步：
//   · 管理员：登录 → 后台「模块」分区 → 拨「对普通访客开放」开关；
//   · 普通访客：编辑 → 导航设置里的「模块」分组 → 启用 → 首页出现卡片；
//   · 撤回：管理员关掉开关 → 访客页重新确认策略后**卸下卡片并停止请求**。
// 因此需要两个隔离上下文（一个访客、一个管理员），它们不共享 Cookie 与 IndexedDB。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');

const PASSWORD = 'StrongPass123!';
const ROW_COUNT = 20; // 20 > 默认 15，这样「显示条数」偏好才看得出效果

/** 上游桩：返回 20 条，供偏好截断与轮询使用。 */
async function weiboStub(t) {
    const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            code: 200,
            data: {
                list: Array.from({ length: ROW_COUNT }, (_, i) => ({
                    rank: i, title: `热搜第 ${i + 1} 条`, hot_value: 400000 - i * 1000,
                    label: '', url: 'https://s.weibo.com/weibo?q=x'
                }))
            }
        }));
    });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    t.after(() => srv.close());
    return `http://127.0.0.1:${srv.address().port}/hot`;
}

async function fixture(t) {
    const stub = await weiboStub(t);
    const app = await installation(t, { env: { NAV_WEIBO_HOT_URL: stub } });
    // 强口令：弱口令登录拿到的是 purpose='password-change' 的会话，
    // 后台每个特权请求都会被拒（HTTP 用例里踩过同一个坑）。
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'),
        JSON.stringify({ passwordHash: await bcrypt.hash(PASSWORD, 4) }));
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    return { app, browser };
}

/** 一个带请求计数的页面。 */
async function openPage(context, app) {
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });
    return {
        page,
        scriptRequests: () => requests.filter(u => u.includes('/modules/weibo-hot.js')).length,
        dataRequests: () => requests.filter(u => u.includes('/api/weibo-hot')).length
    };
}

/**
 * 让访客页重新确认一次策略。用真实的 `online` 事件：它在浏览器里由
 * 「网络恢复」触发，而 app 的监听把它接到 checkAdministratorSync → 匿名分支
 * 再走 checkPublicModules。比等 30 秒轮询快，也比直接调内部方法更接近用户路径
 * （「断网重连后重新确认」本身就是验收要求的一条）。
 */
async function reconfirm(page) {
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

/**
 * 管理员登录并打开后台「模块」分区。
 * 面板已经开着时只切分区——否则 `#adminBtn` 会被面板自己盖住，点不动。
 */
async function openAdminModules(page) {
    if (await page.locator('#modal').isHidden()) {
        await page.locator('#adminBtn').click();
        await page.locator('.ui-dialog input[type="password"]').fill(PASSWORD);
        await page.locator('.ui-dialog button[type="submit"]').click();
        await page.locator('#modal').waitFor({ state: 'visible' });
    }
    await page.locator('#adminTabModules').click();
    await page.locator('[data-module-open="weibo-hot"]').waitFor({ state: 'attached' });
}

test('browser: 访客按需启用公开模块，布局与偏好存本机，管理员撤回后立刻卸载', async t => {
    const { app, browser } = await fixture(t);
    const visitorContext = await browser.newContext();
    const adminContext = await browser.newContext();
    t.after(async () => { await visitorContext.close(); await adminContext.close(); });

    const visitor = await openPage(visitorContext, app);
    const admin = await openPage(adminContext, app);

    // ---------- 未开放：访客一个模块脚本都不下载，设置里也没有模块分组 ----------
    await visitor.page.locator('#layoutBtn').click();
    await visitor.page.locator('#localNavigationTools').waitFor({ state: 'visible' });
    assert.equal(await visitor.page.locator('#localModulesGroup').isHidden(), true,
        '没有开放的公开模块时，设置里不出现模块分组');
    assert.equal(await visitor.page.locator('.module-widget').count(), 0, '首页没有模块卡片');
    await visitor.page.locator('#localCancelBtn').click();
    assert.equal(visitor.scriptRequests(), 0, '未开放期间不下载模块脚本（首屏不为它付费）');

    // ---------- 管理员在后台开放（真实入口：登录 → 模块分区 → 拨开关） ----------
    await openAdminModules(admin.page);
    await admin.page.locator('[data-module-open="weibo-hot"]').check();
    await admin.page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已对访客开放'));
    assert.equal(await admin.page.locator('[data-module-open="weibo-hot"]').isChecked(), true);

    // ---------- 访客重新确认策略后，模块分组出现 ----------
    await reconfirm(visitor.page);
    await visitor.page.locator('#layoutBtn').click();
    await visitor.page.locator('#localModulesGroup').waitFor({ state: 'visible' });
    const toggle = visitor.page.locator('[data-module-local-toggle="weibo-hot"]');
    assert.equal(await toggle.isChecked(), false, '公开模块默认关闭——要用户自己启用');

    // ---------- 启用：首页出现卡片，且偏好控件跟着出现 ----------
    await toggle.check();
    await visitor.page.locator('.weibo-row').first().waitFor();
    assert.equal(await visitor.page.locator('.weibo-row').count(), 15, '默认显示 15 条');
    await visitor.page.locator('[data-module-setting-input="weibo-hot"]').fill('5');
    await visitor.page.locator('[data-module-setting-input="weibo-hot"]').blur();
    await visitor.page.waitForFunction(() => document.querySelectorAll('.weibo-row').length === 5);
    assert.equal(visitor.scriptRequests(), 1, '启用后才下载模块脚本，且只下载一次');

    // 非法偏好被拒并回落默认（不是静默接受）
    await visitor.page.locator('[data-module-setting-input="weibo-hot"]').fill('99');
    await visitor.page.locator('[data-module-setting-input="weibo-hot"]').blur();
    await visitor.page.waitForFunction(() => document.querySelector('#toast').textContent.includes('只接受'));
    assert.equal(await visitor.page.locator('[data-module-setting-input="weibo-hot"]').inputValue(), '15',
        '越界值回落到声明的默认值');
    await visitor.page.locator('[data-module-setting-input="weibo-hot"]').fill('5');
    await visitor.page.locator('[data-module-setting-input="weibo-hot"]').blur();
    await visitor.page.waitForFunction(() => document.querySelectorAll('.weibo-row').length === 5);

    await visitor.page.locator('#localDoneBtn').click();
    await visitor.page.waitForFunction(() => document.querySelector('#localNavigationStatus').textContent === '仅保存在本机');

    // ---------- 刷新后仍在（本机持久化） ----------
    await visitor.page.reload();
    await visitor.page.locator('.weibo-row').first().waitFor();
    assert.equal(await visitor.page.locator('.weibo-row').count(), 5, '偏好与开关都从本机恢复');

    // ---------- 管理员撤回：访客重新确认后卸下卡片，并**停止请求** ----------
    await openAdminModules(admin.page);
    await admin.page.locator('[data-module-open="weibo-hot"]').uncheck();
    await admin.page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已撤回'));

    await reconfirm(visitor.page);
    await visitor.page.waitForFunction(() => document.querySelectorAll('.module-widget').length === 0);
    assert.equal(await visitor.page.locator('.weibo-row').count(), 0, '撤回后卡片被卸下');

    // 「停止请求」这一条要用模块**自己的**重拉路径去证：公开模块在页面回到前台时
    // 会立即补拉一次（visibilitychange + !pollTimer）。卸载若没把定时器与监听
    // 收干净，这里就会冒出一条新的 /api/weibo-hot 请求 —— 而服务端此刻已经在 403。
    const before = visitor.dataRequests();
    await visitor.page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await visitor.page.waitForTimeout(600);
    assert.equal(visitor.dataRequests(), before, '卸载后不再有任何模块请求');

    // ---------- 重新开放：偏好还在，卡片自动回来 ----------
    await openAdminModules(admin.page);
    await admin.page.locator('[data-module-open="weibo-hot"]').check();
    await admin.page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已对访客开放'));
    await reconfirm(visitor.page);
    await visitor.page.locator('.weibo-row').first().waitFor();
    assert.equal(await visitor.page.locator('.weibo-row').count(), 5,
        '重新开放后用户的偏好（5 条）原样恢复——撤回不删除偏好');
});

/**
 * 直接驱动「页面进入/离开后台」这个机制。
 *
 * 环境造不出真正的后台标签页（headless 里 document.hidden 恒为 false），
 * 所以改写这个属性再派发真实事件——模块与平台挂的都是同一个
 * visibilitychange 监听，走的是它们自己的处理器。它证明的是**接线**正确，
 * 不证明真实后台标签页的时序。
 */
const setHidden = (page, hidden) => page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { value, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

test('browser: 访客的模块布局存在本机，不进管理员的服务端配置（布局隔离）', async t => {
    const { app, browser } = await fixture(t);
    const visitorContext = await browser.newContext();
    const adminContext = await browser.newContext();
    t.after(async () => { await visitorContext.close(); await adminContext.close(); });
    const visitor = await openPage(visitorContext, app);
    const admin = await openPage(adminContext, app);

    await openAdminModules(admin.page);
    await admin.page.locator('[data-module-open="weibo-hot"]').check();
    await admin.page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已对访客开放'));

    const cookie = (await app.request('/api/verify-password', { password: PASSWORD, body: {} }))
        .headers.get('set-cookie').split(';')[0];
    const serverWidgets = async () => (await (await app.request('/api/modules/config', { cookie })).json()).widgets;
    const before = await serverWidgets();

    // 宽视口才有「两侧停靠」，换边才拖得动
    await visitor.page.setViewportSize({ width: 1800, height: 1000 });
    await reconfirm(visitor.page);
    await visitor.page.locator('#layoutBtn').click();
    await visitor.page.locator('#localModulesGroup').waitFor({ state: 'visible' });
    await visitor.page.locator('[data-module-local-toggle="weibo-hot"]').check();
    await visitor.page.locator('.weibo-row').first().waitFor();

    const card = visitor.page.locator('.module-widget[data-module-id="weibo-hot"]');
    assert.equal(await card.getAttribute('data-side'), 'left', '未布局时停靠默认一侧');
    const handle = await card.locator('.module-drag-handle').boundingBox();
    await visitor.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await visitor.page.mouse.down();
    await visitor.page.mouse.move(1700, handle.y + 100, { steps: 15 });
    await visitor.page.mouse.up();
    await visitor.page.locator('#localDoneBtn').click();
    await visitor.page.waitForFunction(() => document.querySelector('#localNavigationStatus').textContent === '仅保存在本机');
    assert.equal(await card.getAttribute('data-side'), 'right', '拖到另一侧后立即归位');

    await visitor.page.reload();
    await visitor.page.locator('.weibo-row').first().waitFor();
    assert.equal(await visitor.page.locator('.module-widget[data-module-id="weibo-hot"]').getAttribute('data-side'), 'right',
        '布局从本机恢复（不是从服务端）');
    assert.deepEqual(await serverWidgets(), before, '服务端那份布局一点没变——两套存储互不写入');
});

test('browser: 离线保留已确认的公开模块，联网后轮询恢复', async t => {
    const { app, browser } = await fixture(t);
    const visitorContext = await browser.newContext();
    const adminContext = await browser.newContext();
    t.after(async () => { await visitorContext.close(); await adminContext.close(); });
    const visitor = await openPage(visitorContext, app);
    const admin = await openPage(adminContext, app);

    await openAdminModules(admin.page);
    await admin.page.locator('[data-module-open="weibo-hot"]').check();
    await admin.page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已对访客开放'));
    await reconfirm(visitor.page);
    await visitor.page.locator('#layoutBtn').click();
    await visitor.page.locator('#localModulesGroup').waitFor({ state: 'visible' });
    await visitor.page.locator('[data-module-local-toggle="weibo-hot"]').check();
    await visitor.page.locator('.weibo-row').first().waitFor();
    await visitor.page.locator('#localDoneBtn').click();
    const rows = await visitor.page.locator('.weibo-row').count();
    assert.ok(rows > 0, `启用后拿到榜单（${rows} 行）`);

    // 断网并让模块真拉一次：失败态应当出现，而卡片与已取到的榜单都留着。
    await visitorContext.setOffline(true);
    await setHidden(visitor.page, true);
    await setHidden(visitor.page, false);
    await visitor.page.waitForFunction(() => document.querySelector('.weibo-card-status')?.dataset.kind === 'failed');
    assert.equal(await visitor.page.locator('.module-widget[data-module-id="weibo-hot"]').count(), 1,
        '离线不拆卡片——策略确认失败时沿用上一次已知结果');
    assert.equal(await visitor.page.locator('.weibo-row').count(), rows, '已取到的榜单仍留在卡上');

    // 恢复联网：策略重新确认（仍然开放），失败的模块从重试入口恢复。
    await visitorContext.setOffline(false);
    await reconfirm(visitor.page);
    await visitor.page.locator('.weibo-card-status [data-action="retry"]').click();
    await visitor.page.waitForFunction(() => document.querySelector('.weibo-card-status')?.dataset.kind !== 'failed');
    assert.equal(await visitor.page.locator('.weibo-row').count(), rows, '恢复后榜单正常');
});

test('browser: 管理员的启用与开放是两件事，私人模块不在访客的设置里', async t => {
    const { app, browser } = await fixture(t);
    const visitorContext = await browser.newContext();
    const adminContext = await browser.newContext();
    t.after(async () => { await visitorContext.close(); await adminContext.close(); });
    const visitor = await openPage(visitorContext, app);
    const admin = await openPage(adminContext, app);

    await openAdminModules(admin.page);
    // 私人模块（备忘录）没有「对外开放」开关——分类在开发时就定了
    assert.equal(await admin.page.locator('[data-module-open="memo"]').count(), 0,
        '私人模块没有开放开关，不可能被转成公开');
    // 开放开关不随「启用」折叠：未启用的公开模块也要能开放
    const blockOff = await admin.page.locator('.module-block[data-module="weibo-hot"]').getAttribute('data-enabled');
    assert.equal(blockOff, '0', '默认未启用');
    assert.equal(await admin.page.locator('[data-module-open="weibo-hot"]').isVisible(), true,
        '未启用时「对普通访客开放」仍然可见可点');

    await admin.page.locator('[data-module-open="weibo-hot"]').check();
    await admin.page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已对访客开放'));
    // 管理员自己**没有**启用它 → 他自己的首页仍然没有这张卡；但访客可以用
    assert.equal(await admin.page.locator('.weibo-row').count(), 0, '开放不等于给自己启用');

    await reconfirm(visitor.page);
    await visitor.page.locator('#layoutBtn').click();
    await visitor.page.locator('#localModulesGroup').waitFor({ state: 'visible' });
    assert.equal(await visitor.page.locator('.local-module-row').count(), 1, '访客设置里只有公开模块一行');
    assert.equal(await visitor.page.locator('[data-module-row="memo"]').count(), 0,
        '私人模块不出现在访客的设置里');
});

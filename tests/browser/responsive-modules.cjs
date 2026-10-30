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
                    rank: i, title: `热搜第 ${i + 1} 条：这是一条用于检查窄窗口排版的完整长标题`, hot_value: 400000 - i * 1000,
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
 * 管理员登录并打开后台「模块」分区。
 * 面板已经开着时只切分区，否则 `#adminBtn` 会被面板自己盖住，点不动。
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

test('browser: 模块随窗口重排，长标题完整且不挤压导航', async t => {
    const { app, browser } = await fixture(t);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    t.after(() => context.close());
    const { page } = await openPage(context, app);
    await openAdminModules(page);
    for (const id of ['weibo-hot', 'memo', 'server-monitor']) {
        const title = await page.locator(`[data-module-toggle="${id}"]`).evaluate(n => n.closest('.module-block').querySelector('.module-block-title').textContent);
        const saved = page.waitForResponse(r => r.url().endsWith('/api/modules/config') && r.request().method() === 'POST');
        await page.locator(`label:has([data-module-toggle="${id}"])`).click();
        const response = await saved;
        assert.equal(response.status(), 200);
        await page.waitForFunction(({ id, title }) => document.querySelector(`[data-module-toggle="${id}"]`) && document.querySelector('#toast').textContent.includes(`「${title}」`), { id, title });
    }
    await page.locator('#cancelBtn').click();
    await page.locator('.weibo-row').first().waitFor();
    for (const width of [1280, 1440, 1244, 1243, 1024, 844, 834, 768, 600, 390, 360, 320, 1440]) {
        await page.setViewportSize({ width, height: width === 844 ? 390 : width <= 390 ? 640 : 900 });
        await page.waitForTimeout(500); // 等待 150ms resize 节流与 220ms 让位完成
        const metrics = await page.evaluate(() => {
            const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, right: r.right, bottom: r.bottom }; };
            const widgets = [...document.querySelectorAll('.module-widget')].map(rect);
            const title = document.querySelector('.weibo-title');
            return { dock: document.querySelector('#moduleZone').dataset.dock,
                board: rect(document.querySelector('.backboard')), widgets,
                overflow: document.documentElement.scrollWidth > innerWidth,
                titleClipped: title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1 };
        });
        console.log(JSON.stringify({ width, ...metrics }));
        await page.screenshot({ path: `/tmp/sylph-modules-${width}.png`, fullPage: true });
        assert.equal(metrics.overflow, false, `${width}: 页面无横向溢出`);
        assert.equal(metrics.titleClipped, false, `${width}: 长热搜标题完整显示`);
        for (const widget of metrics.widgets) {
            assert.ok(widget.width >= Math.min(280, width - 24), `${width}: 卡片保持可读宽度`);
            assert.ok(widget.x >= 0 && widget.right <= width + 1, `${width}: 卡片位于窗口内`);
            if (metrics.dock === 'outside') assert.ok(widget.right <= metrics.board.x - 19 || widget.x >= metrics.board.right + 19, `${width}: 模块与导航留出间距`);
            else assert.ok(widget.y >= metrics.board.bottom, `${width}: 模块落在导航下方`);
        }
        for (let i = 0; i < metrics.widgets.length; i++) for (let j = i + 1; j < metrics.widgets.length; j++) {
            const a = metrics.widgets[i], b = metrics.widgets[j];
            assert.ok(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, `${width}: 模块互不遮挡`);
        }
    }
    // 下方网格拖动最后一张卡到首位，再保存并恢复宽屏。
    await page.setViewportSize({ width: 834, height: 900 });
    await page.waitForTimeout(500);
    await page.locator('#layoutBtn').click();
    const hot = page.locator('[data-module-id="weibo-hot"]');
    await hot.locator('.module-drag-handle').scrollIntoViewIfNeeded();
    const handle = await hot.locator('.module-drag-handle').boundingBox();
    const first = await page.locator('.module-widget').first().boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 20, first.y + 5, { steps: 12 });
    await page.mouse.up();
    assert.equal(await page.locator('.module-widget').first().getAttribute('data-module-id'), 'weibo-hot');
    await page.locator('#localDoneBtn').click();
    await page.locator('#localDoneBtn').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);
    await page.locator('#adminBtn').click();
    await page.locator('#adminTabModules').click();
    await page.locator('label:has([data-module-toggle="special-line"])').click();
    await page.locator('#cancelBtn').click();
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const width of [1440, 1364, 1363, 1280, 390]) {
        await page.setViewportSize({ width, height: width === 844 ? 390 : width <= 390 ? 640 : 900 });
        await page.waitForTimeout(500);
        const sizes = await page.locator('.module-widget').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().width));
        assert.ok(sizes.every(w => w >= 280), `${width}: 时间线与普通模块同时启用仍保持宽度`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: `/tmp/sylph-timeline-${width}.png`, fullPage: true });
    }
});

test('browser: 停用最后一个模块后导航恢复居中', async t => {
    const { app, browser } = await fixture(t);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    t.after(() => context.close());
    const { page } = await openPage(context, app);
    await openAdminModules(page);
    await page.locator('label:has([data-module-toggle="weibo-hot"])').click();
    await page.locator('#cancelBtn').click();
    await page.locator('.weibo-row').first().waitFor();
    await page.locator('#adminBtn').click();
    await page.locator('#adminTabModules').click();
    const saved = page.waitForResponse(r => r.url().endsWith('/api/modules/config') && r.request().method() === 'POST');
    await page.locator('label:has([data-module-toggle="weibo-hot"])').click();
    assert.equal((await saved).status(), 200);
    await page.locator('#cancelBtn').click();
    await page.locator('#moduleZone').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => Math.abs(document.querySelector('#app > .backboard').getBoundingClientRect().width - 936) < 1);
    assert.equal(await page.locator('#app').getAttribute('data-rail'), 'narrow');
});

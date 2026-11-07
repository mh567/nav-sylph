'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');
const shots = path.join(__dirname, '../../.impeccable/review');

async function fixture(t) {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });
    return { app, browser, context, page };
}
async function appearance(page, style, mode) {
    await page.waitForFunction(({ style, mode }) => document.documentElement.dataset.themeStyle === style && (document.documentElement.dataset.theme || 'auto') === mode, { style, mode });
}
async function login(page) {
    await page.locator('#adminBtn').click();
    await page.locator('.ui-dialog input[type="password"]').fill('StrongPass123!');
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#modal').waitFor({ state: 'visible' });
}
async function saveAdmin(page) {
    const response = page.waitForResponse(r => r.url().endsWith('/api/admin/navigation') && r.request().method() === 'POST');
    await page.locator('#saveBtn').click();
    assert.equal((await response).status(), 200);
    await page.locator('#modal').waitFor({ state: 'hidden' });
}

test('browser: 访客主题真实保存、取消、重载、离线回访与经典明暗偏好恢复', async t => {
    const { page, context } = await fixture(t);
    await page.locator('#layoutBtn').click();
    await page.locator('#localThemeSelect').selectOption('light');
    await page.locator('#localThemeStyleSelect').selectOption('prism');
    assert.equal(await page.locator('#localThemeSelect').isDisabled(), true);
    await page.locator('#localDoneBtn').click();
    await appearance(page, 'prism', 'dark');
    await page.reload();
    await appearance(page, 'prism', 'dark');
    await context.setOffline(true);
    await page.reload();
    await appearance(page, 'prism', 'dark');
    await context.setOffline(false);
    await page.locator('#layoutBtn').click();
    await page.locator('#localThemeStyleSelect').selectOption('classic');
    await page.locator('#localCancelBtn').click();
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#localNavigationTools').waitFor({ state: 'hidden' });
    await appearance(page, 'prism', 'dark');
    await page.locator('#layoutBtn').click();
    await page.locator('#localThemeStyleSelect').selectOption('classic');
    assert.equal(await page.locator('#localThemeSelect').isDisabled(), false);
    assert.equal(await page.locator('#localThemeSelect').inputValue(), 'light');
    await page.locator('#localDoneBtn').click();
    await appearance(page, 'classic', 'light');
    await page.reload();
    await appearance(page, 'classic', 'light');
});

test('browser: 管理员主题覆盖模块、后台及对话框，跨会话保存且与访客配置隔离', async t => {
    const { page, app, context, browser } = await fixture(t);
    fs.mkdirSync(shots, { recursive: true });
    await login(page);
    await page.locator('#themeModeSelect').selectOption('light');
    await page.locator('#themeStyleSelect').selectOption('prism');
    await appearance(page, 'prism', 'dark');
    assert.equal(await page.locator('#themeModeSelect').isDisabled(), true);
    assert.equal(await page.locator('#themeModeSelect').inputValue(), 'dark');
    await page.screenshot({ path: path.join(shots, 'admin.png'), fullPage: true });
    await saveAdmin(page);
    await page.locator('#adminBtn').click();
    await page.locator('#adminTabModules').click();
    for (const id of ['memo', 'server-monitor', 'special-line']) {
        const response = page.waitForResponse(r => r.url().endsWith('/api/modules/config') && r.request().method() === 'POST');
        await page.locator(`label:has([data-module-toggle="${id}"])`).click();
        assert.equal((await response).status(), 200);
    }
    await page.locator('#cancelBtn').click();
    await page.locator('.memo-card').waitFor();
    await page.locator('#toast').waitFor({ state: 'hidden' });
    for (const [name, width] of [['desktop', 1440], ['tablet', 834], ['mobile', 390], ['narrow', 320]]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
        assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(10, 11, 14)');
        const colors = await page.locator('.module-widget').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).backgroundColor));
        assert.ok(colors.length >= 2);
        assert.ok(colors.every(c => c === 'rgba(12, 13, 17, 0.6)'), JSON.stringify(colors));
        await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.memo-card-manage').click();
    await page.locator('.memo-panel').waitFor();
    await page.screenshot({ path: path.join(shots, 'memo.png'), fullPage: true });
    await page.goto(app.base);
    await appearance(page, 'prism', 'dark');
    await page.evaluate(() => window.app.createPaste('用于验证主题的分享内容。'));
    const shareCode = await page.locator('.paste-code').textContent();
    await page.goto(app.base + '/p/' + shareCode);
    await appearance(page, 'prism', 'dark');
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(10, 11, 14)');
    await page.locator('#content').filter({ hasText: '用于验证主题的分享内容。' }).waitFor();
    const shareColors = await page.evaluate(() => Object.fromEntries(['body', '.container', '#content', '#copyBtn'].map(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return [selector, { background: style.backgroundColor, color: style.color }];
    })));
    assert.equal(shareColors['.container'].background, 'rgba(12, 13, 17, 0.94)');
    assert.equal(shareColors['#content'].color, 'rgb(243, 244, 246)');
    console.log('share computed styles: ' + JSON.stringify(shareColors));
    await page.screenshot({ path: path.join(shots, 'share.png'), fullPage: true });
    await page.goto(app.base);
    await appearance(page, 'prism', 'dark');
    await page.locator('#appearanceBtn').click();
    await page.locator('#themeStyleSelect').waitFor({ state: 'visible' });
    await page.locator('#themeStyleSelect').selectOption('classic');
    await appearance(page, 'classic', 'light');
    await page.locator('#cancelBtn').click();
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await appearance(page, 'prism', 'dark');
    // 新浏览器会话使用相同管理员 Cookie，读取服务端已保存的主题。
    const second = await browser.newContext({ storageState: { cookies: await context.cookies(), origins: [] } });
    t.after(() => second.close());
    const secondPage = await second.newPage();
    await secondPage.goto(app.base);
    await appearance(secondPage, 'prism', 'dark');
    const anonymous = await browser.newContext();
    t.after(() => anonymous.close());
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto(app.base);
    await appearance(anonymousPage, 'classic', 'auto');
    assert.equal((await (await app.request('/api/config')).json()).themeStyle, undefined);
});

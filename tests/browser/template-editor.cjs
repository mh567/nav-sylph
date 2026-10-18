'use strict';
// 站点默认首页：面板内 1:1 可视化编辑的端到端验收。
//
// 走的是真实路径：临时安装 → 真实登录 → 后台「首页导航」→ 画布上直接编辑
// → 保存草稿 → 发布 → 登出后匿名首页读到新模板。
// 同时钉住两条最容易出事的边界：
//   1. 面板宽度足够时画布背板是 936px（与独立首页一致，不是缩放）。
//   2. 模板编辑不碰管理员个人导航。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');

async function setup(t) {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('dialog', dialog => dialog.accept());
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });
    return { app, browser, context, page };
}

async function loginKeepingPanel(page) {
    await page.locator('#adminBtn').click();
    await page.locator('.ui-dialog input[type="password"]').fill('StrongPass123!');
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.locator('#modal').waitFor({ state: 'visible' });
    // 默认就停在「首页导航」分区
    await page.locator('#adminPanelSite').waitFor({ state: 'visible' });
}

test('browser: 模板草稿在后台面板内直接可视化编辑，保存后发布，且不动个人导航', async t => {
    const { page } = await setup(t);
    await loginKeepingPanel(page);
    await page.locator('#templateGrid .category').first().waitFor();

    // ---------- 1:1：画布里的背板必须是 936px ----------
    const boardWidth = await page.locator('#templateGrid').evaluate(grid => {
        const board = grid.closest('.backboard');
        return Math.round(board.getBoundingClientRect().width);
    });
    assert.equal(boardWidth, 936, `面板内背板应等于独立首页的 936px，实际 ${boardWidth}`);

    // ---------- 只读态没有任何编辑控件 ----------
    assert.equal(await page.locator('#templateGrid .category-action').count(), 0, '只读态不渲染分类编辑按钮');
    assert.equal(await page.locator('#templateGrid .bookmark-add').count(), 0, '只读态不渲染 ＋ 卡');
    assert.equal(await page.locator('#templateEditBtn').isVisible(), true, '只读态给「编辑」入口');
    assert.equal(await page.locator('#templateSaveBtn').isVisible(), false, '只读态不显示「保存草稿」');
    // 「发布」是终态动作，常显；此时尚无未发布草稿，所以是禁用的。
    assert.equal(await page.locator('#templatePublishBtn').isVisible(), true, '「发布」常显');
    assert.equal(await page.locator('#templatePublishBtn').isDisabled(), true, '没有未发布草稿时不可发布');

    const personalBefore = await page.evaluate(() => JSON.stringify(window.app.config.categories));

    // ---------- 进入编辑：编辑控件出现 ----------
    await page.locator('#templateEditBtn').click();
    await page.locator('#templateGrid .category-action').first().waitFor();
    assert.equal(await page.locator('#templateActions').isVisible(), true, '编辑态显示操作栏');
    assert.equal(await page.locator('#templateEditBtn').isVisible(), false, '编辑态收起「编辑」入口');

    // ---------- 在画布上加一条链接 ----------
    await page.locator('#templateGrid .bookmark-add').first().click();
    const dialog = page.locator('.ui-dialog');
    await dialog.locator('input').nth(0).fill('模板新链接');
    await dialog.locator('input').nth(1).fill('https://example.com/template');
    await dialog.locator('button[type="submit"]').click();
    await page.locator('#templateGrid .bookmark-title', { hasText: '模板新链接' }).first().waitFor();

    // ---------- 未保存时发布被禁用 ----------
    assert.equal(await page.locator('#templatePublishBtn').isDisabled(), true, '有未保存改动时发布必须禁用');
    assert.equal(await page.locator('#templateState').getAttribute('data-dirty'), 'true', 'dirty 状态可见');

    // ---------- 保存草稿 → 发布可用 ----------
    const savedToast = page.getByText('草稿已保存，公开首页保持原样');
    await page.locator('#templateSaveBtn').click();
    await savedToast.waitFor();
    assert.equal(await page.locator('#templatePublishBtn').isDisabled(), false, '保存后发布可用');
    assert.equal(await page.locator('#templateState').getAttribute('data-dirty'), 'false', '保存后 dirty 清除');

    // ---------- 第二轮：已有未发布草稿时，新的未保存改动同样要挡住发布 ----------
    // 这一段是变异验证补出来的：第一次编辑时 revision 与 publishedRevision 相等，
    // 「发布」被「已发布」那一项挡住，看不住 dirty 这一项是不是真的生效。
    await page.locator('#templateEditBtn').click();
    await page.locator('#templateGrid .bookmark-add').first().click();
    await dialog.locator('input').nth(0).fill('第二轮未保存');
    await dialog.locator('input').nth(1).fill('https://example.com/second');
    await dialog.locator('button[type="submit"]').click();
    await page.locator('#templateGrid .bookmark-title', { hasText: '第二轮未保存' }).first().waitFor();
    assert.equal(await page.locator('#templatePublishBtn').isDisabled(), true,
        '已有未发布草稿时，新的未保存改动仍须挡住发布');
    await page.locator('#templateCancelBtn').click();
    await page.locator('#templateGrid .bookmark-title', { hasText: '第二轮未保存' }).first().waitFor({ state: 'detached' });
    assert.equal(await page.locator('#templatePublishBtn').isDisabled(), false, '取消后回到已保存草稿，发布恢复可用');

    // ---------- 发布 ----------
    const publishedToast = page.getByText('默认首页已发布，个人导航保持原样');
    await page.locator('#templatePublishBtn').click();
    await publishedToast.waitFor();

    // ---------- 个人导航没被改动 ----------
    const personalAfter = await page.evaluate(() => JSON.stringify(window.app.config.categories));
    assert.equal(personalAfter, personalBefore, '编辑并发布模板不得改动管理员个人导航');

    // ---------- 匿名首页读到新模板 ----------
    const publicConfig = await page.evaluate(async () => (await fetch('/api/config')).json());
    const titles = publicConfig.categories.flatMap(c => c.bookmarks.map(b => b.title));
    assert.ok(titles.includes('模板新链接'), '匿名首页应读到已发布的模板内容');
});

test('browser: 关闭面板会提示未保存的模板草稿', async t => {
    const { page } = await setup(t);
    await loginKeepingPanel(page);
    await page.locator('#templateGrid .category').first().waitFor();
    await page.locator('#templateEditBtn').click();
    await page.locator('#templateGrid .bookmark-add').first().click();
    const dialog = page.locator('.ui-dialog');
    await dialog.locator('input').nth(0).fill('未保存的链接');
    await dialog.locator('input').nth(1).fill('https://example.com/draft');
    await dialog.locator('button[type="submit"]').click();
    await page.locator('#templateGrid .bookmark-title', { hasText: '未保存的链接' }).first().waitFor();

    // 关面板 → 应先问一句
    await page.locator('#cancelBtn').click();
    await page.getByText(/站点默认首页有未保存的草稿改动/).waitFor();
    // 取消（不关）→ 面板还在，草稿还在
    await page.locator('.ui-dialog button[type="button"]').filter({ hasText: '取消' }).click();
    await page.locator('#modal').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#templateGrid .bookmark-title', { hasText: '未保存的链接' }).count(), 1,
        '取消关闭后草稿仍在画布上');
});

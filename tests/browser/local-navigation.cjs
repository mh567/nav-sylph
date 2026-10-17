'use strict';
// Run with Playwright available in NODE_PATH: node --test tests/browser/local-navigation.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');

test('browser: visitor navigation changes persist through reload', async t => {
    const app = await installation(t);
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.locator('#layoutBtn').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('#layoutBtn').click();
    await page.getByRole('button', { name: '＋ 添加分类', exact: true }).click();
    await page.locator('.ui-dialog input').fill('Browser personal');
    await page.locator('.ui-dialog button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#localNavigationStatus').textContent === '仅保存在本机');
    await page.reload();
    await page.getByRole('heading', { name: 'Browser personal', exact: true }).waitFor();
    assert.equal(await page.locator('#modeBtn').isVisible(), false);
});

async function setup(t, options = {}) {
    const app = await installation(t);
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('dialog', dialog => dialog.accept());
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });
    return { app, browser, context, page };
}
const saved = page => page.waitForFunction(() => document.querySelector('#localNavigationStatus').textContent === '仅保存在本机');
const submit = page => page.locator('.ui-dialog button[type="submit"]').click();
async function engines(page, entries, current) {
    while (await page.locator('.local-engine-list fieldset').count() > 1) await page.locator('.local-engine-list fieldset').last().getByRole('button', { name: '删除', exact: true }).click();
    for (let i = 0; i < entries.length; i++) {
        if (i) await page.getByRole('button', { name: '添加引擎', exact: true }).click();
        const row = page.locator('.local-engine-list fieldset').nth(i);
        for (const [field, value] of Object.entries(entries[i])) await row.locator(`[data-field="${field}"]`).fill(value);
    }
    if (current) await page.locator('#localCurrentEngine').selectOption(current);
}


test('browser: engine drafts validate, reorder and fall back after deleting current; undo and reload retain definitions', async t => {
    const { page } = await setup(t);
    await page.locator('#localSettingsBtn').click();
    await engines(page, [{ id: 'first', name: 'First', url: 'https://first.example/?q=' }, { id: 'second', name: 'Second', url: 'https://second.example/?q=' }], 'second');
    await page.locator('.local-engine-list fieldset').last().getByRole('button', { name: '上移', exact: true }).click();
    await submit(page); await saved(page);
    assert.equal(await page.locator('#engineName').textContent(), 'Second');
    await page.locator('#localSettingsBtn').click();
    await page.locator('.local-engine-list fieldset').first().locator('[data-field="url"]').fill('javascript:alert(1)');
    await submit(page);
    assert.match(await page.locator('.ui-dialog-error').textContent(), /HTTP\/HTTPS/);
    await page.reload();
    // Unconfirmed input never reaches IndexedDB.
    assert.equal(await page.locator('#engineName').textContent(), 'Second');
    await page.locator('#localSettingsBtn').click();
    await page.locator('.local-engine-list fieldset').first().getByRole('button', { name: '删除', exact: true }).click();
    assert.equal(await page.locator('.local-engine-list fieldset').first().getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
    await submit(page); await saved(page);
    assert.equal(await page.locator('#engineName').textContent(), 'First');
    await page.locator('#localUndoBtn').click(); await saved(page);
    assert.equal(await page.locator('#engineName').textContent(), 'Second');
});

test('browser: competing tabs retain unfinished input and reject a stale write', async t => {
    const { page, context, app } = await setup(t);
    const other = await context.newPage();
    other.setDefaultTimeout(6000);
    await other.goto(app.base);
    await other.locator('#app').waitFor({ state: 'visible' });
    await page.locator('#localSettingsBtn').click();
    await engines(page, [{ id: 'mine', name: 'My unsaved engine', url: 'https://mine.example/?q=' }], 'mine');
    await other.locator('#appearanceBtn').click(); await saved(other);
    await page.locator('#localAdoptBtn').waitFor({ state: 'visible' });
    assert.match(await page.getByLabel('引擎 1 名称', { exact: true }).inputValue(), /My unsaved engine/);
    await submit(page);
    await page.waitForFunction(() => document.querySelector('#localNavigationStatus').textContent.includes('其他标签页已修改'));
    await other.reload();
    assert.notEqual(await other.locator('#engineName').textContent(), 'My unsaved engine');
    await page.locator('#localAdoptBtn').click(); await submit(page); await saved(page);
    assert.equal(await page.locator('#engineName').textContent(), await other.locator('#engineName').textContent());
});

test('browser: import rejects unsafe/empty configurations, falls back engine, exports and resets atomically', async t => {
    const { page, context } = await setup(t);
    const original = await page.evaluate(async () => (await fetch('/api/config')).json());
    const upload = async config => page.locator('#localImportFile').setInputFiles({ name: 'navigation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, config })) });
    for (const mutate of [c => { c.searchEngines = []; }, c => { c.searchEngines.push(c.searchEngines[0]); }, c => { c.searchEngines[0].url = 'javascript:alert(1)'; }, c => { c.categories[0].bookmarks[0].url = 'file:///etc/passwd'; }, c => { c.modules = { enabledModules: ['memo'] }; }]) {
        const bad = structuredClone(original); mutate(bad);
        await upload(bad);
        await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('导入失败'));
        assert.equal(await page.locator('.ui-dialog').count(), 0);
    }
    const config = structuredClone(original); config.categories[0].name = 'Imported navigation'; config.searchEngine = 'missing';
    await upload(config); await submit(page); await saved(page);
    await page.getByRole('heading', { name: 'Imported navigation', exact: true }).waitFor();
    const downloading = page.waitForEvent('download');
    await page.locator('#localExportBtn').click();
    const download = await downloading;
    const data = JSON.parse(require('node:fs').readFileSync(await download.path(), 'utf8'));
    assert.equal(data.schemaVersion, 1); assert.equal(data.config.categories[0].name, 'Imported navigation');
    assert.equal(data.config.searchEngine, original.searchEngines[0].id);
    assert.equal(data.config.privacyMode, undefined);
    await context.setOffline(true);
    await page.locator('#localResetBtn').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('重置失败'));
    assert.equal(await page.getByRole('heading', { name: 'Imported navigation', exact: true }).count(), 1);
    await context.setOffline(false);
    await page.locator('#localResetBtn').click(); await submit(page); await saved(page);
    assert.equal(await page.getByRole('heading', { name: 'Imported navigation', exact: true }).count(), 0);
    await page.locator('#localUndoBtn').click(); await saved(page);
    assert.equal(await page.getByRole('heading', { name: 'Imported navigation', exact: true }).count(), 1);
});

test('browser: browser restart, offline revisit and service worker upgrade retain personal navigation', async t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const app = await installation(t); await app.start();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-browser-'));
    let context;
    t.after(async () => { await context?.close(); fs.rmSync(profile, { recursive: true, force: true }); });
    const launch = () => chromium.launchPersistentContext(profile, { headless: true, channel: 'chrome' });
    context = await launch();
    let page = await context.newPage(); page.setDefaultTimeout(8000);
    await page.goto(app.base);
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.locator('#layoutBtn').click();
    await page.getByRole('button', { name: '＋ 添加分类', exact: true }).click();
    await page.locator('.ui-dialog input').fill('Restart survives'); await submit(page); await saved(page);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await context.close(); context = await launch();
    page = await context.newPage(); page.setDefaultTimeout(8000);
    await context.setOffline(true);
    await page.goto(app.base);
    await page.getByRole('heading', { name: 'Restart survives', exact: true }).waitFor();
    assert.equal(await page.locator('#modeBtn').isVisible(), false);
    assert.equal(await page.locator('#moduleZone').isVisible(), false);
    await context.setOffline(false);
    const sw = path.join(app.dir, 'public/sw.js');
    fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace("const CACHE = 'nav-v109'", "const CACHE = 'nav-v109-browser-upgrade'"));
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; await registration.update(); });
    await page.waitForFunction(async () => (await caches.keys()).includes('nav-v109-browser-upgrade'));
    await page.reload();
    await page.getByRole('heading', { name: 'Restart survives', exact: true }).waitFor();
});

test('browser: storage failure reports unsaved state and keeps the previous committed data', async t => {
    const { page } = await setup(t);
    const theme = await page.locator('html').getAttribute('data-theme');
    await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('test quota exhausted', 'QuotaExceededError'); }; });
    await page.locator('#appearanceBtn').click();
    await page.waitForFunction(() => document.querySelector('#localNavigationStatus').textContent.includes('未能保存到本机'));
    assert.match(await page.locator('#toast').textContent(), /未能保存到本机/);
    await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
});

test('browser: delayed administrator confirmation preserves ordinary drafts and never writes private configuration locally', async t => {
    const fs = require('node:fs'), path = require('node:path'), bcrypt = require('bcrypt');
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8000);
    await page.goto(app.base); await page.locator('#app').waitFor({ state: 'visible' });
    await page.locator('#layoutBtn').click();
    await page.getByRole('button', { name: '＋ 添加分类', exact: true }).click();
    await page.locator('.ui-dialog input').fill('Ordinary kept'); await submit(page); await saved(page);
    await page.locator('#layoutBtn').click();
    // Establish the real cookie from the browser so its device fingerprint matches.
    await page.evaluate(async () => {
        const response = await fetch('/api/verify-password', { method: 'POST', headers: { 'X-Admin-Password': 'StrongPass123!', 'X-Sylph-Request': '1', 'Content-Type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error('login failed');
        const data = await (await fetch('/api/admin/navigation')).json();
        data.config.categories[0].name = 'PRIVATE ADMIN NAVIGATION';
        const result = await fetch('/api/admin/navigation', { method: 'POST', headers: { 'X-Sylph-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ config: data.config, revision: data.revision, operationId: 'browser-admin-setup' }) });
        if (!result.ok) throw new Error('admin setup failed');
    });
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    await page.route('**/api/session', async route => { const response = await route.fetch(); await delayed; await route.fulfill({ response }); });
    await page.reload();
    await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('heading', { name: 'PRIVATE ADMIN NAVIGATION', exact: true }).count(), 0);
    await page.locator('#localSettingsBtn').click();
    await engines(page, [{ id: 'ordinary', name: 'Ordinary engine', url: 'https://ordinary.example/?q=' }], 'ordinary');
    release();
    await page.waitForFunction(() => document.querySelector('#localNavigationStatus').textContent.includes('完成当前编辑'));
    assert.match(await page.getByLabel('引擎 1 名称', { exact: true }).inputValue(), /Ordinary engine/);
    await submit(page);
    await page.getByRole('heading', { name: 'PRIVATE ADMIN NAVIGATION', exact: true }).waitFor();
    assert.equal(await page.locator('#localNavigationTools').isVisible(), false);
    await page.evaluate(async () => { await fetch('/api/logout', { method: 'POST', headers: { 'X-Sylph-Request': '1', 'Content-Type': 'application/json' }, body: '{}' }); });
    await page.unroute('**/api/session');
    await page.reload();
    await page.getByRole('heading', { name: 'Ordinary kept', exact: true }).waitFor();
    assert.equal(await page.locator('#engineName').textContent(), 'Ordinary engine');
    assert.equal(await page.getByRole('heading', { name: 'PRIVATE ADMIN NAVIGATION', exact: true }).count(), 0);
    assert.equal(await page.locator('#modeBtn').isVisible(), false);
});

test('browser and HTTP: publishing a new default leaves existing local data unchanged; reset fetches the new default', async t => {
    const fs = require('node:fs'), path = require('node:path'), bcrypt = require('bcrypt');
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const browser = await chromium.launch({ headless: true, channel: 'chrome' }); t.after(() => browser.close());
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8000);
    const requests = []; page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.goto(app.base); await page.locator('#app').waitFor({ state: 'visible' });
    const originalHeading = await page.locator('#grid h2').first().textContent();
    const login = await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const template = await (await app.request('/api/admin/default-homepage', { cookie })).json();
    template.config.categories[0].name = 'New published default';
    let response = await app.request('/api/admin/default-homepage/draft', { cookie, body: { config: template.config, revision: template.revision, operationId: 'browser-new-default' } });
    assert.equal(response.status, 200); const draft = await response.json();
    response = await app.request('/api/admin/default-homepage/publish', { cookie, body: { revision: draft.revision, publishedRevision: template.publishedRevision, operationId: 'browser-publish' } });
    assert.equal(response.status, 200);
    await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#grid h2').first().textContent(), originalHeading);
    const freshContext = await browser.newContext(); const fresh = await freshContext.newPage();
    await fresh.goto(app.base);
    await fresh.getByRole('heading', { name: 'New published default', exact: true }).waitFor();
    await freshContext.close();
    await page.locator('#localResetBtn').click();
    await page.locator('.ui-dialog [data-action="cancel"]').click();
    assert.equal(await page.locator('#grid h2').first().textContent(), originalHeading);
    await page.locator('#localResetBtn').click(); await submit(page); await saved(page);
    assert.equal(await page.locator('#grid h2').first().textContent(), 'New published default');
    assert.equal(requests.some(url => /^\/api\/(favorites|modules)/.test(url)), false);
    assert.equal((await app.request('/api/favorites')).status, 401);
    assert.equal((await app.request('/api/modules/config')).status, 401);
    await page.screenshot({ path: '/private/tmp/sylph-issue4-home.png', fullPage: true });
    await page.locator('#localSettingsBtn').click();
    await page.screenshot({ path: '/private/tmp/sylph-issue4-settings.png', fullPage: true });
});

test('browser: local settings keep actions visible and keyboard focus inside on narrow viewports', async t => {
    const { page } = await setup(t, { viewport: { width: 390, height: 844 } });
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        await page.locator('#localSettingsBtn').click();
        const button = page.locator('.ui-dialog button[type="submit"]');
        const rect = await button.boundingBox();
        assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport.height, 'confirmation must be in the visible viewport');
        await button.focus(); await page.keyboard.press('Tab');
        assert.equal(await page.locator('#localCurrentEngine').evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await button.evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Escape');
    }
});

test('browser: stale writes are rejected even without BroadcastChannel', async t => {
    const { page, context, app } = await setup(t);
    await context.addInitScript(() => { delete window.BroadcastChannel; });
    await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
    const other = await context.newPage(); other.setDefaultTimeout(8000);
    await other.goto(app.base); await other.locator('#app').waitFor({ state: 'visible' });
    await page.locator('#localSettingsBtn').click();
    await other.locator('#appearanceBtn').click(); await saved(other);
    await page.getByLabel('引擎 1 名称', { exact: true }).fill('Stale candidate');
    await submit(page);
    await page.locator('#localAdoptBtn').waitFor({ state: 'visible' });
    assert.match(await page.locator('#localNavigationStatus').textContent(), /其他标签页已修改/);
    await page.locator('#localAdoptBtn').click(); await submit(page); await saved(page);
    assert.notEqual(await page.locator('#engineName').textContent(), 'Stale candidate');
});

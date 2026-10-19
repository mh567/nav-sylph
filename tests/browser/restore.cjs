'use strict';
// Run with Playwright available in NODE_PATH: node --test tests/browser/restore.cjs
//
// #13 恢复的**浏览器**用例：真实浏览器 + 真实临时安装（真实 SQLite/文件）+ 本地 WebDAV 桩。
//
// 验的是界面这一层，而服务端的锁/快照/回滚已经在 tests/restore-http.test.js 用真实
// HTTP 验过。这里三条流程各自对应一条验收要求：
//  1. 备份 → 改数据 → 恢复：先看到「将恢复 / 将跳过」清单（含原因、体积、版本号），
//     确认后 reload，数据回到备份那一刻；
//  2. 旧备份（`type:'nav-sylph-backup'`）→ 醒目提示「只恢复书签」，且只恢复书签；
//  3. 恢复期间另一个浏览器上下文保存导航 → 503「正在执行另一项管理操作」+ 草稿保留
//     （用 WebDAV 桩的 GET 延迟撑开真实的持锁窗口，不是用 route 伪造响应）。
//
// ⚠️ 桩只实现 PROPFIND Depth:1 / GET / PUT / MKCOL / DELETE，与 tests/restore-http.test.js
// 那份等价。它是**内联在这里的局部函数**：helper 目录里没有 WebDAV 桩的公共模块，
// 而本轮改动范围不允许新增 tests/helpers/*，所以照抄一份。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { chromium } = require('playwright');
const { installation } = require('../helpers/installation');
const { openDatabase } = require('../../lib/db.js');
const { calculateChecksum } = require('../../lib/webdav-backup.js');

// helpers/installation.js 写的 admin123 不够强 → 会话是「必须改密」用途，requireAdmin 会拒。
const PASSWORD = 'StrongPass123!';
const FAV_MARKER = 'RESTORE-13 备份里的书签';
const LOCAL_MARKER = 'RESTORE-13 备份之后新加的书签';
const LEGACY_MARKER = 'RESTORE-13 旧备份里的书签';
const DRAFT_CATEGORY = 'RESTORE-13 未保存的草稿';

// ========== 本地 WebDAV 桩 ==========
function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createDavStub() {
    const files = new Map();
    const dirs = new Set(['/']);
    const stub = { delayMs: 0 };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const filePath = decodeURIComponent(url.pathname);
        // GET 是恢复流程里唯一有大段耗时的动作：加一个可控延迟，撑开「恢复进行中」的窗口。
        const later = fn => (stub.delayMs ? setTimeout(fn, stub.delayMs) : fn());
        if (files.has(filePath)) {
            if (req.method === 'GET') {
                return later(() => {
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                    res.end(files.get(filePath));
                });
            }
            if (req.method === 'DELETE') {
                files.delete(filePath);
                res.writeHead(204);
                res.end();
                return;
            }
        }
        if (req.method === 'MKCOL') {
            dirs.add(filePath.endsWith('/') ? filePath : filePath + '/');
            res.writeHead(201);
            res.end();
            return;
        }
        if (req.method === 'PUT') {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                files.set(filePath, Buffer.concat(chunks).toString('utf8'));
                dirs.add(filePath.slice(0, filePath.lastIndexOf('/') + 1));
                res.writeHead(201);
                res.end();
            });
            return;
        }
        if (req.method === 'PROPFIND') {
            const dir = filePath.endsWith('/') ? filePath : filePath + '/';
            if (dir !== '/' && !dirs.has(dir)) {
                res.writeHead(404);
                res.end();
                return;
            }
            let xml = '<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">\n';
            xml += `<d:response><d:href>${escapeXml(dir)}</d:href><d:propstat><d:prop>`
                + '<d:resourcetype><d:collection/></d:resourcetype>'
                + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>\n';
            for (const [name, content] of files) {
                if (!name.startsWith(dir)) continue;
                xml += `<d:response><d:href>${escapeXml(name)}</d:href><d:propstat><d:prop>`
                    + '<d:resourcetype/>'
                    + `<d:getcontentlength>${Buffer.byteLength(content, 'utf8')}</d:getcontentlength>`
                    + '<d:getlastmodified>Wed, 08 Oct 2026 00:00:00 GMT</d:getlastmodified>'
                    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>\n';
            }
            xml += '</d:multistatus>';
            res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
            res.end(xml);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return { files, dirs, server, stub };
}

async function startStub(t) {
    const dav = createDavStub();
    await new Promise(resolve => dav.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${dav.server.address().port}`;
    t.after(() => new Promise(resolve => dav.server.close(resolve)));
    return { ...dav, base };
}

// ========== 安装与种子数据 ==========

async function setup(t) {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'),
        JSON.stringify({ passwordHash: await bcrypt.hash(PASSWORD, 4) }));

    // 管理员导航/引擎：恢复**不得**触碰它们（旧备份的 config 域进 skip）。
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify({
        theme: 'dark',
        searchEngine: 'marker-engine',
        searchEngines: [{ id: 'marker-engine', name: 'ENGINE-13', url: 'https://search.test/?q=' }],
        categories: [{ id: 'c1', name: 'NAV-13', bookmarks: [{ id: 'b1', title: '导航项', url: 'https://nav.test/' }] }]
    }));

    fs.writeFileSync(path.join(app.dir, 'favorites.json'), JSON.stringify({
        version: 1,
        favorites: [{ id: 'fav1', title: FAV_MARKER, url: 'https://private.test/', category: '个人', private: true }]
    }));

    // 一台**没有本机令牌**的机器：它的凭据本来就不在备份里 → 恢复后「待授权」。
    // 这正是计划对话框那句「N 台机器的凭据无法解开」的来源。
    fs.writeFileSync(path.join(app.dir, '.modules.json'), JSON.stringify({
        version: 1,
        enabledModules: ['server-monitor'],
        widgets: [{ id: 'server-monitor', enabled: true, side: 'left', order: 0, collapsed: false }],
        servers: [{
            id: 'srv-nas', name: 'NAS-13', url: 'https://nas.test:8787', mode: 'push',
            certPem: '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----', deployState: 'ready'
        }],
        pollInterval: 30,
        _sync: { revision: 2, receipts: {} }
    }));

    // 备忘录与时间线：四域都在备份里，「将恢复」才能一次列全。
    // 时间线来源是 provider_type='x'（外部来源）→ 恢复后「待授权」。
    const db = openDatabase(path.join(app.dir, 'nav-sylph.db'));
    try {
        const now = Date.now();
        db.prepare('INSERT INTO memos (id, title, body, pinned, created_at, updated_at) VALUES (?,?,?,1,?,?)')
            .run('memo-1', 'RESTORE-13 备忘录', '正文', now, now);
        db.prepare(`INSERT INTO timeline_sources
            (id, provider_type, name, external_key, settings_json, enabled, sync_cursor,
             sync_interval_ms, next_sync_at, last_attempt_at, last_success_at, last_error, created_at, updated_at)
            VALUES ('src-1','x','X · alice','alice','{}',1,NULL,900000,NULL,NULL,NULL,NULL,?,?)`).run(now, now);
        db.prepare(`INSERT INTO timeline_events
            (id, source_id, event_type, provider_event_id, dedupe_key, occurred_at, ingested_at,
             author, title, summary, url, metadata_json)
            VALUES ('ev-1','src-1','social_post','p1','p1',?,?,'@alice','RESTORE-13 事件','摘要','https://x.test/p1','{}')`)
            .run(now, now);
    } finally {
        db.close();
    }

    await app.start();
    const dav = await startStub(t);
    const login = await app.request('/api/verify-password', { password: PASSWORD, body: {} });
    assert.equal(login.status, 200, '管理员登录');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const config = await app.request('/api/webdav/config', {
        cookie,
        body: {
            enabled: true, autoSync: false, url: dav.base,
            username: 'dav-user', password: 'dav-password', remotePath: '/backups/'
        }
    });
    assert.equal(config.status, 200, 'WebDAV 配置保存成功');

    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    t.after(() => browser.close());
    return { app, dav, cookie, browser };
}

/** 备份一次，返回列表里那一组手动备份（恢复要用它的文件名，不自己拼）。 */
async function backupOnce(app, cookie) {
    const backup = await (await app.request('/api/webdav/backup', { cookie, body: {} })).json();
    assert.equal(backup.success, true, JSON.stringify(backup));
    const listed = await (await app.request('/api/webdav/list', { cookie })).json();
    const group = listed.backups.find(entry => !entry.isAuto);
    assert.ok(group, '列表里有一组手动备份');
    return group;
}

// ========== 浏览器侧 ==========

async function page(browser, app, context = null) {
    const ctx = context || await browser.newContext();
    const p = await ctx.newPage();
    p.setDefaultTimeout(12000);
    await p.goto(app.base);
    await p.locator('#app').waitFor({ state: 'visible' });
    return p;
}

async function login(p) {
    await p.locator('#adminBtn').click();
    if (await p.locator('.ui-dialog input[type="password"]').count()) {
        await p.locator('.ui-dialog input[type="password"]').fill(PASSWORD);
        await p.locator('.ui-dialog button[type="submit"]').click();
    }
    await p.locator('#modal').waitFor({ state: 'visible' });
}

/** 进「账户与备份」→ 展开远程备份，等真配置画出来（`#webdavRestoreBtn` 就是哨兵）。 */
async function openWebdavSection(p) {
    await p.getByRole('tab', { name: '账户与备份' }).click();
    await p.locator('[aria-controls="webdavSection"]').click();
    await p.locator('#webdavRestoreBtn').waitFor({ state: 'visible' });
}

/** 打开备份列表，点第一个「恢复」，停在「选择恢复内容」（范围）对话框。 */
/**
 * 清单 → 范围对话框 → 预览 → 计划对话框。返回计划对话框的 Locator。
 *
 * 这条链路本身就是验收内容的一部分：点「恢复」先列清单，选完范围**才**发预览，
 * 预览回来才弹计划。任何一步被跳过，用户就会在没看清「会动什么」时按下覆盖。
 */
async function openPlanDialog(p) {
    await p.locator('#webdavRestoreBtn').click();
    await p.locator('#webdavRestoreDialog').waitFor({ state: 'visible' });
    await p.locator('#webdavRestoreDialog .webdav-restore-btn').first().click();
    await p.locator('#restoreOptionsDialog').waitFor({ state: 'visible' });
    const previewed = p.waitForResponse(response =>
        response.url().endsWith('/api/webdav/restore/preview') && response.request().method() === 'POST');
    await p.locator('#restoreOptionsConfirmBtn').click();
    assert.equal((await previewed).status(), 200, '确认范围之后才发预览');
    await p.locator('#restorePlanDialog').waitFor({ state: 'visible' });
    return p.locator('#restorePlanDialog');
}

/** 确认恢复 → 等「恢复完成」提示 → 点掉它（随后页面会 reload）。 */
async function confirmRestore(p) {
    await p.locator('#restorePlanConfirmBtn').click();
    const notice = p.locator('.ui-dialog').filter({ hasText: '恢复完成' });
    await notice.waitFor({ state: 'visible' });
    const text = await notice.innerText();
    await notice.locator('button[type="submit"]').click();
    return text;
}

const favorites = async (app, cookie) => (await (await app.request('/api/favorites', { cookie })).json()).favorites;

// ========== 1. 备份 → 改数据 → 预览 → 确认 → reload 后一致 ==========

test('browser: 恢复先出「将恢复/将跳过」清单，确认后 reload 数据回到备份那一刻', async t => {
    const { app, cookie, browser } = await setup(t);
    await backupOnce(app, cookie);

    // 破坏现场：把书签换成别的（这一步是「恢复确实覆盖了什么」的唯一凭据）
    const replaced = await app.request('/api/favorites', {
        cookie,
        body: { favorites: [{ id: 'local-1', title: LOCAL_MARKER, url: 'https://local.test/', category: '工作' }] }
    });
    assert.equal(replaced.status, 200, '本机书签被换掉');

    const p = await page(browser, app);
    await login(p);
    await openWebdavSection(p);
    const plan = await openPlanDialog(p);

    const text = await plan.innerText();
    // 副题：说清「拒绝写入」与「草稿不会被写回」——这两句是范围之外的用户承诺
    assert.match(text, /恢复期间受影响配置会暂时拒绝写入/);
    assert.match(text, /其他设备上的未保存草稿会被提示冲突，不会被写回/);

    // 「将恢复」：四个域都在，且带项数与体积
    const restoreItems = plan.locator('.webdav-plan-section').first().locator('.webdav-plan-item');
    assert.equal(await restoreItems.count(), 4, '四域都将恢复');
    const restoredText = await restoreItems.allInnerTexts();
    assert.ok(restoredText.some(line => line.includes('书签')), '清单里有书签');
    assert.ok(restoredText.some(line => line.includes('备忘录')), '清单里有备忘录');
    assert.ok(restoredText.some(line => line.includes('私人模块')), '清单里有私人模块');
    assert.ok(restoredText.some(line => line.includes('时间线')), '清单里有时间线');
    // 「版本 N → N+1」：恢复成功会递增受影响版本（旧基线就此失效）
    assert.match(text, /版本 \d+ → \d+/, '清单里写明版本递增');
    // 体积来自列表接口的远端文件大小
    assert.match(restoredText.join(' '), /\d+ (B|KB|MB)/, '清单里带每一域的体积');

    // 「将跳过」：至少派生域在，且**每条都有原因**
    const skipItems = plan.locator('.webdav-plan-skip .webdav-plan-item');
    assert.ok(await skipItems.count() >= 1, '有跳过项');
    for (const line of await skipItems.allInnerTexts()) {
        assert.ok(line.trim().split('\n').length >= 2 || line.includes('，'), `跳过项带原因：${line}`);
    }
    assert.match(await plan.locator('.webdav-plan-skip').innerText(), /派生数据|不含|不在/, '跳过原因用中文写清');

    // 凭据行：这台机器的凭据不随备份 → 「待授权 / 需要重新部署」
    const credentials = plan.locator('.webdav-plan-credentials');
    await credentials.waitFor({ state: 'visible' });
    const credentialsText = await credentials.innerText();
    assert.match(credentialsText, /1 台机器的凭据无法解开，恢复后显示待授权；0 台需要重新部署/);
    assert.match(credentialsText, /1 个 Special Line 来源需要重新填写凭据/);

    // 确认按钮是 danger 样式，文案点明「覆盖」
    const confirm = plan.locator('#restorePlanConfirmBtn');
    assert.equal(await confirm.textContent(), '恢复并覆盖这些配置');
    assert.ok((await confirm.getAttribute('class')).includes('btn-danger'), '确认按钮是危险样式');

    // 真正确认：服务端复验 planDigest 后应用，页面 reload
    const noticeText = await confirmRestore(p);
    assert.match(noticeText, /已恢复/);
    await p.waitForLoadState('load');
    await p.locator('#app').waitFor({ state: 'visible' });

    // reload 之后：数据就是备份那一刻（本机后加的那条不在了）
    const after = await favorites(app, cookie);
    assert.deepEqual(after.map(item => item.title), [FAV_MARKER]);
    // 界面上也看得见——不然「一致」只存在于接口里
    await login(p);
    await p.getByRole('tab', { name: '收藏夹' }).click();
    await p.locator('#favManagerHost').getByText(FAV_MARKER, { exact: false }).first().waitFor();
    assert.equal(await p.locator('#favManagerHost').getByText(LOCAL_MARKER, { exact: false }).count(), 0,
        '备份之后新加的书签不在界面上');
});

// ========== 2. 旧备份：醒目提示 + 只恢复书签 ==========

test('browser: 旧备份（nav-sylph-backup）醒目提示只恢复书签，导航与引擎一字未动', async t => {
    const { app, dav, cookie, browser } = await setup(t);
    const legacyData = {
        config: { theme: 'light', searchEngine: 'legacy-engine' },
        favorites: {
            version: 1,
            favorites: [{ id: 'legacy-fav', title: LEGACY_MARKER, url: 'https://legacy.test/', category: '旧分类' }]
        }
    };
    const legacyName = 'nav-sylph-backup-20200101-000000.json';
    // 远端目录要存在：桩的 PROPFIND Depth:1 对不存在的集合回 404，列表就成了「读失败」。
    dav.dirs.add('/backups/');
    dav.files.set(`/backups/${legacyName}`, JSON.stringify({
        type: 'nav-sylph-backup',
        version: 1,
        createdAt: '2020-01-01T00:00:00.000Z',
        appVersion: '1.0.0',
        data: legacyData,
        checksum: calculateChecksum(legacyData)
    }));

    const p = await page(browser, app);
    await login(p);
    await openWebdavSection(p);
    const plan = await openPlanDialog(p);

    // 醒目提示：这就是「为什么清单里只剩书签」的答案
    const legacy = plan.locator('.webdav-plan-legacy');
    await legacy.waitFor({ state: 'visible' });
    assert.match(await legacy.innerText(),
        /这是旧版备份：只恢复书签；导航与搜索引擎、站点默认模板不在本版恢复范围内。/);

    // 将恢复：只有书签
    const restoreItems = plan.locator('.webdav-plan-section').first().locator('.webdav-plan-item');
    assert.equal(await restoreItems.count(), 1, '旧备份只恢复一个域');
    assert.match(await restoreItems.first().innerText(), /书签/);

    // 将跳过：导航与搜索引擎那一域带原因
    const skipText = await plan.locator('.webdav-plan-skip').innerText();
    assert.match(skipText, /管理员导航与搜索引擎/, '导航/引擎进了跳过清单');

    await confirmRestore(p);
    await p.waitForLoadState('load');
    await p.locator('#app').waitFor({ state: 'visible' });

    // 书签回来了
    assert.deepEqual((await favorites(app, cookie)).map(item => item.title), [LEGACY_MARKER]);
    // 导航与引擎一字未动
    const nav = await (await app.request('/api/admin/navigation', { cookie })).json();
    assert.equal(nav.config.searchEngine, 'marker-engine', '搜索引擎没被旧备份改掉');
    assert.equal(nav.config.categories[0].name, 'NAV-13');
});

// ========== 3. 恢复期间另一方的保存被 503 拒掉，草稿保留 ==========

test('browser: 恢复持锁期间另一个上下文保存导航被 503 拒掉，文案说清且草稿保留', async t => {
    const { app, dav, cookie, browser } = await setup(t);
    await backupOnce(app, cookie);

    const first = await browser.newContext();
    const second = await browser.newContext();
    const a = await page(browser, app, first);
    const b = await page(browser, app, second);
    await login(a);
    await login(b);

    // b：进入编辑态并加一个分类（**不保存** → 这是一份未保存草稿）
    await b.getByRole('tab', { name: '首页导航' }).click();
    await b.locator('#cancelBtn').click();
    await b.locator('#modal').waitFor({ state: 'hidden' });
    await b.locator('#layoutBtn').click();
    await b.getByRole('button', { name: '＋ 添加分类', exact: true }).click();
    await b.locator('.ui-dialog input').fill(DRAFT_CATEGORY);
    await b.locator('.ui-dialog button[type="submit"]').click();
    await b.getByRole('heading', { name: DRAFT_CATEGORY, exact: true }).waitFor();

    // a：走到计划对话框。桩的 GET 延迟把持锁窗口撑到 ~2.5 秒（真实持锁，不伪造响应）
    dav.stub.delayMs = 500;
    await openWebdavSection(a);
    const plan = await openPlanDialog(a);

    const restoreRequest = a.waitForRequest(request => request.url().endsWith('/api/webdav/restore'));
    await plan.locator('#restorePlanConfirmBtn').click();
    await restoreRequest;

    // 抢在恢复持锁期间让 b 保存：此刻 requireSession 对所有管理写都 503 busy
    const busyResponse = b.waitForResponse(response =>
        response.url().endsWith('/api/admin/navigation')
        && response.request().method() === 'POST'
        && response.status() === 503);
    await b.locator('#localDoneBtn').click();
    const busy = await busyResponse;
    assert.equal((await busy.json()).code, 'busy', '被协调锁拒掉');

    // 文案说清「正在执行另一项管理操作」，不是笼统的「保存失败」
    await b.waitForFunction(() => {
        const toast = document.querySelector('#toast');
        return toast && !toast.hidden && /正在执行另一项管理操作，请稍后再试/.test(toast.textContent);
    }, null, { timeout: 8000 });
    const toastText = await b.locator('#toast').textContent();
    assert.match(toastText, /草稿已保留/, '草稿保留这句话必须在');

    // 草稿确实还在（编辑态没有被退出、分类还在界面上）
    await b.getByRole('heading', { name: DRAFT_CATEGORY, exact: true }).waitFor();
    // 而且没有被写进服务器：a 的恢复成功之后，服务器上的导航仍是备份前那份
    await a.locator('.ui-dialog').filter({ hasText: '恢复完成' }).waitFor({ state: 'visible', timeout: 15000 });
    const nav = await (await app.request('/api/admin/navigation', { cookie })).json();
    assert.ok(!nav.config.categories.some(category => category.name === DRAFT_CATEGORY),
        '被拒的那次保存没有落地');
});

// ========== 4. 三个失败分支的文案各自成立 ==========

test('browser: 恢复失败按码给不同文案——409 请重新预览 / 503 busy / 503 halted', async t => {
    const { app, cookie, browser } = await setup(t);
    await backupOnce(app, cookie);

    const p = await page(browser, app);
    await login(p);
    await openWebdavSection(p);
    let plan = await openPlanDialog(p);
    const error = plan.locator('#restorePlanError');

    // 这三个码的**服务端**语义由 tests/restore-http.test.js 与 tests/restore-recovery.test.js 用真实
    // HTTP + 真实库证明；这里要验的是界面对每个码是否给出各自的话与各自的下一步，
    // 所以用 route 直接把服务端响应摆成那三种（构造真实持锁窗口另有第三条用例）。
    const failWith = async (status, body) => {
        await p.route(url => url.pathname === '/api/webdav/restore', route => route.fulfill({
            status, contentType: 'application/json', body: JSON.stringify(body)
        }));
    };

    // 409 stale_plan：不是「操作错了」，而是「计划过期了」——主按钮置灰，另给「重新预览」
    await failWith(409, { error: '备份内容或本机状态已改变，请重新预览后再恢复', code: 'stale_plan' });
    await plan.locator('#restorePlanConfirmBtn').click();
    await error.waitFor({ state: 'visible' });
    assert.match(await error.innerText(), /备份内容已变化，请重新预览/);
    assert.equal(await plan.locator('#restorePlanConfirmBtn').isDisabled(), true, '过期计划不能再点覆盖');
    await p.unrouteAll({ behavior: 'wait' });

    // 「重新预览」真的重新发一次预览，并把对话框换回一份新计划
    const repreviewed = p.waitForResponse(response =>
        response.url().endsWith('/api/webdav/restore/preview') && response.request().method() === 'POST');
    await plan.locator('#restorePlanRepreviewBtn').click();
    assert.equal((await repreviewed).status(), 200, '点了就重新预览');
    plan = p.locator('#restorePlanDialog');
    await plan.waitFor({ state: 'visible' });
    assert.equal(await plan.locator('.webdav-plan-section').first().locator('.webdav-plan-item').count(), 4,
        '新计划照旧列出四域');

    // 503 busy：另一项管理操作正在跑，等一会儿再点
    await failWith(503, { error: '正在恢复备份，请稍后重试', code: 'busy' });
    await plan.locator('#restorePlanConfirmBtn').click();
    await plan.locator('#restorePlanError').waitFor({ state: 'visible' });
    assert.match(await plan.locator('#restorePlanError').innerText(), /正在执行另一项管理操作，请稍后再试/);
    assert.equal(await plan.locator('#restorePlanConfirmBtn').isDisabled(), false, 'busy 可以原样重试');
    assert.equal(await plan.locator('#restorePlanConfirmBtn').textContent(), '恢复并覆盖这些配置');
    await p.unrouteAll({ behavior: 'wait' });

    // 503 restore_halted：上一次恢复没走完，受影响配置已暂停——再点一次没有意义
    await failWith(503, { error: '恢复失败且回滚未完成，受影响功能已暂停', code: 'restore_halted' });
    await plan.locator('#restorePlanConfirmBtn').click();
    await p.waitForFunction(() => /上一次恢复未完成，受影响配置已暂停/.test(
        document.querySelector('#restorePlanError')?.textContent || ''), null, { timeout: 8000 });
    await p.unrouteAll({ behavior: 'wait' });

    // 对话框一直开着，取消随时可走：失败不该把用户关在模态里
    await plan.locator('#restorePlanCancelBtn').click();
    await p.locator('#restorePlanDialog').waitFor({ state: 'detached' });
});

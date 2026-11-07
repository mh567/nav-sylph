'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const schema = require('../public/navigation-schema');
const config = { theme: 'auto', showBookmarkIcons: true, searchEngine: 'one', searchEngines: [{ id: 'one', name: 'Search', url: 'https://example.com/?q=' }], categories: [] };

/** 按大括号配对切出某个 @supports / @media 块的正文。 */
function blockBody(css, header) {
    const start = css.indexOf(header);
    assert.ok(start >= 0, `样式表里存在 ${header}`);
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') { depth--; if (!depth) return css.slice(open + 1, i); }
    }
    throw new Error(`${header} 的块没有闭合`);
}

test('themes: 浏览器没有背景模糊时，内容面板仍保留透明薄膜而不是退回实心板', () => {
    // 这条盯的是 Windows 上的真实故障：Firefox 123 之前在「GPU 厂商识别不出来」的
    // 机器上不提供 backdrop-filter（MDN 引 bug 1868737），Windows 的虚拟机与部分
    // 驱动正落在这类机器上。此前那条兜底把分类板与模块板一起换成不透明实底，
    // 整页退回 v2.2.5 那种「死板生硬」的底板——用户点名要换掉的正是它。
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'themes.css'), 'utf8');
    const noBlur = blockBody(css, '@supports not ((backdrop-filter: blur(1px))');
    assert.doesNotMatch(noBlur, /\.category/, '没有背景模糊时不得把分类板换成不透明实底');
    assert.doesNotMatch(noBlur, /\.module-widget/, '没有背景模糊时不得把模块卡换成不透明实底');
    assert.doesNotMatch(noBlur, /::after/, '没有背景模糊时光学薄边要留着，它是这套材质的主要标识');
    // 真正需要实底的是盖在任意内容上的浮层：它们失去模糊后必须不透明才读得清。
    for (const selector of ['.modal-content', '.ui-dialog', '.engine-dropdown', '.fav-dropdown', '.toast']) {
        assert.match(noBlur, new RegExp(selector.replace('.', '\\.')), `浮层 ${selector} 仍需不透明底`);
    }

    // 「减少透明度」是用户明确要求的少透明，那条路必须走不透明底，且与上面的兜底分开。
    const reduced = blockBody(css, '@media (prefers-reduced-transparency: reduce)');
    assert.match(reduced, /\.category/, '明确要求少透明时分类板回退为不透明');
    assert.match(reduced, /\.module-widget/, '明确要求少透明时模块卡回退为不透明');
});

test('themes: legacy configuration stays valid; registered styles survive public projection', () => {
    assert.deepEqual(schema.validate(structuredClone(config)), config);
    const prism = { ...config, themeStyle: 'prism' };
    assert.deepEqual(schema.validate(schema.publicConfig(prism)), prism);
    assert.throws(() => schema.validate({ ...config, themeStyle: 'unknown' }), /主题/);
    assert.throws(() => schema.validate({ ...config, themeStyle: { id: 'prism' } }), /主题/);
});

test('themes: fixed dark style preserves the saved classic mode', () => {
    assert.deepEqual(schema.appearance({ ...config, themeStyle: 'prism' }), { style: 'prism', mode: 'dark' });
    assert.deepEqual(schema.appearance(config), { style: 'prism', mode: 'dark' });
    assert.deepEqual(schema.appearance({ ...config, themeStyle: 'classic', theme: 'light' }), { style: 'classic', mode: 'light' });
});

test('themes: personal and published styles persist through real HTTP writes and restart', async t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const bcrypt = require('bcrypt');
    const { installation } = require('./helpers/installation');
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const login = await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const personal = await (await app.request('/api/admin/navigation', { cookie })).json();
    const prism = { ...personal.config, themeStyle: 'prism', theme: 'light' };
    assert.equal((await app.request('/api/admin/navigation', { cookie, body: { config: prism, revision: personal.revision, operationId: 'theme-personal' } })).status, 200);
    assert.equal((await (await app.request('/api/config')).json()).themeStyle, 'prism');
    const draft = await (await app.request('/api/admin/default-homepage', { cookie })).json();
    const saved = await (await app.request('/api/admin/default-homepage/draft', { cookie, body: { config: { ...draft.config, themeStyle: 'prism' }, revision: draft.revision, operationId: 'theme-draft' } })).json();
    assert.equal((await app.request('/api/admin/default-homepage/publish', { cookie, body: { revision: saved.revision, publishedRevision: draft.publishedRevision, operationId: 'theme-publish' } })).status, 200);
    await app.stop();
    await app.start();
    assert.equal((await (await app.request('/api/config')).json()).themeStyle, 'prism');
    const persisted = await (await app.request('/api/admin/navigation', { cookie })).json();
    assert.equal(persisted.config.themeStyle, 'prism');
    assert.equal(persisted.config.theme, 'light');
    const share = await (await app.request('/p/tiger-482')).text();
    assert.match(share, /data-theme-style="prism" data-theme="dark"/);
    assert.match(share, /href="\/themes.css"/);
});


test('themes: explicit classic installation remains classic after default changes and restart', async t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { installation } = require('./helpers/installation');
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify({ ...config, themeStyle: 'classic', theme: 'light' }));
    await app.start();
    const first = await (await app.request('/api/config')).json();
    assert.equal(first.themeStyle, 'classic');
    assert.deepEqual(schema.appearance(first), { style: 'classic', mode: 'light' });
    await app.stop();
    await app.start();
    assert.equal((await (await app.request('/api/config')).json()).themeStyle, 'classic');
});

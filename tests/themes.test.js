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

test('themes: 棱镜的选中态用白面加深色标记，不靠白底压白标', () => {
    // 棱镜的 --accent 是近白色，而这两处控件的「选中」标记也是白的：
    // 后台的模块开关（轨道 = --accent、旋钮 = 近白薄膜）与备忘待办的勾选框
    // （底色 = --accent、勾 = #fff）。白压白 = 状态整个看不见。
    // 棱镜里「选中」的控件一律是**白面 + 深色标记**——原生 checkbox 就是这么画的
    // （accent 填白、勾自动取对比色），照它来；经典主题的 accent 是陶土色，不受影响。
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'themes.css'), 'utf8');
    const knob = /\.toggle-switch input:checked \+ \.toggle-slider::before\s*\{([^}]*)\}/.exec(css);
    assert.ok(knob, '棱镜给「开」态的旋钮单独定了样式');
    assert.match(knob[1], /background:[^;}]*#(?:1f2932|33404a)/i, '开态旋钮是深色（白轨上的深色挖空）');
    const track = /\.toggle-switch input:checked \+ \.toggle-slider\s*\{([^}]*)\}/.exec(css);
    assert.ok(track, '棱镜给「开」态的轨道单独定了样式');
    assert.match(track[1], /background:[^;}]*#ffffff/i, '开态轨道是白面');
    const todo = /\.memo-todo-check:checked\s*\{([^}]*)\}/.exec(css);
    assert.ok(todo, '棱镜给待办勾选框的选中态单独定了样式');
    assert.match(todo[1], /background:[^;}]*#ffffff/i, '待办选中底是白面');
    const mark = /\.memo-todo-check-wrap::after\s*\{([^}]*)\}/.exec(css);
    assert.ok(mark, '棱镜给勾号单独定了颜色');
    assert.match(mark[1], /background:\s*#1b232b/i, '勾号是深色，压在白底上才看得见');
});

test('themes: 棱镜滚动不做经典主题没有的逐帧重绘', () => {
    // 用户报告 Windows 上棱镜上下滚动掉帧、经典主题正常。实测一次 41 帧滚动：
    // 棱镜 PictureLayer::Update 328 次，经典 164 次。两处棱镜独有开销：
    // ① 分类板/模块板的 backdrop-filter 要在每帧重新采样背景；
    // ② background-attachment: fixed 让整屏环境光逐帧重绘。
    // 两处都去掉后棱镜为 164 次，与经典持平。
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'themes.css'), 'utf8');
    // 先剥注释：下面禁止的写法在解释性注释里被原样引用，否则反例断言会匹配到自己。
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

    const prismBody = /:root\[data-theme-style="prism"\] body\s*\{([^}]*)\}/.exec(noComments);
    assert.ok(prismBody, '棱镜 body 规则存在');
    assert.doesNotMatch(prismBody[1], /background-attachment:\s*fixed/,
        '环境光随文档滚动，不用会逐帧重绘的固定背景');
    assert.match(prismBody[1], /radial-gradient/, '环境光本身仍在');

    const card = /:root\[data-theme-style="prism"\] :is\(\.category,\.module-widget\)\s*\{([^}]*)\}/.exec(noComments);
    assert.ok(card, '棱镜分类板/模块板规则存在');
    assert.doesNotMatch(card[1], /backdrop-filter/,
        '分类板与模块板不做逐帧背景模糊');
    assert.match(card[1], /background:\s*var\(--prism-slab\)/, '薄膜底色与光学薄边保留');

    // 浮层是静止且短暂的，保留模糊的视觉收益明确，不属于滚动热路径。
    assert.match(noComments, /\.help-content[^}]*backdrop-filter/, '浮层仍保留背景模糊');
});

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
    // 但不能把面板压成一整块平涂的 --bg-card——那是 v2.2.5 那种死板底板，
    // Windows 上「透明度效果」一关整页就退成另一个主题。正确做法是换 token：
    // 同样的冷调色偏、反射、光学薄边、圆角与投影全部保留，只是不再透过去。
    const reduced = blockBody(css, '@media (prefers-reduced-transparency: reduce)');
    // 只把**底色**换成不透明：冷调色偏与反射那几层渐变必须留着。
    // 只断言「不透明」不够——写成纯色 #27323b 同样是「不透明」，那正是要挡掉的平涂板。
    assert.match(reduced, /--prism-slab:[^;]*radial-gradient[^;]*#27323b/,
        '少透明时分类板保留冷调色偏，只把底色换成不透明');
    assert.match(reduced, /--prism-pill:[^;]*linear-gradient[^;]*#202b34/,
        '少透明时胶囊控件保留反光渐变，只把底色换成不透明');
    assert.match(reduced, /--glass-strong:\s*#253039/, '少透明时浮层换不透明底');
    assert.doesNotMatch(reduced, /::after[^}]*display:\s*none/, '少透明时光学薄边要留着，它是这套材质的标识');
    assert.doesNotMatch(reduced, /:is\([^)]*\.category[^)]*\)[^}]*background:\s*var\(--bg-card\)/,
        '少透明时不得把分类板直接压成平涂的 --bg-card');
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

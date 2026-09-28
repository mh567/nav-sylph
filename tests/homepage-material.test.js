const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public/styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');

// 剥掉整行注释与块注释。源码形状断言曾因 `/* (reverted) .app.set(...) */`
// 这类「注释里提到了标识符」的写法而假绿。
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// 本组断言只看文件尾部的「2026 材质层」。文件前 2546 行是旧样式，
// 里面同名选择器的旧声明（.bookmarks 的 120px、.search-engine 的裸底色等）
// 会让「取第一个匹配」读到错误的块——那正是要防的静默覆盖事故，
// 但断言的对象是材质层本身，所以先切出这一段再剥注释。
const LAYER_MARKER = '/* 2026 front-end material and interaction layer */';
const layerStart = stylesCss.indexOf(LAYER_MARKER);
assert.ok(layerStart > 0, 'styles.css 仍带有 2026 材质层标记');
const code = stripComments(stylesCss.slice(layerStart));

// 取某个 @media 块的正文。同一查询在文件里可能出现多次，
// requiredIn 指定目标块必须包含的标记，否则返回第一个同查询块。
function mediaBlocks(css, query) {
    const blocks = [];
    let searchFrom = 0;
    for (;;) {
        const start = css.indexOf(query, searchFrom);
        if (start === -1) break;
        const open = css.indexOf('{', start);
        let depth = 0;
        for (let i = open; i < css.length; i++) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') {
                depth--;
                if (depth === 0) { blocks.push(css.slice(open + 1, i)); searchFrom = i; break; }
            }
        }
    }
    return blocks;
}

function mediaBlock(css, query, requiredIn) {
    const blocks = mediaBlocks(css, query);
    assert.ok(blocks.length > 0, `样式表里存在 ${query}`);
    if (!requiredIn) return blocks[0];
    const match = blocks.find(body => body.includes(requiredIn));
    assert.ok(match, `${query} 中存在包含 ${requiredIn} 的块（共 ${blocks.length} 个同查询块）`);
    return match;
}

// 取某个选择器的块正文。同一选择器在降级块（@supports / reduced-transparency）
// 里还会出现，取第一个会读到降级值而非基础值，所以用 requiredIn 定位。
function ruleBlock(css, selector, requiredIn) {
    const blocks = mediaBlocks(css, selector + ' {').concat(mediaBlocks(css, selector + ','));
    const candidates = blocks.map(b => b.replace(/^[\s\S]*?\{/, ''));
    if (!requiredIn) return candidates[0];
    const match = candidates.find(body => body.includes(requiredIn));
    assert.ok(match, `${selector} 中存在包含 ${requiredIn} 的块（共 ${candidates.length} 个同选择器块）`);
    return match;
}

test('快捷键说明行只在桌面出现', () => {
    const base = ruleBlock(code, '.search-caption', 'justify-content');
    assert.match(base, /display:\s*flex/, '桌面端用 flex 居中排布两段提示');
    assert.equal(/display:\s*none/.test(base), false, '基础规则不应隐藏说明行');

    const narrow = mediaBlock(code, '@media (max-width: 600px)', '.search-caption');
    assert.match(narrow, /\.search-caption\s*\{[^}]*display:\s*none/, '≤600px 必须隐藏（手机没有物理键盘）');

    // 源码顺序即层叠顺序：基础规则排在 600px 块之后时，
    // 同特异性的 display:flex 会把块里的 display:none 压掉，
    // 表现是手机上说明行照样显示。这类问题单看两条规则都「有」，
    // 只有断言相对位置才抓得住。
    const baseIdx = code.indexOf('.search-caption { display: flex');
    const blockIdx = code.indexOf('@media (max-width: 600px)', code.indexOf('.search-caption { display: flex') - 200);
    assert.ok(baseIdx > -1, '找到说明行基础规则');
    assert.ok(baseIdx < blockIdx, '基础规则必须排在 ≤600px 块之前，否则移动端隐藏会被覆盖');
});

test('三个搜索按钮的色相锚点各自只定义一次', () => {
    for (const name of ['--mode-hue', '--engine-hue', '--submit-hue', '--ctl-h', '--ctl-press-shadow']) {
        const defs = code.match(new RegExp(`${name}\\s*:`, 'g')) || [];
        assert.equal(defs.length, 3, `${name} 必须在 :root、prefers-color-scheme:dark、data-theme="dark" 三处各定义一次，实际 ${defs.length}`);
    }
});

test('深色块的三色锚点逐字一致，避免手动深色与系统深色分叉', () => {
    const values = s => (s.match(/--(?:mode|engine|submit)-hue:\s*[\d,]+/g) || []).join('|');
    // 按标记定位到真正承载三色锚点的那个块：文件里同选择器有十三个，
    // 只有材质层的这一个带 --mode-hue
    const systemDark = mediaBlock(code, ':root:not([data-theme="light"])', '--mode-hue');
    const forcedDark = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(code);
    assert.ok(forcedDark, '存在 :root[data-theme="dark"] 块');
    assert.ok(values(systemDark), 'prefers-color-scheme 块里读到三色锚点');
    assert.ok(values(forcedDark[1]), 'data-theme 块里读到三色锚点');
    assert.equal(values(systemDark), values(forcedDark[1]), '两个深色块的三色锚点必须逐字相同');
});

test('搜索栏三按钮在材质层里各只被声明一次', () => {
    // 只数顶部层（行首无缩进）的块声明：@media 里的覆盖不算，
    // 否则合法的窄屏覆写会让断言对着正确代码失败。
    for (const sel of ['.search-mode', '.search-engine', '.search-btn']) {
        const exact = code.match(new RegExp(`^${sel.replace('.', '\\.')}\\s*\\{`, 'gm')) || [];
        assert.equal(exact.length, 1, `${sel} 的基础块应只声明一次，实际 ${exact.length}`);
    }
    // 组合声明那一行只应出现一次（三者共用同一套结构）
    const shared = code.match(/^\.search-mode\s*,\s*\.search-engine\s*,\s*\.search-btn\s*\{/gm) || [];
    assert.equal(shared.length, 1, `三按钮的组合基础块应只声明一次，实际 ${shared.length}`);
});

test('按钮的点击凹陷比书签更深，且过渡更短', () => {
    const pressShadow = /--ctl-press-shadow:\s*([^;]+);/.exec(code);
    assert.ok(pressShadow, '定义了 --ctl-press-shadow');
    const inset = /inset 0 (\d+)px (\d+)px/.exec(pressShadow[1]);
    assert.ok(inset, '按压阴影用 inset');

    const bookmarkPress = /--bookmark-press-shadow:\s*([^;]+);/.exec(code);
    const bmInset = /inset 0 (\d+)px (\d+)px/.exec(bookmarkPress[1]);
    assert.ok(Number(inset[1]) > Number(bmInset[1]), `按钮凹陷 ${inset[1]}px 应深于书签 ${bmInset[1]}px`);

    const motion = /--ctl-press-motion:\s*(\d+)ms/.exec(code);
    const bmMotion = /--bookmark-press-motion:\s*(\d+)ms/.exec(code);
    assert.ok(Number(motion[1]) <= Number(bmMotion[1]), `按钮按压过渡 ${motion[1]}ms 应不慢于书签 ${bmMotion[1]}ms`);
});

test('模式按钮的选中态用外投影，不与点击凹陷共用 inset', () => {
    const pressed = /\.search-mode\[aria-pressed="true"\]\s*\{([^}]*)\}/.exec(code);
    assert.ok(pressed, '存在 [aria-pressed="true"] 规则');
    const shadows = pressed[1].match(/inset 0 \d+px \d+px/g) || [];
    assert.equal(shadows.length, 0, `选中态不应有整段 inset 阴影（会与 :active 凹陷撞语义），实际 ${shadows.join('; ')}`);
    assert.match(pressed[1], /0 \d+px \d+px/, '选中态应有外投影，表达「点亮」而非「凹陷」');
});

test('书签尺寸未被这次光影改动带偏', () => {
    // 本次只换光影，列宽与高度必须原样保留
    const grid = /^\.bookmarks\s*\{([^}]*)\}/m.exec(code);
    assert.ok(grid, '.bookmarks 有基础规则');
    const columns = /grid-template-columns:\s*repeat\(auto-fill,\s*96px\)/.exec(grid[1]);
    assert.ok(columns, '桌面列宽仍是 96px');

    const card = /^\.bookmark,\s*\.bookmark-text-only\s*\{([^}]*)\}/m.exec(code);
    assert.ok(card, '.bookmark 有基础规则');
    assert.match(card[1], /min-height:\s*42px/, '书签高度仍是 42px');
    assert.match(card[1], /border-radius:\s*7px/, '圆角仍是 7px');
});

test('宽屏背板在窄屏完全退回透明容器', () => {
    // 降级块（@supports、prefers-reduced-transparency）里也有 .backboard，
    // 取第一个会读到 background: var(--bg-card)——那是降级值不是基础值
    const base = ruleBlock(code, '.backboard', 'width:');
    assert.match(base, /width:\s*min\(100%,\s*936px\)/, '宽屏收束到 936px');
    assert.match(base, /backdrop-filter/, '宽屏使用毛玻璃');

    // 单一来源：≤1023px 的兜底只能有一条，否则后写的会静默覆盖前一条
    const fallbacks = mediaBlocks(code, '@media (max-width: 1023px)');
    assert.equal(fallbacks.length, 1, `≤1023px 兜底块应只有一条，实际 ${fallbacks.length}`);
    const fb = fallbacks[0];
    assert.match(fb, /\.backboard\s*\{[^}]*background:\s*none/, '窄屏背板不填充');
    assert.match(fb, /\.backboard\s*\{[^}]*box-shadow:\s*none/, '窄屏背板无投影');
    assert.match(fb, /\.backboard\s*\{[^}]*padding:\s*0/, '窄屏背板无内边距');
    assert.match(fb, /\.backboard::before\s*,\s*\.backboard::after\s*\{[^}]*display:\s*none/, '窄屏隐藏高光与发丝线');
});

test('站点标识已从标记与样式中一并移除', () => {
    assert.equal(/class="site-identity"/.test(indexHtml), false, 'index.html 不应再有 .site-identity');
    assert.equal(/site-identity/.test(code), false, 'styles.css 不应再有 .site-identity 规则');
});

test('主操作按钮在网页态与收藏态是同一种材质', () => {
    // 旧样式里有 `.search.fav-search-mode .search-btn { background:#f59e0b }`，
    // 特异性 (0,3,0) 压过 (0,1,0) 的 .search-btn，把实心陶土换成琥珀底。
    // 截图才看得出来，源码形状断言负责钉住它不再出现。
    // 匹配前必须剥注释：解释这条历史问题的注释里就写着 #f59e0b，
    // 不剥的话断言会把自己的说明当成违规规则。
    const amber = /\.search\.fav-search-mode\s+\.search-btn\s*\{[^}]*#f59e0b/.test(
        stylesCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''));
    assert.equal(amber, false, '收藏态不再覆写主按钮底色（琥珀底会盖掉实心陶土）');
});

test('背板包住搜索区与收藏网格，操作条留在外面', () => {
    const board = /<div class="backboard">([\s\S]*?)<nav class="utility-dock"/.exec(indexHtml);
    assert.ok(board, '背板包裹层应存在并终止于 .utility-dock 之前');
    assert.match(board[1], /<header class="header">/, '背板内含 header');
    assert.match(board[1], /<main class="grid" id="grid">/, '背板内含收藏网格');
    // 光感与按压都按 ID 委托在这两个容器上，包裹不能改变它们的祖先结构
    assert.match(indexHtml, /<form class="search" id="searchForm">[\s\S]*?<textarea[^>]*id="searchInput"/, 'searchInput 仍嵌套在 searchForm 内');
    assert.match(indexHtml, /<div class="engine-dropdown" id="engineDropdown"[\s\S]*?<\/div>\s*<\/div>\s*<\/header>/, '引擎下拉仍是 .search-wrapper 的子节点，绝对定位锚点才不位移');
});

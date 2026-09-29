const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public/styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');

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
// 有些选择器的基础块在材质层之前的旧样式区（如 .engine-dropdown 在 166 行），
// 只切材质层会找不到它们，这类断言用全文件去注释后的版本。
const fullCode = stripComments(stylesCss);

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

test('按钮按下有可见的按键行程', () => {
    // 只靠内阴影的「凹陷」读起来像贴纸在变暗，缺少离开平面的实感。
    // 2px 位移 + .985 缩放才有琴键被按下去的行程；1px 几乎看不出来。
    const active = /^\.search-mode:active,\.search-engine:active,\.search-btn:active\s*\{([^}]*)\}/m.exec(code);
    assert.ok(active, '存在三按钮共用的 :active 规则');
    const t = /transform:\s*translateY\((\d+)px\)\s*scale\(([\d.]+)\)/.exec(active[1]);
    assert.ok(t, '按下态应为 translateY + scale 组合');
    assert.ok(Number(t[1]) >= 2, `按键行程至少 2px，当前 ${t[1]}px（1px 视觉上几乎读不出来）`);
    // 缩放不能吃掉触摸目标：44px × .985 ≈ 43.3px，仍高于 40px
    const scale = Number(t[2]);
    assert.ok(scale >= 0.98 && scale < 1, `缩放应在 [.98, 1) 之间，当前 ${scale}`);
    assert.ok(44 * scale >= 40, `缩放后高度 ${(44 * scale).toFixed(1)}px 不应低于 40px`);
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

test('引擎按钮带下拉箭头，并在展开时翻转', () => {
    // 箭头是引擎按钮可点开的唯一视觉线索。曾整块丢失：
    // 标记里没有 <svg>，而 .engine-arrow 的旧样式还留着，成为死代码。
    assert.match(indexHtml, /class="search-engine"[\s\S]*?class="engine-arrow"/,
        '引擎按钮内应有 .engine-arrow 箭头');

    const arrow = ruleBlock(code, '.engine-arrow', 'stroke-width');
    assert.match(arrow, /stroke-width/, '箭头用描边绘制');
    assert.match(arrow, /stroke:\s*currentColor/, '箭头跟随按钮文字色');

    // 展开态的驱动钩子统一为 aria-expanded。JS（app.js:314）其实两个都设，
    // 所以旧的那条 `.search-engine.active .engine-arrow` 是能命中的——
    // 删它是因为同一状态两条规则会各自旋转一次，不是因为不命中。
    const expanded = /\.search-engine\[aria-expanded="true"\]\s+\.engine-arrow\s*\{([^}]*)\}/.exec(code);
    assert.ok(expanded, '存在展开态的箭头翻转规则');
    assert.match(expanded[1], /rotate\(180deg\)/, '展开时箭头翻转');
    // 同一状态只能有一条旋转规则，否则两条会叠乘
    assert.equal(/\.search-engine\.active\s+\.engine-arrow/.test(code), false,
        '不应再有 .search-engine.active 驱动的第二处箭头旋转');

    // 同一选择器的基础块只能有一处定义，否则同特异性下后写的会静默覆盖。
    // 只数行首无缩进的块：`.search-engine:hover .engine-arrow {` 这类派生规则不算。
    const sites = code.match(/^\.engine-arrow\s*\{/gm) || [];
    assert.equal(sites.length, 1, `.engine-arrow 基础块应只定义一次，实际 ${sites.length}`);
});

test('搜索按钮按下态显式设置边框色', () => {
    // 指针按下时仍停在按钮上，:hover 依然命中。若 :active 不写 border-color，
    // 悬停时的浅色描边会保留在深色实心底上，凹陷读不出来。
    const active = /^\.search-btn:active\s*\{([^}]*)\}/m.exec(code);
    assert.ok(active, '存在 .search-btn:active 规则');
    assert.match(active[1], /border-color:\s*rgba\(var\(--submit-hue\)/,
        '按下态必须自己给 border-color，不能依赖 :hover 的浅色描边');
});

test('搜索按钮实心填充的中间停靠点与仿真一致', () => {
    // 仿真用 #71513f（它的 --primary）；移植时误用了 --accent-hover (#79503f)，
    // 语义与取值都不对——--accent-hover 是悬停色，不是常态底色。
    const btn = /^\.search-btn\s*\{([^}]*)\}/m.exec(code);
    assert.ok(btn, '存在 .search-btn 基础规则');
    assert.match(btn[1], /linear-gradient\(172deg,#85604e,#71513f 58%,#66483a\)/,
        '三档渐变与仿真逐字一致，中间档不得改用 --accent-hover');
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

test('说明行只讲 / 与 > 两个触发符', () => {
    const cap = /<div class="search-caption"[^>]*>([\s\S]*?)<\/div>/.exec(indexHtml);
    assert.ok(cap, 'index.html 里有说明行');
    const text = cap[1];
    assert.match(text, /<kbd>\/<\/kbd>/, '说明行要点出 / 这个收藏触发符');
    assert.match(text, /<kbd>&gt;<\/kbd>/, '说明行要点出 > 这个分享触发符');
    // 次要功能（方向键选择、Enter 打开）不在这行强调，细节留给「说明」弹窗
    for (const noise of ['Enter', '↑', '↓']) {
        assert.equal(text.includes(noise), false, `说明行不应再出现 ${noise}（次要功能留给说明弹窗）`);
    }
});

test('说明行贴搜索框、远离收藏区', () => {
    const cap = ruleBlock(code, '.search-caption', 'justify-content');
    const m = /margin:\s*(\d+)px\s+0\s+(\d+)px/.exec(cap);
    assert.ok(m, '说明行用 margin: 上 0 下 的形式给出上下间距');
    const [top, bottom] = [Number(m[1]), Number(m[2])];
    assert.ok(top < bottom, `说明行上间距 ${top}px 应小于下间距 ${bottom}px（贴搜索框、远离收藏区）`);

    // 间距归说明行自己管，.header 的 margin-bottom 必须让位，
    // 否则两者折叠后取大值，说明行会被推离搜索框。
    const header = /^\.header\s*\{([^}]*)\}/m.exec(code);
    assert.ok(header, '存在 .header 基础规则');
    assert.match(header[1], /margin-bottom:\s*0/, '.header 的 margin-bottom 必须归零，间距交给说明行');
});

test('引擎下拉对齐到按钮下方，而不是搜索框左缘', () => {
    const drop = /^\.engine-dropdown\s*\{([\s\S]*?)\n\}/m.exec(fullCode);
    assert.ok(drop, '存在 .engine-dropdown 基础规则');
    assert.match(drop[1], /left:\s*58px/,
        'left 应为 58px（1+5+48+4），对齐引擎按钮左缘；left:0 会贴到搜索框左缘，与按钮脱开');

    // 窄屏块曾把 left 重置为 0，等于在大屏修好、小屏又坏掉
    const narrow = mediaBlock(fullCode, '@media (max-width: 768px)', '.engine-dropdown');
    assert.equal(/\.engine-dropdown\s*\{[^}]*left:\s*0/.test(narrow), false,
        '≤768px 不得把 left 重置为 0');
});

test('引擎下拉不带开合动画，与仿真一致', () => {
    const drop = /^\.engine-dropdown\s*\{([\s\S]*?)\n\}/m.exec(fullCode);
    assert.ok(drop, '存在 .engine-dropdown 基础规则');
    assert.equal(/animation\s*:/.test(drop[1]), false, '引擎下拉不应有 animation');

    // @keyframes dropIn 仍被收藏下拉使用，不能跟着删掉
    const users = stylesCss.match(/animation:\s*dropIn/g) || [];
    assert.ok(users.length > 0, '收藏下拉仍在用 dropIn，关键字帧不能删');
    assert.match(stylesCss, /@keyframes dropIn/, '@keyframes dropIn 必须保留');
});

test('下拉选中项不铺底色', () => {
    // 只有加粗 + 变色才与 hover 的底色区分得开。
    // 必须显式写 transparent：旧样式 `.engine-option.active { background: var(--bg-hover) }`
    // 同特异性，不覆盖就会留一层米色底，把信号淹掉。
    const active = /^\.engine-option\.active\s*\{([^}]*)\}/m.exec(code);
    assert.ok(active, '存在 .engine-option.active 规则');
    assert.match(active[1], /background:\s*transparent/, '选中项必须显式清掉底色');
    assert.match(active[1], /color:\s*var\(--accent\)/, '选中项用主色文字');
    assert.match(active[1], /font-weight:\s*700/, '选中项加粗');

    // 选项也要有按下反馈——仿真 .engine-choice:active 有，移植时漏过一次
    const pressed = /^\.engine-option:active\s*\{([^}]*)\}/m.exec(code);
    assert.ok(pressed, '下拉选项应有按下态规则');
    assert.match(pressed[1], /box-shadow:\s*var\(--press-shadow\)/, '按下态用统一的凹陷阴影');
});

test('下拉容器与收藏下拉各自成条，不共用规则', () => {
    // 两者材质不同（引擎 10px 圆角，收藏 13px），合写后改一处会连带改动另一处。
    // 断言的是「分开声明」，不是具体数值——数值另有断言。
    assert.equal(/\.engine-dropdown\s*,\s*\.fav-dropdown\s*\{/.test(code), false,
        '.engine-dropdown 与 .fav-dropdown 不应再共用一条规则');
    assert.match(code, /^\.engine-dropdown\s*\{/m, '引擎下拉有独立规则');
    assert.match(code, /^\.fav-dropdown\s*\{/m, '收藏下拉有独立规则');
});

test('悬浮光感是双层：中性白高光 + 色相光晕', () => {
    // 缺了白色高光层，两层色相光晕叠在一起偏灰发糊——
    // 这是「说不上哪里不精致」的观感来源，只能靠数值钉住。
    for (const name of ['--glint-white', '--glint', '--search-glint']) {
        const n = (fullCode.match(new RegExp(`${name}\\s*:`, 'g')) || []).length;
        assert.equal(n, 3, `${name} 必须在三处主题块各定义一次，实际 ${n}`);
    }

    const searchAfter = /^\.search::after\s*\{([^}]*)\}/m.exec(code);
    assert.ok(searchAfter, '存在 .search::after 规则');
    const gradients = searchAfter[1].match(/radial-gradient/g) || [];
    assert.equal(gradients.length, 2, `.search::after 应为双层光感，实际 ${gradients.length} 层`);
    assert.match(searchAfter[1], /var\(--glint-white\)/, '搜索框光感含中性白高光层');
    assert.match(searchAfter[1], /var\(--search-glint\)/, '搜索框光感含色相光晕层');

    const bmBefore = /^\.bookmark::before\s*\{([^}]*)\}/m.exec(code);
    assert.ok(bmBefore, '存在 .bookmark::before 规则');
    assert.match(bmBefore[1], /var\(--glint-white\)/, '书签光感同样含中性白高光层');
    // 白色层不能写死一个偏暗的 rgba——那正是上一版「显得灰」的原因
    assert.equal(/rgba\(255,\s*255,\s*255,\s*\.5\d\)/.test(bmBefore[1]), false,
        '书签白色高光层应用 --glint-white 变量，不要写死偏暗的 rgba');
});

test('书签光晕强度不再靠提透明度补偿', () => {
    // 仿真用 --glint-white + --glint 两层本身就是 .32；上一版把单层调成 .46
    // 来补颜色，方向反了——该换的是颜色而不是透明度。
    const glow = /--bookmark-glow-opacity:\s*([\d.]+)/.exec(fullCode);
    assert.ok(glow, '定义了 --bookmark-glow-opacity');
    assert.equal(Number(glow[1]), 0.32, `浅色光晕应为仿真的 .32，实际 ${glow[1]}`);
});

test('书签顶边高光与悬停描边按仿真取值', () => {
    const after = /^\.bookmark::after\s*\{([^}]*)\}/m.exec(code);
    assert.ok(after, '存在 .bookmark::after 规则');
    assert.match(after[1], /left:\s*12px/, '高光左右各内缩 12px');
    assert.match(after[1], /right:\s*12px/, '高光左右各内缩 12px');

    const hoverBorder = /--bookmark-hover-border:\s*([^;]+);/.exec(fullCode);
    assert.ok(hoverBorder, '定义了 --bookmark-hover-border');
    assert.match(hoverBorder[1], /rgba\(148,94,74,\.37\)/, '悬停描边为仿真的陶土色 rgba(148,94,74,.37)');
});

test('引擎按钮的展开态只有一个真相来源', () => {
    // .active 类已无 CSS 消费者，JS 不应再 toggle 它——两个真相来源会各自驱动。
    assert.equal(/engineBtn\.classList/.test(appSource), false,
        'app.js 不应再操作 engineBtn 的 classList');
    assert.equal(/search-engine\.active/.test(fullCode.replace(/\/\*[\s\S]*?\*\//g, '')), false,
        'CSS 不应再有 .search-engine.active 规则');
    // aria-expanded 是唯一驱动，且四处设置都保留
    const sets = (appSource.match(/engineBtn\.setAttribute\('aria-expanded'/g) || []).length;
    assert.ok(sets >= 4, `aria-expanded 应在所有关闭路径上都被设置，实际 ${sets} 处`);
});

test('背板上边距还原仿真的纵向节奏', () => {
    // 仿真里搜索框顶距视口 83px = 背板内边距 24 + topbar 占位 4 + 其下边距 20。
    // 本项目删掉了那个空占位元素，用单值 48px 等效还原；窄屏兜底必须清零。
    // 用 mediaBlocks 的花括号配对取正文：这条规则跨行书写，正则 [^\n]* 会漏掉。
    const board = mediaBlocks(code, '.backboard {').find(b => b.includes('padding: 48px'));
    assert.ok(board, '存在 .backboard 基础规则且上内边距为 48px');
    assert.match(board, /padding:\s*48px 30px 30px/,
        '上内边距应为 48px（24 + 4 + 20），使搜索框顶落在 83px');

    const fb = mediaBlock(code, '@media (max-width: 1023px)', '.backboard');
    assert.match(fb, /\.backboard\s*\{[^}]*padding:\s*0/, '窄屏背板内边距必须清零');
});

test('搜索框有顶边受光高光', () => {
    // ::after 已被光感占用，这条高光必须走 ::before。仿真有、移植时漏过。
    const before = /^\.search::before\s*\{([^}]*)\}/m.exec(code);
    assert.ok(before, '存在 .search::before 规则');
    assert.match(before[1], /height:\s*1px/, '是 1px 细线');
    assert.match(before[1], /left:\s*11px/, '左右各内缩 11px');
    assert.match(before[1], /pointer-events:\s*none/, '不拦截指针事件');
    // 同一元素上 ::before 只能一条，否则后写的会覆盖先写的
    assert.equal((code.match(/^\.search::before\s*\{/gm) || []).length, 1,
        '.search::before 应只声明一次');
});

test('触屏点按关掉 UA 蓝色高亮', () => {
    // iOS Safari / 移动 Chrome 的 -webkit-tap-highlight-color 默认是
    // rgba(51,181,229,.4)，那抹蓝会盖在暖灰拟物材质上。
    // 此前只有 .fav-item / .fav-manager-item / .btn 被覆盖，搜索栏三个
    // 按钮、书签和右下角 dock 都会漏出蓝框。
    const block = mediaBlock(code, '@media (hover: none) and (pointer: coarse)', '-webkit-tap-highlight-color');
    for (const sel of ['.search-mode', '.search-engine', '.search-btn', '.bookmark', '.engine-option', '.fab']) {
        assert.match(block, new RegExp(sel.replace('.', '\\.') + '(?![\\w-])'),
            `${sel} 应在触屏高亮的兜底选择器里`);
    }
    assert.match(block, /-webkit-tap-highlight-color:\s*transparent/, '兜底值为 transparent');

    // 键盘可达性不能因此丢失：focus-visible 轮廓必须仍在。
    // 断言只认材质层那一条（旧样式区 281 行也有一份，命中它就等于没测）。
    const focusRule = /^\.bookmark:focus-visible[^\n]*$/m.exec(code);
    assert.ok(focusRule, '材质层存在 focus-visible 统一轮廓规则');
    for (const sel of ['.search-mode', '.search-btn', '.search-engine']) {
        assert.ok(focusRule[0].includes(sel), `${sel} 保留 focus-visible 轮廓`);
    }
    assert.match(focusRule[0], /outline:\s*2px solid var\(--focus\)/, '轮廓仍使用主色');
});

test('浅色下的浮起与按下依赖外投影，不能只靠内阴影', () => {
    // 深色下手感正确、浅色下「读不出来」，根因不是色相而是**机制缺失**：
    // 深色常态就带 --shadow、悬停带 --shadow-lg，抬升时有影子跟着；
    // 浅色此前常态完全没有外投影，悬停那层灰棕影在米色底上几乎不可见，
    // 按钮抬了 -1px 却看不到影子，等于白抬。
    // 这组断言钉住「浅色必须带外投影」，防止以后又被当成冗余删掉。
    const idle = /--bookmark-idle-shadow:\s*([^;]+);/.exec(code);
    assert.ok(idle, '定义了 --bookmark-idle-shadow');
    assert.match(idle[1], /var\(--shadow\)/, '书签常态须带外投影（与深色同构）');

    const hover = /--bookmark-hover-shadow:\s*([^;]+);/.exec(code);
    assert.ok(hover, '定义了 --bookmark-hover-shadow');
    assert.match(hover[1], /var\(--shadow-lg\)/, '书签悬停须换成更强的外投影');

    const btnBase = /^\.search-mode,\.search-engine,\.search-btn\s*\{([\s\S]*?)\n\}/m.exec(code);
    assert.ok(btnBase, '存在三按钮基础规则');
    assert.match(btnBase[1], /var\(--shadow\)/, '搜索按钮常态须带外投影');

    const btnHover = /^\.search-mode:hover,\.search-engine:hover,\.search-btn:hover\s*\{([^}]*)\}/m.exec(code);
    assert.ok(btnHover, '存在三按钮悬停规则');
    assert.match(btnHover[1], /var\(--shadow-lg\)/, '搜索按钮悬停须换成更强的外投影');

    // 按下时外投影必须收掉：抬升与下压两股力会互相抵消
    const btnActive = /^\.search-mode:active,\.search-engine:active,\.search-btn:active\s*\{([^}]*)\}/m.exec(code);
    assert.match(btnActive[1], /box-shadow:\s*var\(--ctl-press-shadow\)/,
        '按下态整条替换阴影，不保留悬停的外投影');
});

test('浅色与深色共用同一套浮起机制', () => {
    // 悬停抬升此前浅色 -1px / 深色 -2px，是机制不一致的又一处。
    const lifts = [...fullCode.matchAll(/--bookmark-lift:\s*(-?\d+)px/g)].map(m => m[1]);
    assert.equal(lifts.length, 3, `--bookmark-lift 应定义三处，实际 ${lifts.length}`);
    assert.equal(new Set(lifts).size, 1,
        `三处 --bookmark-lift 应一致（同一套机制），实际 ${lifts.join(' / ')}`);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public/styles.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const adminCss = fs.readFileSync(path.join(__dirname, '..', 'public/admin.css'), 'utf8');
const adminCode = stripComments(adminCss);

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

    // 单一来源：≤1023px 的**背板**兜底只能有一条，否则后写的会静默覆盖前一条。
    // 这里按「含 .backboard 的块」过滤，而不是数全部 ≤1023px 块——
    // 模块区另有一条同查询的窄屏段（位置纪律另有一条测试守着），
    // 但它不碰 .backboard，两者在属性上互不覆盖。
    const fallbacks = mediaBlocks(code, '@media (max-width: 1023px)')
        .filter(b => /\.backboard/.test(b));
    assert.equal(fallbacks.length, 1, `≤1023px 的背板兜底块应只有一条，实际 ${fallbacks.length}`);
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

test('模块区的窄屏覆盖写在基础规则之后', () => {
    // 位置本身就是契约，不只是「两条规则都在」：
    // 曾把窄屏段并进文件上方那条 ≤1023px 块，于是它落在基础规则**之前**，
    // 同特异性下基础赢——390px / 360px 实测 .module-zone-inner 仍算成 grid，
    // 横向滚动完全没生效，360px 下还被挤成 190px+105px 两列。
    // 断言必须比较两处的源码位置，光断言存在永远为真。
    //
    // 宽屏形态已从「两栏网格」改为「背板外侧绝对定位」（display:contents），
    // 所以这里钉的是 flex 那条窄屏声明的位置。
    const baseAt = code.search(/^\.module-zone-inner\s*\{[^}]*display:\s*contents/m);
    assert.ok(baseAt >= 0, '.module-zone-inner 有基础规则（display:contents，让子节点直接参与外层定位）');

    const narrowAt = code.search(/\.module-zone-inner\s*\{[^}]*display:\s*flex/);
    assert.ok(narrowAt >= 0, '窄屏段把 module-zone-inner 改为 flex');

    assert.ok(narrowAt > baseAt,
        `窄屏覆盖必须写在基础规则之后（base@${baseAt} → narrow@${narrowAt}），`
        + '否则同特异性下基础规则胜出，窄屏形态整段失效');
});

test('宽屏模块区绝对定位在背板外侧，放不下时退回网格下方', () => {
    // 宽屏：模块贴背板左右外侧，靠 position:absolute + 实测高度算出的纵向次序。
    // 窄屏或余量不足：必须整段撤掉绝对定位——只写宽屏定位而不写 reset，
    // 绝对定位会一路带到手机上，模块区脱离文档流、页面高度塌掉。
    assert.match(code, /\.module-zone\s*\{[^}]*position:\s*absolute/,
        '宽屏模块区绝对定位');
    // 宽度跟着可用余量伸缩，不写死：936 背板在 1280 视口下左右只剩 150px，
    // 写死 200px 实测会压进背板 50px。
    assert.match(code, /\.module-widget\[data-side="(?:left|right)"\]\s*\{[^}]*position:\s*absolute[^}]*width:\s*clamp\(/,
        '宽屏 widget 绝对定位且宽度用 clamp 跟随可用空间');
    // 纵向偏移按实测高度算，不是固定步进——见 stackWidgetsByHeight。
    assert.match(code, /\.module-widget\[data-side="(?:left|right)"\]\s*\{[^}]*margin-top:\s*var\(--stack-top/,
        '纵向偏移取 JS 实测的 --stack-top');
    assert.doesNotMatch(code, /\.module-widget\[data-side="(?:left|right)"\]\s*\{[^}]*margin-top:\s*calc\(var\(--i/,
        '不得写死步进——卡片高度随内容变，写死会压住下一张（实测重叠 8px）');

    // 「放不下」的兜底形态由 JS 写 data-dock 触发，不用媒体查询：
    // 936 背板在 1024 下留 44px、1440 下留 252px，断点表达不了这个连续量。
    assert.match(code, /\.module-zone\[data-dock="below"\]\s*\{[^}]*position:\s*static/,
        'data-dock=below 时模块区回到文档流');
    assert.match(code, /\.module-zone\[data-dock="below"\] \.module-widget\s*\{[^}]*position:\s*static/,
        'data-dock=below 时 widget 也撤掉绝对定位');
    assert.match(code, /\.module-zone\[data-dock="below"\] \.module-zone-inner\s*\{[^}]*overflow-x:\s*auto/,
        'data-dock=below 时横向滚动');

    const narrow = mediaBlocks(code, '@media (max-width: 1023px)')
        .filter(b => /module-zone/.test(b));
    assert.equal(narrow.length, 1, '模块区窄屏规则应恰好一条');
    const block = narrow[0];
    assert.match(block, /\.module-zone\s*\{[^}]*position:\s*static/, '窄屏模块区回到文档流');
    assert.match(block, /\.module-widget\[data-side\]\s*\{[^}]*position:\s*static/, '窄屏 widget 也撤掉绝对定位');
    assert.match(block, /\.module-widget\[data-side\]\s*\{[^}]*margin-top:\s*0/, '窄屏清掉 --i 带来的纵向偏移');
    assert.match(block, /\.module-zone-inner\s*\{[^}]*overflow-x:\s*auto/, '窄屏横向滚动');
    assert.match(block, /\.module-widget\s*\{[^}]*flex:\s*0 0 auto/, '窄屏 widget 固定宽度，不参与网格分配');
});

test('背板外侧放得下：.app 宽度足够容纳 936 背板 + 两侧模块', () => {
    // .app 内容盒 = max-width - 2×padding。模块用 clamp 伸缩，
    // 所以这里只钉「最大宽度下两侧有余量」：1440 上限时每侧 252px。
    // 1280 这类窄一点的视口由 JS 的 sideDockAvailable() 判为 below。
    const appRule = /^\.app\s*\{([^}]*)\}/m.exec(code);
    assert.ok(appRule, '.app 有基础规则');
    const maxWidth = Number(/max-width:\s*(\d+)px/.exec(appRule[1])?.[1]);
    const padX = Number(/padding:\s*[\d.]+px\s+(\d+)px/.exec(appRule[1])?.[1]);
    assert.ok(Number.isFinite(maxWidth) && Number.isFinite(padX), '.app 的 max-width 与左右 padding 可解析');

    const sideAtMax = (maxWidth - padX * 2 - 936) / 2;
    assert.ok(sideAtMax >= 220,
        `.app 上限 ${maxWidth}px 时每侧余量 ${sideAtMax}px，需 ≥ 220px`);

    // 背板本身宽度不变——两侧模块是新增的，不该顺带改动既有主体宽度
    const bb = ruleBlock(code, '.backboard', 'width:');
    assert.match(bb, /width:\s*min\(100%,\s*936px\)/, '背板仍是 936px 居中');
});

test('模块区停靠方式由 JS 按实际余量判定，不靠媒体查询', () => {
    // 1024 视口下 936 背板左右只剩 44px，1440 下有 252px——
    // 固定断点只能二选一，另一头必然出错，所以判据是实测量。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(appSource, /sideDockAvailable\(\)\s*\{[\s\S]*?getBoundingClientRect\(\)\.width/,
        '判据必须读实际渲染宽度');
    assert.match(appSource, /side\w*\s*>=\s*MIN_SIDE\s*\+\s*GAP/,
        '余量不足最小宽度加间隙时判为放不下');
    assert.match(appSource, /zone\.dataset\.dock\s*=\s*this\.sideDockAvailable\(\)\s*\?\s*'outside'\s*:\s*'below'/,
        '两种停靠方式都要有对应的 data-dock 值');
    // 跨过阈值要重新摆放，否则窗口拉宽后模块仍挤在下方
    assert.match(appSource, /addEventListener\('resize'[\s\S]*?sideDockAvailable\(\)[\s\S]*?renderModuleZone\(\)/,
        'resize 时要重算并重绘');
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

test('管理页下拉框的展开列表自带不透明底色，深色下不会退回白底', () => {
    // 收起的下拉框靠 select 自己的渐变上色，看起来正常；展开后的列表由 UA
    // 绘制，只认 option 的 background-color。此前 option 完全透明
    // （rgba(0,0,0,0)），深色下就由 UA 默认的白画布铺底，文字看不清。
    const option = /select option\s*\{([\s\S]*?)\n\}/.exec(adminCode);
    assert.ok(option, '存在 select option 规则');
    assert.match(option[1], /background-color:\s*var\(--admin-field-canvas\)/,
        'option 必须自带不透明底色');
    assert.match(option[1], /color:\s*var\(--text\)/, 'option 必须自带文字色');

    // 变量要在三处主题里都定义，否则自动深色（无 data-theme）会取不到值
    const defs = adminCode.match(/--admin-field-canvas\s*:/g) || [];
    assert.equal(defs.length, 3, `--admin-field-canvas 应定义三处，实际 ${defs.length}`);

    // 深色取值必须真的是深色：写成浅色等于把白底问题换个地方复现。
    // 浅色侧引用 --control-top，这里按浅色块来处理，不参与逐字比对。
    const values = [...adminCode.matchAll(/--admin-field-canvas:\s*([^;]+);/g)].map(m => m[1].trim());
    const light = values[0];
    const dark = values.slice(1);
    assert.match(light, /^var\(--/, '浅色底色应引用既有 token，不另存一份色值');
    for (const d of dark) {
        assert.equal(d, dark[0], '两个深色块的下拉底色必须逐字一致，避免手动深色与系统深色分叉');
    }
    // 数值断言：深色底必须真的是深色。仅比较两处深色彼此相同不够——
    // 两处同时写成同一个浅色也会「逐字一致」而假绿。
    const lum = hex => {
        const n = parseInt(hex.replace('#', ''), 16);
        return (n >> 16 & 255) * 0.299 + (n >> 8 & 255) * 0.587 + (n & 255) * 0.114;
    };
    const controlTop = /--control-top:\s*(#[0-9a-fA-F]{6})/.exec(stylesCss);
    assert.ok(controlTop, 'styles.css 定义了 --control-top');
    assert.ok(lum(dark[0]) < lum(controlTop[1]),
        `深色下拉底亮度 ${lum(dark[0]).toFixed(1)} 应低于浅色 ${lum(controlTop[1]).toFixed(1)}`);
});

test('background 简写不会把下拉底色抹掉', () => {
    // `background` 简写会把 background-color 重置为 transparent。
    // 把它写在不透明底色之前，底色当场失效且不报错，深色下又变回白底。
    // 浏览器实测确认过：简写在后时 background-color 读回 rgba(0,0,0,0)。
    const field = mediaBlocks(adminCode, ':is(input:not([type="checkbox"])')
        .map(b => b.replace(/^[\s\S]*?\{/, ''))
        .find(b => b.includes('--admin-field-canvas'));
    assert.ok(field, '找到给表单控件设置底色的规则');

    const shorthand = field.search(/\bbackground\s*:/);
    const color = field.search(/background-color\s*:/);
    assert.ok(shorthand >= 0 && color >= 0, '该规则同时写了 background 与 background-color');
    assert.ok(shorthand < color,
        'background 简写必须排在 background-color 之前，否则底色被重置为 transparent');
});

test('进入管理页的两个请求并发发出，不串行叠加两次密码校验', () => {
    // 两个请求各自跑一次 bcrypt（实测各约 55ms），串行等待把两次叠加成约 130ms。
    // 这条断言钉住「并发」这个意图，而不是某个具体毫秒数。
    // 用花括号配对取正文，源码里的 openAdmin 缩进一变，正则就会误报「找不到」。
    const start = appSource.indexOf('async openAdmin()');
    assert.ok(start > -1, '找到 openAdmin');
    const open = /\{([\s\S]*?)\n {8}\}/.exec(appSource.slice(start));
    assert.ok(open, '能取到 openAdmin 的函数体');
    const body = open[1];

    assert.equal(body.search(/await\s+this\.(ensureAdminFavorites|loadPrivacyMode)/), -1,
        '两个请求不得各自 await（那会把两次 bcrypt 串成约 130ms）');
    assert.match(body, /await Promise\.all\(\[/,
        '两个请求必须放进同一个 Promise.all 并发发出');
    assert.match(body, /this\.ensureAdminFavorites\(\)/, '仍需取回全量收藏，否则保存会丢私密条目');
    assert.match(body, /this\.loadPrivacyMode\(\)/, '仍需取回 privacyMode 的真实值');
});

test('每个下拉框都被同一条 option 规则覆盖', () => {
    // 只修主面板的两个、漏掉收藏弹窗里的那个，等于留一个同样的坑。
    //
    // 断言的是「每个下拉框都被同一条 option 规则覆盖」这个事实，
    // 而不是某个固定数量——新增下拉框时数量会变（模块分区的「更新周期」是
    // 第四个），写死 3 会让正常的新增变成测试失败。
    const selects = [...appSource.matchAll(/<select\b[^>]*id="([^"]+)"/g)].map(m => m[1]);
    assert.ok(selects.length >= 3, `应至少三个下拉框，实际 ${selects.length}: ${selects.join(', ')}`);
    // 一条 :is(...) 规则同时挂载三处弹窗，收藏弹窗里的 favCategorySelect
    // 因此不必单独再写一条。断言的是「三处都被覆盖」这个事实。
    const optionRule = /:is\(([^)]*)\)\s*select option\s*\{/.exec(adminCode);
    assert.ok(optionRule, '存在 select option 规则');
    for (const host of ['.modal', '.fav-dialog', '.ui-dialog']) {
        assert.ok(optionRule[1].includes(host),
            `option 规则未覆盖 ${host}，该弹窗里的下拉框会漏`);
    }
    // 新增的下拉框必须在 .modal 里，否则它会退回浏览器默认的 UA 配色：
    // 深色页面上的原生 option 弹层是白底（实测过）。
    const moduleSelects = selects.filter(id => id === 'pollIntervalSelect');
    assert.deepEqual(moduleSelects, ['pollIntervalSelect'],
        '模块分区的更新周期下拉框存在，且位于 .modal 内（被上面那条规则覆盖）');
});

// ========== 首页编辑模式 ==========

// 按大括号配对取方法体。用「下一个顶格方法定义」当结束标记会在嵌套的
// catch { / if { 处截断，断言于是在错误的位置通过。
function methodBody(source, name) {
    const sync = source.indexOf(`\n        ${name}(`);
    const asyncHead = source.indexOf(`\n        async ${name}(`);
    const head = sync >= 0 ? sync : asyncHead;
    assert.ok(head >= 0, `${name} 存在`);
    const open = source.indexOf('{', head);
    assert.ok(open > head, `${name} 的方法体起点可定位`);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                const body = source.slice(open, i + 1);
                assert.ok(body.length > 60, `${name} 的切片长度合理（${body.length}）`);
                return body;
            }
        }
    }
    throw new Error(`${name} 的方法体没有闭合`);
}

test('编辑按钮的文案随状态切换，且初值是「编辑」', () => {
    // 按钮承担两个动作：进入编辑 / 保存编辑。停在「布局」会与模块区那条
    // 旧语义混淆，而实际可编辑的早已不止模块。
    assert.match(indexHtml, /id="layoutBtn"[^>]*>编辑</,
        'index.html 里 #layoutBtn 的初值文案是「编辑」');
    assert.match(indexHtml, /id="layoutBtn"[^>]*aria-pressed="false"/,
        '#layoutBtn 带初始 aria-pressed');

    const body = methodBody(appSource, 'syncEditLayoutUI');
    assert.match(body, /textContent\s*=\s*editing\s*\?\s*'保存编辑'\s*:\s*'编辑'/,
        'syncEditLayoutUI 必须按 editing 切换按钮文案');
    assert.match(body, /btn\.setAttribute\(\s*'aria-pressed',\s*String\(editing\)\s*\)/,
        'aria-pressed 跟着同一个 editing 走，不另开真相来源');
    // 两处 is-editing 都要切：模块区拖拽把手与网格增删控件各靠一个 class
    assert.match(body, /zone\.classList\.toggle\(\s*'is-editing',\s*editing\s*\)/,
        '模块区的 is-editing 由状态驱动');
    assert.match(body, /grid\.classList\.toggle\(\s*'is-editing',\s*editing\s*\)/,
        '网格的 is-editing 也由同一个状态驱动');
});

test('网格的编辑控件由模板分支生成，且只在编辑态出现', () => {
    // 非编辑态的模板与改动前逐字相同，所以正常访问的首页零回归；
    // 正因如此，增删入口必须挂在 editing 分支里而不是一直渲染。
    const body = methodBody(appSource, 'renderGrid');
    assert.match(body, /const editing = this\.editLayout;/,
        'renderGrid 必须按 editLayout 分支');
    assert.match(body, /bookmark bookmark-add/, '编辑态追加「＋」占位卡');
    assert.match(body, /category-add/, '编辑态追加「＋ 添加分类」');
    assert.match(body, /category-del/, '编辑态分类头有删除按钮');
    assert.match(body, /editing \? `<button/, '增删控件必须包在 editing 分支里');
    // ＋卡片与「添加分类」都**受 editing 门控**。只断言「它们出现了」
    // 是不够的：`if (editing)` 改成 `if (true)` 后断言仍然成立，
    // 而结果是登录用户之外的所有访客都看到一堆点不动的加号。
    assert.match(body, /if \(editing\) \{\s*\n\s*bms\.appendChild[\s\S]*?bookmark-add/,
        '＋卡片必须由 if (editing) 门控');
    assert.match(body, /if \(editing\) \{\s*\n\s*fragment\.appendChild[\s\S]*?category-add/,
        '「添加分类」必须由 if (editing) 门控');
    // ＋卡片每个分类末尾各一个，所以它挂在 cat.bookmarks 循环之后
    const loopAt = body.indexOf('cat.bookmarks.forEach');
    const addAt = body.indexOf('bookmark-add');
    assert.ok(loopAt >= 0 && addAt > loopAt,
        '＋卡片在书签循环之后追加，即每个分类末尾一个');

    // 书签卡要带定位坐标：拖拽、增删改全靠 data-cat/data-bm
    const bm = methodBody(appSource, 'createBookmark');
    assert.match(bm, /data-cat="\$\{catIdx\}"/, '书签卡带 data-cat');
    assert.match(bm, /data-bm="\$\{bmIdx\}"/, '书签卡带 data-bm');
    assert.match(bm, /draggable="true"/, '编辑态书签卡是原生拖拽宿主');
});

test('编辑态书签的点击被拦下，不会跳转', () => {
    // 书签卡本体是 <a href>。不拦就会一边打开新标签页、一边想编辑。
    const body = methodBody(appSource, 'bindGridEdit');
    assert.match(body, /if \(!this\.editLayout\) return;/,
        '网格交互必须先判编辑态，否则常态下会被劫持');
    assert.match(body, /addEventListener\(\s*'click'/, '有 click 分支处理增删改');
    assert.match(body, /addEventListener\(\s*'dragstart'/, '有 dragstart 分支处理拖拽');
    const clickAt = body.indexOf("addEventListener( 'click'") >= 0
        ? body.indexOf("addEventListener( 'click'")
        : body.indexOf("addEventListener('click'");
    const guardAt = body.indexOf('preventDefault', clickAt);
    assert.ok(clickAt >= 0 && guardAt > clickAt,
        'click 分支里必须有 preventDefault 拦掉链接导航');
    // 增删改五条路径都要在
    for (const fn of ['addHomeBookmark', 'editHomeBookmark', 'deleteHomeBookmark',
        'addHomeCategory', 'renameHomeCategory', 'deleteHomeCategory']) {
        assert.ok(body.includes(fn), `${fn} 由编辑态点击调用`);
    }
});

test('删除最后一个分类被拦下', () => {
    // 首页要有一个容器，删光后网格整块空掉且无法恢复。
    const body = methodBody(appSource, 'deleteHomeCategory');
    assert.match(body, /length <= 1/, '至少保留一个分类');
    assert.match(body, /至少保留一个分类/, '拦下时要告诉用户为什么');
    // 且拦下必须早于确认框与删除，否则「已被拦下」只是 toast 而数组照样少一项
    const guardAt = body.indexOf('length <= 1');
    const spliceAt = body.indexOf('splice(catIdx, 1)');
    assert.ok(guardAt >= 0 && spliceAt > guardAt, '拦截在 splice 之前');
});

test('书签拖拽复用既有的 moveBookmark，不另写一套排序', () => {
    // 自己重写一套排序就会与别处各有一份真值，两边拖出不同结果时
    // 无从判断该信哪个。后台那份编辑器已删除，现在只剩首页这一处调用方。
    const body = methodBody(appSource, 'bindGridEdit');
    assert.match(body, /this\.moveBookmark\(/, '书签拖拽走 moveBookmark');
    assert.match(body, /this\.moveCategory\(/, '分类拖拽走 moveCategory');
    assert.match(body, /dragKind === 'cat'/, '分类与书签是两条独立的拖拽分支');
    // 加号卡是新增入口，不该被当成拖拽宿主
    assert.match(body, /bookmark-add'\)\s*\)?\s*return|bookmark-add\)\) return/,
        '＋卡片不参与拖拽');
});

test('分类的拖拽宿主是分类头，不是 ⠿ 按钮也不是整块 section', () => {
    // 两条边界都是真实浏览器实测出来的，方向相反：
    //  · 宿主太小：只给书签卡加 draggable 时，从 ⠿ 按下一个 dragstart 都不发（0 事件）。
    //  · 宿主太大：挂到整块 <section> 上时 section 内任何位置按下都起拖，
    //    **包括 ✎ 重命名与 ✕ 删除**——按住横拖就起拖，浏览器按规范抑制随后的
    //    click，对话框再也打不开（实测：单独点击正常，一拖就死）。
    // 所以宿主是 .category-header：可拖区域与分流判据落在同一处，
    // ✎/✕ 作为 draggable=false 的后代，按下不起拖。
    const body = methodBody(appSource, 'renderGrid');
    assert.match(body, /<div class="category-header"\$\{editing \? ' draggable="true"' : ''\}>/,
        'draggable 必须挂在 .category-header 上');
    assert.doesNotMatch(body, /<section class="category" data-cat="\$\{catIdx\}"\$\{editing/,
        '整块 <section> 不得挂 draggable——那会让 ✎/✕ 起死拖并吞掉 click');
    assert.doesNotMatch(body, /class="category-drag"[^>]*draggable/,
        '⠿ 是 <button>，不可拖拽；把 draggable 写在这里不解决问题');

    // 分流判据必须与宿主一致：落在分类头里，而不是落在 ⠿ 上。
    const edit = methodBody(appSource, 'bindGridEdit');
    assert.match(edit, /pointerdown[\s\S]*?closest\('\.category-header'\)/,
        'pointerdown 的定性判据要与宿主同为 .category-header');
    assert.doesNotMatch(edit, /downOnCategory\s*=\s*!!event\.target\.closest\('\.category-drag'\)/,
        '判据不能是 ⠿ ——宿主已经是分类头，把手只是它内部一个点');
    assert.match(edit, /if \(downOnCategory\)/, 'dragstart 要靠这个标志分流');

    // ⚠️ 宿主收窄到分类头之后，✎/✕ 就在可拖拽区域**里面**了，而
    // 后代的 draggable="false" 不能豁免（对照页实测：Chrome 里可拖拽祖先的
    // 后代——普通 button、写死 draggable=false 的 button、h2——按下照样起拖，
    // dragstart 命中祖先）。于是按住 ✎ 横拖就拖走整个分类，浏览器按规范
    // 抑制随后的 click，重命名/删除对话框再也打不开（实测：一拖就死）。
    // 解法是在 pointerdown 里对这两个按钮 preventDefault：对照页实测取消后
    // 一个 dragstart 都不发，click 照常送达。dragstart 里再取消就晚了。
    const pd = stripComments(edit.slice(edit.indexOf("addEventListener('pointerdown'"),
        edit.indexOf("addEventListener('dragstart'")));
    assert.match(pd, /category-action:not\(\.category-drag\)/,
        'pointerdown 必须把 ✎/✕ 排除在可拖区域外');
    assert.match(pd, /closest\('\.category-action:not\(\.category-drag\)'\)\)\s*\{[\s\S]*?preventDefault\(\)/,
        '落在 ✎/✕ 上要 preventDefault —— 否则按钮会被拖拽吞掉 click');
    assert.match(pd, /downOnCategory = false/,
        '按钮上按下必须把定性复位，否则上一次的状态会带进下一次 dragstart');

    // 兜底分支必须显式取消：既不在分类头也不在书签卡上按下时，
    // 什么都不做就会「能拖、松手没 drop」的死拖。
    // ⚠️ 断言要剥注释后再找：那个兜底分支的说明文字里就写着 preventDefault，
    // 不剥的话「从 closest('.bookmark') 往后找 preventDefault」会命中**注释**，
    // 于是把真正那行删掉测试照样绿——反向断言的同类陷阱。
    const start = edit.indexOf("addEventListener('dragstart'");
    assert.ok(start >= 0, '有 dragstart 监听');
    const tail = stripComments(edit.slice(start));
    const bmAt = tail.indexOf("closest('.bookmark')");
    assert.ok(bmAt >= 0, '书签分支存在');
    const branchEnd = tail.indexOf('dragKind = \'bm\';', bmAt);
    assert.ok(branchEnd > bmAt, '书签分支的兜底 return 边界可定位');
    const branch = tail.slice(bmAt, branchEnd);
    assert.match(branch, /preventDefault\(\)/,
        '兜底 return 之前要 preventDefault，否则 ＋卡片起手是死拖');

    // JS 会加 .drop-target，但**只有 CSS 真的消费它**这个 class 才有意义。
    assert.match(stripComments(stylesCss), /\.category\.drop-target\s*\{[^}]*opacity/,
        '.category.drop-target 必须有样式，否则拖动时毫无反馈');
});

test('编辑态的拖拽反馈样式不被覆盖成死规则', () => {
    // .grid.is-editing 是宿主类：JS 只 toggle 它，不写 hidden / display。
    // 若某条规则用 hidden 或 display:none 接管这些控件，它们会实测 0×0。
    const code = stripComments(stylesCss);
    assert.doesNotMatch(code, /\.grid\.is-editing [^{]*\{[^}]*(?:^|[;{\s])display:\s*none/,
        '编辑态控件不得被 display:none 接管（显隐只由 .grid.is-editing 门控）');
    // 书签卡在编辑态必须中和 hover 抬升，否则拖动时卡片浮起来、落点判断跟着偏。
    // ⚠️ 钉「hover 被置成 transform: none」这个事实，而不是「它单独占一条规则」：
    // 触摸端那轮把 hover / :active / .is-pressed 并进了一条共享规则
    // （为了少一次重复声明），硬钉单条规则会把正确改动判红。
    const hover = /\.grid\.is-editing [^{]*\.bookmark:hover[^{]*\{([^}]*)\}/.exec(code);
    assert.ok(hover, '编辑态书签卡的 hover 规则存在');
    assert.match(hover[1], /transform:\s*none/, '编辑态书签卡取消 hover 抬升');
});

/**
 * 把 bindGridEdit 的真实方法体摘出来执行一遍。
 *
 * 上一条断言的是「代码写了分流」，这里钉住**分流真的执行**：
 * 分类拖拽整个不可用时，dragstart 里的定性永远走不到，
 * 源码断言照样全绿——403 条测试就是这么放过去的。
 *
 * DOM 全是假节点，唯一为真的就是「按下落在哪 → 定性成哪种 → drop 调谁」。
 */
function mountGridEdit(editLayout = true) {
    const calls = [];
    const config = {
        categories: [
            { name: 'A', bookmarks: [{ title: 'a1' }, { title: 'a2' }] },
            { name: 'B', bookmarks: [] }
        ]
    };
    // 假节点：closest 按选择器向上查找，返回自身或 parents 里登记的祖先。
    // ⚠️ 祖先也必须是带 classList 的节点：dragstart 的分类分支会写
    // source.classList.add('is-dragging')，而 source 来自 closest——
    // 这里少给一层 classList，测试就会挂在「read of 'add'」上，
    // 读起来像产品代码炸了，其实是自己造的桩太薄。
    const node = (className, dataset, parents = {}) => ({
        className, dataset,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        closest(sel) {
            if (sel === `.${className}`) return this;
            const parent = parents[sel];
            if (!parent) return null;
            return parent.__node || (parent.__node = Object.assign(node(className, {}), parent));
        },
        querySelectorAll: () => []
    });

    const app = {
        editLayout,
        config,
        moveCategory: (from, to) => calls.push(['cat', from, to]),
        moveBookmark: (fc, fb, tc, tb) => calls.push(['bm', fc, fb, tc, tb]),
        renderGrid() {}, markConfigDirty() {},
        // bindGridEdit 末尾会调它；触摸路径另有自己的用例，不在这里展开。
        // 少了这个桩，方法体会抛「is not a function」，读起来像产品代码炸了。
        bindTouchGridDrag() {}
    };
    // 方法体通过文件级 $ 拿 grid；这里让它返回能记录监听的桩。
    // ⚠️ 监听必须**全部**留存成数组：bindGridEdit 对 pointerdown 注册了两次
    // （定性 + 既有的 card.focus()），只留最后一个会把定性那个悄悄丢掉，
    // 于是测试读起来像「代码没生效」，其实是桩自己丢了监听。
    // ⚠️ listeners 建在 vm 沙箱**内**，挂到宿主对象上再回读是拿不到的
    // （跨上下文属性不可见），所以由方法体自己 return 出来。
    const grid = { querySelectorAll: () => [] };
    const mount = vm.runInNewContext(`(function (grid) {
        const $ = () => grid;
        const $$ = () => [];
        const listeners = {};
        grid.addEventListener = (t, f) => { (listeners[t] ||= []).push(f); };
        ${methodBody(appSource, 'bindGridEdit')}
        return listeners;
    })`);
    const listeners = mount.call(app, grid);

    // 浏览器语义：同一类型的所有监听按注册顺序依次收到事件
    const fire = (type, event) =>
        (listeners[type] || []).forEach(fn => fn(event));
    const dataTransfer = { setData() {}, effectAllowed: '', dropEffect: '' };

    return {
        calls, config, listeners,
        countOf: type => (listeners[type] || []).length,
        // pointerdown 的落点：分类头内 or 书签卡上
        press: onHeader => fire('pointerdown', {
            button: 0,
            target: { closest: sel => (onHeader && sel === '.category-header' ? {} : null) }
        }),
        // 分类宿主是 .category-header，它自身带 draggable
        header: idx => node('category-header', {}, {
            '.category': { dataset: { cat: String(idx) } }
        }),
        category: idx => node('category', { cat: String(idx) }),
        bookmark: (cat, bm) => node('bookmark', { cat: String(cat), bm: String(bm) },
            { '.category': { dataset: { cat: String(cat) } } }),
        dragstart: target => fire('dragstart', { target, dataTransfer }),
        dragover: target => fire('dragover', { target, dataTransfer }),
        drop: target => fire('drop', { target, preventDefault() {}, dataTransfer })
    };
}

test('从分类头起手走 moveCategory，从卡片起手走 moveBookmark', () => {
    const grid = mountGridEdit();
    // 两条 pointerdown 监听并存（定性 + card.focus()）——桩退化成只留一个
    // 会把定性悄悄丢掉，于是测试读起来像「代码没生效」，其实是自己丢了监听
    assert.equal(grid.countOf('pointerdown'), 2,
        'pointerdown 应有两个监听（定性 + 聚焦），只留一个说明桩退化了');

    // 场景一：从分类头起手，落到第二个分类 → moveCategory(0, 1)
    grid.press(true);
    grid.dragstart(grid.header(0));
    grid.drop(grid.header(1));
    assert.deepEqual(grid.calls, [['cat', 0, 1]],
        '从分类头起手时 drop 必须调用 moveCategory(0, 1)');

    // 场景二：从书签卡起手 → 必须走 moveBookmark，不能被误判成分类
    grid.calls.length = 0;
    grid.press(false);
    grid.dragstart(grid.bookmark(0, 1));
    grid.drop(grid.bookmark(0, 0));
    assert.deepEqual(grid.calls, [['bm', 0, 1, 0, 0]],
        '从卡片起手时 drop 必须调用 moveBookmark(0,1→0,0)');
});

test('非编辑态下整条拖拽链都不许动配置', () => {
    // dragstart 的第一道门是 editLayout。少了它，退出编辑后一次拖拽
    // 就会改到配置上——而那一刻用户以为自己在浏览首页。
    const grid = mountGridEdit(false);
    grid.press(true);
    grid.dragstart(grid.header(0));
    grid.drop(grid.header(1));
    assert.deepEqual(grid.calls, [], '非编辑态下整条链都不该有调用');
});

test('拖拽残留的清理覆盖 dragend，不只靠 drop', () => {
    // drop 只在松手点位于 #grid 内才触发（监听挂在 grid 上）。拖到页头、
    // 模块区或留白处松手走不到它——而 .drop-target 与 .is-dragging 视觉完全相同
    // （同为 opacity .55），漏清会让用户以为「分类卡住了」。
    const body = methodBody(appSource, 'bindGridEdit');
    const end = body.indexOf("addEventListener('dragend'");
    assert.ok(end >= 0, '有 dragend 监听');
    const tail = body.slice(end);
    // 按下一个方法定义当结束标记会在嵌套处截断，用到下一个 addEventListener 为止
    const next = tail.indexOf("addEventListener('click'");
    const dragend = next > 0 ? tail.slice(0, next) : tail;
    assert.match(dragend, /\.bookmark\.is-dragging/,
        'dragend 清书签的 is-dragging');
    assert.match(dragend, /\.category\.is-dragging/,
        'dragend 清分类的 is-dragging');
    assert.match(dragend, /\.category\.drop-target/,
        'dragend 必须也清 .drop-target —— 松手在网格外时 drop 不触发');
});

test('退出编辑时清掉两处容器的拖拽残留，且 class 名要对', () => {
    // exitEditLayout 的注释声称清掉「全部拖拽残留」，那就必须同时覆盖
    // #grid 与 #moduleZone。早先这里写的是 .drop-active —— 那个 class 在
    // 样式表里根本不存在，整行是空转，模块拖拽后按 Esc 放弃编辑会留下压暗卡片。
    // ⚠️ 断言前必须剥注释：解释这段历史的那几行里就写着「drop-active」，
    // 不剥就会把「注释里提到过」读成「代码里还在用」——反向断言的同类陷阱。
    // ⚠️ 「选中了什么」不够——还要「真的遍历并移除了」。只查选择器的话，
    // 把 querySelectorAll 的结果丢在一边不迭代，这用例照样绿。
    const body = stripComments(methodBody(appSource, 'exitEditLayout'));
    assert.match(body, /is-dragging/, '清 is-dragging');
    assert.doesNotMatch(body, /drop-active/,
        '.drop-active 在样式表里不存在，用它是空转；真实落点高亮叫 .drop-target');
    assert.match(body, /drop-target/, '清 .drop-target');
    // 两个容器都要：选择器 + forEach 里真的移除了这两个 class
    for (const [id, what] of [['$(\'#grid\')', '网格（分类/书签）'], ['$(\'#moduleZone\')', '模块区']]) {
        const at = body.indexOf(id);
        assert.ok(at >= 0, `${what} 也要清（找不到 ${id}）`);
        // 窗口按**方法边界**给，不用字符数：早先用 220 字符，
        // 正好在第二个 remove 之前切掉，读起来像「代码没清」而其实切窄了。
        const slice = body.slice(at, at + 320);
        assert.ok(slice.length > 200, `${what} 的切片长度合理（${slice.length}）`);
        assert.match(slice, /querySelectorAll\('\.is-dragging, \.drop-target'\)/,
            `${what} 要同时清 .is-dragging 与 .drop-target`);
        assert.match(slice, /forEach\(n => \{/,
            `${what} 的结果必须真的被遍历——选中却丢弃等于没清`);
        assert.match(slice, /n\.classList\.remove\('is-dragging'\)/, `${what} 移除 is-dragging`);
        assert.match(slice, /n\.classList\.remove\('drop-target'\)/, `${what} 移除 drop-target`);
    }
});

test('落点与自己相同时分类不动', () => {
    // 拖回自己身上是最常见的空拖。若不加 to !== dragFrom 判断，
    // moveCategory(0, 0) 会 splice 再插回——虽然结果碰巧一样，
    // 但它会把 markConfigDirty 打开，用户只是点了一下就被标记成「有未保存改动」。
    const grid = mountGridEdit();
    grid.press(true);
    grid.dragstart(grid.header(0));
    grid.drop(grid.header(0));
    assert.deepEqual(grid.calls, [], '落回自身不应算一次移动');
});

/**
 * 最小假 DOM：带**真实父子链**的节点树 + 按选择器向上查找的 closest。
 *
 * 为什么不能只给每个节点塞一个「按选择器查表」的假 closest：
 * bindTouchGridDrag 会用 `closest('.category-header')` 找拖拽宿主、
 * `closest('.category')` 找所属分类、`closest('.category-action:not(.category-drag)')`
 * 排除 ✎/✕——查表式 closest 少一条就返回 null，处理器在守卫处早退，
 * 测试报「没调用 moveCategory」，读起来像产品缺陷，其实是桩太薄。
 */
function makeDom() {
    const matches = (node, sel) => sel.split(',').map(s => s.trim()).some(part => {
        const neg = part.match(/^\.([\w-]+):not\(\.([\w-]+)\)$/);
        if (neg) return node.hasClass(neg[1]) && !node.hasClass(neg[2]);
        const classes = part.replace(/^\./, '').split('.').filter(Boolean);
        return classes.length > 0 && classes.every(c => node.hasClass(c));
    });
    const walk = (node, out) => { out.push(node); node.children.forEach(c => walk(c, out)); return out; };

    const el = (className, dataset = {}, children = []) => {
        const classes = new Set(className.split(/\s+/).filter(Boolean));
        const node = {
            className, dataset, children, parent: null, tag: 'DIV',
            classes,
            hasClass: c => classes.has(c),
            classList: {
                add: c => classes.add(c),
                remove: c => classes.delete(c),
                toggle: c => (classes.has(c) ? classes.delete(c) : classes.add(c)),
                contains: c => classes.has(c)
            },
            closest(sel) {
                for (let n = node; n; n = n.parent) if (matches(n, sel)) return n;
                return null;
            },
            querySelectorAll() { return []; },
            contains(other) {
                for (let n = other; n; n = n.parent) if (n === node) return true;
                return false;
            },
            setPointerCapture() {}, releasePointerCapture() {}
        };
        children.forEach(c => { c.parent = node; });
        return node;
    };

    const tree = {};
    tree.sections = [0, 1].map(i => {
        const title = el('category-title');
        const dragHandle = el('category-action category-drag');
        const editBtn = el('category-action category-edit');
        // 用 el() 的 children 参数（它负责设 parent），不要建完再 push：
        // 手工 push 不会设 parent，closest 往上走就断链，
        // 于是「在 ✎ 上按下」找不到分类头，守卫看起来生效其实没走到。
        const header = el('category-header', {}, [title, dragHandle, editBtn]);
        const cards = el('bookmarks', {}, [el('bookmark', { cat: String(i), bm: '0' }, [el('bookmark-title')])]);
        const section = el('category', { cat: String(i) }, [header, cards]);
        return { section, header, title, dragHandle, editBtn, cards, card: cards.children[0] };
    });
    const all = [];
    tree.sections.forEach(s => walk(s.section, all));
    // grid 的 querySelectorAll 按已存在的 class 过滤（$$ 用它清 drop-target）
    tree.grid = {
        nodes: all,
        querySelectorAll(sel) { return all.filter(n => matches(n, sel)); }
    };
    tree.matches = matches;
    return tree;
}

/**
 * 把 bindTouchGridDrag 的真实方法体摘出来执行。
 *
 * 触摸路径的判据全在**时序**里（长按 400ms、容忍 25px），所以桩必须能
 * 推进定时器——否则「长按满 400ms 才激活」这条永远验不到，测试只能退化成
 * 读源码文本。elementFromPoint 也由桩注入，让落点可精确指定。
 */
function mountTouchDrag({ editLayout = true, hit: initialHit } = {}) {
    const calls = [];
    // 落点可改：一个用例里往往要「先按在这里、再拖到那里」
    let hit = initialHit;
    const config = {
        categories: [
            { name: 'A', bookmarks: [{ title: 'a1' }, { title: 'a2' }] },
            { name: 'B', bookmarks: [] }
        ]
    };
    const dom = makeDom();

    const gridListeners = {};
    const windowListeners = {};
    // grid 用真实节点树：$$('.category.drop-target', grid) 要能查到刚加上的 class
    const grid = {
        nodes: dom.grid.nodes,
        querySelectorAll: sel => dom.grid.querySelectorAll(sel),
        addEventListener: (t, f, o) => { (gridListeners[t] ||= []).push({ fn: f, o }); },
        removeEventListener: (t, f) => {
            if (!gridListeners[t]) return;
            gridListeners[t] = gridListeners[t].filter(x => x.fn !== f);
        }
    };

    // 可推进的定时器：记录 pending，长按推进时才真正触发
    let now = 0;
    const timers = [];
    let nextId = 1;
    const setTimeoutStub = (fn, ms) => {
        const id = nextId++;
        timers.push({ id, fn, at: now + ms });
        return id;
    };
    const clearTimeoutStub = id => {
        const i = timers.findIndex(t => t.id === id);
        if (i >= 0) timers.splice(i, 1);
    };

    const app = {
        editLayout,
        config,
        moveCategory: (from, to) => calls.push(['cat', from, to]),
        moveBookmark: (fc, fb, tc, tb) => calls.push(['bm', fc, fb, tc, tb]),
        renderGrid() {}, markConfigDirty() {}
    };

    const mount = vm.runInNewContext(`(function (deps) {
        const $ = () => deps.grid;
        const $$ = (sel, root) => (root || deps.grid).querySelectorAll(sel);
        const document = deps.document;
        const setTimeout = deps.setTimeout;
        const clearTimeout = deps.clearTimeout;
        const window = deps.window;
        ${methodBody(appSource, 'bindTouchGridDrag')}
    })`);
    mount.call(app, {
        grid, document: { elementFromPoint: () => hit },
        setTimeout: setTimeoutStub, clearTimeout: clearTimeoutStub,
        window: {
            addEventListener: (t, f) => { (windowListeners[t] ||= []).push(f); },
            removeEventListener: (t, f) => {
                if (!windowListeners[t]) return;
                windowListeners[t] = windowListeners[t].filter(x => x !== f);
            }
        }
    });

    const fireWindow = (type, event) =>
        (windowListeners[type] || []).forEach(fn => fn(event));

    // 真实 PointerEvent 都有这几个字段/方法，桩必须一起给：
    //  · button: 0 —— 处理器第一行就是 `event.button !== 0` 早退，
    //    漏掉它所有「不该动」的用例会**空过**（因为处理器压根没跑），
    //    读起来像守卫有效，其实什么都没验。
    //  · preventDefault / stopPropagation —— move 的第一行就会调，
    //    缺了整个处理器直接抛异常。
    const evt = opts => ({
        pointerType: 'touch', pointerId: 1, button: 0,
        clientX: 0, clientY: 0,
        preventDefault() {}, stopPropagation() {},
        ...opts
    });

    return {
        calls, config, grid, timers, gridListeners,
        sections: dom.sections,
        setHit: node => { hit = node; },
        // 推进定时器：只触发到期的
        advance: ms => {
            now += ms;
            const due = timers.filter(t => t.at <= now);
            for (const t of due) {
                clearTimeoutStub(t.id);
                const i = timers.indexOf(t);
                if (i >= 0) timers.splice(i, 1);
                t.fn();
            }
        },
        pendingTimers: () => timers.length,
        down: (target, opts = {}) => (gridListeners.pointerdown || []).forEach(
            x => x.fn(evt({ ...opts, target }))),
        move: (opts = {}) => fireWindow('pointermove', evt(opts)),
        up: (opts = {}) => fireWindow('pointerup', evt(opts)),
        cancel: (opts = {}) => fireWindow('pointercancel', evt(opts))
    };
}

test('触摸拖拽必须长按满 400ms 才激活，且期间漂移超过 25px 即取消', () => {
    // 判据是触摸端唯一真正的难点：一按就拖会抢走滚动，纯位移阈值会在
    // 滑页途中误判。所以「长按 400ms + 容忍 25px」这两个数就是要验的东西。
    const body = stripComments(methodBody(appSource, 'bindTouchGridDrag'));
    assert.match(body, /HOLD_MS = 400/, '长按阈值 400ms');
    assert.match(body, /HOLD_TOLERANCE = 25/, '漂移容忍 25px');
    // 不写 touch-action: none —— 写了书签网格就滚不动了
    const css = stripComments(stylesCss);
    const editBlock = /\.grid\.is-editing \.bookmark\s*,\s*\.grid\.is-editing \.category-header\s*\{([^}]*)\}/
        .exec(css);
    assert.ok(editBlock, '编辑态书签卡与分类头有共享规则');
    assert.doesNotMatch(editBlock[1], /touch-action\s*:\s*none/,
        '书签网格不能写 touch-action: none —— 那会让首页滚不动');
    assert.match(editBlock[1], /user-select\s*:\s*none/, '编辑态关掉文字选中，否则长按先选中文字');
    assert.match(editBlock[1], /-webkit-touch-callout\s*:\s*none/, '关掉 iOS 长按菜单');
});

test('触摸拖拽只接触摸，鼠标仍走已验证的原生 DnD', () => {
    // 两条路径必须互不重叠：桌面端若也进触摸路径，就要额外处理
    // 「一按就拖 vs 选文字」，那是对已验证路径的回归风险。
    const body = stripComments(methodBody(appSource, 'bindTouchGridDrag'));
    const guard = body.indexOf("event.pointerType !== 'touch'");
    assert.ok(guard >= 0, '触摸路径必须按 pointerType 过滤');
    // 守卫要在建 hold 之前
    const hold = body.indexOf('hold = {');
    assert.ok(hold > guard, '过滤早于建立长按状态');
});

test('长按未满就松手不算一次拖拽', () => {
    const t = mountTouchDrag();
    t.down(t.sections[0].header);
    // ⚠️ 先证明处理器**真的跑到了**：桩若漏字段（例如 button），
    // 处理器第一行就早退，calls 空——这条用例会空过并假装守卫有效。
    assert.equal(t.pendingTimers(), 1, '按下后必须挂起一个长按定时器');
    t.advance(200);          // 只按住 200ms
    t.up();
    assert.deepEqual(t.calls, [], '未满 400ms 就松手不该移动任何东西');
});

test('长按期间漂移超过容忍 = 用户在滚动，不激活', () => {
    const t = mountTouchDrag();
    t.down(t.sections[0].header);
    assert.equal(t.pendingTimers(), 1, '按下后必须挂起一个长按定时器');
    t.advance(100);
    t.move({ clientX: 30, clientY: 0 });   // 漂移 30px > 25px
    assert.equal(t.pendingTimers(), 0, '漂移超过容忍必须取消长按');
    t.advance(1000);                        // 再等多久也不该激活
    t.up();
    assert.deepEqual(t.calls, [], '漂移超过容忍后即使再按住也不该拖');
});

test('长按满 400ms 但一直没动 = 长按，不是拖拽', () => {
    // 只按键不动：drag.to 仍是 null，不该把元素挪到任何地方。
    // 这条与「按满就提交」的写法只差一个 moved 判断，而那正是要钉的。
    const t = mountTouchDrag();
    t.down(t.sections[0].header);
    assert.equal(t.pendingTimers(), 1, '按下后必须挂起一个长按定时器');
    t.advance(400);          // 激活
    // is-dragging 加在**整块分类**上（CSS 就是 .category.is-dragging，
    // 拖动时整个分类压暗），不是加在分类头那个把手元素上。
    assert.ok(t.sections[0].section.hasClass('is-dragging'), '满 400ms 确实激活了');
    assert.ok(t.sections[0].header.hasClass('is-arming') === false, '激活后长按提示退场');
    t.up();
    assert.deepEqual(t.calls, [], '长按不动不该产生任何移动');
});

test('在 ✎ 上长按不起拖，在 ⠿ 上才起拖', () => {
    // 分类头是拖拽宿主，✎/✕ 在它里面。触摸端必须与桌面端同样排除 ✎/✕，
    // 否则长按按钮会起拖并抑制随后的 click，重命名/删除对话框打不开。
    // ⠿ 是不同的东西：它是拖拽把手，本来就该能起拖。
    const t = mountTouchDrag();
    const edit = t.sections[0].editBtn;
    const handle = t.sections[0].header.children.find(c => c.hasClass('category-drag'));

    t.down(edit);
    // ⚠️ 用「有没有挂起长按定时器」而不是只看 calls：排除发生在建定时器**之前**，
    // 若桩的 closest 太薄导致 node 找不到，也会得出空 calls——两者必须分得开。
    assert.equal(t.pendingTimers(), 0, '✎ 上按下不该挂起长按定时器');
    t.advance(1000);
    t.up();

    t.down(handle);
    assert.equal(t.pendingTimers(), 1, '⠿ 把手上按下要挂起长按定时器');
    t.advance(400);
    assert.ok(t.sections[0].section.hasClass('is-dragging'), '⠿ 上长按确实激活了');
    t.up();

    assert.deepEqual(t.calls, [], '无论哪条路径，没移动就不该提交');
});

test('取消的触摸拖拽不留压暗：压暗谁就要复原谁', () => {
    // ⚠️ 这条抓的是一个真实泄漏：分类拖拽压暗的是**整块 section**
    // （CSS 就是 .category.is-dragging），而收尾若是按分类头去 remove，
    // section 上那层永远清不掉。提交时因为 renderGrid 重建 DOM 而被掩盖，
    // 但取消（落点无效 / 漂移后松手）时压暗就留在页面上。
    const t = mountTouchDrag();
    const src = t.sections[0];
    t.down(src.header);
    t.advance(400);
    assert.ok(src.section.hasClass('is-dragging'), '激活后整块分类被压暗');
    // 不移动就直接松手：落点为 null → 不提交 → 走取消路径
    t.up();
    assert.equal(src.section.hasClass('is-dragging'), false,
        '取消后 section 上的压暗必须清掉（压暗谁就要复原谁）');
    assert.deepEqual(t.calls, [], '没有落点就不该提交');

    // 书签路径同样要有始有终
    const t2 = mountTouchDrag();
    const card = t2.sections[0].card;
    t2.down(card);
    t2.advance(400);
    assert.ok(card.hasClass('is-dragging'), '激活后书签卡被压暗');
    t2.up();
    assert.equal(card.hasClass('is-dragging'), false, '取消后书签卡的压暗也要清');
});

test('长按满 400ms 后拖到另一分类，提交 moveCategory', () => {
    // 端到端跑真实方法体：按下 → 等满 400ms → 移动 → 松手。
    // 这是触摸路径唯一真正为真的部分（时序 + 落点），桩只提供时钟与命中点。
    const t = mountTouchDrag();
    const source = t.sections[0].header;
    t.setHit(t.sections[1].header);
    t.down(source, { pointerId: 5 });
    t.advance(399);
    assert.deepEqual(t.calls, [], '399ms 还没满，不该动');
    t.advance(1);                            // 满 400ms → 激活
    t.move({ pointerId: 5, clientX: 100, clientY: 100 });
    t.up({ pointerId: 5 });
    assert.deepEqual(t.calls, [['cat', 0, 1]],
        '长按激活后拖到第二个分类必须调用 moveCategory(0, 1)');
});

test('触摸路径复用桌面的 moveBookmark，不另写一套排序', () => {
    // 两套排序实现就有两个真值，两边拖出不同结果时无从判断该信哪个
    const body = methodBody(appSource, 'bindTouchGridDrag');
    assert.match(body, /this\.moveCategory\(/, '分类排序走同一个 moveCategory');
    assert.match(body, /this\.moveBookmark\(/, '书签排序走同一个 moveBookmark');
    assert.doesNotMatch(body, /splice\(/,
        '触摸路径不得直接改数组 —— 那样就是第二套排序实现');
});

test('触摸路径的残留清理与桌面路径对称', () => {
    // 三样都要清：长按提示、拖拽态、落点高亮。少一样就是「看起来卡住了」。
    const body = methodBody(appSource, 'bindTouchGridDrag');
    assert.match(body, /classList\.remove\('is-arming'\)/, '清长按提示');
    assert.match(body, /classList\.remove\('is-dragging'\)/, '清拖拽态');
    assert.match(body, /\.category\.drop-target/, '清落点高亮');
    // pointercancel 必须与 pointerup 同等待遇：系统中断手势只走 cancel
    assert.match(body, /addEventListener\('pointercancel', settle\)/,
        'pointercancel 也走 settle，否则系统中断手势会卡住状态');
});

test('后台彻底没有书签分类分区，书签只在首页编辑', () => {
    // 首页编辑模式上线后，后台那份编辑器（#catsEditor / renderCatsEditor /
    // bindEditorDrag / #addCat）连同它的 CSS 与整个「书签分类」分区一起删除。
    // 这里钉住两件事：容器与分区都不在后台模板里，编辑能力没有被删掉——
    // 用户要改书签得有一条明确的路，而不是发现功能凭空消失。
    const code = stripComments(appSource);
    // 后台模板里既没有容器，也没有分区标题
    assert.doesNotMatch(appSource, /id="catsEditor"/,
        '后台模板里不应再有 #catsEditor 容器');
    assert.doesNotMatch(appSource, /id="addCat"/,
        '后台模板里不应再有 #addCat 按钮');
    for (const dead of ['renderCatsEditor(', 'bindEditorDrag(']) {
        assert.ok(!code.includes(dead), `${dead} 应已随后台书签编辑器一起删除`);
    }
    // 五个 CSS 选择器在 app.js 里已零引用，一并清掉了。
    for (const sel of ['bookmarks-list', 'bookmark-item', 'cat-toggle', 'cat-count', 'item-drag']) {
        assert.ok(!code.includes(sel), `${sel} 在 JS 里零引用，CSS 也应已删除`);
        assert.ok(!fullCode.includes(sel), `styles.css 里不应再有 ${sel}`);
        assert.ok(!adminCode.includes(sel), `admin.css 里不应再有 ${sel}`);
    }
    // 编辑能力必须还在。后台不再保留任何指路文案——
    // 用户要改书签就去首页点「编辑」，那里是唯一入口。
    for (const alive of ['addHomeBookmark', 'editHomeBookmark', 'deleteHomeBookmark',
        'addHomeCategory', 'renameHomeCategory', 'deleteHomeCategory']) {
        assert.match(code, new RegExp(`${alive}\\s*\\(`), `${alive} 仍是首页编辑的入口`);
    }
    // 整个「书签分类」分区已从后台模板里消失（不只是容器被清空）
    assert.doesNotMatch(appSource, /<div class="section-title">书签分类<\/div>/,
        '后台不再有「书签分类」分区——不留空壳也不留指路文案');
    assert.doesNotMatch(appSource, /书签与分类请在首页/,
        '后台不再有指向首页编辑的提示文案');
});

test('搜索引擎编辑器不受影响：它与书签编辑器共用过 .item 与 .add-btn', () => {
    // 删除书签编辑器时最容易误伤的一条：搜索引擎编辑器用的是
    // .item / .item-row / .item-header / .add-btn，与被删的那些同名。
    //
    // ⚠️ 断言要钉住**面板初始化处的那一次调用**，不只是「这个字符串在切片里」。
    // 方法体内还有第二处调用（#addEngine 的 onclick 回调里），所以
    // `assert.match(panel, /this\.renderEnginesEditor\(\)/)` 在删掉初始化
    // 调用后照样匹配——实测过，守卫是假绿的。判据必须是「紧跟在
    // bindAdminTabs() 之后」：这两行是面板每次渲染的固定序列。
    const code = stripComments(appSource);
    assert.match(code, /id="enginesEditor"/, '搜索引擎编辑器容器在');
    assert.match(code, /id="addEngine"/, '「添加搜索引擎」按钮在');
    const panel = methodBody(appSource, 'renderAdminPanel');
    assert.match(panel, /this\.bindAdminTabs\(\);\s*\n\s*this\.renderEnginesEditor\(\);/,
        '面板初始化时紧接着渲染搜索引擎编辑器——删掉这一步面板就空着');
    assert.match(appSource, /class="item-row"/, '共用的 .item-row 仍在用');
    assert.match(appSource, /class="item" data-idx=/, '共用的 .item 仍在用');
    assert.match(fullCode, /\.item-row\s*\{/, '共用的 .item-row 样式仍在');
    assert.match(adminCode, /\.modal \.add-btn\s*\{/, '共用的 .add-btn 样式仍在');
});

test('＋占位卡与真实书签卡同尺寸，否则网格错位', () => {
    // .bookmarks 是 grid auto-fill，尺寸不同会让整行高度被占位卡拉偏。
    const addRule = ruleBlock(fullCode, '.bookmark-add', 'min-height');
    assert.match(addRule, /min-height:\s*42px/, '＋卡片 min-height 42px');
    // 真实书签卡的 42px 来自材质层的合并规则
    assert.match(fullCode, /\.bookmark,\.bookmark-text-only\s*\{[^}]*min-height:\s*42px/,
        '真实书签卡的 min-height 同样是 42px（材质层 styles.css:2848）');
    const addRadius = /border-radius:\s*([\d.]+px)/.exec(addRule);
    const realRadius = /border-radius:\s*([\d.]+px)/.exec(fullCode.slice(
        fullCode.indexOf('.bookmark,.bookmark-text-only {')
    ));
    assert.equal(addRadius[1], '7px', '＋卡片圆角 7px');
    assert.equal(realRadius[1], '7px', '真实书签卡圆角同为 7px');
});

test('编辑态显隐只由 .grid.is-editing 控制，JS 不写 hidden', () => {
    // 与模块拖拽把手同一条纪律：hidden 属性压过任何 CSS，
    // 而 editLayout 在挂载时几乎总是 false，控件会实测 0×0、点不到。
    assert.doesNotMatch(stripComments(appSource), /\.category-action[^\n]*\.hidden\s*=/,
        '分类按钮的显隐交给 CSS，JS 不得写 hidden');
    assert.doesNotMatch(stripComments(appSource), /bookmark-add[^\n]*\.hidden\s*=/,
        '＋卡片的显隐交给 CSS，JS 不得写 hidden');
    assert.match(fullCode, /\.grid\.is-editing \.category-action\s*\{[^}]*display:\s*inline-flex/,
        '编辑态必须让分类按钮显形');
    assert.match(fullCode, /\.category-action\s*\{[^}]*display:\s*none/,
        '非编辑态分类按钮隐藏');
});

test('.grid.is-editing 规则只有一处定义，不会被尾部覆盖', () => {
    // 同优先级下后写的赢。本仓库已因尾部重复声明让前部规则静默失效
    // 两次（.category-tree-children、.search.paste-mode .search-input）。
    // 枚举**同一个选择器**的声明次数，而不是数规则条数——后者会随
    // 新增选择器自然变化，测不出「同一个选择器写了两次」。
    const declared = [...fullCode.matchAll(/(^|[},;]\s*)\.grid\.is-editing\s+([^{@]+?)\s*[,{]/g)]
        .map(m => m[2].trim());
    assert.ok(declared.length >= 4,
        `编辑态规则按选择器拆成若干条，实际 ${declared.length} 条：${declared.join(' / ')}`);
    const seen = [];
    const dup = declared.filter(sel => {
        if (seen.includes(sel)) return true;
        seen.push(sel);
        return false;
    });
    assert.deepEqual(dup, [], `以下选择器在 .grid.is-editing 下被声明了两次：${dup.join(', ')}`);
});

test('首页第一屏没有因为编辑模式变重', () => {
    // 编辑模式的全部代码在 app.js 里（首页本来就要加载它），
    // 样式也在既有文件内，没有新增资源或新增请求。
    assert.doesNotMatch(indexHtml, /edit-mode|editMode/,
        '首页不引入额外的编辑模式资源');
    const swAssets = fs.readFileSync(path.join(__dirname, '..', 'public/sw.js'), 'utf8');
    const precached = [...swAssets.matchAll(/'(\/?[^']+\.(?:js|css))'/g)].map(m => m[1]);
    assert.ok(!precached.some(p => /edit/i.test(p)),
        '预缓存清单里没有新增的编辑模式文件');
});

// ========== 右下角「外观」三态按钮 ==========
//
// 把后台的「主题模式」搬到前台，未登录也可见。未登录访客写不了服务端配置
// （POST /api/config 要管理员），所以选择只能存本机 localStorage；
// 登录后点它则等同于改站点主题，与后台下拉框是同一份状态。

const appCode = stripComments(appSource);
const indexCode = stripComments(indexHtml);

/** 按大括号配对取出一个方法的完整方法体（含首尾大括号）。 */
function methodBodyOf(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} 存在`);
    const open = start + signature.length - 1;
    assert.equal(src[open], '{', `${signature} 的签名以 { 收尾`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`${signature} 方法体未闭合`);
}

test('外观按钮在右下角 dock 内、排在「编辑」与「管理」之间，且不随登录态隐藏', () => {
    const dockStart = indexCode.indexOf('class="utility-dock"');
    assert.ok(dockStart > 0, '首页仍有 dock');
    const dock = indexCode.slice(dockStart, indexCode.indexOf('</nav>', dockStart));
    assert.ok(dock.length > 100, '取到 dock 区块');

    const order = ['id="helpBtn"', 'id="layoutBtn"', 'id="appearanceBtn"', 'id="adminBtn"']
        .map(id => dock.indexOf(id));
    assert.ok(order.every(i => i >= 0), '四个按钮都在 dock 内');
    assert.deepEqual(order, [...order].sort((a, b) => a - b), '顺序：说明 → 编辑 → 外观 → 管理');

    // 「编辑」靠 hidden 控制登录可见性；外观按钮带上 hidden 未登录就看不到，
    // 而这正是本次要求「未登录也可见」的那一半。
    const btnTag = indexCode.match(/<button[^>]*id="appearanceBtn"[^>]*>/)[0];
    assert.doesNotMatch(btnTag, /\bhidden\b/, '外观按钮不随登录态隐藏');
    assert.doesNotMatch(appCode, /appearanceBtn'\)\.hidden\s*=/, 'JS 里也不隐藏它');
});

test('本机主题的键名在 index.html 与 app.js 两处一致', () => {
    const keyInApp = appCode.match(/const THEME_STORAGE_KEY = '([^']+)'/);
    const keyInHtml = indexCode.match(/localStorage\.getItem\('([^']+)'\)/);
    assert.ok(keyInApp, 'app.js 定义了 THEME_STORAGE_KEY');
    assert.ok(keyInHtml, 'index.html 内联脚本读了本机主题');
    // 两处不一致的话，内联脚本永远读不到访客的选择，首屏就会先按系统色画一遍
    assert.equal(keyInHtml[1], keyInApp[1], '跨文件的键名必须一致');
});

test('本机主题抢在样式表之前应用，首屏不闪系统色', () => {
    const applyAt = indexHtml.indexOf("localStorage.getItem('nav-sylph-theme')");
    const cssAt = indexHtml.indexOf('<link rel="stylesheet" href="styles.css">');
    assert.ok(applyAt > 0 && cssAt > 0, '两处都能定位');
    assert.ok(applyAt < cssAt, '读本机主题必须在 styles.css 之前');
    assert.match(indexCode, /setAttribute\('data-theme', storedTheme\)/);
    // 只认同明确的两种强制态；'auto' 要留给 prefers-color-scheme
    assert.match(indexCode, /storedTheme === 'light' \|\| storedTheme === 'dark'/,
        'auto 不写死，交给 CSS 的媒体查询');
});

test('resolveTheme：本机覆盖优先，其次服务端站点主题，最后默认自动', () => {
    const key = appCode.match(/const THEME_STORAGE_KEY = '([^']+)'/)[1];
    const body = methodBodyOf(appCode, 'resolveTheme() {');
    const sandbox = {
        localStorage: { getItem: k => (k === key ? 'dark' : null) },
        THEME_STORAGE_KEY: key,
        APPEARANCE_ORDER: ['auto', 'light', 'dark']
    };
    const resolveTheme = vm.runInNewContext(`(function () ${body})`, sandbox);
    const ctx = { config: { theme: 'light' } };

    assert.equal(resolveTheme.call(ctx), 'dark', '本机选过就用本机');
    sandbox.localStorage.getItem = () => null;
    assert.equal(resolveTheme.call(ctx), 'light', '本机没选过才用服务端的站点主题');
    assert.equal(resolveTheme.call({ config: {} }), 'auto', '两者都没有时默认跟随系统');
    // 本机存了不可识别的值（旧版本残留、被手改）不能变成「无主题」
    sandbox.localStorage.getItem = () => 'purple';
    assert.equal(resolveTheme.call(ctx), 'light', '非法值忽略，回落到服务端值');
});

test('三态循环：自动 → 浅色 → 深色 → 自动（取模回绕）', () => {
    const order = appCode.match(/const APPEARANCE_ORDER = \[([^\]]+)\]/);
    assert.ok(order, '定义了循环顺序');
    assert.deepEqual(
        order[1].split(',').map(s => s.trim().replace(/'/g, '')),
        ['auto', 'light', 'dark']
    );
    const cycle = methodBodyOf(appCode, 'cycleTheme() {');
    assert.match(cycle, /% APPEARANCE_ORDER\.length/,
        '取模回绕——少了它深色之后就不再变（或越界成 undefined）');
});

test('未登录只写本机，登录后改的是服务端站点主题', () => {
    const body = methodBodyOf(appCode, 'async setTheme(theme) {');
    const guestStart = body.indexOf('if (!this.authenticated) {');
    assert.ok(guestStart >= 0, '有未登录分支');
    const guest = body.slice(guestStart, body.indexOf('return;', guestStart));
    assert.match(guest, /localStorage\.setItem\(THEME_STORAGE_KEY, theme\)/, '未登录写本机');
    assert.doesNotMatch(guest, /api\/config/, '未登录不发保存请求（服务端也会 401）');

    // 登录分支：先清本机覆盖再写服务端 —— 顺序反了的话，本机旧值会一直压过刚写下的值
    const clearAt = body.indexOf('localStorage.removeItem(THEME_STORAGE_KEY)');
    const saveAt = body.indexOf("API.post('/api/config'");
    assert.ok(clearAt > guestStart && saveAt > clearAt, '先清本机覆盖，再保存服务端');
    assert.match(body, /this\.config\.theme = previous[\s\S]*?this\.applyTheme\(\)/,
        '保存失败要还原，不能把界面停在一个没存住的档位上');
});

test('按钮的图标与无障碍文案跟着当前态走', () => {
    const fn = methodBodyOf(appCode, 'renderAppearanceButton(theme) {');
    assert.match(fn, /icon\.innerHTML = APPEARANCE_ICONS\[theme\]/, '图标随状态更换');
    // 图标是纯视觉，aria-label 才是读屏用户拿到的唯一信息，必须同源
    assert.match(fn, /btn\.setAttribute\('aria-label', label\)/, 'aria-label 同步更新');
    const icons = appCode.match(/const APPEARANCE_ICONS = \{([\s\S]*?)\n    \};/);
    assert.ok(icons, '图标表存在');
    ['auto', 'light', 'dark'].forEach(k =>
        assert.ok(new RegExp(`(^|\\s)${k}:`).test(icons[1]), `${k} 态有图标`));
});

test('外观按钮与旁边按钮同高、只收窄宽度，触摸目标不缩水', () => {
    const rule = code.match(/\.utility-dock \.appearance-btn \{([^}]*)\}/);
    assert.ok(rule, '材质层有 .utility-dock .appearance-btn 规则');
    assert.match(rule[1], /width:\s*40px/, '宽度收窄成图标按钮');
    assert.match(rule[1], /min-height:\s*44px/,
        '高度不缩水——32–36px 低于触摸目标底线，手机上会误触紧邻的「管理」');
    assert.match(fullCode, /\.appearance-btn:focus-visible/, '键盘可达');
});

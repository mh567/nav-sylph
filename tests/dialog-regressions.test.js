const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const adminCss = fs.readFileSync(path.join(__dirname, '..', 'public/admin.css'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public/styles.css'), 'utf8');
const exportPoint = '    let app;\n';
assert.equal(source.split(exportPoint).length, 2);

// 取出某个 @media 块的正文。一个查询在文件里可能出现多次（如 ≤768px），
// requiredIn 用来指定目标块必须包含的标记，否则返回第一个同查询的块——
// 那可能根本不是要断言的那个。
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
    assert.ok(blocks.length > 0, `样式表里存在 ${query}`);
    return blocks;
}

function mediaBlock(css, query, requiredIn) {
    const blocks = mediaBlocks(css, query);
    if (!requiredIn) return blocks[0];
    const match = blocks.find(body => body.includes(requiredIn));
    assert.ok(match, `${query} 中存在包含 ${requiredIn} 的块（共 ${blocks.length} 个同查询块）`);
    return match;
}

function loadApp(document) {
    const window = {};
    vm.runInNewContext(source.replace(exportPoint, '    window.AppForTest = App;\n' + exportPoint), {
        window,
        document,
        setTimeout,
        clearTimeout
    });
    return Object.create(window.AppForTest.prototype);
}

// 解析对话框模板，收集输入项及其所属区块。
// 记录完整的祖先链（ancestors），因为选项可能嵌在 .ui-dialog-group 之类的
// 包装层里，浏览器按最近的 .ui-dialog-option 判定归属，不能只看最内层 div。
function parseInputs(htmlString) {
    const tokenRe = /<div\b[^>]*>|<\/div>|<input\b([^>]*)>/g;
    const stack = [];
    const inputs = [];
    let match;
    while ((match = tokenRe.exec(htmlString))) {
        if (match[0] === '</div>') { stack.pop(); continue; }
        if (match[0].startsWith('<div')) {
            const cls = /class="([^"]*)"/.exec(match[0]);
            const name = /data-name="([^"]*)"/.exec(match[0]);
            stack.push({ cls: cls ? cls[1] : '', name: name ? name[1] : '', dataset: { name: name ? name[1] : '' } });
            continue;
        }
        const attrs = {};
        const attrRe = /([a-z-]+)="([^"]*)"/g;
        let attr;
        while ((attr = attrRe.exec(match[1]))) attrs[attr[1]] = attr[2];
        const ancestors = stack.slice();
        // 归属取链上最近的 .ui-dialog-option，与浏览器语义一致
        const owner = ancestors.slice().reverse().find(node => node.cls.includes('ui-dialog-option'))
            || ancestors.at(-1)
            || { cls: '', name: '', dataset: { name: '' } };
        inputs.push({ attrs, parent: owner, ancestors });
    }
    return inputs;
}

// 最小 DOM 桩：只实现 showUiDialog 实际使用到的选择器与行为
function createDocument() {
    const state = { dialog: null, activeElement: null };
    const returnFocus = { isConnected: true, focus() { state.activeElement = returnFocus; } };
    state.activeElement = returnFocus;

    class El {
        constructor(kind, props = {}) {
            Object.assign(this, props);
            this.kind = kind;
            this.listeners = {};
            this.removed = false;
            this.focused = false;
            this.value = props.attrs ? (props.attrs.value || '') : (props.value || '');
            this.checked = props.attrs ? 'checked' in props.attrs : !!props.checked;
            this.type = props.attrs ? (props.attrs.type || 'text') : 'text';
            this.name = props.attrs ? (props.attrs.name || '') : '';
            this.parent = props.parent || { cls: '', name: '', dataset: { name: '' } };
            this.dataset = { name: this.parent.name || '' };
            this.hidden = !!props.hidden;
            this.textContent = '';
        }
        addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
        fire(name, event) { (this.listeners[name] || []).forEach(fn => fn(event)); }
        remove() { this.removed = true; }
        focus() { this.focused = true; state.activeElement = this; }
        // 分组内的选项向上找最近的 .ui-dialog-option，模拟浏览器的祖先匹配
        closest(selector) {
            if (selector !== '.ui-dialog-option') return null;
            const chain = this.ancestors || [this.parent];
            return chain.slice().reverse().find(node => node.cls.includes('ui-dialog-option')) || null;
        }
    }

    const document = {
        readyState: 'loading',
        get activeElement() { return state.activeElement; },
        set activeElement(value) { state.activeElement = value; },
        addEventListener() {},
        body: { appendChild(node) { state.dialog = node; } },
        createElement(tag) {
            assert.equal(tag, 'template');
            return {
                set innerHTML(value) { this.content = { firstChild: buildOverlay(value) }; },
                content: null
            };
        }
    };

    function buildOverlay(htmlString) {
        const parsed = parseInputs(htmlString);
        // 保留原始模板，供断言 DOM 顺序（PIN 输入框必须紧跟它的复选框）
        parsed.markup = htmlString;
        const fieldInputs = parsed
            .filter(i => (i.attrs.name || '').startsWith('field') || i.parent.cls.includes('ui-dialog-reveal'))
            .map(i => new El('input', i));
        const optionInputs = parsed
            .filter(i => i.parent.cls.includes('ui-dialog-option'))
            .map(i => new El('input', i));

        // 浏览器按 input 的 name 分组实现 radio 原生互斥，因此这里也按 name 分组。
        // 若生产代码给同组选项生成了不同 name，这个桩会暴露互斥失效，测试随即失败。
        const radioGroups = new Map();
        optionInputs.forEach(input => {
            if (input.type !== 'radio') return;
            const group = input.name;
            if (!radioGroups.has(group)) radioGroups.set(group, []);
            radioGroups.get(group).push(input);
        });
        optionInputs.forEach(input => {
            if (input.type !== 'radio') return;
            input.addEventListener('change', () => {
                if (!input.checked) return;
                radioGroups.get(input.name).forEach(other => { if (other !== input) other.checked = false; });
            });
        });

        const reveal = htmlString.includes('ui-dialog-reveal') ? new El('div', { hidden: true }) : null;
        if (reveal) {
            const revealInput = fieldInputs.find(i => i.parent.cls.includes('ui-dialog-reveal'));
            reveal.querySelector = () => revealInput;
        }

        const error = new El('div', {});
        const form = new El('form', {});
        form.queryButton = () => new El('button', { type: 'submit' });
        form.querySelector = selector => (selector === 'button[type="submit"]' ? form.queryButton() : null);

        const cancelButton = new El('button', {});
        const submitButton = form.queryButton();
        const allFocusables = [...fieldInputs, ...optionInputs, cancelButton, submitButton];

        const dialog = new El('div', {});
        const overlay = new El('div', {});
        overlay.querySelector = selector => ({
            '.ui-dialog': dialog,
            'form': form,
            '.ui-dialog-reveal': reveal,
            '.ui-dialog-error': error
        })[selector] || null;
        overlay.querySelectorAll = selector => {
            if (selector === 'input[name^="field"], .ui-dialog-reveal input') return fieldInputs;
            if (selector === '.ui-dialog-option input') return optionInputs;
            if (selector === 'input, button') return allFocusables;
            return [];
        };
        overlay.closest = () => null;
        overlay.markup = htmlString;
        return overlay;
    }

    return { document, state };
}

test('backdrop dismissal and cancellation never create a share', async () => {
    const { document, state } = createDocument();
    const app = loadApp(document);
    const shares = [];
    app.createPaste = async (...args) => { shares.push(args); };

    const pending = app.showPasteOptions('private text');
    await new Promise(resolve => setImmediate(resolve));

    const overlay = state.dialog;
    // 点击遮罩：面板不应关闭，也不应创建分享
    overlay.fire('click', { target: overlay });
    assert.equal(overlay.removed, false);
    assert.equal(shares.length, 0);

    // 点击取消：同样不创建分享
    const cancelButton = { closest: selector => (selector === '[data-action="cancel"]' ? {} : null) };
    overlay.fire('click', { target: cancelButton });
    await pending;
    assert.deepEqual(shares, []);
});

test('default settings create a share without PIN or expiry override', async () => {
    const { document, state } = createDocument();
    const app = loadApp(document);
    const shares = [];
    app.createPaste = async (...args) => { shares.push(args); };

    const pending = app.showPasteOptions('hello');
    await new Promise(resolve => setImmediate(resolve));

    // 保持默认：不勾选 PIN，有效期停在 5 分钟
    const overlay = state.dialog;
    const form = overlay.querySelector('form');
    form.fire('submit', { preventDefault() {} });
    await pending;

    assert.equal(shares.length, 1);
    // 默认档位不传第三个参数，保持既有 createPaste 两参数契约
    assert.equal(shares[0].length, 2);
    assert.deepEqual(Array.from(shares[0]), ['hello', null]);
});

test('PIN and expiry selections are forwarded to createPaste', async () => {
    const { document, state } = createDocument();
    const app = loadApp(document);
    const shares = [];
    app.createPaste = async (...args) => { shares.push(args); };

    const pending = app.showPasteOptions('secret');
    await new Promise(resolve => setImmediate(resolve));

    const overlay = state.dialog;
    const pinBox = overlay.querySelectorAll('.ui-dialog-option input').find(i => i.type === 'checkbox');
    const ttlRadios = overlay.querySelectorAll('.ui-dialog-option input').filter(i => i.type === 'radio');
    const pinInput = overlay.querySelectorAll('input[name^="field"], .ui-dialog-reveal input')[0];

    pinBox.checked = true;
    pinInput.value = '4321';
    // 像真实用户一样点选「1 天」：置为 checked 并触发 change，由浏览器语义负责互斥
    const day = ttlRadios.find(r => r.value === '1440');
    day.checked = true;
    day.fire('change', {});

    const form = overlay.querySelector('form');
    form.fire('submit', { preventDefault() {} });
    await pending;

    // app.js 在 vm 上下文中执行，跨 realm 对象不能直接 deepStrictEqual
    assert.equal(shares.length, 1);
    assert.equal(shares[0].length, 3);
    assert.deepEqual(Array.from(shares[0]).slice(0, 2), ['secret', '4321']);
    assert.equal(shares[0][2].ttlMinutes, 1440);
});

test('a non-numeric PIN is rejected before the share is created', async () => {
    const { document, state } = createDocument();
    const app = loadApp(document);
    const shares = [];
    app.createPaste = async (...args) => { shares.push(args); };

    const pending = app.showPasteOptions('secret');
    await new Promise(resolve => setImmediate(resolve));

    const overlay = state.dialog;
    const pinBox = overlay.querySelectorAll('.ui-dialog-option input').find(i => i.type === 'checkbox');
    const pinInput = overlay.querySelectorAll('input[name^="field"], .ui-dialog-reveal input')[0];
    pinBox.checked = true;
    pinInput.value = '12';

    const form = overlay.querySelector('form');
    form.fire('submit', { preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(shares, []);
    assert.match(overlay.querySelector('.ui-dialog-error').textContent, /4 位数字/);
    assert.equal(overlay.removed, false);

    // 修正为 4 位后可以继续
    pinInput.value = '1234';
    form.fire('submit', { preventDefault() {} });
    await pending;
    assert.equal(shares.length, 1);
    assert.deepEqual(shares[0].slice(0, 2), ['secret', '1234']);
    assert.equal(shares[0][2].ttlMinutes, 5);
});

test('expiry radios share one name so the browser enforces mutual exclusion', async () => {
    const { document, state } = createDocument();
    const app = loadApp(document);
    const shares = [];
    app.createPaste = async (...args) => { shares.push(args); };

    const pending = app.showPasteOptions('text');
    await new Promise(resolve => setImmediate(resolve));

    const overlay = state.dialog;
    const ttlRadios = overlay.querySelectorAll('.ui-dialog-option input').filter(i => i.type === 'radio');
    assert.equal(ttlRadios.length, 4);

    // 同组必须共用同一个 name，否则浏览器不会实现原生互斥
    const names = new Set(ttlRadios.map(radio => radio.name));
    assert.equal(names.size, 1, `有效期单选项应共用一个 name，实际得到: ${[...names].join(', ')}`);

    // 模拟浏览器：勾选 30 分钟后，同组其余项应自动取消
    const thirty = ttlRadios.find(radio => radio.value === '30');
    thirty.checked = true;
    thirty.fire('change', {});
    assert.equal(ttlRadios.filter(radio => radio.checked).length, 1);

    overlay.querySelector('form').fire('submit', { preventDefault() {} });
    await pending;
    assert.equal(shares[0][2].ttlMinutes, 30);
});

test('every overlay dialog stays vertically centred on narrow screens', () => {
    // 曾经 .ui-dialog-overlay（≤480px）与 .fav-dialog-overlay（≤768px）都被写成
    // 贴底的底部抽屉，结果在移动端被地址栏与 Home 指示条盖住。两处都要守住。
    const narrow480 = mediaBlock(adminCss, '@media (max-width: 480px)');
    const uiOverlay = /\.ui-dialog-overlay\s*\{([^}]*)\}/.exec(narrow480);
    assert.ok(uiOverlay, '窄屏仍有 .ui-dialog-overlay 规则');
    assert.equal(/align-items:\s*end/.test(uiOverlay[1]), false, '窄屏不得把弹窗改成底部抽屉');
    assert.equal(/place-items:\s*[^;]*end/.test(uiOverlay[1]), false, 'place-items 也不得指定 end');
    // ≤480px 块里不得再出现 fav-dialog 的底部抽屉声明
    assert.equal(/\.fav-dialog\s*\{/.test(narrow480), false, '≤480px 不应重定义 .fav-dialog');

    // .fav-dialog 的唯一定义处是 styles.css 的 ≤768px 块（该查询有多个块，
    // 必须按内容定位，不能取第一个）
    const narrow768 = mediaBlock(stylesCss, '@media (max-width: 768px)', '.fav-dialog-overlay');
    const favOverlay = /\.fav-dialog-overlay\s*\{([^}]*)\}/.exec(narrow768);
    assert.ok(favOverlay, '≤768px 仍有 .fav-dialog-overlay 规则');
    assert.equal(/align-items:\s*flex-end/.test(favOverlay[1]), false, '收藏弹窗不得贴底');
    assert.match(favOverlay[1], /align-items:\s*center/, '收藏弹窗居中');
    assert.match(favOverlay[1], /env\(safe-area-inset-bottom\)/, '收藏弹窗避让 Home 指示条');

    const favDialog = /\.fav-dialog\s*\{([^}]*)\}/.exec(narrow768);
    assert.ok(favDialog, '≤768px 仍有 .fav-dialog 规则');
    assert.equal(/border-radius:\s*16px 16px 0 0/.test(favDialog[1]), false, '收藏弹窗不得是顶部圆角的抽屉');

    // 基础规则负责居中，窄屏只调内边距与尺寸
    // 注意：基础规则出现在文件中第一个 @media 之后，不能用 indexOf 判定它在前
    const base = /\.ui-dialog-overlay\s*\{([^}]*)\}/.exec(adminCss);
    assert.ok(base, '存在 .ui-dialog-overlay 规则');
    assert.match(base[1], /place-items:\s*center/, '弹窗在基础规则里居中');
});

test('the engine dropdown is bounded and scrollable in landscape', () => {
    // 12 个引擎时高 442px，横屏 844×390 下超出视口 199px 且无法滚动，
    // 后 6 个引擎完全点不到。这是功能失效，不是观感问题。
    const landscape = mediaBlock(stylesCss, '@media (max-height: 500px) and (orientation: landscape)', '.engine-dropdown');
    const dropdown = /\.engine-dropdown\s*\{([^}]*)\}/.exec(landscape);
    assert.ok(dropdown, '横屏块仍声明 .engine-dropdown');
    assert.match(dropdown[1], /max-height:\s*[^;]*\d/, '横屏必须给引擎下拉设高度上限');
    assert.match(dropdown[1], /overflow-y:\s*auto/, '超出后必须能滚动，否则下方选项点不到');

    // 基础规则不该自带高度上限——竖屏下 442px 并不溢出，加了反而多余
    const base = /\.engine-dropdown\s*\{([^}]*)\}/.exec(stylesCss);
    assert.ok(base, '存在基础的 .engine-dropdown 规则');
    assert.equal(/max-height/.test(base[1]), false, '基础规则不应限制高度，留给横屏块处理');
});

test('dialogs and the composer yield to the on-screen keyboard', () => {
    // vh/dvh 都不跟随软键盘收缩，只有 visualViewport 反映真实可视高度。
    // app.js 把被遮挡高度写进 --kb-inset，各弹窗按它收矮。
    // 断言只匹配可执行代码：先把整行注释与块注释剥掉，否则
    // 「只有 visualViewport 反映」这句注释就能让断言通过，而代码已被删空。
    const code = source
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(code, /window\.visualViewport/, 'app.js 必须在代码中读取 visualViewport');
    assert.match(code, /--kb-inset/, 'app.js 必须写出 --kb-inset');
    assert.match(code, /addEventListener\('resize',\s*sync\)/, '键盘弹出/收起要监听 resize');
    assert.match(code, /addEventListener\('scroll',\s*sync\)/, '键盘滚动也要同步');
    // 变量不能只在 JS 里写而没有 CSS 消费，否则是死代码
    assert.match(stylesCss, /var\(--kb-inset/, 'styles.css 需消费 --kb-inset');
    assert.match(adminCss, /var\(--kb-inset/, 'admin.css 需消费 --kb-inset');

    // 收矮后仍要留出底部安全区，否则键盘上方那条手势条又会压住按钮
    const narrow = mediaBlock(adminCss, '@media (max-width: 480px)', '.ui-dialog-overlay');
    assert.match(narrow, /--kb-inset/, '窄屏弹窗内边距需减去键盘高度');
    assert.match(narrow, /env\(safe-area-inset-bottom\)/, '且仍需保留安全区');
});

test('the expiry grid is a two-column layout declared exactly once', () => {
    const all = [...adminCss.matchAll(/^\.ui-dialog-options\s*\{([^}]*)\}/gm)];
    assert.equal(all.length, 1, `.ui-dialog-options 应只定义一次，实际 ${all.length} 次`);
    assert.match(all[0][1], /grid-template-columns:\s*1fr 1fr/, '有效期排成 2×2');
});

test('the search input font size never drops below the iOS zoom threshold', () => {
    // 15px 位于 iOS Safari 的自动缩放阈值之下，聚焦时整页会被放大。
    // 583/603 行已写 16px，若末尾的新版样式块再写更小的值就会把它们覆盖掉。
    const declarations = [...stylesCss.matchAll(/^\.search-input\s*\{([^}]*)\}/gm)]
        .map(match => /font-size:\s*(\d+)px/.exec(match[1]))
        .filter(Boolean)
        .map(match => Number(match[1]));
    assert.ok(declarations.length > 0, '存在 .search-input 的 font-size 声明');
    declarations.forEach(size => {
        assert.ok(size >= 16, `.search-input 的 font-size 不得低于 16px，实际出现 ${size}px`);
    });
});

test('the utility dock and toast clear the home indicator', () => {
    // viewport-fit=cover 之后，固定在底部的元素必须自己让位
    const narrow = mediaBlock(stylesCss, '@media (max-width: 600px)');
    assert.match(narrow, /\.utility-dock\s*\{[^}]*bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/, '底部工具条避让 Home 指示条');
    assert.match(narrow, /\.toast\s*\{[^}]*bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/, '提示条避让 Home 指示条');
});

test('the share receive page declares viewport-fit=cover', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const meta = /<meta name="viewport" content="([^"]*)">/.exec(server);
    assert.ok(meta, '分享页有 viewport meta');
    assert.match(meta[1], /viewport-fit=cover/, '分享页必须声明 viewport-fit=cover');
});

test('the PIN field sits directly under its checkbox, not below the expiry options', async () => {
    const { document, state } = createDocument();
    const app = loadApp(document);
    app.createPaste = async () => {};

    const pending = app.showPasteOptions('text');
    await new Promise(resolve => setImmediate(resolve));

    const markup = state.dialog.markup;
    const checkboxAt = markup.indexOf('opt_pin');
    const pinFieldAt = markup.indexOf('revealField');
    const firstRadioAt = markup.indexOf('opt_ttl');

    assert.ok(checkboxAt > -1 && pinFieldAt > -1 && firstRadioAt > -1, '面板含 PIN 复选框、PIN 输入框与有效期单选项');
    assert.ok(pinFieldAt > checkboxAt, 'PIN 输入框必须排在 PIN 复选框之后');
    assert.ok(pinFieldAt < firstRadioAt, 'PIN 输入框必须排在有效期单选项之前，否则视觉上会掉到弹窗最下面');

    // 弹窗只在提交或取消时 resolve，这里只需要模板内容，按取消收尾
    state.dialog.fire('click', { target: { closest: s => (s === '[data-action="cancel"]' ? {} : null) } });
    await pending;
});

test('the four expiry options share one grid container', async () => {
    const { document, state } = createDocument();
    const app = loadApp(document);
    app.createPaste = async () => {};

    const pending = app.showPasteOptions('text');
    await new Promise(resolve => setImmediate(resolve));

    const markup = state.dialog.markup;
    assert.match(markup, /class="ui-dialog-options"/, '有效期需要独立的网格容器才能排成 2×2');
    assert.match(markup, /class="ui-dialog-group-label">有效期</, '分组需要标题说明这一组是什么');

    // 四个单选项必须都在同一个 .ui-dialog-options 内，否则网格只作用于第一项
    const gridAt = markup.indexOf('ui-dialog-options');
    assert.ok(gridAt > -1, '网格容器存在');

    const radios = [...markup.matchAll(/name="opt_ttl"/g)];
    assert.equal(radios.length, 4, '四档有效期都存在');
    radios.forEach(match => {
        assert.ok(match.index > gridAt, '每个有效期单选项都渲染在网格容器之内');
    });

    state.dialog.fire('click', { target: { closest: s => (s === '[data-action="cancel"]' ? {} : null) } });
    await pending;
});

test('promptValue still returns the first field value', async () => {
    const { document, state } = createDocument();
    const app = loadApp(document);

    const pending = app.promptValue('设置 PIN', '4 位数字 PIN 码', { type: 'password' });
    await new Promise(resolve => setImmediate(resolve));

    const overlay = state.dialog;
    const inputs = overlay.querySelectorAll('input[name^="field"], .ui-dialog-reveal input');
    inputs[0].value = '9876';
    overlay.querySelector('form').fire('submit', { preventDefault() {} });

    assert.equal(await pending, '9876');
});

test('expiry text reflects the requested window', () => {
    const { document } = createDocument();
    const app = loadApp(document);
    const now = Date.now();

    assert.equal(app.pasteExpiryText(now + 30 * 60000), '30分钟后过期');
    assert.equal(app.pasteExpiryText(now + 2 * 3600000), '2小时后过期');
    assert.equal(app.pasteExpiryText(now + 3 * 86400000), '3天后过期');
    assert.equal(app.pasteExpiryText(now - 1000), '已过期');
    assert.equal(app.pasteExpiryText(null), '5分钟后过期');
});

test('Enter on a merging category opens one confirmation despite input blur', async () => {
    let input;
    const document = {
        readyState: 'loading',
        addEventListener() {},
        body: { contains: element => !element.removed },
        createElement(tag) {
            assert.equal(tag, 'input');
            input = { removed: false, focus() {}, select() {}, remove() { this.removed = true; } };
            return input;
        }
    };
    const app = loadApp(document);
    app.favorites = [{ category: 'Old' }, { category: 'New' }];
    app.favManagerCurrentCategory = '';
    app.showToast = () => {};
    app.saveFavorites = async () => true;
    app.renderFavManager = () => {};

    const classes = new Set();
    const nameSpan = { classList: {
        add: value => classes.add(value),
        remove: value => classes.delete(value),
        contains: value => classes.has(value)
    } };
    const selectButton = { hidden: false };
    const editButton = {};
    const item = {
        dataset: { category: 'Old', name: 'Old' },
        querySelector(selector) {
            return { '.tree-item-name': nameSpan, '.category-tree-select': selectButton, '.tree-item-edit': editButton }[selector];
        },
        insertBefore() {}
    };
    let confirmations = 0;
    let resolveConfirmation;
    app.confirmAction = () => {
        confirmations++;
        input.onblur();
        return new Promise(resolve => { resolveConfirmation = resolve; });
    };

    app.editCategoryName(item);
    input.value = 'New';
    input.onkeydown({ key: 'Enter', preventDefault() {} });
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.equal(confirmations, 1);
    resolveConfirmation(false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(confirmations, 1);
    assert.equal(selectButton.hidden, true);
});

test('对话框内边距四边对称，overlay 上不留单边覆盖', () => {
    // 回归表现（浏览器实测 1280×800 / 834×1112 / 844×390）：对话框 top 留白
    // 比 bottom 多 8px，四个视口里三个都不居中。
    //
    // 根因是两条规则打架：overlay 先写 `padding: 20px`（四边），
    // 后面再写 `padding-bottom: calc(12px + …)`（只改底边）——
    // top 留 20px、bottom 留 12px，`place-items: center` 居中的是内容盒，
    // 而内容盒被不对称的内边距整体上推了 4px。
    //
    // 只查 .ui-dialog-overlay，**不查 .fav-dialog-overlay**：后者在 styles.css
    // 的 ≤768px 块里有一条四边吃安全区的规则，而本文件后加载、特异性相同，
    // 若在这里也给它一条四边简写就会把那四边整个覆盖掉——收藏弹窗在 iPhone 上
    // 就丢掉安全区。它保持只写 padding-bottom 是有意的。
    const rules = [...adminCss.matchAll(/\.ui-dialog-overlay\s*\{([^}]*)\}/g)].map(m => m[1]);
    assert.ok(rules.length > 0, '找到 .ui-dialog-overlay 的规则');
    for (const body of rules) {
        assert.doesNotMatch(body, /padding-(top|bottom|left|right)\s*:/,
            `overlay 规则里不得单边覆盖内边距（会造成上下/左右不对称）：${body.trim()}`);
    }
    // 既要写内边距，又必须是简写（一次给全四边）
    assert.ok(rules.some(b => /padding\s*:/.test(b)),
        'overlay 用 padding 简写声明内边距');
});

test('收藏弹窗 overlay 的安全区规则不被 admin.css 覆盖掉', () => {
    // 回归记录：本轮修对话框居中时把 .fav-dialog-overlay 并进了同一条简写，
    // 而 styles.css 的 ≤768px 块里那个选择器有一条四边吃安全区的规则——
    // 两处特异性相同、admin.css 后加载，于是收藏弹窗在 iPhone 上
    // 丢掉 top/right/left 的安全区。样式表跨文件覆盖，静态读代码看不出来。
    //
    // 断言：admin.css 里对 .fav-dialog-overlay **只准**改 padding-bottom，
    // 不得出现会整体覆盖的简写。
    const rules = [...adminCss.matchAll(/\.fav-dialog-overlay\s*[,{]([^}]*)\}/g)].map(m => m[1]);
    assert.ok(rules.length > 0, 'admin.css 里有 .fav-dialog-overlay 规则');
    for (const body of rules) {
        assert.doesNotMatch(body, /^\s*padding\s*:/m,
            `不得给 .fav-dialog-overlay 写 padding 简写（会覆盖 styles.css 的四边安全区）：${body.trim()}`);
    }
    // 且 styles.css 那条安全区规则必须还在
    assert.match(stylesCss, /\.fav-dialog-overlay\s*\{[^}]*padding:[^}]*safe-area-inset-top/,
        'styles.css 的 ≤768px 块仍保有四边安全区规则');
});

test('横屏矮视口下对话框的操作区固定在底部', () => {
    // 回归表现（浏览器实测 844×390）：对话框内容 584px、视口只有 390px，
    // 「确定/取消」落在首屏外 582px 处——用户看到的是一张只有输入框的弹窗，
    // 不知道下面还有控件，也点不到确认。
    //
    // 容器本身可滚，所以内容能到达；缺的是「操作区始终可点」这一条。
    // 四轮实测的结论写在 admin.css 同一处注释里，改动前先读它。
    const block = mediaBlock(adminCss, '@media (max-height: 500px) and (orientation: landscape)', '.ui-dialog-actions');
    const actions = /\.ui-dialog-actions\s*\{([^}]*)\}/.exec(block);
    assert.ok(actions, '横屏块里有 .ui-dialog-actions 规则');
    assert.match(actions[1], /position:\s*sticky/,
        '操作区在横屏下 sticky —— absolute 实测无效：.ui-dialog 既是滚动容器'
        + '又是定位基准，padding-bottom 不给内容流留空间');
    assert.match(actions[1], /bottom:\s*-?\d/, 'sticky 需要一个 bottom 锚点');
    // 底色要跟着主题走，否则叠在输入框上分不清边界
    assert.match(actions[1], /background:\s*var\(--bg-card\)/,
        '操作区用主题底色，不要硬编码颜色');

    // 压缩必须作用在真正的空间来源上
    assert.match(block, /\.ui-dialog-message\s*\{[^}]*max-height/,
        '横屏下限制提示正文的高度（实测省下 26px）');
    assert.match(block, /\.ui-dialog-hint\s*\{[^}]*max-height/,
        '横屏下限制 hint 的高度（实测每个省下 15px）');
    // 并排两列是压缩里唯一拿到足够空间的一刀（实测再省约 59px）
    assert.match(block, /\.ui-dialog-options\.is-plain\s*\{[^}]*grid-template-columns:\s*1fr 1fr/,
        '扁平 options 在横屏下并排两列');
});

test('扁平 options 默认维持竖排，只有横屏才并排', () => {
    // 本轮给扁平 options（采集方式等）补上了 .ui-dialog-options 容器，
    // 而该类的 base 是 grid-template-columns: 1fr 1fr —— 那是给分组里的
    // 四档有效期设计的。顺带套上去会改掉分享有效期、PIN 等对话框的既有布局。
    // 所以 base 上必须有 .is-plain 覆写回竖排。
    const plain = /\.ui-dialog-options\.is-plain\s*\{([^}]*)\}/.exec(adminCss);
    assert.ok(plain, '有 .ui-dialog-options.is-plain 的基础规则');
    assert.match(plain[1], /grid-template-columns:\s*1fr\s*;/,
        '默认竖排（1fr 单列），不继承 .ui-dialog-options 的两列');

    // 分组里的四档有效期必须仍是 2×2
    const base = /\.ui-dialog-options\s*\{([^}]*)\}/.exec(adminCss);
    assert.ok(base, '有 .ui-dialog-options 的基础规则');
    assert.match(base[1], /grid-template-columns:\s*1fr 1fr/,
        '分组里的多档选项保持 2×2');
});

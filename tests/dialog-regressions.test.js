const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const exportPoint = '    let app;\n';
assert.equal(source.split(exportPoint).length, 2);

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

// 解析对话框模板，收集输入项及其所属区块
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
        inputs.push({ attrs, parent: stack[stack.length - 1] || { cls: '', name: '', dataset: { name: '' } } });
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
        closest(selector) { return selector === '.ui-dialog-option' ? this.parent : null; }
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
    app.showFavManager = () => {};

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

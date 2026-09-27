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

test('backdrop dismissal cannot create a share without PIN', async () => {
    let overlay;
    const returnFocus = { isConnected: true, focus() {} };
    const confirmButton = { focus() {} };
    const form = { addEventListener() {} };
    const dialog = { addEventListener() {} };
    const document = {
        readyState: 'loading',
        activeElement: returnFocus,
        addEventListener() {},
        body: { appendChild() {} },
        createElement(tag) {
            assert.equal(tag, 'template');
            overlay = {
                removed: false,
                listeners: {},
                closest() { return null; },
                addEventListener(name, listener) { this.listeners[name] = listener; },
                querySelector(selector) { return selector === '.ui-dialog' ? dialog : form; },
                querySelectorAll(selector) { return selector === 'input' ? [] : [confirmButton]; },
                remove() { this.removed = true; }
            };
            return { content: { firstChild: overlay }, set innerHTML(_) {} };
        }
    };
    const app = loadApp(document);
    const shares = [];
    app.createPaste = async (...args) => { shares.push(args); };

    const pending = app.showPasteOptions('private text');
    overlay.listeners.click({ target: overlay });
    assert.equal(overlay.removed, false);
    assert.equal(shares.length, 0);

    const cancelButton = { closest: selector => selector === '[data-action="cancel"]' ? {} : null };
    overlay.listeners.click({ target: cancelButton });
    await pending;
    assert.deepEqual(shares, [['private text', null]]);
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

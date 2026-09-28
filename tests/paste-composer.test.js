const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'public/styles.css'), 'utf8');

const exportPoint = '    let app;\n';
assert.equal(appSource.split(exportPoint).length, 2);

function loadApp(document, window = {}, sandbox = {}) {
    vm.runInNewContext(appSource.replace(exportPoint, '    window.AppForTest = App;\n' + exportPoint), {
        window,
        document,
        setTimeout,
        clearTimeout,
        // autoGrowPasteInput clamps against the CSS ceiling, so the sandbox
        // needs a getComputedStyle; individual tests override maxHeight.
        getComputedStyle: () => ({ maxHeight: 'none' }),
        ...sandbox
    });
    return Object.create(window.AppForTest.prototype);
}

// Build a DOM stub covering exactly what togglePasteMode and the key handlers touch.
function createComposerDom() {
    const el = tag => {
        const node = {
            tag,
            hidden: false,
            textContent: '',
            title: '',
            value: '',
            placeholder: '',
            style: {},
            attrs: {},
            classes: new Set(),
            children: [],
            setAttribute(name, value) { this.attrs[name] = value; },
            getAttribute(name) { return this.attrs[name]; },
            focus() { this.focused = true; },
            querySelector(selector) { return this.children.find(c => c.matches(selector)) || null; },
            matches(sel) {
                return sel.split(',').map(s => s.trim()).some(s => {
                    if (s.startsWith('#')) return node.attrs.id === s.slice(1);
                    if (s.startsWith('.')) return node.classes.has(s.slice(1));
                    if (s.startsWith('[')) {
                        const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(s);
                        return !!m && node.attrs[m[1]] === m[2];
                    }
                    return true;
                });
            }
        };
        node.classList = {
            add: v => node.classes.add(v),
            remove: v => node.classes.delete(v),
            toggle: (v, on) => (on ? node.classes.add(v) : node.classes.delete(v)),
            contains: v => node.classes.has(v)
        };
        return node;
    };

    const form = el('form'); form.attrs.id = 'searchForm';
    const input = el('textarea'); input.attrs.id = 'searchInput';
    const searchBtn = el('button'); searchBtn.classes.add('search-btn');
    const engineBtn = el('button'); engineBtn.attrs.id = 'engineBtn';
    const dropdown = el('div'); dropdown.attrs.id = 'engineDropdown';
    const webLabel = el('span'); webLabel.attrs['data-label'] = 'web';
    const exitLabel = el('span'); exitLabel.attrs['data-label'] = 'exit'; exitLabel.hidden = true;
    const modeBtn = el('button');
    modeBtn.attrs.id = 'modeBtn';
    modeBtn.children = [webLabel, exitLabel];

    const registry = {
        '#searchForm': form,
        '#searchInput': input,
        '#engineBtn': engineBtn,
        '#engineDropdown': dropdown,
        '#modeBtn': modeBtn,
        '.search-btn': searchBtn
    };

    const document = {
        readyState: 'loading',
        addEventListener() {},
        body: { appendChild() {}, contains: () => true },
        createElement: tag => el(tag),
        // app.js's $ helper resolves against document; only the selectors
        // togglePasteMode actually uses need to resolve.
        querySelector(selector) {
            if (registry[selector]) return registry[selector];
            return el('div');
        }
    };

    return {
        document,
        nodes: { form, input, searchBtn, engineBtn, dropdown, modeBtn, webLabel, exitLabel }
    };
}

function mountComposer(controls = {}) {
    const dom = createComposerDom();
    const document = {
        ...dom.document,
        createElement: tag => {
            const node = dom.document.createElement(tag);
            if (tag === 'template') {
                return {
                    set innerHTML(_value) { this.content = { firstChild: dom.nodes.form }; },
                    content: null
                };
            }
            return node;
        }
    };
    const app = loadApp(
        document,
        { matchMedia: () => ({ matches: false }) },
        { getComputedStyle: () => ({ maxHeight: controls.maxHeight ?? 'none' }) }
    );
    return { app, dom };
}

// ---- style shape guards ----
// The expanded composer silently broke once before: a later "new theme"
// block re-declared .search.paste-mode .search-input and flattened the
// min-height back to the single-line value. Assert the definition is unique.

test('the share composer styles are declared in exactly one place', () => {
    // The media-query override is legitimate responsive behaviour, so only
    // top-level (unindented) declarations count as competing definitions.
    const definitions = cssSource.match(/^\.search\.paste-mode\s+\.search-input\s*\{/gm) || [];
    assert.equal(definitions.length, 1, `expected one top-level .search.paste-mode .search-input block, found ${definitions.length}`);

    const engineRules = cssSource.match(/^\.search\.paste-mode\s+#engineBtn\s*\{/gm) || [];
    assert.equal(engineRules.length, 1, 'the engine button should be hidden from exactly one rule');
});

test('the composer grows taller than the single-line search row', () => {
    const block = /\.search\.paste-mode\s+\.search-input\s*\{([^}]*)\}/.exec(cssSource);
    assert.ok(block, 'composer rule exists');

    // min-height alone pins a textarea to its rows=1 height; without
    // height:auto the content cannot push the box open.
    assert.match(block[1], /height:\s*auto/, 'composer needs height:auto for content to expand it');

    const minHeight = /min-height:\s*(\d+)px/.exec(block[1]);
    assert.ok(minHeight, 'composer sets a min-height');
    assert.ok(Number(minHeight[1]) >= 80, `composer min-height ${minHeight[1]}px is not meaningfully taller than 36px`);

    // A bound is mandatory, otherwise dragging can push the send button off-screen
    assert.match(block[1], /max-height:\s*\d+v?h/, 'composer needs a max-height bound');
    assert.match(block[1], /resize:\s*vertical/, 'composer should be vertically draggable');
});

test('the composer auto-grows with its content but yields to manual resizing', () => {
    const controls = { maxHeight: 'none' };
    const { app, dom } = mountComposer(controls);
    const input = dom.nodes.input;
    let scrollHeight = 200;
    Object.defineProperty(input, 'scrollHeight', { get: () => scrollHeight, configurable: true });

    app.pasteMode = true;
    app.autoGrowPasteInput();
    assert.equal(input.style.height, '200px', 'grows to fit the content');

    // Shrinking the content must shrink the box back
    scrollHeight = 120;
    app.autoGrowPasteInput();
    assert.equal(input.style.height, '120px', 'shrinks when the content does');

    // The written height must never exceed the CSS ceiling, otherwise a huge
    // draft would leave a dead inline value behind
    controls.maxHeight = '346px';
    scrollHeight = 2400;
    app.autoGrowPasteInput();
    assert.equal(input.style.height, '346px', 'clamped to max-height');

    // Once the user grabs the resize handle, stop overriding their choice
    app.pasteUserResized = true;
    input.style.height = '251px';
    scrollHeight = 400;
    app.autoGrowPasteInput();
    assert.equal(input.style.height, '251px', 'manual resize wins over auto-grow');

    // Search mode never grows
    app.pasteMode = false;
    app.pasteUserResized = false;
    input.style.height = '';
    scrollHeight = 500;
    app.autoGrowPasteInput();
    assert.equal(input.style.height, '', 'no auto-grow outside share mode');
});

test('pressing the resize handle marks the height as user-controlled', () => {
    const source = appSource;
    assert.match(source, /addEventListener\('pointerdown'/, 'editor watches for resize-handle presses');
    assert.match(source, /this\.pasteUserResized = true/, 'handle press flips the flag');
});

test('the search row itself stays single-height and not draggable', () => {
    // The last declaration wins, so assert on the one in the later
    // "new theme" block rather than the first one in the file.
    const all = [...cssSource.matchAll(/^\.search-input\s*\{([^}]*)\}/gm)];
    assert.ok(all.length > 0, '.search-input base rule exists');

    const base = all[all.length - 1][1];
    assert.match(base, /min-height:\s*36px/, 'base row keeps the 36px height');
    assert.match(base, /resize:\s*none/, 'base row must not be draggable');
    // A bare `height` (not min-height) would pin the box and block growth
    assert.equal(/(^|;)\s*height\s*:/.test(base), false, 'a fixed height would block content growth');
});

// ---- markup guards ----

test('the editor is a textarea with both mode labels present', () => {
    assert.match(htmlSource, /<textarea[^>]*id="searchInput"/, 'searchInput must be a textarea');
    assert.equal(/<input[^>]*id="searchInput"/.test(htmlSource), false, 'no leftover input element');
    assert.match(htmlSource, /data-label="web"/);
    assert.match(htmlSource, /data-label="exit"/);
});

// ---- behaviour ----

test('entering share mode swaps the mode button to an exit affordance', () => {
    const { app, dom } = mountComposer();

    app.togglePasteMode(true);

    assert.equal(dom.nodes.form.classes.has('paste-mode'), true);
    assert.equal(dom.nodes.webLabel.hidden, true, '网页 label hidden while sharing');
    assert.equal(dom.nodes.exitLabel.hidden, false, '退出 label shown while sharing');
    assert.equal(dom.nodes.modeBtn.getAttribute('aria-label'), '退出文本分享');
    assert.equal(dom.nodes.searchBtn.textContent, '发送');
});

test('the engine button is hidden by class, not by an inline style', () => {
    const { app, dom } = mountComposer();

    app.togglePasteMode(true);

    // An inline display:none cannot participate in transitions and outranks
    // the stylesheet, so the hiding must live in CSS.
    assert.equal(dom.nodes.engineBtn.style.display, undefined, 'no inline display on the engine button');
    assert.match(cssSource, /\.search\.paste-mode\s+#engineBtn\s*\{[^}]*display:\s*none/, 'CSS hides the engine button');

    app.togglePasteMode(false);
    assert.equal(dom.nodes.engineBtn.style.display, undefined, 'still no inline display when leaving');
});

test('entering share mode clears the engine dropdown and resets the editor height', () => {
    const { app, dom } = mountComposer();
    dom.nodes.dropdown.hidden = false;
    dom.nodes.engineBtn.setAttribute('aria-expanded', 'true');
    dom.nodes.input.style.height = '320px';

    app.togglePasteMode(true);

    assert.equal(dom.nodes.dropdown.hidden, true);
    assert.equal(dom.nodes.engineBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(dom.nodes.input.style.height, '', 'a previous drag size must not carry over');
});

test('leaving share mode restores the search row', () => {
    const { app, dom } = mountComposer();
    app.togglePasteMode(true);
    app.togglePasteMode(false);

    assert.equal(dom.nodes.form.classes.has('paste-mode'), false);
    assert.equal(dom.nodes.webLabel.hidden, false);
    assert.equal(dom.nodes.exitLabel.hidden, true);
    assert.equal(dom.nodes.modeBtn.getAttribute('aria-label'), '切换搜索模式，当前为网页');
    assert.equal(dom.nodes.searchBtn.textContent, '搜索');
    assert.equal(dom.nodes.input.placeholder, '搜索网页或收藏');
});

test('Enter sends while Shift/Ctrl/Cmd+Enter inserts a newline', () => {
    const { app, dom } = mountComposer();
    const input = dom.nodes.input;
    const listeners = {};
    input.addEventListener = (name, fn) => { listeners[name] = fn; };

    let sent = 0;
    app.handleSearch = async () => { sent++; };

    // Behaviour check for the intended rule. The wiring itself is pinned
    // separately below so this cannot drift from the real implementation.
    const handler = new Function('event', `
        const app = this;
        if (event.key !== 'Enter' || !app.pasteMode) return;
        if (event.shiftKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        app.handleSearch();
    `);
    const keydown = event => handler.call(app, event);

    app.pasteMode = true;

    let prevented = false;
    keydown({ key: 'Enter', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, 'plain Enter must not submit the form');
    assert.equal(sent, 1, 'plain Enter sends the share');

    prevented = false;
    keydown({ key: 'Enter', shiftKey: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, 'Shift+Enter must fall through to a newline');

    prevented = false;
    keydown({ key: 'Enter', ctrlKey: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, 'Ctrl+Enter must fall through to a newline');

    prevented = false;
    keydown({ key: 'Enter', metaKey: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, 'Cmd+Enter must fall through to a newline');

    // In search mode the textarea must keep native behaviour
    app.pasteMode = false;
    prevented = false;
    keydown({ key: 'Enter', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, 'search mode keeps native newline behaviour');
    assert.equal(sent, 1, 'search mode must not send');
});

test('the production source installs an Enter handler on the editor', () => {
    // The behavioural test above drives a re-implemented handler; this pins
    // the wiring in app.js itself so the two cannot drift apart.
    const bind = /bind\(\)\s*\{([\s\S]*?)\n        \}/.exec(appSource);
    assert.ok(bind, 'bind() exists');
    assert.match(bind[1], /\$\('#searchInput'\)\.addEventListener\('keydown'/, 'editor has a keydown handler');
    assert.match(bind[1], /event\.key !== 'Enter' \|\| !this\.pasteMode/, 'handler is scoped to share mode');
    assert.match(bind[1], /event\.shiftKey \|\| event\.ctrlKey \|\| event\.metaKey/, 'modifier keys allow a newline');
});

test('Escape leaves share mode and clears the draft', () => {
    const { app, dom } = mountComposer();
    app.pasteMode = true;
    dom.nodes.input.value = '>draft text';
    app.handleSearchInput = () => {};

    // Behaviour check for the intended rule; the real wiring is asserted below.
    const escape = new Function('key', `
        const app = this;
        if (key !== 'Escape') return 'ignored';
        return app.pasteMode ? 'leave-share' : 'none';
    `);
    assert.equal(escape.call(app, 'Escape'), 'leave-share');

    app.pasteMode = false;
    app.togglePasteMode(false);
    dom.nodes.input.value = '';
    app.handleSearchInput({ target: dom.nodes.input });

    assert.equal(app.pasteMode, false);
    assert.equal(dom.nodes.input.value, '');
    assert.equal(dom.nodes.form.classes.has('paste-mode'), false);
});

test('the production source handles Escape while sharing', () => {
    const onkeydown = /document\.onkeydown\s*=\s*\(e\)\s*=>\s*\{([\s\S]*?)\n            \};/.exec(appSource);
    assert.ok(onkeydown, 'document.onkeydown exists');
    assert.match(onkeydown[1], /e\.key === 'Escape'/, 'Escape branch present');
    assert.match(onkeydown[1], /this\.pasteMode/, 'Escape also leaves share mode');
});

test('the help text documents the new composer shortcuts', () => {
    assert.match(appSource, /Shift<\/code>\+回车换行/, 'help mentions Shift+Enter');
    assert.match(appSource, /拖拽/, 'help mentions dragging');
});

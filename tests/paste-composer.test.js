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
        const listeners = {};
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
            addEventListener: (name, fn) => { listeners[name] = fn; },
            // Tests read this to drive the handler bind() really registered
            get listeners() { return listeners; },
            setAttribute(name, value) { this.attrs[name] = value; },
            getAttribute(name) { return this.attrs[name]; },
            focus() { this.focused = true; },
            appendChild() {},
            remove() {},
            // Elements are query contexts too: $$('.fav-item', dropdown) goes
            // through here, and a missing method throws inside handleFavKeydown.
            querySelectorAll() { return []; },
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

    // bind() wires up a lot more than togglePasteMode touches; register the
    // elements it reaches so a real bind() can run without throwing.
    const grid = el('div'); grid.attrs.id = 'grid';
    const favDropdown = el('div'); favDropdown.attrs.id = 'favDropdown'; favDropdown.hidden = true;
    const modal = el('div'); modal.attrs.id = 'modal'; modal.hidden = true;
    const backdrop = el('div'); backdrop.attrs.id = 'modalBackdrop';
    const modalContent = el('div');
    modalContent.querySelectorAll = () => [];
    const uiOverlay = el('div'); uiOverlay.classes.add('ui-dialog-overlay'); uiOverlay.hidden = true;

    const registry = {
        '#searchForm': form,
        '#searchInput': input,
        '#engineBtn': engineBtn,
        '#engineDropdown': dropdown,
        '#modeBtn': modeBtn,
        '.search-btn': searchBtn,
        '#grid': grid,
        '#favDropdown': favDropdown,
        '#modal': modal,
        '#modalBackdrop': backdrop,
        '#cancelBtn': el('button'),
        '#saveBtn': el('button'),
        '#adminBtn': el('button'),
        '#helpBtn': el('button'),
        '#modal .modal-content': modalContent,
        '.ui-dialog-overlay, .fav-dialog-overlay': uiOverlay,
        '#engineName': el('span')
    };

    const document = {
        readyState: 'loading',
        addEventListener() {},
        body: { appendChild() {}, contains: () => true },
        createElement: tag => el(tag),
        // Unregistered selectors must resolve to null the way a real browser
        // does. Returning a visible element here would make handleFavKeydown
        // treat a non-existent fav dropdown as an open one and swallow Esc.
        querySelector(selector) {
            return registry[selector] || null;
        },
        querySelectorAll() { return []; }
    };

    return {
        document,
        nodes: { form, input, searchBtn, engineBtn, dropdown, modeBtn, webLabel, exitLabel, modal }
    };
}

function mountComposer(controls = {}) {
    const dom = createComposerDom();
    // Mutate the original document rather than spreading it: bind() assigns
    // document.onkeydown, and tests read it back off the same object.
    const document = dom.document;
    const createElement = document.createElement;
    document.createElement = tag => {
        const node = createElement(tag);
        if (tag === 'template') {
            return {
                set innerHTML(_value) { this.content = { firstChild: dom.nodes.form }; },
                content: null
            };
        }
        return node;
    };
    const app = loadApp(
        document,
        {
            matchMedia: () => ({ matches: false }),
            addEventListener() {},
            open() {},
            location: { href: '' }
        },
        { getComputedStyle: () => ({ maxHeight: controls.maxHeight ?? 'none', minHeight: controls.minHeight ?? '0px' }) }
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

test('the composer transition survives the later .search rule', () => {
    // .search is declared three times. The first is the original look; the
    // second and third are the composer block and the later "new theme" block,
    // and the last one wins outright. If that last one omits min-height, the
    // whole expand animation is silently dead.
    const blocks = [...cssSource.matchAll(/^\.search\s*\{([^}]*)\}/gm)].map(m => m[1]);
    const lists = blocks
        .map(b => /transition\s*:([^;]+);/.exec(b))
        .filter(Boolean)
        .map(m => m[1].replace(/\s+/g, ''));

    const applied = lists[lists.length - 1];
    assert.match(applied, /min-height/, `the applied .search transition omits min-height: ${applied}`);
    assert.match(applied, /padding/, `the applied .search transition omits padding: ${applied}`);
    assert.match(applied, /border-radius/, `the applied .search transition omits border-radius: ${applied}`);

    // The composer block declares its own list; the two must stay in step or
    // editing one will silently break the other.
    const composer = lists.find(l => l.startsWith('min-height'));
    assert.ok(composer, 'the composer block declares a min-height transition');
    assert.equal(composer, applied, `composer and applied .search transitions differ:\n  composer: ${composer}\n  applied:  ${applied}`);
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

test('a drag that changes nothing hands control back to auto-grow', () => {
    // Dragging upward into min-height leaves the rendered height unchanged but
    // still marks the box as user-resized, which would freeze auto-grow for
    // the rest of the session and strand the content in an inner scrollbar.
    const controls = { maxHeight: 'none', minHeight: '96px' };
    const { app, dom } = mountComposer(controls);
    const input = dom.nodes.input;
    input.getBoundingClientRect = () => ({ right: 100, bottom: 100, height: 96 });
    let scrollHeight = 300;
    Object.defineProperty(input, 'scrollHeight', { get: () => scrollHeight, configurable: true });

    app.pasteMode = true;
    app.bind();

    assert.ok(input.listeners.pointerdown, 'bind() listens for pointerdown on the editor');

    input.listeners.pointerdown({ clientX: 99, clientY: 99, currentTarget: input });
    assert.equal(app.pasteUserResized, true, 'the press claims control');

    // The settle handler is armed by the press, not by bind()
    assert.ok(input.listeners.pointerup, 'a settle handler is armed by the press');
    input.listeners.pointerup();

    assert.equal(app.pasteUserResized, false, 'a no-op drag releases control');
    assert.equal(input.style.height, '300px', 'auto-grow resumes and fits the content');
});

test('a real drag keeps control with the user', () => {
    const controls = { maxHeight: 'none', minHeight: '96px' };
    const { app, dom } = mountComposer(controls);
    const input = dom.nodes.input;
    input.getBoundingClientRect = () => ({ right: 100, bottom: 300, height: 204 });
    let scrollHeight = 300;
    Object.defineProperty(input, 'scrollHeight', { get: () => scrollHeight, configurable: true });

    app.pasteMode = true;
    app.bind();

    input.listeners.pointerdown({ clientX: 99, clientY: 299, currentTarget: input });
    input.listeners.pointerup();
    assert.equal(app.pasteUserResized, true, 'a successful drag keeps the height the user chose');
});

test('the editor announces what it is for', () => {
    const { app, dom } = mountComposer();
    const input = dom.nodes.input;

    app.togglePasteMode(true);
    const sharingLabel = input.getAttribute('aria-label');
    assert.ok(sharingLabel, 'the editor has an aria-label while sharing');
    assert.doesNotMatch(sharingLabel, /搜索|收藏/, 'the label must not still say "search" while sharing');

    app.togglePasteMode(false);
    assert.match(input.getAttribute('aria-label'), /搜索/, 'the label returns to the search wording');
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
    const handlers = dom.nodes.input.listeners;

    let sent = 0;
    app.handleSearch = async () => { sent++; };

    // Drive the handler bind() actually registers. Re-implementing it here
    // would leave the test asserting its own copy, so a regression in app.js
    // would slip through.
    app.bind();
    assert.ok(handlers.keydown, 'bind() registers a keydown handler on the editor');

    app.pasteMode = true;

    let prevented = false;
    handlers.keydown({ key: 'Enter', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, 'plain Enter must not submit the form');
    assert.equal(sent, 1, 'plain Enter sends the share');

    for (const [name, modifier] of [['shift', 'shiftKey'], ['ctrl', 'ctrlKey'], ['cmd', 'metaKey']]) {
        prevented = false;
        handlers.keydown({ key: 'Enter', [modifier]: true, preventDefault: () => { prevented = true; } });
        assert.equal(prevented, false, `${name}+Enter must fall through to a newline`);
    }

    // In search mode the textarea must keep native behaviour
    app.pasteMode = false;
    prevented = false;
    handlers.keydown({ key: 'Enter', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, 'search mode keeps native newline behaviour');
    assert.equal(sent, 1, 'search mode must not send');
});

test('Escape leaves share mode and clears the draft', () => {
    const { app, dom } = mountComposer();

    let searchInputSeen = null;
    app.handleSearchInput = arg => { searchInputSeen = arg; };

    // Same rule as above: use the registered onkeydown, not a copy of it
    app.bind();
    const onkeydown = dom.document.onkeydown;
    assert.ok(onkeydown, 'bind() installs document.onkeydown');

    // Escape closes the engine dropdown first; share mode is the next branch
    dom.nodes.dropdown.hidden = true;
    dom.nodes.modal.hidden = true;

    app.pasteMode = true;
    dom.nodes.input.value = '>draft text';

    onkeydown({ key: 'Escape' });

    assert.equal(app.pasteMode, false, 'share mode ends');
    assert.equal(dom.nodes.form.classes.has('paste-mode'), false, 'the composer collapses');
    assert.equal(dom.nodes.input.value, '', 'the draft is discarded');
    assert.equal(searchInputSeen, dom.nodes.input, 'the input is re-evaluated after clearing');
    assert.equal(dom.nodes.input.focused, true, 'focus returns to the editor');
});

test('Escape leaves other modes alone', () => {
    const { app, dom } = mountComposer();
    let exited = false;
    app.exitPasteMode = () => { exited = true; };

    app.bind();
    const onkeydown = dom.document.onkeydown;

    app.pasteMode = false;
    onkeydown({ key: 'Escape' });
    assert.equal(exited, false, 'search mode is untouched by Escape');
});

test('the exit button and Escape share one code path', () => {
    // Both routes used to inline the same reset. If either ever inlines it
    // again, that copy can drift from the other and leave stale state behind.
    // A bare adjacent pair is not distinctive (fav-search and a successful
    // share clear the flag the same way), so anchor on exitPasteMode's body
    // and require that no other site pairs the reset with a draft clear.
    const owner = /exitPasteMode\(\)\s*\{([\s\S]*?)\n        \}/.exec(appSource);
    assert.ok(owner, 'exitPasteMode exists');
    assert.match(owner[1], /this\.pasteMode = false;\n\s*this\.togglePasteMode\(false\);/, 'exitPasteMode owns the reset');
    assert.match(owner[1], /input\.value = ''/, 'exitPasteMode also clears the draft');

    const callSites = appSource.match(/this\.exitPasteMode\(\)/g) || [];
    assert.equal(callSites.length, 2, 'the exit button and Escape both call exitPasteMode');

    // No route outside exitPasteMode may re-inline a draft clear. Strip that
    // method first, otherwise it matches its own body.
    const outsideMethod = appSource.replace(owner[0], '');
    const strays = outsideMethod.match(
        /this\.pasteMode = false;\n\s*this\.togglePasteMode\(false\);\n\s*(?:[^\n]*\n\s*)?(?:this\.\$\('#searchInput'\)\.value|input\.value) = '';/g
    ) || [];
    assert.equal(strays.length, 0, `no route may inline the draft clear, found ${strays.length}`);
});

test('the help text documents the new composer shortcuts', () => {
    assert.match(appSource, /Shift<\/code>\+回车换行/, 'help mentions Shift+Enter');
    assert.match(appSource, /拖拽/, 'help mentions dragging');
});

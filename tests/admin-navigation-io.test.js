'use strict';

/**
 * 后台「首页导航 → 数据管理」的导入导出。
 *
 * 用户要求：管理页面的导航部分增加类似 pabu 编辑区「数据管理」的导入导出。
 * 两边共用同一份 `navigation-schema.js`，文件形状固定为
 * `{ schemaVersion: 1, config }`，所以 pabu 导出的导航文件可以直接导入这里。
 *
 * 这里执行真实方法，而不是只断言源码里出现了几个标识符：
 *   - 导出：在假 Blob/URL/document 上跑 `exportAdminNavigation`，解析落盘内容；
 *   - 导入：在真实 schema 上跑 `importAdminNavigation`，覆盖成功、拒绝、
 *     引擎回退、确认取消与保存失败五条路径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const schema = require('../public/navigation-schema');

// 源码形状断言必须只匹配可执行代码：注释里提到标识符曾让守卫假绿。
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 按大括号配对切出一个类方法。两端都做断言：起点找不到时 `indexOf('{')`
 * 会落到别处，负长切片则会让断言静默落空。
 */
function methodBody(source, name) {
    const re = new RegExp(`\\n {8}(?:async )?${name}\\(`);
    const match = re.exec(source);
    assert.ok(match, `${name} 存在`);
    const open = source.indexOf('{', match.index);
    assert.ok(open > match.index, `${name} 方法体起点存在`);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                assert.ok(i - open > 100, `${name} 切片完整（${i - open} 字节）`);
                // 从方法签名开始切：只给方法体会在对象字面量里变成 `{ { ... } }`。
                return source.slice(match.index + 1, i + 1);
            }
        }
    }
    throw new Error(`${name} 方法体未闭合`);
}

const CURRENT = {
    theme: 'dark',
    themeStyle: 'prism',
    showBookmarkIcons: true,
    searchEngine: 'google',
    searchEngines: [{ id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' }],
    categories: [{ id: 'read', name: '阅读', bookmarks: [{ id: 'zhihu', title: '知乎', url: 'https://zhihu.com' }] }],
    privacyMode: true
};

function fileOf(payload) {
    const text = JSON.stringify(payload);
    return { size: text.length, text: async () => text };
}

function loadImport() {
    const body = methodBody(stripComments(appSource), 'importAdminNavigation');
    return new Function('window', `return ({ ${body} }).importAdminNavigation;`)({ NavigationSchema: schema });
}

function loadExport(env) {
    const body = methodBody(stripComments(appSource), 'exportAdminNavigation');
    return new Function('window', 'Blob', 'URL', 'document', 'setTimeout',
        `return ({ ${body} }).exportAdminNavigation;`)(env.window, env.Blob, env.URL, env.document, env.setTimeout);
}

test('后台「首页导航」分区有独立的「数据管理」块与两个入口', () => {
    const panel = methodBody(appSource, 'renderAdminPanel');
    const siteStart = panel.indexOf('id="adminPanelSite"');
    const favStart = panel.indexOf('id="adminPanelFav"');
    assert.ok(siteStart > 0 && favStart > siteStart, '首页导航面板边界可定位');
    const site = panel.slice(siteStart, favStart);
    assert.match(site, /<span class="section-title">数据管理<\/span>/, '数据管理块在首页导航分区内');
    assert.match(site, /id="exportNavBtn">导出导航</, '导出入口');
    assert.match(site, /id="importNavBtn">导入导航</, '导入入口');
    assert.match(site, /id="navFileInput"[^>]*accept="application\/json,\.json"[^>]*hidden/, '只接受 JSON 的隐藏文件框');
    assert.match(site, /onclick="app\.toggleSection\('navData'\)"/, '折叠块复用统一的开合入口');
    assert.match(site, /与 pabu 的导航导出互通/, '文件互通写进界面说明');
});

test('导出：文件形状是 { schemaVersion: 1, config }，只含公开字段', () => {
    let parts = null;
    let clicked = false;
    const link = { click() { clicked = true; } };
    const BlobStub = function (chunks) { parts = chunks; };
    const URLStub = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
    const state = { config: structuredClone(CURRENT) };

    loadExport({
        window: { NavigationSchema: schema },
        Blob: BlobStub,
        URL: URLStub,
        document: { createElement: () => link },
        setTimeout: () => {}
    }).call(state);

    assert.ok(clicked, '触发下载');
    assert.equal(link.download, 'habu-navigation.json');
    assert.equal(link.href, 'blob:test');
    const data = JSON.parse(parts[0]);
    assert.deepEqual(Object.keys(data), ['schemaVersion', 'config'], '顶层只允许两个字段');
    assert.equal(data.schemaVersion, 1);
    assert.deepEqual(data.config, schema.publicConfig(state.config), '导出的是当前内存配置的公开视图');
    assert.equal(data.config.privacyMode, undefined, 'privacyMode 不进导出文件');
    assert.equal(data.config.categories[0].bookmarks[0].id, 'zhihu', '分类与书签原样带出');
});

test('导入：校验通过后替换配置、立即保存并前移基线', async () => {
    const calls = [];
    const state = {
        config: structuredClone(CURRENT),
        configDirty: true,
        configSnapshot: 'old',
        confirmAction: async () => true,
        markConfigDirty() { calls.push('dirty'); },
        saveNavigation: async () => { calls.push('save'); return { success: true, revision: 9 }; },
        updateConfigStatus() { calls.push('status'); },
        applyTheme() { calls.push('theme'); },
        render() { calls.push('render'); },
        renderAdminPanel() { calls.push('panel'); },
        showToast(message, kind) { calls.push(['toast', message, kind]); }
    };
    const imported = {
        schemaVersion: 1,
        config: {
            theme: 'light',
            showBookmarkIcons: false,
            searchEngine: 'bing',
            searchEngines: [{ id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' }],
            categories: [
                { id: 'dev', name: '开发', bookmarks: [{ id: 'gh', title: 'GitHub', url: 'https://github.com' }] },
                { id: 'read', name: '阅读', bookmarks: [] }
            ]
        }
    };

    await loadImport().call(state, fileOf(imported));

    assert.equal(state.config.searchEngine, 'bing', '替换为导入的导航');
    assert.equal(state.config.categories.length, 2);
    assert.equal(state.config.privacyMode, true, 'privacyMode 保留导入前的值');
    assert.deepEqual(calls.filter(c => c === 'save'), ['save'], '只提交一次');
    assert.ok(calls.includes('dirty'), '保存前先标记为待保存');
    assert.equal(state.configSnapshot, JSON.stringify(state.config), '基线前移，关闭面板不会回滚');
    assert.equal(state.configDirty, false);
    assert.ok(calls.some(c => Array.isArray(c) && c[1].startsWith('已导入导航：2 个分类、1 个链接')), '成功提示带数量');
});

test('导入：版本或字段不对时拒绝，不弹确认也不保存', async () => {
    const calls = [];
    const state = {
        config: structuredClone(CURRENT),
        confirmAction: async () => { calls.push('confirm'); return true; },
        saveNavigation: async () => { calls.push('save'); return { success: true }; },
        markConfigDirty() {}, updateConfigStatus() {}, applyTheme() {}, render() {}, renderAdminPanel() {},
        showToast(message, kind) { calls.push(['toast', message, kind]); }
    };
    const run = loadImport();

    await run.call(state, fileOf({ schemaVersion: 2, config: CURRENT }));
    assert.ok(!calls.includes('confirm'), '版本不符不进入确认');
    assert.ok(!calls.includes('save'));
    assert.ok(calls.some(c => Array.isArray(c) && c[1].includes('版本或字段无效')));

    calls.length = 0;
    await run.call(state, fileOf({ schemaVersion: 1, config: CURRENT, extra: 1 }));
    assert.ok(!calls.includes('save'), '顶层多余字段同样拒绝');
});

test('导入：搜索引擎默认项失效时回退首项，而不是整份拒绝', async () => {
    let saved = null;
    const state = {
        config: structuredClone(CURRENT),
        confirmAction: async () => true,
        markConfigDirty() {}, updateConfigStatus() {}, applyTheme() {}, render() {}, renderAdminPanel() {},
        saveNavigation: async () => { saved = structuredClone(state.config); return { success: true, revision: 2 }; },
        showToast() {}
    };
    const payload = {
        schemaVersion: 1,
        config: {
            theme: 'auto',
            showBookmarkIcons: true,
            searchEngine: 'missing',
            searchEngines: [{ id: 'duck', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' }],
            categories: [{ id: 'c', name: '分类', bookmarks: [] }]
        }
    };

    await loadImport().call(state, fileOf(payload));
    assert.equal(saved.searchEngine, 'duck', '回退到首个可用引擎');
    assert.equal(saved.categories[0].id, 'c');
});

test('导入：确认取消后一行都不改', async () => {
    const calls = [];
    const state = {
        config: structuredClone(CURRENT),
        confirmAction: async () => false,
        saveNavigation: async () => { calls.push('save'); return { success: true }; },
        markConfigDirty() { calls.push('dirty'); }, updateConfigStatus() {}, applyTheme() {}, render() {}, renderAdminPanel() {},
        showToast() {}
    };
    await loadImport().call(state, fileOf({
        schemaVersion: 1,
        config: { ...schema.publicConfig(CURRENT), categories: [{ id: 'x', name: '新分类', bookmarks: [] }] }
    }));
    assert.equal(state.config.categories[0].id, 'read', '取消不修改内存配置');
    assert.deepEqual(calls, [], '取消不发保存请求');
});

test('导入：保存失败保留导入结果并给出可重试的提示', async () => {
    const calls = [];
    const state = {
        config: structuredClone(CURRENT),
        configSnapshot: 'old',
        confirmAction: async () => true,
        markConfigDirty() { calls.push('dirty'); },
        saveNavigation: async () => { throw new Error('配置已改变，请刷新后处理冲突'); },
        updateConfigStatus() { calls.push('status'); },
        applyTheme() { calls.push('theme'); },
        render() { calls.push('render'); },
        renderAdminPanel() { calls.push('panel'); },
        showToast(message, kind) { calls.push(['toast', message, kind]); }
    };
    await loadImport().call(state, fileOf({
        schemaVersion: 1,
        config: { ...schema.publicConfig(CURRENT), categories: [{ id: 'new', name: '导入的', bookmarks: [] }] }
    }));
    assert.equal(state.config.categories[0].id, 'new', '失败不回滚刚导入的内容');
    assert.notEqual(state.configSnapshot, JSON.stringify(state.config), '基线仍停在导入前，便于重试');
    assert.ok(calls.includes('panel'), '重画面板以显示导入结果');
    const toast = calls.find(c => Array.isArray(c) && c[2] === 'error');
    assert.ok(toast && toast[1].includes('配置已改变'), '错误原因原样透出');
});

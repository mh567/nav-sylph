const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const swJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 剥掉整行注释与块注释。源码形状断言曾被「注释里提到了标识符」的写法假绿。
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g).replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 按大括号配对取出一个类方法的完整方法体。
 * renderFavManager / renderAdminPanel 的模板字面量里，${...}
 * 插值自身花括号配平，计数不受影响。
 */
function methodBody(src, name) {
    const start = src.indexOf(name + '() {');
    assert.ok(start >= 0, `${name} 存在`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`${name} 方法体未闭合`);
}

test('书签检索执行真实实现：中文、混合输入、拼音与英文均可匹配且隔离私密条目', () => {
    const uFuzzy = new Function(fs.readFileSync(path.join(__dirname, '..', 'public/lib/uFuzzy.iife.min.js'), 'utf8') + '\nreturn uFuzzy;')();
    const Pinyin = require('../public/lib/pinyin.js');
    const dropdown = { innerHTML: '' };
    const state = { authenticated: true, favorites: [
        { id: 'private', title: '私密中文', url: 'https://private.example', private: true },
        { id: 'zh', title: '知乎', url: 'https://zhihu.com', category: '阅读', description: '中文问答社区', tags: ['知识'] },
        { id: 'stock', title: '雪球', url: 'https://xueqiu.com', description: '股票行情' },
        { id: 'dev', title: 'GitHub 开发', url: 'https://github.com', category: '技术' }
    ], privacySearchActive: false, renderFavResults(rows) { this.results = rows; },
    renderFavManagerList(rows) { this.managerResults = rows; } };
    const loadMethod = (signature) => {
        const start = appSource.indexOf(`        ${signature} {`);
        assert.ok(start >= 0, `${signature} 存在`);
        const end = appSource.indexOf('\n        }', start);
        assert.ok(end > start, `${signature} 末端存在`);
        return new Function('uFuzzy', 'Pinyin', '$', `return ({ ${appSource.slice(start, end + 10)} });`)(uFuzzy, Pinyin, () => dropdown);
    };
    for (const signature of ['buildSearchIndex()', 'getSearchableFavorites()', 'searchFavorites(query)', 'filterFavManager(query, category)']) {
        Object.assign(state, loadMethod(signature));
    }
    state.buildSearchIndex();
    for (const [query, expected] of [['知乎', 'zh'], ['股票行情', 'stock'], ['知识', 'zh'], ['阅读', 'zh'], ['GitHub 开发', 'dev'], ['zhihu', 'zh'], ['ZH', 'zh'], ['github', 'dev']]) {
        state.results = [];
        state.searchFavorites(query);
        assert.ok(state.results.some(row => row.id === expected), `首页 ${query} 命中 ${expected}`);
        state.filterFavManager(query, '');
        assert.ok(state.managerResults.some(row => row.id === expected), `后台 ${query} 命中 ${expected}`);
    }
    state.results = [];
    state.searchFavorites('私密中文');
    assert.deepEqual(state.results, []);
    state.adminFavorites = state.favorites;
    state.privacySearchActive = true;
    state.searchFavorites('私密中文');
    assert.deepEqual(state.results.map(row => row.id), ['private']);
    state.filterFavManager('知乎', '技术');
    assert.deepEqual(state.managerResults, []);
    state.results = [];
    state.searchFavorites('不存在的条目');
    assert.deepEqual(state.results, []);
});

test('后台 tab 栏：收藏夹是第二个，「同步管理」在模块与账户之间（共五个）', () => {
    const tabs = [...appSource.matchAll(
        /<button type="button" class="admin-tab" role="tab" id="adminTab(\w+)" aria-controls="adminPanel\1" aria-selected="false" tabindex="-1" data-panel="(\w+)">([^<]+)/g
    )];
    assert.equal(tabs.length, 5, '恰好五个 tab（同步管理从「首页导航」里拆出来自成一格）');
    assert.deepEqual(tabs.map(t => t[2]), ['site', 'fav', 'modules', 'sync', 'account'], 'tab 顺序');
    assert.deepEqual(tabs.map(t => t[3]), ['首页导航', '收藏夹', '模块', '同步管理', '账户与备份'], 'tab 文案');
});

test('收藏分区整区迁入收藏夹 tab，账户与备份不再持有任何收藏入口', () => {
    const favStart = appSource.indexOf('id="adminPanelFav"');
    const modulesStart = appSource.indexOf('id="adminPanelModules"');
    const syncStart = appSource.indexOf('id="adminPanelSync"');
    const accountStart = appSource.indexOf('id="adminPanelAccount"');
    assert.ok(favStart > 0 && modulesStart > favStart && syncStart > modulesStart && accountStart > syncStart,
        '五个面板按 tab 顺序排列');

    // 收藏夹 tab = adminPanelFav 起、adminPanelModules 止
    const favPanel = appSource.slice(favStart, modulesStart);
    assert.match(favPanel, /id="importFavBtn">导入书签</, '导入书签按钮在收藏夹 tab 内');
    assert.match(favPanel, /id="exportFavBtn">导出书签</, '导出书签按钮在收藏夹 tab 内');
    assert.match(favPanel, /id="addFavBtn">添加书签</, '添加书签按钮在收藏夹 tab 内');
    assert.match(favPanel, /id="favManagerHost"/, '收藏管理器宿主容器在收藏夹 tab 内');
    assert.match(favPanel, />收藏夹</, '分区标题是「收藏夹」');
    assert.match(favPanel, /个书签/, '统计行按书签计数');

    // 账户与备份面板 = adminPanelAccount 起、bindAdminTabs 调用止
    const accountEnd = appSource.indexOf('this.bindAdminTabs();', accountStart);
    assert.ok(accountEnd > accountStart, '账户与备份面板边界可定位');
    const accountPanel = appSource.slice(accountStart, accountEnd);
    assert.doesNotMatch(accountPanel, /manageFavBtn|importFavBtn|exportFavBtn|addFavBtn|favFileInput/,
        '账户与备份不再持有收藏分区的任何控件');
});

test('showFavManager 被 renderFavManager 取代，「← 返回」整条路径移除', () => {
    const src = stripComments(appSource);
    assert.doesNotMatch(src, /showFavManager/, '旧入口彻底移除（包括调用点）');
    assert.match(src, /renderFavManager\(\)/, '新入口存在');
    assert.doesNotMatch(src, /backToAdmin/, '返回按钮及其绑定一并移除');
});

test('renderFavManager 渲染进 #favManagerHost，方法体内不写 #modalBody', () => {
    const body = methodBody(appSource, 'renderFavManager');
    assert.match(body, /const host = \$\('#favManagerHost'\);\s*\n\s*if \(!host\) return;/,
        '以 #favManagerHost 为宿主，容器缺席时安全返回');
    assert.match(body, /host\.innerHTML = `/, '写入宿主容器');
    assert.doesNotMatch(body, /modalBody/, '不再整块替换 #modalBody');
    // 分类树与列表的既有结构保留：批量条、全选、统计、列表、页脚
    for (const id of ['favBatchBar', 'selectAllFav', 'favSelectedCount', 'privacySelectedBtn', 'deleteSelectedBtn', 'favManagerStats', 'favManagerList', 'favManagerFooter', 'categoryTree', 'favManagerSearch', 'addCategoryBtn']) {
        assert.match(body, new RegExp(`id="${id}"`), `既有控件 #${id} 保留`);
    }
});

test('头部「共 N 个书签」计数由 updateFavStat 统一刷新', () => {
    // 管理器只重绘 #favManagerHost，头部统计不在其中。若 renderFavManager
    // 不主动刷新，tab 内删除/导入后这一行会停在旧值——从前它与列表分处
    // 两个 tab，看不出来；现在同屏可见。
    const src = stripComments(appSource);
    assert.match(src, /this\.updateFavStat\(\);\s*\n\s*\}/, 'renderFavManager 末尾刷新头部计数');
    assert.match(src, /this\.favoritesLoading = false;\s*\n\s*this\.updateFavStat\(\);/, 'loadFavorites 走同一个刷新入口');
    const stat = methodBody(appSource, 'updateFavStat');
    assert.match(stat, /\$\('\.fav-stats strong'\)/, '写入 .fav-stats strong');
    assert.match(stat, /this\.favoritesLoading \? '加载中' : this\.favorites\.length/, '加载中与真实数量两种取值');
    // 写入点有且只有一处（就在 updateFavStat 内）——旧的内联写法已并入它，
    // 散落的第二处正是「删了书签但头部不动」这类漂移的来源。
    const writes = src.split("$('.fav-stats strong')").length - 1;
    assert.equal(writes, 1, '.fav-stats strong 全校只有一处写入');
});

test('selectAdminTab：收藏夹分区惰性渲染，renderAdminPanel 每次复位', () => {
    const src = stripComments(appSource);
    assert.match(src, /if \(panel === 'fav' && !this\.favManagerRendered\) \{\s*\n\s*this\.renderFavManager\(\);\s*\n\s*this\.favManagerRendered = true;/,
        '首次进入收藏夹分区才渲染管理器');
    const adminBody = methodBody(appSource, 'renderAdminPanel');
    assert.match(adminBody, /this\.favManagerRendered = false;/,
        '面板 DOM 每次重建，渲染标记必须复位——否则收藏夹分区会停在「从未渲染」');
});

test('全产品线换名：用户可见文案不再以「收藏」称呼条目', () => {
    const src = stripComments(appSource);
    // 注意：「收藏管理」不能列入——它是合法新词「收藏管理器」的子串
    const stale = ['管理收藏', '导入收藏', '导出收藏', '添加收藏', '全部收藏', '收藏已保存',
        '个收藏', '收藏检索', '搜索收藏', '无收藏', '收藏加载', '编辑收藏', '删除收藏',
        '移动收藏', '只恢复收藏', '配置和收藏', '收藏文件'];
    for (const s of stale) {
        assert.ok(!src.includes(s), `app.js 不应再出现「${s}」`);
    }
    assert.doesNotMatch(indexHtml, /收藏/, 'index.html 不再出现「收藏」');
    assert.doesNotMatch(serverSource, /读取收藏失败|保存收藏失败/, 'server.js 错误文案已换名');
});

test('条目改称书签：收藏夹内的操作文案用「书签」', () => {
    const src = stripComments(appSource);
    assert.match(src, /placeholder="搜索书签（支持拼音）\.\.\."/, '管理器搜索框');
    assert.match(src, /aria-label="全部书签"/, '分类树「全部」节点');
    assert.match(src, /<h3>添加书签<\/h3>/, '添加弹窗标题');
    assert.match(src, /<h3>编辑书签<\/h3>/, '编辑弹窗标题');
    assert.match(src, /'书签已保存到服务器'/, '保存提示');
    assert.match(src, /`导入成功，新增 \$\{res\.imported\} 个书签/, '导入提示');
    assert.match(src, /`已更新 \$\{targets\.length\} 个书签的隐私状态`/, '批量隐私提示');
    assert.match(src, /`确定删除选中的 \$\{count\} 个书签？`/, '批量删除确认');
    assert.match(src, /'确定删除此书签？', '删除书签', true/, '单条删除确认');
    assert.match(src, /<span>只恢复书签（含隐私标签）<\/span>/, 'WebDAV 恢复选项');
    // 「同时恢复」的括号里按「这一组里实际有哪些域」拼：只放模块时是「（含模块设置）」，
    // 时间线也在时是「（含备忘录、模块设置、时间线）」——没有任何私人数据时不显示这一项。
    assert.match(src, /<input type="radio" name="restoreType" value="all"/,
        'WebDAV 恢复选项：同时恢复书签与私人数据');
    assert.match(src, /同时恢复书签与私人数据（含\$\{\[hasMemos && '备忘录'/,
        '括号内容由这一组实际包含的域决定');
    assert.match(src, /<span>只恢复备忘录（正文与置顶状态）<\/span>/,
        'WebDAV 恢复选项含备忘录');
    assert.match(src, /<span>只恢复时间线（事件与归档 \/ 收藏状态）<\/span>/,
        'WebDAV 恢复选项含时间线');
    // 恢复对话框不得再谈 token（凭据不随备份），并要列出「恢复后需重新授权」的项目
    assert.doesNotMatch(src, /只恢复模块设置（监控目标、布局、token）/,
        '恢复选项里不再出现 token 字样');
    assert.match(src, /恢复后需要重新授权 \/ 重新部署的项目/, '列出恢复后需授权/需部署的项目');
    assert.match(src, /旧范围的备份：<strong>只恢复书签<\/strong>/, '旧备份醒目提示「只恢复书签」');
});

test('首页网格条目改称「导航」，与收藏夹的「书签」分层', () => {
    const src = stripComments(appSource);
    assert.match(src, /title="为「\$\{this\.esc\(cat\.name\)\}」添加导航" aria-label="为 \$\{this\.esc\(cat\.name\)\} 添加导航"/,
        '分类末尾的＋卡');
    assert.match(src, /title="删除导航" aria-label="删除导航 \$\{this\.esc\(bm\.title\)\}"/, '书签卡删除按钮');
    assert.match(src, /title: `为「\$\{cat\.name\}」添加导航`/, '添加导航弹窗标题');
    assert.match(src, /title: '编辑导航'/, '编辑导航弹窗标题');
    assert.match(src, /`删除导航「\$\{bm\.title\}」？`/, '删除导航确认');
    assert.match(src, /`删除分类「\$\{cat\.name\}」及其中的 \$\{cat\.bookmarks\.length\} 个导航？`/, '删除分类确认');
    assert.match(src, /'导航已添加，点「保存编辑」生效'/, '添加提示');
    assert.match(indexHtml, /id="layoutBtn" title="编辑首页导航"/, '底栏编辑入口 title');
    // 旧网格文案不得残留
    assert.doesNotMatch(src, /编辑首页布局与书签/);
    assert.doesNotMatch(src, /添加书签" aria-label/);
    assert.doesNotMatch(src, /删除书签 \$\{this\.esc\(bm\.title\)\}/);
});

test('匿名搜索框仅提示网页搜索', () => {
    assert.match(indexHtml, /placeholder="搜索网页"/);
    assert.match(appSource, /input\.placeholder = this\.authenticated \? '搜索网页或书签' : '搜索网页';/);
    assert.doesNotMatch(appSource, /搜索网页或收藏/);
    assert.doesNotMatch(indexHtml, /搜索网页或收藏/);
});

test('sw.js：CACHE 升到 nav-v125（同步管理 tab），注释块记录本次变更', () => {
    assert.match(swJs, /const CACHE = 'nav-v125';/);
    // 注释块的第一条必须**以当前缓存号开头并带说明**。这里不写死「本轮的主题」：
    // 主题随每次升级变化，写死就要每轮改一次断言（而真正要钉的是「注释跟着 CACHE 走」
    // 这个关系，见下面的派生断言）。
    const head = swJs.split('\n')[0];
    assert.match(head, /^\/\/ nav-v125：\S/, '第一条注释要带当前版本号与说明');
    // 注释块记录的最新版本必须**就是** CACHE 里的那个——两者漂移意味着有人改了其一。
    // 这里不写死版本号：写死的话每次升缓存都要改断言，而断言该钉的是「两者一致」
    // 这个关系（升号时改 CACHE 与注释就够，不必再想起这个文件）。
    const cache = /const CACHE = 'nav-(v\d+)';/.exec(swJs)[1];
    const latest = [...swJs.matchAll(/\/\/ nav-(v\d+)：/g)].map(m => m[1]);
    assert.equal(latest[0], cache, '注释块第一条即最新版本');
    assert.ok(latest.every((v, i) => i === 0 || Number(v.slice(1)) <= Number(latest[i - 1].slice(1))),
        '注释块版本号递减');
});

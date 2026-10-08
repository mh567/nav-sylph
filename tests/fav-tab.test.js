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

test('后台 tab 栏：收藏夹是第二个，顺序为 导航 · 收藏夹 · 模块 · 账户', () => {
    const tabs = [...appSource.matchAll(
        /<button type="button" class="admin-tab" role="tab" id="adminTab(\w+)" aria-controls="adminPanel\1" aria-selected="false" tabindex="-1" data-panel="(\w+)">([^<]+)/g
    )];
    assert.equal(tabs.length, 4, '恰好四个 tab');
    assert.deepEqual(tabs.map(t => t[2]), ['site', 'fav', 'modules', 'account'], 'tab 顺序');
    assert.deepEqual(tabs.map(t => t[3]), ['首页导航', '收藏夹', '模块', '账户与备份'], 'tab 文案');
});

test('收藏分区整区迁入收藏夹 tab，账户与备份不再持有任何收藏入口', () => {
    const favStart = appSource.indexOf('id="adminPanelFav"');
    const modulesStart = appSource.indexOf('id="adminPanelModules"');
    const accountStart = appSource.indexOf('id="adminPanelAccount"');
    assert.ok(favStart > 0 && modulesStart > favStart && accountStart > modulesStart, '四个面板按 tab 顺序排列');

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
    assert.match(src, /<span>只恢复书签<\/span>/, 'WebDAV 恢复选项');
    // 括号里的内容按「这一组里实际有哪些文件」拼：只放模块时是「（含模块设置）」，
    // 时间线也在时是「（含模块设置与时间线）」——两者都不在时完全不显示括号。
    assert.match(src, /同时恢复配置和书签\$\{\(hasModules \|\| hasTimeline\)/,
        'WebDAV 恢复选项（含模块与时间线）');
    assert.match(src, /<span>只恢复时间线（事件与已读 \/ 归档状态；凭据需重新填写）<\/span>/,
        'WebDAV 恢复选项含时间线');
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
    assert.match(src, /'编辑首页导航'/, '右下角编辑按钮 title');
    // 旧网格文案不得残留
    assert.doesNotMatch(src, /编辑首页布局与书签/);
    assert.doesNotMatch(src, /添加书签" aria-label/);
    assert.doesNotMatch(src, /删除书签 \$\{this\.esc\(bm\.title\)\}/);
});

test('placeholder 在 index.html 与 app.js 两层一致（搜索网页或书签）', () => {
    assert.match(indexHtml, /placeholder="搜索网页或书签"/);
    assert.match(appSource, /input\.placeholder = '搜索网页或书签';/);
    assert.doesNotMatch(appSource, /搜索网页或收藏/);
    assert.doesNotMatch(indexHtml, /搜索网页或收藏/);
});

test('sw.js：CACHE 升到 nav-v80，注释块记录本次变更', () => {
    assert.match(swJs, /const CACHE = 'nav-v80';/);
    assert.match(swJs, /nav-v80：修首屏布局判定读不到模块声明/);
    // 注释块记录的最新版本必须就是 CACHE——两者漂移意味着有人改了其一
    const latest = [...swJs.matchAll(/\/\/ nav-(v\d+)：/g)].map(m => m[1]);
    assert.equal(latest[0], 'v80', '注释块第一条即最新版本');
    assert.ok(latest.every((v, i) => i === 0 || Number(v.slice(1)) <= Number(latest[i - 1].slice(1))),
        '注释块版本号递减');
});

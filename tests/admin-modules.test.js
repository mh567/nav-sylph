'use strict';

/**
 * 后台「模块」分区的结构契约。
 *
 * 用户原话：「后台管理模块页的配置应该按照模块分割，比如监控目标应该和服务器监控
 * 和开关放在一起，订阅来源管理应该和 specialline 模块名称和开关放在一起等，
 * 现在逻辑混乱」。
 *
 * 所以这里钉的是三件事：
 *   ① 每个模块一块，块头是「名称 + 说明 + 开关」，块内是它自己的配置；
 *   ② 未启用时配置收起（版式 C，用户选的），点「展开配置」就地展开；
 *   ③ **平台侧不再有任何模块专属的渲染代码**——监控目标整块搬进了
 *      `public/modules/server-monitor.js`，平台只提供容器与服务包。
 *
 * 形态参照 `docs/mockup-admin-modules.html`（已确认的仿真样例）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const monitorSource = fs.readFileSync(path.join(ROOT, 'public', 'modules', 'server-monitor.js'), 'utf8');
const adminCss = fs.readFileSync(path.join(ROOT, 'public', 'admin.css'), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

/**
 * 切出一个方法/函数的**含签名片段**。两种缩进（app.js 的类方法 8 空格、
 * 模块文件的函数声明 4 空格）与 `function ` 前缀都要认——只认一种时切片会是
 * 空串，而空切片让断言静默落空（看起来和通过一样绿）。
 */
function methodBodyOf(code, name) {
    const re = new RegExp(`\\n( {8}| {4})(?:async )?(?:function )?${name}\\([^()]*\\) \\{`);
    const m = re.exec(code);
    if (!m) return '';
    const indent = m[1];
    const rest = code.slice(m.index + 1);
    const next = rest.search(new RegExp(`\\n${indent}(?:async )?(?:function )?[a-zA-Z_][\\w$]*\\(`));
    return next > 0 ? rest.slice(0, next) : rest;
}

// ========== ① 模块块的结构与折叠（执行真实方法）==========

test('每个模块一块：块头是名称+说明+开关，块内是它自己的配置落点', () => {
    const body = methodBodyOf(stripComments(appSource), 'renderModuleBlock');
    assert.ok(body.length > 500, `切出 renderModuleBlock（${body.length}）`);
    const render = new Function('def', 'config', `return ({ ${body} }).renderModuleBlock;`)();

    const def = { id: 'special-line', title: 'Special Line', summary: 'X / 微博订阅与手动保存的文章', adminSectionTitle: '订阅来源', renderAdminSection() {} };
    const html = render.call({ esc: s => String(s), expandedDisabled: new Set() }, def, { enabledModules: ['special-line'] });

    assert.match(html, /class="module-block" data-module="special-line" data-enabled="1"/, '一块一个容器，带模块 id 与启用态');
    assert.match(html, /class="module-block-title">Special Line</, '块头有模块名');
    assert.match(html, /class="module-block-summary">X \/ 微博订阅与手动保存的文章</, '说明紧贴名称');
    assert.match(html, /data-module-toggle="special-line" checked/, '开关在块头里');
    assert.match(html, /class="module-setting-state">已启用</, '状态文字紧贴开关');
    assert.match(html, /class="module-block-sub">订阅来源</, '配置区的名字由模块自己给（adminSectionTitle）');
    assert.match(html, /class="module-admin-section" data-module-admin="special-line"/, '配置落点在块内');
    assert.doesNotMatch(html, /module-block-off-note/, '已启用时不出现折叠提示');
});

test('未启用时配置收起：只留一行提示与「展开配置」；点开后就地展开', () => {
    const body = methodBodyOf(stripComments(appSource), 'renderModuleBlock');
    const render = new Function('def', 'config', `return ({ ${body} }).renderModuleBlock;`)();
    const def = { id: 'special-line', title: 'Special Line', adminSectionTitle: '订阅来源', renderAdminSection() {} };

    // 未启用、没展开过
    const collapsed = render.call({ esc: s => String(s), expandedDisabled: new Set() }, def, { enabledModules: [] });
    assert.match(collapsed, /data-enabled="0"/, '标记为未启用');
    assert.match(collapsed, /class="module-block-off-note"[\s\S]*?未启用，配置先收起来。[\s\S]*?data-expand-module="special-line"/,
        '收起态给一行提示 + 展开入口');
    assert.doesNotMatch(collapsed, /module-admin-section/,
        '★ 收起时**不渲染**配置容器：模块自己的接口因此不会被拉（关掉的模块不该还在后台打请求）');
    assert.match(collapsed, /data-module-toggle="special-line" >?\s*$/m, '开关不带 checked');

    // 未启用、但用户点过展开
    const expanded = render.call({ esc: s => String(s), expandedDisabled: new Set(['special-line']) }, def, { enabledModules: [] });
    assert.match(expanded, /module-admin-section/, '展开后配置容器在');
    assert.doesNotMatch(expanded, /module-block-off-note/, '展开后不再有收起提示');
});

test('没有后台配置的模块：块内一句淡字说明，且不出现折叠入口', () => {
    const body = methodBodyOf(stripComments(appSource), 'renderModuleBlock');
    const render = new Function('def', 'config', `return ({ ${body} }).renderModuleBlock;`)();
    // memo 就是这种：只声明了挂件，没有 renderAdminSection
    const def = { id: 'memo', title: '备忘录', summary: '随手记几行' };
    const html = render.call({ esc: s => String(s), expandedDisabled: new Set() }, def, { enabledModules: [] });
    assert.match(html, /这个模块没有额外配置/, '给一句说明而不是空块');
    assert.doesNotMatch(html, /module-block-off-note/, '没东西可收，就不给折叠入口');
    assert.doesNotMatch(html, /module-admin-section/, '也不该凭空造一个配置容器');
});

// ========== ② 分区装配：模块块在前、平台设置在末尾 ==========

test('模块页装配：每块来自 KNOWN_MODULES，平台设置单独一块且在末尾', () => {
    const body = methodBodyOf(stripComments(appSource), 'renderModulesEditorContent');
    assert.ok(body.length > 800, `切出编辑器方法体（${body.length}）`);

    // ⚠️ 这里是**模板字符串**里的顺序，所以 indexOf 就是渲染出来的 DOM 顺序
    //（不是 JS 调用顺序，那种「源码顺序 ≠ 运行顺序」的坑在这里不适用）。
    const blocksAt = body.indexOf('known.map(def => this.renderModuleBlock(def, config))');
    const platformAt = body.indexOf('class="platform-block"');
    const selfSignedAt = body.indexOf('${this.selfSignedRow()}');
    const pollAt = body.indexOf('${this.pollIntervalRow(config)}');
    assert.ok(blocksAt > 0, '模块块由 KNOWN_MODULES 逐块生成（顺序即模块注册顺序）');
    assert.ok(platformAt > blocksAt, '平台设置排在所有模块块之后');
    assert.ok(selfSignedAt > platformAt && pollAt > platformAt, '自签与更新周期都在平台设置块里');

    // 早先那条「开关列表 + 配置区两段分」的模板必须彻底消失
    assert.doesNotMatch(body, /module-setting-row/, '不再有旧的「开关行」模板');
    assert.doesNotMatch(body, /监控目标/, '平台侧不再硬写某个模块的配置区标题');
});

// ========== ③ 平台侧不再有模块专属代码 ==========

test('监控目标整块搬进模块文件：平台侧不留任何模块专属渲染', () => {
    const code = stripComments(appSource);
    // 这些名字随搬迁从 app.js 消失。逐个点名的好处是失败信息直接指出复活的那一个。
    const gone = [
        'server-item', 'renderServerList', 'renderLocalServerCard', 'renderServerStatusBits',
        'renderServerStateBody', 'serverDeployState', 'serverDeployBit', 'serverOnlineState',
        'renderDeployAction', 'isAgentOutdated', 'displayUrlOf', 'schedulePendingProbe',
        'clearPendingProbe', 'saveServerVisibility', 'showServerDialog', 'showDeployDialog',
        'showCommandPanel', 'richIntro', 'findServerById', 'lastProbe',
        'enroll-token', '#serverList', '#addServerBtn', 'data-server-visible'
    ];
    for (const name of gone) {
        assert.equal(code.includes(name), false, `app.js 里不得再有 ${name}（它属于 server-monitor 模块）`);
    }
    // ⚠️ 反向断言：它们确实**搬到了**模块文件，而不是被整块删掉——
    // 只查「app.js 里没有」的话，把功能删掉也能让上面那条全绿。
    const mod = stripComments(monitorSource);
    for (const name of ['renderServerList', 'renderLocalServerCard', 'showDeployDialog',
        'schedulePendingProbe', 'renderAdminSection', 'onAdminSectionClose']) {
        assert.ok(mod.includes(name), `模块文件里有 ${name}`);
    }
    // 平台侧仍保留的两处「提到监控」都不是渲染代码：
    // ① 模块 id 白名单；② 远程备份恢复对话框里那句说明覆盖范围的文案。
    assert.match(code, /KNOWN_MODULES = \['server-monitor'/, 'id 白名单照旧');
});

// ========== ④ 后台服务包与唯一写路径 ==========

test('后台服务包：模块从注入的服务里取能力，不去够平台内部', () => {
    const body = methodBodyOf(stripComments(appSource), 'moduleServices');
    assert.ok(body.length > 300, `切出 moduleServices（${body.length}）`);
    // ⚠️ 只列**真被消费**的键：`requestStack` 那两个模块在后台都不用（它是
    // mountWidget 那条路径的服务），留在包里等于给后来者一个没人用的入口。
    for (const key of ['api:', 'get config()', 'saveConfig:', 'reloadConfig:', 'toast:', 'dialog:',
        'confirm:', 'notice:', 'refreshAdmin:', 'refreshHome:',
        'selfSigned:', 'version:']) {
        assert.ok(body.includes(key), `服务包里有 ${key}`);
    }
    // ⚠️ 配置与两个「读实时值」的必须用取值器/函数，不能用快照：
    // 写入之后平台会更新配置，快照会让模块读到上一版（丢改动那类事故）。
    assert.match(body, /get config\(\) \{ return app\.modulesConfig; \}/, 'config 是取值器而不是快照');
    assert.match(body, /selfSigned: \(\) => app\.selfSignedCert === true/, '自签标记读实时值');
    assert.match(body, /version: \(\) => app\.currentVersion \|\| ''/, '版本号读实时值');
    // ⚠️ 包里的每一项都必须**经 app 实例**调用平台能力。
    // 这条是被真机抓出来的：`showToast` / `showUiDialog` 是 App 的**方法**，
    // 不是文件作用域里的函数，写成裸名会 ReferenceError——而它在静态断言里
    // 看不出来（服务包的键都在、切片也正常），只有真点一次才炸。
    const bare = [];
    for (const line of body.split('\n')) {
        const m = /=>\s*([a-zA-Z_$][\w$]*)\(/.exec(line);
        if (m && !/^app$|^showUiDialog$/.test(m[1])) bare.push(`${m[1]}()  ← ${line.trim().slice(0, 60)}`);
    }
    assert.deepEqual(bare, [], `服务包里的平台能力必须写成 app.xxx()：${bare.join(' / ')}`);
    assert.match(body, /app\.showToast\(/, 'toast 经实例调用');
    assert.match(body, /app\.showUiDialog\(/, 'dialog 经实例调用');
    // 平台把整个包交给模块的后台区块
    assert.match(stripComments(appSource), /def\.renderAdminSection\(el, this\.moduleServices\(\)\)/,
        '调用处注入的是整个服务包');
});

test('模块配置只有一条写路径：saveModulesConfig（后台三处都改走它）', () => {
    const code = stripComments(appSource);
    // ⚠️ 首页编辑态的 saveWidgetLayout 是**有意**保留的第二条（草稿/回滚语义纠缠），
    // 所以这里数的是 2：一条模块配置的通用写路径 + 一条首页拖拽布局的写路径。
    const posts = [...code.matchAll(/API\.post\('\/api\/modules\/config'/g)];
    assert.equal(posts.length, 2, `写路径恰好两条（实际 ${posts.length}）`);
    const save = methodBodyOf(code, 'saveModulesConfig');
    assert.ok(save.length > 300, `切出 saveModulesConfig（${save.length}）`);
    assert.match(save, /await API\.post\('\/api\/modules\/config'/, '通用写路径在这里');
    assert.match(save, /enabledModules: merged\.enabledModules[\s\S]*?widgets: merged\.widgets[\s\S]*?servers: merged\.servers/,
        '按服务端要的形状整份提交，不是只带自己关心的那几个键');
    // ⚠️ 原地更新，不换对象：各处（渲染闭包、模块拿到的取值器）都握着这个引用
    assert.match(save, /Object\.assign\(this\.modulesConfig, merged\)/,
        '原地合并（换对象会让别人手里的引用过期）');
    // 后台三处消费方都改走它了
    for (const [name, marker] of [['模块开关', /await this\.saveModulesConfig\(\{ enabledModules: next \}\)/],
        ['更新周期', /await this\.saveModulesConfig\(\{ pollInterval: value \}\)/]]) {
        assert.match(code, marker, `${name}走通用写路径`);
    }
    // 模块文件里也不该自己拼请求体（那是把写路径又拆回去）
    assert.equal(stripComments(monitorSource).includes("API.post('/api/modules/config'"), false,
        '模块自己不再直接 POST 模块配置');
    assert.match(stripComments(monitorSource), /await services\.saveConfig\(\{ widgets \}\)/,
        '显示/隐藏走注入的 saveConfig');
});

// ========== ⑤ 生命周期：平台不认识「探测定时器」 ==========

test('后台区块的关闭由模块自己收尾（平台不再写死清某个定时器）', () => {
    const code = stripComments(appSource);
    const closer = methodBodyOf(code, 'closeModuleAdminSections');
    assert.ok(closer.length > 150, `切出 closeModuleAdminSections（${closer.length}）`);
    assert.match(closer, /KNOWN_MODULES/, '逐个模块问（平台不认模块 id）');
    assert.match(closer, /def\.onAdminSectionClose\(\)/, '调用可选的 onAdminSectionClose');
    assert.match(closer, /catch/, '单个模块抛错不影响关面板');
    // 关面板时真的调它（closeAdmin 带一个默认参数，所以用切片助手而不是 indexOf）
    const closeAdmin = methodBodyOf(code, 'closeAdmin');
    assert.ok(closeAdmin.length > 200, `切出 closeAdmin（${closeAdmin.length}）`);
    assert.match(closeAdmin, /this\.closeModuleAdminSections\(\)/, 'closeAdmin 里通知各模块');

    const mod = stripComments(monitorSource);
    const hook = methodBodyOf(mod, 'onAdminSectionClose');
    assert.ok(hook.length > 30, `模块实现了 onAdminSectionClose（${hook.length}）`);
    assert.match(hook, /clearPendingProbe\(\)/, '模块收掉自己的探测定时器');
});

// ========== ⑥ CSS 与布局约束 ==========

test('模块块的样式：块头两栏、未启用折叠条、平台块分隔线', () => {
    // ⚠️ 剥注释再查死规则：admin.css 里留了一句「这里曾有 navDeployPulse」的说明，
    // 不剥的话断言会把自己的记录当成违规代码。
    const cssCode = stripComments(adminCss);
    const block = /\.modal \.module-block \{([^}]*)\}/.exec(adminCss);
    assert.ok(block, '有 .module-block 规则');
    assert.match(block[1], /border-radius/, '块有圆角（与卡片同一套观感）');
    const head = /\.modal \.module-block-head \{([^}]*)\}/.exec(adminCss);
    assert.ok(head, '有块头规则');
    assert.match(head[1], /display: flex/, '块头是「左文案 + 右开关」两栏');
    const note = /\.modal \.module-block-off-note \{([^}]*)\}/.exec(adminCss);
    assert.ok(note, '有折叠提示条规则');
    assert.match(note[1], /border-top/, '折叠条与块头之间有分隔线');
    assert.match(adminCss, /\.modal \.platform-block \{[^}]*border-top/,
        '平台设置块有自己的分隔线，与模块分开');
    // 窄屏：展开按钮也要到 44px 触摸下限（与列表里的按钮同一条规则）
    const narrow = adminCss.slice(adminCss.indexOf('@media (max-width: 899px)'));
    assert.match(narrow.slice(0, 900), /module-block-off-note button \{ min-height: 44px/,
        '窄屏下展开按钮也抬到 44px');
    // 死规则清理（现代码不再产出它们）
    assert.doesNotMatch(cssCode, /\.modal \.server-item-token/, 'token 徽章的死规则已删');
    assert.doesNotMatch(cssCode, /navDeployPulse/, '呼吸圆点的死规则已删');
    assert.doesNotMatch(cssCode, /#saveModulesBtn/, '保存按钮的死规则已删');
});

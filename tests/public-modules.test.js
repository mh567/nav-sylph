'use strict';

/**
 * Issue #6「开放获准公开模块」。
 *
 * 两条证据链，缺一不算验收：
 *  ① **真实 HTTP + 真实持久化**：临时安装、真实会话、真实 .modules.json。
 *     越权（匿名直读私人模块接口）、策略撤回（撤回后立刻 403）、
 *     共享缓存的并发合并、管理员可用未开放的公开模块、私人模块不能被转公开。
 *  ② **执行真实代码的客户端契约**：把 app.js 的方法体与模块文件里的真实声明
 *     切出来真跑一遍——不是读源码字符串。
 *     少数几条仍是源码形状断言（例如「两处名单一致」这种跨文件登记关系，
 *     跑起来也表达不出「两处」这件事），凡是形状断言都写明它守的是什么。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const bcrypt = require('bcrypt');
const { installation } = require('./helpers/installation');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const MODULE_IDS = ['memo', 'server-monitor', 'special-line', 'weibo-hot'];

// ===================== 夹具 =====================

/**
 * 上游桩。**必须**用桩：真连外网既不确定，也没法断言「并发只打一趟」。
 * 第二条数据带 `javascript:` 是故意的——服务端的 href 白名单要把空串落进去，
 * 这条断言的是「第一道过滤真的在服务端」。
 */
async function weiboStub(t) {
    let hits = 0;
    const srv = http.createServer((req, res) => {
        hits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            code: 200,
            data: {
                list: [
                    { rank: 0, title: '榜一', hot_value: 400000, label: '热', url: 'https://s.weibo.com/weibo?q=x' },
                    { rank: 1, title: '榜二', hot_value: 300000, label: '', url: 'javascript:alert(1)' }
                ]
            }
        }));
    });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    t.after(() => srv.close());
    return { url: `http://127.0.0.1:${srv.address().port}/hot`, hits: () => hits };
}

/** 起一个真实安装，并登录取到管理员会话 Cookie。 */
async function adminSession(t) {
    const stub = await weiboStub(t);
    const app = await installation(t, { env: { NAV_WEIBO_HOT_URL: stub.url } });
    // ⚠️ 必须换成**强**口令再启动：安装夹具默认的 admin123 会被
    // `strongPassword()` 判为弱口令，登录拿到的是 purpose='password-change'
    // 的会话，而 requireAdmin 一律拒绝它——症状是每个特权请求都 401。
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'),
        JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const res = await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} });
    assert.equal(res.status, 200, '管理员登录成功');
    return { app, stub, cookie: res.headers.get('set-cookie').split(';')[0] };
}

/** 改对外开放名单。走真实写接口（含 revision/operationId 协议）。 */
async function setOpen(app, cookie, publicModules, operationId) {
    const base = await (await app.request('/api/modules/config', { cookie })).json();
    const res = await app.request('/api/modules/config', {
        cookie,
        body: {
            publicModules,
            revision: base.revision,
            operationId: operationId || `open-${publicModules.join('-') || 'none'}-${base.revision}`
        }
    });
    assert.equal(res.status, 200, '开放名单写入成功');
    return res.json();
}

const anon = (app, route) => app.request(route);

// ===================== ① 真实 HTTP =====================

test('HTTP：未开放时匿名被拒，匿名策略清单为空', async t => {
    const { app } = await adminSession(t);

    const policy = await anon(app, '/api/modules/public');
    assert.equal(policy.status, 200, '策略接口匿名可读');
    assert.deepEqual((await policy.json()).modules, [], '默认一个都没开放——新公开模块默认关闭');

    const denied = await anon(app, '/api/weibo-hot');
    assert.equal(denied.status, 403, '未开放时匿名直读模块数据接口被拒');
    assert.match((await denied.json()).error, /未对外开放/);
});

test('HTTP：管理员的「启用」不等于「开放」——启用后匿名仍然被拒', async t => {
    const { app, cookie } = await adminSession(t);

    // 管理员把自己首页上的微博热搜打开（enabledModules），但**不**对外开放。
    const base = await (await app.request('/api/modules/config', { cookie })).json();
    const saved = await app.request('/api/modules/config', {
        cookie,
        body: { enabledModules: ['weibo-hot'], revision: base.revision, operationId: 'admin-enables' }
    });
    assert.equal(saved.status, 200);

    assert.deepEqual((await (await anon(app, '/api/modules/public')).json()).modules, [],
        '管理员自己启用不构成开放');
    assert.equal((await anon(app, '/api/weibo-hot')).status, 403, '匿名仍然被拒');
    // 但管理员自己能用（下面单独一条也验，这里顺带确认未开放不影响自己）
    assert.equal((await app.request('/api/weibo-hot', { cookie })).status, 200);
});

test('HTTP：开放后匿名可读，撤回后立刻 403，重启仍生效', async t => {
    const { app, cookie } = await adminSession(t);
    await setOpen(app, cookie, ['weibo-hot']);

    const policy = await (await anon(app, '/api/modules/public')).json();
    assert.deepEqual(policy.modules, ['weibo-hot']);

    const first = await anon(app, '/api/weibo-hot');
    assert.equal(first.status, 200, '开放后匿名可读');
    const list = (await first.json()).list;
    assert.equal(list.length, 2);
    assert.equal(list[0].title, '榜一');
    // 服务端 href 白名单的第一道：第三方数据里的 javascript: 被清成空串
    assert.equal(list[1].url, '', 'javascript: 不进 href（服务端先滤一道）');

    // 撤回：立刻生效，不需要等任何缓存过期
    await setOpen(app, cookie, []);
    assert.equal((await anon(app, '/api/weibo-hot')).status, 403, '撤回后匿名立刻被拒');
    assert.deepEqual((await (await anon(app, '/api/modules/public')).json()).modules, []);

    // 重新开放后重启，策略与数据都还在（落盘的是真实文件）
    await setOpen(app, cookie, ['weibo-hot'], 'reopen');
    await app.stop();
    await app.start();
    assert.deepEqual((await (await anon(app, '/api/modules/public')).json()).modules, ['weibo-hot'],
        '策略是持久化的，重启不丢');
    assert.equal((await anon(app, '/api/weibo-hot')).status, 200);
});

test('HTTP：管理员可用自己尚未对外开放的公开模块', async t => {
    const { app, cookie } = await adminSession(t);
    const res = await app.request('/api/weibo-hot', { cookie }); // 一次都没开放过
    assert.equal(res.status, 200, '管理员不受「对外开放」限制');
    assert.equal((await res.json()).list.length, 2);
});

test('HTTP：私人模块提交进开放名单被丢弃，其数据接口对匿名仍是 401', async t => {
    const { app, cookie } = await adminSession(t);
    await setOpen(app, cookie, ['server-monitor', 'memo', 'weibo-hot', 'special-line']);

    const config = await (await app.request('/api/modules/config', { cookie })).json();
    assert.deepEqual(config.publicModules, ['weibo-hot'], '只有服务端白名单里的 id 落盘');
    assert.deepEqual((await (await anon(app, '/api/modules/public')).json()).modules, ['weibo-hot']);

    for (const route of ['/api/memos', '/api/timeline/events', '/api/modules/config', '/api/modules/metrics']) {
        assert.equal((await anon(app, route)).status, 401, `${route} 对匿名仍是 401`);
    }
});

test('HTTP：冷缓存下 8 个并发请求只打一趟上游（共享缓存 + 并发合并）', async t => {
    const { app, cookie, stub } = await adminSession(t);
    await setOpen(app, cookie, ['weibo-hot']);

    const responses = await Promise.all(Array.from({ length: 8 }, () => anon(app, '/api/weibo-hot')));
    for (const res of responses) {
        assert.equal(res.status, 200);
        assert.equal((await res.json()).list.length, 2);
    }
    assert.equal(stub.hits(), 1, `冷缓存下并发请求只应打一趟上游，实际 ${stub.hits()}`);
});

test('HTTP：开放不启动私人采集——匿名路径只有它自己那条数据接口', async t => {
    const { app, cookie } = await adminSession(t);
    await setOpen(app, cookie, ['weibo-hot']);
    // 匿名走一遍公开模块的两条请求
    assert.equal((await anon(app, '/api/modules/public')).status, 200);
    assert.equal((await anon(app, '/api/weibo-hot')).status, 200);
    // 其他模块仍是管理员域：普通访客不该因为公开模块而被拉进私人采集
    for (const route of ['/api/timeline/events', '/api/memos', '/api/timeline/sources']) {
        assert.equal((await anon(app, route)).status, 401, `${route} 匿名 401（未触发私人采集）`);
    }
});

// ===================== ② 客户端契约（执行真实方法体） =====================

/**
 * 按大括号配对切出**方法定义**（不是调用点）。
 *
 * 用 `\n<缩进>(static )?name(...) {` 定位：`this.enabledModuleIds()` 这类调用
 * 出现在定义之前，只按名字 `indexOf` 会切到调用点上，随后的大括号配对落在
 * 下一段无关代码里——断言于是在错误的窗口里通过（本仓库记过多次的切片坑）。
 */
function findMethod(source, name) {
    const re = new RegExp(`\\n([ \\t]*)(?:async )?(?:static )?${name}\\([^()]*\\) \\{`);
    const m = re.exec(source);
    assert.ok(m, `找到方法定义 ${name}`);
    const open = source.indexOf('{', m.index);
    assert.ok(open > m.index, `${name} 的方法体起点可定位`);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                const inner = source.slice(open + 1, i);
                assert.ok(inner.length > 40, `${name} 切片长度合理（${inner.length}）`);
                return {
                    params: m[0].slice(m[0].indexOf('(') + 1, m[0].lastIndexOf(')')),
                    // async 方法必须还原：方法体里有 await，拼成同步函数会直接
                    // SyntaxError（症状是「测试文件加载失败」而不是断言失败）。
                    async: /async\s+\w+\(/.test(m[0]),
                    inner
                };
            }
        }
    }
    throw new Error(`${name} 的方法体没有闭合`);
}

/** 把方法体拼成可执行函数；context 里的名字作为自由变量注入。 */
function buildMethod(source, name, context) {
    const { params, inner, async: isAsync } = findMethod(source, name);
    const names = Object.keys(context);
    return new Function(...names, `return ${isAsync ? 'async ' : ''}function(${params}){ ${inner} }`)(
        ...names.map(n => context[n]));
}

const KNOWN = { KNOWN_MODULES: MODULE_IDS, MODULE_CATEGORIES: ['admin', 'public'] };

test('模块声明校验：缺分类、公开模块缺配置白名单都被拒绝', () => {
    const validate = buildMethod(appSource, 'validateModuleDef', { App: KNOWN });

    assert.equal(validate({ id: 'x', category: 'admin' }), null, '合法的私人模块通过');
    assert.equal(validate({ id: 'x', category: 'public', settings: {} }), null,
        '公开模块声明空白名单也通过（它确实没有用户侧配置）');

    assert.match(validate({ id: 'x' }), /分类声明/, '缺分类 → 拒绝');
    assert.match(validate({ id: 'x', category: 'admin-only' }), /分类声明/, '非法分类 → 拒绝');
    assert.match(validate({ id: 'x', category: 'public' }), /可同步配置白名单/, '公开模块缺白名单 → 拒绝');
    assert.match(validate({ id: 'x', category: 'public', settings: { a: { default: 1 } } }), /校验规则/, '缺 validate → 拒绝');
    assert.match(validate({ id: 'x', category: 'public', settings: { a: { validate: () => 1 } } }), /校验规则/, '缺默认值 → 拒绝');
});

test('注册被拒绝时不会进注册表（声明不合法就不能被加载渲染）', () => {
    const app = { moduleDefs: new Map(), MODULE_CATEGORIES: ['admin', 'public'] };
    app.validateModuleDef = buildMethod(appSource, 'validateModuleDef', { App: app });
    const errors = [];
    const register = buildMethod(appSource, 'registerModule', { App: app, console: { error: m => errors.push(m) } });

    assert.equal(register({ id: 'weibo-hot' }), null, '缺分类 → 返回 null');
    assert.equal(app.moduleDefs.size, 0, '被拒绝的模块不进注册表');
    assert.match(errors.join('\n'), /注册被拒绝/);

    assert.ok(register({ id: 'weibo-hot', category: 'public', settings: {} }), '合法声明注册成功');
    assert.deepEqual([...app.moduleDefs.keys()], ['weibo-hot']);
});

test('enabledModuleIds：普通访客只放行声明为 public 的模块', () => {
    const fn = buildMethod(appSource, 'enabledModuleIds', { App: KNOWN });
    const defs = { 'server-monitor': { category: 'admin' }, 'weibo-hot': { category: 'public' } };
    const base = {
        getModule: id => defs[id],
        modulesConfig: { enabledModules: ['server-monitor', 'weibo-hot'], widgets: [] }
    };
    assert.deepEqual([...fn.call({ ...base, authenticated: false })], ['weibo-hot'],
        '本机或策略里混进私人模块 id 也不渲染给访客');
    assert.deepEqual([...fn.call({ ...base, authenticated: true })], ['server-monitor', 'weibo-hot'],
        '管理员不受分类限制（可以用自己尚未对外开放的公开模块）');
});

test('sanitizeModuleSettings：白名单外的键丢弃，越界与缺失回落到默认', () => {
    const fn = buildMethod(appSource, 'sanitizeModuleSettings', { App: KNOWN });
    const defs = {
        'weibo-hot': {
            category: 'public',
            settings: { pageSize: { default: 15, min: 5, max: 30, validate: v => (Number.isInteger(v) && v >= 5 && v <= 30 ? v : null) } }
        },
        'server-monitor': { category: 'admin' }
    };
    const call = settings => fn.call({ getModule: id => defs[id] }, settings);

    assert.deepEqual(call({ 'weibo-hot': { pageSize: 20, evil: 'x' } }), { 'weibo-hot': { pageSize: 20 } },
        '白名单外的键不落盘');
    assert.deepEqual(call({ 'weibo-hot': { pageSize: 999 } }), { 'weibo-hot': { pageSize: 15 } },
        '越界值回落默认');
    assert.deepEqual(call({ 'weibo-hot': {} }), { 'weibo-hot': { pageSize: 15 } }, '缺失补默认');
    assert.equal('server-monitor' in call({ 'server-monitor': { a: 1 } }), false,
        '私人模块没有用户侧配置（不因提交就被收进来）');
});

test('平台在策略/身份变化时卸载离开启用集合的模块', () => {
    const fn = buildMethod(appSource, 'teardownUnusedModules', {});
    const unmounted = [];
    const app = {
        mountedModuleIds: new Set(['weibo-hot', 'memo']),
        getModule: id => ({ unmount: () => unmounted.push(id) })
    };
    fn.call(app, ['weibo-hot']);
    assert.deepEqual(unmounted, ['memo'], '只卸下离开启用集合的那个');
    assert.deepEqual([...app.mountedModuleIds], ['weibo-hot'], '留下的仍在册');

    // ⚠️ 这三条必须**限定在各自的宿主方法里**。写成整文件 match
    // `/this\.teardownUnusedModules\(\[\]\)/` 会命中 renderModuleZone 匿名分支
    // 里的那一处（它在源码里排在 syncModuleVisibility 之前），于是删掉登出那处
    // 调用照样绿——本条原本就是这么写的，变异验证把它抓出来了。
    assert.match(findMethod(appSource, 'mountModule').inner, /this\.mountedModuleIds\.add\(id\)/,
        'mountModule 登记已挂载的模块');
    assert.match(findMethod(appSource, 'renderModuleZone').inner, /this\.teardownUnusedModules\(ids\)/,
        'renderModuleZone 按启用集合收');
    assert.match(findMethod(appSource, 'syncModuleVisibility').inner, /this\.teardownUnusedModules\(\[\]\)/,
        '同步可见性时整体收（登出）');
});

test('登出路径整体卸载已挂载的模块（执行真实 syncModuleVisibility + 真实 teardown）', async () => {
    const body = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const unmounted = [];
    const app = {
        authenticated: false,
        personalNavigationLoaded: false,
        mountedModuleIds: new Set(['weibo-hot', 'memo']),
        getModule: id => ({ unmount: () => unmounted.push(id) }),
        exitEditLayout() {},
        renderModuleZone: async () => {}
    };
    app.teardownUnusedModules = buildMethod(body, 'teardownUnusedModules', {});
    const run = buildMethod(body, 'syncModuleVisibility', {
        $: () => ({ hidden: true, replaceChildren() {} })
    });
    await run.call(app);

    assert.deepEqual([...unmounted].sort(), ['memo', 'weibo-hot'], '登出时把已挂载的模块全部卸载');
    assert.equal(app.mountedModuleIds.size, 0, '卸载后名册清空');
});

test('mountModule 登记已挂载的模块，并把该模块的用户偏好注入给它（执行真实方法）', async () => {
    const body = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const shell = { className: '', dataset: {}, children: [], classList: { add() {} }, appendChild() {} };
    let seenState = null;
    const def = {
        id: 'weibo-hot',
        mountWidget(node, state) { seenState = state; return [node]; }
    };
    const app = {
        // 偏好只对公开模块存在；注入点必须按 id 取出**该模块自己的**那一份
        modulesConfig: { settings: { 'weibo-hot': { pageSize: 5 } } },
        editLayout: false,
        mountedModuleIds: new Set(),
        getModule: id => (id === 'weibo-hot' ? def : undefined),
        loadModule: async () => {},
        requestWidgetStack: () => {}
    };
    const run = buildMethod(body, 'mountModule', {
        document: { createElement: () => shell, createDocumentFragment: () => ({ __fragment: true, appendChild() {} }) },
        API: {}
    });
    await run.call(app, 'weibo-hot', []);

    assert.deepEqual([...app.mountedModuleIds], ['weibo-hot'],
        '挂载即登记——否则卸载时平台根本不认识它');
    assert.deepEqual(seenState.settings, { pageSize: 5 }, '该模块的用户偏好经 state.settings 注入');
    assert.equal(seenState.config, app.modulesConfig, '整份模块配置仍然注入');
});

test('策略刷新失败时沿用上一次已知结果，不清成「未知」', async () => {
    // 语义是「离线时用最近一次已知结果，联网后重新确认」。清成 null 的后果不是
    // 「本次不加载」，而是**已经显示的卡片会在下一次渲染被拆掉**（窗口尺寸变化、
    // 换停靠都会触发 renderModuleZone，而它看到「未知授权」就收起模块区）——
    // 服务端此刻仍在正常放行，用户看到的是卡片莫名消失。
    const run = buildMethod(appSource, 'loadPublicModulePolicy', {
        API: { get: async () => { throw new Error('offline'); } }
    });
    const known = { authenticated: false, publicModulePolicy: ['weibo-hot'] };
    await run.call(known);
    assert.deepEqual(known.publicModulePolicy, ['weibo-hot'], '取不到时保留上一次已知策略');

    // 从未确认过时保持 null —— 那一种才是「未知授权不加载」
    const fresh = { authenticated: false, publicModulePolicy: null };
    await run.call(fresh);
    assert.equal(fresh.publicModulePolicy, null, '从未确认过时不假装知道');
});

test('renderModuleZone 按新的启用集合卸载模块（执行真实方法 + 真实 teardown）', async () => {
    // 这条补的是「撤回开放」覆盖不到的那半：管理员把自己首页上某个模块**停用**时，
    // 启用集合缩小但模块区照旧渲染（走的是 ids 那一处 teardown，不是提前返回那处）。
    // 少掉这一次调用，被停用的模块会继续按周期请求一个它已经不属于的接口。
    // 变异验证：删掉 `this.teardownUnusedModules(ids);`，本条转红。
    const body = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const node = () => ({
        hidden: true, dataset: {}, offsetHeight: 0,
        classList: { add() {}, remove() {} },
        replaceChildren() {}, appendChild() {}, querySelector: () => null
    });
    const unmounted = [];
    const defs = {
        'weibo-hot': { category: 'public', unmount: () => unmounted.push('weibo-hot') },
        memo: { category: 'admin', unmount: () => unmounted.push('memo') }
    };
    const app = {
        authenticated: false,
        moduleGeneration: 0,
        mountedModuleIds: new Set(['weibo-hot', 'memo']), // memo 已在册，但这次不在启用集合里
        modulesError: null,
        modulesConfig: { enabledModules: ['weibo-hot'], widgets: [] },
        getModule: id => defs[id],
        preparePublicModules: async () => true,
        enabledModuleIds: () => ['weibo-hot'],
        preloadModuleDefs: async () => {},
        // 让位/停靠/入场这一串不是本条的主题，给空壳；顺序另有专条执行真实实现
        syncRail: () => ({ board: 600 }),
        watchRailShift() {},
        sideDockAvailable: () => true,
        mountModule: async () => node(),
        waitFirstRound: async () => {},
        applyWidgetLayout() {},
        playModuleEntrance() {}
    };
    app.teardownUnusedModules = buildMethod(body, 'teardownUnusedModules', {});

    // 入场常量从源码解析，不写死字面量：写死的话改了真实常量这里照样绿
    // （timeline.test.js 已经为这一手吃过一次亏）。本条不校验数值，只不写死。
    const appEnter = Number(/static MODULE_ENTER_MS = (\d+)/.exec(appSource)?.[1]);
    const appStagger = Number(/static MODULE_ENTER_STAGGER_MS = (\d+)/.exec(appSource)?.[1]);
    assert.ok(Number.isFinite(appEnter) && Number.isFinite(appStagger), '两个入场常量能从源码解析');
    const run = buildMethod(body, 'renderModuleZone', {
        $: () => node(),
        document: { createElement: () => node() },
        performance: { now: () => 0 },
        App: { MODULE_ENTER_MS: appEnter, MODULE_ENTER_STAGGER_MS: appStagger }
    });
    await run.call(app);

    assert.deepEqual(unmounted, ['memo'], '离开启用集合的模块被卸载，留下的不动');
    assert.deepEqual([...app.mountedModuleIds], ['weibo-hot']);
});

/**
 * 把模块文件真跑一遍，拿到它**实际注册**的那份声明。
 *
 * 只 regex 源码里有没有 `category: 'admin'` 是不够的：把那一行挪进注释，
 * 正则照样命中，而模块在运行时会被 validateModuleDef 拒绝注册。
 */
function loadModuleDef(id) {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'modules', `${id}.js`), 'utf8');
    let registered = null;
    const sandbox = {
        window: { app: { registerModule: def => { registered = def; } } },
        document: { hidden: false, createElement: () => ({}), addEventListener() {}, removeEventListener() {} },
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        Date, Map, Set, Math, Number, Array, String, JSON, Error, Object, Promise, RegExp, Symbol, isNaN
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(src, sandbox, { filename: `${id}.js` });
    assert.ok(registered, `${id}.js 执行时调用了 registerModule`);
    assert.equal(registered.id, id, `${id}.js 注册的 id 与文件名一致`);
    return registered;
}

test('四个模块的真实声明都能通过平台校验，且只有微博热搜是公开模块', () => {
    const validate = buildMethod(appSource, 'validateModuleDef', { App: KNOWN });
    const defs = MODULE_IDS.map(loadModuleDef);

    for (const def of defs) {
        assert.equal(validate(def), null, `${def.id} 的真实声明通过 validateModuleDef（缺声明会在这里红）`);
        assert.equal(typeof def.unmount, 'function', `${def.id} 声明了 unmount（平台靠它停表）`);
    }
    assert.deepEqual(defs.map(d => d.id), MODULE_IDS, '四个模块都注册成功——声明不合法的会被 registerModule 扔掉');
    assert.deepEqual(defs.filter(d => d.category === 'public').map(d => d.id), ['weibo-hot'],
        '本轮唯一的公开模块');
    assert.deepEqual(defs.filter(d => d.category === 'admin').map(d => d.id),
        ['memo', 'server-monitor', 'special-line'], '三个私人模块声明为 admin');

    const weibo = defs.find(d => d.id === 'weibo-hot');
    assert.deepEqual(Object.keys(weibo.settings), ['pageSize'], '公开模块带可同步配置白名单');
    assert.equal(typeof weibo.settings.pageSize.validate, 'function', '白名单里每一项都有校验规则');

    // 跨文件登记关系只能靠源码断言：服务端那份白名单与客户端声明必须逐项一致。
    // 任一层单独失效都不该放行，所以两处都要有——这条就是防止只改一处的。
    const serverList = [...(/const PUBLIC_MODULE_IDS = new Set\(\[([^\]]*)\]\)/.exec(server)[1]
        .matchAll(/'([^']+)'/g))].map(m => m[1]);
    assert.deepEqual(serverList, ['weibo-hot'], '服务端白名单与客户端声明一致');
});

test('普通访客没有启用任何公开模块时不预加载脚本（首屏不为「可能用得上」付成本）', () => {
    const fn = buildMethod(appSource, 'preparePublicModules', { App: { KNOWN_MODULES: MODULE_IDS } });
    const loaded = [];
    const app = {
        publicModulePolicy: ['weibo-hot'],
        localModules: { enabled: [], widgets: [], settings: {} },
        readLocalModules: async () => app.localModules,
        preloadModuleDefs: async ids => { loaded.push(...ids); },
        modulesConfig: null,
        loadModulesConfig: async () => { throw new Error('不该走到这里'); }
    };
    return fn.call(app).then(result => {
        assert.equal(result, false, '没有启用项 → 不渲染模块区');
        assert.deepEqual(loaded, [], '一个脚本都不下载');

        // 对照：策略未知时同样不加载
        const unknown = { ...app, publicModulePolicy: null };
        return fn.call(unknown).then(r => assert.equal(r, false, '未知授权不加载'));
    });
});

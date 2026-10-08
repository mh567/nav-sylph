const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/** 去注释后再匹配，避免注释里的字符串把形状断言骗过。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

/**
 * 按大括号配对取出一个方法的完整定义（含签名行）。
 *
 * 传**完整签名**（如 `'toggleSection(sectionId) {'`）而不是方法名：
 * 调用点（`app.toggleSection('webdav')`）与定义同名，用方法名会切到模板里
 * 那次调用上去。切片两端都要 `assert.ok(length > N)` 兜住——端锚点落空时
 * slice 会静默给出一个错误范围的窗口，而断言照样能通过（本仓库踩过多次）。
 */
function methodBody(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `找到方法定义：${signature}`);
    const open = src.indexOf('{', start + signature.length - 1);
    assert.ok(open > start, `${signature} 有方法体`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`${signature} 的大括号不配对`);
}

// 登录防护是纯函数 + 注入时钟，抽出来直接测，不启动监听器。
// 注意：这里用**原始源码**定位边界——stripComments 会把行注释删掉，
// 拿注释当结束标记会得到 -1（此前踩过）。
const raw = server;
const begin = raw.indexOf('const LOGIN_FAIL_WINDOW');
const end = raw.indexOf('// 第 2 层：全站总量封顶', begin);
assert.ok(begin >= 0 && end > begin, '登录防护代码块存在');

// 抽出的片段本身不含注释，可直接执行
const LOGIN_FAIL_WINDOW = 30 * 60000;
const LOGIN_FAIL_MAX = 10;
const { checkLoginLock, notePasswordResult } = vm.runInNewContext(
    `${raw.slice(begin, end)}
     ({ checkLoginLock, notePasswordResult })`
);

// 形状断言一律基于去注释后的源码
const code = stripComments(server);

function fresh() { return new Map(); }
const T0 = 1_700_000_000_000;

function hammer(store, ip, times, now) {
    let result;
    for (let i = 0; i < times; i++) {
        result = notePasswordResult(store, ip, false, now);
    }
    return result;
}

// ========== 失败锁定 ==========

test('连续错误达阈值即锁，阈值前不锁', () => {
    const store = fresh();
    hammer(store, '1.2.3.4', LOGIN_FAIL_MAX - 1, T0);
    assert.equal(checkLoginLock(store, '1.2.3.4', T0).locked, false, '第 9 次后还不该锁');

    hammer(store, '1.2.3.4', 1, T0);
    assert.equal(checkLoginLock(store, '1.2.3.4', T0).locked, true, '第 10 次应触发锁定');
});

test('锁定期内返回可重试的剩余秒数', () => {
    const store = fresh();
    hammer(store, '1.2.3.4', LOGIN_FAIL_MAX, T0);
    const { locked, retryAfter } = checkLoginLock(store, '1.2.3.4', T0 + 60000);
    assert.equal(locked, true);
    assert.equal(retryAfter, LOGIN_FAIL_WINDOW / 1000 - 60, '剩余时间应随等待递减');
});

test('锁定期满后自动解锁，不是永久封禁', () => {
    // 一次锁定变成永久封禁是这类实现最常见的坑：用户会直接失去访问能力。
    const store = fresh();
    hammer(store, '1.2.3.4', LOGIN_FAIL_MAX, T0);
    assert.equal(checkLoginLock(store, '1.2.3.4', T0).locked, true);
    assert.equal(checkLoginLock(store, '1.2.3.4', T0 + LOGIN_FAIL_WINDOW).locked, false,
        '30 分钟后应自动解锁');
    // 清理在越过窗口后发生（恰好到期时记录仍在，但已不判为锁定）；
    // 再晚一点就该被清掉，否则内存会一直留着。
    assert.equal(checkLoginLock(store, '1.2.3.4', T0 + LOGIN_FAIL_WINDOW + 1).locked, false);
    assert.equal(store.has('1.2.3.4'), false, '过期记录应被清除，否则内存会一直增长');
});

test('锁一个 IP 不影响其他 IP', () => {
    // 这是「不误伤」的核心：没有账户体系时，锁 IP 是唯一能做到定向封锁的手段。
    const store = fresh();
    hammer(store, '9.9.9.9', LOGIN_FAIL_MAX, T0);
    assert.equal(checkLoginLock(store, '9.9.9.9', T0).locked, true);
    assert.equal(checkLoginLock(store, '8.8.8.8', T0).locked, false, '别的 IP 不该被连带锁');
});

test('密码正确即清零，不会「成功一次后连错几次」把自己锁住', () => {
    const store = fresh();
    hammer(store, '1.2.3.4', 9, T0);
    notePasswordResult(store, '1.2.3.4', true, T0);
    hammer(store, '1.2.3.4', 9, T0 + 1000);
    assert.equal(checkLoginLock(store, '1.2.3.4', T0 + 1000).locked, false,
        '成功后计数应归零，重��后还需再错满 10 次');
});

test('计数只在窗口内累加，超窗后重新开始', () => {
    const store = fresh();
    hammer(store, '1.2.3.4', 6, T0);
    // 间隔很久再错，不该接着之前的 6 次算
    hammer(store, '1.2.3.4', 6, T0 + LOGIN_FAIL_WINDOW + 1000);
    assert.equal(checkLoginLock(store, '1.2.3.4', T0 + LOGIN_FAIL_WINDOW + 1000).locked, false,
        '超窗后应从零重新计数');
});

test('未登录过的 IP 不被判定为锁定', () => {
    const store = fresh();
    assert.deepEqual(
        { ...checkLoginLock(store, '1.1.1.1', T0) },
        { locked: false, retryAfter: 0, count: 0 }
    );
});

test('被锁定的 IP 在 loginGuard 层就被挡下，不进入密码校验', () => {
    // 必须测**真实的 loginGuard**，而不是在测试里重写一遍——重写的那份
    // 与实现无关，守卫形同虚设时这里照样会绿（此前踩过）。
    const { loginGuard, loginFailMap } = vm.runInNewContext(`
        ${raw.slice(begin, end)}
        const resolveClientIp = req => req.ip;
        (() => {
            for (let i = 0; i < 10; i++) notePasswordResult(loginFailMap, '7.7.7.7', false, Date.now());
        })();
        ({ loginGuard, loginFailMap })
    `);
    const out = {};
    const res = {
        status(c) { out.code = c; return this; },
        json(b) { out.body = b; return this; },
        locals: {}
    };
    let nexted = 0;
    loginGuard({ ip: '7.7.7.7' }, res, () => { nexted++; });
    assert.equal(nexted, 0, '被锁的 IP 不应进入密码校验（否则仍在消耗 bcrypt）');
    assert.equal(out.code, 429);
    assert.equal(out.body.code, 'locked');
    assert.ok(out.body.retryAfter > 0, '须告知还需等多久');
});

test('未锁定的 IP 能通过 loginGuard', () => {
    const { loginGuard } = vm.runInNewContext(`
        ${raw.slice(begin, end)}
        const resolveClientIp = req => req.ip;
        ({ loginGuard })
    `);
    const out = {};
    const res = {
        status(c) { out.code = c; return this; },
        json(b) { out.body = b; return this; },
        locals: {}
    };
    let nexted = 0;
    loginGuard({ ip: '3.3.3.3' }, res, () => { nexted++; });
    assert.equal(nexted, 1, '未锁定的 IP 应进入密码校验');
    assert.equal(out.code, undefined, '未锁定不应设置状态码');
    assert.equal(res.locals.loginIp, '3.3.3.3', '须把 ip 传给密码校验环节用于回写结果');
});

// ========== 全站总量封顶 ==========

test('登录三层防护齐备：IP 速率 → 失败锁定 → 全站总量', () => {
    const route = code.slice(code.indexOf("app.post('/api/verify-password'"));
    assert.match(route, /rateLimit, loginGuard, globalLoginLimit,/,
        '登录入口必须依次经过三层，缺一则该层失效');
    // 顺序不能反：总量桶排在 loginGuard 之前会先触发，
    // 单 IP 锁定永远走不到，且正常用户会先吃到全局桶的代价。
    assert.ok(route.indexOf('loginGuard') < route.indexOf('globalLoginLimit'),
        '失败锁定必须排在总量封顶之前');
});

test('总量阈值必须高于单 IP 锁定阈值', () => {
    // 两者都设 10 时总量桶会先触发：连续输错 10 次拿不到「已锁定」，
    // 第 11 次只得到「稍后再试」——锁定功能形同虚设。
    // 这是实测踩过的坑（e2e 第一版就栽在这里）。
    const global = Number(code.match(/const GLOBAL_LOGIN_LIMIT = (\d+)/)[1]);
    assert.ok(global > LOGIN_FAIL_MAX,
        `总量阈值 ${global} 必须大于单 IP 锁定阈值 ${LOGIN_FAIL_MAX}，否则锁定永远走不到`);
    // 且要给正常登录留出余量
    assert.ok(global >= LOGIN_FAIL_MAX * 2, '总量阈值至少留出 2 倍余量供正常登录使用');
});

test('全站桶不按 IP 计数', () => {
    // 单账号系统里 IP 维度只带来误伤与绕过；层间也不该互相消耗配额。
    // 只截取函数体本身——若一路切到文件末尾，会匹配到别处的
    // resolveClientIp 而误判（此前踩过）。
    const g = code.slice(code.indexOf('function globalLoginLimit'));
    const body = g.slice(0, g.indexOf('\n}'));
    assert.match(body, /'global:login'/, '总量桶的 key 必须是固定字符串');
    assert.doesNotMatch(body, /resolveClientIp/, '总量桶不应按 IP 分桶');
});

test('/api/session 不再消耗登录配额', () => {
    // 它每次首屏都调；与登录共用桶会挤掉真正的登录尝试。
    assert.match(code, /app\.get\('\/api\/session', publicReadLimit,/);
    assert.doesNotMatch(code, /app\.get\('\/api\/session', rateLimit,/);
});

test('锁定与总量桶都会被清扫，不会无限增长', () => {
    const sweep = code.slice(code.indexOf('setInterval('), code.indexOf('sessionStore.sweep(now)'));
    assert.match(sweep, /sweepRateLimitStore\(loginFailMap, now, LOGIN_FAIL_WINDOW\)/,
        '失败锁定记录必须按窗口清理');
    assert.match(sweep, /sweepRateLimitStore\(globalLoginMap, now, 60000\)/);
});

test('锁定响应带 code 与 retryAfter，供客户端区分', () => {
    // 没有解锁入口时，用户必须知道「不是密码错了、而是被锁了」，
    // 否则只会反复输，把锁定越推越深。
    const g = code.slice(code.indexOf('function loginGuard'));
    assert.match(g, /status\(429\)/);
    assert.match(g, /code: 'locked'/);
    assert.match(g, /retryAfter/);
});

test('客户端区分锁定、总量封顶与密码错误三种提示', () => {
    const client = stripComments(appSource);
    const login = client.slice(client.indexOf('async openAdmin()'), client.indexOf('beginConfigEdit()'));
    assert.match(login, /code === 'locked'/, '必须单独识别锁定');
    assert.match(login, /code === 'global_limited'/, '必须识别总量封顶');
    assert.match(login, /密码错误/, '普通失败仍提示密码错误');
});

// ========== 远程备份区块的静默失败 ==========

test('WebDAV 配置加载失败必须显示原因，不能停在「加载中」', () => {
    // 修复前只在 res.ok 时渲染：任何非 200（限流 429、会话失效、网络错误）
    // 都会让「加载中...」永远留在页面上，且没有任何提示——用户只能干等。
    const c = stripComments(appSource);
    const b = c.indexOf('async loadWebDAVConfig()');
    const e = c.indexOf('renderWebDAVSection() {');
    assert.ok(b >= 0 && e > b, 'loadWebDAVConfig 应在 renderWebDAVSection 定义之前');
    const load = c.slice(b, e);
    assert.match(load, /if \(!res\.ok\)/, '非 200 必须走失败分支而不是什么都不做');
    assert.match(load, /renderWebDAVError/, '失败时要渲染错误信息');
    // 网络异常（fetch 抛错）同样不能静默：此前 catch 只写 console，
    // 页面上依旧是无声的「加载中...」。
    // 必须**只**看 catch 块：早先的断言从 catch 一直切到函数末尾，
    // 而 catch 后面紧跟着 renderWebDAVError 的定义（含同名调用），
    // 于是删掉 catch 里那一行仍然会匹配上——断言形同虚设（本次实测踩到）。
    const catchStart = load.indexOf('catch');
    assert.ok(catchStart > 0, 'loadWebDAVConfig 应有 catch 分支');
    const catchEnd = load.indexOf('\n        }', catchStart);
    assert.ok(catchEnd > catchStart, '应能定位到函数结尾');
    const catchBody = load.slice(catchStart, catchEnd);
    assert.match(catchBody, /renderWebDAVError/,
        'fetch 抛错时也必须提示，而不是只记 console');
    assert.match(c, /id="webdavRetryBtn"/, '失败后要给重试入口，不能只能刷新整页');
});

test('远程备份配置改为首次展开时加载，不再每次重渲染都预取', () => {
    // 修复前在 renderAdminPanel 末尾预取：每次保存配置、增删分类都会重渲染，
    // 于是每次都多打一次请求，累积起来撞上管理接口的限流。
    const c = stripComments(appSource);
    const panel = methodBody(c, 'renderAdminPanel() {');
    assert.ok(panel.length > 5000, 'renderAdminPanel 切片完整（含整块面板模板）');
    assert.doesNotMatch(panel, /this\.loadWebDAVConfig\(\)/,
        'renderAdminPanel 末尾不应再预取 WebDAV 配置');
});

test('远程备份区块按「是否已渲染进当前 DOM」判定，不按「配置是否已加载」', () => {
    // 本轮修的就是这一条。修复前判据是 !this.webdavConfig：面板每次重建
    // #modalBody 都会产生一个只写着「加载中...」的新 #webdavSection，而
    // webdavConfig 还在内存里——条件为假、不发请求，占位符永远留在页面上。
    // 用户报的「改完配置去同步时，展开会失败」就是它：第二次打开管理面板
    // 起必然复现，不是偶发。
    //
    // 这与 tests/api-boundary.test.js 里模块分区那条是同一个缺陷类：
    // 判据要落在「输出有没有画出来」，不是「输入在不在内存里」。
    const c = stripComments(appSource);
    const toggle = methodBody(c, 'toggleSection(sectionId) {');
    assert.ok(toggle.length > 200, 'toggleSection 方法体完整');
    assert.match(toggle, /sectionId === 'webdav' && !this\.webdavRendered/,
        '判据必须是 webdavRendered（这份配置有没有画进当前这块 DOM）');
    assert.doesNotMatch(toggle, /sectionId === 'webdav' && !this\.webdavConfig/,
        'webdavConfig 只是缓存，重建 DOM 后它照样为真——用它当条件会让区块停在「加载中...」');
});

test('面板重建 DOM 时复位 webdavRendered，登出时两样一起清', () => {
    const c = stripComments(appSource);

    // 容器是新的，标记就得跟着复位——与 modulesEditorRendered /
    // favManagerRendered 同一条纪律。
    //
    // 断言必须钉住**这三行在同一段连续语句里**，不是「方法体里出现过
    // this.webdavRendered = false」：
    // ① logout 处理器就在 renderAdminPanel 方法体之内，那里也有一行同样的复位；
    // ② 用 `[\s\S]*?` 连接三行时，懒匹配会一路跨到 logout 那一行去，
    //    于是删掉本行仍然绿（变异实测两次都是这样绿的）。
    // `[^;]*` 限定两行之间不能再有别的语句，logout 那段隔着几十行代码，
    // 无法被跨过。
    const panel = methodBody(c, 'renderAdminPanel() {');
    assert.match(panel,
        /this\.modulesEditorRendered = false;[^;]*this\.favManagerRendered = false;[^;]*this\.webdavRendered = false;/,
        'renderAdminPanel 必须复位「已渲染」闩锁（与另两个标记相邻成组），否则重建后展开不会再加载');
    assert.match(panel, /this\.modulesEditorRendered = false/);
    assert.match(panel, /this\.favManagerRendered = false/);

    // 渲染成功要置位，否则每次展开都会重复请求
    const render = methodBody(c, 'renderWebDAVSection() {');
    assert.ok(render.length > 500, 'renderWebDAVSection 方法体完整');
    assert.match(render, /this\.webdavRendered = true/);

    const logout = c.slice(c.indexOf("$('#logoutBtn').onclick"));
    assert.match(logout, /this\.webdavConfig = null/,
        '换会话后内存里不留上一个会话的配置');
    assert.match(logout, /this\.webdavRendered = false/,
        '闩锁也要清——决定「展开时要不要重新加载」的是它，只清缓存清不掉新会话的「已加载过」状态');
});

test('自动同步开关：控件存在、禁用态联动、三种状态分开说、随保存提交', () => {
    const c = stripComments(appSource);
    const render = methodBody(c, 'renderWebDAVSection() {');

    assert.match(render, /id="webdavAutoSync"/, '有自动同步勾选框');
    // 未启用 WebDAV 时置灰并实时联动——一个看着开着、其实什么也不做的开关，
    // 比没有这个开关更糟。**两个框都要绑**：只绑「启用」时，勾上自动同步后
    // 状态行仍写着「已关闭」（浏览器实测如此），读起来正像「勾了没反应」。
    assert.match(render, /enabledBox\.onchange = refreshAutoState/);
    assert.match(render, /autoBox\.onchange = refreshAutoState/,
        '自动同步自己的勾选也要刷新状态行');
    assert.match(render, /autoBox\.disabled = !enabledBox\.checked/);
    // 三种状态不能塌缩成一句：「开着但没启用」与「关着」的下一步完全不同
    assert.match(render, /自动同步：已开启/);
    assert.match(render, /自动同步：待启用/);
    assert.match(render, /自动同步：已关闭/);
    // 失败态必须渲染出来，不能只进 console
    assert.match(render, /lastAutoSyncError/, '上次自动同步失败要显示在区块里');

    const save = methodBody(c, 'saveWebDAVConfig() {');
    assert.match(save, /autoSync: \$\('#webdavAutoSync'\)\.checked/,
        '保存配置时要一并提交开关，否则勾了也存不下去');
    // 既有缺陷（本轮顺带修）：成功提示曾被 renderWebDAVSection 重建容器时抹掉，
    // 于是「保存成功」从来没显示过。顺序必须是先重渲染、再写提示。
    const renderAt = save.indexOf('this.renderWebDAVSection()');
    const freshAt = save.indexOf("const freshMsg = $('#webdavMessage')");
    assert.ok(renderAt >= 0 && freshAt > renderAt,
        '成功分支必须先重渲染、再把提示写到新元素上（反过来提示会被空元素覆盖）');
    assert.match(save, /freshMsg\.textContent = '配置已保存'/);
});

test('错误提示经过转义，不直接插入用户可见文本', () => {
    const c = stripComments(appSource);
    // 锚在**定义**上：renderWebDAVSection 在 loadWebDAVConfig 里被调用，
    // 用它当结束标记会得到一个起点晚于终点的空切片（此前踩过）。
    const b = c.indexOf('renderWebDAVError(message) {');
    const e = c.indexOf('renderWebDAVSection() {');
    assert.ok(b >= 0 && e > b, 'renderWebDAVError 定义应排在 renderWebDAVSection 之前');
    assert.match(c.slice(b, e), /\$\{this\.esc\(message\)\}/,
        '服务端返回的 error 文案可能含用户数据，必须转义后再插入');
});

// ========== 响应体只能读一次 ==========

test('恢复对话框不得在 API.request 之后再次 res.json()', () => {
    // 报错的直接原因：body stream 只能读一次。API.request 已经解析过，
    // 调用方再 res.json() 抛
    // "Failed to execute 'json' on 'Response': body stream already read"，
    // 于是恢复功能 100% 失败，与 WebDAV 服务端无关。
    const c = stripComments(appSource);
    const dialog = c.slice(c.indexOf('async showWebDAVRestoreDialog()'), c.indexOf('formatSize('));
    assert.doesNotMatch(dialog, /const\s*\{\s*res\s*\}\s*=\s*await API\.request\([^)]*\)\s*;\s*\n\s*const\s+data\s*=\s*await res\.json\(\)/,
        '不能解构出 res 后再 res.json()——body 已被 request 读走');
    assert.match(dialog, /const \{ res, data \} = await API\.request\('\/api\/webdav\/list'\)/,
        '应直接使用 request 已解析好的 data');
});

test('非 JSON 响应时用 data?. 而非 data.', () => {
    // 网关返回 HTML 502 时 data 为 null，data.error 会二次抛错把真正的错误盖掉。
    const c = stripComments(appSource);
    const dialog = c.slice(c.indexOf('async showWebDAVRestoreDialog()'), c.indexOf('formatSize('));
    assert.doesNotMatch(dialog, /msgEl\.textContent = data\.error/,
        'data 可能为 null，必须用 data?.error');
    assert.match(dialog, /data\?\.error/);
});

test('API.request 支持 binary 模式，把 body 流留给调用方', () => {
    // 导出收藏需要 res.blob()；若 request 无条件 res.json()，流已被消费，
    // 导出功能同样会坏（只是表现为 blob 为空而非明确报错）。
    const c = stripComments(appSource);
    const api = c.slice(c.indexOf('const API = {'), c.indexOf('class App {'));
    assert.match(api, /async request\(url, options, binary = false\)/, 'request 应支持 binary 开关');
    assert.match(api, /if \(binary\) return \{ res, data: null \};/,
        'binary 模式必须完全不消费 body');
    // binary 模式下不得再走 json 分支
    const guard = api.slice(api.indexOf('if (binary)'));
    const jsonAfter = guard.indexOf('res.json()');
    assert.ok(jsonAfter === -1 || guard.indexOf('return') < jsonAfter,
        'binary 分支必须先返回，不能继续解析 body');
    assert.match(c, /API\.request\('\/api\/favorites\/export', undefined, true\)/,
        '导出收藏应走 binary 模式');
});

test('全库不得残留「解构 res 后再 res.json()」的写法', () => {
    // 这一类错误在源码里看着完全正常，只有运行时才炸，必须全库扫。
    const c = stripComments(appSource);
    const bad = c.match(/const\s*\{\s*res\s*\}\s*=\s*await API\.request\([^)]*\)\s*;\s*\n\s*const\s+data\s*=\s*await res\.json\(\)/g) || [];
    assert.deepEqual(bad, [], `仍有 ${bad.length} 处二次读取 body`);
});

// ========== 窄屏管理面板布局 ==========

/** 取 admin.css 里最后一个 ≤480px 块——文件尾部同名块后写者胜。 */
function adminNarrowBlock() {
    const admin = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'admin.css'), 'utf8'));
    const at = admin.indexOf('@media (max-width: 480px)');
    assert.ok(at >= 0, 'admin.css 应有 ≤480px 块');
    let end = admin.length;
    for (const m of admin.matchAll(/@media \(max-width: 480px\)/g)) {
        if (m.index > at) { end = m.index; break; }
    }
    return admin.slice(at, end);
}

test('窄屏管理面板的调整必须写在 admin.css（它后加载且特异性更高）', () => {
    // 本项目已多次被「后写的同特异性声明静默覆盖」咬到：本次改 styles.css
    // 后实测头部仍是 118.5px——真正的决定者是 admin.css 里的
    // `.modal .fav-actions` 这类更高特异性选择器。
    const block = adminNarrowBlock();
    for (const sel of ['.modal-header', '.modal-actions', '.modal .fav-actions', '.modal .fav-manager-sidebar', '.modal .fav-manager-item']) {
        assert.ok(block.includes(sel), `≤480px 块应包含 ${sel}`);
    }
});

test('窄屏头部必须让标题与按钮同行，且不被保存状态挤下去', () => {
    // 修复前：.modal-actions 占满整行 + flex-wrap:wrap，标题只有约 35px 宽，
    // 两者放不下 390px 的可用宽度，按钮必然换行——头部实测 118.5px。
    const block = adminNarrowBlock();
    assert.match(block, /\.modal-header \{[^}]*align-items: center/, '窄屏头部应垂直居中对齐');
    assert.match(block, /\.modal-actions \{[^}]*flex-wrap: nowrap/, '按钮区不得换行');
    assert.match(block, /\.config-save-status \{ display: none/, '窄屏应隐藏保存状态，而不是让它把按钮挤下去');
});

test('窄屏收藏按钮为两列网格且满足触摸目标下限', () => {
    // 横排时每个按钮仅约 52px 宽；44px 是触摸目标下限，
    // 放在媒体查询里的条件覆盖会让它在多数机型上不成立。
    const block = adminNarrowBlock();
    assert.match(block, /\.modal \.fav-actions \{[^}]*display: grid[^}]*grid-template-columns: 1fr 1fr/s,
        '收藏按钮应为两列网格');
    assert.match(block, /\.modal \.fav-actions \.btn \{[^}]*min-height: 44px/,
        '每个按钮高度须满足 44px 触摸下限');
});

test('窄屏收藏管理器侧栏改为横向滚动，且列表条目被压紧', () => {
    // 侧栏原本在 ≤768px 占满整行并限高 176px，把列表挤出首屏。
    const block = adminNarrowBlock();
    const side = block.match(/\.modal \.fav-manager-sidebar \{[^}]*\}/);
    assert.ok(side, '应有窄屏侧栏规则');
    assert.match(side[0], /flex-direction: row/, '侧栏应改为横排');
    assert.match(side[0], /overflow-x: auto/, '分类过多时应可横向滚动');
    assert.match(block, /\.modal \.fav-manager-item \{[^}]*align-items: center/);
    // 分类标签不能横贯整行（看起来像个输入框）
    assert.match(block, /\.modal \.fav-manager-category \{[^}]*flex: 0 1 auto/);
});

test('窄屏管理器头部必须禁止换行并解除搜索框的 min-width', () => {
    // 基线是 flex-wrap:wrap + .fav-manager-search{min-width:150px}：
    // 150px 搜索框 + 67px 返回按钮放不下 336px，仍会换行，头部实测 116px。
    const block = adminNarrowBlock();
    const head = block.match(/\.modal \.fav-manager-header \{[^}]*\}/);
    assert.ok(head, '应有窄屏管理器头部规则');
    assert.match(head[0], /flex-wrap: nowrap/, '头部不得换行，否则按钮与搜索框仍会分两行');
    assert.match(block, /\.modal \.fav-manager-search \{[^}]*min-width: 0/, '须覆盖基线的 min-width:150px');
    // 搜索框字号不得降到 16px 以下：iOS Safari 会自动放大页面
    assert.match(block, /\.modal \.fav-manager-search \{[^}]*font-size: 16px/);
});

// ========== 源码形状守卫 ==========

test('锁定只统计失败，不按请求到达计数', () => {
    // 只看请求到达的话，一次成功登录也会消耗配额。
    const route = code.slice(code.indexOf("app.post('/api/verify-password'"));
    assert.match(route, /notePasswordResult\(loginFailMap, res\.locals\.loginIp, valid, Date\.now\(\)\)/,
        '密码校验结果必须回写到失败计数');
    assert.match(code, /if \(valid\) \{\s*store\.delete\(ip\)/,
        '密码正确时必须清零');
});
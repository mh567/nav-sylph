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

// ========== 源码形状守卫 ==========

test('锁定只统计失败，不按请求到达计数', () => {
    // 只看请求到达的话，一次成功登录也会消耗配额。
    const route = code.slice(code.indexOf("app.post('/api/verify-password'"));
    assert.match(route, /notePasswordResult\(loginFailMap, res\.locals\.loginIp, valid, Date\.now\(\)\)/,
        '密码校验结果必须回写到失败计数');
    assert.match(code, /if \(valid\) \{\s*store\.delete\(ip\)/,
        '密码正确时必须清零');
});
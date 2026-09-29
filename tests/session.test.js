const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GEO_DB = path.join(ROOT, 'lib', 'geo', 'ip2region_v4.xdb');

// lib/session.js 只依赖 crypto 与 ./geo/xdb，用 vm 载入以便注入可控时钟与假 IP。
const sessionSource = fs.readFileSync(path.join(ROOT, 'lib', 'session.js'), 'utf8');
const sessionModule = { exports: {} };
vm.runInNewContext(sessionSource, {
    module: sessionModule,
    require: name => {
        if (name === 'crypto') return require('crypto');
        if (name === './geo/xdb') return require(path.join(ROOT, 'lib', 'geo', 'xdb.js'));
        return require(name);
    }
});
const {
    SessionStore,
    collectFingerprint,
    fingerprintScore,
    isSameDevice,
    readCookie,
    FP_WEIGHTS,
    FP_TOTAL,
    FP_THRESHOLD,
    ENV_CHANGED_CODE
} = sessionModule.exports;

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/** 去注释后再匹配，避免注释里的字符串把形状断言骗过。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // 整行注释；`[^:'"\\]` 前瞻是为了不吃掉 URL 里的 `//`（如 https://）
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

const MAC = {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0 Safari/537.36',
    'sec-ch-ua-platform': 'macOS',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform-version': '15.1.0',
    'sec-ch-ua-arch': 'x86',
    'sec-ch-ua-bitness': '64',
    'accept-language': 'zh-CN'
};

function req(headers, token, ip) {
    const h = { ...headers };
    if (token) h.cookie = `nav_session=${token}`;
    return { headers: h, ip };
}

function makeStore(overrides = {}) {
    let now = 1_700_000_000_000;
    const store = new SessionStore({
        cookieName: 'nav_session',
        ttlTrusted: 30 * 86400000,
        ttlDefault: 24 * 3600000,
        cookieSecure: true,
        isHttps: () => true,
        getClientIp: () => '114.114.114.114',
        geoEnabled: false,
        ...overrides,
        now: () => now
    });
    return { store, setNow: v => { now = v; }, advance: ms => { now += ms; } };
}

// ========== 指纹加权 ==========

test('指纹权重表与声明的总分一致（加字段忘了改阈值会红）', () => {
    const sum = Object.values(FP_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(sum, FP_TOTAL, 'FP_WEIGHTS 之和必须等于 FP_TOTAL');
    assert.equal(FP_TOTAL, 14);
    // 阈值是一致**比例**，不是绝对分。绝对分会把无 Client Hints 的浏览器永久挡在门外。
    assert.equal(FP_THRESHOLD, 0.7);
    assert.ok(FP_THRESHOLD > 0 && FP_THRESHOLD <= 1, '阈值应落在 0~1 的比例区间');
});

test('全部信号一致时一致率为 1', () => {
    const a = collectFingerprint({ headers: MAC });
    assert.equal(fingerprintScore(a, a), 1);
    assert.equal(isSameDevice(a, a), true);
});

test('只有浏览器升级时不该把用户踢下线', () => {
    // 仅 UA 变（权重 2 / 总 14）：一致率 12/14 ≈ 0.86，仍是同一设备
    const old = collectFingerprint({ headers: MAC });
    const upgraded = collectFingerprint({ headers: { ...MAC, 'user-agent': MAC['user-agent'].replace('130.0.0.0', '131.0.0.0') } });
    assert.equal(isSameDevice(old, upgraded), true, '浏览器自动升级不应触发自动登出');
});

test('系统小版本升级应判为同一设备', () => {
    // 恰好丢 platVer(4)：10/14 ≈ 0.71，贴近阈值
    const old = collectFingerprint({ headers: MAC });
    const patched = collectFingerprint({ headers: { ...MAC, 'sec-ch-ua-platform-version': '15.2.0' } });
    assert.ok(isSameDevice(old, patched), '系统小版本升级不应触发自动登出');
});

test('换了操作系统要判为设备变化', () => {
    const old = collectFingerprint({ headers: MAC });
    const other = collectFingerprint({
        headers: {
            ...MAC,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
            'sec-ch-ua-platform': 'Windows',
            'sec-ch-ua-platform-version': '15.1.0'
        }
    });
    assert.ok(!isSameDevice(old, other), 'UA+platform+platVer 全变应判为设备变化');
    assert.ok(fingerprintScore(old, other) < FP_THRESHOLD);
});

test('阈值边界：一致率恰好等于阈值应算命中（>= 而非 >）', () => {
    // 权重 ua2 platform3 mobile2 platVer4 arch1 bits1 lang1。
    // 只让 platform(3)+mobile(2)+platVer(4)+lang(1) 可比 = 10 分，
    // 其中 platform 失配 → matched = 7 → 恰好 7/10 = 0.7。
    const same = { ua: '', platform: 'p', mobile: '?0', platVer: '1', arch: '', bits: '', lang: 'zh' };
    const boundary = { ua: '', platform: 'Q', mobile: '?0', platVer: '1', arch: '', bits: '', lang: 'zh' };

    assert.equal(fingerprintScore(same, boundary), 0.7, '构造应恰好落在阈值上');
    assert.equal(isSameDevice(same, boundary), true, '恰好等于阈值必须算命中；若实现写成 > 这里会红');

    // 再失配 1 分（platVer 4 → 失配 6/10 = 0.6），应跌破阈值
    const below = { ua: '', platform: 'p', mobile: '?0', platVer: 'Z', arch: '', bits: '', lang: 'zh' };
    assert.ok(fingerprintScore(same, below) < FP_THRESHOLD);
    assert.equal(isSameDevice(same, below), false);
});

test('缺失信号不扣分：Firefox / Safari 没有 Client Hints 也能拿 30 天', () => {
    // Firefox 不发任何 Sec-CH-* 头，只剩 UA 与语言（权重 2 + 1）。
    // 若用绝对分阈值，3 分永远达不到阈值，这类浏览器将永久拿不到 30 天。
    const firefox = collectFingerprint({
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'accept-language': 'zh-CN' }
    });
    const firefox2 = collectFingerprint({
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'accept-language': 'zh-CN' }
    });
    assert.equal(firefox.platform, '');
    assert.equal(firefox.platVer, '');
    assert.equal(fingerprintScore(firefox, firefox2), 1, '仅剩 UA+语言时一致率应为 1');
    assert.equal(isSameDevice(firefox, firefox2), true, '两个 Firefox 请求之间不应判为设备变化');
});

test('完全没有可比信号时不判为变化（无法判定 ≠ 检测到变化）', () => {
    const empty = { headers: {} };
    const a = collectFingerprint(empty);
    const b = collectFingerprint(empty);
    assert.equal(isSameDevice(a, b), true);
});

// ========== 地理位置 ==========

function geoStore(scope) {
    return makeStore({
        geoEnabled: true,
        geoScope: scope,
        geoDatabase: GEO_DB,
        getClientIp: () => currentIp
    });
}
let currentIp = '114.114.114.114';

test('同一个省内换 IP 不算环境变化', () => {
    currentIp = '114.114.114.114';
    const { store } = geoStore('province');
    const token = store.createSession(req(MAC), true);
    currentIp = '114.114.115.200';   // 同为江苏
    assert.ok(store.getSession(req(MAC, token), {}), '同省换 IP 不该登出');
});

test('跨省换出口 IP 判为环境变化并销毁会话', () => {
    currentIp = '114.114.114.114';   // 江苏
    const { store } = geoStore('province');
    const token = store.createSession(req(MAC), true);
    currentIp = '202.96.128.86';     // 广东
    const reason = {};
    assert.equal(store.getSession(req(MAC, token), reason), null, '跨省应判定为环境变化');
    assert.equal(reason.code, ENV_CHANGED_CODE, '响应体应带上 env_changed 原因码');
    assert.equal(store.sessions.has(token), false, '环境变化后会话必须被销毁');
});

test('geoScope 设为 city 时，同省不同市也算变化；仍为 province 时不算', () => {
    // 必须是**同省不同市**才能隔离 province 与 city 两种粒度。
    // 之前用的是 南京 → 上海（跨省），那种输入下两种粒度都会判为变化，
    // 等于没有验证 city 粒度本身。
    // 实测：106.11.1.1 = 广东省深圳市，221.5.1.1 = 广东省汕头市。
    currentIp = '106.11.1.1';                    // 广东深圳
    const cityStore = geoStore('city');
    const cityToken = cityStore.store.createSession(req(MAC), true);
    currentIp = '221.5.1.1';                     // 广东汕头（同省，不同市）
    const cityReason = {};
    assert.equal(cityStore.store.getSession(req(MAC, cityToken), cityReason), null,
        'city 粒度下同省不同市应判为变化');
    assert.equal(cityReason.code, ENV_CHANGED_CODE);

    // 同样这一对 IP，在 province 粒度下属于同一省，不该变化
    currentIp = '106.11.1.1';
    const provinceStore = geoStore('province');
    const provinceToken = provinceStore.store.createSession(req(MAC), true);
    currentIp = '221.5.1.1';
    assert.ok(provinceStore.store.getSession(req(MAC, provinceToken), {}),
        'province 粒度下同省不同市不该判为变化——这正是默认选省级的理由');
});

test('地理判据查不到时跳过该判据，而不是判为变化', () => {
    currentIp = '114.114.114.114';
    const { store } = geoStore('province');
    const token = store.createSession(req(MAC), true);
    currentIp = '192.168.1.37';       // 私网，查不到
    assert.ok(store.getSession(req(MAC, token), {}), '私网地址查不到地区时不该登出');
});

test('库文件缺失时地理判据被跳过', () => {
    // 用一个明确缺库的 store 走完整流程：设备一致、地理跨省，但地理算不出来，
    // 因此不能判为环境变化。此前这条测试还构造了一个从未使用的 store
    // 并以 assert.ok(store) 充数，等于没有真正验证「库缺失」这条路径。
    currentIp = '114.114.114.114';
    const missing = new SessionStore({
        cookieName: 'nav_session',
        ttlTrusted: 1e12, ttlDefault: 1e12, cookieSecure: true,
        isHttps: () => true,
        getClientIp: () => currentIp,
        geoEnabled: true, geoScope: 'province',
        geoDatabase: path.join(ROOT, 'lib', 'geo', '不存在的库.xdb')
    });
    const token = missing.createSession(req(MAC), true);
    currentIp = '202.96.128.86';        // 广东：若地理可算，这会触发登出
    assert.ok(missing.getSession(req(MAC, token), {}),
        '库缺失时地理判据应被跳过，只按设备分决策');
});

test('geoEnabled=false 时地理完全不参与判断', () => {
    currentIp = '114.114.114.114';
    const { store } = makeStore({ geoEnabled: false, getClientIp: () => currentIp });
    const token = store.createSession(req(MAC), true);
    currentIp = '8.8.8.8';
    assert.ok(store.getSession(req(MAC, token), {}), '关闭地理判据后换 IP 不影响');
});

// ========== 会话生命周期 ==========

test('令牌是 32 字节随机且互不相同', () => {
    const { store } = makeStore();
    const a = store.createSession(req(MAC), true);
    const b = store.createSession(req(MAC), true);
    assert.equal(a.length, 64, '32 字节 → 64 位十六进制');
    assert.notEqual(a, b);
});

test('会话命中即可放行', () => {
    const { store } = makeStore();
    const token = store.createSession(req(MAC), true);
    assert.ok(store.getSession(req(MAC, token), {}), '有效会话应被接受');
});

test('过期会话被拒绝并从存储中清除', () => {
    const { store, advance } = makeStore();
    const token = store.createSession(req(MAC), false);
    advance(24 * 3600000 + 1);
    assert.equal(store.getSession(req(MAC, token), {}), null);
    assert.equal(store.sessions.has(token), false, '过期会话必须被删除，不能一直留着');
});

test('可信设备 30 天、普通会话 24 小时', () => {
    const trusted = makeStore();
    const t1 = trusted.store.createSession(req(MAC), true);
    assert.equal(trusted.store.sessions.get(t1).expiresAt - 1_700_000_000_000, 30 * 86400000);

    const plain = makeStore();
    const t2 = plain.store.createSession(req(MAC), false);
    assert.equal(plain.store.sessions.get(t2).expiresAt - 1_700_000_000_000, 24 * 3600000);
});

test('可信会话在 30 天内滑动续期，普通会话不会因此被延长', () => {
    const { store, advance } = makeStore();
    const token = store.createSession(req(MAC), true);
    advance(10 * 86400000);
    const found = store.getSession(req(MAC, token), {});
    assert.ok(found, '20 天后再访问仍应有效');
    assert.equal(found.session.expiresAt, 1_700_000_000_000 + 10 * 86400000 + 30 * 86400000);
});

test('markTrusted 把会话升级为 30 天', () => {
    const { store } = makeStore();
    const token = store.createSession(req(MAC), false);
    const session = store.markTrusted(token);
    assert.equal(session.trusted, true);
    assert.equal(session.expiresAt, 1_700_000_000_000 + 30 * 86400000);
    assert.equal(store.markTrusted('不存在的令牌'), null);
});

test('destroy 之后原令牌立即失效', () => {
    const { store } = makeStore();
    const token = store.createSession(req(MAC), true);
    store.destroy(token);
    assert.equal(store.getSession(req(MAC, token), {}), null);
});

test('sweep 清掉过期会话', () => {
    const { store, advance } = makeStore();
    const token = store.createSession(req(MAC), false);
    advance(25 * 3600000);
    store.sweep(1_700_000_000_000 + 25 * 3600000);
    assert.equal(store.sessions.has(token), false);
});

// ========== Cookie ==========

function fakeRes() {
    const headers = {};
    return {
        getHeader: name => headers[name.toLowerCase()],
        setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
        cookie: () => headers['set-cookie'],
        headers
    };
}

test('Cookie 带 HttpOnly 与 SameSite=Lax', () => {
    const { store } = makeStore();
    const res = fakeRes();
    const token = store.createSession(req(MAC), true);
    store.setSessionCookie(res, { token, expiresAt: store.sessions.get(token).expiresAt }, req(MAC));
    const cookie = res.cookie().join(';');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=2592000/);
});

test('Cookie 名不带 __Host- 前缀（该前缀会拒绝无 Secure 的 Cookie）', () => {
    assert.equal(FP_WEIGHTS && require(path.join(ROOT, 'server-config', 'defaults.js')).security.sessionCookieName, 'nav_session');
});

test('https 时带 Secure，http 时不带', () => {
    // 修复前：setSessionCookie 调用 isHttps() 时没传 req，cookieSecure 为 true 时
    // 直接抛 TypeError（req 为 undefined）。此前测试全部用 cookieSecure:false，
    // `&&` 短路让这条路径从没被执行过——直到真实服务器以默认值启动才崩。
    // 这组测试必须让 isHttps 真的被调用。
    const httpsReq = { headers: { 'x-forwarded-proto': 'https' } };
    const httpReq = { headers: { 'x-forwarded-proto': 'http' } };

    const httpsRes = fakeRes();
    const httpsStore = makeStore({ cookieSecure: true, isHttps: r => r?.headers['x-forwarded-proto'] === 'https' });
    const t1 = httpsStore.store.createSession(httpsReq, true);
    httpsStore.store.setSessionCookie(httpsRes, { token: t1, expiresAt: httpsStore.store.sessions.get(t1).expiresAt }, httpsReq);
    assert.match(httpsRes.cookie().join(';'), /Secure/);

    const httpRes = fakeRes();
    const httpStore = makeStore({ cookieSecure: true, isHttps: r => r?.headers['x-forwarded-proto'] === 'https' });
    const t2 = httpStore.store.createSession(httpReq, true);
    httpStore.store.setSessionCookie(httpRes, { token: t2, expiresAt: httpStore.store.sessions.get(t2).expiresAt }, httpReq);
    assert.doesNotMatch(httpRes.cookie().join(';'), /Secure/, 'http 部署不能带 Secure，否则浏览器不落盘');
});

test('issueSession / refreshSessionCookie / clearSessionCookie 都能在 cookieSecure=true 下工作', () => {
    // 修复前：这三个入口都间接调用 isHttps()，均未传 req，登录接口直接崩。
    const httpsReq = { headers: { 'x-forwarded-proto': 'https' } };
    const store = new SessionStore({
        cookieName: 'nav_session',
        ttlTrusted: 30 * 86400000, ttlDefault: 24 * 3600000,
        cookieSecure: true,
        isHttps: r => r?.headers['x-forwarded-proto'] === 'https',
        getClientIp: () => '114.114.114.114',
        geoEnabled: false
    });
    const res = fakeRes();
    const token = store.issueSession(res, httpsReq, true);
    assert.ok(token && token.length === 64);
    assert.match(res.cookie().join(';'), /Secure/);

    const found = store.getSession(req(MAC, token, '114.114.114.114'), {});
    assert.ok(found, '刚签发的会话应可取回');
    const res2 = fakeRes();
    store.refreshSessionCookie(res2, found, httpsReq);
    assert.match(res2.cookie().join(';'), /Secure/);

    const res3 = fakeRes();
    store.clearSessionCookie(res3, httpsReq);
    assert.match(res3.cookie().join(';'), /Max-Age=0/);
    assert.match(res3.cookie().join(';'), /Secure/, '清除 Cookie 也要沿用 Secure');
});

test('同名 Cookie 不会重复下发（滑动续期 + 信任设备各写一次）', () => {
    const { store } = makeStore();
    const res = fakeRes();
    const token = store.createSession(req(MAC), false);
    store.setSessionCookie(res, { token, expiresAt: store.sessions.get(token).expiresAt }, req(MAC));
    const trusted = store.markTrusted(token);
    store.setSessionCookie(res, { token, expiresAt: trusted.expiresAt }, req(MAC));
    const all = res.cookie();
    assert.equal(all.length, 1, '同名 Cookie 只应保留一条，否则有效期需要靠猜');
    assert.match(all[0], /Max-Age=2592000/, '应保留最后一次（30 天）的那条');
});

test('清除 Cookie 用 Max-Age=0 并沿用下发时的属性', () => {
    const { store } = makeStore();
    const res = fakeRes();
    store.clearSessionCookie(res, req(MAC));
    const cookie = res.cookie().join(';');
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
    // 属性必须与下发时一致，否则浏览器视为另一个 Cookie，原会话 Cookie 留存
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Secure/);
});

test('readCookie 能从混合 Cookie 串里取出会话', () => {
    assert.equal(readCookie({ headers: { cookie: 'other=1; nav_session=abc; x=2' } }, 'nav_session'), 'abc');
    assert.equal(readCookie({ headers: { cookie: 'other=1' } }, 'nav_session'), null);
    assert.equal(readCookie({ headers: {} }, 'nav_session'), null);
});

// ========== xdb 解析器（真实库文件）==========

test('已知 IP 解析出正确的省级地区', () => {
    const { Ip2Region } = require(path.join(ROOT, 'lib', 'geo', 'xdb.js'));
    const geo = new Ip2Region();
    assert.equal(geo.ensureLoaded(GEO_DB), true, '库文件应能载入');
    assert.equal(geo.lookupRegion('114.114.114.114', 'province'), '江苏省');
    assert.equal(geo.lookupRegion('223.5.5.5', 'province'), '浙江省');
    assert.equal(geo.lookupRegion('8.8.8.8', 'province'), 'California');
});

test('市级粒度取出的是市', () => {
    const { Ip2Region } = require(path.join(ROOT, 'lib', 'geo', 'xdb.js'));
    const geo = new Ip2Region();
    geo.ensureLoaded(GEO_DB);
    assert.equal(geo.lookupRegion('114.114.114.114', 'city'), '南京市');
});

test('非法与保留地址返回 null，不抛异常', () => {
    const { Ip2Region } = require(path.join(ROOT, 'lib', 'geo', 'xdb.js'));
    const geo = new Ip2Region();
    geo.ensureLoaded(GEO_DB);
    for (const ip of ['999.1.1.1', '', '::1', '10.0.0.1', '192.168.1.1', '127.0.0.1', 'not-an-ip', '1.2.3']) {
        assert.equal(geo.lookupRegion(ip, 'province'), null, `${ip} 应返回 null`);
    }
});

test('未载入时查询返回 null 而非崩溃', () => {
    const { Ip2Region } = require(path.join(ROOT, 'lib', 'geo', 'xdb.js'));
    const geo = new Ip2Region();
    assert.equal(geo.search('114.114.114.114'), null);
});

test('损坏的库文件被拒绝，不返回错误地区', () => {
    const { Ip2Region } = require(path.join(ROOT, 'lib', 'geo', 'xdb.js'));
    const geo = new Ip2Region();
    assert.equal(geo.ensureLoaded(path.join(ROOT, 'lib', 'session.js')), false, '非 xdb 文件必须被拒绝');
    assert.equal(geo.lookupRegion('114.114.114.114', 'province'), null);
});

test('查询走的是索引查找而非线性扫描', () => {
    const { Ip2Region } = require(path.join(ROOT, 'lib', 'geo', 'xdb.js'));
    const geo = new Ip2Region();
    geo.ensureLoaded(GEO_DB);
    const started = process.hrtime.bigint();
    for (let i = 0; i < 5000; i++) geo.lookupRegion('114.114.114.114', 'province');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 250, `5000 次查询耗时 ${ms.toFixed(1)}ms，疑似线性扫描`);
});

// ========== 源码形状守卫 ==========

test('11 个特权路由 + change-password 都改用 requireAdmin 中间件', () => {
    // 修复前：11 个路由各自内联 `if (!await verifyPassword(password)) return 401`，
    // 同一个守卫复制了 11 份，改一处漏三处，且每份都跑一次 bcrypt。
    const code = stripComments(server);
    const guarded = code.match(/app\.(?:post|get)\('\/api\/[^']*',\s*rateLimit,\s*requireAdmin,/g) || [];
    assert.equal(guarded.length, 12, '11 个特权路由外加 change-password 共 12 处');
    assert.equal((code.match(/if \(!await verifyPassword\(password\)\)/g) || []).length, 0,
        '手写守卫必须全部移除');
});

test('会话命中时不跑 bcrypt', () => {
    // 修复前：每个带密码的请求都跑一次 bcrypt（实测约 55ms），
    // 会话机制的全部意义之一就是把它降到 0。
    const code = stripComments(server);
    assert.match(code, /async function requireAdmin\(req, res, next\) \{[\s\S]*?sessionStore\.getSession\([\s\S]*?return next\(\)[\s\S]*?verifyPassword/,
        'requireAdmin 必须先查会话再回退到密码');
});

test('会话相关响应带 no-store 与 Accept-CH', () => {
    // 修复前：服务端全库没有任何 Cache-Control，浏览器与中间代理可能缓存
    // 带令牌的响应；也没有 Accept-CH，高熵 Client Hints 永远不会到达。
    const code = stripComments(server);
    assert.match(code, /function setSessionHeaders\(res\) \{[\s\S]*?Cache-Control', 'no-store/);
    assert.match(code, /function setSessionHeaders\(res\) \{[\s\S]*?Accept-CH/);
});

test('登出只清 cookies 不清 cache', () => {
    // 修复前若写 Clear-Site-Data: "cache", "cookies"，
    // 会连带清掉用户刚存的配置缓存。
    const code = stripComments(server);
    assert.match(code, /Clear-Site-Data', '"cookies"'/);
    assert.doesNotMatch(code, /Clear-Site-Data',\s*'"cache/, '清 cache 会连带清掉用户刚存的配置缓存');
});

test('401 响应带上 env_changed 原因码', () => {
    // 修复前：401 只有一句「未登录或登录已过期」，客户端无法区分
    // 「从没登录过」和「刚被环境变化踢掉」，也就无法给出对应提示。
    const code = stripComments(server);
    assert.match(code, /function unauthorized\(res, reason\) \{[\s\S]*?code: reason\.code/);
});

test('客户端不再保存明文密码', () => {
    const code = stripComments(appSource);
    assert.equal((code.match(/this\.password/g) || []).length, 0, 'this.password 应完全消失');
    assert.equal((code.match(/SESSION_PWD_KEY/g) || []).length, 0, '会话密码键应完全删除');
    assert.equal((code.match(/sessionStorage/g) || []).length, 0, '明文密码不应再进任何浏览器存储');
    const headerUses = code.match(/X-Admin-Password/g) || [];
    assert.equal(headerUses.length, 1, '密码只应在登录那一次请求里出现');
});

test('会话状态用 HttpOnly Cookie，客户端用 credentials 携带', () => {
    const code = stripComments(appSource);
    assert.match(code, /credentials: 'same-origin'/);
    assert.match(code, /code !== 'env_changed'/, '客户端必须识别环境变化原因码');
});

test('环境变化提示复用底部 toast 且时长可调', () => {
    const code = stripComments(appSource);
    assert.match(code, /showToast\(message, state = 'success', duration = 3500\)/, 'showToast 需支持可选时长');
    assert.match(code, /'检测到登录环境变化，已自动退出，请重新登录', 'error', 8000/, '自动登出提示应传更长时长');
});

test('窄屏 toast 仍避让 Home 指示条', () => {
    // 既有守卫：@media (max-width: 600px) 内的 .toast 必须保留 safe-area 计算。
    // 本次新增的底部条幅直接复用 .toast，误改该规则会让提示被 iOS Home 指示条盖住。
    // （dialog-regressions.test.js 覆盖的是收藏弹窗与工具条，没有覆盖 toast 本身。）
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));
    const blocks = [...css.matchAll(/@media\s*\(max-width:\s*600px\)/g)];
    assert.ok(blocks.length > 0, '应存在窄屏媒体查询');
    const body = css.slice(blocks[0].index, blocks[0].index + 1200);
    const toast = body.match(/\.toast\s*\{[^}]*\}/);
    assert.ok(toast, '窄屏块内应有 .toast 规则');
    assert.match(toast[0], /bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/);
});

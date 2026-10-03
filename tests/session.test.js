const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

// 会话的落盘后端同样归本文件管：本文件是会话逻辑的归属测试。
const { openDatabase, MIGRATIONS } = require(path.join(ROOT, 'lib', 'db.js'));
const { createSqliteBackend } = require(path.join(ROOT, 'lib', 'session-sqlite.js'));

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

// 不传 backend → SessionStore 使用进程内内存后端；测试经 store.backend 直接读存储，
// 与生产（SQLite 后端）走同一套 6 方法接口。「存哪里」是接缝，不是断言点。
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
    assert.equal(store.backend.get(token), undefined, '环境变化后会话必须被销毁');
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
    assert.equal(store.backend.get(token), undefined, '过期会话必须被删除，不能一直留着');
});

test('可信设备 30 天、普通会话 24 小时', () => {
    const trusted = makeStore();
    const t1 = trusted.store.createSession(req(MAC), true);
    assert.equal(trusted.store.backend.get(t1).expiresAt - 1_700_000_000_000, 30 * 86400000);

    const plain = makeStore();
    const t2 = plain.store.createSession(req(MAC), false);
    assert.equal(plain.store.backend.get(t2).expiresAt - 1_700_000_000_000, 24 * 3600000);
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
    assert.equal(store.backend.get(token), undefined);
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
    store.setSessionCookie(res, { token, expiresAt: store.backend.get(token).expiresAt }, req(MAC));
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
    httpsStore.store.setSessionCookie(httpsRes, { token: t1, expiresAt: httpsStore.store.backend.get(t1).expiresAt }, httpsReq);
    assert.match(httpsRes.cookie().join(';'), /Secure/);

    const httpRes = fakeRes();
    const httpStore = makeStore({ cookieSecure: true, isHttps: r => r?.headers['x-forwarded-proto'] === 'https' });
    const t2 = httpStore.store.createSession(httpReq, true);
    httpStore.store.setSessionCookie(httpRes, { token: t2, expiresAt: httpStore.store.backend.get(t2).expiresAt }, httpReq);
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
    store.setSessionCookie(res, { token, expiresAt: store.backend.get(token).expiresAt }, req(MAC));
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
    // 回归记录：这条断言原先用 `assert.ok(ms < 250)` 卡 5000 次查询的耗时，
    // 而 node --test 会并发跑 13 个测试文件，CPU 争用能让同一个查询从
    // 几毫秒涨到 700ms —— 于是它偶发失败（实测一次 722.7ms，随后多次全量
    // 均全绿、单跑不复现）。一次 flaky 会让人开始怀疑整个套件。
    //
    // 计时测的是**机器有多快**，而这条断言的意图是「查找方式对不对」。
    // 意图可以用不依赖速度的方式表达，所以改为断言机制本身。
    //
    // 办法是包一层 Buffer 的两个读方法，数一次查询实际读了多少次：
    // 索引查找固定读 4 次——两次 readUInt32LE 读 vector index 拿
    // startPtr/endPtr，一次 readUInt16LE 读命中段的 dataLen，
    // 一次 readUInt32LE 读该段的 dataPtr。实测七个不同 IP 全部恰好 4 次，
    // 与所在区段大小无关：区段从 14 字节到 1078 字节（1 段 vs 77 段）都是 4 次。
    // 线性扫描则会一路读穿整个数据段，读次数随区段大小线性增长。
    //
    // 曾试过用「触及的最大偏移」做指标，**行不通**：索引里的 startPtr 是
    // 文件的绝对偏移，落在文件各处很正常，实测十个 IP 的占比 30%–99%，
    // 与实现方式无关。
    //
    // 而只包 readUInt32LE 同样行不通：线性扫描那版读的是 UInt16 的
    // （每段读一次长度字段），探针一次都不响，断言恒绿 ——
    // 这也是红/绿验证时才发现的，破坏落地了而测试全绿。
    const { Ip2Region } = require(path.join(ROOT, 'lib', 'geo', 'xdb.js'));
    const geo = new Ip2Region();
    geo.ensureLoaded(GEO_DB);
    assert.ok(geo.loaded, '库文件已载入');

    const buf = geo.buffer;
    // 数一次查询实际读了多少次数据。**必须同时包住 readUInt16LE 与
    // readUInt32LE**：线性扫描那版恰恰是读 UInt16 的（每个 14 字节段读一次
    // 长度字段），只包 UInt32 的话探针一次都不响，断言恒绿。
    // 这个漏法是红/绿验证时才发现的——破坏落地了、测试却全绿。
    const READ_METHODS = ['readUInt16LE', 'readUInt32LE'];
    function readCount(ip) {
        let reads = 0;
        const originals = {};
        for (const m of READ_METHODS) {
            originals[m] = buf[m];
            buf[m] = function () { reads++; return originals[m].apply(buf, arguments); };
        }
        let region;
        try {
            region = geo.lookupRegion(ip, 'province');
        } finally {
            for (const m of READ_METHODS) buf[m] = originals[m];
        }
        return { reads, region };
    }

    // 命中与未命中都要测：未命中（保留地址）会提前返回、读得更少，
    // 不能拿它当「索引查找读 4 次」的样本。
    for (const ip of ['114.114.114.114', '8.8.8.8', '223.5.5.5', '210.22.70.3', '202.96.128.86']) {
        const { reads, region } = readCount(ip);
        assert.ok(region, `${ip} 应能查到地区`);
        assert.equal(reads, 4,
            `${ip} 查询应恰好读 4 次（2 次 vector index + 1 次段长 + 1 次段指针），实际 ${reads} 次 —— `
            + `读次数随区段大小增长即为线性扫描`);
    }

    // 区段大小差两个数量级（1 段 vs 77 段），读次数却一样 ——
    // 这才是「与区段大小无关」的直接证据。
    const small = readCount('223.5.5.5');   // 单段
    const large = readCount('202.96.128.86'); // 多段
    assert.equal(small.reads, large.reads,
        '区段大小不同但读次数相同，说明查找成本与区段大小无关');

    // 保留地址必须在读任何数据之前就返回——否则一次私网 IP 查询
    // 就会真的去扫库。
    const before = readCount('192.168.1.1');
    assert.equal(before.region, null, '私网地址查不到地区');
    assert.equal(before.reads, 0, `私网地址应在读取任何数据之前返回，实际读了 ${before.reads} 次`);
});

test('setTrusted 可双向设置，并立即按新档位重算有效期', () => {
    // 取消信任不能等下次访问才生效：否则用户以为已经降级，实际还能用到 30 天。
    const { store, advance } = makeStore();
    const token = store.createSession(req(MAC), false);
    assert.equal(store.backend.get(token).trusted, false);

    const trusted = store.setTrusted(token, true);
    assert.equal(trusted.trusted, true);
    assert.equal(trusted.expiresAt, 1_700_000_000_000 + 30 * 86400000, '开启后按 30 天算');

    // 用掉一些时间后再取消，应当立刻回到「现在起 24 小时」
    advance(10 * 86400000);
    const untrusted = store.setTrusted(token, false);
    assert.equal(untrusted.trusted, false);
    assert.equal(untrusted.expiresAt, 1_700_000_000_000 + 10 * 86400000 + 24 * 3600000,
        '取消信任必须立即降回 24 小时，而不是等下次访问');
    assert.ok(store.getSession(req(MAC, token), {}), '取消信任不销毁会话，用户当前仍处于登录态');

    assert.equal(store.setTrusted('不存在的令牌', true), null);
});

test('markTrusted 仍是 setTrusted(true) 的等价入口', () => {
    const { store } = makeStore();
    const token = store.createSession(req(MAC), false);
    assert.equal(store.markTrusted(token).trusted, true);
});

test('管理端 trust-device 端点接受显式的 trusted 布尔值', () => {
    // 服务端此前只能置 true，无法取消；前端管理面板的开关需要双向。
    const code = stripComments(server);
    const route = code.slice(code.indexOf("app.post('/api/trust-device'"));
    assert.match(route, /req\.body\?\.trusted !== false/, '缺省为 true 以兼容旧客户端');
    assert.match(route, /sessionStore\.setTrusted\(token, trusted\)/, '必须用双向的 setTrusted');
    assert.equal((code.match(/sessionStore\.markTrusted\(token\)/g) || []).length, 0,
        '端点里不应再直接用单向的 markTrusted');
});

test('管理面板提供信任此设备开关，且失败时回滚显示状态', () => {
    // 开关的 checked 是「用户点完之后的意图」，不等于服务端真实状态。
    // 服务端没接受却把开关留在新位置，用户就会看到一个假的档位。
    const code = stripComments(appSource);
    assert.match(code, /id="trustDeviceToggle"/, '管理面板要有该开关');
    assert.match(code, /\$\{this\.sessionTrusted \? 'checked' : ''\}/,
        '开关初值须反映真实的会话可信状态');
    assert.match(code, /if \(ok !== wanted\) \{[\s\S]*?toggle\.checked = !wanted/,
        '服务端没接受时必须把开关拨回真实状态');
    assert.match(code, /toggle\.disabled = true/, '等待期间须锁住，避免连点发出矛盾请求');
});

test('登录与登出都会同步 sessionTrusted', () => {
    // 状态不同步的后果：换一个会话后，面板仍显示上一段的「已信任」。
    const code = stripComments(appSource);
    const login = code.slice(code.indexOf('async openAdmin()'), code.indexOf('beginConfigEdit()'));
    // 必须在认证成功后立刻清掉旧值，且要在勾选分支之前
    const reset = login.indexOf('this.sessionTrusted = false;');
    assert.ok(reset > login.indexOf('this.authenticated = true;'),
        '重新登录后旧的可信状态不再作数');
    assert.ok(reset < login.indexOf('await this.trustDevice()'),
        '须先复位，再按本次勾选结果写入，否则残留的旧值会覆盖本次选择');
    assert.match(login, /this\.sessionTrusted = await this\.trustDevice\(\)/,
        '勾选时应写入服务端返回的真实结果，而不是假定成功');
    const logout = code.slice(code.indexOf("$('#logoutBtn').onclick"));
    assert.match(logout, /this\.sessionTrusted = false/, '登出后必须清空');
});

// ========== 源码形状守卫 ==========

test('21 个特权路由 + change-password 都改用 requireAdmin 中间件', () => {
    // 修复前：11 个路由各自内联 `if (!await verifyPassword(password)) return 401`，
    // 同一个守卫复制了 11 份，改一处漏三处，且每份都跑一次 bcrypt。
    const code = stripComments(server);
    // 推送端点是**故意**没有 requireAdmin 的：agent 在内网、是裸 HTTP，
    // 拿不到浏览器会话，它的鉴权是推送凭据（tests/api-boundary.test.js 有对应用例）。
    // 把它算进「特权路由」会让这条断言要么被迫放水、要么逼迫加上那个会让
    // 推送彻底失效的守卫——所以先把它摘出去，再数剩下的。
    //
    // 摘除的边界锚在**下一个 app.* 路由**上，而不是按分号切：处理函数体内
    // 到处是分号（每个 if/for 都有），按 `[^;]*?` 切会在中途停下，
    // 摘不干净就变成一条恒绿的断言。
    const pushStart = code.indexOf("app.post('/api/modules/agent-push'");
    assert.ok(pushStart > 0, '推送端点存在于源码中（找不到则本条断言的摘除逻辑已失效）');
    const afterPush = code.indexOf('\napp.', pushStart);
    const withoutPush = code.slice(0, pushStart) + code.slice(afterPush > pushStart ? afterPush : pushStart);
    assert.ok(withoutPush.length > 0 && withoutPush.length < code.length, '推送端点被摘出');
    const guarded = withoutPush.match(/app\.(?:post|get|delete)\('\/api\/[^']*',\s*(?:rateLimit,\s*)?requireAdmin,/g) || [];
    // 11 特权路由 + change-password + trust-device + 模块平台 8 条 = 21
    assert.equal(guarded.length, 21, '特权路由 + change-password + trust-device + 模块 8 条共 21 处');
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

test('登出不再发 Clear-Site-Data', () => {
    // 修复前发的是 Clear-Site-Data: "cookies"，想的是「只清 cookies 不清 cache」。
    // 但该头作用于整个源（Chrome 还覆盖可注册域），而 /api/logout 无需凭据即可调用，
    // 一个跨站表单 POST 就能把受害者该站所有 Cookie 清空——反复登出的死循环。
    // 显式清掉会话 Cookie 已经足够，不应再依赖这个头。
    const code = stripComments(server);
    assert.doesNotMatch(code, /Clear-Site-Data/, 'Clear-Site-Data 可被跨站触发清空整站 Cookie');
    assert.match(code, /app\.post\('\/api\/logout', rateLimit,/, '登出端点必须限流');
    assert.match(code, /app\.post\('\/api\/logout', rateLimit,[\s\S]*?sessionStore\.getSession/,
        '登出必须要求一个真实会话，不能是任意调用即可清 Cookie 的端点');
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

test('重新登录后必须复位 envChangeNotified', () => {
    // 修复前：envChangeNotified 一旦置真，只有显式点「退出登录」才会复位。
    // 于是「环境变化 → 看到提示 → 重新登录 → 再次环境变化」这条极常见的路径上，
    // 第二次登出**完全没有提示**，用户只看到自己被踢出去却没有任何说明。
    const code = stripComments(appSource);
    const login = code.slice(code.indexOf('async openAdmin()'), code.indexOf('beginConfigEdit()'));
    assert.match(login, /API\.envChangeNotified = false;/,
        '重新登录成功后必须复位，否则本轮再次环境变化不会提示');
    // 复位必须发生在 authenticated = true 之后，否则旧会话的迟到响应会再置真
    assert.ok(login.indexOf('API.envChangeNotified = false;') > login.indexOf('this.authenticated = true;'),
        '复位应在确认登录成功之后');
});

test('服务端兜住未处理的 Promise 拒绝', () => {
    // 纵深防御：Express 4 不捕获 async 处理函数抛出的异常，
    // 任何解析路径出错都会变成 unhandledRejection 终止进程。
    // readCookie 已有 try/catch，这里是第二道防线。
    const code = stripComments(server);
    assert.match(code, /process\.on\('unhandledRejection'/, '必须兜住未处理的 Promise 拒绝');
});

test('会话状态用 HttpOnly Cookie，客户端用 credentials 携带', () => {
    // 修复前只从响应体读 code:'env_changed'，而两处软门必须返回 200，
    // 那里带不出原因码——于是环境变化后客户端对着被截断的公开列表建索引，
    // 私密检索报「无匹配」且不自愈。软门改用 X-Session-Env-Changed 头。
    const code = stripComments(appSource);
    assert.match(code, /credentials: 'same-origin'/);
    assert.match(code, /code === 'env_changed'/, '客户端必须识别 401 响应体里的原因码');
    assert.match(code, /X-Session-Env-Changed'\) === 'env_changed'/, '必须识别软门响应头里的原因码');
});

test('两处软门与环境变化响应都带 X-Session-Env-Changed', () => {
    // 修复前 hasAdminAccess 丢掉了 reason，两条软门在环境变化后静默返回
    // 公开子集，客户端无从判断自己已被登出。
    const code = stripComments(server);
    assert.match(code, /function noteEnvChanged\(res, reason\)/, '需要统一标注环境变化的辅助函数');
    assert.match(code, /ENV_CHANGED_HEADER = 'X-Session-Env-Changed'/);
    const gates = code.match(/noteEnvChanged\(res, access\.reason\)/g) || [];
    assert.equal(gates.length, 2, '/api/config 与 /api/favorites 两处软门都要标注');
    assert.match(code, /app\.get\('\/api\/session', (?:rateLimit|publicReadLimit),[\s\S]*?noteEnvChanged\(res, reason\)/,
        '/api/session 必须透出 env_changed——它是页面加载时客户端唯一发的请求');
});

test('改密码必须重新验证当前密码，并终止全部会话', () => {
    // 修复前：改密码只凭会话即可，密码泄露后的补救动作完全失效——
    // 攻击者能改掉密码让受害者也登不进去，且已窃取的令牌继续可用。
    // OWASP Authentication Cheat Sheet 要求凭据变更前重新认证。
    const code = stripComments(server);
    const route = code.slice(code.indexOf("app.post('/api/change-password'"));
    assert.match(route, /currentPassword/, '必须接收当前密码');
    assert.match(route, /verifyPassword\(provided\)/, '必须校验当前密码');
    assert.match(route, /sessionStore\.destroyAll\(\)/, '改密码后必须终止全部会话');
});

test('会话总数有上限，超限拒绝而非驱逐', () => {
    const code = stripComments(server);
    assert.match(code, /登录会话过多/, '会话满时应明确报错');
    const { MAX_SESSIONS } = require(path.join(ROOT, 'lib', 'session.js'));
    assert.equal(MAX_SESSIONS, 1000);
});

test('会话存储由 init() 内打开的 SQLite 库承载', () => {
    // 落盘的顺序是有约束的：迁移必须先于 createSqliteBackend 的 prepare，否则表还不存在。
    // 若有人把构造挪回模块顶层，这条会红。
    const code = stripComments(server);
    const open = code.indexOf('openDatabase(config.paths.database)');
    const create = code.indexOf('backend: createSqliteBackend(db)');
    assert.ok(open > -1, 'init() 必须打开 SQLite 库');
    assert.ok(create > open, '必须先开库跑完迁移，再构造 SessionStore');
    assert.match(code, /let sessionStore;/, 'sessionStore 由 init() 赋值，不能再是模块顶层 const');
    assert.doesNotMatch(code, /const sessionStore = new SessionStore/, '不应回到模块顶层构造');

    // 退出路径要关库：关库会把 WAL 合并回主文件，升级/备份因此只需处理一个 .db
    const closes = code.match(/db\.close\(\)/g) || [];
    assert.ok(closes.length >= 2, '正常关闭与 init() 失败两条路径都要关库');
});

test('匿名可读接口有独立限流，防止 bcrypt 放大', () => {
    // 修复前 /api/config 与 /api/favorites 无任何限流，而它们在无会话时
    // 每次都跑一次 bcrypt：伪造 X-Admin-Password 可把单请求从约 7ms
    // 抬到 63ms（约 9 倍 CPU）且无需认证。
    const code = stripComments(server);
    assert.match(code, /function publicReadLimit\(req, res, next\)/);
    assert.match(code, /app\.get\('\/api\/config', publicReadLimit,/, '/api/config 需独立限流');
    assert.match(code, /app\.get\('\/api\/favorites', publicReadLimit,/, '/api/favorites 需独立限流');
    // 必须是独立桶：与登录共用会把防爆破预算耗光
    assert.match(code, /publicReadLimitMap = new Map\(\)/);
});

test('畸形百分号编码的 Cookie 不会让进程崩溃', () => {
    // 修复前 readCookie 直接 decodeURIComponent，Cookie: nav_session=%
    // 抛 URIError；调用栈都在 async 处理函数里、Express 4 不捕获，
    // 于是 unhandledRejection 终止进程——一个未认证请求即可打挂服务。
    const { readCookie } = sessionModule.exports;
    for (const bad of ['nav_session=%', 'nav_session=%E4%', 'nav_session=%zz', 'nav_session=%C0']) {
        assert.equal(readCookie({ headers: { cookie: bad } }, 'nav_session'), null,
            `${bad} 应被安全拒绝而不是抛出`);
    }
    assert.equal(readCookie({ headers: { cookie: 'nav_session=abc' } }, 'nav_session'), 'abc',
        '正常值仍应照常解析');
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

// ========== SQLite 后端（会话落盘）==========
//
// 本次改动的核心目的：登录态不再随进程重启/升级丢失。以下用例把「存哪里」这条接缝
// 铺开验证——语义必须与内存后端一致，且写入要真正落到库里（关库重开仍在）。

function tempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-sqlite-'));
    return { dir, file: path.join(dir, 'nav-sylph.db') };
}

function makeSqliteStore(file, overrides = {}) {
    let now = 1_700_000_000_000;
    const db = openDatabase(file);
    const store = new SessionStore({
        cookieName: 'nav_session',
        ttlTrusted: 30 * 86400000,
        ttlDefault: 24 * 3600000,
        cookieSecure: false,
        isHttps: () => false,
        getClientIp: () => '114.114.114.114',
        geoEnabled: false,
        backend: createSqliteBackend(db),
        ...overrides,
        now: () => now
    });
    return { db, store, advance: ms => { now += ms; } };
}

function withTempDb(fn) {
    const { dir, file } = tempDbPath();
    try {
        return fn(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('SQLite 后端：写入的会话可读回，字段语义与内存后端一致', () => {
    withTempDb(file => {
        const { db, store } = makeSqliteStore(file);
        try {
            const token = store.createSession(req(MAC), true);
            const rec = store.backend.get(token);
            assert.equal(rec.trusted, true);
            // 用序列化比较，避免 vm 载入的 collectFingerprint 与库中读回的对象
            // 分属不同 realm、原型不同而让 deepStrictEqual 误报。
            assert.equal(JSON.stringify(rec.fp), JSON.stringify(collectFingerprint({ headers: MAC })),
                '指纹要原样存取');
            assert.equal(rec.expiresAt, 1_700_000_000_000 + 30 * 86400000);

            const found = store.getSession(req(MAC, token), {});
            assert.ok(found, '同一请求应命中会话');
            assert.equal(found.session.trusted, true);
        } finally {
            db.close();
        }
    });
});

test('重启后登录态仍在：关库再开，原令牌依然有效', () => {
    // 修复前会话只在进程内 Map 里，sylph.sh update 重启进程后所有人被登出。
    withTempDb(file => {
        const first = makeSqliteStore(file);
        const token = first.store.createSession(req(MAC), true);
        first.db.close();

        const second = makeSqliteStore(file);
        try {
            const found = second.store.getSession(req(MAC, token), {});
            assert.ok(found, '关库重开后同一令牌必须仍然有效');
            assert.equal(found.session.trusted, true);
            assert.equal(second.store.getSession(req(MAC, 'f'.repeat(64)), {}), null,
                '伪造令牌不应命中');
        } finally {
            second.db.close();
        }
    });
});

test('SQLite 后端：过期会话被拒绝并从库中删除', () => {
    withTempDb(file => {
        const { db, store, advance } = makeSqliteStore(file);
        try {
            const token = store.createSession(req(MAC), false);
            assert.ok(store.backend.get(token), '前置：会话应先真正写入库，否则下面的删除断言会空转');
            advance(24 * 3600000 + 1);
            assert.equal(store.getSession(req(MAC, token), {}), null);
            assert.equal(store.backend.get(token), undefined, '过期会话必须从库中删除');
        } finally {
            db.close();
        }
    });
});

test('SQLite 后端：sweep 只清过期行，不动仍在有效期内的会话', () => {
    withTempDb(file => {
        const { db, store, advance } = makeSqliteStore(file);
        try {
            const expired = store.createSession(req(MAC), false);
            advance(25 * 3600000);
            const alive = store.createSession(req(MAC), true);
            store.sweep(1_700_000_000_000 + 25 * 3600000);
            assert.equal(store.backend.get(expired), undefined);
            assert.ok(store.backend.get(alive), '未过期的会话不能被误删');
        } finally {
            db.close();
        }
    });
});

test('SQLite 后端：setTrusted 写回库，并立即按新档位重算有效期', () => {
    withTempDb(file => {
        const { db, store, advance } = makeSqliteStore(file);
        try {
            const token = store.createSession(req(MAC), false);
            store.setTrusted(token, true);
            assert.equal(store.backend.get(token).trusted, true, '可信状态必须落盘');

            advance(10 * 86400000);
            store.setTrusted(token, false);
            assert.equal(store.backend.get(token).expiresAt,
                1_700_000_000_000 + 10 * 86400000 + 24 * 3600000,
                '取消信任必须立刻降回 24 小时并写回库');
        } finally {
            db.close();
        }
    });
});

test('SQLite 后端：destroy / destroyAll 真正删除行', () => {
    withTempDb(file => {
        const { db, store } = makeSqliteStore(file);
        try {
            const a = store.createSession(req(MAC), true);
            const b = store.createSession(req(MAC), true);
            store.destroy(a);
            assert.equal(store.backend.get(a), undefined);
            assert.ok(store.backend.get(b), 'destroy 只删指定令牌');

            assert.equal(store.destroyAll(), 1, 'destroyAll 必须返回被删除的行数');
            assert.equal(store.backend.count(), 0);
        } finally {
            db.close();
        }
    });
});

test('SQLite 后端：环境变化销毁会话也穿透到库', () => {
    // 走地理判据触发 env_changed，确认删除动作发生在库里，而非只改内存对象。
    withTempDb(file => {
        let ip = '106.11.1.1';        // 广东深圳
        const db = openDatabase(file);
        try {
            const store = new SessionStore({
                cookieName: 'nav_session',
                ttlTrusted: 1e12, ttlDefault: 1e12, cookieSecure: false,
                isHttps: () => false,
                getClientIp: () => ip,
                geoEnabled: true, geoScope: 'city', geoDatabase: GEO_DB,
                backend: createSqliteBackend(db)
            });
            const token = store.createSession(req(MAC), true);
            ip = '221.5.1.1';         // 广东汕头（同省不同市）
            const reason = {};
            assert.equal(store.getSession(req(MAC, token), reason), null);
            assert.equal(reason.code, ENV_CHANGED_CODE);
            assert.equal(store.backend.get(token), undefined, '环境变化必须在库中删除该行');
        } finally {
            db.close();
        }
    });
});

test('SQLite 后端：会话达上限时拒绝新登录，且不驱逐既有会话', () => {
    withTempDb(file => {
        const db = openDatabase(file);
        try {
            const store = new SessionStore({
                cookieName: 'nav_session',
                ttlTrusted: 1e12, ttlDefault: 1e12, cookieSecure: false,
                isHttps: () => false,
                getClientIp: () => '114.114.114.114',
                geoEnabled: false,
                backend: createSqliteBackend(db)
            });
            const insert = db.prepare(
                `INSERT INTO sessions (token, trusted, expires_at, fp, region) VALUES (?, 1, 9e15, '{}', NULL)`
            );
            db.transaction(() => {
                for (let i = 0; i < 1000; i++) insert.run('t' + i);
            })();

            assert.equal(store.createSession(req(MAC), true), null, '满额必须拒绝而非驱逐');
            assert.equal(store.backend.count(), 1000, '不能悄悄删掉他人仍在有效期内的会话');
        } finally {
            db.close();
        }
    });
});

test('库文件权限收紧到 0600（含令牌，不可世界可读）', () => {
    withTempDb(file => {
        const db = openDatabase(file);
        try {
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        } finally {
            db.close();
        }
    });
});

test('迁移幂等：重复打开不会重复建表，user_version 稳定在 MIGRATIONS.length', () => {
    // 断言写成 MIGRATIONS.length 而非硬编码数字：每次在 lib/db.js 尾部追加
    // 台阶都会让硬编码值过期，而这类过期曾以「测试失败」的形式出现，
    // 容易被误当成实现坏了而改断言。台阶数由代码自己回答。
    withTempDb(file => {
        const first = openDatabase(file);
        const v1 = first.pragma('user_version', { simple: true });
        first.close();

        const second = openDatabase(file);   // 表已存在，不应抛错
        try {
            assert.equal(v1, MIGRATIONS.length, `首次打开应升到 ${MIGRATIONS.length}`);
            assert.equal(second.pragma('user_version', { simple: true }), MIGRATIONS.length,
                '重复打开不再推进');
            const tables = second
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .all().map(row => row.name);
            assert.ok(tables.includes('sessions'), '会话表在');
            assert.ok(tables.includes('module_cache'), '模块缓存表在');
        } finally {
            second.close();
        }
    });
});

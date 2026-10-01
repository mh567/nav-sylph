'use strict';

/**
 * 管理端会话：设备指纹、地理位置绑定、可信设备判定与 Cookie 读写。
 *
 * 设计依据 OWASP Session Management Cheat Sheet「Binding the Session ID to Other
 * User Properties」：把会话绑定到一组客户端属性，中途变化时告警/终止。
 * OWASP 同时明确这些属性可被伪造（可改 UA、可与受害者共用 NAT 出口），
 * 因此**指纹只用于降权，绝不用于提权**；真正的护栏是 256 位 CSPRNG 令牌本身。
 */

const crypto = require('crypto');
const { Ip2Region } = require('./geo/xdb');

/**
 * 设备信号权重。权重只用于给字段排序，**不构成总分**：
 * 判定式是「一致权重 / 可比权重」，不存在绝对分母。
 * FP_TOTAL 仅供自洽性断言（权重之和），不要拿它当阈值分母。
 */
const FP_WEIGHTS = {
    ua: 2,
    platform: 3,
    mobile: 2,
    platVer: 4,
    arch: 1,
    bits: 1,
    lang: 1
};
const FP_TOTAL = 14;
/**
 * 判为「同一设备」所需的**一致比例**。
 *
 * 用比例而非绝对分是关键：Firefox 与 Safari 完全不实现 UA Client Hints，
 * 可比较的只剩 UA(2) + 语言(1) = 3 分。若用绝对阈值 10，这类浏览器
 * 无论是否同一台设备都永远不达标，也就永远拿不到 30 天——这是「缺失不扣分」
 * 单独解决不了的：它避免了扣分，但没解决基准本身偏高。
 */
const FP_THRESHOLD = 0.7;

/** Client Hints 中本项目会索取的高熵头。 */
const ACCEPT_CH = 'Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness';

/** 进程内会话总数上限。超限时拒绝新登录，而不是驱逐既有会话。 */
const MAX_SESSIONS = 1000;

const ENV_CHANGED_CODE = 'env_changed';
const ENV_CHANGED_MESSAGE = '检测到登录环境变化，已自动退出，请重新登录';

function collectFingerprint(req) {
    const h = req.headers || {};
    return {
        ua: h['user-agent'] || '',
        platform: h['sec-ch-ua-platform'] || '',
        mobile: h['sec-ch-ua-mobile'] || '',
        platVer: h['sec-ch-ua-platform-version'] || '',
        arch: h['sec-ch-ua-arch'] || '',
        bits: h['sec-ch-ua-bitness'] || '',
        lang: h['accept-language'] || ''
    };
}

/**
 * 逐字段加权比对，返回**一致比例**（0~1）。
 *
 * 只统计「双方都提供了该字段」的那些字段：缺失即跳过，既不加分也不扣分。
 * 一个可比较字段都没有时返回 1（无法判定 → 不判为变化），宁可放行也不
 * 因为缺信号把正常用户踢下线。
 */
function fingerprintScore(a, b) {
    let matched = 0;
    let comparable = 0;
    for (const key of Object.keys(FP_WEIGHTS)) {
        if (!a[key] || !b[key]) continue;
        comparable += FP_WEIGHTS[key];
        if (a[key] === b[key]) matched += FP_WEIGHTS[key];
    }
    if (comparable === 0) return 1;
    return matched / comparable;
}

function isSameDevice(a, b) {
    return fingerprintScore(a, b) >= FP_THRESHOLD;
}

/**
 * 默认后端：进程内 Map，语义与原实现逐一对应——重启即失效。
 *
 * 它定义了 SessionStore 依赖的 6 个方法，SQLite 后端（`lib/session-sqlite.js`）
 * 实现同一接口。于是「会话存哪里」是一个可替换的接缝，而不是散落在会话逻辑里的分支。
 */
function createMemoryBackend() {
    const map = new Map();
    return {
        get: token => map.get(token),
        set: (token, session) => { map.set(token, session); },
        delete: token => { map.delete(token); },
        deleteAll: () => { const n = map.size; map.clear(); return n; },
        sweep: now => {
            for (const [token, session] of map) {
                if (session.expiresAt <= now) map.delete(token);
            }
        },
        count: () => map.size
    };
}

class SessionStore {
    /**
     * @param {object} options
     * @param {string} options.cookieName
     * @param {number} options.ttlTrusted  可信设备有效期（毫秒）
     * @param {number} options.ttlDefault  普通会话有效期（毫秒）
     * @param {boolean} options.cookieSecure
     * @param {() => boolean} options.isHttps
     * @param {() => string} options.getClientIp
     * @param {() => number} [options.now]
     * @param {object} [options.backend] 会话存储后端；缺省为进程内内存（重启即失效）
     */
    constructor(options) {
        this.cookieName = options.cookieName;
        this.ttlTrusted = options.ttlTrusted;
        this.ttlDefault = options.ttlDefault;
        this.cookieSecure = options.cookieSecure;
        this.isHttps = options.isHttps || (() => false);
        this.getClientIp = options.getClientIp || (() => 'unknown');
        this.now = options.now || (() => Date.now());
        this.geoEnabled = options.geoEnabled !== false;
        this.geoScope = options.geoScope || 'province';
        this.geoDatabase = options.geoDatabase || '';
        this.geo = new Ip2Region();
        // 生产环境由 server.js 注入 SQLite 后端，使登录态在重启/升级后仍在；
        // 缺省内存后端保持原有语义，测试与既有调用方无需改动。
        this.backend = options.backend || createMemoryBackend();
    }

    ttlFor(trusted) {
        return trusted ? this.ttlTrusted : this.ttlDefault;
    }

    /**
     * 会话总量上限。sweep 只清过期的，而每次成功登录都会新增一条，
     * 30/分钟的登录速率意味着单个 IP 一天能堆出数万条 Map 记录。
     * 超限时**明确报错**而不是驱逐最旧的会话——驱逐会静默踢掉别人
     * 仍在有效期内的登录，且不留任何痕迹。
     * @returns {string|null} 令牌；超限或出错时返回 null
     */
    createSession(req, trusted) {
        if (this.backend.count() >= MAX_SESSIONS) {
            // 先试一次清理：多数情况下只是有陈旧记录堆积
            this.sweep(this.now());
            if (this.backend.count() >= MAX_SESSIONS) return null;
        }
        const token = crypto.randomBytes(32).toString('hex');
        const now = this.now();
        this.backend.set(token, {
            trusted: !!trusted,
            expiresAt: now + this.ttlFor(!!trusted),
            fp: collectFingerprint(req),
            region: this.lookupRegion(req)
        });
        return token;
    }

    /**
     * 取当前请求对应的会话。
     * 返回 null 表示没有有效会话；此时若原会话是因环境变化被销毁，
     * reason 会带上 ENV_CHANGED_CODE，供路由层放进 401 响应体。
     */
    getSession(req, reason) {
        const token = readCookie(req, this.cookieName);
        if (!token) return null;
        const session = this.backend.get(token);
        if (!session) return null;

        if (session.expiresAt <= this.now()) {
            this.backend.delete(token);
            return null;
        }

        const deviceOk = isSameDevice(session.fp, collectFingerprint(req));
        const region = this.lookupRegion(req);
        // 地理查不到（库缺失/IPv6/私网）时跳过该判据，而不是判为变化
        const regionOk = region === null || session.region === null || region === session.region;

        if (!deviceOk || !regionOk) {
            this.backend.delete(token);
            if (reason) reason.code = ENV_CHANGED_CODE;
            return null;
        }

        // 滑动续期：只在令牌被真正使用时延长，闲置令牌照常过期。
        // 显式写回后端——内存后端下这是同一对象，落盘后端下这一步才是持久化。
        session.expiresAt = this.now() + this.ttlFor(session.trusted);
        this.backend.set(token, session);
        return { token, session };
    }

    /**
     * 设置当前会话的可信状态。
     * trusted=true  → 30 天滑动续期；false → 降回 24 小时。
     * 取消信任**不销毁会话**：用户当前仍处于登录态，只是有效期回到 24 小时。
     * @param {string} token
     * @param {boolean} trusted
     * @returns {object|null} 会话；令牌不存在时返回 null
     */
    setTrusted(token, trusted) {
        const session = this.backend.get(token);
        if (!session) return null;
        session.trusted = !!trusted;
        // 立即按新的档位重算到期时间：取消信任不能等下次访问才生效，
        // 否则用户以为已经降级，实际还能用到 30 天。
        session.expiresAt = this.now() + this.ttlFor(session.trusted);
        this.backend.set(token, session);
        return session;
    }

    markTrusted(token) {
        return this.setTrusted(token, true);
    }

    destroy(token) {
        if (token) this.backend.delete(token);
    }

    /**
     * 销毁全部会话。改密码后必须调用：密码是唯一的根凭据，
     * 换密码若不终止既有会话，已泄露的令牌仍能继续用——
     * 补密码这个补救动作就失去意义了（OWASP：凭据变更后应终止会话）。
     */
    destroyAll() {
        return this.backend.deleteAll();
    }

    sweep(now) {
        this.backend.sweep(now);
    }

    lookupRegion(req) {
        if (!this.geoEnabled || this.geoScope === 'off') return null;
        if (!this.geoDatabase) return null;
        this.geo.ensureLoaded(this.geoDatabase);
        if (!this.geo.loaded) return null;
        return this.geo.lookupRegion(this.getClientIp(req), this.geoScope);
    }

    /**
     * 下滑动续期后重新下发 Cookie。
     * 传入 getSession 的返回值或 { token, ...session }；
     * 令牌由调用方组装会散落到四处，故这里只认一个「带 token 的对象」形状。
     */
    setSessionCookie(res, session, req) {
        const expiresAt = session.expiresAt;
        const maxAge = Math.max(0, Math.floor((expiresAt - this.now()) / 1000));
        appendCookieHeader(res, this.cookieName, session.token, {
            maxAge,
            httpOnly: true,
            sameSite: 'Lax',
            path: '/',
            // req 必须传进来：isHttps 读的是请求头，缺参会直接抛 TypeError。
            // 这条路径只有 cookieSecure 为 true 时才会走到——短路会掩盖缺参。
            secure: this.cookieSecure && this.isHttps(req)
        });
    }

    /** 登录 / 信任设备时下发 Cookie。超限时返回 null（会话已满）。 */
    issueSession(res, req, trusted) {
        const token = this.createSession(req, trusted);
        if (!token) return null;
        this.setSessionCookie(res, { token, expiresAt: this.backend.get(token).expiresAt }, req);
        return token;
    }

    /**
     * 把当前会话重新下发 Cookie。登录/信任设备后统一走这里，
     * 避免调用方自己拼 { token, ...session }。
     */
    refreshSessionCookie(res, found, req) {
        this.setSessionCookie(res, { token: found.token, expiresAt: found.session.expiresAt }, req);
    }

    /**
     * 清除 Cookie。属性必须与下发时一致（HttpOnly / SameSite / Path），
     * 否则浏览器会把它当成另一个 Cookie 留着，原会话的 Cookie 仍在。
     */
    clearSessionCookie(res, req) {
        appendCookieHeader(res, this.cookieName, '', {
            maxAge: 0,          // 0 时由 appendCookieHeader 自动补 Expires 过去时间
            httpOnly: true,
            sameSite: 'Lax',
            path: '/',
            secure: this.cookieSecure && this.isHttps(req)
        });
    }
}

function readCookie(req, name) {
    const header = (req.headers && req.headers.cookie) || '';
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        const raw = part.slice(eq + 1).trim();
        // 百分号编码畸形时 decodeURIComponent 抛 URIError。未认证请求即可触发，
        // 而这里的调用栈都在 async 处理函数里、Express 4 不捕获 async 异常，
        // 于是变成 unhandledRejection 直接终止进程——一个 Cookie 就能打挂服务。
        // 解不出来就当成没有会话：宁可不认，不让它成为拒绝服务入口。
        try {
            return decodeURIComponent(raw);
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * 手写 Set-Cookie 拼装。Express 4 不带 res.cookie（那是 cookie-parser 提供的），
 * 为一个 Cookie 引入依赖不划算，这里只支持本项目用到的属性。
 */
function appendCookieHeader(res, name, value, options) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge !== undefined) {
        parts.push(`Max-Age=${options.maxAge}`);
        if (options.maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    }
    if (options.httpOnly) parts.push('HttpOnly');
    if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
    if (options.path) parts.push(`Path=${options.path}`);
    if (options.secure) parts.push('Secure');
    const cookie = parts.join('; ');

    const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null;
    const all = existing ? (Array.isArray(existing) ? existing.slice() : [existing]) : [];
    // 同名 Cookie 只能有一条：滑动续期会先写一条，信任设备再写一条。
    // 两条同名并存时浏览器取最后一条，语义正确但响应体含冗余，且让
    // 「当前会话的有效期」需要靠猜。直接替换掉同名的旧值。
    const replaced = all.map(item => (item.startsWith(`${name}=`) ? cookie : item));
    if (replaced.includes(cookie) || all.some(item => item.startsWith(`${name}=`))) {
        res.setHeader('Set-Cookie', Array.from(new Set(replaced)));
    } else {
        res.setHeader('Set-Cookie', [...all, cookie]);
    }
}

module.exports = {
    SessionStore,
    collectFingerprint,
    fingerprintScore,
    isSameDevice,
    readCookie,
    FP_WEIGHTS,
    FP_TOTAL,
    FP_THRESHOLD,
    MAX_SESSIONS,
    ACCEPT_CH,
    ENV_CHANGED_CODE,
    ENV_CHANGED_MESSAGE
};

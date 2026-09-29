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
        this.sessions = new Map();
    }

    ttlFor(trusted) {
        return trusted ? this.ttlTrusted : this.ttlDefault;
    }

    createSession(req, trusted) {
        const token = crypto.randomBytes(32).toString('hex');
        const now = this.now();
        this.sessions.set(token, {
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
        const session = this.sessions.get(token);
        if (!session) return null;

        if (session.expiresAt <= this.now()) {
            this.sessions.delete(token);
            return null;
        }

        const deviceOk = isSameDevice(session.fp, collectFingerprint(req));
        const region = this.lookupRegion(req);
        // 地理查不到（库缺失/IPv6/私网）时跳过该判据，而不是判为变化
        const regionOk = region === null || session.region === null || region === session.region;

        if (!deviceOk || !regionOk) {
            this.sessions.delete(token);
            if (reason) reason.code = ENV_CHANGED_CODE;
            return null;
        }

        // 滑动续期：只在令牌被真正使用时延长，闲置令牌照常过期
        session.expiresAt = this.now() + this.ttlFor(session.trusted);
        return { token, session };
    }

    markTrusted(token) {
        const session = this.sessions.get(token);
        if (!session) return null;
        session.trusted = true;
        session.expiresAt = this.now() + this.ttlFor(true);
        return session;
    }

    destroy(token) {
        if (token) this.sessions.delete(token);
    }

    sweep(now) {
        for (const [token, session] of this.sessions.entries()) {
            if (session.expiresAt <= now) this.sessions.delete(token);
        }
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

    /** 登录 / 信任设备时下发 Cookie。 */
    issueSession(res, req, trusted) {
        const token = this.createSession(req, trusted);
        this.setSessionCookie(res, { token, expiresAt: this.sessions.get(token).expiresAt }, req);
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
        if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
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
    ACCEPT_CH,
    ENV_CHANGED_CODE,
    ENV_CHANGED_MESSAGE
};

'use strict';

/**
 * provider adapter 共用的 HTTP 取数与错误分类。
 *
 * 为什么要有分类：「凭据失效」与「网络暂时不通」的下一步动作完全不同——
 * 前者要用户去重新授权，后者只需稍后重试。都塌缩成一句「同步失败」，
 * 界面就只能给一个含糊的提示。
 */

class AdapterError extends Error {
    /**
     * @param {'auth'|'rate'|'http'|'network'|'timeout'} code
     * @param {string} message 面向用户/日志的简短原因（不含凭据）
     */
    constructor(code, message) {
        super(message);
        this.name = 'AdapterError';
        this.code = code;
    }
}

const DEFAULT_TIMEOUT_MS = 12000;

/**
 * 取 JSON。fetch 没有内建超时，用 AbortSignal 兜住。
 *
 * 非 2xx 一律抛 AdapterError；响应体只在能解析成 JSON 时才读，
 * 否则正文（可能是 HTML 错误页）不塞进错误消息——那是给用户看的东西。
 */
async function getJson(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    let res;
    try {
        res = await fetch(url, {
            headers: { accept: 'application/json', ...headers },
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (err) {
        const timeout = !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new AdapterError(timeout ? 'timeout' : 'network', timeout ? '请求超时' : '网络错误');
    }

    let body = null;
    try {
        body = await res.json();
    } catch {
        body = null;
    }

    if (!res.ok) {
        const code = res.status === 401 || res.status === 403
            ? 'auth'
            : res.status === 429 ? 'rate' : 'http';
        throw new AdapterError(code, `HTTP ${res.status}`);
    }
    return body;
}

// ================= 只填链接时，抓标题与摘要 =================

function decodeEntities(value) {
    return String(value == null ? '' : value)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&');
}

/** 取某个 meta 的 content，属性顺序随意（og:title / description 等）。 */
function metaContent(html, key) {
    const tag = new RegExp(`<meta[^>]*(?:property|name)=["']${key}["'][^>]*>`, 'i').exec(html);
    if (!tag) return '';
    const content = /content=["']([^"']*)["']/i.exec(tag[0]);
    return content ? content[1] : '';
}

/** 从 HTML 里取标题与摘要；取不到给空串（调用方自己决定怎么退）。 */
function parsePageMeta(html) {
    const clean = s => decodeEntities(s).replace(/\s+/g, ' ').trim();
    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return {
        title: clean(metaContent(html, 'og:title') || metaContent(html, 'twitter:title')
            || (titleTag ? titleTag[1] : '')),
        summary: clean(metaContent(html, 'og:description') || metaContent(html, 'description')
            || metaContent(html, 'twitter:description'))
    };
}

/**
 * 抓一个网页的标题与摘要，供「只填链接」的保存流程使用。
 *
 * ⚠️ 这是**服务端代用户发起的请求**，属 SSRF 面：调用方必须先过 `safeHttpUrl`
 * （只允许 http/https）。这里再叠超时与响应体上限，并且**任何失败都返回空对象**——
 * 抓取失败不该让「保存」失败，调用方会退回「用链接当标题」。
 */
async function fetchPageMeta(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 256 * 1024 } = {}) {
    let res;
    try {
        res = await fetch(url, {
            redirect: 'follow',
            headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'nav-sylph/1' },
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch {
        return {};
    }
    if (!res.ok) return {};
    const type = res.headers.get('content-type') || '';
    if (type && !/text\/html|application\/xhtml/i.test(type)) return {};
    try {
        const buf = await res.arrayBuffer();
        return parsePageMeta(Buffer.from(buf.slice(0, maxBytes)).toString('utf8'));
    } catch {
        return {};
    }
}

module.exports = { getJson, AdapterError, DEFAULT_TIMEOUT_MS, fetchPageMeta, parsePageMeta };

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

module.exports = { getJson, AdapterError, DEFAULT_TIMEOUT_MS };

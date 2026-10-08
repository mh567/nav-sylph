'use strict';

/**
 * 微博开放平台 adapter。
 *
 * ⚠️ 诚实边界：与 x.js 同理——按官方文档的端点形状实现，**真实连通性未验证**
 * （本机没有开放平台应用与 access_token）。微博的 access_token 有有效期，
 * 过期后同步会以 auth 错误现形，界面提示「重新授权」，用户重新粘贴即可。
 *
 * 微博的错误不走 HTTP 状态码：HTTP 200 + body 里的 error_code。所以这里
 * 必须自己判 body，不能只看 res.ok。
 */

const { getJson, AdapterError } = require('../http');

const API = 'https://api.weibo.com/2';
const PAGE_SIZE = 50;

/** error_code → 分类。只列已知的几类，其余归 http。 */
const AUTH_ERRORS = new Set([
    21332, // 不存在的用户
    21315, // token 过期
    21317, // token 过期（另一条）
    21327, // token 过期
    21314  // token 无效
]);
const RATE_ERRORS = new Set([10023, 10022]);

function throwIfApiError(body) {
    const code = body && Number(body.error_code);
    if (!code) return;
    const message = String((body && body.error) || `error_code ${code}`);
    if (AUTH_ERRORS.has(code)) throw new AdapterError('auth', message);
    if (RATE_ERRORS.has(code)) throw new AdapterError('rate', message);
    throw new AdapterError('http', message);
}

module.exports = {
    id: 'weibo',
    label: '微博',
    symbol: '微',
    minIntervalMs: 5 * 60 * 1000,
    credentialLabel: 'Access Token',
    accountLabel: '微博昵称',

    validateSettings() {
        return { ok: true };
    },

    async testConnection({ credentials, externalKey }) {
        const token = credentials && credentials.token;
        if (!token) return { ok: false, code: 'auth', error: '缺少 Access Token' };
        const screenName = String(externalKey || '').trim();
        if (!screenName) return { ok: false, code: 'http', error: '缺少微博昵称' };
        try {
            const params = new URLSearchParams({ access_token: token, screen_name: screenName });
            const body = await getJson(`${API}/users/show.json?${params.toString()}`);
            throwIfApiError(body);
            if (!body || !body.id) return { ok: false, code: 'http', error: '未找到该账号' };
            return { ok: true, accountId: String(body.id) };
        } catch (err) {
            return { ok: false, code: err.code || 'http', error: err.message };
        }
    },

    async fetchEvents({ credentials, externalKey, cursor }) {
        const token = credentials && credentials.token;
        if (!token) throw new AdapterError('auth', '缺少 Access Token');
        const screenName = String(externalKey || '').trim();
        if (!screenName) throw new AdapterError('http', '缺少微博昵称');

        const params = new URLSearchParams({
            access_token: token,
            screen_name: screenName,
            count: String(PAGE_SIZE)
        });
        if (cursor) params.set('since_id', String(cursor));

        const body = await getJson(`${API}/statuses/user_timeline.json?${params.toString()}`);
        throwIfApiError(body);
        const rows = Array.isArray(body && body.statuses) ? body.statuses : [];

        let newest = null;
        for (const row of rows) {
            const s = row && row.id != null ? String(row.id) : '';
            if (!/^\d+$/.test(s)) continue;
            if (newest === null || BigInt(s) > BigInt(newest)) newest = s;
        }
        return {
            events: rows.map(row => this.normalize(row, { externalKey: screenName })),
            nextCursor: newest || cursor || null
        };
    },

    normalize(record, ctx = {}) {
        const id = record && record.id != null ? String(record.id) : '';
        if (!id) return null;
        // 微博的时间是 Twitter 风格："Sat Aug 10 12:00:00 +0800 2024"。
        // 解析不出来时 occurredAt 留 null，由 service 回落到摄入时刻。
        const parsed = record.created_at ? Date.parse(record.created_at) : NaN;
        const text = String(record.text || '');
        const screenName = (record.user && record.user.screen_name) || String(ctx.externalKey || '');
        // 链接用 mid（微博的 base62 短 id）；缺了才退回数字 id。
        const mid = record.mid ? String(record.mid) : id;
        return {
            providerEventId: id,
            eventType: 'social_post',
            occurredAt: Number.isFinite(parsed) ? parsed : null,
            author: screenName,
            title: text.split('\n')[0].trim().slice(0, 120) || '（无正文）',
            summary: text.split('\n').slice(1).join('\n').trim(),
            url: `https://weibo.com/${encodeURIComponent(screenName)}/${encodeURIComponent(mid)}`,
            metadata: {}
        };
    }
};

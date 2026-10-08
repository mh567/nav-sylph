'use strict';

/**
 * X（Twitter）官方 API v2 adapter。
 *
 * ⚠️ 诚实边界：这里按官方文档的端点形状实现，但**本机没有开发者凭据，
 * 真实连通性未验证**（单测只用 fixture）。运维需要自备开发者账号，且其
 * 访问层级要允许读取用户时间线；`testConnection` 是唯一真相来源。
 *
 * 用 App-Only Bearer Token（只读公开账号的时间线），不做应用内 OAuth。
 */

const { getJson, AdapterError } = require('../http');

const API = 'https://api.twitter.com/2';
/** 一次取多少条。100 是 v2 该端点的上限。 */
const PAGE_SIZE = 100;
/**
 * 缓存上次解析出的 userId，省一次 users/by/username 往返。
 *
 * 上限 32：键是账号名、只有管理员能建来源，实际到不了这个量——但**不设上限
 * 就是又一个「只增不减」的 Map**（本仓库对这形状有明确纪律，每个限流 Map
 * 都被要求登记进清扫）。超了整体清空，对这个规模比实现 LRU 划算。
 */
const USER_ID_CACHE_MAX = 32;
const userIdCache = new Map();

function normalizeAccount(raw) {
    return String(raw || '').trim().replace(/^@/, '');
}

/** 取最大的数字 id（tweet id 是 19 位十进制，超出 Number 精度）。 */
function newestId(ids) {
    let best = null;
    for (const id of ids) {
        const s = String(id);
        if (!/^\d+$/.test(s)) continue;
        if (best === null || BigInt(s) > BigInt(best)) best = s;
    }
    return best;
}

async function resolveUserId(externalKey, token) {
    const cached = userIdCache.get(externalKey);
    if (cached) return cached;
    const body = await getJson(`${API}/users/by/username/${encodeURIComponent(externalKey)}`, {
        headers: { authorization: `Bearer ${token}` }
    });
    const id = body && body.data && body.data.id;
    if (!id) throw new AdapterError('http', '未找到该账号');
    if (userIdCache.size >= USER_ID_CACHE_MAX) userIdCache.clear();
    userIdCache.set(externalKey, String(id));
    return String(id);
}

module.exports = {
    id: 'x',
    label: 'X',
    symbol: 'X',
    /**
     * 最小间隔压到 15 分钟：X 的读取配额很紧，5 分钟一拉会很快打满。
     * 这是保守取值，不是从配额表推出来的（未验证）。
     */
    minIntervalMs: 15 * 60 * 1000,
    credentialLabel: 'Bearer Token',
    accountLabel: '账号名（不含 @）',

    validateSettings() {
        return { ok: true };
    },

    async testConnection({ credentials, externalKey }) {
        const token = credentials && credentials.token;
        if (!token) return { ok: false, code: 'auth', error: '缺少 Bearer Token' };
        if (!normalizeAccount(externalKey)) return { ok: false, code: 'http', error: '缺少账号名' };
        try {
            const id = await resolveUserId(normalizeAccount(externalKey), token);
            return { ok: true, accountId: id };
        } catch (err) {
            return { ok: false, code: err.code || 'http', error: err.message };
        }
    },

    async fetchEvents({ credentials, externalKey, cursor }) {
        const token = credentials && credentials.token;
        if (!token) throw new AdapterError('auth', '缺少 Bearer Token');
        const username = normalizeAccount(externalKey);
        const userId = await resolveUserId(username, token);

        const params = new URLSearchParams({
            max_results: String(PAGE_SIZE),
            'tweet.fields': 'created_at,author_id',
            exclude: 'replies,retweets'
        });
        if (cursor) params.set('since_id', String(cursor));

        const body = await getJson(`${API}/users/${userId}/tweets?${params.toString()}`, {
            headers: { authorization: `Bearer ${token}` }
        });
        const rows = Array.isArray(body && body.data) ? body.data : [];
        return {
            events: rows.map(row => this.normalize(row, { externalKey: username })),
            // since_id 语义：记住本批里最大的 id，下一轮只要更新的。
            nextCursor: newestId(rows.map(r => r.id)) || cursor || null
        };
    },

    normalize(record, ctx = {}) {
        const id = record && record.id != null ? String(record.id) : '';
        if (!id) return null;
        const text = String(record.text || '');
        const firstLine = text.split('\n')[0].trim();
        const rest = text.split('\n').slice(1).join('\n').trim();
        const username = normalizeAccount(ctx.externalKey);
        const createdAt = record.created_at ? Date.parse(record.created_at) : NaN;
        return {
            providerEventId: id,
            eventType: 'social_post',
            occurredAt: Number.isFinite(createdAt) ? createdAt : null,
            author: username ? '@' + username : '',
            // 标题截到 120，摘要留全文（service 会再按上限裁一次）
            title: (firstLine || text).slice(0, 120) || '（无正文）',
            summary: rest || (firstLine.length > 120 ? firstLine : ''),
            url: username ? `https://x.com/${username}/status/${id}` : '',
            metadata: {}
        };
    }
};

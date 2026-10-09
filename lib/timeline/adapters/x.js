'use strict';

const { getJson, AdapterError } = require('../http');
const {
    SYNC_INTERVALS_MS, X_MAX_PAGES, MAX_TRANSLATIONS_PER_SYNC, TRANSLATION_CONCURRENCY
} = require('../constants');

const API = 'https://api.fxtwitter.com/2/profile';
const STATUS_API = 'https://api.fxtwitter.com/2/status';
const OPTIONS = { maxBytes: 2 * 1024 * 1024, redirect: 'error', timeoutMs: 12000 };
/** 译文语言。X 自带翻译（provider: grok）只挂在单条接口上，列表接口不带。 */
const TRANSLATE_TO = 'zh-cn';
/** 已含中日韩统一表意文字就不必再翻——多半本身就是中文。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function normalizeAccount(raw) {
    const handle = String(raw || '').trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        throw new AdapterError('http', '请输入 1–15 位字母、数字或下划线的 X 用户名，不要填写链接');
    }
    return handle;
}

function validId(row) {
    if (!row || typeof row !== 'object' || row.type !== 'status') return null;
    const id = typeof row.id === 'string' ? row.id : Number.isSafeInteger(row.id) ? String(row.id) : '';
    return /^\d+$/.test(id) && row.author && typeof row.author.screen_name === 'string'
        && typeof row.text === 'string' ? id : null;
}

function checkBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AdapterError('http', 'FxEmbed 返回无效 JSON，请稍后重试');
    }
    if (body.code !== 200) {
        const code = body.code === 429 ? 'rate' : 'http';
        const message = body.code === 429 ? 'FxEmbed 限流，请稍后重试'
            : body.code === 401 || body.code === 403 ? '账号可能为私密或已被封禁，请确认公开可访问'
                : body.code === 404 ? (body.reason === 'suspended' ? '账号已被封禁，请确认公开可访问' : '无法确认该账号或时间线，请确认用户名后重试')
                    : 'FxEmbed 上游故障，请稍后重试';
        throw new AdapterError(code, message);
    }
}

async function requestJson(url, options) {
    try { return await getJson(url, options); }
    catch (err) {
        if (err.status === 401 || err.status === 403) {
            throw new AdapterError('http', '账号可能为私密或已被封禁，请确认公开可访问');
        }
        if (err.status === 429) throw new AdapterError('rate', 'FxEmbed 限流，请稍后重试');
        throw err;
    }
}

async function profileFor(handle) {
    const body = await requestJson(`${API}/${encodeURIComponent(handle)}`, { ...OPTIONS, allowedStatuses: [404] });
    checkBody(body);
    const profile = body.user || body.results;
    if (!profile || Array.isArray(profile) || typeof profile !== 'object'
        || normalizeAccount(profile.screen_name).toLowerCase() !== handle.toLowerCase()) {
        throw new AdapterError('http', '无法确认账号资料，请稍后重试');
    }
    if (profile.protected || profile.private || profile.suspended) {
        throw new AdapterError('http', '账号为私密或已被封禁，请确认公开可访问');
    }
    return profile;
}

/** 这条值不值得为它多打一次请求取译文。 */
function needsTranslation(record) {
    if (String(record.lang || '').toLowerCase().startsWith('zh')) return false;
    const text = String(record.text || '');
    return !!text.trim() && !CJK.test(text);
}

/** 取单条译文；取不到返回空串（不抛错，交调用方跳过这一条）。 */
async function fetchTranslation(id) {
    const body = await getJson(`${STATUS_API}/${encodeURIComponent(id)}?lang=${TRANSLATE_TO}`, OPTIONS);
    if (!body || typeof body !== 'object' || body.code !== 200) return '';
    const t = body.status && body.status.translation;
    if (!t || typeof t.text !== 'string') return '';
    const target = String(t.target_lang || '').toLowerCase();
    if (target && !target.startsWith('zh')) return '';
    return t.text.trim();
}

/**
 * 为这一轮新入库的事件补译文。**有界**：最多 MAX_TRANSLATIONS_PER_SYNC 条、
 * 并发 TRANSLATION_CONCURRENCY；单条失败只跳过该条，绝不影响整批入库。
 */
async function attachTranslations(pending) {
    const batch = pending.slice(0, MAX_TRANSLATIONS_PER_SYNC);
    let next = 0;
    const worker = async () => {
        while (next < batch.length) {
            const item = batch[next++];
            try {
                const text = await fetchTranslation(item.record.id);
                if (text) item.event.metadata.translation = text;
            } catch {
                // 单条取不到译文不是错误：这一条按原文展示
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(TRANSLATION_CONCURRENCY, batch.length) }, worker));
}

async function statuses(handle, cursor, profile) {
    const params = new URLSearchParams({ count: '100' });
    if (cursor) params.set('cursor', cursor);
    const body = await requestJson(`${API}/${encodeURIComponent(handle)}/statuses?${params}`,
        { ...OPTIONS, allowedStatuses: [404] });
    if (body && body.code === 404 && Array.isArray(body.results) && body.results.length === 0
        && body.cursor && !body.cursor.bottom) {
        if (!profile) await profileFor(handle);
        return { ...body, code: 200 };
    }
    checkBody(body);
    if (!Array.isArray(body.results) || !body.cursor || typeof body.cursor !== 'object'
        || (body.cursor.bottom != null && typeof body.cursor.bottom !== 'string')) {
        throw new AdapterError('http', 'FxEmbed 时间线格式无效，请稍后重试');
    }
    return body;
}

module.exports = {
    id: 'x',
    label: 'X',
    symbol: 'X',
    requiresCredentials: false,
    minIntervalMs: 60000,
    defaultSyncIntervalMs: 300000,
    syncIntervalsMs: SYNC_INTERVALS_MS,
    credentialLabel: null,
    accountLabel: '账号名（不含 @）',
    normalizeAccount,

    validateSettings() {
        return { ok: true };
    },

    async testConnection({ externalKey }) {
        try {
            const handle = normalizeAccount(externalKey);
            const profile = await profileFor(handle);
            await statuses(handle, null, profile);
            return { ok: true, accountId: profile.id == null ? null : String(profile.id) };
        } catch (err) {
            return { ok: false, code: err.code || 'http', error: err.message };
        }
    },

    async fetchEvents({ externalKey, cursor }) {
        const handle = normalizeAccount(externalKey);
        const watermark = /^\d+$/.test(String(cursor || '')) ? String(cursor) : null;
        let newest = watermark;
        let pageCursor = null;
        const seen = [];
        const events = [];
        /** 本轮新入库、且值得取译文的事件（与它的原始记录配对）。 */
        const pending = [];
        let done = false;
        for (let page = 0; page < X_MAX_PAGES && !done; page++) {
            const body = await statuses(handle, pageCursor);
            const ids = [];
            for (const row of body.results) {
                const id = validId(row);
                if (!id) continue;
                ids.push(id);
                if (!newest || BigInt(id) > BigInt(newest)) newest = id;
                if (!watermark || BigInt(id) > BigInt(watermark)) {
                    const event = this.normalize(row, { externalKey: handle });
                    if (event) {
                        events.push(event);
                        if (needsTranslation(row)) pending.push({ event, record: row });
                    }
                }
            }
            const bottom = body.cursor && body.cursor.bottom;
            const last = body.results.filter(row => validId(row) && !row.is_pinned && !row.pinned).at(-1);
            // 到达水位只看「本页最后一条非置顶动态」——加上 ids.length > 1 会让
            // 「末页只剩一条且正好到水位」判成没到，翻满五页后误报覆盖不全。
            const reached = !!last && BigInt(validId(last)) <= BigInt(watermark || '0');
            if (!watermark || reached || !bottom || body.results.length === 0) { done = true; break; }
            if (page === X_MAX_PAGES - 1 || seen.includes(String(bottom))) {
                throw new AdapterError('http', '未能覆盖所有新动态，请缩短监控周期后重试');
            }
            pageCursor = String(bottom);
            seen.push(pageCursor);
        }
        if (!done) throw new AdapterError('http', '时间线分页失败，请稍后重试');
        await attachTranslations(pending);
        return { events, nextCursor: newest || cursor || null };
    },

    normalize(record, ctx = {}) {
        const id = validId(record);
        if (!id || record.replying_to || record.reposted_by) return null;
        let username;
        try {
            username = normalizeAccount(record.author.screen_name);
            if (username.toLowerCase() !== normalizeAccount(ctx.externalKey).toLowerCase()) return null;
        } catch { return null; }
        const text = record.text;
        const firstLine = text.split('\n')[0].trim();
        const parsed = Number.isFinite(record.created_timestamp)
            ? record.created_timestamp * 1000 : Date.parse(record.created_at);
        const metadata = {};
        if (record.quote && typeof record.quote.text === 'string') metadata.quote = record.quote.text;
        const displayName = record.author && record.author.name;
        if (typeof displayName === 'string' && displayName.trim()) metadata.authorName = displayName.trim();
        const avatar = record.author && record.author.avatar_url;
        if (typeof avatar === 'string' && avatar.trim()) metadata.authorAvatar = avatar.trim();
        return {
            providerEventId: id,
            eventType: 'social_post',
            occurredAt: Number.isFinite(parsed) ? parsed : null,
            author: '@' + username,
            title: firstLine.slice(0, 120) || '（无正文）',
            summary: text.split('\n').slice(1).join('\n').trim() || (firstLine.length > 120 ? firstLine : ''),
            url: `https://x.com/${username}/status/${id}`,
            metadata
        };
    }
};

'use strict';

const { getJson, AdapterError } = require('../http');
const {
    SYNC_INTERVALS_MS, X_MAX_PAGES, X_BACKFILL_PAGES_PER_SYNC
} = require('../constants');

const API = 'https://api.fxtwitter.com/2/profile';
const STATUS_API = 'https://api.fxtwitter.com/2/status';
const OPTIONS = { maxBytes: 2 * 1024 * 1024, redirect: 'error', timeoutMs: 12000 };
/** 译文语言。X 自带翻译（provider: grok）只挂在单条接口上，列表接口不带。 */
const TRANSLATE_TO = 'zh-cn';

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

/** 推文 id 是雪花号：高 41 位是毫秒时间戳，可以直接算出发布时刻。 */
function idTime(id) {
    try { return Number((BigInt(id) >> 22n) + 1288834974657n); } catch { return null; }
}

/**
 * 取单条动态的作者名 / 头像 / 中文译文。
 *
 * 译文只挂在单条接口上（列表接口即使带 `lang` 也不返回），所以这笔请求
 * 顺带把作者信息也取回来——老版本入库的事件只有 @handle，没有昵称与头像，
 * 靠它一并补上。取不到就返回 null，由调用方跳过这一条。
 */
async function fetchStatusMeta(id) {
    let body;
    try {
        body = await getJson(`${STATUS_API}/${encodeURIComponent(id)}?lang=${TRANSLATE_TO}`, OPTIONS);
    } catch (err) {
        // 帖子已被删除 / 账号不可见：这是**确定性**结果，记「已判定」让它别每轮重问；
        // 其余错误（网络、限流、上游故障）抛出去，留到下一轮再試。
        if (err && err.status === 404) return { translationSettled: '1' };
        throw err;
    }
    if (!body || typeof body !== 'object' || body.code !== 200) {
        if (body && body.code === 404) return { translationSettled: '1' };
        return null;
    }
    const status = body.status;
    if (!status || typeof status !== 'object') return null;
    const meta = {};
    const name = status.author && status.author.name;
    if (typeof name === 'string' && name.trim()) meta.authorName = name.trim();
    const avatar = status.author && status.author.avatar_url;
    if (typeof avatar === 'string' && avatar.trim()) meta.authorAvatar = avatar.trim();
    const t = status.translation;
    if (t && typeof t.text === 'string' && t.text.trim()) {
        const target = String(t.target_lang || '').toLowerCase();
        if (!target || target.startsWith('zh')) meta.translation = t.text.trim();
    }
    // 没有拿到译文（已是中文，或 X 没提供）就记一个「已判定」标记：
    // 否则这一条会每一轮都被当成「缺译文」重新请求一次。
    if (!meta.translation) meta.translationSettled = '1';
    return Object.keys(meta).length ? meta : null;
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
    fetchStatusMeta,

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

    /**
     * 增量拉取。
     *
     * 单轮请求数有界（`X_MAX_PAGES`），但**翻满预算不等于失败**：未追到水位时
     * 把「本轮取到的消息 + 下一页游标」一起返回，由 service 落进度、下一轮接着走。
     * 旧实现把部分进度整批丢掉再抛错，水位又因失败不推进，于是每轮从同一位置重来，
     * 永久卡在「未能覆盖所有新动态」——这正是用户报的现象。
     *
     * 缺口了结（`covered`）有两个条件：追到 `cursor` 水位，或已翻过保留窗口
     * （`windowStartMs`）——后者说明缺口整体在保留期之外，没有值得留下的消息，
     * 此时放弃老水位并以最新 id 推进（`abandonedOldWatermark`）。
     *
     * @param {string}  cursor        要追到的水位（上次完整覆盖的最高 id）
     * @param {string?} resumeCursor  上一轮存下的续接页游标；为空则从最新页开始
     * @param {number?} windowStartMs 保留窗口下界，由 service 传入
     *
     * ⚠️ `nextCursor` 只有**未续接**（`resumeCursor` 为空）时才等于真正的最新 id；
     * 续接时本轮是从时间线中段开始的，看到的最大 id 并非最新，service 要用
     * `settings.catchup.top` 推进水位。
     */
    async fetchEvents({ externalKey, cursor, resumeCursor, windowStartMs }) {
        const handle = normalizeAccount(externalKey);
        const watermark = /^\d+$/.test(String(cursor || '')) ? String(cursor) : null;
        let newest = null;
        let pageCursor = resumeCursor ? String(resumeCursor) : null;
        let firstPageBottom = null;
        // 本轮用过的页游标。续接时要连「上一轮停下的那个游标」一起算进来：
        // 上游把同一个游标原样还回来就是这个来源卡住的形态。
        const seen = new Set();
        if (pageCursor) seen.add(pageCursor);
        const events = [];
        let covered = false;
        let abandonedOldWatermark = false;

        for (let page = 0; page < X_MAX_PAGES; page++) {
            const body = await statuses(handle, pageCursor);
            const bottom = body.cursor && body.cursor.bottom;
            // 只有从最新页开始的这一轮才配得上「第一页的翻页游标」：
            // 续接轮的起始页在时间线中段，拿它当回填起点会跳过窗口顶部。
            if (page === 0 && !resumeCursor) firstPageBottom = bottom ? String(bottom) : null;

            let oldestMs = null;
            for (const row of body.results) {
                const id = validId(row);
                if (!id) continue;
                if (!newest || BigInt(id) > BigInt(newest)) newest = id;
                // ⚠️ 置顶帖不参与「本页最旧」的判断：一条 30 天前的置顶会把整页
                // 判成已越过保留窗口，于是水位跳到最新、`(本页底, 水位]` 的积压
                // 消息被永久跳过（回填若已 done，就再也补不回来）。
                // 与下面 `last` 的过滤保持同一口径。
                const pinned = !!(row.is_pinned || row.pinned);
                if (!pinned && windowStartMs !== undefined && windowStartMs !== null) {
                    const ms = idTime(id);
                    if (ms !== null && (oldestMs === null || ms < oldestMs)) oldestMs = ms;
                }
                // 水位的推进要算上被过滤的回复 / 转发（validId 已收），
                // 否则只发回复的账号每轮都会重新翻页。
                if (!watermark || BigInt(id) > BigInt(watermark)) {
                    const event = this.normalize(row, { externalKey: handle });
                    if (event) events.push(event);
                }
            }

            const last = body.results.filter(row => validId(row) && !row.is_pinned && !row.pinned).at(-1);
            const reached = !!last && BigInt(validId(last)) <= BigInt(watermark || '0');
            const passedWindow = oldestMs !== null && windowStartMs !== undefined
                && windowStartMs !== null && oldestMs <= windowStartMs;

            if (reached || passedWindow) {
                covered = true;
                abandonedOldWatermark = passedWindow && !reached;
                break;
            }
            // 没有水位（首次接入）、没有下一页、或本页为空：缺口到头了。
            if (!watermark || !bottom || body.results.length === 0) { covered = true; break; }
            if (seen.has(String(bottom))) {
                throw new AdapterError('pagination', '上游分页游标重复，本轮已停止');
            }
            seen.add(String(bottom));
            pageCursor = String(bottom);
        }

        return {
            events,
            nextCursor: newest || watermark || null,
            covered,
            resumeCursor: covered ? null : pageCursor,
            firstPageBottom,
            abandonedOldWatermark
        };
    },

    /**
     * 往更早翻页，把保留窗口内的历史铺满。
     *
     * 热门账号一页（约 20 条）里可能只剩个位数原创——只拉一页会让库里只有
     * 十几条，既凑不满一屏，也永远触发不了分页。这里每轮往下翻
     * `X_BACKFILL_PAGES_PER_SYNC` 页，并从保存的游标接着走；翻到某页最旧一条
     * 早于保留窗口就认为铺满了（`done`）。已入库的条目由数据库去重吸收，
     * 所以重复翻页只是白花请求，不会重复入库。
     */
    async fetchHistory({ externalKey, cursor, cutoffMs }) {
        const handle = normalizeAccount(externalKey);
        let pageCursor = cursor || null;
        const events = [];
        let done = false;
        for (let page = 0; page < X_BACKFILL_PAGES_PER_SYNC; page++) {
            const body = await statuses(handle, pageCursor);
            const bottom = body.cursor && body.cursor.bottom;
            let oldestMs = null;
            for (const row of body.results) {
                const id = validId(row);
                if (!id) continue;
                const ms = idTime(id);
                if (ms && (oldestMs === null || ms < oldestMs)) oldestMs = ms;
                const event = this.normalize(row, { externalKey: handle });
                if (event) events.push(event);
            }
            pageCursor = bottom ? String(bottom) : null;
            if (!body.results.length || !pageCursor) { done = true; break; }
            if (oldestMs !== null && oldestMs <= cutoffMs) { done = true; break; }
        }
        return { events, nextCursor: pageCursor, done };
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

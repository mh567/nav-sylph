'use strict';

/**
 * 时间线的编排层，也是**不可信输入的边界**。
 *
 * adapter 拉回来的一切（第三方 API 字段）、用户提交的一切（保存文章、
 * 来源表单）都在这里被裁剪与验证，之后才允许落库、进备份、进渲染。
 * 路由只做鉴权与调用，不在这里重复判断。
 */

const crypto = require('crypto');
const { getProvider, isEventType, eventTypeLabel, selectableProviders } = require('./registry');
const { fetchPageMeta } = require('./http');
const {
    MANUAL_SOURCE_ID, LIMITS, METADATA_KEYS, SOCIAL_RETENTION_DAYS,
    MAX_EVENTS_PER_SOURCE, MAX_MANUAL_ARTICLES, DEFAULT_SYNC_INTERVAL_MS,
    MAX_BACKOFF_MS, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX
} = require('./constants');
const { encrypt, decrypt } = require('../credentials');

/** 允许的最早时间：2000-01-01。再早的时间在时间轴上排不出意义。 */
const MIN_TIME = 946684800000;

class ServiceError extends Error {
    constructor(status, message, code) {
        super(message);
        this.name = 'ServiceError';
        this.status = status;
        this.code = code || 'bad_request';
    }
}

function clampText(value, max) {
    if (value === null || value === undefined) return '';
    const s = String(value).trim();
    if (!s) return '';
    return s.length > max ? s.slice(0, max) : s;
}

/** 抓不到标题时的兜底：用链接的「域名 + 路径」当标题。 */
function titleFromLink(url) {
    try {
        const u = new URL(url);
        const path = decodeURIComponent(u.pathname || '').replace(/\/+$/, '');
        return (u.host + path).slice(0, 300) || url;
    } catch {
        return url;
    }
}

/** 只允许 http/https。file:、javascript:、data: 一律拒绝。 */
function safeHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    let parsed;
    try {
        parsed = new URL(value.trim());
    } catch {
        return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const s = parsed.toString();
    return s.length > LIMITS.url ? s.slice(0, LIMITS.url) : s;
}

/**
 * provider 给的时间可能缺失或离谱（时区乱填、秒当毫秒）。
 * 回落到摄入时刻而不是丢弃整条——丢一个时间比丢整条内容轻。
 */
function safeTime(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n < MIN_TIME || n > Date.now() + 3600 * 1000) return fallback;
    return Math.round(n);
}

/** metadata 白名单：只留 {quote}，其余键丢弃。 */
function sanitizeMetadata(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const key of METADATA_KEYS) {
        const value = raw[key];
        if (typeof value === 'string' && value.trim()) {
            out[key] = clampText(value, LIMITS[key] || 1000);
        }
    }
    return out;
}

function hashKey(prefix, value) {
    return prefix + crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

/**
 * provider 的错误文本可能把请求原样回显（微博的 access_token 就在 query string
 * 里）。这段文本会写进 last_error（后台可见）与日志，所以先剥掉像凭据的片段。
 */
function scrubSecrets(text) {
    return String(text === null || text === undefined ? '' : text)
        .replace(/((?:access_token|token|api_key|apikey|secret)=)[^&\s'"]+/gi, '$1***')
        .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1***')
        .slice(0, 400);
}

/**
 * @param {object} repo createRepository 的返回值
 * @param {object} deps
 * @param {() => Promise<string>} deps.getPasswordHash 凭据加解密用（异步：读密码文件）
 * @param {(kind: string) => void} [deps.onDurableChange] 不可再生数据变更的钩子（见下）
 */
function createService(repo, { getPasswordHash, onDurableChange = () => {}, log = console,
    // 抓目标页的标题/摘要（只填链接的保存流程用）。可注入：测试不该真的发网络请求。
    fetchMeta = fetchPageMeta } = {}) {
    if (typeof getPasswordHash !== 'function') {
        throw new Error('createService 需要 getPasswordHash');
    }
    /** sourceId → 连续失败次数（决定退避）。进程内即可，重启清零。 */
    const failures = new Map();

    function adapterFor(providerType) {
        const adapter = getProvider(providerType);
        if (!adapter) throw new ServiceError(400, '未知的来源类型');
        return adapter;
    }

    /** 生效间隔 = 用户设置与 adapter 最小间隔取大（X 的配额比默认值更紧）。 */
    function intervalFor(source) {
        const adapter = getProvider(source.providerType);
        const min = (adapter && adapter.minIntervalMs) || 0;
        const base = Number(source.syncIntervalMs) || DEFAULT_SYNC_INTERVAL_MS;
        return Math.max(base, min);
    }

    function backoffFor(source, consecutive) {
        const ms = intervalFor(source) * Math.pow(2, Math.max(0, consecutive - 1));
        return Math.min(ms, MAX_BACKOFF_MS);
    }

    async function decryptCredentials(source) {
        const envelope = repo.getCredentials(source.id);
        if (!envelope) return null;
        try {
            const hash = await getPasswordHash();
            return JSON.parse(decrypt(envelope, hash, 'timeline'));
        } catch {
            // 解不开（改过密码、或密文损坏）——按「没有凭据」处理，
            // 界面给「重新授权」，而不是让整次同步以未知错误崩掉。
            return null;
        }
    }

    async function storeCredentials(sourceId, credentials) {
        const hash = await getPasswordHash();
        repo.setCredentials(sourceId, encrypt(JSON.stringify(credentials), hash, 'timeline'));
    }

    /** 来源 → 界面形状。status 决定界面给什么下一步。 */
    function sourceView(source) {
        const adapter = getProvider(source.providerType);
        let status;
        if (source.providerType === MANUAL_SOURCE_ID) status = 'manual';
        else if (!source.enabled) status = 'paused';
        else if (!source.hasCredentials) status = 'pending';
        else if (source.lastError && source.lastError.code === 'auth') status = 'expired';
        else if (source.lastError) status = 'failed';
        else status = 'ok';

        return {
            id: source.id,
            providerType: source.providerType,
            providerLabel: (adapter && adapter.label) || source.providerType,
            providerSymbol: (adapter && adapter.symbol) || '·',
            name: source.name,
            externalKey: source.externalKey,
            enabled: source.enabled,
            hasCredentials: source.hasCredentials,
            status,
            lastError: source.lastError || null,
            lastSuccessAt: source.lastSuccessAt,
            nextSyncAt: source.nextSyncAt,
            createdAt: source.createdAt
        };
    }

    function eventView(row) {
        const adapter = getProvider(row.providerType);
        return {
            id: row.id,
            sourceId: row.sourceId,
            sourceName: row.sourceName,
            providerType: row.providerType,
            providerSymbol: (adapter && adapter.symbol) || '·',
            eventType: row.eventType,
            eventTypeLabel: eventTypeLabel(row.eventType, row.providerType),
            occurredAt: row.occurredAt,
            ingestedAt: row.ingestedAt,
            author: row.author,
            title: row.title,
            summary: row.summary,
            url: row.url,
            quote: (row.metadata && row.metadata.quote) || '',
            unread: !row.readAt,
            archived: !!row.archivedAt
        };
    }

    /** adapter 输出 → 可信事件。不合格返回 null（跳过这一条，不作废整批）。 */
    function sanitizeEvent(raw) {
        if (!raw || typeof raw !== 'object') return null;
        if (!isEventType(raw.eventType)) return null;
        const title = clampText(raw.title, LIMITS.title);
        if (!title) return null;
        const providerEventId = clampText(raw.providerEventId, LIMITS.providerEventId);
        const occurredAt = safeTime(raw.occurredAt, Date.now());
        const author = clampText(raw.author, LIMITS.author);
        return {
            providerEventId,
            eventType: raw.eventType,
            occurredAt,
            author,
            title,
            summary: clampText(raw.summary, LIMITS.summary),
            url: safeHttpUrl(raw.url),
            metadata: sanitizeMetadata(raw.metadata),
            // 有 provider 事件 id 就用它；否则按「时间+标题+作者」算稳定键。
            // 两者都必须稳定，否则重复同步会重复入库。
            dedupeKey: providerEventId
                ? providerEventId
                : hashKey('h:', `${occurredAt}|${title}|${author}`)
        };
    }

    return {
        selectableProviders,

        ensureManualSource() {
            return repo.ensureManualSource();
        },

        listSources() {
            return repo.listSources().map(sourceView);
        },

        getSourceView(id) {
            const source = repo.getSource(id);
            return source ? sourceView(source) : null;
        },

        dueSources(now, limit) {
            return repo.dueSources(now, limit);
        },

        /** 面板读取：事件页 + 来源状态 + 未读数。 */
        listTimeline({ sourceId = null, view = 'all', cursor = null, limit } = {}) {
            const safeView = ['all', 'unread', 'archived'].includes(view) ? view : 'all';
            const size = Math.min(Math.max(Number(limit) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
            const page = repo.listEvents({ sourceId, view: safeView, cursor, limit: size });
            const sources = repo.listSources().map(sourceView);
            const failed = sources.filter(s => s.status === 'expired' || s.status === 'failed');
            return {
                events: page.rows.map(eventView),
                nextCursor: page.hasMore ? page.nextCursor : null,
                hasMore: page.hasMore,
                unreadCount: repo.unreadCount(),
                sources,
                sync: {
                    state: failed.length ? 'failed' : 'ok',
                    failed: failed.map(s => ({
                        id: s.id,
                        name: s.name,
                        code: (s.lastError && s.lastError.code) || 'http',
                        message: (s.lastError && s.lastError.message) || ''
                    }))
                }
            };
        },

        /**
         * 保存文章。同一 URL 是更新而不是新增。
         *
         * 用户要求「只需填链接就行」：标题与摘要都成了选填，留空时**服务端**去抓
         * （浏览器跨域抓不到目标页）。抓不到就退回「用链接的域名+路径当标题」，
         * 并用 `titleFromUrl` 告诉界面提示用户。抓取失败**不**让保存失败。
         */
        async saveArticle({ url, title, summary }) {
            const safeUrl = safeHttpUrl(url);
            if (!safeUrl) throw new ServiceError(400, '请填写有效的 http 或 https 链接');

            let safeTitle = clampText(title, LIMITS.title);
            let safeSummary = clampText(summary, LIMITS.summary);
            let titleFromUrl = false;
            if (!safeTitle || !safeSummary) {
                const meta = await fetchMeta(safeUrl);
                if (!safeTitle) {
                    safeTitle = clampText(meta.title, LIMITS.title);
                    if (!safeTitle) { safeTitle = clampText(titleFromLink(safeUrl), LIMITS.title); titleFromUrl = true; }
                }
                if (!safeSummary) safeSummary = clampText(meta.summary, LIMITS.summary);
            }

            repo.ensureManualSource();
            if (repo.countSourceEvents(MANUAL_SOURCE_ID) >= MAX_MANUAL_ARTICLES) {
                throw new ServiceError(409,
                    `稍后阅读已达上限 ${MAX_MANUAL_ARTICLES} 条，请先清理已归档的文章`);
            }

            const now = Date.now();
            const row = repo.upsertManualEvent({
                dedupeKey: hashKey('url:', safeUrl),
                occurredAt: now,
                title: safeTitle,
                summary: safeSummary,
                url: safeUrl,
                metadata: {}
            }, now);
            onDurableChange('article');
            return Object.assign(eventView(Object.assign({}, row, {
                providerType: 'manual',
                sourceName: '稍后阅读'
            })), { titleFromUrl });
        },

        markRead(id, read) {
            if (!repo.getEvent(id)) throw new ServiceError(404, '事件不存在');
            repo.setRead(id, !!read, Date.now());
            onDurableChange('state');
            return { id, unread: !read };
        },

        archive(id, archived) {
            if (!repo.getEvent(id)) throw new ServiceError(404, '事件不存在');
            repo.setArchive(id, !!archived, Date.now());
            onDurableChange('state');
            return { id, archived: !!archived };
        },

        /** 新建来源：**先测连通再落库**，填错了当场告诉用户。 */
        async createSource({ providerType, name, externalKey, token }) {
            const adapter = adapterFor(providerType);
            if (!adapter.accountLabel) throw new ServiceError(400, '该来源类型不能手动添加');
            const key = clampText(externalKey, LIMITS.externalKey);
            if (!key) throw new ServiceError(400, `请填写${adapter.accountLabel}`);
            const secret = clampText(token, 4096);
            if (!secret) throw new ServiceError(400, `请填写${adapter.credentialLabel || '凭据'}`);

            const credentials = { token: secret };
            const result = await adapter.testConnection({ credentials, externalKey: key });
            if (!result || !result.ok) {
                throw new ServiceError(400,
                    `连接失败：${(result && result.error) || '未知原因'}`,
                    (result && result.code) || 'http');
            }

            const source = repo.createSource({
                providerType,
                name: clampText(name, LIMITS.name) || `${adapter.label} · ${key}`,
                externalKey: key,
                settings: {},
                syncIntervalMs: Math.max(DEFAULT_SYNC_INTERVAL_MS, adapter.minIntervalMs || 0),
                nextSyncAt: Date.now()
            });
            await storeCredentials(source.id, credentials);
            onDurableChange('source');
            return sourceView(repo.getSource(source.id));
        },

        /**
         * 改来源。带 token 就是「重新授权」：先测再存，避免把一个好来源改坏。
         * token 留空表示保留原值（与后台的 WebDAV 密码字段同一约定）。
         */
        async updateSource(id, { name, externalKey, token, enabled }) {
            const source = repo.getSource(id);
            if (!source) throw new ServiceError(404, '来源不存在');
            if (source.providerType === MANUAL_SOURCE_ID) throw new ServiceError(400, '内置来源不能修改');
            const adapter = adapterFor(source.providerType);

            const patch = {};
            if (name !== undefined) patch.name = clampText(name, LIMITS.name) || source.name;
            if (externalKey !== undefined) {
                const key = clampText(externalKey, LIMITS.externalKey);
                if (!key) throw new ServiceError(400, `请填写${adapter.accountLabel}`);
                patch.externalKey = key;
            }
            if (enabled !== undefined) patch.enabled = !!enabled;

            const secret = clampText(token, 4096);
            if (secret) {
                const credentials = { token: secret };
                const result = await adapter.testConnection({
                    credentials,
                    externalKey: patch.externalKey || source.externalKey
                });
                if (!result || !result.ok) {
                    throw new ServiceError(400,
                        `连接失败：${(result && result.error) || '未知原因'}`,
                        (result && result.code) || 'http');
                }
                await storeCredentials(id, credentials);
                failures.delete(id);
                // 重新授权意味着用户期待它马上工作：清掉旧的失败记录并立刻排一次同步
                patch.enabled = patch.enabled === undefined ? true : patch.enabled;
            }

            repo.updateSource(id, patch);
            if (patch.enabled) repo.setNextSyncAt(id, Date.now());
            onDurableChange('source');
            return sourceView(repo.getSource(id));
        },

        deleteSource(id) {
            const source = repo.getSource(id);
            if (!source) throw new ServiceError(404, '来源不存在');
            if (source.providerType === MANUAL_SOURCE_ID) {
                throw new ServiceError(400, '「稍后阅读」是内置来源，不能删除');
            }
            // 级联删事件/状态/凭据（外键 ON DELETE CASCADE，不是应用层手工清）
            repo.deleteSource(id);
            failures.delete(id);
            onDurableChange('source');
            return { id };
        },

        async testSource(id) {
            const source = repo.getSource(id);
            if (!source) throw new ServiceError(404, '来源不存在');
            if (source.providerType === MANUAL_SOURCE_ID) return { ok: true };
            const adapter = adapterFor(source.providerType);
            const credentials = await decryptCredentials(source);
            if (!credentials) return { ok: false, code: 'auth', error: '尚未配置凭据' };
            return adapter.testConnection({
                credentials,
                externalKey: source.externalKey,
                settings: source.settings
            });
        },

        /**
         * 跑一次同步（调度器与「立即同步」共用）。
         *
         * 契约：成功才推进游标；失败保留旧游标与旧事件，只记错误与下次时刻。
         * **不调用 onDurableChange**——社交事件的摄入是可再取回的、机器节奏的
         * 高频写入，让它触发自动备份会把远端上传变成每轮一次。
         */
        async syncSource(id, { force = false } = {}) {
            const source = repo.getSource(id);
            if (!source) throw new ServiceError(404, '来源不存在');
            if (source.providerType === MANUAL_SOURCE_ID) {
                return { ok: true, skipped: true, inserted: 0 };
            }
            if (!source.enabled && !force) return { ok: true, skipped: true, inserted: 0 };

            const adapter = adapterFor(source.providerType);
            const attemptedAt = Date.now();
            repo.recordAttempt(id, attemptedAt);

            const credentials = await decryptCredentials(source);
            if (!credentials) {
                const n = (failures.get(id) || 0) + 1;
                failures.set(id, n);
                const message = '尚未配置凭据或凭据无法解密';
                repo.recordFailure(id, {
                    code: 'auth', message, at: attemptedAt,
                    nextSyncAt: attemptedAt + backoffFor(source, n)
                });
                return { ok: false, code: 'auth', error: message };
            }

            // 容量上限**先判**：触顶时连第三方请求都不该发出去——白花一次配额，
            // 而且拉回来的东西注定进不了库。
            if (repo.countSourceEvents(id) >= MAX_EVENTS_PER_SOURCE) {
                const message = `已达单来源上限 ${MAX_EVENTS_PER_SOURCE} 条，暂停入库`;
                repo.recordFailure(id, {
                    code: 'capacity', message, at: Date.now(),
                    nextSyncAt: Date.now() + MAX_BACKOFF_MS
                });
                return { ok: false, code: 'capacity', error: message };
            }

            try {
                const result = await adapter.fetchEvents({
                    credentials,
                    externalKey: source.externalKey,
                    settings: source.settings,
                    cursor: source.syncCursor,
                    since: source.lastSuccessAt
                });
                const raw = Array.isArray(result && result.events) ? result.events : [];
                const rows = raw.map(sanitizeEvent).filter(Boolean);
                const skipped = raw.length - rows.length;

                const inserted = rows.length ? repo.insertEvents(id, rows, Date.now()) : 0;
                repo.recordSuccess(id, {
                    cursor: result && result.nextCursor !== undefined
                        ? result.nextCursor
                        : source.syncCursor,
                    at: Date.now(),
                    nextSyncAt: Date.now() + intervalFor(source)
                });
                failures.delete(id);
                return { ok: true, inserted, fetched: rows.length, skipped };
            } catch (err) {
                const code = (err && err.code) || 'http';
                const message = scrubSecrets((err && err.message) || '同步失败');
                const n = (failures.get(id) || 0) + 1;
                failures.set(id, n);
                repo.recordFailure(id, {
                    code, message, at: Date.now(),
                    nextSyncAt: Date.now() + backoffFor(source, n)
                });
                log.warn(`[timeline] 来源「${source.name}」同步失败(${code})：${message}`);
                return { ok: false, code, error: message };
            }
        },

        sweepRetention(now = Date.now()) {
            return repo.sweepRetention(now - SOCIAL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        },

        /** 逻辑快照（不含凭据）。 */
        exportTimeline() {
            return repo.exportAll();
        },

        importTimeline(data) {
            if (!data || typeof data !== 'object'
                || !Array.isArray(data.sources) || !Array.isArray(data.events)
                || !Array.isArray(data.eventState)) {
                throw new ServiceError(400, '时间线备份数据格式不正确');
            }
            const result = repo.importAll(data);
            // 恢复后凭据表是空的（备份不带凭据），手动来源要确保在位
            repo.ensureManualSource();
            failures.clear();
            onDurableChange('restore');
            return result;
        },

        maxManualArticles: MAX_MANUAL_ARTICLES,
        maxEventsPerSource: MAX_EVENTS_PER_SOURCE
    };
}

module.exports = {
    createService,
    ServiceError,
    __test: { clampText, safeHttpUrl, safeTime, sanitizeMetadata, hashKey, scrubSecrets }
};

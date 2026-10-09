'use strict';

/**
 * 时间线的全部 SQL 都在这一个文件里。
 *
 * 上层 service 不拼 SQL、sync 不碰数据库——「谁负责持久化」只有一处答案，
 * 换驱动或改表时不必翻遍调用方。
 */

const crypto = require('crypto');
const { MANUAL_SOURCE_ID, LIMITS } = require('./constants');

/**
 * last_error 存 JSON（见 recordFailure）：界面必须能区分「凭据失效」与
 * 「网络不通」——前者要用户去重新授权，后者等退避重试即可。
 * 旧值或坏值退回纯文本，不让界面因此白屏。
 */
function parseError(raw) {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object' && typeof v.message === 'string') {
            return { code: v.code || 'http', message: v.message };
        }
    } catch {
        // 落到下面按纯文本处理
    }
    return { code: 'http', message: String(raw) };
}

function parseJson(text, fallback) {
    try {
        const value = JSON.parse(text);
        return value === null || value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

/** 游标 = base64url(occurred_at + ':' + id)。不透明化是为了让前端不必理解排序键。 */
function encodeCursor(row) {
    return Buffer.from(`${row.occurred_at}:${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
    if (!cursor) return null;
    try {
        const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
        const at = raw.indexOf(':');
        if (at <= 0) return null;
        const occurredAt = Number(raw.slice(0, at));
        const id = raw.slice(at + 1);
        if (!Number.isFinite(occurredAt) || !id) return null;
        return { occurredAt, id };
    } catch {
        return null;
    }
}

function createRepository(db) {
    const SOURCE_SELECT = `
        SELECT s.*, (c.source_id IS NOT NULL) AS has_credentials
        FROM timeline_sources s
        LEFT JOIN timeline_credentials c ON c.source_id = s.id
    `;

    const S = {
        insertSource: db.prepare(`
            INSERT INTO timeline_sources
                (id, provider_type, name, external_key, settings_json, enabled,
                 sync_cursor, sync_interval_ms, next_sync_at, last_attempt_at,
                 last_success_at, last_error, created_at, updated_at)
            VALUES
                (@id, @providerType, @name, @externalKey, @settingsJson, @enabled,
                 @syncCursor, @syncIntervalMs, @nextSyncAt, @lastAttemptAt,
                 @lastSuccessAt, @lastError, @createdAt, @updatedAt)
        `),
        allSources: db.prepare(`${SOURCE_SELECT} ORDER BY s.created_at ASC, s.id ASC`),
        oneSource: db.prepare(`${SOURCE_SELECT} WHERE s.id = ?`),
        dueSources: db.prepare(`
            ${SOURCE_SELECT}
            WHERE s.enabled = 1
              AND s.provider_type != 'manual'
              AND s.next_sync_at IS NOT NULL
              AND s.next_sync_at <= ?
            ORDER BY s.next_sync_at ASC
            LIMIT ?
        `),
        deleteSource: db.prepare('DELETE FROM timeline_sources WHERE id = ?'),
        updateSourcePatch: db.prepare(`
            UPDATE timeline_sources
            SET name = @name, external_key = @externalKey, settings_json = @settingsJson,
                enabled = @enabled, sync_interval_ms = @syncIntervalMs, updated_at = @updatedAt
            WHERE id = @id
        `),
        setNextSyncAt: db.prepare('UPDATE timeline_sources SET next_sync_at = ? WHERE id = ?'),
        recordAttempt: db.prepare('UPDATE timeline_sources SET last_attempt_at = ? WHERE id = ?'),
        recordSuccess: db.prepare(`
            UPDATE timeline_sources
            SET sync_cursor = @cursor, last_success_at = @at, last_error = NULL,
                next_sync_at = @nextSyncAt, updated_at = @at
            WHERE id = @id
        `),
        recordFailure: db.prepare(`
            UPDATE timeline_sources
            SET last_error = @error, next_sync_at = @nextSyncAt, updated_at = @at
            WHERE id = @id
        `),
        putCredentials: db.prepare(`
            INSERT INTO timeline_credentials (source_id, envelope_json) VALUES (?, ?)
            ON CONFLICT(source_id) DO UPDATE SET envelope_json = excluded.envelope_json
        `),
        getCredentials: db.prepare('SELECT envelope_json FROM timeline_credentials WHERE source_id = ?'),
        clearCredentials: db.prepare('DELETE FROM timeline_credentials WHERE source_id = ?'),
        insertEvent: db.prepare(`
            INSERT OR IGNORE INTO timeline_events
                (id, source_id, event_type, provider_event_id, dedupe_key, occurred_at,
                 ingested_at, author, title, summary, url, metadata_json)
            VALUES
                (@id, @sourceId, @eventType, @providerEventId, @dedupeKey, @occurredAt,
                 @ingestedAt, @author, @title, @summary, @url, @metadataJson)
        `),
        upsertManualEvent: db.prepare(`
            INSERT INTO timeline_events
                (id, source_id, event_type, provider_event_id, dedupe_key, occurred_at,
                 ingested_at, author, title, summary, url, metadata_json)
            VALUES
                (@id, @sourceId, 'article_saved', '', @dedupeKey, @occurredAt,
                 @ingestedAt, @author, @title, @summary, @url, @metadataJson)
            ON CONFLICT(source_id, dedupe_key) DO UPDATE SET
                title = excluded.title,
                summary = excluded.summary,
                url = excluded.url,
                metadata_json = excluded.metadata_json
        `),
        getEventById: db.prepare('SELECT * FROM timeline_events WHERE id = ?'),
        getEventByDedupe: db.prepare(
            'SELECT * FROM timeline_events WHERE source_id = ? AND dedupe_key = ?'),
        countSourceEvents: db.prepare(
            'SELECT COUNT(*) AS c FROM timeline_events WHERE source_id = ?'),
        oldestSourceEvent: db.prepare(`
            SELECT provider_event_id, occurred_at FROM timeline_events
            WHERE source_id = ? ORDER BY occurred_at ASC, id ASC LIMIT 1
        `),
        recentSourceEvents: db.prepare(`
            SELECT id, provider_event_id, metadata_json FROM timeline_events
            WHERE source_id = ? AND provider_event_id != ''
            ORDER BY occurred_at DESC, id DESC LIMIT ?
        `),
        updateEventMetadata: db.prepare(
            'UPDATE timeline_events SET metadata_json = ? WHERE id = ?'),
        countUnread: db.prepare(`
            SELECT COUNT(*) AS c
            FROM timeline_events e
            LEFT JOIN timeline_event_state st ON st.event_id = e.id
            WHERE COALESCE(st.read_at, 0) = 0 AND COALESCE(st.archived_at, 0) = 0
        `),
        sweepRetention: db.prepare(`
            DELETE FROM timeline_events
            WHERE occurred_at < ?
              AND source_id IN (SELECT id FROM timeline_sources WHERE provider_type != 'manual')
        `),
        upsertStateRead: db.prepare(`
            INSERT INTO timeline_event_state (event_id, read_at) VALUES (?, ?)
            ON CONFLICT(event_id) DO UPDATE SET read_at = excluded.read_at
        `),
        upsertStateArchive: db.prepare(`
            INSERT INTO timeline_event_state (event_id, archived_at) VALUES (?, ?)
            ON CONFLICT(event_id) DO UPDATE SET archived_at = excluded.archived_at
        `),
        exportSources: db.prepare(`
            SELECT id, provider_type, name, external_key, settings_json, enabled,
                   sync_cursor, sync_interval_ms, next_sync_at, last_attempt_at,
                   last_success_at, last_error, created_at, updated_at
            FROM timeline_sources ORDER BY created_at ASC, id ASC
        `),
        exportEvents: db.prepare('SELECT * FROM timeline_events ORDER BY occurred_at ASC, id ASC'),
        exportState: db.prepare('SELECT * FROM timeline_event_state ORDER BY event_id ASC'),
        wipeState: db.prepare('DELETE FROM timeline_event_state'),
        wipeEvents: db.prepare('DELETE FROM timeline_events'),
        wipeCredentials: db.prepare('DELETE FROM timeline_credentials'),
        wipeSources: db.prepare('DELETE FROM timeline_sources'),
        insertSourceRaw: db.prepare(`
            INSERT INTO timeline_sources
                (id, provider_type, name, external_key, settings_json, enabled,
                 sync_cursor, sync_interval_ms, next_sync_at, last_attempt_at,
                 last_success_at, last_error, created_at, updated_at)
            VALUES
                (@id, @provider_type, @name, @external_key, @settings_json, @enabled,
                 @sync_cursor, @sync_interval_ms, @next_sync_at, @last_attempt_at,
                 @last_success_at, @last_error, @created_at, @updated_at)
        `),
        insertEventRaw: db.prepare(`
            INSERT INTO timeline_events
                (id, source_id, event_type, provider_event_id, dedupe_key, occurred_at,
                 ingested_at, author, title, summary, url, metadata_json)
            VALUES
                (@id, @source_id, @event_type, @provider_event_id, @dedupe_key, @occurred_at,
                 @ingested_at, @author, @title, @summary, @url, @metadata_json)
        `),
        insertStateRaw: db.prepare(`
            INSERT INTO timeline_event_state (event_id, read_at, archived_at)
            VALUES (@event_id, @read_at, @archived_at)
        `)
    };

    function sourceRow(row) {
        return {
            id: row.id,
            providerType: row.provider_type,
            name: row.name,
            externalKey: row.external_key,
            settings: parseJson(row.settings_json, {}),
            enabled: !!row.enabled,
            syncCursor: row.sync_cursor,
            syncIntervalMs: row.sync_interval_ms,
            nextSyncAt: row.next_sync_at,
            lastAttemptAt: row.last_attempt_at,
            lastSuccessAt: row.last_success_at,
            lastError: parseError(row.last_error),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            hasCredentials: !!row.has_credentials
        };
    }

    function eventRow(row) {
        return {
            id: row.id,
            sourceId: row.source_id,
            eventType: row.event_type,
            providerEventId: row.provider_event_id,
            dedupeKey: row.dedupe_key,
            occurredAt: row.occurred_at,
            ingestedAt: row.ingested_at,
            author: row.author,
            title: row.title,
            summary: row.summary,
            url: row.url,
            metadata: parseJson(row.metadata_json, {}),
            readAt: row.read_at === undefined ? null : row.read_at,
            archivedAt: row.archived_at === undefined ? null : row.archived_at
        };
    }

    return {
        /** 内置手动来源：不存在就建。幂等——服务启动与保存文章前都会调。 */
        ensureManualSource(now = Date.now()) {
            if (S.oneSource.get(MANUAL_SOURCE_ID)) return sourceRow(S.oneSource.get(MANUAL_SOURCE_ID));
            S.insertSource.run({
                id: MANUAL_SOURCE_ID,
                providerType: 'manual',
                name: '稍后阅读',
                externalKey: '',
                settingsJson: '{}',
                enabled: 1,
                syncCursor: null,
                syncIntervalMs: null,
                nextSyncAt: null,
                lastAttemptAt: null,
                lastSuccessAt: null,
                lastError: null,
                createdAt: now,
                updatedAt: now
            });
            return sourceRow(S.oneSource.get(MANUAL_SOURCE_ID));
        },

        getSource(id) {
            const row = S.oneSource.get(id);
            return row ? sourceRow(row) : null;
        },

        listSources() {
            return S.allSources.all().map(sourceRow);
        },

        createSource({ providerType, name, externalKey, settings, syncIntervalMs, nextSyncAt }) {
            const now = Date.now();
            const id = crypto.randomUUID();
            S.insertSource.run({
                id,
                providerType,
                name,
                externalKey,
                settingsJson: JSON.stringify(settings || {}),
                enabled: 1,
                syncCursor: null,
                syncIntervalMs,
                nextSyncAt: nextSyncAt === undefined ? now : nextSyncAt,
                lastAttemptAt: null,
                lastSuccessAt: null,
                lastError: null,
                createdAt: now,
                updatedAt: now
            });
            return sourceRow(S.oneSource.get(id));
        },

        updateSource(id, patch) {
            const current = S.oneSource.get(id);
            if (!current) return null;
            S.updateSourcePatch.run({
                id,
                name: patch.name !== undefined ? patch.name : current.name,
                externalKey: patch.externalKey !== undefined ? patch.externalKey : current.external_key,
                settingsJson: patch.settings !== undefined
                    ? JSON.stringify(patch.settings || {})
                    : current.settings_json,
                enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled,
                syncIntervalMs: patch.syncIntervalMs !== undefined
                    ? patch.syncIntervalMs
                    : current.sync_interval_ms,
                updatedAt: Date.now()
            });
            return sourceRow(S.oneSource.get(id));
        },

        setNextSyncAt(id, at) {
            S.setNextSyncAt.run(at, id);
        },

        deleteSource(id) {
            return S.deleteSource.run(id).changes > 0;
        },

        dueSources(now, limit) {
            return S.dueSources.all(now, limit).map(sourceRow);
        },

        countSourceEvents(sourceId) {
            return S.countSourceEvents.get(sourceId).c;
        },

        /** 该来源最旧的一条事件（回填窗口是否已铺满，看它的时间）。 */
        oldestSourceEvent(sourceId) {
            const row = S.oldestSourceEvent.get(sourceId);
            return row ? { providerEventId: row.provider_event_id, occurredAt: row.occurred_at } : null;
        },

        /**
         * 最近若干条事件里**缺作者名或译文**的那些（补旧账用）。
         * 在 JS 里判定而不是用 SQL 的 LIKE：metadata_json 里的正文字段也可能
         * 恰好含有 `"translation"` 这样的字面量，LIKE 会误判。
         */
        eventsNeedingMeta(sourceId, limit, scan = 200) {
            return S.recentSourceEvents.all(sourceId, scan)
                .filter(row => {
                    const meta = parseJson(row.metadata_json, {});
                    // 缺作者名，或者「既没有译文、也没判定过」
                    // ——没有这个判定标记的话，中文原文会被每轮重复请求
                    return !meta.authorName || (!meta.translation && !meta.translationSettled);
                })
                .slice(0, limit)
                .map(row => ({
                    id: row.id,
                    providerEventId: row.provider_event_id,
                    metadata: parseJson(row.metadata_json, {})
                }));
        },

        updateEventMetadata(id, metadataJson) {
            S.updateEventMetadata.run(metadataJson, id);
        },

        setCredentials(sourceId, envelope) {
            S.putCredentials.run(sourceId, JSON.stringify(envelope));
        },

        getCredentials(sourceId) {
            const row = S.getCredentials.get(sourceId);
            return row ? parseJson(row.envelope_json, null) : null;
        },

        clearCredentials(sourceId) {
            S.clearCredentials.run(sourceId);
        },

        recordAttempt(id, at) {
            S.recordAttempt.run(at, id);
        },

        recordSuccess(id, { cursor, at, nextSyncAt }) {
            S.recordSuccess.run({ id, cursor: cursor === undefined ? null : cursor, at, nextSyncAt });
        },

        recordFailure(id, { code, message, at, nextSyncAt }) {
            // 分类码进 JSON：界面据此给下一步（重新授权 / 稍后重试），
            // 塌缩成一句「同步失败」等于把两种处置方式混成一种。
            S.recordFailure.run({
                id,
                error: message
                    ? JSON.stringify({ code: code || 'http', message: String(message) })
                        .slice(0, LIMITS.lastError)
                    : null,
                at,
                nextSyncAt
            });
        },

        /**
         * 列表查询。筛选在 SQL 里做（不是拉回来再过滤）——分页的正确性依赖
         * WHERE 与 ORDER BY 落在同一份数据集上，否则「加载更早」会漏掉或重发。
         */
        listEvents({ sourceId = null, view = 'all', cursor = null, limit = 20 } = {}) {
            const where = [];
            const params = [];
            if (sourceId) {
                where.push('e.source_id = ?');
                params.push(sourceId);
            }
            if (view === 'unread') {
                where.push('COALESCE(st.read_at, 0) = 0 AND COALESCE(st.archived_at, 0) = 0');
            } else if (view === 'archived') {
                where.push('COALESCE(st.archived_at, 0) != 0');
            } else {
                // 默认视图不显示已归档：归档的语义就是「从时间线收起来」
                where.push('COALESCE(st.archived_at, 0) = 0');
            }
            const decoded = decodeCursor(cursor);
            if (decoded) {
                where.push('(e.occurred_at < ? OR (e.occurred_at = ? AND e.id < ?))');
                params.push(decoded.occurredAt, decoded.occurredAt, decoded.id);
            }

            const sql = `
                SELECT e.*, s.provider_type, s.name AS source_name,
                       st.read_at, st.archived_at
                FROM timeline_events e
                JOIN timeline_sources s ON s.id = e.source_id
                LEFT JOIN timeline_event_state st ON st.event_id = e.id
                WHERE ${where.join(' AND ')}
                ORDER BY e.occurred_at DESC, e.id DESC
                LIMIT ?
            `;
            // 多取一条只用来判断「还有没有」，不返回给调用方
            const rows = db.prepare(sql).all(...params, limit + 1);
            const hasMore = rows.length > limit;
            const page = hasMore ? rows.slice(0, limit) : rows;
            return {
                rows: page.map(r => Object.assign(eventRow(r), {
                    providerType: r.provider_type,
                    sourceName: r.source_name
                })),
                hasMore,
                nextCursor: page.length ? encodeCursor(page[page.length - 1]) : null
            };
        },

        unreadCount() {
            return S.countUnread.get().c;
        },

        insertEvents(sourceId, events, now) {
            const tx = db.transaction(rows => {
                let inserted = 0;
                for (const e of rows) {
                    const info = S.insertEvent.run({
                        id: crypto.randomUUID(),
                        sourceId,
                        eventType: e.eventType,
                        providerEventId: e.providerEventId || '',
                        dedupeKey: e.dedupeKey,
                        occurredAt: e.occurredAt,
                        ingestedAt: now,
                        author: e.author || '',
                        title: e.title,
                        summary: e.summary || '',
                        url: e.url || '',
                        metadataJson: JSON.stringify(e.metadata || {})
                    });
                    if (info.changes > 0) inserted++;
                }
                return inserted;
            });
            return tx(events);
        },

        /** 手动保存：同一 URL 是更新而不是新增（返回落库后的那一行）。 */
        upsertManualEvent(event, now) {
            const tx = db.transaction(e => {
                S.upsertManualEvent.run({
                    id: crypto.randomUUID(),
                    sourceId: MANUAL_SOURCE_ID,
                    dedupeKey: e.dedupeKey,
                    occurredAt: e.occurredAt,
                    ingestedAt: now,
                    author: e.author || '',
                    title: e.title,
                    summary: e.summary || '',
                    url: e.url || '',
                    metadataJson: JSON.stringify(e.metadata || {})
                });
                return S.getEventByDedupe.get(MANUAL_SOURCE_ID, e.dedupeKey);
            });
            return eventRow(tx(event));
        },

        getEvent(id) {
            const row = S.getEventById.get(id);
            return row ? eventRow(row) : null;
        },

        setRead(id, read, at) {
            return S.upsertStateRead.run(id, read ? at : null).changes > 0;
        },

        setArchive(id, archived, at) {
            return S.upsertStateArchive.run(id, archived ? at : null).changes > 0;
        },

        sweepRetention(cutoff) {
            return S.sweepRetention.run(cutoff).changes;
        },

        /** 逻辑快照。**不含凭据**——凭据密文跨安装解不开，导出它只有暴露面。 */
        exportAll() {
            return {
                formatVersion: 1,
                sources: S.exportSources.all(),
                events: S.exportEvents.all(),
                eventState: S.exportState.all()
            };
        },

        importAll(data) {
            const tx = db.transaction(() => {
                S.wipeState.run();
                S.wipeEvents.run();
                S.wipeCredentials.run();
                S.wipeSources.run();
                for (const s of data.sources) S.insertSourceRaw.run(s);
                for (const e of data.events) S.insertEventRaw.run(e);
                for (const st of data.eventState) S.insertStateRaw.run(st);
            });
            tx();
            return { sources: data.sources.length, events: data.events.length };
        }
    };
}

module.exports = { createRepository, encodeCursor, decodeCursor };

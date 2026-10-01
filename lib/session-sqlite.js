'use strict';

/**
 * SessionStore 的 SQLite 存储后端。
 *
 * 与 lib/session.js 里的 `createMemoryBackend()` 实现**同一个接口**（6 个方法），
 * 由 `new SessionStore({ backend })` 注入，SessionStore 与路由层对此无感知。
 * 这样「存哪里」是一个可替换的接缝，而不是散落在会话逻辑里的分支。
 *
 * 记录形状（与内存后端一致）：{ trusted: boolean, expiresAt: number, fp: object, region: string|null }
 */

/**
 * @param {import('better-sqlite3').Database} db 已跑完迁移的库句柄
 */
function createSqliteBackend(db) {
    const selectOne = db.prepare(
        'SELECT trusted, expires_at, fp, region FROM sessions WHERE token = ?'
    );
    const upsert = db.prepare(`
        INSERT INTO sessions (token, trusted, expires_at, fp, region)
        VALUES (@token, @trusted, @expires_at, @fp, @region)
        ON CONFLICT(token) DO UPDATE SET
            trusted    = excluded.trusted,
            expires_at = excluded.expires_at,
            fp         = excluded.fp,
            region     = excluded.region
    `);
    const deleteOne = db.prepare('DELETE FROM sessions WHERE token = ?');
    const deleteAll = db.prepare('DELETE FROM sessions');
    const sweepExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
    const countAll = db.prepare('SELECT COUNT(*) AS n FROM sessions');

    return {
        get(token) {
            const row = selectOne.get(token);
            if (!row) return undefined;
            return {
                trusted: !!row.trusted,
                expiresAt: row.expires_at,
                fp: JSON.parse(row.fp),
                region: row.region
            };
        },

        set(token, session) {
            upsert.run({
                token,
                trusted: session.trusted ? 1 : 0,
                expires_at: session.expiresAt,
                fp: JSON.stringify(session.fp),
                region: session.region === undefined ? null : session.region
            });
        },

        delete(token) {
            deleteOne.run(token);
        },

        /** @returns {number} 被删除的行数，供调用方记账（对应 destroyAll 的返回值） */
        deleteAll() {
            return deleteAll.run().changes;
        },

        sweep(now) {
            sweepExpired.run(now);
        },

        count() {
            return countAll.get().n;
        }
    };
}

module.exports = { createSqliteBackend };

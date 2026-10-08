'use strict';

/**
 * SQLite 连接与迁移。
 *
 * 驱动只在本文件出现：日后要换驱动（如 Node 内置的 `node:sqlite`），只改这里，
 * 上层（lib/session.js、lib/session-sqlite.js、server.js）不受影响。
 *
 * 迁移用 `PRAGMA user_version` 记录台阶：MIGRATIONS 的第 i 项把版本从 i 推到 i+1。
 * 未来模块在数组尾部追加自己的建表语句，**不要改动已发布的项**，否则老库的台阶
 * 会对不上（老库 user_version 已领先，被改动的那一步不会再执行）。
 */

const fs = require('fs');
const Database = require('better-sqlite3');

// 第 i 项 = 从版本 i 升到 i+1。每步在事务内执行，失败即回滚且不推进 user_version。
const MIGRATIONS = [
    // v0 → v1：管理端会话。会话由进程内 Map 迁到此处后，重启/升级不再清空登录态。
    (db) => {
        db.exec(`
            CREATE TABLE sessions (
                token      TEXT PRIMARY KEY,
                trusted    INTEGER NOT NULL DEFAULT 0,
                expires_at INTEGER NOT NULL,
                fp         TEXT NOT NULL,
                region     TEXT
            );
            CREATE INDEX idx_sessions_expires ON sessions(expires_at);
        `);
    },
    // v1 → v2：模块平台的采集值缓存。采集是请求驱动的（前端轮询打到
    // /api/modules/metrics 才采），没有后台采集定时器，所以这里存的是
    // "上次采到的值"而不是采集本身——重启后读不到就等下一轮。
    (db) => {
        db.exec(`
            CREATE TABLE module_cache (
                key        TEXT PRIMARY KEY,
                payload    TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
    },
    // v2 → v3：推送模式下各机器自己上报的指标。
    // 与 module_cache 分开：那张表是单键 'local'，存"上次采到的值"
    //（含聚合后的 servers 数组）；这里按 server_id 一行一行存"某台机器的
    // 单份上报"。两者生命周期不同，共用一个 key 会让一次推送覆写掉本机
    // 和其它拉取机器的结果。
    (db) => {
        db.exec(`
            CREATE TABLE agent_metrics (
                server_id   TEXT PRIMARY KEY,
                payload     TEXT NOT NULL,
                received_at INTEGER NOT NULL
            );
        `);
    },
    // v3 → v4：备忘录模块的私有数据。独立成表而不是进 config.json：
    // 后者会经 toPublicConfig 整份发给匿名访客。备忘录随本库走
    // sylph.sh 的升级备份，但不进 WebDAV 跨设备备份集（与
    // sessions/module_cache/agent_metrics 同列）——服务器本身是
    // 多端同步的真相源，跨设备靠服务器而非备份。
    (db) => {
        db.exec(`
            CREATE TABLE memos (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL,
                body       TEXT NOT NULL DEFAULT '',
                pinned     INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
    },
    // v4 → v5：Special Line 时间线模块。
    //
    // 与 memos 同理独立成表，不进 config.json——后者会经 toPublicConfig
    // 整份发给匿名访客。
    //
    // 去重落在**数据库层**（UNIQUE(source_id, dedupe_key)）而不是 service 里的
    // 一次查重：摄入是「同一批事件可能被重复拉回来」的场景，唯一约束 + INSERT
    // OR IGNORE 是原子且幂等的；先查后插在两次同步交错时会漏。
    //
    // 用户状态（已读/归档）单独一张表：重复同步会更新来源内容，但绝不能因此
    // 把用户标过的已读/归档重置回默认。
    //
    // 凭据单独一张表且**永不回传 API**（接口只回 hasCredentials）。它随本库走
    // sylph.sh 的升级备份，但不进 WebDAV 导出（见 lib/webdav-backup.js 的注释：
    // 密钥派生自管理员密码哈希，跨安装解不开，export 它只增加暴露面）。
    (db) => {
        db.exec(`
            CREATE TABLE timeline_sources (
                id               TEXT PRIMARY KEY,
                provider_type    TEXT NOT NULL,
                name             TEXT NOT NULL,
                external_key     TEXT NOT NULL DEFAULT '',
                settings_json    TEXT NOT NULL DEFAULT '{}',
                enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                sync_cursor      TEXT,
                sync_interval_ms INTEGER,
                next_sync_at     INTEGER,
                last_attempt_at  INTEGER,
                last_success_at  INTEGER,
                last_error       TEXT,
                created_at       INTEGER NOT NULL,
                updated_at       INTEGER NOT NULL
            );
            CREATE INDEX idx_timeline_sources_due ON timeline_sources(enabled, next_sync_at);

            CREATE TABLE timeline_credentials (
                source_id     TEXT PRIMARY KEY REFERENCES timeline_sources(id) ON DELETE CASCADE,
                envelope_json TEXT NOT NULL
            );

            CREATE TABLE timeline_events (
                id                TEXT PRIMARY KEY,
                source_id         TEXT NOT NULL REFERENCES timeline_sources(id) ON DELETE CASCADE,
                event_type        TEXT NOT NULL,
                provider_event_id TEXT NOT NULL DEFAULT '',
                dedupe_key        TEXT NOT NULL,
                occurred_at       INTEGER NOT NULL,
                ingested_at       INTEGER NOT NULL,
                author            TEXT NOT NULL DEFAULT '',
                title             TEXT NOT NULL,
                summary           TEXT NOT NULL DEFAULT '',
                url               TEXT NOT NULL DEFAULT '',
                metadata_json     TEXT NOT NULL DEFAULT '{}',
                UNIQUE (source_id, dedupe_key)
            );
            CREATE INDEX idx_timeline_events_time ON timeline_events(occurred_at DESC, id DESC);
            CREATE INDEX idx_timeline_events_source_time
                ON timeline_events(source_id, occurred_at DESC, id DESC);

            CREATE TABLE timeline_event_state (
                event_id    TEXT PRIMARY KEY REFERENCES timeline_events(id) ON DELETE CASCADE,
                read_at     INTEGER,
                archived_at INTEGER
            );
        `);
    }
];

function runMigrations(db) {
    const current = db.pragma('user_version', { simple: true });
    for (let version = current; version < MIGRATIONS.length; version++) {
        const step = MIGRATIONS[version];
        db.transaction(() => {
            step(db);
            db.pragma(`user_version = ${version + 1}`);
        })();
    }
}

/**
 * 库文件含会话令牌，收紧到 0600（与 .admin-password.json 同级）。
 * WAL/SHM 边车由 SQLite 在首次写入时创建——迁移已经写过一次，故此刻通常已存在；
 * 存在就一并收紧。它们会在干净关闭时被合并回主文件。
 */
function restrictPermissions(file) {
    if (file === ':memory:') return;
    for (const target of [file, `${file}-wal`, `${file}-shm`]) {
        try {
            fs.chmodSync(target, 0o600);
        } catch {
            // 边车尚未创建时忽略；主文件在本函数前已由 new Database 建好
        }
    }
}

/**
 * 打开（不存在则创建）数据库并跑完迁移。
 *
 * WAL 是必需的：会话在每次请求上滑动续期都会写一行，回滚日志模式下并发读写会互相阻塞。
 * synchronous=NORMAL 在 WAL 下已足够（崩溃最多丢最后几次提交，不会损坏库）。
 *
 * @param {string} file 绝对路径；也支持 `':memory:'`
 * @returns {import('better-sqlite3').Database}
 */
function openDatabase(file) {
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    restrictPermissions(file);
    return db;
}

module.exports = { openDatabase, MIGRATIONS };

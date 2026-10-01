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
    // v1 → v2：模块平台的采集值缓存。采集在后台定时器里做，读取走特权端点，
    // 所以这里存的是"上次采到的值"而不是采集本身——重启后读不到就等下一轮。
    (db) => {
        db.exec(`
            CREATE TABLE module_cache (
                key        TEXT PRIMARY KEY,
                payload    TEXT NOT NULL,
                updated_at INTEGER NOT NULL
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

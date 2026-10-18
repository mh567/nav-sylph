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
    },
    // v5 → v6：事件状态从「已读 + 归档」改为「收藏 + 归档」。
    //
    // 语义差别就在清理上：**收藏过的 `sweepRetention` 不删**（这才是「长期保存」），
    // 归档**不**豁免——归档仍然只是「从默认视图收起」，到期照样删。
    //
    // 已读功能整条去掉，所以 `read_at` 直接删列（功能都不要了，迁移旧值没有意义）。
    // ⚠️ 老备份里的 `read_at` 在导入时被忽略（`repository.importAll` 把缺失的键补成
    // null），但**新备份不能被旧版本还原**——旧版会因找不到 `read_at` 列而失败。
    // DROP COLUMN 需要 SQLite ≥ 3.35；better-sqlite3 13 自带 3.5x（实测 3.53.4）。
    (db) => {
        db.exec(`
            ALTER TABLE timeline_event_state ADD COLUMN favorited_at INTEGER;
            ALTER TABLE timeline_event_state DROP COLUMN read_at;
        `);
    },
    // 升级撤销旧管理会话，并持久化限时改密凭据的权限。
    (db) => {
        db.exec(`DELETE FROM sessions;
            ALTER TABLE sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'admin';`);
    },
    (db) => {
        db.exec(`CREATE TABLE navigation_documents (
            id TEXT PRIMARY KEY, config_json TEXT NOT NULL, revision INTEGER NOT NULL
        );
        CREATE TABLE navigation_receipts (
            domain TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL,
            response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY (domain, operation_id)
        );`);
    },
    // v8 → v9：普通访问者的口令云端空间。
    //
    // 这是第一组**不属于管理员**的数据：表里存的是访客自己的导航配置，凭据是
    // 访客自设的口令，与管理员密码、会话、收藏都无关。三张表各自的分工不要混：
    //
    //  - `sync_spaces.proof_id` 存的是「连接证明」的哈希，**不是口令本身**。
    //    口令在浏览器里用 Web Crypto 派生（见 lib/sync-store.js 顶部的派生约定），
    //    服务端只见证明、再哈希一次作为定位键——库里既没有口令也没有可直接当
    //    凭据用的值。
    //  - `sync_devices.token_hash` 同理：设备令牌明文只在签发响应里出现一次，
    //    此后只有哈希。列名叫 token_hash 而不是 token，就是提醒读的人这里没有明文。
    //  - `sync_invites` 一次性、48 小时有效。`used_at` 只在**创建空间**时写入；
    //    连接既有空间不消耗邀请码。竞争创建靠单事务 + `UNIQUE(proof_id)` +
    //    「UPDATE ... WHERE used_at IS NULL」的 changes 断言拦住，不靠先查后写。
    //  - `sync_receipts.material` 是加密后的签发材料（含设备令牌），用于响应丢失后
    //    同 `operationId` 重试时返回同一份材料。密钥随管理员密码哈希，改密码会让
    //    旧回执解不开——改密流程会直接清空本表（回执只活 24 小时，清掉不影响
    //    已经连接的设备令牌）。
    //
    // 四张表随 nav-sylph.db 走 sylph.sh 的升级备份（该脚本已备整个 db 文件），
    // 不进 WebDAV 备份集——按设计文档 §8，普通云端空间不在 WebDAV 范围内。
    (db) => {
        db.exec(`
            CREATE TABLE sync_spaces (
                id           TEXT PRIMARY KEY,
                proof_id     TEXT NOT NULL UNIQUE,
                generation   INTEGER NOT NULL DEFAULT 1,
                revision     INTEGER NOT NULL DEFAULT 1,
                config_json  TEXT NOT NULL,
                modules_json TEXT NOT NULL DEFAULT '{}',
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL,
                disabled     INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
            );
            CREATE INDEX idx_sync_spaces_updated ON sync_spaces(updated_at);

            CREATE TABLE sync_devices (
                token_hash   TEXT PRIMARY KEY,
                space_id     TEXT NOT NULL REFERENCES sync_spaces(id) ON DELETE CASCADE,
                generation   INTEGER NOT NULL,
                created_at   INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                revoked      INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
            );
            CREATE INDEX idx_sync_devices_space ON sync_devices(space_id);

            CREATE TABLE sync_invites (
                id         TEXT PRIMARY KEY,
                code_hash  TEXT NOT NULL UNIQUE,
                hint       TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                used_at    INTEGER,
                used_space TEXT,
                revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
            );
            CREATE INDEX idx_sync_invites_expires ON sync_invites(expires_at);

            CREATE TABLE sync_receipts (
                scope        TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                digest       TEXT NOT NULL,
                material     TEXT NOT NULL,
                created_at   INTEGER NOT NULL,
                PRIMARY KEY (scope, operation_id)
            );
        `);
    },
    // v9 → v10：空间删除后的「墓碑」。
    //
    // 删除云端空间**不真删那一行**，而是留一个墓碑。三个理由，缺一不可：
    //   1. 客户端要能把「空间已被删除」与「令牌无效」分开。真删行的话设备行会
    //      跟着级联消失，之后所有请求都是同一种 401，用户只会看到「连接已失效」，
    //      而设计文档明确要求这两者分别处理（删除就断开、令牌过期要重新输口令）。
    //   2. 设备行与空间行的外键保持完整：真删行要么留孤儿设备行，要么级联删掉，
    //      而级联之后第 1 条就做不到了。
    //   3. 同口令重建时要能算出「新代次 = 旧代次 + 1」（设计要求「使用新代次和
    //      新令牌」）——墓碑是唯一还记得旧代次的地方。
    //
    // 口令槽怎么释放：删除时把 `proof_id` 改写成 `'gone:' + <空间 id>`（每个墓碑
    // 天然唯一），原口令哈希挪进 `deleted_proof_id`。于是
    // ① 活动空间的精确查找（`WHERE proof_id = ?`，值是纯哈希）永远碰不到墓碑；
    // ② 同一个口令可以反复「建 → 删 → 再建」（UNIQUE 不再冲突）；
    // ③ 重建时按 `WHERE deleted_proof_id = ?` 查到旧代次，取最高的那个 +1。
    // ⚠️ 前缀不会误伤：`PROOF_PATTERN` 限定口令证明是 64 位十六进制，
    // 正常的 proof_id 里**不可能**出现冒号——两种取值天然不相交。
    //
    // ⚠️ 第一版把口令哈希直接放在 `proof_id` 的前缀里（`'gone:' + hash`），
    // **同一个口令删第二次就撞 UNIQUE**（两个墓碑的 proof_id 完全相同），
    // 症状是删除接口 500。真实浏览器验收里「建→删→重建→再删」正好走到第二步。
    // 所以唯一的部分必须来自空间 id，不能来自口令。
    //
    // （也想过把 proof_id 置 NULL：实测被 v9 的 `NOT NULL` 挡住——SQLite 的 UNIQUE
    // 允许多个 NULL，但 NOT NULL 不允许；改约束要在迁移里重建整张表，代价不值得。）
    //
    // 墓碑行不清理（体积与时间字段仍在）——清理与配额归 #10；本轮只保证读路径
    // 永不返回墓碑内容（`deleted = 1` 一律 410）。
    (db) => {
        db.exec(`
            ALTER TABLE sync_spaces ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE sync_spaces ADD COLUMN deleted_proof_id TEXT;
            CREATE INDEX idx_sync_spaces_deleted ON sync_spaces(deleted_proof_id);
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

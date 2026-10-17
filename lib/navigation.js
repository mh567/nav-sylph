'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validate, publicConfig, FIELDS } = require('../public/navigation-schema');
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, max = 200) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function snapshot(root, databaseFile = path.join(root, 'nav-sylph.db'), passwordFile = path.join(root, '.admin-password.json')) {
    const target = path.join(root, '.navigation-upgrade-snapshot');
    if (fs.existsSync(target)) return;
    const temp = target + '.tmp';
    fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { mode: 0o700 });
    const files = new Map();
    for (const name of fs.readdirSync(root)) {
        if (name.endsWith('.json') || name === '.env' || /^nav-sylph\.db(?:-wal|-shm)?$/.test(name)) {
            const source = path.join(root, name);
            if (fs.statSync(source).isFile()) files.set(source, name);
        }
    }
    for (const [source, name] of [[databaseFile, 'database.sqlite'], [databaseFile + '-wal', 'database.sqlite-wal'], [databaseFile + '-shm', 'database.sqlite-shm'], [passwordFile, 'admin-password.json']]) {
        if (fs.existsSync(source) && !files.has(source)) files.set(source, name);
    }
    for (const [source, name] of files) {
        fs.copyFileSync(source, path.join(temp, name)); fs.chmodSync(path.join(temp, name), 0o600);
    }
    fs.writeFileSync(path.join(temp, 'RESTORE.json'), JSON.stringify({ files: [...files].map(([source, name]) => ({ source, snapshot: name })), databaseFile, databaseExisted: fs.existsSync(databaseFile) }, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(temp, 'RESTORE.txt'), '停止服务后，按 RESTORE.json 的 files 映射将快照文件恢复至原路径，并使用升级前程序启动。先删除目标数据库的 -wal 和 -shm，再恢复快照中的数据库及边车。databaseExisted 为 false 时删除升级后新建的数据库。禁止旧程序直接操作升级后的数据库。\n', { mode: 0o600 });
    fs.renameSync(temp, target);
}
function createNavigation(db, original, defaults) {
    if (!db.prepare('SELECT 1 FROM navigation_documents LIMIT 1').get()) {
        const published = validate(publicConfig({ ...defaults, ...original, categories: original.categories ?? original.bookmarks ?? defaults.categories }));
        db.transaction(() => {
            const insert = db.prepare('INSERT INTO navigation_documents (id, config_json, revision) VALUES (?, ?, 1)');
            insert.run('admin', JSON.stringify(original));
            insert.run('draft', JSON.stringify(published));
            insert.run('published', JSON.stringify(published));
        })();
    }
    function read(id) {
        const row = db.prepare('SELECT * FROM navigation_documents WHERE id = ?').get(id);
        return { config: JSON.parse(row.config_json), revision: row.revision };
    }
    function write(id, body) {
        if (!Number.isSafeInteger(body.revision) || !text(body.operationId, 100)) fail('页面版本不兼容，请刷新后重试', 409);
        const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        return db.transaction(() => {
            db.prepare('DELETE FROM navigation_receipts WHERE created_at < ?').run(Date.now() - 86400000);
            const receipt = db.prepare('SELECT * FROM navigation_receipts WHERE domain = ? AND operation_id = ?').get(id, body.operationId);
            if (receipt) {
                if (receipt.digest !== digest) fail('同一操作标识不能提交不同内容', 409);
                return JSON.parse(receipt.response_json);
            }
            const current = read(id);
            if (id === 'published') {
                const draft = read('draft');
                if (draft.revision !== body.revision || current.revision !== body.publishedRevision) fail('默认首页已改变，请重新读取后发布', 409);
                validate(draft.config);
                body = { ...body, config: draft.config };
            } else if (current.revision !== body.revision) fail('配置已改变，请刷新后处理冲突', 409);
            if (id === 'admin') {
                if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) fail('配置必须是对象');
                const allowed = [...FIELDS, 'privacyMode'];
                // 旧扩展数据只从当前服务端保留，客户端不能新增或更改这些字段。
                const extra = Object.keys(body.config || {}).filter(k => !allowed.includes(k));
                if (extra.some(k => JSON.stringify(body.config[k]) !== JSON.stringify(current.config[k]))) fail('不允许修改私人扩展字段');
                if (body.config?.privacyMode !== undefined && typeof body.config.privacyMode !== 'boolean') fail('隐私设置无效');
                validate(publicConfig(body.config));
                body = { ...body, config: { ...current.config, ...body.config } };
            } else validate(body.config);
            const revision = current.revision + 1;
            db.prepare('UPDATE navigation_documents SET config_json = ?, revision = ? WHERE id = ?').run(JSON.stringify(body.config), revision, id);
            const result = { success: true, revision };
            db.prepare('INSERT INTO navigation_receipts VALUES (?, ?, ?, ?, ?)').run(id, body.operationId, digest, JSON.stringify(result), Date.now());
            return result;
        })();
    }
    return { read, write };
}
module.exports = { snapshot, createNavigation };

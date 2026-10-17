'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const FIELDS = ['theme', 'showBookmarkIcons', 'searchEngine', 'searchEngines', 'categories'];
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, max = 200) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function url(value) {
    if (!text(value, 4096)) return false;
    try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
}
function keys(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('配置包含不允许的字段');
}
function unique(items, max) {
    if (!Array.isArray(items) || items.length > max || items.some(i => !i || !text(i.id, 100)) || new Set(items.map(i => i.id)).size !== items.length) fail('配置数量或标识无效');
}
function validate(value) {
    keys(value, FIELDS);
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) fail('配置超过 1 MiB');
    if (!['auto', 'light', 'dark'].includes(value.theme) || typeof value.showBookmarkIcons !== 'boolean') fail('显示偏好无效');
    unique(value.searchEngines, 50);
    if (!value.searchEngines.length || !value.searchEngines.some(e => e.id === value.searchEngine)) fail('请选择有效搜索引擎');
    for (const e of value.searchEngines) {
        keys(e, ['id', 'name', 'url']);
        if (!text(e.name) || !url(e.url) || /[{}]/.test(e.url)) fail('搜索引擎须使用 HTTP/HTTPS 关键词前缀地址');
    }
    unique(value.categories, 100); let count = 0; const ids = new Set();
    for (const c of value.categories) {
        keys(c, ['id', 'name', 'bookmarks']);
        if (!text(c.name)) fail('分类名称无效');
        unique(c.bookmarks, 2000); count += c.bookmarks.length;
        for (const b of c.bookmarks) {
            keys(b, ['id', 'title', 'url']);
            if (!text(b.title) || !url(b.url) || ids.has(b.id)) fail('导航链接无效');
            ids.add(b.id);
        }
    }
    if (count > 2000) fail('导航链接超过 2000 条');
    return value;
}
function publicConfig(value) {
    // 旧公开过滤只移除 privacyMode；再用封闭白名单隔离所有私人字段。
    const { privacyMode, ...legacy } = value;
    return Object.fromEntries(FIELDS.map(k => [k, legacy[k]]));
}
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

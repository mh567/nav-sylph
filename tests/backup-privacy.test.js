const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');
const backupSource = fs.readFileSync(path.join(__dirname, '..', 'lib/webdav-backup.js'), 'utf8');
const backupModule = { exports: {} };
vm.runInNewContext(backupSource, {
    module: backupModule,
    require: name => name === 'webdav' ? { createClient: () => {} } : require(name)
});
const { WebDAVBackup } = backupModule.exports;

// server.js starts the HTTP listener when loaded, so exercise its serializer seam directly.
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = server.indexOf('function parseBookmarkHtml(');
const end = server.indexOf("app.get('/api/favorites'", begin);
assert.ok(begin >= 0 && end > begin, 'bookmark serializer functions are present');
const { parseBookmarkHtml, generateBookmarkHtml } = vm.runInNewContext(
    `${server.slice(begin, end)}; ({ parseBookmarkHtml, generateBookmarkHtml })`
);

test('backup HTML round trip preserves private favorites', () => {
    const favorites = [
        { title: '个人入口', url: 'https://example.test/private', category: '个人', private: true },
        { title: '公开入口', url: 'https://example.test/public', category: '个人', private: false }
    ];
    const restored = parseBookmarkHtml(generateBookmarkHtml(favorites));
    assert.equal(restored.length, 2);
    assert.equal(restored[0].private, true);
    assert.equal(restored[1].private, false);
});

test('ordinary browser bookmark HTML stays public', () => {
    const html = '<DL><p>\n<DT><A HREF="https://example.test/public">公开入口</A>\n</DL><p>';
    const restored = parseBookmarkHtml(html);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].private, false);
});

test('an unchanged legacy backup is refreshed with privacy metadata', async () => {
    const favorites = [{ title: '个人入口', url: 'https://example.test/private', category: '个人', private: true }];
    const configData = { theme: 'light' };
    const legacyChecksum = crypto.createHash('sha256').update(JSON.stringify(favorites)).digest('hex');
    const configChecksum = crypto.createHash('sha256').update(JSON.stringify(configData)).digest('hex');
    const files = new Map();
    const client = {
        getDirectoryContents: async () => [],
        putFileContents: async (name, content) => { files.set(name, content); },
        getFileContents: async name => files.get(name)
    };
    const backup = new WebDAVBackup('/unused', 'unused');
    backup.config = { remotePath: '/backups/', lastConfigChecksum: configChecksum, lastFavoritesChecksum: legacyChecksum };
    backup.createClient = () => client;
    backup.saveConfig = async data => { backup.config = { ...backup.config, ...data }; };
    const result = await backup.createBackup(configData, { favorites }, '1.4.0', generateBookmarkHtml);
    assert.equal(result.noChanges, undefined);
    const html = files.get(`/backups/${result.bookmarksFilename}`);
    assert.match(html, /DATA-SYLPH-PRIVATE="1"/);
    const restored = await backup.restoreBackup({ bookmarksFile: result.bookmarksFilename });
    assert.equal(parseBookmarkHtml(restored.data.bookmarksHtml)[0].private, true);
    const repeat = await backup.createBackup(configData, { favorites }, '1.4.0', generateBookmarkHtml);
    assert.equal(repeat.noChanges, true);
});

// ========== 私有文件的权限 ==========
//
// 修复前：这些文件由应用首次启动时创建，而 sylph.sh 的 chmod 跑在它们存在之前，
// `[ -f ... ] && chmod` 直接跳过——实测全新安装后密码哈希与私密收藏都是 644，
// 只有本次新增的会话库是 600。这里钉住「谁负责收紧」。

/** 去注释后再匹配，避免注释里的字样把形状断言骗过。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

test('应用自己创建/写入的私有文件立即收紧为 600', () => {
    const code = stripComments(server);
    assert.match(code, /const PRIVATE_FILES = \[CONFIG_FILE, FAVORITES_FILE, PASSWORD_FILE, WEBDAV_CONFIG_FILE\]/,
        '密码、收藏、配置与 WebDAV 配置都承载私有数据');
    assert.match(code, /async function writeJSON\(file, data\) \{[\s\S]*?fs\.chmod\(file, 0o600\)/,
        '写入后必须立即收紧，不留 644 窗口');
    assert.match(code, /await restrictPrivateFileModes\(\)/,
        '启动时要兜底校正既有安装中仍是 644 的老文件');
});

test('WebDAV 配置保存后同样收紧为 600', () => {
    // 该文件由 lib/webdav-backup.js 直接写，不走 server.js 的 writeJSON。
    const code = stripComments(backupSource);
    assert.match(code, /saveConfig\(newConfig\) \{[\s\S]*?fs\.chmod\(this\.configPath, 0o600\)/,
        '里面存着加密后的 WebDAV 密码');
});

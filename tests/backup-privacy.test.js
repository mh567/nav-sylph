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

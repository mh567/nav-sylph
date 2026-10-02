const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');
const backupSource = fs.readFileSync(path.join(__dirname, '..', 'lib/webdav-backup.js'), 'utf8');
const backupModule = { exports: {} };
// lib/webdav-backup.js 现在 require('./credentials')。vm 里的 require 要按
// **被测文件所在目录**解析相对路径——直接透传给外层 require 会从 tests/ 找，
// 报 MODULE_NOT_FOUND。早先只桩掉 'webdav'，相对路径就漏在这里。
const LIB = path.join(__dirname, '..', 'lib');
vm.runInNewContext(backupSource, {
    module: backupModule,
    require: name => {
        if (name === 'webdav') return { createClient: () => {} };
        if (name.startsWith('.')) return require(path.join(LIB, name));
        return require(name);
    }
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
    assert.match(code, /const PRIVATE_FILES = \[CONFIG_FILE, FAVORITES_FILE, PASSWORD_FILE, WEBDAV_CONFIG_FILE, MODULES_FILE\]/,
        '密码、收藏、配置、WebDAV 配置与模块平台配置都承载私有数据');
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

// ========== 凭据加密 ==========
// 凭据加密的归属测试。原先的实现在 lib/webdav-backup.js 里，模块 token
// 要复用就得抄一份——抄出来的两份会各自漂移，改密码时也只重加密其中一份。

const { encrypt, decrypt, reencrypt, isEnvelope } =
    require(path.join(__dirname, '..', 'lib', 'credentials.js'));

const HASH_OLD = '$2b$10$oldhashforunit';
const HASH_NEW = '$2b$10$newhashforunit';

test('加密后的凭据能解开，且同一个值两次加密结果不同', () => {
    const secret = 'agent-token-xyz';
    const first = encrypt(secret, HASH_OLD, 'modules');
    const second = encrypt(secret, HASH_OLD, 'modules');

    assert.equal(decrypt(first, HASH_OLD, 'modules'), secret);
    assert.equal(isEnvelope(first), true, '形状可识别');
    assert.notEqual(first.iv, second.iv, 'IV 必须每次随机——相同 IV 泄露明文关系');
    assert.notEqual(first.data, second.data, '相同密钥与明文也必须产出不同密文');
});

test('用途隔离：webdav 的密钥解不开 modules 的密文', () => {
    // 同一把密钥跨用途会让一处泄露同时丢掉两个凭据，所以后缀必须不同。
    const envelope = encrypt('secret', HASH_OLD, 'modules');
    assert.throws(() => decrypt(envelope, HASH_OLD, 'webdav'), /解密失败/,
        '跨用途不可解');
    assert.equal(decrypt(envelope, HASH_OLD, 'modules'), 'secret', '本用途可解');
});

test('换密码后旧密文立刻失效，不存在「两个密码都能解」', () => {
    const before = encrypt('secret', HASH_OLD, 'webdav');
    assert.equal(decrypt(before, HASH_OLD, 'webdav'), 'secret');
    assert.throws(() => decrypt(before, HASH_NEW, 'webdav'), /解密失败/,
        '新密码不能解旧密码的密文');
});

test('reencrypt 用旧密码解开、新密码加密，明文不落盘', () => {
    const before = encrypt('my-dav-secret', HASH_OLD, 'webdav');
    const after = reencrypt(before, HASH_OLD, HASH_NEW, 'webdav');

    assert.equal(decrypt(after, HASH_NEW, 'webdav'), 'my-dav-secret', '新密码可解');
    assert.throws(() => decrypt(after, HASH_OLD, 'webdav'), /解密失败/, '旧密码已失效');
    assert.doesNotMatch(JSON.stringify(after), /my-dav-secret/, '结果里没有明文');
});

test('畸形或被篡改的密文抛错，不返回部分明文', () => {
    const envelope = encrypt('secret', HASH_OLD, 'modules');
    assert.throws(() => decrypt(null, HASH_OLD, 'modules'), /格式不正确/);
    assert.throws(() => decrypt({}, HASH_OLD, 'modules'), /格式不正确/);
    assert.throws(() => decrypt({ iv: 'a', data: 'b' }, HASH_OLD, 'modules'), /格式不正确/);

    // 篡改 data 会让 GCM 认证失败
    const tampered = { ...envelope, data: envelope.data.replace(/^../, 'ff') };
    assert.throws(() => decrypt(tampered, HASH_OLD, 'modules'), /解密失败/);
});

test('缺少密码哈希时明确报错，而不是派生出错误的密钥', () => {
    // 静默用空串派生会产出一把「能加密但永不对应任何密码」的密钥，
    // 症状是凭据写进去就再也解不开，且没有任何线索。
    assert.throws(() => encrypt('x', '', 'modules'), /缺少密码哈希/);
    assert.throws(() => encrypt('x', null, 'modules'), /缺少密码哈希/);
    assert.throws(() => encrypt('x', HASH_OLD, 'unknown-context'), /未知的密钥用途/);
    assert.throws(() => encrypt('', HASH_OLD, 'modules'), /待加密内容为空/);
});

test('改密码时重新加密 WebDAV 与模块凭据，且先算完再落盘', () => {
    // 修复前：改密码直接覆盖 .admin-password.json，而 WebDAV 密码是用旧
    // 密码哈希派生的密钥加密的——改完再也解不开，且无任何提示。
    const code = stripComments(server);

    // 1) 端点必须调用重加密，且在写密码文件之前
    const route = code.slice(code.indexOf("app.post('/api/change-password'"),
        code.indexOf("app.get('/api/health'"));
    const reencryptAt = route.indexOf('reencryptCredentials(');
    const writeAt = route.indexOf('writeJSON(PASSWORD_FILE');
    assert.ok(reencryptAt >= 0, '改密码端点调用 reencryptCredentials');
    assert.ok(writeAt >= 0, '改密码端点写密码文件');
    assert.ok(reencryptAt < writeAt,
        '必须先重加密凭据再写密码文件——反过来会让新密码配旧密文，全部失效');

    // 光「调用存在」不够：把调用包进 `if (false) {` 文本仍在，位置关系也照旧，
    // 断言照样全绿，而改密码后凭据照样全部失效（这正是修复前的行为）。
    // 所以要确认调用**可达**——它不在一个恒假的条件里。
    const before = route.slice(0, reencryptAt);
    const guard = before.slice(before.lastIndexOf('if (') );
    assert.doesNotMatch(guard, /if \((false|0|null|undefined)\)/,
        '重加密调用不得被恒假条件包住——那等于没有调用');
    // 条件只能是「旧密码哈希存在」这一类真判断
    assert.match(before, /if \(oldHash\)/, '重加密的守卫是旧密码哈希存在');

    // 2) 两者都要覆盖
    const fn = code.slice(code.indexOf('async function reencryptCredentials('),
        code.indexOf("app.post('/api/change-password'"));
    assert.match(fn, /WEBDAV_CONFIG_FILE/, 'WebDAV 密码一并重加密');
    assert.match(fn, /MODULES_FILE/, '模块 agent token 一并重加密');
    assert.match(fn, /'modules'/, '模块用 modules 用途的密钥');
    assert.match(fn, /'webdav'/, 'WebDAV 用 webdav 用途的密钥');

    // 3) 失败时密码也不能写。
    // 断言范围必须**只覆盖 catch 块**：早先用「catch 之后不许出现 writeJSON」
    // 扫整段路由，扫过 catch 里的 return 落到了成功路径上那次正当写入，
    // 断言恒假。正确做法是确认 catch 以 return 收尾——
    // return 之后那一次写入属于成功路径，本就应该发生。
    const catchAt = route.indexOf('reencryptCredentials(');
    const catchStart = route.indexOf('catch (err) {', catchAt);
    assert.ok(catchStart > catchAt, '重加密有独立的失败处理');
    const catchEnd = route.indexOf('\n            }', catchStart);
    assert.ok(catchEnd > catchStart, 'catch 块的结束位置可定位');
    const catchBody = route.slice(catchStart, catchEnd);

    assert.match(catchBody, /return res\.status\(500\)/, '重加密失败要中止并返回错误');
    assert.doesNotMatch(catchBody, /writeJSON\(PASSWORD_FILE/,
        'catch 块内不得写密码文件——密码改了而凭据没迁移是不可恢复的状态');
});

test('凭据只存在于内存，落盘的永远是密文', () => {
    // 端点把重加密结果回给前端，让用户知道哪些需要重新填——
    // 但绝不能回显明文或整个信封。
    const code = stripComments(server);
    const route = code.slice(code.indexOf("app.post('/api/change-password'"),
        code.indexOf("app.get('/api/health'"));
    assert.match(route, /credentials:\s*migration/, '回传迁移结果');
    assert.doesNotMatch(route, /plain/, '响应里不出现解密出的明文变量');
    assert.doesNotMatch(route, /console\.log\([^)]*plain/, '明文不进日志');
});

test('模块配置的 token 字段不被归一化接受（明文不入盘）', () => {
    // normalizeServer 的白名单里没有 token：提交明文 token 会被丢弃，
    // 必须走服务端的加密路径。
    const start = server.indexOf('function normalizeServer(');
    const end = server.indexOf('function normalizeStringList(');
    const fn = server.slice(start, end);
    assert.doesNotMatch(stripComments(fn), /token/,
        '归一化不接受 token 字段——明文 token 不得进配置文件');
});

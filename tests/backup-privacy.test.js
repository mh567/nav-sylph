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
    const backup = offlineBackup(
        { remotePath: '/backups/', lastConfigChecksum: configChecksum, lastFavoritesChecksum: legacyChecksum },
        recordingClient(files)
    );
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

// ========== 模块配置纳入备份 ==========
// v1.6.0 引入了 .modules.json（监控目标、token、顺序与显示开关），
// 但备份只覆盖 config.json 与 favorites.json。换机器或文件丢失后，
// 监控配置全部重来——这里钉住它必须跟着一起走。

test('备份包含 .modules.json，且 token 仍是密文', () => {
    const code = stripComments(backupSource);
    const backupFn = code.slice(code.indexOf('async createBackup('),
        code.indexOf('async listBackups('));

    // 上传
    assert.match(backupFn, /auto \? AUTO_MODULES_FILE : `nav-sylph-modules-\$\{timestamp\}\.json`/,
        '上传 nav-sylph-modules-{时间戳}.json；自动同步用文件头那三个常量，不另写一遍字面量');
    assert.match(backupFn, /auto \? AUTO_CONFIG_FILE : `nav-sylph-config-\$\{timestamp\}\.json`/,
        '配置文件同理——名字只定义在常量里，两处各写一遍就会漂移');
    assert.match(backupFn, /type:\s*'nav-sylph-modules'/, '带自己的 type 标记');
    // token 走的是 data.modules 原文，不做转换 —— 密文进、密文出
    assert.match(backupFn, /data:\s*modulesData/, '原样带出模块配置');

    // **要断言真的上传了**，只匹配文件名是不够的：
    // 把 `if (modulesData)` 改成 `if (false)` 后，文件名与 type 仍在源码里，
    // 两条断言照样全绿，而备份里永远不会出现 modules 文件。
    // 所以要盯住从存在性判断到 putFileContents 这一段。
    // 锚点用 `let modulesFilename` —— 存在性判断在它之后、对象字面量之前，
    // 用 `const modulesBackup` 会把 `if (modulesData)` 切到外面去。
    // 也不能用注释当锚点：code 已剥掉注释，indexOf 会返回 -1 而切片仍是全文。
    const uploadBlock = backupFn.slice(backupFn.indexOf('let modulesFilename'));
    assert.ok(uploadBlock.length > 100, '找到 modules 上传段');
    assert.match(uploadBlock, /if \(modulesData\)/, '上传段有存在性判断');
    assert.match(uploadBlock, /putFileContents\([\s\S]*?modulesFilePath/,
        'modules 文件真的被 put 上传');
    assert.match(backupFn, /modulesFilename = auto \? AUTO_MODULES_FILE : `nav-sylph-modules-/, '上传后记录文件名供界面显示');

    // 「有无变化」判定也要算上它：只改监控目标却判成 noChanges，
    // 远端会留一份旧布局，恢复时拿到过期数据
    assert.match(backupFn, /this\.config\[modulesKey\] === modulesChecksum/,
        '模块配置参与 noChanges 判定');
    // 手动与自动各一套校验和：共用的话，自动备份之后用户点「立即备份」
    // 会被判成「没有变化」，一次显式请求被静默吞掉
    assert.match(backupFn, /auto \? 'lastAutoModulesChecksum' : 'lastModulesChecksum'/,
        '自动/手动校验和必须分开');
});

test('.admin-password.json 始终不进备份', () => {
    // 把密码哈希交出去等于把账号交出去。不管备份覆盖多少文件，这一条不能破。
    const code = stripComments(backupSource);
    const backupFn = code.slice(code.indexOf('async createBackup('),
        code.indexOf('async listBackups('));
    assert.doesNotMatch(backupFn, /PASSWORD_FILE|admin-password|passwordHash\s*[:=]/,
        '备份不得包含管理密码哈希');
});

test('恢复时校验 modules 文件的 type 与 checksum', () => {
    // 不校验就是把任意 JSON 当配置写进 .modules.json。
    const code = stripComments(backupSource);
    const restoreFn = code.slice(code.indexOf('async restoreBackup('),
        code.indexOf('async deleteBackup('));
    assert.match(restoreFn, /backup\.type !== 'nav-sylph-modules'/, '校验 type');
    assert.match(restoreFn, /verifyChecksum\(backup\)/, '校验 checksum');
});

test('备份列表把 modules 文件归到同一时间戳分组，删除时一并清理', () => {
    const code = stripComments(backupSource);
    const listFn = code.slice(code.indexOf('async listBackups('),
        code.indexOf('async cleanupOldBackups('));
    assert.match(listFn, /\^nav-sylph-modules-\(\\d\{8\}-\\d\{6\}\)\\\.json\$/,
        '识别 modules 文件名');
    assert.match(listFn, /backupGroups\[ts\]\.modulesFile = item\.basename/,
        '归入同一时间戳分组——否则它会变成孤儿文件');

    // 清理按分组算：孤儿文件既不被计入也不会被清走，长期堆积在 WebDAV 上
    const cleanFn = code.slice(code.indexOf('async cleanupOldBackups('),
        code.indexOf('async restoreBackup('));
    assert.match(cleanFn, /if \(backup\.modulesFile\)[\s\S]*?deleteBackup\(backup\.modulesFile\)/,
        '删除备份时一并删除 modules 文件');
});

test('服务端把 .modules.json 传进备份并写回', () => {
    const code = stripComments(server);
    const backupRoute = code.slice(code.indexOf("app.post('/api/webdav/backup'"),
        code.indexOf("app.get('/api/webdav/list'"));
    // 端锚点必须存在：`app.post('/api/webdav/list'` 是错的（那条路由是 GET），
    // indexOf 返回 -1，slice(start, -1) 会静默给出「直到文件末尾」的巨大窗口——
    // 里面当然有 readJSON(MODULES_FILE)，断言照样通过。这里显式钉住长度。
    assert.ok(backupRoute.length > 100 && backupRoute.length < 2000,
        `备份路由切片应正好覆盖该路由（实际 ${backupRoute.length} 字符）`);
    // 本轮把载荷组装抽到了 collectBackupPayload（手动与自动同步共用同一份
    // 「哪些文件进备份」的清单），所以在那个函数里断言，而不是在路由里。
    assert.match(backupRoute, /performBackup\(webdav\)/, '手动备份走共用入口');
    assert.doesNotMatch(backupRoute, /readJSON\(MODULES_FILE\)/,
        '路由不得自己再抄一份清单——两份副本必然漂移，改一处漏一处');

    const payloadFn = code.slice(code.indexOf('async function collectBackupPayload()'),
        code.indexOf('async function performBackup('));
    assert.ok(payloadFn.length > 200, 'collectBackupPayload 切片完整');
    assert.match(payloadFn, /modulesData = await readJSON\(MODULES_FILE\)/,
        '备份时读取 .modules.json');
    // 文件不存在（旧版本升级）时不能因此失败——但**只吞 ENOENT**：
    // 文件损坏时上传一份空书签会直接抹掉远端那一份，而自动同步是在用户
    // 没点任何按钮的情况下发生的。
    //
    // 断言要数个数，不能只写 doesNotMatch(/} catch {}/)：version.json 那处
    // 仍**有意**无条件兜底（读不到就用 1.0.0，没有任何破坏性），一刀切会把它
    // 一起判红。两个数据文件各要一条 ENOENT 判断，无条件兜底只准剩一处。
    assert.equal((payloadFn.match(/\} catch \{\}/g) || []).length, 1,
        '无条件兜底只允许剩下 version.json 那一处');
    assert.equal((payloadFn.match(/if \(err\.code !== 'ENOENT'\) throw err;/g) || []).length, 2,
        'favorites 与 modules 两处都要只吞 ENOENT、其余错误抛上去');

    const performFn = code.slice(code.indexOf('async function performBackup('),
        code.indexOf('async function runAutoSync('));
    assert.ok(performFn.length > 200, 'performBackup 切片完整');
    assert.match(performFn,
        /createBackup\(\s*configData, favoritesData, appVersion, generateBookmarkHtml, modulesData, options\s*\)/,
        '传给 createBackup，且把 options 透传下去（自动/手动由它决定文件名与校验和）');

    const restoreRoute = code.slice(code.indexOf("app.post('/api/webdav/restore'"),
        code.indexOf("app.post('/api/webdav/delete'"));
    assert.match(restoreRoute, /writeJSON\(MODULES_FILE, result\.data\.modules\)/,
        '恢复时写回 .modules.json');
    assert.match(restoreRoute, /restoreModules = true/, '默认恢复模块配置');
    // 缺失的 modules 文件不能被当成「没选」，否则整个恢复被 400 挡下
    assert.match(restoreRoute, /!configFile && !bookmarksFile && !modulesFile && !legacyFile/,
        '只选模块文件也能恢复');
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

test('改密码时推送凭据哈希原样保留（它不派生自管理员密码）', () => {
    // agent token 与 WebDAV 密码的密钥派生自管理员密码哈希，所以改密码时必须重加密。
    // 推送凭据不是：它存的是 sha256(secret)，校验时重新哈希比对，从不解密。
    // 因此重加密循环**不该碰它**——碰了反而是错（没有可解的密文，硬解会抛）。
    //
    // 真正的风险是另一条路径：若重写成「读出对象逐字段重建」而不是「就地改 token」，
    // 就会把 pushSecretHash 一起丢掉，用户的 agent 从此全部 401。
    // reencryptCredentials 走的是「读出整份 JSON → 改若干字段 → 写回」，所以它天然安全——
    // 这条测试把这个「天然」钉住，而不是靠读代码时的印象。
    const code = stripComments(server);
    const fn = code.slice(code.indexOf('async function reencryptCredentials('),
        code.indexOf("app.post('/api/change-password'"));

    // 循环里只重写 token，不该出现对 pushSecretHash 的赋值或删除
    assert.doesNotMatch(fn, /server\.pushSecretHash\s*=/,
        '推送凭据哈希不得被重写');
    assert.doesNotMatch(fn, /delete\s+\w+\.pushSecretHash/,
        '推送凭据哈希不得被删除');

    // 而且必须是「就地改 + 整份写回」：写回的对象来自读出来的那份，
    // 未被触碰的字段（pushSecretHash、mode 等）自然留存。
    assert.match(fn, /modulesRaw\s*=\s*await readJSON\(MODULES_FILE\)/,
        '先读出整份模块配置');
    assert.match(fn, /await writeJSON\(MODULES_FILE,\s*modulesRaw\)/,
        '再把同一份对象写回——未触碰的字段随之保留');
});

// ========== 备份时间的时区 ==========
//
// 文件名里的时间戳由 createBackup 用 toISOString() 生成，是 UTC。
// 修复前恢复列表把这个字符串按本地时间直接渲染：UTC 02:00 显示成 02:00，
// 而同一时刻的「上次备份」经 Date 解析后显示 10:00（北京时间），两处差 8 小时。

const { execFileSync } = require('node:child_process');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('备份列表返回带 Z 的 UTC 创建时间，而不是裸的文件名时间戳', async () => {
    const entries = [
        { type: 'file', basename: 'nav-sylph-config-20261006-020027.json', size: 10, lastmod: 'ignored' },
        { type: 'file', basename: 'nav-sylph-bookmarks-20261006-020027.html', size: 10, lastmod: 'ignored' },
        { type: 'file', basename: 'nav-sylph-modules-20261006-020027.json', size: 10, lastmod: 'ignored' },
        { type: 'file', basename: 'nav-sylph-backup-20250101-120000.json', size: 10, lastmod: 'ignored' }
    ];
    const backup = new WebDAVBackup('/unused', 'unused');
    backup.config = { remotePath: '/backups/' };
    backup.createClient = () => ({ getDirectoryContents: async () => entries });

    const { backups } = await backup.listBackups();
    assert.equal(backups.length, 2);
    assert.equal(backups[0].createdAt, '2026-10-06T02:00:27Z');
    assert.equal(backups[1].createdAt, '2025-01-01T12:00:00Z');
    assert.equal(new Date(backups[0].createdAt).getTime(), Date.UTC(2026, 9, 6, 2, 0, 27),
        '解析出来是 UTC 02:00:27——少了 Z 就会被当成本地时间，早 8 小时');
});

test('前端把 UTC 时刻渲染成本地时间（固定 TZ=Asia/Shanghai，UTC 02:00 → 10:00）', () => {
    // 子进程里固定 TZ，否则断言会随测试机时区变化。
    const script = [
        "const fs = require('fs');",
        `const code = fs.readFileSync(${JSON.stringify(path.join(__dirname, '..', 'public', 'app.js'))}, 'utf8');`,
        "const start = code.indexOf('formatBackupTime(iso) {');",
        "if (start < 0) throw new Error('formatBackupTime 不存在');",
        "const open = code.indexOf('{', start);",
        "let depth = 0, end = -1;",
        "for (let i = open; i < code.length; i++) {",
        "  if (code[i] === '{') depth++;",
        "  else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }",
        "}",
        "const fn = new Function('iso', code.slice(open + 1, end));",
        "process.stdout.write(JSON.stringify([fn('2026-10-06T02:00:27Z'), fn('not-a-date')]));"
    ].join('\n');

    const stdout = execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, TZ: 'Asia/Shanghai' },
        encoding: 'utf8'
    });

    // 若把 UTC 的时分秒原样输出，这里会是 02:00:27 —— 正是修复前的现象
    assert.deepEqual(JSON.parse(stdout), ['2026-10-06 10:00:27', '']);
});

test('恢复列表不再直接展示文件名时间戳，两处时间共用一个格式化', () => {
    const code = stripComments(appSource);

    // 用**带参数的定义**做结束锚点：方法体内还有一次 this.showRestoreOptionsDialog({
    // 调用，用 'showRestoreOptionsDialog(' 会把删除确认那段切到窗口外。
    const start = code.indexOf('async showWebDAVRestoreDialog() {');
    const end = code.indexOf('showRestoreOptionsDialog(backup, parentDialog)');
    assert.ok(start >= 0 && end > start, '恢复对话框方法体边界可定位');
    const dialogFn = code.slice(start, end);
    assert.ok(dialogFn.length > 500, '切片覆盖整个恢复对话框');
    assert.match(dialogFn, /this\.formatBackupTime\(b\.createdAt\)/, '列表用服务端的 createdAt');
    assert.match(dialogFn, /this\.formatBackupTime\(item\.dataset\.createdAt\)/, '删除确认走同一格式化');
    assert.doesNotMatch(dialogFn, /b\.timestamp|dataset\.timestamp/, '不再直接读文件名时间戳');

    const start2 = code.indexOf('renderWebDAVSection() {');
    const end2 = code.indexOf('async saveWebDAVConfig()');
    assert.ok(start2 >= 0 && end2 > start2, 'WebDAV 状态区边界可定位');
    const renderFn = code.slice(start2, end2);
    assert.match(renderFn, /this\.formatBackupTime\(cfg\.lastBackupTime\)/, '「上次备份」走同一格式化');
    assert.doesNotMatch(renderFn, /toLocaleString\(\)/,
        '不再用 toLocaleString——它的输出格式与列表对不上');
});

test('删掉自动槽位的文件会同时清掉它那一组校验和', async () => {
    // 不清的话 `noChanges` 会在下一次自动同步时直接短路，远端那份**再也不会
    // 被重新创建**，而界面上还写着「自动同步：已开启」。
    const files = new Map([['/backups/nav-sylph-config-auto.json', '{}']]);
    const deleted = [];
    const backup = offlineBackup(
        { remotePath: '/backups/', lastAutoConfigChecksum: 'abc' },
        { deleteFile: async name => { deleted.push(name); files.delete(name); } }
    );

    await backup.deleteBackup('nav-sylph-config-auto.json');

    assert.deepEqual(deleted, ['/backups/nav-sylph-config-auto.json'], '真的删了远端文件');
    assert.equal(backup.config.lastAutoConfigChecksum, undefined, '校验和必须被清掉');
    // 赋 undefined 而不是 null 才是关键：JSON.stringify 会丢掉值为 undefined 的键，
    // 于是这个键从配置文件里彻底消失，下一次比较必然不相等。写 null 时若当前
    // 内容也判出 null，null === null 会让 noChanges 再次把上传吞掉。
    assert.ok(!('lastAutoConfigChecksum' in JSON.parse(JSON.stringify(backup.config))),
        '序列化后这个键整个消失（这才保证下次比较必然不相等）');

    // 删手动分组的文件不该动到自动那一组
    const other = offlineBackup(
        { remotePath: '/backups/', lastAutoConfigChecksum: 'abc' },
        { deleteFile: async () => {} }
    );
    await other.deleteBackup('nav-sylph-config-20260101-010101.json');
    assert.equal(other.config.lastAutoConfigChecksum, 'abc', '删手动备份不得清自动槽位的校验和');
});

test('恢复备份前取消已排期的自动同步，runAutoSync 也要再看一眼抑制标志', () => {
    // 只递增抑制挡不住「点恢复**之前**就已排期、此刻正在飞」的那一次：它会读到
    // 写了一半的文件（config.json 已换、favorites.json 还没换），上传一份
    // 混合快照并把它记成最新自动槽位。scheduleAutoSync 只挡新排的期。
    const code = stripComments(server);

    const start = code.indexOf('async function runAutoSync(');
    const end = code.indexOf("app.get('/api/webdav/config'", start);
    assert.ok(start >= 0 && end > start, 'runAutoSync 边界可定位');
    const body = code.slice(start, end);
    assert.ok(body.length > 400, 'runAutoSync 切片完整');
    const suppressedAt = body.indexOf('if (autoSyncSuppressed > 0) return;');
    const runningAt = body.indexOf('if (autoSyncRunning)');
    assert.ok(suppressedAt >= 0, 'runAutoSync 开头必须再看一眼抑制标志');
    assert.ok(runningAt > suppressedAt, '抑制守卫要排在串行判断之前');

    const restoreRoute = code.slice(code.indexOf("app.post('/api/webdav/restore'"),
        code.indexOf("app.post('/api/webdav/delete'"));
    assert.match(restoreRoute, /cancelScheduledAutoSync\(\);\s*autoSyncSuppressed\+\+/,
        '进入恢复时先取消已排期的定时器，再打开抑制');
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

// ========== 自动同步 ==========
//
// 开关打开后，配置类数据文件一有改动就自动备份一次。触发点放在
// writeJSON（三个文件的唯一写出口），因此每条写路径都覆盖到了；
// 自动备份写固定槽位，不参与手动备份「最新 5 组」的轮换。

/** 记录写入的假 WebDAV 客户端。 */
function recordingClient(files) {
    return {
        getDirectoryContents: async () => [],
        putFileContents: async (name, content) => { files.set(name, content); },
        getFileContents: async name => files.get(name),
        createDirectory: async () => {},
        deleteFile: async name => { files.delete(name); }
    };
}

/** 一个不走网络、不落盘的 WebDAVBackup。 */
function offlineBackup(config, client) {
    const b = new WebDAVBackup('/unused', 'unused');
    b.config = config;
    b.createClient = () => client;
    b.saveConfig = async data => { b.config = { ...b.config, ...data }; };
    return b;
}

test('自动备份写固定槽位，且与手动备份各用一套校验和', async () => {
    const files = new Map();
    const backup = offlineBackup({ remotePath: '/backups/' }, recordingClient(files));
    const configData = { theme: 'dark' };
    const favorites = [{ title: 'x', url: 'https://e.test/' }];

    // 1) 自动备份 -> 固定文件名（不带时间戳，每次覆盖）
    const auto = await backup.createBackup(configData, { favorites }, '1.0.0', generateBookmarkHtml, null, { auto: true });
    assert.equal(auto.configFilename, 'nav-sylph-config-auto.json');
    assert.equal(auto.bookmarksFilename, 'nav-sylph-bookmarks-auto.html');
    assert.ok(files.has('/backups/nav-sylph-config-auto.json'), '真的上传了');

    // 2) 同样的数据再自动跑一次 -> noChanges（不重复上传）
    const again = await backup.createBackup(configData, { favorites }, '1.0.0', generateBookmarkHtml, null, { auto: true });
    assert.equal(again.noChanges, true);

    // 3) **手动备份同样的数据不得被判成 noChanges**。两套校验和若共用，
    //    用户点「立即备份」会得到一句「没有变化」、什么都不生成——
    //    一次显式请求被静默吞掉。这条是本次最容易漏的交互。
    const manual = await backup.createBackup(configData, { favorites }, '1.0.0', generateBookmarkHtml, null);
    assert.equal(manual.noChanges, undefined, '自动备份不得让「立即备份」变成空操作');
    assert.match(manual.configFilename, /^nav-sylph-config-\d{8}-\d{6}\.json$/);
    assert.ok(backup.config.lastConfigChecksum, '手动那一组也被更新了');
    assert.ok(backup.config.lastAutoConfigChecksum, '自动那一组独立存在');
});

test('清理旧备份时自动槽位不参与轮换，也不会被删', async () => {
    const entries = [{ type: 'file', basename: 'nav-sylph-config-auto.json', size: 1, lastmod: '2026-10-07T00:00:00Z' }];
    for (let i = 1; i <= 7; i++) {
        entries.push({ type: 'file', basename: `nav-sylph-config-2026010${i}-010101.json`, size: 1, lastmod: 'x' });
    }
    const deleted = [];
    const backup = offlineBackup({ remotePath: '/backups/' }, { getDirectoryContents: async () => entries });
    backup.deleteBackup = async name => { deleted.push(name); };

    const result = await backup.cleanupOldBackups(5);

    assert.equal(result.backupsRemoved, 2, '只从手动组里删两组');
    assert.ok(!deleted.includes('nav-sylph-config-auto.json'),
        '自动槽位是「最新一份」而不是历史还原点；不排除的话它反而会最先被当成最旧一组删掉');
    assert.ok(deleted.includes('nav-sylph-config-20260101-010101.json'), '最旧的手动组被删');
});

test('备份列表把自动槽位排在最前并标记 isAuto', async () => {
    const entries = [
        { type: 'file', basename: 'nav-sylph-config-20260101-010101.json', size: 1, lastmod: 'x' },
        { type: 'file', basename: 'nav-sylph-config-auto.json', size: 1, lastmod: '2026-10-07T01:02:03Z' },
        { type: 'file', basename: 'nav-sylph-modules-auto.json', size: 1, lastmod: '2026-10-07T01:02:03Z' }
    ];
    const backup = offlineBackup({ remotePath: '/backups/' }, { getDirectoryContents: async () => entries });

    const { backups } = await backup.listBackups();

    assert.equal(backups.length, 2, '自动槽位归成一组，不与时间戳分组混同');
    assert.equal(backups[0].isAuto, true, '自动槽位排最前');
    assert.equal(backups[0].configFile, 'nav-sylph-config-auto.json');
    assert.equal(backups[0].modulesFile, 'nav-sylph-modules-auto.json');
    // 固定文件名里没有时刻，「这份有多新」只能取远端给的 lastmod
    assert.equal(backups[0].createdAt, '2026-10-07T01:02:03Z');
    assert.equal(backups[1].isAuto, undefined);
});

test('自动同步缺省关闭，公开配置带开关与失败原因', async () => {
    const fresh = new WebDAVBackup('/nonexistent-webdav-config.json', 'unused');
    await fresh.loadConfig();
    assert.equal(fresh.config.autoSync, false,
        '远端上传是有副作用的动作，不该因为升级到新版本就自己开始跑');

    const backup = offlineBackup({
        enabled: true,
        autoSync: true,
        lastAutoSyncError: 'WebDAV 连不上',
        lastAutoSyncErrorAt: '2026-10-07T02:00:00Z'
    }, recordingClient(new Map()));
    const pub = backup.getPublicConfig();
    assert.equal(pub.autoSync, true);
    assert.equal(pub.lastAutoSyncError, 'WebDAV 连不上',
        '失败必须能显示在界面上——「以为已经进云了」是代价最大的一种静默失败');
    assert.equal(pub.lastAutoSyncErrorAt, '2026-10-07T02:00:00Z');
});

test('自动同步的触发只认三个数据文件，且发生在写完之后', () => {
    const code = stripComments(server);

    const fn = code.slice(code.indexOf('function isBackupSource(file)'),
        code.indexOf('async function writeJSON('));
    assert.ok(fn.length > 100, 'isBackupSource 切片完整');
    assert.match(fn, /file === CONFIG_FILE/);
    assert.match(fn, /file === FAVORITES_FILE/);
    assert.match(fn, /file === MODULES_FILE/);
    assert.doesNotMatch(fn, /PASSWORD_FILE|WEBDAV_CONFIG_FILE/,
        '密码文件与 WebDAV 自身配置的写入不算「配置变了」');

    const write = code.slice(code.indexOf('async function writeJSON('),
        code.indexOf('async function verifyPassword('));
    assert.ok(write.length > 100, 'writeJSON 切片完整');
    const chmodAt = write.indexOf('fs.chmod(file, 0o600)');
    const hookAt = write.indexOf('scheduleAutoSync()');
    assert.ok(chmodAt >= 0 && hookAt > chmodAt,
        '排期必须排在落盘与收紧权限之后——写失败就不该触发上传');
});

test('自动同步要求 enabled、autoSync 与 url 同时成立', () => {
    const code = stripComments(server);
    const start = code.indexOf('async function runAutoSync(');
    const end = code.indexOf("app.get('/api/webdav/config'", start);
    assert.ok(start >= 0 && end > start, 'runAutoSync 边界可定位');
    const body = code.slice(start, end);
    assert.ok(body.length > 400, 'runAutoSync 切片完整');
    assert.match(body,
        /if \(!webdav\.config\.enabled \|\| !webdav\.config\.autoSync \|\| !webdav\.config\.url\) return;/,
        '三个条件缺一不可——只认 autoSync 会做出一个看着开、其实不做的开关');
    // 串行：并发备份会在同一个 .webdav-config.json 上互相覆盖
    assert.match(body, /if \(autoSyncRunning\) \{\s*autoSyncQueued = true;/, '已在跑时要排队而不是并发');
    // 失败留痕：写回配置 + 有 console 记录（两条都要，缺一条就有一边没人看见）
    assert.match(body, /lastAutoSyncError: err\.message/, '失败原因要写回配置');
    assert.match(body, /console\.error\('自动同步失败:', err\.message\)/, '同时留一条服务端日志');
});

test('恢复备份期间抑制自动同步，且递减在 finally 里', () => {
    const code = stripComments(server);
    const restoreRoute = code.slice(code.indexOf("app.post('/api/webdav/restore'"),
        code.indexOf("app.post('/api/webdav/delete'"));
    assert.ok(restoreRoute.length > 500, '恢复路由切片完整');

    const incAt = restoreRoute.indexOf('autoSyncSuppressed++');
    assert.ok(incAt >= 0, '恢复前要打开抑制');
    // 递减必须在 finally 里。中间任何一步抛错若跳过递减，抑制就永久留在开状态，
    // 自动同步从此静默失效，而界面上的开关还写着「已开启」。
    assert.match(restoreRoute, /\}\s*finally\s*\{\s*autoSyncSuppressed--;/,
        '递减必须放在 finally，且紧跟 try 块之后');
    const finallyAt = restoreRoute.indexOf('} finally {');
    const decAt = restoreRoute.indexOf('autoSyncSuppressed--');
    assert.ok(finallyAt >= 0 && decAt > finallyAt, 'finally 里递减');
    assert.doesNotMatch(stripComments(restoreRoute.slice(finallyAt + 12)),
        /autoSyncSuppressed\+\+/,
        'finally 之后不得再开一次抑制（那会让抑制失衡）');
});

test('保存 WebDAV 配置接收 autoSync，并清掉旧的失败原因', () => {
    const code = stripComments(server);
    const route = code.slice(code.indexOf("app.post('/api/webdav/config'"),
        code.indexOf("app.post('/api/webdav/test'"));
    assert.ok(route.length > 300, '配置保存路由切片完整');
    assert.match(route, /enabled, autoSync \}/, '解构里要有 autoSync');
    assert.match(route, /if \(autoSync !== undefined\) newConfig\.autoSync = !!autoSync;/,
        '不传时保持原值（旧客户端不该把开关抹掉）');
    assert.match(route, /newConfig\.lastAutoSyncError = null/,
        '用户刚改过配置，旧错误说的是旧配置');
});

test('自动同步的定时器不会把进程吊住，关闭时一并清理', () => {
    const code = stripComments(server);
    const start = code.indexOf('function scheduleAutoSync()');
    const end = code.indexOf('async function collectBackupPayload(');
    assert.ok(start >= 0 && end > start, 'scheduleAutoSync 边界可定位');
    const body = code.slice(start, end);
    assert.ok(body.length > 200, 'scheduleAutoSync 切片完整');
    assert.match(body, /autoSyncTimer\.unref\(\)/,
        '待触发的定时器不得让事件循环保持活着——否则 `out=$(node --test …)` 永不返回');
    // 启动期的 ensureFile 写入不算用户改动
    assert.match(body, /if \(!autoSyncReady \|\| autoSyncSuppressed > 0\) return;/,
        '初始化尚未完成时不得排期（否则开机就把默认配置推到自动槽位）');

    const shutdown = code.slice(code.indexOf('function gracefulShutdown('),
        code.indexOf('function gracefulShutdown(') + 800);
    assert.match(shutdown, /clearTimeout\(autoSyncTimer\)/, '关闭时清掉待触发的定时器');
});

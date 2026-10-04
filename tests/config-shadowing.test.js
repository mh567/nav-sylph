const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server.js');
const DEFAULTS_JS = path.join(ROOT, 'server-config', 'defaults.js');

// ========== 实测故障：server-config.json 遮蔽 server-config/ 目录 ==========
//
// 一份只写了 {"security":{"selfSignedCert":false}} 的残片放在安装目录根下。
// Node 解析 require('./server-config') 的顺序是 .js → .json → 目录，于是它胜出，
// server-config/index.js 一行都不执行；config 因此少了 rootDir，
// 第一个用到它的 path.join(config.rootDir, 'config.json') 收到 undefined，
// 抛出 ERR_INVALID_ARG_TYPE —— 指向 path.join，不提配置文件，也不提同名遮蔽。
//
// 而那份残片不是外部残留：POST /api/server-flags 写出来的就是它
// （首次改设置时 existing 初始为 {}，只补 security）。见本文件末尾的回归测试。

/**
 * 把项目拷进临时目录并按指定形状放置 server-config.json，然后真实启动 server.js。
 *
 * 刻意走**真实进程**而不是匹配源码：早先那条「断言 assertConfigUsable 被调用了」
 * 的测试是假绿的——它用 indexOf 找 'assertConfigUsable(config);'，结果匹配到了
 * 注释里的同一串字符，把调用点注释掉它照样全绿。真实启动不存在这个问题。
 *
 * 拷贝用 tar 而不是 fs.cpSync：实测在 macOS 上 fs.cpSync 带 filter 时只会对源根
 * 调用一次（返回不跳过后就不再递归），结果是「报告成功、目录为空」，
 * 表现为 Cannot find module '…/server.js'。tar 的行为在两个平台都可预期。
 */
function bootWith(userConfig) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-shadow-'));
    // 走临时文件而不是管道：spawnSync 传 Buffer 给另一个 spawnSync 的 stdin
    // 在两处 encoding 不一致时会静默拿到空输入（实测报「拷贝项目失败」且 stderr 为空）。
    const tarball = path.join(dir, 'project.tar');
    const copy = spawnSync('tar', [
        '--exclude=./node_modules', '--exclude=./.git', '--exclude=./logs',
        // 运行时私有文件与真实配置：不能带进测试环境，也不能覆盖我们要摆的形状
        '--exclude=./.admin-password.json', '--exclude=./.modules.json',
        '--exclude=./config.json', '--exclude=./favorites.json',
        '--exclude=./server-config.json',
        '--exclude=*.db', '--exclude=*.db-wal', '--exclude=*.db-shm',
        '-cf', tarball, '-C', ROOT, '.'
    ], { encoding: 'utf8' });
    if (copy.status !== 0) {
        throw new Error('拷贝项目失败: ' + copy.stderr);
    }
    const extract = spawnSync('tar', ['-xf', tarball, '-C', dir], { encoding: 'utf8' });
    fs.rmSync(tarball, { force: true });
    if (extract.status !== 0) {
        throw new Error('解包失败: ' + extract.stderr);
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));

    if (userConfig !== null) {
        fs.writeFileSync(path.join(dir, 'server-config.json'), JSON.stringify(userConfig, null, 2));
    }

    const res = spawnSync(process.execPath, ['server.js'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 20000,
        // 端口必须落在 1–65535：传 0 会被 config.validate() 判为无效端口
        // （server.js 末尾会调它），服务在打印横幅前就退出。
        env: { ...process.env, PORT: '47311', HOST: '127.0.0.1' }
    });
    return { dir, stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

test('残片配置下服务启动即报人话：点名文件、说清遮蔽、给出修复命令', (t) => {
    // 用户机器上实测拿到的就是这个形状——它由 /api/server-flags 写出。
    const { dir, stderr, status } = bootWith({ security: { selfSignedCert: false } });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.notEqual(status, 0, '残片配置必须让服务起不来（否则守卫没拦住）');
    assert.match(stderr, /服务配置加载失败/, '必须是自有错误文案');
    assert.match(stderr, /server-config\.json/, '必须点名那个配置文件');
    // 精确匹配那句解释，而不是裸测 /遮蔽/：源码注释里「遮蔽」出现多次
    // （本文件开头就警告过这个坑），裸词断言会匹配到注释而恒绿。
    assert.match(stderr, /遮蔽了 server-config\/ 目录/, '必须说清是同名遮蔽目录');
    assert.match(stderr, /server-config\.example\.json/, '必须指向正确的模板');
    assert.match(stderr, /assertConfigUsable/, '栈里应能看到守卫自己，便于定位');
    // 关键回归：不能再退回到那个指不到真因的类型错误。
    assert.doesNotMatch(stderr, /ERR_INVALID_ARG_TYPE/,
        '不能抛 path.join 的类型错误——那正是本轮要消灭的失败模式');
    assert.doesNotMatch(stderr, /at Object\.join/, '不应再崩在 path.join 上');
});

test('手写 rootDir 也拦得住——否则会退化成 config.validate is not a function', (t) => {
    // 只查 rootDir 的话这份 json 会通过守卫，然后在更下游炸成更难懂的错误。
    const { dir, stderr, status } = bootWith({ rootDir: '/opt/nav-sylph' });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.notEqual(status, 0);
    assert.match(stderr, /服务配置加载失败/, '必须拦在守卫上');
    assert.doesNotMatch(stderr, /validate is not a function/,
        '不能放行到下游才炸');
});

test('没有 server-config.json 时正常启动（守卫不得误伤）', (t) => {
    const { dir, stdout, status } = bootWith(null);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    assert.match(stdout, /Nav Sylph Server/, '默认路径必须照常起来');
    assert.doesNotMatch(stdout, /服务配置加载失败/, '守卫不该在正常路径上触发');
});

// ========== 缺失的段被逐个列出 ==========
//
// 端到端跑得慢且不适合逐条枚举键名，这一层用抽取的真函数覆盖。
// 抽取而非源文本匹配：JSDoc 与 require 处的长注释都提到过这个函数名。

function loadGuard(userFileExists) {
    const src = fs.readFileSync(SERVER_JS, 'utf8');

    const constStart = src.indexOf('const REQUIRED_CONFIG_SECTIONS =');
    assert.ok(constStart > -1, 'server.js 必须声明 REQUIRED_CONFIG_SECTIONS');
    const constEnd = src.indexOf('\n', constStart);

    const fnStart = src.indexOf('function assertConfigUsable(');
    assert.ok(fnStart > -1, 'server.js 必须定义 assertConfigUsable');
    // 按缩进配对花括号，而不是找 '\n}\n'：函数体里一旦出现顶格 }（比如模板
    // 字符串里换行），后者会截断到错误的位置。实测那种注入会让 4 条测试红。
    const fnEnd = findFunctionEnd(src, fnStart);
    assert.ok(fnEnd > fnStart, 'assertConfigUsable 必须有可定位的结尾');

    const snippet = [
        src.slice(constStart, constEnd),
        src.slice(fnStart, fnEnd)
    ].join('\n');

    const sandbox = {
        path: require('node:path'),
        __dirname: ROOT,
        fsSync: { existsSync: () => userFileExists }
    };
    vm.createContext(sandbox);
    vm.runInContext(snippet + '\nglobalThis.__guard = assertConfigUsable;', sandbox);
    return sandbox.__guard;
}

// 从 'function xxx(' 处开始，按大括号配对找结尾，跳过字符串/模板/注释里的花括号。
function findFunctionEnd(src, start) {
    let depth = 0;
    let seen = false;
    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') { depth++; seen = true; }
        else if (ch === '}') {
            depth--;
            if (seen && depth === 0) return i + 1;
        }
    }
    return -1;
}

test('缺失的段被逐个列出，便于判断残片缺了什么', () => {
    const guard = loadGuard(true);
    assert.throws(
        () => guard({ server: { port: 4000 } }),
        (err) => {
            // 只看「缺少 …」这一段，别拿整条消息匹配——后面的指引里必然出现
            // server-config.json（文件名含 server），会误判。
            const listed = /（缺少 ([^）]*)）/.exec(err.message);
            assert.ok(listed, '消息里应有一段列出缺失的键');
            const missing = listed[1].split(',').map((s) => s.trim()).sort();
            assert.deepEqual(missing, ['paths', 'rootDir', 'security'],
                '应恰好列出这三个，且不含已存在的 server');
            return true;
        }
    );
});

test('完整配置一律放行——校验不能误伤正常运行', () => {
    const guard = loadGuard(true);
    const real = require(path.join(ROOT, 'server-config'));
    assert.equal(typeof real.rootDir, 'string', '真实配置必须有 rootDir');
    assert.equal(typeof real.validate, 'function', '真实配置必须有 validate');
    assert.doesNotThrow(() => guard(real), '真实配置必须原样通过');
});

// ========== 遮蔽顺序是 Node 的行为，不是我们的选择 ==========
//
// 守卫与「写出完整配置」的修复都依赖「json 优先于目录」。若哪天这个前提不成立，
// 两者会静默失效——所以把这个前提本身也钉住。

test('实测 Node 解析：server-config.json 确实优先于 server-config/ 目录', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-probe-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(dir, 'server-config'));
    fs.writeFileSync(
        path.join(dir, 'server-config', 'index.js'),
        'module.exports = { rootDir: "/from-index", validate: () => {} };\n'
    );
    const jsonPath = path.join(dir, 'server-config.json');
    fs.writeFileSync(jsonPath, '{"security":{"selfSignedCert":false}}');

    // macOS 上 tmpdir 是 /var/…（符号链接到 /private/var/…），require.resolve
    // 返回 realpath，两边都归一化再比，否则这条断言在 mac 上恒假。
    const resolved = fs.realpathSync(require.resolve(path.join(dir, 'server-config')));
    assert.equal(resolved, fs.realpathSync(jsonPath), 'json 必须胜出，否则守卫的前提不成立');

    const loaded = require(resolved);
    assert.equal(loaded.rootDir, undefined, '残片给不出 rootDir，这正是守卫的判据');
    assert.deepEqual(Object.keys(loaded), ['security']);
});

test('require("./server-config/defaults") 不受同名遮蔽影响', (t) => {
    // /api/server-flags 靠这个引用当基准，把完整配置写回磁盘。
    // 若它也被遮蔽，写出去的仍是残片——整个修复就垮了。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'defaults-probe-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(dir, 'server-config'));
    fs.cpSync(DEFAULTS_JS, path.join(dir, 'server-config', 'defaults.js'));
    fs.writeFileSync(path.join(dir, 'server-config.json'), '{"security":{}}');

    const defaults = require(path.join(dir, 'server-config', 'defaults.js'));
    assert.deepEqual(
        Object.keys(defaults).sort(),
        ['app', 'paths', 'security', 'server', 'webdav'],
        '带显式子路径的 require 必须拿到完整的 defaults'
    );
});

// ========== 真正的根因：应用自己会写出遮蔽文件 ==========
//
// 上面三条守卫是「症状看得见」。这一节修的是「症状不再发生」：
// POST /api/server-flags 首次改设置时 existing 初始为 {}，只补 security，
// 于是它写出的文件恰好就是那份让服务起不来的残片。

test('写出的是完整配置——不再只写改动的那一段', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const routeStart = src.indexOf("app.post('/api/server-flags'");
    assert.ok(routeStart > -1, '必须能定位 /api/server-flags 路由');
    const routeEnd = src.indexOf('\n});', routeStart);
    assert.ok(routeEnd > routeStart, '路由必须有可定位的结尾');
    const route = src.slice(routeStart, routeEnd);

    // 基准必须来自 defaults，而不是内存里的 config（后者在遮蔽状态下就是残片）。
    assert.match(route, /serverConfigDefaults/, '补齐段时必须以 defaults 为基准');
    assert.match(route, /for \(const \[key, value\] of Object\.entries\(serverConfigDefaults\)\)/,
        '必须遍历 defaults 的每个段补齐，而不是只处理 security');

    // 补齐的条件是「该段缺失」，不能是「无条件覆盖」——否则会把用户已改的端口冲掉。
    assert.match(route, /if \(existing\[key\] === undefined\)/,
        '只在缺段时补默认值，不得覆盖用户已有的设置');

    // 写盘前必须确保 existing 是普通对象。
    assert.match(route, /Array\.isArray\(existing\)/,
        'existing 若是数组或 null，必须先归位，否则 Object.entries 会写出怪东西');
});

// ========== 白名单仍然有效 ==========
//
// 补齐 defaults 之后，写出的文件里会包含 defaultPassword 等敏感默认值。
// 它们来自 defaults.js、本就是公开可读的，但**绝不能**因此放开白名单。

test('可写白名单仍只有 selfSignedCert', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const m = /WRITABLE_SERVER_FLAGS = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(m, '必须能读到白名单定义');
    const flags = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepEqual(flags, ['selfSignedCert'], '白名单不得因为补齐逻辑而扩大');
    for (const forbidden of ['defaultPassword', 'adminPasswordFile']) {
        assert.doesNotMatch(src, new RegExp(`WRITABLE_SERVER_FLAGS[^\\n]*${forbidden}`),
            `${forbidden} 绝不能变成网页可写`);
    }
});
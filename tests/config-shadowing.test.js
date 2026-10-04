const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server.js');

// 所有被启动的服务进程都登记在这里，退出前一律杀掉。
//
// ⚠️ 不这么做会挂死外层脚本：泄漏的子进程继承了本进程的 stdout 管道，
// 于是 `out=$(node --test …)` 这种命令替换永远等不到管道关闭——实测卡了 20 分钟。
// 各测试自己的 t.after 是正常路径，这里是任何异常路径的兜底。
const spawned = new Set();
function killAll() {
    for (const proc of spawned) {
        try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
    spawned.clear();
}
after(killAll);
process.on('exit', killAll);

// ========== 实测故障：server-config.json 遮蔽 server-config/ 目录 ==========
//
// 安装目录根下的 server-config.json 会**遮蔽** server-config/ 目录
// （Node 解析 .js → .json → .node → 目录）。而那份文件是后台「自签证书」开关
// 自己写出来的（首次保存时 existing 为 {}，只补 security），于是：
//   · index.js 一行都不执行，defaults 不被合并
//   · rootDir 也不会被赋值（它不在 defaults.js 里，是 index.js 单独加的）
//   · 服务启动即崩，报 ERR_INVALID_ARG_TYPE，指向 path.join
//
// 1.6.10 试过「把配置写全」来绕开，但 rootDir 补不出来，同一故障复发。
// 正解是 server.js 用显式路径 require('./server-config/index.js')，让遮蔽不发生。
// 下面第一条测试就是这条修复的行为证明：残片存在时服务必须照常起来，
// 且那份残片必须仍被读取并应用（不能被无声忽略）。

/** 拷项目进临时目录（tar，见下方说明），可选预置一份 server-config.json。 */
function stage(userConfig) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-cfg-'));
    // 拷贝用 tar 而不是 fs.cpSync：实测 macOS 上 cpSync 带 filter 只对源根调用一次
    // （返回不跳过后就不再递归），结果是「报告成功、目录为空」，
    // 表现为 Cannot find module '…/server.js'，极难辨认。
    const tarball = path.join(dir, 'project.tar');
    const copy = spawnSync('tar', [
        '--exclude=./node_modules', '--exclude=./.git', '--exclude=./logs',
        // 运行时私有文件与真实配置：不能带进测试环境，也不能覆盖预置的形状
        '--exclude=./.admin-password.json', '--exclude=./.modules.json',
        '--exclude=./config.json', '--exclude=./favorites.json',
        '--exclude=./server-config.json',
        '--exclude=*.db', '--exclude=*.db-wal', '--exclude=*.db-shm',
        '-cf', tarball, '-C', ROOT, '.'
    ], { encoding: 'utf8' });
    if (copy.status !== 0) throw new Error('拷贝项目失败: ' + copy.stderr);
    const extract = spawnSync('tar', ['-xf', tarball, '-C', dir], { encoding: 'utf8' });
    fs.rmSync(tarball, { force: true });
    if (extract.status !== 0) throw new Error('解包失败: ' + extract.stderr);
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));

    if (userConfig !== undefined && userConfig !== null) {
        fs.writeFileSync(path.join(dir, 'server-config.json'), JSON.stringify(userConfig, null, 2));
    }
    return dir;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/**
 * 真启动一个服务进程并等它就绪。
 *
 * 用 spawn 而非 spawnSync：spawnSync 会阻塞到进程退出，没法在运行期间发 HTTP。
 * 就绪判据是 stdout 出现横幅——这同时是「残片没有让它崩」的观测点。
 */
async function startServer(dir) {
    const port = await freePort();
    const proc = spawn(process.execPath, ['server.js'], {
        cwd: dir,
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    spawned.add(proc);
    let output = '';
    proc.stdout.on('data', (d) => { output += d; });
    proc.stderr.on('data', (d) => { output += d; });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) {
            throw new Error(`服务提前退出（code=${proc.exitCode}）：\n${output}`);
        }
        if (output.includes('Nav Sylph Server')) {
            return { proc, port, base: `http://127.0.0.1:${port}`, get output() { return output; } };
        }
        await new Promise((r) => setTimeout(r, 60));
    }
    proc.kill('SIGKILL');
    throw new Error(`服务 15s 内未就绪：\n${output}`);
}

function stopServer(srv) {
    if (srv && srv.proc && srv.proc.exitCode === null) {
        srv.proc.kill('SIGKILL');
        spawned.delete(srv.proc);
    }
}

/** 拨自签开关。默认管理密码见 server-config/defaults.js 的 defaultPassword。 */
async function saveSelfSigned(srv) {
    return fetch(`${srv.base}/api/server-flags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': 'admin123' },
        body: JSON.stringify({ selfSignedCert: true })
    });
}

// ========== 核心：残片存在时服务必须照常起来，且残片必须被应用 ==========

test('残片 server-config.json 不再让服务起不来，且其中设置确实生效', async (t) => {
    // 用户那份的形状：只有 security 一段，由后台开关写出。
    const dir = stage({ security: { selfSignedCert: true } });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const srv = await startServer(dir);              // 起不来会在这里抛错
    t.after(() => stopServer(srv));

    // 不但要能起，还要证明那份 json 真被读了——否则「忽略它」也能通过上面这步。
    const res = await fetch(`${srv.base}/api/server-flags`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.selfSignedCert, true,
        '残片里的 selfSignedCert 必须被应用（说明 index.js 合并了该文件，而不是忽略它）');
});

test('手写 rootDir 的 json 不再拦住服务，且 rootDir 以真实安装目录为准', async (t) => {
    // 带 rootDir 的 json 曾绕过守卫、然后在更下游炸成 config.validate is not a function。
    const dir = stage({ rootDir: '/nonexistent-should-be-overridden', security: { selfSignedCert: true } });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const srv = await startServer(dir);
    t.after(() => stopServer(srv));

    // index.js 在合并之后无条件用 __dirname 推导的 ROOT_DIR 覆盖 rootDir，
    // 所以数据文件必须落在真实安装目录，而不是 json 里写的那个假路径。
    assert.ok(fs.existsSync(path.join(dir, 'config.json')), 'config.json 必须落在真实安装目录');
    assert.equal(fs.existsSync('/nonexistent-should-be-overridden'), false,
        '绝不能采用 json 里手写的 rootDir');
});

test('没有 server-config.json 时正常启动（守卫不得误伤）', async (t) => {
    const dir = stage(null);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const srv = await startServer(dir);
    t.after(() => stopServer(srv));
    assert.ok(fs.existsSync(path.join(dir, 'config.json')), '应正常初始化数据文件');
});

// ========== 用户报告的完整往返：拨开关 → 重启 ==========

test('拨自签开关后重启不再崩溃（用户报告的原始路径）', async (t) => {
    const dir = stage(null);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const first = await startServer(dir);
    const res = await saveSelfSigned(first);         // 拨开关：写 server-config.json
    assert.equal(res.status, 200, '保存开关应成功');
    stopServer(first);

    // 写出的文件应只含用户改动的那一段，不该把 defaults 整份落到磁盘。
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'server-config.json'), 'utf8'));
    assert.deepEqual(Object.keys(written), ['security'],
        '只写用户改动的那一段——写全也补不出 rootDir，反而会落下 defaultPassword 等默认值');
    assert.equal(written.security.selfSignedCert, true);
    assert.doesNotMatch(JSON.stringify(written), /defaultPassword/,
        '不得把管理密码默认值写进这个文件');

    // 关键一步：用这份文件重启。这正是用户手动重启后崩掉的场景。
    const second = await startServer(dir);
    t.after(() => stopServer(second));
    const flags = await (await fetch(`${second.base}/api/server-flags`)).json();
    assert.equal(flags.selfSignedCert, true, '重启后开关设置必须仍然生效');
});

// ========== 兜底守卫（require 若被改回隐式形式，上面几条会先逮住） ==========

function loadGuard(userFileExists) {
    const src = fs.readFileSync(SERVER_JS, 'utf8');

    const constStart = src.indexOf('const REQUIRED_CONFIG_SECTIONS =');
    assert.ok(constStart > -1, 'server.js 必须声明 REQUIRED_CONFIG_SECTIONS');
    const constEnd = src.indexOf('\n', constStart);

    const fnStart = src.indexOf('function assertConfigUsable(');
    assert.ok(fnStart > -1, 'server.js 必须定义 assertConfigUsable');
    const fnEnd = findFunctionEnd(src, fnStart);
    assert.ok(fnEnd > fnStart, 'assertConfigUsable 必须有可定位的结尾');

    const snippet = [src.slice(constStart, constEnd), src.slice(fnStart, fnEnd)].join('\n');
    const sandbox = {
        path: require('node:path'),
        __dirname: ROOT,
        fsSync: { existsSync: () => userFileExists }
    };
    vm.createContext(sandbox);
    vm.runInContext(snippet + '\nglobalThis.__guard = assertConfigUsable;', sandbox);
    return sandbox.__guard;
}

// 从函数名处按花括号配对找结尾，跳过字符串/模板/注释里的花括号。
// 不用 '\n}\n'：函数体里一旦出现顶格 }（模板字符串换行）就会截断到错位置。
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

test('守卫仍是有效兜底：拿到残片时逐个列出缺失的段', () => {
    const guard = loadGuard(true);
    assert.throws(
        () => guard({ security: {} }),
        (err) => {
            assert.match(err.message, /服务配置加载失败/, '必须是自有错误文案');
            assert.match(err.message, /遮蔽了 server-config\/ 目录/, '必须说清遮蔽');
            // 只看「缺少 …」那段：后面的指引里必然出现 server-config.json（含 server），
            // 拿整条消息匹配会误判。
            const listed = /（缺少 ([^）]*)）/.exec(err.message);
            assert.ok(listed, '应有一段列出缺失的键');
            const missing = listed[1].split(',').map((s) => s.trim()).sort();
            // 段本身缺着时不再追加 validate()——对用户是噪音，那条只在段都齐了
            // 却仍缺 validate（手写 rootDir 的形状）时才有信息量，见下一条。
            assert.deepEqual(missing, ['paths', 'rootDir', 'server'],
                '应恰好列出缺失的段');
            return true;
        }
    );
});

test('段都齐但缺 validate 时，明确点出 validate()', () => {
    // 手写一份带 rootDir/server/paths/security 的 json 就是这个形状：
    // 单看段名「齐了」，但没有 index.js 挂上的 validate，放过去会炸在更下游。
    const guard = loadGuard(true);
    assert.throws(
        () => guard({ rootDir: '/x', server: {}, paths: {}, security: {} }),
        (err) => {
            const listed = /（缺少 ([^）]*)）/.exec(err.message);
            assert.ok(listed, '应有一段列出缺失的键');
            assert.deepEqual(listed[1].split(',').map((s) => s.trim()), ['validate()'],
                '段齐时唯一缺的就是 validate()');
            return true;
        }
    );
});

test('守卫不误伤完整配置', () => {
    const guard = loadGuard(true);
    // 这里必须用显式路径 require，否则在遮蔽场景下会读到 json。
    const real = require(path.join(ROOT, 'server-config', 'index.js'));
    assert.equal(typeof real.rootDir, 'string');
    assert.equal(typeof real.validate, 'function');
    assert.doesNotThrow(() => guard(real));
});

// ========== 钉住修复本身：require 必须是显式路径 ==========

test('server.js 用显式 index.js 加载配置（修复的落点）', () => {
    // 这条是「提示」而非实质守卫：实质证明是上面那几条真实启动的测试
    // ——require 一旦改回隐式形式，残片会让服务崩掉，它们立即变红。
    // 保留它是为了让失败信息直接点出原因。
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const call = /const config = require\('\.\/server-config[^']*'\)/.exec(src);
    assert.ok(call, '必须能定位配置的 require');
    assert.equal(call[0], "const config = require('./server-config/index.js')",
        '必须显式带 index.js——写成 ./server-config 会让同名 json 遮蔽目录');
});

test('守卫真的被调用——剥掉注释后仍能找到那行', () => {
    // 改成显式路径后守卫已是兜底：把它注释掉，服务照常起来，真实启动的测试
    // 一条都不会红。所以要单独钉住「它确实被调用」。
    //
    // 必须在**剥掉注释**后判断：早先那版用 src.indexOf('assertConfigUsable(config);')
    // 直接找，命中的是注释里同一串字符，把真正的调用点注释掉仍全绿（假绿）。
    const src = stripComments(fs.readFileSync(SERVER_JS, 'utf8'));

    const requireAt = src.indexOf("require('./server-config/index.js')");
    const callAt = src.search(/^[ \t]*assertConfigUsable\(config\);[ \t]*$/m);
    assert.ok(requireAt > -1, '必须能定位配置的 require');
    assert.ok(callAt > -1, 'assertConfigUsable(config) 必须作为真代码存在（注释不算）');
    assert.ok(callAt > requireAt, '调用必须在 require 之后——否则传进去的是 undefined');
});

// 去掉块注释与整行注释。只删**整行**的 //，避免把字符串里的
// "http://…" 一起吃掉（那会让断言对源码里的 URL 产生误判）。
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

test('前提：Node 解析确实让 server-config.json 优先于同名目录', (t) => {
    // 显式路径这条修复的正确性建立在这个前提上；前提变了这段注释就该重写。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-probe-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(dir, 'server-config'));
    fs.writeFileSync(path.join(dir, 'server-config', 'index.js'),
        'module.exports = { rootDir: "/from-index", validate: () => {} };\n');
    const jsonPath = path.join(dir, 'server-config.json');
    fs.writeFileSync(jsonPath, '{"security":{"selfSignedCert":false}}');

    // macOS 的 tmpdir 是 /var/…（符号链接到 /private/var/…），require.resolve 返回
    // realpath，两边都归一化再比，否则这条断言在 mac 上恒假。
    const implicit = fs.realpathSync(require.resolve(path.join(dir, 'server-config')));
    assert.equal(implicit, fs.realpathSync(jsonPath),
        '隐式 require 会被 json 抢走——这正是必须写显式路径的原因');

    // 显式路径不受影响，这是修复的支点。
    const explicit = fs.realpathSync(require.resolve(path.join(dir, 'server-config', 'index.js')));
    assert.equal(explicit, fs.realpathSync(path.join(dir, 'server-config', 'index.js')));
    assert.equal(typeof require(explicit).rootDir, 'string');
});

test('可写白名单仍只有 selfSignedCert', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    const m = /WRITABLE_SERVER_FLAGS = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(m, '必须能读到白名单定义');
    const flags = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepEqual(flags, ['selfSignedCert'], '白名单不得被扩大');
    for (const forbidden of ['defaultPassword', 'adminPasswordFile']) {
        assert.doesNotMatch(src, new RegExp(`WRITABLE_SERVER_FLAGS[^\\n]*${forbidden}`),
            `${forbidden} 绝不能变成网页可写`);
    }
});
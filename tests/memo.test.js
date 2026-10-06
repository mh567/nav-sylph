const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const swSource = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const memoSrc = fs.readFileSync(path.join(ROOT, 'public', 'modules', 'memo.js'), 'utf8');

const { openDatabase, MIGRATIONS } = require(path.join(ROOT, 'lib', 'db.js'));

/** 去注释后再匹配，避免注释里的字符串把形状断言骗过。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function tempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-memo-db-'));
    return path.join(dir, 'memos.db');
}

// ========== 迁移 ==========

test('v4 迁移建出 memos 表，且是在数组尾部追加（不改已发布台阶）', () => {
    assert.ok(MIGRATIONS.length >= 4, `迁移台阶至少 4 级，当前 ${MIGRATIONS.length}`);

    const db = openDatabase(tempDbPath());
    try {
        const cols = db.prepare('PRAGMA table_info(memos)').all().reduce((acc, c) => {
            acc[c.name] = c.type;
            return acc;
        }, {});
        assert.deepEqual(Object.keys(cols).sort(),
            ['body', 'created_at', 'id', 'pinned', 'title', 'updated_at'],
            'memos 表的列必须与设计一致');
        assert.equal(cols.id, 'TEXT', 'id 是客户端不可预测的字符串（服务端生成）');
        assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    } finally {
        db.close();
    }
});

// ========== 路由形状：五条，每条都带守卫 ==========

test('五条 /api/memos 路由全部带 rateLimit, requireAdmin', () => {
    const code = stripComments(server);
    const routes = [...code.matchAll(/app\.(get|post|delete)\('(\/api\/memos[^']*)'/g)];
    assert.equal(routes.length, 5, `应有 5 条备忘录路由，实测 ${routes.length}`);

    // 正向枚举：逐条断言守卫链，不用负向 lookahead（那种写法是恒真的）。
    // 每条都用自身匹配的 index 取链，不能按路径去 find——同一路径的 GET/POST
    // 会互相取错锚点。
    for (const m of routes) {
        const [, method, route] = m;
        const head = code.slice(m.index);
        const handlerAt = head.indexOf('=>');
        assert.ok(handlerAt > 0, `${method} ${route} 的处理函数可定位`);
        const chain = head.slice(0, handlerAt);
        assert.ok(chain.includes('rateLimit') && chain.includes('requireAdmin'),
            `${method} ${route} 必须同时挂 rateLimit 与 requireAdmin，实际：${chain.trim()}`);
    }
});

test('备忘录限流桶登记进 60 秒 sweep 定时器（无界 Map 不能只增不减）', () => {
    const code = stripComments(server);
    assert.match(code, /const memoRateLimitMap = new Map\(\)/, '限流桶已声明');
    assert.match(code, /sweepRateLimitStore\(memoRateLimitMap, now, MEMO_LIMIT_WINDOW\)/,
        '限流桶必须被 sweep 清理');
});

// ========== 真实处理函数（vm 抽出，配真实 SQLite） ==========

/**
 * 抽出 server.js 的「备忘录 API」整节，只替换外部依赖：
 * app 记录路由，rateLimit/requireAdmin 放行（鉴权由下面的 HTTP 边界用例覆盖），
 * db 用临时库（真跑迁移），readPollInterval 固定 15。
 */
function loadMemoRoutes(db) {
    const begin = server.indexOf('const MEMO_LIMIT_WINDOW');
    const end = server.indexOf('// ========== Paste API ==========', begin);
    assert.ok(begin >= 0 && end > begin, '备忘录 API 小节存在');

    const routes = new Map();
    const record = method => (route, ...mw) => routes.set(`${method} ${route}`, mw);
    const context = {
        app: { get: record('GET'), post: record('POST'), delete: record('DELETE') },
        rateLimit: (req, res, next) => next(),
        requireAdmin: (req, res, next) => next(),
        resolveClientIp: req => req.ip || '127.0.0.1',
        readPollInterval: async () => 15,
        crypto: require('node:crypto'),
        db,
        console
    };
    const { memoToClient } = vm.runInNewContext(
        `${server.slice(begin, end)}\n;({ memoToClient })`, context);
    return { routes, memoToClient };
}

function makeRes() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        setHeader(key, value) { this.headers[key] = value; }
    };
}

/** 调真实处理器；返回响应对象（含 statusCode / body）。 */
async function callApi(routes, routeKey, { body = {}, params = {} } = {}) {
    const mw = routes.get(routeKey);
    assert.ok(mw, `路由存在：${routeKey}`);
    const handler = mw[mw.length - 1];
    const res = makeRes();
    await handler({ body, params, ip: '127.0.0.1' }, res);
    return res;
}

test('增删改查往返：建 → 读 → 改 → 固定 → 删', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoRoutes(db);

        let res = await callApi(routes, 'POST /api/memos', { body: { title: '  周末爬山清单  ', body: '登山鞋、护膝' } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.memo.title, '周末爬山清单', '标题应 trim');
        assert.equal(res.body.memo.pinned, false, '新建默认不固定');
        const id = res.body.memo.id;
        assert.ok(id && id.length >= 16, '服务端生成的 id 不可预测');
        assert.equal(res.body.memo.createdAt, res.body.memo.updatedAt);

        res = await callApi(routes, 'GET /api/memos');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.memos.length, 1);
        assert.equal(res.body.pollInterval, 15, '回当前生效的轮询周期，客户端据此重排表');

        res = await callApi(routes, 'POST /api/memos/:id', { params: { id }, body: { title: '改后标题', body: '新正文' } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.memo.title, '改后标题');
        assert.ok(res.body.memo.updatedAt >= res.body.memo.createdAt);

        res = await callApi(routes, 'POST /api/memos/:id/pin', { params: { id }, body: { pinned: true } });
        assert.equal(res.statusCode, 200);
        res = await callApi(routes, 'GET /api/memos');
        assert.equal(res.body.memos[0].pinned, true);

        res = await callApi(routes, 'DELETE /api/memos/:id', { params: { id } });
        assert.equal(res.statusCode, 200);
        res = await callApi(routes, 'GET /api/memos');
        assert.equal(res.body.memos.length, 0);
    } finally {
        db.close();
    }
});

test('固定组在前，组内按更新时间倒序；未固定的一律在其后', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoRoutes(db);
        // 直接种数据并写死 updated_at：连续两次创建会落在同一毫秒，
        // 并列时 SQLite 的顺序未定义——那样断言的是时间粒度，不是排序契约。
        const insert = db.prepare('INSERT INTO memos (id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
        insert.run('a', '普通一', '', 0, 1000, 1000);
        insert.run('b', '置顶一', '', 1, 2000, 2000);
        insert.run('c', '普通二', '', 0, 3000, 3000);
        insert.run('d', '置顶二', '', 1, 4000, 4000);

        const res = await callApi(routes, 'GET /api/memos');
        // 展开进本 realm：vm 里 map 出来的数组原型与本文件不同，deepStrictEqual 会假红
        assert.deepEqual([...res.body.memos.map(m => m.id)], ['d', 'b', 'c', 'a'],
            '固定组在前、组内按更新时间倒序；未固定组同样倒序且整体在后');
    } finally {
        db.close();
    }
});

test('切换固定不改 updated_at（固定组内按内容更新时间排序）', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoRoutes(db);
        const created = await callApi(routes, 'POST /api/memos', { body: { title: '一条', body: '' } });
        const id = created.body.memo.id;
        const before = created.body.memo.updatedAt;

        await callApi(routes, 'POST /api/memos/:id/pin', { params: { id }, body: { pinned: true } });
        let res = await callApi(routes, 'GET /api/memos');
        assert.equal(res.body.memos[0].updatedAt, before, '固定操作不算内容更新');
        assert.equal(res.body.memos[0].pinned, true);

        await callApi(routes, 'POST /api/memos/:id/pin', { params: { id }, body: { pinned: false } });
        res = await callApi(routes, 'GET /api/memos');
        assert.equal(res.body.memos[0].updatedAt, before);
        assert.equal(res.body.memos[0].pinned, false);
    } finally {
        db.close();
    }
});

test('容量上限：第 201 条被拒', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoRoutes(db);
        const insert = db.prepare('INSERT INTO memos (id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)');
        const now = Date.now();
        db.transaction(() => {
            for (let i = 0; i < 200; i++) insert.run(`seed-${i}`, `第 ${i} 条`, '', now, now);
        })();

        const res = await callApi(routes, 'POST /api/memos', { body: { title: '第 201 条', body: '' } });
        assert.equal(res.statusCode, 400);
        assert.match(res.body.error, /200/);
    } finally {
        db.close();
    }
});

test('字段校验在服务端把住：空标题 / 标题超 60 / 正文超 10KB / pinned 非布尔', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoRoutes(db);

        let res = await callApi(routes, 'POST /api/memos', { body: { title: '   ', body: 'x' } });
        assert.equal(res.statusCode, 400, '只有空白的标题不算标题');

        res = await callApi(routes, 'POST /api/memos', { body: { title: 'x'.repeat(61), body: '' } });
        assert.equal(res.statusCode, 400, '客户端 maxlength 只是体验，边界在服务端');

        res = await callApi(routes, 'POST /api/memos', { body: { title: 'ok', body: 'y'.repeat(10241) } });
        assert.equal(res.statusCode, 400);

        const created = await callApi(routes, 'POST /api/memos', { body: { title: '边界内', body: 'y'.repeat(10240) } });
        assert.equal(created.statusCode, 200, '恰好 10KB 必须通过');

        res = await callApi(routes, 'POST /api/memos/:id/pin', { params: { id: created.body.memo.id }, body: { pinned: 'yes' } });
        assert.equal(res.statusCode, 400, 'pinned 必须严格是布尔值，字符串不能让固定状态落成 1');
    } finally {
        db.close();
    }
});

test('编辑 / 删除 / 固定不存在的 id 都返回 404', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoRoutes(db);
        const params = { id: 'nope' };

        assert.equal((await callApi(routes, 'POST /api/memos/:id', { params, body: { title: 'x', body: '' } })).statusCode, 404);
        assert.equal((await callApi(routes, 'DELETE /api/memos/:id', { params })).statusCode, 404);
        assert.equal((await callApi(routes, 'POST /api/memos/:id/pin', { params, body: { pinned: true } })).statusCode, 404);
    } finally {
        db.close();
    }
});

test('memoToClient 把 0/1 转布尔、下划线键转驼峰', () => {
    const { memoToClient } = loadMemoRoutes(openDatabase(tempDbPath()));
    const row = { id: 'a', title: 't', body: 'b', pinned: 1, created_at: 1, updated_at: 2 };
    // 展开进本 realm 再比：vm 里的对象原型与本文件不同，deepStrictEqual 会假红
    assert.deepEqual({ ...memoToClient(row) }, {
        id: 'a', title: 't', body: 'b', pinned: true, createdAt: 1, updatedAt: 2
    });
});

// ========== 前端与发布面 ==========

test('KNOWN_MODULES 收编 memo，模块文件存在且经 registerModule 注册', () => {
    assert.match(appSource, /static KNOWN_MODULES = \[[^\]]*'memo'/,
        '白名单不含 memo 的话 loadModule 会直接拒绝加载');
    assert.match(memoSrc, /window\.app\.registerModule\(\{/);
    assert.match(memoSrc, /id: 'memo'/);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'modules', 'memo.js')));
});

test('sw.js 预缓存 memo.js，且 CACHE 与注释里最新的一级一致', () => {
    assert.match(swSource, /'\/modules\/memo\.js'/,
        '延后加载也要预缓存：否则回访用户每次打开模块区都要走一次网络');

    const cache = swSource.match(/const CACHE = '([^']+)'/)[1];
    const versions = [...swSource.matchAll(/nav-v(\d+)/g)].map(m => Number(m[1]));
    const newest = Math.max(...versions);
    assert.equal(cache, `nav-v${newest}`,
        `CACHE ${cache} 必须等于注释里记录的最新版本 nav-v${newest}——改了 public/ 不升缓存名，老用户拿不到`);
});

test('备忘录模块把用户文本经 esc() 落进模板，原始字段不得直接插入', () => {
    assert.match(memoSrc, /function esc\(/, '模块内自带转义助手');

    // 正向枚举：用户文本（标题 / 正文 / 搜索词）在哪都行，但每一处插值
    // 都必须整体包在 esc() 里。只作「存在性检查」是不够的——标题在预览行
    // 与列表行各出现一次，去掉其中一处的 esc 仍然能匹配到另一处（实测踩过）。
    const offenders = [];
    for (const tpl of [...memoSrc.matchAll(/`([^`]*)`/gs)].map(m => m[1])) {
        for (const hit of tpl.matchAll(/\$\{([^}]+)\}/g)) {
            const expr = hit[1].trim();
            if (!/\b(m\.title|m\.body|search)\b/.test(expr)) continue;
            if (/^esc\(/.test(expr)) continue;                        // 正确写法
            if (/\.length\b/.test(expr)) continue;                    // 只取长度，得到数字
            if (/^\s*m\.title\.trim\(\)\s*\?/.test(expr)) continue;   // 三元只输出静态字面量
            offenders.push(expr);
        }
    }
    assert.deepEqual(offenders, [],
        `这些插值把用户文本直接落进了 innerHTML：${offenders.join(' | ')}`);
    // 备注：m.id 不在此列——它是服务端 crypto.randomUUID() 生成的十六进制，
    // 不是用户可控输入；data-id 用它没有注入面。
});

test('模块只用平台注入的 api 对象，不引用 app.js 内部的裸标识符', () => {
    const code = stripComments(memoSrc);
    // app.js 的 API 是 IIFE 内部的 const，不是全局——写裸 API 时
    // node --check 与任何「源码里有没有 API 字样」的形状断言都过得去，
    // 只有真在浏览器里跑起来才会 ReferenceError（实测踩过）。
    assert.doesNotMatch(code, /\bAPI\./, '不得出现裸 API. 调用');
    assert.match(code, /api = \(state && state\.api\)/, 'API 对象必须从 mountWidget 的 state 注入');
    assert.match(code, /api = null;/, '注入位要有初值，避免用错作用域静默取到别处的同名变量');
    assert.doesNotMatch(code, /window\.app\.API|window\.API/, '也不该从 window 上找');
});

test('模块用的元素 id 不与页面既有 id 冲突', () => {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const memoIds = [...memoSrc.matchAll(/(?<![-\w])id="([^"]+)"/g)].map(m => m[1]);
    assert.ok(memoIds.length >= 5, `备忘录模块应有若干 id，实测 ${memoIds.length}`);

    // 浏览器实测踩过：模块的 #saveBtn 与 app.js 后台弹窗的 #saveBtn 撞名，
    // 于是 querySelector('#saveBtn') 命中的是那个隐藏的后台按钮——
    // 点击落到遮罩上、面板被关掉，看起来像「保存没反应」。
    const existing = [];
    for (const [file, src] of [['index.html', indexHtml], ['app.js', appSource]]) {
        for (const m of src.matchAll(/\bid="([^"]+)"/g)) existing.push([m[1], file]);
        for (const m of src.matchAll(/id:\s*'([^']+)'/g)) existing.push([m[1], file]);
        for (const m of src.matchAll(/\$\('#([^']+)'\)/g)) existing.push([m[1], file]);
    }
    for (const id of memoIds) {
        // 模块自己的 id 一律以 memo 起头，天然避开全页命名空间
        assert.match(id, /^memo/, `模块 id 应带 memo 前缀：${id}`);
        const clash = existing.filter(([other]) => other === id);
        assert.deepEqual(clash, [], `${id} 与页面既有 id 冲突：${JSON.stringify(clash)}`);
    }
});

// ========== 真实 HTTP 边界 ==========
// 上面的 vm 用例把 rateLimit/requireAdmin 换成了放行桩，因此**测不到鉴权与
// 限流的真实链路**。这一段把服务按用户的启动方式跑起来（临时副本 + 默认密码）
// 走一遍：未登录 401、密码头 200、增删改查真的落在 HTTP 上。
//
// 临时副本是必需的：config.json / favorites.json / .modules.json 的路径钉在
// 仓库根（server-config/index.js:166 的 rootDir），直接在仓库里起服务会碰
// 真实用户文件。副本里排除全部私有文件，让服务自己按默认值新建。

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

async function waitForServer(base, deadlineMs) {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
        try {
            const res = await fetch(`${base}/api/server-flags`);
            if (res.ok) return true;
        } catch { /* 还没起来 */ }
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

test('HTTP 边界：未登录 401，带密码头可增删改查', { timeout: 60000 }, async t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-memo-e2e-'));
    let child = null;
    t.after(() => {
        if (child) child.kill('SIGKILL');
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    // 复制项目（排除 node_modules / .git / logs 与全部私有数据），
    // 排除目标在源之内会自我递归，故先建副本目录再拷内容
    const tar = spawnSync('bash', ['-c',
        `tar --exclude=node_modules --exclude=.git --exclude=logs ` +
        `--exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' ` +
        `--exclude=.admin-password.json --exclude=.modules.json ` +
        `--exclude=.webdav-config.json --exclude=config.json --exclude=favorites.json ` +
        `--exclude=server-config.json --exclude=docs ` +
        `-cf - . | tar -xf - -C "${tmp}"`
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(tar.status, 0, `复制项目失败：${tar.stderr}`);

    // 私有文件一个都不能跟进副本：漏进去等于把管理员密码带进 /tmp
    for (const leak of ['.admin-password.json', '.modules.json', 'config.json', 'favorites.json', 'nav-sylph.db']) {
        assert.equal(fs.existsSync(path.join(tmp, leak)), false, `${leak} 不应出现在临时副本里`);
    }
    assert.ok(fs.existsSync(path.join(tmp, 'server.js')), '副本必须完整');

    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
    assert.ok(fs.existsSync(path.join(tmp, 'public', 'modules', 'memo.js')));

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], {
        cwd: tmp,
        env: {
            ...process.env,
            PORT: String(port),
            DB_FILE: path.join(tmp, 'nav-sylph.db'),
            DATA_FILE: path.join(tmp, 'config.json'),
            LOG_DIR: path.join(tmp, 'logs'),
            ADMIN_PASSWORD_FILE: path.join(tmp, '.admin-password.json')
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    assert.ok(await waitForServer(base, 20000), `服务未在 20 秒内就绪；stderr:\n${stderr}`);

    const auth = { 'X-Admin-Password': 'admin123' };
    const json = { ...auth, 'Content-Type': 'application/json' };

    // 未登录：401，且不泄露任何条目
    let res = await fetch(`${base}/api/memos`);
    assert.equal(res.status, 401);

    // 登录（默认密码），空列表
    res = await fetch(`${base}/api/memos`, { headers: auth });
    assert.equal(res.status, 200);
    let data = await res.json();
    assert.deepEqual(data.memos, []);

    // 建
    res = await fetch(`${base}/api/memos`, {
        method: 'POST', headers: json,
        body: JSON.stringify({ title: 'HTTP 往返', body: '正文' })
    });
    assert.equal(res.status, 200);
    data = await res.json();
    const id = data.memo.id;
    assert.equal(data.memo.title, 'HTTP 往返');

    // 改 + 固定
    res = await fetch(`${base}/api/memos/${id}`, {
        method: 'POST', headers: json,
        body: JSON.stringify({ title: 'HTTP 改后', body: '新正文' })
    });
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/memos/${id}/pin`, {
        method: 'POST', headers: json,
        body: JSON.stringify({ pinned: true })
    });
    assert.equal(res.status, 200);

    res = await fetch(`${base}/api/memos`, { headers: auth });
    data = await res.json();
    assert.equal(data.memos.length, 1);
    assert.equal(data.memos[0].title, 'HTTP 改后');
    assert.equal(data.memos[0].pinned, true);

    // 校验 + 404 也要真的从 HTTP 回来
    res = await fetch(`${base}/api/memos`, {
        method: 'POST', headers: json,
        body: JSON.stringify({ title: 'x'.repeat(61), body: '' })
    });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/memos/${id}`, { method: 'DELETE', headers: auth });
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/memos/${id}`, { method: 'DELETE', headers: auth });
    assert.equal(res.status, 404);

    // 删掉的确实不在了
    res = await fetch(`${base}/api/memos`, { headers: auth });
    data = await res.json();
    assert.deepEqual(data.memos, []);

    // 实测落盘的库文件名对得上（备份/升级面）：nav-sylph.db 在副本里生成
    assert.ok(fs.existsSync(path.join(tmp, 'nav-sylph.db')), '备忘录与会话共用同一个库文件');
});

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

test('五条 /api/memos 路由：读走轮询桶，写走管理桶 + memoLimit', () => {
    const code = stripComments(server);
    const routes = [...code.matchAll(/app\.(get|post|delete)\('(\/api\/memos[^']*)'/g)];
    assert.equal(routes.length, 5, `应有 5 条备忘录路由，实测 ${routes.length}`);

    // 正向枚举：逐条断言守卫链，不用负向 lookahead（那种写法是恒真的）。
    // 每条都用自身匹配的 index 取链，不能按路径去 find——同一路径的 GET/POST
    // 会互相取错锚点。
    //
    // ⚠️ 读与写用的**不是同一只桶**。GET 是 15 秒一次的轮询，按标签页数线性
    // 增长：算进 30 次/分钟的管理桶，8 个标签页 × 4 次/分钟就超了——那时
    // 首页模块区会整个渲染不出来（实测过）。它走 modulePollLimit（120/分钟）；
    // 写是用户手动发起的，走 rateLimit + memoLimit。
    for (const m of routes) {
        const [, method, route] = m;
        const head = code.slice(m.index);
        const handlerAt = head.indexOf('=>');
        assert.ok(handlerAt > 0, `${method} ${route} 的处理函数可定位`);
        const chain = head.slice(0, handlerAt);
        assert.ok(chain.includes('requireAdmin'),
            `${method} ${route} 必须挂 requireAdmin，实际：${chain.trim()}`);
        if (method === 'get') {
            assert.ok(chain.includes('modulePollLimit'),
                `GET ${route} 是轮询，必须走 modulePollLimit，实际：${chain.trim()}`);
            assert.ok(!chain.includes('rateLimit,') && !chain.includes('memoLimit'),
                `GET ${route} 不得占用管理桶或写桶，实际：${chain.trim()}`);
        } else {
            assert.ok(chain.includes('rateLimit') && chain.includes('memoLimit'),
                `${method} ${route} 写操作必须挂 rateLimit 与 memoLimit，实际：${chain.trim()}`);
        }
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
 * app 记录路由，几个限流中间件与 requireAdmin 放行（鉴权与限流本身
 * 由别处的路由形状断言与 HTTP 边界用例覆盖），db 用临时库（真跑迁移），
 * readPollInterval 固定 15。
 *
 * ⚠️ 三只桶都要桩上：读接口走 modulePollLimit，写接口走 rateLimit + memoLimit。
 * 少桩一只，`app.get(..., undefined, ...)` 会在注册时抛，表现为一串与本用例
 * 无关的失败。
 */
function loadMemoRoutes(db) {
    const begin = server.indexOf('const MEMO_LIMIT_WINDOW');
    // 端锚点用**下一节自己的标题**，不要用 Paste API：时间线 API 小节就排在
    // 备忘录之后、Paste 之前，用 Paste 当端点会把整节时间线路由拖进这个 vm，
    // 于是注册期就要求桩出 app.put / ServiceError / timeline——与本用例无关的
    // 一串失败。切片到这里，恰好只剩备忘录那一节。
    const end = server.indexOf('// ========== Special Line 时间线 API ==========', begin);
    assert.ok(begin >= 0 && end > begin, '备忘录 API 小节存在');

    const routes = new Map();
    const record = method => (route, ...mw) => routes.set(`${method} ${route}`, mw);
    const pass = (req, res, next) => next();
    const context = {
        app: { get: record('GET'), post: record('POST'), delete: record('DELETE') },
        rateLimit: pass,
        modulePollLimit: pass,
        memoLimit: pass,
        requireAdmin: pass,
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

// ========== 轮询开销 ==========

test('卡片按数据指纹跳过整块重建，同步态就地更新', () => {
    // 症状（浏览器实测）：每 15 秒一轮，卡片 innerHTML **整块重写两次**
    // ——「同步中」一次、「已同步」一次，每次都跟一次全量纵向重排。
    // 一轮 48 次模块区 DOM 变更、12 次强制重排，而绝大多数轮询里数据没变。
    const code = stripComments(memoSrc);

    // ① 指纹不含 syncState：含进去等于每轮必然重写一次，正是要避免的那件事
    const keyAt = code.indexOf('function cardKey()');
    assert.ok(keyAt > 0, '有卡片内容指纹函数');
    const keyBody = code.slice(keyAt, code.indexOf('\n    }', keyAt));
    assert.ok(keyBody.length > 50, `切出 cardKey（${keyBody.length}）`);
    assert.doesNotMatch(keyBody, /syncState/,
        '指纹不得包含同步态——否则每轮必翻一次、跳过重建形同虚设');
    assert.match(keyBody, /drafts\.length/, '离线草稿条数要进指纹');
    assert.match(keyBody, /m\.updatedAt/, '每条的时间要进指纹');
    // 时间那一项取**渲染出来的文案**（relTime），不是自造的分钟档：
    // 两处取整方式不一致时显示值会比指纹早一个档变化，卡上那行停在旧值上。
    assert.match(keyBody, /relTime\(m\.updatedAt\)/, '时间项取渲染文案，不自造档位');

    // ② 「没变就只刷状态行」
    const maybeAt = code.indexOf('function renderCardMaybe()');
    assert.ok(maybeAt > 0, '有「没变就不重建」的入口');
    const maybeBody = code.slice(maybeAt, code.indexOf('\n    }', maybeAt));
    assert.match(maybeBody, /cardKey\(\) === lastCardKey/, '指纹相同走就地更新');
    assert.match(maybeBody, /renderCardStatus\(\)/, '就地只刷状态行');
    assert.match(maybeBody, /renderCard\(\)/, '不同才整块重建');
    assert.match(code, /function renderCardStatus\(\)/, '状态就地更新');
    assert.match(code, /lastCardKey = cardKey\(\)/, '整块重建后记下指纹');
    // 状态自己也有指纹：数据与同步态都没变的一轮轮询应当零 DOM 写入
    const statusAt = code.indexOf('function renderCardStatus()');
    const statusBody = code.slice(statusAt, code.indexOf('\n    }', statusAt));
    assert.ok(statusBody.length > 150, `切出 renderCardStatus（${statusBody.length}）`);
    assert.match(statusBody, /if \(key === lastCardStatusKey\) return;/, '状态没变就不写');
    // ⚠️ 光钉「有指纹」不够：这个函数的作用就是把状态**写出去**，
    // 删掉写入语句后上面几条断言照样绿。写入本身必须钉住。
    assert.match(code, /function fillStatus\(\)/, '有真正写状态的函数');
    const fillAt = code.indexOf('function fillStatus()');
    const fillBody = code.slice(fillAt, code.indexOf('\n    }', fillAt));
    assert.ok(fillBody.length > 150, `切出 fillStatus（${fillBody.length}）`);
    assert.match(fillBody, /cardStatus\.innerHTML = statusPillHTML\(\) \+ pendingPillHTML\(\)/,
        '状态胶囊写进**卡片头**的状态区（不再独占正文第一行）');
    // ⚠️ 只断言「出现过 querySelector('.memo-sync-part')」是不够的：把那行
    // **写入**删掉、只留查询，断言照样绿，而底部小字里的时刻就没了。
    assert.match(fillBody, /part\.textContent = t \? ` · \$\{t\}同步` : ''/,
        '真的把同步时刻写进底部小字（没有时刻时连分隔符一起不渲染）');
    // 时刻只在成功态给值——同步中/失败时显示上一次成功的时刻会误导
    assert.match(code, /function syncTimeText\(\)\s*\{[\s\S]{0,200}syncState === 'synced' && lastSync/,
        '同步时刻只在成功态给值');
    assert.match(code, /lastCardStatusKey = statusKey\(\)/, '整块重建后同步状态指纹');
    // setSyncState 必须走 renderCardMaybe，否则上面两层都白搭
    const syncAt = code.indexOf('function setSyncState(next)');
    const syncBody = code.slice(syncAt, code.indexOf('\n    }', syncAt));
    assert.match(syncBody, /renderCardMaybe\(\)/, '同步态变化走「没变就不重建」的入口');

    // ③ 只有**手动**同步才进「同步中」态（自动轮询不转圈）。用户原话：
    //    「不要一直在前台转圈显示刷新，一是不美观，二是是否会占用更多终端资源」。
    //    实测：每次轮询都转圈时未变动的一轮是 +15 次 DOM 变更 / +4 次强制重排，
    //    仅手动时 +0 / +0。
    //    ⚠️ 上一轮我为这件事写过方向相反的断言（把「自动也不提示」钉成契约），
    //    两轴审查把它判为越界的行为变更并撤回；本轮由用户自己提出，方向反转。
    const pollAt = code.indexOf('async function poll(');
    assert.ok(pollAt > 0, '找到 poll');
    const pollBody = code.slice(pollAt, code.indexOf('\n    }', pollAt));
    assert.ok(pollBody.length > 150, `切出 poll（${pollBody.length}）`);
    assert.match(pollBody, /if \(manual\) setSyncState\('syncing'\)/,
        '「同步中」只在手动同步时出现');
    assert.match(code, /poll\(\{ manual: true \}\)/, '同步 / 重试按钮走手动');
    // 两种入口都要传 manual——只传一处会让另一个入口静默不提示
    assert.equal((code.match(/poll\(\{ manual: true \}\)/g) || []).length, 2,
        '手动入口恰好两处：卡片上的「重试」与面板里的「同步 / 重试」');

    // ④ 首轮 promise 交给平台（与 server-monitor 同一处契约）
    assert.match(code, /const firstRound = poll\(\)/, '首轮拉取');
    assert.match(code, /state\.whenReady\(firstRound\)/, '把首轮 promise 交给平台');

    // ⑤ 重排**由平台注入**，且整块重建之后才请求。
    //    ⚠️ 只断言「存在 state.requestStack」还不够——注入的取值、调用点、
    //    以及状态行那条路径都要各自钉住，否则删掉任一处都还是绿。
    assert.match(code, /requestStack = \(state && state\.requestStack\) \|\| null/,
        '从 state 取注入的重排请求');
    assert.match(code, /function mountWidget\(shell, state\) \{[\s\S]{0,200}requestStack = \(state/,
        '挂载时就取，不能等到渲染时才取');
    assert.doesNotMatch(code, /function requestStack\(\)/,
        '模块不得自带转发函数（两份副本是重复代码）');
    assert.doesNotMatch(code, /window\.app\.stackWidgetsByHeight/,
        '模块不直接摸平台方法');
    const cardAt = code.indexOf('function renderCard() {');
    assert.ok(cardAt > 0, '找到 renderCard');
    const renderCardBody = code.slice(cardAt, code.indexOf('\n    }', cardAt));
    assert.ok(renderCardBody.length > 300, `切出 renderCard（${renderCardBody.length}）`);
    assert.match(renderCardBody, /if \(requestStack\) requestStack\(\)/,
        '整块重建后请求一次合并重排');
    // 状态本身也会让卡片变高：底部那行小字是块级、会折行，失败态多一个
    // 「重试」、同步时刻那一小段出现/消失（「共 N 条 · 01:07同步 · 管理」），
    // 在最窄的 132px 卡片上都可能让它从一行变两行。所以这条路径也必须请求重排。
    assert.match(statusBody, /if \(requestStack\) requestStack\(\)/,
        '状态变化后也要请求重排（底部小字会折行变高）');
});

test('卡片布局：状态胶囊在卡片头，「管理」在正文（窄卡片才装得下）', () => {
    // 用户原话：「备忘录的"已同步"状态应该放在第一行，不应该占用这么大空间」。
    // 状态胶囊原来独占正文第一行（胶囊行 + 8px 外边距约 26px）。
    //
    // ⚠️ 但**不能连「管理」一起放进卡片头**：实测最窄的一档卡片只有 132px、
    // 头部可用 104px，而「标题(33) + 胶囊(41) + 管理(36) + 间隙」需要 126px，
    // 标题会被挤成 8px（对照表见 docs/mockup-module-status-motion.html，四个
    // 位置 × 两档宽度的实测）。所以「管理」下移到右下角那行小字——那行本来
    // 就在说「点击管理」。
    const code = stripComments(memoSrc);

    // ① 卡片头里有一个独立的状态容器，且不参与正文的整块重建
    assert.match(code, /let cardStatus = null;/, '状态区是模块级状态');
    assert.match(code, /const status = document\.createElement\('span'\);\s*\n\s*status\.className = 'memo-card-status'/,
        '卡片头里建了状态容器');
    assert.match(code, /head\.append\(label, status, handle\)/, '状态容器排在标题之后');
    assert.match(code, /cardStatus = status;/, '挂载时记下状态容器');

    // ② 正文里不再有那一行
    const cardAt = code.indexOf('function renderCard() {');
    const renderBody = code.slice(cardAt, code.indexOf('\n    }', cardAt));
    assert.ok(renderBody.length > 300, `切出 renderCard（${renderBody.length}）`);
    assert.doesNotMatch(renderBody, /memo-status-row/, '正文不再渲染独立的状态行');

    // ③ 「管理」在正文底部，带 data-action（走那一层事件委托）
    assert.match(renderBody, /class="memo-card-manage"[^>]*data-action="open"/,
        '「管理」在底部小字里，仍是 data-action="open"');
    assert.match(renderBody, /memo-sync-part/, '同步时刻的容器也在底部小字里');
    // 卡片头里不得再有「管理」按钮（那就是会挤掉标题的那个形状）
    assert.doesNotMatch(code, /module-widget-expand/, '卡片头里不得再有「管理」按钮');

    // ④ 委托必须挂在**整张卡**上，不能挂在正文上。
    //    ⚠️ 这是本轮踩到的真缺陷：状态胶囊（含失败态的「重试」按钮）在卡片头里，
    //    而卡片头与正文是**兄弟节点**——委托挂在正文上时，头里那个「重试」是
    //    死按钮。实测（停服制造失败态）：点头里的「重试」不发请求、状态纹丝不动，
    //    而面板里的「同步」正常。光断言「字符串 poll({manual:true}) 存在」抓不到它，
    //    因为那个分支还在、只是永远走不到。
    assert.match(code, /card\.addEventListener\('click'/, '点击委托挂在整张卡上');
    assert.doesNotMatch(code, /body\.addEventListener\('click'/,
        '不得只挂在正文上——卡片头里的「重试」会点不到');
    assert.match(code, /card\.append\(head, body\)/, '卡片头与正文都是 card 的子节点');
    assert.match(code, /t\.dataset\.action === 'retry'\)\s*poll\(\{ manual: true \}\)/,
        '失败态的「重试」确实接到手动同步上');
});

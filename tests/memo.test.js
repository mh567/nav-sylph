const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
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

test('v13 迁移建出 todos 表', () => {
    assert.ok(MIGRATIONS.length >= 13, `迁移台阶至少 13 级，当前 ${MIGRATIONS.length}`);

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

        const todoCols = db.prepare('PRAGMA table_info(todos)').all().reduce((acc, c) => {
            acc[c.name] = c.type;
            return acc;
        }, {});
        assert.deepEqual(Object.keys(todoCols).sort(),
            ['created_at', 'done', 'id', 'text', 'updated_at'],
            'todos 表的列必须与设计一致');
        assert.equal(todoCols.id, 'TEXT', '待办 id 同样是服务端生成的字符串');
        assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    } finally {
        db.close();
    }
});

test('v12 老库升级到 v13：原有备忘/会话不丢，todos 表新建', () => {
    const file = tempDbPath();
    // 先手工把库停在升级前的 v12，并写入一条备忘与一条会话。
    const raw = new Database(file);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    for (let version = 0; version < 12; version++) {
        raw.transaction(() => {
            MIGRATIONS[version](raw);
            raw.pragma(`user_version = ${version + 1}`);
        })();
    }
    const now = Date.now();
    raw.prepare('INSERT INTO memos (id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .run('legacy-memo', '升级前', '正文', now, now);
    raw.prepare("INSERT INTO sessions (token, trusted, expires_at, fp, region, purpose) VALUES (?, 0, ?, ?, NULL, 'admin')")
        .run('legacy-token', now + 86400e3, 'legacy-fp');
    raw.close();

    const db = openDatabase(file);
    try {
        assert.equal(db.pragma('user_version', { simple: true }), 13, '老库补到 v13');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memos WHERE id = ?').get('legacy-memo').n, 1,
            '既有备忘不丢（迁移只追加）');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token = ?').get('legacy-token').n, 1,
            '既有会话不丢');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM todos').get().n, 0,
            'todos 表已建好且为空');
    } finally {
        db.close();
    }
});

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
    assert.match(code, /const todoRateLimitMap = new Map\(\)/, '待办写桶已声明');
    assert.match(code, /sweepRateLimitStore\(todoRateLimitMap, now, TODO_LIMIT_WINDOW\)/,
        '待办写桶也必须被 sweep 清理（与备忘录同一条纪律）');
});

test('五条 /api/todos 路由：读走轮询桶，写走管理桶 + todoLimit', () => {
    const code = stripComments(server);
    const routes = [...code.matchAll(/app\.(get|post|delete)\('(\/api\/todos[^']*)'/g)];
    assert.equal(routes.length, 5, `应有 5 条待办路由，实测 ${routes.length}`);

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
            assert.ok(!chain.includes('rateLimit,') && !chain.includes('todoLimit'),
                `GET ${route} 不得占用管理桶或写桶，实际：${chain.trim()}`);
        } else {
            assert.ok(chain.includes('rateLimit') && chain.includes('todoLimit'),
                `${method} ${route} 写操作必须挂 rateLimit 与 todoLimit，实际：${chain.trim()}`);
        }
    }
});

// ========== 真实处理函数（vm 抽出，配真实 SQLite） ==========

/**
 * 抽出 server.js 的「备忘 + 待办 API」整节，只替换外部依赖：
 * app 记录路由，几个限流中间件与 requireAdmin 放行（鉴权与限流本身
 * 由别处的路由形状断言与 HTTP 边界用例覆盖），db 用临时库（真跑迁移），
 * readPollInterval 固定 15。
 *
 * ⚠️ 四只桶都要桩上：读接口走 modulePollLimit，备忘写走 rateLimit + memoLimit，
 * 待办写走 rateLimit + todoLimit。少桩一只，`app.get(..., undefined, ...)`
 * 会在注册时抛，表现为一串与本用例无关的失败。
 */
function loadMemoTodoRoutes(db) {
    const begin = server.indexOf('const MEMO_LIMIT_WINDOW');
    // 端锚点用**下一节自己的标题**，不要用 Paste API：时间线 API 小节就排在
    // 备忘录之后、Paste 之前，用 Paste 当端点会把整节时间线路由拖进这个 vm，
    // 于是注册期就要求桩出 app.put / ServiceError / timeline——与本用例无关的
    // 一串失败。切片到这里，恰好只剩备忘录那一节。
    // ⚠️ 端锚点用**紧挨着的下一节标题**。原先写的是 Special Line 那一节，而
    // 「微博热搜代理」小节排在备忘录与 Special Line 之间——于是整个代理路由
    // （含 `process.env.NAV_WEIBO_HOT_URL`）也被拖进这个 vm，注册期就报
    // `process is not defined`，表现为一串与备忘录无关的失败。
    const end = server.indexOf('// ========== 微博热搜代理 ==========', begin);
    assert.ok(begin >= 0 && end > begin, '备忘录 API 小节存在');

    const routes = new Map();
    const record = method => (route, ...mw) => routes.set(`${method} ${route}`, mw);
    const pass = (req, res, next) => next();
    const context = {
        app: { get: record('GET'), post: record('POST'), delete: record('DELETE') },
        rateLimit: pass,
        modulePollLimit: pass,
        memoLimit: pass,
        todoLimit: pass,
        requireAdmin: pass,
        resolveClientIp: req => req.ip || '127.0.0.1',
        readPollInterval: async () => 15,
        crypto: require('node:crypto'),
        db,
        console
    };
    const { memoToClient, todoToClient, restoreMemosFromBackup, restoreTodosFromBackup } =
        vm.runInNewContext(
            `${server.slice(begin, end)}\n;({ memoToClient, todoToClient, restoreMemosFromBackup, restoreTodosFromBackup })`,
            context);
    return { routes, memoToClient, todoToClient, restoreMemosFromBackup, restoreTodosFromBackup };
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
        const { routes } = loadMemoTodoRoutes(db);

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
        const { routes } = loadMemoTodoRoutes(db);
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
        const { routes } = loadMemoTodoRoutes(db);
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
        const { routes } = loadMemoTodoRoutes(db);
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
        const { routes } = loadMemoTodoRoutes(db);

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
        const { routes } = loadMemoTodoRoutes(db);
        const params = { id: 'nope' };

        assert.equal((await callApi(routes, 'POST /api/memos/:id', { params, body: { title: 'x', body: '' } })).statusCode, 404);
        assert.equal((await callApi(routes, 'DELETE /api/memos/:id', { params })).statusCode, 404);
        assert.equal((await callApi(routes, 'POST /api/memos/:id/pin', { params, body: { pinned: true } })).statusCode, 404);
    } finally {
        db.close();
    }
});

test('memoToClient 把 0/1 转布尔、下划线键转驼峰', () => {
    const { memoToClient } = loadMemoTodoRoutes(openDatabase(tempDbPath()));
    const row = { id: 'a', title: 't', body: 'b', pinned: 1, created_at: 1, updated_at: 2 };
    // 展开进本 realm 再比：vm 里的对象原型与本文件不同，deepStrictEqual 会假红
    assert.deepEqual({ ...memoToClient(row) }, {
        id: 'a', title: 't', body: 'b', pinned: true, createdAt: 1, updatedAt: 2
    });
});

// ========== 待办：真实处理函数 ==========

test('待办增删改查往返：建 → 读 → 改文字 → 勾选 → 取消勾选 → 删', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoTodoRoutes(db);

        let res = await callApi(routes, 'POST /api/todos', { body: { text: '  买牛奶  ' } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.todo.text, '买牛奶', '文字应 trim');
        assert.equal(res.body.todo.done, false, '新建默认未完成');
        const id = res.body.todo.id;
        assert.ok(id && id.length >= 16, '服务端生成的 id 不可预测');
        assert.equal(res.body.todo.createdAt, res.body.todo.updatedAt);

        res = await callApi(routes, 'GET /api/todos');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.todos.length, 1);
        assert.equal(res.body.pollInterval, 15, '与备忘录一样回当前生效的周期');

        res = await callApi(routes, 'POST /api/todos/:id', { params: { id }, body: { text: '买牛奶和面包' } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.todo.text, '买牛奶和面包');
        const textUpdatedAt = res.body.todo.updatedAt;

        res = await callApi(routes, 'POST /api/todos/:id/done', { params: { id }, body: { done: true } });
        assert.equal(res.statusCode, 200);
        res = await callApi(routes, 'GET /api/todos');
        assert.equal(res.body.todos[0].done, true);
        assert.equal(res.body.todos[0].updatedAt, textUpdatedAt,
            '完成态是状态变更，不动 updated_at（与备忘录的 pinned 同一条约定）');

        res = await callApi(routes, 'POST /api/todos/:id/done', { params: { id }, body: { done: false } });
        assert.equal(res.statusCode, 200);
        res = await callApi(routes, 'GET /api/todos');
        assert.equal(res.body.todos[0].done, false);

        res = await callApi(routes, 'DELETE /api/todos/:id', { params: { id } });
        assert.equal(res.statusCode, 200);
        res = await callApi(routes, 'GET /api/todos');
        assert.equal(res.body.todos.length, 0);
    } finally {
        db.close();
    }
});

test('待办按创建时间倒序；完成态不参与排序（勾选不换位）', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoTodoRoutes(db);
        const insert = db.prepare('INSERT INTO todos (id, text, done, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
        insert.run('a', '最早', 0, 1000, 1000);
        insert.run('b', '中间', 0, 2000, 2000);
        insert.run('c', '最新', 0, 3000, 3000);

        let res = await callApi(routes, 'GET /api/todos');
        assert.deepEqual([...res.body.todos.map(t => t.id)], ['c', 'b', 'a'], '新建的在上');

        await callApi(routes, 'POST /api/todos/:id/done', { params: { id: 'b' }, body: { done: true } });
        res = await callApi(routes, 'GET /api/todos');
        assert.deepEqual([...res.body.todos.map(t => t.id)], ['c', 'b', 'a'],
            '勾选后保持原位（否则连续勾选会点错下一条）');
    } finally {
        db.close();
    }
});

test('待办容量上限：第 301 条被拒；字段校验在服务端把住', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoTodoRoutes(db);
        const insert = db.prepare('INSERT INTO todos (id, text, done, created_at, updated_at) VALUES (?, ?, 0, ?, ?)');
        const now = Date.now();
        db.transaction(() => {
            for (let i = 0; i < 300; i++) insert.run(`seed-${i}`, `第 ${i} 条`, now, now);
        })();

        let res = await callApi(routes, 'POST /api/todos', { body: { text: '第 301 条' } });
        assert.equal(res.statusCode, 400);
        assert.match(res.body.error, /300/);
    } finally {
        db.close();
    }
});

test('待办字段校验：空白文字 / 超 200 字 / done 非布尔', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoTodoRoutes(db);

        let res = await callApi(routes, 'POST /api/todos', { body: { text: '   ' } });
        assert.equal(res.statusCode, 400, '只有空白的待办不算内容');

        res = await callApi(routes, 'POST /api/todos', { body: { text: 'x'.repeat(201) } });
        assert.equal(res.statusCode, 400, '客户端 maxlength 只是体验，边界在服务端');

        const created = await callApi(routes, 'POST /api/todos', { body: { text: 'y'.repeat(200) } });
        assert.equal(created.statusCode, 200, '恰好 200 字必须通过');

        res = await callApi(routes, 'POST /api/todos/:id', {
            params: { id: created.body.todo.id }, body: { text: '   ' }
        });
        assert.equal(res.statusCode, 400, '编辑同样不许空内容');

        res = await callApi(routes, 'POST /api/todos/:id/done', {
            params: { id: created.body.todo.id }, body: { done: 'yes' }
        });
        assert.equal(res.statusCode, 400, 'done 必须严格是布尔值，字符串不能让完成态落成 1');
    } finally {
        db.close();
    }
});

test('待办编辑 / 勾选 / 删除不存在的 id 都返回 404', async () => {
    const db = openDatabase(tempDbPath());
    try {
        const { routes } = loadMemoTodoRoutes(db);
        const params = { id: 'nope' };
        assert.equal((await callApi(routes, 'POST /api/todos/:id', { params, body: { text: 'x' } })).statusCode, 404);
        assert.equal((await callApi(routes, 'POST /api/todos/:id/done', { params, body: { done: true } })).statusCode, 404);
        assert.equal((await callApi(routes, 'DELETE /api/todos/:id', { params })).statusCode, 404);
    } finally {
        db.close();
    }
});

test('todoToClient 把 0/1 转布尔、下划线键转驼峰', () => {
    const { todoToClient } = loadMemoTodoRoutes(openDatabase(tempDbPath()));
    const row = { id: 'a', text: 't', done: 1, created_at: 1, updated_at: 2 };
    assert.deepEqual({ ...todoToClient(row) }, {
        id: 'a', text: 't', done: true, createdAt: 1, updatedAt: 2
    });
});

test('恢复备份时拒绝带引号的 id（否则会进前端的 data-id 属性）', () => {
    const db = openDatabase(tempDbPath());
    try {
        const { restoreMemosFromBackup, restoreTodosFromBackup } = loadMemoTodoRoutes(db);
        // 合法 id 照常恢复：服务端生成的就是这种字符集
        restoreMemosFromBackup({
            memos: [
                { id: '2f0c5e1a-9b3d-4c7e-8a1b-0d2e3f4a5b6c', title: '正常', body: '' },
                { id: 'bad" onmouseover="alert(1)', title: '注入', body: '' }
            ]
        });
        restoreTodosFromBackup({
            todos: [
                { id: 'todo-ok_1', text: '正常' },
                { id: "x' onclick='alert(1)", text: '注入' }
            ]
        });
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memos').get().n, 1, '只跳过非法 id');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM todos').get().n, 1, '只跳过非法 id');
        assert.ok(db.prepare('SELECT id FROM memos').get().id.startsWith('2f0c5e1a'));
    } finally {
        db.close();
    }
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

    // 正向枚举：用户文本（标题 / 正文 / 待办文字 / 搜索词）在哪都行，但每一处
    // 插值都必须整体包在 esc() 里。只作「存在性检查」是不够的——标题在预览行
    // 与列表行各出现一次，去掉其中一处的 esc 仍然能匹配到另一处（实测踩过）。
    const offenders = [];
    for (const tpl of [...memoSrc.matchAll(/`([^`]*)`/gs)].map(m => m[1])) {
        for (const hit of tpl.matchAll(/\$\{([^}]+)\}/g)) {
            const expr = hit[1].trim();
            if (!/\b(m\.title|m\.body|t\.text|search)\b/.test(expr)) continue;
            if (/^esc\(/.test(expr)) continue;                        // 正确写法
            if (/\.length\b/.test(expr)) continue;                    // 只取长度，得到数字
            if (/^\s*m\.title\.trim\(\)\s*\?/.test(expr)) continue;   // 三元只输出静态字面量
            offenders.push(expr);
        }
    }
    assert.deepEqual(offenders, [],
        `这些插值把用户文本直接落进了 innerHTML：${offenders.join(' | ')}`);
    // id 也必须经 esc()：恢复备份时 id 来自外部 JSON，且会进 data-id 属性。
    // 服务端另有字符集校验（RESTORE_ID_PATTERN），这里是第二道。
    const rawIdAttr = [...memoSrc.matchAll(/data-id="\$\{(?!esc\()([^}]+)\}"/g)]
        .map(m => m[1].trim());
    assert.deepEqual(rawIdAttr, [], `这些 data-id 没有转义：${rawIdAttr.join(' | ')}`);
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

test('HTTP 边界：未登录及密码头被拒绝，正常会话可增删改查', { timeout: 60000 }, async t => {
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

    const login = await fetch(`${base}/api/verify-password`, { method: 'POST', headers: { 'X-Admin-Password': 'admin123', 'X-Sylph-Request': '1' } });
    const weak = login.headers.get('set-cookie').split(';')[0];
    const changed = await fetch(`${base}/api/change-password`, { method: 'POST', headers: { Cookie: weak, 'Content-Type': 'application/json', 'X-Sylph-Request': '1' }, body: JSON.stringify({ currentPassword: 'admin123', newPassword: 'MemoTest12345!' }) });
    assert.equal(changed.status, 200);
    const auth = { Cookie: changed.headers.get('set-cookie').split(';')[0], 'X-Sylph-Request': '1' };
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

    // ③ 「管理」在正文底部，带 data-action（走那一层事件委托）。
    //    卡片正文现在拆成两个页签各自的片段函数，两处都必须带同一个「管理」。
    for (const name of ['memoCardHTML', 'todoCardHTML']) {
        const at = code.indexOf(`function ${name}() {`);
        assert.ok(at > 0, `找到 ${name}`);
        const body = code.slice(at, code.indexOf('\n    }', at));
        assert.ok(body.length > 150, `切出 ${name}（${body.length}）`);
        assert.match(body, /class="memo-card-manage"[^>]*data-action="open"/,
            `${name}：「管理」在底部小字里，仍是 data-action="open"`);
        assert.match(body, /memo-sync-part/, `${name}：同步时刻的容器也在底部小字里`);
    }
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
    assert.match(code, /action === 'retry'\)\s*poll\(\{ manual: true \}\)/,
        '失败态的「重试」确实接到手动同步上');
});

// ========== 备忘 / 待办页签与完成态 ==========

test('卡片顶部两个页签：默认备忘、正文按页签切换、页签进指纹', () => {
    const code = stripComments(memoSrc);

    assert.match(code, /let activeTab = 'memo';/, '默认展示备忘列表（只存内存，不落 localStorage）');
    assert.match(code, /function tabsHTML\(/, '有页签渲染函数');
    assert.match(code, /data-action="switch-tab" data-tab="memo"/, '备忘页签');
    assert.match(code, /data-action="switch-tab" data-tab="todo"/, '待办页签');
    assert.match(code, /data-tab="memo" aria-selected="\$\{activeTab === 'memo'\}">备忘<\/button>/,
        '备忘按钮的选中态由 activeTab 决定');
    assert.match(code, /data-tab="todo" aria-selected="\$\{activeTab === 'todo'\}">待办<\/button>/,
        '待办按钮的选中态由 activeTab 决定');
    const cardAt = code.indexOf('function renderCard() {');
    const renderBody = code.slice(cardAt, code.indexOf('\n    }', cardAt));
    assert.ok(renderBody.length > 200, `切出 renderCard（${renderBody.length}）`);
    assert.match(renderBody, /cardBody\.innerHTML = tabsHTML\(\)/,
        '页签在卡片正文顶部');
    assert.match(renderBody, /activeTab === 'memo' \? memoCardHTML\(\) : todoCardHTML\(\)/,
        '切到待办时正文换成待办清单');
    assert.match(renderBody, /cardLabel\.textContent = activeTab === 'memo' \? '备忘' : '待办'/,
        '卡片头标题跟着页签走（132px 卡片放不下「备忘与待办」）');

    // 页签与待办数据都必须进卡片指纹：切页签/勾选待办都要整块重建
    const keyAt = code.indexOf('function cardKey()');
    const keyBody = code.slice(keyAt, code.indexOf('\n    }', keyAt));
    assert.ok(keyBody.length > 80, `切出 cardKey（${keyBody.length}）`);
    assert.match(keyBody, /^\s*activeTab,/m, '页签进指纹');
    assert.match(keyBody, /todos\.map\(/, '待办数据进指纹');

    // 切页签必须直接整块重建，不能落在「没变就只刷状态」那条路径上
    const switchAt = code.indexOf('function switchTab(tab)');
    const switchBody = code.slice(switchAt, code.indexOf('\n    }', switchAt));
    assert.ok(switchBody.length > 80, `切出 switchTab（${switchBody.length}）`);
    assert.match(switchBody, /activeTab = tab;/, '记录当前页签');
    assert.match(switchBody, /renderCard\(\);/, '切页签整块重建卡片');
    assert.match(switchBody, /if \(editingTodoId\) commitTodoEdit\(\)/,
        '切换前收下未提交的就地编辑');
    assert.match(switchBody, /renderPanelMaybe\(\)/,
        '面板走「数据没变就不重渲染」的入口，不绕开守卫');
    // 面板与卡片共享同一个 activeTab
    assert.match(code, /\$\{tabsHTML\('memo-tabs-lg'\)\}/, '面板顶部也有一组页签');
    assert.match(code, /activeTab === 'memo' \? memoPanelBodyHTML\(\) : todoPanelBodyHTML\(\)/,
        '面板正文同样按页签切换');
});

test('待办完成态：删除线 + 变灰 + 斜体，规则只声明一次', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    // 只匹配基规则（`…[data-done="1"] {`）；`:hover` 那条选择器更长，不会命中
    const rules = [...css.matchAll(/\.memo-todo-text\[data-done="1"\]\s*\{([^}]*)\}/g)];
    assert.equal(rules.length, 1, `完成态基规则只声明一次，实测 ${rules.length}`);
    const body = rules[0][1];
    assert.match(body, /text-decoration:\s*line-through/, '完成态加删除线');
    assert.match(body, /font-style:\s*italic/, '完成态加斜体');
    assert.match(body, /color:\s*var\(--text-muted\)/, '完成态文字变灰');
    // 卡片与面板渲染的是同一个属性，样式才能共用一条规则
    const code = stripComments(memoSrc);
    assert.equal((code.match(/data-done="\$\{t\.done \? 1 : 0\}"/g) || []).length, 2,
        '卡片与面板两处都带 data-done');
});

test('待办就地编辑：点文字进编辑态、回车/失焦保存、Esc 取消、轮询不覆盖', () => {
    const code = stripComments(memoSrc);

    assert.match(code, /let editingTodoId = null;/, '有就地编辑状态');
    assert.match(code, /case 'edit-todo':[\s\S]{0,120}editingTodoId = id;/,
        '点文字进入编辑态');
    assert.match(code, /editingTodoId === t\.id[\s\S]{0,200}memoTodoInput/,
        '编辑态下文字按钮换成输入框');

    // 轮询期间不得重渲染面板——否则每 15 秒就把正在输入的那一行换掉
    const maybeAt = code.indexOf('function renderPanelMaybe()');
    const maybeBody = code.slice(maybeAt, code.indexOf('\n    }', maybeAt));
    assert.ok(maybeBody.length > 100, `切出 renderPanelMaybe（${maybeBody.length}）`);
    assert.match(maybeBody, /panelView === 'edit' \|\| editingTodoId\) return;/,
        '就地编辑时跳过轮询重渲染');

    // 三条提交路径各自存在且真的接到了提交函数
    const keydownAt = code.indexOf("panelEl.addEventListener('keydown'");
    const keydown = code.slice(keydownAt, code.indexOf('\n        });', keydownAt));
    assert.ok(keydown.length > 200, `切出 keydown（${keydown.length}）`);
    assert.match(keydown, /key === 'Enter'[\s\S]{0,200}commitTodoEdit\(\)/, '回车保存');
    assert.match(keydown, /key === 'Escape'[\s\S]{0,200}cancelTodoEdit\(\)/, 'Esc 取消');
    assert.match(keydown, /stopPropagation\(\)/, 'Esc 不能连带把整个面板关掉');

    const focusAt = code.indexOf("panelEl.addEventListener('focusout'");
    const focus = code.slice(focusAt, code.indexOf('\n        });', focusAt));
    assert.match(focus, /memoTodoInput[\s\S]{0,120}commitTodoEdit\(\)/, '失焦保存');

    // 行内按钮在 pointerdown 先拦截：不拦的话输入框失焦 → 重渲染 → click 落空
    const pdAt = code.indexOf("panelEl.addEventListener('pointerdown'");
    const pd = code.slice(pdAt, code.indexOf('\n        });', pdAt));
    assert.match(pd, /preventDefault\(\)/, '行内操作按钮的 pointerdown 先拦截');

    // 保存成功后退出编辑态；空内容回退原文
    const commitAt = code.indexOf('async function commitTodoEdit()');
    const commit = code.slice(commitAt, code.indexOf('\n    }', commitAt));
    assert.ok(commit.length > 200, `切出 commitTodoEdit（${commit.length}）`);
    assert.match(commit, /editingTodoId = null;/, '先退出编辑态，避免重渲染触发第二次提交');
    assert.match(commit, /if \(!text\)[\s\S]{0,160}不能为空/, '空内容不落库');
    assert.match(commit, /saveTodo\(id, text\)/, '走同一个保存入口');
});

test('卡片上的待办行：勾选框直接切完成态，点文字打开面板', () => {
    const code = stripComments(memoSrc);
    const at = code.indexOf('function todoCardHTML() {');
    const body = code.slice(at, code.indexOf('\n    }', at));
    assert.ok(body.length > 200, `切出 todoCardHTML（${body.length}）`);
    assert.match(body, /todoCheckHTML\(t\)/, '卡片复用共用的勾选框标记');
    assert.match(body, /data-action="open"[^>]*data-done=/, '点文字打开面板（编辑只在面板里）');
    // 勾选框的 data-action 在共用标记里；委托里必须有这条分支，否则它是死按钮
    const checkAt = code.indexOf('function todoCheckHTML(t) {');
    const checkBody = code.slice(checkAt, code.indexOf('\n    }', checkAt));
    assert.match(checkBody, /data-action="toggle-todo"/, '勾选框直接切完成态');
    assert.match(code, /else if \(action === 'toggle-todo'\)/, '卡片的勾选分支存在');
    assert.match(code, /todos\.find\(x => x\.id === t\.dataset\.id\)[\s\S]{0,80}toggleTodo/,
        '找到待办后调用 toggleTodo');
});

test('待办达到 300 条上限时禁用添加（客户端不送必然被拒的请求）', () => {
    const code = stripComments(memoSrc);
    assert.match(code, /const full = todos\.length >= TODO_MAX_ENTRIES/);
    assert.match(code, /placeholder="\$\{full \? '已达上限' : '添加待办，回车保存'\}"\$\{full \? ' disabled' : ''\}/,
        '输入框在满额时禁用');
    assert.match(code, /data-action="add-todo"\$\{full \? ' disabled' : ''\}/,
        '添加按钮在满额时禁用');
});

test('窄屏 44px 下限覆盖卡片页签与勾选（不只面板）', () => {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    const blocks = [...css.matchAll(/@media \(max-width: 1023px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]);
    const memoBlock = blocks.find(b => b.includes('.memo-todo-check-wrap'));
    assert.ok(memoBlock, '找到备忘模块的窄屏块');
    assert.match(memoBlock, /\.memo-tab, \.memo-panel \.memo-tab \{[^}]*min-height:\s*44px/,
        '卡片与面板的页签都抬到 44px');
    assert.match(memoBlock, /\.memo-todo-check-wrap, \.memo-panel \.memo-todo-check-wrap \{[^}]*width:\s*44px/,
        '卡片与面板的勾选热区都抬到 44px');
});

// ========== 执行真实片段（不只匹配源码文本） ==========
//
// 源码存在性断言可以被「函数还在、但什么都不做」骗过：把 switchTab 改成空函数、
// 把完成态标记删掉，正则仍然能匹配到。下面这些用例切出函数体、注入依赖真跑一遍。

/** 从源码切出顶层 `function name(...) { ... }`；模板里的 `${}` 成对，不影响配对。 */
function extractFunction(src, name) {
    let at = src.indexOf(`function ${name}(`);
    assert.ok(at > 0, `找到函数 ${name}`);
    // `async function` 的 async 在 'function' 之前：不带上它，函数体里的 await
    // 会在 new Function 里直接 SyntaxError（症状是「测试文件加载失败」而不是断言）。
    if (src.slice(Math.max(0, at - 6), at) === 'async ') at -= 6;
    const open = src.indexOf('{', at);
    assert.ok(open > at, `${name} 的函数体起点可定位`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                const text = src.slice(at, i + 1);
                assert.ok(text.length > 60, `${name} 切片长度合理（${text.length}）`);
                return text;
            }
        }
    }
    throw new Error(`${name} 未闭合`);
}

test('tabsHTML 真跑：选中态跟着 activeTab 走', () => {
    const body = extractFunction(memoSrc, 'tabsHTML');
    const render = activeTab => new Function('activeTab', `${body}; return tabsHTML('');`)(activeTab);
    const memoHtml = render('memo');
    assert.match(memoHtml, /data-tab="memo" aria-selected="true">备忘<\/button>/, '备忘选中');
    assert.match(memoHtml, /data-tab="todo" aria-selected="false">待办<\/button>/, '待办未选中');
    const todoHtml = render('todo');
    assert.match(todoHtml, /data-tab="memo" aria-selected="false">备忘<\/button>/);
    assert.match(todoHtml, /data-tab="todo" aria-selected="true">待办<\/button>/, '待办选中');
});

test('switchTab 真跑：真的切状态并重渲染；有未提交的编辑先保存', () => {
    const body = extractFunction(memoSrc, 'switchTab');

    function build({ editing = false, panelOpen = true } = {}) {
        const calls = [];
        const api = new Function('renderCard', 'renderPanelMaybe', 'commitTodoEdit', `
            let activeTab = 'memo';
            let editingTodoId = ${editing ? "'t1'" : 'null'};
            let panel = ${panelOpen ? '{}' : 'null'};
            let panelView = 'list';
            ${body}
            return { switchTab, state: () => ({ activeTab, editingTodoId }) };
        `)(
            () => calls.push('card'),
            () => calls.push('panel'),
            () => calls.push('commit')
        );
        return { api, calls };
    }

    const a = build();
    a.api.switchTab('todo');
    assert.equal(a.api.state().activeTab, 'todo', '真的切到待办');
    assert.deepEqual(a.calls, ['card', 'panel'], '卡片与面板都重渲染');
    a.api.switchTab('bogus');
    assert.equal(a.api.state().activeTab, 'todo', '非法页签不切换');
    a.api.switchTab('todo');
    assert.deepEqual(a.calls, ['card', 'panel'], '重复点击同一页签不重渲染');

    const b = build({ editing: true });
    b.api.switchTab('todo');
    assert.deepEqual(b.calls, ['commit', 'card', 'panel'], '先收下未提交的就地编辑再切换');

    const c = build({ panelOpen: false });
    c.api.switchTab('todo');
    assert.deepEqual(c.calls, ['card'], '面板没开时只重渲染卡片');
});

test('todoCardHTML 真跑：完成态、转义、预览条数与计数', () => {
    const escBody = extractFunction(memoSrc, 'esc');
    const checkBody = extractFunction(memoSrc, 'todoCheckHTML');
    const cardBody = extractFunction(memoSrc, 'todoCardHTML');
    const render = todos => new Function('todos', 'TODO_PREVIEW_ROWS', `
        ${escBody}
        ${checkBody}
        ${cardBody}
        return todoCardHTML();
    `)(todos, 4);

    const extra = Array.from({ length: 5 }, (_, i) => ({
        id: `x${i}`, text: `第 ${i} 条`, done: false, createdAt: 1, updatedAt: 1
    }));
    const html = render([
        { id: 't1', text: '<b>完成</b>', done: true, createdAt: 3, updatedAt: 4 },
        { id: 't2', text: '未完成', done: false, createdAt: 2, updatedAt: 2 },
        ...extra
    ]);

    assert.match(html, /data-done="1"[^>]*>&lt;b&gt;完成&lt;\/b&gt;/, '完成态 + 文字已转义');
    assert.match(html, /data-id="t1" checked aria-label="标记未完成"/, '完成项勾选框已勾上');
    assert.equal((html.match(/class="memo-row memo-todo-row"/g) || []).length, 4, '预览最多 4 条');
    assert.match(html, /共 7 项 · 6 未完成/, '计数与未完成数来自真实数据');
});

test('toggleTodo 真跑：请求失败时把完成态回滚', async () => {
    const body = extractFunction(memoSrc, 'toggleTodo');
    const events = [];
    const fn = new Function('api', 'window', 'renderCard', 'renderPanelMaybe',
        `${body}
         return toggleTodo;`)(
        { post: async () => { throw new Error('offline'); } },
        { app: { showToast: (msg, kind) => events.push(`toast:${kind}:${msg}`) } },
        () => events.push('render'),
        () => events.push('panel')
    );

    const todo = { id: 't1', done: false };
    await fn(todo);
    assert.equal(todo.done, false, '失败后回滚到未完成');
    assert.equal(events.filter(e => e === 'render').length, 2, '乐观更新与回滚各重渲染一次');
    assert.ok(events.some(e => e.startsWith('toast:error')), '失败必须报错');
});

test('saveTodo 真跑：断网时进离线草稿队列（编辑与新建各一条）', async () => {
    const body = extractFunction(memoSrc, 'saveTodo');
    const fn = new Function('api', 'window', 'renderCard', 'renderPanelMaybe', 'persistTodoDrafts', 'setSyncState', `
        let todoDrafts = [];
        let lastSync = null;
        ${body}
        return { saveTodo, get drafts() { return todoDrafts; } };
    `)(
        { post: async () => { throw new Error('offline'); } },
        { app: { showToast: () => {} } },
        () => {}, () => {}, () => {}, () => {}
    );

    assert.equal(await fn.saveTodo('t1', '改后的文字'), false, '断网返回 false');
    assert.equal(await fn.saveTodo(null, '新的待办'), false);
    assert.equal(fn.drafts.length, 2);
    assert.equal(fn.drafts[0].id, 't1');
    assert.equal(fn.drafts[0].text, '改后的文字');
    assert.equal(fn.drafts[1].id, null, '新建草稿没有 id');
    assert.ok(fn.drafts.every(d => typeof d.ts === 'number' && d.ts > 0), '草稿带时间戳');
});

test('commitTodoEdit 真跑：空内容不落库，只提示并退出编辑态', async () => {
    const body = extractFunction(memoSrc, 'commitTodoEdit');
    const events = [];
    let saved = 0;
    const api = new Function('renderPanel', 'window', 'saveTodo', `
        let panel = { panelEl: { querySelector: () => ({ value: '   ' }) } };
        let editingTodoId = 't1';
        let todos = [{ id: 't1', text: '原文' }];
        ${body}
        return { commitTodoEdit, get editingTodoId() { return editingTodoId; } };
    `)(
        () => events.push('render'),
        { app: { showToast: (msg, kind) => events.push(`${kind}:${msg}`) } },
        () => { saved++; return true; }
    );

    await api.commitTodoEdit();
    assert.equal(saved, 0, '空内容不调用保存');
    assert.equal(api.editingTodoId, null, '退出编辑态');
    assert.ok(events.includes('error:待办内容不能为空'), '给出提示');
});

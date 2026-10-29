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
    const dir = fs.mkdtempSync(path.join(process.env.COMMANDCODE_SCRATCHPAD || os.tmpdir(), 'sylph-memo-db-'));
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
    assert.match(stripComments(appSource), /static KNOWN_MODULES = \[[^\]]*'memo'/,
        '白名单不含 memo 的话 loadModule 会直接拒绝加载');
    assert.match(stripComments(memoSrc), /window\.app\.registerModule\(\{/);
    assert.match(stripComments(memoSrc), /id: 'memo'/);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'modules', 'memo.js')));
});

test('sw.js 预缓存 memo.js，且 CACHE 与注释里最新的一级一致', () => {
    assert.match(stripComments(swSource), /'\/modules\/memo\.js'/,
        '延后加载也要预缓存：否则回访用户每次打开模块区都要走一次网络');

    const cache = swSource.match(/const CACHE = '([^']+)'/)[1];
    const versions = [...swSource.matchAll(/nav-v(\d+)/g)].map(m => Number(m[1]));
    const newest = Math.max(...versions);
    assert.equal(cache, `nav-v${newest}`,
        `CACHE ${cache} 必须等于注释里记录的最新版本 nav-v${newest}——改了 public/ 不升缓存名，老用户拿不到`);
});

test('备忘录模块把用户文本经 esc() 落进模板，原始字段不得直接插入', () => {
    assert.match(stripComments(memoSrc), /function esc\(/, '模块内自带转义助手');

    // 正向枚举：用户文本（标题 / 正文 / 待办文字 / 搜索词）在哪都行，但每一处
    // 插值都必须整体包在 esc() 里。只作「存在性检查」是不够的——标题在预览行
    // 与列表行各出现一次，去掉其中一处的 esc 仍然能匹配到另一处（实测踩过）。
    const offenders = [];
    for (const tpl of [...stripComments(memoSrc).matchAll(/`([^`]*)`/gs)].map(m => m[1])) {
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
    const rawIdAttr = [...stripComments(memoSrc).matchAll(/data-id="\$\{(?!esc\()([^}]+)\}"/g)]
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
    const memoIds = [...stripComments(memoSrc).matchAll(/(?<![-\w])id="([^"]+)"/g)].map(m => m[1]);
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
    const tmp = fs.mkdtempSync(path.join(process.env.COMMANDCODE_SCRATCHPAD || os.tmpdir(), 'sylph-memo-e2e-'));
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
    assert.match(fillBody, /cardFooter\?\.querySelector\('\.memo-sync-part'\)/);
    assert.match(fillBody, /part\.innerHTML = .*statusPillHTML\(\).*pendingPillHTML\(\)/);
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
    assert.match(code, /head\.innerHTML = tabsHTML\(\)/, '页签在稳定头部');
    assert.doesNotMatch(renderBody, /tabsHTML\(/, '正文重建不销毁页签');
    assert.match(renderBody, /activeTab === 'memo' \? memoCardHTML\(\) : todoCardHTML\(\)/,
        '切到待办时正文换成待办清单');
    assert.doesNotMatch(code, /cardLabel|cardStatus/, '旧标题与头状态已移除');

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
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));
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
    assert.match(code, /case 'edit-todo':[\s\S]{0,320}editingTodoId = id;/,
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
    const commitAt = code.indexOf('async function commitTodoEdit(');
    const commit = code.slice(commitAt, code.indexOf('\n    }', commitAt));
    assert.ok(commit.length > 200, `切出 commitTodoEdit（${commit.length}）`);
    assert.match(commit, /editingTodoId = null;/, '先退出编辑态，避免重渲染触发第二次提交');
    assert.match(commit, /if \(!text\)[\s\S]{0,160}不能为空/, '空内容不落库');
    assert.match(commit, /saveTodo\(id, text\)/, '走同一个保存入口');
});

test('卡片上的待办行：勾选框直接切完成态，点文字直达指定编辑', () => {
    const code = stripComments(memoSrc);
    const at = code.indexOf('function todoCardHTML() {');
    const body = code.slice(at, code.indexOf('\n    }', at));
    assert.ok(body.length > 200, `切出 todoCardHTML（${body.length}）`);
    assert.match(body, /todoCheckHTML\(t\)/, '卡片复用共用的勾选框标记');
    assert.match(body, /data-action="open-todo-edit" data-id="\$\{esc\(t\.id\)\}"/, '点文字传入目标 id 编辑');
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
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));
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
    // 参数里可能有默认值解构（`{ epoch } = {}`）：先配平括号，再找函数体左花括号，
    // 否则会把参数里的 `}` 当成函数结束（切出 39 个字符）。
    const openParen = src.indexOf('(', at);
    let parenDepth = 0;
    let closeParen = -1;
    for (let i = openParen; i < src.length; i++) {
        if (src[i] === '(') parenDepth++;
        else if (src[i] === ')') {
            parenDepth--;
            if (parenDepth === 0) { closeParen = i; break; }
        }
    }
    assert.ok(closeParen > openParen, `${name} 的参数括号可配平`);
    const open = src.indexOf('{', closeParen);
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
        const api = new Function('renderCard', 'renderPanelMaybe', 'commitTodoEdit', 'saveCardScroll', `
            let activeTab = 'memo';
            let editingTodoId = ${editing ? "'t1'" : 'null'};
            let panel = ${panelOpen ? '{}' : 'null'};
            let panelView = 'list';
            ${body}
            return { switchTab, state: () => ({ activeTab, editingTodoId }) };
        `)(
            () => calls.push('card'),
            () => calls.push('panel'),
            () => calls.push('commit'),
            () => calls.push(`scroll:${api.state().activeTab}`)
        );
        return { api, calls };
    }

    const a = build();
    a.api.switchTab('todo');
    assert.equal(a.api.state().activeTab, 'todo', '真的切到待办');
    assert.deepEqual(a.calls, ['scroll:memo', 'card', 'panel'], '卡片与面板都重渲染');
    a.api.switchTab('bogus');
    assert.equal(a.api.state().activeTab, 'todo', '非法页签不切换');
    a.api.switchTab('todo');
    assert.deepEqual(a.calls, ['scroll:memo', 'card', 'panel'], '重复点击同一页签不重渲染');

    const b = build({ editing: true });
    b.api.switchTab('todo');
    assert.deepEqual(b.calls, ['commit', 'scroll:memo', 'card', 'panel'], '先收下未提交的就地编辑再切换');

    const c = build({ panelOpen: false });
    c.api.switchTab('todo');
    assert.deepEqual(c.calls, ['scroll:memo', 'card'], '面板没开时只重渲染卡片');
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
    const textOfBody = extractFunction(memoSrc, 'todoTextOf');
    const events = [];
    let saved = 0;
    const api = new Function('renderPanel', 'window', 'saveTodo', 'renderCardMaybe', `
        let panel = { panelEl: { querySelector: () => ({ value: '   ' }) }, epoch: 1 };
        let editingTodoId = 't1';
        let todos = [{ id: 't1', text: '原文' }];
        let todoDrafts = [];
        const failedTodoEdits = new Map();
        let panelRendering = false;
        let activeTab = 'todo';
        let panelView = 'list';
        ${textOfBody}
        ${body}
        return { commitTodoEdit, get editingTodoId() { return editingTodoId; } };
    `)(
        () => events.push('render'),
        { app: { showToast: (msg, kind) => events.push(`${kind}:${msg}`) } },
        () => { saved++; return true; },
        () => events.push('card')
    );

    await api.commitTodoEdit();
    assert.equal(saved, 0, '空内容不调用保存');
    assert.equal(api.editingTodoId, null, '退出编辑态');
    assert.ok(events.includes('error:待办内容不能为空'), '给出提示');
});

class MemoElement {
    constructor(tag, document) {
        this.tagName = tag;
        this.ownerDocument = document;
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.listeners = {};
        this.scrollTop = 0;
        this.writes = 0;
        this.value = '';
        this._text = '';
        this.history = [];
    }
    set className(value) { this.setAttribute('class', value); }
    get className() { return this.attributes.class || ''; }
    get id() { return this.attributes.id; }
    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
        if (name === 'value') this.value = String(value);
        this.writes++;
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    appendChild(node) { node.parent = this; this.children.push(node); return node; }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this);
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    matches(selector) {
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
        if (selector.startsWith('[')) {
            const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) || [];
            return name && this.getAttribute(name) !== null && (value === undefined || this.getAttribute(name) === value);
        }
        return this.tagName === selector;
    }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(listener => listener !== fn); }
    fire(type, target = this, extra = {}) {
        const event = { target, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
        for (const listener of this.listeners[type] || []) listener(event);
        return event;
    }
    focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
    select() { this.selected = true; }
    setSelectionRange(start, end) { this.selection = [start, end]; }
    scrollIntoView(options) { this.scrollOptions = options; }
    set textContent(value) { this._text = String(value); this.children = []; this.writes++; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(html) {
        this._html = String(html);
        this.history.push(this._html);
        this.children = [];
        this._text = '';
        this.writes++;
        const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));
        const stack = [this];
        for (const token of this._html.match(/<[^>]*>|[^<]+/g) || []) {
            if (token.startsWith('</')) { stack.pop(); continue; }
            if (!token.startsWith('<')) { stack.at(-1)._text += decode(token); continue; }
            const tag = token.match(/^<([\w-]+)/)?.[1];
            if (!tag) continue;
            const node = new MemoElement(tag, this.ownerDocument);
            for (const attr of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)) {
                node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? ''));
            }
            stack.at(-1).appendChild(node);
            if (!['input', 'br', 'hr', 'img'].includes(tag) && !token.endsWith('/>')) stack.push(node);
        }
    }
    get innerHTML() { return this._html || ''; }
}

function memoRuntime(source = memoSrc, { memoCount = 8, todoCount = 9, post } = {}) {
    const document = new MemoElement('document', null);
    document.ownerDocument = document;
    document.body = new MemoElement('body', document);
    document.appendChild(document.body);
    document.createElement = tag => new MemoElement(tag, document);
    const memos = Array.from({ length: memoCount }, (_, i) => ({ id: `m${i}`, title: `备忘 ${i}`, body: '正文', pinned: i === 0, createdAt: 100 - i, updatedAt: 100 - i }));
    const todos = Array.from({ length: todoCount }, (_, i) => ({ id: `t${i}`, text: `待办 ${i}`, done: i === todoCount - 1, createdAt: 100 - i, updatedAt: 100 - i }));
    let definition;
    let ready;
    let failed = false;
    let stacks = 0;
    const requests = [];
    const toasts = [];
    let clock = Date.now();
    class MemoClock extends Date { static now() { return clock; } }
    const context = vm.createContext({
        document,
        window: { app: { registerModule: value => { definition = value; }, showToast: (...args) => toasts.push(args) } },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        console: { error() {}, warn() {} },
        setInterval: () => 1,
        clearInterval() {},
        Date: MemoClock
    });
    const marker = '    window.app.registerModule({';
    assert.equal(source.split(marker).length, 2);
    const instrumented = source.replace(marker, '    globalThis.inspectMemo = code => eval(code);\n' + marker);
    vm.runInContext(instrumented, context);
    const api = {
        get: async url => {
            requests.push(['get', url]);
            if (failed) throw new Error('offline');
            return url === '/api/memos' ? { memos: memos.map(m => ({ ...m })) } : { todos: todos.map(t => ({ ...t })) };
        },
        post: async (url, body) => {
            requests.push(['post', url, body]);
            return post ? post(url, body) : {};
        }
    };
    const [card] = definition.mountWidget(null, { api, requestStack: () => { stacks++; }, whenReady: promise => { ready = promise; } });
    const run = code => context.inspectMemo(code);
    return {
        document, card, run, requests, toasts, memos, todos, definition,
        ready: () => ready,
        fail: value => { failed = value; },
        advance: ms => { clock += ms; },
        get stacks() { return stacks; },
        get body() { return card.querySelector('.module-widget-body'); },
        get head() { return card.querySelector('.module-widget-head'); },
        get footer() { return card.querySelector('.memo-card-footer'); },
        get rows() { return card.querySelector('.memo-rows'); },
        get panel() { return document.body.querySelector('.memo-panel'); },
        click(action, id) {
            const target = card.querySelectorAll('[data-action]').find(node => node.dataset.action === action && (id === undefined || node.dataset.id === id));
            assert.ok(target, `卡片按钮存在：${action}/${id}`);
            card.fire('click', target);
        }
    };
}

const settleMemo = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function assertCompleteMemoLists(source = memoSrc) {
    const h = memoRuntime(source, { memoCount: 20, todoCount: 30 });
    await h.ready();
    assert.equal(h.body.querySelectorAll('.memo-row').length, 20);
    assert.match(h.body.innerHTML, /备忘 19/);
    assert.equal(h.rows.getAttribute('tabindex'), '0');
    assert.equal(h.rows.getAttribute('aria-label'), '备忘列表');
    assert.equal(h.footer.querySelector('.memo-card-count').textContent, '共 20 条');
    h.card.fire('click', h.head.querySelector('[data-tab="todo"]'));
    assert.equal(h.body.querySelectorAll('.memo-todo-row').length, 30);
    assert.match(h.body.innerHTML, /待办 29/);
    assert.equal(h.rows.getAttribute('aria-label'), '待办列表');
    assert.equal(h.footer.querySelector('.memo-card-count').textContent, '共 30 项 · 29 未完成');
    h.run(`todos[29].id = 'last"<'; todos[29].text = '<b>完成</b>'; renderCard()`);
    assert.match(h.body.innerHTML, /data-id="last&quot;&lt;"/);
    assert.match(h.body.innerHTML, /data-done="1"[^>]*>&lt;b&gt;完成&lt;\/b&gt;/);
    assert.match(h.body.innerHTML, /data-id="last&quot;&lt;" checked aria-label="标记未完成"/);
    h.run("memos[19].title = '<img>'; switchTab('memo')");
    assert.match(h.body.innerHTML, /&lt;img&gt;/);
    h.run("memos = []; todos = []; renderCard()");
    assert.match(h.body.innerHTML, /还没有备忘/);
    h.run("switchTab('todo')");
    assert.match(h.body.innerHTML, /还没有待办/);
}

test('真实完整模块：备忘与待办超过旧预览上限仍含末项、计数、空态、转义与完成态', () => assertCompleteMemoLists());

async function assertStableMemoShell(source = memoSrc) {
    const h = memoRuntime(source);
    await h.ready();
    assert.equal(h.card.getAttribute('aria-label'), '备忘与待办');
    assert.equal(h.card.dataset.instanceId, 'memo:main');
    assert.equal(h.card.children.length, 3);
    assert.equal(h.head.children.length, 1);
    assert.equal(h.head.children[0].getAttribute('role'), 'tablist');
    assert.equal(h.head.querySelectorAll('.module-card-status').length, 0);
    assert.equal(h.body.querySelectorAll('.memo-tabs').length, 0);
    assert.equal(h.body.querySelectorAll('.memo-card-manage').length, 0);
    const handle = h.footer.querySelector('.module-drag-handle');
    assert.ok(handle);
    assert.equal(handle.getAttribute('hidden'), null);
    const tab = h.head.querySelector('[data-tab="todo"]');
    const writes = h.head.writes;
    tab.focus();
    h.card.fire('click', tab);
    assert.equal(h.head.writes, writes);
    assert.equal(h.document.activeElement, tab);
    assert.equal(tab.getAttribute('aria-selected'), 'true');
    assert.equal(h.head.querySelector('[data-tab="memo"]').getAttribute('aria-selected'), 'false');
    assert.equal(h.footer.querySelector('.module-drag-handle'), handle);
    assert.equal(h.footer.querySelectorAll('.memo-card-manage').length, 1);
}

test('真实挂载：首行仅稳定页签，底部计数/管理/把手，切页不重建首行或丢焦点', () => assertStableMemoShell());

async function assertMemoScroll(source = memoSrc) {
    const h = memoRuntime(source, { post: async () => { throw new Error('offline'); } });
    await h.ready();
    h.rows.scrollTop = 91;
    h.run("switchTab('todo')");
    assert.equal(h.rows.scrollTop, 0);
    h.rows.scrollTop = 173;
    h.run("switchTab('memo')");
    assert.equal(h.rows.scrollTop, 91);
    h.run("switchTab('todo')");
    assert.equal(h.rows.scrollTop, 173);
    const input = h.body.querySelectorAll('[data-action]').find(node => node.dataset.action === 'toggle-todo' && node.dataset.id === 't8');
    input.focus();
    h.card.fire('click', input);
    assert.equal(h.rows.scrollTop, 173);
    await settleMemo();
    assert.equal(h.rows.scrollTop, 173);
    assert.equal(h.run('todos[8].done'), true);
    assert.equal(h.document.activeElement.dataset.id, 't8');
    assert.equal(h.document.activeElement.dataset.action, 'toggle-todo');
    assert.equal(h.document.activeElement.focusOptions.preventScroll, true);
    h.run('todos[8].updatedAt++; renderCardMaybe()');
    assert.equal(h.rows.scrollTop, 173);
    h.run("switchTab('memo')");
    h.rows.scrollTop = 117;
    h.run('memos[0].updatedAt = Date.now() - 120000; renderCardMaybe()');
    assert.equal(h.rows.scrollTop, 117);
    const beforeTime = h.body.writes;
    h.advance(60000);
    h.run('renderCardMaybe()');
    assert.ok(h.body.writes > beforeTime);
    assert.equal(h.rows.scrollTop, 117);
    assert.deepEqual({ ...h.run('cardScroll') }, { memo: 117, todo: 173 });
}

test('真实滚动流程：双页签独立记忆，勾选/失败回滚/数据与相对时间重建恢复滚动及焦点', () => assertMemoScroll());

async function assertMemoBottomStatus(source = memoSrc) {
    const h = memoRuntime(source);
    await h.ready();
    const sync = h.footer.querySelector('.memo-sync-part');
    assert.match(sync.innerHTML, /\d{2}:\d{2}同步/);
    assert.doesNotMatch(sync.innerHTML, /重试|同步失败|待同步/);
    const bodyWrites = h.body.writes;
    const statusWrites = sync.writes;
    const stacks = h.stacks;
    await h.run('poll()');
    assert.equal(h.body.writes, bodyWrites);
    assert.equal(sync.writes, statusWrites);
    assert.equal(h.stacks, stacks);
    h.fail(true);
    await h.run('poll()');
    assert.match(sync.innerHTML, /同步失败/);
    assert.ok(sync.querySelector('[data-action="retry"]'));
    assert.doesNotMatch(sync.innerHTML, /\d{2}:\d{2}同步/);
    assert.equal(h.body.writes, bodyWrites);
    assert.ok(h.stacks > stacks);
    assert.match(h.body.innerHTML, /备忘 7/);
    h.fail(false);
    const before = h.requests.length;
    h.click('retry');
    assert.match(sync.innerHTML, /同步中/);
    await settleMemo();
    assert.equal(h.requests.length - before, 2);
    assert.match(sync.innerHTML, /\d{2}:\d{2}同步/);
    assert.doesNotMatch(sync.innerHTML, /同步失败|重试/);
    await h.run("api.post = async () => { throw new Error('offline') }; saveTodo('t0', '离线修改')");
    await h.run("saveMemo('m0', '离线标题', '离线正文')");
    assert.match(sync.innerHTML, /待同步 2/);
    assert.equal(h.head.querySelectorAll('.module-card-status').length, 0);
    const unchanged = [h.body.writes, sync.writes, h.stacks];
    h.run('renderCardMaybe()');
    assert.deepEqual([h.body.writes, sync.writes, h.stacks], unchanged);
}

test('真实底部状态：成功时刻、失败保留列表、委托重试/同步中/恢复、双类离线待同步与零变化零写入', () => assertMemoBottomStatus());

async function assertMemoTarget(source = memoSrc) {
    for (const id of ['t0', 't8']) {
        const h = memoRuntime(source);
        await h.ready();
        h.run("switchTab('todo')");
        h.click('open-todo-edit', id);
        assert.equal(h.document.body.querySelectorAll('.module-overlay').length, 1);
        assert.equal(h.panel.history.length, 1);
        assert.match(h.panel.history[0], new RegExp(`id="memoTodoInput"[^>]*data-id="${id}"`));
        const input = h.panel.querySelector('#memoTodoInput');
        assert.ok(input);
        assert.equal(input.value, id === 't0' ? '待办 0' : '待办 8');
        assert.equal(h.document.activeElement, input);
        assert.equal(input.selected, true);
        assert.equal(input.focusOptions.preventScroll, true);
        assert.equal(input.scrollOptions.block, 'nearest');
        const overlay = h.definition.openPanel({ todoId: id });
        assert.equal(overlay, h.document.body.querySelector('.module-overlay'));
        await settleMemo();
        assert.equal(h.panel.querySelector('#memoTodoInput'), input);
        assert.equal(h.document.listeners.keydown.length, 1);
        assert.equal(h.document.body.querySelectorAll('.module-overlay').length, 1);
    }
}

test('真实卡片 action/id → openPanel：首项/末项已完成项首次渲染即目标编辑、聚焦全选滚入、复用同一面板', () => assertMemoTarget());

test('真实管理与 invalid：无参保留当前页签不自动编辑，勾选不打开面板，不存在 id 回退待办清单', async () => {
    const h = memoRuntime();
    await h.ready();
    h.click('open');
    assert.equal(h.panel.querySelector('#memoTodoInput'), null);
    assert.ok(h.panel.querySelector('#memoSearch'));
    h.run('panel.close()');
    h.run("switchTab('todo')");
    h.click('toggle-todo', 't0');
    await settleMemo();
    assert.equal(h.panel, null);
    h.click('open');
    assert.ok(h.panel.querySelector('#memoTodoNew'));
    assert.equal(h.panel.querySelector('#memoTodoInput'), null);
    h.run('panel.close()');
    h.run("switchTab('memo')");
    h.definition.openPanel({ todoId: 'missing' });
    assert.ok(h.panel.querySelector('#memoTodoNew'));
    assert.equal(h.panel.querySelector('#memoTodoInput'), null);
    assert.match(h.toasts.at(-1)[0], /已不存在/);
    assert.equal(h.document.listeners.keydown.length, 1);
    h.definition.openPanel({ todoId: 't8' });
    await settleMemo();
    assert.equal(h.panel.querySelector('#memoTodoInput').dataset.id, 't8');
    h.definition.openPanel({ todoId: 'missing-again' });
    await settleMemo();
    assert.equal(h.panel.querySelector('#memoTodoInput'), null);
    assert.equal(h.document.body.querySelectorAll('.module-overlay').length, 1);
});

test('真实复用保护：未保存备忘与新增待办不被目标跳转覆盖，轮询保留输入', async () => {
    const h = memoRuntime();
    await h.ready();
    h.click('open');
    h.panel.fire('click', h.panel.querySelector('[data-action="add"]'));
    const title = h.panel.querySelector('#memoTitle');
    title.value = '未保存备忘';
    h.definition.openPanel({ todoId: 't8' });
    await settleMemo();
    assert.equal(h.panel.querySelector('#memoTitle'), title);
    assert.equal(title.value, '未保存备忘');
    assert.match(h.toasts.at(-1)[0], /先保存或取消/);
    h.run('renderPanelMaybe()');
    assert.equal(h.panel.querySelector('#memoTitle'), title);
    h.panel.fire('click', h.panel.querySelector('[data-action="back"]'));
    h.run("switchTab('todo')");
    const add = h.panel.querySelector('#memoTodoNew');
    add.value = '未添加待办';
    h.definition.openPanel({ todoId: 't8' });
    await settleMemo();
    assert.equal(h.panel.querySelector('#memoTodoNew'), add);
    assert.equal(add.value, '未添加待办');
    assert.match(h.toasts.at(-1)[0], /先添加或清空/);
    add.value = '';
    h.definition.openPanel({ todoId: 't8' });
    await settleMemo();
    const input = h.panel.querySelector('#memoTodoInput');
    input.value = '正在编辑';
    await h.run('poll()');
    assert.equal(h.panel.querySelector('#memoTodoInput'), input);
    assert.equal(input.value, '正在编辑');
    h.definition.openPanel({ todoId: 't8' });
    await settleMemo();
    assert.equal(h.panel.querySelector('#memoTodoInput'), input);
    assert.equal(input.value, '正在编辑');
});

test('真实切换编辑目标：先提交，服务拒绝保留输入，断网草稿可保留后切换', async () => {
    for (const mode of ['success', 'rejected', 'offline']) {
        const h = memoRuntime(memoSrc, { post: async (url, body) => {
            if (mode === 'offline') throw new Error('offline');
            if (mode === 'rejected') return { error: '保存被拒绝' };
            return { todo: { id: 't0', text: body.text, done: false, createdAt: 100, updatedAt: 200 } };
        } });
        await h.ready();
        h.definition.openPanel({ todoId: 't0' });
        h.panel.querySelector('#memoTodoInput').value = '修改后';
        const overlay = h.definition.openPanel({ todoId: 't8' });
        await settleMemo();
        assert.equal(h.requests.filter(([method, url]) => method === 'post' && url === '/api/todos/t0').length, 1);
        assert.equal(h.panel.querySelector('#memoTodoInput').dataset.id, mode === 'rejected' ? 't0' : 't8');
        if (mode === 'rejected') assert.equal(h.panel.querySelector('#memoTodoInput').value, '修改后');
        if (mode === 'offline') assert.equal(h.run('todoDrafts[0].text'), '修改后');
        assert.equal(h.document.body.querySelector('.module-overlay'), overlay);
        assert.equal(h.document.listeners.keydown.length, 1);
    }
});

function delayedMemoPost() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

for (const result of ['success', 'rejected', 'offline']) {
    for (const reentry of ['target', 'inline', 'reopen', 'memo']) {
        test(`真实延迟交错：${result}/${reentry} 旧目标不得覆盖新上下文`, async () => {
            const pending = delayedMemoPost();
            const h = memoRuntime(memoSrc, { post: () => pending.promise });
            await h.ready();
            h.definition.openPanel({ todoId: 't0' });
            h.panel.querySelector('#memoTodoInput').value = '  A失败输入  ';
            h.definition.openPanel({ todoId: 't1' });
            if (reentry === 'reopen') {
                h.run('panel.close()');
                h.definition.openPanel({ todoId: 't2' });
            } else if (reentry === 'target') {
                h.definition.openPanel({ todoId: 't2' });
            } else if (reentry === 'inline') {
                const target = h.panel.querySelectorAll('[data-action="edit-todo"]').find(node => node.dataset.id === 't2');
                h.panel.fire('click', target);
            } else {
                h.panel.fire('click', h.panel.querySelector('[data-tab="memo"]'));
            }
            const panel = h.panel;
            const input = panel.querySelector(reentry === 'memo' ? '#memoSearch' : '#memoTodoInput');
            input.value = 'C未提交输入';
            input.focus();
            const writes = panel.writes;
            if (result === 'offline') pending.reject(new Error('offline'));
            else pending.resolve(result === 'rejected' ? { error: '保存被拒绝' } : { todo: { ...h.todos[0], text: 'A失败输入', updatedAt: 200 } });
            await settleMemo();
            assert.equal(h.panel, panel);
            assert.equal(panel.querySelector(reentry === 'memo' ? '#memoSearch' : '#memoTodoInput'), input);
            assert.equal(input.value, 'C未提交输入');
            assert.equal(panel.writes, writes);
            assert.equal(h.document.activeElement, input);
            if (reentry === 'memo') {
                assert.equal(h.run('editingTodoId'), null);
                h.run('memos[0].updatedAt++; renderPanelMaybe()');
                assert.ok(panel.writes > writes);
            } else {
                assert.equal(input.dataset.id, 't2');
            }
            if (result !== 'success') {
                h.run('panel.close()');
                h.definition.openPanel({ todoId: 't0' });
                assert.equal(h.panel.querySelector('#memoTodoInput').value, result === 'offline' ? 'A失败输入' : '  A失败输入  ');
            }
        });
    }
}

test('真实延迟拒绝切页：不恢复孤立编辑状态，回到原目标保留失败原输入', async () => {
    const pending = delayedMemoPost();
    const h = memoRuntime(memoSrc, { post: () => pending.promise });
    await h.ready();
    h.definition.openPanel({ todoId: 't0' });
    h.panel.querySelector('#memoTodoInput').value = '  拒绝原输入  ';
    h.panel.fire('click', h.panel.querySelector('[data-tab="memo"]'));
    pending.resolve({ error: '保存被拒绝' });
    await settleMemo();
    assert.equal(h.run('editingTodoId'), null);
    const writes = h.panel.writes;
    h.run('memos[0].updatedAt++; renderPanelMaybe()');
    assert.ok(h.panel.writes > writes);
    h.definition.openPanel({ todoId: 't0' });
    await settleMemo();
    assert.equal(h.panel.querySelector('#memoTodoInput').value, '  拒绝原输入  ');
});

test('真实离线重开：卡片与行内入口读取同id草稿，未修改不替换草稿', async () => {
    const h = memoRuntime(memoSrc, { post: async () => { throw new Error('offline'); } });
    await h.ready();
    h.definition.openPanel({ todoId: 't0' });
    let input = h.panel.querySelector('#memoTodoInput');
    input.value = '离线 <草稿> & 原文';
    h.panel.fire('keydown', input, { key: 'Enter' });
    await settleMemo();
    const draft = h.run('todoDrafts[0]');
    h.run('panel.close()');
    h.click('open-todo-edit', 't0');
    input = h.panel.querySelector('#memoTodoInput');
    assert.equal(input.value, draft.text);
    h.panel.fire('keydown', input, { key: 'Enter' });
    await settleMemo();
    assert.equal(h.run('todoDrafts[0]'), draft);
    const target = h.panel.querySelectorAll('[data-action="edit-todo"]').find(node => node.dataset.id === 't0');
    h.panel.fire('click', target);
    input = h.panel.querySelector('#memoTodoInput');
    assert.equal(input.value, draft.text);
    input.value += ' 新改';
    h.panel.fire('focusout', input);
    await settleMemo();
    assert.equal(h.run('todoDrafts.length'), 1);
    assert.equal(h.run('todoDrafts[0].text'), draft.text + ' 新改');
});

test('真实编辑事件：Enter/失焦各保存一次，Esc只取消编辑，pointerdown保护行内click', async () => {
    const h = memoRuntime();
    await h.ready();
    h.definition.openPanel({ todoId: 't0' });
    let input = h.panel.querySelector('#memoTodoInput');
    input.value = '回车保存';
    const enter = h.panel.fire('keydown', input, { key: 'Enter' });
    await settleMemo();
    assert.equal(enter.defaultPrevented, true);
    assert.equal(h.requests.filter(([method]) => method === 'post').length, 1);
    h.panel.fire('focusout', input);
    await settleMemo();
    assert.equal(h.requests.filter(([method]) => method === 'post').length, 1);
    h.definition.openPanel({ todoId: 't8' });
    await settleMemo();
    input = h.panel.querySelector('#memoTodoInput');
    input.value = '失焦保存';
    h.panel.fire('focusout', input);
    await settleMemo();
    assert.equal(h.requests.filter(([method]) => method === 'post').length, 2);
    h.definition.openPanel({ todoId: 't0' });
    await settleMemo();
    input = h.panel.querySelector('#memoTodoInput');
    const button = h.panel.querySelector('[data-action="ask-del-todo"]');
    assert.equal(h.panel.fire('pointerdown', button).defaultPrevented, true);
    input.value = '取消的输入';
    const escape = h.panel.fire('keydown', input, { key: 'Escape' });
    assert.equal(escape.stopped, true);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(h.panel.querySelector('#memoTodoInput'), null);
    assert.ok(h.panel);
    assert.equal(h.requests.filter(([method]) => method === 'post').length, 2);
});

test('面板内切换编辑目标：先保存上一条，旧文本不写到新 id', async () => {
    const h = memoRuntime();
    await h.ready();
    h.definition.openPanel({ todoId: 't0' });
    const input = h.panel.querySelector('#memoTodoInput');
    input.value = 't0 的新文本';
    const next = h.panel.querySelectorAll('[data-action="edit-todo"]').find(node => node.dataset.id === 't2');
    h.panel.fire('click', next);
    await settleMemo();
    assert.equal(h.panel.querySelector('#memoTodoInput').dataset.id, 't2', '切到新目标');
    assert.equal(h.requests.filter(([method, url]) => method === 'post' && url === '/api/todos/t0').length, 1,
        '上一条先保存一次');
    assert.equal(h.requests.filter(([method, url]) => method === 'post' && url === '/api/todos/t2').length, 0,
        '绝不把上一条的文本写到新 id');
});

test('卡片复用首页材料层：表面、行悬停/按压、抬起页签与拟物勾选都有守卫', () => {
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));
    const rule = selector => {
        const matches = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].trim() === selector);
        assert.equal(matches.length, 1, `${selector} 只声明一次`);
        return matches[0][2];
    };
    const card = rule('.memo-card');
    assert.match(card, /background:\s*var\(--bookmark-face\)/, '卡片表面与书签同源');
    assert.match(card, /box-shadow:[^;]*inset 0 1px/, '卡片有内高光');
    assert.match(rule('.memo-card .module-widget-head'), /linear-gradient\([^;]*center bottom/, '首行用渐变发丝线');
    assert.match(rule('.memo-tab[aria-selected="true"]'), /linear-gradient\([^;]*var\(--control-top\)/, '选中页签是抬起块');
    assert.match(rule('.memo-row:hover'), /var\(--bookmark-hover-face\)/, '行悬停用材料表面');
    assert.match(rule('.memo-row:active'), /var\(--bookmark-press-shadow\)/, '行按下用拟物凹陷');
    assert.match(rule('.memo-todo-check'), /appearance:\s*none/, '勾选框不再用原生外观');
    assert.match(css, /\.memo-todo-check-wrap:has\(\.memo-todo-check:checked\)::after/, '勾选中时才显示勾');
});

test('卡片CSS执行声明：居中、限高原生滚动、焦点与稳定底部，不凭注释通过', () => {
    const css = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8'));
    const rule = selector => {
        const matches = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].trim() === selector);
        assert.equal(matches.length, 1, selector);
        return matches[0][2];
    };
    assert.match(rule('.memo-card .module-widget-head'), /justify-content:\s*center\s*;/);
    const rows = rule('.memo-card .memo-rows');
    for (const declaration of [/max-height:\s*min\(240px,\s*45dvh\)/, /overflow-y:\s*auto\s*;/, /min-height:\s*0\s*;/, /overscroll-behavior:\s*contain\s*;/, /scrollbar-width:\s*thin\s*;/, /scrollbar-gutter:\s*stable\s*;/]) assert.match(rows, declaration);
    assert.match(rule('.memo-card .memo-rows:focus-visible'), /outline:/);
    assert.match(rule('.memo-card .memo-card-footer'), /flex-direction:\s*column/);
});

test('副本变异：旧slice、丢目标action/id/编辑赋值、无滚动恢复、无失败写入、旧头结构均变红', async t => {
    const variants = [
        ['备忘slice', 'memos.map(m =>\n            `<div class="memo-row"', 'memos.slice(0, 3).map(m =>\n            `<div class="memo-row"', assertCompleteMemoLists],
        ['待办slice', 'const rows = todos.map(t =>', 'const rows = todos.slice(0, 4).map(t =>', assertCompleteMemoLists],
        ['丢action', 'data-action="open-todo-edit"', 'data-action="open"', assertMemoTarget],
        ['丢目标id', 'openPanel({ todoId: t.dataset.id })', 'openPanel()', assertMemoTarget],
        ['丢编辑赋值', 'editingTodoId = todos.some(t => t.id === todoId) ? todoId : null;', 'editingTodoId = null;', assertMemoTarget],
        ['丢滚动恢复', 'if (rows) rows.scrollTop = cardScroll[activeTab];', 'if (rows) rows.scrollTop = 0;', assertMemoScroll],
        ['丢失败重试写入', ': statusPillHTML()) + pendingPillHTML()', ": '') + pendingPillHTML()", assertMemoBottomStatus],
        ['旧标题', 'head.innerHTML = tabsHTML();', 'head.innerHTML = `<span class="module-widget-label">备忘</span>` + tabsHTML();', assertStableMemoShell],
        ['旧头状态', 'head.innerHTML = tabsHTML();', 'head.innerHTML = tabsHTML() + statusPillHTML();', assertStableMemoShell]
    ];
    const dir = fs.mkdtempSync(path.join(process.env.COMMANDCODE_SCRATCHPAD || os.tmpdir(), 'memo-mutants-'));
    const original = Buffer.from(memoSrc);
    try {
        for (const [name, before, after, check] of variants) await t.test(name, async () => {
            assert.ok(memoSrc.includes(before), `${name}变异锚点存在`);
            const file = path.join(dir, 'memo.js');
            const mutant = memoSrc.replace(before, after);
            fs.writeFileSync(file, mutant);
            assert.notEqual(mutant, memoSrc);
            await assert.rejects(() => check(fs.readFileSync(file, 'utf8')), error => error.code === 'ERR_ASSERTION');
        });
    } finally {
        fs.writeFileSync(path.join(dir, 'memo.js'), original);
        assert.deepEqual(fs.readFileSync(path.join(dir, 'memo.js')), original);
        assert.deepEqual(fs.readFileSync(path.join(ROOT, 'public', 'modules', 'memo.js')), original);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

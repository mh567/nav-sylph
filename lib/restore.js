'use strict';

/**
 * 可回滚、且不覆盖并发修改的**恢复**。
 *
 * 这个文件只做一件事：把「一份备份内容」变成盘上的新状态，并且在这个过程里
 * 保证下面四条不变量。每条都对应一个具体失败模式，别把它们当注释读过去：
 *
 *  1. **不半套**。恢复跨两种存储（JSON 文件 + SQLite 表）。文件没有事务，所以
 *     每一步之前先写**快照**、进程里先写**持久记录**（`restore_records`），
 *     任何一域失败都按 `applied_json` 的**逆序**回滚。回滚也失败 → `halted`：
 *     受影响域的读写全部 503 `restore_halted`，不开放半套状态。
 *  2. **可续做**。快照目录里同时存「改之前」与「要改成什么」。进程在应用中间被杀掉，
 *     重启后 `recover()` 能接着把剩下的域做完；所需文件缺失就转回滚。
 *  3. **不静默覆盖**。预览与确认两段之间若现场变了（另一个标签页改了模块、
 *     别人恢复了别的东西），`planDigest` 对不上 → 409 请重新预览。
 *  4. **失败不动版本**。版本递增**只**在全部成功之后发生；失败的路径靠
 *     「快照逐字节还原」保证各域 revision 与恢复前完全相等。
 *
 * ⚠️ 快照里有**凭据密文**（时间线 `timeline_credentials.envelope_json`）。
 * 它只允许出现在 `<rootDir>/.restore-snapshot/<runId>/`（0700/0600，temp→rename）：
 * 绝不进 WebDAV 载荷、不进日志、不进响应。快照在成功恢复后立刻删除。
 */

const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

/** 快照根目录名（相对 rootDir）。`.gitignore` 与 restrictPrivateFileModes() 都认它。 */
const SNAPSHOT_ROOT = '.restore-snapshot';

/**
 * 应用顺序。**顺序有语义**：先把最独立的（备忘录）落地，把最容易被别处读到的
 * （收藏）放在中间，模块与时间线放后面。回滚严格按实际应用顺序的逆序走。
 */
const APPLY_ORDER = ['memos', 'todos', 'favorites', 'modules', 'timeline'];

/** 派生域：不进备份、也不参与回滚（恢复后由采集器重建）。 */
const DERIVED_DOMAINS = ['metrics-cache'];

/** 记录表的合法 phase。与迁移 v12 的 CHECK 约束同源，改一处必须改两处。 */
const PHASES = ['applying', 'applied', 'rolling_back', 'rolled_back', 'halted'];

const CONFLICT_MESSAGE = '备份内容或本机状态已改变，请重新预览后再恢复';

function sha256(text) {
    return nodeCrypto.createHash('sha256').update(text).digest('hex');
}

/** 稳定的 JSON 摘要：键顺序由构造顺序决定（计划对象一律按固定键序构造）。 */
function planDigest(plan) {
    const { domains, skipped, pendingAuthorization, unknownModules, versions } = plan;
    return sha256(JSON.stringify({ domains, skipped, pendingAuthorization, unknownModules, versions }));
}

function conflictError(message = CONFLICT_MESSAGE) {
    return Object.assign(new Error(message), { status: 409, code: 'stale_plan' });
}

function readRaw(file) {
    try {
        return fs.readFileSync(file);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/** temp → rename：崩在中间只会留下一个临时文件，目标要么是旧内容要么是新内容。 */
function writeRaw(file, buffer) {
    const temp = `${file}.restore-tmp`;
    fs.writeFileSync(temp, buffer, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
}

function writeFileSafe(file, contents) {
    fs.writeFileSync(file, contents, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
}

/** 从库里按表取全表行。列名随 `SELECT *` 走，回滚时按同一份列名单插入。 */
function dumpTable(db, table, orderBy) {
    try {
        return db.prepare(`SELECT * FROM ${table}${orderBy ? ` ORDER BY ${orderBy}` : ''}`).all();
    } catch {
        // 老库没有这张表（理论上走完迁移不会有，但快照/回滚不该因为一句 SELECT 崩掉）
        return [];
    }
}

/** 按行的实际列名插入。行来自 `SELECT *`，所以列名与表结构天然一致。 */
function insertRow(db, table, row) {
    const cols = Object.keys(row);
    if (!cols.length) return;
    db.prepare(`INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map(c => row[c]));
}

function replaceTable(db, table, rows) {
    db.prepare(`DELETE FROM ${table}`).run();
    for (const row of rows) insertRow(db, table, row);
}

function runIdOf(now) {
    const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `${stamp}-${nodeCrypto.randomBytes(4).toString('hex')}`;
}

/**
 * 恢复前把备份里的机器状态**归一到本机的既有词表**。
 *
 * `mergeServers`（#12）看的是备份里写着的 `deployState`——那是**备份那台机器**
 * 的观测结果，跨安装基本没有意义（那边的 token 到这里解不开）。恢复后的真实情况
 * 只由一件事决定：本机有没有这台机器的注册信息（`certPem`）。
 *
 *  - 有 `certPem`（部署过）但令牌不随备份 → `pending`（等待重新授权/重新部署）
 *  - 连 `certPem` 都没有 → `not_deployed`（这块既有词表里的「未部署」）
 *
 * 两种情况都**不发明新状态词**：界面与客户端已有的分支直接复用。
 */
function normalizeServerDeployment(backupModules) {
    if (!backupModules || typeof backupModules !== 'object') return backupModules;
    const servers = Array.isArray(backupModules.servers) ? backupModules.servers : [];
    return {
        ...backupModules,
        servers: servers.map(server => {
            if (!server || typeof server !== 'object') return server;
            return {
                ...server,
                deployState: typeof server.certPem === 'string' && server.certPem ? 'pending' : 'not_deployed'
            };
        })
    };
}

/**
 * `mergePrivateModules`（#12）不知道「本机有哪些模块」——它只按公开/私人分流。
 * 恢复要**跳过并报告**未知 id：一份来自别的安装、或来自将来版本的备份里可能带
 * 这台机器没有的模块，静默写进 `.modules.json` 的表现是侧栏里出现一张永远加载
 * 不出来的卡片。
 *
 * 判据是**本机随包携带的模块实现**（`public/modules/<id>.js` 的文件名，由
 * server.js 传进来）+ 本机当前配置里出现过的 id。⚠️ 不能只看当前配置：恢复的
 * 典型场景恰恰是「本机的私人模块被清空了，要从备份里恢复回来」，那时备份里的
 * 每一个私人模块都不在当前配置里。
 */
function filterUnknownModules(backupModules, knownIds) {
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);

    const out = { version: 1, enabledModules: [], widgets: [], servers: [], pollInterval: backupModules?.pollInterval };
    const dropped = [];
    const note = id => { if (!dropped.includes(id)) dropped.push(id); };

    for (const id of (Array.isArray(backupModules?.enabledModules) ? backupModules.enabledModules : [])) {
        if (typeof id !== 'string' || !id) continue;
        if (known.has(id)) out.enabledModules.push(id); else note(id);
    }
    for (const widget of (Array.isArray(backupModules?.widgets) ? backupModules.widgets : [])) {
        if (!widget || typeof widget.id !== 'string' || !widget.id) continue;
        if (known.has(widget.id)) out.widgets.push(widget); else note(widget.id);
    }
    // 机器不按模块 id 白名单过滤：标的是 `servers[].id`，本机本来就可能没有它。
    // 未知机器由 mergePrivateModules 报进 needsAuthorization（凭据不随备份）。
    out.servers = Array.isArray(backupModules?.servers) ? backupModules.servers : [];
    return { modules: out, dropped };
}

/**
 * 恢复服务。
 *
 * @param {object} deps
 * @param {string} deps.rootDir 安装根目录（快照落在它与 `.navigation-upgrade-snapshot` 同级）
 * @param {import('better-sqlite3').Database} deps.db 已跑完迁移的库
 * @param {{favorites: string, modules: string}} deps.files 两个 JSON 文件的绝对路径
 * @param {(file: string) => Promise<any>} deps.readJSON
 * @param {(file: string, data: any) => Promise<void>} deps.writeJSON
 * @param {object} deps.versionedModules lib/versioned-modules.js
 * @param {object} deps.navigation createNavigation 的实例
 * @param {{service: object, scheduler: object}} deps.timeline
 * @param {string[]} deps.publicModuleIds 公开模块白名单
 * @param {(html: string) => any[]} deps.parseBookmarks 书签 HTML 解析（lib 不认识书签 HTML）
 * @param {Record<string, (input: {data: object}) => Promise<object>>} deps.writers
 *        逐域**正向**写入。由 server.js 注入：模块/时间线/备忘录的写入口在那边
 *        （它们要用 versionedModules、timeline.service、db 的写语句），而快照与
 *        回滚留在这里。写入函数收到 `{data}`——与路由里 `result` 的形状一致，
 *        于是「路由应用」与「重启续做」走同一份代码，不存在两套 if。
 */
function createRestore(deps) {
    const {
        rootDir, db, files, readJSON, writeJSON, versionedModules,
        navigation, timeline, publicModuleIds = [], moduleIds = [], parseBookmarks, writers = {}
    } = deps;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

    // ========== 快照 ==========

    function snapshotDirOf(runId) {
        return path.join(rootDir, SNAPSHOT_ROOT, runId);
    }

    function ensureSnapshotRoot() {
        const root = path.join(rootDir, SNAPSHOT_ROOT);
        if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(root, 0o700); } catch { /* 权限收不紧不该阻断恢复 */ }
        return root;
    }

    /** 当前各域的版本号。`before_json` 存它，成功后与它比对来证明「失败了版本没动」。 */
    function readVersions() {
        const versions = {};
        try {
            const favorites = JSON.parse(fs.readFileSync(files.favorites, 'utf8'));
            versions.favorites = Number(favorites?.revision) || 0;
        } catch { versions.favorites = 0; }
        try {
            versions.modules = versionedModules.revision(versionedModules.read(files.modules));
        } catch { versions.modules = 0; }
        try {
            versions['navigation-admin'] = navigation.read('admin').revision;
        } catch { versions['navigation-admin'] = 0; }
        return versions;
    }

    /** 恢复前的现场。`before.db.json` 含时间线凭据行——只在快照里。 */
    function captureBefore() {
        return {
            'before.favorites.json': readRaw(files.favorites),
            'before.modules.json': readRaw(files.modules),
            'before.db.json': Buffer.from(JSON.stringify({
                navigationDocuments: dumpTable(db, 'navigation_documents'),
                timelineSources: dumpTable(db, 'timeline_sources'),
                timelineEvents: dumpTable(db, 'timeline_events'),
                timelineEventState: dumpTable(db, 'timeline_event_state'),
                timelineCredentials: dumpTable(db, 'timeline_credentials'),
                memos: dumpTable(db, 'memos'),
                todos: dumpTable(db, 'todos')
            }), 'utf8')
        };
    }

    /**
     * 落快照。目录用 `<runId>.tmp` → rename：rename 之前进程被杀，盘上只会多一个
     * `.tmp` 目录，`recover()` 按记录里的 `snapshot_dir` 找不到它 → 转回滚，不会
     * 把一份写了一半的快照当成好的用。
     */
    function writeSnapshot(runId, { domains, incoming, plan }) {
        ensureSnapshotRoot();
        const target = snapshotDirOf(runId);
        const temp = `${target}.tmp`;
        fs.rmSync(temp, { recursive: true, force: true });
        fs.mkdirSync(temp, { mode: 0o700 });
        fs.chmodSync(temp, 0o700);

        for (const [name, buffer] of Object.entries(captureBefore())) {
            if (buffer) writeFileSafe(path.join(temp, name), buffer);
        }
        // 「要改成什么」。续做需要的正是它——重启之后 WebDAV 那边取回来的那份
        // 早就不在内存里了（也不该在：重新去取可能取到另一份备份）。
        writeFileSafe(path.join(temp, 'incoming.json'), JSON.stringify(incoming));
        writeFileSafe(path.join(temp, 'SNAPSHOT.json'), JSON.stringify({
            runId,
            createdAt: now(),
            domains,
            versions: plan.versions,
            planDigest: plan.digest
        }, null, 2));
        fs.renameSync(temp, target);
        return target;
    }

    function readSnapshot(dir, runId) {
        const read = name => {
            const file = path.join(dir, name);
            if (!fs.existsSync(file)) return null;
            return fs.readFileSync(file);
        };
        const beforeDb = read('before.db.json');
        const incomingRaw = read('incoming.json');
        return {
            dir,
            runId,
            favorites: read('before.favorites.json'),
            modules: read('before.modules.json'),
            beforeDb: beforeDb ? JSON.parse(beforeDb.toString('utf8')) : null,
            incoming: incomingRaw ? JSON.parse(incomingRaw.toString('utf8')) : null
        };
    }

    function removeSnapshot(dir) {
        if (!dir) return;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉留给人看，不影响结果 */ }
        // `.tmp` 残骸：崩在 rename 之前留下的。成功收尾时顺手清掉。
        try { fs.rmSync(`${dir}.tmp`, { recursive: true, force: true }); } catch { /* 同上 */ }
    }

    // ========== 记录 ==========

    function insertRecord({ runId, domains, plan, before, snapshotDir }) {
        const at = now();
        db.prepare(`INSERT INTO restore_records
            (id, phase, domains_json, applied_json, plan_json, before_json, snapshot_dir, failure, generation, created_at, updated_at)
            VALUES (?, 'applying', ?, '[]', ?, ?, ?, NULL, 0, ?, ?)`)
            .run(runId, JSON.stringify(domains), JSON.stringify(plan), JSON.stringify(before), snapshotDir, at, at);
    }

    /** 每域成功即追加。与业务数据的写入**不在**同一事务里（跨文件没有事务），
     *  但顺序是「先写业务数据、再追加记录」——崩在中间的重启会重做这一域，
     *  而所有域的应用都是「写成这份内容」的幂等操作。 */
    function noteApplied(runId, domain) {
        const row = db.prepare('SELECT applied_json FROM restore_records WHERE id = ?').get(runId);
        const applied = row ? JSON.parse(row.applied_json) : [];
        if (!applied.includes(domain)) applied.push(domain);
        db.prepare('UPDATE restore_records SET applied_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(applied), now(), runId);
        return applied;
    }

    function setPhase(runId, phase, failure = null) {
        if (!PHASES.includes(phase)) throw new Error(`未知恢复阶段：${phase}`);
        db.prepare('UPDATE restore_records SET phase = ?, failure = ?, updated_at = ? WHERE id = ?')
            .run(phase, failure, now(), runId);
    }

    /** 成功收尾：代次 +1（全表最大 +1，不做「取最后一行 +1」——并发恢复已被锁挡住，
     *  但手工删过记录的老库会让「最后一行」倒退）。 */
    function commitSuccess(runId) {
        db.transaction(() => {
            db.prepare(`UPDATE restore_records SET generation = (SELECT COALESCE(MAX(generation), 0) + 1 FROM restore_records)
                WHERE id = ?`).run(runId);
            db.prepare("UPDATE restore_records SET phase = 'applied', failure = NULL, updated_at = ? WHERE id = ?")
                .run(now(), runId);
        })();
        return db.prepare('SELECT generation FROM restore_records WHERE id = ?').get(runId).generation;
    }

    function getRecord(runId) {
        const row = db.prepare('SELECT * FROM restore_records WHERE id = ?').get(runId);
        return row ? {
            ...row,
            domains: JSON.parse(row.domains_json),
            applied: JSON.parse(row.applied_json),
            plan: JSON.parse(row.plan_json),
            before: JSON.parse(row.before_json)
        } : null;
    }

    function lastUnsettled() {
        return db.prepare(`SELECT * FROM restore_records WHERE phase IN ('applying', 'rolling_back')
            ORDER BY created_at DESC LIMIT 1`).get();
    }

    function lastHalted() {
        return db.prepare("SELECT * FROM restore_records WHERE phase = 'halted' ORDER BY created_at DESC LIMIT 1").get();
    }

    // ========== 计划 ==========

    /**
     * 收集「要写进去的内容」，并把逐域的跳过原因一次算清。
     *
     * 这里是恢复语义的**唯一**判据：什么算「有内容可恢复」、旧备份为什么只剩书签、
     * 凭据为什么落到「待授权」。回滚与续做都复用它的输出（快照里的 incoming）。
     */
    async function collectIncoming(backup) {
        const data = backup?.data || {};
        const skipped = [];
        const incoming = {};
        // 本机当下的模块配置：既用来判「未知模块 id」，也用来判「这些凭据本机还在、
        // 不需要用户重新授权」——两处用的是同一份现场，不能各读一次。
        let currentModules = {};
        try { currentModules = await readJSON(files.modules); } catch { currentModules = {}; }

        // 收藏：新备份只有书签 HTML（Netscape 往返），旧备份带一份 JSON。
        const bookmarkItems = Array.isArray(data.favorites)
            ? data.favorites
            : (Array.isArray(data.favorites?.favorites) ? data.favorites.favorites : null);
        if (bookmarkItems) incoming.favorites = bookmarkItems;
        else if (typeof data.bookmarksHtml === 'string') incoming.favorites = parseBookmarks(data.bookmarksHtml);

        if (Array.isArray(data.memos)) incoming.memos = { memos: data.memos };
        // 备忘录域的信封数据是 `{memos: [...]}`（`projectMemosForBackup` 的形状），
        // 不是裸数组。恢复侧的写入（`restoreMemosFromBackup`）认的正是这个形状，
        // 所以这里**保持原样**而不是拆成数组——拆了会悄悄改掉一条既有契约。
        else if (data.memos && Array.isArray(data.memos.memos)) incoming.memos = data.memos;

        // 待办与备忘录同一契约：信封数据是 `{todos: [...]}`，保持原样交给
        // restoreTodosFromBackup，不在这里拆成数组。
        if (Array.isArray(data.todos)) incoming.todos = { todos: data.todos };
        else if (data.todos && Array.isArray(data.todos.todos)) incoming.todos = data.todos;

        let unknownModules = [];
        if (data.modules && typeof data.modules === 'object') {
            // 已知 id = 本机随包携带的模块实现 + 公开白名单 + 当前配置里出现过的 id。
            // 见 filterUnknownModules 的注释（为什么不能只看当前配置）。
            const known = new Set([...(moduleIds || []), ...publicModuleIds]);
            for (const id of (Array.isArray(currentModules?.enabledModules) ? currentModules.enabledModules : [])) {
                if (typeof id === 'string' && id) known.add(id);
            }
            for (const widget of (Array.isArray(currentModules?.widgets) ? currentModules.widgets : [])) {
                if (widget && typeof widget.id === 'string' && widget.id) known.add(widget.id);
            }
            const filtered = filterUnknownModules(normalizeServerDeployment(data.modules), known);
            incoming.modules = filtered.modules;
            unknownModules = filtered.dropped;
            if (unknownModules.length) {
                // 未知 id 跳过**并报告**：静默丢掉的话，用户会以为恢复完整成功了。
                skipped.push({
                    domain: 'modules.widgets#unknown',
                    reason: `本机没有这些模块，已跳过：${unknownModules.join('、')}`
                });
            }
        }

        if (data.timeline && typeof data.timeline === 'object') incoming.timeline = data.timeline;

        return { incoming, skipped, unknownModules, pendingAuthorization: collectPendingAuthorization(incoming, currentModules) };
    }

    /**
     * 预览（只读）：算出「将恢复 / 将跳过（含原因）/ 凭据待授权 / 新版本号」+ `planDigest`。
     *
     * ⚠️ 只读的含义是硬要求：它不写文件、不写库、不碰快照。用户点「预览」时还在
     * 选择阶段，任何副作用都会让「取消」变成一句空话。
     */
    async function preview(backup) {
        const before = readVersions();
        const { incoming, skipped, unknownModules, pendingAuthorization } = await collectIncoming(backup);
        const backupSkipped = (Array.isArray(backup?.skipped) ? backup.skipped : [])
            .map(item => ({ domain: item.domain, reason: item.reason }));

        const domains = [];
        const order = [];
        for (const domain of APPLY_ORDER) {
            const value = incoming[domain];
            if (value === undefined) {
                domains.push({
                    domain,
                    action: 'skip',
                    reason: domain === 'memos'
                        ? '这组备份不含备忘'
                        : (domain === 'todos'
                            ? '这组备份不含待办'
                            : (domain === 'timeline' ? '这组备份不含时间线' : '这组备份不含这一域'))
                });
                continue;
            }
            order.push(domain);
            domains.push({
                domain,
                action: 'restore',
                count: countOf(domain, value),
                revisionBefore: before[domain] ?? null,
                revisionAfter: before[domain] === undefined ? null : before[domain] + 1
            });
        }
        // 导航/引擎/默认模板：新备份本来就不含，#12 之后**永不**恢复。
        // 旧备份能列出、能选，但这里明确进 skip 并给原因（界面据此提示「只恢复书签」）。
        for (const item of backupSkipped) {
            if (domains.some(entry => entry.domain === item.domain)) continue;
            domains.push({ domain: item.domain, action: 'skip', reason: item.reason });
        }
        for (const derived of DERIVED_DOMAINS) {
            domains.push({ domain: derived, action: 'skip', reason: '派生数据，恢复成功后由采集器重建' });
        }

        const plan = {
            domains,
            order,
            skipped: [...backupSkipped, ...skipped],
            // 凭据不随备份：这些机器/来源在恢复后需要重新授权（复用既有文案与状态词）。
            pendingAuthorization,
            unknownModules,
            versions: { before, after: nextVersions(before, order) }
        };
        plan.digest = planDigest(plan);
        return { plan, incoming };
    }

    /**
     * 预览里「这一域会写进去多少条」。各域的形状不同，集中在一处算，
     * 免得界面为五个域各写一份判断。
     */
    function countOf(domain, value) {
        if (Array.isArray(value)) return value.length;
        if (domain === 'memos') return value && Array.isArray(value.memos) ? value.memos.length : null;
        if (domain === 'todos') return value && Array.isArray(value.todos) ? value.todos.length : null;
        if (domain === 'timeline') return value && Array.isArray(value.events) ? value.events.length : null;
        if (domain === 'modules') {
            const widgets = Array.isArray(value?.widgets) ? value.widgets.length : 0;
            const servers = Array.isArray(value?.servers) ? value.servers.length : 0;
            return widgets + servers;
        }
        return null;
    }

    /** 恢复后仍然「没有凭据」的项目。不发明第二套状态机：落到既有 deployState 语义。 */
    function collectPendingAuthorization(incoming, currentModules = {}) {
        const items = [];
        // 本机已经有凭据的机器不需要重新授权：备份里没有它的令牌，但本机那份还在
        //（`mergeServers` 对同 id 的机器只补布局、不动凭据）。漏掉这一条的表现是
        // 恢复后界面让用户去重新授权一台明明还在正常上报的机器。
        const localWithToken = new Set(
            (Array.isArray(currentModules?.servers) ? currentModules.servers : [])
                .filter(server => server && server.id && server.token)
                .map(server => server.id)
        );
        for (const server of (Array.isArray(incoming.modules?.servers) ? incoming.modules.servers : [])) {
            if (!server || !server.id) continue;
            if (localWithToken.has(server.id)) continue;
            items.push({
                kind: 'server',
                id: server.id,
                name: server.name || server.url || server.id,
                // 缺 certPem 的机器连部署都没做过 → 既有词表里的 not_deployed；
                // 有的则是「部署过但凭据不在备份里」→ pending（等待重新授权/部署）。
                state: server.certPem ? 'pending' : 'not_deployed',
                reason: server.certPem
                    ? 'agent 令牌密文由本机管理密码派生，不随备份；恢复后需重新授权或重新部署'
                    : '这台机器没有注册信息（certPem），恢复后需要重新部署'
            });
        }
        for (const source of (Array.isArray(incoming.timeline?.sources) ? incoming.timeline.sources : [])) {
            if (!source || !source.id || source.provider_type === 'manual') continue;
            items.push({
                kind: 'timeline-source',
                id: source.id,
                name: source.name || source.id,
                state: 'pending_authorization',
                reason: '来源凭据的密文由本机管理密码派生，不跨安装；恢复后请重新填写'
            });
        }
        return items;
    }

    function nextVersions(before, order) {
        const after = { ...before };
        for (const domain of order) {
            if (after[domain] === undefined) continue;
            after[domain] = after[domain] + 1;
        }
        return after;
    }

    // ========== 回滚 ==========

    /**
     * 把一域还原成快照里的样子。
     *
     * 文件域**逐字节**还原（不是「把解析出来的对象再写一遍」）：解析再序列化会把
     * 键顺序、空格、末尾换行都改掉，而 `.modules.json` 的 `_sync.revision` 与回执
     * 也在这份字节里——「版本不变」的断言只能靠逐字节相等来证明。
     */
    function restoreDomain(live, domain) {
        if (domain === 'favorites' || domain === 'modules') {
            const buffer = domain === 'favorites' ? live.favorites : live.modules;
            const file = domain === 'favorites' ? files.favorites : files.modules;
            if (buffer === null) {
                // 恢复前这个文件不存在：回滚要让它重新不存在，而不是留一份空文件
                try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
            } else writeRaw(file, buffer);
            return;
        }
        const before = live.beforeDb;
        if (!before) throw new Error('快照缺少数据库部分，无法回滚');
        if (domain === 'navigation-admin') {
            db.transaction(() => {
                const admin = (before.navigationDocuments || []).find(row => row.id === 'admin');
                if (!admin) return;
                db.prepare('UPDATE navigation_documents SET config_json = ?, revision = ? WHERE id = ?')
                    .run(admin.config_json, admin.revision, admin.id);
            })();
            return;
        }
        if (domain === 'timeline') {
            db.transaction(() => {
                replaceTable(db, 'timeline_event_state', before.timelineEventState || []);
                replaceTable(db, 'timeline_events', before.timelineEvents || []);
                replaceTable(db, 'timeline_credentials', before.timelineCredentials || []);
                replaceTable(db, 'timeline_sources', before.timelineSources || []);
            })();
            return;
        }
        if (domain === 'memos') {
            db.transaction(() => replaceTable(db, 'memos', before.memos || []))();
            return;
        }
        if (domain === 'todos') {
            db.transaction(() => replaceTable(db, 'todos', before.todos || []))();
            return;
        }
        throw new Error(`未知域：${domain}`);
    }

    /**
     * 逆序回滚。返回 `{ok, rolledBack, failedAt}`。
     *
     * `ok === false` 意味着盘上是一份自己都说不清的状态 → 调用方把记录置为 `halted`，
     * 受影响域的读写从此 503。**不重试**：再跑一次只会把快照也覆盖掉。
     */
    function rollback(runId, applied, live) {
        const rolledBack = [];
        for (const domain of [...applied].reverse()) {
            try {
                restoreDomain(live, domain);
                rolledBack.push(domain);
            } catch (err) {
                return { ok: false, rolledBack, failedAt: domain, error: err };
            }
        }
        return { ok: true, rolledBack, failedAt: null, error: null };
    }

    // ========== 应用 ==========

    async function applyDomain(domain, input) {
        const writer = writers[domain];
        if (typeof writer !== 'function') throw new Error(`缺少「${domain}」域的写入实现`);
        return await writer(input);
    }

    /**
     * 应用一份备份。
     *
     * 生命周期（顺序不可换）：
     *   复验 planDigest → 落快照 → 写 `applying` 记录 → 逐域应用（每域成功即追加
     *   `applied_json`）→ 全部成功才提交（代次 +1、`applied`、删快照）。
     *
     * @param {object} options
     * @param {object} options.backup 刚刚取回来的备份（`webdav.restoreBackup` 的返回）
     * @param {string} [options.planDigest] 预览时下发的摘要；不传则跳过复验（旧客户端）
     * @param {boolean} [options.resume] 内部用：重启续做时不重新预览
     */
    async function apply({ backup, planDigest: expectedDigest } = {}) {
        const { plan, incoming } = await preview(backup);
        // 复验：预览与确认之间现场变了（别处改了模块、别人恢复了别的东西、远端那份
        // 备份被重新上传）→ 计划已经不是用户看到的那一份，必须让他重新预览。
        // ⚠️ 旧客户端不带 digest：这一条是**兼容**而不是豁免——它仍然走锁/快照/回滚。
        if (expectedDigest && expectedDigest !== plan.digest) throw conflictError();

        const domains = plan.order;
        if (!domains.length) {
            return { plan, applied: [], snapshotDir: null, generation: 0, nothingToDo: true };
        }

        const runId = runIdOf(now());
        const before = plan.versions.before;
        const snapshotDir = writeSnapshot(runId, { domains, incoming, plan });
        insertRecord({ runId, domains, plan, before, snapshotDir });

        const live = readSnapshot(snapshotDir, runId);
        let applied = [];
        const results = {};
        try {
            for (const domain of domains) {
                results[domain] = await applyDomain(domain, { data: incoming });
                applied = noteApplied(runId, domain);
            }
        } catch (err) {
            setPhase(runId, 'rolling_back', `应用「${err.domain || ''}」失败：${err.message}`.replace('「」', ''));
            const undone = rollback(runId, applied, live);
            if (undone.ok) {
                setPhase(runId, 'rolled_back', `恢复失败，已完整回滚：${err.message}`);
                removeSnapshot(snapshotDir);
                const failure = Object.assign(new Error(`恢复失败，已完整回滚：${err.message}`), {
                    status: 500, code: 'restore_rolled_back', runId, rolledBack: undone.rolledBack
                });
                throw failure;
            }
            // 回滚也失败 → 终态。受影响域的读写全部 503，快照**保留**（人工恢复的唯一依据）。
            setPhase(runId, 'halted', `${err.message}；回滚「${undone.failedAt}」也失败：${undone.error.message}`);
            const halted = Object.assign(new Error('恢复失败且回滚未完成，受影响功能已暂停'), {
                status: 503, code: 'restore_halted', runId, rolledBack: undone.rolledBack, snapshotDir
            });
            throw halted;
        }

        const generation = commitSuccess(runId);
        removeSnapshot(snapshotDir);
        return {
            runId,
            plan,
            applied,
            results,
            generation,
            snapshotDir: null,
            versions: { before, after: readVersions() }
        };
    }

    // ========== 重启续做 ==========

    /**
     * 启动时收尾上一条没走完的恢复。在 `init()` 里、`server.listen` 之前调用。
     *
     * 三态：
     *  - `applying`：**续做**（拍定默认）。已应用的域跳过，剩下的按快照里的
     *    `incoming.json` 继续写；快照/文件缺失 → 转回滚。
     *  - `rolling_back`：继续回滚到 `rolled_back`。
     *  - `halted`：**不自动重试**。返回值里带上它，`/api/health` 报 degraded，
     *    受影响域读写 503。
     */
    async function recover() {
        const rec = lastUnsettled();
        if (!rec) {
            const halted = lastHalted();
            return { action: halted ? 'halted' : 'none', runId: halted?.id || null, domains: halted ? JSON.parse(halted.domains_json) : [] };
        }
        const dir = rec.snapshot_dir;
        const live = dir && fs.existsSync(dir) ? readSnapshot(dir, rec.id) : null;
        const applied = JSON.parse(rec.applied_json);
        const domains = JSON.parse(rec.domains_json);

        if (rec.phase === 'rolling_back' || !live) {
            // 缺料（快照目录被删、只留下 .tmp）等于「无法续做」。拍定：转回滚，
            // 而不是赌一份看不全的现场继续写。
            setPhase(rec.id, 'rolling_back', rec.failure || '快照缺失，改为回滚');
            const undone = rollback(rec.id, applied, live || { beforeDb: null, favorites: null, modules: null });
            if (undone.ok) {
                // 失败原因保留「为什么走到回滚」：界面/日志要能回答「这次启动到底做了什么」。
                setPhase(rec.id, 'rolled_back', live
                    ? `进程中断，回滚已续做完成（${rec.failure || '原因未记录'}）`
                    : '快照缺失，无法续做，已按记录回滚');
                removeSnapshot(dir);
                return { action: 'rolled_back', runId: rec.id, domains };
            }
            setPhase(rec.id, 'halted', `进程中断后回滚失败：${undone.error.message}`);
            return { action: 'halted', runId: rec.id, domains };
        }

        // 续做：只补没做完的域，顺序沿用快照里的 domains。
        const remaining = domains.filter(domain => !applied.includes(domain));
        try {
            for (const domain of remaining) {
                await applyDomain(domain, { data: live.incoming });
                noteApplied(rec.id, domain);
            }
        } catch (err) {
            setPhase(rec.id, 'rolling_back', `续做失败：${err.message}`);
            const current = getRecord(rec.id)?.applied || [];
            const undone = rollback(rec.id, current, live);
            if (undone.ok) {
                setPhase(rec.id, 'rolled_back', `续做失败：${err.message}`);
                removeSnapshot(dir);
                return { action: 'rolled_back', runId: rec.id, domains };
            }
            setPhase(rec.id, 'halted', `续做失败且回滚失败：${undone.error.message}`);
            return { action: 'halted', runId: rec.id, domains };
        }

        const generation = commitSuccess(rec.id);
        removeSnapshot(dir);
        return { action: 'completed', runId: rec.id, domains, generation, resumed: remaining };
    }

    /** 受影响域（给 503 守卫用）。没有 `halted` 记录时返回空数组。 */
    function haltedDomains() {
        const halted = lastHalted();
        if (!halted) return [];
        // `halted` 之后的记录若已成功收尾（人工处理过），就不再拦。
        const later = db.prepare("SELECT COUNT(*) AS n FROM restore_records WHERE phase = 'applied' AND created_at > ?")
            .get(halted.created_at).n;
        if (later > 0) return [];
        try { return JSON.parse(halted.domains_json); } catch { return []; }
    }

    function status() {
        const halted = lastHalted();
        const last = db.prepare('SELECT * FROM restore_records ORDER BY created_at DESC LIMIT 1').get();
        return {
            halted: halted ? {
                runId: halted.id,
                domains: JSON.parse(halted.domains_json),
                failure: halted.failure,
                snapshotDir: halted.snapshot_dir,
                createdAt: halted.created_at
            } : null,
            last: last ? {
                runId: last.id,
                phase: last.phase,
                generation: last.generation,
                applied: JSON.parse(last.applied_json),
                failure: last.failure,
                createdAt: last.created_at,
                updatedAt: last.updated_at
            } : null
        };
    }

    return {
        preview, apply, recover, status, haltedDomains, snapshotDirOf, SNAPSHOT_ROOT,
        // 测试用：`tests/restore-recovery.test.js` 要**直接造出**「进程上次死在
        // applying 中间」的现场（快照 + 记录），而那条路径没法从 `apply()` 触发
        //（它自己会把记录推到 rolling_back）。与 lib/timeline/service.js 的 `__test` 同一手法。
        __test: { writeSnapshot, readSnapshot, insertRecord, setPhase, noteApplied, getRecord, runIdOf }
    };
}

module.exports = {
    createRestore,
    SNAPSHOT_ROOT,
    APPLY_ORDER,
    DERIVED_DOMAINS,
    PHASES,
    planDigest,
    filterUnknownModules,
    normalizeServerDeployment,
    conflictError,
    CONFLICT_MESSAGE
};

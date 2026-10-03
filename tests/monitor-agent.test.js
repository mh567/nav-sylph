const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 服务器监控 agent 与远端采集的回归测试。
 *
 * 归属在这里而不是分散到别处：这两件事是一条链的两端——
 * agent/agent.js 负责「目标机上读到什么」，lib/monitor.js 负责「服务端怎么拉」，
 * 中间靠一份协议（version 字段 + 那几个字段名）绑定。
 */

const ROOT = path.join(__dirname, '..');
const agentSource = fs.readFileSync(path.join(ROOT, 'agent', 'agent.js'), 'utf8');
const monitorSource = fs.readFileSync(path.join(ROOT, 'lib', 'monitor.js'), 'utf8');
const moduleSource = fs.readFileSync(path.join(ROOT, 'public', 'modules', 'server-monitor.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

test('agent 的两条采集路径返回同一种形状', () => {
    // /proc/stat 返回一个聚合对象，而 os.cpus() 返回按核的数组。
    // 两边形状不一致时 collect() 里 `current.total - previousCpu.total`
    // 变成「数组减数字」= NaN，totalDelta > 0 不成立，cpu 恒为 null——
    // 而返回的 JSON 完全合法，看不出出错，只是永远没有 CPU 数据。
    const code = stripComments(agentSource);
    const readProc = /function readProcStat\(\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)\};/.exec(code);
    assert.ok(readProc, 'readProcStat 返回一个对象字面量');

    const readOs = /function readOsCpuTotal\(\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)\};/.exec(code);
    assert.ok(readOs, '有 readOsCpuTotal 回落实现');

    // 两者的字段名集合必须一致
    const fields = src => (src.match(/[a-z]+\s*[:,}]/g) || [])
        .map(s => s.replace(/[\s,:}]/g, '')).sort();
    const procFields = fields(readProc[1]);
    const osFields = fields(readOs[1]);
    for (const key of ['user', 'nice', 'system', 'idle', 'iowait', 'total']) {
        assert.ok(procFields.includes(key), `/proc 路径有 ${key}`);
        assert.ok(osFields.includes(key), `os 回落路径有 ${key}`);
    }

    // 且都必须是对象而非数组
    assert.doesNotMatch(code, /readOsCpuTotal[\s\S]*?return\s+os\.cpus\(\)/,
        '回落实现不能直接返回 os.cpus() 的数组');
});

test('agent 的 token 走环境变量优先，且鉴权失败不泄露任何提示', () => {
    const code = stripComments(agentSource);
    assert.match(code, /NAVSYLPH_TOKEN\s*\|\|\s*args\.token/,
        '环境变量优先于命令行——命令行会出现在 ps 输出与 shell 历史里');
    assert.match(code, /timingSafeEqual/, '定长比较，避免逐字符比较泄露前缀');
    assert.match(code, /401[\s\S]*?unauthorized/, '未授权返回 401');
    // 401 的响应体里不能带上任何关于 token 的提示
    const unauthorized = code.slice(code.indexOf('unauthorized') - 200, code.indexOf('unauthorized') + 40);
    assert.doesNotMatch(unauthorized, /token.{0,20}(长度|length|前缀|prefix|错误)/i,
        '401 响应不得帮助攻击者缩小 token 的猜测空间');
});

test('agent 的 health 端点不需要鉴权，metrics 需要', () => {
    const code = stripComments(agentSource);
    const healthAt = code.indexOf("'/health'");
    const metricsAt = code.indexOf("'/metrics'");
    assert.ok(healthAt >= 0 && metricsAt > healthAt, '两个端点都在');
    // health 分支在鉴权之前 return
    const healthBranch = code.slice(healthAt, metricsAt);
    assert.doesNotMatch(healthBranch, /tokenMatches/,
        'health 段里没有鉴权调用');
    assert.match(code.slice(metricsAt, metricsAt + 600), /tokenMatches/,
        'metrics 段里有鉴权');
});

test('agent 在没有 /proc 的平台降级而不是崩溃', () => {
    const code = stripComments(agentSource);
    assert.match(code, /HAS_PROC\s*=\s*fs\.existsSync\('\/proc\/stat'\)/,
        '先探测 /proc 是否存在');
    assert.match(code, /readCpuTotal\s*=\s*HAS_PROC\s*\?\s*readProcStat\s*:\s*readOsCpuTotal/,
        '按平台选采集实现');
    // 顶层不能直接调 readProcStat（/proc 不存在时会在启动阶段抛错）
    assert.doesNotMatch(code, /^let previousCpu = readProcStat\(\)/m,
        '顶层采样必须走有回落的实现，不能在启动时因缺 /proc 而崩');
});

test('macOS 内存走 vm_stat，不用 os.freemem()', () => {
    // os.freemem() 在 macOS 上返回的是「未被列为可用」的页，
    // 而 macOS 把大部分内存拿去做文件缓存——实测 16GB 机器上
    // totalmem - freemem 达 98.6%，显示成「内存 99%」，看着像要爆，
    // 实际完全正常。那个数衡量的是缓存占用，不是应用占用。
    //
    // 这条最容易回归：`os.freemem()` 在所有平台都存在、都能跑，
    // 只是 macOS 上语义不对，所以没有任何报错会提醒你。
    const agentCode = stripComments(agentSource);
    const monitorCode = stripComments(monitorSource);

    for (const [name, code, fn] of [
        ['agent', agentCode, /function readDarwinMemory\(\)/],
        ['服务端', monitorCode, /function readLocalMemory\(\)/]
    ]) {
        assert.match(code, fn, `${name} 有独立的 macOS 内存读取`);
        assert.match(code, /vm_stat/, `${name} 读 vm_stat`);
        // available 必须把 inactive（可回收缓存）算进去
        assert.match(code, /Pages inactive/, `${name} 把 inactive 计入可用`);
        assert.match(code, /Pages speculative/, `${name} 把 speculative 计入可用`);
    }

    // 实际使用处必须走这个函数，而不是又回到 os.freemem()
    assert.match(agentCode, /const mem = readMemory\(\)/, 'agent 的 collect 走 readMemory');
    assert.match(monitorCode, /const mem = readLocalMemory\(\)/, '服务端走 readLocalMemory');

    // 非 darwin 分支仍然可以用 os.freemem()，但要被平台判断包住
    assert.match(monitorCode, /if \(process\.platform !== 'darwin'\)[\s\S]*?os\.freemem\(\)/,
        'os.freemem() 只在非 macOS 分支使用');
});

test('agent 的 macOS 内存读取失败时退回而不是崩', () => {
    // 容器、精简系统上 vm_stat 可能读不到。整��� agent 起不来
    // 比内存数字粗一点严重得多。
    const code = stripComments(agentSource);
    assert.match(code, /try\s*\{[\s\S]*?readDarwinMemory\(\)[\s\S]*?\}\s*catch/,
        'vm_stat 读取有 try/catch');
    assert.match(code, /catch[\s\S]*?os\.freemem\(\)/, 'catch 分支退回 os 模块');
});

test('页大小用 sysctl 取，不是当成文件路径读', () => {
    // 一度写成 fs.readFileSync('/sysctl -n hw.pagesize')——
    // 那不是路径，会抛 ENOENT，在非 macOS 上还可能被当成合法路径。
    const agentCode = stripComments(agentSource);
    assert.doesNotMatch(agentCode, /readFileSync\(\s*['"]\/sysctl/,
        '不得把 sysctl 命令当文件路径读');
    assert.match(agentCode, /execSync\(\s*'sysctl -n hw\.pagesize'/, '用 execSync 调 sysctl');
});

test('服务端拉取远端失败时返回原因而不是抛错', () => {
    // 一台离线不能让整轮采集失败——首页要显示「离线」，
    // 而不是把全部服务器一起清空。
    const code = stripComments(monitorSource);
    const fn = code.slice(code.indexOf('async function fetchRemoteMetrics('),
        code.indexOf('module.exports'));
    assert.match(fn, /return\s*\{\s*ok:\s*false/, '失败返回 ok:false');
    assert.match(fn, /authFailed:\s*true/, '401 单独标记，便于界面区分「凭据错」与「机器挂」');
    assert.match(fn, /无法连接/, 'ECONNREFUSED 给出可读原因，不透出 fetch failed');

    // **不得向上抛错**。这条要盯住 catch 块本身——
    // 早先写成「成功 return 之前不许有 throw」，而那个锚点
    // （`return { ok: true }`）在真实代码里根本不存在（实际是
    // `return { ok: true, metrics: ... }`），slice 到 -1 之后
    // 扫的区间不含真正的抛出点，测试恒绿。变异验证：
    // 在 401 分支前插入 `throw new Error('boom')`，旧断言仍全绿。
    const catchStart = fn.indexOf('} catch');
    assert.ok(catchStart > 0, '有 catch 块');
    const catchBlock = fn.slice(catchStart);
    assert.doesNotMatch(catchBlock, /\bthrow\b/,
        '远端拉取的 catch 块不得向上抛错——一台离线不能拖垮整轮采集');
    // 主体（catch 之前）也不该有裸抛
    const body = fn.slice(0, catchStart);
    assert.doesNotMatch(body, /throw new Error/, '函数体在 try 内不得抛错');
});

test('agent 与服务端的协议版本必须能对上', () => {
    // 版本不一致时报错，而不是把不认识的字段当 0 读进去——
    // 那会显示「CPU 0%」，是一个错误的结论而不是一个可见的失败。
    const agentVersion = /const VERSION\s*=\s*(\d+)/.exec(agentSource);
    const serverVersion = /AGENT_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(monitorSource);
    assert.ok(agentVersion, 'agent 有 VERSION');
    assert.ok(serverVersion, '服务端有 AGENT_PROTOCOL_VERSION');
    assert.equal(agentVersion[1], serverVersion[1],
        '两侧协议版本必须一致——改一侧就要改另一侧');

    const code = stripComments(monitorSource);
    assert.match(code, /payload\.version\s*!==\s*AGENT_PROTOCOL_VERSION/,
        '版本不符时明确报错');
});

test('模块按服务器渲染多张卡片，布局键用 instanceId', () => {
    // 一个模块渲染多张卡片时，若都用 moduleId 作布局键，
    // 它们的 order 与 side 会互相覆盖——拖一张，另几张跟着变。
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(moduleSource, /return visible\.map\(buildCard\)/,
        'mountWidget 返回节点数组，一台一张（visible 是过滤后的）');
    assert.match(moduleSource, /id:\s*'local'[\s\S]*?name:\s*'本机'/,
        '本机固定排第一且不需要配置');
    assert.match(appSource, /Array\.isArray\(mounted\)/, '平台支持多卡片返回');
    assert.match(appSource, /dataset\.instanceId\s*=/, '每张卡片有独立的布局键');

    // 布局键必须绑定**服务器 id**，不是数组下标。
    // 用下标的话，隐藏一张卡片会让后面所有卡的键整体前移——
    // 用户只是关了一台机器，所有人的顺序与左右却全乱了。
    assert.match(moduleSource, /dataset\.instanceId\s*=\s*`server-monitor:\$\{entry\.id\}`/,
        '布局键绑定服务器 id');
    assert.doesNotMatch(appSource, /\$\{id\}:\$\{i\}/,
        '不得用数组下标拼布局键——隐藏一张会让其余卡片整体错位');

    // 三处读写布局键的地方必须统一用 instanceId 优先
    const keyOf = appSource.match(/const keyOf = node => node\.dataset\.instanceId \|\| node\.dataset\.moduleId;/);
    assert.ok(keyOf, 'applyWidgetLayout 有统一的键解析');
    const dragKey = /const id = widget\.dataset\.instanceId \|\| widget\.dataset\.moduleId;/;
    assert.match(appSource, dragKey, '拖拽用同一套键');
    const commitKey = appSource.match(/const key = node\.dataset\.instanceId \|\| node\.dataset\.moduleId;/g) || [];
    assert.ok(commitKey.length >= 2, '落盘与落点高亮也用同一套键');
});

test('服务器列表的触控目标不得低于 44px', () => {
    // 回归记录：列表曾是一行一台、按钮挤在右侧，实测 26px——低于 44px 触摸下限。
    // 那个高度是为「三个按钮挤一行」刻意定的（本轮加的「检测连通性」变成四个），
    // 改成一台一张卡、横向 grid 排多台后，卡内竖排才有空间做达标的目标。
    //
    // 守卫要钉的是**两半**：目标达标 + 不退回单行紧凑排布。
    // 只查 min-height 的话，把容器改回一行一台照样能过——那正是当初的形态。
    const css = fs.readFileSync(path.join(ROOT, 'public', 'admin.css'), 'utf8');

    // 按钮与开关都要达标
    const btn = /\.modal \.server-item-actions \.btn\s*\{([^}]*)\}/.exec(css);
    assert.ok(btn, '找到 .server-item-actions .btn 规则');
    const h = Number(/min-height:\s*(\d+)px/.exec(btn[1])?.[1]);
    assert.ok(h >= 44, `列表行按钮 min-height 应 ≥44px，实际 ${h}px`);

    const show = /\.modal \.server-item-show\s*\{([^}]*)\}/.exec(css);
    assert.ok(show, '找到 .server-item-show 规则');
    const sh = Number(/min-height:\s*(\d+)px/.exec(show[1])?.[1]);
    assert.ok(sh >= 44, `可见性开关 min-height 应 ≥44px，实际 ${sh}px`);

    // 容器是 grid：一台一张卡、横向排多台
    const list = /\.modal #serverList\s*\{([^}]*)\}/.exec(css);
    assert.ok(list, '找到 #serverList 规则');
    assert.match(list[1], /display:\s*grid/, '列表容器是 grid');
    assert.match(list[1], /grid-template-columns:\s*repeat\(auto-fill/, '按可用宽度自动增列');

    // 卡内竖排（flex-direction: column），这是纵向腾出空间的前提
    const card = /\.modal \.server-item\s*\{([^}]*)\}/.exec(css);
    assert.ok(card, '找到 .server-item 规则');
    assert.match(card[1], /flex-direction:\s*column/, '卡内竖排');
    // 退回一行一台的旧形态：flex-direction 不再有 column
    assert.doesNotMatch(card[1], /flex-direction:\s*row/, '不得退回单行横排');

    // 窄屏缩字号但**不降高度**——窄屏正是触摸设备，降高度只会把
    // 已经达标的目标打回 26。正向要求：窄屏块里根本不出现按钮高度声明。
    const narrow = mediaBlockOf(css, '@media (max-width: 700px)');
    assert.ok(narrow, '存在 max-width: 700px 块');
    assert.doesNotMatch(narrow, /server-item-actions\s+\.btn[^{]*\{[^}]*min-height/,
        '窄屏块里不得下调按钮高度');
    assert.doesNotMatch(narrow, /server-item-show[^{]*\{[^}]*min-height/,
        '窄屏块里不得下调开关高度');
});

/** 取出某个 @media 查询的正文（取第一个同查询块）。 */
function mediaBlockOf(css, query) {
    const start = css.indexOf(query);
    if (start === -1) return null;
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(open + 1, i); }
    }
    return null;
}

test('每台服务器可单独控制是否在首页显示', () => {
    const appCode = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
    const modCode = stripComments(moduleSource);

    // 过滤逻辑：enabled === false 才隐藏，缺省为显示
    assert.match(modCode, /filter\(w => w\.enabled === false\)/, '只隐藏显式关掉的');
    assert.match(modCode, /hidden\.has\(`server-monitor:\$\{e\.id\}`\)/, '按服务器 id 匹配');
    // 本机不可关：关掉后模块区可能全空且无处可恢复
    assert.match(modCode, /e\.id === 'local' \|\| !hidden\.has/, '本机始终可见');

    // 界面：每行一个开关，且立即落盘
    assert.match(appCode, /data-server-visible=/, '每行有可见性开关');
    // 断言范围限定在这个方法体内：用 [\s\S]*? 扫全文件会跨到别的方法去
    const save = appCode.slice(appCode.indexOf('async saveServerVisibility(key, shown, config)'));
    assert.ok(save.length > 200, 'saveServerVisibility 方法被正确切出');
    assert.match(save.slice(0, 900), /API\.post\('\/api\/modules\/config'/,
        '走模块配置端点落盘');
    // 只改这一条的 enabled，其余原样带回
    assert.match(save, /const widgets = \(config\.widgets \|\| \[\]\)\.map\(w => \(\{ \.\.\.w \}\)\)/,
        '复制后只改目标那条，不动其他服务器的顺序与左右');
    // 失败要回滚界面，否则显示的是一个没生效的状态
    assert.match(save, /Save server visibility failed[\s\S]*?renderModulesEditor\(\)/,
        '保存失败后重绘列表，把开关拨回去');
});

test('模块不写 hidden 属性，显隐交给平台', () => {
    const code = stripComments(moduleSource);
    assert.doesNotMatch(code, /handle\.hidden\s*=/,
        '拖拽把手显隐由 .module-zone.is-editing 控制，模块不写 hidden');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    assert.match(css, /\.module-zone\.is-editing \.module-drag-handle\s*\{[^}]*display:\s*block/,
        '平台侧有对应的显示规则');
});

test('agent 随发布包分发', () => {
    // 不打进包的话，多服务器功能对下载者等于不存在。
    const release = fs.readFileSync(path.join(ROOT, 'scripts', 'release.sh'), 'utf8');
    assert.match(release, /cp -r agent/, 'release.sh 复制 agent/ 目录');
    assert.ok(fs.existsSync(path.join(ROOT, 'agent', 'agent.js')), 'agent 文件在仓库里');
});

test('监控端点返回全部服务器，且本机无需配置', () => {
    const code = stripComments(serverSource);
    const route = code.slice(code.indexOf("app.get('/api/modules/metrics'"),
        code.indexOf("app.post('/api/modules/servers'"));
    assert.match(route, /collectAllServers/, '端点走多机采集');
    assert.match(route, /servers:\s*cached\.value\.servers/, '缓存的是整份列表');
});

test('服务器配置变更时让采集缓存失效', () => {
    // 缓存 TTL 5 分钟，但它缓存的是「上次采到了什么」，而采集目标由配置决定。
    // 不清缓存的症状是「新加的机器不出现、删掉的还在」，要等满 5 分钟才自愈。
    // 用户实测时正是这样看到的：配好四台机器，首页仍只有一张空卡片。
    //
    // 这不是优化，是正确性——配置是缓存的输入，输入变了缓存就该失效。
    const code = stripComments(serverSource);
    assert.match(code, /function invalidateMetricsCache\(\)/, '有失效函数');
    assert.match(code, /DELETE FROM module_cache WHERE key = \?/, '按 key 删除，不清空整表');

    // 三条会改变采集目标的写入路径都要调用它
    const addServer = code.slice(code.indexOf("app.post('/api/modules/servers'"),
        code.indexOf("app.delete('/api/modules/servers/:id'"));
    assert.match(addServer, /invalidateMetricsCache\(\)/, '添加/编辑服务器后清缓存');

    const delServer = code.slice(code.indexOf("app.delete('/api/modules/servers/:id'"),
        code.indexOf('// ========== Paste API =========='));
    assert.match(delServer, /invalidateMetricsCache\(\)/, '删除服务器后清缓存');

    // 切片终点用**下一条路由**，不能用 invalidateMetricsCache 的定义位置——
    // 它定义在 config 路由**之前**，拿它当终点会切出负长度区间。
    const saveConfig = code.slice(code.indexOf("app.post('/api/modules/config'"),
        code.indexOf('/**\n * 解密一台目标机的 token'));
    assert.ok(saveConfig.length > 200, 'config 路由被正确切出');
    assert.match(saveConfig, /invalidateMetricsCache\(\)/, '保存模块配置时按需清缓存');
});

test('只改布局不清缓存——否则缓存形同虚设', () => {
    // /api/modules/config 也用于拖拽排序与开关模块，那两种改动不影响采集目标。
    // 无条件清缓存会让「加一台机器立刻可见」这个修复变成「任何保存都重采」，
    // 5 分钟 TTL 就再没有意义了。
    const code = stripComments(serverSource);
    const route = code.slice(code.indexOf("app.post('/api/modules/config'"),
        code.indexOf('/**\n * 解密一台目标机的 token'));

    // 调用必须被条件包住
    const guard = /if \(normalized\.servers !== undefined\)\s*\{[\s\S]*?before\s*!==\s*after\s*\)\s*invalidateMetricsCache\(\)/;
    assert.match(route, guard, '清缓存前先比较 servers 是否真的变了');
    assert.match(route, /JSON\.stringify\(existing\.servers/, '与合并前的列表比较');
    assert.match(route, /JSON\.stringify\(merged\.servers/, '与合并后的列表比较');
});

test('更新周期可配，且白名单在服务端裁决', () => {
    // 周期直接决定请求频率：10 秒以下会撞管理端限流（30 次/分钟），
    // 5 分钟以上又与默认缓存 TTL 相同、失去意义。所以是白名单而非自由输入，
    // 且校验必须发生在服务端——前端绕不过去。
    const code = stripComments(serverSource);
    const serverList = /const POLL_INTERVALS = \[([\d,\s]+)\]/.exec(code);
    assert.ok(serverList, '服务端有白名单字面量');
    assert.match(code, /function resolvePollInterval\(value\)/, '有白名单校验');
    assert.match(code, /POLL_INTERVALS\.includes\(n\)\s*\?\s*n\s*:\s*15/, '非法值回落到默认');

    // 归一化与合并都要处理这个键
    assert.match(code, /out\.pollInterval\s*=\s*resolvePollInterval\(body\.pollInterval\)/,
        '写入时过白名单');
    assert.match(code, /pollInterval:\s*resolvePollInterval\(pick\('pollInterval'\)\)/,
        '合并时沿用既有值——前端保存布局通常不提交这个键，无条件重置会改掉用户设过的周期');
});

test('前后端的周期白名单逐项一致', () => {
    // 两份列表各写一份必然漂移：前端多一项，服务端静默回落默认，
    // 用户选了一个「看起来存在」却不生效的周期；前端少一项则给不出去。
    // 只断言服务端那份字面量完全挡不住这类漂移——要真的比较两侧。
    const serverList = /const POLL_INTERVALS = \[([\d,\s]+)\]/
        .exec(stripComments(serverSource))?.[1]
        .split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n)).sort((a, b) => a - b);

    const appCode = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
    const fn = appCode.slice(appCode.indexOf('pollIntervalOptions(current)'));
    const appList = (fn.slice(0, 400).match(/\[([\d,\s]+)\]\.map/) || [])[1]
        .split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n)).sort((a, b) => a - b);

    assert.ok(serverList.length >= 3, `服务端列表解析出 ${serverList.length} 项`);
    assert.ok(appList.length >= 3, `前端列表解析出 ${appList.length} 项`);
    assert.deepEqual(appList, serverList,
        `前后端周期白名单不一致：前端 [${appList}] 服务端 [${serverList}]`);
});

test('缓存 TTL 跟着轮询周期走，否则「设成 10 秒」是空话', () => {
    // 固定 5 分钟 TTL 时，前端每 10 秒问一次、服务端 5 分钟内都回同一份缓存——
    // 用户把周期改短却看不到更实时的数据，根因就在这里。
    const code = stripComments(serverSource);
    assert.match(code, /function resolveCacheTtl\(pollIntervalSeconds\)/, '有按周期算 TTL 的函数');
    assert.match(code, /Math\.min\(300,\s*Math\.max\(20,\s*seconds \+ 10\)\)/,
        'TTL = 周期 + 10s，并夹在 20s–300s 之间');

    // 端点必须真的用它，而不是仍用固定常量
    const route = code.slice(code.indexOf("app.get('/api/modules/metrics'"),
        code.indexOf("app.post('/api/modules/servers'"));
    assert.match(route, /resolveCacheTtl\(pollInterval\)/, '端点用动态 TTL');
    assert.doesNotMatch(route, /now - cached\.updatedAt < METRICS_CACHE_TTL_MS/,
        '不得仍用固定 TTL——那正是「设了短周期却不生效」的成因');
    // 周期要回给前端，否则改完要刷新页面才生效
    assert.match(route, /pollInterval\s*\}/, '响应里带上当前周期');
});

test('前端按服务端回的周期重排自己的定时器', () => {
    const mod = stripComments(moduleSource);
    assert.match(mod, /let pollMs = POLL_MS/, '周期是可变状态，不是常量');
    assert.match(mod, /payload\.pollInterval/, '读服务端回的周期');
    // 这条必须锚定到「poll() 里那段」而不是 startPolling()——
    // 后者本来就有一对 clearInterval + setInterval，与「周期变化后重排」无关。
    // 早先的断言扫全文件，在 startPolling 里就命中了；变异验证：
    // 把 poll() 里的 `if (pollTimer) {` 改成 `if (false) {`（彻底关掉重排），
    // 旧断言仍全绿。断言范围必须落在 poll 的函数体内。
    const poll = mod.slice(mod.indexOf('async function poll('), mod.indexOf('function startPolling('));
    assert.ok(poll.length > 200, 'poll 函数体被正确切出');
    assert.match(poll, /if \(pollTimer\)\s*\{/, '只有在跑着的时候才重排');
    assert.match(poll, /clearInterval\(pollTimer\)[\s\S]*?setInterval\(poll,\s*pollMs\)/,
        '周期变化时重排表——否则会一直用旧周期直到下次进页面');
    // 页面不可见时暂停这条不能被改掉
    assert.match(mod, /document\.hidden/, '不可见时停表');
});

test('agent 的 health 端点不泄露主机名', () => {
    // /health 不需要鉴权（方便「agent 起来了吗」这类探测），
    // 所以返回主机名等于给每个能扫到该端口的人一份免费的资产清单。
    // 主机名只该出现在需要鉴权的 /metrics 里。
    const code = stripComments(agentSource);
    const health = code.slice(code.indexOf("req.url === '/health'"),
        code.indexOf("req.url !== '/metrics'"));
    assert.ok(health.length > 100, '切出 health 分支');
    assert.doesNotMatch(health, /hostname:\s*os\.hostname\(\)/,
        'health 默认不得返回主机名');
    // 确实想要时可以显式打开
    assert.match(health, /if \(args\.exposeHostname\)/, '主机名改为显式开关');
    assert.match(code, /'--expose-hostname'/, '有对应的命令行参数');

    // /metrics 仍然返回主机名（那里要鉴权）
    const metrics = code.slice(code.indexOf('async function collect('));
    assert.match(metrics, /hostname:\s*os\.hostname\(\)/, 'metrics 里保留主机名');
});

test('README 与 agent 源码的变量名一致，且不泄露凭据后果', () => {
    // 我在文档里把 NAVSYLPH_TOKEN 一度手写成 NAVSYP_TOKEN ——
    // 用户照着设了一个 agent 根本不读的环境变量，鉴权必然失败。
    // 变量名是这类文档最容易被改坏又最难被发现的东西，要有守卫。
    const agentCode = agentSource;
    const readme = fs.readFileSync(path.join(ROOT, 'agent', 'README.md'), 'utf8');
    const realName = /process\.env\.([A-Z_]+)/.exec(agentCode)?.[1];
    assert.equal(realName, 'NAVSYLPH_TOKEN', '源码里的变量名');
    assert.doesNotMatch(readme, /NAVSYP_TOKEN/, '文档里不得出现拼错的变量名');
    assert.ok(readme.includes(realName), '文档引用了正确的变量名');

    // token 的后果与轮换流程必须写在文档里
    assert.match(readme, /## 安全[\s\S]*token 泄露意味着什么/, '写了泄露意味着什么');
    assert.match(readme, /## 安全[\s\S]*泄露后怎么办/, '写了泄露后怎么办');
});

test('添加/编辑服务器时说明 token 的后果', () => {
    // 写在 agent/README.md 里还不够：那是给读文档的人看的，
    // 而大多数人是从「添加服务器」这个对话框进来的。
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const fn = appSource.slice(appSource.indexOf('async showServerDialog(server, onDone)'));
    assert.ok(fn.length > 400, '切出 showServerDialog');
    assert.match(fn, /message:\s*'token 等同于/, '对话框里有 token 后果说明');
    assert.match(fn, /每台用不同的值/, '提醒不要多台复用同一个 token');
    assert.match(fn, /泄露后在下方「编辑」里填新值/, '给出轮换入口');
});

test('agent 脚本可被下载，供部署命令直接 curl', () => {
    // agent/ 在仓库根而非 public/ 下（不进 SW 预缓存），所以必须有一条
    // 专门路由提供它，否则部署命令第一步就 404。
    const code = stripComments(serverSource);
    assert.match(code, /app\.get\('\/agent\/agent\.js'/, '有下载路由');
    assert.match(code, /agent',\s*'agent\.js'/, '从 agent/ 目录读');
    // URL 不变而内容会随版本变，不能给长缓存
    assert.match(code, /Cache-Control', 'no-cache'/, '按需获取，不给长缓存');
    // 404 时返回注释而不是 HTML 错误页——写进 shell 脚本里的东西
    // 必须是可读的诊断信息
    assert.match(code, /status\(404\)\.send\('\/\/ agent\.js not found/, '404 返回可读注释');
});

test('部署命令在后台生成，且不泄露明文 token', () => {
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const appCode = stripComments(app);

    assert.match(appCode, /showDeployDialog\(server\)/, '有部署命令对话框');
    assert.match(appCode, /deploy-server/, '服务器列表里有部署按钮');

    // 关键：读接口只回 hasToken，命令里只能是占位符。
    // 断言不能写成 /占位符|hasToken/ —— 变异把占位符换成 server.token 之后，
    // `hasToken ?` 还在（只是条件变了），交替匹配照样命中，护栏形同虚设。
    // 这里只认占位符本身，并额外断言没有从 server 对象直取 token。
    const deployFn = appCode.slice(appCode.indexOf('showDeployDialog(server)'),
        appCode.indexOf('showCommandPanel('));
    assert.match(deployFn, /'<你的 token>'/, '命令里用占位符');
    assert.doesNotMatch(deployFn, /server\.token/, '不得从 server 对象直取 token');
    assert.doesNotMatch(appCode, /showDeployDialog[\s\S]*?decrypt\(/,
        '部署命令不得去解密 token');

    // 命令要覆盖完整流程：下载 → 生成证书 → 试跑 → 核对指纹 → 开机自启 → 防火墙
    //
    // ⚠️ 「curl /metrics 自检」这一步是被**替换**掉的，不是被删掉的：目标机现在
    // 起 HTTPS，自签证书会让 `curl https://...` 直接报证书错误，用户以为是故障。
    // 它的位置被「在后台核对证书指纹」接替——那一步同时验证了连通性与身份。
    const fn = appCode.slice(appCode.indexOf('showDeployDialog(server)'));
    for (const step of ['curl -fsSL', 'NAVSYLPH_TOKEN=', '--gen-cert', 'systemd', 'firewall']) {
        assert.ok(fn.includes(step), `部署命令包含「${step}」这一步`);
    }
    // 证书生成与启动都必须带 --tls-cert/--tls-key，否则照抄命令起不来
    // （agent 没有证书会拒绝启动，见「拉取模式强制 TLS」那条）
    assert.match(fn, /--tls-cert/, '启动命令带证书路径');
    assert.match(fn, /--tls-key/, '启动命令带私钥路径');
    // 指纹核对这一步必须在，且要说清它替代了 curl 自检
    assert.match(fn, /检测连通性/, '部署面板提示回后台核对证书指纹');
    assert.doesNotMatch(fn, /curl\s+-H\s+"Authorization[^\n]*\/metrics/,
        '不再用裸 curl 自检（自签证书会让它失败）；改由后台探测端点完成');
    // 端口从用户填的地址里取，而不是写死
    assert.match(appCode, /new URL\(url\)\.port \|\| '4195'/, '端口取自填写的地址');

    // 仓库里也要有一份完整说明，供离线查阅
    const readme = path.join(ROOT, 'agent', 'README.md');
    assert.ok(fs.existsSync(readme), 'agent/README.md 存在');
    const text = fs.readFileSync(readme, 'utf8');
    for (const section of ['## 快速开始', '## 参数', '## 排错', '## 安全']) {
        assert.ok(text.includes(section), `README 含「${section}」`);
    }
    assert.match(text, /--host 0\.0\.0\.0/, 'README 说明必须显式监听 0.0.0.0');
});

test('部署面板的层级高于管理面板，否则点开却看不见', () => {
    // 面板是从管理面板**里面**点开的，两层是嵌套关系。初版把 z-index 写成 260，
    // 而 .modal 是 1000——面板整个被盖住、内容点不到。
    // 症状特别隐蔽：DOM 里有节点、接口测试全过、打开动作也确实触发了，
    // 只有真机点开才看得见（截图里是管理面板，看不到任何命令）。
    // .modal 的 z-index 在 styles.css，部署面板的在 admin.css——
    // 只读一个文件会得到 undefined 而误报。两边都要读。
    const adminCss = fs.readFileSync(path.join(ROOT, 'public', 'admin.css'), 'utf8');
    const stylesCss = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

    const modalZ = Number(/\.modal\s*\{[^}]*z-index:\s*(\d+)/.exec(stylesCss)?.[1]);
    const panelZ = Number(/\.command-panel-overlay\s*\{[^}]*z-index:\s*(\d+)/.exec(adminCss)?.[1]);
    assert.ok(Number.isFinite(modalZ), '.modal 的 z-index 可解析（应在 styles.css）');
    assert.ok(Number.isFinite(panelZ), '部署面板的 z-index 可解析（应在 admin.css）');
    assert.ok(panelZ > modalZ,
        `部署面板 z-index ${panelZ} 必须高于 .modal 的 ${modalZ}，否则被整个盖住`);
});

test('宽屏卡片按实测高度堆叠，不按固定步进', () => {
    // 卡片高度随内容变：在线带延迟提示 174px、在线无提示 152px、离线只有 98px。
    // 固定步进 166px 遇上 174px 的卡片就压住下一张——实测重叠 8px，两处。
    //
    // 用 CSS 变量表达「每张卡自己的偏移」做不到，因为偏移依赖前面所有卡的高度和；
    // 所以必须量了再排。断言要同时钉住三处：CSS 接受 JS 给的值、
    // JS 真的量了、以及**重排时机**（内容变了之后要重排）。
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const appCode = stripComments(app);

    assert.match(appCode, /stackWidgetsByHeight\(\)/, '有按高度堆叠的方法');
    assert.match(appCode, /node\.style\.setProperty\('--stack-top'/, '把量到的偏移写进 --stack-top');
    // 游标要累加「高度 + 间隙」，而不是索引乘常数
    assert.match(appCode, /cursor \+= height \+ GAP/, '逐张累加高度与间隙');
    assert.doesNotMatch(appCode, /cursor \+= \d+/, '不得写死步进');
    // 量的前提是宽度已经定下来，所以要在归位之后
    assert.match(appCode, /this\.stackWidgetsByHeight\(\)[\s\S]*?\}/,
        'applyWidgetLayout 里在归位之后调用');

    // 内容变化后必须重排：上线会多出延迟提示、掉线会整张变矮
    assert.match(moduleSource, /stackWidgetsByHeight/, '模块渲染后调用重排');
});

test('拖拽过程中真的移动 DOM，插入点按拖拽开始时的中线判定', () => {
    // 两个缺陷都在这里，各自的表现完全不同：
    //
    // 1. **不移动 DOM**：早先只在松手时按「DOM 当前顺序」写 order，
    //    可节点从没被移动过，读回来的还是原顺序——拖 NAS 到本机位置，
    //    两者纹丝不动。
    // 2. **每帧读实时中线**：卡片一旦让位，上方那张的中线也跟着移位，
    //    于是「指针 < 中线」在自己造成的移动中失配——实测把最后一张
    //    拖到最前，怎么拖都插不进去。
    //
    // 所以：拖拽中必须 insertBefore，中线必须量一次并缓存。
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const appCode = stripComments(app);

    // 1) 拖拽中插入，而不是只在结束时写 order
    assert.match(appCode, /reorderWhileDragging\(ev\.clientY, ev\.clientX\)/,
        'pointermove 里就调用插入逻辑');
    const fn = appCode.slice(appCode.indexOf('reorderWhileDragging(clientY, clientX)'));
    assert.match(fn, /insertBefore\(widget, anchor\.node\)/, '用 insertBefore 真正移动节点');
    assert.match(fn, /appendChild\(widget\)/, '拖到末尾时追加');

    // 2) 中线只量一次并缓存
    assert.match(fn, /if \(!drag\.bounds\)/, '中线缓存有判空');
    assert.match(fn, /drag\.bounds\s*=\s*\[/, '中线被缓存到 dragData');
    // 缓存之后不再读实时几何
    const afterCache = fn.slice(fn.indexOf('if (!drag.bounds)'));
    const cacheBlock = afterCache.slice(0, afterCache.indexOf('if (!drag.bounds.length) return;'));
    assert.match(cacheBlock, /getBoundingClientRect\(\)/, '中线在缓存块里量一次');
    assert.doesNotMatch(afterCache.slice(afterCache.indexOf('if (!drag.bounds.length) return;')),
        /getBoundingClientRect\(\)/,
        '缓存之后不得再读实时几何——让位会让中线漂移，比较必然失配');

    // 3) 每次插入后要重排纵向偏移，否则让位了位置却没动
    assert.match(fn, /this\.stackWidgetsByHeight\(\)/, '插入后重算 --stack-top');

    // 4) 新一次拖拽必须清掉上一次的缓存
    assert.match(appCode, /this\.dragData\s*=\s*\{[^}]*bounds:\s*null/,
        'dragData 初始化时 bounds 为 null，否则第二次拖拽会沿用上一次的陈旧中线');
});

test('插入导致的基准跳变必须补进 transform，否则卡片会弹一下', () => {
    // 视觉位置 = 基准（--stack-top）+ transform。插入会让基准突变
    // （实测 376 → 188，跳了两张卡的高度），而 transform 仍相对拖拽起点——
    // 合成后卡片猛跳 247px，用户看到的是「先弹回原处再跟上指针」。
    //
    // 修法：把基准的差量补进 transform，视觉位置保持不变；
    // 同时同步 startY，否则下一帧仍用旧起点算 dy，位置会逐帧漂移。
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const appCode = stripComments(app);

    assert.match(appCode, /compensateStackShift\(widget, before, horizontal\)/,
        '插入后调用基准补偿');
    const fn = appCode.slice(appCode.indexOf('compensateStackShift(widget, beforeTop, horizontal)'));
    assert.match(fn, /const shift = after - beforeTop/, '算出基准差量');
    // 读回已有位移再叠加，不能覆盖成 0
    assert.match(fn, /readTranslate\(widget\)/, '读回当前 transform');
    // 三元里两个分支都要检查：横排改 x、竖排改 y
    assert.match(fn, /const next = horizontal[\s\S]*?\{ x: current\.x \+ shift, y: current\.y \}[\s\S]*?\{ x: current\.x, y: current\.y \+ shift \}/,
        '把差量加到对应轴的位移上（横排 x / 竖排 y）');
    // 起点要跟着基准走，否则下一帧又用旧参照
    assert.match(fn, /this\.dragData\.startY \+= shift/, '纵轴同步 startY');
    // 起点必须挂在 dragData 上才改得动
    assert.match(appCode, /this\.dragData\s*=\s*\{[^}]*startX,\s*startY/,
        'startX/startY 挂在 dragData 上');
    assert.match(appCode, /ev\.clientY - this\.dragData\.startY/,
        'move 从 dragData 读参照点');
});

test('让位的卡片有短过渡，拖拽中的那张不参与', () => {
    // 「生硬」的另一半：其余卡片是硬跳的。给 margin-top 一个短过渡让它们滑过去。
    // 但被拖的那张不能有——它的位置由 transform 连续控制，
    // 再叠一个 margin 过渡会和基准补偿打架，出现二次抖动。
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    // 样式表里有好几条 .module-widget 规则（基础、两侧定位、离线态），
    // 按首次出现取会命中 `pointer-events` 那条——要找**带 padding 的基础规则**。
    const widgetRules = [...css.matchAll(/\.module-widget\s*\{([^}]*)\}/g)].map(m => m[1]);
    const base = widgetRules.find(body => /padding:\s*13px/.test(body));
    assert.ok(base, '找到 .module-widget 的基础规则（含 padding）');
    assert.match(base, /transition:[^}]*margin-top/, '让位靠 margin-top 过渡，不是瞬移');
    // 时长要在 120–260ms 之间：太长显得拖泥带水，太短看着还是硬跳
    const ms = Number(/margin-top\s+(\d+)ms/.exec(base)?.[1]);
    assert.ok(ms >= 120 && ms <= 260, `过渡时长 ${ms}ms 需在 120–260ms 之间`);

    const dragging = /\.module-widget\.is-dragging\s*\{([^}]*)\}/.exec(css);
    assert.ok(dragging, '拖拽态有独立规则');
    assert.doesNotMatch(dragging[1], /margin-top/, '拖拽中的卡片不参与纵向过渡');
});

// ========== 推送模式 ==========

test('采集方式默认拉取，非法值一律回落而不是被静默接受', () => {
    // 回归风险：把 mode 写成「非 push 即 push」会让一个拼错的字段把机器
    // 静默切成推送——那台机器立刻掉线，而用户不知道自己改了什么。
    const fn = /function normalizeServer\(raw\) \{[\s\S]*?\n\}/.exec(stripComments(serverSource));
    assert.ok(fn, '找到 normalizeServer');
    assert.match(fn[0], /raw\.mode\s*===\s*'push'\s*\?\s*'push'\s*:\s*'pull'/,
        '只有字面量 push 才算推送，其它一律 pull');
});

test('推送模式默认不监听任何端口', () => {
    // 这是推送最大的安全收益：内网机器上一个端口都不用开。
    // 若 agent 在 --push 下仍默认 listen，用户以为没开端口，
    // 实际却把一个只靠 token 保护的 HTTPS 服务挂在了局域网里。
    const code = stripComments(agentSource);
    assert.match(code, /const SERVE_HTTP\s*=\s*!PUSH_MODE\s*\|\|\s*args\.serveAlongsidePush/,
        '是否监听由「是否推送模式」与「是否显式要求」共同决定');
    // 监听块与创建 server 已经被拆开（requestHandler 提取成具名变量，
    // 好让 https.createServer 与 http.createServer 共用它），
    // 所以这里钉住的是「创建与 listen 都在 SERVE_HTTP 之内」这个事实。
    const serveBlock = code.slice(code.indexOf('if (SERVE_HTTP) {'));
    assert.ok(serveBlock.length > 200, '拿到的是监听块而不是空壳');
    assert.match(serveBlock, /createServer\(/,
        'server 在 SERVE_HTTP 块内创建');
    assert.match(serveBlock, /server\.listen\(/,
        'listen 也在同一块内');
    // 负向断言：推送启动之后不得再出现 listen。
    // 锚点用 `startPushing();` 这个**调用点**而不是 `if (PUSH_MODE) {`——
    // 后者在文件里出现两次（参数校验处、启动处），indexOf 会命中前面那个，
    // 而它后面还隔着整个采集实现与监听块，断言于是红在正确代码上。
    const pushCall = code.indexOf('startPushing();');
    assert.ok(pushCall > 0, '推送启动调用存在于源码中');
    const startupTail = code.slice(pushCall);
    assert.ok(startupTail.length > 50, '切片拿到的是启动尾部而不是空壳');
    assert.doesNotMatch(startupTail, /\.listen\(/,
        '推送启动之后没有 listen');
});

test('推送凭据与拉取 token 是两个独立的环境变量，不互相顶替', () => {
    // 顶替的后果：把推送凭据填进 NAVSYLPH_TOKEN 会让推送 401，
    // 而错误信息只说「凭据无效」，用户查不到是自己填错了变量名。
    const code = stripComments(agentSource);
    assert.match(code, /NAVSYLPH_PUSH_SECRET/, '推送凭据有自己的环境变量');
    assert.match(code, /NAVSYLPH_SERVER_ID/, 'server id 有自己的环境变量');
    assert.doesNotMatch(code, /PUSH_SECRET\s*=\s*process\.env\.NAVSYLPH_TOKEN/,
        '推送凭据不从拉取 token 的变量里取');
});

test('推送周期与服务端的白名单一致，且非法值回落', () => {
    // 两侧必须逐项一致：agent 若能推送得比服务端限流桶更密，
    // 正常配置就会自己把自己限掉（表现是间歇性 429）。
    const agentIntervals = /const PUSH_INTERVALS\s*=\s*\[([\d,\s]+)\]/.exec(agentSource);
    const serverIntervals = /const POLL_INTERVALS\s*=\s*\[([\d,\s]+)\]/.exec(serverSource);
    assert.ok(agentIntervals, 'agent 声明了推送周期白名单');
    assert.ok(serverIntervals, '服务端声明了周期白名单');
    const normalize = s => s.split(',').map(x => Number(x.trim())).filter(Number.isFinite).sort((a, b) => a - b);
    assert.deepEqual(normalize(agentIntervals[1]), normalize(serverIntervals[1]),
        'agent 与服务端的周期白名单逐项一致');
    assert.match(stripComments(agentSource), /PUSH_INTERVALS\.includes\(value\)\s*\?\s*value\s*:\s*15/,
        '非法周期回落默认值，而不是照单全收');
});

test('推送失败时退避，且退避有上限', () => {
    // 无脑按原周期重试会持续消耗服务端的限流桶——而那个桶是全局的
    // （按 IP 计数），一台机器的重试风暴会影响其它所有 agent。
    const code = stripComments(agentSource);
    assert.match(code, /PUSH_BACKOFF_MAX_MS/, '退避有上限');
    assert.match(code, /backoff\s*=\s*Math\.min\(PUSH_BACKOFF_MAX_MS,/, '退避被夹在上限内');
    assert.match(code, /backoff\s*\*\s*2/, '失败时指数增长');
});

test('推送载荷先校验形状再写库，越界值不得原样落盘', () => {
    // 推送来的 metrics 会流到所有人的首页上，而 agent 在内网——
    // 这是未经信任的网络输入进入渲染路径的入口。
    // 回归表现：一台受控的机器靠 cpu: 1e9 就能把进度条撑破。
    const code = stripComments(serverSource);
    const fn = /function normalizePushedMetrics\(raw\) \{[\s\S]*?\n\}/.exec(code);
    assert.ok(fn, '找到 normalizePushedMetrics');
    assert.match(fn[0], /clamp\(raw\.cpu,\s*0,\s*1,\s*null\)/,
        'cpu 被夹在 [0,1]，越界回落 null（界面显示「—」）');
    assert.match(fn[0], /clamp\(raw\.memoryPercent,\s*0,\s*1,\s*null\)/, '内存百分比同样夹取');
    assert.match(fn[0], /nonNegative\(raw\.memoryUsed,\s*0\)/, '内存字节数夹取下界');
    assert.match(fn[0], /shortString\(raw\.hostname,\s*128\)/, '主机名有长度上限');
    assert.match(fn[0], /shortString\(raw\.platform,\s*32\)/, '平台名有长度上限');

    // version 越界必须回落 null：**不能**回落成 1。
    // 拉取路径遇到版本不符会明确报错（lib/monitor.js 的协议一致性检查），
    // 推送路径若把 99 当成 1 就静默渲染——同一种不一致、两种答案。
    assert.match(fn[0], /version:\s*Number\.isInteger\(raw\.version\)\s*\?\s*raw\.version\s*:\s*null/,
        'version 越界回落 null，而不是伪装成当前版本');

    // 字节数与秒数要有**上界**：只有下界时 1e308 会原样落库，
    // 进 fmtBytes 滚出一串无意义字符，而它本来是个「不可能的坏数据」。
    assert.match(fn[0], /MAX_SAFE\s*=\s*Number\.MAX_SAFE_INTEGER/, '声明了安全整数上界');
    assert.match(fn[0], /value\s*>=\s*0\s*&&\s*value\s*<=\s*MAX_SAFE/,
        'nonNegative 同时夹取下界与上界——只有下界时 1e308 会原样落库');

    // 写入顺序：校验必须在写库之前。反过来就是「先存后筛」，
    // 越界值已经落盘，只是不显示——换一次渲染路径就又显示出来了。
    const route = code.slice(code.indexOf("app.post('/api/modules/agent-push'"));
    const normAt = route.indexOf('normalizePushedMetrics(body.metrics)');
    const insertAt = route.indexOf('INSERT INTO agent_metrics');
    assert.ok(normAt > 0 && insertAt > 0, '推送端点里有校验与写入');
    assert.ok(normAt < insertAt, '先校验形状，再写库');
});

test('推送端点不挂 requireAdmin，但也不回显任何凭据', () => {
    // agent 是裸 HTTP，拿不到浏览器会话——挂上 requireAdmin 推送就废了。
    // 但它是全仓库第一个匿名可达的写端点，所以两件事必须同时成立：
    // 没有会话守卫，且错误响应不泄露任何凭据信息。
    const code = stripComments(serverSource);
    const start = code.indexOf("app.post('/api/modules/agent-push'");
    assert.ok(start > 0, '推送端点存在');
    const body = code.slice(start, code.indexOf('\napp.', start) > 0 ? code.indexOf('\napp.', start) : code.length);
    assert.doesNotMatch(body, /requireAdmin/, '推送端点不带 requireAdmin');
    assert.match(body, /pushLimit/, '推送端点有自己的限流桶');
    assert.doesNotMatch(body, /echo.*secret|json\(\{\s*secret/i,
        '推送端点的错误响应不回显凭据');
});

test('推送模式断线后保留上次数值，而不是清空', () => {
    // 回归表现：卡片在推送断掉后变回「未获取到数据」，
    // 用户分不清「刚才还好好的、网断了」与「一直没上来、配置就不对」。
    const serverCode = stripComments(serverSource);
    const fn = /function buildPushResult\(server, timeoutMs, now\) \{[\s\S]*?\n\}\n/.exec(serverCode);
    assert.ok(fn, '找到 buildPushResult');
    assert.match(fn[0], /age\s*>\s*timeoutMs/, '超阈值判为离线');

    // 切片锚在**离线分支的起点**上。`metrics,` 在函数里出现两次
    // （在线分支、离线分支各一），从函数开头切会读到在线分支那一处，
    // 于是把离线分支的 metrics 删掉时断言照样全绿。
    const offlineAt = fn[0].indexOf('age > timeoutMs');
    assert.ok(offlineAt > 0, '找到离线判定分支');
    const offlineBranch = fn[0].slice(offlineAt);
    assert.match(offlineBranch, /metrics\s*,/,
        '离线分支保留上次的 metrics —— 断线前的数值是有信息量的');
    assert.doesNotMatch(offlineBranch, /metrics:\s*null/,
        '离线分支不得把 metrics 置空');

    // 渲染侧：不能按「离线就清空」处理，否则又把它抹掉了。
    // 只扫 server-monitor.js 本文件——app.js 里的 innerHTML 是后台模板，
    // 与推送值的渲染路径无关，混进来数会让这条断言恒红。
    const modCode = stripComments(moduleSource);
    assert.match(modCode, /if\s*\(!entry\s*\|\|\s*\(!entry\.online\s*&&\s*!entry\.metrics\)\)/,
        '只有连 metrics 都没有时才走错误分支');
    assert.match(modCode, /lastUpdatedText/, '渲染最后更新时间');
    // 全部文本写入仍须是 textContent——推送值是网络输入
    const innerHtml = modCode.match(/\.innerHTML\s*=/g) || [];
    assert.equal(innerHtml.length, 0, '模块内不得有 innerHTML 写入');
});

test('推送的超时阈值独立于聚合缓存的 TTL', () => {
    // 复用 resolveCacheTtl 会让「缓存新鲜但推送已断」显示为在线：
    // 缓存命中时压根不会重采，也就不会重新判断推送的死活。
    //
    // 断言要钉的是**公式本身**，不是「有没有出现 resolveCacheTtl 这个名字」——
    // 早先只查了名字，于是把函数体换成等价的手写算式时断言照样全绿。
    const code = stripComments(serverSource);
    const fn = /function resolvePushTimeoutMs\(pollIntervalSeconds\) \{([\s\S]*?)\n\}/.exec(code);
    assert.ok(fn, '找到 resolvePushTimeoutMs');
    const body = fn[1];
    assert.match(body, /resolvePollInterval/, '用实际生效的轮询周期算');
    // 阈值必须严格大于周期：等于周期时，恰好在边界上的那次上报会被判为过期
    assert.match(body, /\*\s*2\s*\+\s*30/, '阈值是「周期 × 2 + 30 秒」——两倍余量加固定宽限');
    assert.doesNotMatch(body, /Math\.min|Math\.max/, '不夹在聚合缓存的上下界里');
    assert.doesNotMatch(body, /resolveCacheTtl/, '不复用聚合缓存的 TTL');
});

test('推送端点真的校验了凭据，而不是拿到就写库', () => {
    // 这是推送端点唯一的防线。它没有 requireAdmin（agent 拿不到浏览器会话），
    // 所以「凭据不匹配就 401」是匿名可达的写路径上全部的访问控制。
    // 回归表现：把 `if (!matched)` 写成 `if (false)` 后，任何人都能改写
    // 首页上所有服务器的指标，而测试全绿。
    const code = stripComments(serverSource);
    const start = code.indexOf("app.post('/api/modules/agent-push'");
    const end = code.indexOf('\napp.', start);
    const body = code.slice(start, end > 0 ? end : code.length);
    assert.match(body, /if\s*\(!matched\)/, '凭据没匹配上就拒绝');
    assert.match(body, /res\.status\(401\)/, '凭据不对返回 401');
    assert.match(body, /pushSecretMatches\(provided,\s*s\.pushSecretHash\)/,
        '比对的是推送凭据的哈希');
    // 匹配到机器之后才比对 serverId：不一致要明确拒绝，而不是默默写错行
    assert.match(body, /body\.serverId\s*!==\s*matched\.id/, 'serverId 错配要拦住');
    assert.match(body, /status\(409\)/, '错配返回 409');
});

test('推送端点不因限流而静默：未匹配凭据要留日志', () => {
    // 401 对用户是「推送没上来」，对管理员是「有个来源在试」。
    // 不记日志的话，agent 反复 401 而用户只能看到卡片离线，无从排查。
    const code = stripComments(serverSource);
    const start = code.indexOf("app.post('/api/modules/agent-push'");
    const end = code.indexOf('\napp.', start);
    const body = code.slice(start, end > 0 ? end : code.length);
    assert.match(body, /console\.warn\(`\[push\]/,
        '凭据被拒时记一条日志（记来源与时间，不记凭据）');
    assert.doesNotMatch(body, /console\.(?:log|warn|error)\([^)]*provided/,
        '日志里不得出现凭据本身');
});

test('推送凭据只存哈希，明文只在领取响应里出现一次', () => {
    // 与 .admin-password.json 同一处理：落盘的必须是哈希。
    // 若把明文写进 .modules.json，备份（WebDAV 会带上它）就等于交出凭据。
    const code = stripComments(serverSource);
    assert.match(code, /function hashPushSecret/, '有哈希函数');
    const gen = /function generatePushSecret\(\) \{[\s\S]*?\n\}/.exec(code);
    assert.ok(gen, '找到 generatePushSecret');
    assert.match(gen[0], /randomBytes\(/, '凭据来自 CSPRNG，不是可预测的序列');

    // 领取端点：只回 secret + id，不回显 agent token
    const start = code.indexOf("app.post('/api/modules/servers/:id/push-secret'");
    assert.ok(start > 0, '领取端点存在');
    const end = code.indexOf('\napp.', start);
    const route = code.slice(start, end > 0 ? end : code.length);
    assert.match(route, /requireAdmin/, '领取凭据必须登录后才能做');
    assert.match(route, /hashPushSecret\(secret\)/, '落盘的是哈希');
    assert.match(route, /json\(\{\s*secret,\s*serverId/, '响应只含凭据与 id');
    assert.doesNotMatch(route, /token:\s*(?:s\.|server\.)/, '不回显 agent token');
});

test('推送凭据的哈希与 agent token 一样只进不出', () => {
    // 读接口把哈希折成布尔状态，明文与密文都不该进浏览器 DOM。
    // 若归一化顺手接收 pushSecretHash，merge 的按 id 补回分支就永远走不到。
    const code = stripComments(serverSource);
    const norm = /function normalizeServer\(raw\) \{[\s\S]*?\n\}/.exec(code);
    assert.ok(norm, '找到 normalizeServer');
    assert.doesNotMatch(norm[0], /pushSecretHash/,
        '归一化不接收 pushSecretHash —— 它只由领取那一步写入');

    const merge = /function mergeModulesConfig\(existing, incoming\) \{[\s\S]*?\n\}\n/.exec(code);
    assert.ok(merge, '找到 mergeModulesConfig');
    assert.match(merge[0], /pushSecretHash:\s*previous\.pushSecretHash/,
        '按 id 合并时补回既有的凭据哈希');
});

test('agent 推送的 URL 只接受 http/https', () => {
    // 服务端在写服务器时校验了协议白名单，agent 侧推送目标同理——
    // 否则 `--push file:///…` 经 fetch 会变成一个可被利用的请求面，
    // 而 --push 是用户从命令行传的输入。
    //
    // 回归记录：这条测试原本叫这个名字却**没有任何协议断言**，而 agent
    // 确实不校验——测试名把没实现的约束写成了已实现。
    const code = stripComments(agentSource);
    assert.match(code, /new URL\(args\.push\)\.protocol/,
        '解析 --push 的协议');
    assert.match(code, /pushProtocol\s*!==\s*'http:'\s*&&\s*pushProtocol\s*!==\s*'https:'/,
        '只放行 http 与 https');
    assert.match(code, /必须以 http:\/\/ 或 https:\/\/ 开头/,
        '拒绝时给出可读的原因');

    assert.match(code, /api\/modules\/agent-push/, '推送到服务端声明的端点');
    // serverId 必须随请求带上：服务端按凭据找机器后要核对，
    // 不一致返回 409 而不是默默把数据写到别的机器名下。
    assert.match(code, /serverId:\s*SERVER_ID/, '请求带 serverId 供服务端核对');
});

test('离线分支不带 metrics，而推送断线分支带着', () => {
    // 渲染侧现在按「有没有 metrics」决定是否走错误框（推送断线要保留上次数值），
    // 而不再按 online——这要求服务端保持一条约定：**离线就不带 metrics**。
    //
    // 这条约定此前只存在于实现的巧合里，没有守卫。将来若有人给某个离线分支
    // 加上 metrics，一台实际离线的机器就会被渲染成「有数值」的样子
    // （`data-online="0"` 但显示着 CPU/内存），且没有任何测试会红。
    //
    // 范围要覆盖**两处**：离线分支分布在 collectAllServers（拉取路径的
    // token 解不开 / 拉取失败）与 buildPushResult（推送的读库失败 / 断线），
    // 只扫前者会漏掉推送那两处——而那里恰恰是「带 metrics」的那个例外。
    const code = stripComments(serverSource);
    const collectStart = code.indexOf('async function collectAllServers');
    const collectEnd = code.indexOf("\napp.get('/api/modules/metrics'", collectStart);
    assert.ok(collectStart > 0 && collectEnd > collectStart, '切出 collectAllServers');
    const collect = code.slice(collectStart, collectEnd);

    const pushStart = code.indexOf('function buildPushResult');
    const pushEnd = code.indexOf('async function collectAllServers', pushStart);
    assert.ok(pushStart > 0 && pushEnd > pushStart, '切出 buildPushResult');
    const push = code.slice(pushStart, pushEnd);

    // 拉取路径的离线分支：一处都没有 metrics
    const pullOffline = collect.match(/\{[^{}]*\bonline:\s*false[^{}]*\}/g) || [];
    assert.ok(pullOffline.length >= 2,
        `collectAllServers 里应至少有 2 处 offline 分支，实际 ${pullOffline.length}`);
    for (const b of pullOffline) {
        assert.doesNotMatch(b, /metrics\s*[:,]/,
            `拉取的 offline 分支不得带 metrics：${b.replace(/\s+/g, ' ').slice(0, 90)}`);
    }

    // 推送侧：「读库失败」不带 metrics（真的没数据），「断线」必须带（保留上次数值）
    assert.match(push, /online:\s*false,\s*error:\s*'读取推送记录失败'\s*\}/,
        '推送读库失败是一个不带 metrics 的离线分支');
    assert.match(push, /pushStale:\s*true,[\s\S]{0,200}?metrics,/,
        '推送断线分支**必须**带着上次的 metrics，否则「保留上次数值」失效');
});

test('连通性探测的每个分支都带 hint', () => {
    // 前端把提示拼进 toast：`res.hint || ''`。所以**任何**一条没有 hint 的
    // 分支，用户看到的就是「够不着这台机器。」后面什么都没有。
    //
    // 回归记录：没配 token 的那条早退原本只回 {reachable,status,error}，
    // 而「没配 token / token 解不开」恰恰是最常见的误判场景——
    // 真实原因是凭据问题，「够不够得着」根本还没验证，两者的下一步完全不同。
    const code = stripComments(serverSource);
    const start = code.indexOf("app.post('/api/modules/servers/:id/probe'");
    assert.ok(start > 0, '探测端点存在');
    const end = code.indexOf('\napp.', start);
    const route = code.slice(start, end > 0 ? end : code.length);

    // 早退分支（凭据问题）：必须**就地**带 hint。
    // 不能用 `if (error) {[\s\S]*?hint:` 这种跨函数的惰性匹配——
    // 它会一路找到后面正常分支里的 hint，于是把早退分支的 hint 删掉也照样匹配上，
    // 断言恒绿。所以切片要止于「下一个 return」或下一个分支起点。
    const earlyAt = route.indexOf('if (error) {');
    assert.ok(earlyAt > 0, '找到 token 解不开的早退分支');
    const earlyEnd = route.indexOf('const result = await fetchRemoteMetrics', earlyAt);
    assert.ok(earlyEnd > earlyAt, '早退分支的结束位置可定位');
    const earlyBranch = route.slice(earlyAt, earlyEnd);
    assert.match(earlyBranch, /hint:\s*'/,
        'token 解不开的早退分支必须带 hint —— 前端拼的是 `res.hint || \'\'`，没有就什么都不显示');
    assert.match(earlyBranch, /status:\s*'no_token'/,
        '并标明这是「没能试连」而非「够不着」');

    // 正常分支
    assert.match(route.slice(earlyEnd), /hint:/, '试连后的分支必须带 hint');

    // 401 算可达——这是整个判定的关键，路是通的、只是 token 不对
    assert.match(route, /reachable:\s*result\.ok\s*\|\|\s*result\.authFailed === true/,
        '401 算可达：路是通的');

    // 不写缓存：探测是用户主动发起的，不该污染聚合采集的缓存
    assert.doesNotMatch(route, /writeCacheRow|module_cache/,
        '探测不得写采集缓存');
});

test('编辑推送机器不会自动领取新凭据（旧凭据应继续有效）', () => {
    // 回归表现（审查发现）：编辑对话框保存后无条件打开部署面板，而部署面板
    // 会调 push-secret 领取新凭据——领取即作废旧凭据。于是「改个机器名」这种
    // 无害操作会让正在运行的 agent 从此每次上报都 401，而界面上看不出关联。
    //
    // 只有**新建**时该自动引导（用户下一步必然是领凭据）；编辑时若要换凭据，
    // 点列表行的「部署」按钮，那是有意领取、用户知道后果。
    const appCode = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
    const start = appCode.indexOf('async showServerDialog(');
    const end = appCode.indexOf('\n        renderAdminPanel(', start);
    assert.ok(start > 0 && end > start, '切出 showServerDialog');
    const fn = appCode.slice(start, end);
    assert.match(fn, /!isEdit\s*&&\s*mode === 'push'/,
        '自动打开部署面板的判断必须带 !isEdit');
    assert.match(fn, /showDeployDialog\(/, '新建推送机器时给出部署引导');
});

test('写服务器的路由真的把 mode 落盘了', () => {
    // 回归记录：界面上选了「推送」、归一化也认 push，但写服务器的路由
    // 没解构也没存 mode——于是 mode 是 undefined，采集仍走拉取分支，
    // 表现为「推送怎么推都不上来」。而这条路径上没有单元测试：
    // 归一化的单元测试是对的，坏的是另一条写路径。
    // 只有真的走一次 HTTP 写盘才看得见，见 docs/current-work.md。
    const code = stripComments(serverSource);
    const start = code.indexOf("app.post('/api/modules/servers',");
    assert.ok(start > 0, '写服务器的路由存在');
    const end = code.indexOf('\napp.', start);
    const route = code.slice(start, end > 0 ? end : code.length);
    assert.match(route, /\{\s*id,\s*name,\s*url,\s*token,\s*mode\s*\}/,
        '请求体解构出 mode');
    assert.match(route, /mode:\s*mode\s*===\s*'push'\s*\?\s*'push'\s*:\s*'pull'/,
        '写盘时裁决 mode，且与 normalizeServer 同一套规则');
});

test('编辑一台机器不会抹掉已领取的推送凭据', () => {
    // 回归表现（浏览器/端到端实测）：给推送机改个名字，pushSecretHash 被抹掉，
    // 读接口的 hasPushSecret 变成 false，agent 从此每次上报都 401——
    // 而界面上没有任何地方解释为什么，改名字和凭据失效看不出关联。
    //
    // 根因是**整体替换 entry**：这条写路径只补回了 token，漏了 pushSecretHash。
    // mergeModulesConfig 那条路径补对了，所以「保存模块配置」不会丢——
    // 两条写路径里只有这条漏了，只测 merge 会完全看不见。
    const code = stripComments(serverSource);
    const start = code.indexOf("app.post('/api/modules/servers',");
    const end = code.indexOf('\napp.', start);
    const route = code.slice(start, end > 0 ? end : code.length);

    const editBranch = route.slice(route.indexOf('if (index >= 0)'));
    assert.ok(editBranch.length > 0, '找到编辑分支');
    assert.match(editBranch, /entry\.token\s*=\s*servers\[index\]\.token/,
        '编辑时补回 token');
    assert.match(editBranch, /entry\.pushSecretHash\s*=\s*servers\[index\]\.pushSecretHash/,
        '编辑时**同样**补回 pushSecretHash —— 漏掉就会因改个名字而使凭据失效');

    // 领取凭据那一步写的正是同一个字段，两条路径必须对上
    const issue = code.slice(code.indexOf("app.post('/api/modules/servers/:id/push-secret'"));
    assert.match(issue.slice(0, issue.indexOf('\napp.')), /pushSecretHash:\s*hashPushSecret\(secret\)/,
        '领取端点写入的就是 pushSecretHash');
});

test('推送端点用到的中间件与常量都在路由之上定义', () => {
    // 回归记录：pushLimit 的 Map/常量定义在路由下方，app.post 的第二个
    // 参数在注册时就要求中间件存在，而 const 有暂时性死区——
    // 服务器启动即抛 `pushLimit is not defined`。
    //
    // 为什么 193 个单元测试和 node --check 都是绿的：语法检查不查标识符
    // 是否已定义，静态断言更看不出「谁在什么时候求值」。只有真正把
    // 服务器起起来才会暴露——所以这条断言比较的是**位置**。
    const code = stripComments(serverSource);
    const defAt = code.indexOf('function pushLimit(');
    const routeAt = code.indexOf("app.post('/api/modules/agent-push'");
    assert.ok(defAt > 0, 'pushLimit 中间件已定义');
    assert.ok(routeAt > 0, '推送路由存在');
    assert.ok(defAt < routeAt, 'pushLimit 必须定义在路由之上（否则启动即 ReferenceError）');

    // 限流 Map 也要在清理定时器之上：那个定时器 60 秒后才触发并引用它
    const sweepAt = code.indexOf('sweepRateLimitStore(pushLimitMap');
    const mapAt = code.indexOf('const pushLimitMap');
    assert.ok(sweepAt > 0, '清理定时器扫了推送桶');
    assert.ok(mapAt > 0, 'pushLimitMap 已声明');
    assert.ok(mapAt < sweepAt, 'pushLimitMap 必须在定时器之前声明');
});

// ========== 传输加密：pull 模式强制 HTTPS ==========

test('拉取模式缺 TLS 证书时拒绝启动，不监听明文', () => {
    // 修之前的形状：agent 永远 http.createServer，token 明文过网。
    // token 是那台机器的只读监控凭据，拿到就能读 CPU、内存、主机名——
    // 所以这里钉的是「没有证书就没有监听」，而不是「有证书就走 https」。
    const code = stripComments(agentSource);
    const gate = /if\s*\(\s*!hasCert\s*&&\s*!args\.insecureHttp\s*\)[\s\S]*?process\.exit\(1\)/.exec(code);
    assert.ok(gate, '缺证书且未显式 --insecure-http 时退出');
    assert.match(code, /const hasCert\s*=\s*Boolean\(args\.tlsCert\s*&&\s*args\.tlsKey\)/,
        '两个路径都给了才算有证书（只给一个必须失败）');
    // 逃生门必须是显式的，不能成为默认
    assert.match(code, /insecureHttp:\s*false/, '--insecure-http 默认关闭');
});

test('agent 有证书时起 HTTPS，且证书在启动时校验可读', () => {
    const code = stripComments(agentSource);
    assert.match(code, /https\.createServer\(\{[\s\S]*?cert:\s*fs\.readFileSync\(args\.tlsCert\)/,
        '带证书时用 https.createServer');
    assert.match(code, /key:\s*fs\.readFileSync\(args\.tlsKey\)/, '同时读私钥');
    // 证书路径写了却读不到，要指名文件而不是抛一段无关 ENOENT
    assert.match(code, /--tls-cert['"]\s*,\s*args\.tlsCert[\s\S]*?--tls-key['"]\s*,\s*args\.tlsKey[\s\S]*?fs\.accessSync/,
        '启动前校验证书与私钥可读');
});

test('证书生成只经参数传入，不拼 shell 字符串', () => {
    // 主机名来自 os.hostname()，而主机名可以含分号。拼进 shell 字符串
    // 等于给一台叫 "x; rm -rf ~" 的机器开了执行的口子。
    const code = stripComments(agentSource);
    assert.match(code, /execFileSync\(\s*'openssl'/, '用 execFileSync 传参数');
    assert.doesNotMatch(code, /exec\(\s*`openssl[^`]*\$\{/,
        '不得把变量拼进 shell 命令字符串');
    assert.match(code, /'-subj',\s*`\/CN=\$\{subjectName\}`/,
        '主机名作为独立参数传入');
});

test('拉取时拒 http，且证书类错误不塌缩成「机器离线」', async () => {
    const { fetchRemoteMetrics } = require(path.join(ROOT, 'lib', 'monitor'));

    // 明文直接拒，不发请求
    const insecure = await fetchRemoteMetrics({ url: 'http://192.168.1.10:4195', token: 'x' });
    assert.equal(insecure.ok, false);
    assert.equal(insecure.insecure, true, '回 insecure 标记，界面据此给迁移引导');
    assert.match(insecure.error, /https/, '错误信息指向 https');

    // 连接不通时必须是「无法连接」，不能是证书相关——两者处置完全不同
    const unreachable = await fetchRemoteMetrics({ url: 'https://127.0.0.1:1', token: 'x' });
    assert.equal(unreachable.ok, false);
    assert.match(unreachable.error, /无法连接/);
    assert.notEqual(unreachable.needTrust, true, '连不上不等于「待确认证书」');
    assert.notEqual(unreachable.certMismatch, true);
});

test('服务端 require 的每个 monitor 导出都真实存在', () => {
    // 回归记录：函数改名 fetchPeerFingerprint → fetchPeerCert 时漏改导出，
    // require 得到的 fetchPeerCert 是 undefined，配对端点真实运行时永远 502。
    // 而当时 334 条测试全绿——它们断言的是**源码形状**（服务端调用了
    // fetchPeerCert），不是「这个导出真的存在」。形状对了、值为 undefined，
    // 源码形状断言无从发现。所以这条直接取实际导出并逐个断言是函数。
    //
    // 同时钉住「服务端 import 的名字 ⊆ 模块导出的名字」这个不变量，
    // 让同类改名漏改在编译期之外的第一道检查就被抓住。
    const monitor = require(path.join(ROOT, 'lib', 'monitor'));
    for (const name of ['readLocalMetrics', 'fetchRemoteMetrics', 'fetchPeerCert']) {
        assert.equal(typeof monitor[name], 'function', `${name} 是可调用的导出`);
    }
    // 反向：服务端 import 的每个名字都必须有导出
    const imported = serverSource.match(/const \{([^}]+)\} = require\('\.\/lib\/monitor'\)/);
    assert.ok(imported, '服务端确实从 lib/monitor import');
    for (const raw of imported[1].split(',')) {
        const name = raw.trim();
        if (!name) continue;
        assert.notEqual(monitor[name], undefined,
            `服务端 import 的 ${name} 在 lib/monitor 里没有导出`);
    }
});

test('改名后不留悬空引用：配对端点不引用已不存在的变量', () => {
    // 回归记录：fetchPeerFingerprint 改名成 fetchPeerCert 后，配对端点的
    // 响应里还写着 `fingerprint: actual` —— 那个变量早已不存在，于是
    // 真实运行时抛 ReferenceError 回 500。而 node --check 不查标识符是否
    // 定义，源码形状断言也只核对「调用了 fetchPeerCert」。
    //
    // 不用「枚举路由里所有裸标识符」那种写法：白名单要么漏一个（假红）、
    // 要么宽到永远绿（假绿），实测两条路都走不通。改成直接钉住这个缺陷的
    // 形状——响应里那个字段必须来自实际存在的变量。
    const code = stripComments(serverSource);
    const start = code.indexOf("app.post('/api/modules/servers/:id/trust-cert'");
    assert.ok(start > 0, '配对路由存在');
    // 边界用「下一个路由声明」并断言它真的找到了。⚠️ 锚点必须是**代码**：
    // code 是 stripComments 之后的源码，注释行去 indexOf 会返回 -1，
    // 而 slice(start, -1) 会静默切出「从 -1 到末尾」的整段，把后面几十个
    // 函数的标识符全算进来（实测踩过）。
    const nextRoute = code.indexOf("\napp.post('/api/modules/agent-push'", start);
    assert.ok(nextRoute > start, '找到路由的下边界');
    const body = code.slice(start, nextRoute);
    assert.ok(body.length > 200 && body.length < 4000,
        `切片是单条路由的长度（${body.length}），不是空壳也不是整个文件`);

    assert.match(body, /res\.json\(\{ success: true, fingerprint: peer\.fingerprint \}\)/,
        '成功响应里的指纹来自实际存在的 peer');
    // 负向：`actual` 这类改名前的局部变量不得再出现
    assert.doesNotMatch(body, /:\s*actual\b/,
        '不引用改名后已不存在的变量 actual');
});

test('lib/monitor 本轮新增的导出都被 server.js 用到', () => {
    // fetchPeerFingerprint 改名后既没导出也没被调用，注释还写着
    // 「探测端点与 fetchRemoteMetrics 用它」—— 两个调用点都改用了
    // fetchPeerCert。注释与事实相反会误导下一个改动。
    const code = stripComments(monitorSource);
    assert.doesNotMatch(code, /function fetchPeerFingerprint/,
        '只指纹的包装函数已无消费者，应删除');
    // 只钉**本轮新增**的那个导出。AGENT_PROTOCOL_VERSION 是既有的死导出
    // （server.js 里零引用），把它算进来会让这条断言红在一个与本次改动
    // 无关的既有问题上——那属于待办，不属于这次的红。
    assert.match(code, /fetchPeerCert/,
        'fetchPeerCert 已导出');
    assert.ok(serverSource.includes('fetchPeerCert'),
        'server.js 确实消费 fetchPeerCert');
    // 反向：服务端 import 的名字必须在导出里（改名漏改导出正是本轮真发生的 bug）
    const imported = serverSource.match(/const \{([^}]+)\} = require\('\.\/lib\/monitor'\)/);
    assert.ok(imported, '服务端确实从 lib/monitor import');
    const monitor = require(path.join(ROOT, 'lib', 'monitor'));
    for (const raw of imported[1].split(',')) {
        const name = raw.trim();
        if (!name) continue;
        assert.notEqual(monitor[name], undefined,
            `服务端 import 的 ${name} 在 lib/monitor 里没有导出`);
    }
});

test('两种证书结果分开：未配对 vs 已配对但证书变了', () => {
    // 这两种情况都表现为「拉不到数据」，但一个是「还没做这一步」，
    // 另一个是安全事件。塌缩成同一句话会让用户照着错误方向排查。
    const code = stripComments(monitorSource);
    assert.match(code, /if\s*\(server\.certPem\)\s*\{[\s\S]*?certMismatch:\s*true/,
        '已配对却仍报证书错 → certMismatch');
    assert.match(code, /needTrust:\s*true/, '未配对 → needTrust');
    // 证书错误码要单列，否则会落进 ECONNREFUSED 分支显示成机器离线
    assert.match(code, /SELF_SIGNED_CODES\s*=\s*new Set\(\[([\s\S]*?)DEPTH_ZERO_SELF_SIGNED_CERT/,
        '自签证书错误码被显式枚举');
});

test('拉取用 https.request 并透传 ca，才能验自签证书', () => {
    const code = stripComments(monitorSource);
    // 实测（Node 22）：checkServerIdentity 在证书链无效时根本不会被调用，
    // OpenSSL 先抛 DEPTH_ZERO_SELF_SIGNED_CERT。所以「自定义指纹比对」不可行，
    // 唯一可行的是把该机器的证书作为可信锚点传进 ca。
    assert.match(code, /https\.request\(/, '走 node:https 而不是内置 fetch');
    assert.match(code, /ca,/, '把 ca 透传给请求');
    assert.doesNotMatch(code, /checkServerIdentity/,
        '不依赖 checkServerIdentity（实测在自签证书场景下不会被调用）');
});

test('SNI 不给 IP，否则触发 DEP0123 弃用警告', () => {
    const code = stripComments(monitorSource);
    assert.match(code, /servername:\s*net\.isIP\(parsed\.hostname\)\s*\?\s*undefined\s*:\s*parsed\.hostname/,
        '按是否为 IP 决定要不要设 servername');
});

test('两条写路径都补回已配对的证书，改个名字不会抹掉它', () => {
    // 症状隐蔽：配对好好的机器，用户改了个名字，采集又报「证书未受信任」，
    // 而界面上看不出这两件事有关联。
    const code = stripComments(serverSource);
    const merge = code.slice(code.indexOf('function mergeModulesConfig('),
        code.indexOf('\nfunction ', code.indexOf('function mergeModulesConfig(') + 10));
    assert.match(merge, /certPem:\s*previous\.certPem/,
        '模块配置合并补回 certPem（拖拽排序走这条路）');
    assert.match(merge, /certFingerprint:\s*previous\.certFingerprint/,
        '并补回 certFingerprint');

    const route = code.slice(code.indexOf("app.post('/api/modules/servers'"),
        code.indexOf("app.delete('/api/modules/servers/:id'"));
    assert.ok(route.length > 200, '切片拿到整条写路由');
    assert.match(route, /entry\.certPem\s*=\s*servers\[index\]\.certPem/,
        '编辑单台机器时补回 certPem');
    assert.match(route, /entry\.certFingerprint\s*=\s*servers\[index\]\.certFingerprint/,
        '并补回 certFingerprint');
});

test('确认证书前重抓一次比对，不一致就不写', () => {
    // 用户点「确认」到服务端落盘之间有个时间差。服务端自己再抓一次，
    // 对不上就拒——否则那段时间里换掉的证书会被当成「用户认可的」。
    const code = stripComments(serverSource);
    const route = code.slice(code.indexOf("app.post('/api/modules/servers/:id/trust-cert'"),
        code.indexOf('\napp.', code.indexOf("app.post('/api/modules/servers/:id/trust-cert'") + 10));
    assert.ok(route.length > 200, '切片拿到整条配对路由');
    assert.match(route, /fetchPeerCert/, '落盘前重新抓一次证书');
    assert.match(route, /409/, '不一致时 409');
    // 409 分支必须真的不写
    const mismatch = route.slice(route.indexOf('409'));
    const writeAt = route.indexOf('await writeJSON');
    assert.ok(writeAt > mismatch.indexOf('409'), '写盘发生在 409 之后，即不一致时已返回');
});

test('读接口不回显证书 PEM，只给配对状态', () => {
    // PEM 有 1KB+ 且前端用不到；前端只需要知道「配对过没有」，
    // 否则用户会被反复要求确认同一张证书。
    const code = stripComments(serverSource);
    const read = code.slice(code.indexOf("app.get('/api/modules/config'"),
        code.indexOf("app.post('/api/modules/config'"));
    assert.match(read, /\{\s*token,\s*pushSecretHash,\s*certPem,\s*\.\.\.rest\s*\}/,
        '解构时摘掉 certPem');
    assert.match(read, /hasCert:\s*Boolean\(certPem\)/, '只回布尔状态');
});

test('前端：探测遇到待确认证书时弹指纹核对，确认后才落盘', () => {
    const app = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
    const probe = app.slice(app.indexOf('.probe-server'));
    assert.ok(probe.length > 200, '切片拿到探测按钮的处理逻辑');
    assert.match(probe, /need_trust/, '识别 need_trust 分支');
    assert.match(probe, /trust-cert/, '确认后调配对端点');
    assert.match(probe, /fingerprint:\s*res\.fingerprint/, '把指纹带上去');
    // 确认框必须默认不勾选：默认勾选等于把「核对」这个动作架空
    assert.match(probe, /checked:\s*false/, '确认框默认未勾选');
    // 未勾选就点确认必须有提示。实测发现静默 return 的后果：对话框一关，
    // 徽章不变、没有任何文字，「没勾」与「点了取消」表现完全一样，
    // 用户会以为证书已经配好了。
    //
    // ⚠️ 不能写成 `if (...) {[\s\S]*?showToast(` —— 那个 `[\s\S]*?` 没有上界，
    // 会越过 if 块去匹配后面别的分支里的 showToast，删掉提示照样绿（实测踩过）。
    // 这里显式切出 if 块本身，再在块内找 showToast。
    const noTrustAt = probe.indexOf('if (!ok || !ok.choices.trust)');
    assert.ok(noTrustAt > 0, '找到未勾选的处理分支');
    const blockEnd = probe.indexOf('}', probe.indexOf('return;', noTrustAt));
    assert.ok(blockEnd > noTrustAt, '找到该分支的结束');
    const trustBlock = probe.slice(noTrustAt, blockEnd);
    assert.ok(trustBlock.length < 600, `分支长度合理（${trustBlock.length}）`);
    assert.match(trustBlock, /showToast\(/,
        '未勾选时给出提示，而不是静默返回');
    assert.match(trustBlock, /if\s*\(ok\)/,
        '只有「点了确认但没勾选」才提示；真取消时不该打扰用户');
});

test('renderServerList 里不引用它没有的参数', () => {
    // 回归记录（浏览器实测发现）：配对成功后写的是 `await onDone()`，
    // 而 onDone 是 showServerDialog 的参数名，本方法
    // renderServerList(host, config) 根本没有它 —— 真实点击时抛
    // ReferenceError，被外层 catch 吞成「检测失败，请重试」。
    // **服务端其实已经存好证书**，界面却显示失败且徽章不刷新，
    // 用户会以为配对没成功而反复重来。
    //
    // 这类缺陷对源码形状断言是隐形的：它看起来只是一句正常的重绘调用。
    // 所以这里比对「方法签名声明了什么」与「方法体里用了哪些局部标识符」。
    const app = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
    const sigAt = app.indexOf('renderServerList(host, config) {');
    assert.ok(sigAt > 0, '找到 renderServerList 方法');
    // 边界：下一个同缩进的方法定义
    const nextAt = app.indexOf('\n        async ', sigAt);
    assert.ok(nextAt > sigAt, '找到方法的下边界');
    const body = app.slice(sigAt, nextAt);
    assert.ok(body.length > 500, `方法体长度合理（${body.length}）`);

    // 签名里声明的参数
    const params = ['host', 'config'];
    // 早先的缺陷：`await onDone()`
    assert.doesNotMatch(body, /\bonDone\b/,
        'renderServerList 没有 onDone 参数，不能引用它');
    // 重绘必须走本方法真实可用的入口
    assert.match(body, /await this\.renderModulesEditor\(\)/,
        '配对成功后走 renderModulesEditor 重绘（与编辑/删除同一入口）');
    // 参数确实都在用（反向：声明了却没用是另一种残留）
    for (const p of params) {
        assert.ok(body.includes(p), `参数 ${p} 有被使用`);
    }
});

test('指纹核对框里必须显示完整指纹，不能截断', () => {
    // 回归记录（浏览器实测发现）：确认框的文案写着「请逐字核对」，
    // 而勾选项只显示前 4 段加省略号，**完整指纹从未进入 DOM**——
    // 用户被要求执行一个界面上根本做不到的核对。实测：
    //   optLabel = "我已核对，指纹一致（AD:24:26:71…）"
    //   fullFingerprintInDOM = "未找到完整指纹"
    // 源码形状断言看不出这个：它只关心「有没有 fingerprint 字段」。
    const app = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
    const branch = app.slice(app.indexOf("res.status === 'need_trust'"),
        app.indexOf("res.status === 'need_trust'") + 2000);
    assert.ok(branch.length > 200, '切片拿到 need_trust 分支');

    // message 里必须插入完整的 res.fingerprint
    assert.match(branch, /message:[\s\S]*\$\{res\.fingerprint\}/,
        '完整指纹进 message（用户要逐字核对的就是它）');
    // 勾选项不再重复截断的前缀
    assert.doesNotMatch(branch, /split\('\:'\)\.slice\(0,\s*\d+\)/,
        '不要把指纹截断成前缀——那样界面上无法核对');
    // 文案要求「逐字核对」，就必须真的给得出完整串
    assert.match(branch, /逐字核对/, '文案仍要求逐字核对');
});

test('前端：http 地址在对话框里就被拒，并给出迁移步骤', () => {
    const app = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'));
    const validate = app.slice(app.indexOf('async showServerDialog(server, onDone)'));
    // 用字面量而不是正则断言这条：/^http:\/\// 的斜杠转义在正则字面量里
    // 极易写错（写成 /\/^http:\\\/\\\// 直接是语法错误，整个文件加载失败），
    // 而这里要断言的事实就是「源码里就是这几个字符」。
    assert.ok(validate.includes('/^http:\\/\\//i.test(url)'), 'http 单独判');
    assert.ok(validate.includes('/^https:\\/\\//i.test(url)'), '只接受 https');
    // http 的拒绝必须带迁移步骤，否则用户以为是自己地址写错了
    assert.ok(validate.includes('--tls-cert'), '错误信息含迁移步骤');
});
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

test('每台服务器可单独控制是否在首页显示', () => {
    const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const appCode = stripComments(appSource);
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

    // 命令要覆盖完整流程：下载 → 试跑 → 自检 → 开机自启 → 防火墙
    const fn = appCode.slice(appCode.indexOf('showDeployDialog(server)'));
    for (const step of ['curl -fsSL', 'NAVSYLPH_TOKEN=', '/metrics', 'systemd', 'firewall']) {
        assert.ok(fn.includes(step), `部署命令包含「${step}」这一步`);
    }
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
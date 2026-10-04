const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

/**
 * 服务器监控的回归测试。
 *
 * 归属在这里而不是分散到别处：这是一条链的两端——agent/ 负责「目标机上读到什么」，
 * server.js 负责「服务端怎么拉、怎么存」，中间靠一份协议
 * （version 字段 + 那几个字段名）绑定。
 *
 * ⚠️ agent 现在是 **Go 静态二进制**（agent/main.go），不再是 Node 脚本。
 * 所以对 agent 的断言分两类：
 *   · 能真跑的（子命令、载荷形状、协议版本）—— 跑构建出来的本机二进制
 *   · 只能读源码的（TLS 闸门、x509 用法）—— Go 源码形状
 * install.sh 与 build-agent.sh 仍是 shell，按 shell 断言。
 *
 * 布局、缓存、推送载荷那部分与 agent 实现无关，留在本文件里——
 * 它们守的是「首页与模块平台」，换个 agent 不该影响它们。
 */

const ROOT = path.join(__dirname, '..');
const goSource = fs.readFileSync(path.join(ROOT, 'agent', 'main.go'), 'utf8');
const installSh = fs.readFileSync(path.join(ROOT, 'agent', 'install.sh'), 'utf8');
const agentReadme = fs.readFileSync(path.join(ROOT, 'agent', 'README.md'), 'utf8');
const buildSh = fs.readFileSync(path.join(ROOT, 'scripts', 'build-agent.sh'), 'utf8');
const monitorSource = fs.readFileSync(path.join(ROOT, 'lib', 'monitor.js'), 'utf8');
const moduleSource = fs.readFileSync(path.join(ROOT, 'public', 'modules', 'server-monitor.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const adminCss = fs.readFileSync(path.join(ROOT, 'public', 'admin.css'), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

/** 构建出来的本机二进制。没构建过就返回 null——调用方自己决定跳过还是失败。 */
function localAgentBinary() {
    const file = path.join(
        ROOT, 'agent', 'dist', `nav-agent-${process.platform}-${process.arch}`);
    return fs.existsSync(file) ? file : null;
}

/**
 * 取出一条路由的源码（从声明到下一个顶层 app.* 声明为止）。
 * ⚠️ 切片必须落在**代码**上，不能用注释行当锚点——
 * code 是 stripComments 之后的源码，注释行 indexOf 返回 -1，
 * 而 slice(start, -1) 会静默切出「从 -1 到末尾」的整段（本项目踩过两次）。
 */
function routeBody(marker, endMarker) {
    const code = stripComments(serverSource);
    const start = code.indexOf(marker);
    if (start < 0) return '';
    if (endMarker) {
        const end = code.indexOf(endMarker, start + 10);
        return end > start ? code.slice(start, end) : '';
    }
    const next = code.indexOf('\napp.', start + 10);
    return next > start ? code.slice(start, next) : code.slice(start);
}

/**
 * 取出 app.js 里某个方法的函数体。
 *
 * ⚠️ 切片以「下一个缩进 8 的方法定义」为界。用 `\n        }` 当边界时，
 * 函数体里任何一层缩进 8 的右花括号都会提前截断——加几行注释就切不全，
 * 而表现是「断言不成立」而不是「切错了」。
 *
 * ⚠️ 同样不能用固定字符窗口：实现里插入过「agent 版本提示」那几行，
 * 200 字符的窗口就切不全了。按方法边界切才与内容长度无关。
 *
 * ⚠️⚠️ 必须匹配**带参数的定义形态**，不能只匹配名字：
 * `indexOf('\n        isAgentOutdated')` 会先命中**调用处**
 * （`isAgentOutdated(s);` 在另一个方法体里，缩进也是 8），
 * 于是切出一段几百字符的无关代码，而里面当然找不到该方法的实现 ——
 * 断言会全部落空，且**没有任何一条会失败**。本项目已经在这个坑上栽过
 * 多次（局部变量名当锚点、同形字符串抢先匹配）。
 */
function methodBodyOf(code, name) {
    // 定义处：名字后面紧跟一个参数列表与 `{`
    const re = new RegExp(`\\n        (?:async )?${name}\\([a-zA-Z_$][\\w$, ]*\\) \\{`);
    const m = re.exec(code);
    if (!m) return '';
    const rest = code.slice(m.index + 1);
    const next = rest.search(/\n        (?:async )?[a-zA-Z_][\w$]*\(/);
    return next > 0 ? rest.slice(0, next) : rest;
}

/**
 * methodBodyOf 的自检。
 *
 * ⚠️ 这是**给它自己**的测试。
 *
 * 曾经的 bug：它只按名字匹配，而同名方法有「调用处」与「定义处」两份，
 * 于是可能切到调用处（`this.isAgentOutdated(s);` 在另一个方法体里），
 * 后果是**所有基于它的断言全部落空、且没有一条失败** ——
 * 一个什么都不检查的测试看起来和通过的测试一样绿。
 *
 * 所以下面断言的是**可观测**的性质：切出的片段以「名字 + 参数列表 +
 * 花括号」开头，并且**含方法体**而不是只有一行签名。
 */
test('切片辅助函数切到的是定义（含参数列表与花括号），不是裸调用', () => {
    const code = stripComments(appSource);
    for (const name of ['isAgentOutdated', 'renderServerStateBody',
        'renderServerStatusBits', 'showDeployDialog']) {
        const body = methodBodyOf(code, name);
        assert.ok(body.length > 200, `切出 ${name}（${body.length}）`);
        // ⚠️ 片段必须以**定义形态**开头：名字 + 参数列表 + 花括号。
        // 只按名字匹配会命中裸调用（`this.foo(s);` 后面没有 `{`），
        // 于是断言全部落空且没有一条失败 —— 一个什么都不检查的测试
        // 看起来和通过的测试一样绿。
        assert.match(body, new RegExp(`^\\s*(?:async )?${name}\\([a-zA-Z_$][\\w$, ]*\\) \\{`),
            `${name} 切到的是定义而非调用`);
    }
    // 而 app.js 里确实同时存在这三种形态，说明这条断言不是空转：
    // 定义带 `{`，调用不带。
    assert.match(code, /isAgentOutdated\(s\) \{/, '定义形态：带 {');
    assert.match(code, /this\.isAgentOutdated\(s\);/, '调用形态：不带 {');
});

/** 取出某个 @media 查询的正文（按括号配平，不靠正则）。 */
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

// ========== agent 二进制（能真跑的部分）==========

test('agent 二进制可执行，自报版本与协议一致', (t) => {
    const bin = localAgentBinary();
    if (!bin) {
        t.skip('未构建 agent 二进制（跑 scripts/build-agent.sh）');
        return;
    }
    const out = execFileSync(bin, ['version'], { encoding: 'utf8' });
    // ⚠️ 这里原先断言 /nav-agent v1\b/，那是**协议**版本被当成了整个版本号
    // （老格式把两者印在一起）。软件版本与协议版本拆开之后，
    // 这一行必须同时点到两个：软件版本由构建期注入，协议版本恒为 1。
    assert.match(out, /^nav-agent (dev|\d+(\.\d+)*)\s*（协议 v1，/,
        '自报软件版本与协议版本');
    assert.ok(out.includes(`${process.platform}/${process.arch}`), '自报平台');
});

test('agent collect 的字段与后端校验逐字一致', (t) => {
    const bin = localAgentBinary();
    if (!bin) {
        t.skip('未构建 agent 二进制');
        return;
    }
    const payload = JSON.parse(execFileSync(bin, ['collect'], { encoding: 'utf8' }));

    // 后端 normalizePushedMetrics 的必填项。少一个或类型不对，
    // 整条载荷会被拒——而表现是「这台机器离线」而不是明确的格式错误。
    for (const k of ['memoryPercent', 'memoryTotal', 'cores', 'sampledAt']) {
        assert.equal(typeof payload[k], 'number', `${k} 是数字`);
    }
    for (const k of ['hostname', 'platform']) {
        assert.equal(typeof payload[k], 'string', `${k} 是字符串`);
    }
    // cpu 允许 null（拿不到累计时间时），但不能是别的类型。
    // ⚠️ 它不能是 0 —— 0% 是一个「看起来正常」的假结论，而缺失是诚实的。
    assert.ok(payload.cpu === null || typeof payload.cpu === 'number',
        'cpu 是数字或 null');
    // 字段集合必须与服务端期望的**逐字一致**。多一个少一个都会被静默忽略，
    // 而界面上看不出少了东西。
    //
    // ⚠️ diskUsed/diskTotal 是本轮新增的（首页第三条指标改成存储占用）。
    // 这条断言就是为这类变更准备的：它确实转红了，因为新字段没登记进来
    // ——一个「加了字段但忘了同步契约」的守卫，能被自己抓到。
    assert.deepEqual(Object.keys(payload), [
        'version', 'cpu', 'memoryUsed', 'memoryTotal', 'memoryPercent',
        'diskUsed', 'diskTotal',
        'load1', 'load5', 'uptime', 'cores', 'hostname', 'platform', 'sampledAt'
    ], '字段名与顺序与后端期望一致');

    // 磁盘字段要是数字（0 表示「没报出来」，不是缺失）
    for (const k of ['diskUsed', 'diskTotal']) {
        assert.equal(typeof payload[k], 'number', `${k} 是数字`);
    }
});

test('agent 的协议版本与服务端对得上', (t) => {
    const bin = localAgentBinary();
    if (!bin) {
        t.skip('未构建 agent 二进制');
        return;
    }
    const payload = JSON.parse(execFileSync(bin, ['collect'], { encoding: 'utf8' }));
    const { AGENT_PROTOCOL_VERSION } = require(path.join(ROOT, 'lib', 'monitor'));
    // 不一致时服务端会明确报错，而不是把不认识的字段当 0 读进去
    //（那样会显示「CPU 0%」这种错误结论）
    assert.equal(payload.version, AGENT_PROTOCOL_VERSION, '与服务端一致');
});

test('agent health 在未注册时点名缺什么，而不是笼统失败', (t) => {
    const bin = localAgentBinary();
    if (!bin) {
        t.skip('未构建 agent 二进制');
        return;
    }
    const r = spawnSync(bin, ['health'], { encoding: 'utf8' });
    // 「为什么连不上」要拆得开：配置错、证书读不到、端口不通、token 不对，
    // 处置完全不同。笼统的「失败」等于把排查工作推回给用户。
    assert.notEqual(r.status, 0, '未注册时退出码非零');
    assert.match(r.stdout + r.stderr, /config\.json|注册/,
        '指名配置文件或注册步骤');
});

test('agent 的 help 列出的子命令都真实存在，未知命令被拒绝', (t) => {
    const bin = localAgentBinary();
    if (!bin) {
        t.skip('未构建 agent 二进制');
        return;
    }
    const out = execFileSync(bin, ['help'], { encoding: 'utf8' });
    for (const sub of ['enroll', 'serve', 'push', 'collect', 'health']) {
        assert.ok(out.includes(sub), `help 提到 ${sub}`);
    }
    // 未知子命令必须拒绝，而不是当成默认动作跑起来
    const bad = spawnSync(bin, ['no-such-command'], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0, '未知子命令非零退出');
    assert.match(bad.stderr, /未知子命令/, '说清原因');
});

test('agent 是零依赖：go.mod 没有第三方 require', () => {
    // 「零运行时依赖」是选 Go 的唯一理由。引了第三方库要么得 vendor、
    // 要么得联网拉，而 agent 的意义就是拷过去就能跑。
    const mod = fs.readFileSync(path.join(ROOT, 'agent', 'go.mod'), 'utf8');
    const requires = mod.split('\n').filter(l => l.trim().startsWith('require'));
    assert.equal(requires.length, 0, `不该有 require，实际：${requires.join(' / ')}`);
});

test('拉取模式缺 TLS 证书时拒绝启动，不监听明文', () => {
    // 改之前的形状：agent 永远 http.ListenAndServe，token 明文过网。
    // token 是那台机器唯一的鉴权凭据，拿到就能读它的 CPU、内存与主机名。
    const code = stripComments(goSource);
    // ⚠️ 这里有两个 `if certFile == "" || keyFile == ""`：
    //   第一个（661 行）是「没给就去配置里补默认值」，
    //   第二个（682 行）才是「补完仍然没有 → 拒绝启动」。
    // 早先的断言用 `[\s\S]{0,1500}` 从第一个往后找 return，等于把第二个
    // 当成第一个的证据——于是把第一个的条件改坏（变异）时测试照样绿。
    // 现在锚定**拒绝那一处**：从 return 往回找最近的闸门。
    const rejectAt = code.indexOf('return errors.New("缺少 TLS 证书")');
    assert.ok(rejectAt > 0, '有「缺少 TLS 证书」的拒绝分支');
    const gateAt = code.lastIndexOf('if certFile == "" || keyFile == ""', rejectAt);
    assert.ok(gateAt > 0, '拒绝分支之前有证书闸门');
    // 闸门与 return 之间不得夹着别的 if —— 那样它就不是「这个闸门在守」
    const between = code.slice(gateAt, rejectAt);
    assert.doesNotMatch(between, /\n\tif /,
        '闸门与拒绝之间不该有另一个条件分支（否则守的不是这条路径）');
    // 逃生门必须是显式的，不能成为默认
    assert.match(code, /insecure := args\.has\("insecure-http"\)/,
        '逃生门由「显式给了 --insecure-http」才开启');
    // 且不得用 str 取——那会让缺省值把逃生门打开
    assert.doesNotMatch(code, /insecure := args\.str\(/, '逃生门不得有缺省开启的路径');
    assert.ok(goSource.includes('--insecure-http'), '逃生门在参数解析里');
});

test('agent 用 x509 原生签发证书，不调 openssl', () => {
    // 这是选 Go 的主要原因之一：Node 内置 crypto 只有 X509Certificate
    //（只能解析、不能签发），上一版被迫 execFileSync('openssl', …)。
    const code = stripComments(goSource);
    assert.match(code, /x509\.CreateCertificate\(/, '用 x509 签发');
    assert.match(code, /func selfSign\(/, '有自签函数');
    // ⚠️ 不得再有 openssl 调用——那个依赖本轮就该消失
    // ⚠️ 必须先 stripComments：文件头与 usage 里都解释了「为什么不用 openssl」，
    // 那些说明提到它是对的；对原文断言等于让注释里的词把断言撑成恒绿。
    // ⚠️ usage 文本里会写「不需要 openssl」——那是给人看的说明，不是调用。
    // 真正要禁的是把它当子进程执行，那正是上一版的妥协。
    assert.doesNotMatch(code, /exec(File)?Sync\(\s*'openssl/, '不把 openssl 当子进程调用');
    assert.doesNotMatch(code, /exec\.Command\(\s*'openssl/, '也不经 exec.Command 调 openssl');
    assert.match(code, /Chmod\(keyPath, 0o600\)/, '显式再 chmod 一次');
});

test('SAN 里必须有 IP：现代 TLS 校验先看 SAN，CN 只是回退', () => {
    // 缺了它，用 IP 连目标机会直接握手失败——而用户填的恰恰就是 IP。
    const code = stripComments(goSource);
    assert.match(code, /tmpl\.IPAddresses = \[\]net\.IP\{ip\}/, 'IP 形式的 SAN');
    assert.match(code, /ParseIP\("127\.0\.0\.1"\)/, '含 127.0.0.1');
});

test('两条采集路径返回同一种形状，且拿不到时诚实降级', () => {
    // /proc/stat 返回一个聚合对象而无 /proc 的回落路径若返回别的东西，
    // collect() 里「一个形状减另一个形状」= NaN，totalDelta > 0 不成立，
    // cpu 恒为 null——而返回的 JSON 完全合法，看不出出错，只是一直没有 CPU。
    //
    // 现在的约定：两个平台的回落都返回 (cpuTimes, bool)，
    // **拿不到就返回 false**，让 CPU 留成 null，而不是造一个假值。
    for (const f of ['readcpu_darwin.go', 'readcpu_other.go']) {
        const src = stripComments(fs.readFileSync(path.join(ROOT, 'agent', f), 'utf8'));
        assert.match(src, /func osCpuTotal\(\) \(cpuTimes, bool\)/,
            `${f} 的回落返回 (cpuTimes, bool)`);
    }
    const main = stripComments(goSource);
    assert.match(main, /cur, ok := readCpuTotal\(\)/, '调用点接住 ok');
    assert.match(main, /if ok \{[\s\S]{0,300}?previousCpu = cur/,
        '只有拿到数据才更新基准值');
    // ⚠️ CPU 读不到**不是致命错误**：其它指标还能报，
    // 让整个采集失败会把一台完全正常的机器显示成「离线」
    assert.doesNotMatch(main, /if !ok \{[\s\S]{0,80}?return nil, errors\.New\("读不到 CPU/,
        'CPU 读不到时不得让整个采集失败');
});

test('macOS 内存走 vm_stat，且解析的是词组标签', () => {
    // 「总内存 − 空闲」在 macOS 上衡量的是「缓存占用」而不是「应用占用」——
    // 实测 16GB 机器上显示成「内存 99%」，看着像要爆，实际完全正常。
    // 这条最容易回归：它在所有平台都能跑，只是 macOS 上语义不对。
    const code = stripComments(goSource);
    assert.match(code, /func readDarwinMemory\(\)/, '有独立的 macOS 内存读取');
    assert.match(code, /vm_stat/, '读 vm_stat');
    assert.match(code, /Pages inactive/, '把 inactive（可回收缓存）计入可用');
    assert.match(code, /Pages speculative/, '把 speculative 计入可用');
    // ⚠️ 标签是**词组**（"Pages free:"），所以 Fields[1] 是 "free:" 而非数字。
    // 按下标取第一段会 ParseFloat("free:") 失败、返回 0，
    // 于是「可用内存 = 0」显示成「内存 100%」（实测踩过）。
    assert.match(code, /fields\[len\(fields\)-1\]/,
        '取最后一段作为数字，而不是按下标取 Fields[1]');
    // 非 darwin 分支走 /proc/meminfo 的 MemAvailable
    assert.match(code, /MemAvailable/, 'Linux 分支用 MemAvailable');
});

test('token 比较用定长比较，不泄露前缀', () => {
    const code = stripComments(goSource);
    assert.match(code, /subtle\.ConstantTimeCompare\(/, '定长比较');
    assert.match(code, /"Bearer "/, 'Bearer 前缀');
});

test('systemd 的子命令与凭据按模式分支，push 不再装错', () => {
    // 回归记录（本轮代码审查发现）：ExecStart 写死 `serve`，而 push 模式
    // 不写 Bearer token —— 于是 agent 启动即退出，脚本却只 warn 一句、
    // 返回 0，用户在后台看到「已就绪」，实际那台机器上没有任何进程。
    // **静默失败比崩溃更坏**：崩了用户会来问，装上了用户不会。
    //
    // 这里逐条钉住 push 与 pull 各自的形状。
    assert.match(installSh, /if \[ "\$MODE" = "push" \]; then\s*\n\s*SUBCMD="push"/,
        'push 模式用 push 子命令');
    assert.match(installSh, /SUBCMD="serve"/, '其余（pull）用 serve');
    assert.match(installSh, /ExecStart=\$BIN_PATH \$SUBCMD/,
        'ExecStart 用按模式算出的子命令，而不是写死 serve');
    assert.doesNotMatch(installSh, /ExecStart=\$BIN_PATH serve\b/,
        '不得再写死 serve');

    // 凭据也要分支：push 用推送凭据 + server id，没有 Bearer token
    assert.match(installSh, /NAV_AGENT_PUSH_SECRET=/, 'push 写推送凭据');
    assert.match(installSh, /NAV_AGENT_SERVER_ID=/, 'push 写目标机 id');
    assert.match(installSh, /NAV_AGENT_TOKEN=/, 'pull 写 Bearer token');
});

test('启动失败必须让脚本非零退出，不能静默成功', () => {
    // 只看 `systemctl restart` 的返回值会漏掉「启动即退出」——
    // systemd 对那种情况照样返回 0。所以要 sleep 后再 is-active。
    assert.match(installSh, /systemctl is-active --quiet nav-agent/,
        'restart 之后还要确认进程真的活着');
    // 而失败分支必须 die（退出非零），不能只 warn
    //
    // ⚠️ 锚点不能是 `systemctl is-active` 这个子串：新增的「先停旧 agent」
    // 那一段里也有 `systemctl is-active --quiet nav-agent`（判断是否在跑），
    // 而它出现在这段之前——`indexOf` 会抢到那处，于是切出来的 800 字符
    // 里根本没有失败分支，断言报的是「启动即退出时报错并退出」不成立，
    // 而真实原因（锚点指错了地方）完全不在信息里。
    // 用 `systemctl restart` 作锚点：它只出现在「装完 systemd 之后启动」那一步。
    const failBranch = installSh.slice(installSh.indexOf('if systemctl restart nav-agent'));
    assert.ok(failBranch.length > 400,
        `切出启动后的分支（${failBranch.length}）`);
    assert.match(failBranch.slice(0, 800), /systemctl is-active --quiet nav-agent/,
        'restart 之后确实用 is-active 复验（锚点没指错）');
    assert.match(failBranch.slice(0, 800), /die "agent 启动后立刻退出/,
        '启动即退出时报错并退出');
    assert.doesNotMatch(failBranch.slice(0, 800), /warn "systemd 启动失败/,
        '不得只 warn —— 那正是这个 bug 藏了这么久的原因');

    // 无 systemd / 跳过 systemd 的提示也要按模式给对应命令
    assert.match(installSh, /请手动运行：\$BIN_PATH push --server/,
        '无 systemd 时 push 给 push 命令');
    assert.match(installSh, /请手动运行：\$BIN_PATH serve --host/,
        '无 systemd 时 pull 给 serve 命令');
});

test('后台卡片有「在线」与「部署就绪」两个独立状态位', () => {
    // 用户原话是「方块上除了在线状态，还要有 agent 部署状态」——
    // 两个正交维度。实现曾把它们拼成一句话（「在线 · 未部署」），
    // 而后台是操作台：扫过一列卡片时要能分出「哪几台连不上」（查网络）
    // 与「哪几台没装」（去部署），两类待办的处置完全不同。
    //
    // 首页仍只保留合并后的那一个（用户拍板：首页一个就够）。
const code = stripComments(appSource);
    // ⚠️ 切片以「下一个缩进 8 的方法定义」为界。用 \n        } 当边界时，
    // 函数体里任何一层缩进 8 的右花括号都会提前截断——加了注释就切不全，
    // 而表现是「第一条断言无故失败」而不是「切错了」。
    const methodBody = (name) => {
        const body = methodBodyOf(code, name);
        assert.ok(body, `找到 ${name}`);
        return body;
    };
    const render = methodBody('renderServerStatusBits');
    assert.ok(render.length > 100, `切出 renderServerStatusBits（${render.length}）`);
    // 两个 span，一个给 online 一个给 deploy
    assert.match(render, /serverOnlineState\(s, p\)/, '在线位独立判断');
    assert.match(render, /serverDeployBit\(s, p\)/, '部署位独立判断');
    assert.match(render, /class="server-item-status" data-kind="\$\{online\.kind\}"/,
        '渲染出在线状态位');
    assert.match(render, /class="server-item-status" data-kind="\$\{deploy\.kind\}"/,
        '渲染出部署状态位');

    // 「在线」这一位必须用 probe 的 reachable —— 服务端早就算好并返回了，
    // 前端此前从不读它（server.js 的注释明写这两个是不同问题、不能混用）
    const online = methodBody('serverOnlineState');
    assert.ok(online.length > 80, '切出 serverOnlineState');
    assert.match(online, /'reachable' in probe/,
        '优先用探测返回的 reachable，而不是自己推断');
    // 推送模式报 null（无端口可探），不能谎称在线或离线
    assert.match(online, /probe\.reachable === null/,
        '推送模式如实显示「在线未知」');

    // 没探测过时说「未检测」，不能猜成「离线」
    assert.match(online, /未检测/, '未探测时说「未检测」');

    // ⚠️ 探测结果必须有落点，否则「在线」位永远显示「未检测」。
    // 回归记录（浏览器实测发现）：renderServerStatusBits 调用时不传 probe，
    // 而 reachable 只存在于 /probe 的响应里、不在配置里 —— 于是两个位
    // 里的第一个恒为「未检测」，等于白做。
    assert.match(render, /probe \|\| this\.lastProbe\?\.\[s\.id\]/,
        '渲染时退回读缓存的探测结果');
    // 探测与轮询都要写缓存
    const probeCalls = code.match(/this\.lastProbe\[(id|s\.id)\] = res;/g) || [];
    assert.ok(probeCalls.length >= 2,
        `探测与轮询都写缓存（实际 ${probeCalls.length} 处）`);

    // 三个部署状态各有措辞与配色
    const bit = methodBody('serverDeployBit');
    assert.ok(bit.length > 100, '切出 serverDeployBit');
    for (const [state, text, kind] of [
        ['ready', '已就绪', 'ready'],
        ['pending', '等待部署', 'pending'],
        ['not_deployed', '未部署', 'not_deployed'],
        ['cert_mismatch', '证书异常', 'alert'],
        ['port_conflict', '端口被占', 'alert']
    ]) {
        assert.match(bit, new RegExp(`case '${state}':[\\s\\S]{0,120}?kind: '${kind}'`),
            `${state} → ${kind}`);
    }
    // 措辞只有一处：说明区与 toast 都取自它，否则两边说法会漂移
    //
    // ⚠️ 不要用固定字符窗口：实现里插入过「agent 版本提示」那几行，
    // 200 字符的窗口就切不全了，而表现是「断言不成立」而不是「切错了」。
    // 这里改成在同一方法体内逐个断言，不依赖顺序距离。
    const body = methodBodyOf(code, 'renderServerStateBody');
    assert.ok(body.length > 200, `切出 renderServerStateBody（${body.length}）`);
    assert.match(body, /const bit = this\.serverDeployBit\(s\);/,
        '说明区复用 serverDeployBit 的措辞');
    assert.match(body, /class="server-item-state"/,
        '确实渲染成那块说明区');
    assert.doesNotMatch(code, /serverStateLabel|serverStateKind/,
        '旧的两套状态文案已删除（零消费者，留着必然漂移）');
});

test('hasEnrollToken 有真实消费者：决定「复制命令」还是「部署」', () => {
    // 该字段此前服务端算了、前端零引用，而它的注释声称「界面据此决定
    // 显示复制命令还是重新生成令牌」——一个假承诺（那两个按钮不存在）。
    // 用户拍板「有用就留着」，所以接上：它正是「令牌还能直接用」的判据。
    assert.match(serverSource, /hasEnrollToken: Boolean\(enrollTokenHash\) && enrollTokenExpiresAt > Date\.now\(\)/,
        '服务端算出它且已考虑过期');
    const code = stripComments(appSource);
    const fn = /renderDeployAction\(s\) \{[\s\S]*?\n        \}/.exec(code);
    assert.ok(fn, '找到 renderDeployAction');
    assert.match(fn[0], /if \(s\.hasEnrollToken\)/, '按它分两支');
    assert.match(fn[0], /复制命令/, '令牌有效 → 直接给可复制的命令');
    assert.match(fn[0], /部署/, '否则给「部署」（点开面板会重新签一枚）');
    // 卡片必须真的调用它，否则又是一个有定义无调用的死函数
    assert.match(code, /\$\{this\.renderDeployAction\(s\)\}/,
        '卡片渲染时调用');
});

test('install.sh 只支持 Linux，且在 macOS 上给出可执行的替代路径', () => {
    // 发布包里是 Linux 的静态二进制。没有这道检查时，在 macOS 上跑
    // install.sh 会一路通过所有检查，然后下载一个跑不起来的 Linux ELF、
    // 写 systemd、systemctl 失败 —— 用户看到一连串莫名错误，
    // 而根因（平台不对）在第一秒就该说。
    assert.match(installSh, /case "\$\(uname -s\)" in\s*\n\s*Linux\) ;;/,
        '按 uname -s 拦下非 Linux');
    assert.ok(installSh.includes('只支持 Linux'),
        '说清为什么装不了');
    // 给出替代路径而不是只说「不支持」——本项目自己在 macOS 上开发，
    // 开发者需要知道该怎么做
    assert.ok(installSh.includes('build-agent.sh'),
        '给出本机自测的替代命令');

    // ⚠️ 平台检查必须**早于** root 检查：在 macOS 上用户首先该知道的是
    // 「装不了」，而不是「请用 sudo」——后者会让人以为加上 sudo 就能装。
    const platformAt = installSh.indexOf('uname -s');
    const rootAt = installSh.indexOf('id -u');
    assert.ok(platformAt > 0 && rootAt > 0, '两处检查都可定位');
    assert.ok(platformAt < rootAt,
        '平台检查在 root 检查之前（macOS 上不该先让人加 sudo）');
});

test('install.sh 按架构下载对应二进制，且 404 不会静默写下去', () => {
    // 架构探测错了，用户拿到的是跑不了的二进制，而错误在目标机上、看不到后台。
    assert.match(installSh, /x86_64\|amd64\)\s+echo "amd64"/, 'x86_64 映射');
    assert.match(installSh, /aarch64\|arm64\)\s+echo "arm64"/, 'aarch64 映射');
    assert.match(installSh, /armv7l\|armv7\|armhf\)\s+echo "armv7"/, 'armv7 映射');
    assert.match(installSh, /nav-agent-linux-\$\{ARCH\}/, 'URL 含架构');
    // ⚠️ curl 必须带 -f：少了它 404 的 HTML 会被当二进制写下去，
    // 用户看到的错误是「不是可执行文件」而不是「404」
    assert.match(installSh, /curl -fsSL/, 'curl 带 -f');
    assert.match(installSh, /install -m 0755/, '装到 /usr/local/bin');
});

test('install.sh 凭据写 env 文件而不是 systemd unit', () => {
    // unit 会被 systemctl cat / show / status 打印出来，也常被用户贴进 issue。
    assert.match(installSh, /EnvironmentFile=-\/etc\/nav-agent\/env/, 'unit 用 EnvironmentFile');
    assert.match(installSh, /ENVFILE=\/etc\/nav-agent\/env/, 'env 路径固定');
    assert.match(installSh, /chmod 600 "\$ENVFILE"/, 'env 权限 0600');
    // ⚠️ 凭据不得出现在 unit 正文里
    const unitBlock = /cat > "\$UNIT" <<EOF[\s\S]*?\nEOF/.exec(installSh);
    assert.ok(unitBlock, '找到写 unit 的那段');
    assert.doesNotMatch(unitBlock[0], /TOKEN=/, 'unit 正文里不出现 token');
    // 缺 systemd 时降级而不是崩（容器、精简系统里没有）
    assert.match(installSh, /command -v systemctl/, '检查 systemd 是否存在');
});

test('install.sh 没有需要用户自己填的占位符', () => {
    // 改之前是 6 步手工复制 + `<你的 token>` 占位符，用户得先去别处取 token。
    // 一键部署的判据：命令复制过去就能跑。
    assert.doesNotMatch(installSh, /<你的 token>|<TOKEN>|TOKEN_PLACEHOLDER/,
        '没有占位符');
    assert.match(installSh, /--enroll/, '令牌由参数传入');
});

test('构建脚本覆盖三个架构，armv7 用的是正确的 GOARCH/GOARM 组合', () => {
    // armv7 覆盖老树莓派与部分路由器——「轻量到能在 NAS 上跑」是本项目的初衷。
    // ⚠️ 而 armv7 的正确写法是 GOARCH=arm + GOARM=7：
    // **没有** GOARCH=armv7 这个值，写了会报 unsupported GOOS/GOARCH pair（实测踩过）。
    assert.match(buildSh, /LINUX_ARCHES=\(amd64 arm64 armv7\)/, '三个架构');
    assert.match(buildSh, /build linux arm "nav-agent-linux-armv7" 7/,
        'armv7 用 GOARCH=arm + GOARM=7');
    assert.match(buildSh, /CGO_ENABLED=0/, '静态链接，否则「拷过去就能跑」不成立');
    assert.match(buildSh, /grep -q "ELF"/, '自检产物是 ELF');
});

test('agent 二进制不进 git，但发布时会构建并校验', () => {
    // 三个架构加起来十几 MB，且是构建产物
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.match(ignore, /^dist\//m, 'dist/ 被 gitignore');
    const release = fs.readFileSync(path.join(ROOT, 'scripts', 'release.sh'), 'utf8');
    assert.match(release, /build-agent\.sh/, '发布时调构建脚本');
    // ⚠️ 构建失败必须让发布失败，而不是打个没有 agent 的包——
    // 那时用户照着命令执行，拿到的错误在目标机上、看不到后台
    assert.match(release, /agent 二进制缺失/, '发布前确认产物存在');
});

// ========== TCP 三态探测（核心）==========

test('探测区分 refused 与 timeout——这是「在线但未部署」得以成立的前提', () => {
    // 改之前只有「在线 / 离线」两个结果，而用户真正要回答的是三个不同的
    // 问题：主机在吗、agent 装了吗、能不能读到指标。三者塌缩成一个
    // 「离线」时，用户无法判断该点部署、该查网络、还是该重装。
    //
    // TCP 层面这两个是**确定可分**的：ECONNREFUSED 说明主机回了 RST，
    // 它活着，只是没人监听；超时才是路不通。实测可行，无需 root、无需依赖。
    const code = stripComments(monitorSource);

    // refused 必须由 ECONNREFUSED 触发，且紧挨着它（不能隔着别的分支）
    const refusedAt = code.indexOf("done('refused'");
    assert.ok(refusedAt > 0, 'refused 是一等状态而不是被合并掉的');
    const before = code.slice(Math.max(0, refusedAt - 260), refusedAt);
    assert.match(before, /ECONNREFUSED/,
        'refused 由 ECONNREFUSED 触发（主机回了 RST，说明它活着）');

    // 三态齐全，且 refused 不得被写成 timeout 的别名
    assert.ok(code.includes("'open'"), 'open：有服务在监听');
    assert.ok(code.includes("'refused'"), 'refused：主机在线但没人监听');
    assert.ok(code.includes("'timeout'"), 'timeout：路不通');
    // 描述文字也要分开——用户看到的是这句话
    const refusedDesc = /done\('refused',\s*'([^']*)'/.exec(code)?.[1] || '';
    const timeoutDesc = /done\('timeout',\s*'([^']*)'/.exec(code)?.[1] || '';
    assert.ok(refusedDesc, 'refused 有自己的描述文案');
    assert.ok(timeoutDesc, 'timeout 有自己的描述文案');
    assert.notEqual(refusedDesc, timeoutDesc,
        '两者的描述文案不得相同——那句话是用户看到的唯一区分');
    // ⚠️ refused 的文案必须点出「主机在线」，否则用户仍会以为机器挂了
    assert.match(refusedDesc, /在线/, 'refused 的文案要点明主机在线');
});

test('探测轮询比的是「本次 vs 上次」，不是「本次 vs 陈旧快照」', () => {
    // 回归记录（本轮代码审查发现，浏览器实测可复现）：早先写的是
    //   if (res.deployState && res.deployState !== s.deployState) changed = true;
    // 而 s 来自 schedulePendingProbe 启动时捕获的 config.servers —— 那个快照
    // 每一轮读的都是同一个值。于是只要结果非空就恒真，**每 60 秒必弹一次
    // 「有机器的状态变了」，哪怕什么都没变**。
    //
    // 同一个陈旧快照还导致第二个 bug：pending 列表只在启动时 filter 一次，
    // 已注册的机器永远进不了下一轮 —— 刚部署完的那台要等用户重开面板
    // 才被重新筛。
    const code = stripComments(appSource);
    const fn = /schedulePendingProbe\(config\) \{[\s\S]*?\n        \}/.exec(code);
    assert.ok(fn, '找到 schedulePendingProbe');
    const body = fn[0];

    assert.match(body, /const lastSeen = new Map\(\)/,
        '用可变 Map 记录上次状态，而不是闭包里的陈旧快照');
    assert.match(body, /lastSeen\.set\(s\.id, s\.deployState \|\| null\)/,
        '启动时记下每台的初始状态');
    assert.match(body, /const before = lastSeen\.get\(s\.id\)/,
        '比对的是 Map 里的「上次」');
    assert.match(body, /if \(now !== before\)/,
        '只有真的变了才标 changed');
    // ⚠️ 变异验证：改回比 s.deployState（陈旧快照）必须让本条红
    assert.doesNotMatch(body, /res\.deployState !== s\.deployState/,
        '不得与闭包里的陈旧快照比对');
    // 「变了吗」必须同时更新 Map，否则下一轮的 before 仍是同一个旧值
    assert.match(body, /lastSeen\.set\(s\.id, now\)/,
        '判定为变化时同步更新 Map');
    // pending 列表靠重绘重建 —— 这是刚部署完那台能「毕业」的唯一路径
    assert.match(body, /await this\.renderModulesEditor\(\)/,
        '状态变化后重绘 → 重建 pending 列表');
    // 只探未就绪的，且面板一关就停（零额外服务端状态）
    assert.match(body, /if \(s\.mode === 'push'\) return false;/,
        'push 模式无端口可探，跳过');
    assert.match(body, /return !s\.enrolled;/, '已注册的跳过');
    assert.match(body, /this\.clearPendingProbe\(\);/, '面板关掉即停');
    assert.match(code, /closeAdmin[\s\S]{0,1500}?this\.clearPendingProbe\(\)/,
        'closeAdmin 里清理定时器（否则它跑到页面卸载）');
    // ⚠️ 窗口给足：body 里 setInterval 与 60000 之间隔着整个回调体
    // （含注释与 pending 循环），200 字符切不到底 —— 而窗口太窄又正是
    // 本项目反复踩的坑（切出半个函数，断言恒绿）。
    assert.match(body, /setInterval\([\s\S]*?60000/, '每 60 秒一次');
});

test('未注册且证书是自签时如实报告，而不是抛异常杀掉进程', async (t) => {
    // 回归记录（本轮代码审查发现，实测可复现）：fetchPeerCert 在 TOFU 流程
    // 被删除时漏改了这个调用点，于是「agent 在跑但注册没成功」
    // （pending 态、certPem 为空、证书是自签）会走到那一行并抛
    // ReferenceError —— 它不在任何 try 包装里，**直接杀掉整个进程**，
    // 首页所有机器一起消失，而 /api/modules/metrics 返回 500。
    //
    // 所以这条**真起一个自签 HTTPS 服务**，而不是断言源码形状：
    // 形状断言看不见「这个标识符根本不存在」。
    const https = require('https');
    const os = require('os');
    const path = require('path');

    // 复用 agent 构建出来的本机二进制的自签证书做不成（那是 pem 原文，
    // 缺私钥），所以现生成一对。x509 签发在测试里不方便，用 openssl。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-tls-'));
    const certFile = path.join(tmp, 'cert.pem');
    const keyFile = path.join(tmp, 'key.pem');
    const { execFileSync } = require('child_process');
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', keyFile, '-out', certFile, '-days', '1',
            '-subj', '/CN=test', '-addext', 'subjectAltName=IP:127.0.0.1',
        ], { stdio: 'ignore' });
    } catch {
        t.skip('本机没有 openssl，生成不了自签证书');
        return;
    }

    const server = https.createServer({
        cert: fs.readFileSync(certFile),
        key: fs.readFileSync(keyFile)
    }, (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: 1, cpu: 0.1, memoryPercent: 0.5 }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const { fetchRemoteMetrics } = require(path.join(ROOT, 'lib', 'monitor'));

        // 场景 A：未注册（certPem 空）——修复前这里抛 ReferenceError
        const a = await fetchRemoteMetrics({
            url: `https://127.0.0.1:${port}`, token: 'x', certPem: undefined
        });
        assert.equal(a.ok, false, '未配对时拉不到指标');
        assert.notEqual(a.ok, undefined, '返回的是结果而不是异常');
        assert.equal(a.notEnrolled, true,
            '如实报告「这台机器还没注册」，而不是伪造一个指纹');
        // ⚠️ 关键：那个标识符必须已经不存在了，否则这条会重新崩
        const monitor = require(path.join(ROOT, 'lib', 'monitor'));
        assert.equal(monitor.fetchPeerCert, undefined,
            'fetchPeerCert 已删除；残留调用点就是本条要防的那个 bug');

        // 场景 B：配对过且证书匹配 → 应该成功（ca 传对了）
        const b = await fetchRemoteMetrics({
            url: `https://127.0.0.1:${port}`, token: 'x',
            certPem: fs.readFileSync(certFile, 'utf8')
        });
        assert.equal(b.ok, true, '传对了证书就应拉得到指标');
        assert.equal(b.metrics.memoryPercent, 0.5);
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
test('探测结论写回配置，不靠每次渲染重新推断', () => {
    // 回归记录（浏览器实测）：保存一台机器后自动探测，界面 toast 说「正在检测」，
    // 但 deployState 在 .modules.json 里仍是 undefined——卡片于是显示「未检测」，
    // 用户点完检测看到的还是「未检测」。
    //
    // 根因：probe 端点只 res.json 返回状态，从不落盘。而 deployState 恰恰
    // 是「这个 agent 装好没有」的答案，不该每帧重新猜。
    const probe = routeBody("app.post('/api/modules/servers/:id/probe'");
    assert.ok(probe.length > 1500, '拿到 probe 路由');

    // 落盘辅助：只在真的变了时写（否则 mtime 一直跳，
    // 而这个文件在备份与版本管理里是被当配置看的）
    assert.match(probe, /if \(server\.deployState === state\) return;/,
        '状态没变时不写盘');
    assert.match(probe, /deployState: state, stateProbedAt: Date\.now\(\)/,
        '落盘 deployState 与探测时间');
    assert.match(probe, /async function persistState|const persistState = async/,
        '有专门的落盘函数');
    // 写盘失败不该让探测失败——结论已经在响应里了
    assert.match(probe, /写回部署状态失败/,
        '写盘失败被捕获并记日志');

    // ⚠️ 每条分支都要走 reply（既回响应又落盘）。
    // 逐条断言 reply 的调用数 ≥ 分支数，否则漏掉一条分支就静默不落盘了——
    // 而漏掉的那条正是用户最关心的「未部署」。
    const replies = (probe.match(/reply\(\{/g) || []).length;
    assert.ok(replies >= 6,
        `每条分支都经 reply 落盘，实际 ${replies} 处`);
    assert.doesNotMatch(probe, /res\.json\(\{[\s\S]{0,80}?deployState/,
        '不得有绕过 reply 直接 res.json 的分支（那类不会落盘）');
});

test('open 只说明「有人应答 TCP」，必须再确认是 agent', () => {
    // 回归记录（端到端实测，本机办公网/VPN 环境）：连接一个完全不可达的
    // 公网地址（198.51.100.1:4195，同地址 curl 报 HTTP 000）时，
    // net.Socket 仍然触发 'connect' —— 中间有透明代理接管了 TCP，
    // 而且它**保持连接**，不会握手后立刻断开。
    //
    // 所以「connect 就当 agent 在跑」会把一台根本够不着的机器报成
    // 「未部署」，用户点部署后依然失败。
    //
    // 试过「connect 后等 250ms 看对端关不关」，**实测无效**（代理保持连接），
    // 只让每次探测多花 250ms，已删。
    //
    // 真正挡住它的是第二道防线：TCP 连上之后必须去问「你自报家门是不是 agent」。
    const probe = routeBody("app.post('/api/modules/servers/:id/probe'");
    assert.ok(probe.length > 1200, '拿到 probe 路由');

    // 顺序：先 probeTcp，再 probeAgentHealth，最后才拉指标。
    // 少了第二步就会把「代理应答」误报成「agent 在跑」。
    const tcpAt = probe.indexOf('await probeTcp(');
    const healthAt = probe.indexOf('await probeAgentHealth(');
    const metricsAt = probe.indexOf('await fetchRemoteMetrics(');
    assert.ok(tcpAt > 0, '先做 TCP 探测');
    assert.ok(healthAt > tcpAt, 'TCP 通之后再确认那确实是 agent');
    assert.ok(metricsAt > healthAt, '确认是 agent 之后才拉指标');

    // ⚠️ 断言范围要卡准：refused 分支**本来就应该**在 health 检查之前早退
    // （没人应答 TCP 时问 /health 只会白等一个超时），而那里也写着
    // not_deployed。所以「not_deployed 不得出现在 health 之前」是错的断言——
    // 我自己写过一次，被自己的实现证伪。
    //
    // 真正要守的是：**tcp.state === 'open' 之后不得直接返回**。
    // 即 open 那一支必须继续往下走到 probeAgentHealth。
    const openBranch = probe.slice(tcpAt, healthAt);
    assert.match(openBranch, /tcp.state === 'refused'/,
        'refused 分支在 health 检查之前早退（没人应答时不必再问）');
    // ⚠️ 这里要用 **调用点** 而不是函数名：
    // probeAgentHealth 在本文件里有定义处与调用处两个 'await probeAgentHealth('，
    // indexOf 命中的是更早的定义，于是 slice 从定义之后开始——
    // 而 `if (!health.ok)` 在调用处，正好落在切片起点之前，断言就红了
    // （实测踩过一次）。所以锚点取 `const health = await probeAgentHealth(`。
    const callAt = probe.indexOf('const health = await probeAgentHealth(');
    assert.ok(callAt > tcpAt, '调用点在 TCP 探测之后（healthAt 是定义处，callAt 才是调用处）');
    assert.match(probe.slice(callAt),
        /const health = await probeAgentHealth\([\s\S]{0,200}?if \(!health\.ok\)/,
        'health 调用的结果立刻被检查——TCP 通但答不出形状就落到 port_conflict');
    // open 分支之后的那段（health 与 metrics 之间）才是 port_conflict 的落点
    const healthToMetrics = probe.slice(healthAt, metricsAt);
    assert.doesNotMatch(openBranch, /deployState: 'ready'/,
        'TCP 通之后不得直接判就绪——必须先确认对面是 agent');
    // 答不出 agent 形状的，落到 port_conflict（那个端口上确实没有我们的 agent）
    assert.match(probe.slice(healthAt, metricsAt), /deployState: 'port_conflict'/,
        'TCP 通但答不出 /health 形状 → port_conflict');
});

test('端口上有服务时要确认那确实是 agent', () => {
    // 只做 TCP 探测会漏掉一种情况：别的程序占着 4195，
    // 用户看到「有东西在监听」却始终读不到指标。
    const code = stripComments(monitorSource);
    assert.match(code, /function probeAgentHealth/, '有健康探测');
    assert.match(code, /payload\.status === 'ok'/, '校验响应形状');
    assert.match(code, /rejectUnauthorized: false/, '探测时不校验证书');
    // ⚠️ 不校验证书是这个探测成立的前提：此刻证书还没被信任，
    // 正在被信任的正是「这个端口是我们的 agent」这件事本身
    assert.match(serverSource, /port_conflict/, '端口冲突单独成一态');
});

test('健康探测比对协议版本，而不是把不认识的字段当 0', () => {
    const code = stripComments(monitorSource);
    assert.match(code, /payload\.version === AGENT_PROTOCOL_VERSION/, '比对版本');
    assert.ok(code.includes('协议版本'), '版本不符时给明确错误');
});

test('push 模式不探测端口——它一个端口都不开', () => {
    // 探测 TCP 在推送机器上永远得到「连不上」，而那不是故障。
    // 推送的在线判定靠「多久没收到上报」。
    const probe = routeBody("app.post('/api/modules/servers/:id/probe'");
    assert.ok(probe.length > 1200, `拿到 probe 路由（${probe.length}）`);

    // ⚠️ 用「push 分支起点 → TCP 探测起点」这一段做区间断言，
    // 而不是找某个固定宽度的窗口——窗口宽度是实现细节，改一句文案就红。
    const pushAt = probe.indexOf('if (isPush) {');
    const tcpAt = probe.indexOf('await probeTcp(');
    assert.ok(pushAt > 0, 'push 模式有独立分支');
    assert.ok(tcpAt > pushAt, 'TCP 探测在 push 分支之后');
    const pushBranch = probe.slice(pushAt, tcpAt);
    // 该分支里不得出现 TCP 探测：push 机器没有端口可探
    assert.doesNotMatch(pushBranch, /probeTcp\(/, 'push 分支不走 TCP 探测');
    // 且它自己给出了答案（两条：未注册 / 已注册）
    assert.match(pushBranch, /deployState: 'not_deployed'/, '未注册时给出 not_deployed');
    assert.match(pushBranch, /deployState: 'ready'/, '已注册时给出 ready');
    assert.match(pushBranch, /不开放端口|没有端口可探测|探测不到主机是否在线/,
        '说清为什么探不到');
});


test('注册限流桶会被定时清理，否则是只增不减的 Map', () => {
    // 回归记录（本轮代码审查自查发现）：enrollLimitMap 曾是仓库里**唯一**
    // 没被登记进 60 秒清理定时器的限流 Map。
    //
    // 为什么这是真的问题：POST /api/modules/enroll 匿名可达（agent 注册时
    // 还没有任何长期凭据），而这个桶按来源 IP 计数 —— 不清理就随 IP 数量
    // 无限增长。推送桶有同样的形状，server.js 里明写了「不清就会无限增长」，
    // 新桶漏掉属于同一个缺陷。
    const code = stripComments(serverSource);
    assert.match(code, /sweepRateLimitStore\(enrollLimitMap, now, ENROLL_LIMIT_WINDOW\)/,
        '注册桶登记在清理定时器里');

    // 前向不变量：仓库里每个限流 Map 都该被清理。列出来是为了
    // 下次新增桶时能一眼看出「少了一个」。
    //
    // ⚠️ 捕获 Map 名要用 `(\w*Map)` 而不是 `(\w+Map)`：后者在
    // 「pasteRateLimitMap」上会贪婪到把 Map 吃掉、只捕获到 pasteRateLimit，
    // 于是报出一条「它没被清理」的假问题（实测踩过）。
    const maps = [...code.matchAll(/const (\w*Map) = new Map\(\)/g)].map(m => m[1]);
    assert.ok(maps.length >= 4, `解析出 ${maps.length} 个限流 Map：${maps.join(', ')}`);
    const swept = [...code.matchAll(/sweepRateLimitStore\((\w+),/g)].map(m => m[1]);
    for (const name of new Set(maps)) {
        assert.ok(swept.includes(name),
            `限流 Map ${name} 没有登记进清理定时器`);
    }
});

test('注册成功即作废令牌，重放必须失败', () => {
    // 这是令牌能当凭据用的前提。若重放能成功，它就退化成一个长期凭据，
    // 15 分钟 TTL 形同虚设。
    const enroll = routeBody("app.post('/api/modules/enroll'");
    assert.ok(enroll.length > 800, `拿到 enroll 路由（${enroll.length}）`);
    // 变异验证：把两个键的删除循环改成空的（`for (const k of [])`）后本条必须红
    assert.match(enroll, /for \(const k of \['enrollTokenHash'/,
        '成功后逐个删除令牌的键');
    // ⚠️ 只有两个键了：第三个（enrollTokenIp）曾是一句假防护——
    // 签发时存 hostOf(server.url)、注册时比 hostOf(matched.url)，
    // 同一个字段的同一个函数，两边恒相等，分支永不执行。
    // 服务端看到的是目标机的**出口** IP（NAT 之后），与后台填的地址不可比，
    // 所以这道防护做不到，已连同注释与 README 里的声明一起删掉。
    for (const k of ['enrollTokenHash', 'enrollTokenExpiresAt']) {
        assert.ok(enroll.includes(`delete servers[index][`) && enroll.includes(k),
            `成功后删除 ${k}`);
    }
    assert.doesNotMatch(enroll, /enrollTokenIp\s*!==/,
        '不得保留那个恒不成立的 IP 比对');
    assert.ok(!/enrollTokenIp:\s*hostOf\(/.test(stripComments(serverSource)),
        '签发时也不再存期望来源 IP');
    // 作废必须发生在写盘之前
    const delAt = enroll.indexOf('delete servers[index]');
    const writeAt = enroll.indexOf('writeJSON');
    assert.ok(delAt > 0 && writeAt > delAt, '先作废再写盘');
});

test('自签服务器要带 --server-ca，且失败提示要说清这件事', () => {
    // 【实测】Go 在 macOS 上不读 SSL_CERT_FILE / SSL_CERT_DIR（那是 Linux
    // 行为，macOS 走系统 Keychain），GODEBUG=x509usefallbackroots=1 也无效。
    // 于是自托管用户（自签证书而非 certbot）的 enroll 必然握手失败——
    // 报「certificate signed by unknown authority」，而这不是「明文不可用」
    // 那条安全要求想要的结果，只是让自签部署完全不可用。
    //
    // 所以必须有一条显式的 CA 通路：--server-ca <PEM 路径>。
    // 用路径而不是 PEM 字符串：命令行会出现在 ps 输出里。
    assert.match(goSource, /func enrollClient\(args options\) \*http\.Client/,
        '有专门构造客户端的函数');
    const fn = /func enrollClient\(args options\) \*http\.Client \{[\s\S]*?\n\}/.exec(goSource);
    assert.ok(fn, '切出 enrollClient');
    assert.match(fn[0], /server-ca/, '接受 --server-ca');
    assert.match(fn[0], /NAV_AGENT_SERVER_CA/, '也支持环境变量');
    assert.match(fn[0], /RootCAs: pool/, '把它当可信根（而不是 InsecureSkipVerify）');
    assert.doesNotMatch(goSource, /InsecureSkipVerify:\s*true/,
        '不得用「跳过证书校验」糊过去——那等于把 HTTPS 降级成明文');

    // install.sh 要真的把它传下去
    assert.match(installSh, /--server-ca\) SERVER_CA=/, 'install.sh 接受该参数');
    assert.match(installSh, /ENROLL_ARGS\+=\(--server-ca "\$SERVER_CA"\)/, '并传给 agent');

    // 失败提示必须给出这个具体原因，否则用户只会看到一句天书
    const seg = installSh.slice(installSh.indexOf('if ! "$BIN_PATH"'));
    assert.ok(seg.length > 100, '切出注册失败的分支');
    assert.match(seg.slice(0, 800), /certificate signed by unknown authority/,
        '失败提示点名证书不受信这个原因');
    assert.match(seg.slice(0, 800), /--server-ca/, '并给出怎么补');
});

test('agent 发出的注册请求带 token——这个 bug 曾让 NAS 上 100% 失败', async (t) => {
    // 【真实缺陷，用户在 NAS 上跑安装脚本时发现】
    // HTTP 400「缺少令牌」。根因：agent 校验了 token 非空（main.go 的
    // `args.pick("token", ...)` + 空值检查），却**没把它放进发出去的
    // JSON body**。于是：
    //   · 二进制编译通过（Go 不管这件事）
    //   · 341 项单元测试全绿（没有一条跑过两端通话）
    //   · 代码审计也没看出来（两边各自都有测试，却没有一个断言
    //     「agent 发的字段名 == 服务端读的字段名」）
    //   · 真实调用 100% 失败
    //
    // 这条断言的作用不是「检查代码里有没有这个字」，而是
    // **真的把两个程序放在一起跑一次**。形状断言看不见
    // 一个组件间的字段契约对不对得上。
    //
    // 守卫方式：把 agent 构造请求的那段代码切出来，逐字断言
    // 它与服务端读的那一行是同一个键名。
    const start = goSource.indexOf('body, _ := json.Marshal(map[string]string{');
    assert.ok(start > 0, '找到 agent 构造注册请求体的位置');
    const seg = goSource.slice(start, start + 600);
    assert.match(seg, /"token":\s*token,/, '请求体里必须带 token 字段');

    // 而服务端读的是 body.token —— 两个名字必须对得上
    const enroll = routeBody("app.post('/api/modules/enroll'");
    assert.ok(enroll.length > 400, '拿到 enroll 路由');
    assert.match(enroll, /body\.token/, '服务端从 body.token 读取');

    // 变异验证：删掉 "token": token, 这一行后本条必须红
});

test('enroll 能端到端跑通：真 agent 打通真服务端（这是唯一可靠的守卫）', async (t) => {
    // 上面那条钉住「token 在请求体里」，但那是形状断言。
    // 真正证明两端对得上的是把它们放在一起跑：
    //   真 agent 二进制 → 真 enroll 路由 → 真配置落盘
    //
    // 需要能写的配置目录，所以 agent 支持 NAV_AGENT_HOME 覆盖
    // （非 root 环境下 /etc/nav-agent 不可写）。这个覆盖最初不存在，
    // 于是 enroll 这条路径**从未在测试里跑过一次**——正是它漏掉
    // 上一个 bug 的原因。
    assert.match(goSource, /NAV_AGENT_HOME/,
        '配置目录可被覆盖，否则非 root 环境无法端到端测试');

    const bin = path.join(ROOT, 'agent', 'dist', 'nav-agent-darwin-arm64');
    if (!fs.existsSync(bin) || process.platform !== 'darwin') {
        t.skip('需要先跑 scripts/build-agent.sh 生成 darwin 产物');
        return;
    }

    const os = require('os');
    const https = require('https');
    const { spawn } = require('child_process');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-enroll-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));

    // ⚠️ 必须用 HTTPS：agent 硬切掉明文（用户要求「坚决不能用 http」），
    // 连自己测试的服务端也不例外。
    //
    // ⚠️⚠️ agent 必须用**异步** spawn，不能用 spawnSync/execSync：
    // 同步调用会阻塞整个 Node 进程的事件循环，于是同一个进程里的
    // HTTPS 服务器根本来不及响应，握手卡到超时。表现是
    // 「TLS handshake timeout」——一个与被测代码毫无关系的假信号，
    // 而且会让人误以为是证书信任问题。（实测在这个坑里绕了两圈。）
    const { execFileSync: ef } = require('child_process');
    let key, cert;
    try {
        ef('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', path.join(home, 'k.pem'), '-out', path.join(home, 'c.pem'),
            '-days', '1', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
        key = fs.readFileSync(path.join(home, 'k.pem'), 'utf8');
        cert = fs.readFileSync(path.join(home, 'c.pem'), 'utf8');
    } catch {
        t.skip('本机没有 openssl，无法起自签 HTTPS 测试服务端');
        return;
    }

    let received = null;
    const srv = https.createServer({ key, cert }, (req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            received = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ serverId: 's1', mode: 'pull', token: 'tok' }));
        });
    });
    srv.on('clientError', (e, sock) => sock.destroy());
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    t.after(() => srv.close());

    const env = {
        ...process.env,
        NAV_AGENT_HOME: home
    };

    // --server-ca 是真实能力，不只是测试后门：Go 在 macOS 不读 SSL_CERT_FILE，
    // 自签部署的 enroll 必须靠它（Linux 上自签同样要）。
    // 所以这里用**命令行参数**而不是环境变量，顺带证明那条路径真的通了。
    const args = [
        'enroll', '--server', `https://127.0.0.1:${port}`,
        '--token', 'test-enroll-token',
        '--server-ca', path.join(home, 'c.pem')
    ];

    const { code, stdout, stderr } = await new Promise((resolve) => {
        const child = spawn(bin, args, { env });
        let out = '', err = '';
        child.stdout.on('data', c => { out += c; });
        child.stderr.on('data', c => { err += c; });
        child.on('close', c => resolve({ code: c, stdout: out, stderr: err }));
    });
    const r = { status: code, stdout, stderr };

    assert.equal(r.status, 0, `enroll 成功退出：${r.stderr || r.stdout}`);
    // 服务端真的收到了 token，且值一字不差
    assert.ok(received, '服务端收到了请求');
    assert.equal(received.token, 'test-enroll-token',
        '服务端读到的 token 与 agent 持有的一致');
    assert.ok(received.certPem && received.certPem.includes('BEGIN CERTIFICATE'),
        'agent 自签了证书（不依赖 openssl）');
    assert.equal(received.mode, 'pull', '模式随请求带上');
    // agent 把自己收到的长期凭据落盘了
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(saved.token, 'tok', '长期凭据落盘');
    assert.ok(saved.certPem, '证书也落盘，供服务端作 ca');
});


test('二进制与安装脚本可被下载，且 404 必须是 shell 注释', () => {
    assert.match(serverSource, /app\.get\('\/agent\/nav-agent-linux-:arch'/, '二进制路由');
    assert.match(serverSource, /app\.get\('\/agent\/install\.sh'/, '安装脚本路由');
    // ⚠️ 这两段文本会被 install.sh 用 `bash -s` 执行。回 HTML 错误页会变成
    // 一堆莫名其妙的语法错误，而用户在目标机上。
    const binRoute = routeBody("app.get('/agent/nav-agent-linux-:arch'", "app.get('/agent/install.sh'");
    assert.ok(binRoute.length > 200, `拿到二进制路由（${binRoute.length}）`);
    assert.match(binRoute, /res\.status\(404\)\.send\(\s*['"]#/, '404 回 shell 注释');
    // 架构白名单：少了它，../ 之类能读出仓库里的其它文件
    assert.match(binRoute, /AGENT_ARCHES\.has\(arch\)/, '架构白名单');
    // 不给长缓存：URL 不变而内容随版本变
    assert.match(binRoute, /Cache-Control', 'no-cache'/, '不给长缓存');

    // ⚠️ 分发二进制必须用真正的 fs 模块，不是 fs.promises。
    // 回归记录（端到端实测）：server.js 顶部是 `require('fs').promises`，
    // 而 fs/promises **没有** createReadStream —— 路由里的
    // `fs.createReadStream(file)` 抛 TypeError，被 catch 转成 404，
    // 于是「二进制下载失败」与「架构不支持」在响应上完全一样，
    // 两者都只是一段 shell 注释，只有 109 vs 32 字节的差别。
    assert.equal(typeof require('fs').promises.createReadStream, 'undefined',
        '前提核对：fs/promises 确实没有 createReadStream');
    assert.match(binRoute, /fsSync\.createReadStream\(/,
        '二进制路由用 fsSync（真正的 fs）做流式分发');
    assert.doesNotMatch(binRoute, /[^S]fs\.createReadStream\(/,
        '不得用 fs（=fs/promises）做流式分发——它没有这个 API');
    // 二进制有 6–7MB，一次性 readFile 进内存也不是好选择
    assert.doesNotMatch(binRoute, /fs\.readFile\(file\)[\s\S]{0,200}res\.send/,
        '不得把整个二进制读进内存再发送');
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

test('后台模块页：没有总的保存按钮，本机排第一且不可删', () => {
    const code = stripComments(appSource);

    // 用户原话：「不应该存在这个按钮」——曾有个「保存模块配置」，
    // 与右上角的「保存」职责重叠、用户分不清哪个真的生效
    // （实际两者写的都是同一份 .modules.json）。
    assert.doesNotMatch(code, /saveModulesBtn|modulesSaveStatus/,
        '模块页不再有总的保存按钮与它的状态位');

    // 模块开关仍要即时落盘——删掉按钮之后，这条路径就是唯一的
    const toggle = code.slice(code.indexOf("for (const box of host.querySelectorAll('[data-module-toggle]'))"));
    assert.ok(toggle.length > 100, '切出开关绑定');
    assert.match(toggle.slice(0, 600), /addEventListener\('change'/,
        '模块开关仍走 change 即时保存，不是靠那个按钮');

    // 本机卡片：永远第一、无部署/编辑/删除
    const local = /renderLocalServerCard\(config\) \{[\s\S]*?\n        \}/.exec(code);
    assert.ok(local, '找到 renderLocalServerCard');
    assert.ok(!/deploy-server|edit-server|del-server/.test(local[0]),
        '本机卡片没有部署/编辑/删除按钮');
    assert.match(local[0], /data-server-id="local"/, '本机有独立的 id');
    // 三个状态位：已安装 / 在线 / 直读
    for (const [kind, text] of [['ready', '已安装'], ['online', '在线']]) {
        assert.match(local[0], new RegExp(`data-kind="${kind}"[\\s\\S]{0,80}?${text}`),
            `本机的「${text}」状态位`);
    }
    assert.match(local[0], /data-mode="local"/, '本机标注为直读');

    // 本机永远排在远端之前
    assert.match(code, /host\.innerHTML = this\.renderLocalServerCard\(config\)\s*\n\s*\+ servers\.map/,
        '本机卡片先渲染，随后才是远端列表');

    // ⚠️ 本机卡片缺按钮，所以事件绑定必须容错——
    // 早先是无条件 `row.querySelector('.deploy-server').onclick = …`，
    // 本机那一行会抛 TypeError 并中断后面所有行的绑定。
    const bind = code.slice(code.indexOf('for (const row of host.querySelectorAll'));
    assert.ok(bind.length > 500, '切出事件绑定循环');
    for (const sel of ['.deploy-server', '.edit-server', '.del-server']) {
        assert.match(bind.slice(0, 4000),
            new RegExp(`const \\w+ = row\\.querySelector\\('${sel.replace('.', '\\.')}'\\);\\s*\\n\\s*if \\(\\w+\\)`),
            `${sel} 的绑定带存在性判断（本机卡片没有它）`);
    }
});

test('改更新周期会让采集缓存失效，否则「改完不生效」', () => {
    // TTL 是跟着周期算出来的（周期 + 10s），但**已写下的缓存行不会因为
    // TTL 变小而提前失效**。用户把周期从 5 分钟改成 10 秒，TTL 确实变成
    // 20 秒，可那条缓存还能再活 5 分钟——前端按新周期重排了定时器，
    // 拿到的仍是旧数据，于是看起来像设置完全没起作用。
    const src = stripComments(serverSource);
    assert.match(src, /function metricsInputsChanged\(current, incoming\)/, '有判断函数');
    const fn = /function metricsInputsChanged\(current, incoming\) \{[\s\S]*?\n\}/.exec(src);
    assert.ok(fn, '切出 metricsInputsChanged');
    assert.match(fn[0], /incoming\.pollInterval/,
        '周期参与判定（不能只比 servers——那是旧版仅有的条件）');
    assert.match(fn[0], /resolvePollInterval\(incoming\.pollInterval\) !== resolvePollInterval\(current\.pollInterval\)/,
        '比较的是**归一化后**的值，否则 15 与非法值回落 15 会被判成变了');

    // 调用点必须在写盘之后
    const route = routeBody("app.post('/api/modules/config'");
    assert.ok(route.length > 300, '切出保存配置的路由');
    assert.match(route, /metricsInputsChanged\(existing, normalized\)/, '路由里真的调了它');
    const writeAt = route.indexOf('writeJSON');
    const invAt = route.indexOf('invalidateMetricsCache()');
    assert.ok(writeAt > 0 && invAt > writeAt, '先写盘再清缓存');
});

test('发布包只含 Linux 产物，不夹带本机 darwin 二进制', () => {
    // 回归记录（实测 v1.6.5 与 v1.6.6 都中招）：build-agent.sh 会顺带编译一份
    // darwin 二进制给开发机自测，注释里写着「不进发布包」——
    // 而 `cp -r agent` 不感知 .gitignore、也不看注释，于是那份 6～7 MB
    // 静静地躺在每个用户的下载包里。用户部署到的是 Linux 机器，
    // 它是纯浪费。
    //
    // 修在 release.sh（真正决定打包的地方），不是 build-agent.sh：
    // 后者是构建步骤，它删掉文件只会让本地自测不方便。
    const rel = fs.readFileSync(path.join(ROOT, 'scripts', 'release.sh'), 'utf8');
    assert.match(rel, /cp -r agent "\$DIST_DIR/,
        'release.sh 会拷 agent 目录（所以必须在这里剔除）');
    // 判据是「不是 linux- 开头」而不是匹配 darwin：
    // 将来加 windows 版时同样不该进这个面向 Linux 的包。
    assert.match(rel, /find "\$DIST_DIR\/\$\{RELEASE_NAME\}\/agent\/dist"[\s\S]{0,220}?! -name 'nav-agent-linux-\*'[\s\S]{0,80}?-delete/,
        '打包后剔除非 Linux 产物');
    // 剔除必须发生在拷贝之后
    const cpAt = rel.indexOf('cp -r agent');
    const findAt = rel.indexOf('! -name \'nav-agent-linux-*\'');
    assert.ok(cpAt > 0 && findAt > cpAt, '先拷入再剔除（反了等于什么都没剔）');
});

test('首页状态位只回答「能不能读到数据」，不再说「已就绪」', () => {
    const code = stripComments(moduleSource);

    // 用户原话：「主要体现是否在线就行了」。
    // 「已就绪 / 等待 / 未部署」是**后台操作台**的措辞——那里要分派任务
    // （该点部署还是去查网络）。首页是一眼扫过的地方，一台正常工作的
    // 机器显示「已就绪」对「它活着吗」没有额外信息量。
    const label = /function statusLabelOf\(entry\) \{[\s\S]*?\n    \}/.exec(code);
    assert.ok(label, '找到 statusLabelOf');
    assert.doesNotMatch(label[0], /已就绪|未部署|等待/,
        '首页状态位不再出现后台那三个词');
    assert.match(label[0], /case 'ready': return '在线'/, '正常就是「在线」');

    // ⚠️ 但异常必须说出来：证书被换 / 端口被占，这两种塌缩成「离线」
    // 会让用户以为机器挂了，而实际是安全问题或配置冲突。
    const kind = /function statusKindOf\(entry\) \{[\s\S]*?\n    \}/.exec(code);
    assert.ok(kind, '找到 statusKindOf');
    assert.match(kind[0], /entry\.certMismatch\) return 'alert'/,
        '证书异常单独成态');
    assert.match(kind[0], /deployState === 'port_conflict'\) return 'alert'/,
        '端口被占单独成态');

    // 后台那张卡片**保留**完整三状态位——那里才是分派任务的地方。
    // 断言这一点是为了防止「首页收敛」被误做成「两处一起简化」。
    assert.match(appSource, /text: '已就绪',/,
        '后台卡片仍用「已就绪」等完整措辞');
    assert.match(appSource, /text: '未部署',/,
        '后台仍区分「未部署」');
});

test('首页第三条指标是存储占用，不是负载', () => {
    const code = stripComments(moduleSource);
    const rows = /function metricRows\(m\) \{[\s\S]*?\n    \}/.exec(code);
    assert.ok(rows, '找到 metricRows');

    // 用户原话：「不在首页显示负载信息了不容易读懂，换成存储占用吧」。
    // 负载对不熟悉的人没有直觉：「0.52 / 0.61」是高是低得先知道核数。
    assert.match(rows[0], /metricRow\('存储'/, '第三条是「存储」');
    assert.doesNotMatch(rows[0], /metricRow\('负载'/, '首页不再有「负载」那一行');
    // 百分比条也要跟着换成存储占比
    assert.match(rows[0], /m\.diskUsed \/ m\.diskTotal/, '进度条按存储占比');

    // 但**详情页保留负载**：那里有 CPU 与核数做参照。
    // 「首页不显示」不等于「这个指标废弃了」。
    const panel = code.slice(code.indexOf('function renderPanelBody'));
    assert.ok(panel.length > 400, '切出详情页');
    assert.match(panel.slice(0, 2500), /add\('负载（1 \/ 5 分钟）'/,
        '详情页仍显示负载');
    assert.match(panel.slice(0, 2500), /add\('存储占用'/,
        '详情页也列出存储占用');
});

test('详情页显示设备地址，且在指标之外（拉不到数据时也看得到）', () => {
    const code = stripComments(moduleSource);
    const panel = /function renderPanelBody\(body, entry, all\) \{[\s\S]*?if \(!entry\.metrics\)/.exec(code);
    assert.ok(panel, '切出 renderPanelBody 到 metrics 判断之前');

    // ⚠️ 位置是关键：必须在 `if (!entry.metrics)` **之前**。
    // 放在之后意味着「这台机器连不上」时看不到地址——而那正是最需要
    // 地址的时候（排障第一句问「它在哪台机器上」）。
    // ⚠️ 本机也必须有地址（用户拍板「d 显示」）。它的 url 是 null ——
    // 因为它不通过 agent 采集——而本机的地址就是**用户此刻访问本服务
    // 的位置**，浏览器自己知道，让服务端再猜一遍反而多一处可能不一致。
    assert.match(panel[0], /entry\.isLocal \? location\.origin : entry\.url/,
        '本机用浏览器所在处，远端用配置里的地址');
    assert.match(panel[0], /module-panel-address/, '有专门的地址条');
    assert.match(panel[0], /displayHost\(address\)/, '只显示主机与端口');

    // 概览列表里也带地址，且同样覆盖本机 ——
    // 排除本机会让第一行缺地址，而那行恰恰是最常被问的
    assert.match(moduleSource, /const rowAddress = s\.isLocal \? location\.origin : s\.url;/,
        '概览行里本机也带地址');
    assert.doesNotMatch(moduleSource, /if \(s\.url && !s\.isLocal\)/,
        '不得把本机排除在外');

    // 服务端一直在传 url（server.js 的 collect 里每条都有），前端此前
    // 从没读过它——又一个「算了没人用」的字段。守卫钉住消费方存在。
    const collect = /results\.push\(\{[\s\S]*?id: 'local'/.exec(stripComments(serverSource));
    assert.ok(collect, '找到本机那条');
    // 远端每条分支都要带 url：至少失败分支与成功分支
    const remoteFails = /id: server\.id,\s*\n\s*name: server\.name,\s*\n\s*url: server\.url,[\s\S]{0,80}?online: false/.exec(stripComments(serverSource));
    assert.ok(remoteFails, '拉取失败那条也带 url');

    // 概览列表里两台机器可能都叫「服务器」，所以要带地址消歧
    assert.match(code, /module-panel-list-host/,
        '概览行里也显示地址');
});

test('磁盘数据两端都采集，且口径一致', () => {
    // agent 侧
    const go = fs.readFileSync(path.join(ROOT, 'agent', 'main.go'), 'utf8');
    assert.match(go, /DiskUsed\s+float64 `json:"diskUsed"`/, 'agent 上报 diskUsed');
    assert.match(go, /DiskTotal\s+float64 `json:"diskTotal"`/, 'agent 上报 diskTotal');
    assert.match(go, /readDiskUsage\("\/"\)/, '采根文件系统');

    const disk = fs.readFileSync(path.join(ROOT, 'agent', 'disk_other.go'), 'utf8');
    assert.match(disk, /func readDiskUsage\(path string\)/, '实现存在');
    assert.match(disk, /float64\(st\.Blocks\) \* blockSize/, '总量 = Blocks × Bsize');
    // ⚠️ 口径必须与 lib/monitor.js 的本机实现一致，否则本机卡片与远端
    // 卡片报两个不同的数，而用户无从判断该信哪个。
    assert.match(disk, /st\.Bfree/, '用 Bfree（与本机实现同口径）');

    // 本机侧
    assert.match(monitorSource, /function readLocalDisk\(\)/, '本机也采磁盘');
    assert.match(monitorSource, /fs\.statfsSync\('\/'\)/, '采根文件系统');
    assert.match(monitorSource, /diskUsed: disk\.used,/, '本机指标带 diskUsed');
    // fs 必须显式 require：它在 Node 里恰好是全局的，但那是实现细节，
    // 不是规范保证；靠全局拿不到任何编译期提示。
    assert.match(monitorSource, /^const fs = require\('fs'\);$/m, 'fs 显式引入');

    // 推送载荷校验也要认这两个字段，否则推送模式一律显示「—」
    const norm = /function normalizePushedMetrics\(raw\) \{[\s\S]*?\n\}/.exec(stripComments(serverSource));
    assert.ok(norm, '找到 normalizePushedMetrics');
    assert.match(norm[0], /diskUsed: nonNegative\(raw\.diskUsed, 0\)/, '校验 diskUsed');
    assert.match(norm[0], /diskTotal: nonNegative\(raw\.diskTotal, 0\)/, '校验 diskTotal');

    // CSS
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    assert.match(css, /\.module-panel-address-host\s*\{/, '地址条有样式');
    assert.match(css, /\.module-panel-list-host\s*\{/, '概览里的地址有样式');
});

test('软件版本与协议版本是两件事，且软件版本由构建期注入', () => {
    // ⚠️ 这两个混用会让「升级了 agent」变成「协议不一致」，
    // 而指标字段一个都没变——服务端会报一个用户无法理解的错误。
    assert.match(goSource, /const VERSION = 1/, '协议版本恒为 1');
    assert.match(goSource, /var buildVersion = "dev"/, '软件版本独立、可注入');
    // 缺省回落 dev：让「从源码直接 go build 的产物」能被识别出来，
    // 而不是伪装成某个正式版本。
    assert.match(goSource, /func agentVersion\(\) string \{[\s\S]{0,200}?return "dev"/,
        '未注入时回落 dev');

    // build-agent.sh 必须真的从 version.json 读，而不是硬编码
    assert.match(buildSh, /version\.json/, '构建时读 version.json');
    assert.match(buildSh, /main\.buildVersion=/, '通过 -X 注入');
    // ⚠️ 少了这条注入，产物会自报 dev，后台永远提示「有新版」——
    // 而用户升了三次都是同一个 dev。
});

test('agent 能自升级，且三道校验都在替换之前', (t) => {
    const bin = localAgentBinary();
    if (!bin) { t.skip('未构建 agent 二进制'); return; }

    const usage = execFileSync(bin, ['help'], { encoding: 'utf8' });
    assert.match(usage, /nav-agent upgrade/, 'usage 里有 upgrade');
    assert.match(usage, /amd64 \/ arm64 \/ armv7/, '说明支持哪些架构');

    // --- version --raw：机器可读入口 ---
    // ⚠️ 这条是被实测逼出来的：upgrade 最初解析人类可读那行，
    // 按空白切第 2 段拿到的是 "1.6.7（协议"，然后被当版本号去比较。
    // 任何一次改文案都会静默弄坏它，所以机器可读的字段必须有自己的入口。
    const raw = execFileSync(bin, ['version', '--raw'], { encoding: 'utf8' }).trim();
    assert.match(raw, /^(dev|\d+(\.\d+)*)$/, `version --raw 只输出版本号（实际 ${raw}）`);
    const human = execFileSync(bin, ['version'], { encoding: 'utf8' });
    assert.match(human, /nav-agent/, '人类可读那行仍以 nav-agent 开头');
    assert.match(human, /（协议 v/, '人类可读那行仍带协议版本');

    // --- 缺 --server 时明确报错，不静默 ---
    const r = spawnSync(bin, ['upgrade'], { encoding: 'utf8', timeout: 20000 });
    assert.notEqual(r.status, 0, '缺 --server 时非零退出');
    assert.match(r.stderr + r.stdout, /缺少 --server/, '说清缺什么');

    // --- 三道校验的顺序：都在替换之前 ---
    const up = /func cmdUpgrade\(args options\) error \{[\s\S]*?\n\}/.exec(goSource);
    assert.ok(up, '找到 cmdUpgrade');
    const sizeAt = up[0].indexOf('written < 1024*1024');
    const probeAt = up[0].indexOf('probeBinaryVersion(tmpPath)');
    const backupAt = up[0].indexOf('copyFile(self, backup)');
    const renameAt = up[0].indexOf('os.Rename(tmpPath, self)');
    assert.ok(sizeAt > 0 && probeAt > sizeAt, '大小检查在自检之前');
    assert.ok(backupAt > probeAt,
        '**替换前**先自检通过，才备份（顺序反了会留下跑不起来的 agent）');
    assert.ok(renameAt > backupAt, '备份之后才替换');

    // --- 校验失败时不得动原文件 ---
    // 升级最重要的一条性质：失败的升级必须让机器上仍然有一个能跑的
    // agent，而用户已经在目标机上——那比「升级失败」糟糕得多。
    assert.match(up[0], /新下载的文件跑不起来：[\s\S]{0,60}保持现有版本不变/,
        '自检失败的提示要说明原版本未被动过');
    assert.ok(up[0].indexOf('保持现有版本不变') < renameAt,
        '「保持不变」那个分支必须在 rename 之前返回');

    // --- 替换后再验一次 + 回滚 ---
    assert.match(up[0], /probeBinaryVersion\(self\)/, '替换后复验落地的那一个');
    assert.match(up[0], /rollback := func/, '有回滚实现');
    assert.match(up[0], /os\.Remove\(backup\)/, '成功后清掉备份');
});

test('agent 的版本解析来自受控输出，不解析人类可读那行', () => {
    const fn = /func probeBinaryVersion\(path string\) \(string, error\) \{[\s\S]*?\n\}/.exec(goSource);
    assert.ok(fn, '找到 probeBinaryVersion');
    assert.match(fn[0], /"version", "--raw"/,
        '用 --raw 入口（人类可读那行带中文括号，按空白切会切错）');
    assert.match(fn[0], /版本号格式异常/, '格式不对要拒绝而不是放行');
    assert.doesNotMatch(fn[0], /strings\.Fields\(line\)\[1\]/,
        '不得靠切人类可读输出取版本号');
});

test('采集在 macOS 与 Linux 上都拿得到，缺的那项诚实降级', (t) => {
    const bin = localAgentBinary();
    if (!bin) { t.skip('未构建 agent 二进制'); return; }

    const m = JSON.parse(execFileSync(bin, ['collect'], { encoding: 'utf8' }));

    // 内存与存储必须在所有平台都拿得到 —— 用户明确要求这两项跨平台
    for (const k of ['memoryUsed', 'memoryTotal', 'diskUsed', 'diskTotal']) {
        assert.equal(typeof m[k], 'number', `${k} 是数字`);
    }
    assert.ok(m.memoryTotal > 0, '内存总量大于 0（取不到时显示「—」）');
    assert.ok(m.diskTotal > 0, '存储总量大于 0');

    // CPU 在 macOS 上拿不到（现代内核移除了 kern.cp_time，没有 cgo 就
    // 读不到累计值），实测为 null —— 诚实降级，不是 0。
    //
    // ⚠️ 断言的形态是「数字或 null」而不是「大于 0」：
    // 早期版本只断言函数存在，于是「数组减数字 = NaN → CPU 恒 null」
    // 这一整类缺陷全都能通过，而返回的 JSON 完全合法、看不出出错。
    assert.ok(m.cpu === null || typeof m.cpu === 'number', 'CPU 是数字或 null');
    if (m.cpu !== null) {
        assert.ok(m.cpu >= 0 && m.cpu <= 1, `CPU 在 0..1 之间（实际 ${m.cpu}）`);
    }
});

test('build 约束只圈住真正支持的平台', () => {
    // ⚠️ 这条来自一次真实踩坑：`//go:build !windows` 把 OpenBSD 圈了进来，
    // 而它的 syscall.Statfs_t 字段叫 F_bsize —— 于是 main.go 的调用处
    // 变成 undefined: readDiskUsage，整个包编译不过。
    //
    // 「这台机器没有磁盘数据」与「这个平台编不出 agent」是两件事：
    // 后者意味着用户连装都装不上。
    const disk = fs.readFileSync(path.join(ROOT, 'agent', 'disk_other.go'), 'utf8');
    const tag = /\/\/go:build (.+)/.exec(disk);
    assert.ok(tag, 'disk_other.go 有 build 约束');
    // 白名单式而不是排除式：排除式会在新增平台时静默圈错
    assert.match(tag[1], /\blinux\b/, '含 linux');
    assert.match(tag[1], /\bdarwin\b/, '含 darwin');
    assert.doesNotMatch(tag[1], /^!/, '不用 !xxx 排除式');

    // 必须有对应的降级实现，否则不支持的平台上整个包编译不过
    const fallback = path.join(ROOT, 'agent', 'disk_unsupported.go');
    assert.ok(fs.existsSync(fallback), '有 disk_unsupported.go 兜底');
    const fb = fs.readFileSync(fallback, 'utf8');
    assert.match(fb,
        /func readDiskUsage\(path string\) \(used float64, total float64\) \{ return 0, 0 \}/,
        '不支持的平台上返回 0,0（界面显示「—」而不是假值）');
    const fbTag = /\/\/go:build (.+)/.exec(fb);
    assert.ok(fbTag && fbTag[1].includes('!linux'), '兜底与主实现的条件互补');
});

test('服务端能读到 agent 的软件版本（升级提示的前提）', () => {
    // ⚠️ 没有它，后台无法判断「目标机上跑的是不是旧版」。
    // 而旧 agent 根本没有 upgrade 子命令——所以只知道「版本旧」没用，
    // 必须把版本值取回来才能给出一条可执行的动作。
    const health = /async function probeAgentHealth[\s\S]*?\n\}/.exec(monitorSource);
    assert.ok(health, '找到 probeAgentHealth');
    assert.match(health[0], /agentVersion/,
        '健康探测把 agent 的软件版本带出来');
    assert.match(health[0], /typeof payload\.agentVersion === 'string'/,
        '校验类型，不把任意值当版本');
    // ⚠️ 不要断言它叫 payload.version —— 那是**协议**版本（恒为 1），
    // 与软件版本是两件事。混用会让「升级了 agent」变成「协议不一致」。
    assert.match(health[0], /payload\.version === AGENT_PROTOCOL_VERSION/,
        '协议版本仍只用于判断能不能解析');

    const route = routeBody("/api/modules/servers/:id/probe");
    assert.ok(route.length > 800, '切出 probe 路由');
    assert.match(route, /agentVersion: health\.agentVersion \|\| null/,
        'probe 响应带出 agent 版本');
});

test('重复执行部署命令不会撞 ETXTBSY，且会先停掉旧 agent', () => {
    // 用户问的：「已经装了 agent，再执行一遍部署命令会怎么样？」
    //
    // 两个独立的机制，缺一不可：
    //
    // ① **不会 ETXTBSY**。Linux 内核禁止覆盖**执行中**的 inode，而
    //    install(1) 的内部实现是「复制到临时文件再 rename」——rename 换的是
    //    目录项，不动那个已映射的 inode。所以 install -m 0755 覆盖一个正在
    //    运行的 agent 是安全的（实测：macOS 上同样不报错）。
    //
    // ② **但换 token 会造成一段 401 空窗**。enroll 会让服务端换掉 token 并
    //    作废旧的，而旧进程还在跑、手里是旧 token —— 从 enroll 成功到
    //    systemctl restart 之间它一直 401。表现为「首页那台机器突然掉线，
    //    几秒后恢复」，用户会以为部署把机器弄坏了。
    //
    // 所以脚本必须在**装二进制之前**就停掉它。
    const stopAt = installSh.indexOf('systemctl stop nav-agent');
    const installAt = installSh.indexOf('install -m 0755');
    // 锚点用 ENROLL_ARGS[@] 而不是整条 if —— 后者的引号与空格在
    // 改动中最容易变，而这里要定位的只是「调用注册的那一步」。
    const enrollAt = installSh.indexOf('"${ENROLL_ARGS[@]}"');
    assert.ok(stopAt > 0, '脚本会停掉正在运行的 agent');
    assert.ok(installAt > 0, '找到安装那一步');
    assert.ok(enrollAt > 0, '找到注册那一步');
    assert.ok(stopAt < installAt,
        '**先停再装**：否则旧进程一直占着，且第 ② 条的空窗无从避免');
    assert.ok(stopAt < enrollAt, '且必须在 enroll 之前停（enroll 会作废旧 token）');

    // 停止失败不能中断整条命令——否则一个僵死的 systemd 会让用户
    // 连「升级」都做不了，而升级才是他更需要的操作。
    assert.match(installSh, /systemctl stop nav-agent \|\| warn/,
        '停止失败只警告不中断');
    // 也要覆盖没有 systemd 的手动运行场景
    assert.match(installSh, /pkill -x nav-agent/,
        '手动运行的进程也会被停掉');
});

test('部署面板给出独立的升级命令，且路径与脚本一致', () => {
    const code = stripComments(appSource);
    // ⚠️ 切片必须守长度上界：本文件（app.js）里 showDeployDialog 之类的名字
    // 可能同时出现在**调用处**与定义处，取第一个匹配的 `\n        }` 会切出
    // 一个几百字符的片段，于是后面的断言全部指向错误的范围。
    // 同批新增的断言都守了这条（route.length > 800、slice(0, 2500)），唯独它没有。
    const dialog = /showDeployDialog\(server\) \{[\s\S]*?\n        \}/.exec(code);
    assert.ok(dialog, '切出 showDeployDialog');
    assert.ok(dialog[0].length > 800,
        `切到的是定义而非调用处（${dialog[0].length} 字符）`);

    // 升级命令必须在面板里，与部署命令**并列**
    assert.match(dialog[0], /upgrade --server \$\{origin\}/, '面板给出升级命令');
    // 自签时也要带 CA，否则升级握手失败
    assert.match(dialog[0], /--server-ca/, '自签时升级命令也带 CA');

    // ⚠️ 路径必须与 install.sh 的 BIN_PATH 逐字一致。
    // 两处漂移时用户拿到的是一条跑不通的命令，而错误发生在目标机上，
    // 排查成本很高。
    const binPath = /^BIN_PATH="([^"]+)"/m.exec(installSh);
    assert.ok(binPath, 'install.sh 里定义了 BIN_PATH');
    assert.ok(dialog[0].includes(binPath[1]),
        `升级命令的路径与 install.sh 的 BIN_PATH 一致（${binPath[1]}）`);

    // 措辞要说清「升级不换 token」——用户在 sudo 之前需要知道这条
    // 会不会动他的凭据。
    assert.match(dialog[0], /不重新注册/,
        '说明升级不重新注册');
    assert.match(dialog[0], /systemctl restart nav-agent/,
        '提醒升级后要重启服务');
});

test('enrollTokenIp 已彻底移除（含作废时的删除循环）', () => {
    // 上一轮删掉了这个假防护的字段与声明，却漏了这个删除循环里的名字。
    // delete 一个不存在的键是空操作，所以无害——但它让「已经彻底移除」
    // 这件事在代码里看着不是真的，下一个人会以为还有残留要找。
    const route = routeBody("app.post('/api/modules/enroll'");
    assert.ok(route.length > 400, '切出 enroll 路由');
    assert.doesNotMatch(route, /enrollTokenIp/,
        '作废令牌的删除循环里也不该再有它');
    // 而两个真键必须在（它们写在同一个 for 的数组字面量里）
    assert.match(route, /for \(const k of \['enrollTokenHash', 'enrollTokenExpiresAt'\]\)/,
        '作废时删掉这两个键');
});

test('同一 IIFE 里不得有两份同名函数（声明提升会让前一份变死代码）', () => {
    // ⚠️ 代码审查发现（而 360 项测试全绿）：server-monitor.js 里曾有**两份**
    // fmtBytes —— 旧的在上方（只到 TB，多一条「≥100 就取整」的分支），
    // 新加的在下方。JS 的函数声明提升让**后一份覆盖前一份**，于是旧的成了
    // 死代码，而它看起来完全正常，没有任何一条断言过具体输出。
    //
    // 「看起来正常 + 全绿 + 实际不生效」是这个项目反复遇到的组合，
    // 所以这里钉的是「同一作用域内不得重复声明」这个结构本身。
    const fns = ['fmtBytes', 'fmtPercent', 'fmtDuration', 'displayHost'];
    for (const name of fns) {
        const count = (stripComments(moduleSource).match(
            new RegExp(`function ${name}\\(`, 'g')) || []).length;
        assert.equal(count, 1,
            `${name} 在 server-monitor.js 里声明了 ${count} 次（必须恰好 1 次）`);
    }
});

test('agent 的 CA 客户端只有一份实现，升级与注册共用', () => {
    // 审查发现：早先 enrollClient 与 upgradeHTTPClient 各写一份 23 行，
    // 而 upgrade 那份**丢掉了 enroll 的两条 stderr 提示** —— CA 路径写错时
    // 它静默回落到系统根池，用户只看到「certificate signed by unknown
    // authority」，完全指不到「你的 --server-ca 路径不对」。
    //
    // 两份副本必然漂移，这正是本项目反复吃过亏的地方（协议常量、
    // 轮询白名单、架构白名单）。
    assert.match(goSource, /func upgradeHTTPClient\(args options\) \*http\.Client \{ return enrollClient\(args\) \}/,
        'upgrade 复用 enroll 的 CA 客户端');
    // 两处「读不到 CA 就报错」的提示必须还在
    for (const msg of ['读取 --server-ca 失败', '里没有可用的证书']) {
        const at = goSource.indexOf(msg);
        assert.ok(at > 0, `${msg} 仍在`);
        // 且必须在 enrollClient 之内（也就是共用路径上），不是各写一份
        const fnStart = goSource.indexOf('func enrollClient');
        const fnEnd = goSource.indexOf('\n}', fnStart);
        assert.ok(at > fnStart && at < fnEnd, `${msg} 在共享的那一份里`);
    }
});

test('currentArch 不得留「两个分支返回同值」的死代码', () => {
    // 早先写的是 `if os.Getenv("GOARM") == "7" { return "armv7" }` 之后
    // 再 `return "armv7"` —— 两支同值。而且 GOARM 是**编译期**变量，
    // 运行中的二进制不带它，那个 if 永远不成立。
    const fn = /func currentArch\(\) \(string, error\) \{[\s\S]*?\n\}/.exec(goSource);
    assert.ok(fn, '找到 currentArch');
    assert.doesNotMatch(fn[0], /GOARM/,
        '不得按 GOARM 分支（那是编译期变量，运行期读不到）');
    // 三个支持的架构各一个 case，不多不少
    const cases = fn[0].match(/case "(\w+)":/g) || [];
    assert.equal(cases.length, 3, `恰好三个架构分支（实际 ${cases.length}）`);
    for (const a of ['amd64', 'arm64', 'arm']) {
        assert.match(fn[0], new RegExp(`case "${a}":\\s*return "${a === 'arm' ? 'armv7' : a}"`),
            `${a} → ${a === 'arm' ? 'armv7（v7 能在 v5/v6 上跑，反之不行）' : a}`);
    }
    // 白名单与 server.js 那份一致，且有比对测试
    const server = stripComments(serverSource);
    const arches = /const AGENT_ARCHES = new Set\(\[([^\]]*)\]\)/.exec(server);
    assert.ok(arches, '找到服务端的架构白名单');
    for (const a of ['amd64', 'arm64', 'armv7']) {
        assert.ok(arches[1].includes(`'${a}'`), `服务端白名单含 ${a}`);
    }
});

test('自签证书开关是真实可用的（有配置键、有 UI、有赋值）', () => {
    // 【P0，代码审查发现】部署面板读的是 `this.serverIsSelfSigned`，
    // 而那个属性**从未被赋值、也没有任何 UI 能设置它** —— 恒为 undefined，
    // 于是自签分支永不触发：自签部署的用户拿到的命令必然缺 --server-ca，
    // agent 在目标机上报一句指不到真因的
    // 「certificate signed by unknown authority」。
    //
    // 这类 bug 最贵的地方在于它**看起来完全正常**：属性名合理、判断有模有样、
    // 形状断言与全绿测试都看不见「它从来没有被写」。
    const code = stripComments(appSource);
    const defs = fs.readFileSync(path.join(ROOT, 'server-config', 'defaults.js'), 'utf8');
    // 剥掉行注释再查「赋值」：init 里那条注释正解释着为什么要赋值，
    // 不剥的话 `/\/\//` 之类会误伤。
    const codeOnly = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    // ① 配置键存在，有默认值与解释
    assert.match(defs, /selfSignedCert:\s*false/,
        '配置有 selfSignedCert 且默认 false（按可信证书处理）');
    // ⚠️ 不要用固定字符窗口：解释它的那段注释有 8 行。
    // 断言的是「默认值紧跟着解释」，所以取「键之前 700 字符」而不是之后。
    const keyAt = defs.indexOf('selfSignedCert: false');
    assert.ok(keyAt > 0, '找到 selfSignedCert 默认值');
    assert.match(defs.slice(Math.max(0, keyAt - 700), keyAt),
        /certificate signed by unknown authority/,
        '默认值处说清它不设会怎样');

    // ② 它真的被读出来赋给状态（而不是靠某个从未执行的分支）
    // ⚠️⚠️ 必须走**服务配置**的端点，而不是 `/api/config`：
    // 那条字段住在 server-config.json，而 `/api/config` 返回的是
    // config.json（用户的公开配置：主题/分类/搜索引擎）——两个文件、
    // 两套字段，从后者读永远是 undefined，而界面看起来一切正常。
    // 浏览器实测发现；单元测试全绿，因为没有任何一条断言它真的被下发。
    const init = /async init\(\) \{[\s\S]*?\n        \}/.exec(codeOnly);
    assert.ok(init, '切出 init');
    assert.match(init[0], /API\.get\('\/api\/server-flags'\)/, '从服务配置端点读');
    assert.doesNotMatch(init[0], /this\.config\?\.security\?\.selfSignedCert/,
        '不得从 /api/config 读 —— 那是用户公开配置，没有这个字段');
    assert.match(init[0], /this\.selfSignedCert = flags\?\.selfSignedCert === true;/,
        '保存到状态');
    // 读失败也要有明确落点，而不是留 undefined
    assert.match(init[0], /catch[\s\S]{0,200}?this\.selfSignedCert = false;/,
        '读失败按「否」处理');

    // ③ 服务端真的提供这个端点，且只回那一个布尔
    const getRoute = routeBody("app.get('/api/server-flags'");
    assert.ok(getRoute.length > 100, `切出 GET 端点（${getRoute.length}）`);
    assert.match(getRoute, /config\.security\.selfSignedCert === true/,
        '读的是服务配置里那个值');
    // ⚠️ 整个 security 段里有 defaultPassword / adminPasswordFile，
    // 那两个绝不能被这个公开只读端点下发
    assert.doesNotMatch(getRoute, /defaultPassword|adminPasswordFile/,
        '不得下发凭据与密码文件路径');

    // ④ 写端点：白名单 + 类型校验 + 落盘 + 告知需重启
    const postRoute = routeBody("app.post('/api/server-flags'");
    assert.ok(postRoute.length > 400, `切出 POST 端点（${postRoute.length}）`);
    // ⚠️ 白名单常量定义在**路由之前**，所以 routeBody 切不到它 ——
    // 按整份 server.js 源码查，并确认它就在这条路由之前（顺序反了会有 TDZ 报错）。
    // ⚠️ 而且它在 **server.js** 里，不在 app.js —— 查错文件时 indexOf 返回 -1，
    // 表现是「找到白名单定义」失败，与「它根本不存在」无法区分。
    const serverCodeOnly = stripComments(serverSource);
    const WL = "WRITABLE_SERVER_FLAGS = new Set(['selfSignedCert'])";
    const wlAt = serverCodeOnly.indexOf(WL);
    assert.ok(wlAt > 0, '在 server.js 里找到白名单定义');
    assert.ok(wlAt < serverCodeOnly.indexOf("app.post('/api/server-flags'"),
        '白名单定义在路由之前（TDZ：路由执行时它必须已初始化）');
    assert.match(postRoute, /if \(!WRITABLE_SERVER_FLAGS\.has\(key\)\)/,
        '不在白名单的一律拒');
    assert.match(postRoute, /typeof value !== 'boolean'/, '类型校验');
    assert.match(postRoute, /requireAdmin/, '写端点要管理员');
    assert.match(postRoute, /server-config\.json/, '落盘到服务配置');
    assert.match(postRoute, /needsReload: true/,
        '告知需重启（内存里那份被 Object.freeze，改它不落盘）');

    // ⑤ UI 存在且真的能写
    assert.match(code, /id="selfSignedCertBox"/, '有那个开关');
    // ⚠️ 不要用固定字符窗口：这段的处理里有 8 行注释，
    // 而 900 字符的窗口在加注释之前刚好够。改用「切到下一个同缩进的收尾」。
    const boxAt = code.indexOf("const selfSignedBox = $('#selfSignedCertBox');");
    assert.ok(boxAt > 0, '找到开关的处理起点');
    const onchange = code.slice(boxAt, code.indexOf('\n        }', boxAt) + 10);
    assert.ok(onchange.length > 400, `切出开关的处理（${onchange.length}）`);
    assert.match(onchange, /onchange = async \(\) =>/, '有 change 处理');
    // ⚠️ 写端点必须与读端点是同一个
    assert.match(onchange, /API\.post\('\/api\/server-flags', \{ selfSignedCert: value \}\)/,
        '写到同一个端点');
    assert.doesNotMatch(onchange, /API\.post\('\/api\/config'/,
        '不得写到 /api/config —— 那是用户公开配置，不含服务级字段');
    assert.match(onchange, /重启本服务后生效/, '提示里说清要重启才生效');
    assert.match(onchange, /this\.selfSignedCert = value;/, '并更新本地状态');
    // ⚠️ 保存失败必须把开关拨回去，否则界面显示的是一个没生效的值
    assert.match(onchange, /catch[\s\S]{0,300}?selfSignedBox\.checked = !value/,
        '保存失败要回滚开关');

    // ⑥ 那个从未被赋值的属性名不得复活。
    // ⚠️ 只查可执行代码（上面已剥好）：注释里正写着它是什么、
    // 以及为什么废弃 —— 不剥的话这条会把自己的说明当成违规代码。
    assert.doesNotMatch(codeOnly, /serverIsSelfSigned/,
        '可执行代码里不得再有 serverIsSelfSigned');

    // ⑦ 部署与升级两条命令都要用它
    const dialog = methodBodyOf(code, 'showDeployDialog');
    assert.ok(dialog.length > 800, `切出 showDeployDialog（${dialog.length}）`);
    const uses = dialog.match(/this\.selfSignedCert === true/g) || [];
    assert.equal(uses.length, 2, `部署与升级各用一次（实际 ${uses.length}）`);
});

test('agent 版本有真实消费者：后台提示「可升级」', () => {
    // 审查发现：服务端把 agentVersion 算出来、probe 回传了，而 public/
    // 里零引用——正是本项目自己的注释所描述的假承诺（「后台据此提示
    // 旧版可升级」，而那个提示不存在）。
    const code = stripComments(appSource);

    // ① 真的比较了版本
    const fn = methodBodyOf(code, 'isAgentOutdated');
    assert.ok(fn.length > 200, `切出 isAgentOutdated（${fn.length}）`);
    assert.match(fn, /s\.agentVersion/, '读目标机版本');
    assert.match(fn, /this\.currentVersion \|\| this\.serverVersion/, '读本服务版本');
    // ⚠️ 必须逐段比数字：字符串比较会让 '1.10.0' < '1.9.0'
    assert.match(fn, /split\('\.'\)\.map\(Number\)/, '按段转数字再比');
    assert.doesNotMatch(fn, /have\s*<\s*want/, '不得直接比字符串');
    // 拿不到就不说 —— 「拿不到就说有新版」会让用户被反复告知可以升级，
    // 而升完还是同一个版本
    for (const guard of ['!have', '!want', "have === 'dev'", "want === 'dev'"]) {
        assert.ok(fn.includes(guard), `${guard} 的守卫还在`);
    }

    // ② 真的有 UI 消费它
    const body = methodBodyOf(code, 'renderServerStateBody');
    assert.match(body, /isAgentOutdated\(s\)/, '说明区会问「是不是旧版」');
    assert.match(body, /server-item-version/, '旧版时渲染版本提示');
    // ⚠️ 「已就绪」原本无条件 return ''，那会把「已就绪但版本旧」一起吞掉
    assert.match(body, /\(state === 'ready' \|\| state === 'unchecked'\) && !outdated/,
        '已就绪但版本旧时仍要显示');

    // ③ agentVersion 从探测结果里读 —— 它不在配置里
    assert.match(code, /const probe = this\.lastProbe\?\.\[raw\.id\];/,
        '读缓存的探测结果');
    assert.match(code, /const s = probe \? \{ \.\.\.raw, \.\.\.probe \} : raw;/,
        '合并探测结果（不改配置对象）');
    assert.doesNotMatch(code, /\bs\.agentVersion\s*=/,
        '不得把探测结果写进配置对象（那是永久状态）');

    // ④ 样式在
    const css = fs.readFileSync(path.join(ROOT, 'public', 'admin.css'), 'utf8');
    assert.match(css, /\.modal \.server-item-version\s*\{/, '版本提示有样式');
});

test('本机详情页与概览行都显示地址', () => {
    // 用户拍板「d 显示」。本机的 url 是 null（它不走 agent 采集），
    // 而它的地址就是用户此刻访问本服务的位置 —— 浏览器自己知道。
    const code = stripComments(moduleSource);
    const panel = /function renderPanelBody\(body, entry, all\) \{[\s\S]*?if \(!entry\.metrics\)/.exec(code);
    assert.ok(panel, '切出 renderPanelBody 到 metrics 判断之前');
    assert.match(panel[0], /entry\.isLocal \? location\.origin : entry\.url/,
        '本机用浏览器所在处');
    assert.match(panel[0], /displayHost\(address\)/, '只显示主机与端口');
    // ⚠️ 必须在 if (!entry.metrics) 之前 —— 离线那台才是最需要地址的
    assert.ok(panel[0].indexOf('isLocal') < panel[0].indexOf('!entry.metrics'),
        '地址渲染在 metrics 判断之前');

    // 概览行也要，且不排除本机
    assert.match(code, /const rowAddress = s\.isLocal \? location\.origin : s\.url;/,
        '概览行里本机也带地址');
    assert.doesNotMatch(code, /if \(s\.url && !s\.isLocal\)/, '不得把本机排除');

    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
    assert.match(css, /\.module-panel-address-host\s*\{/, '地址条有样式');
    assert.match(css, /\.module-panel-list-host\s*\{/, '概览地址有样式');
});

test('服务器列表的按钮高度：桌面 36px 起，窄屏必须抬回 44px', () => {
    // 回归记录：列表曾是一行一台、按钮挤在右侧，实测 26px——低于触摸下限。
    // 那个高度是为「三个按钮挤一行」刻意定的（本轮加的「检测连通性」变成四个），
    // 改成一台一张卡、横向 grid 排多台后，卡内竖排才有空间做达标的目标。
    //
    // 后来按用户要求把桌面端降到 36px（44px 在鼠标操作下占掉整行高度显得笨重，
    // 一台机器约 180px）。**但触摸下限不能一起降**：≤700px 那个分支是
    // 手机与小平板，那里的 36px 就是把目标打回事故值。
    //
    // 所以断言分两半：桌面 ≥36（守住「别退回 26」），窄屏 ≥44（守住触摸下限）。
    const css = fs.readFileSync(path.join(ROOT, 'public', 'admin.css'), 'utf8');
    const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

    const btn = /\.modal \.server-item-actions \.btn\s*\{([^}]*)\}/.exec(css);
    assert.ok(btn, '找到 .server-item-actions .btn 规则');
    const h = Number(/min-height:\s*(\d+)px/.exec(btn[1])?.[1]);
    assert.ok(h >= 36, `桌面端按钮 min-height 应 ≥36px，实际 ${h}px`);
    assert.ok(h < 44, `桌面端应低于触摸下限（否则降高度没意义），实际 ${h}px`);

    const show = /\.modal \.server-item-show\s*\{([^}]*)\}/.exec(css);
    assert.ok(show, '找到 .server-item-show 规则');
    const sh = Number(/min-height:\s*(\d+)px/.exec(show[1])?.[1]);
    assert.ok(sh >= 36, `可见性开关桌面端 min-height 应 ≥36px，实际 ${sh}px`);

    // 窄屏块必须把两者都抬回 44px。
    // 用 mediaBlockOf 而不是手写 brace matching，也不要用固定窗口——
    // 本文件里有多处 @media，取第一个匹配的块会读到不相干的规则。
    const narrowBlock = mediaBlockOf(css, '@media (max-width: 700px)');
    assert.ok(narrowBlock, '存在 max-width: 700px 块');
    for (const sel of ['.modal .server-item-actions .btn', '.modal .server-item-show']) {
        assert.ok(stripComments(narrowBlock).includes(sel),
            `窄屏块里必须重新声明 ${sel}，否则降高度会波及触摸设备`);
    }
    assert.match(stripComments(narrowBlock),
        /\.modal \.server-item-actions \.btn,\s*\.modal \.server-item-show \{ min-height: 44px; \}/,
        '窄屏两者一起抬回 44px');

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
});

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

test('采集方式默认拉取，非法值一律回落而不是被静默接受', () => {
    // 回归风险：把 mode 写成「非 push 即 push」会让一个拼错的字段把机器
    // 静默切成推送——那台机器立刻掉线，而用户不知道自己改了什么。
    const fn = /function normalizeServer\(raw\) \{[\s\S]*?\n\}/.exec(stripComments(serverSource));
    assert.ok(fn, '找到 normalizeServer');
    assert.match(fn[0], /raw\.mode\s*===\s*'push'\s*\?\s*'push'\s*:\s*'pull'/,
        '只有字面量 push 才算推送，其它一律 pull');
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

test('probe 的每个分支都带 hint 与下一步', () => {
    // 前端把提示拼进 toast：`res.hint || ''`。所以**任何**一条没有 hint 的分支，
    // 用户看到的就是「够不着这台机器。」后面什么都没有。
    //
    // 改版把 probe 从「发一次 /metrics」换成「TCP 三态 + 按需拉指标」，
    // 分支换了，所以这条断言要按新分支重新枚举——
    // 旧的「token 解不开早退」那条已不存在，拿旧断言保它绿是没有意义的。
    const code = stripComments(serverSource);
    const start = code.indexOf("app.post('/api/modules/servers/:id/probe'");
    assert.ok(start > 0, '探测端点存在');
    const end = code.indexOf('\napp.', start);
    const route = code.slice(start, end > 0 ? end : code.length);
    assert.ok(route.length > 800, `切出 probe 路由（${route.length}）`);

    // 每条 reply() 都要带 hint。逐条数而不是只数一次——
    // 只数一次的话，新增分支忘了带 hint 照样绿。
    //
    // ⚠️ 这里数的是 reply( 而不是 res.json(：probe 的响应现在经 reply()
    // 走（既回响应又把 deployState 落盘），直接 res.json 的分支不会落盘。
    // 见「探测结论写回配置」那条。
    const branches = route.match(/reply\(\{/g) || [];
    const hints = route.match(/hint:/g) || [];
    assert.ok(branches.length >= 6,
        `probe 至少有 6 条返回分支，实际 ${branches.length}`);
    assert.ok(hints.length >= branches.length,
        `每条分支都要带 hint：返回 ${branches.length} 条、hint ${hints.length} 个`);

    // 三种 TCP 结果各自的下一步措辞必须不同：
    // 「连不上」与「连得上但没装 agent」的处置完全不同，
    // 用同一句话等于把排查工作推回给用户。
    assert.match(route, /deployState: 'not_deployed'[\s\S]{0,400}?端口没人监听/,
        'refused 的分支说清「主机在线但没装 agent」');
    assert.match(route, /deployState: 'offline'[\s\S]{0,300}?检查地址/,
        'timeout 的分支指向网络排查');
    // 已就绪也要有 hint —— 用户点了检测，「正常」同样是一句交代
    assert.match(route, /deployState: 'ready'[\s\S]{0,900}?一切正常|一切正常/,
        '就绪的分支给出确认');
    // 端口冲突是独立状态，且说清该换端口而不是重试
    assert.match(route, /port_conflict[\s\S]{0,400}?端口/,
        '端口冲突说清是端口的问题');
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
    // ⚠️ 解构列表变了：新增 reachable（用户对「能否直接连到它」的回答），
    // 而 url 不再是唯一形态（裸 IP 会被归一化）——
    // 但 reachable 必须在这里解构出来，否则落盘时拿不到，永远是 true。
    assert.match(route, /const \{ id, name, url, token, mode, reachable \} = req\.body/,
        '请求体解构出 mode 与 reachable');
    assert.match(route, /mode: mode === 'push' \? 'push' : 'pull'/,
        '写盘时裁决 mode，且与 normalizeServer 同一套规则');
    assert.match(route, /reachable: reachable === false \? false : true/,
        '写盘时落 reachable——否则界面永远显示「能连」，push 选不上去');
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
    // 回归记录（两次）：函数改名 fetchPeerFingerprint → fetchPeerCert 时漏改导出，
    // require 得到的名字是 undefined，端点真实运行时必然 502。而当时全部测试
    // 都是绿的——它们断言的是**源码形状**（服务端调用了它），不是
    // 「这个导出真的存在」。形状对了、值为 undefined，形状断言无从发现。
    //
    // 所以这条直接取实际导出并逐个断言是函数。名字**从服务端 import 里取**，
    // 不在测试里硬编码一份清单——硬编码的那份迟早与实现漂移，
    // 而漂移的表现是「测试报一个 undefined 的名字」，看不出真正原因。
    const monitor = require(path.join(ROOT, 'lib', 'monitor'));
    // ⚠️ 这里踩过三次坑，逐个说清：
    //   1. import 是**多行**的（四个名字各占一行），单行的 [^}]+ 在换行
    //      风格一变时就落空；
    //   2. 用 [\s\S]*? 往前找 `const {` 而不加「最近的」这个限定，会一路
    //      找到文件最开头的另一个 `const {`，把几十行无关代码当成 import 名单；
    //   3. 即使用 [\s\S]*? 懒惰匹配，它也会越过这个 require，去匹配后面
    //      另一个 `} = ...(` 形状（本项目里就有 `} = consumeRateLimit(...)`）。
    //
    // 可靠的做法：**以 `require('./lib/monitor')` 为唯一锚点，往回取到最近的
    // `const {`**，这样无论 import 写成几行、中间有什么，都不会越界。
    const REQ = "require('./lib/monitor')";
    const reqAt = serverSource.indexOf(REQ);
    assert.ok(reqAt > 0, '服务端确实从 lib/monitor import');
    const openAt = serverSource.lastIndexOf('const {', reqAt);
    assert.ok(openAt > 0, '找到 import 的 const {');
    const closeAt = serverSource.lastIndexOf('}', reqAt);
    assert.ok(closeAt > openAt,
        'import 名单的右括号在 const { 之后（排除匹配到别处的情况）');
    const names = serverSource.slice(openAt + 7, closeAt)
        .split(',').map(s => s.trim()).filter(Boolean);
    assert.ok(names.length >= 2, `解析出 ${names.length} 个 import 名字`);
    for (const name of names) {
        assert.match(name, /^[A-Za-z_$][\w$]*$/, `${name} 是合法标识符`);
        assert.equal(typeof monitor[name], 'function',
            `服务端 import 的 ${name} 在 lib/monitor 里是可调用的导出`);
    }
});

test('两种证书结果分开：未注册 vs 已配对但证书变了', () => {
    // 这两种情况都表现为「拉不到数据」，但一个是「还没注册」，
    // 另一个是安全事件。塌缩成同一句话会让用户照着错误方向排查。
    //
    // ⚠️ 这里的分支名换过一次：早先是 needTrust（人工核对指纹），
    // 那条 TOFU 流程已随一次性令牌注册删除，改为 notEnrolled。
    // 形状断言对改名是敏感的 —— 所以同时钉住「不再有 needTrust」，
    // 否则它悄悄回来也没人发现。
    const code = stripComments(monitorSource);
    // ⚠️ 括号要写进正则（`if (server.certPem)`）：少写就匹配不上，
    // 而表现是「这条断言一直红」而不是「匹配到了别的东西」。
    assert.match(code, /if \(server\.certPem\) \{[\s\S]*?certMismatch: true/,
        '已配对却仍报证书错 → certMismatch（安全事件）');
    assert.match(code, /notEnrolled: true/,
        '未配对 → notEnrolled（如实报告，不伪造指纹）');
    assert.doesNotMatch(code, /needTrust/,
        '旧的人工核对字段已随 TOFU 流程删除，不该回来');
    // 证书错误码要单列，否则会落进 ECONNREFUSED 分支显示成机器离线
    assert.match(code, /SELF_SIGNED_CODES = new Set\(\[[\s\S]*?DEPTH_ZERO_SELF_SIGNED_CERT/,
        '自签证书错误码被显式枚举');
    // ⚠️ 被删掉的函数不得还有调用点——那正是崩进程的 bug（本轮审查发现）
    assert.doesNotMatch(code, /fetchPeerCert/,
        'fetchPeerCert 已删除，不得有残留调用点');
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

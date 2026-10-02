#!/usr/bin/env node
'use strict';

/**
 * Nav Sylph 监控 agent —— 部署在**被监控的目标机**上。
 *
 * 为什么需要它：本服务只能读到运行它自己的那台主机。要读别的机器，
 * 目标机上就得有一个东西去读系统计数器并把结果吐出来。这个 agent 就是那个东西。
 *
 * 跨平台
 * - Linux：读 `/proc/stat`、`/proc/meminfo`、`/proc/loadavg`
 * - macOS：用 `os` 模块 + `vm_stat`（`os.freemem()` 在 macOS 上不代表可用内存）
 * - 其它（BSD 等）：退回 `os` 模块
 *
 * 两种上报方向
 * - 拉取（默认）：起一个 HTTP 服务等本服务来连。适合目标机与本服务同网段或公网可达。
 * - 推送（`--push`）：**不监听任何端口**，只做出站连接把指标送到本服务。
 *   适合目标机在局域网内、本服务在公网——内网机器上一个端口都不用开。
 *
 * 其它特性
 * - 无依赖、无构建步骤，单文件 `node agent.js` 即可运行。
 * - Bearer token 鉴权，token 从环境变量读、**不落盘**。
 * - 拉取模式默认只监听 127.0.0.1；要跨机访问得显式 `--host 0.0.0.0`。
 *
 * 用法
 *   # 拉取模式
 *   NAVSYLPH_TOKEN=<token> node agent.js --port 4195 --host 0.0.0.0
 *   # 推送模式（不监听端口）
 *   NAVSYLPH_PUSH_SECRET=<凭据> NAVSYLPH_SERVER_ID=<id> \
 *     node agent.js --push https://nav.example.com
 *
 * 目标机需要 Node 18+。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');

const VERSION = 1;

// ========== 参数 ==========

function parseArgs(argv) {
    const out = {
        port: 4195,
        host: '127.0.0.1',
        exposeHostname: false,
        push: null,
        pushSecret: null,
        serverId: null,
        // 推送周期。与服务端的白名单一致，避免推送频率超出它的限流桶
        // （20 台 × 6 次/分钟 = 120/min 是它的上限）。
        interval: 15,
        // 推送模式默认**不**监听端口。要同时保留拉取能力时显式加 --port
        serveAlongsidePush: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--port' && argv[i + 1]) {
            out.port = Number(argv[++i]);
            // 显式给了 --port 就是要两个模式都开着
            out.serveAlongsidePush = true;
        } else if (arg === '--host' && argv[i + 1]) out.host = argv[++i];
        else if (arg === '--token' && argv[i + 1]) out.token = argv[++i];
        else if (arg === '--push' && argv[i + 1]) out.push = argv[++i].replace(/\/+$/, '');
        else if (arg === '--push-secret' && argv[i + 1]) out.pushSecret = argv[++i];
        else if (arg === '--server-id' && argv[i + 1]) out.serverId = argv[++i];
        else if (arg === '--interval' && argv[i + 1]) out.interval = Number(argv[++i]);
        // /health 里带主机名。只有确定端口没暴露到不可信网络时才需要。
        else if (arg === '--expose-hostname') out.exposeHostname = true;
        else if (arg === '--help' || arg === '-h') out.help = true;
    }
    return out;
}

/** 推送周期只接受服务端的同一组白名单值，其它回落 15。 */
const PUSH_INTERVALS = [10, 15, 30, 60, 300];
function resolveInterval(value) {
    return PUSH_INTERVALS.includes(value) ? value : 15;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
    console.log('用法（拉取模式，默认）:');
    console.log('  NAVSYLPH_TOKEN=<token> node agent.js [--port 4195] [--host 127.0.0.1] [--expose-hostname]');
    console.log('  --host           监听地址；跨机访问必须显式设 0.0.0.0');
    console.log('  --expose-hostname 让 /health 也返回主机名（默认不返回，避免泄露）');
    console.log('');
    console.log('用法（推送模式，目标机在局域网时用）:');
    console.log('  NAVSYLPH_PUSH_SECRET=<凭据> NAVSYLPH_SERVER_ID=<id> \\');
    console.log('    node agent.js --push <本服务地址> [--interval 15] [--port 4195]');
    console.log('  --push         本服务地址，进入推送模式；**默认不监听任何端口**');
    console.log('  --interval     上报间隔秒数，可选 ' + PUSH_INTERVALS.join('/') + '（默认 15）');
    console.log('  --server-id    目标机在后台的 id（也可用环境变量 NAVSYLPH_SERVER_ID）');
    console.log('  --port         额外同时开启拉取模式（默认不监听）');
    process.exit(0);
}

// 拉取模式的 token：优先环境变量，其次 --token。
// 环境变量更安全：命令行参数会出现在 `ps` 输出与 shell 历史里。
const TOKEN = process.env.NAVSYLPH_TOKEN || args.token;
// 推送凭据与拉取 token 是**两回事**，分环境变量、分参数，互不顶替。
const PUSH_SECRET = process.env.NAVSYLPH_PUSH_SECRET || args.pushSecret;
const SERVER_ID = process.env.NAVSYLPH_SERVER_ID || args.serverId;

const PUSH_MODE = Boolean(args.push);
const SERVE_HTTP = !PUSH_MODE || args.serveAlongsidePush;

if (PUSH_MODE) {
    // 协议白名单与服务端写服务器时那条一致：其它协议（file:、gopher:）
    // 经 fetch 会变成一个可被利用的请求面，而 --push 是用户从命令行传的。
    let pushProtocol = null;
    try {
        pushProtocol = new URL(args.push).protocol;
    } catch {
        console.error(`--push 的地址无法解析：${args.push}`);
        process.exit(1);
    }
    if (pushProtocol !== 'http:' && pushProtocol !== 'https:') {
        console.error('--push 的地址必须以 http:// 或 https:// 开头。');
        process.exit(1);
    }
    if (!PUSH_SECRET) {
        console.error('推送模式缺少凭据。请设置环境变量 NAVSYLPH_PUSH_SECRET，或用 --push-secret 传入。');
        process.exit(1);
    }
    if (!SERVER_ID) {
        console.error('推送模式缺少 server id。请设置环境变量 NAVSYLPH_SERVER_ID，或用 --server-id 传入。');
        process.exit(1);
    }
} else if (!TOKEN) {
    console.error('缺少 token。请设置环境变量 NAVSYLPH_TOKEN，或用 --token 传入。');
    process.exit(1);
}

// ========== 采集 ==========

/** 读 /proc/stat 第一行，返回各状态的累计 tick 数。 */
function readProcStat() {
    const raw = fs.readFileSync('/proc/stat', 'utf8');
    const line = raw.split('\n').find(l => l.startsWith('cpu '));
    if (!line) return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal
    return {
        user: parts[0] || 0,
        nice: parts[1] || 0,
        system: parts[2] || 0,
        idle: parts[3] || 0,
        iowait: parts[4] || 0,
        total: parts.reduce((a, b) => a + b, 0)
    };
}

/** 读 /proc/meminfo，取 kB 为单位的值。 */
function readMemInfo() {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const field = name => {
        const m = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(raw);
        return m ? Number(m[1]) * 1024 : 0;
    };
    const total = field('MemTotal');
    const available = field('MemAvailable') || field('MemFree');
    return { total, used: Math.max(0, total - available) };
}

/**
 * macOS 内存。用 `vm_stat` 而不是 `os.freemem()`。
 *
 * `os.freemem()` 在 macOS 上返回的是**未被列为可用**的页，而 macOS 会把
 * 大部分内存拿去做文件缓存——实测 16GB 机器上 `totalmem - freemem`
 * 达到 98.6%，显示成「内存 99%」，看起来像要爆，实际完全正常。
 * 那个数衡量的是「缓存占用」，不是「应用占用」。
 *
 * 可用内存 = free + inactive + speculative + purgeable（页大小 × 各计数）。
 * 其中 inactive 是可回收的缓存，算作可用才是用户视角的「还有多少能用」。
 */
function readDarwinMemory() {
    // 页大小用 sysctl 取（不是读文件——'/sysctl -n hw.pagesize' 不是路径）
    const page = Number(require('child_process')
        .execSync('sysctl -n hw.pagesize', { encoding: 'utf8' }).trim()) || 4096;
    const vm = require('child_process').execSync('vm_stat', { encoding: 'utf8' });

    const value = label => {
        const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(vm);
        return m ? Number(m[1]) : 0;
    };

    const total = os.totalmem();
    // vm_stat 的计数单位是页，乘以页大小得到字节
    const free = value('Pages free') * page;
    const inactive = value('Pages inactive') * page;
    const speculative = value('Pages speculative') * page;
    const purgeable = value('Pages purgeable') * page;

    const available = Math.max(0, free + inactive + speculative + purgeable);
    // 「已用」= 总内存 − 可用。与 Linux 的口径一致（那里是 total − MemAvailable）。
    const used = Math.max(0, Math.min(total, total - available));
    return { total, used, available };
}

/** 按平台选内存实现。 */
function readMemory() {
    if (HAS_PROC) return readMemInfo();
    if (process.platform === 'darwin') {
        try {
            return readDarwinMemory();
        } catch (e) {
            // vm_stat 读不到（容器里、精简系统上）时退回 os 模块，
            // 数值口径会粗一些，但不至于整个 agent 起不来
            console.error('读取 vm_stat 失败，退回 os.freemem():', e.message);
        }
    }
    const total = os.totalmem();
    return { total, used: total - os.freemem(), available: os.freemem() };
}

function readLoadAvg() {
    try {
        const raw = fs.readFileSync('/proc/loadavg', 'utf8');
        const parts = raw.split(/\s+/);
        return [Number(parts[0]) || 0, Number(parts[1]) || 0];
    } catch {
        return [0, 0];
    }
}

/**
 * /proc 只在 Linux 上有。缺文件时回落到 os 模块的对应值——
 * agent 可能被拿去做 macOS/BSD 的自测，那时不该整个起不来。
 *
 * 两条采集路径必须返回**同一种形状**：一个聚合对象（不是按核的数组）。
 * 早先回落路径返回数组，于是 collect() 里 `current.total - previousCpu.total`
 * 变成「数组减数字」= NaN，totalDelta > 0 不成立，cpu 恒为 null——
 * 而返回值仍是合法的 JSON，看不出出错，只是一直没有 CPU 数据。
 */
const HAS_PROC = fs.existsSync('/proc/stat');

/** os.cpus() 聚合成一个与 /proc/stat 同形状的对象。 */
function readOsCpuTotal() {
    let user = 0, nice = 0, system = 0, idle = 0, irq = 0;
    for (const c of os.cpus()) {
        const t = c.times;
        user += t.user; nice += t.nice; system += t.sys;
        idle += t.idle; irq += t.irq;
    }
    // iowait 在 os 模块里没有，置 0；它计入 idle，对 CPU 百分比的影响可忽略
    return { user, nice, system, idle, iowait: 0, total: user + nice + system + idle + irq };
}

const readCpuTotal = HAS_PROC ? readProcStat : readOsCpuTotal;

let previousCpu = readCpuTotal();

/** 采一份。Linux 读 /proc，其余平台读 os 模块。 */
async function collect() {
    // CPU 必须两次采样做差——单次读没有百分比
    previousCpu = readCpuTotal();
    await new Promise(r => setTimeout(r, 200));
    const current = readCpuTotal();

    let cpu = null;
    if (previousCpu && current) {
        const totalDelta = current.total - previousCpu.total;
        const idleDelta = (current.idle - previousCpu.idle) + (current.iowait - previousCpu.iowait);
        if (totalDelta > 0) {
            cpu = Math.min(1, Math.max(0, 1 - idleDelta / totalDelta));
        }
    }

    const mem = readMemory();
    const load = HAS_PROC ? readLoadAvg() : os.loadavg().slice(0, 2);

    return {
        version: VERSION,
        cpu,
        memoryUsed: mem.used,
        memoryTotal: mem.total,
        memoryPercent: mem.total > 0 ? mem.used / mem.total : 0,
        load1: load[0],
        load5: load[1],
        uptime: os.uptime(),
        cores: os.cpus().length,
        hostname: os.hostname(),
        platform: process.platform,
        sampledAt: Date.now()
    };
}

// ========== HTTP ==========

/**
 * 定长比较，避免 token 逐字符比较时的时间差泄露前缀。
 * token 长度有限，攻击收益极低，但这是唯一一处该这么做的地方。
 */
function tokenMatches(provided) {
    if (typeof provided !== 'string') return false;
    if (!TOKEN) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(TOKEN);
    // 先比长度会立刻暴露长度——对随机 token 来说长度不是秘密，
    // 但既然要防时序泄露，就不该在这里开一个口子。
    if (a.length !== b.length) return false;
    return require('crypto').timingSafeEqual(a, b);
}

// ========== 推送 ==========

/** 退避上限（毫秒）。 */
const PUSH_BACKOFF_MAX_MS = 300000;
/** 单次上报的超时。太长会占住整个周期。 */
const PUSH_TIMEOUT_MS = 8000;

/**
 * 把一份指标送到本服务。
 *
 * 返回 true 表示成功。失败一律返回 false 而不抛错——推送是后台循环，
 * 一次失败不该让 agent 退出。
 */
async function pushOnce(metrics) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    try {
        const res = await fetch(`${args.push}/api/modules/agent-push`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${PUSH_SECRET}`
            },
            body: JSON.stringify({ serverId: SERVER_ID, metrics })
        });
        if (res.ok) {
            return { ok: true };
        }
        // 401/409 是配置问题，重试多少次都一样——照样报出来，
        // 但退避要封顶，否则日志会被刷爆
        let detail = `HTTP ${res.status}`;
        try {
            const body = await res.json();
            if (body && body.error) detail = body.error;
        } catch {
            // 响应不是 JSON，用状态码即可
        }
        return { ok: false, error: detail, fatal: res.status === 401 || res.status === 409 };
    } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 推送循环。失败时指数退避，上限 5 分钟。
 *
 * 退避是必须的：本服务在 429 时已经在限流，无脑按原周期重试只会让
 * 情况更糟，并可能把它的限流桶彻底耗光。
 */
function startPushing() {
    const intervalMs = resolveInterval(args.interval) * 1000;
    let backoff = 0;
    let stopped = false;

    console.log(`  推送目标 ${args.push}/api/modules/agent-push`);
    console.log(`  上报间隔 ${intervalMs / 1000}s`);
    console.log(`  server id ${SERVER_ID}`);
    if (!SERVE_HTTP) {
        console.log('  未监听任何端口（推送模式默认不开放端口）');
    }

    const tick = async () => {
        if (stopped) return;
        try {
            const metrics = await collect();
            const result = await pushOnce(metrics);
            if (result.ok) {
                if (backoff > 0) console.log(`[push] 恢复上报（退避 ${Math.round(backoff / 1000)}s）`);
                backoff = 0;
            } else {
                if (backoff === 0) console.error(`[push] 上报失败：${result.error}`);
                else console.error(`[push] 仍失败：${result.error}`);
                // 配置类失败（401/409）封顶到 5 分钟：重试解决不了，
                // 但也不能就此停掉——用户改完配置重启前，agent 得自己活着
                backoff = Math.min(PUSH_BACKOFF_MAX_MS, backoff === 0 ? 5000 : backoff * 2);
            }
        } catch (err) {
            console.error('[push] 采集失败:', err && err.message ? err.message : err);
            backoff = Math.min(PUSH_BACKOFF_MAX_MS, backoff === 0 ? 5000 : backoff * 2);
        }
        if (!stopped) {
            setTimeout(tick, backoff > 0 ? backoff : intervalMs);
        }
    };

    tick();

    // 停止推送（测试与优雅退出用）。定时器本身不阻止进程退出。
    return () => { stopped = true; };
}

// ========== 启动 ==========

if (SERVE_HTTP) {
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            // /health 不需要鉴权（方便「agent 起来了吗」这类探测），所以**不能**返回
            // 主机名：它会跟着其它信息一起泄露这台机器叫什么、内网里怎么称呼它。
            // 早先这里返回 hostname，等于给每个能扫到该端口的人一份免费的资产清单。
            // 需要主机名的人自己看 /metrics（那里要鉴权）。
            const payload = { status: 'ok', version: VERSION };
            if (args.exposeHostname) payload.hostname = os.hostname();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
            return;
        }

        if (req.method !== 'GET' || req.url !== '/metrics') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
            return;
        }

        const auth = req.headers.authorization || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!tokenMatches(provided)) {
            // 不回显 token 的一部分——401 里带上任何提示都会帮攻击者
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }

        collect().then(metrics => {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify(metrics));
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err && err.message || err) }));
        });
    });

    server.listen(args.port, args.host, () => {
        console.log(`  监听 ${args.host}:${args.port}`);
        if (args.host === '127.0.0.1') {
            console.log('  提示：只监听本机，跨机访问需 --host 0.0.0.0');
        }
    });
}

if (PUSH_MODE) {
    startPushing();
}

console.log(`Nav Sylph agent v${VERSION}`);
console.log(`  主机名 ${os.hostname()}`);
if (SERVE_HTTP) {
    console.log(`  端点 /metrics（Bearer 鉴权）、/health（无需鉴权）`);
}

module.exports = {
    readProcStat, readMemInfo, readLoadAvg, collect, tokenMatches,
    parseArgs, resolveInterval, pushOnce, PUSH_INTERVALS, VERSION
};
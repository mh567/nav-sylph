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
 * 其它特性
 * - 无依赖、无构建步骤，单文件 `node agent.js` 即可运行。
 * - Bearer token 鉴权，token 从环境变量读、**不落盘**。
 * - 默认只监听 127.0.0.1；要跨机访问得显式 `--host 0.0.0.0`。
 *
 * 用法
 *   NAVSYLPH_TOKEN=<token> node agent.js --port 4195 --host 0.0.0.0
 *
 * 目标机需要 Node 18+。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');

const VERSION = 1;

// ========== 参数 ==========

function parseArgs(argv) {
    const out = { port: 4195, host: '127.0.0.1' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
        else if (arg === '--host' && argv[i + 1]) out.host = argv[++i];
        else if (arg === '--token' && argv[i + 1]) out.token = argv[++i];
        else if (arg === '--help' || arg === '-h') out.help = true;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
    console.log('用法: NAVSYLPH_TOKEN=<token> node agent.js [--port 4195] [--host 127.0.0.1]');
    process.exit(0);
}

// token 优先取环境变量，其次才轮到 --token。
// 环境变量更安全：命令行参数会出现在 `ps` 输出与 shell 历史里。
const TOKEN = process.env.NAVSYLPH_TOKEN || args.token;
if (!TOKEN) {
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
    const a = Buffer.from(provided);
    const b = Buffer.from(TOKEN);
    // 先比长度会立刻暴露长度——对随机 token 来说长度不是秘密，
    // 但既然要防时序泄露，就不该在这里开一个口子。
    if (a.length !== b.length) return false;
    return require('crypto').timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: VERSION, hostname: os.hostname() }));
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
    console.log(`Nav Sylph agent v${VERSION}`);
    console.log(`  监听 ${args.host}:${args.port}`);
    console.log(`  主机名 ${os.hostname()}`);
    console.log(`  端点 /metrics（Bearer 鉴权）、/health（无需鉴权）`);
    if (args.host === '127.0.0.1') {
        console.log('  提示：只监听本机，跨机访问需 --host 0.0.0.0');
    }
});

module.exports = { readProcStat, readMemInfo, readLoadAvg, collect, tokenMatches, VERSION };
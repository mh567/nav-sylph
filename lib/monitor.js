'use strict';

/**
 * 服务器监控的本机采集。
 *
 * 只读 `os` 模块，不需要 API key 或任何第三方——这使服务器监控成为第一个
 * 可以端到端跑通的模块，其余四个模块都可以照它的形状复制。
 *
 * CPU 用累计时间差分：os.cpus() 给的是自开机以来的累计值，单次读没有百分比，
 * 必须两次采样之间做差。所以这里不是纯函数——见 sampleCpu。
 */

const os = require('os');
const { execSync } = require('child_process');

/** 两次 CPU 采样之间的间隔。200ms 是本机开销与响应速度的折中。 */
const CPU_SAMPLE_GAP_MS = 200;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function readCpuTimes() {
    return os.cpus().map(cpu => ({ ...cpu.times }));
}

/**
 * 把两次采样之间的累计时间差算成忙碌比例。
 * @returns {number} 0..1；没有可比的采样时返回 null（而不是假装 0）。
 */
function diffCpuTimes(prev, current) {
    let idleDelta = 0;
    let totalDelta = 0;

    for (let i = 0; i < current.length; i++) {
        const now = current[i];
        const before = prev[i];
        if (!before) continue;
        const idle = now.idle - before.idle;
        const total = (now.user - before.user)
            + (now.nice - before.nice)
            + (now.sys - before.sys)
            + idle
            + (now.irq - before.irq);
        if (total <= 0) continue;
        idleDelta += idle;
        totalDelta += total;
    }

    if (totalDelta <= 0) return null;
    return Math.min(1, Math.max(0, 1 - idleDelta / totalDelta));
}

/**
 * 采一份本机指标。CPU 需要两次采样，因此本函数异步且要等约 200ms。
 *
 * @returns {Promise<{cpu:number|null, memoryUsed:number, memoryTotal:number,
 *   memoryPercent:number, load1:number, load5:number, uptime:number,
 *   cores:number, sampledAt:number}>}
 *   cpu 为 null 表示两次采样间隔过短、没有可比的差值；前端据此显示「采样中」
 *   而不是显示 0%——后者会被读成「服务器完全空闲」，是一个错误结论。
 */
async function sampleCpu() {
    const before = readCpuTimes();
    await delay(CPU_SAMPLE_GAP_MS);
    const after = readCpuTimes();
    return diffCpuTimes(before, after);
}

/**
 * 本机内存。macOS 上**不能用 `os.freemem()`**——
 * 它返回未被列为可用的页，而 macOS 把大部分内存拿去做文件缓存，
 * 实测 16GB 机器上 `totalmem - freemem` 达 98.6%，显示成「内存 99%」，
 * 看着像要爆，实际完全正常。那个数衡量的是缓存占用，不是应用占用。
 *
 * 与 agent/agent.js 的口径保持一致：可用 = free + inactive + speculative + purgeable。
 */
function readLocalMemory() {
    if (process.platform !== 'darwin') {
        const total = os.totalmem();
        const available = os.freemem();
        return { total, used: total - available, available };
    }
    try {
        const page = Number(execSync('sysctl -n hw.pagesize', { encoding: 'utf8' }).trim()) || 4096;
        const vm = execSync('vm_stat', { encoding: 'utf8' });
        const value = label => {
            const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(vm);
            return m ? Number(m[1]) * page : 0;
        };
        const total = os.totalmem();
        const available = value('Pages free') + value('Pages inactive')
            + value('Pages speculative') + value('Pages purgeable');
        return { total, used: Math.max(0, Math.min(total, total - available)), available };
    } catch (e) {
        // 容器 / 精简系统上 vm_stat 可能读不到。退回 os.freemem()——
        // 数值口径粗一些，但不至于整个监控不可用
        const total = os.totalmem();
        return { total, used: total - os.freemem(), available: os.freemem() };
    }
}

/**
 * 采一份完整的本机指标。
 */
async function readLocalMetrics() {
    const mem = readLocalMemory();
    const load = os.loadavg();

    return {
        cpu: await sampleCpu(),
        memoryUsed: mem.used,
        memoryTotal: mem.total,
        memoryPercent: mem.total > 0 ? mem.used / mem.total : 0,
        load1: load[0],
        load5: load[1],
        uptime: os.uptime(),
        cores: os.cpus().length,
        sampledAt: Date.now()
    };
}

// ========== 远端采集 ==========

/** 单台目标机的拉取超时。太长会拖住整个轮询周期。 */
const REMOTE_TIMEOUT_MS = 5000;

/**
 * 拉一台目标机的指标。
 *
 * 失败返回 `{ok:false, error}` 而不是抛错：一台离线不该让整轮采集失败，
 * 首页要显示「离线」而不是把全部服务器一起清空。
 *
 * @param {{url:string, token?:string}} server 已解密出 token 的目标机
 */
async function fetchRemoteMetrics(server) {
    const started = Date.now();
    try {
        const url = server.url.replace(/\/+$/, '') + '/metrics';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url, {
                signal: controller.signal,
                headers: server.token ? { Authorization: `Bearer ${server.token}` } : {},
                cache: 'no-store'
            });
        } finally {
            clearTimeout(timer);
        }

        if (res.status === 401) {
            return { ok: false, error: '凭据被拒绝（token 不匹配）', authFailed: true };
        }
        if (!res.ok) {
            return { ok: false, error: `HTTP ${res.status}` };
        }

        const payload = await res.json();
        // agent 的 version 字段用于将来协议演进：不认识就报清楚，
        // 而不是把不认识的字段当成 0 读进去——那样会显示「CPU 0%」这种错误结论。
        if (payload && payload.version !== undefined && payload.version !== AGENT_PROTOCOL_VERSION) {
            return { ok: false, error: `agent 协议版本 ${payload.version} 与服务端 ${AGENT_PROTOCOL_VERSION} 不一致` };
        }
        if (!payload || typeof payload.memoryPercent !== 'number') {
            return { ok: false, error: '返回格式不可识别' };
        }

        return { ok: true, metrics: payload, latencyMs: Date.now() - started };
    } catch (err) {
        let msg;
        if (err && err.name === 'AbortError') {
            msg = '连接超时';
        } else if (err && (err.code === 'ECONNREFUSED' || /fetch failed/.test(err.message || ''))) {
            // "fetch failed" 是 undici 对多种网络错误的统一包装，
            // 直接透出这行英文对用户毫无意义
            msg = '无法连接（地址不通或服务未启动）';
        } else {
            msg = (err && err.message) || '连接失败';
        }
        return { ok: false, error: msg };
    }
}

/** 与 agent/agent.js 的 VERSION 保持一致。不一致时报错而不是猜。 */
const AGENT_PROTOCOL_VERSION = 1;

// 只导出真正被外部消费的。diffCpuTimes / sampleCpu / 两个常量是本文件的
// 内部实现，导出它们没有消费者——上一轮刚把同类问题从 session 收回，这里不重犯。
module.exports = { readLocalMetrics, fetchRemoteMetrics, AGENT_PROTOCOL_VERSION };
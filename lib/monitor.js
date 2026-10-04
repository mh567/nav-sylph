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
const https = require('https');
const net = require('net');
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
 * 证书错误码单列。落进下面的 ECONNREFUSED 分支会把「证书不受信任」
 * 显示成「无法连接（地址不通或服务未启动）」——一个安全问题长得和一个
 * 网络问题一模一样，用户会去查防火墙而查不到根因。
 */
const SELF_SIGNED_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
]);

/**
 * 剥出 TLS 错误码。
 *
 * ⚠️ 必须读 `err.cause.code` 而不是 `err.code`：这是 undici 的包装行为，
 * 但本文件现在用 `node:https`，错误直接来自 TLS 栈，`err.code` 就有值。
 * 两边都读，因为调用方可能包过一层。
 */
function tlsErrorCode(err) {
    return (err && (err.code || (err.cause && err.cause.code))) || '';
}

/**
 * 拉一台目标机的指标。
 *
 * 失败返回 `{ok:false, error}` 而不是抛错：一台离线不该让整轮采集失败，
 * 首页要显示「离线」而不是把全部服务器一起清空。
 *
 * **只用 https**：token 是那台机器的只读监控凭据，明文传输等于把它公开。
 * http 的地址在这里直接被拒，而不是发出请求再报错。
 *
 * 用 `node:https` 而非全局 `fetch`：内置 fetch 不接受 dispatcher 选项，
 * 而验自签证书需要传 `ca`。实测（Node 22）：`checkServerIdentity`
 * 在证书链无效时**根本不会被调用**——OpenSSL 先抛 DEPTH_ZERO_SELF_SIGNED_CERT。
 * 所以「自定义一个按指纹比对」的方案不可行，唯一可行的是把该机器的
 * 证书 PEM 作为可信锚点传进 `ca`。实测 `ca: <该证书自身>` → authorized:true。
 *
 * @param {{url:string, token?:string, certPem?:string}} server 已解密出 token 的目标机
 *        certPem 是用户在后台确认过的自签证书（TOFU 配对时存下）
 * @returns {Promise<{ok:boolean, error?:string, authFailed?:boolean,
 *   needTrust?:boolean, fingerprint?:string, metrics?:object, latencyMs?:number}>}
 */
async function fetchRemoteMetrics(server) {
    const started = Date.now();
    const url = server.url.replace(/\/+$/, '') + '/metrics';

    // 明文直接拒，不发请求
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, error: '地址格式不正确' };
    }
    if (parsed.protocol !== 'https:') {
        return { ok: false, error: '未加密传输已停用：这台机器需改用 https 重新配置', insecure: true };
    }

    try {
        const res = await httpsRequest(url, {
            headers: server.token ? { Authorization: `Bearer ${server.token}` } : {},
            ca: server.certPem || undefined
        });

        if (res.status === 401) {
            return { ok: false, error: '凭据被拒绝（token 不匹配）', authFailed: true };
        }
        if (res.status !== 200) {
            return { ok: false, error: `HTTP ${res.status}` };
        }

        let payload;
        try {
            payload = JSON.parse(res.body);
        } catch {
            return { ok: false, error: '返回格式不可识别' };
        }
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
        const code = tlsErrorCode(err);
        if (SELF_SIGNED_CODES.has(code)) {
            // 配对过（config 里有 certPem）却仍报证书错 = 证书被换过了。
            // 这是安全事件，单独标出来，界面据此显示「证书异常」。
            if (server.certPem) {
                return { ok: false, error: '证书与已确认的不一致（该机器的证书可能已被更换）', certMismatch: true };
            }
            // 没配对过 = 这台机器的证书我们还不认识。
            //
            // ⚠️ 这里**不能**去抓对端证书来给用户核对指纹：那条 TOFU 流程
            // （trust-cert 端点 + 指纹确认框）已随一次性令牌注册一起删除，
            // 而支撑它的 fetchPeerCert 也一并删了。上一轮忘了改这个调用点，
            // 于是「agent 在跑但注册没成功」（pending 态、certPem 为空、
            // 证书是自签）会走到这里并抛 ReferenceError —— 异常不在任何
            // try 包装里，直接杀掉整个进程，首页所有机器一起消失。
            // （本轮代码审查发现，实测可复现。）
            //
            // 所以这里只如实报告「证书不受信任且我们还没有它的证书」，
            // 让界面显示为「等待部署」——那正是它的状态。
            return {
                ok: false,
                error: '证书未受信任：该机器尚未向本服务注册',
                notEnrolled: true
            };
        }
        if (err && err.name === 'TimeoutError') {
            return { ok: false, error: '连接超时' };
        }
        if (code === 'ECONNREFUSED') {
            return { ok: false, error: '无法连接（地址不通或服务未启动）' };
        }
        return { ok: false, error: (err && err.message) || '连接失败' };
    }
}

/**
 * 一次 https 请求，带超时。解析为 `{status, body}`。
 * 只在成功握手后才有 socket，所以 TLS 错误由调用方的 catch 处理。
 */
function httpsRequest(url, { headers = {}, ca } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'GET',
            headers,
            ca,
            timeout: REMOTE_TIMEOUT_MS
        }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                body += chunk;
                // 目标机是自己部署的 agent，但仍然设上限：一份无界的响应
                // 能把服务端的内存吃光，而这里没有任何理由收到超过 64KB 的指标
                if (body.length > 64 * 1024) {
                    req.destroy(new Error('响应体过大'));
                }
            });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => {
            const err = new Error('连接超时');
            err.name = 'TimeoutError';
            req.destroy(err);
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * TCP 三态探测——「在线 / 未部署」得以成立的前提。
 *
 * 为什么不用 ping：
 *   · Node 做不了 ICMP（要 root 或引原生依赖）
 *   · ping 通了也证明不了 agent 装没装，而那正是用户要问的
 *   · 各平台的 ping 参数语义不同（macOS 的 -W 是毫秒、Linux 是秒）
 *
 * 三态各自对应用户的下一步动作：
 *   refused → 主机**活着**，但 4195 没人监听 → 该点「部署」
 *   open    → 有服务在监听 → 接着确认那是不是我们的 agent
 *   timeout → 路不通 → 该查网络/地址
 * 把 refused 与 timeout 分开是这次改版的核心：上一版两者都显示「离线」，
 * 用户因此无法判断「是没装」还是「够不着」。
 *
 * @returns {Promise<{state:'open'|'refused'|'timeout'|'error', detail:string}>}
 */
function probeTcp(host, port, timeoutMs = 3000) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let settled = false;
        const done = (state, detail) => {
            if (settled) return;
            settled = true;
            socket.removeAllListeners();
            socket.destroy();
            resolve({ state, detail });
        };
        socket.setTimeout(timeoutMs, () => done('timeout', '连接超时'));
        socket.once('error', err => {
            const code = err && err.code;
            if (code === 'ECONNREFUSED') {
                // RST：主机收到了连接请求并明确拒绝——它在线，只是没人监听
                done('refused', '连接被拒绝：主机在线，但端口上没人监听');
            } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
                done('timeout', '网络不可达');
            } else {
                done('error', (err && err.message) || '连接出错');
            }
        });
        // ⚠️ 这里**不要**试图用「connect 后等一会儿看对端是否断开」来加固。
        //
        // 实测（macOS，办公网/VPN 环境）：连接一个完全不可达的公网地址
        // （198.51.100.1:4195，同地址 curl 报 HTTP 000）时 net.Socket 仍会
        // 触发 'connect'——中间有透明代理接管了 TCP，而且它**保持连接**，
        // 不会在握手后立刻断开。所以「等 250ms 看对端关不关」这个加固
        // 实测无效（试过，又删了）：它只让每次探测多花 250ms。
        //
        // 真正挡住这种情况的是**第二道防线** probeAgentHealth：
        // TCP 连上只说明「有人应答」，而它会再去问「你自报家门是不是 agent」。
        // 代理接得下 TCP 却答不出 /health 的形状，于是被判成 port_conflict
        // ——那是准确的结论（那个端口上确实没有我们的 agent）。
        //
        // ⚠️ 因此本函数返回 'open' 的准确含义是「有人应答 TCP」，
        // **不是**「agent 在跑」。调用方必须走 probeAgentHealth 确认。
        socket.once('connect', () => done('open', '有人应答 TCP'));
        socket.connect(port, host);
    });
}

/**
 * 确认监听端口的确实是我们的 agent，而不是别的程序占了 4195。
 *
 * 刻意**不校验证书**：这个探测要回答的是「对面自报家门是不是 agent」，
 * 而证书此刻还没被信任（还没注册）。真正的信任由 enroll 流程建立。
 * 所以这里只要求返回体形状对得上。
 */
async function probeAgentHealth(url, timeoutMs = 4000) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, reason: '地址格式不正确' };
    }
    if (parsed.protocol !== 'https:') {
        return { ok: false, reason: '需要 https' };
    }
    try {
        return await new Promise(resolve => {
            const req = https.request({
                host: parsed.hostname,
                port: parsed.port || 443,
                path: '/health',
                method: 'GET',
                rejectUnauthorized: false,
                timeout: timeoutMs,
                headers: { 'Accept': 'application/json' }
            }, res => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', c => {
                    body += c;
                    if (body.length > 8192) req.destroy();
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        return resolve({ ok: false, reason: `HTTP ${res.statusCode}` });
                    }
                    try {
                        const payload = JSON.parse(body);
                        if (payload && payload.status === 'ok' && payload.version === AGENT_PROTOCOL_VERSION) {
                            return resolve({ ok: true, hostname: payload.hostname || null });
                        }
                        return resolve({
                            ok: false,
                            reason: payload && payload.status === 'ok'
                                ? `agent 协议版本 ${payload.version} 与服务端 ${AGENT_PROTOCOL_VERSION} 不一致`
                                : '返回的不是 agent 的健康响应'
                        });
                    } catch {
                        resolve({ ok: false, reason: '返回格式不可识别' });
                    }
                });
            });
            req.on('timeout', () => {
                const e = new Error('连接超时');
                e.name = 'TimeoutError';
                req.destroy(e);
            });
            req.on('error', err => {
                resolve({ ok: false, reason: (err && err.message) || '连接失败' });
            });
            req.end();
        });
    } catch (err) {
        return { ok: false, reason: (err && err.message) || '连接失败' };
    }
}

/** 与 agent 的 VERSION 保持一致。不一致时报错而不是猜。 */
const AGENT_PROTOCOL_VERSION = 1;

// 只导出真正被外部消费的。diffCpuTimes / sampleCpu / 两个常量是本文件的
// 内部实现，导出它们没有消费者——上一轮刚把同类问题从 session 收回，这里不重犯。
//
// ⚠️ 导出名要与定义名逐字一致：上一轮函数从 fetchPeerFingerprint 改成
// fetchPeerCert 时漏改这里，require 得到的是 undefined，配对端点在真实运行时
// 必然 502 ——而单元测试全绿，因为它们断言的是源码形状，
// 不是「这个导出真的存在」。所以 tests 里有针对实际导出值的断言。
module.exports = {
    readLocalMetrics, fetchRemoteMetrics,
    probeTcp, probeAgentHealth,
    AGENT_PROTOCOL_VERSION
};
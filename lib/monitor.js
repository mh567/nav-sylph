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
const tls = require('tls');
const net = require('net');
const { createHash } = require('crypto');
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
            // 还没配对过 → 交出指纹让用户核对；配对过仍报错 → 证书被换过了。
            // 两者必须分开：一个是「还没做这一步」，一个是「有人动了证书」。
            if (server.certPem) {
                return { ok: false, error: '证书与已确认的不一致（该机器的证书可能已被更换）', certMismatch: true };
            }
            const peer = await fetchPeerCert(parsed);
            return {
                ok: false,
                error: '证书未受信任，需在后台「检测连通性」中确认指纹',
                needTrust: true,
                fingerprint: peer.fingerprint
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
 * 抓目标机的证书，返回 `{fingerprint, pem}`。
 *
 * 一次握手同时取两样东西——分成两次连接会留下一个窗口：
 * 算指纹的那次和取 PEM 的那次之间，证书可能已经换了。
 *
 * 这是 TOFU（首次使用即信任）的「首次」：不校验证书真实性，只把
 * **对方出示的那张证书**取出来。真正的信任决定由用户在界面上做——
 * 而 agent 生成证书时把指纹印在目标机终端上，用户有独立的渠道核对。
 *
 * 抓不到就返回 `{fingerprint:null, pem:null}`（而不是抛错）：拿不到证书
 * 不该把「无法连接」覆盖成另一条错误，用户看到的应该是真正的网络问题。
 */
function fetchPeerCert(parsed) {
    return new Promise(resolve => {
        const EMPTY = { fingerprint: null, pem: null };
        let socket;
        try {
            socket = tls.connect({
                host: parsed.hostname,
                port: parsed.port || 443,
                // SNI 只对域名有意义。给 IP 设 servername 会触发 Node 的
                // DEP0123 弃用警告（RFC 6066 不允许 IP 作 SNI），而且
                // 未来的 Node 会直接忽略它——所以这里按是否为 IP 决定。
                servername: net.isIP(parsed.hostname) ? undefined : parsed.hostname,
                rejectUnauthorized: false
            });
        } catch {
            return resolve(EMPTY);
        }
        const done = value => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(REMOTE_TIMEOUT_MS, () => done(EMPTY));
        socket.once('error', () => done(EMPTY));
        socket.once('secureConnect', () => {
            try {
                const cert = socket.getPeerCertificate();
                if (!cert || !cert.raw) return done(EMPTY);
                done({
                    fingerprint: createHash('sha256').update(cert.raw)
                        .digest('hex').toUpperCase().match(/.{2}/g).join(':'),
                    pem: pemFromDer(cert.raw)
                });
            } catch {
                done(EMPTY);
            }
        });
    });
}

/** DER → PEM。Node 没有内建的 DER→PEM 转换，只能自己包一层 base64。 */
function pemFromDer(der) {
    const b64 = Buffer.from(der).toString('base64');
    const lines = b64.match(/.{1,64}/g).join('\n');
    return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

/** 与 agent/agent.js 的 VERSION 保持一致。不一致时报错而不是猜。 */
const AGENT_PROTOCOL_VERSION = 1;

// 只导出真正被外部消费的。diffCpuTimes / sampleCpu / 两个常量是本文件的
// 内部实现，导出它们没有消费者——上一轮刚把同类问题从 session 收回，这里不重犯。
//
// ⚠️ 导出名要与定义名逐字一致：函数从 fetchPeerFingerprint 改成
// fetchPeerCert（一次握手同时取指纹与 PEM）时漏改这里，require 得到的
// 是 undefined，配对端点在真实运行时必然 502 ——而单元测试全绿，
// 因为它们断言的是源码形状，不是「这个导出真的存在」。
module.exports = {
    readLocalMetrics, fetchRemoteMetrics, fetchPeerCert,
    AGENT_PROTOCOL_VERSION
};
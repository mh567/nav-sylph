'use strict';

/**
 * 管理员写操作的**进程内单锁**。
 *
 * 为什么只有一把锁：恢复备份会同时改写收藏、`.modules.json`、时间线与备忘录，
 * 而这几条写路径之间没有任何一致性协议（各自有 revision，但跨文件不是一个事务）。
 * 「不受影响域的写也一并拒掉」是本轮的**拍定**选择：多域锁要么漏一处、要么让人
 * 以为「没被锁的那部分还能写」，两种情况都会把半套状态写到盘上。单锁 + 503 +
 * `Retry-After` 是唯一一套能被测试证明「恢复期间没有第二个写者」的语义。
 *
 * 锁**只在进程内**：本服务是单进程部署（`sylph.sh` 起一个 node），跨进程锁需要
 * 文件锁或库锁，而那样会在崩溃后留下一个要人工清理的残留物，与「重启就续做/回滚」
 * 的恢复语义直接冲突。重启之后锁自然是空的——那时由 `recoverRestore()` 接管。
 *
 * 与既有机制的边界：
 *  - `passwordChanging` / `activeAdminWrites`（server.js）挡的是改密与并发写，
 *    两者都与本锁**同时**生效，互不替代；
 *  - `autoSyncSuppressed` 只影响自动同步的排期，挡不住已经在飞的那一次，
 *    所以 `runAutoSync` 开头另外复查本锁（见 server.js）。
 */

/** 恢复涉及的域。与 `lib/restore.js` 的适配表同名——两处漂移的表现是「锁了一个域、恢复了另一个」。 */
const DOMAINS = ['navigation-admin', 'modules', 'favorites', 'timeline', 'memos', 'todos'];

/** 503 的 `Retry-After`：恢复是秒级动作，给一个能被界面直接显示的小值。 */
const RETRY_AFTER_SECONDS = 5;

const BUSY_MESSAGE = '正在恢复备份，请稍后重试';
const BUSY_CODE = 'busy';

let holder = null;

/**
 * 域 → 排空器。由 server.js 在 `init()` 里注入：这两个域的在途任务
 * （时间线来源同步、监控采集）只有装配处才知道怎么等。
 */
let drainers = new Map();

function publicHolder() {
    if (!holder) return null;
    return {
        kind: holder.kind,
        domains: [...holder.domains],
        startedAt: holder.startedAt,
        // 已持有时长：界面/日志用它解释「为什么还在 503」
        heldMs: Date.now() - holder.startedAt
    };
}

/** 当前持有者（没有则 null）。 */
function current() {
    return publicHolder();
}

function isBusy() {
    return holder !== null;
}

/**
 * 取锁。
 *
 * 非空即失败——**不排队**。排队会让一个 5 分钟前点了恢复的请求在锁释放后突然
 * 落地，而它携带的 `planDigest` 早已陈旧；直接 503 让客户端重新预览才是对的。
 *
 * @param {string} kind 持有者名字（'restore' / 'backup'），只用于回报与日志
 * @param {string[]} [domains] 这次要动的域
 * @returns {{ok: boolean, holder: object|null}}
 */
function acquire(kind, domains = []) {
    if (holder) return { ok: false, holder: publicHolder() };
    holder = {
        kind: typeof kind === 'string' && kind ? kind : 'admin-write',
        domains: [...new Set((Array.isArray(domains) ? domains : []).filter(d => typeof d === 'string' && d))],
        startedAt: Date.now()
    };
    return { ok: true, holder: publicHolder() };
}

/** 释放。返回被释放的持有者（没持有时返回 null），便于记录持有时长。 */
function release() {
    const released = publicHolder();
    holder = null;
    return released;
}

/** 503 的响应体。`code` 是稳定标识，界面按它决定文案，不解析中文。 */
function busyBody() {
    return {
        error: BUSY_MESSAGE,
        code: BUSY_CODE,
        retryAfter: RETRY_AFTER_SECONDS,
        holder: publicHolder()
    };
}

/** 直接写 503。返回 true 表示「已经拒掉了」，调用方应立即 return。 */
function rejectBusy(res) {
    res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
    res.status(503).json(busyBody());
    return true;
}

/**
 * 中间件：锁被占用就 503。
 *
 * `domains` 只用于回报（`holder.domains` 与「你这次想动的域」），**不影响判定**：
 * 拍定的是「恢复期间所有管理写都拒」，不做域级豁免。
 */
function rejectIfBusy(domains) {
    const wanted = Array.isArray(domains) ? domains : (domains ? [domains] : []);
    return function busyGuard(req, res, next) {
        if (!holder) return next();
        res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
        res.status(503).json({ ...busyBody(), requestedDomains: wanted });
    };
}

/** 注入排空器：`{ [domain]: async (timeoutMs) => boolean }`，返回 true 表示已排空。 */
function configureDrainers(map) {
    drainers = new Map();
    for (const [domain, fn] of Object.entries(map || {})) {
        if (typeof fn === 'function') drainers.set(domain, fn);
    }
}

function withTimeout(promise, timeoutMs) {
    let timer = null;
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        // 不得把进程吊住：排空本身是恢复路径上的一个等待，不是后台服务
        if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([
        Promise.resolve(promise).then(ok => ok !== false, () => false),
        timeout
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * 等待受影响域的在途任务结束。
 *
 * 顺序是「先停再等」：只等不停，调度器会在等待期间再起一个新的来源同步，
 * 于是永远等不完（实测里表现为恢复卡在排空阶段直到超时）。
 *
 * 超时**不抛错**：调用方（恢复流程）需要知道「有没有排空」而不是被一个超时打断——
 * 拒绝恢复会把用户锁在「点了恢复但永远失败」的状态里。返回 `{drained, pending}`，
 * 由调用方决定是继续（并接受一次可能交错在途的写）还是放弃。
 *
 * @param {Iterable<string>} domains 要排空的域
 * @param {number} timeoutMs 总预算
 * @returns {Promise<{drained: boolean, pending: string[], waitedMs: number}>}
 */
async function drainInFlight(domains, timeoutMs = 5000) {
    const wanted = [...new Set((Array.isArray(domains) ? domains : (domains ? [domains] : []))
        .filter(d => typeof d === 'string' && d))];
    const targets = wanted.length ? wanted : [...drainers.keys()];
    const startedAt = Date.now();
    const pending = [];
    const jobs = [];
    for (const domain of targets) {
        const drainer = drainers.get(domain);
        if (!drainer) continue;
        jobs.push(withTimeout(Promise.resolve().then(() => drainer(timeoutMs)), timeoutMs)
            .then(ok => { if (!ok) pending.push(domain); }));
    }
    await Promise.all(jobs);
    return { drained: pending.length === 0, pending, waitedMs: Date.now() - startedAt };
}

/** 测试用：清空持有者与排空器（进程级单例在用例之间会互相污染）。 */
function __reset() {
    holder = null;
    drainers = new Map();
}

module.exports = {
    DOMAINS,
    RETRY_AFTER_SECONDS,
    BUSY_CODE,
    BUSY_MESSAGE,
    acquire,
    release,
    current,
    isBusy,
    busyBody,
    rejectBusy,
    rejectIfBusy,
    configureDrainers,
    drainInFlight,
    __reset
};

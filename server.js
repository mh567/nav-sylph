const express = require('express');
const compression = require('compression');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const http = require('http');
const bcrypt = require('bcrypt');

// ⚠️ 必须写成 './server-config/index.js'（显式带 index.js），不能写 './server-config'。
//
// Node 解析 `require('./server-config')` 的顺序是 `.js` → `.json` → `.node` → **目录**，
// 所以安装目录根下的 server-config.json（用户配置，由后台自签开关写出）会**遮蔽**
// server-config/ 目录：index.js 一行都不执行，defaults 不被合并，rootDir 也不会被
// 赋值（它不在 defaults.js 里，是 index.js 单独加的），于是服务启动即崩。
//
// 写成显式路径后，加载的永远是目录模块，用户那份 json 仍由 index.js 的
// loadFromConfigFile() 读出并覆盖到 defaults 之上——这才是它本来的设计语义。
// 1.6.10 曾试图用「写全配置」绕开遮蔽，但 rootDir 不在 defaults 里、补不出来，
// 于是同一个故障复发；让遮蔽不发生才是正解。
const config = require('./server-config/index.js');

// 判定「这份配置不是被遮蔽后的残片」所需的段。
//
// 刻意硬编码而不从 server-config/defaults.js 取：那份 defaults 是**用户配置之外**的
// 兜底，列在这里等于「拿到完整配置时必须具备的段」；若将来 defaults 增删段，
// 这个清单要跟着人工过一遍——这是有意的，避免把「defaults 里有什么」
// 和「运行时必须有什么」两件事绑在一起。
//
// 顺序按最早被使用排：rootDir 在文件顶部就被 path.join 用到，其后是 paths。
const REQUIRED_CONFIG_SECTIONS = ['rootDir', 'server', 'paths', 'security'];

// defaults 兜底用的段清单见下方 REQUIRED_CONFIG_SECTIONS；此处不再单独 require defaults
// （1.6.10 曾用它补齐配置，那条路已废弃——rootDir 不在 defaults 里，补不出来）。

// ⚠️ 为什么校验必须在这里，而不能放进 server-config/index.js：
//
// Node 解析 `require('./server-config')` 的顺序是 `.js` → `.json` → `.node`
// → **目录**。所以 ~/nav-sylph/server-config.json 一旦存在，加载的就是它，
// `server-config/index.js` **一行都不会执行**——校验写在那边等于死代码。
// 这里 require 完是全项目第一个能同时看到「配置对象」和「目录是否存在」的
// 位置，也是唯一能在 `path.join(config.rootDir, ...)` 之前拦下来的地方。
//
// 失败模式（实测）：一份只写了 `{"security":{"selfSignedCert":false}}` 的残片
// 让 config 少了 rootDir/server/paths 等键，第一个用到它的 server.js:219
// `path.join(config.rootDir, 'config.json')` 收到 undefined，抛出的却是
// `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string`——
// 指向 path.join，既不提配置文件，也不提同名目录被遮蔽，排查要绕三层。
assertConfigUsable(config);

const app = express();
let server;

/**
 * 校验 require('./server-config') 拿到的是不是一份可用的服务配置。
 *
 * 唯一能判定的失效模式是「同名 json 遮蔽了 server-config/ 目录」：
 * 那种情况下 require 返回的是用户的 `server-config.json` 原文，
 * 只有用户写过的那几个键，defaults 里的其余段（rootDir/server/paths/app/webdav）
 * 一个都没有。它必须在这里报，且要说人话——失败链路见上方 require 处的注释。
 *
 * 判据用 `rootDir` 是否存在，而不是比对 defaults 的完整键集：
 * `server-config/index.js` 正常跑完会无条件补上 rootDir（它由 __dirname 推导），
 * 而任何用户 json 都给不出这个字段——所以它的缺失是遮蔽的充分证据。
 *
 * 目录缺失（用户从未写过 server-config.json）时 require 的就是 index.js，
 * 这一层不会触发；此处的 if 只是万一 index.js 被移走时的兜底文案。
 *
 * @throws {Error} 指向 server-config.json 本身，而非某个下游的 path.join
 */
function assertConfigUsable(loaded) {
    // 判据是两个而不是一个：rootDir 与 validate。
    //
    // 只查 rootDir 的话，用户手写一份带 "rootDir": "..." 的 json 就能绕过——
    // 实测那样会放行，然后在更下游炸成 `config.validate is not a function`
    // （server.js 末尾会调它），正是本函数要消灭的那类指不到真因的错误。
    // validate 只有 server-config/index.js 会挂，用户 json 给不出来，
    // 而 rootDir 在残片状态下根本不可能是字符串。两个合起来才是充分证据。
    if (loaded && typeof loaded.rootDir === 'string' && typeof loaded.validate === 'function') {
        return;
    }

    const userFile = path.join(__dirname, 'server-config.json');
    const present = fsSync.existsSync(userFile);
    const missing = REQUIRED_CONFIG_SECTIONS.filter((key) => !loaded || !(key in loaded));
    if (loaded && typeof loaded.validate !== 'function' && missing.length === 0) {
        missing.push('validate()');
    }

    throw new Error(
        '服务配置加载失败：' + (present
            ? `${userFile} 遮蔽了 server-config/ 目录，Node 优先加载了它，` +
              '但它不是一个完整的配置对象（缺少 ' + missing.join(', ') + '）。\n' +
              '  Node 的解析顺序是 .js → .json → 目录，server-config.json 一旦存在就赢。\n' +
              '  · 你本意是用默认配置 → 备份后删除：' +
              `cp '${userFile}' '${userFile}.bak' && sudo rm '${userFile}'\n` +
              '  · 你要改配置 → 参考 server-config.example.json 写完整后再启用'
            : 'server-config/ 目录缺失或无法加载，请重新安装程序文件'
        )
    );
}

// ========== Paste 分享功能 ==========
const pasteStorage = new Map();
// 结构: { code: { content, pin, expiresAt, attempts } }

// 有效期白名单：键为分钟数，值为毫秒。只接受这些档位，未知值回落到 5 分钟。
// 用 Object.create(null) 断开原型链，避免 ttl="constructor" 之类取到原型属性，
// 把 expiresAt 变成 NaN 或字符串，导致条目永不过期、永不被清理。
const PASTE_TTL_OPTIONS = Object.assign(Object.create(null), {
    5: 5 * 60 * 1000,
    30: 30 * 60 * 1000,
    1440: 24 * 60 * 60 * 1000,
    10080: 7 * 24 * 60 * 60 * 1000
});
const PASTE_DEFAULT_TTL_MINUTES = 5;

// 只接受白名单自身的键；数字以外的键（如 "5"）也视为非法，避免类型混淆
function resolvePasteTtlMinutes(ttl) {
    if (typeof ttl !== 'number' || !Number.isInteger(ttl)) return PASTE_DEFAULT_TTL_MINUTES;
    return Object.hasOwn(PASTE_TTL_OPTIONS, ttl) ? ttl : PASTE_DEFAULT_TTL_MINUTES;
}

// 词表用于生成易记的分享码
const ADJECTIVES = [
    'happy', 'sunny', 'cool', 'swift', 'brave', 'calm', 'eager', 'fair', 'gentle', 'kind',
    'lively', 'merry', 'nice', 'proud', 'quick', 'smart', 'warm', 'wise', 'bold', 'bright',
    'clean', 'clear', 'crisp', 'deep', 'fine', 'fresh', 'glad', 'good', 'grand', 'great',
    'keen', 'light', 'neat', 'pure', 'rich', 'safe', 'sharp', 'soft', 'strong', 'sweet',
    'tall', 'true', 'vast', 'vivid', 'wild', 'young', 'zesty', 'agile', 'fancy', 'golden',
    'handy', 'ideal', 'jolly', 'lucky', 'magic', 'noble', 'peaceful', 'rapid', 'royal', 'silent',
    'simple', 'smooth', 'solid', 'stable', 'steady', 'super', 'tender', 'tiny', 'ultra', 'unique',
    'useful', 'valid', 'vital', 'witty', 'zealous', 'azure', 'cosmic', 'divine', 'epic', 'fiery',
    'frozen', 'humble', 'lunar', 'mighty', 'mystic', 'polar', 'primal', 'radiant', 'rustic', 'serene',
    'silver', 'sonic', 'stellar', 'stormy', 'sunset', 'thunder', 'timber', 'turbo', 'velvet', 'vintage'
];

const NOUNS = [
    'tiger', 'eagle', 'wolf', 'bear', 'fox', 'hawk', 'lion', 'deer', 'swan', 'dove',
    'oak', 'pine', 'maple', 'cedar', 'birch', 'willow', 'palm', 'fern', 'rose', 'lily',
    'river', 'lake', 'ocean', 'stream', 'wave', 'cloud', 'rain', 'snow', 'wind', 'storm',
    'star', 'moon', 'sun', 'sky', 'dawn', 'dusk', 'night', 'day', 'light', 'shadow',
    'stone', 'rock', 'hill', 'peak', 'cliff', 'cave', 'sand', 'dust', 'flame', 'spark',
    'dragon', 'phoenix', 'griffin', 'raven', 'falcon', 'owl', 'crane', 'heron', 'finch', 'lark',
    'coral', 'pearl', 'jade', 'ruby', 'amber', 'crystal', 'diamond', 'emerald', 'onyx', 'opal',
    'bridge', 'tower', 'castle', 'temple', 'garden', 'forest', 'meadow', 'valley', 'island', 'harbor',
    'arrow', 'blade', 'crown', 'drum', 'flute', 'harp', 'horn', 'lyre', 'shield', 'sword',
    'atlas', 'bolt', 'comet', 'delta', 'echo', 'frost', 'glow', 'haze', 'iris', 'jazz',
    'karma', 'lotus', 'metro', 'nexus', 'orbit', 'pulse', 'quest', 'ridge', 'surge', 'tide',
    'unity', 'vortex', 'whisper', 'zenith', 'zephyr', 'anchor', 'beacon', 'cipher', 'drift', 'ember',
    'flare', 'glider', 'horizon', 'ignite', 'jungle', 'kindle', 'lagoon', 'mirage', 'nebula', 'oasis',
    'prism', 'quartz', 'rapids', 'sage', 'terra', 'umbra', 'vertex', 'wraith', 'yacht', 'zero',
    'alpha', 'beta', 'gamma', 'sigma', 'omega', 'nova', 'pixel', 'quasar', 'realm', 'spirit',
    'thunder', 'titan', 'vapor', 'vector', 'voyage', 'wander', 'wonder', 'xerox', 'yonder', 'zodiac',
    'breeze', 'canyon', 'delta', 'epoch', 'fiber', 'grain', 'haven', 'inlet', 'jewel', 'knot',
    'ledge', 'manor', 'night', 'olive', 'petal', 'quill', 'reef', 'shell', 'thorn', 'bloom',
    'coast', 'dune', 'field', 'grove', 'marsh', 'plain', 'shore', 'trail', 'woods', 'brook'
];

function generatePasteCode() {
    // 中国人常见的简短英文单词
    const words = [
        // 动物
        'cat', 'dog', 'bird', 'fish', 'bear', 'lion', 'tiger', 'panda', 'fox', 'wolf',
        'duck', 'frog', 'deer', 'rabbit', 'mouse', 'horse', 'sheep', 'pig', 'cow', 'bee',
        // 自然
        'sun', 'moon', 'star', 'sky', 'rain', 'snow', 'wind', 'fire', 'ice', 'sea',
        'lake', 'river', 'hill', 'rock', 'tree', 'leaf', 'rose', 'lily', 'grass', 'cloud',
        // 食物
        'apple', 'orange', 'grape', 'peach', 'mango', 'lemon', 'berry', 'candy', 'cake', 'pizza',
        'bread', 'rice', 'noodle', 'milk', 'juice', 'tea', 'coffee', 'honey', 'sugar', 'salt',
        // 颜色
        'red', 'blue', 'green', 'pink', 'gold', 'silver', 'black', 'white', 'gray', 'purple',
        // 形容词
        'happy', 'lucky', 'cool', 'nice', 'good', 'sweet', 'smart', 'fast', 'big', 'little',
        'hot', 'cold', 'new', 'old', 'soft', 'warm', 'bright', 'fresh', 'quiet', 'calm',
        // 名词
        'love', 'game', 'music', 'book', 'king', 'queen', 'baby', 'angel', 'dream', 'hope',
        'time', 'day', 'night', 'home', 'door', 'key', 'box', 'gift', 'card', 'note',
        'phone', 'photo', 'video', 'song', 'dance', 'smile', 'heart', 'magic', 'power', 'peace'
    ];
    const word = words[Math.floor(Math.random() * words.length)];
    const num = Math.floor(Math.random() * 900) + 100; // 100-999
    const code = `${word}-${num}`;

    // 确保唯一性
    if (pasteStorage.has(code)) {
        return generatePasteCode();
    }
    return code;
}

function isPasteCodeFormat(str) {
    // 匹配 单词-3位数字 格式 (7-10位)
    return /^[a-z]{2,6}-\d{3}$/.test(str);
}

// 清理过期分享
function cleanExpiredPastes() {
    const now = Date.now();
    for (const [code, data] of pasteStorage.entries()) {
        if (now > data.expiresAt) {
            pasteStorage.delete(code);
        }
    }
}

// 分享限流：取码与创建是两个独立入口，用不同 key 分别计数，
// 避免互相消耗配额
const pasteRateLimitMap = new Map();
const PASTE_CODE_LIMIT = 10;     // 每小时取码次数
const PASTE_CREATE_LIMIT = 20;   // 每小时创建次数
const PASTE_GET_LIMIT = 30;      // 每小时读取次数
const PASTE_RATE_WINDOW = 3600000; // 1小时

// 分享全局容量上限：限流按 IP 计数，多个 IP 仍可能共同堆高内存
const PASTE_MAX_ENTRIES = 500;
const PASTE_MAX_BYTES = 50 * 1024 * 1024;

// 纯函数形式：store 与 now 由调用方传入，便于注入时钟做确定性测试
function consumeRateLimit(store, key, now, windowMs, limit) {
    const record = store.get(key);
    if (!record || now - record.start > windowMs) {
        store.set(key, { start: now, count: 1 });
        return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
    }
    record.count++;
    store.set(key, record);
    return {
        allowed: record.count <= limit,
        remaining: Math.max(0, limit - record.count),
        resetAt: record.start + windowMs
    };
}

function sweepRateLimitStore(store, now, windowMs) {
    for (const [key, record] of store.entries()) {
        if (now - record.start > windowMs) store.delete(key);
    }
}

// 匿名可读接口（/api/config、/api/favorites）的限流。
// 这两条软门在无会话时每次都会跑一次 bcrypt 比对，实测伪造 X-Admin-Password
// 可把单请求从约 7ms 抬到 63ms（约 9 倍 CPU）且无需任何认证。
// 单独计数而不是复用 rateLimit：首页匿名加载是正常流量，若与登录共用一个桶，
// 正常访问就能把登录的防爆破预算耗光。阈值放宽到 120 次/分钟。
const publicReadLimitMap = new Map();
const PUBLIC_READ_WINDOW = 60000;
const PUBLIC_READ_MAX = 120;

function publicReadLimit(req, res, next) {
    const ip = resolveClientIp(req);
    const { allowed } = consumeRateLimit(publicReadLimitMap, ip, Date.now(), PUBLIC_READ_WINDOW, PUBLIC_READ_MAX);
    if (!allowed) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
}

// 后台轮询接口（/api/modules/metrics、/api/memos）的限流。
//
// 这两条是**轮询**打的：每个开着的前台标签页每 pollInterval 各打一次，
// 最短周期 10 秒即 6 次/分钟/接口。它们原先与管理操作共用 rateLimit
// （30 次/分钟/IP），于是「正常使用」自己就能把桶打满——实测：
//   · 一次页面加载占 3 次（modules/config + metrics + memos），
//   · 一个标签页空闲轮询占 8 次/分钟（两个接口各 4 次），
// 所以单开一个标签页时刷 7~8 次、两个标签页时刷 4~5 次就打满。
// 实测复现（一分钟连刷 12 次）：第 9 秒起 /api/modules/config 连续 429，
// 模块区因此渲染不出来；metrics 则显示「监控数据读取失败」——两条症状
// 同源，而它们看起来像两个不同的故障。
//
// 单独计数而**不是**提高 rateLimit：rateLimit 同时是
// /api/verify-password 的第一层防爆破，放宽它等于把暴力破解的额度一起
// 放宽 4 倍。这与 publicReadLimit 早先为 /api/session 做过的是同一件事。
// 阈值按轮询推导：2 个接口 × 6 次/分钟（周期下限 10 秒）× 10 个标签页 = 120。
//
// 代价：这两条是 requireAdmin 门控，无会话时它会跑一次 bcrypt（正常会话
// 命中不走）。所以伪造 X-Admin-Password 打这两个接口时，可触发的 bcrypt
// 上限从 30 次/分钟升到 120 次/分钟；仍是有界的，且不必放宽登录那条路径。
const modulePollLimitMap = new Map();
const MODULE_POLL_WINDOW = 60000;
const MODULE_POLL_MAX = 120;

function modulePollLimit(req, res, next) {
    const ip = resolveClientIp(req);
    const { allowed } = consumeRateLimit(modulePollLimitMap, ip, Date.now(), MODULE_POLL_WINDOW, MODULE_POLL_MAX);
    if (!allowed) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
}

function isOverPasteCapacity(count, totalBytes) {
    return count >= PASTE_MAX_ENTRIES || totalBytes >= PASTE_MAX_BYTES;
}

// 限流用的客户端标识。已开启 trust proxy，req.ip 即为反代回填的真实地址；
// 兜底取 socket 地址仅用于完全没有 req.ip 的极端情况。
function resolveClientIp(req) {
    return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

// 当前已占用的字节数：内容均为密文 base64，字符数即可近似
function pasteStorageBytes() {
    let total = 0;
    for (const data of pasteStorage.values()) {
        total += data.content.length;
    }
    return total;
}

// 每60秒清理过期分享与过期限流记录。
// 限流记录不清理会随 IP 数量无限增长；开启 trust proxy 后 key 等于访问者数量。
// unref 避免该定时器阻止进程自然退出。
// 推送端点的限流桶定义在下方「推送接收」小节里。这个定时器 60 秒后才触发，
// 那时 const 已完成初始化——但把它列进清理时不能直接引用尚未声明的标识符，
// 所以在这里声明这个 Map，下方直接复用同一个对象（不再重复声明）。
const pushLimitMap = new Map();

setInterval(() => {
    const now = Date.now();
    cleanExpiredPastes();
    sweepRateLimitStore(pasteRateLimitMap, now, PASTE_RATE_WINDOW);
    sweepRateLimitStore(rateLimitMap, now, RATE_LIMIT_WINDOW);
    sweepRateLimitStore(publicReadLimitMap, now, PUBLIC_READ_WINDOW);
    sweepRateLimitStore(globalLoginMap, now, 60000);
    // 失败锁定：按窗口清掉过期记录，锁定期已满的也会随之消失
    sweepRateLimitStore(loginFailMap, now, LOGIN_FAIL_WINDOW);
    // 推送桶同样要清：它按来源 IP 计数，匿名可达且无会话，不清就会无限增长
    sweepRateLimitStore(pushLimitMap, now, PUSH_LIMIT_WINDOW);
    // 注册桶同理：POST /api/modules/enroll 匿名可达（agent 注册时尚无任何
    // 长期凭据），也按 IP 计数。漏掉它就等于给了一个「只增不减、无人回收」
    // 的 Map —— 本仓库每个限流 Map 都登记在这个定时器里，不是可选项。
    sweepRateLimitStore(enrollLimitMap, now, ENROLL_LIMIT_WINDOW);
    // 备忘录桶：路由虽要求登录，仍按 IP 计数——已登录会话下的
    // 异常流量同样只增不减。桶定义在下方「备忘录 API」小节，
    // 与注册桶同理：定时器 60 秒后才触发，那时 const 已初始化。
    sweepRateLimitStore(memoRateLimitMap, now, MEMO_LIMIT_WINDOW);
    // 模块轮询桶：按 IP 计数，不清就会随标签页数量无限增长。
    sweepRateLimitStore(modulePollLimitMap, now, MODULE_POLL_WINDOW);
    // 会话同理：只增不减会随登录次数累积。
    // 回调在首次触发（60 秒后）才读取 sessionStore，而 init() 在开始监听前就已完成赋值；
    // init() 失败则进程随即 exit(1)，定时器不会触发——安全性取决于调用时机，不是代码顺序。
    sessionStore.sweep(now);
}, 60000).unref();

const CONFIG_FILE = path.join(config.rootDir, 'config.json');
const FAVORITES_FILE = path.join(config.rootDir, 'favorites.json');
const PASSWORD_FILE = config.security.adminPasswordFile;
const WEBDAV_CONFIG_FILE = path.join(config.rootDir, '.webdav-config.json');
// 登录后模块的平台配置：服务器监控目标、社交账号、自选代码、widget 布局。
// 独立于 config.json —— 那里的新 key 默认会经 toPublicConfig 下发给匿名用户，
// 且 mergeConfig 是顶层浅合并，嵌套对象会被客户端旧副本整块覆盖。
const MODULES_FILE = path.join(config.rootDir, '.modules.json');

// WebDAV Backup module
const { WebDAVBackup } = require('./lib/webdav-backup');
const { encrypt, decrypt, isEnvelope } = require('./lib/credentials');

// 管理端会话：设备指纹 + 地理绑定
// 注意：本文件另有粘贴相关的 globalThis.crypto（WebCrypto）用法，
// 故这里不 require('crypto')，令牌随机数由 lib/session 内部生成。
const {
    SessionStore,
    readCookie,
    ACCEPT_CH,
    ENV_CHANGED_CODE,
    ENV_CHANGED_MESSAGE
} = require('./lib/session');
const { openDatabase } = require('./lib/db');
const { createSqliteBackend } = require('./lib/session-sqlite');
const {
    readLocalMetrics, fetchRemoteMetrics, probeTcp, probeAgentHealth
} = require('./lib/monitor');

// 推送凭据的随机数与哈希需要 Node 的 crypto。
// **必须用别名**：本文件的 `crypto` 是 globalThis.crypto（WebCrypto），
// 粘贴功能的 AES-GCM 加解密依赖它（见下方 require 与 server.js:222 的警告）。
// 写成 `const crypto = require('crypto')` 会遮蔽 WebCrypto，
// 那个 bug 的表现是登录/解密时才炸，不会在启动时。
const nodeCrypto = require('crypto');

// ========== 推送凭据 ==========
//
// 推送端点是匿名可达的（内网 agent 主动连公网服务器），所以它的鉴权
// **不能**是 requireAdmin（agent 是裸 HTTP，拿不到浏览器会话），
// 也不能只验 agent token——服务端要拿 token 去解密 .modules.json 里的
// 密文（密钥派生自管理员密码哈希），一旦 token 能触发解密+写库，
// 它就等于配置写权限：可反复触发 bcrypt、可改写首页上所有机器的指标。
//
// 因此用独立的、绑定 server.id 的推送凭据：明文只在领取响应里出现一次，
// 服务端只存哈希（与 .admin-password.json 同级处理）。
const PUSH_SECRET_BYTES = 32;

/** 生成一个推送凭据明文。base64url 无需转义，可直接进环境变量。 */
function generatePushSecret() {
    return nodeCrypto.randomBytes(PUSH_SECRET_BYTES).toString('base64url');
}

function hashPushSecret(secret) {
    return nodeCrypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

// ========== 部署令牌 ==========
//
// 一键部署的核心：后台生成一枚一次性令牌，命令里带着它，目标机的 agent
// 用它完成注册（把自己生成的证书交上来、换回长期凭据）。
//
// 为什么需要它：上一版要求用户手工生成证书、把终端上打印的指纹抄回后台核对、
// 自己发明一个 token —— 七步以上，且第一步就需要用户已经能 SSH 上目标机。
// 令牌把「信任」这一步从**人工比对**换成**持有即信任**，用户只做一次复制粘贴。
//
// 威胁模型要说清：令牌是「谁拿到它谁就能注册」。所以
//   · 只有已登录的管理员能签发（端点挂 requireAdmin）
//   · 15 分钟过期、一次性用掉（用过即从配置里删掉）
//   · 重复签发即作废旧令牌
//   · 注册端点有自己的限流桶
//
// ⚠️ 这里**没有**「绑定来源 IP」那道防护，尽管早先写过一版。原因是它做不到：
// 部署令牌在目标机上使用，而服务端看到的是它的出口 IP（NAT 之后），
// 与用户在后台填的地址没有可比性。详见 enroll 端点里那段注释。
// 真实防护就是上面这几条 —— 换成「谁拿到它谁就能注册」，别粉饰。
const ENROLL_TOKEN_BYTES = 32;
/** 令牌有效期。过了就重新签发——用户不会在 15 分钟外还在粘贴旧命令。 */
const ENROLL_TOKEN_TTL_MS = 15 * 60 * 1000;

function generateEnrollToken() {
    return nodeCrypto.randomBytes(ENROLL_TOKEN_BYTES).toString('base64url');
}

function hashEnrollToken(token) {
    return nodeCrypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function enrollTokenMatches(provided, storedHash) {
    if (typeof provided !== 'string' || !provided || !storedHash) return false;
    const a = Buffer.from(hashEnrollToken(provided), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return nodeCrypto.timingSafeEqual(a, b);
}

/**
 * 定长比较，避免逐字符比较的时间差泄露哈希前缀。
 * 长度不同直接拒绝——与 agent 的 tokenMatches 同一处理。
 */
function pushSecretMatches(provided, storedHash) {
    if (typeof provided !== 'string' || !provided || !storedHash) return false;
    const a = Buffer.from(hashPushSecret(provided), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return nodeCrypto.timingSafeEqual(a, b);
}

// 禁用 X-Powered-By 头
app.disable('x-powered-by');

// 信任反代写入的 X-Forwarded-For，使限流能拿到真实客户端 IP。
// 1 表示只信任最右侧一跳。该跳正是 nginx 用 proxy_add_x_forwarded_for
// 追加 $remote_addr 的位置，客户端自带的 XFF 会被完全丢弃。
// 前提是端口不对外暴露：若能绕过 nginx 直连，客户端可往 XFF 末尾追加任意
// IP 换取新限流桶（实测可无限轮换），此时 1 与 true 都不安全。真正生效的
// 边界是网络层，不是这个取值。
app.set('trust proxy', 1);

// Express 4 不捕获 async 处理函数抛出的异常，这类异常会变成 unhandledRejection
// 并终止进程。任何未认证请求都能触发的解析路径（如 Cookie 解码）都可能打挂服务，
// 因此在这里兜底：记日志、继续存活。真正的请求级错误仍由下面的错误处理中间件负责。
process.on('unhandledRejection', (reason) => {
    console.error('[Server] 未处理的 Promise 拒绝:', reason && reason.message ? reason.message : reason);
});

app.use(express.json());
app.use(compression({ threshold: 1024 }));

// 全局错误处理：统一返回 JSON，并屏蔽 Express 默认处理器会回显的
// err.stack（其中包含 node_modules 路径与服务器绝对目录）。
// 必须紧跟 body-parser 之后，否则捕获不到 PayloadTooLargeError。
app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
        console.error(`[Server] ${req.method} ${req.path} 处理失败:`, err.message);
        return res.status(status).json({ error: '服务器内部错误' });
    }
    if (status === 413) return res.status(413).json({ error: '内容过大' });
    res.status(status).json({ error: '请求无效' });
});

// 安全头 (必须在静态文件之前)
app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('X-XSS-Protection', '1; mode=block');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.header('Content-Security-Policy', "script-src 'self' 'unsafe-inline'");
    
    // CORS
    const origin = req.headers.origin;
    if (!origin || origin === `http://${config.server.host}:${config.server.port}`) {
        res.header('Access-Control-Allow-Origin', origin || '*');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.static(path.join(config.rootDir, 'public'), {
    index: 'index.html',
    extensions: ['html', 'htm']
}));

/**
 * agent 二进制分发（安装脚本按架构 curl 它）。
 *
 * 放在仓库根的 agent/dist/ 而非 public/ 下——它不在首页的静态资源清单里，
 * 不该进 Service Worker 的预缓存（预缓存一个只在装 agent 时才下载的文件，
 * 只会在每次更新时让所有人多下一次）。
 *
 * ⚠️ 二进制不进 git（是构建产物，三个架构加起来十几 MB）。开发机上没构建过
 * 时回一条**shell 注释**而不是 HTML 错误页：这段文本会被 install.sh 用
 * `bash -s` 执行，回 HTML 会变成一堆莫名其妙的语法错误。
 */
const AGENT_ARCHES = new Set(['amd64', 'arm64', 'armv7']);
app.get('/agent/nav-agent-linux-:arch', async (req, res) => {
    const arch = req.params.arch;
    if (!AGENT_ARCHES.has(arch)) {
        // 架构白名单：少了它，../ 之类能读出仓库里的其它文件
        res.status(404).send(`// 不支持的架构：${arch}\n`);
        return;
    }
    try {
        const file = path.join(config.rootDir, 'agent', 'dist', `nav-agent-linux-${arch}`);
        const stat = await fs.stat(file);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        // 二进制随版本变但 URL 不变，不给长缓存——否则用户照着旧命令
        // curl 到的是过期产物，而它装上之后不会自己更新。
        res.setHeader('Cache-Control', 'no-cache');
        // ⚠️ 分发 agent 二进制时**必须**用 fsSync（真正的 fs 模块），不能用 fs。
        // `require('fs').promises` 没有 createReadStream —— 实测会抛
        // `fs.createReadStream is not a function`，而 catch 把它转成了 404，
        // 于是「二进制下载失败」与「架构不支持」在响应上长得一模一样。
        // 二进制有 6–7MB，也不能用 readFile 一次性读进内存。
        const stream = fsSync.createReadStream(file);
        stream.on('error', () => {
            if (!res.headersSent) res.status(500).send('// 二进制读取失败');
            else res.destroy();
        });
        stream.pipe(res);
    } catch (err) {
        console.error(`提供 agent 二进制失败（${arch}）:`, err.message);
        // shell 注释而非 HTML：这段文本会被 install.sh 当脚本读
        res.status(404).send(
            '# 本安装未构建 agent 二进制。\n' +
            '# 服务端需要跑一次 scripts/build-agent.sh 后重新发布。\n'
        );
    }
});

/** 一键安装脚本本身。同样按需提供，不进预缓存。 */
app.get('/agent/install.sh', async (req, res) => {
    try {
        const file = path.join(config.rootDir, 'agent', 'install.sh');
        const source = await fs.readFile(file, 'utf8');
        res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(source);
    } catch (err) {
        console.error('提供 install.sh 失败:', err);
        // 同样必须是 shell 注释——这段文本会被 bash -s 执行
        res.status(404).send('# install.sh not found in this installation\n');
    }
});

app.use((req, res, next) => {
    const time = new Date().toISOString();
    console.log(`[${time}] ${req.method} ${req.path}`);
    next();
});



// 简易 Rate Limiting (密码相关接口)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1分钟
const RATE_LIMIT_MAX = 30; // 最多30次

function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const key = ip + ':auth';
    
    let record = rateLimitMap.get(key);
    if (!record || now - record.start > RATE_LIMIT_WINDOW) {
        record = { start: now, count: 0 };
    }
    record.count++;
    rateLimitMap.set(key, record);
    
    if (record.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
}

// ========== 登录防爆破 ==========
//
// 本项目只有一个管理密码、没有账户体系，因此没有「锁账号、输密码解锁」这条路。
// 能做的只有两件事，各管一层：
//
//   第 1 层 失败锁定（主力）：同一 IP 连续 LOGIN_FAIL_MAX 次密码错误即锁该 IP
//                          LOGIN_FAIL_WINDOW。锁定期内直接 429，**不跑 bcrypt**——
//                          攻击者每个 IP 只消耗 LOGIN_FAIL_MAX 次密码比对，
//                          之后边际成本趋近于零，堆再多 IP 也只是自己更慢。
//   第 2 层 总量封顶（兜底）：见 globalLoginLimit，防「大量 IP 各打一次」
//                          这一种不触发锁定的打法。
//
// 三层的执行顺序有讲究：失败锁定必须排在总量封顶**之前**。若总量阈值不大于
// 单 IP 锁定阈值（第 N 次错误），总量桶会先触发，单 IP 锁定永远走不到，
// 锁定功能形同虚设，而且「换一台设备登录」也会被总量桶挡下——
// 那正是全局桶唯一的代价，不该由正常用户先吃到。
const LOGIN_FAIL_WINDOW = 30 * 60000;  // 30 分钟
const LOGIN_FAIL_MAX = 10;             // 连续 10 次错误即锁
const loginFailMap = new Map();        // ip -> { count, start, lockedUntil }

/**
 * 纯函数形式：store 与 now 由调用方注入，便于做确定性测试。
 * @returns {{locked: boolean, retryAfter: number, count: number}}
 */
function checkLoginLock(store, ip, now) {
    const rec = store.get(ip);
    if (!rec) return { locked: false, retryAfter: 0, count: 0 };
    if (rec.lockedUntil > now) {
        return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000), count: rec.count };
    }
    // 锁定期已过：计数归零重新开始，否则一次锁定会变成永久封禁
    if (now - rec.start > LOGIN_FAIL_WINDOW) {
        store.delete(ip);
        return { locked: false, retryAfter: 0, count: 0 };
    }
    return { locked: false, retryAfter: 0, count: rec.count };
}

/** 密码正确 → 清零；密码错误 → 累加，达阈值即锁。 */
function notePasswordResult(store, ip, valid, now) {
    if (valid) {
        // 成功即清零：否则「成功一次后再错 9 次」会把自己锁住
        store.delete(ip);
        return { locked: false };
    }
    const rec = store.get(ip);
    const count = (rec && now - rec.start <= LOGIN_FAIL_WINDOW) ? rec.count + 1 : 1;
    const lockedUntil = count >= LOGIN_FAIL_MAX ? now + LOGIN_FAIL_WINDOW : 0;
    store.set(ip, { count, start: rec && now - rec.start <= LOGIN_FAIL_WINDOW ? rec.start : now, lockedUntil });
    return { locked: count >= LOGIN_FAIL_MAX };
}

function loginGuard(req, res, next) {
    const ip = resolveClientIp(req);
    const { locked, retryAfter } = checkLoginLock(loginFailMap, ip, Date.now());
    if (locked) {
        return res.status(429).json({
            error: `密码错误次数过多，请在 ${Math.ceil(retryAfter / 60)} 分钟后重试`,
            code: 'locked',
            retryAfter
        });
    }
    // 把 ip 传给密码校验环节，由 notePasswordResult 回写结果
    res.locals.loginIp = ip;
    next();
}

// 第 2 层：全站总量封顶。key 是固定字符串，不按 IP——单账号系统里 IP 维度
// 只带来误伤与绕过，层间也不该互相消耗配额。它防的是「大量 IP 各试一次、
// 始终不触发第 1 层锁定」的打法；代价是攻击者打满时你也会被挡一分钟，
// 这是封顶总量的必然代价，纯应用层无法既封顶又保证你一定进得来。
//
// 阈值必须**大于** LOGIN_FAIL_MAX 并留出足够余量：正常登录要留出余量
// （自己一次 + 若干次输错），更关键的是要让「第 1 层先触发」成为常态——
// 否则总量桶会先于单 IP 锁定触发，把「连续输错」变成「等一会儿再试」，
// 既让锁定功能形同虚设，也让正常用户先吃到全局桶的代价。
const GLOBAL_LOGIN_LIMIT = 30;         // 每分钟，明显高于单 IP 锁定阈值
const globalLoginMap = new Map();

function globalLoginLimit(req, res, next) {
    const { allowed, resetAt } = consumeRateLimit(
        globalLoginMap, 'global:login', Date.now(), 60000, GLOBAL_LOGIN_LIMIT
    );
    if (!allowed) {
        return res.status(429).json({
            error: '登录请求过于频繁，请稍后再试',
            code: 'global_limited',
            retryAfter: Math.ceil((resetAt - Date.now()) / 1000)
        });
    }
    next();
}

const defaultConfig = {
    theme: 'auto',
    searchEngine: 'google',
    showBookmarkIcons: true,
    categories: [
        {
            id: 'cat_1',
            name: '论坛',
            bookmarks: [
                { id: 'bm_1', title: 'V2EX', url: 'https://v2ex.com' },
                { id: 'bm_2', title: 'Reddit', url: 'https://reddit.com' },
                { id: 'bm_3', title: 'Hacker News', url: 'https://news.ycombinator.com' }
            ]
        },
        {
            id: 'cat_2',
            name: '视频',
            bookmarks: [
                { id: 'bm_4', title: 'YouTube', url: 'https://youtube.com' },
                { id: 'bm_5', title: 'Bilibili', url: 'https://bilibili.com' },
                { id: 'bm_6', title: 'Netflix', url: 'https://netflix.com' }
            ]
        },
        {
            id: 'cat_3',
            name: 'AI',
            bookmarks: [
                { id: 'bm_7', title: 'ChatGPT', url: 'https://chat.openai.com' },
                { id: 'bm_8', title: 'Claude', url: 'https://claude.ai' },
                { id: 'bm_9', title: 'Gemini', url: 'https://gemini.google.com' }
            ]
        }
    ],
    searchEngines: [
        { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
        { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=' },
        { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
        { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' }
    ]
};

const defaultFavorites = {
    version: 1,
    favorites: []
};

/**
 * 模块平台配置。全部是扁平数组，没有嵌套对象——
 * 嵌套结构在这个文件里语义不对：它整体读、整体写，不参与 mergeConfig 的浅合并。
 */
const defaultModulesConfig = {
    version: 1,
    enabledModules: [],
    widgets: [],
    servers: [],
    socialAccounts: [],
    symbols: [],
    // 首页轮询周期（秒）。不在白名单里的值会回落到默认——
    // 这是唯一允许的取值来源，前端与服务端共用同一份。
    pollInterval: 15
};

/**
 * 承载用户数据或凭据的文件，权限统一收到 600。
 *
 * 不依赖 sylph.sh 的 chmod：`.admin-password.json` 等文件是**应用**在首次启动时才创建的，
 * 脚本里的 `[ -f ... ] && chmod` 跑在它们存在之前，等于空操作——实测全新安装后密码哈希
 * 与私密书签都是 644，反而是本次新增的会话库为 600。
 */
const PRIVATE_FILES = [CONFIG_FILE, FAVORITES_FILE, PASSWORD_FILE, WEBDAV_CONFIG_FILE, MODULES_FILE];

/** 兜底校正既有安装：老版本写下的文件可能仍是 644，每次启动收敛一次。 */
async function restrictPrivateFileModes() {
    await Promise.all(PRIVATE_FILES.map(async file => {
        try {
            await fs.chmod(file, 0o600);
        } catch {
            // 尚未创建，例如未配置 WebDAV 时的 .webdav-config.json
        }
    }));
}

async function ensureFile(file, defaultData) {
    try {
        await fs.access(file);
    } catch {
        await writeJSON(file, defaultData);
        console.log(`Created: ${path.basename(file)}`);
    }
}

async function readJSON(file) {
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data);
}

/** 只用于 PRIVATE_FILES 里的文件：写完立即收紧，不留 644 窗口。 */
async function writeJSON(file, data) {
    await fs.writeFile(file, JSON.stringify(data, null, 2));
    await fs.chmod(file, 0o600);
}

async function verifyPassword(password) {
    if (!password) return false;
    try {
        const { passwordHash } = await readJSON(PASSWORD_FILE);
        return await bcrypt.compare(password, passwordHash);
    } catch {
        return false;
    }
}

// ========== 会话 ==========

// 标准部署由 nginx 终止 TLS，Node 收到的是明文 HTTP，req.secure 恒为 false。
// 正确判据是反代回填的 X-Forwarded-Proto；已开 trust proxy=1，丢弃客户端自带的值。
function isHttps(req) {
    if (config.server.https.enabled) return true;
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// 会话存储改由 SQLite 承载：进程内 Map 会随重启清空，登录态因此丢失。
// 这里只声明，实例在 init() 打开数据库后创建——路由闭包与 60 秒清扫定时器
// 都在 init() 完成之后才读它（定时器只在首次触发时读取）。
let db;
let sessionStore;

// 会话相关的响应带 Accept-CH（高熵 Client Hints 需要它才会被发送）。
// 只在这些响应上下发，不放静态资源与 /api/config 上，避免拖累首页首屏。
function setSessionHeaders(res) {
    res.setHeader('Accept-CH', ACCEPT_CH);
    res.setHeader('Cache-Control', 'no-store');
}

function unauthorized(res, reason) {
    if (reason && reason.code) {
        return res.status(401).json({ error: ENV_CHANGED_MESSAGE, code: reason.code });
    }
    return res.status(401).json({ error: '未登录或登录已过期' });
}

/**
 * 统一管理端守卫。会话命中即放行（零 bcrypt）；否则回退到明文密码，
 * 保证已打开的旧页面仍可用。环境变化导致的登出由 reason 透传给调用方。
 */
async function requireAdmin(req, res, next) {
    req.sessionReason = {};
    const found = sessionStore.getSession(req, req.sessionReason);
    if (found) {
        req.adminSession = found;
        sessionStore.refreshSessionCookie(res, found, req);
        return next();
    }
    if (await verifyPassword(req.headers['x-admin-password'])) return next();
    return unauthorized(res, req.sessionReason);
}

/**
 * 环境变化的信号怎么传给客户端。
 *
 * 401 一律走 unauthorized()，靠 body 里的 code 区分。但两处「软门」
 * （/api/config、/api/favorites）必须返回 200 + 公开视图，否则未登录用户
 * 每次刷新首页都会看到报错。它们此前把 reason 丢掉，于是环境变化后
 * 客户端只拿到一个被截断的公开列表，既不知道发生了登出，私密检索
 * 也会对着残缺数据报「无匹配」。这里改用响应头携带，由客户端统一识别。
 */
const ENV_CHANGED_HEADER = 'X-Session-Env-Changed';

function noteEnvChanged(res, reason) {
    if (reason && reason.code) res.setHeader(ENV_CHANGED_HEADER, reason.code);
}

// 两处「软门」：命中即返回全量，否则返回公开视图，不返回 401。
async function hasAdminAccess(req) {
    const reason = {};
    const found = sessionStore.getSession(req, reason);
    if (found) return { ok: true, reason };
    if (await verifyPassword(req.headers['x-admin-password'])) return { ok: true, reason };
    return { ok: false, reason };
}

async function init() {
    const logDir = config.paths.logs;
    if (!fsSync.existsSync(logDir)) {
        await fs.mkdir(logDir, { recursive: true });
        console.log(`Created: ${path.basename(logDir)}/`);
    }

    await ensureFile(CONFIG_FILE, defaultConfig);
    await ensureFile(FAVORITES_FILE, defaultFavorites);
    await ensureFile(MODULES_FILE, defaultModulesConfig);
    await ensureFile(PASSWORD_FILE, {
        passwordHash: await bcrypt.hash(config.security.defaultPassword, 10)
    });

    // 老版本写下的这几个文件可能仍是 644（脚本的 chmod 跑在它们创建之前），
    // 每次启动收敛一次；本次新建的已在 writeJSON 里就收紧。
    await restrictPrivateFileModes();

    // 打开（必要时创建）SQLite 库并跑完迁移，再据此构造会话存储。
    // 顺序固定：迁移必须先于 createSqliteBackend 的 prepare，否则表还不存在。
    db = openDatabase(config.paths.database);
    sessionStore = new SessionStore({
        cookieName: config.security.sessionCookieName,
        ttlTrusted: config.security.sessionTtlTrusted,
        ttlDefault: config.security.sessionTtlDefault,
        cookieSecure: config.security.cookieSecure,
        isHttps,
        getClientIp: req => resolveClientIp(req),
        geoEnabled: config.security.geoEnabled,
        geoScope: config.security.geoScope,
        geoDatabase: config.security.geoDatabase,
        backend: createSqliteBackend(db)
    });
}

// 这条软门在无会话时会跑一次 bcrypt 比对，而匿名访问必走这条路。
// 不限流的话，伪造的 X-Admin-Password 就能把每次请求从约 7ms 抬到 63ms
// （约 9 倍 CPU），且完全无需认证。匿名也要能读首页，因此用独立限流桶。

// 供浏览器读**服务级**配置的只读端点。
//
// ⚠️ 为什么单开一个而不塞进 /api/config：
// `/api/config` 返回的是 **config.json**（用户的公开配置：主题、分类、
// 搜索引擎），而 `selfSignedCert` 住在**服务配置**里
// （`server-config/defaults.js` 的 security 段，与 cookieSecure 同级）——
// 两个文件是两套东西。所以那条字段从 `/api/config` 永远读不到，
// 前端只能拿到 undefined，而界面看起来一切正常。
// （浏览器实测发现：单元测试全绿，因为没有任何一条断言它真的被下发。）
//
// ⚠️ 只回**这一个布尔**：整个 security 段里有 defaultPassword、
// adminPasswordFile 那些绝不能下发的字段。这里的东西必须是
// 「即使公开也无害」且「前端确实需要」。
app.get('/api/server-flags', publicReadLimit, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json({
        selfSignedCert: config.security.selfSignedCert === true
    });
});

/**
 * 改服务级配置里那几个后台能调的开关。
 *
 * ⚠️ 为什么不用 `POST /api/config`：那个端点只写 **config.json**
 * （用户的公开配置），而这些开关住在 **server-config.json**（服务配置，
 * 覆盖 defaults.js 的默认值）。两个文件是两套东西，往错的那个写会
 * 「保存成功但下次启动就没了」。
 *
 * ⚠️ 为什么不用直接改内存里的 `config`：它被 Object.freeze 了
 * （server-config/index.js 的末尾），而且改内存不落盘，重启即丢。
 * 这里写文件；下次启动由 loadFromConfigFile() 读回来。
 *
 * ⚠️ 白名单式：只接受明确列出的键。整个 security 段里有 defaultPassword
 * 与 adminPasswordFile，那两个绝不能从这个端点被改——它是 requireAdmin
 * 保护的，但白名单让「将来加了新键」不会自动变成「可被网页改写」。
 */
const WRITABLE_SERVER_FLAGS = new Set(['selfSignedCert']);

app.post('/api/server-flags', rateLimit, requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const updates = {};
        for (const [key, value] of Object.entries(body)) {
            if (!WRITABLE_SERVER_FLAGS.has(key)) {
                return res.status(400).json({
                    error: `不允许修改 ${key}（可改的：${[...WRITABLE_SERVER_FLAGS].join(', ')}）`
                });
            }
            if (typeof value !== 'boolean') {
                return res.status(400).json({ error: `${key} 必须是布尔值` });
            }
            updates[key] = value;
        }
        if (!Object.keys(updates).length) {
            return res.status(400).json({ error: '没有可修改的项' });
        }

        const file = path.join(config.rootDir, 'server-config.json');
        // 只写用户改动的那一段即可：这个文件在 require 侧已不再遮蔽 server-config/ 目录
        // （见文件顶部对 './server-config/index.js' 显式路径的说明），
        // index.js 会把它合并到 defaults 之上，缺的段由默认值补齐。
        // 不要试图把整份配置写进来——defaults 里没有 rootDir（它由 index.js 单独赋值），
        // 写全也补不出它，反而把 defaultPassword 之类的默认值落到磁盘上。
        let existing = {};
        try {
            existing = JSON.parse(await fs.readFile(file, 'utf8'));
        } catch {
            // 文件不存在是正常路径：第一次通过网页改设置
        }
        // 文件内容若是数组/null/标量，先归位再写，否则会写出形状不对的 JSON。
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
            existing = {};
        }
        if (!existing.security || typeof existing.security !== 'object' || Array.isArray(existing.security)) {
            existing.security = {};
        }
        Object.assign(existing.security, updates);
        await writeJSON(file, existing);

        // 内存里那份是冻结的，不能改 —— 所以前端要立刻生效就得刷新。
        // 这里明确告知，而不是假装已经生效。
        res.json({ success: true, ...updates, needsReload: true });
    } catch (err) {
        console.error('保存服务配置失败:', err);
        res.status(500).json({ error: '保存失败: ' + err.message });
    }
});

app.get('/api/config', publicReadLimit, async (req, res) => {
    try {
        // 允许浏览器缓存但每次用 ETag 校验：配置未变时返 304（零响应体），
        // 省去首屏往返的传输量，又保证配置始终最新。客户端以
        // cache: 'no-cache' 发起（见 index.html），二者配合才生效。
        res.setHeader('Cache-Control', 'no-cache');
        const cfg = await readJSON(CONFIG_FILE);
        // 会话或正确管理密码时返回完整配置，供管理面板读取 privacyMode
        const access = await hasAdminAccess(req);
        if (access.ok) {
            return res.json(cfg);
        }
        noteEnvChanged(res, access.reason);
        res.json(toPublicConfig(cfg));
    } catch (err) {
        console.error('读取配置失败:', err);
        res.status(500).json({ error: '读取配置失败' });
    }
});

app.post('/api/config', rateLimit, requireAdmin, async (req, res) => {
    try {
        const cfg = req.body;
        if (!cfg.categories || !Array.isArray(cfg.categories)) {
            return res.status(400).json({ error: '无效的配置格式' });
        }

        // 客户端持有的配置来自公开视图，不含 privacyMode，
        // 整份覆盖会静默抹掉该设置，因此以现有文件为基底合并。
        let existing = {};
        try {
            existing = await readJSON(CONFIG_FILE);
        } catch {}

        await writeJSON(CONFIG_FILE, mergeConfig(existing, cfg));
        res.json({ success: true });
    } catch (err) {
        console.error('保存配置失败:', err);
        res.status(500).json({ error: '保存配置失败' });
    }
});

// 登录入口：三层依次是「IP 请求速率 → 失败锁定 → 全站总量」。
// 顺序不能调换：失败锁定排在总量封顶之前，且总量阈值必须高于单 IP 锁定阈值，
// 否则总量桶先触发，锁定功能形同虚设（详见 globalLoginLimit 上方注释）。
app.post('/api/verify-password', rateLimit, loginGuard, globalLoginLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    const valid = await verifyPassword(password);
    notePasswordResult(loginFailMap, res.locals.loginIp, valid, Date.now());
    if (valid) {
        // 登录即换发新会话令牌（OWASP：权限级别变化后必须换发会话 ID）
        const token = sessionStore.issueSession(res, req, false);
        if (!token) {
            // 会话数已满：明确报错，不静默驱逐他人仍在有效期内的登录
            return res.status(503).json({ error: '登录会话过多，请稍后再试' });
        }
        setSessionHeaders(res);
    }
    res.json({ valid });
});

// 首屏静默确认登录态。未登录返回 200 + { authenticated:false } 而非 401，
// 避免未访问者把整个首页渲染成错误态。
// 仍然要把 env_changed 透出去：页面加载时这是客户端唯一发的请求，
// 若不告诉它「你刚被环境变化登出」，用户只会看到一个无来由的登录框。
// 它每次首屏都调，不该消耗登录配额；会话命中时也不跑 bcrypt，档位可放宽。
app.get('/api/session', publicReadLimit, async (req, res) => {
    setSessionHeaders(res);
    const reason = {};
    const found = sessionStore.getSession(req, reason);
    if (!found) {
        noteEnvChanged(res, reason);
        return res.json({ authenticated: false, trusted: false });
    }
    sessionStore.refreshSessionCookie(res, found, req);
    res.json({
        authenticated: true,
        trusted: found.session.trusted,
        expiresAt: found.session.expiresAt
    });
});

// 信任此设备：设置当前会话的可信状态。
// body.trusted 为 true 时升级为 30 天滑动续期，false 时降回 24 小时。
// 缺省为 true，兼容只在登录时勾选「信任此设备」的旧客户端。
// **取消信任不登出**：用户当前仍处于登录态，只是有效期回到 24 小时。
app.post('/api/trust-device', rateLimit, requireAdmin, async (req, res) => {
    setSessionHeaders(res);
    const token = readCookie(req, config.security.sessionCookieName);
    if (!token) {
        // 明文密码登录的旧客户端没有会话可调整，前端会重新登录后再试
        return res.json({ trusted: false, requiresLogin: true });
    }
    const trusted = req.body?.trusted !== false;
    const session = sessionStore.setTrusted(token, trusted);
    if (!session) return unauthorized(res, {});
    sessionStore.setSessionCookie(res, { token, expiresAt: session.expiresAt }, req);
    res.json({ trusted: session.trusted, expiresAt: session.expiresAt });
});

// 登出：服务端销毁会话 + 清 Cookie。
// **不发 Clear-Site-Data。** 该头作用于整个源（Chrome 还覆盖可注册域），
// 一个跨站表单 POST 就能触发，把用户在该站所有 Cookie 一次清空——
// 受害者会陷入「一访问就被登出」的循环。显式清掉会话 Cookie 已经足够。
// 必须带一个真实会话：否则它就是个无凭据也能调的端点，还能烧掉
// 登录接口共用的限流桶。幂等语义由「有无会话都清 Cookie」保证。
app.post('/api/logout', rateLimit, async (req, res) => {
    const reason = {};
    const found = sessionStore.getSession(req, reason);
    if (found) sessionStore.destroy(found.token);
    sessionStore.clearSessionCookie(res, req);
    setSessionHeaders(res);
    res.json({ success: true });
});

/**
 * 用新密码重新加密所有依赖密码派生的凭据。
 *
 * 修复前的行为：改密码直接覆盖 .admin-password.json，而 WebDAV 密码是用
 * 旧密码哈希派生的密钥加密的——改完之后**再也解不开**，只能重新填一次，
 * 且没有任何提示。模块的 agent token 会踩同一个坑，所以在这里一起处理。
 *
 * 三条纪律：
 *  1. **先全部算完再落盘**。边解密边写会出现「密码改了、凭据只重加密了一半」，
 *     而那一半永久无法恢复。
 *  2. 任何一项失败就整体放弃，密码文件也不写——宁可让用户再点一次。
 *  3. 明文只在内存里经过，不写中间文件、不进日志。
 *
 * @returns {Promise<{reencrypted:number, details:string[]}>}
 */
async function reencryptCredentials(oldHash, newHash) {
    const details = [];
    let reencrypted = 0;

    // 1) WebDAV 密码
    let webdavRaw = null;
    try {
        webdavRaw = await readJSON(WEBDAV_CONFIG_FILE);
    } catch {
        webdavRaw = null;
    }
    if (webdavRaw && isEnvelope(webdavRaw.password)) {
        try {
            const plain = decrypt(webdavRaw.password, oldHash, 'webdav');
            webdavRaw.password = encrypt(plain, newHash, 'webdav');
            reencrypted++;
            details.push('WebDAV 密码');
        } catch (e) {
            // 旧密文本身已解不开（可能更早改过密码）：不能挡着改密码，
            // 保留原样并记录，让用户在该分区看到需要重新输入。
            details.push('WebDAV 密码（无法解密，已保留原值）');
        }
    }

    // 2) 模块 agent token
    let modulesRaw = null;
    try {
        modulesRaw = await readJSON(MODULES_FILE);
    } catch {
        modulesRaw = null;
    }
    if (modulesRaw && Array.isArray(modulesRaw.servers)) {
        for (const server of modulesRaw.servers) {
            if (!server || !isEnvelope(server.token)) continue;
            try {
                const plain = decrypt(server.token, oldHash, 'modules');
                server.token = encrypt(plain, newHash, 'modules');
                reencrypted++;
                details.push(`${server.name || server.id} 的凭据`);
            } catch (e) {
                details.push(`${server.name || server.id} 的凭据（无法解密，已保留原值）`);
            }
        }
    }

    // 全部算完才写。writeJSON 各自 chmod 600，与首次创建时同一套收紧。
    if (webdavRaw) await writeJSON(WEBDAV_CONFIG_FILE, webdavRaw);
    if (modulesRaw) await writeJSON(MODULES_FILE, modulesRaw);

    return { reencrypted, details };
}

// 改密码必须重新验证**当前密码**，会话 Cookie 不足以授权。
// 密码是这里唯一的根凭据：只凭一个会话就改掉它，等于让任何拿到会话的人
// 完成账号接管，而且受害者改完密码反而把自己锁在门外。
// OWASP Authentication Cheat Sheet 要求凭据变更前重新认证。
app.post('/api/change-password', rateLimit, requireAdmin, async (req, res) => {
    const { newPassword, currentPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: '新密码至少8位' });
    }

    // 优先取当前密码；不传时回落到旧版放在请求头的写法。
    const provided = currentPassword || req.headers['x-admin-password'];
    if (!provided) {
        return res.status(401).json({ error: '请输入当前密码' });
    }
    if (!await verifyPassword(provided)) {
        return res.status(401).json({ error: '当前密码错误' });
    }

    try {
        const oldHash = await getPasswordHash();
        const passwordHash = await bcrypt.hash(newPassword, 10);

        // 先把凭据重算完。失败就整体放弃，密码文件一个字都不写——
        // 「密码改了、凭据只迁移了一半」是不可恢复的状态。
        let migration = { reencrypted: 0, details: [] };
        if (oldHash) {
            try {
                migration = await reencryptCredentials(oldHash, passwordHash);
            } catch (err) {
                console.error('凭据重加密失败，密码未修改:', err);
                return res.status(500).json({
                    error: '凭据重新加密失败，密码未修改。请检查磁盘写入权限后重试。'
                });
            }
        }

        await writeJSON(PASSWORD_FILE, { passwordHash });
        // 换密码后终止全部会话（含本会话），否则已泄露的令牌仍能继续用，
        // 这个补救动作就失去意义。客户端已无凭据可重放，需重新登录。
        const revoked = sessionStore.destroyAll();
        console.log(`[Server] 密码已修改，终止 ${revoked} 个会话`
            + (migration.reencrypted ? `，重加密 ${migration.reencrypted} 项凭据` : ''));
        sessionStore.clearSessionCookie(res, req);
        // details 告诉前端哪些凭据没能迁移——不能静默：用户不知道
        // WebDAV 与 agent 需要重新填 token，就会在某次备份时才撞上。
        res.json({ success: true, reauth: true, credentials: migration });
    } catch (err) {
        console.error('修改密码失败:', err);
        res.status(500).json({ error: '修改密码失败' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== Version API ==========

// 获取版本信息
app.get('/api/version', async (req, res) => {
    try {
        const versionFile = path.join(config.rootDir, 'version.json');
        const data = await readJSON(versionFile);
        res.json(data);
    } catch (err) {
        // 如果文件不存在，返回默认版本
        res.json({ version: '1.0.0', releaseDate: null });
    }
});

// 获取更新日志
app.get('/api/changelog', async (req, res) => {
    try {
        const changelogFile = path.join(config.rootDir, 'CHANGELOG.json');
        const data = await readJSON(changelogFile);
        res.json(data);
    } catch (err) {
        res.json({ versions: [] });
    }
});

// ========== Favorites API ==========

// 解析 Netscape Bookmark HTML 格式（Chrome/Edge/Firefox/Safari 通用）
function parseBookmarkHtml(html) {
    const results = [];
    let currentCategory = '未分类';
    const lines = html.split('\n');

    for (const line of lines) {
        // 检查是否是分类标题 <H3>...</H3>
        const folderMatch = /<H3[^>]*>([^<]+)<\/H3>/i.exec(line);
        if (folderMatch) {
            currentCategory = folderMatch[1].trim();
            continue;
        }

        // 检查是否是书签链接 <A HREF="..." ...>title</A>
        const linkMatch = /<A\s+HREF="([^"]+)"([^>]*)>([^<]+)<\/A>/i.exec(line);
        if (linkMatch) {
            const url = linkMatch[1];
            const title = linkMatch[3].trim();
            const privateMarker = /\bDATA-SYLPH-PRIVATE="([^"]*)"/i.exec(linkMatch[2]);

            // 跳过无效 URL
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                continue;
            }

            results.push({
                id: 'fav_' + Math.random().toString(36).slice(2, 11),
                title,
                url,
                description: '',
                category: currentCategory,
                tags: [],
                private: privateMarker?.[1] === '1',
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        }
    }

    return results;
}

// 生成 Netscape Bookmark HTML 格式（可导入到任何浏览器）
function generateBookmarkHtml(favorites) {
    const now = Math.floor(Date.now() / 1000);

    // 按分类分组
    const byCategory = {};
    for (const fav of favorites) {
        const cat = fav.category || '未分类';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(fav);
    }

    let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

    for (const [category, items] of Object.entries(byCategory)) {
        html += `    <DT><H3 ADD_DATE="${now}">${escapeHtml(category)}</H3>\n`;
        html += `    <DL><p>\n`;
        for (const item of items) {
            const addDate = Math.floor((item.createdAt || Date.now()) / 1000);
            const privateMarker = item.private ? ' DATA-SYLPH-PRIVATE="1"' : '';
            html += `        <DT><A HREF="${escapeHtml(item.url)}" ADD_DATE="${addDate}"${privateMarker}>${escapeHtml(item.title)}</A>\n`;
        }
        html += `    </DL><p>\n`;
    }

    html += `</DL><p>\n`;
    return html;
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ========== 公开视图 ==========
// 匿名请求只返回首页需要渲染的部分。管理端设置和私密书签不下发，
// 浏览器端的隐藏状态不构成访问控制。

function toPublicConfig(cfg) {
    const { privacyMode, ...rest } = cfg || {};
    return rest;
}

function toPublicFavorites(data) {
    const list = Array.isArray(data?.favorites) ? data.favorites : [];
    return {
        version: data?.version || 1,
        favorites: list
            .filter(fav => fav && !fav.private)
            .map(({ private: _private, ...rest }) => rest)
    };
}

// 按 id 合并书签写入。客户端可能只持有公开子集（私密条目不下发），
// 因此既有的私密条目在请求体缺席时必须保留，不能当作删除。
function mergeFavorites(existing, incoming) {
    const current = Array.isArray(existing?.favorites) ? existing.favorites : [];
    const updates = Array.isArray(incoming) ? incoming : [];
    const byId = new Map(current.map(fav => [fav.id, fav]));
    const submitted = new Set(updates.map(fav => fav.id).filter(Boolean));

    const merged = current.filter(fav => {
        if (submitted.has(fav.id)) return true;
        return fav.private === true;
    });

    for (const fav of updates) {
        if (fav && fav.id && byId.has(fav.id)) {
            const index = merged.findIndex(item => item.id === fav.id);
            if (index >= 0) merged[index] = fav;
        } else if (fav) {
            merged.push(fav);
        }
    }

    return merged;
}

// 合并配置写入。公开视图不携带 privacyMode，客户端回传的配置里没有它，
// 直接整份覆盖会静默抹掉该设置。
function mergeConfig(existing, incoming) {
    return { ...(existing || {}), ...(incoming || {}) };
}

// ========== 模块平台配置 ==========
// 与 config.json 分离的两条理由：那里的新 key 默认经 toPublicConfig 下发给
// 匿名用户，而 mergeConfig 是顶层浅合并、嵌套对象会被客户端旧副本整块覆盖。
// 所以模块配置不进 config.json，也不共享它的保存按钮。

const WIDGET_SIDES = new Set(['left', 'right']);
const MODULES_CONFIG_MAX = 64 * 1024;

function asTrimmedString(value, max = 200) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, max);
}

/**
 * 首页轮询周期的可选值（秒）。
 * 白名单而非自由输入：周期直接决定请求频率，10 秒以下会撞管理端限流
 * （30 次/分钟），而 5 分钟以上与缓存 TTL 相同、失去意义。
 */
const POLL_INTERVALS = [10, 15, 30, 60, 300];

function resolvePollInterval(value) {
    const n = Number(value);
    return POLL_INTERVALS.includes(n) ? n : 15;
}

function normalizeWidget(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = asTrimmedString(raw.id, 64);
    if (!id) return null;
    const order = Number(raw.order);
    return {
        id,
        enabled: raw.enabled !== false,
        side: WIDGET_SIDES.has(raw.side) ? raw.side : 'left',
        order: Number.isFinite(order) ? order : 0,
        collapsed: raw.collapsed === true
    };
}

function normalizeServer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = asTrimmedString(raw.id, 64);
    const url = asTrimmedString(raw.url, 300);
    if (!id || !url) return null;
    // mode 决定采集方向：pull = 本服务去拉（默认），push = 目标机主动上报。
    // 只接受两个已知值，其它一律回落 'pull'——一个拼错的字段不该把机器
    // 静默切成推送。
    const mode = raw.mode === 'push' ? 'push' : 'pull';
    // reachable 是用户对「本服务能否直接连到这台机器」的回答。
    // 它不是自动推导的：服务器自己就架在家里时（NAS、小主机），
    // 按 IP 段猜私网会判错，而 100.64.x 与 127.0.0.1 都在那个判断的盲区里。
    const reachable = raw.reachable === false ? false : true;
    // deployState 只由服务端写入（探测端点），归一化不接收——
    // 否则一次拖拽保存就能把状态改成「已就绪」。
    return { id, name: asTrimmedString(raw.name, 60) || url, url, mode, reachable };
}

function normalizeStringList(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => asTrimmedString(item, 120))
        .filter(Boolean)
        .slice(0, 200);
}

/**
 * 校验请求体，返回规范化后的配置；形状不对时返回 null。
 * 这里是唯一的写入闸门：POST /api/config 只有一条 categories 检查，
 * 模块配置比它更严格，因为每个字段都会变成对外的轮询目标。
 *
 * **缺席的键不补默认值**：缺失的键在结果里保持 undefined，
 * 这样 mergeModulesConfig 才能区分「显式清空」与「没提交」。
 * 早先这里把缺失一律补成空数组，于是 merge 的保留分支永远走不到——
 * 单元测试直接调 merge 绕过了归一化，所以是真实服务端到端才发现的：
 * 只提交 widgets 的一次拖拽排序，把 servers 与 symbols 清空了。
 */
function normalizeModulesConfig(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const out = { version: 1 };

    // enabledModules 要被 URL 路径使用，白名单只允许已知形状的短 id
    if (body.enabledModules !== undefined) {
        out.enabledModules = [...new Set(normalizeStringList(body.enabledModules)
            .filter(id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)))];
    }
    if (body.widgets !== undefined) {
        out.widgets = (Array.isArray(body.widgets) ? body.widgets : [])
            .map(normalizeWidget)
            .filter(Boolean)
            .slice(0, 50);
    }
    if (body.servers !== undefined) {
        out.servers = (Array.isArray(body.servers) ? body.servers : [])
            .map(normalizeServer)
            .filter(Boolean)
            .slice(0, 20);
    }
    if (body.socialAccounts !== undefined) out.socialAccounts = normalizeStringList(body.socialAccounts);
    if (body.symbols !== undefined) out.symbols = normalizeStringList(body.symbols);
    if (body.pollInterval !== undefined) out.pollInterval = resolvePollInterval(body.pollInterval);

    return out;
}

/**
 * 判断这次写入是否改变了会影响采集缓存的输入。
 *
 * ⚠️ `pollInterval` 也在其中，而这是曾经漏掉的一项：TTL 是**跟着周期算出来的**
 * （周期 + 10s），但缓存行**不会因为 TTL 变小而提前失效**。于是用户把周期
 * 从 5 分钟改成 10 秒，TTL 确实算成了 20 秒，可那条已经写下的缓存行还能
 * 再活 5 分钟——「改完不生效」的现象。
 *
 * 而改大的方向恰好相反：周期从 10 秒改成 5 分钟时，清缓存让用户立刻多付
 * 一次全量采集，可下一次轮询本来也要采。这一侧清掉是划算的。
 */
function metricsInputsChanged(current, incoming) {
    if (!current || typeof current !== 'object') return true;
    if (incoming.pollInterval !== undefined
        && resolvePollInterval(incoming.pollInterval) !== resolvePollInterval(current.pollInterval)) {
        return true;
    }
    // servers 的比较在调用处做（要按 id 比，不能整体 JSON.stringify）
    return false;
}

/**
 * 按 id 合并模块配置写入。
 * 请求体里缺席的数组一律保留而非清空——拖拽排序只提交 widgets，
 * 若整份覆盖，用户调整一次布局就会把服务器列表清空。
 *
 * servers 额外按 id 逐条合并：读接口只回 `hasToken`、不回信封，
 * 所以客户端手里的 server 对象**没有** token 字段。若直接采纳请求体，
 * 每保存一次配置就会把所有已存的 token 抹掉。
 */
function mergeModulesConfig(existing, incoming) {
    const current = existing && typeof existing === 'object' ? existing : {};
    const pick = key => (incoming[key] !== undefined ? incoming[key] : current[key]);

    // 服务器：请求体里有这条就用它（但补回既有的 token），
    // 没提交（= 用户删了）才真的移除。
    let servers;
    if (incoming.servers !== undefined) {
        const existingById = new Map(
            (Array.isArray(current.servers) ? current.servers : []).map(s => [s.id, s]));
        servers = incoming.servers.map(server => {
            const previous = existingById.get(server.id);
            if (!previous) return server;
            // hasToken 为 true 但没有 token 字段 = 前端只回显了状态，
            // 此时保留原有的密文信封。pushSecretHash 同理：它只由服务端
            // 在"领取推送凭据"时写入，归一化不接收，所以只能在这里补回。
            // 若归一化顺手补了空串，下面的保留分支就永远走不到。
            return {
                ...server,
                token: previous.token,
                pushSecretHash: previous.pushSecretHash,
                // 证书同理：只由「注册」写入，归一化不接收。
                // 拖拽排序会走这条路径（提交整个 servers 列表），
                // 不补回就会把配对好的证书抹掉。
                certPem: previous.certPem,
                certFingerprint: previous.certFingerprint,
                enrolledAt: previous.enrolledAt,
                // 探测得出的部署状态同理：它是对外部世界的观测结果，
                // 不能被一次前端保存覆盖成「已就绪」。
                deployState: previous.deployState,
                stateProbedAt: previous.stateProbedAt
            };
        });
    } else {
        servers = current.servers || [];
    }

    return {
        version: 1,
        enabledModules: pick('enabledModules') || [],
        widgets: pick('widgets') || [],
        servers,
        socialAccounts: pick('socialAccounts') || [],
        symbols: pick('symbols') || [],
        // 缺席时沿用既有值（不回落默认）——前端保存布局时通常不提交这个键，
        // 无条件重置成 15 会让用户设过的周期被悄悄改掉
        pollInterval: resolvePollInterval(pick('pollInterval'))
    };
}

// 获取收藏夹里的书签
app.get('/api/favorites', publicReadLimit, async (req, res) => {
    try {
        const data = await readJSON(FAVORITES_FILE);
        // 会话或正确管理密码时返回全量列表，供管理面板与私密检索使用
        const access = await hasAdminAccess(req);
        if (access.ok) {
            return res.json({
                version: data?.version || 1,
                favorites: Array.isArray(data?.favorites) ? data.favorites : []
            });
        }
        // 环境变化时这里返回的是被截断的公开子集，必须让客户端知道，
        // 否则它会把残缺列表当成完整数据建索引，私密检索随即报「无匹配」。
        noteEnvChanged(res, access.reason);
        res.json(toPublicFavorites(data));
    } catch (err) {
        console.error('读取书签失败:', err);
        res.status(500).json({ error: '读取书签失败' });
    }
});

// 保存收藏夹里的书签
app.post('/api/favorites', rateLimit, requireAdmin, async (req, res) => {
    try {
        const { favorites } = req.body;
        if (!Array.isArray(favorites)) {
            return res.status(400).json({ error: '无效的数据格式' });
        }

        let existing = { favorites: [] };
        try {
            existing = await readJSON(FAVORITES_FILE);
        } catch {}

        const merged = mergeFavorites(existing, favorites);
        await writeJSON(FAVORITES_FILE, { version: 1, favorites: merged });
        res.json({
            success: true,
            privatePreserved: merged.filter(fav => fav.private === true).length
        });
    } catch (err) {
        console.error('保存书签失败:', err);
        res.status(500).json({ error: '保存书签失败' });
    }
});

// 导入浏览器书签
app.post('/api/favorites/import', rateLimit, requireAdmin, async (req, res) => {
    try {
        const { html, merge = true } = req.body;
        if (!html || typeof html !== 'string') {
            return res.status(400).json({ error: '无效的书签数据' });
        }

        // 解析 Netscape Bookmark HTML
        const imported = parseBookmarkHtml(html);

        let currentData = { favorites: [] };
        if (merge) {
            try {
                currentData = await readJSON(FAVORITES_FILE);
            } catch {}
        }

        // 去重合并（基于 URL）
        const existingUrls = new Set(currentData.favorites.map(f => f.url));
        let duplicates = 0;
        const newFavorites = [];

        for (const item of imported) {
            if (existingUrls.has(item.url)) {
                duplicates++;
            } else {
                existingUrls.add(item.url);
                newFavorites.push(item);
            }
        }

        currentData.favorites = [...currentData.favorites, ...newFavorites];
        await writeJSON(FAVORITES_FILE, { version: 1, favorites: currentData.favorites });

        res.json({
            success: true,
            imported: newFavorites.length,
            duplicates
        });
    } catch (err) {
        console.error('导入失败:', err);
        res.status(500).json({ error: '导入失败: ' + err.message });
    }
});

// 导出书签为 HTML
app.get('/api/favorites/export', rateLimit, requireAdmin, async (req, res) => {
    try {
        const data = await readJSON(FAVORITES_FILE);
        const html = generateBookmarkHtml(data.favorites || []);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="bookmarks.html"');
        res.send(html);
    } catch (err) {
        console.error('导出失败:', err);
        res.status(500).json({ error: '导出失败' });
    }
});

// ========== WebDAV Backup API ==========

// Helper to get password hash for WebDAV encryption
async function getPasswordHash() {
    try {
        const { passwordHash } = await readJSON(PASSWORD_FILE);
        return passwordHash;
    } catch {
        return null;
    }
}

// Get WebDAV config (password masked)
app.get('/api/webdav/config', rateLimit, requireAdmin, async (req, res) => {
    try {
        const passwordHash = await getPasswordHash();
        const webdav = new WebDAVBackup(WEBDAV_CONFIG_FILE, passwordHash);
        await webdav.loadConfig();
        res.json(webdav.getPublicConfig());
    } catch (err) {
        console.error('获取 WebDAV 配置失败:', err);
        res.status(500).json({ error: '获取配置失败' });
    }
});

// Save WebDAV config
app.post('/api/webdav/config', rateLimit, requireAdmin, async (req, res) => {
    try {
        const { url, username, password: webdavPassword, remotePath, enabled } = req.body;
        const passwordHash = await getPasswordHash();
        const webdav = new WebDAVBackup(WEBDAV_CONFIG_FILE, passwordHash);
        await webdav.loadConfig();

        const newConfig = { enabled: !!enabled };
        if (url !== undefined) newConfig.url = url;
        if (username !== undefined) newConfig.username = username;
        if (webdavPassword !== undefined && webdavPassword !== '') {
            newConfig.password = webdavPassword;
        }
        if (remotePath !== undefined) newConfig.remotePath = remotePath;

        await webdav.saveConfig(newConfig);
        res.json({ success: true, config: webdav.getPublicConfig() });
    } catch (err) {
        console.error('保存 WebDAV 配置失败:', err);
        res.status(500).json({ error: '保存配置失败: ' + err.message });
    }
});

// Test WebDAV connection
app.post('/api/webdav/test', rateLimit, requireAdmin, async (req, res) => {
    try {
        const passwordHash = await getPasswordHash();
        const webdav = new WebDAVBackup(WEBDAV_CONFIG_FILE, passwordHash);
        await webdav.loadConfig();

        if (!webdav.config.url) {
            return res.status(400).json({ error: '请先配置 WebDAV 服务器地址' });
        }

        const result = await webdav.testConnection();
        res.json(result);
    } catch (err) {
        console.error('WebDAV 连接测试失败:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Create backup
app.post('/api/webdav/backup', rateLimit, requireAdmin, async (req, res) => {
    try {
        const passwordHash = await getPasswordHash();
        const webdav = new WebDAVBackup(WEBDAV_CONFIG_FILE, passwordHash);
        await webdav.loadConfig();

        if (!webdav.config.url) {
            return res.status(400).json({ error: '请先配置 WebDAV 服务器' });
        }

        // Read current config and favorites
        const configData = await readJSON(CONFIG_FILE);
        let favoritesData = { favorites: [] };
        try {
            favoritesData = await readJSON(FAVORITES_FILE);
        } catch {}
        // 模块平台配置。丢了它，监控目标、每台的 token、顺序与显示开关全部重来，
        // 所以它必须跟配置、书签一起进备份。文件不存在时（旧版本）跳过。
        let modulesData = null;
        try {
            modulesData = await readJSON(MODULES_FILE);
        } catch {}

        // Get app version
        let appVersion = '1.0.0';
        try {
            const versionData = await readJSON(path.join(config.rootDir, 'version.json'));
            appVersion = versionData.version;
        } catch {}

        const result = await webdav.createBackup(configData, favoritesData, appVersion, generateBookmarkHtml, modulesData);

        // Auto cleanup: keep only latest 5 backups
        try {
            await webdav.cleanupOldBackups(5);
        } catch (cleanupErr) {
            console.error('自动清理旧备份失败:', cleanupErr.message);
        }

        res.json(result);
    } catch (err) {
        console.error('WebDAV 备份失败:', err);
        res.status(500).json({ error: '备份失败: ' + err.message });
    }
});

// List backups
app.get('/api/webdav/list', rateLimit, requireAdmin, async (req, res) => {
    try {
        const passwordHash = await getPasswordHash();
        const webdav = new WebDAVBackup(WEBDAV_CONFIG_FILE, passwordHash);
        await webdav.loadConfig();

        if (!webdav.config.url) {
            return res.status(400).json({ error: '请先配置 WebDAV 服务器' });
        }

        const result = await webdav.listBackups();
        res.json(result);
    } catch (err) {
        console.error('获取备份列表失败:', err);
        res.status(500).json({ error: '获取列表失败: ' + err.message });
    }
});

// Restore from backup
app.post('/api/webdav/restore', rateLimit, requireAdmin, async (req, res) => {
    try {
        const {
            configFile,
            bookmarksFile,
            modulesFile,
            legacyFile,
            restoreConfig = true,
            restoreBookmarks = true,
            restoreModules = true
        } = req.body;

        if (!configFile && !bookmarksFile && !modulesFile && !legacyFile) {
            return res.status(400).json({ error: '请选择要恢复的备份文件' });
        }

        const passwordHash = await getPasswordHash();
        const webdav = new WebDAVBackup(WEBDAV_CONFIG_FILE, passwordHash);
        await webdav.loadConfig();

        if (!webdav.config.url) {
            return res.status(400).json({ error: '请先配置 WebDAV 服务器' });
        }

        const result = await webdav.restoreBackup({
            configFile,
            bookmarksFile,
            modulesFile,
            legacyFile,
            restoreConfig,
            restoreBookmarks,
            restoreModules
        });

        // Write restored data
        if (result.data.config && restoreConfig) {
            await writeJSON(CONFIG_FILE, result.data.config);
        }

        if (result.data.favorites && restoreBookmarks) {
            await writeJSON(FAVORITES_FILE, result.data.favorites);
        }

        // Parse and restore bookmarks from HTML if present
        if (result.data.bookmarksHtml && restoreBookmarks) {
            const imported = parseBookmarkHtml(result.data.bookmarksHtml);
            await writeJSON(FAVORITES_FILE, { version: 1, favorites: imported });
        }

        // 模块配置。token 保持密文原样写回——换机器时用同一个管理员密码
        // 才能解开，所以这里不做任何转换。恢复后要重置内存里的配置与缓存，
        // 否则页面还拿着恢复前的服务器列表。
        let modulesRestored = false;
        if (result.data.modules && restoreModules) {
            await writeJSON(MODULES_FILE, result.data.modules);
            modulesRestored = true;
        }

        res.json({
            success: true,
            message: modulesRestored ? '恢复成功（含模块配置）' : '恢复成功',
            restoredConfig: !!(result.data.config && restoreConfig),
            restoredBookmarks: !!(result.data.favorites || result.data.bookmarksHtml) && restoreBookmarks,
            restoredModules: modulesRestored,
            createdAt: result.createdAt,
            appVersion: result.appVersion
        });
    } catch (err) {
        console.error('WebDAV 恢复失败:', err);
        res.status(500).json({ error: '恢复失败: ' + err.message });
    }
});

// Delete backup file
app.post('/api/webdav/delete', rateLimit, requireAdmin, async (req, res) => {
    try {
        const { filename } = req.body;
        if (!filename) {
            return res.status(400).json({ error: '请指定要删除的文件' });
        }

        const passwordHash = await getPasswordHash();
        const webdav = new WebDAVBackup(WEBDAV_CONFIG_FILE, passwordHash);
        await webdav.loadConfig();

        if (!webdav.config.url) {
            return res.status(400).json({ error: '请先配置 WebDAV 服务器' });
        }

        await webdav.deleteBackup(filename);
        res.json({ success: true });
    } catch (err) {
        console.error('删除备份失败:', err);
        res.status(500).json({ error: '删除失败: ' + err.message });
    }
});

// ========== 模块平台 API ==========
// 三个端点全部是特权路由：模块配置与采集值不进公开视图，
// 匿名用户连"有哪些服务器在监控"都不该看到。

const METRICS_CACHE_KEY = 'local';
// 兜底 TTL。实际用 resolveCacheTtl()：它跟着用户设的轮询周期走。
const METRICS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 缓存 TTL 跟着轮询周期走。
 *
 * 固定 5 分钟会让「把周期改成 10 秒」变成一句空话——前端每 10 秒问一次，
 * 服务端 5 分钟内都拿同一份缓存返回。实测里用户设了短周期却看不到更实时的数据，
 * 根因就是这里。
 *
 * 取 `周期 + 10s` 而不是等于周期：等于周期时，两个轮询刚好落在 TTL 边界外，
 * 永远拿不到新值。10 秒的余量让边界错开。
 */
function resolveCacheTtl(pollIntervalSeconds) {
    const seconds = resolvePollInterval(pollIntervalSeconds);
    // 下限 20 秒、上限 5 分钟：太短会每次请求都重采（顺带把目标机也拖住）
    return Math.min(300, Math.max(20, seconds + 10)) * 1000;
}

/** 读当前配置里的轮询周期（秒），供采集端算 TTL。 */
async function readPollInterval() {
    try {
        const config = await readJSON(MODULES_FILE);
        return resolvePollInterval(config?.pollInterval);
    } catch {
        return 15;
    }
}

function readCacheRow(db, key) {
    const row = db.prepare('SELECT payload, updated_at FROM module_cache WHERE key = ?').get(key);
    if (!row) return null;
    try {
        return { value: JSON.parse(row.payload), updatedAt: row.updated_at };
    } catch {
        return null;
    }
}

function writeCacheRow(db, key, value, now) {
    db.prepare(
        'INSERT INTO module_cache (key, payload, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at'
    ).run(key, JSON.stringify(value), now);
}

/**
 * 让采集缓存失效。
 *
 * 缓存 TTL 是 5 分钟，但它缓存的是「上次采到了什么」，而采集的目标由配置决定。
 * 改完服务器列表不清缓存的话，下一次轮询拿到的仍是**改动之前**那份采集结果——
 * 症状是「新加的机器不出现、删掉的还在」，而且要等满 5 分钟才自愈。
 *
 * 用户实测时正是这样看到的：配好了四台机器，首页仍只有一张空卡片。
 * 配置是缓存的输入，输入变了就必须让缓存失效——这不是优化，是正确性。
 */
function invalidateMetricsCache() {
    try {
        if (db) db.prepare('DELETE FROM module_cache WHERE key = ?').run(METRICS_CACHE_KEY);
    } catch (err) {
        // 缓存清不掉不该阻断配置保存——配置已落盘，下一次采集自己会覆盖
        console.error('清除监控缓存失败:', err);
    }
}

app.get('/api/modules/config', rateLimit, requireAdmin, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const config = await readJSON(MODULES_FILE).catch(() => defaultModulesConfig);
        // token 只出不来：回一个 hasToken 布尔即可，前端显示「已配置」。
        // 把信封原样回给前端等于把密文也交出去——虽然解不开，
        // 但没必要让浏览器拿到本不该有的数据。
        res.json({
            ...config,
            // 证书 PEM 不回给前端：它不是秘密，但有 1KB+ 且前端用不到。
            // 前端只需要知道「注册过没有」，据此显示状态而不是让用户
            // 反复重新部署同一台机器。
            //
            // 部署令牌的三件套（哈希 / 过期时间 / 期望 IP）也一并摘掉——
            // 令牌哈希落到浏览器毫无用处，而过期时间会让人以为
            // 「还有个令牌在生效」。
            servers: (config.servers || []).map(({
                token, pushSecretHash, certPem,
                enrollTokenHash, enrollTokenExpiresAt, enrollTokenIp,
                ...rest
            }) => ({
                ...rest,
                // 凭据只出状态不回明文：把信封原样回给前端等于
                // 把密文也交出去——虽然解不开，但没必要让浏览器拿到
                // 本不该有的数据。hasToken/hasPushSecret 让界面能显示
                // 「已配置」，而空白提交仍表示保持原值。
                hasToken: isEnvelope(token),
                hasPushSecret: Boolean(pushSecretHash),
                // enrolled = 有没有注册过。这是卡片上「未部署 / 已就绪」
                // 那条线的依据，由 probeTcp 的三态进一步细化。
                enrolled: Boolean(certPem || rest.enrolledAt),
                // 令牌是否已签发（不含明文）：界面据此决定显示
                // 「复制命令」还是「重新生成令牌」
                hasEnrollToken: Boolean(enrollTokenHash) && enrollTokenExpiresAt > Date.now(),
                certFingerprint: rest.certFingerprint || null
            }))
        });
    } catch {
        // 文件缺失时回落到默认值，而不是 500——配置丢了不该让模块整体不可用
        res.json(defaultModulesConfig);
    }
});

app.post('/api/modules/config', rateLimit, requireAdmin, async (req, res) => {
    try {
        if (JSON.stringify(req.body ?? {}).length > MODULES_CONFIG_MAX) {
            return res.status(413).json({ error: '配置过大' });
        }

        const normalized = normalizeModulesConfig(req.body);
        if (!normalized) {
            return res.status(400).json({ error: '无效的模块配置格式' });
        }

        let existing = {};
        try {
            existing = await readJSON(MODULES_FILE);
        } catch {
            existing = defaultModulesConfig;
        }

        const merged = mergeModulesConfig(existing, normalized);
        await writeJSON(MODULES_FILE, merged);

        // 服务器列表变了才清缓存：这条路由也用于拖拽排序与开关模块，
        // 那两种改动不影响采集目标，每次都清会让缓存形同虚设。
        if (normalized.servers !== undefined) {
            const before = JSON.stringify(existing.servers || []);
            const after = JSON.stringify(merged.servers || []);
            if (before !== after) invalidateMetricsCache();
        }
        // ⚠️ 更新周期变了同样要清：TTL 是跟着周期算出来的，而**已写下的
        // 缓存行不会因为 TTL 变小而提前失效**。用户把周期从 5 分钟改成
        // 10 秒，TTL 确实变成 20 秒，可那条缓存还能再活 5 分钟——
        // 表现为「改完不生效」。前端会按新周期重排定时器，但拿到的
        // 还是旧数据，所以看起来像设置完全没起作用。
        if (metricsInputsChanged(existing, normalized)) invalidateMetricsCache();

        res.json({ success: true });
    } catch (err) {
        console.error('保存模块配置失败:', err);
        res.status(500).json({ error: '保存失败: ' + err.message });
    }
});

/**
 * 解密一台目标机的 token。失败时返回 null 并说明原因——
 * 静默跳过会让「token 错了」和「服务器离线」在界面上长得一样。
 */
function resolveServerToken(server, passwordHash) {
    if (!isEnvelope(server.token)) {
        // 没有 token 说明用户没配，或沿用了本机模式（不需要凭据）
        return { token: null, error: null };
    }
    try {
        return { token: decrypt(server.token, passwordHash, 'modules'), error: null };
    } catch {
        return { token: null, error: '凭据无法解密，请重新输入 token' };
    }
}

/**
 * 推送模式的离线判定阈值。
 *
 * 刻意**不**复用 resolveCacheTtl()：那是聚合缓存的 TTL，与"某台机器是否还在
 * 上报"无关。缓存命中时不会重采，复用它会让「缓存新鲜但推送已断」显示为在线。
 *
 * 最坏延迟：周期 10s → 50s；周期 300s → 630s。这仍是轮询，不是推送——
 * 新鲜度始终由用户设的周期决定。
 */
function resolvePushTimeoutMs(pollIntervalSeconds) {
    return (resolvePollInterval(pollIntervalSeconds) * 2 + 30) * 1000;
}

/**
 * 读一台推送模式机器的上次上报。
 *
 * 与拉取模式的离线判定口径**根本不同**：拉取是"当场连一次，连不上就是离线"，
 * 推送没有请求-响应，只能靠"多久没收到"来判断。
 *
 * 超阈值时**保留上次的数值**（metrics），并标 stale：能分辨"刚才还好好的、
 * 网断了"与"一直没上来、配置就不对"这两种完全不同的排查方向。
 */
function buildPushResult(server, timeoutMs, now) {
    let row = null;
    try {
        row = db.prepare('SELECT payload, received_at FROM agent_metrics WHERE server_id = ?')
            .get(server.id);
    } catch (err) {
        console.error('读取推送指标失败:', err);
        return {
            id: server.id, name: server.name, url: server.url,
            isLocal: false, online: false, error: '读取推送记录失败'
        };
    }

    if (!row) {
        return {
            id: server.id, name: server.name, url: server.url,
            isLocal: false, online: false, pushStale: true,
            error: '尚未收到推送'
        };
    }

    let metrics = null;
    try {
        metrics = JSON.parse(row.payload);
    } catch {
        // 载荷损坏（理论上不会：写入前已归一化并 JSON.stringify 过）
        metrics = null;
    }

    const age = now - row.received_at;
    if (age > timeoutMs) {
        const minutes = Math.max(1, Math.round(age / 60000));
        return {
            id: server.id, name: server.name, url: server.url,
            isLocal: false, online: false, pushStale: true,
            error: `已 ${minutes} 分钟未收到推送`,
            // 断线前的数值留着——它是有信息量的
            metrics,
            pushReceivedAt: row.received_at
        };
    }

    return {
        id: server.id, name: server.name, url: server.url,
        isLocal: false, online: true,
        metrics,
        pushReceivedAt: row.received_at
    };
}

/**
 * 采集全部服务器：本机 + 配置里的每台目标机。
 *
 * 本机始终排第一（id 用 `local`），它的卡片不需要配置、不会掉线。
 * 目标机并发拉取——串行会让 N 台的总耗时累加到超出前端轮询周期。
 */
async function collectAllServers(passwordHash) {
    let config = defaultModulesConfig;
    try {
        config = await readJSON(MODULES_FILE);
    } catch {
        // 配置文件缺失时只返回本机
    }

    const servers = Array.isArray(config.servers) ? config.servers : [];
    const results = [];

    // 推送模式的离线阈值要按**实际生效的周期**算，不是写死的值
    const pushTimeoutMs = resolvePushTimeoutMs(config.pollInterval);
    const now = Date.now();

    // 本机
    results.push({
        id: 'local',
        name: '本机',
        url: null,
        isLocal: true,
        online: true,
        metrics: await readLocalMetrics()
    });

    // 目标机：并发
    const remote = await Promise.all(servers.map(async server => {
        // deployState 是**已持久化**的观测结果（上次探测算出来的）。
        // 它带进采集结果，是为了让首页卡片不必自己推断——实测显示错过
        // （配了 pending 却显示「未部署」、配了 cert_mismatch 却显示「离线」）。
        const persistedState = server.deployState
            || (server.certPem || server.enrolledAt ? 'pending' : 'not_deployed');
        // 推送模式：不去连它，改为读它上次上报的值
        if (server.mode === 'push') {
            return buildPushResult(server, pushTimeoutMs, now);
        }
        const { token, error } = resolveServerToken(server, passwordHash);
        if (error) {
            return {
                id: server.id, name: server.name, url: server.url,
                online: false, error, deployState: persistedState,
                enrolled: Boolean(server.certPem || server.enrolledAt)
            };
        }
        const result = await fetchRemoteMetrics({ url: server.url, token, certPem: server.certPem });
        if (!result.ok) {
            return {
                id: server.id,
                name: server.name,
                url: server.url,
                online: false,
                error: result.error,
                // enrolled 让界面区分「压根没部署」与「部署了但拉不到」——
                // 两者的下一步完全不同：装一个东西 vs 查网络/证书。
                enrolled: Boolean(server.certPem || server.enrolledAt),
                // authFailed 透传给界面：凭据被拒与机器挂掉需要不同的处置
                // （前者去重填 token，后者去查机器），只给一行文本会逼用户自己猜
                authFailed: result.authFailed === true,
                // 证书与已注册的不一致 = 安全事件（有人换了证书或中间人），
                // 不该和「拉不到」共用一句话。
                certMismatch: result.certMismatch === true,
                // 明文传输已停用 —— 界面据此给迁移引导，而不是只显示「离线」
                insecure: result.insecure === true,
                // 本次拉取的结果**覆盖**持久状态：拉到了就是就绪，
                // 证书变了就是证书异常（比上次探测的结论更实时）。
                // ⚠️ 但**不覆盖 cert_mismatch**：那是安全事件（证书被换了），
                // 一次拉取失败不代表它恢复了——冲掉它等于让用户以为
                // 重新点一次检测就能洗掉一次可能的中间人。
                deployState: result.ok ? 'ready'
                    : (result.certMismatch ? 'cert_mismatch'
                        : (result.insecure ? 'offline'
                            : (server.deployState === 'cert_mismatch' ? 'cert_mismatch'
                                : (Boolean(server.certPem || server.enrolledAt) ? 'pending' : 'not_deployed'))))
            };
        }
        return {
            id: server.id,
            name: server.name,
            url: server.url,
            isLocal: false,
            online: true,
            enrolled: true,
            metrics: result.metrics,
            latencyMs: result.latencyMs,
            // 真的拉到指标了 —— 这是最硬的证据，直接盖过任何持久状态
            deployState: 'ready'
        };
    }));
    results.push(...remote);

    return results;
}

// 轮询接口：走轮询专用桶，不占管理操作的预算（见 modulePollLimit 的注释）。
app.get('/api/modules/metrics', modulePollLimit, requireAdmin, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');

        const now = Date.now();
        // TTL 跟着用户设的轮询周期走，而不是固定 5 分钟——
        // 否则「把周期改成 10 秒」只是名义上的，服务端仍 5 分钟才重采一次。
        const pollInterval = await readPollInterval();
        const ttl = resolveCacheTtl(pollInterval);
        // 缓存新鲜就直接回，避免每个轮询都付一次 200ms 的本机采样 + N 次远端请求
        const cached = readCacheRow(db, METRICS_CACHE_KEY);
        if (cached && now - cached.updatedAt < ttl) {
            return res.json({
                servers: cached.value.servers,
                updatedAt: cached.updatedAt,
                cached: true,
                pollInterval
            });
        }

        const passwordHash = await getPasswordHash();
        const servers = await collectAllServers(passwordHash);
        const payload = { servers };
        writeCacheRow(db, METRICS_CACHE_KEY, payload, now);
        res.json({ servers, updatedAt: now, cached: false, pollInterval });
    } catch (err) {
        console.error('读取监控指标失败:', err);
        res.status(500).json({ error: '读取失败: ' + err.message });
    }
});

/**
 * 服务器配置的增删改。token 只进不出：
 * 读接口只回 hasToken，保存时空值表示保持原值。
 */
app.post('/api/modules/servers', rateLimit, requireAdmin, async (req, res) => {
    try {
        const { id, name, url, token, mode, reachable } = req.body || {};
        if (typeof url !== 'string' || !url.trim()) {
            return res.status(400).json({ error: '请填写服务器地址' });
        }

        // 只允许 https：token 是那台机器的只读监控凭据，明文传输等于把它公开。
        // 这不只是「写个地址」的问题——file:、gopher: 经 agent 拉取时会变成
        // 一个可被利用的服务端请求面，而 http: 会把凭据摊在网络上。
        //
        // 裸 IP 也接受（「只填 IP 就行」是这个改版的核心诉求）：
        // 没有协议头时 `new URL('192.168.1.10')` 会把 `192.168.1.10` 当成
        // **协议名**解析并抛错，用户看到的是「格式不正确」——而他填的完全正确，
        // 只是不知道要写 https://。所以这里补上协议与默认端口再校验。
        let rawUrl = url.trim();
        if (/^https?:\/\//i.test(rawUrl)) {
            if (/^http:\/\//i.test(rawUrl)) {
                return res.status(400).json({
                    error: '监控目标必须使用 https：token 是那台机器的只读监控凭据，明文传输等于把它公开。'
                        + '目标机上的 agent 自己起 HTTPS，请把地址改成 https://'
                });
            }
        } else if (!rawUrl.includes('://')) {
            rawUrl = `https://${rawUrl}`;
        } else {
            return res.status(400).json({ error: '只支持 https，agent 自己起的就是 HTTPS' });
        }

        let parsed;
        try {
            parsed = new URL(rawUrl);
        } catch {
            return res.status(400).json({
                error: '地址格式不正确。填 IP 或域名即可，例如 192.168.1.10'
            });
        }
        if (parsed.protocol !== 'https:') {
            return res.status(400).json({ error: '只支持 https，agent 自己起的就是 HTTPS' });
        }
        if (!parsed.hostname) {
            return res.status(400).json({ error: '地址缺少主机名' });
        }
        // 没写端口就补默认的：agent 听 4195，而 URL 不带端口时请求会打到 443
        if (!parsed.port) parsed.port = '4195';
        const normalizedUrl = parsed.toString().replace(/\/$/, '');

        let config = defaultModulesConfig;
        try {
            config = await readJSON(MODULES_FILE);
        } catch {
            config = defaultModulesConfig;
        }
        const servers = Array.isArray(config.servers) ? config.servers : [];
        const serverId = typeof id === 'string' && id.trim() ? id.trim() : `srv_${Date.now()}`;
        const index = servers.findIndex(s => s.id === serverId);

        const entry = {
            id: serverId,
            name: (typeof name === 'string' && name.trim()) || parsed.hostname,
            // 存**归一化后**的地址（补了 https 与 4195）。
            // 若原样存下用户填的裸 IP，后续每一次 new URL(server.url) 都会失败，
            // 而错误会出现在采集路径上——离「保存时格式不对」十万八千里。
            url: normalizedUrl,
            // 只有字面量 'push' 才算推送，其它（含缺席）一律拉取——
            // 与 normalizeServer 同一裁决，免得两条写路径给出不同答案。
            mode: mode === 'push' ? 'push' : 'pull',
            // 用户对「本服务能否直接连到它」的回答。与 mode 分开存，
            // 因为它同时决定了采集方式与界面上的那一句提示。
            reachable: reachable === false ? false : true
        };
        if (index >= 0) {
            // 编辑：token 空 = 保持原值，不回显所以用户无法「重新看到」它。
            // pushSecretHash 同理，且**必须**在这里补回：它只由「领取凭据」
            // 那一步写入，而本函数整体替换 entry —— 漏掉的后果是用户改个名字
            // 就把刚领的推送凭据抹了，agent 从此 401，界面上却看不出原因。
entry.token = servers[index].token;
            entry.pushSecretHash = servers[index].pushSecretHash;
            // 证书与部署状态**必须**补回：它们由「注册」与「探测」写入，
            // 而本函数整体替换 entry。漏掉的后果是用户改个名字就抹掉配对，
            // 采集重新报「证书未受信任」——而界面上看不出这两件事有关联。
            entry.certPem = servers[index].certPem;
            entry.certFingerprint = servers[index].certFingerprint;
            entry.enrolledAt = servers[index].enrolledAt;
            entry.deployState = servers[index].deployState;
            entry.stateProbedAt = servers[index].stateProbedAt;
        }

        const passwordHash = await getPasswordHash();
        if (typeof token === 'string' && token.trim()) {
            entry.token = encrypt(token.trim(), passwordHash, 'modules');
        }

        if (index >= 0) servers[index] = entry;
        else servers.push(entry);

        config.servers = servers;
        await writeJSON(MODULES_FILE, config);
        // 加/改一台机器后立刻重采，否则要等满 5 分钟 TTL 才看到新目标
        invalidateMetricsCache();
        res.json({ success: true, id: serverId });
    } catch (err) {
        console.error('保存服务器失败:', err);
        res.status(500).json({ error: '保存失败: ' + err.message });
    }
});

app.delete('/api/modules/servers/:id', rateLimit, requireAdmin, async (req, res) => {
    try {
        let config;
        try {
            config = await readJSON(MODULES_FILE);
        } catch {
            return res.status(404).json({ error: '未找到该服务器' });
        }
        const servers = Array.isArray(config.servers) ? config.servers : [];
        const before = servers.length;
        config.servers = servers.filter(s => s.id !== req.params.id);
        if (config.servers.length === before) {
            return res.status(404).json({ error: '未找到该服务器' });
        }
        await writeJSON(MODULES_FILE, config);
        // 删掉的机器不该再出现在下一次采集结果里
        invalidateMetricsCache();
        res.json({ success: true });
    } catch (err) {
        console.error('删除服务器失败:', err);
        res.status(500).json({ error: '删除失败: ' + err.message });
    }
});

/**
 * 领取某台机器的推送凭据。
 *
 * 明文只在这一次响应里出现，之后服务端只留哈希——所以界面上必须让用户
 * 立刻复制走（部署命令面板就是干这个的）。重新领取即轮换：旧凭据立刻失效。
 */
app.post('/api/modules/servers/:id/push-secret', rateLimit, requireAdmin, async (req, res) => {
    try {
        let config;
        try {
            config = await readJSON(MODULES_FILE);
        } catch {
            return res.status(404).json({ error: '未找到该服务器' });
        }
        const servers = Array.isArray(config.servers) ? config.servers : [];
        const index = servers.findIndex(s => s.id === req.params.id);
        if (index < 0) {
            return res.status(404).json({ error: '未找到该服务器' });
        }

        const secret = generatePushSecret();
        servers[index] = { ...servers[index], pushSecretHash: hashPushSecret(secret) };
        config.servers = servers;
        await writeJSON(MODULES_FILE, config);
        // 模式可能马上要切到 push，采集结果的来源变了，缓存必须失效
        invalidateMetricsCache();

        // 只回凭据与 id，**不回显 agent token**——这个响应会进浏览器 DOM
        res.json({ secret, serverId: req.params.id });
    } catch (err) {
        console.error('领取推送凭据失败:', err);
        res.status(500).json({ error: '领取失败: ' + err.message });
    }
});

/**
 * 探测一台机器的「在线状态」与「agent 部署状态」。
 *
 * 这是本次改版的核心端点。上一版只有「在线 / 离线」两个结果，而用户真正要回答的
 * 是三个不同的问题：**这台机器在吗、agent 装了吗、能不能读到指标**。
 * 三者塌缩成一个「离线」时，用户无法判断该点部署、该查网络、还是该换 token。
 *
 * 判定按顺序：
 *   1. TCP 连接 → refused / timeout / open 三态。
 *      refused 的意义：主机回了 RST，它**活着**，只是没人监听 → 未部署。
 *   2. 若 open，问 /health 确认那确实是我们的 agent（而不是别的程序占了端口）。
 *   3. 若已注册，再真拉一次 /metrics 拿到实时指标。
 *
 * 不写 module_cache：探测是用户主动发起的，不该污染聚合采集的缓存。
 * 但 **deployState 要写回 .modules.json**：它是「这个 agent 装好没有」这个
 * 问题的答案，而答案不该每次渲染都重新推断——实测浏览器里保存后
 * deployState 仍是 undefined，卡片退回「未检测」，
 * 用户点完检测看到的还是「未检测」。
 */
app.post('/api/modules/servers/:id/probe', rateLimit, requireAdmin, async (req, res) => {
    try {
        let config;
        try {
            config = await readJSON(MODULES_FILE);
        } catch {
            return res.status(404).json({ error: '未找到该服务器' });
        }
        const servers = Array.isArray(config.servers) ? config.servers : [];
        const index = servers.findIndex(s => s.id === req.params.id);
        if (index < 0) {
            return res.status(404).json({ error: '未找到该服务器' });
        }
        const server = servers[index];

        // 把探测结论写回配置。只在真的变了时写盘——
        // 每次探测都写会让 .modules.json 的 mtime 一直跳，
        // 而它在备份与版本管理里是被当配置看的。
        const persistState = async state => {
            if (server.deployState === state) return;
            servers[index] = { ...server, deployState: state, stateProbedAt: Date.now() };
            config.servers = servers;
            try {
                await writeJSON(MODULES_FILE, config);
            } catch (err) {
                // 写不进去不该让探测失败——结论已经在响应里返回给界面了
                console.error('写回部署状态失败:', err.message);
            }
        };
        // 包一层：每条分支既回响应又落盘，避免漏掉某一条
        const reply = async (payload) => {
            if (payload.deployState) await persistState(payload.deployState);
            return res.json(payload);
        };

        const enrolled = Boolean(server.certPem || server.enrolledAt);
        const isPush = server.mode === 'push';

        // push 模式没有端口可探测——agent 一个端口都不开。
        // 所以它只能靠「有没有注册过」判断部署状态，
        // 「主机在不在线」也退化成「多久没上报」。
        if (isPush) {
            if (!enrolled) {
                return reply({
                    deployState: 'not_deployed',
                    reachable: null,
                    error: null,
                    hint: '推送模式的机器不开放端口，所以探测不到主机是否在线。'
                        + '部署之后本服务会通过「多久没收到上报」来判断它是否在线。'
                });
            }
            return reply({
                deployState: 'ready',
                reachable: null,
                error: null,
                hint: '已注册。推送模式下是否在线由上报时间决定，'
                    + '超过轮询周期两倍加 30 秒仍无上报会显示为「已 N 分钟未收到」。'
            });
        }

        let target;
        try {
            target = new URL(server.url);
        } catch {
            return reply({
                deployState: 'offline',
                reachable: false,
                error: '地址格式不正确',
                hint: '请在「编辑」里把地址改成 https://开头'
            });
        }

        // 第 1 步：TCP 三态
        const tcp = await probeTcp(target.hostname, Number(target.port) || 443, 3000);

        if (tcp.state === 'timeout' || tcp.state === 'error') {
            return reply({
                deployState: 'offline',
                reachable: false,
                error: tcp.detail,
                hint: '连不上这台机器。检查地址、端口与网络；'
                    + '如果它在局域网而本服务在公网，请把「能被本服务直接连到」改成「不能」。'
            });
        }

        if (tcp.state === 'refused') {
            // 主机活着，只是没人监听——这是「该点部署」的信号，不是「离线」
            return reply({
                deployState: 'not_deployed',
                reachable: true,
                error: null,
                hint: '主机在线，但目标机上还没有 agent（端口没人监听）。'
                    + '点「部署」把命令复制到目标机上执行即可。'
            });
        }

        // 第 2 步：确认监听者确实是 agent
        const health = await probeAgentHealth(server.url);
        if (!health.ok) {
            return reply({
                deployState: 'port_conflict',
                reachable: true,
                error: `端口上有服务，但不是 agent：${health.reason}`,
                hint: '目标机的该端口被别的程序占用了。'
                    + '改一下 agent 的端口，或先停掉占用它的程序。'
            });
        }

        // 第 3 步：已注册才拉指标；没注册说明是「装了但没连回本服务」
        if (!enrolled) {
            return reply({
                deployState: 'pending',
                reachable: true,
                error: null,
                agentHostname: health.hostname || null,
                hint: '目标机上已经有 agent 在跑，但它还没向本服务注册。'
                    + '请在目标机上重新跑一次部署命令（令牌需要重新生成）。'
            });
        }

        const passwordHash = await getPasswordHash();
        const { token, error: tokenError } = resolveServerToken(server, passwordHash);
        if (tokenError) {
            return reply({
                deployState: 'ready',
                reachable: true,
                error: tokenError,
                hint: 'agent 在跑且已注册，但本服务读不出它的 token。'
                    + '通常是管理员密码改过导致密文解不开——请重新部署一次。'
            });
        }

        const result = await fetchRemoteMetrics({ url: server.url, token, certPem: server.certPem });

        // ⚠️ deployState 与 reachable 回答的是两个不同的问题，**不能混用**：
        //   deployState = agent 装好并注册了吗
        //   reachable   = 此刻这台机器通吗（拉不到指标就是不通）
        // 实测踩过：TLS 握手失败时返回 `deployState:'ready'` + `reachable:false`，
        // 界面拿到自相矛盾的一对，卡片不知道该显示「已就绪」还是「离线」。
        // 所以拉不到指标时退回 'pending'——它准确表达「装好了但还没通」，
        // 而 hint 会给出具体原因（证书不匹配 / token 不对 / 网络不通）。
        const online = result.ok || result.authFailed === true;
        let state;
        if (result.ok) state = 'ready';
        else if (result.certMismatch) state = 'cert_mismatch';
        else if (result.insecure) state = 'offline';
        else state = 'pending';

        return reply({
            deployState: state,
            // agent 的**软件**版本（与 deployState 那个协议版本是两件事）。
            // 后台据此提示「目标机上跑的是旧版，可升级」——
            // 而旧 agent 没有 upgrade 子命令，所以光看到版本旧没有用，
            // 必须同时知道它的版本才能给出一条可执行的动作。
            agentVersion: health.agentVersion || null,
            reachable: online,
            error: result.ok ? null : result.error,
            authFailed: result.authFailed === true,
            certMismatch: result.certMismatch === true,
            insecure: result.insecure === true,
            // 每条分支都要给出下一步——用户点了探测，任何结果都得告诉他接着做什么。
            // ⚠️ 英文 TLS 错误串（"Hostname/IP does not match..."）对用户无意义，
            // 换成「证书与地址不匹配」并说清怎么办。
            hint: result.ok
                ? '一切正常，可以监控这台机器'
                : (result.authFailed
                    ? '路是通的，只是 token 不匹配——重新部署一次即可'
                    : (result.certMismatch
                        ? '这台机器的证书与注册时不一致。如果你重新装过 agent，重新部署即可；'
                            + '否则可能是中间人，先查网络'
                        : (result.insecure
                            ? '明文传输已停用：请改用 https 地址'
                            : (/does not match certificate|Hostname\/IP does not match/i.test(result.error || '')
                                ? '证书与这台机器的地址不匹配（多半是重新生成证书时换过 IP 或主机名）。'
                                    + '重新部署一次即可'
                                : '路是通的，但拉取指标失败：' + result.error))))
        });
    } catch (err) {
        console.error('探测服务器失败:', err);
        res.status(500).json({ error: '探测失败: ' + err.message });
    }
});
app.post('/api/modules/servers/:id/enroll-token', rateLimit, requireAdmin, async (req, res) => {
    try {
        let config;
        try {
            config = await readJSON(MODULES_FILE);
        } catch {
            return res.status(404).json({ error: '未找到该服务器' });
        }
        const servers = Array.isArray(config.servers) ? config.servers : [];
        const index = servers.findIndex(s => s.id === req.params.id);
        if (index < 0) {
            return res.status(404).json({ error: '未找到该服务器' });
        }
        const server = servers[index];

        const token = generateEnrollToken();
        servers[index] = {
            ...server,
            // 明文只在响应里出现，磁盘上只有哈希 + 过期时间。
            // ⚠️ 刻意不存「期望来源 IP」：那是目标机的地址，而服务端看到的
            // 是它的出口 IP（NAT 之后），两者不可比。详见 enroll 端点里那段注释。
            enrollTokenHash: hashEnrollToken(token),
            enrollTokenExpiresAt: Date.now() + ENROLL_TOKEN_TTL_MS
        };
        config.servers = servers;
        await writeJSON(MODULES_FILE, config);

        res.json({
            token,
            serverId: req.params.id,
            expiresAt: servers[index].enrollTokenExpiresAt,
            // 只回凭据与 id，不回显任何已有凭据——这个响应会进浏览器 DOM
            mode: server.mode === 'push' ? 'push' : 'pull'
        });
    } catch (err) {
        console.error('签发部署令牌失败:', err);
        res.status(500).json({ error: '签发失败: ' + err.message });
    }
});

/** 从服务器地址里取出主机名部分（用于绑定令牌）。解析失败就原样返回。 */
function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return typeof url === 'string' ? url : '';
    }
}

/**
 * agent 注册（enroll）。
 *
 * ⚠️ **匿名可达**：agent 在目标机上，注册时还没有任何长期凭据——它的鉴权
 * 就是这次调用里带来的那枚一次性令牌。所以它**不能**挂 requireAdmin，
 * 也不能只验 IP：拿到的正是「持有令牌即可注册」这个语义。
 *
 * 防护是令牌本身的三条约束（见 ENROLL_TOKEN_TTL_MS 处的说明）：一次性、
 * 15 分钟过期、重复签发即作废旧令牌。以及独立的限流桶——
 * 复用 publicReadLimit 会让匿名首页流量消耗注册配额，
 * 复用 rateLimit（30/min）会把正常的一键部署也限掉。
 *
 * 成功后立刻作废令牌：同一个令牌重放必须失败。
 */
const ENROLL_LIMIT_WINDOW = 60000;
const ENROLL_LIMIT_MAX = 30;
const enrollLimitMap = new Map();

function enrollLimit(req, res, next) {
    const ip = resolveClientIp(req);
    const now = Date.now();
    const rec = enrollLimitMap.get(ip);
    if (!rec || now > rec.resetAt) {
        enrollLimitMap.set(ip, { count: 1, resetAt: now + ENROLL_LIMIT_WINDOW });
        return next();
    }
    rec.count += 1;
    if (rec.count > ENROLL_LIMIT_MAX) {
        res.status(429).json({ error: '注册过于频繁，请稍后再试' });
        return;
    }
    next();
}

app.post('/api/modules/enroll', enrollLimit, async (req, res) => {
    try {
        const body = req.body || {};
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        if (!token) {
            return res.status(400).json({ error: '缺少令牌' });
        }
        const certPem = typeof body.certPem === 'string' ? body.certPem : '';
        if (!certPem || !certPem.includes('BEGIN CERTIFICATE')) {
            return res.status(400).json({ error: '缺少证书' });
        }

        let config;
        try {
            config = await readJSON(MODULES_FILE);
        } catch {
            config = defaultModulesConfig;
        }
        const servers = Array.isArray(config.servers) ? config.servers : [];

        // 按令牌哈希反查机器。哈希定长比较，20 台的开销可忽略。
        const matched = servers.find(s => s.enrollTokenHash && enrollTokenMatches(token, s.enrollTokenHash));
        if (!matched) {
            console.warn(`[enroll] 令牌无效或已使用，来源 ${resolveClientIp(req)}`);
            return res.status(401).json({ error: '部署令牌无效或已被使用' });
        }

        const now = Date.now();
        if (typeof matched.enrollTokenExpiresAt === 'number' && now > matched.enrollTokenExpiresAt) {
            console.warn(`[enroll] 令牌已过期，server ${matched.id}`);
            return res.status(401).json({ error: '部署令牌已过期，请在后台重新生成' });
        }
        // ⚠️ 这里**刻意没有**「绑定来源 IP」这道防护。
        //
        // 早先写过一版，把令牌绑到 hostOf(server.url)，注册时比对
        // hostOf(matched.url) —— 同一个字段的同一个函数，两边恒相等，
        // 分支永不执行。于是「绑定 IP」成了一句只存在于注释和 README 里的
        // 假防护（本轮代码审查发现）。
        //
        // 真正实现不了的原因：部署令牌是在**目标机**上用的，而这里看到的是
        // 请求的来源地址。公网服务看到的是目标机的出口 IP（NAT 之后），
        // 与用户在后台填的地址没有可比性 —— 拿它做判定就是把「局域网地址」
        // 推出后台，和 architecture.md 里明确拒绝的「按 IP 段猜可达性」同一类错误。
        //
        // 真实的防护是这三条：一次性（用过即作废）、15 分钟 TTL、
        // 以及匿名端点自己的限流桶。要更强的保证，应该走后台主动轮询
        // 校验证书，而不是在注册时猜来源地址。

        // 指纹由 agent 自己算好上报——它就是 certPem 的 SHA-256。
        // 服务端不再去抓对端证书：那样需要先连一次，而注册的目的正是建立连接。
        const fingerprint = typeof body.fingerprint === 'string' && body.fingerprint
            ? body.fingerprint
            : fingerprintOfPem(certPem);

        const mode = body.mode === 'push' ? 'push' : 'pull';
        const index = servers.findIndex(s => s.id === matched.id);

        // pull 模式发一枚长期 token（agent 之后靠它调 /metrics）；
        // push 模式发推送凭据。两者的明文都**只**在这一次响应里出现。
        const longToken = mode === 'pull' ? generatePushSecret() : null;
        const pushSecret = mode === 'push' ? generatePushSecret() : null;

        servers[index] = {
            ...matched,
            mode,
            certPem,
            certFingerprint: fingerprint,
            enrolledAt: now,
            token: longToken ? encrypt(longToken, await getPasswordHash(), 'modules') : matched.token,
            pushSecretHash: pushSecret ? hashPushSecret(pushSecret) : matched.pushSecretHash,
            deployState: 'ready'
        };
        // 令牌用掉即作废：把两个键**删掉**，而不是赋 undefined。
        // JSON.stringify 本来就会丢 undefined，所以「赋 undefined 再 delete」
        // 是纯噪声；直接 delete 才读得出「这两个键已经作废」。
        //
        // ⚠️ 第三个 enrollTokenIp 是上一轮删掉的假防护（同一字段同一函数，
        // 恒相等，NAT 下还不可比），字段与声明都清了，**这里漏了一处**。
        // 无害——delete 一个不存在的键是空操作——但它会让「这个字段已经彻底
        // 移除」这件事在代码里显得不是真的。
        for (const k of ['enrollTokenHash', 'enrollTokenExpiresAt']) {
            delete servers[index][k];
        }
        config.servers = servers;
        await writeJSON(MODULES_FILE, config);
        invalidateMetricsCache();

        res.json({
            serverId: matched.id,
            mode,
            token: longToken,
            pushSecret
        });
    } catch (err) {
        console.error('agent 注册失败:', err);
        res.status(500).json({ error: '注册失败: ' + err.message });
    }
});

/** 证书 PEM 的 SHA-256 指纹（冒号分隔的大写十六进制）。 */
function fingerprintOfPem(pemText) {
    try {
        const der = Buffer.from(
            pemText.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''),
            'base64'
        );
        return nodeCrypto.createHash('sha256').update(der).digest('hex')
            .toUpperCase().match(/.{2}/g).join(':');
    } catch {
        return '';
    }
}

// ========== 推送接收 ==========
//
// 独立限流桶。复用 publicReadLimit 会让匿名首页流量消耗推送配额；
// 复用 rateLimit（管理端 30/min）会把 10s 周期的 agent 直接限掉。
//
// ⚠️ 这些定义必须在**使用它的路由之上**。app.post 的第二个参数在注册时
// 就要求中间件存在，而 `const` 有暂时性死区——定义在路由下方时，
// 服务器启动即抛 ReferenceError，而 node --check 与全部单元测试都是绿的：
// 语法检查不查标识符是否已定义，静态断言更看不出「谁在什么时候求值」。
// 这条只有真正把服务器起起来才会暴露。
const PUSH_LIMIT_WINDOW = 60000;
// 20 台 × 6 次/分钟（最短周期 10s）= 120。这个数字是推导出来的：
// 目标机上限 20 台（normalizeModulesConfig 的 slice），最短周期 10s。
const PUSH_LIMIT_MAX = 120;
// pushLimitMap 已在文件上方（清理定时器旁）声明——那里必须先于定时器存在，
// 这里不再重复声明，只说明它服务于推送端点。

/** 推送端点的限流中间件。与 publicReadLimit 同一形状，独立计数。 */
function pushLimit(req, res, next) {
    const ip = resolveClientIp(req);
    const { allowed } = consumeRateLimit(pushLimitMap, ip, Date.now(), PUSH_LIMIT_WINDOW, PUSH_LIMIT_MAX);
    if (!allowed) {
        return res.status(429).json({ error: '上报过于频繁，请稍后再试' });
    }
    next();
}

/** 载荷里允许的字节数。指标对象本身只有几百字节，4096 留足余量。 */
const PUSH_METRICS_MAX_BYTES = 4096;

/**
 * 把推送来的 metrics 压到已知形状。
 *
 * 这是**未经信任的网络输入**直接进入首页渲染路径的入口：agent 在内网，
 * 而写入的值会显示在所有人的首页上。压不进形状的压不进库，压不进库就
 * 渲染不出来。数值越界回落为安全值，而不是原样写入——一台受控的机器
 * 不该靠抬高 cpu: 1e9 就能撑破进度条。
 */
function normalizePushedMetrics(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    // 区间内的有限数，夹取；区间外或非数一律回落 fallback
    const clamp = (value, min, max, fallback) =>
        (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
            ? value : fallback;
    // 上界取 2^53：超过它的整数在 JS 里就不再精确，而字节数与秒数都远超这个量级，
    // 真有机器报出 1e308 只能是坏数据——让它落库只会在 fmtBytes 里滚出一串无意义的字符。
    const MAX_SAFE = Number.MAX_SAFE_INTEGER;
    const nonNegative = (value, fallback) =>
        (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SAFE)
            ? value : fallback;
    const shortString = (value, max) =>
        (typeof value === 'string' ? value.slice(0, max) : '');

    return {
        // 越界回落 null 而不是 1：拉取路径遇到版本不符会明确报错（协议一致性检查），
        // 推送路径若回落成 1 就把一台版本不同的机器静默当成同版本渲染——
        // 同一种不一致，两条路径给出两种答案。null 让它在界面上显示为「—」。
        version: Number.isInteger(raw.version) ? raw.version : null,
        cpu: clamp(raw.cpu, 0, 1, null),
        memoryUsed: nonNegative(raw.memoryUsed, 0),
        memoryTotal: nonNegative(raw.memoryTotal, 0),
        memoryPercent: clamp(raw.memoryPercent, 0, 1, null),
        // 磁盘：0 表示「这台机器没报」（旧版 agent 或 statfs 失败），
        // 界面据此显示「—」而不是「0 B / 0 B」。
        diskUsed: nonNegative(raw.diskUsed, 0),
        diskTotal: nonNegative(raw.diskTotal, 0),
        load1: nonNegative(raw.load1, 0),
        load5: nonNegative(raw.load5, 0),
        uptime: nonNegative(raw.uptime, 0),
        cores: nonNegative(raw.cores, 0),
        hostname: shortString(raw.hostname, 128),
        platform: shortString(raw.platform, 32),
        sampledAt: nonNegative(raw.sampledAt, 0)
    };
}

/**
 * 接收 agent 上报的指标。
 *
 * **没有 requireAdmin**：agent 在内网、是裸 HTTP，拿不到浏览器会话。
 * 它的鉴权是推送凭据（见上方「推送凭据」小节的取舍说明）。
 */
app.post('/api/modules/agent-push', pushLimit, async (req, res) => {
    try {
        const auth = req.headers.authorization || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';

        let config;
        try {
            config = await readJSON(MODULES_FILE);
        } catch {
            config = defaultModulesConfig;
        }
        const servers = Array.isArray(config.servers) ? config.servers : [];

        // 按凭据哈希反查机器。哈希比对是定长的，20 台的开销可忽略。
        const matched = servers.find(s => s.pushSecretHash && pushSecretMatches(provided, s.pushSecretHash));
        if (!matched) {
            // 401 而非 404：凭据不对与"机器没配推送"在返回上无法真正区分，
            // 而 404 会额外泄露"存在哪些机器"。记 IP 与时间供排查，不记凭据。
            console.warn(`[push] 凭据被拒，来源 ${resolveClientIp(req)}`);
            return res.status(401).json({ error: '推送凭据无效' });
        }

        // serverId 由 agent 带上，仅用于排错与防写错行；不一致时明确拒绝，
        // 而不是默默把数据写到别的机器名下。
        const body = req.body || {};
        if (typeof body.serverId === 'string' && body.serverId && body.serverId !== matched.id) {
            return res.status(409).json({ error: '凭据与 serverId 不匹配' });
        }

        const raw = JSON.stringify(body.metrics ?? null);
        if (raw.length > PUSH_METRICS_MAX_BYTES) {
            return res.status(400).json({ error: '指标载荷过大' });
        }
        const metrics = normalizePushedMetrics(body.metrics);
        if (!metrics) {
            return res.status(400).json({ error: '指标格式不正确' });
        }

        const now = Date.now();
        db.prepare(
            'INSERT INTO agent_metrics (server_id, payload, received_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(server_id) DO UPDATE SET payload = excluded.payload, received_at = excluded.received_at'
        ).run(matched.id, JSON.stringify(metrics), now);
        // 推送是采集的输入之一，输入变了就得让聚合缓存失效
        invalidateMetricsCache();

        res.json({ ok: true, receivedAt: now });
    } catch (err) {
        console.error('接收推送失败:', err);
        res.status(500).json({ error: '接收失败' });
    }
});

// ========== 备忘录 API ==========
//
// 登录后的私有数据（SQLite memos 表，v4 迁移——独立于
// config.json：那里的 key 会经 toPublicConfig 下发给匿名访客）。
//
// 写操作（POST / pin / DELETE）在共享防爆破桶之外再按 IP 单列一只桶：
// 那是**用户手动发起**的动作，频率由人决定，30 次/分钟足够。
// ⚠️ 读接口（GET /api/memos）**不**在这只桶里——它是 15 秒一次的轮询，
// 按标签页数线性增长，算进来以后多开几个标签页就会自己打满（8 个标签页
// × 4 次/分钟 = 32 > 30）。它走 modulePollLimit。
// 容量与长度在服务端再校验一遍——客户端 maxlength 只是体验不是边界。
const MEMO_LIMIT_WINDOW = 60000;
const MEMO_LIMIT_MAX = 30;
const MEMO_MAX_ENTRIES = 200;
const MEMO_TITLE_MAX = 60;
const MEMO_BODY_MAX = 10240;
const memoRateLimitMap = new Map();

function memoLimit(req, res, next) {
    const ip = resolveClientIp(req);
    const now = Date.now();
    const rec = memoRateLimitMap.get(ip);
    if (!rec || now > rec.resetAt) {
        memoRateLimitMap.set(ip, { count: 1, resetAt: now + MEMO_LIMIT_WINDOW });
        return next();
    }
    rec.count += 1;
    if (rec.count > MEMO_LIMIT_MAX) {
        res.status(429).json({ error: '请求过于频繁，请稍后再试' });
        return;
    }
    next();
}

// 行 → 客户端形态：SQLite 的 0/1 转布尔，下划线键改驼峰
function memoToClient(row) {
    return {
        id: row.id,
        title: row.title,
        body: row.body,
        pinned: !!row.pinned,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const MEMO_SELECT = 'SELECT id, title, body, pinned, created_at, updated_at FROM memos';
// 排序在服务端做：固定组在前、组内按内容更新时间倒序——
// 单一真相源，客户端不再各自排序。
const MEMO_LIST_SQL = MEMO_SELECT + ' ORDER BY pinned DESC, updated_at DESC';

// 轮询接口：走轮询专用桶。**不带 memoLimit**——那只桶留给下面的写操作
//（用户手动增删改），把 15 秒一次的读也算进去会让多标签页用户自己打满它。
app.get('/api/memos', modulePollLimit, requireAdmin, async (req, res) => {
    try {
        const rows = db.prepare(MEMO_LIST_SQL).all();
        // 与 metrics 路由同理：回当前生效的周期，
        // 用户在后台改过之后不必刷新页面就能按新周期走。
        const pollInterval = await readPollInterval();
        res.json({ memos: rows.map(memoToClient), pollInterval });
    } catch (err) {
        console.error('读取备忘录失败:', err);
        res.status(500).json({ error: '读取失败' });
    }
});

app.post('/api/memos', rateLimit, requireAdmin, memoLimit, (req, res) => {
    try {
        const body = req.body || {};
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const text = typeof body.body === 'string' ? body.body : '';
        if (!title) return res.status(400).json({ error: '标题不能为空' });
        if (title.length > MEMO_TITLE_MAX) return res.status(400).json({ error: `标题最长 ${MEMO_TITLE_MAX} 字符` });
        if (text.length > MEMO_BODY_MAX) return res.status(400).json({ error: `正文最长 ${MEMO_BODY_MAX} 字符` });
        if (db.prepare('SELECT COUNT(*) AS n FROM memos').get().n >= MEMO_MAX_ENTRIES) {
            return res.status(400).json({ error: `最多 ${MEMO_MAX_ENTRIES} 条备忘录` });
        }
        const now = Date.now();
        // WebCrypto 的 randomUUID：本文件不 require('crypto')，
        // 以免 shadow 粘贴代码用的全局 WebCrypto（见上方说明）。
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO memos (id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
            .run(id, title, text, now, now);
        const row = db.prepare(MEMO_SELECT + ' WHERE id = ?').get(id);
        res.json({ memo: memoToClient(row) });
    } catch (err) {
        console.error('创建备忘录失败:', err);
        res.status(500).json({ error: '创建失败' });
    }
});

app.post('/api/memos/:id', rateLimit, requireAdmin, memoLimit, (req, res) => {
    try {
        const body = req.body || {};
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const text = typeof body.body === 'string' ? body.body : '';
        if (!title) return res.status(400).json({ error: '标题不能为空' });
        if (title.length > MEMO_TITLE_MAX) return res.status(400).json({ error: `标题最长 ${MEMO_TITLE_MAX} 字符` });
        if (text.length > MEMO_BODY_MAX) return res.status(400).json({ error: `正文最长 ${MEMO_BODY_MAX} 字符` });
        const now = Date.now();
        // LWW（定稿决策 Q10）：直接覆盖，不带版本检查——
        // 单管理员工具，两端同刻编辑同一条的概率极低。
        const info = db.prepare('UPDATE memos SET title = ?, body = ?, updated_at = ? WHERE id = ?')
            .run(title, text, now, req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: '未找到该备忘录' });
        const row = db.prepare(MEMO_SELECT + ' WHERE id = ?').get(req.params.id);
        res.json({ memo: memoToClient(row) });
    } catch (err) {
        console.error('保存备忘录失败:', err);
        res.status(500).json({ error: '保存失败' });
    }
});

app.post('/api/memos/:id/pin', rateLimit, requireAdmin, memoLimit, (req, res) => {
    try {
        const v = req.body && req.body.pinned;
        if (typeof v !== 'boolean') return res.status(400).json({ error: 'pinned 必须为布尔值' });
        // 只改 pinned，不动 updated_at：固定组内按「内容更新时间」
        // 排序（定稿决策 Q3），固定操作本身不算内容更新。
        const info = db.prepare('UPDATE memos SET pinned = ? WHERE id = ?')
            .run(v ? 1 : 0, req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: '未找到该备忘录' });
        res.json({ success: true });
    } catch (err) {
        console.error('固定备忘录失败:', err);
        res.status(500).json({ error: '操作失败' });
    }
});

app.delete('/api/memos/:id', rateLimit, requireAdmin, memoLimit, (req, res) => {
    try {
        const info = db.prepare('DELETE FROM memos WHERE id = ?').run(req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: '未找到该备忘录' });
        res.json({ success: true });
    } catch (err) {
        console.error('删除备忘录失败:', err);
        res.status(500).json({ error: '删除失败' });
    }
});

// ========== Paste API ==========

// 生成分享码（用于客户端加密）
app.post('/api/p/code', (req, res) => {
    const ip = resolveClientIp(req);

    if (!consumeRateLimit(pasteRateLimitMap, `${ip}:paste:code`, Date.now(), PASTE_RATE_WINDOW, PASTE_CODE_LIMIT).allowed) {
        return res.status(429).json({ error: '创建过于频繁，请稍后再试' });
    }

    const code = generatePasteCode();
    res.json({ code });
});

// 创建分享
app.post('/api/p', (req, res) => {
    const ip = resolveClientIp(req);

    // 创建入口必须独立限流：否则可绕开 /api/p/code 直接自造分享码创建
    if (!consumeRateLimit(pasteRateLimitMap, `${ip}:paste:create`, Date.now(), PASTE_RATE_WINDOW, PASTE_CREATE_LIMIT).allowed) {
        return res.status(429).json({ error: '创建过于频繁，请稍后再试' });
    }

    const { code, content, pin, ttl } = req.body;

    // 验证分享码格式
    if (!code || !isPasteCodeFormat(code)) {
        return res.status(400).json({ error: '无效的分享码' });
    }

    // 检查分享码是否已被使用
    if (pasteStorage.has(code)) {
        return res.status(400).json({ error: '分享码已被使用' });
    }

    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: '内容不能为空' });
    }

    if (content.length > 100000) {
        return res.status(400).json({ error: '内容过大' });
    }

    if (pin && (!/^\d{4}$/.test(pin))) {
        return res.status(400).json({ error: 'PIN 必须是4位数字' });
    }

    // 有效期只接受白名单档位；缺失或非法值按 5 分钟处理
    const ttlMinutes = resolvePasteTtlMinutes(ttl);
    const expiresAt = Date.now() + PASTE_TTL_OPTIONS[ttlMinutes];

    // 全局容量兜底：限流按 IP 计数，多个 IP 仍可能共同堆高内存。
    // 不做最旧条目驱逐，避免静默清掉他人仍在有效期内的分享。
    if (isOverPasteCapacity(pasteStorage.size + 1, pasteStorageBytes() + content.length)) {
        return res.status(503).json({ error: '分享服务繁忙，请稍后再试' });
    }

    pasteStorage.set(code, {
        content,
        pin: pin || null,
        expiresAt,
        attempts: 0
    });

    console.log(`[Paste] Created: ${code} (expires in ${ttlMinutes}min)`);

    res.json({
        success: true,
        code,
        expiresAt,
        hasPin: !!pin
    });
});

// 获取分享 (API)
app.post('/api/p/:code', (req, res) => {
    const ip = resolveClientIp(req);

    if (!consumeRateLimit(pasteRateLimitMap, `${ip}:paste:get`, Date.now(), PASTE_RATE_WINDOW, PASTE_GET_LIMIT).allowed) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }

    const { code } = req.params;
    const { pin } = req.body;

    if (!isPasteCodeFormat(code)) {
        return res.status(400).json({ error: '无效的分享码格式' });
    }

    const paste = pasteStorage.get(code);

    if (!paste) {
        return res.status(404).json({ error: '分享不存在或已过期' });
    }

    if (Date.now() > paste.expiresAt) {
        pasteStorage.delete(code);
        return res.status(404).json({ error: '分享已过期' });
    }

    // PIN 验证
    if (paste.pin) {
        if (!pin) {
            return res.json({ requirePin: true });
        }
        if (pin !== paste.pin) {
            paste.attempts++;
            if (paste.attempts >= 3) {
                pasteStorage.delete(code);
                console.log(`[Paste] Destroyed due to PIN failures: ${code}`);
                return res.status(403).json({ error: 'PIN 错误次数过多，分享已销毁' });
            }
            return res.status(403).json({ error: `PIN 错误，剩余 ${3 - paste.attempts} 次尝试` });
        }
    }

    const content = paste.content;

    // 阅后即删
    pasteStorage.delete(code);
    console.log(`[Paste] Retrieved and deleted: ${code}`);

    res.json({
        success: true,
        content
    });
});

// 分享页面路由
app.get('/p/:code', (req, res) => {
    const { code } = req.params;

    if (!isPasteCodeFormat(code)) {
        return res.redirect('/');
    }

    const paste = pasteStorage.get(code);
    const exists = paste && Date.now() <= paste.expiresAt;
    const requirePin = exists && paste.pin;

    // 返回支持客户端解密的 HTML 页面（使用分享码作为密钥）
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>分享内容</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #efede8; --panel: rgba(252,250,246,.91); --text: #302b27;
            --text-secondary: #655e57; --border: rgba(92,76,64,.18); --accent: #945e4a;
            --accent-hover: #79503f; --focus: rgba(148,94,74,.58);
            --control-top: #fcfaf6; --control-bottom: #eee9e1;
            --control-hover-top: #fffdf9; --control-hover-bottom: #f4eee6;
            --control-pressed-top: #e9e2d9; --control-pressed-bottom: #f1ece5;
            --input-top: #f1ece5; --input-bottom: #fcfaf6;
            --inner-light: rgba(255,255,255,.67); --inner-dark: rgba(91,70,55,.13);
            --press-shadow: inset 0 2px 5px rgba(91,70,55,.20),inset 0 -1px rgba(255,255,255,.55);
            --text-muted: #8b837a;
            --code-string: #4e7a52; --code-number: #9a6b3f; --code-title: #3f6b8a;
            --code-attr: #8a5a7a; --code-type: #7a6a3f; --code-deletion: #a4463f;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                color-scheme: dark;
                --bg: #211f1c; --panel: rgba(57,51,46,.93); --text: #f3eee8;
                --text-secondary: #c9beb3; --border: rgba(222,203,185,.18); --accent: #c28d70;
                --accent-hover: #d4a181; --focus: rgba(223,169,140,.68);
                --control-top: #625951; --control-bottom: #3c3630;
                --control-hover-top: #71655b; --control-hover-bottom: #4a4139;
                --control-pressed-top: #292521; --control-pressed-bottom: #39312b;
                --input-top: #292521; --input-bottom: #39312b;
                --inner-light: rgba(255,255,255,.09); --inner-dark: rgba(0,0,0,.24);
                --press-shadow: inset 0 3px 7px rgba(0,0,0,.45),inset 0 -1px rgba(255,255,255,.08);
                --text-muted: #9c9287;
                --code-string: #9dc49f; --code-number: #d9a877; --code-title: #8fb8d4;
                --code-attr: #c99ec0; --code-type: #c7b581; --code-deletion: #e0897f;
            }
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
            background: var(--bg); color: var(--text); min-height: 100dvh;
            display: flex; align-items: center; justify-content: center;
            /* 刘海屏与 Home 指示条：viewport-fit=cover 之后必须由内边距让位 */
            padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right))
                     max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
        }
        .container {
            width: 100%; max-width: 560px; background: var(--panel);
            border: 1px solid var(--border); border-radius: 16px;
            padding: 24px;
            /* 与 body 同理：内容本身也要避开刘海与 Home 指示条 */
            padding-top: max(24px, env(safe-area-inset-top));
            padding-bottom: max(24px, env(safe-area-inset-bottom));
            box-shadow: inset 0 1px var(--inner-light), 0 20px 48px rgba(35,27,21,.21);
            backdrop-filter: blur(23px) saturate(118%); -webkit-backdrop-filter: blur(23px) saturate(118%);
        }
        .title { font-size: 14px; font-weight: 600; color: var(--text-secondary); margin-bottom: 15px; }
        .content {
            background: linear-gradient(180deg,var(--input-top),var(--input-bottom)); border: 1px solid var(--border); border-radius: 9px;
            box-shadow: inset 0 1px 2px var(--inner-dark), inset 0 -1px var(--inner-light);
            padding: 16px; font-family: 'SF Mono', Menlo, monospace; font-size: 13px; line-height: 1.6;
            white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto;
        }
        .btn {
            display: inline-flex; align-items: center; gap: 8px;
            min-height: 38px; padding: 7px 15px; background: linear-gradient(170deg,var(--control-top),var(--control-bottom)); color: var(--text);
            border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600;
            box-shadow: inset 0 1px var(--inner-light); cursor: pointer; margin-top: 16px;
            transition: transform 110ms, border-color 140ms, background 140ms, box-shadow 140ms;
        }
        .btn:hover { transform: translateY(-1px); border-color: var(--focus); background: linear-gradient(170deg,var(--control-hover-top),var(--control-hover-bottom)); }
        .btn:active { transform: translateY(1px); background: linear-gradient(180deg,var(--control-pressed-top),var(--control-pressed-bottom)); box-shadow: var(--press-shadow); transition-duration: 35ms; }
        .btn:focus-visible, .pin-input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
        .notice { font-size: 13px; color: var(--text-secondary); margin-top: 12px; }
        .error { text-align: center; color: var(--text-secondary); }
        .pin-form { display: flex; gap: 12px; flex-wrap: wrap; }
        .pin-input {
            flex: 1; min-width: 120px; padding: 10px 16px; font-size: 18px;
            text-align: center; letter-spacing: 8px; border: 1px solid var(--border);
            border-radius: 8px; background: linear-gradient(180deg,var(--input-top),var(--input-bottom)); color: var(--text);
            box-shadow: inset 0 1px 2px var(--inner-dark), inset 0 -1px var(--inner-light);
        }
        .pin-input:focus { border-color: var(--accent); }
        .msg { padding: 12px; border-radius: 8px; margin-top: 12px; font-size: 14px; }
        .msg.error-msg { border: 1px solid var(--border); background: var(--input-top); color: var(--accent); }
        .expired-mark { font-size: 32px; line-height: 1; color: var(--text-secondary); margin-bottom: 14px; }
        .error .btn { text-decoration: none; margin-top: 22px; }
        .pin-form .btn { margin-top: 0; }
        @media (max-width: 480px) { body { padding: 14px; } .container { padding: 20px 17px; } .pin-form .btn { min-height: 44px; } }
        @media (prefers-reduced-motion: reduce) { .btn { transition: none; } .btn:hover, .btn:active { transform: none; } }
        @media (prefers-reduced-transparency: reduce) { .container { background: var(--input-bottom); backdrop-filter: none; -webkit-backdrop-filter: none; } }
        @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .container { background: var(--input-bottom); } }

        /* 代码高亮配色，复用页面既有变量以适配明暗主题 */
        .hljs { color: var(--text); background: transparent; }
        .hljs-comment, .hljs-quote { color: var(--text-muted); font-style: italic; }
        .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag { color: var(--accent); }
        .hljs-string, .hljs-regexp, .hljs-addition { color: var(--code-string); }
        .hljs-number, .hljs-symbol, .hljs-bullet { color: var(--code-number); }
        .hljs-title, .hljs-title.function_, .hljs-section, .hljs-name { color: var(--code-title); }
        .hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable { color: var(--code-attr); }
        .hljs-type, .hljs-built_in, .hljs-class .hljs-title { color: var(--code-type); }
        .hljs-meta, .hljs-tag { color: var(--text-secondary); }
        .hljs-deletion { color: var(--code-deletion); }
        .hljs-emphasis { font-style: italic; }
        .hljs-strong { font-weight: 600; }
    </style>
</head>
<body>
    <div class="container">
        ${!exists ? `
            <div class="error">
                <p class="expired-mark" aria-hidden="true">◇</p>
                <p>分享不存在或已过期</p>
                <a href="/" class="btn">返回首页</a>
            </div>
        ` : requirePin ? `
            <div class="title">此分享需要验证 PIN</div>
            <form class="pin-form" id="pinForm">
                <input type="text" class="pin-input" id="pinInput" maxlength="4" pattern="\\d{4}"
                       placeholder="••••" autocomplete="off" inputmode="numeric">
                <button type="submit" class="btn">验证</button>
            </form>
            <div id="errorMsg"></div>
        ` : `
            <div class="title">分享内容</div>
            <div class="content" id="content">加载中...</div>
            <button class="btn" id="copyBtn">复制内容</button>
            <p class="notice">此内容已从服务器删除</p>
        `}
    </div>
    <script src="/lib/highlight.min.js"></script>
    <script>
        // 使用分享码进行端到端解密
        const Crypto = {
            async deriveKey(code) {
                const enc = new TextEncoder();
                const keyMaterial = await crypto.subtle.importKey(
                    'raw', enc.encode(code + '-nav-sylph-e2e'), 'PBKDF2', false, ['deriveKey']
                );
                return crypto.subtle.deriveKey(
                    { name: 'PBKDF2', salt: enc.encode('nav-sylph-paste-v2'), iterations: 100000, hash: 'SHA-256' },
                    keyMaterial,
                    { name: 'AES-GCM', length: 256 },
                    false,
                    ['decrypt']
                );
            },
            async decrypt(encryptedBase64, code) {
                const key = await this.deriveKey(code);
                const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
                const iv = combined.slice(0, 12);
                const data = combined.slice(12);
                const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
                return new TextDecoder().decode(decrypted);
            }
        };

        const code = '${code}';
        let decryptedText = '';

        // 语言识别：先用高精度签名判定明确语言，再用 hljs 自动识别兜底。
        // 分享内容多为短片段，hljs 的 relevance 在短文本上区分度不足，
        // 因此签名层优先，避免把 Python 片段判成 CSS 一类的误判。
        const CJK = /[\\u4e00-\\u9fff]/;
        const LANG_SIGNATURES = [
            ['python', [/^\\s*def\\s+\\w+\\s*\\(.*\\)\\s*(->[^:]*)?:/m, /^\\s*(from\\s+[\\w.]+\\s+)?import\\s+[\\w.,*\\s]+$/m, /\\bself\\.\\w+/, /^\\s*class\\s+\\w+.*:\\s*$/m, /\\bprint\\s*\\(/, /\\b(elif|None|True|False|__init__|__name__)\\b/]],
            ['javascript', [/\\b(const|let|var)\\s+\\w+\\s*=/, /\\bfunction\\s*\\w*\\s*\\(/, /=>/, /\\brequire\\s*\\(/, /\\bconsole\\.(log|error|warn)\\s*\\(/, /\\bexport\\s+(default|const|function)/]],
            ['go', [/^\\s*package\\s+\\w+\\s*$/m, /\\bfunc\\s+\\w*\\s*\\(/, /\\bfmt\\.(Println|Printf|Errorf)\\s*\\(/, /:=/]],
            ['rust', [/\\bfn\\s+\\w+\\s*\\(/, /\\blet\\s+mut\\s+/, /\\bprintln!\\s*\\(/, /\\buse\\s+std::/]],
            ['java', [/\\b(public|private|protected)\\s+(static\\s+)?(final\\s+)?\\w+[\\w<>\\[\\]]*\\s+\\w+\\s*\\(/, /System\\.out\\.print/]],
            ['csharp', [/using\\s+System[\\s;]/, /namespace\\s+\\w+/, /Console\\.WriteLine\\s*\\(/]],
            ['php', [/<\\?php/, /\\$\\w+\\s*=/]],
            ['sql', [/\\b(SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|CREATE\\s+TABLE)\\b/i, /\\bFROM\\s+\\w+/i]],
            ['bash', [/^\\s*#!\\/.*\\b(ba)?sh\\b/m, /^\\s*(sudo|apt|apt-get|yum|brew|cd|ls|rm|mkdir|chmod|chown|curl|wget|git|export)\\s/m, /\\$\\{?\\w+\\}?/]],
            ['json', [/^\\s*[{[][\\s\\S]*[}\\]]\\s*$/]],
            ['yaml', [/^\\s*[\\w-]+:\\s*.*$/m, /^\\s*-\\s+\\w+:/m]]
        ];

        function detectLanguage(text) {
            if (!text || !text.trim()) return null;
            if (CJK.test(text)) return null;
            for (const [lang, patterns] of LANG_SIGNATURES) {
                if (patterns.some(pattern => pattern.test(text))) {
                    return window.hljs && window.hljs.getLanguage(lang) ? lang : null;
                }
            }
            if (!window.hljs) return null;
            const auto = window.hljs.highlightAuto(text);
            return auto && auto.language ? auto.language : null;
        }

        function renderContent(text) {
            const target = document.getElementById('content');
            const language = window.hljs ? detectLanguage(text) : null;
            if (language) {
                try {
                    target.classList.add('hljs');
                    target.innerHTML = window.hljs.highlight(text, { language }).value;
                    return;
                } catch {
                    target.classList.remove('hljs');
                }
            }
            target.textContent = text;
        }

        async function showContent(encryptedContent) {
            try {
                decryptedText = await Crypto.decrypt(encryptedContent, code);
                renderContent(decryptedText);
                document.getElementById('copyBtn').onclick = () => {
                    navigator.clipboard.writeText(decryptedText).then(() => {
                        document.getElementById('copyBtn').textContent = '已复制';
                        setTimeout(() => { document.getElementById('copyBtn').textContent = '复制内容'; }, 2000);
                    });
                };
            } catch {
                document.getElementById('content').textContent = '解密失败';
            }
        }

        ${exists && !requirePin ? `
        fetch('/api/p/' + code, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(r => r.json())
            .then(data => {
                if (data.content) {
                    showContent(data.content);
                } else {
                    document.getElementById('content').textContent = data.error || '获取失败';
                }
            })
            .catch(() => { document.getElementById('content').textContent = '获取失败'; });
        ` : ''}
        ${exists && requirePin ? `
        document.getElementById('pinForm').onsubmit = async (e) => {
            e.preventDefault();
            const pin = document.getElementById('pinInput').value;
            if (!/^\\d{4}$/.test(pin)) return;

            try {
                const res = await fetch('/api/p/' + code, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin })
                });
                const data = await res.json();

                if (data.content) {
                    document.querySelector('.container').innerHTML =
                        '<div class="title">分享内容</div>' +
                        '<div class="content" id="content">解密中...</div>' +
                        '<button class="btn" id="copyBtn">复制内容</button>' +
                        '<p class="notice">此内容已从服务器删除</p>';
                    showContent(data.content);
                } else {
                    // 用 textContent 而非拼接 innerHTML：不必依赖「服务端错误文案恒为
                    // 固定字符串」这一隐含前提，将来任何把用户输入拼进 error 的改动
                    // 都不会因此变成 XSS
                    const errorBox = document.getElementById('errorMsg');
                    const msg = document.createElement('div');
                    msg.className = 'msg error-msg';
                    msg.textContent = data.error || '验证失败';
                    errorBox.replaceChildren(msg);
                    if (data.error && data.error.includes('销毁')) {
                        document.getElementById('pinForm').style.display = 'none';
                    }
                }
            } catch {
                document.getElementById('errorMsg').innerHTML = '<div class="msg error-msg">请求失败</div>';
            }
        };
        ` : ''}
    </script>
</body>
</html>`;

    res.type('html').send(html);
});

function createServer() {
    if (config.server.https.enabled) {
        const https = require('https');
        const httpsOptions = {
            key: fsSync.readFileSync(config.server.https.keyPath),
            cert: fsSync.readFileSync(config.server.https.certPath)
        };
        if (config.server.https.caPath && fsSync.existsSync(config.server.https.caPath)) {
            httpsOptions.ca = fsSync.readFileSync(config.server.https.caPath);
        }
        return https.createServer(httpsOptions, app);
    }
    return http.createServer(app);
}

function gracefulShutdown(signal) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    // 关库会把 WAL 合并回主文件（checkpoint），于是升级/备份只需处理一个 .db 文件。
    if (db) {
        try {
            db.close();
        } catch (err) {
            console.error('关闭数据库失败:', err.message);
        }
        db = null;
    }
    if (server) {
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
        setTimeout(() => {
            console.error('Forced shutdown after timeout');
            process.exit(1);
        }, 10000);
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

init().then(() => {
    config.validate();
    
    server = createServer();
    const HOST = config.server.host;
    const PORT = config.server.port;
    const protocol = config.server.https.enabled ? 'https' : 'http';
    
    server.listen(PORT, HOST, () => {
        console.log(`
┌─────────────────────────────────────────┐
│           Nav Sylph Server              │
├─────────────────────────────────────────┤
│  URL:      ${protocol}://${HOST}:${PORT}`.padEnd(43) + `│
│  HTTPS:    ${config.server.https.enabled ? 'Enabled' : 'Disabled'}`.padEnd(43) + `│
│  Logs:     ${path.relative(config.rootDir, config.paths.logs) || 'logs/'}`.padEnd(43) + `│
└─────────────────────────────────────────┘
`);
    });
}).catch(err => {
    console.error('启动失败:', err);
    // 开库或迁移失败时连接可能已经建立：先关库再退出，避免留下未 checkpoint 的 WAL。
    if (db) {
        try { db.close(); } catch { /* 关不掉也要退出 */ }
        db = null;
    }
    process.exit(1);
});

module.exports = app;

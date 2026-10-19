'use strict';

/**
 * 普通访问者的口令云端空间。
 *
 * 与 `lib/navigation.js`（管理员的导航/模板，会话 cookie 鉴权）是两套东西，
 * 不要互相复用：那套的凭据是管理员会话，这套的凭据是**访客自设的口令**。
 *
 * ## 口令怎么变成凭据
 *
 * 口令本身**从不上行**。浏览器用 Web Crypto 把它派生成 64 位十六进制的
 * 「连接证明」，本模块再哈希一次得到 `proof_id` 存库并用作定位键。所以：
 *
 *   浏览器：proof = sha256( CONNECT_LABEL + '\0' + 口令 )      // public/app.js
 *   服务端：proof_id = sha256( STORE_LABEL + '\0' + proof )    // 本文件
 *
 * 两级哈希的分工是「用途 + 版本隔离」：`CONNECT_LABEL` 里的 `-v1` 是版本，
 * `space-connect` 是用途。将来换用法或换版本就换标签，**同一个口令算出来的
 * 证明不同**，旧的证明定位不到新空间——不需要额外的命名空间字段。
 * 两处标签分居两个文件，所以有一条测试从两份源码里各解析出来对拍。
 *
 * 已知边界（设计文档 §7 已声明，这里如实复述）：两级都是**快速哈希**，
 * 不抗离线弱口令猜测。首版不宣称端到端加密，服务端能看到空间内容。
 *
 * ## 竞争安全
 *
 * 创建与连接都在**单个 better-sqlite3 事务**里完成（驱动同步执行，进程内
 * 不会有交错）。竞争创建靠 `UNIQUE(proof_id)` 而不是「先查后插」；邀请码
 * 消耗靠 `UPDATE ... WHERE used_at IS NULL` 的 `changes` 断言而不是「先读后写」。
 * 这两处是本模块最容易被后人改坏的地方：把断言换成读取判断，单线程下测试
 * 照样全绿，但语义就从「原子」退化成「尽力」了。
 *
 * ## 设备令牌
 *
 * 32 字节安全随机，明文只在签发响应里出现一次；库里只有 `token_hash`。
 * 令牌绑定签发时的空间**代次**，代次一涨（撤销全部旧设备）旧令牌立即失效。
 * 连续 90 天没有成功鉴权即失效，每次成功读取会滑动续期。
 *
 * ## 幂等回执
 *
 * 同一个客户端 `operationId` 的重试必须拿回同一份材料，否则「响应丢了但事务
 * 已提交」会让用户每点一次就多一个设备。材料（含令牌明文）用
 * `lib/credentials.js` 的 `sync-receipt` 用途加密后暂存 24 小时——库里不留
 * 明文令牌。回执**还绑定代次**：代次变了就不再返回材料，避免「撤销之后靠
 * 重试把刚作废的令牌要回来」。
 *
 * ## 额度与总暂停（Issue #10）
 *
 * 两件事都在这一个模块里，**判定只有一处**：
 *
 *  - **额度**：每空间 1 MiB（`config_json + modules_json` 之和，物化在
 *    `sync_spaces.content_bytes`）、全实例 1000 空间、有效配置合计 1 GiB。
 *    超限一律 **503**（`space_quota_exceeded` / `storage_limit` / `space_limit`），
 *    **绝不淘汰**已有空间；**读取与删除不受额度影响**；**缩减写入无条件放行**
 *    ——没有这条，一个已经超限的空间就再也删不掉自己的内容了。
 *    并发检查靠 store 内的**单事务**：先查后写会看出「两个请求都通过」。
 *
 *  - **总暂停**（`sync_paused`）：管理员的一个开关，挡的是**数据面**
 *    （读 / 写 / 连接 / 创建 / 重新连接），**但「删除空间」与「撤销本设备」
 *    照常可用**——否则管理员一开总暂停，用户连自己的数据都删不掉了，等于
 *    被锁在里面。返回 503 + `Retry-After`，客户端按 5 分钟间隔轮询等恢复。
 *
 * 这两个开关**必须落在 `sync_settings` 表里**，不能只放进程内存：总暂停是
 * 一份管理策略，重启后本该继续生效；只存内存的实现会在重启时静默放开，而
 * 那一刻没有任何人会注意到（服务正常、界面也正常，只是不挡了）。
 */

const { createHash, randomBytes } = require('node:crypto');
const { validate, FIELDS } = require('../public/navigation-schema');
const { encrypt, decrypt, isEnvelope } = require('./credentials');

// 用途 + 版本。改这两行等于换一代协议：老的证明全部定位不到空间。
// 浏览器侧同名常量在 public/app.js，两处必须逐字一致。
const CONNECT_LABEL = 'sylph-space-connect-v1';
const STORE_LABEL = 'sylph-space-store-v1';

// 各类凭据的哈希前缀：把「同一个字符串在不同用途下哈希相同」这件事掐掉。
const TOKEN_HASH_LABEL = 'sylph-device-token-v1';
const INVITE_HASH_LABEL = 'sylph-invite-code-v1';

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
// 记录保留窗口。**跑得比窗口勤得多**：由 server.js 的 60 秒定时器调用，过期即删。
// 这两个常量只是「多久之后算陈旧」，不是清理周期。
const INVITE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const DEVICE_IDLE_MS = 90 * 24 * 60 * 60 * 1000;

// ---- 管理员列表的分页与服务端批量 ------------------------------------------
//
// 这些上限**在服务端判**，不是「只在界面上限」：界面那一层是给用户看的，绕过它
// 打一条 curl 的时候，没有任何东西会替这层把关。四个数都从 `lib/sync-store.js`
// 导出，测试与界面读的是同一个值（散成两份必然漂移）。
const PAGE_LIMIT_DEFAULT = 20;    // 每页默认 20 条（设计定稿）
const PAGE_LIMIT_MAX = 100;       // 单页上限：再多也不是「列表」，是导出
const INVITE_BATCH_MAX = 20;      // 单次批量生成上限（用户拍定：20 张）
const INVITE_REVOKE_MAX = 100;    // 单次批量撤销上限（多选一整页也够）

// 空间列表的**筛选与排序白名单**。
//
// ⚠️ 这两张表是本模块唯一会把「请求里的字符串」变成 SQL 片段的地方，所以做法是
// **查表**而不是拼串：`state` / `sort` 的取值先在表里找，找不到就回落到 `all` /
// `updated`，用户给的值**永远不进入 SQL**，只进入参数绑定（`q` / `limit` / `offset`
// 也一样）。这是「参数化 + 白名单」的完整写法：缺了白名单，参数化也挡不住
// `ORDER BY` 这种「值就是语法」的位置；缺了参数化，白名单里的片段还得靠转义。
const SPACE_STATE_FILTERS = {
    all: '',                                              // 全部：连墓碑一起看（治理面板要能看见已删除的）
    active: 'AND s.disabled = 0 AND s.deleted = 0',        // 正常
    disabled: 'AND s.disabled = 1 AND s.deleted = 0',      // 已停用
    deleted: 'AND s.deleted = 1'                          // 已删除（墓碑）
};
const SPACE_SORT_ORDERS = {
    // 默认「最近更新」。三种排序都拿 id 兜底：没有它，同一毫秒/同体积的行在翻页时
    // 会顺序不稳，用户会看到某一行在两页里各出现一次（或一次都不出现）。
    updated: 'ORDER BY s.updated_at DESC, s.id ASC',
    bytes: 'ORDER BY s.content_bytes DESC, s.updated_at DESC, s.id ASC',
    devices: 'ORDER BY active_devices DESC, s.updated_at DESC, s.id ASC'
};

/**
 * 邀请码的四种状态片段。**互不重叠、合起来等于全部**（`counts` 的四个数与
 * `page.total` 是同一套划分，界面才能把它们加起来）。
 *
 * 优先级写在这个顺序里：已使用 > 已撤销 > 已过期 > 未使用。一张已使用的码即使
 * 事后被 `/revoke/:id`（旧路由）标了 `revoked`，它仍然只算「已使用」——否则
 * 「用了多少张」这个数会因为一次撤销而变少。
 */
const INVITE_STATE_FILTERS = {
    all: () => ({ where: '', args: [] }),
    unused: (at) => ({ where: 'AND used_at IS NULL AND revoked = 0 AND expires_at > ?', args: [at] }),
    used: () => ({ where: 'AND used_at IS NOT NULL', args: [] }),
    expired: (at) => ({ where: 'AND used_at IS NULL AND revoked = 0 AND expires_at <= ?', args: [at] }),
    revoked: () => ({ where: 'AND used_at IS NULL AND revoked = 1', args: [] })
};
const INVITE_STATES = ['unused', 'used', 'expired', 'revoked'];

/** 每页条数：非法/缺省回落到 20，上限 100。**不抛错**（界面上限被绕开时也别 400）。 */
function pageLimit(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return PAGE_LIMIT_DEFAULT;
    return Math.min(Math.floor(n), PAGE_LIMIT_MAX);
}
/** 偏移量：非法/负数回落到 0。越界（偏移大于总数）由查询自己返回空页。 */
function pageOffset(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
}
/** 白名单取值：找不到就回落，绝不把调用方给的值透到 SQL 里。 */
function pick(table, value, fallback) {
    return typeof value === 'string' && Object.hasOwn(table, value) ? value : fallback;
}

const MODULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODULE_LIMIT = 50;
const MODULE_SETTING_KEYS = 20;
const MODULE_SETTING_TEXT = 200;
const MODULES_MAX_BYTES = 128 * 1024;

// ---- 额度（设计文档 §7 的默认值）----------------------------------------
//
// ⚠️ 这三个数与 server.js 的限流常量一样，**只有这一处实现**：读取路径（`sweep`、
// 管理员列表）与判定路径（`createSpace` / `writeConfig`）都从这里取。散成两份
// 必然漂移，而漂移的症状是「接口说超了、另一条路径却放行」。
//
// 测试要注入小限额，所以它是**函数**而不是常量：`options.limits` 覆盖注入的值
// （server.js 从 env 读、测试直接传），默认值就是这里的三个规格数。测试另有一条
// 断言把默认值与规格逐字对拍（1000 / 1 MiB / 1 GiB）——只测注入路径的话，默认值
// 被改小也全绿。
const DIFFICULTY = {
    spaceLimit: 1000,                 // 全实例空间数上限
    contentBytesLimit: 1024 * 1024,   // 每空间 1 MiB（config_json + modules_json 之和）
    totalBytesLimit: 1024 * 1024 * 1024 // 全实例有效配置总量 1 GiB
};

// 墓碑清理窗口。与设备令牌的 90 天窗口同值，但**语义不同**：那条是「没鉴权多久
// 算过期」，这条是「空间删掉多久之后连墓碑都不必留」。
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// 已撤销设备行的保留窗口。撤销时把 `revoked = 1` 留着，是因为客户端要能区分
// 「本设备被踢了」（401 `device_revoked`）与「根本没这枚令牌」（401 `device_invalid`）；
// 过了这个窗口两种都归 401 无效，那条行就没有信息量了。
const REVOKED_DEVICE_RETENTION_MS = 24 * 60 * 60 * 1000;

// 总暂停期间客户端该等多久再来问。服务端把它放进 503 的 `Retry-After`，
// 客户端 `SYNC_PAUSED_POLL_MS` 与它同值——**一处定义不可能，两处必然要一致**，
// 所以有一条测试把两边解析出来对拍（改一边而忘了另一边，症状是客户端要么
// 比服务端要求来得更勤（白发请求），要么更懒（恢复后迟迟不回来）。
const SYNC_PAUSED_RETRY_MS = 5 * 60 * 1000;

/**
 * 内容的 UTF-8 字节数。**与内容同一条 INSERT/UPDATE 物化进 `content_bytes`**，
 * 不在读路径上现算——见 `lib/db.js` 的 v11 注释。
 */
function contentBytes(configJson, modulesJson) {
    return Buffer.byteLength(configJson, 'utf8') + Buffer.byteLength(modulesJson, 'utf8');
}

const PROOF_PATTERN = /^[0-9a-f]{64}$/;
// 墓碑的 proof_id 前缀：见 lib/db.js 的 v10 注释。唯一性来自**空间 id**
// （同一个口令删两次会留下两个墓碑，用口令做唯一部分会撞 UNIQUE，实测 500）。
// 冒号不可能出现在正常的 proof_id 里（上面那条形状约束），所以两种取值不相交。
const DELETED_PROOF_PREFIX = 'gone:';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function fail(message, status = 400, code = 'invalid') {
    throw Object.assign(new Error(message), { status, code });
}
function text(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * 邀请码归一化：只允许「十六进制 + 分隔符」。
 * 口令不裁空格，**邀请码裁**——它是管理员手抄给用户的一串码，
 * 复制粘贴时带进来一个空格是常态，而它本身不是用户自设的密码。
 */
function normalizeInviteCode(value) {
    const cleaned = typeof value === 'string' ? value.replace(/[\s-]/g, '').toLowerCase() : '';
    if (!/^[0-9a-f]{24}$/.test(cleaned)) fail('邀请码无效', 403, 'invite_invalid');
    return cleaned;
}
function formatInviteCode(hex) {
    return hex.replace(/(.{4})(?=.)/g, '$1-');
}

/** 空间的配置只存导航 schema 的五个字段，其余一律拒绝（不是静默丢弃）。 */
function validateSyncConfig(value) {
    validate(value);
    return Object.fromEntries(FIELDS.map((key) => [key, value[key]]));
}

/**
 * 公开模块偏好的严格归一化。
 *
 * 只允许 `enabled` / `widgets` / `settings` 三个键——管理员字段（`servers`、
 * `publicModules`、`pollInterval`…）、收藏、私人都没有落脚点，出现即 400。
 * 模块 id 限定在服务端的 `PUBLIC_MODULE_IDS` 里：私人模块的 id 即使写进来了
 * 也**不会进库**（丢弃而不是报错，因为客户端可能还留着某个已下架公开模块的
 * 陈旧 id，为它拒掉整次保存是没必要的强硬）。
 */
function normalizeSyncModules(input, publicIds) {
    const allowed = new Set(publicIds);
    const out = { enabled: [], widgets: [], settings: {} };
    if (input === undefined || input === null) return out;
    if (typeof input !== 'object' || Array.isArray(input)) fail('模块偏好必须是对象');
    if (Object.keys(input).some((key) => !['enabled', 'widgets', 'settings'].includes(key))) {
        fail('模块偏好包含不允许的字段');
    }
    if (input.enabled !== undefined) {
        if (!Array.isArray(input.enabled) || input.enabled.length > MODULE_LIMIT) fail('模块启用列表无效');
        out.enabled = [...new Set(input.enabled.filter((id) => typeof id === 'string' && MODULE_ID.test(id) && allowed.has(id)))];
    }
    if (input.widgets !== undefined) {
        if (!Array.isArray(input.widgets) || input.widgets.length > MODULE_LIMIT) fail('模块布局无效');
        out.widgets = input.widgets.map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) fail('模块布局无效');
            if (Object.keys(item).some((key) => !['id', 'side', 'order', 'collapsed'].includes(key))) fail('模块布局包含不允许的字段');
            if (!allowed.has(item.id)) return null;
            const order = Number.isInteger(item.order) && item.order >= 0 && item.order <= 9999 ? item.order : 0;
            return { id: item.id, side: item.side === 'left' ? 'left' : 'right', order, collapsed: item.collapsed === true };
        }).filter(Boolean);
    }
    if (input.settings !== undefined) {
        if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) fail('模块偏好无效');
        for (const [id, value] of Object.entries(input.settings)) {
            if (!allowed.has(id)) continue;
            if (!value || typeof value !== 'object' || Array.isArray(value)) fail('模块偏好无效');
            const keys = Object.keys(value);
            if (keys.length > MODULE_SETTING_KEYS) fail('模块偏好项过多');
            const clean = {};
            for (const key of keys) {
                const item = value[key];
                if (typeof item === 'string') {
                    if (item.length > MODULE_SETTING_TEXT) fail('模块偏好过长');
                    clean[key] = item;
                } else if (typeof item === 'number') {
                    if (!Number.isFinite(item)) fail('模块偏好无效');
                    clean[key] = item;
                } else if (typeof item === 'boolean') {
                    clean[key] = item;
                } else {
                    fail('模块偏好值无效');
                }
            }
            out.settings[id] = clean;
        }
    }
    if (Buffer.byteLength(JSON.stringify(out)) > MODULES_MAX_BYTES) fail('模块偏好过大');
    return out;
}

/** 「条目数」= 全部分类下的导航链接数——检查空间时给用户看的规模指标。 */
function entryCount(config) {
    return (config.categories || []).reduce((total, category) => total + (category.bookmarks || []).length, 0);
}

function createSyncStore(db, options = {}) {
    const now = options.now || (() => Date.now());
    const publicIds = () => (typeof options.publicModuleIds === 'function' ? options.publicModuleIds() : (options.publicModuleIds || []));
    const passwordHash = () => {
        const value = typeof options.getPasswordHash === 'function' ? options.getPasswordHash() : options.passwordHash;
        if (typeof value !== 'string' || !value) throw new Error('缺少密码哈希，无法加解密签发回执');
        return value;
    };
    // 额度**只在这一处解析**：默认值来自 DIFFICULTY，`options.limits` 只为注入
    // 小限额（server.js 从 env 读、测试直接传）。三个字段各自独立覆盖，缺省回到规格值。
    const limits = {
        spaceLimit: Number.isInteger(options.limits?.spaceLimit) ? options.limits.spaceLimit : DIFFICULTY.spaceLimit,
        contentBytesLimit: Number.isInteger(options.limits?.contentBytesLimit) ? options.limits.contentBytesLimit : DIFFICULTY.contentBytesLimit,
        totalBytesLimit: Number.isInteger(options.limits?.totalBytesLimit) ? options.limits.totalBytesLimit : DIFFICULTY.totalBytesLimit
    };

    const proofId = (proof) => sha256(`${STORE_LABEL}\u0000${proof}`);
    const hashToken = (token) => sha256(`${TOKEN_HASH_LABEL}\u0000${token}`);
    const hashInvite = (code) => sha256(`${INVITE_HASH_LABEL}\u0000${code}`);

    function requireProof(value) {
        if (typeof value !== 'string' || !PROOF_PATTERN.test(value)) fail('连接证明无效', 400, 'proof_invalid');
        return value;
    }
    function requireOperationId(value) {
        const id = text(value, 100);
        if (!id) fail('缺少操作标识', 409, 'operation_required');
        return id;
    }

    // ---- 全局设置（单行）与额度 -------------------------------------------

    /** 读 `sync_settings` 的那一行。表与行都由 v11 迁移建好，这里只读。 */
    function settings() {
        return db.prepare('SELECT * FROM sync_settings WHERE id = 1').get() || { creating_paused: 0, sync_paused: 0, updated_at: 0 };
    }

    /**
     * 总暂停的闸门。**只在这一处判**——不要在 `syncDeviceGuard` 里再写一遍：
     * 判定散成两处必然漂移，而且删除/撤销那两条**必须放行**的路径最容易漏掉一处。
     *
     * `Retry-After` 的秒数由调用方（server.js 的 `syncFailure`）从 `retryAfter`
     * 算出来——这里给的是**时刻**而不是秒数，与限流那几只桶同一种表达。
     */
    function requireNotPaused(at) {
        if (!settings().sync_paused) return;
        throw Object.assign(new Error('同步服务已由管理员暂停，请稍后再试'), {
            status: 503, code: 'sync_paused', retryAfter: at + SYNC_PAUSED_RETRY_MS
        });
    }

    /**
     * 「暂停新建」的闸门。与总暂停**是两个开关**（设计 §7：「暂停新建仅影响新空间，
     * 已有空间继续同步」）：
     *   · 暂停新建 → 只有创建被拒（503 `create_paused`）；
     *   · 总暂停 → 连读都不放行。
     * 两者都由 `createSpace` 检查，各有各的 code，客户端能说清是哪一种。
     */
    function requireNotCreatingPaused(at) {
        if (!settings().creating_paused) return;
        // 也带 `Retry-After`：诚实的客户端会等一会儿再试（暂停是**临时的**，
        // 管理员随时会打开）。不带的后果是客户端对着 503 反复重试。
        throw Object.assign(new Error('管理员已暂停新建云端空间'), {
            status: 503, code: 'create_paused', retryAfter: at + SYNC_PAUSED_RETRY_MS
        });
    }

    /**
     * 每空间内容额度的判定。**只看写**：读与删不受额度影响。
     *
     * `bytes` 是这次写入**将要变成**的字节数（由调用方算好）。判据是
     * `bytes > limit`——而调用方在调它之前会先比「是不是比现在还小」，
     * 缩减写入因此无条件放行（见 `writeConfig`）：没有那条，一个已经超限的
     * 空间就再也删不掉自己的内容，用户被自己的数据锁在门外。
     */
    function requireContentQuota(bytes) {
        if (bytes > limits.contentBytesLimit) {
            fail('这个空间的配置已超过 1 MiB 上限，请先精简内容', 503, 'space_quota_exceeded');
        }
    }

    /**
     * 全实例的两个额度。都在**同一个事务里**读当前总量再比：
     * 先查后写会让两个并发创建都看到「还没满」。`bytes` 为 0 时（纯删除路径）
     * 只比空间数。
     */
    function requireInstanceQuota(extraBytes) {
        const spaces = db.prepare('SELECT COUNT(*) AS n FROM sync_spaces WHERE deleted = 0').get().n;
        if (spaces >= limits.spaceLimit) fail('本实例的云端空间数量已达上限', 503, 'space_limit');
        if (!extraBytes) return;
        const total = db.prepare('SELECT COALESCE(SUM(content_bytes), 0) AS n FROM sync_spaces WHERE deleted = 0').get().n;
        if (total + extraBytes > limits.totalBytesLimit) fail('本实例的云端配置总量已达上限', 503, 'storage_limit');
    }

    /** 管理员列表要展示的总量（存储那一半）。同一份 `content_bytes` 求和，不现算字符串长度。 */
    function storageUsage() {
        const row = db.prepare('SELECT COUNT(*) AS spaces, COALESCE(SUM(content_bytes), 0) AS bytes FROM sync_spaces WHERE deleted = 0').get();
        return { spaces: row.spaces, bytes: row.bytes };
    }

    /**
     * 概览用的三个数（**全实例**，与当前页无关）。
     *
     * ⚠️ 这一条是「全实例」而不是「当页合计」：面板顶上的「空间总数 / 有效配置
     * 字节数 / 活跃设备数」是治理指标（上限 1000 空间、1 GiB 用掉了多少），把当页
     * 那一行加起来会得出一个随机数——翻页时它还会变。`spaces` / `bytes` 复用
     * `storageUsage()`（不再写第二份 SQL）；`devices` 只数**未撤销且空间未删除**的
     * 设备，墓碑名下的设备行只是留痕，不代表有人连着。
     */
    function instanceUsage() {
        const storage = storageUsage();
        const devices = db.prepare(`SELECT COUNT(*) AS n FROM sync_devices d
                                    JOIN sync_spaces s ON s.id = d.space_id
                                    WHERE d.revoked = 0 AND s.deleted = 0`).get().n;
        return { spaces: storage.spaces, bytes: storage.bytes, devices };
    }

    // ---- 管理员治理（Issue #10）-------------------------------------------
    //
    // 这三条都**只回非敏感项**：标识、状态、体积、版本、代次、活跃设备数、时间。
    // 正文（config/modules）、口令哈希、`deleted_proof_id`、令牌与其哈希、回执
    // 一律不出现——管理员能看到「这个空间多大、什么时候动的」，但拿不到它的内容，
    // 也无法凭列表里的任何字段冒充某台设备（设计文档 §7 明令）。

    /**
     * 管理员列表：**服务端分页 + 前缀搜索 + 状态筛选 + 排序**。
     *
     * 参数化与白名单的分工见文件顶部那两张常量的注释。这里只强调两件事：
     *
     *  · `q` 是**前缀**匹配，不是包含、更不是内容搜索：`instr(s.id, ?) = 1` 就是
     *    「`q` 出现在 id 的第 1 个位置」。用 `LIKE ? || '%'` 也行，但那样得先转义
     *    `%`/`_`（用户搜一个 `_` 会把整表都匹配上），而 `instr` 没有通配符语义，
     *    天然干净。**不查正文**：正文根本不在这个 SELECT 里。
     *
     *  · `page.total` 是**筛选后**的总数（不含 LIMIT），界面靠它算总页数；`usage`
     *    则是全实例，两者不是一回事（见 `instanceUsage` 的注释）。
     */
    function listSpaces(options = {}) {
        const state = pick(SPACE_STATE_FILTERS, options.state, 'all');
        const sort = pick(SPACE_SORT_ORDERS, options.sort, 'updated');
        const needle = typeof options.q === 'string' ? options.q.trim().toLowerCase().slice(0, 100) : '';
        const limit = pageLimit(options.limit);
        const offset = pageOffset(options.offset);
        const filter = SPACE_STATE_FILTERS[state];
        const args = [];
        let where = filter;
        if (needle) {
            where += ' AND instr(s.id, ?) = 1';
            args.push(needle);
        }
        const total = db.prepare(`SELECT COUNT(*) AS n FROM sync_spaces s WHERE 1 = 1 ${where}`).get(...args).n;
        const rows = db.prepare(`
            SELECT s.id, s.revision, s.generation, s.content_bytes, s.created_at, s.updated_at,
                   s.disabled, s.disabled_at, s.deleted, s.deleted_at,
                   (SELECT COUNT(*) FROM sync_devices d WHERE d.space_id = s.id AND d.revoked = 0) AS active_devices
            FROM sync_spaces s
            WHERE 1 = 1 ${where}
            ${SPACE_SORT_ORDERS[sort]}
            LIMIT ? OFFSET ?
        `).all(...args, limit, offset);
        return {
            success: true,
            spaces: rows.map((row) => ({
                id: row.id,
                revision: row.revision,
                generation: row.generation,
                contentBytes: row.content_bytes,
                activeDevices: row.active_devices,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                disabled: !!row.disabled,
                disabledAt: row.disabled_at || null,
                deleted: !!row.deleted,
                deletedAt: row.deleted_at || null
            })),
            page: { total, offset, limit },
            usage: instanceUsage()
        };
    }

    // ---- 回执 -------------------------------------------------------------

    function pruneReceipts(at) {
        db.prepare('DELETE FROM sync_receipts WHERE created_at < ?').run(at - RECEIPT_TTL_MS);
    }
    function readReceipt(scope, operationId, digest) {
        const row = db.prepare('SELECT * FROM sync_receipts WHERE scope = ? AND operation_id = ?').get(scope, operationId);
        if (!row) return null;
        if (row.digest !== digest) fail('同一操作标识不能提交不同内容', 409, 'operation_conflict');
        return row;
    }
    /** 读出回执里加密的材料；解不开（改过密码）就当作没有回执，让调用方重走一次。 */
    function receiptPayload(row) {
        let envelope;
        try {
            envelope = JSON.parse(row.material);
        } catch {
            return null;
        }
        if (!isEnvelope(envelope)) return null;
        try {
            return JSON.parse(decrypt(envelope, passwordHash(), 'sync-receipt'));
        } catch {
            return null;
        }
    }
    function writeReceipt(scope, operationId, digest, payload, at) {
        const envelope = encrypt(JSON.stringify(payload), passwordHash(), 'sync-receipt');
        db.prepare('DELETE FROM sync_receipts WHERE scope = ? AND operation_id = ?').run(scope, operationId);
        db.prepare('INSERT INTO sync_receipts (scope, operation_id, digest, material, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(scope, operationId, digest, JSON.stringify(envelope), at);
    }

    /**
     * 重放一份签发回执。
     *
     * 三道门都要过：材料还解得开（密码没换）、材料绑定的代次仍是当前代次
     * （期间没被「撤销全部旧设备」掀掉）、设备行还在且未撤销。任何一道不过
     * 就明确要求重新输入口令——**不能**把一份已经作废的令牌当成功返回。
     */
    function replayIssuance(row, digest, at) {
        if (row.digest !== digest) fail('同一操作标识不能提交不同内容', 409, 'operation_conflict');
        const payload = receiptPayload(row);
        if (!payload || !payload.deviceToken) fail('连接材料已过期，请重新输入口令', 409, 'receipt_expired');
        const device = db.prepare('SELECT * FROM sync_devices WHERE token_hash = ?').get(hashToken(payload.deviceToken));
        const space = device ? db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(device.space_id) : null;
        if (!device || device.revoked || !space || space.disabled
            || device.generation !== space.generation || device.generation !== payload.generation) {
            db.prepare('DELETE FROM sync_receipts WHERE scope = ? AND operation_id = ?').run(row.scope, row.operation_id);
            fail('连接材料已失效，请重新输入口令', 409, 'receipt_stale');
        }
        db.prepare('UPDATE sync_devices SET last_seen_at = ? WHERE token_hash = ?').run(at, device.token_hash);
        return {
            success: true,
            spaceId: space.id,
            generation: space.generation,
            revision: space.revision,
            updatedAt: space.updated_at,
            entryCount: entryCount(JSON.parse(space.config_json)),
            deviceToken: payload.deviceToken
        };
    }

    // ---- 签发 -------------------------------------------------------------

    /**
     * 签一台新设备。
     *
     * `onIssue` 是**每个空间的签发上限**（设计文档 §7：30 次/分钟）。放在这里是因为
     * 只有本模块知道 `spaceId`，而「知道口令的人能无限换设备」这条滥用面正需要按空间
     * 封顶。位置在插入设备行之前只是读起来顺——两种顺序在外部等价，因为整段都在同一个
     * 事务里，回调抛错时插入会跟着回滚（试过把它挪到后面，用例照样全绿，所以没有为
     * 它写断言）。回执重放**不**经过它：重放没有签发新设备。
     * 可选：不传就只是不设这道闸（store 用例里按需注入）。
     */
    function issueDevice(space, at) {
        if (typeof options.onIssue === 'function') options.onIssue(space.id);
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sync_devices (token_hash, space_id, generation, created_at, last_seen_at, revoked) VALUES (?, ?, ?, ?, ?, 0)')
            .run(hashToken(token), space.id, space.generation, at, at);
        return token;
    }

    function deviceForToken(token, at) {
        if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) fail('设备凭据无效', 401, 'device_invalid');
        const device = db.prepare('SELECT * FROM sync_devices WHERE token_hash = ?').get(hashToken(token));
        if (!device) fail('设备凭据无效', 401, 'device_invalid');
        const space = db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(device.space_id);
        if (!space) fail('设备凭据无效', 401, 'device_invalid');
        // ⚠️ 顺序：**先看空间是否已删，再看设备是否被吊销**。删除会把该空间的
        // 设备一起吊销，所以先判吊销的话「空间已被删除」这条永远读不到，客户端
        // 就分不出「空间没了」与「这台设备被踢了」——而这两种的下一条提示完全不同。
        if (space.deleted) fail('云端空间已被删除，已转为仅保存在本机', 410, 'space_deleted');
        if (device.revoked) fail('这台设备已断开同步，请重新输入口令', 401, 'device_revoked');
        // 代次不符 = 这个令牌在「撤销全部旧设备」之后没被重新签发过，立即失效，
        // 不回退到「空间还在所以放行」。
        if (device.generation !== space.generation) fail('设备授权已变化，请重新输入口令', 401, 'device_invalid');
        if (at - device.last_seen_at > DEVICE_IDLE_MS) fail('连接已过期，请重新输入口令', 401, 'device_expired');
        if (space.disabled) fail('该空间已停用', 403, 'space_disabled');
        db.prepare('UPDATE sync_devices SET last_seen_at = ? WHERE token_hash = ?').run(at, device.token_hash);
        return { device, space };
    }

    // ---- 邀请码 -----------------------------------------------------------

    /**
     * 往 `sync_invites` 插一张新码。**码的明文只在这一层出现**：返回给调用方之后
     * 库里只有 `code_hash` 与 4 位 `hint`，谁也再捞不回来（邀请码就是「开一个空间」
     * 的凭据，能捞回来等于库里存了一份可用的凭据）。
     *
     * 单张与批量共用这一份字段与 TTL：两处各写一遍的话，漂移的第一站就是有效期
     * （界面说 48 小时、库里却是别的值）。
     */
    function insertInvite(at) {
        const code = randomBytes(12).toString('hex');
        const id = randomBytes(8).toString('hex');
        db.prepare('INSERT INTO sync_invites (id, code_hash, hint, created_at, expires_at, used_at, used_space, revoked) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0)')
            .run(id, hashInvite(code), code.slice(0, 4), at, at + INVITE_TTL_MS);
        return { id, hint: code.slice(0, 4), code: formatInviteCode(code), createdAt: at, expiresAt: at + INVITE_TTL_MS };
    }

    function createInvite() {
        const invite = insertInvite(now());
        return { success: true, invite };
    }

    /**
     * 批量生成。上限 `INVITE_BATCH_MAX`（20）**在这里判**——路由层不判，界面层更
     * 不是判据（界面上限只挡手滑，挡不住 curl）。
     *
     * 整批在**一个事务**里：中途任何一条失败（唯一约束撞了、库写不进去）都整批
     * 回滚，绝不会出现「界面说生成 20 张、其实只落库 7 张」——那种半批是最难解释
     * 的一类 bug：用户按着界面上那 7 张的码去找，剩下的 13 张永远不存在。
     *
     * 一批里的码互不相同：`randomBytes(12)` 撞车的概率可以忽略，但「忽略」不是
     * 「不可能」，而撞了会让整批回滚。这里在批内去重后重取，代价是几次比较。
     */
    function createInvites(count) {
        // 类型也要卡：`Number.isInteger('20')` 是 false，所以 `"20"` 会被拒。宁可 400，
        // 也不要在「字符串能过」以后再猜它到底想生成几张。
        if (!Number.isInteger(count) || count < 1 || count > INVITE_BATCH_MAX) {
            fail(`一次可生成的邀请码为 1–${INVITE_BATCH_MAX} 张`);
        }
        const total = count;
        const at = now();
        return db.transaction(() => {
            const seen = new Set();
            const invites = [];
            while (invites.length < total) {
                let invite = insertInvite(at);
                while (seen.has(invite.code)) invite = insertInvite(at);
                seen.add(invite.code);
                // 响应里**不带 id**：这一批的语义是「把码抄走」，之后的治理在列表里做
                // （列表带 id）。多带一个 id 只会多一份「界面拿它去撤销」的诱惑，
                // 而撤销的判据是库里的状态，不是响应里这一份快照。
                invites.push({ code: invite.code, hint: invite.hint, createdAt: invite.createdAt, expiresAt: invite.expiresAt });
            }
            return { success: true, invites };
        })();
    }

    /**
     * 邀请码列表：状态筛选 + 分页 + 四个状态的计数。
     *
     * 只回 `hint`（前 4 位）与状态/时间，**不回完整码**——库里本来也只有哈希，
     * 想回也回不了；这条约束在这里是「形状上就没有那个字段」。
     */
    function listInvites(options = {}) {
        const at = now();
        const state = pick(INVITE_STATE_FILTERS, options.state, 'all');
        const { where, args } = INVITE_STATE_FILTERS[state](at);
        const limit = pageLimit(options.limit);
        const offset = pageOffset(options.offset);
        const total = db.prepare(`SELECT COUNT(*) AS n FROM sync_invites WHERE 1 = 1 ${where}`).get(...args).n;
        const rows = db.prepare(`SELECT * FROM sync_invites WHERE 1 = 1 ${where} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`)
            .all(...args, limit, offset);
        // 计数走**同一张白名单表**而不是另写一份 SQL：两份判据一定会漂移，而漂移的
        // 症状是「筛选出 3 张，角标却写着 4 张」——用户会以为列表漏了一条。
        const counts = {};
        for (const key of INVITE_STATES) {
            const filter = INVITE_STATE_FILTERS[key](at);
            counts[key] = db.prepare(`SELECT COUNT(*) AS n FROM sync_invites WHERE 1 = 1 ${filter.where}`).get(...filter.args).n;
        }
        return {
            success: true,
            invites: rows.map((row) => ({
                id: row.id,
                hint: row.hint,
                state: inviteState(row, at),
                createdAt: row.created_at,
                expiresAt: row.expires_at,
                usedAt: row.used_at,
                used: !!row.used_at,
                revoked: !!row.revoked,
                expired: row.expires_at <= at
            })),
            page: { total, offset, limit },
            counts
        };
    }

    /** 行 → 状态字符串。优先级与 `INVITE_STATE_FILTERS` 的分片逐条对齐（见那里的注释）。 */
    function inviteState(row, at) {
        if (row.used_at) return 'used';
        if (row.revoked) return 'revoked';
        if (row.expires_at <= at) return 'expired';
        return 'unused';
    }

    function revokeInvite(id) {
        const target = text(id, 100);
        if (!target) fail('邀请码标识无效');
        const info = db.prepare('UPDATE sync_invites SET revoked = 1 WHERE id = ?').run(target);
        if (!info.changes) fail('邀请码不存在', 404, 'invite_missing');
        return { success: true };
    }

    /**
     * 批量撤销。与 `revokeInvite()` 的语义**只差一个 IN 列表**，但那一条的
     * `WHERE id = ?` 会连已使用的码一起标掉——批量撤销必须只动「还没用、也没过期」
     * 的那些，判据写进 WHERE 而不是「先读一遍挑出来再写」：先查后写在两个管理员
     * 同时点的时候会漏判（那边刚被用户用掉，这边照样标成已撤销）。
     *
     * 返回的 `revoked` 是**实际改动行数**（`changes`），不是请求里给了几个 id：
     * 界面按这个数说话（「已撤销 3 张」），给大了就是在编。
     */
    function revokeInvites(ids) {
        if (!Array.isArray(ids) || ids.length === 0) fail('请先选择要撤销的邀请码');
        if (ids.length > INVITE_REVOKE_MAX) fail(`一次最多撤销 ${INVITE_REVOKE_MAX} 张邀请码`);
        const targets = [...new Set(ids.map((id) => {
            const value = text(id, 100);
            if (!value) fail('邀请码标识无效');
            return value;
        }))];
        const at = now();
        const placeholders = targets.map(() => '?').join(', ');
        const info = db.prepare(`UPDATE sync_invites SET revoked = 1
                                  WHERE id IN (${placeholders}) AND used_at IS NULL AND revoked = 0 AND expires_at > ?`)
            .run(...targets, at);
        return { success: true, revoked: info.changes };
    }

    /** 消耗一张邀请码：`used_at IS NULL` 是这条 UPDATE 的承重条件，见文件头。 */
    function consumeInvite(code, spaceId, at) {
        const invite = db.prepare('SELECT * FROM sync_invites WHERE code_hash = ?').get(hashInvite(code));
        if (!invite) fail('邀请码无效', 403, 'invite_invalid');
        if (invite.revoked) fail('邀请码已被撤销', 403, 'invite_revoked');
        if (invite.used_at) fail('邀请码已被使用', 403, 'invite_used');
        if (invite.expires_at <= at) fail('邀请码已过期', 403, 'invite_expired');
        const consumed = db.prepare('UPDATE sync_invites SET used_at = ?, used_space = ? WHERE id = ? AND used_at IS NULL')
            .run(at, spaceId, invite.id);
        if (consumed.changes !== 1) fail('邀请码已被使用', 403, 'invite_used');
        return invite.id;
    }

    // ---- 空间 -------------------------------------------------------------

    function checkSpace(input) {
        const id = proofId(requireProof(input && input.proof));
        const space = db.prepare('SELECT * FROM sync_spaces WHERE proof_id = ?').get(id);
        if (!space) return { exists: false };
        return {
            exists: true,
            revision: space.revision,
            updatedAt: space.updated_at,
            entryCount: entryCount(JSON.parse(space.config_json))
        };
    }

    /**
     * 创建空间。
     *
     * 这一条上叠了**三种**拒绝，顺序是刻意的（都在同一个事务里，所以「先查后写」
     * 那类竞争在这里不存在）：
     *   ① 总暂停（503 `sync_paused`）—— 管理员开的总闸，挡整个数据面；
     *   ② 幂等回执重放 —— 响应丢了但事务已提交时，重试必须拿回同一份材料，
     *      **而且不能因为「这次赶上额度满了」就拒绝**：那会违背幂等（同一个请求
     *      时成时败），也会让用户以为自己的空间没建起来。所以重放排在额度之前；
     *   ③ 额度（503 `space_limit` / `storage_limit`）—— **不消耗邀请码**。
     *      这一条最容易写错：把 `consumeInvite` 放在额度检查之前，被拒的创建会
     *      烧掉用户唯一一张邀请码。
     */
    function createSpace(input) {
        const source = input && typeof input === 'object' ? input : {};
        const id = proofId(requireProof(source.proof));
        const operationId = requireOperationId(source.operationId);
        const code = normalizeInviteCode(source.inviteCode);
        // 校验放在事务外：纯函数、不读库，放进去只会拉长写锁的持有时间。
        const config = validateSyncConfig(source.config);
        const modules = normalizeSyncModules(source.modules, publicIds());
        const configJson = JSON.stringify(config);
        const modulesJson = JSON.stringify(modules);
        const bytes = contentBytes(configJson, modulesJson);
        const digest = sha256(JSON.stringify({ scope: 'create', inviteCode: code, operationId, config, modules }));
        const at = now();
        return db.transaction(() => {
            pruneReceipts(at);
            // ① 总暂停：**排在回执之前**。暂停期间的创建一律拒绝，包括重试——
            // 总暂停是「现在谁都别写」的语义，不是「新内容别写」。
            requireNotPaused(at);
            // 暂停新建：只挡创建（已有空间照常），所以排在总暂停之后、回执之前。
            requireNotCreatingPaused(at);
            const receipt = readReceipt('create', operationId, digest);
            if (receipt) return replayIssuance(receipt, digest, at);
            // ② 额度（在消耗邀请码之前）。`requireInstanceQuota` 在同一事务里
            // 读当前总量，所以并发创建的第二路会看到第一路已经占用的额度。
            requireContentQuota(bytes);
            requireInstanceQuota(bytes);
            // 同一个口令以前删过空间？沿用它的代次往上走一格——设计要求「同口令
            // 重建使用新代次和新令牌」。墓碑是唯一还记得旧代次的地方（`proof_id`
            // 已被置 NULL 释放，所以这里查的是 `deleted_proof_id`）。
            // 同一个口令可能留下多个墓碑（建→删→再建→再删），取代次最高的那个 +1。
            const grave = db.prepare('SELECT generation FROM sync_spaces WHERE deleted = 1 AND deleted_proof_id = ? ORDER BY generation DESC LIMIT 1').get(id);
            const generation = grave ? grave.generation + 1 : 1;
            const spaceId = randomBytes(12).toString('hex');
            try {
                db.prepare('INSERT INTO sync_spaces (id, proof_id, generation, revision, config_json, modules_json, content_bytes, created_at, updated_at, disabled, deleted) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0, 0)')
                    .run(spaceId, id, generation, configJson, modulesJson, bytes, at, at);
            } catch (error) {
                // 唯一约束拦住并发创建：口令已经对应一个空间，不能抢写。
                if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) fail('该口令已存在空间，请改用连接', 409, 'space_exists');
                throw error;
            }
            consumeInvite(code, spaceId, at);
            const space = { id: spaceId, generation, revision: 1, updated_at: at };
            const deviceToken = issueDevice(space, at);
            const payload = { spaceId, generation, revision: 1, deviceToken };
            writeReceipt('create', operationId, digest, payload, at);
            return { success: true, ...payload, updatedAt: at, entryCount: entryCount(config) };
        })();
    }

    /**
     * 停止同步时尽力撤销**本设备**的令牌。
     *
     * 调用方（浏览器）已经先完成了本地断开，所以这里一律返回成功：形状不对、
     * 令牌不存在、空间已删——对调用方来说结果都一样（「这个令牌别再能用」），
     * 让它去区分只会把「离线撤销失败」变成用户可见的错误，而设计要求那种失败
     * 不妨碍本地断开。
     *
     * **不受总暂停影响**：总暂停挡的是数据面（读写/连接/创建），而「撤销本设备」
     * 是「我要离开」这个动作的一部分。挡住它等于把用户锁在一个他不想再用的
     * 连接里——那是总暂停最容易写错的一处。
     */
    function revokeDevice(token) {
        if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return { success: true };
        db.prepare('UPDATE sync_devices SET revoked = 1, revoked_at = ? WHERE token_hash = ?').run(now(), hashToken(token));
        return { success: true };
    }

    /**
     * 墓碑化一个空间：**管理员删除与用户删除共用这一份实现**。
     *
     * 两处各写一遍必然漂移，而漂移的那一半会漏掉「吊销全部设备」或「清回执」，
     * 症状是「管理员删掉了，但旧设备还能读」这种最难解释的一种。
     * 调用方负责鉴权与事务边界（这里假定已经在事务里）。
     */
    function tombstoneSpace(space, at) {
        db.prepare('UPDATE sync_spaces SET deleted = 1, deleted_at = ?, proof_id = ?, deleted_proof_id = ?, config_json = ?, modules_json = ?, content_bytes = 0, updated_at = ? WHERE id = ?')
            .run(at, DELETED_PROOF_PREFIX + space.id, space.proof_id, '{}', '{}', at, space.id);
        const revoked = db.prepare('UPDATE sync_devices SET revoked = 1, revoked_at = ? WHERE space_id = ? AND revoked = 0').run(at, space.id).changes;
        const receipts = db.prepare('DELETE FROM sync_receipts WHERE scope = ? OR scope = ?')
            .run(`config:${space.id}`, `connect:${space.id}`).changes;
        return { revoked, receipts };
    }

    /**
     * 删除云端空间（**墓碑**，见 lib/db.js 的迁移 v10）。
     *
     * 鉴权是**双要素**：Bearer 设备令牌把空间钉住，body 里的口令证明再验证一次
     * （设计要求的「重新输入口令」）。只凭口令分不清「口令打错了」和「空间早被
     * 删了」——两者都定位不到活动空间，而这两种情况的下一步完全不同。
     *
     * 一个事务里做完四件事：标记删除并清空内容、释放口令槽、吊销该空间全部设备、
     * 删掉空间作用域的回执。删除与上传都在这一个库上单事务执行，谁先到谁生效，
     * 删除先完成时旧上传会因为空间已删而拿不到凭据。
     *
     * **不受总暂停影响**：总暂停挡数据面，删除是清理动作。挡住它的话管理员一开
     * 总暂停，用户连自己的数据都删不掉了——那是「被锁在里面」。
     */
    function deleteSpace(token, input) {
        const source = input && typeof input === 'object' ? input : {};
        const proofHash = proofId(requireProof(source.proof));
        const at = now();
        return db.transaction(() => {
            // deviceForToken 已经会把「空间已删」「设备已吊销」「令牌无效」分开抛，
            // 所以重试删除时这里拿到的是 410 space_deleted，而不是含糊的 401。
            const { space } = deviceForToken(token, at);
            if (space.proof_id !== proofHash) fail('口令不正确，未删除任何内容', 403, 'proof_mismatch');
            return { success: true, ...tombstoneSpace(space, at) };
        })();
    }

    function connectSpace(input) {
        const source = input && typeof input === 'object' ? input : {};
        const id = proofId(requireProof(source.proof));
        const operationId = requireOperationId(source.operationId);
        const digest = sha256(JSON.stringify({ scope: 'connect', operationId }));
        const at = now();
        return db.transaction(() => {
            pruneReceipts(at);
            requireNotPaused(at);
            const space = db.prepare('SELECT * FROM sync_spaces WHERE proof_id = ?').get(id);
            if (!space) fail('该口令尚未创建空间', 404, 'space_not_found');
            if (space.disabled) fail('该空间已停用', 403, 'space_disabled');
            // 回执按空间分开存：两台不同空间的客户端偶然用了同一个 operationId
            // 时，不能互相看到对方的签发材料。
            const scope = `connect:${space.id}`;
            const receipt = readReceipt(scope, operationId, digest);
            if (receipt) return replayIssuance(receipt, digest, at);
            const deviceToken = issueDevice(space, at);
            const payload = { spaceId: space.id, generation: space.generation, revision: space.revision, deviceToken };
            writeReceipt(scope, operationId, digest, payload, at);
            return {
                success: true,
                ...payload,
                updatedAt: space.updated_at,
                entryCount: entryCount(JSON.parse(space.config_json))
            };
        })();
    }

    /**
     * 「撤销全部旧设备并重新连接」（设计文档 §5）。
     *
     * 顺序**是**这个方法本身（每一步换个位置都有可观察后果，见下），一个事务：
     *
     *   ① 查空间（口令证明定位）→ 不存在 404、已停用 403；
     *   ② 总暂停检查（这是数据面的一步：用户想连回来）；
     *   ③ 回执重放：`scope = 'reset:' + 空间 id`，同 ID 只撤一次。**这一步排在
     *      代次 +1 之前**——重试时必须拿回同一份材料，而不是又撤一遍刚签发的令牌；
     *   ④ `generation + 1`。**不动** revision、不动内容、不动时间戳：设计要求
     *      「不能把重新连接当作恢复或覆盖配置」；
     *   ⑤ 清掉 `connect:` / `reset:` 两个作用域的回执：旧代次的材料已经解不开了，
     *      留着只会让重试拿到一份 `receipt_stale`；
     *   ⑥ **先吊销全部旧设备、后签发新设备**。顺序反了的话，新令牌插入之后那一次
     *      全量吊销会把**刚签发的那枚**也一起吊销——症状是「重新连接成功，但立刻
     *      就被判为设备已撤销」；
     *   ⑦ 写回执。
     *
     * 不变量（各有用例钉着）：revision 不变、内容逐字节不变、不消耗邀请码。
     *
     * ⚠️ 稳定请求 ID 由**调用方**生成、只活在内存里（客户端的 `crypto.randomUUID()`）。
     * 刷新页面重来会再撤一次：代价是多一枚孤儿令牌，它在 90 天无鉴权后被 `sweep()`
     * 删掉。接受这个代价，是因为把 ID 落进 IndexedDB 会引入「这条 ID 属于哪一次
     * 重置」的状态，而那个状态与现有的连接代次是同一件事的两份表述——必然漂移。
     */
    function resetDevices(input) {
        const source = input && typeof input === 'object' ? input : {};
        const proofHash = proofId(requireProof(source.proof));
        const operationId = requireOperationId(source.operationId);
        const digest = sha256(JSON.stringify({ scope: 'reset', operationId }));
        const at = now();
        return db.transaction(() => {
            pruneReceipts(at);
            requireNotPaused(at);
            const space = db.prepare('SELECT * FROM sync_spaces WHERE proof_id = ?').get(proofHash);
            if (!space) fail('该口令尚未创建空间', 404, 'space_not_found');
            if (space.disabled) fail('该空间已停用', 403, 'space_disabled');
            const scope = `reset:${space.id}`;
            const receipt = readReceipt(scope, operationId, digest);
            // 重放走 replayIssuance 的三道门：材料解得开、代次仍是当前代次、设备行还在。
            if (receipt) return replayIssuance(receipt, digest, at);
            const nextGeneration = space.generation + 1;
            db.prepare('UPDATE sync_spaces SET generation = ? WHERE id = ?').run(nextGeneration, space.id);
            // 旧代次的两个作用域回执一起清：`connect:` 的那份令牌已经作废，
            // `reset:` 的那份也不该在「又一次重置」之后还在（它是上一次的答案）。
            db.prepare('DELETE FROM sync_receipts WHERE scope = ? OR scope = ?').run(`connect:${space.id}`, scope);
            // ⚠️ 顺序：先吊销、后签发（反了会把新令牌当场吊销）。
            const revoked = db.prepare('UPDATE sync_devices SET revoked = 1, revoked_at = ? WHERE space_id = ? AND revoked = 0').run(at, space.id).changes;
            const deviceToken = issueDevice({ id: space.id, generation: nextGeneration }, at);
            const payload = { spaceId: space.id, generation: nextGeneration, revision: space.revision, deviceToken, revoked };
            writeReceipt(scope, operationId, digest, payload, at);
            return {
                success: true,
                ...payload,
                updatedAt: space.updated_at,
                entryCount: entryCount(JSON.parse(space.config_json))
            };
        })();
    }

    /**
     * 只做鉴权与滑动续期，不读配置。
     *
     * 存在的原因只有一个：**每空间的限流要拿到 spaceId 才能计数**，而 spaceId
     * 只能由令牌查出来。所以路由先用它换到空间身份、再按空间计数，最后才做
     * 真正的读写——后者会再查一次主键。多出来的那次查询是微秒级的，换来的是
     * 「一个空间被很多台设备连」时额度按空间而不是按设备算。
     */
    function authenticate(token) {
        const at = now();
        return db.transaction(() => {
            const { space } = deviceForToken(token, at);
            return { spaceId: space.id, generation: space.generation, revision: space.revision, updatedAt: space.updated_at };
        })();
    }

    function readConfig(token) {
        const at = now();
        return db.transaction(() => {
            // 总暂停挡数据面的**读**：设计要求「客户端暂停自动同步」。读放行的话
            // 客户端会照常拉到配置、照常显示「已同步」，只有写被拒——用户看到的
            // 是一条自相矛盾的状态行，而且看不出是管理员暂停的。
            const { space } = deviceForToken(token, at);
            requireNotPaused(at);
            return {
                config: JSON.parse(space.config_json),
                modules: JSON.parse(space.modules_json),
                revision: space.revision,
                generation: space.generation,
                updatedAt: space.updated_at
            };
        })();
    }

    function writeConfig(token, input) {
        const source = input && typeof input === 'object' ? input : {};
        const operationId = requireOperationId(source.operationId);
        if (!Number.isSafeInteger(source.revision)) fail('页面版本不兼容，请刷新后重试', 409, 'revision_required');
        const revision = source.revision;
        const config = validateSyncConfig(source.config);
        const modules = normalizeSyncModules(source.modules, publicIds());
        const configJson = JSON.stringify(config);
        const modulesJson = JSON.stringify(modules);
        const bytes = contentBytes(configJson, modulesJson);
        // ⚠️ `generation` **不进摘要**：它是传输元数据（这条写属于哪一代设备授权），
        // 不是内容。同一个 operationId 的重试换了一代人，那是「重新连接」而不是
        // 「同 ID 换了内容」，不该报 operation_conflict。
        const digest = sha256(JSON.stringify({ scope: 'config', operationId, revision, config, modules }));
        const at = now();
        return db.transaction(() => {
            // 先鉴权再碰回执：没凭据的请求连「这个 operationId 存不存在」都不该知道。
            const { space } = deviceForToken(token, at);
            // 代次校验（验收 3 要求的「事务内同时校验 revision 与空间代次」）。
            // 设备令牌在鉴权时已经比过代次，这里是同一事务里的第二次确认——
            // 严格说冗余，但它让协议把这条约束**写出来**，客户端也能拿到一个
            // 明确的原因码而不是笼统的 401。只在**带上了**这个字段时才检查：
            // 已经在跑的旧客户端不带，仍然照旧（它们的令牌鉴权已经覆盖）。
            if (source.generation !== undefined && source.generation !== space.generation) {
                fail('设备授权已变化，请重新输入口令', 409, 'generation_mismatch');
            }
            requireNotPaused(at);
            pruneReceipts(at);
            const scope = `config:${space.id}`;
            const receipt = readReceipt(scope, operationId, digest);
            if (receipt) {
                // ⚠️ 回执返回的是**那次提交**的结果（原 revision、原写入时刻），
                // 不是现在的状态。设计文档也是这么要求的：「客户端收到原成功结果后
                // 仍检查最新云端版本，不把旧回执当作当前完整配置覆盖本地」。
                // 所以调用方拿到 `success` 之后必须再读一次，别把这里的数当现状。
                const payload = receiptPayload(receipt);
                if (!payload) fail('上一次提交的结果已过期，请重新读取云端版本', 409, 'receipt_expired');
                return payload;
            }
            if (space.revision !== revision) fail('配置已改变，请刷新后处理冲突', 409, 'revision_conflict');
            // 额度只拦**增长**：`bytes <= space.content_bytes` 时无条件放行。
            // 没有这条，一个已经超限的空间（比如管理员事后把限额调小，或者历史上
            // 限额更大）就再也删不掉自己的内容——用户被自己的数据锁在门外。
            // 缩减之后 `content_bytes` 也跟着缩，于是下一次写入又受正常额度约束。
            if (bytes > space.content_bytes) requireContentQuota(bytes);
            const next = space.revision + 1;
            db.prepare('UPDATE sync_spaces SET config_json = ?, modules_json = ?, content_bytes = ?, revision = ?, updated_at = ? WHERE id = ?')
                .run(configJson, modulesJson, bytes, next, at, space.id);
            // 响应带上 generation 与 updatedAt：客户端要落进连接记录与状态行，
            // 省掉一次「写完还要再问一遍」的往返。
            const result = { success: true, revision: next, generation: space.generation, updatedAt: at };
            writeReceipt(scope, operationId, digest, result, at);
            return result;
        })();
    }

    // ---- 管理员治理（Issue #10）-------------------------------------------
    //
    // 这三条都**只回非敏感项**：标识、状态、体积、版本、代次、活跃设备数、时间。
    // 正文（config/modules）、口令哈希、`deleted_proof_id`、令牌与其哈希、回执
    // 一律不出现——管理员能看到「这个空间多大、什么时候动的」，但拿不到它的内容，
    // 也无法凭列表里的任何字段冒充某台设备（设计文档 §7 明令）。
    //
    // 列表（`listSpaces` / `instanceUsage`）与两个总开关都在上面「额度」那一节旁
    // ——它们与「全实例用量」共用同一份 SQL，搬远了必然有人再写一份。

    /**
     * 管理员启用/停用某个空间。**幂等**：重复停用不改时间戳（历史轮次只关心
     * 状态位，反复刷新让它跳动没有意义）。
     */
    function setSpaceDisabled(id, disabled) {
        const target = text(id, 100);
        if (!target) fail('空间标识无效');
        const at = now();
        return db.transaction(() => {
            const space = db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(target);
            if (!space) fail('空间不存在', 404, 'space_missing');
            if (space.deleted) fail('空间已被删除', 410, 'space_deleted');
            const next = disabled ? 1 : 0;
            const changed = space.disabled !== next;
            const info = db.prepare('UPDATE sync_spaces SET disabled = ?, disabled_at = ? WHERE id = ?')
                .run(next, changed ? (disabled ? at : null) : space.disabled_at, target);
            if (!info.changes) fail('空间不存在', 404, 'space_missing');
            return { success: true, id: target, disabled: !!next, changed };
        })();
    }

    /**
     * 管理员删除空间：**与用户删除共用 `tombstoneSpace()`**。
     *
     * 管理员没有口令，所以鉴权交给路由（`requireAdmin`），这里只认空间 id。
     * 「服务端核销」这一半与用户那条路径逐字一致——两套实现里漏掉任一步
     * （吊销设备 / 清回执）都会造成「管理员删掉了，旧设备还能读」。
     */
    function deleteSpaceAsAdmin(id) {
        const target = text(id, 100);
        if (!target) fail('空间标识无效');
        const at = now();
        return db.transaction(() => {
            const space = db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(target);
            if (!space) fail('空间不存在', 404, 'space_missing');
            if (space.deleted) fail('空间已被删除', 410, 'space_deleted');
            return { success: true, id: target, ...tombstoneSpace(space, at) };
        })();
    }

    /**
     * 管理员总开关：`creatingPaused`（暂停新建）与 `syncPaused`（总暂停）。
     *
     * 写入 `sync_settings` 的**那一行**是 upsert：行由 v11 迁移建好，但迁移之后
     * 被手工删除过的库不该在这里 500。两个字段都可选（只传一个就只改那一个），
     * 所以判据是 `!== undefined` 而不是真值——传 `false` 是「明确打开同步」，
     * 漏掉这一条会出现「关不掉」这种最气人的 bug。
     */
    function updateSettings(input) {
        const source = input && typeof input === 'object' ? input : {};
        const at = now();
        const current = settings();
        const creatingPaused = source.creatingPaused !== undefined ? (source.creatingPaused ? 1 : 0) : current.creating_paused;
        const syncPaused = source.syncPaused !== undefined ? (source.syncPaused ? 1 : 0) : current.sync_paused;
        db.prepare(`INSERT INTO sync_settings (id, creating_paused, sync_paused, updated_at) VALUES (1, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET creating_paused = excluded.creating_paused,
                        sync_paused = excluded.sync_paused, updated_at = excluded.updated_at`)
            .run(creatingPaused, syncPaused, at);
        return { success: true, settings: readSettings() };
    }

    /** 当前的全局开关。返回**归一化后**的布尔，别把 0/1 漏到 JSON 外面去。 */
    function readSettings() {
        const row = settings();
        return { creatingPaused: !!row.creating_paused, syncPaused: !!row.sync_paused, updatedAt: row.updated_at || null };
    }

    /** 只清签发回执。改密后旧回执解不开，留着只会让重试拿到一份本该作废的材料。 */
    function clearReceipts() {
        return db.prepare('DELETE FROM sync_receipts').run().changes;
    }

    /**
     * 常规清理，由 server.js 的 60 秒定时器调用（**不是**「每日」——保留窗口是
     * 天数级的常量，但跑得比它勤得多，过期即删）。四件事，**顺序不能换**：
     *
     *   ① 过期回执；
     *   ② 已撤销设备行（保留 24 小时，靠 `revoked_at` 而不是 `last_seen_at`，
     *      见 lib/db.js 的 v11 注释）；
     *   ③ 过期设备（90 天没鉴权）；
     *   ④ **墓碑**：`deleted = 1 AND deleted_at < 90 天前 AND id NOT IN (SELECT
     *      space_id FROM sync_devices)`。
     *
     * ⚠️ ④ 必须排在 ②③ **之后**，而且带那个 `NOT IN` 子句。墓碑先没了而设备行
     * 还在的话，那个空间的设备会从 410 `space_deleted` 变成 401 `device_invalid`
     * ——客户端丢掉「空间已被删除」这个事实，会把它当成「令牌过期」要求重新输
     * 口令，而那个口令对应的空间其实已经被管理员/用户删掉了。`NOT IN` 保证
     * 「只要还有设备行指向它，墓碑就留着」，②③ 先跑则保证那些行本身会先到期。
     */
    function sweep() {
        const at = now();
        pruneReceipts(at);
        db.prepare('DELETE FROM sync_invites WHERE expires_at < ? OR (revoked = 1 AND created_at < ?)')
            .run(at - INVITE_RETENTION_MS, at - INVITE_RETENTION_MS);
        db.prepare('DELETE FROM sync_devices WHERE revoked = 1 AND revoked_at IS NOT NULL AND revoked_at < ?')
            .run(at - REVOKED_DEVICE_RETENTION_MS);
        db.prepare('DELETE FROM sync_devices WHERE last_seen_at < ?').run(at - DEVICE_IDLE_MS);
        db.prepare(`DELETE FROM sync_spaces
                    WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?
                      AND id NOT IN (SELECT space_id FROM sync_devices)`).run(at - TOMBSTONE_RETENTION_MS);
    }

    return {
        createInvite, createInvites, listInvites, revokeInvite, revokeInvites,
        checkSpace, createSpace, connectSpace, resetDevices,
        authenticate, readConfig, writeConfig, revokeDevice, deleteSpace, clearReceipts, sweep,
        listSpaces, setSpaceDisabled, deleteSpaceAsAdmin, updateSettings, readSettings,
        storageUsage, instanceUsage, limits
    };
}

module.exports = {
    createSyncStore,
    CONNECT_LABEL,
    STORE_LABEL,
    INVITE_TTL_MS,
    RECEIPT_TTL_MS,
    DEVICE_IDLE_MS,
    TOMBSTONE_RETENTION_MS,
    REVOKED_DEVICE_RETENTION_MS,
    SYNC_PAUSED_RETRY_MS,
    PAGE_LIMIT_DEFAULT,
    PAGE_LIMIT_MAX,
    INVITE_BATCH_MAX,
    INVITE_REVOKE_MAX,
    DIFFICULTY,
    normalizeSyncModules,
    normalizeInviteCode,
    formatInviteCode,
    validateSyncConfig,
    entryCount,
    contentBytes
};

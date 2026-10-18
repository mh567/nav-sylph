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

const MODULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODULE_LIMIT = 50;
const MODULE_SETTING_KEYS = 20;
const MODULE_SETTING_TEXT = 200;
const MODULES_MAX_BYTES = 128 * 1024;

const PROOF_PATTERN = /^[0-9a-f]{64}$/;
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
        if (!device || device.revoked) fail('设备凭据无效', 401, 'device_invalid');
        const space = db.prepare('SELECT * FROM sync_spaces WHERE id = ?').get(device.space_id);
        if (!space) fail('设备凭据无效', 401, 'device_invalid');
        // 代次不符 = 这个令牌在「撤销全部旧设备」之后没被重新签发过，立即失效，
        // 不回退到「空间还在所以放行」。
        if (device.generation !== space.generation) fail('设备凭据已失效，请重新输入口令', 401, 'device_invalid');
        if (at - device.last_seen_at > DEVICE_IDLE_MS) fail('设备凭据已过期，请重新输入口令', 401, 'device_expired');
        if (space.disabled) fail('该空间已停用', 403, 'space_disabled');
        db.prepare('UPDATE sync_devices SET last_seen_at = ? WHERE token_hash = ?').run(at, device.token_hash);
        return { device, space };
    }

    // ---- 邀请码 -----------------------------------------------------------

    function createInvite() {
        const at = now();
        const code = randomBytes(12).toString('hex');
        const id = randomBytes(8).toString('hex');
        db.prepare('INSERT INTO sync_invites (id, code_hash, hint, created_at, expires_at, used_at, used_space, revoked) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0)')
            .run(id, hashInvite(code), code.slice(0, 4), at, at + INVITE_TTL_MS);
        return { success: true, invite: { id, hint: code.slice(0, 4), code: formatInviteCode(code), createdAt: at, expiresAt: at + INVITE_TTL_MS } };
    }
    function listInvites() {
        const at = now();
        return {
            invites: db.prepare('SELECT * FROM sync_invites ORDER BY created_at DESC').all().map((row) => ({
                id: row.id,
                hint: row.hint,
                createdAt: row.created_at,
                expiresAt: row.expires_at,
                usedAt: row.used_at,
                used: !!row.used_at,
                revoked: !!row.revoked,
                expired: row.expires_at <= at
            }))
        };
    }
    function revokeInvite(id) {
        const target = text(id, 100);
        if (!target) fail('邀请码标识无效');
        const info = db.prepare('UPDATE sync_invites SET revoked = 1 WHERE id = ?').run(target);
        if (!info.changes) fail('邀请码不存在', 404, 'invite_missing');
        return { success: true };
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

    function createSpace(input) {
        const source = input && typeof input === 'object' ? input : {};
        const id = proofId(requireProof(source.proof));
        const operationId = requireOperationId(source.operationId);
        const code = normalizeInviteCode(source.inviteCode);
        // 校验放在事务外：纯函数、不读库，放进去只会拉长写锁的持有时间。
        const config = validateSyncConfig(source.config);
        const modules = normalizeSyncModules(source.modules, publicIds());
        const digest = sha256(JSON.stringify({ scope: 'create', inviteCode: code, operationId, config, modules }));
        const at = now();
        return db.transaction(() => {
            pruneReceipts(at);
            const receipt = readReceipt('create', operationId, digest);
            if (receipt) return replayIssuance(receipt, digest, at);
            const spaceId = randomBytes(12).toString('hex');
            try {
                db.prepare('INSERT INTO sync_spaces (id, proof_id, generation, revision, config_json, modules_json, created_at, updated_at, disabled) VALUES (?, ?, 1, 1, ?, ?, ?, ?, 0)')
                    .run(spaceId, id, JSON.stringify(config), JSON.stringify(modules), at, at);
            } catch (error) {
                // 唯一约束拦住并发创建：口令已经对应一个空间，不能抢写。
                if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) fail('该口令已存在空间，请改用连接', 409, 'space_exists');
                throw error;
            }
            consumeInvite(code, spaceId, at);
            const space = { id: spaceId, generation: 1, revision: 1, updated_at: at };
            const deviceToken = issueDevice(space, at);
            const payload = { spaceId, generation: 1, revision: 1, deviceToken };
            writeReceipt('create', operationId, digest, payload, at);
            return { success: true, ...payload, updatedAt: at, entryCount: entryCount(config) };
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
            const { space } = deviceForToken(token, at);
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
        const digest = sha256(JSON.stringify({ scope: 'config', operationId, revision, config, modules }));
        const at = now();
        return db.transaction(() => {
            // 先鉴权再碰回执：没凭据的请求连「这个 operationId 存不存在」都不该知道。
            const { space } = deviceForToken(token, at);
            pruneReceipts(at);
            const scope = `config:${space.id}`;
            const receipt = readReceipt(scope, operationId, digest);
            if (receipt) {
                const payload = receiptPayload(receipt);
                if (!payload) fail('上一次提交的结果已过期，请重新读取云端版本', 409, 'receipt_expired');
                return payload;
            }
            if (space.revision !== revision) fail('配置已改变，请刷新后处理冲突', 409, 'revision_conflict');
            const next = space.revision + 1;
            db.prepare('UPDATE sync_spaces SET config_json = ?, modules_json = ?, revision = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(config), JSON.stringify(modules), next, at, space.id);
            const result = { success: true, revision: next };
            writeReceipt(scope, operationId, digest, result, at);
            return result;
        })();
    }

    /** 只清签发回执。改密后旧回执解不开，留着只会让重试拿到一份本该作废的材料。 */
    function clearReceipts() {
        return db.prepare('DELETE FROM sync_receipts').run().changes;
    }

    /**
     * 常规清理，由 server.js 的 60 秒定时器调用（**不是**「每日」——保留窗口是
     * 天数级的常量，但跑得比它勤得多，过期即删）。三件事：过期回执、陈旧邀请码
     * 记录、长期没鉴权的设备。
     */
    function sweep() {
        const at = now();
        pruneReceipts(at);
        db.prepare('DELETE FROM sync_invites WHERE expires_at < ? OR (revoked = 1 AND created_at < ?)')
            .run(at - INVITE_RETENTION_MS, at - INVITE_RETENTION_MS);
        db.prepare('DELETE FROM sync_devices WHERE last_seen_at < ?').run(at - DEVICE_IDLE_MS);
    }

    return { createInvite, listInvites, revokeInvite, checkSpace, createSpace, connectSpace, authenticate, readConfig, writeConfig, clearReceipts, sweep };
}

module.exports = {
    createSyncStore,
    CONNECT_LABEL,
    STORE_LABEL,
    INVITE_TTL_MS,
    RECEIPT_TTL_MS,
    DEVICE_IDLE_MS,
    normalizeSyncModules,
    normalizeInviteCode,
    formatInviteCode,
    validateSyncConfig,
    entryCount
};

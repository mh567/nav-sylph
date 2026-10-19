/**
 * WebDAV Backup Module
 * Handles remote backup and restore operations via WebDAV
 *
 * ## 备份范围（#12 起）
 *
 * 只备份**私人数据**：收藏（含隐私标签）、备忘录正文与状态、主机监控与私人模块
 * 的开关/布局、Special Line 的来源与事件（含归档/收藏状态）。
 *
 * 管理员导航与搜索引擎、站点默认模板、普通口令空间/邀请码/设备令牌、密码与会话、
 * 监控缓存、公开模块项（`publicModules` 与公开模块的布局）、`socialAccounts`、
 * `symbols`、模块文件的 `_sync` 元数据，以及任何凭据（`servers[].token`、
 * `pushSecretHash`、`enrollTokenHash`、时间线凭据）都**不进备份**。
 * 清单见 `SKIPPED_DOMAINS`，manifest 的 `skipped[]` 由它生成——范围说明、
 * 清单与实现只有这一处真相源。
 *
 * ## 凭据为什么不进备份
 *
 * 所有密文（agent token、时间线来源凭据、WebDAV 密码）的密钥都从**管理员密码哈希**
 * 派生，而 bcrypt 带盐 ⇒ 同一密码在另一台机器上是另一个哈希 ⇒ 密文**解不开**。
 * 带过去只是把一个用不上的秘密多放一份在远端。恢复后这些项目显示为
 * 「等待部署 / 待授权」，由用户重新授权。
 */

const { createClient } = require('webdav');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// Encryption utilities for storing WebDAV password
//
// 加密实现已抽到 lib/credentials.js，与模块 agent token 共用：
// 同一套算法与参数，且改密码时能一起重新加密（见 reencryptCredentials）。
// 下面两个包装保留原有的抛错文案，避免改变既有行为。
const { encrypt: encryptRaw, decrypt: decryptRaw } = require('./credentials');

/**
 * Encrypt sensitive data (WebDAV password)
 */
function encrypt(text, passwordHash) {
    return encryptRaw(text, passwordHash, 'webdav');
}

/**
 * Decrypt sensitive data (WebDAV password)
 */
function decrypt(encrypted, passwordHash) {
    try {
        return decryptRaw(encrypted, passwordHash, 'webdav');
    } catch (err) {
        throw new Error('Failed to decrypt WebDAV password');
    }
}

/**
 * Calculate SHA-256 checksum
 */
function calculateChecksum(data) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(data))
        .digest('hex');
}

/** 文件内容（UTF-8 字节）的 sha256。manifest 用它钉住「清单说的内容」与「真的取了那份内容」。 */
function sha256Bytes(text) {
    return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Verify checksum
 */
function verifyChecksum(backup) {
    if (!backup.checksum || !backup.data) return false;
    const expected = calculateChecksum(backup.data);
    return backup.checksum === expected;
}

// 自动同步槽位的文件名。**不带时间戳**：它是「最新一份」，每次覆盖。
// 手动备份仍是带时间戳的那一套，由 cleanupOldBackups 按最新 N 组轮换；
// 两者分开，自动备份才不会把历史还原点挤掉。
const AUTO_BOOKMARKS_FILE = 'nav-sylph-bookmarks-auto.html';
const AUTO_MEMOS_FILE = 'nav-sylph-memos-auto.json';
const AUTO_MODULES_FILE = 'nav-sylph-modules-auto.json';
const AUTO_TIMELINE_FILE = 'nav-sylph-timeline-auto.json';
const AUTO_MANIFEST_FILE = 'nav-sylph-manifest-auto.json';

// 自动槽位文件名 → 它那一组校验和。**只有这一张表**：`deleteBackup` 靠它清掉
// 对应校验和（否则 noChanges 会短路，远端那份再也不会被重建），漏一项就是
// 一份再也长不回来的文件。
const AUTO_CHECKSUM_KEYS = {
    [AUTO_BOOKMARKS_FILE]: 'lastAutoFavoritesChecksum',
    [AUTO_MEMOS_FILE]: 'lastAutoMemosChecksum',
    [AUTO_MODULES_FILE]: 'lastAutoModulesChecksum',
    [AUTO_TIMELINE_FILE]: 'lastAutoTimelineChecksum',
    [AUTO_MANIFEST_FILE]: 'lastAutoScopeChecksum'
};

// 信封格式版本。旧读取只校验 type 与 checksum、不看 version，所以 1→2 不会
// 让旧版本的恢复流程坏掉；`checksum` 的语义（`sha256(JSON.stringify(data))`）不动。
const ENVELOPE_VERSION = 2;
// 备份范围本身的版本。它进 manifest 也进「有没有变化」判定：范围改了（这里
// 加一），下一次备份必须重建清单，而不是因为四个域的内容没变就整轮跳过。
const SCOPE_VERSION = 2;

// 进备份的域（manifest 的 included[] 按这个顺序写，范围说明也照这个顺序讲）。
const INCLUDED_DOMAINS = ['favorites', 'memos', 'modules', 'timeline'];

// 不进备份的域与原因。manifest 的 skipped[] 逐条从这里生成；`domain` 用点号路径
// 表示「某个域里的某个字段」，因为逐字段排除与整域排除是同一件事的两端。
const SKIPPED_DOMAINS = [
    { domain: 'admin-navigation', reason: '管理员导航、主题与搜索引擎是本机界面设置，不跨设备恢复' },
    { domain: 'default-template', reason: '站点默认模板（草稿与已发布）不在备份范围内' },
    { domain: 'sync-spaces', reason: '普通口令空间、邀请码与设备令牌属于同步服务的数据' },
    { domain: 'passwords-sessions', reason: '管理员密码哈希与登录会话永不进备份' },
    { domain: 'metrics-cache', reason: '监控采集缓存是派生数据，恢复后由采集器重建' },
    { domain: 'modules.publicModules', reason: '公开模块的开放名单是对访客的授权配置，属于本机' },
    { domain: 'modules.widgets#public', reason: '公开模块的布局项由本机保留，备份只带私人模块项' },
    { domain: 'modules.socialAccounts', reason: '社交账号名属于界面资料，不进跨设备备份' },
    { domain: 'modules.symbols', reason: '自定义符号列表不进跨设备备份' },
    { domain: 'modules._sync', reason: '模块文件的修订号与幂等回执是本机并发控制元数据' },
    { domain: 'modules.servers[].token', reason: 'agent 令牌密文由本机管理密码派生，跨安装解不开，恢复后需重新授权' },
    { domain: 'modules.servers[].pushSecretHash', reason: '推送凭据哈希是凭据，永不进备份' },
    { domain: 'modules.servers[].enrollTokenHash', reason: '注册令牌及其过期时间/来源 IP 是凭据，永不进备份' },
    { domain: 'timeline.credentials', reason: '时间线来源凭据的密文由本机管理密码派生，跨安装解不开' }
];

/** 某条 skip 的原因（按 domain 取，取不到就给一句通用的）。 */
function skipReason(domain) {
    const hit = SKIPPED_DOMAINS.find(item => item.domain === domain);
    return hit ? hit.reason : '不在备份范围内';
}

// ========== 投影（白名单 pick）==========
//
// ⚠️ 一律**白名单**构造，不用 `delete`：将来给 .modules.json 加一个凭据字段时，
// 「删掉已知的敏感字段」的写法会让新字段默认漏出去，白名单则默认不进。
//
// ⚠️ 一律**固定键顺序**：`calculateChecksum` 是 `sha256(JSON.stringify(data))`，
// 键顺序敏感。用条件键拼对象时若顺序随字段有无变化，同一份内容会算出两个校验和
// ⇒ `noChanges` 永远判不中 ⇒ 每轮自动同步都上传一次。

/** 模块条目里跨安装仍**有用**的字段。凭据不在这里，且这份名单就是唯一判据。 */
const SERVER_BACKUP_FIELDS = ['name', 'url', 'mode', 'reachable', 'certPem', 'certFingerprint', 'enrolledAt', 'deployState'];

/** 一台机器的投影。键顺序固定：id/name/url/mode/reachable 恒在，注册信息可选但顺序固定。 */
function projectServerForBackup(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (!id || !url) return null;
    const out = {
        id,
        name: typeof raw.name === 'string' ? raw.name : url,
        url,
        mode: raw.mode === 'push' ? 'push' : 'pull',
        reachable: raw.reachable !== false
    };
    if (typeof raw.certPem === 'string' && raw.certPem) out.certPem = raw.certPem;
    if (typeof raw.certFingerprint === 'string' && raw.certFingerprint) out.certFingerprint = raw.certFingerprint;
    if (Number.isFinite(raw.enrolledAt)) out.enrolledAt = raw.enrolledAt;
    if (typeof raw.deployState === 'string' && raw.deployState) out.deployState = raw.deployState;
    return out;
}

/** 布局项投影。公开模块项被调用方先筛掉（判据在 projectModulesForBackup）。 */
function projectWidgetForBackup(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) return null;
    const order = Number(raw.order);
    return {
        id,
        enabled: raw.enabled !== false,
        side: raw.side === 'right' ? 'right' : 'left',
        order: Number.isFinite(order) ? order : 0,
        collapsed: raw.collapsed === true
    };
}

/**
 * `.modules.json` 全文 → 备份里的私人投影。
 *
 * @param {object} modules 读出来的模块配置（可能带 `_sync` 与各类凭据字段）
 * @param {object} [options]
 * @param {Iterable<string>} [options.publicModuleIds] 分类为 public 的模块 id
 * @returns {object|null} 没有任何字段时返回 null（不为空模块在远端留垃圾）
 */
function projectModulesForBackup(modules, options = {}) {
    if (!modules || typeof modules !== 'object') return null;
    const publicIds = new Set(options.publicModuleIds || []);
    const isPrivate = id => typeof id === 'string' && id && !publicIds.has(id);

    // enabledModules：只留私人模块。公开模块「管理员自己启用了没有」是本机状态，
    // 恢复时也不能把访客侧的开放名单带过来。
    const enabledModules = [];
    for (const id of (Array.isArray(modules.enabledModules) ? modules.enabledModules : [])) {
        if (isPrivate(id) && !enabledModules.includes(id)) enabledModules.push(id);
    }
    const widgets = [];
    for (const raw of (Array.isArray(modules.widgets) ? modules.widgets : [])) {
        const widget = projectWidgetForBackup(raw);
        if (widget && isPrivate(widget.id)) widgets.push(widget);
    }
    const servers = [];
    for (const raw of (Array.isArray(modules.servers) ? modules.servers : [])) {
        const server = projectServerForBackup(raw);
        if (server) servers.push(server);
    }

    // 键顺序固定。pollInterval 是采集周期（监控配置的一部分），不是凭据。
    const out = {
        version: 1,
        enabledModules,
        widgets,
        servers,
        pollInterval: Number(modules.pollInterval) || 15
    };
    return out;
}

/** 备忘录投影。键顺序固定，且**只**取这六项（正文、状态与时间，没有别的）。 */
function projectMemosForBackup(memos) {
    const entries = [];
    for (const raw of (Array.isArray(memos) ? memos : [])) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) continue;
        entries.push({
            id: raw.id,
            title: typeof raw.title === 'string' ? raw.title : '',
            body: typeof raw.body === 'string' ? raw.body : '',
            pinned: raw.pinned === true,
            createdAt: Number(raw.createdAt) || 0,
            updatedAt: Number(raw.updatedAt) || 0
        });
    }
    return { memos: entries };
}

/** 收藏投影：只取备份用得到的形状（与 HTML 往返保住的字段一致）。 */
function projectFavoritesForBackup(favorites) {
    const items = [];
    for (const raw of (Array.isArray(favorites) ? favorites : [])) {
        if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string' || !raw.url) continue;
        items.push({
            title: typeof raw.title === 'string' ? raw.title : '',
            url: raw.url,
            category: typeof raw.category === 'string' ? raw.category : '未分类',
            private: raw.private === true
        });
    }
    return items;
}

// ========== 恢复侧合并 ==========
//
// 恢复**不能**整份覆盖 `.modules.json`：`publicModules` 是本机对访客的授权，
// `socialAccounts`/`symbols` 是本机界面资料，公开模块的布局项也在本机——
// 它们都不在备份里，整份覆盖等于用「备份里没有」把它们删掉。

/** 合并后的机器列表。本机的机器一律保留（含令牌），备份里同 id 只补布局。 */
function mergeServers(currentServers, backupServers) {
    const out = [];
    const byId = new Map();
    for (const server of (Array.isArray(currentServers) ? currentServers : [])) {
        if (!server || typeof server !== 'object' || !server.id) continue;
        byId.set(server.id, server);
        out.push(server);
    }
    const added = [];
    for (const server of (Array.isArray(backupServers) ? backupServers : [])) {
        if (!server || !server.id || !server.url) continue;
        const existing = byId.get(server.id);
        if (existing) {
            // 同一台机器：本机已有凭据与状态，备份只用来补齐布局字段。
            // deployState / certPem 不覆盖——那是本机探测出来的事实。
            for (const key of ['name', 'url', 'mode', 'reachable']) {
                if (server[key] !== undefined) existing[key] = server[key];
            }
            continue;
        }
        const restored = {
            id: server.id,
            name: typeof server.name === 'string' && server.name ? server.name : server.url,
            url: server.url,
            mode: server.mode === 'push' ? 'push' : 'pull',
            reachable: server.reachable !== false
        };
        if (typeof server.certPem === 'string' && server.certPem) restored.certPem = server.certPem;
        if (typeof server.certFingerprint === 'string' && server.certFingerprint) restored.certFingerprint = server.certFingerprint;
        if (Number.isFinite(server.enrolledAt)) restored.enrolledAt = server.enrolledAt;
        // 凭据不随备份：这台机器此刻采不到数据，状态必须落到既有词表里的
        // 「等待部署」(`deployState: 'pending'`)，而不是继续显示备份里那份「已就绪」。
        restored.deployState = server.deployState === 'not_deployed' ? 'not_deployed' : 'pending';
        byId.set(restored.id, restored);
        out.push(restored);
        added.push({ id: restored.id, name: restored.name, pending: 'authorize' });
    }
    return { servers: out, added };
}

/**
 * 按稳定模块 id 合并私人项，**保留当前公开模块项及其相对顺序**。
 *
 * @param {object} current 当前 `.modules.json`（`readJSON(MODULES_FILE)` 读出来的）
 * @param {object} backup  备份里的模块域（已经过白名单投影）
 * @param {object} [options]
 * @param {Iterable<string>} [options.publicModuleIds]
 * @returns {{modules: object, needsAuthorization: {id: string, name: string, reason: string}[]}}
 */
function mergePrivateModules(current, backup, options = {}) {
    const publicIds = new Set(options.publicModuleIds || []);
    const isPublic = id => publicIds.has(id);
    const base = current && typeof current === 'object' ? current : {};
    const incoming = backup && typeof backup === 'object' ? backup : {};

    const currentWidgets = (Array.isArray(base.widgets) ? base.widgets : []).filter(w => w && typeof w === 'object');
    const backupWidgets = (Array.isArray(incoming.widgets) ? incoming.widgets : [])
        .map(projectWidgetForBackup).filter(Boolean);

    // 公开项来自本机（备份里本来没有），相对顺序原样保留；私人项取备份。
    // `order` 重排成紧凑序号：备份里剩下的空洞会在侧栏留出空位。
    const widgets = [
        ...currentWidgets.filter(w => isPublic(w.id)),
        ...backupWidgets.filter(w => !isPublic(w.id))
    ].map((widget, index) => ({
        id: widget.id,
        enabled: widget.enabled !== false,
        side: widget.side === 'right' ? 'right' : 'left',
        order: index,
        collapsed: widget.collapsed === true
    }));

    const currentEnabled = Array.isArray(base.enabledModules) ? base.enabledModules : [];
    const backupEnabled = Array.isArray(incoming.enabledModules) ? incoming.enabledModules : [];
    const enabledModules = [];
    for (const id of [...currentEnabled.filter(isPublic), ...backupEnabled.filter(id => !isPublic(id))]) {
        if (typeof id !== 'string' || !id || enabledModules.includes(id)) continue;
        enabledModules.push(id);
    }

    const { servers, added } = mergeServers(base.servers, incoming.servers);

    // 键顺序固定：这份对象会被写回 .modules.json 并参与 revision 比较。
    const merged = {
        version: base.version || 1,
        enabledModules,
        widgets,
        servers,
        pollInterval: Number(Number.isFinite(incoming.pollInterval) ? incoming.pollInterval : base.pollInterval) || 15
    };
    // 其余顶层键（publicModules / socialAccounts / symbols / 将来的新字段）一律
    // 取**本机**的：它们不在备份范围里，整份覆盖等于把它们删掉。
    for (const key of Object.keys(base)) {
        if (!(key in merged)) merged[key] = base[key];
    }

    return {
        modules: merged,
        needsAuthorization: added.map(item => ({
            id: item.id,
            name: item.name,
            reason: '这台机器在本机没有凭据（agent 令牌密文由本机管理密码派生，不随备份）'
        }))
    };
}

class WebDAVBackup {
    constructor(configPath, passwordHash) {
        this.configPath = configPath;
        this.passwordHash = passwordHash;
        this.config = null;
        this.client = null;
    }

    /**
     * Load WebDAV configuration from file
     */
    async loadConfig() {
        try {
            const data = await fs.readFile(this.configPath, 'utf8');
            this.config = JSON.parse(data);
            return this.config;
        } catch (err) {
            // Return default config if file doesn't exist
            this.config = {
                enabled: false,
                url: '',
                username: '',
                password: null,
                remotePath: '/nav-sylph-backups/',
                lastBackupTime: null,
                // 自动同步缺省关闭：远端上传是有副作用的动作，不该因为
                // 升级到新版本就自己开始跑。
                autoSync: false
            };
            return this.config;
        }
    }

    /**
     * Save WebDAV configuration to file
     */
    async saveConfig(newConfig) {
        // Encrypt password if provided as plain text
        if (newConfig.password && typeof newConfig.password === 'string') {
            newConfig.password = encrypt(newConfig.password, this.passwordHash);
        }

        this.config = { ...this.config, ...newConfig };
        await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
        // 里面是加密后的 WebDAV 密码，与其它凭据文件同级收紧
        await fs.chmod(this.configPath, 0o600);
        return this.config;
    }

    /**
     * Get config for frontend (password masked)
     */
    getPublicConfig() {
        if (!this.config) return null;
        return {
            enabled: this.config.enabled,
            url: this.config.url,
            username: this.config.username,
            hasPassword: !!(this.config.password && this.config.password.data),
            remotePath: this.config.remotePath,
            lastBackupTime: this.config.lastBackupTime,
            // 开关本身 + 上一次自动备份的失败原因。失败必须能显示在界面上：
            // 「以为配置已经进云了」是静默失败里代价最大的一种。
            autoSync: !!this.config.autoSync,
            lastAutoSyncError: this.config.lastAutoSyncError || null,
            lastAutoSyncErrorAt: this.config.lastAutoSyncErrorAt || null
        };
    }

    /**
     * Create WebDAV client
     */
    createClient() {
        if (!this.config || !this.config.url) {
            throw new Error('WebDAV not configured');
        }

        let password = '';
        if (this.config.password && this.config.password.data) {
            password = decrypt(this.config.password, this.passwordHash);
        }

        this.client = createClient(this.config.url, {
            username: this.config.username,
            password: password
        });

        return this.client;
    }

    /**
     * Test WebDAV connection
     */
    async testConnection() {
        try {
            const client = this.createClient();

            // Try to get directory contents or create remote path
            const remotePath = this.config.remotePath || '/nav-sylph-backups/';

            try {
                await client.getDirectoryContents(remotePath);
            } catch (err) {
                // Directory might not exist, try to create it
                if (err.status === 404) {
                    await client.createDirectory(remotePath);
                } else {
                    throw err;
                }
            }

            return { success: true, message: 'Connection successful' };
        } catch (err) {
            return {
                success: false,
                message: err.message || 'Connection failed'
            };
        }
    }

    /**
     * Create backup and upload to WebDAV.
     *
     * 上传的是四个域（收藏 HTML、备忘录、私人模块、时间线）加一份版本化清单，
     * 见文件头的范围说明。**不生成 `nav-sylph-config-*.json`**：管理员导航、
     * 主题与搜索引擎从 #12 起不在备份范围内。
     *
     * @param {object} payload
     * @param {object[]} [payload.favorites]      favorites.json 的 favorites 数组
     * @param {object[]} [payload.memos]          memos 行（id/title/body/pinned/createdAt/updatedAt）
     * @param {object}   [payload.modules]        .modules.json 全文（这里按白名单投影）
     * @param {object}   [payload.timeline]       timeline.service.exportTimeline()（不含凭据）
     * @param {string}   [payload.appVersion]
     * @param {Iterable<string>} [payload.publicModuleIds] 分类为 public 的模块 id
     * @param {Function} [payload.renderBookmarks] favorites → Netscape HTML
     * @param {object} [options]
     * @param {boolean} [options.auto] 自动同步：写固定文件名（`-auto`，不带
     *   时间戳、每次覆盖），并只比对/更新 `lastAuto*Checksum` 那一组。
     *
     * **校验和为什么分两套。** 自动备份若更新了手动那一组，用户随后点
     * 「立即备份」会因为「数据没变」而返回 noChanges —— 一次显式请求被
     * 静默吞掉。两条路径各比各的、各更新各的。
     */
    async createBackup(payload = {}, options = {}) {
        const auto = options.auto === true;
        const favoritesKey = auto ? 'lastAutoFavoritesChecksum' : 'lastFavoritesChecksum';
        const memosKey = auto ? 'lastAutoMemosChecksum' : 'lastMemosChecksum';
        const modulesKey = auto ? 'lastAutoModulesChecksum' : 'lastModulesChecksum';
        const timelineKey = auto ? 'lastAutoTimelineChecksum' : 'lastTimelineChecksum';
        const scopeKey = auto ? 'lastAutoScopeChecksum' : 'lastScopeChecksum';

        const favorites = projectFavoritesForBackup(payload.favorites);
        const memos = projectMemosForBackup(payload.memos);
        const modules = projectModulesForBackup(payload.modules, {
            publicModuleIds: payload.publicModuleIds || []
        });
        const timeline = payload.timeline || null;
        const appVersion = payload.appVersion || '1.0.0';
        const renderBookmarks = payload.renderBookmarks;

        // Calculate checksums for current data
        // Include the HTML format revision so an existing backup is refreshed after
        // privacy metadata becomes part of the exported bookmarks.
        const favoritesChecksum = calculateChecksum({ formatVersion: 2, favorites });
        const memosChecksum = calculateChecksum(memos);
        // 模块配置同样参与「有无变化」判定：监控目标改了却判成 noChanges，
        // 就会留一份旧的模块配置在备份里，恢复后拿到的是过期布局。
        const modulesChecksum = modules ? calculateChecksum(modules) : null;
        // 时间线同理：没有它，新增一条事件不会让自动同步上传任何东西——
        // 而事件恰恰是这里最不可再生的数据。
        const timelineChecksum = timeline ? calculateChecksum(timeline) : null;
        // 第 5 组：范围指纹。范围改了（SCOPE_VERSION）而四个域的内容没变时，
        // 清单仍必须重建——否则远端会长期留着一份「旧范围的清单」，而界面
        // 上写着「已备份」。
        const scopeChecksum = calculateChecksum({
            scopeVersion: SCOPE_VERSION,
            included: INCLUDED_DOMAINS,
            skipped: SKIPPED_DOMAINS.map(item => item.domain)
        });

        // Check if data has changed since last backup
        if (this.config[favoritesKey] === favoritesChecksum &&
            this.config[memosKey] === memosChecksum &&
            this.config[modulesKey] === modulesChecksum &&
            this.config[timelineKey] === timelineChecksum &&
            this.config[scopeKey] === scopeChecksum) {
            return {
                success: true,
                noChanges: true,
                message: '收藏、备忘录、模块设置与时间线没有变化，无需备份'
            };
        }

        const client = this.createClient();
        const remotePath = this.config.remotePath || '/nav-sylph-backups/';

        // Ensure remote directory exists
        try {
            await client.getDirectoryContents(remotePath);
        } catch (err) {
            if (err.status === 404) {
                await client.createDirectory(remotePath);
            } else {
                throw err;
            }
        }

        // Generate filename with timestamp
        const now = new Date();
        const timestamp = now.toISOString()
            .replace(/[-:]/g, '')
            .replace('T', '-')
            .slice(0, 15);
        const createdAt = now.toISOString();

        // manifest 的 included[]：每个域一条，带**文件字节 sha256** 与计数。
        // 恢复时按它对回真实字节（清单说 A 内容、取回来的却是 B，就必须拒绝）。
        const included = [];
        const put = async (filename, text) => {
            const filePath = path.posix.join(remotePath, filename);
            await client.putFileContents(filePath, text, { contentLength: false });
            return sha256Bytes(text);
        };

        // 1. 收藏：浏览器兼容的 Netscape HTML（保留隐私标签），可直接导入 Chrome。
        let bookmarksFilename = null;
        // 收藏为空时**也要写**：远端那份 -auto 文件若留着上一次的内容，
        // 「全删了」这个状态就传不过去；恢复时会把删掉的书签又带回来。
        if (renderBookmarks && Array.isArray(payload.favorites)) {
            const bookmarksHtml = renderBookmarks(favorites);
            bookmarksFilename = auto ? AUTO_BOOKMARKS_FILE : `nav-sylph-bookmarks-${timestamp}.html`;
            included.push({
                domain: 'favorites',
                file: bookmarksFilename,
                sha256: await put(bookmarksFilename, bookmarksHtml),
                counts: { favorites: favorites.length, private: favorites.filter(f => f.private).length }
            });
        }

        // 2. 备忘录：正文与状态（含置顶与时间戳）。
        const memosFilename = auto ? AUTO_MEMOS_FILE : `nav-sylph-memos-${timestamp}.json`;
        const memosEnvelope = {
            version: ENVELOPE_VERSION,
            type: 'nav-sylph-memos',
            createdAt,
            appVersion,
            data: memos,
            checksum: memosChecksum
        };
        included.push({
            domain: 'memos',
            file: memosFilename,
            sha256: await put(memosFilename, JSON.stringify(memosEnvelope, null, 2)),
            counts: { memos: memos.memos.length, pinned: memos.memos.filter(m => m.pinned).length }
        });

        // 3. 私人模块：监控目标、布局、开关。凭据被投影挡在外面（见 projectModulesForBackup）。
        let modulesFilename = null;
        if (modules) {
            const modulesEnvelope = {
                version: ENVELOPE_VERSION,
                type: 'nav-sylph-modules',
                createdAt,
                appVersion,
                data: modules,
                checksum: modulesChecksum
            };
            modulesFilename = auto ? AUTO_MODULES_FILE : `nav-sylph-modules-${timestamp}.json`;
            included.push({
                domain: 'modules',
                file: modulesFilename,
                sha256: await put(modulesFilename, JSON.stringify(modulesEnvelope, null, 2)),
                counts: {
                    servers: modules.servers.length,
                    widgets: modules.widgets.length,
                    enabledModules: modules.enabledModules.length
                }
            });
        }

        // 4. 时间线：来源、事件、用户状态。**不含凭据**（见文件头说明）。
        // 没有内容时 timeline 为 null，这里就不生成文件——不为空模块在远端留垃圾。
        let timelineFilename = null;
        if (timeline) {
            const timelineEnvelope = {
                version: ENVELOPE_VERSION,
                type: 'nav-sylph-timeline',
                createdAt,
                appVersion,
                data: timeline,
                checksum: timelineChecksum
            };
            timelineFilename = auto ? AUTO_TIMELINE_FILE : `nav-sylph-timeline-${timestamp}.json`;
            included.push({
                domain: 'timeline',
                file: timelineFilename,
                sha256: await put(timelineFilename, JSON.stringify(timelineEnvelope, null, 2)),
                counts: {
                    sources: Array.isArray(timeline.sources) ? timeline.sources.length : 0,
                    events: Array.isArray(timeline.events) ? timeline.events.length : 0,
                    eventState: Array.isArray(timeline.eventState) ? timeline.eventState.length : 0
                }
            });
        }

        // 5. 清单：这一组备份到底装了什么、跳过了什么。**最后写**：先有文件才有
        // 校验和，清单里不得出现一份还没上传成功的文件。
        const manifestData = {
            scopeVersion: SCOPE_VERSION,
            included,
            skipped: SKIPPED_DOMAINS.map(item => ({ domain: item.domain, reason: item.reason }))
        };
        const manifestEnvelope = {
            version: ENVELOPE_VERSION,
            type: 'nav-sylph-manifest',
            createdAt,
            appVersion,
            data: manifestData,
            checksum: calculateChecksum(manifestData)
        };
        const manifestFilename = auto ? AUTO_MANIFEST_FILE : `nav-sylph-manifest-${timestamp}.json`;
        await put(manifestFilename, JSON.stringify(manifestEnvelope, null, 2));

        // Update last backup time and checksums
        this.config.lastBackupTime = createdAt;
        // lastBackupTime 两条路径都更新（它就是界面上的「上次备份」）；
        // 校验和只更新自己那一组。
        await this.saveConfig({
            lastBackupTime: this.config.lastBackupTime,
            [favoritesKey]: favoritesChecksum,
            [memosKey]: memosChecksum,
            [modulesKey]: modulesChecksum,
            [timelineKey]: timelineChecksum,
            [scopeKey]: scopeChecksum
        });

        return {
            success: true,
            bookmarksFilename,
            memosFilename,
            modulesFilename,
            timelineFilename,
            manifestFilename,
            included,
            skipped: manifestData.skipped,
            createdAt,
            timestamp: auto ? 'auto' : timestamp
        };
    }

    /**
     * List available backups from WebDAV
     * Groups files of one backup by timestamp
     */
    async listBackups() {
        const client = this.createClient();
        const remotePath = this.config.remotePath || '/nav-sylph-backups/';

        try {
            const contents = await client.getDirectoryContents(remotePath);

            // Group files by timestamp
            const backupGroups = {};

            for (const item of contents) {
                if (item.type !== 'file') continue;

                // Match new format: nav-sylph-{domain}-{ts}.{ext}
                // 旧版本生成的 nav-sylph-config-{ts}.json **仍然要能列出**：
                // 它是历史备份，用户要能看见、也要能（按新范围）只恢复书签。
                const configMatch = item.basename.match(/^nav-sylph-config-(\d{8}-\d{6})\.json$/);
                const bookmarksMatch = item.basename.match(/^nav-sylph-bookmarks-(\d{8}-\d{6})\.html$/);
                const memosMatch = item.basename.match(/^nav-sylph-memos-(\d{8}-\d{6})\.json$/);
                const modulesMatch = item.basename.match(/^nav-sylph-modules-(\d{8}-\d{6})\.json$/);
                const timelineMatch = item.basename.match(/^nav-sylph-timeline-(\d{8}-\d{6})\.json$/);
                const manifestMatch = item.basename.match(/^nav-sylph-manifest-(\d{8}-\d{6})\.json$/);
                // Also support legacy format: nav-sylph-backup-{timestamp}.json
                const legacyMatch = item.basename.match(/^nav-sylph-backup-(\d{8}-\d{6})\.json$/);
                // 自动同步槽位（固定文件名）。它不是历史还原点，是「最新一份」，
                // 所以单独 mark，由 cleanupOldBackups 排除在轮换之外。
                const autoSlots = {
                    // 旧版本遗留的自动配置文件：不再生成，但仍要能列出、能随组删除，
                    // 否则它会永远是一个既看不见也删不掉的孤儿文件。
                    'nav-sylph-config-auto.json': ['configFile', 'configSize'],
                    [AUTO_BOOKMARKS_FILE]: ['bookmarksFile', 'bookmarksSize'],
                    [AUTO_MEMOS_FILE]: ['memosFile', 'memosSize'],
                    [AUTO_MODULES_FILE]: ['modulesFile', 'modulesSize'],
                    [AUTO_TIMELINE_FILE]: ['timelineFile', 'timelineSize'],
                    [AUTO_MANIFEST_FILE]: ['manifestFile', 'manifestSize']
                }[item.basename];

                const stampInto = (ts, key, sizeKey) => {
                    if (!backupGroups[ts]) backupGroups[ts] = { timestamp: ts, lastmod: item.lastmod };
                    backupGroups[ts][key] = item.basename;
                    backupGroups[ts][sizeKey] = item.size;
                };

                if (configMatch) stampInto(configMatch[1], 'configFile', 'configSize');
                else if (bookmarksMatch) stampInto(bookmarksMatch[1], 'bookmarksFile', 'bookmarksSize');
                else if (memosMatch) stampInto(memosMatch[1], 'memosFile', 'memosSize');
                else if (modulesMatch) stampInto(modulesMatch[1], 'modulesFile', 'modulesSize');
                else if (timelineMatch) stampInto(timelineMatch[1], 'timelineFile', 'timelineSize');
                else if (manifestMatch) stampInto(manifestMatch[1], 'manifestFile', 'manifestSize');
                else if (legacyMatch) stampInto(legacyMatch[1], 'legacyFile', 'legacySize');
                else if (autoSlots) {
                    if (!backupGroups.auto) {
                        backupGroups.auto = { timestamp: 'auto', isAuto: true, lastmod: item.lastmod };
                    }
                    backupGroups.auto[autoSlots[0]] = item.basename;
                    backupGroups.auto[autoSlots[1]] = item.size;
                    // 固定文件名里没有时间，「这份有多新」只能看远端给的最后修改时间
                    if (item.lastmod) backupGroups.auto.lastmod = item.lastmod;
                }
            }

            // 文件名里的时间戳由 createBackup 用 toISOString() 生成，是 UTC。
            // 只把这段字符交给显示层，浏览器会当成本地时间渲染，
            // 于是列表比「上次备份」（走 toISOString 后还原成本地）早一个时区。
            // 这里还原成带 Z 的 ISO，时区转换统一交给浏览器。
            for (const group of Object.values(backupGroups)) {
                // 自动槽位的时间戳是哨兵值 'auto'，解析不出时刻——它的
                // createdAt 取自远端的 lastmod，跳过这段还原。
                if (group.isAuto) {
                    group.createdAt = group.lastmod || null;
                    continue;
                }
                group.createdAt = group.timestamp.replace(
                    /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/,
                    (_, y, mo, d, h, mi, s) => `${y}-${mo}-${d}T${h}:${mi}:${s}Z`
                );
            }

            // Convert to sorted array。自动槽位排最前（它是最新的），其余按
            // 时间戳倒序——显式判 isAuto，不依赖 `'auto'` 恰好大于数字的
            // 字典序巧合。
            const backups = Object.values(backupGroups)
                .sort((a, b) => (Number(!!b.isAuto) - Number(!!a.isAuto))
                    || b.timestamp.localeCompare(a.timestamp));

            return { success: true, backups };
        } catch (err) {
            if (err.status === 404) {
                return { success: true, backups: [] };
            }
            throw err;
        }
    }

    /**
     * Auto cleanup old backups, keep only the latest N
     */
    async cleanupOldBackups(keepCount = 5) {
        const { backups } = await this.listBackups();

        // 自动同步槽位不参与轮换：它是「最新一份」，不是历史还原点。
        // 把它算进 keepCount，它总会在某次清理里被当成最旧的一组删掉；
        // 而它又永远排在最前，所以不筛掉的话「最新的那份」反而最先消失。
        const manual = backups.filter(b => !b.isAuto);

        if (manual.length <= keepCount) {
            return { deleted: 0 };
        }

        const toDelete = manual.slice(keepCount);
        let deleted = 0;

        for (const backup of toDelete) {
            try {
                // 一组备份里的每个文件都必须一起删：清理是按分组算的，孤儿文件
                // 既不被计入也不会被清走，长期堆积在 WebDAV 上；而只删一半会
                // 留下「配置是旧的、清单是新的」这种半新半旧的分组。
                for (const key of ['configFile', 'bookmarksFile', 'memosFile', 'modulesFile', 'timelineFile', 'manifestFile', 'legacyFile']) {
                    if (!backup[key]) continue;
                    await this.deleteBackup(backup[key]);
                    deleted++;
                }
            } catch (err) {
                console.error('Failed to delete old backup:', err.message);
            }
        }

        return { deleted, backupsRemoved: toDelete.length };
    }

    /**
     * Restore from a specific backup.
     *
     * 只取回**新范围内的域**：书签、备忘录、模块配置、时间线。旧的
     * `nav-sylph-config-*` 备份里的配置域**不再恢复**——它在 #12 之后不在
     * 备份范围内，这里显式记一条 skip，界面据此提示「旧备份只恢复书签」。
     */
    async restoreBackup(options = {}) {
        const client = this.createClient();
        const remotePath = this.config.remotePath || '/nav-sylph-backups/';

        const result = {
            success: true,
            data: {},
            createdAt: null,
            appVersion: null,
            skipped: [],
            manifest: null
        };

        const readText = file => client.getFileContents(path.posix.join(remotePath, file), { format: 'text' });
        const readEnvelope = async (file, type, label) => {
            const text = await readText(file);
            const backup = JSON.parse(text);
            if (backup.type !== type) {
                throw new Error(`Invalid ${label} backup file format`);
            }
            if (!verifyChecksum(backup)) {
                throw new Error(`${label} backup checksum verification failed`);
            }
            return { text, backup };
        };

        // 旧备份的分域配置：不恢复、也不去取它。用户要的是「列出 + 只恢复书签」。
        if (options.configFile || options.legacyFile) {
            result.skipped.push({ domain: 'admin-navigation', reason: skipReason('admin-navigation') });
        }

        // 清单：先取回来，取到后用它核对每一个文件的真实字节。
        const expected = new Map();
        if (options.manifestFile) {
            const { backup } = await readEnvelope(options.manifestFile, 'nav-sylph-manifest', 'manifest');
            result.manifest = backup.data;
            for (const entry of (Array.isArray(backup.data.included) ? backup.data.included : [])) {
                if (entry && entry.file && entry.sha256) expected.set(entry.file, entry.sha256);
            }
        }
        /** 清单里说了这个文件的 sha256 就必须对上，对不上就当整份备份坏了。 */
        const assertDigest = (file, text) => {
            if (!file || !expected.has(file)) return;
            if (expected.get(file) !== sha256Bytes(text)) {
                throw new Error(`备份内容与清单不符（${file}）`);
            }
        };

        // Handle legacy format (single file with config and favorites)
        if (options.legacyFile) {
            const text = await readText(options.legacyFile);
            const backup = JSON.parse(text);

            if (backup.type !== 'nav-sylph-backup') {
                throw new Error('Invalid backup file format');
            }

            if (!backup.data || !backup.data.config) {
                throw new Error('Backup file is corrupted or incomplete');
            }

            if (!verifyChecksum(backup)) {
                throw new Error('Backup checksum verification failed');
            }

            // 旧格式只有「配置 + 书签」两段：配置按新范围跳过，书签照常恢复。
            if (options.restoreBookmarks !== false && backup.data.favorites) {
                result.data.favorites = backup.data.favorites;
            }

            result.createdAt = backup.createdAt;
            result.appVersion = backup.appVersion;
            return result;
        }

        if (options.bookmarksFile && options.restoreBookmarks !== false) {
            const text = await readText(options.bookmarksFile);
            assertDigest(options.bookmarksFile, text);
            // Return raw HTML for parsing by server
            result.data.bookmarksHtml = text;
        }

        // 备忘录：正文与状态都在这里；服务端整表替换（与时间线同一形状）。
        if (options.memosFile && options.restoreMemos !== false) {
            const { text, backup } = await readEnvelope(options.memosFile, 'nav-sylph-memos', 'memos');
            assertDigest(options.memosFile, text);
            result.data.memos = backup.data;
            if (!result.createdAt) {
                result.createdAt = backup.createdAt;
                result.appVersion = backup.appVersion;
            }
        }

        // 模块平台配置（已投影的私人子集）。服务端按稳定模块 id 合并，
        // 公开模块项与本机凭据都不受影响。
        if (options.modulesFile && options.restoreModules !== false) {
            const { text, backup } = await readEnvelope(options.modulesFile, 'nav-sylph-modules', 'modules');
            assertDigest(options.modulesFile, text);
            result.data.modules = backup.data;
            if (!result.createdAt) {
                result.createdAt = backup.createdAt;
                result.appVersion = backup.appVersion;
            }
        }

        // 时间线。数据在 SQLite，这里只负责取回与校验；整表替换由 server 路由
        // 交给 timeline.service.importTimeline（一个事务）。凭据不在这份文件里——
        // 恢复后来源需要重新授权，这是设计而非缺陷。
        if (options.timelineFile && options.restoreTimeline !== false) {
            const { text, backup } = await readEnvelope(options.timelineFile, 'nav-sylph-timeline', 'timeline');
            assertDigest(options.timelineFile, text);
            result.data.timeline = backup.data;
            if (!result.createdAt) {
                result.createdAt = backup.createdAt;
                result.appVersion = backup.appVersion;
            }
        }

        return result;
    }

    /**
     * Delete a backup file
     */
    async deleteBackup(filename) {
        const client = this.createClient();
        const remotePath = this.config.remotePath || '/nav-sylph-backups/';
        const filePath = path.posix.join(remotePath, filename);

        await client.deleteFile(filePath);

        // 删掉自动槽位的文件时必须同时清掉它那一组校验和。否则 `noChanges`
        // 会在下一次自动同步时直接短路（内容没变 → 不上传），远端那份
        // **再也不会被重新创建**，而界面上还写着「自动同步：已开启」。
        const autoChecksumKey = AUTO_CHECKSUM_KEYS[path.posix.basename(filename)];
        if (autoChecksumKey) {
            // 赋 undefined 而不是 null：JSON.stringify 会丢掉值为 undefined 的键，
            // 于是这一组校验和从配置文件里彻底消失，下一次比较必然不相等。
            // 写 null 不够稳——若当前那一项的内容恰好也判出 null，null === null
            // 会让 noChanges 再次把上传吞掉。
            await this.saveConfig({ [autoChecksumKey]: undefined });
        }

        return { success: true };
    }
}

module.exports = {
    WebDAVBackup,
    encrypt,
    decrypt,
    // 纯函数（投影与合并）导出给测试直接对拍：形状断言看不出「投影漏了一个字段」。
    projectModulesForBackup,
    projectMemosForBackup,
    projectFavoritesForBackup,
    mergePrivateModules,
    mergeServers,
    calculateChecksum,
    sha256Bytes,
    INCLUDED_DOMAINS,
    SKIPPED_DOMAINS,
    SCOPE_VERSION
};

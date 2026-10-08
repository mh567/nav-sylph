/**
 * WebDAV Backup Module
 * Handles remote backup and restore operations via WebDAV
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

/**
 * Verify checksum
 */
function verifyChecksum(backup) {
    if (!backup.checksum || !backup.data) return false;
    const expected = calculateChecksum(backup.data);
    return backup.checksum === expected;
}

// 自动同步槽位的文件名。**不带时间戳**：它是「最新一份」，每次覆盖。
// 手动备份仍是 nav-sylph-config-{时间戳}.json 那一套，由 cleanupOldBackups
// 按最新 N 组轮换；两者分开，自动备份才不会把历史还原点挤掉。
const AUTO_CONFIG_FILE = 'nav-sylph-config-auto.json';
const AUTO_BOOKMARKS_FILE = 'nav-sylph-bookmarks-auto.html';
const AUTO_MODULES_FILE = 'nav-sylph-modules-auto.json';
// 时间线的逻辑导出（来源 / 事件 / 用户状态）。**不含 provider 凭据**：
// 密钥派生自管理员密码哈希，跨安装解不开，放进远端只扩大暴露面。
// 恢复后来源标为「待授权」，由用户重新填写 token。
const AUTO_TIMELINE_FILE = 'nav-sylph-timeline-auto.json';

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
     * Create backup and upload to WebDAV
     * Uploads: config JSON + bookmarks HTML (browser-compatible) + modules JSON
     * Returns noChanges: true if data hasn't changed since last backup
     *
     * @param {object} configData    config.json 全文
     * @param {object} favoritesData favorites.json 全文
     * @param {string} appVersion
     * @param {Function} generateBookmarkHtml
     * @param {object} [modulesData] .modules.json 全文（模块平台配置）
     * @param {object} [options]
     * @param {boolean} [options.auto] 自动同步：写固定文件名（`-auto`，不带
     *   时间戳、每次覆盖），并只比对/更新 `lastAuto*Checksum` 那一组。
     *
     * `modulesData` 里的 token 是**密文**，密钥派生自管理员密码哈希 ——
     * 带着它进备份是安全的（换机器后用同一密码即可解开），但绝不要把
     * 备份和密码放在一起。`.admin-password.json` 依然**不备份**：
     * 把密码哈希交出去等于把账号交出去。
     *
     * **校验和为什么分两套。** 自动备份若更新了手动那一组，用户随后点
     * 「立即备份」会因为「数据没变」而返回 noChanges —— 一次显式请求被
     * 静默吞掉。两条路径各比各的、各更新各的。
     */
    async createBackup(configData, favoritesData, appVersion, generateBookmarkHtml, modulesData, options = {}) {
        const auto = options.auto === true;
        const configKey = auto ? 'lastAutoConfigChecksum' : 'lastConfigChecksum';
        const favoritesKey = auto ? 'lastAutoFavoritesChecksum' : 'lastFavoritesChecksum';
        const modulesKey = auto ? 'lastAutoModulesChecksum' : 'lastModulesChecksum';
        const timelineKey = auto ? 'lastAutoTimelineChecksum' : 'lastTimelineChecksum';

        // Calculate checksums for current data
        const configChecksum = calculateChecksum(configData);
        // Include the HTML format revision so an existing backup is refreshed after
        // privacy metadata becomes part of the exported bookmarks.
        const favoritesChecksum = favoritesData?.favorites
            ? calculateChecksum({ formatVersion: 2, favorites: favoritesData.favorites })
            : null;
        // 模块配置同样参与「有无变化」判定：监控目标改了却判成 noChanges，
        // 就会留一份旧的模块配置在备份里，恢复后拿到的是过期布局。
        const modulesChecksum = modulesData ? calculateChecksum(modulesData) : null;
        // 时间线同理：没有它，新增一条事件不会让自动同步上传任何东西——
        // 而事件恰恰是这里最不可再生的数据。
        const timelineData = options.timelineData || null;
        const timelineChecksum = timelineData ? calculateChecksum(timelineData) : null;

        // Check if data has changed since last backup
        if (this.config[configKey] === configChecksum &&
            this.config[favoritesKey] === favoritesChecksum &&
            this.config[modulesKey] === modulesChecksum &&
            this.config[timelineKey] === timelineChecksum) {
            return {
                success: true,
                noChanges: true,
                message: '配置、书签和模块设置没有变化，无需备份'
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

        // 1. Create config backup (JSON) - contains theme, search engines, bookmark categories
        const configBackup = {
            version: 1,
            type: 'nav-sylph-config',
            createdAt: now.toISOString(),
            appVersion: appVersion || '1.0.0',
            data: configData,
            checksum: calculateChecksum(configData)
        };
        // 自动槽位用文件头那三个常量拼，**不在这里重写一遍字面量**——
        // listBackups 的识别用的就是同一组常量，两处各写一遍就会漂移。
        const configFilename = auto ? AUTO_CONFIG_FILE : `nav-sylph-config-${timestamp}.json`;
        const configFilePath = path.posix.join(remotePath, configFilename);
        await client.putFileContents(configFilePath, JSON.stringify(configBackup, null, 2), {
            contentLength: false
        });

        // 2. Create bookmarks backup (HTML - Netscape format, browser-compatible)
        let bookmarksFilename = null;
        if (generateBookmarkHtml && favoritesData && favoritesData.favorites) {
            const bookmarksHtml = generateBookmarkHtml(favoritesData.favorites);
            bookmarksFilename = auto ? AUTO_BOOKMARKS_FILE : `nav-sylph-bookmarks-${timestamp}.html`;
            const bookmarksFilePath = path.posix.join(remotePath, bookmarksFilename);
            await client.putFileContents(bookmarksFilePath, bookmarksHtml, {
                contentLength: false
            });
        }

        // 3. Create modules backup (JSON) - server list, layout, encrypted agent tokens
        let modulesFilename = null;
        if (modulesData) {
            const modulesBackup = {
                version: 1,
                type: 'nav-sylph-modules',
                createdAt: now.toISOString(),
                appVersion: appVersion || '1.0.0',
                // token 在这里仍是密文：密钥派生自管理员密码哈希，
                // 只有用同一个密码才能解开。丢了这个文件，监控目标与
                // 每台的 token 都要重来一遍。
                data: modulesData,
                checksum: modulesChecksum
            };
            modulesFilename = auto ? AUTO_MODULES_FILE : `nav-sylph-modules-${timestamp}.json`;
            const modulesFilePath = path.posix.join(remotePath, modulesFilename);
            await client.putFileContents(modulesFilePath, JSON.stringify(modulesBackup, null, 2), {
                contentLength: false
            });
        }
        // 4. 时间线（JSON）：来源、事件、用户状态。**不含凭据**（见文件头常量处的说明）。
        // 没有内容时 timelineData 为 null，这里就不生成文件——不为空模块在远端留垃圾。
        let timelineFilename = null;
        if (timelineData) {
            const timelineBackup = {
                version: 1,
                type: 'nav-sylph-timeline',
                createdAt: now.toISOString(),
                appVersion: appVersion || '1.0.0',
                data: timelineData,
                checksum: timelineChecksum
            };
            timelineFilename = auto ? AUTO_TIMELINE_FILE : `nav-sylph-timeline-${timestamp}.json`;
            const timelineFilePath = path.posix.join(remotePath, timelineFilename);
            await client.putFileContents(timelineFilePath, JSON.stringify(timelineBackup, null, 2), {
                contentLength: false
            });
        }

        // Update last backup time and checksums
        this.config.lastBackupTime = now.toISOString();
        // lastBackupTime 两条路径都更新（它就是界面上的「上次备份」）；
        // 校验和只更新自己那一组。
        await this.saveConfig({
            lastBackupTime: this.config.lastBackupTime,
            [configKey]: configChecksum,
            [favoritesKey]: favoritesChecksum,
            [modulesKey]: modulesChecksum,
            [timelineKey]: timelineChecksum
        });

        return {
            success: true,
            configFilename: configFilename,
            bookmarksFilename: bookmarksFilename,
            modulesFilename: modulesFilename,
            timelineFilename: timelineFilename,
            createdAt: now.toISOString(),
            timestamp: auto ? 'auto' : timestamp
        };
    }

    /**
     * List available backups from WebDAV
     * Groups config and bookmarks files by timestamp
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

                // Match new format: nav-sylph-config-{ts}.json,
                // nav-sylph-bookmarks-{ts}.html, nav-sylph-modules-{ts}.json
                const configMatch = item.basename.match(/^nav-sylph-config-(\d{8}-\d{6})\.json$/);
                const bookmarksMatch = item.basename.match(/^nav-sylph-bookmarks-(\d{8}-\d{6})\.html$/);
                const modulesMatch = item.basename.match(/^nav-sylph-modules-(\d{8}-\d{6})\.json$/);
                const timelineMatch = item.basename.match(/^nav-sylph-timeline-(\d{8}-\d{6})\.json$/);
                // Also support legacy format: nav-sylph-backup-{timestamp}.json
                const legacyMatch = item.basename.match(/^nav-sylph-backup-(\d{8}-\d{6})\.json$/);
                // 自动同步槽位（固定文件名）。它不是历史还原点，是「最新一份」，
                // 所以单独 mark，由 cleanupOldBackups 排除在轮换之外。
                const isAutoConfig = item.basename === AUTO_CONFIG_FILE;
                const isAutoBookmarks = item.basename === AUTO_BOOKMARKS_FILE;
                const isAutoModules = item.basename === AUTO_MODULES_FILE;
                const isAutoTimeline = item.basename === AUTO_TIMELINE_FILE;

                if (configMatch) {
                    const ts = configMatch[1];
                    if (!backupGroups[ts]) backupGroups[ts] = { timestamp: ts, lastmod: item.lastmod };
                    backupGroups[ts].configFile = item.basename;
                    backupGroups[ts].configSize = item.size;
                } else if (bookmarksMatch) {
                    const ts = bookmarksMatch[1];
                    if (!backupGroups[ts]) backupGroups[ts] = { timestamp: ts, lastmod: item.lastmod };
                    backupGroups[ts].bookmarksFile = item.basename;
                    backupGroups[ts].bookmarksSize = item.size;
                } else if (modulesMatch) {
                    const ts = modulesMatch[1];
                    if (!backupGroups[ts]) backupGroups[ts] = { timestamp: ts, lastmod: item.lastmod };
                    backupGroups[ts].modulesFile = item.basename;
                    backupGroups[ts].modulesSize = item.size;
                } else if (timelineMatch) {
                    const ts = timelineMatch[1];
                    if (!backupGroups[ts]) backupGroups[ts] = { timestamp: ts, lastmod: item.lastmod };
                    backupGroups[ts].timelineFile = item.basename;
                    backupGroups[ts].timelineSize = item.size;
                } else if (legacyMatch) {
                    const ts = legacyMatch[1];
                    if (!backupGroups[ts]) backupGroups[ts] = { timestamp: ts, lastmod: item.lastmod };
                    backupGroups[ts].legacyFile = item.basename;
                    backupGroups[ts].legacySize = item.size;
                } else if (isAutoConfig || isAutoBookmarks || isAutoModules || isAutoTimeline) {
                    if (!backupGroups.auto) {
                        backupGroups.auto = { timestamp: 'auto', isAuto: true, lastmod: item.lastmod };
                    }
                    if (isAutoConfig) {
                        backupGroups.auto.configFile = item.basename;
                        backupGroups.auto.configSize = item.size;
                    } else if (isAutoBookmarks) {
                        backupGroups.auto.bookmarksFile = item.basename;
                        backupGroups.auto.bookmarksSize = item.size;
                    } else if (isAutoModules) {
                        backupGroups.auto.modulesFile = item.basename;
                        backupGroups.auto.modulesSize = item.size;
                    } else {
                        backupGroups.auto.timelineFile = item.basename;
                        backupGroups.auto.timelineSize = item.size;
                    }
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
                if (backup.configFile) {
                    await this.deleteBackup(backup.configFile);
                    deleted++;
                }
                if (backup.bookmarksFile) {
                    await this.deleteBackup(backup.bookmarksFile);
                    deleted++;
                }
                // 模块文件必须一起删：清理是按分组算的，孤儿文件既不被计入
                // 也不会被清走，长期堆积在 WebDAV 上。
                if (backup.modulesFile) {
                    await this.deleteBackup(backup.modulesFile);
                    deleted++;
                }
                // 时间线文件也必须随组删：清理按分组算，孤儿文件既不计入
                // 也不会被清走，长期堆在 WebDAV 上。
                if (backup.timelineFile) {
                    await this.deleteBackup(backup.timelineFile);
                    deleted++;
                }
                if (backup.legacyFile) {
                    await this.deleteBackup(backup.legacyFile);
                    deleted++;
                }
            } catch (err) {
                console.error('Failed to delete old backup:', err.message);
            }
        }

        return { deleted, backupsRemoved: toDelete.length };
    }

    /**
     * Restore from a specific backup
     * Supports selective restore: config only, bookmarks only, or both
     */
    async restoreBackup(options) {
        const client = this.createClient();
        const remotePath = this.config.remotePath || '/nav-sylph-backups/';

        const result = {
            success: true,
            data: {},
            createdAt: null,
            appVersion: null
        };

        // Handle legacy format (single file with both config and favorites)
        if (options.legacyFile) {
            const filePath = path.posix.join(remotePath, options.legacyFile);
            const content = await client.getFileContents(filePath, { format: 'text' });
            const backup = JSON.parse(content);

            if (backup.type !== 'nav-sylph-backup') {
                throw new Error('Invalid backup file format');
            }

            if (!backup.data || !backup.data.config) {
                throw new Error('Backup file is corrupted or incomplete');
            }

            if (!verifyChecksum(backup)) {
                throw new Error('Backup checksum verification failed');
            }

            // Apply restore options
            if (options.restoreConfig !== false) {
                result.data.config = backup.data.config;
            }
            if (options.restoreBookmarks !== false && backup.data.favorites) {
                result.data.favorites = backup.data.favorites;
            }

            result.createdAt = backup.createdAt;
            result.appVersion = backup.appVersion;
            return result;
        }

        // Handle new format (separate config and bookmarks files)
        if (options.configFile && options.restoreConfig !== false) {
            const filePath = path.posix.join(remotePath, options.configFile);
            const content = await client.getFileContents(filePath, { format: 'text' });
            const backup = JSON.parse(content);

            if (backup.type !== 'nav-sylph-config') {
                throw new Error('Invalid config backup file format');
            }

            if (!verifyChecksum(backup)) {
                throw new Error('Config backup checksum verification failed');
            }

            result.data.config = backup.data;
            result.createdAt = backup.createdAt;
            result.appVersion = backup.appVersion;
        }

        if (options.bookmarksFile && options.restoreBookmarks !== false) {
            const filePath = path.posix.join(remotePath, options.bookmarksFile);
            const content = await client.getFileContents(filePath, { format: 'text' });
            // Return raw HTML for parsing by server
            result.data.bookmarksHtml = content;
        }

        // 模块平台配置。token 仍是密文，落到 .modules.json 后由服务端按需解密；
        // 换机器恢复时用的是同一个管理员密码，密文才能解开。
        if (options.modulesFile && options.restoreModules !== false) {
            const filePath = path.posix.join(remotePath, options.modulesFile);
            const content = await client.getFileContents(filePath, { format: 'text' });
            const backup = JSON.parse(content);
            if (backup.type !== 'nav-sylph-modules') {
                throw new Error('Invalid modules backup file format');
            }
            if (!verifyChecksum(backup)) {
                throw new Error('Modules backup checksum verification failed');
            }
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
            const filePath = path.posix.join(remotePath, options.timelineFile);
            const content = await client.getFileContents(filePath, { format: 'text' });
            const backup = JSON.parse(content);
            if (backup.type !== 'nav-sylph-timeline') {
                throw new Error('Invalid timeline backup file format');
            }
            if (!verifyChecksum(backup)) {
                throw new Error('Timeline backup checksum verification failed');
            }
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
        const autoChecksumKey = {
            [AUTO_CONFIG_FILE]: 'lastAutoConfigChecksum',
            [AUTO_BOOKMARKS_FILE]: 'lastAutoFavoritesChecksum',
            [AUTO_MODULES_FILE]: 'lastAutoModulesChecksum',
            [AUTO_TIMELINE_FILE]: 'lastAutoTimelineChecksum'
        }[path.posix.basename(filename)];
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

module.exports = { WebDAVBackup, encrypt, decrypt };

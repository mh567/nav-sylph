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
                lastBackupTime: null
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
            lastBackupTime: this.config.lastBackupTime
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
     *
     * `modulesData` 里的 token 是**密文**，密钥派生自管理员密码哈希 ——
     * 带着它进备份是安全的（换机器后用同一密码即可解开），但绝不要把
     * 备份和密码放在一起。`.admin-password.json` 依然**不备份**：
     * 把密码哈希交出去等于把账号交出去。
     */
    async createBackup(configData, favoritesData, appVersion, generateBookmarkHtml, modulesData) {
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

        // Check if data has changed since last backup
        if (this.config.lastConfigChecksum === configChecksum &&
            this.config.lastFavoritesChecksum === favoritesChecksum &&
            this.config.lastModulesChecksum === modulesChecksum) {
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
        const configFilename = `nav-sylph-config-${timestamp}.json`;
        const configFilePath = path.posix.join(remotePath, configFilename);
        await client.putFileContents(configFilePath, JSON.stringify(configBackup, null, 2), {
            contentLength: false
        });

        // 2. Create bookmarks backup (HTML - Netscape format, browser-compatible)
        let bookmarksFilename = null;
        if (generateBookmarkHtml && favoritesData && favoritesData.favorites) {
            const bookmarksHtml = generateBookmarkHtml(favoritesData.favorites);
            bookmarksFilename = `nav-sylph-bookmarks-${timestamp}.html`;
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
            modulesFilename = `nav-sylph-modules-${timestamp}.json`;
            const modulesFilePath = path.posix.join(remotePath, modulesFilename);
            await client.putFileContents(modulesFilePath, JSON.stringify(modulesBackup, null, 2), {
                contentLength: false
            });
        }

        // Update last backup time and checksums
        this.config.lastBackupTime = now.toISOString();
        await this.saveConfig({
            lastBackupTime: this.config.lastBackupTime,
            lastConfigChecksum: configChecksum,
            lastFavoritesChecksum: favoritesChecksum,
            lastModulesChecksum: modulesChecksum
        });

        return {
            success: true,
            configFilename: configFilename,
            bookmarksFilename: bookmarksFilename,
            modulesFilename: modulesFilename,
            createdAt: now.toISOString(),
            timestamp: timestamp
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
                // Also support legacy format: nav-sylph-backup-{timestamp}.json
                const legacyMatch = item.basename.match(/^nav-sylph-backup-(\d{8}-\d{6})\.json$/);

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
                } else if (legacyMatch) {
                    const ts = legacyMatch[1];
                    if (!backupGroups[ts]) backupGroups[ts] = { timestamp: ts, lastmod: item.lastmod };
                    backupGroups[ts].legacyFile = item.basename;
                    backupGroups[ts].legacySize = item.size;
                }
            }

            // Convert to sorted array
            const backups = Object.values(backupGroups)
                .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

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

        if (backups.length <= keepCount) {
            return { deleted: 0 };
        }

        const toDelete = backups.slice(keepCount);
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
        return { success: true };
    }
}

module.exports = { WebDAVBackup, encrypt, decrypt };

/**
 * WebDAV Backup Module
 * Handles remote backup and restore operations via WebDAV
 */

const { createClient } = require('webdav');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// Encryption utilities for storing WebDAV password
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Derive encryption key from admin password hash
 */
function deriveKey(passwordHash) {
    return crypto.createHash('sha256')
        .update(passwordHash + 'webdav-config-key')
        .digest();
}

/**
 * Encrypt sensitive data (WebDAV password)
 */
function encrypt(text, passwordHash) {
    const key = deriveKey(passwordHash);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();

    return {
        iv: iv.toString('hex'),
        data: encrypted,
        tag: tag.toString('hex')
    };
}

/**
 * Decrypt sensitive data (WebDAV password)
 */
function decrypt(encrypted, passwordHash) {
    try {
        const key = deriveKey(passwordHash);
        const iv = Buffer.from(encrypted.iv, 'hex');
        const tag = Buffer.from(encrypted.tag, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);

        let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
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
     * Now creates two files: config JSON + bookmarks HTML (browser-compatible)
     * Returns noChanges: true if data hasn't changed since last backup
     */
    async createBackup(configData, favoritesData, appVersion, generateBookmarkHtml) {
        // Calculate checksums for current data
        const configChecksum = calculateChecksum(configData);
        const favoritesChecksum = favoritesData?.favorites ? calculateChecksum(favoritesData.favorites) : null;

        // Check if data has changed since last backup
        if (this.config.lastConfigChecksum === configChecksum &&
            this.config.lastFavoritesChecksum === favoritesChecksum) {
            return {
                success: true,
                noChanges: true,
                message: '配置和收藏没有变化，无需备份'
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

        // Update last backup time and checksums
        this.config.lastBackupTime = now.toISOString();
        await this.saveConfig({
            lastBackupTime: this.config.lastBackupTime,
            lastConfigChecksum: configChecksum,
            lastFavoritesChecksum: favoritesChecksum
        });

        return {
            success: true,
            configFilename: configFilename,
            bookmarksFilename: bookmarksFilename,
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

                // Match new format: nav-sylph-config-{timestamp}.json or nav-sylph-bookmarks-{timestamp}.html
                const configMatch = item.basename.match(/^nav-sylph-config-(\d{8}-\d{6})\.json$/);
                const bookmarksMatch = item.basename.match(/^nav-sylph-bookmarks-(\d{8}-\d{6})\.html$/);
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

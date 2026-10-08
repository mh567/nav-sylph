'use strict';

/**
 * 凭据加密。
 *
 * 从 `lib/webdav-backup.js` 抽出，供 WebDAV 密码、模块 agent token 与
 * 时间线 provider 凭据共用。共用的理由不是「少写一份代码」，而是两条规则
 * 必须一致：
 *  - 同一套算法与参数，改一处不会漏另一处；
 *  - 改密码时要**一起**重新加密，逻辑只有一份才做得到。
 *
 * 密钥从管理员密码哈希派生，每个用途用不同的后缀——
 * 同一把密钥跨用途会让一处泄露同时丢掉两个凭据。
 *
 * 已知边界：丢失 `.admin-password.json` 且无备份里的旧密码时，
 * 凭据永久无法恢复。这是「不另存主密钥」的直接代价，与 WebDAV 原有
 * 行为一致，不是本次新引入的限制。同理，**凭据密文不可跨安装移植**：
 * 密钥由密码哈希（bcrypt，带盐）派生，换个安装、换个密码哈希就解不开——
 * 所以时间线的 provider 凭据不进 WebDAV 备份（见 lib/webdav-backup.js）。
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// 每个用途一个派生后缀。改动这里会让已存的密文全部解不开——
// 追加新用途可以，改已有后缀不行。
const KEY_CONTEXTS = {
    webdav: 'webdav-config-key',
    modules: 'modules-token-key',
    timeline: 'timeline-credential-key'
};

function deriveKey(passwordHash, context) {
    const suffix = KEY_CONTEXTS[context];
    if (!suffix) throw new Error('未知的密钥用途: ' + context);
    if (typeof passwordHash !== 'string' || !passwordHash) {
        throw new Error('缺少密码哈希，无法派生密钥');
    }
    return crypto.createHash('sha256')
        .update(passwordHash + suffix)
        .digest();
}

/**
 * 加密一段文本。
 * @returns {{iv:string, data:string, tag:string}}
 */
function encrypt(text, passwordHash, context) {
    if (typeof text !== 'string' || !text) {
        throw new Error('待加密内容为空');
    }
    const key = deriveKey(passwordHash, context);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let data = cipher.update(text, 'utf8', 'hex');
    data += cipher.final('hex');
    return {
        iv: iv.toString('hex'),
        data,
        tag: cipher.getAuthTag().toString('hex')
    };
}

/** 形状校验。用于判断某个字段是不是一个可解密的信封。 */
function isEnvelope(value) {
    return !!value && typeof value === 'object'
        && typeof value.iv === 'string' && typeof value.data === 'string'
        && typeof value.tag === 'string';
}

/**
 * 解密。失败（密钥变了 / 数据被改 / 密文截断）一律抛错，
 * 不返回部分明文，也不静默吞掉——调用方需要据此提示用户重新输入。
 */
function decrypt(envelope, passwordHash, context) {
    if (!isEnvelope(envelope)) {
        throw new Error('凭据格式不正确');
    }
    try {
        const key = deriveKey(passwordHash, context);
        const decipher = crypto.createDecipheriv(
            ALGORITHM, key, Buffer.from(envelope.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
        let plain = decipher.update(envelope.data, 'hex', 'utf8');
        plain += decipher.final('utf8');
        return plain;
    } catch (err) {
        throw new Error('凭据解密失败，可能因修改过管理密码而失效');
    }
}

/**
 * 换密钥：用一个密码解、另一个密码加。
 * 用于修改密码时原地重加密——明文全程只在内存里，不落盘。
 *
 * @param {object} envelope 原密文
 * @param {string} oldHash 旧密码哈希
 * @param {string} newHash 新密码哈希
 * @param {string} context 密钥用途
 * @returns {object} 新密文
 */
function reencrypt(envelope, oldHash, newHash, context) {
    return encrypt(decrypt(envelope, oldHash, context), newHash, context);
}

module.exports = { encrypt, decrypt, reencrypt, isEnvelope, deriveKey, KEY_CONTEXTS };

/**
 * 配置加载器
 * 优先级: 默认值 < config.json < .env < 环境变量
 */

const fs = require('fs');
const path = require('path');
const defaults = require('./defaults');

// 项目根目录
const ROOT_DIR = path.join(__dirname, '..');

// 尝试加载 dotenv（如果已安装）
try {
    const envPath = path.join(ROOT_DIR, '.env');
    if (fs.existsSync(envPath)) {
        require('dotenv').config({ path: envPath });
    }
} catch (e) {
    // dotenv 未安装，忽略
}

/**
 * 深度合并对象
 */
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(result[key] || {}, source[key]);
        } else if (source[key] !== undefined && source[key] !== '') {
            result[key] = source[key];
        }
    }
    return result;
}

/**
 * 从环境变量读取配置
 */
function loadFromEnv() {
    const env = process.env;
    return {
        server: {
            host: env.SERVER_HOST || env.HOST,
            port: env.SERVER_PORT || env.PORT ? parseInt(env.SERVER_PORT || env.PORT) : undefined,
            https: {
                enabled: env.HTTPS_ENABLED === 'true',
                keyPath: env.HTTPS_KEY_PATH,
                certPath: env.HTTPS_CERT_PATH,
                caPath: env.HTTPS_CA_PATH
            }
        },
        security: {
            adminPasswordFile: env.ADMIN_PASSWORD_FILE
        },
        paths: {
            data: env.DATA_FILE,
            icon: env.ICON_PATH,
            favicon: env.FAVICON_PATH,
            logs: env.LOG_DIR
        }
    };
}

/**
 * 从 JSON 文件读取服务器配置（如果存在 server-config.json）
 */
function loadFromConfigFile() {
    const configPath = path.join(ROOT_DIR, 'server-config.json');
    if (fs.existsSync(configPath)) {
        try {
            const content = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(content);
        } catch (e) {
            console.warn('警告: server-config.json 解析失败:', e.message);
        }
    }
    return {};
}

/**
 * 解析相对路径为绝对路径
 */
function resolvePaths(config) {
    const resolved = JSON.parse(JSON.stringify(config));
    
    if (resolved.paths) {
        for (const key of Object.keys(resolved.paths)) {
            if (resolved.paths[key] && !path.isAbsolute(resolved.paths[key])) {
                resolved.paths[key] = path.join(ROOT_DIR, resolved.paths[key]);
            }
        }
    }
    
    if (resolved.security && resolved.security.adminPasswordFile && !path.isAbsolute(resolved.security.adminPasswordFile)) {
        resolved.security.adminPasswordFile = path.join(ROOT_DIR, resolved.security.adminPasswordFile);
    }
    
    if (resolved.server && resolved.server.https) {
        const httpsConf = resolved.server.https;
        if (httpsConf.keyPath && !path.isAbsolute(httpsConf.keyPath)) {
            httpsConf.keyPath = path.join(ROOT_DIR, httpsConf.keyPath);
        }
        if (httpsConf.certPath && !path.isAbsolute(httpsConf.certPath)) {
            httpsConf.certPath = path.join(ROOT_DIR, httpsConf.certPath);
        }
        if (httpsConf.caPath && !path.isAbsolute(httpsConf.caPath)) {
            httpsConf.caPath = path.join(ROOT_DIR, httpsConf.caPath);
        }
    }
    
    if (resolved.app && resolved.app.pidFile && !path.isAbsolute(resolved.app.pidFile)) {
        resolved.app.pidFile = path.join(ROOT_DIR, resolved.app.pidFile);
    }
    
    return resolved;
}

/**
 * 验证配置
 */
function validateConfig(config) {
    const errors = [];
    
    // 验证端口
    if (config.server.port < 1 || config.server.port > 65535) {
        errors.push(`无效的端口号: ${config.server.port}`);
    }
    
    // 验证 HTTPS 配置
    if (config.server.https.enabled) {
        if (!config.server.https.keyPath) {
            errors.push('HTTPS 已启用但未配置 keyPath');
        } else if (!fs.existsSync(config.server.https.keyPath)) {
            errors.push(`HTTPS 密钥文件不存在: ${config.server.https.keyPath}`);
        }
        
        if (!config.server.https.certPath) {
            errors.push('HTTPS 已启用但未配置 certPath');
        } else if (!fs.existsSync(config.server.https.certPath)) {
            errors.push(`HTTPS 证书文件不存在: ${config.server.https.certPath}`);
        }
    }
    
    if (errors.length > 0) {
        throw new Error('配置验证失败:\n  - ' + errors.join('\n  - '));
    }
    
    return config;
}

let configData = deepMerge(defaults, loadFromConfigFile());
configData = deepMerge(configData, loadFromEnv());
configData = resolvePaths(configData);

configData.rootDir = ROOT_DIR;

configData.validate = function() {
    return validateConfig(configData);
};

Object.freeze(configData.server.https);
Object.freeze(configData.server);
Object.freeze(configData.security);
Object.freeze(configData.paths);
Object.freeze(configData.app);

module.exports = configData;

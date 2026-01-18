const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const http = require('http');
const bcrypt = require('bcrypt');

const config = require('./server-config');

const app = express();
let server;

const CONFIG_FILE = path.join(config.rootDir, 'config.json');
const PASSWORD_FILE = config.security.adminPasswordFile;

// 禁用 X-Powered-By 头
app.disable('x-powered-by');

app.use(express.json());

// 安全头 (必须在静态文件之前)
app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('X-XSS-Protection', '1; mode=block');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    
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

app.use((req, res, next) => {
    const time = new Date().toISOString();
    console.log(`[${time}] ${req.method} ${req.path}`);
    next();
});



// 简易 Rate Limiting (密码相关接口)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1分钟
const RATE_LIMIT_MAX = 10; // 最多10次

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

async function ensureFile(file, defaultData) {
    try {
        await fs.access(file);
    } catch {
        await fs.writeFile(file, JSON.stringify(defaultData, null, 2));
        console.log(`Created: ${path.basename(file)}`);
    }
}

async function readJSON(file) {
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data);
}

async function writeJSON(file, data) {
    await fs.writeFile(file, JSON.stringify(data, null, 2));
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

async function init() {
    const logDir = config.paths.logs;
    if (!fsSync.existsSync(logDir)) {
        await fs.mkdir(logDir, { recursive: true });
        console.log(`Created: ${path.basename(logDir)}/`);
    }

    await ensureFile(CONFIG_FILE, defaultConfig);
    await ensureFile(PASSWORD_FILE, {
        passwordHash: await bcrypt.hash(config.security.defaultPassword, 10)
    });
}

app.get('/api/config', async (req, res) => {
    try {
        const cfg = await readJSON(CONFIG_FILE);
        res.json(cfg);
    } catch (err) {
        console.error('读取配置失败:', err);
        res.status(500).json({ error: '读取配置失败' });
    }
});

app.post('/api/config', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    
    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }
    
    try {
        const cfg = req.body;
        if (!cfg.categories || !Array.isArray(cfg.categories)) {
            return res.status(400).json({ error: '无效的配置格式' });
        }
        
        await writeJSON(CONFIG_FILE, cfg);
        res.json({ success: true });
    } catch (err) {
        console.error('保存配置失败:', err);
        res.status(500).json({ error: '保存配置失败' });
    }
});

app.post('/api/verify-password', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    const valid = await verifyPassword(password);
    res.json({ valid });
});

app.post('/api/change-password', rateLimit, async (req, res) => {
    const currentPassword = req.headers['x-admin-password'];
    const { newPassword } = req.body;
    
    if (!await verifyPassword(currentPassword)) {
        return res.status(401).json({ error: '当前密码错误' });
    }
    
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: '新密码至少8位' });
    }
    
    try {
        const passwordHash = await bcrypt.hash(newPassword, 10);
        await writeJSON(PASSWORD_FILE, { passwordHash });
        res.json({ success: true });
    } catch (err) {
        console.error('修改密码失败:', err);
        res.status(500).json({ error: '修改密码失败' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    process.exit(1);
});

module.exports = app;

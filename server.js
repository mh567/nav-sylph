const express = require('express');
const compression = require('compression');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const http = require('http');
const bcrypt = require('bcrypt');

const config = require('./server-config');

const app = express();
let server;

// ========== Paste 分享功能 ==========
const pasteStorage = new Map();
// 结构: { code: { content, pin, expiresAt, attempts } }

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

// 每60秒清理过期分享
setInterval(cleanExpiredPastes, 60000);

// Paste 速率限制
const pasteRateLimitMap = new Map();
const PASTE_CREATE_LIMIT = 10; // 每小时创建限制
const PASTE_GET_LIMIT = 30;    // 每小时获取限制
const PASTE_RATE_WINDOW = 3600000; // 1小时

function checkPasteRateLimit(ip, action) {
    const now = Date.now();
    const key = `${ip}:paste:${action}`;
    const limit = action === 'create' ? PASTE_CREATE_LIMIT : PASTE_GET_LIMIT;

    let record = pasteRateLimitMap.get(key);
    if (!record || now - record.start > PASTE_RATE_WINDOW) {
        record = { start: now, count: 0 };
    }
    record.count++;
    pasteRateLimitMap.set(key, record);

    return record.count <= limit;
}

const CONFIG_FILE = path.join(config.rootDir, 'config.json');
const FAVORITES_FILE = path.join(config.rootDir, 'favorites.json');
const PASSWORD_FILE = config.security.adminPasswordFile;
const WEBDAV_CONFIG_FILE = path.join(config.rootDir, '.webdav-config.json');

// WebDAV Backup module
const { WebDAVBackup } = require('./lib/webdav-backup');

// 禁用 X-Powered-By 头
app.disable('x-powered-by');

app.use(express.json());
app.use(compression({ threshold: 1024 }));

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
    await ensureFile(FAVORITES_FILE, defaultFavorites);
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

// 获取收藏书签
app.get('/api/favorites', async (req, res) => {
    try {
        const data = await readJSON(FAVORITES_FILE);
        res.json(data);
    } catch (err) {
        console.error('读取收藏失败:', err);
        res.status(500).json({ error: '读取收藏失败' });
    }
});

// 保存收藏书签
app.post('/api/favorites', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];

    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

    try {
        const { favorites } = req.body;
        if (!Array.isArray(favorites)) {
            return res.status(400).json({ error: '无效的数据格式' });
        }

        await writeJSON(FAVORITES_FILE, { version: 1, favorites });
        res.json({ success: true });
    } catch (err) {
        console.error('保存收藏失败:', err);
        res.status(500).json({ error: '保存收藏失败' });
    }
});

// 导入浏览器书签
app.post('/api/favorites/import', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];

    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

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
app.get('/api/favorites/export', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];

    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

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
app.get('/api/webdav/config', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

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
app.post('/api/webdav/config', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

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
app.post('/api/webdav/test', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

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
app.post('/api/webdav/backup', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

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

        // Get app version
        let appVersion = '1.0.0';
        try {
            const versionData = await readJSON(path.join(config.rootDir, 'version.json'));
            appVersion = versionData.version;
        } catch {}

        const result = await webdav.createBackup(configData, favoritesData, appVersion, generateBookmarkHtml);

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
app.get('/api/webdav/list', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

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
app.post('/api/webdav/restore', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

    try {
        const {
            configFile,
            bookmarksFile,
            legacyFile,
            restoreConfig = true,
            restoreBookmarks = true
        } = req.body;

        if (!configFile && !bookmarksFile && !legacyFile) {
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
            legacyFile,
            restoreConfig,
            restoreBookmarks
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

        res.json({
            success: true,
            message: '恢复成功',
            restoredConfig: !!(result.data.config && restoreConfig),
            restoredBookmarks: !!(result.data.favorites || result.data.bookmarksHtml) && restoreBookmarks,
            createdAt: result.createdAt,
            appVersion: result.appVersion
        });
    } catch (err) {
        console.error('WebDAV 恢复失败:', err);
        res.status(500).json({ error: '恢复失败: ' + err.message });
    }
});

// Delete backup file
app.post('/api/webdav/delete', rateLimit, async (req, res) => {
    const password = req.headers['x-admin-password'];
    if (!await verifyPassword(password)) {
        return res.status(401).json({ error: '密码错误' });
    }

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

// ========== Paste API ==========

// 生成分享码（用于客户端加密）
app.post('/api/p/code', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;

    if (!checkPasteRateLimit(ip, 'create')) {
        return res.status(429).json({ error: '创建过于频繁，请稍后再试' });
    }

    const code = generatePasteCode();
    res.json({ code });
});

// 创建分享
app.post('/api/p', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;

    const { code, content, pin } = req.body;

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

    const expiresAt = Date.now() + 5 * 60 * 1000; // 5分钟后过期

    pasteStorage.set(code, {
        content,
        pin: pin || null,
        expiresAt,
        attempts: 0
    });

    console.log(`[Paste] Created: ${code} (expires in 5min)`);

    res.json({
        success: true,
        code,
        expiresAt,
        hasPin: !!pin
    });
});

// 获取分享 (API)
app.post('/api/p/:code', (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;

    if (!checkPasteRateLimit(ip, 'get')) {
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
            }
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
            background: var(--bg); color: var(--text); min-height: 100dvh;
            display: flex; align-items: center; justify-content: center; padding: 20px;
        }
        .container {
            width: 100%; max-width: 560px; background: var(--panel);
            border: 1px solid var(--border); border-radius: 16px; padding: 24px;
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

        async function showContent(encryptedContent) {
            try {
                decryptedText = await Crypto.decrypt(encryptedContent, code);
                document.getElementById('content').textContent = decryptedText;
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
                    document.getElementById('errorMsg').innerHTML =
                        '<div class="msg error-msg">' + (data.error || '验证失败') + '</div>';
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

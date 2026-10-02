// 首页性能优化：admin.css 改非阻塞加载、pinyin/qrcode 延迟加载，
// index.html 与 app.js 已变，命中缓存的老用户拿不到，必须升缓存名。
// 模块平台：新增 public/modules/server-monitor.js。它按需加载、不进首屏，
// 但仍留在预缓存清单里——延后加载的文件若不预缓存，回访用户的每次模块
// 打开都要走一次网络，与延后加载的初衷相反。
// nav-v46：多服务器监控新增「推送」模式（后台采集方式单选、模式徽章、
// 连通性探测按钮、推送版部署命令），并修对话框在宽屏偏上 8px 与
// 横屏下操作区不可见。改了 app.js、admin.css、modules/server-monitor.js。
// nav-v45：agent /health 不再泄露主机名 + 后台说明 token 后果。
// nav-v44：后台恢复选项与备份列表加入「模块」。
// nav-v43：.app 建立包含块，修模块区在 .app 有居中留白时错位。
// nav-v42：每台服务器可单独控制首页显示 + 布局键改绑服务器 id。
// nav-v41：拖拽加基准补偿 + 让位过渡（修「切换生硬、跳动过大」）。
// nav-v40：拖拽真正移动 DOM（修「拖了不换位」）。
// nav-v39：模块卡片按实测高度堆叠（修重叠）+ 后台监控目标列表压紧，改了 app.js、admin.css、styles.css。
// nav-v38：更新周期可配 + agent 部署命令面板，改了 app.js、admin.css、server.js。
// nav-v37：服务器监控改为多服务器（每台一张卡片）+ 后台监控目标列表，
// 改了 app.js、styles.css、admin.css、modules/server-monitor.js。
const CACHE = 'nav-v46';
const ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/admin.css',
    '/app.js',
    '/lib/uFuzzy.iife.min.js',
    '/lib/pinyin.js',
    '/lib/qrcode.js',
    '/modules/server-monitor.js',
    '/favicon.svg',
    '/icon.svg',
    '/manifest.json'
];
const ASSET_PATHS = new Set(ASSETS);

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE)
            .then(c => c.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !ASSET_PATHS.has(url.pathname)) return;

    e.respondWith(
        caches.match(e.request).then(cached => {
            const fetched = fetch(e.request).then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return res;
            }).catch(() => cached);
            return cached || fetched;
        })
    );
});

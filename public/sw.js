// nav-v154：项目更名 Habu，站点标题改为数字工作台。
// nav-v153：清理拆分后遗留的多端同步说明，改为管理员多设备。
// nav-v152：Sylph 定位个人数字工作台，移除口令同步。
const CACHE = 'nav-v154';
const ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/admin.css',
    '/themes.css',
    '/fonts/inter-tight-latin-variable.woff2',
    '/app.js',
    '/navigation-schema.js',
    '/local-navigation.js',
    '/lib/uFuzzy.iife.min.js',
    '/lib/pinyin.js',
    '/lib/qrcode.js',
    '/modules/server-monitor.js',
    '/modules/memo.js',
    '/modules/special-line.js',
    '/modules/weibo-hot.js',
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

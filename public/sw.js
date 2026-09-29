// app.js 新增管理面板的「信任此设备」开关，必须升缓存名，否则老用户拿到的仍是旧面板
const CACHE = 'nav-v28';
const ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/admin.css',
    '/app.js',
    '/lib/uFuzzy.iife.min.js',
    '/lib/pinyin.js',
    '/lib/qrcode.js',
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

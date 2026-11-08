// nav-v165：新增公开演示页 public/demo/（纯静态，不进预缓存清单）。
// nav-v164：首屏并发优化，server-flags 与会话并行、版本与日志并行。
// nav-v163：首页脚本改为 defer，HTML 解析不再被脚本求值打断。
// nav-v162：后台设置下拉统一为自绘控件，模块开关改为就地替换。
// nav-v161：下拉统一为 pabu 规范（宽度、锚点、入场动画与勾标）。
// nav-v160：首页底栏退出入口，模块开关重画保持滚动位置。
// nav-v159：静谧空间登录入口。
// nav-v158：移除底部外观快捷入口。
// nav-v157：移除文本分享及专属资源。
// nav-v156：个人工作台登录门禁，首页与私人页面不进入静态缓存。
// nav-v155：运行时标识与协议标记同步改名为 habu。
// nav-v154：项目更名 Habu，站点标题改为数字工作台。
// nav-v153：清理拆分后遗留的多端同步说明，改为管理员多设备。
// nav-v152：Sylph 定位个人数字工作台，移除口令同步。
const CACHE = 'nav-v165';
const ASSETS = [
    '/login.html',
    '/login.js',
    '/login.css',
    '/styles.css',
    '/admin.css',
    '/themes.css',
    '/fonts/inter-tight-latin-variable.woff2',
    '/app.js',
    '/navigation-schema.js',
    '/local-navigation.js',
    '/lib/uFuzzy.iife.min.js',
    '/lib/pinyin.js',
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

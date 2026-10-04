// 首页性能优化：admin.css 改非阻塞加载、pinyin/qrcode 延迟加载，
// index.html 与 app.js 已变，命中缓存的老用户拿不到，必须升缓存名。
// 模块平台：新增 public/modules/server-monitor.js。它按需加载、不进首屏，
// 但仍留在预缓存清单里——延后加载的文件若不预缓存，回访用户的每次模块
// 打开都要走一次网络，与延后加载的初衷相反。
// nav-v52：首页卡片改「存储占用」替掉负载、状态位只说在线/离线、
// 详情页显示设备地址。改了 server-monitor.js、styles.css、app.js。
// ⚠️ 改了 public/ 下的文件必须同批升缓存名，否则老用户继续吃旧 bundle、
// 本次修复对他们完全不生效，而本地测试是绿的、看不出这个问题。
// nav-v51：后台模块页重构——去掉总的「保存模块配置」按钮、本机排第一
// 不可删、三状态位（已装 agent / 在线 / 同步方式）、卡片按钮 44→36px。
// ⚠️ 改了 public/ 下的文件必须同批升缓存名，否则老用户继续吃旧 bundle、
// 本次修复对他们完全不生效，而本地测试是绿的、看不出这个问题。
// nav-v50：修 agent 注册漏发 token（NAS 上安装稳定 400）+ 自签服务器
// 需要 --server-ca。改了 app.js、agent/、tests/。
// ⚠️ 改了 public/ 下的文件必须同批升缓存名，否则老用户继续吃旧 bundle、
// 本次修复对他们完全不生效，而本地测试是绿的、看不出这个问题。
// nav-v49：监控接入重构——Go 静态二进制 agent、一键安装命令、
// 后台卡片拆成「在线」+「部署就绪」两个状态位。改了 app.js、admin.css、
// styles.css、modules/server-monitor.js。
// ⚠️ 改了 public/ 下的文件必须同批升缓存名，否则老用户继续吃旧 bundle、
// 本次修复对他们完全不生效，而本地测试是绿的、看不出这个问题。
// nav-v48：拉取模式强制 HTTPS（agent 内置 TLS + 指纹配对 TOFU），
// 改了 app.js、admin.css、sw.js。改了 public/ 下的文件必须同批升缓存名，
// 否则老用户继续吃旧 bundle、本次修复对他们完全不生效，而本地测试是绿的。
// nav-v47：服务器列表改卡片网格（按钮从 26px 抬到 44px 触控下限，
// 横向多台并排），横屏对话框压缩（选项并排两列），以及一条 flaky 计时断言
// 改为机制断言。改了 app.js、admin.css、sw.js。
// nav-v46：多服务器监控新增「推送」模式（后台采集方式单选、模式徽章、
// 连通性探测按钮、推送版部署命令），并修对话框在宽屏偏上 8px 与
// 横屏下操作区不可见。改了 app.js、admin.css、modules/server-monitor.js。
// nav-v45：agent /health 不再泄露主机名 + 后台说明 token 后果。
// nav-v44：后台恢复选项与备份列表加入「模块」。
// nav-v43：.app 建立包含块，修模块区在 .app 有居中留白时错位。
// nav-v42：每台服务器可单独控制首页显示 + 布局键重绑服务器 id。
// nav-v41：拖拽加基准补偿 + 让位过渡（修「切换生硬、跳动过大」）。
// nav-v40：拖拽真正移动 DOM（修「拖了不换位」）。
// nav-v39：模块卡片按实测高度堆叠（修重叠）+ 后台监控目标列表压紧，改了 app.js、admin.css、styles.css。
// nav-v38：更新周期可配 + agent 部署命令面板，改了 app.js、admin.css、server.js。
// nav-v37：服务器监控改为多服务器（每台一张卡片）+ 后台监控目标列表，
// 改了 app.js、styles.css、admin.css、modules/server-monitor.js。
const CACHE = 'nav-v49';
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

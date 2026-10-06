// 首页性能优化：admin.css 改非阻塞加载、pinyin/qrcode 延迟加载，
// index.html 与 app.js 已变，命中缓存的老用户拿不到，必须升缓存名。
// 模块平台：新增 public/modules/server-monitor.js。它按需加载、不进首屏，
// 但仍留在预缓存清单里——延后加载的文件若不预缓存，回访用户的每次模块
// 打开都要走一次网络，与延后加载的初衷相反。
// nav-v65：右下角新增「外观」三态按钮（自动 / 浅色 / 深色）——后台的
// 「主题模式」搬到前台，未登录也可见；未登录存本机，登录后写服务端。
// 改了 index.html、app.js、styles.css。
// nav-v64：WebDAV 备份列表的时间不再比北京时间早 8 小时——文件名里的
// 时间戳是 UTC，此前被当成本地时间直接显示。新增 formatBackupTime 统一
// 按本地时区渲染，「上次备份」与列表（含删除确认）共用。改了 app.js。
// nav-v63：后台「收藏夹」成为独立 tab——原「账户与备份」里的收藏
// 分区整区迁入，收藏管理器改渲染进 tab 内的 #favManagerHost（不再整块
// 替换 #modalBody，「← 返回」由 tab 栏取代）；全产品线换名：
// 收藏→书签、首页网格的书签→导航。改了 app.js、index.html、server.js。
// nav-v62：触摸端也能拖了——新增 bindTouchGridDrag（长按 400ms 激活的 pointer 路径），
// 桌面端仍走原生 DnD。分类头/书签卡在编辑态关掉文字选中与 iOS 长按菜单。
// 改了 app.js、styles.css。
// nav-v61：首页编辑模式拖拽真正可用——补上从未注册过的 pointermove 监听；
// 分类拖拽宿主定为 .category-header，并在 pointerdown 排除 ✎/✕（否则拖拽吞掉 click）。
// 改了 app.js、styles.css。
// nav-v60：删掉后台的「书签分类」分区——编辑器、容器与整块分区一并
// 移除，书签的编辑入口唯一是首页右下角的「编辑」。同时清掉随之
// 失去引用的 CSS（.bookmarks-list / .bookmark-item / .cat-toggle /
// .cat-count / .item-drag）。改了 app.js、styles.css、admin.css。
// 同批升缓存名——发版 pre-flight 抓到的漏 bump。
// nav-v59：首页「布局」按钮改为「编辑 / 保存编辑」——编辑模式扩到书签网格：
// 分类与书签可拖拽、可增删改，模块拖拽改为草稿（不再松手即存）。
// 改了 index.html、app.js、styles.css。同批升缓存名。
// nav-v58：修「后台更新周期改完不生效」——两处前端漂移：
// loadModulesConfig 归一化时漏掉 pollInterval（模块编辑器回显恒为 15 秒，
// 用户改的值确实落盘了、首页轮询也真按新周期跑，唯独回显是假的），
// visibilityHandler 切回前台时用硬编码 POLL_MS 重排表（周期被悄悄打回 15 秒）。
// 改了 app.js、modules/server-monitor.js、sw.js。同批升缓存名。
// nav-v57：发版审查修正——部署面板 push 文案引用屏幕上真实出现的字样
// （「已就绪」「尚未收到推送」「已 N 分钟未收到推送」，两态不合并）、
// note 也按模式分支（push 无自动翻牌）；自签说明再减一句；
// renderLocalServerCard 头注释里「关掉无处恢复」的旧前提改写。
// 改了 app.js、admin.css。同批升缓存名。
// nav-v56：修「后台取消本机「显示」、首页照常挂着」——mountWidget 的过滤器
// 曾给本机一个无条件放行（理由「关掉无处恢复」在后台本机卡片出现后已不成立）。
// 改了 modules/server-monitor.js。同批升缓存名：老用户否则拿不到。
// nav-v55：后台自签开关重排（成块靠左、修嵌套 label、说明限宽两行）
// + 部署面板第 3 步按模式分开说（原文案指向一个被面板自己遮住、
// 且 push 模式下压根不存在的「检测」按钮）。
// ⚠️ 同时**补上 v1.6.8 漏升的那一级**：v50–v54 的改动都记在下面的注释里，
// 而 CACHE 一直停在 nav-v49 —— 也就是 v1.6.8 那个「自签用户命令缺
// --server-ca」的 P0 修复，老用户从服务端拿到的仍是旧 bundle。
// 改了 public/ 下的文件必须同批升缓存名，否则本地全绿、老用户拿不到修复。
// nav-v54：修一个 P0 —— 部署面板读的自签标记从未被赋值也没有 UI 可设，
// 于是自签用户拿到的命令必然缺 --server-ca；接上 agent 版本提示；
// 本机详情页与概览行显示地址。改了 app.js、server-monitor.js、admin.css。
// ⚠️ 改了 public/ 下的文件必须同批升缓存名，否则老用户继续吃旧 bundle、
// 本次修复对他们完全不生效，而本地测试是绿的、看不出这个问题。
// nav-v53：部署面板加独立的升级命令（不换 token）；重复部署前先停旧 agent。
// ⚠️ 改了 public/ 下的文件必须同批升缓存名，否则老用户继续吃旧 bundle、
// 本次修复对他们完全不生效，而本地测试是绿的、看不出这个问题。
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
const CACHE = 'nav-v65';
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

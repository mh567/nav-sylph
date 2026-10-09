// 首页性能优化：admin.css 改非阻塞加载、pinyin/qrcode 延迟加载，
// index.html 与 app.js 已变，命中缓存的老用户拿不到，必须升缓存名。
// 模块平台：新增 public/modules/server-monitor.js。它按需加载、不进首屏，
// 但仍留在预缓存清单里——延后加载的文件若不预缓存，回访用户的每次模块
// 打开都要走一次网络，与延后加载的初衷相反。
// nav-v92：筛选行改为**按渠道分组**——每个渠道一个按钮、悬停或点击展开具体订阅人，
// 视图组（全部/未读/已归档）固定不再被挤掉。改前是一条扁平 chips + 横向滚动 + 隐藏
// 滚动条，来源一多最右边的「已归档」就被推出可视区且鼠标够不着（实测 8 个来源超出
// 415px）。改了 special-line.js、styles.css。
// nav-v91：订阅时把保留窗口内的历史**回填**铺满（原来只拉最新一页，转发多的
// 账号只剩十几条原创，永远到不了一页 30 条，懒加载因此从不触发）；同步时为已入库
// 但缺作者名/译文的事件补数据；X 的昵称与 @账号始终同时显示。改了 special-line.js、
// lib/timeline/*。
// nav-v90：修筛选行被卡片压缩裁切（`.special-line-filters` 加 `flex: 0 0 auto`）；
// 卡片默认更高、分页 30 条；列表底部懒加载并在到底时提示「仅保留最近 30 天」；
// X 事件按推特样式显示头像+显示名+@handle，默认中文译文、可切「查看原文」、长文可折叠。
// 改了 special-line.js、styles.css、lib/timeline/*。
// nav-v89：X 订阅改用 FxEmbed JSON API（只填用户名、不需要凭据），每条来源可独立
// 设置监控周期（1/5/15/30/60 分钟）与启用/停止；改了 special-line.js、admin.css、
// lib/timeline/*、server.js。
// nav-v88：Special Line 顶部只留最近同步时间（去掉副标题/已同步/未读），底部去掉条数与更新时间；
// 保存弹窗改用平台 .ui-dialog-overlay（居中 + 同款遮罩，点遮罩/Esc 关闭）；标题与摘要改为选填，
// 留空由服务端抓取，抓不到就用链接当标题。改了 special-line.js、styles.css、lib/timeline/*、server.js。
// nav-v87：Special Line 菜单改走 top layer（popover）——不再被滚动容器裁剪，位置恢复「紧贴按钮」；
// 并补上外部点击与 Esc 关闭（此前只有再点 ⋯ / 点别的 ⋯ / 切筛选 / 重渲染四条关闭路径）。改了
// special-line.js、tests/timeline.test.js。
// nav-v86：Special Line 菜单加「夹取」兜底——列表很矮时上翻也会越出滚动容器顶边被裁掉，
// 而那条带正是「全部/未读/已归档」那一行（实测视口 1280×400）。越界就夹回容器内。改了
// special-line.js、tests/timeline.test.js。
// nav-v85：Special Line 菜单的抬升改为 JS 加类（is-menu-open），不再用 CSS 的 :has()
// ——不支持 :has() 的浏览器会整条忽略那条规则，短条目的菜单又被下一张事件卡盖住。改了
// special-line.js、styles.css。
// nav-v84：修复后台模块启停开关点不动——分组改版把开关宿主从 label 退回 span，
// 而输入框是 0×0 隐藏框、可见滑块与它没有关联，点滑块不触发 change。改回 label 宿主。改了 app.js。
// nav-v83：修复 Special Line 操作菜单被后续事件卡遮挡；筛选切换保留旧列表，
// 等新结果到达后再替换，快速连续切换只补拉最后条件。改了 special-line.js、styles.css。
// nav-v82：修正时间线日期与节点重叠，压缩日期栏留白。
// nav-v81：后台「模块」分区按模块分组 + 监控目标整块搬进模块文件。
// ① 每个模块一块：块头是「名称 + 说明 + 开关」，块内是它自己的配置；未启用时
//    配置收起（给「展开配置」）；平台级设置（自签证书 / 更新周期）挪到末尾单独的
//    「平台设置」块。用户原话：「监控目标应该和服务器监控和开关放在一起，订阅来源
//    管理应该和 specialline 模块名称和开关放在一起，现在逻辑混乱」。
// ② 平台侧不再有任何模块专属渲染：监控目标（服务器列表、检测、部署面板、添加/编辑
//    对话框、探测定时器）整体搬进 modules/server-monitor.js，平台只给容器与服务包
//    （api / config / saveConfig / toast / dialog / confirm / notice / requestStack /
//    refreshAdmin / refreshHome / selfSigned / version）+ 一个 onAdminSectionClose。
// ③ 模块配置写入收敛为 saveModulesConfig 一条路径（模块开关、显示隐藏、更新周期）。
// 改了 app.js、modules/server-monitor.js、modules/special-line.js、admin.css。
// nav-v80：修首屏布局判定读不到模块声明。
// 宽栏判定（要不要给时间线让出宽列）读的是模块定义里的 wideRail，而定义由模块
// 脚本执行时才注册，脚本又只有 mountModule 会加载——syncRail 排在它前面，于是
// 首屏第一次判定永远读到 undefined，时间线按普通窄卡（210px）出生，直到手动缩放
// 窗口触发第二次判定才恢复正常。改为在 syncRail 之前先 preloadModuleDefs(ids)
// （loadScript 按 src 缓存，不会重复下载）。只改了 public/app.js。
// nav-v79：布局自适应 + 窄屏纵向堆叠 + 补回底部按钮。
// ① 三列宽度（左列 / 背板 / 时间线）改由 app.js 的 railLayoutFor() 算好后写进
//    #app 的 --side-w / --board-max / --rail-w，CSS 只消费——写死的 calc + 硬阈值
//    会做出「窗口缩 1px 时间线从 420 掉到 132、再缩又跳到 190」的悬崖，而且左列
//    被压到 132px 时监控卡排版错乱。现在连续单调：rail 400→440、side 180→220。
// ② data-dock="below"（窄屏 / 两侧放不下）从横向滑条改成**纵向堆叠**
//    （grid + 卡片 min(100%,560px)），模块不再需要左右滑动才看得见。
// ③ 卡片底部按仿真补回居中的「加载更早事件」按钮 + 一行居中说明。
// ④ 容器查询的阈值按内容盒定（360）：卡片有 13px 内边距 + 1px 边框，写 400 会让
//    最窄那一档误判成窄版。改了 app.js、styles.css、modules/special-line.js。
// nav-v78：Special Line 的形态改成与仿真样例一致 —— 左侧日期轨道 + 贯穿节点线 +
// 事件卡 + chips 筛选 + 「⋯」菜单（v1.13.1 那版是紧凑列表 + 原生下拉，用户否掉了
// 「界面完全变了」）。为此给平台加了**宽栏机制**：模块可声明 wideRail，平台据此让
// 背板让位（#app[data-rail="wide"]：右侧固定 420px、背板 max-width calc(100%-592px)、
// 左侧按剩余空间给 132～220），让位发生在判停靠**之前**（sideDockAvailable 读的是
// 背板实际宽度）。模块的两套版式由**容器查询**按卡片宽度切换，与视口无关。
// 另：v1.13.1 里那条「卡片必须自成一个包含块」保留（below 停靠下的 .sr-only
// 溢出会把整个文档撑宽）。改了 app.js、modules/special-line.js、styles.css。
// nav-v77：Special Line 改为**内联**在首页右侧那一列里显示（v1.13.0 是「摘要卡 +
// 点开弹窗」，用户否掉了那个形态）。去掉 .module-overlay 面板，卡片本身即时间线。
// 另修：样式里引用了本仓库不存在的 --danger / --warning / --success 三个 token，
// 会静默丢掉那些声明；改用自带的 --sl-danger / --sl-warning。
// nav-v76：新增「Special Line」时间线模块（public/modules/special-line.js）——
// 社交订阅与稍后阅读汇成一条时间线，启用后默认停靠在首页右侧空白区、位置可拖。
// 同时给平台加了两个通用能力：模块定义可声明 defaultSide（无已保存布局时按它
// 停靠，用户拖过之后以保存的位置为准），模块可挂自己的后台区块
// （renderAdminSection）。后端新增 v5 迁移与 /api/timeline/* 路由。
// 改了 app.js、styles.css、admin.css、server.js、lib/db.js、lib/timeline/*。
// nav-v75：后台「远程备份」区块两件事。①修「第二次打开管理面板后展开该区块
// 一直停在『加载中...』」——判据从「配置是否已加载」改成「是否已渲染进当前
// 这块 DOM」（面板每次重建 DOM 都会产生新的 #webdavSection，而配置还在
// 内存里，旧判据于是跳过加载、没人把它画出来）。②新增「自动同步」开关：
// 配置 / 书签 / 模块设置变更后自动备份一次，写在固定槽位，不占用手动备份的
// 5 份历史。改了 app.js、admin.css、server.js、lib/webdav-backup.js。
// nav-v74：模块轮询接口（GET /api/modules/metrics、GET /api/memos）不再与
// 管理操作共用 30 次/分钟的限流桶——轮询按标签页数线性增长，正常刷几次页面
// 就能把桶打满，表现为「模块区渲染不出来」+「监控数据读取失败」两种听起来
// 无关的症状。改走 modulePollLimit（120/分钟，按轮询周期推导）；备忘录的写
// 操作仍走原桶。客户端把 429 与「读取失败」分开说，不再混成一句。
// 改了 server.js、app.js、modules/server-monitor.js。
// nav-v73：拉取模式的卡片右下角不再显示单次请求耗时（`Nms`）——那个数含
// agent 固定 200ms 的 CPU 采样等待，读起来像网络延迟。改为与推送模式同一句
// 「最后更新 N 分钟前」：推送取机器上报时刻，拉取取本服务取到它的时刻。
// 本机卡片不发这一行（产品取舍：它就是你在用的那台机器）。
// 改了 modules/server-monitor.js；styles.css 只动了一句注释。
// nav-v72：备忘录卡片的状态胶囊从「独占正文第一行」挪进**卡片头**
// （标题右侧），「管理」因此从头里下移到右下角那行小字——最窄的一档卡片
// （132px）装不下「标题 + 胶囊 + 管理」，标题会被截断；省下的那一行还给内容。
// 自动轮询不再进「同步中」态（只有手动同步/重试才转圈）：实测未变动的
// 一轮从 +15 次 DOM 变更 / +4 次强制重排降到 +0 / +0。模块区**首次出现**时
// 加一次淡入上浮（260ms，只动 opacity/transform）。改了 app.js、styles.css、
// modules/memo.js。
// nav-v71：模块加载与轮询开销优化——① 模块脚本**并行**下载（此前串行，
// 第二个模块要等第一个的脚本下载与挂载都完成）；② 模块区等**首轮数据**
// 到手再首次布局，卡片出现即终态（此前数据落地会把下面的卡片整体下推，
// 实测 54px 加一次过渡）；③ 卡片按内容指纹跳过重建、同一帧内多次纵向
// 重排合并成一次。改了 app.js、modules/server-monitor.js、modules/memo.js。
// nav-v70：模块卡片拖拽的落点修正——未登记布局的卡片要在松手时补条目，
// 否则把一张卡拖到最后一个位置会弹回；并调细备忘录面板的观感
// （输入框改下沉材质、按钮回到 35px/12px）。改了 app.js、styles.css。
// nav-v69：新增「备忘录」模块（public/modules/memo.js）。登录后才
// 加载，但与 server-monitor 同理留在预缓存清单里——否则回访用户
// 首次打开模块区要等一次网络。改了 app.js、sw.js、styles.css，
// 新增 modules/memo.js。
// nav-v68：模块区首次挂载不再「四张卡叠成一叠再各自滑开」——卡片是带着
// margin-top:0 出生的，.module-widget 上的让位过渡把它当成一次真实位移。
// 首帧布局加 .is-laying-out 关掉这一次的过渡（之后的让位动画保留）。
// 改了 app.js、styles.css。
// nav-v67：升级命令的面板说明改口——agent 的 upgrade 现在自己重启服务，
// 不再要求用户手动 systemctl restart（用户照做后后台仍催升级的那个 bug）。
// 改了 app.js。
// nav-v66：外观按钮的三处修正——编辑态下切换先确认（不再连带提交未保存的
// 布局草稿）、localStorage 写不进去时给提示并做内存兜底、applyTheme 提到
// server-flags 之前少闪一帧。改了 app.js。
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
const CACHE = 'nav-v92';
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
    '/modules/memo.js',
    '/modules/special-line.js',
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

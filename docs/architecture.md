# Nav Sylph 架构与开发背景

更新日期：2026-09-28。本文描述当前仓库代码。开始新任务时，应核对实际代码与版本。

## 产品方向

Nav Sylph 是个人导航和书签页面，面向公网访问的首页应保持简洁、无需登录即可使用、加载迅速。管理操作和私人数据需要受保护。今后扩展网址、服务、主机、监控或订阅时，优先围绕同一资产组织信息，避免首页堆积彼此分离的模块。现有仓库尚未实现统一资产模型，这一段是后续设计约束。

用户主要在国内访问海外部署的服务器。页面运行时资源由本服务提供。用户主动点击的搜索、书签和 WebDAV 地址属于外部目标，不属于页面运行时依赖。

## 当前结构

| 位置 | 职责 |
| --- | --- |
| `server.js` | Express 服务、静态资源、配置与收藏接口、管理密码、分享页面和 WebDAV 接口 |
| `server-config/` | 服务配置默认值、文件与环境变量的加载及校验 |
| `public/index.html`、`public/app.js` | 首页结构、搜索、收藏、管理界面及浏览器状态；管理密码存在时按需取回完整配置与收藏 |
| `public/styles.css`、`public/admin.css` | 首页与管理界面样式。`admin.css` 经 `media="print" onload` 非阻塞加载（首屏渲染不等它）——它不止样式化管理面板，还样式化站内对话框 `showUiDialog()` 与错误 toast（见 :145），故必须在用户交互前就位、不能按需加载；`.search.paste-mode`（分享编辑器）只在该文件「Paste 分享模式」区块定义一处，勿在尾段的新版样式区块重复声明 |
| `public/sw.js` | 同源静态资源白名单缓存；动态接口和分享页不在缓存范围内 |
| `public/lib/` | 本地提供的搜索、拼音、二维码（`qrcode.js`）与代码高亮（`highlight.min.js`）脚本；高亮仅供分享接收页按需加载；拼音（收藏加载时）与二维码（首次分享时）经 `app.js` 的 `loadScript` 延迟加载，仍列入 sw.js 的 `ASSETS` 预缓存（离线可用） |
| `lib/webdav-backup.js` | WebDAV 配置加密、备份、恢复和校验 |
| `lib/session.js` | 管理端会话：设备指纹加权、地理绑定、Cookie 读写 |
| `lib/geo/` | ip2region 离线 IP 归属库（仅 IPv4）与其只读解析器 |
| `sylph.sh`、`scripts/release.sh` | 安装管理与版本发布脚本 |
| `tests/` | 备份隐私、移动收藏、对话框、接口数据边界和服务生命周期回归测试 |

服务使用 Node.js、Express 和原生浏览器代码。`package.json` 的 `start` 命令运行 `server.js`，`dev` 命令使用 nodemon。测试目前通过 `node --test tests/*.test.js` 运行。

## 数据与请求路径

`server-config/index.js` 合并默认配置、可选的 `server-config.json`、`.env` 和环境变量。首页在 `public/index.html` 中提前请求 `/api/config`（`cache: 'no-cache'`，服务端回 `Cache-Control: no-cache` + ETag）：浏览器缓存配置但每次用 ETag 校验，未变时服务端返 304（零响应体），既省去首屏往返的传输量，又保证配置始终最新——配置按认证态生成不同表示（公开视图不含 `privacyMode`），ETag 随之不同，登录态变化必得新 200，不会拿到旧的完整配置。`public/app.js` 复用该请求，渲染首页后再加载收藏及版本信息。服务端使用 compression 处理中等及较大的可压缩响应。Service Worker 仅缓存列出的同源静态资源。

运行时的 `config.json` 保存页面设置和分类，`favorites.json` 保存收藏，`.admin-password.json` 保存管理密码哈希，`.webdav-config.json` 保存 WebDAV 配置。这些文件由 `.gitignore` 排除，不能作为跨工具交接附件提交。书签 HTML 的 `DATA-SYLPH-PRIVATE` 标记承载 Sylph 私密属性；修改导出、解析、恢复或备份版本时，应完整检查往返路径。

`GET /api/config` 和 `GET /api/favorites` 在没有管理密码时返回公开视图，只含首页需要渲染的部分：收藏过滤掉 `private` 条目并剥离 `private` 字段本身，配置剔除 `privacyMode`。带上正确的 `X-Admin-Password` 时才返回完整数据，供管理面板和私密检索使用。写入路径相应地按 id 合并而不是整份覆盖：`POST /api/favorites` 中既有的私密条目在请求体缺席时保留，`POST /api/config` 以现有文件为基底合并，因此公开视图未携带的 `privacyMode` 不会被保存动作抹掉。浏览器中的私密收藏筛选只是显示逻辑，服务端不再依赖它承担隔离职责。新增私有资产字段时，应先确认它是否应当进入公开视图。

管理端登录采用服务端会话：登录成功后签发 32 字节 CSPRNG 令牌（OWASP 要求 ≥128 位），用 `HttpOnly` Cookie 下发，会话存于进程内 `Map`，重启即失效。浏览器不再保存明文密码——`X-Admin-Password` 只在登录那一次请求里出现，密码验证通过后改由 Cookie 承载；该头作为兜底保留，已打开的旧页面仍可用。

`lib/session.js` 负责设备绑定与 Cookie 读写。要点：

- **指纹用加权部分匹配，不用整体哈希。** 逐字段比对七个请求头信号（UA、`Sec-CH-UA-Platform`、`-Mobile`、`-Platform-Version`、`-Arch`、`-Bitness`、`Accept-Language`），权重 2/3/2/4/1/1/1。整体哈希无法回答「只是语言变了还是设备换了」，且任一字段变动即 100% 不匹配。
- **判定用一致**比例**，阈值 0.7，权重不构成总分。** 权重只用于给字段排序，算法是 `一致权重 / 可比权重`——不存在「满分 14」这个分母，`FP_TOTAL` 仅供权重自洽性断言使用。若改用绝对分阈值（如 10/14），Firefox 与 Safari 会被永久挡在门外：它们完全不实现 UA Client Hints，可比的只剩 UA(2)+语言(1)=3 分，无论是否同一台设备都达不到 10。**「缺失即跳过」只解决扣分，解决不了基准偏高**，两者必须一起改。比例判据下这类浏览器的一致率是 1.0；一个可比字段都没有时同样返回 1（无法判定 ≠ 检测到变化）。
- **低熵 Client Hints 默认发送**，高熵的三个需 `Accept-CH` 协商，且**仅在 HTTPS 下发送**。`Accept-CH` 是持久化偏好，故只在下发会话相关响应（`/api/session`、登录、信任设备）时带上，不放静态资源与 `/api/config` 上。代价：首个会话请求拿不到高熵头，要等下一次请求补齐，此刻绑定较弱但仍可用。
- **地理位置是独立判据，不并入加权分。** 地理是位置信号而非设备信号：同城两台设备地理完全相同，一台设备换城市则地理变。两者混在一个分数里会让动作无法决策（掉分了是降级还是登出？）。地理变化或设备分不达标 → **自动登出**，响应带 `code: 'env_changed'`，前端在页面底部弹一次提示条幅。
- **地理库为 vendored 的 ip2region xdb**（`lib/geo/ip2region_v4.xdb`，10.6 MiB，双许可 Apache-2.0 OR MIT，见 `lib/geo/LICENSE.ip2region.txt`），只读、不调任何在线归属服务。格式与查找实现参照上游 `binding/golang/xdb`：小端、向量索引项为绝对文件偏移、段内 IP 需反转后比较。
  - **数据出处**：取自上游 `master` 分支 `data/ip2region_v4.xdb`（blob SHA `c3d5915c69816dd3474943f0c826dcc2fd9aa562`，11,122,036 字节，`git hash-object` 校验一致）。上游 README 说明其自带的 IP 段数据为**不定期更新**的快照，来源是 ip2region 社区提供的数据、`[数据源补充]` 标签的 Issue 补充及其他合法合规来源；对精度和更新频率要求高的场景，上游建议购买社区的商用离线数据。**因此该库是快照而非实时数据**，新分配或未收录的 IP 段会查不到——这正是「查不到即跳过该判据」而非「判为环境变化」的原因。
  - **字段格式** `国家|省份|城市|ISP|国家二字码`；中国境内全中文，境外全英文。上游 `data/README_zh.md` 记录了命名规则（自治区用简称、特别行政区用长称、直辖市带「市」、自治地区带「地区」），本项目按省/市两级取值，命名细节未作二次加工。
  - **只随附 IPv4 库**（IPv6 库 35.6 MiB 不值得为此买单），IPv6 走「跳过该判据」分支。默认按**省级**比对——移动基站在相邻城市间漂移，市级会频繁误报自动登出；`security.geoScope` 可切 `'city'` 或 `'off'`。库缺失、IPv6、私网地址一律返回 `null` 并跳过该判据。
- **指纹只用于降权，绝不用于提权。** OWASP 明确这些属性可被伪造（可改 UA、可与受害者共用 NAT 出口）。真正的护栏是令牌本身不可猜 + HttpOnly + Secure + 过期。局限须如实告知：浏览器升级、换系统、跨省移动网络都会触发一次自动登出。
- **Cookie 不加 `__Host-` 前缀。** OWASP 推荐该前缀，但它强制要求 `Secure`；本项目支持本地 http 调试（`HTTPS_ENABLED=false`），前缀 + 无 `Secure` 会被浏览器直接拒收，登录态静默失效。改用普通名称 + `security.cookieSecure` 配置项。
- **`Secure` 的判据不是 `req.secure`。** 标准部署由 nginx 终止 TLS，Node 收到明文 HTTP，`req.secure` 恒为 `false`；照此判断会让 http 部署的 Cookie 永不落盘（表现为「密码正确但一直未登录」）。实际判据是读反代回填的 `X-Forwarded-Proto`（`DEPLOYMENT.md:140` 的 `proxy_set_header`），已开 `trust proxy = 1` 保证该头可信，再与 `security.cookieSecure` 取与——**纯 http 部署自动省略 `Secure`，无需手工配置**，该配置项只在需要覆盖自动判断时使用。
- **清除 Cookie 时必须沿用下发时的属性**（`HttpOnly`/`SameSite`/`Path`），否则浏览器会当成另一个 Cookie 留着。同名 `Set-Cookie` 只保留一条，避免「当前有效期」需要靠猜。
- 登出响应带 `Clear-Site-Data: "cookies"`，**只清 cookies 不清 cache**——清 cache 会连带清掉用户刚存的配置缓存。

`X-Admin-Password` 兜底通道仍在，因此上述改动没有关闭明文密码通道，只是让常规路径不再经过它。彻底移除前需确认没有旧客户端在用。

## 登录防爆破

管理端**没有账户体系，只有一个管理密码**（`.admin-password.json`）。因此没有「锁账号、
输密码解锁」这条路，能做的只有**锁来源**与**封总量**。按设备维护黑名单在此不成立：
攻击者换 IP 的成本远低于维护一份黑名单的成本，而真正的护栏是令牌本身与 bcrypt 的
总计算量上限。`POST /api/verify-password` 依次过三层：

| 层 | 中间件 | 作用 |
| --- | --- | --- |
| 1 | `rateLimit` | 每 IP 30 次/分钟的历史值，保留 |
| 2 | `loginGuard` | 同一 IP 连续 10 次密码**错误** → 锁该 IP 30 分钟，锁定期内直接 429 且**不跑 bcrypt** |
| 3 | `globalLoginLimit` | 全站 30 次/分钟，key 为固定字符串、不按 IP |

**两个必须记住的约束**（均由实测踩出，见 `tests/login-guard.test.js`）：

- **失败计数由密码校验结果回写**（`notePasswordResult`），不是按请求到达计。只看请求
  到达的话，一次成功登录也会消耗配额；而真正的爆破恰好只打这一个接口。
  密码正确时一律清零，否则「成功一次后再错 9 次」会把自己锁住。
- **总量阈值必须高于单 IP 锁定阈值，且锁定层排在总量层之前**。两者都设 10 时总量桶
  会先触发：连错 10 次拿不到「已锁定」，第 11 次只得到「稍后再试」——锁定功能形同
  虚设，而且「换一台设备登录」也会被总量桶挡下，那正是全局桶唯一的代价，
  不该由正常用户先吃到。

第 2 层是主力：每个 IP 最多消耗 10 次 bcrypt，之后边际成本趋近于零，堆再多 IP 也只是
攻击者自己更慢。第 3 层是兜底，只拦「大量 IP 各试一次、不触发锁定」的打法；
代价是打满时**你也会被挡一分钟**——封顶总量的必然代价，纯应用层无法消除。

客户端必须区分「密码错误」「已锁定（带剩余秒数）」「总量封顶」三种提示。本项目没有解锁
入口，若一律提示「密码错误」，你只会反复输、把锁定越推越深。

`/api/session` 已从 `rateLimit` 改到 `publicReadLimit`：它每次首屏都调，不该挤占登录配额。
锁定与总量两个 Map 都挂在既有的 60 秒清扫定时器上，不会随访问量无限增长。

`server.js` 设置 `app.set('trust proxy', 1)`，限流与日志据此使用 `req.ip` 取真实客户端地址。跳数 `1` 表示只信任最右侧一跳——该跳正是 nginx 用 `proxy_add_x_forwarded_for` 追加 `$remote_addr` 的位置，客户端自带的 `X-Forwarded-For` 会因截断而被丢弃。

**这里的前提是端口不对外暴露，而不是取值本身。** 实测（socket 直连 + `app.set('trust proxy', 1)`）：`X-Forwarded-For: 9.9.9.9, 8.8.8.8, 7.7.7.7` 得到的 `req.ip` 是 `7.7.7.7`（最右），而最右恰是客户端能自己写的那一跳——把同一前缀的最右 entry 逐次改掉即可为每次请求换一个限流桶，实测可无限轮换。`true` 在同一场景下取最左，反而不受追加影响，但一旦真有反代在前面，其语义又会翻转。因此**两种取值都不能替代网络层隔离**：部署时必须让 Node 只监听回环地址并经反代对外暴露；一旦能直连服务端口，限流即退化为可绕过的计数。

## 跨设备文本分享

分享内容在浏览器内用分享码派生 AES-GCM 密钥加密，服务端只存密文。`POST /api/p` 的 `ttl` 只接受白名单档位（5/30/1440/10080 分钟），缺失或非法值回落到 5 分钟；不放开任意时长，因为 `expiresAt` 决定条目在进程内 `Map` 中的驻留周期。存储仍是进程内 `Map`，重启即丢失，因此 7 天档并不等于数据能存活 7 天。

滥用防护分三层，缺一不可：取码（`/api/p/code`）、创建（`POST /api/p`）与读取各自独立计数，创建入口必须单独限流，否则可绕开取码接口自造分享码直接创建。限流 Map 由 60 秒定时器按窗口清理，开启 `trust proxy` 后 key 数量等于访问者数量，不清理会变成内存放大器。除按 IP 限流外还有全局容量上限（条数与字节双阈值），用于兜底多个 IP 协同堆内存的情况；容量满时返回 503 而非驱逐最旧条目，避免静默丢弃他人仍在有效期内的分享。

分享接收页 `/p/:code` 是服务端独立渲染的整页，运行时资源由本站提供。代码渲染先走高精度正则签名判定语言，再由 highlight.js 兜底自动识别：分享多为短片段，`highlightAuto` 的 relevance 在短文本上区分度不足，直接使用会把 Python 片段误判为 CSS。含中文的内容按纯文本处理，不做高亮。识别失败或 `hljs` 未加载时回退为原文 `textContent`。高亮产物由 highlight.js 自身转义后才写入 `innerHTML`；修改此处渲染逻辑时必须复核这一前提。

分享编辑器在首页搜索框内完成。触发字符仍是 `>`（或全角 `》`），编辑区为 `<textarea>`——单行 `<input>` 在 HTML 规范上无法换行，也撑不开多行内容。搜索态保持单行（`min-height: 44px`，不写 inline height；44px 同时是触摸目标下限，同排的三个按钮同为 44px）；分享态下 `min-height: 96px` 起、`max-height: 60vh` 封顶。JS 的 `autoGrowPasteInput()` 在 `input` 事件中按 `scrollHeight` 写入 inline height 使其随内容增删同步伸缩并 clamp 到上限；进入分享态的首帧不测量，此时由 `min-height` 兜底。用户拖动右下角把手后置 `pasteUserResized`，此后不再自动跟随。回车发送、`Shift`/`Ctrl`/`Cmd`+回车换行，Esc 或左侧「退出」按钮返回搜索态（移动端无 Esc 键，退出按钮是主路径；两条路径共用 `exitPasteMode()`，复位逻辑只此一处）。搜索引擎按钮在分享态由 `.search.paste-mode #engineBtn` 隐藏，不用内联 `display`，否则无法参与过渡且会盖过样式表。

搜索栏三个按钮共用一套拟物结构，只在色相与明度上分层：`--mode-hue`（网页/收藏，青灰）、`--engine-hue`（引擎，琥珀）、`--submit-hue`（搜索，陶土）。各自的 `--HUE` 是底色、光感与按压阴影的唯一来源（`styles.css:2726`），因此三者共享同一条光感规则而不会走样。三个锚点必须在 `:root`、`@media (prefers-color-scheme: dark)`、`:root[data-theme="dark"]` 三处各定义一次（`styles.css:2590`/`2636`/`2689`），漏掉任一处则手动深色与系统深色表现分叉——`tests/homepage-material.test.js` 断言了三处计数与深色块的逐字一致。

按压语义分两级，不可混用同一视觉语言。**点击凹陷**是 `inset 0 4px 9px`（`--ctl-press-shadow`，过渡 28ms），比书签的 `inset 0 3px 6px` 更深更快；**模式按钮的选中态**（`[aria-pressed="true"]`，`styles.css:2745`）刻意做成「点亮」——外投影 + 更实的底色，不含整段 inset。若选中态也用 inset 阴影，用户无法区分「已切换到收藏」与「正在按下」。实心陶土按钮的凹陷另需加深填充才能读出效果，实心深底会盖住 inset 阴影。

三个按钮的**高度统一为 44px**（`--ctl-h`），与仿真的 40px 有意不同：44px 是触摸目标下限，改回 40px 等于重新引入此前列为 P1 的缺陷。

凹陷之外还要给**按键行程**：`:active` 用 `translateY(2px) scale(.985)`，只靠内阴影的「凹陷」读起来像贴纸在变暗，按钮并没有离开原平面；2px 行程加上轻微缩放才有按键被按下去的实感。缩放幅度受两条约束——须落在 `[.98, 1)`，且 `44 × scale ≥ 40`，否则会吃掉触摸目标。**按下时整条替换 `box-shadow`、不留悬停那层外投影**：按钮已经离开平面，外投影会与位移打架，让「沉下去」的读数变浑。

**浮起感来自外投影，不是内阴影，更不是色相。** 深色下手感正确、浅色下读不出来，根因是**机制缺失**而非配色：深色常态就带 `--shadow`、悬停换成 `--shadow-lg`，抬升时有真实影子跟着长；浅色此前常态完全没有外投影，悬停那层灰棕影（`rgba(67,51,39,.06/.09)`）在米色底上几乎不可见，按钮抬了 -1px 却看不到影子，等于白抬。

因此浅色侧做了三处收敛，使两套主题共用同一套机制：

- `--shadow` / `--shadow-lg` 在浅色下取中间强度（`rgba(60,45,32,.11)` 起 / `.10 .15`），比旧值（`rgba(0,0,0,.06/.1)`）强、但比深色（`.3/.5`）弱。米色底比深色亮，需要更强的黑才读得出，到深色那档则会让浅色发脏。
- 书签与搜索栏三按钮的常态、悬停都改为引用这两个 token，不再各写各的淡影。
- `--bookmark-lift` 浅色由 `-1px` 改为 `-2px`，与深色一致。

`tests/homepage-material.test.js` 断言「浅色必须带外投影」「三处 `--bookmark-lift` 必须一致」，防止这些投影日后被当成冗余删掉——它们正是平面感的唯一来源。

两个只在按下瞬间才暴露的坑，都靠真实指针驱动才测出来（`getComputedStyle` 在非按下状态读不到）：

- **`:active` 必须显式写 `border-color`**。指针按下时仍停在按钮上，`:hover` 依然命中；实心按钮若不在 `:active` 里重写描边色，悬停时的浅色边会留在深色实心底上，凹陷读不出来。
- **`.engine-arrow` 是引擎按钮可点开的唯一视觉线索**。它曾整块丢失：标记里没有 `<svg>`，而旧样式还留着两条 `.engine-arrow` 规则，样式落在一个不存在的元素上成为死代码。现在的定义只在材质层一处，旧的那条 `.search-engine.active .engine-arrow` 已删除——**不是因为不命中**（`app.js` 确实会设 `.active` 类），而是同一状态有 `.active` 与 `aria-expanded` 两个钩子，保留两条规则会各自旋转一次；统一只认语义化的 `[aria-expanded="true"]`。副作用：`engineBtn` 上的 `.active` 类目前没有 CSS 消费者。

首页顶部不再有站点标识。快捷键说明行（`.search-caption`）是桌面专属的提示，`≤600px` 隐藏。内容只讲两个**触发符**——`/` 查收藏、`>` 分享文本；方向键选择与 Enter 打开属于次要操作，留给「说明」弹窗，不在这行挤占注意力。间距由说明行自己给（`margin: 10px 0 26px`：贴搜索框、与下方收藏区拉开），`.header` 的 `margin-bottom` 因此归零，`≤600px` 该行隐藏时再把间距还给 `.header`。它的**基础规则必须排在 `≤600px` 块之前**，否则同特异性下后写的 `display:flex` 会把块里的 `display:none` 压掉，表现为手机上说明行照样显示。

宽屏背板（`.backboard`）把搜索区与收藏网格收进一块 936px 的居中玻璃面，边缘发丝线复用分类分割线那套 `--divider-rgb` 渐变语法。它只在 `≥1024px` 生效：`≤1023px` 的兜底把宽、圆角、内边距、背景、投影、模糊全部清零，两个伪元素 `display:none`，等于退回改动前的布局。该兜底块只能有一条——两条以上时后写的会静默覆盖前一条。

**悬浮光感必须是双层**：中性白高光（`--glint-white`）压在一层色相光晕（`--glint` / `--search-glint`）之上，`.search::after` 与 `.bookmark::before` 同构。缺了白色那层，两层色相光晕叠在一起偏灰发糊——这是「说不上哪里不精致」的主要来源，只能靠数值钉住。`--glint-white` 与另两个变量一样，必须在三处主题块各定义一次。

书签的尺寸（96×42、`min-height` 42px、圆角 7px）由「尺寸维持现状」这条需求钉死，不可为了追仿真而改动。**光晕强度 `--bookmark-glow-opacity: .32` 不可上调**：仿真用双层颜色（`--glint-white` + `--glint`）本身就是 `.32`，把它提到 `.46` 来补观感是方向反了——该换的是颜色而不是透明度。深色维持 `.8`，深色背景上再加强会过曝。

引擎下拉（`.engine-dropdown`）在几何上对齐到引擎按钮左缘（`left: 58px` = 1px 表单边框 + 5px 内边距 + 48px 模式按钮 + 4px 间距；模式按钮三个标签都是两字，`min-width: 48px` 稳定生效），`≤370px` 另有独立偏移。它**不带开合动画**，材质与收藏下拉是两套（圆角 10 vs 13、阴影不同），因此两条规则分开写、不合并。选中项用主色文字加粗表示，**不铺底色**——底色留给 `:hover`，两者若都用底色就分不清「当前引擎」和「鼠标停在这项」；这里的 `background: transparent` 必须显式写，否则旧样式那条同特异性的 `.engine-option.active { background: var(--bg-hover) }` 会留一层米色底把信号淹掉。

**展开态只有一个真相来源**：`aria-expanded`。此前 JS 还并行 `toggle` 一个 `.active` 类，而 `.search-engine.active` 的 CSS 规则已删，类名成了无消费者的死状态，两个真相来源会各自驱动。`app.js` 里那四处 `engineBtn.classList` 已全部移除。

**宽屏下的纵向节奏**（1280×800 实测）：背板顶距视口 35px，背板上内边距 48px，搜索框顶 83px，说明行在其下 10px，首个分类再下 26px。仿真里搜索框顶同样在 83px——它靠一个 `min-height: 4px` + `margin-bottom: 20px` 的 `.topbar` 占位元素（放主题切换按钮用）加 24px 内边距叠出来，本项目删站点标识时连它一起删了，这里用 `padding-top: 48px` 单值等效还原。两段留白叠起来比一段更透气，这是观感差异的真正来源。**若日后要再加大距离，继续加 `padding-top` 即可，不必恢复 `.topbar` 占位元素。** 窄屏兜底会把它清零。

搜索框自身的顶边 1px 受光高光走 `::before`（`::after` 已被光感占用），左右各内缩 11px。仿真有这条、移植时曾整块漏掉；背板加上内距后，框顶与背板顶拉开 20px，框若没有这道亮边会在这道缝里显得缺一条受光边。

**触屏点按必须关掉 UA 蓝色高亮。** iOS Safari 与移动 Chrome 的 `-webkit-tap-highlight-color` 默认是 `rgba(51,181,229,.4)`，那抹蓝会盖在暖灰拟物材质上，与整套色调冲突。兜底写在 `@media (hover: none) and (pointer: coarse)` 里，覆盖搜索栏三个按钮、书签、引擎选项与右下角 dock。**它不影响键盘可达性**——材质层那条统一的 `:focus-visible` 轮廓（`outline: 2px solid var(--focus)`）只在键盘导航时出现，正是该给提示的时候。旧样式区另有一份同样用途的规则（针对 `.fav-item`/`.btn`），两者并存不冲突，但新增可点元素时别忘了新块。

站内对话框统一走 `showUiDialog()`，样式定义在 `admin.css`（而非 `styles.css`——`admin.css` 后加载，同特异性时胜出）。它有三条平行的选项入口，渲染时必须保持顺序一致：平铺的 `options`、带标题的 `groups`（其 `options` 渲染进 `.ui-dialog-options` 网格，用于 2×2 排布），以及由某选项 `reveal: true` 触发的内联展开区（如 PIN 输入框）。展开区紧跟触发它的选项渲染，**不放在所有选项之后**——那是 DOM 顺序，CSS 改不动。取值、焦点流转与「是否返回 payload」三处都读合并后的 `allOptions`（`options` 在前、`groups` 在后），漏改任一处都会让分组内的选项静默取不到值。新增选项入口时把这三处一并更新。

`vh` 与 `dvh` 都不跟随软键盘收缩，只有 `visualViewport` 能反映键盘弹出后的真实可视高度；`.ui-dialog` 与分享编辑器当前仍按 `dvh` 定高，键盘弹出时可能被顶出视口，这一点尚未处理。

**原生 `<select>` 展开后的列表由 UA 绘制，应用层控制不了，只能靠 `option` 的 `background-color` 上色。** 收起的下拉框由 `admin.css` 那条 `background: linear-gradient(...)` 撑着，看起来一直正常；`option` 此前完全透明（`rgba(0,0,0,0)`），于是展开后回落到 UA 默认的白画布，深色下文字看不清。修法是新增 `--admin-field-canvas`（浅色引用既有 `--control-top`，深色 `#2a2521`），**必须在 `:root`、`@media (prefers-color-scheme: dark)`、`:root[data-theme="dark"]` 三处各定义一次**，与本文件 `:51`、`:78` 记的同类 token 规矩一致。规则写成 `:is(.modal, .fav-dialog, .ui-dialog) select option`，一处覆盖全部三个下拉框（管理面板两个 + 收藏弹窗的 `favCategorySelect`），不必逐个再写。

**`background` 简写会把 `background-color` 重置为 `transparent`，因此不透明底色必须写在 `background:` 之后。** 顺序反了底色当场失效且不报错，深色下又变回白底；浏览器实测两种顺序读回分别是 `rgba(0,0,0,0)` 与 `rgb(42,37,33)`。`tests/homepage-material.test.js` 断言了这个相对顺序——只断言「有这条声明」会被同特异性的另一种写法蒙过去。

进入管理页的 `openAdmin()` 里，全量收藏与 `privacyMode` 两个请求互不依赖，必须放进同一个 `Promise.all` 并发发出：服务端每个带密码的请求都要跑一次 `bcrypt.compare`（实测各约 55ms，不带密码约 1ms），串行等待等于把两次叠加成约 130ms。**`loadPrivacyMode()` 不能删**——`defaultConfig` 里没有 `privacyMode` 键只说明它有默认值（`migrateConfig` 填 `false`），用户在管理面板保存过一次后该键就会写入 `config.json` 并正常往返；删掉请求会让已开启隐私模式的用户丢失该状态。

## 开发与验收边界

保持现有 Node.js、Express 和原生前端结构，先依据目标服务器及设备的实际数据优化首屏、搜索和管理加载。现有本地文件体积、压缩估算和静态检查不能替代真实网络或移动端性能测量。

界面设计历史见 `docs/sylph-unified-interface-plan.md`。该文件包含当时的阶段状态，当前发布与验收状态以 `docs/current-work.md`、Git 和实际环境为准。部署方法见 `README.md` 与 `DEPLOYMENT.md`。

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
| `lib/session.js` | 管理端会话：设备指纹加权、地理绑定、Cookie 读写；存储后端可注入（缺省内存） |
| `lib/session-sqlite.js` | 会话的 SQLite 存储后端（实现 SessionStore 的 6 方法接口） |
| `lib/db.js` | SQLite 连接、PRAGMA 与 `user_version` 迁移；驱动只在此文件出现 |
| `lib/geo/` | ip2region 离线 IP 归属库（仅 IPv4）与其只读解析器 |
| `lib/monitor.js` | 监控采集：本机读 `os`，远端读 agent（`node:https` + 证书 PEM 作 `ca`），`probeTcp` 三态探测 |
| `lib/credentials.js` | 凭据加密（AES-256-GCM），WebDAV 密码、agent token、推送凭据共用 |
| `agent/` | 部署在**被监控目标机**上的只读采集程序。**Go 静态二进制，零第三方依赖**（`go.mod` 无 `require`）：`main.go`（协议、HTTPS、注册、推送、`upgrade`）+ 平台桩（`mem_darwin.go` / `mem_other.go` / `readcpu_darwin.go` / `readcpu_other.go` / `disk_other.go` / `disk_unsupported.go`）、`install.sh`（一键 `curl \| bash`）、`README.md` |
| `scripts/build-agent.sh` | agent 交叉编译（linux/amd64、linux/arm64、linux/armv7）+ ELF 自检 |
| `public/modules/` | 登录后才按需加载的模块脚本，每个模块一个文件（当前 `server-monitor.js`） |
| `sylph.sh`、`scripts/release.sh` | 安装管理与版本发布脚本（后者会先构建 agent 产物） |
| `tests/` | 备份隐私、移动收藏、对话框、接口数据边界、模块平台和服务生命周期回归测试 |

服务使用 Node.js、Express 和原生浏览器代码。`package.json` 的 `start` 命令运行 `server.js`，`dev` 命令使用 nodemon。测试目前通过 `node --test tests/*.test.js` 运行。

## 登录后模块平台

首页与后台都要承载一批「登录后才可见」的模块（服务器监控、社交媒体、行情、稍后阅读、文件分享）。平台骨架已落地，四个业务模块尚未实现。

**模块代码独立成文件，按需加载。** `public/app.js` 里的 `App.KNOWN_MODULES` 是 id 白名单，`registerModule()` 收定义，`loadModule(id)` 复用既有的 `loadScript()`（`/modules/<id>.js`）。**未在白名单里的 id 一律拒绝加载**——这些 id 会被拼进脚本路径，不是校验就等于任意路径可被请求。未登录访客不下载任何模块文件，首屏重量不受模块数量影响。

**模块配置独立存 `.modules.json`，不进 `config.json`。** 两个理由，都是绕开而非修补：`toPublicConfig()` 只剥离 `privacyMode` 一个 key，放进 `config.json` 的任何新字段会**默认公开下发**给匿名用户；`mergeConfig()` 是顶层浅合并，嵌套对象会被客户端旧副本整块覆盖。该文件已在 `PRIVATE_FILES` 名单里，自动获得 `writeJSON()` 的 0600 收紧。

**归一化不得补默认值。** `normalizeModulesConfig()` 对缺席的键保持 `undefined`（而非空数组），`mergeModulesConfig()` 才能区分「显式清空」与「没提交」。拖拽排序只提交 `widgets`；若归一化补了空数组，一次排序就会清空 `servers` 与 `symbols`。这条是真实服务端到端才发现的——单元测试当时直接调 `merge` 绕过了归一化，于是恒绿。

**首页模块区在分类网格之后**（首屏视觉重心留给搜索框与收藏），未登录时 `hidden` 且不发起任何模块请求。显隐有三个钩子必须齐全：`restoreSession()` 成功分支、`#logoutBtn` 处理器、`API.notifyEnvChanged()`（环境变化自动登出）——少一个就会出现「登出后入口还亮着」。

**编辑模式是显式开关，不是默认拖拽。** widget 卡片本身可点击（点开全屏面板），默认态开拖拽会劫持点击；且 `bookmark` 卡片已是拖拽排序的宿主（`moveBookmark`），两种拖拽语义混在一页会互相干扰。入口是右下角 `.utility-dock` 的「布局」按钮，仅登录后可见。拖拽用 Pointer Events，**终止监听挂 `window` 且同时处理 `pointerup` 与 `pointercancel`**，指针 capture 只是双保险——挂在元素上用 `{ once:true }` 会在指针于元素外释放时永久卡住状态（分享编辑器的 auto-grow 曾这样冻结整个会话）。排序是持久化状态，**拖完立即落盘、失败整体回滚并 render 出错误**，不做乐观更新。换边仅宽屏可用：窄屏模块区是横滑列表，横向拖拽会与横滑抢同一个手势。

**后台分区导航**用 tab 三件套（`role="tablist"` / `tab` + `aria-selected` / `tabpanel`），宽屏（≥900px）左侧竖排常驻侧栏，≤899px 退化为顶部横向滚动标签条，同一套 DOM 与状态。**这些规则必须写在 `admin.css`**，不能写进 `styles.css`——后者先加载，而窄屏块内用 `.modal` 提高了特异性，写错文件会被静默压掉（见 :18）。

**模块配置不共用 `#saveBtn`。** 它只保存 `config.json`；模块配置走独立端点、独立保存按钮，也不参与 `beginConfigEdit()` 的脏检查——否则用户改了个服务器名点「取消」会被「你有未保存的修改」拦住。模块分区首次进入时才拉 `/api/modules/config`，每次 `renderAdminPanel()` 都预取会累积撞上限流。

**新增模块的落点**：定义放 `public/modules/<id>.js`，id 加入 `App.KNOWN_MODULES`，配置项加入 `normalizeModulesConfig()` 的白名单。需要增长或查询的数据（条目、缓存）在 `lib/db.js` 的 `MIGRATIONS` 尾部追加台阶，不预建空表。新增 `public/` 文件必须同步 `sw.js` 的 `ASSETS` 与 `CACHE`——延后加载的文件若不预缓存，回访用户每次打开模块都要走一次网络，与延后加载的初衷相反。

## 凭据加密

凭据加密实现在 `lib/credentials.js`，WebDAV 密码与模块 agent token 共用。共用的理由不是省代码，而是两条规则必须一致：同一套算法与参数，以及**改密码时一起重新加密**。

- **密钥从管理员密码哈希派生**，每个用途一个后缀：`webdav-config-key` / `modules-token-key`。同一把密钥跨用途会让一处泄露同时丢掉两个凭据。追加新用途可以，**改已有后缀不行**——会让已存的密文全部解不开。
- **`token` 只进不出。** `GET /api/modules/config` 把每个 server 的 token 折成 `hasToken` 布尔；编辑时留空表示保持原值（与 WebDAV 的「留空保持原密码」同一形状）。
- **保存模块配置不会抹掉 token。** 这是「不回显」的必然副作用：客户端手里的 server 对象没有 `token` 字段，直接采纳请求体就会清空密文。`mergeModulesConfig()` 因此对 `servers` 按 id 逐条合并、补回既有的密文。症状隐蔽——服务器还在，只是开始 401。
- **修改密码时自动重加密。** `reencryptCredentials()` 先用旧密码解密全部凭据、用新密码重新加密，**全部成功才落盘**；任一失败则密码文件也不写。边解密边写会造成「密码改了、凭据只迁移了一半」，而那一半永久无法恢复。
- **归一化不接受 `token` 字段。** `normalizeServer()` 的白名单里没有它——提交明文 token 会被丢弃，必须走服务端的加密路径。
- **推送凭据不走 `lib/credentials.js`。** 它是 `sha256` 哈希而非 AES-GCM 密文，因为校验时要**比对**而不是解密——密文每次加密的 IV 都不同，没法直接比较。设计上与 `.admin-password.json` 同级：明文只在领取响应里出现一次，落盘只有哈希。
- **`pushSecretHash` 与 `token` 一样只进不出。** `normalizeServer()` 的白名单里同样没有它，`mergeModulesConfig()` 按 id 补回，读接口折成 `hasPushSecret` 布尔。**若归一化顺手接收它，merge 的保留分支就永远走不到**——下一次保存配置会把凭据清空。
- **已知边界**：丢失 `.admin-password.json` 且无备份里的旧密码时，agent token 与 WebDAV 密码永久无法恢复。推送凭据不受影响（它不派生自管理员密码），但重新领取需要先能登录。这是「不另存主密钥」的直接代价，与 WebDAV 原有行为一致。

## 多服务器监控

**目标机上跑 agent，本服务采集它。** 本服务只能读到运行它自己的那台主机；要看别的机器，目标机上就得有一个东西去读 `/proc` 并把结果吐出来。

采集有两个方向，各自适用不同网络：

```
【注册】       后台「部署」→ 签一次性令牌 → 一条命令贴到目标机
                目标机 agent ──POST /api/modules/enroll（带令牌）──▶ 本服务
                agent 自签证书，本服务存 PEM + 回长期 token（见下）

【拉取（默认）】目标机 agent ──HTTPS /metrics（服务来连）──▶ 本服务 ──▶ module_cache ──▶ 首页卡片
                  读 /proc/stat、/proc/meminfo                     └─ 本机读 os，永远排第一
                  Bearer token 鉴权，目标机要开端口
                  自签证书以 PEM 作 ca 信任（见下）

【推送】        目标机 agent ──HTTPS POST（机器去报）──▶ agent_metrics 表 ──▶ 首页卡片
                  不监听任何端口                   └─ 离线判定靠「多久没收到」
                  推送凭据鉴权，与 agent token 是两回事
```

**两种模式并存**，每台机器在 `.modules.json` 的 `servers[].mode` 里选 `'pull'`（默认）或 `'push'`。同一个请求里可以同时有本机、拉取机、推送机。

### 拉取模式的传输：强制 HTTPS + 一次性令牌注册

**为什么强制。** 拉取模式下 Bearer token 是**唯一的**鉴权凭据，而它能读到那台机器的 CPU、内存与主机名。走明文 HTTP 等于把这个凭据公开在网络上——任何能嗅探或旁路监听的人都能拿到。所以三层都硬切，没有「默认明文」这个选项：

- **agent**：缺 `--tls-cert/--tls-key` 时**拒绝启动**（不是降级到明文）。错误信息印在目标机终端，用户当场看得见；否则它只会表现为后台里一台离线的机器。逃生门是显式的 `--insecure-http`，默认关闭。
- **服务端写入**：`POST /api/modules/servers` 只接受 `https:`，且**接受裸 IP**（自动补 `https://` 与默认端口 4195）——「只填 IP 就行」是这个设计的核心诉求，不能只在前端成立。`http:` 单独给一条带迁移步骤的错误，不是笼统的「格式错误」。
- **服务端采集**：`fetchRemoteMetrics()` 入口即拒 `http:`，不发请求。

**这条与主服务自己的 TLS 无关。** 握手发生在「本服务 → 目标机」之间；给主服务套的 nginx/certbot 只保护主服务自己。目标机 4195 端口的 TLS 必须由目标机自己承担。

**自签证书的信任：一次性令牌自动注册（不是人工核对指纹）。** agent 在 `enroll` 阶段用 Go 的 `crypto/x509` 生成自签证书（**能原生签发**——这正是选 Go 的原因之一，Node 内置 crypto 只有 `X509Certificate` 只能解析，所以上一版被迫调 openssl CLI），把证书交给本服务；本服务存下 PEM 并回一枚长期 token。

注册用的凭据是一枚**一次性部署令牌**：后台生成（明文只在响应里出现一次，落盘只有 `sha256` 哈希）、15 分钟过期、用过即从配置里删除、重复签发即作废旧令牌。

**为什么不用人工核对指纹。** 上一版要求用户 SSH 上去生成证书、把终端打印的指纹抄回后台逐字核对——七步以上，且第一步就需要用户已经能上目标机。令牌的语义是「持有即信任」，用户只做一次复制粘贴。

⚠️ **这里没有「绑定来源 IP」那道防护**（代码里曾有过一版，已删）：部署令牌在**目标机**上使用，而服务端看到的是它的**出口 IP**（NAT 之后），与用户在后台填的地址没有可比性。拿它做判定就是把「局域网地址」推出后台，和本文「不按私网地址自动切换」一节拒绝的推断同一类错误。真实防护是上面那三条。

**enroll 的字段契约必须真跑一次才能验证。** agent 发出的 JSON 与服务端读取的字段名是一个**跨进程契约**，而两边各自都有测试却互不相干：token 一度在 agent 侧校验了非空、却没放进请求体，于是 NAS 上稳定返回 400「缺少令牌」——二进制编译通过、全部单元测试全绿、代码审计也没看出来。所以现在有一条**真的把 agent 二进制和 enroll 端点放在一起跑**的测试（自签 HTTPS 服务端 + 异步 spawn + `--server-ca`）。

⚠️ 那条测试本身踩过两个坑，都写进了注释：① agent 必须用**异步** `spawn`，`spawnSync`/`execSync` 会阻塞事件循环，同进程的 HTTPS 服务器来不及响应，表现为与证书无关的「TLS handshake timeout」；② 测试服务端是自签的，所以要 `--server-ca`。

**自签服务器要显式给 CA。** `http.DefaultClient` 只认系统根池，而 **Go 在 macOS 上不读 `SSL_CERT_FILE`/`SSL_CERT_DIR`**（那是 Linux 行为，macOS 走 Keychain），`GODEBUG=x509usefallbackroots=1` 实测也无效。于是自托管用户（自签而非 certbot）的 enroll 必然握手失败。所以 agent 提供 `--server-ca <PEM 路径>`，把它追加进 `RootCAs`——**不是 `InsecureSkipVerify`**，那等于把 HTTPS 悄悄降级成明文。`install.sh` 透传该参数，并在注册失败时明确点名这个原因（`certificate signed by unknown authority` → 加 `--server-ca`）。

**必须存证书 PEM 而不是指纹。** Node 的 `https.request` 只支持把某张证书作为可信锚点传进 `ca`，没有「按指纹信任」的接口。实测（Node 22）：自签证书会先被 OpenSSL 链校验拦下（`DEPTH_ZERO_SELF_SIGNED_CERT`），`checkServerIdentity` 在这种情况下**根本不会被调用**——所以「自定义一个指纹比对函数」这条路在 Node 上走不通，只能存 PEM 交给 `ca`。这也是 `fetchRemoteMetrics` 用 `node:https` 而不是内置 `fetch` 的原因（内置 fetch 不接受 dispatcher 选项）。

**三种结果必须分开，不能塌缩成「机器离线」：**

| 情况 | 返回 | 含义 |
| --- | --- | --- |
| `http:` 地址 | `insecure` | 明文已停用，需改 https |
| 还没注册（`certPem` 为空） | `notEnrolled` | 「还没注册」，如实报告，不伪造指纹 |
| 注册过但证书变了 | `certMismatch` | **安全事件**：证书被更换，可能是中间人 |
| 连不上 | 无标志 | 真的网络问题 |

`certMismatch` 与 `notEnrolled` 都表现为「拉不到数据」，但一个是「还没注册」、一个是「有人动了证书」，塌缩成同一句话会让用户照错误方向排查。同理，证书错误码（`DEPTH_ZERO_SELF_SIGNED_CERT` 等）必须**单列**——落进 `ECONNREFUSED` 分支会把一个安全问题显示成「无法连接（地址不通或服务未启动）」。

**证书要走两条写路径的保留分支。** `certPem` / `certFingerprint` / `enrolledAt` / `deployState` 只由服务端写入，归一化不接收；而 `POST /api/modules/servers`（编辑单台）与 `mergeModulesConfig`（拖拽排序提交整个列表）都整体替换 entry，漏掉保留就会「改个名字就抹掉注册」，采集重新报「证书未受信任」而界面上看不出这两件事有关联。

### 模式的判定：显式字段 + 探测按钮，不猜 IP 段

**不按私网地址自动切换。** 本项目单人自用、tarball 部署，**服务器完全可能就架在家里**（NAS、小主机）——那时 `192.168.1.10` 完全可达、拉取正常工作，自动切推送反而把好端端的配置搞坏。而且 `100.64.x`（Tailscale CGNAT）和 `127.0.0.1`（隧道映射到本机）都落在「私网前缀」这个判断的盲区里。

后台添加机器时问的是「**本服务能否直接连到这台机器**」，而不是「局域网 / 公网」。后者要用户自己推导四种组合里的哪一格；前者就是决定性事实本身。回答映射为 `servers[].reachable`，进而定 `mode`（能连 → `pull`，不能 → `push`）。

**探测用 TCP 三态，而不是 ping。**

| 三态 | 含义 | 界面 |
| --- | --- | --- |
| `refused` | 主机回了 RST——**它活着**，只是没人监听 4195 | 在线 · 未部署 |
| `timeout` | 路不通 | 离线 |
| `open` | 有服务在监听 | 接着问 `/health` |

`refused` 与 `timeout` 分开是这次改版的核心：**上一版两者都显示「离线」，用户无法判断「是没装 agent」还是「够不着」**，而这两种情况的下一步完全不同。

`open` 之后**必须再问一次 `/health`**（`probeAgentHealth`）：端口上有东西 ≠ 那是我们的 agent。别的程序占了 4195 会被判成 `port_conflict`。

⚠️ **`open` 只说明「有人应答 TCP」。** 实测（macOS 办公网/VPN 环境）：连一个完全不可达的公网地址也会触发 `connect` 事件，且对端**保持连接**不主动断开——中间有透明代理接管了 TCP。所以「connect 后等一会儿看对端关不关」这个加固**实测无效**（试过，已删）。挡住它的是第二道防线 `probeAgentHealth`：代理接得下 TCP 却答不出 `/health` 的形状。代价是在有透明代理的网络里，「未部署」的判定会不准。

**后台卡片有两个状态位，首页只有一个。** 「在线」（`reachable`）与「agent 就绪」（`deployState`）是两个正交问题，分开才看得出该先查网络还是先部署。首页是「一眼扫过」的场景，合并成一个就够（用户拍板）。

⚠️ 但**首页那个状态位的措辞后来又收窄了一次**（用户原话：「主要体现是否在线就行了」）：它不再显示「已就绪 / 未部署 / 等待部署」那套后台措辞，只说 **在线 / 离线 / 连不上 / 异常**。那些词回答的是「该点部署还是去查网络」，属于操作台的信息；而一台正常工作的机器显示「已就绪」，对「它活着吗」这个问题没有额外信息量。

**异常不合并进「离线」**：证书被换、端口被别的程序占，这两种塌缩成「离线」会让用户以为机器挂了，实际是安全问题或配置冲突。

⚠️ **首页的第三条指标是「存储占用」，不再是「负载」。** 负载对不熟悉的人没有直觉（「0.52 / 0.61」是高是低得先知道核数），存储占用是「用了 300 GB / 460 GB」，看一眼就知道急不急。**详情面板仍保留负载**——那里有 CPU 与核数做参照。「首页不显示」不等于「这个指标废弃了」。

**详情页的设备地址放在指标之外**：拉不到数据时没有指标、只有一句错误，而那正是最需要地址的时候（排障第一句问「它在哪台机器上」）。概览列表里也带地址——两台机器可能都叫「服务器」。

### 推送的鉴权：独立凭据，替代 requireAdmin

推送端点是**匿名可达**的（内网 agent 主动连公网服务），所以它的鉴权**不能**是 `requireAdmin`——agent 是裸 HTTP，拿不到浏览器会话。

**也不能只验 agent token。** 服务端要拿 token 去解密 `.modules.json` 里的密文（密钥派生自管理员密码哈希），一旦 token 能触发解密 + 写库，它就等于**配置写权限**：可反复触发 bcrypt（单次约 55ms）、可改写首页上所有机器的指标。爆炸半径不该从「这台机器的指标」升级成「整个配置」。

因此用**绑定 `server.id` 的推送凭据**：管理员登录后领取，32 字节 CSPRNG（base64url），**明文只在领取响应里出现一次**，服务端只存 `sha256` 哈希；比对走 `timingSafeEqual`。凭据绑定机器，所以拿 A 机的凭据推 B 机的数据返回 409。重新领取即轮换，旧的立即失效。

- **agent token 在推送模式下不参与鉴权**，但保留在配置里，切回拉取时不必重填。
- **限流是独立桶**（120 次/分钟）。复用 `publicReadLimit` 会让匿名首页流量消耗推送配额；复用 `rateLimit`（管理端 30/min）会把 10s 周期的 agent 直接限掉。上限 120 = 20 台 × 6 次/分钟（最短周期 10s），是推导值不是拍脑袋。
- **凭据被拒返回 401 而非 404**：两者在返回上无法真正区分，而 404 会额外泄露「存在哪些机器」。同时记一条日志（记来源与时间，**不记凭据**），否则用户看到卡片离线却无从排查。

### 推送的载荷：未经信任的网络输入

推送来的 `metrics` 会直接流到首页卡片渲染，而 agent 在内网。落库前压到已知形状：

| 字段 | 规则 | 越界时 |
| --- | --- | --- |
| `cpu` / `memoryPercent` | 有限数且 `0 ≤ v ≤ 1` | `null`（界面显示「—」） |
| `memoryUsed` / `memoryTotal` / `load1` / `load5` / `uptime` / `cores` | 有限数且 `≥ 0` | `0` |
| `diskUsed` / `diskTotal` | 有限数且 `≥ 0`。`0` 表示**这台机器没报**（旧版 agent，或 `statfs` 失败） | `0`（界面显示「—」而不是「0 B / 0 B」） |
| `hostname` | 字符串，`≤ 128` 字符 | 截断 |
| `platform` | 字符串，`≤ 32` 字符 | 截断 |

- **磁盘口径：`Blocks - Bfree × Bsize`**，本机与远端**必须一致**。口径不同会让本机卡片与远端卡片报出两个数，而用户无从判断该信哪个。
  ⚠️ 这个数在 **macOS 上与 `df` 对不上**（实测 300.5 GiB vs `df` 12.7 GiB，差 24 倍）——APFS 的「已分配」含其他卷共享的可回收快照，而 `df` 报的是当前实际落盘的数据。statfs 给不出后者，那需要 APFS 专有接口。**实际部署的 Linux（ext4/xfs）上两者一致**，不受影响。
- 校验在写库之前。反过来是「先存后筛」：越界值已落盘，只是不显示——换一次渲染路径就又显示出来了。
- **载荷整体超 4KB 整个拒收（400）**，不是静默截断。
- 一台受控的机器不该靠 `cpu: 1e9` 就能撑破进度条。
- 渲染侧全部用 `textContent`，没有一处 `innerHTML`——有单测钉住。

### 推送的离线判定与拉取根本不同

拉取是「当场连一次，连不上就是离线」；推送没有请求-响应，只能靠**多久没收到**：

- 阈值 = `pollInterval × 2 + 30s`（最坏延迟：周期 10s → 50s，周期 300s → 630s）。这是轮询不是推送，新鲜度始终由用户设的周期决定。
- **刻意不复用 `resolveCacheTtl()`**：那是聚合缓存的 TTL，与「某台机器是否还在上报」无关。缓存命中时不会重采，复用它会让「缓存新鲜但推送已断」显示为在线。
- **超阈值时保留上次数值**，卡片标注「最后更新 N 分钟前」。这能分辨「刚才还好好的、网断了」与「一直没上来、配置就不对」两种完全不同的排查方向。

### 推送的数据落地

写入 SQLite 新表 `agent_metrics`（`server_id` 主键 + `payload` + `received_at`），**与 `module_cache` 分开**：

- `module_cache` 是单键 `'local'`，存「本次聚合采集的结果」（含聚合后的 `servers` 数组）；`agent_metrics` 按 `server_id` 一行一行存「某台机器的单份上报」。两者生命周期不同，**共用一个 key 会让一次推送覆写掉本机和其它拉取机器的结果**。
- 进 SQLite 而非 JSON：`nav-sylph.db` 已在 `PRIVATE_FILES` 里、已是 0600、已被 WebDAV 备份覆盖、随发布包打包。复用它意味着不需要新的文件权限管理、新的备份条目，也不需要改 `sylph.sh` 的备份/恢复列表。
- **必须入库而不是只驻内存**：服务器重启后 agent 下一次推送（≤ pollInterval）即可自愈。

### agent 侧

agent 是 **Go 静态二进制**（`agent/main.go` + 四个平台桩文件），**零第三方依赖**（`go.mod` 无 `require`），三个 Linux 架构由 `scripts/build-agent.sh` 交叉编译（amd64 / arm64 / armv7）。

**为什么不是 Node 或 shell**：Node 内置 `crypto` 只能解析证书不能签发（上一版被迫调 openssl CLI）；纯 shell 做不了带鉴权的 HTTPS 服务（`openssl s_server` 无鉴权）。Go 两个都能，且交叉编译后目标机什么都不用装——这才是「NAS / 路由器 / 精简容器上能用」的前提。

- **正式支持的平台只有 Linux**。darwin 产物仅供开发机自测：`sysctl kern.cp_time` 在现代 macOS 已被移除，没有 cgo 就拿不到累计 CPU 时间，于是 CPU 一栏恒为 `null`（诚实降级，不编造值）。`agent/install.sh` 在非 Linux 上**第一步就拦下**并给出本机自测命令——少了它会一路通过检查、下载跑不起来的 ELF、写 systemd、systemctl 失败。
- **子命令**：`enroll`（注册，生成自签证书并换回长期凭据）、`serve`（拉取，起 HTTPS）、`push`（推送，只做出站连接）、`collect`（打印指标，调试用）、`health`（自检）。凭据从环境变量读更安全（命令行会出现在 `ps` 输出里），但**为了重启后仍能鉴权必须落盘**：写在 `/etc/nav-agent/config.json` 与 `/etc/nav-agent/env`，两份都是 0600 root，**不写进 systemd unit**——unit 会被 `systemctl cat` / `show` / `status` 打印出来，也常被用户贴进 issue。
- **推送模式默认不监听任何端口**（`SERVE_HTTP = !PUSH_MODE || args.serveAlongsidePush`）。这是推送最大的安全收益：内网机器上一个端口都不用开。
- **推送凭据与拉取 token 是分开的**环境变量（`NAV_AGENT_PUSH_SECRET` / `NAV_AGENT_SERVER_ID` vs `NAV_AGENT_TOKEN`），互不顶替——顶替的表现是推送一直 401，而错误信息只说「凭据无效」。
- **失败时指数退避，上限 5 分钟**。无脑按原周期重试会持续消耗服务端的限流桶，而那个桶按 IP 计数，一台机器的重试风暴会影响其它所有 agent。
- **推送周期与服务端白名单逐项一致**（10/15/30/60/300），非法值回落 15。两侧不一致时，正常配置就会自己把自己限掉（间歇性 429）。
- **协议版本不变**（`VERSION = 1`）。两种模式上报的指标载荷字段完全一样，推送是与拉取并存的另一条通道，不构成协议变更。
- **`install.sh` 的子命令必须按模式分支**（push → `push`，其余 → `serve`）。写死 `serve` 时 push 模式会因缺 Bearer token 启动即退出，而脚本只 warn 一句、**返回 0**——用户在后台看到「已就绪」，实际那台机器上没有任何进程。**静默失败比崩溃更坏**：崩了用户会来问，装上了用户不会。所以 `systemctl restart` 之后还要 sleep + `is-active`，失败一律 `die`。

- **重复执行部署命令会重装并重新注册**，所以脚本必须在**装二进制之前**停掉正在运行的 agent。enroll 会让服务端**换掉 token**、作废旧的，而旧进程手里正是那个已作废的凭据——从 enroll 成功到 `systemctl restart` 之间它一直 401，表现为「首页那台机器突然掉线、几秒后恢复」，用户会以为部署把机器弄坏了。
  覆盖二进制本身是安全的：`install(1)` 内部是「复制到临时文件再 rename」，rename 换的是目录项，不动那个已映射的 inode，所以**不会 ETXTBSY**。
  停止失败只 `warn` 不中断——一个僵死的 systemd 不该让用户连升级都做不了。

### agent 自升级（`nav-agent upgrade`）

**协议版本与软件版本是两件事**，混用会让「升级了 agent」变成「协议不一致」，而指标字段一个都没变：

| | 含义 | 何时变 |
| --- | --- | --- |
| `VERSION`（载荷里的） | **协议**版本，恒为 1 | 指标字段有增减时 |
| `buildVersion` | **软件**版本 | 每次发布 |

`buildVersion` 由 `scripts/build-agent.sh` 从 `version.json` 用 `-ldflags -X` 注入；读不到时回落到 `dev`，让「从源码直接 `go build` 的产物」能被识别出来，而不是伪装成某个正式版本。

**`/health` 同时带 `agentVersion` 与 `goos`/`goarch`**，服务端 `probeAgentHealth` 取回软件版本，probe 路由回传。

升级时**三道校验全部在替换之前**，任何一道不过都保持现有版本不变：

1. 文件大小（< 1MB 不是可执行文件）
2. 架构自检（执行 `version --raw`，跑不起来或输出不像版本号就拒绝）
3. 版本格式（只接受数字与点，外加 `dev`）

之后才备份 → `os.Rename`（原子，不会出现写了一半的损坏文件）→ 复验落地的那一个 → 不过就回滚 → 成功则清掉备份。架构按 `runtime.GOARCH` 自动选（amd64 / arm64 / armv7；`GOARCH=arm` 一律按 v7 处理，v7 能在 v5/v6 上跑而反过来不行，所以这是安全的一侧）。

⚠️ **必须用 `version --raw` 解析，不要解析人类可读那行。** 那行是
`nav-agent 1.6.8（协议 v1，linux/amd64，…）`，按空白切第 2 段拿到的是
`1.6.8（协议` —— 实测踩过，然后被当版本号拿去比较。**机器可读的字段就该有
一个只输出它的入口**，而不是让脚本去解析给人看的那行：任何一次改文案都会
静默弄坏它。

**升级与部署是并列的两条路，不是同一条**：部署会重新注册（换 token、重签证书），
升级只替换二进制。所以部署面板把升级命令单列一步，路径写死
`/usr/local/bin/nav-agent` 并与 `install.sh` 的 `BIN_PATH` 保持一致（两处漂移时
用户拿到的是一条跑不通的命令，而错误发生在目标机上）。

### 拉取模式（默认）

- **默认只监听 `127.0.0.1`**，跨机访问需显式 `--host 0.0.0.0`。`/health` 不需鉴权，`/metrics` 需要。
- **CPU 必须两次采样做差**。`/proc/stat` 给的是累计值，单次读没有百分比。
- **两条采集路径必须返回同一种形状**（`cpuTimes` 聚合结构）。形状不一致时 `current.Total - previous.Total` 变成 NaN，CPU 恒为 `null`，而返回的 JSON 完全合法——看不出出错，只是永远没有 CPU 数据。拿不到时**返回 `(零值, false)`** 让 CPU 留 null，而不是造一个假值。
- **macOS 的内存不能用「总内存 − 空闲」**。那个差值在 macOS 上衡量的是缓存占用而不是应用占用——实测 16GB 机器上显示成「内存 99%」。正确口径是 `vm_stat` 的 `free + inactive + speculative + purgeable`。⚠️ `vm_stat` 的标签是**词组**（`Pages free:`），按空白切分后 `Fields[1]` 是 `free:` 而非数字——取错下标会让 `ParseFloat` 失败返回 0，于是「可用内存 = 0」显示成「内存 100%」。必须匹配整行再取**最后一段**。
- **协议版本两侧必须对齐**（agent 的 `VERSION` 与服务端的 `AGENT_PROTOCOL_VERSION`）。不一致时报错，**不把不认识的字段当 0 读进去**。
- **一台离线不影响其它台。** `fetchRemoteMetrics()` 失败返回 `{ok:false, error}` 而不抛错；401 单独标记 `authFailed`，界面据此区分「凭据错」与「机器挂」。目标机**并发**拉取——串行会让 N 台耗时累加到超出前端轮询周期。
- ⚠️ **改了 certPem 相关的分支要同时改调用点。** 上一版删掉 `fetchPeerCert` 时漏改了这一处调用，于是「agent 在跑但没注册成功」会走到它并抛 `ReferenceError`——**不在任何 try 包装里，直接杀掉整个进程**，首页所有机器一起消失，而 `/api/modules/metrics` 返回 500。形状断言看不见「这个标识符根本不存在」，必须有**真起一个自签 HTTPS 服务**的用例兜住。

### 两种模式共有的部分

- **每台一张卡片**，本机固定排第一且不需要配置；**每台可在后台单独开关是否在首页显示**（写进 `widgets[].enabled`，缺省为显示）。**本机也可隐藏**（v1.6.9 起）：过滤器与远端同一规则，恢复入口是后台「监控目标」里本机卡片的显示/隐藏复选框——旧设计「本机不可关」的理由「关掉后模块区可能全空却找不到入口开回来」败给了一个事实：恢复入口就是后台这张卡自己，它出现的那一刻前提就翻了。隐藏只影响显示，顺序与左右原样保留，重新打开精确回到原位。
- **`.app` 必须建立包含块**（`position: relative`）。否则 `.module-zone` 的 `left/right: 22px` 相对**视口**而非 `.app` 内容盒，而 `sideDockAvailable()` 又是用 `.app` 宽度算余量的——两个坐标系对不上。实测 1760 宽的窗口下 `.app` 左边缘在 160px，模块区却从视口 22px 开始，卡片被甩到窗口左侧。
- **宽屏纵向偏移按实测高度排**，`--stack-top` 由 JS 写入。写死步进（166px）会压住更高的卡片——实测在线带延迟提示 174px、离线只有 98px。内容变化后要重排。
- **拖拽要真的移动 DOM**：在 `pointermove` 里 `insertBefore`，而不是松手时按「DOM 当前顺序」写 order——后者读到的是从未变动过的顺序，拖了不换位。插入点用**拖拽开始时**缓存的中线判定：每帧读实时 `getBoundingClientRect()` 会因让位而漂移，比较在自己造成的移动中失配。
- **插入导致的基准跳变要补进 transform。** 视觉位置 = 基准 + `transform`；基准突变而 transform 仍相对拖拽起点，合成后卡片会猛弹（实测 247px）。补上差量并同步 `dragData.startY`，单帧跳动可降到与指针位移一致。
- **采集缓存的失效跟着配置走。** `module_cache` 缓存的是「上次采到了什么」，而采集的目标由配置决定。加/改/删服务器时调用 `invalidateMetricsCache()` 让它失效——否则「新加的机器不出现、删掉的还在」，要等满 TTL 才自愈。`POST /api/modules/config` 也用于拖拽排序与开关模块，那两种改动不影响采集目标，所以那里加了前后比较、只在 `servers` 真的变了才清；无条件清会让「加机器立刻可见」退化成「任何保存都重采」，TTL 就失去了意义。**推送写入也清缓存**——推送是采集的输入之一，输入变了就得失效。
- **`agent/` 随发布包分发**（`scripts/release.sh` 里的 `cp -r agent`）。不打进包的话，多服务器功能对下载者等于不存在。
- **`.modules.json` 纳入 WebDAV 备份。** 备份产出三个文件：`nav-sylph-config-{ts}.json`、`nav-sylph-bookmarks-{ts}.html`、`nav-sylph-modules-{ts}.json`，按时间戳归为同一组。模块配置参与「有无变化」判定——只改监控目标却判成 noChanges，远端会留一份旧布局。token 在备份里**仍是密文**（密钥派生自管理员密码哈希），换机器后用同一密码即可解开；**`.admin-password.json` 始终不进备份**——把密码哈希交出去等于把账号交出去。推送凭据的哈希同样在备份里，它本身不可逆，但备份与密码仍不该放在一起。清理旧备份时三个文件一并删除，否则 modules 文件会成为孤儿：清理按分组算，孤儿既不被计入也不会被清走。
- **一键部署命令在后台生成，不在 `sylph.sh`。** `sylph.sh` 管的是**主服务**的安装与升级，agent 部署在**别的机器**上，混进去会让两个角色互相干扰。上一版是六步手工说明（下载、手动改配置、自检、systemd、防火墙…），现在合并成**一条可复制命令**——每一个由系统能自己生成的步骤（协议前缀、端口、令牌、证书指纹）都不该让用户填。
- **命令里的凭据是占位符，明文不进页面 DOM。** 令牌明文只在「签发」那一次响应里出现一次；为了让命令可复制而不泄露，页面上的令牌位是 `<占位符>`，由 `agent/install.sh` 在目标机上自己填进 0600 的配置。
- **二进制按架构分发**（`GET /agent/nav-agent-linux-<arch>`，白名单 amd64/arm64/armv7），路径穿越有防护。**失败必须分因**：文件缺失与架构不在白名单是两种原因，塌缩成一个 404 会让用户以为是网络问题。分发用 `fs.createReadStream`（从 `require('fs')` 拿，不是 `require('fs').promises`——后者没有流式 API），多 MB 产物不要 `readFile` 再 `send`。**不进 Service Worker 预缓存**（预缓存一个从不加载的文件只会在每次更新时多下载一次），并且 `Cache-Control: no-cache`——URL 稳定而内容随版本变，否则照旧命令执行的用户拿到的是旧版。404 的响应体必须是 **shell 注释**而不是 HTML 错误页，因为它会被 `bash -s` 执行。
- **`hasEnrollToken` 是「能不能直接复制命令」的判据**（令牌已签发且未过期 vs 没有/已过期），卡片据此在「复制命令」与「部署」之间切换。这个字段曾长期算了却没人读，而它的注释声称驱动着两个并不存在的按钮——一个假承诺。
- 另有一份 `agent/README.md` 供离线查阅。
- **更新周期可配，白名单在服务端裁决。** 取值 10 / 15 / 30 / 60 / 300 秒，存在 `.modules.json` 的 `pollInterval`。10 秒是下限（再短会撞管理端限流 30 次/分钟），5 分钟是上限（再长与默认 TTL 相同、失去意义）。非法值回落默认。
- **缓存 TTL 跟着周期走。** 取 `周期 + 10s`，夹在 20s–300s 之间。固定 5 分钟 TTL 会让「把周期改成 10 秒」变成一句空话——前端每 10 秒问一次、服务端 5 分钟内都回同一份缓存。`+10s` 的余量是为了让两次轮询错开 TTL 边界，否则永远拿不到新值。服务端把当前周期回给前端，前端据此重排自己的定时器，改完不必刷新页面。
- **页面切到后台时轮询暂停**，回到前台立即刷新一次。

### 两条必须由测试钉住的边界

- **`pushSecretHash` 与 `token` 一样只进不出。** `normalizeServer` **不接收**它（否则 merge 的按 id 补回分支永远走不到），只有「领取」那一步写入，merge 按 id 补回。读接口折成 `hasPushSecret` 布尔。
- **中间件必须在路由之上定义。** `app.post` 的第二个参数在注册时就要求中间件存在，而 `const` 有暂时性死区——定义在下方时服务器启动即抛 `ReferenceError`，而 `node --check` 与全部单元测试都是绿的：语法检查不查标识符是否已定义，静态断言更看不出「谁在什么时候求值」。只有真正把服务器起起来才会暴露。

## 首页编辑模式

右下角 `#layoutBtn` 承担两个动作：常态是「编辑」，编辑态变「保存编辑」。进入编辑模式时对两套存储各存一份草稿快照（`this.editSession`），**改动一律只落在内存与 DOM，点「保存编辑」才提交**；Esc 或自动登出则整体丢弃（有改动时先确认）。

### 覆盖范围与边界

- **模块区**：既有能力，行为从「松手即存」改为草稿。`commitWidgetDrag` 不再调 `saveWidgetLayout`，只按新 `order` 重排一次。
- **书签网格**：分类之间、分类之内都可拖；每类末尾一个「＋」卡新增该类书签；网格末尾一个「＋ 添加分类」；点书签卡弹窗改标题/URL；点分类头的 ⠿/✎/✕ 分别拖拽/重命名/删除。
- **只覆盖 `config.json` 的 `categories[].bookmarks[]`**（`{id, title, url}`）。**这块数据现在只有一个编辑入口**——首页的编辑模式。后台原先还有一个「书签分类」分区（`#catsEditor` / `renderCatsEditor` / `bindEditorDrag`），已删除，改为一行指向首页的提示文案；重复的第二个入口意味着同一份数据有两个真相来源。
- **别与后台「管理收藏」混淆。** `favorites.json` 的平铺收藏（多 `description`/`category`/`tags`/`private`）由收藏管理器编辑，**不在首页编辑模式范围内**。两者的分类结构长得像但不是一回事：前者是首页网格的分类，后者是收藏管理器左侧的树（含重命名、拖拽归类、批量隐私）。

### 三条必须保持的性质

- **书签拖拽走 HTML5 DnD 而非 pointer 事件。** 模块那边用 pointer 是因为宽屏绝对定位卡片要实时跟手并自己处理 `--stack-top` 基准补偿；书签网格是 CSS grid，没有那一层。`dragstart` 后浏览器会抑制随后的 `click`（规范行为），所以同一张卡既能拖又能点开编辑框，不需要计时器区分。
- **增删控件的显隐只由 `.grid.is-editing` 控制，JS 不写 `hidden`。** 与模块拖拽把手同一条纪律：挂载时 `editLayout` 几乎总是 `false`，而 `hidden` 属性压过任何 CSS，控件会实测 0×0、点不到。
- **`syncEditLayoutUI` 只在状态真的翻转时重绘网格。** 它还被 `applyWidgetLayout` 调用（视口变化时会触发），无差别重绘会让正在被拖拽的书签 DOM 凭空重建。判据是 `this._gridEditing !== editing`——`_gridEditing` 在构造函数里显式初始化，不靠 `undefined !== false` 成立。

### 两套存储的提交不是原子的

`/api/modules/config` 写 `.modules.json`、`/api/config` 写 `config.json`，**没有跨文件事务**。保存走**串行 + 前者失败即中止**，把最坏情况收敛成「只有布局变了」，而不是并发后两者状态不确定。彻底解决要服务端加一个合并端点。

**失败路径必须收尾，不能只是中止。** `saveWidgetLayout` 自己回滚 `widgets` 并提示，但**编辑会话不会因此结束**——书签草稿还在内存里，界面仍停在编辑态，用户点了「保存编辑」却什么都没发生。所以 `if (!ok)` 分支要与书签提交失败同构：`rollbackEditSession()` + `exitEditLayout()`。

**`saveWidgetLayout` 的入参是 `{ widgets }` 对象，不是裸数组。** 它的回滚分支读 `snapshot.widgets`；传数组会让那行抛 `TypeError`，而异常从 `catch` 块**内部**抛出，会穿透 `saveWidgetLayout` 的 catch、穿透 `saveEditSession` 的 `try`，于是回滚、退出、提示一行都不执行。改这个签名时，调用方与被调方必须同时改——测试用 `vm` 抽出方法真跑一遍，断言实际传出去的值。

### 拖拽的宿主元素必须是可拖拽的最近祖先，且不能是整块

原生 DnD 从**最近的 draggable 元素**起手。所以书签与分类的宿主分别是卡片本身（`<a class="bookmark" draggable>`）与**分类头**（`.category-header` 带 `draggable`），而不是那个 ⠿ 按钮——`<button>` 不是可拖拽元素。

两条都是实测出来的，方向相反：

- **宿主不能太小**：只给书签卡加 `draggable` 时，从 ⠿ 按下**一个 dragstart 都不发**（浏览器实测事件数为 0）。
- **宿主不能太大**：把 `draggable` 挂到整块 `<section>` 上，section 内部**任何**位置按下都会起拖，**包括 ✎ 重命名与 ✕ 删除**。那两个按钮于是变成「按住横拖 → 起拖 → 浏览器按规范抑制随后的 click → 对话框打不开」，比改前更糟（改前根本不起拖，按钮是好的）。实测：✎ 单独点击正常，一拖就死。

所以宿主收窄到 `.category-header`。

⚠️ **但收窄到分类头并不自动解决 ✎/✕——它们就在分类头里面。** 后代写 `draggable="false"` **不能豁免**：对照页实测，普通 `<button>`、写死 `draggable="false"` 的 `<button>`、`<h2>` 三种后代按下都照样起拖，`dragstart.target` 命中祖先。所以必须在 `pointerdown` 里对 `.category-action:not(.category-drag)` 显式 `preventDefault()`（对照页实测：取消后一个 `dragstart` 都不发，`click` 照常送达）。等到 `dragstart` 里再取消就晚了——拖影已出现、`click` 已丢。

代价是 `dragstart.target` 解析到 `.category-header`，而书签卡是 section 的子节点、且自己可拖拽（命中它时 target 就是 `<a>` 本身）——两条路径在该事件上不能靠 target 区分，因此分流靠 `pointerdown` 记住的真实落点（`downOnCategory`）。

`draggable` 必须由编辑态门控：常态首页整块可拖拽会劫持文字选中与点击。

**`dragstart` 的兜底分支要显式 `preventDefault()`。** 既不在分类头也不在书签卡上按下（例如 ＋ 卡片）时什么都不做，浏览器会照常画拖影而松手没有 drop——又是「能拖、拖了没反应」的死拖。

**注册与解绑必须成对。** `beginWidgetDrag` 的 `move` 曾经只有 `removeEventListener('pointermove', move)` 而从未注册，于是按下设好 `dragData`、指针一动就没人跟、`markDropSide` 连带成为死代码，而测试断言的是「监听挂在 window 且能解绑」——恰好跳过了「要先注册」。守卫要钉住 add 与 remove 的**数量相等**，不是「至少出现一次」。

**拖拽残留的清理要覆盖 `dragend`，不能只靠 `drop`。** `drop` 只在松手点位于 `#grid` 内才触发（监听挂在 grid 上），拖到页头或留白处松手走不到它；`.drop-target` 与 `.is-dragging` 视觉完全相同（同为 `opacity: .55`），漏清会让用户以为「卡住了」。同理 `exitEditLayout` 的注释声称清掉「全部拖拽残留」，就必须同时覆盖 `#grid` 与 `#moduleZone`，且 class 名要对（那里曾写着样式表里根本不存在的 `.drop-active`，整行是空转）。

### 触摸端与桌面端是两条判据，不是同一手势的两份实现

**原生 DnD 在触摸端不发任何事件。** MDN 写明 drag events **继承自 mouse events**（"drag events inherited from mouse events"），触摸没有 mouse 事件链。这是继承关系决定的，不是兼容性不足——CSS 的 `touch-action` 补不了，它只决定浏览器是否接管手势。模块卡片不受影响，因为它一开始走的就是 pointer 事件。

于是书签与分类有两条输入路径，**按 `pointerType` 互斥**：

| | 桌面（mouse / pen） | 触摸（touch） |
| --- | --- | --- |
| 机制 | 原生 DnD（`dragstart` / `dragover` / `drop`） | `pointerdown/move/up/cancel`（`bindTouchGridDrag`） |
| 激活 | 按下即起拖 | **长按 400ms**，容忍 25px 漂移 |
| 排序 | `moveCategory` / `moveBookmark` | 同一对函数 |

互斥是刻意的：桌面端若也进触摸路径，就要额外处理「一按就拖 vs 选中文字」——那是对已验证路径的回归风险。**排序逻辑只有一份**（`moveCategory` / `moveBookmark`），任何一侧自己 `splice` 就变成两个真值。

**为什么必须长按，而不是「一按就拖」或「位移阈值」**：书签网格在首页常常需要滚动浏览，一按就拖会把滚动抢走；纯位移阈值则会在滑页途中误判成拖拽。长按期间手指不动，浏览器不会开始滚动，于是两件事可以共存。这也是 `@dragdroptouch` 的 `pressHoldDelayMS` / `pressHoldMargin` 与 iOS 长按菜单的同量级取值。

**⚠️ 因此书签网格与分类头不写 `touch-action: none`**，这与 `.module-drag-handle` 是有意的不一致：模块把手在窄屏是横滑列表，没有纵向滚动需求；首页网格有滚动需求，写了就滚不动。触摸端要有东西，是 `user-select: none`（否则长按先选中文字）与 `-webkit-touch-callout: none`（否则 iOS 长按菜单与拖拽互相打断），两者都只在编辑态生效。

**「压暗谁」必须与「复原谁」是同一个元素。** 分类拖拽压暗的是整块 `.category`（CSS 就是 `.category.is-dragging`），而书签压暗的是卡片本身。收尾时若一律按 `node` 去 `remove`，section 上那层永远清不掉——提交时因为 `renderGrid` 重建 DOM 而被掩盖，但取消或落点无效时压暗就留在页面上。所以承载 class 的元素记进 `drag.tinted`，激活与收尾都读它。

**触摸端的落点用 `elementFromPoint`，不用坐标几何。** 网格会随拖拽重排，实时几何与缓存中线都可能失效（模块那条路径踩过这个坑，见 `reorderWhileDragging` 的注释）。

### 拖拽落点的守卫要排在解引用之前

`closest('.category')` 在「＋ 添加分类」按钮与网格间隙上返回 `null`。写 `this.config.categories[toCat]` 之前必须先判 `toCat < 0` 并**清掉 `dragKind`/`dragFrom`**——异常从事件监听器抛出时，监听器末尾的清理代码不会执行，拖拽状态就此卡住，下一次 `dragover` 仍认为在拖拽。

### 校验责任在前端

书签的标题非空与 URL 协议（只接受 `http:` / `https:`）由编辑模式的对话框 `validate` 把关。**`POST /api/config` 对 `categories` 只有一条形状检查**（必须是数组），不校验书签字段——实测 `javascript:alert(1)` 会原样落盘。所以这一层的守卫不能省。

### 尚未实现

- **触摸端已实现，但只在本机用合成 pointer 事件验证过**。真实触摸的手势语义（长按是否会先触发滚动、iOS 长按菜单是否真被压掉、`pointercancel` 何时到来）**没有在真机或真实触摸设备上验证过**——headless Chrome 不产生真实触摸。见 `current-work.md` 的「只在真机能确认」清单。
- **分类操作按钮 26×26px 低于 `--ctl-h: 44px` 的触摸下限**，同为鼠标/长按操作的设计取舍。已确认本轮不改（触摸端真正难按的是 ✎/✕，但改动会让编辑态头部变宽，另行决定）。

## 数据与请求路径

`server-config/index.js` 合并默认配置、可选的 `server-config.json`、`.env` 和环境变量。

⚠️ **`server-config.json` 会遮蔽 `server-config/` 目录**，这不是本项目的选择而是 Node 的解析顺序（`.js` → `.json` → `.node` → 目录）：该文件一旦存在于安装目录根下，`require('./server-config')` 返回的就是它的原文，`server-config/index.js` 一行都不执行，defaults 与 `rootDir` 全部落空。**因此 `server.js` 必须写成显式路径 `require('./server-config/index.js')`** —— 这是唯一让遮蔽不发生的方式；`rootDir` 不在 `defaults.js` 里（由 `index.js` 用 `__dirname` 推导后赋值），所以「把配置写全」补不出它。用户那份文件由后台「自签证书」开关写出（`POST /api/server-flags`，首次保存只写 `security` 一段），因此这条路径不是边缘情况。`server.js` 另在 `require` 之后调用 `assertConfigUsable(config)` 兜底：缺 `rootDir`/`server`/`paths`/`security` 或 `validate` 时直接报出文件名、遮蔽原因与两条修复命令，取代原先指不到真因的 `ERR_INVALID_ARG_TYPE`。`tests/config-shadowing.test.js` 用真实启动钉住「残片存在时服务照常起来、且残片仍被应用」，另有一条钉住显式路径与 Node 的解析顺序。首页在 `public/index.html` 中提前请求 `/api/config`（`cache: 'no-cache'`，服务端回 `Cache-Control: no-cache` + ETag）：浏览器缓存配置但每次用 ETag 校验，未变时服务端返 304（零响应体），既省去首屏往返的传输量，又保证配置始终最新——配置按认证态生成不同表示（公开视图不含 `privacyMode`），ETag 随之不同，登录态变化必得新 200，不会拿到旧的完整配置。`public/app.js` 复用该请求，渲染首页后再加载收藏及版本信息。服务端使用 compression 处理中等及较大的可压缩响应。Service Worker 仅缓存列出的同源静态资源。

运行时的 `config.json` 保存页面设置和分类，`favorites.json` 保存收藏，`.admin-password.json` 保存管理密码哈希，`.webdav-config.json` 保存 WebDAV 配置。这四个文件与会话库都承载私有数据，**由服务在创建/写入时收紧到 0600，并在每次启动兜底校正**（`server.js` 的 `writeJSON()` 与 `restrictPrivateFileModes()`；WebDAV 配置另在 `lib/webdav-backup.js` 的保存路径收紧）。不要把它们交给 `sylph.sh` 的 chmod 兜底：那几个文件是**应用首次启动时**才创建的，脚本里的 `[ -f ... ] && chmod` 跑在它们存在之前，对全新安装等于空操作（实测此前为 644）。这些文件由 `.gitignore` 排除，不能作为跨工具交接附件提交。**`nav-sylph.db` 是 SQLite 库，当前保存管理端会话**；`sylph.sh` 只把它加进更新失败的本地回滚清单，不参与 WebDAV 跨设备备份（会话令牌不是用户内容）。书签 HTML 的 `DATA-SYLPH-PRIVATE` 标记承载 Sylph 私密属性；修改导出、解析、恢复或备份版本时，应完整检查往返路径。

`GET /api/config` 和 `GET /api/favorites` 在没有管理密码时返回公开视图，只含首页需要渲染的部分：收藏过滤掉 `private` 条目并剥离 `private` 字段本身，配置剔除 `privacyMode`。带上正确的 `X-Admin-Password` 时才返回完整数据，供管理面板和私密检索使用。写入路径相应地按 id 合并而不是整份覆盖：`POST /api/favorites` 中既有的私密条目在请求体缺席时保留，`POST /api/config` 以现有文件为基底合并，因此公开视图未携带的 `privacyMode` 不会被保存动作抹掉。浏览器中的私密收藏筛选只是显示逻辑，服务端不再依赖它承担隔离职责。新增私有资产字段时，应先确认它是否应当进入公开视图。

管理端登录采用服务端会话：登录成功后签发 32 字节 CSPRNG 令牌（OWASP 要求 ≥128 位），用 `HttpOnly` Cookie 下发。**会话持久化在 SQLite（`nav-sylph.db`）中，不随进程重启或版本升级失效**——此前存在进程内 `Map` 里，`./sylph.sh update` 重启进程即把所有人登出。浏览器仍不保存明文密码：`X-Admin-Password` 只在登录那一次请求里出现，验证通过后改由 Cookie 承载；该头作为兜底保留，已打开的旧页面仍可用。

存储分三层，各自只做一件事：`lib/db.js` 管连接、PRAGMA 与 `user_version` 迁移，**驱动（`better-sqlite3`）只在这个文件里出现**，换驱动只改这一处；`lib/session-sqlite.js` 把 `sessions` 表适配成 `SessionStore` 需要的 6 方法后端接口（`get`/`set`/`delete`/`deleteAll`/`sweep`/`count`）；`lib/session.js` 缺省使用语义等价的内存后端，因此不传 `backend` 的调用方（含 `tests/session.test.js` 的 vm 加载方式）行为不变。**这套分层同时是未来模块的接缝**：新模块在 `lib/db.js` 的 `MIGRATIONS` 尾部追加一个台阶即可，不新建库文件、不改已发布的迁移项（老库 `user_version` 已领先，被改动的那一步不会再执行）。

会话在每次请求上滑动续期都会写一行，所以用 WAL（`journal_mode=WAL`，回滚日志下并发读写会互相阻塞）。库文件含令牌，`openDatabase()` 在打开后把主文件与 `-wal`/`-shm` 边车收紧到 0600，与 `.admin-password.json` 同级。**令牌落盘确实扩大了「磁盘可读即可窃取会话」的面**，缓解手段是文件权限、TTL 到期、以及改密码即 `destroyAll()`；这与「密码哈希本就落盘」属同一威胁级别。`server.js` 在 `init()` 内开库并据此构造 `sessionStore`（`requireAdmin` 等路由闭包与 60 秒清扫定时器都在其后才读它），`gracefulShutdown` 关库时 WAL 自动 checkpoint，因此升级与备份只需处理主文件。

配置、收藏与密码仍是 JSON，本次未迁移。

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

搜索栏三个按钮共用一套拟物结构，只在色相与明度上分层：`--mode-hue`（网页/收藏，青灰）、`--engine-hue`（引擎，琥珀）、`--submit-hue`（搜索，陶土）。各自的 `--HUE` 是底色、光感与按压阴影的唯一来源（`styles.css:2607`），因此三者共享同一条光感规则而不会走样。三个锚点必须在 `:root`、`@media (prefers-color-scheme: dark)`、`:root[data-theme="dark"]` 三处各定义一次（`styles.css:2607`/`2661`/`2715`），漏掉任一处则手动深色与系统深色表现分叉——`tests/homepage-material.test.js` 断言了三处计数与深色块的逐字一致。

按压语义分两级，不可混用同一视觉语言。**点击凹陷**是 `inset 0 4px 9px`（`--ctl-press-shadow`，过渡 28ms），比书签的 `inset 0 3px 6px` 更深更快；**模式按钮的选中态**（`[aria-pressed="true"]`，`styles.css:2780`）刻意做成「点亮」——外投影 + 更实的底色，不含整段 inset。若选中态也用 inset 阴影，用户无法区分「已切换到收藏」与「正在按下」。实心陶土按钮的凹陷另需加深填充才能读出效果，实心深底会盖住 inset 阴影。

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

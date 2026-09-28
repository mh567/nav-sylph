# 当前工作交接

核对日期：2026-09-28。本文供更换开发 Agent 或开发软件时快速接续。开始任务后，先运行 `git status --short --branch` 并检查近期提交，再更新本文件。

## 当前基线

修改前的基线：分支 `main`，与本地 `origin/main` 跟踪引用一致；最新提交为 `9ecc720`；`package.json` 版本 `1.5.6`。

分享功能改动已提交为 `39acce5`，发布前的两个缺陷修复为 `ee77a39`，v1.5.7 发布为 `7ab0981`，分享接口滥用防护为 `d3ee955`，分享编辑器交互改版为 `04895fc`，审计与视觉核验修复为 `ff63fd7`，发布前审查修复（回车回归 + 拖拽收尾 + `trust proxy` 注释订正）**尚未提交**。本地比 `origin/main` 领先两个提交，**尚未推送**。

## 本次完成的内容

三项分享相关需求。

**1. 分享保护面板。** 原来是「是否设置 PIN？」的确认框加二次 PIN 输入。现在 `showPasteOptions` 打开单个弹窗，直接展示两项设置：PIN 码保护复选框（默认不设，勾选后在同弹窗内联展开 4 位数字输入框），有效期单选组 5 分钟 / 30 分钟 / 1 天 / 7 天（默认 5 分钟）。服务端新增 `PASTE_TTL_OPTIONS` 白名单，`POST /api/p` 接受 `ttl`，缺失或非法值回落到 5 分钟，保持对旧客户端的兼容。

**2. 分享二维码。** 分享结果面板新增二维码，手机可直接扫码打开。生成在浏览器端用本地 `qrcode.js`（MIT，55KB，gzip 后约 11.8KB）输出 data URL 塞进 `<img>`，不用站外资源也不用 npm 依赖。生成失败时静默移除，不影响复制链接。过期文案不再写死「5分钟后过期」，改为按服务端返回的 `expiresAt` 计算。

**3. 分享接收页代码渲染。** `/p/:code` 接收页在解密后自动识别编程语言并高亮渲染。新增 `public/lib/highlight.min.js`（highlight.js v11.11.2，BSD-3-Clause，common 构建，125KB，gzip 后约 43KB）。

需要特别说明实现取舍：接收页原先用 hljs 的 `highlightAuto` 直接识别，实测在短片段上不可靠——15 个样本中 Python 片段被判成 scss / cpp / ini / ruby，JS 片段被判成 css，且 relevance 无法区分对错（判对与判错的 rel 值重叠）。分享内容天然是短片段，因此改为先用高精度正则签名层判定明确语言，hljs 只做高亮和兜底，自测 15 个样本命中 14 个。含中文的内容直接按纯文本处理，不做高亮。

`showUiDialog` 增加了可选的 `options` 参数以支持复选框与单选组，返回值从数组变为 `{ values, choices }`，因此 `promptValue` 和 `changePassword` 两处调用方同步调整。既有对话框调用方（`confirmAction`、`notice`）不受影响。

## 发布前代码审查发现并修复的缺陷

**缺陷一：有效期白名单可被原型链绕过，导致条目永不过期。**
`PASTE_TTL_OPTIONS[ttl]` 原本直接用裸对象取键。请求体传 `{"ttl": "constructor"}` 时取到 `Object` 构造函数，`Date.now() + ttlMs` 变成字符串，`cleanExpiredPastes` 与取内容时的 `Date.now() > paste.expiresAt` 判断恒为 false——**该密文永久不过期、永久不被清理**。由于 `POST /api/p` 本身没有速率限制（既有问题），攻击者可持续堆积内存，且 `expiresAt` 回传给前端会显示为 `NaN天`。

修复：白名单改用 `Object.assign(Object.create(null), {...})` 断开原型链，并新增 `resolvePasteTtlMinutes()` 收紧类型——只有有限整数才接受，且用 `Object.hasOwn` 确认是白名单自身的键。字符串 `"5"`、`null`、`5.5`、`true`、数组、对象等一律回落到 5 分钟。

**缺陷二：有效期单选项未实现浏览器原生互斥。**
四个 radio 曾被生成为各自不同的 `name`（`opt1`~`opt4`），浏览器因此不会互斥，用户可以同时勾选多档。测试桩当时按 `data-name` 手工模拟互斥，**掩盖了这个 bug**。

修复：同组选项共用 `name="opt_<选项名>"`，浏览器原生互斥恢复生效。同时把 PIN 输入框的文案与长度从通用对话框中移出（改由 `showPasteOptions` 通过 `reveal` 参数传入），避免 `showUiDialog` 这个通用组件硬编码 PIN 领域知识。

已在真实浏览器用真实鼠标点击确认：四个 radio 的 `name` 均为 `opt_ttl`，点击「1 天」或「7 天」后始终恰好只有一个 checked。

**顺带修正的文档失真**：`docs/current-work.md` 原写「本次修改尚未提交」，与实际提交状态不符，已按实际更新。

## 分享接口滥用防护

发布 v1.5.7 后对分享接口做了实测攻击，结论基于实际请求而非代码推测。

**修复前实测到的可利用问题：**

- 绕过 `/api/p/code` 直接打 `POST /api/p`，连发 **200 次全部创建成功**，`/api/p/code` 一次都没碰过。创建入口的 `ip` 变量取了值却从未使用。
- 灌入 200 条 × 99KB 内容（7 天档），进程内存 95.8MB → 116.7MB，且这些条目 7 天内不会被清理。
- 500KB 请求返回 Express 默认 HTML 错误页，含 `node_modules/raw-body/index.js` 完整调用栈与服务器绝对路径。

**修复前已防住的：** 超大文本（超 100000 字符拒绝）、超大文件（1MB 返回 413）、XSS 载荷（可存储但服务端不存明文，接收页用 `textContent` 兜底）、PIN 爆破（3 次错误即销毁）、分享码枚举（存在与不存在的文案一致）、JSON 解析炸弹（5000 层嵌套无影响）。

**本次修复：**

1. `POST /api/p` 接入创建限流。取码 10 次/小时、创建 20 次/小时、读取 30 次/小时，三个入口用不同 key 独立计数，避免互相消耗配额。
2. 开启 `app.set('trust proxy', 1)`。此前未设置，反代部署下 `req.ip` 恒为 `127.0.0.1`，限流退化为全局单桶——攻击者打满会连带锁死所有正常用户。用跳数而非 `true`，否则能直连端口的客户端可伪造 `X-Forwarded-For` 轮换 IP 绕过限流。
3. 新增全局容量上限：500 条 / 50MB 双阈值，超出返回 503。**不做最旧条目驱逐**，避免静默清掉他人仍在有效期内的分享。
4. 限流 Map 纳入 60 秒定时器清理。开启 `trust proxy` 后 key 数量等于访问者数量，不清理会立刻变成新的内存放大器。定时器同时加了 `unref()`，不再阻止进程自然退出。
5. 新增全局错误处理中间件，413 统一返回 JSON，不再回显堆栈。
6. 接收页 `data.error` 由拼接 `innerHTML` 改为 `textContent`，不再依赖「服务端错误文案恒为固定字符串」这一隐含前提。

限流逻辑重构为纯函数（`consumeRateLimit` / `sweepRateLimitStore` / `isOverPasteCapacity`），store 与时钟由调用方注入，便于确定性测试。

**已排除的误判**：CORS 曾被怀疑是「回显任意 Origin」的漏洞，实际不是。`server.js:211` 的比较式硬编码了 `http://${config.server.host}:${config.server.port}`，反代部署下浏览器 Origin 与之永不相等，因此任意第三方 Origin 都拿不到 `Access-Control-Allow-Origin`。这是过度收紧（误伤）而非放开。

## 分享编辑器交互改版

进入文本分享模式后，搜索框变为可编辑的分享编辑器。

**改版前发现的核心问题**：`styles.css` 文件尾段的「新版样式」区块（改版前 2676-2677 行）重复声明了 `.search.paste-mode .search-input`，把早先 621-624 行设计的 `min-height: 60px` 压回 `36px`、padding 压回 `0 10px`。同特异性下后来者胜，因此**展开效果早已静默失效**，分享态与搜索态高度完全一致。移动端 899-901 行的 `min-height: 50px` 因位于覆盖规则之前，同样是死代码。

**改动**：

- 编辑区 `<input>` 换为 `<textarea>`。单行 input 在 HTML 规范上无法换行，也无法撑开多行内容。
- 分享态样式集中到「Paste 分享模式」区块（现 609-644 行）作为唯一定义处，删除尾段的重复声明。编辑器 `min-height: 96px`、`max-height: 60vh`、`resize: vertical`。
- 新增 `autoGrowPasteInput()`：按 `scrollHeight` 写入 inline height 使编辑框随内容增删同步伸缩，并 clamp 到 `max-height`，避免留下永不生效的大值。用户拖动右下角把手后置 `pasteUserResized`，此后不再自动跟随；退出并重新进入时重置。
- 左侧「网页」按钮在分享态变为「退出」，用双 span 切换文案；退出时清空输入并回到搜索态，不再跳转收藏检索。`Esc` 提供同一行为（桌面增强，移动端无 Esc 键）。
- 右侧按钮「搜索」改为「发送」。搜索引擎按钮改由 CSS `.search.paste-mode #engineBtn` 隐藏，不再用内联 `style.display`（内联样式无法参与过渡且会盖过样式表）。
- 键盘：回车发送，`Shift`/`Ctrl`/`Cmd`+回车换行。搜索态保持原生行为。
- 结果面板与编辑框同宽（同为 `.search-wrapper` 直接子元素），圆角与间距调整为读作编辑器的输出区，并补上新版响应式段落此前缺失的窄屏规则。

**浏览器验收中发现并修复的缺陷**：首轮实现只写了 `min-height` 没写 `height: auto`，textarea 高度锁死在 96px 不随内容增长。真实 Chrome 实测 1→20 行高度恒为 96px、`scrollHeight` 却涨到 492px（内容被压在内部滚动条里）。补 `height: auto` 与 `autoGrowPasteInput()` 后复验通过。

## 代码审计（基线 `7ab0981...HEAD`）

对 `d3ee955`（限流安全修复）与 `04895fc`（分享编辑器改版）做了 Standards 轴审计。**已修**三项：

1. `docs/current-work.md` 的完成状态与仓库实际不符（写「尚未提交」但已提交）——已更新为 `04895fc`。
2. 退出分享态的复位序列在「退出」按钮与 Esc 两处逐行重复。现抽成 `exitPasteMode()`，两条路径共用；并把 `handleSearchInput({ target: input })` 这种伪造事件对象的写法收敛为直接传元素。
3. `tests/paste-composer.test.js` 的 Enter/Esc 两例**自证式**：用 `new Function` 在测试里重写一份 handler 再断言它自己的行为，`app.js` 改坏时仍然全绿。现改为调用真实的 `app.bind()`，捕获它注册进去的 `keydown` 与 `document.onkeydown` 引用来驱动。

重写测试时踩到两个坑，均已修正：

- DOM 桩的 `querySelector` 对未注册选择器原本返回一个**可见**元素（`hidden: false`），导致 `handleFavKeydown` 把不存在的收藏下拉当成展开状态、吞掉 Esc。改为返回 `null`，与浏览器一致。
- 新增的去重断言第一版写成「数 `pasteMode=false` + `togglePasteMode(false)` 相邻对」，结果正常代码有 3 处（收藏态退出、`exitPasteMode`、分享成功）而误报；改成先剥掉 `exitPasteMode` 方法体再检查其余位置是否内联了清空草稿。

**已推翻的发现**见上节「已排除的误判」。

红绿验证（改坏 `app.js` 确认测试会红）：

| 破坏方式 | 结果 |
| --- | --- |
| Esc 分支改 `this.pasteMode && false` | 第 12 项失败 |
| Enter 拦截加 `\|\| true` 短路 | 第 11 项失败 |
| Esc 分支重新内联复位序列 | 第 12、14 项失败 |

## 浏览器视觉与交互核验

用真实 Chrome（agent-browser）在临时副本上做了 A/B/C 三组核验，截图与测量值留在 scratchpad。**三条最严重的问题，两条属实已修，一条被推翻。**

**已修 1：展开动画整条失效（`styles.css:2671` 覆盖 `:616`）**。`.search` 被声明三次，最后一条整块覆盖了「Paste 分享模式」区块里的 `transition`。实测 `getComputedStyle().transitionProperty` 只剩 `border-color, box-shadow, background`——`min-height` / `padding` / `border-radius` 全部没有参与过渡。`:614-615` 专门写的注释解释了「height:auto 不可过渡，故过渡 min-height」，而这段设计从未运行过。这与改版前修的是**同一类错误**（尾段新版区块覆盖前面），而当时的守卫只覆盖了 `.search.paste-mode` 后代规则，漏了 `.search` 自身。已把 `:2671` 的 transition 补齐，并新增守卫断言：最后生效的 `.search` transition 必须含 `min-height` / `padding` / `border-radius`，且与 composer 区块声明的完全一致。

**已修 2：一次失败的拖拽会永久锁死自增高**。`pointerdown` 命中把手就无条件置 `pasteUserResized = true`，不区分拖拽是否真的成功。实测把把手向上拖 60px（撞上 `min-height`）后，inline height 被写成 `36px`（被 CSS 钳到 96px，永不生效的死值），自增高就此关闭；之后输入 10 行内容，高度**永久停在 96px** 而 `scrollHeight` 涨到 300px，全部转入内部滚动。对照组（不做失败拖拽）同样 10 行，高度正常长到 492px。修法：`pointerup` 时读回实际渲染高度，若未高于 `min-height` 则清掉标记与内联高度并重新自增高；真正拖成功的仍保留用户选择。

**已修 3：编辑区 `aria-label` 在分享态不更新**。placeholder 已改成「输入要分享的文本…」，`aria-label` 仍是「搜索网页或收藏」。`aria-label` 优先于 placeholder 播报，读屏用户会听到「搜索网页或收藏」却在里面写分享文本。同一函数里左侧按钮的 `aria-label` 有正确切换，属编辑区的单点遗漏。已在 `togglePasteMode` 两个分支同步。

**已推翻：拖拽把手与「发送」按钮命中盒重叠**。首轮评估报告称水平重叠 5px、垂直重叠 6px。二次独立核验**不成立**：两个视口下 textarea 右边缘到按钮左边缘净空均为 **4px**，把手命中盒与按钮水平重叠 **0px**；在按钮左下角取 `elementFromPoint` 命中的是 `<form>`（圆角死区），并非 textarea，因此点击按钮不会误触发拖拽。首轮的数字来自推算而非实测。

**核验通过、未改动的项**：反复进出分享模式 3 轮，16 个字段逐位复现基线、零状态残留；快速输入 `>` 立即删除无闪烁；回车弹面板后取消，内容/高度/焦点/分享态全部保留；编辑框拖到 60vh 时「发送」始终在视口内可点（560px 高视口下 send 底边 430 < 560）；390×844 窄屏无横向滚动、媒体查询正常；暗色主题编辑器对比度充足。

**核验发现、本次未改**：

- 分享成功会清空编辑内容并让编辑器塌回搜索态（无撤销、无草稿兜底），关闭结果面板后焦点掉到 `<body>`。这是产品行为改动而非缺陷修复，需产品决策。
- 96px 初始高度下只有一个字时偏空（末行以下留白 60px）。属设计意图，核验建议保留。
- 暗色主题下原生拖拽把手是低对比度系统灰，与「发送」按钮叠在一起像渲染瑕疵。若要改需 `resize: none` + 自绘 grip，属独立改动。
- 「退出」贴左上、「发送」贴右下构成对角对称（内缩均为 11px/13px），核验实拍三种替代方案后判定现方案更协调，不改。

console 全程零消息。

## 发布前审查（基线 `7ab0981...HEAD`）

发布 v1.5.8 前的代码审查，**两条阻塞项属实、已修**，一条结论被推翻。

**已修 1：搜索态回车搜索失效（严重回归）**。改版把搜索框从 `<input>` 换成 `<textarea>`，而 textarea 的裸回车**默认插入换行、不提交表单**，原 keydown 处理器又只在 `pasteMode` 为真时接管，于是 `onsubmit` 永远不会被裸回车触发。真实 Chrome 实测：搜索态输入 `test` 按回车，`window.open` 调用 **0 次**、输入框被插入换行符（charCode 10）、页面无反应——用户只能点「搜索」按钮。违反 AGENTS.md 第 1 条「保留已有搜索行为」。

**为何没被抓住**：`tests/paste-composer.test.js` 里那条断言把它**当成了正确行为**（`prevented === false`，注释写「search mode keeps native newline behaviour」）。测试固化的是回归本身。已改为两种模式都接管回车，并把断言倒过来。

**已修 2：拖拽 `pointerup` 可能永不触发**。`settleDrag` 原先以 `{once:true}` 挂在 input 上，无 `setPointerCapture` 也无 `pointercancel` 兜底——拖到元素外松手就收不到事件，`pasteUserResized` 永久为 `true`、自增高被锁死；同文件的 `bindBookmarkPress` 已有 window + pointercancel 的正确范式。已改为挂在 window 上并补 pointercancel。

**已推翻：`docs/current-work.md` 与 `server.js` 注释对 `trust proxy` 的结论**。原文称「用跳数而非 `true`，否则能直连端口的客户端可伪造 XFF 轮换绕过限流」。实测（`app.set('trust proxy', 1)` + socket 直连）：`X-Forwarded-For: 9.9.9.9, 8.8.8.8, 7.7.7.7` → `req.ip === '7.7.7.7'`（最右一跳）。而**跳数 1 信任的正是最右那一跳，恰是客户端能自己写的那一跳**。实测攻击成立：固定 `9.9.9.9, 5.5.5.5` 打满 30 次触发 429 后，只把最右改成 `6.6.6.6` 即恢复 200，再改 `4.4.4.4` 又恢复——**桶可无限轮换**。反观 `true`，因取最左反而在本场景下不被追加影响。

修正后的准确表述：`1` 是**在 nginx 前置且端口不对外暴露时的正确配置**（`DEPLOYMENT.md:139` 用 `proxy_add_x_forwarded_for` 追加 `$remote_addr` 到最右，攻击者的原始 XFF 被完全丢弃）；**若能绕过 nginx 直连端口，`1` 与 `true` 都会被追加式 XFF 轮换绕过**。这不是配置错误，是部署前提——已改写注释与文档（见下），未改代码。

**未采纳的判断题**：全局错误中间件缺 `if (res.headersSent) return next(err)` 守卫（`server.js:203`）。当前无异步路由在 `res.json()` 之后抛错的路径，属预防性加固，单独评估。

## 实际验证

- `node --check`：`server.js`、`public/app.js`、`public/sw.js`、`public/lib/qrcode.js`、`public/lib/highlight.min.js`、`tests/dialog-regressions.test.js`、`tests/paste-ttl.test.js`、`tests/share-guards.test.js`、`tests/paste-composer.test.js` 全部通过。
- `node --test tests/*.test.js`：65 项全部通过（原 46 项 + 新增 19 项）。

发布前修复的真实 Chrome 复验（三态回车 + 元素外松手）：

| 场景 | 按键 | 实测 |
| --- | --- | --- |
| 搜索态 | 裸回车 | `window.open("https://www.google.com/search?q=test")`，输入框清空，**无 charCode 10** |
| 分享态 | 裸回车 | 弹出分享保护面板（未创建分享），取消后内容/高度/分享态全保留 |
| 分享态 | Shift+回车 | 插入换行符，**不弹面板** |
| 分享态 | 拖到元素外松手 | `pasteUserResized` 复位为 `false`，随后 10 行内容自增高到 252px（与不拖拽的对照组一致） |

以上复验 console 全程零消息。
- `git diff --check`：无空白或冲突标记问题。
- 首页首屏回归：`public/index.html` 未引入 highlight.js，只新增了 `lib/qrcode.js`（55KB，gzip 后约 11.8KB）。

修复缺陷的验证：

- `tests/paste-ttl.test.js` 覆盖白名单四档、缺失值与多种非法值回落，以及 `constructor` / `__proto__` / `toString` / `valueOf` / `hasOwnProperty` 五个原型键不能污染 `expiresAt`。该测试**已确认在修复前的代码上失败**（还原旧写法后 5 项中 2 项报错），修复后通过。
- `tests/dialog-regressions.test.js` 中的互斥测试断言四个有效期 radio 共用同一个 `name`，并模拟浏览器 change 语义确认任意时刻只有一个 checked。测试桩此前按 `data-name` 模拟互斥而掩盖了缺陷，现已改为按 `name` 分组，与浏览器行为一致。
- 真实服务验证原型链绕过已堵住：`ttl` 传 `constructor` / `__proto__` / `toString` / `valueOf` / `hasOwnProperty` 全部回落 5 分钟；四档合法值仍分别得到 5 / 30 / 1440 / 10080 分钟；字符串 `"5"` 回落 5 分钟。服务端日志确认 `expires in Nmin` 正确。

滥用防护的验证：

- `tests/share-guards.test.js` 共 13 项。**已确认红绿两轮**：把修复逐项还原后，4 个接线测试（创建限流、容量上限、trust proxy、错误中间件）失败；恢复修复后 13 项全绿。
- 该测试的接线断言只匹配可执行代码（先剔除整行注释）。第一版没有这层过滤，把 `app.set('trust proxy', 1);` 注释成 `// (reverted) ...` 后断言仍然通过——即测试能被一行注释骗过，已修正。
- 真实服务实测创建限流：绕过 `/api/p/code` 连打 `POST /api/p` 30 次，前 20 次成功、**第 21 次起返回 429**，与 20 次/小时设定精确一致（修复前实测 200/200 全通过）。
- 真实服务实测按 IP 分桶：已耗尽配额的原 IP 之后，带新 `X-Forwarded-For` 的请求返回 200；两个不同 IP 各打 3 次均成功，互不影响。
- 真实服务实测容量上限：用 60 个 IP 累积创建，创建到 469 条（叠加存量共 499 条）后开始返回 503，总数稳定在 500 未突破。
- 真实服务实测 413：500KB 请求返回 `{"error":"内容过大"}`，`Content-Type: application/json`，响应体不含 `node_modules`、错误类型名或调用栈。
- 功能回归 10 项全通过：取码、创建、接收页 200、端到端加解密往返、阅后即删、`requirePin`、错误 PIN 剩余次数、正确 PIN 解密、原型链键仍回落 5 分钟。

分享编辑器的验证：

- `tests/paste-composer.test.js` 共 15 项。**已确认红绿两轮**：`git stash` 还原改版前的三个文件后，11 项失败；恢复后 15 项全绿。
- 其中「样式只定义一处」「编辑器为 textarea」「无内联 display」「高度自增」「clamp 到 max-height」等断言，直接针对本次修复的根因——改版前那处重复声明正是靠这类断言防住的。
- 真实 Chrome 验收（视口 1280×577，60vh = 346.2px）：
  - 分享态初始 96px，容器 118px；搜索引擎按钮 `display:none`、宽高 0/0；左侧按钮文案「退出」、aria「退出文本分享」；右侧「发送」。
  - **自增高**：1/3/6/12 行对应高度 96/96/156/300px，每步 `rect.height === scrollHeight`（零内部溢出）。1 行与 3 行同为 96px 是 `min-height` 地板的正确表现。
  - **收缩**：从 12 行删到 6/3/1 行，高度 300→156→96 逐级回缩，与对应行数的增高值完全一致，双向对称。
  - **封顶**：30/60/100 行时可见高度稳定 346.19px，不随内容增长。
  - **拖拽互斥**：用真实鼠标拖拽右下角把手到 251px 后，`pasteUserResized` 变为 `true`；继续输入到 18 行高度仍保持 251px。
  - **重置**：点「退出」再重新进入，`pasteUserResized` 归 `false`，高度回到 96px，自增高恢复。
  - 键盘：`Shift+Enter` 换行不提交；普通 `Enter` 弹出分享保护面板（未完成创建）；Esc 与「退出」按钮行为一致。
  - console 全程 0 条消息；网络日志确认未点「发送」，限流额度未消耗。

真实 HTTP 验证：在临时目录启动服务并造数据，验证结果全部通过。

- 端到端加密往返：创建 → 接收页取密文 → 解密还原与原文一致；接收页不内联明文；阅后即删仍然生效。
- PIN 流程：`requirePin` 返回、错误 PIN 返回剩余次数、正确 PIN 解密成功、服务端拒绝非 4 位 PIN。
- 接收页模板以绝对路径 `/lib/highlight.min.js` 引用高亮库（相对路径会解析成 `/p/lib/...` 而 404）。
- 安全验证：把 `<script>`、`<img onerror>`、`<svg onload>`、`javascript:` 等注入载荷交给高亮库处理，输出均已转义，未出现可执行标签。

真实浏览器验证（agent-browser + Chrome）：

- Python 分享页：内容正常解密，`#content` 带 `hljs` class，生成 17 个高亮 span，关键字与字符串实际取到不同颜色，非纯文本；console 零消息；`/lib/highlight.min.js` 返回 200。
- 中文纯文本分享页：`#content` 无 `hljs` class，无 span 包裹，按纯文本显示，未被误判为代码。
- 分享保护面板：PIN 复选框与四个有效期单选项均直接展示，勾选 PIN 后输入框在同弹窗内展开，无二次弹窗。
- radio 互斥：用真实鼠标点击「1 天」「7 天」，每次读取四个 radio 的 `name` 均为 `opt_ttl`，且始终恰好只有一个 checked。
- PIN 输入框初始隐藏：在勾选复选框前读取，其容器 `display: none`、布局盒为 0×0、`offsetParent` 为 null，且未进入无障碍树；勾选后变为可见并自动获得焦点；取消勾选后重新隐藏，开合对称。
- 分享结果面板：二维码 `src` 为 `data:image/` 开头，渲染尺寸 160×160，过期文案显示「1天后过期」并与所选档位一致。
- 首页：用正确结构的配置加载，`#loader` 移除、`#app` 可见、搜索框与收藏格子正常、所有请求 200、console 零消息。

验证脚本与临时服务均为一次性使用，已删除；验证期间未修改任何真实数据文件，仓库工作区无残留进程与临时文件。

## 已排除的误判

- **「搜索态下 textarea 高度锁死 36px，多行内容进内部滚动条，属功能退化」** —— 审计提出，经核实不成立。`autoGrowPasteInput()` 有 `if (!this.pasteMode || this.pasteUserResized) return;` 守卫，搜索态根本不写 inline height，交给 CSS 的 `min-height: 36px`。这是刻意设计：搜索框本就该单行，`textarea` 只是分享态的载体。审计建议「进入分享态时补一次调用」，照做反而会让搜索框在长文本时突然变高。
- **「`this.exitPasteMode()` 应在两处之外还有第三处调用」** —— 排查后确认 `pasteMode = false` 在 `handleSearchInput`（切到收藏检索）与 `createPaste` 成功（展示结果）时也会出现，这两处是各自独立的正确逻辑，不是重复。
- **「`trust proxy` 用跳数 1 即可防住 XFF 伪造」** —— 原注释与文档都这么写，实测不成立。跳数 1 取最右一跳，而最右恰是客户端能自己写的那一跳，追加即可无限换桶。正确结论是「前提为端口不对外暴露」，与取值无关。已改写 `server.js:193-199` 注释与 `docs/architecture.md:37-39`。

## 未完成与后续

1. 二维码未做真机扫码实测。已确认 data URL 生成正确、尺寸正常，但「实际能否被手机相机扫出」需要真机验证。
2. **分享编辑器的移动端手感未实测**。`Shift+Enter` 在 iOS/Android 软键盘上行为不一致（部分键盘不提供稳定的 Shift 键），真机上可能无法换行；届时需考虑加一个显式「换行」按钮。窄屏（≤480px、≤370px）下的编辑框与结果面板布局、拖拽把手在触屏上的可用性也都未在真机验证。
3. **分享结果面板与编辑框的同宽对齐已在浏览器中确认**。实测面板与容器的 `leftDiff` / `rightDiff` / `widthDiff` 均为 0，上间距 14px 与 `margin-top` 一致，内部排布（分享码 30px → 二维码 160px → 复制按钮 36px → 过期提示 16.5px）垂直节奏递减合理。二维码仍未做真机扫码验证。
4. **动画观感未做主观评估**。展开与收回的过渡已修复（原被 `styles.css:2671` 覆盖而完全失效），但时长与曲线是否自然未在浏览器中看过。`height: auto` 本身不可过渡是 CSS 限制，因此编辑框的增高是硬切，只有容器 padding/圆角/底色的过渡会生效。
5. **拖拽把手的 18px 命中阈值依赖坐标判断**。`pasteUserResized` 通过 pointerdown 落点是否在右下角 18px 内判定。若浏览器或主题改变把手的视觉尺寸，该阈值需相应调整；目前为实测可用值。失败拖拽已能在 pointerup 时回退，但阈值本身仍靠经验值。
6. **分享成功即销毁用户刚写的内容**。创建分享后编辑器清空、塌回搜索态，无撤销、无草稿兜底（实测 `localStorage` 为空），关闭面板后焦点掉到 `<body>`。改法有两种：保留草稿与分享态让用户能改后重发，或收成「已分享 · 编辑 · 重新发送」的摘要条。属产品行为改动，未擅自决定。
7. **暗色主题下原生拖拽把手是低对比度系统灰**，与「发送」按钮叠在一起像渲染瑕疵。要改需 `resize: none` 并自绘 grip，属独立改动。
8. 语言识别未做系统性评测。上面的 14/15 基于 15 个人工构造样本，不是覆盖真实代码的语料；短片段的边界情况（如只有两三行的片段、混合语言注释）可能仍判错。识别错误只影响配色，不影响内容正确性。
9. 接收页改用 `innerHTML` 渲染高亮结果，安全前提是 highlight.js 自身完成 HTML 转义。该前提已用注入载荷验证过，但升级 highlight.js 大版本时必须复核。
10. 新增两个本地库（合计约 180KB，gzip 后约 55KB）的加载耗时尚未在国内网络与移动端实测。其中 `highlight.min.js` 只在分享接收页加载，不影响首页首屏；`qrcode.js` 以同步 `<script>` 进入首页，虽只在进入分享模式时实际使用，但仍占用首屏带宽，后续可改为按需动态加载。
11. 有效期放到 7 天放大了「存储是进程内 `Map`、重启即丢」的既有缺陷——重启服务后历史分享立即失效。7 天档在当前存储模型下并不保证内容存活 7 天。若要真正支持长有效期，需要持久化存储，属于架构级变更，未在本次范围内。
12. **限流参数的取值未经真实流量校准**。20 次/小时、500 条、50MB 三个阈值是按个人工具场景估的，没有真实访问数据支撑。若实际使用中频繁误伤正常用户，或仍嫌宽松，需按观察调整。这些值目前是 `server.js` 里的裸 `const`，未接入 `server-config`（`config` 在 require 时已 `Object.freeze`，新增 section 需改 5 处），改完要重启服务。
13. **限流 Map 的定时清理未做端到端验证**。`sweepRateLimitStore` 的行为已由单测覆盖，但真实清空需等待超过 1 小时的窗口，本次会话内无法实测。定时器本身每 60 秒触发一次，可在下个版本发布后回查内存是否随访问 IP 数增长而线性上升。
14. **`trust proxy` 的防伪依赖网络层隔离，而非取值本身**。实测：socket 直连 + `trust proxy = 1` 时，客户端往 `X-Forwarded-For` 末尾追加任意 IP 即可为每次请求换一个新限流桶，打满后逐次改写可无限轮换（`true` 在直连场景下取最左反而不受影响，但有真实反代时语义又翻转）。因此 `DEPLOYMENT.md` 里「不直接暴露 4000 端口」是**限流成立的前提**，目前没有机制强制。若要纵深防御，可在应用层校验 `X-Forwarded-For` 的 entry 数量，超过 1 个即拒绝或回落到 socket 地址。
15. `pasteExpiryText` 用客户端 `Date.now()` 推算剩余时间，接收端时钟偏移会让文案显示错误；更稳妥的做法是服务端直接下发剩余秒数。此外有效期档位表在前端 `showPasteOptions`、后端 `PASTE_TTL_OPTIONS` 与 `pasteExpiryText` 回退值中各写了一份，存在重复，可提取为单一来源。
16. 分享码用 `Math.random()` 非加密安全；`isPasteCodeFormat` 正则 `/^[a-z]{2,6}-\d{3}$/` 与生成器词表不一致（`noodle`、`coffee` 等超过 6 个字母的词无法通过校验，生成的分享码可能取不回来）。命名空间仅约 18 万。属分享码设计问题，需换生成策略。
17. 分享保护面板的键盘操作（Tab 焦点流转、Esc、遮罩点击）已在 DOM 桩测试与真实浏览器点击中验证，未做完整的键盘可达性走查。
18. 其余已知问题均未改动：CORS 硬编码 `http://` 导致反代部署下跨域被拒（是误伤不是漏洞）；缺 HSTS / `Permissions-Policy`；写操作无 CSRF 校验；管理密码明文经 `X-Admin-Password` 逐请求校验，无会话、令牌或过期。

## 下一位 Agent 的启动步骤

1. 阅读根目录 `AGENTS.md`、`README.md`、`docs/architecture.md` 及本文件。
2. 核对 `git status --short --branch`、`git log -5 --oneline`、`package.json` 和与新任务相关的代码。
3. 明确本次目标与完成条件，实施后运行定向检查及 `node --test tests/*.test.js`。
4. 在交接前记录实际修改、验证命令与结果、未完成事项。只有发生稳定架构变化时才更新 `docs/architecture.md`。

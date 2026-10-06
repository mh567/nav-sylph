# 当前工作交接

核对日期：2026-10-06。本文供更换开发 Agent 或开发软件时快速接续。开始任务后，先运行 `git status --short --branch` 并检查近期提交，再更新本文件。

## 最新一轮：新增「备忘录」模块（v1.11.1；v1.11.0 为功能首发）

用户原话（`/grill-me`）：「新开发备忘录模块（只有登录后才能用），可增删改查备忘录内容，并可将指定备忘固定在最前面，备忘录可通过服务器自动实时同步，并反馈同步状态，手动同步时也反馈同步状态」。

按仓库约定走完三步才动代码：grilling 定 14 项决策 → `docs/mockup-memo.html` 仿真样例（8 个工具栏控件可强制各状态）→ 书面计划 `~/.commandcode/plans/memo-module.md`（含「不在本次范围」与验证命令清单）→ 批准后实现。

### 定稿决策（14 项，用户全部「同意所有」/「同意」）

| # | 决策 | 结论 |
| --- | --- | --- |
| Q1–Q3 | 端数 / 内容 / 置顶 | 多设备同步（服务器为唯一真相源）；标题 + 纯文本正文；多条可置顶，组内按更新时间倒序 |
| Q4 / Q6 | 删除 / 容量 | 硬删除 + 两步确认；≤200 条、标题 ≤60 字符、正文 ≤10KB |
| Q7 | 存储 | **SQLite 新表**（`MIGRATIONS` 尾部 v4）——`server-config/index.js:166` 的 `rootDir` 把 JSON 路径钉在仓库根，加一个 `.memos.json` 要同时改 `PRIVATE_FILES`、`ensureFile`、`sylph.sh` 两处、WebDAV 三处；`architecture.md:205` 早已写明这条路线 |
| Q8 | 入口 | 模块区模块（`registerModule`），「只有登录后才能用」由现成门控免费获得 |
| Q9/Q12 | 同步机制 | 轮询：挂载拉一次 → `pollInterval`（白名单 10/15/30/60/300，默认 15s）→ `visibilitychange` 切回前台立即补拉 |
| Q10/Q11 | 冲突 / 离线 | LWW 直接覆盖；断网时暂存 `localStorage`，恢复后随轮询自动补传，卡片显示「N 条待同步」 |
| Q13 | 搜索 | 纯前端。**对 grilling 推荐的修正**：用子串 `includes` 而非 uFuzzy——uFuzzy 是英文模糊匹配，对中文无分词能力 |
| Q14 | 卡片形态 | 卡片 = 置顶/最近摘要行，点击开完整管理对话框（server-monitor `openPanel` 同路线） |

### 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `lib/db.js` | `MIGRATIONS` **尾部**追加 v4（`memos` 表：id/title/body/pinned/created_at/updated_at），已发布的台阶一字未动 |
| `server.js` | `MEMO_*` 常量、`memoRateLimitMap` + `memoLimit`、并入 60 秒 sweep、五条路由（`GET/POST /api/memos`、`POST /api/memos/:id`、`POST /api/memos/:id/pin`、`DELETE /api/memos/:id`），全部 `rateLimit, requireAdmin, memoLimit`；`GET` 顺带回当前生效的 `pollInterval` |
| `public/modules/memo.js` | 新模块（`registerModule` + `mountWidget` + `openPanel`），~640 行 |
| `public/app.js` | `KNOWN_MODULES = ['server-monitor', 'memo']` |
| `public/styles.css` | 备忘录样式块（含窄屏 44px 触控下限与 `(hover: none)` 常显行内操作） |
| `public/sw.js` | `ASSETS` 加 `/modules/memo.js`；`CACHE` `nav-v68 → nav-v69` |
| `tests/fav-tab.test.js` | 缓存名守卫同步到 `nav-v69`（仓库既有的每轮同步项，连同用例名一起改） |
| `tests/memo.test.js` | 新增 16 条（见下） |

**存储面的一个必须说清的取舍**：`memos` 表随 `nav-sylph.db` 走 `sylph.sh` 的升级备份，但**不进 WebDAV 跨设备备份集**（与 `sessions` / `module_cache` / `agent_metrics` 同列）。跨设备靠服务器本身（那正是同步的真相源），不是靠备份。

### 验证

- `node --test tests/*.test.js` → **465 pass / 0 fail**（基线 449 + 新增 16；已用用例名 grep 确认参与全量运行，不是只跑了单文件）
- 新增 16 条的构成：迁移表结构、五条路由**逐条**带 `rateLimit, requireAdmin`（正向枚举 + 计数 5）、限流桶登记进 sweep、真实处理器（vm 抽出 + 真实 SQLite）上的 CRUD/排序/pin 不动 `updated_at`/容量 200→201/服务端字段校验/404、`memoToClient` 形状、`KNOWN_MODULES`、SW 预缓存与缓存名同一性、**用户文本逐处 `esc()` 的正向枚举**、**模块不得引用裸 `API` 标识符**、**模块 id 不得与页面既有 id 冲突**
- **红绿 5/5 全红**（每步都断言锚点命中、改后内容确实不同、恢复后与备份逐字节 `diff`）：去掉一条路由的 `requireAdmin`、删掉 sweep 登记、删掉 v4 迁移、`CACHE` 退回 `nav-v68`、预览行标题不过 `esc`
- `node --check`（全部改动 JS）、`git diff --check` 干净

### 真实浏览器实测（临时副本 + 默认密码，端口 61752；每轮 `unregister()` + `caches.delete()` + cache-buster；服务已停、副本已删、端口已释放、浏览器已 close）

| 场景 | 结果 |
| --- | --- |
| 未登录 | 模块区不渲染（`#moduleZone.hidden`），一个模块文件都不下载 |
| 登录后 | 卡片挂载，状态行「已同步 HH:MM」 |
| 新建 | 表单空标题时保存按钮 `disabled` → 填写后启用；计数 `8 / 60`、`22 / 10240`；保存后列表与卡片同时更新 |
| 编辑 | 表单回填原值（含换行）；改后卡片显示新标题、`updated_at` 前移、`pinned` 保留 |
| 固定 | 行移入「已固定」组，卡片摘要行出现图钉；按钮 `aria-pressed` 与文案同步 |
| 搜索 | 子串过滤生效；**真实键盘输入 3 个字符后输入框仍聚焦、光标停在 3**（只重渲染列表子树） |
| 删除 | 行内两步确认；**取消后 2 行仍在**、确认后 1 行且库里同步 |
| 注入对抗 | 标题 `<img onerror>`、正文 `<script>`/`<svg onload>`：三个探针变量全部 `undefined`、面板内 `img/script/svg[onload]` 计数 **0**、payload 以纯文本呈现 |
| 持久化 | 清 SW 后硬重载，两条备忘仍在（已固定在前）；**直读库**：`user_version: 4`、`pinned` 为 0/1、字段与 UI 一致 |
| 同步失败 | 停服后本轮询转「同步失败」+「重试」入口，**已显示的备忘不被清空**；服务恢复后下一次轮询自动回到「已同步」 |
| 同步中 | 本地回环太快（<10ms），**未能截到 spinner 那一帧**；手动点「同步」后时间戳前移可证其执行过 |
| 窄屏 390×844 | 模块区 `data-dock` 退化为横滑（`overflow-x: auto`）；面板 366px；触控目标修前 30×30 → 修后 **44×44**；行内操作 `opacity: 1` |
| 桌面 1280×800 | 面板 480px、触控目标仍 30×30（窄屏块未泄漏）；行内操作 `opacity: 0` → hover 后 1；卡片摘要行 hover 实测 `translateY(-2px)` + 外投影 |
| console | 清空后跨一次完整轮询静置 20 秒，**零日志** |

### 浏览器实测抓到的三个真缺陷（源码形状断言与 `node --check` 全都放过了）

1. **`ReferenceError: API is not defined`——模块会完全不能同步。** `API` 是 `app.js` IIFE 内部的 `const`，不是全局；平台是通过 `mountWidget(shell, { api })` 注入的，我却写了裸 `API`。症状是卡片正常渲染、每一轮同步都失败。已改为从 `state.api` 注入（取不到时在卡片上明说「模块未拿到 API」，不退化成一串静默失败），并加守卫：源码里不得出现裸 `API.`、必须从 `state.api` 赋值。
2. **元素 id 与后台弹窗撞名，点击落空。** 我的 `#saveBtn` 与 `app.js:1037/4912` 的 `#saveBtn` 同名，`querySelector('#saveBtn')` 命中的是那个隐藏的后台按钮——`elementFromPoint` 落在遮罩上，于是**面板被关掉、编辑内容丢失**，看起来像「保存没反应」。已把模块内 id 全部加 `memo` 前缀，并加守卫：模块 id 必须以 `memo` 起头、且不得与 `index.html` / `app.js` 里的 id 相同。
3. **窄屏触控目标 30×30、行内操作靠 hover 才显形。** 都已按仓库既有做法修正（`≤1023px` 抬到 44px、`(hover: none)` 常显）。顺带把「点空白关面板」改成**编辑态不关**——一次误点不该丢掉刚写的备忘，取消有显式的「取消 / ← 返回」。

### 仍未验证

1. **真机触摸**：`agent-browser set device` 在本环境仍报 `maxTouchPoints: 0`，`(hover: none)` 恒 false，因此那条常显规则**一行都没被浏览器执行过**（可测的是 `≤1023px` 那条，已测）。
2. **真机软键盘**：与仓库既有记录同一条限制，本轮未涉及。
3. **「同步中」spinner 的观感**：本地回环下该状态只存在几毫秒，没能截帧。
4. **多设备同时编辑同一条**：LWW 是定稿决策，但「两端同刻编辑」这一场景本地造不出来。
5. **老用户是否真能拿到新 bundle**：规则要求升缓存名、已升（`nav-v69`），但不能断言送达——需对着已部署的源刷一次。

### 发布后用户报「备忘录模块无法启用」——模块开关自平台上线起就没保存过（v1.11.1）

发布 v1.11.0 后用户原话：「更新后，备忘录模块无法启用」。

**根因不在备忘录模块。** 后台「模块」页那枚启用开关，自模块平台上线（`ada60c6`，10-02）起就**只把那一行的文字改成「已启用」，从不发请求**——`.modules.json` 一个字没变，所以任何模块都开不了，只是此前没人去开过（本机 `enabledModules` 里那个 `server-monitor` 不是这枚开关开的）。v1.11.0 的 highlights 里那句「需要在后台勾选启用」当时是句空话，已在 CHANGELOG 里补了更正。

**为什么 465 条测试全绿**：`tests/monitor-agent.test.js` 有一条守卫只断言「开关上存在一个 change 监听」——形状成立、语义上什么也没证明，等于把缺陷钉成了契约。紧挨着它的 `app.js` 注释同样写着「模块开关有自己的即时保存路径」，那条路径从来不存在。**注释与断言互相作证，而两者都与代码不符。**

**我自己漏掉的那一步（已记进教训）**：上一轮的浏览器走查里，我把 memo 打开是**直接手写 `.modules.json` 的 `enabledModules`**，从没走过那枚开关。模块本身（渲染、同步、增删改查、离线暂存、注入对抗、失败态）我验得很细，唯独「怎么把它打开」被我用手写配置绕过去了——而用户第一步走的就是它。**夹具替我做掉的那一步，就是我没验的那一步。**

**改法**：照抄同一文件里「显示/隐藏」那个开关的既有形状——POST `/api/modules/config` 写入新的启用列表 → 成功后重渲染首页模块区（不必刷新）→ 失败把开关与文字一起拨回去并提示。回滚要按「这次拨动的方向」取反，所以先用快照 `on`，不回读 `box.checked`（那时它已被改动）。

**验证**：

- 新行为用例把源码里那段**真实循环体**放进函数里跑（不是形状断言）：「后台模块开关真的落盘：跑一遍真实处理器，成功与失败两条路径」。断言成功时的 POST URL 与 `enabledModules` 内容、内存列表同步、文字翻转、模块区被重渲染、有 toast；失败时开关与文字都拨回、内存列表不变、不重渲染。
- **红绿已验证**：删掉那行 POST → 恰好这一条转红（102 pass / 1 fail）；还原后与备份逐字节一致、466/466。
- **真实浏览器复现并复验**（临时副本 + 全新安装）：修前勾选 → 界面显示「已启用」但 `.modules.json` 不变、无 toast；修后勾选 → toast「已启用「备忘录」」、落盘 `["memo"]`、关掉面板首页**立即**出现卡片；再关掉 → 落盘 `[]`、卡片消失。console 全程零日志。
- 放宽了一条既有断言：`tests/api-boundary.test.js` 的「状态文字随开关切换」原先钉具体写法 `box.checked ? …`，改用快照后它转红，而它要守的意图未变——按仓库纪律**放宽断言、不改代码去迎合**。
- 同类开关逐处核对：轮询周期、显示/隐藏、自签证书三处本来就有 POST，只有模块开关这一处漏了。

### 下一步

1. **需要在后台勾选启用**：模块平台是按模块开关的，本机 `.modules.json` 的 `enabledModules` 目前只有 `server-monitor`——去后台「模块」里把「备忘录」勾上（v1.11.1 起这枚开关真的会保存），首页才会出现这张卡片。
2. 本机 `.modules.json` 里那两台演示机（`NAS http://127.0.0.1:4401`、`VPS http://127.0.0.1:4402`，端口早已不通，mtime 10-02）仍在。属你的本地数据、被 `.gitignore` 排除、不进发布包，我**没有动**；要清就在后台「监控目标」里删掉这两台。
3. 真机确认「仍未验证」第 1 条（触摸设备上 `(hover: none)` 那条常显规则）。

## 上一轮：修「首页加载、模块区出现时卡一下」（修复提交 `2c1211e`，发布为 v1.10.5）

用户原话：「首页加载，模块展示的时候会有卡顿感，动画不够流畅」。

### 先说结论：不是掉帧，是首次挂载被做成了动画

`--stack-top` 要等卡片进入文档、量完高度才算得出来，所以卡片是**带着 `margin-top: 0` 出生的**；而 `.module-widget` 的基础规则上挂着 `margin-top 180ms` 的让位过渡，浏览器把这个「从 0 到最终位置」当成一次真实位移，照做了一遍动画。

浏览器实测（1440×900，两侧停靠，4 张卡）：

| | 插入瞬间各卡 top | 过渡 | LayoutShift | CLS |
| --- | --- | --- | --- | --- |
| 改前 | **48 / 48 / 48 / 48**（完全重叠，文字互相压住） | 6 次 `margin-top` | 7 帧（85→201ms） | 0.0191 |
| 改后 | 48 / 159.5 / 271 / 382.5（按各自高度铺开） | 0 次 | 5 帧（数据到达那一次） | 0.0050 |

同一批测量里**帧率满 60fps（最大帧 16.8ms）、长任务 0**、轮询 17 秒窗口内无过渡无抖动——所以「卡顿感」来自**动画本身不该出现**，不是渲染跟不上。截图佐证：放慢过渡后可见四张卡的标题/指标文字叠成一团。

窄屏（`data-dock="below"`，flex 横排、不写 `--stack-top`）没有这个问题：实测无重叠、零过渡。缺陷只在宽屏两侧停靠时出现。

### 修法

`renderModuleZone` 首帧布局期间给模块区加 `.module-zone.is-laying-out`（CSS：`.module-zone.is-laying-out .module-widget { transition: none }`），摆好位、**同步**强制一次重排后再摘掉。

三条硬约束，都是实测出来的（对照页忠实复刻 `stackWidgetsByHeight`「先读高度、后写 `--stack-top`」的顺序）：

| 变体 | `margin-top` 过渡 | 插入首帧落点 |
| --- | --- | --- |
| 无标记（改前） | 3 次 | `0 / 0 / 0 / 0`（完全重叠） |
| 强制重排 + 同步摘 ← 现实现 | **0** | `0 / 104 / 208 / 312` ✓ |
| 强制重排 + **rAF 摘** | **0** | `0 / 104 / 208 / 312` ✓ 同样修好 |
| **删掉强制重排** | **1 次（最后一张卡）** | `0 / 104 / 208 / **0**` |
| 标记加到 `inner` | 3 次 | `0 / 0 / 0 / 0`（缺陷原样复发） |

1. **承重的是 `void zone.offsetHeight` 那一句，不是摘标记的时机。** `stackWidgetsByHeight` 先读高度后写 `--stack-top`，于是最后一张卡写完之后没有任何读操作；不显式刷这一次，它那笔写入会等到摘掉标记之后才落进计算值。
2. **标记必须加在 `#moduleZone` 上**（它同时带 `.module-zone`）。CSS 是 `.module-zone.is-laying-out`，两个类必须同宿主；加到子元素 `.module-zone-inner` 上规则完全不命中。
3. **摘标记放在 `finally` 里**：`applyWidgetLayout` 内部会走 `syncEditLayoutUI → renderGrid`，任一步抛异常而标记留着，模块区的让位动画就**永久**失效了。

之后的让位动画（拖拽换序、轮询后高度变化）一律保留——那正是它存在的理由。

### 验证

- `node --test tests/*.test.js`：**449/449**（新增 1 条）。
- 新守卫「首次布局不做让位动画——卡片不得从重叠位置滑开」钉五件事：标记加/摘在 **`zone`** 上（CSS 要求同宿主）、五步**顺序**（加标记 → 挂节点 → 摆位 → 强制重排 → 摘标记）、**强制重排在窗口内**（承重那一步）、摘标记在 **`finally`** 里、CSS 里真有这条规则。类名从 JS 取出再去 CSS 找同一个名字，改一边忘另一边会红。
- 红绿 **6/6** 转红（破坏与恢复都有 before/after 校验、恢复后逐字节一致）：删「加标记」、删强制重排、**删 `finally`**、删 CSS 规则、`applyWidgetLayout` 里也关过渡、**标记改加到 `inner` 上**。
- 另有一个**刻意不要求变红**的变体：把摘标记改成 `requestAnimationFrame` —— 实测它同样 0 过渡（见修法表第 2 行），所以旧断言里「抑制窗口不得出现 rAF」是**过约束**，已删掉。
- 真实浏览器复验（临时副本、排除全部私有文件；每轮 `unregister()` + `caches.delete()` + cache-buster）：见上表；另单测「让位动画还在」——直接改一张卡的 `--stack-top`，`transitionstart` 照常报 `margin-top`；1280 视口（below）横排布局与改前逐值相同。
- `node --check`（改动的 JS）、`git diff --check` 干净。

### 提交前的两轴代码审查（基线 v1.10.4，跑在未提交的工作树上）

两轴独立收敛到同一条，而且**它是对的、我原来写错了**：

**① 我把「同步摘标记」当成了必要条件——错。** 我在注释、文档和断言里都写了「摘标记不能交给 rAF，否则等于没修」。两轴各自在对照页上实测：**保留 `void zone.offsetHeight` 时，摘标记改成 rAF 同样 0 过渡**；真正承重的是那次强制重排（删掉它，最后一张卡仍有 1 次过渡）。我已用忠实复刻「先读后写」顺序的对照页自己复现了这套对照表（见修法），把注释/文档改成正确因果，并把那条**过约束**的断言删掉——留着它会否掉一个功能正确的实现。

**② 守卫不钉「标记加在哪个元素上」——真漏洞，已修。** 原来的断言用 `classList.add('is-laying-out')` 这种不含元素名的串定位，于是把标记从 `zone` 挪到 `inner` 上测试**仍然全绿**，而线上缺陷原样复发（对照页实测 3 次过渡、首帧四张卡全重 0——CSS 的 `.module-zone.is-laying-out` 要求两个类同宿主）。已改成钉 `zone.classList.add/remove`。

**③ 没有兜底——已补。** `applyWidgetLayout` 抛异常会把标记永久留下，模块区让位动画**永久**失效。改为 `try/finally`，并加了对应断言。

**④ `methodBodyOf` 仍会给「带默认值/解构参数」的方法切出空串——真漏洞，已修。** 这与本轮顺手修掉的零参空切片是同一个坑，两轴之一实测：app.js 的 180 个方法定义里有 **12 个**（`request(url, options, binary = false)`、`showToast(message, state, duration)`、`showUiDialog({...})`、`bookmarkFieldError([title, url])` 等）切不出来、返回空串。已把判据放宽到 `\([^()]*\)`（实测 180/180 全部可切），并在 helper 的自检里加了一条**枚举断言**：app.js 里每一个 8 缩进方法定义都必须切得出非空片段，否则直接红。

**两轴经复核「不成立」的**（记下来免得下一轮重查）：

- 「新测试只做源码形状断言、等于没验」——不成立。本仓库对「布局行为单测看不见」的既定做法就是钉住不许退回旧形状（`architecture.md` 多处），删除实现会转红，已由红绿表证明。
- 「`fav-tab.test.js` 的缓存名守卫是空转」——不成立，把 `CACHE` 退回 `nav-v67` 会让它红。
- 「其他动画（书签悬停、按钮按下）也有同类问题」——不成立。全页首屏过渡日志里只有模块卡片的 `margin-top`；那些动的是 `transform`/`box-shadow`（合成/绘制属性），不是布局属性，且已有 `prefers-reduced-motion` 兜底。
- 「无范围蔓延」——两轴一致确认：7 个文件每个 hunk 都服务于这一句话（`sw.js` 缓存名与 `fav-tab` 守卫是 `public/` 改动的必要连带）。

### 顺带修掉的两处（都在本轮边界内）

1. **`methodBodyOf` 判据太窄**：它要求方法「至少一个普通参数」，于是零参的 `renderModuleZone()` 被切成空字符串——而空切片会让所有基于它的断言静默落空（看起来和通过一样绿）；审查进一步测出带默认值/解构参数的 **12 个**方法同样切不出来。判据已放宽到 `\([^()]*\)`（实测 app.js 的 180 个方法定义全部可切），并加了一条枚举断言把这一类整体堵死。
2. **`fav-tab.test.js` 的 SW 缓存名守卫**钉着上一轮的 `nav-v67`。按仓库既有模式同步到 `nav-v68`（本轮改了 `public/app.js`、`public/styles.css`，缓存名必须升）。

### 仍未验证 / 下一步

1. **数据到达时的那 5 帧位移没有消除**，只是从「重叠滑开」降成「首次数据落地后卡片按新高度让位」（CLS 0.004）。它是 `.module-widget` 让位过渡的既定用途，且在本地服务器上约 11ms 就发生、与首帧几乎同批；**在真实远端网络下这段会明显滞后**（卡片先以离线高度出现，几十到几百毫秒后才让位）。要彻底消除只有一条路：让模块区**带着首轮数据**再首次布局（给模块平台加一个「首轮已就绪」的信号）。本轮没做，等你定。
2. 真机（窄屏触摸）未测——本缺陷只在宽屏两侧停靠出现，与触摸无关。
3. **`docs/current-work.md` 的「当前基线」段此前严重滞后**：一度仍写着 v1.6.12 发布提交，而仓库已到 v1.10.4。本轮发版收尾时已按仓库纪律迁移（见下节）。

## 上一轮：修 v1.10.3 的自举盲区——升级后仍未自动重启（v1.10.4）

用户原话：「agent 新版本发布后，在终端执行升级命令后显示版本升级了，但没有自动重启服务，服务端仍检测到旧版本」。

### 根因：一次升级无法获得它自己引入的行为

v1.10.3 给 `cmdUpgrade` 加了自动重启，但**执行那次升级的是旧版二进制里的 upgrade 代码**——那段代码里还没有重启逻辑。于是：

1. 从 1.10.2 升到 1.10.3：文件换了、进程没换。用户看到「版本升级了」，服务端仍报旧版本。
2. 再跑一次：这次跑的确实是 1.10.3 的代码，但 `newVersion == current` 走「已经是最新版本」分支**直接 return**——仍然不重启。用户于是永远卡在「文件是新的、进程是旧的」，再跑多少次都没用。

这是修复的**自举问题**：带来行为改变的补丁，无法由它要替换掉的那份旧代码执行。任何「让升级命令多做一件事」的修复，都要晚一版才生效——上一轮没预见到这一点，是本轮的教训。

### 修法

`cmdUpgrade` 在「已是最新版本」分支同样做一次收尾重启（抽出 `reportRestart` 给两条路径共用）。于是「再跑一次 upgrade」成为一条**能自愈**的路径，而不是死路。

用户当时的两种解法（不必等这一版）：直接在目标机 `sudo systemctl restart nav-agent`；或在 1.10.4 之后再跑一次 upgrade（那时该分支会重启）。

### 验证

- `node --test tests/*.test.js`：**448/448**。
- 既有那条行为用例里加了场景 C：**连续跑两次 upgrade**，第二次必须走到「已是最新」并**仍然**调用 `restart nav-agent`——正是用户卡住的那个状态。
- 红绿：摘掉「已是最新」分支的收尾 → 场景 C 变红。
- 又踩到一个自己的坑：下载源原本用 `agent/dist/` 里的**预构建产物**，那是上一次发布留下的、不含当前改动——于是场景 C 跑的是旧逻辑，把「没修好」判成了通过（断言打出的是上一版文案才暴露出来）。现在两个版本都**现编**（`-ldflags -X main.buildVersion=`），都含当前源码。

### 仍未验证

真机 systemd 的重启路径（本机是 macOS，`systemctl` 是桩）——与上一轮是同一条。

## 上一轮：修「升级 agent 后后台仍催升级」（v1.10.3）

用户原话：「在后台点击检测按钮，提示 agent 版本为 1.10.1 可升级为 1.10.2，我在主机侧执行了升级命令后主机侧显示是 1.10.2 了，但服务端后台还是提示需要升级」。

### 根因：upgrade 只换文件，不重启进程

`agentVersion()` 是构建期用 `-ldflags -X` 注入的**常量**——**正在运行的那个进程**会一直自报旧版本。而后台「可升级」正是拿 `/health` 的 `agentVersion` 判断的，于是：主机侧 `nav-agent version`（新进程读新文件）已经是 1.10.2，服务里跑的旧进程仍报 1.10.1，后台就一直催。

`install.sh` 的部署路径早就做对了这件事（**停旧 → 装新 → enroll → restart**），而 `cmdUpgrade` 只做了中间的「装新」，最后一步仅**打印**一句「若它是 systemd 服务，重启后生效：systemctl restart nav-agent」。那行字太容易被当成可选项——用户确实照命令做完了、也确认了版本，界面却毫无变化。这与本仓库反复记录过的「只 warn 不做事 = 静默失败」是同一形状（install.sh 里「写死 serve 导致 push 模式启动即退出」那条注释就是同一个教训）。

### 修法

`cmdUpgrade` 替换成功后调用新增的 `restartAgentService()`：直接试 `systemctl restart nav-agent`，再用 `is-active` 确认它没「启动即退出」（install.sh 的同一课：systemd 对启动即退出照样返回 0）。重启不了就把**具体**手动步骤交给用户（systemd 一条、手动运行一条），而不是笼统的「重启后生效」。

不预设「这台机器一定有 systemd」——直接试、失败就报。macOS 上开发、容器里、`--no-systemd` 装的机器都会因此拿到准确提示。

三处文案同步改口：`upgrade` 的输出、`agent/README.md` 的升级段、后台命令面板第 2 步的 note（原先写着「执行完若 agent 是 systemd 服务，还需 systemctl restart nav-agent」）。

### 顺带修掉一个被测试暴露的真缺陷

`enrollClient` 里 `caPath := args.str("server-ca", "NAV_AGENT_SERVER_CA")` —— `str(name, def)` 的第二参数是**字面默认值**，不是环境变量名（同文件 `--server` 那处写的是 `os.Getenv("NAV_AGENT_SERVER")`，是对的）。于是**不传** `--server-ca` 时，每次 `enroll` / `upgrade` 都会白打一行
`读取 --server-ca 失败：open NAV_AGENT_SERVER_CA: no such file or directory`。
功能没坏（随后回落 `http.DefaultClient`），但那行字会让人以为配置错了。已改为 `os.Getenv`。

### 验证

- `node --test tests/*.test.js`：**448/448**。
- 新增一条**行为**用例：临时目录里现编一个版本号不同的副本（`-ldflags -X main.buildVersion=0.0.1`），`systemctl` 与「提供新版二进制的服务端」都是桩，真跑一次 `upgrade`——断言它调了 `restart nav-agent`、输出说「已重启」；systemctl 失败时断言给出两条手动命令。同一条用例天然不传 `--server-ca`，顺带钉住上面那个缺陷。
- 红绿：把 `restartAgentService()` 调用改成恒假 → 用例红；把 `os.Getenv` 改回字面量 → 用例红。
- 写这条用例踩了两个自己的坑：**`spawnSync` 会阻塞本进程的事件循环**，而提供下载的 http 服务跑在同一进程里——下载永远等不到响应，卡满 30 秒且 stub 一次都没被调用（改异步 `spawn` 才对）；以及一条**既有断言打偏**——它用 `dialog.indexOf('note:')` 当作第 3 步的 note 起点，实际从第 1 步就开始切，我给第 2 步加的「自动」二字落进了它的 push 切片，于是「push 不得许诺自动翻牌」误报（起点已改锚 `note: mode ===`）。

### 仍未验证

**真机 systemd 的重启路径没跑过**：本机是 macOS，`systemctl` 是桩。桩能证明「参数传对了、失败分支走了」，证明不了「systemd 真的把服务拉起来了」——需要在真实 Linux 机器上跑一次 `upgrade`。

## 上一轮：修「接入新主机报证书 altnames 不匹配」（v1.10.2）

用户原话：「接入监控新的主机时，报错“Hostname/IP does not match certificate's altnames: IP: 103.11.78.39 is not in the cert's list: 127.0.0.1, ::1”」。

### 根因：`ca` 解决的是「信不信这张证书」，不是「这张证书是不是叫这个名字」

配对流程把该机器的证书 PEM 存进 `certPem`，拉取时作为 `ca` 传进去——这一步只让**证书链**可信。链通过之后 Node **仍会**拿 URL 里的 host 去比对证书 SAN，而 agent 的证书是 `selfSign(sysHostname())` 签的，SAN 里通常只有 `127.0.0.1` / `::1`（本机访问用），服务端却是拿那台机器的 IP 去连的 → 直接拒。

实测复现：一张 SAN 只有 loopback 的证书 + 用本机 LAN IP 去连，逐字得到用户那句话。

### 修法

`lib/monitor.js`：**配对过**的机器（有 `certPem`）显式跳过 hostname 比对。只在配对过时装上去——信任已经锚定到那一张具体证书（`ca` 里只有它），要冒充得先拿到那张证书的私钥，而那只在目标机器上；没配对时照旧走默认校验。

一处坑：**不能写成 `checkServerIdentity: undefined`**。Node 要求这个键要么不存在、要么是函数，传 `undefined` 直接抛「must be of type function」，于是每一次拉取都失败——比原来那条报错更糟。所以调用点与 `httpsRequest` 两处都是「是函数才放进 options」。

### 一条前提已过时的旧守卫

`tests/monitor-agent.test.js` 原先断言「**不得出现** `checkServerIdentity`」，理由是「实测自签场景下它不会被调用（OpenSSL 先抛 DEPTH_ZERO_SELF_SIGNED_CERT）」。那个前提只在**链不受信**时成立；链已靠 `ca` 验过之后，它是唯一能改 hostname 判定的钩子。守卫已改写成对准新意图：只在配对过之后跳过、且不得传 `undefined`。

### 验证

- `node --test tests/*.test.js`：**447/447**。
- 行为用例（真实 TLS，不是形状断言）：在既有那条「起真自签 HTTPS 服务」的用例里加了两个场景——**C** 证书 SAN 不含访问地址仍应连得上；**D** 换成**另一张**证书当锚点必须连不上（专门防「为了修 C 干脆把校验整个关掉」）。openssl 缺失时照旧 `t.skip`。
- 红绿：摘掉那一行 → C 失败；改成传 `undefined` → Node 抛 must-be-a-function。
- **真实服务端端到端**（临时副本 + 一个模拟 agent 的真实 https 服务，证书 SAN 只有 loopback；端口 4197/4203，已停、端口已释放、副本已删）：
  - 修复后：`cached: false` 的真实拉取 → `online: true`，指标就是模拟 agent 返回的那份
  - 只改副本摘掉修复 → **逐字复现**用户那句报错
  - 途中踩到：`metrics` 的结果有**持久化缓存**（存 SQLite，重启不清），第一次拉取显示的是缓存里的旧结果；清掉缓存行后才对上。排查这类「改了没反应」先看响应里的 `cached` 字段。

### 已知未修（同一类缺陷的另一侧）

`agent/main.go` 的 `enrollClient` 用 `RootCAs = 系统 CA 池 + --server-ca` 连服务器，同样会做 hostname 校验。它**不能**照搬这次的做法：池里不止那一张证书，「跳过 hostname」会放宽成「任意公共 CA 签的证书都接受」。要修得先区分「这次用的锚点是自签的还是公共 CA」，本轮不动，等真实遇到再说。

## 上一轮：右下角新增「外观」三态按钮（v1.10.0 发布，v1.10.1 为随后的审查修复）

用户原话：「右下角的按钮旁边增加一个小一点的外观切换按钮，一键切换深色模式/浅色模式/自动模式（即把后台管理的主题模式放到前台，该功能未登录状态下也可见）」。先做了 `docs/mockup-theme-toggle.html` 仿真页（四种按钮形态 + 未登录/已登录两形态 + 窄屏对照），三处决策都选了推荐项后才落代码。

### 约束：未登录写不了服务端

主题存在 `config.json`，而 `toPublicConfig` 只剔 `privacyMode` —— 未登录**能读**到站点主题；但 `POST /api/config` 要管理员。所以「未登录也能切」这条只能是本机生效，这也决定了下面第 1 条的形态。

### 定下的三条

1. **保存位置**：未登录写本机 `localStorage`；**登录后点它 = 改站点主题**，与后台下拉框同一份状态。读取优先级 `localStorage → config.theme → auto`（非法值忽略，回落服务端）。
2. **先清本机、再写服务端**：登录成功时（两处——首屏探测 `restoreSession` 与页面内登录）都调 `adoptServerTheme()` 清掉本机覆盖，否则本机旧值会一直压过刚写下的站点值。`tests/api-boundary.test.js` 用**枚举断言**钉住「每一处 `authenticated = true` 之后必须有它」——只搜一次「有没有调用」会漏掉第二条路径。
3. **按钮形态**：与旁边 `.fab` 同高（44px）、只把宽度收窄成 40px 的图标按钮。32–36px 的圆低于触摸目标底线，手机上会误触紧邻的「管理」。

首屏不闪：`index.html` 的内联脚本抢在 `styles.css` 之前应用本机主题；键名与 `app.js` 的 `THEME_STORAGE_KEY` 有跨文件断言钉住。

### 顺带修的两条既有守卫

两条都不是新写的守卫有错，而是被本轮改动打中：

- `api-boundary` 用固定行号 `h.line > 120` 排除 constructor 的初始值。本轮在类顶新增 13 行常量，constructor 从 L114 漂到 L127，越线后被多算成第 5 处切换点。改成按「第一条」排除——顺序才是语义，行号只是代理，类字段每加一行它就失效一次。
- `paste-composer` 的 DOM stub 缺 `#appearanceBtn` / `#appearanceIcon`，`bind()` 在 stub 里抛 `Cannot set properties of null`，连带 7 条用例变红。

### 验证

- `node --test tests/*.test.js`：**443/443 通过**（新增 8 条）。
- 红绿：8 处变异（`hidden` / 键名漂移 / 抢先应用挪到样式表之后 / 本机优先被摘 / 循环丢取模 / 未登录也 POST / 图标表缺一态 / 高度改 32px）各自只让对应用例变红；另单独验了删掉「页面内登录」那处 `adoptServerTheme()`。破坏与恢复都有 before/after 校验。
- 真实浏览器（临时副本，排除全部私有文件；端口 4201；已停、端口已释放、副本已删）：
  - 未登录态 dock 是 `说明 · 外观 · 管理`，外观按钮可见、不受登录态控制；连点四次 `data-theme` 走 `light → dark → null → light`，`localStorage` 与 `aria-label` 同步更新
  - 未登录点成深色 → 登录 → 本机覆盖被清、主题回服务端 `auto`；登录态点按钮 → `config.json` 的 `theme` 跟着变，后台下拉框同步显示「浅色模式」；登出后再点，写回本机
  - 刷新后本机覆盖仍在且优先于服务端值（服务端 `dark`、本机 `light` → 显示 light）
  - 窄屏 390：dock 221×54 贴右下未溢出，外观按钮 40×44 与旁边同高，dock 高度未因新按钮变化

### 代码审查（基线 v1.9.1）与随之的修复

v1.10.0 发布后按惯例跑了两轴审查（规范 / 需求），逐条回代码复核——四条真缺陷已修，并入 v1.10.1：

1. **编辑态下切换外观会替用户提交草稿**（最严重）。`setTheme` 登录分支是整份 `POST /api/config`，而编辑模式里 `editSession` 是深拷贝快照、`this.config` 就地改——按下一个只说「外观」的按钮等于按下「保存编辑」，且不可逆。现在编辑态先弹确认。浏览器实测：取消后 `theme` 仍 `auto` 且编辑态保留；确认后 `config.json` 才变。
2. **首屏防闪只做了一半**。本机覆盖由内联脚本零延迟应用，但服务端强制主题要等 `/api/config`，而 `init()` 里 `applyTheme()` 还被排在 `/api/server-flags` 那第二个往返**之后**——白白多闪一帧。已提前到配置到手即应用。服务端主题的窗口没法归零（静态 `index.html` 无法把主题注入 HTML），这条限制写进了 `docs/architecture.md`。
3. **`localStorage` 写不进去时静默**（隐私模式 / 禁用站点数据）。原来 catch 吞掉，点击后画面纹丝不动也没提示，看起来像按钮坏了。现在做内存兜底让这次点击仍生效并给出提示——`resolveTheme` 因此多了一级「本会话内存覆盖」。
4. **`docs/architecture.md` 缺本轮条目**（AGENTS.md §5 的硬要求）。补上三态优先级、`adoptServerTheme` 的两处调用点、首屏那条顺序约束与 40px 宽度的已知取舍。

两条小收敛：抽出 `nextTheme()`（循环与按钮文案原先各算一遍）；`setTheme` 复用 `adoptServerTheme()` 清本机覆盖（原先 `removeItem` 在两个调用点各写一遍）。

**被推翻的审查发现**（记下来免得下一轮重查）：

- 「`tests/fav-tab.test.js` 仍硬编码 `CACHE` 名，应改成自跟随」——**不成立**。每轮同步缓存名是这个仓库既有的守卫模式，669673d 的 spec 就是同步它；改成自跟随反而丢掉「本轮必须真的升过版」这层保护。
- 「40px 宽低于触摸目标」——用户拍板的就是这个形态（看过仿真），尺寸不动；但当初「触摸目标仍达标」的措辞不准确，已在架构文档里如实记为「已知未消」。

审查本身的验证：`node --test tests/*.test.js` **447/447**（新增 4 条守卫）；四条修复各做一次变异、加上 1 条既有守卫同步，5/5 变红且恢复有校验。

### 仍未验证 / 下一步

1. **真机触摸未测**：40×44 只在桌面浏览器的模拟视口下量过。`agent-browser set device` 在本环境报 `maxTouchPoints: 0`，粗指针相关的媒体查询跑不出来——需要真实触摸设备点一次。
2. 修复 3（`localStorage` 写不进去）没有浏览器实测——需要伪造 `localStorage.setItem` 抛错，只有红绿与代码审查覆盖。
3. `docs/mockup-theme-toggle.html`（本轮）与 `docs/mockup-fav-tab.html`（上一轮）是否保留待定；两者都不进发布包，留着不影响体积。

## 上一轮：WebDAV 备份时间与北京时间差 8 小时（v1.9.1，提交 `f665633`，已发布）

用户原话：「webdav备份和恢复备份的显示时间和北京时间不一致」。

### 根因

两处时间来自不同来源，只有一处做了时区转换：

- 「上次备份」用 `lastBackupTime`，是 `toISOString()` 的带 `Z` 串，前端 `new Date(...)` 解析后按本地时区渲染 → 正确。
- 「管理备份」列表用文件名里的 `YYYYMMDD-HHMMSS`（同样由 `toISOString()` 生成，**UTC**），前端只做了一次纯字符串格式化，把它当本地时间直接显示 → 比北京时间早 8 小时。

实测（TZ=Asia/Shanghai）：文件名 `20261006-020027`，列表显示 `02:00:27`，而同一时刻的「上次备份」显示 `10:00:27`。

### 改动

1. `lib/webdav-backup.js`：`listBackups()` 为每个分组补一个 `createdAt`，把文件名时间戳还原成带 `Z` 的 ISO（`2026-10-06T02:00:27Z`）。文件名与 `timestamp` 字段**不动**——它是分组主键，改成本地时间会让新旧文件混用两个时区。
2. `public/app.js`：新增 `formatBackupTime(iso)`，统一按浏览器本地时区渲染成 `YYYY-MM-DD HH:mm:ss`；「上次备份」与恢复列表（渲染 + 删除确认）三处都走它，`data-timestamp` → `data-created-at`。

显示格式保持既有的 `YYYY-MM-DD HH:mm:ss`（等宽、可排序），只把值修正。

### 验证

- `node --test tests/*.test.js`：**435/435 通过**（新增 3 条，已 grep 确认参与全量运行）。
- 新增守卫（`tests/backup-privacy.test.js`）：列表返回带 `Z` 的 UTC 时刻（config / bookmarks / modules / legacy 四种文件名都覆盖）；`formatBackupTime` 在子进程固定 `TZ=Asia/Shanghai` 下把 `2026-10-06T02:00:27Z` 渲染成 `2026-10-06 10:00:27`、非法输入返回空串；恢复对话框与状态区都走同一格式化，不再出现 `dataset.timestamp` / `toLocaleString()`。
- 红绿：backend / utc / wiring 三处变异各只让对应用例变红，破坏与恢复都有 before/after 校验。
- 语法：改动文件 `node --check` OK，`git diff --check` 干净。
- 发布：SW 缓存 `nav-v63 → nav-v64`（`public/` 在发布包内），三处版本号同为 `1.9.1`，走 `scripts/release.sh`。
- **发布流程上的自身失误（已在随后一笔提交修正）**：升 `CACHE` 之后没重跑全量就提交发布，而 `tests/fav-tab.test.js` 里那条守卫硬编码着上一轮的期望（`nav-v63`），当时是红的；是发布完跑收尾回归才发现的。发布产物本身没问题（包内 `CACHE = nav-v64` 已核对，`tests/` 也不进发布包）。教训：**升了 SW 缓存名就必须再跑一次全量**——`public/` 的变更既影响发布产物，也影响测试。

### 仍未验证 / 下一步

1. **真实 WebDAV + 浏览器端到端未跑**：`listBackups()` 用桩 client 验证、前端格式化用子进程固定时区验证，但没有连真实 WebDAV 服务器，也没在浏览器里打开恢复对话框看渲染结果。

## 上一轮：「收藏管理」升格为独立「收藏夹」标签页 + 全产品线换名（v1.9.0，提交 `4770c15`，已发布）

用户原话：「现在其实把原来的书签管理变成了首页导航管理，原来的收藏管理应该提升为一个大的 tab 模块，并改名为收藏夹，里面管理的是书签（名字上与一般浏览器的书签叫法相同）」。先按约定做了 `docs/mockup-fav-tab.html` 仿真页（含宽/窄视口对照），批准后才落生产代码。

### 三处结构性改动

1. 后台标签页从三个变**四个**，顺序固定 **导航 · 收藏夹 · 模块 · 账户**（`#adminTabFav` / `#adminPanelFav`）。
2. 「账户与备份」里的收藏分区**整区迁入**收藏夹标签页（导入/导出/添加书签三按钮 + `#favFileInput` 都在新分区内），旧分区不再持有任何收藏控件（含 1571/4239 两处禁用/启用按钮数组里的 `manageFavBtn`）。
3. 收藏管理器 `showFavManager` → `renderFavManager`：渲染进标签页内的 `#favManagerHost`，**不再整块替换 `#modalBody`**；「← 返回」与 `#manageFavBtn` 入口一并删除，分区切换交给标签栏。渲染时机照抄模块分区的成熟模式——`selectAdminTab` 首次进入该分区才渲染，`renderAdminPanel` 每次复位 `favManagerRendered`。

### 为什么「返回」可以删

每条编辑路径（添加/编辑/删除/批量隐私/分类重命名/拖拽归类）本来就即时 `saveFavorites()`，返回按钮里那次保存只是兜底。标签页化后它成了死代码。`api-boundary.test.js` 里钉「返回时带保存」的那条守卫同步移除。

### 换名清单（全产品线）

| 旧 | 新 |
| --- | --- |
| 收藏（条目级：收藏检索/管理收藏/导入收藏…） | **书签** |
| 书签管理（首页网格） | **首页导航**，条目称「导航」 |

覆盖：首页模式按钮第三态、placeholder、caption、`layoutBtn` title、编辑态添加/删除/编辑文案；收藏夹内的全部书签/搜索书签/添加编辑书签/批量隐私与删除提示/WebDAV 恢复选项；`server.js` 的 `读取/保存书签失败` 与相关注释；`README.md`、`docs/architecture.md`。

### 验证

- `node --test tests/*.test.js`：**432/432 通过**，含新增 `tests/fav-tab.test.js`（11 条守卫）。
- 新增守卫钉住：四标签页顺序、整区迁移（账户面板零收藏控件）、`renderFavManager` 宿主 + 方法体内不写 `modalBody`、`updateFavStat` 头部计数（唯一写入点 + 两条调用路径）、`selectAdminTab` 惰性分支 + `renderAdminPanel` 复位标记、换名余孽（`管理收藏`/`个收藏`/… 不得再出现，且不误伤合法的「收藏管理器」——它是「收藏管理」的子串）、首页「导航」文案、两层 placeholder 一致、`sw.js` 的 `CACHE` 与注释块首条一致。
- 审查（`git diff v1.8.0` 两轴）修掉 7 项，其中 4 项是本轮引入的真缺陷：帮助弹窗引号被写成 `”网页”`（应为 `“网页”`）、tab 内删除书签后头部计数不刷新（新增 `updateFavStat`）、`lib/webdav-backup.js` 的「配置、收藏和模块设置没有变化」漏改、`dialog-regressions.test.js` 仍桩着已删的 `showFavManager`。另修架构文档的换名残留与 `admin.css` 里「四个按钮」的旧注释（现为三个）。
- 真实浏览器实测（临时副本 + 预置密码，端口 4199；副本排除全部私有文件，已删；服务器已停，端口已释放）：
  - 宽屏 1280×900：左侧四标签页（收藏夹选中）、分区标题「收藏夹」、统计「共 4 个书签」、分类树（全部书签 4 / 开发 2 / 未分类 2）、四行列表（知乎带「私密」标签）
  - 窄屏 390×844：标签条 `flex-direction: row` + `overflow-x: auto` 横排可滚、四标签页同一行（y=85）；按钮换行；分类 chips 横向；列表堆叠且保留 URL
  - 首页文案：模式标签 网页/书签/退出、placeholder `搜索网页或书签`、caption `/ 查书签`、`layoutBtn` title `编辑首页导航`；编辑态 `为「论坛」添加导航` / `删除导航` / `＋ 添加分类`
  - 服务端换名：登录后驱动真实 UI 走通；私有数据文件 mtime 早于本轮，未被触碰

### 下一步

1. **发版**：版本 `1.9.0` 三处已同步；SW 缓存 `nav-v62 → nav-v63`（`public/` 在发布包内，缓存名必须升）。仓库约定用 `scripts/release.sh`，不要手写 git/gh。
2. **两处命名待拍板**（本轮按 mockup 实现，改回成本很低）：收藏夹分区标题用「收藏夹」（与标签页同名）+ 统计行「共 N 个书签」；首页网格条目改称「导航」。
3. **仍未验证**：真实触摸设备上的长按拖拽——本轮未改拖拽逻辑，但窄屏布局只在桌面浏览器模拟视口下测过；`docs/mockup-fav-tab.html` 是否保留（可删）。

## 上一轮：触摸端也能拖了（v1.8.0，提交 `98c2e4a` + 版本账 `19dfd9d`，已推送）

用户问「触摸端应该怎么适配合格」，先做了调研再实现。**结论：不能靠 CSS 补救，必须换实现。**

### 为什么 touch-action 补不了

MDN 写明 drag events **继承自 mouse events**（"drag events inherited from mouse events"），而触摸没有 mouse 事件链——原生 DnD 在 iOS Safari / Android Chrome 上按了也不发 `dragstart`。这是继承关系决定的，不是兼容性不足；`touch-action` 只决定浏览器是否接管手势，管不了事件是否产生。

模块卡片不受影响，因为它一开始走的就是 pointer 事件。所以坏掉的**只有网格侧（书签 + 分类）**。

### 三条路的取舍

| | 做法 | 代价 |
| --- | --- | --- |
| 1 | 引入 `@dragdroptouch` polyfill | 新依赖；全局劫持 touch 事件，与现有 pointer 路径打架；违背仓库 vendored / 无 CDN 约定 |
| 2 | **网格侧改 pointer 事件，与模块侧统一** ← 采纳 | 要自己处理「长按 vs 滚动」判据 |
| 3 | 触摸端不给拖拽，改「上移/下移」按钮 | 交互不如拖拽直观 |

### 设计：两条判据按 pointerType 互斥，排序只有一份

| | 桌面（mouse / pen） | 触摸（touch） |
| --- | --- | --- |
| 机制 | 原生 DnD | `pointerdown/move/up/cancel`（`bindTouchGridDrag`） |
| 激活 | 按下即起拖 | **长按 400ms**，容忍 25px 漂移 |
| 排序 | `moveCategory` / `moveBookmark` | 同一对函数 |

**为什么必须长按**：首页网格常常要滚动浏览，一按就拖会把滚动抢走；纯位移阈值会在滑页途中误判。长按期间手指不动，浏览器不开始滚动，两件事才能共存。

**⚠️ 因此网格与分类头不写 `touch-action: none`**（写了首页就滚不动），这与 `.module-drag-handle` 是有意的不一致。触摸端加的是 `user-select: none` 与 `-webkit-touch-callout: none`，且只在编辑态生效。

**桌面端一行没动**：`pointerType !== 'touch'` 直接早退，走的是上一轮已验证的原生 DnD 路径。

### 实现中被测试与实测抓出的三个真缺陷

1. **`hold` 没存 `pointerId`**：`settle` 里 `hold.pointerId` 恒为 `undefined`，与任何 pointerId 都不相等，`pointercancel` 路径上 `hold` 清不掉。
2. **`drag.moved` 是死代码**：变异验证显示删掉它没有任何用例转红——它与 `!to` 等价。已删除（与 `!to` 重复的标志只会让后来者以为它承载语义）。
3. **「压暗谁」与「复原谁」脱钩**：激活时 `is-dragging` 加在**整块 section** 上（CSS 就是 `.category.is-dragging`），收尾却按分类头去 `remove`，section 那层永远清不掉。提交时因 `renderGrid` 重建 DOM 而被掩盖，**取消或落点无效时压暗就留在页面上**——真实浏览器实测抓到的。修法是承载元素记进 `drag.tinted`，两边都读它。

### 真实浏览器实测（合成 pointer 事件，`pointerType:'touch'`）

| 场景 | 结果 |
| --- | --- |
| 分类：长按 → 拖到第三个分类 | `moveCategory(0,2)` 生效，落点高亮出现 |
| 书签：长按 → 拖到别的分类 | `moveBookmark` 生效 |
| 短按 200ms 松手 | 不动、无残留 |
| 长按满 400ms 但不动 | 激活但不提交，**无残留**（第 3 条缺陷修复后） |
| 长按期间漂移 30px | 不激活、不动、无残留 |
| `pointerType:'mouse'` | 不进触摸路径 |
| ✎ 短按后 click | 正常打开「重命名分类」 |
| 拖拽后补发 click | 被吞掉，不打开编辑框 |
| 桌面 DnD（分类 + 书签） | 无回归 |
| 模块卡片拖拽（桌面 pointer） | 无回归，order 落盘 |
| 非编辑态 | `user-select: auto`、无 `draggable`、无分类按钮 |

### 红/绿：23 项变异全部被捕获

触摸 12 项（`mutate-touch`）+ 桌面 11 项（`mutate-desktop`）。触摸侧每条守卫都确认能转红，包括：阈值归零、容忍放大到 9999、去掉 pointerType 过滤、去掉 ✎/✕ 排除、忽略空落点、自己 splice、pointercancel 不接、去掉 user-select、加上 touch-action:none、定时器不挂、以及第 3 条那两个方向。

新增用例**执行 `bindTouchGridDrag` 的真实方法体**，并带可推进的假定时器与带真实父子链的假 DOM——判据全在时序与 `closest` 上，桩薄一点就会空过。

### 我自己搞出又修掉的（测试侧）

1. **桩漏了 `button: 0`**，处理器第一行就早退 → **两条「不该动」的用例是空过的**，看起来守卫有效其实什么都没验。已补上，并在用例里加「必须挂起长按定时器」的前置断言。
2. **桩的 `closest` 只认 `.category`**，`closest('.category-header')` 恒为 null → 处理器早退。换成带真实父子链的假 DOM。
3. **桩漏了 `preventDefault`** → `move` 第一行直接抛，报「没调用 moveCategory」，读起来像产品缺陷。
4. **断言错了元素**：`is-dragging` 加在 section 上，我却断言 header。
5. **变异脚本锚点不唯一**（`pointercancel, settle` 在模块路径里也有一份）与**期望写窄**（阈值归零后先炸的是另一条用例）。
6. **测试里合成 click 落在书签 `<a>` 上，浏览器跳去了 bilibili**——测量脚本的手误，不是产品问题；重测时改掉了。

### 已验证

- `node --test tests/*.test.js` → **421 pass / 0 fail**（上一轮 411）
- 23 项变异全部转红，恢复后逐字一致
- `node --check public/app.js`、`public/sw.js` 通过
- SW 缓存 `nav-v61` → `nav-v62`（改了 `public/` 资产必须同批升）；`max(nav-vNN) == CACHE` 同一性成立

### 只在真机能确认（本环境无法验证）

> headless Chrome **不产生真实触摸**——它既没有触摸输入源，也不会因长按触发滚动或系统菜单。上面的测量全部是合成 `PointerEvent`，验的是**我的 JS 逻辑**，不是**浏览器的触摸语义**。

1. **长按期间浏览器会不会先开始滚动**，从而发 `pointercancel` 把拖拽掐掉。这是整套设计最大的不确定点。如果真机上「按住不动 400ms」也会被判成滚动，就要把 `HOLD_TOLERANCE` 从 25 调小，或改用 `touch-action: pan-y` + 方向判定。
2. **iOS 长按菜单是否真被 `-webkit-touch-callout: none` 压掉**，以及压掉后是否连累「拷贝链接」等正常操作。
3. **`pointercancel` 的真实触发时机**（来电、系统手势、多指）。
4. **滚动与拖拽共存的手感**：编辑态下能否顺畅滚动网格，而不是一滑就被判成拖拽。
5. **`navigator.vibrate` 触觉反馈**：本轮**没有**加（避免猜用户偏好）；若真机上手感太「哑」，长按激活可以考虑加一次 10ms 振动。

**真机验证清单**（建议按序）：
- [ ] 手机上进入编辑模式，**先试着正常滚动**网格——不该被拖拽抢走
- [ ] 长按一张书签卡 400ms 再拖 → 看是否跟手、落点是否高亮、松手是否换位
- [ ] 长按分类头拖动 → 同上
- [ ] 长按 ✎ → 不该起拖，松手应打开重命名对话框
- [ ] 拖拽中途用另一根手指或返回手势打断 → 压暗是否残留
- [ ] 拖到页面空白处松手 → 是否残留压暗（这正是第 3 条缺陷的现场）
- [ ] 编辑态下滚动到最后一个分类，确认能滚

### 仍未验证

- **Firefox / Safari 桌面端**：上一轮就没验，本轮同样没有。触摸端的 `pointerType` 语义在 Firefox 上一致，但未实测。
- 拖拽中途按 Esc、拖拽中改变窗口尺寸（上一轮遗留）。

## 上一轮：修首页编辑模式拖拽完全不可用（v1.7.2）

用户报「首页编辑模式下各导航分类及模块的位置均无法拖拽，自由拖拽功能未生效」。查实**两个独立缺陷**，都自模块平台上线（`ada60c6`）起就存在，而当时 403 条测试全绿。

### 缺陷一：模块拖拽的 pointermove 监听从未注册

`beginWidgetDrag` 定义了 `move` 处理器、结束时也调了 `removeEventListener('pointermove', move)`，但**从来没 add 过**。按下设好 `dragData`、加上 `.is-dragging`，然后指针一动就没人跟——松手回原位。连带 `markDropSide`（宽屏左右换边）整段是死代码，因为它只在这个没注册的处理器里跑。

改法是一行 `window.addEventListener('pointermove', move)`。

### 缺陷二：分类拖拽的宿主是 `<button>`，而 `<button>` 不可拖拽

原生 DnD 只从**最近的 draggable 元素**起手。改动前只有书签卡带 `draggable`，分类的 `<section>` 没有，于是从 ⠿ 把手按下**一个 dragstart 都不发**（真实浏览器实测事件数 0）。

修这个的过程中踩到一条反直觉的规则，两侧都实测过：

| 宿主 | 从 ⠿ 按下 | 从 ✎/✕ 按下 | 从分类标题按下 |
| --- | --- | --- | --- |
| 无（改前） | 不起拖 | 不起拖 | 不起拖 |
| 整块 `<section>` | 能拖 ✓ | **起死拖 ✗** | 能拖 ✓ |
| `.category-header`（终版） | 能拖 ✓ | 起拖 ✗ → 再用 pointerdown 排除 | 能拖 ✓ |

终版行为：从 ⠿、从分类标题按下都能拖；✎/✕ 上按下被 `pointerdown` 里的 `preventDefault()` 取消，既不起拖、也不吞掉 click。

**宿主不能太大**：挂到整块 section 上，✎ 重命名与 ✕ 删除也在可拖区域里，按住横拖就起拖，而浏览器按规范抑制随后的 click——**对话框再也打不开**。实测：✎ 单独点击正常，一拖就死。这比改前更糟。

**收窄到分类头也不够**：✎/✕ 就在分类头里面，且后代的 `draggable="false"` **不能豁免**（对照页实测：普通 button、写死 `draggable=false` 的 button、`<h2>` 三种后代按下都照样起拖，`dragstart.target` 命中祖先）。最终解法是在 `pointerdown` 里对 `.category-action:not(.category-drag)` 显式 `preventDefault()`——对照页实测取消后一个 dragstart 都不发、click 照常送达。等到 `dragstart` 里再取消就晚了，拖影已出现、click 已丢。

代价是 `dragstart.target` 解析到 `.category-header`，与书签卡无法区分，所以分流靠 `pointerdown` 记住的真实落点（`downOnCategory`）。

### 顺手修掉的两处残留（都在 dragend / 退出路径上）

- `.category.drop-target` 只在 `drop` 分支清理，而 `drop` 只在**松手点位于 #grid 内**才触发。拖到页头或留白处松手走不到它，落点分类就一直压暗——而它与 `.is-dragging` 视觉完全相同（同为 `opacity: .55`），用户分不清「在拖」还是「卡住了」。现由 `dragend` 一并清理。
- `exitEditLayout` 的注释声称清掉「全部拖拽残留」，实际只管模块区、且写的是 `.drop-active`——**那个 class 在样式表里根本不存在**，整行空转。现在两处容器都清、class 名也对上了。

### 真实浏览器实测（非源码推断）

驱动方式：`agent-browser` + 临时目录里的真实服务端副本（端口 4312，`admin123` 登录）。**每一项都清了 Service Worker 缓存再测**——中途有一次「改了不生效」是 `nav-v60` 缓存，不是代码问题。

| 场景 | 结果 |
| --- | --- |
| 从分类头拖到另一分类 | `moveCategory(0,1)` 生效 |
| 从 ⠿ 把手拖 | 生效（标题与把手两个起手点都验过） |
| 书签跨分类拖拽 | `moveBookmark` 生效 |
| 从 ✎ 拖拽 | **不起拖**（原先起死拖），拖后 ✎ 仍能打开重命名对话框 |
| 从 ✕ 拖拽 | 同上，✕ 仍能打开删除对话框 |
| 从 ＋ 卡片起手 | 明确取消（`defaultPrevented=true`），不再是死拖 |
| 模块卡片末位拖到首位 | DOM 拖动中即换位，`order` 写入 0/1/2 并落盘 |
| 模块卡片正向拖拽 | 同上 |
| 宽屏（1760px）换边 | `data-drop-side=right` → 该卡 `side` 落为 `right` |
| 保存编辑后服务端 | `.modules.json` 的 `widgets[].order` 与界面一致 |
| 非编辑态首页 | `<section>`/分类头均无 `draggable`，无 ＋ 卡片与分类按钮，DOM 与改前逐字相同 |

⚠️ **`agent-browser` 的合成拖拽会偶发不在目标上松手**（不发 `drop`）。已用对照页排除工具问题：对照页两个方向都稳定落上，而真实页面在同一条路径上稳定生效。测量用的是必然落点的分步重放。

### 红/绿：10 项变异全部被捕获

先修测试再谈绿。新增用例**执行 `bindGridEdit` 的真实方法体**（按下→起手→落下全程），不是匹配源码文本——上一轮那种「断言恒真」的教训正是本轮缺陷能溜过 403 条的原因。

| 变异 | 结果 |
| --- | --- |
| M1 删掉 pointermove 的注册 | 转红 2 条 |
| M2 draggable 挂回整块 section | 转红 |
| M3 draggable 从分类头挪到 ⠿ 按钮 | 转红 |
| M4 分流判据退回 ⠿ 按钮 | 转红 2 条 |
| M5 dragend 不清 `.drop-target` | 转红 |
| M6 `exitEditLayout` 退回 `.drop-active` | 转红 |
| M7 `exitEditLayout` 不再清 #grid | 转红 |
| M8 删掉 dragstart 兜底的 preventDefault | 转红 |
| M9 删掉 `.category.drop-target` 的 CSS | 转红 |
| M10 pointerdown 不再排除 ✎/✕ | 转红 |

### 我自己搞出又修掉的几件事

1. **M7 一开始没被捕获**，因为用例只查「选中了 `#grid`」，把 `querySelectorAll` 的结果丢在一边不迭代也照样绿。补上「必须真的 forEach 并 remove 两个 class」。
2. **M8 一开始没被捕获**，因为断言从 `closest('.bookmark')` 往后找 `preventDefault`，而那个兜底分支的**说明文字里就写着 preventDefault**——命中的是注释。改成先剥注释、再按分支边界切片。
3. **`exitEditLayout` 的用例把注释里的 `drop-active` 当成了代码在用**，反向断言自己被自己的注释绊倒。断言前先 `stripComments`。
4. **切片按字符数（220）切窄了**，正好在第二个 `classList.remove` 之前切掉，读起来像「代码没清」。改成 320 并断言切片长度。
5. **第一版 `countOf(type) >= 1` 是恒真的**，已换成「`pointerdown` 恰好两个监听」。
6. **`adds/removes` 钉死 3 会把正确的将来改动判红**（加一个成对的 `lostpointercapture` 就红）。改成断言两者相等 + `>= 3`。
7. 我给宿主加 `draggable` 时只测了 ⠿，没测 ✎/✕——**是新加的「双轴审查」在提交前抓到的**，不是我自己复验出来的。

### 提交前的双轴代码审查抓到的真缺陷

审查跑在**未提交的工作树**上（`git diff v1.7.1`，不是 `...HEAD`，后者对未提交改动返回空，等于审查了空气）。两个轴独立收敛到同一个阻断项：从 ✎/✕ 起手是死拖且按钮失效。已按实测结论修掉。

⚠️ 其中一个轴报告的「v1.7.1 基线 337 tests / 324 pass（5 条在 v1.7.1 上就红）」**我不采信也未复核**——那与本机实测的 403 不符，本轮未对基线单独跑全量。若要复核：`git archive v1.7.1 | tar -x` 到临时目录跑 `node --test`。

### 已验证

- `node --test tests/*.test.js` → **411 pass / 0 fail**（v1.7.1 为 403）
- 10 项变异全部转红，恢复后逐字一致
- `node --check public/app.js`、`public/sw.js` 通过；`git diff --check` 无输出
- 三处版本一致：`package.json` / `version.json` / `CHANGELOG.json` 均为 1.7.2，重新解析证明 JSON 仍合法
- SW 缓存 `nav-v60` → `nav-v61`（改了 `public/` 资产必须同批升）

### 仍未验证

1. **Firefox / Safari**。全部修复依赖「从 draggable 后代按下能起拖、且 `pointerdown` 的 preventDefault 能取消它」这两条 Chrome 行为。仓库里第一次把 `draggable` 挂到非链接元素上，Firefox 的规则我没有把握。
2. **触摸端**。原生 DnD 在 iOS Safari / Android Chrome 上多数不触发 `dragstart`，而 `.category-header` 也没有 `touch-action: none`（只有 `.module-drag-handle` 有）。这是 `architecture.md` 已登记的既定取舍，不在本轮范围。
3. **拖拽中途按 Esc**。`exitEditLayout` 会 `renderGrid()` 重画网格，拖拽进行中重画源节点后浏览器如何发 `dragend` 无规范保证；`downOnCategory` 只由 `dragend` 复位。请试：按住 ⠿ 拖到一半按 Esc。
4. **拖拽中改变窗口尺寸**。`reorderWhileDragging` 的中线在拖拽**开始时**缓存一次，布局重排后全部失效；`sideDockAvailable` 变化会触发 `renderModuleZone()` 把拖拽中的 DOM 换掉。
5. **本地 `.modules.json` 里仍有两条演示数据**（NAS `127.0.0.1:4401`、VPS `127.0.0.1:4402`，端口早已不通，mtime 为 10-02/10-01）。它们被 `.gitignore` 排除、不进发布包，我**没有动**——属于你的本地数据，要清就在后台删掉这两台。

### 与既有约束的冲突

- `.category-header` 现在在编辑态是 draggable，会劫持该区域的**文字选中**。`styles.css` 的两处 `user-select: none` 都在 `.section-header` / `.category-tree-item` 上，不含 `.category-title`。实测未阻断使用，但与「整块可拖拽会劫持选中」的注释理由相关——若日后要支持选中分类名，需再收窄宿主。

## 上一轮：删掉后台的书签分类编辑器（v1.7.1，提交 `90833a8` + `60c67f2`）

首页编辑模式上线后，后台「书签分类」分区成了同一份数据的第二个编辑入口。已删除：**净删 213 行**（8 行新增全是注释）。

### 发版 pre-flight 抓到一次漏 bump

这两笔改的是 `public/`，而 SW 缓存还停在 `nav-v59`——**pre-flight 的第二个检查项抓到的**，不是事后补的。已升到 `nav-v60`。上一轮（v1.7.0）是在功能提交里提前升的，这次是连续两笔删除改动，bump 就漏了。

### 删除边界：两套收藏存储不能一起删

仓库里有两套互不相通的数据，后台面板里是**两个不同分区**：

| 后台分区 | 存储 | 本次 |
| --- | --- | --- |
| 「书签分类」`#catsEditor` | `config.json` → `categories[]` | ✅ **删除**（首页编辑模式已覆盖） |
| 「收藏」`#manageFavBtn` → 收藏管理器 | `favorites.json` → `favorites[]` | ❌ **保留**（平铺收藏，多 `description`/`category`/`tags`/`private`，首页编辑模式不涉及） |

两者的**分类树**长得像但不是一回事：前者是首页网格的分类，后者是收藏管理器左侧的树（含 `editCategoryName` / 拖拽归类 / 批量隐私）。后者一行没动。

### 删了什么

| 位置 | 内容 |
| --- | --- |
| `public/app.js` | `#catsEditor` 容器、`#addCat` 按钮、`renderCatsEditor()`（136 行）、`bindEditorDrag()`、`renderAdminPanel` 里的初始化调用、模板里的分区块 |
| `public/styles.css` | `.bookmarks-list` / `.bookmark-item` / `.cat-toggle` / `.cat-count` / `.item-drag` 及两处媒体查询里的覆盖（66 行） |
| `public/admin.css` | `.modal` 下同名的 4 处覆盖（7 行） |

**保留 `moveBookmark` / `moveCategory`** —— 首页编辑模式的拖拽在调它们。删掉首页就拖不动了。

### 最容易误伤的一条：共用类名

搜索引擎编辑器（`renderEnginesEditor`）用的是 **`.item` / `.item-row` / `.item-header` / `.add-btn`**，与被删的那些同名。删 CSS 时若按选择器名一刀切，会把搜索引擎编辑器连根拔起。已加守卫钉住它的容器、按钮、初始化调用与共用样式。

### 整个「书签分类」分区一并删除，不留指路文案

删掉编辑器之后那个分区只剩一行「请在首页点编辑」的提示，**整块一起去掉了**。后台站点分区现在只有「界面设置」与「搜索引擎」两节。用户要改书签就去首页点「编辑」——那里是唯一入口，后台不再重复提示。

（这一步是我自己先加的、随后按用户要求去掉的：初版认为空分区加一句话比什么都不留友好，实际用户要的是后台彻底不出现这块。）

### 红/绿 5/5，以及一条我自己写出的假绿

| 变异 | 结果 |
| --- | --- |
| 后台模板把 `#catsEditor` 加回来 | ✅ 转红 |
| 把 `item-drag` 的 CSS 加回来 | ✅ 转红 |
| 误删搜索引擎编辑器的初始化调用 | ✅ 转红（**改前是假绿**） |
| 误删搜索引擎的「添加」按钮 | ✅ 转红 |
| 后台把「书签分类」分区整个加回来（容器+标题+文案） | ✅ 转红 |

第三条我第一版断言写的是 `assert.match(panel, /this\.renderEnginesEditor\(\)/)`，删掉初始化调用后**仍然通过**——因为方法体内还有第二处调用（`#addEngine` 的 onclick 回调里也调它），字符串照样在切片里。已改成钉住「紧跟在 `bindAdminTabs()` 之后」这个固定序列。

**这是「源码形状断言只能证明『提到过』」的又一次**：同一段代码里出现两次时，位置断言分不清删的是哪一次。

### 已验证

- `node --test tests/*.test.js` → **403 pass / 0 fail**（新增 3 条守卫）
- 浏览器实测：后台面板正常渲染、`#catsEditor` 与 `#addCat` 均不存在、搜索引擎编辑器 4 条条目完好、收藏管理器按钮仍在、后台显示指路文案
- 浏览器实测：首页编辑模式未受牵连（＋卡片 3 个、「添加分类」1 个、分类操作按钮 9 个、书签跨分类拖拽正常）
- `node --check`、`git diff --check`
- 五处残留引用检查全部清空（`#addCategoryBtn` 是收藏管理器的，与本次无关）

### 仍未验证

同上一轮（触摸拖拽、26×26px 按钮尺寸），本次删除不改变那两条。

---

## 上一轮：首页「布局」按钮改为「编辑 / 保存编辑」（v1.7.0，提交 `5002d54` + 版本账 `e513f81`）

> 本节原先 titled 「最新一轮」，已随本节升格为「上一轮」。

把右下角原本只管模块拖拽的「布局」按钮，扩成覆盖首页全部内容的一次性编辑会话：书签网格也能拖、能增删改，改完点一次「保存编辑」统一落盘。

### 先说一个与原描述冲突的事实

模块拖拽原本是**松手即存**（`commitWidgetDrag` 末尾直接 `await saveWidgetLayout`）。用户描述的「点保存编辑后所有改动自动保存」对书签天然成立，对模块则意味着改掉即时保存。四选一后按推荐项执行：**统一草稿语义**，两者都攒到点保存。代价是拖坏了布局没有逐次反悔的余地，只能整体放弃。

### 数据范围：只做 config.json 的 categories

仓库里有**两套互不相通**的收藏存储，本次只动前者：

| 存储 | 路径 | 内容 | 本次 |
| --- | --- | --- | --- |
| 首页书签分类 | `config.json` → `categories[].bookmarks[]` | `{id, title, url}` | ✅ 做 |
| 平铺收藏 | `favorites.json` → `favorites[]` | `{title, url, description, category, tags, private}` | ❌ 不做 |

后台「书签分类」分区（`renderCatsEditor`）编辑的正是前者，两边是**同一份数据**，只是前台改为直接交互。后台「管理收藏」那套是后者，未动。

### 改动清单

| 文件 | 改什么 |
| --- | --- |
| `public/index.html` | `#layoutBtn` 文案「布局」→「编辑」，补 `aria-pressed="false"` |
| `public/app.js` | 新增 `editSession` 草稿快照；改写 `syncEditLayoutUI` / `exitEditLayout`；新增 `saveEditSession` / `cancelEditSession` / `rollbackEditSession`；`renderGrid` / `createBookmark` 加编辑态分支；新增 `bindGridEdit` 与六个增删改方法；`commitWidgetDrag` 去掉落盘 |
| `public/styles.css` | 新增 `.grid.is-editing` 规则组（紧跟模块区，**没有**追加到文件末尾） |
| `public/sw.js` | `CACHE` `nav-v58 → nav-v59` |
| `tests/api-boundary.test.js` | 改写 1 条既有用例（顺序断言的前提已不成立），新增 3 条 |
| `tests/homepage-material.test.js` | 新增 8 条 |

### 三个设计决定及其理由

1. **书签拖拽用 HTML5 DnD，不用 pointer 事件。** 模块那边用 pointer 是因为宽屏绝对定位卡片要实时跟手并自己处理基准跳变（`--stack-top` 补偿）；书签网格是 CSS grid、没有那一层，后台的 `bindEditorDrag` 已是成熟范式。一次拖拽开始后浏览器会抑制随后的 click（规范行为），所以同一张卡既能拖又能点开编辑框，不需要计时器区分。

2. **`syncEditLayoutUI` 只在「真的发生切换」时重绘网格。** 它还被 `applyWidgetLayout` 调用，而后者会在视口变化时触发——无差别重绘会让正在被拖拽的书签 DOM 凭空重建。判据是 `this._gridEditing !== editing`。

3. **删除按钮不写 `hidden`，显隐交给 CSS。** 与模块拖拽把手同一条纪律（见 `tests/api-boundary.test.js` 里「拖拽把手不由模块自己写 hidden 属性」那条用例）：挂载时 `editLayout` 几乎总是 `false`，而 `hidden` 属性压过任何 CSS，控件会实测 0×0、点不到。

### 两套存储的提交不是原子的

`/api/modules/config` 与 `/api/config` 写两个文件，没有跨文件事务。采用**串行 + 前者失败即中止**，把最坏情况收敛成「只有布局变了」，而不是并发后两者状态不确定。彻底解决要服务端加合并端点，属结构性改动，本轮不做。

### 浏览器实测（真实交互，非源码推断）

登录后逐项驱动，**每一项都读回服务端或 DOM**：

| 操作 | 结果 |
| --- | --- |
| 非编辑态初始 | 按钮「编辑」、`is-editing` 缺省、＋卡片 0 个、分类操作按钮 0 个、书签 11 张 |
| 进编辑 | 按钮「保存编辑」、两处 `is-editing`、＋卡片 3 个（每分类一个）、「添加分类」1 个、分类操作按钮 9 个（3×3）、`draggable` 书签 11 张 |
| 点 ＋卡片 | 弹窗开 → 提交 → 该分类 5→6、toast「书签已添加，点「保存编辑」生效」 |
| 点已有书签 | 编辑框带原值（`V2EX` / `https://v2ex.com`）、提示「所属分类：…」、**点了取消则值不变** |
| 校验 | 空标题 → 「请填写标题」；`javascript:` URL → 「网址必须以 http:// 或 https:// 开头」；两者都保持对话框打开 |
| Esc | 弹「放弃编辑 / 放弃本次编辑的改动？未保存的内容会丢失。」 |
| 确认放弃 | 书签数 6→5、新增那条消失、按钮与两处 class 复位、`editSession=null`、**服务端 `config.json` 未含该条** |
| 改分类名 + 新增分类 → 保存 | toast「编辑已保存」，从磁盘读回：分类 3→4、改名与新分类都在 |
| 书签跨分类拖拽 | V2EX 从分类 0 移到分类 1 首位、无 `.is-dragging` 残留 |
| 分类拖拽 | `[论坛,视频,AI,实测新分类]` → `[视频,AI,论坛,实测新分类]` |
| 删除书签 | 确认框「删除书签「V2EX」？」→ 确认后该分类 4→3 |
| 删除分类 | 确认框带书签数：「删除分类「AI」及其中的 3 个书签？」 |
| 删到只剩一个再删 | toast「至少保留一个分类」、**不弹确认框**、数量仍为 1 |

五视口（390×844 / 360×640 / 834×1112 / 844×390 / 1280×800）逐个量，**每次都重跑 `unregister()` + `caches.delete()` + cache-busting 重载**：

| 视口 | ＋卡与真实卡同高 | 可见操作钮 | 横向溢出 | 首行数 |
| --- | --- | --- | --- | --- |
| 390×844 | 是 | 9/9 | 0 | 4 |
| 360×640 | 是 | 9/9 | 0 | 4 |
| 834×1112 | 是 | 9/9 | 0 | 3 |
| 844×390 | 是 | 9/9 | 0 | 3 |
| 1280×800 | 是 | 9/9 | 0 | 3 |

分类头在 390px 下实测标题 `(12,116,63×17)`、三个按钮 `(87/125/163, 111, 26×26)`——**同一行、未换行**（`flex-wrap: nowrap`）。

### 我这轮自己搞出又修掉的几件事

1. **第一版守卫有三条是假绿的**，红/绿验证抓出来的：
   - 变异锚点 `this.applyWidgetLayout();\n        }` 在文件里**命中两处**（`renderModuleZone` 与 `commitWidgetDrag`），`String.replace` 只改了前者，被测代码毫发无损而测试照绿。脚本因此加了「锚点必须唯一」的硬门（命中数 ≠ 1 即退出 3）。
   - 「＋卡片不限定在编辑态」那条只断言「`bookmark-add` 出现在书签循环之后」，把 `if (editing)` 改成 `if (true)` 断言仍成立。已补两条断言：`if (editing) { bms.appendChild … bookmark-add` 与 `if (editing) { fragment.appendChild … category-add`。
   - 「保存编辑的提交顺序」那条断言的是**字符串位置**，改 `if (this.modulesConfig)` 为 `if (false)`（让布局那次提交根本不发生）照样通过。**审查第二轮证明我改的版本仍然是位置断言**，下详。

2. **红/绿脚本第一版 12 条全部 SKIP**，而输出看起来像「无法验证」。真因是脚本自己 `[...after.match(/MUT-MARK/g)]` 在 `match` 返回 `null` 时抛错，把这一步的退出码吞掉了。破坏其实全部生效——**报告会把「脚本崩了」读成「守卫不可信」**。

3. **`node --check` 被套到 CSS/HTML 上**，四条非 JS 变异因此全判「语法错」而 SKIP。已按扩展名分流。

4. **端到端 fixture 用 curl 登录、fetch 发后续请求**，两个客户端 UA 不同，服务端的环境变化判据直接把会话判为异常并自动登出（`code: env_changed`）。**那是产品行为正确**，是 fixture 造了一个真实浏览器不会产生的场景。改为全程 fetch 后 14/14 通过。

5. **端到端里「布局顺序未变」是我的 fixture 缺陷**：`.modules.json` 初始 `widgets: []`，空数组倒序仍是空数组。已改为先种两条 widget 再倒序。

6. **`methodBody` 切片**：本仓库已多次栽在「用下一个方法定义当结束标记会在嵌套 `catch {` 处截断」。两处新增 helper 都用大括号配对，并断言切片长度 > 60 作为兜底。

7. **`--danger-rgb` 变量不存在**（仓库的危险色是硬编码，成对定义在 `styles.css:2872-2875`）。最初写的 `rgba(var(--danger-rgb, …), .12)` 改为与 `.btn-danger` 同一批色值，深浅两套都写。

8. **我曾误判「取消编辑会留下 DOM 残留」**：推断 `rollbackEditSession` 在 `exitEditLayout` 之前重绘会渲染出编辑态 DOM，而 `_gridEditing` 已翻转导致跳过重绘。**实测证明代码是对的**（`adds: 3 → 0` 照常发生），已撤回该结论。

### 提交前的两轴代码审查，以及它抓到的三个真缺陷

审查跑在**未提交的工作树**上（`git diff` 两横线），这样发现的问题折进同一个 commit，不用事后 amend。

**Standards 轴报的三条，全部由我手工复现确认成立：**

**(1) `saveWidgetLayout` 的参数形状不对 —— 布局保存失败时回滚路径崩溃**

`saveEditSession` 传的是**裸数组**，而 `saveWidgetLayout` 的回滚分支读的是 `snapshot.widgets`：

```js
const ok = await this.saveWidgetLayout(this.editSession.widgets);   // 数组
// saveWidgetLayout 内部：
this.modulesConfig.widgets = snapshot.widgets.map(w => ({ ...w }));  // undefined.map → TypeError
```

基线里调用方传的是 `snapshot = { widgets: [...] }`（对象），我删掉 `beginWidgetDrag` 的局部 snapshot 后改传裸数组，**形状没跟着改**。

后果比看上去严重：那个异常从 `catch` 块**内部**抛出，穿透 `saveWidgetLayout` 的 catch → 穿透 `saveEditSession` 的 try（`try` 只包了 `/api/config` 那段）→ 于是 `rollbackEditSession()` / `exitEditLayout()` / toast **一行都不执行**：草稿没回滚、没退出编辑态、用户看不到任何提示，而 `widgets` 已被改坏。触发条件恰是断网/服务重启这类用户真会遇到的场景。已改为传 `{ widgets: ... }`，并加一条**运行时**断言（`vm` 抽出该方法真跑一遍，断言实际传出去的值不是数组）。

**(2) `drop` 处理器在落点不属于任何分类时崩溃**

守卫写晚了：

```js
const toCat = section ? +section.dataset.cat : -1;
const toBm = ... : this.config.categories[toCat].bookmarks.length;  // ← 守卫在这之前
if (toCat >= 0 && toBm >= 0) ...                                   // ← 太晚
```

「＋ 添加分类」按钮与网格间隙都在任一 `.category` 之外 → `closest` 返回 `null` → `categories[-1]` 是 `undefined` → 抛 `TypeError`。且异常从监听器抛出，**`dragKind = null` 的清理不执行**，拖拽状态就此卡住，下一次 `dragover` 仍认为在拖拽。

浏览器实测确认（`window.addEventListener('error')` 捕获到 `Cannot read properties of undefined (reading 'bookmarks')`）。已把守卫前置，并在提前返回前清 `dragKind`/`dragFrom`。

**(3) 我上一轮的自评是错的：「已改为断言控制流」并没有生效**

Standards 轴按我文档里写的做法做了变异——把 `if (this.modulesConfig)` 改成 `if (false)`——**全绿**。原因：位置断言（`configAt > widgetsAt` 这类下标关系）在原理上无法区分「这段代码在控制流里」与「这段文本在切片里」；把整个 `if` 体删掉后只剩一个 `;`，而 `saveWidgetLayout(`、`'/api/config'`、`try {`、`catch (e)` 这些**字符串本身仍在切片里**，下标关系原样成立。

已改为 `vm` 抽出 `saveEditSession` 真跑两遍：一遍布局成功（断言调用序列恰好是 `modules → /api/config → exit → toast`），一遍布局失败（断言恰好是 `modules → rollback → exit`，书签那次**不发生**）。

**而这条运行时断言在写的过程中又抓出第三个真缺陷**：布局失败时我原来写的是 `if (!ok) return;` —— `saveWidgetLayout` 自己回滚了 `widgets` 并提示，但**编辑会话没结束**：书签草稿还在内存里，界面仍停在编辑态。用户点了「保存编辑」却什么都没发生，也没有下一步可走。已改为与书签提交失败同构的回滚+退出。

**Spec 轴结论**：9 条原子需求全部做到（含删除书签入口可达、书签字段与后台完全对齐），四个决策 4/4 落地，五个声明范围外的项逐一核实未被触碰，无范围蔓延。

**建议项四条已全部处理**：
- `_gridEditing` 在构造函数里显式初始化（原靠 `undefined !== false` 成立纯属巧合，而它被架构文档列为「必须保持的性质」之一）
- 编辑态下连 `:active` / `.is-pressed` 一起中和——`bindBookmarkPress` 在 `pointerdown` 就加 `.is-pressed` 并保留 135ms，只压 `:hover` 的话松手后那一小段里抬升+缩放照旧出现
- ＋占位卡清掉 `box-shadow`（`.bookmark` 带 `--bookmark-idle-shadow`，虚线占位卡带实体投影会比真实卡更重）
- 删掉 `toggleEditLayout(force)` 的死参数（`force=false` 因为 `if (!next) return` 早就无法退出，留着会让后来者以为还能控制方向）

**另修一处文档漂移**：`docs/current-work.md` 引用 `tests/api-boundary.test.js:509`，实际已漂到 542（本次新增的 helper 与用例把它挤下去了）。已改为引用用例名而非行号。

### 与既有约束的冲突及处理

- `tests/api-boundary.test.js` 原有那条「重排必须在落盘之后」的前提（`layoutAt > saveAt`）在本轮**不再成立**——落盘已移出 `commitWidgetDrag`。已改写为「不得落盘」的反向断言 + 「仍需按新顺序重排」，并新增一条单独钉住 `order = index` 先于 `applyWidgetLayout`。
- `beginWidgetDrag` 里的局部 `snapshot`（原本给 `saveWidgetLayout` 回滚用）随之失去用途，已删。

### 本轮已验证 / 仍未验证

**已本地核实**：
- `node --test tests/*.test.js` → **401 pass / 0 fail**（改前 385，本轮新增 16 条）
- **红/绿 19/19 全部精确变红**，变异标记零残留，恢复走 `trap ... EXIT`
- 真实 HTTP 端到端（临时目录 + 独立端口 + 真实登录）→ 14/14
- 浏览器真实交互 13 项 + 五视口测量（见上表）
- 审查抓到的三条缺陷**逐条手工复现**后才动手修（不是照单全收）
- 修复后在浏览器里复验：drop 到「＋ 添加分类」不再抛（`threw: null`、书签与分类数量未变、拖拽状态无残留）；布局提交失败时正确收尾（退出编辑态、按钮复位、草稿回滚、无残留）
- `node --check`（全部改动 JS）、`git diff --check`
- SW 缓存一致性：`CACHE=59`，注释块最大 `59`，**相等**（判据是同一性，不是大小——`Math.max(...) < CACHE` 会把结论反过来）
- 临时目录的私有文件逐个检查：`.modules.json` / `.admin-password.json` / `config.json` / `favorites.json` / `nav-sylph.db` 全部 absent；源树私有文件 mtime 停留在 10-01 ~ 10-04，本轮未触碰
- 端口 4319 / 4321 已释放，临时目录已删除

**仍未验证**：
- **触摸设备的书签拖拽手势**。HTML5 DnD 在触摸设备上不可靠（这是既有 `bindEditorDrag` 的同一取舍）。headless Chrome 既不产生真实 touch 事件、`set device` 也给不出 `pointer: coarse`，本地无法判定。**需要你在手机上按一下**：编辑态下长按一张书签卡，看能否拖到别的分类。
- **分类操作按钮 26×26px 低于仓库既有的 `--ctl-h: 44px` 触摸下限**。与模块拖拽把手是同一设计取舍（鼠标/长按操作），但真机上是否够用只能你按了才知道。
- **SW `nav-v59` 是否真的送达老用户**——需对着已部署的源做一次真实刷新。规则要求升、已升，但不能断言「修复未送达」。

### 下一步

1. 发布（本轮未提交）。`scripts/release.sh` + 三文件版本号同步；`public/` 有改动，pre-flight 第一条命令就会要求确认 `CACHE` 已 bump（已提前升到 `nav-v59`）。
2. 真机确认上面两条触摸相关的未验证项。

---

## 上一轮：修「后台更新周期改完不生效」（v1.6.12）

> 本节原先 titled 「最新一轮」，已随本节升格为「上一轮」。

用户报「后台服务器监控的更新周期修改后不生效」。**先说结论：用户的改动其实一直是生效的**，服务端写入、落盘、缓存失效三段经实测全部正常；坏掉的是两处别的地方——所以这轮的诊断不是「保存没写进去」，而是「写进去了但界面不回显，且另一条路径会把它改回去」。

### 浏览器实测的三层数字（不是读代码推断出来的）

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 改成 30s 后首页实际请求间隔 | 30s ✓ | 30s ✓ |
| 重开管理面板，下拉框回显 | **15s ✗** | 30s ✓ |
| 切回前台后的间隔 | **15s ✗** | 30.004s ✓ |
| 改成 60s 完整往返 | — | 60.225s，回显 60 ✓ |

测量方式：钩 `window.fetch` 记录 `/api/modules/metrics` 的请求时刻，读相邻请求的时间差。这是唯一能测到「真实间隔」的办法——源码里的常量值说明不了运行时行为。

### 根因一：回显是假的（`public/app.js` 的 `loadModulesConfig`）

归一化时只从响应里挑了 `enabledModules` / `widgets` / `servers` 三个字段，**`pollInterval` 被丢在门外**。模块编辑器渲染下拉框时读到 `undefined`，`pollIntervalOptions` 回落到 15——不管服务端存的是 10 秒还是 5 分钟，重开面板永远显示「每 15 秒」。

首页轮询那条路径是对的（它走 `/api/modules/metrics` 响应里的 `pollInterval`），所以「数据是实时的、设置像是没生效」这两件事同时成立，并不矛盾。

**这是本仓库既有的一类缺陷的镜像**：项目里记着大量「读了但没人写」的 bug（形如 `hasEnrollToken` 被服务端算出来却没人消费、`authFailed` 被丢掉、`title` 承诺了一个没人实现的快捷键）。这一条是反过来的——**服务端写了，前端没读**。

### 根因二：切一次标签页就把周期打回 15 秒（`public/modules/server-monitor.js`）

`visibilityHandler` 切回前台时用**硬编码的 `POLL_MS`（15000）**重排定时器，而不是当前生效的 `pollMs`。于是「切到后台再切回来」把用户设的周期悄悄改回 15 秒，无任何提示。

`pollMs`（`server-monitor.js:278`）才是唯一真相来源：`poll()` 按服务端返回值更新它，`startPolling()` 也用它。改前 `visibilityHandler` 是**唯一**还在用常量的地方。

这一条与仓库既有教训同源——同一个 `pollMs`，两条生命周期路径各读一个来源。

### 审查抓到的真缺陷：我自己写的第一条守卫是假绿的

发版审查（Standards 轴）报「新测试的 `vis` 切片起点锚错」。**复核后成立**：`mod.indexOf('visibilityHandler =')` 首次命中的是文件顶部那句 `let visibilityHandler = null;`（第 10 行），切片一路吃掉 `startPolling()`——而那里本来就有一处**正确的** `setInterval(poll, pollMs)`。实测把 handler 里那行整行删掉，测试仍全绿。

讽刺之处：我在那条测试的注释里恰好写下了「断言范围必须落在 visibilityHandler 里，startPolling 里本来就有一处正常的 setInterval，扫全文件会误命中它」——**注释是对的，实现方式否证了它**。改法是锚到定义形态 `visibilityHandler = () => {`、终点锚到注册那一行，并把反向断言从只挡 `POLL_MS` 放宽到同时挡 `15000`（写死字面量是同一种漂移）。

改完重跑变异验证，五个全部精确变红、无连带失败：

| 变异 | 结果 |
| --- | --- |
| A 删掉 handler 里的 `setInterval` 整行 | ✅ 转红（**改前是假绿**） |
| B 改回硬编码 `POLL_MS` | ✅ 转红 |
| C 写死字面量 `15000` | ✅ 转红 |
| D 删掉归一化里的 `pollInterval` 行 | ✅ 转红 |
| E 下拉框改读硬编码 `15` | ✅ 转红 |

### 我这轮自己搞出又修掉的两件事

1. **第一条守卫本身是假绿的**（上面那条），审查报出来、我复核确认、修掉并重跑变异。
2. **变异脚本自己没改到可执行那行**：B/C 两次「测试全绿」让我一度以为守卫收紧失败。`diff` 显示 `String.replace` 只换了**第一个** `pollMs`，而那个位置在**注释里**（注释原文引用了同一串），可执行那行没被碰到——正是本仓库记过的「`String.replace` 只换第一处，注释里那句话被改了」的坑。改用 `lastIndexOf` 后两个变异都正确变红。**「没红」先怀疑变异脚本，再怀疑守卫。**

### 与 v1.6.7 的关系：同一个症状，两次不同的层面

`git log` 显示 v1.6.7 的提交信息就是「修更新周期不生效」。那一轮修的是**服务端缓存不失效**（TTL 跟着周期算 + 缓存行按需清理）。本轮修的是**前端回显与标签页回落**。两者不冲突，也说明「不生效」这个词在不同时期指的不是同一件事——所以 CHANGELOG 里写的是本轮的具体层面，没有宣称「v1.6.7 没修好」。

### 发布配套

`public/app.js` 与 `public/modules/server-monitor.js` 都在 SW 的 `ASSETS` 清单里，SW 是 cache-first，所以必须同批升缓存名：`nav-v57 → nav-v58`。发版 pre-flight 的**第一个**命令就抓到了这点（先跑它，避免 `diff <tag>..HEAD` 对未提交内容返回空而误判为干净）。

### 本轮已验证 / 仍未验证

**已本地核实**：
- 三层字节一致：磁盘、`curl` 回来的 HTTP 响应、浏览器实际加载的 bundle（每轮都做了 `unregister()` + `caches.delete()` + cache-busting query，本项目 SW 会活过任何普通刷新）
- `node --test tests/*.test.js` → 382 pass / 0 fail
- 五个变异逐一验证（见上表）
- `node --check`（三个改动文件）、`git diff --check`

**仍未验证**：
- SW `nav-v58` 是否真的送达老用户——需要对着已部署的源做一次真实刷新。本项目实测下来 SW 是 stale-while-revalidate + 每轮 sw.js 字节不同（install 会 `addAll` 刷新同名缓存），所以**不能**断言「修复未送达」，只能说规则要求升、已升。
- 真实标签页切换的 `visibilitychange` 语义：本轮 headless 里 `document.hidden` 是用 `Object.defineProperty` 模拟的。headless Chrome 无法真正切标签页，这一点环境上做不到。
- agent 推送模式（`resolvePushTimeoutMs` 也吃 `config.pollInterval`）本轮未端到端跑——服务端那一侧本轮没动。

### 下一步

本轮无遗留待办。

---

## 上一轮：后台自签开关布局 + 部署面板死指引（已提交 `09ac6be` + 审查修正 `ac7a8a3`，随 v1.6.9 发布）

用户报两处：① 自签开关「说明太详细、位置奇怪、是和之间有大量空白」；② 部署面板里写着「也可以点上面的「检测」立刻试一次」，实际找不到那个按钮。

### ② 是两层独立缺陷，不是一处

- **指向一个被自己遮住的控件**：部署面板是 fixed 覆盖层（`admin.css` z-index 1100）盖在管理弹窗（`styles.css` 1000）之上，而它盖住的正是服务器卡片那一块。浏览器实测：面板开着时对「检测」按钮做 hit-test，命中的是 `command-note` 而非按钮。
- **push 模式压根没有那个按钮**：`renderServerList` 里 `isPush ? '' : ...` 直接不渲染。而 push 机器恰恰是最需要确认部署结果的那种（不开放端口，只靠注册与上报时间）。

顺带修掉同一句里的自相矛盾：原文案同时说「每 60 秒自动探测」与「也可以点检测立刻试一次」，而 `schedulePendingProbe` 只轮询 `!s.enrolled` 的机器——**已注册的那台永远不会被自动探测**，照原文案读，用户执行完部署却等不到卡片自己变。

改法：第 3 步按 `mode` 分支。push 说「不开放端口，探测不到主机在不在线，成功看卡片上的已就绪与上报时间」；pull 说「未部署的机器每 60 秒自动探测，已注册的不自动探测，关掉这个面板后点卡片上的「检测」可以立刻试一次」。守卫断言的是**三元表达式的 `?` 与 `:`** 作分界，不是文案内容。

### ① 第一版改错了，是截图揭穿的

我按「右侧开关 + 说明改短」实现，守卫也写了 `justify-content: space-between` 并全绿。但浏览器实测**标题右边缘到开关左边缘相距 707px**，截图一看形状和改之前一模一样——`space-between` 正是那片空白的**成因**，照抄一遍等于没改。

第二版改成 `flex-start` + `width: auto`，内容按自身宽度成块靠左，说明加 `max-width: 62em`、字号 11px → 12px（单行横贯 915px 实测发虚）。实测 **707px → 14px**（就是那个 gap），说明两行。同时修掉标记里 `<label>` 套 `<label>` 的无效嵌套。

守卫已改成断言 `flex-start` 并**显式否定** `space-between`，另加 `width: auto`、说明限宽、字号 ≥12px 三条。盯的是被量出来的数字，不是一个看起来合理的属性值。

### 顺带发现并修掉：v1.6.8 漏升 SW 缓存（不在本次范围）

`public/sw.js` 的注释已记到 `nav-v54`，而 `CACHE` 常量一直停在 **`nav-v49`**——规则（改 public/ 必须同批升）连续四版失守。已补跳到 v55。

**一条危害结论被发版审查推翻，按实测改写**：先前写「v1.6.8 那个 P0 修复老用户拿不到」——过强了。实测两条送达中继都在：① 每轮 sw.js 因注释变化字节都不同，install 会重装并 `addAll` 刷新同名缓存（比对 v1.6.7/v1.6.8 的 sw.js，字节不同）；② fetch 处理器本就是 stale-while-revalidate（先回旧、后台拉新、下次起全新）。开发期里「改了 CSS 刷新仍是旧样式」的确反复发生，但验尸是「sw.js 没动字节 → 无重装」加「测量吃的是 SWR 的第一口缓存」的组合，不是常驻失达。所以漏升的实价是「仓库自订规则失守、版本账对不上」，不是修复未送达。补跳照做（规则就是规则）。

### 实际验证

- `node --test tests/*.test.js` → **369 pass / 0 fail**（新增 2 条用例）
- **红/绿验证 13 个变异全部变红**，破坏用 `node` 读文件 + 先断言锚点存在再改写（不用 perl/sed），改完打印 `before!==after` 作为落地证明，最后与备份逐字节 diff 确认恢复。其中一个变异（往 push 分支塞「检测」）**抓出了我自己的守卫漏洞**：原切片按「push 文案出现位置」分界，只切到那句文案之前，破坏落在窗口外。
- **浏览器实测**（临时目录起真服务 4271，SW `unregister()` + `caches.delete()` 后带 cache-buster 重载）：自签开关 707px → 14px、说明两行 12px、checkbox `elementFromPoint` 命中自身；pull 文案含「关掉这个面板」、push 文案不含「检测」且实测 `pushCardHasProbeBtn: false`。
- 临时服务已停、4271 端口已释放、临时目录已删、`git status --short` 只剩 4 个预期改动。

## 本机显隐修复（后一轮，已提交 `bc70fbb`，随 v1.6.9 发布）：「取消勾选了，首页仍挂着」

用户报：后台监控目标里把本机「显示」取消勾选，首页仍能看到本机监控卡。

**根因**：`server-monitor.js` `mountWidget()` 的过滤器给本机塞了 `e.id === 'local' ||` 无条件放行，注释写明理由——「关掉的话用户会得到一个空模块区，却没有任何入口能把它开回来」。那条理由的前提**已不存在**：后台「监控目标」的本机卡片就有「显示/隐藏」复选框（`app.js` `renderLocalServerCard`），恢复入口一直在。结果后台一个承诺（toast「已从首页隐藏」）、首页另一个行为，互相矛盾。

**修法**：过滤器一视同仁——`entries.filter(e => !hidden.has(\`server-monitor:${e.id}\`))`。远端卡片的键一直是 id 基（instanceId），隐藏本机不会让别的卡串位。

**一处曾被钉成契约的旧断言反转了**：「每台服务器可单独控制是否在首页显示」里有一条 `assert.match(/e\.id === 'local' \|\| !hidden\.has/, '本机始终可见')`——绿测试成了旧缺陷的最后一名辩护者。已反转为 `doesNotMatch` 并改名说新契约（本机不再无条件放行），理由的演变写在注释里。

**新增守卫**（`本机卡片可以被「显示/隐藏」真正关掉`）两头各钉一条：模块侧过滤统一、后台侧恢复入口存在（那是修复成立的前提——若有人删掉后台复选框，会退回「关掉打不开」的困境，应重新讨论而非静默沿用）。

**实际验证**：

- `node --test tests/monitor-agent.test.js` → 99 pass / 0 fail；红/绿 2 个变异全红（① 本机放行原样回来 → 新守卫与反转后的旧断言双双红；② hidden 表整体失效 → 归旧用例红——变异各归其主，账目别记错），恢复逐字节比对。
- 浏览器实测（临时目录真服务 + SW 预处理）：勾选取消 → toast「已从首页隐藏」、首页只剩远端卡；**刷新后仍隐藏**（磁盘 `.modules.json` 里 `local enabled:false`）；重新勾选 → toast「已在首页显示」、本机回到第一位、远端卡 identity 不乱。服务、端口、临时目录均已清理。
- `sw.js` 缓存升 `nav-v56`（模块文件改动，同批升）。

### 补充验证（第二轮「验证」：窄屏与主题对比度）

上一轮把窄屏整项归为「需真机确认」是**过宽的**：媒体查询按视口宽度判断，headless 恰恰能定。本轮实测：

**窄屏布局**（headless 设视口，SW 预处理后测）：

| 视口 | flex-direction | 标题↔开关 | 溢出视口 | checkbox 命中 | 说明行数 |
|---|---|---|---|---|---|
| 390×844 | row ✓ | 14px | 否 | ✓ | 3 |
| 360×640 | row ✓ | 14px | 否 | ✓ | 4 |
| 768×1024 | row ✓ | 14px | 否 | ✓ | 2 |
| 844×390 横屏 | row ✓ | 14px | 否 | 见下 | 2 |

- `styles.css` 的竖排规则核实为 `@media (max-width: 768px)`（行 1113），本轮的 `.self-signed-label` 特异性压制在四个视口全部生效。
- 844×390 的「命中失败」是我探针的锅：checkbox rect top=499 而视口高 390，点落在视口外，`elementFromPoint` 返回 null；`scrollIntoView` 后命中本体 ✓。不是覆盖问题。
- 真正剩下的只有真拇指触感（本环境无法伪造 coarse pointer + 软键盘），但该行不是高频触摸面，checkbox 15px 的既有尺寸也未被本次改动放大。

**主题对比度**（WCAG 对比度，正文阈值 4.5）：

| 元素 | 默认主题（=深色，本轮所有截图本来就是它） | `data-theme="light"` |
|---|---|---|
| 标题 `.self-signed-name` | 10.79 ✓ | 13.42 ✓ |
| 说明 `.self-signed-hint` | 4.64 ✓ | **4.11 ✗** |
| 开关文字 | 6.82 ✓ | 6.12 ✓ |
| `code`（底色合成后） | 6.12 ✓ | 6.12 ✓ |

- 「深色模式」这项顾虑**不成立**：这个应用的默认主题就是深色（`styles.css:19` `:root:not([data-theme="light"])`），先前的截图全在深色下；`data-theme="dark"` 与默认同调。真正的另一极是 light，已量。
- **新发现（既有问题，非本次引入）**：浅色下说明文字 4.11 < 4.5。颜色是 `--text-muted`（`admin.css:252` 的 `.modal .fav-hint` 同源），旧版同一块底上就是同一个数——**面板级共享变量**，`.fav-hint` / `.module-setting-hint` 全体一致。只改这一行会与兄弟行分叉，改变量则波及整个后台观感，均超出本轮。记为后续项：评估把后台提示类文字整体提到 `--text-secondary`（浅色 6.12、深色不变 4.64→ 需复核深色端的值再动）。

### 仍未验证

- 真机拇指触感（软键盘 / coarse pointer）——本环境无法伪造，该行非高频触摸面，风险低。

## 上一轮：升级后服务起不来——server-config.json 遮蔽配置目录（v1.6.10 未修住，v1.6.11 修好）

用户报：升级到最新版本后站点访问不了，systemd 起不来，`systemctl status` 只给出 `status=1/FAILURE`，没有原因。

### 定位过程（三层，每层都要自己实测，不能靠推断）

1. **1.6.9 没有服务端改动**：`git show --stat ac7a8a3` 只动了 `public/` 与文档，`server.js`/`lib/` 一行未改。所以不是新代码坏了。
2. **`systemctl status` 不是真相**：它只有 systemd 的视角。Node 的真实报错在 `logs/server.log`——单元由 `sylph.sh enable` 生成，带 `StandardError=append:…/logs/server.log`。日志给出 `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string`，指向 `path.join(config.rootDir, 'config.json')`。
3. **`config.rootDir` 为什么是 undefined**：`server-config/index.js` 里 `configData.rootDir = ROOT_DIR` 是**无条件**赋值。这在逻辑上排除了「字段缺失」，把矛头指向「加载到的不是这个文件」。`require.resolve('./server-config')` 直接告出答案是 `<安装目录>/server-config.json`。

### 根因（Node 的解析顺序，不是本项目的选择）

`require('./server-config')` 的补全顺序是 `.js` → `.json` → `.node` → **目录**。所以安装目录根下的 `server-config.json` **遮蔽整个 `server-config/` 目录**，`index.js` 一行都不执行，defaults 也不再被合并。该用户文件内容是 `{"security":{"selfSignedCert":false}}`——只有 `security` 一段，于是 `rootDir`/`server`/`paths` 全部消失。

**这不是外部残留，是应用自己写出来的**：`POST /api/server-flags`（后台自签证书开关）首次保存时 `existing` 初始为 `{}`，只补 `security`，写出的文件恰好就是这个形状。**每个用户在后台拨一次自签开关，就把自己锁死在下次重启崩溃。**

### v1.6.10 的修法是错的（重要教训）

v1.6.10 采取的是「保存时把配置写全」——用 `serverConfigDefaults` 补齐 defaults 的每一段。它写出的文件确实是完整的五段，**但补不出 `rootDir`：它根本不在 `defaults.js` 里**，而是 `index.js` 用 `__dirname` 推导后单独赋值的一个字段。

于是 v1.6.10 发布后用户照做（升级 → 拨开关 → 重启），同一个故障原样复发。**我当时只验证了「写出的文件里有 server/security/paths/app/webdav」，就据此宣布修好——没有验证最关键的那一步：用写出的文件重启。** `rootDir` 恰恰是唯一会崩的字段，而它不在我检查的清单里。这是本轮最该记住的：验证要跑完用户的完整路径（拨开关 → **重启**），不能停在中间产物看起来正确。

### v1.6.11 的正解：让遮蔽不发生

| 位置 | 改动 |
| --- | --- |
| `server.js` | `require('./server-config/index.js')` —— **显式带 index.js**。Node 的补全顺序不再有机会让同名 json 抢走加载权。用户那份 json 仍由 `index.js` 的 `loadFromConfigFile()` 读出并覆盖到 defaults 之上，这才是它本来的设计语义 |
| `server.js` `/api/server-flags` | 撤销「写全配置」，改回只写用户改动的那一段（与显式路径配套：写全既无必要，还会把 `defaultPassword` 之类的默认值落到磁盘） |
| `server.js` `assertConfigUsable()` | 保留为兜底：`require` 之后校验，缺段或缺 `validate` 时报出文件名、遮蔽原因、两条修复命令。判据是 `rootDir` 为字符串**且** `validate` 是函数——只看 `rootDir` 的话，手写一个带 `rootDir` 的 json 能绕过并炸成 `config.validate is not a function` |
| `sylph.sh` | 更新删除清单处注明 `server-config.json` 是用户文件、不在删除清单内，且 `rm -rf server-config` 不会消除遮蔽 |

### 三条容易重犯的错误（都已写进代码注释）

1. **修复曾写在 `server-config/index.js` 里——那是死代码。** json 遮蔽时该文件根本不执行（实测：删掉 json 才看到模块顶层的 log 打印）。守卫必须放在**能看到实际加载结果**的位置，即 `server.js` 的 require 之后。
2. **「把配置写全」这条路走不通**（见上）。
3. **测试假绿**：断言「`assertConfigUsable` 被调用了」曾用 `indexOf('assertConfigUsable(config);')`，命中的是**注释里同一串字符**；把真正的调用点注释掉，全部测试照样绿。现在改成剥掉注释后再判断，并配一条真实启动的端到端。

### 测试与验证

- `tests/config-shadowing.test.js` 11 条，含 4 条**真实启动进程**的端到端：残片存在时必须照常起来**且残片里的设置必须生效**（只断言「能起来」不够——「忽略该文件」也能通过）；拨开关写出的文件只含用户改动的那一段；**用写出的文件重启**（用户报告的原始路径）。
- 全量 `node --test tests/*.test.js` 结果见下方「验证记录」。
- 变异逐条破坏（require 改回隐式、守卫摘除、判据放宽、文案改动、写盘路径放宽、白名单扩大），每条都必须变红。
- 本轮踩到的两个工具坑，都已写进注释：`fs.cpSync` 带 filter 在 macOS 上只对源根调用一次（「报告成功、目录为空」→ `Cannot find module`），改用 `tar`；泄漏的子进程会继承 stdout 管道，让外层 `out=$(node --test …)` 永远等不到关闭（实测卡 20 分钟），测试改为登记子进程并在退出前统一杀掉、脚本改用文件重定向 + `timeout`。

## 当前基线

当前基线：只用 `main` 一个分支（策略见 `AGENTS.md` 第 8 条），本地与 `origin/main` 一致，代码基线是 v1.11.1 发布提交（本轮；v1.11.0 为备忘录模块的首发）。`package.json` / `version.json` / `CHANGELOG.json` 三处版本均为 `1.11.1`。历史见各版本 CHANGELOG 条目与文末两节。

⚠️ 本段此前长期滞后：停在 v1.6.12，而仓库已到 v1.10.4——**连续多轮发布都没跟着走**。本轮按「写基线的义务归每一轮发布收尾，不是可欠的」补齐。早先 `v1.6.2`–`v1.6.8` 也欠过同一笔账，同样是被后一轮重写补回来的：这条义务写成规则也仍会失守，唯一的兜底是每轮发布收尾时真的动手改这一句。

> 基线只锚定**发布提交与版本号**，不写「最新提交是哪个」：把 tip 的 hash 写进文档，会被承载它的那一笔提交本身顶掉一位——上一版就写成了 `d9713f8`，而包含这行字的提交是 `9eafbb5`。锚定不变的发布提交就不会漂。

分享功能改动已提交为 `39acce5`，发布前的两个缺陷修复为 `ee77a39`，v1.5.7 发布为 `7ab0981`，分享接口滥用防护为 `d3ee955`，分享编辑器交互改版为 `04895fc`，审计与视觉核验修复为 `ff63fd7`，发布前审查修复为 `e5f3fae`，v1.5.8 发布为 `edff173`，模式切换状态错乱修复为 `14bd923`，v1.5.9 发布为 `382c89e`，分享弹窗紧凑化 `a5a2e00`/v1.5.10 `b4522e2`，收藏弹窗 `7779a64`/v1.5.11 `49f9f28`，横屏与软键盘修复为 v1.5.12，**首页材质改版为 v1.5.13**。

首页材质改版（删站点标识、搜索栏三色按钮、快捷键说明行、书签光影、PC 背板）**已提交并发布为 v1.5.13**，`sw.js` 缓存同步升到 `nav-v22`。设计仿真留在 `docs/mockup-v2.html`，回归测试在 `tests/homepage-material.test.js`（11 条，均经红绿验证）。

## 本次完成的内容（首页材质改版：仿真 v2 落地）

以 `docs/mockup-v2.html` 为准，落到 `public/index.html` 与 `public/styles.css`。**已提交、已发布 v1.5.13**。

### 改了什么

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 删站点标识 | `index.html:35` | `.site-identity` 元素连同两条 CSS 规则一并删除，不留死代码。 |
| 三色按钮 | `styles.css:2607` 起 | 网页/收藏=青灰、引擎=琥珀、搜索=实心陶土。各自 `--HUE` 派生底色与光感，三者共用一条规则。 |
| 快捷键说明行 | `index.html:54`、`styles.css:2894` | 桌面显示，`≤600px` 隐藏（`styles.css:2896`）。 |
| 书签光影 | `styles.css:2853` | 新增 `::after` 顶边高光；浅色光晕 `.32→.46`、悬浮加外投影。**尺寸 96×42 与圆角 7px 一律未动。** |
| 宽屏背板 | `index.html:35`、`styles.css:2910` | `≥1024px` 收进 936px 玻璃面；`≤1023px` 兜底（`styles.css:2924`）完全退回原布局。 |

### 发布后按用户反馈补正的四处（v1.5.13 已含前三处的错误版本）

用户比对后发现引擎按钮与搜索按钮的观感与仿真不一致。用「真实指针悬停/按下 + 逐属性 dump」在两种主题下比对，定位到四处差异：

**已修 1：引擎按钮丢失下拉箭头。** 标记里只有 `<span class="engine-name">`，没有箭头 `<svg>`；而旧样式保留着两条 `.engine-arrow` 规则，样式落在一个不存在的元素上，成为死代码——箭头是「这个按钮能点开」的唯一视觉线索。已补 `<svg class="engine-arrow">`，并把箭头定义整块收进材质层。删除旧的那条 `.search-engine.active .engine-arrow` **不是因为不命中**，而是同一状态有 `.active` 与 `aria-expanded` 两个钩子，保留两条规则会各自旋转一次；统一只认 `[aria-expanded="true"]`。

**已修 2：搜索按钮按下态没有边框色。** `:active` 未写 `border-color`，而指针按下时仍停在按钮上、`:hover` 依然命中，于是悬停的浅色描边 `rgba(214,161,129,.7)` 留在了深色实心底上（正确值是 `rgba(148,94,74,.62)`）。**只在按住不放时才看得见**，单击太快根本捕捉不到。已显式补上。

**已修 3：搜索按钮常态渐变的中间档取错值。** 移植时用了 `var(--accent-hover)` = `#79503f`，仿真的 `#71513f`；语义也不对（`--accent-hover` 是悬停色，不是常态底色）。深色档同样整体错位一档：`--accent`/`--accent-hover` 换成了仿真用的 `#d4a181`/`#e0b293`。已全部对齐。

**已修 4：最小宽度与内边距。** 引擎 66→68px（要容纳箭头）、搜索 47→49px、`padding` 0 10px→0 11px。

**有意保留的差异：按钮高度 44px（仿真 40px）。** 44px 是触摸目标下限，改回 40px 等于重新引入上一轮列为 P1 的缺陷。除高度外，色相、渐变、描边、阴影、位移、内边距、最小宽度已与仿真**逐属性一致**（浅色与深色两套均验证）。

### 第二轮反馈：Google 下拉框对齐仿真 + 说明行

用户随后指出「点击 google 的下拉框动作和效果与仿真不一样」。用「真实指针悬停/按下 + 逐属性 dump」量出 7 处差异，用户选择**全部对齐仿真**：

| 项 | 改前 | 改后（=仿真） |
| --- | --- | --- |
| 锚点 | `left: 0`（贴搜索框左缘 x=360） | `left: 58px`（对齐按钮左缘，实测偏移 0px） |
| 开合动画 | `dropIn 0.15s` 下落淡入 | 无 |
| 间距 | `calc(100% + 8px)` | `calc(100% + 4px)` |
| 尺寸 | 160px / padding 6px / 圆角 11px | 152px / 5px / 10px |
| 阴影 | `--shadow-lg` | `0 12px 28px rgba(67,51,39,.13)` + `inset 0 1px rgba(255,255,255,.66)` |
| 选项行 | 高 35px、padding 10px 12px | 高 31px、padding 6px 10px |
| 选中项 | 米色底 `rgba(148,94,74,.11)` | 主色文字 + 加粗，**无底色** |

`58px` 由盒模型推出（1px 表单边框 + 5px 内边距 + 48px 模式按钮 + 4px 间距），实测与按钮左缘**完全对齐（偏移 0px）**；仿真的 `left: 60px` 差 2px，未采用。`≤370px` 有独立偏移 `51px`。旧样式在 `≤768px` 曾把 `left` 重置回 0，等于大屏修好小屏又坏，已改为不重置。

**说明行**：文案改为只讲两个触发符——`/` 查收藏、`>` 分享文本，方向键与 Enter 这类次要操作留给「说明」弹窗。间距从「上 34px、下 0px」改为 **上 10px、下 26px**（贴搜索框、与收藏区拉开）；间距归说明行自己给，故 `.header` 的 `margin-bottom` 归零，`≤600px` 说明行隐藏时再把 30px 还给 `.header`。

### 代码审查（`git diff v1.5.13`）

两轴各起一个子代理：**Standards**（对照 `AGENTS.md` + `docs/architecture.md` + 代码异味基线）与 **Spec**（对照 `docs/mockup-v2.html` 与用户历次要求）。findings 逐条在真实浏览器/源码里复核后才动手。

**已修（在本次边界内）**

- **`sw.js` 缓存未升**：本次改了 `public/index.html` 与 `public/styles.css`，两者都在 `ASSETS` 白名单里，缓存却仍是 `nav-v22`。已升 **`nav-v23`**。不升的话老用户继续吃旧资源。
- **下拉选项缺按下反馈**：仿真 `.engine-choice:active` 有 `--press-shadow`，移植时漏了。
- **我写错的一条理由**：我在注释、`architecture.md` 和测试里都写了「旧样式 `.search-engine.active .engine-arrow` 永远不命中，因为 JS 设的是 aria-expanded」。**这是错的**——那一行确实能命中。删它的真实理由是：同一状态有两个钩子，留两条规则会各自旋转一次，统一只认 `[aria-expanded="true"]`。三处已改正，并补断言禁止 `.search-engine.active` 再长回来。
- **另一条写错的注释**：我写「两个下拉在仿真里圆角 11 vs 10」——11 是**本项目**收藏下拉的值，仿真里收藏面板是 **13px**。已改正。
- **死声明**：`≤768px` 的 `.engine-dropdown { right: auto }`，基础规则从未设过 `right`，已删。
- **`.engine-option` 两条背靠背规则**已合并为一条。
- **文档行号**：本轮编辑又让 20 余处 `styles.css:NNN` 失效，已逐条 `sed -n` 重核。这个文件每次改动都会让文档行号漂移，已把 `architecture.md` 里非必要的行号去掉，只留散文描述。

**已记录、本次未改（超出当前边界，避免连带改动已发布的视觉）**

1. ~~`.search::after` 单层光感~~ → **已在第三轮修完**，见下节。
2. ~~书签 `::before` 仍是旧色、光晕靠提透明度补偿~~ → **已在第三轮修完**。
3. ~~书签 `::after` 顶边高光内缩 8px~~ → **已改为 12px**。
4. ~~书签悬停描边色~~ → **已改为仿真的 `rgba(148,94,74,.37)`**。
5. ~~`.fav-dropdown` 圆角 11px~~ → **已改为 13px** + 仿真的阴影。
6. ~~`app.js` 的 `.active` 无消费者~~ → **已删四处 `engineBtn.classList`**。

**审查中推翻的（记录以免重复调查）**

- Standards 轴称「`.engine-option.active` 是死代码」——**部分成立**：三条声明确实全被材质层覆盖，但这是本项目「材质层覆盖旧样式」的既有模式，非本次引入，故不动。
- Spec 轴称「下拉几何 58px 与仿真 60px 不一致，需要裁定」——**已裁定**：58px 实测零偏移，比仿真的 60px（差 2px）更准，保留 58px。

## 第三轮：补完光感双层与遗留项，并回答「为什么仿真更精致」

**改了什么**

| 项 | 改前 | 改后（=仿真） |
| --- | --- | --- |
| `--glint-white` | 未定义 | 新增，浅色 `rgba(255,255,255,.90)`、深色 `rgba(255,244,226,.18)`，三处主题块 |
| `.search::after` | 单层 `--search-glint`，`.44` | **双层**（白高光 77×51 + 色相 105×52），`.40`，过渡 85ms |
| `.bookmark::before` 白层 | 写死 `rgba(255,255,255,.54)` | `var(--glint-white)` |
| `--bookmark-glint` | `rgba(184,150,124,.16)`（偏灰） | `var(--glint)` |
| `--bookmark-glow-opacity` | `.46`（提透明度补偿） | **`.32`**（仿真本值） |
| 书签 `::after` 内缩 | 8px | 12px |
| 书签悬停描边 | `rgba(116,100,85,.28)` | `rgba(148,94,74,.37)` |
| `.fav-dropdown` | 圆角 11px + `--shadow-lg` | 圆角 13px + 仿真的 `0 4px 8px / 0 16px 30px` |
| `app.js` | 4 处 `engineBtn.classList` | 全删，`aria-expanded` 成为唯一真相来源 |

**关键认知（写下来以免重犯）**：上一轮为了让书签「更有立体感」，方向搞反了——把 `--bookmark-glow-opacity` 从 `.32` 提到 `.46` 来补偿缺失的白色高光层。补上 `--glint-white` 后两层颜色本身就足够，透明度必须回到 `.32`。**该换的是颜色，不是强度**；用强度补颜色缺失，等于用全局变亮掩盖局部缺料。

### 「为什么仿真那版看上去更精致」——实测结论

用户问是不是因为搜索框距上边框更远、或布局比例更协调。两版在 1280×800、浅色下逐项测量：

| 指标 | 实际 | 仿真 | 判断 |
| --- | --- | --- | --- |
| 背板顶距视口 | 35px | 35px | 相同 |
| **搜索框顶距视口** | **59px** | **83px** | **差 24px，这是主要差别** |
| 背板内边距 | 24px 30px 30px | 24px 30px 30px | 相同 |
| 搜索框高 | 56px | 52px | 差 4px（44px 触摸下限导致的有意差异） |
| 搜索框到说明行 | 10px | 11px | 相同 |
| 说明行到收藏区 | 26px | 26px | 相同 |
| 网格宽 / 占背板 | 876px / 89% | 876px / 89% | 相同 |
| 书签 | 96×42，8 列，间距 8 | 117×55，7 列，间距 10 | 差异**来自尺寸需求，不是比例** |

**结论：用户猜的两点都对，但可以更精确——差距只有一个来源。**

1. **顶边距离差 24px，是唯一真实的布局差异。** 原因不是「实际版本忘了留白」，而是结构不同：仿真保留了一个 `min-height: 4px` + `margin-bottom: 20px` 的 `.topbar` 占位元素（原本放主题切换按钮），本项目删站点标识时连它一起删了，两者与背板 24px 内边距叠加后**恰好都是 24px**——但仿真是 4+20 两段、实际是一段，观感上仿真更「透气」，因为多出来的 20px 落在内容与背板顶边之间，形成了一段渐进的缓冲。**这个差异在删掉那个空占位元素时就已经产生，不是本轮改动造成的。**
2. **布局比例其实完全一致**——网格宽度、占背板比例、说明行上下间距三项逐值相同，不存在「比例不协调」。
3. **书签的差异是需求导致的，不是疏漏**——你明确说过「实际项目的收藏夹书签按钮大小更合适」，96×42 是刻意保留的；仿真 117×55 是原型阶段的估计值。列数 8 vs 7 是这个尺寸差的必然结果。
4. **本轮修完光感双层后，观感差距已经缩小**：单层光晕偏灰发糊的问题解决，剩下的就是那 24px 顶边距离。

### 第四轮：对齐那 24px 顶边距离

用户选择「对齐仿真」。改动很小，但过程中发现两件事：

- **背板 `padding-top` 24px → 48px。** 48 = 24 + 4 + 20，正是仿真里「内边距 + 空 topbar 占位 + 其下边距」三段之和。改完实测搜索框顶落在 **83px**，与仿真逐值相同。**第一次只改到 44px（漏了 topbar 那 4px）时实测是 79px**，差了 4px 才发现——这类等效换算不能只做算术，必须量。
- **顺带补上一条漏掉的规则：搜索框的顶边高光。** 仿真 `.search-shell::before` 有一条 1px 受光高光，移植时整块缺失。背板加上内距后框顶与背板顶拉开 20px，这条亮边的缺失才显出来——之前两者只差 4px，看不出来。已补，左右各内缩 11px；因 `::after` 已被光感占用，走 `::before`。

**窄屏验证**（`padding-top` 不应泄漏到小屏）：1280 与 1024 为 48px/83px；1023 与 390 均回落 `padding: 0`，说明行 390 下 `display: none`，四个视口均无横向滚动。深色 1280 同样落在 83px。

## 第五轮：修移动端点按的蓝色底框

用户报「移动端点击搜索框那几个按钮会有蓝色的底框」。在 iPhone 14 设备模拟下量得 `-webkit-tap-highlight-color` 的生效值是 **`rgba(51, 181, 229, 0.4)`**——正是那抹蓝（iOS Safari / 移动 Chrome 的 UA 默认值）。

**根因不是搜索框本身，是覆盖不全**：项目里早就有两处 `-webkit-tap-highlight-color: transparent`，但只针对 `.fav-item`、`.fav-manager-item`、`.btn`——收藏项与管理按钮。搜索栏三个按钮、书签、引擎选项、右下角 dock 都不在其中。

已在材质层新增一条兜底（`styles.css:2909`）：

```css
@media (hover: none) and (pointer: coarse) {
  .search-mode,.search-engine,.search-btn,.bookmark,.bookmark-text-only,.engine-option,.fab,.fab-help {
    -webkit-tap-highlight-color: transparent;
  }
}
```

**键盘可达性不受影响**：材质层那条统一的 `:focus-visible` 轮廓（`outline: 2px solid var(--focus)`）只在键盘导航时触发，正是该给提示的时候；关掉的只是触屏点按的 UA 底框。

**未能在本机验证的部分（如实记录）**：无头 Chrome 报 `maxTouchPoints: 0`、`(hover: none)` 为 false，**无法真正模拟触屏**，所以「点上后蓝框消失」这一现象本身没能在浏览器里跑出来。已验证的是：规则能被 CSSOM 正确解析、8 个选择器在页面上都各能匹配到真实元素、声明值为 `transparent`；并补了源码形状断言钉住它。

**过程中的一次假红**：新断言里我想验证「材质层的 focus-visible 轮廓未被误删」，破坏时用 `findIndex` 找 `.bookmark:focus-visible,` 开头的行，结果先命中了**旧样式区 281 行**那份同选择器规则——破坏没生效，测试却"绿"了。这与本项目记录的「断言要锚定到材质层，不能取第一个匹配」是同一类错误，已改成锚定材质层再破坏，测试如期转红。

### 发布时拦下的一处遗漏

发 v1.5.16 前检查「v1.5.15 之后改了什么」，发现 `public/styles.css` 已改而 `sw.js` 的 `CACHE` 仍是 `nav-v23`——**发布阻断项**：Service Worker 是 cache-first，老用户会继续吃 v1.5.15 的旧样式，本次修复在他们手机上根本不生效。已升到 `nav-v24`。这条纪律在 `AGENTS.md` 与 `docs/current-work.md` 都有记录，本次差点重犯，**以后每次发版前先跑一次「包内是否有改动 → 缓存是否已升」的两步检查**。

## 第六轮：按钮按下加出「按键行程」

用户反馈「仿真那版按钮点击有下沉的感觉，当前版本只有凹陷和玻璃光感」，并补充形容是「整个按钮像钢琴键一样被整个按下去，离原平面更远了」。

**先量后改，结论是：这不是移植遗漏。** 逐属性对比两版按住不放时的计算样式，位移（1px）、凹陷（`inset 0 4px 9px`）、描边、底色**全部逐字相同**，按钮在容器内的上下间隙也相同（各 6px）。仿真之所以「按下感更强」，是因为它给出的是**按键行程**而非仅凹陷：按钮离开原平面。

**改动**：`styles.css` 的 `:active` 由 `translateY(1px)` 改为 `translateY(2px) scale(.985)`。行程从 1px 翻倍，配合轻微缩放产生离开平面的实感。

**为什么缩放幅度选 .985**：44px 按钮缩后仍有 43.3px，高于 40px 底线，不牺牲触摸目标；已加断言钉住 `scale ∈ [.98, 1)` 且 `44 × scale ≥ 40`。若为了更夸张的观感继续放大，这条断言会先转红。

**是否会被容器裁切**：容器 `overflow: visible`，按下后按钮下沿落在 135px、容器下沿 139px，尚有 4px 余量，不会溢出。

**验证过程中的两次弯路（记录下来）**：
1. 第一次测量时取「按钮中心点」作为鼠标坐标，但中心点实际落在子元素 `.engine-name` 上，导致 `:hover`/`:active` 都不命中、读数全为 `none`，一度以为按下态没生效。改用 `elementFromPoint` 复核才定位到。
2. 跨进程分两次 `agent-browser` 调用读取按住态，第二次调用时鼠标已松开、状态复位，读数全为 0。必须在**同一次调用**里完成「按下 + 读数」。

**未验证**：真机触控板的实际手感，以及 44px 高度下 2px 行程是否在移动端显得过短或过长——本地无头浏览器无法代表真机触感。

## 第七轮：浅色下补回外投影（机制而非色相）

用户指出「深色模式下书签按钮的点击下沉感觉是对的」，让我看深色是怎么实现的。**这个方向选对了——深色是对的参照系，之前一直在拿仿真当参照。**

**先查机制差异，数据完全支持用户的判断：**

| | 浅色 | 深色 | 同机制？ |
| --- | --- | --- | --- |
| 悬停抬升 | -1px | **-2px** | ✗ |
| 常态外投影 | **无**（纯内阴影） | `--shadow` | ✗ |
| 悬停外投影 | 淡灰棕 `.06/.09` | `--shadow-lg` | ✗ |
| 悬停过渡 | 90ms | 160ms | ✗ |
| 按下位移/缩放 | 1px / .975 | 1px / .975 | ✓ |

深色「浮得起来」靠的是**外投影跟着走**：常态带 `--shadow`、悬停换 `--shadow-lg`，抬升时身后有真实影子变长。浅色此前**常态完全没有外投影**，悬停那层又是几乎不可见的淡灰棕——抬了 -1px 却看不到影子，等于白抬。

**我在上一轮的解释是错的**：曾说「深色强对比所以对」，实际是机制缺失，不是色相问题。已在 `docs/architecture.md` 写明正确机制。

**改动（浅色侧三处收敛，使两套主题共用同一套机制）**

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 浅色 `--shadow` | `0 1px 3px rgba(0,0,0,.06)` | `0 1px 3px rgba(60,45,32,.11),0 4px 10px rgba(60,45,32,.07)` |
| 浅色 `--shadow-lg` | `0 8px 24px rgba(0,0,0,.1)` | `0 4px 10px rgba(60,45,32,.10),0 14px 30px rgba(60,45,32,.15)` |
| 书签常态/悬停 | 自带淡影 | 引用 `var(--shadow)` / `var(--shadow-lg)` |
| 搜索栏按钮常态/悬停 | 自带淡影 | 引用同两个 token |
| `--bookmark-lift` | -1px | **-2px**（与深色一致） |

强度取中间档：比旧的 `.06/.1` 强（那档在米色底上看不见），比深色的 `.3/.5` 弱（到那档浅色会发脏）。深色块**完全未改**。

**验证**：浅色悬停实测 `translateY(-2px)`，引擎按钮常态带 `rgba(60,45,32,.11)` 外投影、悬停换成 `rgba(60,45,32,.10) .15`，深色读数与改前逐字相同。107 个测试全绿，新增 2 条断言（浅色必须带外投影、三处 `--bookmark-lift` 必须一致），三种破坏均验证转红。

**未验证**：新投影强度在真机上的观感——尤其浅色下是否偏重。已把值调到中间档并留了断言，但最终观感仍需真机确认。

### 发布 v1.5.17

发版前两步检查：`git diff v1.5.16..HEAD --name-only` 显示 `public/styles.css` 有改动（`a00a88f` 按键行程 + `8eabfd2` 浅色外投影），`public/` 在 `sw.js` 的 `ASSETS` 白名单里 → 缓存必须升。已从 `nav-v24` 升到 `nav-v25`。**这条纪律上一版刚踩过一次，本次按流程跑完两步检查。**

### 四处旧样式残留（浏览器实测才暴露）

**已修 A：收藏态的「打开」按钮是琥珀色。** 旧样式有一条 `.search.fav-search-mode .search-btn { background:#f59e0b }`，特异性 `(0,3,0)` 压过新材质层的 `.search-btn` `(0,1,0)`，实心陶土被换成琥珀底。只在真实浏览器截图里看得出来——单测与 `getComputedStyle` 在未进入收藏态时都测不到。已**删除**该规则（不是覆盖），原位留了解释性注释（`styles.css:1152`），并在 `tests/homepage-material.test.js` 加断言钉住。

**已修 B：说明行在手机上照样显示。** 基础规则 `.search-caption { display:flex }` 原本写在文件末尾的 `≤600px` 块**之后**，同特异性下把块里的 `display:none` 压掉。390×844 实测 `display` 仍为 `flex`。已把基础规则移到 `≤600px` 块之前，并补了一条**断言相对源码位置**的测试——两条规则都「存在」时只有顺序能区分对错。

**已修 C：验证过程中自己的测试是假绿的。** 上面第 B 条最初没被测出来，因为断言只检查「基础规则有 `display:flex`」和「`≤600px` 块里有 `display:none`」，两条都满足，但层叠结果是错的。另外加琥珀色断言时，它匹配到了我自己写的解释性注释里的 `#f59e0b` 字样——剥注释后才是正确判定。

**已改 D：`--kb-inset` 的验证夹具漏字段。** 两次手写 fixture 都漏了 `searchEngines`，页面直接白屏「加载失败」（`app.js:618` 读 `config.searchEngines.find`），报错只出现在浏览器控制台。**对策：fixture 应从服务端默认配置派生，而不是手写。** 手写的那次还误把服务器配置写进了 `config.json`（书签数据文件），并一度用不完整的 `server-config.json` 覆盖默认配置导致 `paths` 丢失——端口改用环境变量 `PORT=` 传递，不要写配置文件。

### 验证记录

```
node --test tests/*.test.js          → 88 tests, 88 pass, 0 fail
for f in $(find public scripts -name '*.js'); do node --check "$f"; done   → 无输出
grep -c 'max-width: 1023px' public/styles.css  → 1
git diff --check                     → 无空白问题
```

新增 `tests/homepage-material.test.js` 共 11 条。**每条都做过红绿验证**：改坏实现后确认对应测试转红，再恢复并 `diff` 确认文件逐字复原。覆盖层叠顺序、深色双块一致性、按钮唯一声明、凹陷深度对比、书签尺寸未偏移、背板兜底唯一性、琥珀覆写不存在。

**五视口实测（真实服务器 + fixture，非 file://）**

| 视口 | 背板 | 书签 | 说明行 | 左右留白 | 横向滚动 |
| --- | --- | --- | --- | --- | --- |
| 1280×860 | 936px 可见 | 96×42 | flex | 172/172 相等 | 无 |
| 1024×768 | 936px 可见 | 96×42 | flex | 44/44 相等 | 无 |
| 1023×767 | 979px 消失 | 96×42 | flex | 22/22 相等 | 无 |
| 834×1112 | 790px 消失 | 96×42 | flex | 22/22 相等 | 无 |
| 390×844 | 366px 消失 | 116.66×44 | **none** | 12/12 相等 | 无 |

**交互实测**：书签 `--glow-x/y` 被 `app.js` 写入 px 值（46.8px / 20.5px）；`pointerdown` 加 `.is-pressed`，`window` 上 `pointerup` 后移除，260ms 后为 `false`（无卡住）；分享态 `>` 展开正常（56→116px、`transition` 六项属性完整、退出后回落）；模式按钮选中态为外投影「点亮」，与 `:active` 凹陷可区分；**系统深色与手动 `data-theme="dark"` 逐字一致**（三色、凹陷、悬浮阴影、按钮渐变五项 `cmp` 全等）。

### 补充验证（发布 v1.5.13 后补做，原先误列为「未验证」）

初版把三项笼统记成「需真机确认」，其中两项本地其实能给出结论，已补做：

- **深色三色相区分度 —— 已确认可用**。1280×800 深色截图肉眼比对：网页=浅青灰、引擎=琥珀金、搜索=亮陶土，三者边界清晰。数值上三色锚点（`138,160,168`/`208,162,96`/`223,169,140`）亮度差足够，原先的顾虑不成立。
- **书签 hover 态 —— 已确认**。`agent-browser` 真实指针悬停：`:hover` 命中、`transform: translateY(-1px)` 生效、`box-shadow` 含新增外投影（`0 2px 5px` + `0 9px 18px`）、`::after` 顶边渐变生效、`::before` 光晕 `opacity: 0.46`。截图可见该卡片明显浮起且边缘更亮，与同排静止项对比清晰。
- **软键盘让位 —— 接线已验证，但「键盘本身」仍未复测**。无头浏览器不会真的弹出软键盘，因此直接驱动机制输入：把 `--kb-inset` 置为 300px 后，分享编辑区 `max-height` 从 `420px` 收到 `120px`（`styles.css:641`）。另有两条消费点同样在 `calc()` 内：`styles.css:1633/1641`（收藏弹窗）与 `admin.css:517/518`（UI 对话框）。**这证明接线正确，不证明真机键盘行为一致**——真机仍需看一眼分享编辑区底部按钮是否被键盘遮住。

### 仍未验证（本地造不出该环境）

- **真机 Safari / 微信内置浏览器**：背板发丝线依赖 `mask-composite: exclude`，旧版 WebKit 的支持情况无法在 Chrome 里复现。若在你的设备上发丝线不显示，背板退化为无边框玻璃面，不影响功能。
- **iOS 软键盘弹出时的真实布局**：如上，接线已验证，行为未验证。

### 下一步

1. ~~用户确认视觉后提交~~ → 已发布 v1.5.13。
2. ~~发布前把 `sw.js` 的 `CACHE` 升到 `nav-v22`~~ → 已升。
3. **仅剩真机确认两项**：旧版 WebKit 上的背板发丝线、iOS 软键盘下的分享编辑区。其余全部已本地验证。

## 上一轮：分享弹窗紧凑化 + 移动端适配审计

分享弹窗与移动端适配提交为 `a5a2e00`、v1.5.10 发布为 `b4522e2`；收藏弹窗的同类修复为 `7779a64`、v1.5.11 发布为 `49f9f28`；引擎下拉与软键盘修复见下节，本次发布 **v1.5.12**。

### 一、分享弹窗

**PIN 输入框原本掉到弹窗最下面**，根因是 DOM 顺序：`app.js` 旧版把 `.ui-dialog-reveal` 渲染在**所有 option 之后**，与 CSS 无关。已改为紧随触发它的复选框渲染（`showUiDialog` 新增 `reveal` 就地插入）。实测勾选后：复选框底边 337.3 → PIN 框顶 345.3 → 有效期组顶 424.3，PIN 确实位于两者之间。

**有效期改为 2×2 两横两竖**。`showUiDialog` 新增可选 `groups` 参数承载分组选项，四档有效期装进 `.ui-dialog-options` 网格容器并加「有效期」分组标题。实测网格 `grid-template-columns: 164.5px 164.5px`，两行两列，每格 46px 高（≥44px 触摸标准），「30 分钟」单行不折行。

**弹窗在窄屏被浏览器遮挡**，根因不是缺少 `position: fixed`（`.ui-dialog-overlay` 一直在 `admin.css:290` 有 `position: fixed; place-items: center`），而是 `admin.css:401` 的 ≤480px 规则写了 `align-items: end`，**把居中弹窗改成了底部抽屉**。已删除该规则，窄屏恢复居中，改为四边 `env(safe-area-inset-*)` 内边距。5 档视口实测上下留白完全相等（见下表）。

**收紧弹窗布局**：`admin.css:306` 的 `.ui-dialog-hint` 负边距 `-4px` 改为 `-2px`（原值让提示文字贴住复选框）；`.ui-dialog-choice` 补 `min-height: 40px`（窄屏 44px）。

### 二、移动端适配审计（4 项确认破损 + 6 项体验缺陷）

审计覆盖 `index.html`、`styles.css`、`admin.css`、`sw.js`、`server.js` 分享页。**共 42 个 `@media` 块**（`styles.css` 31、`admin.css` 5、`index.html` 2、`server.js` 4；`sw.js` 无），宽度断点为 768 / 600 / 480 / 370 / 1024，另有横屏 `max-height:500px` 与 `hover/pointer` 能力查询。管理界面**不是独立页面**，而是 `#modal` 弹窗，由后加载的 `admin.css` 接管（`admin.css` 加载在 `styles.css` 之后，同特异性时它胜出）。

**P0（会造成破损，本次已修）**

| # | 位置 | 缺陷 |
| --- | --- | --- |
| 1 | `styles.css:2772` | `.search-input` 在文件**末尾**声明 `font-size: 15px`，覆盖了 583/603 行的移动端 `16px`。15px 低于 iOS Safari 自动缩放阈值 → 点击输入框整页被放大。改为 16px。 |
| 2 | `admin.css:401` | ≤480px 的 `align-items: end` 把弹窗变底部抽屉，被地址栏与 Home 指示条遮挡。 |
| 3 | `styles.css:2789` | `.utility-dock` 与 `.toast` 均无 `env(safe-area-inset-bottom)`。页面已声明 `viewport-fit=cover`，底部固定元素会压住 iOS Home 指示条。 |
| 4 | `server.js:1114` | 分享接收页 viewport meta **缺 `viewport-fit=cover`**，刘海屏直接留白。补上后 `body` 的 `padding` 也改为 `max(20px, env(safe-area-inset-*))`，否则该 meta 无实际作用。 |

**P1（明确体验缺陷，本次已修）**

| # | 位置 | 缺陷 |
| --- | --- | --- |
| 5 | `styles.css:2728` | 搜索栏三按钮 36px（≤480px 降到 32px）、dock 内按钮仅 31px，均低于 44px 触摸标准。统一提到 44px（本次改版后由 `--ctl-h: 44px` 统一提供）。 |
| 6 | `styles.css:1727`（横屏块） | `.help-content` 与 `.paste-result` 没有高度上限，横屏矮视口下内容溢出、关闭按钮随内容滚走。补 `max-height: 88dvh; overflow-y: auto`，同时横屏把搜索栏收窄（现值 54px，`styles.css:1768`）。 |
| 7 | `index.html:5`、`styles.css:58/67` | `100vh` 在 iOS Safari 中是地址栏收起时的高度，展开时底部出现空白带。改为 `100vh` + `100dvh` 双声明（不支持 dvh 的浏览器沿用前者）。`admin.css` 早已全面改用 dvh，首页是漏网的。 |
| 8 | `styles.css:2772` | placeholder 偏上：`line-height: 20px` + `padding: 8px 10px` 在 36px 容器内基线偏离中心。改为 `min-height: 44px; line-height: 44px; padding: 0 10px`，文字精确垂直居中。 |
| 9 | `styles.css:2858` | ≤480px 的 `max-width: 304px` 硬上限在 390px 机型上造成右侧大片空白，且使 `≤600px` 块里的 `auto-fill 96px` 成为死代码（同断点同特异性、后者在后）。改为 `max-width: 100%` + 三列等分。 |

### 三、代码审计（基线 `382c89e`...工作区）

**已修 1：`showUiDialog` 新增 `groups` 后三处取值仍读旧的 `options`。** 新参数若不同步，`choices.ttl` 会永远读不到、返回值也会错误地退化成 `true`。已引入 `allOptions` 统一承载 `options` 与 `groups.flatMap(...)`，改动 3 处：reveal 的 owner 索引、提交时的 `close(...)` 判定。

**已修 2：测试桩把分组内的选项判给了错误的父节点。** `parseInputs` 只取 `<div>` 栈的最内层，新增 `.ui-dialog-group` 包装后 `stack.at(-1)` 变成 group 容器，`closest('.ui-dialog-option')` 会返回 `null`（生产代码读 `input.closest(...).dataset.name` 抛 TypeError）。已改为记录完整祖先链并取**最近的** `.ui-dialog-option`，与浏览器语义一致。

**已修 3：一条测试固化了即将改掉的旧值。** `paste-composer.test.js` 断言 `min-height: 36px`，而本次要把该值提到 44px。测试本身没有错（它守的是"不得被固定 height 钉死"这个真实意图），已更新为 44px 并**补上 `font-size: 16px` 断言**，守住同一个意图的另一半。

**新增测试桩的收尾修正**：新加的两条 DOM 顺序用例最初只 `await` 了永不 resolve 的弹窗 Promise（弹窗只在提交或取消时 resolve），导致连续 5 项 `cancelledByParent`。已改为点击取消按钮收尾。**这是测试自身的缺陷，不是生产代码的问题。**

### 四、发布前双轴代码审查（基线 `382c89e`）

Standards 与 Spec 两轴各跑一个独立 sub-agent（基线 `382c89e`），报告分列不合并、不重排。**发现 7 条属实、已修；2 条经复核推翻；1 条不采纳。**

**已修 1（Standards，硬违规）：交接文档与仓库状态不符。** 本节当时写「尚未提交」，但改动已落为 `a5a2e00`。已按实际更新，并补上 `v1.5.10` 的版本记账。

**已修 2（Standards，硬违规）：`docs/architecture.md` 未同步。** 两处：原写「搜索态保持单行（`min-height: 36px`）」，已随本次改动失效；`showUiDialog` 新增 `groups` 属稳定接口扩展，原文未记载。已补写，并新增一段说明三条并行选项入口必须同步维护 `allOptions` 的三处取值——这正是本次踩到的坑。同时记录了软键盘不受 `dvh` 约束这一未处理项。

**已修 3（Standards，Duplicated Code）：选项模板被复制成两份。** `app.js` 的 `options.map` 与 `groups.map` 各写了一份逐字节相同的 `.ui-dialog-option` 标记（仅缩进不同），日后改一处忘另一处即漂移。已抽成 `renderOption()`，两处共用。

**已修 4（Standards，Feature Envy）：`revealOption` 仍只扫平铺数组。** `allOptions` 已经合并了两个来源，但上一行的 `revealOption` 判定仍只查 `options`。当前唯一调用方把 `reveal: true` 放在平铺选项上，因此**尚未暴露**；一旦把带 `reveal` 的选项挪进 `groups`，展开区会静默不渲染。已改为查 `allOptions`。

**已修 5（Standards + Spec，Duplicated Code）：同一个横屏 `@media` 出现两次。** 原先 `styles.css` 已有 `(max-height: 500px) and (orientation: landscape)`（1728 行），本次又在文件末尾追加了一个。**这正是本仓库发生过两次事故的那类问题**（尾段覆盖前段），也已作为 P2 记在后续项第 20 条里。已把帮助面板、分享结果面板与搜索栏三组规则合并进既有的那个块，末尾不再有第二个。

**已修 6（Spec）：2×2 网格每格只有 42px，低于选项卡承诺的 44px。** 我在澄清轮给出的选项卡写明「每格约 180×44px」，实现时把 `min-height` 设成 40px、窄屏再抬到 44px，结果平板/横屏/PC 实测全是 42px。已把基础规则直接设为 44px 并删掉窄屏那条重复声明。

**已修 7（Spec）：`server.js` 容器内边距漏改。** 计划里写了「容器 `padding: 24px` 改用 `max(24px, env(...))`」，实际只改了 `body`。已补。

**已推翻 1：「≤480px 的 `height: 32px` 覆盖了 44px 触摸目标」。** 审查认为 ≤480px 块的 `height: 32px`（`styles.css:602/605/604/607`）会压过末尾的 `min-height: 44px`，理由是"更specific/更早"。**不成立**：`min-height` 与 `height` 不是同一属性，永远同时生效，**与源码顺序无关**，且 `min-height` 优先。真实 Chrome 在 390×844 实测四个控件全为 **44px**（`modeBtn` / `engineBtn` / `searchBtn` / `searchInput`），并非 32px。

**已推翻 2：「PIN 输入框在 PIN 提示文字上方」。** 审查只做了模板字符串的 `indexOf` 比较，断言 reveal 区块排在 `opt_pin` 之后就算通过，因而误判视觉顺序。真实浏览器实测 y 坐标：复选框文案 280 → 提示文字 309.8~326.3 → **PIN 输入框 345.3** → 「有效期」标题 424.3，完全符合「紧跟在 PIN 码提示下面」。

**未采纳：`groups` 是 Speculative Generality。** 审查提出 `.ui-dialog-options` 只有一个调用方、且只有一个分组，怀疑过度设计。**不采纳**：2×2 网格正是用户明确选定的排布（而非四档横排一行），`groups` 承载的正是这个需求；`confirmAction` / `notice` / `promptValue` / `changePassword` 传空数组时行为与改动前逐字节一致，不构成为想象中的需求预留钩子。

**当时仍未处理、经确认后补做**：`.fav-dialog` 在窄屏也是底部抽屉（真因在 `styles.css` 的 ≤768px 块而非 `admin.css`——我最初把它记成了后者，行号也写错了），已按 `.ui-dialog` 同款处理修掉，见下节。原需求点名的「大折叠」机型仍未纳入实测视口，记入后续项。

### 五、收藏弹窗的同类修复（`7779a64`，发布为 v1.5.11）

审查指出 `.fav-dialog` 与本次修掉的 `.ui-dialog` 属同一类缺陷。经确认后一并修掉，并暴露出**我把根因记错了文件**：不是 `admin.css` 的 ≤480px 块，而是 **`styles.css` 的 ≤768px 块**——断点都不同，因此此前只搜 `admin.css` 根本没找到它。真正的贴底声明在 ≤768px 块里的 `.fav-dialog-overlay`（`styles.css:1628` 起；原为 `align-items: flex-end` + `border-radius: 16px 16px 0 0`，现已改为 `align-items: center`，见 1630 行）。

改动：`styles.css` 的 ≤768px 块改为 `align-items: center` + 四边安全区内边距 + `border-radius: 14px` + `max-height: 88dvh; overflow-y: auto`；`admin.css` 的 ≤480px 块里那条重复的底部抽屉声明删除，改为注释指向唯一定义处。`slideUpMobile` 动画随之不再被使用，但保留在原处（`@keyframes` 仍在 768px 块内，若确认无其他引用可再清理）。

新增守卫：`every overlay dialog stays vertically centred on narrow screens` 同时断言**两个**弹窗——`.ui-dialog-overlay`（≤480px）与 `.fav-dialog-overlay`（≤768px），并额外断言 ≤480px 块内不得再出现 `.fav-dialog` 声明（防止第二处覆盖重新长出来）。

**测试桩自身的一个坑**：`mediaBlock()` 原本用 `indexOf` 取**第一个**同查询块，而 `styles.css` 里有多个 `@media (max-width: 768px)`，取到的不是要断言的那个，测试直接报「规则不存在」。已改为 `mediaBlocks()` 收集全部同查询块，再用 `requiredIn` 按内容定位。**这是一条会给出误导性失败的断言**，值得记住。

红绿验证：把 `.fav-dialog-overlay` 改回 `align-items: flex-end` 后该测试变红，恢复后 75 项全绿。

真实 Chrome 验收（进入管理面板 → 「添加收藏」打开 `.fav-dialog`，5 档视口）：

| 视口 | 弹窗高 | 上留白 | 下留白 | 居中 | 完整在视口内 | 内部滚动 |
| --- | --- | --- | --- | --- | --- | --- |
| 390×844 | 624.0 | 110.0 | 110.0 | ✅ | ✅ | 否（622/622） |
| 360×640 | 563.2 | 38.4 | 38.4 | ✅ | ✅ | 是 |
| 844×390 | 351.0 | 19.5 | 19.5 | ✅ | ✅ | 是 |
| 834×1112 | 581.5 | 265.3 | 265.3 | ✅ | ✅ | 否 |
| 1280×800 | 581.5 | 109.3 | 109.3 | ✅ | ✅ | 否 |

390×844 下另测：圆角 14px、`align-items: center`、按钮 44px、五个文本框 50px 高且 `font-size: 16px`。console 零消息。

**搜索框桌面高度保持 56px（经确认）**：桌面 `.search` 由 48px 变 56px 是「按钮抬到 44px」的必然结果（44 + 5×2 内边距 = 54px），不是独立改动。已确认保留，不再回退。

### 六、引擎下拉与软键盘（本次发布 v1.5.12）

这两项原本是交接文档里的后续项，调查后发现**第一项的严重性被记错了**。

**引擎下拉不是「体验缺陷」，是功能在特定视口下直接失效。** 上一版把它写成「引擎较多时横屏可能超出视口」。实测（12 个搜索引擎，横屏 844×390）后确认：下拉框高 **442px**，超出视口 **199px**，且基础规则是 `max-height: none` + `overflow: visible` —— **既不能滚动也够不到**。12 个引擎里 **6 个完全选不中**（Startpage、Ecosia、Qwant、搜狗、360 搜索、头条搜索），界面上没有任何提示。「可能」两个字掩盖的是一个静默的功能失效。

修复照抄 `.fav-dropdown` 已有范式，只加在横屏块（`max-height: 500px` 那个）：

```css
.engine-dropdown {
    max-height: min(60dvh, 300px);
    overflow-y: auto;
    overscroll-behavior: contain;
}
```

**基础规则刻意不加 `max-height`**：竖屏实测 442px < 640px 本就不溢出，加了只是无谓的限制。守卫测试同时断言「横屏块必须有上限且能滚动」与「基础规则不得有上限」。

实测复验（12 引擎）：

| 视口 | 下拉高 | 上限 | 完整在视口内 | 需滚动 |
| --- | --- | --- | --- | --- |
| 844×390 | 234.0 | 234px | ✅ | 是（440/232） |
| 390×844 | 442.0 | none | ✅ | 否 |
| 360×640 | 442.0 | none | ✅ | 否 |
| 834×1112 | 442.0 | none | ✅ | 否 |
| 1280×800 | 442.0 | none | ✅ | 否 |

横屏滚到底后实测最后一个引擎「头条搜索」底边 **374 ≤ 390**，12 个全部可达（修复前 6 个不可达）。

**软键盘适配（`visualViewport`）**。`vh` 与 `dvh` 都不跟随软键盘收缩——这是规范事实，不是本项目的疏漏，因此此前所有 `dvh` 写法都无法解决。新增 `bindKeyboardViewport()`（`app.js:829`）：监听 `visualViewport` 的 `resize` 与 `scroll`，用 `requestAnimationFrame` 合并同一帧内的重复事件，把被遮挡高度写进 CSS 变量 `--kb-inset`；再由各处 `calc()` 消费：

- `.ui-dialog` / `.fav-dialog` 的 `max-height` 减去该值
- 两个 overlay 的 `padding-bottom` 加上该值（**与 `env(safe-area-inset-bottom)` 叠加**，否则键盘上方那条手势条又会压住按钮）
- `.search.paste-mode .search-input` 的 `max-height` 改为 `calc(60vh - var(--kb-inset, 0px))`
- 写入变量后调用 `autoGrowPasteInput()` 重算编辑区高度，否则会停在键盘弹出前算出的值上

不支持 `visualViewport` 的浏览器 `--kb-inset` 恒为 0，行为与改动前完全一致。

**已验证的部分**：用 `element.style.setProperty('--kb-inset', ...)` 模拟键盘（headless 无法模拟真实软键盘），实测 `.ui-dialog` 的 `max-height` 由 **742.72px → 442.72px**（恰好 −300px），overlay `padding-bottom` 由 12px → 312px；弹窗 410.5px 完整落在 532px 可用区内，操作按钮可见。键盘更大（450px）时弹窗收矮至 292.7px 并转为内部滚动，不溢出。console 零消息。

**未验证的部分（重要）**：**真机软键盘从未实测。** headless Chrome 不会触发 `visualViewport` 的键盘行为，因此以下三点**都没有答案**：

1. `offsetTop` 在 iOS Safari 与 Android Chrome 上是否语义一致；
2. 键盘弹出时 `window.innerHeight` 是否同步收缩（部分浏览器不收缩，公式会算出 0）；
3. 输入框聚焦后浏览器自动滚动页面是否让 `offsetTop` 变成非零值。

第 3 点尤其可疑：当前实现把 `offsetTop` 算进遮挡高度，**在会自动滚动的浏览器上可能过度收矮弹窗**。上线前需在真机确认，必要时改为只取 `height` 差值。

**测试桩的一个坑（第二次踩到同类问题）**：新加的键盘守卫最初用 `assert.match(source, /visualViewport/)` 匹配整个 `app.js`，但 `bindKeyboardViewport` 上方那句注释里就写着「只有 visualViewport 反映」——**把实现代码删空后测试依然全绿**。已改为先剥掉整行注释与块注释再匹配可执行代码。这与本仓库此前「源码形状断言只匹配可执行代码」的教训相同，区别只在于这次是自己新写的守卫。

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

**已修 1：展开动画整条失效（`styles.css:2707` 覆盖 `:610`）**。`.search` 被声明三次，最后一条整块覆盖了「Paste 分享模式」区块里的 `transition`。实测 `getComputedStyle().transitionProperty` 只剩 `border-color, box-shadow, background`——`min-height` / `padding` / `border-radius` 全部没有参与过渡。`:617-618` 专门写的注释解释了「height:auto 不可过渡，故过渡 min-height」，而这段设计从未运行过。这与改版前修的是**同一类错误**（尾段新版区块覆盖前面），而当时的守卫只覆盖了 `.search.paste-mode` 后代规则，漏了 `.search` 自身。已把 `:2700` 的 transition 补齐，并新增守卫断言：最后生效的 `.search` transition 必须含 `min-height` / `padding` / `border-radius`，且与 composer 区块声明的完全一致。

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

## 模式切换状态错乱（收藏 → 网页 → 分享）

**现象**：先输入 `/` 进收藏模式，再切回网页模式，然后输入 `>` 触发分享——左侧按钮仍显示「网页」、右侧仍显示「搜索」，编辑区却已展开成大编辑器、搜索引擎按钮已消失。回车后行为诡异。

**根因**：`toggleFavSearchMode` 用 `modeBtn.textContent = enabled ? '收藏' : '网页'` 切换按钮文案。`textContent` 赋值是**破坏性**的——它把 `#modeBtn` 里原有的 `<span class="mode-label">` 子节点整个删掉，替换成纯文本节点。此后 `togglePasteMode` 里的 `modeBtn.querySelector('[data-label="web"]')` 返回 `null`，第 `webLabel.hidden = enabled` 一行抛 `TypeError: Cannot set properties of null`，**函数在此中断**，后续所有文案赋值（按钮、placeholder、aria-label）一行都没执行。

而 `form.classList.toggle('paste-mode')` 在异常点**之前**已执行，所以 CSS 生效（编辑区展开、引擎按钮隐藏），`app.pasteMode` 也已被赋值为 `true`。结果就是**样式层已切到分享态、行为与文案层仍停在网页搜索态**——同一个输入框对外呈现两套互相打架的语义。

收藏模式是**单向门**：任意一次 `toggleFavSearchMode` 调用都会永久销毁分享态所需的子节点，此后无论怎么切都恢复不了。两条退出路径（点「网页」按钮、退格删 `/`）结果完全相同。

**根因的第二层**：两个 `toggle*Mode` 用**互不兼容的机制**写同一批 UI——一个用 `textContent`（删子节点），一个用 `hidden`（依赖子节点）。先执行哪个决定了另一个能否工作。这是我在上一轮改版时引入的：为了让按钮文案能随模式切换，我把「网页/退出」拆成两个 span，却没检查既有的 `toggleFavSearchMode` 也在写同一个按钮。

**修法**：

- `index.html` 的 `#modeBtn` 补第三个标签 `<span class="mode-label" data-label="fav">收藏</span>`，三个身份（网页 / 收藏 / 退出）各有其 span。
- 新增 `showModeLabel(mode)`，按 `dataset.label` 切换显隐，`toggleFavSearchMode` 与 `togglePasteMode` 共用。**任何地方都不再写 `modeBtn.textContent`**——它会删掉所有子节点。
- 加源码形状断言 `modeBtn.textContent` 不得出现，以及「收藏→网页→分享」完整往返的行为测试。

**真实 Chrome 复验**（10 步，含两条退出路径）：`labelCount`（`#modeBtn` 内 `.mode-label` 数量）**每一步均为 3**；分享态 = 退出 + 发送，收藏态 = 收藏 + 打开，网页态 = 网页 + 搜索；回车正常弹出分享保护面板；全程零 TypeError（页面内另装 `window.onerror` / `unhandledrejection` / `console.error` 捕获器复跑，`count: 0`）。

顺带确认两条正确行为：收藏态下输入 `>` 不触发分享、分享态下输入 `/` 不切收藏（`handleSearchInput` 中 `isFavMode` 为真时提前 return，模式互斥成立）。

## 实际验证

### 本次（分享弹窗 + 移动端）

- `node --check`：`server.js`、`public/app.js`、`public/sw.js`、`public/lib/qrcode.js`、`public/lib/highlight.min.js`、`tests/dialog-regressions.test.js`、`tests/paste-ttl.test.js`、`tests/share-guards.test.js`、`tests/paste-composer.test.js` 全部通过。
- CSS 花括号配平：`styles.css` 587 对、`admin.css` 179 对，均平衡。
- `node --test tests/*.test.js`：**75 项全部通过**（原 68 项 + 新增 7 项）。
- `git diff --check`：无空白或冲突标记问题。
- 首页首屏回归：`index.html` 的 `src` 仍为 `lib/uFuzzy.iife.min.js`、`lib/pinyin.js`、`lib/qrcode.js`、`app.js` 四项，`grep -c highlight public/index.html` 为 **0**，未引入新脚本。

**红绿验证**（逐项改坏后确认对应测试变红，再恢复）：

| 改坏方式 | 变红的测试 |
| --- | --- |
| `admin.css` 恢复 `align-items: end` | `the dialog stays vertically centred on narrow screens` |
| `.search-input` 恢复 `font-size: 15px` | `the search input font size never drops below the iOS zoom threshold` + `the search row itself stays single-height and not draggable` |
| `.utility-dock` / `.toast` 去掉 `env(safe-area-inset-bottom)` | `the utility dock and toast clear the home indicator` |
| `reveal` 移回 options 之后 | `the PIN field sits directly under its checkbox, not below the expiry options` |

共 5 项变红（含 1 项既有测试）。恢复后 75 项全绿。

**真实浏览器验证**（agent-browser + Chrome，临时副本 + fixture 数据，端口 4123）：

弹窗居中（5 档视口，`gapTop` 与 `gapBottom` 完全相等即居中）：

| 视口 | 弹窗高 | 上留白 | 下留白 | 居中 | 完整在视口内 | 网格列宽 | 每格高 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 390×844 | 331.5 | 256.3 | 256.3 | ✅ | ✅ | 164.5px ×2 | 46 |
| 360×640 | 331.5 | 154.3 | 154.3 | ✅ | ✅ | 149.5px ×2 | 46 |
| 834×1112 | 322.5 | 394.8 | 394.8 | ✅ | ✅ | 173.5px ×2 | 42 |
| 844×390（横屏） | 322.5 | 33.8 | 33.8 | ✅ | ✅ | 173.5px ×2 | 42 |
| 1280×800 | 322.5 | 238.8 | 238.8 | ✅ | ✅ | 173.5px ×2 | 42 |

网格行数实测 `rowCount: 2`，四档依次为 5 分钟 / 30 分钟 / 1 天 / 7 天。

PIN 输入框位置（390×844，勾选后）：复选框底边 **337.3** → PIN 框顶 **345.3** → PIN 框底 412.3 → 有效期组顶 **424.3**。`pinAboveGroup: true`。横屏 844×390 同样成立（142 → 150 → 224.5），且弹窗转为内部滚动（`scrolls: true`）而非溢出视口。取消勾选后 `revealHidden: true`、高度 0、`offsetParent === null`，开合对称。

搜索框（390×844，退出分享态后）：`font-size: 16px`、`line-height: 44px`、容器 56px、输入框 44px、模式/搜索按钮均 44px。

底部固定元素与书签网格（390×844）：dock 底边 832（`bottom: calc(12px + env(...))`）、按钮 44px；toast 宽 195、`max-width: calc(100% - 24px)`、底边 816，均在视口内；书签三列各 116.66px、总宽 366、左右留白各 12px（原先 `max-width: 304px` 造成右侧空白）；`scrollWidth 390 <= 390`，无横向滚动。

管理面板（390×844，用默认密码 `admin123` 进入）：`.modal-content` 全屏 390×844，`.modal-body` 707.3px 且可滚动，操作按钮 44px，`scrollWidth` 未超视口。行宽 345px 全部在视口内。

暗色主题：弹窗背景 `rgba(57, 51, 46, 0.93)`，选项与选中态配色正常，布局与亮色一致。

分享接收页：`GET /p/lucky-805` 返回的 HTML 含 `viewport-fit=cover`；390×844 下 `body` 内边距 14px、容器宽 362px、无横向滚动。（页面显示「解密失败」属预期——验收用的 content 不是真实密文。）

console 全程零消息。未点击「分享」按钮，创建接口限流额度未消耗。

### 历次发布

- `node --check`：`server.js`、`public/app.js`、`public/sw.js`、`public/lib/qrcode.js`、`public/lib/highlight.min.js`、`tests/dialog-regressions.test.js`、`tests/paste-ttl.test.js`、`tests/share-guards.test.js`、`tests/paste-composer.test.js` 全部通过。
- `node --test tests/*.test.js`：68 项全部通过（原 46 项 + 新增 22 项）。

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

## 深色模式管理页下拉框底色 + 进入管理页延迟

核对日期：2026-09-29。**已提交并发布为 v1.5.18**（修复 `d7091a6`、发布 `764106d`），`sw.js` 缓存同步升到 `nav-v26`。

### 问题 1：深色模式下管理页的下拉框看不清文字

用户报「主题模式/管理搜索引擎的下拉选择框背景依然是白色」。

**根因不是收起态的底色，而是展开后的原生列表。** 实测（`--color-scheme dark`）：

| 元素 | 修复前 `background-color` | 修复后 |
| --- | --- | --- |
| `select#themeModeSelect` | `rgba(0, 0, 0, 0)`（只有 `background-image` 渐变） | `rgb(42, 37, 33)` |
| `select option` | `rgba(0, 0, 0, 0)`、`background-image: none` | `rgb(42, 37, 33)` |

收起的下拉框由 `admin.css` 那条 `background: linear-gradient(...)` 撑着，看起来一直是正常的；但**展开后的列表完全由 UA 绘制，只认 `option` 的 `background-color`**，而它此前是全透明，于是回落到 UA 默认的白画布。

**修法**：新增 `--admin-field-canvas`（浅色引用既有 `--control-top`、深色 `#2a2521`，三处主题块各定义一次），给 `select` 补 `background-color`，并新增一条 `:is(.modal, .fav-dialog, .ui-dialog) select option` 同时设定 `background-color` 与 `color`。一处规则覆盖全部三个下拉框（`themeModeSelect` / `defaultEngineSelect` / 收藏弹窗的 `favCategorySelect`）。

**`background` 简写会重置 `background-color`**——这是本次踩到并已用浏览器实测确认的坑：不透明底色必须写在 `background:` **之后**，否则被当场抹成 `transparent` 且不报错。实测两种顺序：简写在后时 `background-color` 读回 `rgba(0, 0, 0, 0)`，简写在前时读回 `rgb(42, 37, 33)`。已加断言钉住这个相对顺序。

**浅色未回归**：实测 `option` 为 `rgb(252, 250, 246)` 配 `rgb(48, 43, 39)` 文字，与修复前一致。

### 问题 2：进入管理页延迟约 130ms

**实测拆解**（临时服务 + 真实 Chrome，1280×577）：

- 修复前 `openAdmin` 5 次：`[123, 131.1, 139.8, 149.6, 120.5]` ms
- 修复后 5 次：`[66.3, 65.4, 80.2, 75.7, 79.2]` ms

**根因是两次串行的 bcrypt。** `openAdmin` 依次 `await` 了 `ensureAdminFavorites()`（`GET /api/favorites`）与 `loadPrivacyMode()`（`GET /api/config`），两者互不依赖，而服务端每个带密码的请求都要跑一次 `bcrypt.compare`。curl 实测单次约 55ms、不带密码约 1ms——**串行即两次 bcrypt 叠加**。渲染本身只占 0.6ms，不是瓶颈。

**修法**：两个请求放进同一个 `Promise.all` 并发发出（`app.js:2200-2206`）。总耗时降到单次校验的量级。

### 顺带查到、并已复核澄清的一件事（我自己先前的判断是错的）

我一度以为 `loadPrivacyMode()` 恒返回 `null`、白付一次 bcrypt，理由是 `defaultConfig` 里没有 `privacyMode` 键。**代码审查的 Spec 轴也独立得出同样结论，并建议直接删掉这个请求。两条线索指向一起，看起来很可信——但实测推翻了它。**

起真实服务验证（`POST /api/config` 写入 `privacyMode: true`，再带密码 `GET`）：

| 状态 | 落盘 `config.json` | 带密码读回 | `loadPrivacyMode()` |
| --- | --- | --- | --- |
| 用户从未动过隐私模式 | 无该键 | `undefined` | `null`（符合预期） |
| 用户已开启隐私模式 | `true` | `true` | `true` |

即：键**在用户第一次保存设置后就会出现**，之后正常往返。`defaultConfig` 里没有它只说明**默认状态**（`migrateConfig` 把它填成 `false`），不是这条链路取不到值。**删掉这个请求会让已开启隐私模式的用户丢失该状态**——正是「无它」与「慢」必须分开判断的那类改动。

`Promise.all` 因此是这里的正确修法：既降到一次 bcrypt 的量级，又不动行为。

### 验证

- `node --test tests/*.test.js` → **111 全通过**（新增 4 条断言）。
- **红绿两轮已验证**，不是只看绿灯。每一次破坏都用 `grep`/断言结果复核确实落到文件里，没有出现「破坏是空操作、断言其实没在测」：
  - 删掉 `select option` 规则与 `background-color` → **2 条失败**（31 pass / 2 fail）。
  - 把 `Promise.all` 改回串行 → `进入管理页的两个请求并发发出` **失败**（32 pass / 1 fail）。
  - 把 `background` 简写与 `background-color` 的顺序对调（即我一度写错的版本）→ `background 简写不会把下拉底色抹掉` **失败**。
  - 从 option 规则里删掉 `.fav-dialog` → `三个下拉框都被同一条 option 规则覆盖` **失败**。
- 真实浏览器（临时目录启动服务；`--color-scheme dark` 与 `light` 各跑一轮）：审查修正后复测 `clickToVisible` 81ms，深色下两个下拉框的 `option` 底色均为 `rgb(42, 37, 33)`、文字 `rgb(243, 238, 232)`；浅色下为 `rgb(252, 250, 246)` 配 `rgb(48, 43, 39)`，与修复前一致。console 零消息。
- `node --check` 覆盖 `app.js` / `sw.js`；`git diff --check` 干净。CSS 无法用 `node --check`，改由浏览器读回计算样式验证（深色 `--admin-field-canvas` = `#2a2521`、浅色 = `#fcfaf6`）。
- `sw.js` 缓存 `nav-v25` → **`nav-v26`**：本次改动的 `admin.css` 与 `app.js` 都在 ASSETS 白名单里，不升老用户继续吃旧资源。

### 代码审查（`git diff v1.5.17`）

两轴各起一个子代理：**Standards**（对照 `AGENTS.md` + `docs/architecture.md` + Fowler 坏味道基线）与 **Spec**（对照用户本轮原话需求）。findings 逐条自行复核后才动手。

**已按 findings 修改**

- **`background` 简写与 `background-color` 的顺序是承重的**（Standards C4 / Spec C4）。`background` 简写会把 `background-color` 重置为 `transparent`。我第一版就写反了（把底色放在简写之前），是 Spec 轴点出来的。**用浏览器实测确认了两种顺序的差别**才改正，并补断言钉住相对位置。
- **token 命名窄于作用域**（Standards A3/Mysterious Name）。原名 `--admin-select-canvas` 却挂在覆盖 `input`/`select`/`textarea` 的共享规则上。改名 `--admin-field-canvas`。
- **浅色值是既有 token 的逐字副本**（Standards / Spec C2）。`#fcfaf6` 与 `styles.css` 的 `--control-top` 完全相同，而本文件既有写法一律是引用。改为 `var(--control-top)`，少一份要同步的色值。
- **两条测试锁死了实现写法**（Spec B2）。`selects.length >= 3` 对源码字符串恒真、且逐字匹配 `:is(...)` 文本，无行为价值。改为断言「恰好三个下拉框」+「规则确实覆盖 `.modal`/`.fav-dialog`/`.ui-dialog` 三处」，并按内容取块而不是硬编码缩进（Standards 指出的脆弱正则）。

**已推翻的 finding（未改代码）**

- **「`loadPrivacyMode()` 恒返回 `null`，是死代码，应直接删掉」**（Spec A1/C1，审查列为最严重，且我的新测试把它固化成契约）—— **不成立，已实测推翻**。`defaultConfig` 没有该键只说明**默认**状态；用户保存设置后键就会写入 `config.json` 并正常往返（见上表）。删掉它会让已开启隐私模式的用户**丢失该状态**。该测试因此保留。
- **「第三个下拉框 `favCategorySelect` 是 scope creep」**（Spec B1）—— 审查自己改判为「合理的完整性」，我也同意：一条 `:is(...)` 规则覆盖三处弹窗几乎零成本，漏掉等于明知故犯留同一个坑。
- **`sw.js` 缓存未升**（Standards 关注项）—— 已核对：本次正确升到 `nav-v26`，`admin.css`/`app.js` 均在 `ASSETS` 白名单内。✅
- **Primitive Obsession 指控 `X-Admin-Password` 逐请求明文校验**（Standards A3）—— 属 `architecture.md` 已文档化的现状，非本次引入，按该轴自己的「仓库文档优先」规则抑制。

**已补 `docs/architecture.md`**：Standards 指出新 token 属于该文件已建档的同类约束（`:51`「三处主题块各定义一次」）。已把三件事写进架构文档：`--admin-field-canvas` 的三处定义规矩、`background` 简写与 `background-color` 的顺序约束、以及 `openAdmin()` 必须并发且 `loadPrivacyMode()` 不可删的理由（附实测依据）。

### 仍未验证 / 待办

1. **展开后的原生下拉列表没有真机截图。** headless Chrome 抓不到 UA 弹层（`el.click()` 后截图只得到背景虚化）。已验证的是应用层能控制的全部：规则解析通过、声明读回为深色、`option` 匹配到真实元素。**请在真机上点开一次下拉框确认。**
2. ~~服务端每次带密码请求都跑一次 `bcrypt.compare` 本身没动。~~ **已在本次会话改造中解决**：会话 Cookie 命中时不再跑 bcrypt，只在登录与兜底密码路径上跑一次。本条仅在仍用明文密码的旧页面上成立。
3. 旧 WebKit 的 `mask-composite: exclude` 细线降级为无边框玻璃面板，功能无影响（旧有结论，未复测）。

## 已排除的误判

- **「搜索态下 textarea 高度锁死 36px，多行内容进内部滚动条，属功能退化」** —— 审计提出，经核实不成立。`autoGrowPasteInput()` 有 `if (!this.pasteMode || this.pasteUserResized) return;` 守卫，搜索态根本不写 inline height，交给 CSS 的 `min-height: 36px`。这是刻意设计：搜索框本就该单行，`textarea` 只是分享态的载体。审计建议「进入分享态时补一次调用」，照做反而会让搜索框在长文本时突然变高。
- **「`this.exitPasteMode()` 应在两处之外还有第三处调用」** —— 排查后确认 `pasteMode = false` 在 `handleSearchInput`（切到收藏检索）与 `createPaste` 成功（展示结果）时也会出现，这两处是各自独立的正确逻辑，不是重复。
- **「`trust proxy` 用跳数 1 即可防住 XFF 伪造」** —— 原注释与文档都这么写，实测不成立。跳数 1 取最右一跳，而最右恰是客户端能自己写的那一跳，追加即可无限换桶。正确结论是「前提为端口不对外暴露」，与取值无关。已改写 `server.js:193-199` 注释与 `docs/architecture.md:37-39`。

## 未完成与后续

1. 二维码未做真机扫码实测。已确认 data URL 生成正确、尺寸正常，但「实际能否被手机相机扫出」需要真机验证。
2. **分享编辑器的移动端手感未实测**。`Shift+Enter` 在 iOS/Android 软键盘上行为不一致（部分键盘不提供稳定的 Shift 键），真机上可能无法换行；届时需考虑加一个显式「换行」按钮。窄屏（≤480px、≤370px）下的编辑框与结果面板布局、拖拽把手在触屏上的可用性也都未在真机验证。
3. **分享结果面板与编辑框的同宽对齐已在浏览器中确认**。实测面板与容器的 `leftDiff` / `rightDiff` / `widthDiff` 均为 0，上间距 14px 与 `margin-top` 一致，内部排布（分享码 30px → 二维码 160px → 复制按钮 36px → 过期提示 16.5px）垂直节奏递减合理。二维码仍未做真机扫码验证。
4. **动画观感未做主观评估**。展开与收回的过渡已修复（原被 `styles.css:2707` 覆盖而完全失效），但时长与曲线是否自然未在浏览器中看过。`height: auto` 本身不可过渡是 CSS 限制，因此编辑框的增高是硬切，只有容器 padding/圆角/底色的过渡会生效。
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

### 本次明确不在范围内（移动端）

19. **`styles.css` 与 `admin.css` 对同一批选择器重复声明且结论冲突**。`admin.css` 加载在 `styles.css` 之后，同特异性时它胜出：`.modal-content` 的宽度/圆角/最大高度在两个文件里各写一遍（`styles.css:347` vs `admin.css:52`）；`.category-tree-children` 在 `styles.css:2483`（≤768px 块内）是 `display: none`，`admin.css:383` 是 `display: contents`，实际生效的是后者（树在移动端并未被压平，与 styles.css 的意图相反）。本次未收敛，改任一处都可能失效。
20. **管理面板的拖拽排序在移动端被禁用**（`styles.css` ≤768px 的 `.fav-drag-handle { display: none }`），现状保留；平板竖屏下也没有替代的排序方式。
21. **`/p/:code` 分享页只有一个 `max-width: 480px` 断点**，横屏、平板与折叠屏展开态未逐一验证；本次只补了 `viewport-fit=cover` 与安全区内边距。
22. **首屏体积未重新测量**。本次未增删任何脚本，但 `100dvh` 与触摸目标调整会影响移动端重排成本；国内网络下的首屏耗时仍需真机复测。

## 已排除的误判（本次移动端审计）

- **「分享弹窗没有 CSS 定位，所以掉到页面最底部」** —— 不成立。`.ui-dialog-overlay` 在 `admin.css:290` 一直有 `position: fixed; inset: 0; display: grid; place-items: center`，桌面端表现正常。真因是 `admin.css:401` 的 ≤480px 规则写了 `align-items: end` 覆盖成底部抽屉。**不要**去 `styles.css` 里补一份 `.ui-dialog` 定位，那会变成第三处声明。
- **「`styles.css:2896` 的 `repeat(auto-fill, 96px)` 是死代码」** —— 成立但成因不是"漏写"：它与 2787 行的三列规则同在 ≤480px、同特异性，后者在文件更靠后，因此前者被覆盖。已把 2787 的 `max-width: 304px` 改为 `100%`，两行现在语义一致。
- **「placeholder 偏上是 `padding` 造成的」** —— 部分成立但不是主因。主因是 `styles.css:2772` 在文件末尾的 `font-size: 15px` 覆盖了移动端 16px（会触发 iOS 缩放），次因是 `line-height: 20px` 在 36px 容器内基线偏上。已两者一并修正。
- **「引擎下拉在横屏下可能超出视口」** —— 记录严重性被低估。实测 12 个引擎时横屏 844×390 下超出视口 199px，且 `max-height: none` + `overflow: visible` 无法滚动，**6 个引擎完全选不中**。已修（v1.5.12）。教训：写「可能」之前先量一次。

## 发布流程漏了两步（已补齐）

**现象**：服务器执行 `./sylph.sh update` 提示「已是最新版本」，而仓库已是 1.5.12。

**根因不是 tag，是 GitHub Release。** `sylph.sh:335` 的 `get_latest_release()` 请求 `${GITHUB_RELEASES}/latest`，从 JSON 里取 `tag_name` 与 `.tar.gz` 的 `browser_download_url`；`sylph.sh:740` 拿它和**服务器上的** `version.json`（`sylph.sh:728`）比较。两者都停在 1.5.9 —— 服务器旧版本与缺失的 Release 互相掩盖，看起来像"已经是最新"。

git tag 与 GitHub Release 是两套东西：推 tag 不产生 Release。当时 `gh release list` 最新仍是 v1.5.9，`/releases/latest` 也就仍返回 v1.5.9。

**本次连续三轮发布（v1.5.10 / v1.5.11 / v1.5.12）都只做了「提交 + 推分支」，既没打 tag 也没建 Release。** 仓库本来就有 `scripts/release.sh` 一次做完打包、打 tag、建 Release 三件事，一次都没跑过；而 `AGENTS.md` 当时也没写这条。

**已做**：

1. 补推 v1.5.10 / v1.5.11 / v1.5.12 三个 tag；
2. 用 `scripts/release.sh` 补建三个 GitHub Release 并上传 `.tar.gz`；
3. 修 `scripts/release.sh` 使其可重跑：tag 已存在时先校验它是否指向 HEAD（不一致就停，否则 Release 会挂在错误的提交上），Release 已存在时给出明确的删除命令而不是让 `gh` 报一句看不懂的错。顺带修掉新代码在顶层脚本里用 `local` 的问题（`set -e` 下会直接退出）；
4. 重写 `AGENTS.md` 第 6 条：**发布一律跑 `scripts/release.sh`**，并写明 `sylph.sh` 查的是 Release 而非 tag。

**补发后的核验**：`/releases/latest` 返回 `v1.5.12`，附件 `nav-sylph-v1.5.12.tar.gz`；下载该压缩包确认内含 `version.json` 为 1.5.12，且含本次的 `visualViewport`、引擎下拉上限与搜索框 16px 三处修复（打包的是各版本真实代码，非最新版）。

**校验方法**（发布后跑）：

```bash
# 远端最新 Release 与附件
gh release list --limit 3
curl -s https://api.github.com/repos/mh567/nav-sylph/releases/latest \
  | grep -o '"tag_name"[^,]*'

# 本地 release 提交是否都有 tag
for c in $(git log --format=%H --grep="^release: v" -6); do
  printf "%s  %s\n" "$(git log -1 --format=%h:%s $c | cut -c1-46)" "$(git tag --points-at $c | head -1)"
done
```

**教训**：这个仓库有自动化发布脚本，且用户的 `update` 入口依赖 GitHub Release 而非 tag。以后发布不要手写 `git` / `gh` —— 直接 `bash scripts/release.sh`。

## 本次完成的内容（保持登录：会话 Cookie + 可信设备）

**状态：已发布 v1.5.19。** 保持登录实现提交为 `e29a842`（父提交 `b809d21` / v1.5.18），
安全修复为 `caaed31`，`sw.js` 缓存已升到 `nav-v27`。

### 改了什么

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 会话与指纹 | `lib/session.js`（新增） | 32 字节 CSPRNG 令牌、HttpOnly Cookie、七字段加权指纹、地理绑定、Cookie 读写 |
| 地理库 | `lib/geo/`（新增） | vendored ip2region IPv4 库（11,122,036 字节）+ 只读解析器 + 上游许可证 |
| 统一守卫 | `server.js` | 11 处手写 `verifyPassword` 守卫改为 `requireAdmin` 中间件；两处软门同步接入 |
| 新端点 | `server.js` | `GET /api/session`、`POST /api/logout`、`POST /api/trust-device`；登录成功即签发 Cookie |
| 配置项 | `server-config/defaults.js` | `sessionCookieName`、`sessionTtl*`、`cookieSecure`、`geoEnabled`、`geoDatabase`、`geoScope` |
| 客户端 | `public/app.js` | `this.password` → `this.authenticated`；明文密码不再进任何浏览器存储 |

`X-Admin-Password` 保留为兜底通道（旧页面仍可用），**没有**关闭明文密码通道本身。

### 实施中发现并修掉的问题

1. **xdb 格式与我在计划里写的不同。** 计划按「大端、指针为相对索引」写的探针全部返回 null。实际格式（对照上游 `binding/golang/xdb`）是**小端**、向量索引项为**绝对文件偏移**、段内 IP 需**反转后**比较。探针失败促成了去读权威实现，否则会静默返回错误地区。
2. **绝对分阈值会让 Firefox/Safari 永久拿不到 30 天。** 计划写的是「总分 14、阈值 10」+「缺失不扣分」。但 Firefox 完全不实现 Client Hints，可比信号只剩 UA(2)+语言(1)=3 分，**无论是否同一台设备都达不到 10**。「缺失不扣分」只避免了扣分，没解决基准本身偏高。改为**一致比例**阈值 0.7 后，这类浏览器一致率为 1.0。
3. **清除 Cookie 时没沿用下发属性。** 原实现只发 `Max-Age=0`，缺 `HttpOnly`/`SameSite`/`Path`，浏览器会当成另一个 Cookie 留着。已补齐并加测试。
4. **同名 `Set-Cookie` 会下发两条。** 滑动续期写一条、信任设备再写一条，令牌的当前有效期需要靠猜。已改为同名替换，保留最后一条。
5. **`sessionStore` 的 TDZ 风险。** `setInterval` 回调引用了在其之后才声明的 `const`。`node --check` 通过，但回调首次触发时会在 TDZ 内抛错。回调在 60 秒后才执行，届时模块顶层已初始化，故当前安全——依赖的是调用时机而非代码顺序，值得记住。

### 代码审查发现（提交前双轴审查，已全部修掉）

按仓库约定在**提交前**跑双轴审查（Standards 对 `AGENTS.md` + `docs/architecture.md`，
Spec 对已批准的计划 + 用户原话），发现的问题已逐条复核并修复：

1. **`isHttps()` 缺参导致登录接口崩溃（最严重，155 条单测全绿也没抓到）。**
   `setSessionCookie` 调 `this.isHttps()` 时没传 `req`，`cookieSecure` 为默认值 `true` 时
   直接抛 `TypeError: Cannot read properties of undefined (reading 'headers')`，
   进程退出。此前 e2e 一直设 `COOKIE_SECURE=false`，`&&` 短路让这条路径从未被执行；
   单元测试的 `makeStore` 默认也是 `cookieSecure:false`，同样没覆盖。
   **是真实服务器以默认配置启动才暴露的**——`issueSession` / `refreshSessionCookie` /
   `clearSessionCookie` 三个入口同样缺参。已全部补上 `req` 参数并加了两条
   真正会调用 `isHttps` 的回归测试（红/绿确认：还原后 2 条变红）。
2. **README 的 http 部署警告是错的。** 原写「纯 http 部署必须设 `COOKIE_SECURE=false`」，
   但 `secure: cookieSecure && isHttps(req)` 已在 http 时自动省略 `Secure`，
   根本不需要手工配置。已改为说明自动判断 + 该项仅用于覆盖判断。
3. **架构文档的「总分 14 / 阈值 10」是虚构的分母。** 实际算法是「一致权重 / 可比权重」，
   权重只用于排序。已改写并说明「缺失即跳过」与「基准不能偏高」必须一起改。
4. **DEPLOYMENT.md 未按计划要求更新**（计划明写「必须写进 README / DEPLOYMENT」）。已补，
   含登录后始终未登录时的排查命令。
5. **ip2region 数据来源出处未记录**（计划要求）。已查上游 README 补记：
   快照式数据、非实时更新、来源为社区数据与 Issue 补充。
6. **地理测试没测到它声称的东西。** 「同省不同市」用的是 南京→上海（跨省），
   两种粒度下都会判为变化，等于没验证 city 粒度。已改用真实同省不同市 IP
   （深圳 `106.11.1.1` → 汕头 `221.5.1.1`），并同时断言 province 粒度下不误报。
7. **`trust-device` 的 `requiresLogin` 分支被客户端忽略**，旧页面勾选「信任此设备」会
   静默只拿到 24 小时。已改为显式提示。
8. 另修：`envChanged` 死字段、`expires` 死参数、`照常` 错字、
   `architecture.md` 里失效的 `app.js:314` 引用（会话改动后该行已指向别处）、
   `{ token, ...session }` 四处重复拼装收敛为 `refreshSessionCookie`、
   源码形状守卫补上「修复前是什么样」的注释。

**两条审查结论经复核后判定为不成立，未改**：
- 「错误态 toast 没有样式」——`.toast[data-state="error"]` 存在于 `admin.css:334`，
  且 `admin.css` 确实被 `index.html` 加载，`--admin-error` 也在该文件定义。
- 「新增的 safe-area 断言与 `dialog-regressions.test.js` 重复」——那个文件的
  safe-area 断言针对收藏弹窗与工具条，没有一条针对 `.toast` 本身。

### 第二轮审查（对抗性安全 + 状态机角度，发布前）

第一轮修完后又审了一轮，换角度（不问「是否符合规范」，只问「能不能被打挂、
能不能被接管」），结果比第一轮严重。已全部修掉，提交为 `caaed31`。

**一处崩溃（162 条单测全绿都没抓到）**：`readCookie` 直接调 `decodeURIComponent`，
畸形百分号编码（`Cookie: nav_session=%`）抛 URIError；调用栈全在 async 处理函数里，
Express 4 不捕获 async 异常 → `unhandledRejection` → **进程退出**。
**未认证请求即可打挂服务。**

> **这与上一轮修的 `isHttps` 缺参是同一类缺陷**：两次都因为**默认值让危险分支
> 在测试里不可达**而漏掉（前者是 `cookieSecure:false` 使 `&&` 短路，
> 后者是 e2e 一直设 `COOKIE_SECURE=false`）。**教训：验证某个分支时，
> 必须让默认值生效，不能靠测试夹具把分支绕过去。**

**七处可被利用的缺口**（均经实测确认，非照抄审查结论）：
改密码不验证当前密码（拿到会话即可完成接管）；改密码后全部会话仍有效（补救动作失效）；
`env_changed` 到不了客户端（私密检索对着残缺数据报「无匹配」且不自愈）；
`envChangeNotified` 重新登录后不复位（第二次登出无任何提示）；
`Clear-Site-Data` 可被跨站请求触发清空整站 Cookie；会话数无上限；
两条软门无限流（伪造密码头放大约 9 倍 CPU）。

**两条判定不成立**：「401 可区分会话是否存在」——伪造 token 与真实 token 响应体完全相同；
「私有检索退化」——该行为由第一轮的 rAF 延后引入，不是本轮问题。

### 过程中我自己的失误

1. **调试 e2e 时用 `tar` 往目标目录解包，造成 2.4 GB 递归目录并波及项目目录内。**
   已清理干净、项目完好。教训：解包目标必须在**源目录之外**，且别用会自我递归的
   `tar -cf - . | (cd 子目录 && tar xf -)` 写法。
2. **e2e 脚本反复误判成代码有 bug**。真实原因是脚本每次请求换 IP——而换 IP 就是换地理，
   会正确地触发自动登出，**我的测试在测一个不存在的场景**。花了不少时间才定位。
3. 提交信息先写成「三处缺口」，实际修了七处，已 amend 改正。
4. 上一轮：todo 面板做完后未更新；核验时用 `grep COOKIE_SECURE` 查 DEPLOYMENT.md 误报「缺」
   （文档写的是配置键名 `security.cookieSecure`）；文档引用了尚未发布的版本号 v1.5.19。

### 验证记录

```bash
node --test tests/session.test.js   # 51 passed / 0 failed
node --test tests/*.test.js         # 162 passed / 0 failed（原有 111 条无回归）
node --check <每个改动的 .js>       # 全部 OK
```

- **红/绿验证 12/12 全部变红**（第二轮），每条破坏都校验了前后源码确实不同。
  其中「重新登录复位」「`unhandledRejection` 兜底」两条最初写成无效断言
  （破坏后仍全绿），补强后确认可变红。
- **真实 HTTP 端到端 20/20**：改密码必须验证当前密码（只带会话 → 401，
  攻击者的新密码无效、原密码不变）→ 带正确当前密码 → 200 + `reauth:true`
  → 旧会话失效、旧密码失效、新密码可用 → 三种畸形 Cookie 后进程存活 →
  `env_changed` 在 `/api/session`、`/api/favorites`、`/api/config` 三处
  都透出 → 会话复用/信任设备/换系统自动登出/登出/不再发 `Clear-Site-Data`/
  旧 Cookie 失效/明文兜底可用/无凭据 401。
- **地理解析实测**：`114.114.114.114→江苏省`、`223.5.5.5→浙江省`、`58.32.11.42→上海市`、
  `8.8.8.8→California`；私网/IPv6/非法 IP 返回 `null`；5000 次查询 < 250ms。
- **`.env` 覆盖实测**：`COOKIE_SECURE=false` 与 `GEO_SCOPE=city` 均能被读到。
  注意 `COOKIE_SECURE` 只是允许在 https 下加 `Secure` 的开关，
  http 部署本来就会自动省略它——**不需要靠这个变量来让 http 部署可用**。
- **验收命令实测**：`grep -c 'requireAdmin' server.js` = **14**（1 处定义 + 13 处路由使用：11 个特权路由 + `change-password` + `trust-device`）。计划里写的 13 是漏算了 `trust-device`。
- `git diff --check` 无空白问题；改动文件全部 `node --check` 通过；临时目录与端口 4123 已清理，`git status` 无残留产物。

### 未验证 / 需真机确认

原先这里笼统列了 4 条「需真机」，其中 3 条其实本地就能定论。已复核并改写：

**已本地核实（不再是未验证项）**
- **首屏多一次 `/api/session` 往返**：本地实测 1.4ms（5 次取样，去掉首次 JIT 后的
  0.9–1.4ms），与首屏本就有的 `/api/config`（0.9–2.1ms）同量级；且它挂在
  `requestAnimationFrame` 内（`app.js:560`），不阻塞渲染。
- **`Accept-CH` 不拖累首页**：实测只在会话相关响应出现——`/api/session` 有该头，
  `/api/config` 与首页静态资源均无。
- **私密检索的首屏窗口**：已修（检索分支等 `sessionProbe`），`app.js:1250/1251/1759` 三处可查（1224 处赋值）。

**确实需要真机/真实环境（本地无法定论）**
- **Firefox / Safari 的实际登录体验**：逻辑上已保证它们能拿 30 天（无 Client Hints 时
  一致率为 1.0，单元测试覆盖），但真机上是否照此表现未跑过。
- **真实浏览器的 Client Hints 协商**：`curl` 是手工构造的头，真机上高熵头是否按预期
  补齐未验证。首个会话请求必然缺高熵头（浏览器需在收到 `Accept-CH` 后的**下一次**
  请求才发送），此刻绑定较弱——这是**已知的、机制上不可避免**的缺口，不是 bug。
  （本机无 playwright/puppeteer，headless 也用不上：UA Client Hints 由浏览器内核
  在真实网络栈上协商，构造不出可靠的高熵头。）
- **真实移动网络下的跨省漫游误报率**：省级判据对「同省不同市」已被本地实测证明
  不误报（`106.11.1.1` 深圳 ↔ `221.5.1.1` 汕头、`202.96.128.86` 广州 ↔
  `14.215.1.1` 湛江均判为同省）；但「运营商 IP 段在漫游时归属是否稳定」需要真实
  流量观察，本地造不出这个环境。

> 判据：能在本地跑出数值的就不写进「未验证」——把该做的验证推给真机，
> 既掩盖了问题，也让这份清单失去筛选作用。

### 追加：窄屏管理面板布局（v1.5.24）

**用 390×844 真实视口逐项测量后修，不是靠读代码推断。**

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 管理面板顶部 | 118.5px | 64px |
| 收藏按钮 | 横排，每个 52px 宽 | 2×2 网格，169×44 |
| 收藏管理器头部 | 102px | 64px |
| 分类侧栏 | 176px 竖排限高 | 83px 横排可横向滚动 |
| 列表条目 | 134px | 62px |

顺带修掉一个视觉问题：条目里的分类标签原本 `flex:1 0 100%` 横贯整行，看着像个输入框。

**根因值得记：改错了文件。** 第一版写在 `styles.css` 的 `≤480px` 块里，**完全没生效**——
`admin.css` 在 `index.html` 里排在 `styles.css` 之后，且用的是 `.modal .fav-actions`
这类更高特异性的选择器，同特异性下后者胜。这是本仓库记录过多次的
「后写的声明静默覆盖」陷阱，本次又踩了一次。**发现方式是量数值**（头部仍是 118.5px），
不是看代码——代码看起来完全合理。

**测量本身也踩了坑**：service worker 缓存了旧 CSS，页面试了三轮都不对。
需 `getRegistrations()` → `unregister()` + `caches.delete()` 全部 key 才看到真实效果。
另外改完 CSS 必须把文件同步到测试服务目录并重启，否则服务器仍在发旧副本。

**验证**：197 条测试全绿（新增 5 条布局守卫）；红/绿 10/10 全部变红；
五个视口（360/390/430/768/1280）逐一确认标题与按钮无重叠、
≤480px 生效而 >480px 保持原样；截图确认视觉效果。

**已知遗留（本次未动，不在范围内）**
- 收藏管理器的「删除选中」在未选中时仍显示为空的禁用按钮——既有缺陷。
- 收藏管理器仍是弹窗套弹窗。改成标签页属于结构调整，建议单独一轮。

### 追加：修复「从备份恢复」点开就报错（v1.5.23）

**报错原文**：`获取列表失败: Failed to execute 'json' on 'Response': body stream already read`

**根因是客户端代码，与 WebDAV 服务端无关。** 浏览器里 `Response.body` 是**一次性流**，
读过一次就不能再读。而 `API.request` 内部无条件 `await res.json()`，
`showWebDAVRestoreDialog` 拿到 `res` 后又调了一次 `res.json()` ——
于是恢复功能 **100% 必然失败**，与配了什么 WebDAV 无关。

顺带查出**导出收藏也坏了**，只是症状不同：它成功后要用 `res.blob()`，
而 body 已被 `request` 读走，导出的内容会是空的（不报错，所以更隐蔽）。

修法不是逐处打补丁，而是从根上明确职责：
- `API.request(url, options, binary)` 增加 binary 模式，**完全不碰 body**，
  把流留给需要 blob/arrayBuffer 的调用方；
- 恢复对话框直接用 `request` 已解析好的 `data`；
- `data?.error` 而非 `data.error`——网关返回 HTML 错误页时 `data` 为 `null`，
  直接取属性会二次抛错，把真实错误盖掉；
- 加一条**全库扫描**断言，禁掉「解构 res 后再 res.json()」这种写法。

**我在这里走了一段弯路，得说清楚**：一开始我用自建的 WebDAV 测试服务端，
复现出 `Cannot read properties of undefined (reading 'getlastmodified')`，
差点当成项目 bug 去改服务端。查下来是**我的测试桩不达标**（WebDAV 的属性
必须包在 `<propstat><prop>` 里，href 也要带远程根前缀）。
修正测试桩后，备份→列出→恢复全流程一次跑通，证明服务端本来就是好的。
**如果当时照着那个假象去改服务端，就会把一个前端 bug 修成别的问题。**
是用户提供的确切报错把方向掰回来的——这正是不该靠猜的证据。

**验证**：192 条测试全绿（新增 4 条）；红/绿 5/5 全部变红；
用 Node 的 `Response` 实测确认「二次读取必崩」与「修复后正常」。

### 追加：修复「远程备份一直加载」（v1.5.22）

**状态：已修复，发布为 v1.5.22。**

**根因是静默失败，不是限流本身。** `loadWebDAVConfig()` 此前只在 `res.ok` 时渲染，
任何非 200（限流 429、会话失效、网络错误）都不做任何事——容器里那句 `加载中...`
会**永远留着**，且没有任何提示。实测复现：耗尽 `ip:auth` 桶后
`/api/webdav/config` 返回 429，页面表现就是「一直在加载」。

三处修改：
1. **失败必须显式渲染**：`!res.ok` 与 `catch` 两条路径都调 `renderWebDAVError`，
   把服务端返回的原因（经 `esc` 转义）显示在区块内，并给一个「重试」按钮。
2. **改为首次展开时才拉取**：原先在 `renderAdminPanel` 末尾预取，而该函数在
   保存配置、增删分类等每次重渲染时都会跑，等于每次都多打一次请求，
   累积起来撞上限流——这是「为什么会触发 429」的来源。
3. **登出时清空 `webdavConfig`**：否则换个会话再进管理面板时，
   `toggleSection` 会因「已加载过」而跳过请求，直接显示上一个会话的内容。

**教训**：这是本次会话里第三次出现「测试全绿但功能是坏的」，
共同点是**失败路径没有断言**。前两次是崩溃（默认值让危险分支不可达），
这次是静默失败（只测了成功路径）。**只断言成功路径的测试，等于没测失败路径。**

同时把那条写歪的守卫也修好了：它从 `catch` 一直切到函数末尾，
而 `catch` 后面紧跟 `renderWebDAVError` 的定义（含同名调用），
于是删掉 catch 里那一行仍然匹配——**断言形同虚设却一直显示为绿**。

**验证**：188 条测试全绿（新增 4 条）；红/绿 7/7 全部变红；
实测耗尽限流桶后服务端确实返回 429，前端走错误分支。

### 追加：登录防爆破（失败锁定 + 总量封顶）

**状态：已发布 v1.5.21。** 基线 v1.5.20（`44fb9e2`）。

管理端没有账户体系、只有一个密码，所以没有「锁账号、输密码解锁」这条路。
按设备维护黑名单也不成立：攻击者换 IP 的成本远低于维护黑名单的成本。
最终方案是三层，各管一件事——`rateLimit`（每 IP 30/分钟，历史值）、
`loginGuard`（同 IP 连错 10 次锁 30 分钟，锁定期内不跑 bcrypt）、
`globalLoginLimit`（全站 30/分钟，不按 IP）。

**实施中由 e2e 抓出的设计错误**（计划里写错了，不是实现走偏）：
两层阈值原本都设 10，且总量层排在锁定层之后。结果总量桶先触发——连错 10 次拿不到
「已锁定」，第 11 次只得到「稍后再试」，**锁定功能形同虚设**；更糟的是
「换一个 IP 登录」也被总量桶挡下，那正是全局桶唯一的代价，却让正常用户先吃到。
已改为总量阈值 30、锁定层在前，并补两条断言把这条约束钉住
（顺序比较 + 阈值必须 `>= 2 倍`）。**单测全绿时这个错误是活的，是真实服务器跑出来的。**

另修两个顺带发现：失败计数改为由密码校验结果回写（此前按请求计，一次成功登录也占配额，
而真正的爆破只打这一个接口）；`/api/session` 从 `rateLimit` 改到 `publicReadLimit`
（它每次首屏都调，原先会挤占登录配额）。

**实测**：连错 10 次 → 第 11 次 429 + `code:'locked'` + `retryAfter:1800`；
锁定期内持续被拒；换 IP 正常登录（不误伤）；30 分钟后自动解锁且记录被清；
总量桶 35 个 IP 各打一次 → 第 31 次 429 + `code:'global_limited'`；
成功登录后计数清零。

**已知局限（如实记录）**：① 攻击者打满总量桶时你也会被挡一分钟，这是封顶总量的
必然代价，纯应用层无法消除；② 重启服务会清空锁定状态；③ 同一 NAT 下的其他设备
会被连带锁——个人自用场景下这反而有利，被锁的正是那个出口。

**验证**：184 条测试全绿（新增 17 条）；红/绿 12/12 全部变红；端到端 8/8 + 总量桶单测。

### 追加：管理面板内可再次设置「信任此设备」

已发布 v1.5.20（提交 `10f054a`，`sw.js` 缓存升到 `nav-v28`）。

原先只能在登录对话框里勾选，进了管理面板就没法再改。现按「双向开关」实现：
开启=30 天免重复登录，关闭=降回 24 小时。**取消信任不登出**，用户当前仍处于登录态。

- 服务端 `SessionStore.setTrusted(token, trusted)` 取代单向的 `markTrusted`。
  **取消信任时立即重算 `expiresAt`**，不等下次访问——否则用户以为已经降级、
  实际还能用到 30 天。`markTrusted` 保留为 `setTrusted(true)` 的等价入口。
- `POST /api/trust-device` 接受 `body.trusted`（缺省 `true` 兼容旧客户端）。
- 管理面板新增「登录安全」区块与开关，开关初值取自 `/api/session` 的真实 `trusted`。
  三个实现要点：请求期间锁住开关（连点会发出互相矛盾的两次请求）；
  **服务端没接受时把开关拨回真实状态**（`checked` 是用户意图，不等于服务端状态）；
  登录/登出时同步 `sessionTrusted`，否则换会话后面板仍显示上一段的「已信任」。
- 开关旁的说明文字写明「关闭后当前会话仍有效」，避免被误解成退出登录。

**实测**（真实服务器）：开启 → `trusted:true`、`Max-Age=2592000`；关闭 →
`trusted:false`、`Max-Age=86400`；关闭后 `/api/session` 仍返回 `authenticated:true`；
不带 `trusted` 字段 → 仍为 `true`（旧客户端兼容）。

### 用户已拍板（2026-09-29）

- **接受发布包增大 10.6 MiB**（gzip 后约 4–5 MB）。仅安装包体积受影响，首页首屏零影响
  （该文件不经 HTTP 下发、不进 service worker `ASSETS`）。保留地理判据；
  若日后要退回，`security.geoEnabled=false` 即可完全关闭。
- **`COOKIE_SECURE` 无需配置**：审查发现 http 部署本来就会自动省略 `Secure`，
  原先以为需要手工设置的判断是错的，已改正文档。该项保留为覆盖自动判断的开关。

### 收藏批量隐私（已提交 `8e487db`，发布 v1.5.25）

**目标**：收藏管理里多选后，能一次性修改隐私状态。

**做了什么**

- 批量条新增「隐私」按钮（`public/app.js:4549`），点开复用现有 `showUiDialog`，
  单选「设为私密 / 设为公开」。混选时默认预选「设为私密」——批量收紧可见性比放宽安全；
  全部已私密才预选「设为公开」。
- 新增 `privacySelectedFavorites()`（`public/app.js:4920`）。保存失败时按快照整体回滚
  （`Object.assign(f, previous[i])`），与同文件 `editFavorite` 的回滚方式一致。
- 列表项复用首页既有的 `.fav-private-label` 显示「私密」，**不新建类名**。
- 窄屏 order 写在 `public/admin.css` 的 `.modal` 作用域内（`admin.css:477`），
  与既有 `.fav-manager-category { order: 3 }` 同行。

**两个方向的提示不对称**：「设为私密」只是收紧可见性；「设为公开」等于对未登录访客
披露（服务端 `toPublicFavorites` 会把 `private` 条目放进公开集合）。因此只在「设为公开」
上挂了 `hint`，不新增弹窗——用户选定的形态就是单层弹窗。
注意：单个编辑弹窗 `editFavorite` 改 private 仍无任何提示，是**既存缺口**，未在本次修。

**已验证**（真实服务器 + 无头 Chrome 390×844，非仅单测）

- 选中 2 项 → 按钮启用、全选框半选；未选中时两个按钮都禁用
- 混选预选「设为私密」、全私密预选「设为公开」——两条都实测
- 改完后 DOM 与服务端 `favorites.json` 逐项一致，未选中项未被误改
- 窄屏弹窗上下间距均 289px（严格居中），选项 334×44px
- 回归 207 条全绿；新测试 10 项，每项都做过「破坏 → 转红 → 还原」验证
- service worker 缓存 `nav-v32 → nav-v33`（本次改了 `public/` 资产，**发版阻断项**）

**审查中发现并已修的三处**

1. **违背了用户选定的形态**（Spec 轴 P0）。用户选的是「复用 `.fav-private-label`、
   在分类标签旁显示」，我第一版却新建了 `.fav-manager-private` 并把标签塞进
   `.fav-manager-info` 里。且我给的理由（「窄屏 info 占满整行 `flex:1 1 100%`」）
   在 ≤480px 下**不成立**——`admin.css:458` 的 `.modal .fav-manager-info`
   特异性更高、加载更晚，把它改成了 `1 1 auto`，而 390px 正是落在这个区间。
   真实生效的是 `admin.css` 那套 order，不是 `styles.css` 里的。
2. **回滚快照不完整**（Standards 轴 P1）。只快照了 `private`，但同时推进了 `updatedAt`，
   保存失败后时间戳会停在一次失败的操作上。已改为整体快照 + `Object.assign` 还原。
3. **测试有两处恒真断言**。`favs()` fixture 没有 `updatedAt` 字段，
   `assert.ok(f.updatedAt > 0)` 恒假、且回滚路径完全没校验时间戳。
   fixture 已补初值，回滚测试新增 `updatedAt` 断言。另补了 onclick 接线断言——
   之前删掉那行，10 条测试仍全绿。

**已知取舍与未做的事**

- **私密项行高高于非私密项**（实测 62px vs 80px），列表会略参差。这是标签独占一行的代价；
  已选择保留，因为隐藏状态比行高一致更重要。
- **「全选」只选当前页**（`pageSize = 50`）。这与既有批量删除**完全一致**，
  非本次引入。但收藏数 >50 时无法一次「全部设为私密」，而隐私清查正是跨页场景的典型用法。
  是否要跨页全选属于「选中模型」的既有边界，需用户定。
- **保存期间未锁按钮**（Standards 轴 P1）。连点会发出两次相同方向的写——幂等、不损坏数据，
  但会有重复 toast。可接受与否取决于取向，未修。
- 窄屏批量条在 <356px 视口可能换行（`<=768px` 下 `.fav-batch-bar` 是 `flex-wrap: wrap`）。
  仅按 CSS 手算，未在 320/375px 实测。
- 无头 Chrome `maxTouchPoints: 0`，无法验证 coarse pointer 相关的触摸目标差异。

### 首页加载性能优化（已提交 `4ec2a07` + 版本 `b418b4c`，发布 v1.5.26）

**目标**：首页加载变慢，分析原因并优化。用户从三项优化中选了 2、3、4（未选 1 的 SW stale-while-revalidate）。

**做了什么**（4 文件，`+73/−15`）

- **选项 2**：`/api/config` 的 fetch 从 `cache: 'no-store'` 改 `cache: 'no-cache'`
  （`index.html`），服务端补 `Cache-Control: no-cache`（`server.js`）。**单改客户端不够**——
  服务端虽发 ETag 但从不发 `Cache-Control`，浏览器因此不缓存 config、ETag 形同虚设；
  补上头后浏览器才在回访时发 `If-None-Match`、服务端返 304（零响应体）。
- **选项 4**：`lib/pinyin.js`（收藏加载时）与 `lib/qrcode.js`（首次分享时）从
  `index.html` 移除，经 `app.js` 新增的 `loadScript(src)` 延迟加载（同一 src 只加载
  一次，失败清缓存可重试）。二者仍列入 `sw.js` 的 `ASSETS` 预缓存（离线可用）。
- **选项 3（原方案被审查推翻，见下）**：`admin.css` 改为 `media="print" onload`
  非阻塞加载——首屏渲染不等它，但用户交互前已就位。
- `sw.js` 缓存 `nav-v33 → nav-v34`（改了 `public/` 资产，**发版阻断项**）。

**审查中发现并已修的硬违规（Standards 轴 P0）**：我最初把 `admin.css` 移出 head、
只在 `openAdmin` 里按需加载。但架构文档 `:145` 规定「站内对话框统一走 `showUiDialog()`，
样式定义在 `admin.css`」——admin.css **不止样式化管理面板**，还样式化首页的分享保护
面板、confirm 对话框与错误 toast（`admin.css:49` 的 `.ui-dialog`、`:334` 的
`.toast[data-state="error"]`）。按需加载会让这些首页功能在首次打开管理面板前**完全无样式**
（我首次的分享测试因先开了管理面板而幸免，是假绿）。已改为非阻塞加载，并实测：
全新页面不碰管理面板、直接触发分享，保护面板即带 `backdrop-filter: blur(23px)`、
`background: var(--admin-panel)`、`border: 1px solid`。

**已验证**（真实服务器 + 无头 Chrome）

- 选项 2：服务器日志确认浏览器回访时发 `If-None-Match: W/"428-…"`、服务端返 304；
  配置按认证态生成不同表示（公开视图不含 `privacyMode`）→ 不同 ETag → 登录态变化
  必得新 200，**不会拿到旧的完整配置**（「始终最新」成立）。
- 选项 4：qrcode 仅在分享时加载、二维码正常生成（真实 data URL）；pinyin 在首屏后
  才加载（load 事件已完成），拼音搜索 `bdss` 正确命中「百度搜索」；`buildSearchIndex`
  另有三个调用点均在首次 `loadFavorites` 之后，不会 `ReferenceError`。
- 选项 3：`admin.css` 的 `media` 由 print 切为 all（onload 生效），首页对话框样式就位。
- 回归 207 条全绿；`node --check` 通过。
- 发布验证：`/releases/latest` 指向 `v1.5.26`（4.3MB）；下载 tarball 后 grep 确认
  8 项改动全部在内、`ensureAdminCss` 无残留、无 docs/tests 泄漏；远程 `main` 到
  `b418b4c`、tag `v1.5.26` 已推送。

**已知取舍与未做**

- pinyin/qrcode 仍由 SW 在安装时预缓存（省的是**首屏阻塞**而非流量；严格说「首次分享
  才下载」有出入，但脚本执行确实已延迟，且换来离线可用与老访客秒开）。
- `loadScript` 的失败重试（`promise.catch` 清缓存）只为两个调用点，属轻量投机泛化，
  保留因网络抖动后可自愈。
- 未在真实高 RTT 网络测 304 的端到端收益（本地回环 RTT≈0，看不出省传输的绝对值）。

## 会话落盘（SQLite）：升级/重启不再掉登录

**目标**：`./sylph.sh update` 重启进程后不再要求所有人重新登录；顺带为后续模块（文件上传、服务器/行情/社媒监控、稍后阅读）预留一个窄的数据库接缝。做法是既定的**方案 2**——只把**会话**落到 SQLite，`config.json` / `favorites.json` / `.admin-password.json` / `.webdav-config.json` 一律不动。

**改了什么**

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 连接与迁移 | `lib/db.js`（新增） | 驱动只在此文件出现；WAL + `user_version` 迁移；打开后把库文件与 `-wal`/`-shm` 收紧到 0600 |
| 会话后端 | `lib/session-sqlite.js`（新增） | 把 `sessions` 表适配成 `SessionStore` 的 6 方法后端接口 |
| 存储接缝 | `lib/session.js` | `this.sessions`（Map）→ `this.backend`，新增默认内存后端；**对外接口未变**，路由层零改动 |
| 接线 | `server.js` | `sessionStore` 由 `const` 改 `let`，在 `init()` 内开库后构造；`gracefulShutdown` 关库（WAL checkpoint） |
| 配置 | `server-config/defaults.js`、`index.js` | 新增 `paths.database`（`DB_FILE` 可覆盖） |
| 忽略 | `.gitignore` | `nav-sylph.db`、`-wal`、`-shm` |
| 升级 | `sylph.sh` | 备份/回滚清单加入 db 文件，**仅本地回滚**，不进 WebDAV |
| systemd | `nav-sylph.service` | `ReadWritePaths` 追加 db 与 WAL 边车（`-` 前缀容忍首次启动时尚不存在） |
| 依赖 | `package.json` | `better-sqlite3@^13.0.3` |

**驱动选择推翻了一个初稿事实**：`better-sqlite3@13` 要求 **Node ≥ 22**（`engines: {"node":">=22"}`），初稿写的「Node 18+」不成立。v12 支持 Node 20，但带 `install: prebuild-install || node-gyp rebuild`——本机沙箱与国内网络下都是失败点；v13 **无安装脚本、包内自带预编译二进制**，故选定 v13，并把 Node 基线从 16+ 提到 **22+**（README / DEPLOYMENT 已同步）。

**已验证**

- `node --test tests/*.test.js` → **217 tests, 217 pass, 0 fail**（`tests/session.test.js` 新增 10 条）
- 红/绿：改坏 `lib/session-sqlite.js` 的 `set()` → 7 条转红（含「重启后登录态仍在」）；恢复后 `diff` 逐字相同
- 其中「过期会话」一条最初在该破坏下**空转通过**（它断言的行从未被写入），已补前置断言钉住，重跑后转红
- 真实服务器端到端（临时目录 + 真实 HTTP，非 file://）：登录 → **重启进程** → `authenticated:true`；再走一遍 `sylph.sh update` 的文件替换（`rm -rf public server-config` + `rm -f server.js …`）→ 仍 `authenticated:true`；伪造令牌 → `authenticated:false`
- 端到端反向验证：把 `server.js` 的后端换成内存 → 重启后 `authenticated:false`，证明测试不是空转
- 库文件实测权限 600（含 `-wal`/`-shm`）
- 语法：`server.js`、`lib/*.js`、`server-config/*.js` 逐个 `node --check` 通过；`bash -n sylph.sh` 通过
- 本次**未改动 `public/`**，故 `sw.js` 缓存**不升版**

**未验证 / 需目标环境确认**

- 目标 Linux 服务器上 `npm install` 能否命中 `better-sqlite3@13` 的预编译二进制（本机 darwin-arm64 / Node 22.23.1 已验证可用）
- `ProtectSystem=strict` 下 systemd 对 db 的实际写入（本地无 systemd 环境）
- 真实浏览器中「升级后无需重新登录」的交互确认（HTTP 层已证明，未在浏览器点过）

**过程中我自己的一次失误**：E2E 脚本的 `start()` 写成 `( cd … && node … ) &`，写进 PID 文件的是子 shell 而非 node，`kill` 后留下一个 PPID=1 的孤儿进程占着 4195。已先用 `ps -o pid,lstart,command` 与 `lsof -a -p … -d cwd` 确认归属（cwd 指向已删除的临时目录，不是用户自己的服务）再清理，并改为 `exec` 让 `$!` 就是 node 的 PID。

**代码审查（两轴，基线 `v1.5.26`，审查对象是未提交的工作树）**

采纳并已修 5 项：

- `server.js` 定时器旁的注释仍写「模块顶层 `const` 已完成初始化」——已是 `let`，改为「回调 60 秒后才读，而 `init()` 在开始监听前就已完成赋值；`init()` 失败则进程随即 `exit(1)`，安全性取决于调用时机而非代码顺序」。
- `init()` 失败路径只 `exit(1)`、不关库，补上 `db.close()`，避免留下未 checkpoint 的 WAL。
- `lib/db.js` 多导出 `runMigrations`、`lib/session.js` 多导出 `createMemoryBackend`，两者都无消费者，收回（`lib/db.js` 按要求只留 `openDatabase` + `MIGRATIONS`）。
- 计划承诺的部署面源码形状守卫此前只是手工核对，已补 4 条断言（`nav-sylph.service` 的 `ReadWritePaths`、`sylph.sh` 的备份与放回、`.gitignore` 三项、`server.js` 的开库顺序），并逐个做了红/绿验证。

复核后**驳回** 3 项（记录以免重复调查）：

- 「db 文件名同时硬编码在 `sylph.sh` 与 unit，用 `DB_FILE` 覆盖时这两处会漏」——成立，但与本仓库既有模式一致（`LOG_DIR` / `DATA_FILE` 对 shell 与 unit 同样不可见），覆盖者本来就需要同步调整 unit；不为此新增机制。
- 「`SessionStore` 构造参数已达 12 个（Data Clumps）」——既有形状，非本次引入，且当下没有打包成 options 类型的需求。
- 「`sylph.sh` 只备份主 `.db`、不含 `-wal`，回滚会与新 WAL 错配」——**不成立**：该脚本自始至终不覆盖 db（tarball 里没有这个文件），所谓「回滚」只是把同一份字节拷回原处，构不成「旧主库 + 新 WAL」；且停服走 SIGTERM，关库时已 checkpoint。

另有一条**保留为未验证**：「`ProtectSystem=strict` 下，用 `-` 前缀列出的 db 路径若在首装时尚不存在，可能不会被挂成可写」。本地无 systemd 无法验证，且实际部署运行的是 `sylph.sh do_enable` 生成的 unit（不设 `ProtectSystem`）。

**发布 v1.5.27**

- 前置检查：`git status --short` + `git diff <last-tag> --name-only` 对照 `release.sh` 的打包清单。`public/` **未改动** → `sw.js` 缓存保持 `nav-v34`，**无需升版**。本次是「确认命中」方向，不是拦下遗漏。
- 三处版本号 → `1.5.27`，并用 `node -e` 重新解析确认 JSON 仍合法、三处一致；`CHANGELOG.json` 新增 `1.5.27` 条目（summary 一句 + 两条 highlights + improve 三条）。
- 提交 `17efea1`；`bash scripts/release.sh` 产出 `nav-sylph-v1.5.27.tar.gz`（4.3M）、打 tag `v1.5.27`、创建 Release。
- 脚本只推 tag，已手工 `git push origin main`（`7c3fc16..17efea1`）。
- 产物核验：`/releases/latest` → `v1.5.27`；下载 tarball 解包确认 `lib/db.js`、`lib/session-sqlite.js` 在内，包内 `package.json` 为 `1.5.27`，`docs/`、`tests/`、`.git`、`node_modules` 均无泄漏，包内 README 已是「Node.js 22+」。

**下一步**

- 新模块在 `lib/db.js` 的 `MIGRATIONS` 尾部追加台阶，不新建库文件
- 若日后要把配置/收藏也迁入同一库，须先处理 `favorites.json` 的 HTML 导入导出与 WebDAV 往返格式
- 本次改动已提交 `17efea1`、已发布 v1.5.27

## 全面审查（文档 / 脚本 / 新旧模块冲突）与随后的修复

**方法**：基线 `v1.5.27`。文档逐条与代码核对；后端方法集、驱动引用点、WAL 权限、WebDAV 边界等一律**实测**而非推理。以下结论均已复核。

**确认并已修**

| 级别 | 问题 | 证据 | 修法 |
| --- | --- | --- | --- |
| P0 | 密码哈希与私密收藏是 644，反而只有新加的会话库是 600 | 全新安装实测 `.admin-password.json` / `config.json` / `favorites.json` 均为 644 | `writeJSON()` 写完即 `chmod 600`；`init()` 每次启动调 `restrictPrivateFileModes()` 兜底校正既有安装；WebDAV 配置在 `lib/webdav-backup.js` 的保存路径单独收紧 |
| P1 | `release.sh` 把未跟踪的本机 `server-config/config.json`（含 `"port": 4123`）打进了发布包 | 下载的 v1.5.27 产物里确有该文件 | `cp -r server-config` 改为只复制 `server-config/*.js` |
| P2 | `server-config.example.json` 缺 `database` 键 | 与 `defaults.js` 的 `paths` 块比对 | 示例补上 |
| P3 | 升级到本版本（Node < 22 时）会「`npm install` 全绿、启动段错误」，而脚本既无版本检查也无回滚 | 实测 Node 20.19.4 加载 `better-sqlite3@13` → **Segmentation fault，退出码 139**（`try/catch` 接不住）；Node 20 下 `npm install` → **退出码 0、EBADENGINE 出现 0 次** | `sylph.sh` 新增 Node 版本闸门，**排在停服与下载之前**；`do_install` 同样校验；README / DEPLOYMENT 写明前提 |

P3 是本轮最值得记住的一条：失败**不会在安装阶段暴露**。`sylph.sh update` 的既有流程是「停服 → 删程序文件 → 拷贝新版 → `npm install` → 启动」，版本不够时前四步全部成功，只有最后一步段错误退出——而脚本在停服之后没有任何回滚路径，站点就这么停着。闸门因此必须挡在 `do_stop` 之前。实测平台为 darwin-arm64；Linux 上未复现，但包与 N-API 层级相同。

P0 的根因值得记住：`sylph.sh:473` 的 `chmod 600 .admin-password.json` 跑在**应用创建该文件之前**（文件由 `server.js` 的 `ensureFile()` 在首次启动时写入），`[ -f ]` 守卫直接跳过——**脚本侧的 chmod 不能作为私有文件的唯一防线**。`.env` 不受影响（`sylph.sh:474`），因为脚本自己在前面创建了它。

**已排除（不成立，免得重复调查）**：会话泄进 WebDAV（`lib/webdav-backup.js` 零引用）；两个后端方法集不一致（实测两侧都是同样 6 个方法）；驱动被别处 require（只有 `lib/db.js`）；二次启动后 WAL 权限回落 644（实测仍为 600）。

**既有、非本次引入，未改**：`nav-sylph.service` 的 `ReadWritePaths` 未含 `favorites.json` 与 `.webdav-config.json`（`ProtectSystem=strict` 下会拒写，但实际部署用的是 `sylph.sh do_enable` 生成的 unit，不设 `ProtectSystem`）；`paths.data` 是死配置（全仓无消费者）；`lib/db.js` 导出的 `MIGRATIONS` 无 import（方案要求暴露，保留）。

**验证**：`node --test tests/*.test.js` → **226 通过 0 失败**（新增 2 条私有文件权限守卫 + 4 条 Node 闸门用例，均经红/绿验证）；全新安装实测五个文件全部 600；预置 644 的旧文件在启动后被收敛为 600；打包逻辑实测不再夹带 `config.json`；闸门用例在环境 `NODE_BIN` 不可用时仍全部通过（不依赖跑测试的 Node 版本）。

**发布 v1.5.28**

- 前置检查：`git status --short` + `git diff <last-tag>` 对照 `release.sh` 打包清单；`public/` 未改动 → `sw.js` 缓存保持 `nav-v34`，**无需升版**。本次是「确认命中」方向，不是拦下遗漏。
- 三处版本 → `1.5.28`；`CHANGELOG.json` 新增条目（summary 一句 + 两条 highlights + `fix`/`security`/`improve`）。
- 提交 `5c774d1`；`bash scripts/release.sh` 产出 `nav-sylph-v1.5.28.tar.gz`；脚本只推 tag，分支为手工推送（`f10e93c..5c774d1`）。
- 产物核验：`server-config/` 只有 `defaults.js index.js`（**P1 在真实产物上确认修复**）；包内版本 `1.5.28`；`restrictPrivateFileModes` 与 `REQUIRED_NODE_MAJOR=22` 均已随包；无 `docs/`、`tests/`、`.git`、`node_modules` 泄漏。
- **在产物里真实的 `sylph.sh` 上跑了一次闸门**：伪造 Node 20 → 打印拒绝信息并以 `exit 1` 结束，未停服、未联网。

## 登录后模块平台（地基 + 第一个模块，已随 v1.6.0 发布）

本节改动已合并到 `main` 并发布为 v1.6.0（发布提交 `ada60c6`）。计划文件：`~/.commandcode/plans/nav-sylph-module-platform.md`。

> **四个模块尚未实现**：本节交付的是平台骨架 + 服务器监控。文件分享、稍后阅读清单、社交媒体监控、行情监控（股票 + 加密货币）都还没做各自的业务逻辑——它们需要三件本轮没有的决定：稍后阅读的外部分享入口如何鉴权、行情数据源是否引入外部依赖、文件分享「下载不需登录」下的链接猜测成本与过期策略。

### 目标

为服务器监控、社交媒体监控、行情监控、稍后阅读清单、文件分享五个「登录后才可见」的模块建立骨架，并落地其中一个（服务器监控，唯一无外部依赖者）验证整条链路。四个业务模块留给后续。

### 做了什么

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 模块配置独立文件 | `server.js` 的 `MODULES_FILE` / `defaultModulesConfig` / `normalizeModulesConfig` / `mergeModulesConfig` | `.modules.json`，已入 `PRIVATE_FILES`（自动 0600）与 `.gitignore`。**不进 `config.json`** |
| SQLite 台阶 | `lib/db.js` 的 `MIGRATIONS` 第 2 项 | 只建 `module_cache` 一张表，`user_version` 1→2。其余三张表留给各自的模块 |
| 三个特权端点 | `server.js` 模块平台 API 段 | `GET/POST /api/modules/config`、`GET /api/modules/metrics`，全部 `rateLimit + requireAdmin` |
| 本机采集 | `lib/monitor.js` | CPU 用两次采样的累计时间差分（单次读恒为 0）；内存、负载、运行时长 |
| 模块平台（前端） | `public/app.js` | `KNOWN_MODULES` 白名单、`registerModule`/`loadModule`、模块区渲染、编辑模式与拖拽 |
| 模块区 DOM | `public/index.html` | `<section class="module-zone" id="moduleZone" hidden>` 在 `main.grid#grid` **之后**；dock 加「布局」按钮（`#layoutBtn`，默认 `hidden`） |
| 第一个模块 | `public/modules/server-monitor.js` | 三指标 widget + 全屏面板 + 15 秒轮询（页面隐藏时停表） |
| 样式 | `public/styles.css` 尾段、`public/admin.css` 尾段 | 模块区样式并入 `styles.css`；tab 侧栏样式写进 `admin.css` |
| 缓存 | `public/sw.js` | `nav-v34` → `nav-v35`，`ASSETS` 加入 `/modules/server-monitor.js` |
| 后台分区 | `public/app.js` 的 `renderAdminPanel`/`bindAdminTabs`/`selectAdminTab` | tab 三件套；宽屏侧栏、≤899px 顶部横滑标签条 |

### 本次发现并修掉的一个真缺陷

**归一化补默认值导致「缺席」与「显式清空」无法区分。** `normalizeModulesConfig()` 早先把缺失的键一律补成空数组，于是 `mergeModulesConfig()` 的 `incoming[key] !== undefined` 恒为真，保留分支永远走不到。后果很具体：**用户在首页拖一次 widget 排序（只提交 `widgets`），`servers` 与 `symbols` 被清空。**

发现途径是真实服务端到端，不是读代码。当时的单元测试直接调 `mergeModulesConfig(existing, 部分对象)`，**绕过了归一化**，所以对着有 bug 的实现恒绿。已把测试改成走「归一化 → 合并」两步，并补一条专门断言「归一化不补缺席的键」；重新施加原缺陷后两条测试同时变红。

这个缺陷之所以值得记：它同时命中本仓库的两条既有教训——「合并而非覆盖」的守卫若只测 merge 不测真实调用链，等于没测；单元测试在结构上就看不见「归一化把缺失补成空」这一层。

### 验证

- `node --test tests/*.test.js` → **240 通过 0 失败**（基线 226，新增 14 条）
- **红绿验证共 11 处**（服务端 6 处 + 浏览器 5 处），每处都先用 `node -e` 断言锚点存在、缺失即 `exit 1`，并 `diff` 确认文件真的变了：
  1. 从 `/api/modules/metrics` 摘掉 `requireAdmin` → 端点守卫测试红
  2. 让 merge 的缺席分支回落空数组 → 合并测试红
  3. 改名 `module_cache` 表 → 迁移幂等测试红
  4. 从 `PRIVATE_FILES` 移除 `MODULES_FILE` → 权限测试红
  5. 移除 `enabledModules` 的 id 白名单 → 归一化测试红
  另加第 6 处：恢复最初的归一化缺陷 → 两条测试红（这是修复后的回归证明）
  浏览器轮的 5 处见下文「红绿验证（本轮新增 5 处）」表
- **真实服务端到端**（`tar` 复制到 `/tmp` 临时目录、`node_modules` 符号链接、`PORT=4319` 覆盖）：
  - 启动创建 `.modules.json`，五个私有文件全部 `-rw-------`
  - 匿名访问三个端点全部 **401**
  - 登录 → 写配置：路径穿越 `../../etc/passwd` 被挡、`token` 字段不在白名单内故不落盘、字符串两端空白被裁
  - `GET /api/modules/metrics` 首次 `cached:false`（真实采集 CPU 23.9%），第二次 `cached:true`（命中 5 分钟缓存，不重采）
  - 只提交 `widgets` 后 `servers`/`socialAccounts`/`symbols` **保留**（缺陷修复的实测确认）
  - 畸形请求体 `[]` / `"string"` / `42` / `null` 全部 **400**
  - 登出后三个端点重新 **401**；匿名 `GET /api/config` 的顶层键只有 `theme, searchEngine, showBookmarkIcons, categories, searchEngines`，无任何模块字段
- 测试进程已按 PID 确认归属后终止，4319 端口已释放，4195–4320 全扫无残留

### 浏览器实测发现并修掉的五个缺陷

单元测试与真实服务端端到端都跑完之后，浏览器里又抓出五个。前两个只有真机能看出来，因为它们在接口返回 200、内存状态齐全的情况下才发生。

**1. 页面内登录不加载模块区。** `openAdmin` 里密码验证成功那条路径设了 `authenticated = true`，却没有调 `syncModuleVisibility()`——它与首屏的 `restoreSession` 是两条独立路径。症状是「密码正确、已进入管理，但首页模块区空的、布局按钮不出现」。改密码那条路径同样问题：会话已全部销毁，模块入口却还亮着。已给四条登录态切换路径各补一次同步，并加了一条枚举式护栏。

**2. `mountModule` 先查定义再加载脚本。** 顺序反了，于是首次进入必然显示「模块未注册」——脚本其实加载成功了，只是注册发生在检查之后。单元测试看不见：注册表在测试里始终是空的，而错误态与正常态渲染成同一个 `.module-widget` 外壳。

**3. 窄屏规则写在基础规则之前。** 我一度把窄屏段并进文件上方那条 `≤1023px` 块（想避免同查询出现第二条），结果基础规则落在它**后面**，同特异性下基础赢。实测 390×844 与 360×640：`.module-zone-inner` 仍算成 `grid`、横向滚动完全没生效，360px 下还被挤成 `190px + 105px` 两列。这正是本文件尾段注释警告过的覆盖顺序陷阱，我又踩了一次。已把窄屏段移回基础规则之后，并加了一条**比较两处源码位置**的断言——只断言两条规则都在，永远为真。

**4. 拖拽把手写了 `hidden` 属性。** 模块在 `mountWidget` 里写 `handle.hidden = !state.editLayout`，而挂载时 `editLayout` 几乎总是 `false`；`hidden` 属性压过任何 CSS，于是进编辑模式后把手实测 **0×0**、点不到。已交回平台侧用 `.module-zone.is-editing` 控制，模块不再碰 `hidden`。

**5. 后台侧栏没有并排。** 只把 `.admin-tabs` 改成 `column` 不够——它与 `.admin-panels` 是 `#modalBody` 里的同级块，各占满整行，实测每个标签 **827px 宽**、右侧大片空白（截图可见）。要让两者并排，必须让 `#modalBody` 本身成为横向 flex 容器。修后侧栏 172px、内容列 643px。

另外修了一处判据错误：模块分区用 `!this.modulesConfig` 判断是否加载，而首页早已拉过配置，于是切进分区什么都不做、永远停在「加载中...」。改成 `!this.modulesEditorRendered`，并在 `renderAdminPanel` 里复位（面板 DOM 每次都是新的）。

### 五视口实测量表

单位 px。每轮测量前都 `unregister()` + `caches.delete()` 清掉全部 key 并加 cache-busting query——本仓库已因 SW 缓存误判过三次，实测中确实有一次量到的是上一轮的旧 CSS。

| 视口 | 模块区 top | 模块区高 | 模块区宽 | 网格→区间距 | inner 布局 | 横向溢出 | widget |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 390×844 | 419.5 | 177 | 366 | 24 | flex | 否 | 190×152 |
| 360×640 | 419.5 | 177 | 321 | 24 | flex | 否 | 190×152 |
| 834×1112 | 446 | 177 | 790 | 24 | flex | 否 | 190×152 |
| 844×390 | 446 | 177 | 785 | 24 | flex | 否 | 190×152 |
| 1280×800 | 500 | 152 | 876 | 30 | grid 两栏 | 否 | 425×152 |

窄屏 widget 固定 190px、模块区单行横滑（`overflow-x:auto` + `scroll-snap` + 右侧渐隐 mask）；当前只有一个模块故 `overflowX` 实测为否，多模块时才会溢出。宽屏两栏各 425px，B 方案的「网格末行与模块区粘连」风险未出现（间距 30px，与既有分类间距同量级）。

### 交互实测

- **拖拽换边**：指针在元素**外**移动 200px 后松手 → `side` 由 `left` 落盘为 `right`；`dragData` 清空、`.is-dragging` 移除、`transform` 归零，无残留
- **pointercancel**：拖拽中派发 cancel → 同样全部清理干净，`data-drop-side` 与 `.drop-target` 归零
- **编辑模式往返 10 次**：每一步 `editLayout`、`.is-editing`、把手数量（恒 1）、`.is-dragging`（恒 0）、`.drop-target`（恒 0）、把手 display 全部一致，无状态残留
- **登出（且正处于编辑态）**：`editLayout=false`、模块区 `hidden` 且 `children=0`、`#layoutBtn` 隐藏、`modulesConfig` 清空、`dragData` 为 null
- **详情面板**：六项明细齐全（内存绝对值、核数、负载、运行时长、采样时间、数据来源），`aria-modal=true`
- **深色模式**：沿用既有 token，widget 底 `rgba(65,58,51,.7)`、文字 `rgb(243,238,232)`、进度条渐变取到 `--accent`/`--accent-hover` 的深色值

### 红绿验证（本轮新增 5 处，均已确认变红）

| 变异 | 变红的测试 |
| --- | --- |
| `mountModule` 改回先查后加载 | mountModule 先加载脚本再取定义 |
| 分区判据改回 `!this.modulesConfig` | 模块分区按「是否已渲染」判定 |
| 删掉 `renderAdminPanel` 里的标志复位 | 同上 |
| 模块重新写 `handle.hidden` | 拖拽把手不由模块自己写 hidden |
| 窄屏段移到基础规则之前 | 模块区的窄屏覆盖写在基础规则之后 |

### 我在验证过程中自己搞错的三处（都已修，且都属同一类）

1. **三处护栏的断言写错了，读起来像代码有 bug**：`mountModule` 的顺序判据（我把「第二次查询」当成了「第一次」）、`renderAdminPanel` 的切片窗口（复位在 ~14288 字符处，被切在外面）、`beginWidgetDrag` 的切片窗口（三个 `addEventListener` 落在 1825–1941，1800 的窗口正好切掉）。**第一处与第三处都曾让「删掉修复」后测试仍然绿**——护栏自己失效了，是重跑变异才发现的。已全部改成按方法边界切片，并在注释里记下窗口大小与偏移。
2. **一次 `perl`/锚点替换静默无操作**：M3 变异声称应用成功、测试却全绿，追查发现是锚点虽然匹配、但我替换成的目标文本与原文本等价。改用显式 before/after 断言后才暴露。
3. **一次量到的是缓存**：未清 SW 就测量，390px 读到 `grid`，差点误判为修复无效。

### 仍未验证

- **agent 在真实 Linux 上读 `/proc` 的路径**：本轮全部验证跑在 macOS 上，走的是 `os`/`vm_stat` 分支。`/proc/stat`、`/proc/meminfo`、`/proc/loadavg` 的解析逻辑未经实测——它们在 Linux 上的真实输出格式需要一台 Linux 机器才能验证。
- **触摸设备的真实拖拽手势**：headless Chrome 不产生真实 touch 事件，`set device` 也无法提供 `pointer: coarse`。把手实测 26×26px，低于既有 `--ctl-h: 44px` 的触摸下限——**这是已知的设计取舍（鼠标/长按操作），但真机上是否够用需要你按一下才知道**。
- **软键盘顶起时的模块面板**：`.module-panel` 已按既有 `--kb-inset` 写了 `max-height`，机制与站内对话框一致，但键盘真的弹起来时未实测。
- `prefers-reduced-transparency` 下的实际观感。

### 用户实测后修掉的两处

**1. 首页只有一张卡片且无数据。** 原因不是代码缺陷，而是**指标有 5 分钟缓存**：`module_cache` 里存着配置服务器**之前**的那份结果（当时还没有远端服务器，只有本机）。刷新读到的还是旧值，看起来就是「一张空卡片」。

**已修**：加 `invalidateMetricsCache()`，在**改变采集目标的三条写入路径**上调用——添加/编辑服务器、删除服务器、以及 `/api/modules/config` 里 `servers` 实际发生变化时。

关键取舍：`/api/modules/config` 也用于拖拽排序与开关模块，那两种改动**不影响采集目标**，所以那里加了前后比较、只在 `servers` 真的变了才清。无条件清缓存会让「加一台机器立刻可见」这个修复退化成「任何保存都重采」，5 分钟 TTL 就再没有意义。

实测：加一台服务器 → 缓存行数 1→0 → 下次采集立刻出现新机器（`cached:false`，服务器数 5→6）；只改布局 → 缓存行数保持 1。

**2. macOS 上内存恒为 99%。** `os.freemem()` 在 macOS 上返回的是「未被列为可用」的页，而 macOS 把大部分内存拿去做文件缓存——实测 16GB 机器上 `totalmem - freemem` 达 **98.6%**，显示成「内存 99%」，看着像要爆，实际完全正常。那个数衡量的是缓存占用，不是应用占用。已改为读 `vm_stat` 的 `free + inactive + speculative + purgeable`（`inactive` 是可回收缓存，算作可用才是用户视角），实测从 99.5% 降到 76.2%。**服务端与 agent 两处都改了**，口径一致。

macOS 支持是这一轮补上的：原先只在「缺 `/proc` 时不崩」这个意义上支持，指标口径仍是 Linux 的。Linux 走 `/proc`、macOS 走 `vm_stat`、其它平台退回 `os`。

### 布局与拖拽：用户实测后修掉的三处

**卡片重叠。** 宽屏纵向偏移写死了 `calc(var(--i) * 166px)`，而卡片高度随内容变：在线带延迟提示 174px、在线无提示 152px、离线只有 98px。174 > 166，带提示的卡片就压住下一张——实测两处重叠，都是 8px。已改为 JS 实测高度后逐张累加写入 `--stack-top`；CSS 侧接受这个值。用 CSS 变量表达「每张卡自己的偏移」做不到，因为偏移依赖前面**所有**卡的高度和。内容变化（上线多一行提示、掉线整张变矮）后也要重排。

**后台监控目标列表太松。** 每台 59px 两行 → 37px 单行（名称与地址并排），三台从 176px 降到 110px。窄屏换行时保留 token 徽章——「这台配没配 token」正是判断离线原因的关键，藏掉用户只能靠猜。

**拖拽不换位（本轮最隐蔽的一个）。** 症状是「把本机拖到 NAS 的位置，两者不互换」。根因是**拖拽过程中从未移动过 DOM**：只在松手时按「DOM 当前顺序」写 `order`，而节点位置从没变，读回来的自然还是原顺序。已改为在 `pointermove` 里用 `insertBefore` 真正插入。

修完第一个又暴露第二个：**中线必须量一次并缓存**，不能每帧读实时 `getBoundingClientRect()`。因为卡片一旦让位，上方那张的实时中线也跟着移位，「指针 < 中线」这个比较会在自己造成的移动中失配——实测「把最后一张拖到最前」怎么拖都插不进去。已在 `dragData.bounds` 里缓存拖拽开始时的中线，并确保每次新拖拽把它清空。

实测四种位置全部生效：最后一张拖到最前、 第一张拖到最后、中间两张互换、跨边（right→left）。刷新后顺序保持，卡片零重叠。

**红绿验证 3 处**：拖拽中不插入、每帧重读中线、不清缓存 —— 全部变红。

**拖拽切换生硬、跳动幅度过大。** 修好换位之后用户指出「跳得太猛」。量出来是两个叠加的问题：

1. **被拖的卡片会「弹」一下。** 视觉位置 = 基准（`--stack-top`）+ `transform`。插入会让基准突变（实测 376 → 188，跳了两张卡的高度），而 `transform` 仍相对拖拽起点 —— 合成后卡片猛跳 **247px**，用户看到的是「先弹回原处再跟上指针」。修法是记住基准差量、补进 `transform`，并同步 `dragData.startY`（否则下一帧仍用旧参照，位置逐帧漂移）。实测单帧跳动从 247px 降到 **21px**，与指针位移完全一致。
2. **让位的卡片是硬跳的。** 给 `margin-top` 加 **180ms** 过渡。但**被拖的那张不能有**——它的位置由 `transform` 连续控制，再叠一个 `margin` 过渡会和基准补偿打架，出现二次抖动。所以单独给 `.is-dragging` 一条不含 `margin-top` 的 transition。

**红绿验证 4 处**：不做基准补偿、差量不加进 transform、不同步 `startY`、撤掉让位过渡 —— 全部变红。

### v1.6.1：备份补全 + 凭据暴露面收紧

**1. 远程备份漏了 `.modules.json`（v1.6.0 引入的缺口）。** 备份此前只覆盖 `config.json` 与 `favorites.json`，于是监控目标、每台的 token、顺序与显示开关都拿不回来 —— 换机器或文件丢失就得全部重来。现已补齐：

- 备份产出第三个文件 `nav-sylph-modules-{ts}.json`，按时间戳归入同一组
- **token 在备份里仍是密文**（密钥派生自管理员密码哈希），换机器后用同一密码即可解开；**`.admin-password.json` 依然不备份**
- 模块配置参与「有无变化」判定 —— 只改监控目标却判成 `noChanges`，远端会留一份旧布局
- 清理旧备份时三个文件一并删除：清理按分组算，孤儿文件既不被计入也不会被清走
- 恢复新增「只恢复模块设置」选项，并校验 type 与 checksum

用假 WebDAV 做了完整往返实测：破坏本地配置（改名 + 删光服务器）→ 只恢复模块 → 两台服务器、token、顺序、`pollInterval` 全部回来，**且恢复的 token 解密后仍能通过 agent 鉴权**。

**2. agent 的 `/health` 不再泄露主机名。** 它不需要鉴权（方便「agent 起来了吗」这类探测），所以返回主机名等于给每个扫到该端口的人一份免费资产清单。主机名改到需鉴权的 `/metrics` 里，确实需要时用 `--expose-hostname` 显式打开。

**3. 凭据后果写进了界面，不只写在文档里。** 填写 token 时对话框直接说明：它是那台机器的实时只读监控凭据、每台应使用不同值、泄露后在哪里更换。多数人是从这个对话框进来的，不会去翻 `agent/README.md`。README 的安全章节同步重写为「泄露意味着什么 / 怎么防 / 泄露后怎么办」三节。

**过程中我自己写错的一处**：写 README 时把 `NAVSYLPH_TOKEN` 手写成 `NAVSYP_TOKEN`（**3 处**）。用户照着设一个 agent 根本不读的环境变量，鉴权必然失败，而这种错在文档里完全看不出来。已加守卫测试：从源码 `process.env.X` 反查真实变量名与 README 交叉比对。

**新写的护栏也踩了一次同类坑**：备份测试第一版只匹配文件名与 type，把 `if (modulesData)` 改成 `if (false)` 后**照样全绿** —— 备份里就永远不会出现 modules 文件。已改为盯住「存在性判断 → `putFileContents`」整段。中间两次把切片锚点搞错（拿注释当锚点，而 `code` 已剥注释；用 `const modulesBackup` 会把 `if` 切到外面）。

**红绿验证 7 处**（备份 4 + 安全 3）全部确认变红。测试 293 → 296。

### 发布前审查（双轴）发现的缺陷，均已修

规范轴与需求轴各跑一轮。**需求轴那一路跑满了轮次上限，没交出结论** —— 我自己把它怀疑的几条逐条核实了一遍。

**1. 模块区定位的包含块错了（P0，影响真实观感）。** `.app` 没有 `position`，所以 `.module-zone` 的 `left/right: 22px` 相对**视口**而不是 `.app` 内容盒；而 `sideDockAvailable()` 又是拿 `.app` 宽度算两侧余量的 —— 两个坐标系对不上。实测 1760 宽的窗口：`.app` 左边缘在 160px，模块区却从视口 22px 开始，卡片被甩到窗口左侧。已给 `.app` 加 `position: relative`；六档视口复测，卡片稳定落在背板外侧 20px。

这条能查出来是因为审查员坚持要「打开文件确认」，而不是接受「实测表上是好的」。那张表当时确实没量「卡片与背板边缘的间距」——**指标齐不等于覆盖到**。

**2. 两条护栏是恒绿的（P0）。**

- 「远端拉取不得抛错」写成「成功 return 之前不许有 `throw`」，而那个锚点（`return { ok: true }`）在真实代码里**根本不存在**（实际是 `return { ok: true, metrics: … }`），`slice(0, -1)` 扫的区间不含真正的抛出点。变异验证：在 401 分支前插 `throw`，旧断言全绿。已改为直接盯 catch 块。
- 「周期变化时重排定时器」用 `[\s\S]*?` 扫全文件，在 `startPolling()` 里就命中了 —— 那儿本来就有一对 `clearInterval`+`setInterval`，与这条路径无关。变异验证：把 poll 里的 `if (pollTimer)` 改成 `if (false)`（彻底关掉重排），旧断言全绿。已改为只扫 `poll()` 函数体。

两条都已重跑变异确认变红。

**3. 前后端周期白名单各写一份，且没有测试比较它们。** 前端多一项，服务端会静默回落默认 —— 用户选了一个「看起来存在」却不生效的周期。已补一条**逐项比较两侧列表**的断言（变异：前端多一项 600 → 变红）。

**4. 死代码与「承诺了但没实现」** —— 删掉 `lib/webdav-backup.js` 重构后遗留的四个加密常量、`agent/agent.js` 里每次采样跑两次 `execSync` 却从不返回的 `wired`/`compressed`、`lib/monitor.js` 四个无消费者的导出、`dragData.move`/`settle` 两处冗余赋值。

**5. 两处「说了但没做」** —— 服务端为改密码精心收集的 `credentials.details` 前端**从未读过**，那四句「（无法解密，已保留原值）」等于死字符串；`authFailed` 标记在 `server.js` 丢掉了，界面拿不到，`docs/architecture.md` 记的「界面据此区分凭据错与机器挂」是假的。都已接通：改密码后会弹窗列出需要重输的凭据；凭据被拒的卡片额外提示「去重填 token」。

**6. `#layoutBtn` 的 `title` 承诺了 `Alt+L` 快捷键，全仓库零实现。** 已删掉这个假承诺（`#adminBtn` 的 `Alt+A` 同样是假的，但那是本轮之前就有的，未动）。

**7. 文档引用漂移。** 抽查 `styles.css` / `admin.css` 的四处 `file:line`，**四处全错**（我这一轮大量编辑把它们顶下去了）。已重新定位并改正 10 处。另发现 `docs/architecture.md` 里两处跨节引用（`:145`、`:51`/`:78`）也失效，一并修正；`instanceId` 那段还记着**已被推翻的旧方案**（「加序号」），改为记录实现与理由。

**我这轮自己写错的一处**：改 `pollIntervalOptions` 注释时打进了一个乱码字（`却��效`），已发现并修掉。

### 下一步

发布 **v1.6.0**（三处版本已升、CHANGELOG 已写）。走 `AGENTS.md` 第 6 条 `bash scripts/release.sh`，**不要手写 `git` / `gh`**。发布前置检查已完成：`public/` 有改动、`CACHE` 已升到 `nav-v43`。

之后可考虑：真机确认（agent 在真实 Linux 上读 `/proc` 的路径、systemd 部署命令、触摸拖拽把手尺寸），或实现下一个模块（稍后阅读清单、文件分享、社交媒体、行情）。

## 下一位 Agent 的启动步骤

1. 阅读根目录 `AGENTS.md`、`README.md`、`docs/architecture.md` 及本文件。
2. 核对 `git status --short --branch`、`git log -5 --oneline`、`package.json` 和与新任务相关的代码。
3. 明确本次目标与完成条件，实施后运行定向检查及 `node --test tests/*.test.js`。
4. 在交接前记录实际修改、验证命令与结果、未完成事项。只有发生稳定架构变化时才更新 `docs/architecture.md`。
5. 发布时按 `AGENTS.md` 第 6 条跑 `bash scripts/release.sh`（**不要手写 `git` / `gh`**），完成后用上面的命令确认远端 Release 与本地 tag 都到位——只推分支或只打 tag 都会让 `./sylph.sh update` 停在旧版本。

---

## 局域网设备主动推送（已随 v1.6.2 发布）

基线 `06e7383` 之后的四笔：`ed96806` 功能、`9751663` 文档、`65e8f2c` 版本准备。
发布提交见 tag `v1.6.2`。`sw.js` 的 `CACHE` 同一轮从 `nav-v45` 升到 `nav-v46`。

### 目标

Nav Sylph 部署在公网服务器，用户要看家里局域网的设备。原来的监控是**服务器主动拉取**（`lib/monitor.js` 里拼用户填的 URL + `/metrics`），公网服务器要够着内网必须做端口映射或隧道——那等于把内网服务摊到公网上。

本轮给 `server-monitor` 加**推送模式**：家里 agent 只做出站连接，不开放任何端口。默认仍是拉取，行为完全不变。

### 改了什么

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 新表 `agent_metrics` | `lib/db.js` | `MIGRATIONS` 尾部追加 v2→v3。与 `module_cache` 分开：后者是单键 `'local'` 的聚合结果，前者按 `server_id` 一行一行存单份上报 |
| `mode` 字段 | `server.js` `normalizeServer` + 写路由 | `'pull'`（默认）/ `'push'`，非法值一律回落 `pull` |
| 推送凭据 | `server.js` | 32 字节 CSPRNG，明文只在领取响应里出现一次，落盘只有 `sha256` 哈希 |
| 推送接收端点 | `server.js` | `POST /api/modules/agent-push`，**不带 requireAdmin**（agent 是裸 HTTP），用独立限流桶 120/min |
| 载荷形状校验 | `server.js` | 落库前逐字段夹取；`cpu` 越界变 `null`、字符串截断、载荷 >4KB 整个拒收 |
| 采集分流 | `server.js` `collectAllServers` | 按 `mode` 分流；推送走 `buildPushResult` |
| 离线判定 | `server.js` | 阈值 `pollInterval × 2 + 30s`，**刻意不复用 `resolveCacheTtl`** |
| agent 推送模式 | `agent/agent.js` | `--push <url>`；**默认不监听任何端口**；失败指数退避上限 5 分钟 |
| 后台界面 | `public/app.js` | 「采集方式」单选、「检测连通性」按钮、推送版部署命令面板 |
| 卡片渲染 | `public/modules/server-monitor.js` | 断线时**保留上次数值** + 「最后更新 N 分钟前」 |
| 样式 | `public/admin.css` | 模式徽章；窄屏规则**合并进既有的 `max-width: 700px` 块**，没另起一个 |

### 关键取舍

**不按私网 IP 自动切推送。** 本项目单人自用、tarball 部署，服务器完全可能就架在家里——那时 `192.168.1.10` 完全可达，自动切推送反而搞坏好端端的配置。而且 `100.64.x`（Tailscale）与 `127.0.0.1`（隧道映射）都落在这个判断的盲区里。改成后台「检测连通性」按钮真去连一次（401 算可达），失败只提示、**不自动改用户配置**。

**推送端点不能只验 agent token。** 服务端要拿 token 去解密 `.modules.json`（密钥派生自管理员密码哈希），token 一旦能触发解密+写库就等于配置写权限——可反复触发 bcrypt（约 55ms/次）、可改写首页所有机器的指标。所以用独立的、绑定 `server.id` 的推送凭据。

### 实际跑过的验证

```bash
# 语法（清单从文件类型派生，CSS 不在列——node --check 对它无意义）
for f in server.js lib/db.js lib/monitor.js lib/credentials.js \
         public/app.js public/modules/server-monitor.js agent/agent.js; do
  node --check "$f" || echo "FAIL $f"
done

# 全量（13 个测试文件，逐个列出——`tests/*.test.js` 由 shell 展开更省事）
node --test tests/*.test.js
# → 316 tests, 316 pass, 0 fail（连跑三次均全绿）
```

> 早先这里写的是只列 8 个文件、其中 2 个（`webdav.test.js` / `privacy.test.js`）
> **根本不存在**，且真实的 13 个文件没列全。数字已按全量实跑改正。
>
> 审查轮又新增 6 条守卫，最终为 **320 tests / 320 pass / 0 fail**。
>
> **一条既有的 flaky 断言**：`session.test.js` 的「查询走的是索引查找而非线性扫描」
> 用 `assert.ok(ms < 250)` 卡 5000 次查询耗时。13 个文件并发跑时受 CPU 争用影响，
> 偶发超阈值（实测一次 722.7ms，随后多次全量均全绿、单跑不复现）。
> **不是本轮引入，也不影响本轮结论**，记为待办不在本次修。

**红/绿验证 10/10**（逐条破坏承重结构并确认对应用例转红，备份 + `diff` 确认破坏与还原都真的落地）：mode 白名单、推送模式监听端口、`cpu` 夹取、凭据比对、离线保留数值、渲染侧离线判定、推送阈值公式、`normalizeServer` 接收 `pushSecretHash`、凭据存明文、agent 周期白名单。

**端到端**（真实服务器 + 真实 agent，临时目录在源树之外）：

- 迁移后 `user_version=3`，`agent_metrics` 表已建，库文件 0600
- 真 agent 推送 → 数据落库 → 采集端点读到 `online:true`、`cpu=0.426`、`cores=8`
- **`lsof -Pan -p <pid> -iTCP -sTCP:LISTEN` 对 agent 进程无输出** = 推送模式确实零监听端口
- 错凭据 → 401；`serverId` 错配 → 409；空载荷 → 400；载荷 >4KB → 400
- 越界 `cpu: 1e9` → 落库为 `null`；`platform` 500 字符 → 截到 32
- 离线：人工把 `received_at` 回拨 90 秒（阈值 60 秒）→ `online:false`、`已 2 分钟未收到推送`、**`metrics` 仍在**（`cpu=0.556`）
- 缓存失效：推送后立刻读到新值 `cpu=0.111`
- 三者共存：本机 `online=true`、推送机 `online=true`、拉取机 `无法连接`
- 限流：连打 130 次 → 111 个 200 + 19 个 429，且 `/api/modules/config` 仍 200（独立桶没误伤管理端）

### 两个只有端到端能抓到的 bug（已修，各补了守卫）

**1. `pushLimit is not defined`——服务器启动即崩。** 中间件定义在路由下方，`app.post` 的第二个参数在注册时就要求它存在，而 `const` 有暂时性死区。**`node --check` 与 193 个单元测试全绿**：语法检查不查标识符是否已定义，静态断言看不出「谁在什么时候求值」。守卫改成比较**位置**（`indexOf(function pushLimit)` < `indexOf(app.post(...agent-push))`）。同时发现 `pushLimitMap` 也得进那个 60 秒清理定时器，否则按 IP 计数会无限增长。

**2. `mode` 没落盘，推送静默失效。** 界面选了「推送」、`normalizeServer` 也认 `push`，但 `POST /api/modules/servers` 既没解构 `mode` 也没存进 entry——于是配置里 `mode: undefined`，采集仍走拉取分支，表现为「推送怎么推都不上来」。归一化的单元测试是对的，坏的是**另一条写路径**。守卫断言写路由里那两处。

### 浏览器实测发现并修掉的两处 CSS 缺陷

这两条是**浏览器实测**发现的，单元测试与红/绿验证都看不见（它们是布局行为，不是源码形状）。

**1. 对话框在宽屏恒定偏上 8px。** 五视口里三个不居中：

| 视口 | 修复前 top / bottom | 居中? |
| --- | --- | --- |
| 390×844 | 97.91 / 97.91 | 是 |
| 360×640 | 38.41 / 38.41 | 是 |
| 834×1112 | 280 / 272 | ❌ 差 8px |
| 844×390 | 23.5 / 15.5 | ❌ 差 8px |
| 1280×800 | 124 / 116 | ❌ 差 8px |

根因：`admin.css` 里 `.ui-dialog-overlay` 先写 `padding: 20px`（四边），后面再写
`padding-bottom: calc(12px + …)`（只改底边）。top 留 20px、bottom 留 12px，
`place-items: center` 居中的是内容盒，而内容盒被不对称的内边距整体上推 4px。
窄屏的 media query 四边都用 `calc(12px + …)` 覆盖了，所以只有宽屏偏。

已改为**四边对称的简写**，`--kb-inset` 只影响底部；并删掉 `:310` 那条已成死代码的
`padding: 20px`，避免下一个人去改一个不生效的地方。

**2. 横屏 844×390 下新增的单选组与「确定」按钮全在首屏外。** 修复前
「确定」按钮 `top=582.39`（视口只有 390px），两个采集方式单选在 383–553，
全部不可见——用户看到的是一张只有三个输入框的弹窗。新增横屏块压缩纵向节奏，
并把操作区 `position: sticky` 钉在底部。

**两条都补了守卫并做了红/绿验证（3/3 转红，还原干净）**：
- 「对话框内边距四边对称」断言的是「overlay 规则体里没有单边 `padding-*` 声明」，
  而不是某条规则的字面文本——断言意图，不是断言实现。
- 「横屏操作区钉底」按 `.ui-dialog-actions` 定位 media 块（文件里有多个同查询块，
  按首次匹配会取错）。

### 浏览器实测结果

**修好的（复测后确认，均为干净 run 下的实测值）**

| 视口 | 修复前 top/bottom | 修复后 top/bottom | 差值 | overlay padTop/Bottom |
| --- | --- | --- | --- | --- |
| 390×844 | 97.91 / 97.91 | 97.91 / 97.91 | 0 | 12px / 12px |
| 360×640 | 38.41 / 38.41 | 38.41 / 38.41 | 0 | 12px / 12px |
| 834×1112 | 280 / 272（❌8px） | **276 / 276** | **0** | 12px / 12px |
| 844×390 | 23.5 / 15.5（❌8px） | **19.5 / 19.5** | **0** | 12px / 12px |
| 1280×800 | 124 / 116（❌8px） | **120 / 120** | **0** | 12px / 12px |

两个原本正常的视口数值**未变**（无回归）。原来的三个整体下移 4px，
与「top 内边距 20→12、bottom 保持 12」一致。

**横屏 844×390 的操作区**：`position: sticky` / `bottom: -14px` 生效，
「确定」按钮 `rect.top=332.5`（修复前 582.39，落在视口外 192px），
`elementFromPoint(559,350)` 返回该按钮本身——**几何在内且真的可点**。
滚动到中间位置后仍是 332.5，sticky 保持钉住。

**推送卡片**：标题「家里NAS」、`data-online="1"`、三条指标正常渲染，
「最后更新 不到 1 分钟前」存在且高 15px。本机（直读）与拉取机（连不上）
**都没有**这一行——确认它是推送模式独有的。全程 console 零输出、零错误。

### 未达标的一处（我修得不够，已如实记下）

**横屏 844×390 下「采集方式」两个单选项仍在首屏外。** 修复前
`top` 383.39 / 446.39（`bottom` 到 533.39），修复后 351.39 / 446.39——
**只上移了 32px，离「进入 390px 视口」差得远**。

sticky 那一半完全达成（「确定」可点、滚动后仍可点），但**首屏可见**这一半没达成：
内容总高 584px、视口可见区 349px，上方三个输入框 + 提示文字仍占约 350px。
那个 media 块压了 padding 与 margin，但没动 `.ui-dialog-choice` 的
`min-height: 44px`（两个选项就是 88px），也没有重新编排字段顺序。

**容器可滚，所以不是不可达，而是要滚 118–235px 才看得到。**
要做到首屏可见，得在横屏下让「采集方式」排在三个输入框**之前**，
或把提示正文在横屏下折叠。两者都要改 `showUiDialog` 的字段顺序逻辑，
超出本轮「加一个采集方式选择」的范围，**记为待办不在本次修**。

### 明确不改的两处（既有缺陷，不是本轮引入）

**1. 服务器列表行的按钮实测 26px 高，低于 44px 触摸目标下限。**
`.modal .server-item-actions .btn { min-height: 26px }` 是本轮之前就有的规则
（在 `git diff` 的上下文行里，未被本轮改动）。它压过 `:212` 的
`:is(.modal, …) .btn-sm { min-height: 31px }`——后者特异性更低。
本轮新增的「检测连通性」按钮沿用了同一个容器，所以同样 26px。

**2. 360×640 / 834×1112 / 1280×800 下「确定」按钮的几何 rect 在视口内，
但被 `.ui-dialog` 的 `overflow-y: auto` 裁掉**（hit-test 返回 overlay）。
这是这些尺寸下 scrollTop=0 的既有状态，本轮两个补丁都没改变它。

### 我自己搞出又修掉的两件事

1. **方案文件第一版写崩了**：`~/.commandcode/plans/lan-agent-push-mode.md` 第 434 行起是大段「回回回…」重复、`### 2.8` 出现两次、尾部被截断。写完读回形状（`grep` 重复标记 + 列 `^##` 标题）才发现，整份重写。
2. **复制测试目录时漏了私有文件**：`tar` 的排除清单只写了 `*.db*`，把 `.admin-password.json` 和 `.modules.json`（含真实的 NAS/VPS 配置与密文 token）一起复制到了临时目录。发现后删掉整个临时目录重来，**源目录未受影响**。正确清单要排除 `.admin-password.json` / `.modules.json` / `.webdav-config.json` / `favorites.json` / `config.json`。

### 代码审查发现并修掉的六个问题（提交前）

审查在**工作树未提交状态**下跑的双轴（Standards 对照本仓库书面约定、
Spec 对照用户原话与已批准计划）。基线 `06e7383`，`git diff HEAD` 14 文件 +1505/-91。
下面每条都经我**重新推导并实测**确认，不是直接采信审查结论。

**1. 改个机器名就把推送凭据抹掉（严重，本轮引入）。**
`POST /api/modules/servers` 整体替换 `entry` 时只补回了 `token`，漏了
`pushSecretHash`。实测：领凭据 → 改名字 → `hasPushSecret` 变 false →
agent 全部 401，而界面上看不出「改名字」与「凭据失效」有关联。
`mergeModulesConfig` 那条路径补对了，所以「保存模块配置」不会丢——
**两条写路径里只有这条漏了，只测 merge 会完全看不见**。

**2. 编辑推送机器会自动作废旧凭据（严重，本轮引入）。**
编辑对话框保存后无条件打开部署面板，而部署面板会调 `push-secret`
领取新凭据——领取即作废。于是「改个机器名」这种无害操作会让正在运行的
agent 从此 401。已限定为 `!isEdit &&`：只有**新建**时给引导，编辑时
要换凭据得点列表行的「部署」按钮，那是有意领取。

**3. 跨样式表覆盖：收藏弹窗丢掉安全区（本轮引入）。**
修对话框居中时把 `.fav-dialog-overlay` 并进了同一条四边简写，而
`styles.css` 的 ≤768px 块里那个选择器有一条四边吃安全区的规则——
两者特异性相同、`admin.css` 后加载，于是被整个覆盖。
已拆开：`.ui-dialog-overlay` 用四边简写，`.fav-dialog-overlay` 保持只写 `padding-bottom`。
**这类覆盖静态读代码看不出来**，两个文件都要查。

**4. agent 不校验 `--push` 的协议。** `--push file:///…` 会直入 `fetch`。
测试名叫「只接受 http/https」却**没有任何协议断言**——测试名把没实现的
约束写成了已实现。已加白名单并把断言补实（实测 `file://`/`gopher://`/非法
地址均被拒，`http://` 放行）。

**5. 载荷校验两处与规格不符。** `version` 越界回落 `1` 而非 `null`——
一台推 `version: 99` 的机器会静默当成同版本渲染，而拉取路径会明确报
「协议版本不一致」，同一种不一致两种答案；`memoryUsed`/`memoryTotal`
只有下界没有上界，`1e308` 会原样落库。均按规格改正。

**6. 探测在「没配 token」时早退且不带 hint。** 前端拼的是 `res.hint || ''`，
于是最常见的误判场景（没配 token）恰恰什么都不显示，而真实原因是凭据问题、
「够不够得着」根本还没验证。已补 hint 并标明 `status: 'no_token'`。

**另修三处文档/文案失准**：`server.js` 注释里写死的行号（正是本仓库反复栽的
漂移）、部署面板文案「四步里最关键的三步」（推送只有 3 步）、
`session.test.js` 测试名仍写「18 个」而断言已是 20。

**渲染侧放宽判定的连带影响**：`renderCardBody` 从 `!entry.online` 改成
`!entry.metrics`（推送断线要保留数值，这是本轮必需的）。核实拉取路径的
三个离线分支都不带 `metrics`，所以暂无回归；但这条约定此前只存在于
实现的巧合里，已加守卫正向枚举全部离线分支——将来有人给某个离线分支
加上 `metrics`，一台离线机器就会被渲染成有数值的样子。

**红/绿验证 8/8**（逐条破坏、确认对应对应用例转红、还原干净）。
其中三处**第一版守卫是恒绿的**，补写后才真正有证明力：
- 载荷断言只查了 `cpu`/`memoryPercent`，漏掉 `version` 与上界
- hint 断言用了跨函数的惰性匹配 `if (error) {[\s\S]*?hint:`，
  它一路找到后面正常分支的 hint，删掉早退分支的也照样匹配上
- 离线分支断言只扫了 `collectAllServers`，漏掉独立函数 `buildPushResult`

## 补做三项（已随 v1.6.3 发布）

### 1. 横屏 844×390：改了四版仍未达标（用户选择接受现状）

**这一项没有做完。** 四轮实测的结论都记在 `admin.css` 同一处注释里，
改动前先读那段——它比本文档更靠近代码。

- **第一版**（v1.6.2 已发布）：压 message/hint 的 max-height + 操作区 sticky。
  省 71px，缺口 132px，且 sticky 仍在文档流末位占位，与第一个选项 y/x
  双向重叠 45px——按钮可见了，代价是**挡住了控件**。
- **第二版**：操作区改 `position: absolute` + `.ui-dialog` 加 `padding-bottom: 63px`。
  实测**完全没生效**：选项位置逐位不变（320.89 / 394.48 与第一版相同）。
  原因是 `.ui-dialog` 既是滚动容器又是 absolute 的定位基准，
  给它的 padding-bottom 不会给内容流预留空间。
- **第三版**：扁平 options 横屏下并排两列。溢出 235 → 103px，确有进展。
- **第四版**：收 sticky 条自身的 padding。溢出 → 99px。

**为什么停下**：第四版报告算清了一直被我算错的账。我盯着「选项底边超视口
11.48px」，而真正的问题是 sticky 条**遮挡 42.61px**（可见 42.61/80.59），
加上两个 hint **整个落在对话框裁剪线（bottom 370.5）之下 6.39px**、
逐点采样 **0% 可见**。微调 padding 每 4px 只换 4px 溢出，补不上 99px 的缺口。

**下一步该动的**（不是继续压内容）：sticky 条上方的净空。实测对话框内容盒
`top 34.5` 而 form 内容从 `109.39` 起，**标题与被限高的 message 之间有
74.89px 空白**——那才是真正能省下的地方。

**当前状态可接受的原因**：容器可滚（能到达全部控件）、「确定」按钮始终可点
（`elementFromPoint` 命中按钮本身）、分享对话框完全不受影响（实测溢出 0、
有效期仍是 2×2）。横屏手机用户滚一下即可。

**两处被实测推翻的结论**（已在 `admin.css` 注释里改正）：
- 「absolute 会把溢出撑大约 92px」——sticky 下溢出本来就已经是 99px 量级，
  两个数字不可互相印证，该因果**不成立**。
- 「缺口只剩 11.48px」——那是几何距离，不是遮挡距离。

**一个附带的行为问题**（本次顺带发现，未修）：
改密码对话框点「取消」不生效，需要按 Escape 才关闭。

**配套改动**：扁平 options 此前**不带容器**（`.ui-dialog-options` 只存在于
`groups` 分支），本次给它们补上 `<div class="ui-dialog-options is-plain">`。
但该类的 base 是 `grid-template-columns: 1fr 1fr`（为分组里的四档有效期设计的），
所以加 `.is-plain { grid-template-columns: 1fr }` 让**默认维持原来的竖排**，
只有横屏块里才改成两列 —— 否则分享有效期、PIN 等对话框的布局会被顺带改掉
（实测分享对话框：有效期四项仍是 2×2、溢出 0）。

### 2. 服务器列表改卡片网格 + 按钮 44px

**改动的形态**：一行一台 → **一台一张卡、横向 grid 排多台**（`repeat(auto-fill, minmax(230px, 1fr))`），
卡内竖排（`flex-direction: column`）。

原形态是「三个按钮挤在右侧一行」，`min-height: 26px` 是为那个密度刻意定的；
本轮加了「检测连通性」变四个按钮，更挤不下。卡片形态让密度由**列宽**决定，
卡内因此腾出纵向空间，按钮与开关都做到 44px。

实测（5 台机器）：

| 视口 | 列数 | 每行卡数 | 按钮高度 | 一屏完整可见 |
| --- | --- | --- | --- | --- |
| 1280×800 | 3 | 3 + 2 | 全部 44px | 5 |
| 834×1112 | 3 | 3 + 2 | 全部 44px | 5 |
| 390×844 | 1 | 1 | 全部 44px | 2 |
| 360×640 | 1 | 1 | 全部 44px | 1 |

四视口**碰撞数 0**（x 与 y 区间同时重叠才算），卡片间距 8px。
窄屏缩字号但**不降高度**——窄屏正是触摸设备，降高度只会把达标目标打回 26px。

DOM 相应改动：`server-item-main` → `server-item-head`，新增 `server-item-badges`
承载两个徽章，`server-item-actions` 独占一行。

### 3. 一条 flaky 计时断言改为机制断言

`session.test.js` 的「查询走的是索引查找而非线性扫描」原先用
`assert.ok(ms < 250)` 卡 5000 次查询耗时，并发跑时偶发失败（实测一次 722.7ms）。

计时测的是**机器有多快**，而断言的意图是「查找方式对不对」。改为数
`Buffer.readUInt16LE` / `readUInt32LE` 的调用次数：索引查找固定 4 次
（2 次 vector index + 1 次段长 + 1 次段指针），与所在区段大小无关——
实测七个 IP 全部恰好 4 次，区段从 14 字节到 1078 字节（1 段 vs 77 段）都一样。
线性扫描则是读穿整个数据段（注入后实测 794417 次）。

**两个失败的设计尝试**（都记在这里，因为它们看起来都很有道理）：
- 用「触及的最大偏移」做指标：行不通。索引里的 `startPtr` 是文件的绝对偏移，
  落在各处很正常，实测十个 IP 的占比 30%–99%，与实现方式无关。
- 只包 `readUInt32LE`：行不通。线性扫描那版读的是 UInt16（每段读一次长度字段），
  探针一次都不响、断言恒绿——破坏落地了而测试全绿。红/绿验证才发现。

### 本轮未完成（下一位 Agent 从这里接手）

1. **横屏 844×390 首屏可见** —— 改了四版仍未达标，用户选择接受现状。
   下一步该动的是 sticky 条上方的净空（实测标题与被限高的 message 之间
   有 74.89px 空白），**不是**继续压内容。详见「补做三项」第 1 项与
   `admin.css` 里那段横屏注释。
2. ~~**改密码对话框点「取消」不生效**，需按 Escape~~ —— **已推翻，不是产品缺陷**，
   见下方「一条被推翻的缺陷记载」。那一项本轮记错了，不需要修。
3. **推送在真实内网环境未测** —— 端到端是本机回环，跨 NAT / 代理 /
   真实 systemd 下的表现未验证。
4. **推送凭据轮换的完整闭环没在浏览器走过** —— 重新领取 → 旧凭据失效 →
   agent 报错 → 换新值重启，这条链文档里写了但没实测。
5. **agent 在真实 Linux 上读 `/proc` 的路径未验证** —— 历史遗留项，
   本轮未改变，也未加重。

> 上面第 3–5 条是「未验证」而非「未做完」：功能已实现且在本机测过，
> 缺的是真实环境下的确认。
>
> 文档里另有三节「仍未验证」属于**更早的轮次**（浅色外投影、深色下拉框底色、
> 登录后模块平台），基线 `7a4cac2` 里就已存在，不是本轮欠的。

### 一条被推翻的缺陷记载（不是产品缺陷，别去「修」它）

本轮曾记下「**改密码对话框点「取消」不生效，需按 Escape 才能关闭**」，
并当成一条待办。**该结论是错的**，那是测量工具踩的坑。

实测复现结论（浏览器 + 源码双向核对）：

- 五种关闭方式**全部正常**：真实鼠标点击、`el.click()`、
  `dispatchEvent(new MouseEvent('click'))`、Escape、点遮罩，
  每种都把 `.ui-dialog-overlay` 从 1 变 0
- 连续 8 轮「登录 → 弹窗 → 点取消」**8/8 通过**
- **Escape 与点取消的结果完全相同**——不存在「只有 Escape 能关」这回事

**根因**：页面上有两个文本为「取消」的按钮——

| 元素 | `data-action` | 可见 | 尺寸 |
| --- | --- | --- | --- |
| 对话框内的取消 | `cancel` | 是 | 52×35 |
| 管理面板的 `#cancelBtn` | `null`（无） | **否** | **0×0** |

按可访问名「取消」查找（无障碍树 / 自动化 `find role button`）会同时命中
那个隐藏的 `#cancelBtn`，点击它毫无反应——**看起来就像取消按钮坏了**。
而 Escape 只绑在对话框的 `dialog` 上、遮罩点击受 `closeOnBackdrop` 控制，
两者都作用于**真实**那个按钮。于是「点不动、Escape 能关」的假象就出来了。

代码侧也对得上，没有可疑之处：`confirmAction` 传 `notice: false`，
所以取消按钮**会**被渲染（`app.js` 里是 `${notice ? '' : '<button … data-action="cancel">'}`）；
关闭判断（`app.js` 约 2298 行）用 `||` 并联，
`closeOnBackdrop` 与取消分支互不影响。

**教训**：这是我本轮第二次犯「没核实就写进文档」——上一次是发布后没同步
交接状态。测量工具报的缺陷要先复现再登记；而**报告里带「我实测是 X」的数字
尤其要自己跑一遍**，因为最可能出错的恰恰是测量本身。

若日后再看到「取消点了没反应」，先确认点的是哪个元素
（`document.querySelectorAll('button')` 里筛 `[data-action="cancel"]` 且
`offsetWidth > 0` 的那个），再谈缺陷。

### 本轮已完成、从清单移除

- ~~两处 CSS 修复的浏览器复测~~ —— 五视口 top/bottom 差值全为 0、
  sticky 按钮 `rect.top` 582.39 → 332.5 且 hit-test 可点。
- ~~横屏 844×390 单选组仍在首屏外~~ —— **未真正解决**，见「补做三项」第 1 项。
  用户选择接受现状（容器可滚、确定按钮可点、分享对话框不受影响）。
- ~~列表行按钮 26px 低于 44px~~ —— 已改卡片网格，四视口实测全部 44px。

### 下一步

本轮（v1.6.3）已完成提交与发布：

- 提交：`28274a3` 代码与测试 / `d94e831` 交接文档 / `472ad84` 版本准备
- `sw.js` 的 `CACHE` 同批升到 `nav-v47`（改了 `public/` 必须同批升）
- 已发布 v1.6.3，Release 与 tag 均已核对，并单独推了分支
  （`release.sh` 只推 tag 不推分支，漏掉这步 `./sylph.sh update` 会停在旧版本）

测试 322 项全绿。下一轮可从上面「本轮未完成」的五条里挑。

## 监控 agent 传输加密：拉取模式强制 HTTPS（本轮完成，未发布）

用户提出：**坚决不能用 http，起码要 https 或加密的 websocket**。核实后确认这是真实的缺口
——`agent/agent.js` 原来只起纯 `http.createServer`，而拉取模式下 Bearer token 是**唯一**的
鉴权凭据，能读到那台机器的 CPU、内存与主机名。走明文等于把这个凭据公开在网络上。

**代码已改完并全量验证，但尚未提交、尚未发布。** 下一位若接手发布，注意这三点：
改了 `public/app.js` 与 `public/admin.css` → **`sw.js` 的 `CACHE` 必须同批升**；
模块端点从 8 条变 9 条、特权路由从 20 处变 21 处（`tests/api-boundary.test.js:160` 与
`tests/session.test.js:631` 的计数断言已更新）。

### 三条已定的决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| TLS 责任 | agent 内置 HTTPS + 自签证书 | `https`/`tls` 是 Node 内置模块，不破 agent「单文件无依赖」的硬约束 |
| 指纹录入 | 只在「检测连通性」里交互式 TOFU | 用户不需要在表单里维护证书字段 |
| 兼容策略 | 硬切，拒 http | 读写两侧都拒，界面给带迁移步骤的错误 |

### 逐文件改动

| 文件 | 改了什么 |
| --- | --- |
| `agent/agent.js` | 新增 `--tls-cert`/`--tls-key`/`--gen-cert`/`--insecure-http`；缺证书**拒绝启动**；`https.createServer`；新增 `certFingerprint()` 与 `generateSelfSignedCert()` 并导出 |
| `lib/monitor.js` | `fetch` 换 `node:https`（为了能传 `ca`）；入口拒 `http:`；证书错误单列；新增 `fetchPeerCert()` |
| `server.js` | 写入只收 `https:`；新增 `POST .../trust-cert` 配对端点；探测端点返回 `need_trust` + 指纹；读接口给 `hasCert`；两条写路径补回 `certPem`/`certFingerprint` |
| `public/app.js` | 校验改 https；探测遇 `need_trust` 弹指纹确认框；部署面板改 6 步；卡片加证书状态徽章 |
| `public/admin.css` | 新增 `.server-item-cert` 徽章样式（浅色 `#a44c46` / 深色 `#e9a69d`，沿用 `.btn-danger` 那一套色值） |
| `agent/README.md` | 快速开始改 4 步、参数表补 4 项、排错表补 4 条、新增「传输为什么必须是 HTTPS」 |

### 实施时推翻计划的一个假设（实测，非推测）

计划里写「存指纹 + `checkServerIdentity` 自定义校验」。**实测（Node 22）走不通**：

```
A rejectUnauthorized:false          → HTTP 200, authorizationError=DEPTH_ZERO_SELF_SIGNED_CERT
B rejectUnauthorized:true + 自定义    → ERR DEPTH_ZERO_SELF_SIGNED_CERT，checkServerIdentity **未被调用**
C ca=<该证书自身>                   → HTTP 200, authorized=true
D 完全默认                          → ERR DEPTH_ZERO_SELF_SIGNED_CERT
```

B 那行是关键：OpenSSL 的链校验先抛错，`checkServerIdentity` **根本不会被调用**。
所以「按指纹比对」这条路在 Node 上不存在，唯一可行的是**把该机器的证书 PEM 作为
可信锚点传进 `ca`**（C 行）。这也是 `fetchRemoteMetrics` 必须从 `fetch` 换成
`node:https` 的原因——内置 fetch 不接受 dispatcher 选项。

顺带修掉一个实测发现的缺陷：`tls.connect` 给 IP 设 `servername` 会触发 Node 的
`DEP0123` 弃用警告（RFC 6066 不允许 IP 作 SNI），已按 `net.isIP()` 分支处理。

### e2e 走通的 7 步（真实 server + 真实 agent）

```
1. http 写入          → 400 + 带迁移步骤的错误
2. https 写入         → 200, id=srv_xxx
3. 探测（未配对）      → status=need_trust, 指纹与 agent 打印的逐字一致
4a. 错误指纹配对       → 409「证书与指纹不一致，未保存」
4b. 正确指纹配对       → 200（大小写与冒号归一化后接受）
5. 真实采集           → online=true, cpu/mem/hostname 均有真实值
6. 读接口投影         → hasCert=true；无 certPem、无 token 字段
7. 换掉 agent 证书     → cached=false 后 certMismatch=true，探测 status=cert_mismatch
```

第 7 步第一次测时看到 `online=true`，原因是命中了聚合缓存（`cached:true`，TTL 跟着
轮询周期走）；等缓存过期重采才拿到 `certMismatch`。**这不是漏检**，但它说明改证书后
最多要等一个 TTL 才反映出来。

### 过程中我自己搞出又修掉的两处

1. **`fetchPeerCert` 改名后漏改 `module.exports`。** 服务端 `require` 得到 `undefined`，
   配对端点真实运行时永远 502。**334 条测试全绿**——因为它们断言的是「服务端调用了
   `fetchPeerCert`」这个源码形状，不是「这个导出真的存在」。
2. **`trust-cert` 路由里残留 `fingerprint: actual`**，那个变量在改名后已不存在，
   真实运行时抛 `ReferenceError` 回 500。`node --check` 不查标识符是否定义。

两处都只有真实 HTTP 走一遍才暴露。已各补一条守卫：导出必须 `typeof === 'function'`
（并反向断言「服务端 import 的每个名字都有导出」），以及成功响应的指纹必须来自
`peer.fingerprint`。

### 我自己写坏又改掉的两条测试

- 先写的负向断言 `doesNotMatch(/parsed\.protocol\s*!==\s*'http:'\s*&&/)` **对变异绿过**：
  它依赖「http 紧跟在 `&&` 后面」这个顺序，变异写成 `!== 'https:' && !== 'http:'`
  就漏了。已改成 `/!==\s*'http:'/` 加一条正面计数（整条路由只允许一个 protocol 放行分支）。
- 计数正则写成 `[a-z]+` **匹配不到 `'https:'`**（协议字符串带冒号），等于恒绿。
  已改成 `[a-z]+:`。这两条都写完才发现「绿」的含义不对——**恒绿的断言比没有断言更糟**。

### 仍未验证 / 未做

- ~~浏览器实测未做~~ —— **已做**，见上一节。三个真实缺陷已修并补了守卫。
- **多视口视觉未做。** 徽章在 1280×577 下量过无溢出，但 390×844 / 360×640 /
  834×1112 / 844×390 四档没走（agent-browser 无法改视口，需 `set device`；
  而本项目此前实测记录：headless 下 `set device` 报 `maxTouchPoints: 0`、
  `(hover: none)` 为 false，依赖粗指针的媒体查询在那里测不了）。
  按本项目自己的判据「能在本地跑出数值的就不写进未验证」，这四条**本轮做不了**。
- **老式 http 配置的编辑路径未走**：写入侧会 400，错误文案带 `--gen-cert` 步骤，
  但「改个名字就存不了」这个具体场景没在浏览器里点过。
- **`--gen-cert` 在 openssl 缺失时的降级提示**未实测（本机有 openssl）。
- **push 模式的传输未加密**（本轮明确不在范围内）：`server.js` 的推送端点注释仍写着
  「裸 HTTP」。改它取决于主服务是否 100% 走 https，而本地 `HTTPS_ENABLED=false`
  的调试路径仍需可用，所以本轮不动。
- `lib/monitor.js` 导出的 `AGENT_PROTOCOL_VERSION` 在 `server.js` 里零引用，
  是既有的死导出（非本轮引入），未处理。

### 实际验证记录

```bash
# 语法检查（派生列表，非硬编码）
for f in $(git ls-files '*.js' | grep -v node_modules); do node --check "$f" || echo "FAIL $f"; done

# 全量回归：337 项全绿（本轮新增 15 条，更新 5 条旧断言）
node --test tests/*.test.js

# 变异验证：6 处破坏各自让对应断言变红
#   去掉 TLS 缺失闸门 / 服务端放行 http / 编辑不补回 certPem
#   / 确认框默认勾选 / 把 actual 塞回去 / 把 fetchPeerFingerprint 包装函数加回来
# 每处破坏后都用 cp 备份还原并 diff 校验

# e2e 环境（树外 /tmp，私有文件泄漏检查 7 项全 absent）
# 服务端端口 4601、agent 端口 4610，测完已停、目录已删
```

**测试数从 322 涨到 339**，其中新增的 17 条都经过变异验证——「新增测试」本身也必须是红的才算有效。

### 浏览器实测（补做，发现 3 个真实缺陷）

用 agent-browser 驱动真实页面（树外环境 + 真实 agent，端口 4701/4710）。**这一轮又抓出 3 个
源码形状断言看不见的缺陷，全部已修**：

1. **指纹核对框里根本没有完整指纹。** 文案写着「请逐字核对」，而勾选项只显示
   `AD:24:26:71…`（前 4 段），实测 `fullFingerprintInDOM = "未找到完整指纹"`。
   **用户被要求执行一个界面上根本做不到的核对。** 已把完整 32 段指纹放进
   dialog 的 `message`（CSS 是 `white-space:pre-line`，换行生效），勾选项不再重复截断。
2. **配对成功后抛 `ReferenceError`。** 写的是 `await onDone()`，而 `onDone` 是
   `showServerDialog` 的参数名；本方法 `renderServerList(host, config)` 根本没有它。
   后果特别恶劣：**服务端已把证书存好，界面却显示「检测失败，请重试」且徽章不刷新**——
   状态不一致，用户会以为没成功而反复重来。已改走 `this.renderModulesEditor()`
   （与「编辑」「删除」同一入口）。
3. **未勾选点确认时静默返回。** 对话框一关，徽章不变、**没有任何文字**，
   「没勾」与「点了取消」表现完全一样，用户会以为证书已配好。已加错误提示。

**实测数值（不是「正常」）**：

| 项 | 实测值 |
| --- | --- |
| 徽章尺寸（三张卡一致） | 64 × 19，`flex-wrap` 未折行 |
| 徽章颜色 | 已确认 `rgb(148,94,74)`（accent）/ 待确认 `rgb(164,76,70)`（警示红） |
| 完整指纹 | 32 段全部在 DOM 内 |
| 确认框勾选项 | 354 × 46（触摸目标达标），默认 `checked=false` |
| 确认框高度 | 355.6px（视口 577px 内），确认按钮 `hitSelf=true`、高 35px |
| 卡片横向溢出 | 徽章与按钮右边界均 −11px（未溢出），无横向滚动 |
| 采集结果 | 3 台 https 机器 `online=true` 且有真实 cpu/mem/hostname；老式 http 那台 `online=false` 且错误文案含迁移指引 |

**已排除的两条误判**：

- 「删除按钮换行到第二行」是**既有布局**，不是本轮徽章挤出来的。证据有二：
  三张卡的 `按钮容器高` 全是 93px、`删除按钮top` 全是 479.1（完全一致），
  且本轮 `git diff public/admin.css` 只新增了 `.server-item-cert` 四条规则，
  未触碰 `.server-item-actions`。
- 换证书后卡片一度仍显示 `online=true`，那是**聚合缓存**（`cached:true`），
  TTL 过期重采后才变 `certMismatch` —— 不是漏检，但说明改证书最多等一个 TTL 才反映。

**又一次踩到 `[\s\S]*?` 没有上界**：新写的断言
`/if (...) \{[\s\S]*?showToast\(/` 在删掉提示后**照样绿**——那个惰性匹配越过了 if 块，
去匹配后面 `trust-cert` 之后另一个分支里的 `showToast`。已改成显式切出 if 块再在块内找，
并加了 `trustBlock.length < 600` 的上界断言。这是本项目第三次因它踩坑。

**本轮我自己搞出又修掉的还有两处测试写法错误**（详见上文「我自己写坏又改掉的两条测试」
与上面的 `[\s\S]*?` 一节）：`[a-z]+` 匹配不到 `'https:'`、切片锚点用了
stripComments 后不存在的注释行。**恒绿的断言比没有断言更糟**，每次新增都要变异验证。

### 仍未验证

- **多视口视觉未做。** 徽章在 1280×577 下量过无溢出，但 390×844 / 360×640 /
  834×1112 / 844×390 四档没走（agent-browser 无法改视口，需 `set device`；
  而本项目此前实测记录：headless 下 `set device` 报 `maxTouchPoints: 0`）。
  按本项目自己的判据「能在本地跑出数值的就不写进未验证」，这四条**应该做但本轮做不了**。
- `--gen-cert` 在 openssl 缺失时的降级提示未实测（本机有 openssl）。
- 老式 http 配置的**编辑路径**未走：写入侧会 400，弹出的错误文案里带了
  `--gen-cert` 步骤，但「改个名字就存不了」这个具体场景没在浏览器里点过。

---

## 监控接入重构：七步手工 → 填 IP → 一条命令（v1.6.5）

### 起因

用户原话：「监控接入方式还是太复杂了…输入名称、IP、选择局域网/公网，先保存。
这时候可以自动检测到主机在线状态…方块上除了在线状态，还要有 agent 部署状态，
如果没有部署，提供部署按钮，点击可以生成一键部署的命令…」

v1.6.4 刚做完的「拉取强制 HTTPS + 指纹配对（TOFU）」，**方向错了**：它把整个
接入流程做成了七步以上、且第一步就要求用户已经能 SSH 上目标机。安全要求是对的
（明文绝不可用），交互是错的。这轮推翻了 TOFU，保留 TLS。

### 三条硬约束（贯穿全程）

1. **绝不用 HTTP。** 拉取只接受 HTTPS，推送也只走 HTTPS。Bearer token 就是那台
   机器的只读监控凭据，明文过网等于公开。
2. **只填名称 + IP。** 「局域网/公网」是用户要自己推导的四种组合；真正决定性
   的事实是「本服务能否直接连到它」，后台直接问这个。
3. **每一个系统能自己生成的步骤都不该让用户填。** 协议前缀、端口、令牌、
   证书——全部由系统生成。

### 做了什么

- **agent 从 Node 换成 Go 静态二进制**（`agent/agent.js` 删除）。选型决定性因素：
  Node 内置 `crypto` 只能解析证书不能签发，v1.6.4 因此被迫调 `openssl` CLI；
  Go 的 `crypto/x509` 原生能签，交叉编译后目标机零依赖——这才是「NAS / 路由器 /
  精简容器上能用」的前提。交叉编译三个架构（amd64/arm64/armv7）+ ELF 自检。
- **TOFU 指纹核对 → 一次性令牌自动注册。** 后台签一枚 15 分钟有效的一次性令牌，
  明文只在响应里出现一次；目标机执行一条命令即可完成「生成自签证书 → 注册 →
  换回长期 token → 写 systemd」。用户只做一次复制粘贴。
- **探测从「401 即视为可达」改为 TCP 三态**（`lib/monitor.js` 的 `probeTcp`）：
  `refused` = 主机活着但没部署、`timeout` = 离线、`open` = 再问 `/health`
  确认那是不是我们的 agent（否则别的程序占端口会被误判）。上一版两者都显示
  「离线」，用户无法判断「是没装 agent」还是「够不着」。
- **后台添加机器只要两个输入框**（名称 + 地址），支持裸 IP（服务端也接受并
  归一化，不是只在前端成立）。
- **部署面板从六步手工说明合并成一条可复制命令**。

### 代码审计修掉的六个问题

在 `cc74c1b` 基线上按 Standards / Spec 两轴并行审，六个问题全部已修，
每处都做了变异验证（破坏 → 确认对应断言变红 → `cp` 备份还原并 `diff` 校验）。

1. **P0 会崩进程**：`lib/monitor.js:222` 调用已删除的 `fetchPeerCert` → 未捕获
   `ReferenceError` **直接杀掉进程**，首页所有机器一起消失。触发场景很常见
   （agent 在跑但注册失败 / 令牌过期）。已改为如实返回 `notEnrolled`，并补了
   **真起一个自签 HTTPS 服务**的用例——形状断言看不见「这个标识符根本不存在」。
2. **P0 静默失败**：`agent/install.sh` push 模式 `ExecStart` 写死 `serve`，
   push 不写 token → 启动即退出 → 脚本只 `warn` 且**返回 0** → 后台显示
   「已就绪」但机器上无进程。已改为按模式分支，`restart` 后 sleep + `is-active`，
   失败 `die`。**静默失败比崩溃更坏**：崩了用户会来问，装上了用户不会。
3. **P1「绑定目标 IP」是假防护**：签发存 `hostOf(server.url)`、注册比
   `hostOf(matched.url)`，同一字段同一函数**恒相等**；且 NAT 下不可行
   （令牌在目标机用，服务端看到的是出口 IP）。已删除字段、注释与 README 声明。
4. **P1 `enrollLimitMap` 从不被清理**：仓库唯一未登记进 60 秒
   `sweepRateLimitStore` 的限流 Map，而 enroll 端点匿名可达、按 IP 计数。
5. **P1 探测轮询是恒等判断**：`res.deployState !== s.deployState` 里 `s` 是启动时
   的陈旧快照 → **每 60 秒必弹一次「有机器的状态变了」**；`pending` 列表同样冻结，
   部署完永远进不了下一轮。已改为可变 `lastSeen` Map（此前该逻辑零测试覆盖）。
6. **P1 `install.sh` 在 macOS 无拦截**：会一路通过检查、下 Linux ELF、写 systemd、
   systemctl 失败，给出一串莫名错误。已在 root 检查**之前**加平台校验。

### 审计后又做的四处（用户拍板）

- **后台卡片拆成两个状态位**：「在线」（`reachable`）+「部署就绪」（`deployState`）。
  用户原话要的是两个，理由是后台是操作台——扫过一列卡片时要能分出「哪几台连不上」
  （查网络）与「哪几台没装」（去部署）这两类待办。**首页仍只保留合并后的一个**
  （用户拍板：首页一个就够）。
- **`hasEnrollToken` 接上消费者**：该字段此前服务端算了、前端零引用，而它的注释
  声称「界面据此决定显示复制命令还是重新生成令牌」——那两个按钮并不存在，
  是一个假承诺。用户选择「有用就留着」，所以接上：它正是「令牌还能不能直接用」
  的判据，卡片据此在「复制命令」与「部署」之间切换。
- **部署按钮留在后台**，不上首页（用户拍板）。
- **修 `agent/README.md` 两处假承诺**：原文写「token 从环境变量读、不落盘」，
  实际为了重启后仍能鉴权**必须落盘**（`/etc/nav-agent/config.json` 与 `env`
  两处，均 0600 root），只是**不写进 systemd unit**。已改为如实描述并说明
  为什么是这个位置。

### 我自己搞出又修掉的三处（本轮）

1. **挪函数时把 2110 行追加到了文件末尾**，`})(window);` 之后堆了一整块孤立代码，
   语法直接崩。从 `scratchpad/app-probe.bak` 恢复（该备份含本轮全部修复），
   改用 `edit_file` 原地编辑，不再用脚本搬位置。
2. **「在线」位恒为「未检测」**（浏览器实测发现，非单测发现）：`renderServerStatusBits`
   调用时不传 probe，而 `reachable` 只存在于 `/probe` 的响应里、不在配置里——
   第一个状态位等于白做。已加 `lastProbe` 缓存，探测与轮询都写入。
   **函数直接调用是对的、渲染是错的**，这类问题只有真跑浏览器才看得见。
3. 顺带：切测试代码时用 `\n        }` 当切片边界，函数体里任何一层缩进 8 的右
   花括号都会提前截断，表现为「第一条断言无故失败」。已改为按「下一个方法定义」
   为界。

### 实际验证记录

```bash
# 全量回归：341 项全绿（本轮新增 2 条、更新计数断言）
node --test tests/*.test.js          # 341 pass / 0 fail

# 语法检查（派生列表，非硬编码）
for f in $(git ls-files '*.js' | grep -v node_modules); do node --check "$f"; done
bash -n agent/install.sh
git diff --check

# 变异验证：4 处破坏各自让对应断言变红，还原后 diff 校验
#   合回一个状态位 / hasEnrollToken 不接上 / 不写 lastProbe 缓存
# 实际：每次 not ok 1、其余 340 pass；cp 还原后 diff 一致

# 浏览器实测（agent-browser，树外临时目录，私有文件已排除）
#   后台模块页三台机器：状态位 = 在线[online] + 未部署[not_deployed]
#   探测 3 次 → lastProbe 缓存 3 条；探测后的引导弹窗正常
#   服务端口 4951、目标端口 4910/4920/4930，测完已停、目录已删
```

### 仍未验证 / 未做

- ⚠️ **`agent/install.sh` 在真 Linux 上从未执行过。** 本机是 macOS，脚本第一步的
  平台校验就拦下了，**pull 与 push 两条路径的真实执行一次都没有**。测试里只有
  源码形状断言。上面第 2 条修复（systemd 子命令）正是在这个从未跑过的路径上，
  形状断言能钉住子命令字符串，但钉不住 systemctl 的真实行为。
  **要签字说「一键部署可用」，需要一台 Linux（容器即可）真跑一遍。**
- **透明代理环境下的探测准确性未确认。** 实测连不可达的公网地址也会触发 TCP
  `connect` 且对端保持连接（中间有代理接管）。「connect 后等 250ms 看对端关不关」
  这个加固**实测无效、已删**。挡住它的是第二道防线 `probeAgentHealth`（问
  `/health` 的形状）。代价：有透明代理时「未部署」的判定会不准。
- **多视口视觉未做**（与上一轮同）：390×844 / 360×640 / 834×1112 / 844×390
  四档没走。本轮新增的第二个状态位可能让窄屏徽章行变挤——**下次改样式前先量一遍**。
- 本轮的仿真样例（`docs/mockup-agent-onboarding.html`）已按用户决定删除、不入库。
  需要追溯视觉决策的话，仿真的结论已经写进本文「做了什么」一节与
  `docs/architecture.md` 的对应段落——那份 HTML 里有些设计已被实现取代
  （TOFU 配对 → 令牌注册；首页双状态位 → 后台双状态位），不宜当现状参考。

---

## v1.6.5 用户实测：NAS 上安装失败（HTTP 400「缺少令牌」）

### 现象

用户在自己的 NAS（x86_64）上跑后台生成的一键命令，失败：

```
[安装] 注册到本服务
  错误：注册失败（HTTP 400）：{"error":"缺少令牌"}
[错误] 注册失败（服务端原文）
```

同时全部中文显示成 `å®è£` 这样的乱码。

### 两个独立问题，根因完全不同

**问题一（真缺陷）：agent 没把 token 放进请求体。**
`agent/main.go` 的 `cmdEnroll` 取到了 token、校验了非空（`args.pick` + 空值检查），
但构造 JSON 时那个 map 里**没有 `"token"` 这个键**。服务端读的是 `body.token`，
于是稳定 400。

这个缺陷能一路漏到用户手上，是因为它同时满足：
- Go 编译通过（编译器不管跨进程契约）
- 341 项单元测试全绿（没有一条真的让两端通话）
- 代码审计没看出来（两边各自都有测试，却没有一个断言
  「agent 发的字段名 == 服务端读的字段名」）

**修复**：`body` 里补上 `"token": token`。

**问题二（不是缺陷）：乱码。**
`å®è£` 正是「安装」的 UTF-8 字节被按 Latin-1 解码。实测确认脚本发出的字节是对的
（`安装` = `e5 ae 89 e8 a3 85`，在 `LC_ALL=C` 与 `LC_ALL=C.UTF-8` 下**完全相同**），
坏的是 NAS 终端的显示。**`LC_ALL` 修不了这个问题**——我先写了一段「强制 UTF-8」
的代码，实测证明无效后删掉了：脚本侧无法修复接收端的解码器。
真要在 NAS 上看清中文，得改那个 Web 终端的编码设置，或改用 SSH 连接。

### 顺带发现并修掉的第三件事：自签服务器无法 enroll

写端到端测试时撞上的：测试用的自签 HTTPS 服务端被 agent 拒绝
（`x509: certificate signed by unknown authority`）。

实测确认 **Go 在 macOS 上不读 `SSL_CERT_FILE` / `SSL_CERT_DIR**（那是 Linux 行为，
macOS 走系统 Keychain），`GODEBUG=x509usefallbackroots=1` 也无效。
所以**自托管用户（用自签证书而非 certbot）必然卡在这一步**——
而这不是「明文不可用」那条安全要求想要的结果，只是让自签部署完全不可用。

修复：agent 新增 `--server-ca <PEM 路径>`，把它追加进 `RootCAs`。
**不用 `InsecureSkipVerify`**——那等于把 HTTPS 悄悄降级成明文，
守卫里明确断言它不出现。`install.sh` 透传该参数，并在注册失败时点名这个原因
（`certificate signed by unknown authority` → 加 `--server-ca`）。

用户不确定自己的服务器用的是哪种证书，所以后台命令生成里留了
`serverIsSelfSigned` 开关（默认不勾，多数人用 certbot）。

### 为此新增的测试

| 测试 | 作用 |
| --- | --- |
| agent 发出的注册请求带 token | 形状：逐字断言请求体里有 `"token": token`，且服务端读 `body.token` |
| enroll 能端到端跑通 | **真 agent 二进制 + 真 HTTPS 服务端**，断言服务端收到的 token 一字不差 |
| 自签服务器要带 --server-ca | 断言走 `RootCAs` 而非 `InsecureSkipVerify`，且 install.sh 透传、失败提示点名原因 |

为此给 agent 加了 `NAV_AGENT_HOME`（配置目录覆盖）。
**这个覆盖最初不存在，于是 enroll 从未在测试里跑过一次**——正是它漏掉上述缺陷的原因。

### 变异验证

三处破坏各自让对应断言变红，还原后 `diff` 一致：
- 从请求体删掉 `"token": token` → 两条守卫红
- 改成 `InsecureSkipVerify: true` → 自签守卫红
- install.sh 不再传 `--server-ca` → 自签守卫红

### 端到端实测数据

```
341 → 344 项测试全绿
四架构构建通过、ELF 自检通过、gofmt 干净

真 agent enroll → 真服务端 enroll 端点：注册成功
服务端配置落盘：certPem ✓ / fingerprint ✓ / deployState=ready ✓
                 一次性令牌已清除 ✓
令牌复用：HTTP 401「部署令牌无效或已被使用」✓
agent 自身：/metrics 无 token → 401；带 token → 真实指标 ✓
服务端采集：解密 token + certPem 作 ca → ok:true + 真实指标 ✓
后台探测：deployState=ready, reachable=true ✓
首页 /api/modules/metrics：本机 + 测试机两张卡片都在线 ✓
```

### 我自己在这个过程中走错的三条路

1. **把 `LC_ALL` 当成乱码的解法**，写了「强制 UTF-8」的代码，实测证明无效后删掉。
   脚本发什么字节都会被同样地误解码——接收端的解码器修不了。
2. **用 `spawnSync`/`execSync` 调 agent**，阻塞了事件循环，同进程的 HTTPS 服务器
   根本来不及响应，表现为「TLS handshake timeout」——一个与被测代码无关的假信号。
   在这个坑里绕了两圈才想到。正确做法是异步 `spawn`。
3. 改 `app.js` 时把「什么也不会发生」写成了 `what also happens`——
   本项目反复记录过的错误类型（中文里混入英文）。读回时发现并改回。

### 仍未验证

- **install.sh 在真 Linux 上仍未执行过。** 本机 macOS 被平台校验第一步拦下。
  本轮修的 `--server-ca` 与端到端测试都在 macOS 上完成，
  Linux 上「自签 vs 系统根证书池」的差异没有真机验证。

---

## 代码审查（基准 v1.6.7）+ 四项拍板修复

两轴并行审（Standards / Spec），子 agent 跑了 31 次工具调用。**两个轴各报了一条
「`sw.js` 的 CACHE 没升」，我实测证伪**：`v1.6.7` 是 `nav-v51`、HEAD 是
`nav-v53`，两版都升了。子 agent 的 `file:line` 与命令输出都可能是错的，逐条
自己复核是必要的。

### 审查发现并已修的

1. **P0：`serverIsSelfSigned` 从未被赋值、也没有任何 UI 能设置它** → 恒为
   `undefined`，于是自签证书的用户拿到的部署/升级命令**必然缺 `--server-ca`**，
   agent 在目标机上报一句指不到真因的
   「certificate signed by unknown authority」。属性名合理、判断有模有样、
   形状断言与全绿测试都看不见「它从来没有被写」。已加配置键
   `security.selfSignedCert` + 后台开关 + init 读取 + 失败回滚。
2. **`server-monitor.js` 里两份 `fmtBytes`** → JS 函数声明提升让后一份覆盖
   前一份，旧的那份成了死代码，而它看起来完全正常、360 项测试全绿、没有任何
   一条断言过具体输出。
3. **`enrollClient` 与 `upgradeHTTPClient` 23 行重复**，且 upgrade 那份
   **丢掉了 enroll 的两条错误提示** → CA 路径写错时静默回落系统根池。已合并。
4. **`currentArch` 的 `if GOARM=="7"` 是死分支**（两个分支返回同值），而且
   `GOARM` 是编译期变量、运行中的二进制根本不带它。已删。
5. **`agentVersion` 是死数据**（本项目注释所描述的假承诺）→ 已接上 UI：后台
   卡片显示「agent X · 本服务 Y [可升级]」。逐段比数字（字符串比较会让
   `1.10.0 < 1.9.0`），拿不到版本一律不提示。
6. **切片无长度上界**（同批断言都守了这条唯独它没有）。
7. **文档债**：载荷字段表缺 `diskUsed`/`diskTotal`、完全没有自升级章节、
   结构表 `agent/` 不含新桩文件、首页状态位措辞仍是旧描述。已补齐。

### 拍板项的处置

- **存储口径开关** —— 这条是我给审查 agent 的 prompt 写错上下文造出来的
  **假发现**。当时问的是「证书」不是「磁盘口径」，磁盘口径写死单一口径是
  有意的。已在汇报里纠正。
- **macOS 升级 404** —— 服务端只发三个 Linux 产物（正确设计），而你只在 NAS
  上部署 agent，实际不影响。按你说的「同意我的看法」保持现状。
- **本机详情页显示地址**（你说的「d 显示」）—— 已加。本机的地址就是浏览器
  所在处（`location.origin`），概览行里也带上了。

### 实测结论：一条「守卫的守卫」不可观测，别再花时间

`methodBodyOf` 曾只按名字匹配，可能切到同名调用处。我为此写了一条自检，
三次尝试都没能让它变红 —— 逐个核实后发现：**对本文件里用到的这几个方法，
「只按名字」与「按定义形态」切出的结果完全相同**（都正确）。

原因：调用处是 `this.isAgentOutdated(s);`，不匹配 `\n        foo(`，
而剥完注释后它前面的 `this.` 让「下一个方法定义」边界恰好落在同一处。

⚠️ **所以那条退化对当前代码不可观测**，任何声称能抓到它的断言都是假的。
我最终把断言改成了一条真正可观测的性质（切片以「名字 + 参数列表 + 花括号」
开头，且含方法体）。下次要改这个辅助函数，别再写「我验证过它能抓到退化」——
那句话在实测里是假的。

另一条同类教训：变异验证里我一度以为守卫漏了「版本比较改回字符串」，
实际是**我的变异无效** —— `String.replace` 只换了第一处，而源文件里有两处
`String(...).split('.').map(Number)`，第二处仍在满足断言。
**变异没变红时，先确认变异真的写进去了。**

367 项测试全绿，新守卫做了变异验证（自签开关不赋值 / 已就绪时无条件返回 /
概览排除本机 / 版本比较改字符串 / 切片锚点指错）。

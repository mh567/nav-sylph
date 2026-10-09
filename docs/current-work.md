# 当前工作交接

核对日期：2026-10-08。本文供更换开发 Agent 或开发软件时快速接续。开始任务后，先运行 `git status --short --branch` 并检查近期提交，再更新本文件。

## 最新一轮：渠道下拉收窄、底部按钮删除、左侧留白收紧（未提交，工作树；基线 `44b2859`）

用户原话：「渠道的下拉框太宽了不够美观。模块底部的加载更早事件好像没什么用。模块时间线左侧时间左侧还有一些空白可以收缩一下。」

### 改法（三处，都先量后改）

1. **下拉宽度按内容收窄**：原 `min-width: 172px` 是硬下限，而菜单里最宽的只是一项「该渠道全部」——短账号名（jack / MikeIsaac）时右边空一大截。改为 `width: max-content` + `min-width: 104px` + `max-width: min(240px, 70vw)`，单项过长用省略号截断。实测 **172 → 104px**。
2. **背景改实底**：原背景是 `--glass-strong`（深色下只有 6% 白），浮在事件列表上时底下的正文会透上来。改用 `--bg-card`——四个主题块里都是**不透明**色（#ffffff / #161616 / #faf8f4 / #3a3530），浅色与深色实测计算值都不带 alpha。（中途我先加过 `backdrop-filter`，实测计算值是 `none` 且背景本就不透明，属死代码，已删。）
3. **底部删掉「加载更早事件」按钮**：滚到底部就会自动加载，按钮与它重复。**键盘路径不能一起删**，所以列表改成**可聚焦的滚动区域**（`tabIndex = 0` + `role="region"` + `aria-label` + `:focus-visible` 轮廓）——聚焦后按方向键 / PageDown 滚动同样触发哨兵（符合 WAI-ARIA 对滚动区域的建议）。底部只剩一行说明。
4. **左侧留白收紧**：实测时间（「15:20」29px 宽）左侧有 **35px** 空白 = 平台卡片 `padding` 13px + 时间轨右对齐的空档。改为：`.module-widget[data-module-id="special-line"] { padding-inline: 9px }`、时间轨 48→**44px**（最宽日期「11月30日」实测需 43px，不能再窄）、节点线 64→**60px**，实测 **35 → 27px**，事件卡相对卡片左边缘 93 → 86px。⚠️ 节点线只跟着缩 4px：既有测试要求未读节点光圈（半径 8.5px）两侧各留 ≥6px，列间距保持不变才同时满足。
5. 缓存 `nav-v92 → nav-v93`。

### 实际验证（隔离夹具，3 个 X 来源 + 75 条事件，1280×577）

- 菜单宽 **104px**、背景 `rgb(250,248,244)`（浅色）/ `rgb(58,53,48)`（深色）均不带 alpha；三个探针 `elementFromPoint` 都命中菜单本身（层级正确）。裁出原分辨率看图确认：菜单外右侧的卡片文字是**菜单外面**的正常内容，不是透底（缩略图上我一度看错，裁图后才确认）。
- 底部：`底部有没有按钮: false`，文案「向下滚动会自动加载更早事件」。
- 键盘路径：`wrap.tabIndex === 0`，`wrap.focus()` 后 `document.activeElement === wrap`，滚到底条数 **30 → 60**（自动加载生效）。
- 几何：时间轨 44px、竖线 60px、时间文字左侧留白 27px。
- 测试：页脚用例改为断言「按钮与那句按钮文案都不在」+ 列表可聚焦/有 region 语义/有焦点轮廓；宽版版式断言从 48px 改为 44px。**全套 561/561 通过**；`node --check` 与 `git diff --check` 通过。

### 验证边界

- 未在用户的 Edge 上复跑；深色只在无头浏览器里核对过计算值，没有逐像素目视。
- ⚠️ **事件右上角「⋯」菜单仍是 `--glass-strong` 半透明**（与已确认的仿真一致），同样存在透底观感问题；本轮没动，若要统一可另开一轮。
- 触屏真机与横向平板未测。

### 下一步

1. 若要发布：按仓库规矩跑两轴审查 + `node --test tests/*.test.js`，再用 `scripts/release.sh`（本请求未授权发布）。
2. 遗留：`PAGE_SIZE_DEFAULT` 是否调小、头像外站依赖、「⋯」菜单的透底、README 顶部旧描述。

## 上一轮：筛选行按渠道分组（功能提交 `99eee4d`，随 **v1.15.3** 发布；基线 `4b17764`）

用户原话：「specialline 顶部 tab 逻辑不合理，如果订阅数量很多，这一行根本展示不过来，现在已经有最右侧的"已归档"按钮被遮盖无法显示了。初步可以把每个渠道如 x/稍后阅读等分类展示，每个渠道只显示一个 tab 按钮，每个按钮悬停可选择子内容如具体的订阅人等。」

### 根因（对照页实测）

筛选行是「一条扁平 chips + `overflow-x: auto` + **隐藏滚动条**」。来源一多，右边的 chip 被推出可视区，而鼠标用户没有可发现的横滑方式（不按 Shift 的滚轮不横滚）——等于够不着。实测：3 个来源正好放下（溢出 0）；**8 个来源**内容宽 827 / 可视 412，溢出 **415px**，「已归档」右边缘超出容器 **414.7px**；**14 个来源**溢出 **954px**。

### 改法（决策表三项均按推荐）

1. **按渠道分组**：渠道按钮（X / 微博 / 稍后阅读）+ 右侧固定的视图组（全部 / 未读 / 已归档）。按钮数只随**渠道数**增长，不再随订阅人数增长。
2. **子菜单**：悬停或**点击**都能展开（触屏与键盘只能靠点，所以点击是主路径），列出「该渠道全部」+ 具体订阅人；选中后按钮文案变成「渠道 · 订阅人」并加圆点高亮，其余渠道保持原样。
3. **放不下就换行**（`flex-wrap: wrap`），不再横向滚动。
4. 只有一个订阅人的渠道（如「稍后阅读」）**直接选中、不给空菜单**。
5. 关闭路径与 ⋯ 菜单同构：再点一次、点别的渠道、选中子项、切视图、重渲染、点空白处、Esc（Esc 把焦点还给该渠道按钮）。
6. ⚠️ **筛选行必须没有 `overflow`**：渠道子菜单是它的绝对定位子节点，一旦这一行成为滚动容器就会被裁掉——这条由测试钉住（规则里不得出现 `overflow`、必须有 `flex-wrap: wrap`）。
7. 缓存 `nav-v91 → nav-v92`。

### 实际验证（隔离夹具，3 个 X 来源 + 稍后阅读，共 12 条事件）

- **1280×577**：按钮为「全部渠道 / X ▾ / 稍后阅读 / 全部 / 未读 / 已归档」，行内 `flex-wrap: wrap`、`scrollWidth === clientWidth`（无横向滚动）；「已归档」右边缘 **0px 超出**，`elementFromPoint` 命中它本身。
- **390×844**：换行成 2 行（行高 103px）、无横向滚动、「已归档」0px 超出且命中 `BUTTON.special-line-chip`。
- 交互：点击展开（`aria-expanded=true`，菜单项 `elementFromPoint` 命中自身）；悬停展开（菜单 1099×255 在视口内）；选中 `spiral_xyz` 后按钮变「● X · spiral_xyz」、列表收窄到 4 条、菜单自动收起；Esc 收起；点空白处收起。
- **测试**：改写既有 chips 断言为分组结构；文档级处理器用例补上渠道菜单的两条路径（点筛选行内不收起、Esc 先收渠道菜单并把焦点还回按钮）；CSS 守卫新增「筛选行不得有 overflow / 必须 flex-wrap: wrap / 子菜单默认收起且悬停与 data-open 都能展开」。**全套 561/561 通过**。
- 中途两次量到「已归档不可点」，都是我自己的调试残留（一次是页面上的 `ui-dialog-overlay`、一次是后台弹窗 `modal-body` 盖着首页）——关掉后复测即命中按钮本身。记在这里：**测量异常先怀疑夹具**。

### 验证边界

- 子菜单是**普通绝对定位**（不是 top-layer popover）：因为筛选行已不再是滚动容器，菜单不会被裁；若将来有人把 `overflow` 加回这一行，隐藏菜单的守卫会先变红。
- 菜单会短暂盖住它右下方的内容（属正常下拉行为），选中或点空白即收起。
- 未在用户的 Edge 上复跑；未测横向平板与触屏真机（触屏用的是同一条 click 路径）。
- 微博来源仍未验证（无凭据）。

### 下一步

1. 本轮已随 **v1.15.3** 发布（功能提交 `99eee4d`）；本地读 `git status` 与 `node --test tests/*.test.js` 复核。
2. 上一轮遗留：`PAGE_SIZE_DEFAULT` 是否调小、头像外站依赖、README 顶部旧描述。
3. 子菜单目前向下弹、会短暂盖住右下内容；如需改成向上弹或右对齐可另行调整。

## 上一轮：订阅时回填窗口 + 老事件补昵称/译文（功能提交 `51a7860`，随 **v1.15.2** 发布；基线 `751b1ab`）

用户原话：「模块未达预期：1.没有翻译 2.没有展示用户名(昵称)（区分 x 的用户名和账号）3.没有懒加载」。随后补充：「我删除了旧的订阅，重新订阅了用户的 x，重新拉取的推文用户头像、名称和中文翻译都能正常显示了。现在仍没有懒加载机制。」

### 根因（两条，都已实测）

1. **译文与昵称只写在「采集时」**：事件入库后不可变（`INSERT OR IGNORE`），水位又已越过旧条目——所以**升级前入库的事件永远补不上**，删来源重建只是绕过。用户重新订阅后 1、2 两条自愈，正好印证。
2. **懒加载不是坏了，是没有可加载的内容**：首次订阅只拉最新一页。实测 `jack` 的 `count=100` 一页里**只有个位数原创**（大量转发被过滤），订阅后库里只有 13 条 —— 30 天窗口内**总共就 13 条原创**，不足一页 30 条，`hasMore` 恒为 false。先前我把一页里「首行的时间」误当成最旧时间，才误以为一页=一天；实际 13 条跨越 2026-09-09 → 2026-10-03。

### 改法

1. **同步后补数据**（`service.enrichSource` + `adapters/x.fetchStatusMeta`）：每轮在**已入库**事件里挑缺作者名/译文的，逐条取回作者名/头像/译文写回 `metadata_json`。上限 30、并发 3。新老条目走同一条路，**不需要删来源重建**。移到 service 后删掉了 adapter 里的 `attachTranslations` 与 `MAX_TRANSLATIONS_PER_SYNC`。
2. **收敛标记 `translationSettled`**：取不到译文（本来就是中文、或 X 没提供）与 404（帖子已删）都记这个标记——否则这些条目**每轮都会被重问一次**。网络/限流类失败不记，留到下轮再试。
3. **订阅时回填窗口**（`service.backfillSource` + `adapters/x.fetchHistory`）：每轮从首页底部游标（或 `settings.history.cursor`）往下翻 20 页，翻到某页最旧一条早于 30 天就 `done`；进度存 `settings.history`，下一轮接着走。已入库条目由数据库去重吸收。
4. **昵称与 @账号始终同时显示**（此前两者相同时会省略 `@账号`，用户要求「区分」）。
5. `sw.js` 缓存 `nav-v90 → nav-v91`。**改 `public/` 必须升缓存名**——本轮验证时正是被 `nav-v90` 的缓存挡住了新模块，清 SW 注册与缓存后才看到改动。

### 实际验证（隔离夹具，真实账号 `jack`）

- 首次订阅：`inserted 5 / backfilled 9 / enriched 14`；再同步一轮后 `settings.history.done = true`，最旧事件落在 30 天边界（2026-09-09）。
- 把夹具重置成「升级前」的样子（`settings` 清空、所有事件 `metadata_json = '{}'`）再同步：`enriched 13` → 13/13 拿到昵称、11/13 拿到译文（其余是中文原文），**无需删来源重建**。
- 懒加载机制在本构建上实测有效：把库补到 73 条后，首屏 30 条 + 哨兵存在，滚到底自动追加到 60 条；到底后哨兵消失、底部显示「已到最早一条 · 仅保留最近 30 天」。
- 清缓存后实测作者行：`name = jack`、`handle = @jack`、头像 `img` 在、`译` 标记在。
- 新增 4 条测试（单条补数据与收敛标记、补旧账且第二轮不重复请求、回填游标推进与 `done`、页脚/筛选行守卫按需更新）。**全套 561/561 通过**；`node --check` 与 `git diff --check` 通过。

### 验证边界

- **`jack` 的 30 天窗口里只有 13 条原创**，所以那台机器上「看不到懒加载」是正确行为（没有下一页），底部会直说。要让它更快出现只能调小页大小（`PAGE_SIZE_DEFAULT` 30 → 例如 12，仍是 1.5 屏以上），这是一个**展示长度 vs 分页可见性**的取舍，本轮未擅自改，留给用户定。
- 回填是**逐轮推进**的：每轮 20 页，大号要若干轮才能铺满 30 天；未做「一轮拉完」。
- 微博来源不做补数据（没有单条翻译接口），卡片仍只显示账号；未测。
- 未在用户的 Edge 上复跑；未验证头像在其网络下能否真的加载出来。

### 下一步

1. 本轮已随 **v1.15.2** 发布（功能提交 `51a7860`）；本地读 `git status` 与 `node --test tests/*.test.js` 复核。
2. 页大小是否调小（让懒加载在更小的窗口里也可见）由用户决定。
3. 头像外站依赖、README 顶部旧描述（同上一轮）仍未处理。

## 上一轮：筛选行裁切修复 + 30 天窗口与懒加载 + X 中文展示（功能提交 `e2d7fbe`，随 **v1.15.1** 发布；基线 `6ce246f`）

用户原话：「bug:1.新版本订阅博主后"全部来源"所在那一行文字被遮挡只剩半个文字了。优化项：1.模块采用队列机制，只保留 30 天内的消息，默认模块展示长度需要增长一些，采用懒加载机制，划到最底部时提示仅保留 30 天。3.x 订阅要像 twitter 一样在模块展示出用户名，并默认将内容翻译为中文，保留查看原文的按钮，点击查看原文可显示原文，如果太长需折叠内容。」

用决策表确认三项（均按选择）：**采集时翻译并缓存**；**显示头像**（外站 `pbs.twimg.com`）；**不收转发**（维持只收原创）。

### bug 的根因（对照页实测，不是推断）

`.special-line-filters` 是卡片（`display:flex;flex-direction:column;max-height`）里**没有 `flex: 0 0 auto` 的可收缩项**，而它同时带 `overflow-x:auto`（另一轴按规范计算为 `auto`）与 `align-items:center`。订阅后列表变长、卡片触顶，筛选行被压扁，文字**上下各裁一半**——正是「只剩半个文字」。对照页实测：修复前筛选行 13.5px、`clientHeight 12 < scrollHeight 23`；修复后 35px、两者相等 34。**修法**：给 `.special-line-filters` / `.special-line-head` / `.special-line-foot` 各加 `flex: 0 0 auto`，并加守卫钉住（删掉即变红）。

### 改法

1. **30 天窗口**：`SOCIAL_RETENTION_DAYS` 90 → 30（清理只按 `occurred_at`，是时间窗口而非条数队列；5000 条硬上限保留为安全阀）。
2. **更长默认展示**：`PAGE_SIZE_DEFAULT` 20 → 30（客户端 `PAGE_SIZE` 同步），卡片 `max-height` `min(62vh,620px)` → `min(74vh,760px)`（窄屏 `min(72vh,640px)` → `min(84vh,780px)`，≤700px 提高触摸目标不变）。
3. **懒加载**：列表底部放哨兵（**必须在滚动容器内部**，observer 的 root 才是 `.special-line-listwrap`），进入视野就 `loadMore()`；保留显式「加载更早事件」按钮作键盘路径，两者共用同一函数并靠 `loadingMore`/`inFlight` 去重。底部文案：有更多→按钮 + 「向下滚动会自动加载更早事件」；到底→「已到最早一条 · 仅保留最近 30 天」。
4. **作者行**：社交事件按推特样式给「头像 + 显示名 + @handle」（显示名与 handle 相同则不重复）；手动文章仍是「稍后阅读」。头像 `loading="lazy"`/`decoding="async"`/`referrerpolicy="no-referrer"`/显式 20×20，失败 `onerror` 摘掉 `img` 露出首字母方块。
5. **默认中文译文**（`adapters/x.js` + `service.js`）：FxEmbed 的 `translation` **只在单条接口上**（实测列表接口即使带 `lang=zh-cn` 也不返回），所以采集后对本轮新入库、非中文的条目**逐条**补取：上限 20 条、并发 3、单条失败只跳过该条。译文与作者信息写进 `metadata_json` 的三个新白名单键（`authorName`/`authorAvatar`/`translation`），**不加表、不加迁移**；`eventView` 透出，前端决定显示哪个。头像 URL 在服务端受主机白名单约束（只 `https:` + `pbs.twimg.com`）。
6. **查看原文 / 长文折叠**：有译文时默认显示中文（meta 行加「译」标记），按钮在「查看原文 / 查看译文」间切换；正文超过约 6 行折叠，渲染后量 `scrollHeight > clientHeight` 才显示「展开全文 / 收起」。两个选择都按事件 id 记在模块级 `Set` 里，轮询重建不丢。

### 实际验证

- **筛选行**：隔离夹具真实页面（订阅一个 X 来源后）实测 `.special-line-filters` 高 35px、`clientHeight 34 = scrollHeight 34`、chip 26px 完整不被裁；对照页另有修复前后的 13.5px vs 35px 数值。
- **真实采集**：走真实登录 → 模块页真实开关启用 → 表单添加 `X · jack` → 同步，`GET /api/timeline/events` 返回的头条含 `authorName: "jack"`、`authorAvatar: https://pbs.twimg.com/...`、`translation: "印度政府正式从 App Store 中移除 Bitchat"`（西班牙语那条也译成中文）。
- **页面渲染**：头像 `img` 存在、「译」标记存在、标题为中文、「查看原文」按钮存在；点它后标题变回 `government of India officially offici…`、按钮变「查看译文」。
- **长文折叠**：夹具里造一条长正文，折叠态 `clientHeight 109 / scrollHeight 381`、按钮「展开全文」可见；点开后 381 = 381、按钮变「收起」。
- **懒加载**：夹具库补足到 66 条 → 首屏 30 条 + 哨兵存在，滚到底自动追加到 60 条；继续滚到底后哨兵消失、底部显示「已到最早一条 · 仅保留最近 30 天」。
- **自动测试**：新增 4 条（作者/译文/上限与失败容忍、恢复备份也要过白名单、筛选行三段的 `flex` 守卫、保留期 30 天边界内外），改写 5 条旧守卫（保留期、页脚文案、metadata 白名单扩展、页脚适用条件）。**全套 559/559 通过**；`node --check`（server、模块、lib/timeline 全部）与 `git diff --check` 通过。
- 缓存 `nav-v89 → nav-v90`。

### 两轴审查发现并已修

1. **恢复备份会绕过 metadata 白名单**（真缺陷）：`repo.importAll` 是原样写库，改一份备份文件就能把任意地址塞进 `authorAvatar`，浏览器随后会去请求它。现在 `service.importTimeline` 在交给 repository **之前**逐条净化 `metadata_json`，并加了一条恢复路径的用例。
2. **「仅保留最近 30 天」说得太宽**：原实现只要 `hasMore === false` 就显示。但「稍后阅读」不参与时限清理、空列表也谈不上「已到最早一条」。现在只在 `events.length && filterSource !== 'manual'` 时显示，并加守卫。
3. **窄屏 44px 漏了新增按钮**：`查看原文 / 展开全文`（`.special-line-ghost`）是 26px，而本模块自己对窄屏的约定是 44px。已并入 `≤700px` 区块。
4. **单段长译文折叠失效**：整段没有换行时，译文全进了标题（`h3` 不 clamp），「太长需折叠」形同虚设。现在与 adapter 的归一化同规则——首行超长就把整段放进正文，交给折叠逻辑。
5. **顺手**：删掉因此变成死代码的 `sourceLabelOf`；修正 `sanitizeMetadata` 的旧注释；CSP 补 `img-src 'self' data: https://pbs.twimg.com`，把头像主机白名单在浏览器侧再兜一道（QR 是 data URL，站内没有其它外站图片）。

审查还指出、本轮**未改**的两点（记在这里）：① 译文取满 20 条时最坏约 7 波 × 12s 会加在本轮 `fetchEvents` 上（有界，但不是小数目）；② 同一事件若内容变了而 `relTime` 与 id 都没变，`viewKey` 不会重绘——事件入库后是不可变的（`INSERT OR IGNORE`），这条目前不可达。

### 验证边界

- 未在用户的 Edge 上复跑；浏览器验证用的是本机隔离夹具与 headless Chrome。
- 真实翻译只覆盖 `jack` 一个账号的一轮采集（含一条西班牙语）；未测翻译在长 note tweet、含 CJK 混排、限流下的表现（那些只有单元测试）。
- 头像真实加载只在夹具里确认 `img` 元素与 `pbs.twimg.com` 地址存在；**未确认在用户网络下能否加载出来**（国内访问该域的实际成功率未知），失败回退路径只由代码保证。
- 未做「真的等一个周期自动跑一次」的观察；周期对调度的影响仍由可控时间与 DB 断言证明。
- `showOriginalIds` / `expandedIds` 是客户端 `Set`，不随分页裁剪（翻页后回到同一事件仍记得选择）；一个会话内不会无限增长，但没有显式上限。

### 下一步

1. 本轮已随 **v1.15.1** 发布（功能提交 `e2d7fbe`）；本地读 `git status` 与 `node --test tests/*.test.js` 复核。
2. 头像依赖外站图片；若用户希望完全自足，可去掉 `authorHTML` 里的 `img` 分支（只留首字母方块），其余不变。
3. README 顶部「卡片头含同步状态与未读数」那句仍与实现不符（v1.14.6 之前遗留），与本轮无关，可另行清理。

## 上一轮：X 订阅改用 FxEmbed + 逐来源监控周期与启停（功能提交 `71bdbae`，随 **v1.15.0** 发布；基线 `813a86e`）

用户原话：「对 special line 模块，x 订阅改为采用 FxEmbed JSON API 来实现，输入用户名即可监控，如需配置监控周期可在后台配置。对每个添加的订阅来源均可设置启用或停止。」

用决策表确认两项（均取推荐）：**周期按来源独立设置**（1/5/15/30/60 分钟，新来源默认 5 分钟）；**停止只关自动采集，仍可「立即同步」手动拉一次，且不会因此重新启用**。

### 改法

1. **X adapter 换 FxEmbed**（`lib/timeline/adapters/x.js`）：固定 `api.fxtwitter.com/2/profile/{handle}` 与 `/statuses`，不再需要 Bearer Token、不再缓存 userId。用户名校验后 `encodeURIComponent`；有界 `getJson`（2 MiB 流式上限、12 秒超时、拒绝重定向）。水位改用最高推文 ID 作字符串/BigInt 比较；只摄入原创（过滤 `replying_to`/`reposted_by`/他人作者），但**被过滤的有效 status 也推进水位**；用「空 results + 无 bottom cursor + 资料复核」区分上游两种 404。
2. **凭据变成 provider 能力**：`requiresCredentials` / `defaultSyncIntervalMs` / `syncIntervalsMs` 随 `selectableProviders()` 下发；`createSource`/`testSource`/`syncSource` 只对需要凭据的 adapter 解密；X 不读旧密文、不存新 token；`sourceView()` 的 pending/expired 判定同样受约束。
3. **逐来源周期**：`syncIntervalMs` 走 POST/PUT→service→DB→响应→调度；非法值 400，缺席保留；改周期以 `lastAttemptAt` 为基准重算 `nextSyncAt`（从未尝试过则保持到期），**重新授权立刻排一次**且不被同一次提交里的周期字段挤掉。
4. **启停语义**：`enabled` 只接受布尔；停止只阻止新的自动采集，保留历史/已读/归档；`{ force: true }` 的手动同步仍可用且不重新启用。
5. **后台界面**（`public/modules/special-line.js`、`public/admin.css`）：X 表单只留用户名与周期，微博才出现 Access Token；每行新增「编辑」（账号只读、可改周期），显示「每 N 分钟 · 自动监控已启用/已停止」；动作改「停止监控/启用监控」；失败保留输入与列表、busy 防重复点击；按钮 44px。`sw.js` 缓存 `nav-v88 → nav-v89`。

### 实际验证

- 接口核实：官方文档 `/api/introduction/` 与运行时 OpenAPI `/2/openapi.json` 确认 `/2/profile/{handle}/statuses` 存在且无需凭据；**本机 Node 进程真连**该端点拿到真实动态（`count=2` 实测返回不止 2 条且含回复/转发，故不能把参数当边界）。
- 隔离夹具（本机临时目录，无任何私人文件）：真实浏览器走「登录 → 模块页真实开关启用 Special Line → 展开配置 → 添加 X · jack → 提交」。请求体 `{providerType,externalKey:jack,syncIntervalMs:300000}`，行显示「每 5 分钟 · 自动监控已启用」，无未配置凭据。
- 「立即同步」真实采集：`fetched 5 / inserted 5`；直接读 SQLite 确认 5 条事件（author `@jack`、原文链接 `x.com/jack/status/<id>`、毫秒时间）与水位 `2108326299731378630`。
- 「编辑周期」提交 `{"syncIntervalMs":900000}`（**不含 externalKey**），行读回「每 15 分钟」，DB `sync_interval_ms=900000` 且 `next_sync_at = last_attempt_at + 900000`。
- 「停止监控」后手动同步仍返回 `ok:true`，`enabled` 仍为 `false`，状态显示「已暂停」、动作变「启用监控」。
- 脚本探针：无 Authorization 头、重复同步 `inserted 0`、来源带无法解密的旧凭据仍能采集、导出→恢复后 `enabled`/`syncIntervalMs` 原样保留。
- 新增/扩展测试：FxEmbed 校验与分页、404 双义、超大 JSON 截停、真实路由→服务→DB 的周期/启停/调度、重新授权立即到期、后台渲染函数真执行（X 无 token 字段、微博无 1 分钟档、行状态文案）。**全套 556/556 通过**；`node --check`（server、模块、lib/timeline 全部）与 `git diff --check` 通过。两轴审查已跑，发现的问题逐条复现：改周期分支顺序、重新授权被周期分支推后、周期文案对微博含非法档位、水位判定 `ids.length > 1` 会误报覆盖不全——**四处已修并补测试**。

### 验证边界

- 未在**用户的 Edge** 上复跑；浏览器验证用的是本机隔离夹具与 headless Chrome。
- 只对 `jack` 一个账号做过真实采集；未覆盖私密/封禁账号、限流的真实响应（这些只有 fixture）。
- 未做真实「等到下一个周期自动跑一次」的等待观察（周期对调度的影响由可控时间与 DB 断言证明）。
- 键盘焦点在「停止/立即同步」后因重渲染回到 body（既有行为，非本轮引入），未改。

### 下一步

1. 本轮已随 **v1.15.0** 发布（功能提交 `71bdbae`）；本地读 `git status` 与 `node --test tests/*.test.js` 复核。
2. README 顶部「卡片头含同步状态与未读数」一句仍是 v1.14.6 之前的旧描述，与本轮无关，可另行清理。
3. `PUT` 改 `externalKey` 不会重置 `syncCursor`（换号后旧水位可能跳过早帖）——既有问题，本轮未动（新 UI 的编辑态账号只读，常规路径不可达）。
4. `public/modules/special-line.js` 的键盘焦点在「停止 / 立即同步」后因整块重渲染回到 body（既有行为，非本轮引入），如需可另作改进。

## 上一轮：时间线卡片瘦身 + 保存弹窗改平台那套 + 只填链接自动解析（修复提交 `c44ba87`/`f24385a`/`aeef2e0`，版本账 `1365d42`，已发布 **v1.14.6**）

用户原话：「1. "动态 · 稍后阅读 / 已同步 / 未读 1" 这些描述不用保留了，顶部只保留最新同步时间就行了，另外模块底部的更新时间和条数也没必要保留。 2. 点击保存按钮是新增稍后阅读的链接，弹窗位置不对，应该不加遮罩居中，和其他设置弹窗一样 3. 添加稍后阅读的链接时，只需填链接就行，标题或者说明选填，链接填完添加后自动解析摘要进行展示」

三处与现状不符的地方，已用决策表确认（三项都取推荐）：①「同步中 / 同步失败·重试」是**带动作**的临时态，保留；②「不加遮罩」与「和设置弹窗一样」在现状下冲突（平台弹窗**有**遮罩），按「完全照平台弹窗」实现；③ 抓不到标题时回落用链接当标题并提示。

### 改法

1. **头/底瘦身**：`statusHTML()` 稳态返回空串（删「已同步」），头部去掉「未读 N」与副标题元素，底部只留「加载更早事件」。顺手删掉随之成死代码的 `.special-line-sub`、`.special-line-pill[data-kind="ready"]`、`.special-line-footnote`——**注意 `.special-line-sub` 有两处定义**，第二处藏在窄列媒体块里，只删一处会留下死规则。
2. **保存弹窗**：从原生 `<dialog>` + `showModal()`（自带 58% 黑遮罩）换成 `.ui-dialog-overlay` + `.ui-dialog`，与后台设置弹窗同款；点遮罩或 Esc 关闭。
3. **只填链接**：标题/摘要选填；留空由服务端抓（`lib/timeline/http.js` 的 `fetchPageMeta`/`parsePageMeta`），失败不阻断保存、回落「域名+路径」并回 `titleFromUrl`。`fetchMeta` 可注入，测试不发网络请求。`POST /api/timeline/articles` 改为 async。

### 实际验证

- 真实浏览器（隔离夹具，已加载 `styles.css` + `admin.css`）：`headText = "Special Line 00:16 同步 ↻ ＋ 保存"`（无副标题/无「已同步」/无未读）；`hasSub/hasReadyPill/hasUnreadPill` 均 false；`footText` 为空、`hasFootnote` false。
- 弹窗：`.ui-dialog-overlay` 存在且 `position: fixed`、背景 `rgba(25,21,18,0.44)`（平台遮罩）、**X/Y 双向居中**；标题「保存到稍后阅读」、URL 必填、标题非必填、提交按钮「保存」；Esc 关闭。
- ⚠️ **未加载 admin.css 时弹窗是未样式化的**（`position: static`、背景透明）——因为这两个类定义在 admin.css，而首页异步加载它。这是本轮引入的新依赖，已记在架构文档里。
- 新增 4 条守卫（解析函数单测三种情形；顶部/底部旧描述不得回来；弹窗用平台那套且标题非必填；底部件），**六项变异全部变红**且逐字节还原。
- 全套 **546/546**；缓存 `nav-v87 → nav-v88`。

### 验证边界

- **未在真实网页上验证抓取**（`fetchPageMeta` 只走单测与注入桩，没对真实站点发过请求）；也未在用户的 Edge 上复跑。
- 「只填链接」只验证到「回落用链接当标题」这条路径；og/twitter 元数据的真实命中率未测。
- 夹具为临时草稿、未入库。

### 下一步

1. 检查 `git status --short --branch` 与本段 diff。
2. 本轮已随 **v1.14.6** 发布（版本账提交 `1365d42`，tag `v1.14.6`，Release 已建）；`main` 已推送。
3. 两轴审查都已跑：规范轴抓到**重定向 SSRF**（`redirect:'follow'` 能走到 `127.0.0.1`／云元数据，`safeHttpUrl` 只管原始 URL）与三处死代码，已修；需求轴抓到 **`titleFromUrl` 读错字段**（服务端挂在 `event` 上，客户端读 `data.` → 提示永远不出现），已修并加守卫。
4. **已发布产物的核对**：三处版本账 1.14.6；`CACHE = 'nav-v88'`；模块内 `popover="manual"`/`showPopover()`/`ClassName = 'ui-dialog-overlay'`/`data.event.titleFromUrl` 均在；`lib/timeline/http.js` 含 `isPrivateHost` 最终 URL 校验；未夹带私有文件；`agent/dist/` 只有三个 Linux 二进制。

## 上一轮：Special Line 操作菜单的交互整体返工（位置、外部点击、Esc）（修复提交 `2d23500`，版本账 `d0bc8ca`，已发布 **v1.14.5**）

用户原话：「可是现在弹出来的位置又很奇怪，点击空白处也不会消失，全面审查这部分的交互」

### 审查结论（逐条实测，隔离夹具 + 真实模块与样式）

| # | 现象 | 测量 | 定性 |
|---|---|---|---|
| 1 | 位置变怪 | 1280×400：`inlineTop=-40px`，菜单顶离按钮底 **66px**（自然位置应贴 4px） | **上一轮「夹进容器」的副作用** |
| 2 | 点空白不关 | 两个视口均 `closedByOutsideClick=false` | 缺陷（从来如此） |
| 3 | Esc 不关 | `closedByEscape=false` | 缺陷（从来如此） |
| 4 | 菜单被裁 | 列表矮时上翻越顶边被 `overflow` 裁（v1.14.4 已修，但用的是有副作用的夹取） | 缺陷（已换机制） |

关闭路径原先只有四条：再点一次 ⋯、点别的 ⋯、切筛选、重渲染。

### 改法

把菜单从「往容器里塞」改为**放进 top layer**：`.special-line-actions` 加 `popover="manual"`，打开时
`showPopover()`——任何祖先的 `overflow` 都裁不到它，于是**恢复「紧贴按钮」的自然位置**。top layer 的
包含块是**视口**（UA 还带 `inset:0` + `margin:auto`），所以坐标由 JS 显式给：贴按钮下方、放不下翻上去、
最后按视口夹取。关闭路径补齐到**六条**，新增 **点空白处**（`document` 的 `pointerdown` 捕获阶段，点在
`.special-line-tools` 内不关）与 **Esc**（`document` 的 `keydown`）。不支持 popover 的浏览器走回退分支
（保留上翻 + 夹取）。抬升类 `is-menu-open` 保留给回退路径。

### 实际验证（修复后实测）

- 位置：两个视口 `gapButtonToMenu=4`、`menuAwayFromButton=false`——菜单紧贴按钮。
- 外部点击 `closedByOutsideClick=true`；Esc `closedByEscapeOnly=true`（单独一次只按 Esc 的测量）。
- top layer 确实生效：1280×400 下菜单底 262 > 列表底 249（越过 13px），按钮中心 `elementFromPoint` 仍命中自身、且命中元素位于 `[popover]` 内。
- 参数扫描（⋯ 完整可见的条目 × 3 滚动位置）：1280×400 与 1440×360 均 **0 失败**。
- 新增两条守卫：**执行真实的 `adjustMenu`**（popover 桩：打开 `showPopover`、关闭 `hidePopover`）与 **执行 `onDocPointerDown` / `onDocKeyDown`**（点内部不关、点外部关、非 Esc 键不关、Esc 关），另加接线断言。
- **八项变异全部变红**且逐字节还原。`public/sw.js` 缓存 `nav-v86 → nav-v87`。全套 **543/543**。

### 验证边界

仍在隔离夹具中测得，未在用户的 Edge 上直接复跑（无该环境）。夹具为临时草稿、未入库。
**测「点空白处」时必须先派发 `pointerdown` 再 `click`**——处理器挂在 `pointerdown` 上，只合成 `click`
会误报为「不关」（本轮的第一次探针就是这么错的，已在夹具注释里记下）。「列表比菜单还矮」的极端情形
在支持 popover 的浏览器里已不再有问题（top layer 不裁剪），但回退路径仍会遇到。

### 下一步

1. 检查 `git status --short --branch` 与本段 diff。
2. 本轮已随 **v1.14.5** 发布（版本账提交 `d0bc8ca`，tag `v1.14.5`，Release 已建）；`main` 已推送。发布方式：`scripts/release.sh` 打包并建 Release，随后单独 `git push origin main`（脚本只推 tag）。
3. **已发布产物的核对**（下载 `nav-sylph-v1.14.5.tar.gz` 解包后实测）：三处版本账均为 1.14.5；`public/sw.js` 的 `CACHE = 'nav-v87'`；`public/modules/special-line.js` 含 `popover="manual"` 标记、`menu.showPopover()`、`function hideMenuPopover(`、`document.addEventListener('pointerdown', onDocPointerDown, true)` 与 `document.addEventListener('keydown', onDocKeyDown)`；前几轮的修复同样在产物内；未夹带 `.modules.json`、`.admin-password.json`、`.webdav-config.json`、`config.json`、`favorites.json`、`nav-sylph.db`、`server-config/config.json`、`.env`；`agent/dist/` 只有三个 Linux 二进制，无 darwin。sha256 `ca374747…d8d763`。

## 上一轮：Special Line 菜单上翻越出容器顶边被筛选行遮挡（修复提交 `54ad060`，版本账 `295d290`，已发布 **v1.14.4**）

用户原话：「我用的 edge 浏览器 154.0.4258.62版本，点击事件右上角菜单依然会被"全部/未读/已归档"所在的那行遮挡住」

### 先纠正上一轮的判断

上一轮把原因判为「用户的浏览器不支持 `:has()`」。**这条判断是错的**：Edge 154 一定支持 `:has()`。
用户给出的浏览器与症状（遮挡者是筛选行，不是下一张卡片）指向的是另一层机制，与抬升方式无关。

### 根因

`.special-line-listwrap` 是 `overflow: auto` 的滚动容器（卡片 `max-height: min(62vh,620px)`）。
`adjustMenu` 只在菜单会越出**底边**时把它上翻（`.is-up`），**从不检查顶边**。列表很矮时
（窗口不高、62vh 被压小），上翻后的菜单会越出容器的**顶边** → 被 `overflow` 裁掉；
而容器顶边之上正是筛选行所在处，于是看起来就是「被『全部/未读/已归档』那行遮挡」。

实测（隔离夹具，真实模块输出 + 真实样式，扫描「⋯ 完整可见」的条目 × 3 个滚动位置 × 4 个视口）：

| 视口 | 列表高 | 失败 |
|---|---|---|
| 1280×400 | 131px | index 3：`isUp=true`、菜单 `[77,147]` 越出列表顶 `118`，命中 `NAV.special-line-filters` |
| 1440×360 | 107px | index 0/3/6：越顶，命中卡片头按钮 |
| 1440×900 / 1280×700 / 1440×520 | 430/310/203px | 0 |

即：**列表高 < 约 2×菜单高**时必然发生；正常高度的列表不触发（这也是前两轮都没抓到的原因）。

### 改法

`adjustMenu` 在翻完之后再量一次最终位置：只要越出上或下边界，就把菜单**夹回容器内**
（inline `top` + 清 `bottom`）。夹取后菜单可能压住本条目的正文，但完整可见、点得到。
不移动 DOM（保留点击委托），不清除既有的 `.is-up` 与抬升类逻辑。

### 实际验证

- 同一扫描在 1280×400 与 1440×360 由「3 处 + 2 处失败」变为 **0 失败**；1440×900 / 1280×700 仍为 0。
- 守卫**执行真实的 `adjustMenu`**：新增夹取用例（容器 100..200、上翻后菜单 60..130 → 断言写回 `top: 14px`、`bottom: auto`），并保留加类/摘类/上翻/收起的断言。
- 五项变异（去掉加类、CSS 规则失效、收起时不摘类、无条件加类、去掉夹取兜底）全部变红且逐字节还原。
- `public/sw.js` 缓存 `nav-v85 → nav-v86`。全套 `node --test tests/*.test.js` **541/541**。

### 验证边界

仍在隔离夹具中测得，未在用户的 Edge 上直接复跑（无该环境）。夹具为临时草稿、未入库。
扫描覆盖 4 个视口 × 3 个滚动位置 × 每个可见条目；**「列表比菜单还矮」的极端情形未覆盖**
（那种情况夹取也无处可放，会退回被裁）。

### 下一步

1. 检查 `git status --short --branch` 与本段 diff。
2. 本轮已随 **v1.14.4** 发布（版本账提交 `295d290`，tag `v1.14.4`，Release 已建）；`main` 已推送。发布方式：`scripts/release.sh` 打包并建 Release，随后单独 `git push origin main`（脚本只推 tag）。
3. **已发布产物的核对**（下载 `nav-sylph-v1.14.4.tar.gz` 解包后实测）：三处版本账均为 1.14.4；`public/sw.js` 的 `CACHE = 'nav-v86'`；`public/modules/special-line.js` 含 `const MENU_EDGE = 4;`、夹取分支 `menuRect.top < wrap.top + MENU_EDGE`、`closeMenus` 里的 `m.style.top = ''` 与 `remove('is-menu-open')`；前几轮的修复（`:has()` 替换、筛选过渡/失败回滚、后台开关 label）同样在产物内；未夹带 `.modules.json`、`.admin-password.json`、`.webdav-config.json`、`config.json`、`favorites.json`、`nav-sylph.db`、`server-config/config.json`、`.env`；`agent/dist/` 只有三个 Linux 二进制，无 darwin。sha256 `d0a365b4…0f721`。

## 上一轮：Special Line 操作菜单仍被遮挡——`:has()` 在用户浏览器里失效（修复提交 `234f395`，版本账 `acb88e4`，已发布 **v1.14.3**）

用户原话：「点击事件操作的三个点按钮，弹出的取消归档等操作弹框依然会被 specialline 模块本身遮挡」

### 根因

上一轮（已发布的 **v1.14.2**）用 CSS `.special-line-item:has(.special-line-tools[open]) { z-index: 2 }`
抬升「打开菜单的那一行」。这条规则**只在支持 `:has()` 的浏览器里成立**；不支持时整条被忽略，
抬升静默失效，于是**短条目**（手动保存的文章，条目比菜单还矮）的菜单朝下弹进下一张事件卡、
被其盖住——正是用户看到的「被模块本身遮挡」。

### 改法

把抬升从 CSS `:has()` 改为 **JS 加类**：`adjustMenu()` 按 `details.open` 对所在行
`classList.toggle('is-menu-open', details.open)`（开与关都跑一次），`closeMenus()` 收起别的菜单时
一并摘掉对方的类；CSS 只消费 `.special-line-item.is-menu-open { z-index: 2 }`。这样在任何浏览器都成立。
`adjustMenu` 原有的「超出滚动容器底边就 `.is-up` 上翻」行为保留。

### 实际验证

隔离夹具（**临时草稿，未入库**，按仓库惯例一次性验证脚本用完即弃）加载真实 `special-line` 模块输出与真实 `styles.css`（**不压平** `.module-zone` / `.module-widget`
/ `.module-card` 的定位与裁剪），用 `#short` 造短条目、用中和那条规则模拟「抬升失效」：

- 抬升失效时（`:has()` 形态或类被中和）：`itemZ=auto`，菜单按钮中心的 `elementFromPoint` 命中**下一张卡的按钮**——症状复现。
- 抬升生效时（本轮改法）：`itemZ=2`、行上有 `is-menu-open`，两个按钮都命中自身。
- 上一轮夹具之所以漏掉：它把容器定位压平了，且条目都很长（菜单完全落在条目内部，碰不到下一张卡）。

新守卫**执行真实的 `adjustMenu`**（DOM 用桩）：断言打开加类、关闭摘类、超底边仍上翻；并断言 CSS 含
`.special-line-item.is-menu-open` 且**不含** `.special-line-item:has(`。四项变异（去掉加类、CSS 规则失效、
收起时不摘类、无条件加类）各自使该用例变红并逐字节还原。`public/sw.js` 缓存 `nav-v84 → nav-v85`；
全套 `node --test tests/*.test.js` **541/541**。

### 验证边界

仍在隔离夹具中测得，未在用户的实际浏览器与真实后端上复跑；用户的浏览器型号/版本未确认（**推断**为
不支持 `:has()`）。本轮的修法与该推断无关——JS 加类在任何浏览器都成立。若仍能复现，请告知浏览器
（名称与版本），我用同款再量一次。

### 下一步

1. 检查 `git status --short --branch` 与本段 diff。
2. 本轮已随 **v1.14.3** 发布（版本账提交 `acb88e4`，tag `v1.14.3`，Release 已建）；`main` 已推送。发布方式：`scripts/release.sh` 打包并建 Release，随后单独 `git push origin main`（脚本只推 tag）。
3. **已发布产物的核对**（下载 `nav-sylph-v1.14.3.tar.gz` 解包后实测）：三处版本账均为 1.14.3；`public/sw.js` 的 `CACHE = 'nav-v85'`；`public/styles.css` 含 `.special-line-item.is-menu-open { z-index: 2 }` 且**不含** `special-line-item:has(`；`public/modules/special-line.js` 含 `classList.toggle('is-menu-open', details.open)` 与 `closeMenus` 的摘类；前两轮的修复（菜单层级/筛选过渡/失败回滚、后台开关 label）同样在产物内；未夹带 `.modules.json`、`.admin-password.json`、`.webdav-config.json`、`config.json`、`favorites.json`、`nav-sylph.db`、`server-config/config.json`、`.env`；`agent/dist/` 只有三个 Linux 二进制，无 darwin。sha256 `7cc6088b…94f489`。
4. 用户的浏览器型号/版本仍未确认（**推断**为不支持 `:has()`）。若仍能复现，请提供浏览器名称与版本。

## 上一轮：后台模块启停开关点不动（修复提交 `378aa61`，版本账 `b96cff9`，已发布 **v1.14.2**）

用户原话：「后台管理界面各个模块的启停按钮点击不生效了」

### 根因与改法

`e1d1262`（后台模块分区按模块分组，随 **v1.14.0** 发布）重写 `renderModuleBlock` 时把整行的 `<label>`
外壳丢了，开关宿主只剩 `<span class="module-setting-toggle">`。而 `styles.css` 的 `.toggle-switch input`
是 `opacity:0; width:0; height:0`——零尺寸、不可命中；可见的 `.toggle-slider` 是它的**兄弟** `<span>`，
两者没有 label 关联，点滑块等于点什么都没绑的 span。于是**每个**模块的启停都点不动（同一文件另外两个
开关「隐私模式」「信任此设备」都是 `<label>` 包裹，所以只有模块开关整体失效）。改回 `<label>` 宿主，
并在模板里补注说明为什么必须是 label。

为什么回归能悄悄发布：`tests/admin-modules.test.js` 原有的守卫只断言**渲染出的 HTML 含 `data-module-toggle`**
与**handler 源码里出现 `await this.saveModulesConfig({ enabledModules: next })`**。两者都真，而控件不可点
——正是本仓库反复记录的那一类「形状断言放过了不可操作的控件」。

### 实际验证

隔离夹具加载真实 `renderModuleBlock` 输出与真实 `styles.css` / `admin.css`，浏览器命中测试：

- **修复前**：input 命中框 `0×0`、无 label 祖先、滑块中心命中 `SPAN.toggle-slider`；点它 `checked` 不变、`change` 触发 **0** 次（复现用户症状）。
- **修复后**：宿主 `LABEL`、`labelAncestor: true`；点滑块中心 `checked` 由 false → true、`change` 触发 **1** 次。

新增守卫钉「宿主是 label 元素，且输入框与可见滑块落在**同一个** label 内」；两项变异（宿主退回 span、
把 input 挪出 label）各自使该守卫变红，`app.js` 逐字节还原。`public/sw.js` CACHE `nav-v83 → nav-v84`
（`app.js` 属受缓存资源）。全套 `node --test tests/*.test.js` **541/541**。

### 验证边界

命中测试与守卫作用在隔离夹具与渲染出的 HTML 上，**未**在真实后端 + 真实 `.modules.json` 上点一次开关
观察落盘——那会改动用户私有数据，本轮不碰。开关的**落盘**路径已有既有守卫（handler 经 `saveModulesConfig`）；
本轮补的是「控件可被点到」这一层。若你实际点击仍有异常，请说明是哪个模块与浏览器。

### 下一步

1. 检查 `git status --short --branch` 与本段 diff。
2. 本轮已随 **v1.14.2** 发布（版本账提交 `b96cff9`，tag `v1.14.2`，Release 已建）；`main` 已推送。发布方式：`scripts/release.sh` 打包并建 Release，随后单独 `git push origin main`（脚本只推 tag）。
3. **本批发布内容**：后台模块开关回归修复（`378aa61`）与 Special Line 交互修复（`3abf360`，见下一节）一并进入 v1.14.2。`public/` 变更的 SW 缓存为 `nav-v84`。
4. **已发布产物的核对**（下载 `nav-sylph-v1.14.2.tar.gz` 解包后实测）：三处版本账均为 1.14.2；`public/sw.js` 的 `CACHE = 'nav-v84'` 与其注释块首条一致；`public/app.js` 含 1 处 `<label class="module-setting-toggle">` 且不含 span 宿主；`styles.css` 含 `.special-line-item:has(.special-line-tools[open])` 与 `.special-line-listwrap.is-filtering`；`modules/special-line.js` 含筛选过渡分支与失败回滚；未夹带 `.modules.json`、`.admin-password.json`、`.webdav-config.json`、`config.json`、`favorites.json`、`nav-sylph.db`、`server-config/config.json`、`.env`；`agent/dist/` 只有三个 Linux 二进制，无 darwin。sha256 `81521a9b…60a800`。

## 上一轮：Special Line 操作菜单层叠与筛选过渡（修复提交 `3abf360`，随 **v1.14.2** 发布）

用户原话：「special line 目前手动建了一个事件，事件操作那三个点点击时弹出框在上方会被遮挡，修复。鼠标在不同分类如已读未读全部来源稍后阅读等点击切换时不够丝滑顺畅」

### 根因与改法

1. **「⋯」菜单被相邻事件卡盖住**：`.special-line-event:hover` 有 `transform`，从而建立独立 stacking context；菜单的 `z-index:3` 只能在自己的事件卡内部生效，后绘制的下一张事件卡仍可覆盖它。给含有打开菜单的 `.special-line-item` 提升层级（`:has(.special-line-tools[open])`），保留原有 `adjustMenu()` 在列表底部向上翻转的行为；没有为了菜单把它移到 `body` 或更改卡片视觉层级。
2. **筛选切换闪空、不顺**：旧路径先 `events=[]`，同步画骨架/空态，再等待 API；每次点击都会立即销毁正在看的列表。改为筛选请求在途时保留现有事件 DOM、滚动位置与内容，列表轻淡并显示 `aria-busy` + 「正在切换…」状态，数据到达后再一次性替换。若前一请求未完成又点了其它分类，排队只补拉最后一次筛选条件，避免旧响应覆盖最终选择。

### 实际验证

用隔离静态夹具加载真实 `public/modules/special-line.js` 与项目 CSS，`api.get` 返回手写模拟事件、每次延迟 450ms；无后端、无生产 URL、未读取或写入私有配置，**不是实际数据库里的手动事件复现**。

- 手动事件行打开「⋯」后：事件行 `z-index=2`；菜单项中心 `elementFromPoint` 命中真实 `.special-line-action`；菜单边界仍在列表可视裁剪区内。
- 筛选等待中：列表节点对象保持同一个、7 条旧行未被清空、`scrollTop=8` 保留，`aria-busy=true` 并显示「正在切换…」；响应回来后状态清除，筛选结果替换为 4 条。
- 连续点击 X → 稍后阅读：等待期间 DOM 仍保留；网络记录显示第一条请求与最终补发分别带 `source-x`、`manual`，最终选中「稍后阅读」、列表显示该筛选结果，不闪回旧条件。
- 模拟筛选 API 返回 503：保留旧行、显示错误并将 chip 回滚到仍显示的条件；普通同步请求在途时切换「未读」，立刻显示忙碌态，之后按顺序请求原条件与新条件，最终展示新条件结果。
- 浏览器错误列表为空。测试：菜单/筛选定向两条通过；`node --test tests/*.test.js` **540/540** 通过。五项变异（删行层级、恢复筛选清空、禁用 DOM 保留分支、禁用 in-flight 排队、禁用失败回滚）均使对应测试失败且逐字节还原。菜单截图与筛选加载状态截图来自隔离夹具（不含真实用户数据）。

### 验证边界

隔离夹具加载真实模块渲染与样式，以手写事件及模拟 API 测菜单层叠、竞态和 503 恢复；证明通用 DOM/CSS 路径，但**不是用户实际数据库中那条手动事件的复现**，未访问该条目或真实后端，也未重新验证 X / 微博订阅连接。若实际操作仍能复现遮挡，后续需在用户原浏览器与实际条目环境复查；本轮未改持久数据或 API。

### 下一步

1. 检查 `git status --short --branch` 与本段 diff。
2. 本节修复（`3abf360`）已随 **v1.14.2** 发布（与后台模块开关回归修复合并，见上一节）；`public/` 变更的 SW 缓存为 `nav-v83`，v1.14.2 的最终缓存名为 `nav-v84`。

## 上一轮：Special Line 日期栏与轨道分离、压缩留白（修复提交 `ebf9f74`，版本账 `5798bbc`，已发布 **v1.14.1**）

目标：修正日期和时间与时间线节点重叠，减少左侧空白，把宽度还给正文。保留现有日期轨道、事件卡与窄版单列结构，不改首页三列布局或模块数据行为。

根因：宽版日期列宽 84px 且右对齐，轨道却位于列表左侧 80px，普通／未读节点分别从 76／75px 开始，侵入日期文本所在区域；正文起点为 100px。

修正：日期列 48px + 间隔 32px，正文从 80px 开始；轨道和两种节点中心统一为 64px，节点用 `translate(-50%, -50%)` 居中。宽版日期字号由 11px 调到 10px，避免「11月30日」溢出 48px 日期栏。`public/sw.js` 缓存 `nav-v81 → nav-v82`；本次补丁版本为 1.14.1，三处版本账同步更新。

### 实际验证

隔离静态对照页调用 `public/modules/special-line.js` 的真实 `eventHTML`，加载仓库实际样式；示例含「今天」「昨天」「11月30日」、已读／未读节点与长正文。不启动后端，不读取或写入私有配置，不注册 service worker。

浅色与深色分别测量下列五档容器宽度（不是视口宽度）：

| 卡片外宽 | 版式 | 正文卡外宽 | 日期完整显示 | 横向溢出 |
| --- | --- | --- | --- | --- |
| 440px | 两列 | 321px（改前 301px） | 是 | 0px |
| 400px | 两列 | 281px | 是 | 0px |
| 390px | 两列 | 271px | 是 | 0px |
| 360px | 单列 | 297px | 是 | 0px |
| 320px | 单列 | 257px | 是 | 0px |

两套主题的宽版文字与最大未读光圈最小实测间距均为 7.5px，浏览器错误列表为空；已读取浅色、深色截图核对视觉效果。

- `node --test tests/timeline.test.js`：31/31 通过。
- `node --test tests/*.test.js`：538/538 通过，新增一条几何守卫。
- `node --check public/sw.js`、`node --check tests/timeline.test.js`、`node --check tests/fav-tab.test.js` 与 `git diff --check`：通过。
- `node "$COMMANDCODE_SCRATCHPAD/timeline-mutation.cjs"`：恢复旧列宽、轨道侵入日期、删除节点居中、扩大未读光圈、恢复 11px 日期字号，五种变异均使新增用例失败；每次以备份内容恢复并逐字节确认。

### 提交前两轴审查

固定点 `a34ab75`，审查命令为 `git diff a34ab75`（包含未提交工作树差异，不使用会漏掉它的三点比较）。

- 规范轴：发现一个几何守卫盲点，已复现并修正。原守卫只取首个声明，宽版追加大光圈或在居中声明后追加 `transform: none` 时仍通过；现合并基础与宽版规则、读取最后一个同名声明，分别检查普通与未读节点的有效位置与光圈尺寸。
- 需求轴：未发现阻塞问题或范围偏离。保持既有日期轨道与事件卡风格，窄版规则未变；审查自身没有重做浏览器测量，浏览器证据来自上面的实施验证。
- `node "$COMMANDCODE_SCRATCHPAD/release-guard-mutations.cjs" green`：旧守卫确实漏检两种覆盖；修正后 `node "$COMMANDCODE_SCRATCHPAD/release-guard-mutations.cjs" red`：两种均返回预期测试失败，逐字节还原通过。与原五种变异合计七种均能检出。
- 发布预检：工作树仅本轮程序、测试与文档差异；发布脚本复制 `public/`，所以必须检查缓存，本次确认已升至 `nav-v82`，没有发现漏升；私有文件均被忽略，不在复制清单。完整回归重新执行为 538/538 通过。

### 验证边界与下一步

这轮验证仅覆盖真实事件渲染与样式几何，不声称重新验证官方订阅连接、完整登录启用流程或真实手机触摸。没有新增后台服务，也没有修改私有数据。

1. 接续时检查 `git status --short --branch`，并核对本段的发布记录。
2. 如需查看对照页，可运行本会话 scratchpad 中的 `timeline-preview.cjs`，打开生成的 `timeline-preview.html`，切改前／改后、主题和宽度；这些临时文件不进入发布包。
3. 本轮发布与产物核对已完成；后续改动继续以发布版本及实际程序为准，官方订阅连接与真实触摸的验证边界未被本次样式修复消除。

### 发布记录

- 修复提交 `ebf9f74`，版本账 `5798bbc`；当前程序基线为发布 tag `v1.14.1` 所指向的 `5798bbc`。本段文档收尾另行提交，避免修改已发布提交的哈希。
- `bash scripts/release.sh </dev/null`：退出码 0，构建 Linux amd64／arm64／armv7 三种静态 ELF 后打包并创建 Release：https://github.com/mh567/nav-sylph/releases/tag/v1.14.1 。脚本只推 tag，随后 `git push origin main` 推送分支（`a34ab75..5798bbc`）。
- `gh release view v1.14.1 --json url,tagName,isDraft,isPrerelease,assets` 与 `gh api repos/mh567/nav-sylph/releases/latest`：正式发布、非草稿、非预发布，latest 为 `v1.14.1`；`git rev-list -n 1 v1.14.1` 与发布时 HEAD 均为 `5798bbc750493b649e853318cd88007baf7c94f3`。
- `gh release download v1.14.1 --pattern nav-sylph-v1.14.1.tar.gz --dir "$COMMANDCODE_SCRATCHPAD/release-v1.14.1"`：已下载实际附件。先检查 tar 路径与私有文件排除再解包；三处版本均为 1.14.1，CACHE 为 nav-v82，紧凑日期栏规则存在，程序及版本文件与提交内容逐字节一致，agent 目录仅含三种 Linux ELF。
- 包内没有 `.admin-password.json`、`.modules.json`、`.webdav-config.json`、`config.json`、`favorites.json`、`.env` 或数据库。附件 SHA-256：`68f2b3b37193bb431d2623ea179b728ad343ceed30feb184cfd23f885356c474`。
- 发布构建后再执行 `node --test tests/*.test.js`：538/538 通过，0 失败、0 跳过；`git diff --check` 通过。下载解包目录核对后清理；本轮未启动后台服务。

## 上一轮：后台「模块」分区按模块分组 + 平台侧不留模块专属代码（内容提交 `e1d1262`，版本账 `6e31134`，已发布 **v1.14.0**）

用户原话：「后台管理模块页的配置应该按照模块分割，比如监控目标应该和服务器监控和开关放在一起，订阅来源管理应该和 specialline 模块名称和开关放在一起等，现在逻辑混乱」

### 现象 → 根因

原来是一张平铺列表：三条开关行 → Special Line 的订阅来源 → 监控目标 → 自签证书 → 更新周期。三层问题：

1. **两个分组轴打架**：一列是「模块」（开关行），另一堆是「配置区」，同一模块的开关与配置被拆到列表两端（服务器监控的开关在第一行、它的监控目标在最后一块）；
2. **平台 UI 与模块 UI 混在一起**：special-line 的配置走模块钩子，server-monitor 的配置硬写在 app.js 里——屏幕上的顺序是实现的副产物；
3. **平台级设置夹在中间**（自签证书、更新周期），没有任何归属标记。

### 用户拍板的三项

- **版式 C**：每个模块一块；**未启用时配置收起**成一行「未启用，配置先收起来。[展开配置]」。仿真 `docs/mockup-admin-modules.html`（工具条可切 A/B/C、主题、模块状态、宽窄屏）。
- **平台设置**留在模块页**底部单独一块**，标明「不属于任何单个模块」。
- **监控目标整块搬进 `public/modules/server-monitor.js`**，平台侧不留任何模块专属代码。

### 改法

1. **结构**：`renderModuleBlock(def, config)` 一块；块头「名称 + 说明 + 开关」，块内是通用落点 `[data-module-admin]`。折叠判据**不认模块 id**，只看模块有没有声明 `renderAdminSection`。平台级设置进末尾的 `.platform-block`。
2. **契约**：后台钩子从 `{ api }` 扩成**服务包**（`api / config(取值器) / saveConfig / reloadConfig / toast / dialog / confirm / notice / requestStack / refreshAdmin / refreshHome / selfSigned() / version()`）+ 可选的 `onAdminSectionClose()` 生命周期（关面板时逐个通知，取代写死的 `clearPendingProbe`）。
3. **归属**：搬去模块的 19 个函数——服务器列表与状态位、检测、部署面板（含一次性令牌签发与命令拼装）、添加/编辑对话框、显示隐藏、探测定时器与 `lastProbe` 缓存、命令面板。`app.js` 里不再出现它们的名字（有零出现断言）。
4. **写路径**：后台三处（模块开关、显示隐藏、更新周期）收敛为 `saveModulesConfig(patch)` 一处；请求体按服务端形状整份提交，并**原地**更新配置对象（换对象会让各处闭包手里的引用过期）。`saveWidgetLayout()` 有意不并入。

### 真机实测（`/tmp` 的项目副本里跑，端口 4325）

| 验的东西 | 结果 |
| --- | --- |
| 结构 | 三块（服务器监控 / 备忘录 / Special Line，顺序 = `KNOWN_MODULES`）+ 末尾「平台设置」；标题恰好两组（一度重复，已修） |
| 折叠（版式 C） | 关掉 Special Line → 配置收起、**来源行数 0（不拉接口）**；点「展开配置」→ 来源 2 行出现，状态仍是「未启用」 |
| 开关 | 关→toast「已停用」+ 状态文字与配置区同步；开→toast「已启用」；首页卡片跟着变 |
| 服务器卡 | 本机只有「显示/隐藏」；pull 有「检测/部署/编辑/删除」；push 没有「检测」 |
| 检测 | 真实探测，toast 给出「未部署 + 下一步」（服务端 hint 原样透出） |
| 部署 | 面板三步骤、2 个复制按钮；**令牌在面板里只出现 1 次**；自签开关打开后部署与升级命令都带上 `--server-ca`（读的是实时值） |
| 编辑校验 | `http://` 被拒，文案与服务端同一裁决（「必须用 https：token 是那台机器的只读监控凭据…」） |
| 删除 | 二次确认「确定删除「NAS」？」+ 取消/确认删除 |
| 探测定时器 | 面板开→`setInterval` 1 个、关→`clearInterval` 1 个（活跃归 0）、再开→又能起（2 个） |
| 首页 | 4 张卡、指标仍在刷新（29% / 77% / 298.5GB），未受影响 |
| 窄屏 390 | 三块正常、无横向溢出、标签条横滑 |

### 过程中我自己搞出又修掉的三件事

1. **服务包里的 `toast` / `dialog` 写成了裸函数名**——`showToast` / `showUiDialog` 是 App 的**方法**（`this.showToast`），`ReferenceError` 被模块开关处理器的 catch 吞成「保存失败」，表现是「开关拨了没反应、自己弹回去」。**单测全绿是因为它把 `showToast` 当参数注入 vm，恰好替真代码补了作用域**（仓库记过的「桩替真代码补作用域」那一类）。已把 `showToast` 挂在假 app 上、加「必须经 this 调用」的源码断言，并变异证明能红。
2. **`#adminPanelModules` 的静态模板本来就有「模块 / 模块配置独立保存…」**，新内容里又渲染一套 → 屏幕上两组（静态那套已去掉）。
3. **验证服务读了仓库真实的 `.modules.json`**（种子脚本只重定向了数据库/密码/日志，而 `MODULES_FILE = path.join(config.rootDir, '.modules.json')`），于是浏览器实测把用户的真实配置改了（关掉 special-line、加了 2 台演示机器）。已按原状还原（启用列表改回 server-monitor + special-line、删掉那 2 台），后续验证改在 `/tmp` 的**项目副本**里跑（副本内不含任何私有文件，逐项核对过）。

### 测试

- `node --test tests/*.test.js` → **537 全过**（上一轮 528，本轮 +9：新增 `tests/admin-modules.test.js`）。
- 既有 19 条按旧结构切片的断言**重新锚定**（意图不变）：切片助手改成同时支持 4/8 空格缩进与 `function` 前缀，并新增「模块文件里的函数也必须切得出来」的自检；`api-boundary` 的「说明紧贴名称」改切 `renderModuleBlock`；`timeline` 的后台钩子断言改为服务包注入；`login-guard` 的闩锁成组复位把展开状态清理挪到三行之后。
- **变异验证**（各自精确变红）：平台块挪到模块块之前 / 未启用也渲染配置 / 关面板不通知模块 / 平台侧复活一句模块专属标记 / 开关改回自己拼请求体 / 服务包把 config 改成快照 / `toast` 改回裸名。

### 仍未验证（与前几轮同一批）

- X / 微博的真实连通性：本机没有开发者凭据，「测试连接」只跑到固定响应；要在有凭据的机器上点一次。
- 真机触摸：44px 触控下限只量到计算值，没有真手指按过。
- 10 标签页的轮询配额：公式推导 + 单测，未做真实负载。

### 发布记录

- 内容提交 `e1d1262`（代码 + 测试 + 文档 + 仿真稿），版本账 `6e31134`，tag / Release **v1.14.0**：
  https://github.com/mh567/nav-sylph/releases/tag/v1.14.0
- 预检：改动集 ∩ 打包路径 = `public/`（**必须**升 CACHE —— 本轮**已升**到 `nav-v81`，属「确认」而非「抓到漏升」）；工作树无私有文件。
- 产物核对（下载 tarball 后在树外解包）：`version.json` = 1.14.0、`CACHE` = nav-v81、`renderModuleBlock` / `moduleServices` / `saveModulesConfig` 在、**app.js 里六大模块专属标识符一个都没有**、模块文件里有 `renderAdminSection` + `监控目标` + `enroll-token` + `showDeployDialog`、admin.css 有模块块与平台块样式、三条死规则在可执行 CSS 里已无（只剩一句历史注释提到 `navDeployPulse`）、`#serverList + #addServerBtn` 相邻规则与窄屏 44px 规则都还在、四类私有文件未夹带。
- ⚠️ 核对脚本第一版把「CSS 里不得出现 navDeployPulse」写成朴素 grep，被我自己留的那句历史注释判红——**剥注释再查**是同一条纪律的又一次应用（探针的错，不是产物的错）。
- `scripts/release.sh` 只推 tag，分支手工推送（`91761c3..6e31134`）。

## 上一轮：修首屏宽栏判定读不到模块声明（v1.13.4）

用户原话：「首页初次加载时，该模块依然显示不全，需要手动缩窄网页尺寸后再变宽，该模块才会变成正常宽度，分析原因并修复」

### 根因：顺序，不是测量

宽栏判定（要不要给时间线让出宽列）读的是**模块定义**里的 `wideRail`，而定义是模块脚本执行时才 `registerModule` 的，早先只有 `mountModule` 会加载脚本——`syncRail()` 排在 `mountModule` 之前。于是：

- **首屏**第一次判定必然拿到 `undefined` → 判为「不需要宽栏」→ 时间线按普通窄卡出生（实测 210px，容器查询落到窄版）；
- 用户手动缩放窗口 → `resize` 触发第二次判定，此时脚本早已加载、定义已注册 → 才变宽。

挂临时探针（`syncRail` 里记 `performance.now / authenticated / wantsWideRail / appW / content / layout` 到 sessionStorage）复现：首屏 `syncRail` **只被调用过一次**，`wants:false`，而 `appW=1440`、`content=1396` 都正常——所以不是「量错了」，是判定所需的输入那时还不存在。探针读完即摘。

### 改法

`renderModuleZone()` 里先 `const ids = this.enabledModuleIds()`，`await this.preloadModuleDefs(ids)`（新增方法），**再** `syncRail()`。脚本本来就在 `mountModule` 里躲不掉（`loadScript` 按 src 缓存，同一份只下载一次；已注册的定义会被复用），提前加载只是把顺序摆正。**代价**：让位仍发生在挂载与首轮数据之前，右侧那一列会先空着若干帧才出现卡片；判定也因此被模块脚本的下载门控住（总耗时与改前相当，脚本本来就要下）。反过来把让位挪到卡片之后，卡片会先以窄列出生再跳宽，更难看。单个脚本加载失败不抛异常，仍由 `mountModule` 渲染那张卡的错误态。

### 首屏实测（每个视口都做一次全新加载，全程不派发 resize）

| 视口 | rail | 停靠 | 背板 | 时间线 | 版式 |
| --- | --- | --- | --- | --- | --- |
| 1600 | wide | 两侧 | 696 | 440 | 桌面版 |
| 1280 / 1264 | wide | 两侧 | 600 | 400 | 桌面版 |
| 1263 / 1200 / 834 | narrow | 堆叠 | — | 400 | 桌面版 |
| 390 | narrow | 堆叠 | 351 | 351 | 窄版 |

全程无横向溢出。修前同一套测量在 1600 上得到的是 `narrow / 210 / 无变量`。

### 变异验证

| 变异 | 结果 |
| --- | --- |
| 删掉 `preloadModuleDefs`（= 改动前的行为） | 红 |
| 保留 `preloadModuleDefs` 但排到 `syncRail` 之后 | 红 |

还原后与备份逐字节一致。

### 顺带修正一条既有断言的代理指标

`tests/monitor-agent.test.js` 的「modulesError 必须排在判空之前」原本拿 `const ids = this.enabledModuleIds()` 的**声明下标**当代理；本轮把该声明上移（它现在要早于 preload），于是断言对着一份仍然正确的代码报错。承重的事实是「那个会提前 return 的判空分支不能挡在错误分支前面」，已改为直接断言 `if (this.modulesError)` < `if (!ids.length)`。

### 验证

- `node --test tests/*.test.js` → **528 全过**（上一轮 527，本轮 +1：新增首屏顺序的回归用例）。
- `node --check public/app.js`、`node --check public/sw.js`、`git diff --check` 干净。

### 仍未验证（与前几轮同一批）

- X / 微博的真实连通性：本机没有开发者凭据，「测试连接」只跑到固定响应；要在有凭据的机器上点一次。
- 真机触摸：44px 触控下限只量到计算值，没有真手指按过。
- 10 标签页的轮询配额：公式推导 + 单测，未做真实负载。

### 发布记录

- 内容提交 `917a028`（代码 + 测试 + 文档），版本账 `765e914`，tag / Release **v1.13.4**：
  https://github.com/mh567/nav-sylph/releases/tag/v1.13.4
- 预检：改动集 ∩ 打包路径 = `public/app.js` + `public/sw.js` → `CACHE` 已同步升到 `nav-v80`（这次同样是「确认」而非「抓到漏升」）；工作树无私有文件。
- 产物核对（下载 tarball 后在树外解包）：`version.json` = 1.13.4、`CACHE` = nav-v80、`preloadModuleDefs` 在且顺序正确（登录路径里 preload 先于 syncRail）、`railLayoutFor` 与窄屏封顶 400 仍在、无探针残留、四类私有文件未夹带。
- `scripts/release.sh` 只推 tag，分支手工推送（`ca5dc81..765e914`）。

## 上一轮：布局自适应 + 窄屏纵向堆叠 + 补回底部按钮（内容提交 `f9f6077`，版本账 `e7e8ea8`，已发布 **v1.13.3**）

用户原话：「默认PC 等宽布局下该模块宽度太窄，内容显示不全。缩窄一点窗口后，该模块宽度反而变大，最左侧的监控模块会变窄内容排版错乱。应该优化布局显示，宽屏模式下，当屏幕宽度足够时，可保持最佳宽度微调布局位置。当屏幕宽度不够时，若开启该时间线模块，可稍微调整中间导航的宽度，让该模块能正常显示。另外模块的底部以前仿真时候是更多的按钮现在怎么丢失了。移动端也需要适配这种模块的展示，不能简单左右罗列了，可纵向排布」

四个问题都复现了，根因都是「宽度写在 CSS 的 `calc()` 里 + 一个硬阈值」：

### 现象 → 根因

| 现象 | 根因 |
| --- | --- |
| 缩窄窗口后模块**反而变宽** | 阈值悬崖：`content < 1232` 时宽栏关闭，时间线掉到 `clamp(132px, calc((100%-936px)/2-20px), 220px)` = **132px**；再窄一点 `sideDockAvailable` 失败 → 翻成 `below` 横向条，卡片变 **190px**。一缩一涨，方向相反 |
| 模块太窄、**内容显示不全** | 就是上面那个 132px 档 |
| **监控卡被压到 132px、排版错乱** | 宽栏模式的左列写死 `clamp(132px, calc(100% - 936px - 440px), 220px)`，多数宽度下算出来正好是下限 132 |
| 底部**按钮丢失** | 仿真里是居中的「加载更早事件」按钮（`.quiet-button`）+ 一行居中说明；v1.13.1 改版时写成了角落里的下划线小链接 |
| 移动端**左右罗列** | `data-dock="below"` 是一条横向滑条（`display:flex` + 190px 卡 + `scroll-snap`），模块得左右滑才看得见 |

### 改法

1. **三列宽度改由 JS 算**（`app.js` 的 `railLayoutFor(content)` 纯函数 → 写成 `#app` 上的 `--rail-w` / `--side-w` / `--board-max`，CSS 只消费）。分配顺序：时间线先拿上限 440 → 背板拿余量、封顶 936 → 背板不足 600 时按「背板 → 时间线 → 左列」依次让步。这样是**连续单调**的：`content` 变大时 rail 400→440、side 180→220、board 600→936，没有跳变。左列下限从 132 提到 **180**（132px 实测监控卡三行数值挤成一团）。
2. **窄屏 `below` 改纵向堆叠**：`display: grid` + 卡片 `width: min(100%, 400px)` 居中，横滑的 `scroll-snap` 与淡出遮罩去掉（媒体块里那份重复声明一起改，两处说法必须一致）。
3. **底部按仿真还原**：居中的「加载更早事件」按钮 + 一行居中说明；顺带把仿真底部区另外两处状态按钮也还原成真按钮（筛选无结果→「清除筛选」、空状态→实心「＋ 保存文章」），并把下划线小链接那套连同样式删除。
4. **跨界只换位置、不跳宽度**：窄屏封顶取值**等于** `RAIL_MIN`（400）——两边都是 400 时，跨过边界只有「右列 ↔ 导航下方」的位置变化；背板让位的 `margin-left` 补上列间距（`calc(var(--side-w) + 20px)`），否则左列与背板贴在一起（实测左右间距 0 / 40，现为 20 / 20）。

### 实测（视口扫描，含左侧监控卡是否被挤坏）

| 视口 | 停靠 | 左列 | 背板 | 时间线 | 时间线版式 | 左间距 / 右间距 | 监控卡溢出 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2560 / 1920 / 1680 / 1600 / 1440 | outside | 220 | 696 | **440** | 桌面版 | 20 / 20 | 无 |
| 1360 | outside | 220 | 616 | 440 | 桌面版 | 20 / 20 | 无 |
| 1264 | outside | 180 | 600 | **400** | 桌面版 | 20 / 20 | 无 |
| 1263（边界另一侧） | below | （堆叠） | 936 | **400** | 桌面版 | — | 无 |
| 1200 / 1100 / 1024 | below | （堆叠） | 936 | 400 | 桌面版 | — | 无 |
| 834 | below | （堆叠） | 775 | 400 | 桌面版 | — | 无 |
| 390 | below | （堆叠） | 351 | 351 | 窄版 | — | 无 |

边界两侧（1264 / 1263）时间线都是 **400**——这是本轮审查抓出来的第二处跳变（原封顶 560，导致缩 1px 反而变宽）修正后的结果。全程 `documentElement.scrollWidth` 不超视口，窄屏不能横向滚动；390 下四张卡片纵向排开（top 441/607/718/830），模块区 `display: grid`。窄屏（`below`）时 `#app` 的三个宽度变量为 `none`（已清）。

### 本轮自查与审查出的四处

1. **容器查询量的是内容盒，不是外框**。阈值先写 400（= `RAIL_MIN`），实测 1280 视口下卡片 400 却渲染成窄版——卡片有 2×13px 内边距 + 2×1px 边框，实际参与匹配的是 **372px**。改 390 仍不中（同一个原因没算对），最后定 **360**（对应 400px 的卡片的外框）。这条已写进架构文档，免得下次再踩。
2. 扫描脚本第一遍没清 service worker 缓存，量到的还是旧值（老问题，已是第 N 次）；清缓存后复测才拿到真数据。
3. **边界仍有跳变**（由审查指出）：窄屏封顶 560 vs 时间线下限 400，视口 1263↔1264 之间时间线 400↔560、背板 600↔936——方向正是用户抱怨的那个「缩窄反而变宽」，只是发生在模式切换处。改为封顶 == `RAIL_MIN`，并加跨文件断言钉住这个相等关系。
4. **背板让位少算了列间距**（由审查指出）：算式留了 2×20px，定位只给 `--side-w`，实测左右间距 0 / 40；改成 `calc(var(--side-w) + 20px)` 后为 20 / 20。

### 两轴审查（未提交的工作树上跑）

- 规范轴：3 条 P2 + 2 条 P3，全部已修（陈旧的 `wideRailAvailable()` 引用、文档/CHANGELOG 里写错的测试数、仍在描述「横向滚动」的注释、`special-line.js` 里 340 的阈值、`highlights` 里引用了用户的口语原话）。另记录两条不改的观察：`BOARD_MAX = 936` 在生产不可达（已在架构文档写明可达范围 600～696），以及边界处位置仍会变（模式切换本身）。
- 规格轴：7 条要求 5 条满足、1 条部分满足（(b) 单调性——即上面第 3 条）、1 条满足但有一处对齐缺陷（(d) 的列间距——第 4 条）；无范围蔓延。同时确认「底部按钮」仿真里确实只有一个（`加载更早事件`），头部的「↻ 同步」「＋ 保存文章」从来不在底部。

### 变异验证（新断言能不能红）

| 变异 | 结果 |
| --- | --- |
| `railLayoutFor` 退回阈值悬崖（`content<1300` 就 null） | 红（阈值断言） |
| 左列下限退回 132 | 红（单调 + 下限断言） |
| `below` 退回横向滑条 | 红（2 条用例） |
| 底部按钮改回下划线小链接 | 红 |
| `syncRail` 不再写 CSS 变量 | 红 |
| 容器查询阈值改回 400 | 红 |

前五项用 `cp` 备份 + 唯一性校验（锚点出现次数 ≠ 1 就跳过）逐个跑，还原后逐字节比对通过。

### 验证

- `node --test tests/*.test.js` → **527 全过**（HEAD 基线 524，本轮 +3）。新增/改写：`railLayoutFor` 的**执行**测试（逐像素扫 800 档断言单调 + 三个下限 + 三列之和 + 阈值正好落在「三个下限加两个间距」上）、`below` 纵向堆叠与「窄屏封顶 == `RAIL_MIN`」这条跨文件相等、底部按钮与说明、宽栏机制改为断言三个 CSS 变量与 `syncRail` 的顺序/清变量。
- `node --check public/app.js public/modules/special-line.js public/sw.js`、`git diff --check` → 均干净。
- 浏览器：上面的视口扫描表 + 1600（宽栏）/1200（堆叠）/390（手机）三张截图核对；窄屏拖拽与桌面拖拽仍正常（上一轮的用例保留）。

### 仍未验证

同前（X / 微博真实连通需你的凭据；真机触摸；10 标签页轮询配额是推导 + 单测）。

### 发布记录

- 内容提交 `f9f6077`（代码 + 测试 + 文档），版本账 `e7e8ea8`，tag / Release **v1.13.3**：
  https://github.com/mh567/nav-sylph/releases/tag/v1.13.3
- 发布前预检：工作树干净；改动集 ∩ 发布脚本打包路径 = `public/`（于是必须升 `CACHE` —— 本轮**已升**到 `nav-v79`，这次是「确认」而不是「抓到漏升」）；`.admin-password.json` / `.modules.json` 由 `.gitignore:13/19` 挡住，均不在 `cp` 清单里。
- 产物逐项核对（下载 tarball 后在工作树之外解包）：`version.json` = 1.13.3、`CACHE` = nav-v79、`railLayoutFor` 在、三个 CSS 变量与 `removeProperty` 在、`margin-left: calc(var(--side-w …) + 20px)` 在、窄屏 `display: grid` 与 `min(100%, 400px)` 在、容器阈值 360（且 340 / 399.98 已无）、横滑条已无、底部按钮在、`linkbtn` 残留已无；四类私有文件一律未夹带。
- `scripts/release.sh` 只推 tag，分支由本次手工推送（`2e32caa..e7e8ea8`）。

## 上一轮：Special Line 恢复仿真形态 + 平台宽栏机制（内容提交 `ef4c895`，版本账 `8816201`，已发布 **v1.13.2**）

用户原话：「不对，现在的界面和当时的仿真界面或者之前那版弹窗时间线比，界面完全变了和当时设计不一样」。

也就是 v1.13.1 那版把**视觉语言**换掉了（紧凑列表 + 原生下拉），而不是把已确认的设计搬到首页右侧。本轮按仿真样例还原形态，并为此给平台加了宽栏机制。

### 先做仿真对比，再动手

按「改动前先给仿真样例」的惯例，先做了 `docs/mockup-special-line-inline.html`（可切版式 A/B、视口 1440/1280/390、主题、内容态），把两种可行版式摆出来：

- **A**：背板让位（右侧固定 420px）→ 能完整还原仿真的桌面版（左侧日期轨道 + 事件卡）
- **B**：背板不动（右侧仍 210px）→ 只能走窄版

用户选了 **A**。

### 改了什么

1. **形态回到仿真**：左侧日期轨道 + 贯穿节点线（画在**列表**上，逐段画会断开）+ 事件卡（边框 / 玻璃底 / 投影 / 悬停抬起）+ 来源标记（角标 + 名称 + 类型）+ chips 筛选 + 「⋯」菜单。时间在桌面版只出现在轨道上，卡内不重复（`.special-line-stamp` 在宽列里隐藏）。
2. **两套版式由容器查询切换**：卡片 `container-type: inline-size`，`@container (min-width: 340px)` 是桌面版，`(max-width: 339.98px)` 是仿真 ≤700px 那套。同一份 DOM，拖到左列或窗口变窄都不需要重渲染。窄版里 `<time>` 必须显式 `display: block`——行内元素的 padding 盒会压到下面那张卡的上沿。
3. **平台新增宽栏机制**：模块可声明 `wideRail`，平台据此让背板让位（`#app[data-rail="wide"]`）。判定 `content >= 132+20+640+20+420`；`syncRail()` 必须排在 `sideDockAvailable()` **之前**（后者读背板实际宽度）。
4. **「⋯」菜单的裁切**：列表是滚动容器，菜单朝下弹到容器外会被 `overflow` 裁掉 → 打开后量一次、超出底边加 `.is-up` 往上弹；打开一个菜单时收起别的。

### 本轮自查出的三个问题（都是我引入的）

1. **背板压在时间线下面 124px**。宽栏模式只写了「背板收窄」的宽度公式，忘了 `.backboard` 默认是 `margin: 0 auto` **居中**的——不收掉居中，收窄后的背板右半边正好落在右侧那 420px 的列下面（实测 `card.left` 1078 < `board.right` 1202）。修法 `margin-left: 152px; margin-right: auto`（152 = 左侧那一列 132 + 20 间距，与宽度公式里的 592 = 152+420+20 对得上）。**这条只看 diff 看不出来**，是截图里一眼看出来的。
2. **窄屏触控目标退回 34px**：重写样式时把 44px 的下限丢了（仿真里 `.filter-button` / `.timeline-action` / `.event-tools summary` 都是 44px）。已改回。
3. **宽栏判定「没生效」过一次**：`set viewport` 之后 `rail` 仍是 narrow，追下去发现是**仿真工具没投递 resize 事件**（手动 `dispatchEvent(new Event('resize'))` 立刻正确翻成 wide）。产品路径是加载时 `renderModuleZone → syncRail()` 就会算，不受影响；记下来免得下次把它当产品缺陷。

另外，本轮改完样式后第一次测出来的仍是**旧值**——老问题：service worker 缓存。按既有纪律每次测量前都做「注销 SW + 清所有 caches + 带时间戳的 query」，但当时是改完立刻测、没重做这一步，白测了一轮。

### 验证

- `node --test tests/*.test.js` → **524 全过**。新增/改写三条守卫：内联形态与仿真一致（轨道 / 事件卡 / ⋯ / chips、菜单翻转）、平台宽栏机制（判定 + **顺序** + 登出复位 + 三处 CSS 含背板靠左）、两套版式的容器查询。
- 浏览器（每次测量前注销 SW + 清 caches）：
  - **1600×1000**：`rail=wide`、`dock=outside`；背板 804 靠左（左侧卡片 132px、不重叠）、时间线 420 距背板 20px；桌面版 `grid`、时间列 84px 靠右；节点线在 80px；7 个 chips；13 条；列表可滚；**文档无横向溢出**。⋯ 菜单在容器内，**最后一个条目自动上弹**（`flippedUp: true`）。已读 13→12、归档少一条、已归档视图 3 条、来源 chip 切「稍后阅读」正确、保存对话框焦点落在链接框。拖拽右→左→右并落盘 `side: right`。
  - **390×844**：`rail=narrow`（不强行让位）、`dock=below`、卡片 190px、容器查询切到窄版（`display: block`、时间 `padding-left: 24px`）、无横向溢出、触控目标 44px、无 console 报错。

### 仍未验证

同上一轮（X / 微博真实连通需要你自己的开发者凭据；真机触摸；10 标签页的轮询配额是推导 + 单测，没压测）。

### 发布记录

- 内容提交 `ef4c895`，版本账 `8816201`；`scripts/release.sh` 完成打包 → tag → `gh release create`。
- Release：https://github.com/mh567/nav-sylph/releases/tag/v1.13.2
- 分支手工推送（脚本只推 tag）：`47a0606..8816201  main -> main`。
- 产物下载后核对：`version.json` 为 1.13.2；`CACHE = 'nav-v78'`；`styles.css` 里 `data-rail="wide"` 规则 3 条、`@container` 块 2 个；模块脚本声明 `wideRail: true`；`app.js` 含宽栏判定；未夹带任何私有文件。

## 上一轮：Special Line 改为内联显示（内容提交 `39365d5`，版本账 `83ef907`，已发布 **v1.13.1**）

用户原话：「不对，我想让 special line 这个模块直接在首页右侧显示，不是单独弹出一个框再显示」。

也就是 v1.13.0 那一版把形态做错了：我做成了「摘要卡（最近 3 条 + 打开时间线）+ 点开一个 `.module-overlay` 弹窗面板」，而用户要的是**时间线本身长在首页右侧那一列里**。本轮把那套弹窗整个去掉。

### 改成什么样

卡片的四段（自上而下），**卡片即时间线**：

| 段 | 内容 |
| --- | --- |
| 头 | 标题 + 同步状态与未读数 + 编辑态的拖拽把手 |
| 工具行 | 来源下拉、状态下拉（全部 / 未读 / 已归档）、立即同步、「＋」保存文章 |
| 列表 | 事件行（来源角标 + 来源名 + 类型 + 标题链接 + 摘要两行 + 相对时间 + 右侧两个行内按钮「✓ 标为已读」「⇣ 归档」），**列表自身滚动** |
| 底 | 条数与最后更新时刻；还有更早时给「加载更早」 |

三个形态决策与理由：

1. **筛选用原生 `<select>` 而不是 chips**：这一列实测只有 152～230px（宽屏 1600 下 210px），三个 chips 排不下；且工具行允许换行（基准 120px），窄时来源下拉独占一行、状态与两个按钮排第二行，够宽时自动回到一行。
2. **已读 / 归档做成行内按钮**，不用「⋯」弹出菜单：菜单挂在会滚动的列表容器里会被 `overflow` 裁掉。
3. **「保存文章」仍是原生 `<dialog>`**：那是个表单，塞不进这一列。

### 放开了这一列的宽度（但上限仍是「可用余量」）

平台把两侧卡片钳在 220px。本轮只对本模块放开到 420px（`.module-zone[data-dock="outside"] .module-widget[data-module-id="special-line"]`）。要说清楚的是：**实际宽度由背板两侧的可用余量决定**，不是那个 420——实测 1600 视口下 `(100% - 936px)/2 - 20px = 210px`，420 的封顶要到视口 ≈1816px 才起作用。想让时间线更宽就得动背板宽度（影响整个首页），不在本轮范围。

### 本轮自查出的三个问题（都是我引入的）

1. **样式里引用了本仓库不存在的 token**：`.special-line-notice` / `.special-line-form-error` / 来源状态徽章用了 `var(--danger)`、`var(--warning)`、`var(--success)`，而这三个 token **在 styles.css 里根本没有定义**（`grep -- '--danger:' public/styles.css` 只命中我自己注释里的引用）。引用不存在的 token 不报错，只是静默丢掉那条声明——失败提示没了颜色，看上去像「样式没生效」。已改用自带的 `--sl-danger` / `--sl-warning`（定义在 `:root` + 两个深色块），「已连接」改用 `--accent`（与 `[data-kind="ready"]` 同一套）。并补了一条测试：两个样式表里都不得出现 `var(--danger|--warning|--success)`。
2. **窄屏（390）下整个文档被撑宽 338px，页面可以真的横向滚动**。逐项二分定位到「行内 `.sr-only` 的包含块」：`.module-zone` 是 `position: absolute`，而卡片在 `data-dock="below"` 下是 `position: static`，于是每行两个 1×1 的绝对定位盒子以 `.module-zone` 为包含块，**逐行累积的溢出逃出了横滑条的裁剪**（隐藏行→溢出归零；隐藏整卡→归零；其他模块从没用过 `.sr-only`，所以这是本模块引入的第一例）。修法 `.module-zone[data-dock="below"] .module-widget[data-module-id="special-line"] { position: relative }`。第一版写成了不限 dock 的 0-3-0，会被它把 outside 模式的 absolute 顶掉——写完立刻复查到并加了反向断言。实测：修复前 `docEl.scrollWidth 728`（视口 390）且 `window.scrollTo` 能滚到 353，修复后 375 且滚不动。
3. **来源下拉被挤成「全…」**：两个下拉各分 57px。改成允许换行 + 基准 120px，来源下拉拿到整行（182px）、状态 120px，两个都不再截断。

### 验证

- `node --test tests/*.test.js` → **523 / 523**（新增两条：内联结构无弹窗 / CSS 的高度上限、包含块与宽度放开、token 审计）。
- 浏览器（每次测量前注销 SW + 清 caches）：
  - **1600×1000**：`dock=outside`、`side=right`、卡片在背板右侧 20px；无 `.module-overlay`、无 `.special-line-panel`；工具行 2 行、来源下拉 182px 不截断；行内按钮 2 个；列表可滚（client 452 / scroll 2225）；页脚「共 15 条」。**拖拽仍可用**：右→左→右，落盘 `side: right`，无残留。
  - **390×844**：`dock=below`、卡片 190×591；卡片 `position: relative`；`docEl.scrollWidth 375`（= 应用宽度）、**不能横向滚动**；行内按钮 34px、图标按钮 40px、下拉 40px/16px 字体（防 iOS 聚焦放大）；列表仍可滚。
  - 交互：已读 15→14、归档后默认视图少一条、归档视图 3 条且 `aria-pressed=true`、来源切「稍后阅读」正确、**滚动位置在手动同步重画后保持 400**、保存对话框焦点落在链接框且无遮罩；浅色/深色都渲染；整轮 console 无报错。
- `sw.js` 的 `CACHE` 由 `nav-v76` 升到 `nav-v77`。

### 仍未验证

同上一轮（X / 微博真实连通需要你自己的开发者凭据；真机触摸；10 标签页的轮询配额是推导+单测，没压测）。

### 发布记录

- 内容提交 `39365d5`，版本账 `83ef907`；`scripts/release.sh` 完成打包 → tag → `gh release create`。
- Release：https://github.com/mh567/nav-sylph/releases/tag/v1.13.1
- 分支手工推送（脚本只推 tag）：`d00e58c..83ef907  main -> main`。
- 产物下载后核对：`version.json` 为 1.13.1；`CACHE = 'nav-v77'`；模块脚本里 `module-overlay` / `special-line-panel` 的出现次数为 **0**（弹窗确实去掉了）；包含块那条修复在包内的 `styles.css` 里；未夹带任何私有文件。
- 本轮自己踩的一个小坑：截图时给 `agent-browser screenshot` 传了**相对路径**，图落进了仓库根目录（`sl-inline2.png`），提交前扫 `git status` 时发现并删除。教训与既有的「工具说成功≠文件在指定位置」同源：凡是会写文件的命令，落点都要给绝对路径，并在收尾时扫一遍仓库根。

## 上一轮：Special Line 时间线模块（内容提交 `c54bf41`，版本账 `ed9f709`，已发布 **v1.13.0**）

用户原话：「可以，开始实现。默认模块启用后放在导航首页右侧空白部分，可拖拽」。在此之前方案与仿真样例都已确认（设计基线 `~/.commandcode/plans/special-line-timeline.md`，实施计划 `special-line-timeline-implementation.md`，仿真 `docs/mockup-special-line.html`，本轮随代码入库）。

### 交付了什么

新增登录后可用的第三个模块 `special-line`：社交订阅与手动保存的文章汇成一条时间线，可标为已读 / 归档。四层落地：

- **数据**：`lib/db.js` 尾部追加 v5——`timeline_sources` / `timeline_credentials` / `timeline_events` / `timeline_event_state`。去重在**数据库层**（`UNIQUE(source_id, dedupe_key)` + `INSERT OR IGNORE`），用户状态独立成表，所以重复摄入既不会重复入库、也不会重置已读 / 归档。
- **服务端**：`lib/timeline/` 六件套 + 三个 adapter（`manual` / `x` / `weibo`）。`service.js` 是不可信输入的边界（长度、URL 协议、时间合理性、metadata 白名单、未知事件类型跳过）；`sync.js` 是调度器（每来源至多一个在途、全局并发 2、失败指数退避到 4 小时、只在成功时前进游标）；`repository.js` 收全部 SQL。10 条 `/api/timeline/*` 路由全部 `requireAdmin`。
- **前端**：摘要卡（缩略时间线）+ 面板（左侧日期轨道 + 节点线 + 事件卡）+ 保存文章对话框 + 后台来源管理区。标题即原文链接（新标签页），次要操作收在「⋯」菜单，时间只在轨道上显示。
- **平台**：为它加了两个**不特判模块 id** 的通用能力——模块定义可声明 `defaultSide`（无已保存布局时按它停靠），模块可挂自己的后台区块 `renderAdminSection(host, { api })`。

### 用户那条新要求怎么落的

「默认模块启用后放在导航首页右侧空白部分，可拖拽」按**启用后默认停靠右侧、模块本身仍由后台开关 opt-in** 实现（与备忘录 / 服务器监控一致，升级不会自动启用）：`special-line.js` 注册 `defaultSide: 'right'`，`applyWidgetLayout` 的 `sideOf` 在没有已保存布局项时回落它，`commitWidgetDrag` 新建条目时同判据。**用户拖过之后 `widgets[].side` 就是唯一真相**，默认值不再参与——不覆盖已保存位置。

### 凭据与备份（本轮最重要的取舍）

- **provider 凭据只存在服务端**：接口只回 `hasCredentials`，任何响应里都不出现 token（明文与密文都不出现）；改管理密码时由 `reencryptCredentials()` 一并重加密。
- **凭据不进 WebDAV 备份**。理由不是偷懒：密钥派生自管理员密码**哈希**（bcrypt 带盐），跨安装解不开——放进远端只多一份暴露面、没有恢复收益。恢复后来源是「待授权」，重新粘贴一次 token。
- **社交事件的摄入不触发自动同步**：那一类可再从提供方取回、且是机器节奏的高频写入，挂钩会把远端上传变成每轮一次。触发的是不可再生数据（保存文章 / 已读归档 / 来源增删改）。

### 两轴代码审查（基线 `v1.12.0`，跑在**未提交的工作树**上）

两轴各自独立跑，各自真跑了测试；两轴都没有浏览器（浏览器实测由我自己做，见「验证」一节）。共 **8 处真问题，全部已修**：

| # | 问题 | 性质 |
| --- | --- | --- |
| 1 | `reencryptCredentials` 里时间线凭据**在循环内逐条落库**，破坏了「全部算完才写」的原子性——中途抛错会留下半新半旧密钥，那一半永久解不开 | 本轮引入，**必须修**（已改成收集后统一在一个事务里写） |
| 2 | 恢复对话框的「唯一可选项默认选中」判据写成「四项全无」，恒为假 → 只含模块 / 只含时间线的分组里**一个 radio 都不选中**，`$(':checked').value` 抛在 handler 里，表现为「点确认恢复什么都不发生」 | 本轮引入，**必须修**（已改成 `optionCount === 1`，并补了一条**真跑该方法体**的回归测试 + 红绿变异证明） |
| 3 | 新增第三条轮询接口后，`modulePollLimit` 仍按「2 个接口 × 6 次/分钟 × 10 标签页 = 120」推导；三模块全开 + 10 标签页会自己打满，复现 v1.11.7 修过的故障 | 设计问题，已抬到 **180** 并同步文档与「按接口数推导」的守卫 |
| 4 | 保存文章成功后草稿没清：`close` 监听会把输入框的值回采进 `saveDraft`，覆盖掉刚赋的空值 → 重开对话框残留上一篇的链接与标题 | 本轮引入（仿真要求成功后清空），已在 `close()` 前先清输入框 |
| 5 | 同步失败提示丢了仿真里确认过的「保留了上次同步的事件。」 | 已补 |
| 6 | 面板缺「最近动态 / N 条事件」列表标题与计数（标题应随筛选切换） | 已补 |
| 7 | 测试里一条**恒真断言**（`assert.equal(a, cond ? a : b)` 自比） | 已改成钉「末页 hasMore 为假 + 满页才给游标」 |
| 8 | 两处被我自己的补丁粘到同一行的语句（`git diff --check` 抓不到） | 已拆行 |

顺带采纳的建议：x adapter 的 `userIdCache` 加上限（32，超了清空）；模块内元素 id 统一成 `specialLine*` 前缀并补「不与页面既有 id 撞名」守卫；**真跑**时间线路由处理器（不再只断言源码形状）；`syncSource` 把容量判断提到 `fetchEvents` 之前（触顶时不再白打第三方请求）；错误文本落库前剥掉像凭据的片段（微博的 token 就在 query string 里）。

**审查推翻的怀疑（不成立，记下来免得下一轮重查）**：时间线数据经 `toPublicConfig` / 匿名端点泄露（不成立——数据全在 SQLite 新表，从不写 `config.json`）；凭据进日志 / 进响应 / 进备份（不成立，三处都有真跑断言）；新增限流 Map 漏登记 sweep（不存在新增 Map）；迁移改了已发布台阶（不成立——只在尾部追加 v5）；模块引用裸 `API` / 摸 `window.app` 内部方法（不成立）；`saveServerVisibility` 写死 `side:'left'` 影响 `defaultSide`（不成立——它只被监控目标调用，服务器没有 `defaultSide`）。

### 验证

- `node --test tests/*.test.js` → **521 / 521 通过**（相对 v1.12.0 基线 489，新增 32 条）。新增 `tests/timeline.test.js`（22 条）与 `tests/timeline-backup.test.js`（10 条）。
- `node --check`：server.js、lib/db.js、lib/credentials.js、lib/webdav-backup.js、lib/timeline/**（含 adapters）、public/app.js、public/modules/special-line.js、public/sw.js 全部通过；`git diff --check` 干净。
- **真实服务副本**（临时目录 + 已知密码 + 夹具；未复制任何真实私有文件）：匿名 `GET /api/timeline/events` → 401；保存文章 → 列表出现；非法链接（`javascript:`）→ 400；标为已读 → 未读数 1→0；归档 → 默认视图排除、归档视图可见；建未知 provider → 400；建 X 来源（凭据无效）→ 400 `code=auth` 且**未落库**；删内置来源 → 400。
- **浏览器实测**（1440×900 / 1600×1000 / 390×844，每次测量前 unregister SW + 清 caches）：
  - 新启用 → `dock=outside`、卡片在背板右侧 20px（宽 210）`side=right`；清掉布局条目后同样回落右侧。
  - 编辑态拖拽：把手可见 → 右拖到左 → 配置项 `side` 记为 `left`、无残留（`dropSide` 空、无 `is-dragging`）→ 「保存编辑」→ 重载后仍在左侧（**默认值没有把它拉回**）。
  - 面板 720×620；来源 chips（含「稍后阅读」）/ 视图 chips；事件卡带来源标记、类型标签、⋯ 菜单、真链接（`target=_blank` + `rel="noopener noreferrer"`）；轨道在 118px；页脚计数。
  - ⋯ 菜单展开出「标为已读 / 归档」，且不超出面板；已读 3→2；归档后默认视图 3→2、归档视图 3 条。
  - 保存对话框：聚焦在链接框；`javascript:` 被拒（文案 + `aria-invalid`）；取消后重开草稿仍在；**成功保存后重开为空**（本轮修的那条）。
  - 窄屏 390：单列、时间在卡上方（`display:block`）、节点线在 11px、无横向溢出、触控目标 44px（`chip` 44、`⋯` 44×44）。
  - 浅色 / 深色都渲染正常；整轮操作（开面板→同步→切筛选→保存）**console 无报错**，`swController: true`。
  - 把来源标成 `auth` 错误后：卡片转「同步失败 + 重试」，面板提示为「同步未完成 保留了上次同步的事件。X · @northstar 需要重新授权，可到后台「模块」分区更新」。
- `sw.js` 的 `CACHE` 由 `nav-v75` 升到 `nav-v76`，新模块进 `ASSETS`（测试钉住）。

### 仍未验证

- **X / 微博真实连通性**：本环境没有开发者凭据，两个 adapter 只有固定响应的 fixture。界面上的「已连接」来自 `testConnection` / 同步成功，不是仿真状态——但**真实端点能否连通，必须在有凭据的机器上以「测试连接」为准**。同时未验证的还有：X 各访问层级对「用户时间线」端点的实际开放情况、微博 access_token 的有效期与刷新行为、以及各自的真实配额。
- **多标签页下的轮询配额**：本轮把 `modulePollLimit` 抬到 180 是按公式推导 + 单测钉住，**没有真的开 10 个标签页压测**（要 10 个浏览器上下文，未做）。
- **真机触摸**：44px 触控目标是按 CSS 计算值验的（390 视口），没有真机手指测试。
- Service Worker 的 install/`addAll` 运行时行为未核（工具链限制）。

### 发布记录

- 内容提交 `c54bf41`（29 个文件，+5620/−56），版本账 `ed9f709`，随后 `b53e852` 修了发布脚本的一处 bug。
- **发布过程中被 `scripts/build-agent.sh:60` 挡下过一次**：`echo "…版本 $AGENT_VERSION）"` 后面紧跟全角「）」，bash 在 `set -u` 下把这个非 ASCII 字节吃进变量名（报 `AGENT_VERSION：unbound variable`），而 `release.sh` 把它报成「请先安装 Go 1.22+」——Go 其实装好了。改成 `${AGENT_VERSION}` 后 4 个目标全部构建成功。
- `scripts/release.sh` 完成：打包 → `git tag -a v1.13.0` → 推 tag → `gh release create`。Release：https://github.com/mh567/nav-sylph/releases/tag/v1.13.0
- **分支由手工推送**（脚本只推 tag，这是既有设计）：`cea929f..b53e852  main -> main`。
- 发布产物下载后核对：`version.json` 为 1.13.0；`public/sw.js` 里 `CACHE = 'nav-v76'` 且 `ASSETS` 含 `/modules/special-line.js`；`lib/db.js` 含 v5 建表语句；`lib/timeline/*` 与 `public/modules/special-line.js` 都在包内；**未夹带任何私有文件**（`.modules.json` / `.admin-password.json` / `config.json` / `favorites.json` / `nav-sylph.db` / `.webdav-config.json` 逐一 grep 为空）。
- `docs/` 与 `tests/` 不在打包范围（`release.sh` 的 `cp` 清单里没有它们），所以本文件与仿真样例只存在于仓库。

### 下一步

1. 有 X / 微博开发者凭据时，跑一次真实「测试连接 + 立即同步」，把结论回填到 `README.md` 与本文的「仍未验证」。
2. 时间线目前**只读社交、不抓正文**（有意：避免新增 SSRF 面）。若要做正文摘要，先按架构文档的 SSRF 边界设计。
3. `.env.example` 未新增变量（本轮无常量需要外部化）。

## 上一轮：WebDAV 自动同步开关 + 修「远程备份展开失败」（内容提交 `ad101da`，版本账 `dd3a13d`，已发布 **v1.12.0**）

用户原话：「在修改完首页导航内容等配置项后，后台 webdav 会自动保存配置吗，需要增加自动同步的开关，打开开关后有配置修改自动触发。现在改完配置手动去同步时，有时候管理界面的 webdav 配置项展开会失败，分析根本原因并修复」

### 先回答那个问题：不会自动保存（本轮改动**之前**的行为）

备份只有一条路径——用户点「立即备份」→ `POST /api/webdav/backup`。`config.json` / `favorites.json` / `.modules.json` 的任何一次写入都不碰 WebDAV。上一轮 README 重写时也已按实际命名（写「WebDAV 远程备份」而不是「自动备份」，并在「待用户决定」里挂了这个缺口）——本轮把它补上。加了自动同步开关之后，这个答案只在开关关闭时成立。

### 根因：「展开失败」是内存缓存与 DOM 脱节，不是偶发

`toggleSection('webdav')` 原来的加载条件是 `!this.webdavConfig`（**配置在不在内存里**）。而 `renderAdminPanel()` 每次重建 `#modalBody` 都会产生一个只写着「加载中...」的新 `#webdavSection`，`webdavConfig` 却还留着上一份——于是展开时条件为假、不发请求，占位符永久留在页面上。

**可复现路径（不是偶发）**：登录 → 打开管理面板 → 展开「远程备份」（正常）→ 关闭面板 → 再打开 → 展开 → 永久「加载中...」。其它会重建面板 DOM 的入口（导入收藏、添加收藏、默认密码提示分支）之后同样触发。

这与仓库里已经修过的模块分区 `!this.modulesConfig` 是**同一个缺陷类**（判据该落在「输出有没有画出来」，不是「输入在不在内存里」）。修法：新增 `webdavRendered` 闩锁，在构造函数初始化、`renderAdminPanel()` 复位、`renderWebDAVSection()` 置位、登出复位；判据改为 `!this.webdavRendered`。

⚠️ 同时处理了一条**把缺陷固化成契约**的守卫：`tests/login-guard.test.js` 里原本正面断言 `expanded && sectionId === 'webdav' && !this.webdavConfig`。不删它，正确修法会让测试转红。已改成钉闩锁并给测试改名（名字陈述应有行为）。

### 自动同步的设计（用户拍板：自动备份单独占一槽）

- 开关 `autoSync` 存 `.webdav-config.json`，**缺省关闭**；生效条件是 `enabled && autoSync && url` 同时成立。
- **触发点在 `writeJSON`**，不逐条路由加：`.modules.json` 一个文件就有 8 处写路径，漏一处的表现是「改了这项不会自动同步」而用户不会知道。钩子排在落盘与 chmod 之后；`isBackupSource()` 只认那三个数据文件（`.admin-password.json` 永不触发）。
- 30 秒防抖（`NAV_AUTO_SYNC_DELAY_MS` 可覆盖，仅供 e2e）；串行 + 队列；定时器 `unref()` 且关闭时清掉。
- **启动期不排期**：`init()` 的 `ensureFile()` 也走 `writeJSON`，若此时 `.webdav-config.json` 已是 `enabled+autoSync`，一次开机就会把默认配置推到自动槽位、覆盖掉好数据。
- **失败必须留痕**：`lastAutoSyncError` / `lastAutoSyncErrorAt` 写回配置 → 接口回给前端 → 渲染在区块里。静默失败在这里代价最大。
- **恢复备份期间抑制**，递减放 `finally`（否则任一步抛错会让抑制永久开着、自动同步静默失效，而界面还写着「已开启」）。
- ⚠️ **两套校验和**：自动备份若更新了手动那一组，用户点「立即备份」会得到「没有变化」、什么都不生成——一次显式请求被静默吞掉。自动用 `lastAuto*Checksum`，手动仍用 `last*Checksum`，`lastBackupTime` 两条都更新。
- 自动槽位用固定文件名（不带时间戳、每次覆盖），`listBackups()` 标 `isAuto` 并显式排最前，`cleanupOldBackups()` 用 `filter(b => !b.isAuto)` 把它排除在计数与删除之外——它永远排最前，不排除的话反而最先被当成「最旧一组」删掉。

### 提交前的两轴代码审查（基线 v1.11.9，跑在**未提交的工作树**上）

规范轴（对照 AGENTS.md + `docs/architecture.md` + 本文件，外加命名的代码异味基线，规则是「仓库文档优先于通用基线」）与需求轴（把用户两轮原话当作规格，另外把计划文件里「不在本次范围」一节交给它判越界）并行跑。结论：**无 P0/P1**，需求逐条满足、无越界（计划 §六 的七条一条没碰）。提出的 P2 里采纳并修了九处：

1. **恢复期间抑制只挡排期，挡不住「正在飞」的那一次**（规范轴找到的竞态，本轮最硬的一条）。`scheduleAutoSync` 的 `autoSyncSuppressed` 判断只在**排期时**生效；一个在「点恢复」之前就已排期的定时器会照常触发，而恢复正好写到一半（`config.json` 已换、`favorites.json` 还没换），于是上传一份**混合快照**并把它记成最新自动槽位。e2e 那一步抓不到它——那次运行里没有在飞的定时器。修法：进入恢复时先 `cancelScheduledAutoSync()`，`runAutoSync` 开头也再看一眼抑制标志（两处都补了守卫与变异）。
2. **删掉自动槽位的文件 = 它再也不会回来**。远端 `-auto` 被删而 `lastAuto*Checksum` 还留着，`noChanges` 会在下一次自动同步时直接短路，而界面上仍写着「已开启」。`deleteBackup` 现在按文件名清掉对应那一组校验和，**赋 `undefined` 而不是 `null`**（`JSON.stringify` 会丢掉值为 `undefined` 的键，这个键整个消失；写 `null` 时若当前内容也判出 `null`，`null === null` 会让上传再次被吞）。删除确认框也改用列表里渲染出来的名字——原来重算会退化成光秃秃的时间，用户认不出自己点的是哪一条。
3. **数据文件读失败的无条件兜底在自动路径上会抹数据**。`favorites.json` 损坏时兜底是空数组，上传它等于用一份空书签**直接抹掉**远端那一份，而自动同步发生在用户没点任何按钮的时候。两个兜底改为**只吞 ENOENT**（`version.json` 那处仍有意无条件兜底：读不到就用 1.0.0，没有破坏性）。
4. **一处因果说法不成立**：「还可能把真正的还原点挤出保留窗口」——自动槽位已被排除在轮换之外，自动备份**不可能**挤掉手动分组。三处（两条代码注释 + architecture）按实际改写。
5. **`AUTO_SYNC_KEEP_COUNT` 名字误导**：它管的是**手动**分组的保留数。改名 `BACKUP_KEEP_COUNT`。
6. **自动槽位文件名重复拼写**：`createBackup` 又把三个名字写成字面量模板。改为使用文件头那三个常量（`listBackups` 的识别用的就是同一组）。
7. **同一测试文件里两份假客户端**：新加的 `recordingClient`/`offlineBackup` 与既有那条测试的内联版本重复，旧的那条改用新助手。
8. **没有消费者的产出**：`runAutoSync` 返回的 `auto` 字段（只有测试读——正是本仓库记过多次的那类缺陷）、自动同步失败行的 `id="webdavAutoSyncError"`（无 CSS 无 JS，样式本就来自 `.webdav-message.error`）。两处都删掉。
9. **`favManagerRendered` 靠 `undefined` 参与判断**：本文件自己的规矩是显式初始化（见 `_gridEditing` 的注释），补上构造函数里那一行——三个同批复位的标记此前只有两个显式初始化。

需求轴另提两条**未改**的：「勾选框文案里的括号」与「改密码引起的凭据重加密也会触发一次自动备份」。前者是该轴自己判定的计划级选择（AGENTS 第 9 条的括号禁令只针对 CHANGELOG 的 `summary`/`highlights`），后者是有意的（密文确实变了）——已把后者写进 architecture 的触发清单，不再只存在于代码里。

### 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `lib/webdav-backup.js` | `autoSync` 默认值 + `getPublicConfig` 三个字段 + `createBackup(options.auto)`（文件名取自常量 + 独立校验和）+ `listBackups` 识别 `-auto` 并显式排序 + `cleanupOldBackups` 排除 `isAuto` + `deleteBackup` 删自动槽位时清掉对应校验和 |
| `server.js` | `writeJSON` 钩子 + `isBackupSource` / `scheduleAutoSync` / `cancelScheduledAutoSync` / `runAutoSync` / `autoSyncSuppressed` / `autoSyncReady`；抽出 `collectBackupPayload` + `performBackup` 让手动路由共用（兜底只吞 ENOENT）；`POST /api/webdav/config` 接收 `autoSync` 并清旧错误；恢复路由取消排期 + 抑制（`finally` 递减）；`init()` 末尾置 `autoSyncReady`；`gracefulShutdown` 清定时器 |
| `public/app.js` | ①`webdavRendered` 闩锁修「展开失败」；②自动同步勾选框 + 三态状态行 + 失败行 + 提示文案 + 保存时提交 `autoSync`；③恢复对话框 `isAuto` 前缀、删除确认用渲染出来的名字；④保存成功提示改为先重渲染再写 |
| `public/admin.css` | 状态行允许换行（三段了）、勾选框禁用态暗化、自动槽位左侧色条 |
| `public/sw.js` | `CACHE` `nav-v74` → `nav-v75` |
| `.env.example` | `NAV_AUTO_SYNC_DELAY_MS` 说明 |
| `README.md` | 核心功能表加「自动同步」；远程备份一节加开关说明与自动槽位文件名；环境变量节的说明补 `NAV_AUTO_SYNC_DELAY_MS` |
| `docs/architecture.md` | 新增「WebDAV 远程备份与自动同步」一节；「后台管理分区」补折叠区判据纪律 |
| `tests/login-guard.test.js` | 改写并改名那条固化了缺陷的断言；新增闩锁、复位、禁用联动、三态、保存提交的守卫；加 `methodBody()` 括号配对助手 |
| `tests/backup-privacy.test.js` | 自动同步的服务端与行为守卫（含恢复竞态、删除后清校验和、ENOENT 边界）；复用一个假客户端助手；修正一条端锚点**从来不存在**的旧断言 |
| `tests/fav-tab.test.js` | CACHE 名跟到 `nav-v75` |

### 顺带修掉的三处（都在本轮边界内）

1. **`saveWebDAVConfig` 的「配置已保存」从来没显示过**（既有缺陷）：提示写在 `renderWebDAVSection()` 之前，而那次重渲染会重建整个容器，把提示所在的元素换成空的新元素。顺序改为先重渲染、再写到新元素上。用户勾完自动同步保存后看不到任何反馈，正好是本轮最不该缺的那条确认。
2. **勾「自动同步」后状态行不动**（浏览器实测发现）：`onchange` 只绑了「启用」。改为两个框共用同一个 `refreshAutoState()`，状态文案与禁用态都只在这一处算。
3. **`tests/backup-privacy.test.js` 里一条旧断言的端锚点是错的**：`code.indexOf("app.post('/api/webdav/list'")` —— 那条路由是 **GET**，`indexOf` 返回 -1，`slice(start, -1)` 静默给出「直到文件末尾」的巨大窗口，里面的 `readJSON(MODULES_FILE)` 让它照样通过。本轮把清单移出路由后这条断言暴露了端锚点问题，已改为 `app.get` 并补长度上限断言。

### 验证

- **单测 489/489 通过**。相对 HEAD 基线（在临时 worktree 里跑）= 476 条，**+13 条全部是本次新增**；基线那 8 条 skipped 是 worktree 里没有 `agent/dist` 构建产物所致，不是用例差异。
- **红/绿变异证明 22/22 条按预期变红**，且每条都落在**预期的那个用例**上（脚本同时校验锚点唯一、替换前后不同、恢复后标记消失）。其中 2 条第一轮是绿的：一条锚点不唯一被跳过，另一条暴露了守卫本身太弱（见下）。审查后补的 5 处修复各有一条新变异（恢复竞态 ×2、删自动槽位清校验和、ENOENT 边界、文件名常量）。
  - **守卫太弱的那条**：`assert.match(panel, /this\.webdavRendered = false/)` 在删掉 `renderAdminPanel` 里那一行后**仍然绿**——因为 logout 处理器就在 `renderAdminPanel` 方法体之内，也有一行同样的复位。改用 `[^;]*` 连接三行复位（限定「同一段连续语句」）后转红。用 `[\s\S]*?` 也不行，懒匹配会跨到 logout 那行去。
- **真实 HTTP 边界 e2e（真服务 + 桩 WebDAV，`NAV_AUTO_SYNC_DELAY_MS=1200`）9 步全过**，审查后补完修复**又重跑一次同样全过**：副本里先断言无任何私有文件；开关落盘且文件仍 0600；改配置 → 固定槽位出现三个文件；内容未变不重复上传；**手动「立即备份」仍生成时间戳分组**（证明两套校验和没互相污染）；连做 6 轮 → 手动裁到 5 组、自动槽位仍在；指向死端口 → `lastAutoSyncError` 落盘且接口回传；恢复期间 PUT 数不增加；关掉开关后不再上传。桩先单独用**真 `webdav` 客户端**验证过形状（`propstat.prop` + 小写属性 + `lastmod`/`size`/`type` 都取得到）。
- **真浏览器（agent-browser）先复现再验收**。每次测量前 `unregister()` + `caches.delete()` 全清 + 破缓存查询串。
  - **基线（HEAD，4401）复现**：第一次展开正常；关闭再打开后第二次展开 → `区块内容 = "加载中..."`、`hasForm = false`、`aria-expanded = "true"`、`webdavConfig = 有`、**全程只发出 1 次 `/api/webdav/config`（第二次一次都没发）**。截图存证。这直接印证根因是「判据为假、不发请求」，而不是「toggle 坏了」。
  - **修复版（4402）**：同一序列两次展开**都渲染出配置**，`/api/webdav/config` 请求数 **2**。
  - 新控件实测：未勾「启用」时自动同步置灰且 label 变淡；勾「启用」→ 解禁；勾「自动同步」→ 状态行 **已关闭 → 已开启**；取消「启用」→ **待启用（需先勾选「启用 WebDAV 备份」）**、勾仍留着但置灰；保存后读盘确认 `enabled=true autoSync=true url=…` 且文件模式 `-rw-------`；「配置已保存」提示现在可见。
  - **过程中踩到一次自己的坑**：`#webdavSaveBtn` 在 1280×577 下位于折叠线以下（`rect.y=650`），`elementFromPoint` 返回 `null`、点击静默无效——是夹具没滚动到视口内，不是产品缺陷；`scrollintoview` 后再 hit-test（`命中就是它自己: true`）才点中。**光看「✓ Done」会把它读成按钮坏了。**

### 仍未验证

- **未在真实 WebDAV 服务上跑过**（坚果云 / NextCloud）：e2e 用的是按客户端解析器形状实现的最小桩。真实的 `MKCOL` / `PUT` 覆盖语义、配额与限流行为未覆盖。
- **未验证多标签页/多端并发改配置时的自动同步**：串行化只在单进程内，够用但没实测过并发触发。
- **未验证长时间运行下自动槽位的覆盖行为**（连续改几十次配置后远端是否只有一个自动槽位）——只在 e2e 里覆盖到 6 轮。
- 触摸端未涉及。

### 发布记录

用户当轮以「提交并发布」授权整条链，未再逐句确认。实际执行：内容提交 `ad101da`（12 个文件）→ 版本账提交 `dd3a13d`（`package.json` / `version.json` / `CHANGELOG.json`，三处 1.11.9 → 1.12.0，重新解析一致）→ `scripts/release.sh`（`CACHE` 已在内容提交里升到 `nav-v75`，脚本构建了三个 Linux agent 产物并自检为静态 ELF）→ 打 tag `v1.12.0` 并创建 Release → **手工推分支**（脚本只推 tag，见 AGENTS 第 8 条）→ 从 Release 下载 `nav-sylph-v1.12.0.tar.gz`（13 MB）核对：六个私有文件全部缺席、`webdavRendered` / `id="webdavAutoSync"` / `cancelScheduledAutoSync` / `BACKUP_KEEP_COUNT` / `AUTO_MODULES_FILE` 五个标记齐在（证明产物确实出自最终树，含审查后补的那几处）、包内三处版本一致、三个 Linux agent 产物在而无 darwin、`docs` / `tests` / `scripts` 未进包。

**定为 minor 而不是 patch**：新增的是用户可见能力（一个开关 + 一套服务端机制），与 v1.11.0 新增模块、v1.8.0 触摸端拖拽同级，按仓库惯例走 minor。

### 下一步

- 自动同步是否要覆盖未来的新数据文件（例如某个模块自带表）：目前白名单写死三个文件，需要时按文件路径扩展并同步更新文档。
- 计划 §四 的改动表没列 `README.md`、`public/admin.css` 的装饰色条与三处「顺带修」，但都不在 §六 的排除项内；需求轴复核后判为「in-spirit 而非越界」，此处记录以免下次读成越界。

## 上一轮：README 结构重写（v1.11.9）

用户原话：「核心特点及 readme 内容要突出重点，不要写“登录后模块”这类自造的不标准啊式的表述。突出核心功能（如自定义导航、超级搜索框（快速分享文本/搜索书签）、书签集中管理、自动webdav 备份、自定义模块等）、安全特性等，然后每个概括说明功能和使用方法即可。其他的项目安装方法、架构、遵循的协议等按需保留即可。」

### 改法

结构：核心功能（6 行概览）→ 功能说明（6 项，每项一段概括 + 具体操作）→ 安装 → 配置 → 项目结构 → 更新日志 → 许可证。篇幅 400 行收敛到 280 行。

术语一律对齐界面与代码：

| 原表述 | 改为 | 依据 |
| --- | --- | --- |
| 登录后模块 | 自定义模块 | 后台分区名（`public/app.js:4459-4462`） |
| 首页编辑模式 | 自定义导航 | 按钮 title「编辑首页导航」（`public/index.html:85`） |
| 搜索引擎编辑器 | 搜索引擎 | 分区内标题与「添加搜索引擎」按钮（`public/app.js:4500,4505`） |
| 自动 WebDAV 备份 | WebDAV 远程备份 | 见审查第 1 条 |

### 两轴审查（基线 v1.11.8，跑在未提交的工作树上）

**已采纳并修**

1. **「自动备份」不成立（规范轴，本轮最硬的一条）。** 备份只有「立即备份」按钮触发：`public/app.js:4820` → `POST /api/webdav/backup`（`server.js:1773`）。全仓库唯一的 `setInterval` 是限流清扫（`server.js:319`），「自动」的部分只有备份后清理旧备份（`server.js:1809`）。**用户原话写的是「自动webdav 备份」，但代码没有这个能力，因此按实际命名为「WebDAV 远程备份」**——写「自动」等于给用户一个不存在的承诺。
2. （规范轴）「所有设置都在管理面板」与紧随其后的「首页导航直接在首页编辑、不必进后台」自相矛盾，已改为「设置集中在管理面板……首页导航的排版不在面板里」。
3. （需求轴）术语：「搜索引擎编辑器」在界面上叫「搜索引擎」，已对齐。
4. （规范轴）三处括号旁白改为直陈句（部署第 4 步、传输安全、macOS 的 CPU 说明）。
5. （需求轴）安全特性给可操作项补了用法（默认密码在提示中修改、私密在收藏管理器里标记）。

**经复核后未改（有意保留 / 已推翻）**

- （需求轴）「书签导入的浏览器列表是凭空编造」——**不成立**：`server.js:1274` 的注释就写着「Netscape Bookmark HTML 格式（Chrome/Edge/Firefox/Safari 通用）」，解析器是通用 Netscape 解析。保留列表，补上「Netscape 格式」这一前提。
- （需求轴）指服务器监控子节约 30 行「超出概括」。它确实是「使用方法」（部署与升级是用户要做的步骤），保留。
- （需求轴）指「其他特性」「配置」两节权重过高。按用户「按需保留」的要求保留，不再压缩。
- （需求轴）指标题用「核心功能」而非原话的「核心特点」。保留：该节是功能表，措辞更准。

### 待用户决定

- ~~**要不要真的做「自动备份」**：目前只有手动「立即备份」。~~ **已于本轮（WebDAV 自动同步开关）解决**：新增 `autoSync` 开关，缺省关闭；README 与 architecture 均已同步。

### 验证

- `git diff v1.11.8 --name-only` → 仅 `README.md`；`public/` 无改动，不 bump `sw.js` 缓存名（保持 `nav-v74`）
- 三处版本号重新解析一致（1.11.9），CHANGELOG 形状确认为 `{ versions: [...] }`
- 本次不含代码改动，未跑 `node --test`（无代码路径受影响）
- README 为纯文本，没有浏览器渲染路径可看

## 上一轮：README 全量刷新（v1.11.8）

用户原话：「项目 README 需要更新一下了」。范围选了「全面刷新」。

**README 停留在 v1.6 前后，v1.7～v1.11 加入的三块功能一个字都没有。** 新增三节：服务器监控与 agent（添加机器 → 生成部署命令 → 升级命令、拉取/推送对照）、登录后模块（模块开关、更新周期、服务器监控卡片与备忘录）、首页编辑模式（拖模块、拖书签、分类头、一次保存）。

### 逐项修正（均与代码核对后改）

| 项 | 原状 | 实际 |
| --- | --- | --- |
| WebDAV 备份内容 | 两个文件 | 三个（多 `nav-sylph-modules-*.json`）；书签与模块文件仅在对应数据存在时生成 |
| 配置文件表 | 缺 `.modules.json` | 已补 |
| 环境变量表 | 8 项 | 13 项（补 `HTTPS_CA_PATH`、`ADMIN_PASSWORD_FILE`、`GEO_DATABASE`、`DB_FILE`、`LOG_DIR`） |
| 管理面板 | 平铺功能列表 | 四个分区（首页导航 / 收藏夹 / 模块 / 账户与备份） |
| 目录结构 | 缺 `agent/`、`public/admin.css`、`public/modules/`、`public/lib/`、`lib/monitor.js`、`lib/credentials.js`、`lib/geo/`、`scripts/`、`tests/` | 已补 |
| 技术栈 | 存储仅登录会话 | 补 Go agent；SQLite 含备忘录与监控指标缓存 |
| 许可证 | 仅 MIT | 补 4 项第三方（highlight.js BSD-3-Clause、qrcode.js MIT、uFuzzy MIT、ip2region Apache-2.0 OR MIT） |
| 后台状态位措辞 | 写作合并的「异常」 | 实为「证书异常」「端口被占」；两个状态位是「在线」「部署就绪」 |
| 模块区位置 | 「分类网格下方」 | 宽屏两侧有空间时停靠在背板左右两侧 |

### 两轴审查（基线 v1.11.7，跑在未提交的工作树上）

**已采纳并修**

1. （规范轴）`DATA_FILE` / `ICON_PATH` / `FAVICON_PATH` 被列成可用配置，但 `config.paths` 下只有 `database` 与 `logs` 有消费者（`server.js:900`、`:881`），页面图标固定引用 `public/` 下的文件。README 改为在表外说明它们不生效。
2. （需求轴）环境变量表漏了服务端实际读取的 `DB_FILE` 与 `GEO_DATABASE`（`server-config/index.js:58,63`）；后者经 `server.js:910` → `lib/session.js:240` 真正被消费。已补入。
3. （需求轴）首页编辑模式漏了书签卡上的 ✕ 删除（`public/app.js:1093`，处理器 `:1540`）。
4. （两轴一致）「模块区位于分类网格下方」只在 `data-dock=below` 成立，宽屏基础规则是绝对定位停靠，与同节「宽屏可拖到左右两侧」自相矛盾。已改写。
5. （需求轴）「单列为『异常』」不存在这个名字，实际是「证书异常」「端口被占」（`public/app.js:3883,3885`）。
6. （规范轴）「共三个文件」不总成立：书签文件仅在存在收藏时上传（`lib/webdav-backup.js:243`），模块文件仅在 `modulesData` 存在时（`:254`）。已改为条件措辞。
7. （规范轴）`.modules.json` 写「凭据加密存储」不准确——agent token 是 AES-256-GCM 密文，推送凭据是 sha256 哈希，不是同一种形态。改为「不以明文存储」。

**经复核后未改（有意保留）**

- 规范轴指 README 记录了 0600、SQLite 里存什么等属 `architecture.md` 的实现细节。这些对自托管用户是操作性信息（文件权限、哪个库承担什么），保留。
- 规范轴指若干括号旁白违反 `AGENTS.md` 第 9 条。该条的适用范围是 CHANGELOG 的用户可见文案；README 里保留的是事实性限定（如「有改动时会先确认」），只把自嘲式的一句（「诚实降级，不编造数值」）改写成陈述。

### 本轮发现的后续项（不在本次范围）

1. **界面里没有常驻的「修改密码」入口。** 全仓库 grep：`changePassword()` 只被默认密码的提示调用（`public/app.js:3120-3126`），「账户与备份」分区只有信任此设备 / 远程备份 / 退出登录（`:4535-4560`）。README 已按实际改写，未凭空写一个不存在的按钮；要不要补入口需要产品决定。
2. **`.modules.json` 不在 `sylph.sh` 的升级备份清单里**（`sylph.sh:756-763` 只有 config.json、.admin-password.json、.env、server-config.json、favorites.json、nav-sylph.db）。它当前不会丢，因为升级的 `rm` 清单里没有它；但这属于「靠没被删而幸存」，不是被备份。

### 验证

- `git diff v1.11.7 --name-only` → 仅 `README.md`；`public/` 无改动，因此不 bump `sw.js` 缓存名（保持 `nav-v74`）
- `git diff --check` 干净；三处版本号重新解析一致（1.11.8），CHANGELOG 形状确认为 `{ versions: [...] }`
- 本次不含代码改动，未跑 `node --test`（无代码路径受影响）
- 未做的事：README 是纯文本，没有浏览器渲染路径可看；上面两条后续项没有实现，只记录

## 上一轮：轮询接口不再占用管理端的限流桶（v1.11.7）

用户原话：「更新以后，有时刷新后显示监控数据读取失败模块加载不出来」。

### 先说结论：不是数据读不到，是那两个请求被 429 了

「监控数据读取失败」这句只可能来自**客户端那次请求整体失败**（某一台机器拉不到会显示服务端给的 error），而「模块加载不出来」说明 `/api/modules/config` 那一跳也失败了。两者同时失败 → 查限流。

**实测复现**（临时副本里给限流器逐条加计数日志）：一分钟内连刷 12 次——

| 请求 | 结果 |
| --- | --- |
| `/api/memos` | 第 6 秒起 429 |
| `/api/modules/config` | 第 9 秒起**连续 5 次 429**（模块区因此渲染不出来） |
| `/api/modules/metrics` | 前 7 次 200，之后**根本没再发**（config 先失败，模块区没渲染） |

**额度算术**（同一只桶，30 次/分钟/IP）：

- 一次页面加载占 **3** 次：`modules/config` + `metrics` + `memos`
- 一个前台标签页空闲轮询占 **8** 次/分钟（两个接口各 4 次）
- ⇒ 单开一个标签页刷 **7~8 次**打满；两个标签页 **4~5 次**；三个标签页 **2 次**

所以「更新以后」这个时间点不是巧合：更新完总会多刷几次去看新版本。**这不是 v1.11.5 / v1.11.6 引入的**——`git diff v1.11.4 HEAD -- public/` 里没有任何新增请求，是既有设计撞上了使用方式。

### 顺手发现的第二个缺陷：失败是「静默消失」而不是「报错」

用户说的「模块加载不出来」，屏幕上其实**一句解释都没有**。`renderModuleZone` 里 `if (this.modulesError)` 那段排在 `enabledModuleIds()` 判空**之后**，而 config 没拿到时那个列表是空的——函数在更早处就 `hidden` 返回，错误 UI 走不到（**精确地说：首次加载时走不到**；若此前已有一份 config——比如打开过管理面板——它是能走到的，我起初写成「死代码」是夸大了，审查指出后已改口）。实测（冷启动 + 把 `/api/modules/config` 打成 429）：模块区文案为空、没有重试按钮。已把判据顺序调正，现在会显示原因 + 重试按钮。

### 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `server.js` | 新增 `modulePollLimitMap` + `modulePollLimit`（120 次/分钟，按「2 个接口 × 周期下限 6 次/分钟 × 10 个标签页」推导），**登记进 60 秒清扫定时器**；`GET /api/modules/metrics` 与 `GET /api/memos` 从 `rateLimit` 改到它；备忘录的写路由仍走 `rateLimit` + `memoLimit` |
| `public/app.js` | `API.get` 的异常带上 `status`；`loadModulesConfig` 把 429 与普通失败分开说；`renderModuleZone` 把 `modulesError` 的判据**提到判空之前**（否则失败是静默的） |
| `public/modules/server-monitor.js` | 轮询失败按状态码分开说（429 → 「请求过于频繁，稍后自动重试」）；失败态的指纹带上那句话，否则先 429 后真失败时卡上文案不更新 |
| `public/sw.js` | `CACHE` `nav-v73 → nav-v74` + 注释块记录 |
| `tests/fav-tab.test.js` | 缓存名守卫同步到 `nav-v74` |
| `tests/monitor-agent.test.js` | 新增 2 条（轮询桶的存在/阈值推导/两条路由的接线/写路由没被一起放出去/客户端区分 429；失败要先渲染错误再判空） |
| `tests/api-boundary.test.js` | 模块端点的限流桶守卫改成**按路由查表**（默认 `rateLimit`，`metrics` 是 `modulePollLimit`），而不是写死一种 |
| `tests/memo.test.js` | 「五条路由都带 rateLimit」改为「读走轮询桶、写走管理桶 + memoLimit」；vm 夹具补桩 `modulePollLimit` |

### 验证

- `node --test tests/*.test.js` → **476 pass / 0 fail**（新增 2 条 + 改 3 条既有守卫）
- **红绿验证 15/15 全部精确转红**（副本内做，工作树未受触碰），含「停靠赋值挪到错误分支之后」「错误态丢掉强制 below」「错误条不再开 pointer-events」三条。其中「轮询桶不登记进清扫定时器」是由**既有那条枚举守卫**抓住的（仓库里每个限流 `*Map` 都必须在定时器里），不是新守卫——按「变异各归其主」如实记下。
- **真实浏览器重放原场景**：同样的节奏（12 次刷新 / 31 秒 / 120 个请求）→ **零非 200**，模块区正常渲染 2 张卡。改前是 6 个 429、模块区整个出不来。
- **客户端两处 429 文案**（页面内拦截对应请求返回 429）：监控卡片 →「请求过于频繁，稍后自动重试」（不再是「监控数据读取失败」）；模块区 → 可见、显示「请求过于频繁，请等一分钟再刷新」+ 重试按钮（位置与可点性见下面审查一节）。
- **错误态的几何与交互**（冷启动 + config 打成 429，1440×900）：`data-dock=below`、`position: static`、错误条 `y 524..599`，与搜索框、分类格子的重叠**均为 0**；`elementFromPoint` 落在按钮中心命中的**是按钮本身**；点一下「重试」→ 错误条消失、2 张卡回来。
- `node --check`（全部改动 JS）、`git diff --check` 干净

### 提交前的两轴代码审查（基线 v1.11.6，跑在未提交的工作树上）

**已修**

1. **（规范轴，本轮引入的回归）错误 UI 的「重试」按钮点不动。** 我把 `modulesError` 的判据提前时，**没有把 `zone.dataset.dock` 一起提前**——失败时它没被赋值，`.module-zone` 保持默认的 `position: absolute` + `pointer-events: none`。实测（冷启动 + config 打成 429）：`data-dock` 未设置，错误条以 1396×54 横铺在 `y 48..102`，`document.elementFromPoint` 落在「重试」按钮中心返回的是 `app` 而不是按钮。已把 dock 赋值提到错误分支之前，并给 `.module-zone-error` 单独开 `pointer-events: auto`（它是 `.module-zone` 的**直接子节点**，不在那两条重新打开指针事件的规则里）。

    **修第一处时我自己又补了一刀**：只把 dock 提前还不够——`[data-dock="outside"]`（宽屏）**根本没有自己的 CSS 块**，那个模式靠每张卡片各自绝对定位；错误条是普通 div，于是仍按 `.module-zone` 的基础规则横铺成 `y 48..102` 的全宽条，实测**压住搜索框 19px**（搜索输入 13px），而它 `pointer-events: auto`，会挡住搜索框下沿的点击。所以错误态**一律走 below**（文档流里、分类网格下方的一条横幅）。复验：`y 524..599`、与搜索框和分类格子的重叠都是 **0**、按钮命中自己；点一下「重试」→ 错误条消失、**2 张卡回来**、dock 恢复 `outside`。
2. **（规范轴）`docs/architecture.md` 那条「五条路由全部 rateLimit」过时了**——`GET /api/memos` 已改走轮询桶。已按读/写拆开写。
3. **（规范轴）阈值断言太松**：只断言「是 12 的整数倍且 ≥2 个标签页」，把 120 改成 24 仍然全绿，而 24 会让 3 个标签页就复现本轮那个 bug。已改成钉住文档里推导出的余量（≥10 个标签页）。
4. **（规范轴）新用例里的路由切片末端锚点没断言存在**（`indexOf('(req, res)')`）——正是本仓库记过的 `slice(at, -1)` 坑。已抽成带两端断言的 `chainOf()`。
5. **（规范轴）`res.json()` 抛错时状态码带不出来**：反代自己返回 429 时响应体常常是 HTML，那样又会退回「监控数据读取失败」。已把解析包进 try，状态码与文案不再依赖响应体是 JSON。
6. **（需求轴）我把那条缺陷说成「死代码」，夸大了**：它在**首次加载**时走不到（用户报的正是这条路径），但若此前已有一份 config（例如打开过管理面板），它是能走到的。措辞已改。

**经复核不成立 / 有意留着的**

- **（需求轴）`GET /api/modules/config` 仍在管理桶上** —— 成立，且是**有意留的**，不是遗漏。用户选的方案只点了两条轮询接口；而 config 每次加载只占 **1** 次、**不随标签页数增长**（这正是本轮缺陷的判据：频率是否随用量线性增长），30 次/分钟要 30 次/分钟的加载才打得满。何况它现在 429 时会**把原因和重试按钮渲染出来**，症状是可读的。已把判据改写成「是否随用量线性增长」并写明这一条是有意为之——我原来写的「任何首屏自动发出的请求都不该计在它头上」是过宽的表述。
- **（规范轴）`API.post` 没有带上 `status`**：成立，但当前没有任何 POST 调用方读它。按「没有消费者就不要先建能力」留着，已记为潜在的一致性问题。
- **（需求轴）「12 次刷新零非 200」这类浏览器断言无法从仓库复核**：成立，仓库里没有 e2e 夹具。报告里已标明它是本机实测、非仓库可复现。

### 仍未验证

1. **真实部署上的复验**：本地是回环、单 IP。你在自己环境里可以这样确认：一分钟内刷 8 次以上，模块区应照常出现。
2. 多标签页并发的真实额度：本地只开了 1 个标签页，`120/分钟` 是按「10 个标签页」推导的上限，没在 10 个标签页下实测过。
3. **仍然建议的后续**（不在本轮范围）：`memoLimit` 那只写桶是 30/分钟/IP，如果哪天写操作也要按标签页算，它会是下一个同形状的坑；目前写是用户手动发起的，频率由人决定。

## 上一轮：拉取模式的监控卡片改为显示「最后更新」（v1.11.6）

用户原话（先问后改）：「我增加了一个主机监控，在首页上这个监控模块右下角显示的是延迟，其他的另一台内网主机显示的是最后更新时间，这正常吗？延迟指的是谁和谁之间的延迟？」——答完「正常，是两种采集方式」之后，用户说：「200多 ms 的这个数值展示没有意义，也改成更新时间吧」。

### 为什么那个数没有意义（诊断结论）

卡片右下角的 `213ms` 来自 `latencyMs`（`lib/monitor.js:206` 记开始、`:257` 算 `Date.now() - started`），量的是**本服务 → 目标机 agent** 一次 HTTPS `/metrics` 往返。但它有一个**固定 200ms 的地板**：agent 每次响应都会先 `time.Sleep(cpuSampleGap)`，而 `cpuSampleGap = 200ms`（`agent/main.go:78`；`/metrics` → `collect()` → `:423`），因为 CPU 累计值必须两次采样做差。

实测（本机 darwin 产物，隔离进程启动）：

| | 耗时 |
| --- | --- |
| `nav-agent version`（只启动不采集） | 21ms |
| `nav-agent collect`（采集一次） | 244–264ms |
| 差 | **≈200ms+**，就是那行 sleep |

所以它读起来像网络延迟、其实主要是采样地板。**两种采集方式的差别也让「同一个动作两种结果」**：`server.js:2183` 按 `server.mode` 分流，推送的那台根本不会被连接（永远没有 `latencyMs`），拉取的那台也不会有 `pushReceivedAt`。

### 改动

卡片右下角统一成一句话：**这份数据有多新**。时间来源与文案由新增的 `dataTimeOf(entry, collectedAt)` / `hintTextOf(entry, collectedAt)` 统一取：推送取机器上报时刻（`pushReceivedAt`），拉取取本服务取到它的时刻（聚合结果的 `updatedAt`，每台远端在同一次采集里并发拉、共用一个时刻）。**本机不发这一行**——它是你正在用的那台机器，新鲜度没有信息量（这是产品取舍，不是布局限制；卡片高度本来就按实测排）。

| 文件 | 改动 |
| --- | --- |
| `public/modules/server-monitor.js` | 新增 `dataTimeOf()`（两种模式的时刻来源）与 `hintTextOf()`（右下角文案，**渲染与指纹共用**）；`renderCardBody`/`bodyKeyOf` 收下采集时刻，挂载路径显式传 `null`；卡片与详情面板都不再渲染 `latencyMs`／「响应时间」，改为「最后更新」；本机不发这一行；删掉无消费者的 `data-push-stale` 属性 |
| `public/sw.js` | `CACHE` `nav-v72 → nav-v73` + 注释块记录 |
| `tests/fav-tab.test.js` | 缓存名守卫同步到 `nav-v73` |
| `tests/monitor-agent.test.js` | 新增 1 条（右下角是「最后更新」、不得再出现 `latencyMs`／「响应时间」、本机不发这一行、指纹与渲染共用文案函数、详情面板对称、采集时刻要传下去）；修 4 条既有断言（`bodyKeyOf` 的签名与两个调用点变了）；三处「带延迟提示」的旧注释改成实际含义 |
| `public/app.js` | 只改了一句注释（`stackWidgetsByHeight` 里那处「在线带延迟提示 174px」） |
| `docs/architecture.md` | 补「两种采集方式各有一个时间来源」与「为什么停用 latencyMs」；两处旧措辞改成实际含义 |

### 实测（走真实渲染路径）

本地没有可达的远端主机，所以在页面内拦截 `/api/modules/metrics` 返回**构造载荷**（`updatedAt` = 42 秒前；一台带 `latencyMs: 213`，一台带 `pushReceivedAt` = 8 分钟前），再调 `window.app.renderModuleZone()` 真跑一遍渲染：

| 卡片 | 右下角 |
| --- | --- |
| 本机 | （无这一行） |
| 拉取机（带 `latencyMs`） | 「最后更新 不到 1 分钟前」 |
| 推送机 | 「最后更新 8 分钟前」 |

页面上**不再出现任何 `ms` 数字**。详情面板同样对称：拉取机 = 数据来源「实时采集」+ 最后更新；推送机 = 「目标机推送」+ 最后更新；两边都没有「响应时间」。

### 需要你知道的一件事（不是缺陷，是语义）

**拉取模式下这一行会恒为「最后更新 不到 1 分钟前」。** 因为服务每次轮询都当场去拉，数据按定义是新的——所以它在这里不承担「越久越可疑」那种健康信号的作用（推送模式才有那个作用）。它的价值只剩「这份数据是被采集过的、不是占位」。若你觉得这样也没信息量，下一个可选动作是**让这一行在拉取模式带一个真正的健康含义**：把「最近一次成功采集的时刻」按目标机持久化，失败时继续显示它（像推送那样），这样它才回答「刚才还好好的、还是从来没成功过」。这需要新增存储，不在本次改动范围内。

### 验证

- `node --test tests/*.test.js` → **474 pass / 0 fail**（新增 1 条）
- **红绿 11/11 全部精确转红**（副本内做，工作树未受触碰）。其中「指纹里的时刻不走 `hintTextOf`」这一条是被**另一条既有守卫**（「卡片按内容指纹跳过重建」）抓住的，不是新守卫——按仓库纪律「变异各归其主」，如实记下而不是把新守卫抻宽去覆盖它。
- `node --check`（改动 JS）、`git diff --check` 干净

### 提交前的两轴代码审查（基线 v1.11.5，跑在未提交的工作树上）

**已修**

1. **（规范轴）多处「在线带延迟提示」的旧注释没跟着改**：`public/app.js`、`tests/monitor-agent.test.js` 两处。交接文档当时只写了「改了两处」，实际漏了三处——**文档说改过的地方要按实际清点**。
2. **（规范轴）新用例的切片末端锚点没断言存在**：`mod.indexOf('\n    function ', …)` 在 `renderPanelBody`（模块里最后一个顶层函数）上返回 -1，`slice(at, -1)` 会静默切到文件末尾、长度断言照样通过。改成**按大括号配对**切片，两端都断言（这个 bug 是守卫自己先报出来的：`renderPanelBody 切片末端存在（14288/-1）`）。
3. **（规范轴）指纹与渲染各判一次「本机不发这一行」**：渲染排除 `isLocal`、指纹却把时刻算进去，于是缓存命中的轮次会凭空空重建一次卡片并请求一次重排。抽出 `hintTextOf()` 让两处共用同一个判据。
4. **（规范轴）挂载路径的两个调用点没跟着签名改**：`renderCardBody(body, entry)` / `bodyKeyOf(entry)`。今天无害（挂载时的 entry 是配置合成的占位，既无 metrics 也无时刻），但第三个参数在这条路径上是死参数。已显式传 `null` 并写明「确实没有」。
5. **（规范轴）详情面板那一半改动没有任何断言**：删掉 `add('最后更新', hintText)`、删掉数据来源分支、改标签，测试都仍然绿。已补上面板切片的断言。
6. **（需求轴）详情面板里本机的「数据来源」被我从「缓存/实时采集」改成了「本机直读」**——这是我未声明的改动（用户只提了首页卡片）。已**还原**成原来的两种说法；`本机直读` 若你更想要，是一处独立的小改动。
7. **（需求轴）两条 `doesNotMatch` 把「这个数永远不许出现」钉成了契约**，会挡住架构文档自己写下的下一步（「要给它一个说得清的含义」）。已把范围收窄到卡片与详情面板两个函数内，而不是整份模块。
8. **（需求轴）我给「本机不发这一行」写的理由是错的**：我写「加了会把下面所有卡片整体下移」，而布局本来就按实测高度排、多一行排得下。**理由改成真实的那条**：它是你正在用的那台机器，新鲜度没有信息量。并写明这是可回退的产品取舍、改 `hintTextOf` 一处即可。

**经复核不成立 / 有意不改**

- 「（规范轴）改用 `metrics.sampledAt` 做时间来源」——**不采用**。那是**目标机的时钟**（本机由 `lib/monitor.js`、远端由 `agent/main.go` 各自写 `now`），与浏览器里的 `Date.now()` 跨机做差会被时钟偏差吃掉，与本仓库记过的「两处时间来自不同来源」是同一类缺陷；而 `pushReceivedAt` 与 `updatedAt` 都是**本服务时钟**，两端一致。理由已写进 `dataTimeOf` 的注释。
- 「（规范轴）`latencyMs` 现在是死字段」——成立，但已由架构文档显式记为「目前没有消费者」，且它是**你的拍板项**（删掉／给它一个位置），不在本轮范围内。
- 「（需求轴）拉取模式这一行恒为『不到 1 分钟前』」——成立且已知，已在文档里如实写明，并把「持久化最近一次成功采集的时刻」列为下一步可选项（不在本轮范围）。

### 仍未验证

1. **真实远端主机**：验证用的是构造载荷（代码路径是真的，数据不是）。真实拉取机上的显示需要你在部署实例上看一眼。
2. 真机触摸与真实远端网络下的动画观感，与上一轮同。

## 上一轮：备忘录卡片状态位置、轮询提示与模块出现动画（v1.11.5）

用户原话：「备忘录的"已同步"状态应该放在第一行，不应该占用这么大空间，而且不要一直在前台转圈显示刷新，一是不美观，二是是否会占用更多终端资源。另外给模块加载增加一个淡入或其他动画效果，现在直接冒出来有些生硬」。

三条里有一条是**明确指令**（不要一直转圈），两条留了设计余地。留余地的两条先做了仿真页 `docs/mockup-module-status-motion.html`（工具栏 8 个控件、7 个状态位置/动画变体、可重播），用户看完后按编号选了「1、1」。

### 仿真页揭出的那个坑（决定了最终做法）

「把状态放进第一行」在宽卡片上没问题，但**最窄的一档会挤掉标题**。卡片宽度是 `clamp(132px, (可用宽度 − 936)/2 − 20px, 220px)`，而宽屏两侧停靠的判据只要 `side ≥ 152` 就成立——算下来最窄时卡片正好是 **132px**、头部可用 **104px**：

| 卡片宽 | 状态位置 | 标题可见宽 | 标题 | 卡片高 |
| --- | --- | --- | --- | --- |
| 210px | 现状（独占一行） | 136px | 完整 | 187px |
| 210px | 并入卡片头 | 86px | 完整 | 164px |
| **132px** | 并入卡片头 | **8px** | **被截断** | 164px |
| 132px | 头内 + 管理下移 | 54px | 完整 | 168px |

「标题(33) + 胶囊(41) + 管理(36) + 间隙(16)」需要 126px，头部只有 104px。所以最终做法是**状态胶囊进卡片头 + 「管理」下移到右下角那行小字**——那行本来就在说「点击管理」，不额外占高度。

### 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `public/modules/memo.js` | 卡片头改为「标题 + 状态容器（`span.memo-card-status`）+ 拖拽把手」，**不再有**「管理」按钮；正文不再渲染 `.memo-status-row`，底部小字改成「共 N 条 · HH:MM同步 · 管理」（「管理」是 `data-action="open"` 的按钮）；新增 `fillStatus()`（写卡片头的胶囊 + 底部小字的时刻）与 `syncTimeText()`（四处共用的时刻文案，只在成功态给值）；**点击委托从 `body` 移到 `card`**（见下）；`poll({ manual })`——自动轮询不再进「同步中」态 |
| `public/app.js` | `renderModuleZone` 在开头记下 `wasHidden`，摆好位之后 `if (wasHidden) this.playModuleEntrance(zone)`；新增 `playModuleEntrance()` 与 `static MODULE_ENTER_MS = 260` |
| `public/styles.css` | 新增 `@keyframes moduleEnter` 与 `.module-zone.is-entering .module-widget`；新增 `.memo-card-status`（卡片头里的状态区）与 `.memo-card-manage`（底部小字里的「管理」）；删掉随之失效的 `.memo-status-row` 底边距 |
| `public/sw.js` | `CACHE` `nav-v71 → nav-v72` + 注释块记录 |
| `tests/fav-tab.test.js` | 缓存名守卫同步到 `nav-v72` |
| `tests/memo.test.js` | 新增 1 条（卡片布局：状态在头、「管理」在正文）；改 2 条（`fillStatus` 的写入本身、`manual` 的两个入口计数） |
| `tests/monitor-agent.test.js` | 新增 1 条（出现动画：只在 wasHidden 时播、播完摘类、按动画名过滤、CSS 与 JS 常量一致、关键帧不得动布局属性） |
| `docs/mockup-module-status-motion.html` | 新增仿真页（独立文件，`docs/` 不进发布包） |

### 出现动画的两个承重点（都是实测/推理出来的）

1. **只在「由隐藏变可见」时播**：`renderModuleZone` 还会被主题切换、视口变化、模块开关触发，无条件播会被反复打扰。判据是进入函数时先读到的 `zone.hidden`。
2. **播完必须摘掉 `is-entering`**：CSS 用的是 `animation-fill-mode: both`，最后一帧的 `transform: none` 会被一直保留，而拖拽正是靠 inline `transform` 跟手。摘除走 `animationend`（**按 `animationName` 过滤**——子元素那个无限循环的同步 spinner 也会冒泡 animationend）+ 定时器兜底。实测：动画期间 `transform` 是 `matrix(1,0,0,1,0,0.31)`，结束后为 `none`；随后给卡片写 inline `transform` 能立刻生效（`matrix(1,0,0,1,0,13)`），拖拽换位实测把 `server-monitor > memo` 拖成 `memo > server-monitor`。

### 实测

**出现动画**（冷启动，1440×900）：t=233ms 时 opacity 0.96 / `translateY(0.31px)`（动画进行中），t=356ms 时 opacity 1 / `transform: none` 且 `is-entering` 已摘。

**转圈时机**：连续观察一个完整轮询周期（16.5s）——自动轮询期间**从未**出现 spinner；点面板里的「同步」时**出现**。

**轮询开销**（连测三个周期，而不是单次采样）：

| 周期 | DOM 变更 | 强制重排 |
| --- | --- | --- |
| 第 1 轮 | +7 | +2 |
| 第 2 轮 | **+0** | **+0** |
| 第 3 轮 | +17 | +4 |

未变动的一轮是 **+0/+0**；第 1、3 轮的那些是**分钟翻转**——卡片指纹里含渲染出来的相对时间（备忘的「N 分钟前」）与同步时刻，两者每分钟各变一次，属内容变化而不是每轮开销。改前（自动轮询也转圈）是**每轮固定 +15/+4**。

**最窄一档**（视口 1284，`dock=outside`，卡片实测 132px）：头部可用 104px、需要 104px，**装得下**；标题 54px 未被截断。

窄屏 390×844、拖拽换位、console 均无异常。

### 提交前的两轴代码审查（基线 v1.11.4，跑在未提交的工作树上）

两轴**独立**报出同一条 blocker，我先复现才动手：

1. **（blocker）卡片头里的「重试」是死按钮。** 状态胶囊挪进卡片头后，失败态的「重试」也跟着进了头，而点击委托还挂在**正文**上——卡片头与正文是兄弟节点。实测（停掉服务制造失败态）：点头里的「重试」`handlerFired: false`、一个请求都不发；同一个动作在面板里（委托挂在 `panelEl` 上）正常翻到「同步中」。**这是本轮引入的回归**。改法是把委托从 `body` 移到 `card`。
   根因值得记下来：**把控件挪了位置，却没检查它落在谁的委托范围里。** 光断言「字符串 `poll({manual:true})` 存在」抓不到——那个分支还在，只是永远走不到。
2. **（blocker）一条测试把死按钮钉成了契约。** 我写的 `assert.equal(count, 2, '手动入口恰好两处：卡片上的「重试」与面板里的「同步 / 重试」')` 靠那个**不可达**的分支凑够数。已改为同时钉「委托挂在 `card` 上」与「不得只挂在 `body` 上」。
3. **（should-fix）关键帧守卫只查了 `from` 帧。** 用 `/@keyframes X \{([\s\S]*?)\}/` 会在第一个 `}`（`from` 帧的收尾）就停，往 `to` 帧里塞 `margin`/`padding` 测试仍是绿——审查实测过。已改为大括号配对整段切出，并断言两帧都在里面。
4. **（should-fix）`fillStatus` 的守卫只断言「查询」，没断言「写入」。** 删掉那行 `part.textContent = …` 测试照样绿。已改为钉写入本身。
5. **（should-fix）`animationend` 过滤的注释理由是错的。** 我写「备忘录那个 spinner 也会冒泡 animationend」——但它是 `infinite`，只发 `animationiteration`，永远不会发 animationend。过滤本身保留（防的是以后往卡片里加**有限**动画），注释改成真实理由（app.js、architecture.md、测试注释三处）。
6. **（should-fix，需求轴）面板头现在无条件显示同步时刻。** 把时刻从 `statusPillHTML` 拆出去之后，同步中/失败时会显示**上一次成功**的时刻，像刚同步成功过。已加 `syncTimeText()`：只在成功态给值（这也恢复了改动前的语义），顺手消掉四处重复。
7. **（nice-to-have）** 已修：`.memo-card-status:empty` 是死规则（胶囊永远渲染）、`.memo-status-row` 的 `margin-bottom` 永远被面板头覆盖、底部小字在首次同步前会显示成「共 N 条 · 同步 · 管理」（现在没有时刻就连分隔符一起不渲染）、测试里两处引用已消失符号的注释、architecture.md 与 sw.js 把「+0/+0」说成了每轮（实为**未变动的那一轮**）。

**经复核不成立 / 有意不改**

- 「动画只覆盖模块区由隐藏变可见，启用模块时的重渲染不播」——需求轴自己判为「可辩护且有文档记录，是局限不是偏离」。对照仿真页的说明（用户是在那上面选的这个动画），触发时机就是「首次出现」，不改。
- 需求轴提到 `assert.equal(count, 2)` 会挡住「加第三个手动入口」——已采纳其精神（改成钉委托宿主），但仍保留计数：两处入口各漏一个都会静默不提示。


### 验证

- `node --test tests/*.test.js` → **473 pass / 0 fail**（基线 471 + 新增 2）
- **红绿 17/17 全部精确转红**（副本内做，工作树未受触碰；每条先断言锚点恰好命中 1 次，改后与备份逐字节 `diff` 确认还原）
- `node --check`（全部改动 JS）、`git diff --check` 干净

### 仍未验证

1. **真机触摸**：`(hover: none)` 在本环境恒为 false，与仓库既有记录同一条限制；本轮改的是卡片头布局与动画，触摸端的点击目标（把手 26px、底部「管理」按钮约 20px 高）**没有放大**——这是值得你上手确认的一条。
2. **真实远端网络下的动画观感**：本机回环下动画与数据落地几乎同批；远端网络下模块区会晚一个往返才出现，动画叠在那之后的观感本地复现不了。
3. **一条没能复现的偶发失败**：审查期间有一次全量跑出 472 pass / 1 fail，**没有记下用例名**，随后本机连跑四次、审查方连跑十次都是全绿。按仓库纪律「先重复验证再定性」，此处只作为观察记录，不下结论。若再出现，先抓住用例名再谈。
4. 仿真页里被否掉的「并入卡片头」（不移动「管理」）与几个动画变体仍留在文件里，方便你日后回看比较。

## 上一轮：优化模块加载、首帧动画与轮询开销（v1.11.4）

用户原话：「优化首页模块加载速度及动画，并降低客户端占用」。

先测量再改。用临时副本（端口 4390）+ `agent-browser` 注入探针（记录过渡、强制重排、DOM 变更、资源时序）量出三组数字，然后按用户在两问决策表上选的两项（都取推荐项）实现。

### 改前的实测（这就是三个目标各自的起点）

| 目标 | 改前实测 |
| --- | --- |
| 加载速度 | 模块脚本**串行**：`memo.js` 53→56ms 结束后，`server-monitor.js` 才在 58ms 起请求（要等前一个的脚本下载**加**挂载都完成） |
| 动画 | 首帧叠影 0 次过渡（v1.10.5 的修复仍有效）；但**首轮数据落地**把下面的卡片整体下推：`server-monitor` 卡片 98px → 152px，`memo` 卡片 top 112 → 166（**54px**）+ 1 次 `margin-top` 过渡 + 3 次 layout-shift |
| 客户端占用 | 每 15 秒一轮（2 个模块）：模块区内 DOM 变更 **+48**、强制重排读取 `getBoundingClientRect` **+12**；`memo` 每轮把卡片 `innerHTML` 整块重写**两次**（「同步中」→「已同步」各一次） |

测「首轮位移」时本机回环太快（metrics 只要 1.2ms），`无数据` 那一帧根本拍不到，所以在探针层给 `/api/modules/metrics` 注入了 600ms 延迟——**只延迟响应到达，不碰产品代码**。`agent-browser network route` 没能拦到这个请求（试过 `--abort` 与 `--body`），工具路走不通才走探针。

### 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `public/app.js` | ① `renderModuleZone` 改 `Promise.all` 并发挂载（原来 `for … await` 串行）；② 新增 `waitFirstRound` + `App.FIRST_ROUND_TIMEOUT_MS = 1500`，挂载后等首轮数据再首次布局，`mountModule` 把 `whenReady` 与 `requestStack` 注入 `state`；③ `zone.hidden = false` 也推迟到首轮之后；④ `stackWidgetsByHeight` 改「先读完所有高度、再统一写 `--stack-top`」并对未变的值跳过写入；⑤ 新增 `requestWidgetStack`（同一帧内合并，rAF），拖拽与布局路径仍走同步版 |
| `public/modules/server-monitor.js` | `startPolling` 拆成 `schedulePolling`（只挂表）+ mountWidget 里的显式首轮拉取（promise 交给 `state.whenReady`）；新增 `bodyKeyOf` 内容指纹，`poll` 指纹相同就跳过 `replaceChildren`，只有真的重建过才请求重排；`buildCard` 记下首轮指纹；失败态把指纹置 `!error`；重排改取 `state.requestStack` |
| `public/modules/memo.js` | 新增 `cardKey`（**不含** syncState）/ `renderCardMaybe` / `renderCardStatus`（状态行自己也有指纹）；`setSyncState` 改走 `renderCardMaybe`；同样拆 `schedulePolling` + 交首轮 promise + 取 `state.requestStack`；删掉因此失去调用者的 `stopPolling` |
| `public/sw.js` | `CACHE` `nav-v70 → nav-v71` + 注释块记录 |
| `tests/fav-tab.test.js` | 缓存名守卫同步到 `nav-v71`（仓库既有的每轮同步项） |
| `tests/monitor-agent.test.js` | 新增 3 条（并行挂载 / 首轮等待与超时兜底 / 指纹跳过重建与重排合并）；**修正 1 处切片锚点**（挂表函数从 `startPolling` 改名后 `indexOf` 返回 -1，切片会静默吃到文件末尾——两端都补了存在性断言）；改 2 条既有形状断言（`return visible.map(buildCard)`、以及模块侧的「渲染后请求重排」：写法变了、意图未变）；新用例里的负向断言**收窄了范围**（`visibilityHandler` 里那处合法的 `poll();` 不能被误判成入口拉取） |
| `tests/memo.test.js` | 新增 1 条（卡片与状态行的指纹、手动/自动轮询的区分） |
| `docs/architecture.md` | 模块平台一节补三条新契约（并行挂载、`whenReady`、合并重排） |

### 改后的实测（同一套探针）

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 模块脚本起请求时刻 | 53ms / 58ms（串行） | **50ms / 50ms（并行）** |
| 首轮数据落地时下方卡片位移 | **54px** + 1 次过渡 + 3 次 layout-shift | **0**（0 次过渡） |
| 正常加载时模块区出现 | — | 267ms，出现即终态（152 / 162） |
| metrics 延迟 5 秒（探超时兜底） | — | 1561ms 出现（超时兜底，98px），数据到达后再让位一次 |
| 未变动的一轮轮询 | +48 DOM 变更 / +12 强制重排 | **+15 / +4** |
| 数据真的变了的一轮 | — | +11 / +3（卡片照常更新，实测新增的备忘一条轮询内出现） |

窄屏 390×844（`dock=below` 路径）复测：模块区 366×202、2 张卡、`overflow-x: auto`；备忘录面板可开、手动「同步」可用、关闭正常；console 全程零日志。

**一处被审查驳回、已撤回的改动（记下来免得再犯）**：我起初把「自动轮询不再显示『同步中』」也当作降耗手段（每 15 秒闪一次 spinner 确实是噪音），并写了断言把它钉住。**两轴审查独立指出同一个问题**：这既超出所选选项——指纹本身已经去掉了整块重写，那一行剩下的只是一次就地更新——又与备忘录的既定需求「可通过服务器自动实时同步，**并反馈同步状态**，手动同步时也反馈同步状态」相抵触；而那条断言等于把一个越界的行为变更钉成了契约。**已撤回**：自动轮询与手动同步都照常进「同步中」态。代价如实记在上面那张表里——未变动的一轮因此是 +15 而不是 +0（两次状态行重写各约 7 次变更），仍比改前的 +48 低约三分之二。

### 验证

- `node --test tests/*.test.js` → **471 pass / 0 fail**（基线 467 + 新增 4）
- **红绿 27/27 全部精确转红**（第二轮；在仓库**副本**里做，工作树未受触碰；每条都先断言锚点恰好命中 1 次，改后与备份逐字节 `diff` 确认还原）
- 三轮「守卫自身不成立」的修正，全部由实测/审查抓出，均已改掉并重跑变异：
  1. 「先读后写」原来断言「第一次读在第一次写之前」——**交错写法在源码里读同样在写之前**（循环体只出现一次，重复发生在运行时），该断言会放过真正的缺陷。改为钉「写入循环里没有任何几何读取」。
  2. `zone.hidden = false` 的先后断言用 `indexOf` 命中了**错误分支**里那一处，改用 `lastIndexOf`。
  3. 审查查出三条**实际不成立**的守卫（删掉被测行为仍然是绿）：`_stackFrame = null` 整文件匹配会被 rAF 回调里那一处满足、构造函数里那次初始化没被钉住；`poll({ manual: true })` 出现两次、存在性断言分不清删的是哪一处；`renderCardStatus` 的**唯一作用**（把状态写进那一行）没有任何断言。三条都已按符号锚定重写，并在第二轮变异里各自转红。
- `node --check`（全部改动 JS）、`git diff --check` 干净

### 提交前的两轴代码审查（基线 v1.11.3，跑在未提交的工作树上）

规范轴与需求轴各自起一个子代理，同时跑。逐条自己复现后才动手：

**已修**

1. **（需求轴，blocker）自动轮询不显示「同步中」是越界的行为变更**——详见上文「被审查驳回、已撤回的改动」。两轴独立收敛到同一条，且它是对的。
2. **（规范轴）三条形同虚设的守卫**，见「验证」第 3 条。
3. **（需求轴）`renderCardStatus` 不请求重排**：`.memo-status-row` 是 `flex-wrap: wrap`，失败态多一个「重试」按钮后窄卡片上会折成两行、卡片变高，而这条路径原来不重排，下面几张会停在旧高度。已补上（`if (requestStack) requestStack()`）。
4. **（规范轴）两份一模一样的 `requestStack()` 转发函数**（server-monitor 与 memo 逐字节相同，含回退分支）。改为平台通过 `state.requestStack` 注入，与 `state.api` 同一套机制——模块不再去摸 `window.app` 上的平台方法。
5. **（规范轴）指纹与渲染的取整方式不一致**：`bodyKeyOf` 用 `Math.floor` 取分钟档，而渲染用的 `lastUpdatedText` 用 `Math.round`，两者最多差 30 秒——卡上「最后更新 N 分钟前」会停在旧值。`memo` 的 `cardKey` 有同类问题。两处都改为**直接取渲染出来的文案**（`lastUpdatedText` / `relTime`），指纹与显示值由此必然同步。
6. **（规范轴）注释引用了已改名的函数**（`startPolling` → `schedulePolling`），已改写为「挂表那个函数（它当时叫 startPolling）」。
7. **（规范轴）交接文档一句话与 diff 不符**：写成「收窄 1 条**既有**断言的负向范围」，而那次收窄发生在**新用例**里。已改写。

**经复核不成立 / 有意不改**

- 「`zone.hidden = false` 挪到首轮之后 = 范围蔓延」——不成立。首轮等待的代价「模块区晚约一个往返出现」正是所选选项写明的代价，挪显隐是同一次等待的一部分（否则窄屏会先亮出一个空盒子）。
- 规范轴的「`requestStack` 重复」建议注入——**已采纳**（见上），不是不改。
- 需求轴提到的「server-monitor 里对 `textContent` / `dataset.online` 的两处写入加了相等判断」：方向与总目标一致（降低客户端占用），保留。


### 仍未验证

1. **真实远端网络下的观感**：本机回环下 600ms 是注入的延迟。用户的部署是「国内访问海外服务器」，模块区因此会晚一个往返出现——**这个「晚多久」只能在他的真实网络里看**。
2. **推送模式（push）的首轮位移**：本地只有本机卡片，远端卡片是离线态。推送模式下 `pushReceivedAt` 的相对时间那一行也进了指纹（取分钟档），但没有真实推送源可测。
3. 前端探针注入的那条 `window.fetch` 包装只存在于临时副本的探针里，**没有进仓库**。

## 上一轮：新增「备忘录」模块与随后的三项修复（v1.11.0 – v1.11.3）

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

### 用户第二次反馈：拖不到最下 + 面板观感（v1.11.2）

用户原话：「备忘录模块不能拖拽到最下面一个模块，点开后的编辑界面搜索框太大，按钮也不够精致，需要优化一下」。

**① 拖拽是平台缺陷，不是备忘录独有。** 按用户配置复现（`dock=outside`，卡片 `本机 > 备忘录 > srv461 > srv472`）：把备忘录拖到最下时 DOM 顺序确实变成了 `本机 > srv461 > srv472 > 备忘录`，**但松手那一刻弹回第二位**。根因在 `commitWidgetDrag`——它只给「被拖的那一张」补 `widgets` 条目，其余未登记的卡片在 `applyWidgetLayout` 里按 `Number.MAX_SAFE_INTEGER` 排，永远压在有 `order` 的卡片之前，刚写下的 `order: 3` 被两张 MAX 顶回。用户本机那两张真实服务器卡片正是未登记（`widgets` 里那条 `server-monitor:srv_1` 是已删机器的陈旧项）。**任何新加的服务器都踩同一条。**

改法：松手时对**每一张渲染中的卡片**写 `order`，缺条目就补（`side` 取节点当前的 `data-side`）。复验：拖到最下停住 → 保存编辑 → 读盘顺序正确 → 重载仍在最下；两张原本未登记的服务器卡片也各自拿到了条目。红绿：把这段改回「跳过未登记的」→ 新守卫恰好那一条转红。

**② 观感两项按实测对齐仓库既有的对话框配方**（微调，不是重新设计）：

| 控件 | 改前 | 改后（对齐实测的 `.ui-dialog` 基准） |
| --- | --- | --- |
| 搜索框 | 442×36、抬起的一块 `--bg-card` 浅板 | 442×**32**、**下沉暗槽**（`--bg` + inset 阴影） |
| 标题 / 正文输入 | 同上的浅板 | 同上换成下沉暗槽（与 `.ui-dialog` 输入框同材质） |
| 面板内按钮 | **38px** 高 / **14px** 字 / padding 8px 16px | **35px / 12px / 6px 13px**（与 `.ui-dialog .btn` 逐值相同） |
| 面板高度（空态） | 284px | **243px** |
| 行内小按钮 | pin/✎/✕ 30×30、关闭 32×32 | 28×28、关闭 30×30 |

量到的基准：`.ui-dialog` 的输入框是 40px、`rgb(42,37,33)` + `inset 0 1px 2px rgba(0,0,0,.24)`；按钮是 52×35 / 12px / `6px 13px`。搜索框比基准再矮一档（32px）是照用户「太大」的方向收的。窄屏 44px 触控下限仍由 ≤1023px 块覆盖（已确认规则顺序在 `.memo-panel .btn` 之后）。

**③ 顺带修一条假红**：`tests/api-boundary.test.js` 的「重排必须在写完 order 之后」被我自己新写的注释绊倒——注释里含 `applyWidgetLayout` 字样，`indexOf` 先命中注释、得到 `layoutAt < orderAt`，而代码完全正确。按仓库纪律**在断言前剥注释**（`methodBody(stripComments(appSource), …)`），不是改注释。

**验证**：全量 **467/467**；两条新行为用例（开关落盘、拖拽补条目）各自红绿通过；真实浏览器复现 + 复验拖拽端到端（拖 → 保存 → 落盘 → 重载）与三张截图（空态 / 列表 / 编辑表单）+ 逐控件尺寸实测；焦点落点实测在标题输入框（截图上「← 返回」的亮边是按钮自带的 inset 高光，不是焦点环）。

**一处仍按我的理解做的**：用户说「搜索框太大」，我量到的是**材质**问题（抬起的浅板 vs 应用惯用的下沉暗槽）而不是尺寸（36px 本就比 `.ui-dialog` 的 40px 矮）。所以我把材质换成下沉、并把高度再收 4px。若用户的本意是「宽度 / 字号」，改法是同一处的另外两行。

### 用户第三次反馈：更新说明的措辞太口语化（v1.11.3）

用户原话：「每次更新的说明现在写的太口语化了，要正式一点」。

**先查清三处出口，再动文案**：应用内「更新说明」只渲染 `summary`（`getNewFeatures()` → `.help-new-features-summary`）；`sylph.sh` 更新后打印 `highlights[0]`（`sylph.sh:830-834`）；Release 说明由 `release.sh` 把 `highlights` 全部列成条目。`changes` 数组**不出现在任何界面**，是仓库的技术记录——所以改动只落在 `summary` 与 `highlights`，技术细节原样保留在 `changes`。

**改了哪些**：最近六条（v1.10.3 – v1.11.2）的 `summary` + `highlights` 改写为书面语。语体参照仓库既有条目（「修接入新主机时的证书校验报错」「修正 WebDAV 备份列表的时间显示」），即「修 / 新增 / 修正 + 名词短语」。v1.11.0 的 highlights 里原本带着一条 ⚠️ 旁白（「这条当时其实做不到」），已挪进 `changes.add`——更正记录保留，界面上不再出现旁白。更早的条目（≤ 1.10.2）语体与本轮体例基本一致，未动：它们不进当前界面，改写七十条只会制造格式噪音（本仓库已有过一次「CHANGELOG 整体重排 504 行纯格式噪音」的教训）。

**约定成文**：`AGENTS.md` 第 9 条（`summary`/`highlights` 面向用户、正式书面语、不写口语词/括号旁白/⚠️；更正写进 `changes`；技术细节留在 `changes`）。

**验证**：`node -e` 重新解析证明 JSON 合法（77 → 78 条）；逐条打印改后的 `summary` 与 `highlights` 复核。本轮**未触及 `public/`**，故 SW 缓存名不动——pre-flight 的「包内是否有改动」检查结果为否（与上一轮相反的方向：上一轮 pre-flight 抓到漏 bump，这一轮确认无需 bump）。

**仍未办的一件事**：v1.11.0 / v1.11.1 / v1.11.2 三个 **已发布 Release 页面的说明文字**仍是旧措辞（Release 正文是发布时写死的快照，改它要动已发布内容，属共享状态，已交用户决定）。仓库内的 `CHANGELOG.json` 已更正，所以应用内「更新说明」与下次 `sylph.sh update` 的输出都会是新文案。

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

当前基线：只用 `main` 一个分支（策略见 `AGENTS.md` 第 8 条），代码基线是 v1.12.0（本轮为 WebDAV 自动同步开关 + 修远程备份区块展开失败，发布提交 `dd3a13d`）。`package.json` / `version.json` / `CHANGELOG.json` 三处版本均为 `1.12.0`。历史见各版本 CHANGELOG 条目与文末两节。

⚠️ 本段此前长期滞后：停在 v1.6.12，而仓库已到 v1.10.4——**连续多轮发布都没跟着走**。v1.10.4 那轮按「写基线的义务归每一轮发布收尾，不是可欠的」补齐过一次，但随后又停在 v1.11.6（而仓库实际已到 v1.11.9），本轮发布收尾再次补齐到 v1.12.0。这条义务写成规则也仍会失守，唯一的兜底是每轮发布收尾时真的动手改这一句。

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

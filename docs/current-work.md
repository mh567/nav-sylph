# 当前工作交接

核对日期：2026-09-28。本文供更换开发 Agent 或开发软件时快速接续。开始任务后，先运行 `git status --short --branch` 并检查近期提交，再更新本文件。

## 当前基线

修改前的基线：分支 `main`，与本地 `origin/main` 跟踪引用一致；最新提交为 `9ecc720`；`package.json` 版本 `1.5.6`。

分享功能改动已提交为 `39acce5`，发布前的两个缺陷修复为 `ee77a39`，v1.5.7 发布为 `7ab0981`，分享接口滥用防护为 `d3ee955`，分享编辑器交互改版为 `04895fc`，审计与视觉核验修复为 `ff63fd7`，发布前审查修复为 `e5f3fae`，v1.5.8 发布为 `edff173`，模式切换状态错乱修复为 `14bd923`，v1.5.9 发布为 `382c89e`，分享弹窗紧凑化 `a5a2e00`/v1.5.10 `b4522e2`，收藏弹窗 `7779a64`/v1.5.11 `49f9f28`，横屏与软键盘修复为 v1.5.12，**首页材质改版为 v1.5.13**。

首页材质改版（删站点标识、搜索栏三色按钮、快捷键说明行、书签光影、PC 背板）**已提交并发布为 v1.5.13**，`sw.js` 缓存同步升到 `nav-v22`。设计仿真留在 `docs/mockup-v2.html`，回归测试在 `tests/homepage-material.test.js`（11 条，均经红绿验证）。

## 本次完成的内容（首页材质改版：仿真 v2 落地）

以 `docs/mockup-v2.html` 为准，落到 `public/index.html` 与 `public/styles.css`。**已提交、已发布 v1.5.13**。

### 改了什么

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 删站点标识 | `index.html:35` | `.site-identity` 元素连同两条 CSS 规则一并删除，不留死代码。 |
| 三色按钮 | `styles.css:2726` 起 | 网页/收藏=青灰、引擎=琥珀、搜索=实心陶土。各自 `--HUE` 派生底色与光感，三者共用一条规则。 |
| 快捷键说明行 | `index.html:54`、`styles.css:2852` | 桌面显示，`≤600px` 隐藏（`styles.css:2854`）。 |
| 书签光影 | `styles.css:2817` | 新增 `::after` 顶边高光；浅色光晕 `.32→.46`、悬浮加外投影。**尺寸 96×42 与圆角 7px 一律未动。** |
| 宽屏背板 | `index.html:35`、`styles.css:2866` | `≥1024px` 收进 936px 玻璃面；`≤1023px` 兜底（`styles.css:2880`）完全退回原布局。 |

### 发布后按用户反馈补正的四处（v1.5.13 已含前三处的错误版本）

用户比对后发现引擎按钮与搜索按钮的观感与仿真不一致。用「真实指针悬停/按下 + 逐属性 dump」在两种主题下比对，定位到四处差异：

**已修 1：引擎按钮丢失下拉箭头。** 标记里只有 `<span class="engine-name">`，没有箭头 `<svg>`；而旧样式保留着两条 `.engine-arrow` 规则，样式落在一个不存在的元素上，成为死代码——箭头是「这个按钮能点开」的唯一视觉线索。已补 `<svg class="engine-arrow">`，并把箭头定义整块收进材质层。删除旧的那条 `.search-engine.active .engine-arrow` **不是因为不命中**（`app.js:314` 确实会设 `.active`），而是同一状态有 `.active` 与 `aria-expanded` 两个钩子，保留两条规则会各自旋转一次；统一只认 `[aria-expanded="true"]`。

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
- **我写错的一条理由**：我在注释、`architecture.md` 和测试里都写了「旧样式 `.search-engine.active .engine-arrow` 永远不命中，因为 JS 设的是 aria-expanded」。**这是错的**——`app.js:314` 会同时设 `.active` 类和 aria-expanded，那条选择器本来能命中。删它的真实理由是：同一状态有两个钩子，留两条规则会各自旋转一次，统一只认 `[aria-expanded="true"]`。三处已改正，并补断言禁止 `.search-engine.active` 再长回来。
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

已在材质层新增一条兜底（`styles.css:2865`）：

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

### 四处旧样式残留（浏览器实测才暴露）

**已修 A：收藏态的「打开」按钮是琥珀色。** 旧样式有一条 `.search.fav-search-mode .search-btn { background:#f59e0b }`，特异性 `(0,3,0)` 压过新材质层的 `.search-btn` `(0,1,0)`，实心陶土被换成琥珀底。只在真实浏览器截图里看得出来——单测与 `getComputedStyle` 在未进入收藏态时都测不到。已**删除**该规则（不是覆盖），原位留了解释性注释（`styles.css:1152`），并在 `tests/homepage-material.test.js` 加断言钉住。

**已修 B：说明行在手机上照样显示。** 基础规则 `.search-caption { display:flex }` 原本写在文件末尾的 `≤600px` 块**之后**，同特异性下把块里的 `display:none` 压掉。390×844 实测 `display` 仍为 `flex`。已把基础规则移到 `≤600px` 块之前，并补了一条**断言相对源码位置**的测试——两条规则都「存在」时只有顺序能区分对错。

**已修 C：验证过程中自己的测试是假绿的。** 上面第 B 条最初没被测出来，因为断言只检查「基础规则有 `display:flex`」和「`≤600px` 块里有 `display:none`」，两条都满足，但层叠结果是错的。另外加琥珀色断言时，它匹配到了我自己写的解释性注释里的 `#f59e0b` 字样——剥注释后才是正确判定。

**已修 D：`--kb-inset` 的验证夹具漏字段。** 两次手写 fixture 都漏了 `searchEngines`，页面直接白屏「加载失败」（`app.js:193` 读 `config.searchEngines.find`），报错只出现在浏览器控制台。**对策：fixture 应从服务端默认配置派生，而不是手写。** 手写的那次还误把服务器配置写进了 `config.json`（书签数据文件），并一度用不完整的 `server-config.json` 覆盖默认配置导致 `paths` 丢失——端口改用环境变量 `PORT=` 传递，不要写配置文件。

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
- **软键盘让位 —— 接线已验证，但「键盘本身」仍未复测**。无头浏览器不会真的弹出软键盘，因此直接驱动机制输入：把 `--kb-inset` 置为 300px 后，分享编辑区 `max-height` 从 `420px` 收到 `120px`（`styles.css:637`）。另有两条消费点同样在 `calc()` 内：`styles.css:1629/1637`（收藏弹窗）与 `admin.css:294/295`（UI 对话框）。**这证明接线正确，不证明真机键盘行为一致**——真机仍需看一眼分享编辑区底部按钮是否被键盘遮住。

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

**软键盘适配（`visualViewport`）**。`vh` 与 `dvh` 都不跟随软键盘收缩——这是规范事实，不是本项目的疏漏，因此此前所有 `dvh` 写法都无法解决。新增 `bindKeyboardViewport()`（`app.js:381`）：监听 `visualViewport` 的 `resize` 与 `scroll`，用 `requestAnimationFrame` 合并同一帧内的重复事件，把被遮挡高度写进 CSS 变量 `--kb-inset`；再由各处 `calc()` 消费：

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
- **「`styles.css:2854` 的 `repeat(auto-fill, 96px)` 是死代码」** —— 成立但成因不是"漏写"：它与 2787 行的三列规则同在 ≤480px、同特异性，后者在文件更靠后，因此前者被覆盖。已把 2787 的 `max-width: 304px` 改为 `100%`，两行现在语义一致。
- **「placeholder 偏上是 `padding` 造成的」** —— 部分成立但不是主因。主因是 `styles.css:2772` 在文件末尾的 `font-size: 15px` 覆盖了移动端 16px（会触发 iOS 缩放），次因是 `line-height: 20px` 在 36px 容器内基线偏上。已两者一并修正。
- **「引擎下拉在横屏下可能超出视口」** —— 记录严重性被低估。实测 12 个引擎时横屏 844×390 下超出视口 199px，且 `max-height: none` + `overflow: visible` 无法滚动，**6 个引擎完全选不中**。已修（v1.5.12）。教训：写「可能」之前先量一次。

## 发布流程漏了两步（已补齐）

**现象**：服务器执行 `./sylph.sh update` 提示「已是最新版本」，而仓库已是 1.5.12。

**根因不是 tag，是 GitHub Release。** `sylph.sh:297` 的 `get_latest_release()` 请求 `${GITHUB_RELEASES}/latest`，从 JSON 里取 `tag_name` 与 `.tar.gz` 的 `browser_download_url`；`sylph.sh:698` 拿它和**服务器上的** `version.json`（`sylph.sh:686`）比较。两者都停在 1.5.9 —— 服务器旧版本与缺失的 Release 互相掩盖，看起来像"已经是最新"。

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

## 下一位 Agent 的启动步骤

1. 阅读根目录 `AGENTS.md`、`README.md`、`docs/architecture.md` 及本文件。
2. 核对 `git status --short --branch`、`git log -5 --oneline`、`package.json` 和与新任务相关的代码。
3. 明确本次目标与完成条件，实施后运行定向检查及 `node --test tests/*.test.js`。
4. 在交接前记录实际修改、验证命令与结果、未完成事项。只有发生稳定架构变化时才更新 `docs/architecture.md`。
5. 发布时按 `AGENTS.md` 第 6 条跑 `bash scripts/release.sh`（**不要手写 `git` / `gh`**），完成后用上面的命令确认远端 Release 与本地 tag 都到位——只推分支或只打 tag 都会让 `./sylph.sh update` 停在旧版本。

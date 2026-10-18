# Issue #6 验收记录

日期：2026-10-18。起始提交：`96c1495`（v2.0.0）。实现提交：`7e14244`。Issue：[开放获准公开模块](https://github.com/mh567/nav-sylph/issues/6)。依赖 #4、#5 在基线已完成。本次遵循单 main 开发，不发布版本。

## 范围与验证入口

给模块平台引入**分类边界**：模块在开发时声明 `admin` / `public`，管理员决定哪些公开模块对外开放，普通访客在本地启用并排版。导航、引擎与管理员首页完全不受影响；公开模块的偏好只落本机，不进入任何跨设备同步（云空间仍属后续集成）。

真实 HTTP 使用临时安装、真实会话与真实的 `.modules.json`；浏览器使用本机 Chrome 的隔离上下文（访客与管理员各一个上下文，不共享 Cookie 与 IndexedDB），上游微博热搜用本地桩，避免用例真的连外网。

| Issue 验收要求 | 实现与证据 |
| --- | --- |
| 开发声明 admin/public 分类、可同步配置白名单和校验规则，缺声明拒绝注册；私人模块不能运行时转公开 | `app.js` 的 `App.validateModuleDef` / `registerModule`（缺分类或不合法声明一律拒绝注册）；四个模块声明 `category`，微博热搜声明 `settings.pageSize` 白名单。服务端持 `PUBLIC_MODULE_IDS`，`normalizeModulesConfig` 只收其中 id。测试：`public-modules.test.js`「四个模块的真实声明都能通过平台校验」（**执行**模块文件 + 执行真实 `validateModuleDef`）、「注册被拒绝时不会进注册表」、「公开模块开放名单只收服务端白名单里的 id」（`api-boundary.test.js`）与真实 HTTP「私人模块提交进开放名单被丢弃」。 |
| 备忘录、主机监控、Special Line 分类 admin，微博热搜分类 public；新公开模块默认关闭 | 四个模块文件的 `category`；`defaultModulesConfig.publicModules = []`；访客本机 `enabled` 默认空。测试：同一条声明枚举用例 + 真实 HTTP「未开放时匿名被拒，匿名策略清单为空」+ 浏览器「公开模块默认关闭——要用户自己启用」。 |
| 普通模块启用需同时满足公开分类、管理员开放和用户启用；脚本、数据接口及执行路径独立守卫 | 三条件在 `applyLocalModules`（本机启用 ∩ 开放名单）与 `enabledModuleIds`（再按声明分类过滤）里逐层收窄；数据接口由服务端 `publicModuleAccess(id)` 守卫（撤回即刻 403）。测试：真实 HTTP 越权四连（`/api/memos`、`/api/timeline/events`、`/api/modules/config`、`/api/modules/metrics` 对匿名均 401）+ 浏览器「私人模块不在访客的设置里」。⚠️ 脚本文件本身是静态资源，匿名可取（点 5 已写明：脚本不含数据与凭据，授权落在接口与执行路径上）。 |
| 普通开关布局及偏好保存本地；管理员模块配置存服务端。管理员可使用未对外开放的公开模块 | 访客：同一 IndexedDB 的 `modules` 键（`local-navigation.js` 的 `readModules` / `writeModules`，带修订号乐观并发），`saveLocalModules` 经白名单清洗后落盘。管理员：`.modules.json`。测试：浏览器「访客按需启用公开模块，布局与偏好存本机」（含刷新后恢复、越界偏好被拒并回落默认）与「访客的模块布局存在本机，不进管理员的服务端配置」（拖拽换边后服务端 `widgets` 深度相等）；真实 HTTP「管理员可用自己尚未对外开放的公开模块」。 |
| 关闭后普通设备卸载并停止请求，服务端立即拒绝，保留偏好；联网重新确认策略，未知授权不加载 | 服务端每次请求重读配置（撤回即刻 403）；平台在模块离开启用集合时调 `unmount()` 停表摘监听；本机 `enabled` 不清空（偏好保留）。测试：浏览器「管理员撤回后立刻卸载」（撤回后强制走模块自己的重拉路径，断言零新增请求）、「离线保留已确认的公开模块，联网后轮询恢复」、「重新开放后偏好原样恢复」；单元层「策略刷新失败时沿用上一次已知结果」与「普通访客没有启用任何公开模块时不预加载脚本」。 |
| 热搜实例共享缓存及并发刷新合并；文本分享保持独立匿名流程，不启动普通私人采集任务 | 服务端 60 秒缓存 + `weiboHotInFlight` 单飞合并；`/p` 分享流程本轮未改动。测试：真实 HTTP「冷缓存下 8 个并发请求只打一趟上游」（上游用计数桩）、「开放不启动私人采集」（匿名路径只碰公开策略与模块自身数据接口，时间线与备忘录仍 401）。 |
| 真实 HTTP 及浏览器测试直接越权、策略撤回、布局隔离、离线及重新开放 | `tests/public-modules.test.js`（18 条，真实 HTTP + 真实持久化 + 执行真实方法体）与 `tests/browser/public-modules.cjs`（4 条：启用/布局与偏好、布局隔离、离线与恢复、撤回与重新开放；管理员走真实登录与后台开关）。 |

## 实际检查

- `node --test tests/*.test.js`：**644/644**（基线 625；新增 18 条 + `api-boundary` 1 条）。
- Chrome 回归 **28/28**：`admin-sync.cjs` 10、`local-navigation.cjs` 12、`public-modules.cjs` 4、`template-editor.cjs` 2。入口形如 `NODE_PATH=<含 playwright 的 node_modules> node --test tests/browser/*.cjs`。
- 相关 JavaScript 执行 `node --check`；`git diff --check`；三处 JSON 用 `node -e` 重新解析确认合法。本项目未配置 TypeScript 类型检查命令。
- **变异验证 12 条全部变红，且逐字节还原**：匿名守卫换回 `requireAdmin`；归一化不过滤开放名单；渲染路径不再卸载；微博热搜改成私人分类；白名单不再清洗取值；并发取数不再合并；策略未知也照加载；**登出路径不再整体卸载**（原断言只匹配整文件第一处，会漏掉这一处——变异把它抓出来了）；把 `category` 挪进注释（只匹配源码文本的写法会漏掉）；挂载不再登记已挂载模块；策略刷新失败时清成「未知」；浏览器用例把缓存名写死。
- 首屏预算：`index.html` 未新增任何脚本；未开放/未启用时 `preparePublicModules()` 在 `preloadModuleDefs` 之前返回，浏览器用例断言此时 `/modules/weibo-hot.js` 请求数为 0。

## 审查与整改

两轴在同一份**未提交**工作树上并行执行（固定点 `HEAD`，`git diff HEAD`）。Standards 轴按仓库自己的 `AGENTS.md` / `docs/architecture.md` 判定；Spec 轴按本次需求的原始措辞逐条核对。

已修：

1. **文档失真（Standards 高）**：本次改动使 `docs/architecture.md` 与 `README.md` 的多处陈述变假（「未登录访客不下载任何模块文件」「未登录时不发起任何模块请求」「当前尚未开放任何公开模块配置」等）。已按 AGENTS.md ¶5 更新两处文档，并补写分类边界、撤回语义、`unmount` 契约与 `NAV_WEIBO_HOT_URL`。
2. **断言整文件匹配导致漏检（Standards 高）**：`this.teardownUnusedModules([])` 在源码里有两处，整文件 `match` 命中渲染路径那处，于是删掉登出那处调用照样绿。已限定到各自的宿主方法，并补一条**执行真实 `syncModuleVisibility` + 真实 teardown** 的用例。
3. **注释夸大（Standards 中）**：测试文件头部声称「不是读源码形状」，而当时有两条是纯正则。已把模块声明改成**执行模块文件 + 执行真实校验器**，并在注释里点名剩下那条跨文件登记断言为什么只能是形状断言。
4. **`/api/modules/public` 的注释与事实不符（Standards 中）**：它不是「按页面加载次数打」，而是每 30 秒的周期请求。已改正并写明匿名桶的余量账（约 30 个同 IP 标签页）。
5. **离线语义与设计文档不符（Spec 中）**：策略刷新失败时原实现把 `publicModulePolicy` 清成 `null`，后果不是「本次不加载」，而是已显示的卡片会在下一次渲染被拆掉。已改为沿用上一次已知结果（从未确认过时才保持未知）。
6. 其余小项：删除 `/api/modules/public` 里没有读取方的 `revision` 字段；删掉 `PUBLIC_MODULES_MAX`（白名单过滤之后本就到不了，是死代码）；修正两处计数/切片说明；`local-navigation.js` 的形状校验注释不再声称校验数量与类型；入场的两个常量从源码解析而不是写死字面量。

未修（记录，不改）：

- **四个模块各写一份 `unmount()`**（Standards 中）。三份体逐字相同，第四份形状相同。判断：那三个变量是模块私有的，共用只能靠平台把整个定时器机制收上去，改动面远大于本轮收益；重复的规模已被一条用例钉住（四个模块都必须声明 `unmount`）。理由写进了 `architecture.md`。
- **`NAV_WEIBO_HOT_URL` 覆盖项**（Spec 中，判为轻微范围外）。保留：没有它就无法确定性地测「共享缓存 + 并发只取一趟」（用例会真的连外网），也无法断言上游调用次数。已写进 README 的环境变量说明。
- **脚本本身匿名可取**（Spec 中）。这是 `public/` 静态资源的既有事实，不是本轮引入；已在 `architecture.md` 点明「授权落在接口与执行路径上，不是『脚本拿不到』」。

被推翻的审查发现（记录以免下一轮重复调查）：

- 「`tests/timeline.test.js` 放宽到 900 字符的窗口可能匹配到另一个 `if (!this.authenticated) {`」——复核后确认该文件里 `renderModuleZone` 的分支排在 `syncModuleVisibility` 之前，行为上是良性的；仍按建议改成在 `renderModuleZone` 自己的方法体里匹配（`extractFunction`），不再依赖文件顺序。

## 顺带修正的既有缺陷（非本次引入）

1. `tests/browser/local-navigation.cjs` 的 Service Worker 升级场景把缓存名写死成 `nav-v116`。本轮 `CACHE` 升到 `nav-v117` 后 `replace` 匹配不到，**整个场景变成空转而断言仍然是绿的**。已改为从文件里取当前缓存名，并加一条「替换必须真的改掉了缓存名」的断言。
2. 同一处 `page.waitForFunction(async () => …)` 传入 async 谓词。实测（Playwright + Chrome）：async 谓词返回 `false` 也在 11ms 内「通过」——Playwright 收到 Promise 对象即当真值。断言因此永远不红。已在 Node 侧轮询并在用例里注明实测值。
3. `docs/architecture.md` 里「平台骨架已落地，四个业务模块尚未实现」「编辑入口仅登录后可见」「排序是持久化状态，拖完立即落盘」三条早已过期（分别是 #2–#5 与本地编辑轮的漂移），与本次要写的模块边界直接冲突，一并改正。

## 交付及限制

实现提交 `7e14244`、验收交接 `893c1c2`、版本提交 `baeb37a`；推送后读取远端 `main` 确认为 `baeb37a`。

发布：[v2.0.1](https://github.com/mh567/nav-sylph/releases/tag/v2.0.1)（tag 指向 `baeb37a`，非草稿、非预发布）。按用户指定的「小版本」取补丁号，内容为本任务的公开模块分类与开放授权。下载实际附件核对：`nav-sylph-v2.0.1.tar.gz` 13,514,340 字节，SHA-256 `bc0db4d592dbeaddc92a7bb508408a24ed87aa8906ae74ea6b6fff49a7e7f9fc`，与 GitHub asset digest 一致；包内 `version.json` / `package.json` / `CHANGELOG.json` 同为 2.0.1，`public/sw.js` 的 `CACHE` = `nav-v117`，新功能标记（`validateModuleDef`、`preparePublicModules`、`data-module-open`、`teardownUnusedModules`、`readModules`、`category: 'public'`、`PUBLIC_MODULE_IDS`、`/api/modules/public`、`publicModuleAccess`）齐全，`agent/dist` 仅三个 Linux 产物，私有文件与 `.env` 均不在包内。

[Issue #6](https://github.com/mh567/nav-sylph/issues/6) 七项验收已勾选，[完成说明](https://github.com/mh567/nav-sylph/issues/6#issuecomment-6249117449) 已发布并读取核对；远端状态为 CLOSED、关闭原因为 completed。父 Issue #1 保持打开（其余子任务与综合验收尚未完成）。

未执行：目标服务器、移动实机、两台物理设备、其他浏览器、24 小时容量或断电持久性验收；管理员后台「对普通访客开放」开关在 ≤899px 的窄屏形态与深色模式未逐像素截图核对（功能由真实管理员入口的浏览器用例覆盖，样式仅经源码与规则检查）。本机 Chrome 的隔离上下文证明存储与会话隔离，不能代替物理多设备。

保留与运行中的实例：仓库根目录 `sylph-handoff-2026-10-18.md`（上一会话的未跟踪交接件）原样未动。上一会话的调试实例（PID 42087，`/private/tmp/sylph-debug-vEYrXW`）已按用户要求停止，目录未删除；当前运行的演示实例在 `/private/tmp/sylph-dev-AWfXBj`（127.0.0.1:4000，由本轮代码新装、无私有数据，演示口令只在会话中告知）。

# Issue #11 验收记录：管理员与普通口令同步的完整切换

- Issue：<https://github.com/mh567/nav-sylph/issues/11>（父规格 #1；语义见 `personal-navigation-sync-design.md` §4.1、§5、§6）
- 基线：`24b48c6`（#10 完成）
- 状态：**本地提交，未推送、未发版、Issue 未关闭**
- 范围：几乎全是客户端。身份切换所需的接口（`/api/session`、`/api/logout`、`/api/admin/navigation`、`GET /api/sync/config` 与 #9 的四类终态码）已经齐了，**本轮没有改 `server.js`、没有新增迁移、没有新增 IndexedDB 字段**。

## 核心缺陷（本轮修掉的）

同步引擎只在**入口**判 `authenticated`，在**落盘点**只比连接代次 `connEpoch`。于是：一次普通空间的拉取在飞期间登录管理员，响应回来时**仍会被采用**——而 `recovery` 取的是 `this.config`，在管理员上下文下那就是**管理员个人导航**，它会被写进普通同步记录的 `recovery`。这正是验收第 4 条明令禁止的「管理员草稿落入普通存储」。

修法：**上下文代次复用 `privateEpoch`**（登录 / 退出 / 过期 / 改密四处本来就递增，不新增第二个计数器——同一事实两处各写一遍必然漂移），并统一成一个判据与一个快照：

- `canRunOrdinarySync()` = `!authenticated && !suspendedAdministrator && !identityPending`（**唯一判据**，排程入口与拉取入口都用它）；
- `syncContextSnapshot()` / `syncContextHeld(snap)`：在飞请求**发起时**记 `{conn, home}`，**返回时**两个代次都比、并复查上下文；
- 落盘点：拉取、上传确认、上传的 `finally`（释放认领那一步）都走 `syncContextHeld`；`applyCloudConfig` 在写 `recovery` 与 adopt **之前**再断言一次（最后一道）。

## 逐条验收

### 1. 登录前普通修改落本地、处理表单、暂停普通同步并递增上下文代次、保留普通凭据及待上传

- 落本地/表单/暂停/递增代次/保留凭据都是既有实现（`finishLocalDraft`、`pauseSyncForAdmin`、`privateEpoch++`、`connEpoch` 只由断开推进）；本轮补的是**在飞请求的作废**（上节），否则「暂停」只停调度，挡不住已经在飞的那一次。
- 用例：`sync-engine.test.js`「迟到的拉取不能把管理员配置写进普通同步记录」「迟到的上传确认不能落到管理员上下文里」；`sync-client.test.js` 的 `pauseSyncForAdmin` 调用点计数守卫仍成立（2 处）。

### 2. 管理员编辑、模块和导出不使用普通空间凭据；普通迟到响应不能覆盖管理员首页

- 管理编辑走 `/api/admin/navigation`、模块走 `/api/modules/config`、导出走各自管理接口（`API.request` 对管理前缀要求 `authenticated` 并用 `privateEpoch` 作废跨登录响应）；普通同步的所有落盘现在同样受上下文约束。

### 3. 退出成功清理管理员内容并恢复普通副本，先协调云端再续传，保护登录前修改

- `resumeOrdinarySync()` 顺序固定：**先协调云端**（`syncPullCheck`，终态走 `syncTerminalOf`）→ **再续传**（按**内容指纹**判，不只认 `pending`）→ **最后起轮询**。旧名字 `resumeSyncAfterAdmin()` 保留为转发（调用点不动、实现只有一份）。`clearPrivateState` 调它时把 rejection 收口（#9 的教训：漏掉就是未处理的 rejection）。
- **采用判据修正**：`localDirty = pending || inFlight || 已上传指纹 ≠ 当前指纹`。只看 `pending` 会漏掉「登录前已落盘但还没排上传」的那一版，而它正是最不该被静默覆盖的。改动后「本机有未上传改动时不再自动采用云端」，改走上传 → 409 → 先核对 → 真不同才摆两份候选（不静默覆盖，复用 #8 的既有语义）。
- 用例：「退出管理员：先协调云端、再续传、最后起轮询（顺序不可换）」（按 `calls.gets/posts` 顺序断言）「本机有未上传改动（即使 pending 为空）时也不自动采用云端」。

### 4. 会话过期、网络故障、改密及其他标签页登录退出分别处理，不能将管理员草稿落入普通存储

- 会话过期：`expirePrivateState` 保留草稿、禁普通编辑；普通同步因 `suspendedAdministrator`/`authenticated` 而整体暂停（见下条的口径）✓。
- 改密：`clearPrivateState` + `nav-sylph-auth-reset` 广播 + reload（既有）；**设备令牌不受影响**（存的是哈希）。
- 其他标签页：双通道 `notifyIdentityChanged` → `checkAdministratorSync` 收敛（既有）。
- 「管理员草稿不落普通存储」由 §核心缺陷的修法保证，并有两条行为用例（拉取/上传）钉住。

### 5. 管理员期间普通空间被删除禁用或令牌过期，恢复后按真实状态处理，不影响管理员内容

- 退出后的第一次读就是探活：`resumeOrdinarySync()` 的 `syncPullCheck` 拿到 410/401/403 走 `syncTerminalOf`（删除→断开、撤销/过期→要求重新输口令、停用→保留连接进停用态），**不采用云端、不排上传**；此时 `this.config` 已是普通副本（`clearPrivateState` 先回填），终态处理碰不到管理员内容。

### 6. 启动确认身份前不运行同步，失败时本地可用、私人数据不展示；端到端延迟请求及多标签页测试验证全部路径

- 新增 `identityPending`（显式初始化 ✓）：`restoreSession` 开始时置真、**成功**时置假、**失败时保持真**（确认不了 ≠ 是匿名）；`loadSyncState()` 首行 `await this.waitForSession()`，任何调用点都自动受门保护；门关着时**不发起任何 `/api/sync/*` 请求、不排任何上传**（用例「身份未确认（identityPending）时一个同步请求都不发、也不排上传」）。
- 代价：普通云同步的首次检查晚一个往返（`loadSyncState` 本来就在 `requestAnimationFrame` 之后，**不阻塞首屏渲染**）。
- 浏览器：既有的 `tests/browser/admin-sync.cjs`（10 条）覆盖管理员跨设备同步与「迟到管理员响应不能替换普通上下文」；`tests/browser/sync-space.cjs` / `sync-governance.cjs` 覆盖普通同步的停止/删除/治理。

## 口径说明与取舍

- **未决草稿期间普通同步整体暂停（连读都不发）**：调研建议是「只探活、不采用、不上传」，我选了更保守的一档——`canRunOrdinarySync()` 一处判据同时挡住读与写。理由：草稿未决时用户还在决定要不要放弃，任何自动动作都会让界面状态与他的选择打架；而「恢复」本来就有退出/放弃草稿两条明确路径。用例明确钉住「连读都不发」。
- **没有把身份切换步骤收口成一个 `beginAdministratorContext()`**：两处调用点的上下文不同（一处在 `restoreSession` 的 promise 链里、一处在登录处理器里），收口会牵动既有 await 语义；而 `pauseSyncForAdmin` 的调用点计数守卫仍然钉住「恰好 2 处」，漂移会被发现。记为有意未做。

## 验证数字

- 单元：`node --test tests/*.test.js` = **765 / 765**（基线 759，本轮 +6）。
- 浏览器：`node --test tests/browser/*.cjs` = **37 / 37**（未新增，沿用既有覆盖）。
- 红/绿变异：**6 条里 5 条按预期变红**。例外一条如实记录：「拉取与采用都不检查身份上下文」**没有变红**——原因是这条用例被我自己的另一层守卫提前拦住（记录修订号 CAS 失败 → 异常 → 又被上下文判断静默吞掉），所以它没有隔离到那个调用点。代码保留两层（纵深防御），但**这条守卫的变异没有单独打红**，它目前由「上传确认不能落到管理员上下文」那条用例（同样走 `syncContextHeld` ✓ 已证明可红）与浏览器路径共同覆盖；剩余风险仅限于「该调用点本身被删掉」这一种改动。

## 仍未验证

- 真机移动端、公网时延、目标机（归 #13/#14）。
- 「多标签页 + 身份切换」的**浏览器**端到端只有既有的 `admin-sync.cjs` 覆盖（10 条通过），本轮没有新增浏览器用例；延迟请求的破坏性场景在引擎层用门控 GET/POST 验证（真实现 + 可控释放），没有在浏览器里真的把响应拖慢。
- `identityPending` 不落盘：刷新即重新确认身份（有意，刷新是用户的明确动作）。

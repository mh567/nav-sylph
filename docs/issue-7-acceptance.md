# Issue #7 验收记录：邀请码创建及口令连接云端空间

- Issue：<https://github.com/mh567/nav-sylph/issues/7>（父规格 #1；父规格正文见 `personal-navigation-sync-design.md`）
- 基线：`4ae92d4`（改动前的工作树只有未跟踪的 `sylph-handoff-2026-10-18.md`，本轮未触碰）
- 状态：**已本地提交，未推送、未发布、Issue 未关闭**（三者均待单独授权）
- 本轮范围与显式排除见 `docs/architecture.md` 的「普通口令云端空间（Issue #7）」末节与本文最后两项

## 逐条验收

### 1. 管理员管理一次性 48 小时邀请码及撤销；仅新建消耗邀请，既有空间连接无需邀请码，原子检查竞争创建和邀请消耗

- 实现：`lib/sync-store.js` 的 `createInvite` / `listInvites` / `revokeInvite` / `consumeInvite`；管理员三条路由 `/api/admin/sync-invites`（`rateLimit, requireAdmin`）；UI 在后台「首页导航」分区。
- 验证：`tests/sync-store.test.js`「邀请码 48 小时一次性，撤销与过期都拦住创建」（有效期断言 `expiresAt - createdAt === 48h`）、「既有空间连接不消耗邀请码」（连接前后未消耗的张数都是 0）、「并发创建只有一路成功，且只消耗一张邀请码」；`tests/sync-http.test.js`「真并发创建——同一个口令只有一路成功，只烧掉一张邀请码」（5 路真并发 → `[200,409,409,409,409]`，已用邀请码恰好 1 张；同一张邀请码 2 路 → `[200,403]`）。
- 原子性怎么保证：创建与消耗在**单个 better-sqlite3 事务**里，竞争创建靠 `UNIQUE(proof_id)`，消耗靠 `UPDATE … WHERE used_at IS NULL` 的 `changes === 1` 断言。变异「邀请码消耗改成非原子」与「创建空间不消耗邀请码」各自被上面同一组用例检出。
- 限制：邀请码只存哈希 + 前 4 位提示，明文只在生成响应里出现一次；后台列表不提供「复制旧邀请码」——丢了就撤销重发。

### 2. 口令 6 至 128 个 Unicode 码点、区分大小写、不静默归一化或裁空格、拒绝全空白，首次确认输入并提示共享及遗失风险

- 实现：`App.validateSyncPassphrase` / `App.deriveSyncProof`（`public/app.js`）；对话框「未连接」态的口令 + 再输一次 + 风险提示行。
- 验证：`tests/sync-client.test.js` 的「口令按 Unicode 码点计数」（边界 `MIN`/`MIN-1`/`MAX`/`MAX+1`；`MIN-1` 个 emoji 的 `.length` 已 ≥ MIN，用长度判会误放行，所以这条能真正分开码点与 UTF-16 长度）、「口令既不裁空格也不做归一化」（四种写法派生四个不同证明；NFC/NFD 两种写法不同证明）。
- 浏览器实测：太短 / 全空白 / 两次不一致 / 5 个 emoji / 6 个 emoji 加尾空格五条分支都只在本机拦下，**没有发出任何请求**，文案分别是「口令至少 6 个字符」「口令不能全是空白字符」「两次输入的口令不一致」。
- 限制：派生需要安全上下文；纯 `http://` 局域网下 `crypto.subtle` 不存在，入口会明确提示不可用（见架构文档）。

### 3. 不存在时确认上传本地创建；存在时展示更新时间及条目数，选择云端或本地，保留替换前本地恢复副本，覆盖检查版本

- 实现：`POST /api/sync/space/check` 返回 `{ exists, revision, updatedAt, entryCount }`（`entryCount` 由服务端从分类下的书签数算出）；对话框两态；上传方向以 `revision` 为基线、冲突 409；两个方向都写 `recovery` 到本机。
- 验证：`tests/sync-http.test.js`「检查→创建→两台设备连接→读写版本冲突→刷新复用同一设备」（含 `entryCount === 1`、旧基线写入 409）；`tests/sync-client.test.js`「凭据保存失败不能显示连接成功」的 ③④ 两段断言 `recovery.direction` 与内容：连接既有空间并覆盖云端时留下的是**云端**那一份，采用云端配置时留下的是**本机**那一份（且取自改动之前）；新建空间时 `recovery === null`（云端本来没有内容可替换——这条也做成了变异「新建空间也声称留了替换前的副本」）。
- 浏览器实测：第二台设备看到「该口令已存在云端空间 / 最近更新 4 分钟前 · 9 个条目」，两个方向都走通；采用云端后本机主题从 `light` 变回云端的 `auto`，`recovery` 记录的是 `light`。

### 4. 追加 SQLite 迁移保存空间、代次、版本、设备及邀请；口令连接证明用途和版本隔离，不记明文或 URL 日志

- 实现：`lib/db.js` 数组**尾部追加**第 9 项（`sync_spaces` / `sync_devices` / `sync_invites` / `sync_receipts`），未改动已发布的 0–7；证明派生见架构文档，标签 `sylph-space-connect-v1` 同时承载用途与版本。
- 验证：迁移由 `openDatabase` 在每次真实打开库时执行（`tests/sync-store.test.js` 与 `tests/sync-http.test.js` 全部走真实 SQLite；老库升级路径由既有迁移测试覆盖）。用途隔离：`tests/sync-store.test.js`「换用途/版本标签的证明定位不到空间」与 `tests/sync-http.test.js`「换用途/版本标签的证明定位不到空间，缺令牌读写一律 401」（换 label → `check` 说不存在、`connect` 404）。跨边界常量对拍：`tests/sync-client.test.js` 第 1 条从两份源码各解析出标签并断言一致，且用两侧口径各算一遍证明比对。
- 「不记明文或 URL 日志」的守卫：`tests/sync-client.test.js`「服务端不记录口令、证明或设备令牌，也不从 URL 读它们」——遍历 `server.js` 的每条 `console.*`，断言没有一条提到 `proof`/`deviceToken`/`passphrase`/`inviteCode`；断言没有 `req.query.proof|token`、路由里没有 `proof|token` 字面量；令牌只从 `Authorization: Bearer` 解析。另有「设备令牌只走 Authorization 头，不进 URL」对**每一处**读取断言带令牌。
- 限制：口令与证明用的是快速哈希，不抗离线弱口令猜测（设计文档已声明，不宣称端到端加密）。

### 5. 设备令牌安全随机，仅哈希校验；签发请求 ID 幂等，返回材料短期加密回执，普通凭据不能用于管理员接口

- 实现：`randomBytes(32)` → 只存 `sha256`；`sync_receipts` 存 `credentials` 的 AES-GCM 密文（`sync-receipt` 用途），24 小时；回执还绑定空间代次。
- 验证：`tests/sync-store.test.js`「设备令牌只存哈希，库里任何地方都没有明文」——断言设备表没有 `token` 列、`token_hash` 等于口径一致的 `sha256`、回执是 `{iv,data,tag}` 信封且不含明文、并且**把主库 + WAL + SHM 三个文件按字节读出来**断言令牌明文与口令明文都不在其中。「连接幂等（同 operationId 返回同一令牌、设备不新增）」（两次同 ID → 同一令牌、设备行不增；换个 ID 才新增）。「回执超过 24 小时后先按当前版本协调，不重复签发」（断言回执**恰好一行**，同 ID 重试不新增，过期后换新令牌但仍是恰好一行）。「代次递增后旧令牌与旧回执一律失效」（旧令牌 401，旧回执 `receipt_stale`，新连接拿到当前代次）。「改密码后旧回执解不开」（换了哈希后同 ID 重试 → `receipt_expired`，而已签发的令牌仍可用）。
- 普通凭据不能用于管理员接口：`tests/sync-http.test.js`「邀请码接口只认管理员会话——匿名与设备令牌都是 401」（三条管理员路由，匿名与持合法设备令牌各试一遍，全部 401）。`tests/sync-client.test.js` 另外从源码正向枚举：访客 5 条、管理员 3 条，逐条断言守卫串。
- 限制：`tests/credentials.js` 的密钥随管理员密码哈希，所以改密码后旧回执解不开——改密处理器**清空**整张回执表（不影响已连接的设备令牌）。

### 6. 配置仅允许导航、个人引擎和公开模块偏好，严格 schema、协议、数量和大小校验；不得上传收藏、私人模块或管理字段

- 实现：`validateSyncConfig` 直接复用 `public/navigation-schema.js`（未知顶层键即 400、1 MiB、引擎 ≤50、分类 ≤100、链接 ≤2000、URL 只许 http/https 且不含 `{}`）；`normalizeSyncModules` 只认 `enabled`/`widgets`/`settings` 三个键，模块 id 限定在服务端 `PUBLIC_MODULE_IDS`，值只许标量并有条数/长度上限与 128 KiB 总大小。
- 验证：`tests/sync-store.test.js`「配置只收导航 schema，管理员字段、收藏、私人模块都进不来」（`privacyMode`/`favorites`/`adminToken` → 400；`servers`/`pollInterval` → 400；`settings` 的嵌套对象与超长文本 → 400；私人模块 id 的 enabled/widgets/settings **不落库**——直接读 `modules_json` 断言）；`tests/sync-http.test.js`「上传的配置受严格 schema 约束，管理员字段与私人模块进不来」（真实 HTTP 上再验一遍，含缺 `revision` → 409）。变异「私人模块 id 放行入库」被检出。
- 限制：`settings` 的内容只做类型/数量/大小约束，**不按各模块声明的白名单逐键校验**——那份白名单住在客户端模块文件里，服务端复刻一份必然漂移；客户端侧仍有 `sanitizeModuleSettings`。

### 7. 两浏览器真实 HTTP 和 UI 完成创建连接，刷新复用设备连接，无固定设备数量限制；凭据保存失败不显示连接成功

- 真实 HTTP：`tests/sync-http.test.js` 9 条全部跑在真实服务进程 + 临时安装 + 真实会话 + 真实 `.modules.json`/SQLite 上（`tests/helpers/installation.js`）。
- 无固定设备数量上限：`tests/sync-http.test.js`「设备数量没有固定上限（连 20 台各拿一枚可用令牌）」——20 枚令牌互不相同且每台都能读。
- 凭据保存失败不显示连接成功：`tests/sync-client.test.js` 执行**真实的** `finishSyncConnection`——把落盘打桩成抛错后，状态序列里只出现 `error`，绝不出现 `connected`。浏览器实测：把 `localStore.writeSync` 打桩成抛错，对话框显示「未能保存到本机，连接未建立：配额已满」、页脚仍是「同步」、`window.app.syncConnection` 为 `null`，本机也没有留下记录。
- 两浏览器 UI：**手工驱动**（agent-browser，树外临时副本 + 管理员会话 + 两个独立访客会话 + 清 SW/caches 预检）。路径：管理员生成邀请码 → 访客 A 输口令 + 确认 → 「该口令还没有云端空间」→ 填邀请码 → 「用本机配置创建」→ 已连接；访客 B 同口令 → 「已存在 · 9 个条目」→ 分别走完两个方向；访客 A 刷新 → 仍为已连接、「云端版本 3」、主题是 B 上传的那一版，且服务端设备行**不新增**（4 → 4）。截图已读取（后台邀请码区、已连接对话框、390px 窄屏的三按钮态）。
- ⚠️ 这一条的**可重复性**不足：UI 验收是手工驱动的，仓库约定的 `tests/browser/*.cjs`（Playwright）**本轮没有写** ——本机没装 Playwright，写一份跑不起来的用例比不写更糟。已列为后续项（接入方式与既有四个 `.cjs` 相同）。

## 实际验证命令与结果

```
node --test tests/sync-store.test.js      # 17/17
node --test tests/sync-http.test.js       # 9/9
node --test tests/sync-client.test.js     # 8/8
node --test tests/*.test.js               # 678/678（基线 644，本轮 +34）
node --check server.js lib/sync-store.js lib/db.js lib/credentials.js \
  public/app.js public/local-navigation.js public/sw.js \
  tests/sync-store.test.js tests/sync-http.test.js tests/sync-client.test.js
git diff --check
```

红/绿变异 **13 条全部变红，且源文件逐字节还原**：邀请码有效期 / 原子消耗 / 不消耗邀请码 / 设备令牌不比对代次 / 回执不比对代次 / 私人模块放行 / 签发回调拿掉 / 码点计数 / 裁空格 / 落盘失败仍置已连接 / 新建也声称留了副本 / 探活漏令牌 / SW 缓存号。

## 未验证与后续

1. **可重复的浏览器回归**（上面 7 的 ⚠️）——后续项。
2. **多 IP 下的每空间签发桶**：单 IP 时连接桶（同值 30/分钟）会先挡住，所以那条上限的行为只在多 IP 下可观察；行为用例直接驱动 store 回调，未做多 IP 端到端。
3. 目标服务器、移动实机、真机软键盘与窄屏横排、两台**物理**设备（本轮用同一浏览器的两个独立会话模拟）、容量与时效（归 #8/#13/#14）。
4. 纯 `http://` 局域网下不可用（需 HTTPS 或 localhost）。
5. 新建空间时若客户端落盘失败，服务端会留下一行未被使用的设备令牌（90 天无鉴权后清理；空间数量无固定上限，属冗余不是泄露）。
6. 设计默认的 1000 空间 / 1 GiB 总量配额未实现（归 #10）；`disabled`/`revoked`/`used_space` 三个字段本轮无写入方（#9/#10 立刻要用，迁移台阶只该加一次）。

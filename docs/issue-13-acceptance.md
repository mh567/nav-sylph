# Issue #13 验收记录：可回滚且不覆盖并发修改的恢复

- Issue：<https://github.com/mh567/nav-sylph/issues/13>（父规格 #1；语义见 `personal-navigation-sync-design.md` §8、§10、§11）
- 基线：`c9036c2`（#12 完成）
- 状态：**进行中——只做完第一段（服务端核心）**。本地未提交、未推送、未发版、Issue 未关闭。

---

## 进行中：已完成 X / 未完成 Y / 下一步 Z / 当前全量数字

**已完成（第一段：服务端核心，1–7 全做，含测试）**

1. `lib/admin-lock.js`（新增）：进程内单锁 `acquire(kind, domains)` / `release()` / `current()`；
   `rejectIfBusy(domains)` 中间件（503 + `code:'busy'` + `Retry-After: 5`）；`drainInFlight(domains, timeoutMs)`
   经 `configureDrainers()` 注入排空器（时间线 `scheduler.stop()` + 轮询 `isRunning()`；监控采集等 `metricsInFlight`）。
2. 迁移 **v12**（只追加）：`restore_records`（id/phase/domains_json/applied_json/plan_json/before_json/
   snapshot_dir/failure/generation/created_at/updated_at）+ 两个索引。v9–v11 一字未改。
3. `lib/restore.js`（新增）：快照读写（`<rootDir>/.restore-snapshot/<runId>/`，0700/0600，temp→rename，
   同时存「改之前」与「要改成什么」）、逐域适配（`memos`/`favorites`/`modules`/`timeline` 的 snapshot/apply/restore）、
   写前记录、逐域应用（每域成功即追加 `applied_json`）、失败**逆序回滚**、回滚也失败 → `phase='halted'`、
   成功才递增受影响版本（`favorites.revision`、`.modules.json` 的 `_sync.revision`、`restore_records.generation`）。
4. `recover()`：在 `init()` 内、`server.listen` 之前调用；`applying` 续做（缺料转回滚）、`rolling_back` 继续、
   `halted` 不自动重试（受影响域读写 503 `restore_halted` + `/api/health` 报 `degraded`）。
5. 预览与恢复接口：`POST /api/webdav/restore/preview`（只读，出清单 + `planDigest`）；
   `POST /api/webdav/restore` 带 `planDigest` 复验（不一致 → 409 `stale_plan`），全程持锁、排空在途、快照、写前记录。
6. 合并：`mergePrivateModules`（#12）+ 本轮新增的 `normalizeServerDeployment()` 与
   `filterUnknownModules()`（未知 id 跳过并报告）；旧备份只恢复书签，导航/引擎/模板进 skip 并给原因，
   `published`/`draft` 永不触碰。
7. 测试：`tests/restore-merge.test.js`（6 条纯函数）、`tests/restore-http.test.js`（5 条真实 HTTP + 临时安装 +
   本地 WebDAV 桩）、`tests/restore-recovery.test.js`（5 条直接调 `recover()` 的三态）。

**未完成（第二段，本段刻意不做）**

- `public/app.js` 的恢复对话框（清单文案、旧备份提示、409 文案、「需重新授权」清单）、不可关闭的 halted 横幅；
- `public/sw.js` 缓存号 +1；
- `docs/mockup-webdav-restore.html` 仿真样例；
- `tests/browser/restore.cjs`（真实浏览器：恢复后一致、恢复期间第二个标签页保存被拒）；
- `docs/architecture.md` 的 #13 一节、`docs/current-work.md` 交接、README/DEPLOYMENT 的故障手册；
- 本记录的逐条验收勾选（要等第二段与浏览器验收补齐）。

**下一步 Z（第二段的第一件事）**

在 `public/app.js` 的 `renderWebDAVSection` 里把恢复流程改成两段：先 `POST /api/webdav/restore/preview`
渲染 `plan.domains` / `plan.skipped` / `plan.pendingAuthorization` / `plan.versions`，确认时把
`planDigest` 一起 POST；同时处理 409 `stale_plan`（提示重新预览）与 503 `busy` / `restore_halted` 的文案。

**当前全量数字**

- 单元：`node --test tests/*.test.js` = **796 / 796**（基线 780，本段 +16）。
- `node --check`：`server.js`、`lib/admin-lock.js`、`lib/restore.js`、`lib/db.js` 全过。
- `git diff --check`：干净。
- 变异证红 4 条（逐字节还原后 `cmp` 一致）：回滚不真还原 → 红；`planDigest` 不复验 → 红；
  并发写不被锁拦 → 红；`halted` 之后不拦受影响域 → 红。

---

## 逐条验收（第一段能给的证据；标注「须第二段」的尚未完成）

### 1. 恢复前校验版本大小及内容，展示将恢复与跳过项目；旧备份不恢复导航引擎或默认模板，明确提示

- 预览：`lib/restore.js` 的 `preview()` → `plan.domains[]`（`action: restore|skip` + `count` + `reason` +
  `revisionBefore/After`）、`plan.skipped[]`、`plan.pendingAuthorization[]`、`plan.unknownModules[]`、`plan.versions`。
- 内容校验：远端文件字节 sha256 与清单 `included[].sha256` 对拍（#12 的 `restoreBackup` 已有，本段沿用）；
  旧备份（`type:'nav-sylph-backup'`）只出 `favorites` 一个 restore 域，`admin-navigation`/`default-template` 进 skip。
- 证据：`tests/restore-http.test.js` 用例 1（预览清单、四域将恢复、`metrics-cache` 派生域进 skip 且有原因、
  新版本号 = 当前 +1）与用例 5（旧备份只恢复书签 + skip 原因）。
- 界面展示：**须第二段**。

### 2. 恢复与管理员配置写入共用协调锁，拒绝受影响域新写入；暂停并等待在途任务，恢复和备份互斥

- 锁：`lib/admin-lock.js`；判定点收在 `requireSession()` 里（`server.js` 的「非 GET/HEAD 且 `adminLock.isBusy()`」），
  一处覆盖全部管理写路由（含 `/api/change-password`、`/api/webdav/*`、`/api/modules/*`、`/api/admin/navigation`、
  `/api/favorites`、`/api/timeline/*`）。拍定：恢复期间**不受影响域的管理写也拒**。
- 互斥的另外两侧：`runAutoSync()` 开头复查锁（`autoSyncSuppressed` 挡不住已在飞的那一次）；
  手动备份走 `requireSession` 的同一道闸。
- 排空：`drainInFlight(['timeline','metrics-cache'])`，时间线先 `scheduler.stop()` 再轮询 `isRunning()`，
  监控采集等 `metricsInFlight`；顺序 `acquire → drain → 快照/应用 → 缓存重建与 `scheduler.start()` → release`。
- 证据：`tests/restore-http.test.js` 用例 4（恢复进行中另一个保存请求 503 `busy` + `Retry-After`，且没落地）；
  变异「并发写不被锁拦」→ 红。

### 3. 建立恢复前快照和持久恢复记录，JSON 与 SQLite 跨存储替换失败完整回滚，进程中断重启先完成恢复或回滚，禁止半套状态开放

- 快照：`.restore-snapshot/<runId>/`（0700/0600，temp→rename），含 `before.favorites.json`、`before.modules.json`、
  `before.db.json`（时间线凭据**只在快照里**）、`incoming.json`、`SNAPSHOT.json`；成功收尾即删除。
- 记录：迁移 v12 的 `restore_records`；`phase ∈ applying/applied/rolling_back/rolled_back/halted`。
- 回滚：按 `applied_json` 逆序；文件域**逐字节**还原（解析再序列化会改键顺序与 `_sync.revision`）。
- 重启：`recover()` 三态；`applying` 续做、缺料转回滚、`rolling_back` 继续、`halted` 不自动重试。
- 证据：`tests/restore-http.test.js` 用例 3（时间线域写失败 → rolledBack = `['modules','favorites','memos']`、
  两个文件 `deepEqual` 逐字节不变、库里行不变、`generation` 仍为 0）；
  `tests/restore-recovery.test.js` 五条（续做 / 缺料转回滚 / 继续回滚逐字节还原 / 回滚也失败转 halted / halted 的人工出口）。
  变异「回滚不真还原」→ 红。

### 4. 成功递增受影响版本使旧基线失效；失败回滚保持原版本，回滚失败暂停受影响服务

- 成功：收藏 `revision +1`、`.modules.json` 的 `_sync.revision +1`、`restore_records.generation +1`；
  管理员导航 revision 不动（本轮永不动它）。
- 失败：文件逐字节回到恢复前 ⇒ 各域 revision 与恢复前完全相等（用例 3 断言 `versions.before` 不变）。
- `halted`：受影响域读写都 503 `restore_halted`（`restoreHaltedGuard` 挂在 `/api/favorites`、`/api/modules`、
  `/api/timeline`、`/api/admin/navigation`、`/api/memos` 的路径前缀上）、`/api/health` 报 `status:'degraded'` +
  `haltedDomains`；快照保留（人工恢复的唯一依据）。
- 证据：用例 1（版本递增 + `restored.restoreGeneration === 1`）、用例 3（失败不递增）、
  `restore-recovery.test.js` 的 halted 两条；变异「halted 不拦受影响域」→ 红。
- ⚠️ 诚实边界：`favorites.revision` 目前**只由恢复路径维护**。其余收藏写入（`POST /api/favorites`、
  导入）写的是 `{version, favorites}` 且不带 `revision`，所以它是「恢复代次印记」而不是严格单调的计数器。
  它没有客户端基线消费者（收藏侧本来就没有「旧基线 409」语义），本轮不为它新增一套校验；如果将来需要，
  要把所有收藏写路径统一到 `lib/versioned-modules.js` 那种带幂等回执的写法（属于另一件事）。

### 5. 仅合并私人模块项，保留公开模块项及相对顺序，未知项报告，缺失凭据显示待授权或部署

- 合并：`mergePrivateModules`（#12）+ 本轮 `normalizeServerDeployment()`（只按「本机有没有 `certPem`」定
  `pending` / `not_deployed`，不看备份那台机器的观测）+ `filterUnknownModules()`（判据是随包携带的
  `public/modules/<id>.js`，未知 id 跳过并在 `plan.skipped` 与 `plan.unknownModules` 里报告）。
- 凭据不回填：同 id 的机器只补布局、令牌仍是本机的；新机器 `token` 恒为 `undefined`，进 `needsAuthorization`。
- 证据：`tests/restore-merge.test.js` 六条（顺序与紧凑序号、凭据不回填、`pending` vs `not_deployed`、
  未知 id 报告、「私人模块被清空后仍能恢复」的场景、`planDigest` 敏感性）。

### 6. 重建模块缓存后恢复任务，测试另一设备竞争保存、旧任务完成、故障注入、中断重启及新旧备份

- 恢复成功后：`invalidateMetricsCache()` + `timeline.scheduler.start()`（drain 停过它，失败路径也放回去）。
- 已覆盖：故障注入（用例 3）、中断重启（recovery 用例）、新旧备份（用例 5）、竞争保存（用例 4，503）。
- **未覆盖**：「另一设备的新修改不被覆盖」的**真实并发时序**（两台设备在同一时刻保存同一域）与
  真实浏览器里的第二个标签页（`tests/browser/restore.cjs`）**须第二段**。

## 验证数字与命令

```
node --test tests/*.test.js        # 796 / 796
node --test tests/restore-merge.test.js tests/restore-http.test.js tests/restore-recovery.test.js  # 16 / 16
node --check server.js lib/admin-lock.js lib/restore.js lib/db.js
git diff --check
```

## 本段额外做的决定（每条一句理由）

1. **`planDigest` 对旧客户端可选**：`tests/backup-scope-http.test.js` 等既有真实 HTTP 用例不带它，
   而本段的改动范围不允许改那些测试；不带 digest 时仍然走锁/快照/回滚，只是少了「请重新预览」这一步。
2. **`memos` 也进逐域适配表**（交付清单只点名四个域）：它是 SQLite 整表替换，若不参与回滚，
   时间线域失败后会留下「备忘录已是新、其余已回滚」的半套状态。
3. **未知模块 id 的判据是 `public/modules/*.js`**：服务端没有第二份模块注册表，而用「当前配置里的 id」
   会把「私人模块被清空后恢复」这一典型场景全部误判成未知。
4. **机器状态按 `certPem` 归一**：`mergeServers` 信的是备份那台机器的 `deployState`，跨安装没有意义；
   #13 的口径是「缺 `certPem` → `not_deployed`」。
5. **本机已有令牌的机器不算待授权**：备份里没有它的令牌、但本机那份还在，否则界面会让用户去重新授权一台正在上报的机器。
6. **排空超时不失败**：把用户锁在「点了恢复但永远失败」比接受一次可能交错的在途写更糟（日志留痕）。
7. **`halted` 时 `/api/health` 仍返 200**（`status:'degraded'`）：用 503 会让「整站挂了」与「一域暂停」看起来一样，
   而启动探测（`tests/helpers/installation.js`）也读 `.ok`。
8. **`__test` 钩子**（`writeSnapshot/insertRecord/setPhase/noteApplied`）：`applying` 现场无法从 `apply()` 触发
   （它自己会推进到 `rolling_back`），与 `lib/timeline/service.js` 的 `__test` 同一手法。
9. **WebDAV 桩在本测试文件内复制一份**（不新增 `tests/helpers/*`）：#12 的桩是内联局部函数、没有导出，
   而本段允许新增的文件只有 `tests/restore-*.test.js`。

## 仍未验证

- 界面与真实浏览器（第二段）；真实第三方 WebDAV（只用合成上游）；目标机与公网时延归 #14。
- `favorites.revision` 的跨路径一致性（见上面第 4 条的诚实边界）。

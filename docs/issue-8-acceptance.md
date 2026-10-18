# Issue #8 验收记录：自动同步和多端冲突处理

- Issue：<https://github.com/mh567/nav-sylph/issues/8>（父规格 #1；语义见 `personal-navigation-sync-design.md` §5、§10）
- 基线：`5c72c5f`（改动前的工作树只有未跟踪的 `sylph-handoff-2026-10-18.md`）
- 状态：**未推送、未发布、Issue 未关闭**（实现提交见交接文档）
- 这一轮几乎全是客户端：#7 已经把服务端协议做完了（revision 基线校验、409、`operationId` + 24 小时回执、代次绑定）；#8 补的是「什么时候读、什么时候写、冲突了怎么办、多标签页谁动手」，外加服务端两处接缝（可选的 `generation` 校验、写响应补 `generation`/`updatedAt`）。

## 逐条验收

### 1. 本地修改合并 500 毫秒上传，持续操作最长等 2 秒，同浏览器一个上传在途；后续修改合并下一次

- 实现：`markSyncDirty()`（唯一触发点，挂在两处本地保存的**成功之后**）→ `scheduleSyncUpload()`（防抖 500ms + 上限 2s，上限**不从**连续改动重置）→ `uploadOnce()`（`syncUploadInFlight` 单飞，在途期间只置 `syncUploadAgain`，完成后排下一轮）。
- 真实浏览器实测（本机 localhost + 页面内注入 200ms 往返，`performance.now()` 量到 `fetch` 真正发出）：单次改动 → 上传 **510ms**；每 200ms 改一次、连改 3 秒（15 次改动）→ 首次上传 **2006ms**（上限 2000ms + 约 6ms 的落盘与认领），整批 15 次改动合并成 2 次上传。
- 用例：`tests/sync-engine.test.js`「防抖」「2 秒上限」「单飞」（假时钟推进，不真实等待）。变异「去掉 2s 上限」「单飞去闩」各自被对应用例检出。

### 2. 打开、恢复可见及网络恢复立即读取，可见页 30 秒检查，隐藏暂停；失败指数退避最长 5 分钟

- 实现：四个触发点（首屏之后、`visibilitychange`→可见、`online`、`setInterval(30s)` 且隐藏时 `clearInterval`）；`scheduleSyncRetry()` 从 1s 翻倍到 300s，成功后归零，`online`/恢复可见/「立即同步」都立即取消退避。
- 用例：`sync-engine.test.js`「退避」「轮询」「网络恢复/回到可见」「管理员会话生效期间暂停调度」；接线（三个监听器都在 `bind()` 里、隐藏时停轮询）由 `tests/sync-client.test.js` 的接线守卫正面枚举。
- 真实浏览器实测（持续可见设备，注入 200ms 往返）：三个自然相位下「服务端提交 → 接收端显示」= **775ms / 18114ms / 18145ms**；随后**刻意构造最坏相位**（把该设备的轮询相位重置到已知零点，让提交落在一次 tick 之后 1.2 秒）= **29030ms**，即「下一次 tick + 一个 RTT」。上界由构造决定：30s + RTT ≤ 32s。

### 3. 云端基线 revision 与空间代次事务校验，冲突 409；保留两个候选按整份选择并再次校验，不自动逐字段合并

- 服务端：`writeConfig` 在**同一个事务**里鉴权、比代次、比基线；`generation` 只在**带上且不一致**时拒绝（409 `generation_mismatch`），不带则照旧——v2.0.2 已在跑的客户端不会因为这次加字段而写不进去。
- 客户端：409 之后**先读一次核对**（内容一致 → 视为已生效，清 pending 置已同步；不同 → 摆两份候选）；`conflict` 态并排两个方向 + 「导出两边」，不逐字段合并；两个方向都会先把被替换的那一份写进 `recovery`。
- 用例：`tests/sync-http.test.js`「写配置——同基线并发只有一个成功」（真并发 `[200,409]`）、「写配置带错的空间代次」、「上传的配置受严格 schema 约束」；`sync-engine.test.js`「409 先核对再报冲突」「冲突裁决」「冲突裁决「保留本机」」。
- 真实浏览器实测：构造过期基线后设备进入 `conflict`（页脚「同步冲突」），两份候选分别是本机与云端的标记；「保留本机」→ 云端 revision +1 且内容是本机那份；另一端「采用云端」→ 本机被替换为云端那份，`recovery` 记录的是被覆盖的本机内容。

### 4. 稳定 operationId 与待上传内容持久保存；配置、版本、成功回执原子提交，相同 ID 同内容返回原结果，不同内容拒绝；回执 24 小时后先协调版本

- 客户端：`pending = { operationId, content, localRevision, baseRevision, createdAt }` 在 POST **之前**写进 IndexedDB 的 `sync` 键，重试与重启复用同一个 ID。
- 服务端：配置 + revision + 回执在同一次事务提交；同 ID 同内容返回**原提交结果**（不重复写入），同 ID 不同内容 409 `operation_conflict`；回执 24 小时。
- 用例：`sync-http.test.js` 的并发写用例里包含了重放（`deepEqual(重放, 原结果)` 且 revision 不变）与「同 ID 换内容」；`sync-engine.test.js`「24 小时之外的回执」（先核对：内容一致 → 清 pending 收工；不同 → 进冲突，**不盲目重提**）。
- 真实浏览器实测（响应丢失）：让第一个 POST 真的提交到服务端但把响应丢掉 —— 重试复用**同一个 operationId**（两次 POST 的 id 字符串相同），云端 revision 只 +1（`delta: 1`），最终收敛到 `synced`。

### 5. 本地修订和连接代次保护读取及上传确认；迟到响应不覆盖新修改，旧回执不被当作最新全量配置

- 每个在飞的读/写记下发起时的 `syncConnEpoch` + `localRevision`，回来时任一变则整份丢弃；连接代次在连接与清除连接时递增（`clearSyncConnection` 递增后，旧连接的在飞上传既不改状态也不写记录）。
- 上传确认只确认**实际发出的那一版**（`pending.localRevision`），`uploadedLocalRevision` 落在记录里、跨重启有效；成功之后**再读一次**云端（回执给的是那次提交的结果，不是现状）。
- 用例：`sync-engine.test.js`「上传确认只认「实际发出去的那一版」」「迟到响应不覆盖新修改」「清除连接会递增本机连接代次，之后旧连接的响应一律作废」「云端版本比本机已知的更旧时不采用」。
- 变异：「迟到响应照常采用」「清除连接不递增连接代次」「采纳更旧的云端版本」各自被对应用例检出。

### 6. 浏览器锁或 IndexedDB 事务协调多标签页，BroadcastChannel 通知，草稿受到保护；状态仅在真实成功后显示已同步

- 「已同步」的判据是**内容指纹**（`syncPayloadKey()`）而不是导航那条记录的修订号——后者对**模块改动不敏感**，用它判会把「模块改完还没传上去」显示成已同步（审查发现，已修）。浏览器复验：只改模块开关（不动导航）后立刻触发一次拉取，状态是「同步中」；上传落地后才变「已同步」，云端 `modules.enabled` 跟着变成 `['weibo-hot']`（revision 28 → 29）。

- 协调：不引 `navigator.locks`（本仓库已有一套「乐观 revision + BroadcastChannel」，再加一条路径必然漂移，且这条不引进被接线守卫正面钉住）。跨标签页单飞靠记录里的 `claim`，与 `pending` 写在**同一个事务**；读到别人的新鲜认领时**先问一声**（`claim-check` → `claim-held`），没人应答就接手。
- 通知：`BroadcastChannel('nav-sylph-space-sync')` 只负责「现在去看一眼」，正确性不依赖它。
- 草稿保护：`hasLocalDraft()`（复用管理员侧判据的形状，**不含**同步对话框自己）→ 有草稿时拉取到的云端内容不采用，只提示。
- 「已同步」的判据：`uploadedLocalRevision === localRevision` **且**服务端确认过；所有状态变更收口到 `setSyncStatus()`。
- 用例：`sync-engine.test.js`「多标签页：认领还活着就不动手；没人应答（标签页已关/刷新）就接手」「认领握手」「有草稿时不采用云端内容」「没有待上传也没有草稿时，较新的云端配置会被采用并落盘」「重开页面」。
- 真实浏览器实测：刷新后设备行不新增（沿用 #7 的验证）；重开后 409ms 内把「已保存但没上传」的那次改动补传出去。

### 7. 测试离线、关闭重启、响应丢失、同时写入、轮询最坏相位；检查触发后 2 秒、持续可见提交后 32 秒目标按父规格合成条件分别验证

- 合成网络：页面内 `fetch` 包装注入 200ms 往返（100ms 各向），与设计 §10 的条件一致。
- 实测（同一台机器、同一份合成网络）：

| 场景 | 做法 | 结果 |
| --- | --- | --- |
| 触发检查 | 接收端派发真实的 `visibilitychange` | 新内容 **258ms** 后出现（目标 ≤2s） |
| 持续可见轮询 | 三个自然相位 | 775ms / 18114ms / 18145ms |
| 最坏相位 | 相位重置后让提交落在一次 tick 之后 1.2s | **29030ms**（目标 ≤32s） |
| 离线 | `set offline on` → 编辑 | 状态 `pending`、页脚「待同步」、盘上有 pending |
| 恢复 | `set offline off` | 自动补传（revision 19），另一设备在下一轮轮询看到 |
| 响应丢失 | 第一次写提交成功但响应丢掉 | 同 ID 重放，revision 只 +1，收敛 `synced` |
| 关闭重启 | 保存后立刻重载页面 | 409ms 内补传，无重复写入 |
| 同时写入 | 构造过期基线后提交 | 两端进 `conflict`，两份候选都在，两个方向都能收敛 |

- 状态词（设计 §5 的六个）在真实浏览器里观察到：`local`（初始）、`syncing`（上传在途/等下一轮）、`synced`（收敛）、`pending`（离线）、`conflict`（冲突）；`failed` 由用例覆盖（`operation_conflict` 与在线网络失败两条路径）。

## 实际验证命令与结果

```
node --test tests/sync-engine.test.js      # 23/23（假时钟，跑真实调度方法）
node --test tests/sync-http.test.js        # 11/11（含并发写 / 重放 / 响应丢失 / 代次）
node --test tests/sync-client.test.js      # 10/10（接线守卫 + 本地记录形状校验）
node --test tests/*.test.js                # 705/705（基线 700，其中 #7 的基线 644）
node --check server.js lib/sync-store.js public/app.js public/local-navigation.js public/sw.js tests/sync-engine.test.js
git diff --check
```

红/绿变异 **25 条全部变红，且源文件逐字节还原**。其中三条第一次**没红**，都是**测试没盖到**（不是代码问题），已补齐后重跑：①「重开时补传」那条用例原本自己手动调 `scheduleSyncUpload()`，于是 `loadSyncState` 里那条分支删掉也照样绿——改成走真实的 `loadSyncState`；② 客户端写请求带 `generation` 这件事没有断言，补进接线守卫；③「隐藏时不停止轮询」那条用例**根本没先把轮询跑起来**，于是断言恒真——先 `startSyncPolling()` 再切走。

## 未验证与已知边界

1. **2s / 32s 是注入 200ms 合成网络下的数**（同一台机器、localhost），不是公网数；公网延迟单独看。
2. **可重复的浏览器回归**仍然缺（本机没有 Playwright），与 #7 同一条；本轮的 UI 验收同样是手工驱动真实浏览器完成的。
3. 多标签页协调没有在**两个真实标签页**里跑过（用假通道执行的引擎用例 + 真浏览器里的单标签页刷新）；跨标签页冲突的收敛靠服务端 409，未实测。
4. `claim` 的 15 秒 TTL 与 300ms 询问上限是我定的数；真正的兜底是索引 CAS 与服务端 revision 校验。
5. 管理员会话期间只暂停调度，不做配置隔离与切换（归 #11）。
6. 移动实机、目标服务器、容量与时效的完整验收归 #13/#14。

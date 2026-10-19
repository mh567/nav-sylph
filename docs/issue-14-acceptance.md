# Issue #14 验收记录：升级、浏览器与目标机器综合验收

- Issue：<https://github.com/mh567/nav-sylph/issues/14>
- 基线：`d9ab382`（#13 关闭后的 main）
- 状态：**部分完成**。第 1、2、3、7 条有独立证据；**第 4、5 条的「2 核 2 GB 目标机连续 24 小时」与「公网时延」给不了**，按验收原文第 6 条「目标机器不可用则明确验收未完成，不能以 mock 或空闲轮询替代」→ **Issue 不关闭**。

## 逐条验收

### 1. 全部定向/全量测试、语法与差异检查；浏览器覆盖八流程 ✅

- 单元：`node --test tests/*.test.js` = **796 / 796**（29 个文件）。
- 语法：`node --check` 覆盖 `server.js`、`lib/*.js`、`public/*.js`（含 `public/modules/*.js`）、`tests/*.test.js`。
- 差异：`git diff --check` 干净；工作树除按约定保持未跟踪的 `sylph-handoff-2026-10-18.md` 外干净。
- 浏览器（Playwright + 系统 Chrome，`channel:'chrome'`）：`node --test tests/browser/*.cjs` = **41 / 41**，八个流程逐项覆盖：

| 流程 | 用例文件 | 条数 |
| --- | --- | --- |
| 初访、本地编辑（刷新/重启/离线/缓存升级/表单草稿/两标签页竞争/存储故障注入） | `local-navigation.cjs` | 12 |
| 管理员跨设备同步、迟到响应 | `admin-sync.cjs` | 10 |
| 默认首页发布 | `template-editor.cjs` | 2 |
| 公开模块启用/布局/离线/撤回 | `public-modules.cjs` | 4 |
| 普通口令空间：停止同步、删除、同口令重建、跨标签页取消调度 | `sync-space.cjs` | 3 |
| 普通口令空间：总开关/列表/暂停/停用/删除/配额 | `sync-governance.cjs` | 6 |
| WebDAV 恢复：计划清单、旧备份、恢复期间并发写、失败码 | `restore.cjs` | 4 |

### 2. 合成旧安装验证升级、重试、旧客户端及 schema 不兼容、SW 与本地数据迁移、私人缓存清理及完整快照回退 ✅（除「真实 GitHub 下载链路」）

- **合成旧安装**：`git archive v2.0.2` → 干净目录 → 合成管理员密码 → 启动（`user_version = 9`）→ 用旧版 API 写入配置/收藏/一条备忘录。
- **模拟 `sylph.sh update` 的覆盖集**（`server.js`、`lib/`、`public/`、`server-config/`、版本与清单文件；数据文件不动）→ 启动新版：
  - `user_version` **9 → 12**（v10 墓碑、v11 资源治理、v12 恢复记录逐级推进）；
  - 旧 `config.json` 仍在（分类名逐字一致）；**旧管理员密码仍能登录**；**旧版写入的备忘录还在**（1 条，标题一致）；
  - `public/sw.js` 的 `CACHE` = `nav-v124`（回访用户拿新 bundle）。
- schema 不兼容：`tests/config-shadowing.test.js` 与 v9–v12 的迁移用例覆盖「拒绝而非静默回退」；恢复的 `halted`/`applied` 记录在 `tests/restore-recovery.test.js` 三种态各有一条。
- **快照回退**：`lib/restore.js` 的逆序回滚由 `tests/restore-http.test.js` 的故障注入用例验证（某域写失败 → 已应用域逐字节还原、版本不变）。
- **真实升级链路已由用户在真机上走通**：v2.1.0 与 v2.1.1 都通过 `./sylph.sh update`（GitHub Release 的 `tag_name` 与附件）升级，试用正常。所以第 2 条不再只有合成模拟；本地那次「归档 + 覆盖」的模拟作为对照保留在记录里。

### 3. 匿名分享与搜索保留原有行为，收藏全部拒绝匿名，三类配置任何操作均不互相覆盖 ✅

- 分享与搜索：`tests/share-guards.test.js`、`tests/paste-ttl.test.js`、`tests/paste-composer.test.js`、`tests/navigation-http.test.js`（含匿名文本分享、TTL、搜索行为）。
- 收藏全拒匿名：`tests/fav-batch-privacy.test.js`、`tests/api-boundary.test.js`（匿名 401 + 软门只回公开视图）。
- 三类配置互不覆盖：`tests/admin-sync-http.test.js`（管理员导航/模块/收藏三域各自 revision + 回执）、`tests/sync-http.test.js`（普通空间与管理员域不同表不同凭据，互不升级）。

### 4. 目标机负载（2 核 2 GB × 30 空间 × 2 设备 ≥ 24 小时）；≥20 设备；空间总量与 1 MiB 边界 ⚠️ 部分

- **能给的证据**：`tests/sync-http.test.js` 真 HTTP 连 **25 台设备**（无固定上限）；额度边界用 `NAV_SYNC_*_LIMIT` 注入后真 HTTP 打边界（空间数 503 且不消耗邀请码、每空间 1 MiB 口径 = config+modules 之和、**缩减写入无条件放行**、并发创建/写只有一路成功）；`tests/sync-store.test.js` 的四条额度用例 + 迁移回填的 BLOB 口径（含非 ASCII）。
- **给不了**：**2 核 2 GB 目标机连续 24 小时**的容量结论（没有该机器）。按第 6 条，不用 mock 或空闲轮询替代，**该条不勾选**。

### 5. CPU / RSS / DB 与 WAL / P95 / 同步延迟 / 私人模块影响；合成条件下普通与管理员同步时效；公网结果单列 ⚠️ 部分

- **本机实测**（新版运行在合成升级后的安装上，空闲 + 30 次 `GET /api/config`）：
  - RSS ≈ **70 MB**；`%CPU` 3.9–24.2（采样瞬间包含启动与请求突发，非稳态基线）；
  - `nav-sylph.db` ≈ 164 KB、`-wal` 96–346 KB、`-shm` 32 KB；
  - `GET /api/config` **P95 = 2.6 ms**（中位 1.7 ms；30 次，本机回环）。
- 同步时效：沿用 #8 的方法（注入 200 ms 合成往返），实测「服务端提交 → 接收端显示」775 ms / 18.1 s / 29.0 s（上界 30 s + RTT ≤ 32 s）；本轮 #10/#11 未改变调度参数（30 s 轮询、500 ms 防抖 + 2 s 上限），#11 只把首次检查推迟一个会话探测往返（不阻塞首屏）。
- 私人模块影响：模块文件只在有内容时生成/恢复；恢复期间 `invalidateMetricsCache()` 与 `dropOrphanAgentMetrics()` 由 #13 负责（`tests/restore-http.test.js` 断言）。
- **给不了 / 单列**：**公网时延**（未部署公网 VPS，只有合成 200 ms 与回环数据）；**目标机 24 小时**的稳态曲线。该条不勾选。

### 6. 功能缺陷修复并复验；目标机器不可用则明确验收未完成 ⚠️

- 本轮综合验收**没有发现新缺陷**（796 单元 + 41 浏览器全绿）。
- **目标机器不可用 → 明确验收未完成**：`#14` 保持 **OPEN**，第 4、5、6 条不勾选。

### 7. 更新部署说明、已实现架构及交接记录，记录兼容性变化和实际限制；不自动授权发布 ✅

- `README.md`（备份/恢复范围、额度与暂停、撤销旧设备）、`DEPLOYMENT.md`（**新增「恢复故障手册」**：`.restore-snapshot/`、`halted` 记录、人工恢复步骤、升级回滚快照与恢复功能的分工、Node ≥22 与 `NAV_SYNC_*_LIMIT` 说明）、`docs/architecture.md`（#10/#11/#13 各一节 + WebDAV 范围与「凭据解不开」的更正）、`docs/current-work.md`（#9–#13 交接）。
- 兼容性变化：备份**不再含** `nav-sylph-config-*.json`（旧备份仍可列出，恢复时跳过并提示）；新备份**不能被旧程序还原**；`#11` 起「本机有未上传改动时不再自动采用云端」。
- **未发版**（用户明确：等完整功能做完；本任务不自动授权发布）。

## 需要什么才能把 #14 收口

1. 一台 2 vCPU / 2 GB 的 Linux 机器 + 连续 24 小时窗口（按 #10 的额度注入把上限调到目标规模：30 空间 × 2 设备）；
2. 一个公网部署（VPS + nginx/TLS 或真实域名）用于公网时延；
3. 若允许走真实 `./sylph.sh update`：GitHub Release 可用的环境（或授权用本地 tarball 镜像并在记录里注明）。

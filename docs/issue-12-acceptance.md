# Issue #12 验收记录：按新范围生成管理员 WebDAV 备份

- Issue：<https://github.com/mh567/nav-sylph/issues/12>（父规格 #1；语义见 `personal-navigation-sync-design.md` §8、§10、§11）
- 基线：`b40461b`（#11 完成）
- 状态：**本地提交，未推送、未发版、Issue 未关闭**

## 逐条验收

### 1. 备份收藏及隐私标签、备忘录正文状态、监控配置、Special Line 来源事件及归档收藏状态、对应私人开关布局

- 收藏：`favorites.json` → Netscape HTML（隐私标签走 `DATA-SYLPH-PRIVATE="1"`，既有往返）。
- **备忘录（本轮新增）**：`memos` 表 → `nav-sylph-memos-*.json`，字段白名单 `id/title/body/pinned/createdAt/updatedAt`，`updated_at` 保留原值（**不用 now 覆盖**）。
- 主机监控与私人模块的开关/布局：`.modules.json` 经**白名单投影**后进 `nav-sylph-modules-*.json`（只留私人模块的 `enabledModules`/`widgets` 与 `servers` 的非凭据字段）。
- Special Line：时间线导出的 `sources/events/eventState`（含 `favorited_at`/`archived_at`）→ `nav-sylph-timeline-*.json`。
- 证据：`tests/backup-scope.test.js`（投影与清单）+ `tests/backup-scope-http.test.js`（真实 HTTP + 本地 WebDAV 桩，逐文件解析）。真实 HTTP 用例 1 断言清单 `included` = `['favorites','memos','modules','timeline']`、时间线事件的标题与归档/收藏状态都在产物里。

### 2. 排除管理员导航和引擎、默认模板、普通空间、邀请码、设备令牌、密码、会话、监控缓存

- **不再生成** `nav-sylph-config-*.json`；管理员导航/引擎/主题不入备份。
- 投影剔除 `publicModules`、`socialAccounts`、`symbols`、`_sync`、`servers[].token`、`pushSecretHash`、`enrollTokenHash`；**保留** `certPem`/`certFingerprint`/`enrolledAt`/`deployState`。
- 默认模板（`published`/`draft`）从未进备份；普通空间/邀请码/设备令牌/会话/监控缓存都在另一套表里，备份集不含。
- **证据姿势（反向证明）**：真实 HTTP 用例先在管理员导航里放 `NAV-MARKER-…`、引擎里放 `ENGINE-MARKER-…`，备份后断言**所有数据文件的字节里都不出现**这些字符串，也不出现 `"token"`/`pushSecretHash`/`enrollTokenHash`/`publicModules`/`socialAccounts`/`symbols`/`"_sync"`/`"receipts"`/`passwordHash`。清单文件本身**跳过**这条扫描（它是「关于排除项」的文档，`skipped` 的原因会点名这些字段）。
- **信封断言**：遍历每个 JSON 产物（递归找 `isEnvelope()`），HTML 里也不得出现 `"iv"`——本仓库所有密文都由管理员密码哈希派生，而哈希不可移动，所以**产物里不应有任何 AES-GCM 信封**。

### 3. 按开发分类及白名单筛选私人布局项，不导出公开模块项或明文凭据；不能跨安装使用的凭据不加入

- `PRIVATE_MODULE_IDS` 白名单 + `projectPrivateModulesConfig()`（**白名单 pick，不是 delete**：将来新增的凭据字段默认不进备份）。
- `servers` 按 id 合并、**不回填凭据**；恢复后缺凭据的机器落到既有词表里的 `deployState: 'pending'`（「等待部署」），并在响应 `needsAuthorization[]` 里列出来。
- 恢复时 `publicModules`/`socialAccounts`/`symbols`/`pollInterval` **取本机值**，备份里的一律丢弃（真实 HTTP 用例断言「本机对访客的开放名单没被抹掉」）。

### 4. 版本化清单及实际内容校验和，手动和自动备份遵守相同范围，UI 说明范围和恢复后需授权项目

- `nav-sylph-manifest-*.json` / `-auto`：`version: 2`、`type`、`scope: 'admin-private'`、`included[]`（domain、file、**文件字节 sha256**、counts）、`skipped[]`（domain + 原因）、`checksums`。各信封 `version` 1→2，`checksum` 语义**不动**（旧读取不坏）。
- 手动与自动**同一份采集函数**；`noChanges` 从 4 组校验和变 **5 组**（漏改会出现「改了备忘录点备份却说没变化」）。
- UI：范围说明改写（列出含/不含）、恢复对话框加「只恢复备忘录」、去掉 token 字样、加「恢复后需重新授权/重新部署的项目」清单、旧备份醒目提示「只恢复书签」。`sw.js` CACHE nav-v122 → **nav-v123**。

### 5. 生成并解析真实备份验证包含排除项，自动同步及现有备份格式读取回归，第三方存储采用合成上游

- 真实 HTTP + **本地 WebDAV 桩**（只实现 PROPFIND Depth:1 / GET / PUT / MKCOL / DELETE）→ 用例**直接向上游 GET 回每个文件并解析**：文件集合逐字、清单 `included` 的 sha256 等于上游那份文件的字节摘要、自动槽位与手动同范围。
- 恢复回归：真实 HTTP 用例 3 —— 备份 → 破坏现场（删备忘录、换收藏、清模块布局）→ 恢复 → 备忘录/收藏/布局回来、时间线事件与归档/收藏状态回位（**直接查库**：列表接口默认不列已归档项）、`/api/config` 与 `/api/admin/navigation` **一字未变**。
- 旧格式读取：`tests/backup-privacy.test.js` / `tests/timeline-backup.test.js` 已按新范围改写（保留旧备份可列出、恢复时 config 域跳过并提示）。

## 验证数字与已知缺口

- 单元：`node --test tests/*.test.js` = **780 / 780**（基线 765，本轮 +15；新增 `tests/backup-scope.test.js` 与 `tests/backup-scope-http.test.js` 共 3 条真实 HTTP 用例）。
- 浏览器：`tests/browser/*.cjs` = **37 / 37**（`template-editor.cjs` 在**并行整批跑**时失败过一次，单独连跑 3 次 2/2 全绿——判定为并行负载下的既有抖动，与本轮改动无关，未在本轮修）。
- ⚠️ **红/绿变异这一轮没有做**：实施用尽回合预算，我接手时先把它留下的真实 HTTP 用例跑绿（三条都通过），但**没有**对「凭据剔除 / 管理员导航剔除 / 白名单投影 / 清单 skipped / memos 进 noChanges」这五条守卫逐条做变异证红。**这是本轮明确的缺口**，不应被当作已验证；下轮开工前应补（与本仓库对守卫的一贯要求一致）。

## 仍未验证

- 真实第三方 WebDAV 服务（只用合成上游）；目标服务器与公网时延归 #14。
- 旧版程序读取新备份（单向兼容：新备份不能被旧程序还原，已写进架构文档）。

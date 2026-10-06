# 项目协作入口

本文件供在本仓库工作的开发 Agent 使用。开始任务时，先阅读 `README.md`、`docs/architecture.md` 和 `docs/current-work.md`，再检查 `git status`、当前代码和相关测试。文档中的版本与状态以实际仓库为准。

## 开发约定

1. 围绕用户当前任务修改代码。保留已有数据格式、搜索、收藏、备份和分享行为；需要改变这些行为时，说明迁移与兼容影响。
2. 首页保持轻量和快速。运行时脚本、样式及字体由本服务提供。引入依赖或改变加载链路前，检查首屏影响。
3. 涉及公开接口、隐私收藏、管理操作或备份恢复时，检查服务端权限边界、数据流和升级路径。不要把浏览器界面的隐藏状态当作访问控制。
4. 修改后运行相关定向测试。候选完成时运行 `node --test tests/*.test.js`，并按改动范围执行语法检查和 `git diff --check`。需要真实浏览器或目标服务器验证的结果应单独列明。
5. 交接时更新 `docs/current-work.md` 中的目标、完成状态、实际验证和下一步。稳定的架构变化更新 `docs/architecture.md`。不要在仓库文档中写入密码、密钥或私人书签数据。
6. 发布一律用仓库自带的 `scripts/release.sh`，不要手写 `git` / `gh` 命令。它会依次完成：读取 `version.json` 的版本号 → 打包（`server.js`、`public/`、`lib/`、配置示例等）为 `nav-sylph-v<版本>.tar.gz` → 从 `CHANGELOG.json` 摘 highlights 生成发布说明 → `git tag -a` → `gh release create` 上传附件。**漏掉最后一步的后果是 `./sylph.sh update` 永远提示旧版本**：`sylph.sh` 的 `get_latest_release()` 读的是 GitHub Release（`/releases/latest` 的 `tag_name` 与 `browser_download_url`），**不是 git tag**——推 tag 不会产生 Release。版本号需在 `package.json`、`version.json`、`CHANGELOG.json` 三处保持一致，改完用 `node -e` 重新解析以证明 JSON 仍合法。
7. 运行与开发需要 **Node ≥ 22**：`better-sqlite3@13` 的 `engines` 是 `>=22`，低版本加载它会**段错误退出**，而 `npm install` 阶段不报任何错。私有数据现在是两套存储：**登录会话在 SQLite**（`nav-sylph.db`，连接与迁移见 `lib/db.js`，会话后端见 `lib/session-sqlite.js`），配置/收藏/密码/WebDAV 配置仍是 JSON。新增模块要建表时，往 `lib/db.js` 的 `MIGRATIONS` 数组**尾部追加**一个台阶，不要新建库文件，也不要改动已发布的迁移项——老库的 `user_version` 已领先，被改动的那一步不会再执行。私有文件（含会话库）由服务自身在写入时收紧为 0600，不要只依赖 `sylph.sh` 的 chmod。
8. **只用 `main` 一个分支**，不要建 `develop` 之类的长期分支。开发直接提交在 `main` 上，发布时打 tag。理由：`docs/current-work.md` 以「基线锚定发布提交」描述状态，隐含前提是 **任何时刻 `main` 都代表已发布状态**；多一个长期分支会与这个前提冲突。实际教训：v1.6.0 期间曾建过 `develop` 承接后续模块，合并发布后没有同步回来，它随后落后 main 两个提交、成为分叉状态，而 `release.sh` **只推 tag 不管分支**，于是后来的修复全落在 `main` 上，`develop` 静默失效。**发布后若发现某个分支落后或分叉，直接删掉它**，不要花力气维护一条已经没人用的并行线。
9. `CHANGELOG.json` 的 **`summary` 与 `highlights` 是用户直接读到的文案**，一律用正式书面语、一句话陈述：不写口语词（「能真的」「弹回」「调细」这类）、不写括号里的旁白与自嘲、不在文案里放 ⚠️ 标记。三处出口：应用内「更新说明」只渲染 `summary`（`getNewFeatures()` → `.help-new-features-summary`）；`sylph.sh` 更新后打印 `highlights[0]`；Release 说明由 `release.sh` 把 `highlights` 全部列成条目。语体参照既有条目：「修接入新主机时的证书校验报错」「修正 WebDAV 备份列表的时间显示」。需要更正一条已发布的说明时，把更正写进 `changes`（不在界面上显示），不要塞进 `highlights` 变成给用户看的旁白。**技术细节、根因、实测数字写在 `changes` 的 `fix`/`improve`/`add` 里**——它不出现在任何界面，可以写细，也是下一轮排查的依据。

## 文档分工

`README.md` 说明用户使用、安装和部署；`docs/architecture.md` 记录已实现的结构与设计约束；`docs/current-work.md` 记录当前工作及未完成的验收。旧计划和研究文档可供追溯，使用前核对其日期与代码状态。

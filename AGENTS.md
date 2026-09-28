# 项目协作入口

本文件供在本仓库工作的开发 Agent 使用。开始任务时，先阅读 `README.md`、`docs/architecture.md` 和 `docs/current-work.md`，再检查 `git status`、当前代码和相关测试。文档中的版本与状态以实际仓库为准。

## 开发约定

1. 围绕用户当前任务修改代码。保留已有数据格式、搜索、收藏、备份和分享行为；需要改变这些行为时，说明迁移与兼容影响。
2. 首页保持轻量和快速。运行时脚本、样式及字体由本服务提供。引入依赖或改变加载链路前，检查首屏影响。
3. 涉及公开接口、隐私收藏、管理操作或备份恢复时，检查服务端权限边界、数据流和升级路径。不要把浏览器界面的隐藏状态当作访问控制。
4. 修改后运行相关定向测试。候选完成时运行 `node --test tests/*.test.js`，并按改动范围执行语法检查和 `git diff --check`。需要真实浏览器或目标服务器验证的结果应单独列明。
5. 交接时更新 `docs/current-work.md` 中的目标、完成状态、实际验证和下一步。稳定的架构变化更新 `docs/architecture.md`。不要在仓库文档中写入密码、密钥或私人书签数据。
6. 发布一律用仓库自带的 `scripts/release.sh`，不要手写 `git` / `gh` 命令。它会依次完成：读取 `version.json` 的版本号 → 打包（`server.js`、`public/`、`lib/`、配置示例等）为 `nav-sylph-v<版本>.tar.gz` → 从 `CHANGELOG.json` 摘 highlights 生成发布说明 → `git tag -a` → `gh release create` 上传附件。**漏掉最后一步的后果是 `./sylph.sh update` 永远提示旧版本**：`sylph.sh` 的 `get_latest_release()` 读的是 GitHub Release（`/releases/latest` 的 `tag_name` 与 `browser_download_url`），**不是 git tag**——推 tag 不会产生 Release。版本号需在 `package.json`、`version.json`、`CHANGELOG.json` 三处保持一致，改完用 `node -e` 重新解析以证明 JSON 仍合法。

## 文档分工

`README.md` 说明用户使用、安装和部署；`docs/architecture.md` 记录已实现的结构与设计约束；`docs/current-work.md` 记录当前工作及未完成的验收。旧计划和研究文档可供追溯，使用前核对其日期与代码状态。

# 当前工作交接

核对日期：2026-09-28。本文供更换开发 Agent 或开发软件时快速接续。开始任务后，先运行 `git status --short --branch` 并检查近期提交，再更新本文件。

## 当前基线

修改前的基线：分支 `main`，与本地 `origin/main` 跟踪引用一致；最新提交为 `19d6480`；`package.json` 版本 `1.5.6`。这里的远端状态只反映本地跟踪引用，后续 Agent 需要联网时应自行核对真实远端。

本次修改尚未提交。`AGENTS.md`、`docs/architecture.md`、`docs/current-work.md` 在本次之前已是未跟踪文件，`tests/api-boundary.test.js` 为本次新增。`node_modules` 是本次为运行验证而新装的本地依赖。

## 本次完成的内容

匿名接口此前直接返回整个数据文件，私密收藏的标题、URL、描述、分类和标签会下发给任何访问者，`private` 标志本身也照发；`config.json` 的 `privacyMode` 同样公开。浏览器端的私密筛选发生在数据已经落到内存之后，不构成隔离。

现在 `GET /api/config` 和 `GET /api/favorites` 在没有管理密码时返回公开视图：收藏剔除 `private` 条目并剥离 `private` 字段，配置剔除 `privacyMode`；带上正确的 `X-Admin-Password` 时返回完整数据。写入路径改为按 id 合并，`POST /api/favorites` 中请求体缺席的私密条目会被保留，`POST /api/config` 以现有文件为基底合并，公开视图未携带的 `privacyMode` 不再被保存动作抹掉。

前端相应调整：`API.get` 支持传入管理密码；管理面板打开前和私密检索触发时按需取回完整配置与收藏；登出后丢弃全量缓存并回到公开子集。`privacyMode` 不在公开视图内，因此改由带密码的 `GET /api/config` 取回，否则私密检索会因迁移默认值恒为 `false` 而无法触发。

## 实际验证

- `node --test tests/*.test.js`：22 项全部通过（原 11 项 + 新增 11 项）。
- `node --check server.js`、`node --check public/app.js`、`node --check tests/api-boundary.test.js`：通过。
- `git diff --check`：无空白或冲突标记问题。
- 真实 HTTP 验证：在临时目录启动服务并造含私密条目的数据，确认匿名响应不含私密标题与内网地址、不含 `private` 字段；错误密码只得到公开视图；正确密码得到全量与 `privacyMode`；从公开子集保存后私密条目存活而缺席的公开条目被删除；保存配置后 `privacyMode` 保留。验证脚本是一次性临时的，已删除，未纳入 `tests/`。

## 未完成与后续

1. 浏览器端行为未在真实浏览器验收。管理面板的收藏列表、私密徽标、输 `//` 的私密检索、拖拽改分类、导出收藏，以及私密检索加载全量时的索引配对，都需要在目标环境实测。静态测试和一次性 HTTP 验证覆盖不到这些交互。
2. 公开部署前应核对实际部署凭据。默认管理密码由 `server-config/defaults.js` 定义为 `admin123`，仓库状态不能证明线上已改密。
3. 首屏性能没有新的实测数据。本次改动使已登录用户在打开管理面板或触发私密检索时多一次带密码的 `/api/config` 或 `/api/favorites` 请求；匿名首屏路径未增加请求。国内网络与移动端下需重新测量。
4. 本次范围外的已知问题，均在 `server.js` 中可核对：`POST /api/p` 没有速率限制（其余分享路由有）；CORS 允许来源硬编码为 `http://`，HTTPS 部署下正常来源会被拒绝，且未设置 `Vary: Origin`；安全头只有 `script-src`，缺 HSTS、`Permissions-Policy`；写操作没有 CSRF 校验；所有管理路由共享单个 IP 的 30 次/分钟限流桶，攻击者可借此阻断正常管理操作。
5. auth 机制本身未改动，仍是明文密码经 `X-Admin-Password` 头逐请求校验，无会话、令牌或过期。公网部署应配合 HTTPS。
6. 既有记录未证明目标 VPS 与国内手机网络下的明暗主题、触屏、拖放及 WebDAV 流程已验收。

## 下一位 Agent 的启动步骤

1. 阅读根目录 `AGENTS.md`、`README.md`、`docs/architecture.md` 及本文件。
2. 核对 `git status --short --branch`、`git log -5 --oneline`、`package.json` 和与新任务相关的代码。
3. 明确本次目标与完成条件，实施后运行定向检查及适用的回归测试。
4. 在交接前记录实际修改、验证命令与结果、未完成事项。只有发生稳定架构变化时才更新 `docs/architecture.md`。

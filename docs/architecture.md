# Nav Sylph 架构与开发背景

更新日期：2026-09-28。本文描述当前仓库代码。开始新任务时，应核对实际代码与版本。

## 产品方向

Nav Sylph 是个人导航和书签页面，面向公网访问的首页应保持简洁、无需登录即可使用、加载迅速。管理操作和私人数据需要受保护。今后扩展网址、服务、主机、监控或订阅时，优先围绕同一资产组织信息，避免首页堆积彼此分离的模块。现有仓库尚未实现统一资产模型，这一段是后续设计约束。

用户主要在国内访问海外部署的服务器。页面运行时资源由本服务提供。用户主动点击的搜索、书签和 WebDAV 地址属于外部目标，不属于页面运行时依赖。

## 当前结构

| 位置 | 职责 |
| --- | --- |
| `server.js` | Express 服务、静态资源、配置与收藏接口、管理密码、分享页面和 WebDAV 接口 |
| `server-config/` | 服务配置默认值、文件与环境变量的加载及校验 |
| `public/index.html`、`public/app.js` | 首页结构、搜索、收藏、管理界面及浏览器状态；管理密码存在时按需取回完整配置与收藏 |
| `public/styles.css`、`public/admin.css` | 首页与管理界面样式；`.search.paste-mode`（分享编辑器）只在该文件「Paste 分享模式」区块定义一处，勿在尾段的新版样式区块重复声明 |
| `public/sw.js` | 同源静态资源白名单缓存；动态接口和分享页不在缓存范围内 |
| `public/lib/` | 本地提供的搜索、拼音、二维码（`qrcode.js`）与代码高亮（`highlight.min.js`）脚本；高亮仅供分享接收页按需加载 |
| `lib/webdav-backup.js` | WebDAV 配置加密、备份、恢复和校验 |
| `sylph.sh`、`scripts/release.sh` | 安装管理与版本发布脚本 |
| `tests/` | 备份隐私、移动收藏、对话框、接口数据边界和服务生命周期回归测试 |

服务使用 Node.js、Express 和原生浏览器代码。`package.json` 的 `start` 命令运行 `server.js`，`dev` 命令使用 nodemon。测试目前通过 `node --test tests/*.test.js` 运行。

## 数据与请求路径

`server-config/index.js` 合并默认配置、可选的 `server-config.json`、`.env` 和环境变量。首页在 `public/index.html` 中提前请求 `/api/config`；`public/app.js` 复用该请求，渲染首页后再加载收藏及版本信息。服务端使用 compression 处理中等及较大的可压缩响应。Service Worker 仅缓存列出的同源静态资源。

运行时的 `config.json` 保存页面设置和分类，`favorites.json` 保存收藏，`.admin-password.json` 保存管理密码哈希，`.webdav-config.json` 保存 WebDAV 配置。这些文件由 `.gitignore` 排除，不能作为跨工具交接附件提交。书签 HTML 的 `DATA-SYLPH-PRIVATE` 标记承载 Sylph 私密属性；修改导出、解析、恢复或备份版本时，应完整检查往返路径。

`GET /api/config` 和 `GET /api/favorites` 在没有管理密码时返回公开视图，只含首页需要渲染的部分：收藏过滤掉 `private` 条目并剥离 `private` 字段本身，配置剔除 `privacyMode`。带上正确的 `X-Admin-Password` 时才返回完整数据，供管理面板和私密检索使用。写入路径相应地按 id 合并而不是整份覆盖：`POST /api/favorites` 中既有的私密条目在请求体缺席时保留，`POST /api/config` 以现有文件为基底合并，因此公开视图未携带的 `privacyMode` 不会被保存动作抹掉。浏览器中的私密收藏筛选只是显示逻辑，服务端不再依赖它承担隔离职责。新增私有资产字段时，应先确认它是否应当进入公开视图。

管理密码仍以明文经 `X-Admin-Password` 头逐请求校验，没有会话、令牌或过期机制。公网部署时该头在网络上明文传输，应配合 HTTPS。

`server.js` 设置 `app.set('trust proxy', 1)`，限流与日志据此使用 `req.ip` 取真实客户端地址。**必须是跳数而非 `true`**：`true` 会信任客户端自带的 `X-Forwarded-For`，任何能直连服务端口的客户端都能伪造 IP 轮换绕过限流。代价是若绕过反代直连服务，限流退化为按 socket 地址计数；因此部署时必须让 Node 只监听回环地址并经反代对外暴露。

## 跨设备文本分享

分享内容在浏览器内用分享码派生 AES-GCM 密钥加密，服务端只存密文。`POST /api/p` 的 `ttl` 只接受白名单档位（5/30/1440/10080 分钟），缺失或非法值回落到 5 分钟；不放开任意时长，因为 `expiresAt` 决定条目在进程内 `Map` 中的驻留周期。存储仍是进程内 `Map`，重启即丢失，因此 7 天档并不等于数据能存活 7 天。

滥用防护分三层，缺一不可：取码（`/api/p/code`）、创建（`POST /api/p`）与读取各自独立计数，创建入口必须单独限流，否则可绕开取码接口自造分享码直接创建。限流 Map 由 60 秒定时器按窗口清理，开启 `trust proxy` 后 key 数量等于访问者数量，不清理会变成内存放大器。除按 IP 限流外还有全局容量上限（条数与字节双阈值），用于兜底多个 IP 协同堆内存的情况；容量满时返回 503 而非驱逐最旧条目，避免静默丢弃他人仍在有效期内的分享。

分享接收页 `/p/:code` 是服务端独立渲染的整页，运行时资源由本站提供。代码渲染先走高精度正则签名判定语言，再由 highlight.js 兜底自动识别：分享多为短片段，`highlightAuto` 的 relevance 在短文本上区分度不足，直接使用会把 Python 片段误判为 CSS。含中文的内容按纯文本处理，不做高亮。识别失败或 `hljs` 未加载时回退为原文 `textContent`。高亮产物由 highlight.js 自身转义后才写入 `innerHTML`；修改此处渲染逻辑时必须复核这一前提。

分享编辑器在首页搜索框内完成。触发字符仍是 `>`（或全角 `》`），编辑区为 `<textarea>`——单行 `<input>` 在 HTML 规范上无法换行，也撑不开多行内容。搜索态保持单行（`min-height: 36px`，不写 inline height）；分享态下 `min-height: 96px` 起、`max-height: 60vh` 封顶。JS 的 `autoGrowPasteInput()` 在 `input` 事件中按 `scrollHeight` 写入 inline height 使其随内容增删同步伸缩并 clamp 到上限；进入分享态的首帧不测量，此时由 `min-height` 兜底。用户拖动右下角把手后置 `pasteUserResized`，此后不再自动跟随。回车发送、`Shift`/`Ctrl`/`Cmd`+回车换行，Esc 或左侧「退出」按钮返回搜索态（移动端无 Esc 键，退出按钮是主路径；两条路径共用 `exitPasteMode()`，复位逻辑只此一处）。搜索引擎按钮在分享态由 `.search.paste-mode #engineBtn` 隐藏，不用内联 `display`，否则无法参与过渡且会盖过样式表。

## 开发与验收边界

保持现有 Node.js、Express 和原生前端结构，先依据目标服务器及设备的实际数据优化首屏、搜索和管理加载。现有本地文件体积、压缩估算和静态检查不能替代真实网络或移动端性能测量。

界面设计历史见 `docs/sylph-unified-interface-plan.md`。该文件包含当时的阶段状态，当前发布与验收状态以 `docs/current-work.md`、Git 和实际环境为准。部署方法见 `README.md` 与 `DEPLOYMENT.md`。

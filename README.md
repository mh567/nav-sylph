# Nav Sylph

一个极简、高效的个人导航与书签管理页面。

![预览](docs/preview.png)

## ✨ 核心特点

| 特点 | 说明 |
|------|------|
| **极简设计** | 纯净无广告，秒开体验，专注搜索与书签 |
| **收藏检索** | 导入浏览器书签，`/` 触发模糊搜索，毫秒级响应 |
| **书签管理** | 分类管理、拖拽排序、图标/纯文字两种显示模式 |
| **多搜索引擎** | 内置 Google、百度、Bing、DuckDuckGo，可自定义 |
| **WebDAV 备份** | 支持远程备份配置和收藏，可选择性恢复 |
| **跨设备分享** | 端到端加密的临时文本分享，5分钟过期，阅后即删 |
| **主题切换** | 支持浅色/深色/跟随系统三种模式 |
| **PWA 支持** | 可安装到桌面或手机主屏，离线可用 |
| **响应式布局** | 完美适配手机、平板和桌面端 |
| **自动更新提示** | 新版本发布后自动提示，一键更新 |
| **安全防护** | bcrypt 密码加密、Rate Limiting、安全头 |

## 🚀 快速开始

### 项目简介

Nav Sylph 是一个基于 **Node.js** 的轻量级 Web 应用，可部署在个人服务器或本地电脑上，作为浏览器首页使用。

### 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/sylph.sh | bash
```

支持 Linux / macOS / Windows (Git Bash, WSL)

> 💡 安装脚本会自动从 [GitHub Releases](https://github.com/mh567/nav-sylph/releases) 下载最新版本，无需安装 Git。

### 系统要求

- **Node.js** 16+
- **curl** 或 **wget**（用于下载）

## 📦 管理脚本

项目使用统一的 `sylph.sh` 脚本进行所有操作：

### 基础命令

| 命令 | 说明 |
|------|------|
| `./sylph.sh start` | 启动服务 |
| `./sylph.sh stop` | 停止服务 |
| `./sylph.sh restart` | 重启服务 |
| `./sylph.sh status` | 查看运行状态 |
| `./sylph.sh logs` | 查看实时日志 |

### 安装与维护

| 命令 | 说明 |
|------|------|
| `./sylph.sh install` | 初始化安装 |
| `./sylph.sh update` | 更新到最新版本（保留配置） |
| `./sylph.sh uninstall` | 完全卸载 |

### 版本更新

```bash
# 检查并更新到最新版本
./sylph.sh update
```

更新时会自动：
- 备份用户配置（书签、密码、设置）
- 从 GitHub Release 下载最新版本
- 恢复配置并重启服务
- 显示版本变化和更新亮点

> 💡 更新后访问页面会自动弹出新功能说明。

### 开机自启

| 系统 | 命令 |
|------|------|
| **Linux** | `sudo ./sylph.sh enable` / `disable` |
| **macOS** | 脚本提示使用 launchd |
| **Windows** | 脚本提示使用任务计划程序 |

### 自定义安装目录

```bash
NAV_SYLPH_DIR=/opt/nav-sylph curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/sylph.sh | bash
```

## ⚙️ 系统配置

### 配置文件

| 文件 | 用途 | 说明 |
|------|------|------|
| `.env` | 服务器配置 | 端口、HTTPS 等 |
| `config.json` | 主配置 | 主题、搜索引擎、书签分类 |
| `favorites.json` | 收藏数据 | 导入的浏览器书签数据 |
| `.webdav-config.json` | WebDAV 配置 | 远程备份服务器配置（加密存储） |
| `version.json` | 版本信息 | 当前安装版本 |
| `.admin-password.json` | 管理密码 | 自动生成，bcrypt 加密存储 |

### 配置优先级

```
默认值 → server-config.json → .env → 环境变量
```

### 环境变量

复制 `.env.example` 为 `.env` 进行配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SERVER_HOST` | `127.0.0.1` | 监听地址 |
| `SERVER_PORT` | `4000` | 监听端口 |
| `HTTPS_ENABLED` | `false` | 启用 HTTPS |
| `HTTPS_KEY_PATH` | - | SSL 私钥路径 |
| `HTTPS_CERT_PATH` | - | SSL 证书路径 |

## 🖥️ 使用说明

### 默认账户

| 项目 | 值 |
|------|-----|
| 访问地址 | http://127.0.0.1:4000 |
| 管理密码 | `admin123` |

> ⚠️ **首次登录会提示修改默认密码！**

### 管理面板

点击页面 **右下角齿轮图标** 进入管理面板：

| 功能 | 说明 |
|------|------|
| **主题模式** | 跟随系统 / 浅色 / 深色 |
| **搜索引擎** | 设置默认引擎，添加自定义引擎 |
| **显示模式** | 图标+文字 / 纯文字 |
| **书签管理** | 添加/编辑/删除书签和分类 |
| **拖拽排序** | 拖动调整书签和分类顺序 |
| **收藏管理** | 导入/导出/管理收藏，支持批量删除和拖拽分类 |
| **WebDAV 备份** | 远程备份配置和收藏，支持选择性恢复 |
| **修改密码** | 更改管理密码 |

### 收藏检索

快速搜索大量收藏，支持从浏览器一键导入。

**导入收藏：**
1. 进入管理面板 → 收藏 → 导入收藏
2. 选择浏览器导出的书签 HTML 文件
3. 支持 Chrome、Edge、Firefox、Safari、Opera、Brave

**快速检索：**
1. 在搜索框输入 `/` 进入检索模式
2. 继续输入关键词，实时显示匹配结果
3. 支持标题、网址、分类、描述模糊匹配
4. `↑↓` 选择，`Enter` 打开，`Esc` 退出

**管理收藏：**
- 支持批量选择删除
- 拖拽收藏到分类标签快速更改分类
- 点击「+ 新分类」创建新的分类

**导出收藏：**
- 管理面板 → 收藏 → 导出收藏
- 导出为标准 HTML 格式，可导入任何浏览器

### 搜索功能

- 输入关键词按 `Enter` 搜索
- 点击搜索框左侧图标切换搜索引擎

### 跨设备文本分享

快速在不同设备间传递文本，无需登录、无需安装应用。

**发送文本：**
1. 在搜索框输入 `>` 或 `》` 进入分享模式
2. 输入要分享的内容，按 `Enter` 发送
3. 可选择设置 4 位 PIN 码保护
4. 复制生成的链接

**接收文本：**
- 在另一设备打开分享链接即可查看内容

**安全特性：**
- 🔐 端到端加密（AES-256-GCM），服务器无法查看原文
- ⏱️ 5 分钟自动过期
- 🗑️ 阅后即删，不持久存储
- 🔒 可选 PIN 码保护

### WebDAV 远程备份

支持将配置和收藏备份到 WebDAV 服务器（如坚果云、NextCloud 等）。

**配置备份：**
1. 进入管理面板 → 远程备份
2. 填写 WebDAV 服务器地址、用户名、密码
3. 点击「测试连接」验证配置
4. 点击「立即备份」创建备份

**备份内容：**
- 配置文件（JSON）：主题、搜索引擎、书签分类
- 收藏文件（HTML）：浏览器兼容格式，可直接导入 Chrome/Edge

**恢复备份：**
- 点击「从备份恢复」选择备份时间点
- 可选择「同时恢复配置和收藏」或「只恢复配置」

### PWA 安装

| 平台 | 方法 |
|------|------|
| **桌面浏览器** | 地址栏点击安装图标 |
| **iOS Safari** | 分享 → 添加到主屏幕 |
| **Android** | 菜单 → 添加到主屏幕 |

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | HTML5 + CSS3 + 原生 JavaScript (ES6+) |
| **后端** | Node.js + Express.js |
| **存储** | JSON 文件存储 |
| **安全** | bcrypt、Rate Limiting、安全响应头、XSS 防护 |
| **PWA** | Service Worker + Web App Manifest |

## 📁 目录结构

```
nav-sylph/
├── public/                 # 前端静态文件
│   ├── index.html         # 主页面
│   ├── app.js             # 前端逻辑
│   ├── styles.css         # 样式（含深色模式）
│   └── sw.js              # Service Worker
├── lib/                    # 后端模块
│   └── webdav-backup.js   # WebDAV 备份模块
├── server-config/          # 服务器配置模块
├── server.js              # 后端服务入口
├── sylph.sh               # 统一管理脚本
├── version.json           # 版本信息
├── CHANGELOG.json         # 更新日志
├── .env.example           # 环境变量示例
└── package.json           # 依赖配置
```

## 🔄 更新日志

查看 [CHANGELOG.json](CHANGELOG.json) 或 [Releases](https://github.com/mh567/nav-sylph/releases) 页面。

## 📄 许可证

MIT License

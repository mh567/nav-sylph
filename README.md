# Nav Sylph

一个极简、高效的个人导航与书签管理页面。

![预览](docs/preview.png)

## ✨ 核心特点

| 特点 | 说明 |
|------|------|
| **极简设计** | 纯净无广告，秒开体验，专注搜索与书签 |
| **书签管理** | 分类管理、拖拽排序、图标/纯文字两种显示模式 |
| **多搜索引擎** | 内置 Google、百度、Bing、DuckDuckGo，可自定义 |
| **主题切换** | 支持浅色/深色/跟随系统三种模式 |
| **PWA 支持** | 可安装到桌面或手机主屏，离线可用 |
| **响应式布局** | 完美适配移动端和桌面端 |
| **安全防护** | bcrypt 密码加密、Rate Limiting、安全头 |

## 🚀 快速开始

### 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/sylph.sh | bash
```

支持 **Linux** / **macOS** / **Windows** (Git Bash, WSL)

安装完成后显示：
- 服务运行状态和访问地址
- 默认管理密码
- 所有管理命令

### 手动安装

```bash
git clone https://github.com/mh567/nav-sylph.git
cd nav-sylph
npm install
npm start
```

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
| `config.json` | 书签数据 | 自动生成，通过管理面板编辑 |
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
| **修改密码** | 更改管理密码 |

### 搜索功能

- 输入关键词按 `Enter` 搜索
- 点击搜索框左侧图标切换搜索引擎

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
├── server-config/          # 服务器配置模块
├── server.js              # 后端服务入口
├── sylph.sh               # 统一管理脚本
├── .env.example           # 环境变量示例
└── package.json           # 依赖配置
```

## 📄 许可证

MIT License

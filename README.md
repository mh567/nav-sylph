# Nav Sylph

一个极简、高效的个人导航与书签管理页面。

![预览](docs/preview.png)

## 核心特点

| 特点 | 说明 |
|------|------|
| **极简设计** | 纯净无广告，秒开体验，专注搜索与书签 |
| **书签管理** | 分类管理、拖拽排序、图标/纯文字两种显示模式 |
| **多搜索引擎** | 内置 Google、百度、Bing、DuckDuckGo，可设置默认 |
| **PWA 支持** | 可安装到桌面或手机主屏，离线可用 |
| **响应式布局** | 完美适配移动端和桌面端，支持系统级暗黑模式 |
| **安全防护** | bcrypt 密码加密、Rate Limiting、安全头、XSS 防护 |

## 部署与管理

### 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/install.sh | bash
```

支持 Linux / macOS / Windows (Git Bash, WSL)

### 手动部署

```bash
git clone https://github.com/mh567/nav-sylph.git
cd nav-sylph
npm install
npm start
```

### 脚本说明

项目提供两个管理脚本：

#### `install.sh` - 一键部署脚本

| 命令 | 说明 |
|------|------|
| `./install.sh install` | 一键安装（克隆仓库、安装依赖、启动服务） |
| `./install.sh update` | 更新到最新版本（保留配置） |
| `./install.sh uninstall` | 完全卸载 |

```bash
# 自定义安装目录
NAV_SYLPH_DIR=/opt/nav-sylph ./install.sh install
```

#### `manage.sh` - 服务管理脚本

| 命令 | 说明 |
|------|------|
| `./manage.sh install` | 初始化：安装依赖、创建目录 |
| `./manage.sh start` | 启动服务（后台运行） |
| `./manage.sh stop` | 停止服务 |
| `./manage.sh restart` | 重启服务 |
| `./manage.sh status` | 查看运行状态 |
| `./manage.sh logs` | 查看实时日志 |
| `sudo ./manage.sh enable` | 安装为 systemd 服务（开机自启） |
| `sudo ./manage.sh disable` | 卸载 systemd 服务 |

## 系统配置

### 配置文件

| 文件 | 用途 |
|------|------|
| `.env` | 环境变量配置（主要配置文件） |
| `server-config.json` | JSON 格式服务器配置（可选） |
| `config.json` | 书签数据存储（自动生成） |
| `.admin-password.json` | 管理密码存储（自动生成） |

### 配置优先级

```
默认值 → server-config.json → .env → 环境变量
```

### 环境变量 (.env)

复制 `.env.example` 为 `.env` 进行配置：

```bash
# 服务器配置
SERVER_HOST=127.0.0.1
SERVER_PORT=4000

# HTTPS 配置（可选）
HTTPS_ENABLED=false
HTTPS_KEY_PATH=/path/to/key.pem
HTTPS_CERT_PATH=/path/to/cert.pem
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SERVER_HOST` | `127.0.0.1` | 监听地址 |
| `SERVER_PORT` | `4000` | 监听端口 |
| `HTTPS_ENABLED` | `false` | 是否启用 HTTPS |
| `HTTPS_KEY_PATH` | - | SSL 私钥路径 |
| `HTTPS_CERT_PATH` | - | SSL 证书路径 |

## 操作与使用

### 默认账户

| 项目 | 值 |
|------|-----|
| 访问地址 | http://127.0.0.1:4000 |
| 管理密码 | `admin123` |

> ⚠️ **首次登录后请立即修改密码！**

### 管理面板

点击页面右下角齿轮图标进入管理面板，可进行：

- **书签管理**：添加/编辑/删除书签和分类
- **拖拽排序**：拖动书签或分类调整顺序
- **搜索引擎**：设置默认搜索引擎
- **显示模式**：切换图标模式/纯文字模式
- **修改密码**：更改管理密码

### 搜索功能

- 输入关键词后按 `Enter` 搜索
- 点击搜索框左侧图标切换搜索引擎
- 支持 Google、百度、Bing、DuckDuckGo

### PWA 安装

- **桌面**：浏览器地址栏点击安装图标
- **手机**：浏览器菜单选择「添加到主屏幕」

## 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | HTML5 + CSS3 + 原生 JavaScript (ES6+) |
| **后端** | Node.js + Express.js |
| **存储** | JSON 文件存储 |
| **安全** | bcrypt 密码哈希、Rate Limiting、安全响应头 |
| **PWA** | Service Worker + Web App Manifest |

## 目录结构

```
nav-sylph/
├── public/                 # 前端静态文件
│   ├── index.html         # 主页面
│   ├── app.js             # 前端逻辑
│   ├── styles.css         # 样式
│   └── sw.js              # Service Worker
├── server-config/          # 服务器配置模块
├── server.js              # 后端服务入口
├── install.sh             # 一键部署脚本
├── manage.sh              # 服务管理脚本
├── .env.example           # 环境变量示例
└── package.json           # 依赖配置
```

## 许可证

MIT License

# VPS 部署指南

本文档介绍如何在 VPS 上部署 Nav Sylph 应用。

## 系统要求

- Linux (Ubuntu 20.04+ / Debian 11+ / CentOS 8+)
- Node.js 22+（`better-sqlite3` 要求；登录会话持久化在 SQLite 库中）
- 512MB RAM（最低）
- curl 或 wget
- 开放端口：4000（或自定义端口）

## 快速部署

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/sylph.sh | bash
```

安装脚本会自动：
1. 从 GitHub Release 下载最新版本
2. 安装依赖
3. 启动服务

### 自定义安装目录

```bash
NAV_SYLPH_DIR=/opt/nav-sylph curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/sylph.sh | bash
```

## 手动部署

### 1. 安装 Node.js

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**CentOS/RHEL:**
```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs
```

验证安装：
```bash
node --version  # v22.x.x
npm --version   # 10.x.x
```

### 2. 下载应用

```bash
# 创建目录
sudo mkdir -p /opt/nav-sylph
cd /opt/nav-sylph

# 从 Release 下载最新版本
LATEST_URL=$(curl -sL https://api.github.com/repos/mh567/nav-sylph/releases/latest | grep browser_download_url | cut -d'"' -f4)
curl -fsSL "$LATEST_URL" | tar -xz --strip-components=1

# 安装依赖
npm install --production
```

### 3. 配置应用

```bash
# 复制配置模板
cp .env.example .env

# 编辑配置
vim .env
```

推荐的生产配置：
```bash
SERVER_HOST=127.0.0.1
SERVER_PORT=4000
```

### 4. 启动服务

```bash
# 使用管理脚本启动
./sylph.sh start

# 查看状态
./sylph.sh status
```

### 5. 配置开机自启（Linux systemd）

```bash
sudo ./sylph.sh enable
```

或手动配置：

```bash
# 复制服务文件
sudo cp nav-sylph.service /etc/systemd/system/

# 重载并启用
sudo systemctl daemon-reload
sudo systemctl enable nav-sylph
sudo systemctl start nav-sylph

# 检查状态
sudo systemctl status nav-sylph
```

## 配置反向代理（推荐）

使用 Nginx 作为反向代理：

```bash
sudo apt install nginx  # Ubuntu/Debian
sudo yum install nginx  # CentOS
```

创建配置 `/etc/nginx/sites-available/nav-sylph`：

```nginx
server {
    listen 80;
    server_name nav.example.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

启用配置：
```bash
sudo ln -s /etc/nginx/sites-available/nav-sylph /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 配置 HTTPS（Let's Encrypt）

```bash
# 安装 Certbot
sudo apt install certbot python3-certbot-nginx

# 获取证书
sudo certbot --nginx -d nav.example.com
```

**登录 Cookie 与 HTTPS**：登录状态存放在 Cookie 中。服务端通过 nginx 回填的
`X-Forwarded-Proto` 头判断请求是否经 https 到达，是则给 Cookie 加 `Secure` 标记。
纯 http 部署会自动省略该标记，浏览器才肯保存——**只要按上面配置了证书与反代，
无需任何额外设置**。`security.cookieSecure` 仅用于覆盖这一自动判断，一般不要改。

若登录后始终提示未登录，先确认浏览器能收到 `Set-Cookie` 响应头：
`curl -i -X POST http://127.0.0.1:4000/api/verify-password -H 'X-Admin-Password: <密码>' -d '{}'`
应看到 `Set-Cookie: nav_session=...; HttpOnly; SameSite=Lax; Path=/`（经 https 时另带 `Secure`）。

## 更新应用

**前提：Node ≥ 22。** 从 1.5.27 起应用改用 SQLite 持久化登录会话，依赖的 `better-sqlite3`
在 Node 20 及以下会**段错误退出**，而 `npm install` 阶段不会报任何错——也就是说，版本不够时
更新会变成「文件已替换、服务起不来、且没有回滚」。因此 `./sylph.sh update` 会**先校验 Node 版本**，
不满足就直接拒绝，不会停服、不会替换任何文件。

```bash
node --version        # 必须 ≥ v22；否则先按上面「安装 Node.js」一节升级（旧版本仍在运行，升级 Node 本身安全）
cd /opt/nav-sylph
./sylph.sh update
```

更新时会自动：
- 校验 Node 版本（不足则中止）
- 备份用户配置（含 `nav-sylph.db`，仅用于更新失败时本地回滚）
- 下载最新版本
- 恢复配置并重启

> 会话库 `nav-sylph.db` 不在程序文件删除清单里，升级后仍在，因此更新不会让已登录的浏览器掉线。

## 安全检查清单

部署完成后，请确认以下事项：

- [ ] 修改默认密码 `admin123`
- [ ] 应用绑定 `127.0.0.1`（不直接暴露）
- [ ] 配置反向代理
- [ ] 启用 HTTPS
- [ ] 配置防火墙
- [ ] `.env` 权限为 600（`config.json`、`favorites.json`、`.admin-password.json`、`.webdav-config.json`、`nav-sylph.db` 由服务在创建/写入时收紧，并在每次启动兜底校正）

## 常用运维命令

```bash
# 服务管理
./sylph.sh start      # 启动
./sylph.sh stop       # 停止
./sylph.sh restart    # 重启
./sylph.sh status     # 状态
./sylph.sh logs       # 日志

# 更新
./sylph.sh update     # 更新到最新版本

# systemd 方式
sudo systemctl status nav-sylph
sudo systemctl restart nav-sylph
sudo journalctl -u nav-sylph -f
```

## 备份与恢复

### 备份

```bash
tar -czf backup-$(date +%Y%m%d).tar.gz \
  config.json \
  favorites.json \
  .admin-password.json \
  nav-sylph.db \
  .env
```

### 恢复

```bash
tar -xzf backup-20240101.tar.gz -C /opt/nav-sylph/
./sylph.sh restart
```

## 故障排除

### 服务无法启动

```bash
# 查看详细日志
./sylph.sh logs

# 手动运行测试
node server.js
```

### 端口被占用

```bash
# 查看端口占用
sudo lsof -i:4000

# 修改端口
vim .env  # 修改 SERVER_PORT
./sylph.sh restart
```

## 健康检查

```bash
curl -s http://127.0.0.1:4000/api/health
# 返回: {"status":"ok","timestamp":"..."}
```

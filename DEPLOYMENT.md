# VPS 部署指南

本文档介绍如何在 VPS 上部署导航页应用。

## 系统要求

- Linux (Ubuntu 20.04+ / Debian 11+ / CentOS 8+)
- Node.js 18+ 
- 512MB RAM（最低）
- 开放端口：4000（或自定义端口）

## 部署步骤

### 1. 安装 Node.js

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**CentOS/RHEL:**
```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
```

验证安装：
```bash
node --version  # v20.x.x
npm --version   # 10.x.x
```

### 2. 创建应用用户

```bash
sudo useradd -r -s /bin/false -d /opt/nav-sylph navsylph
```

### 3. 部署应用

```bash
# 创建目录
sudo mkdir -p /opt/nav-sylph
cd /opt/nav-sylph

# 下载/上传项目文件
# 方式1：从 Git 克隆
sudo git clone https://github.com/your-username/nav-sylph.git .

# 方式2：上传压缩包后解压
# scp nav-sylph.tar.gz user@server:/tmp/
# sudo tar -xzf /tmp/nav-sylph.tar.gz -C /opt/nav-sylph

# 设置权限
sudo chown -R navsylph:navsylph /opt/nav-sylph
```

### 4. 配置应用

```bash
# 复制配置模板
sudo -u navpage cp .env.example .env

# 编辑配置
sudo vim .env
```

推荐的生产配置：
```bash
SERVER_HOST=127.0.0.1
SERVER_PORT=4000
LOG_DIR=/opt/nav-sylph/logs
```

### 5. 安装依赖

```bash
cd /opt/nav-sylph
sudo -u navsylph npm install --production
```

### 6. 配置 Systemd

```bash
# 复制服务文件
sudo cp nav-sylph.service /etc/systemd/system/

# 编辑服务文件（确认路径正确）
sudo vim /etc/systemd/system/nav-sylph.service

# 重载并启用
sudo systemctl daemon-reload
sudo systemctl enable nav-sylph
sudo systemctl start nav-sylph

# 检查状态
sudo systemctl status nav-sylph
```

### 7. 配置反向代理（推荐）

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

    # 自动跳转 HTTPS（如果启用）
    # return 301 https://$server_name$request_uri;

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

### 8. 配置 HTTPS（Let's Encrypt）

使用 Certbot 自动配置 SSL：

```bash
# 安装 Certbot
sudo apt install certbot python3-certbot-nginx  # Ubuntu/Debian

# 获取证书
sudo certbot --nginx -d nav.example.com

# 自动续期（已自动配置）
sudo systemctl status certbot.timer
```

### 9. 配置防火墙

**UFW (Ubuntu):**
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

**firewalld (CentOS):**
```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

## 安全检查清单

部署完成后，请确认以下事项：

- [ ] 修改默认密码 `admin123`
- [ ] 应用绑定 `127.0.0.1`（不直接暴露）
- [ ] 配置反向代理
- [ ] 启用 HTTPS
- [ ] 配置防火墙
- [ ] `.env` 和 `.admin-password.json` 权限为 600
- [ ] 日志目录权限正确

## 常用运维命令

```bash
# 查看服务状态
sudo systemctl status nav-sylph

# 查看日志
sudo journalctl -u nav-sylph -f
tail -f /opt/nav-sylph/logs/server.log

# 重启服务
sudo systemctl restart nav-sylph

# 停止服务
sudo systemctl stop nav-sylph

# 更新应用
cd /opt/nav-sylph
sudo -u navsylph git pull
sudo -u navsylph npm install --production
sudo systemctl restart nav-sylph
```

## 备份与恢复

### 备份

```bash
# 备份配置和数据
tar -czf backup-$(date +%Y%m%d).tar.gz \
  config.json \
  .admin-password.json \
  .env
```

### 恢复

```bash
# 恢复配置
tar -xzf backup-20240101.tar.gz -C /opt/nav-sylph/
sudo chown navsylph:navsylph /opt/nav-sylph/{config.json,.admin-password.json,.env}
sudo systemctl restart nav-sylph
```

## 故障排除

### 服务无法启动

```bash
# 查看详细日志
sudo journalctl -u nav-sylph -n 50 --no-pager

# 手动运行测试
cd /opt/nav-sylph
sudo -u navsylph node server.js
```

### 端口被占用

```bash
# 查看端口占用
sudo lsof -i:4000
sudo ss -tuln | grep 4000

# 修改端口
vim .env  # 修改 SERVER_PORT
sudo systemctl restart navigation-page
```

### 权限问题

```bash
# 修复权限
sudo chown -R navsylph:navsylph /opt/nav-sylph
sudo chmod 600 /opt/nav-sylph/.env
sudo chmod 600 /opt/nav-sylph/.admin-password.json
```

## 性能优化

### 启用 Gzip

在 Nginx 配置中添加：

```nginx
gzip on;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
gzip_min_length 1000;
```

### 静态资源缓存

```nginx
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
    proxy_pass http://127.0.0.1:4000;
    expires 7d;
    add_header Cache-Control "public, immutable";
}
```

## 监控建议

推荐配置以下监控：

1. **进程监控**：确保服务运行中
2. **端口监控**：确保 4000 端口响应
3. **日志告警**：监控错误日志
4. **磁盘空间**：监控日志目录大小

可以使用 `curl` 进行健康检查：

```bash
curl -s http://127.0.0.1:4000/api/health
# 返回: {"status":"ok","timestamp":"..."}
```

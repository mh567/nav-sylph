# 故障排查

按「症状 → 原因 → 解法」组织。每条都来自实际发生过的问题，不是设想。

排查前先跑这两条命令，它们能把大部分配置类问题直接定位：

```bash
node server.js config:validate   # 只校验配置，不开端口
node server.js config:print      # 打印合并后的最终配置（凭据已脱敏）
```

配置的合并顺序是：默认值 < `server-config.json` < `.env` < 环境变量。`config:print` 打出来的就是最终结果，比翻文件推断可靠。

---

## 服务起不来

### 启动即崩，报 `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string`

**原因**：安装目录根下有一份 `server-config.json`。Node 解析 `require('./server-config')` 的顺序是 `.js` → `.json` → `.node` → **目录**，所以这份 json 会遮蔽 `server-config/` 目录，整个模块一行都不执行，`rootDir` 拿不到值。

这个文件通常由后台的「自签证书」开关自己写出，内容往往只有 `{"security":{"selfSignedCert":true}}` 一段。

**解法**：

```bash
node server.js config:validate    # 先确认是不是这个问题
```

确认后，如果本来想用默认配置：

```bash
cp server-config.json server-config.json.bak && rm server-config.json
```

如果要保留自定义配置，参考 `server-config.example.json` 重写一份完整文件。注意 `rootDir` 是程序推导出来的，写不进配置，所以「补全配置」绕不开这个问题，让遮蔽不发生才是正解。

### 启动即崩，无任何输出（退出码 139）

**原因**：Node 版本低于 22。`better-sqlite3@13` 声明 `engines: >=22`，低版本加载它会段错误退出，而 `npm install` 阶段不报任何错。

**解法**：`node -v` 确认版本，升到 22 或更高后重新 `npm install`。

### 启动报 `secret-key must be set when users are configured`

这条不属于本项目。Habu 是单管理员模型，认证走 `.admin-password.json`，没有多用户配置，也不会出现这个字段。

看到这句说明你启动的很可能是同机安装的另一个项目（例如 glance），或者目录里混进了别的 `server.js`。先确认跑的是哪一份程序：

```bash
grep -c "Habu Server" ./server.js
```

本项目的 `server.js` 在启动横幅里有 `Habu Server` 字样，计数为 0 就说明找错文件了。

---

## 登录与访问

### 登录成功但刷新后又要求登录

**原因**：`cookieSecure` 默认为 `true`，浏览器只在 https 下保存该 Cookie。纯 http 部署（本地调试、内网直连）时 Cookie 被静默丢弃。

**解法**：在 `.env` 里显式设置：

```bash
COOKIE_SECURE=false
```

⚠️ 只在本服务确实跑在 http 下时才这么做。经反向代理的部署，代理回填 `X-Forwarded-Proto: https` 时程序会自动加 `Secure`，不需要改这一项。

### 改了 `server-config.json` 但设置不生效

**原因**：`config:print` 能看到实际生效的值。常见于两种情况：

- 环境变量优先级高于文件，`.env` 或 shell 里的同名变量把文件覆盖了。
- 字段名拼错，被 `deepMerge` 当成新键加进去，没有覆盖到原字段。

**解法**：

```bash
node server.js config:print
```

对照你写的内容，看差异出现在哪一层。

### HTTPS 只在环境变量里能开

**已修复**（本次改动）。旧版本 `loadFromEnv()` 里 `https.enabled` 未做「未设置」的区分，未设 `HTTPS_ENABLED` 时也会返回 `false`，把文件里的 `true` 压掉。现在写成 `env.HTTPS_ENABLED === undefined ? undefined : ...`，与 `cookieSecure`、`geoEnabled` 保持一致。

如果你还在旧版本上，只能用环境变量开 HTTPS。

---

## 升级

### 升级后一直提示有新版本

**原因**：`habu.sh` 的 `get_latest_release()` 读的是 GitHub **Release**（`/releases/latest`），不是 git tag。发布时只推了 tag、没执行 `gh release create`，就会出现「版本已更新但脚本永远认为有新版」。

**解法**：确认发布流程走的是仓库自带的 `scripts/release.sh`，它包含 `gh release create` 与附件上传两步。手工补发：

```bash
gh release create v<版本> dist/habu-v<版本>.tar.gz --notes "..."
```

### 升级后配置丢了

**原因**：`habu.sh` 在更新前会把 `config.json`、`.admin-password.json`、`.env`、`server-config.json`、`favorites.json`、`habu.db` 备份到 `/tmp/habu-backup-<时间戳>/`，失败时自动恢复。如果这些文件被手工改动或系统重启清空了 `/tmp`，备份可能不在了。

**解法**：检查 `/tmp/habu-backup-*/` 是否还在。日常应通过 WebDAV 备份（后台「备份」分区）保留一份远端副本，那才是跨设备、跨重装可用的。

### 升级后服务没起来，但 `systemctl restart` 返回成功

**原因**：`systemctl restart` 对「启动后立刻退出」的单元也返回 0。

**解法**：

```bash
systemctl status habu          # 看 Active 状态，不只看返回码
journalctl -u habu -n 100      # 服务自己的日志才有真正的堆栈
node server.js config:validate # 配置类问题先排除
```

---

## 首页与模块

### 首页卡片一直转圈，拿不到数据

**原因**：`module_cache` 里存的是配置变更**之前**的采集结果，TTL 未到就不会重采。

**解法**：改任何与采集目标相关的配置（增删服务器、改轮询周期）后，程序会自动失效该缓存。如果仍是旧值，重启一次服务即可。这条历史上出现过「新加的机器不出现、删掉的还在」，根因就是缓存没跟着配置失效。

### 模块区一片空白，没有任何提示

**原因**：早期版本里 `modulesError` 的判断排在「已启用模块为空」之后，配置拉取失败时列表为空，函数直接 `hidden` 返回，错误 UI 成了不可达代码。

**当前行为**：错误条会显示出来，并区分状态码。429 显示「请求过于频繁，请等一分钟再刷新」，不是「监控数据读取失败」。

如果仍看到空白，检查浏览器控制台里 `/api/modules/config` 的响应。

### 后台改了模块开关，刷新后自己弹回去

**原因**：保存失败被 `catch` 吞掉，界面回滚但没提示。常见于会话过期（401）或请求被限流（429）。

**解法**：打开开发者工具看 `/api/modules/config` 的响应状态。401 表示需要重新登录，429 表示一分钟后再试。

### 一台机器显示离线，但 agent 明明在跑

按顺序排查：

1. **拉取模式**：本服务能否连到目标机的 4195 端口？点后台卡片上的「检测」。
   - `连不上` / 超时 → 网络不通或防火墙
   - `在线 · 未部署` → 端口有服务但不是我们的 agent
   - 证书变了 → 显示为「异常」，这是安全事件，不是离线
2. **推送模式**：判断依据是「多久没收到上报」，阈值为 `轮询周期 × 2 + 30s`。周期 300 秒时阈值是 630 秒，等一下属正常。
3. **自签证书**：agent 连本服务做 enroll / upgrade 时，若本服务用自签证书，目标机会报 `certificate signed by unknown authority`。需在后台勾选「本服务的 https 证书是自签的」，重新生成部署命令（命令会带上 `--server-ca`），改完要重启本服务。

两张机器的状态位在后台是两个（在线 / agent 就绪），首页合并成一个。首页显示「离线」时，去后台看是网络问题还是部署问题。

---

## 前端资源

### 改了 `public/` 下的文件，刷新看不到变化

按三层依次确认，不要用刷新来猜：

```bash
# 1. 磁盘上改了吗
grep -n "你改的内容" public/app.js

# 2. 服务端发出去的是新版吗（把 URL 换成实际路径）
curl -s http://127.0.0.1:4000/app.js | grep -c "你改的内容"

# 3. 浏览器里还是旧的吗
```

前两层都对、浏览器仍是旧版，就是 Service Worker 缓存在生效。在浏览器控制台执行：

```js
const regs = await navigator.serviceWorker.getRegistrations();
await Promise.all(regs.map(r => r.unregister()));
const keys = await caches.keys();
await Promise.all(keys.map(k => caches.delete(k)));
location.reload();
```

然后带一个查询参数打开，例如 `/?cachebust=1`。

⚠️ 这是本仓库最常踩的坑，已经四次把「服务端已修正」误判成「代码没生效」。

### 发布后回访用户仍拿到旧前端

**原因**：改了 `public/` 但没升 `public/sw.js` 的 `CACHE` 常量。

**当前行为**：`scripts/release.sh` 加了预检，`public/` 有变更而 `CACHE` 未提升时会直接退出并报错。

手工检查：

```bash
grep -n "const CACHE" public/sw.js
git diff <上一个 tag> -- public/ | head
```

---

## 数据与备份

### WebDAV 备份里没有监控凭据

**这是设计如此**。`servers[].token`、`pushSecretHash`、`enrollTokenHash` 全部剔除。原因是凭据密钥派生自管理员密码哈希，而 bcrypt 带盐，换一台机器用同一口令得到的是不同的哈希，密文解不开。恢复后需要重新部署 agent。

`certPem`、`certFingerprint`、`enrolledAt` 是公钥与注册信息，会保留。

`.admin-password.json` 始终不进备份，把密码哈希交出去等于把账号交出去。

### 恢复失败，报 `restore_halted`

**原因**：恢复过程中某个域写入失败，且逐字节回滚也失败了。受影响域的读写全部返回 503，`/api/health` 报 `degraded`。

**解法**：这是需要人工介入的状态，程序刻意不自动重试。查看 `logs/` 下的错误，确认快照目录 `.restore-snapshot/<runId>/` 完好后，联系维护者或按备份重新恢复。

### 修改密码后，监控与 WebDAV 凭据失效

**原因**：凭据密钥由管理员密码哈希派生，改密码会重新加密全部凭据。如果某个凭据在此前已经解不开（更早一次改密码的遗留），会保留原值并在响应的 `details` 里列出，需要重新输入。

如果连 `.admin-password.json` 也丢了、且没有旧密码的备份，这些凭据永久无法恢复。这是「不另存主密钥」的直接代价。推送凭据不受影响（它不派生自管理员密码），但重新领取需要先能登录。

---

## 提交问题前

请附上这些信息，能省掉很多来回：

```bash
node -v
cat version.json
node server.js config:validate
node server.js config:print
journalctl -u habu -n 100     # systemd 部署
```

`config:print` 的输出已经对密码、密钥一类的字段做了脱敏，可以整段贴出。它仍会显示路径，如果你不希望公开目录结构，删掉 `paths` 段即可。

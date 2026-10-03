# Nav Sylph 监控 agent

部署在**被监控的目标机**上，让 Nav Sylph 服务能读到这台机器的 CPU、内存与负载。

本服务只能读到运行它自己的那台主机。要看别的机器，目标机上就得有一个东西去读系统计数器并把结果吐出来——这就是 agent 的全部职责。

## 特性

- **单文件、无依赖、无构建步骤**。`node agent.js` 就能跑，不需要 `npm install`
- **只读**。只读系统计数器，不写任何文件、不执行外部命令（macOS 上读 `vm_stat` 是唯一的例外，见下）
- **跨平台**。Linux 读 `/proc`，macOS 读 `vm_stat`，其它平台退回 Node 的 `os` 模块
- **两种上报方向**。拉取（默认，起一个 HTTPS 服务等本服务来连）或推送（`--push`，只做出站连接，**不监听任何端口**）
- **token 鉴权**。token 从环境变量读、不落盘
- **拉取模式强制 TLS**。没有证书就拒绝启动，不提供「默认明文」这个选项

## 前置要求

- **Node.js 18 或更高**
- 拉取模式：需要能被 Nav Sylph 服务访问到（同一局域网，或公网可达）
- 推送模式：只需能**访问** Nav Sylph 服务（出站即可）。家里局域网里的机器用这种方式

检查：`node --version`

## 选哪种模式

| | 拉取（默认） | 推送（`--push`） |
| --- | --- | --- |
| 谁主动 | Nav Sylph 服务来连这台机器 | 这台机器把指标送上去 |
| 目标机要开端口 | **要**（默认 4195） | **不要，一个都不开** |
| 传输 | **HTTPS（强制）** | 取决于本服务自己的 TLS |
| 目标机的网络要求 | 能被服务访问到（同局域网或公网可达） | 能访问服务即可 |
| 适合 | 两台机器网络互相可达 | 目标机在家里局域网、服务在公网 |

判断方法：后台「模块 → 监控目标」里每台**拉取**模式的机器都有一个「检测连通性」按钮，
点一下会真的去连一次。够不着就改用推送。

> 拉取模式那栏的「传输：HTTPS（强制）」是硬要求——没有证书时 agent 拒绝启动。
> 它与**本服务自己**是否配了 HTTPS 无关：握手发生在「服务 → 目标机」之间，
> 你的 nginx/certbot 保护的是服务自己，目标机这个端口的 TLS 得由目标机自己负责。

**推送模式一个端口都不开**——这是它相对拉取最大的安全收益：
内网机器上不会多出一个只靠 token 保护的网络服务。

## 快速开始（拉取模式）

```bash
# 1. 下载
mkdir -p /opt/nav-agent && cd /opt/nav-agent
curl -fsSL http://<你的服务器地址>/agent/agent.js -o agent.js

# 2. 生成 TLS 证书（只需一次）
sudo node agent.js --gen-cert /opt/nav-agent
```

第 2 步会打印一串证书指纹，**把它抄下来**——后台配对时要逐字核对。

```bash
# 3. 先手工跑一次，确认能通
NAVSYLPH_TOKEN=<你的 token> node agent.js \
  --tls-cert /opt/nav-agent/cert.pem \
  --tls-key /opt/nav-agent/key.pem \
  --host 0.0.0.0
```

看到 `监听 https://0.0.0.0:4195` 和一串证书指纹就说明正常。`--host 0.0.0.0` 是必须的：不加的话默认只监听 `127.0.0.1`，别的机器连不上。

```bash
# 4. 回到 Nav Sylph 后台，点这台机器的「检测连通性」
#    核对指纹一致后勾选确认，这台机器才会开始上报
```

**为什么必须带证书。** 拉取模式下 token 是这台机器的唯一凭据，拿到就能读它的 CPU、内存与主机名。走明文 HTTP 等于把这个凭据公开在网络上，所以 agent 没有证书就**拒绝启动**——它不会降级去监听明文端口。

**token 要和后台「模块 → 监控目标」里那台服务器填的一致。**

## 快速开始（推送模式）

后台「模块 → 监控目标」里把这台机器的「采集方式」选成**推送**，
点「部署」，面板会给出可直接复制的三步命令。凭据由服务端下发，不要手写。

```bash
# 1. 下载（同上）

# 2. 手工跑一次确认能推上去
NAVSYLPH_PUSH_SECRET=<凭据> NAVSYLPH_SERVER_ID=<id> \
  node agent.js --push https://你的服务器地址
```

看到 `推送目标 …/api/modules/agent-push` 和 `未监听任何端口` 就说明正常。
**没有「放行防火墙」这一步**——推送不开端口。

## 参数

### 拉取模式

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | 4195 | 监听端口 |
| `--host` | 127.0.0.1 | 监听地址。跨机访问必须显式设 `0.0.0.0` |
| `--tls-cert <路径>` | 无 | TLS 证书（PEM）。**拉取模式必填** |
| `--tls-key <路径>` | 无 | TLS 私钥（PEM）。**拉取模式必填** |
| `--gen-cert <目录>` | — | 生成自签证书到该目录并打印指纹，然后退出。只需跑一次 |
| `--insecure-http` | 关 | 逃生门：明文监听。仅限已确认走可信网络的场景 |
| `--token` | 无 | Bearer token。**优先用环境变量 `NAVSYLPH_TOKEN`**——命令行参数会出现在 `ps` 输出和 shell 历史里 |
| `--expose-hostname` | 关 | 让 `/health` 也返回主机名。默认**不返回**，因为 `/health` 不需要鉴权 |

`--tls-cert` 与 `--tls-key` **两个都要给**，只给一个会报错退出。

`--gen-cert` 需要目标机上有 `openssl`（各 Linux 发行版默认都有）。它生成 `cert.pem` 与 `key.pem`，并把私钥权限收紧到 `600`。

### 推送模式

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--push <地址>` | 无 | 本服务的地址。给了就进入推送模式，且**默认不监听任何端口** |
| `--interval <秒>` | 15 | 上报间隔。可选 `10`/`15`/`30`/`60`/`300`，与后台的更新周期同一组值 |
| `--server-id <id>` | 无 | 后台里那台服务器的 id。**优先用环境变量 `NAVSYLPH_SERVER_ID`** |
| `--push-secret <凭据>` | 无 | 推送凭据。**优先用环境变量 `NAVSYLPH_PUSH_SECRET`** |
| `--port` | — | 额外**同时**开启拉取模式（推送模式默认不开端口，加了这个就两个模式都跑） |

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `NAVSYLPH_TOKEN` | 拉取模式的 Bearer token |
| `NAVSYLPH_PUSH_SECRET` | 推送模式的凭据 |
| `NAVSYLPH_SERVER_ID` | 推送模式的目标机器 id |

**两个凭据是分开的**，用途不同、互不顶替。填错变量名的表现是推送一直返回
「推送凭据无效」，而日志里不会说你是填错了变量。

## 端点

| 路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /health` | 否 | 存活检查，返回 `{"status":"ok","version":1}`。**不含主机名** —— 它不需要鉴权，泄露主机名等于给每个能扫到该端口的人一份资产清单 |
| `GET /metrics` | **是** | 指标 JSON，需要 `Authorization: Bearer <token>`。主机名在这里 |

拉取模式下这两个端点**只走 HTTPS**：没配证书时 agent 拒绝启动。

`/metrics` 返回：

```json
{
  "version": 1,
  "cpu": 0.234,
  "memoryUsed": 5033164800,
  "memoryTotal": 17179869184,
  "memoryPercent": 0.293,
  "load1": 1.82,
  "load5": 1.41,
  "uptime": 691652,
  "cores": 8,
  "hostname": "my-nas",
  "platform": "linux",
  "sampledAt": 1790872081324
}
```

`cpu` 为 `null` 表示两次采样间隔过短、没有可比的差值——这不是 0%，别当成「完全空闲」读。

## 配成开机自启（systemd）

```bash
sudo tee /etc/systemd/system/nav-agent.service >/dev/null <<'EOF'
[Unit]
Description=Nav Sylph 监控 agent
After=network.target

[Service]
Environment=NAVSYLPH_TOKEN=<你的 token>
ExecStart=/usr/bin/node /opt/nav-agent/agent.js --tls-cert /opt/nav-agent/cert.pem --tls-key /opt/nav-agent/key.pem --host 0.0.0.0 --port 4195
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nav-agent
```

检查：`systemctl status nav-agent`

> `ExecStart` 里的 `/usr/bin/node` 换成目标机上 `which node` 的实际输出——用 nvm 装的话路径通常在 `~/.nvm/versions/node/...`。

## 防火墙

只在本机启用了防火墙时才需要：

```bash
# firewalld
sudo firewall-cmd --permanent --add-port=4195/tcp
sudo firewall-cmd --reload

# 或 ufw
sudo ufw allow 4195/tcp
```

## 排错

### 拉取模式的常见问题

| 现象 | 检查 |
| --- | --- |
| agent 启动就退出，提示「拉取模式需要 TLS 证书」 | 没给 `--tls-cert/--tls-key`。先跑 `node agent.js --gen-cert /opt/nav-agent` |
| 后台显示「证书未受信任」 | 还没配对。在后台点这台机器的「检测连通性」，核对指纹后确认 |
| 后台显示「证书与已确认的不一致」 | 目标机换了证书。**如果是你重新生成过证书**，在后台重新配对一次；**如果不是，中间人**。别急着重新确认 |
| 后台显示「无法连接」 | `curl -k https://<目标机>:4195/health` 是否通；防火墙是否放行；`--host` 是不是漏了 `0.0.0.0` |
| 后台显示「凭据被拒绝」 | token 与后台填的不一致。注意 `NAVSYLPH_TOKEN` 改了要重启 agent |
| 后台显示「连接超时」 | 网络不通或端口被拦；跨机时先在目标机上 `curl -k https://localhost:4195/health` 确认 agent 本身活着 |
| CPU 一直是 `—` | 极少发生。正常情况下不会是 `null`；持续为 `null` 说明采样逻辑异常，请提 issue 并附平台信息 |
| macOS 上内存占用偏高 | 正常。macOS 把内存拿去做文件缓存，本 agent 已用 `vm_stat` 排除可回收缓存，读数与「活动监视器」一致 |

> 自检命令要带 `-k`（或 `--cacert`）：目标机用的是自签证书，普通 `curl https://…` 会报证书错误，那是预期的，不是故障。

### 推送模式的常见问题

推送的失败模式与拉取完全不同：拉取失败会立刻显示原因，推送是「一段时间没收到」。
先看 **agent 的终端输出**，再对照下表。

| 现象 | 检查 |
| --- | --- |
| agent 报「推送凭据无效」 | 后台的凭据被重新领过了（重新领会立刻作废旧凭据）。用当前这一枚，或重新打开「部署」面板取新的 |
| agent 报「凭据与 serverId 不匹配」 | `NAVSYLPH_SERVER_ID` 与后台那台服务器对不上。id 在后台的「部署」面板里能看到 |
| agent 报「fetch failed」 | 目标机连不到本服务。检查网络、代理、本服务地址是否写对（`--push` 后面要带 `http://` 或 `https://`） |
| agent 报「上报过于频繁」 | 命中服务端限流（120 次/分钟）。把 `--interval` 调大，别小于 10 秒 |
| 后台显示「尚未收到推送」 | agent 从没成功推上来。**先看 agent 终端有没有报错** |
| 后台显示「已 N 分钟未收到推送」 | 之前推成功过、现在断了。**卡片上仍保留断线前的数值**，可据此判断是网断了还是机器关了 |
| 一直退避不恢复 | 退避上限 5 分钟。改完配置后不用等，`systemctl restart nav-agent` 立刻生效 |

**最快的排查方式**：在目标机上直接看 agent 的 stderr，它会把服务端返回的
错误原文打出来（`[push] 上报失败：<原因>`）。

## 指标口径

- **CPU** —— 两次采样（间隔 200ms）的累计时间差分。`os.cpus()` 与 `/proc/stat` 给的都是自开机以来的累计值，单次读没有百分比
- **内存** —— `已用 = 总内存 − 可用`。Linux 的可用取 `MemAvailable`，macOS 的可用取 `free + inactive + speculative + purgeable`（`inactive` 是可回收的文件缓存，算作可用才是用户视角）
- **负载** —— Linux 取 `/proc/loadavg`，macOS 取 `os.loadavg()`

## 安全

### token 泄露意味着什么

**拿到 agent token ≈ 拿到那台机器的实时只读监控数据。** 具体是：CPU 与内存占用、系统负载、运行时长、主机名（`/metrics` 里返回）。

**不能**通过 agent 执行命令、改配置、读文件或访问内网其它主机 —— agent 只读系统计数器，只回 JSON。

真正要防的是信息泄露与被当作跳板：

1. **内网信息泄露。** 监控目标通常是 NAS、软路由、家用机，这些恰好常在局域网。token 一旦泄露且那台机器可达，攻击者就知道你家有哪些机器、叫什么、什么时候开着。
2. **公开暴露的 agent。** 若某台 agent 设了 `--host 0.0.0.0` 而防火墙又没关，那它就是一个公开的「你的机器都在这里」的信息源。
3. **横向移动的跳板。** 主机名 + 内网角色信息（NAS、路由器）会帮攻击者判断下一步打哪台。

**token 是明文等价的凭据**：它在命令行与环境变量里都是明文，`ps` 输出与 shell 历史都看得到。所以：

- 优先用**环境变量** `NAVSYLPH_TOKEN` 而非 `--token`
- 目标机上的 token 用**每台不同**的值，别所有机器共用一个 —— 共用时泄一台等于泄全部
- agent 只在你信任的网络里用 `--host 0.0.0.0`；能走 VPN 或 SSH 隧道就别直接暴露端口

### 传输为什么必须是 HTTPS

token 能读到 CPU、内存、系统负载与主机名。**走明文 HTTP 等于把这个凭据公开在网络上** —— 同一网段里的任何人抓一次包就拿到了。所以 agent 在拉取模式下**没有证书就拒绝启动**，不提供「默认明文」这个选项。

自签证书的信任靠**首次使用即信任（TOFU）**：

1. `node agent.js --gen-cert /opt/nav-agent` 生成证书，**把打印的指纹抄下来**
2. 在 Nav Sylph 后台点「检测连通性」，它会显示同一个指纹
3. **逐字核对两者一致**后勾选确认

第 3 步不能省。「检测连通性」这一步只能告诉你「对面有一张证书」，不能告诉你「那张证书是那台机器的」—— 而第 1 步的指纹印在**目标机终端**上，是一条独立于本服务的核对途径。两者一致才说明中间没有别人。

配对之后，这台机器的证书就被记住了。**如果它后来变了**（你在目标机重新生成了证书，或有人在中间替换），后台会显示「证书与已确认的不一致」：

- 是你自己重新生成的 → 在后台重新配对一次
- 不是 → **有人在中间**，先查网络

### 泄露后怎么办

1. 在 Nav Sylph 后台「模块 → 监控目标」点该服务器的「编辑」，**填一个全新的 token**（清空再填新值即覆盖旧值）
2. 到目标机上改 `NAVSYLPH_TOKEN` 并重启 agent：

   ```bash
   sudo systemctl edit nav-agent   # 或直接编辑 unit 文件
   # 把 Environment=NAVSYLPH_TOKEN=... 换成新值
   sudo systemctl daemon-reload && sudo systemctl restart nav-agent
   ```

3. 确认新 token 生效：后台卡片恢复在线，或 `curl -k -H "Authorization: Bearer <新token>" https://<目标机>:4195/metrics`（返回指标 JSON 即鉴权通过）

旧 token 立刻失效，无需额外操作 —— 它只存在于配置里，服务端不保存明文。

> 改 token **不需要**改 Nav Sylph 的管理密码，也不需要重新部署 agent，也**不需要重新配对证书**。三者独立。

### 推送凭据泄露意味着什么

**拿到推送凭据 ≈ 能伪造那台机器的监控数据。** 具体是：能往 Nav Sylph 写任意指标
（会被显示在所有人的首页上），但**不能**读到其它机器、不能改配置、不能执行命令。

推送凭据与 agent token 是**两回事**：

| | agent token（拉取） | 推送凭据（推送） |
| --- | --- | --- |
| 方向 | 服务来问 | 机器去报 |
| 泄露后果 | 读到那台机器的实时指标 | 能**伪造**那台机器的指标 |
| 存在哪 | 配置里的密文 | 配置里的哈希（明文只在领取时出现一次） |
| 怎么换 | 后台「编辑」填新值 | 重新打开「部署」面板领取（旧的立即失效） |

**推送凭据泄露比 token 泄露轻**：token 是「读到真实数据」，凭据是「写入假数据」——
后者不泄露信息，但会误导监控。两种凭据都要每台不同。

轮换推送凭据：后台点「部署」会领一枚新的，**旧的立即失效**，
所以要同步更新目标机上的 `NAVSYLPH_PUSH_SECRET` 再重启 agent，否则会开始报
「推送凭据无效」。

### 已有防护

- token 只从环境变量或 `--token` 读，**不写任何文件**
- `/metrics` 需要鉴权；未授权返回 `{"error":"unauthorized"}` —— 不提示 token 的长度或前缀，避免帮攻击者缩小猜测空间
- token 比较用 `crypto.timingSafeEqual` 定长比较
- **`/health` 默认不返回主机名**。它不需要鉴权，所以只回 `{"status":"ok","version":1}`；主机名只出现在需要鉴权的 `/metrics` 里。只有确定端口没暴露到不可信网络时，才用 `--expose-hostname` 让 `/health` 也带上它
- agent 只读 `/proc`（或 `os` 模块），不写任何文件、不执行外部命令
- **推送模式默认不监听任何端口**，内网机器上不会多出一个网络服务
- 推送载荷在落库前被压到已知形状：越界的数值回落为安全值（`cpu` 越界变 `—`），
  超长字符串被截断，超过 4KB 的载荷整个拒收
- 推送端点有独立的限流桶（120 次/分钟），不会消耗管理端或匿名读接口的配额

## 协议版本

`/metrics` 返回里的 `version` 必须与服务端一致，不一致时 Nav Sylph 会明确报错而不是把不认识的字段当 0 读进去。当前 `VERSION = 1`。

**推送模式没有改变协议**：两种模式上报的指标载荷字段完全一样，
所以推送不构成版本变更，`VERSION` 仍是 1。看到这里若以为漏升版本，那是没升。

升级服务端后，如果目标机上的 agent 还是旧版，卡片会显示「agent 协议版本 X 与服务端 Y 不一致」——重新下载 agent 即可。

# Nav Sylph 监控 agent

部署在**被监控的目标机**上，让 Nav Sylph 服务能读到这台机器的 CPU、内存与负载。

本服务只能读到运行它自己的那台主机。要看别的机器，目标机上就得有一个东西去读系统计数器并把结果吐出来——这就是 agent 的全部职责。

## 特性

- **单文件、无依赖、无构建步骤**。`node agent.js` 就能跑，不需要 `npm install`
- **只读**。只读系统计数器，不写任何文件、不执行外部命令（macOS 上读 `vm_stat` 是唯一的例外，见下）
- **跨平台**。Linux 读 `/proc`，macOS 读 `vm_stat`，其它平台退回 Node 的 `os` 模块
- **token 鉴权**。token 从环境变量读、不落盘

## 前置要求

- **Node.js 18 或更高**
- 能被 Nav Sylph 服务访问到（同一局域网，或公网可达）

检查：`node --version`

## 快速开始

```bash
# 1. 下载
mkdir -p /opt/nav-agent && cd /opt/nav-agent
curl -fsSL http://<你的服务器地址>/agent/agent.js -o agent.js

# 2. 先手工跑一次，确认能通
NAVSYLPH_TOKEN=<你的 token> node agent.js --port 4195 --host 0.0.0.0
```

看到 `监听 0.0.0.0:4195` 就说明正常。`--host 0.0.0.0` 是必须的：不加的话默认只监听 `127.0.0.1`，别的机器连不上。

**token 要和后台「模块 → 监控目标」里那台服务器填的一致。**

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | 4195 | 监听端口 |
| `--host` | 127.0.0.1 | 监听地址。跨机访问必须显式设 `0.0.0.0` |
| `--token` | 无 | Bearer token。**优先用环境变量 `NAVSYLPH_TOKEN`**——命令行参数会出现在 `ps` 输出和 shell 历史里 |

## 端点

| 路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /health` | 否 | 存活检查，返回 `{"status":"ok","version":1,"hostname":"..."}` |
| `GET /metrics` | **是** | 指标 JSON，需要 `Authorization: Bearer <token>` |

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
ExecStart=/usr/bin/node /opt/nav-agent/agent.js --port 4195 --host 0.0.0.0
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

| 现象 | 检查 |
| --- | --- |
| 后台显示「无法连接」 | `curl http://<目标机>:4195/health` 是否通；防火墙是否放行；`--host` 是不是漏了 `0.0.0.0` |
| 显示「凭据被拒绝」 | token 与后台填的不一致。注意 `NAVSYLPH_TOKEN` 改了要重启 agent |
| 显示「连接超时」 | 网络不通或端口被拦；跨机时先在目标机上 `curl localhost:4195/health` 确认 agent 本身活着 |
| CPU 一直是 `—` | 极少发生。正常情况下不会是 `null`；持续为 `null` 说明采样逻辑异常，请提 issue 并附平台信息 |
| macOS 上内存占用偏高 | 正常。macOS 把内存拿去做文件缓存，本 agent 已用 `vm_stat` 排除可回收缓存，读数与「活动监视器」一致 |

## 指标口径

- **CPU** —— 两次采样（间隔 200ms）的累计时间差分。`os.cpus()` 与 `/proc/stat` 给的都是自开机以来的累计值，单次读没有百分比
- **内存** —— `已用 = 总内存 − 可用`。Linux 的可用取 `MemAvailable`，macOS 的可用取 `free + inactive + speculative + purgeable`（`inactive` 是可回收的文件缓存，算作可用才是用户视角）
- **负载** —— Linux 取 `/proc/loadavg`，macOS 取 `os.loadavg()`

## 安全

- token 只从环境变量或 `--token` 读，**不写任何文件**
- `/metrics` 需要鉴权，`/health` 不需要（只返回版本与主机名，不含任何指标）
- 未授权的响应体是 `{"error":"unauthorized"}`——不提示 token 的长度或前缀，避免帮攻击者缩小猜测空间
- token 比较用 `crypto.timingSafeEqual` 定长比较

## 协议版本

`/metrics` 返回里的 `version` 必须与服务端一致，不一致时 Nav Sylph 会明确报错而不是把不认识的字段当 0 读进去。当前 `VERSION = 1`。

升级服务端后，如果目标机上的 agent 还是旧版，卡片会显示「agent 协议版本 X 与服务端 Y 不一致」——重新下载 agent 即可。

#!/usr/bin/env bash
#
# Nav Sylph 监控 agent 一键安装。
#
# 用法（后台「部署」面板会生成这一行）：
#   curl -fsSL <本服务>/agent/install.sh | sudo bash -s -- \
#     --server <本服务地址> --enroll <一次性令牌> [--mode pull|push]
#
# 这个脚本只做四件事：下二进制、注册、配 systemd、自检。
# 证书由 agent 自己生成（Go 的 crypto/x509 能签发，不需要 openssl），
# 所以这里没有证书相关步骤——那是上一版最让人烦躁的部分。
#
# ⚠️ 凭据不写进 systemd unit。unit 会被 systemctl cat / show / status 打印出来，
# 也常被用户贴进 issue；所以走 EnvironmentFile，权限 0600。

set -euo pipefail

# ========== 参数 ==========

SERVER=""
ENROLL_TOKEN=""
MODE=""
HOST_ARG=""
PORT_ARG=""
INTERVAL_ARG=""
BIN_URL_OVERRIDE=""
SKIP_SYSTEMD=0

log()  { printf '\033[0;34m[安装]\033[0m %s\n' "$1"; }
ok()   { printf '\033[0;32m  ✓\033[0m %s\n' "$1"; }
warn() { printf '\033[0;33m[注意]\033[0m %s\n' "$1"; }
die()  { printf '\033[0;31m[错误]\033[0m %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --server)   SERVER="${2:-}"; shift 2 ;;
        --enroll)   ENROLL_TOKEN="${2:-}"; shift 2 ;;
        --mode)     MODE="${2:-}"; shift 2 ;;
        --host)     HOST_ARG="${2:-}"; shift 2 ;;
        --port)     PORT_ARG="${2:-}"; shift 2 ;;
        --interval) INTERVAL_ARG="${2:-}"; shift 2 ;;
        --bin-url)  BIN_URL_OVERRIDE="${2:-}"; shift 2 ;;
        --no-systemd) SKIP_SYSTEMD=1; shift ;;
        -h|--help)
            sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) die "未知参数：$1" ;;
    esac
done

[ -n "$SERVER" ]     || die "缺少 --server（本服务地址）"
[ -n "$ENROLL_TOKEN" ] || die "缺少 --enroll（后台生成的一次性令牌）"
SERVER="${SERVER%/}"

# ========== 平台与架构 ==========

# ⚠️ 平台检查在 root 检查**之前**：在 macOS 上跑，用户首先需要知道的是
# 「这个装不了」，而不是「请用 sudo」——后者会让人以为加上 sudo 就能装。
#
# 只支持 Linux。发布包里是 Linux 的静态二进制，在 macOS/BSD 上跑这个脚本
# 会一路通过所有检查，然后下载一个跑不起来的 Linux ELF、写 systemd、
# systemctl 失败 —— 用户看到的是一连串莫名其妙的错误。
case "$(uname -s)" in
    Linux) ;;
    *) die "agent 只支持 Linux（发布包里是 Linux 的静态二进制）。
当前系统是 $(uname -s)，无法安装。
如果你是在 macOS 上开发，请直接用仓库里构建好的本机产物自测：
  bash scripts/build-agent.sh && ./agent/dist/nav-agent-\$(uname -s | tr A-Z a-z)-\$(uname -m) version" ;;
esac

[ "$(id -u)" -eq 0 ] || die "请用 sudo 运行（需要写 /usr/local/bin 与 /etc/systemd/system）"

# uname -m 的输出在不同平台/架构上有别名，统一映射到发布包里的名字。
detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)            echo "amd64" ;;
        aarch64|arm64)           echo "arm64" ;;
        armv7l|armv7|armhf)      echo "armv7" ;;
        armv6l|armv6)            echo "armv7" ;;  # armv6 向后兼容 v7 运行时
        i386|i686)               die "暂不支持 32 位 x86（这个架构太旧了）" ;;
        *) die "不支持的架构：$(uname -m)。请在后台反馈需要支持哪个。" ;;
    esac
}

ARCH="$(detect_arch)"
BIN_PATH="/usr/local/bin/nav-agent"
BIN_URL="${BIN_URL_OVERRIDE:-${SERVER}/agent/nav-agent-linux-${ARCH}}"

log "Nav Sylph agent 安装"
echo "  本服务 $SERVER"
echo "  架构   $ARCH ($(uname -m))"
echo ""

# ========== 下载二进制 ==========

log "下载 agent（$ARCH）"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# curl 的 -f 让 404 变成非零退出，而不是把错误页当成二进制写下去。
if ! curl -fsSL --retry 2 --connect-timeout 15 "$BIN_URL" -o "$TMP/nav-agent"; then
    die "下载失败：$BIN_URL
若本服务是刚升级的，可能还没构建 agent 二进制。
服务端需要跑一次 scripts/build-agent.sh 再重新发布。"
fi

# 校验它真的是 ELF 而不是一段错误文本——curl -f 已经挡掉 404，
# 但「服务端返回了 200 的 HTML 错误页」这种情况仍需自己判断。
if ! head -c 4 "$TMP/nav-agent" | grep -q 'ELF' 2>/dev/null; then
    # macOS 的 file 命令对 Linux ELF 也能识别；没有 file 时退回上面的字节判断
    if command -v file >/dev/null 2>&1; then
        file "$TMP/nav-agent" | grep -q ELF || {
            rm -f "$TMP/nav-agent"
            die "下载到的不是可执行文件（架构可能不匹配）。"
        }
    fi
fi

chmod 755 "$TMP/nav-agent"
ok "已下载 $(du -h "$TMP/nav-agent" | cut -f1)"

install -m 0755 "$TMP/nav-agent" "$BIN_PATH"
ok "已安装到 $BIN_PATH"

# ========== 注册 ==========

# 注册会：生成自签证书 → 把证书交给本服务 → 换回长期凭据 → 写 /etc/nav-agent/config.json
# 令牌用完即废，不会被写进任何持久配置。
log "注册到本服务"
ENROLL_ARGS=(enroll --server "$SERVER" --token "$ENROLL_TOKEN")
[ -n "$MODE" ] && ENROLL_ARGS+=(--mode "$MODE")
[ -n "$HOST_ARG" ] && ENROLL_ARGS+=(--host "$HOST_ARG")
[ -n "$PORT_ARG" ] && ENROLL_ARGS+=(--port "$PORT_ARG")
[ -n "$INTERVAL_ARG" ] && ENROLL_ARGS+=(--interval "$INTERVAL_ARG")

if ! "$BIN_PATH" "${ENROLL_ARGS[@]}"; then
    die "注册失败。上面是服务端返回的原文。
常见原因：
  · 令牌已过期（15 分钟有效）或已被用过（一次性）
  · 本服务地址填错，目标机连不上它
若令牌过期，回后台点「重新生成令牌」再执行一次。"
fi
ok "注册完成"

# ========== systemd ==========

if [ "$SKIP_SYSTEMD" -eq 1 ]; then
    warn "已跳过 systemd 配置（--no-systemd）"
elif ! command -v systemctl >/dev/null 2>&1; then
    warn "这台机器没有 systemd，跳过开机自启配置。"
    if [ "$MODE" = "push" ]; then
        warn "请手动运行：$BIN_PATH push --server $SERVER"
    else
        warn "请手动运行：$BIN_PATH serve --host 0.0.0.0"
    fi
else
    log "配置 systemd 开机自启"
    UNIT=/etc/systemd/system/nav-agent.service
    mkdir -p /etc/nav-agent

    # ⚠️ 凭据写 env 文件而不是 unit：unit 会被 systemctl cat 打印出来，
    # 也常被用户贴进 issue。env 文件权限 0600。
    # 值从 agent 刚写好的 config.json 里读出来，一次成型——
    # 不写占位符再替换。
    ENVFILE=/etc/nav-agent/env
    json_get() {
        sed -n "s/.*\"$1\":[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
            /etc/nav-agent/config.json 2>/dev/null | head -1
    }

    umask 077
    {
        echo "# Nav Sylph agent 凭据。此文件含凭据，不要贴进 issue。"
        echo "NAV_AGENT_SERVER=$SERVER"
        if [ "$MODE" = "push" ]; then
            # 推送模式：凭据是推送凭据 + 目标机器 id，没有 Bearer token。
            PUSH_SECRET_VALUE="$(json_get pushSecret)"
            SERVER_ID_VALUE="$(json_get serverId)"
            if [ -n "$PUSH_SECRET_VALUE" ]; then
                echo "NAV_AGENT_PUSH_SECRET=$PUSH_SECRET_VALUE"
            fi
            if [ -n "$SERVER_ID_VALUE" ]; then
                echo "NAV_AGENT_SERVER_ID=$SERVER_ID_VALUE"
            fi
        else
            TOKEN_VALUE="$(json_get token)"
            if [ -n "$TOKEN_VALUE" ]; then
                echo "NAV_AGENT_TOKEN=$TOKEN_VALUE"
            fi
        fi
    } > "$ENVFILE"
    chmod 600 "$ENVFILE"

    # ⚠️ 子命令必须按模式分。写死 serve 时，push 模式会因为缺 Bearer token
    # 而启动即退出——而下面只 warn 一句、脚本照样返回 0，于是用户在后台
    # 看到「已就绪」，实际那台机器上一个 agent 进程都没有。
    # （本轮代码审查发现；这是静默失败，比崩溃更坏。）
    if [ "$MODE" = "push" ]; then
        SUBCMD="push"
    else
        SUBCMD="serve"
    fi

    cat > "$UNIT" <<EOF
[Unit]
Description=Nav Sylph 监控 agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 凭据在 /etc/nav-agent/env（0600），不在这个 unit 里——
# unit 会被 systemctl cat / show / status 打印出来。
EnvironmentFile=-/etc/nav-agent/env
ExecStart=$BIN_PATH $SUBCMD
Restart=always
RestartSec=5
# 采集只需要读系统计数器，不需要别的权限
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable nav-agent >/dev/null 2>&1 || true
    if systemctl restart nav-agent; then
        # 起来了不等于能用：给它 2 秒，若已经退出就是配置不对。
        # 只看 restart 的返回值会漏掉「启动即退出」——
        # systemd 对那类情况照样返回 0。
        sleep 2
        if systemctl is-active --quiet nav-agent; then
            ok "已启动（$SUBCMD 模式，systemctl status nav-agent 查看）"
        else
            echo ""
            die "agent 启动后立刻退出。诊断：journalctl -u nav-agent -n 30 --no-pager
最常见的原因是凭据没写进 env 文件：
  sudo cat /etc/nav-agent/env
若上面缺 NAV_AGENT_TOKEN（拉取）或 NAV_AGENT_PUSH_SECRET（推送），
请回后台点「部署」重新生成令牌，再跑一次这条命令。"
        fi
    else
        die "systemd 启动失败。诊断：journalctl -u nav-agent -n 30 --no-pager"
    fi
fi

# ========== 自检 ==========

echo ""
log "自检"
"$BIN_PATH" health || warn "自检未完全通过，上面列出了具体项。"
echo ""

# 拉取模式下顺手确认端口真的在监听——「服务起来了」与「端口在听」是两件事。
if [ "$MODE" != "push" ]; then
    PORT="${PORT_ARG:-4195}"
    sleep 1
    if command -v ss >/dev/null 2>&1; then
        if ss -ltn 2>/dev/null | grep -q ":${PORT}"; then
            ok "端口 ${PORT} 正在监听"
        else
            warn "端口 ${PORT} 还没在监听。若上面自检是通过的，等一两秒再看；"
            warn "否则查 journalctl -u nav-agent"
        fi
    fi
fi

cat <<EOF

安装完成。

  日志     journalctl -u nav-agent -f
  自检     $BIN_PATH health
  停止     systemctl stop nav-agent
  卸载     systemctl disable --now nav-agent
           rm -f $BIN_PATH $UNIT /etc/nav-agent/env /etc/nav-agent/config.json

回到 Nav Sylph 后台点「刷新状态」，这台机器就会显示「已就绪」。
EOF
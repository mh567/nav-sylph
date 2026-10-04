#!/usr/bin/env bash
#
# 构建监控 agent 的各架构二进制。
#
# 产物进 agent/dist/，**不提交进 git**（是构建产物，且三个架构加起来十几 MB）。
# 发布时 scripts/release.sh 会调本脚本并把 linux-* 打进 tarball。
#
# 为什么需要多架构：agent 部署在 NAS、路由器、树莓派这类设备上，
# x86 之外的机器占实际用户的大多数——「零运行时依赖」的前提是
# 拷过去就能跑，所以每个常见架构都要有产物。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT="$ROOT/agent/dist"

command -v go >/dev/null 2>&1 || {
    echo "找不到 go。装 Go 1.22+ 后重试。" >&2
    exit 1
}

mkdir -p "$OUT"

# 发布包里的三个 Linux 架构。
# armv7 覆盖老树莓派与部分路由器——「轻量到能在 NAS 上跑」正是本项目的初衷，
# 而这些设备里 armv7 不少。
LINUX_ARCHES=(amd64 arm64 armv7)

# 软件版本从 version.json 读，编译期用 -ldflags -X 注入。
#
# ⚠️ 它与 agent 代码里的 `VERSION`（协议版本，恒为 1）是**两件事**：
# 协议版本决定服务端能不能解析指标载荷，软件版本决定「有没有新版本可升」。
# 混用会让「升级了 agent」变成「协议不一致」，而指标字段一个没变。
#
# 为什么不写死在 main.go 里：升级命令要回答「我手上这个是哪一版」，
# 而版本号是发布时决定的。写死就得改源码、编译、再记得同步 tag，
# 三处各自漂移——而这里一次读取就保证了产物与发布版本一致。
# 读不到就回落到 "dev"，让「从源码直接 go build 的产物」能被识别出来，
# 而不是伪装成某个正式版本。
AGENT_VERSION="dev"
if [ -f "$ROOT/version.json" ]; then
    AGENT_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' \
        "$ROOT/version.json" | head -1 | cut -d'"' -f4)
fi
if [ -z "$AGENT_VERSION" ]; then
    AGENT_VERSION="dev"
fi
LDFLAGS="-s -w -X main.buildVersion=$AGENT_VERSION"

build() {
    local goos="$1" goarch="$2" out="$3" goarm="${4:-}"
    printf '  %-16s %s/%s\n' "$out" "$goos" "$goarch"
    # CGO_ENABLED=0 保证是静态二进制——否则「拷过去就能跑」不成立。
    ( cd "$ROOT/agent" && \
      CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" GOARM="$goarm" \
      go build -trimpath -ldflags="$LDFLAGS" -o "$OUT/$out" . )
}

echo "构建 agent（$(go version)，版本 $AGENT_VERSION）"
for arch in "${LINUX_ARCHES[@]}"; do
    if [ "$arch" = "armv7" ]; then
        # ⚠️ armv7 的正确写法是 GOARCH=arm + GOARM=7，
        # **没有** GOARCH=armv7 这个值（写了会报 unsupported GOOS/GOARCH pair）。
        build linux arm "nav-agent-linux-armv7" 7
    else
        build linux "$arch" "nav-agent-linux-$arch"
    fi
done

# 本机自测用。**不进发布包**——darwin 产物只服务于开发机上的 e2e 验证。
HOST_OS="$(go env GOOS)"
HOST_ARCH="$(go env GOARCH)"
build "$HOST_OS" "$HOST_ARCH" "nav-agent-$HOST_OS-$HOST_ARCH"

echo ""
echo "产物："
ls -lh "$OUT" | awk 'NR>1 {printf "  %-34s %s\n", $9, $5}'

# 自检：至少确认产物真的是对应平台的可执行文件，而不是空文件或脚本。
fail=0
for arch in "${LINUX_ARCHES[@]}"; do
    f="$OUT/nav-agent-linux-$arch"
    if [ ! -s "$f" ]; then
        echo "  ✗ $arch 产物为空" >&2
        fail=1
        continue
    fi
    if ! file "$f" | grep -q "ELF"; then
        echo "  ✗ $arch 产物不是 ELF（交叉编译可能没生效）" >&2
        file "$f" >&2
        fail=1
    fi
done
[ "$fail" -eq 0 ] || exit 1

echo ""
echo "自检通过：三个 Linux 产物均为静态 ELF。"
echo "本机自测：$OUT/nav-agent-$HOST_OS-$HOST_ARCH version"
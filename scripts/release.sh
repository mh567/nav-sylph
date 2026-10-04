#!/bin/bash
#
# Nav Sylph 发布脚本
# 用于打包和发布新版本到 GitHub Release
#

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

# 获取脚本所在目录的父目录（项目根目录）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# 读取版本号
if [ ! -f "version.json" ]; then
    log_error "version.json 不存在"
    exit 1
fi

VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' version.json | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
    log_error "无法读取版本号"
    exit 1
fi

RELEASE_NAME="nav-sylph-v${VERSION}"
ARCHIVE_NAME="${RELEASE_NAME}.tar.gz"
DIST_DIR="dist"

echo ""
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${BLUE}       Nav Sylph 发布脚本               ${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""
log_info "版本: ${VERSION}"
echo ""

# 检查 gh 命令
if ! command -v gh &> /dev/null; then
    log_error "请先安装 GitHub CLI: https://cli.github.com/"
    exit 1
fi

# 检查是否已登录
if ! gh auth status &> /dev/null; then
    log_error "请先登录 GitHub CLI: gh auth login"
    exit 1
fi

# 检查是否有未提交的更改
if [ -n "$(git status --porcelain)" ]; then
    log_warn "存在未提交的更改"
    read -p "是否继续? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 检查该版本是否已发布
if gh release view "v${VERSION}" &> /dev/null; then
    log_warn "版本 v${VERSION} 已存在"
    read -p "是否删除并重新发布? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_step "删除旧版本..."
        gh release delete "v${VERSION}" --yes
        git tag -d "v${VERSION}" 2>/dev/null || true
        git push origin --delete "v${VERSION}" 2>/dev/null || true
    else
        exit 1
    fi
fi

# 创建临时目录
log_step "准备打包文件..."
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/${RELEASE_NAME}"

# 复制需要打包的文件（仅运行必需文件）
# 核心文件
cp server.js "$DIST_DIR/${RELEASE_NAME}/"
cp package.json "$DIST_DIR/${RELEASE_NAME}/"
cp package-lock.json "$DIST_DIR/${RELEASE_NAME}/"
cp sylph.sh "$DIST_DIR/${RELEASE_NAME}/"
cp version.json "$DIST_DIR/${RELEASE_NAME}/"
cp CHANGELOG.json "$DIST_DIR/${RELEASE_NAME}/"

# 配置示例
cp .env.example "$DIST_DIR/${RELEASE_NAME}/"
cp server-config.example.json "$DIST_DIR/${RELEASE_NAME}/"
cp nav-sylph.service "$DIST_DIR/${RELEASE_NAME}/"

# 文档（仅 README）
cp README.md "$DIST_DIR/${RELEASE_NAME}/"

# 目录
cp -r public "$DIST_DIR/${RELEASE_NAME}/"
# server-config/ 只复制代码模块：该目录下可能残留本机的 server-config/config.json
# （被 .gitignore 忽略，但 `cp -r` 不感知），打进发布包会夹带开发者的本地配置。
mkdir -p "$DIST_DIR/${RELEASE_NAME}/server-config"
cp server-config/*.js "$DIST_DIR/${RELEASE_NAME}/server-config/"
cp -r lib "$DIST_DIR/${RELEASE_NAME}/"

# agent/ 要随包分发：用户需要在目标机上部署它才能监控多台服务器。
# 不打进去的话，多服务器功能对下载者等于不存在。
#
# ⚠️ 里面必须有**已构建的二进制**：一键部署命令是
#    `curl … /agent/install.sh | bash`，脚本再去 curl 对应架构的二进制。
# 少了 dist/，用户照着命令执行会拿到一段「本安装未构建 agent 二进制」的注释，
# 而错误信息在目标机上，不在后台——很难排查。所以先构建，打包前就知道有没有构建成功。
log_step "构建 agent 二进制..."
if command -v go >/dev/null 2>&1; then
    bash "$SCRIPT_DIR/build-agent.sh" || {
        log_error "agent 构建失败。请先安装 Go 1.22+ 再发布。"
        exit 1
    }
else
    log_error "找不到 go，无法构建 agent 二进制。"
    log_error "一键部署依赖它。请安装 Go 1.22+ 后重试（或临时发布不含 agent 的版本，"
    log_error "但那样多服务器监控对下载者等于不存在）。"
    exit 1
fi
cp -r agent "$DIST_DIR/${RELEASE_NAME}/"

# ⚠️ 删掉本机（darwin）产物。用户部署 agent 到的是 Linux 机器，
# build-agent.sh 顺带编译的那份 darwin 二进制是给开发机自测用的，
# 6～7 MB 白占下载体积。
#
# 这里以前**只写在 build-agent.sh 的注释里**（「不进发布包」），
# 而 `cp -r agent` 不感知 .gitignore、也不看注释——实测 v1.6.5 与 v1.6.6
# 的发布包里都躺着 nav-agent-darwin-arm64。
#
# 判据用「不是 linux- 开头」而不是匹配 darwin：将来加 windows 版时
# 同样不该进这个面向 Linux 的包。
find "$DIST_DIR/${RELEASE_NAME}/agent/dist" -maxdepth 1 -type f \
    ! -name 'nav-agent-linux-*' -print -delete 2>/dev/null || true

# ⚠️ 二进制只进 tarball，不进 git：三个架构加起来十几 MB，且是构建产物。
# 这一步之后要确认 dist/ 里确实有东西，否则上面那句「构建失败」会被无声跳过。
for arch in amd64 arm64 armv7; do
    if [ ! -s "agent/dist/nav-agent-linux-${arch}" ]; then
        log_error "agent 二进制缺失：nav-agent-linux-${arch}"
        exit 1
    fi
done

# 创建空目录
mkdir -p "$DIST_DIR/${RELEASE_NAME}/logs"
touch "$DIST_DIR/${RELEASE_NAME}/logs/.gitkeep"

log_info "打包内容:"
ls -la "$DIST_DIR/${RELEASE_NAME}/"

# 打包
log_step "创建压缩包..."
cd "$DIST_DIR"

# 清除 macOS 扩展属性（避免 Linux 解压警告）
if command -v xattr &> /dev/null; then
    xattr -cr "${RELEASE_NAME}" 2>/dev/null || true
fi

# 使用 ustar 格式避免 macOS 扩展属性（pax 格式会包含 xattr）
COPYFILE_DISABLE=1 tar --format ustar -czvf "$ARCHIVE_NAME" "${RELEASE_NAME}"
cd "$PROJECT_DIR"

ARCHIVE_PATH="$DIST_DIR/$ARCHIVE_NAME"
ARCHIVE_SIZE=$(ls -lh "$ARCHIVE_PATH" | awk '{print $5}')
log_info "压缩包: $ARCHIVE_PATH ($ARCHIVE_SIZE)"

# 生成发布说明
log_step "生成发布说明..."

# 从 CHANGELOG.json 提取最新版本的信息
RELEASE_NOTES=$(cat <<EOF
## Nav Sylph v${VERSION}

### 安装方式

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/sylph.sh | bash
\`\`\`

### 更新亮点

EOF
)

# 提取最新版本的 highlights（遇到第一个 ] 就停止）
HIGHLIGHTS=$(awk '
    /"highlights"/ { in_highlights=1; next }
    in_highlights && /\]/ { exit }
    in_highlights && /"[^"]+/ {
        gsub(/^[[:space:]]*"/, ""); gsub(/"[,]?[[:space:]]*$/, "");
        if (length($0) > 0) print "- " $0
    }
' CHANGELOG.json)

RELEASE_NOTES="${RELEASE_NOTES}"$'\n\n'"${HIGHLIGHTS}

### 下载

- \`${ARCHIVE_NAME}\` - 完整安装包

### 更新方式

已安装用户可运行:
\`\`\`bash
./sylph.sh update
\`\`\`
"

echo "$RELEASE_NOTES"

# 创建 Git Tag
log_step "创建 Git Tag..."
if git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
    # tag 已存在（补发历史版本，或上次跑到一半中断）时不要直接失败，
    # 但必须确认它指向当前 HEAD，否则 Release 会挂到错误的提交上。
    # 注意：这是顶层脚本而非函数，不能用 local（set -e 下会直接退出）。
    tag_commit=$(git rev-list -n 1 "v${VERSION}")
    head_commit=$(git rev-parse HEAD)
    if [ "$tag_commit" != "$head_commit" ]; then
        log_error "tag v${VERSION} 已存在但指向 ${tag_commit:0:7}，与当前 HEAD ${head_commit:0:7} 不一致"
        log_error "请先删除该 tag（git tag -d v${VERSION}）或确认版本号是否正确"
        exit 1
    fi
    log_warn "tag v${VERSION} 已存在且指向当前提交，跳过创建"
else
    git tag -a "v${VERSION}" -m "Release v${VERSION}"
fi
git push origin "v${VERSION}" 2>/dev/null || log_warn "tag v${VERSION} 推送失败（可能已存在），继续"

# 提醒推送分支。本脚本只推 tag，不推分支——曾因此让 develop 停在旧提交上分叉。
# 分支策略见 AGENTS.md 第 8 条：只用 main，开发直接提交在 main 上。
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
log_info "当前分支: ${CURRENT_BRANCH}（本脚本只推 tag，分支需自行 git push）"
if [ "${CURRENT_BRANCH}" != "main" ]; then
    log_warn "不在 main 上发布。仓库约定只用 main（见 AGENTS.md 第 8 条）。"
fi

# 发布到 GitHub Release
log_step "发布到 GitHub Release..."
if gh release view "v${VERSION}" >/dev/null 2>&1; then
    log_error "Release v${VERSION} 已存在，请先删除：gh release delete v${VERSION}"
    exit 1
fi
gh release create "v${VERSION}" \
    --title "Nav Sylph v${VERSION}" \
    --notes "$RELEASE_NOTES" \
    "$ARCHIVE_PATH"

# 清理
log_step "清理临时文件..."
rm -rf "$DIST_DIR"

echo ""
log_info "发布完成!"
echo ""
echo "  Release URL: https://github.com/mh567/nav-sylph/releases/tag/v${VERSION}"
echo "  下载地址:    https://github.com/mh567/nav-sylph/releases/download/v${VERSION}/${ARCHIVE_NAME}"
echo ""

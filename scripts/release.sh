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

# 复制需要打包的文件（排除开发/用户相关文件）
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

# 文档
cp README.md "$DIST_DIR/${RELEASE_NAME}/"
cp DEPLOYMENT.md "$DIST_DIR/${RELEASE_NAME}/"

# 目录
cp -r public "$DIST_DIR/${RELEASE_NAME}/"
cp -r server-config "$DIST_DIR/${RELEASE_NAME}/"
mkdir -p "$DIST_DIR/${RELEASE_NAME}/docs"
cp docs/preview.png "$DIST_DIR/${RELEASE_NAME}/docs/" 2>/dev/null || true

# 创建空目录
mkdir -p "$DIST_DIR/${RELEASE_NAME}/logs"
touch "$DIST_DIR/${RELEASE_NAME}/logs/.gitkeep"

log_info "打包内容:"
ls -la "$DIST_DIR/${RELEASE_NAME}/"

# 打包
log_step "创建压缩包..."
cd "$DIST_DIR"
# 使用 --no-xattrs 和 --no-mac-metadata 排除 macOS 扩展属性（兼容 Linux）
if tar --help 2>&1 | grep -q 'no-xattrs'; then
    tar --no-xattrs -czvf "$ARCHIVE_NAME" "${RELEASE_NAME}"
elif tar --help 2>&1 | grep -q 'no-mac-metadata'; then
    tar --no-mac-metadata -czvf "$ARCHIVE_NAME" "${RELEASE_NAME}"
else
    # 使用 COPYFILE_DISABLE 环境变量（macOS 特有）
    COPYFILE_DISABLE=1 tar -czvf "$ARCHIVE_NAME" "${RELEASE_NAME}"
fi
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

RELEASE_NOTES="${RELEASE_NOTES}${HIGHLIGHTS}

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
git tag -a "v${VERSION}" -m "Release v${VERSION}"
git push origin "v${VERSION}"

# 发布到 GitHub
log_step "发布到 GitHub Release..."
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

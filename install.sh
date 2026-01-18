#!/bin/bash
#
# Nav Sylph 一键部署脚本
# 支持: Linux / macOS / Windows (Git Bash/WSL)
# 用法: curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/install.sh | bash
#

set -e

# ===== 配置 =====
REPO_URL="https://github.com/mh567/nav-sylph.git"
INSTALL_DIR="${NAV_SYLPH_DIR:-$HOME/nav-sylph}"
BRANCH="${NAV_SYLPH_BRANCH:-main}"

# ===== 颜色定义 =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ===== 辅助函数 =====
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

print_banner() {
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                                                           ║"
    echo "║              Nav Sylph - 个人导航页                       ║"
    echo "║                  一键部署脚本                              ║"
    echo "║                                                           ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# 检测操作系统
detect_os() {
    case "$(uname -s)" in
        Linux*)     OS="linux";;
        Darwin*)    OS="macos";;
        CYGWIN*|MINGW*|MSYS*) OS="windows";;
        *)          OS="unknown";;
    esac
    echo "$OS"
}

# 检查命令是否存在
check_command() {
    command -v "$1" > /dev/null 2>&1
}

# 检查依赖
check_dependencies() {
    log_step "检查依赖..."

    local missing=()

    if ! check_command git; then
        missing+=("git")
    fi

    if ! check_command node; then
        missing+=("node")
    fi

    if ! check_command npm; then
        missing+=("npm")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "缺少以下依赖: ${missing[*]}"
        echo ""
        echo "请先安装缺少的依赖:"

        local os=$(detect_os)
        case "$os" in
            linux)
                echo "  Ubuntu/Debian: sudo apt update && sudo apt install -y git nodejs npm"
                echo "  CentOS/RHEL:   sudo yum install -y git nodejs npm"
                echo "  Arch:          sudo pacman -S git nodejs npm"
                ;;
            macos)
                echo "  Homebrew: brew install git node"
                ;;
            windows)
                echo "  下载 Node.js: https://nodejs.org/"
                echo "  下载 Git: https://git-scm.com/"
                ;;
        esac
        echo ""
        exit 1
    fi

    log_info "Git: $(git --version | cut -d' ' -f3)"
    log_info "Node.js: $(node --version)"
    log_info "npm: $(npm --version)"
}

# 安装 Nav Sylph
do_install() {
    print_banner

    local os=$(detect_os)
    log_info "检测到操作系统: $os"
    echo ""

    check_dependencies
    echo ""

    # 检查是否已安装
    if [ -d "$INSTALL_DIR" ]; then
        log_warn "目录已存在: $INSTALL_DIR"
        read -p "是否删除并重新安装? [y/N] " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            # 先停止服务
            if [ -f "$INSTALL_DIR/manage.sh" ]; then
                cd "$INSTALL_DIR"
                ./manage.sh stop 2>/dev/null || true
            fi
            rm -rf "$INSTALL_DIR"
        else
            log_info "取消安装"
            exit 0
        fi
    fi

    # 克隆仓库
    log_step "克隆仓库..."
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    log_info "已克隆到: $INSTALL_DIR"
    echo ""

    # 运行安装
    log_step "安装依赖..."
    chmod +x manage.sh
    ./manage.sh install
    echo ""

    # 显示完成信息
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}                    安装完成!                              ${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  安装目录: $INSTALL_DIR"
    echo ""
    echo -e "  ${YELLOW}默认管理密码: admin123${NC}"
    echo -e "  ${YELLOW}请登录后立即修改密码!${NC}"
    echo ""
    echo "  启动命令:"
    echo "    cd $INSTALL_DIR"
    echo "    ./manage.sh start"
    echo ""

    if [ "$os" = "linux" ]; then
        echo "  服务器部署 (开机自启):"
        echo "    sudo ./manage.sh enable"
        echo ""
    fi

    echo "  管理命令:"
    echo "    ./manage.sh status   # 查看状态"
    echo "    ./manage.sh stop     # 停止服务"
    echo "    ./manage.sh logs     # 查看日志"
    echo ""

    # 询问是否立即启动
    read -p "是否立即启动服务? [Y/n] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        ./manage.sh start
    fi
}

# 卸载 Nav Sylph
do_uninstall() {
    print_banner

    if [ ! -d "$INSTALL_DIR" ]; then
        log_error "未找到安装目录: $INSTALL_DIR"
        exit 1
    fi

    echo -e "${YELLOW}警告: 这将删除 Nav Sylph 及所有数据!${NC}"
    read -p "确定要卸载吗? [y/N] " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "取消卸载"
        exit 0
    fi

    cd "$INSTALL_DIR"

    # 停止服务
    log_step "停止服务..."
    ./manage.sh stop 2>/dev/null || true

    # 移除 systemd 服务 (如果存在)
    if [ -f "/etc/systemd/system/nav-sylph.service" ]; then
        log_step "移除 systemd 服务..."
        sudo ./manage.sh disable 2>/dev/null || true
    fi

    # 删除目录
    log_step "删除文件..."
    cd ~
    rm -rf "$INSTALL_DIR"

    echo ""
    log_info "卸载完成!"
}

# 更新 Nav Sylph
do_update() {
    print_banner

    if [ ! -d "$INSTALL_DIR" ]; then
        log_error "未找到安装目录: $INSTALL_DIR"
        log_info "请先运行安装: $0 install"
        exit 1
    fi

    cd "$INSTALL_DIR"

    # 停止服务
    log_step "停止服务..."
    ./manage.sh stop 2>/dev/null || true

    # 备份配置
    log_step "备份配置..."
    local backup_dir="/tmp/nav-sylph-backup-$(date +%s)"
    mkdir -p "$backup_dir"
    [ -f "config.json" ] && cp config.json "$backup_dir/"
    [ -f ".admin-password.json" ] && cp .admin-password.json "$backup_dir/"
    [ -f ".env" ] && cp .env "$backup_dir/"
    [ -f "server-config.json" ] && cp server-config.json "$backup_dir/"

    # 更新代码
    log_step "拉取最新代码..."
    git fetch origin "$BRANCH"
    git reset --hard "origin/$BRANCH"

    # 恢复配置
    log_step "恢复配置..."
    [ -f "$backup_dir/config.json" ] && cp "$backup_dir/config.json" .
    [ -f "$backup_dir/.admin-password.json" ] && cp "$backup_dir/.admin-password.json" .
    [ -f "$backup_dir/.env" ] && cp "$backup_dir/.env" .
    [ -f "$backup_dir/server-config.json" ] && cp "$backup_dir/server-config.json" .
    rm -rf "$backup_dir"

    # 更新依赖
    log_step "更新依赖..."
    npm install --production

    # 启动服务
    log_step "启动服务..."
    ./manage.sh start

    echo ""
    log_info "更新完成!"
}

# 显示帮助
show_help() {
    print_banner
    echo "用法: $0 [命令]"
    echo ""
    echo "命令:"
    echo "  install     安装 Nav Sylph (默认)"
    echo "  uninstall   卸载 Nav Sylph"
    echo "  update      更新到最新版本"
    echo "  help        显示此帮助"
    echo ""
    echo "环境变量:"
    echo "  NAV_SYLPH_DIR     安装目录 (默认: ~/nav-sylph)"
    echo "  NAV_SYLPH_BRANCH  Git 分支 (默认: main)"
    echo ""
    echo "示例:"
    echo "  # 一键安装"
    echo "  curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/install.sh | bash"
    echo ""
    echo "  # 指定安装目录"
    echo "  NAV_SYLPH_DIR=/opt/nav-sylph ./install.sh install"
    echo ""
    echo "  # 卸载"
    echo "  ./install.sh uninstall"
    echo ""
}

# ===== 主入口 =====
main() {
    case "${1:-install}" in
        install)
            do_install
            ;;
        uninstall|remove)
            do_uninstall
            ;;
        update|upgrade)
            do_update
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "未知命令: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"

#!/bin/bash
#
# Nav Sylph 统一管理脚本
# 支持: Linux / macOS / Windows (Git Bash, WSL)
#
# 远程安装: curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/sylph.sh | bash
# 本地使用: ./sylph.sh [command]
#

set -e

# ===== 配置 =====
APP_NAME="nav-sylph"
REPO_URL="https://github.com/mh567/nav-sylph.git"
BRANCH="${NAV_SYLPH_BRANCH:-main}"

# 检测脚本运行模式（远程安装 or 本地管理）
if [ -f "$(dirname "$0")/server.js" ] 2>/dev/null; then
    # 本地模式：脚本在项目目录中
    APP_DIR="$(cd "$(dirname "$0")" && pwd)"
    MODE="local"
else
    # 远程模式：通过 curl 执行
    APP_DIR="${NAV_SYLPH_DIR:-$HOME/nav-sylph}"
    MODE="remote"
fi

PID_FILE="${APP_DIR}/.nav-sylph.pid"
LOG_DIR="${APP_DIR}/logs"
LOG_FILE="${LOG_DIR}/server.log"
NODE_BIN="${NODE_BIN:-node}"
SYSTEMD_DIR="/etc/systemd/system"

# ===== 颜色定义 =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ===== 辅助函数 =====
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1"; }

print_banner() {
    echo -e "${CYAN}"
    echo "╔════════════════════════════════════════╗"
    echo "║         Nav Sylph 管理脚本             ║"
    echo "╚════════════════════════════════════════╝"
    echo -e "${NC}"
}

# 检测操作系统
detect_os() {
    case "$(uname -s)" in
        Linux*)
            if grep -q Microsoft /proc/version 2>/dev/null; then
                echo "wsl"
            else
                echo "linux"
            fi
            ;;
        Darwin*) echo "macos";;
        CYGWIN*|MINGW*|MSYS*) echo "windows";;
        *)       echo "unknown";;
    esac
}

OS=$(detect_os)

# 检查是否支持 systemd
has_systemd() {
    [ "$OS" = "linux" ] && command -v systemctl > /dev/null 2>&1 && systemctl --version > /dev/null 2>&1
}

# 检查命令是否存在
check_command() {
    command -v "$1" > /dev/null 2>&1
}

# 检查 root 权限
check_root() {
    if [ "$(id -u)" != "0" ]; then
        log_error "此命令需要 root 权限，请使用: sudo $0 $1"
        exit 1
    fi
}

# 加载环境变量
load_env() {
    if [ -f "${APP_DIR}/.env" ]; then
        set -a
        source "${APP_DIR}/.env"
        set +a
    fi
}

# 获取配置
get_config() {
    load_env
    PORT="${SERVER_PORT:-4000}"
    HOST="${SERVER_HOST:-127.0.0.1}"
}

# 检查服务是否运行
is_running() {
    if [ -f "${PID_FILE}" ]; then
        local pid=$(cat "${PID_FILE}")
        if ps -p ${pid} > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

# 检查端口占用
check_port() {
    local port=$1
    if check_command lsof; then
        lsof -i:${port} > /dev/null 2>&1
        return $?
    elif check_command ss; then
        ss -tuln | grep -q ":${port} "
        return $?
    elif check_command netstat; then
        netstat -tuln 2>/dev/null | grep -q ":${port} "
        return $?
    fi
    return 1
}

# 检查依赖
check_dependencies() {
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
        log_error "缺少依赖: ${missing[*]}"
        echo ""
        echo "请先安装:"
        case "$OS" in
            linux|wsl)
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
        exit 1
    fi
}

# ===== 核心命令 =====

# 安装
do_install() {
    print_banner
    log_info "操作系统: $OS"
    echo ""

    check_dependencies
    log_info "Git: $(git --version | cut -d' ' -f3)"
    log_info "Node.js: $(node --version)"
    echo ""

    # 远程模式：需要克隆仓库
    if [ "$MODE" = "remote" ]; then
        if [ -d "$APP_DIR" ]; then
            log_warn "目录已存在: $APP_DIR"
            read -p "是否删除并重新安装? [y/N] " -n 1 -r
            echo ""
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                if [ -f "$APP_DIR/sylph.sh" ]; then
                    cd "$APP_DIR" && ./sylph.sh stop 2>/dev/null || true
                fi
                rm -rf "$APP_DIR"
            else
                log_info "取消安装"
                exit 0
            fi
        fi

        log_step "克隆仓库..."
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
        cd "$APP_DIR"
        log_info "已克隆到: $APP_DIR"
    else
        cd "$APP_DIR"
    fi

    # 创建目录
    log_step "创建目录..."
    mkdir -p "${LOG_DIR}"

    # 安装依赖
    log_step "安装依赖..."
    npm install --production 2>&1 | tail -5
    log_info "依赖安装完成"

    # 创建 .env
    if [ ! -f "${APP_DIR}/.env" ] && [ -f "${APP_DIR}/.env.example" ]; then
        log_step "创建配置文件..."
        cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
        log_info "已创建 .env (可按需编辑)"
    fi

    # 设置文件权限
    chmod +x "${APP_DIR}/sylph.sh" 2>/dev/null || true
    [ -f "${APP_DIR}/.admin-password.json" ] && chmod 600 "${APP_DIR}/.admin-password.json"
    [ -f "${APP_DIR}/.env" ] && chmod 600 "${APP_DIR}/.env"

    # 远程安装模式：创建标记文件，用于区分开发目录
    if [ "$MODE" = "remote" ]; then
        echo "installed=$(date -Iseconds)" > "${APP_DIR}/.installed-by-script"
    fi

    # 完成提示
    echo ""
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}            安装完成!                   ${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    echo "  安装目录: $APP_DIR"
    echo ""
    echo -e "  ${YELLOW}默认管理密码: admin123${NC}"
    echo -e "  ${YELLOW}请登录后立即修改密码!${NC}"
    echo ""
    echo "  常用命令:"
    echo "    ./sylph.sh start    # 启动服务"
    echo "    ./sylph.sh stop     # 停止服务"
    echo "    ./sylph.sh status   # 查看状态"
    echo ""

    # 平台特定提示
    if has_systemd; then
        echo "  开机自启 (仅 Linux):"
        echo "    sudo ./sylph.sh enable"
        echo ""
    elif [ "$OS" = "macos" ]; then
        echo -e "  ${BLUE}提示: macOS 可使用 launchd 实现开机自启${NC}"
        echo "    参考: https://support.apple.com/guide/terminal/apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac"
        echo ""
    elif [ "$OS" = "windows" ] || [ "$OS" = "wsl" ]; then
        echo -e "  ${BLUE}提示: Windows 可使用任务计划程序实现开机自启${NC}"
        echo ""
    fi

    # 询问是否启动
    read -p "是否立即启动服务? [Y/n] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        do_start
    fi
}

# 启动服务
do_start() {
    get_config

    if is_running; then
        log_warn "服务已在运行 (PID: $(cat ${PID_FILE}))"
        return 0
    fi

    if check_port $PORT; then
        log_error "端口 ${PORT} 已被占用"
        if check_command lsof; then
            lsof -i:${PORT} | head -3
        fi
        exit 1
    fi

    mkdir -p "${LOG_DIR}"

    log_step "启动服务..."
    cd "${APP_DIR}"
    nohup ${NODE_BIN} server.js >> "${LOG_FILE}" 2>&1 &
    echo $! > "${PID_FILE}"

    sleep 2

    if is_running; then
        echo ""
        log_info "服务启动成功"
        echo ""
        echo "  PID:  $(cat ${PID_FILE})"
        echo "  URL:  http://${HOST}:${PORT}"
        echo "  日志: ${LOG_FILE}"
        echo ""
    else
        log_error "启动失败，请查看日志: tail -50 ${LOG_FILE}"
        exit 1
    fi
}

# 停止服务
do_stop() {
    if ! is_running; then
        log_warn "服务未运行"
        [ -f "${PID_FILE}" ] && rm -f "${PID_FILE}"
        return 0
    fi

    local pid=$(cat "${PID_FILE}")
    log_step "停止服务 (PID: ${pid})..."

    kill -TERM ${pid} 2>/dev/null || true

    local count=0
    while is_running && [ ${count} -lt 10 ]; do
        sleep 1
        count=$((count + 1))
        echo -n "."
    done
    echo ""

    if is_running; then
        log_warn "强制终止..."
        kill -KILL ${pid} 2>/dev/null || true
        sleep 1
    fi

    rm -f "${PID_FILE}"
    log_info "服务已停止"
}

# 重启服务
do_restart() {
    do_stop
    sleep 1
    do_start
}

# 查看状态
do_status() {
    get_config

    echo ""
    echo -e "${BLUE}════════════════════════════════════════${NC}"
    echo -e "${BLUE}       Nav Sylph 服务状态               ${NC}"
    echo -e "${BLUE}════════════════════════════════════════${NC}"
    echo ""

    # 检查 systemd 服务
    if has_systemd && systemctl is-active --quiet ${APP_NAME} 2>/dev/null; then
        echo -e "  运行模式: ${GREEN}systemd${NC}"
        echo -e "  状态:     ${GREEN}运行中${NC}"
        echo ""
        systemctl status ${APP_NAME} --no-pager -l 2>/dev/null | head -10
    elif is_running; then
        local pid=$(cat "${PID_FILE}")
        echo -e "  运行模式: 手动"
        echo -e "  状态:     ${GREEN}运行中${NC}"
        echo "  PID:      ${pid}"
        echo "  地址:     http://${HOST}:${PORT}"
        echo ""

        # 健康检查
        if check_command curl; then
            local http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://${HOST}:${PORT}/api/health" 2>/dev/null || echo "000")
            if [ "${http_code}" = "200" ]; then
                echo -e "  健康检查: ${GREEN}正常${NC}"
            else
                echo -e "  健康检查: ${YELLOW}异常${NC} (HTTP ${http_code})"
            fi
        fi
        echo ""

        # 进程信息
        echo "  进程信息:"
        ps -p ${pid} -o pid,ppid,%cpu,%mem,etime 2>/dev/null | head -2
    else
        echo -e "  状态: ${RED}未运行${NC}"
        if [ -f "${PID_FILE}" ]; then
            echo -e "  ${YELLOW}警告: 存在残留 PID 文件${NC}"
        fi
    fi
    echo ""
}

# 查看日志
do_logs() {
    if [ ! -f "${LOG_FILE}" ]; then
        log_error "日志文件不存在: ${LOG_FILE}"
        exit 1
    fi

    echo "显示日志 (Ctrl+C 退出)..."
    echo ""
    tail -f "${LOG_FILE}"
}

# 更新
do_update() {
    if [ ! -d "$APP_DIR" ] || [ ! -f "$APP_DIR/server.js" ]; then
        log_error "未找到安装目录: $APP_DIR"
        log_info "请先运行: ./sylph.sh install"
        exit 1
    fi

    print_banner
    cd "$APP_DIR"

    # 停止服务
    log_step "停止服务..."
    do_stop 2>/dev/null || true

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

    # 设置权限
    chmod +x sylph.sh

    # 启动服务
    log_step "启动服务..."
    do_start

    echo ""
    log_info "更新完成!"
}

# 卸载
do_uninstall() {
    print_banner

    if [ ! -d "$APP_DIR" ]; then
        log_error "未找到安装目录: $APP_DIR"
        exit 1
    fi

    cd "$APP_DIR"

    # 检测是否为脚本安装的目录
    if [ ! -f ".installed-by-script" ]; then
        log_warn "检测到这不是通过一键脚本安装的目录"
        echo ""
        echo "为防止误删开发代码或手动部署的项目，uninstall 命令已阻止。"
        echo ""
        echo "如果只是想停止服务:"
        echo "  ./sylph.sh stop"
        echo ""
        echo "如果确实要删除，请手动执行:"
        echo "  rm -rf $APP_DIR"
        echo ""
        exit 1
    fi

    echo -e "${YELLOW}警告: 这将删除 Nav Sylph 及所有数据!${NC}"
    read -p "确定要卸载吗? [y/N] " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "取消卸载"
        exit 0
    fi

    # 停止服务
    log_step "停止服务..."
    do_stop 2>/dev/null || true

    # 移除 systemd 服务
    if has_systemd && [ -f "${SYSTEMD_DIR}/${APP_NAME}.service" ]; then
        log_step "移除 systemd 服务..."
        sudo systemctl stop ${APP_NAME} 2>/dev/null || true
        sudo systemctl disable ${APP_NAME} 2>/dev/null || true
        sudo rm -f "${SYSTEMD_DIR}/${APP_NAME}.service"
        sudo systemctl daemon-reload
    fi

    # 删除目录
    log_step "删除文件..."
    cd ~
    rm -rf "$APP_DIR"

    echo ""
    log_info "卸载完成!"
}

# 启用 systemd 服务
do_enable() {
    if ! has_systemd; then
        log_error "当前系统不支持 systemd"
        echo ""
        case "$OS" in
            macos)
                echo "macOS 请使用 launchd 实现开机自启:"
                echo "  1. 创建 plist 文件: ~/Library/LaunchAgents/com.nav-sylph.plist"
                echo "  2. 加载服务: launchctl load ~/Library/LaunchAgents/com.nav-sylph.plist"
                echo ""
                echo "或使用 Homebrew services (如果通过 Homebrew 安装):"
                echo "  brew services start nav-sylph"
                ;;
            windows|wsl)
                echo "Windows 请使用任务计划程序:"
                echo "  1. 打开「任务计划程序」"
                echo "  2. 创建基本任务 → 触发器选择「计算机启动时」"
                echo "  3. 操作选择「启动程序」→ 选择 node.exe"
                echo "  4. 添加参数: ${APP_DIR}/server.js"
                ;;
        esac
        echo ""
        exit 1
    fi

    check_root "enable"

    log_step "安装 systemd 服务..."

    local run_user="${SUDO_USER:-root}"
    local node_path=$(which node)

    # 生成 service 文件
    cat > "${SYSTEMD_DIR}/${APP_NAME}.service" << EOF
[Unit]
Description=Nav Sylph - Personal Navigation Page
After=network.target

[Service]
Type=simple
User=${run_user}
Group=${run_user}
WorkingDirectory=${APP_DIR}

ExecStart=${node_path} server.js
ExecReload=/bin/kill -HUP \$MAINPID

Restart=on-failure
RestartSec=5
StartLimitInterval=60
StartLimitBurst=3

Environment=NODE_ENV=production
EnvironmentFile=-${APP_DIR}/.env

StandardOutput=append:${LOG_DIR}/server.log
StandardError=append:${LOG_DIR}/server.log

[Install]
WantedBy=multi-user.target
EOF

    # 停止手动进程
    if is_running; then
        log_step "停止手动运行的服务..."
        do_stop
    fi

    # 启用服务
    log_step "启用并启动服务..."
    systemctl daemon-reload
    systemctl enable ${APP_NAME}
    systemctl start ${APP_NAME}

    sleep 2

    if systemctl is-active --quiet ${APP_NAME}; then
        get_config
        echo ""
        log_info "systemd 服务安装成功!"
        echo ""
        echo "  服务名称: ${APP_NAME}"
        echo "  状态:     运行中"
        echo "  开机自启: 已启用"
        echo "  访问地址: http://${HOST}:${PORT}"
        echo ""
        echo "  管理命令:"
        echo "    sudo systemctl status ${APP_NAME}"
        echo "    sudo systemctl restart ${APP_NAME}"
        echo "    sudo ./sylph.sh disable  # 卸载服务"
        echo ""
    else
        log_error "服务启动失败"
        systemctl status ${APP_NAME} --no-pager
        exit 1
    fi
}

# 禁用 systemd 服务
do_disable() {
    if ! has_systemd; then
        log_error "当前系统不支持 systemd"
        exit 1
    fi

    check_root "disable"

    log_step "移除 systemd 服务..."

    systemctl stop ${APP_NAME} 2>/dev/null || true
    systemctl disable ${APP_NAME} 2>/dev/null || true

    if [ -f "${SYSTEMD_DIR}/${APP_NAME}.service" ]; then
        rm -f "${SYSTEMD_DIR}/${APP_NAME}.service"
        systemctl daemon-reload
    fi

    log_info "systemd 服务已移除"
    echo ""
    echo "可以继续使用手动模式:"
    echo "  ./sylph.sh start"
    echo ""
}

# 显示帮助
show_help() {
    print_banner
    echo "用法: $0 <命令>"
    echo ""
    echo "安装与部署:"
    echo "  install     安装 Nav Sylph (远程安装时自动克隆仓库)"
    echo "  update      更新到最新版本 (保留配置)"
    echo "  uninstall   完全卸载"
    echo ""
    echo "服务管理:"
    echo "  start       启动服务"
    echo "  stop        停止服务"
    echo "  restart     重启服务"
    echo "  status      查看运行状态"
    echo "  logs        查看实时日志"
    echo ""
    if has_systemd; then
        echo "开机自启 (需要 sudo):"
        echo "  enable      安装为 systemd 服务"
        echo "  disable     移除 systemd 服务"
        echo ""
    fi
    echo "环境变量:"
    echo "  NAV_SYLPH_DIR     安装目录 (默认: ~/nav-sylph)"
    echo "  NAV_SYLPH_BRANCH  Git 分支 (默认: main)"
    echo ""
    echo "示例:"
    echo "  # 一键安装"
    echo "  curl -fsSL https://raw.githubusercontent.com/mh567/nav-sylph/main/sylph.sh | bash"
    echo ""
    echo "  # 指定目录安装"
    echo "  NAV_SYLPH_DIR=/opt/nav-sylph ./sylph.sh install"
    echo ""
}

# ===== 主入口 =====
main() {
    # 远程模式默认执行 install
    if [ "$MODE" = "remote" ] && [ -z "$1" ]; then
        do_install
        exit 0
    fi

    case "${1:-}" in
        install)    do_install ;;
        start)      do_start ;;
        stop)       do_stop ;;
        restart)    do_restart ;;
        status)     do_status ;;
        logs)       do_logs ;;
        update)     do_update ;;
        uninstall)  do_uninstall ;;
        enable)     do_enable ;;
        disable)    do_disable ;;
        help|--help|-h) show_help ;;
        *)
            if [ -n "$1" ]; then
                log_error "未知命令: $1"
            fi
            show_help
            exit 1
            ;;
    esac
}

main "$@"

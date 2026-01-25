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
REPO_OWNER="mh567"
REPO_NAME="nav-sylph"
GITHUB_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}"
GITHUB_RELEASES="${GITHUB_API}/releases"
RAW_URL="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main"

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

# 检查依赖（不再需要 git）
check_dependencies() {
    local missing=()

    if ! check_command curl && ! check_command wget; then
        missing+=("curl 或 wget")
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
                echo "  Ubuntu/Debian: sudo apt update && sudo apt install -y curl nodejs npm"
                echo "  CentOS/RHEL:   sudo yum install -y curl nodejs npm"
                echo "  Arch:          sudo pacman -S curl nodejs npm"
                ;;
            macos)
                echo "  Homebrew: brew install node"
                ;;
            windows)
                echo "  下载 Node.js: https://nodejs.org/"
                ;;
        esac
        exit 1
    fi
}

# 获取最新版本信息
get_latest_release() {
    local api_url="${GITHUB_RELEASES}/latest"
    local response=""

    if check_command curl; then
        response=$(curl -sL "$api_url" 2>/dev/null)
    elif check_command wget; then
        response=$(wget -qO- "$api_url" 2>/dev/null)
    fi

    if [ -z "$response" ]; then
        log_error "无法获取版本信息"
        return 1
    fi

    # 解析 JSON 获取 tag_name 和 assets
    LATEST_TAG=$(echo "$response" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
    LATEST_VERSION="${LATEST_TAG#v}"

    # 获取下载链接
    DOWNLOAD_URL=$(echo "$response" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.tar\.gz"' | head -1 | cut -d'"' -f4)

    if [ -z "$LATEST_TAG" ] || [ -z "$DOWNLOAD_URL" ]; then
        log_error "无法解析版本信息"
        return 1
    fi

    return 0
}

# 下载并解压 Release
download_release() {
    local url="$1"
    local dest_dir="$2"
    local temp_file="/tmp/nav-sylph-release-$$.tar.gz"
    local temp_dir="/tmp/nav-sylph-extract-$$"

    log_step "下载 ${LATEST_TAG}..."

    if check_command curl; then
        curl -fsSL "$url" -o "$temp_file"
    elif check_command wget; then
        wget -q "$url" -O "$temp_file"
    fi

    if [ ! -f "$temp_file" ]; then
        log_error "下载失败"
        return 1
    fi

    log_step "解压文件..."
    mkdir -p "$temp_dir"
    tar -xzf "$temp_file" -C "$temp_dir"

    # 找到解压后的目录（应该是 nav-sylph-vX.X.X）
    local extracted_dir=$(find "$temp_dir" -maxdepth 1 -type d -name "nav-sylph-*" | head -1)

    if [ -z "$extracted_dir" ]; then
        log_error "解压失败：未找到目录"
        rm -f "$temp_file"
        rm -rf "$temp_dir"
        return 1
    fi

    # 确保目标目录存在
    mkdir -p "$dest_dir"

    # 复制文件到目标目录
    cp -r "$extracted_dir"/* "$dest_dir/"

    # 清理
    rm -f "$temp_file"
    rm -rf "$temp_dir"

    return 0
}

# ===== 核心命令 =====

# 安装
do_install() {
    print_banner
    log_info "操作系统: $OS"
    echo ""

    check_dependencies
    log_info "Node.js: $(node --version)"
    echo ""

    # 获取最新版本
    log_step "获取最新版本..."
    if ! get_latest_release; then
        exit 1
    fi
    log_info "最新版本: ${LATEST_VERSION}"

    # 远程模式：需要下载
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

        # 下载并解压
        if ! download_release "$DOWNLOAD_URL" "$APP_DIR"; then
            exit 1
        fi
        cd "$APP_DIR"
        log_info "已安装到: $APP_DIR"
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

    # 启动服务
    local service_started=false
    if [ -t 0 ]; then
        # 有交互终端：询问用户
        read -p "是否立即启动服务? [Y/n] " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            do_start
            service_started=true
        fi
    else
        # 无交互终端（curl | bash）：直接启动
        do_start
        service_started=true
    fi

    # 获取配置
    get_config

    # 完成提示 - 显示完整状态
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    安装完成!                               ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${CYAN}── 安装信息 ──${NC}"
    echo "  安装目录:     $APP_DIR"
    echo "  安装版本:     v${LATEST_VERSION}"
    echo "  安装方式:     一键脚本"
    echo ""
    echo -e "${CYAN}── 服务状态 ──${NC}"
    if [ "$service_started" = true ] && is_running; then
        echo -e "  运行状态:     ${GREEN}运行中${NC} (PID: $(cat ${PID_FILE}))"
    else
        echo -e "  运行状态:     ${YELLOW}未启动${NC}"
    fi
    if has_systemd; then
        echo -e "  开机自启:     ${YELLOW}未启用${NC} (可用 sudo ./sylph.sh enable 启用)"
    else
        echo -e "  开机自启:     不适用 (当前系统: $OS)"
    fi
    echo ""
    echo -e "${CYAN}── 访问信息 ──${NC}"
    echo "  访问地址:     http://${HOST}:${PORT}"
    echo -e "  管理密码:     ${YELLOW}admin123${NC} (请登录后立即修改!)"
    echo ""
    echo -e "${CYAN}── 管理命令 ──${NC}"
    echo "  cd $APP_DIR"
    echo "  ./sylph.sh start       # 启动服务"
    echo "  ./sylph.sh stop        # 停止服务"
    echo "  ./sylph.sh restart     # 重启服务"
    echo "  ./sylph.sh status      # 查看状态"
    echo "  ./sylph.sh logs        # 查看日志"
    echo "  ./sylph.sh update      # 更新版本"
    echo "  ./sylph.sh uninstall   # 卸载"
    if has_systemd; then
        echo "  sudo ./sylph.sh enable   # 开机自启"
        echo "  sudo ./sylph.sh disable  # 禁用自启"
    fi
    echo ""
    echo -e "${CYAN}── 配置说明 ──${NC}"
    echo "  服务器配置:   编辑 .env 文件 (端口、HTTPS等)"
    echo "  书签管理:     浏览器访问后点击右下角齿轮图标"
    echo "  修改密码:     在管理面板中修改"
    echo ""
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
        log_info "服务启动成功 (PID: $(cat ${PID_FILE}))"
        return 0
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

    # 获取当前版本
    local old_version=""
    if [ -f "version.json" ]; then
        old_version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' version.json | cut -d'"' -f4)
    fi
    log_info "当前版本: ${old_version:-未知}"

    # 获取最新版本
    log_step "检查最新版本..."
    if ! get_latest_release; then
        exit 1
    fi
    log_info "最新版本: ${LATEST_VERSION}"

    # 检查是否需要更新
    if [ "$old_version" = "$LATEST_VERSION" ]; then
        log_info "已是最新版本，无需更新"
        exit 0
    fi

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
    [ -f "favorites.json" ] && cp favorites.json "$backup_dir/"

    # 下载新版本
    log_step "下载新版本..."
    local temp_dir="/tmp/nav-sylph-update-$$"
    mkdir -p "$temp_dir"

    if ! download_release "$DOWNLOAD_URL" "$temp_dir"; then
        log_error "下载失败，恢复备份..."
        rm -rf "$temp_dir"
        do_start
        exit 1
    fi

    # 更新文件（保留用户配置目录）
    log_step "更新文件..."

    # 删除旧的程序文件（保留用户数据）
    rm -rf public server-config
    rm -f server.js package.json package-lock.json sylph.sh version.json CHANGELOG.json
    rm -f .env.example server-config.example.json nav-sylph.service
    rm -f README.md DEPLOYMENT.md
    rm -rf docs
    rm -rf node_modules

    # 复制新文件
    cp -r "$temp_dir"/* "$APP_DIR/"
    rm -rf "$temp_dir"

    # 恢复配置
    log_step "恢复配置..."
    [ -f "$backup_dir/config.json" ] && cp "$backup_dir/config.json" .
    [ -f "$backup_dir/.admin-password.json" ] && cp "$backup_dir/.admin-password.json" .
    [ -f "$backup_dir/.env" ] && cp "$backup_dir/.env" .
    [ -f "$backup_dir/server-config.json" ] && cp "$backup_dir/server-config.json" .
    [ -f "$backup_dir/favorites.json" ] && cp "$backup_dir/favorites.json" .
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

    # 显示版本变化
    echo ""
    echo -e "${CYAN}版本更新: ${old_version:-1.0.0} → ${LATEST_VERSION}${NC}"

    # 显示更新亮点
    if [ -f "CHANGELOG.json" ]; then
        echo ""
        echo -e "${CYAN}── 更新亮点 ──${NC}"
        # 提取最新版本的 highlights
        grep -o '"highlights"[[:space:]]*:[[:space:]]*\[[^]]*\]' CHANGELOG.json | head -1 | \
            sed 's/"highlights"[[:space:]]*:[[:space:]]*\[//; s/\]//; s/"//g; s/,/\n/g' | \
            while read -r line; do
                line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
                [ -n "$line" ] && echo "  • $line"
            done
    fi
    echo ""
    echo "访问页面后将自动显示新功能说明"
    echo ""
}

# 卸载
do_uninstall() {
    print_banner

    if [ ! -d "$APP_DIR" ]; then
        log_error "未找到安装目录: $APP_DIR"
        exit 1
    fi

    cd "$APP_DIR"

    echo -e "${YELLOW}警告: 这将删除 Nav Sylph 及所有数据!${NC}"
    echo ""
    echo "  安装目录: $APP_DIR"
    echo ""

    # 非交互模式直接退出，防止误删
    if [ ! -t 0 ]; then
        log_error "卸载操作需要交互式终端确认，请直接运行: ./sylph.sh uninstall"
        exit 1
    fi

    read -p "确定要卸载吗? [y/N] " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "取消卸载"
        exit 0
    fi

    # ===== 1. 停止 systemd 服务（如果存在）=====
    if has_systemd; then
        # 检查服务是否正在运行
        if systemctl is-active --quiet ${APP_NAME} 2>/dev/null; then
            log_step "停止 systemd 服务..."
            sudo systemctl stop ${APP_NAME}
            log_info "systemd 服务已停止"
        fi

        # 检查服务是否已启用开机自启
        if systemctl is-enabled --quiet ${APP_NAME} 2>/dev/null; then
            log_step "禁用开机自启..."
            sudo systemctl disable ${APP_NAME}
            log_info "已禁用开机自启"
        fi

        # 删除服务文件
        if [ -f "${SYSTEMD_DIR}/${APP_NAME}.service" ]; then
            log_step "移除 systemd 服务文件..."
            sudo rm -f "${SYSTEMD_DIR}/${APP_NAME}.service"
            sudo systemctl daemon-reload
            log_info "已移除服务文件"
        fi
    fi

    # ===== 2. 停止手动启动的进程 =====
    if is_running; then
        log_step "停止服务进程..."
        do_stop
    elif [ -f "${PID_FILE}" ]; then
        # 清理残留的 PID 文件
        rm -f "${PID_FILE}"
    fi

    # ===== 3. macOS: 检查 launchd =====
    if [ "$OS" = "macos" ]; then
        local plist_file="$HOME/Library/LaunchAgents/com.nav-sylph.plist"
        if [ -f "$plist_file" ]; then
            log_step "检测到 launchd 服务，正在移除..."
            launchctl unload "$plist_file" 2>/dev/null || true
            rm -f "$plist_file"
            log_info "已移除 launchd 服务"
        fi
    fi

    # ===== 4. 删除安装目录 =====
    log_step "删除文件..."
    cd ~
    rm -rf "$APP_DIR"

    echo ""
    log_info "卸载完成!"
    echo ""
    echo "感谢使用 Nav Sylph!"
    echo ""
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
    echo "  install     安装 Nav Sylph (从 GitHub Release 下载)"
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
    echo ""
    echo "示例:"
    echo "  # 一键安装"
    echo "  curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/sylph.sh | bash"
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

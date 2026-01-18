#!/bin/bash
set -e

APP_NAME="nav-sylph"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="${APP_DIR}/.nav-sylph.pid"
LOG_DIR="${APP_DIR}/logs"
LOG_FILE="${LOG_DIR}/server.log"
NODE_BIN="${NODE_BIN:-node}"
SERVICE_FILE="${APP_DIR}/nav-sylph.service"
SYSTEMD_DIR="/etc/systemd/system"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

if [ -f "${APP_DIR}/.env" ]; then
    set -a
    source "${APP_DIR}/.env"
    set +a
fi

PORT="${SERVER_PORT:-4000}"
HOST="${SERVER_HOST:-127.0.0.1}"

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

check_root() {
    if [ "$(id -u)" != "0" ]; then
        log_error "This command requires root privileges. Use: sudo $0 $1"
        exit 1
    fi
}

is_running() {
    if [ -f "${PID_FILE}" ]; then
        local pid=$(cat "${PID_FILE}")
        if ps -p ${pid} > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

check_port() {
    if command -v lsof > /dev/null 2>&1; then
        lsof -i:${PORT} > /dev/null 2>&1
        return $?
    elif command -v ss > /dev/null 2>&1; then
        ss -tuln | grep -q ":${PORT} "
        return $?
    elif command -v netstat > /dev/null 2>&1; then
        netstat -tuln | grep -q ":${PORT} "
        return $?
    fi
    return 1
}

do_install() {
    log_step "Installing ${APP_NAME}..."
    
    log_step "Checking Node.js..."
    if ! command -v ${NODE_BIN} > /dev/null 2>&1; then
        log_error "Node.js not found. Please install Node.js first."
        exit 1
    fi
    log_info "Node.js: $(${NODE_BIN} --version)"
    
    log_step "Creating directories..."
    mkdir -p "${LOG_DIR}"
    log_info "Created: ${LOG_DIR}"
    
    log_step "Installing dependencies..."
    cd "${APP_DIR}"
    if [ -f "package.json" ]; then
        npm install --production 2>&1 | tail -3
        log_info "Dependencies installed"
    fi
    
    if [ ! -f "${APP_DIR}/.env" ] && [ -f "${APP_DIR}/.env.example" ]; then
        log_step "Creating .env from .env.example..."
        cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
        log_info "Created .env (edit as needed)"
    fi
    
    # 设置敏感文件权限
    if [ -f "${APP_DIR}/.admin-password.json" ]; then
        chmod 600 "${APP_DIR}/.admin-password.json"
    fi
    if [ -f "${APP_DIR}/.env" ]; then
        chmod 600 "${APP_DIR}/.env"
    fi
    
    echo ""
    log_info "Installation complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Edit .env if needed (optional)"
    echo "  2. Run: ./manage.sh start"
    echo "  3. Or install as system service: sudo ./manage.sh enable"
    echo ""
}

do_start() {
    if is_running; then
        log_warn "Server already running (PID: $(cat ${PID_FILE}))"
        exit 1
    fi
    
    if check_port; then
        log_error "Port ${PORT} is already in use"
        if command -v lsof > /dev/null 2>&1; then
            lsof -i:${PORT}
        fi
        exit 1
    fi
    
    mkdir -p "${LOG_DIR}"
    
    log_step "Starting server..."
    cd "${APP_DIR}"
    nohup ${NODE_BIN} server.js >> "${LOG_FILE}" 2>&1 &
    echo $! > "${PID_FILE}"
    
    sleep 2
    
    if is_running; then
        echo ""
        log_info "Server started successfully"
        echo ""
        echo "  PID:  $(cat ${PID_FILE})"
        echo "  URL:  http://${HOST}:${PORT}"
        echo "  Logs: ${LOG_FILE}"
        echo ""
    else
        log_error "Failed to start server"
        echo "Check logs: tail -50 ${LOG_FILE}"
        exit 1
    fi
}

do_stop() {
    if ! is_running; then
        log_warn "Server not running"
        [ -f "${PID_FILE}" ] && rm -f "${PID_FILE}"
        return 0
    fi
    
    local pid=$(cat "${PID_FILE}")
    log_step "Stopping server (PID: ${pid})..."
    
    kill -TERM ${pid} 2>/dev/null || true
    
    local count=0
    while is_running && [ ${count} -lt 10 ]; do
        sleep 1
        count=$((count + 1))
        echo -n "."
    done
    echo ""
    
    if is_running; then
        log_warn "Force stopping..."
        kill -KILL ${pid} 2>/dev/null || true
        sleep 1
    fi
    
    rm -f "${PID_FILE}"
    log_info "Server stopped"
}

do_restart() {
    do_stop
    sleep 1
    do_start
}

do_status() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}  Nav Sylph Server Status${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}"
    echo ""
    
    # 检查 systemd 服务状态
    if systemctl is-active --quiet ${APP_NAME} 2>/dev/null; then
        echo -e "  Mode:    ${GREEN}systemd${NC}"
        echo -e "  Status:  ${GREEN}RUNNING${NC}"
        echo ""
        systemctl status ${APP_NAME} --no-pager -l 2>/dev/null | head -10
    elif is_running; then
        local pid=$(cat "${PID_FILE}")
        echo -e "  Mode:    manual"
        echo -e "  Status:  ${GREEN}RUNNING${NC}"
        echo "  PID:     ${pid}"
        echo "  Host:    ${HOST}"
        echo "  Port:    ${PORT}"
        echo "  URL:     http://${HOST}:${PORT}"
        echo ""
        
        if command -v curl > /dev/null 2>&1; then
            local http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://${HOST}:${PORT}/api/health" 2>/dev/null || echo "000")
            if [ "${http_code}" = "200" ]; then
                echo -e "  Health:  ${GREEN}OK${NC}"
            else
                echo -e "  Health:  ${YELLOW}DEGRADED${NC} (HTTP ${http_code})"
            fi
        fi
        echo ""
        
        echo "  Process Info:"
        ps -p ${pid} -o pid,ppid,%cpu,%mem,etime,args 2>/dev/null | head -2
    else
        echo -e "  Status:  ${RED}STOPPED${NC}"
        if [ -f "${PID_FILE}" ]; then
            echo -e "  ${YELLOW}Warning: Stale PID file exists${NC}"
        fi
    fi
    echo ""
}

do_logs() {
    if [ ! -f "${LOG_FILE}" ]; then
        log_error "Log file not found: ${LOG_FILE}"
        exit 1
    fi
    
    echo "Showing logs (Ctrl+C to exit)..."
    echo ""
    tail -f "${LOG_FILE}"
}

do_enable() {
    check_root "enable"
    
    log_step "Installing systemd service..."
    
    # 生成适配当前路径的 service 文件
    local tmp_service="/tmp/nav-sylph.service"
    local run_user="${SUDO_USER:-root}"
    local node_path=$(which node)
    
    cat > "${tmp_service}" << SVCEOF
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
SVCEOF

    # 停止手动运行的进程
    if is_running; then
        log_step "Stopping manually started server..."
        do_stop
    fi
    
    # 安装服务
    cp "${tmp_service}" "${SYSTEMD_DIR}/${APP_NAME}.service"
    rm -f "${tmp_service}"
    
    log_step "Enabling and starting service..."
    systemctl daemon-reload
    systemctl enable ${APP_NAME}
    systemctl start ${APP_NAME}
    
    sleep 2
    
    if systemctl is-active --quiet ${APP_NAME}; then
        echo ""
        log_info "Service installed and started successfully!"
        echo ""
        echo "  Service:  ${APP_NAME}"
        echo "  Status:   active (running)"
        echo "  Autostart: enabled"
        echo "  URL:      http://${HOST}:${PORT}"
        echo ""
        echo "Manage with:"
        echo "  sudo systemctl status ${APP_NAME}"
        echo "  sudo systemctl restart ${APP_NAME}"
        echo "  sudo ./manage.sh disable  # to uninstall"
        echo ""
    else
        log_error "Service failed to start"
        systemctl status ${APP_NAME} --no-pager
        exit 1
    fi
}

do_disable() {
    check_root "disable"
    
    log_step "Removing systemd service..."
    
    if systemctl is-active --quiet ${APP_NAME} 2>/dev/null; then
        systemctl stop ${APP_NAME}
    fi
    
    if systemctl is-enabled --quiet ${APP_NAME} 2>/dev/null; then
        systemctl disable ${APP_NAME}
    fi
    
    if [ -f "${SYSTEMD_DIR}/${APP_NAME}.service" ]; then
        rm -f "${SYSTEMD_DIR}/${APP_NAME}.service"
        systemctl daemon-reload
    fi
    
    log_info "Service removed"
    echo ""
    echo "You can still use manual mode:"
    echo "  ./manage.sh start"
    echo ""
}

show_usage() {
    echo ""
    echo "Usage: $0 {install|start|stop|restart|status|logs|enable|disable}"
    echo ""
    echo "Commands:"
    echo "  install   Initialize the application (directories, dependencies)"
    echo "  start     Start the server (manual mode)"
    echo "  stop      Stop the server gracefully"
    echo "  restart   Restart the server"
    echo "  status    Show server status and health"
    echo "  logs      Tail the server logs"
    echo ""
    echo "Systemd Commands (requires sudo):"
    echo "  enable    Install as systemd service with auto-start on boot"
    echo "  disable   Remove systemd service"
    echo ""
    echo "Configuration:"
    echo "  Edit .env file or set environment variables:"
    echo "    SERVER_HOST  Listen address (default: 127.0.0.1)"
    echo "    SERVER_PORT  Listen port (default: 4000)"
    echo ""
    exit 1
}

case "${1:-}" in
    install)
        do_install
        ;;
    start)
        do_start
        ;;
    stop)
        do_stop
        ;;
    restart)
        do_restart
        ;;
    status)
        do_status
        ;;
    logs)
        do_logs
        ;;
    enable)
        do_enable
        ;;
    disable)
        do_disable
        ;;
    *)
        show_usage
        ;;
esac

exit 0

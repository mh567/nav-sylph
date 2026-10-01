const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scriptPath = path.join(__dirname, '..', 'sylph.sh');
const ROOT = path.join(__dirname, '..');

function runLifecycle(action, initialState = 'active', options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sylph-service-test-'));
    const statePath = path.join(directory, 'service-state');
    const callsPath = path.join(directory, 'systemctl-calls');
    fs.writeFileSync(statePath, initialState);
    const source = fs.readFileSync(scriptPath, 'utf8').replace(/^main "\$@"\s*$/m, '');
    const script = `${source}
        APP_DIR="$CASE_DIR"
        PID_FILE="$CASE_DIR/.nav-sylph.pid"
        LOG_DIR="$CASE_DIR/logs"
        OS=linux
        has_systemd() { return 0; }
        check_port() { return 0; }
        sudo() { shift; systemctl "$@"; }
        systemctl() {
            printf '%s\\n' "$*" >> "$CALLS_PATH"
            case "$1" in
                show)
                    case "$2" in
                        --property=LoadState) printf 'loaded\\n' ;;
                        --property=WorkingDirectory) printf '%s\\n' "$SERVICE_DIR" ;;
                    esac
                    ;;
                is-active) [ "$(cat "$STATE_PATH")" = active ] ;;
                stop)
                    [ "$FAIL_STOP" = 1 ] && return 1
                    printf 'inactive' > "$STATE_PATH"
                    ;;
                start) printf 'active' > "$STATE_PATH" ;;
            esac
        }
        ${action}
    `;
    const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
            ...process.env,
            CASE_DIR: directory,
            SERVICE_DIR: options.serviceDirectory || directory,
            STATE_PATH: statePath,
            CALLS_PATH: callsPath,
            FAIL_STOP: options.failStop ? '1' : '0'
        }
    });
    const state = fs.readFileSync(statePath, 'utf8');
    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : '';
    const downloadAttempted = fs.existsSync(path.join(directory, 'download-attempted'));
    const serverContents = fs.existsSync(path.join(directory, 'server.js'))
        ? fs.readFileSync(path.join(directory, 'server.js'), 'utf8') : null;
    fs.rmSync(directory, { recursive: true, force: true });
    return { ...result, state, calls, downloadAttempted, serverContents };
}

test('stop handles an active systemd service without a PID file', () => {
    const result = runLifecycle('do_stop');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.calls}`);
    assert.match(result.calls, /stop nav-sylph\.service/);
    assert.equal(result.state, 'inactive');
});

test('start uses an installed systemd service when its port is occupied', () => {
    const result = runLifecycle('do_start', 'inactive');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.calls}`);
    assert.match(result.calls, /start nav-sylph\.service/);
    assert.equal(result.state, 'active');
});

test('stop leaves a systemd service for another installation alone', () => {
    const result = runLifecycle('do_stop', 'active', { serviceDirectory: '/other/nav-sylph' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.calls, /stop nav-sylph\.service/);
    assert.equal(result.state, 'active');
});

test('failed systemd stop prevents an update from downloading or replacing files', () => {
    const action = `
        printf 'old server' > "$CASE_DIR/server.js"
        printf '{"version":"1.5.0"}' > "$CASE_DIR/version.json"
        get_latest_release() { LATEST_VERSION=1.5.1; }
        download_release() { touch "$CASE_DIR/download-attempted"; return 1; }
        do_update
    `;
    const result = runLifecycle(action, 'active', { failStop: true });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /服务未能停止，更新已取消/);
    assert.equal(result.downloadAttempted, false);
    assert.equal(result.serverContents, 'old server');
    assert.doesNotMatch(result.calls, /start nav-sylph\.service/);
});

// ========== 源码形状守卫：会话库的部署面 ==========
//
// 会话落盘依赖三处部署配置同时正确。任一处漏掉，症状都不是本地报错，而是真实环境里
// 「升级后又掉登录」或「服务起不来」——所以把它们钉成断言，而不是靠手工核对。

test('systemd 单元把会话库及其 WAL 边车纳入可写路径', () => {
    // ProtectSystem=strict 下，未列入 ReadWritePaths 的路径一律只读，库建不出来。
    const unit = fs.readFileSync(path.join(ROOT, 'nav-sylph.service'), 'utf8');
    assert.match(unit, /ReadWritePaths=.*nav-sylph\.db\b/, '会话库必须可写');
    assert.match(unit, /ReadWritePaths=.*nav-sylph\.db-wal/, 'WAL 边车也要可写');
});

test('sylph.sh 更新前备份会话库、替换文件后放回', () => {
    const sh = fs.readFileSync(scriptPath, 'utf8');
    assert.match(sh, /\[\s*-f\s+"nav-sylph\.db"\s*\]\s*&&\s*cp\s+nav-sylph\.db\s+"\$backup_dir\/"/,
        '更新流程要先备份会话库');
    assert.match(sh, /\[\s*-f\s+"\$backup_dir\/nav-sylph\.db"\s*\]\s*&&\s*cp\s+"\$backup_dir\/nav-sylph\.db"\s+\./,
        '替换程序文件后要把会话库放回，否则回滚路径状态不一致');
});

test('.gitignore 排除会话库及其 WAL 边车', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const entry of ['nav-sylph.db', 'nav-sylph.db-wal', 'nav-sylph.db-shm']) {
        assert.match(ignore, new RegExp(`^${entry.replace(/\./g, '\\.')}$`, 'm'),
            `${entry} 必须被忽略，否则库会进仓库`);
    }
});

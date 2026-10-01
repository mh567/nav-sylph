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
        # 钉住 Node 版本：否则这条用例会隐式依赖跑测试的环境 Node ≥ 22，
        # 一旦在低版本上跑（或闸门阈值被改坏），它会因为闸门而非「停服失败」转红。
        NODE_BIN="$CASE_DIR/fake-node"
        { echo '#!/bin/bash'; echo 'echo v22.11.0'; } > "$NODE_BIN"
        chmod +x "$NODE_BIN"
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

// ========== Node 版本闸门 ==========
//
// 版本不够的后果是「npm install 全绿、启动时段错误」：实测 Node 20 加载 better-sqlite3@13
// 直接 Segmentation fault，且 npm 不报 EBADENGINE。更新一旦走到停服+换文件就没有回滚路径，
// 所以闸门必须挡在最前面。

function updateAction({ nodeVersion, latest }) {
    return `
        NODE_BIN="$CASE_DIR/fake-node"
        { echo '#!/bin/bash'; echo 'echo v${nodeVersion}'; } > "$NODE_BIN"
        chmod +x "$NODE_BIN"
        printf 'old server' > "$CASE_DIR/server.js"
        printf '{"version":"1.5.0"}' > "$CASE_DIR/version.json"
        get_latest_release() { LATEST_VERSION=${latest}; }
        download_release() { touch "$CASE_DIR/download-attempted"; return 1; }
        do_update
    `;
}

test('Node 版本不足时更新被拒绝，且不停服、不下载、不替换文件', () => {
    // latest 故意设得比本地新：若闸门缺失，这个版本会被放行到停服与下载，测试随即转红。
    const result = runLifecycle(updateAction({ nodeVersion: '20.11.1', latest: '1.5.1' }), 'active');
    assert.notEqual(result.status, 0, '版本不足必须中止更新');
    assert.match(result.stdout, /当前 Node 主版本为 20/);
    assert.match(result.stdout, /要求 Node 22/);
    assert.equal(result.downloadAttempted, false, '拒绝时不应发起下载');
    assert.equal(result.serverContents, 'old server', '拒绝时不应替换程序文件');
    assert.doesNotMatch(result.calls, /stop nav-sylph\.service/, '拒绝时不应停服');
});

test('Node 版本满足时闸门放行，更新照常走后续流程', () => {
    // 对照组：latest 与本地相同，走闸门之后立刻命中「已是最新版本」，
    // 因此既不碰 do_stop/备份，也证明闸门确实放行了。
    const result = runLifecycle(updateAction({ nodeVersion: '22.11.0', latest: '1.5.0' }), 'active');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /已是最新版本/);
});

test('Node 版本闸门排在停服与下载之前', () => {
    const body = fs.readFileSync(scriptPath, 'utf8').slice(
        fs.readFileSync(scriptPath, 'utf8').indexOf('do_update() {'));
    const gate = body.indexOf('check_node_version || exit 1');
    assert.ok(gate > -1, 'do_update 必须调用版本闸门');
    assert.ok(gate < body.indexOf('do_stop'),
        '闸门必须在停服之前——停服之后失败就没有回滚路径了');
    assert.ok(gate < body.indexOf('download_release'),
        '闸门必须在下载之前');
});

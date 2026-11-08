'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = fs.readFileSync(path.join(__dirname, '../scripts/release.sh'), 'utf8');
const publish = script.slice(script.indexOf('# 发布到 GitHub Release'), script.indexOf('# 清理'));
function releaseArguments(version) {
    const result = spawnSync('bash', ['-c', `
        set -e
        log_step() { :; }
        gh() {
            if [ "$1" = release ] && [ "$2" = view ]; then return 1; fi
            printf '%s\\0' "$@"
        }
        ${publish}
    `], { encoding: 'utf8', env: { ...process.env, VERSION: version, RELEASE_NOTES: 'line one\nline two', ARCHIVE_PATH: '/tmp/release files/nav.tar.gz' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\0').filter(Boolean);
}

test('release: test versions are prereleases and never replace latest', () => {
    const args = releaseArguments('2.2.5-beta.1');
    assert.deepEqual(args, ['release', 'create', 'v2.2.5-beta.1', '--title', 'Habu v2.2.5-beta.1', '--notes', 'line one\nline two', '--prerelease', '--latest=false', '/tmp/release files/nav.tar.gz']);
});

test('release: stable versions retain the existing release command', () => {
    const args = releaseArguments('2.2.5');
    assert.deepEqual(args, ['release', 'create', 'v2.2.5', '--title', 'Habu v2.2.5', '--notes', 'line one\nline two', '/tmp/release files/nav.tar.gz']);
});


test('release: test package instructions use the attached archive; stable update instructions remain', () => {
    const notes = script.slice(script.indexOf('# 生成发布说明'), script.indexOf('# 创建 Git Tag'));
    for (const version of ['2.2.5-beta.1', '2.2.5']) {
        const result = spawnSync('bash', ['-c', `log_step() { :; }; ${notes}`], {
            encoding: 'utf8', cwd: path.join(__dirname, '..'),
            env: { ...process.env, VERSION: version, ARCHIVE_NAME: `nav-sylph-v${version}.tar.gz` }
        });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(`nav-sylph-v${version}.tar.gz`));
        assert.equal(result.stdout.includes('./sylph.sh update'), !version.includes('-'));
        assert.equal(result.stdout.includes('独立测试环境'), version.includes('-'));
    }
});

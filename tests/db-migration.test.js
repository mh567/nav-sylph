'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateDatabaseFile } = require('../lib/db');

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'habu-db-migration-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('旧 nav-sylph.db 与 WAL 边车在打开前改名为 habu.db', (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, 'nav-sylph.db'), 'main');
    fs.writeFileSync(path.join(dir, 'nav-sylph.db-wal'), 'wal');
    fs.writeFileSync(path.join(dir, 'nav-sylph.db-shm'), 'shm');

    const target = path.join(dir, 'habu.db');
    const result = migrateDatabaseFile(target);

    assert.equal(result.migrated, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'main');
    assert.equal(fs.readFileSync(`${target}-wal`, 'utf8'), 'wal');
    assert.equal(fs.readFileSync(`${target}-shm`, 'utf8'), 'shm');
    for (const name of ['nav-sylph.db', 'nav-sylph.db-wal', 'nav-sylph.db-shm']) {
        assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应已移走`);
    }
});

test('目标库已存在时不动旧库', (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, 'nav-sylph.db'), 'old');
    fs.writeFileSync(path.join(dir, 'habu.db'), 'new');

    const result = migrateDatabaseFile(path.join(dir, 'habu.db'));

    assert.equal(result.migrated, false);
    assert.equal(fs.readFileSync(path.join(dir, 'habu.db'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(dir, 'nav-sylph.db'), 'utf8'), 'old');
});

test('显式把库名指成旧名时不迁移', (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, 'nav-sylph.db'), 'old');
    const result = migrateDatabaseFile(path.join(dir, 'nav-sylph.db'));
    assert.equal(result.migrated, false);
    assert.equal(fs.readFileSync(path.join(dir, 'nav-sylph.db'), 'utf8'), 'old');
});

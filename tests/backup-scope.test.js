'use strict';

/**
 * #12 备份范围：只有私人数据进备份，且清单说得清装了与跳过了什么。
 *
 * 分三段：
 *  1. 投影（纯函数）：字段级排除必须有断言——形状断言看不出「多带了一个 token」。
 *  2. 产物（走真实 createBackup，注入式 WebDAV 存根）：文件集合、清单、校验和、
 *     **产物里不得出现任何 AES-GCM 信封**。
 *  3. 恢复侧合并与旧备份：按稳定模块 id 合并私人项、保留本机公开项、不回填凭据；
 *     旧备份列出但仍然「只恢复书签」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
    WebDAVBackup,
    projectModulesForBackup,
    projectMemosForBackup,
    projectTodosForBackup,
    projectFavoritesForBackup,
    mergePrivateModules,
    calculateChecksum,
    sha256Bytes,
    SKIPPED_DOMAINS,
    INCLUDED_DOMAINS,
    SCOPE_VERSION
} = require(path.join(ROOT, 'lib', 'webdav-backup.js'));
const { isEnvelope, encrypt } = require(path.join(ROOT, 'lib', 'credentials.js'));

const HASH = '$2b$10$hashforbackupscope';
const PUBLIC_IDS = ['weibo-hot'];

/** 记录写入的假 WebDAV 客户端（不联网、不落盘）。 */
function recordingClient(files) {
    const calls = { gets: [], puts: [] };
    const client = {
        getDirectoryContents: async () => [...files.keys()].map(name => ({
            type: 'file',
            basename: path.posix.basename(name),
            filename: name,
            size: files.get(name).length,
            lastmod: '2026-10-08T00:00:00Z'
        })),
        putFileContents: async (name, content) => { calls.puts.push(name); files.set(name, content); },
        getFileContents: async name => {
            calls.gets.push(name);
            if (!files.has(name)) throw new Error('not found: ' + name);
            return files.get(name);
        },
        createDirectory: async () => {},
        deleteFile: async name => { files.delete(name); }
    };
    return { client, calls };
}

function offlineBackup(config, client) {
    const b = new WebDAVBackup('/unused', 'unused');
    b.config = config;
    b.createClient = () => client;
    b.saveConfig = async data => { b.config = { ...b.config, ...data }; };
    return b;
}

/** 一份「什么都带了」的模块配置：凭据、公开模块项、_sync 全在。 */
function modulesFixture() {
    return {
        version: 1,
        enabledModules: ['server-monitor', 'memo', 'weibo-hot'],
        publicModules: ['weibo-hot'],
        widgets: [
            { id: 'weibo-hot', enabled: true, side: 'right', order: 0, collapsed: false },
            { id: 'server-monitor', enabled: true, side: 'left', order: 1, collapsed: true },
            { id: 'memo', enabled: false, side: 'left', order: 2, collapsed: false }
        ],
        servers: [
            {
                id: 'srv-home', name: '家里的 NAS', url: 'https://nas.test:8787',
                mode: 'push', reachable: false,
                token: encrypt('agent-token-plaintext', HASH, 'modules'),
                pushSecretHash: 'a'.repeat(64),
                enrollTokenHash: 'b'.repeat(64),
                enrollTokenExpiresAt: 1893456000000,
                enrollTokenIp: '203.0.113.9',
                certPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
                certFingerprint: 'c'.repeat(64),
                enrolledAt: 1767225600000,
                deployState: 'ready',
                stateProbedAt: 1767225700000
            }
        ],
        socialAccounts: ['@alice'],
        symbols: ['🔥'],
        pollInterval: 30,
        _sync: { revision: 7, receipts: { 'op-1': { at: 1, digest: 'd', response: {} } } }
    };
}

/** 递归找 AES-GCM 信封。产物里出现任何一个都算泄露（密钥跨安装解不开，带过去只是多一份暴露面）。 */
function findEnvelopes(value, trail = '') {
    const found = [];
    if (Array.isArray(value)) {
        value.forEach((item, i) => found.push(...findEnvelopes(item, `${trail}[${i}]`)));
        return found;
    }
    if (!value || typeof value !== 'object') return found;
    if (isEnvelope(value)) {
        found.push(trail || '<root>');
        return found;
    }
    for (const [key, item] of Object.entries(value)) {
        found.push(...findEnvelopes(item, trail ? `${trail}.${key}` : key));
    }
    return found;
}

// ========== 投影：字段级排除 ==========

test('模块投影：凭据、_sync、公开模块项与界面资料一律不进备份', () => {
    const projected = projectModulesForBackup(modulesFixture(), { publicModuleIds: PUBLIC_IDS });
    const text = JSON.stringify(projected);

    // 排除项逐条断言（不是「没有 token 字段」这种笼统说法）
    for (const needle of ['token', 'pushSecretHash', 'enrollTokenHash', 'enrollTokenExpiresAt',
        'enrollTokenIp', 'socialAccounts', 'symbols', 'publicModules', 'weibo-hot',
        '203.0.113.9', 'a'.repeat(64), 'b'.repeat(64)]) {
        assert.ok(!text.includes(needle), `产物里不得出现「${needle}」`);
    }
    assert.equal(projected._sync, undefined, '_sync 是本机并发元数据');
    assert.deepEqual(findEnvelopes(projected), [], '不得出现任何 AES-GCM 信封');

    // 保留项：公钥与注册信息不是凭据，恢复后仍然有用
    assert.equal(projected.servers[0].certPem, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
    assert.equal(projected.servers[0].certFingerprint, 'c'.repeat(64));
    assert.equal(projected.servers[0].enrolledAt, 1767225600000);
    assert.equal(projected.servers[0].deployState, 'ready');

    // 公开模块项：布局与开关都不带；私人项原样带
    assert.deepEqual(projected.widgets.map(w => w.id), ['server-monitor', 'memo']);
    assert.deepEqual(projected.enabledModules, ['server-monitor', 'memo']);
    assert.equal(projected.pollInterval, 30, '采集周期属于监控配置，进备份');
});

test('模块投影的键顺序固定（checksum 是 JSON.stringify 摘要，键序敏感）', () => {
    // 同一台机器，一份带注册信息、一份没有：键顺序必须一致，
    // 否则同一份内容会算出两个校验和 ⇒ noChanges 永远判不中 ⇒ 每轮都上传。
    const withCert = projectModulesForBackup({ servers: [{
        id: 's', url: 'https://s.test', certPem: 'x', deployState: 'ready'
    }] }, { publicModuleIds: PUBLIC_IDS });
    const withoutCert = projectModulesForBackup({ servers: [{
        id: 's', url: 'https://s.test'
    }] }, { publicModuleIds: PUBLIC_IDS });
    const keysOf = obj => Object.keys(obj);
    assert.deepEqual(keysOf(withCert.servers[0]),
        ['id', 'name', 'url', 'mode', 'reachable', 'certPem', 'deployState']);
    assert.deepEqual(keysOf(withoutCert.servers[0]), ['id', 'name', 'url', 'mode', 'reachable'],
        '可选字段只是追加在固定前缀之后，前缀顺序不变');
    assert.deepEqual(keysOf(withCert), ['version', 'enabledModules', 'widgets', 'servers', 'pollInterval']);
    // 键顺序稳定 ⇒ 同样的输入产出同样的校验和
    assert.equal(calculateChecksum(projectModulesForBackup(modulesFixture(), { publicModuleIds: PUBLIC_IDS })),
        calculateChecksum(projectModulesForBackup(modulesFixture(), { publicModuleIds: PUBLIC_IDS })));
});

test('备忘录投影只带正文与状态六项，多余字段被丢掉', () => {
    const projected = projectMemosForBackup([
        { id: 'm1', title: '标题', body: '正文', pinned: true, createdAt: 1, updatedAt: 2, ownerHash: 'secret' },
        { id: '', title: '没有 id' },
        { title: '缺 id' }
    ]);
    assert.equal(projected.memos.length, 1, '没有 id 的条目被丢掉（否则恢复时写不回去）');
    assert.deepEqual(Object.keys(projected.memos[0]), ['id', 'title', 'body', 'pinned', 'createdAt', 'updatedAt']);
    assert.deepEqual(projected.memos[0], {
        id: 'm1', title: '标题', body: '正文', pinned: true, createdAt: 1, updatedAt: 2
    });
});

test('待办投影只带文字/完成态五项，多余字段被丢掉', () => {
    const projected = projectTodosForBackup([
        { id: 't1', text: '买牛奶', done: true, createdAt: 1, updatedAt: 2, ownerHash: 'secret' },
        { id: '', text: '没有 id' },
        { text: '缺 id' }
    ]);
    assert.equal(projected.todos.length, 1, '没有 id 的条目被丢掉（否则恢复时写不回去）');
    assert.deepEqual(Object.keys(projected.todos[0]), ['id', 'text', 'done', 'createdAt', 'updatedAt']);
    assert.deepEqual(projected.todos[0], {
        id: 't1', text: '买牛奶', done: true, createdAt: 1, updatedAt: 2
    });
    // done 非严格布尔时按未完成处理，不把字符串带进备份
    assert.equal(projectTodosForBackup([{ id: 't2', text: 'x', done: 'yes' }]).todos[0].done, false);
});

test('收藏投影只带标题/地址/分类/隐私标签', () => {
    const projected = projectFavoritesForBackup([
        { title: 'A', url: 'https://a.test', category: '工作', private: true, id: 'fav_1', tags: ['x'] },
        { title: 'B' }
    ]);
    assert.equal(projected.length, 1, '没有地址的条目被丢掉');
    assert.deepEqual(projected[0], { title: 'A', url: 'https://a.test', category: '工作', private: true });
});

// ========== 产物：文件集合 + 清单 ==========

test('备份产物只有清单声明的五个域 + manifest，且不含任何 AES-GCM 信封', async () => {
    const files = new Map();
    const { client } = recordingClient(files);
    const backup = offlineBackup({ remotePath: '/backups/' }, client);

    const result = await backup.createBackup({
        favorites: [{ title: 'A', url: 'https://a.test', category: '工作', private: true }],
        memos: [{ id: 'm1', title: '备忘', body: '正文', pinned: true, createdAt: 10, updatedAt: 20 }],
        todos: [{ id: 't1', text: '待办一条', done: true, createdAt: 30, updatedAt: 40 }],
        modules: modulesFixture(),
        timeline: {
            formatVersion: 1,
            sources: [{ id: 's1', provider_type: 'x', name: 'X' }],
            events: [{ id: 'e1', source_id: 's1', title: '事件' }],
            eventState: [{ event_id: 'e1', favorited_at: 5, archived_at: 6 }]
        },
        appVersion: '2.0.2',
        publicModuleIds: PUBLIC_IDS,
        renderBookmarks: () => '<DL><p><DT><A HREF="https://a.test" DATA-SYLPH-PRIVATE="1">A</A>\n</DL><p>'
    });

    // 1) 文件集合逐字：不再有 nav-sylph-config-*
    const written = [...files.keys()].map(name => path.posix.basename(name)).sort();
    assert.deepEqual(written, [
        `nav-sylph-bookmarks-${result.timestamp}.html`,
        `nav-sylph-manifest-${result.timestamp}.json`,
        `nav-sylph-memos-${result.timestamp}.json`,
        `nav-sylph-modules-${result.timestamp}.json`,
        `nav-sylph-timeline-${result.timestamp}.json`,
        `nav-sylph-todos-${result.timestamp}.json`
    ]);
    assert.ok(!written.some(name => name.startsWith('nav-sylph-config')), '不再生成 config 备份');

    // 2) 每个 JSON 产物里都不得出现 AES-GCM 信封
    for (const [name, content] of files) {
        if (!name.endsWith('.json')) {
            assert.ok(!content.includes('"iv"'), `HTML 里不会有信封（${name}）`);
            continue;
        }
        assert.deepEqual(findEnvelopes(JSON.parse(content)), [], `${path.posix.basename(name)} 里不得有信封`);
    }

    // 3) 信封版本 1→2，checksum 语义没变（旧读取按同一个算法复算仍成立）
    const memosEnvelope = JSON.parse(files.get('/backups/' + result.memosFilename));
    assert.equal(memosEnvelope.version, 2);
    assert.equal(memosEnvelope.type, 'nav-sylph-memos');
    assert.equal(memosEnvelope.checksum, calculateChecksum(memosEnvelope.data),
        'checksum 仍是 sha256(JSON.stringify(data))，旧版本按同一算法复算即可');

    // 4) 清单：included[] 有 domain/file/sha256/counts，sha256 对得上真实字节
    const manifest = JSON.parse(files.get('/backups/' + result.manifestFilename));
    assert.equal(manifest.type, 'nav-sylph-manifest');
    assert.equal(manifest.data.scopeVersion, SCOPE_VERSION);
    assert.deepEqual(manifest.data.included.map(entry => entry.domain), INCLUDED_DOMAINS);
    for (const entry of manifest.data.included) {
        assert.equal(typeof entry.file, 'string', `${entry.domain} 带文件名`);
        assert.equal(typeof entry.counts, 'object', `${entry.domain} 带计数`);
        const bytes = files.get('/backups/' + entry.file);
        assert.equal(entry.sha256, sha256Bytes(bytes),
            `${entry.domain} 的 sha256 是**文件字节**的摘要，不是重算出来的对象摘要`);
    }
    const counts = Object.fromEntries(manifest.data.included.map(e => [e.domain, e.counts]));
    assert.deepEqual(counts.favorites, { favorites: 1, private: 1 });
    assert.deepEqual(counts.memos, { memos: 1, pinned: 1 });
    assert.deepEqual(counts.todos, { todos: 1, done: 1 });
    assert.deepEqual(counts.modules, { servers: 1, widgets: 2, enabledModules: 2 });
    assert.deepEqual(counts.timeline, { sources: 1, events: 1, eventState: 1 });

    // 5) 清单的 skipped[]：每个排除域一条，带原因
    const skipped = manifest.data.skipped;
    for (const domain of ['admin-navigation', 'default-template', 'sync-spaces', 'passwords-sessions',
        'metrics-cache', 'modules.publicModules', 'modules.socialAccounts', 'modules.symbols',
        'modules._sync', 'modules.servers[].token', 'modules.servers[].pushSecretHash',
        'modules.servers[].enrollTokenHash']) {
        const entry = skipped.find(item => item.domain === domain);
        assert.ok(entry, `skipped[] 必须有 ${domain}`);
        assert.ok(typeof entry.reason === 'string' && entry.reason.length > 4, `${domain} 要说明原因`);
    }
    assert.equal(skipped.length, SKIPPED_DOMAINS.length, '跳过的项与常量表一一对应');
});

test('六个校验和各自都能让「有没有变化」失效（少了任一项都会静默漏上传）', async () => {
    const keys = ['lastFavoritesChecksum', 'lastMemosChecksum', 'lastTodosChecksum',
        'lastModulesChecksum', 'lastTimelineChecksum', 'lastScopeChecksum'];
    const payload = {
        favorites: [{ title: 'A', url: 'https://a.test', category: '工作' }],
        memos: [{ id: 'm1', title: '备忘', body: '正文', pinned: false, createdAt: 10, updatedAt: 20 }],
        todos: [{ id: 't1', text: '待办', done: false, createdAt: 10, updatedAt: 20 }],
        modules: modulesFixture(),
        timeline: { formatVersion: 1, sources: [], events: [{ id: 'e' }], eventState: [] },
        appVersion: '2.0.2',
        publicModuleIds: PUBLIC_IDS,
        renderBookmarks: () => '<DL><p>\n</DL><p>'
    };

    const files = new Map();
    const { client } = recordingClient(files);
    const backup = offlineBackup({ remotePath: '/backups/' }, client);
    await backup.createBackup(payload);
    for (const key of keys) {
        assert.equal(typeof backup.config[key], 'string', `${key} 必须被写入`);
    }
    assert.equal((await backup.createBackup(payload)).noChanges, true, '内容没变就不重复上传');

    // 逐个抹掉一项 -> 必须重新上传。只抹一项就够证明这一项在判定里承重。
    for (const key of keys) {
        const probe = offlineBackup({ remotePath: '/backups/', ...backup.config, [key]: 'stale' },
            recordingClient(new Map()).client);
        const result = await probe.createBackup(payload);
        assert.equal(result.noChanges, undefined, `${key} 不相等时必须重新备份`);
    }

    // 内容真的变了也必须重新上传（不是只靠校验和键的存在）
    const changed = { ...payload, memos: [{ id: 'm2', title: '新备忘', body: '', pinned: false, createdAt: 1, updatedAt: 1 }] };
    assert.equal((await backup.createBackup(changed)).noChanges, undefined, '备忘录变了要重新备份');
    const todoChanged = { ...payload, todos: [{ id: 't2', text: '新待办', done: true, createdAt: 3, updatedAt: 4 }] };
    assert.equal((await backup.createBackup(todoChanged)).noChanges, undefined, '待办变了也要重新备份');

    // 自动槽位与手动各一组，互不吞掉
    const auto = offlineBackup({ remotePath: '/backups/' }, recordingClient(new Map()).client);
    await auto.createBackup(payload, { auto: true });
    assert.equal((await auto.createBackup(payload, { auto: true })).noChanges, true);
    assert.equal((await auto.createBackup(payload)).noChanges, undefined,
        '自动备份过不代表手动「没有变化」——一次显式请求不能被静默吞掉');
});

test('清单也算进产物：篡改任一文件后按清单核对会拒绝恢复', async () => {
    const files = new Map();
    const { client } = recordingClient(files);
    const backup = offlineBackup({ remotePath: '/backups/' }, client);
    const result = await backup.createBackup({
        favorites: [{ title: 'A', url: 'https://a.test', category: '工作' }],
        memos: [{ id: 'm1', title: '备忘', body: '正文', pinned: false, createdAt: 1, updatedAt: 2 }],
        modules: null,
        timeline: null,
        appVersion: '2.0.2',
        publicModuleIds: PUBLIC_IDS,
        renderBookmarks: () => '<DL><p>\n</DL><p>'
    });

    // 原样能读
    const ok = await backup.restoreBackup({
        bookmarksFile: result.bookmarksFilename,
        memosFile: result.memosFilename,
        manifestFile: result.manifestFilename
    });
    assert.equal(ok.data.memos.memos[0].title, '备忘');
    // 收藏 + 备忘 + 待办（空表也要写：那是「那时候没有待办」）
    assert.equal(ok.manifest.included.length, 3);

    // 把备忘录文件改一个字（信封 checksum 也会对不上，所以先只改 HTML——
    // 那一个没有自校验，只有清单能发现它被换过）
    files.set('/backups/' + result.bookmarksFilename, '<DL><p><DT><A HREF="https://evil.test">x</A>\n</DL><p>');
    await assert.rejects(
        () => backup.restoreBackup({
            bookmarksFile: result.bookmarksFilename,
            manifestFile: result.manifestFilename
        }),
        /清单不符/, '清单说 A 内容、取回来是 B，必须拒绝');
});

// ========== 恢复侧合并 ==========

test('合并私人模块项：保留本机公开项与相对顺序，凭据不回填', () => {
    const current = {
        version: 1,
        enabledModules: ['weibo-hot', 'server-monitor'],
        publicModules: ['weibo-hot'],
        widgets: [
            { id: 'weibo-hot', enabled: true, side: 'right', order: 0, collapsed: false },
            { id: 'server-monitor', enabled: true, side: 'left', order: 1, collapsed: false }
        ],
        servers: [{
            id: 'srv-home', name: '本机的名字', url: 'https://nas.test:8787', mode: 'push',
            reachable: true, token: encrypt('still-here', HASH, 'modules'), deployState: 'ready'
        }],
        socialAccounts: ['@local'],
        symbols: ['★'],
        pollInterval: 15
    };
    const backupModules = {
        version: 1,
        enabledModules: ['memo', 'timeline'],
        widgets: [
            { id: 'memo', enabled: true, side: 'left', order: 0, collapsed: false },
            { id: 'timeline', enabled: false, side: 'right', order: 1, collapsed: true }
        ],
        servers: [
            // 同一台机器：只补布局，凭据与状态以本机为准
            { id: 'srv-home', name: '备份里的名字', url: 'https://nas.test:8787', mode: 'push', reachable: false, deployState: 'ready' },
            // 本机没有的机器：补一台「缺凭据」的
            { id: 'srv-office', name: '办公室', url: 'https://office.test', mode: 'pull', reachable: true, certPem: 'PEM', enrollState: undefined, deployState: 'ready' }
        ],
        pollInterval: 60
    };

    const { modules, needsAuthorization } = mergePrivateModules(current, backupModules, { publicModuleIds: PUBLIC_IDS });

    // 公开项是本机的，且排在前面（相对顺序保留）；私人项来自备份
    assert.deepEqual(modules.widgets.map(w => [w.id, w.order]),
        [['weibo-hot', 0], ['memo', 1], ['timeline', 2]]);
    assert.deepEqual(modules.enabledModules, ['weibo-hot', 'memo', 'timeline'],
        '公开模块的开关来自本机，私人模块的来自备份');
    // 本机对访客的授权与界面资料一律保住
    assert.deepEqual(modules.publicModules, ['weibo-hot']);
    assert.deepEqual(modules.socialAccounts, ['@local']);
    assert.deepEqual(modules.symbols, ['★']);
    assert.equal(modules.pollInterval, 60, '采集周期属于监控配置，取备份');

    // 同一台机器：令牌没有被覆盖或删除
    const home = modules.servers.find(s => s.id === 'srv-home');
    assert.ok(isEnvelope(home.token), '本机凭据原样保留——凭据从来没进备份，也绝不能被「恢复成空」');
    assert.equal(home.name, '备份里的名字', '布局字段取备份');
    assert.equal(home.reachable, false);

    // 本机没有的机器：加进来，但状态落到既有词表里的「等待部署」
    const office = modules.servers.find(s => s.id === 'srv-office');
    assert.equal(office.deployState, 'pending', '不回填凭据 ⇒ 不能继续显示「已就绪」');
    assert.equal(office.token, undefined, '凭据不回填');
    assert.equal(office.certPem, 'PEM', '公钥与注册信息保留（它不是凭据）');
    assert.deepEqual(needsAuthorization.map(item => item.id), ['srv-office'],
        '恢复后要重新授权的项目清单');
});

test('合并时未知的顶层键取本机（将来新增的凭据字段不会因为「备份里没有」被删）', () => {
    const current = { version: 1, widgets: [], servers: [], futureSecret: 'keep-me' };
    const { modules } = mergePrivateModules(current, { version: 1, widgets: [], servers: [] }, { publicModuleIds: PUBLIC_IDS });
    assert.equal(modules.futureSecret, 'keep-me');
});

// ========== 旧备份：能列出、只恢复书签 ==========

test('旧备份仍能列出；恢复时跳过配置域并明确给出原因', async () => {
    const files = new Map([
        ['/backups/nav-sylph-config-20260101-010101.json', JSON.stringify({
            version: 1, type: 'nav-sylph-config', createdAt: '2026-01-01T01:01:01Z',
            data: { theme: 'dark', categories: [] },
            checksum: crypto.createHash('sha256').update(JSON.stringify({ theme: 'dark', categories: [] })).digest('hex')
        })],
        ['/backups/nav-sylph-bookmarks-20260101-010101.html', '<DL><p><DT><A HREF="https://a.test">A</A>\n</DL><p>']
    ]);
    const { client } = recordingClient(files);
    const backup = offlineBackup({ remotePath: '/backups/' }, client);

    const listed = await backup.listBackups();
    assert.equal(listed.backups.length, 1, '旧备份仍能列出（否则用户看不见自己的历史）');
    assert.ok(listed.backups[0].configFile, '带 configFile——它只用来提示「这个域不恢复了」');

    const restored = await backup.restoreBackup({
        configFile: 'nav-sylph-config-20260101-010101.json',
        bookmarksFile: 'nav-sylph-bookmarks-20260101-010101.html'
    });
    assert.match(restored.data.bookmarksHtml, /https:\/\/a\.test/, '书签照常取回');
    assert.equal(restored.data.config, undefined, '配置域不恢复（导航/主题/引擎已不在范围内）');
    assert.deepEqual(restored.skipped.map(item => item.domain), ['admin-navigation']);
    assert.ok(restored.skipped[0].reason.includes('导航'), '给的是能给用户看的原因');

    // 旧格式（单文件）：同样只取书签
    const legacyData = { config: { theme: 'dark' }, favorites: [{ title: 'A', url: 'https://a.test' }] };
    const legacyChecksum = crypto.createHash('sha256').update(JSON.stringify(legacyData)).digest('hex');
    const legacyFiles = new Map([['/backups/nav-sylph-backup-20250101-010101.json',
        JSON.stringify({ version: 1, type: 'nav-sylph-backup', createdAt: '2025-01-01T01:01:01Z', appVersion: '1.0.0', data: legacyData, checksum: legacyChecksum })]]);
    const legacy = offlineBackup({ remotePath: '/backups/' }, recordingClient(legacyFiles).client);
    const legacyRestored = await legacy.restoreBackup({
        legacyFile: 'nav-sylph-backup-20250101-010101.json', restoreBookmarks: true
    });
    assert.equal(legacyRestored.data.config, undefined, '旧格式的配置域同样跳过');
    assert.equal(legacyRestored.data.favorites.length, 1, '书签保留');
    assert.deepEqual(legacyRestored.skipped.map(item => item.domain), ['admin-navigation']);
});

test('列表与清理接纳 memos / manifest；删自动槽位清单会清掉范围校验和', async () => {
    const files = new Map();
    const { client } = recordingClient(files);
    const backup = offlineBackup({ remotePath: '/backups/' }, client);
    for (let i = 1; i <= 7; i++) {
        files.set(`/backups/nav-sylph-memos-2026010${i}-010101.json`, JSON.stringify({ type: 'nav-sylph-memos', data: { memos: [] } }));
        files.set(`/backups/nav-sylph-manifest-2026010${i}-010101.json`, JSON.stringify({ type: 'nav-sylph-manifest', data: { included: [], skipped: [] } }));
    }
    const listed = await backup.listBackups();
    assert.equal(listed.backups.length, 7);
    assert.equal(listed.backups[0].memosFile, 'nav-sylph-memos-20260107-010101.json');
    assert.equal(listed.backups[0].manifestFile, 'nav-sylph-manifest-20260107-010101.json');

    const cleaned = await backup.cleanupOldBackups(5);
    assert.equal(cleaned.backupsRemoved, 2);
    assert.ok(!files.has('/backups/nav-sylph-memos-20260101-010101.json'), '备忘录文件随组删除');
    assert.ok(!files.has('/backups/nav-sylph-manifest-20260101-010101.json'), '清单随组删除（漏了就成孤儿）');
    assert.ok(files.has('/backups/nav-sylph-memos-20260107-010101.json'), '保留窗口内的不动');

    // 删自动槽位的清单 -> 清掉范围校验和（否则范围变了也不会重建清单）
    const auto = offlineBackup({ remotePath: '/backups/', lastAutoScopeChecksum: 'abc' }, recordingClient(new Map()).client);
    await auto.deleteBackup('nav-sylph-manifest-auto.json');
    assert.equal(auto.config.lastAutoScopeChecksum, undefined);
});

test('server.js 的载荷只取私人数据，且 memo 写入会排一次自动同步', () => {
    const fs = require('node:fs');
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

    const payloadFn = source.slice(source.indexOf('async function collectBackupPayload()'),
        source.indexOf('async function performBackup('));
    assert.ok(payloadFn.length > 200, 'collectBackupPayload 切片完整');
    // 导航配置不再进载荷：它是 #12 明确排除的域
    assert.doesNotMatch(payloadFn, /navigation\.read\('admin'\)/, '不再读管理员导航配置进备份');
    assert.match(payloadFn, /publicModuleIds: \[\.\.\.PUBLIC_MODULE_IDS\]/, '公开模块白名单参与投影');
    assert.match(payloadFn, /db\.prepare\(MEMO_LIST_SQL\)\.all\(\)\.map\(memoToClient\)/, '备忘录进载荷');
    assert.match(payloadFn, /db\.prepare\(TODO_LIST_SQL\)\.all\(\)\.map\(todoToClient\)/, '待办进载荷');

    // 备忘录与待办都在 SQLite 里，不走 writeJSON 的自动同步钩子：各四条写路由
    // 都要自己排期。排期入口是注入式的（`tests/memo.test.js` 会把这一段单独
    // 切出来在 vm 里跑，那里没有整份 server.js 的定时器机制），真实实现由
    // init() 注册。
    const memoRegion = source.slice(source.indexOf("app.post('/api/memos',"),
        source.indexOf('// ========== 微博热搜代理'));
    assert.equal((memoRegion.match(/memoWriteHook\(\);/g) || []).length, 4,
        '增/改/置顶/删 四条写路径各排一次，漏一处的表现是「改了备忘录但云端不更新」');
    assert.equal((memoRegion.match(/todoWriteHook\(\);/g) || []).length, 4,
        '待办增/改/勾选/删 四条写路径同样各排一次');
    assert.match(source, /memoWriteHook = scheduleAutoSync;/,
        '注册点在 init() 里；漏了注册的表现是四条写路由全部变成空操作');
    assert.match(source, /todoWriteHook = scheduleAutoSync;/,
        '待办的注册点也在 init() 里');

    // 恢复路由：合并模块 + 整表替换备忘录/待办
    const restoreRoute = source.slice(source.indexOf("app.post('/api/webdav/restore'"),
        source.indexOf("app.post('/api/webdav/delete'"));
    assert.match(restoreRoute, /restoreMemosFromBackup\(result\.data\.memos\)/, '备忘录写回');
    assert.match(restoreRoute, /restoreTodosFromBackup\(result\.data\.todos\)/, '待办写回');
    assert.match(restoreRoute, /needsAuthorization/, '响应里带「需重新授权」清单');
    assert.doesNotMatch(restoreRoute, /restoreConfig/, '恢复不再有配置域');
});

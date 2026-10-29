'use strict';

/**
 * #13 恢复侧的**纯函数**：模块合并与恢复计划。
 *
 * 这一份不做 HTTP、不碰盘。它钉的是「合并/计划」本身的语义——真实 HTTP 用例
 * （`tests/restore-http.test.js`）只能证明「端到端跑通了」，看不出「私有项是不是
 * 真的按顺序取备份、未知 id 是不是真的被跳过」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mergePrivateModules } = require('../lib/webdav-backup.js');
const { DOMAINS } = require('../lib/admin-lock.js');
const {
    filterUnknownModules, normalizeServerDeployment, planDigest, APPLY_ORDER
} = require('../lib/restore.js');

const PUBLIC_IDS = ['weibo-hot'];

/** 本机现场：一个公开模块项（本机保留）+ 一个私人模块项 + 一台带凭据的机器。 */
function currentModules() {
    return {
        version: 1,
        enabledModules: ['weibo-hot', 'server-monitor'],
        publicModules: ['weibo-hot'],
        widgets: [
            { id: 'weibo-hot', enabled: true, side: 'right', order: 7, collapsed: false },
            { id: 'server-monitor', enabled: true, side: 'left', order: 9, collapsed: false }
        ],
        servers: [{
            id: 'srv-home', name: '本机的名字', url: 'https://nas.test:8787', mode: 'push',
            token: { iv: 'x', data: 'y', tag: 'z' }, pushSecretHash: 'a'.repeat(64), deployState: 'ready'
        }],
        socialAccounts: ['@alice'],
        symbols: ['SYM'],
        pollInterval: 15,
        _sync: { revision: 4, receipts: {} }
    };
}

/** 备份里的模块域（已经过 #12 的白名单投影：没有凭据、没有公开项）。 */
function backupModules() {
    return {
        version: 1,
        enabledModules: ['memo', 'server-monitor'],
        widgets: [
            { id: 'memo', enabled: true, side: 'left', order: 3, collapsed: true },
            { id: 'server-monitor', enabled: true, side: 'left', order: 5, collapsed: false }
        ],
        servers: [
            // 本机已有的机器：只补布局，凭据保留本机的
            { id: 'srv-home', name: '备份里的名字', url: 'https://nas.test:8787', mode: 'push', certPem: 'PEM', deployState: 'ready' },
            // 本机没有的机器：新增，状态落到既有词表里的「等待部署」
            { id: 'srv-new', name: '备份里的新机器', url: 'https://other.test:8787', mode: 'pull', certPem: 'PEM-NEW', deployState: 'ready' },
            // 缺 certPem：连注册信息都没有 → 既有词表里的 not_deployed
            { id: 'srv-bare', url: 'https://bare.test:8787', mode: 'pull' }
        ],
        pollInterval: 30
    };
}

test('合并：公开项与相对顺序保留，私人项取备份，order 重排成紧凑序号', () => {
    const { modules } = mergePrivateModules(currentModules(), backupModules(), { publicModuleIds: PUBLIC_IDS });

    // 公开项（本机授权与布局）在最前，私人项来自备份；顺序 = 先本机公开项，再备份顺序
    assert.deepEqual(modules.widgets.map(w => w.id), ['weibo-hot', 'memo', 'server-monitor']);
    // order 紧凑：备份里剩下的空洞（3 / 5）被重排成 0..n-1
    assert.deepEqual(modules.widgets.map(w => w.order), [0, 1, 2]);
    // 公开模块的启用状态取本机（备份里根本没有它）
    assert.equal(modules.publicModules.includes('weibo-hot'), true);
    // 界面资料不在备份范围里 → 取本机，不能被「备份里没有」抹掉
    assert.deepEqual(modules.socialAccounts, ['@alice']);
    assert.deepEqual(modules.symbols, ['SYM']);
    // 启用名单：本机公开项 + 备份私人项，去重
    assert.deepEqual(modules.enabledModules, ['weibo-hot', 'memo', 'server-monitor']);
    // 采集周期取备份（它是备份范围里的私人设置）
    assert.equal(modules.pollInterval, 30);
});

test('合并：凭据不回填，缺 certPem 落到既有的 not_deployed', () => {
    // 恢复侧的归一：机器状态只由「本机有没有 certPem」决定，不看备份那台机器的观测
    const backup = normalizeServerDeployment(backupModules());
    assert.deepEqual(backup.servers.map(server => [server.id, server.deployState]), [
        ['srv-home', 'pending'], ['srv-new', 'pending'], ['srv-bare', 'not_deployed']
    ]);
    const { modules, needsAuthorization } = mergePrivateModules(currentModules(), backup, { publicModuleIds: PUBLIC_IDS });
    const byId = new Map(modules.servers.map(server => [server.id, server]));

    // 本机已有的机器：令牌与推送哈希仍是本机的（备份里没有，也不该被抹掉）
    assert.deepEqual(byId.get('srv-home').token, { iv: 'x', data: 'y', tag: 'z' });
    assert.equal(byId.get('srv-home').pushSecretHash, 'a'.repeat(64));
    // 布局字段来自备份
    assert.equal(byId.get('srv-home').name, '备份里的名字');

    // 新增的机器：没有令牌（永远是 undefined，不是空串/占位符）
    assert.equal(byId.get('srv-new').token, undefined);
    assert.equal(byId.get('srv-new').pushSecretHash, undefined);
    // 有 certPem（部署过）→ 等待重新授权；没有 certPem → 既有词表里的 not_deployed
    assert.equal(byId.get('srv-new').deployState, 'pending');
    assert.equal(byId.get('srv-bare').deployState, 'not_deployed');

    // 两台新机器都要出现在「需重新授权/重新部署」清单里，且说清原因
    const reported = needsAuthorization.map(item => item.id).sort();
    assert.deepEqual(reported, ['srv-bare', 'srv-new']);
    for (const item of needsAuthorization) assert.match(item.reason, /不随备份|重新部署/);
});

test('合并：未知模块 id 跳过并报告，不写进配置', () => {
    // 备份来自另一台装了本机没有的模块的服务器
    const backup = backupModules();
    backup.enabledModules.push('ghost-module');
    backup.widgets.push({ id: 'ghost-module', enabled: true, side: 'left', order: 6, collapsed: false });

    // 本机随包携带的实现只有这两个 + 公开白名单
    const known = new Set(['memo', 'server-monitor', ...PUBLIC_IDS]);
    const { modules: filtered, dropped } = filterUnknownModules(backup, known);

    assert.deepEqual(dropped, ['ghost-module'], '未知 id 要被报告出来');
    assert.ok(!filtered.enabledModules.includes('ghost-module'));
    assert.ok(!filtered.widgets.some(w => w.id === 'ghost-module'));

    // 过滤后合并：配置里没有幽灵模块，但已知的私人项都在
    const { modules } = mergePrivateModules(currentModules(), filtered, { publicModuleIds: PUBLIC_IDS });
    assert.deepEqual(modules.widgets.map(w => w.id), ['weibo-hot', 'memo', 'server-monitor']);
    // 机器不按模块 id 过滤（它标的是 servers[].id）
    assert.equal(filtered.servers.length, 3);
});

test('合并：当前配置里的已知私人项不会被当成未知（恢复的典型场景）', () => {
    // 恢复前本机的私人模块被清空，只剩公开项——此时「只看当前配置」会把
    // memo / server-monitor 全判成未知，恢复就变成了「什么也没恢复」。
    const wiped = {
        version: 1, enabledModules: ['weibo-hot'], publicModules: ['weibo-hot'],
        widgets: [{ id: 'weibo-hot', enabled: true, side: 'right', order: 0 }],
        servers: [], pollInterval: 15
    };
    const known = new Set(['memo', 'server-monitor', ...PUBLIC_IDS]);
    const { modules: filtered, dropped } = filterUnknownModules(backupModules(), known);
    assert.deepEqual(dropped, []);
    const { modules } = mergePrivateModules(wiped, filtered, { publicModuleIds: PUBLIC_IDS });
    assert.deepEqual(modules.widgets.map(w => w.id), ['weibo-hot', 'memo', 'server-monitor']);
});

test('planDigest：同样的计划算出同一个摘要，任何一项变了就变', () => {
    const plan = {
        domains: [{ domain: 'favorites', action: 'restore', count: 2 }],
        skipped: [],
        pendingAuthorization: [],
        unknownModules: [],
        versions: { before: { favorites: 0, modules: 1 }, after: { favorites: 1, modules: 2 } }
    };
    const digest = planDigest(plan);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(planDigest({ ...plan }), digest, '同一份计划必须同一个摘要');

    // 每一条「会影响写什么」的字段都要参与摘要，否则 409 就形同虚设
    const variants = [
        { ...plan, domains: [{ domain: 'favorites', action: 'restore', count: 3 }] },
        { ...plan, skipped: [{ domain: 'admin-navigation', reason: 'x' }] },
        { ...plan, pendingAuthorization: [{ id: 'srv-new', state: 'pending' }] },
        { ...plan, unknownModules: ['ghost-module'] },
        { ...plan, versions: { before: { favorites: 0, modules: 2 }, after: { favorites: 1, modules: 3 } } }
    ];
    const seen = new Set([digest]);
    for (const variant of variants) {
        const next = planDigest(variant);
        assert.ok(!seen.has(next), '任一字段变化都必须改变摘要');
        seen.add(next);
    }
});

test('应用顺序固定：备忘/待办/收藏在前，模块与时间线在后', () => {
    // 顺序有语义（回滚按逆序走）。钉住它，免得「顺手调整」把回滚顺序弄反。
    assert.deepEqual(APPLY_ORDER, ['memos', 'todos', 'favorites', 'modules', 'timeline']);
});

test('恢复域三处清单一致：锁 / 应用顺序 / 路由', () => {
    // admin-lock 的注释点名了漂移风险（「锁了一个、恢复了另一个」）。三处各写
    // 一份时，新增一个域只改两处是必然会发生的事——这里让它们互相校验。
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const match = /const RESTORE_DOMAINS = \[([^\]]*)\]/.exec(serverSource);
    assert.ok(match, '找到 RESTORE_DOMAINS');
    const routes = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

    assert.deepEqual([...routes].sort(), [...APPLY_ORDER].sort(), '路由域与应用顺序一致');
    for (const domain of APPLY_ORDER) {
        assert.ok(DOMAINS.includes(domain), `锁域缺少 ${domain}`);
    }
    for (const domain of DOMAINS) {
        // navigation-admin 是协调锁与版本表里的域，不属于备份恢复路由。
        if (domain === 'navigation-admin') continue;
        assert.ok(APPLY_ORDER.includes(domain), `应用顺序缺少 ${domain}`);
    }
});

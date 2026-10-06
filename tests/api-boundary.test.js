const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// server.js starts the HTTP listener when loaded, so exercise its
// projection and merge helpers directly, as backup-privacy.test.js does.
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = server.indexOf('function toPublicConfig(');
assert.ok(begin >= 0, 'public view helpers are present');

// toPublicConfig 到「获取收藏夹里的书签」这一段里，公开视图与模块平台的
// 归一化/合并助手都在内（模块平台配置段紧接在公开视图之后），
// 所以单次切片即可，不需要第二段——两段会因重复声明而 SyntaxError。
const modulesEnd = server.indexOf('// 获取收藏夹里的书签', begin);
assert.ok(modulesEnd > begin, 'projection and merge helpers are present');

const { toPublicConfig, toPublicFavorites, mergeFavorites, mergeConfig,
    normalizeModulesConfig, mergeModulesConfig } = vm.runInNewContext(
    `${server.slice(begin, modulesEnd)}; ` +
    `({ toPublicConfig, toPublicFavorites, mergeFavorites, mergeConfig,
        normalizeModulesConfig, mergeModulesConfig })`
);

function fav(id, extra = {}) {
    return { id, title: `title-${id}`, url: `https://example.com/${id}`, ...extra };
}

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

// 剥掉整行注释与块注释。源码形状断言曾因 `/* (reverted) .app.set(...) */`
// 这类「注释里提到了标识符」的写法而假绿。
function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 按**大括号配对**取出一个类方法的完整方法体。
 *
 * 不能用「下一个顶格方法定义」当结束标记：嵌套的 catch { / if { 也会匹配，
 * 方法体会被提前截断，于是断言在错误的位置通过——这类切片 bug 已经在
 * 本仓库出现过好几次（切片长度断言是它的兜底）。
 */
function methodBody(source, name) {
    const head = source.indexOf(`\n        ${name}(`) >= 0
        ? source.indexOf(`\n        ${name}(`)
        : source.indexOf(`\n        async ${name}(`);
    assert.ok(head >= 0, `${name} 存在`);
    const open = source.indexOf('{', head);
    assert.ok(open > head, `${name} 的方法体起点可定位`);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                const body = source.slice(open, i + 1);
                // 切片太短说明配对提前收口（多半是字符串里的花括号），
                // 断言会因此在空窗口里「通过」。
                assert.ok(body.length > 60, `${name} 的方法体切片长度合理（${body.length}）`);
                return body;
            }
        }
    }
    throw new Error(`${name} 的方法体没有闭合`);
}

test('the public favorites view drops private entries and the private field itself', () => {
    const view = toPublicFavorites({
        version: 1,
        favorites: [fav('a'), fav('b', { private: true }), fav('c', { private: false })]
    });

    assert.equal(view.version, 1);
    assert.deepEqual(view.favorites.map(f => f.id), ['a', 'c']);
    for (const item of view.favorites) {
        assert.equal('private' in item, false, 'public items carry no private field');
    }
    assert.equal(view.favorites.some(f => f.url === 'https://example.com/b'), false);
});

test('the public favorites view keeps a missing or malformed favorites list safe', () => {
    // vm.runInNewContext gives this realm its own Array, so compare shape not identity
    assert.equal(toPublicFavorites({}).favorites.length, 0);
    assert.equal(toPublicFavorites({ favorites: 'nope' }).favorites.length, 0);
    assert.equal(toPublicFavorites(null).favorites.length, 0);
    assert.equal(toPublicFavorites({}).version, 1);
});

test('the public config view drops privacyMode and keeps the rendered fields', () => {
    const view = toPublicConfig({
        theme: 'dark',
        searchEngine: 'google',
        privacyMode: true,
        categories: [{ id: 'c1', name: 'x', bookmarks: [] }]
    });

    assert.equal('privacyMode' in view, false);
    assert.equal(view.theme, 'dark');
    assert.equal(view.searchEngine, 'google');
    assert.equal(view.categories.length, 1);
});

test('a private favorite absent from the submitted list survives a save', () => {
    const existing = { favorites: [fav('a'), fav('secret', { private: true }), fav('c')] };
    const merged = mergeFavorites(existing, [fav('a'), fav('c')]);

    // 保留原始文件顺序，缺席的私密条目留在原位
    assert.deepEqual(merged.map(f => f.id), ['a', 'secret', 'c']);
    assert.equal(merged[1].private, true);
});

test('a public favorite absent from the submitted list is removed', () => {
    const existing = { favorites: [fav('a'), fav('b'), fav('secret', { private: true })] };
    const merged = mergeFavorites(existing, [fav('a')]);

    assert.deepEqual(merged.map(f => f.id), ['a', 'secret']);
});

test('a submitted favorite with a known id overwrites that entry in place', () => {
    const existing = { favorites: [fav('a'), fav('b')] };
    const updated = fav('b', { title: 'renamed' });
    const merged = mergeFavorites(existing, [fav('a'), updated]);

    assert.deepEqual(merged.map(f => f.id), ['a', 'b']);
    assert.equal(merged[1].title, 'renamed');
});

test('a submitted favorite without an id is appended at the end', () => {
    const existing = { favorites: [fav('a')] };
    const merged = mergeFavorites(existing, [fav('a'), { id: '', title: 'brand new' }]);

    assert.equal(merged.length, 2);
    assert.equal(merged[1].title, 'brand new');
});

test('merging keeps the original order of existing favorites', () => {
    const existing = { favorites: [fav('a'), fav('b'), fav('c')] };
    const merged = mergeFavorites(existing, [fav('c'), fav('a'), fav('b')]);

    assert.deepEqual(merged.map(f => f.id), ['a', 'b', 'c']);
});

test('merging config preserves privacyMode that the public view never carried', () => {
    const existing = { theme: 'dark', privacyMode: true };
    const submitted = { theme: 'light', categories: [] };
    const merged = mergeConfig(existing, submitted);

    assert.equal(merged.privacyMode, true, 'privacyMode survives a save from the public view');
    assert.equal(merged.theme, 'light', 'submitted fields still win');
    assert.equal(merged.categories.length, 0);
});

test('the anonymous read routes project their responses instead of sending whole files', () => {
    assert.match(server, /app\.get\('\/api\/config',[\s\S]*?res\.json\(toPublicConfig\(cfg\)\)/);
    assert.match(server, /app\.get\('\/api\/favorites',[\s\S]*?res\.json\(toPublicFavorites\(data\)\)/);
});

test('the favorites write route merges instead of overwriting the whole file', () => {
    const route = server.slice(server.indexOf("app.post('/api/favorites'"), server.indexOf("app.post('/api/favorites/import'"));
    assert.match(route, /mergeFavorites\(existing, favorites\)/);
    assert.doesNotMatch(route, /favorites: favorites\s*[,}]/, 'must not write the request body straight to disk');
});

// ========== 模块平台配置边界 ==========
// 模块配置刻意不走 config.json：那里的新 key 默认经 toPublicConfig 下发给匿名
// 用户，而 mergeConfig 是顶层浅合并、嵌套对象会被客户端旧副本整块覆盖。
// 下面几条钉住「绕开」这个决定成立，而不是钉住某一行代码。

test('模块配置不进 config.json，也不出现在匿名可见的投影里', () => {
    // toPublicConfig 仍只剥离 privacyMode——这正是模块配置必须另立文件的原因。
    // 若日后有人把模块配置搬进 config.json，这条会先失败。
    const view = toPublicConfig({
        theme: 'dark',
        privacyMode: true,
        categories: [],
        monitorServers: [{ id: 'srv_1', url: 'http://10.0.0.1' }]
    });
    assert.equal('privacyMode' in view, false);
    assert.equal(
        'monitorServers' in view, true,
        'toPublicConfig 不剥离未登记的 key —— 模块配置因此不能放进 config.json'
    );

    // 模块配置的端点必须全部是特权路由，匿名用户连「在监控哪些服务器」都不该看到。
    // 断言用「枚举全部 /api/modules 路由 → 每条都必须带守卫」而不是
    // 「排除不匹配的」：后者用负向前瞻写成会匹配到它本该排除的那段文本，
    // 于是一条都没排除掉，测试恒绿。守卫缺失时这里的数量差会暴露。
    // 切片边界用 Paste 段做锚——早先只切到「模块平台 API」标题处，
    // 新加的端点落在标题之后，切片里一条都看不到（数量断言恒为 0）。
    const routes = server.slice(server.indexOf('// ========== 模块平台 API =========='),
        server.indexOf('// ========== Paste API =========='));
    assert.ok(routes.length > 500, '模块平台段被正确切出');
    const moduleRoutes = routes.match(/app\.(?:get|post|put|delete)\('\/api\/modules[^']*'/g) || [];
    // 10 条 = 8 条既有 + trust-cert（已删）+ enroll（agent 注册）。
    // 数量必须逐条跟上：少一条是漏枚举，多一条可能是有人新加了路由却
    // 没走到下面的守卫循环——那正是本条断言存在的意义。
    assert.equal(moduleRoutes.length, 10, `模块端点应恰好 10 条，实际 ${moduleRoutes.length}`);

    // 有**两个**端点是故意不带 requireAdmin 的，理由不同但都必须具名写出，
    // 否则「给它们加上 requireAdmin」会显得像是在收紧守卫：
    //
    //  · agent-push：agent 主动上报，鉴权是推送凭据
    //  · enroll：agent 注册时还没有任何长期凭据，它的鉴权就是那枚一次性令牌。
    //    这条更要紧——它比推送更早发生，且令牌 15 分钟就过期，
    //    挂上 requireAdmin 会让「一键部署」彻底不可用。
    // 中间件名写成字符串而不是正则：要从正则的 source 里反推名字
    // （slice(1, -2)）那种做法在带字符类时会出错，而出错的表现是
    // 断言报一个看不懂的「找不到匹配」——看不出真正原因。
    const NO_ADMIN_ROUTES = {
        "app.post('/api/modules/agent-push'": {
            middleware: 'pushLimit',
            why: 'agent 没有浏览器会话，鉴权是推送凭据'
        },
        "app.post('/api/modules/enroll'": {
            middleware: 'enrollLimit',
            why: 'agent 注册时尚无任何凭据，鉴权是一次性部署令牌'
        }
    };
    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const route of moduleRoutes) {
        const exempt = NO_ADMIN_ROUTES[route];
        if (exempt) {
            assert.match(routes, new RegExp(
                escapeRe(route) + ',\\s*' + exempt.middleware + '\\b'),
                `${route} 用自己的限流桶 ${exempt.middleware}，不挂 requireAdmin（${exempt.why}）`);
            assert.doesNotMatch(routes, new RegExp(
                escapeRe(route) + '[^)]*requireAdmin'),
                `${route} 一旦挂上 requireAdmin，这条链路就废了（${exempt.why}）`);
            continue;
        }
        assert.match(routes, new RegExp(escapeRe(route) + ', rateLimit, requireAdmin,'),
            `${route} 必须走 rateLimit + requireAdmin`);
    }
    // 豁免名单里的路由必须真的存在，否则删掉端点后这条会静默通过
    for (const route of Object.keys(NO_ADMIN_ROUTES)) {
        assert.ok(moduleRoutes.includes(route), `豁免的 ${route} 确实存在`);
    }
});

test('模块配置的写入合并：请求体缺席的数组保留而非清空', () => {
    // 拖拽排序只提交 widgets；若整份覆盖，用户调一次布局就把服务器列表清空。
    //
    // 关键：必须走「归一化 → 合并」两步，不能直接调 merge。
    // 早先的版本直接喂 merge 一个部分对象，于是它恒绿——而真实路径上
    // 归一化会把缺席的键补成空数组，merge 的保留分支永远走不到，
    // 一次拖拽就把 servers 清空。这是靠真实服务端到端才发现的，
    // 不是靠读代码。
    const existing = {
        version: 1,
        enabledModules: ['server-monitor'],
        widgets: [{ id: 'server-monitor', enabled: true, side: 'left', order: 0, collapsed: false }],
        servers: [{ id: 'srv_1', name: 'NAS', url: 'http://10.0.0.1' }],
        socialAccounts: ['@someone'],
        symbols: ['BTC']
    };
    const submitted = { widgets: [{ id: 'server-monitor', enabled: true, side: 'right', order: 3 }] };

    const merged = mergeModulesConfig(existing, normalizeModulesConfig(submitted));

    assert.equal(merged.widgets[0].side, 'right', '提交的值生效');
    assert.equal(merged.widgets[0].order, 3);
    assert.equal(merged.servers.length, 1, '缺席的 servers 保留');
    assert.deepEqual([...merged.socialAccounts], ['@someone'], '缺席的 socialAccounts 保留');
    assert.deepEqual([...merged.symbols], ['BTC'], '缺席的 symbols 保留');
    assert.deepEqual([...merged.enabledModules], ['server-monitor'], '缺席的 enabledModules 保留');
});

test('模块配置区分「显式清空」与「没提交」', () => {
    const existing = { version: 1, servers: [{ id: 'srv_1', name: 'NAS', url: 'http://10.0.0.1' }] };

    // 显式提交空数组 = 用户真的删光了
    const cleared = mergeModulesConfig(existing, normalizeModulesConfig({ servers: [] }));
    assert.equal(cleared.servers.length, 0, '显式空数组是清空，不是保留');

    // 归一化不得把缺席的键补成空数组，否则两条路径无法区分
    const normalized = normalizeModulesConfig({ widgets: [] });
    assert.equal('servers' in normalized, false, '归一化不补缺席的键');
    assert.equal(normalized.servers, undefined);

    // 合并结果永远五个键齐全，读侧不必处理 undefined
    const merged = mergeModulesConfig({}, normalizeModulesConfig({}));
    for (const key of ['enabledModules', 'widgets', 'servers', 'socialAccounts', 'symbols']) {
        assert.ok(Array.isArray(merged[key]), `${key} 在合并结果里是数组`);
    }
});

test('模块配置写入端点用 mergeModulesConfig，不把请求体直接落盘', () => {
    const route = server.slice(server.indexOf("app.post('/api/modules/config'"),
        server.indexOf("app.post('/api/modules/servers'"));
    assert.match(route, /mergeModulesConfig\(existing, normalized\)/);
    assert.doesNotMatch(route, /writeJSON\(MODULES_FILE, req\.body\)/);
    assert.match(route, /normalizeModulesConfig\(req\.body\)/, '写前必须过校验闸门');
});

test('模块配置读接口不回显 token，只给 hasToken', () => {
    // 回显信封等于把密文交给浏览器——虽然解不开，但本不该有的数据不必给。
    const route = server.slice(server.indexOf("app.get('/api/modules/config'"),
        server.indexOf("app.post('/api/modules/config'"));
    assert.match(route, /hasToken:\s*isEnvelope\(token\)/, 'token 折成布尔状态');
    assert.doesNotMatch(route, /res\.json\(await readJSON\(MODULES_FILE\)\)/,
        '不能把整个配置原样回传——那会把 token 一并带出去');
});

test('保存模块配置不会抹掉已存的 token', () => {
    // 这是读接口不回显带来的必然副作用：客户端手里的 server 没有 token 字段，
    // 直接采纳请求体就会把密文清掉。症状隐蔽——服务器还在，只是开始 401。
    const existing = {
        servers: [
            { id: 'srv_1', name: 'NAS', url: 'http://a', token: { iv: 'a', data: 'b', tag: 'c' } },
            { id: 'srv_2', name: 'VPS', url: 'http://b', token: { iv: 'd', data: 'e', tag: 'f' } }
        ]
    };
    // 前端保存布局时回传的对象：只有 hasToken，没有 token
    const submitted = normalizeModulesConfig({
        widgets: [{ id: 'server-monitor', enabled: true, side: 'right', order: 0 }],
        servers: [
            { id: 'srv_1', name: 'NAS', url: 'http://a' },
            { id: 'srv_2', name: 'VPS', url: 'http://b' }
        ]
    });
    const merged = mergeModulesConfig(existing, submitted);
    assert.equal(merged.servers[0].token.data, 'b', 'srv_1 的密文被补回');
    assert.equal(merged.servers[1].token.data, 'e', 'srv_2 的密文被补回');

    // 删除一台要真的删掉——没提交就不在 incoming 里
    const afterDelete = mergeModulesConfig(existing, normalizeModulesConfig({
        servers: [{ id: 'srv_1', name: 'NAS', url: 'http://a' }]
    }));
    assert.equal(afterDelete.servers.length, 1, '未提交的服务器被移除');
    assert.equal(afterDelete.servers[0].token.data, 'b', '留下的那条 token 仍在');
});

test('服务器地址只接受 https（裸 IP 自动补协议与端口）', () => {
    // 两层防护同时存在，缺一不可：
    //   file:、gopher: 等协议会被 agent 拉取时当成一个可利用的服务端请求面；
    //   http: 会把 Bearer token（那台机器的只读监控凭据）明文摊在网络上。
    //
    // 而**裸 IP 必须接受**：「只填 IP 就行」是这个改版的核心诉求，
    // 不能只在前端成立（回归记录：前端补了 https://，服务端仍拒裸 IP，
    // 于是任何直接调 API 的路径都过不了）。
    const route = server.slice(server.indexOf("app.post('/api/modules/servers'"),
        server.indexOf("app.delete('/api/modules/servers/:id'"));
    assert.ok(route.length > 200, '切片拿到的是整条路由，不是空壳');

    // 补协议 → 再解析 → 校验协议。顺序不能反：
    // new URL('192.168.1.10') 会把 '192.168.1.10' 当成**协议名**并抛错，
    // 所以必须先补上 https:// 才能解析成功。
    //
    // 用字面量而不是正则断言这几条：`https://${rawUrl}` 里的斜杠与 $ 在
    // 正则字面量中转义极易写错，而写错的表现是**整个测试文件加载失败**、
    // 所有用例一起消失（实测踩过两次）。
    assert.ok(route.includes('rawUrl = `https://${rawUrl}`'), '裸地址补 https://');
    assert.match(route, /new URL\(rawUrl\)/, '补完再按 URL 解析');
    assert.match(route, /parsed\.protocol !== 'https:'/, '协议白名单只放 https');

    // http:// 单独判，且理由要说清是凭据问题而非「格式错」
    // 用字面量而不是正则：/^http:\/\// 的斜杠转义在正则字面量里极易写错，
    // 而写错的表现是整个测试文件加载失败、所有用例一起消失（实测踩过）。
    assert.ok(route.includes("/^http:\\/\\//i.test(rawUrl)"), 'http 单独判');
    assert.match(route, /明文传输等于把它公开/, '说清为什么必须 https');
    // ⚠️ 正向计数：整条路由里不得有第二个「放行 http」的分支。
    // 只写 doesNotMatch 会被「换个写法」绕过（实测踩过）。
    //
    // ⚠️⚠️ `[a-z]+` 匹配不到 `'https:'` —— 协议字符串带冒号。这类字符类
    // 写错的表现是**匹配数为 0**，而「0 个分支」看上去像「代码里没有这行」，
    // 很容易被误读成断言过期而不是断言写错。（本项目已犯过一次，
    // 本轮又犯了一次。）
    const allowBranches = route.match(/parsed\.protocol !== '[a-z]+:'/g) || [];
    assert.equal(allowBranches.length, 1,
        `只应有一个协议放行条件，实际 ${allowBranches.length} 个：${allowBranches.join(' | ')}`);

    assert.match(route, /res\.status\(400\)/, '不合法时 400');
    // 默认端口：不补的话请求会打到 443，而 agent 听 4195
    assert.match(route, /parsed\.port = '4195'/, '没写端口就补 4195');
    // 落盘必须是归一化后的地址
    assert.match(route, /url: normalizedUrl/, '落盘归一化后的地址');
    // 迁移指引不得指向已删除的 --gen-cert（证书现在由 Go agent 自签）
    assert.doesNotMatch(route, /--gen-cert/, '不再指向已删除的 --gen-cert');
});


test('服务器写端点对 token 只加密、不落明文', () => {
    const route = server.slice(server.indexOf("app.post('/api/modules/servers'"),
        server.indexOf("app.delete('/api/modules/servers/:id'"));
    // 提交了 token 才加密；空值表示保持原值
    assert.match(route, /entry\.token\s*=\s*encrypt\(token\.trim\(\),\s*passwordHash,\s*'modules'\)/,
        'token 经服务端加密后落盘');
    assert.match(route, /entry\.token\s*=\s*servers\[index\]\.token/, '编辑时默认沿用原密文');
});

test('多服务器采集：一台离线不影响其它台', () => {
    const fn = server.slice(server.indexOf('async function collectAllServers('),
        server.indexOf("app.get('/api/modules/metrics'"));
    assert.match(fn, /Promise\.all\(servers\.map/, '目标机并发拉取，串行会让耗时累加');
    assert.match(fn, /isLocal:\s*true/, '本机固定排第一');
    assert.match(fn, /online:\s*false/, '失败的一台标记为离线而不是抛错');
    // 凭据解不开要与「服务器离线」区分开
    assert.match(server, /凭据无法解密，请重新输入 token/,
        '解不开凭据要给出可操作的原因，不能与离线混为一谈');
});

test('模块配置的归一化丢弃非法条目，而不是把它们写进配置', () => {
    // 这些字段都会变成对外的轮询目标或脚本路径，必须逐条过闸门
    const out = normalizeModulesConfig({
        enabledModules: ['server-monitor', '../../etc/passwd', 'BAD ID', 'server-monitor'],
        widgets: [
            { id: 'server-monitor', side: 'middle', order: 'x', enabled: false },
            { side: 'left' },                       // 无 id，丢弃
            null
        ],
        servers: [
            { id: 'srv_1', name: '  NAS  ', url: ' http://10.0.0.1 ' },
            { id: 'srv_2' },                        // 无 url，丢弃
            { id: 'srv_3', url: 'http://x', token: 'secret' }   // token 不在白名单内
        ]
    });

    // enabledModules 会拼进脚本路径，白名单必须挡住路径穿越
    assert.deepEqual([...out.enabledModules], ['server-monitor'], '路径穿越与重复项都被挡掉');
    assert.equal(out.widgets.length, 1, '缺 id 的条目被丢弃');
    assert.equal(out.widgets[0].side, 'left', '非法 side 回落到 left');
    assert.equal(out.widgets[0].enabled, false, '显式 false 保留');
    assert.equal(out.widgets[0].order, 0, '非数字 order 回落到 0');
    assert.equal(out.servers.length, 2);
    assert.equal(out.servers[0].name, 'NAS', '字符串两端空白被裁掉');
    assert.equal(out.servers[0].url, 'http://10.0.0.1');
    assert.equal('token' in out.servers[1], false, '白名单外的字段不进配置');
});

test('模块配置的归一化拒绝根本不是对象的请求体', () => {
    // 返回 null 会让路由回 400；返回对象等于放行畸形输入
    for (const bad of [null, undefined, 'string', 42, []]) {
        assert.equal(normalizeModulesConfig(bad), null, `拒绝 ${JSON.stringify(bad)}`);
    }
    // 字段类型不对时归一化到空数组，而不是把对象当数组用
    const out = normalizeModulesConfig({ widgets: 'nope', servers: { a: 1 } });
    assert.deepEqual([...out.widgets], []);
    assert.deepEqual([...out.servers], []);
});

// ========== 前端登录态钩子 ==========

test('每一处写入登录态的地方都同步模块区的显隐', () => {
    // 修复前：只有 restoreSession（首屏探测）调了 syncModuleVisibility。
    // 但页面内通过密码框登录（openAdmin）是另一条路径，它设了
    // authenticated = true 却不触发模块加载——于是「密码正确、已进入管理」，
    // 首页模块区仍是空的、「布局」按钮也不出现。改密码那条路径同理，
    // 会话已全部销毁却仍亮着模块入口。
    //
    // 断言用「枚举全部写入点 → 每个都必须在同一段里同步显隐」而不是
    // 「搜一下有没有调用」：新增写入点时数量差会把它暴露出来。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const stripped = appSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const lines = stripped.split('\n');

    // 逐行扫，而不是用一个大正则配 1200 字符窗口：窗口会跨过方法边界，
    // 把下一个方法体里的内容误算进当前写入点的「邻近区域」，
    // 断言就成了看运气。逐行的邻近范围是确定的。
    const hits = [];
    lines.forEach((line, i) => {
        const m = /this\.authenticated\s*=\s*(true|false)\s*;/.exec(line);
        if (m) hits.push({ line: i + 1, value: m[1] });
    });

    // constructor 的初始值不算「登录态变化」，其余每一处都必须同步显隐。
    // 按「第一条」而不是行号阈值来排除：类字段每加一行，constructor 就往下
    // 漂一行，写死的 >120 会被直接跨过去（加 13 行外观常量后它从 L114 到 L127，
    // 于是 constructor 被误算成第 5 处切换点）。顺序才是这里的语义。
    assert.equal(hits[0]?.value, 'false', '第一条是 constructor 里的初始值');
    const transitions = hits.slice(1);
    assert.equal(transitions.length, 4,
        `登录态切换应恰好 4 处（首屏探测 / 页面内登录 / 登出 / 改密后失效），实际 ${transitions.length}：`
        + transitions.map(h => `L${h.line}=${h.value}`).join(', '));

    for (const t of transitions) {
        // 往后 30 行内必须出现同步调用
        const after = lines.slice(t.line - 1, t.line + 30).join('\n');
        assert.match(after, /syncModuleVisibility\(\)/,
            `L${t.line} 写入 authenticated = ${t.value} 后必须同步模块区显隐`);
    }

    // 登录成功那两处还要把外观交回服务端。未登录访客的选择存在本机
    // （localStorage，见 resolveTheme 的优先级），登录后它必须让位，
    // 否则「本机覆盖」会一直压过站点主题——同样是这类「一处写了、
    // 另一处忘了」的缺陷，所以按枚举断言而不是搜一下有没有调用。
    const logins = transitions.filter(t => t.value === 'true');
    assert.equal(logins.length, 2, '写入 true 的地方是两处（首屏探测 / 页面内登录）');
    for (const t of logins) {
        const after = lines.slice(t.line - 1, t.line + 30).join('\n');
        assert.match(after, /adoptServerTheme\(\)/,
            `L${t.line} 登录成功后必须把外观交回服务端（清掉本机覆盖）`);
    }
});

test('模块区在未登录时不发起任何请求', () => {
    // 首屏不因模块变重：未登录访客不下载任何模块文件。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const zoneStart = appSource.indexOf('async renderModuleZone()');
    const zoneEnd = appSource.indexOf('async mountModule(', zoneStart);
    assert.ok(zoneStart >= 0 && zoneEnd > zoneStart, 'renderModuleZone 存在');
    const body = appSource.slice(zoneStart, zoneEnd);

    // 未登录分支必须在拉配置之前就 return
    const unauthAt = body.indexOf('if (!this.authenticated)');
    const loadAt = body.indexOf('loadModulesConfig()');
    assert.ok(unauthAt >= 0, 'renderModuleZone 有未登录分支');
    assert.ok(unauthAt < loadAt, '未登录分支在拉配置之前返回');
});

test('mountModule 先加载脚本再取定义', () => {
    // 修复前：先 getModule 再 loadModule，于是首次进入时模块必然显示
    // 「模块未注册」——脚本其实加载成功了，只是注册发生在检查之后。
    // 这条只有真实浏览器能看出来：单元测试里注册表是空的，
    // 而错误态与正常态都渲染成同一个 .module-widget 外壳。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const start = appSource.indexOf('async mountModule(');
    assert.ok(start >= 0, 'mountModule 存在');
    const body = appSource.slice(start, start + 1600);

    // 判据是「拿到的定义」而不是「加载调用」的位置：
    // 正确写法是 if (!this.getModule(id)) await this.loadModule(id)，
    // 即第一次查询命中空值、随后的加载补上注册，第二次查询才拿到定义。
    // 要钉的是**第二次**查询在加载之后。
    const guardAt = body.indexOf('if (!this.getModule(id))');
    const loadAt = body.indexOf('loadModule(id)');
    const defAt = body.indexOf('const def = this.getModule(id)');
    assert.ok(guardAt >= 0 && loadAt >= 0 && defAt >= 0, 'mountModule 同时有守卫、加载与取值');
    assert.ok(guardAt < loadAt, '先确认未注册，再加载');
    assert.ok(loadAt < defAt, '加载之后才取定义用于挂载');
    assert.match(body.slice(defAt, defAt + 300), /if \(!def\)/, '定义仍为空时要 render 出错误态');
});

test('模块分区按「是否已渲染」判定，不按「配置是否已加载」', () => {
    // 修复前：条件是 !this.modulesConfig。但首页模块区早就拉过配置，
    // 于是切到模块分区时条件为假、什么都不做，面板永远停在「加载中...」。
    // 这类判据错误只有真机点进去才看得见：接口 200、配置也在内存里。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const start = appSource.indexOf('selectAdminTab(panel)');
    assert.ok(start >= 0, 'selectAdminTab 存在');
    const body = appSource.slice(start, start + 1400);

    assert.match(body, /panel === 'modules' && !this\.modulesEditorRendered/,
        '判据必须是 modulesEditorRendered，而不是 modulesConfig');
    assert.doesNotMatch(body, /panel === 'modules' && !this\.modulesConfig/,
        'modulesConfig 会被首页提前填满，用它当条件会让分区永不加载');

    // 面板 DOM 每次 openAdmin 都是新的，标志必须复位。
    // 切片必须覆盖整个 renderAdminPanel 方法体（约 14k 字符）：
    // 早先切到 toggleSection 之前，而复位在 ~14288 处被切在外面，
    // 于是变异「删掉复位」后测试仍绿——护栏自己失效了。
    const panelStart = appSource.indexOf('renderAdminPanel() {');
    assert.ok(panelStart >= 0, 'renderAdminPanel 存在');
    // 方法体结束：下一个顶格方法定义（8 空格缩进的 `name(` 或空行+缩进）
    const rest = appSource.slice(panelStart + 20);
    const nextMethod = rest.search(/\n        [a-zA-Z_$][\w$]*\s*\(/);
    assert.ok(nextMethod > 0, 'renderAdminPanel 的结束位置可定位');
    const panel = appSource.slice(panelStart, panelStart + 20 + nextMethod);
    assert.match(panel, /this\.modulesEditorRendered = false/,
        'renderAdminPanel 必须复位 modulesEditorRendered');
});

test('拖拽把手不由模块自己写 hidden 属性', () => {
    // 修复前：模块在 mountWidget 里写 handle.hidden = !state.editLayout。
    // 挂载时 editLayout 几乎总是 false，而 hidden 属性压过任何 CSS——
    // 于是进编辑模式后把手仍是 0x0、点不到。显隐交给平台的
    // .module-zone.is-editing 规则，模块不得再写 hidden。
    const modPath = path.join(__dirname, '..', 'public', 'modules', 'server-monitor.js');
    const mod = fs.readFileSync(modPath, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    assert.doesNotMatch(mod, /handle\.hidden\s*=/,
        '拖拽把手的显隐由 .module-zone.is-editing 控制，模块不得写 hidden 属性');

    // 反面：平台侧那条规则必须还在
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
    assert.match(css, /\.module-zone\.is-editing \.module-drag-handle\s*\{[^}]*display:\s*block/,
        '平台侧必须有让把手在编辑模式显示的规则');
});

test('拖拽不落盘：布局是草稿，由「保存编辑」统一提交', () => {
    // 改动前：commitWidgetDrag 末尾直接 await saveWidgetLayout(snapshot)，
    // 也就是松手即存。改成草稿后，模块布局与首页书签在同一次提交里落盘。
    // 反向断言：只要这个函数里还有任何一次网络提交，草稿语义就已经破了。
    const body = methodBody(appSource, 'commitWidgetDrag');
    assert.doesNotMatch(body, /saveWidgetLayout\s*\(/,
        'commitWidgetDrag 不得落盘——落盘只发生在保存编辑时');
    assert.doesNotMatch(body, /API\.post|API\.request|fetch\s*\(/,
        'commitWidgetDrag 不得发任何请求');
    // 但必须仍然重排：applyWidgetLayout 按刚写入内存的 order 排序，
    // 漏掉它的症状是「宽屏卡片停在原处」，落盘正确而界面不动。
    assert.match(body, /applyWidgetLayout\s*\(\s*\)/,
        'commitWidgetDrag 仍需按新顺序重排 DOM');
});

/**
 * 把一个类方法变成可独立执行的函数。
 *
 * methodBody 返回的是**从 `{` 开始**的方法体，不含方法签名，所以这里
 * 不能靠替换签名来造函数——直接 `(function(){ <方法体> }).call(this)`。
 * 方法体只依赖 `this`、API 与 console，全部作为形参注入。
 */
function runMethod(source, name, thisArg, { API = {}, console: log = console } = {}) {
    const body = methodBody(source, name);
    // 用 with 之外的显式形参：方法体里的自由变量只有 API 与 console
    const factory = vm.runInNewContext(
        `(function(API, console){ return async function(){ ${body} }; })`,
        { console: log }
    );
    return factory(API, log).call(thisArg);
}

test('保存编辑一次提交两套存储，且布局失败即中止', () => {
    // 两套存储是两个文件，没有跨文件事务。串行 + 前者失败即中止，
    // 把最坏情况收敛成「只有布局变了」，而不是并发后两者状态不确定。
    //
    // 这里**执行**该方法，而不是在源码里找字符串位置。早先那版断言的是
    // `configAt > widgetsAt` 这类下标关系，把整个 `if (this.modulesConfig)`
    // 改成 `if (false)` 后——布局那次提交根本不发生，而被它删掉的位置只剩
    // 一个 `;`，`saveWidgetLayout(`、`'/api/config'`、`try {` 这些字符串
    // 仍在切片里，下标关系原样成立。位置断言在原理上无法区分
    // 「这段代码在控制流里」与「这段文本在切片里」。
    const calls = [];
    let widgetSaveSucceeds = true;
    const makeApp = () => ({
        editSession: { config: { a: 1 }, widgets: [{ id: 'w1' }] },
        modulesConfig: { widgets: [{ id: 'w1', order: 0 }] },
        config: { a: 1 },
        saveWidgetLayout: async () => { calls.push('modules'); return widgetSaveSucceeds; },
        rollbackEditSession: () => calls.push('rollback'),
        exitEditLayout: () => calls.push('exit'),
        showToast: (m, s) => calls.push(`toast:${s === undefined ? '(默认)' : s}`)
    });
    const API = { post: (url) => { calls.push(url); return Promise.resolve({ success: true }); } };

    return (async () => {
        // 布局成功 → 两次提交都发生，顺序为布局先、书签后
        calls.length = 0;
        widgetSaveSucceeds = true;
        const ok = makeApp();
        await runMethod(appSource, 'saveEditSession', ok, { API });
        assert.deepEqual(calls, ['modules', '/api/config', 'exit', 'toast:(默认)'],
            '布局成功后串行提交书签，随后退出编辑态并提示「已保存」');
        assert.equal(ok.editSession, null, '成功后清空 editSession');

        // 布局失败 → 只提交布局，书签那次**不发生**，并回滚退出
        calls.length = 0;
        widgetSaveSucceeds = false;
        await runMethod(appSource, 'saveEditSession', makeApp(), { API });
        assert.deepEqual(calls, ['modules', 'rollback', 'exit'],
            '布局失败必须中止：书签不提交、草稿回滚、退出编辑态');
        // 提示由 saveWidgetLayout 发出（真实实现里是「布局保存失败，已还原」），
        // 所以这里不重复断言 toast——它属于被调方，不属于本方法的职责。
    })();
});

test('保存编辑传给 saveWidgetLayout 的是对象而不是裸数组', () => {
    // 形状缺陷（审查抓到的真缺陷）：saveWidgetLayout 的回滚分支读
    // `snapshot.widgets`。传裸数组会让它变 undefined，.map 抛 TypeError——
    // 而那个异常从 catch 块内部抛出，会穿透两层 try/catch，
    // 于是回滚、退出、提示一行都不执行，只留下改坏了的 widgets。
    //
    // 断言的是**实际传出去的值**，不是源码里有没有 `widgets:` 字样。
    let received;
    const app = {
        editSession: { config: {}, widgets: [{ id: 'w1' }, { id: 'w2' }] },
        modulesConfig: { widgets: [{ id: 'w1' }] },
        config: {},
        saveWidgetLayout: async (snapshot) => { received = snapshot; return true; },
        rollbackEditSession: () => {}, exitEditLayout: () => {}, showToast: () => {}
    };
    const API = { post: () => Promise.resolve({ success: true }) };

    return runMethod(appSource, 'saveEditSession', app, { API }).then(() => {
        assert.ok(received && typeof received === 'object' && !Array.isArray(received),
            'snapshot 必须是对象——回滚分支读 snapshot.widgets');
        assert.ok(Array.isArray(received.widgets),
            'snapshot.widgets 必须是数组，否则回滚时 .map 直接抛');
        assert.equal(received.widgets.length, 2, '快照内容来自 editSession.widgets');
    });
});

test('saveWidgetLayout 的回滚分支读到的形状，与调用方传入的一致', () => {
    // 上一条断言的是「调用方传对了」，这条反过来钉住「被调方怎么读」——
    // 两侧必须用同一个字段名，否则其中一侧改了另一侧不会察觉。
    const body = methodBody(appSource, 'saveWidgetLayout');
    assert.match(body, /snapshot\.widgets\.map\(/,
        'saveWidgetLayout 的回滚读 snapshot.widgets');
    assert.match(body, /if \(snapshot\)/,
        'snapshot 允许缺省（调用方可能没有草稿快照）');
});

test('drop 落在分类之外时必须先守卫再解引用', () => {
    // 真缺陷：原写法把 `if (toCat >= 0)` 放在求值之后，
    // 「＋ 添加分类」按钮与网格间隙都在任一 .category 之外 →
    // closest 返回 null → categories[-1] 是 undefined → .bookmarks 抛
    // TypeError。异常从监听器抛出，dragKind 的清理不执行，拖拽状态卡住。
    //
    // 断言的是**相对顺序**：守卫语句必须排在解引用之前。
    const body = methodBody(appSource, 'bindGridEdit');
    const guardAt = body.indexOf('if (toCat < 0)');
    const derefAt = body.indexOf('this.config.categories[toCat].bookmarks.length');
    assert.ok(guardAt >= 0, '有 toCat < 0 的守卫');
    assert.ok(derefAt > guardAt,
        '守卫必须排在 categories[toCat] 解引用之前——否则 closest 返回 null 时抛');
    // 且放弃时要清掉拖拽状态，否则下一次 dragover 仍认为在拖拽
    const bail = body.slice(guardAt, body.indexOf('}', guardAt));
    assert.match(bail, /dragKind = null/, '提前返回前要清 dragKind');
    assert.match(bail, /dragFrom = null/, '提前返回前要清 dragFrom');
});

test('编辑态下按下与松手的形变都被中和', () => {
    // bindBookmarkPress 在 pointerdown 就加 .is-pressed 并保留 135ms。
    // 只中和 :hover 的话，松手后的那一小段里抬升+缩放照旧出现——
    // 而「卡片在拖拽时浮起来」正是这条规则要避免的。
    // ⚠️ 钉「每个状态都被覆盖」而不是某一条规则的写法：触摸端那轮把这几个
    // 选择器并进了一条共享规则（少一条重复声明），断言硬钉原来的
    // 「:active 与 .is-pressed 同在一个 {}」就会把正确改动判红。
    const code = stripComments(stylesCss);
    // ⚠️ 必须**枚举全部**匹配再挑，不能取第一个：`.grid.is-editing .bookmark`
    // 的第一个匹配是基础态那条（cursor / user-select），变换中和在第二条。
    // 用单次 exec 拿到基础态，断言读起来像「代码没中和」。
    const rules = [...code.matchAll(/\.grid\.is-editing [^{]*\.bookmark[^{]*\{([^}]*)\}/g)]
        .map(m => ({ selector: m[0].slice(0, m[0].indexOf('{')).trim(), body: m[1] }));
    assert.ok(rules.length >= 2, `编辑态书签卡有多条规则（实际 ${rules.length}）`);
    // 逐个状态找：要求 hover、:active、.is-pressed 都被某条规则覆盖，且那条置 none
    for (const state of ['.bookmark:hover', '.bookmark:active', '.bookmark.is-pressed']) {
        const owner = rules.find(r => r.selector.includes(state));
        assert.ok(owner, `${state} 在编辑态有规则`);
        assert.match(owner.body, /transform:\s*none/,
            `${state} 必须置 transform: none（否则拖动时卡片浮起来）`);
    }
});

test('＋占位卡不保留真实卡的实体投影', () => {
    // .bookmark 带 --bookmark-idle-shadow（内含 --shadow）。虚线占位卡
    // 带着它会比真实卡更重，与「占位」的视觉约定相反。
    const code = stripComments(stylesCss);
    const rule = /\.bookmark-add\s*,\s*\.category-add\s*\{([^}]*)\}/.exec(code);
    assert.ok(rule, '存在 ＋卡片的共享规则');
    assert.match(rule[1], /box-shadow:\s*none/, '＋卡片清掉 box-shadow');
});

test('网格编辑态标志在构造函数里显式初始化', () => {
    // syncEditLayoutUI 靠 `this._gridEditing !== editing` 判断「状态真的翻转了」。
    // 靠 undefined !== false 成立纯属巧合，而这条判断被 architecture.md
    // 列为「必须保持的性质」之一——一条性质不该依赖未声明字段的隐式初值。
    const body = methodBody(appSource, 'init');
    assert.ok(body.indexOf('_gridEditing') < 0,
        'init 负责调用，别把初始化塞进它');
    assert.match(appSource, /this\._gridEditing = false;/,
        '_gridEditing 在构造函数里显式初始化');
});

test('toggleEditLayout 不接受 force 参数', () => {
    // 退出与放弃的后果完全不同（一个提交、一个丢弃），不该由布尔量隐式决定。
    // 保留 force 会让后来者以为 toggleEditLayout(false) 能静默退出。
    const head = appSource.slice(
        appSource.indexOf('async toggleEditLayout('),
        appSource.indexOf('async toggleEditLayout(') + 60);
    assert.match(head, /async toggleEditLayout\(\s*\)/, '签名里没有 force');
    // 先剥注释：JSDoc 里正正写着 `toggleEditLayout(false)` 这句话，
    // 直接扫源码会被自己的文档命中——本仓库反复栽过的那个坑。
    assert.doesNotMatch(stripComments(appSource), /toggleEditLayout\((true|false|force)/,
        '没有任何调用方传参——退出与放弃是两个不同的方法');
});

test('放弃编辑只在真有改动时确认，无改动直接退出', () => {
    // 未登录或未改动时不该弹「放弃编辑」——那会让 Esc 变成一个总是要确认的键。
    const body = methodBody(appSource, 'cancelEditSession');
    const changedAt = body.indexOf('JSON.stringify(this.config)');
    const confirmAt = body.indexOf('confirmAction(');
    assert.ok(changedAt >= 0, '要先比对快照判断有无改动');
    assert.ok(confirmAt > changedAt,
        '确认框必须在改动比对之后——无改动时不该问用户');
    assert.match(body, /rollbackEditSession\s*\(\s*\)/,
        '放弃时要把两套存储都还原回草稿快照');
});

test('模块区拖拽：宽屏下松手即改 order 后立即重排', () => {
    // 保留自 orderOf 排序所需的「写 order → 重排」这一段：
    // applyWidgetLayout 按 widgets[i].order 排序，先重排会按旧 order
    // 把拖拽结果撤销（实测拖 NAS 到本机位置，松手又弹回原样）。
    const body = methodBody(appSource, 'commitWidgetDrag');
    const orderAt = body.indexOf('item.order = index');
    const layoutAt = body.indexOf('applyWidgetLayout');
    assert.ok(orderAt >= 0, 'commitWidgetDrag 按 DOM 顺序写 order');
    assert.ok(layoutAt > orderAt,
        '重排必须在写完 order 之后');
});

test('管理分区记住当前分区，重渲染后恢复而不是弹回第一个', () => {
    // 后台分区切换：收藏管理器现在渲染在「收藏夹」tab 内的 #favManagerHost，
    // 不再整块替换 #modalBody。那里若固定选中第一个 tab，从别的分区切回
    // 收藏夹就会被弹到「首页导航」。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(appSource, /selectAdminTab\(panel\)\s*\{[\s\S]*?this\.adminTab\s*=\s*panel/,
        'selectAdminTab 必须记住当前分区');
    assert.match(appSource, /this\.selectAdminTab\(this\.adminTab \|\| 'site'\)/,
        'renderAdminPanel 恢复上次分区，无记录时才回落到默认');

    // 默认分区只能是 site，且模板里不能有任何一个 aria-selected="true"
    const panelStart = appSource.indexOf('renderAdminPanel() {');
    const rest = appSource.slice(panelStart);
    const panelEnd = rest.search(/\n        [a-zA-Z_$][\w$]*\s*\(/);
    const template = rest.slice(0, panelEnd > 0 ? panelEnd : 12000);
    assert.doesNotMatch(template, /aria-selected="true"/,
        '模板里不得硬编码选中的 tab——选中态由 selectAdminTab 统一写入');
});

test('模块分区的说明文字紧贴它描述的那一行，不汇总在区块底部', () => {
    // 早先是「启用后该模块会出现在首页模块区…」一句放在所有开关下面，
    // 离得太远，要来回对照才知道说的是哪个模块。
    // 现在每行自带 summary，紧贴名称；状态文字紧贴开关。
    //
    // 每行的标记在 **rows 的 map 里**（@1042 起），不在 host.innerHTML 模板里
    // （模板只插 `${rows}`）。只切模板会一个都找不到——这里切整个方法体。
    //
    // 方法边界不能用「下一个顶格方法定义」找：内部有一个 catch 块，
    // `console.warn(...)` 之后换行的形式会误判成新方法，把切片截在 ~489 处。
    // 改用「下一处同缩进的 `}` 」——方法体结束就是它。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    // ⚠️ `renderModulesEditorContent(` 会同时命中**调用处**与**定义处**，
    // 而调用处后面紧跟的就是别的东西 —— 切片只有几百字符、四个标记全 -1，
    // 失败信息却显示成「说明与开关不在同一行」，完全指不到真正的原因。
    // 用带参数的定义形态定位：定义才有签名。
    const defRe = /\n        renderModulesEditorContent\(host, config\) \{/;
    const m = defRe.exec(appSource);
    assert.ok(m, '找到 renderModulesEditorContent 的定义（含签名）');
    const start = m.index;
    const rest = appSource.slice(start);
    // 方法体结束 = 下一个同缩进的方法定义。
    //
    // ⚠️ 也不能用局部变量名当锚点（如曾经的 `const status =`）：
    // 「保存模块配置」按钮被删掉后变量消失，`indexOf` 返回 -1，
    // `slice(0, -1)` 变成「除最后一个字符外的全部」——看起来有内容，
    // 实际覆盖了后面整个文件。
    const next = rest.slice(1).search(/\n        (?:async )?[a-zA-Z_][\w$]*\(/);
    const body = next > 0 ? rest.slice(0, next + 1) : rest;
    assert.ok(body.length > 500, `切出方法体（${body.length}）`);
    for (const marker of ['module-setting-label', 'module-setting-hint',
        'module-setting-toggle', 'module-setting-state']) {
        assert.ok(body.includes(marker), `切片内含 ${marker}`);
    }

    // 每行：名称 + 可选说明 + 开关 + 状态文字，四者同在一条 setting-row 里
    assert.match(body, /module-setting-label[\s\S]*?module-setting-hint[\s\S]*?module-setting-toggle[\s\S]*?module-setting-state/,
        '说明与开关在同一行内依次出现');
    // 说明文字取自模块自己的 summary，不是硬编码的一句话
    assert.match(body, /def\.summary\s*\?/, '说明文字由各模块的 summary 提供，便于后续模块复用同一形状');

    // 汇总式的那句提示不该再出现在**可执行代码**里。
    // 必须剥注释再查：解释这次改动的注释里正写着那句话本身，
    // 不剥的话断言会把自己的说明当成违规代码。
    const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.doesNotMatch(codeOnly, /启用后该模块会出现在首页模块区/,
        '汇总提示已被每行 summary 取代（注释里的历史说明不算）');

    // 状态文字必须随开关同步，否则紧贴开关的两者会互相矛盾
    assert.match(body, /box\.checked\s*\?\s*'已启用'\s*:\s*'未启用'/, '状态文字随开关切换');
    assert.match(body, /addEventListener\('change'/, 'change 事件里同步状态文字');
});

test('模块列表行不再有「启用状态」区块标题', () => {
    // 标题已由每行的名称与状态文字取代——一行一个模块，
    // 再加一个统称反而不知道它在统称什么。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const start = appSource.indexOf('renderModulesEditorContent(');
    const rest = appSource.slice(start);
    const tplStart = rest.indexOf('host.innerHTML = `');
    const tplEnd = rest.indexOf('`;', tplStart);
    const tpl = rest.slice(tplStart, tplEnd);
    assert.doesNotMatch(tpl, /启用状态/, '模块列表不再有「启用状态」标题');
});

test('模块列表行不再有「启用状态」区块标题', () => {
    // 标题已由每行的名称与状态文字取代——一行一个模块，
    // 再加一个统称反而不知道它在统称什么。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const start = appSource.indexOf('renderModulesEditorContent(');
    const rest = appSource.slice(start);
    const tplStart = rest.indexOf('host.innerHTML = `');
    const tplEnd = rest.indexOf('`;', tplStart);
    const tpl = rest.slice(tplStart, tplEnd);
    assert.doesNotMatch(tpl, /启用状态/,
        '模块列表不再有「启用状态」标题');
});

test('拖拽终止监听挂在 window 且同时处理 pointercancel', () => {
    // 挂在元素上用 { once:true } 会在指针于元素外释放时永久卡住状态
    // （分享编辑器的 auto-grow 曾这样冻结整个会话）。
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const start = appSource.indexOf('beginWidgetDrag(event, widget)');
    assert.ok(start >= 0, 'beginWidgetDrag 存在');
    // 窗口要够大：三个 addEventListener 落在 ~1825–1941 处，
    // 早先的 1800 字符窗口正好把它们切在外面，读起来像「监听没挂 window」。
    const body = appSource.slice(start, start + 2600);

    // ⚠️ 反向断言：move 必须**被注册**。改动前这里只有 removeEventListener，
    // 于是模块拖拽按下不跟随、松手回原位，而本用例全绿——
    // 它断言的是「监听挂在 window 且能解绑」，恰好跳过了「要先注册」。
    // 注册与解绑成对出现，所以断言数必须相等，不是「至少有一个」。
    assert.match(body, /window\.addEventListener\('pointerup', settle\)/, 'pointerup 挂 window');
    assert.match(body, /window\.addEventListener\('pointercancel', settle\)/, 'pointercancel 也要挂');
    assert.match(body, /removeEventListener\('pointerup', settle\)/, 'pointerup 要解绑');
    assert.match(body, /removeEventListener\('pointercancel', settle\)/, 'pointercancel 要解绑');
    assert.match(body, /removeEventListener\('pointermove', move\)/, 'pointermove 也必须解绑，否则拖拽后事件持续累积');
    assert.match(body, /window\.addEventListener\('pointermove', move\)/,
        'pointermove 必须注册——没有它整个模块拖拽只按下不跟随');
});

test('模块拖拽的注册与解绑数量相等', () => {
    // 上面那条断言的是「文本出现过」。这里钉住**配对**这个性质：
    // add 与 remove 数量相同，删掉任一个都会红。
    // ⚠️ 钉「相等」而不是「恰好 3」：将来加一个正确的终止监听
    // （例如 lostpointercapture，architecture.md 主张 pointerup/pointercancel
    // 是主路径、capture 只是双保险），add 与 remove 会同时 +1，
    // 写死 3 会把正确改动判红——那条测试不该让人不敢修。
    const start = appSource.indexOf('beginWidgetDrag(event, widget)');
    const body = appSource.slice(start, start + 2600);
    const adds = (body.match(/addEventListener\('(pointermove|pointerup|pointercancel)'/g) || []).length;
    const removes = (body.match(/removeEventListener\('(pointermove|pointerup|pointercancel)'/g) || []).length;
    assert.ok(adds >= 3, `三个 pointer 监听都要注册（实际 ${adds}）`);
    assert.equal(adds, removes, `注册与解绑必须成对（add ${adds} / remove ${removes}）`);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const swSource = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const weiboSrc = fs.readFileSync(path.join(ROOT, 'public', 'modules', 'weibo-hot.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

/** 去注释后再匹配，避免注释里的字符串把形状断言骗过。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

// ========== 接线 ==========

test('KNOWN_MODULES 收编 weibo-hot，模块文件存在且经 registerModule 注册', () => {
    assert.match(appSource, /static KNOWN_MODULES = \[[^\]]*'weibo-hot'/,
        '白名单不含 it 的话 loadModule 会直接拒绝加载');
    assert.match(weiboSrc, /window\.app\.registerModule\(\{/);
    assert.match(weiboSrc, /id: 'weibo-hot'/);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'modules', 'weibo-hot.js')));
});

test('sw.js 预缓存 weibo-hot.js，且 CACHE 与注释里最新的一级一致', () => {
    assert.match(swSource, /'\/modules\/weibo-hot\.js'/,
        '延后加载也要预缓存：否则回访用户每次打开模块区都要走一次网络');

    const cache = swSource.match(/const CACHE = '([^']+)'/)[1];
    const versions = [...swSource.matchAll(/nav-v(\d+)/g)].map(m => Number(m[1]));
    const newest = Math.max(...versions);
    assert.equal(cache, `nav-v${newest}`,
        `CACHE ${cache} 必须等于注释里记录的最新版本 nav-v${newest}——改了 public/ 不升缓存名，老用户拿不到`);
});

// ========== 平台边界 ==========

test('模块只用平台注入的 api 对象，不引用 app.js 内部的裸标识符', () => {
    const code = stripComments(weiboSrc);
    // app.js 的 API 是 IIFE 内部的 const，不是全局——写裸 API. 时
    // node --check 与任何形状断言都过得去，只有真在浏览器里跑起来才 ReferenceError。
    assert.doesNotMatch(code, /\bAPI\./, '不得出现裸 API. 调用');
    assert.match(code, /api = \(state && state\.api\)/, 'API 对象必须从 mountWidget 的 state 注入');
    assert.match(code, /api = null;/, '注入位要有初值');
    assert.match(code, /requestStack = \(state && state\.requestStack\)/, '重排请求也从 state 注入');
});

test('模块不得自己写拖拽把手的显隐', () => {
    const code = stripComments(weiboSrc);
    // 平台用 .module-zone.is-editing 规则控制把手；模块自己写 hidden 属性会
    // 让 CSS 失效，编辑模式下把手永远不出现（api-boundary 同款守卫）。
    assert.doesNotMatch(code, /handle\.hidden/, '把手显隐归平台 CSS 管');
    assert.match(code, /module-drag-handle/);
});

test('第三方文本只经 textContent 落 DOM，innerHTML 一律是静态模板', () => {
    const code = stripComments(weiboSrc);
    // 标题/标签来自外站数据。textContent 原位替换没有注入面；
    // innerHTML 里一旦出现插值就等于开洞。
    const innerWrites = [...code.matchAll(/\.innerHTML\s*=\s*(`[^`]*`|'[^']*')/g)].map(m => m[1]);
    assert.ok(innerWrites.length >= 2, `应有若干 innerHTML 静态模板，实测 ${innerWrites.length}`);
    for (const lit of innerWrites) {
        assert.doesNotMatch(lit, /\$\{/, `innerHTML 模板里不得有插值：${lit}`);
    }
    assert.match(code, /el\.children\[1\]\.textContent = item\.title/, '标题走 textContent');
    assert.match(code, /el\.children\[2\]\.textContent = item\.label \|\| ''/, '标签走 textContent');
});

test('href 白名单：第三方 url 只放行 http(s)', () => {
    const code = stripComments(weiboSrc);
    // javascript: 数据 URL 一旦进 href 就是 XSS。模块不信任任何数据源，
    // 服务端已滤一道，这里是客户端那道。
    assert.match(code, /function safeUrl\(/);
    // 源码里就是这行正则字面量，用字符串比对（拿正则去匹配正则文本是自找转义麻烦）
    assert.ok(code.includes("return /^https?:\\/\\//.test(u || '')"),
        '白名单正则必须是 /^https?:\\/\\//——改成别的形式要连这里一起改');
    assert.match(code, /el\.href = safeUrl\(item\.url\)/, 'href 必须经 safeUrl');
    assert.match(code, /rel = 'noopener'/, '外跳链接带 noopener');
});

test('模块不创建未加前缀的元素 id', () => {
    // 模块与页面共用一个 id 命名空间；撞名会让 querySelector 命中隐藏的
    // 后台按钮（memo 的 #saveBtn 踩过）。本模块当前一个 id 都不建，
    // 但将来加了也必须带 weibo 前缀——断言写成「凡 id 必前缀」。
    const ids = [...weiboSrc.matchAll(/(?<![-\w])id="([^"]+)"/g)].map(m => m[1]);
    for (const id of ids) {
        assert.match(id, /^weibo/, `模块 id 应带 weibo 前缀：${id}`);
    }
    const existing = [];
    for (const [file, src] of [['index.html', fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')], ['app.js', appSource]]) {
        for (const m of src.matchAll(/\bid="([^"]+)"/g)) existing.push([m[1], file]);
    }
    for (const id of ids) {
        assert.deepEqual(existing.filter(([o]) => o === id), [], `${id} 与页面既有 id 冲突`);
    }
});

test('窄卡容器查询在 styles.css 里（侧挂档隐藏热度列）', () => {
    // 仿真样例实测：220px 卡里标题被截到 94px，藏掉热度列后恢复 133px。
    // 这条规则依赖 .weibo-card 是查询容器——两半必须都在。
    assert.match(stylesSource, /\.weibo-card \{ container-type: inline-size; \}/);
    assert.match(stylesSource, /@container \(max-width: 240px\) \{ \.weibo-hot \{ display: none; \} \}/);
});

test('标题走常规字重：15 行列表不与书签卡的 600 字重同档', () => {
    // 用户反馈「15 条热搜文字粗、显眼、密、放首页不和谐」——600 字重
    // 连排会糊成一片视觉重块。走 stripComments：注释里摆一条同形假规则
    // 就能骗过源码匹配（本文件自己的守则）。
    const css = stripComments(stylesSource);
    const titleRule = css.match(/\.weibo-title \{[^}]*\}/);
    assert.ok(titleRule, '.weibo-title 规则存在');
    assert.match(titleRule[0], /font-weight: 400/, '标题必须是常规字重 400');
    const rankRule = css.match(/\.weibo-rank \{[^}]*\}/);
    assert.ok(rankRule, '.weibo-rank 规则存在');
    assert.match(rankRule[0], /font-weight: 600/, '名次数字降到 600（原 700）');
    assert.match(css, /\.weibo-rows \{[^}]*gap: 2px/, '行间有 2px 间隙（与 memo-rows 同）');
});

// ========== 服务端代理路由 ==========

test('/api/weibo-hot 路由：轮询桶 + requireAdmin，且不在 /api/modules 前缀下', () => {
    const code = stripComments(server);
    const at = code.indexOf("app.get('/api/weibo-hot'");
    assert.ok(at > 0, '路由存在');
    const route = code.slice(at, at + 120);
    assert.ok(route.length > 100, `切出路由（${route.length}）`);
    assert.match(route, /app\.get\('\/api\/weibo-hot', modulePollLimit, requireAdmin/,
        '读接口走轮询专用桶（按标签页数线性增长，算进管理桶会自己打满）');
    // /api/modules 前缀有「恰好 10 条」的计数守卫，这条不该混进去
    assert.doesNotMatch(code, /app\.get\('\/api\/modules\/weibo-hot'/);
});

test('代理路由：上游取数带超时与大小上限，形状校验后才落缓存', () => {
    const code = stripComments(server);
    const at = code.indexOf("app.get('/api/weibo-hot'");
    const end = code.indexOf('// ========== Special Line', at);
    const route = code.slice(at, end);
    assert.ok(route.length > 800, `切出整个路由体（${route.length}）`);
    assert.match(route, /fetchJson\(WEIBO_HOT_URL/, '复用时间线的取数工具');
    assert.match(route, /timeoutMs: WEIBO_HOT_TIMEOUT/, '上游必须有超时——fetch 没有内建超时');
    assert.match(route, /maxBytes: WEIBO_HOT_MAX_BYTES/, '响应体要有大小上限');
    assert.match(route, /Array\.isArray\(json\.data\.list\)/, '形状校验后才放行到渲染路径');
    assert.match(route, /slice\(0, WEIBO_HOT_PAGE\)/, '服务端就截到 15 条');
    // href 白名单的第一道（服务端先滤，客户端的 safeUrl 是第二道）
    assert.ok(code.includes("/^https?:\\/\\//.test(x.url || '')"),
        'url 在服务端先滤一道（/^https?:\\/\\// 白名单）');
    // 陈旧兜底：直接回缓存里的同一份（响应不带 stale 标记——没有读取方）
    assert.match(route, /return res\.json\(weiboHotCache\.data\)/, '陈旧缓存兜底');
    assert.match(route, /res\.status\(502\)/, '无缓存时才 502');
    // 缓存键与 TTL
    assert.match(route, /now - weiboHotCache\.at < WEIBO_HOT_TTL/, '缓存命中走 TTL 判定');
});

// ========== 渲染核心：keyed diff + FLIP（真执行，不是源码形状） ==========
//
// 桩的语义按浏览器那几条关键规则建：appendChild 对已在树上的节点是**移动**、
// fragment 把子节点搬进目标、行的 rect.top 由它在父容器里的下标推导。
// 只 stub 布局（浏览器才有），不替模块补任何逻辑——
// 模块里所有代码都是 weibo-hot.js 的原文在跑。

const ROW_H = 26;

function makeEl(tag) {
    const el = {
        tagName: tag, children: [], parent: null, style: {}, dataset: {},
        className: '', textContent: '', title: '', href: '', target: '', rel: '',
        offsetHeight: 0, listeners: {},
        get innerHTML() { return this._html || ''; },
        set innerHTML(html) {
            this._html = html;
            // 桩只为模块真实用到的两种静态模板建子节点：
            // 行模板的若干 <span class="x"></span>，其余按空元素处理。
            this.children = [];
            for (const m of html.matchAll(/<span class="([^"]+)"><\/span>/g)) {
                const child = makeEl('span');
                child.className = m[1];
                child.parent = this;
                this.children.push(child);
            }
        },
        appendChild(child) {
            if (child.__fragment) {
                for (const c of [...child.children]) this.appendChild(c);
                return child;
            }
            if (child.parent) child.parent.removeChild(child); // 浏览器语义：已在树上则是移动
            child.parent = this;
            this.children.push(child);
            return child;
        },
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i >= 0) this.children.splice(i, 1);
            child.parent = null;
            return child;
        },
        remove() { if (this.parent) this.parent.removeChild(this); },
        replaceChildren(...nodes) {
            for (const c of this.children) c.parent = null;
            this.children = [];
            for (const n of nodes) this.appendChild(n);
        },
        append(...nodes) { for (const n of nodes) this.appendChild(n); },
        setAttribute() {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        removeEventListener() {},
        getBoundingClientRect() {
            const i = this.parent ? this.parent.children.indexOf(this) : 0;
            return { top: i * ROW_H, bottom: i * ROW_H + ROW_H, left: 0, right: 100, width: 100, height: ROW_H };
        }
    };
    return el;
}

function makeFragment() {
    const f = makeEl('#fragment');
    f.__fragment = true;
    return f;
}

/** 装载模块并挂好桩环境。api.getNext() 每次轮询取一份数据（或抛错）。 */
function loadModule(listResponses) {
    const intervals = [];
    const sandbox = {
        console,
        document: {
            hidden: false,
            createElement: makeEl,
            createDocumentFragment: makeFragment,
            addEventListener() {},
            removeEventListener() {}
        },
        window: {
            matchMedia: () => ({ matches: false }),
            app: { registered: null, registerModule(def) { sandbox.window.app.registered = def; } }
        },
        setInterval(fn) { intervals.push(fn); return intervals.length; },
        clearInterval() {},
        setTimeout, clearTimeout,
        Date, Map, Set, Math, Number, Array, String, JSON, Error, Object, isNaN
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(weiboSrc, sandbox, { filename: 'weibo-hot.js' });

    const def = sandbox.window.app.registered;
    assert.ok(def && typeof def.mountWidget === 'function', '模块经 registerModule 注册');

    const responses = [...listResponses];
    const api = {
        async get() {
            const next = responses.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error('桩里没有下一轮响应了——测试少写了一份数据');
            return next;
        }
    };
    let stackRequests = 0;
    const state = { api, requestStack() { stackRequests++; }, whenReady() {} };
    const mounted = def.mountWidget(makeEl('div'), state);
    const card = mounted[0];
    const cardBody = card.children.find(c => c.children.some && c.children.length === 0 && c.className === 'module-widget-body')
        || card.children[1];
    const cardStatus = card.children[0].children.find(c => c.className === 'weibo-card-status');
    return {
        card, cardBody, cardStatus, intervals, def, state,
        poll: () => intervals[intervals.length - 1](),
        rows: () => cardBody.children.filter(c => c.className === 'weibo-row'),
        titles: () => cardBody.children.filter(c => c.className === 'weibo-row')
            .map(r => r.children[1].textContent),
        stackRequests: () => stackRequests
    };
}

function list15(items) {
    return { list: items.slice(0, 15).map((x, i) => ({ rank: i, ...x })) };
}

const SAMPLE = [
    '泰国警方回应大概率已被转至缅甸', '明知不该买房却想要自己的家', '以青春之我建强农之业',
    '梅艳芳骨灰被盗', '四部门终结速成车乱象', '刘琳琳抖音账号被封',
    '北京人社辟谣拉群领社保是诈骗', '崔晋说李勒优的钱都拿去买车开店', '恋人',
    '打一针让癌细胞生锈而死', '香港近年多位名人骨灰被盗', '曝商家直接和刘琳琳终止合作',
    '黄磊二女儿和黄磊一模一样', '花店老板说李勒优是真没钱', '小姨对李勒优说的话'
].map((t, i) => ({ title: t, hot_value: 400000 - i * 10000, label: '', url: 'https://s.weibo.com/weibo?q=x' }));

test('首轮渲染 15 行，标题/热度/排名都落对了', async () => {
    const h = loadModule([list15(SAMPLE)]);
    await h.intervals.length && Promise.resolve(); // mountWidget 内的首轮 poll 是同步启动的微任务
    await new Promise(r => setImmediate(r));
    assert.equal(h.rows().length, 15);
    assert.equal(h.titles()[0], SAMPLE[0].title);
    assert.equal(h.rows()[0].children[0].textContent, '1', '排名从 1 显示');
    assert.equal(h.rows()[0].children[3].textContent, '40.0万', '热度格式化成中文万');
    assert.equal(h.rows()[0].href, SAMPLE[0].url, 'href 来自数据');
    assert.equal(h.rows()[0].target, '_blank');
});

test('换榜：行节点按 title 复用（identity 不变），顺序真的跟着数据走', async () => {
    // 把第一名和最后一名对调——FLIP 的典型场景
    const swapped = [SAMPLE[14], ...SAMPLE.slice(1, 14), SAMPLE[0]];
    const h = loadModule([list15(SAMPLE), list15(swapped)]);
    await new Promise(r => setImmediate(r));
    const before = h.rows();
    const nodeOfFirstTitle = before[0];

    h.poll();
    await new Promise(r => setImmediate(r));

    const after = h.rows();
    assert.equal(after.length, 15);
    assert.equal(h.titles()[0], SAMPLE[14].title, '顺序跟着新数据');
    assert.ok(after.includes(nodeOfFirstTitle), '原第一名的节点对象还在树上（被移动而不是重建）');
    assert.equal(after[14], nodeOfFirstTitle, '同一个节点换到了第 15 位');
});

test('数据未变化的一轮：零 DOM 写入（不重建、不写 style、不请求重排）', async () => {
    const h = loadModule([list15(SAMPLE), list15(SAMPLE)]);
    await new Promise(r => setImmediate(r));
    const rowsBefore = h.rows();
    const stackBefore = h.stackRequests();
    // 记录第二轮（数据没变的那一轮）期间的全部 style 写入。
    // ⚠️ 不能断言首轮后的 style 值是 undefined——首轮所有行走进入淡入，
    // 写过 transform:''，那是合法的；要断言的是**这一轮**没有任何写入。
    const writes = [];
    for (const row of h.rows()) {
        row.style = new Proxy(row.style, {
            set(t, k, v) { writes.push(`${String(k)}=${v}`); t[k] = v; return true; }
        });
    }

    h.poll();
    await new Promise(r => setImmediate(r));

    assert.deepEqual(writes, [], '数据没变的一轮零 style 写入');
    assert.deepEqual(h.rows(), rowsBefore, '行节点一个没换');
    assert.equal(h.stackRequests(), stackBefore, '没变化就不该请求重排');
});

test('FLIP：换位的行先拿到反转变换再被清零（过渡真的被驱动）', async () => {
    const swapped = [SAMPLE[14], ...SAMPLE.slice(1, 14), SAMPLE[0]];
    const h = loadModule([list15(SAMPLE), list15(swapped)]);
    await new Promise(r => setImmediate(r));
    // 用 Proxy 记录这一轮的全部 style 写入序列：FLIP 的形状是
    // 「transform=translateY(反移) → (reflow) → transition=… → transform=''」。
    // 断言写入序列而不是最终值——最终值恒为空，只有序列能证明过渡被驱动。
    const writes = [];
    for (const row of h.rows()) {
        row.style = new Proxy(row.style, {
            set(t, k, v) { writes.push({ row, k: String(k), v }); t[k] = v; return true; }
        });
    }

    h.poll();
    await new Promise(r => setImmediate(r));

    const inversions = writes.filter(w => w.k === 'transform' && /^translateY\(-?\d/.test(w.v));
    assert.ok(inversions.length >= 2, `应有若干行拿到反转变换，实测 ${inversions.length}`);
    for (const inv of inversions) {
        // 同一行随后必须：挂上 transform 过渡 → 把反转变换清零
        const idx = writes.indexOf(inv);
        const later = writes.slice(idx + 1).filter(w => w.row === inv.row);
        assert.ok(later.some(w => w.k === 'transition' && w.v.includes('transform')),
            '反转变换的行随后挂上了 transform 过渡');
        assert.ok(later.some(w => w.k === 'transform' && w.v === ''),
            '反转变换随后被清零（过渡归零到真实位置）');
    }
    // 全部落位：没有行停在中间态
    for (const row of h.rows()) {
        const t = row.style.transform;
        assert.ok(t === undefined || t === '', `有行没落位：${t}`);
    }
});

test('列表变化后请求一次重排（卡片高度可能变，下面的卡要跟着排）', async () => {
    const swapped = [SAMPLE[14], ...SAMPLE.slice(1, 14), SAMPLE[0]];
    const h = loadModule([list15(SAMPLE), list15(swapped)]);
    await new Promise(r => setImmediate(r));
    const before = h.stackRequests();
    h.poll();
    await new Promise(r => setImmediate(r));
    assert.equal(h.stackRequests(), before + 1, '恰好一次——多了是重复请求，少了下面的卡停在旧高度');
});

test('失败轮：不清列表，状态行转失败且带重试；恢复后回到时间', async () => {
    const h = loadModule([list15(SAMPLE), new Error('network down'), list15(SAMPLE)]);
    await new Promise(r => setImmediate(r));
    const rowsBefore = h.rows();

    h.poll(); // 这一轮 api.get 抛错
    await new Promise(r => setImmediate(r));

    assert.deepEqual(h.rows(), rowsBefore, '失败不清空已显示的榜单');
    assert.equal(h.cardStatus.dataset.kind, 'failed');
    assert.match(h.cardStatus.innerHTML, /同步失败/);
    assert.match(h.cardStatus.innerHTML, /data-action="retry"/, '失败态给出重试入口');

    h.poll(); // 恢复
    await new Promise(r => setImmediate(r));
    assert.equal(h.cardStatus.dataset.kind, undefined, '恢复后失败标记摘掉');
    assert.match(h.cardStatus.textContent, /^更新 \d{2}:\d{2}$/, '状态行回到同步时刻');
});

test('重试按钮经卡片委托触发新一轮拉取（不在正文上挂委托）', async () => {
    const h = loadModule([list15(SAMPLE), list15(SAMPLE), list15(SAMPLE)]);
    await new Promise(r => setImmediate(r));
    // 委托在整张卡上：状态胶囊在卡片头里，挂正文会让重试变死按钮（memo 踩过）
    const handlers = h.card.listeners.click || [];
    assert.equal(handlers.length, 1, '卡片上恰好一个 click 委托');
    const retryBtn = { closest: sel => (sel === '[data-action]' ? { dataset: { action: 'retry' } } : null) };
    const before = h.stackRequests();
    handlers[0]({ target: retryBtn });
    await new Promise(r => setImmediate(r));
    // 轮询跑了：数据相同 → 不重排，但状态行会刷新；用 intervals 长度证明 poll 被调用过
    assert.ok(h.cardStatus.textContent.startsWith('更新 '), '重试后状态行有值');
    assert.equal(h.stackRequests(), before, '重试拉到相同数据，不触发重排');
});

test('首轮交给平台（whenReady），不闪空卡', () => {
    let handed = null;
    const responses = [list15(SAMPLE)];
    const sandbox = {
        console,
        document: { hidden: false, createElement: makeEl, createDocumentFragment: makeFragment, addEventListener() {}, removeEventListener() {} },
        window: { matchMedia: () => ({ matches: false }), app: { registered: null, registerModule(d) { sandbox.window.app.registered = d; } } },
        setInterval() { return 1; }, clearInterval() {}, setTimeout, clearTimeout,
        Date, Map, Set, Math, Number, Array, String, JSON, Error, Object, isNaN
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(weiboSrc, sandbox);
    const api = { async get() { return responses.shift(); } };
    const state = { api, requestStack() {}, whenReady(p) { handed = p; } };
    sandbox.window.app.registered.mountWidget(makeEl('div'), state);
    assert.ok(handed && typeof handed.then === 'function', '首轮数据 promise 交给了平台');
});

test('重挂载（后台开关/重登/换停靠重跑 mountWidget）必须重绘，不得留空卡', async () => {
    // 症状（审查发现，脚本复现）：模块级指纹活得过重挂载，二次 mountWidget
    // 因 listKey/statusKey 相同直接短路，新卡片体 0 行、状态行空；
    // 且上游 60 秒缓存内数据不变，下一轮轮询也救不回来。
    const h = loadModule([list15(SAMPLE), list15(SAMPLE)]);
    await new Promise(r => setImmediate(r));
    assert.equal(h.rows().length, 15, '首次挂载 15 行');

    const again = h.def.mountWidget(makeEl('div'), h.state)[0];
    const body2 = again.children[1];
    const status2 = again.children[0].children.find(c => c.className === 'weibo-card-status');
    assert.equal(body2.children.filter(c => c.className === 'weibo-row').length, 15,
        '重挂载后行数仍是 15——清了指纹才不会短路');
    assert.match(status2.textContent, /^更新 \d{2}:\d{2}$/, '重挂载后状态行有值');
});

test('429 与真失败的文案分开（限流不是「读不到」）', async () => {
    const limiter = Object.assign(new Error('HTTP 429'), { status: 429 });
    const h = loadModule([list15(SAMPLE), limiter, new Error('network down'), list15(SAMPLE)]);
    await new Promise(r => setImmediate(r));

    h.poll(); // 429
    await new Promise(r => setImmediate(r));
    assert.match(h.cardStatus.innerHTML, /请求过于频繁/, '429 单独说，不混成「同步失败」');

    h.poll(); // 真失败
    await new Promise(r => setImmediate(r));
    assert.match(h.cardStatus.innerHTML, /同步失败/, '真失败回落到通用文案');

    h.poll(); // 恢复
    await new Promise(r => setImmediate(r));
    assert.equal(h.cardStatus.dataset.kind, undefined, '恢复后摘掉失败标记');
});

test('FLIP 收尾摘掉内联 transition（留着会盖掉 hover 过渡）', async () => {
    const swapped = [SAMPLE[14], ...SAMPLE.slice(1, 14), SAMPLE[0]];
    const h = loadModule([list15(SAMPLE), list15(swapped)]);
    await new Promise(r => setImmediate(r));
    h.poll();
    await new Promise(r => setImmediate(r));
    const animated = h.rows().filter(r => r.style.transition && r.style.transition.includes('transform'));
    assert.ok(animated.length >= 2, `换位行挂着 FLIP 过渡，实测 ${animated.length}`);
    // 收尾定时器在 FLIP_MS+60 后清内联 transition
    await new Promise(r => setTimeout(r, 280 + 60 + 40));
    for (const row of animated) {
        assert.equal(row.style.transition, '', '动画结束后内联 transition 被摘掉，hover 过渡交还 CSS');
    }
});

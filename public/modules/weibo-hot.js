/**
 * 微博热搜首页模块（weibo-hot）。
 *
 * 渲染核心是 **keyed diff + FLIP**：整卡永不 innerHTML 重建，刷新时按 title
 * 复用行节点、transform 滑动归位——这是「无感切换」需求的实现本体，
 * 仿真样例（scratchpad/weibo-hot-mockup.html）与本文件共用同一段逻辑。
 *
 * 三条平台纪律（与 memo.js 相同，见 docs/architecture.md）：
 * 1. 不引用 app.js 内部标识符——API 经 state.api 注入；
 * 2. 模块自己的元素 id 带模块前缀（weibo）；
 * 3. 同步失败不清空已显示的列表，只把状态行转成失败态。
 */
(() => {
    'use strict';

    const POLL_MS = 60000;
    /** 显示条数的默认值与上下限。真实取值来自用户偏好（state.settings.pageSize）。 */
    const PAGE_SIZE = 15;
    const PAGE_MIN = 5;
    const PAGE_MAX = 30;
    const FLIP_MS = 280;
    const ROW_MOTION = `transform ${FLIP_MS}ms cubic-bezier(.2,.8,.25,1), opacity 220ms ease`;

    /** 热度格式化：570650 → 57.1万 */
    function formatHot(v) {
        if (!Number.isFinite(v)) return '';
        if (v >= 10000) return (v / 10000).toFixed(1) + '万';
        return String(v);
    }

    /** 第三方数据的 href 白名单：只放行 http(s)，挡 javascript:。服务端已滤一道，这里是客户端的那道。 */
    function safeUrl(u) {
        return /^https?:\/\//.test(u || '') ? u : '';
    }

    let api = null;
    let requestStack = null;
    let cardBody = null;
    let cardStatus = null;
    let pollTimer = null;
    let visibilityHandler = null;
    let inFlight = false;
    let lastSync = 0;
    let syncState = 'synced'; // synced | failed
    let rateLimited = false;  // 最近一次失败是不是 429（文案要分开说）
    let items = [];
    let pageSize = PAGE_SIZE; // 用户偏好，来自 state.settings（平台已按声明清洗过）
    let rowEls = new Map();   // title → 行节点（keyed 复用的核心）
    // null 是「尚未渲染过」的哨兵：空榜单的指纹是 ''，初值若也是 '' 会短路掉
    // 空态占位符的首绘。
    let lastListKey = null;
    let lastStatusKey = null;

    // ================= 状态行 =================

    function syncTimeText() {
        if (syncState !== 'synced' || !lastSync) return '';
        const d = new Date(lastSync);
        return '更新 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function statusKey() {
        return [syncState, rateLimited, syncTimeText()].join('|');
    }

    /** 只就地刷新状态胶囊——数据没变时用它代替任何列表操作。 */
    function renderStatus() {
        if (!cardStatus) return;
        const key = statusKey();
        if (key === lastStatusKey) return;
        lastStatusKey = key;
        if (syncState === 'failed') {
            cardStatus.dataset.kind = 'failed';
            // 429 与真失败分开说：混成一句「同步失败」会让人去查服务端，
            // 而实际只要等一分钟（server-monitor / special-line 同款纪律）。
            // 两份**完整静态模板**而不是模板插值——innerHTML 里不放任何 `${}`。
            cardStatus.innerHTML = rateLimited
                ? '请求过于频繁，稍后再试 <button class="weibo-retry" type="button" data-action="retry">重试</button>'
                : '同步失败 <button class="weibo-retry" type="button" data-action="retry">重试</button>';
        } else {
            delete cardStatus.dataset.kind;
            cardStatus.textContent = syncTimeText();
        }
    }

    // ================= 列表渲染：keyed diff + FLIP =================

    function listKey() {
        return items.map(i => `${i.title}:${i.rank}:${i.hot_value}:${i.label}`).join('|');
    }

    function createRow(item) {
        const a = document.createElement('a');
        a.className = 'weibo-row';
        a.innerHTML =
            `<span class="weibo-rank"></span>` +
            `<span class="weibo-title"></span>` +
            `<span class="weibo-badge"></span>` +
            `<span class="weibo-hot"></span>`;
        updateRow(a, item);
        return a;
    }

    function updateRow(el, item) {
        el.href = safeUrl(item.url);
        el.target = '_blank';
        el.rel = 'noopener';
        el.dataset.top = item.rank < 3 ? '1' : '0';
        el.children[0].textContent = String(item.rank + 1);
        // 标题是第三方数据：textContent 原位替换（不走 innerHTML，无注入面）
        el.children[1].textContent = item.title;
        el.children[2].textContent = item.label || '';
        el.children[2].dataset.label = item.label || '';
        el.children[3].textContent = formatHot(item.hot_value);
    }

    function reducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /** 指纹相同 → 只刷状态行（零 DOM 写入）；不同 → keyed diff + FLIP。 */
    function renderListMaybe() {
        if (!cardBody) return;
        const key = listKey();
        if (key === lastListKey) { renderStatus(); return; }
        lastListKey = key;

        if (!items.length) {
            rowEls.clear();
            cardBody.innerHTML = '<div class="weibo-empty">暂无热搜数据</div>';
            renderStatus();
            if (requestStack) requestStack();
            return;
        }

        // First：记录现存行的位置
        const firstRects = new Map();
        if (!reducedMotion()) {
            for (const [title, el] of rowEls) firstRects.set(title, el.getBoundingClientRect());
        }

        // Mutate：按新顺序复用/创建行。fragment 里的 appendChild 对已存在的
        // 节点是**移动**而不是复制——identity 不变，这是无闪断的前提。
        const frag = document.createDocumentFragment();
        const seen = new Set();
        for (const item of items) {
            let el = rowEls.get(item.title);
            if (!el) {
                el = createRow(item);
                rowEls.set(item.title, el);
            } else {
                updateRow(el, item);
            }
            seen.add(item.title);
            frag.appendChild(el);
        }
        for (const [title, el] of [...rowEls]) {
            if (!seen.has(title)) { el.remove(); rowEls.delete(title); }
        }
        cardBody.replaceChildren(frag);

        // Last + Invert + Play
        if (!reducedMotion()) {
            let moved = 0;
            for (const [title, el] of rowEls) {
                const first = firstRects.get(title);
                const last = el.getBoundingClientRect();
                if (first) {
                    const deltaY = first.top - last.top;
                    if (Math.abs(deltaY) > 0.5) {
                        el.style.transition = 'none';
                        el.style.transform = `translateY(${deltaY}px)`;
                        moved++;
                    }
                } else {
                    // 新进入的行：从上方淡入
                    el.style.transition = 'none';
                    el.style.opacity = '0';
                    el.style.transform = 'translateY(-6px)';
                    moved++;
                }
            }
            if (moved) {
                void cardBody.offsetHeight; // 强制 reflow：让反转变换先落地再开过渡
                const animated = [];
                for (const el of rowEls.values()) {
                    if (el.style.transform || el.style.opacity) {
                        el.style.transition = ROW_MOTION;
                        el.style.transform = '';
                        el.style.opacity = '';
                        animated.push(el);
                    }
                }
                // 动画收尾把内联 transition 摘掉：留着它会盖掉 CSS 里
                // .weibo-row 的 hover 过渡（同特异性下内联赢），hover 变瞬变。
                setTimeout(() => {
                    for (const el of animated) {
                        // 只摘仍是本动画挂上的那批——不清会误伤中途开始的新一轮
                        if (el.style.transition === ROW_MOTION) el.style.transition = '';
                    }
                }, FLIP_MS + 60);
            }
        }

        renderStatus();
        // 列表变化可能改变卡片高度（新标题折行），下面的卡要跟着排
        if (requestStack) requestStack();
    }

    // ================= 轮询 =================

    async function poll() {
        if (inFlight) return;
        inFlight = true;
        try {
            const data = await api.get('/api/weibo-hot');
            if (!data || !Array.isArray(data.list)) throw new Error('bad payload');
            items = data.list.slice(0, pageSize);
            lastSync = Date.now();
            syncState = 'synced';
            rateLimited = false;
            renderListMaybe();
        } catch (e) {
            console.error('WeiboHot poll failed:', e);
            // 失败不清列表：上一条已知榜单留在卡上，只把状态行转失败态。
            // 429 单独标记：它与「真的读不到」的下一步动作完全不同。
            rateLimited = !!(e && e.status === 429);
            syncState = 'failed';
            renderStatus();
        } finally {
            inFlight = false;
        }
    }

    /** 只挂表与前后台监听，不立即拉取——首轮由 mountWidget 显式拉一次交给平台。 */
    function schedulePolling() {
        if (pollTimer) clearInterval(pollTimer);
        if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
        pollTimer = setInterval(poll, POLL_MS);
        // 页面不可见时停表，切回前台立即补拉
        visibilityHandler = () => {
            if (document.hidden) {
                clearInterval(pollTimer);
                pollTimer = null;
            } else if (!pollTimer) {
                poll();
                pollTimer = setInterval(poll, POLL_MS);
            }
        };
        document.addEventListener('visibilitychange', visibilityHandler);
    }

    /**
     * 平台在模块离开启用集合时调用。**公开模块尤其需要它**：管理员撤回开放后
     * 服务端立刻 403，若不停表，这张卡片会继续按 60 秒的周期去撞那个 403。
     */
    function unmount() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (visibilityHandler) {
            document.removeEventListener('visibilitychange', visibilityHandler);
            visibilityHandler = null;
        }
        inFlight = false;
    }

    // ================= 挂载 =================

    /**
     * 偏好值兜底。平台已按声明的校验规则清洗过，但模块不假定上游一定给了
     * 合法值——自己再夹一次，免得一个畸形值把列表截成空的或者几十条。
     */
    function clampPageSize(value) {
        const n = Math.floor(Number(value));
        return Number.isFinite(n) && n >= PAGE_MIN && n <= PAGE_MAX ? n : PAGE_SIZE;
    }

    function mountWidget(shell, state) {
        api = (state && state.api) || null;
        requestStack = (state && state.requestStack) || null;
        pageSize = clampPageSize(state && state.settings && state.settings.pageSize);
        if (!api) {
            // 平台契约变化要让它在界面上可见，而不是退化成一连串同步失败
            const box = document.createElement('div');
            box.className = 'module-widget-error';
            box.textContent = '模块未拿到 API（平台接口变化）';
            return [box];
        }

        const card = document.createElement('section');
        // weibo-card 修饰类：样式表用它做容器查询锚点（窄卡隐藏热度列）
        card.className = 'module-card weibo-card';
        card.dataset.instanceId = 'weibo-hot:main';

        const head = document.createElement('div');
        head.className = 'module-widget-head';

        const label = document.createElement('span');
        label.className = 'module-widget-title';
        label.textContent = '微博热搜';

        const status = document.createElement('span');
        status.className = 'weibo-card-status';

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'module-drag-handle';
        handle.title = '拖拽调整位置';
        handle.setAttribute('aria-label', '拖拽调整微博热搜的位置');
        // 显隐交给平台的 .module-zone.is-editing 规则，不在这里写 hidden

        head.append(label, status, handle);

        const body = document.createElement('div');
        body.className = 'module-widget-body';

        card.append(head, body);
        cardBody = body;
        cardStatus = status;

        // H1 修复：平台会在后台开关、断连重登、跨 rail/dock 换停靠时**重跑
        // mountWidget**（app.js renderModuleZone），而本模块的指纹与行节点表
        // 是模块级的、活得过重挂载。不重置的话 renderListMaybe 因指纹相同
        // 直接短路，新卡片体永远是空的（实测复现：二次挂载 0 行、状态行空，
        // 且上游 60 秒缓存内数据不变时下一轮轮询也救不回来）。memo 的对应
        // 做法是挂载时无条件 renderCard()——这里等价：清指纹强制重绘。
        // 行节点表一并清掉：旧节点挂在已脱离文档的旧卡片体上，与其移动
        // 一棵死树里的节点，不如新建并统一走进入淡入（与模块区 is-entering
        // 的整卡入场动画同拍）。
        lastListKey = null;
        lastStatusKey = null;
        rowEls = new Map();

        // 事件委托挂在整张卡上（同 memo）：状态胶囊的「重试」在卡片头里，
        // 委托挂正文会让它变成死按钮
        card.addEventListener('click', event => {
            const t = event.target.closest('[data-action]');
            if (t && t.dataset.action === 'retry') poll();
        });

        renderListMaybe();
        const firstRound = poll();
        schedulePolling();
        if (state && typeof state.whenReady === 'function') state.whenReady(firstRound);
        return [card];
    }

    window.app.registerModule({
        id: 'weibo-hot',
        // 公开模块：管理员可在后台对外开放，普通访客据此自行启用。
        // 分类在开发时固定，运行时无法改变。
        category: 'public',
        title: '微博热搜',
        summary: '首页展示微博热搜榜单，每分钟自动刷新，换榜平滑过渡。',
        // 用户侧配置白名单：声明了默认值与校验规则，平台据此生成设置控件、
        // 并在读写两侧清洗。白名单外的键不会落盘。
        settings: {
            pageSize: {
                default: PAGE_SIZE,
                min: PAGE_MIN,
                max: PAGE_MAX,
                label: '显示条数',
                validate(value) {
                    const n = Math.floor(Number(value));
                    return Number.isFinite(n) && n >= PAGE_MIN && n <= PAGE_MAX ? n : null;
                }
            }
        },
        mountWidget,
        unmount
    });
})();

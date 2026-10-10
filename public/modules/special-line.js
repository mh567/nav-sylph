/**
 * Special Line 时间线模块。
 *
 * 时间线**内联显示在首页右侧那一列里**，形态与仿真样例（docs/mockup-special-line-actions.html）
 * 一致：左侧日期轨道 + 贯穿节点线 + 事件卡（右上角归档、右下角收藏星标）+ chips 筛选；
 * 不是「摘要卡 + 点开弹窗」。
 *
 * 两套版式由**容器查询**切换（见 styles.css 的 @container special-line-card）：
 *  - 宽列（≥340px，平台让背板让位后拿到的就是它）：桌面版，日期在左、事件卡在右；
 *  - 窄列：仿真里 ≤700px 那套，时间移到卡上方、竖线贴左、单列。
 * 两者是同一份 DOM，只有排版不同——所以拖拽/换窗口不会丢状态。
 *
 * 数据在服务端 SQLite（lib/timeline/），服务器是多端同步的唯一真相源。
 * 本模块按 pollInterval 轮询；页面不可见时停表，切回前台补拉一次。
 */
(() => {
    'use strict';

    const DEFAULT_POLL_MS = 15000;
    const PAGE_SIZE = 30;
    const TITLE_MAX = 200;
    const SUMMARY_MAX = 2000;

    let api = null;
    let requestStack = null;

    // ================= 状态 =================

    let events = [];
    let sources = [];
    /**
     * 收藏星标。**一个** SVG，实心/线框由 CSS 按 `aria-pressed` 切。
     *
     * 刻意不「按状态重写按钮内容」：那种写法会把按钮上其它东西一起抹掉
     *（仓库里踩过——一次 textContent 重写让一个模式按钮永久失效）。
     */
    const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/></svg>';
    let nextCursor = null;
    let hasMore = false;
    let syncState = 'synced';   // syncing | synced | failed
    let syncFailed = [];
    let lastSync = null;
    let listError = null;
    let busy = false;

    let filterSource = '';      // '' = 全部来源
    let filterView = 'all';     // all | favorited | archived
    let appliedFilterSource = '';
    let appliedFilterView = 'all';
    let filterTransition = false;
    let filterRefreshPending = false;
    // 批量同步完成后必须等最后那次第一页刷新再置顶；如果当时另一个 GET 在途，
    // scrollToTopPending 会跟着 latest-wins 补拉走，不能被旧响应消费掉。
    let scrollToTopPending = false;
    let scrollRefreshWaiters = [];
    let filterSelectionRevision = 0;
    let syncAllInFlight = false;

    let pollTimer = null;
    let pollMs = DEFAULT_POLL_MS;
    let visibilityHandler = null;
    let inFlight = false;

    /** 懒加载：列表底部哨兵进入视野就自动补一页。 */
    let moreObserver = null;
    let loadingMore = false;

    /** 卡片上的持久节点（chips 只建一次，避免轮询把它重建、丢掉焦点与滚动位置） */
    let headStatus = null;
    let chipsEl = null;
    let listEl = null;
    let footEl = null;

    let saveDialog = null;
    let saveTrigger = null;
    /** 保存对话框的草稿：取消 / Esc 关掉再打开时内容还在 */
    let saveDraft = { url: '', title: '', summary: '' };

    let lastKey = '';
    let lastChipsKey = '';
    /** 展开着的渠道菜单（providerType）；null = 都收着。 */
    let openChannel = null;

    /** 按事件 id 记住「正在看原文」（默认看中文译文）与「已展开全文」。
     *  放在模块级而不是渲染参数里：轮询重建列表时这两个选择不该被重置。 */
    const showOriginalIds = new Set();
    const expandedIds = new Set();

    // ================= 小工具 =================

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function hm(ts) {
        const d = new Date(ts);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    /** 轨道上那一列：今天 / 昨天 / 月日 */
    function dayLabel(ts) {
        const d = new Date(ts);
        if (d.toDateString() === new Date().toDateString()) return '今天';
        if (d.toDateString() === new Date(Date.now() - 86400e3).toDateString()) return '昨天';
        return `${d.getMonth() + 1}月${String(d.getDate()).padStart(2, '0')}日`;
    }

    function relTime(ts) {
        const s = (Date.now() - ts) / 1000;
        if (s < 60) return '刚刚';
        if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
        if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
        const d = new Date(ts);
        if (d.toDateString() === new Date(Date.now() - 86400e3).toDateString()) return '昨天 ' + hm(ts);
        return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm(ts)}`;
    }

    /**
     * 只在成功态给同步时刻。同步中 / 失败时显示上一次成功的时刻，
     * 会让人以为刚刚同步成功过。
     */
    function syncTimeText() {
        return syncState === 'synced' && lastSync ? hm(lastSync) : '';
    }

    /**
     * 后台每行来源的第二行补充：「下次 15:50」。
     *
     * 周期按**本轮开始**算（服务端 nextSyncAtFor），所以正常时它总在未来。
     * 超过周期这么久还没被调度到，才是真的卡住——那时明说等待调度，而不是
     * 继续显示一个已经过去的时刻（用户看到「最近成功 31 分钟前」时会以为
     * 系统没在跑，就是缺了这条对照）。
     */
    const NEXT_SYNC_GRACE_MS = 5 * 60 * 1000;
    function nextSyncHTML(s) {
        if (!s.enabled || !s.nextSyncAt) return '';
        if (Date.now() - s.nextSyncAt > NEXT_SYNC_GRACE_MS) {
            return ' · <span class="special-line-next is-overdue">已到期，等待调度</span>';
        }
        return ` · <span class="special-line-next">下次 ${hm(s.nextSyncAt)}</span>`;
    }

    /**
     * 头部状态。只给**临时**状态：同步中 / 同步失败（带重试）。
     * 稳态不再显示「已同步」这类描述——顶部只留最近同步时间（用户要求）。
     * 失败必须保留：它带一个动作（重试），去掉就没有下一步了。
     */
    function statusHTML() {
        if (syncState === 'syncing') {
            return '<span class="special-line-pill" data-kind="pending"><span class="special-line-spinner"></span>同步中</span>';
        }
        if (syncState === 'failed') {
            return '<span class="special-line-pill" data-kind="alert">同步失败</span>' +
                '<button class="special-line-retry" type="button" data-action="retry">重试</button>';
        }
        return '';
    }

    function symbolOf(event) {
        return event.providerSymbol || '·';
    }

    function sourceNameOf(event) {
        if (event.providerType === 'manual') return '稍后阅读';
        return event.sourceName || event.providerType;
    }

    // ================= 列表 =================

    /** 正文按行数折叠：默认 6 行，超出才给「展开全文」。 */
    const SUMMARY_LINES = 6;
    /** 短于这个长度不可能溢出，连折叠类都不加。 */
    const CLAMP_MIN = 90;

    /**
     * 作者那一行。社交事件按推特的样子给「头像 + 显示名 + @handle」；
     * 头像走外站（pbs.twimg.com），加载失败时退回到下面的首字母方块。
     */
    function authorHTML(e) {
        if (e.providerType === 'manual') {
            return `<span class="special-line-mark"><span class="special-line-icon" aria-hidden="true">${esc(symbolOf(e))}</span>稍后阅读</span>`;
        }
        const handle = String(e.author || '').replace(/^@/, '');
        const name = String(e.authorName || '').trim() || handle || sourceNameOf(e);
        const letter = esc((name || '·').slice(0, 1).toUpperCase());
        const img = e.authorAvatar
            ? `<img src="${esc(e.authorAvatar)}" alt="" width="20" height="20" loading="lazy" decoding="async" ` +
              `referrerpolicy="no-referrer" onerror="this.remove()">`
            : '';
        // 昵称与账号**始终同时显示**（用户要求「区分 X 的用户名和账号」）：
        // 即使两者字面相同也不省略，否则只看到「jack」时无法判断哪个是账号。
        return `<span class="special-line-mark special-line-author">` +
            `<span class="special-line-avatar" aria-hidden="true">${letter}${img}</span>` +
            `<span class="special-line-author-name">${esc(name)}</span>` +
            (handle ? `<span class="special-line-handle">@${esc(handle)}</span>` : '') +
            `</span>`;
    }

    function eventHTML(e) {
        const href = e.url || '';
        // 默认看中文译文；点过「查看原文」的按原文显示。没有译文就只有原文。
        const translated = String(e.translation || '').trim();
        const showOriginal = showOriginalIds.has(e.id);
        const useZh = !!translated && !showOriginal;
        let title = e.title;
        let body = e.summary || '';
        if (useZh) {
            const lines = translated.split('\n');
            const first = lines[0].trim();
            title = first.slice(0, TITLE_MAX) || e.title;
            // 与 adapter 的归一化同一条规则：没有第二行、但首行超长时，
            // 把整段放进正文——否则「太长需折叠」对单段长译文完全不生效
            // （标题那行没有 clamp，只能显示到截断位置）。
            body = lines.slice(1).join('\n').trim() || (first.length > TITLE_MAX ? first : '');
        }
        const linked = href
            ? `<a class="special-line-title" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(title)}` +
              `<span class="sr-only">（新标签页打开）</span></a>`
            : `<span class="special-line-title">${esc(title)}</span>`;

        const expanded = expandedIds.has(e.id);
        const clampable = body.length > CLAMP_MIN;
        const bodyHTML = body
            ? `<p class="special-line-body${clampable && !expanded ? ' is-clamped' : ''}"` +
              ` style="--clamp-lines:${SUMMARY_LINES}">${esc(body)}</p>`
            : '';

        const actions = [];
        if (translated) {
            actions.push(`<button class="special-line-ghost" type="button" data-action="original" data-id="${esc(e.id)}">` +
                `${showOriginal ? '查看译文' : '查看原文'}</button>`);
        }
        if (clampable) {
            actions.push(`<button class="special-line-ghost" type="button" data-action="expand" data-id="${esc(e.id)}" hidden>` +
                `${expanded ? '收起' : '展开全文'}</button>`);
        }

        return `<li class="special-line-item">` +
            `<time class="special-line-time"><strong>${esc(dayLabel(e.occurredAt))}</strong>${hm(e.occurredAt)}</time>` +
            `<article class="special-line-event">` +
                `<div class="special-line-meta">` +
                    authorHTML(e) +
                    `<span class="special-line-type">${esc(e.eventTypeLabel || '')}` +
                        `${useZh ? '<span class="special-line-badge">译</span>' : ''}</span>` +
                    // 归档按钮就在原来「⋯」的位置（右上角）。归档的语义**照旧**：
                    // 从默认视图与「收藏」里收起，只在「已归档」筛选可见；也**不**豁免清理
                    // ——豁免 30 天的是收藏，两者是两件事。
                    `<button class="special-line-archive" type="button" data-action="archive" data-id="${esc(e.id)}"` +
                        ` aria-pressed="${e.archived ? 'true' : 'false'}">${e.archived ? '取消归档' : '归档'}</button>` +
                `</div>` +
                `<h3>${linked}</h3>` +
                bodyHTML +
                (e.quote ? `<blockquote>${esc(e.quote)}</blockquote>` : '') +
                `<div class="special-line-stamp">${relTime(e.occurredAt)}</div>` +
                // 底部这一行**始终存在**（即使没有「查看原文/展开全文」），而且排在时间戳**之后**：
                // 用户要求「收藏按钮放在卡片右下角」——窄列下时间戳是可见的，若它排在收藏之后，
                // 星标就不是卡片最底那一行了（只有宽列下藏着时间戳时才恰好贴底）。
                `<div class="special-line-item-foot">` +
                    (actions.length ? `<div class="special-line-row-actions">${actions.join('')}</div>` : '') +
                    // ⚠️ 开关按钮的可访问名保持**恒定**（「收藏」），状态交给 aria-pressed 承载；
                    // 名字随状态改写会让读屏念成「已收藏，已按下」——重复且别扭。状态提示放 title。
                    `<button class="special-line-star" type="button" data-action="favorite" data-id="${esc(e.id)}"` +
                        ` aria-pressed="${e.favorited ? 'true' : 'false'}"` +
                        ` aria-label="收藏"` +
                        ` title="${e.favorited ? '已收藏，点击取消' : '收藏'}">${STAR_SVG}</button>` +
                `</div>` +
            `</article></li>`;
    }

    /**
     * 渲染后量一次：正文确实被截断的才把「展开全文」显示出来。
     * 只按字数猜会漏（窄列下更早溢出），所以用真实的溢出判断。
     */
    function clampPass() {
        if (!listEl) return;
        listEl.querySelectorAll('.special-line-item').forEach(item => {
            const body = item.querySelector('.special-line-body');
            const btn = item.querySelector('[data-action="expand"]');
            if (!body || !btn) return;
            if (body.classList.contains('is-clamped')) {
                btn.hidden = body.scrollHeight <= body.clientHeight + 1;
            } else {
                btn.hidden = false;   // 已展开：必须留着「收起」
            }
        });
    }

    function emptyHTML() {
        const filtered = filterSource !== '' || filterView !== 'all';
        if (filtered) {
            return '<div class="special-line-empty"><p>当前筛选下没有内容。清除筛选后可查看完整时间线。</p>' +
                '<button class="special-line-btn" type="button" data-action="reset-filters">清除筛选</button></div>';
        }
        return '<div class="special-line-empty"><p>时间线还没有内容。订阅来源请在后台「模块」分区配置，' +
            '也可以先保存一篇文章。这里会按发生时间汇集各类事件。</p>' +
            '<button class="special-line-btn special-line-btn--primary" type="button" data-action="save">＋ 保存文章</button></div>';
    }

    /** 数据指纹：没变就不重写 DOM（保住滚动位置与展开的菜单） */
    function viewKey() {
        return [
            filterSource, filterView, syncState, listError || '', busy ? 'b' : '',
            events.map(e => `${e.id}:${e.favorited}:${e.archived}:${relTime(e.occurredAt)}` +
                `:${showOriginalIds.has(e.id) ? 'o' : ''}${expandedIds.has(e.id) ? 'x' : ''}`).join('|')
        ].join('>');
    }

    function render() {
        if (!listEl) return;
        const key = viewKey();
        if (key === lastKey) return;
        lastKey = key;

        if (headStatus) {
            // 用户要求：顶部只留最近同步时间（去掉「动态 · 稍后阅读」「已同步」「未读 N」）。
            // 同步中 / 同步失败·重试 是带动作的**临时**状态，保留。
            headStatus.innerHTML = statusHTML() +
                (syncTimeText() ? `<span class="special-line-time-note">${syncTimeText()} 同步</span>` : '');
        }

        // 筛选结果在途时保留当前事件 DOM：先给 chips 即时反馈、轻微淡化旧结果，
        // 等新载荷到达再一次性替换列表。旧逻辑先 events=[] 再画骨架，
        // 每次切「全部 / 收藏 / 已归档」或换渠道都会闪空；更糟的是
        // render 内还保留滚动位置，再将它写回到一份全新的骨架上。
        if (filterTransition && listEl.querySelector('.special-line-list')) {
            listEl.classList.add('is-filtering');
            listEl.setAttribute('aria-busy', 'true');
            if (!listEl.querySelector('.special-line-filtering')) {
                const status = document.createElement('div');
                status.className = 'special-line-filtering';
                status.setAttribute('role', 'status');
                const spinner = document.createElement('span');
                spinner.className = 'special-line-spinner';
                spinner.setAttribute('aria-hidden', 'true');
                const label = document.createElement('span');
                label.textContent = '正在切换…';
                status.append(spinner, label);
                listEl.appendChild(status);
            }
            return;
        }
        listEl.classList.remove('is-filtering');
        listEl.removeAttribute('aria-busy');

        const scrollTop = listEl.scrollTop;
        const notice = syncFailed.length
            ? `<div class="special-line-notice" role="status"><strong>同步未完成</strong>` +
              `<span>保留了上次同步的事件。` +
              esc(syncFailed.map(f => f.code === 'auth'
                  ? `${f.name} 需要重新授权，可到后台「模块」分区更新`
                  : `${f.name} 同步失败，稍后会自动重试`).join('；')) +
              `</span></div>`
            : '';
        const err = listError
            ? `<div class="special-line-notice" role="alert"><strong>读取失败</strong><span>${esc(listError)}</span>` +
              `<button class="special-line-btn" type="button" data-action="reload">重试</button></div>`
            : '';

        listEl.innerHTML = err + notice +
            (events.length
                ? `<ol class="special-line-list" aria-label="按时间倒序排列的事件">${events.map(eventHTML).join('')}</ol>`
                : (busy ? '<div class="special-line-skeleton"></div><div class="special-line-skeleton"></div>'
                    : emptyHTML())) +
            // 懒加载哨兵放在滚动容器**内部**底部：根是该容器，才能判断
            // 「滚到接近底部」。放在容器外（底栏里）observer 永远等不到它。
            (hasMore ? '<div class="special-line-sentinel" aria-hidden="true"></div>' : '');

        clampPass();
        syncMoreObserver();

        if (footEl) {
            // 底部只留一行说明，**不再放「加载更早事件」按钮**：滚到底部就会自动
            // 加载，按钮与它重复（用户原话「好像没什么用」）。键盘路径不靠按钮——
            // 列表本身可聚焦（tabindex=0），方向键/PageDown 滚动同样会触发哨兵。
            // ⚠️ 「仅保留最近 30 天」只对社交订阅成立——「稍后阅读」不参与时限清理，
            // 空列表也谈不上「已到最早一条」，这两种情况都不能显示这句话。
            // 括号里那句是**必须**的：收藏过的不会被清理（sweepRetention 豁免），
            // 只写「仅保留 30 天」在用户收藏了一条之后就是错的。
            const socialView = filterSource !== 'manual';
            footEl.innerHTML = hasMore
                ? '<div class="special-line-footnote">向下滚动会自动加载更早事件</div>'
                : (events.length && socialView
                    ? '<div class="special-line-footnote">已到最早一条 · 仅保留最近 30 天（收藏过的除外）</div>'
                    : '');
        }

        listEl.scrollTop = scrollTop;
        if (requestStack) requestStack();
    }

    /**
     * 懒加载：观察列表底部的哨兵，接近可视区就补一页。
     * 只在 DOM 重建后重新挂（旧哨兵已随 innerHTML 一起被替换）。
     */
    function syncMoreObserver() {
        if (moreObserver) { moreObserver.disconnect(); moreObserver = null; }
        if (!listEl || !hasMore || typeof IntersectionObserver !== 'function') return;
        const target = listEl.querySelector('.special-line-sentinel');
        if (!target) return;
        moreObserver = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) loadMore();
        }, { root: listEl, rootMargin: '160px 0px' });
        moreObserver.observe(target);
    }

    /** 懒加载与按钮共用同一条路径，避免两处各发一次请求。 */
    function loadMore() {
        if (loadingMore || inFlight || syncAllInFlight || !hasMore) return;
        loadingMore = true;
        refresh({ append: true }).finally(() => { loadingMore = false; });
    }

    // ================= 筛选 chips =================

    function chipsKey() {
        return sources.map(s => `${s.id}:${s.providerLabel}:${s.externalKey}`).join('|') +
            '>' + filterSource + '>' + filterView + '>' + (openChannel || '');
    }

    /** 渠道分组：按 providerType 归拢，「稍后阅读」（manual）固定排最后。 */
    function channelGroups() {
        const order = [];
        const map = new Map();
        for (const s of sources) {
            if (!map.has(s.providerType)) { map.set(s.providerType, []); order.push(s.providerType); }
            map.get(s.providerType).push(s);
        }
        order.sort((a, b) => (a === 'manual' ? 1 : 0) - (b === 'manual' ? 1 : 0));
        return order.map(type => {
            const items = map.get(type);
            return { type, items, label: (items[0] && items[0].providerLabel) || type };
        });
    }

    function sourceLabel(s) {
        return s.providerType === 'manual'
            ? (s.name || '稍后阅读')
            : (s.externalKey || s.name || s.providerLabel);
    }

    /**
     * 筛选行**按渠道分组**：每个渠道一个按钮，展开后才是具体订阅人。
     *
     * ⚠️ 之前是「一条扁平 chips + `overflow-x: auto` + 隐藏滚动条」：来源一多，
     * 右边的 chip（包括「已归档」）被推出可视区，而鼠标用户没有可发现的横滑方式
     * ——实测 8 个来源时「已归档」超出容器 415px、14 个时 954px，等于点不到。
     * 分组后按钮数只随**渠道数**增长（渠道 + 3 个视图），配合换行不会再藏内容。
     */
    function renderChips() {
        if (!chipsEl) return;
        const key = chipsKey();
        if (key === lastChipsKey) return;
        lastChipsKey = key;

        const selected = sources.find(s => s.id === filterSource) || null;
        const viewChip = (value, label) =>
            `<button class="special-line-chip" type="button" data-action="filter-view" data-value="${value}"` +
            ` aria-pressed="${filterView === value}">${label}</button>`;

        let html = `<button class="special-line-chip" type="button" data-action="filter-source" data-value=""` +
            ` aria-pressed="${!selected}">全部渠道</button>`;

        for (const g of channelGroups()) {
            const picked = selected && selected.providerType === g.type ? selected : null;
            // 选中后拼「渠道 · 订阅项」，但两者同名时（「稍后阅读」渠道只有这一个
            // 同名订阅）只显示一遍，否则按钮上就是「稍后阅读 · 稍后阅读」。
            const pickedLabel = picked ? sourceLabel(picked) : '';
            const text = esc(!picked
                ? g.label
                : (!pickedLabel || pickedLabel === g.label ? g.label : `${g.label} · ${pickedLabel}`));
            const dot = picked ? '<span class="special-line-dot" aria-hidden="true"></span>' : '';
            // 只有一个订阅项的渠道直接选中，不给空菜单（「稍后阅读」就是这种）
            if (g.items.length === 1) {
                html += `<button class="special-line-chip" type="button" data-action="filter-source"` +
                    ` data-value="${esc(g.items[0].id)}" aria-pressed="${!!picked}">${dot}${text}</button>`;
                continue;
            }
            const open = openChannel === g.type;
            html += `<div class="special-line-chan" data-open="${open ? '1' : '0'}">` +
                `<button class="special-line-chip" type="button" data-action="channel" data-value="${esc(g.type)}"` +
                    ` aria-haspopup="true" aria-expanded="${open}" aria-pressed="${!!picked}">${dot}${text}` +
                    `<span class="special-line-caret" aria-hidden="true">▾</span></button>` +
                `<div class="special-line-menu" role="menu">` +
                    `<button type="button" role="menuitemradio" aria-checked="${!picked}"` +
                        ` data-action="filter-source" data-value="">该渠道全部</button>` +
                    g.items.map(s => `<button type="button" role="menuitemradio"` +
                        ` aria-checked="${!!(picked && picked.id === s.id)}"` +
                        ` data-action="filter-source" data-value="${esc(s.id)}">${esc(sourceLabel(s))}</button>`).join('') +
                `</div>` +
            `</div>`;
        }

        html += '<div class="special-line-views">' +
            viewChip('all', '全部') + viewChip('favorited', '收藏') + viewChip('archived', '已归档') +
            '</div>';
        chipsEl.innerHTML = html;
    }

    // ================= 轮询 =================

    function applyPayload(data) {
        events = Array.isArray(data.events) ? data.events : [];
        if (Array.isArray(data.sources)) sources = data.sources;
        syncFailed = (data.sync && Array.isArray(data.sync.failed)) ? data.sync.failed : [];
        nextCursor = data.nextCursor || null;
        hasMore = !!data.hasMore;
        lastSync = Date.now();
        syncState = syncFailed.length ? 'failed' : 'synced';
        listError = null;
    }

    /** @param {{append?: boolean, manual?: boolean, filterChange?: boolean}} [opts] */
    async function refresh({ append = false, manual = false, filterChange = false, scrollToTop = false } = {}) {
        if (scrollToTop) scrollToTopPending = true;
        // 全来源批次在飞时暂停普通轮询：否则轮询可能先把手动「同步中」态刷回稳态，
        // 也会让列表与批次结果交错。批次后的 filterChange/manual 刷新仍可通过。
        if (syncAllInFlight && !manual && !filterChange && !scrollToTop) return;
        if (inFlight) {
            if (filterChange || scrollToTop) {
                filterRefreshPending = true;
                filterTransition = true;
                lastKey = '';
                render();
            }
            if (scrollToTop) return new Promise(resolve => scrollRefreshWaiters.push(resolve));
            return;
        }
        inFlight = true;
        busy = true;
        if (filterChange) {
            filterTransition = true;
            listError = null;
        }
        if (manual) syncState = 'syncing';
        lastKey = '';
        lastChipsKey = '';
        renderChips();
        render();
        try {
            const params = new URLSearchParams({ view: filterView, limit: String(PAGE_SIZE) });
            if (filterSource) params.set('source', filterSource);
            if (append && nextCursor) params.set('cursor', nextCursor);
            const data = await api.get('/api/timeline/events?' + params.toString());
            if (!data || !Array.isArray(data.events)) throw new Error('bad payload');

            if (filterRefreshPending) {
                // 当前响应对应的是过期筛选，不能先让它覆盖屏幕上仍显示的旧结果；
                // finally 会立即按最新 filterSource/filterView 补拉一次。
            } else if (append) {
                const seen = new Set(events.map(e => e.id));
                events = events.concat(data.events.filter(e => !seen.has(e.id)));
                if (Array.isArray(data.sources)) sources = data.sources;
                syncFailed = (data.sync && Array.isArray(data.sync.failed)) ? data.sync.failed : syncFailed;
                nextCursor = data.nextCursor || null;
                hasMore = !!data.hasMore;
                syncState = syncFailed.length ? 'failed' : 'synced';
                appliedFilterSource = filterSource;
                appliedFilterView = filterView;
            } else {
                applyPayload(data);
                appliedFilterSource = filterSource;
                appliedFilterView = filterView;
            }

            // 服务端回当前生效的周期：后台改过之后不必刷新页面
            if (Number.isFinite(data.pollInterval) && data.pollInterval * 1000 !== pollMs) {
                pollMs = data.pollInterval * 1000;
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = setInterval(refresh, pollMs);
                }
            }
        } catch (e) {
            console.error('Special line refresh failed:', e);
            if (!filterRefreshPending) {
                if (append) {
                    listError = e && e.status === 429 ? '请求过于频繁，请稍后再试' : '加载更早的事件失败';
                } else {
                    syncState = 'failed';
                    listError = e && e.status === 429 ? '请求过于频繁，请等一分钟' : '时间线读取失败';
                }
            }
        } finally {
            inFlight = false;
            busy = false;
            lastKey = '';
            lastChipsKey = '';
            renderChips();
            if (filterRefreshPending) {
                // 用户在上一次筛选请求尚未完成时又点了别的 chips（或全量同步刚结束）：
                // 丢弃过时响应后只拉**最后选择**的第一页；置顶标志随这次补拉走。
                filterRefreshPending = false;
                return refresh({ filterChange: true, scrollToTop: scrollToTopPending });
            }
            if (filterChange && listError) {
                // 新筛选读取失败时，旧列表仍留在 DOM；把 chips 也退回最后一次
                // 成功载入的条件，避免「选中 X、列表其实还是稍后阅读」的假状态。
                filterSource = appliedFilterSource;
                filterView = appliedFilterView;
                lastChipsKey = '';
                renderChips();
            }
            filterTransition = false;
            if (scrollToTopPending) {
                if (listEl) listEl.scrollTop = 0;
                scrollToTopPending = false;
            }
            render();
            if (scrollRefreshWaiters.length) {
                const waiters = scrollRefreshWaiters;
                scrollRefreshWaiters = [];
                waiters.forEach(resolve => resolve());
            }
        }
    }

    /**
     * 首页卡头部的「立即同步」：同步所有启用中的外部订阅，然后回到全局最新页并置顶。
     *
     * 不传 force：停止来源不会因此重启。批次期间如果用户自己切了筛选，保留其最后选择；
     * 否则回到「全部渠道 / 全部」，以便刚抓到的全局最新事件可见。
     */
    async function syncAllSources() {
        if (syncAllInFlight) return;
        syncAllInFlight = true;
        const selectionAtStart = filterSelectionRevision;
        syncState = 'syncing';
        lastKey = '';
        render();

        let summary = null;
        let requestFailed = false;
        try {
            summary = await api.post('/api/timeline/sync-all', {});
        } catch (err) {
            requestFailed = true;
            console.error('Special line sync-all failed:', err);
        }

        if (filterSelectionRevision === selectionAtStart) {
            filterSource = '';
            filterView = 'all';
        }
        openChannel = null;
        lastChipsKey = '';
        renderChips();

        // non-append 不带旧 cursor；若 GET 在途，refresh 会排队重拉最后选择的第一页。
        // 只有那次新列表真正落到 DOM 后，refresh 才会把 scrollTop 置为 0。
        let refreshFailed = false;
        try {
            await refresh({ manual: true, filterChange: true, scrollToTop: true });
            // refresh 把 GET 错误收进 listError，不会向这里 throw；必须读回状态，
            // 否则采集成功但列表没读到时仍会 toast「同步完成」。
            refreshFailed = !!listError;
        } catch (err) {
            refreshFailed = true;
            console.error('Special line post-sync refresh failed:', err);
        } finally {
            syncAllInFlight = false;
            lastKey = '';
            render();
        }

        if (requestFailed) {
            window.app?.showToast('同步全部订阅失败，请重试', 'error');
        } else if (refreshFailed) {
            window.app?.showToast('同步已完成，但最新时间线读取失败，请重试', 'error');
        } else if (!summary || !summary.total) {
            window.app?.showToast('没有启用的订阅来源');
        } else {
            const text = `同步完成：成功 ${summary.succeeded} 个，失败 ${summary.failed} 个，跳过 ${summary.skipped} 个，新增 ${summary.inserted} 条`;
            window.app?.showToast(text, summary.failed ? 'error' : 'success');
        }
    }

    /** 只挂表与前后台监听，**不立即拉取**（首轮由 mountWidget 显式拉，好交给 whenReady）。 */
    function schedulePolling() {
        if (pollTimer) clearInterval(pollTimer);
        if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
        pollTimer = setInterval(refresh, pollMs);

        // 页面不可见时停表；切回前台立即补拉一次。
        // ⚠️ 重排表必须用可变的 pollMs，写死 15 秒会悄悄打回用户设置的周期。
        visibilityHandler = () => {
            if (document.hidden) {
                clearInterval(pollTimer);
                pollTimer = null;
            } else if (!pollTimer) {
                refresh();
                pollTimer = setInterval(refresh, pollMs);
            }
        };
        document.addEventListener('visibilitychange', visibilityHandler);
    }

    // ================= 写操作 =================

    /**
     * 收藏 / 取消收藏。语义是「长期保存」：服务端 `sweepRetention` 会跳过它
     * （见 repository 里那条 SQL），而归档不豁免清理。
     *
     * 乐观更新 + 失败回滚，与 setArchived 同一套写法。
     */
    async function setFavorite(event, favorited) {
        const before = event.favorited;
        event.favorited = favorited;
        lastKey = '';
        render();
        try {
            await api.post(`/api/timeline/events/${encodeURIComponent(event.id)}/favorite`, { favorited });
        } catch (e) {
            event.favorited = before;
            lastKey = '';
            render();
            window.app?.showToast('收藏失败，请重试', 'error');
        }
    }

    async function setArchived(event, archived) {
        const before = event.archived;
        event.archived = archived;
        lastKey = '';
        render();
        try {
            await api.post(`/api/timeline/events/${encodeURIComponent(event.id)}/archive`, { archived });
            refresh();
        } catch (e) {
            event.archived = before;
            lastKey = '';
            render();
            window.app?.showToast('归档失败，请重试', 'error');
        }
    }

    // 文档级关闭路径的处理器（重复挂载时先摘旧的，避免叠加）
    let docHandlers = null;

    /**
     * 文档级的关闭路径：**只剩渠道菜单**。点在筛选行以外就收起它。
     *
     * 原来这里还管着一套「⋯」菜单（列表里的定位/抬升/popover 关闭）——那个菜单已经
     * 删掉了（归档改成右上角一个按钮），相关机件（MENU_EDGE / adjustMenu /
     * closeMenus / is-menu-open 抬升）一并删除。⚠️ 别把渠道菜单这一套一起删了。
     */
    function onDocPointerDown(event) {
        const target = event.target;
        if (openChannel && !(target && target.closest && target.closest('.special-line-filters'))) {
            openChannel = null;
            lastChipsKey = '';
            renderChips();
        }
    }

    function onDocKeyDown(event) {
        if (event.key !== 'Escape' || !openChannel) return;
        const type = openChannel;
        openChannel = null;
        lastChipsKey = '';
        renderChips();
        // 焦点别留在被收起的按钮上
        chipsEl?.querySelector(`[data-action="channel"][data-value="${type}"]`)?.focus?.();
    }

    // ================= 保存文章对话框 =================

    function ensureSaveDialog() {
        if (saveDialog) return saveDialog;
        // 用平台设置弹窗那一套（.ui-dialog-overlay + .ui-dialog）：居中面板 + 同款遮罩，
        // 点遮罩或按 Esc 关闭。此前是原生 <dialog> + showModal()，位置与观感都和
        // 后台设置弹窗不一致（用户要求「和其他设置弹窗一样」）。
        const dlg = document.createElement('div');
        dlg.className = 'ui-dialog-overlay';
        dlg.hidden = true;
        dlg.innerHTML = `
            <div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="specialLineDialogTitle">
            <h2 id="specialLineDialogTitle">保存到稍后阅读</h2>
            <p class="special-line-dialog-hint">只填链接就行；标题与摘要留空时会自动抓取，抓不到就用链接本身当标题。</p>
            <form class="special-line-form" novalidate>
                <label>文章链接（必填）
                    <input id="specialLineUrl" name="url" type="url" inputmode="url" autocomplete="url"
                           placeholder="https://…" maxlength="2048" required>
                </label>
                <label>标题（选填）
                    <input id="specialLineTitle" name="title" autocomplete="off"
                           placeholder="留空自动获取" maxlength="${TITLE_MAX}">
                </label>
                <details id="specialLineSummaryDetails">
                    <summary>摘要（选填）</summary>
                    <label>摘要
                        <textarea id="specialLineSummary" name="summary" rows="3"
                                  maxlength="${SUMMARY_MAX}" placeholder="留空自动获取"></textarea>
                    </label>
                </details>
                <p class="special-line-form-error" role="alert" hidden></p>
                <footer class="special-line-form-actions">
                    <button class="btn" type="button" data-action="cancel-save">取消</button>
                    <button class="btn btn-primary" type="submit">保存</button>
                </footer>
            </form>
            </div>`;
        document.body.appendChild(dlg);

        const urlEl = dlg.querySelector('#specialLineUrl');
        const titleEl = dlg.querySelector('#specialLineTitle');
        const summaryEl = dlg.querySelector('#specialLineSummary');
        const errEl = dlg.querySelector('.special-line-form-error');

        function closeSaveDialog() {
            if (dlg.hidden) return;
            // 草稿留下：取消 / Esc / 点遮罩关掉再打开，内容还在
            saveDraft = { url: urlEl.value, title: titleEl.value, summary: summaryEl.value };
            dlg.hidden = true;
            if (saveTrigger && document.contains(saveTrigger)) saveTrigger.focus();
        }

        dlg.addEventListener('input', () => {
            errEl.hidden = true;
            dlg.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
        });

        dlg.querySelector('[data-action="cancel-save"]').addEventListener('click', closeSaveDialog);
        // 与平台弹窗一致：点面板以外（遮罩）关闭
        dlg.addEventListener('pointerdown', event => { if (event.target === dlg) closeSaveDialog(); });
        // Esc 关闭。挂在 document 上：焦点可能不在面板内（面板不是模态 <dialog>，没有焦点陷阱）
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !dlg.hidden) closeSaveDialog();
        });

        function fail(message, field) {
            errEl.textContent = message;
            errEl.hidden = false;
            if (field) {
                field.setAttribute('aria-invalid', 'true');
                field.focus();
            }
        }

        dlg.querySelector('form').addEventListener('submit', async event => {
            event.preventDefault();
            const url = urlEl.value.trim();
            const title = titleEl.value.trim();
            let parsed = null;
            try { parsed = new URL(url); } catch { parsed = null; }
            if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
                fail('请填写有效的 http 或 https 文章链接。', urlEl);
                return;
            }
            // 标题改为选填：留空时由服务端抓取（用户要求「只需填链接就行」）
            const submit = dlg.querySelector('button[type="submit"]');
            submit.disabled = true;
            try {
                const data = await api.post('/api/timeline/articles', {
                    url, title, summary: summaryEl.value.trim()
                });
                if (data && data.error) {
                    fail(data.error);
                    return;
                }
                // 成功了才清草稿；否则关掉再打开要能接着改。
                // ⚠️ 必须**先把输入框清空再 close()**：close 监听会把当前输入框的
                // 值回采进 saveDraft，只把 saveDraft 赋空是无效的。
                urlEl.value = '';
                titleEl.value = '';
                summaryEl.value = '';
                saveDraft = { url: '', title: '', summary: '' };
                closeSaveDialog();
                window.app?.showToast(data && data.event && data.event.titleFromUrl
                    ? '已保存；未能自动获取标题，暂用链接当标题'
                    : '已保存到稍后阅读');
                refresh();
            } catch (e) {
                fail(e && e.status === 429 ? '请求过于频繁，请稍后再试' : '保存失败，请重试');
            } finally {
                submit.disabled = false;
            }
        });

        saveDialog = dlg;
        return dlg;
    }

    function openSaveDialog(trigger) {
        const dlg = ensureSaveDialog();
        saveTrigger = trigger || null;
        dlg.querySelector('#specialLineUrl').value = saveDraft.url || '';
        dlg.querySelector('#specialLineTitle').value = saveDraft.title || '';
        dlg.querySelector('#specialLineSummary').value = saveDraft.summary || '';
        dlg.querySelector('#specialLineSummaryDetails').open = false;
        const errEl = dlg.querySelector('.special-line-form-error');
        errEl.hidden = true;
        errEl.textContent = '';
        dlg.hidden = false;
        dlg.querySelector('#specialLineUrl').focus();
    }

    // ================= 后台：来源管理 =================

    const STATUS_TEXT = {
        ok: '已连接',
        pending: '待授权',
        expired: '授权失效',
        paused: '已暂停',
        failed: '同步失败'
    };

    function renderAdminSection(host, state) {
        const adminApi = (state && state.api) || api;
        // 平台注入的服务（后台区块的契约，见 docs/architecture.md）：提示与对话框
        // 都由平台给，模块不必去够 window.app。取不到时退回 window.app?.——
        // 那是给「平台还没注入」的过渡态留的兜底，不是设计。
        // ⚠️ 兜底里必须写 window.app，不能写成 `toast(...)`：那是在定义它自己，
        // 一调用就无限递归（本轮改这句时真踩了一次）。
        const toast = (state && state.toast)
            || ((message, kind) => window.app?.showToast(message, kind));
        const dialog = (state && state.dialog)
            || (options => window.app?.showUiDialog(options));
        if (!adminApi) {
            host.innerHTML = '<p class="fav-hint">未拿到 API，无法读取来源。</p>';
            return;
        }

        let providers = [];
        let form = null;
        let adminBusy = false;

        async function load() {
            host.innerHTML = '<p class="fav-hint">加载中…</p>';
            try {
                const data = await adminApi.get('/api/timeline/sources');
                providers = Array.isArray(data && data.providers) ? data.providers : [];
                draw(Array.isArray(data && data.sources) ? data.sources : []);
            } catch (e) {
                console.error('Load timeline sources failed:', e);
                host.innerHTML = '<p class="fav-hint">' +
                    (e && e.status === 429 ? '请求过于频繁，请等一分钟再重试。' : '来源列表加载失败，请重开面板重试。') +
                    '</p>';
            }
        }

        function providerFor(id) {
            return providers.find(p => p.id === id);
        }

        function submitText() {
            return form && form.mode === 'edit' ? '保存配置'
                : form && form.mode === 'reauth' ? '重新授权' : '保存并测试';
        }

        function rowHTML(s) {
            const provider = providerFor(s.providerType);
            const needsCredentials = provider && provider.requiresCredentials;
            const canReauth = needsCredentials && (!s.hasCredentials || s.status === 'expired' || s.status === 'pending');
            const actions = [];
            if (canReauth) {
                actions.push(`<button class="btn" type="button" data-act="reauth" data-id="${esc(s.id)}">重新授权</button>`);
            } else {
                actions.push(`<button class="btn" type="button" data-act="test" data-id="${esc(s.id)}">测试连接</button>`);
            }
            actions.push(`<button class="btn" type="button" data-act="edit" data-id="${esc(s.id)}">编辑</button>`);
            actions.push(`<button class="btn" type="button" data-act="sync" data-id="${esc(s.id)}">立即同步</button>`);
            actions.push(`<button class="btn" type="button" data-act="toggle" data-id="${esc(s.id)}">${s.enabled ? '停止监控' : '启用监控'}</button>`);
            actions.push(`<button class="btn btn-danger" type="button" data-act="del" data-id="${esc(s.id)}">删除</button>`);
            const err = s.lastError
                ? `<div class="special-line-source-error">${esc(s.lastError.message || '')}</div>`
                : '';
            return `<div class="special-line-source-row" data-id="${esc(s.id)}">` +
                `<span class="special-line-icon" aria-hidden="true">${esc(s.providerSymbol || '·')}</span>` +
                `<div class="special-line-source-copy">` +
                    `<strong>${esc(s.providerLabel)}${s.externalKey ? ' · ' + esc(s.externalKey) : ''}</strong>` +
                    `<small>每 ${esc(s.syncIntervalMs / 60000)} 分钟 · 自动监控${s.enabled ? '已启用' : '已停止'}</small>` +
                    `<small>${s.lastSuccessAt ? `最近成功 ${esc(relTime(s.lastSuccessAt))}` : '尚未同步成功'}` +
                        `${needsCredentials && !s.hasCredentials ? ' · 未配置凭据' : ''}` +
                        `${nextSyncHTML(s)}</small>` +
                    err +
                `</div>` +
                `<span class="special-line-source-state" data-status="${esc(s.status)}">${esc(STATUS_TEXT[s.status] || s.status)}</span>` +
                `<div class="special-line-source-actions">${actions.join('')}</div>` +
            `</div>`;
        }

        function formHTML() {
            if (!form) return '';
            const editing = form.mode !== 'add';
            const current = providerFor(form.providerType);
            if (!current) return '<p class="fav-hint">暂无可用订阅平台，请重新加载。</p>';
            const intervals = current.syncIntervalsMs || [];
            if (!intervals.includes(form.syncIntervalMs)) form.syncIntervalMs = current.defaultSyncIntervalMs;
            const providerOptions = providers.map(p =>
                `<option value="${esc(p.id)}" ${p.id === form.providerType ? 'selected' : ''}>${esc(p.label)}</option>`
            ).join('');
            const intervalOptions = intervals.map(ms =>
                `<option value="${ms}" ${ms === form.syncIntervalMs ? 'selected' : ''}>${ms / 60000} 分钟</option>`
            ).join('');
            const credential = current.requiresCredentials
                ? `<label>${esc(current.credentialLabel)}
                    <input name="token" type="password" autocomplete="off"
                        placeholder="${editing ? '留空表示保留原值' : '在平台开发者后台获取'}" value="${esc(form.token || '')}">
                   </label>` : '';
            return `<form class="special-line-source-form">
                <label>平台
                    <select name="providerType" ${editing ? 'disabled' : ''}>${providerOptions}</select>
                </label>
                <label>${esc(current.accountLabel)}
                    <input name="externalKey" autocomplete="off" value="${esc(form.externalKey || '')}"
                        ${form.mode === 'edit' ? 'readonly' : ''}>
                </label>
                ${credential}
                <label>监控周期
                    <select name="syncIntervalMs">${intervalOptions}</select>
                </label>
                <div class="special-line-form-actions">
                    <button class="btn" type="button" data-act="form-cancel">取消</button>
                    <button class="btn btn-primary" type="submit">${submitText()}</button>
                </div>
            </form>`;
        }

        function draw(list) {
            const rows = list.filter(s => s.providerType !== 'manual');
            host.innerHTML =
                `<p class="fav-hint">X 通过 FxEmbed 在服务端采集，只需填写用户名；微博需配置 Access Token。` +
                `每条来源独立设置周期。停止仅影响自动监控，仍可立即同步，历史内容保留。</p>` +
                `<div class="special-line-source-list">${rows.length ? rows.map(rowHTML).join('') : '<p class="fav-hint">还没有订阅来源。</p>'}</div>` +
                `<button class="btn" id="specialLineAddSource">＋ 添加订阅来源</button>` +
                formHTML() +
                `<p class="special-line-source-note">添加来源前会测试连通，失败不保存。监控周期与平台页面刷新周期互不影响。</p>`;
            bind(list);
        }

        function bind(list) {
            host.querySelector('#specialLineAddSource')?.addEventListener('click', () => {
                if (adminBusy) return;
                form = { mode: 'add', providerType: providers[0]?.id, externalKey: '',
                    syncIntervalMs: providers[0]?.defaultSyncIntervalMs };
                draw(list);
                host.querySelector('.special-line-source-form input[name="externalKey"]')?.focus();
            });

            host.querySelectorAll('.special-line-source-form [data-act="form-cancel"]').forEach(btn => {
                btn.addEventListener('click', () => { if (!adminBusy) { form = null; draw(list); } });
            });

            host.querySelector('.special-line-source-form [name="providerType"]')?.addEventListener('change', event => {
                if (adminBusy || !form || form.mode !== 'add') return;
                const el = event.currentTarget.closest('form');
                form.externalKey = el.querySelector('[name="externalKey"]').value;
                form.syncIntervalMs = Number(el.querySelector('[name="syncIntervalMs"]').value);
                form.providerType = event.currentTarget.value;
                form.token = '';
                draw(list);
                host.querySelector('.special-line-source-form [name="providerType"]')?.focus();
            });

            host.querySelector('.special-line-source-form')?.addEventListener('submit', async event => {
                event.preventDefault();
                if (adminBusy) return;
                const el = event.currentTarget;
                const providerType = el.querySelector('[name="providerType"]').value;
                const externalKey = el.querySelector('[name="externalKey"]').value.trim();
                const provider = providerFor(providerType);
                const token = provider?.requiresCredentials ? el.querySelector('[name="token"]')?.value : undefined;
                const syncIntervalMs = Number(el.querySelector('[name="syncIntervalMs"]').value);
                if (!externalKey) {
                    toast('请填写账号标识', 'error');
                    return;
                }
                if (form.mode === 'add' && provider?.requiresCredentials && !token) {
                    toast('请填写凭据', 'error');
                    return;
                }
                adminBusy = true;
                const submit = el.querySelector('button[type="submit"]');
                const controls = Array.from(el.querySelectorAll('input, select, button'));
                const disabled = controls.map(control => control.disabled);
                controls.forEach(control => { control.disabled = true; });
                submit.textContent = form.mode === 'edit' ? '保存中…' : '测试中…';
                try {
                    if (form.mode === 'add') {
                        const data = await adminApi.post('/api/timeline/sources', {
                            providerType, externalKey, syncIntervalMs, ...(token ? { token } : {})
                        });
                        if (data && data.error) throw Object.assign(new Error(data.error), { status: 400 });
                        toast('来源已添加');
                    } else {
                        const { res, data } = await adminApi.request(
                            `/api/timeline/sources/${encodeURIComponent(form.id)}`,
                            {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ syncIntervalMs,
                                    ...(form.mode === 'reauth' ? { externalKey } : {}),
                                    ...(token ? { token } : {}) })
                            });
                        if (!res.ok) {
                            throw Object.assign(new Error((data && data.error) || '保存失败'), { status: res.status });
                        }
                        toast(form.mode === 'edit' ? '监控配置已保存' : '已更新授权');
                    }
                    form = null;
                    await load();
                } catch (e) {
                    toast(e.message || '操作失败', 'error');
                } finally {
                    controls.forEach((control, i) => { control.disabled = disabled[i]; });
                    submit.textContent = submitText();
                    adminBusy = false;
                }
            });

            host.querySelectorAll('[data-act]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (adminBusy) return;
                    const id = btn.dataset.id;
                    const source = list.find(s => s.id === id);
                    if (!source) return;
                    adminBusy = true;
                    btn.disabled = true;
                    try {
                    switch (btn.dataset.act) {
                        case 'edit':
                        case 'reauth':
                            form = {
                                mode: btn.dataset.act, id,
                                providerType: source.providerType,
                                externalKey: source.externalKey,
                                syncIntervalMs: source.syncIntervalMs
                            };
                            draw(list);
                            host.querySelector('.special-line-source-form [name="syncIntervalMs"]')?.focus();
                            break;
                        case 'test': {
                            btn.disabled = true;
                            try {
                                const data = await adminApi.post(
                                    `/api/timeline/sources/${encodeURIComponent(id)}/test`, {});
                                toast(
                                    data && data.ok ? '连接正常' : `连接失败：${(data && data.error) || '未知原因'}`,
                                    data && data.ok ? 'success' : 'error');
                            } catch (e) {
                                toast('测试失败，请重试', 'error');
                            } finally {
                                btn.disabled = false;
                            }
                            break;
                        }
                        case 'sync': {
                            btn.disabled = true;
                            try {
                                const data = await adminApi.post(
                                    `/api/timeline/sources/${encodeURIComponent(id)}/sync`, {});
                                if (data && data.ok) {
                                    toast(data.skipped
                                        ? '已跳过（来源已暂停）' : `同步完成，新增 ${data.inserted} 条`);
                                } else {
                                    toast(`同步失败：${(data && data.error) || '未知原因'}`, 'error');
                                }
                            } catch (e) {
                                toast('同步失败，请重试', 'error');
                            } finally {
                                btn.disabled = false;
                                load();
                            }
                            break;
                        }
                        case 'toggle': {
                            const { res, data } = await adminApi.request(
                                `/api/timeline/sources/${encodeURIComponent(id)}`,
                                {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ enabled: !source.enabled })
                                });
                            if (!res.ok) throw new Error((data && data.error) || '操作失败，请重试');
                            toast(source.enabled ? '自动监控已停止' : '自动监控已启用');
                            await load();
                            break;
                        }
                        case 'del': {
                            const confirmed = dialog
                                ? await dialog({
                                    title: '删除订阅来源',
                                    message: `删除「${source.providerLabel} · ${source.externalKey}」会同时删除它已同步的事件。`,
                                    danger: true, confirmText: '删除'
                                })
                                : false;
                            if (!confirmed) return;
                            const { res, data } = await adminApi.request(
                                `/api/timeline/sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
                            if (res.ok) toast('已删除');
                            else toast((data && data.error) || '删除失败', 'error');
                            load();
                            break;
                        }
                    }
                    } catch (e) {
                        toast(e.message || '操作失败，请重试', 'error');
                    } finally {
                        adminBusy = false;
                        btn.disabled = false;
                    }
                });
            });
        }

        load();
    }

    // ================= 挂载 =================

    function mountWidget(shell, state) {
        api = (state && state.api) || null;
        requestStack = (state && state.requestStack) || null;
        if (!api) {
            const box = document.createElement('div');
            box.className = 'module-widget-error';
            box.textContent = '模块未拿到 API（平台接口变化）';
            return [box];
        }

        const card = document.createElement('section');
        card.className = 'module-card special-line-card';
        card.dataset.instanceId = 'special-line:main';

        // ---- 头：标题 + 副标题 + 状态 + 同步 / 保存 + 拖拽把手 ----
        const head = document.createElement('div');
        head.className = 'module-widget-head special-line-head';

        const label = document.createElement('span');
        label.className = 'module-widget-title';
        label.textContent = 'Special Line';

        // 副标题「动态 · 稍后阅读」已按用户要求去掉：顶部只留最近同步时间。

        headStatus = document.createElement('span');
        headStatus.className = 'special-line-status';

        const syncBtn = document.createElement('button');
        syncBtn.type = 'button';
        syncBtn.className = 'special-line-iconbtn';
        syncBtn.dataset.action = 'sync';
        syncBtn.title = '立即同步所有已启用的订阅';
        syncBtn.setAttribute('aria-label', '立即同步所有已启用的订阅');
        syncBtn.textContent = '↻';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'special-line-iconbtn special-line-save';
        saveBtn.dataset.action = 'save';
        saveBtn.title = '保存文章到稍后阅读';
        saveBtn.setAttribute('aria-label', '保存文章到稍后阅读');
        saveBtn.textContent = '＋ 保存';

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'module-drag-handle';
        handle.title = '拖拽调整位置';
        handle.setAttribute('aria-label', '拖拽调整 Special Line 的位置');
        // 显隐交给平台的 .module-zone.is-editing 规则，不在这里写 hidden

        head.append(label, headStatus, syncBtn, saveBtn, handle);

        // ---- 筛选 chips（只建容器，内容随来源变化）----
        chipsEl = document.createElement('nav');
        chipsEl.className = 'special-line-filters';
        chipsEl.setAttribute('aria-label', '时间线筛选');

        // ---- 列表（自身滚动，卡片高度有上限）----
        listEl = document.createElement('div');
        listEl.className = 'special-line-listwrap';
        // 可聚焦的滚动区域：底部没有「加载更早事件」按钮后，键盘用户靠它滚动，
        // 滚到底部照样触发懒加载（WAI-ARIA 也建议滚动区域可聚焦）。
        listEl.tabIndex = 0;
        listEl.setAttribute('role', 'region');
        listEl.setAttribute('aria-label', '时间线事件列表');

        footEl = document.createElement('div');
        footEl.className = 'special-line-foot';

        card.append(head, chipsEl, listEl, footEl);

        // 事件委托挂在**整张卡**上：列表内部会重写，委托在卡上才不会被换掉
        card.addEventListener('click', event => {
            const target = event.target.closest('[data-action]');
            if (!target) return;

            const action = target.dataset.action;
            const id = target.dataset.id;
            switch (action) {
                case 'sync':
                    syncAllSources();
                    break;
                case 'retry':
                    refresh({ manual: true });
                    break;
                case 'reload':
                    refresh();
                    break;
                case 'save':
                    openSaveDialog(target);
                    break;
                case 'original': {
                    if (!id) break;
                    if (showOriginalIds.has(id)) showOriginalIds.delete(id);
                    else showOriginalIds.add(id);
                    lastKey = '';
                    render();
                    break;
                }
                case 'expand': {
                    if (!id) break;
                    if (expandedIds.has(id)) expandedIds.delete(id);
                    else expandedIds.add(id);
                    lastKey = '';
                    render();
                    break;
                }
                case 'channel':
                    // 再点一次收起；点另一个渠道则改开它（只留一个展开）
                    openChannel = openChannel === target.dataset.value ? null : target.dataset.value;
                    lastChipsKey = '';
                    renderChips();
                    break;
                case 'filter-source':
                    filterSelectionRevision++;
                    openChannel = null;
                    filterSource = target.dataset.value || '';
                    lastChipsKey = '';
                    renderChips();
                    refresh({ filterChange: true });
                    break;
                case 'filter-view':
                    filterSelectionRevision++;
                    openChannel = null;
                    filterView = target.dataset.value || 'all';
                    lastChipsKey = '';
                    renderChips();
                    refresh({ filterChange: true });
                    break;
                case 'reset-filters':
                    filterSelectionRevision++;
                    openChannel = null;
                    filterSource = '';
                    filterView = 'all';
                    lastChipsKey = '';
                    renderChips();
                    refresh({ filterChange: true });
                    break;
                case 'favorite': {
                    const e = events.find(x => x.id === id);
                    if (e) setFavorite(e, !e.favorited);
                    break;
                }
                case 'archive': {
                    const e = events.find(x => x.id === id);
                    if (e) setArchived(e, !e.archived);
                    break;
                }
            }
        });

        // 外部点击与 Esc 关闭菜单（此前只有「再点 ⋯ / 点别的 ⋯ / 切筛选 / 重渲染」四条路径）
        if (docHandlers) {
            document.removeEventListener('pointerdown', docHandlers.pointerdown, true);
            document.removeEventListener('keydown', docHandlers.keydown);
        }
        docHandlers = { pointerdown: onDocPointerDown, keydown: onDocKeyDown };
        document.addEventListener('pointerdown', onDocPointerDown, true);
        document.addEventListener('keydown', onDocKeyDown);

        renderChips();
        render();
        const firstRound = refresh();
        schedulePolling();
        if (state && typeof state.whenReady === 'function') state.whenReady(firstRound);
        return [card];
    }

    window.app.registerModule({
        id: 'special-line',
        title: 'Special Line',
        summary: '登录后可用 · 社交订阅与稍后阅读汇成一条时间线',
        // 启用后默认停靠在首页右侧空白区；用户拖过之后以保存的位置为准。
        defaultSide: 'right',
        // 内容不是一张摘要卡而是一条时间线：需要一条**宽**列才用得上仿真那套版式
        // （左侧日期轨道 + 事件卡）。平台据此让背板让位，见 app.js 的 railLayoutFor / syncRail。
        wideRail: true,
        // 模块名已经是块标题（「Special Line」），这里只写配置区自己的名字
        adminSectionTitle: '订阅来源',
        mountWidget,
        renderAdminSection
    });
})();

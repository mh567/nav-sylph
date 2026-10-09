/**
 * Special Line 时间线模块。
 *
 * 时间线**内联显示在首页右侧那一列里**，形态与仿真样例（docs/mockup-special-line.html）
 * 一致：左侧日期轨道 + 贯穿节点线 + 事件卡 + chips 筛选；不是「摘要卡 + 点开弹窗」。
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
    let unreadCount = 0;
    let nextCursor = null;
    let hasMore = false;
    let syncState = 'synced';   // syncing | synced | failed
    let syncFailed = [];
    let lastSync = null;
    let listError = null;
    let busy = false;

    let filterSource = '';      // '' = 全部来源
    let filterView = 'all';     // all | unread | archived
    let appliedFilterSource = '';
    let appliedFilterView = 'all';
    let filterTransition = false;
    let filterRefreshPending = false;

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

        return `<li class="special-line-item" data-unread="${e.unread ? 'true' : 'false'}">` +
            `<time class="special-line-time"><strong>${esc(dayLabel(e.occurredAt))}</strong>${hm(e.occurredAt)}</time>` +
            `<article class="special-line-event">` +
                `<div class="special-line-meta">` +
                    authorHTML(e) +
                    `<span class="special-line-type">${esc(e.eventTypeLabel || '')}` +
                        `${useZh ? '<span class="special-line-badge">译</span>' : ''}</span>` +
                    `<span class="sr-only">${e.unread ? '未读' : '已读'}</span>` +
                    `<details class="special-line-tools">` +
                        `<summary aria-label="事件操作" title="事件操作">⋯</summary>` +
                        `<div class="special-line-actions" popover="manual">` +
                            `<button class="special-line-action" type="button" data-action="read" data-id="${esc(e.id)}"` +
                                ` aria-pressed="${e.unread ? 'false' : 'true'}">${e.unread ? '标为已读' : '标为未读'}</button>` +
                            `<button class="special-line-action" type="button" data-action="archive" data-id="${esc(e.id)}"` +
                                ` aria-pressed="${e.archived ? 'true' : 'false'}">${e.archived ? '取消归档' : '归档'}</button>` +
                        `</div>` +
                    `</details>` +
                `</div>` +
                `<h3>${linked}</h3>` +
                bodyHTML +
                (e.quote ? `<blockquote>${esc(e.quote)}</blockquote>` : '') +
                (actions.length ? `<div class="special-line-row-actions">${actions.join('')}</div>` : '') +
                `<div class="special-line-stamp">${relTime(e.occurredAt)}</div>` +
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
            events.map(e => `${e.id}:${e.unread}:${e.archived}:${relTime(e.occurredAt)}` +
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
        // 每次点「已读 / 未读 / 全部来源 / 稍后阅读」都会闪空；更糟的是
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
            // 底部只留一行：还有更早就给按钮（键盘路径），到底了说明保留窗口。
            // ⚠️ 「仅保留最近 30 天」只对社交订阅成立——「稍后阅读」不参与时限清理，
            // 空列表也谈不上「已到最早一条」，这两种情况都不能显示这句话。
            const socialView = filterSource !== 'manual';
            footEl.innerHTML = hasMore
                ? '<button class="special-line-btn" type="button" data-action="more">加载更早事件</button>' +
                  '<div class="special-line-footnote">向下滚动会自动加载更早事件</div>'
                : (events.length && socialView
                    ? '<div class="special-line-footnote">已到最早一条 · 仅保留最近 30 天</div>'
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
        if (loadingMore || inFlight || !hasMore) return;
        loadingMore = true;
        refresh({ append: true }).finally(() => { loadingMore = false; });
    }

    // ================= 筛选 chips =================

    function chipsKey() {
        return sources.map(s => `${s.id}:${s.providerLabel}:${s.externalKey}`).join('|') +
            '>' + filterSource + '>' + filterView;
    }

    function renderChips() {
        if (!chipsEl) return;
        const key = chipsKey();
        if (key === lastChipsKey) return;
        lastChipsKey = key;

        const chip = (value, label, kind) =>
            `<button class="special-line-chip" type="button" data-action="${kind}" data-value="${esc(value)}"` +
            ` aria-pressed="${(kind === 'filter-source' ? filterSource : filterView) === value}">${esc(label)}</button>`;

        let html = chip('', '全部来源', 'filter-source');
        for (const s of sources) {
            if (s.providerType === 'manual') continue;
            html += chip(s.id, s.providerLabel + (s.externalKey ? ' · ' + s.externalKey : ''), 'filter-source');
        }
        // 「稍后阅读」是固定入口，不是一条可配置来源——它永远在
        html += chip('manual', '稍后阅读', 'filter-source');
        html += '<span class="special-line-sep" aria-hidden="true"></span>';
        html += chip('all', '全部', 'filter-view');
        html += chip('unread', '未读', 'filter-view');
        html += chip('archived', '已归档', 'filter-view');
        chipsEl.innerHTML = html;
    }

    // ================= 轮询 =================

    function applyPayload(data) {
        events = Array.isArray(data.events) ? data.events : [];
        unreadCount = Number(data.unreadCount) || 0;
        if (Array.isArray(data.sources)) sources = data.sources;
        syncFailed = (data.sync && Array.isArray(data.sync.failed)) ? data.sync.failed : [];
        nextCursor = data.nextCursor || null;
        hasMore = !!data.hasMore;
        lastSync = Date.now();
        syncState = syncFailed.length ? 'failed' : 'synced';
        listError = null;
    }

    /** @param {{append?: boolean, manual?: boolean, filterChange?: boolean}} [opts] */
    async function refresh({ append = false, manual = false, filterChange = false } = {}) {
        if (inFlight) {
            if (filterChange) {
                filterRefreshPending = true;
                filterTransition = true;
                lastKey = '';
                render();
            }
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
                unreadCount = Number(data.unreadCount) || unreadCount;
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
                // 用户在上一次筛选请求尚未完成时又点了别的 chips：丢弃过时响应后
                // 立即只拉**最后选择**的条件，不闪回中间筛选的旧结果。
                filterRefreshPending = false;
                return refresh({ filterChange: true });
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
            render();
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

    async function setRead(event, read) {
        const before = event.unread;
        event.unread = !read;
        unreadCount = Math.max(0, unreadCount + (read ? -1 : 1));
        lastKey = '';
        render();
        try {
            await api.post(`/api/timeline/events/${encodeURIComponent(event.id)}/read`, { read });
        } catch (e) {
            event.unread = before;
            unreadCount = Math.max(0, unreadCount + (read ? 1 : -1));
            lastKey = '';
            render();
            window.app?.showToast('标记失败，请重试', 'error');
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

    /**
     * 「⋯」菜单贴着列表底边时要往上弹。
     *
     * 列表是**滚动容器**（卡片高度有上限），菜单是绝对定位的——朝下弹到容器外
     * 会被 overflow 裁掉。所以打开后量一次，超出就翻上去。
     */
    // 菜单与容器边界之间留的间隙（回退路径的上翻与夹取共用同一个值）
    const MENU_EDGE = 4;
    // 文档级关闭路径的处理器（重复挂载时先摘旧的，避免叠加）
    let docHandlers = null;

    /** 收起菜单里的 popover（不支持 popover 的浏览器是空操作）。 */
    function hideMenuPopover(menu) {
        if (!menu || typeof menu.hidePopover !== 'function') return;
        try { if (menu.matches(':popover-open')) menu.hidePopover(); } catch { /* 视为已关闭 */ }
    }

    function adjustMenu(details) {
        if (!details || !listEl) return;
        const item = details.closest('.special-line-item');
        if (item) item.classList.toggle('is-menu-open', details.open);
        details.classList.remove('is-up');
        const menu = details.querySelector('.special-line-actions');
        if (menu) {
            menu.style.position = ''; menu.style.top = ''; menu.style.left = '';
            menu.style.right = ''; menu.style.bottom = '';
        }
        if (!details.open || !menu) { hideMenuPopover(menu); return; }

        // ⚠️ 首选把菜单放进 **top layer**（popover）：top layer 不被任何祖先的 overflow 裁剪，
        // 于是菜单可以保持「紧贴按钮」的位置。这正是问题所在——滚动容器（overflow:auto）会裁掉
        // 越界的菜单；此前的两种补救都有副作用：上翻会在列表矮时越出顶边被裁（被筛选行那条带
        // 「遮挡」），往容器内夹又会把菜单顶到离按钮很远的地方（用户报的「位置很奇怪」）。
        // popover 一次解决两件事，且不动 DOM（点击委托仍挂在卡片上）。
        if (typeof menu.showPopover === 'function') {
            try { menu.showPopover(); } catch { /* 已打开 */ }
            // ⚠️ top layer 的包含块是**视口**（UA 还会带 inset:0 + margin:auto），
            //    所以坐标必须显式给：贴按钮下方，放不下就翻上去，最后按视口夹取。
            const btn = details.getBoundingClientRect();
            const box = menu.getBoundingClientRect();
            const vh = window.innerHeight, vw = window.innerWidth;
            let top = btn.bottom + MENU_EDGE;
            if (top + box.height > vh - MENU_EDGE) top = Math.max(MENU_EDGE, btn.top - MENU_EDGE - box.height);
            const left = Math.max(MENU_EDGE, Math.min(btn.right - box.width, vw - MENU_EDGE - box.width));
            menu.style.position = 'fixed';
            menu.style.top = top + 'px';
            menu.style.left = left + 'px';
            menu.style.right = 'auto';
            menu.style.bottom = 'auto';
            return;
        }

        // 回退（不支持 popover 的浏览器）：保持原有的上翻 + 夹取
        const wrap = listEl.getBoundingClientRect();
        if (menu.getBoundingClientRect().bottom > wrap.bottom - MENU_EDGE) details.classList.add('is-up');
        const menuRect = menu.getBoundingClientRect();
        if (menuRect.top < wrap.top + MENU_EDGE || menuRect.bottom > wrap.bottom - MENU_EDGE) {
            const detailsRect = details.getBoundingClientRect();
            const clamped = Math.max(wrap.top + MENU_EDGE,
                Math.min(menuRect.top, wrap.bottom - MENU_EDGE - menuRect.height));
            menu.style.top = (clamped - detailsRect.top) + 'px';
            menu.style.bottom = 'auto';
        }
    }

    function closeMenus(except) {
        if (!listEl) return;
        for (const d of listEl.querySelectorAll('.special-line-tools[open]')) {
            if (d === except) continue;
            d.open = false;
            d.closest('.special-line-item')?.classList.remove('is-menu-open');
            // 与 adjustMenu 对称：清掉 inline 定位，并收起 popover
            const m = d.querySelector('.special-line-actions');
            if (m) {
                m.style.position = ''; m.style.top = ''; m.style.left = '';
                m.style.right = ''; m.style.bottom = '';
                hideMenuPopover(m);
            }
        }
    }

    /**
     * 文档级的关闭路径。此前只有「再点一次 ⋯」「点别的 ⋯」「切筛选」「重渲染」四条，
     * 于是**点空白处与按 Esc 都关不掉**（用户报的「点击空白处也不会消失」）。
     * 用 pointerdown 的捕获阶段：先于 click，不至于让同一次点击又把它打开。
     */
    function onDocPointerDown(event) {
        if (!listEl) return;
        const open = listEl.querySelector('.special-line-tools[open]');
        if (!open) return;
        if (event.target && event.target.closest('.special-line-tools')) return;   // 点在按钮或菜单里
        closeMenus();
    }

    function onDocKeyDown(event) {
        if (event.key !== 'Escape' || !listEl) return;
        if (!listEl.querySelector('.special-line-tools[open]')) return;
        closeMenus();
        const chip = listEl.closest('.special-line-card')?.querySelector('.special-line-chip');
        chip?.focus?.();   // 焦点别留在被收起的按钮上
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
                        `${needsCredentials && !s.hasCredentials ? ' · 未配置凭据' : ''}</small>` +
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
        syncBtn.title = '立即同步';
        syncBtn.setAttribute('aria-label', '立即同步');
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

        footEl = document.createElement('div');
        footEl.className = 'special-line-foot';

        card.append(head, chipsEl, listEl, footEl);

        // 事件委托挂在**整张卡**上：列表内部会重写，委托在卡上才不会被换掉
        card.addEventListener('click', event => {
            const target = event.target.closest('[data-action], summary');
            if (!target) return;

            // 点「⋯」：开着的时候先把别的收起来，开完再量一次要不要往上弹
            if (target.tagName === 'SUMMARY') {
                const details = target.closest('details');
                closeMenus(details);
                // 开与关都要跑一次：adjustMenu 按 details.open 同步那一行的抬升类。
                setTimeout(() => adjustMenu(details), 0);
                return;
            }

            const action = target.dataset.action;
            const id = target.dataset.id;
            switch (action) {
                case 'sync':
                case 'retry':
                    refresh({ manual: true });
                    break;
                case 'reload':
                    refresh();
                    break;
                case 'save':
                    openSaveDialog(target);
                    break;
                case 'more':
                    loadMore();
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
                case 'filter-source':
                    closeMenus();
                    filterSource = target.dataset.value || '';
                    lastChipsKey = '';
                    renderChips();
                    refresh({ filterChange: true });
                    break;
                case 'filter-view':
                    closeMenus();
                    filterView = target.dataset.value || 'all';
                    lastChipsKey = '';
                    renderChips();
                    refresh({ filterChange: true });
                    break;
                case 'reset-filters':
                    closeMenus();
                    filterSource = '';
                    filterView = 'all';
                    lastChipsKey = '';
                    renderChips();
                    refresh({ filterChange: true });
                    break;
                case 'read': {
                    const e = events.find(x => x.id === id);
                    if (e) setRead(e, e.unread);
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

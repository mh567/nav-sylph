/**
 * 备忘录模块。
 *
 * 登录后可用——模块区整体由登录门控（app.js 的 syncModuleVisibility），
 * 这里不重复判断。数据在服务端 SQLite memos 表：服务器是多端同步的
 * 唯一真相源。本模块按 pollInterval 轮询（挂载拉一次 → 定时拉 →
 * 切回前台立即补拉一次）；写操作在断网时暂存 localStorage，
 * 下次拉取成功后自动补传，卡片显示「N 条待同步」。
 *
 * 冲突策略：last-write-wins（单管理员工具，两端同刻编辑同一条的概率
 * 极低）；固定是即时状态变更，不进离线暂存。
 */
(() => {
    'use strict';

    const DEFAULT_POLL_MS = 15000;
    const DRAFTS_KEY = 'nav-sylph-memo-drafts';
    const TITLE_MAX = 60;
    const BODY_MAX = 10240;
    /** 卡片上最多展示几条摘要 */
    const PREVIEW_ROWS = 3;

    const PIN_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
    const PIN_SVG_BIG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';

    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function hm(ts) {
        const d = new Date(ts);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    function relTime(ts) {
        const s = (Date.now() - ts) / 1000;
        if (s < 60) return '刚刚';
        if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
        if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
        const d = new Date(ts), y = new Date(Date.now() - 86400e3);
        if (d.toDateString() === y.toDateString()) return '昨天 ' + hm(ts);
        return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + hm(ts);
    }

    // ================= 模块级状态 =================

    let pollTimer = null;
    let inFlight = false;
    let pollMs = DEFAULT_POLL_MS;
    let visibilityHandler = null;

    /** 服务器返回的列表（已按 pinned DESC, updated_at DESC 排序） */
    let memos = [];
    let syncState = 'synced'; // syncing | synced | failed
    let lastSync = null;
    /**
     * 平台注入的 API 对象（mountWidget 的 state.api）。
     *
     * ⚠️ 不能写裸 `API`：它是 app.js IIFE 内部的 const，不是全局——
     * 那样写 node --check 过得去、源码里也真有个 API 字样，只有在
     * 浏览器里跑起来才会以 `ReferenceError: API is not defined` 现形
     * （实测：卡片渲染出来了，同步一路失败）。
     */
    let api = null;
    /**
     * 平台注入的纵向重排请求（mountWidget 的 state.requestStack）。
     * 与 api 同一套注入方式——模块不去摸 window.app 上的平台方法。
     */
    let requestStack = null;
    /** 当前挂载的卡片 body（本模块只有一张卡片） */
    let cardBody = null;
    /** 卡片头里的状态区（状态胶囊写在这里，不参与正文的整块重建） */
    let cardStatus = null;

    /** 打开的对话框：{ overlay, panelEl, close } */
    let panel = null;
    let panelView = 'list'; // list | edit
    let editingId = null;   // 备忘录 id 或 'new'
    let confirmDeleteId = null;
    let search = '';
    /** 面板上次渲染时的数据指纹：数据没变就不重渲染（保住搜索框焦点） */
    let lastPanelKey = '';
    /** 卡片上次渲染时的数据指纹：同上，避免每轮轮询整块重写卡片 */
    let lastCardKey = '';
    /** 卡片状态行上次渲染时的指纹 */
    let lastCardStatusKey = '';

    // ================= 离线草稿 =================

    function loadDrafts() {
        try {
            const list = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    let drafts = loadDrafts();

    function persistDrafts() {
        try {
            if (drafts.length) localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
            else localStorage.removeItem(DRAFTS_KEY);
        } catch {
            // 写不进去就只剩内存态：本次会话内暂存仍然有效
        }
    }

    function sortMemos() {
        // 与服务端 ORDER BY pinned DESC, updated_at DESC 一致
        memos.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    }

    function applyMemo(memo) {
        const i = memos.findIndex(m => m.id === memo.id);
        if (i >= 0) memos[i] = memo;
        else memos.push(memo);
        sortMemos();
    }

    // ================= 同步 =================

    function setSyncState(next) {
        syncState = next;
        renderCardMaybe();
        renderPanelMaybe();
    }

    /**
     * @param {{manual?: boolean}} [opts] manual=true 来自「同步 / 重试」按钮。
     *
     * 自动轮询**不**进「同步中」态。用户原话：「不要一直在前台转圈显示刷新，
     * 一是不美观，二是是否会占用更多终端资源」——实测每次轮询都转圈时，
     * 未变动的一轮是 **+15 次 DOM 变更 / +4 次强制重排**（状态胶囊在卡片头里，
     * 翻一次就要把那一行整段换掉）；只在手动同步时提示则是 **+0 / +0**。
     * 数据、同步时刻与失败态仍然照常更新。
     */
    async function poll({ manual = false } = {}) {
        if (inFlight) return;
        inFlight = true;
        if (manual) setSyncState('syncing');
        try {
            const data = await api.get('/api/memos');
            if (!data || !Array.isArray(data.memos)) throw new Error('bad payload');
            memos = data.memos;
            sortMemos();
            lastSync = Date.now();
            // 服务端回当前生效的周期：后台改过之后不必刷新页面
            if (Number.isFinite(data.pollInterval) && data.pollInterval * 1000 !== pollMs) {
                pollMs = data.pollInterval * 1000;
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = setInterval(poll, pollMs);
                }
            }
            setSyncState('synced');
            // 拉取成功说明网络已恢复：补传离线暂存的编辑
            flushDrafts();
        } catch (e) {
            console.error('Memo poll failed:', e);
            setSyncState('failed');
        } finally {
            inFlight = false;
        }
    }

    /**
     * 轮询成功后补传草稿：成功一条删一条。
     * 上一轮拉取刚成功，这里再返回 error 说明草稿本身被拒绝
     * （多半是对应备忘录已在别处删除）——作废，不无限重试。
     * 只有网络异常（fetch 抛错）才保留，等下次拉取。
     */
    async function flushDrafts() {
        if (!drafts.length) return;
        const remaining = [];
        for (const d of drafts) {
            try {
                const data = d.id
                    ? await api.post(`/api/memos/${encodeURIComponent(d.id)}`, { title: d.title, body: d.body })
                    : await api.post('/api/memos', { title: d.title, body: d.body });
                if (data && data.error) {
                    console.warn('Memo draft rejected:', d.id, data.error);
                    continue;
                }
                if (data && data.memo) applyMemo(data.memo);
            } catch (e) {
                remaining.push(d);
            }
        }
        if (remaining.length !== drafts.length) {
            drafts = remaining;
            persistDrafts();
            renderCard();
            renderPanelMaybe();
        }
    }

    /** 只挂表与前后台监听，**不立即拉取**——首轮由 mountWidget 显式拉一次，
     *  好把它的 promise 交给平台（state.whenReady），让模块区带着数据首次布局。 */
    function schedulePolling() {
        if (pollTimer) clearInterval(pollTimer);
        if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
        pollTimer = setInterval(poll, pollMs);

        // 页面不可见时停表：后台 tab 继续轮询只会白耗请求配额；
        // 切回前台时立即补拉一次——手机切回来就能看到另一台设备的新备忘。
        // ⚠️ 重排表必须用可变的 pollMs，写死 15 秒会悄悄打回用户设置的周期。
        visibilityHandler = () => {
            if (document.hidden) {
                clearInterval(pollTimer);
                pollTimer = null;
            } else if (!pollTimer) {
                poll();
                pollTimer = setInterval(poll, pollMs);
            }
        };
        document.addEventListener('visibilitychange', visibilityHandler);
    }

    // ================= 写操作 =================

    /** 保存（新建或编辑）。返回 true 表示已落库；false 为服务端拒绝或已暂存。 */
    async function saveMemo(id, title, body) {
        try {
            const data = id
                ? await api.post(`/api/memos/${encodeURIComponent(id)}`, { title, body })
                : await api.post('/api/memos', { title, body });
            if (data && data.error) {
                window.app?.showToast(data.error, 'error');
                return false;
            }
            if (data && data.memo) applyMemo(data.memo);
            if (id) {
                drafts = drafts.filter(d => d.id !== id);
                persistDrafts();
            }
            lastSync = Date.now();
            setSyncState('synced');
            return true;
        } catch (e) {
            // 断网：暂存到 localStorage，恢复后随轮询自动补传
            if (id) drafts = drafts.filter(d => d.id !== id);
            drafts.push({ id: id || null, title, body, ts: Date.now() });
            persistDrafts();
            renderCard();
            renderPanelMaybe();
            window.app?.showToast('已暂存，恢复网络后自动同步', 'error', 4000);
            return false;
        }
    }

    async function togglePin(memo) {
        // 乐观更新，失败回滚。固定是状态变更，不进离线暂存。
        memo.pinned = !memo.pinned;
        sortMemos();
        renderCard();
        renderPanelMaybe();
        try {
            const data = await api.post(`/api/memos/${encodeURIComponent(memo.id)}/pin`, { pinned: memo.pinned });
            if (data && data.error) throw new Error(data.error);
            window.app?.showToast(memo.pinned ? '已固定到最前' : '已取消固定');
        } catch (e) {
            memo.pinned = !memo.pinned;
            sortMemos();
            renderCard();
            renderPanelMaybe();
            window.app?.showToast('固定状态保存失败', 'error');
        }
    }

    async function deleteMemo(memo) {
        let res, data;
        try {
            ({ res, data } = await api.request(`/api/memos/${encodeURIComponent(memo.id)}`, { method: 'DELETE' }));
        } catch (e) {
            window.app?.showToast('网络异常，删除失败', 'error');
            return;
        }
        if (!res.ok || (data && data.error)) {
            window.app?.showToast((data && data.error) || '删除失败', 'error');
            return;
        }
        memos = memos.filter(m => m.id !== memo.id);
        drafts = drafts.filter(d => d.id !== memo.id);
        persistDrafts();
        confirmDeleteId = null;
        renderCard();
        renderPanelMaybe();
        window.app?.showToast('已删除');
    }

    // ================= 首页卡片 =================

    function statusPillHTML() {
        if (syncState === 'syncing') {
            return '<span class="module-card-status" data-kind="pending"><span class="memo-spinner"></span>同步中</span>';
        }
        if (syncState === 'failed') {
            return '<span class="module-card-status" data-kind="alert">同步失败</span>' +
                   '<button class="memo-retry" type="button" data-action="retry">重试</button>';
        }
        return '<span class="module-card-status" data-kind="ready">已同步</span>';
    }

    function pendingPillHTML() {
        const n = drafts.length;
        return n > 0 ? `<span class="module-card-status" data-kind="pending">待同步 ${n}</span>` : '';
    }

    /**
     * 同步时刻的文案。**只在成功态给值**——同步中 / 失败时显示上一次成功的
     * 时刻，会让人以为刚刚同步成功过（`statusPillHTML` 早先是这个语义，
     * 拆出时刻时别把它弄丢）。
     * 四处共用（fillStatus / statusKey / panelHTML / renderPanelMaybe 的就地刷新），
     * 各写一遍必然漂移。
     */
    function syncTimeText() {
        return syncState === 'synced' && lastSync ? hm(lastSync) : '';
    }

    /**
     * 把状态写进**卡片头**（标题右侧）与底部小字里的同步时刻。
     *
     * 状态胶囊原先独占正文第一行，占掉整整一行高度（胶囊行 + 8px 外边距约 26px）；
     * 现在挪进卡片头——与「服务器监控」那张卡一直以来的放法一致。
     * 「管理」按钮因此也从头里挪到底部那行小字（那行本来就在说「点击管理」），
     * 否则最窄的一档卡片（132px）装不下「标题 + 胶囊 + 管理」，标题会被截断。
     */
    function fillStatus() {
        if (cardStatus) cardStatus.innerHTML = statusPillHTML() + pendingPillHTML();
        if (cardBody) {
            const part = cardBody.querySelector('.memo-sync-part');
            // 整段一起给：没有时刻时连分隔符都不渲染，不留一个孤零零的「·」
            if (part) {
                const t = syncTimeText();
                part.textContent = t ? ` · ${t}同步` : '';
            }
        }
    }

    /**
     * 卡片内容指纹。**不含 syncState**——同步态每轮都在变，含进去等于
     * 每轮必然整块重写一次，而那正是要避免的事；同步态改由
     * renderCardStatus 就地更新状态行。
     * 时间那一项直接取**渲染出来的相对时间**（relTime），而不是自造一个
     * 分钟档：自造档位一旦与渲染用的取整方式不一致，显示值就会比指纹晚
     * 一个档变化，卡上那行停在旧值上。
     */
    function cardKey() {
        return [
            drafts.length,
            memos.map(m => `${m.id}:${m.pinned}:${m.updatedAt}:${relTime(m.updatedAt)}`).join('|')
        ].join('>');
    }

    /**
     * 状态行的指纹。它比卡片指纹多含 syncState 与同步时刻——
     * syncState 正是**不**该进卡片指纹的那一项（见 cardKey）。
     * 有这一层，数据与同步态都没变的一轮轮询是**零 DOM 写入**。
     */
    function statusKey() {
        return [syncState, drafts.length, syncTimeText()].join('|');
    }

    /** 只就地刷新状态——数据没变时用它代替整块重建。 */
    function renderCardStatus() {
        if (!cardBody) return;
        const key = statusKey();
        if (key === lastCardStatusKey) return;
        lastCardStatusKey = key;
        fillStatus();
        // 状态位本身也会变高：失败态多出一个「重试」按钮，而卡片头与底部
        // 那行小字都是可折行的；不请求重排的话，下面那几张停在旧高度。
        if (requestStack) requestStack();
    }

    /** 数据指纹没变就只刷新同步态，不整块重建卡片。 */
    function renderCardMaybe() {
        if (!cardBody) return;
        if (cardKey() === lastCardKey) {
            renderCardStatus();
            return;
        }
        renderCard();
    }

    function renderCard() {
        if (!cardBody) return;
        lastCardKey = cardKey();
        const rows = memos.slice(0, PREVIEW_ROWS).map(m =>
            `<div class="memo-row" data-action="open">` +
            `${m.pinned ? PIN_SVG : ''}` +
            `<span class="memo-row-title">${esc(m.title)}</span>` +
            `<span class="memo-row-time">${relTime(m.updatedAt)}</span>` +
            `</div>`).join('');
        cardBody.innerHTML =
            (memos.length
                ? `<div class="memo-rows">${rows}</div>`
                : '<div class="memo-empty-card">还没有备忘录</div>') +
            `<div class="module-card-hint">共 ${memos.length} 条` +
                `<span class="memo-sync-part"></span>` +
                ` · <button class="memo-card-manage" type="button" data-action="open">管理</button>` +
            `</div>`;
        // 整块重建时状态也一并重画了，指纹要跟着走，否则下一轮会白刷一次
        lastCardStatusKey = statusKey();
        fillStatus();
        // 卡片高度随内容变化（0 条与 3 条差一截），宽屏的纵向偏移按实测高度排。
        if (requestStack) requestStack();
    }

    function mountWidget(shell, state) {
        api = (state && state.api) || null;
        requestStack = (state && state.requestStack) || null;
        if (!api) {
            // 平台契约变化要让它在界面上可见，而不是退化成一连串同步失败
            const box = document.createElement('div');
            box.className = 'module-widget-error';
            box.textContent = '模块未拿到 API（平台接口变化）';
            return [box];
        }

        const card = document.createElement('section');
        card.className = 'module-card';
        // 布局键是稳定域 id，不是数组下标（平台约定）
        card.dataset.instanceId = 'memo:main';

        const head = document.createElement('div');
        head.className = 'module-widget-head';

        const label = document.createElement('span');
        label.className = 'module-widget-title';
        label.textContent = '备忘录';

        // 状态胶囊放卡片头（标题右侧），不再独占正文第一行。
        // ⚠️ 它是模块级状态 cardStatus，写在 **cardBody 之外**（在卡片头里）——
        // 正文的整块重建不该顺手把它抹掉，两处各写各的。
        const status = document.createElement('span');
        status.className = 'memo-card-status';

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'module-drag-handle';
        handle.title = '拖拽调整位置';
        handle.setAttribute('aria-label', '拖拽调整备忘录的位置');
        // 显隐交给平台的 .module-zone.is-editing 规则，不在这里写 hidden

        // 「管理」不在卡片头里：最窄的一档卡片（132px）装不下
        // 「标题 + 状态胶囊 + 管理」，标题会被截断。它挪到底部那行小字里
        // （那行本来就在说「点击管理」），由 renderCard 渲染、走同一层事件委托。

        head.append(label, status, handle);

        const body = document.createElement('div');
        body.className = 'module-widget-body';

        card.append(head, body);
        cardBody = body;
        cardStatus = status;

        // 事件委托挂在**整张卡**上，不是正文上。状态胶囊（含失败态的「重试」）
        // 在卡片头里，而卡片头与正文是兄弟节点——委托挂在正文上时，头里那个
        // 「重试」是死按钮。实测（停服制造失败态）：点头里的「重试」不发请求、
        // 状态纹丝不动，而面板里的「同步」正常——同一个动作两种结果。
        card.addEventListener('click', event => {
            const t = event.target.closest('[data-action]');
            if (!t) return;
            if (t.dataset.action === 'open') openPanel();
            else if (t.dataset.action === 'retry') poll({ manual: true });
        });

        renderCard();
        // 首轮先拉一次、再挂表（schedulePolling 自己不拉取）；把这次 promise
        // 交给平台，模块区首次布局就等到数据落地之后——卡片高度一次到位，
        // 不会在数据到达时把下面的卡片整体推下去（与 server-monitor 同一处）。
        const firstRound = poll();
        schedulePolling();
        if (state && typeof state.whenReady === 'function') state.whenReady(firstRound);
        return [card];
    }

    // ================= 管理对话框 =================

    function openPanel() {
        const overlay = document.createElement('div');
        overlay.className = 'module-overlay';

        const panelEl = document.createElement('div');
        panelEl.className = 'module-panel memo-panel';
        panelEl.setAttribute('role', 'dialog');
        panelEl.setAttribute('aria-modal', 'true');
        panelEl.setAttribute('aria-label', '备忘录');

        overlay.appendChild(panelEl);
        document.body.appendChild(overlay);

        panelView = 'list';
        editingId = null;
        confirmDeleteId = null;
        panel = { overlay, panelEl, close: null };

        const closePanel = () => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            panel = null;
        };
        panel.close = closePanel;
        const onKey = event => { if (event.key === 'Escape') closePanel(); };
        document.addEventListener('keydown', onKey);
        // 点空白关面板，但**编辑中不关**：表单里可能有没保存的内容，
        // 一次误点就把刚写的备忘丢掉。取消有显式的「取消/← 返回」。
        overlay.addEventListener('click', event => {
            if (event.target === overlay && panelView !== 'edit') closePanel();
        });

        // 点击与 input 都委托在面板根上：内部重渲染不会丢掉监听
        panelEl.addEventListener('click', event => {
            const t = event.target.closest('[data-action]');
            if (!t) return;
            const action = t.dataset.action;
            const id = t.dataset.id;
            switch (action) {
                case 'close':
                    closePanel();
                    break;
                case 'sync':
                case 'retry':
                    if (!inFlight) poll({ manual: true });
                    break;
                case 'add':
                    panelView = 'edit';
                    editingId = 'new';
                    renderPanel();
                    break;
                case 'edit':
                    panelView = 'edit';
                    editingId = id;
                    confirmDeleteId = null;
                    renderPanel();
                    break;
                case 'back':
                    panelView = 'list';
                    editingId = null;
                    renderPanel();
                    break;
                case 'save':
                    doSave();
                    break;
                case 'pin': {
                    const m = memos.find(x => x.id === id);
                    if (m) togglePin(m);
                    break;
                }
                case 'ask-del':
                    confirmDeleteId = id;
                    renderPanel();
                    break;
                case 'cancel-del':
                    confirmDeleteId = null;
                    renderPanel();
                    break;
                case 'confirm-del': {
                    const m = memos.find(x => x.id === id);
                    if (m) deleteMemo(m);
                    break;
                }
            }
        });
        panelEl.addEventListener('input', event => {
            if (event.target.id === 'memoSearch') {
                search = event.target.value;
                // 只重渲染列表区：输入框本身不动，焦点与光标自然保留
                const listEl = panelEl.querySelector('#memoList');
                if (listEl) listEl.innerHTML = memoListHTML();
            } else if (event.target.id === 'memoTitle' || event.target.id === 'memoBody') {
                syncFormCounts(panelEl);
            }
        });

        renderPanel();
        return overlay;
    }

    function renderPanel() {
        if (!panel) return;
        // 编辑中的表单可能带着未保存内容：引用的备忘录若已不在
        // （比如刚被删除），退回列表而不是渲染空表单
        if (panelView === 'edit' && editingId !== 'new' && !memos.some(m => m.id === editingId)) {
            panelView = 'list';
            editingId = null;
        }
        panel.panelEl.innerHTML = panelView === 'edit' ? editFormHTML() : panelHTML();
        lastPanelKey = panelKey();
        if (panelView === 'edit') {
            const title = panel.panelEl.querySelector('#memoTitle');
            if (title) {
                title.focus();
                title.setSelectionRange(title.value.length, title.value.length);
            }
        }
    }

    /**
     * 轮询/写操作后的面板刷新。数据指纹没变就不动 DOM——
     * 否则每 15 秒的轮询会把用户正在输入的搜索框整块换掉。
     * 编辑态直接跳过：表单里的未保存内容比后台数据更优先。
     */
    function renderPanelMaybe() {
        if (!panel || panelView === 'edit') return;
        const key = panelKey();
        if (key === lastPanelKey) {
            // 数据没变：仅就地刷新同步时间
            const t = panel.panelEl.querySelector('.memo-status-time');
            if (t) t.textContent = syncTimeText();
            return;
        }
        renderPanel();
    }

    function panelKey() {
        return [syncState, drafts.length, memos.map(m => `${m.id}:${m.pinned}:${m.updatedAt}`).join('|')].join('>');
    }

    function panelHTML() {
        return `
            <div class="memo-dialog-header">
                <h2>备忘录</h2>
                <span class="memo-status-row">${statusPillHTML()}${pendingPillHTML()}<span class="memo-status-time">${syncTimeText()}</span></span>
                <button class="btn" type="button" data-action="sync">同步</button>
                <button class="module-panel-close" type="button" data-action="close" aria-label="关闭">×</button>
            </div>
            <div class="memo-search">
                <input id="memoSearch" type="search" placeholder="搜索标题或正文" value="${esc(search)}">
            </div>
            <div class="memo-list" id="memoList">${memoListHTML()}</div>
            <div class="memo-dialog-footer">
                <span class="memo-count">共 ${memos.length} / 200 条</span>
                <button class="btn btn-primary" type="button" data-action="add">＋ 添加备忘录</button>
            </div>`;
    }

    function memoListHTML() {
        const q = search.trim().toLowerCase();
        const match = m => !q || m.title.toLowerCase().includes(q) || m.body.toLowerCase().includes(q);
        const pinned = memos.filter(m => m.pinned && match(m));
        const recent = memos.filter(m => !m.pinned && match(m));
        // 有离线编辑的备忘录标小圆点（按 id 匹配；新建草稿没有 id）
        const pendingIds = new Set(drafts.filter(d => d.id).map(d => d.id));

        const rowHTML = m => {
            if (confirmDeleteId === m.id) {
                return `<div class="memo-row-lg"><div class="memo-del-confirm">` +
                    `<span>删除「${esc(m.title)}」？</span>` +
                    `<button class="btn" type="button" data-action="confirm-del" data-id="${m.id}">删除</button>` +
                    `<button class="btn" type="button" data-action="cancel-del">取消</button>` +
                    `</div></div>`;
            }
            const dot = pendingIds.has(m.id) ? '<span class="memo-pend-dot" title="离线编辑，待同步"></span>' : '';
            return `<div class="memo-row-lg">` +
                `<button class="memo-pin-btn" type="button" data-action="pin" data-id="${m.id}" aria-pressed="${m.pinned}" title="${m.pinned ? '取消固定' : '固定到最前'}">${PIN_SVG_BIG}</button>` +
                `<div class="memo-row-main" data-action="edit" data-id="${m.id}">` +
                    `<div class="memo-row-title">${esc(m.title)}${dot}</div>` +
                    `<div class="memo-row-snippet">${esc(m.body)}</div>` +
                `</div>` +
                `<span class="memo-row-time">${relTime(m.updatedAt)}</span>` +
                `<div class="memo-row-actions">` +
                    `<button class="icon-btn" type="button" data-action="edit" data-id="${m.id}" title="编辑">✎</button>` +
                    `<button class="icon-btn danger" type="button" data-action="ask-del" data-id="${m.id}" title="删除">✕</button>` +
                `</div>` +
            `</div>`;
        };

        if (q) {
            const all = [...pinned, ...recent];
            return `<div class="memo-section-title">搜索「${esc(search.trim())}」</div>` +
                (all.length ? all.map(rowHTML).join('') : '<div class="memo-none">无匹配</div>');
        }
        let list = '';
        if (pinned.length) list += `<div class="memo-section-title">已固定</div>` + pinned.map(rowHTML).join('');
        if (recent.length) list += `<div class="memo-section-title">最近更新</div>` + recent.map(rowHTML).join('');
        if (!list) list = '<div class="memo-none">还没有备忘录，点下方「添加备忘录」开始</div>';
        return list;
    }

    function editFormHTML() {
        const isNew = editingId === 'new';
        const m = isNew ? { title: '', body: '' } : memos.find(x => x.id === editingId);
        return `
            <div class="memo-dialog-header">
                <button class="btn" type="button" data-action="back">← 返回</button>
                <h2>${isNew ? '添加备忘录' : '编辑备忘录'}</h2>
                <button class="module-panel-close" type="button" data-action="close" aria-label="关闭">×</button>
            </div>
            <div class="memo-form">
                <label>标题 <span class="memo-count" id="memoTitleCount">${m.title.length} / ${TITLE_MAX}</span></label>
                <input id="memoTitle" maxlength="${TITLE_MAX}" value="${esc(m.title)}" placeholder="一句话说明这条备忘">
                <label>正文 <span class="memo-count" id="memoBodyCount">${m.body.length} / ${BODY_MAX}</span></label>
                <textarea id="memoBody" rows="8" maxlength="${BODY_MAX}" placeholder="纯文本，可换行">${esc(m.body)}</textarea>
                <div class="memo-form-actions">
                    <button class="btn" type="button" data-action="back">取消</button>
                    <button class="btn btn-primary" type="button" data-action="save" id="memoSave"${m.title.trim() ? '' : ' disabled'}>保存</button>
                </div>
            </div>`;
    }

    function syncFormCounts(root) {
        const title = root.querySelector('#memoTitle');
        const body = root.querySelector('#memoBody');
        const save = root.querySelector('#memoSave');
        if (!title || !body || !save) return;
        root.querySelector('#memoTitleCount').textContent = `${title.value.length} / ${TITLE_MAX}`;
        root.querySelector('#memoBodyCount').textContent = `${body.value.length} / ${BODY_MAX}`;
        save.disabled = !title.value.trim();
    }

    async function doSave() {
        if (!panel) return;
        const title = panel.panelEl.querySelector('#memoTitle').value.trim();
        const body = panel.panelEl.querySelector('#memoBody').value;
        if (!title) return;
        const id = editingId === 'new' ? null : editingId;
        const ok = await saveMemo(id, title, body);
        if (ok) {
            panelView = 'list';
            editingId = null;
            renderPanel();
            window.app?.showToast('已保存');
        }
        // 失败且已暂存：留在表单——内容还在，返回列表后这条会带「待同步」圆点
    }

    window.app.registerModule({
        id: 'memo',
        title: '备忘录',
        // 说明文字由后台模块列表渲染在名称下方
        summary: '登录后可用 · 多端自动同步',
        mountWidget,
        openPanel
    });
})();

/**
 * 备忘与待办模块。
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
    const TODO_DRAFTS_KEY = 'nav-sylph-todo-drafts';
    const TITLE_MAX = 60;
    const BODY_MAX = 10240;
    const TODO_TEXT_MAX = 200;
    const TODO_MAX_ENTRIES = 300;

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
    /** 待办列表（按 created_at DESC 排序；完成态不参与排序） */
    let todos = [];
    /**
     * 当前页签：memo | todo。
     * **只存内存，不落 localStorage**——「默认展示备忘列表」是每次加载的约定，
     * 记住上次选择会让刷新后的默认值变成待办。卡片与面板共用这一个状态。
     */
    let activeTab = 'memo';
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
    let cardHead = null;
    let cardFooter = null;
    let renderedCardTab = null;
    const cardScroll = { memo: 0, todo: 0 };

    /** 打开对话框时的面板代次：异步续做用它确认自己还是当前面板 */
    let panel = null;
    let panelEpoch = 0;
    /** 保存失败时保留用户原样输入（按 id），下一次打开该条时显示 */
    const failedTodoEdits = new Map();
    let panelView = 'list'; // list | edit（备忘录编辑表单）
    /** 正在替换面板 DOM：此时移除聚焦输入框会同步触发 focusout，必须忽略 */
    let panelRendering = false;
    let editingId = null;   // 备忘录 id 或 'new'
    let confirmDeleteId = null;
    let confirmDeleteTodoId = null;
    /** 正在就地编辑的待办 id（null = 无）。非空时面板不随轮询重渲染 */
    let editingTodoId = null;
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

    function loadTodoDrafts() {
        try {
            const list = JSON.parse(localStorage.getItem(TODO_DRAFTS_KEY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    let todoDrafts = loadTodoDrafts();

    function persistTodoDrafts() {
        try {
            if (todoDrafts.length) localStorage.setItem(TODO_DRAFTS_KEY, JSON.stringify(todoDrafts));
            else localStorage.removeItem(TODO_DRAFTS_KEY);
        } catch {
            // 同上：写不进去只影响跨刷新保留
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

    function sortTodos() {
        // 与服务端 ORDER BY created_at DESC, id DESC 一致。
        // 完成态**不参与排序**：勾选后条目留在原位（否则连续勾选会点错下一条）。
        todos.sort((a, b) => (b.createdAt - a.createdAt)
            || String(b.id).localeCompare(String(a.id)));
    }

    function applyTodo(todo) {
        const i = todos.findIndex(t => t.id === todo.id);
        if (i >= 0) todos[i] = todo;
        else todos.push(todo);
        sortTodos();
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
     *
     * 备忘与待办**并发**取：两条串行 await 会把两次鉴权与网络耗时叠加
     * （与首页把 /api/config 与 /api/favorites 并行是同一条理由）。
     * 用 allSettled：一条失败不该把另一条已经拿到的数据丢掉。
     */
    async function poll({ manual = false } = {}) {
        if (inFlight) return;
        inFlight = true;
        if (manual) setSyncState('syncing');
        try {
            const [memoRes, todoRes] = await Promise.allSettled([
                api.get('/api/memos'),
                api.get('/api/todos')
            ]);
            let failed = false;

            if (memoRes.status === 'fulfilled' && memoRes.value && Array.isArray(memoRes.value.memos)) {
                memos = memoRes.value.memos;
                sortMemos();
                adoptPollInterval(memoRes.value);
            } else {
                failed = true;
                if (memoRes.status === 'rejected') console.error('Memo poll failed:', memoRes.reason);
            }

            if (todoRes.status === 'fulfilled' && todoRes.value && Array.isArray(todoRes.value.todos)) {
                todos = todoRes.value.todos;
                sortTodos();
                adoptPollInterval(todoRes.value);
            } else {
                failed = true;
                if (todoRes.status === 'rejected') console.error('Todo poll failed:', todoRes.reason);
            }

            if (failed) {
                setSyncState('failed');
                return;
            }
            lastSync = Date.now();
            setSyncState('synced');
            // 拉取成功说明网络已恢复：补传离线暂存的编辑
            flushDrafts();
            flushTodoDrafts();
        } catch (e) {
            console.error('Memo poll failed:', e);
            setSyncState('failed');
        } finally {
            inFlight = false;
        }
    }

    /** 服务端回当前生效的周期：后台改过之后不必刷新页面就能按新周期走。 */
    function adoptPollInterval(data) {
        if (Number.isFinite(data.pollInterval) && data.pollInterval * 1000 !== pollMs) {
            pollMs = data.pollInterval * 1000;
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = setInterval(poll, pollMs);
            }
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

    /** 待办草稿的补传：与备忘录同一套语义（服务端拒绝即作废，网络异常才保留）。 */
    async function flushTodoDrafts() {
        if (!todoDrafts.length) return;
        const remaining = [];
        for (const d of todoDrafts) {
            try {
                const data = d.id
                    ? await api.post(`/api/todos/${encodeURIComponent(d.id)}`, { text: d.text })
                    : await api.post('/api/todos', { text: d.text });
                if (data && data.error) {
                    console.warn('Todo draft rejected:', d.id, data.error);
                    continue;
                }
                if (data && data.todo) applyTodo(data.todo);
                if (d.id) failedTodoEdits.delete(d.id);
            } catch (e) {
                remaining.push(d);
            }
        }
        if (remaining.length !== todoDrafts.length) {
            todoDrafts = remaining;
            persistTodoDrafts();
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

    /**
     * 平台在模块离开启用集合时调用（用户停用、或管理员撤回开放）。
     * 必须收掉定时器与监听：否则停用的模块会继续按周期请求接口。
     */
    function unmount() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (visibilityHandler) {
            document.removeEventListener('visibilitychange', visibilityHandler);
            visibilityHandler = null;
        }
        inFlight = false;
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

    /** 保存待办文字（新建或编辑）。返回 true 表示已落库；false 为服务端拒绝或已暂存。 */
    async function saveTodo(id, text) {
        try {
            const data = id
                ? await api.post(`/api/todos/${encodeURIComponent(id)}`, { text })
                : await api.post('/api/todos', { text });
            if (data && data.error) {
                window.app?.showToast(data.error, 'error');
                return false;
            }
            if (data && data.todo) applyTodo(data.todo);
            if (id) {
                todoDrafts = todoDrafts.filter(d => d.id !== id);
                failedTodoEdits.delete(id);
                persistTodoDrafts();
            }
            lastSync = Date.now();
            setSyncState('synced');
            return true;
        } catch (e) {
            // 断网：暂存到 localStorage，恢复后随轮询自动补传
            if (id) todoDrafts = todoDrafts.filter(d => d.id !== id);
            todoDrafts.push({ id: id || null, text, ts: Date.now() });
            persistTodoDrafts();
            renderCard();
            renderPanelMaybe();
            window.app?.showToast('已暂存，恢复网络后自动同步', 'error', 4000);
            return false;
        }
    }

    async function toggleTodo(todo) {
        // 乐观更新，失败回滚。完成态是状态变更，不进离线暂存（与 pinned 同）。
        todo.done = !todo.done;
        renderCard();
        renderPanelMaybe();
        try {
            const data = await api.post(`/api/todos/${encodeURIComponent(todo.id)}/done`, { done: todo.done });
            if (data && data.error) throw new Error(data.error);
            // 勾选是高频操作，删除线本身已是反馈，不再弹 toast。
        } catch (e) {
            todo.done = !todo.done;
            renderCard();
            renderPanelMaybe();
            window.app?.showToast('状态保存失败', 'error');
        }
    }

    async function deleteTodo(todo) {
        let res, data;
        try {
            ({ res, data } = await api.request(`/api/todos/${encodeURIComponent(todo.id)}`, { method: 'DELETE' }));
        } catch (e) {
            window.app?.showToast('网络异常，删除失败', 'error');
            return;
        }
        if (!res.ok || (data && data.error)) {
            window.app?.showToast((data && data.error) || '删除失败', 'error');
            return;
        }
        todos = todos.filter(t => t.id !== todo.id);
        todoDrafts = todoDrafts.filter(d => d.id !== todo.id);
        failedTodoEdits.delete(todo.id);
        persistTodoDrafts();
        confirmDeleteTodoId = null;
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
        const n = drafts.length + todoDrafts.length;
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

    function fillStatus() {
        const part = cardFooter?.querySelector('.memo-sync-part');
        if (!part) return;
        const t = syncTimeText();
        part.innerHTML = (syncState === 'synced' ? (t ? `${t}同步` : '') : statusPillHTML()) + pendingPillHTML();
    }

    /**
     * 卡片内容指纹。**不含 syncState**——同步态每轮都在变，含进去等于
     * 每轮必然整块重写一次，而那正是要避免的事；同步态改由
     * renderCardStatus 就地更新状态行。
     * 时间那一项直接取**渲染出来的相对时间**（relTime），而不是自造一个
     * 分钟档：自造档位一旦与渲染用的取整方式不一致，显示值就会比指纹晚
     * 一个档变化，卡上那行停在旧值上。
     * 页签也进指纹：切换页签本身就是「内容变了」，必须整块重建。
     */
    function cardKey() {
        return [
            activeTab,
            drafts.length + todoDrafts.length,
            memos.map(m => `${m.id}:${m.pinned}:${m.updatedAt}:${relTime(m.updatedAt)}`).join('|'),
            todos.map(t => `${t.id}:${t.done}:${t.updatedAt}`).join('|')
        ].join('>');
    }

    /**
     * 状态行的指纹。它比卡片指纹多含 syncState 与同步时刻——
     * syncState 正是**不**该进卡片指纹的那一项（见 cardKey）。
     * 有这一层，数据与同步态都没变的一轮轮询是**零 DOM 写入**。
     */
    function statusKey() {
        return [syncState, drafts.length + todoDrafts.length, syncTimeText()].join('|');
    }

    /** 只就地刷新状态——数据没变时用它代替整块重建。 */
    function renderCardStatus() {
        if (!cardBody) return;
        const key = statusKey();
        if (key === lastCardStatusKey) return;
        lastCardStatusKey = key;
        fillStatus();
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

    /** 「备忘 | 待办」分段切换。卡片与面板共用同一份状态与同一套标记。 */
    function tabsHTML(extraClass) {
        const cls = extraClass ? `memo-tabs ${extraClass}` : 'memo-tabs';
        return `<div class="${cls}" role="tablist" aria-label="备忘与待办">` +
            `<button class="memo-tab" type="button" role="tab" data-action="switch-tab" data-tab="memo" aria-selected="${activeTab === 'memo'}">备忘</button>` +
            `<button class="memo-tab" type="button" role="tab" data-action="switch-tab" data-tab="todo" aria-selected="${activeTab === 'todo'}">待办</button>` +
            `</div>`;
    }

    function switchTab(tab) {
        if (tab !== 'memo' && tab !== 'todo') return;
        if (activeTab === tab) return;
        // 先收下未提交的就地编辑（与失焦保存同一语义），不静默丢弃用户刚打的字。
        // commitTodoEdit 会同步清掉 editingTodoId，因此下面的重渲染不会带着旧输入框。
        if (editingTodoId) commitTodoEdit();
        saveCardScroll();
        activeTab = tab;
        renderCard();
        // 备忘编辑表单里没有页签，但卡片上的页签仍可点：此时不重渲染面板，
        // 否则一次点击就把表单里未保存的备忘丢掉。
        // 用 renderPanelMaybe：activeTab 在面板指纹里，页签变了自然会重渲染；
        // 数据没变时则保留搜索框焦点（原先直接 renderPanel 绕开了这道守卫）。
        if (panel && panelView === 'list') renderPanelMaybe();
    }

    /** 勾选框：卡片与面板共用一份，免得两处标记各自漂移。 */
    function todoCheckHTML(t) {
        const label = t.done ? '标记未完成' : '标记完成';
        return `<label class="memo-todo-check-wrap" title="${label}">` +
            `<input class="memo-todo-check" type="checkbox" data-action="toggle-todo" data-id="${esc(t.id)}"` +
            `${t.done ? ' checked' : ''} aria-label="${label}">` +
            `</label>`;
    }

    /** 同一条待办若已有离线草稿或失败的编辑，显示用户最后一次输入。 */
    function todoTextOf(todo) {
        const draft = todoDrafts.find(d => d.id === todo.id);
        if (draft) return draft.text;
        if (failedTodoEdits.has(todo.id)) return failedTodoEdits.get(todo.id);
        return todo.text;
    }


    function memoCardHTML() {
        const rows = memos.map(m =>
            `<div class="memo-row" data-action="open">` +
            `${m.pinned ? PIN_SVG : ''}` +
            `<span class="memo-row-title">${esc(m.title)}</span>` +
            `<span class="memo-row-time">${relTime(m.updatedAt)}</span>` +
            `</div>`).join('');
        return memos.length
            ? `<div class="memo-rows" tabindex="0" role="region" aria-label="备忘列表">${rows}</div>`
            : '<div class="memo-empty-card">还没有备忘</div>';
    }

    function todoCardHTML() {
        const rows = todos.map(t =>
            `<div class="memo-row memo-todo-row">` +
            todoCheckHTML(t) +
            `<button class="memo-todo-text" type="button" data-action="open-todo-edit" data-id="${esc(t.id)}" data-done="${t.done ? 1 : 0}" title="编辑这条待办">${esc(todoTextOf(t))}</button>` +
            `</div>`).join('');
        return todos.length
            ? `<div class="memo-rows memo-todo-rows" tabindex="0" role="region" aria-label="待办列表">${rows}</div>`
            : '<div class="memo-empty-card">还没有待办</div>';
    }

    function saveCardScroll() {
        const rows = cardBody?.querySelector('.memo-rows');
        if (rows && renderedCardTab) cardScroll[renderedCardTab] = rows.scrollTop;
    }

    function renderCard() {
        if (!cardBody) return;
        saveCardScroll();
        const focused = document.activeElement;
        const restoreFocus = cardBody.contains(focused);
        const action = restoreFocus ? focused.dataset.action : null;
        const id = restoreFocus ? focused.dataset.id : null;
        lastCardKey = cardKey();
        cardHead.querySelectorAll('[data-action="switch-tab"]').forEach(tab => {
            const selected = String(tab.dataset.tab === activeTab);
            if (tab.getAttribute('aria-selected') !== selected) tab.setAttribute('aria-selected', selected);
        });
        cardBody.innerHTML = activeTab === 'memo' ? memoCardHTML() : todoCardHTML();
        renderedCardTab = activeTab;
        const rows = cardBody.querySelector('.memo-rows');
        if (rows) rows.scrollTop = cardScroll[activeTab];
        if (restoreFocus) {
            const target = action
                ? Array.from(cardBody.querySelectorAll('[data-action]')).find(el => el.dataset.action === action && el.dataset.id === id)
                : rows;
            if (target) target.focus({ preventScroll: true });
        }
        cardFooter.querySelector('.memo-card-count').textContent = activeTab === 'memo'
            ? `共 ${memos.length} 条`
            : `共 ${todos.length} 项 · ${todos.filter(t => !t.done).length} 未完成`;
        lastCardStatusKey = statusKey();
        fillStatus();
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
        card.className = 'module-card memo-card';
        card.setAttribute('aria-label', '备忘与待办');
        // 布局键是稳定域 id，不是数组下标（平台约定）
        card.dataset.instanceId = 'memo:main';

        const head = document.createElement('div');
        head.className = 'module-widget-head';

        head.innerHTML = tabsHTML();

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'module-drag-handle';
        handle.title = '拖拽调整位置';
        handle.setAttribute('aria-label', '拖拽调整备忘与待办的位置');
        // 显隐交给平台的 .module-zone.is-editing 规则，不在这里写 hidden

        const body = document.createElement('div');
        body.className = 'module-widget-body';
        const footer = document.createElement('div');
        footer.className = 'memo-card-footer module-card-hint';
        footer.innerHTML = '<span class="memo-card-count"></span><div class="memo-card-tools"><span class="memo-sync-part"></span><button class="memo-card-manage" type="button" data-action="open">管理</button></div>';
        footer.querySelector('.memo-card-tools').appendChild(handle);
        card.append(head, body, footer);
        cardBody = body;
        cardHead = head;
        cardFooter = footer;
        renderedCardTab = null;

        card.addEventListener('click', event => {
            const t = event.target.closest('[data-action]');
            if (!t) return;
            const action = t.dataset.action;
            if (action === 'open') openPanel();
            else if (action === 'open-todo-edit') openPanel({ todoId: t.dataset.id });
            else if (action === 'retry') poll({ manual: true });
            else if (action === 'switch-tab') switchTab(t.dataset.tab);
            else if (action === 'toggle-todo') {
                const todo = todos.find(x => x.id === t.dataset.id);
                if (todo) toggleTodo(todo);
            }
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

    function openPanel({ todoId } = {}) {
        if (panel) {
            if (todoId !== undefined) openTodoTarget(todoId);
            return panel.overlay;
        }
        const overlay = document.createElement('div');
        overlay.className = 'module-overlay';

        const panelEl = document.createElement('div');
        panelEl.className = 'module-panel memo-panel';
        panelEl.setAttribute('role', 'dialog');
        panelEl.setAttribute('aria-modal', 'true');
        panelEl.setAttribute('aria-label', '备忘与待办');

        overlay.appendChild(panelEl);
        document.body.appendChild(overlay);

        panelView = 'list';
        editingId = null;
        confirmDeleteId = null;
        confirmDeleteTodoId = null;
        editingTodoId = null;
        if (todoId !== undefined) {
            saveCardScroll();
            activeTab = 'todo';
            editingTodoId = todos.some(t => t.id === todoId) ? todoId : null;
            if (!editingTodoId) window.app?.showToast('这条待办已不存在，已打开待办清单', 'error');
            renderCardMaybe();
        }
        panel = { overlay, panelEl, close: null, epoch: ++panelEpoch, targetSeq: 0 };

        const closePanel = () => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            panel = null;
            editingTodoId = null;
        };
        panel.close = closePanel;
        const onKey = event => { if (event.key === 'Escape') closePanel(); };
        document.addEventListener('keydown', onKey);
        // 点空白关面板，但**编辑中不关**：表单里可能有没保存的内容，
        // 一次误点就把刚写的备忘丢掉。取消有显式的「取消/← 返回」。
        // 待办就地编辑同理——空白处误点不该丢掉正在改的文字。
        overlay.addEventListener('click', event => {
            if (event.target === overlay && panelView !== 'edit' && !editingTodoId) closePanel();
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
                case 'switch-tab':
                    switchTab(t.dataset.tab);
                    break;
                case 'edit-todo':
                    // 换目标前先保存上一条，避免「点另一条」把未提交的编辑丢掉
                    if (editingTodoId && editingTodoId !== id) commitTodoEdit();
                    editingTodoId = id;
                    confirmDeleteTodoId = null;
                    renderPanel();
                    break;
                case 'add-todo':
                    doAddTodo();
                    break;
                case 'toggle-todo': {
                    const td = todos.find(x => x.id === id);
                    if (td) toggleTodo(td);
                    break;
                }
                case 'ask-del-todo':
                    confirmDeleteTodoId = id;
                    editingTodoId = null;
                    renderPanel();
                    break;
                case 'cancel-del-todo':
                    confirmDeleteTodoId = null;
                    renderPanel();
                    break;
                case 'confirm-del-todo': {
                    const td = todos.find(x => x.id === id);
                    if (td) deleteTodo(td);
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
        panelEl.addEventListener('keydown', event => {
            if (event.target.id === 'memoTodoNew' && event.key === 'Enter') {
                event.preventDefault();
                doAddTodo();
            } else if (event.target.id === 'memoTodoInput' && event.key === 'Enter') {
                event.preventDefault();
                commitTodoEdit();
            } else if (event.target.id === 'memoTodoInput' && event.key === 'Escape') {
                // 就地编辑里的 Esc 只能取消这一条，不能把整个面板关掉
                event.preventDefault();
                event.stopPropagation();
                cancelTodoEdit();
            }
        });
        // 失焦保存。focusout 会冒泡（blur 不会），焦点移到行内按钮时也走这里；
        // 编辑态已经退出（commitTodoEdit 先清 editingTodoId）就不会重复触发。
        panelEl.addEventListener('focusout', event => {
            if (panelRendering) return;
            if (event.target.id === 'memoTodoInput' && editingTodoId) commitTodoEdit();
        });
        // ⚠️ 行内操作按钮（删除 / 勾选）在 pointerdown 时阻止默认：
        // 不阻止的话输入框先失焦 → 重渲染把按钮换掉 → 紧接着的 click 落空，
        // 症状是「点删除没反应」。
        panelEl.addEventListener('pointerdown', event => {
            if (!editingTodoId || event.target.id === 'memoTodoInput') return;
            if (event.target.closest('[data-action]')) event.preventDefault();
        });

        renderPanel();
        return overlay;
    }

    async function openTodoTarget(todoId) {
        const owner = panel;
        if (!owner) return;
        if (panelView === 'edit') {
            window.app?.showToast('请先保存或取消当前备忘编辑', 'error');
            return;
        }
        if (owner.panelEl.querySelector('#memoTodoNew')?.value.trim()) {
            window.app?.showToast('请先添加或清空正在输入的待办', 'error');
            return;
        }
        const seq = ++owner.targetSeq;
        const startTab = activeTab;
        if (editingTodoId && editingTodoId !== todoId) {
            if (await commitTodoEdit({ epoch: owner.epoch }) === false) return;
        } else if (editingTodoId === todoId && todos.some(t => t.id === todoId)) {
            const input = owner.panelEl.querySelector('#memoTodoInput');
            input?.focus({ preventScroll: true });
            input?.scrollIntoView({ block: 'nearest' });
            return;
        }
        if (panel !== owner || owner.targetSeq !== seq || panelView === 'edit'
            || editingTodoId || activeTab !== startTab) return;
        saveCardScroll();
        activeTab = 'todo';
        panelView = 'list';
        confirmDeleteTodoId = null;
        editingTodoId = todos.some(t => t.id === todoId) ? todoId : null;
        if (!editingTodoId) window.app?.showToast('这条待办已不存在，已打开待办清单', 'error');
        renderCardMaybe();
        renderPanel();
    }

    function renderPanel() {
        if (!panel) return;
        // 编辑中的表单可能带着未保存内容：引用的备忘录若已不在
        // （比如刚被删除），退回列表而不是渲染空表单
        if (panelView === 'edit' && editingId !== 'new' && !memos.some(m => m.id === editingId)) {
            panelView = 'list';
            editingId = null;
        }
        panelRendering = true;
        try {
            panel.panelEl.innerHTML = panelView === 'edit' ? editFormHTML() : panelHTML();
        } finally {
            panelRendering = false;
        }
        lastPanelKey = panelKey();
        if (panelView === 'edit') {
            const title = panel.panelEl.querySelector('#memoTitle');
            if (title) {
                title.focus();
                title.setSelectionRange(title.value.length, title.value.length);
            }
        } else if (editingTodoId) {
            // 就地编辑：聚焦并把原文字全选，直接输入即可替换
            const input = panel.panelEl.querySelector('#memoTodoInput');
            if (input) {
                input.focus({ preventScroll: true });
                input.select();
                input.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    /**
     * 轮询/写操作后的面板刷新。数据指纹没变就不动 DOM——
     * 否则每 15 秒的轮询会把用户正在输入的搜索框整块换掉。
     * 编辑态直接跳过：表单里的未保存内容比后台数据更优先。
     */
    function renderPanelMaybe() {
        // 编辑态 / 待办就地编辑都直接跳过：未保存内容比后台数据更优先，
        // 否则每 15 秒一轮的轮询会把正在输入的那一行整块换掉。
        if (!panel || panelView === 'edit' || editingTodoId) return;
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
        return [
            activeTab,
            syncState,
            activeTab === 'memo' ? drafts.length : todoDrafts.length,
            activeTab === 'memo' ? memos.map(m => `${m.id}:${m.pinned}:${m.updatedAt}`).join('|') : '',
            activeTab === 'todo' ? todos.map(t => `${t.id}:${t.done}:${t.updatedAt}`).join('|') : ''
        ].join('>');
    }

    function panelHTML() {
        return `
            <div class="memo-dialog-header">
                <h2>备忘与待办</h2>
                <span class="memo-status-row">${statusPillHTML()}${pendingPillHTML()}<span class="memo-status-time">${syncTimeText()}</span></span>
                <button class="btn" type="button" data-action="sync">同步</button>
                <button class="module-panel-close" type="button" data-action="close" aria-label="关闭">×</button>
            </div>
            ${tabsHTML('memo-tabs-lg')}
            ${activeTab === 'memo' ? memoPanelBodyHTML() : todoPanelBodyHTML()}`;
    }

    function memoPanelBodyHTML() {
        return `
            <div class="memo-search">
                <input id="memoSearch" type="search" placeholder="搜索标题或正文" value="${esc(search)}">
            </div>
            <div class="memo-list" id="memoList">${memoListHTML()}</div>
            <div class="memo-dialog-footer">
                <span class="memo-count">共 ${memos.length} / 200 条</span>
                <button class="btn btn-primary" type="button" data-action="add">＋ 添加备忘</button>
            </div>`;
    }

    function todoPanelBodyHTML() {
        const undone = todos.filter(t => !t.done).length;
        const full = todos.length >= TODO_MAX_ENTRIES;
        return `
            <div class="memo-list memo-todo-list" id="memoTodoList">${todoListHTML()}</div>
            <div class="memo-dialog-footer memo-todo-footer">
                <span class="memo-count">共 ${todos.length} 项 / ${TODO_MAX_ENTRIES} · ${undone} 未完成</span>
                <div class="memo-todo-add">
                    <input id="memoTodoNew" type="text" maxlength="${TODO_TEXT_MAX}" placeholder="${full ? '已达上限' : '添加待办，回车保存'}"${full ? ' disabled' : ''}>
                    <button class="btn btn-primary" type="button" data-action="add-todo"${full ? ' disabled' : ''}>＋ 添加</button>
                </div>
            </div>`;
    }

    function todoListHTML() {
        if (!todos.length) return '<div class="memo-none">还没有待办，在下方添加</div>';
        return todos.map(t => {
            if (confirmDeleteTodoId === t.id) {
                return `<div class="memo-row-lg memo-todo-row">` +
                    `<div class="memo-del-confirm"><span>删除「${esc(todoTextOf(t))}」？</span>` +
                    `<button class="btn" type="button" data-action="confirm-del-todo" data-id="${esc(t.id)}">删除</button>` +
                    `<button class="btn" type="button" data-action="cancel-del-todo">取消</button></div></div>`;
            }
            const body = editingTodoId === t.id
                ? `<input class="memo-todo-input" id="memoTodoInput" type="text" data-id="${esc(t.id)}" maxlength="${TODO_TEXT_MAX}" value="${esc(todoTextOf(t))}">`
                : `<button class="memo-todo-text" type="button" data-action="edit-todo" data-id="${esc(t.id)}" data-done="${t.done ? 1 : 0}" title="点击编辑">${esc(todoTextOf(t))}</button>`;
            return `<div class="memo-row-lg memo-todo-row">` + todoCheckHTML(t) + body +
                `<div class="memo-row-actions">` +
                    `<button class="icon-btn danger" type="button" data-action="ask-del-todo" data-id="${esc(t.id)}" title="删除">✕</button>` +
                `</div>` +
                `</div>`;
        }).join('');
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
                    `<button class="btn" type="button" data-action="confirm-del" data-id="${esc(m.id)}">删除</button>` +
                    `<button class="btn" type="button" data-action="cancel-del">取消</button>` +
                    `</div></div>`;
            }
            const dot = pendingIds.has(m.id) ? '<span class="memo-pend-dot" title="离线编辑，待同步"></span>' : '';
            return `<div class="memo-row-lg">` +
                `<button class="memo-pin-btn" type="button" data-action="pin" data-id="${esc(m.id)}" aria-pressed="${m.pinned}" title="${m.pinned ? '取消固定' : '固定到最前'}">${PIN_SVG_BIG}</button>` +
                `<div class="memo-row-main" data-action="edit" data-id="${esc(m.id)}">` +
                    `<div class="memo-row-title">${esc(m.title)}${dot}</div>` +
                    `<div class="memo-row-snippet">${esc(m.body)}</div>` +
                `</div>` +
                `<span class="memo-row-time">${relTime(m.updatedAt)}</span>` +
                `<div class="memo-row-actions">` +
                    `<button class="icon-btn" type="button" data-action="edit" data-id="${esc(m.id)}" title="编辑">✎</button>` +
                    `<button class="icon-btn danger" type="button" data-action="ask-del" data-id="${esc(m.id)}" title="删除">✕</button>` +
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
        if (!list) list = '<div class="memo-none">还没有备忘，点下方「添加备忘」开始</div>';
        return list;
    }

    function editFormHTML() {
        const isNew = editingId === 'new';
        const m = isNew ? { title: '', body: '' } : memos.find(x => x.id === editingId);
        return `
            <div class="memo-dialog-header">
                <button class="btn" type="button" data-action="back">← 返回</button>
                <h2>${isNew ? '添加备忘' : '编辑备忘'}</h2>
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

    /** 待办就地编辑：回车 / 失焦保存。先退出编辑态再写，避免重渲染触发第二次提交。 */
    async function commitTodoEdit({ epoch } = {}) {
        const owner = panel;
        if (!owner || !editingTodoId || panelRendering) return;
        if (epoch !== undefined && owner.epoch !== epoch) return;
        const id = editingTodoId;
        const todo = todos.find(t => t.id === id);
        const input = owner.panelEl.querySelector('#memoTodoInput');
        // 迟到的 focusout 可能来自已被替换的旧输入框：它的 id 与当前目标不一致时
        // 绝不能把旧文本提交到新目标。
        if (input && input.dataset?.id && input.dataset.id !== id) return;
        const raw = input ? input.value : '';
        editingTodoId = null;
        if (!todo || !input) {
            if (panel === owner) renderPanel();
            return;
        }
        const text = raw.trim();
        if (!text) {
            if (panel === owner) renderPanel();
            window.app?.showToast('待办内容不能为空', 'error');
            return false;
        }
        if (text === todoTextOf(todo)) {
            if (panel === owner) renderPanel();
            return;
        }
        const ok = await saveTodo(id, text);
        if (ok) window.app?.showToast('已保存');
        const retained = ok || todoDrafts.some(d => d.id === id && d.text === text);
        if (!retained) failedTodoEdits.set(id, raw);
        // 等待期间面板已换成别的对象、或用户已切到备忘页签/另一个编辑目标：
        // 迟到的结果只保留文字，不写新上下文的 DOM，也不恢复孤立的 editingTodoId。
        const sameContext = panel === owner
            && panelView === 'list'
            && !editingTodoId
            && activeTab === 'todo';
        if (!sameContext) return retained;
        if (!retained) {
            if (!todos.some(t => t.id === id)) {
                window.app?.showToast('待办保存失败，且该条已不存在', 'error');
                renderPanel();
                return false;
            }
            editingTodoId = id;
            renderPanel();
            const again = panel.panelEl.querySelector('#memoTodoInput');
            if (again) again.value = raw;
            return false;
        }
        renderPanel();
        return retained;
    }

    function cancelTodoEdit() {
        if (!editingTodoId) return;
        failedTodoEdits.delete(editingTodoId);
        editingTodoId = null;
        renderPanel();
    }

    async function doAddTodo() {
        if (!panel) return;
        const input = panel.panelEl.querySelector('#memoTodoNew');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;
        if (todos.length >= TODO_MAX_ENTRIES) {
            window.app?.showToast(`最多 ${TODO_MAX_ENTRIES} 条待办`, 'error');
            return;
        }
        const ok = await saveTodo(null, text);
        if (panel && panelView === 'list') {
            renderPanel();
            const again = panel.panelEl.querySelector('#memoTodoNew');
            if (again) {
                // 失败（已暂存）时把刚输入的内容放回去，避免用户重打一遍
                if (!ok) again.value = text;
                again.focus();
            }
        }
    }

    window.app.registerModule({
        id: 'memo',
        // 私人模块：分类在开发时固定，运行时无法改成 public。
        category: 'admin',
        title: '备忘与待办',
        // 说明文字由后台模块列表渲染在名称下方
        summary: '登录后可用 · 备忘与待办 · 多端自动同步',
        mountWidget,
        openPanel,
        unmount
    });
})();

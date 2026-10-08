/**
 * Special Line 时间线模块。
 *
 * 登录后可用——模块区整体由登录门控（app.js 的 syncModuleVisibility），
 * 这里不重复判断。数据在服务端 SQLite：台账与事件都在那里，服务器是唯一
 * 真相源。本模块按 pollInterval 轮询（挂载拉一次 → 定时拉 → 切回前台补拉）。
 *
 * 两种视图各自成一份状态：
 *  - 卡片（缩略时间线）永远按「全部来源 / 默认视图」拉最新 3 条，顺带带回
 *    未读数、来源状态与同步状态；
 *  - 面板按用户选的筛选拉自己那一页，支持游标分页。
 * 分开的理由：面板里筛过「未读」之后关掉面板，首页那张卡不该跟着变成未读列表。
 */
(() => {
    'use strict';

    const DEFAULT_POLL_MS = 15000;
    const CARD_ROWS = 3;
    const PAGE_SIZE = 20;
    const TITLE_MAX = 200;
    const SUMMARY_MAX = 2000;

    let api = null;
    let requestStack = null;

    // ================= 状态 =================

    /** 卡片用：最新几条（默认视图，全部来源） */
    let cardEvents = [];
    let unreadCount = 0;
    let sources = [];
    let syncState = 'synced';   // syncing | synced | failed
    let syncFailed = [];
    let lastSync = null;

    /** 面板用：用户筛选后的那一页 */
    let panelEvents = [];
    let panelCursor = null;
    let panelHasMore = false;
    let panelBusy = false;
    let panelError = null;
    let filterSource = null;    // null = 全部来源
    let filterView = 'all';     // all | unread | archived

    let pollTimer = null;
    let pollMs = DEFAULT_POLL_MS;
    let visibilityHandler = null;
    let inFlight = false;

    let cardBody = null;
    let cardStatus = null;
    let panel = null;
    let saveDialog = null;
    let saveTrigger = null;
    /** 保存对话框的草稿：取消/ Esc 关掉再打开时内容还在 */
    let saveDraft = { url: '', title: '', summary: '' };

    let lastCardKey = '';
    let lastCardStatusKey = '';
    let lastPanelKey = '';

    // ================= 小工具 =================

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function hm(ts) {
        const d = new Date(ts);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    /** 时间轴上那一列：今天/昨天/月日 */
    function dayLabel(ts) {
        const d = new Date(ts);
        const today = new Date();
        if (d.toDateString() === today.toDateString()) return '今天';
        const yesterday = new Date(Date.now() - 86400e3);
        if (d.toDateString() === yesterday.toDateString()) return '昨天';
        return `${d.getMonth() + 1}月${String(d.getDate()).padStart(2, '0')}日`;
    }

    function relTime(ts) {
        const s = (Date.now() - ts) / 1000;
        if (s < 60) return '刚刚';
        if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
        if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
        const d = new Date(ts);
        const y = new Date(Date.now() - 86400e3);
        if (d.toDateString() === y.toDateString()) return '昨天 ' + hm(ts);
        return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm(ts)}`;
    }

    /**
     * 只在成功态给同步时刻。同步中/失败时显示上一次成功的时刻，
     * 会让人以为刚刚同步成功过。
     */
    function syncTimeText() {
        return syncState === 'synced' && lastSync ? hm(lastSync) : '';
    }

    function statusPillHTML() {
        if (syncState === 'syncing') {
            return '<span class="special-line-pill" data-kind="pending"><span class="special-line-spinner"></span>同步中</span>';
        }
        if (syncState === 'failed') {
            return '<span class="special-line-pill" data-kind="alert">同步失败</span>' +
                '<button class="special-line-retry" type="button" data-action="retry">重试</button>';
        }
        return '<span class="special-line-pill" data-kind="ready">已同步</span>';
    }

    function unreadPillHTML() {
        return unreadCount > 0
            ? `<span class="special-line-pill" data-kind="unread">未读 ${unreadCount}</span>`
            : '';
    }

    /** provider 的短名：来源角标用 */
    function symbolOf(event) {
        return event.providerSymbol || '·';
    }

    function sourceNameOf(event) {
        if (event.providerType === 'manual') return '稍后阅读';
        return event.sourceName || event.providerType;
    }

    // ================= 卡片（缩略时间线） =================

    function cardKey() {
        return [
            unreadCount,
            syncState,
            cardEvents.slice(0, CARD_ROWS)
                .map(e => `${e.id}:${e.unread}:${e.archived}:${relTime(e.occurredAt)}`)
                .join('|')
        ].join('>');
    }

    function statusKey() {
        return [syncState, unreadCount, syncTimeText()].join('|');
    }

    function fillCardStatus() {
        if (cardStatus) cardStatus.innerHTML = statusPillHTML() + unreadPillHTML();
    }

    function renderCard() {
        if (!cardBody) return;
        lastCardKey = cardKey();
        const rows = cardEvents.slice(0, CARD_ROWS).map(e => {
            const href = e.url || '';
            const title = esc(e.title);
            const inner = href
                ? `<a class="special-line-row-title" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
                : `<span class="special-line-row-title">${title}</span>`;
            return `<div class="special-line-row"${e.unread ? ' data-unread="true"' : ''}>` +
                `<span class="special-line-sym" aria-hidden="true">${esc(symbolOf(e))}</span>` +
                inner +
                `<span class="special-line-row-time">${relTime(e.occurredAt)}</span>` +
                `</div>`;
        }).join('');

        cardBody.innerHTML =
            (cardEvents.length
                ? `<div class="special-line-rows">${rows}</div>`
                : '<div class="special-line-empty-card">还没有内容</div>') +
            `<div class="module-card-hint">共 ${cardEvents.length ? '≥' + cardEvents.length : 0} 条` +
                `${unreadCount ? ` · ${unreadCount} 条未读` : ''}` +
                ` · <button class="special-line-open" type="button" data-action="open">打开时间线</button>` +
            `</div>`;
        lastCardStatusKey = statusKey();
        fillCardStatus();
        if (requestStack) requestStack();
    }

    /** 数据没变就只刷状态行，不整块重写卡片（避免每轮都改 DOM） */
    function renderCardStatus() {
        if (!cardBody) return;
        const key = statusKey();
        if (key === lastCardStatusKey) return;
        lastCardStatusKey = key;
        fillCardStatus();
        if (requestStack) requestStack();
    }

    function renderCardMaybe() {
        if (!cardBody) return;
        if (cardKey() === lastCardKey) {
            renderCardStatus();
            return;
        }
        renderCard();
    }

    // ================= 轮询 =================

    function applyCardPayload(data) {
        cardEvents = Array.isArray(data.events) ? data.events : [];
        unreadCount = Number(data.unreadCount) || 0;
        if (Array.isArray(data.sources)) sources = data.sources;
        syncFailed = (data.sync && Array.isArray(data.sync.failed)) ? data.sync.failed : [];
        lastSync = Date.now();
        syncState = syncFailed.length ? 'failed' : 'synced';
    }

    /** 卡片那一份：默认视图、全部来源、只要前几条。 */
    async function pollCard({ manual = false } = {}) {
        if (inFlight) return;
        inFlight = true;
        if (manual) {
            syncState = 'syncing';
            renderCardMaybe();
        }
        try {
            const data = await api.get(`/api/timeline/events?view=all&limit=${CARD_ROWS}`);
            applyCardPayload(data || {});
            // 服务端回当前生效的周期：后台改过之后不必刷新页面
            if (Number.isFinite(data && data.pollInterval) && data.pollInterval * 1000 !== pollMs) {
                pollMs = data.pollInterval * 1000;
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = setInterval(pollCard, pollMs);
                }
            }
            renderCardMaybe();
            renderPanelMaybe();
        } catch (e) {
            console.error('Special line poll failed:', e);
            syncState = 'failed';
            renderCardMaybe();
            renderPanelMaybe();
        } finally {
            inFlight = false;
        }
    }

    /** 面板那一份：按用户筛选，支持游标分页。 */
    async function pollPanel({ append = false } = {}) {
        if (!panel || panelBusy) return;
        panelBusy = true;
        try {
            const params = new URLSearchParams({ view: filterView, limit: String(PAGE_SIZE) });
            if (filterSource) params.set('source', filterSource);
            if (append && panelCursor) params.set('cursor', panelCursor);
            const data = await api.get('/api/timeline/events?' + params.toString());
            if (!data || !Array.isArray(data.events)) throw new Error('bad payload');
            panelEvents = append ? [...panelEvents, ...data.events] : data.events;
            panelCursor = data.nextCursor || null;
            panelHasMore = !!data.hasMore;
            panelError = null;
            renderPanel();
        } catch (e) {
            console.error('Special line list failed:', e);
            panelError = e && e.status === 429
                ? '请求过于频繁，请等一分钟再重试'
                : '时间线读取失败';
            renderPanel();
        } finally {
            panelBusy = false;
        }
    }

    /** 只挂表与前后台监听，**不立即拉取**（首轮由 mountWidget 显式拉，好交给 whenReady）。 */
    function schedulePolling() {
        if (pollTimer) clearInterval(pollTimer);
        if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
        pollTimer = setInterval(pollCard, pollMs);

        // 页面不可见时停表；切回前台立即补拉一次。
        // ⚠️ 重排表必须用可变的 pollMs，写死 15 秒会悄悄打回用户设置的周期。
        visibilityHandler = () => {
            if (document.hidden) {
                clearInterval(pollTimer);
                pollTimer = null;
            } else if (!pollTimer) {
                pollCard();
                if (panel) pollPanel();
                pollTimer = setInterval(pollCard, pollMs);
            }
        };
        document.addEventListener('visibilitychange', visibilityHandler);
    }

    // ================= 写操作 =================

    async function setRead(event, read) {
        const before = event.unread;
        event.unread = !read;
        unreadCount = Math.max(0, unreadCount + (read ? -1 : 1));
        renderPanel();
        renderCardMaybe();
        try {
            await api.post(`/api/timeline/events/${encodeURIComponent(event.id)}/read`, { read });
            pollCard();
        } catch (e) {
            event.unread = before;
            unreadCount = Math.max(0, unreadCount + (read ? 1 : -1));
            renderPanel();
            renderCardMaybe();
            window.app?.showToast('标记失败，请重试', 'error');
        }
    }

    async function setArchived(event, archived) {
        const before = event.archived;
        event.archived = archived;
        renderPanel();
        try {
            await api.post(`/api/timeline/events/${encodeURIComponent(event.id)}/archive`, { archived });
            // 归档会把它移出当前视图，重新拉一次列表比在本地删更准
            pollPanel();
            pollCard();
        } catch (e) {
            event.archived = before;
            renderPanel();
            window.app?.showToast('归档失败，请重试', 'error');
        }
    }

    // ================= 保存文章对话框 =================

    function ensureSaveDialog() {
        if (saveDialog) return saveDialog;
        const dlg = document.createElement('dialog');
        dlg.className = 'special-line-dialog';
        dlg.setAttribute('aria-labelledby', 'specialLineDialogTitle');
        dlg.innerHTML = `
            <h2 id="specialLineDialogTitle">保存文章</h2>
            <p class="special-line-dialog-hint">粘贴链接，再填写标题；不自动获取网页内容。</p>
            <form class="special-line-form" novalidate>
                <label>文章链接（必填）
                    <input id="specialLineUrl" name="url" type="url" inputmode="url" autocomplete="url"
                           placeholder="https://…" maxlength="2048" required>
                </label>
                <label>文章标题（必填）
                    <input id="specialLineTitle" name="title" autocomplete="off"
                           placeholder="输入文章标题" maxlength="${TITLE_MAX}" required>
                </label>
                <details id="specialLineSummaryDetails">
                    <summary>添加摘要（可选）</summary>
                    <label>摘要
                        <textarea id="specialLineSummary" name="summary" rows="3"
                                  maxlength="${SUMMARY_MAX}" placeholder="稍后阅读时快速回想内容"></textarea>
                    </label>
                </details>
                <p class="special-line-form-error" role="alert" hidden></p>
                <footer class="special-line-form-actions">
                    <button class="btn" type="button" data-action="cancel-save">取消</button>
                    <button class="btn btn-primary" type="submit">保存到稍后阅读</button>
                </footer>
            </form>`;
        document.body.appendChild(dlg);

        const urlEl = dlg.querySelector('#specialLineUrl');
        const titleEl = dlg.querySelector('#specialLineTitle');
        const summaryEl = dlg.querySelector('#specialLineSummary');
        const errEl = dlg.querySelector('.special-line-form-error');

        // 输入就清错：留着上一次的红字会让人以为这次也不行
        dlg.addEventListener('input', () => {
            errEl.hidden = true;
            dlg.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
        });

        dlg.querySelector('[data-action="cancel-save"]').addEventListener('click', () => dlg.close());

        dlg.addEventListener('close', () => {
            // 草稿留下：取消/ Esc 关掉再打开，内容还在（用户不会白写一遍）
            saveDraft = { url: urlEl.value, title: titleEl.value, summary: summaryEl.value };
            if (saveTrigger && document.contains(saveTrigger)) saveTrigger.focus();
            else if (panel) {
                const btn = panel.panelEl.querySelector('[data-action="save"]');
                if (btn) btn.focus();
            }
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
            if (!title) {
                fail('请填写文章标题。', titleEl);
                return;
            }
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
                // 值回采进 saveDraft，只把 saveDraft 赋空是无效的（同步的 close
                // 回调紧接着就用旧值覆盖回去），下次打开会残留上一篇的链接与标题。
                urlEl.value = '';
                titleEl.value = '';
                summaryEl.value = '';
                saveDraft = { url: '', title: '', summary: '' };
                dlg.close();
                window.app?.showToast('已保存到稍后阅读');
                if (panel) pollPanel();
                pollCard();
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
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
        dlg.querySelector('#specialLineUrl').focus();
    }

    // ================= 时间线面板 =================

    function sourceChipsHTML() {
        const chips = [];
        chips.push(chipHTML(null, '全部来源'));
        for (const s of sources) {
            if (s.providerType === 'manual') continue;
            chips.push(chipHTML(s.id, s.providerLabel + (s.externalKey ? ' · ' + s.externalKey : '')));
        }
        // 「稍后阅读」是一个固定入口而不是一条来源记录：它永远在，且没有可配置项
        chips.push(chipHTML('manual', '稍后阅读'));
        return chips.join('');
    }

    function chipHTML(value, label) {
        const active = filterSource === value;
        return `<button class="special-line-chip" type="button" data-action="filter-source"` +
            ` data-value="${value === null ? '' : esc(value)}" aria-pressed="${active}">${esc(label)}</button>`;
    }

    function viewChipsHTML() {
        return [['all', '全部'], ['unread', '未读'], ['archived', '已归档']]
            .map(([value, label]) =>
                `<button class="special-line-chip" type="button" data-action="filter-view"` +
                ` data-value="${value}" aria-pressed="${filterView === value}">${label}</button>`)
            .join('');
    }

    function eventHTML(e) {
        const href = e.url || '';
        const title = esc(e.title);
        const linked = href
            ? `<a class="special-line-title" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}` +
              `<span class="sr-only">（新标签页打开）</span></a>`
            : title;
        const quote = e.quote ? `<blockquote>${esc(e.quote)}</blockquote>` : '';
        return `<li class="special-line-item" data-unread="${e.unread ? 'true' : 'false'}">` +
            `<time class="special-line-time"><strong>${esc(dayLabel(e.occurredAt))}</strong>${hm(e.occurredAt)}</time>` +
            `<article class="special-line-event">` +
                `<div class="special-line-meta">` +
                    `<span class="special-line-source"><span class="special-line-icon" aria-hidden="true">${esc(symbolOf(e))}</span>` +
                        `${esc(sourceNameOf(e))}${e.author ? ' · ' + esc(e.author) : ''}</span>` +
                    `<span class="special-line-type">${esc(e.eventTypeLabel || '')}</span>` +
                    `<span class="sr-only">${e.unread ? '未读' : '已读'}</span>` +
                    `<details class="special-line-tools">` +
                        `<summary aria-label="事件操作" title="事件操作">⋯</summary>` +
                        `<div class="special-line-actions">` +
                            `<button class="special-line-action" type="button" data-action="read" data-id="${esc(e.id)}"` +
                                ` aria-pressed="${e.unread ? 'false' : 'true'}">${e.unread ? '标为已读' : '标为未读'}</button>` +
                            `<button class="special-line-action" type="button" data-action="archive" data-id="${esc(e.id)}"` +
                                ` aria-pressed="${e.archived ? 'true' : 'false'}">${e.archived ? '取消归档' : '归档'}</button>` +
                        `</div>` +
                    `</details>` +
                `</div>` +
                `<h3>${linked}</h3>` +
                (e.summary ? `<p>${esc(e.summary)}</p>` : '') +
                quote +
            `</article></li>`;
    }

    function panelKey() {
        return [
            filterSource || '', filterView, syncState,
            panelEvents.map(e => `${e.id}:${e.unread}:${e.archived}`).join('|')
        ].join('>');
    }

    function renderPanel() {
        if (!panel) return;
        const body = panel.panelEl;
        const failed = syncFailed.length;
        // 失败提示必须先说「旧事件还在」再给下一步：用户看到「同步未完成」的
        // 第一反应是「我的内容是不是没了」。仿真样例里确认过的措辞就是这句。
        const notice = failed
            ? `<div class="special-line-notice" role="status"><strong>同步未完成</strong><span>` +
              `保留了上次同步的事件。` +
              esc(syncFailed.map(f => f.code === 'auth'
                  ? `${f.name} 需要重新授权，可到后台「模块」分区更新`
                  : `${f.name} 同步失败，稍后会自动重试`).join('；')) +
              `</span></div>`
            : '';
        // 列表标题随筛选切换（仿真的「最近动态 / 未读动态 / 已归档」）
        const listTitle = filterView === 'unread' ? '未读动态'
            : filterView === 'archived' ? '已归档' : '最近动态';
        const listHTML = panelEvents.map(eventHTML).join('');
        const empty = !panelEvents.length;
        const noResult = empty && (filterSource !== null || filterView !== 'all');
        const emptyHTML = empty
            ? (noResult
                ? `<section class="special-line-state"><span class="special-line-state-icon" aria-hidden="true">⌕</span>` +
                  `<h3>没有匹配的事件</h3><p>当前来源或状态筛选下没有内容。清除筛选后可查看完整时间线。</p>` +
                  `<button class="btn" type="button" data-action="reset-filters">清除筛选</button></section>`
                : `<section class="special-line-state"><span class="special-line-state-icon" aria-hidden="true">◷</span>` +
                  `<h3>时间线还没有内容</h3>` +
                  `<p>订阅来源请在后台「模块」分区配置；也可以先保存一篇文章。这里会按发生时间汇集各类事件。</p>` +
                  `<button class="btn btn-primary" type="button" data-action="save">＋ 保存文章</button></section>`)
            : '';
        const errorHTML = panelError
            ? `<div class="special-line-notice" role="alert"><strong>读取失败</strong><span>${esc(panelError)}</span>` +
              `<button class="btn" type="button" data-action="reload">重试</button></div>`
            : '';

        body.innerHTML =
            `<div class="special-line-head">` +
                `<h2>Special Line</h2>` +
                `<span class="special-line-subtitle">动态 · 稍后阅读</span>` +
                `<span class="special-line-sync">${statusPillHTML()}${unreadPillHTML()}` +
                    `${syncTimeText() ? `<span class="special-line-time-note">${syncTimeText()} 同步</span>` : ''}</span>` +
                `<button class="btn" type="button" data-action="sync">↻ 同步</button>` +
                `<button class="btn btn-primary" type="button" data-action="save">＋ 保存文章</button>` +
                `<button class="module-panel-close" type="button" data-action="close" aria-label="关闭">×</button>` +
            `</div>` +
            `<nav class="special-line-filters" aria-label="时间线筛选">` +
                `<div class="special-line-source-filters" role="group" aria-label="按来源筛选">${sourceChipsHTML()}</div>` +
                `<div class="special-line-view-filters" role="group" aria-label="按状态筛选">${viewChipsHTML()}</div>` +
            `</nav>` +
            errorHTML + notice +
            (panelEvents.length
                ? `<div class="special-line-topline"><h3>${listTitle}</h3>` +
                  `<span>${panelEvents.length} 条事件</span></div>` +
                  `<ol class="special-line-timeline" aria-label="按时间倒序排列的事件">${listHTML}</ol>`
                : '') +
            (panelBusy && !panelEvents.length
                ? '<section class="special-line-loading" aria-label="正在读取时间线">' +
                  '<div class="special-line-skeleton"></div><div class="special-line-skeleton"></div>' +
                  '<div class="special-line-skeleton"></div></section>'
                : '') +
            emptyHTML +
            (panelHasMore && !empty
                ? `<div class="special-line-more"><button class="btn" type="button" data-action="more">加载更早事件</button></div>`
                : '') +
            `<p class="special-line-foot">${panelEvents.length} 条${panelHasMore ? '（还有更早的）' : ''}` +
                `${lastSync ? ` · 更新于 ${hm(lastSync)}` : ''}</p>`;

        lastPanelKey = panelKey();
    }

    /** 数据没变就不重渲染：否则每 15 秒的轮询会把用户展开的「⋯」菜单收起来 */
    function renderPanelMaybe() {
        if (!panel) return;
        if (panelKey() === lastPanelKey) return;
        renderPanel();
    }

    function openPanel() {
        if (panel) return panel.overlay;

        const overlay = document.createElement('div');
        overlay.className = 'module-overlay';

        const panelEl = document.createElement('div');
        panelEl.className = 'module-panel special-line-panel';
        panelEl.setAttribute('role', 'dialog');
        panelEl.setAttribute('aria-modal', 'true');
        panelEl.setAttribute('aria-label', 'Special Line 时间线');

        overlay.appendChild(panelEl);
        document.body.appendChild(overlay);

        panel = { overlay, panelEl };

        const closePanel = () => {
            if (saveDialog && saveDialog.open) saveDialog.close();
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            panel = null;
        };
        const onKey = event => { if (event.key === 'Escape') closePanel(); };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closePanel();
        });

        // 点击委托在面板根上：内部重渲染不会丢监听
        panelEl.addEventListener('click', event => {
            const target = event.target.closest('[data-action]');
            if (!target) return;
            const action = target.dataset.action;
            const id = target.dataset.id;
            switch (action) {
                case 'close':
                    closePanel();
                    break;
                case 'sync':
                    pollCard({ manual: true });
                    pollPanel();
                    break;
                case 'reload':
                    pollPanel();
                    break;
                case 'save':
                    openSaveDialog(target);
                    break;
                case 'more':
                    pollPanel({ append: true });
                    break;
                case 'read': {
                    const e = panelEvents.find(x => x.id === id);
                    if (e) setRead(e, e.unread);
                    break;
                }
                case 'archive': {
                    const e = panelEvents.find(x => x.id === id);
                    if (e) setArchived(e, !e.archived);
                    break;
                }
                case 'filter-source':
                    filterSource = target.dataset.value || null;
                    panelEvents = [];
                    panelCursor = null;
                    renderPanel();
                    pollPanel();
                    break;
                case 'filter-view':
                    filterView = target.dataset.value || 'all';
                    panelEvents = [];
                    panelCursor = null;
                    renderPanel();
                    pollPanel();
                    break;
                case 'reset-filters':
                    filterSource = null;
                    filterView = 'all';
                    panelEvents = [];
                    panelCursor = null;
                    renderPanel();
                    pollPanel();
                    break;
            }
        });

        renderPanel();
        pollPanel();
        return overlay;
    }

    // ================= 后台：来源管理 =================

    const STATUS_TEXT = {
        ok: '已连接',
        pending: '待授权',
        expired: '授权失效',
        paused: '已暂停',
        failed: '同步失败'
    };

    /**
     * 后台「模块」分区里的来源区块。由 app.js 在渲染模块编辑器时调用，
     * 并注入 API（那时模块可能并未挂载，不能指望 mountWidget 留下的引用）。
     */
    function renderAdminSection(host, state) {
        const adminApi = (state && state.api) || api;
        if (!adminApi) {
            host.innerHTML = '<p class="fav-hint">未拿到 API，无法读取来源。</p>';
            return;
        }

        let providers = [];
        /** 表单模式：null=收起，{mode:'add'} 或 {mode:'reauth', id, providerType, externalKey} */
        let form = null;
        let busy = false;

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

        function rowHTML(s) {
            const canReauth = s.status === 'expired' || s.status === 'pending';
            const actions = [];
            if (canReauth) actions.push(`<button class="btn" type="button" data-act="reauth" data-id="${esc(s.id)}">重新授权</button>`);
            else actions.push(`<button class="btn" type="button" data-act="test" data-id="${esc(s.id)}">测试连接</button>`);
            actions.push(`<button class="btn" type="button" data-act="sync" data-id="${esc(s.id)}">立即同步</button>`);
            actions.push(`<button class="btn" type="button" data-act="toggle" data-id="${esc(s.id)}">${s.enabled ? '暂停同步' : '恢复同步'}</button>`);
            actions.push(`<button class="btn btn-danger" type="button" data-act="del" data-id="${esc(s.id)}">删除</button>`);
            const err = s.lastError
                ? `<div class="special-line-source-error">${esc(s.lastError.message || '')}</div>`
                : '';
            return `<div class="special-line-source-row" data-id="${esc(s.id)}">` +
                `<span class="special-line-icon" aria-hidden="true">${esc(s.providerSymbol || '·')}</span>` +
                `<div class="special-line-source-copy">` +
                    `<strong>${esc(s.providerLabel)}${s.externalKey ? ' · ' + esc(s.externalKey) : ''}</strong>` +
                    `<small>${s.lastSuccessAt ? `最近成功 ${esc(relTime(s.lastSuccessAt))}` : '尚未同步成功'}` +
                        `${s.hasCredentials ? '' : ' · 未配置凭据'}</small>` +
                    err +
                `</div>` +
                `<span class="special-line-source-state" data-status="${esc(s.status)}">${esc(STATUS_TEXT[s.status] || s.status)}</span>` +
                `<div class="special-line-source-actions">${actions.join('')}</div>` +
            `</div>`;
        }

        function formHTML() {
            if (!form) return '';
            const editing = form.mode === 'reauth';
            const current = editing ? providers.find(p => p.id === form.providerType) : null;
            const providerOptions = providers.map(p =>
                `<option value="${esc(p.id)}" ${editing && p.id === form.providerType ? 'selected' : ''}>${esc(p.label)}</option>`
            ).join('');
            const accountLabel = (current && current.accountLabel) ||
                (providers[0] && providers[0].accountLabel) || '账号标识';
            const credentialLabel = (current && current.credentialLabel) ||
                (providers[0] && providers[0].credentialLabel) || '凭据';
            return `<form class="special-line-source-form">
                <label>平台
                    <select name="providerType" ${editing ? 'disabled' : ''}>${providerOptions}</select>
                </label>
                <label>${esc(accountLabel)}
                    <input name="externalKey" autocomplete="off" value="${esc(form.externalKey || '')}">
                </label>
                <label>${esc(credentialLabel)}
                    <input name="token" type="password" autocomplete="off"
                           placeholder="${editing ? '留空表示保留原值' : '在平台开发者后台获取'}" value="">
                </label>
                <div class="special-line-form-actions">
                    <button class="btn" type="button" data-act="form-cancel">取消</button>
                    <button class="btn btn-primary" type="submit">${editing ? '重新授权' : '保存并测试'}</button>
                </div>
            </form>`;
        }

        function draw(list) {
            const rows = list.filter(s => s.providerType !== 'manual');
            host.innerHTML =
                `<p class="fav-hint">社交订阅在服务端用官方接口拉取；稍后阅读由你在首页保存。` +
                `凭据只存在服务端，不会回传到页面。</p>` +
                `<div class="special-line-source-list">${rows.length ? rows.map(rowHTML).join('') : '<p class="fav-hint">还没有订阅来源。</p>'}</div>` +
                `<button class="btn" id="specialLineAddSource">＋ 添加订阅来源</button>` +
                formHTML() +
                `<p class="special-line-source-note">保存前会先测试连通：连不上的凭据不会被保存下来。</p>`;
            bind(list);
        }

        function bind(list) {
            host.querySelector('#specialLineAddSource')?.addEventListener('click', () => {
                form = { mode: 'add', externalKey: '' };
                draw(list);
                host.querySelector('.special-line-source-form input[name="externalKey"]')?.focus();
            });

            host.querySelectorAll('.special-line-source-form [data-act="form-cancel"]').forEach(btn => {
                btn.addEventListener('click', () => { form = null; draw(list); });
            });

            host.querySelector('.special-line-source-form')?.addEventListener('submit', async event => {
                event.preventDefault();
                if (busy) return;
                const el = event.currentTarget;
                const providerType = el.querySelector('[name="providerType"]').value;
                const externalKey = el.querySelector('[name="externalKey"]').value.trim();
                const token = el.querySelector('[name="token"]').value;
                if (!externalKey) {
                    window.app?.showToast('请填写账号标识', 'error');
                    return;
                }
                if (form.mode === 'add' && !token) {
                    window.app?.showToast('请填写凭据', 'error');
                    return;
                }
                busy = true;
                const submit = el.querySelector('button[type="submit"]');
                submit.disabled = true;
                submit.textContent = '测试中…';
                try {
                    if (form.mode === 'add') {
                        const data = await adminApi.post('/api/timeline/sources', { providerType, externalKey, token });
                        if (data && data.error) throw Object.assign(new Error(data.error), { status: 400 });
                        window.app?.showToast('来源已添加');
                    } else {
                        const { res, data } = await adminApi.request(
                            `/api/timeline/sources/${encodeURIComponent(form.id)}`,
                            {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ externalKey, token: token || undefined })
                            });
                        if (!res.ok) throw Object.assign(new Error((data && data.error) || '保存失败'), { status: res.status });
                        window.app?.showToast('已更新授权');
                    }
                    form = null;
                    await load();
                } catch (e) {
                    window.app?.showToast(e.message || '操作失败', 'error');
                    submit.disabled = false;
                    submit.textContent = form && form.mode === 'reauth' ? '重新授权' : '保存并测试';
                } finally {
                    busy = false;
                }
            });

            host.querySelectorAll('[data-act]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.dataset.id;
                    const source = list.find(s => s.id === id);
                    if (!source) return;
                    switch (btn.dataset.act) {
                        case 'reauth':
                            form = {
                                mode: 'reauth', id,
                                providerType: source.providerType,
                                externalKey: source.externalKey
                            };
                            draw(list);
                            break;
                        case 'test': {
                            btn.disabled = true;
                            try {
                                const data = await adminApi.post(`/api/timeline/sources/${encodeURIComponent(id)}/test`, {});
                                window.app?.showToast(data && data.ok ? '连接正常' : `连接失败：${(data && data.error) || '未知原因'}`,
                                    data && data.ok ? 'success' : 'error');
                            } catch (e) {
                                window.app?.showToast('测试失败，请重试', 'error');
                            } finally {
                                btn.disabled = false;
                            }
                            break;
                        }
                        case 'sync': {
                            btn.disabled = true;
                            try {
                                const data = await adminApi.post(`/api/timeline/sources/${encodeURIComponent(id)}/sync`, {});
                                if (data && data.ok) {
                                    window.app?.showToast(data.skipped ? '已跳过（来源已暂停）' : `同步完成，新增 ${data.inserted} 条`);
                                } else {
                                    window.app?.showToast(`同步失败：${(data && data.error) || '未知原因'}`, 'error');
                                }
                            } catch (e) {
                                window.app?.showToast('同步失败，请重试', 'error');
                            } finally {
                                btn.disabled = false;
                                load();
                            }
                            break;
                        }
                        case 'toggle': {
                            const { res } = await adminApi.request(
                                `/api/timeline/sources/${encodeURIComponent(id)}`,
                                {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ enabled: !source.enabled })
                                });
                            if (res.ok) window.app?.showToast(source.enabled ? '已暂停同步' : '已恢复同步');
                            else window.app?.showToast('操作失败', 'error');
                            load();
                            break;
                        }
                        case 'del': {
                            const confirmed = window.app && window.app.showUiDialog
                                ? await window.app.showUiDialog({
                                    title: '删除订阅来源',
                                    message: `删除「${source.providerLabel} · ${source.externalKey}」会同时删除它已同步的事件。`,
                                    danger: true, confirmText: '删除'
                                })
                                : false;
                            if (!confirmed) return;
                            const { res, data } = await adminApi.request(
                                `/api/timeline/sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
                            if (res.ok) window.app?.showToast('已删除');
                            else window.app?.showToast((data && data.error) || '删除失败', 'error');
                            load();
                            break;
                        }
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
        card.className = 'module-card';
        // 布局键是稳定域 id，不是数组下标（平台约定）
        card.dataset.instanceId = 'special-line:main';

        const head = document.createElement('div');
        head.className = 'module-widget-head';

        const label = document.createElement('span');
        label.className = 'module-widget-title';
        label.textContent = 'Special Line';

        // 状态胶囊写在卡片头里（标题右侧），与备忘录卡片一致；
        // 正文整块重建时不会顺手把它抹掉——两处各写各的。
        const status = document.createElement('span');
        status.className = 'special-line-card-status';

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'module-drag-handle';
        handle.title = '拖拽调整位置';
        handle.setAttribute('aria-label', '拖拽调整 Special Line 的位置');
        // 显隐交给平台的 .module-zone.is-editing 规则，不在这里写 hidden

        head.append(label, status, handle);

        const body = document.createElement('div');
        body.className = 'module-widget-body';

        card.append(head, body);
        cardBody = body;
        cardStatus = status;

        // 委托挂在**整张卡**上：卡头里的「重试」与正文里的行/按钮是兄弟节点，
        // 挂在正文上会让卡头那个按钮变成死按钮。
        card.addEventListener('click', event => {
            const target = event.target.closest('[data-action]');
            if (!target) return;
            if (target.dataset.action === 'open') openPanel();
            else if (target.dataset.action === 'retry') pollCard({ manual: true });
        });

        renderCard();
        const firstRound = pollCard();
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
        adminSectionTitle: 'Special Line · 订阅来源',
        mountWidget,
        openPanel,
        renderAdminSection
    });
})();

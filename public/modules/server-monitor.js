/**
 * 服务器监控模块。
 *
 * 第一个落地模块，也是唯一一个不需要 API key 的——本机直接读 `os`，
 * 远端读目标机上跑的 agent/agent.js。
 *
 * **一台服务器一张卡片**：mountWidget 返回节点数组，平台把每个节点当作
 * 一张独立卡片（可单独拖拽、单独换边）。本机固定排第一，不需要配置。
 */
(() => {
    'use strict';

    const POLL_MS = 15000;

    let pollTimer = null;
    let inFlight = false;
    let lastPayload = null;
    let visibilityHandler = null;
    /** 已挂载的卡片：serverId → { card, body, label } */
    const cards = new Map();

    function fmtPercent(value) {
        return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
    }

    function fmtBytes(bytes) {
        if (!Number.isFinite(bytes)) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let i = 0;
        while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
        return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
    }

    function fmtDuration(seconds) {
        if (!Number.isFinite(seconds)) return '—';
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d) return `${d} 天 ${h} 小时`;
        if (h) return `${h} 小时 ${m} 分`;
        return `${m} 分`;
    }

    /** 一条指标：标签 + 数值 + 迷你进度条。纯 div，无 canvas。 */
    function metricRow(label, value, ratio) {
        const row = document.createElement('div');
        row.className = 'module-metric';

        const name = document.createElement('span');
        name.className = 'module-metric-label';
        name.textContent = label;

        const val = document.createElement('span');
        val.className = 'module-metric-value';
        val.textContent = value;

        const bar = document.createElement('span');
        bar.className = 'module-metric-bar';
        // 进度不可知时 --pct 缺失，CSS 回落到 0 宽，而不是显示一个假的满格
        if (Number.isFinite(ratio)) {
            bar.style.setProperty('--pct', `${Math.min(100, Math.max(0, ratio * 100))}%`);
        }
        const fill = document.createElement('span');
        fill.className = 'module-metric-fill';
        bar.appendChild(fill);

        row.append(name, val, bar);
        return row;
    }

    /** 只显示主机与端口，不必让用户每次都看见 https:// 前缀。 */
    function displayHost(url) {
        try {
            const u = new URL(url);
            return u.port ? `${u.hostname}:${u.port}` : u.hostname;
        } catch {
            return url;
        }
    }

    /** 字节数 → 人类可读（GB/TB）。取不到时返回 '—'。 */
    function fmtBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        let v = bytes, i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    }

    /**
     * 三条指标。
     *
     * 第三条曾经是「负载（1 / 5 分钟）」——用户原话「不在首页显示负载信息了
     * 不容易读懂，换成存储占用吧」。负载对不熟悉的人没有直觉：
     * 「0.52 / 0.61」是高还是低？得知道有几核才知道。
     * 存储占用是「用了 320 GB / 460 GB」，看一眼就知道急不急。
     *
     * 详情面板里**仍保留**负载——那里有 CPU 和核数做参照，能读懂的人
     * 仍然看得到，只是不再占据首页那一行。
     */
    function metricRows(m) {
        const diskPercent = (Number.isFinite(m.diskTotal) && m.diskTotal > 0)
            ? m.diskUsed / m.diskTotal
            : null;
        return [
            metricRow('CPU', fmtPercent(m.cpu), m.cpu),
            metricRow('内存', fmtPercent(m.memoryPercent), m.memoryPercent),
            metricRow('存储',
                m.diskTotal > 0
                    ? `${fmtBytes(m.diskUsed)} / ${fmtBytes(m.diskTotal)}`
                    : '—',
                diskPercent)
        ];
    }

    /**
     * 状态位只回答「这台机器现在能不能读到数据」。
     *
     * 曾经这里还区分「已就绪 / 等待 / 未部署」——用户原话是
     * 「主要体现是否在线就行了」。那些是**后台操作台**需要的信息
     * （该点部署、还是去查网络），而首页是一眼扫过的地方：
     * 一台正常工作的机器显示「已就绪」，对「它活着吗」这个问题
     * 没有任何额外信息量，只增加了一种要记的词。
     *
     * 所以这里收敛成在线 / 离线 / 出问题三态。后台那张卡片仍然
     * 保留完整的三状态位——那里才是分派任务的地方。
     *
     * 但**异常必须说出来**：证书被换、端口被别的程序占了，
     * 这不是「离线」能覆盖的，用户不点进详情就会一直以为机器挂了。
     */
    function statusKindOf(entry) {
        if (!entry || entry.id === 'local') return 'ready';
        // 安全事件与端口冲突：这两种要让用户看见，不能塌缩成「离线」
        if (entry.certMismatch) return 'alert';
        if (entry.deployState === 'port_conflict') return 'alert';
        // 能读到指标 = 真的通了。这是最可靠的信号，优先于任何状态字段
        if (entry.online && entry.metrics) return 'ready';
        // 已注册但拉不到：机器在，agent 或网络有问题
        if (entry.enrolled) return entry.online ? 'pending' : 'offline';
        return entry.online ? 'ready' : 'not_deployed';
    }

    /** 状态位的文案。首页只回答「能不能读到数据」。 */
    function statusLabelOf(entry) {
        switch (statusKindOf(entry)) {
            case 'ready': return '在线';
            case 'alert': return '异常';
            case 'pending': return '连不上';
            default: return '离线';
        }
    }

    function errorBox(message) {
        const box = document.createElement('div');
        box.className = 'module-widget-error';
        const detail = document.createElement('span');
        detail.className = 'module-widget-error-detail';
        detail.textContent = message;
        box.appendChild(detail);
        return box;
    }

    /**
     * 「最后更新 N 前」。推送模式才有——拉取模式是当场拉一次，没有"上次"的概念。
     */
    function lastUpdatedText(receivedAt) {
        if (!Number.isFinite(receivedAt)) return null;
        const seconds = Math.max(0, Math.round((Date.now() - receivedAt) / 1000));
        if (seconds < 60) return '最后更新 不到 1 分钟前';
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `最后更新 ${minutes} 分钟前`;
        const hours = Math.round(minutes / 60);
        return `最后更新 ${hours} 小时前`;
    }

    function renderCardBody(body, entry) {
        if (!entry || (!entry.online && !entry.metrics)) {
            // 凭据被拒与机器挂掉要给不同的处置：前者去重填 token，后者去查机器。
            // 只给一行文本的话，用户得自己判断是哪一种。
            const box = errorBox((entry && entry.error) || '未获取到数据');
            if (entry && entry.authFailed) {
                box.dataset.authFailed = '1';
                const hint = document.createElement('div');
                hint.className = 'module-card-hint';
                hint.textContent = '在后台「模块 → 监控目标」重新输入 token';
                box.appendChild(hint);
            }
            body.replaceChildren(box);
            return;
        }

        // 推送模式断线时服务端**保留**了上次数值：能看到「断线前一切正常」
        // 与「一直没上来」的区别，这两个排查方向完全不同。所以这里只在
        // 真的没有 metrics 时才走上面的错误分支。
        if (entry.metrics) {
            const nodes = metricRows(entry.metrics);
            if (Number.isFinite(entry.latencyMs)) {
                const hint = document.createElement('div');
                hint.className = 'module-card-hint';
                hint.textContent = `${entry.latencyMs}ms`;
                nodes.push(hint);
            }
            if (Number.isFinite(entry.pushReceivedAt)) {
                const hint = document.createElement('div');
                hint.className = 'module-card-hint';
                hint.dataset.pushStale = entry.pushStale ? '1' : '0';
                hint.textContent = lastUpdatedText(entry.pushReceivedAt) || '';
                nodes.push(hint);
            }
            body.replaceChildren(...nodes);
            return;
        }
        body.replaceChildren(errorBox('未获取到数据'));
    }

    /**
     * 拉一次全部服务器，更新每张已挂载的卡片。
     * 失败要 render 出来——只渲染成功分支会让上一份数据一直留在屏上。
     */
    async function poll() {
        if (inFlight) return;
        inFlight = true;
        try {
            const res = await fetch('/api/modules/metrics', {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const payload = await res.json();
            if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
            lastPayload = payload;

            // 服务端会回当前生效的周期：用户在后台改过之后，
            // 不必刷新页面就能按新周期走。
            if (Number.isFinite(payload.pollInterval) && payload.pollInterval * 1000 !== pollMs) {
                pollMs = payload.pollInterval * 1000;
                // 已经在跑就重排表，否则会一直用旧周期直到下次进页面
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = setInterval(poll, pollMs);
                }
            }

            for (const entry of payload.servers || []) {
                const card = cards.get(entry.id);
                if (!card) continue;
                card.label.textContent = entry.name || entry.id;
                card.card.dataset.online = entry.online ? '1' : '0';
                // 状态位每次刷新都要跟着更新：它是从「有没有指标 / 有没有注册」
                // 推出来的，机器从「未部署」变成「已就绪」时全靠这一步体现。
                // 只在挂载时设一次是不够的——那正是上一版的问题：
                // 部署完成后首页仍然显示旧状态，用户以为没生效。
                const kind = statusKindOf(entry);
                if (card.status.dataset.kind !== kind) {
                    card.status.dataset.kind = kind;
                    card.status.textContent = statusLabelOf(entry);
                }
                renderCardBody(card.body, entry);
            }

            // 卡片高度随内容变（在线带延迟提示 174px、离线只有 98px），
            // 而宽屏的纵向偏移是按实测高度排的——每次渲染后都要重排，
            // 否则「上线」或「掉线」会让下面几张错位或重叠。
            if (typeof window.app?.stackWidgetsByHeight === 'function') {
                window.app.stackWidgetsByHeight();
            }

        } catch (e) {
            console.error('Server monitor poll failed:', e);
            for (const card of cards.values()) {
                card.body.replaceChildren(errorBox('监控数据读取失败'));
            }
        } finally {
            inFlight = false;
        }
    }

    /** 轮询周期。首次用服务端给的 pollInterval 覆盖，之后由用户设置决定。 */
    let pollMs = POLL_MS;

    function startPolling() {
        stopPolling();
        poll();
        pollTimer = setInterval(poll, pollMs);

        // 页面不可见时停表：后台 tab 继续轮询只会白耗请求配额
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

    function stopPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        if (visibilityHandler) {
            document.removeEventListener('visibilitychange', visibilityHandler);
            visibilityHandler = null;
        }
        cards.clear();
        lastPayload = null;
    }

    /** 建一张服务器卡片。 */
    function buildCard(entry) {
        const card = document.createElement('section');
        card.className = 'module-card';
        card.dataset.serverId = entry.id;
        // 布局键绑定**服务器 id**，不是数组下标。关掉一台机器后，
        // 其余卡片的键不能整体前移——否则所有人的顺序与左右都乱。
        card.dataset.instanceId = `server-monitor:${entry.id}`;
        card.dataset.online = entry.online ? '1' : '0';

        const head = document.createElement('div');
        head.className = 'module-widget-head';

        const label = document.createElement('span');
        label.className = 'module-widget-title';
        label.textContent = entry.name || entry.id;

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'module-drag-handle';
        handle.title = '拖拽调整位置';
        handle.setAttribute('aria-label', `拖拽调整${entry.name || entry.id}的位置`);
        // 显隐交给平台的 .module-zone.is-editing 规则，不在这里写 hidden：
        // 挂载时 editLayout 几乎总是 false，hidden 会压过任何 CSS。

        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = 'module-widget-expand';
        expand.title = '查看详情';
        expand.setAttribute('aria-label', `查看${entry.name || entry.id}的监控详情`);
        expand.textContent = '详情';

        // 部署状态位。首页卡片只有 132–220px 宽，放不下按钮，
        // 所以这里只传达状态、操作留在后台——五张卡片并排时多一个按钮
        // 会让整屏的视觉密度明显上升。
        const status = document.createElement('span');
        status.className = 'module-card-status';
        status.dataset.kind = statusKindOf(entry);
        status.textContent = statusLabelOf(entry);
        status.title = entry.id === 'local'
            ? '本机，直接读取'
            : (entry.enrolled ? '已注册，正在上报指标' : '还没在目标机上部署 agent');

        head.append(label, status, handle, expand);

        const body = document.createElement('div');
        body.className = 'module-widget-body';

        card.append(head, body);
        expand.addEventListener('click', event => {
            event.stopPropagation();
            openPanel(entry.id);
        });

        // status 也要存进 Map：刷新时要更新它，而那时拿不到 DOM 引用
        cards.set(entry.id, { card, body, label, status });
        renderCardBody(body, entry);
        return card;
    }

    /**
     * 紧凑态：按配置里的服务器列表建卡片。
     * 本机永远存在、排在第一，不需要配置——装完就能看到一个有效卡片。
     */
    function mountWidget(shell, state) {
        const servers = (state.config && state.config.servers) || [];
        const entries = [{ id: 'local', name: '本机', online: true, isLocal: true }]
            .concat(servers.map(s => ({ id: s.id, name: s.name || s.url, online: false })));

        // 逐台可见性由 widgets[].enabled 控制，缺省为「显示」。
        // 本机不可关：它是这个模块唯一的零配置产物，关掉的话
        // 用户会得到一个空模块区，却没有任何入口能把它开回来。
        const hidden = new Set((state.config.widgets || [])
            .filter(w => w.enabled === false)
            .map(w => w.id));
        const visible = entries.filter(e => e.id === 'local' || !hidden.has(`server-monitor:${e.id}`));

        startPolling();
        return visible.map(buildCard);
    }

    /** 全屏面板：选中的一台的详情 + 全部服务器概览。 */
    function openPanel(serverId) {
        const all = (lastPayload && lastPayload.servers) || [];
        const entry = all.find(s => s.id === serverId)
            || { id: serverId, name: serverId, online: false, error: '未获取到数据' };

        const overlay = document.createElement('div');
        overlay.className = 'module-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'module-panel';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', `${entry.name} 监控详情`);

        const head = document.createElement('div');
        head.className = 'module-panel-head';
        const title = document.createElement('h2');
        title.textContent = entry.name || serverId;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'module-panel-close';
        close.setAttribute('aria-label', '关闭');
        close.textContent = '×';
        head.append(title, close);

        const body = document.createElement('div');
        body.className = 'module-panel-body';

        dialog.append(head, body);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const closePanel = () => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
        };
        const onKey = event => { if (event.key === 'Escape') closePanel(); };
        document.addEventListener('keydown', onKey);
        close.addEventListener('click', closePanel);
        overlay.addEventListener('click', event => { if (event.target === overlay) closePanel(); });

        renderPanelBody(body, entry, all);
        return overlay;
    }

    function renderPanelBody(body, entry, all) {
        const nodes = [];

        // 地址放在最前面，且**在指标之外**——即使这台机器拉不到数据
        // 也要能看到它。用户在排障时第一句问的是「它到底在哪台机器上」，
        // 而那个状态下没有 metrics、没有 detail，只有一句 error。
        //
        // 服务端一直在传 `url`（server.js 的 collect 里就有），前端此前
        // 从没读过它——又一个「算了没人用」的字段。
        if (entry.url) {
            const addr = document.createElement('div');
            addr.className = 'module-panel-address';
            const host = document.createElement('span');
            host.className = 'module-panel-address-host';
            // 只显示主机与端口：https:// 前缀每一台都一样，占地方且不增信息
            host.textContent = displayHost(entry.url);
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'btn btn-sm';
            copy.textContent = '复制';
            copy.title = `复制 ${entry.url}`;
            copy.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(entry.url);
                    copy.textContent = '已复制';
                    setTimeout(() => { copy.textContent = '复制'; }, 1500);
                } catch {
                    copy.textContent = '复制失败';
                    setTimeout(() => { copy.textContent = '复制'; }, 1500);
                }
            });
            addr.append(host, copy);
            nodes.push(addr);
        }

        if (!entry.metrics) {
            nodes.push(errorBox(entry.error || '未获取到数据'));
        } else {
            const m = entry.metrics;
            const rows = document.createElement('div');
            rows.className = 'module-panel-metrics';
            rows.append(...metricRows(m));
            nodes.push(rows);

            const detail = document.createElement('dl');
            detail.className = 'module-panel-detail';
            const add = (label, value) => {
                const dt = document.createElement('dt');
                dt.textContent = label;
                const dd = document.createElement('dd');
                dd.textContent = value;
                detail.append(dt, dd);
            };
            add('内存', `${fmtBytes(m.memoryUsed)} / ${fmtBytes(m.memoryTotal)}`);
            // 详情页保留负载：这里有 CPU 与核数做参照，能读懂的人仍然看得到。
            // 首页那一行换成了存储占用，但不代表这个指标被废弃。
            if (m.diskTotal > 0) {
                add('存储占用', `${fmtBytes(m.diskUsed)} / ${fmtBytes(m.diskTotal)}`);
            }
            add('CPU 核心', `${m.cores}`);
            add('负载（1 / 5 分钟）', `${(m.load1 || 0).toFixed(2)} / ${(m.load5 || 0).toFixed(2)}`);
            add('运行时长', fmtDuration(m.uptime));
            if (m.hostname) add('主机名', m.hostname);
            if (Number.isFinite(entry.latencyMs)) add('响应时间', `${entry.latencyMs}ms`);
            // 推送模式：数据来源是"上次上报"，没有响应时间可言
            if (Number.isFinite(entry.pushReceivedAt)) {
                add('数据来源', '目标机推送');
                add('最后更新', lastUpdatedText(entry.pushReceivedAt) || '—');
            } else {
                add('数据来源', lastPayload && lastPayload.cached ? '缓存' : '实时采集');
            }
            nodes.push(detail);
        }

        // 全部服务器概览：多于一台时才显示
        if (all.length > 1) {
            const list = document.createElement('div');
            list.className = 'module-panel-list';
            const h = document.createElement('div');
            h.className = 'module-panel-list-title';
            h.textContent = `全部服务器（${all.length}）`;
            list.appendChild(h);
            for (const s of all) {
                const row = document.createElement('div');
                row.className = 'module-panel-list-row';
                row.dataset.online = s.online ? '1' : '0';
                const name = document.createElement('span');
                name.className = 'module-panel-list-name';
                // 名称后面带上地址：概览里最常见的问题是「这一行是哪台机器」，
                // 而两台机器可能都叫「服务器」。
                name.textContent = s.name || s.id;
                if (s.url && !s.isLocal) {
                    const host = document.createElement('span');
                    host.className = 'module-panel-list-host';
                    host.textContent = displayHost(s.url);
                    name.append(' · ', host);
                }
                const value = document.createElement('span');
                value.className = 'module-panel-list-value';
                value.textContent = s.online && s.metrics
                    ? `CPU ${fmtPercent(s.metrics.cpu)} · 内存 ${fmtPercent(s.metrics.memoryPercent)}`
                    : (s.error || '离线');
                row.append(name, value);
                list.appendChild(row);
            }
            nodes.push(list);
        }

        body.replaceChildren(...nodes);
    }

    window.app.registerModule({
        id: 'server-monitor',
        title: '服务器监控',
        // 说明文字由后台列表渲染在名称下方，必须写清「读的是哪台机器」：
        // 本机直接读 os，远端读目标机上部署的 agent。
        summary: '本机直接读取；其他机器需在目标机上部署 agent',
        mountWidget,
        openPanel
    });
})();
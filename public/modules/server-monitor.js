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
    /** 已挂载的卡片：serverId → { card, body, label, status, bodyKey } */
    const cards = new Map();
    /**
     * 平台注入的纵向重排请求（mountWidget 的 state.requestStack）。
     * 与 state.api 同一套注入方式——模块不去摸 window.app 上的平台方法。
     */
    let requestStack = null;

    function fmtPercent(value) {
        return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
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

    /** 字节数 → 人类可读（GB/TB/PB）。取不到时返回 '—'。
     *
     *  ⚠️ 这里曾经有**两份** fmtBytes：本函数是新增的，而文件上方
     *  另有一份旧的（只到 TB，且多一条「≥100 就取整」的分支）。JS 的函数
     *  声明提升让**后一份覆盖前一份**，于是旧的那份成了死代码——而它看起来
     *  完全正常，测试也全绿（没有任何一条断言过具体输出）。
     *  症状是同一个值在详情页与卡片上可能显示成两种精度。
     *  现在只有这一份。
     */
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
     * 「最后更新 N 分钟前」。两种采集方式共用一句话——它回答的是同一个问题
     *（这份数据有多新），只是时间来源不同（见 dataTimeOf）。
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

    /**
     * 这份数据的时间。两种采集方式各有一个真相来源：
     *   · 推送：那台机器**上报**的时刻（`pushReceivedAt`，落库时记的是**本服务**时钟）
     *   · 拉取：本服务**取到它**的时刻（聚合结果的 `updatedAt`，同样是本服务时钟）
     * 两端都用本服务的时钟，「N 分钟前」因此是在同一个时钟里做差。
     *
     * ⚠️ 不要改用 payload 里的 `metrics.sampledAt`：那是**目标机的时钟**
     *（本机由 `lib/monitor.js` 写、远端由 `agent/main.go` 写，各用各的 `now`），
     * 与浏览器里的 `Date.now()` 跨机做差会被时钟偏差吃掉——与本仓库记过的
     * 「两处时间来自不同来源」是同一类缺陷。它也救不了本机那一档（见 hintTextOf）。
     *
     * 拿不到（本机、或首轮 payload 还没来）返回 null。
     */
    function dataTimeOf(entry, collectedAt) {
        if (entry && Number.isFinite(entry.pushReceivedAt)) return entry.pushReceivedAt;
        return Number.isFinite(collectedAt) ? collectedAt : null;
    }

    /**
     * 卡片右下角那一行的文案。**渲染与指纹共用这一个函数**——两处各判一次
     * 必然漂移，本机那一档就是例子：渲染不显示它、指纹却把它算进去，于是
     * 缓存命中的轮次会凭空空重建一次卡片并请求一次重排。
     *
     * 本机不发这一行：它就是你在用的那台机器，数据读出来就是你看到它的时刻，
     * 「有多新」没有信息量。**这是产品取舍，不是布局限制**——卡片高度本来就
     * 按实测排（`stackWidgetsByHeight`），多一行也排得下，只是白占一行。
     * 若日后要一视同仁地显示，改这一处即可，指纹会跟着走。
     */
    function hintTextOf(entry, collectedAt) {
        if (!entry || entry.isLocal) return '';
        const t = dataTimeOf(entry, collectedAt);
        return t === null ? '' : (lastUpdatedText(t) || '');
    }

    function renderCardBody(body, entry, collectedAt) {
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
            // ⚠️ 拉取模式早先显示的是单次请求耗时（`${latencyMs}ms`），而那个数
            // **含 agent 那边固定 200ms 的 CPU 采样等待**（`agent/main.go` 的
            // `cpuSampleGap`：累计值必须两次采样做差；实测 collect 稳态 244–264ms、
            // 而只启动不采集的 version 是 21ms），所以它读起来像网络延迟、
            // 实际是采样地板——用户原话「这个数值展示没有意义」。
            // 现在右下角只回答一个问题：这份数据有多新（见 hintTextOf）。
            const hintText = hintTextOf(entry, collectedAt);
            if (hintText) {
                const hint = document.createElement('div');
                hint.className = 'module-card-hint';
                hint.textContent = hintText;
                nodes.push(hint);
            }
            body.replaceChildren(...nodes);
            return;
        }
        body.replaceChildren(errorBox('未获取到数据'));
    }

    /**
     * 卡片体的内容指纹。
     *
     * 轮询每 15 秒一次，而绝大多数轮询里数字根本没变；整块 replaceChildren
     * 一次会带来一次强制重排。指纹相同就整个跳过重建。
     * 「最后更新」那一项取**渲染出来的文案**（与渲染共用 hintTextOf，
     * 本机那一档因此不会在内容没变时翻转指纹），而不是自造一个分钟档：
     * 自造档位的取整方式与渲染用的不一致时，显示值会比指纹早/晚一个档变化，
     * 卡上那行就停在旧值上（实测差 30 秒）。
     */
    function bodyKeyOf(entry, collectedAt) {
        if (!entry || (!entry.online && !entry.metrics)) {
            return `err|${(entry && entry.error) || ''}|${entry && entry.authFailed ? 1 : 0}`;
        }
        const m = entry.metrics || {};
        return [
            m.cpu, m.memoryPercent, m.memoryUsed, m.memoryTotal, m.diskUsed, m.diskTotal,
            hintTextOf(entry, collectedAt)
        ].join('|');
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
            // 解析要容错：反代自己返回 429 时响应体常常是 HTML，`res.json()` 会抛，
            // 那样状态码就带不出来，429 又会退回「监控数据读取失败」这一句。
            let payload = null;
            try { payload = await res.json(); } catch { /* 非 JSON 响应体 */ }
            if (!res.ok) {
                // 带上状态码：429 是「你刷太快」，不是「数据读不到」——两者的
                // 下一步完全不同（等一分钟 vs 去查服务）
                const err = new Error((payload && payload.error) || `HTTP ${res.status}`);
                err.status = res.status;
                throw err;
            }
            if (!payload) throw new Error('返回格式不可识别');
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

            let rendered = false;
            for (const entry of payload.servers || []) {
                const card = cards.get(entry.id);
                if (!card) continue;
                const name = entry.name || entry.id;
                if (card.label.textContent !== name) card.label.textContent = name;
                const online = entry.online ? '1' : '0';
                if (card.card.dataset.online !== online) card.card.dataset.online = online;
                // 状态位每次刷新都要跟着更新：它是从「有没有指标 / 有没有注册」
                // 推出来的，机器从「未部署」变成「已就绪」时全靠这一步体现。
                // 只在挂载时设一次是不够的——那正是上一版的问题：
                // 部署完成后首页仍然显示旧状态，用户以为没生效。
                const kind = statusKindOf(entry);
                if (card.status.dataset.kind !== kind) {
                    card.status.dataset.kind = kind;
                    card.status.textContent = statusLabelOf(entry);
                }
                // 内容没变就不重建卡片体（见 bodyKeyOf）。重建过才需要重排。
                // collectedAt 是这一轮聚合结果的采集时刻——拉取模式的时间来源。
                const key = bodyKeyOf(entry, payload.updatedAt);
                if (card.bodyKey !== key) {
                    card.bodyKey = key;
                    renderCardBody(card.body, entry, payload.updatedAt);
                    rendered = true;
                }
            }

            // 卡片高度随内容变（远端在线带「最后更新」那一行 174px、离线只有 98px），
            // 而宽屏的纵向偏移是按实测高度排的——内容真的变了才重排。
            if (rendered && requestStack) requestStack();

        } catch (e) {
            console.error('Server monitor poll failed:', e);
            // 429 不能显示成「读取失败」：那会让人去查服务端，而实际只要等一分钟。
            // 指纹带上这句话，否则先 429 后真失败时，卡上那句会停在旧文案上。
            const msg = e && e.status === 429 ? '请求过于频繁，稍后自动重试' : '监控数据读取失败';
            for (const card of cards.values()) {
                card.body.replaceChildren(errorBox(msg));
                card.bodyKey = `!error|${msg}`;
            }
            if (requestStack) requestStack();
        } finally {
            inFlight = false;
        }
    }

    /** 轮询周期。首次用服务端给的 pollInterval 覆盖，之后由用户设置决定。 */
    let pollMs = POLL_MS;

    /**
     * 挂上轮询定时器与前后台切换监听。**不立即拉取**——首次拉取由
     * mountWidget 显式做一次，好把它的 promise 交给平台（state.whenReady），
     * 让模块区带着首轮数据首次布局、卡片出现时就是终态。
     */
    function schedulePolling() {
        if (pollTimer) clearInterval(pollTimer);
        if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
        pollTimer = setInterval(poll, pollMs);

        // 页面不可见时停表：后台 tab 继续轮询只会白耗请求配额
        visibilityHandler = () => {
            if (document.hidden) {
                clearInterval(pollTimer);
                pollTimer = null;
            } else if (!pollTimer) {
                poll();
                // ⚠️ 这里原来写死 POLL_MS，于是「切到后台再切回来」会把用户
                // 设的周期悄悄改回 15 秒，无任何提示（浏览器实测：设 30 秒时
                // 切一次前后台就掉回 15s）。必须是可变状态 pollMs。
                pollTimer = setInterval(poll, pollMs);
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

        // status 也要存进 Map：刷新时要更新它，而那时拿不到 DOM 引用。
        // bodyKey 记下首轮渲染的指纹——poll 的回调据此跳过重复重建。
        // 挂载时还没有聚合结果：entry 是从配置合成的占位（既没有 metrics、也没有
        // 采集时刻）。第三个参数显式传 `null` 而不是省略——这条路径上是「确实没有」，
        // 不是「忘了传」。
        renderCardBody(body, entry, null);
        cards.set(entry.id, { card, body, label, status, bodyKey: bodyKeyOf(entry, null) });
        return card;
    }

    /**
     * 紧凑态：按配置里的服务器列表建卡片。
     * 本机永远存在、排在第一，不需要配置——装完就能看到一个有效卡片。
     */
    function mountWidget(shell, state) {
        requestStack = (state && state.requestStack) || null;
        const servers = (state.config && state.config.servers) || [];
        const entries = [{ id: 'local', name: '本机', online: true, isLocal: true }]
            .concat(servers.map(s => ({ id: s.id, name: s.name || s.url, online: false })));

        // 逐台可见性由 widgets[].enabled 控制，缺省为「显示」——本机与远端
        // 同一套规则，过滤器一视同仁。
        // ⚠️ 早先这里给本机塞了一个 `e.id === 'local' ||` 无条件放行，理由是
        // 「关掉的话用户会得到一个空模块区，却没有任何入口能把它开回来」。
        // 那条理由成立的前提（没有恢复入口）已经不存在了：后台「监控目标」
        // 的本机卡片就有「显示/隐藏」复选框（app.js renderLocalServerCard），
        // 而首页无视它，用户取消勾选后 toast 说「已从首页隐藏」、
        // 首页却照常挂着——一个后台与首页互相矛盾的开关。
        const hidden = new Set((state.config.widgets || [])
            .filter(w => w.enabled === false)
            .map(w => w.id));
        const visible = entries.filter(e => !hidden.has(`server-monitor:${e.id}`));

        // 换一批卡片前先清干净：stopPolling 会清 cards 与 lastPayload，
        // 首次挂载时它们本来就是空的，重挂载时则是上一次留下的。
        stopPolling();
        const nodes = visible.map(buildCard);

        // 首轮先拉一次、再挂表（schedulePolling 自己不拉取），卡片因此
        // 带着数据出生；把这次 promise 交给平台，模块区首次布局就会等它，
        // 数据落地时不会再把下面的卡片整体推下去。
        const firstRound = poll();
        schedulePolling();
        if (state && typeof state.whenReady === 'function') state.whenReady(firstRound);

        return nodes;
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
        // 服务端对远端一直在传 `url`（server.js 的 collect 里就有）；
        // 本机没有它（url 为 null，因为它不通过 agent 采集），而本机的
        // 地址就是**用户此刻访问本服务的位置**——浏览器自己知道，
        // 让服务端再猜一遍反而多一处可能不一致。
        const address = entry.isLocal ? location.origin : entry.url;
        if (address) {
            const addr = document.createElement('div');
            addr.className = 'module-panel-address';
            const host = document.createElement('span');
            host.className = 'module-panel-address-host';
            // 只显示主机与端口：https:// 前缀每一台都一样，占地方且不增信息
            host.textContent = displayHost(address);
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'btn btn-sm';
            copy.textContent = '复制';
            copy.title = `复制 ${address}`;
            copy.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(address);
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
            if (Number.isFinite(entry.pushReceivedAt)) {
                add('数据来源', '目标机推送');
            } else {
                add('数据来源', lastPayload && lastPayload.cached ? '缓存' : '实时采集');
            }
            // 与本机卡片同一档取舍：本机不发这一行（见 hintTextOf），
            // 文案也共用同一个函数，两处不会说不一样的话。
            const hintText = hintTextOf(entry, lastPayload && lastPayload.updatedAt);
            if (hintText) add('最后更新', hintText);
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
                // 本机也带：它的 url 是 null，但访问地址就是浏览器所在处。
                // 排除本机会让概览第一行缺地址，而那行恰恰是最常被问的。
                const rowAddress = s.isLocal ? location.origin : s.url;
                if (rowAddress) {
                    const host = document.createElement('span');
                    host.className = 'module-panel-list-host';
                    host.textContent = displayHost(rowAddress);
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

    // ==================== 后台「监控目标」区块 ====================
    //
    // 这一段以前住在 app.js 里——平台代码特判「加一台机器」，与本模块的其余
    // 部分（卡片长什么样、部署命令怎么拼）分离，后台里就会出现「开关在这一头、
    // 配置在那一头」的混乱。搬进来之后：卡片、对话框、部署命令、探测定时器
    // 全在本文件，平台只给一个容器和一个服务包。
    //
    // ⚠️ 本文件不得引用 app.js 的标识符（平台的硬约束）：所有平台能力都从
    // `renderAdminSection(host, services)` 注入的 services 里取。

    /** 平台注入的服务包；后台区块里的交互（点按钮、开对话框）会一直用它 */
    let services = null;
    /** 后台区块的容器：用来判断「面板还开着吗」 */
    let adminHost = null;
    /** /probe 结果的缓存。渲染「在线」位要读它——渲染不该有网络副作用 */
    let lastProbe = {};
    let pendingProbeTimer = null;

    function esc(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function html(str) {
        const t = document.createElement('template');
        t.innerHTML = str.trim();
        return t.content.firstChild;
    }

    /** 命令面板的 intro 是唯一放行 HTML 的地方，白名单只给 <strong>。 */
    function richIntro(text) {
        return esc(text).replace(/&lt;strong&gt;/g, '<strong>').replace(/&lt;\/strong&gt;/g, '</strong>');
    }

    function adminApi() {
        return services && services.api;
    }

    /** 取**当下**的模块配置：不缓存引用，避免写入之后读到旧对象。 */
    function currentConfig() {
        return (services && services.config) || {};
    }

    function showToastSafe(message, state) {
        if (services && services.toast) services.toast(message, state);
    }

    /**
     * 一台机器当前处于哪个部署状态。
     *
     * 上一版只有「在线 / 离线」两个结果，而用户真正要回答的是三个不同的
     * 问题：**这台机器在吗、agent 装了吗、能不能读到指标**。三者塌缩成
     * 一个「离线」时，用户无法判断该点部署、该查网络、还是该重装。
     *
     * pull 模式下这三问由 TCP 三态探测分别回答；push 模式没有端口可探测，
     * 只能靠「注册过没有」判断部署状态。
     */
    function serverDeployState(s) {
        // 已注册但证书变了 —— 安全事件，优先于一切其它状态：
        // 这台机器此刻报上来的东西不该被当成可信数据。
        if (s.certMismatch) return 'cert_mismatch';
        if (s.deployState) return s.deployState;
        // 还没探测过：给一个诚实的初值，而不是谎称「离线」
        if (!s.enrolled) return 'unchecked';
        return 'ready';
    }

    /**
     * 状态位下方那块说明区。已就绪时不渲染任何东西——
     * 那台机器正常，没有需要解释的事。
     */
    function renderServerStateBody(s) {
        const state = serverDeployState(s);
        // 「已就绪」时那块不渲染 —— 正常机器没有需要解释的事。
        // 但**已就绪的机器可能跑着旧版 agent**，那是要解释的，
        // 所以这里多一个例外而不是无条件 return ''。
        const outdated = isAgentOutdated(s);
        if ((state === 'ready' || state === 'unchecked') && !outdated) return '';
        // 措辞统一取自 serverDeployBit —— 状态位与说明区说同一句话，
        // 两处各写一份文案必然漂移（然后用户看到卡片说「未部署」
        // 而展开说「等待部署」）。
        const bit = serverDeployBit(s);
        const text = s.error ? esc(s.error) : esc(bit.title);
        const version = outdated ? `
            <div class="server-item-version">
                agent ${esc(outdated.have)} · 本服务 ${esc(outdated.want)}
                <span title="升级不会改凭据与证书，只替换程序本身">可升级</span>
            </div>` : '';
        return `
            <div class="server-item-state" data-kind="${bit.kind}">
                <div class="lead">${esc(bit.text)}</div>
                <div class="sub">${text}</div>
                ${version}
            </div>`;
    }

    /**
     * 这台机器上的 agent 是不是旧版。
     *
     * ⚠️ 只有**真的比较过**才返回结论。拿不到目标机版本（没探测过、
     * 旧 agent 不报这个字段、版本是 dev）一律返回 null —— 那样界面
     * 什么都不显示。
     * 「拿不到就说有新版」比反过来糟得多：用户会被反复告知可以升级，
     * 而升完还是同一个版本。
     */
    function isAgentOutdated(s) {
        const have = s.agentVersion;
        // 本服务版本由平台注入（版本管理已经取过一次，不再另发请求）
        const want = (services && services.version && services.version()) || '';
        // dev 是从源码直接构建的产物，它与任何正式版都不可比
        if (!have || !want || have === 'dev' || want === 'dev') return null;
        // 逐段比数字：字符串比较会让 '1.10.0' < '1.9.0'
        const a = String(have).split('.').map(Number);
        const b = String(want).split('.').map(Number);
        if (a.length === 0 || a.some(n => !Number.isFinite(n))) return null;
        if (b.length === 0 || b.some(n => !Number.isFinite(n))) return null;
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const x = a[i] || 0, y = b[i] || 0;
            if (x !== y) return x < y ? { have, want } : null;
        }
        return null;
    }

    /** 地址只显示主机与端口，不必让用户每次都看见 https:// 前缀。 */
    function displayUrlOf(s) {
        try {
            const u = new URL(s.url);
            return u.port ? `${u.hostname}:${u.port}` : u.hostname;
        } catch {
            return s.url || '';
        }
    }

    /**
     * 后台卡片的两个状态位：**在线**与**部署就绪**。
     *
     * 刻意分成两个，因为它们回答的是两个正交的问题：
     *   · 在线吗       —— 主机的网络层能不能到达（TCP 三态探测）
     *   · agent 就绪吗 —— 那台机器上装了没、注册了没
     * 合成一句话（「在线 · 未部署」）在单台机器上看着够用，但用户扫过
     * 一列卡片时，「有哪几台连不上」和「有哪几台没装」是两类不同的
     * 待办 —— 分开才看得出该先做哪一类。
     *
     * 首页卡片只保留合并后的那一个（用户拍板：首页一个就够，
     * 后台至少两个）。差别在这里：后台是操作台，要能分派任务。
     *
     * @param {object} s 一台机器
     * @param {object} [probe] 最近一次探测结果（没有就退回配置里的持久状态）
     */
    function renderServerStatusBits(s, probe) {
        // probe 缺省时退回「上一次探测结果」的缓存。
        // ⚠️ 早先这里不传，于是「在线」位永远是「未检测」——而服务端
        // 早就把 reachable 算好并返回了（浏览器实测发现）。
        // 用 lastProbe 缓存而不是重新探测：渲染不该有网络副作用，
        // 而且每次渲染都探一次会把管理端限流桶打满。
        const p = probe || lastProbe[s.id];
        const online = serverOnlineState(s, p);
        const deploy = serverDeployBit(s, p);
        return `
            <span class="server-item-status" data-kind="${online.kind}"
                  title="${esc(online.title)}">${esc(online.text)}</span>
            <span class="server-item-status" data-kind="${deploy.kind}"
                  title="${esc(deploy.title)}">${esc(deploy.text)}</span>`;
    }

    /**
     * 「在线」这一位。推送模式报 null —— 它一个端口都不开，
     * 主机在不在线只能由「多久没收到上报」回答，不是探测能知道的。
     */
    function serverOnlineState(s, probe) {
        if (probe && 'reachable' in probe) {
            if (probe.reachable === null) {
                return { kind: 'unknown', text: '在线未知', title: '推送模式不开放端口，探测不到主机是否在线' };
            }
            return probe.reachable
                ? { kind: 'online', text: '在线', title: '能连到这台机器' }
                : { kind: 'offline', text: '离线', title: '连不上：探测超时或主机拒绝了' };
        }
        // 没探测过时不要瞎猜。说「未检测」是诚实的初值，不是「离线」。
        return { kind: 'unknown', text: '未检测', title: '还没探测过，点「检测」试一次' };
    }

    /** 「部署就绪」这一位。 */
    function serverDeployBit(s, probe) {
        const state = (probe && probe.deployState) || serverDeployState(s);
        switch (state) {
            case 'ready':
                return { kind: 'ready', text: '已就绪', title: 'agent 已注册，正在上报指标' };
            case 'pending':
                return { kind: 'pending', text: '等待部署', title: '目标机上有 agent，但还没向本服务注册' };
            case 'not_deployed':
                return { kind: 'not_deployed', text: '未部署', title: '目标机上还没有 agent' };
            case 'cert_mismatch':
                return { kind: 'alert', text: '证书异常', title: '证书与注册时不一致，可能被换了' };
            case 'port_conflict':
                return { kind: 'alert', text: '端口被占', title: '该端口上有别的服务，不是 agent' };
            default:
                return { kind: 'unknown', text: '未检测', title: '点「检测」确认部署状态' };
        }
    }

    /**
     * 部署操作按钮。这是 `hasEnrollToken` 唯一的消费者。
     *
     * 语义按用户拍板「有用就留着」接上：
     *   · 令牌已签发且未过期 → 直接给「复制命令」（用户可以直接粘）
     *   · 没有 / 已过期     → 给「部署」（点开面板会重新签一枚）
     * 所以这个字段不是冗余，它是「能不能直接复制」的判据。
     */
    function renderDeployAction(s) {
        if (s.hasEnrollToken) {
            return `<button class="btn btn-sm deploy-server"
                title="令牌还有效，直接复制部署命令">复制命令</button>`;
        }
        return `<button class="btn btn-sm deploy-server"
            title="生成一条部署命令，在目标机上执行">部署</button>`;
    }

    /**
     * 本机那张卡片。永远排第一，不需要任何配置，也**不可删**——
     * 它是这个模块唯一的零配置产物。但它**可以**从首页隐藏：
     * 这张卡上的「显示/隐藏」复选框自己就是恢复入口——
     * 模块侧的过滤器已与代码对齐（本文件 mountWidget 与远端同一 hidden 表）。
     * 所以它没有「部署」「编辑」「删除」，只有「是否在首页显示」。
     *
     * 三个状态位对本机恒为固定值：agent 天然在（不需要装）、
     * 在线（它就是本服务本身）、同步方式是直读。
     */
    function renderLocalServerCard(config) {
        const key = 'server-monitor:local';
        const item = (config.widgets || []).find(w => w.id === key);
        const shown = item ? item.enabled !== false : true;
        return `
        <div class="server-item" data-server-id="local" data-local="1">
            <div class="server-item-head">
                <span class="server-item-name">本机（${esc(location.hostname || '运行此服务的机器')}）</span>
            </div>
            <div class="server-item-badges">
                <span class="server-item-status" data-kind="ready"
                      title="本服务直接读自己，不需要装任何东西">已安装</span>
                <span class="server-item-status" data-kind="online"
                      title="它就是本服务本身，永远在线">在线</span>
                <span class="server-item-mode" data-mode="local"
                      title="直接读本机系统计数器，不走网络">直读</span>
            </div>
            <div class="server-item-actions">
                <label class="server-item-show" title="${shown ? '首页显示' : '已隐藏'}">
                    <input type="checkbox" data-server-visible="${esc(key)}" ${shown ? 'checked' : ''}
                           aria-label="在首页显示本机">
                    <span>${shown ? '显示' : '隐藏'}</span>
                </label>
            </div>
        </div>`;
    }

    /**
     * 服务器列表。本机一张 + 每台远端一张。
     * 每张卡上有两个状态位（是否装了 agent / 是否在线）、一个同步方式、
     * 一个「是否在首页显示」的复选框，以及该台机器的操作按钮。
     * 凭据不回显——已注册的回一个布尔，编辑时留空表示保持原值
     * （与 WebDAV 的「留空保持原密码」同一形状）。
     */
    function renderServerList(host, config) {
        if (!host) return;
        const servers = config.servers || [];
        // 本机永远有卡片——它是这个模块唯一的零配置产物，也是用户
        // 确认「这套东西活着」的第一眼。
        host.innerHTML = renderLocalServerCard(config)
            + servers.map(raw => {
            const key = `server-monitor:${raw.id}`;
            const item = (config.widgets || []).find(w => w.id === key);
            const shown = item ? item.enabled !== false : true;
            // ⚠️ 合并探测结果：agentVersion 只存在于 /probe 的响应里
            // （配置里没有这个字段），所以「目标机上跑的是不是旧版」
            // 这个判断必须读缓存，否则永远拿不到那个值。
            // 用 {...raw, ...probe} 而不是直接改 raw —— 那是配置对象，
            // 改它会让「这次探测的结果」变成「永久状态」。
            const probe = lastProbe[raw.id];
            const s = probe ? { ...raw, ...probe } : raw;
            const isPush = s.mode === 'push';
            // 一台一张卡、卡内竖排：横向由 grid 排多台，纵向因此有空间做
            // 达标的触控目标。此前是一行一台、按钮挤在右侧一行里（实测 26px，
            // 低于 44px 触摸下限），而那个密度是为三个按钮写的——
            // 现在有四个，紧凑单行更挤不下了。
            return `
            <div class="server-item" data-server-id="${esc(s.id)}">
                <div class="server-item-head">
                    <span class="server-item-name">${esc(s.name || s.url)}</span>
                    <span class="server-item-url">${esc(displayUrlOf(s))}</span>
                </div>
                <div class="server-item-badges">
                    ${renderServerStatusBits(s)}
                    <span class="server-item-mode" data-mode="${isPush ? 'push' : 'pull'}"
                          title="${isPush
                            ? '推送：目标机主动送上来，不开放端口'
                            : '拉取：本服务去连这台机器'}">${isPush ? '推送' : '拉取'}</span>
                </div>
                ${renderServerStateBody(s)}
                <div class="server-item-actions">
                    <label class="server-item-show" title="${shown ? '首页显示' : '已隐藏'}">
                        <input type="checkbox" data-server-visible="${esc(key)}" ${shown ? 'checked' : ''}
                               aria-label="在首页显示 ${esc(s.name || s.url)}">
                        <span>${shown ? '显示' : '隐藏'}</span>
                    </label>
                    ${isPush ? '' : `<button class="btn btn-sm probe-server"
                        title="真去连一次：主机在不在线、agent 装没装">检测</button>`}
                    ${renderDeployAction(s)}
                    <button class="btn btn-sm edit-server">编辑</button>
                    <button class="btn btn-sm btn-danger del-server">删除</button>
                </div>
            </div>`;
        }).join('');

        for (const row of host.querySelectorAll('.server-item')) {
            const id = row.dataset.serverId;
            // 本机卡片没有 deploy/probe/edit/delete 按钮，
            // 所以下面每个 querySelector 都可能返回 null。
            const server = servers.find(s => s.id === id);
            const showBox = row.querySelector('[data-server-visible]');
            if (showBox) {
                showBox.onchange = async () => {
                    const shown = showBox.checked;
                    row.querySelector('.server-item-show span').textContent = shown ? '显示' : '隐藏';
                    await saveServerVisibility(showBox.dataset.serverVisible, shown);
                };
            }
            const deployBtn = row.querySelector('.deploy-server');
            if (deployBtn) deployBtn.onclick = () => showDeployDialog(server);

            // 探测：真去连一次，回答三个问题——主机在吗、agent 装了吗、
            // 能读到指标吗。只对拉取模式的机器有意义：推送模式是目标机
            // 来找我们，「够不够得着」是反过来的问题。
            const probeBtn = row.querySelector('.probe-server');
            if (probeBtn) {
                probeBtn.onclick = async () => {
                    probeBtn.disabled = true;
                    const original = probeBtn.textContent;
                    probeBtn.textContent = '检测中…';
                    try {
                        const res = await adminApi().post(`/api/modules/servers/${encodeURIComponent(id)}/probe`);
                        // 记进缓存：渲染时的「在线」位要读它（服务端算好的
                        // reachable 不会凭空出现在配置里）
                        lastProbe[id] = res;
                        const name = server.name || server.url;
                        // 每种结果都给出下一步——服务端已经在 hint 里写好了，
                        // 这里只负责把它显示出来，并按情况提示下一步动作。
                        // 措辞取自 serverDeployBit，与卡片状态位、说明区同源。
                        const ok = res.deployState === 'ready';
                        const bit = serverDeployBit(res);
                        showToastSafe(`${name}：${bit.text}。${res.hint || ''}`,
                            ok ? 'success' : 'error');
                        // 「主机在线但没装 agent」是最值得主动引导的一种：
                        // 用户点检测多半就是想确认能不能用，而答案是「能连，
                        // 但要装个东西」——直接告诉他去哪装。
                        if (res.deployState === 'not_deployed') {
                            await services.notice('这台机器还缺 agent', res.hint || '');
                        }
                        // 刷新卡片，让状态位与说明区立刻反映这次探测的结果
                        await services.refreshAdmin();
                    } catch (e) {
                        console.error('Probe server failed:', e);
                        showToastSafe('检测失败，请重试', 'error');
                    } finally {
                        probeBtn.disabled = false;
                        probeBtn.textContent = original;
                    }
                };
            }

            const editBtn = row.querySelector('.edit-server');
            if (editBtn) editBtn.onclick = () => showServerDialog(server, () => services.refreshAdmin());
            const delBtn = row.querySelector('.del-server');
            if (delBtn) delBtn.onclick = async () => {
                if (!await services.confirm(`确定删除「${server.name || server.url}」？`, '删除服务器', true)) return;
                try {
                    // ⚠️ `API.request` 已经把 body 解析过了（它返回 { res, data }），
                    // 再 `res.res.json()` 会抛「body stream already read」，被 catch
                    // 吞成 `HTTP 500` —— 服务端那句具体的 error（例如「未找到该服务器」）
                    // 就丢了。直接用返回的 data。
                    const { res, data } = await adminApi().request(
                        `/api/modules/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
                    showToastSafe('已删除');
                    await services.refreshAdmin();
                } catch (e) {
                    console.error('Delete server failed:', e);
                    showToastSafe(e.message || '删除失败', 'error');
                }
            };
        }
    }

    /**
     * 保存单台服务器的首页可见性。
     *
     * 立即落盘而不是等「保存模块配置」：可见性是一个开关式的即时决定，
     * 让用户改完再去点另一个按钮，等于把两步合成一步却要两个动作。
     * 与整体保存同一套合并语义——只改这一条的 enabled，
     * order / side / 其他服务器一律原样带回（服务端 mergeModulesConfig 按 id 补回）。
     *
     * ⚠️ 每次都读**当下**的配置（services.config 是取值器）：写盘之后配置对象
     * 会被平台换成新的，闭包里的旧引用会让第二次点「隐藏」把上一次的改动丢掉。
     */
    async function saveServerVisibility(key, shown) {
        const config = currentConfig();
        const widgets = (config.widgets || []).map(w => ({ ...w }));
        const item = widgets.find(w => w.id === key);
        if (item) item.enabled = shown;
        else widgets.push({ id: key, enabled: shown, side: 'left', order: widgets.length, collapsed: false });

        try {
            await services.saveConfig({ widgets });
            showToastSafe(shown ? '已在首页显示' : '已从首页隐藏');
            await services.refreshHome();
        } catch (e) {
            console.error('Save server visibility failed:', e);
            showToastSafe('保存失败，请重试', 'error');
            // 失败要拨回去，否则界面显示的是一个没生效的状态
            await services.refreshAdmin();
        }
    }

    /**
     * 一键部署面板：签一枚一次性令牌，把「复制粘贴一行命令」给用户。
     *
     * 为什么放在这里而不是 sylph.sh：sylph.sh 管的是**主服务**的安装与升级，
     * 而 agent 部署在**别的机器**上，混进去会让两个角色互相干扰。
     *
     * 现在三处需要用户填的值（token、端口、证书指纹）全部归零：
     * 端口由后台按当前访问地址自动带上，证书由 agent 自己签发，
     * 令牌是一次性的、用完即废。
     */
    function showDeployDialog(server) {
        const name = server.name || server.url || '这台机器';
        // 一键部署：先换一枚一次性部署令牌，再把命令拼出来。
        // 令牌明文只在这一次响应里出现，服务端只存哈希——
        // 所以面板必须立刻让用户复制走。
        showToastSafe('正在生成部署命令…');
        adminApi().post(`/api/modules/servers/${encodeURIComponent(server.id)}/enroll-token`)
            .then(res => {
                const origin = location.origin;
                const mode = res.mode === 'push' ? 'push' : 'pull';
                // 自签服务端要在命令里带上 CA，否则 agent 的 TLS 握手会失败
                // （Go 在 macOS 上不读 SSL_CERT_FILE，Linux 上自签也不在
                // 系统根池里）。默认不勾：多数人用 certbot。
                const selfSigned = !!(services.selfSigned && services.selfSigned());
                const parts = [
                    `curl -fsSL ${origin}/agent/install.sh | sudo bash -s --`,
                    `  --server ${origin}`,
                    `  --enroll ${res.token}`
                ];
                if (mode === 'push') parts.push('  --mode push');
                // 自签时用户得自己给证书路径——我们不知道他装在哪，
                // 而猜一个路径比让用户改一行更糟。
                if (selfSigned) {
                    parts.push('  --server-ca /etc/ssl/certs/你的证书.crt');
                }
                const command = parts.join(' \\\n');
                const mins = Math.max(1, Math.round((res.expiresAt - Date.now()) / 60000));

                // 升级命令：与部署命令**并列**，而不是替代它。
                //
                // 两者不是一回事，走的路径不同：
                //   部署 → 重新注册，服务端**换掉 token**、证书也重签
                //   升级 → 只替换二进制，凭据与证书都不动
                // 所以日常升级用下面这条；上面那条留给「首次安装」
                // 与「这台机器的凭据要重新配」的情况。
                //
                // ⚠️ 别把升级做成部署的别名：那会让用户每升级一次就换一次
                // token，凭据白白轮换，而旧进程在重启前一直 401。
                // ⚠️ 路径写死 /usr/local/bin/nav-agent：它必须与 agent/install.sh 里的
                // BIN_PATH 一致。改成从服务端读的话，多一次请求只为一个
                // 不会变的常量——而两处不一致时用户会拿到一条跑不通的命令。
                const upgradeCommand =
                    `sudo /usr/local/bin/nav-agent upgrade --server ${origin}`
                    + (selfSigned ? ' \\\n  --server-ca /etc/ssl/certs/你的证书.crt' : '');

                showCommandPanel(`部署到「${name}」`, [
                    {
                        title: '1. 复制并执行',
                        note: '在目标机的终端执行（需要 sudo）。这一行会装好 agent、'
                            + '生成证书、注册到本服务并配置开机自启',
                        code: command
                    },
                    {
                        title: '2. 已经装过了？只升级用这条',
                        // ⚠️ 措辞里不要用 Markdown 强调：这个面板的 note 与
                        // plain 都经过 esc()，`**…**` 会原样显示星号
                        // （浏览器实测确认，同 richIntro 的那条约束）。
                        note: '下面这条只替换 agent 程序本身，不重新注册：'
                            + '凭据、证书都不动，token 不会变。'
                            + '本服务出新版本后在目标机执行它即可，'
                            + '结束时它会自动重启服务，无需再手动 systemctl restart。'
                            + '（上一条部署命令也能升级，但会顺便换掉 token，'
                            + '没必要。）',
                        code: upgradeCommand
                    },
                    {
                        title: '3. 回到这里刷新',
                        // ⚠️ 按模式分开说（plain 也是）：push 没有自动翻牌——
                        // 探测轮询显式排除推送机器，注册成功是唯一路径，
                        // 所以 note 不能对 push 许诺「自动变成已就绪」。
                        note: mode === 'push'
                            ? '目标机执行完后，关掉这个面板重开一次：'
                              + '注册成功它就会显示「已就绪」'
                            : '目标机执行完后，这张卡片会自动变成「已就绪」，也能读到指标了',
                        // 没有可复制的命令，所以不放代码块——
                        // 放一个装注释的代码块只会让用户以为要复制它，
                        // 而复制到终端里什么也不会发生。
                        //
                        // ⚠️ 这个面板是 fixed 覆盖层（z-index 1100），盖在管理弹窗
                        // （1000）之上，正对着服务器卡片那一块——用户在这里看不到
                        // 任何按钮。原文案「点上面的「检测」」因此是条**看不见的
                        // 入口**：面板开着时那个按钮在它下面。
                        //
                        // ⚠️ 而且 push 模式压根没有那个按钮（renderServerList
                        // 对 isPush 直接不渲染）。push 机器恰恰是最需要确认
                        // 部署结果的那种——它一个端口都不开，只靠注册与上报时间。
                        // 所以必须按模式分开说，不能给一句两处都不成立的话。
                        //
                        // ⚠️ 也不要再写「每 60 秒自动探测」：那个轮询
                        // （schedulePendingProbe）只覆盖 `!s.enrolled` 的机器，
                        // 已注册的那台永远不会被自动探测——照原文案读，用户
                        // 执行完部署却等不到卡片自己变。
                        // ⚠️ 引号里必须是**屏幕上的字**：
                        //   · push 失败首发是「尚未收到推送」（未上报），
                        //     断线态是「已 N 分钟未收到推送」——两个不同的原因，
                        //     文案要分开，不能压成一个；
                        //   · 「已就绪」是后台管理卡的状态位字样；
                        //   · 首页卡片在 push 正常态不显示错误，只在未上/断线时出错误框。
                        plain: mode === 'push'
                            ? '无需命令 —— 推送模式下目标机不开放端口，'
                              + '探测不到主机在不在线，部署结果看它有没有注册上来。'
                              + '关掉这个面板后：后台这张卡显示「已就绪」即装好了；'
                              + '首页那张卡显示「尚未收到推送」说明 agent 没起来，'
                              + '显示「已 N 分钟未收到推送」说明起来了又断线。'
                            : '无需命令 —— 未部署的机器本页面每 60 秒自动探测一次，'
                              + '状态变了会自动刷新。'
                              + '这台已注册的机器不会自动探测，'
                              + '关掉这个面板后点它卡片上的「检测」可以立刻试一次。'
                    }
                ], {
                    // ⚠️ 不要用 Markdown 强调：intro 经过 esc() 转义后是纯文本，
                    // `**目标机**` 会原样显示星号（浏览器实测确认）。
                    // 要强调就用 <strong>——它是这面板里唯一允许的 HTML。
                    intro: `在<strong>目标机</strong>上执行，不是在这台服务器上。\n`
                        + `这枚令牌 ${mins} 分钟内有效、只能用一次，执行完就作废——`
                        + `所以它只出现在这条命令里，不会被写进目标机的任何持久配置。`
                });
            })
            .catch(e => {
                console.error('Issue enroll token failed:', e);
                showToastSafe('生成部署命令失败，请重试', 'error');
            });
    }

    /**
     * 可复制的命令面板。
     *
     * 每一步有两种形态：
     *   { title, note, code }  —— 有命令，带「复制」按钮
     *   { title, note, plain } —— 只是说明，**不给复制按钮**
     *
     * 第二种是必要的：早先把「无需命令」也塞进一个装注释的代码块，
     * 于是用户看到两个一模一样的「复制」按钮，复制到终端里什么也不会发生
     * （浏览器实测发现）。
     *
     * ⚠️ title / note / code 一律走 esc()，它们是纯文本；
     * intro 例外，由 richIntro() 做白名单净化（只放行 <strong>）。
     */
    function showCommandPanel(title, steps, { intro = '' } = {}) {
        document.querySelectorAll('.command-panel-overlay').forEach(o => o.remove());
        const overlay = html(`
            <div class="command-panel-overlay">
                <div class="command-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
                    <div class="command-panel-head">
                        <h3>${esc(title)}</h3>
                        <button type="button" class="command-panel-close" aria-label="关闭">×</button>
                    </div>
                    <div class="command-panel-body">
                        ${intro ? `<p class="command-intro">${richIntro(intro)}</p>` : ''}
                        ${steps.map(s => `
                            <section class="command-step">
                                <h4>${esc(s.title)}</h4>
                                ${s.note ? `<p class="command-note">${esc(s.note)}</p>` : ''}
                                ${s.plain
                                    ? `<p class="command-plain">${esc(s.plain)}</p>`
                                    : `<div class="command-row">
                                        <pre class="command-code">${esc(s.code)}</pre>
                                        <button type="button" class="btn btn-sm command-copy">复制</button>
                                      </div>`}
                            </section>
                        `).join('')}
                    </div>
                </div>
            </div>
        `);
        document.body.appendChild(overlay);

        const close = () => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
        };
        const onKey = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        overlay.querySelector('.command-panel-close').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

        for (const btn of overlay.querySelectorAll('.command-copy')) {
            btn.addEventListener('click', async () => {
                const code = btn.closest('.command-row').querySelector('.command-code').textContent;
                try {
                    await navigator.clipboard.writeText(code);
                    btn.textContent = '已复制';
                } catch {
                    // 剪贴板不可用（http 页面、非用户手势）时退回选中
                    const range = document.createRange();
                    range.selectNodeContents(btn.closest('.command-row').querySelector('.command-code'));
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    btn.textContent = '已选中，按 ⌘C';
                }
                setTimeout(() => { btn.textContent = '复制'; }, 2400);
            });
        }
    }

    /**
     * 添加 / 编辑一台服务器。
     *
     * 字段从「名称 + 地址（带协议和端口）+ token + 采集方式」收敛成
     * 「名称 + 地址（只填 IP）+ 一个连通性问题」：上一版要用户自己拼协议、
     * 自己发明 token、自己在「拉取/推送」两个技术词之间选，而这三个值
     * 本服务全都知道。
     *
     * token 与证书都不再由用户填：它们由「部署」流程里的注册步骤带回。
     * 编辑时留空表示保持原值（与 WebDAV 的「留空保持原密码」同一形状）。
     *
     * 单独一个端点而不是走 /api/modules/config——token 必须由服务端加密，
     * 前端提交的明文不能经那条路径落盘。
     */
    async function showServerDialog(server, onDone) {
        const isEdit = !!server;
        // 用户答的是「本服务能否直接连到它」，而不是「局域网/公网」。
        // 后者描述的是机器的位置，前者才是决定能不能 pull 的那个事实；
        // 而「局域网/公网」组合起来有四格，用户要自己推导哪一格。
        const currentReachable = server ? server.reachable !== false : true;
        const result = await services.dialog({
            title: isEdit ? '编辑服务器' : '添加服务器',
            message: isEdit
                ? '改了地址或连通方向后，需要重新部署一次才能生效。'
                : '保存后会自动检测这台机器的状态。token 与证书会在你部署时自动配置，不用在这里填。',
            fields: [
                { label: '名称', type: 'text', value: server ? server.name : '', placeholder: '例如：家用 NAS' },
                {
                    label: '地址',
                    type: 'text',
                    value: server ? displayUrlOf(server) : '',
                    placeholder: '192.168.1.10'
                }
            ],
            options: [
                {
                    name: 'reachable', kind: 'radio', value: 'yes',
                    label: '能：同一局域网，或公网可达',
                    checked: currentReachable,
                    hint: '本服务会主动去连这台机器采集数据（拉取方式）'
                },
                {
                    name: 'reachable', kind: 'radio', value: 'no',
                    label: '不能：它在家里的内网，本服务在公网',
                    checked: !currentReachable,
                    hint: '目标机主动把数据送上来（推送方式），它不需要开放任何端口'
                }
            ],
            validate: (values) => {
                const raw = (values[1] || '').trim();
                if (!raw) return '请填写服务器地址';
                // 只填 IP 也接受：补上 https:// 与默认端口再校验。
                // ⚠️ 但 http:// 一律拒——token 是那台机器的只读监控凭据，
                // 明文传输等于把它公开。与服务端那条校验同一裁决，
                // 免得用户填完了才被拒。
                if (/^http:\/\//i.test(raw)) {
                    return '必须用 https：token 是那台机器的只读监控凭据，'
                        + '明文传输等于把它公开。目标机上的 agent 自己起 HTTPS。';
                }
                const normalized = /^https:\/\//i.test(raw) ? raw : `https://${raw}`;
                let parsed;
                try {
                    parsed = new URL(normalized);
                } catch {
                    return '地址格式不正确。填 IP 或域名即可，例如 192.168.1.10';
                }
                if (!parsed.hostname) return '地址缺少主机名';
                // 反过来要拦：用户填了 http://host 但漏了冒号，或写了别的协议
                if (!/^https:\/\//i.test(raw) && raw.includes('://')) {
                    return '只支持 https，agent 自己起的就是 HTTPS';
                }
                return null;
            }
        });
        if (!result) return;

        const name = (result.values[0] || '').trim();
        const rawAddr = (result.values[1] || '').trim();
        // 补全成完整 URL：默认 https、默认端口 4195。
        // 用户只填 IP 也能存——这是「只填 IP 就行」那个诉求的关键。
        let url;
        if (/^https:\/\//i.test(rawAddr)) {
            url = rawAddr;
            // 没写端口就补上默认的，否则后台会连 443 而 agent 听在 4195
            try {
                const u = new URL(url);
                if (!u.port) u.port = '4195';
                url = u.toString().replace(/\/$/, '');
            } catch { /* 交给服务端去拒 */ }
        } else {
            const withScheme = `https://${rawAddr}`;
            try {
                const u = new URL(withScheme);
                if (!u.port) u.port = '4195';
                url = u.toString().replace(/\/$/, '');
            } catch {
                url = withScheme;
            }
        }
        const reachable = result.choices.reachable !== 'no';
        const mode = reachable ? 'pull' : 'push';

        try {
            const saved = await adminApi().post('/api/modules/servers', {
                id: server ? server.id : undefined,
                name,
                url,
                mode,
                reachable
            });
            showToastSafe(isEdit ? '服务器已更新' : '服务器已添加，正在检测…');
            await onDone();

            // 保存后立刻探一次，用户不用再点「检测」才知道结果。
            // 编辑时**不**自动打开部署面板：那条命令会签发一枚新令牌，
            // 而「改个名字」这种无害操作不该产生一枚用户看不见的令牌。
            if (saved && saved.id) {
                const fresh = await findServerById(saved.id);
                if (fresh) {
                    const res = await adminApi().post(`/api/modules/servers/${encodeURIComponent(saved.id)}/probe`);
                    if (res.deployState === 'not_deployed') {
                        await services.notice('这台机器还缺 agent',
                            (res.hint || '') + '\n\n点这行右侧的「部署」，把命令复制到目标机上执行就行。');
                        // 新建且还没部署时直接给命令——用户的下一步几乎必然是它
                        if (!isEdit) {
                            showDeployDialog({ ...fresh, id: saved.id, name, url });
                        }
                    }
                    await onDone();
                }
            }
        } catch (e) {
            console.error('Save server failed:', e);
            showToastSafe('保存失败，请重试', 'error');
        }
    }

    /** 从服务端重新读一份模块配置，找一台机器。找不到返回 null 而不是抛错。 */
    async function findServerById(id) {
        const config = await services.reloadConfig();
        const list = (config && config.servers) || [];
        return list.find(s => s.id === id) || null;
    }

    /**
     * 每 60 秒探一次还没就绪的机器，直到它们都就绪或面板被关掉。
     *
     * 已就绪的机器不探：它们的状态由首页那个轮询周期管着（默认 15s），
     * 这里再探一遍只是浪费。而「未就绪」恰恰是变化最频繁的阶段——
     * 用户正在目标机上执行命令。
     */
    function schedulePendingProbe(config) {
        clearPendingProbe();
        // ⚠️ 用一个**可变**的 Map 记录「上次见到的状态」，而不是闭包里
        // 捕获 config.servers。早先直接比 s.deployState，而 s 是启动时的
        // 陈旧快照 —— 于是 `res.deployState !== s.deployState` 只要结果
        // 非空就恒真，每 60 秒必弹一次「有机器的状态变了」，哪怕什么都没变
        //（浏览器实测发现）。同样地，已注册的机器也永远进不了下一轮
        // 的 pending 列表，只能靠重开面板才被重新筛。
        const lastSeen = new Map();
        const pending = (config.servers || []).filter(s => {
            if (s.mode === 'push') return false; // 推送模式无端口可探
            lastSeen.set(s.id, s.deployState || null);
            return !s.enrolled;
        });
        if (!pending.length) return;

        const timer = setInterval(async () => {
            // 面板关了就不必再探：用户看不到结果，探了只是白花限流配额。
            // 判据是「这块 DOM 还在不在」，而不是去问平台当前停在哪个分区。
            if (!adminHost || !adminHost.isConnected) {
                clearPendingProbe();
                return;
            }
            let changed = false;
            for (const s of pending) {
                try {
                    const res = await adminApi().post(`/api/modules/servers/${encodeURIComponent(s.id)}/probe`);
                    // 同上：写缓存，让卡片重绘时「在线」位有数据可读
                    lastProbe[s.id] = res;
                    const now = res.deployState || null;
                    const before = lastSeen.get(s.id) ?? null;
                    if (now !== before) {
                        lastSeen.set(s.id, now);
                        changed = true;
                    }
                } catch (e) {
                    // 单台失败不影响其它机器，也不该弹 toast 打扰用户——
                    // 这是后台的静默轮询，不是用户发起的操作
                    console.debug('probe failed:', e);
                }
            }
            if (changed) {
                // 重绘会重新调 schedulePendingProbe，从而用**最新**的
                // 配置重建 pending 列表 —— 这也是「刚部署完的那台机器
                // 能从 pending 里毕业」的唯一路径。
                await services.refreshAdmin();
                showToastSafe('有机器的状态变了', 'success');
            }
        }, 60000);

        pendingProbeTimer = timer;
    }

    function clearPendingProbe() {
        if (pendingProbeTimer) {
            clearInterval(pendingProbeTimer);
            pendingProbeTimer = null;
        }
    }

    /**
     * 后台「监控目标」区块。平台只给容器与服务包；这里的内容、
     * 卡片结构、对话框与部署命令全是本模块自己的事。
     */
    function renderAdminSection(host, injected) {
        services = injected;
        adminHost = host;
        const config = currentConfig();
        host.innerHTML = `
            <p class="fav-hint">每个方块是一台机器。改动即时生效；
                单台机器的配置在它的「编辑」里保存。</p>
            <div id="serverList"></div>
            <button class="btn" id="addServerBtn">添加服务器</button>
        `;
        renderServerList(host.querySelector('#serverList'), config);
        host.querySelector('#addServerBtn').onclick = () => showServerDialog(null, () => services.refreshAdmin());
        schedulePendingProbe(config);
    }

    /** 面板关闭：平台在 closeAdmin 时调（平台不认识「探测」这件事）。 */
    function onAdminSectionClose() {
        clearPendingProbe();
    }

    window.app.registerModule({
        id: 'server-monitor',
        title: '服务器监控',
        // 说明文字由后台列表渲染在名称下方，必须写清「读的是哪台机器」：
        // 本机直接读 os，远端读目标机上部署的 agent。
        summary: '本机直接读取；其他机器需在目标机上部署 agent',
        mountWidget,
        openPanel,
        // 后台「监控目标」区块：开关与配置在同一个模块块里，平台不认这个模块
        adminSectionTitle: '监控目标',
        renderAdminSection,
        onAdminSectionClose
    });
})();

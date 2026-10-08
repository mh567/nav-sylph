((window) => {
    'use strict';

    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
    const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const html = (str) => { const t = document.createElement('template'); t.innerHTML = str.trim(); return t.content.firstChild; };
    const uid = () => 'id_' + Math.random().toString(36).slice(2, 9);

    // ========== 端到端加密工具 ==========
    const Crypto = {
        // 从分享码派生 AES 密钥（用户无感知）
        async deriveKey(code) {
            const enc = new TextEncoder();
            const keyMaterial = await crypto.subtle.importKey(
                'raw', enc.encode(code + '-nav-sylph-e2e'), 'PBKDF2', false, ['deriveKey']
            );
            return crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: enc.encode('nav-sylph-paste-v2'), iterations: 100000, hash: 'SHA-256' },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        },

        // 加密文本
        async encrypt(text, code) {
            const key = await this.deriveKey(code);
            const enc = new TextEncoder();
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                enc.encode(text)
            );
            // 合并 iv + 密文，转 base64
            const combined = new Uint8Array(iv.length + encrypted.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(encrypted), iv.length);
            return btoa(String.fromCharCode(...combined));
        },

        // 解密文本
        async decrypt(encryptedBase64, code) {
            try {
                const key = await this.deriveKey(code);
                const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
                const iv = combined.slice(0, 12);
                const data = combined.slice(12);
                const decrypted = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv },
                    key,
                    data
                );
                return new TextDecoder().decode(decrypted);
            } catch {
                throw new Error('解密失败');
            }
        }
    };

    // 管理端凭据由 HttpOnly Cookie 承载，JS 读不到也不需要读。
    // 服务端把「因环境变化被自动登出」用两种方式表达：401 响应体里的
    // code:'env_changed'，以及两处软门（200 响应）上的 X-Session-Env-Changed 头。
    // 软门必须返回 200——否则匿名用户每次刷新首页都会看到报错——
    // 但那样客户端就收不到原因，只能对着被截断的公开列表建索引。
    const API = {
        envChangeNotified: false,
        notifyEnvChanged(data, headers) {
            const fromBody = data && data.code === 'env_changed';
            const fromHeader = headers && headers.get('X-Session-Env-Changed') === 'env_changed';
            if (!fromBody && !fromHeader) return;
            if (API.envChangeNotified) return;
            API.envChangeNotified = true;
            if (window.app) {
                window.app.authenticated = false;
                // 模块区与布局按钮是登录态的产物，必须一起收起。
                // 少了这一行，环境变化后首页仍留着可点的模块入口。
                window.app.syncModuleVisibility();
                window.app.showToast('检测到登录环境变化，已自动退出，请重新登录', 'error', 8000);
            }
        },
        // binary=true 时不碰 body，把流留给调用方用 res.blob() 读。
        // 否则一律在此解析：body stream 只能读一次，调用方再 res.json()
        // 会抛 "body stream already read"。
        async request(url, options, binary = false) {
            const res = await fetch(url, { credentials: 'same-origin', ...options });
            if (binary) return { res, data: null };
            let data = null;
            try { data = await res.json(); } catch (e) {}
            // 200 的响应也可能带 env_changed（软门），所以不看状态码，只看两个信号源
            API.notifyEnvChanged(data, res.headers);
            return { res, data };
        },
        async get(url) {
            const { res, data } = await API.request(url);
            // 带上状态码：调用方要能区分「请求过于频繁（429）」与「真的读不到」。
            // 混成一句话会让用户完全找不到下一步——同一个限流桶曾同时表现为
            // 「模块加载不出来」与「监控数据读取失败」两种听起来无关的症状。
            if (!res.ok) {
                throw Object.assign(new Error(res.statusText || `HTTP ${res.status}`), { status: res.status });
            }
            return data;
        },
        async post(url, body) {
            const { data } = await API.request(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return data || {};
        }
    };

    // 外观三态，与后台「主题模式」下拉框同一套取值。
    // 未登录访客的选择存在本机；这个键名在 index.html 的内联脚本里也出现
    // （那里要抢在样式表之前把它应用上，避免首屏闪一下系统色），
    // 两处必须一致——tests 里有跨文件断言钉住。
    const THEME_STORAGE_KEY = 'nav-sylph-theme';
    const APPEARANCE_ORDER = ['auto', 'light', 'dark'];
    const APPEARANCE_TEXT = { auto: '自动（跟随系统）', light: '浅色模式', dark: '深色模式' };
    const APPEARANCE_ICONS = {
        auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.3"/><path d="M12 3.7a8.3 8.3 0 0 1 0 16.6Z" fill="currentColor" stroke="none"/></svg>',
        light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.1"/><path d="M12 2.7v2.1M12 19.2v2.1M2.7 12h2.1M19.2 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5"/></svg>',
        dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.4 14.7A8.6 8.6 0 0 1 9.3 3.6a8.6 8.6 0 1 0 11.1 11.1Z"/></svg>'
    };
    /** 三态循环的下一格（深色之后回绕到自动）。 */
    const nextTheme = current => APPEARANCE_ORDER[(APPEARANCE_ORDER.indexOf(current) + 1) % APPEARANCE_ORDER.length];

    class App {
        constructor() {
            this.config = null;
            this.authenticated = false;
            // 本会话的外观覆盖。正常情况下这份状态在 localStorage 里，
            // 只有它写不进去（隐私模式 / 禁用站点数据）时才落到这个字段，
            // 让那一次点击仍然生效，而不是看起来「按钮坏了」。
            this.themeOverride = null;
            // 当前会话是否被信任（可信=30 天，否则 24 小时）
            this.sessionTrusted = false;
            this.dragData = null;
            this.pasteMode = false;
            this.pasteUserResized = false;
            // 书签检索
            this.favorites = [];
            this.favoritesLoading = true;
            this.favoritesLoadError = false;
            this.configDirty = false;
            this.configSaving = false;
            this.configSnapshot = null;
            this.toastTimer = null;
            this.favSearchMode = false;
            this.privacySearchActive = false;
            this.adminFavorites = null;  // 带密码取回的全量书签，私密检索与管理面板使用
            this.adminFavoritesLoading = false;
            this.uf = null;  // uFuzzy 实例
            this.favHaystack = [];  // 搜索索引数组
            this.favSelectedIdx = 0;  // 当前选中的下拉项
            // 性能优化
            this.searchDebounceTimer = null;
            this.favManagerPage = 0;
            this.favManagerPageSize = 50;
            this.favManagerFiltered = null;  // 当前过滤结果
            // 版本管理
            this.currentVersion = null;
            this.changelog = null;
            this.hasNewVersion = false;
            this._scriptCache = new Map();  // 按需加载的 <script>，同一 src 只加载一次
            // 模块平台：登录后才可见。配置来自 /api/modules/config，
            // 不进 config.json —— 那里的新 key 会经 toPublicConfig 下发给匿名用户。
            this.modulesConfig = null;
            this.modulesLoaded = false;
            this.modulesLoading = false;
            this.modulesError = null;
            this.modulesEditorRendered = false;
            // 远程备份区块：配置缓存 + 「有没有渲染进当前这块 DOM」的闩锁。
            // 判据必须是后者。面板每次 openAdmin / 重渲染都会重建 #modalBody，
            // 于是 #webdavSection 是一个只写着「加载中...」的新节点，而
            // webdavConfig 还在内存里——拿「配置是否已加载」当条件，展开时
            // 条件为假、不发请求，占位符就永远留在页面上（用户报的「展开失败」）。
            // 与模块分区的 modulesEditorRendered 是同一条纪律。
            this.webdavConfig = null;
            this.webdavRendered = false;
            // 收藏管理器同理。此前它只在 selectAdminTab / renderAdminPanel 里赋值、
            // 靠 undefined 参与判断——而本文件自己的规矩是「显式初始化，不靠
            // undefined 的隐式比较」（见下面 _gridEditing 的注释），补上这一行。
            this.favManagerRendered = false;
            this.editLayout = false;
            // 编辑会话的草稿快照：进入编辑模式时对 config 与 widgets 各存一份，
            // 「保存编辑」才落盘，Esc/退出则整体丢弃。
            this.editSession = null;
            // 网格上一次渲染时是否处于编辑态。显式初始化而不是靠 undefined
            // 与 false 的隐式比较：syncEditLayoutUI 靠它判断「状态真的翻转了」，
            // 而 undefined !== false 成立纯属巧合。
            this._gridEditing = false;
            // 同一帧内多次纵向重排请求合并成一个（见 requestWidgetStack）。
            // 与 _gridEditing 同理显式初始化，不靠 undefined 的隐式比较。
            this._stackFrame = null;
            this.init();
        }

        // 按需加载一个 <script>。同一 src 只加载一次，后续调用复用同一 promise。
        // 用于把非首屏必需的库（拼音搜索、分享二维码）移出首屏关键路径。
        loadScript(src) {
            if (this._scriptCache.has(src)) return this._scriptCache.get(src);
            const promise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = src;
                s.onload = () => resolve();
                s.onerror = () => reject(new Error('加载失败: ' + src));
                document.head.appendChild(s);
            });
            this._scriptCache.set(src, promise);
            // 失败时清掉缓存，允许下次重试（网络抖动后可恢复）
            promise.catch(() => this._scriptCache.delete(src));
            return promise;
        }

        // ========== 模块平台 ==========
        // 每个模块一个 public/modules/<id>.js，登录且启用时才加载。
        // 首页首屏因此不因模块变重——未登录访客一个模块文件都不下载。

        /** 已知模块 id 白名单。loadModule 只加载这里有的，避免任意路径被当成脚本请求。 */
        static KNOWN_MODULES = ['server-monitor', 'memo', 'special-line'];

        /**
         * 等模块首轮数据的上限。
         * 超时后照常布局——某个模块卡住不该让整个模块区一直不出来；
         * 此时退化成改动之前的行为（数据落地时让位一次）。
         */
        static FIRST_ROUND_TIMEOUT_MS = 1500;

        /**
         * 模块区首次出现的淡入上浮时长。**必须与 styles.css 里
         * `moduleEnter` 的 animation-duration 一致**——摘标记的兜底定时器
         * 按它算，两处漂移会让兜底早于/晚于动画结束（有断言钉住）。
         */
        static MODULE_ENTER_MS = 260;

        static moduleDefs = new Map();

        registerModule(def) {
            if (!def || !def.id) throw new Error('模块必须带 id');
            App.moduleDefs.set(def.id, def);
        }

        getModule(id) {
            return App.moduleDefs.get(id);
        }

        /** 拉取模块平台配置。只在登录后调用。 */
        async loadModulesConfig() {
            if (this.modulesLoading) return this.modulesConfig;
            this.modulesLoading = true;
            this.modulesError = null;
            try {
                const data = await API.get('/api/modules/config');
                this.modulesConfig = {
                    enabledModules: Array.isArray(data?.enabledModules) ? data.enabledModules : [],
                    widgets: Array.isArray(data?.widgets) ? data.widgets : [],
                    servers: Array.isArray(data?.servers) ? data.servers : [],
                    // ⚠️ 早先这里只挑了三个字段，pollInterval 被丢在门外，
                    // 于是模块编辑器读到 undefined、回落到 15 秒：不管服务端
                    // 存的是什么，重开面板永远显示「每 15 秒」。值其实一直
                    // 落盘了、首页轮询也真按新周期在跑（那条路径走
                    // /api/modules/metrics 回的 pollInterval），唯独回显是假的。
                    pollInterval: Number(data?.pollInterval) || 15
                };
                this.modulesLoaded = true;
                return this.modulesConfig;
            } catch (e) {
                // 失败必须 render 出来，而不是留一个空白的模块区：
                // 无声失败过一次（WebDAV 分区永远停在「加载中...」）。
                console.error('Load modules config failed:', e);
                // 429 要说清楚：掩成「加载失败」用户只会一直刷新，而越刷越久
                this.modulesError = e && e.status === 429
                    ? '请求过于频繁，请等一分钟再刷新'
                    : '模块配置加载失败';
                return null;
            } finally {
                this.modulesLoading = false;
            }
        }

        /** 已启用的模块 id，按 widgets 里的 order 排序；未配置 layout 的按注册顺序。 */
        enabledModuleIds() {
            const enabled = new Set(this.modulesConfig?.enabledModules || []);
            const layout = this.modulesConfig?.widgets || [];
            const ids = App.KNOWN_MODULES.filter(id => enabled.has(id));
            const orderOf = id => {
                const item = layout.find(w => w.id === id);
                return item && Number.isFinite(item.order) ? item.order : 0;
            };
            return ids.sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b));
        }

        /**
         * 背板外侧是否放得下模块。
         *
         * 用固定断点表达不了这件事：936px 的背板在 1024 视口下左右只剩 44px，
         * 而 1440 下有 252px。断点只能二选一，另一头必然出错。
         * 所以按实际余量判断——放得下才用两侧，否则退回网格下方。
         */
        sideDockAvailable() {
            const MIN_SIDE = 132;   // 与 CSS 里的 clamp 下限一致
            const GAP = 20;
            const board = $('.backboard');
            const app = $('#app');
            if (!board || !app) return false;
            const boardWidth = board.getBoundingClientRect().width;
            const appWidth = app.getBoundingClientRect().width;
            const padding = 22 * 2;
            const side = (appWidth - padding - boardWidth) / 2;
            return side >= MIN_SIDE + GAP;
        }

        /** 已启用的模块里有没有声明 `wideRail` 的（要一条宽列而不是一张窄卡）。 */
        wantsWideRail() {
            return this.enabledModuleIds().some(id => {
                const def = this.getModule(id);
                return !!(def && def.wideRail === true);
            });
        }

        /**
         * 宽栏模式下三列各占多宽。**纯函数**（不碰 DOM），由 `syncRail()` 把结果写成
         * `#app` 上的三个 CSS 变量（`--rail-w` / `--side-w` / `--board-max`）。
         *
         * 为什么用 JS 算而不是写死在 CSS 里：三列的宽度是**相互挤**出来的，用嵌套的
         * `calc()` 表达会出现「阈值悬崖」——实测过一版，窗口缩 1px 该模块从 420 掉到
         * 132（反而更窄），再缩一点又跳到 190（反而更宽）。这里是连续的：随着 content
         * 变大，rail 400→440、side 180→220、board 600→936 单调变化，没有跳变。
         *
         * 分配顺序按「谁更需要」来：
         *   1. 时间线（声明了 wideRail 的那个）先拿上限 440——它是被让位的对象，
         *      太窄就没有存在意义（实测左列 132px 时监控卡的三行数值会挤乱）；
         *   2. 背板拿余量并封顶 936（首页导航不该无限宽）；
         *   3. 背板不足 600 时按「背板 → 时间线 → 左列」依次让步，都让到下限还不够
         *      就返回 null——调用方退回普通布局，模块自己按容器宽度降级成窄版。
         *
         * 左边的监控卡最低给 180：132px 那版实测排版错乱，180 起才正常。
         */
        railLayoutFor(content) {
            const GAP = 20;
            const SIDE_MIN = 180;
            const SIDE_MAX = 220;
            const BOARD_MIN = 600;
            const BOARD_MAX = 936;
            const RAIL_MIN = 400;
            const RAIL_MAX = 440;

            let side = SIDE_MAX;
            let rail = RAIL_MAX;
            let board = content - 2 * GAP - side - rail;

            if (board > BOARD_MAX) {
                board = BOARD_MAX;
                rail = Math.min(RAIL_MAX, content - 2 * GAP - side - board);
            }
            if (board < BOARD_MIN) {
                rail = Math.max(RAIL_MIN, content - 2 * GAP - side - BOARD_MIN);
                board = content - 2 * GAP - side - rail;
            }
            if (board < BOARD_MIN) {
                side = Math.max(SIDE_MIN, content - 2 * GAP - BOARD_MIN - rail);
                board = content - 2 * GAP - side - rail;
            }
            if (board < BOARD_MIN || rail < RAIL_MIN) return null;
            return { side, board, rail };
        }

        /**
         * 决定 `#app` 的 data-rail 与三个宽度变量，返回是否进了宽栏模式。
         *
         * ⚠️ 必须在 `sideDockAvailable()` **之前**调：后者读的是背板的实际宽度，
         * 而宽栏模式会把背板收窄——顺序反了就会按旧宽度判停靠。
         *
         * 未登录也算「不进宽栏」——让位是给登录后那条时间线的，登出后不该让背板
         * 继续窄着。这条判断放在这里而不是调用方，登出路径才只需要调一次本方法。
         */
        syncRail() {
            const app = $('#app');
            if (!app) return false;
            const content = app.getBoundingClientRect().width - 22 * 2;
            const layout = (this.authenticated && this.wantsWideRail())
                ? this.railLayoutFor(content) : null;
            app.dataset.rail = layout ? 'wide' : 'narrow';
            // 三个变量只在宽栏下有定义；不进宽栏就**清掉**，不要把上一档的宽度
            // 留在 #app 的行内样式上。CSS 只在 [data-rail="wide"] 下消费它们，
            // 所以留着不出症状——但那是一份读起来像「还在生效」的残留状态。
            const vars = { '--rail-w': layout && layout.rail, '--side-w': layout && layout.side, '--board-max': layout && layout.board };
            for (const key of Object.keys(vars)) {
                if (vars[key]) app.style.setProperty(key, vars[key] + 'px');
                else app.style.removeProperty(key);
            }
            return !!layout;
        }

        /**
         * 加载并渲染模块区。
         * 单个模块加载失败不影响其它模块——失败的那个渲染出错误与重试按钮。
         */
        async renderModuleZone() {
            const zone = $('#moduleZone');
            if (!zone) return;
            // 是否**由隐藏变可见**：只有这一次才播出现动画。主题切换、视口
            // 变化、模块开关等都会重渲染，那些不该再播一遍。
            const wasHidden = zone.hidden;

            if (!this.authenticated) {
                zone.hidden = true;
                zone.replaceChildren();
                // 未登录不该让背板继续收窄——让位是给登录后那条时间线的。
                // 走 syncRail（它自己判未登录 + 清宽度变量），别再手写一份 'narrow'。
                this.syncRail();
                return;
            }
            if (!this.modulesConfig) await this.loadModulesConfig();

            // 宽栏模块先让背板让位，再量余量（顺序不能反，见 syncRail 的注释）
            this.syncRail();

            // 停靠方式必须在**错误分支之前**定下来：`.module-zone` 的基础规则是
            // `position: absolute; pointer-events: none`，不设 data-dock 的话失败时
            // 错误条会横铺在页面顶部，而且里面的「重试」按钮点不动。
            //
            // ⚠️ 但错误态**一律走 below**：`[data-dock="outside"]` 没有自己的 CSS 块
            // （那个模式靠每张卡片各自绝对定位），错误条是个普通 div，会按基础规则
            // 铺成 y=48..102 的全宽条——实测压住搜索框 19px，而它是 pointer-events:auto，
            // 会挡住搜索框下沿的点击。below 是文档流里、分类网格下方的一条横幅。
            const sideDock = this.sideDockAvailable();
            zone.dataset.dock = (this.modulesError || !sideDock) ? 'below' : 'outside';

            // ⚠️ 加载失败要**先说话**：config 没拿到时 enabledModuleIds() 是空的，
            // 若先判空再返回，模块区会静默消失——用户看到的是「模块加载不出来」
            // 而屏幕上没有任何线索（首次加载时下面那段错误 UI 走不到）。
            // 本仓库同一条教训：失败的请求必须渲染失败，不能只是跳过成功分支。
            if (this.modulesError) {
                zone.hidden = false;
                zone.replaceChildren(this.renderModuleZoneError());
                return;
            }

            const ids = this.enabledModuleIds();
            if (!ids.length) {
                zone.hidden = true;
                zone.replaceChildren();
                return;
            }

            const inner = document.createElement('div');
            inner.className = 'module-zone-inner';

            // **并行**挂载，不串行 await：每个模块是一个独立脚本文件，
            // 串行下载等于把 N 个往返累加。实测（本地回环）`memo.js` 53→56ms
            // 结束之后 `server-monitor.js` 才在 58ms 起请求——第二个模块要等
            // 前一个的脚本下载**加**挂载都完成；真实网络下这一段是成倍的等待。
            const firstRound = [];
            const parts = await Promise.all(ids.map(id => this.mountModule(id, firstRound)));
            for (const part of parts) inner.appendChild(part);

            // 等首轮数据再首次布局。卡片高度依赖首轮数据：服务器卡片没有数据
            // 时 98px、拿到指标后 152px。不等的话卡片先以「无数据」的高度出生，
            // 数据落地时把下面的卡片整体推下去——实测 54px 位移 + 一次
            // margin-top 过渡（给 metrics 注入 600ms 延迟模拟远端网络）。
            // 等过之后卡片出现时就是终态。
            await this.waitFirstRound(firstRound);

            // 显隐也等到首轮之后：dock=below 时模块区自带一条上边框与内边距，
            // 先亮出来再等数据会凭空留一个空盒子。
            zone.hidden = false;

            // 首次布局**不做**让位动画。--stack-top 要等节点进入文档、量完高度
            // 才算得出来，所以卡片是带着 `margin-top: 0` 出生的，而
            // .module-widget 上挂着 margin-top 的过渡——浏览器会把这个「从 0
            // 到最终位置」的变化当成一次真实位移并做成动画。
            // 实测（1440×900，两侧停靠）改前：插入瞬间四张卡 top 全是 48px，
            // 完全重叠、文字互相压住；随后 180ms 滑到 48/214/342/470。
            //
            // 承重的是 `void zone.offsetHeight` 那一句，**不是**摘标记的时机。
            // stackWidgetsByHeight 先读高度、后写 --stack-top，于是最后一张卡
            // 写完之后没有任何读操作；不显式刷这一次，它那笔写入会等到摘掉
            // 标记之后才落进计算值，过渡就又回来了（对照页实测：去掉这一句
            // → 仍有 1 次 margin-top 过渡，且是最后一张卡，首帧落回 0）。
            // 标记早摘晚摘都行（改成 rAF 实测同样 0 过渡）——只要在刷完之后。
            zone.classList.add('is-laying-out');
            try {
                zone.replaceChildren(inner);
                this.applyWidgetLayout();
                void zone.offsetHeight;
            } finally {
                // 无条件摘掉：中间任一步抛异常，留着这个类会让模块区的让位
                // 动画**永久**失效——它是全局关掉 .module-widget 过渡的。
                zone.classList.remove('is-laying-out');
            }

            // 摆好位之后再播淡入上浮（同一帧内加类，首帧就是 opacity 0，
            // 不会先亮一下再暗下去）。
            if (wasHidden) this.playModuleEntrance(zone);
        }

        /**
         * 模块区首次出现时的淡入上浮。
         *
         * ⚠️ 动画结束后**必须**把类摘掉：CSS 用的是 `animation-fill-mode: both`，
         * 最后一帧（`transform: none`）会被一直保留，而拖拽正是靠 inline
         * `transform` 跟手——留着它，拖拽当场失效。
         * 摘除有两条路：`animationend`（正常）与定时器兜底（动画没跑时，
         * 例如标签页在后台、或系统开了「减少动态效果」）。
         */
        playModuleEntrance(zone) {
            const cls = 'is-entering';
            zone.classList.add(cls);
            let done = false;
            const onEnd = ev => {
                // 只认自己那条动画。子元素上将来若加一条**有限**动画，它的
                // animationend 会冒泡上来，按名字过滤才不会被别人的动画提前摘掉。
                // （备忘录那个 spinner 是 infinite，只发 animationiteration，
                // 不在此列——这里防的是以后的改动，不是现在这个。）
                if (ev.animationName !== 'moduleEnter') return;
                finish();
            };
            const finish = () => {
                if (done) return;
                done = true;
                zone.classList.remove(cls);
                zone.removeEventListener('animationend', onEnd);
            };
            zone.addEventListener('animationend', onEnd);
            setTimeout(finish, App.MODULE_ENTER_MS + 150);
        }

        /** 加载一个模块并返回它的 DOM 节点；加载失败返回错误卡片而非抛出。
         *  `firstRound` 是平台收集「首轮数据」promise 的数组，见 waitFirstRound。 */
        async mountModule(id, firstRound = []) {
            const shell = document.createElement('section');
            shell.className = 'module-widget';
            shell.dataset.moduleId = id;

            // 顺序要紧：必须先加载脚本，再取定义。
            // 首次进入时模块尚未注册，若先查 getModule 会拿到 undefined，
            // 于是一直渲染「模块未注册」——而脚本其实加载成功了，
            // 只是注册发生在 getModule 之后。已注册的定义要留着，
            // 这样重渲染时不必重复加载。
            if (!this.getModule(id)) {
                try {
                    await this.loadModule(id);
                } catch (e) {
                    console.error(`Load module ${id} failed:`, e);
                    shell.appendChild(this.renderWidgetError(id, '加载失败'));
                    return shell;
                }
            }

            const def = this.getModule(id);
            if (!def) {
                shell.appendChild(this.renderWidgetError(id, '模块未注册'));
                return shell;
            }

            try {
                const mounted = def.mountWidget(shell, {
                    config: this.modulesConfig,
                    editLayout: this.editLayout,
                    api: API,
                    // 轮询路径的纵向重排放到这里注入，而不是让每个模块各自去摸
                    // window.app 上的平台方法——两个模块此前各写了一份一模一样的
                    // 转发函数（含回退分支），注入后只有平台这一处是真相来源。
                    requestStack: () => this.requestWidgetStack(),
                    // 模块把「首轮数据」的 promise 交回来，平台据此决定模块区
                    // 首次布局的时机（见 waitFirstRound）。**不调用 = 不等待**，
                    // 所以不轮询的模块不会白等一个超时。
                    whenReady: promise => {
                        if (promise && typeof promise.then === 'function') firstRound.push(promise);
                    }
                });
                // mountWidget 有三种返回形态：
                //  - 返回节点数组：一台机器一张卡片（如服务器监控，每台一台）
                //  - 返回单个节点：替换 shell 内容
                //  - 返回 shell 本身：就地渲染
                if (Array.isArray(mounted)) {
                    const fragment = document.createDocumentFragment();
                    mounted.forEach(node => {
                        if (!node) return;
                        node.classList.add('module-widget');
                        node.dataset.moduleId = id;
                        // 布局键用节点自带的 instanceId，**不是数组下标**。
                        // 用下标的话，隐藏一张卡片会让后面所有卡的键整体前移，
                        // 谁排在第几、在左边还是右边——全部错乱，
                        // 而用户只是关了一台机器。
                        if (!node.dataset.instanceId) node.dataset.instanceId = id;
                        fragment.appendChild(node);
                    });
                    return fragment;
                }
                shell.dataset.instanceId = id;
                if (mounted && mounted !== shell) shell.replaceChildren(mounted);
            } catch (e) {
                console.error(`Mount module ${id} failed:`, e);
                shell.replaceChildren(this.renderWidgetError(id, '渲染失败'));
            }
            return shell;
        }

        /** 未注册的白名单外的 id 一律拒绝——不要把任意字符串拼进脚本路径。 */
        loadModule(id) {
            if (!App.KNOWN_MODULES.includes(id)) {
                return Promise.reject(new Error('未知模块: ' + id));
            }
            return this.loadScript(`modules/${id}.js`);
        }

        renderWidgetError(id, message) {
            const box = document.createElement('div');
            box.className = 'module-widget-error';
            const title = document.createElement('span');
            title.className = 'module-widget-error-title';
            title.textContent = this.getModule(id)?.title || id;
            const detail = document.createElement('span');
            detail.className = 'module-widget-error-detail';
            detail.textContent = message;
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'module-widget-retry';
            retry.textContent = '重试';
            retry.addEventListener('click', async () => {
                this._scriptCache.delete(`modules/${id}.js`);
                retry.disabled = true;
                await this.renderModuleZone();
            });
            box.append(title, detail, retry);
            return box;
        }

        renderModuleZoneError() {
            const box = document.createElement('div');
            box.className = 'module-zone-error';
            const text = document.createElement('span');
            text.textContent = this.modulesError;
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'module-widget-retry';
            retry.textContent = '重试';
            retry.addEventListener('click', () => this.renderModuleZone());
            box.append(text, retry);
            return box;
        }

        /**
         * 等模块的首轮数据，最多 FIRST_ROUND_TIMEOUT_MS。
         *
         * 为什么等：卡片高度由首轮数据决定（服务器卡片无数据 98px、有数据
         * 152px），不等就会出现「卡片先以无数据的高度出生、数据落地时把
         * 下面的卡片整体推下去」——实测 54px 加一次过渡。
         *
         * 兜底：某个模块的 promise 一直不 settle 时照常布局。宁可退化成
         * 旧行为（让位一次），也不能让模块区一直不出现。
         */
        async waitFirstRound(promises) {
            if (!promises.length) return;
            let timer = null;
            try {
                await Promise.race([
                    // 单模块失败不该拖垮等待：它的失败态同样是一个终态高度
                    Promise.all(promises.map(p => p.catch(() => {}))),
                    new Promise(resolve => { timer = setTimeout(resolve, App.FIRST_ROUND_TIMEOUT_MS); })
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        }

        /**
         * 写回 layout（顺序 / 换边）。排序是持久化状态，所以不做乐观更新：
         * 失败时用调用方的快照回滚，并把错误 render 出来。
         */
        async saveWidgetLayout(snapshot) {
            try {
                await API.post('/api/modules/config', {
                    enabledModules: this.modulesConfig.enabledModules,
                    widgets: this.modulesConfig.widgets,
                    servers: this.modulesConfig.servers
                });
                return true;
            } catch (e) {
                console.error('Save widget layout failed:', e);
                // 整体回滚到拖拽前，而不是只回滚一个字段——同一操作通常还推进了 updatedAt 之类
                if (snapshot) {
                    this.modulesConfig.widgets = snapshot.widgets.map(w => ({ ...w }));
                }
                this.showToast('布局保存失败，已还原', 'error');
                this.renderModuleZone();
                return false;
            }
        }

        /** 按 widgets[].side / order 摆放已渲染的 widget 节点。 */
        applyWidgetLayout() {
            const zone = $('#moduleZone');
            if (!zone || !this.modulesConfig) return;
            const inner = zone.querySelector('.module-zone-inner');
            if (!inner) return;

            // 布局的键是 instanceId 而不是 moduleId：一个模块可能渲染出
            // 多张卡片（服务器监控每台一张），共用 moduleId 会让它们的
            // order 与 side 互相覆盖——拖一张，另几张跟着变。
            const keyOf = node => node.dataset.instanceId || node.dataset.moduleId;

            // 查不到布局项时排到末尾而不是 0：全部回落 0 会让排序变成
            // 「按 id 字母序」，看起来像随机。新加的服务器因此会稳定地
            // 排在已布局的卡片之后。
            const orderOf = id => {
                const item = (this.modulesConfig.widgets || []).find(w => w.id === id);
                return item && Number.isFinite(item.order) ? item.order : Number.MAX_SAFE_INTEGER;
            };
            // 没有已保存布局项的模块，回落到它自己声明的 defaultSide。
            // special-line 声明 'right'：启用后默认停靠在首页右侧空白区。
            // 一旦用户拖过并保存，widgets[].side 就是唯一真相——默认值不再参与，
            // 所以它永远不会覆盖用户自己摆好的位置。
            const defaultSideOf = key => {
                const def = this.getModule(String(key).split(':')[0]);
                return def && def.defaultSide === 'right' ? 'right' : 'left';
            };
            const sideOf = id => {
                const item = (this.modulesConfig.widgets || []).find(w => w.id === id);
                if (item && item.side) return item.side === 'right' ? 'right' : 'left';
                return defaultSideOf(id);
            };

            const nodes = [...inner.querySelectorAll('.module-widget')];
            nodes.sort((a, b) => {
                const ka = keyOf(a), kb = keyOf(b);
                return orderOf(ka) - orderOf(kb) || ka.localeCompare(kb);
            });
            for (const node of nodes) {
                node.dataset.side = sideOf(keyOf(node));
                inner.appendChild(node);
            }
            this.syncEditLayoutUI();
            // 高度要在归位之后量：绝对定位元素的尺寸此时才是最终值
            this.stackWidgetsByHeight();
        }

        /**
         * 宽屏下按**实际高度**纵向堆叠，不按固定步进。
         *
         * 早先 CSS 里写死 `margin-top: calc(var(--i) * 166px)`，而卡片高度
         * 随内容变化：远端在线带「最后更新」那一行 174px、本机 152px、离线只有 98px。
         * 固定 166px 遇上 174px 的卡片就压掉 8px——实测重叠 8px，两处。
         *
         * 用 CSS 变量表达「每张卡自己的偏移」是做不到的，因为偏移依赖
         * 前面所有卡的高度和；所以在 JS 里量、在 JS 里排。
         */
        stackWidgetsByHeight() {
            const zone = $('#moduleZone');
            if (!zone || zone.dataset.dock !== 'outside') return;
            const GAP = 14;

            for (const side of ['left', 'right']) {
                const nodes = [...zone.querySelectorAll(`.module-widget[data-side="${side}"]`)];

                // **先读后写**：一次读完所有高度，再统一写 --stack-top。
                // 边读边写的写法让每一次写都作废上一次的布局缓存，于是每张
                // 卡都变成一次强制同步重排——轮询路径上每 15 秒白花一遍。
                for (const node of nodes) if (node.style.marginTop) node.style.marginTop = '';
                const tops = [];
                let cursor = 0;
                for (const node of nodes) {
                    const height = node.getBoundingClientRect().height;
                    tops.push(`${cursor}px`);
                    cursor += height + GAP;
                }
                for (let i = 0; i < nodes.length; i++) {
                    const node = nodes[i];
                    // 值没变就不写：写一个相同的值同样会让后续读取失去缓存，
                    // 而轮询路径上多数时候高度根本没变。
                    if (node.style.getPropertyValue('--stack-top') !== tops[i]) {
                        node.style.setProperty('--stack-top', tops[i]);
                    }
                }
            }
        }

        /**
         * 请求一次纵向重排，**同一帧内多次调用只做一次**。
         *
         * 轮询路径上每个模块渲染完都会请求一次，而两个模块的渲染常常落在
         * 同一帧；不合并的话每轮要量两三遍高度、写两三遍 --stack-top。
         *
         * 布局路径**不走这里**：renderModuleZone 要先摆位再强制重排、
         * compensateStackShift 要写完立刻读回，都要求同步执行。
         */
        requestWidgetStack() {
            if (this._stackFrame) return;
            this._stackFrame = requestAnimationFrame(() => {
                this._stackFrame = null;
                this.stackWidgetsByHeight();
            });
        }

        /**
         * 编辑模式开关。这是显式的，不是默认拖拽：widget 卡片本身可点击
         * （点开全屏面板），默认态开拖拽会劫持点击。
         *
         * 进入时对两套存储各存一份草稿快照，「保存编辑」才落盘；
         * 放弃则走 cancelEditSession（Esc / 自动登出），整体丢弃。
         *
         * **没有 force 参数**：退出与放弃的后果完全不同（一个提交、一个丢弃），
         * 不该由一个布尔量隐式决定。保留 force 会让后来者以为
         * `toggleEditLayout(false)` 能静默退出，而实际上它做不到。
         */
        async toggleEditLayout() {
            if (this.editLayout) return this.saveEditSession();
            if (!this.authenticated) return;
            this.editSession = {
                config: JSON.parse(JSON.stringify(this.config)),
                widgets: JSON.parse(JSON.stringify(this.modulesConfig?.widgets || []))
            };
            this.editLayout = true;
            this.syncEditLayoutUI();
        }

        syncEditLayoutUI() {
            const zone = $('#moduleZone');
            const grid = $('#grid');
            const btn = $('#layoutBtn');
            const editing = this.editLayout;
            if (btn) {
                btn.textContent = editing ? '保存编辑' : '编辑';
                btn.title = editing ? '保存全部改动并退出编辑' : '编辑首页导航';
                btn.setAttribute('aria-pressed', String(editing));
                btn.classList.toggle('is-active', editing);
            }
            if (zone) zone.classList.toggle('is-editing', editing);
            if (grid) grid.classList.toggle('is-editing', editing);
            // 网格的增删控件（＋卡片、分类删除把手）由模板分支生成，
            // 所以切态要重画网格。但只在**真的发生切换**时重画：
            // syncEditLayoutUI 还被 applyWidgetLayout 调，而后者会在
            // 视口变化、轮询重绘等时机触发——那时正在被拖拽的书签 DOM
            // 会凭空重建。
            if (grid && this._gridEditing !== editing) {
                this._gridEditing = editing;
                this.renderGrid();
            }
        }

        /** 提交草稿：模块布局与首页书签分两套存储，串行提交，前者失败即中止。 */
        async saveEditSession() {
            if (!this.editSession) { this.exitEditLayout(); return; }
            if (this.modulesConfig) {
                // 传**对象**而不是裸数组：saveWidgetLayout 的回滚分支读的是
                // snapshot.widgets。传数组会让 snapshot.widgets 为 undefined，
                // .map 直接抛——而那个异常从 catch 块内部抛出，会穿透
                // saveWidgetLayout 的 catch、穿透 saveEditSession 的 try，
                // 于是回滚、退出编辑态、提示 toast 一行都不执行，
                // 只留下一个改坏了的 widgets。
                const ok = await this.saveWidgetLayout({ widgets: this.editSession.widgets });
                // saveWidgetLayout 自己回滚了 widgets 并已提示，但**编辑会话还没结束**：
                // 书签那部分草稿仍在内存里，界面也仍停在编辑态。早先这里直接
                // return，用户点了「保存编辑」却什么都没发生，也没有下一步可走。
                // 所以失败路径与书签提交失败同构：还原整份草稿、退出、提示。
                // 两套存储不是原子的，串行 + 前者失败即中止，
                // 把最坏情况收敛成「只有布局变了」。
                if (!ok) {
                    this.rollbackEditSession();
                    this.exitEditLayout();
                    return;
                }
            }
            try {
                const res = await API.post('/api/config', this.config);
                if (!res.success) throw new Error(res.error || '保存失败');
            } catch (e) {
                this.rollbackEditSession();
                this.exitEditLayout();
                this.showToast('首页书签保存失败，已还原', 'error');
                return;
            }
            this.editSession = null;
            this.exitEditLayout();
            this.showToast('编辑已保存');
        }

        /** Esc 放弃编辑：有改动时先问一句，没改动则静默退出。 */
        async cancelEditSession() {
            if (!this.editSession) { this.exitEditLayout(); return; }
            const changed =
                JSON.stringify(this.config) !== JSON.stringify(this.editSession.config)
                || JSON.stringify(this.modulesConfig?.widgets || []) !== JSON.stringify(this.editSession.widgets);
            if (changed) {
                const ok = await this.confirmAction('放弃本次编辑的改动？未保存的内容会丢失。', '放弃编辑', true);
                if (!ok) return;
            }
            this.rollbackEditSession();
            this.editSession = null;
            this.exitEditLayout();
        }

        /** 整体替换回草稿快照——不能逐字段还原，
         *  一次拖拽往往同时推进 order、side 与 updatedAt。 */
        rollbackEditSession() {
            if (!this.editSession) return;
            this.config = this.editSession.config;
            if (this.modulesConfig) this.modulesConfig.widgets = this.editSession.widgets;
            this.renderGrid();
            this.renderModuleZone();
        }

        /** 退出编辑模式并清掉全部拖拽残留状态。
         *  登出与环境变化自动登出也走这里——否则反复进出编辑模式会留下
         *  .is-dragging 与悬停高亮，下次进入时看起来像卡住了。 */
        exitEditLayout() {
            this.editLayout = false;
            this.syncEditLayoutUI();
            // 两处都要清，且 class 名要对：模块区的落点高亮用的是 .drop-target，
            // 早先这里写的是 .drop-active —— 那个 class 在样式表里根本不存在，
            // 于是这行是空转，模块拖拽后按 Esc 放弃编辑会留下压暗的卡片。
            const zone = $('#moduleZone');
            if (zone) {
                zone.querySelectorAll('.is-dragging, .drop-target').forEach(n => {
                    n.classList.remove('is-dragging');
                    n.classList.remove('drop-target');
                });
            }
            const grid = $('#grid');
            if (grid) {
                grid.querySelectorAll('.is-dragging, .drop-target').forEach(n => {
                    n.classList.remove('is-dragging');
                    n.classList.remove('drop-target');
                });
            }
            this.dragData = null;
        }

        /** 登录态变化时统一走这里：显示或彻底收起模块区与布局按钮。 */
        async syncModuleVisibility() {
            const btn = $('#layoutBtn');
            if (!this.authenticated) {
                // 会话已失效，无可保存，也不该弹确认框：直接丢弃草稿。
                this.rollbackEditSession();
                this.exitEditLayout();
                const zone = $('#moduleZone');
                if (zone) { zone.hidden = true; zone.replaceChildren(); }
                if (btn) btn.hidden = true;
                this.modulesConfig = null;
                this.modulesLoaded = false;
                this.modulesError = null;
                return;
            }
            if (btn) btn.hidden = false;
            await this.renderModuleZone();
        }

        async init() {
            try {
                this.config = await (window.__navSylphConfigPromise || API.get('/api/config'));
                this.migrateConfig();
                // 用户配置一到就先把外观定下来，**不等**下面那趟 server-flags：
                // 服务端强制了主题（theme 不是 auto）时，全靠这一步把首屏的
                // 系统色纠正过来，多压一个往返就多闪一帧。
                this.applyTheme();
                // 自签标记住在**服务配置**里（server-config.json），
                // 而 this.config 是**用户公开配置**（config.json）——
                // 两个文件、两套字段，所以它必须单独取。
                // 早先从 `this.config?.security?.selfSignedCert` 读，
                // 而那个路径上永远是 undefined（浏览器实测发现，
                // 单元测试全绿：没有任何一条断言它真的被下发过）。
                try {
                    const flags = await API.get('/api/server-flags');
                    this.selfSignedCert = flags?.selfSignedCert === true;
                } catch (e) {
                    console.warn('读取服务配置标志失败，自签标记按「否」处理:', e);
                    this.selfSignedCert = false;
                }
                this.render();
                this.bind();
                $('#loader').remove();
                $('#app').hidden = false;
                // 首页先显示，书签索引、版本信息与会话状态随后加载。
                // 会话状态放在首屏之后查，不为它增加首屏的往返等待。
                requestAnimationFrame(() => {
                    this.restoreSession();
                    this.loadFavorites();
                    this.checkVersionUpdate();
                });
                const registerServiceWorker = () => {
                    if ('serviceWorker' in navigator) {
                        navigator.serviceWorker.register('/sw.js').catch(error => {
                            console.warn('Service worker registration failed:', error);
                        });
                    }
                };
                if (document.readyState === 'complete') {
                    registerServiceWorker();
                } else {
                    window.addEventListener('load', registerServiceWorker, { once: true });
                }
            } catch (e) {
                console.error('Init failed:', e);
                $('#loader').textContent = '加载失败';
            }
        }

        migrateConfig() {
            if (this.config.bookmarks && !this.config.categories) {
                this.config.categories = this.config.bookmarks;
                delete this.config.bookmarks;
            }
            if (this.config.showBookmarkIcons === undefined) {
                this.config.showBookmarkIcons = true;
            }
            if (this.config.theme === undefined) {
                this.config.theme = 'auto';
            }
            if (this.config.privacyMode === undefined) {
                this.config.privacyMode = false;
            }
        }

        /**
         * 当前生效的外观。优先级：本会话内存覆盖 → 本机 localStorage →
         * 服务端站点主题 → auto。
         *
         * 第一级只在 localStorage 写不进去时才有值（见 setTheme）；
         * 第二级在登录成功时会被清掉（见 adoptServerTheme），所以已登录
         * 时读到的一定是服务端值，两处不会各说各话。
         */
        resolveTheme() {
            if (APPEARANCE_ORDER.includes(this.themeOverride)) return this.themeOverride;
            try {
                const stored = localStorage.getItem(THEME_STORAGE_KEY);
                if (APPEARANCE_ORDER.includes(stored)) return stored;
            } catch (e) {}
            return this.config.theme || 'auto';
        }

        applyTheme() {
            const theme = this.resolveTheme();
            const root = document.documentElement;

            if (theme === 'auto') {
                // 跟随系统
                root.removeAttribute('data-theme');
            } else {
                // 强制指定主题
                root.setAttribute('data-theme', theme);
            }
            this.renderAppearanceButton(theme);
        }

        /** 右下角按钮的图标与无障碍文案跟着当前态走。 */
        renderAppearanceButton(theme) {
            const btn = $('#appearanceBtn');
            const icon = $('#appearanceIcon');
            if (!btn || !icon) return;
            icon.innerHTML = APPEARANCE_ICONS[theme] || APPEARANCE_ICONS.auto;
            const label = `外观：${APPEARANCE_TEXT[theme]}，点击切换到${APPEARANCE_TEXT[nextTheme(theme)]}`;
            btn.title = label;
            btn.setAttribute('aria-label', label);
        }

        /**
         * 登录态确立时的统一收尾：外观交回服务端那份。
         * 未登录访客的选择存在本机，登录后必须让位——否则本机旧值会一直
         * 压过站点主题（这正是 resolveTheme 那条优先级成立的前提）。
         * 每一处把 authenticated 置为 true 的地方都要调它；
         * tests/api-boundary.test.js 里有枚举断言钉住。
         */
        adoptServerTheme() {
            this.themeOverride = null;
            try {
                localStorage.removeItem(THEME_STORAGE_KEY);
            } catch (e) {}
            this.applyTheme();
        }

        cycleTheme() {
            return this.setTheme(nextTheme(this.resolveTheme()));
        }

        /**
         * 首页的「外观」按钮。未登录访客只能改本机——写站点主题要管理员，
         * 写 localStorage 不需要；登录后点它就等同于改站点主题，
         * 与后台「主题模式」下拉框是同一份状态。
         */
        async setTheme(theme) {
            if (!this.authenticated) {
                try {
                    localStorage.setItem(THEME_STORAGE_KEY, theme);
                    this.themeOverride = null;
                } catch (e) {
                    // 存不住（隐私模式 / 禁用站点数据）：本会话先按内存值生效，
                    // 并说明刷新后会丢。静默吞掉会让这次点击看起来毫无反应。
                    this.themeOverride = theme;
                    this.showToast('这台设备无法保存外观选择，刷新后会恢复', 'error');
                }
                this.applyTheme();
                return;
            }

            // 登录态下这次调用会**整份**提交 config，等于替用户按下「保存编辑」：
            // 编辑中未保存的布局草稿会一起写进服务器，而按下的那个按钮只说
            // 「外观」。不可逆的动作不能藏在一个附带控件后面，所以先问一句。
            if (this.editLayout) {
                const ok = await this.confirmAction(
                    '正在编辑首页导航，切换外观会连同未保存的改动一起保存到服务器。',
                    '保存并切换'
                );
                if (!ok) return;
            }

            const previous = this.config.theme;
            this.config.theme = theme;
            // 复用登录收尾：清本机覆盖 + 应用外观（removeItem 只此一处）
            this.adoptServerTheme();
            // 管理面板若开着，让下拉框跟上——两处是同一份状态
            const select = $('#themeModeSelect');
            if (select) select.value = theme;
            try {
                const res = await API.post('/api/config', this.config);
                if (!res.success) throw new Error(res.error || '保存失败');
            } catch (e) {
                this.config.theme = previous;
                this.applyTheme();
                if (select) select.value = previous;
                this.showToast('外观保存失败，已还原', 'error');
            }
        }

        render() {
            this.renderEngines();
            this.renderGrid();
        }

        renderEngines() {
            const current = this.config.searchEngines.find(e => e.id === this.config.searchEngine) || this.config.searchEngines[0];
            $('#engineName').textContent = current.name;
            $('#engineBtn').setAttribute('aria-label', `选择搜索引擎，当前为${current.name}`);
            
            const dropdown = $('#engineDropdown');
            dropdown.innerHTML = this.config.searchEngines.map(e => 
                `<button type="button" role="option" aria-selected="${e.id === this.config.searchEngine}" class="engine-option${e.id === this.config.searchEngine ? ' active' : ''}" data-id="${this.esc(e.id)}">${this.esc(e.name)}</button>`
            ).join('');
        }

        renderGrid() {
            const grid = $('#grid');
            const fragment = document.createDocumentFragment();
            // 编辑态多生成两类节点：分类头的手柄/删除按钮，与每类末尾的
            // ＋占位卡。**不进编辑态的模板与改动前逐字相同**，
            // 所以正常访问的首页零回归。
            const editing = this.editLayout;
            // ⚠️ 分类的拖拽宿主必须是 **.category-header**，不是那个 ⠿ 按钮，
            // 也**不能是整块 <section>**。两条都是实测出来的：
            //  1. <button> 不可拖拽，原生 DnD 只从最近的 draggable 起手，
            //     所以把手上没有 draggable 时一个 dragstart 都不发（实测 0 事件）。
            //  2. 反过来把 draggable 挂到整块 section 上，section 内部**任何**
            //     位置按下都会起拖——包括 ✎ 重命名与 ✕ 删除。那两个按钮于是
            //     变成「按住横拖 = 起拖 → 浏览器按规范抑制随后的 click →
            //     对话框打不开」，比改前更糟（改前根本不起拖，按钮是好的）。
            // 所以宿主收窄到分类头：**可拖的区域**与**分流判据**落在同一处，
            // 而 ✎/✕ 作为 draggable=false 的后代，在按钮上按下不会起拖。
            // 代价是 dragstart.target 解析到 .category-header，
            // 「拖分类」与「拖书签」在该事件上无法区分（书签卡是 section 的子节点、
            // 也是 draggable，命中它时 target 就是 <a> 本身）——
            // 分流靠 pointerdown 记住的真实落点。
            this.config.categories.forEach((cat, catIdx) => {
                const section = html(`
                    <section class="category" data-cat="${catIdx}">
                        <div class="category-header"${editing ? ' draggable="true"' : ''}>
                            <h2 class="category-title">${this.esc(cat.name)}</h2>
                            ${editing ? `<button type="button" class="category-action category-drag" title="拖拽调整分类顺序" aria-label="拖拽调整分类顺序">⠿</button>
                            <button type="button" class="category-action category-edit" data-edit-cat="${catIdx}" title="重命名分类">✎</button>
                            <button type="button" class="category-action category-del" data-del-cat="${catIdx}" title="删除分类" aria-label="删除分类 ${this.esc(cat.name)}">✕</button>` : ''}
                        </div>
                        <div class="bookmarks"></div>
                    </section>
                `);
                const bms = $('.bookmarks', section);
                cat.bookmarks.forEach((bm, bmIdx) => {
                    bms.appendChild(this.createBookmark(bm, catIdx, bmIdx));
                });
                if (editing) {
                    bms.appendChild(html(`<button type="button" class="bookmark bookmark-add" data-add-cat="${catIdx}" title="为「${this.esc(cat.name)}」添加导航" aria-label="为 ${this.esc(cat.name)} 添加导航">＋</button>`));
                }
                fragment.appendChild(section);
            });
            if (editing) {
                fragment.appendChild(html(`<button type="button" class="category-add">＋ 添加分类</button>`));
            }
            grid.replaceChildren(fragment);
        }

        createBookmark(bm, catIdx, bmIdx) {
            // 编辑态下 data-cat/data-bm 是拖拽与增删改的定位依据；
            // 非编辑态不写，首页 DOM 与改动前完全一致。
            const editing = this.editLayout;
            const attrs = editing ? ` data-cat="${catIdx}" data-bm="${bmIdx}" draggable="true"` : '';
            // 删除按钮压在卡的右上角：整张卡是拖拽宿主，按钮必须自己
            // stopPropagation，否则拖拽起手会把它一起带走。
            const del = editing
                ? `<button type="button" class="bookmark-del" data-del-bm="${bmIdx}" title="删除导航" aria-label="删除导航 ${this.esc(bm.title)}">✕</button>`
                : '';
            return html(`
                <a class="bookmark bookmark-text-only"${attrs} href="${this.esc(bm.url)}" target="_blank" rel="noopener" title="${this.esc(bm.title)}">
                    <span class="bookmark-title">${this.esc(bm.title)}</span>${del}
                </a>
            `);
        }

        bind() {
            $('#modeBtn').onclick = () => {
                const input = $('#searchInput');
                const value = input.value;
                if (this.pasteMode) {
                    // 分享态下该按钮是「退出」：只回到搜索态并清空，不跳去书签检索
                    this.exitPasteMode();
                    return;
                }
                input.value = this.favSearchMode
                    ? value.replace(/^[\/、]{1,2}/, '')
                    : `/${this.isPasteTrigger(value[0]) ? value.slice(1) : value}`;
                this.handleSearchInput(input);
                input.focus();
            };
            this.bindPointerEffects();
            this.bindKeyboardViewport();
            this.bindBookmarkPress();
            $('#searchForm').onsubmit = (e) => { e.preventDefault(); this.handleSearch(); };
            // textarea 的回车默认只换行，不会提交表单，因此两种模式都要自己接管：
            // 分享态回车发送、Shift/ Ctrl / Cmd+回车换行；搜索态回车搜索。
            $('#searchInput').addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                if (this.pasteMode) {
                    if (event.shiftKey || event.ctrlKey || event.metaKey) return;
                    event.preventDefault();
                }
                // 搜索态不能放行：裸回车会插入换行而不是提交表单
                if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
                    event.preventDefault();
                    this.handleSearch();
                }
            });
            $('#searchInput').oninput = (e) => {
                this.handleSearchInput(e);
                this.autoGrowPasteInput();
            };
            // 拖拽把手在右下角；按下它即视为用户接管高度，之后不再自动跟随。
            // 撞上 min-height 的空拖会留下一个永不生效的小高度并锁死自增高，
            // 因此拖拽结束时按实际渲染高度回退：没真的变高就交还给自动增高。
            // 监听挂在 window 上：拖到元素外松手也能收到，否则标志会永久卡住。
            const input = $('#searchInput');
            const settleDrag = () => {
                window.removeEventListener('pointerup', settleDrag);
                window.removeEventListener('pointercancel', settleDrag);
                if (!this.pasteUserResized) return;
                const minHeight = parseFloat(getComputedStyle(input).minHeight) || 0;
                if (input.getBoundingClientRect().height > minHeight + 1) return;
                this.pasteUserResized = false;
                input.style.height = '';
                this.autoGrowPasteInput();
            };
            input.addEventListener('pointerdown', event => {
                if (!this.pasteMode) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const onHandle = event.clientX > rect.right - 18 && event.clientY > rect.bottom - 18;
                if (!onHandle) return;
                this.pasteUserResized = true;
                window.addEventListener('pointerup', settleDrag);
                window.addEventListener('pointercancel', settleDrag);
            });
            $('#adminBtn').onclick = () => this.openAdmin();
            $('#helpBtn').onclick = () => this.showHelp();
            $('#layoutBtn').onclick = () => this.toggleEditLayout();
            // 外观切换不需要登录：未登录时写本机，登录后写服务端（见 setTheme）
            $('#appearanceBtn').onclick = () => this.cycleTheme();
            // Esc 放弃编辑。放在 window 而非按钮上：编辑态下焦点可能在
            // 任何 widget 或书签内部，按钮收不到冒泡不到的路径。
            document.addEventListener('keydown', event => {
                if (event.key !== 'Escape' || !this.editLayout) return;
                const zone = $('#moduleZone');
                // 全屏面板与站内对话框自己处理 Esc（它们是 overlay，不属于编辑态）
                if (zone && zone.querySelector('.module-overlay')) return;
                if ($('.ui-dialog-overlay, .fav-dialog-overlay')) return;
                event.preventDefault();
                this.cancelEditSession();
            });
            this.bindWidgetDrag();
            this.bindGridEdit();
            // 视口变化时重算模块区的停靠方式：936 背板在宽屏两侧放得下、
            // 窄屏放不下，这个判据是连续量，跨过阈值时要重新摆放。
            let dockResizeTimer = null;
            window.addEventListener('resize', () => {
                clearTimeout(dockResizeTimer);
                dockResizeTimer = setTimeout(() => {
                    const zone = $('#moduleZone');
                    if (!zone || zone.hidden) return;
                    // 背板宽度也是连续量（宽栏模式在阈值附近来回切），所以先重算
                    // data-rail 再判停靠；两者任一变了都要重渲染。
                    const railBefore = $('#app') ? $('#app').dataset.rail : null;
                    this.syncRail();
                    const railChanged = ($('#app') ? $('#app').dataset.rail : null) !== railBefore;
                    const want = this.sideDockAvailable() ? 'outside' : 'below';
                    if (railChanged || zone.dataset.dock !== want) this.renderModuleZone();
                }, 150);
            });
            $('#modalBackdrop').onclick = () => this.closeAdmin();
            $('#cancelBtn').onclick = () => this.closeAdmin();
            $('#saveBtn').onclick = () => this.save();
            $('#modal .modal-content').addEventListener('keydown', event => {
                if (event.key !== 'Tab' || $('#modal').hidden || $('.ui-dialog-overlay, .fav-dialog-overlay')) return;
                const focusables = [...$('#modal .modal-content').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')]
                    .filter(el => el.getClientRects().length > 0);
                const first = focusables[0], last = focusables.at(-1);
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            });

            const engineBtn = $('#engineBtn');
            const dropdown = $('#engineDropdown');
            
            engineBtn.onclick = (e) => {
                e.stopPropagation();
                const isOpen = !dropdown.hidden;
                dropdown.hidden = isOpen;
                // 只用 aria-expanded 驱动展开态：此前还并行 toggle 一个 .active 类，
                // 但该类已无任何 CSS 消费者（.search-engine.active 规则已删），
                // 留着会让展开状态有两个真相来源。
                engineBtn.setAttribute('aria-expanded', String(!isOpen));
                if (!isOpen) dropdown.querySelector('.engine-option.active')?.focus();
            };
            
            dropdown.onclick = (e) => {
                const option = e.target.closest('.engine-option');
                if (option) {
                    this.config.searchEngine = option.dataset.id;
                    this.renderEngines();
                    dropdown.hidden = true;
                    engineBtn.setAttribute('aria-expanded', 'false');
                    $('#searchInput').focus();
                }
            };
            
            document.onclick = (e) => {
                if (!e.target.closest('.search-wrapper')) {
                    dropdown.hidden = true;
                    engineBtn.setAttribute('aria-expanded', 'false');
                    this.hideFavDropdown();
                }
            };

            document.addEventListener('pointerdown', (e) => {
                if (!e.target.closest('.search-wrapper')) this.hideFavDropdown();
            }, { passive: true });

            const reopenFavDropdown = () => {
                if (!this.favSearchMode) return;
                const favoritesDropdown = $('#favDropdown');
                if (!favoritesDropdown?.hidden) return;
                favoritesDropdown.hidden = false;
                const value = $('#searchInput').value;
                const skip = value.length > 1 && this.isFavSearchTrigger(value[1]) ? 2 : 1;
                this.searchFavorites(value.slice(skip).trim());
            };
            $('#searchInput').onclick = reopenFavDropdown;
            $('#searchInput').onfocus = reopenFavDropdown;

            document.onkeydown = (e) => {
                // 书签检索模式的键盘导航
                if (this.favSearchMode && this.handleFavKeydown(e)) {
                    return;
                }

                if (e.key === 'Escape') {
                    if (!dropdown.hidden) {
                        dropdown.hidden = true;
                        engineBtn.setAttribute('aria-expanded', 'false');
                        engineBtn.focus();
                    } else if (!$('#modal').hidden) {
                        this.closeAdmin();
                    } else if (this.pasteMode) {
                        // 分享态退出。移动端没有 Esc 键，主路径是左侧「退出」按钮
                        this.exitPasteMode();
                    }
                }
            };
        }

        // 软键盘弹出时把被遮挡的高度写进 --kb-inset，供弹窗收高。
        // vh 与 dvh 都不会跟随软键盘收缩（规范如此），只有 visualViewport 反映
        // 真实可视高度；不支持该 API 的浏览器 --kb-inset 保持 0，行为不变。
        bindKeyboardViewport() {
            const viewport = window.visualViewport;
            if (!viewport) return;
            let frame = 0;
            const sync = () => {
                if (frame) return;
                frame = requestAnimationFrame(() => {
                    frame = 0;
                    const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
                    document.documentElement.style.setProperty('--kb-inset', `${covered}px`);
                    // 编辑区的 max-height 依赖这个变量，键盘弹出/收起后要重新算高度，
                    // 否则会停在键盘弹出前算出的值上
                    this.autoGrowPasteInput();
                });
            };
            viewport.addEventListener('resize', sync);
            viewport.addEventListener('scroll', sync);
            sync();
        }

        bindPointerEffects() {
            if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
            let frame = 0;
            const setPosition = (element, event, xName, yName) => {
                const rect = element.getBoundingClientRect();
                element.style.setProperty(xName, `${event.clientX - rect.left}px`);
                element.style.setProperty(yName, `${event.clientY - rect.top}px`);
            };
            $('#searchForm').addEventListener('pointermove', event => {
                if (frame) return;
                frame = requestAnimationFrame(() => {
                    setPosition($('#searchForm'), event, '--glow-x', '--glow-y');
                    const control = event.target.closest('.search-mode,.search-engine,.search-btn');
                    if (control) setPosition(control, event, '--glow-x', '--glow-y');
                    frame = 0;
                });
            });
            let gridFrame = 0;
            $('#grid').addEventListener('pointermove', event => {
                const bookmark = event.target.closest('.bookmark');
                if (!bookmark || gridFrame) return;
                gridFrame = requestAnimationFrame(() => {
                    setPosition(bookmark, event, '--glow-x', '--glow-y');
                    gridFrame = 0;
                });
            });
        }

        bindBookmarkPress() {
            const grid = $('#grid');
            const releaseTimers = new WeakMap();
            let pressedBookmark = null;
            const press = (bookmark) => {
                clearTimeout(releaseTimers.get(bookmark));
                bookmark.classList.add('is-pressed');
            };
            const release = (bookmark) => {
                if (!bookmark) return;
                clearTimeout(releaseTimers.get(bookmark));
                releaseTimers.set(bookmark, setTimeout(() => bookmark.classList.remove('is-pressed'), 135));
            };
            grid.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                if (pressedBookmark) pressedBookmark.classList.remove('is-pressed');
                pressedBookmark = event.target.closest('.bookmark');
                if (pressedBookmark) press(pressedBookmark);
            });
            grid.addEventListener('pointerout', (event) => {
                if (event.pointerType === 'touch' || !pressedBookmark) return;
                if (pressedBookmark.contains(event.target) && !pressedBookmark.contains(event.relatedTarget)) {
                    pressedBookmark.classList.remove('is-pressed');
                    pressedBookmark = null;
                }
            });
            window.addEventListener('pointerup', () => {
                release(pressedBookmark);
                pressedBookmark = null;
            });
            window.addEventListener('pointercancel', () => {
                pressedBookmark?.classList.remove('is-pressed');
                pressedBookmark = null;
            });
            grid.addEventListener('click', (event) => {
                const bookmark = event.target.closest('.bookmark');
                if (!bookmark) return;
                press(bookmark);
                release(bookmark);
            });
        }

        moveBookmark(fromCat, fromBm, toCat, toBm) {
            const cats = this.config.categories;
            const [item] = cats[fromCat].bookmarks.splice(fromBm, 1);
            if (fromCat === toCat && fromBm < toBm) toBm--;
            cats[toCat].bookmarks.splice(toBm, 0, item);
            this.renderGrid();
            this.markConfigDirty();
        }

        moveCategory(from, to) {
            const cats = this.config.categories;
            const [item] = cats.splice(from, 1);
            cats.splice(to, 0, item);
            this.renderGrid();
            this.markConfigDirty();
        }

        // ========== 首页编辑模式（书签 / 分类的增删改与拖拽） ==========
        //
        // 拖拽走 HTML5 DnD 而非 pointer 事件：模块那边用 pointer 是因为宽屏
        // 绝对定位卡片要实时跟手并自己处理基准跳变，而书签网格是 CSS grid、
        // 没有 --stack-top 那一层补偿。一次拖拽开始后浏览器会抑制随后的
        // click（规范行为），所以同一张卡既能拖又能点开编辑框，
        // 不需要额外的计时器去区分。

        bindGridEdit() {
            const grid = $('#grid');
            if (!grid) return;
            let dragFrom = null;
            let dragKind = null;
            // pointerdown 落在哪个区域，比 dragstart.target 更可靠：
            // 分类的宿主是 .category-header，而书签是 section 内部的 <a>，
            // 两者在 dragstart.target 上无法区分（都解析到最近的 draggable）。
            // 按下时记下真实落点，dragstart 只用它定性。
            // ⚠️ 判据是「落在分类头里」，而**不是**「落在 ⠿ 上」——
            // 宿主已经是分类头，把手只是它内部的一个点。
            let downOnCategory = false;

            const catIndexOf = node => {
                const section = node.closest('.category');
                return section ? +section.dataset.cat : -1;
            };
            const bmIndexOf = node => {
                const card = node.closest('.bookmark');
                return card && card.dataset.bm !== undefined ? +card.dataset.bm : -1;
            };

            grid.addEventListener('pointerdown', event => {
                if (!this.editLayout || event.button !== 0) return;
                // ⚠️ 落在 ✎/✕ 上必须取消这次按压，否则会连累按钮。
                // 分类头整块 draggable，而**后代的 draggable="false" 并不能豁免**：
                // 实测 Chrome 里可拖拽祖先的后代（普通 button、写死 draggable=false 的
                // button、h2 都一样）按下照样起拖，dragstart 命中祖先。
                // 于是按住 ✎ 横拖 = 拖走整个分类，浏览器按规范抑制随后的 click，
                // 重命名/删除对话框再也打不开（实测：单独点击正常，一拖就死）。
                // pointerdown 里 preventDefault 能彻底取消起拖——对照页实测
                // 取消后一个 dragstart 都不发，只有 click 照常送达。
                // dragstart 里再 preventDefault 就晚了：拖影已经出现、click 已丢。
                if (event.target.closest('.category-action:not(.category-drag)')) {
                    event.preventDefault();
                    downOnCategory = false;
                    return;
                }
                downOnCategory = !!event.target.closest('.category-header');
            });

            grid.addEventListener('dragstart', event => {
                if (!this.editLayout) return;
                if (downOnCategory) {
                    dragKind = 'cat';
                    dragFrom = catIndexOf(event.target);
                    // .category.is-dragging 的样式早已存在（压暗整块），
                    // 但此前没有任何代码给分类加过这个 class——空规则。
                    // 注意它挂在整个 <section> 上，所以拖一个分类会把它下面
                    // 所有书签卡一起压暗 45%，不是只压暗把手。
                    const source = event.target.closest('.category');
                    if (source) source.classList.add('is-dragging');
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', String(dragFrom));
                    return;
                }
                const card = event.target.closest('.bookmark');
                // 加号卡不参与排序，它是「新增」入口
                if (!card || card.classList.contains('bookmark-add')) {
                    // 既不是分类头也不是书签卡（例如从 ＋ 卡片起拖）：
                    // 明确取消这次拖拽。什么都不做的话浏览器会照常画拖影，
                    // 松手也没 drop——用户看到的是「能拖、拖了没反应」。
                    event.preventDefault();
                    dragKind = null;
                    return;
                }
                dragKind = 'bm';
                dragFrom = { cat: catIndexOf(card), bm: bmIndexOf(card) };
                card.classList.add('is-dragging');
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', card.dataset.bm);
            });

            grid.addEventListener('dragover', event => {
                if (!this.editLayout || !dragKind) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (dragKind !== 'cat') return;
                // 分类拖拽的落点提示：拖到谁头上，谁就压暗。
                // 书签拖拽靠 .is-dragging 半透明表达（卡片多、逐个高亮反而吵）。
                const section = event.target.closest('.category');
                $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                if (section && +section.dataset.cat !== dragFrom) {
                    section.classList.add('drop-target');
                }
            });

            grid.addEventListener('drop', event => {
                if (!this.editLayout || !dragKind) return;
                event.preventDefault();
                if (dragKind === 'cat') {
                    const to = catIndexOf(event.target);
                    // 落在自己身上不算移动，必须严格不同才搬
                    if (to >= 0 && to !== dragFrom) this.moveCategory(dragFrom, to);
                    $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                } else {
                    const section = event.target.closest('.category');
                    const targetBm = event.target.closest('.bookmark');
                    const toCat = section ? +section.dataset.cat : -1;
                    // 守卫必须在**解引用之前**。「＋ 添加分类」按钮与网格间隙
                    // 都在任一 .category 之外，closest 返回 null → toCat = -1，
                    // 而 categories[-1] 是 undefined。原写法把 if (toCat >= 0)
                    // 放在求值之后，异常从监听器抛出，dragKind 的清理
                    // （下面两行）不执行——拖拽状态就此卡住，下一次
                    // dragover 仍认为在拖拽。
                    if (toCat < 0) { dragKind = null; dragFrom = null; return; }
                    // 落在空白书签区（没有具体书签）时追加到该分类末尾
                    const toBm = targetBm && !targetBm.classList.contains('bookmark-add')
                        ? +targetBm.dataset.bm
                        : this.config.categories[toCat].bookmarks.length;
                    if (toBm >= 0) this.moveBookmark(dragFrom.cat, dragFrom.bm, toCat, toBm);
                }
                dragKind = null;
                dragFrom = null;
            });

            grid.addEventListener('dragend', () => {
                $$('.bookmark.is-dragging', grid).forEach(n => n.classList.remove('is-dragging'));
                $$('.category.is-dragging', grid).forEach(n => n.classList.remove('is-dragging'));
                // ⚠️ 落点高亮必须在这里也清一遍。drop 只在**松手点位于 #grid 内**
                // 才触发，而监听挂在 grid 上——拖到页头、模块区、留白处松手
                // 走不到 drop 的清理，落点分类就一直压暗着，而它的视觉与
                // .is-dragging 完全相同（同为 opacity .55），用户分不清
                // 「在拖」还是「卡住了」。
                $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                dragKind = null;
                dragFrom = null;
                downOnCategory = false;
            });

            grid.addEventListener('click', event => {
                if (!this.editLayout) return;
                const target = event.target;

                const addCard = target.closest('.bookmark-add');
                if (addCard) { event.preventDefault(); this.addHomeBookmark(+addCard.dataset.addCat); return; }

                if (target.closest('.category-add')) { event.preventDefault(); this.addHomeCategory(); return; }

                const delCat = target.closest('.category-del');
                if (delCat) { event.preventDefault(); this.deleteHomeCategory(+delCat.dataset.delCat); return; }

                const editCat = target.closest('.category-edit');
                if (editCat) { event.preventDefault(); this.renameHomeCategory(+editCat.dataset.editCat); return; }

                // 删除按钮优先于卡片本身：它压在卡右上角，
                // 若继续往下走会当成「点卡片」而打开编辑框。
                const delBm = target.closest('.bookmark-del');
                if (delBm) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.deleteHomeBookmark(catIndexOf(delBm), +delBm.dataset.delBm);
                    return;
                }

                const card = target.closest('.bookmark');
                if (card) {
                    // 编辑态下书签卡不再是链接入口，点了是打开编辑框
                    event.preventDefault();
                    this.editHomeBookmark(catIndexOf(card), bmIndexOf(card));
                }
            });

            // 编辑态下书签卡整体是拖拽宿主，按下即进入原生拖拽。
            // 链接默认导航由下面的 click 分支拦（编辑态点了是打开编辑框，不是跳转）。
            grid.addEventListener('pointerdown', event => {
                if (!this.editLayout || event.button !== 0) return;
                const card = event.target.closest('.bookmark');
                if (!card || card.classList.contains('bookmark-add')) return;
                card.focus();
            });

            this.bindTouchGridDrag();
        }

        /**
         * 触摸端的长按拖拽（书签 / 分类）。
         *
         * 为什么不能靠原生 DnD：MDN 写明 drag events **继承自 mouse events**
         * （"drag events inherited from mouse events"），而触摸没有 mouse 事件链，
         * 所以 iOS Safari / Android Chrome 上按了也不发 dragstart——实测层级的
         * 事实，不是兼容性不足。CSS 的 touch-action 管不了这个，它只决定浏览器
         * 是否接管手势。模块卡片那边不受影响是因为它走的是 pointer 事件。
         *
         * 所以触摸端单独一条 pointer 路径，与模块拖拽同一套机制
         * （pointer capture + window 上的终止监听），排序则复用桌面端
         * 同一个 moveCategory / moveBookmark——两套排序实现就会有两个真值。
         *
         * 激活判据是**长按 400ms、容忍 25px 漂移**（iOS 长按菜单与
         * @dragdroptouch 的 pressHoldDelayMS / pressHoldMargin 同量级）。
         * 不用「一按就拖」：书签网格在首页常常要滚动浏览，抢走手势就没法滚了；
         * 也不用纯位移阈值：滑动页面途中就判成拖拽，误触成本高。
         * ⚠️ 因此**不写 touch-action: none**（与 .module-drag-handle 有意不同）。
         *
         * 落点用 elementFromPoint 判定，而不是坐标几何：网格会随拖拽重排，
         * 实时几何与缓存中线都可能失效（模块那条路径踩过这个坑，
         * 见 reorderWhileDragging 的注释）。
         */
        bindTouchGridDrag() {
            const grid = $('#grid');
            if (!grid) return;
            const HOLD_MS = 400;
            const HOLD_TOLERANCE = 25;
            // 激活后的拖拽状态；未激活时 hold 为 null
            let hold = null;
            let drag = null;

            const catIndexOf = node => {
                const section = node.closest('.category');
                return section ? +section.dataset.cat : -1;
            };

            const clearHold = () => {
                if (!hold) return;
                clearTimeout(hold.timer);
                hold.node.classList.remove('is-arming');
                hold = null;
            };

            // 按落点算出「分类 / 书签」的哪一条，统一返回 {kind, cat, bm, node}
            const resolveTarget = (x, y) => {
                const el = document.elementFromPoint(x, y);
                if (!el) return null;
                const add = el.closest('.bookmark-add, .category-add');
                // ＋ 卡片是新增入口，不参与排序
                if (add) return null;
                const card = el.closest('.bookmark');
                const section = el.closest('.category');
                const toCat = section ? +section.dataset.cat : -1;
                if (toCat < 0) return null;
                const toBm = card && card.dataset.bm !== undefined
                    ? +card.dataset.bm
                    : this.config.categories[toCat].bookmarks.length;
                return { card: !!card, cat: toCat, bm: toBm, section };
            };

            grid.addEventListener('pointerdown', event => {
                // 只接触摸。鼠标走已验证的原生 DnD，两条路径**互不重叠**：
                // 桌面端若也进这条路径，就要额外处理「一按就拖 vs 选文字」。
                if (event.pointerType !== 'touch' || event.button !== 0) return;
                if (!this.editLayout) return;
                // ✎/✕ 上按下不拖（同 pointerdown 的排除，见 bindGridEdit）
                if (event.target.closest('.category-action:not(.category-drag)')) return;

                const header = event.target.closest('.category-header');
                const card = event.target.closest('.bookmark');
                const node = header || (card && !card.classList.contains('bookmark-add') ? card : null);
                if (!node) return;

                const source = {
                    node,
                    kind: header ? 'cat' : 'bm',
                    from: header
                        ? catIndexOf(header)
                        : { cat: catIndexOf(card), bm: +card.dataset.bm }
                };
                clearHold();
                hold = {
                    ...source,
                    // pointerId 必须存下来：settle 用它判断「这次松手是不是
                    // 这一根手指」。早先没存，settle 里 `hold.pointerId` 恒为
                    // undefined，与任何 pointerId 都不相等——于是那一道守卫
                    // 只能靠 `!event` 兜底，pointercancel 路径上 hold 清不掉。
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    timer: setTimeout(() => activate(event.pointerId), HOLD_MS)
                };
                node.classList.add('is-arming');

                function activate(pointerId) {
                    if (!hold) return;
                    const { node: n, kind, from } = hold;
                    clearHold();
                    // ⚠️ 「压暗谁」必须与「复原谁」是同一个元素。分类拖拽压暗的是
                    // **整块 section**（CSS 就是 .category.is-dragging），
                    // 而收尾时若按 node（分类头）去 remove，section 上那层永远清不掉——
                    // 只要这次拖拽没提交（取消、落点无效），压暗就会一直留着。
                    // 所以把承载 class 的元素记进 drag，两边都读它。
                    const tinted = kind === 'cat' ? (n.closest('.category') || n) : n;
                    drag = { id: pointerId, node: n, tinted, kind, from, to: null };
                    tinted.classList.add('is-dragging');
                    // 拖拽期间接管后续手势，并阻止滚动/缩放被浏览器抢走。
                    // touch-action 在 CSS 里**不能**这么写（会把滚动永久禁掉），
                    // 只能在激活这一刻取消。
                    try { n.setPointerCapture(pointerId); } catch (e) {}
                    // 长按激活后必须压掉随后的 click，否则松手会顺带打开编辑框。
                    // 桌面端靠 DnD 规范自动抑制 click，触摸端没有这个保证。
                    suppressNextClick(n);
                }
            });

            const move = event => {
                if (hold) {
                    // 长按期间的漂移超过容忍 = 用户在滚动，不是想拖
                    const dx = event.clientX - hold.x;
                    const dy = event.clientY - hold.y;
                    if (Math.hypot(dx, dy) > HOLD_TOLERANCE) {
                        clearHold();
                        return;
                    }
                    return;
                }
                if (!drag || event.pointerId !== drag.id) return;
                event.preventDefault();
                const target = resolveTarget(event.clientX, event.clientY);
                if (!target) {
                    $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                    drag.to = null;
                    return;
                }
                drag.to = target;
                // 分类拖拽给出落点提示；书签拖拽靠 .is-dragging 半透明表达
                $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                if (drag.kind === 'cat' && target.section && target.cat !== drag.from) {
                    target.section.classList.add('drop-target');
                }
            };

            const settle = event => {
                if (hold && (!event || event.pointerId === hold.pointerId)) clearHold();
                if (!drag || (event && event.pointerId !== drag.id)) return;
                const { node, tinted, kind, from, to, id } = drag;
                drag = null;
                try { node.releasePointerCapture(id); } catch (e) {}
                tinted.classList.remove('is-dragging');
                $$('.category.drop-target', grid).forEach(n => n.classList.remove('drop-target'));
                // to 只在 move 里被设过。长按满 400ms 却一直没动时它是 null——
                // 不看这一条，松手就会把元素挪到一个用户没指过的地方。
                // （一个曾经存在的 `moved` 标志被删掉了：它与 `!to` 等价，
                //   变异验证显示删掉它没有任何用例转红，即它是死代码。）
                if (!to) return;
                if (kind === 'cat') {
                    if (to.cat !== from) this.moveCategory(from, to.cat);
                } else if (to.cat !== from.cat || to.bm !== from.bm) {
                    this.moveBookmark(from.cat, from.bm, to.cat, to.bm);
                }
            };

            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', settle);
            window.addEventListener('pointercancel', settle);

            // 激活后抑制一次 click：长按松手会顺带触发 click，
            // 而 click 分支会打开编辑框 / 新建对话框——用户只想挪个位置。
            function suppressNextClick(node) {
                const swallow = event => {
                    if (!(node === event.target || node.contains(event.target))) return;
                    event.stopPropagation();
                    event.preventDefault();
                };
                grid.addEventListener('click', swallow, { capture: true, once: true });
                // 万一这次没有 click（例如手指在激活后滑走），兜底移除，
                // 否则监听会一直留着，下一次真实点击被吞掉。
                setTimeout(() => grid.removeEventListener('click', swallow, true), 600);
            }
        }

        /** 书签字段校验：标题非空、URL 必须是 http/https。 */
        bookmarkFieldError([title, url]) {
            if (!title || !title.trim()) return '请填写标题';
            const trimmed = (url || '').trim();
            if (!trimmed) return '请填写网址';
            let parsed;
            try { parsed = new URL(trimmed); } catch (e) { return '网址格式不正确'; }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '网址必须以 http:// 或 https:// 开头';
            return '';
        }

        async addHomeBookmark(catIdx) {
            const cat = this.config.categories[catIdx];
            if (!cat) return;
            const result = await this.showUiDialog({
                title: `为「${cat.name}」添加导航`,
                fields: [{ label: '标题' }, { label: '网址', placeholder: 'https://' }],
                confirmText: '添加',
                validate: (values, choices) => this.bookmarkFieldError(values)
            });
            if (!result) return;
            const [title, url] = result.values;
            cat.bookmarks.push({ id: uid(), title: title.trim(), url: url.trim() });
            this.renderGrid();
            this.markConfigDirty();
            this.showToast('导航已添加，点「保存编辑」生效');
        }

        async editHomeBookmark(catIdx, bmIdx) {
            const bm = this.config.categories[catIdx]?.bookmarks[bmIdx];
            if (!bm) return;
            const result = await this.showUiDialog({
                title: '编辑导航',
                message: `所属分类：${this.config.categories[catIdx].name}`,
                fields: [{ label: '标题', value: bm.title }, { label: '网址', value: bm.url }],
                confirmText: '保存',
                validate: values => this.bookmarkFieldError(values)
            });
            if (!result) return;
            const [title, url] = result.values;
            bm.title = title.trim();
            bm.url = url.trim();
            this.renderGrid();
            this.markConfigDirty();
        }

        async deleteHomeBookmark(catIdx, bmIdx) {
            const bm = this.config.categories[catIdx]?.bookmarks[bmIdx];
            if (!bm) return;
            if (!await this.confirmAction(`删除导航「${bm.title}」？`, '删除导航', true)) return;
            this.config.categories[catIdx].bookmarks.splice(bmIdx, 1);
            this.renderGrid();
            this.markConfigDirty();
        }

        async addHomeCategory() {
            const name = await this.promptValue('添加分类', '分类名称', { validate: ([v]) => (v && v.trim()) ? '' : '请填写分类名称' });
            if (name === null) return;
            this.config.categories.push({ id: uid(), name: name.trim(), bookmarks: [] });
            this.renderGrid();
            this.markConfigDirty();
        }

        async renameHomeCategory(catIdx) {
            const cat = this.config.categories[catIdx];
            if (!cat) return;
            const name = await this.promptValue('重命名分类', '分类名称', {
                value: cat.name,
                validate: ([v]) => (v && v.trim()) ? '' : '请填写分类名称'
            });
            if (name === null) return;
            cat.name = name.trim();
            this.renderGrid();
            this.markConfigDirty();
        }

        async deleteHomeCategory(catIdx) {
            // 至少留一个分类：首页要有一个容器，否则网格整块空掉
            if (this.config.categories.length <= 1) {
                this.showToast('至少保留一个分类', 'error');
                return;
            }
            const cat = this.config.categories[catIdx];
            if (!cat) return;
            const message = cat.bookmarks.length
                ? `删除分类「${cat.name}」及其中的 ${cat.bookmarks.length} 个导航？`
                : `删除分类「${cat.name}」？`;
            if (!await this.confirmAction(message, '删除分类', true)) return;
            this.config.categories.splice(catIdx, 1);
            this.renderGrid();
            this.markConfigDirty();
        }

        search() {
            const q = $('#searchInput').value.trim();
            if (!q) return;
            const engine = this.config.searchEngines.find(e => e.id === this.config.searchEngine);
            if (engine) window.open(engine.url + encodeURIComponent(q), '_blank');
            $('#searchInput').value = '';
        }

        // ========== 书签模糊检索 ==========

        async loadFavorites() {
            this.favoritesLoading = true;
            this.favoritesLoadError = false;
            try {
                const data = await API.get('/api/favorites');
                this.favorites = data.favorites || [];
                // 拼音库只在构建搜索索引时才需要，按需加载，不阻塞首屏。
                // 加载失败则索引不含拼音（普通搜索仍可用），不阻断书签加载。
                await this.loadScript('lib/pinyin.js').catch(() => {});
                this.buildSearchIndex();
            } catch (e) {
                console.error('Load favorites failed:', e);
                this.favorites = [];
                this.favoritesLoadError = true;
            } finally {
                this.favoritesLoading = false;
                this.updateFavStat();
                ['importFavBtn', 'exportFavBtn', 'addFavBtn'].forEach(id => {
                    const button = $(`#${id}`);
                    if (button) button.disabled = false;
                });
                if (this.favSearchMode) {
                    const value = $('#searchInput').value;
                    const skip = value.length > 1 && this.isFavSearchTrigger(value[1]) ? 2 : 1;
                    this.searchFavorites(value.slice(skip).trim());
                }
            }
        }

        // ========== 管理会话 ==========

        /**
         * widget 拖拽排序 / 换边。委托在模块区上，编辑态才生效。
         *
         * 三条纪律来自既有代码的教训：
         *  1. 终止监听挂在 window 上——挂在元素上用 { once:true } 会在指针于元素外
         *     释放时永久卡住（分享编辑器的 auto-grow 曾这样冻结整个会话）。
         *  2. 同时处理 pointercancel，只有 pointerup 会漏掉系统中断手势。
         *  3. 排序写进内存后按新顺序重排一次；落盘交给「保存编辑」，
         *     两套存储的提交在那里串行进行，失败整体回滚。
         */
        bindWidgetDrag() {
            const zone = $('#moduleZone');
            if (!zone) return;

            zone.addEventListener('pointerdown', event => {
                if (!this.editLayout || !this.modulesConfig) return;
                const handle = event.target.closest('.module-drag-handle');
                if (!handle) return;
                const widget = handle.closest('.module-widget');
                if (!widget) return;
                // 只响应主键：右键/中键会带着 contextmenu，另开一条路径反而多一个状态
                if (event.button !== 0) return;

                event.preventDefault();
                this.beginWidgetDrag(event, widget);
            });
        }

        beginWidgetDrag(event, widget) {
            // 布局键与 applyWidgetLayout 一致：instanceId 优先，
            // 回落到 moduleId。两者不一致会让拖拽写进一条布局项、
            // 而渲染读的是另一条——卡片看着「拖了但没动」。
            const id = widget.dataset.instanceId || widget.dataset.moduleId;

            const isWide = window.matchMedia('(min-width: 1024px)').matches;
            const startX = event.clientX;
            const startY = event.clientY;

            widget.classList.add('is-dragging');
            // pointer capture：指针移出元素后事件仍回到它身上，与 window 上的
            // 终止监听双保险。旧浏览器/模拟环境可能没有这个方法。
            try { widget.setPointerCapture(event.pointerId); } catch (e) {}

            // startX/startY 挂在 dragData 上：插入导致基准跳变时要把它们同步调整，
            // 否则下一帧仍用旧起点算 dy，位置会逐帧漂移。
            this.dragData = { id, widget, isWide, targetSide: null, bounds: null, startX, startY };

            const move = ev => {
                if (!this.dragData) return;
                const dx = ev.clientX - this.dragData.startX;
                const dy = ev.clientY - this.dragData.startY;
                widget.style.transform = `translate(${dx}px, ${dy}px)`;

                // 同栏内按指针位置插入到正确位置——**拖拽过程中就要真的移动 DOM**。
                // 早先只在松手时按「DOM 当前顺序」写 order，可节点从没被移动过，
                // 读回来的还是原顺序，于是拖 NAS 到本机位置两者纹丝不动。
                this.reorderWhileDragging(ev.clientY, ev.clientX);

                // 换边仅宽屏可用：窄屏模块区是横滑列表，
                // 横向拖拽会与横滑抢同一个手势
                if (!isWide) return;
                this.markDropSide(dx > 80 ? 'right' : dx < -80 ? 'left' : null);
            };

            const settle = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', settle);
                window.removeEventListener('pointercancel', settle);
                try { widget.releasePointerCapture(event.pointerId); } catch (e) {}
                const drag = this.dragData;
                this.dragData = null;
                if (!drag) return;
                this.commitWidgetDrag(drag);
            };

            // ⚠️ 这一行曾经**从未存在过**：move 只被 removeEventListener 解绑，
            // 从来没有被注册，于是整个模块拖拽只按下不跟随，松手即回到原位——
            // 而 403 条测试全绿，因为它们断言的是「监听挂在 window 且能解绑」，
            // 恰好跳过了「要先注册」这一步。注册与解绑必须成对出现。
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', settle);
            window.addEventListener('pointercancel', settle);
        }

        markDropSide(side) {
            if (!this.dragData) return;
            if (this.dragData.targetSide === side) return;
            this.dragData.targetSide = side;
            const zone = $('#moduleZone');
            if (!zone) return;
            if (side) zone.dataset.dropSide = side;
            else delete zone.dataset.dropSide;
            const draggedId = this.dragData.id;
            zone.querySelectorAll('.module-widget').forEach(node => {
                const key = node.dataset.instanceId || node.dataset.moduleId;
                node.classList.toggle('drop-target',
                    !!side && node.dataset.side === side && key !== draggedId);
            });
        }

        /**
         * 按指针位置把被拖的卡插入到正确位置。
         *
         * 拖拽中卡片跟着指针走（transform），其余卡片要让位——所以每一帧都要
         * 重新排一次并重算 `--stack-top`。判据是「指针落在谁的中线上」。
         *
         * 关键：中线必须在**拖拽开始时**量一次并缓存，不能每帧读实时
         * `getBoundingClientRect()`。因为卡片一旦让位，上方那张的实时中线也跟着
         * 移位，于是「指针 < 中线」这个比较会在自己造成的移动中失配——
         * 实测把最后一张拖到最前，怎么拖都插不进去。
         *
         * 窄屏是横滑列表，判据换成横向。
         */
        reorderWhileDragging(clientY, clientX) {
            const zone = $('#moduleZone');
            const drag = this.dragData;
            if (!zone || !drag) return;
            const widget = drag.widget;
            const horizontal = zone.dataset.dock === 'below';
            const pointer = horizontal ? clientX : clientY;

            if (!drag.bounds) {
                // 只量一次：被拖卡片之外那些，在「未让位」状态下的中线
                drag.bounds = [...zone.querySelectorAll('.module-widget')]
                    .filter(node => node !== widget)
                    .map(node => {
                        const rect = node.getBoundingClientRect();
                        return {
                            node,
                            mid: horizontal
                                ? rect.left + rect.width / 2
                                : rect.top + rect.height / 2
                        };
                    })
                    .sort((a, b) => a.mid - b.mid);
            }
            if (!drag.bounds.length) return;

            // 拖拽期间每次让位都会改变次序，所以顺序也每帧重算；
            // 但每张卡的**中线**用缓存里的值。
            const ordered = drag.bounds
                .slice()
                .sort((a, b) =>
                    (a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
            const anchor = ordered.find(entry => pointer < entry.mid) || null;

            const inner = zone.querySelector('.module-zone-inner') || zone;

            // 视觉位置 = 基准（--stack-top）+ transform。插入会让基准突变
            // （实测从 376 跳到 188），而 transform 仍相对拖拽起点——
            // 于是合成后的视觉位置猛跳 247px，卡片「弹」回原处。
            // 修法：记住基准的差量，补进 transform，让视觉位置保持不变。
            const before = this.readStackTop(widget);
            let moved = false;
            if (anchor) {
                if (anchor.node.previousElementSibling === widget) return;  // 已经就位
                inner.insertBefore(widget, anchor.node);
                moved = true;
            } else if (inner.lastElementChild !== widget) {
                inner.appendChild(widget);
                moved = true;
            } else {
                return;
            }
            if (moved) this.compensateStackShift(widget, before, horizontal);
        }

        readStackTop(widget) {
            const value = parseFloat(widget.style.getPropertyValue('--stack-top'));
            return Number.isFinite(value) ? value : 0;
        }

        /**
         * 插入导致基准跳变时，把它补进 transform，使卡片的**视觉位置**保持不动。
         * 不这样做的话，用户看到的是卡片先弹回原处再跟上指针——幅度可达两张卡的高度。
         */
        compensateStackShift(widget, beforeTop, horizontal) {
            this.stackWidgetsByHeight();
            const after = this.readStackTop(widget);
            const shift = after - beforeTop;
            if (!shift) return;
            // transform 里已有的位移要读回来加减，而不是覆盖成 0
            const current = this.readTranslate(widget);
            const next = horizontal
                ? { x: current.x + shift, y: current.y }
                : { x: current.x, y: current.y + shift };
            widget.style.transform = `translate(${next.x}px, ${next.y}px)`;
            // 让 translate 继续跟随指针：起点基准变了，位移的参照也要同步，
            // 否则下一帧又用旧起点算 dy，位置会逐帧漂移。
            if (horizontal) this.dragData.startX += shift;
            else this.dragData.startY += shift;
        }

        readTranslate(widget) {
            const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(widget.style.transform);
            return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
        }

        /** 拖拽结束：按 DOM 顺序重排 order、按落点写 side。
         *  **不落盘**——布局是草稿的一部分，由「保存编辑」统一提交。
         *  早先这里是松手即存，那样点「保存编辑」时只剩书签可存，
         *  且拖坏了布局没有反悔的余地。 */
        commitWidgetDrag(drag) {
            const zone = $('#moduleZone');
            if (!this.modulesConfig) return;

            const { id, widget, targetSide } = drag;
            const widgets = this.modulesConfig.widgets;
            // 配置里还没有这条（首次启用、布局从未保存过）时补一条
            if (!widgets.some(w => w.id === id)) {
                // 新建条目用该模块的默认边（special-line 是 right），不写死 left：
                // 否则第一次在右栏内拖动它时会把 side 记成 left，松手就跳到左栏。
                const def = this.getModule(String(id).split(':')[0]);
                widgets.push({
                    id,
                    enabled: true,
                    side: def && def.defaultSide === 'right' ? 'right' : 'left',
                    order: widgets.length,
                    collapsed: false
                });
            }
            const entry = widgets.find(w => w.id === id);
            if (entry && targetSide) entry.side = targetSide;

            // 顺序取 DOM 当前顺序——拖拽过程中节点位置已经反映了用户的意图。
            // 键同样是 instanceId，否则同一模块的多张卡片会互相写同一个 order。
            //
            // ⚠️ 配置里**没有条目**的卡片必须在这里补条目，不能像早先那样跳过。
            // 未登记的卡片在 applyWidgetLayout 里按 MAX_SAFE_INTEGER 排，永远
            // 落在任何有 order 的卡片**之前**；于是「把一张卡往下拖过一张没
            // 登记过的卡」会在松手那一刻被撤销。用户报的就是这个：「备忘录模块
            // 不能拖拽到最下面一个模块」——浏览器实测：拖到最下时 DOM 顺序已是
            // `本机 > srv461 > srv472 > 备忘录`，松手后弹回第二位（备忘录@3，
            // 两张服务器卡无条目=MAX）。任何新加的服务器都踩同一条，不是备忘录
            // 独有。此前只有**被拖的那张**会补条目（见上方那段），其余永远是 MAX。
            const nodes = zone ? [...zone.querySelectorAll('.module-widget')] : [];
            nodes.forEach((node, index) => {
                const key = node.dataset.instanceId || node.dataset.moduleId;
                let item = widgets.find(w => w.id === key);
                if (!item) {
                    item = {
                        id: key,
                        enabled: true,
                        side: node.dataset.side === 'right' ? 'right' : 'left',
                        order: index,
                        collapsed: false
                    };
                    widgets.push(item);
                }
                item.order = index;
            });

            // 清掉全部拖拽残留：transform、落点高亮、指针状态
            if (zone) {
                delete zone.dataset.dropSide;
                zone.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
            }
            widget.classList.remove('is-dragging');
            widget.style.transform = '';

            // 重排。**必须**在写完 order 之后调：applyWidgetLayout 按
            // modulesConfig.widgets[i].order 排序，而这里正是刚把新顺序写进去。
            // 早先在写之前调，它按旧 order 重排，拖拽结果被自己撤销——
            // 实测拖 NAS 到本机位置，松手又弹回原样。
            this.applyWidgetLayout();
        }

        // 会话状态只存在于 HttpOnly Cookie，JS 读不到内容，
        // 只能问服务端当前是否已登录。
        async loadSession() {
            return API.get('/api/session');
        }

        // 首屏渲染之后再问一次会话。命中则补上私密检索所需的 privacyMode，
        // 整个过程不阻塞首屏。
        //
        // 保留 promise 供检索分支 await：首屏与本次查询之间有一个窗口，
        // 期间 authenticated 仍是 false。此时输入 // 会被当成普通搜索词，
                // 私密书签「凭空消失」，且再输入也不会自愈——所以那个分支必须等结果。
        async restoreSession() {
            const probe = this.sessionProbe = this.loadSession()
                .then(session => {
                    if (session.authenticated) {
                        this.authenticated = true;
                        this.adoptServerTheme();
                        // 记录当前会话是否被信任，管理面板里的开关要反映真实状态
                        this.sessionTrusted = !!session.trusted;
                        this.loadPrivacyMode().then(privacyMode => {
                            if (privacyMode !== null) this.config.privacyMode = privacyMode;
                        });
                        // 模块区同样不占首屏：会话确认后才拉配置、才加载模块文件。
                        // 失败不影响首屏，也不影响上面的私密检索。
                        this.syncModuleVisibility();
                    }
                    return session.authenticated;
                })
                .catch(e => {
                    console.error('Restore session failed:', e);
                    return false;
                });
            return probe;
        }

        // 会话是否已确认。会话查询还没回来时返回 null 表示「尚未确定」，
        // 与 false（确定未登录）区分开。
        async waitForSession() {
            if (this.authenticated) return true;
            if (!this.sessionProbe) return false;
            return this.sessionProbe;
        }

        /**
         * 设置当前会话是否被信任。
         * @param {boolean} trusted true=30 天免重复登录，false=降回 24 小时（不登出）
         * @returns {Promise<boolean>} 是否设置成功
         */
        async setDeviceTrust(trusted) {
            try {
                const res = await API.post('/api/trust-device', { trusted });
                if (res.requiresLogin) {
                    // 服务端没有会话可调整（仅可能发生在仍用明文密码的旧页面上）。
                    // 不静默失败：那会让开关看起来生效了，实际没变。
                    this.showToast('未能设置，请重新登录后再试', 'error');
                    return false;
                }
                if (res.trusted !== undefined) this.sessionTrusted = !!res.trusted;
                return !!res.trusted;
            } catch (e) {
                console.error('Set device trust failed:', e);
                return false;
            }
        }

        async trustDevice() {
            return this.setDeviceTrust(true);
        }

        // 信任此设备开关下方的说明文字。写清「关闭」的实际后果，
        // 避免用户以为关掉就等于退出登录。
        updateTrustDeviceHint() {
            const hint = $('#trustDeviceHint');
            if (!hint) return;
            hint.textContent = this.sessionTrusted
                ? '30 天内免重复登录；关闭后当前会话仍有效，但 24 小时后需重新登录。'
                : '当前设备未被信任，24 小时后需重新登录。';
        }

        // privacyMode 属于管理端设置，不在公开配置视图里。
        // 带会话取回；失败时保持现状。
        async loadPrivacyMode() {
            if (!this.authenticated) return null;
            try {
                const cfg = await API.get('/api/config');
                return typeof cfg.privacyMode === 'boolean' ? cfg.privacyMode : null;
            } catch (e) {
                console.error('Load privacy mode failed:', e);
                return null;
            }
        }

        // 匿名列表只含公开条目。私密检索与管理面板需要全量。
        // 成功后让 this.favorites 指向全量，
        // 使搜索索引与结果取值保持同源。
        async loadAdminFavorites() {
            if (!this.authenticated) return false;
            if (this.adminFavoritesLoading) return false;
            this.adminFavoritesLoading = true;
            try {
                const data = await API.get('/api/favorites');
                this.adminFavorites = data.favorites || [];
                this.favorites = this.adminFavorites;
                return true;
            } catch (e) {
                console.error('Load admin favorites failed:', e);
                return false;
            } finally {
                this.adminFavoritesLoading = false;
            }
        }

        // 管理态下 this.favorites 需要是全量，否则保存会丢掉私密条目
        async ensureAdminFavorites() {
            return this.loadAdminFavorites();
        }

        // 获取当前可搜索的书签列表（仅用于搜索结果过滤，分类树视图不使用此方法）
        getSearchableFavorites() {
            if (this.privacySearchActive && this.adminFavorites) {
                return this.adminFavorites;
            }
            return this.favorites.filter(f => !f.private);
        }

        buildSearchIndex() {
            // 先学习所有分类和标签
            if (typeof Pinyin !== 'undefined') {
                this.favorites.forEach(f => {
                    if (f.category) Pinyin.learnText(f.category);
                    if (f.tags && f.tags.length) Pinyin.learnTexts(f.tags);
                });
            }

            // 构建单个书签的搜索文本
            const buildHay = (f) => {
                let hostname = '';
                try { hostname = new URL(f.url).hostname; } catch {}

                const title = f.title || '';
                const desc = f.description || '';
                const category = f.category || '';
                const tags = (f.tags || []).join(' ');

                let pinyinParts = '';
                if (typeof Pinyin !== 'undefined') {
                    pinyinParts = [
                        Pinyin.buildSearchPinyin(title),
                        Pinyin.buildSearchPinyin(desc),
                        Pinyin.buildSearchPinyin(category),
                        Pinyin.buildSearchPinyin(tags)
                    ].join(' ');
                }

                return `${title} | ${desc} | ${category} | ${hostname} | ${tags} | ${pinyinParts}`;
            };

            // 全量索引
            this.favHaystack = this.favorites.map(buildHay);

            // 非隐私索引（记录原始索引映射）
            this.publicFavIndices = [];
            this.publicFavHaystack = [];
            this.favorites.forEach((f, i) => {
                if (!f.private) {
                    this.publicFavIndices.push(i);
                    this.publicFavHaystack.push(this.favHaystack[i]);
                }
            });

            // 初始化 uFuzzy（宽松模式，适合中英文混合）
            if (typeof uFuzzy !== 'undefined') {
                this.uf = new uFuzzy({
                    intraMode: 1,
                    intraIns: 1,
                    interIns: 3,
                });
            }
        }

        // ========== 版本管理 ==========

        async checkVersionUpdate() {
            try {
                // 获取当前版本信息
                const versionData = await API.get('/api/version');
                this.currentVersion = versionData.version;

                // 获取更新日志
                const changelogData = await API.get('/api/changelog');
                this.changelog = changelogData.versions || [];

                // 检查用户已查看的版本
                const seenVersion = localStorage.getItem('nav-sylph-seen-version');

                // 比较版本号
                if (!seenVersion || this.compareVersions(this.currentVersion, seenVersion) > 0) {
                    this.hasNewVersion = true;
                    this.updateHelpButtonBadge(true);
                }
            } catch (e) {
                console.error('Version check failed:', e);
            }
        }

        compareVersions(v1, v2) {
            const parts1 = v1.split('.').map(Number);
            const parts2 = v2.split('.').map(Number);

            for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
                const p1 = parts1[i] || 0;
                const p2 = parts2[i] || 0;
                if (p1 > p2) return 1;
                if (p1 < p2) return -1;
            }
            return 0;
        }

        updateHelpButtonBadge(show) {
            const helpBtn = $('#helpBtn');
            if (helpBtn) {
                helpBtn.classList.toggle('has-update', show);
            }
        }

        getNewFeatures() {
            if (!this.changelog || this.changelog.length === 0) return null;

            const seenVersion = localStorage.getItem('nav-sylph-seen-version');
            if (!seenVersion) {
                // 首次使用，显示最新版本的亮点
                return this.changelog[0];
            }

            // 收集所有比已查看版本更新的版本
            const newVersions = this.changelog.filter(v =>
                this.compareVersions(v.version, seenVersion) > 0
            );

            if (newVersions.length === 0) return null;

            // 返回最新版本的信息
            return newVersions[0];
        }

        markVersionAsSeen() {
            if (this.currentVersion) {
                localStorage.setItem('nav-sylph-seen-version', this.currentVersion);
                this.hasNewVersion = false;
                this.updateHelpButtonBadge(false);
            }
        }

        isPrivacySearchEnabled() {
            return !!(this.authenticated && this.config.privacyMode);
        }

        isFavSearchTrigger(char) {
            return char === '/' || char === '、';
        }

        // 防抖搜索 - 避免频繁搜索影响性能
        debouncedSearchFavorites(query) {
            if (this.searchDebounceTimer) {
                clearTimeout(this.searchDebounceTimer);
            }
            // 立即显示加载状态（如果查询不为空）
            if (query && this.favorites.length > 100) {
                const dropdown = $('#favDropdown');
                if (dropdown && dropdown.innerHTML.includes('fav-empty')) {
                    // 保持当前内容，不显示loading
                }
            }
            // 50ms 防抖，快速响应同时避免过度计算
            this.searchDebounceTimer = setTimeout(() => {
                this.searchFavorites(query);
            }, 50);
        }

        // 左侧按钮有三种身份：网页 / 书签 / 退出（分享态）。
        // 三个状态都要切换它，所以文案集中在这里，各模式只决定自己那个
        // 标签的显隐。绝不能写 textContent —— 那会把 span 子节点整个删掉，
        // 此后本方法再也找不到它们，切换分享态时就会抛错。
        showModeLabel(mode) {
            const modeBtn = $('#modeBtn');
            for (const label of modeBtn.querySelectorAll('.mode-label')) {
                label.hidden = label.dataset.label !== mode;
            }
        }

        toggleFavSearchMode(enabled) {
            const form = $('#searchForm');
            const input = $('#searchInput');
            const searchBtn = $('.search-btn');

            form.classList.toggle('fav-search-mode', enabled);
            const modeBtn = $('#modeBtn');
            this.showModeLabel(enabled ? 'fav' : 'web');
            modeBtn.setAttribute('aria-pressed', String(enabled));
            modeBtn.setAttribute('aria-label', `切换搜索模式，当前为${enabled ? '书签' : '网页'}`);

            if (enabled) {
                input.placeholder = '搜索书签...';
                $('#engineBtn').style.display = 'none';
                $('#engineDropdown').hidden = true;
                $('#engineBtn').setAttribute('aria-expanded', 'false');
                searchBtn.textContent = '打开';
                searchBtn.title = '书签检索';
                this.showFavDropdown();
            } else {
                input.placeholder = '搜索网页或书签';
                $('#engineBtn').style.display = '';
                searchBtn.textContent = '搜索';
                searchBtn.title = '搜索';
                this.hideFavDropdown();
            }
        }

        showFavDropdown() {
            let dropdown = $('#favDropdown');
            if (!dropdown) {
                dropdown = html('<div class="fav-dropdown" id="favDropdown"></div>');
                $('.search-wrapper').appendChild(dropdown);
            }
            dropdown.hidden = false;
            this.favSelectedIdx = 0;

            if (this.favoritesLoading) {
                dropdown.innerHTML = '<div class="fav-empty">书签加载中...</div>';
                return;
            }

            // 根据隐私模式过滤显示
            const favs = this.getSearchableFavorites();
            this.renderFavResults(favs.slice(0, 10), null, null);
        }

        hideFavDropdown() {
            const dropdown = $('#favDropdown');
            if (dropdown) {
                dropdown.hidden = true;
            }
        }

        searchFavorites(query) {
            const dropdown = $('#favDropdown');
            if (!dropdown) return;

            const isPrivacyMode = this.privacySearchActive;
            const favList = this.getSearchableFavorites();

            // 如果没有书签，显示提示
            if (favList.length === 0) {
                dropdown.innerHTML = `<div class="fav-empty">${this.favoritesLoading ? '书签加载中...' : this.favoritesLoadError ? '书签加载失败，请刷新页面' : '无书签，请在管理面板中导入'}</div>`;
                return;
            }

            if (!query) {
                this.renderFavResults(favList.slice(0, 10), null, null, null);
                return;
            }

            // 选择对应的 haystack
            const haystack = isPrivacyMode ? this.favHaystack : this.publicFavHaystack;
            const indexMap = isPrivacyMode ? null : this.publicFavIndices;

            // 如果 uFuzzy 未初始化，使用简单匹配
            if (!this.uf) {
                const q = query.toLowerCase();
                const filtered = favList.filter(f =>
                    f.title.toLowerCase().includes(q) ||
                    (f.description || '').toLowerCase().includes(q) ||
                    (f.category || '').toLowerCase().includes(q) ||
                    f.url.toLowerCase().includes(q)
                ).slice(0, 15);
                this.renderFavResults(filtered, null, null, null);
                return;
            }

            // uFuzzy 搜索
            const idxs = this.uf.filter(haystack, query);

            if (!idxs || idxs.length === 0) {
                dropdown.innerHTML = '<div class="fav-empty">无匹配结果</div>';
                return;
            }

            const info = this.uf.info(idxs, haystack, query);
            const order = this.uf.sort(info, haystack, query);

            // 取前 15 个结果，映射回 this.favorites 的索引
            const topOrder = order.slice(0, 15);
            const results = topOrder.map(i => {
                const haystackIdx = idxs[i];
                const favIdx = indexMap ? indexMap[haystackIdx] : haystackIdx;
                return this.favorites[favIdx];
            });

            this.renderFavResults(results, info, topOrder, idxs);
        }

        renderFavResults(favs, info, order, idxs) {
            const dropdown = $('#favDropdown');
            if (!dropdown) return;

            if (favs.length === 0) {
                dropdown.innerHTML = '<div class="fav-empty">无书签，请在管理面板中导入</div>';
                return;
            }

            this.favSelectedIdx = 0;

            dropdown.innerHTML = favs.map((fav, i) => {
                let titleHtml = this.esc(fav.title);

                // 如果有匹配信息，高亮标题
                if (info && order && idxs) {
                    const infoIdx = order[i];
                    const ranges = info.ranges[infoIdx];
                    if (ranges && ranges.length > 0) {
                        titleHtml = this.highlightText(fav.title, ranges);
                    }
                }

                let hostname = '';
                try { hostname = new URL(fav.url).hostname; } catch {}

                return `
                    <a class="fav-item${i === 0 ? ' selected' : ''}" href="${this.esc(fav.url)}" target="_blank" rel="noopener" data-idx="${i}">
                        <div class="fav-info">
                            <div class="fav-title">${fav.private ? '<span class="fav-private-label">私密</span> ' : ''}${titleHtml}</div>
                            <div class="fav-meta">
                                ${fav.category ? `<span class="fav-category">${this.esc(fav.category)}</span>` : ''}
                                <span class="fav-host">${this.esc(hostname)}</span>
                            </div>
                        </div>
                    </a>
                `;
            }).join('');
        }

        highlightText(text, ranges) {
            if (!ranges || ranges.length === 0) return this.esc(text);

            // ranges 是匹配字符的位置数组
            // 只取标题长度内的位置
            const titleLen = text.length;
            const validRanges = ranges.filter(r => r < titleLen);
            if (validRanges.length === 0) return this.esc(text);

            // 合并连续位置为区间
            const intervals = [];
            let start = validRanges[0], end = validRanges[0];

            for (let i = 1; i < validRanges.length; i++) {
                if (validRanges[i] === end + 1) {
                    end = validRanges[i];
                } else {
                    intervals.push([start, end]);
                    start = end = validRanges[i];
                }
            }
            intervals.push([start, end]);

            // 构建高亮文本
            let result = '';
            let lastEnd = 0;

            for (const [s, e] of intervals) {
                if (s > lastEnd) {
                    result += this.esc(text.slice(lastEnd, s));
                }
                result += `<mark>${this.esc(text.slice(s, e + 1))}</mark>`;
                lastEnd = e + 1;
            }

            if (lastEnd < text.length) {
                result += this.esc(text.slice(lastEnd));
            }

            return result;
        }

        handleFavKeydown(e) {
            const dropdown = $('#favDropdown');
            if (!dropdown || dropdown.hidden) return false;

            const items = $$('.fav-item', dropdown);
            if (items.length === 0) return false;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.favSelectedIdx = Math.min(this.favSelectedIdx + 1, items.length - 1);
                this.updateFavSelection(items);
                return true;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.favSelectedIdx = Math.max(this.favSelectedIdx - 1, 0);
                this.updateFavSelection(items);
                return true;
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const selected = items[this.favSelectedIdx];
                if (selected) {
                    window.open(selected.href, '_blank');
                    $('#searchInput').value = '';
                    this.favSearchMode = false;
                    this.toggleFavSearchMode(false);
                }
                return true;
            } else if (e.key === 'Escape') {
                $('#searchInput').value = '';
                this.favSearchMode = false;
                this.toggleFavSearchMode(false);
                return true;
            }

            return false;
        }

        updateFavSelection(items) {
            items.forEach((item, i) => {
                item.classList.toggle('selected', i === this.favSelectedIdx);
            });
            // 滚动到可见区域
            items[this.favSelectedIdx]?.scrollIntoView({ block: 'nearest' });
        }

        // ========== Paste 分享功能 ==========

        // 检查是否为分享模式触发字符
        isPasteTrigger(char) {
            return char === '>' || char === '》';
        }

        // 接收 input 元素；也兼容直接传入事件对象
        handleSearchInput(e) {
            const value = (e.target ?? e).value;

            // 检查书签检索模式（/ 或 //）
            const isFavMode = value.length > 0 && this.isFavSearchTrigger(value[0]);

            // 检测是否为隐私模式触发（//）
            const isPrivacyTrigger = isFavMode && value.length >= 2 && this.isFavSearchTrigger(value[1]);

            // 首屏与 /api/session 返回之间存在一个窗口，期间 authenticated 仍是 false，
            // 若此时判定「// 未生效」，它会被永久当成普通搜索词，私密书签再也回不来。
            // 窗口内改为等会话结果出来再判定；已确定的状态不额外等待。
            if (isPrivacyTrigger && !this.authenticated && this.sessionProbe) {
                e.preventDefault?.();
                this.waitForSession().then(() => this.handleSearchInput(e));
                return;
            }

            if (isFavMode && this.pasteMode) {
                this.pasteMode = false;
                this.togglePasteMode(false);
            }

            if (isFavMode !== this.favSearchMode) {
                this.favSearchMode = isFavMode;
                this.privacySearchActive = isPrivacyTrigger && this.isPrivacySearchEnabled();
                this.toggleFavSearchMode(isFavMode);
            } else if (isFavMode) {
                // 模式已激活，但需要更新隐私状态（如从 / 变为 //）
                const newPrivacyState = isPrivacyTrigger && this.isPrivacySearchEnabled();
                if (newPrivacyState !== this.privacySearchActive) {
                    this.privacySearchActive = newPrivacyState;
                }
            }

            // 匿名列表不含私密条目，私密检索需要按需取回全量
            if (this.privacySearchActive && !this.adminFavorites && !this.adminFavoritesLoading) {
                this.loadAdminFavorites().then(loaded => {
                    if (!loaded) return;
                    this.buildSearchIndex();
                    const current = $('#searchInput').value;
                    const len = this.isFavSearchTrigger(current[0]) && this.isFavSearchTrigger(current[1]) ? 2 : 1;
                    this.searchFavorites(current.slice(len).trim());
                });
            }

            // 如果在书签检索模式，执行防抖搜索
            if (this.favSearchMode) {
                const favoritesDropdown = $('#favDropdown');
                if (favoritesDropdown?.hidden) favoritesDropdown.hidden = false;
                // 隐私模式下跳过第二个 /
                const sliceLen = (isPrivacyTrigger) ? 2 : 1;
                const query = value.slice(sliceLen).trim();
                this.debouncedSearchFavorites(query);
                return;
            }

            // 原有的 Paste 模式检测
            const isPasteMode = value.length > 0 && this.isPasteTrigger(value[0]);

            if (isPasteMode !== this.pasteMode) {
                this.pasteMode = isPasteMode;
                this.togglePasteMode(isPasteMode);
            }
        }

        // 退出分享态：清标志、收起编辑器、清空草稿、还焦点。
        // 「退出」按钮与 Esc 两条路径共用，复位逻辑只此一处。
        exitPasteMode() {
            const input = $('#searchInput');
            this.pasteMode = false;
            this.togglePasteMode(false);
            input.value = '';
            this.handleSearchInput(input);
            input.focus();
        }

        // textarea 只写 min-height 时高度会锁死，需按内容撑开。
        // 用户手动拖拽过的框不再自动跟随，否则会把刚拖出来的大小冲掉。
        autoGrowPasteInput() {
            const input = $('#searchInput');
            if (!this.pasteMode || this.pasteUserResized) return;
            // 先归零再量，否则上一次的 inline height 会成为新的测量基准
            input.style.height = 'auto';
            // clamp 到 CSS 的 max-height，避免把一个永远不生效的大值留在
            // inline 样式里（max-height:none 时 computed 会返回 "none"）
            const declared = parseFloat(getComputedStyle(input).maxHeight);
            const max = Number.isFinite(declared) ? declared : Infinity;
            input.style.height = `${Math.min(input.scrollHeight, max)}px`;
        }

        togglePasteMode(enabled) {
            const form = $('#searchForm');
            const input = $('#searchInput');
            const searchBtn = $('.search-btn');
            const engineBtn = $('#engineBtn');

            form.classList.toggle('paste-mode', enabled);

            // 搜索引擎按钮的显隐交给 CSS（.search.paste-mode #engineBtn），
            // 不用内联 display，否则无法参与过渡且会盖过样式表
            const dropdown = $('#engineDropdown');
            dropdown.hidden = true;
            engineBtn.setAttribute('aria-expanded', 'false');

            // 左侧按钮在分享态下变为「退出」，与书签模式共用同一套标签切换
            const modeBtn = $('#modeBtn');
            this.showModeLabel(enabled ? 'exit' : 'web');
            modeBtn.setAttribute('aria-label', enabled ? '退出文本分享' : '切换搜索模式，当前为网页');

            if (enabled) {
                input.placeholder = '输入要分享的文本，回车发送，Shift+回车换行...';
                // aria-label 优先于 placeholder 播报，不同步的话读屏用户会
                // 听到「搜索网页或书签」却在里面写分享文本
                input.setAttribute('aria-label', '要分享的文本');
                // 重置上次拖拽留下的大小，否则会以旧高度进入
                input.style.height = '';
                this.pasteUserResized = false;
                searchBtn.textContent = '发送';
                searchBtn.title = '发送分享';
            } else {
                input.placeholder = '搜索网页或书签';
                input.setAttribute('aria-label', '搜索网页或书签');
                input.style.height = '';
                this.pasteUserResized = false;
                searchBtn.textContent = '搜索';
                searchBtn.title = '搜索';
            }
        }

        async handleSearch() {
            const value = $('#searchInput').value;

            // 书签检索模式：回车打开选中结果
            if (value.length > 0 && this.isFavSearchTrigger(value[0])) {
                const selected = $('.fav-item.selected');
                if (selected) {
                    window.open(selected.href, '_blank');
                    $('#searchInput').value = '';
                    this.favSearchMode = false;
                    this.toggleFavSearchMode(false);
                }
                return;
            }

            if (value.length > 0 && this.isPasteTrigger(value[0])) {
                const text = value.slice(1).trim();

                if (!text) return;

                // 直接作为分享内容
                await this.showPasteOptions(text);
                return;
            }

            // 正常搜索
            this.search();
        }

        async showPasteOptions(content) {
            const PASTE_TTL_LABELS = { 5: '5 分钟', 30: '30 分钟', 1440: '1 天', 10080: '7 天' };

            const result = await this.showUiDialog({
                title: '分享保护',
                options: [
                    { kind: 'checkbox', name: 'pin', value: 'on', label: '设置 PIN 码保护', hint: '接收方需输入 PIN 才能查看内容', reveal: true }
                ],
                // 四档有效期排成 2×2：单行「30 分钟」不折行，触摸目标也够大
                groups: [
                    {
                        label: '有效期',
                        options: Object.entries(PASTE_TTL_LABELS).map(([minutes, label], index) => ({
                            kind: 'radio',
                            name: 'ttl',
                            value: minutes,
                            label,
                            checked: index === 0
                        }))
                    }
                ],
                confirmText: '分享',
                closeOnBackdrop: false,
                reveal: { label: '4 位数字 PIN 码', maxlength: 4 },
                validate: (values, choices) => choices.pin && !/^\d{4}$/.test(values[0] || '') ? 'PIN 码必须是 4 位数字' : ''
            });

            // 取消或遮罩关闭：返回 null，不创建分享
            if (!result) return;

            const usePin = !!result.choices.pin;
            const pin = usePin ? result.values[0] : null;
            const ttlMinutes = PASTE_TTL_LABELS[result.choices.ttl] ? Number(result.choices.ttl) : 5;

            // 默认档位不传额外参数，保持既有 createPaste 两参数契约
            if (!pin && ttlMinutes === 5) {
                await this.createPaste(content, null);
            } else {
                await this.createPaste(content, pin, { ttlMinutes });
            }
        }

        async createPaste(content, pin = null, options = {}) {
            try {
                // 先请求生成分享码
                const codeRes = await fetch('/api/p/code', { method: 'POST' });
                const codeData = await codeRes.json();

                if (!codeData.code) {
                    this.showToast(codeData.error || '创建分享失败', 'error');
                    return;
                }

                const code = codeData.code;

                // 使用分享码进行端到端加密
                const encryptedContent = await Crypto.encrypt(content, code);

                const body = { code, content: encryptedContent };
                if (pin) body.pin = pin;
                if (options.ttlMinutes) body.ttl = options.ttlMinutes;

                const res = await fetch('/api/p', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();

                if (data.success) {
                    $('#searchInput').value = '';
                    this.pasteMode = false;
                    this.togglePasteMode(false);
                    this.showPasteResult(code, !!pin, data.expiresAt);
                } else {
                    this.showToast(data.error || '创建分享失败', 'error');
                }
            } catch (e) {
                this.showToast('创建分享失败: ' + e.message, 'error');
            }
        }

        showPasteResult(code, hasPin = false, expiresAt = null) {
            this.hidePasteResult();

            const url = `${location.origin}/p/${code}`;
            const pinInfo = hasPin ? '<div class="paste-pin-info">已设置 PIN 保护</div>' : '';
            const result = html(`
                <div class="paste-result" id="pasteResult">
                    <button class="paste-close" type="button" aria-label="关闭分享结果">×</button>
                    <div class="paste-code">${this.esc(code)}</div>
                    ${pinInfo}
                    <div class="paste-qr"><img alt="分享链接二维码"></div>
                    <button class="paste-link" type="button" data-url="${this.esc(url)}">复制链接</button>
                    <div class="paste-expiry">${this.esc(this.pasteExpiryText(expiresAt))}</div>
                </div>
            `);

            result.querySelector('.paste-close').onclick = () => this.hidePasteResult();

            // 二维码：使用本地图库生成 data URL，失败时静默隐藏，不影响复制链接。
            // qrcode.js 经 loadScript 按需加载，加载完成后再生成，
            // 不阻塞分享结果的展示。
            const qrImg = result.querySelector('.paste-qr img');
            this.loadScript('lib/qrcode.js')
                .then(() => {
                    try {
                        const qr = qrcode(0, 'M');
                        qr.addData(url);
                        qr.make();
                        qrImg.src = qr.createDataURL(6, 2);
                    } catch {
                        qrImg.closest('.paste-qr')?.remove();
                    }
                })
                .catch(() => {
                    qrImg.closest('.paste-qr')?.remove();
                });

            result.querySelector('.paste-link').onclick = async (e) => {
                const link = e.target;
                const copyUrl = link.dataset.url;
                try {
                    await navigator.clipboard.writeText(copyUrl);
                    link.textContent = '已复制';
                    setTimeout(() => { link.textContent = '复制链接'; }, 2000);
                } catch {
                    await this.promptValue('复制链接', '分享链接', { value: copyUrl, readonly: true, confirmText: '关闭' });
                }
            };

            $('#searchForm').after(result);
        }

        pasteExpiryText(expiresAt) {
            if (!expiresAt) return '5分钟后过期';
            const minutes = Math.round((expiresAt - Date.now()) / 60000);
            if (minutes <= 0) return '已过期';
            if (minutes < 60) return `${minutes}分钟后过期`;
            if (minutes < 1440) return `${Math.round(minutes / 60)}小时后过期`;
            return `${Math.round(minutes / 1440)}天后过期`;
        }

        hidePasteResult() {
            const existing = $('#pasteResult');
            if (existing) existing.remove();
        }

        showHelp() {
            const returnFocus = document.activeElement;
            const versionStr = this.currentVersion ? ` v${this.currentVersion}` : '';
            const newFeatures = this.getNewFeatures();

            let newFeaturesHtml = '';
            if (this.hasNewVersion && newFeatures) {
                const updateSummary = newFeatures.summary || newFeatures.highlights?.[0] || '';
                if (updateSummary) {
                    newFeaturesHtml = `
                        <div class="help-new-features">
                            <div class="help-new-features-header">更新说明</div>
                            <p class="help-new-features-summary">${this.esc(updateSummary)}</p>
                        </div>
                    `;
                }
            }

            const helpHtml = `
                <div class="help-overlay" id="helpOverlay" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
                    <div class="help-content">
                        <button class="help-close" type="button">关闭</button>
                        <h3 id="helpTitle">Nav Sylph${versionStr}</h3>
                        ${newFeaturesHtml}
                        <div class="help-section">
                            <strong>书签检索</strong>
                            <p>点击“网页”切换到书签，或输入 <code>/</code> + 关键词</p>
                            <p class="help-tip">支持标题、网址、分类、描述模糊匹配</p>
                            <p class="help-tip">↑↓ 选择，Enter 打开，Esc 退出</p>
                        </div>
                        <div class="help-section">
                            <strong>跨设备文本分享</strong>
                            <p>搜索框输入 <code>></code> + 内容，回车发送</p>
                            <p class="help-tip">端到端加密 · 有效期可选 · 阅后即删</p>
                            <p class="help-tip"><code>Shift</code>+回车换行，可拖拽右下来调高编辑区</p>
                            <p class="help-tip">点「退出」或按 <code>Esc</code> 返回搜索</p>
                        </div>
                        <div class="help-section">
                            <strong>管理书签</strong>
                            <p>点击右下角“管理”进入管理面板</p>
                            <p class="help-tip">支持导入/导出浏览器书签</p>
                            <p class="help-tip">兼容 Chrome、Edge、Firefox、Safari</p>
                        </div>
                    </div>
                </div>
            `;
            const overlay = html(helpHtml);
            const closeHelp = () => {
                overlay.remove();
                this.markVersionAsSeen();
                if (returnFocus?.isConnected) returnFocus.focus();
            };
            overlay.onclick = (e) => {
                if (e.target === overlay || e.target.classList.contains('help-close')) {
                    closeHelp();
                }
            };
            overlay.onkeydown = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeHelp();
                } else if (e.key === 'Tab') {
                    const focusables = [...overlay.querySelectorAll('button, a[href]')];
                    const first = focusables[0], last = focusables.at(-1);
                    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                }
            };
            document.body.appendChild(overlay);
            overlay.querySelector('.help-close').focus();
        }

        async openAdmin() {
            this.adminReturnFocus = document.activeElement;
            if (!this.authenticated) {
                // 一次对话框同时收密码与「信任此设备」，不额外弹第二个窗。
                // 勾选框走 options（kind: 'checkbox'）而不是 fields：
                // fields 的取值恒为字符串，options 才会给出真正的布尔值。
                const values = await this.showUiDialog({
                    title: '进入管理',
                    fields: [{ label: '管理密码', type: 'password' }],
                    options: [{
                        name: 'trustDevice',
                        kind: 'checkbox',
                        value: '1',
                        label: '信任此设备（30 天内免重复登录）',
                        hint: '不勾选则本次登录 24 小时后自动退出'
                    }]
                });
                if (!values) return;
                const pwd = values.values[0];
                if (!pwd) return;
                // 密码只在这一请求里出现一次，服务端校验通过后改用 HttpOnly Cookie。
                const res = await API.request('/api/verify-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Admin-Password': pwd },
                    body: '{}'
                });
                if (!res.data || !res.data.valid) {
                    // 必须区分「密码错误」与「已被暂时锁定」：本项目没有解锁入口，
                    // 若两者都提示「密码错误」，你只会反复输，从而把锁定越推越深。
                    if (res.data && res.data.code === 'locked') {
                        await this.notice('登录已暂时锁定', res.data.error || '密码错误次数过多，请稍后再试');
                        return;
                    }
                    if (res.data && res.data.code === 'global_limited') {
                        await this.notice('登录请求过于频繁', res.data.error || '请稍后再试');
                        return;
                    }
                    await this.notice('密码错误', '无法进入管理');
                    return;
                }
                this.authenticated = true;
                this.adoptServerTheme();
                // 重新登录后必须复位这个标志，否则本轮会话再遇到环境变化时
                // 提示会被静默吞掉——用户只看到自己被登出，却没有任何说明。
                API.envChangeNotified = false;
                // 会话已换，之前那份可信状态不再作数
                this.sessionTrusted = false;
                // 模块区与布局按钮是登录态的产物。这条路径与 restoreSession 无关
                // （首屏探测早已判定未登录），漏掉它会出现「密码正确、已登录，
                // 但首页模块区仍是空的且布局按钮不出现」。
                this.syncModuleVisibility();

                // 勾选「信任此设备」才把会话升级为 30 天
                if (values.choices.trustDevice) {
                    this.sessionTrusted = await this.trustDevice();
                } else {
                    this.sessionTrusted = false;
                }

                // 检测是否为默认密码，提示修改
                if (pwd === 'admin123') {
                    const shouldChange = await this.confirmAction('您正在使用默认密码，建议立即修改。', '修改默认密码');
                    if (shouldChange) {
                        this.beginConfigEdit();
                        this.renderAdminPanel();
                        $('#modal').hidden = false;
                        setTimeout(() => this.changePassword(), 100);
                        return;
                    }
                }
            }
            this.beginConfigEdit();
            // 两个请求互不依赖，仍并发发出。会话 Cookie 命中时服务端不再跑
            // bcrypt，但两个请求的串行等待仍是两倍往返。
            const [, privacyMode] = await Promise.all([
                // 收藏管理器需要全量列表，否则保存会丢掉私密条目
                this.ensureAdminFavorites(),
                // privacyMode 不在公开配置视图里，这里取回真实值
                this.loadPrivacyMode()
            ]);
            if (privacyMode !== null) this.config.privacyMode = privacyMode;
            this.renderAdminPanel();
            $('#modal').hidden = false;
            $('#cancelBtn').focus();
        }

        beginConfigEdit() {
            this.configSnapshot = JSON.stringify(this.config);
            this.configDirty = false;
            this.updateConfigStatus();
        }

        markConfigDirty() {
            this.configDirty = JSON.stringify(this.config) !== this.configSnapshot;
            this.updateConfigStatus();
        }

        updateConfigStatus(message = null, state = '') {
            const status = $('#configSaveStatus');
            if (!status) return;
            status.textContent = message || (this.configDirty ? '有未保存的修改' : '修改后点击保存');
            status.dataset.state = state || (this.configDirty ? 'pending' : '');
        }

        // duration 可选，默认 3500ms。环境变化自动登出需要阅读时间，传 8000。
        showToast(message, state = 'success', duration = 3500) {
            const toast = $('#toast');
            if (!toast) return;
            clearTimeout(this.toastTimer);
            toast.textContent = message;
            toast.dataset.state = state;
            toast.hidden = false;
            this.toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
        }

        showUiDialog({ title, message = '', fields = [], options = [], groups = [], reveal = null, confirmText = '确定', cancelText = '取消', danger = false, notice = false, closeOnBackdrop = true, validate }) {
            const previousFocus = document.activeElement;
            // 分组内的选项同样计入取值与焦点流转，否则 choices.ttl 会永远读不到。
            // 顺序必须与模板渲染顺序一致（options 先、groups 后），allOptions 依赖这一点。
            const allOptions = [...options, ...groups.flatMap(group => group.options)];
            const revealOption = allOptions.find(option => option.reveal) ? reveal : null;
            // 平铺选项与分组内的选项是同一份标记，两处各自维护一份模板必然漂移
            const renderOption = option => `<div class="ui-dialog-option" data-kind="${this.esc(option.kind)}" data-name="${this.esc(option.name)}">
                <label class="ui-dialog-choice">
                    <input type="${option.kind === 'checkbox' ? 'checkbox' : 'radio'}" name="opt_${this.esc(option.name)}" value="${this.esc(option.value)}" ${option.checked ? 'checked' : ''}>
                    <span>${this.esc(option.label)}</span>
                </label>
                ${option.hint ? `<p class="ui-dialog-hint">${this.esc(option.hint)}</p>` : ''}
            </div>`;
            const overlay = html(`
                <div class="ui-dialog-overlay">
                    <div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="uiDialogTitle">
                        <h3 id="uiDialogTitle">${this.esc(title)}</h3>
                        ${message ? `<p class="ui-dialog-message">${this.esc(message)}</p>` : ''}
                        <form class="ui-dialog-form">
                            ${fields.map((field, index) => `<label class="ui-dialog-field">
                                <span>${this.esc(field.label)}</span>
                                <input name="field${index}" type="${field.type === 'password' ? 'password' : 'text'}" value="${this.esc(field.value || '')}" placeholder="${this.esc(field.placeholder || '')}" ${field.readonly ? 'readonly' : ''} autocomplete="off">
                            </label>`).join('')}
                            ${options.length ? `<div class="ui-dialog-options is-plain">
                                ${options.map(renderOption).join('')}
                            </div>` : ''}
                            ${revealOption ? `<div class="ui-dialog-reveal" hidden>
                                <label class="ui-dialog-field">
                                    <span>${this.esc(revealOption.label)}</span>
                                    <input name="revealField" type="password" inputmode="numeric" maxlength="${this.esc(revealOption.maxlength || '')}" placeholder="••••" autocomplete="off">
                                </label>
                            </div>` : ''}
                            ${groups.map(group => `<div class="ui-dialog-group">
                                <p class="ui-dialog-group-label">${this.esc(group.label)}</p>
                                <div class="ui-dialog-options">
                                    ${group.options.map(renderOption).join('')}
                                </div>
                            </div>`).join('')}
                            <div class="ui-dialog-error" role="alert"></div>
                            <div class="ui-dialog-actions">
                                ${notice ? '' : `<button class="btn" type="button" data-action="cancel">${this.esc(cancelText)}</button>`}
                                <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit">${this.esc(confirmText)}</button>
                            </div>
                        </form>
                    </div>
                </div>
            `);
            document.body.appendChild(overlay);
            const dialog = overlay.querySelector('.ui-dialog');
            const form = overlay.querySelector('form');
            const fieldInputs = [...overlay.querySelectorAll('input[name^="field"], .ui-dialog-reveal input')];
            const optionInputs = [...overlay.querySelectorAll('.ui-dialog-option input')];
            const focusables = [...overlay.querySelectorAll('input, button')];
            (fieldInputs[0] || optionInputs[0] || focusables.at(-1)).focus();

            // 复选框可展开同弹窗内的附加区域（如 PIN 输入框）
            const revealBox = overlay.querySelector('.ui-dialog-reveal');
            if (revealBox) {
                const owner = optionInputs[allOptions.findIndex(option => option.reveal)];
                const syncReveal = () => {
                    revealBox.hidden = !owner?.checked;
                    // 展开时把焦点交给 PIN 输入框，收起时交还复选框
                    if (owner?.checked) revealBox.querySelector('input')?.focus();
                };
                owner?.addEventListener('change', syncReveal);
                revealBox.hidden = !owner?.checked;
            }

            return new Promise(resolve => {
                const close = value => {
                    overlay.remove();
                    if (previousFocus?.isConnected) previousFocus.focus();
                    resolve(value);
                };
                overlay.addEventListener('click', event => {
                    if ((closeOnBackdrop && event.target === overlay) || event.target.closest('[data-action="cancel"]')) close(null);
                });
                dialog.addEventListener('keydown', event => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        close(null);
                    } else if (event.key === 'Tab') {
                        const first = focusables[0];
                        const last = focusables.at(-1);
                        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
                    }
                });
                form.addEventListener('submit', event => {
                    event.preventDefault();
                    const values = fieldInputs.map(input => input.value);
                    const choices = Object.create(null);
                    optionInputs.forEach(input => {
                        if (input.type === 'radio') { if (input.checked) choices[input.closest('.ui-dialog-option').dataset.name] = input.value; }
                        else choices[input.closest('.ui-dialog-option').dataset.name] = input.checked;
                    });
                    const payload = { values, choices };
                    const error = validate?.(values, choices);
                    if (error) {
                        overlay.querySelector('.ui-dialog-error').textContent = error;
                        (fieldInputs[0] || optionInputs[0] || form.querySelector('button[type="submit"]')).focus();
                        return;
                    }
                    close(allOptions.length || fields.length ? payload : true);
                });
            });
        }

        async confirmAction(message, title = '确认操作', danger = false) {
            return !!(await this.showUiDialog({ title, message, danger, confirmText: danger ? '确认删除' : '确定' }));
        }

        async promptValue(title, label, options = {}) {
            const result = await this.showUiDialog({ title, fields: [{ label, ...options }], confirmText: options.confirmText || '确定', validate: options.validate });
            return result ? result.values[0] : null;
        }

        async notice(message, title = '提示') {
            await this.showUiDialog({ title, message, notice: true, confirmText: '知道了' });
        }

        mountLayer(overlay) {
            overlay.returnFocus = document.activeElement;
            const panel = overlay.querySelector('.fav-dialog');
            const heading = panel.querySelector('h3');
            heading.id = `${overlay.id}Title`;
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');
            panel.setAttribute('aria-labelledby', heading.id);
            document.body.appendChild(overlay);
            (panel.querySelector('input:not([type="hidden"]), button') || panel).focus();
            overlay.addEventListener('click', event => {
                if (event.target === overlay) this.closeLayer(overlay);
            });
            panel.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.closeLayer(overlay);
                } else if (event.key === 'Tab') {
                    const focusables = [...panel.querySelectorAll('input:not([type="hidden"]), select, textarea, button')].filter(el => !el.disabled);
                    const first = focusables[0], last = focusables.at(-1);
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
                }
            });
        }

        closeLayer(overlay) {
            overlay.remove();
            if (overlay.returnFocus?.isConnected) overlay.returnFocus.focus();
        }

        async closeAdmin(force = false) {
            if (this.configSaving && !force) return false;
            if (this.configDirty) {
                if (!force && !await this.confirmAction('有未保存的修改，确定放弃吗？', '放弃修改')) return false;
                this.config = JSON.parse(this.configSnapshot);
                this.applyTheme();
                this.render();
            }
            this.configDirty = false;
            this.configSnapshot = null;
            this.updateConfigStatus();
            // 面板关了，未就绪机器的探测轮询也该停：用户看不到结果，
            // 继续探只是白花限流配额，而定时器留着会一直跑到页面卸载。
            this.clearPendingProbe();
            $('#modal').hidden = true;
            if (this.adminReturnFocus?.isConnected) this.adminReturnFocus.focus();
            return true;
        }

        /**
         * 管理面板的分区导航。宽屏是左侧竖排侧栏，≤899px 是顶部横滑标签条——
         * 同一套 DOM 与状态，只由 CSS 改变呈现方式。
         *
         * 键盘按 WAI-ARIA tabs 模式：←/→ 在标签间移动，Home/End 跳首尾。
         * 未选中的 tab 用 tabindex="-1"，使 Tab 键一次只落在当前分区上。
         */
        bindAdminTabs() {
            const tabs = $$('.admin-tab');
            if (!tabs.length) return;

            const select = tab => this.selectAdminTab(tab.dataset.panel);
            for (const tab of tabs) tab.addEventListener('click', () => select(tab));

            const list = $('.admin-tabs');
            list.addEventListener('keydown', event => {
                const current = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
                if (current < 0) return;
                let next = null;
                if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
                else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = tabs.length - 1;
                if (next === null) return;
                event.preventDefault();
                select(tabs[next]);
                tabs[next].focus();
            });
        }

        /**
         * 切到某个分区。模块分区首次进入时才拉 /api/modules/config——
         * 每次 renderAdminPanel 都预取会累积撞上匿名读限流
         * （WebDAV 分区已经因为这个原因 429 过）。
         */
        selectAdminTab(panel) {
            // 记住当前分区，供下次 renderAdminPanel 恢复
            this.adminTab = panel;
            const tabs = $$('.admin-tab');
            for (const tab of tabs) {
                const active = tab.dataset.panel === panel;
                tab.setAttribute('aria-selected', String(active));
                tab.tabIndex = active ? 0 : -1;
                tab.classList.toggle('is-active', active);
            }
            for (const el of $$('.admin-panel')) {
                el.hidden = el.id !== `adminPanel${panel[0].toUpperCase()}${panel.slice(1)}`;
            }
            // 判据是「编辑器是否已渲染」，不是「配置是否已加载」：
            // 首页模块区早就拉过 modulesConfig，用它当条件会让本分区永远停在
            // 「加载中...」——面板 DOM 是新的，而配置已在内存里，于是什么都不做。
            if (panel === 'modules' && !this.modulesEditorRendered) {
                this.renderModulesEditor();
            }
            // 「收藏夹」同理：管理器只在首次进入分区时渲染，
            // 之后切走切回保留现场（当前分类、搜索词、勾选都在）。
            if (panel === 'fav' && !this.favManagerRendered) {
                this.renderFavManager();
                this.favManagerRendered = true;
            }
        }

        /** 模块分区的配置界面。加载失败必须显式落到容器里，不留「加载中...」。 */
        async renderModulesEditor() {
            const host = $('#modulesEditor');
            if (!host) return;
            this.modulesEditorRendered = false;
            host.innerHTML = '<div class="webdav-loading">加载中...</div>';
            const config = await this.loadModulesConfig();
            if (!config) {
                // 失败也要 render：静默失败过一次（WebDAV 分区的 429）
                host.innerHTML = '<p class="fav-hint">模块配置加载失败，请关闭面板后重试。</p>';
                return;
            }
            // 配置就绪不等于模块脚本已加载：首次进入时两者都不是，
            // 开关列表需要一个已注册的定义才能取标题。
            await this.ensureModulesLoaded();
            this.renderModulesEditorContent(host, config);
            this.modulesEditorRendered = true;
            // 未就绪的机器要持续探测：用户把部署命令粘到目标机上执行完，
            // 那一刻本服务什么都不知道——不主动探，界面就永远停在「未部署」，
            // 用户会以为命令没生效又去重跑一遍。
            //
            // 只探「未就绪」的那些，且只在面板打开时探：面板一关就停，
            // 不引入任何服务端后台状态。
            this.schedulePendingProbe(config);
        }

        /**
         * 每 60 秒探一次还没就绪的机器，直到它们都就绪或面板被关掉。
         *
         * 已就绪的机器不探：它们的状态由首页那个轮询周期管着（默认 15s），
         * 这里再探一遍只是浪费。而「未就绪」恰恰是变化最频繁的阶段——
         * 用户正在目标机上执行命令。
         */
        schedulePendingProbe(config) {
            this.clearPendingProbe();
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
                // 面板关了就不必再探：用户看不到结果，探了只是白花限流配额
                if (!$('#modulesEditor') || this.adminTab !== 'modules') {
                    this.clearPendingProbe();
                    return;
                }
                let changed = false;
                for (const s of pending) {
                    try {
                        const res = await API.post(`/api/modules/servers/${encodeURIComponent(s.id)}/probe`);
                        // 同上：写缓存，让卡片重绘时「在线」位有数据可读
                        if (!this.lastProbe) this.lastProbe = {};
                        this.lastProbe[s.id] = res;
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
                    await this.renderModulesEditor();
                    this.showToast('有机器的状态变了', 'success');
                }
            }, 60000);

            this.pendingProbeTimer = timer;
        }

        clearPendingProbe() {
            if (this.pendingProbeTimer) {
                clearInterval(this.pendingProbeTimer);
                this.pendingProbeTimer = null;
            }
        }

        /** 确保已知模块的定义都已注册。注册表非空则直接返回。 */
        async ensureModulesLoaded() {
            for (const id of App.KNOWN_MODULES) {
                if (this.getModule(id)) continue;
                try {
                    await this.loadModule(id);
                } catch (e) {
                    console.warn(`Preload module ${id} failed:`, e);
                }
            }
        }

        /**
         * 各模块自己的后台区块挂点。
         *
         * 平台只给容器与标题，provider 专属的表单/文案留在模块文件里——
         * 否则每加一种来源，app.js 都要跟着认识它的字段与状态。
         */
        moduleAdminSections() {
            return App.KNOWN_MODULES
                .map(id => this.getModule(id))
                .filter(def => def && typeof def.renderAdminSection === 'function')
                .map(def => `<div class="section-title">${this.esc(def.adminSectionTitle || def.title)}</div>
                    <div class="module-admin-section" data-module-admin="${this.esc(def.id)}"></div>`)
                .join('');
        }

        renderModulesEditorContent(host, config) {
            const known = App.KNOWN_MODULES.map(id => this.getModule(id)).filter(Boolean);
            // 每行：左侧「名称 + 说明」，右侧开关。
            // 说明文字紧贴它描述的那一行，而不是汇总在区块底部——
            // 早先把「启用后该模块会出现在首页模块区…」放在所有开关下面，
            // 离得太远，读的时候要来回对照才知道说的是哪个模块。
            const rows = known.map(def => {
                const on = config.enabledModules.includes(def.id);
                return `<div class="setting-row module-setting-row">
                    <label>
                        <span class="module-setting-label">${this.esc(def.title)}</span>
                        ${def.summary ? `<span class="module-setting-hint">${this.esc(def.summary)}</span>` : ''}
                        <span class="module-setting-toggle">
                            <div class="toggle-switch">
                                <input type="checkbox" data-module-toggle="${this.esc(def.id)}" ${on ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </div>
                            <span class="module-setting-state">${on ? '已启用' : '未启用'}</span>
                        </span>
                    </label>
                </div>`;
            }).join('');

            host.innerHTML = `
                ${rows || '<p class="fav-hint">暂无已注册模块。</p>'}
                ${this.moduleAdminSections()}
                <div class="section-title">监控目标</div>
                <p class="fav-hint">每个方块是一台机器。改动即时生效；
                    单台机器的配置在它的「编辑」里保存。</p>
                <div id="serverList"></div>
                <button class="btn" id="addServerBtn">添加服务器</button>
                <div class="setting-row self-signed-row">
                    <label class="self-signed-label">
                        <span class="self-signed-name">本服务的 https 证书是自签的</span>
                        <span class="setting-toggle">
                            <input type="checkbox" id="selfSignedCertBox"
                                   ${this.selfSignedCert ? 'checked' : ''}>
                            <span>${this.selfSignedCert ? '是' : '否'}</span>
                        </span>
                    </label>
                    <p class="self-signed-hint">自签选「是」，否则部署与升级命令会少一个
                        <code>--server-ca</code>，agent 会报
                        <code>certificate signed by unknown authority</code>。
                        改完<strong>重启本服务</strong>才生效。</p>
                </div>
                <div class="setting-row">
                    <label>
                        <span>更新周期</span>
                        <select id="pollIntervalSelect">
                            ${this.pollIntervalOptions(config.pollInterval)}
                        </select>
                    </label>
                </div>
                <p class="fav-hint" id="pollIntervalHint"></p>
            `;
            // ⚠️ 这两项必须真的接上。早先部署面板读的是 `this.serverIsSelfSigned`，
            // 而那个属性**从未被赋值、也没有任何 UI 能设置它** —— 恒为 undefined，
            // 于是自签分支永不触发，自签部署的用户拿到的命令必然缺 --server-ca。
            // 「读了但没人写」是本项目最贵的一类 bug：形状断言与全绿测试都看不见。
            const selfSignedBox = $('#selfSignedCertBox');
            selfSignedBox.onchange = async () => {
                const value = selfSignedBox.checked;
                selfSignedBox.nextElementSibling.textContent = value ? '是' : '否';
                try {
                    await API.post('/api/server-flags', { selfSignedCert: value });
                    this.selfSignedCert = value;
                    // ⚠️ 服务端写的是 server-config.json，而内存里那份被冻结
                    // （server-config/index.js 末尾），所以**要重启才真的生效**。
                    // 不说清楚的话，用户拨了开关、命令这次变了，
                    // 重启后又变回去 —— 看起来像「保存有时灵有时不灵」。
                    this.showToast(value
                        ? '已标记为自签证书（重启本服务后生效），之后生成的命令会带 --server-ca'
                        : '已按可信证书处理（重启本服务后生效），命令不带 --server-ca');
                } catch (e) {
                    console.error('Save selfSignedCert failed:', e);
                    selfSignedBox.checked = !value;
                    selfSignedBox.nextElementSibling.textContent = !value ? '是' : '否';
                    this.showToast('保存失败，请重试', 'error');
                }
            };
            this.updatePollIntervalHint(config.pollInterval);
            $('#pollIntervalSelect').onchange = async (e) => {
                const value = Number(e.target.value);
                try {
                    await API.post('/api/modules/config', {
                        enabledModules: config.enabledModules,
                        widgets: config.widgets,
                        servers: config.servers,
                        pollInterval: value
                    });
                    config.pollInterval = value;
                    this.updatePollIntervalHint(value);
                    this.showToast(`更新周期已设为 ${this.pollIntervalLabel(value)}`);
                } catch (err) {
                    console.error('Save poll interval failed:', err);
                    // 失败要把下拉拨回去，否则界面显示的是一个没生效的值
                    e.target.value = String(config.pollInterval ?? 15);
                    this.showToast('保存失败，请重试', 'error');
                }
            };
            this.renderServerList($('#serverList'), config);

            // 模块自己的后台区块：先把容器落进 DOM，再交给模块渲染
            //（它要绑事件、要读自己的数据，拿字符串做不到）。
            // 单个模块渲染失败不能让整个分区空白，所以逐个 try。
            for (const el of host.querySelectorAll('[data-module-admin]')) {
                const def = this.getModule(el.dataset.moduleAdmin);
                if (!def || typeof def.renderAdminSection !== 'function') continue;
                try {
                    // 注入 API：后台区块渲染时模块可能并未挂载（模块未启用），
                    // 所以它不能指望 mountWidget 那一次注入留下的 api 变量。
                    def.renderAdminSection(el, { api: API });
                } catch (err) {
                    console.error(`Render admin section ${def.id} failed:`, err);
                    el.innerHTML = '<p class="fav-hint">该模块的后台区块渲染失败，请重开面板重试。</p>';
                }
            }

            $('#addServerBtn').onclick = () => this.showServerDialog(null, async () => {
                await this.renderModulesEditor();
            });

            // 开关与它那一行的「已启用/未启用」文字必须同步，
            // 否则文字会与实际状态相反——它紧贴开关，反而不一致时最刺眼。
            //
            // ⚠️ 这里曾经**只改文字、从不发请求**（自 `ada60c6` 模块平台上线起
            // 就如此），而下面那句注释还断言「开关有自己的即时保存路径」——
            // 于是后台把开关拨成「已启用」、`.modules.json` 一个字没变，用户
            // 报的就是「备忘录模块无法启用」。用户原话：「更新后，备忘录模块
            // 无法启用」。上一轮 449→465 条测试全绿、源码形状守卫也在绿，
            // 因为那条守卫只断言了「存在一个 change 监听」。
            // 保存路径照抄同一文件里「显示/隐藏」那个开关（POST + toast +
            // 重渲染模块区 + 失败回滚）：模块开关与它是同一件事。
            for (const box of host.querySelectorAll('[data-module-toggle]')) {
                const state = box.closest('.module-setting-toggle')
                    ?.querySelector('.module-setting-state');
                box.addEventListener('change', async () => {
                    const id = box.dataset.moduleToggle;
                    const on = box.checked;
                    const before = config.enabledModules.slice();
                    const next = on
                        ? [...new Set([...before, id])]
                        : before.filter(x => x !== id);
                    try {
                        await API.post('/api/modules/config', {
                            enabledModules: next,
                            widgets: config.widgets,
                            servers: config.servers
                        });
                        config.enabledModules = next;
                        if (state) state.textContent = on ? '已启用' : '未启用';
                        const title = this.getModule(id)?.title || id;
                        this.showToast(on ? `已启用「${title}」` : `已停用「${title}」`);
                        await this.renderModuleZone();
                    } catch (err) {
                        console.error('Save module toggle failed:', err);
                        // 失败要把开关与文字一起拨回去，否则界面显示的是一个
                        // 没落盘的状态（本轮修的就是这个形状的谎）
                        box.checked = !on;
                        if (state) state.textContent = !on ? '已启用' : '未启用';
                        this.showToast('保存失败，请重试', 'error');
                    }
                });
            }

            // 模块开关的保存路径就在上面那个 change 处理器里，
            // 所以这里**不需要**一个总的「保存模块配置」按钮。
            // 曾有过一个，而它与右上角的「保存」职责重叠、用户分不清
            // 哪个才是真的生效——实际两者写的都是同一份 .modules.json。
        }

        /**
         * 轮询周期的可选值。与服务端 server.js 的 POLL_INTERVALS 一一对应——
         * 两边各写一份必然会漂移，所以这里只列 label，实际可选值由服务端白名单裁决。
         */
        pollIntervalLabel(seconds) {
            return seconds >= 60 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
        }

        /**
         * 轮询周期的可选项。
         *
         * 值由服务端 `POLL_INTERVALS` 白名单裁决——前端这份只是把同样的值
         * 渲染成下拉框。**两份列表必须保持一致**：前端多一项，服务端会静默
         * 回落默认，用户选了一个「看起来存在」却不生效的周期；前端少一项，
         * 则是给不出去。所以 `tests/monitor-agent.test.js` 有一条断言
         * 逐项比较两侧的列表，而不是只断言服务端那份字面量。
         */
        pollIntervalOptions(current) {
            const value = Number(current) || 15;
            // 与 server.js 的 POLL_INTERVALS 逐项一致（见上）
            return [10, 15, 30, 60, 300].map(s =>
                `<option value="${s}" ${s === value ? 'selected' : ''}>每 ${this.pollIntervalLabel(s)}</option>`
            ).join('');
        }

        /** 说明文字要写清「页面不可见时暂停」——否则用户会以为它一直在轮询。 */
        updatePollIntervalHint(current) {
            const hint = $('#pollIntervalHint');
            if (!hint) return;
            const seconds = Number(current) || 15;
            hint.textContent = `每 ${this.pollIntervalLabel(seconds)}自动刷新一次；`
                + '页面切到后台时暂停，回到前台立即刷新。';
        }

        /**
         * 保存单台服务器的首页可见性。
         *
         * 立即落盘而不是等「保存模块配置」：可见性是一个开关式的即时决定，
         * 让用户改完再去点另一个按钮，等于把两步合成一步却要两个动作。
         * 与整体保存同一套合并语义——只改这一条的 enabled，
         * order / side / 其他服务器一律原样带回（mergeModulesConfig 按 id 补回）。
         */
        async saveServerVisibility(key, shown, config) {
            const widgets = (config.widgets || []).map(w => ({ ...w }));
            const item = widgets.find(w => w.id === key);
            if (item) item.enabled = shown;
            else widgets.push({ id: key, enabled: shown, side: 'left', order: widgets.length, collapsed: false });

            try {
                await API.post('/api/modules/config', {
                    enabledModules: config.enabledModules,
                    widgets,
                    servers: config.servers
                });
                config.widgets = widgets;
                this.showToast(shown ? '已在首页显示' : '已从首页隐藏');
                await this.renderModuleZone();
            } catch (e) {
                console.error('Save server visibility failed:', e);
                this.showToast('保存失败，请重试', 'error');
                // 失败要拨回去，否则界面显示的是一个没生效的状态
                await this.renderModulesEditor();
            }
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
        serverDeployState(s) {
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
        renderServerStateBody(s) {
            const state = this.serverDeployState(s);
            // 「已就绪」时那块不渲染 —— 正常机器没有需要解释的事。
            // 但**已就绪的机器可能跑着旧版 agent**，那是要解释的，
            // 所以这里多一个例外而不是无条件 return ''。
            const outdated = this.isAgentOutdated(s);
            if ((state === 'ready' || state === 'unchecked') && !outdated) return '';
            // 措辞统一取自 serverDeployBit —— 状态位与说明区说同一句话，
            // 两处各写一份文案必然漂移（然后用户看到卡片说「未部署」
            // 而展开说「等待部署」）。
            const bit = this.serverDeployBit(s);
            const text = s.error ? this.esc(s.error) : this.esc(bit.title);
            const version = outdated ? `
                <div class="server-item-version">
                    agent ${this.esc(outdated.have)} · 本服务 ${this.esc(outdated.want)}
                    <span title="升级不会改凭据与证书，只替换程序本身">可升级</span>
                </div>` : '';
            return `
                <div class="server-item-state" data-kind="${bit.kind}">
                    <div class="lead">${this.esc(bit.text)}</div>
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
        isAgentOutdated(s) {
            const have = s.agentVersion;
            // 本服务版本：复用版本管理已经取过的 this.currentVersion，
            // 不另发一次请求——两个字段在同一次会话里必须是同一个值，
            // 而各取一次就多了一个「不一致」的时机。
            const want = this.currentVersion || this.serverVersion;
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
        displayUrlOf(s) {
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
        renderServerStatusBits(s, probe) {
            // probe 缺省时退回「上一次探测结果」的缓存。
            // ⚠️ 早先这里不传，于是「在线」位永远是「未检测」——而服务端
            // 早就把 reachable 算好并返回了（浏览器实测发现）。
            // 用 lastProbe 缓存而不是重新探测：渲染不该有网络副作用，
            // 而且每次渲染都探一次会把管理端限流桶打满。
            const p = probe || this.lastProbe?.[s.id];
            const online = this.serverOnlineState(s, p);
            const deploy = this.serverDeployBit(s, p);
            return `
                <span class="server-item-status" data-kind="${online.kind}"
                      title="${this.esc(online.title)}">${this.esc(online.text)}</span>
                <span class="server-item-status" data-kind="${deploy.kind}"
                      title="${this.esc(deploy.title)}">${this.esc(deploy.text)}</span>`;
        }

        /**
         * 「在线」这一位。推送模式报 null —— 它一个端口都不开，
         * 主机在不在线只能由「多久没收到上报」回答，不是探测能知道的。
         */
        serverOnlineState(s, probe) {
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
        serverDeployBit(s, probe) {
            const state = (probe && probe.deployState) || this.serverDeployState(s);
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
         * 该字段此前算了但没人用（服务端注释声称它「决定显示复制命令还是
         * 重新生成令牌」，而那两个按钮都不存在）——一个假承诺。
         *
         * 语义按用户拍板「有用就留着」接上：
         *   · 令牌已签发且未过期 → 直接给「复制命令」（用户可以直接粘）
         *   · 没有 / 已过期     → 给「部署」（点开面板会重新签一枚）
         * 所以这个字段不是冗余，它是「能不能直接复制」的判据。
         */
        renderDeployAction(s) {
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
         * 旧注释写「关掉后模块区可能全空却找不到入口开回来」，
         * 那是后台还没有这张卡时的旧前提，模块侧的过滤器已与代码对齐
         * （server-monitor.js mountWidget 与远端同一 hidden 表）。
         * 所以它没有「部署」「编辑」「删除」，只有「是否在首页显示」。
         *
         * 三个状态位对本机恒为固定值：agent 天然在（不需要装）、
         * 在线（它就是本服务本身）、同步方式是直读。
         */
        renderLocalServerCard(config) {
            const key = 'server-monitor:local';
            const item = (config.widgets || []).find(w => w.id === key);
            const shown = item ? item.enabled !== false : true;
            return `
            <div class="server-item" data-server-id="local" data-local="1">
                <div class="server-item-head">
                    <span class="server-item-name">本机（${this.esc(location.hostname || '运行此服务的机器')}）</span>
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
                        <input type="checkbox" data-server-visible="${key}" ${shown ? 'checked' : ''}
                               aria-label="在首页显示本机">
                        <span>${shown ? '显示' : '隐藏'}</span>
                    </label>
                </div>
            </div>`;
        }

        /**
         * 服务器列表。本机一张 + 每台远端一张。
         * 每张卡上有**三个**状态位（是否装了 agent / 是否在线 / 同步方式）、
         * 一个「是否在首页显示」的复选框，以及该台机器的操作按钮。
         * 凭据不回显——已注册的回一个布尔，编辑时留空表示保持原值
         * （与 WebDAV 的「留空保持原密码」同一形状）。
         */
        renderServerList(host, config) {
            if (!host) return;
            const servers = config.servers || [];
            // 本机永远有卡片——它是这个模块唯一的零配置产物，也是用户
            // 确认「这套东西活着」的第一眼。此前它只出现在首页卡片里，
            // 后台列表从空开始，用户会以为「还没配任何东西」。
            host.innerHTML = this.renderLocalServerCard(config)
                + servers.map(raw => {
                const key = `server-monitor:${raw.id}`;
                const item = (config.widgets || []).find(w => w.id === key);
                const shown = item ? item.enabled !== false : true;
                // ⚠️ 合并探测结果：agentVersion 只存在于 /probe 的响应里
                // （配置里没有这个字段），所以「目标机上跑的是不是旧版」
                // 这个判断必须读缓存，否则永远拿不到那个值。
                // 用 {...raw, ...probe} 而不是直接改 raw —— 那是配置对象，
                // 改它会让「这次探测的结果」变成「永久状态」。
                const probe = this.lastProbe?.[raw.id];
                const s = probe ? { ...raw, ...probe } : raw;
                const isPush = s.mode === 'push';
                // 一台一张卡、卡内竖排：横向由 grid 排多台，纵向因此有空间做
                // 达标的触控目标。此前是一行一台、按钮挤在右侧一行里（实测 26px，
                // 低于 44px 触摸下限），而那个密度是为三个按钮写的——
                // 本轮加了「检测连通性」变四个，紧凑单行更挤不下了。
                return `
                <div class="server-item" data-server-id="${this.esc(s.id)}">
                    <div class="server-item-head">
                        <span class="server-item-name">${this.esc(s.name || s.url)}</span>
                        <span class="server-item-url">${this.esc(this.displayUrlOf(s))}</span>
                    </div>
                    <div class="server-item-badges">
                        ${this.renderServerStatusBits(s)}
                        <span class="server-item-mode" data-mode="${isPush ? 'push' : 'pull'}"
                              title="${isPush
                                ? '推送：目标机主动送上来，不开放端口'
                                : '拉取：本服务去连这台机器'}">${isPush ? '推送' : '拉取'}</span>
                    </div>
                    ${this.renderServerStateBody(s)}
                    <div class="server-item-actions">
                        <label class="server-item-show" title="${shown ? '首页显示' : '已隐藏'}">
                            <input type="checkbox" data-server-visible="${this.esc(key)}" ${shown ? 'checked' : ''}
                                   aria-label="在首页显示 ${this.esc(s.name || s.url)}">
                            <span>${shown ? '显示' : '隐藏'}</span>
                        </label>
                        ${isPush ? '' : `<button class="btn btn-sm probe-server"
                            title="真去连一次：主机在不在线、agent 装没装">检测</button>`}
                        ${this.renderDeployAction(s)}
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
                        await this.saveServerVisibility(showBox.dataset.serverVisible, shown, config);
                    };
                }
                const deployBtn = row.querySelector('.deploy-server');
                if (deployBtn) deployBtn.onclick = () => this.showDeployDialog(server);

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
                            const res = await API.post(`/api/modules/servers/${encodeURIComponent(id)}/probe`);
                            // 记进缓存：渲染时的「在线」位要读它（服务端算好的
                            // reachable 不会凭空出现在配置里）
                            if (!this.lastProbe) this.lastProbe = {};
                            this.lastProbe[id] = res;
                            const name = server.name || server.url;
                            // 每种结果都给出下一步——服务端已经在 hint 里写好了，
                            // 这里只负责把它显示出来，并按情况提示下一步动作。
                            // 措辞取自 serverDeployBit，与卡片状态位、说明区同源。
                            const ok = res.deployState === 'ready';
                            const bit = this.serverDeployBit(res);
                            this.showToast(`${name}：${bit.text}。${res.hint || ''}`,
                                ok ? 'success' : 'error');
                            // 「主机在线但没装 agent」是最值得主动引导的一种：
                            // 用户点检测多半就是想确认能不能用，而答案是「能连，
                            // 但要装个东西」——直接告诉他去哪装。
                            if (res.deployState === 'not_deployed') {
                                await this.notice('这台机器还缺 agent', res.hint || '');
                            }
                            // 刷新卡片，让状态位与说明区立刻反映这次探测的结果
                            await this.renderModulesEditor();
                        } catch (e) {
                            console.error('Probe server failed:', e);
                            this.showToast('检测失败，请重试', 'error');
                        } finally {
                            probeBtn.disabled = false;
                            probeBtn.textContent = original;
                        }
                    };
                }

                const editBtn = row.querySelector('.edit-server');
                if (editBtn) editBtn.onclick = () => this.showServerDialog(server, async () => {
                    await this.renderModulesEditor();
                });
                const delBtn = row.querySelector('.del-server');
                if (delBtn) delBtn.onclick = async () => {
                    if (!await this.confirmAction(`确定删除「${server.name || server.url}」？`, '删除服务器', true)) return;
                    try {
                        const res = await fetch(`/api/modules/servers/${encodeURIComponent(id)}`, {
                            method: 'DELETE',
                            credentials: 'same-origin'
                        });
                        if (!res.ok) {
                            const body = await res.json().catch(() => ({}));
                            throw new Error(body.error || `HTTP ${res.status}`);
                        }
                        this.showToast('已删除');
                        await this.renderModulesEditor();
                    } catch (e) {
                        console.error('Delete server failed:', e);
                        this.showToast(e.message || '删除失败', 'error');
                    }
                };
            }
        }

        /**
         * 一键部署面板：签一枚一次性令牌，把「复制粘贴一行命令」给用户。
         *
         * 为什么放在这里而不是 sylph.sh：sylph.sh 管的是**主服务**的安装与升级，
         * 而 agent 部署在**别的机器**上，混进去会让两个角色互相干扰。
         * 后台「模块 → 监控目标」是用户配置这些机器的地方，命令就该在这里。
         *
         * 上一版是六个代码块手工复制，还带 `<你的 token>` 占位符——
         * 用户得先去别处取一个自己发明的 token、再手工配 systemd。
         * 现在三处需要用户填的值（token、端口、证书指纹）全部归零：
         * 端口由后台按当前访问地址自动带上，证书由 agent 自己签发，
         * 令牌是一次性的、用完即废。
         */
        showDeployDialog(server) {
            const name = server.name || server.url || '这台机器';
            // 一键部署：先换一枚一次性部署令牌，再把命令拼出来。
            // 令牌明文只在这一次响应里出现，服务端只存哈希——
            // 所以面板必须立刻让用户复制走。
            this.showToast('正在生成部署命令…');
            API.post(`/api/modules/servers/${encodeURIComponent(server.id)}/enroll-token`)
                .then(res => {
                    const origin = location.origin;
                    const mode = res.mode === 'push' ? 'push' : 'pull';
                    // 自签服务端要在命令里带上 CA，否则 agent 的 TLS 握手会失败
                    // （Go 在 macOS 上不读 SSL_CERT_FILE，Linux 上自签也不在
                    // 系统根池里）。默认不勾：多数人用 certbot。
                    const parts = [
                        `curl -fsSL ${origin}/agent/install.sh | sudo bash -s --`,
                        `  --server ${origin}`,
                        `  --enroll ${res.token}`
                    ];
                    if (mode === 'push') parts.push('  --mode push');
                    // 自签时用户得自己给证书路径——我们不知道他装在哪，
                    // 而猜一个路径比让用户改一行更糟。
                    if (this.selfSignedCert === true) {
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
                        + (this.selfSignedCert === true
                            ? ' \\\n  --server-ca /etc/ssl/certs/你的证书.crt'
                            : '');

                    this.showCommandPanel(`部署到「${name}」`, [
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
                    this.showToast('生成部署命令失败，请重试', 'error');
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
         * 早先在 intro 里用 Markdown 的 `**目标机**`，转义后星号原样显示。
         */
        richIntro(text) {
            return this.esc(text).replace(/&lt;strong&gt;/g, '<strong>')
                .replace(/&lt;\/strong&gt;/g, '</strong>');
        }

        showCommandPanel(title, steps, { intro = '' } = {}) {
            document.querySelectorAll('.command-panel-overlay').forEach(o => o.remove());
            const overlay = html(`
                <div class="command-panel-overlay">
                    <div class="command-panel" role="dialog" aria-modal="true" aria-label="${this.esc(title)}">
                        <div class="command-panel-head">
                            <h3>${this.esc(title)}</h3>
                            <button type="button" class="command-panel-close" aria-label="关闭">×</button>
                        </div>
                        <div class="command-panel-body">
                            ${intro ? `<p class="command-intro">${this.richIntro(intro)}</p>` : ''}
                            ${steps.map(s => `
                                <section class="command-step">
                                    <h4>${this.esc(s.title)}</h4>
                                    ${s.note ? `<p class="command-note">${this.esc(s.note)}</p>` : ''}
                                    ${s.plain
                                        ? `<p class="command-plain">${this.esc(s.plain)}</p>`
                                        : `<div class="command-row">
                                            <pre class="command-code">${this.esc(s.code)}</pre>
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
         * 「名称 + 地址（只填 IP）+ 一个连通性问题」——这是本次改版的核心：
         * 上一版要用户自己拼协议、自己发明 token、自己在「拉取/推送」两个
         * 技术词之间选，而这三个值本服务全都知道。
         *
         * token 与证书都不再由用户填：它们由「部署」流程里的注册步骤带回。
         * 编辑时留空表示保持原值（与 WebDAV 的「留空保持原密码」同一形状）。
         *
         * 单独一个端点而不是走 /api/modules/config——token 必须由服务端加密，
         * 前端提交的明文不能经那条路径落盘。
         */
        async showServerDialog(server, onDone) {
            const isEdit = !!server;
            // 用户答的是「本服务能否直接连到它」，而不是「局域网/公网」。
            // 后者描述的是机器的位置，前者才是决定能不能 pull 的那个事实；
            // 而「局域网/公网」组合起来有四格，用户要自己推导哪一格。
            const currentReachable = server ? server.reachable !== false : true;
            const result = await this.showUiDialog({
                title: isEdit ? '编辑服务器' : '添加服务器',
                message: isEdit
                    ? '改了地址或连通方向后，需要重新部署一次才能生效。'
                    : '保存后会自动检测这台机器的状态。token 与证书会在你部署时自动配置，不用在这里填。',
                fields: [
                    { label: '名称', type: 'text', value: server ? server.name : '', placeholder: '例如：家用 NAS' },
                    {
                        label: '地址',
                        type: 'text',
                        value: server ? this.displayUrlOf(server) : '',
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
                const saved = await API.post('/api/modules/servers', {
                    id: server ? server.id : undefined,
                    name,
                    url,
                    mode,
                    reachable
                });
                this.showToast(isEdit ? '服务器已更新' : '服务器已添加，正在检测…');
                await onDone();

                // 保存后立刻探一次，用户不用再点「检测」才知道结果。
                // 编辑时**不**自动打开部署面板：那条命令会签发一枚新令牌，
                // 而「改个名字」这种无害操作不该产生一枚用户看不见的令牌。
                if (saved && saved.id) {
                    const fresh = await this.findServerById(saved.id);
                    if (fresh) {
                        const res = await API.post(`/api/modules/servers/${encodeURIComponent(saved.id)}/probe`);
                        if (res.deployState === 'not_deployed') {
                            await this.notice('这台机器还缺 agent',
                                (res.hint || '') + '\n\n点这行右侧的「部署」，把命令复制到目标机上执行就行。');
                            // 新建且还没部署时直接给命令——用户的下一步几乎必然是它
                            if (!isEdit) {
                                this.showDeployDialog({ ...fresh, id: saved.id, name, url });
                            }
                        }
                        await onDone();
                    }
                }
            } catch (e) {
                console.error('Save server failed:', e);
                this.showToast('保存失败，请重试', 'error');
            }
        }

        /** 从已加载的模块配置里找一台机器。找不到返回 null 而不是抛错。 */
        async findServerById(id) {
            if (!this.modulesConfig) await this.loadModulesConfig();
            const list = (this.modulesConfig && this.modulesConfig.servers) || [];
            return list.find(s => s.id === id) || null;
        }

        renderAdminPanel() {
            const body = $('#modalBody');
            // 四个分区：宽屏左侧常驻侧栏，≤899px 退化为顶部横向标签条。
            // tab 三件套（tablist / tab / tabpanel）是本项目首次引入的交互模式。
            body.innerHTML = `
                <div class="admin-tabs" role="tablist" aria-label="管理分区">
                    <button type="button" class="admin-tab" role="tab" id="adminTabSite" aria-controls="adminPanelSite" aria-selected="false" tabindex="-1" data-panel="site">首页导航</button>
                    <button type="button" class="admin-tab" role="tab" id="adminTabFav" aria-controls="adminPanelFav" aria-selected="false" tabindex="-1" data-panel="fav">收藏夹</button>
                    <button type="button" class="admin-tab" role="tab" id="adminTabModules" aria-controls="adminPanelModules" aria-selected="false" tabindex="-1" data-panel="modules">模块</button>
                    <button type="button" class="admin-tab" role="tab" id="adminTabAccount" aria-controls="adminPanelAccount" aria-selected="false" tabindex="-1" data-panel="account">账户与备份</button>
                </div>
                <div class="admin-panels">
                <div class="admin-panel" role="tabpanel" id="adminPanelSite" aria-labelledby="adminTabSite" hidden>
                <div class="section">
                    <div class="section-title">界面设置</div>
                    <div class="setting-row">
                        <label>
                            <span>主题模式</span>
                            <select id="themeModeSelect">
                                <option value="auto" ${this.config.theme === 'auto' ? 'selected' : ''}>跟随系统</option>
                                <option value="light" ${this.config.theme === 'light' ? 'selected' : ''}>浅色模式</option>
                                <option value="dark" ${this.config.theme === 'dark' ? 'selected' : ''}>深色模式</option>
                            </select>
                        </label>
                    </div>
                    <div class="setting-row">
                        <label>
                            <span>默认搜索引擎</span>
                            <select id="defaultEngineSelect">
                                ${this.config.searchEngines.map(e =>
                                    `<option value="${e.id}" ${e.id === this.config.searchEngine ? 'selected' : ''}>${this.esc(e.name)}</option>`
                                ).join('')}
                            </select>
                        </label>
                    </div>
                    <div class="setting-row">
                        <label>
                            <span>隐私模式</span>
                            <div class="toggle-switch">
                                <input type="checkbox" id="privacyModeToggle" ${this.config.privacyMode ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </div>
                        </label>
                    </div>
                </div>
                <div class="section section-collapsible">
                    <button type="button" class="section-header" aria-expanded="false" aria-controls="enginesSection" onclick="app.toggleSection('engines')">
                        <span class="section-title">搜索引擎</span>
                        <span class="section-toggle-label">展开</span>
                    </button>
                    <div class="section-body collapsed" id="enginesSection">
                        <div id="enginesEditor"></div>
                        <button class="add-btn" id="addEngine">添加搜索引擎</button>
                    </div>
                </div>
                </div>
                <div class="admin-panel" role="tabpanel" id="adminPanelFav" aria-labelledby="adminTabFav" hidden>
                <div class="section">
                    <div class="section-title">收藏夹</div>
                    <div class="fav-stats">
                        共 <strong>${this.favoritesLoading ? '加载中' : this.favorites.length}</strong> 个书签
                        <span class="fav-hint">（搜索框输入 <code>/</code> 快速检索）</span>
                    </div>
                    <div class="fav-actions">
                        <button class="btn" id="importFavBtn">导入书签</button>
                        <button class="btn" id="exportFavBtn">导出书签</button>
                        <button class="btn" id="addFavBtn">添加书签</button>
                    </div>
                    <input type="file" id="favFileInput" accept=".html,.htm" hidden>
                </div>
                <!-- 收藏管理器：渲染进本容器（见 renderFavManager） -->
                <div id="favManagerHost"></div>
                </div>
                <div class="admin-panel" role="tabpanel" id="adminPanelModules" aria-labelledby="adminTabModules" hidden>
                <div class="section">
                    <div class="section-title">模块</div>
                    <p class="fav-hint">模块配置独立保存，不随上方的「保存」按钮提交。</p>
                    <div id="modulesEditor">
                        <div class="webdav-loading">加载中...</div>
                    </div>
                </div>
                </div>
                <div class="admin-panel" role="tabpanel" id="adminPanelAccount" aria-labelledby="adminTabAccount" hidden>
                <div class="section">
                    <div class="section-title">登录安全</div>
                    <div class="setting-row">
                        <label>
                            <span>信任此设备</span>
                            <div class="toggle-switch">
                                <input type="checkbox" id="trustDeviceToggle" ${this.sessionTrusted ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </div>
                        </label>
                    </div>
                    <p class="fav-hint" id="trustDeviceHint"></p>
                </div>
                <div class="section section-collapsible">
                    <button type="button" class="section-header" aria-expanded="false" aria-controls="webdavSection" onclick="app.toggleSection('webdav')">
                        <span class="section-title">远程备份</span>
                        <span class="section-toggle-label">展开</span>
                    </button>
                    <div class="section-body collapsed" id="webdavSection">
                        <div class="webdav-loading">加载中...</div>
                    </div>
                </div>
                <div class="section">
                    <button class="btn btn-danger" id="logoutBtn" style="width: 100%;">退出登录</button>
                </div>
                </div>
                </div>
            `;

            this.bindAdminTabs();
            this.renderEnginesEditor();
            // 书签分类不在这里编辑：首页右下角「编辑」按钮直接管，
            // 后台保留这个分区只为告诉用户去哪改。
            // 面板 DOM 每次 openAdmin 都是新的，模块分区的容器也是；
            // 不复位的话，上一会话渲染过就会让本分区跳过加载（停在「加载中...」）。
            this.modulesEditorRendered = false;
            // 收藏管理器同理：面板 DOM 每次都是新的，
            // 不复位的话上一会话渲染过就会让本分区跳过加载。
            this.favManagerRendered = false;
            // 远程备份区块同理，且它踩的正是这个坑：DOM 重建后 #webdavSection
            // 只剩模板里那句「加载中...」，而 webdavConfig 还在内存里——
            // 不复位「已渲染」闩锁，展开时就不会再去加载，也就没人把它画出来。
            this.webdavRendered = false;
            // 回到上次停留的分区，而不是每次都弹回第一个。
            // 收藏管理器渲染在「收藏夹」tab 内的 #favManagerHost，
            // 分区切换由 tab 栏负责，不再整块替换 #modalBody。
            this.selectAdminTab(this.adminTab || 'site');

            $('#themeModeSelect').onchange = (e) => {
                this.config.theme = e.target.value;
                this.applyTheme();
                this.markConfigDirty();
            };

            $('#defaultEngineSelect').onchange = (e) => {
                this.config.searchEngine = e.target.value;
                this.renderEngines();
                this.markConfigDirty();
            };

            $('#addEngine').onclick = () => {
                this.config.searchEngines.push({ id: uid(), name: '新引擎', url: 'https://' });
                this.renderEnginesEditor();
                this.markConfigDirty();
            };

            // 收藏夹相关绑定（favorites.json 那套平铺书签，与首页导航分类不同）
            $('#importFavBtn').onclick = () => $('#favFileInput').click();
            $('#favFileInput').onchange = (e) => this.handleFavImport(e);
            $('#addFavBtn').onclick = () => this.showAddFavDialog();
            $('#exportFavBtn').onclick = () => this.exportFavorites();
            if (this.favoritesLoading) {
                ['importFavBtn', 'exportFavBtn', 'addFavBtn'].forEach(id => { $(`#${id}`).disabled = true; });
            }

            // 隐私模式开关
            $('#privacyModeToggle').onchange = (e) => {
                this.config.privacyMode = e.target.checked;
                this.markConfigDirty();
            };

            // 信任此设备开关。与其他设置不同：它立即生效、不走「保存配置」，
            // 因为服务端会立刻按新档位重算会话有效期。
            $('#trustDeviceToggle').onchange = async (e) => {
                const toggle = e.target;
                const wanted = toggle.checked;
                // 等待期间锁住，避免连续点击发出互相矛盾的两次请求
                toggle.disabled = true;
                const ok = await this.setDeviceTrust(wanted);
                toggle.disabled = false;
                if (ok !== wanted) {
                    // 服务端没接受：把开关拨回真实状态，别让它停在一个假的档位上
                    toggle.checked = !wanted;
                    this.sessionTrusted = !wanted;
                }
                this.updateTrustDeviceHint();
            };
            this.updateTrustDeviceHint();

            // 登出按钮
            $('#logoutBtn').onclick = async () => {
                if (!await this.closeAdmin()) return;
                this.authenticated = false;
                this.sessionTrusted = false;
                // 换会话后远程备份配置不再可信，必须清掉：内存里不留上一个会话的
                // 配置。真正决定「展开时要不要重新加载」的是 webdavRendered
                //（见 toggleSection），所以两样一起清。
                this.webdavConfig = null;
                this.webdavRendered = false;
                // 通知服务端销毁会话并清 Cookie；失败也要继续清理本地状态
                try { await API.post('/api/logout', {}); } catch (e) {
                    console.error('Logout failed:', e);
                }
                // 重新允许下次登录后再次弹出环境变化提示
                API.envChangeNotified = false;
                this.privacySearchActive = false;
                // 丢弃全量缓存，页面回到匿名可见的公开子集
                this.adminFavorites = null;
                await this.loadFavorites();
                // loadFavorites 之前若有请求在途，可能在登出后才把全量列表写回来。
                // 此刻已是匿名身份，必须把私密条目就地剔除，否则页面会一边声称
                // 未登录、一边握着完整的私密列表（保存/渲染路径都看得到）。
                if (!this.authenticated && this.favorites.some(fav => fav && fav.private)) {
                    this.favorites = this.favorites.filter(fav => fav && !fav.private);
                    this.buildSearchIndex();
                }
                // 模块区最后收起：先清空配置缓存，再退出编辑模式，
                // 顺序与 restoreSession 的展示路径相反。
                this.modulesConfig = null;
                this.modulesLoaded = false;
                this.modulesError = null;
                await this.syncModuleVisibility();
            };

            // WebDAV 配置改为「首次展开时」在 toggleSection 里加载，
            // 不在此处预取——每次重渲染都多打一次请求会累积撞上限流
        }

        // ========== WebDAV 远程备份 ==========

        /**
         * 备份时间统一按浏览器本地时区渲染。
         * 服务端给的都是带 Z 的 ISO 串（UTC）；此前列表把文件名里的
         * UTC 时间戳直接当本地时间显示，比北京时间早 8 小时，
         * 与上面的「上次备份」对不上。
         */
        formatBackupTime(iso) {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return '';
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
                + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }

        async loadWebDAVConfig() {
            const container = $('#webdavSection');
            try {
                const { res, data } = await API.request('/api/webdav/config');
                if (!res.ok) {
                    // 失败必须显式落到容器里。此前只在 res.ok 时渲染，
                    // 任何非 200（限流、会话失效、网络错误）都会让
                    // 「加载中...」永远留在页面上，且没有任何提示。
                    this.renderWebDAVError(data?.error || `加载失败（${res.status}）`);
                    return;
                }
                this.webdavConfig = data;
                this.renderWebDAVSection();
            } catch (e) {
                console.error('Load WebDAV config failed:', e);
                this.renderWebDAVError('加载失败，请稍后重试');
            }
        }

        /** 把失败原因显示在远程备份区块内，而不是留一个转圈的提示。 */
        renderWebDAVError(message) {
            const container = $('#webdavSection');
            if (!container) return;
            // 给一个重试入口：失败后不能只能刷新整页
            container.innerHTML = `<div class="webdav-message error">${this.esc(message)}</div>
                <div class="webdav-actions"><button class="btn" id="webdavRetryBtn">重试</button></div>`;
            $('#webdavRetryBtn').onclick = () => this.loadWebDAVConfig();
        }

        renderWebDAVSection() {
            const container = $('#webdavSection');
            if (!container || !this.webdavConfig) return;

            const cfg = this.webdavConfig;
            const lastBackup = cfg.lastBackupTime
                ? this.formatBackupTime(cfg.lastBackupTime)
                : '从未备份';

            container.innerHTML = `
                <div class="webdav-status">
                    <span class="webdav-status-dot ${cfg.enabled ? 'active' : ''}"></span>
                    <span>${cfg.enabled ? '已启用' : '未启用'}</span>
                    <span class="webdav-auto-status"></span>
                    ${cfg.lastBackupTime ? `<span class="webdav-last-backup">上次备份: ${lastBackup}</span>` : ''}
                </div>
                <div class="webdav-form">
                    <div class="webdav-row">
                        <label>
                            <input type="checkbox" id="webdavEnabled" ${cfg.enabled ? 'checked' : ''}>
                            启用 WebDAV 备份
                        </label>
                    </div>
                    <div class="webdav-row">
                        <label${cfg.enabled ? '' : ' class="is-disabled"'}>
                            <input type="checkbox" id="webdavAutoSync" ${cfg.autoSync ? 'checked' : ''} ${cfg.enabled ? '' : 'disabled'}>
                            自动同步（配置变更后自动备份）
                        </label>
                    </div>
                    <div class="webdav-row">
                        <label class="field-label">WebDAV 地址<input type="url" id="webdavUrl" placeholder="https://dav.example.com" value="${this.esc(cfg.url || '')}"></label>
                    </div>
                    <div class="webdav-row webdav-row-half">
                        <label class="field-label">用户名<input type="text" id="webdavUsername" value="${this.esc(cfg.username || '')}"></label>
                        <label class="field-label">密码<input type="password" id="webdavPassword" placeholder="${cfg.hasPassword ? '已设置，留空保持原密码' : '输入密码'}"></label>
                    </div>
                    <div class="webdav-row">
                        <label class="field-label">远程路径<input type="text" id="webdavPath" value="${this.esc(cfg.remotePath || '/nav-sylph-backups/')}"></label>
                    </div>
                </div>
                <p class="fav-hint">开启自动同步后，首页导航、书签或模块设置发生变化时会自动备份一次；同一时段的连续改动合并为一次。自动备份写在固定的「自动同步」槽位，不占用手动备份的 5 份历史。</p>
                ${cfg.lastAutoSyncError ? `<div class="webdav-message error">上次自动同步失败${cfg.lastAutoSyncErrorAt ? `（${this.formatBackupTime(cfg.lastAutoSyncErrorAt)}）` : ''}：${this.esc(cfg.lastAutoSyncError)}</div>` : ''}
                <div class="webdav-actions">
                    <button class="btn" id="webdavSaveBtn">保存配置</button>
                    <button class="btn" id="webdavTestBtn">测试连接</button>
                    <button class="btn btn-primary" id="webdavBackupBtn">立即备份</button>
                    <button class="btn" id="webdavRestoreBtn">从备份恢复</button>
                </div>
                <div class="webdav-message" id="webdavMessage"></div>
            `;

            $('#webdavSaveBtn').onclick = () => this.saveWebDAVConfig();
            $('#webdavTestBtn').onclick = () => this.testWebDAVConnection();
            $('#webdavBackupBtn').onclick = () => this.createWebDAVBackup();
            $('#webdavRestoreBtn').onclick = () => this.showWebDAVRestoreDialog();

            // 状态行与禁用态都由这两个勾选框的**当前值**算出来，只有一处实现。
            //
            // 三种状态必须分开说：「开着但没启用 WebDAV」与「关着」看起来都是
            // 「没在同步」，但下一步该做什么完全不同（前者去勾「启用」，后者来
            // 勾这一项）。合成一句就是让用户自己猜。
            //
            // 两个框都要绑 onchange：只绑「启用」的话，勾上自动同步后状态行仍写着
            // 「已关闭」（浏览器实测如此），读起来正像「勾了没反应」。
            const enabledBox = $('#webdavEnabled');
            const autoBox = $('#webdavAutoSync');
            const autoStatusEl = container.querySelector('.webdav-auto-status');
            const refreshAutoState = () => {
                if (autoBox.checked && enabledBox.checked) autoStatusEl.textContent = '自动同步：已开启';
                else if (autoBox.checked) autoStatusEl.textContent = '自动同步：待启用（需先勾选「启用 WebDAV 备份」）';
                else autoStatusEl.textContent = '自动同步：已关闭';
                // 未启用时置灰：一个看着开着、其实什么也不做的开关比没有更糟
                autoBox.disabled = !enabledBox.checked;
                autoBox.closest('label').classList.toggle('is-disabled', !enabledBox.checked);
            };
            enabledBox.onchange = refreshAutoState;
            autoBox.onchange = refreshAutoState;
            refreshAutoState();

            // 闩锁：这份配置已经画进当前这块 DOM 了，toggleSection 不必再加载。
            this.webdavRendered = true;
        }

        async saveWebDAVConfig() {
            const msgEl = $('#webdavMessage');
            msgEl.textContent = '保存中...';
            msgEl.className = 'webdav-message';

            try {
                const data = {
                    enabled: $('#webdavEnabled').checked,
                    autoSync: $('#webdavAutoSync').checked,
                    url: $('#webdavUrl').value.trim(),
                    username: $('#webdavUsername').value.trim(),
                    remotePath: $('#webdavPath').value.trim() || '/nav-sylph-backups/'
                };

                const pwd = $('#webdavPassword').value;
                if (pwd) data.password = pwd;

                const res = await API.post('/api/webdav/config', data);
                if (res.success) {
                    this.webdavConfig = res.config;
                    // 顺序要紧：先重渲染，再把提示写到**新**的那个元素上。
                    // renderWebDAVSection() 会重建整个容器，先写的话提示会被
                    // 刚建出来的空 #webdavMessage 覆盖掉——保存成功却什么都没显示，
                    // 用户无法判断刚才那一勾有没有存下去（本轮顺带修的既有缺陷）。
                    this.renderWebDAVSection();
                    const freshMsg = $('#webdavMessage');
                    freshMsg.textContent = '配置已保存';
                    freshMsg.className = 'webdav-message success';
                } else {
                    msgEl.textContent = res.error || '保存失败';
                    msgEl.className = 'webdav-message error';
                }
            } catch (e) {
                msgEl.textContent = '保存失败: ' + e.message;
                msgEl.className = 'webdav-message error';
            }
        }

        async testWebDAVConnection() {
            const msgEl = $('#webdavMessage');
            msgEl.textContent = '测试连接中...';
            msgEl.className = 'webdav-message';

            try {
                const res = await API.post('/api/webdav/test', {});
                if (res.success) {
                    msgEl.textContent = '连接成功';
                    msgEl.className = 'webdav-message success';
                } else {
                    msgEl.textContent = res.message || '连接失败';
                    msgEl.className = 'webdav-message error';
                }
            } catch (e) {
                msgEl.textContent = '连接失败: ' + e.message;
                msgEl.className = 'webdav-message error';
            }
        }

        async createWebDAVBackup() {
            const msgEl = $('#webdavMessage');
            msgEl.textContent = '备份中...';
            msgEl.className = 'webdav-message';

            try {
                const res = await API.post('/api/webdav/backup', {});
                if (res.success) {
                    if (res.noChanges) {
                        msgEl.textContent = res.message || '配置和书签没有变化，无需备份';
                        msgEl.className = 'webdav-message';
                    } else {
                        const files = [res.configFilename, res.bookmarksFilename, res.modulesFilename,
                            res.timelineFilename].filter(Boolean);
                        msgEl.textContent = `备份成功: ${files.join(', ')}`;
                        msgEl.className = 'webdav-message success';
                        await this.loadWebDAVConfig();
                    }
                } else {
                    msgEl.textContent = res.error || '备份失败';
                    msgEl.className = 'webdav-message error';
                }
            } catch (e) {
                msgEl.textContent = '备份失败: ' + e.message;
                msgEl.className = 'webdav-message error';
            }
        }

        async showWebDAVRestoreDialog() {
            const msgEl = $('#webdavMessage');
            msgEl.textContent = '获取备份列表...';
            msgEl.className = 'webdav-message';

            try {
                // 必须用 request 已经解析好的 data，不能再 res.json()：
                // body stream 只能读一次，二次读取抛
                // "Failed to execute 'json' on 'Response': body stream already read"。
                const { res, data } = await API.request('/api/webdav/list');

                if (!res.ok || !data?.success) {
                    msgEl.textContent = data?.error || `获取列表失败（${res.status}）`;
                    msgEl.className = 'webdav-message error';
                    return;
                }

                if (data.backups.length === 0) {
                    msgEl.textContent = '没有可用的备份';
                    msgEl.className = 'webdav-message';
                    return;
                }

                msgEl.textContent = '';

                const dialog = html(`
                    <div class="fav-dialog-overlay" id="webdavRestoreDialog">
                        <div class="fav-dialog webdav-restore-dialog">
                            <h3>管理备份</h3>
                            <div class="webdav-backup-list">
                                ${data.backups.map(b => {
                                    const isLegacy = !!b.legacyFile;
                                    const hasConfig = !!b.configFile;
                                    const hasBookmarks = !!b.bookmarksFile;
                                    const hasModules = !!b.modulesFile;
                                    const hasTimeline = !!b.timelineFile;
                                    // 自动槽位不是历史还原点，单独标出来，免得用户
                                    // 把它当成某个时间点的手动备份。
                                    const displayName = b.isAuto
                                        ? `自动同步${b.createdAt ? ` · ${this.formatBackupTime(b.createdAt)}` : ''}`
                                        : this.formatBackupTime(b.createdAt);
                                    const files = [];
                                    if (isLegacy) files.push('旧版备份');
                                    if (hasConfig) files.push('配置');
                                    if (hasBookmarks) files.push('书签');
                                    if (hasModules) files.push('模块');
                                    if (hasTimeline) files.push('时间线');
                                    return `
                                    <div class="webdav-backup-item${b.isAuto ? ' is-auto' : ''}"
                                         data-config="${this.esc(b.configFile || '')}"
                                         data-bookmarks="${this.esc(b.bookmarksFile || '')}"
                                         data-modules="${this.esc(b.modulesFile || '')}"
                                         data-timeline="${this.esc(b.timelineFile || '')}"
                                         data-legacy="${this.esc(b.legacyFile || '')}"
                                         data-created-at="${this.esc(b.createdAt || '')}">
                                        <div class="webdav-backup-info">
                                            <div class="webdav-backup-name">${displayName}</div>
                                            <div class="webdav-backup-meta">
                                                ${files.join(' + ')}
                                            </div>
                                        </div>
                                        <div class="webdav-backup-actions">
                                            <button class="btn btn-sm webdav-restore-btn" title="恢复">恢复</button>
                                            <button class="btn btn-sm btn-danger webdav-delete-btn" title="删除">删除</button>
                                        </div>
                                    </div>
                                `}).join('')}
                            </div>
                            <div class="fav-dialog-actions">
                                <button class="btn" id="webdavRestoreCancelBtn">关闭</button>
                            </div>
                        </div>
                    </div>
                `);

                this.mountLayer(dialog);

                $('#webdavRestoreCancelBtn').onclick = () => this.closeLayer(dialog);

                $$('.webdav-restore-btn', dialog).forEach(btn => {
                    btn.onclick = async (e) => {
                        e.stopPropagation();
                        const item = btn.closest('.webdav-backup-item');
                        const configFile = item.dataset.config;
                        const bookmarksFile = item.dataset.bookmarks;
                        const modulesFile = item.dataset.modules;
                        const timelineFile = item.dataset.timeline;
                        const legacyFile = item.dataset.legacy;

                        this.showRestoreOptionsDialog({
                            configFile,
                            bookmarksFile,
                            modulesFile,
                            timelineFile,
                            legacyFile
                        }, dialog);
                    };
                });

                $$('.webdav-delete-btn', dialog).forEach(btn => {
                    btn.onclick = async (e) => {
                        e.stopPropagation();
                        const item = btn.closest('.webdav-backup-item');
                        const configFile = item.dataset.config;
                        const bookmarksFile = item.dataset.bookmarks;
                        const modulesFile = item.dataset.modules;
                        const timelineFile = item.dataset.timeline;
                        const legacyFile = item.dataset.legacy;
                        // 用列表里**渲染出来的那串名字**，而不是按 createdAt 重算：
                        // 自动槽位的显示名是「自动同步 · 时间」，重算会退化成光秃秃的
                        // 时间，用户在确认框里认不出自己点的是哪一条。
                        const displayName = $('.webdav-backup-name', item)?.textContent
                            || this.formatBackupTime(item.dataset.createdAt);

                        if (!await this.confirmAction(`确定删除备份 ${displayName}？`, '删除备份', true)) return;

                        btn.disabled = true;
                        btn.textContent = '删除中...';

                        try {
                            // 同组的每个文件都必须一起删，否则远端会留下孤儿文件
                            //（时间线文件同样在内：删了配置却留下它，恢复时会出现
                            // 「配置是旧的、时间线是新的」这种半新半旧的分组）。
                            const filesToDelete = [configFile, bookmarksFile, modulesFile, timelineFile, legacyFile].filter(Boolean);
                            for (const file of filesToDelete) {
                                await API.post('/api/webdav/delete', { filename: file });
                            }
                            item.remove();

                            // Check if list is empty
                            if (!$('.webdav-backup-item', dialog)) {
                                this.closeLayer(dialog);
                                const msgEl = $('#webdavMessage');
                                msgEl.textContent = '没有可用的备份';
                                msgEl.className = 'webdav-message';
                            }
                        } catch (err) {
                            this.showToast('删除失败: ' + err.message, 'error');
                            btn.disabled = false;
                            btn.textContent = '删除';
                        }
                    };
                });
            } catch (e) {
                msgEl.textContent = '获取列表失败: ' + e.message;
                msgEl.className = 'webdav-message error';
            }
        }

        showRestoreOptionsDialog(backup, parentDialog) {
            const hasConfig = !!(backup.configFile || backup.legacyFile);
            const hasBookmarks = !!(backup.bookmarksFile || backup.legacyFile);
            const hasModules = !!backup.modulesFile;
            const hasTimeline = !!backup.timelineFile;
            // 「只恢复 X」那一组里只剩一项可选时（例如只含时间线的自动槽位），
            // 把它默认选中。⚠️ 判据是**可选项恰好一个**，不是「四项全无」——
            // 后者恒为假（能渲染出单选就说明至少有一项），于是两个 radio 都不
            // checked，`:checked` 取到 null、`.value` 抛在 handler 里，
            // 表现是「点『确认恢复』什么都不发生」。
            const optionCount = [hasConfig, hasBookmarks, hasModules, hasTimeline].filter(Boolean).length;
            const soleOptionChecked = optionCount === 1 ? 'checked' : '';

            const optionsDialog = html(`
                <div class="fav-dialog-overlay" id="restoreOptionsDialog">
                    <div class="fav-dialog">
                        <h3>选择恢复内容</h3>
                        <div class="restore-options">
                            ${hasConfig && hasBookmarks ? `
                            <label class="restore-option">
                                <input type="radio" name="restoreType" value="all" checked>
                                <span>同时恢复配置和书签${(hasModules || hasTimeline) ? `（含${[hasModules && '模块设置', hasTimeline && '时间线'].filter(Boolean).join('与')}）` : ''}</span>
                            </label>
                            ` : ''}
                            ${hasConfig ? `
                            <label class="restore-option">
                                <input type="radio" name="restoreType" value="config" ${hasBookmarks ? '' : 'checked'}>
                                <span>只恢复配置（主题、搜索引擎、书签分类）</span>
                            </label>
                            ` : ''}
                            ${hasBookmarks ? `
                            <label class="restore-option">
                                <input type="radio" name="restoreType" value="bookmarks" ${hasConfig ? '' : 'checked'}>
                                <span>只恢复书签</span>
                            </label>
                            ` : ''}
                            ${hasModules ? `
                            <label class="restore-option">
                                <input type="radio" name="restoreType" value="modules" ${soleOptionChecked}>
                                <span>只恢复模块设置（监控目标、布局、token）</span>
                            </label>
                            ` : ''}
                            ${hasTimeline ? `
                            <label class="restore-option">
                                <input type="radio" name="restoreType" value="timeline" ${soleOptionChecked}>
                                <span>只恢复时间线（事件与已读 / 归档状态；凭据需重新填写）</span>
                            </label>
                            ` : ''}
                        </div>
                        <div class="fav-dialog-actions">
                            <button class="btn" id="restoreOptionsCancelBtn">取消</button>
                            <button class="btn btn-primary" id="restoreOptionsConfirmBtn">确认恢复</button>
                        </div>
                    </div>
                </div>
            `);

            this.mountLayer(optionsDialog);

            $('#restoreOptionsCancelBtn').onclick = () => this.closeLayer(optionsDialog);
            $('#restoreOptionsConfirmBtn').onclick = async () => {
                const restoreType = $('input[name="restoreType"]:checked').value;
                const restoreConfig = restoreType === 'all' || restoreType === 'config';
                const restoreBookmarks = restoreType === 'all' || restoreType === 'bookmarks';
                const restoreModules = restoreType === 'all' || restoreType === 'modules';
                // 时间线是「整表替换」：选了 all 就一起恢复；只想动时间线时也有单独一项。
                // 凭据不随备份，恢复后来源显示「待授权」。
                const restoreTimeline = restoreType === 'all' || restoreType === 'timeline';
                if (!await this.confirmAction('恢复将覆盖当前对应的数据，确定继续吗？', '确认恢复')) return;

                optionsDialog.querySelector('.btn-primary').disabled = true;
                optionsDialog.querySelector('.btn-primary').textContent = '恢复中...';

                try {
                    const restoreRes = await API.post('/api/webdav/restore', {
                        configFile: backup.configFile,
                        bookmarksFile: backup.bookmarksFile,
                        modulesFile: backup.modulesFile,
                        timelineFile: backup.timelineFile,
                        legacyFile: backup.legacyFile,
                        restoreConfig,
                        restoreBookmarks,
                        restoreModules,
                        restoreTimeline
                    });

                    if (restoreRes.success) {
                        this.closeLayer(optionsDialog);
                        this.closeLayer(parentDialog);
                        await this.notice('恢复成功，页面即将刷新。', '恢复完成');
                        location.reload();
                    } else {
                        this.showToast(restoreRes.error || '恢复失败', 'error');
                        optionsDialog.querySelector('.btn-primary').disabled = false;
                        optionsDialog.querySelector('.btn-primary').textContent = '确认恢复';
                    }
                } catch (e) {
                    this.showToast('恢复失败: ' + e.message, 'error');
                    optionsDialog.querySelector('.btn-primary').disabled = false;
                    optionsDialog.querySelector('.btn-primary').textContent = '确认恢复';
                }
            };
        }

        formatSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        }

        toggleSection(sectionId) {
            const section = $(`#${sectionId}Section`);
            const header = section?.previousElementSibling;
            if (section && header) {
                section.classList.toggle('collapsed');
                header.classList.toggle('expanded');
                const expanded = !section.classList.contains('collapsed');
                header.setAttribute('aria-expanded', String(expanded));
                header.querySelector('.section-toggle-label').textContent = expanded ? '收起' : '展开';
                // 折叠区块改为**首次展开时**才拉数据。此前在 renderAdminPanel 末尾
                // 就预取，每次重渲染（保存配置、增删分类等）都会多打一次请求，
                // 累积起来会撞上管理接口的限流。
                //
                // 判据是 webdavRendered（这份配置有没有画进当前这块 DOM），
                // **不是 webdavConfig（配置在不在内存里）**。面板每重建一次，
                // #webdavSection 就是一个新的「加载中...」节点，而 webdavConfig
                // 还留着上一份——用后者当条件，展开时条件为假、不发请求，
                // 占位符永远留在页面上，用户看到的就是「展开失败」。
                if (expanded && sectionId === 'webdav' && !this.webdavRendered) {
                    this.loadWebDAVConfig();
                }
            }
        }

        renderEnginesEditor() {
            const container = $('#enginesEditor');
            container.innerHTML = this.config.searchEngines.map((e, i) => `
                <div class="item" data-idx="${i}">
                    <div class="item-row">
                        <input type="text" value="${this.esc(e.name)}" data-field="name" placeholder="名称">
                        <input type="text" value="${this.esc(e.url)}" data-field="url" placeholder="URL">
                        <button class="btn btn-danger btn-sm del-engine">删除</button>
                    </div>
                </div>
            `).join('');

            container.oninput = (e) => {
                const item = e.target.closest('.item');
                if (!item) return;
                const idx = +item.dataset.idx;
                const field = e.target.dataset.field;
                if (field) {
                    this.config.searchEngines[idx][field] = e.target.value;
                    this.markConfigDirty();
                }
            };

            container.onclick = (e) => {
                if (e.target.classList.contains('del-engine')) {
                    const idx = +e.target.closest('.item').dataset.idx;
                    if (this.config.searchEngines.length <= 1) { this.showToast('至少保留一个搜索引擎', 'error'); return; }
                    const deleted = this.config.searchEngines.splice(idx, 1)[0];
                    if (this.config.searchEngine === deleted.id) {
                        this.config.searchEngine = this.config.searchEngines[0].id;
                    }
                    this.renderEnginesEditor();
                    this.markConfigDirty();
                }
            };
        }


        async save() {
            const button = $('#saveBtn');
            if (button.disabled) return;
            this.configSaving = true;
            button.disabled = true;
            $('#modalBody').inert = true;
            button.textContent = '保存中...';
            this.updateConfigStatus('正在保存到服务器', 'pending');
            try {
                const res = await API.post('/api/config', this.config);
                if (res.success) {
                    this.configDirty = false;
                    this.render();
                    await this.closeAdmin(true);
                    this.showToast('设置已保存到服务器');
                } else {
                    this.updateConfigStatus(res.error || '保存失败，请重试', 'error');
                }
            } catch (e) {
                this.updateConfigStatus('保存失败，请检查连接后重试', 'error');
            } finally {
                this.configSaving = false;
                $('#modalBody').inert = false;
                button.disabled = false;
                button.textContent = '保存';
            }
        }

        // ========== 收藏夹 ==========

        async handleFavImport(e) {
            const file = e.target.files[0];
            if (!file) return;

            const htmlContent = await file.text();

            try {
                const res = await API.post('/api/favorites/import', { html: htmlContent, merge: true });
                if (res.success) {
                    this.showToast(`导入成功，新增 ${res.imported} 个书签${res.duplicates ? `，跳过 ${res.duplicates} 个重复` : ''}`);
                    await this.loadFavorites();
                    this.renderAdminPanel();
                } else {
                    this.showToast(res.error || '导入失败', 'error');
                }
            } catch (err) {
                this.showToast('导入失败: ' + err.message, 'error');
            }

            e.target.value = '';
        }

        async exportFavorites() {
            try {
                // binary=true：让 request 不碰 body，流留给 res.blob()
                const { res } = await API.request('/api/favorites/export', undefined, true);
                if (!res.ok) {
                    // 错误分支需要一个可读的 message；body 尚未被读，这里可以安全解析
                    let message = '导出失败';
                    try { message = (await res.json())?.error || message; } catch (e) {}
                    this.showToast(message, 'error');
                    return;
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'bookmarks.html';
                a.click();
                URL.revokeObjectURL(url);
            } catch (err) {
                this.showToast('导出失败: ' + err.message, 'error');
            }
        }

        showAddFavDialog() {
            // 获取现有分类列表
            const existingCategories = [...new Set(this.favorites.map(f => f.category).filter(Boolean))];
            const categoryOptions = existingCategories.length > 0
                ? existingCategories.map(c => `<option value="${this.esc(c)}">${this.esc(c)}</option>`).join('')
                : '';

            const dialog = html(`
                <div class="fav-dialog-overlay" id="favDialog">
                    <div class="fav-dialog">
                        <h3>添加书签</h3>
                        <div class="fav-form">
                            <label class="field-label">标题<input type="text" id="favTitle" required></label>
                            <label class="field-label">URL<input type="url" id="favUrl" required></label>
                            <label class="field-label">描述<input type="text" id="favDesc"></label>
                            <div class="fav-category-row">
                                ${existingCategories.length > 0 ? `
                                    <label class="field-label">已有分类<select id="favCategorySelect">
                                        <option value="">-- 选择分类 --</option>
                                        ${categoryOptions}
                                        <option value="__new__">+ 新建分类</option>
                                    </select></label>
                                ` : ''}
                                <label class="field-label">${existingCategories.length > 0 ? '新分类' : '分类'}<input type="text" id="favCategory" placeholder="${existingCategories.length > 0 ? '或输入新分类' : '可选'}"></label>
                            </div>
                            <label class="field-label">标签<input type="text" id="favTags" placeholder="逗号分隔，可选"></label>
                            <label class="fav-checkbox-row">
                                <input type="checkbox" id="favPrivate">
                                <span>隐私保护</span>
                            </label>
                        </div>
                        <div class="fav-dialog-actions">
                            <button class="btn" id="favCancelBtn">取消</button>
                            <button class="btn btn-primary" id="favSaveBtn">保存</button>
                        </div>
                    </div>
                </div>
            `);

            this.mountLayer(dialog);

            // 分类选择联动
            const categorySelect = $('#favCategorySelect');
            const categoryInput = $('#favCategory');
            if (categorySelect) {
                categorySelect.onchange = (e) => {
                    if (e.target.value === '__new__') {
                        categoryInput.focus();
                        categorySelect.value = '';
                    } else if (e.target.value) {
                        categoryInput.value = e.target.value;
                    }
                };
            }

            $('#favCancelBtn').onclick = () => this.closeLayer(dialog);
            $('#favSaveBtn').onclick = async () => {
                const title = $('#favTitle').value.trim();
                const url = $('#favUrl').value.trim();

                if (!title || !url) {
                    this.showToast('标题和 URL 不能为空', 'error');
                    return;
                }

                // 优先使用下拉选择的分类，否则使用输入的
                let category = categoryInput.value.trim();
                if (categorySelect && categorySelect.value && categorySelect.value !== '__new__') {
                    category = categorySelect.value;
                }

                const newFav = {
                    id: 'fav_' + Math.random().toString(36).slice(2, 11),
                    title,
                    url,
                    description: $('#favDesc').value.trim(),
                    category,
                    tags: $('#favTags').value.split(',').map(t => t.trim()).filter(Boolean),
                    private: $('#favPrivate').checked,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };

                const button = $('#favSaveBtn');
                button.disabled = true;
                button.textContent = '保存中...';
                this.favorites.unshift(newFav);
                if (!await this.saveFavorites()) {
                    this.favorites.shift();
                    button.disabled = false;
                    button.textContent = '保存';
                    return;
                }
                this.closeLayer(dialog);
                this.renderAdminPanel();
            };
        }

        async saveFavorites() {
            try {
                const res = await API.post('/api/favorites', { favorites: this.favorites });
                if (res.success) {
                    this.buildSearchIndex();
                    this.showToast('书签已保存到服务器');
                    return true;
                } else {
                    this.showToast(res.error || '保存失败', 'error');
                }
            } catch (err) {
                this.showToast('保存失败: ' + err.message, 'error');
            }
            return false;
        }

        /** 收藏夹分区头部的「共 N 个书签」。
         *  管理器只重绘 #favManagerHost，头部不在其中，所以每次数据变化后
         *  都必须主动刷新：否则在 tab 内删除/导入后，这一行会停在旧值
         *  （从前它与列表分处两个 tab，看不出来）。 */
        updateFavStat() {
            const count = $('.fav-stats strong');
            if (count) count.textContent = this.favoritesLoading ? '加载中' : this.favorites.length;
        }

        // 收藏管理器：渲染进后台「收藏夹」tab 的 #favManagerHost。
        // 各编辑路径（添加/编辑/删除/批量隐私/分类/拖拽）都即时
        // 落盘并调用 renderFavManager() 原地重绘——不再整块替换
        // #modalBody。「← 返回」随之移除：分区切换交给 tab 栏，
        // 原返回按钮里的 saveFavorites() 兜底因所有路径都已即时
        // 保存而成为死代码。
        renderFavManager() {
            const host = $('#favManagerHost');
            if (!host) return;
            this.favManagerPage = 0;
            // Preserve filter if already set, otherwise reset
            if (!this.favManagerCurrentCategory) {
                this.favManagerCurrentCategory = '';
            }
            this.favManagerFiltered = null;
            this.favManagerSelected = new Set();

            // 按分类统计并构建树状结构
            const categoryStats = {};
            this.favorites.forEach(f => {
                const cat = f.category || '未分类';
                categoryStats[cat] = (categoryStats[cat] || 0) + 1;
            });

            // 如果当前选中的分类不存在于统计中，手动添加（空分类）
            if (this.favManagerCurrentCategory && !categoryStats[this.favManagerCurrentCategory]) {
                categoryStats[this.favManagerCurrentCategory] = 0;
            }

            // 构建树状分类结构
            const categoryTree = this.buildCategoryTree(categoryStats);

            host.innerHTML = `
                <div class="fav-manager fav-manager-split">
                    <div class="fav-manager-sidebar" id="categorySidebar">
                        <div class="sidebar-header">
                            <span class="sidebar-title">分类</span>
                            <button class="btn btn-sm" id="addCategoryBtn" title="新建分类">+</button>
                        </div>
                        <div class="category-tree" id="categoryTree">
                            <div class="category-tree-item ${!this.favManagerCurrentCategory ? 'active' : ''}"
                                 data-category="" data-drop-target="true">
                                <span class="tree-toggle-placeholder" aria-hidden="true"></span>
                                <button class="category-tree-select" type="button" aria-label="全部书签" aria-current="${!this.favManagerCurrentCategory ? 'true' : 'false'}">
                                    <span class="tree-item-icon" aria-hidden="true">▦</span>
                                    <span class="tree-item-name">全部书签</span>
                                </button>
                                <span class="tree-item-count">${this.favorites.length}</span>
                            </div>
                            ${this.renderCategoryTree(categoryTree, 0)}
                            <div class="category-tree-item category-tree-new" data-category="__new__" data-drop-target="true">
                                <span class="tree-toggle-placeholder" aria-hidden="true"></span>
                                <button class="category-tree-select" type="button" aria-label="新建分类">
                                    <span class="tree-item-icon" aria-hidden="true">＋</span>
                                    <span class="tree-item-name">新建分类...</span>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="fav-manager-main">
                        <div class="fav-manager-header">
                            <input type="text" id="favManagerSearch" placeholder="搜索书签（支持拼音）..." class="fav-manager-search">
                        </div>
                        <div class="fav-batch-bar" id="favBatchBar">
                            <label class="fav-select-all">
                                <input type="checkbox" id="selectAllFav">
                                <span>全选</span>
                            </label>
                            <span class="fav-selected-count" id="favSelectedCount"></span>
                            <button class="btn btn-sm" id="privacySelectedBtn" disabled>隐私</button>
                            <button class="btn btn-danger btn-sm" id="deleteSelectedBtn" disabled>删除选中</button>
                        </div>
                        <div class="fav-manager-stats" id="favManagerStats"></div>
                        <div class="fav-manager-list" id="favManagerList"></div>
                        <div class="fav-manager-footer" id="favManagerFooter"></div>
                    </div>
                </div>
            `;

            // 绑定事件
            $('#favManagerSearch').oninput = (e) => this.debouncedFilterFavManager(e.target.value, this.favManagerCurrentCategory);
            $('#addCategoryBtn').onclick = () => this.promptNewCategory();

            // Batch selection
            $('#selectAllFav').onchange = (e) => this.toggleSelectAllFav(e.target.checked);
            $('#privacySelectedBtn').onclick = () => this.privacySelectedFavorites();
            $('#deleteSelectedBtn').onclick = () => this.deleteSelectedFavorites();

            // Category tree events
            this.bindCategoryTree();

            // Apply current filter
            if (this.favManagerCurrentCategory) {
                this.filterFavManager('', this.favManagerCurrentCategory);
            } else {
                this.renderFavManagerList(this.favorites);
            }
            // 头部计数不在 #favManagerHost 内，得单独刷新
            this.updateFavStat();
        }

        // 构建树状分类结构
        buildCategoryTree(categoryStats) {
            const tree = {};
            Object.entries(categoryStats).forEach(([cat, count]) => {
                const parts = cat.split('/').filter(Boolean);
                let current = tree;
                let path = '';
                parts.forEach((part, i) => {
                    path = path ? `${path}/${part}` : part;
                    if (!current[part]) {
                        current[part] = {
                            name: part,
                            fullPath: path,
                            count: 0,
                            children: {}
                        };
                    }
                    // 只在叶子节点累加计数
                    if (i === parts.length - 1) {
                        current[part].count += count;
                    }
                    current = current[part].children;
                });
            });
            return tree;
        }

        // 渲染树状分类
        renderCategoryTree(tree, level) {
            let html = '';
            const entries = Object.entries(tree).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));

            for (const [name, node] of entries) {
                const hasChildren = Object.keys(node.children).length > 0;
                const isActive = this.favManagerCurrentCategory === node.fullPath;
                const indent = level * 16;
                const childrenId = hasChildren ? uid() : '';

                html += `
                    <div class="category-tree-item ${isActive ? 'active' : ''} ${hasChildren ? 'has-children' : ''}"
                         data-category="${this.esc(node.fullPath)}"
                         data-name="${this.esc(name)}"
                         data-drop-target="true"
                         style="padding-left: ${12 + indent}px">
                        ${hasChildren ? `<button class="tree-toggle" type="button" aria-label="折叠分类 ${this.esc(node.fullPath)}" aria-expanded="true" aria-controls="${childrenId}">▼</button>` : '<span class="tree-toggle-placeholder" aria-hidden="true"></span>'}
                        <button class="category-tree-select" type="button" aria-label="分类 ${this.esc(node.fullPath)}" aria-current="${isActive ? 'true' : 'false'}">
                            <span class="tree-item-icon" aria-hidden="true">▦</span>
                            <span class="tree-item-name">${this.esc(name)}</span>
                        </button>
                        <button class="tree-item-edit" type="button" title="编辑分类名称" aria-label="编辑分类 ${this.esc(node.fullPath)}">✎</button>
                        <span class="tree-item-count">${node.count}</span>
                    </div>
                `;

                if (hasChildren) {
                    html += `<div class="category-tree-children" id="${childrenId}">${this.renderCategoryTree(node.children, level + 1)}</div>`;
                }
            }
            return html;
        }

        // 绑定分类树事件
        bindCategoryTree() {
            const tree = $('#categoryTree');
            if (!tree) return;

            // 点击分类筛选
            tree.onclick = async (e) => {
                const item = e.target.closest('.category-tree-item');
                if (!item) return;

                // 点击展开/折叠按钮
                const toggle = e.target.closest('.tree-toggle');
                if (toggle) {
                    const children = item.nextElementSibling;
                    if (children && children.classList.contains('category-tree-children')) {
                        children.classList.toggle('collapsed');
                        const expanded = !children.classList.contains('collapsed');
                        toggle.textContent = expanded ? '▼' : '▶';
                        toggle.setAttribute('aria-expanded', String(expanded));
                        toggle.setAttribute('aria-label', `${expanded ? '折叠' : '展开'}分类 ${item.dataset.category}`);
                    }
                    return;
                }

                // 点击编辑按钮
                if (e.target.classList.contains('tree-item-edit')) {
                    e.stopPropagation();
                    this.editCategoryName(item);
                    return;
                }

                if (!e.target.closest('.category-tree-select')) return;

                // 新建分类
                if (item.classList.contains('category-tree-new')) {
                    this.promptNewCategory();
                    return;
                }

                const category = item.dataset.category;

                // 如果有选中的书签，询问是否移动到该分类
                if (this.favManagerSelected && this.favManagerSelected.size > 0 && category) {
                    const count = this.favManagerSelected.size;
                    if (await this.confirmAction(`是否将选中的 ${count} 个书签移动到「${category || '未分类'}」？`, '移动书签')) {
                        this.favorites.forEach(f => {
                            if (this.favManagerSelected.has(f.id)) {
                                f.category = category;
                                f.updatedAt = Date.now();
                            }
                        });
                        this.favManagerSelected.clear();
                        await this.saveFavorites();
                        this.renderFavManager();
                        return;
                    }
                }

                // 选择分类筛选
                this.favManagerCurrentCategory = category;
                $$('.category-tree-item', tree).forEach(el => el.classList.remove('active'));
                $$('.category-tree-select[aria-current="true"]', tree).forEach(el => el.setAttribute('aria-current', 'false'));
                item.classList.add('active');
                item.querySelector('.category-tree-select').setAttribute('aria-current', 'true');
                this.filterFavManager($('#favManagerSearch')?.value || '', category);
            };

            // 拖拽支持
            tree.ondragover = (e) => {
                e.preventDefault();
                const item = e.target.closest('.category-tree-item[data-drop-target]');
                if (item) item.classList.add('drag-over');
            };

            tree.ondragleave = (e) => {
                const item = e.target.closest('.category-tree-item');
                if (item) item.classList.remove('drag-over');
            };

            tree.ondrop = async (e) => {
                e.preventDefault();
                const item = e.target.closest('.category-tree-item[data-drop-target]');
                if (!item) return;
                item.classList.remove('drag-over');

                const favId = e.dataTransfer.getData('text/plain');
                if (!favId) return;

                let newCategory = item.dataset.category;

                if (newCategory === '__new__') {
                    newCategory = await this.promptValue('新建分类', '分类名称');
                    if (!newCategory || !newCategory.trim()) return;
                    newCategory = newCategory.trim();
                }

                const fav = this.favorites.find(f => f.id === favId);
                if (fav && fav.category !== newCategory) {
                    fav.category = newCategory;
                    fav.updatedAt = Date.now();
                    await this.saveFavorites();
                    this.renderFavManager();
                }
            };
        }

        // 编辑分类名称
        editCategoryName(item) {
            const fullPath = item.dataset.category;
            const currentName = item.dataset.name;
            if (!fullPath) return;

            const nameSpan = item.querySelector('.tree-item-name');
            if (!nameSpan || nameSpan.classList.contains('editing')) return;

            // 创建输入框
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'tree-item-edit-input';
            input.value = currentName;

            // 隐藏原名称，显示输入框
            nameSpan.classList.add('editing');
            const selectButton = item.querySelector('.category-tree-select');
            selectButton.hidden = true;
            item.insertBefore(input, item.querySelector('.tree-item-edit'));
            input.focus();
            input.select();

            const cleanup = () => {
                nameSpan.classList.remove('editing');
                selectButton.hidden = false;
                input.remove();
            };

            let saving = false;
            let blurTimer;
            const save = async () => {
                if (saving) return;
                saving = true;
                clearTimeout(blurTimer);
                try {
                    const newName = input.value.trim();

                    // 验证
                    if (!newName) {
                        cleanup();
                        return;
                    }

                    if (newName === currentName) {
                        cleanup();
                        return;
                    }

                    if (newName.includes('/')) {
                        this.showToast('分类名称不能包含 "/" 字符', 'error');
                        input.focus();
                        return;
                    }

                    // 计算新的完整路径
                    const pathParts = fullPath.split('/');
                    pathParts[pathParts.length - 1] = newName;
                    const newFullPath = pathParts.join('/');

                    // 检查是否与现有分类重名
                    const existingCategories = new Set(
                        this.favorites.map(f => f.category).filter(Boolean)
                    );

                    if (existingCategories.has(newFullPath) && newFullPath !== fullPath) {
                        if (!await this.confirmAction(`分类「${newFullPath}」已存在，是否合并？`, '合并分类')) {
                            input.focus();
                            return;
                        }
                    }

                    // 批量更新书签分类
                    let updated = false;
                    this.favorites.forEach(f => {
                        if (!f.category) return;

                        // 精确匹配当前分类
                        if (f.category === fullPath) {
                            f.category = newFullPath;
                            f.updatedAt = Date.now();
                            updated = true;
                        }
                        // 匹配子分类（以 fullPath/ 开头）
                        else if (f.category.startsWith(fullPath + '/')) {
                            f.category = newFullPath + f.category.slice(fullPath.length);
                            f.updatedAt = Date.now();
                            updated = true;
                        }
                    });

                    if (updated) {
                        await this.saveFavorites();
                        // 更新当前选中的分类
                        if (this.favManagerCurrentCategory === fullPath) {
                            this.favManagerCurrentCategory = newFullPath;
                        } else if (this.favManagerCurrentCategory?.startsWith(fullPath + '/')) {
                            this.favManagerCurrentCategory = newFullPath + this.favManagerCurrentCategory.slice(fullPath.length);
                        }
                        this.renderFavManager();
                    } else {
                        cleanup();
                    }
                } finally {
                    saving = false;
                }
            };

            input.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    save();
                } else if (e.key === 'Escape') {
                    cleanup();
                }
            };

            input.onblur = () => {
                if (saving) return;
                // 延迟执行，避免与点击保存冲突
                blurTimer = setTimeout(() => {
                    if (document.body.contains(input) && !saving) {
                        save();
                    }
                }, 100);
            };
        }

        // 新建分类
        async promptNewCategory() {
            const name = await this.promptValue('新建分类', '分类名称', { placeholder: '例如 工具/开发' });
            if (!name || !name.trim()) return;

            const categoryName = name.trim();

            // 检查是否有选中的书签，如果有则移动到新分类
            if (this.favManagerSelected && this.favManagerSelected.size > 0) {
                this.favorites.forEach(f => {
                    if (this.favManagerSelected.has(f.id)) {
                        f.category = categoryName;
                        f.updatedAt = Date.now();
                    }
                });
                this.favManagerSelected.clear();
                await this.saveFavorites();
            }

            // 设置当前分类并刷新
            this.favManagerCurrentCategory = categoryName;
            this.renderFavManager();
        }

        bindCategoryDropZones() {
            // 已被 bindCategoryTree 替代
        }

        toggleSelectAllFav(checked) {
            const checkboxes = $$('.fav-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = checked;
                const id = cb.closest('.fav-manager-item')?.dataset.id;
                if (id) {
                    if (checked) {
                        this.favManagerSelected.add(id);
                    } else {
                        this.favManagerSelected.delete(id);
                    }
                }
            });
            this.updateBatchBar();
        }

        updateBatchBar() {
            const count = this.favManagerSelected.size;
            const countEl = $('#favSelectedCount');
            const deleteBtn = $('#deleteSelectedBtn');
            const privacyBtn = $('#privacySelectedBtn');
            const selectAllCb = $('#selectAllFav');

            if (countEl) countEl.textContent = count > 0 ? `已选 ${count} 项` : '';
            if (deleteBtn) deleteBtn.disabled = count === 0;
            if (privacyBtn) privacyBtn.disabled = count === 0;

            const checkboxes = $$('.fav-checkbox');
            if (selectAllCb && checkboxes.length > 0) {
                selectAllCb.checked = checkboxes.every(cb => cb.checked);
                selectAllCb.indeterminate = checkboxes.some(cb => cb.checked) && !selectAllCb.checked;
            }
        }

        async privacySelectedFavorites() {
            const targets = this.favorites.filter(f => this.favManagerSelected.has(f.id));
            if (targets.length === 0) return;

            // 混选时默认预选「设为私密」：批量操作里收紧可见性比放宽更安全，
            // 全部已私密才预选「设为公开」。
            const allPrivate = targets.every(f => f.private);
            const result = await this.showUiDialog({
                title: '批量设置隐私状态',
                message: `已选中 ${targets.length} 个书签`,
                options: [
                    { name: 'privacy', kind: 'radio', value: 'private', label: '设为私密', checked: !allPrivate },
                    {
                        name: 'privacy', kind: 'radio', value: 'public', label: '设为公开', checked: allPrivate,
                        // 两个方向的风险不对称：设为私密只是收紧可见性，
                        // 设为公开等于对未登录访客披露。只在同一弹窗里给披露方向加提示。
                        hint: '公开后，未登录的访客也能看到这些书签'
                    }
                ],
                confirmText: '应用'
            });
            if (!result) return;

            const makePrivate = result.choices.privacy === 'private';
            // 快照整个对象而非只记 private：本次同时推进了 updatedAt，
            // 只还原 private 会让时间戳停在一次失败的操作上。
            // 与 editFavorite 的回滚方式保持一致。
            const previous = targets.map(f => ({ ...f }));
            targets.forEach(f => {
                f.private = makePrivate;
                f.updatedAt = Date.now();
            });

            if (!await this.saveFavorites()) {
                targets.forEach((f, i) => Object.assign(f, previous[i]));
                this.renderFavManager();
                return;
            }
            this.renderFavManager();
            this.showToast(`已更新 ${targets.length} 个书签的隐私状态`, 'success');
        }

        async deleteSelectedFavorites() {
            const count = this.favManagerSelected.size;
            if (count === 0) return;

            if (!await this.confirmAction(`确定删除选中的 ${count} 个书签？`, '批量删除', true)) return;

            this.favorites = this.favorites.filter(f => !this.favManagerSelected.has(f.id));
            await this.saveFavorites();
            this.favManagerSelected.clear();
            // 检查当前分类是否还有书签，没有则重置为全部
            if (this.favManagerCurrentCategory) {
                const hasRemaining = this.favorites.some(f =>
                    f.category === this.favManagerCurrentCategory ||
                    f.category?.startsWith(this.favManagerCurrentCategory + '/')
                );
                if (!hasRemaining) {
                    this.favManagerCurrentCategory = '';
                }
            }
            this.renderFavManager();
        }

        debouncedFilterFavManager(query, category) {
            if (this.searchDebounceTimer) {
                clearTimeout(this.searchDebounceTimer);
            }
            this.searchDebounceTimer = setTimeout(() => {
                this.filterFavManager(query, category);
            }, 80);
        }

        filterFavManager(query, category) {
            this.favManagerPage = 0;
            let filtered = this.favorites;

            // 先按分类过滤（支持树状结构，选择父分类时也显示子分类内容）
            if (category) {
                filtered = filtered.filter(f => {
                    const favCat = f.category || '未分类';
                    // 精确匹配或前缀匹配（子分类）
                    return favCat === category || favCat.startsWith(category + '/');
                });
            }

            // 再按关键词过滤
            if (query && query.trim()) {
                const q = query.trim().toLowerCase();

                // 使用 uFuzzy 进行模糊搜索
                if (this.uf && this.favHaystack && this.favHaystack.length > 0) {
                    const idxs = this.uf.filter(this.favHaystack, q);
                    if (idxs && idxs.length > 0) {
                        const matchedIds = new Set(idxs.map(i => this.favorites[i]?.id).filter(Boolean));
                        filtered = filtered.filter(f => matchedIds.has(f.id));
                    } else {
                        // uFuzzy 没有匹配，尝试简单包含搜索
                        filtered = filtered.filter(f => {
                            const searchText = [
                                f.title || '',
                                f.url || '',
                                f.category || '',
                                f.description || '',
                                (f.tags || []).join(' ')
                            ].join(' ').toLowerCase();
                            return searchText.includes(q);
                        });
                    }
                } else {
                    // 没有 uFuzzy，使用简单搜索
                    filtered = filtered.filter(f => {
                        const searchText = [
                            f.title || '',
                            f.url || '',
                            f.category || '',
                            f.description || '',
                            (f.tags || []).join(' ')
                        ].join(' ').toLowerCase();
                        return searchText.includes(q);
                    });
                }
            }

            this.favManagerFiltered = filtered;
            this.renderFavManagerList(filtered);
        }

        renderFavManagerList(favs) {
            const list = $('#favManagerList');
            const footer = $('#favManagerFooter');
            const stats = $('#favManagerStats');

            if (!list) return;

            const total = favs.length;
            const pageSize = this.favManagerPageSize;
            const start = this.favManagerPage * pageSize;
            const end = Math.min(start + pageSize, total);
            const pageFavs = favs.slice(start, end);
            const totalPages = Math.ceil(total / pageSize);

            // 更新统计
            if (stats) {
                if (total === 0) {
                    stats.innerHTML = '';
                } else if (total <= pageSize) {
                    stats.innerHTML = `<span>共 ${total} 项</span>`;
                } else {
                    stats.innerHTML = `<span>显示 ${start + 1}-${end} / 共 ${total} 项</span>`;
                }
            }

            if (total === 0) {
                list.innerHTML = '<div class="fav-empty">无匹配结果</div>';
                if (footer) footer.innerHTML = '';
                return;
            }

            // 渲染列表项（带复选框和拖拽支持）
            list.innerHTML = pageFavs.map(fav => `
                <div class="fav-manager-item" data-id="${fav.id}" draggable="true">
                    <input type="checkbox" class="fav-checkbox" ${this.favManagerSelected?.has(fav.id) ? 'checked' : ''}>
                    <span class="fav-drag-handle">⋮⋮</span>
                    <div class="fav-manager-info">
                        <a href="${this.esc(fav.url)}" target="_blank" rel="noopener noreferrer" class="fav-manager-title-link">
                            <div class="fav-manager-title">${this.esc(fav.title)}</div>
                        </a>
                        <div class="fav-manager-url">${this.esc(fav.url)}</div>
                    </div>
                    ${fav.category ? `<span class="fav-manager-category">${this.esc(fav.category)}</span>` : ''}
                    ${fav.private ? '<span class="fav-private-label">私密</span>' : ''}
                    <div class="fav-manager-actions">
                        <button class="btn btn-sm edit-fav">编辑</button>
                        <button class="btn btn-sm btn-danger del-fav">删除</button>
                    </div>
                </div>
            `).join('');

            // 分页控件
            if (footer && totalPages > 1) {
                footer.innerHTML = `
                    <div class="fav-pagination">
                        <button class="btn btn-sm" id="favPrevPage" ${this.favManagerPage === 0 ? 'disabled' : ''}>上一页</button>
                        <span class="fav-page-info">${this.favManagerPage + 1} / ${totalPages}</span>
                        <button class="btn btn-sm" id="favNextPage" ${this.favManagerPage >= totalPages - 1 ? 'disabled' : ''}>下一页</button>
                    </div>
                `;
                $('#favPrevPage').onclick = () => {
                    if (this.favManagerPage > 0) {
                        this.favManagerPage--;
                        this.renderFavManagerList(this.favManagerFiltered || this.favorites);
                        list.scrollTop = 0;
                    }
                };
                $('#favNextPage').onclick = () => {
                    if (this.favManagerPage < totalPages - 1) {
                        this.favManagerPage++;
                        this.renderFavManagerList(this.favManagerFiltered || this.favorites);
                        list.scrollTop = 0;
                    }
                };
            } else if (footer) {
                footer.innerHTML = '';
            }

            // 事件委托
            list.onclick = async (e) => {
                // 让链接自行处理点击
                if (e.target.closest('.fav-manager-title-link')) {
                    return;
                }

                const item = e.target.closest('.fav-manager-item');
                if (!item) return;
                const id = item.dataset.id;

                if (e.target.classList.contains('fav-checkbox')) {
                    if (e.target.checked) {
                        this.favManagerSelected.add(id);
                    } else {
                        this.favManagerSelected.delete(id);
                    }
                    this.updateBatchBar();
                } else if (e.target.classList.contains('del-fav')) {
                    if (await this.confirmAction('确定删除此书签？', '删除书签', true)) {
                        this.favorites = this.favorites.filter(f => f.id !== id);
                        await this.saveFavorites();
                        this.favManagerSelected.delete(id);
                        // 检查当前分类是否还有书签，没有则重置为全部
                        if (this.favManagerCurrentCategory) {
                            const hasRemaining = this.favorites.some(f =>
                                f.category === this.favManagerCurrentCategory ||
                                f.category?.startsWith(this.favManagerCurrentCategory + '/')
                            );
                            if (!hasRemaining) {
                                this.favManagerCurrentCategory = '';
                            }
                        }
                        // 刷新整个管理界面（包括分类树，以便空分类自动消失）
                        this.renderFavManager();
                    }
                } else if (e.target.classList.contains('edit-fav')) {
                    this.editFavorite(id);
                }
            };

            // 拖拽事件
            list.ondragstart = (e) => {
                const item = e.target.closest('.fav-manager-item');
                if (item) {
                    e.dataTransfer.setData('text/plain', item.dataset.id);
                    item.classList.add('dragging');
                }
            };

            list.ondragend = (e) => {
                const item = e.target.closest('.fav-manager-item');
                if (item) item.classList.remove('dragging');
            };
        }

        editFavorite(id) {
            const fav = this.favorites.find(f => f.id === id);
            if (!fav) return;

            const dialog = html(`
                <div class="fav-dialog-overlay" id="favEditDialog">
                    <div class="fav-dialog">
                        <h3>编辑书签</h3>
                        <div class="fav-form">
                            <label class="field-label">标题<input type="text" id="editFavTitle" value="${this.esc(fav.title)}" required></label>
                            <label class="field-label">URL<input type="url" id="editFavUrl" value="${this.esc(fav.url)}" required></label>
                            <label class="field-label">描述<input type="text" id="editFavDesc" value="${this.esc(fav.description || '')}"></label>
                            <label class="field-label">分类<input type="text" id="editFavCategory" value="${this.esc(fav.category || '')}"></label>
                            <label class="field-label">标签<input type="text" id="editFavTags" value="${this.esc((fav.tags || []).join(', '))}"></label>
                            <label class="fav-checkbox-row">
                                <input type="checkbox" id="editFavPrivate" ${fav.private ? 'checked' : ''}>
                                <span>隐私保护</span>
                            </label>
                        </div>
                        <div class="fav-dialog-actions">
                            <button class="btn" id="editFavCancelBtn">取消</button>
                            <button class="btn btn-primary" id="editFavSaveBtn">保存</button>
                        </div>
                    </div>
                </div>
            `);

            this.mountLayer(dialog);

            $('#editFavCancelBtn').onclick = () => this.closeLayer(dialog);
            $('#editFavSaveBtn').onclick = async () => {
                const previous = { ...fav };
                const button = $('#editFavSaveBtn');
                button.disabled = true;
                button.textContent = '保存中...';
                fav.title = $('#editFavTitle').value.trim();
                fav.url = $('#editFavUrl').value.trim();
                fav.description = $('#editFavDesc').value.trim();
                fav.category = $('#editFavCategory').value.trim();
                fav.tags = $('#editFavTags').value.split(',').map(t => t.trim()).filter(Boolean);
                fav.private = $('#editFavPrivate').checked;
                fav.updatedAt = Date.now();

                if (!await this.saveFavorites()) {
                    Object.assign(fav, previous);
                    button.disabled = false;
                    button.textContent = '保存';
                    return;
                }
                this.closeLayer(dialog);
                this.renderFavManager();
            };
        }

        async changePassword() {
            if (!this.authenticated) { await this.notice('请先进入管理模式'); return; }
            // 必须填当前密码：服务端只凭会话不放行改密码，
            // 这是为了防止拿到会话的人直接改掉密码完成接管。
            const values = await this.showUiDialog({
                title: '修改管理密码',
                fields: [
                    { label: '当前密码', type: 'password' },
                    { label: '新密码', type: 'password' },
                    { label: '再次输入新密码', type: 'password' }
                ],
                validate: ([cur, newPwd, repeated]) =>
                    !cur ? '请输入当前密码'
                        : newPwd.length < 8 ? '密码至少 8 位'
                        : newPwd !== repeated ? '两次输入不一致' : ''
            });
            if (!values) return;
            const currentPwd = values.values[0];
            const newPwd = values.values[1];

            const res = await API.post('/api/change-password', {
                currentPassword: currentPwd,
                newPassword: newPwd
            });
            if (res.success) {
                // 服务端改密码后终止了全部会话，本设备的凭据也已失效，需重新登录。
                this.authenticated = false;
                API.envChangeNotified = false;
                this.adminFavorites = null;
                // 全部会话已被销毁，模块区必须一起收起——否则页面一边提示
                // 「请重新登录」，一边还亮着只有登录态才有的模块入口。
                this.modulesConfig = null;
                this.modulesLoaded = false;
                this.modulesError = null;
                await this.syncModuleVisibility();
                this.showToast('密码已修改，请重新登录', 'success', 5000);

                // 未能迁移的凭据必须说出来——服务端为此专门收集了 details，
                // 但它到不了用户就等于没有：用户不知道哪台 agent 要重填 token，
                // 只会在某次备份或看监控时才撞上，那时已经想不起是改密码导致的。
                const moved = res.credentials && res.credentials.details;
                if (Array.isArray(moved) && moved.length) {
                    await this.notice(
                        `以下凭据未能随新密码重新加密，需要手动重新输入：\n\n· ${moved.join('\n· ')}`,
                        '凭据需要重新输入');
                }
            } else {
                this.showToast(res.error || '修改失败', 'error');
            }
        }

        esc(str) {
            return String(str ?? '').replace(/[&<>"']/g, char => ESC_MAP[char]);
        }
    }

    let app;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { app = new App(); window.app = app; });
    } else {
        app = new App();
        window.app = app;
    }

})(window);

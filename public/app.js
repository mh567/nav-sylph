((window) => {
    'use strict';

    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
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

    const API = {
        async get(url) {
            const res = await fetch(url);
            if (!res.ok) throw new Error(res.statusText);
            return res.json();
        },
        async post(url, data, password) {
            const headers = { 'Content-Type': 'application/json' };
            if (password) headers['X-Admin-Password'] = password;
            const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(data) });
            return res.json();
        }
    };

    class App {
        constructor() {
            this.config = null;
            this.password = null;
            this.dragData = null;
            this.pasteMode = false;
            // 收藏书签检索
            this.favorites = [];
            this.favSearchMode = false;
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
            this.init();
        }

        async init() {
            try {
                this.config = await API.get('/api/config');
                this.migrateConfig();
                // 加载收藏书签
                await this.loadFavorites();
                this.applyTheme();
                this.render();
                this.bind();
                $('#loader').remove();
                $('#app').hidden = false;
                // 版本检测（在页面加载完成后）
                await this.checkVersionUpdate();
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
        }

        applyTheme() {
            const theme = this.config.theme || 'auto';
            const root = document.documentElement;

            if (theme === 'auto') {
                // 跟随系统
                root.removeAttribute('data-theme');
            } else {
                // 强制指定主题
                root.setAttribute('data-theme', theme);
            }
        }

        render() {
            this.renderEngines();
            this.renderGrid();
        }

        renderEngines() {
            const current = this.config.searchEngines.find(e => e.id === this.config.searchEngine) || this.config.searchEngines[0];
            $('#engineName').textContent = current.name;
            
            const dropdown = $('#engineDropdown');
            dropdown.innerHTML = this.config.searchEngines.map(e => 
                `<div class="engine-option${e.id === this.config.searchEngine ? ' active' : ''}" data-id="${e.id}">${this.esc(e.name)}</div>`
            ).join('');
        }

        renderGrid() {
            const grid = $('#grid');
            grid.innerHTML = '';
            this.config.categories.forEach((cat, catIdx) => {
                const section = html(`
                    <section class="category" data-cat="${catIdx}">
                        <div class="category-header">
                            <h2 class="category-title">${this.esc(cat.name)}</h2>
                        </div>
                        <div class="bookmarks"></div>
                    </section>
                `);
                const bms = $('.bookmarks', section);
                cat.bookmarks.forEach((bm, bmIdx) => {
                    bms.appendChild(this.createBookmark(bm, catIdx, bmIdx));
                });
                grid.appendChild(section);
            });
        }

        createBookmark(bm, catIdx, bmIdx) {
            const showIcons = this.config.showBookmarkIcons !== false;
            const iconUrl = this.getFavicon(bm.url);
            
            if (showIcons) {
                return html(`
                    <a class="bookmark" href="${this.esc(bm.url)}" target="_blank" rel="noopener">
                        <img class="bookmark-icon" src="${iconUrl}" alt="" loading="lazy" 
                             onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2280%22>${bm.title[0] || '?'}</text></svg>'">
                        <span class="bookmark-title">${this.esc(bm.title)}</span>
                    </a>
                `);
            } else {
                return html(`
                    <a class="bookmark bookmark-text-only" href="${this.esc(bm.url)}" target="_blank" rel="noopener">
                        <span class="bookmark-title">${this.esc(bm.title)}</span>
                    </a>
                `);
            }
        }

        getFavicon(url) {
            try {
                const u = new URL(url);
                return `${u.origin}/favicon.ico`;
            } catch {
                return '';
            }
        }

        bind() {
            $('#searchForm').onsubmit = (e) => { e.preventDefault(); this.handleSearch(); };
            $('#searchInput').oninput = (e) => this.handleSearchInput(e);
            $('#adminBtn').onclick = () => this.openAdmin();
            $('#helpBtn').onclick = () => this.showHelp();
            $('#modalBackdrop').onclick = () => this.closeAdmin();
            $('#cancelBtn').onclick = () => this.closeAdmin();
            $('#saveBtn').onclick = () => this.save();

            const engineBtn = $('#engineBtn');
            const dropdown = $('#engineDropdown');
            
            engineBtn.onclick = (e) => {
                e.stopPropagation();
                const isOpen = !dropdown.hidden;
                dropdown.hidden = isOpen;
                engineBtn.classList.toggle('active', !isOpen);
            };
            
            dropdown.onclick = (e) => {
                const option = e.target.closest('.engine-option');
                if (option) {
                    this.config.searchEngine = option.dataset.id;
                    this.renderEngines();
                    dropdown.hidden = true;
                    engineBtn.classList.remove('active');
                    $('#searchInput').focus();
                }
            };
            
            document.onclick = (e) => {
                if (!e.target.closest('.search-wrapper')) {
                    dropdown.hidden = true;
                    engineBtn.classList.remove('active');
                }
            };

            document.onkeydown = (e) => {
                // 收藏检索模式的键盘导航
                if (this.favSearchMode && this.handleFavKeydown(e)) {
                    return;
                }

                if (e.key === 'Escape') {
                    if (!dropdown.hidden) {
                        dropdown.hidden = true;
                        engineBtn.classList.remove('active');
                    } else if (!$('#modal').hidden) {
                        this.closeAdmin();
                    }
                }
            };
        }

        moveBookmark(fromCat, fromBm, toCat, toBm) {
            const cats = this.config.categories;
            const [item] = cats[fromCat].bookmarks.splice(fromBm, 1);
            if (fromCat === toCat && fromBm < toBm) toBm--;
            cats[toCat].bookmarks.splice(toBm, 0, item);
            this.renderGrid();
        }

        moveCategory(from, to) {
            const cats = this.config.categories;
            const [item] = cats.splice(from, 1);
            cats.splice(to, 0, item);
            this.renderGrid();
        }

        search() {
            const q = $('#searchInput').value.trim();
            if (!q) return;
            const engine = this.config.searchEngines.find(e => e.id === this.config.searchEngine);
            if (engine) window.open(engine.url + encodeURIComponent(q), '_blank');
            $('#searchInput').value = '';
        }

        // ========== 收藏书签模糊检索 ==========

        async loadFavorites() {
            try {
                const data = await API.get('/api/favorites');
                this.favorites = data.favorites || [];
                this.buildSearchIndex();
            } catch (e) {
                console.error('Load favorites failed:', e);
                this.favorites = [];
            }
        }

        buildSearchIndex() {
            // 构建搜索索引
            this.favHaystack = this.favorites.map(f => {
                let hostname = '';
                try { hostname = new URL(f.url).hostname; } catch {}
                return `${f.title} | ${f.description || ''} | ${f.category || ''} | ${hostname} | ${(f.tags || []).join(' ')}`;
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

                    // 延迟弹出帮助窗口
                    setTimeout(() => {
                        this.showHelp();
                    }, 500);
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

        toggleFavSearchMode(enabled) {
            const form = $('#searchForm');
            const input = $('#searchInput');
            const searchBtn = $('.search-btn');

            form.classList.toggle('fav-search-mode', enabled);

            if (enabled) {
                input.placeholder = '搜索收藏书签...';
                $('#engineBtn').style.display = 'none';
                searchBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
                searchBtn.title = '收藏检索';
                this.showFavDropdown();
            } else {
                input.placeholder = '搜索...';
                $('#engineBtn').style.display = '';
                searchBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>';
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

            // 显示最近收藏
            this.renderFavResults(this.favorites.slice(0, 10), null, null);
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

            // 如果没有收藏，显示提示
            if (this.favorites.length === 0) {
                dropdown.innerHTML = '<div class="fav-empty">无收藏书签，请在管理面板中导入</div>';
                return;
            }

            if (!query) {
                this.renderFavResults(this.favorites.slice(0, 10), null, null, null);
                return;
            }

            // 如果 uFuzzy 未初始化，使用简单匹配
            if (!this.uf) {
                const q = query.toLowerCase();
                const filtered = this.favorites.filter(f =>
                    f.title.toLowerCase().includes(q) ||
                    (f.description || '').toLowerCase().includes(q) ||
                    (f.category || '').toLowerCase().includes(q) ||
                    f.url.toLowerCase().includes(q)
                ).slice(0, 15);
                this.renderFavResults(filtered, null, null, null);
                return;
            }

            // uFuzzy 搜索
            const idxs = this.uf.filter(this.favHaystack, query);

            if (!idxs || idxs.length === 0) {
                dropdown.innerHTML = '<div class="fav-empty">无匹配结果</div>';
                return;
            }

            const info = this.uf.info(idxs, this.favHaystack, query);
            const order = this.uf.sort(info, this.favHaystack, query);

            // 取前 15 个结果
            const topOrder = order.slice(0, 15);
            const results = topOrder.map(i => this.favorites[idxs[i]]);

            this.renderFavResults(results, info, topOrder, idxs);
        }

        renderFavResults(favs, info, order, idxs) {
            const dropdown = $('#favDropdown');
            if (!dropdown) return;

            if (favs.length === 0) {
                dropdown.innerHTML = '<div class="fav-empty">无收藏书签，请在管理面板中导入</div>';
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
                        <img class="fav-icon" src="${this.getFavicon(fav.url)}" alt=""
                             onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2280%22>${fav.title[0] || '?'}</text></svg>'">
                        <div class="fav-info">
                            <div class="fav-title">${titleHtml}</div>
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

        handleSearchInput(e) {
            const value = e.target.value;

            // 检查收藏检索模式
            const isFavMode = value.length > 0 && this.isFavSearchTrigger(value[0]);
            if (isFavMode !== this.favSearchMode) {
                this.favSearchMode = isFavMode;
                this.toggleFavSearchMode(isFavMode);
            }

            // 如果在收藏检索模式，执行防抖搜索
            if (this.favSearchMode) {
                const query = value.slice(1).trim();
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

        togglePasteMode(enabled) {
            const form = $('#searchForm');
            const input = $('#searchInput');
            const searchBtn = $('.search-btn');

            form.classList.toggle('paste-mode', enabled);

            if (enabled) {
                input.placeholder = '输入要分享的文本，回车发送...';
                // 隐藏搜索引擎选择
                $('#engineBtn').style.display = 'none';
                // 更改按钮图标为发送
                searchBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>';
                searchBtn.title = '发送分享';
            } else {
                input.placeholder = '搜索...';
                $('#engineBtn').style.display = '';
                // 恢复搜索图标
                searchBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>';
                searchBtn.title = '搜索';
            }
        }

        async handleSearch() {
            const value = $('#searchInput').value;

            // 收藏检索模式：回车打开选中结果
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
            // 简单确认是否需要 PIN
            const usePin = confirm('是否设置4位PIN码保护？\n\n点击「确定」设置PIN，点击「取消」直接分享');

            let pin = null;
            if (usePin) {
                pin = prompt('请输入4位数字PIN码：');
                if (pin && !/^\d{4}$/.test(pin)) {
                    alert('PIN码必须是4位数字');
                    return;
                }
                if (!pin) return; // 用户取消
            }

            await this.createPaste(content, pin);
        }

        async createPaste(content, pin = null) {
            try {
                // 先请求生成分享码
                const codeRes = await fetch('/api/p/code', { method: 'POST' });
                const codeData = await codeRes.json();

                if (!codeData.code) {
                    alert(codeData.error || '创建分享失败');
                    return;
                }

                const code = codeData.code;

                // 使用分享码进行端到端加密
                const encryptedContent = await Crypto.encrypt(content, code);

                const body = { code, content: encryptedContent };
                if (pin) body.pin = pin;

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
                    this.showPasteResult(code, !!pin);
                } else {
                    alert(data.error || '创建分享失败');
                }
            } catch (e) {
                alert('创建分享失败: ' + e.message);
            }
        }

        showPasteResult(code, hasPin = false) {
            this.hidePasteResult();

            // 简洁的 URL，无需密钥
            const url = `${location.origin}/p/${code}`;
            const pinInfo = hasPin ? '<div class="paste-pin-info">🔒 已设置PIN保护</div>' : '';
            const result = html(`
                <div class="paste-result" id="pasteResult">
                    <button class="paste-close" title="关闭">×</button>
                    <div class="paste-code">${this.esc(code)}</div>
                    ${pinInfo}
                    <div class="paste-link" data-url="${this.esc(url)}">📋 复制链接</div>
                    <div class="paste-expiry">5分钟后过期</div>
                </div>
            `);

            result.querySelector('.paste-close').onclick = () => this.hidePasteResult();

            result.querySelector('.paste-link').onclick = async (e) => {
                const link = e.target;
                const copyUrl = link.dataset.url;
                try {
                    await navigator.clipboard.writeText(copyUrl);
                    link.textContent = '✅ 已复制';
                    setTimeout(() => { link.textContent = '📋 复制链接'; }, 2000);
                } catch {
                    prompt('复制链接:', copyUrl);
                }
            };

            $('#searchForm').after(result);
        }

        hidePasteResult() {
            const existing = $('#pasteResult');
            if (existing) existing.remove();
        }

        showHelp() {
            const versionStr = this.currentVersion ? ` v${this.currentVersion}` : '';
            const newFeatures = this.getNewFeatures();

            let newFeaturesHtml = '';
            if (this.hasNewVersion && newFeatures) {
                const highlightsHtml = newFeatures.highlights
                    ? newFeatures.highlights.map(h => `<li>${this.esc(h)}</li>`).join('')
                    : '';
                newFeaturesHtml = `
                    <div class="help-new-features">
                        <div class="help-new-features-header">✨ 新功能</div>
                        <ul class="help-new-features-list">${highlightsHtml}</ul>
                    </div>
                `;
            }

            const helpHtml = `
                <div class="help-overlay" id="helpOverlay">
                    <div class="help-content">
                        <button class="help-close">×</button>
                        <h3>Nav Sylph${versionStr}</h3>
                        ${newFeaturesHtml}
                        <div class="help-section">
                            <strong>收藏书签检索</strong>
                            <p>搜索框输入 <code>/</code> + 关键词，快速搜索收藏</p>
                            <p class="help-tip">支持标题、网址、分类、描述模糊匹配</p>
                            <p class="help-tip">↑↓ 选择，Enter 打开，Esc 退出</p>
                        </div>
                        <div class="help-section">
                            <strong>跨设备文本分享</strong>
                            <p>搜索框输入 <code>></code> + 内容，回车发送</p>
                            <p class="help-tip">端到端加密 · 5分钟过期 · 阅后即删</p>
                        </div>
                        <div class="help-section">
                            <strong>管理收藏</strong>
                            <p>点击右下角 ⚙️ 进入管理面板</p>
                            <p class="help-tip">支持导入/导出浏览器书签</p>
                            <p class="help-tip">兼容 Chrome、Edge、Firefox、Safari</p>
                        </div>
                    </div>
                </div>
            `;
            const overlay = html(helpHtml);
            overlay.onclick = (e) => {
                if (e.target === overlay || e.target.classList.contains('help-close')) {
                    overlay.remove();
                    // 标记版本为已查看
                    this.markVersionAsSeen();
                }
            };
            document.body.appendChild(overlay);
        }

        async openAdmin() {
            if (!this.password) {
                const pwd = prompt('请输入管理密码：');
                if (!pwd) return;
                const res = await API.post('/api/verify-password', {}, pwd);
                if (!res.valid) return alert('密码错误');
                this.password = pwd;

                // 检测是否为默认密码，提示修改
                if (pwd === 'admin123') {
                    const shouldChange = confirm('⚠️ 您正在使用默认密码，存在安全风险！\n\n强烈建议立即修改密码。\n\n点击「确定」立即修改密码，点击「取消」稍后修改。');
                    if (shouldChange) {
                        this.renderAdminPanel();
                        $('#modal').hidden = false;
                        setTimeout(() => this.changePassword(), 100);
                        return;
                    }
                }
            }
            this.renderAdminPanel();
            $('#modal').hidden = false;
        }

        closeAdmin() {
            $('#modal').hidden = true;
        }

        renderAdminPanel() {
            const body = $('#modalBody');
            body.innerHTML = `
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
                            <span>书签显示模式</span>
                            <select id="iconModeSelect">
                                <option value="true" ${this.config.showBookmarkIcons !== false ? 'selected' : ''}>图标 + 文字</option>
                                <option value="false" ${this.config.showBookmarkIcons === false ? 'selected' : ''}>纯文字模式</option>
                            </select>
                        </label>
                    </div>
                </div>
                <div class="section">
                    <div class="section-title">收藏书签</div>
                    <div class="fav-stats">
                        共 <strong>${this.favorites.length}</strong> 个收藏
                        <span class="fav-hint">（搜索框输入 <code>/</code> 快速检索）</span>
                    </div>
                    <div class="fav-actions">
                        <button class="btn" id="importFavBtn">📥 导入书签</button>
                        <button class="btn" id="exportFavBtn">📤 导出书签</button>
                        <button class="btn" id="addFavBtn">+ 添加收藏</button>
                        <button class="btn" id="manageFavBtn">管理收藏</button>
                    </div>
                    <input type="file" id="favFileInput" accept=".html,.htm" hidden>
                </div>
                <div class="section">
                    <div class="section-title">搜索引擎</div>
                    <div id="enginesEditor"></div>
                    <button class="add-btn" id="addEngine">+ 添加搜索引擎</button>
                </div>
                <div class="section">
                    <div class="section-title">书签分类</div>
                    <div id="catsEditor"></div>
                    <button class="add-btn" id="addCat">+ 添加分类</button>
                </div>
            `;

            this.renderEnginesEditor();
            this.renderCatsEditor();

            $('#themeModeSelect').onchange = (e) => {
                this.config.theme = e.target.value;
                this.applyTheme();
            };

            $('#defaultEngineSelect').onchange = (e) => {
                this.config.searchEngine = e.target.value;
                this.renderEngines();
            };

            $('#iconModeSelect').onchange = (e) => {
                this.config.showBookmarkIcons = e.target.value === 'true';
                this.renderGrid();
            };

            $('#addEngine').onclick = () => {
                this.config.searchEngines.push({ id: uid(), name: '新引擎', url: 'https://' });
                this.renderEnginesEditor();
            };

            $('#addCat').onclick = () => {
                this.config.categories.push({ id: uid(), name: '新分类', bookmarks: [] });
                this.renderCatsEditor();
            };

            // 收藏书签相关绑定
            $('#importFavBtn').onclick = () => $('#favFileInput').click();
            $('#favFileInput').onchange = (e) => this.handleFavImport(e);
            $('#addFavBtn').onclick = () => this.showAddFavDialog();
            $('#manageFavBtn').onclick = () => this.showFavManager();
            $('#exportFavBtn').onclick = () => this.exportFavorites();
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
                if (field) this.config.searchEngines[idx][field] = e.target.value;
            };

            container.onclick = (e) => {
                if (e.target.classList.contains('del-engine')) {
                    const idx = +e.target.closest('.item').dataset.idx;
                    if (this.config.searchEngines.length <= 1) return alert('至少保留一个');
                    const deleted = this.config.searchEngines.splice(idx, 1)[0];
                    if (this.config.searchEngine === deleted.id) {
                        this.config.searchEngine = this.config.searchEngines[0].id;
                    }
                    this.renderEnginesEditor();
                }
            };
        }

        renderCatsEditor(expandCatId = null) {
            const container = $('#catsEditor');
            const expanded = new Set();
            $$('.cat-toggle.expanded', container).forEach(btn => {
                const catEl = btn.closest('.item[data-cat]');
                const ci = +catEl.dataset.cat;
                if (this.config.categories[ci]) expanded.add(this.config.categories[ci].id);
            });
            if (expandCatId !== null) expanded.add(expandCatId);
            
            const bmCount = (cat) => cat.bookmarks.length;
            container.innerHTML = this.config.categories.map((cat, ci) => {
                const isExpanded = expanded.has(cat.id);
                return `
                <div class="item cat-item" data-cat="${ci}">
                    <div class="item-header">
                        <span class="item-drag" draggable="true">⋮⋮</span>
                        <button class="cat-toggle${isExpanded ? ' expanded' : ''}" data-cat="${ci}">
                            <svg class="toggle-icon" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>
                        </button>
                        <input type="text" value="${this.esc(cat.name)}" data-field="name" placeholder="分类名称">
                        <span class="cat-count">${bmCount(cat)}</span>
                        <button class="btn btn-danger btn-sm del-cat">删除</button>
                    </div>
                    <div class="bookmarks-list${isExpanded ? '' : ' collapsed'}">
                        ${cat.bookmarks.map((bm, bi) => `
                            <div class="bookmark-item" data-bm="${bi}">
                                <span class="item-drag" draggable="true">⋮</span>
                                <input type="text" value="${this.esc(bm.title)}" data-field="title" placeholder="标题">
                                <input type="text" value="${this.esc(bm.url)}" data-field="url" placeholder="URL">
                                <button class="btn btn-danger btn-sm del-bm">删除</button>
                            </div>
                        `).join('')}
                        <button class="add-btn add-bm">+ 添加书签</button>
                    </div>
                </div>
            `}).join('');

            container.oninput = (e) => {
                const catEl = e.target.closest('.item[data-cat]');
                if (!catEl) return;
                const ci = +catEl.dataset.cat;
                const bmEl = e.target.closest('.bookmark-item');
                const field = e.target.dataset.field;
                if (bmEl && field) {
                    const bi = +bmEl.dataset.bm;
                    this.config.categories[ci].bookmarks[bi][field] = e.target.value;
                } else if (field === 'name') {
                    this.config.categories[ci].name = e.target.value;
                }
            };

            container.onclick = (e) => {
                const catEl = e.target.closest('.item[data-cat]');
                if (!catEl) return;
                const ci = +catEl.dataset.cat;

                const toggleBtn = e.target.closest('.cat-toggle');
                if (toggleBtn) {
                    const list = catEl.querySelector('.bookmarks-list');
                    list.classList.toggle('collapsed');
                    toggleBtn.classList.toggle('expanded');
                    return;
                }

                if (e.target.classList.contains('del-cat')) {
                    if (this.config.categories.length <= 1) return alert('至少保留一个分类');
                    this.config.categories.splice(ci, 1);
                    this.renderCatsEditor();
                } else if (e.target.classList.contains('del-bm')) {
                    const bi = +e.target.closest('.bookmark-item').dataset.bm;
                    this.config.categories[ci].bookmarks.splice(bi, 1);
                    this.renderCatsEditor(this.config.categories[ci].id);
                } else if (e.target.classList.contains('add-bm')) {
                    this.config.categories[ci].bookmarks.push({ id: uid(), title: '', url: '' });
                    this.renderCatsEditor(this.config.categories[ci].id);
                }
            };

            this.bindEditorDrag(container);
        }

        bindEditorDrag(container) {
            let dragType = null, dragFrom = null;

            container.ondragstart = (e) => {
                const catDrag = e.target.closest('.item[data-cat] > .item-header .item-drag');
                const bmDrag = e.target.closest('.bookmark-item .item-drag');
                
                if (catDrag) {
                    dragType = 'cat';
                    dragFrom = +catDrag.closest('.item').dataset.cat;
                } else if (bmDrag) {
                    dragType = 'bm';
                    const catEl = bmDrag.closest('.item[data-cat]');
                    const bmEl = bmDrag.closest('.bookmark-item');
                    dragFrom = { cat: +catEl.dataset.cat, bm: +bmEl.dataset.bm };
                }
            };

            container.ondragover = (e) => e.preventDefault();

            container.ondrop = (e) => {
                e.preventDefault();
                if (!dragType) return;

                if (dragType === 'cat') {
                    const target = e.target.closest('.item[data-cat]');
                    if (target) {
                        const to = +target.dataset.cat;
                        this.moveCategory(dragFrom, to);
                        this.renderCatsEditor();
                    }
                } else if (dragType === 'bm') {
                    const targetBm = e.target.closest('.bookmark-item');
                    const targetCat = e.target.closest('.item[data-cat]');
                    if (targetBm && targetCat) {
                        const toCat = +targetCat.dataset.cat;
                        const toBm = +targetBm.dataset.bm;
                        this.moveBookmark(dragFrom.cat, dragFrom.bm, toCat, toBm);
                        this.renderCatsEditor();
                    }
                }
                dragType = null;
                dragFrom = null;
            };

            container.ondragend = () => { dragType = null; dragFrom = null; };
        }

        async save() {
            try {
                const res = await API.post('/api/config', this.config, this.password);
                if (res.success) {
                    this.render();
                    this.closeAdmin();
                } else {
                    alert(res.error || '保存失败');
                }
            } catch (e) {
                alert('保存失败: ' + e.message);
            }
        }

        // ========== 收藏书签管理 ==========

        async handleFavImport(e) {
            const file = e.target.files[0];
            if (!file) return;

            const htmlContent = await file.text();

            try {
                const res = await API.post('/api/favorites/import', { html: htmlContent, merge: true }, this.password);
                if (res.success) {
                    alert(`导入成功！新增 ${res.imported} 个书签${res.duplicates ? `，跳过 ${res.duplicates} 个重复` : ''}`);
                    await this.loadFavorites();
                    this.renderAdminPanel();
                } else {
                    alert(res.error || '导入失败');
                }
            } catch (err) {
                alert('导入失败: ' + err.message);
            }

            e.target.value = '';
        }

        async exportFavorites() {
            try {
                const res = await fetch('/api/favorites/export', {
                    headers: { 'X-Admin-Password': this.password }
                });
                if (!res.ok) {
                    const data = await res.json();
                    alert(data.error || '导出失败');
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
                alert('导出失败: ' + err.message);
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
                        <h3>添加收藏</h3>
                        <div class="fav-form">
                            <input type="text" id="favTitle" placeholder="标题 *">
                            <input type="url" id="favUrl" placeholder="URL *">
                            <input type="text" id="favDesc" placeholder="描述（可选）">
                            <div class="fav-category-row">
                                ${existingCategories.length > 0 ? `
                                    <select id="favCategorySelect">
                                        <option value="">-- 选择分类 --</option>
                                        ${categoryOptions}
                                        <option value="__new__">+ 新建分类</option>
                                    </select>
                                ` : ''}
                                <input type="text" id="favCategory" placeholder="${existingCategories.length > 0 ? '或输入新分类' : '分类（可选）'}">
                            </div>
                            <input type="text" id="favTags" placeholder="标签（逗号分隔，可选）">
                        </div>
                        <div class="fav-dialog-actions">
                            <button class="btn" id="favCancelBtn">取消</button>
                            <button class="btn btn-primary" id="favSaveBtn">保存</button>
                        </div>
                    </div>
                </div>
            `);

            document.body.appendChild(dialog);

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

            $('#favCancelBtn').onclick = () => dialog.remove();
            $('#favSaveBtn').onclick = async () => {
                const title = $('#favTitle').value.trim();
                const url = $('#favUrl').value.trim();

                if (!title || !url) {
                    alert('标题和 URL 不能为空');
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
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };

                this.favorites.unshift(newFav);
                await this.saveFavorites();
                dialog.remove();
                this.renderAdminPanel();
            };
        }

        async saveFavorites() {
            try {
                const res = await API.post('/api/favorites', { favorites: this.favorites }, this.password);
                if (res.success) {
                    this.buildSearchIndex();
                } else {
                    alert(res.error || '保存失败');
                }
            } catch (err) {
                alert('保存失败: ' + err.message);
            }
        }

        showFavManager() {
            const body = $('#modalBody');
            this.favManagerPage = 0;
            this.favManagerFiltered = null;

            // 按分类统计
            const categoryStats = {};
            this.favorites.forEach(f => {
                const cat = f.category || '未分类';
                categoryStats[cat] = (categoryStats[cat] || 0) + 1;
            });
            const categoryCount = Object.keys(categoryStats).length;

            body.innerHTML = `
                <div class="fav-manager">
                    <div class="fav-manager-header">
                        <button class="btn" id="backToAdmin">← 返回</button>
                        <input type="text" id="favManagerSearch" placeholder="搜索 ${this.favorites.length} 个收藏..." class="fav-manager-search">
                        <select id="favCategoryFilter" class="fav-category-filter">
                            <option value="">全部分类 (${categoryCount})</option>
                            ${Object.entries(categoryStats)
                                .sort((a, b) => b[1] - a[1])
                                .map(([cat, count]) => `<option value="${this.esc(cat)}">${this.esc(cat)} (${count})</option>`)
                                .join('')}
                        </select>
                    </div>
                    <div class="fav-manager-stats" id="favManagerStats"></div>
                    <div class="fav-manager-list" id="favManagerList"></div>
                    <div class="fav-manager-footer" id="favManagerFooter"></div>
                </div>
            `;

            $('#backToAdmin').onclick = () => this.renderAdminPanel();
            $('#favManagerSearch').oninput = (e) => this.debouncedFilterFavManager(e.target.value, $('#favCategoryFilter').value);
            $('#favCategoryFilter').onchange = (e) => this.filterFavManager($('#favManagerSearch').value, e.target.value);

            this.renderFavManagerList(this.favorites);
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

            // 先按分类过滤
            if (category) {
                filtered = filtered.filter(f => (f.category || '未分类') === category);
            }

            // 再按关键词过滤
            if (query && query.trim()) {
                const q = query.trim();
                if (this.uf && this.favHaystack.length > 0) {
                    const idxs = this.uf.filter(this.favHaystack, q);
                    if (idxs && idxs.length > 0) {
                        const idxSet = new Set(idxs.map(i => this.favorites[i].id));
                        filtered = filtered.filter(f => idxSet.has(f.id));
                    } else {
                        filtered = [];
                    }
                } else {
                    const qLower = q.toLowerCase();
                    filtered = filtered.filter(f =>
                        f.title.toLowerCase().includes(qLower) ||
                        (f.description || '').toLowerCase().includes(qLower) ||
                        f.url.toLowerCase().includes(qLower)
                    );
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

            // 渲染列表项（使用 DocumentFragment 优化）
            list.innerHTML = pageFavs.map(fav => `
                <div class="fav-manager-item" data-id="${fav.id}">
                    <img class="fav-manager-icon" src="${this.getFavicon(fav.url)}" alt="" loading="lazy"
                         onerror="this.style.display='none'">
                    <div class="fav-manager-info">
                        <div class="fav-manager-title">${this.esc(fav.title)}</div>
                        <div class="fav-manager-url">${this.esc(fav.url)}</div>
                    </div>
                    ${fav.category ? `<span class="fav-manager-category">${this.esc(fav.category)}</span>` : ''}
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
            list.onclick = (e) => {
                const item = e.target.closest('.fav-manager-item');
                if (!item) return;
                const id = item.dataset.id;

                if (e.target.classList.contains('del-fav')) {
                    if (confirm('确定删除此收藏？')) {
                        this.favorites = this.favorites.filter(f => f.id !== id);
                        this.saveFavorites();
                        // 重新过滤并渲染
                        if (this.favManagerFiltered) {
                            this.favManagerFiltered = this.favManagerFiltered.filter(f => f.id !== id);
                        }
                        this.renderFavManagerList(this.favManagerFiltered || this.favorites);
                    }
                } else if (e.target.classList.contains('edit-fav')) {
                    this.editFavorite(id);
                }
            };
        }

        editFavorite(id) {
            const fav = this.favorites.find(f => f.id === id);
            if (!fav) return;

            const dialog = html(`
                <div class="fav-dialog-overlay" id="favEditDialog">
                    <div class="fav-dialog">
                        <h3>编辑收藏</h3>
                        <div class="fav-form">
                            <input type="text" id="editFavTitle" value="${this.esc(fav.title)}" placeholder="标题">
                            <input type="url" id="editFavUrl" value="${this.esc(fav.url)}" placeholder="URL">
                            <input type="text" id="editFavDesc" value="${this.esc(fav.description || '')}" placeholder="描述">
                            <input type="text" id="editFavCategory" value="${this.esc(fav.category || '')}" placeholder="分类">
                            <input type="text" id="editFavTags" value="${(fav.tags || []).join(', ')}" placeholder="标签">
                        </div>
                        <div class="fav-dialog-actions">
                            <button class="btn" id="editFavCancelBtn">取消</button>
                            <button class="btn btn-primary" id="editFavSaveBtn">保存</button>
                        </div>
                    </div>
                </div>
            `);

            document.body.appendChild(dialog);

            $('#editFavCancelBtn').onclick = () => dialog.remove();
            $('#editFavSaveBtn').onclick = async () => {
                fav.title = $('#editFavTitle').value.trim();
                fav.url = $('#editFavUrl').value.trim();
                fav.description = $('#editFavDesc').value.trim();
                fav.category = $('#editFavCategory').value.trim();
                fav.tags = $('#editFavTags').value.split(',').map(t => t.trim()).filter(Boolean);
                fav.updatedAt = Date.now();

                await this.saveFavorites();
                dialog.remove();
                this.showFavManager();
            };
        }

        async changePassword() {
            if (!this.password) return alert('请先进入管理模式');
            const newPwd = prompt('输入新密码（至少8位）：');
            if (!newPwd || newPwd.length < 8) return alert('密码至少8位');
            const confirm = prompt('再次输入新密码：');
            if (newPwd !== confirm) return alert('两次输入不一致');

            const res = await API.post('/api/change-password', { newPassword: newPwd }, this.password);
            if (res.success) {
                this.password = newPwd;
                alert('密码已修改');
            } else {
                alert(res.error || '修改失败');
            }
        }

        esc(str) {
            if (!str) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new App());
    } else {
        new App();
    }

})(window);

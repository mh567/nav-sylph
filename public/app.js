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

    const SESSION_PWD_KEY = 'nav-sylph-admin-password';

    class App {
        constructor() {
            this.config = null;
            this.password = null;
            this.dragData = null;
            this.pasteMode = false;
            // 收藏检索
            this.favorites = [];
            this.favoritesLoading = true;
            this.favoritesLoadError = false;
            this.configDirty = false;
            this.configSaving = false;
            this.configSnapshot = null;
            this.toastTimer = null;
            this.favSearchMode = false;
            this.privacySearchActive = false;
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
                this.config = await (window.__navSylphConfigPromise || API.get('/api/config'));
                this.migrateConfig();
                // 恢复 sessionStorage 中的登录状态
                const savedPwd = sessionStorage.getItem(SESSION_PWD_KEY);
                if (savedPwd) {
                    this.password = savedPwd;
                }
                this.applyTheme();
                this.render();
                this.bind();
                $('#loader').remove();
                $('#app').hidden = false;
                // 首页先显示，收藏索引和版本信息随后加载
                requestAnimationFrame(() => {
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
            $('#engineBtn').setAttribute('aria-label', `选择搜索引擎，当前为${current.name}`);
            
            const dropdown = $('#engineDropdown');
            dropdown.innerHTML = this.config.searchEngines.map(e => 
                `<button type="button" role="option" aria-selected="${e.id === this.config.searchEngine}" class="engine-option${e.id === this.config.searchEngine ? ' active' : ''}" data-id="${this.esc(e.id)}">${this.esc(e.name)}</button>`
            ).join('');
        }

        renderGrid() {
            const grid = $('#grid');
            const fragment = document.createDocumentFragment();
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
                fragment.appendChild(section);
            });
            grid.replaceChildren(fragment);
        }

        createBookmark(bm, catIdx, bmIdx) {
            return html(`
                <a class="bookmark bookmark-text-only" href="${this.esc(bm.url)}" target="_blank" rel="noopener" title="${this.esc(bm.title)}">
                    <span class="bookmark-title">${this.esc(bm.title)}</span>
                </a>
            `);
        }

        bind() {
            $('#modeBtn').onclick = () => {
                const input = $('#searchInput');
                const value = input.value;
                if (this.pasteMode) {
                    this.pasteMode = false;
                    this.togglePasteMode(false);
                }
                input.value = this.favSearchMode
                    ? value.replace(/^[\/、]{1,2}/, '')
                    : `/${this.isPasteTrigger(value[0]) ? value.slice(1) : value}`;
                this.handleSearchInput({ target: input });
                input.focus();
            };
            this.bindPointerEffects();
            this.bindBookmarkPress();
            $('#searchForm').onsubmit = (e) => { e.preventDefault(); this.handleSearch(); };
            $('#searchInput').oninput = (e) => this.handleSearchInput(e);
            $('#adminBtn').onclick = () => this.openAdmin();
            $('#helpBtn').onclick = () => this.showHelp();
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
                engineBtn.classList.toggle('active', !isOpen);
                engineBtn.setAttribute('aria-expanded', String(!isOpen));
                if (!isOpen) dropdown.querySelector('.engine-option.active')?.focus();
            };
            
            dropdown.onclick = (e) => {
                const option = e.target.closest('.engine-option');
                if (option) {
                    this.config.searchEngine = option.dataset.id;
                    this.renderEngines();
                    dropdown.hidden = true;
                    engineBtn.classList.remove('active');
                    engineBtn.setAttribute('aria-expanded', 'false');
                    $('#searchInput').focus();
                }
            };
            
            document.onclick = (e) => {
                if (!e.target.closest('.search-wrapper')) {
                    dropdown.hidden = true;
                    engineBtn.classList.remove('active');
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
                // 收藏检索模式的键盘导航
                if (this.favSearchMode && this.handleFavKeydown(e)) {
                    return;
                }

                if (e.key === 'Escape') {
                    if (!dropdown.hidden) {
                        dropdown.hidden = true;
                        engineBtn.classList.remove('active');
                        engineBtn.setAttribute('aria-expanded', 'false');
                        engineBtn.focus();
                    } else if (!$('#modal').hidden) {
                        this.closeAdmin();
                    }
                }
            };
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

        search() {
            const q = $('#searchInput').value.trim();
            if (!q) return;
            const engine = this.config.searchEngines.find(e => e.id === this.config.searchEngine);
            if (engine) window.open(engine.url + encodeURIComponent(q), '_blank');
            $('#searchInput').value = '';
        }

        // ========== 收藏模糊检索 ==========

        async loadFavorites() {
            this.favoritesLoading = true;
            this.favoritesLoadError = false;
            try {
                const data = await API.get('/api/favorites');
                this.favorites = data.favorites || [];
                this.buildSearchIndex();
            } catch (e) {
                console.error('Load favorites failed:', e);
                this.favorites = [];
                this.favoritesLoadError = true;
            } finally {
                this.favoritesLoading = false;
                const count = $('.fav-stats strong');
                if (count) count.textContent = this.favorites.length;
                ['importFavBtn', 'exportFavBtn', 'addFavBtn', 'manageFavBtn'].forEach(id => {
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

        // 获取当前可搜索的收藏列表（仅用于搜索结果过滤，分类树视图不使用此方法）
        getSearchableFavorites() {
            if (this.privacySearchActive) {
                return this.favorites;
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
            return !!(this.password && this.config.privacyMode);
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
            const modeBtn = $('#modeBtn');
            modeBtn.textContent = enabled ? '收藏' : '网页';
            modeBtn.setAttribute('aria-pressed', String(enabled));
            modeBtn.setAttribute('aria-label', `切换搜索模式，当前为${enabled ? '收藏' : '网页'}`);

            if (enabled) {
                input.placeholder = '搜索收藏...';
                $('#engineBtn').style.display = 'none';
                $('#engineDropdown').hidden = true;
                $('#engineBtn').setAttribute('aria-expanded', 'false');
                searchBtn.textContent = '打开';
                searchBtn.title = '收藏检索';
                this.showFavDropdown();
            } else {
                input.placeholder = '搜索网页或收藏';
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
                dropdown.innerHTML = '<div class="fav-empty">收藏加载中...</div>';
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

            // 如果没有收藏，显示提示
            if (favList.length === 0) {
                dropdown.innerHTML = `<div class="fav-empty">${this.favoritesLoading ? '收藏加载中...' : this.favoritesLoadError ? '收藏加载失败，请刷新页面' : '无收藏，请在管理面板中导入'}</div>`;
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
                dropdown.innerHTML = '<div class="fav-empty">无收藏，请在管理面板中导入</div>';
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

        handleSearchInput(e) {
            const value = e.target.value;

            // 检查收藏检索模式（/ 或 //）
            const isFavMode = value.length > 0 && this.isFavSearchTrigger(value[0]);

            // 检测是否为隐私模式触发（//）
            const isPrivacyTrigger = isFavMode && value.length >= 2 && this.isFavSearchTrigger(value[1]);

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

            // 如果在收藏检索模式，执行防抖搜索
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
                searchBtn.textContent = '发送';
                searchBtn.title = '发送分享';
            } else {
                input.placeholder = '搜索网页或收藏';
                $('#engineBtn').style.display = '';
                searchBtn.textContent = '搜索';
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
            const usePin = !!(await this.showUiDialog({
                title: '分享保护',
                message: '是否设置 4 位 PIN 码保护？取消后将直接分享。',
                closeOnBackdrop: false
            }));

            let pin = null;
            if (usePin) {
                pin = await this.promptValue('设置 PIN', '4 位数字 PIN 码', { type: 'password', validate: ([value]) => /^\d{4}$/.test(value) ? '' : 'PIN 码必须是 4 位数字' });
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
                    this.showToast(codeData.error || '创建分享失败', 'error');
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
                    this.showToast(data.error || '创建分享失败', 'error');
                }
            } catch (e) {
                this.showToast('创建分享失败: ' + e.message, 'error');
            }
        }

        showPasteResult(code, hasPin = false) {
            this.hidePasteResult();

            // 简洁的 URL，无需密钥
            const url = `${location.origin}/p/${code}`;
            const pinInfo = hasPin ? '<div class="paste-pin-info">已设置 PIN 保护</div>' : '';
            const result = html(`
                <div class="paste-result" id="pasteResult">
                    <button class="paste-close" type="button" aria-label="关闭分享结果">×</button>
                    <div class="paste-code">${this.esc(code)}</div>
                    ${pinInfo}
                    <button class="paste-link" type="button" data-url="${this.esc(url)}">复制链接</button>
                    <div class="paste-expiry">5分钟后过期</div>
                </div>
            `);

            result.querySelector('.paste-close').onclick = () => this.hidePasteResult();

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
                            <strong>收藏检索</strong>
                            <p>点击“网页”切换到收藏，或输入 <code>/</code> + 关键词</p>
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
            if (!this.password) {
                const pwd = await this.promptValue('进入管理', '管理密码', { type: 'password' });
                if (!pwd) return;
                const res = await API.post('/api/verify-password', {}, pwd);
                if (!res.valid) { await this.notice('密码错误', '无法进入管理'); return; }
                this.password = pwd;
                sessionStorage.setItem(SESSION_PWD_KEY, pwd);

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

        showToast(message, state = 'success') {
            const toast = $('#toast');
            if (!toast) return;
            clearTimeout(this.toastTimer);
            toast.textContent = message;
            toast.dataset.state = state;
            toast.hidden = false;
            this.toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
        }

        showUiDialog({ title, message = '', fields = [], confirmText = '确定', cancelText = '取消', danger = false, notice = false, closeOnBackdrop = true, validate }) {
            const previousFocus = document.activeElement;
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
            const inputs = [...overlay.querySelectorAll('input')];
            const focusables = [...overlay.querySelectorAll('input, button')];
            (inputs[0] || focusables.at(-1)).focus();

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
                    const values = inputs.map(input => input.value);
                    const error = validate?.(values);
                    if (error) {
                        overlay.querySelector('.ui-dialog-error').textContent = error;
                        (inputs[0] || form.querySelector('button[type="submit"]')).focus();
                        return;
                    }
                    close(fields.length ? values : true);
                });
            });
        }

        async confirmAction(message, title = '确认操作', danger = false) {
            return !!(await this.showUiDialog({ title, message, danger, confirmText: danger ? '确认删除' : '确定' }));
        }

        async promptValue(title, label, options = {}) {
            const result = await this.showUiDialog({ title, fields: [{ label, ...options }], confirmText: options.confirmText || '确定', validate: options.validate });
            return result ? result[0] : null;
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
            $('#modal').hidden = true;
            if (this.adminReturnFocus?.isConnected) this.adminReturnFocus.focus();
            return true;
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
                            <span>隐私模式</span>
                            <div class="toggle-switch">
                                <input type="checkbox" id="privacyModeToggle" ${this.config.privacyMode ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </div>
                        </label>
                    </div>
                </div>
                <div class="section">
                    <div class="section-title">收藏</div>
                    <div class="fav-stats">
                        共 <strong>${this.favoritesLoading ? '加载中' : this.favorites.length}</strong> 个收藏
                        <span class="fav-hint">（搜索框输入 <code>/</code> 快速检索）</span>
                    </div>
                    <div class="fav-actions">
                        <button class="btn" id="importFavBtn">导入收藏</button>
                        <button class="btn" id="exportFavBtn">导出收藏</button>
                        <button class="btn" id="addFavBtn">添加收藏</button>
                        <button class="btn" id="manageFavBtn">管理收藏</button>
                    </div>
                    <input type="file" id="favFileInput" accept=".html,.htm" hidden>
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
                <div class="section">
                    <div class="section-title">书签分类</div>
                    <div id="catsEditor"></div>
                    <button class="add-btn" id="addCat">添加分类</button>
                </div>
                <div class="section">
                    <button class="btn btn-danger" id="logoutBtn" style="width: 100%;">退出登录</button>
                </div>
            `;

            this.renderEnginesEditor();
            this.renderCatsEditor();

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

            $('#addCat').onclick = () => {
                this.config.categories.push({ id: uid(), name: '新分类', bookmarks: [] });
                this.renderCatsEditor();
                this.markConfigDirty();
            };

            // 收藏相关绑定
            $('#importFavBtn').onclick = () => $('#favFileInput').click();
            $('#favFileInput').onchange = (e) => this.handleFavImport(e);
            $('#addFavBtn').onclick = () => this.showAddFavDialog();
            $('#manageFavBtn').onclick = () => this.showFavManager();
            $('#exportFavBtn').onclick = () => this.exportFavorites();
            if (this.favoritesLoading) {
                ['importFavBtn', 'exportFavBtn', 'addFavBtn', 'manageFavBtn'].forEach(id => { $(`#${id}`).disabled = true; });
            }

            // 隐私模式开关
            $('#privacyModeToggle').onchange = (e) => {
                this.config.privacyMode = e.target.checked;
                this.markConfigDirty();
            };

            // 登出按钮
            $('#logoutBtn').onclick = async () => {
                if (!await this.closeAdmin()) return;
                this.password = null;
                sessionStorage.removeItem(SESSION_PWD_KEY);
                this.privacySearchActive = false;
            };

            // WebDAV 配置加载
            this.loadWebDAVConfig();
        }

        // ========== WebDAV 远程备份 ==========

        async loadWebDAVConfig() {
            try {
                const res = await fetch('/api/webdav/config', {
                    headers: { 'X-Admin-Password': this.password }
                });
                if (res.ok) {
                    this.webdavConfig = await res.json();
                    this.renderWebDAVSection();
                }
            } catch (e) {
                console.error('Load WebDAV config failed:', e);
            }
        }

        renderWebDAVSection() {
            const container = $('#webdavSection');
            if (!container || !this.webdavConfig) return;

            const cfg = this.webdavConfig;
            const lastBackup = cfg.lastBackupTime
                ? new Date(cfg.lastBackupTime).toLocaleString()
                : '从未备份';

            container.innerHTML = `
                <div class="webdav-status">
                    <span class="webdav-status-dot ${cfg.enabled ? 'active' : ''}"></span>
                    <span>${cfg.enabled ? '已启用' : '未启用'}</span>
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
        }

        async saveWebDAVConfig() {
            const msgEl = $('#webdavMessage');
            msgEl.textContent = '保存中...';
            msgEl.className = 'webdav-message';

            try {
                const data = {
                    enabled: $('#webdavEnabled').checked,
                    url: $('#webdavUrl').value.trim(),
                    username: $('#webdavUsername').value.trim(),
                    remotePath: $('#webdavPath').value.trim() || '/nav-sylph-backups/'
                };

                const pwd = $('#webdavPassword').value;
                if (pwd) data.password = pwd;

                const res = await API.post('/api/webdav/config', data, this.password);
                if (res.success) {
                    this.webdavConfig = res.config;
                    msgEl.textContent = '配置已保存';
                    msgEl.className = 'webdav-message success';
                    this.renderWebDAVSection();
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
                const res = await API.post('/api/webdav/test', {}, this.password);
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
                const res = await API.post('/api/webdav/backup', {}, this.password);
                if (res.success) {
                    if (res.noChanges) {
                        msgEl.textContent = res.message || '配置和收藏没有变化，无需备份';
                        msgEl.className = 'webdav-message';
                    } else {
                        const files = [res.configFilename, res.bookmarksFilename].filter(Boolean);
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
                const res = await fetch('/api/webdav/list', {
                    headers: { 'X-Admin-Password': this.password }
                });
                const data = await res.json();

                if (!data.success) {
                    msgEl.textContent = data.error || '获取列表失败';
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
                                    const displayName = b.timestamp.replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5:$6');
                                    const files = [];
                                    if (isLegacy) files.push('旧版备份');
                                    if (hasConfig) files.push('配置');
                                    if (hasBookmarks) files.push('收藏');
                                    return `
                                    <div class="webdav-backup-item"
                                         data-config="${this.esc(b.configFile || '')}"
                                         data-bookmarks="${this.esc(b.bookmarksFile || '')}"
                                         data-legacy="${this.esc(b.legacyFile || '')}"
                                         data-timestamp="${this.esc(b.timestamp)}">
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
                        const legacyFile = item.dataset.legacy;

                        this.showRestoreOptionsDialog({
                            configFile,
                            bookmarksFile,
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
                        const legacyFile = item.dataset.legacy;
                        const timestamp = item.dataset.timestamp;
                        const displayName = timestamp.replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5:$6');

                        if (!await this.confirmAction(`确定删除备份 ${displayName}？`, '删除备份', true)) return;

                        btn.disabled = true;
                        btn.textContent = '删除中...';

                        try {
                            const filesToDelete = [configFile, bookmarksFile, legacyFile].filter(Boolean);
                            for (const file of filesToDelete) {
                                await API.post('/api/webdav/delete', { filename: file }, this.password);
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

            const optionsDialog = html(`
                <div class="fav-dialog-overlay" id="restoreOptionsDialog">
                    <div class="fav-dialog">
                        <h3>选择恢复内容</h3>
                        <div class="restore-options">
                            ${hasConfig && hasBookmarks ? `
                            <label class="restore-option">
                                <input type="radio" name="restoreType" value="all" checked>
                                <span>同时恢复配置和收藏</span>
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
                                <span>只恢复收藏</span>
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
                if (!await this.confirmAction('恢复将覆盖当前对应的数据，确定继续吗？', '确认恢复')) return;

                optionsDialog.querySelector('.btn-primary').disabled = true;
                optionsDialog.querySelector('.btn-primary').textContent = '恢复中...';

                try {
                    const restoreRes = await API.post('/api/webdav/restore', {
                        configFile: backup.configFile,
                        bookmarksFile: backup.bookmarksFile,
                        legacyFile: backup.legacyFile,
                        restoreConfig,
                        restoreBookmarks
                    }, this.password);

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
                        <button class="cat-toggle${isExpanded ? ' expanded' : ''}" data-cat="${ci}" aria-expanded="${isExpanded}">
                            ${isExpanded ? '收起' : '展开'}
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
                        <button class="add-btn add-bm">添加书签</button>
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
                if (field) this.markConfigDirty();
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
                    const expanded = !list.classList.contains('collapsed');
                    toggleBtn.setAttribute('aria-expanded', String(expanded));
                    toggleBtn.textContent = expanded ? '收起' : '展开';
                    return;
                }

                if (e.target.classList.contains('del-cat')) {
                    if (this.config.categories.length <= 1) { this.showToast('至少保留一个分类', 'error'); return; }
                    this.config.categories.splice(ci, 1);
                    this.renderCatsEditor();
                    this.markConfigDirty();
                } else if (e.target.classList.contains('del-bm')) {
                    const bi = +e.target.closest('.bookmark-item').dataset.bm;
                    this.config.categories[ci].bookmarks.splice(bi, 1);
                    this.renderCatsEditor(this.config.categories[ci].id);
                    this.markConfigDirty();
                } else if (e.target.classList.contains('add-bm')) {
                    this.config.categories[ci].bookmarks.push({ id: uid(), title: '', url: '' });
                    this.renderCatsEditor(this.config.categories[ci].id);
                    this.markConfigDirty();
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
            const button = $('#saveBtn');
            if (button.disabled) return;
            this.configSaving = true;
            button.disabled = true;
            $('#modalBody').inert = true;
            button.textContent = '保存中...';
            this.updateConfigStatus('正在保存到服务器', 'pending');
            try {
                const res = await API.post('/api/config', this.config, this.password);
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

        // ========== 收藏管理 ==========

        async handleFavImport(e) {
            const file = e.target.files[0];
            if (!file) return;

            const htmlContent = await file.text();

            try {
                const res = await API.post('/api/favorites/import', { html: htmlContent, merge: true }, this.password);
                if (res.success) {
                    this.showToast(`导入成功，新增 ${res.imported} 个收藏${res.duplicates ? `，跳过 ${res.duplicates} 个重复` : ''}`);
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
                const res = await fetch('/api/favorites/export', {
                    headers: { 'X-Admin-Password': this.password }
                });
                if (!res.ok) {
                    const data = await res.json();
                    this.showToast(data.error || '导出失败', 'error');
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
                        <h3>添加收藏</h3>
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
                const res = await API.post('/api/favorites', { favorites: this.favorites }, this.password);
                if (res.success) {
                    this.buildSearchIndex();
                    this.showToast('收藏已保存到服务器');
                    return true;
                } else {
                    this.showToast(res.error || '保存失败', 'error');
                }
            } catch (err) {
                this.showToast('保存失败: ' + err.message, 'error');
            }
            return false;
        }

        showFavManager() {
            const body = $('#modalBody');
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

            body.innerHTML = `
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
                                <button class="category-tree-select" type="button" aria-label="全部收藏" aria-current="${!this.favManagerCurrentCategory ? 'true' : 'false'}">
                                    <span class="tree-item-icon" aria-hidden="true">▦</span>
                                    <span class="tree-item-name">全部收藏</span>
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
                            <button class="btn" id="backToAdmin">← 返回</button>
                            <input type="text" id="favManagerSearch" placeholder="搜索收藏（支持拼音）..." class="fav-manager-search">
                        </div>
                        <div class="fav-batch-bar" id="favBatchBar">
                            <label class="fav-select-all">
                                <input type="checkbox" id="selectAllFav">
                                <span>全选</span>
                            </label>
                            <span class="fav-selected-count" id="favSelectedCount"></span>
                            <button class="btn btn-danger btn-sm" id="deleteSelectedBtn" disabled>删除选中</button>
                        </div>
                        <div class="fav-manager-stats" id="favManagerStats"></div>
                        <div class="fav-manager-list" id="favManagerList"></div>
                        <div class="fav-manager-footer" id="favManagerFooter"></div>
                    </div>
                </div>
            `;

            // 绑定事件
            $('#backToAdmin').onclick = async () => {
                await this.saveFavorites();
                this.favManagerCurrentCategory = '';
                this.renderAdminPanel();
            };
            $('#favManagerSearch').oninput = (e) => this.debouncedFilterFavManager(e.target.value, this.favManagerCurrentCategory);
            $('#addCategoryBtn').onclick = () => this.promptNewCategory();

            // Batch selection
            $('#selectAllFav').onchange = (e) => this.toggleSelectAllFav(e.target.checked);
            $('#deleteSelectedBtn').onclick = () => this.deleteSelectedFavorites();

            // Category tree events
            this.bindCategoryTree();

            // Apply current filter
            if (this.favManagerCurrentCategory) {
                this.filterFavManager('', this.favManagerCurrentCategory);
            } else {
                this.renderFavManagerList(this.favorites);
            }
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
                    if (await this.confirmAction(`是否将选中的 ${count} 个书签移动到「${category || '未分类'}」？`, '移动收藏')) {
                        this.favorites.forEach(f => {
                            if (this.favManagerSelected.has(f.id)) {
                                f.category = category;
                                f.updatedAt = Date.now();
                            }
                        });
                        this.favManagerSelected.clear();
                        await this.saveFavorites();
                        this.showFavManager();
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
                    this.showFavManager();
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
                        this.showFavManager();
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
            this.showFavManager();
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
            const selectAllCb = $('#selectAllFav');

            if (countEl) countEl.textContent = count > 0 ? `已选 ${count} 项` : '';
            if (deleteBtn) deleteBtn.disabled = count === 0;

            const checkboxes = $$('.fav-checkbox');
            if (selectAllCb && checkboxes.length > 0) {
                selectAllCb.checked = checkboxes.every(cb => cb.checked);
                selectAllCb.indeterminate = checkboxes.some(cb => cb.checked) && !selectAllCb.checked;
            }
        }

        async deleteSelectedFavorites() {
            const count = this.favManagerSelected.size;
            if (count === 0) return;

            if (!await this.confirmAction(`确定删除选中的 ${count} 个收藏？`, '批量删除', true)) return;

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
            this.showFavManager();
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
                    if (await this.confirmAction('确定删除此收藏？', '删除收藏', true)) {
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
                        this.showFavManager();
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
                        <h3>编辑收藏</h3>
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
                this.showFavManager();
            };
        }

        async changePassword() {
            if (!this.password) { await this.notice('请先进入管理模式'); return; }
            const values = await this.showUiDialog({
                title: '修改管理密码',
                fields: [
                    { label: '新密码', type: 'password' },
                    { label: '再次输入新密码', type: 'password' }
                ],
                validate: ([newPwd, repeated]) => newPwd.length < 8 ? '密码至少 8 位' : newPwd !== repeated ? '两次输入不一致' : ''
            });
            if (!values) return;
            const newPwd = values[0];

            const res = await API.post('/api/change-password', { newPassword: newPwd }, this.password);
            if (res.success) {
                this.password = newPwd;
                sessionStorage.setItem(SESSION_PWD_KEY, newPwd);
                this.showToast('密码已修改');
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

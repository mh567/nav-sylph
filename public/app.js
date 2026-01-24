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
            this.init();
        }

        async init() {
            try {
                this.config = await API.get('/api/config');
                this.migrateConfig();
                this.applyTheme();
                this.render();
                this.bind();
                $('#loader').remove();
                $('#app').hidden = false;
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

        // ========== Paste 分享功能 ==========

        // 检查是否为分享模式触发字符
        isPasteTrigger(char) {
            return char === '>' || char === '》';
        }

        handleSearchInput(e) {
            const value = e.target.value;
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
                const codeRes = await fetch('/api/paste/code', { method: 'POST' });
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

                const res = await fetch('/api/paste', {
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
            const url = `${location.origin}/paste/${code}`;
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
            const helpHtml = `
                <div class="help-overlay" id="helpOverlay">
                    <div class="help-content">
                        <button class="help-close">×</button>
                        <h3>📤 跨设备文本分享</h3>
                        <div class="help-section">
                            <strong>发送</strong>
                            <p>搜索框输入 <code>></code> + 内容，回车发送</p>
                        </div>
                        <div class="help-section">
                            <strong>接收</strong>
                            <p>在另一设备打开分享链接即可</p>
                        </div>
                        <p class="help-note">端到端加密 · 5分钟过期 · 阅后即删</p>
                    </div>
                </div>
            `;
            const overlay = html(helpHtml);
            overlay.onclick = (e) => {
                if (e.target === overlay || e.target.classList.contains('help-close')) {
                    overlay.remove();
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

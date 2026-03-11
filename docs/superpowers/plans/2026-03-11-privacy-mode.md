# 收藏隐私模式 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为收藏书签增加隐私保护功能，通过 `//` 触发隐私搜索模式，仅在管理员登录且开启隐私模式开关时生效。

**Architecture:** 在 `favorites.json` 书签对象上增加 `private` 字段标记隐私书签。`config.json` 增加 `privacyMode` 开关持久化存储。前端通过 `this.password`（已登录）+ `this.config.privacyMode`（开关开启）双重条件控制 `//` 搜索是否包含隐私书签。后台管理面板增加隐私模式开关和登出按钮。

**Tech Stack:** Vanilla JavaScript, Express.js, JSON file storage

**Spec:** `docs/superpowers/specs/2026-03-11-privacy-mode-design.md`

---

## Chunk 1: 数据层与搜索过滤

### Task 1: 服务端 config 支持 privacyMode 字段

**Files:**
- Modify: `server.js:280-308` (GET/POST `/api/config`)

config.json 的读写已通过现有 `/api/config` 接口完成，`privacyMode` 字段会自然地作为 config 对象的一部分被保存和读取，无需修改后端代码。

- [ ] **Step 1: 验证现有 API 兼容性**

手动测试：向 config.json 添加 `"privacyMode": false`，确认 GET `/api/config` 能返回该字段，POST 能保存。

现有的 `POST /api/config` 只校验 `cfg.categories` 是数组（server.js:299-300），然后 `writeJSON(CONFIG_FILE, cfg)` 直接写入整个对象，所以 `privacyMode` 字段会被自然保存。无需改代码。

- [ ] **Step 2: Commit**

```bash
# 无代码改动，仅确认兼容性，跳过此 commit
```

---

### Task 2: 前端 migrateConfig 增加 privacyMode 默认值

**Files:**
- Modify: `public/app.js:119-130` (`migrateConfig` 方法)

- [ ] **Step 1: 在 migrateConfig 中添加 privacyMode 默认值**

在 `public/app.js` 的 `migrateConfig()` 方法末尾（第 129 行 `}` 之前）添加：

```javascript
            if (this.config.privacyMode === undefined) {
                this.config.privacyMode = false;
            }
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat: migrateConfig 增加 privacyMode 默认值"
```

---

### Task 3: 搜索输入处理支持 `//` 隐私模式触发

**Files:**
- Modify: `public/app.js:668-692` (`handleSearchInput` 方法)
- Modify: `public/app.js:422-424` (`isFavSearchTrigger` 方法)

核心逻辑：输入 `//` 时，如果已登录且 `privacyMode` 开启，进入隐私搜索模式；否则 `//` 等同于 `/`。

- [ ] **Step 1: 在 App 类中增加 privacySearchActive 状态跟踪**

在 `isFavSearchTrigger` 方法之前添加一个辅助方法：

```javascript
        isPrivacySearchEnabled() {
            return !!(this.password && this.config.privacyMode);
        }
```

- [ ] **Step 2: 修改 handleSearchInput 处理 `//` 触发**

将 `handleSearchInput` 方法（第 668-692 行）替换为：

```javascript
        handleSearchInput(e) {
            const value = e.target.value;

            // 检查收藏检索模式（/ 或 //）
            const isFavMode = value.length > 0 && this.isFavSearchTrigger(value[0]);

            // 检测是否为隐私模式触发（//）
            const isPrivacyTrigger = isFavMode && value.length >= 2 && this.isFavSearchTrigger(value[1]);

            if (isFavMode !== this.favSearchMode) {
                this.favSearchMode = isFavMode;
                this.privacySearchActive = isPrivacyTrigger && this.isPrivacySearchEnabled();
                this.toggleFavSearchMode(isFavMode);
            } else if (isFavMode) {
                // 模式已激活，但需要更新隐私状态（如从 / 变为 //）
                const newPrivacyState = isPrivacyTrigger && this.isPrivacySearchEnabled();
                if (newPrivacyState !== this.privacySearchActive) {
                    this.privacySearchActive = newPrivacyState;
                    // 重新触发搜索以更新过滤结果
                }
            }

            // 如果在收藏检索模式，执行防抖搜索
            if (this.favSearchMode) {
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
```

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: handleSearchInput 支持 // 隐私模式触发"
```

---

### Task 4: 搜索过滤逻辑 - 排除隐私书签

**Files:**
- Modify: `public/app.js:466-477` (`showFavDropdown` 方法)
- Modify: `public/app.js:486-530` (`searchFavorites` 方法)
- Modify: `public/app.js:300-342` (`buildSearchIndex` 方法)

需要在搜索时根据 `this.privacySearchActive` 过滤隐私书签。

- [ ] **Step 1: 添加获取可搜索收藏列表的辅助方法**

在 `buildSearchIndex` 方法之前添加：

```javascript
        getSearchableFavorites() {
            if (this.privacySearchActive) {
                return this.favorites;
            }
            return this.favorites.filter(f => !f.private);
        }
```

- [ ] **Step 2: 修改 buildSearchIndex 同时构建两套索引**

将 `buildSearchIndex` 方法替换为同时构建全量和非隐私两套 haystack：

```javascript
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

            // 初始化 uFuzzy
            if (typeof uFuzzy !== 'undefined') {
                this.uf = new uFuzzy({
                    intraMode: 1,
                    intraIns: 1,
                    interIns: 3,
                });
            }
        }
```

- [ ] **Step 3: 修改 showFavDropdown 过滤隐私书签**

将 `showFavDropdown` 方法（第 466-477 行）替换为：

```javascript
        showFavDropdown() {
            let dropdown = $('#favDropdown');
            if (!dropdown) {
                dropdown = html('<div class="fav-dropdown" id="favDropdown"></div>');
                $('.search-wrapper').appendChild(dropdown);
            }
            dropdown.hidden = false;
            this.favSelectedIdx = 0;

            // 根据隐私模式过滤显示
            const favs = this.getSearchableFavorites();
            this.renderFavResults(favs.slice(0, 10), null, null);
        }
```

- [ ] **Step 4: 修改 searchFavorites 支持隐私过滤**

将 `searchFavorites` 方法（第 486-530 行）替换为：

```javascript
        searchFavorites(query) {
            const dropdown = $('#favDropdown');
            if (!dropdown) return;

            const isPrivate = this.privacySearchActive;
            const favList = this.getSearchableFavorites();

            // 如果没有收藏，显示提示
            if (favList.length === 0) {
                dropdown.innerHTML = '<div class="fav-empty">无收藏，请在管理面板中导入</div>';
                return;
            }

            if (!query) {
                this.renderFavResults(favList.slice(0, 10), null, null, null);
                return;
            }

            // 选择对应的 haystack
            const haystack = isPrivate ? this.favHaystack : this.publicFavHaystack;
            const indexMap = isPrivate ? null : this.publicFavIndices;

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
```

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: 搜索过滤支持隐私书签排除"
```

---

## Chunk 2: UI 层 - 后台面板、对话框、搜索结果

### Task 5: 后台管理面板增加隐私模式开关和登出按钮

**Files:**
- Modify: `public/app.js:921-1033` (`renderAdminPanel` 方法)
- Modify: `public/app.js:917-919` (`closeAdmin` 方法)

- [ ] **Step 1: 在界面设置 section 末尾添加隐私模式开关**

在 `renderAdminPanel` 方法的界面设置 section 中（第 954 行 `</div>` 之后，第 955 行 `</div>` 之前），添加隐私模式开关：

```javascript
                    <div class="setting-row">
                        <label>
                            <span>隐私模式</span>
                            <div class="toggle-switch">
                                <input type="checkbox" id="privacyModeToggle" ${this.config.privacyMode ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </div>
                        </label>
                    </div>
```

- [ ] **Step 2: 在收藏 section 的 fav-actions 末尾添加登出按钮**

在 `renderAdminPanel` 的书签分类 section 之后（第 993 行 `</div>` 之后），收藏 section 结束标签之前，添加登出按钮区域。

在整个面板末尾（第 993 行之后，反引号 `` ` `` 之前）添加：

```javascript
                <div class="section">
                    <button class="btn btn-danger" id="logoutBtn" style="width: 100%;">退出登录</button>
                </div>
```

- [ ] **Step 3: 绑定隐私模式开关和登出按钮事件**

在 `renderAdminPanel` 方法的事件绑定区域（第 1029 行 `$('#exportFavBtn')` 之后）添加：

```javascript
            // 隐私模式开关
            $('#privacyModeToggle').onchange = (e) => {
                this.config.privacyMode = e.target.checked;
                this.saveConfig();
            };

            // 登出按钮
            $('#logoutBtn').onclick = () => {
                this.password = null;
                this.privacySearchActive = false;
                this.closeAdmin();
            };
```

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat: 后台管理面板增加隐私模式开关和登出按钮"
```

---

### Task 6: toggle-switch CSS 样式

**Files:**
- Modify: `public/styles.css` (添加 toggle-switch 样式)

- [ ] **Step 1: 检查是否已有 toggle-switch 样式**

在 `public/styles.css` 中搜索 `toggle-switch`，如果不存在则添加。

- [ ] **Step 2: 添加 toggle-switch 样式**

在 `public/styles.css` 的管理面板相关样式区域添加：

```css
/* 隐私模式开关 */
.toggle-switch {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
}

.toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
}

.toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: #ccc;
    border-radius: 24px;
    transition: 0.3s;
}

.toggle-slider:before {
    content: "";
    position: absolute;
    height: 18px;
    width: 18px;
    left: 3px;
    bottom: 3px;
    background-color: white;
    border-radius: 50%;
    transition: 0.3s;
}

.toggle-switch input:checked + .toggle-slider {
    background-color: #4f46e5;
}

.toggle-switch input:checked + .toggle-slider:before {
    transform: translateX(20px);
}
```

- [ ] **Step 3: 添加登出按钮危险样式（如果不存在）**

```css
.btn-danger {
    background: #ef4444;
    color: white;
    border: none;
}

.btn-danger:hover {
    background: #dc2626;
}
```

- [ ] **Step 4: Commit**

```bash
git add public/styles.css
git commit -m "feat: 隐私模式开关和登出按钮样式"
```

---

### Task 7: 收藏创建/编辑对话框增加隐私保护选项

**Files:**
- Modify: `public/app.js:1609-1692` (`showAddFavDialog` 方法)
- Modify: `public/app.js:2349-2387` (`editFavorite` 方法)

- [ ] **Step 1: 修改 showAddFavDialog 添加隐私保护复选框**

在 `showAddFavDialog` 的表单中（第 1634 行 tags input 之后），添加：

```javascript
                            <label class="fav-checkbox-row">
                                <input type="checkbox" id="favPrivate">
                                <span>隐私保护</span>
                            </label>
```

在保存逻辑中（第 1676-1685 行 newFav 对象），添加 `private` 字段：

```javascript
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
```

- [ ] **Step 2: 修改 editFavorite 添加隐私保护复选框**

在 `editFavorite` 的表单中（第 2362 行 tags input 之后），添加：

```javascript
                            <label class="fav-checkbox-row">
                                <input type="checkbox" id="editFavPrivate" ${fav.private ? 'checked' : ''}>
                                <span>隐私保护</span>
                            </label>
```

在保存逻辑中（第 2380 行 tags 赋值之后），添加：

```javascript
                fav.private = $('#editFavPrivate').checked;
```

- [ ] **Step 3: 添加复选框行样式**

在 `public/styles.css` 中添加：

```css
.fav-checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    cursor: pointer;
    font-size: 14px;
}

.fav-checkbox-row input[type="checkbox"] {
    width: 16px;
    height: 16px;
    cursor: pointer;
}
```

- [ ] **Step 4: Commit**

```bash
git add public/app.js public/styles.css
git commit -m "feat: 收藏创建和编辑支持隐私保护选项"
```

---

### Task 8: 搜索结果中隐私书签显示小锁图标

**Files:**
- Modify: `public/app.js:532-572` (`renderFavResults` 方法)
- Modify: `public/styles.css`

- [ ] **Step 1: 修改 renderFavResults 为隐私书签添加锁图标**

在 `renderFavResults` 方法中（第 563 行 `<div class="fav-title">` 内），修改标题行：

将第 563 行：
```javascript
                            <div class="fav-title">${titleHtml}</div>
```

替换为：
```javascript
                            <div class="fav-title">${fav.private ? '<svg class="fav-private-icon" viewBox="0 0 24 24" width="12" height="12"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> ' : ''}${titleHtml}</div>
```

- [ ] **Step 2: 添加锁图标样式**

在 `public/styles.css` 中添加：

```css
.fav-private-icon {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.5;
    vertical-align: middle;
    margin-right: 2px;
    flex-shrink: 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add public/app.js public/styles.css
git commit -m "feat: 搜索结果中隐私书签显示锁图标"
```

---

### Task 9: 最终验证与清理

- [ ] **Step 1: 手动测试清单**

1. 未登录时输入 `/` → 显示非隐私书签
2. 未登录时输入 `//` → 等同 `/`，只显示非隐私书签
3. 登录后台 → 隐私模式开关默认关闭
4. 开启隐私模式开关 → 输入 `//` 显示全量书签，隐私书签带锁图标
5. 输入 `/` → 仍只显示非隐私书签
6. 关闭隐私模式开关 → `//` 回退为普通搜索
7. 点击登出按钮 → 后台面板关闭，`//` 失效
8. 添加收藏时勾选隐私保护 → 保存后该书签 `private: true`
9. 编辑收藏时可查看和修改隐私保护状态
10. 重新登录 → 隐私模式开关恢复上次的状态

- [ ] **Step 2: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: 隐私模式功能修复"
```

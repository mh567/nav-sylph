((root) => {
    'use strict';
const FIELDS = ['theme', 'showBookmarkIcons', 'searchEngine', 'searchEngines', 'categories'];
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, max = 200) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function url(value) {
    if (!text(value, 4096)) return false;
    try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
}
function keys(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('配置包含不允许的字段');
}
function unique(items, max) {
    if (!Array.isArray(items) || items.length > max || items.some(i => !i || !text(i.id, 100)) || new Set(items.map(i => i.id)).size !== items.length) fail('配置数量或标识无效');
}
function validate(value) {
    keys(value, FIELDS);
    if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) fail('配置超过 1 MiB');
    if (!['auto', 'light', 'dark'].includes(value.theme) || typeof value.showBookmarkIcons !== 'boolean') fail('显示偏好无效');
    unique(value.searchEngines, 50);
    if (!value.searchEngines.length || !value.searchEngines.some(e => e.id === value.searchEngine)) fail('请选择有效搜索引擎');
    for (const e of value.searchEngines) {
        keys(e, ['id', 'name', 'url']);
        if (!text(e.name) || !url(e.url) || /[{}]/.test(e.url)) fail('搜索引擎须使用 HTTP/HTTPS 关键词前缀地址');
    }
    unique(value.categories, 100); let count = 0; const ids = new Set();
    for (const c of value.categories) {
        keys(c, ['id', 'name', 'bookmarks']);
        if (!text(c.name)) fail('分类名称无效');
        unique(c.bookmarks, 2000); count += c.bookmarks.length;
        for (const b of c.bookmarks) {
            keys(b, ['id', 'title', 'url']);
            if (!text(b.title) || !url(b.url) || ids.has(b.id)) fail('导航链接无效');
            ids.add(b.id);
        }
    }
    if (count > 2000) fail('导航链接超过 2000 条');
    return value;
}
function publicConfig(value) {
    // 旧公开过滤只移除 privacyMode；再用封闭白名单隔离所有私人字段。
    const { privacyMode, ...legacy } = value;
    return Object.fromEntries(FIELDS.map(k => [k, legacy[k]]));
}
const schema = { validate, publicConfig, FIELDS };
if (typeof module !== 'undefined' && module.exports) module.exports = schema;
else root.NavigationSchema = schema;
})(globalThis);

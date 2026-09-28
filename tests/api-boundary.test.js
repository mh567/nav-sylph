const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// server.js starts the HTTP listener when loaded, so exercise its
// projection and merge helpers directly, as backup-privacy.test.js does.
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const begin = server.indexOf('function toPublicConfig(');
const end = server.indexOf('// 获取收藏书签', begin);
assert.ok(begin >= 0 && end > begin, 'public view helpers are present');

const { toPublicConfig, toPublicFavorites, mergeFavorites, mergeConfig } = vm.runInNewContext(
    `${server.slice(begin, end)}; ({ toPublicConfig, toPublicFavorites, mergeFavorites, mergeConfig })`
);

function fav(id, extra = {}) {
    return { id, title: `title-${id}`, url: `https://example.com/${id}`, ...extra };
}

test('the public favorites view drops private entries and the private field itself', () => {
    const view = toPublicFavorites({
        version: 1,
        favorites: [fav('a'), fav('b', { private: true }), fav('c', { private: false })]
    });

    assert.equal(view.version, 1);
    assert.deepEqual(view.favorites.map(f => f.id), ['a', 'c']);
    for (const item of view.favorites) {
        assert.equal('private' in item, false, 'public items carry no private field');
    }
    assert.equal(view.favorites.some(f => f.url === 'https://example.com/b'), false);
});

test('the public favorites view keeps a missing or malformed favorites list safe', () => {
    // vm.runInNewContext gives this realm its own Array, so compare shape not identity
    assert.equal(toPublicFavorites({}).favorites.length, 0);
    assert.equal(toPublicFavorites({ favorites: 'nope' }).favorites.length, 0);
    assert.equal(toPublicFavorites(null).favorites.length, 0);
    assert.equal(toPublicFavorites({}).version, 1);
});

test('the public config view drops privacyMode and keeps the rendered fields', () => {
    const view = toPublicConfig({
        theme: 'dark',
        searchEngine: 'google',
        privacyMode: true,
        categories: [{ id: 'c1', name: 'x', bookmarks: [] }]
    });

    assert.equal('privacyMode' in view, false);
    assert.equal(view.theme, 'dark');
    assert.equal(view.searchEngine, 'google');
    assert.equal(view.categories.length, 1);
});

test('a private favorite absent from the submitted list survives a save', () => {
    const existing = { favorites: [fav('a'), fav('secret', { private: true }), fav('c')] };
    const merged = mergeFavorites(existing, [fav('a'), fav('c')]);

    // 保留原始文件顺序，缺席的私密条目留在原位
    assert.deepEqual(merged.map(f => f.id), ['a', 'secret', 'c']);
    assert.equal(merged[1].private, true);
});

test('a public favorite absent from the submitted list is removed', () => {
    const existing = { favorites: [fav('a'), fav('b'), fav('secret', { private: true })] };
    const merged = mergeFavorites(existing, [fav('a')]);

    assert.deepEqual(merged.map(f => f.id), ['a', 'secret']);
});

test('a submitted favorite with a known id overwrites that entry in place', () => {
    const existing = { favorites: [fav('a'), fav('b')] };
    const updated = fav('b', { title: 'renamed' });
    const merged = mergeFavorites(existing, [fav('a'), updated]);

    assert.deepEqual(merged.map(f => f.id), ['a', 'b']);
    assert.equal(merged[1].title, 'renamed');
});

test('a submitted favorite without an id is appended at the end', () => {
    const existing = { favorites: [fav('a')] };
    const merged = mergeFavorites(existing, [fav('a'), { id: '', title: 'brand new' }]);

    assert.equal(merged.length, 2);
    assert.equal(merged[1].title, 'brand new');
});

test('merging keeps the original order of existing favorites', () => {
    const existing = { favorites: [fav('a'), fav('b'), fav('c')] };
    const merged = mergeFavorites(existing, [fav('c'), fav('a'), fav('b')]);

    assert.deepEqual(merged.map(f => f.id), ['a', 'b', 'c']);
});

test('merging config preserves privacyMode that the public view never carried', () => {
    const existing = { theme: 'dark', privacyMode: true };
    const submitted = { theme: 'light', categories: [] };
    const merged = mergeConfig(existing, submitted);

    assert.equal(merged.privacyMode, true, 'privacyMode survives a save from the public view');
    assert.equal(merged.theme, 'light', 'submitted fields still win');
    assert.equal(merged.categories.length, 0);
});

test('the anonymous read routes project their responses instead of sending whole files', () => {
    assert.match(server, /app\.get\('\/api\/config',[\s\S]*?res\.json\(toPublicConfig\(cfg\)\)/);
    assert.match(server, /app\.get\('\/api\/favorites',[\s\S]*?res\.json\(toPublicFavorites\(data\)\)/);
});

test('the favorites write route merges instead of overwriting the whole file', () => {
    const route = server.slice(server.indexOf("app.post('/api/favorites'"), server.indexOf("app.post('/api/favorites/import'"));
    assert.match(route, /mergeFavorites\(existing, favorites\)/);
    assert.doesNotMatch(route, /favorites: favorites\s*[,}]/, 'must not write the request body straight to disk');
});

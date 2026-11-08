'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { installation } = require('./helpers/installation');

test('removed text-sharing pages, APIs and dedicated libraries are unavailable', async t => {
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const login = await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const route of ['/api/p/code', '/api/p', '/api/p/tiger-482']) {
        assert.equal((await app.request(route, { cookie, body: {} })).status, 404, route);
    }
    for (const auth of [{}, { cookie }]) {
        for (const route of ['/p/tiger-482', '/P/tiger-482', '/lib/qrcode.js', '/lib/highlight.min.js']) {
            assert.equal((await app.request(route, auth)).status, 404, route);
        }
    }
    const home = await (await app.request('/', { cookie })).text();
    assert.doesNotMatch(home, /分享文本|取件码/);
    assert.equal((await app.request('/api/admin/navigation', { cookie })).status, 200);
    assert.equal((await app.request('/api/favorites', { cookie })).status, 200);
});

test('former sharing input remains ordinary search and bookmark search still works', async () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const input = { value: '' };
    const document = { readyState: 'loading', addEventListener() {}, querySelector: selector => selector === '#searchInput' ? input : null };
    const window = {};
    vm.runInNewContext(source.replace('    let app;', '    window.AppForTest = App;\n    let app;'), { document, window });
    const app = Object.create(window.AppForTest.prototype);
    Object.assign(app, { authenticated: true, favSearchMode: false, privacySearchActive: false });
    const searched = [];
    app.search = () => searched.push(input.value);
    app.toggleFavSearchMode = () => {};
    app.debouncedSearchFavorites = query => searched.push('bookmark:' + query);
    for (const value of ['> hello', '》hello', 'tiger-482', 'https://example.com/p/tiger-482']) {
        input.value = value;
        app.handleSearchInput(input);
        assert.equal(app.favSearchMode, false);
        await app.handleSearch();
        assert.equal(searched.at(-1), value);
    }
    input.value = '/needle';
    app.handleSearchInput(input);
    assert.equal(app.favSearchMode, true);
    assert.equal(searched.at(-1), 'bookmark:needle');
});

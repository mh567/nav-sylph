'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../public/navigation-schema');
const config = { theme: 'auto', showBookmarkIcons: true, searchEngine: 'one', searchEngines: [{ id: 'one', name: 'Search', url: 'https://example.com/?q=' }], categories: [] };

test('themes: legacy configuration stays valid; registered styles survive public projection', () => {
    assert.deepEqual(schema.validate(structuredClone(config)), config);
    const prism = { ...config, themeStyle: 'prism' };
    assert.deepEqual(schema.validate(schema.publicConfig(prism)), prism);
    assert.throws(() => schema.validate({ ...config, themeStyle: 'unknown' }), /主题/);
    assert.throws(() => schema.validate({ ...config, themeStyle: { id: 'prism' } }), /主题/);
});

test('themes: fixed dark style preserves the saved classic mode', () => {
    assert.deepEqual(schema.appearance({ ...config, themeStyle: 'prism' }), { style: 'prism', mode: 'dark' });
    assert.deepEqual(schema.appearance(config), { style: 'prism', mode: 'dark' });
    assert.deepEqual(schema.appearance({ ...config, themeStyle: 'classic', theme: 'light' }), { style: 'classic', mode: 'light' });
});

test('themes: personal and published styles persist through real HTTP writes and restart', async t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const bcrypt = require('bcrypt');
    const { installation } = require('./helpers/installation');
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, '.admin-password.json'), JSON.stringify({ passwordHash: await bcrypt.hash('StrongPass123!', 4) }));
    await app.start();
    const login = await app.request('/api/verify-password', { password: 'StrongPass123!', body: {} });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const personal = await (await app.request('/api/admin/navigation', { cookie })).json();
    const prism = { ...personal.config, themeStyle: 'prism', theme: 'light' };
    assert.equal((await app.request('/api/admin/navigation', { cookie, body: { config: prism, revision: personal.revision, operationId: 'theme-personal' } })).status, 200);
    assert.equal((await (await app.request('/api/config')).json()).themeStyle, 'prism');
    const draft = await (await app.request('/api/admin/default-homepage', { cookie })).json();
    const saved = await (await app.request('/api/admin/default-homepage/draft', { cookie, body: { config: { ...draft.config, themeStyle: 'prism' }, revision: draft.revision, operationId: 'theme-draft' } })).json();
    assert.equal((await app.request('/api/admin/default-homepage/publish', { cookie, body: { revision: saved.revision, publishedRevision: draft.publishedRevision, operationId: 'theme-publish' } })).status, 200);
    await app.stop();
    await app.start();
    assert.equal((await (await app.request('/api/config')).json()).themeStyle, 'prism');
    const persisted = await (await app.request('/api/admin/navigation', { cookie })).json();
    assert.equal(persisted.config.themeStyle, 'prism');
    assert.equal(persisted.config.theme, 'light');
    const share = await (await app.request('/p/tiger-482')).text();
    assert.match(share, /data-theme-style="prism" data-theme="dark"/);
    assert.match(share, /href="\/themes.css"/);
});


test('themes: explicit classic installation remains classic after default changes and restart', async t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { installation } = require('./helpers/installation');
    const app = await installation(t);
    fs.writeFileSync(path.join(app.dir, 'config.json'), JSON.stringify({ ...config, themeStyle: 'classic', theme: 'light' }));
    await app.start();
    const first = await (await app.request('/api/config')).json();
    assert.equal(first.themeStyle, 'classic');
    assert.deepEqual(schema.appearance(first), { style: 'classic', mode: 'light' });
    await app.stop();
    await app.start();
    assert.equal((await (await app.request('/api/config')).json()).themeStyle, 'classic');
});

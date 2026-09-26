const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'public/styles.css'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');

test('mobile favorites list stays anchored below its search wrapper', () => {
    assert.equal(/@media\s*\(max-width:\s*768px\)\s*\{\s*\.fav-dropdown\s*\{[^}]*position:\s*fixed\s*;[^}]*bottom:\s*0\s*;/s.test(css), false);
    assert.equal(/@media\s*\(max-height:\s*500px\)[^{]*\{\s*\.fav-dropdown\s*\{[^}]*position:\s*fixed\s*;/s.test(css), false);
});

test('outside pointer interaction closes favorites and input can reopen them', () => {
    const clickStart = app.indexOf('document.onclick = (e) => {');
    const clickEnd = app.indexOf('document.onkeydown =', clickStart);
    assert.ok(clickStart >= 0 && clickEnd > clickStart);
    assert.match(app.slice(clickStart, clickEnd), /this\.hideFavDropdown\(\)/);
    assert.match(app, /searchInput.*(?:onclick|addEventListener\(['"]click)/s);
});

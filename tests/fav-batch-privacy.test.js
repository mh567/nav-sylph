const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const adminCss = fs.readFileSync(path.join(__dirname, '..', 'public/admin.css'), 'utf8');
const exportPoint = '    let app;\n';
assert.equal(source.split(exportPoint).length, 2);

// 取出某个 @media 块的正文。同一查询在文件里可能出现多次，
// requiredIn 用来定位真正包含目标规则的块，否则会断言到无关的块上。
function mediaBlock(css, query, requiredIn) {
    const blocks = [];
    let searchFrom = 0;
    for (;;) {
        const start = css.indexOf(query, searchFrom);
        if (start === -1) break;
        const open = css.indexOf('{', start);
        let depth = 0;
        for (let i = open; i < css.length; i++) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') {
                depth--;
                if (depth === 0) { blocks.push(css.slice(open + 1, i)); searchFrom = i; break; }
            }
        }
    }
    assert.ok(blocks.length > 0, `样式表里存在 ${query}`);
    const match = requiredIn ? blocks.find(body => body.includes(requiredIn)) : blocks[0];
    assert.ok(match, `${query} 中存在包含 ${requiredIn} 的块`);
    return match;
}

// 只驱动目标方法，不让 App 构造函数跑 init()：
// readyState 必须是 'loading'，否则 app.js 会 new App() 并在 init 里访问真实 DOM，
// 报错的栈指向 App.init 而测试本身却显示通过。
function loadApp() {
    const window = {};
    const document = { readyState: 'loading', addEventListener() {} };
    vm.runInNewContext(source.replace(exportPoint, '    window.AppForTest = App;\n' + exportPoint), {
        window,
        document,
        setTimeout,
        clearTimeout
    });
    return Object.create(window.AppForTest.prototype);
}

function favs(count, privateFlags) {
    // updatedAt 必须有真实初值：回滚断言要验证它被还原回这个值，
    // 而不是一个缺失字段（undefined 参与比较会让断言恒真）
    return Array.from({ length: count }, (_, i) => ({
        id: `f${i}`,
        title: `t${i}`,
        url: `https://e${i}.com`,
        private: privateFlags ? !!privateFlags[i] : false,
        updatedAt: 1000 + i
    }));
}

// 驱动真实的 privacySelectedFavorites：只替换弹窗与保存两个边界，
// 选取、改写、回滚逻辑都走生产代码本身。
function runBatch(app, { selected, favorites, choices, saveOk = true }) {
    app.favorites = favorites;
    app.favManagerSelected = new Set(selected);
    const toasts = [];
    app.showToast = (message, state) => toasts.push({ message, state });
    app.showFavManager = () => {};
    app.saveFavorites = async () => saveOk;
    app.showUiDialog = async () => choices ? { values: [], choices } : null;
    return app.privacySelectedFavorites().then(() => toasts);
}

test('批量隐私按钮随选中状态启用，未选中时禁用', () => {
    assert.match(source, /id="privacySelectedBtn"[^>]*>隐私</);
    // 用方法签名做上下界：若用 indexOf('async deleteSelectedFavorites') 当上界，
    // 该符号被改名时 indexOf 返回 -1，slice 会退化成「截到字符串末尾」而静默通过
    const start = source.indexOf('updateBatchBar() {');
    const end = source.indexOf('async privacySelectedFavorites()');
    assert.ok(start >= 0 && end > start, 'updateBatchBar 与 privacySelectedFavorites 都在');
    const fn = source.slice(start, end);
    assert.match(fn, /privacyBtn\.disabled = count === 0;/);
    // 两个按钮的启用条件必须一致，否则会出现「能删不能改隐私」或反之
    assert.match(fn, /deleteBtn\.disabled = count === 0;/);
});

test('批量隐私按钮接到了点击事件上', () => {
    // 上一条只覆盖 updateBatchBar 里的 disabled 赋值，按钮点了没反应也不会红
    assert.match(source, /\$\('#privacySelectedBtn'\)\.onclick = \(\) => this\.privacySelectedFavorites\(\);/);
});

test('批量设为私密：选中的项全部置为私密并保存', async () => {
    const app = loadApp();
    const list = favs(3, [false, true, false]);
    await runBatch(app, { selected: ['f0', 'f1', 'f2'], favorites: list, choices: { privacy: 'private' } });
    assert.deepEqual(list.map(f => f.private), [true, true, true]);
    // 改过的项时间戳应从初值推进，钉住「确实动了这些记录」而不只是翻了布尔位
    assert.ok(list.every(f => f.updatedAt > 1000), 'updatedAt 应从初值推进');
});

test('批量设为公开：全部置为公开', async () => {
    const app = loadApp();
    const list = favs(2, [true, true]);
    await runBatch(app, { selected: ['f0', 'f1'], favorites: list, choices: { privacy: 'public' } });
    assert.deepEqual(list.map(f => f.private), [false, false]);
});

test('批量隐私只作用于选中项，未选中的收藏保持原状', async () => {
    const app = loadApp();
    const list = favs(3, [false, false, true]);
    await runBatch(app, { selected: ['f0', 'f2'], favorites: list, choices: { privacy: 'private' } });
    // f1 未选中，原本是公开，改完必须仍是公开
    assert.deepEqual(list.map(f => f.private), [true, false, true]);
});

test('取消弹窗不改动任何收藏', async () => {
    const app = loadApp();
    const list = favs(2, [false, true]);
    await runBatch(app, { selected: ['f0', 'f1'], favorites: list, choices: null });
    assert.deepEqual(list.map(f => f.private), [false, true]);
});

test('保存失败时完整回滚，不留下与服务端不一致的界面', async () => {
    const app = loadApp();
    // 混选：回滚必须逐项还原，不能被后一项覆盖
    const list = favs(3, [false, true, false]);
    const before = list.map(f => ({ ...f }));
    await runBatch(app, { selected: ['f0', 'f1', 'f2'], favorites: list, choices: { privacy: 'private' }, saveOk: false });
    assert.deepEqual(list.map(f => f.private), [false, true, false]);
    // updatedAt 也是本次改的字段，必须一并还原：只还原 private 会让
    // 时间戳停在一次失败的操作上，与 private 的旧值在时间上不自洽
    assert.deepEqual(list.map(f => f.updatedAt), before.map(f => f.updatedAt), 'updatedAt 应回滚到初值');
});

test('混选时默认预选「设为私密」，全部已私密才预选「设为公开」', () => {
    // 批量收紧可见性比放宽更安全，混选不能默认落在「设为公开」
    assert.match(source, /const allPrivate = targets\.every\(f => f\.private\);/);
    // 只断言 checked 的绑定关系，不把对象写成单行——排版不是这里要钉的东西
    assert.match(source, /label: '设为私密', checked: !allPrivate/);
    assert.match(source, /label: '设为公开', checked: allPrivate/);
    // 两个方向风险不对称：设为私密只收紧可见性，设为公开是对匿名访客披露。
    // 提示必须挂在披露方向上，且不新增弹窗（用户选定的形态就是单层弹窗）
    const publicOption = /\{[^}]*kind: 'radio'[^{}]*value: 'public'[^{}]*\}/.exec(source);
    assert.ok(publicOption, '找不到「设为公开」选项对象');
    assert.match(publicOption[0], /hint: '公开后[^\n]*访客/);
    const privateOption = /\{[^}]*kind: 'radio'[^{}]*value: 'private'[^{}]*\}/.exec(source);
    assert.ok(privateOption, '找不到「设为私密」选项对象');
    assert.doesNotMatch(privateOption[0], /hint:/, '收紧方向不需要风险提示');
});

test('收藏管理列表复用首页的私密标签样式，紧跟分类标签', () => {
    // 用户选定的是「复用首页已有的 .fav-private-label，在分类标签旁显示」。
    // 不新建近似的类名，否则视觉规范会有两份来源。
    assert.match(source, /\$\{fav\.private \? '<span class="fav-private-label">私密<\/span>' : ''\}/);
    const item = source.slice(source.indexOf('class="fav-manager-item"'), source.indexOf('fav-manager-actions'));
    assert.match(item, /fav-manager-category[\s\S]*fav-private-label/, '私密标签应排在分类标签之后');
    assert.doesNotMatch(source, /fav-manager-private/, '不应新建重复的标签类名');
    // 标签必须留在 .fav-manager-info 之外：info 在 ≤480px 下是 1 1 auto，
    // 塞进去就不再与分类标签同行了
    const info = source.slice(source.indexOf('class="fav-manager-info"'), source.indexOf('fav-manager-category"'));
    assert.doesNotMatch(info, /fav-private-label/, '标签应是 info 的兄弟节点，不能塞进 info 块内');
});

test('窄屏私密标签跟分类标签同一 order，不会被排到标题前', () => {
    // ≤480px 下真正生效的是 admin.css 的 .modal 作用域规则（加载更晚、特异性更高），
    // styles.css 里那套 order:2/3 不是最终决定权。标签默认 order:0 会排到
    // order:1 的信息块之前，因此必须在 admin.css 里跟分类标签一样排 order:3。
    const block = mediaBlock(adminCss, '@media (max-width: 480px)', '.fav-manager-category');
    const rule = /\.fav-private-label\s*\{([^}]*)\}/.exec(block);
    assert.ok(rule, 'admin.css ≤480px 块中缺少私密标签的 order 规则');
    assert.match(rule[1], /order:\s*3\s*;/, '应与分类标签同 order（3）');

    const categoryRule = /\.fav-manager-category\s*\{([^}]*)\}/.exec(block);
    assert.match(categoryRule[1], /order:\s*3\s*;/, '分类标签 order 应为 3（与标签一致）');
});

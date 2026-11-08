#!/usr/bin/env node
/**
 * 生成演示页 public/demo/index.html。
 *
 * 为什么要生成而不是直接手写 HTML：演示页要和产品长得一模一样，而产品样式
 * 一直在变。把 public/styles.css + public/themes.css 内联进单文件，演示页
 * 就自动跟着产品走；成品落在 public/demo/ 下，随 public/ 一起发版，服务器上
 * 直接以 /demo/ 对外提供——静态文件不经过登录门禁，也不占什么 CPU。
 *
 * 改法：改 demo/template.html（页面结构与假数据），改完跑
 *   node demo/build.js
 * 产品样式改了不用改这里——重新跑一次 build 就会带上新的样式。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function read(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * 模板里的 <script> 必须能解析，否则生成的页面会整页白屏（浏览器里只报一句
 * SyntaxError，肉眼很难定位到是模板哪一行）。这里在生成前先过一遍 node --check。
 */
function assertScriptParses(html) {
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('模板里找不到 <script> 块');
    const tmp = path.join(os.tmpdir(), `habu-demo-script-${process.pid}.js`);
    fs.writeFileSync(tmp, match[1]);
    try {
        const check = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
        if (check.status !== 0) {
            throw new Error('模板脚本语法有误：\n' + (check.stderr || '').trim());
        }
    } finally {
        fs.unlinkSync(tmp);
    }
}

/** 字体转成 data URI：单文件才能双击打开、随便转发。 */
function inlineFont(css) {
    const fontFile = path.join(PUBLIC, 'fonts', 'inter-tight-latin-variable.woff2');
    if (!fs.existsSync(fontFile)) {
        console.warn('[demo] 未找到字体文件，跳过内联（页面会回落到系统字体）');
        return css;
    }
    const base64 = fs.readFileSync(fontFile).toString('base64');
    return css.replace(/url\(['"]?fonts\/inter-tight-latin-variable\.woff2['"]?\)/g,
        `url('data:font/woff2;base64,${base64}')`);
}

const template = read('demo/template.html');
assertScriptParses(template);
const css = [
    '/* ---- public/styles.css ---- */',
    inlineFont(read('public/styles.css')),
    '/* ---- public/themes.css ---- */',
    inlineFont(read('public/themes.css'))
].join('\n');

// CSS 里出现 </style> 会提前关掉 <style> 标签，页面后半段全部当文本渲染。
if (/<\/style/i.test(css)) {
    console.error('[demo] 样式表里出现 </style，生成中止');
    process.exit(1);
}

const out = template.replace('/*__PRODUCT_CSS__*/', () => css);
// 成品落在 public/demo/ 下：public/ 会被 express.static 直接对外提供，
// 所以放到这里就等于「随发版走的一次性公开页面」——
//   https://<你的域名>/demo/
// 静态文件不经过登录门禁（门禁只拦 / 与 /api/*），也几乎不占 CPU。
// 源模板与本脚本留在仓库根的 demo/，不进发布包（发布脚本只 cp public/）。
const target = path.join(ROOT, 'public', 'demo', 'index.html');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);

const kb = (fs.statSync(target).size / 1024).toFixed(1);
console.log(`[demo] 已生成 public/demo/index.html（${kb} KB，纯静态、零外部请求）`);

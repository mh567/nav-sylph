'use strict';

/**
 * provider 与事件类型的注册表。
 *
 * 「可扩展」= 加一个 adapter 文件并在这里登记；运行时加载第三方插件不在
 * 范围（那会引入本仓库明确拒绝的任意代码执行面）。
 */

const manual = require('./adapters/manual');
const x = require('./adapters/x');
const weibo = require('./adapters/weibo');

const PROVIDERS = new Map([
    [manual.id, manual],
    [x.id, x],
    [weibo.id, weibo]
]);

function getProvider(type) {
    return PROVIDERS.get(type) || null;
}

function isProvider(type) {
    return PROVIDERS.has(type);
}

/** 后台表单要渲染的 provider 选项（手动来源不由用户添加，故排除）。 */
function selectableProviders() {
    return [...PROVIDERS.values()]
        .filter(p => p.accountLabel)
        .map(p => ({ id: p.id, label: p.label, accountLabel: p.accountLabel, credentialLabel: p.credentialLabel,
            requiresCredentials: p.requiresCredentials === true,
            defaultSyncIntervalMs: p.defaultSyncIntervalMs,
            syncIntervalsMs: p.syncIntervalsMs }));
}

/**
 * 事件类型注册表。标签按 provider 细分（X 的推文与微博的动态叫法不同），
 * 未知类型回落通用标签——**不隐藏，也不猜**。
 */
const EVENT_TYPES = {
    social_post: { label: '动态', byProvider: { x: '博主推文', weibo: '微博动态' } },
    article_saved: { label: '保存的文章' }
};

function isEventType(type) {
    return Object.prototype.hasOwnProperty.call(EVENT_TYPES, type);
}

function eventTypeLabel(type, providerType) {
    const def = EVENT_TYPES[type];
    if (!def) return type;
    return (def.byProvider && def.byProvider[providerType]) || def.label;
}

module.exports = {
    PROVIDERS,
    getProvider,
    isProvider,
    selectableProviders,
    EVENT_TYPES,
    isEventType,
    eventTypeLabel
};

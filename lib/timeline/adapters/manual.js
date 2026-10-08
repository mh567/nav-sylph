'use strict';

/**
 * 手动来源（「稍后阅读」）。
 *
 * 它不轮询：事件由用户保存文章时写入（service.saveArticle）。`fetchEvents`
 * 返回空，调度器也跳过 manual 来源。
 *
 * 仍把它放进 registry，是为了让「来源」只有一种形状——时间线面板与后台
 * 列表不必为一类来源写特例，新增 provider 时也不会漏掉它这一支。
 */
module.exports = {
    id: 'manual',
    label: '稍后阅读',
    symbol: '↗',
    /** 永不轮询，没有最小间隔这回事。 */
    minIntervalMs: null,
    /** 后台表单不渲染凭据/账号输入：手动来源没有可授权的对象。 */
    credentialLabel: null,
    accountLabel: null,

    validateSettings() {
        return { ok: true };
    },

    async testConnection() {
        return { ok: true };
    },

    async fetchEvents() {
        return { events: [], nextCursor: null };
    },

    /** 手动事件由 service 直接构造，不经 adapter 规范化。 */
    normalize() {
        return null;
    }
};

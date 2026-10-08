'use strict';

/**
 * Special Line 时间线的全部可调常量。
 *
 * 集中在唯一一处并写进测试：容量与保留策略是「用户数据会不会被悄悄丢掉」
 * 的直接决定，散落在各文件里读不出来，也没法断言。
 */

/** 社交订阅事件的保留天数。手动保存的文章不吃这个时限。 */
const SOCIAL_RETENTION_DAYS = 90;

/** 单个来源的事件硬上限。触顶时停止入库并显式报错，不静默驱逐。 */
const MAX_EVENTS_PER_SOURCE = 5000;

/** 「稍后阅读」的条数上限。触顶时保存被拒并给出明确提示（不是静默丢弃）。 */
const MAX_MANUAL_ARTICLES = 500;

/** 内置手动来源的固定 id：不可删除、不出现在后台来源列表、不进调度。 */
const MANUAL_SOURCE_ID = 'manual';

/** 调度器检查「有没有到期的来源」的节拍。 */
const SCHEDULER_TICK_MS = 30000;

/** 全局并发同步上限：同时打多个第三方 API 只会一起被限流。 */
const MAX_CONCURRENT_SYNCS = 2;

/** 失败退避的上限。 */
const MAX_BACKOFF_MS = 4 * 60 * 60 * 1000;

/** 来源未显式设置间隔时的默认值（实际生效值还要与 adapter 的最小间隔取大）。 */
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** 事件列表分页。 */
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;

/**
 * 字段长度上限。**provider 返回的一切都是不可信输入**——
 * 没有上限的长文本会进数据库、进备份、进渲染。
 */
const LIMITS = {
    name: 100,
    externalKey: 200,
    title: 200,
    summary: 2000,
    author: 100,
    url: 2048,
    quote: 1000,
    providerEventId: 256,
    dedupeKey: 256,
    metadata: 4096,
    settings: 4096,
    lastError: 500,
    syncCursor: 512
};

/** 允许出现在 metadata_json 里的键。白名单，不是黑名单。 */
const METADATA_KEYS = ['quote'];

module.exports = {
    SOCIAL_RETENTION_DAYS,
    MAX_EVENTS_PER_SOURCE,
    MAX_MANUAL_ARTICLES,
    MANUAL_SOURCE_ID,
    SCHEDULER_TICK_MS,
    MAX_CONCURRENT_SYNCS,
    MAX_BACKOFF_MS,
    DEFAULT_SYNC_INTERVAL_MS,
    PAGE_SIZE_DEFAULT,
    PAGE_SIZE_MAX,
    LIMITS,
    METADATA_KEYS
};

'use strict';

/**
 * Special Line 时间线的装配点。
 *
 * server.js 只 require 这一个文件：repository / service / scheduler 的构造
 * 与相互引用在这里收敛，调用方不必知道它们的分层。
 */

const { createRepository } = require('./repository');
const { createService, ServiceError } = require('./service');
const { createScheduler } = require('./sync');

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} deps
 * @param {() => Promise<string>} deps.getPasswordHash
 * @param {(kind: string) => void} [deps.onDurableChange]
 * @param {Console} [deps.log]
 */
function createTimeline(db, { getPasswordHash, onDurableChange, log, fetchMeta } = {}) {
    const repo = createRepository(db);
    // 内置手动来源在装配时就位：面板的「稍后阅读」筛选与保存文章的落点都依赖它。
    repo.ensureManualSource();
    const service = createService(repo, { getPasswordHash, onDurableChange, log, fetchMeta });
    const scheduler = createScheduler({ service, log });
    return { repo, service, scheduler };
}

module.exports = { createTimeline, ServiceError };

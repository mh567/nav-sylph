'use strict';

/**
 * 同步调度器。
 *
 * 它只决定「什么时候调 service.syncSource」——不碰数据库、不拼 SQL、
 * 不判断同步结果。失败退避与游标推进都在 service 里（那里才知道失败了什么），
 * 这里只管节拍与并发闸门。
 */

const { SCHEDULER_TICK_MS, MAX_CONCURRENT_SYNCS } = require('./constants');

function createScheduler({ service, log = console }) {
    let timer = null;
    let ticking = false;
    // scheduler 与手动「同步全部」共享这一份来源级 Promise Map：
    // 同一来源已在跑时复用它，不重复打第三方；Map.size 同时就是全局并发数。
    const inFlight = new Map();

    function runSource(id, options) {
        const existing = inFlight.get(id);
        if (existing) return existing;

        const task = Promise.resolve()
            .then(() => options === undefined
                ? service.syncSource(id)
                : service.syncSource(id, options))
            .finally(() => {
                if (inFlight.get(id) === task) inFlight.delete(id);
            });
        inFlight.set(id, task);
        return task;
    }

    async function scheduleSource(id, options) {
        let task = inFlight.get(id);
        while (!task) {
            if (inFlight.size >= MAX_CONCURRENT_SYNCS) {
                // 等任一槽位释放即可；某个无关来源 reject 也只是释放槽位，不能把当前来源
                // 误判成失败。每个 task 的 rejection 由自己的调用入口处理。
                const settled = Array.from(inFlight.values(), pending => pending.then(() => undefined, () => undefined));
                await Promise.race(settled);
                task = inFlight.get(id);
                continue;
            }
            task = runSource(id, options);
        }
        return task;
    }

    async function tick() {
        // 上一轮还没跑完就跳过：tick 的职责是「发现到期的」，不是排队
        if (ticking) return;
        ticking = true;
        try {
            const due = service.dueSources(Date.now(), MAX_CONCURRENT_SYNCS * 2);
            for (const source of due) {
                if (inFlight.size >= MAX_CONCURRENT_SYNCS) break;
                if (inFlight.has(source.id)) continue;
                runSource(source.id).catch(() => {
                    // 不读取/序列化任意 rejection 值；service.syncSource 的预期错误已转成结果。
                    log.warn(`[timeline] 来源 ${source.id} 调度同步异常（非预期拒绝）`);
                });
            }
            // 保留清扫跟着 tick 走：不为它再起一个定时器，也就不会漏
            service.sweepRetention();
        } catch (err) {
            log.warn(`[timeline] 调度器 tick 失败：${err.message}`);
        } finally {
            ticking = false;
        }
    }

    return {
        start() {
            if (timer) return;
            timer = setInterval(tick, SCHEDULER_TICK_MS);
            // unref：待触发的定时器不得把进程吊住（本项目被测试当模块加载时尤为明显）
            if (typeof timer.unref === 'function') timer.unref();
            // 启动后立刻跑一次：升级/重启之后，已到期的来源不该等下一个 tick。
            // 不 await——它可能打第三方 API，阻塞启动没有好处。
            tick();
        },

        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },

        /** 单来源手动同步也经过共享闸门；force 仍由调用方显式选择。 */
        syncSource(id, options) {
            return scheduleSource(id, options);
        },

        /** 手动同步当前所有启用的外部订阅；不 force，停止中的来源不会被重新启用。 */
        async syncEnabledSources() {
            const sources = service.listSources().filter(source =>
                source.enabled && source.providerType !== 'manual');
            const outcomes = new Array(sources.length);
            let cursor = 0;

            async function worker() {
                while (cursor < sources.length) {
                    const index = cursor++;
                    try {
                        outcomes[index] = await scheduleSource(sources[index].id);
                    } catch {
                        // 批次逐源隔离意外 rejection；不 stringify 任意 thrown 值。
                        log.warn(`[timeline] 来源 ${sources[index].id} 批量同步异常（非预期拒绝）`);
                        outcomes[index] = { ok: false, code: 'internal', error: '同步执行异常' };
                    }
                }
            }

            const workers = Math.min(MAX_CONCURRENT_SYNCS, sources.length);
            await Promise.all(Array.from({ length: workers }, () => worker()));

            const results = sources.map((source, index) => {
                const outcome = outcomes[index] || { ok: false, code: 'internal', error: '同步结果缺失' };
                return {
                    id: source.id,
                    name: source.name,
                    providerType: source.providerType,
                    ok: !!outcome.ok,
                    skipped: outcome.skipped === true,
                    discarded: typeof outcome.skipped === 'number' ? outcome.skipped : 0,
                    ...(outcome.code ? { code: outcome.code } : {}),
                    ...(outcome.error ? { error: outcome.error } : {}),
                    inserted: Number(outcome.inserted) || 0,
                    fetched: Number(outcome.fetched) || 0,
                    backfilled: Number(outcome.backfilled) || 0,
                    enriched: Number(outcome.enriched) || 0
                };
            });
            return {
                total: results.length,
                succeeded: results.filter(result => result.ok && !result.skipped).length,
                failed: results.filter(result => !result.ok && !result.skipped).length,
                skipped: results.filter(result => result.skipped).length,
                inserted: results.reduce((sum, result) => sum + result.inserted, 0),
                discarded: results.reduce((sum, result) => sum + result.discarded, 0),
                results
            };
        },

        isRunning(id) {
            return inFlight.has(id);
        },

        /** 测试用：直接驱动一轮，不必等定时器。 */
        tickNow() {
            return tick();
        }
    };
}

module.exports = { createScheduler };

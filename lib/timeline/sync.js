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
    const inFlight = new Set();

    async function tick() {
        // 上一轮还没跑完就跳过：tick 的职责是「发现到期的」，不是排队
        if (ticking) return;
        ticking = true;
        try {
            const due = service.dueSources(Date.now(), MAX_CONCURRENT_SYNCS * 2);
            for (const source of due) {
                if (inFlight.size >= MAX_CONCURRENT_SYNCS) break;
                if (inFlight.has(source.id)) continue;
                inFlight.add(source.id);
                service.syncSource(source.id)
                    .catch(err => log.warn(`[timeline] 调度同步异常：${err.message}`))
                    .finally(() => inFlight.delete(source.id));
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

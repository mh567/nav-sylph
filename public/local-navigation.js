((window) => {
    'use strict';
    const SCHEMA_VERSION = 1;
    // 模块记录与导航记录**同一个库、同一个对象存储**，只是键不同（'ordinary' / 'modules'）。
    // 刻意不新开存储、也不升库版本：升版本会触发 onupgradeneeded，而对象存储本来就
    // 支持任意键——多一个键是最小的改动，也不会碰到 #4 已经写下的导航数据。
    const MODULES_KEY = 'modules';
    const MODULES_SCHEMA_VERSION = 1;
    // 第三个键：普通口令空间的**连接状态**与「替换前的副本」。
    // 同样不新开存储、不升库版本（理由同上）。这里存的是设备令牌——它是凭据，
    // 所以只能待在 IndexedDB，**不能**进 Service Worker 的静态缓存，也不能进
    // localStorage（那两者都会被别的脚本读到，且 SW 缓存是不可控的持久面）。
    const SYNC_KEY = 'sync';
    const SYNC_SCHEMA_VERSION = 1;
    function check(record) {
        if (record && (record.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(record.revision) || record.revision < 1)) {
            throw new Error('本地配置版本无法读取，请升级应用并保留站点数据');
        }
        if (record) window.NavigationSchema.validate(record.config);
        return record;
    }
    /**
     * 只在**结构**上把关：顶层是对象、两个数组在、id 是非空字符串。
     * 逐项取值（条数范围之类）由 app.js 按各模块声明的白名单校验——那份声明
     * 住在模块文件里，存储层看不到，也不该假装看得到。
     */
    function validateModulesShape(modules) {
        if (!modules || typeof modules !== 'object' || Array.isArray(modules)) throw new Error('本地模块配置形状无效');
        if (!Array.isArray(modules.enabled) || modules.enabled.some(id => typeof id !== 'string' || !id)) {
            throw new Error('本地模块配置形状无效');
        }
        if (!Array.isArray(modules.widgets)) throw new Error('本地模块配置形状无效');
        if (modules.settings !== undefined && (!modules.settings || typeof modules.settings !== 'object' || Array.isArray(modules.settings))) {
            throw new Error('本地模块配置形状无效');
        }
        return modules;
    }
    function checkModules(record) {
        if (record && (record.schemaVersion !== MODULES_SCHEMA_VERSION || !Number.isSafeInteger(record.revision) || record.revision < 1)) {
            throw new Error('本地模块配置版本无法读取，请升级应用并保留站点数据');
        }
        if (record) validateModulesShape(record.modules);
        return record;
    }
    /**
     * 连接状态、恢复副本、待上传内容与多标签页认领的**形状**校验。
     *
     * 逐字段宽容：某一项形状不对就**只丢那一项**，不把整条记录作废——
     * 记录里同时住着凭据（deviceToken）和用户唯一的「替换前副本」，
     * 因为 pending 里少了一个字段就让人重新输口令、连带丢掉副本，代价远大于收益。
     * 令牌缺失时同理按「未连接」处理。
     */
    function checkSync(record) {
        if (!record) return record;
        if (record.schemaVersion !== SYNC_SCHEMA_VERSION || !Number.isSafeInteger(record.revision) || record.revision < 1) {
            throw new Error('本地同步状态版本无法读取，请升级应用并保留站点数据');
        }
        const out = { ...record };
        const connection = record.connection;
        if (connection && (typeof connection.spaceId !== 'string' || typeof connection.deviceToken !== 'string' || !connection.deviceToken)) {
            out.connection = null;
        }
        const pending = record.pending;
        if (pending) {
            const content = pending.content;
            const shaped = typeof pending.operationId === 'string' && pending.operationId
                && content && typeof content === 'object' && content.config && typeof content.config === 'object'
                && typeof pending.payloadKey === 'string' && pending.payloadKey
                && Number.isSafeInteger(pending.baseRevision) && Number.isSafeInteger(pending.createdAt);
            if (!shaped) out.pending = null;
        }
        const claim = record.claim;
        if (claim && (typeof claim.id !== 'string' || !claim.id || !Number.isSafeInteger(claim.at))) out.claim = null;
        if (record.lastSuccessAt != null && !Number.isSafeInteger(record.lastSuccessAt)) out.lastSuccessAt = null;
        if (record.uploadedPayloadKey != null && typeof record.uploadedPayloadKey !== 'string') out.uploadedPayloadKey = null;
        return out;
    }
    /** 记录里的可选字段：缺席（不是显式 null）表示「保持原值」。 */
    // `uploadedPayloadKey` = 最近一次「确认上传成功」时**内容**的指纹（见 app.js 的
    // syncPayloadKey）。「已同步」只有在它等于当前内容指纹时才成立——本机后来改过
    // 就该显示别的词。用指纹而不是修订号：模块改动不动导航的修订号。
    const SYNC_FIELDS = ['connection', 'recovery', 'pending', 'claim', 'lastSuccessAt', 'uploadedPayloadKey'];
    class LocalNavigation {
        async open() {
            if (!this.database) this.database = new Promise((resolve, reject) => {
                const request = indexedDB.open('nav-sylph-personal', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('navigation');
                request.onsuccess = () => {
                    request.result.onversionchange = () => { request.result.close(); this.database = null; };
                    resolve(request.result);
                };
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error('请关闭其他旧标签页后重试'));
            });
            return this.database;
        }
        async read() {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('navigation');
                const request = tx.objectStore('navigation').get('ordinary');
                tx.oncomplete = () => { try { resolve(check(request.result)); } catch (e) { reject(e); } };
                tx.onabort = () => reject(tx.error || new Error('无法读取本地配置'));
            });
        }
        async write(config, revision, undo = false) {
            window.NavigationSchema.validate(config);
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('navigation', 'readwrite');
                const store = tx.objectStore('navigation');
                let result, failure;
                store.get('ordinary').onsuccess = event => {
                    try {
                        const current = check(event.target.result);
                        if ((current?.revision || 0) !== revision) throw Object.assign(new Error('其他标签页已修改导航，请先导出当前内容或采用其他标签页版本'), { code: 'conflict' });
                        const next = undo ? current?.previous : config;
                        if (!next) throw new Error('没有可撤销的操作');
                        window.NavigationSchema.validate(next);
                        result = { schemaVersion: SCHEMA_VERSION, revision: revision + 1, config: next, previous: current?.config || null };
                        store.put(result, 'ordinary');
                    } catch (e) { failure = e; tx.abort(); }
                };
                tx.oncomplete = () => resolve(result);
                tx.onabort = () => reject(failure || tx.error || new Error('未能保存到本机'));
            });
        }
        /** 读本机的模块开关、布局与偏好。从未写过时返回 undefined（不是空对象）。 */
        async readModules() {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('navigation');
                const request = tx.objectStore('navigation').get(MODULES_KEY);
                tx.oncomplete = () => { try { resolve(checkModules(request.result)); } catch (e) { reject(e); } };
                tx.onabort = () => reject(tx.error || new Error('无法读取本地模块设置'));
            });
        }
        /**
         * 写模块记录。与导航同款乐观并发：事务内比较 revision，别的标签页改过就拒绝，
         * 而不是把对方刚写的开关覆盖掉。
         */
        async writeModules(modules, revision) {
            validateModulesShape(modules);
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('navigation', 'readwrite');
                const store = tx.objectStore('navigation');
                let result, failure;
                store.get(MODULES_KEY).onsuccess = event => {
                    try {
                        const current = checkModules(event.target.result);
                        if ((current?.revision || 0) !== revision) {
                            throw Object.assign(new Error('其他标签页已修改模块设置，请刷新后重试'), { code: 'conflict' });
                        }
                        result = { schemaVersion: MODULES_SCHEMA_VERSION, revision: revision + 1, modules };
                        store.put(result, MODULES_KEY);
                    } catch (e) { failure = e; tx.abort(); }
                };
                tx.oncomplete = () => resolve(result);
                tx.onabort = () => reject(failure || tx.error || new Error('未能保存到本机'));
            });
        }
        /** 读同步连接记录。从未写过时返回 undefined。 */
        async readSync() {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('navigation');
                const request = tx.objectStore('navigation').get(SYNC_KEY);
                tx.oncomplete = () => { try { resolve(checkSync(request.result)); } catch (e) { reject(e); } };
                tx.onabort = () => reject(tx.error || new Error('无法读取本地同步状态'));
            });
        }
        /**
         * 写同步记录。乐观并发同款：事务内比较 revision。
         *
         * ⚠️ 参数是**补丁**而不是整条记录：缺席的字段保持原值，显式传 `null` 才是清空。
         * 反过来（缺席即清空）会造出一类静默 bug——连接时只想写凭据，顺手把
         * `pending`（还没上传的修改）和 `lastSuccessAt` 抹掉，而症状是
         * 「改完切标签页，回来发现那一次改动没了」。
         *
         * ⚠️ 这一条也是「凭据保存失败不得显示连接成功」的落点：调用方必须
         * **等这个 Promise 成功**之后才把内存状态置为已连接。IndexedDB 会因
         * 隐私模式、配额、其他标签页持锁而失败，而失败是完全静默的——先显示
         * 「已连接」再补写，用户会以为下一次打开还在，实际打开就是未连接。
         */
        async writeSync(patch, revision) {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction('navigation', 'readwrite');
                const store = tx.objectStore('navigation');
                let result, failure;
                store.get(SYNC_KEY).onsuccess = event => {
                    try {
                        const current = checkSync(event.target.result);
                        if ((current?.revision || 0) !== revision) {
                            throw Object.assign(new Error('其他标签页已修改同步状态，请刷新后重试'), { code: 'conflict' });
                        }
                        const next = {};
                        for (const key of SYNC_FIELDS) {
                            next[key] = Object.prototype.hasOwnProperty.call(patch || {}, key)
                                ? (patch[key] ?? null)
                                : (current?.[key] ?? null);
                        }
                        result = checkSync({ schemaVersion: SYNC_SCHEMA_VERSION, revision: revision + 1, ...next });
                        store.put(result, SYNC_KEY);
                    } catch (e) { failure = e; tx.abort(); }
                };
                tx.oncomplete = () => resolve(result);
                tx.onabort = () => reject(failure || tx.error || new Error('未能保存到本机'));
            });
        }
    }
    window.LocalNavigation = LocalNavigation;
})(window);

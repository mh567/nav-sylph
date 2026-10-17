((window) => {
    'use strict';
    const SCHEMA_VERSION = 1;
    function check(record) {
        if (record && (record.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(record.revision) || record.revision < 1)) {
            throw new Error('本地配置版本无法读取，请升级应用并保留站点数据');
        }
        if (record) window.NavigationSchema.validate(record.config);
        return record;
    }
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
    }
    window.LocalNavigation = LocalNavigation;
})(window);

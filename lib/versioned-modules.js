'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const metadata = Symbol('modules revision');
const conflict = () => Object.assign(new Error('模块配置已改变，请重新读取后处理冲突'), { status: 409 });
function read(file) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const state = value._sync || { revision: 1, receipts: {} };
    delete value._sync;
    value[metadata] = state;
    return value;
}
function revision(value) { return value[metadata]?.revision || 1; }
function replay(file, operation) {
    if (!Number.isSafeInteger(operation.revision) || typeof operation.operationId !== 'string' || !operation.operationId.trim() || operation.operationId.length > 100) throw conflict();
    const receipts = read(file)[metadata].receipts;
    const receipt = Object.hasOwn(receipts, operation.operationId) ? receipts[operation.operationId] : null;
    if (!receipt || receipt.at < Date.now() - 86400000) return null;
    const digest = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
    if (receipt.digest !== digest) throw conflict();
    return receipt.response;
}
function write(file, value, operation, result = {}) {
    const current = fs.existsSync(file) ? read(file) : {};
    const state = current[metadata] || { revision: 0, receipts: {} };
    const now = Date.now();
    const receipts = Object.fromEntries(Object.entries(state.receipts).filter(([, entry]) => entry.at >= now - 86400000));
    let digest;
    if (operation) {
        if (!Number.isSafeInteger(operation.revision) || typeof operation.operationId !== 'string' || !operation.operationId.trim() || operation.operationId.length > 100) throw conflict();
        digest = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
        const receipt = Object.hasOwn(receipts, operation.operationId) ? receipts[operation.operationId] : null;
        if (receipt) {
            if (receipt.digest !== digest) throw conflict();
            return receipt.response;
        }
        if (operation.revision !== state.revision) throw conflict();
    } else if (value[metadata] && revision(value) !== state.revision) throw conflict();
    const response = { success: true, ...result, revision: state.revision + 1 };
    if (operation) Object.defineProperty(receipts, operation.operationId, { value: { digest, response, at: now }, enumerable: true });
    // 配置和回执一次替换，进程重启后仍可确认响应丢失的提交。
    const temp = file + '.tmp';
    try {
        fs.writeFileSync(temp, JSON.stringify({ ...value, _sync: { revision: response.revision, receipts } }, null, 2), { mode: 0o600 });
        fs.chmodSync(temp, 0o600);
        fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
    return response;
}
module.exports = { read, write, revision, replay };

'use strict';

/**
 * ip2region xdb (structure 3.0) 的最小只读实现，仅支持 IPv4。
 *
 * 格式取自上游权威实现 binding/golang/xdb/{header,searcher,version}.go：
 *   - 头部 256 字节；其后 256*256*8 字节为向量索引，每项两个小端 uint32
 *     (sPtr, ePtr)，是指向段索引的**绝对文件偏移**，不是相对索引。
 *   - 段索引每条 14 字节 = [startIp:4][endIp:4][dataLen:2][dataPtr:4]，
 *     其中两个 IP 均以**小端**存放，与传入的大端 IP 比较前必须逐字节反转。
 *   - dataPtr 指向的地区字符串形如 "中国|江苏省|南京市|电信|CN"。
 *
 * 只做本项目需要的事：按 IP 取出地区串。不支持 IPv6（未随附 35MB 的 v6 库），
 * 不支持写入，不依赖任何 npm 包。
 */

const fs = require('fs');

const HEADER_INFO_LENGTH = 256;
const VECTOR_INDEX_ROWS = 256;
const VECTOR_INDEX_COLS = 256;
const VECTOR_INDEX_SIZE = 8;
const SEGMENT_INDEX_SIZE = 14; // 4 + 4 + 2 + 4
const STRUCTURE_30 = 3;
const VECTOR_INDEX_POLICY = 1;

// 地区串字段下标："国家|省|市|运营商|国家码"
const FIELD_REGION = 1;
const FIELD_CITY = 2;

class Ip2Region {
    constructor() {
        this.buffer = null;
        this.loaded = false;
        this.failed = false;
    }

    // 惰性载入。11MB 的库只在首次真正查询时才读进内存，
    // 避免拖慢启动与首屏；载入失败只置 failed，让调用方按"跳过该判据"处理。
    ensureLoaded(dbFile) {
        if (this.loaded || this.failed) return this.loaded;
        try {
            const buffer = fs.readFileSync(dbFile);
            if (!this.hasUsableHeader(buffer)) throw new Error('xdb 头部不可用');
            this.buffer = buffer;
            this.loaded = true;
        } catch (err) {
            this.failed = true;
        }
        return this.loaded;
    }

    hasUsableHeader(buffer) {
        if (buffer.length < HEADER_INFO_LENGTH + VECTOR_INDEX_ROWS * VECTOR_INDEX_COLS * VECTOR_INDEX_SIZE) {
            return false;
        }
        // 只接受 3.0 结构 + 向量索引 + IPv4 + 4 字节指针。
        // 其余组合本实现未经验证，宁可不查也不能返回错误地区。
        return buffer.readUInt16LE(0) === STRUCTURE_30
            && buffer.readUInt16LE(2) === VECTOR_INDEX_POLICY
            && buffer.readUInt16LE(16) === 4
            && buffer.readUInt16LE(18) === 4;
    }

    parseIPv4(ip) {
        if (typeof ip !== 'string') return null;
        const parts = ip.split('.');
        if (parts.length !== 4) return null;
        const bytes = new Array(4);
        for (let i = 0; i < 4; i++) {
            const n = Number(parts[i]);
            if (!Number.isInteger(n) || n < 0 || n > 255) return null;
            bytes[i] = n;
        }
        return bytes;
    }

    // 私网/回环/链路本地等地址查不到公网地区，返回 null 让调用方跳过地理判据。
    isReserved(bytes) {
        const [a, b] = bytes;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
        return false;
    }

    // 返回形如 "中国|江苏省|南京市|电信|CN" 的原始地区串；查不到返回 null。
    search(ip) {
        if (!this.loaded) return null;
        const bytes = this.parseIPv4(ip);
        if (!bytes || this.isReserved(bytes)) return null;

        const buf = this.buffer;
        const vecIdx = HEADER_INFO_LENGTH + (bytes[0] * VECTOR_INDEX_COLS + bytes[1]) * VECTOR_INDEX_SIZE;
        const startPtr = buf.readUInt32LE(vecIdx);
        const endPtr = buf.readUInt32LE(vecIdx + VECTOR_INDEX_SIZE);
        // 零指针表示该段无源数据
        if (startPtr === 0 || endPtr === 0 || endPtr <= startPtr) return null;

        let lo = 0;
        let hi = Math.floor((endPtr - startPtr) / SEGMENT_INDEX_SIZE);
        let dataLen = 0;
        let dataPtr = 0;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const p = startPtr + mid * SEGMENT_INDEX_SIZE;
            if (p + SEGMENT_INDEX_SIZE > buf.length) return null;

            // 段内 IP 为小端存放，比较前反转成大端
            const startCmp = compareBytes(bytes, [buf[p + 3], buf[p + 2], buf[p + 1], buf[p]]);
            if (startCmp < 0) {
                hi = mid - 1;
                continue;
            }
            const endCmp = compareBytes(bytes, [buf[p + 7], buf[p + 6], buf[p + 5], buf[p + 4]]);
            if (endCmp > 0) {
                lo = mid + 1;
                continue;
            }
            dataLen = buf.readUInt16LE(p + 8);
            dataPtr = buf.readUInt32LE(p + 10);
            break;
        }

        if (dataLen === 0 || dataPtr === 0) return null;
        if (dataPtr + dataLen > buf.length) return null;
        return buf.toString('utf8', dataPtr, dataPtr + dataLen);
    }

    /**
     * 按粒度取出用于比对的地区标识。
     * scope: 'province' 取省级，'city' 取市级。查不到一律返回 null。
     */
    lookupRegion(ip, scope) {
        const raw = this.search(ip);
        if (!raw) return null;
        const fields = raw.split('|');
        const value = scope === 'city' ? fields[FIELD_CITY] : fields[FIELD_REGION];
        if (!value) return null;
        // 库里 "0" 表示无有效归属，不能当作真实地区参与比对
        return value === '0' ? null : value;
    }
}

function compareBytes(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }
    return 0;
}

module.exports = { Ip2Region, FIELD_REGION, FIELD_CITY };

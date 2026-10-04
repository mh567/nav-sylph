/**
 * 默认配置
 * 配置优先级: 默认值 < config.json < .env < 环境变量
 */

module.exports = {
    server: {
        host: '127.0.0.1',
        port: 4000,
        https: {
            enabled: false,
            keyPath: '',
            certPath: '',
            caPath: ''
        }
    },
    security: {
        adminPasswordFile: '.admin-password.json',
        defaultPassword: 'admin123',
        // 会话 Cookie 名称。刻意不用 __Host- 前缀：它强制要求 Secure，
        // 而本地 http 调试（HTTPS_ENABLED=false）会被浏览器直接拒收。
        sessionCookieName: 'nav_session',
        // 会话有效期（毫秒）。可信设备 30 天滑动续期，普通会话 24 小时。
        sessionTtlTrusted: 30 * 86400000,
        sessionTtlDefault: 24 * 3600000,
        // Cookie 是否带 Secure。默认 true；纯 http 部署需在 .env 设 COOKIE_SECURE=false，
        // 否则浏览器不会保存该 Cookie，登录态静默失效。
        cookieSecure: true,
        // 本服务自己的 https 证书是不是自签的。
        //
        // 为什么需要它：agent 连本服务（enroll / upgrade）时，如果证书是自签的
        // 就必须显式拿到那份证书当可信根——而 Go 在 macOS 上不读
        // SSL_CERT_FILE（那是 Linux 行为），Linux 上自签也不在系统根池里。
        // 不知道这一点，生成的部署/升级命令就会缺 --server-ca，在目标机上
        // 报一句指不到真因的「certificate signed by unknown authority」。
        //
        // 不知道就保持默认 false（按公网可信证书处理）——多数人用 certbot。
        selfSignedCert: false,
        // 设备绑定的地理位置判据。geoEnabled=false 或库文件缺失时该判据被跳过。
        geoEnabled: true,
        geoDatabase: 'lib/geo/ip2region_v4.xdb',
        // 'province' 省级（默认，噪声小）| 'city' 市级 | 'off' 关闭
        geoScope: 'province'
    },
    paths: {
        data: 'data.json',           // 书签数据文件
        database: 'nav-sylph.db',    // SQLite 库（会话等落盘数据）
        icon: 'icon.svg',
        favicon: 'favicon.svg',
        logs: 'logs'
    },
    app: {
        name: 'nav-sylph',
        pidFile: '.nav-sylph.pid'
    },
    webdav: {
        configFile: '.webdav-config.json'
    }
};

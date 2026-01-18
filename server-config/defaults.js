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
        defaultPassword: 'admin123'
    },
    paths: {
        data: 'data.json',           // 书签数据文件
        icon: 'icon.svg',
        favicon: 'favicon.svg',
        logs: 'logs'
    },
    app: {
        name: 'nav-sylph',
        pidFile: '.nav-sylph.pid'
    }
};

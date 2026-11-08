'use strict';
(() => {
    const form = document.querySelector('#loginForm');
    const password = document.querySelector('#password');
    const message = document.querySelector('#message');
    const button = document.querySelector('#submitBtn');
    const fields = document.querySelector('#changeFields');
    let changing = false;
    function enter() {
        location.replace('/');
    }
    function requireChange() {
        changing = true;
        fields.hidden = false;
        document.querySelector('#newPassword').required = true;
        document.querySelector('#repeatPassword').required = true;
        button.textContent = '修改密码并登录';
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        message.textContent = '';
        button.disabled = true;
        try {
            const newPassword = document.querySelector('#newPassword').value;
            if (changing && newPassword !== document.querySelector('#repeatPassword').value) throw new Error('两次输入的密码不一致');
            const response = await fetch(changing ? '/api/change-password' : '/api/verify-password', {
                method: 'POST', credentials: 'same-origin', cache: 'no-store',
                headers: { 'Content-Type': 'application/json', 'X-Habu-Request': '1', ...(changing ? {} : { 'X-Admin-Password': password.value }) },
                body: JSON.stringify(changing ? { currentPassword: password.value, newPassword } : {})
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '登录失败，请稍后重试');
            if (changing && data.success) return enter();
            if (!data.valid) throw new Error('密码错误');
            if (data.passwordChangeRequired) return requireChange();
            enter();
        } catch (error) {
            message.textContent = error.message;
        } finally { button.disabled = false; }
    });
    fetch('/api/session', { cache: 'no-store' }).then(res => res.json()).then(session => {
        if (session.authenticated) enter();
        else if (session.passwordChangeRequired) requireChange();
    }).catch(() => { message.textContent = '无法连接服务器，请检查网络后重试。'; });
})();

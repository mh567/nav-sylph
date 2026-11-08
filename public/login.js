'use strict';
(() => {
    const form = document.querySelector('#loginForm');
    const password = document.querySelector('#password');
    const newPassword = document.querySelector('#newPassword');
    const repeatPassword = document.querySelector('#repeatPassword');
    const message = document.querySelector('#message');
    const controls = document.querySelector('#controls');
    const buttonLabel = document.querySelector('#buttonLabel');
    let changing = false;
    let entering = false;
    function ready() {
        controls.disabled = false;
        form.setAttribute('aria-busy', 'false');
        buttonLabel.textContent = changing ? '设置密码并进入' : '进入工作台';
    }
    function enter(animate = true) {
        entering = true;
        controls.disabled = true;
        buttonLabel.textContent = '正在进入';
        message.textContent = '验证成功，正在进入工作台。';
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!animate || reduced) return location.replace('/');
        document.body.classList.add('entering');
        setTimeout(() => location.replace('/'), 380);
    }
    function requireChange() {
        changing = true;
        document.body.classList.add('changing');
        document.querySelector('#changeFields').hidden = false;
        document.querySelector('#heading').textContent = '设置访问密码。';
        document.querySelector('#intro').textContent = '设置完成，即可进入工作台。';
        document.querySelector('#passwordLabel').textContent = '当前密码';
        newPassword.required = true;
        repeatPassword.required = true;
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (controls.disabled || entering) return;
        message.textContent = '';
        for (const input of [password, newPassword, repeatPassword]) input.removeAttribute('aria-invalid');
        if (changing && newPassword.value !== repeatPassword.value) {
            message.textContent = '两次输入的密码不一致，请重新确认。';
            repeatPassword.setAttribute('aria-invalid', 'true');
            repeatPassword.focus();
            return;
        }
        controls.disabled = true;
        form.setAttribute('aria-busy', 'true');
        buttonLabel.textContent = changing ? '正在设置' : '正在验证';
        try {
            const response = await fetch(changing ? '/api/change-password' : '/api/verify-password', {
                method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000),
                headers: { 'Content-Type': 'application/json', 'X-Habu-Request': '1', ...(changing ? {} : { 'X-Admin-Password': password.value }) },
                body: JSON.stringify(changing ? { currentPassword: password.value, newPassword: newPassword.value } : {})
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '登录失败，请稍后重试。');
            if (changing && data.success) return enter();
            if (!data.valid) {
                password.setAttribute('aria-invalid', 'true');
                throw new Error('密码不正确，请重新输入。');
            }
            if (data.passwordChangeRequired) return requireChange();
            enter();
        } catch (error) {
            message.textContent = error instanceof TypeError || error.name === 'TimeoutError' || error instanceof SyntaxError
                ? '连接未完成，请检查网络后重试。' : error.message;
        } finally {
            if (!entering) {
                ready();
                if (!message.textContent && changing) newPassword.focus();
                else if (password.getAttribute('aria-invalid') === 'true') { password.focus(); password.select(); }
            }
        }
    });
    fetch('/api/session', { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(res => {
        if (!res.ok) throw new Error('session');
        return res.json();
    }).then(session => {
        if (session.authenticated) enter(false);
        else if (session.passwordChangeRequired) requireChange();
    }).catch(() => { message.textContent = '无法连接服务器，请检查网络后重试。'; }).finally(() => {
        if (!entering) ready();
    });
})();

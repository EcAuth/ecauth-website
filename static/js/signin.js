/* リカバリ: POST /api/account/magic-link/request {email}（enumeration 対策で常に 202 同一応答） */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var form = App.$('#magic-request-form');
  var statusEl = App.$('#status');
  var btn = App.$('#submit-btn');
  var fEmail = App.$('#f-email');
  if (!form) return;

  App.$('#email').addEventListener('input', function () {
    if (App.validEmail(this.value)) fEmail.classList.remove('invalid');
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    App.clearStatus(statusEl);
    if (!App.validEmail(App.$('#email').value)) {
      fEmail.classList.add('invalid');
      return;
    }

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '送信中…';

    var res = await App.postJson('/api/account/magic-link/request', {
      email: App.$('#email').value.trim()
    });

    btn.textContent = original;
    btn.disabled = false;

    if (res.networkError) {
      App.setStatus(statusEl, 'err', 'ネットワークエラーが発生しました。時間をおいて再度お試しください。');
      return;
    }

    // enumeration 対策: 登録の有無に関わらず常に同一メッセージ
    form.reset();
    App.setStatus(statusEl, 'ok',
      'ご入力のメールアドレスが登録されている場合、ログイン用リンクを送信しました。メールをご確認ください。');
  });

  // パスキーログインはマイページ側（未認証時に accounts の認証へ誘導）で開始する。
  App.$('#passkey-login-link').addEventListener('click', function (e) {
    e.preventDefault();
    window.location.href = '/mypage/';
  });
})();

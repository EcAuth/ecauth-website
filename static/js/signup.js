/* 申込フォーム: POST {apiBaseUrl}/api/signup/request */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var form = App.$('#signup-form');
  var statusEl = App.$('#status');
  var btn = App.$('#submit-btn');
  if (!form) return;

  var fEmail = App.$('#f-email'), fContact = App.$('#f-contact');

  function validate() {
    var emailOk = App.validEmail(App.$('#email').value);
    var contactOk = App.$('#contact').value.trim() !== '';
    fEmail.classList.toggle('invalid', !emailOk);
    fContact.classList.toggle('invalid', !contactOk);
    return emailOk && contactOk;
  }

  App.$('#email').addEventListener('input', function () {
    if (App.validEmail(this.value)) fEmail.classList.remove('invalid');
  });
  App.$('#contact').addEventListener('input', function () {
    if (this.value.trim()) fContact.classList.remove('invalid');
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    App.clearStatus(statusEl);
    if (!validate()) return;

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '送信中…';

    var res = await App.postJson('/api/signup/request', {
      email: App.$('#email').value.trim(),
      organization_name: App.$('#org').value.trim(),
      contact_name: App.$('#contact').value.trim()
    });

    btn.textContent = original;

    if (res.networkError) {
      btn.disabled = false;
      App.setStatus(statusEl, 'err', 'ネットワークエラーが発生しました。時間をおいて再度お試しください。');
      return;
    }

    if (res.status === 202 || res.ok) {
      form.reset();
      App.setStatus(statusEl, 'ok',
        '確認メールを送信しました。メール内のリンクから登録を完了してください。（メールが届かない場合は迷惑メールフォルダもご確認ください）');
      return;
    }

    // エラー: サーバの error_description を textContent で安全表示
    btn.disabled = false;
    var d = res.data || {};
    var msg = d.error_description || '送信に失敗しました。入力内容をご確認ください。';
    if (res.status === 409) msg = d.error_description || 'このメールアドレスは既に登録されています。';
    App.setStatus(statusEl, 'err', msg);
  });
})();

/* 申込確認: ?token= をユーザー操作で POST /api/signup/confirm、成功でパスキー登録へ誘導 */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var statusEl = App.$('#status');
  var btn = App.$('#confirm-btn');
  var nextStep = App.$('#next-step');
  var passkeyBtn = App.$('#passkey-btn');

  var token = App.queryParam('token');
  var confirmedEmail = null;
  var registrationToken = null;

  if (!token) {
    btn.disabled = true;
    App.setStatus(statusEl, 'err', 'URL が正しくありません。確認メールのリンクから再度アクセスしてください。');
    return;
  }

  btn.addEventListener('click', async function () {
    App.clearStatus(statusEl);
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '確認中…';

    var res = await App.postJson('/api/signup/confirm', { token: token });
    btn.textContent = original;

    if (res.networkError) {
      btn.disabled = false;
      App.setStatus(statusEl, 'err', 'ネットワークエラーが発生しました。時間をおいて再度お試しください。');
      return;
    }

    if (res.ok && res.data) {
      confirmedEmail = res.data.email || null;
      registrationToken = res.data.registration_token || null;
      btn.style.display = 'none';
      App.setStatus(statusEl, 'ok', (res.data.message || '申込を確定しました。') + (confirmedEmail ? '（' + confirmedEmail + '）' : ''));
      if (!registrationToken) {
        App.setStatus(statusEl, 'err', '登録トークンを取得できませんでした。お手数ですが再度お申し込みください。');
        return;
      }
      nextStep.style.display = 'block';
      return;
    }

    btn.disabled = false;
    var d = res.data || {};
    App.setStatus(statusEl, 'err', d.error_description || 'リンクの有効期限が切れているか、既に使用済みです。お手数ですが再度お申し込みください。');
  });

  // パスキー登録は accounts オリジン（RP ID=accounts.ec-auth.io）で行う。
  // 登録トークン・client_id・メールを引き継ぎ、accounts のパスキー登録ページへ遷移する。
  passkeyBtn.addEventListener('click', function () {
    var cfg = window.ECAUTH || {};
    var base = (cfg.apiBaseUrl || '').replace(/\/$/, '');
    var q = new URLSearchParams();
    q.set('token', registrationToken || '');
    q.set('client_id', cfg.adminClientId || '');
    if (confirmedEmail) q.set('email', confirmedEmail);
    window.location.href = base + '/passkey/register?' + q.toString();
  });
})();

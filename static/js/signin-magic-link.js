/* マジックリンク着地: ?token= をユーザー操作で POST verify → 返却 location へ遷移 */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var statusEl = App.$('#status');
  var btn = App.$('#login-btn');

  var token = App.queryParam('token');
  if (!token) {
    btn.disabled = true;
    App.setStatus(statusEl, 'err', 'URL が正しくありません。メール内のリンクから再度アクセスしてください。');
    return;
  }

  btn.addEventListener('click', async function () {
    App.clearStatus(statusEl);
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = 'ログイン中…';

    var res = await App.postJson('/api/account/magic-link/verify', { token: token });

    if (res.networkError) {
      btn.textContent = original;
      btn.disabled = false;
      App.setStatus(statusEl, 'err', 'ネットワークエラーが発生しました。時間をおいて再度お試しください。');
      return;
    }

    if (res.ok && res.data && res.data.location) {
      // マジックリンクは PKCE を伴わない。callback 側は verifier 非依存で code を交換する。
      App.setStatus(statusEl, 'ok', 'ログインに成功しました。移動しています…');
      window.location.href = res.data.location;
      return;
    }

    btn.textContent = original;
    btn.disabled = false;
    var d = res.data || {};
    App.setStatus(statusEl, 'err', d.error_description || 'リンクの有効期限が切れているか、既に使用済みです。お手数ですが再度お試しください。');
  });
})();

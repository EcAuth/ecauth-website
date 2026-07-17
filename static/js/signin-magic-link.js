/* マジックリンク着地: ?token= をユーザー操作で POST verify → 返却 location へ遷移 */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var statusEl = App.$('#status');
  var btn = App.$('#login-btn');

  // 遷移先が自オリジンの絶対 URL のときのみ返す。それ以外は null（オープンリダイレクト対策）。
  function sameOriginUrl(value) {
    try {
      var u = new URL(value, window.location.origin);
      return u.origin === window.location.origin ? u.href : null;
    } catch (e) {
      return null;
    }
  }

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
      // オープンリダイレクト対策: 遷移先は自サイト（ec-auth.io）内に限定する。
      // サーバ返却値でも、同一オリジンの絶対 URL 以外へは遷移しない。
      var dest = sameOriginUrl(res.data.location);
      if (!dest) {
        App.setStatus(statusEl, 'err', '不正な遷移先が返されました。お手数ですが最初からやり直してください。');
        return;
      }
      App.setStatus(statusEl, 'ok', 'ログインに成功しました。移動しています…');
      window.location.href = dest;
      return;
    }

    btn.textContent = original;
    btn.disabled = false;
    var d = res.data || {};
    App.setStatus(statusEl, 'err', d.error_description || 'リンクの有効期限が切れているか、既に使用済みです。お手数ですが再度お試しください。');
  });
})();

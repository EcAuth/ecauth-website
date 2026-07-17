/*
 * OAuth2 コールバック: ?code= を /v1/token で交換してアクセストークンを取得。
 * - パスキー経路: sessionStorage の code_verifier を付けて PKCE 交換。
 * - マジックリンク経路: verifier が無い（サーバが code を発行）。verifier 無しで交換する。
 * トークン取得後はマイページへ遷移する。
 */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var cfg = window.ECAUTH || {};
  var AT_KEY = 'ecauth_at';
  var VERIFIER_KEY = 'ecauth_pkce_verifier';

  var statusEl = App.$('#status');
  var msgEl = App.$('#cb-message');
  var retryEl = App.$('#retry');

  function fail(text) {
    msgEl.style.display = 'none';
    App.setStatus(statusEl, 'err', text);
    retryEl.style.display = '';
  }

  function apiBase() { return (cfg.apiBaseUrl || '').replace(/\/$/, ''); }

  var error = App.queryParam('error');
  var code = App.queryParam('code');

  if (error) {
    fail('ログインがキャンセルされたか、エラーが発生しました（' + error + '）。');
    return;
  }
  if (!code) {
    fail('認可コードがありません。お手数ですが最初からやり直してください。');
    return;
  }

  (async function () {
    var verifier = sessionStorage.getItem(VERIFIER_KEY);
    var body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', cfg.authRedirectUri || '');
    body.set('client_id', cfg.adminClientId || '');
    if (verifier) body.set('code_verifier', verifier);

    var res, data = null;
    try {
      res = await fetch(apiBase() + '/v1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: body.toString()
      });
      try { data = await res.json(); } catch (e) {}
    } catch (e) {
      fail('ネットワークエラーが発生しました。時間をおいて再度お試しください。');
      return;
    }

    // 使い終わった verifier は必ず破棄
    sessionStorage.removeItem(VERIFIER_KEY);

    if (res.ok && data && data.access_token) {
      sessionStorage.setItem(AT_KEY, data.access_token);
      window.location.replace('/mypage/');
      return;
    }

    var desc = (data && data.error_description) || 'ログインに失敗しました。お手数ですが最初からやり直してください。';
    fail(desc);
  })();
})();

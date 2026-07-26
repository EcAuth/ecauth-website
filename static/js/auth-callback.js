/*
 * OAuth2 コールバック（パスキー経路 / PKCE）: ?code= を /v1/token で交換。
 * セキュリティ上、この経路は必ず PKCE(code_verifier) + state を要求する。
 *   - state: mypage で保存した値と一致検証（CSRF / 認可コード注入対策）。
 *   - code_verifier: 必須。欠落時は交換せずエラー（PKCE ダウングレード防止）。
 * マジックリンク（リカバリ）は verifier を持てず本経路と衝突するため、backend 側の
 * /api/account/magic-link/verify がトークンを直接返す。よってリカバリ経路は本 callback を
 * 経由しない（signin-magic-link.js 参照）。ここは常にパスキー経路のみを扱う。
 */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var cfg = window.ECAUTH || {};
  var AT_KEY = 'ecauth_at';
  var VERIFIER_KEY = 'ecauth_pkce_verifier';
  var STATE_KEY = 'ecauth_oauth_state';

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
  var returnedState = App.queryParam('state');

  var expectedState = sessionStorage.getItem(STATE_KEY);
  var verifier = sessionStorage.getItem(VERIFIER_KEY);
  // 使い捨て: 検証用に取り出したら即破棄する（再利用・残留を防ぐ）
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  if (error) {
    fail('ログインがキャンセルされたか、エラーが発生しました（' + error + '）。');
    return;
  }
  if (!code) {
    fail('認可コードがありません。お手数ですが最初からやり直してください。');
    return;
  }
  // state 検証（CSRF / 認可コード注入対策）。開始時の値と一致しなければ中断。
  if (!expectedState || returnedState !== expectedState) {
    fail('セッションが確認できませんでした。お手数ですが最初からやり直してください。');
    return;
  }
  // PKCE 必須（ダウングレード防止）。verifier が無ければ交換しない。
  if (!verifier) {
    fail('ログインセッションが確認できませんでした。マイページから再度ログインしてください。');
    return;
  }

  (async function () {
    var body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', cfg.authRedirectUri || '');
    body.set('client_id', cfg.adminClientId || '');
    body.set('code_verifier', verifier);

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

    if (res.ok && data && data.access_token) {
      sessionStorage.setItem(AT_KEY, data.access_token);
      window.location.replace('/mypage/');
      return;
    }

    var desc = (data && data.error_description) || 'ログインに失敗しました。お手数ですが最初からやり直してください。';
    fail(desc);
  })();
})();

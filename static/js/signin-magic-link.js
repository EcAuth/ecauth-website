/*
 * マジックリンク着地: ?token= をユーザー操作で POST verify → 返却されたトークンでマイページへ。
 *
 * verify は認可コードではなくアクセストークンを直接返す。マイページ（管理コンソール）は
 * public client であり /v1/token は PKCE(code_verifier) を必須とするが、マジックリンクは
 * メール往復（別端末・別ブラウザもあり得る）のため verifier を着地側と紐づけられない。
 * よってリカバリ経路では認可コードを介さず、/auth/callback も経由しない。
 */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var AT_KEY = 'ecauth_at';
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

    if (res.ok && res.data && res.data.access_token) {
      // マイページと同じ保管場所・同じキーに置く（/auth/callback 経由と等価な状態にする）。
      sessionStorage.setItem(AT_KEY, res.data.access_token);
      App.setStatus(statusEl, 'ok', 'ログインに成功しました。移動しています…');
      // replace: 戻る操作で消費済みトークンの URL に戻らせない。
      window.location.replace('/mypage/');
      return;
    }

    btn.textContent = original;
    btn.disabled = false;
    var d = res.data || {};
    App.setStatus(statusEl, 'err', d.error_description || 'リンクの有効期限が切れているか、既に使用済みです。お手数ですが再度お試しください。');
  });
})();

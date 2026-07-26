/*
 * マイページ: OAuth2(PKCE) public client。
 * 未認証 → パスキー認証(accounts)へ誘導。認証済 → GET /v1/account/clients を表示。
 */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var cfg = window.ECAUTH || {};
  var AT_KEY = 'ecauth_at';
  var MASK = '••••••••••••••••';
  var VERIFIER_KEY = 'ecauth_pkce_verifier';
  var STATE_KEY = 'ecauth_oauth_state';

  function randomState() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  var loading = App.$('#loading');
  var loginView = App.$('#login-view');
  var appView = App.$('#app-view');
  var clientsEl = App.$('#clients');
  var listStatus = App.$('#list-status');

  function show(el) { if (el) el.style.display = ''; }
  function hide(el) { if (el) el.style.display = 'none'; }

  function apiBase() { return (cfg.apiBaseUrl || '').replace(/\/$/, ''); }

  // --- 認証開始（PKCE）---
  App.$('#login-btn').addEventListener('click', async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var pkce = await window.EcAuthPkce.create();
      var state = randomState();
      sessionStorage.setItem(VERIFIER_KEY, pkce.verifier);
      sessionStorage.setItem(STATE_KEY, state);
      var q = new URLSearchParams({
        client_id: cfg.adminClientId || '',
        redirect_uri: cfg.authRedirectUri || '',
        response_type: 'code',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        // CSRF / 認可コード注入対策。callback で保存値と一致検証する。
        state: state
      });
      // accounts オリジンのパスキー認証ページ（RP ID=accounts）へ遷移
      window.location.href = apiBase() + '/passkey/authenticate?' + q.toString();
    } catch (e) {
      btn.disabled = false;
      App.setStatus(App.$('#login-status'), 'err', 'パスキー認証を開始できませんでした。この端末は対応していない可能性があります。');
    }
  });

  App.$('#logout-link').addEventListener('click', function (e) {
    e.preventDefault();
    sessionStorage.removeItem(AT_KEY);
    window.location.reload();
  });

  // --- Client 一覧の描画（DOM 構築で XSS 回避）---
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function makeCodeRow(labelText, value) {
    var row = el('div', 'secret-row');
    row.appendChild(el('span', 'label', labelText));
    row.appendChild(el('code', null, value));

    var copy = el('button', 'icon-btn', 'コピー');
    copy.addEventListener('click', async function () {
      var ok = await App.copyText(value);
      copy.textContent = ok ? 'コピー済' : '失敗';
      setTimeout(function () { copy.textContent = 'コピー'; }, 1500);
    });
    row.appendChild(copy);
    return row;
  }

  /*
   * Client Secret 行。
   * 一覧 API（GET /v1/account/clients）は secret 値を返さないため、
   * 「表示」/「コピー」の操作時に初めて POST .../secret/reveal で 1 件だけ取得する。
   * 取得済みの値はこの行のクロージャにのみ保持し、DOM 上は既定でマスク表示のままにする。
   */
  function makeSecretRow(client) {
    var secret = null;      // reveal 済みの平文（未取得なら null）
    var revealed = false;

    var row = el('div', 'secret-row');
    row.appendChild(el('span', 'label', 'Client Secret'));
    var code = el('code', null, client.has_secret ? MASK : '（未設定）');
    row.appendChild(code);

    function render() {
      code.textContent = !client.has_secret ? '（未設定）'
        : (revealed && secret) ? secret : MASK;
      toggle.textContent = revealed ? '隠す' : '表示';
    }

    // 未取得なら reveal API で取得する。取得できたら平文を返す。
    async function ensureSecret(btn) {
      if (secret != null) return secret;
      var original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '取得中…';
      var res = await authFetch('POST', '/v1/account/clients/' + encodeURIComponent(client.id) + '/secret/reveal');
      btn.disabled = false;
      btn.textContent = original;
      if (res && res.ok && res.data && typeof res.data.client_secret === 'string') {
        secret = res.data.client_secret;
        return secret;
      }
      if (res && res.status === 401) { requireLogin(); return null; }
      App.setStatus(listStatus, 'err', 'Client Secret を取得できませんでした。時間をおいて再度お試しください。');
      return null;
    }

    var toggle = el('button', 'icon-btn', '表示');
    toggle.addEventListener('click', async function () {
      if (!client.has_secret) return;
      if (revealed) { revealed = false; render(); return; }
      if (await ensureSecret(toggle) == null) return;
      revealed = true;
      render();
    });
    row.appendChild(toggle);

    var copy = el('button', 'icon-btn', 'コピー');
    copy.addEventListener('click', async function () {
      if (!client.has_secret) return;
      var value = await ensureSecret(copy);
      if (value == null) return;
      var ok = await App.copyText(value);
      copy.textContent = ok ? 'コピー済' : '失敗';
      setTimeout(function () { copy.textContent = 'コピー'; }, 1500);
    });
    row.appendChild(copy);

    var regen = el('button', 'icon-btn', '再生成');
    regen.addEventListener('click', function () {
      regenerateSecret(client, regen, function (newSecret) {
        secret = newSecret;
        revealed = true;          // 生成直後は控えてもらうため全表示にする
        client.has_secret = true;
        render();
      });
    });
    row.appendChild(regen);

    return row;
  }

  function renderClients(clients) {
    clientsEl.textContent = '';
    if (!clients.length) {
      App.setStatus(listStatus, 'info', '表示できる Client がありません。');
      return;
    }
    clients.forEach(function (c) {
      var item = el('div', 'client-item');
      var badge = el('span', 'obadge ' + (c.is_sandbox ? 'sand' : 'prod'), c.is_sandbox ? 'テスト' : '本番');
      var name = el('div', 'ci-name');
      name.appendChild(badge);
      name.appendChild(document.createTextNode(c.app_name || c.organization_name || c.client_id));
      item.appendChild(name);
      if (c.organization_code) item.appendChild(el('div', 'ci-domain', c.organization_code));

      item.appendChild(makeCodeRow('Client ID', c.client_id));
      item.appendChild(makeSecretRow(c));

      clientsEl.appendChild(item);
    });
  }

  async function regenerateSecret(client, regenBtn, onSuccess) {
    if (!global_confirm('Client Secret を再生成します。既存の値は無効になり、EC-CUBE プラグインへの再設定が必要です。よろしいですか？')) return;
    regenBtn.disabled = true;
    var original = regenBtn.textContent;
    regenBtn.textContent = '生成中…';
    var res = await authFetch('POST', '/v1/account/clients/' + encodeURIComponent(client.id) + '/secret');
    regenBtn.disabled = false;
    regenBtn.textContent = original;
    if (res && res.ok && res.data && res.data.client_secret) {
      onSuccess(res.data.client_secret);
      App.setStatus(listStatus, 'ok', 'Client Secret を再生成しました。EC-CUBE プラグインに再設定してください。');
    } else if (res && res.status === 401) {
      requireLogin();
    } else {
      App.setStatus(listStatus, 'err', '再生成に失敗しました。時間をおいて再度お試しください。');
    }
  }

  function global_confirm(msg) { return window.confirm(msg); }

  // --- 認証付き fetch ---
  async function authFetch(method, path) {
    var token = sessionStorage.getItem(AT_KEY);
    try {
      var res = await fetch(apiBase() + path, {
        method: method,
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      return { ok: res.ok, status: res.status, data: data };
    } catch (e) {
      return { ok: false, status: 0, data: null, networkError: true };
    }
  }

  function requireLogin() {
    sessionStorage.removeItem(AT_KEY);
    hide(loading); hide(appView); show(loginView);
  }

  async function loadClients() {
    var res = await authFetch('GET', '/v1/account/clients');
    if (res.status === 401) { requireLogin(); return; }
    if (!res.ok || !res.data) {
      hide(loading); show(appView);
      App.setStatus(listStatus, 'err', 'Client 情報の取得に失敗しました。時間をおいて再度お試しください。');
      return;
    }
    hide(loading); show(appView);
    renderClients(res.data.clients || []);
  }

  // --- 初期化 ---
  (function init() {
    var token = sessionStorage.getItem(AT_KEY);
    if (!token) { requireLogin(); return; }
    loadClients();
  })();
})();

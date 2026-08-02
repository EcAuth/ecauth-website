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

  /*
   * Client 設定（redirect_uri / allowed_rp_ids）の編集セクション。
   *
   * API はどちらも「配列を受け取ってリストごと全置換」する POST。CORS ポリシーが
   * GET / POST / OPTIONS 限定のため PUT / DELETE は使えない。
   *
   * サーバは入力値をエラーに載せず「N 件目の redirect_uri は…」という**位置**で返す
   * （redirect_uri は user:pass@ を含みうるため、反映するとログに資格情報が残る）。
   * そのため画面の行番号と送信配列の添字を必ず一致させる:
   *   - 行は表示順のまま送る
   *   - 空欄の行も落とさずに送る（クライアントで詰めると位置がずれ、別の行を指すエラーになる）
   * 空要素はサーバ側が捨てる。
   */
  var SECTIONS = [
    {
      key: 'redirect_uris',
      path: 'redirect-uris',
      title: 'コールバック URL（redirect_uri）',
      inputType: 'url',
      placeholder: 'https://shop.example.jp/ecauth/callback',
      hints: [
        'EC-CUBE 4 系は https://{管理画面のホスト}/ecauth/callback、2 系は https://{管理画面のホスト}/ecauth/callback.php です。',
        'サブディレクトリに設置している場合は、そのパスを前に付けてください（例: https://shop.example.jp/shop/ecauth/callback）。'
      ],
      warning: null,
      // 消しても再設定すれば復旧できるため確認は挟まない。
      confirmMessage: null
    },
    {
      key: 'allowed_rp_ids',
      path: 'allowed-rp-ids',
      title: 'パスキーのドメイン（RP ID）',
      inputType: 'text',
      placeholder: 'shop.example.jp',
      hints: [
        '管理画面のホスト名だけを指定します。https:// やポート番号（:8443）、IP アドレスは指定できません。'
      ],
      // パスキーは RP ID に束縛されるため、変更は既存の資格情報を無効化する破壊的操作になる。
      warning: '変更・削除すると、そのドメインで登録済みのパスキーは使えなくなり、再登録が必要になります。',
      confirmMessage: 'パスキーのドメイン（RP ID）を変更します。削除・変更したドメインで登録済みのパスキーは使えなくなり、再登録が必要です。よろしいですか？'
    }
  ];

  function descriptionOf(res) {
    return res && res.data && typeof res.data.error_description === 'string' ? res.data.error_description : '';
  }

  function makeSettingsSection(client, section) {
    // 直近にサーバへ保存された値。「取り消し」の戻り先であり、件数表示の元でもある。
    var values = (client[section.key] || []).slice();

    var box = el('details', 'ci-settings');
    box.setAttribute('data-section', section.key);

    var summary = document.createElement('summary');
    summary.appendChild(document.createTextNode(section.title));
    var count = el('span', 'ci-count');
    summary.appendChild(count);
    box.appendChild(summary);

    var list = el('div', 'row-list');
    box.appendChild(list);

    var add = el('button', 'icon-btn row-add', '+ 追加');
    add.type = 'button';
    box.appendChild(add);

    section.hints.forEach(function (h) { box.appendChild(el('p', 'hint', h)); });
    if (section.warning) box.appendChild(el('p', 'hint warn', '⚠ ' + section.warning));

    var actions = el('div', 'row-actions');
    var save = el('button', 'btn primary small row-save', '保存');
    save.type = 'button';
    var cancel = el('button', 'btn secondary small row-cancel', '取り消し');
    cancel.type = 'button';
    actions.appendChild(save);
    actions.appendChild(cancel);
    box.appendChild(actions);

    // App.setStatus / clearStatus は className を丸ごと差し替えるため、目印はクラスではなく
    // 属性で持つ（クラスに付けると 1 回目の setStatus で消える）。
    var statusEl = el('div', 'status');
    statusEl.setAttribute('data-status', 'section');
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    box.appendChild(statusEl);

    // 画面の行から配列を作る。空欄も落とさない（サーバのエラー位置と対応づけるため）。
    function collect() {
      return Array.prototype.map.call(
        list.querySelectorAll('.row-input'), function (input) { return input.value; });
    }

    function renderRows(items) {
      list.textContent = '';
      // 0 件だと入力する場所が無いので、空の行を 1 つ出す。
      (items.length ? items : ['']).forEach(function (value, index) {
        var row = el('div', 'list-row');
        var no = index + 1;
        row.appendChild(el('span', 'row-no', String(no)));

        var input = document.createElement('input');
        input.className = 'row-input';
        input.type = section.inputType;
        input.value = value;
        input.placeholder = section.placeholder;
        input.setAttribute('aria-label', section.title + ' ' + no + ' 件目');
        row.appendChild(input);

        var del = el('button', 'icon-btn row-del', '削除');
        del.type = 'button';
        del.setAttribute('aria-label', section.title + ' ' + no + ' 件目を削除');
        del.addEventListener('click', function () {
          // 他の行に入力途中の値があっても失わないよう、画面の現在値から作り直す。
          var next = collect();
          next.splice(index, 1);
          renderRows(next);
        });
        row.appendChild(del);

        list.appendChild(row);
      });
    }

    function renderCount() { count.textContent = values.length + ' 件'; }

    add.addEventListener('click', function () {
      var next = collect();
      next.push('');
      renderRows(next);
    });

    cancel.addEventListener('click', function () {
      App.clearStatus(statusEl);
      renderRows(values);
    });

    save.addEventListener('click', async function () {
      if (section.confirmMessage && !global_confirm(section.confirmMessage)) return;

      var body = {};
      body[section.key] = collect();

      save.disabled = true;
      var original = save.textContent;
      save.textContent = '保存中…';
      var res = await authFetch(
        'POST', '/v1/account/clients/' + encodeURIComponent(client.id) + '/' + section.path, body);
      save.disabled = false;
      save.textContent = original;

      if (res.status === 401) { requireLogin(); return; }
      if (!res.ok || !res.data || !Array.isArray(res.data[section.key])) {
        // 422 は error_description に「N 件目の…」という位置付きの理由が入る。そのまま見せる
        // （setStatus は textContent なのでサーバ由来の文字列を渡しても安全）。
        // ここで再描画はしない。入力を残したまま直して再送できるようにするため。
        App.setStatus(statusEl, 'err',
          descriptionOf(res) || '保存に失敗しました。時間をおいて再度お試しください。');
        return;
      }

      // 保存されたのは正規化後の値（ホストの小文字化・Punycode 化・重複の畳み込み・空要素の除去）。
      // 入力のままではなく、実際に保存された配列で描き直す。
      values = res.data[section.key].slice();
      client[section.key] = values.slice();
      renderRows(values);
      renderCount();
      App.setStatus(statusEl, 'ok', '保存しました。');
    });

    renderRows(values);
    renderCount();
    return box;
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
      SECTIONS.forEach(function (s) { item.appendChild(makeSettingsSection(c, s)); });

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
  // body を渡すと JSON として送る（渡さなければヘッダも付けない）。
  async function authFetch(method, path, body) {
    var token = sessionStorage.getItem(AT_KEY);
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    var init = { method: method, headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      var res = await fetch(apiBase() + path, init);
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

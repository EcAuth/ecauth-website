/*
 * マイページ: OAuth2(PKCE) public client。
 * 未認証 → パスキー認証(accounts)へ誘導。認証済 → GET /v1/account/organizations を表示。
 *
 * 画面の単位は **サイト（Organization）**。Organization = 組織、Client = アプリケーション
 * （EC-CUBE / WordPress 等）で、1 つのサイトに複数の Client がぶら下がる（EcAuthDocs#121）。
 * 申込もマイページからのサイト追加も Client を 1 つ持つ Organization を作り、既存のサイトには
 * カード内の「Client を追加」から POST /v1/account/organizations/{id}/clients で Client を足す。
 * 本番の登録上限（max_sites）は本番サイト配下の Client 数で数える（サーバと同じ単位）。
 * organizations は各 Organization の clients[] を内包するため一覧はこの 1 本で足り、
 * 加えて「本番 / テストの対応」（parent_organization_id）と「本番の登録上限」（max_sites）を
 * 返す。サイト追加フォームはこの 2 つが無いと選択肢も残枠も出せないので、
 * 旧 GET /v1/account/clients は使わない。
 *
 * 「お支払い」カード（EcAuthDocs#119）は GET /v1/account/billing を一覧とは別に取り、
 * 支払い方法の登録状況と当月の見込み額（税抜）を出す。カードの登録・管理は Stripe の
 * Checkout / Customer Portal に任せ、ここでは遷移先 URL を受け取って移るだけ。
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
  var sitesEl = App.$('#sites');
  var listStatus = App.$('#list-status');

  // --- サイト追加フォーム ---
  var addCard = App.$('#add-card');
  var addForm = App.$('#add-form');
  var addUrlField = App.$('#f-add-url');
  var addUrl = App.$('#add-url');
  var addBtn = App.$('#add-btn');
  var addStatus = App.$('#add-status');
  var addKindHint = App.$('#add-kind-hint');
  var addParentField = App.$('#f-add-parent');
  var addParent = App.$('#add-parent');
  var kindProduction = App.$('#add-kind-production');
  var kindSandbox = App.$('#add-kind-sandbox');
  var siteUsage = App.$('#site-usage');

  // 直近に取得した一覧。追加フォームの選択肢・残枠判定と、削除確認に出す
  // 「一緒に消えるテストサイト」の割り出しに使う。
  var organizations = [];
  var maxSites = 0;

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

    /*
     * 保存リクエストの飛行中はセクション全体の編集操作を止める。
     * 送信ボディは「保存」を押した時点のスナップショットなので、飛行中に加えた編集は
     * 送られていない。にもかかわらず成功時の renderRows(values) で上書きされるため、
     * ロックしないと「送っていない変更が黙って消えたのに『保存しました』と出る」状態になる。
     */
    function setBusy(busy) {
      save.disabled = busy;
      add.disabled = busy;
      cancel.disabled = busy;
      Array.prototype.forEach.call(
        list.querySelectorAll('.row-input, .row-del'), function (n) { n.disabled = busy; });
    }

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

      var original = save.textContent;
      save.textContent = '保存中…';
      setBusy(true);
      var res = await authFetch(
        'POST', '/v1/account/clients/' + encodeURIComponent(client.id) + '/' + section.path, body);
      setBusy(false);
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

  /*
   * 表示順は「本番 → その本番に紐づくテスト」。API は id 昇順で返すため、あとから足した
   * テストサイトは親から離れた位置に来る。並べ直さないとどのテストがどの本番のものか
   * 画面から読み取れない。
   *
   * 親が一覧に無いテストサイトは本来生まれない（本番を削除するとテストもカスケードで
   * 論理削除される）が、万一残っても隠さず末尾に出す。見えていれば削除できるが、
   * 隠すと消す手段が無くなる。
   */
  function orderSites(orgs) {
    var productions = orgs.filter(function (o) { return !o.is_sandbox; });
    var sandboxes = orgs.filter(function (o) { return o.is_sandbox; });
    var ordered = [];

    productions.forEach(function (production) {
      ordered.push({ org: production, parent: null });
      sandboxes
        .filter(function (s) { return s.parent_organization_id === production.id; })
        .forEach(function (s) { ordered.push({ org: s, parent: production }); });
    });

    var placed = {};
    ordered.forEach(function (entry) { placed[entry.org.id] = true; });
    sandboxes.forEach(function (s) {
      if (!placed[s.id]) ordered.push({ org: s, parent: null });
    });

    return ordered;
  }

  // 表示中のカードが持つ「削除確認を閉じる」関数。描画のたびに作り直す。
  var closers = [];
  function closeAllConfirms() {
    closers.forEach(function (close) { close(); });
  }

  /** 画面上のサイトの呼び名。組織コードが実質の識別子（接続先ホスト名）になる。 */
  function siteLabel(org) {
    return org.code || org.name || '';
  }

  /** 本番サイトを削除したとき、一緒に論理削除されるテストサイトを含めた一覧。 */
  function deletionTargets(org) {
    if (org.is_sandbox) return [org];
    return [org].concat(
      organizations.filter(function (o) { return o.parent_organization_id === org.id; }));
  }

  /*
   * 削除の確認。window.confirm では読ませきれない情報（一緒に消えるテストサイト、
   * 失われる Client ID とパスキー、同じドメインで再登録できないこと）を提示する必要が
   * あるため、カード内に確認ブロックを展開する。
   */
  function makeDeleteConfirm(org, trigger) {
    var box = el('div', 'site-confirm');
    box.hidden = true;

    var targets = deletionTargets(org);
    box.appendChild(el('p', 'sc-title', '「' + siteLabel(org) + '」を削除します。取り消せません。'));

    box.appendChild(el('p', 'sc-label', '削除されるサイト'));
    var list = el('ul', 'sc-list');
    targets.forEach(function (t) {
      list.appendChild(el('li', null, t.code + (t.is_sandbox ? '（テストサイト）' : '（本番サイト）')));
    });
    box.appendChild(list);

    box.appendChild(el('p', 'sc-note',
      '発行済みの Client ID / Client Secret は使えなくなり、EC-CUBE 管理画面から EcAuth でログインできなくなります。'
        + 'このサイトに登録済みのパスキーもすべて無効になります。'));
    box.appendChild(el('p', 'sc-note',
      'ご利用状況の集計のため記録は残ります。同じドメインで登録し直すことはできません。'));

    var actions = el('div', 'sc-actions');
    var proceed = el('button', 'btn danger small sc-ok', '削除する');
    proceed.type = 'button';
    var cancel = el('button', 'btn secondary small sc-cancel', 'やめる');
    cancel.type = 'button';
    actions.appendChild(proceed);
    actions.appendChild(cancel);
    box.appendChild(actions);

    // App.setStatus は className を差し替えるため、目印はクラスではなく属性で持つ
    // （makeSettingsSection と同じ理由）。
    var statusEl = el('div', 'status');
    statusEl.setAttribute('data-status', 'delete');
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    box.appendChild(statusEl);

    cancel.addEventListener('click', function () { close(); });

    function close() {
      box.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      App.clearStatus(statusEl);
    }

    proceed.addEventListener('click', async function () {
      proceed.disabled = true;
      cancel.disabled = true;
      trigger.disabled = true;
      var original = proceed.textContent;
      proceed.textContent = '削除中…';

      var res = await authFetch(
        'POST', '/v1/account/organizations/' + encodeURIComponent(org.id) + '/delete');

      if (res.status === 401) { requireLogin(); return; }

      if (!res.ok) {
        proceed.disabled = false;
        cancel.disabled = false;
        trigger.disabled = false;
        proceed.textContent = original;
        // 404 は「別の端末で先に削除済み」等。理由はサーバの文言をそのまま見せる。
        App.setStatus(statusEl, 'err',
          descriptionOf(res) || '削除に失敗しました。時間をおいて再度お試しください。');
        return;
      }

      var deleted = res.data && Array.isArray(res.data.deleted_organization_ids)
        ? res.data.deleted_organization_ids.length : targets.length;

      // 再読込でこのカードごと消える。完了メッセージは一覧側に出す。
      // 再取得に失敗したときは書かない。古いカードが残ったまま「削除しました」と出ると
      // 削除できていないように見え、loadSites が出したエラーの理由まで消えるため。
      if (!(await loadSites())) return;
      App.setStatus(listStatus, 'ok', deleted > 1
        ? 'サイトを削除しました（紐づくテストサイトを含む ' + deleted + ' 件）。'
        : 'サイトを削除しました。');
    });

    return { box: box, close: close };
  }

  /*
   * 既存サイトへの Client 追加（EcAuthDocs#121 項目 3）。
   *
   * 同じ組織で EC-CUBE と WordPress のように複数のアプリケーションを運用する場合、サイト
   * （Organization）を増やすと接続先サブドメイン・Client ID / Secret・カードがサイト数だけ
   * 増える。代わりに既存サイトのカード内に Client を足し、テナント（接続先）は共有する。
   *
   * 本番サイトへの追加はサイト追加の本番と同じ枠（max_sites = 本番配下の Client 数）を使う。
   * テストサイトへの追加は枠に数えない。上限到達はサーバも 422 で弾くが、押す前に理由を出す。
   */
  function makeClientAddForm(org, trigger) {
    var box = el('form', 'client-add');
    box.hidden = true;
    box.setAttribute('novalidate', '');

    box.appendChild(el('p', 'ca-title', '「' + siteLabel(org) + '」に Client を追加します。'));
    box.appendChild(el('p', 'ca-note',
      '同じサイトで EC-CUBE と WordPress のように複数のアプリケーションを使う場合に追加します。'
        + '接続先（' + siteLabel(org) + '）は共有し、Client ID / Client Secret を新たに発行します。'));

    var urlField = el('div', 'field');
    var urlId = 'ca-url-' + org.id;
    var urlLabel = el('label', null, 'アプリケーションの URL');
    urlLabel.setAttribute('for', urlId);
    urlLabel.appendChild(el('span', 'req', '*'));
    urlField.appendChild(urlLabel);
    var urlInput = el('input', 'ca-url');
    urlInput.type = 'url';
    urlInput.id = urlId;
    urlInput.placeholder = 'https://blog.example.jp';
    urlInput.setAttribute('inputmode', 'url');
    urlInput.setAttribute('autocomplete', 'off');
    urlField.appendChild(urlInput);
    urlField.appendChild(el('div', 'hint',
      'https:// で始まる URL を入力してください。コールバック URL とパスキーのドメインの初期値はこの URL から作られます。'
        + '既存の Client と同じドメインでも追加できます。'));
    var urlErr = el('div', 'err-msg', 'https:// で始まる有効な URL を入力してください。');
    urlErr.setAttribute('role', 'alert');
    urlField.appendChild(urlErr);
    box.appendChild(urlField);

    var versionField = el('div', 'field');
    var versionLabelId = 'ca-version-label-' + org.id;
    var versionLabel = el('label', null, 'ご利用の EC プラットフォーム');
    versionLabel.id = versionLabelId;
    versionLabel.appendChild(el('span', 'req', '*'));
    versionField.appendChild(versionLabel);
    var radios = el('div', 'radio-row');
    radios.setAttribute('role', 'radiogroup');
    radios.setAttribute('aria-labelledby', versionLabelId);
    var versionName = 'ca_version_' + org.id;
    [['4', 'EC-CUBE 4 系'], ['2', 'EC-CUBE 2 系'], ['other', 'EC-CUBE 以外']].forEach(function (v, i) {
      var label = el('label');
      var radio = el('input');
      radio.type = 'radio';
      radio.name = versionName;
      radio.value = v[0];
      if (i === 0) radio.checked = true;
      label.appendChild(radio);
      label.appendChild(el('span', null, v[1]));
      radios.appendChild(label);
    });
    versionField.appendChild(radios);
    versionField.appendChild(el('div', 'hint', 'コールバック URL の初期値がバージョンによって変わります。追加後に変更できます。'));
    box.appendChild(versionField);

    var nameField = el('div', 'field');
    var nameId = 'ca-name-' + org.id;
    var nameLabel = el('label', null, '表示名');
    nameLabel.setAttribute('for', nameId);
    nameLabel.appendChild(el('span', 'opt', '（任意）'));
    nameField.appendChild(nameLabel);
    var nameInput = el('input', 'ca-name');
    nameInput.type = 'text';
    nameInput.id = nameId;
    nameInput.placeholder = 'WordPress';
    nameInput.maxLength = 100;
    nameInput.setAttribute('autocomplete', 'off');
    nameField.appendChild(nameInput);
    nameField.appendChild(el('div', 'hint', '同じサイトの Client を見分けるための名前です。未入力ならアプリケーションのホスト名になります。'));
    box.appendChild(nameField);

    var actions = el('div', 'ca-actions');
    var submit = el('button', 'btn primary small ca-ok', '追加する');
    submit.type = 'submit';
    var cancel = el('button', 'btn secondary small ca-cancel', 'やめる');
    cancel.type = 'button';
    actions.appendChild(submit);
    actions.appendChild(cancel);
    box.appendChild(actions);

    // App.setStatus は className を差し替えるため、目印はクラスではなく属性で持つ
    // （makeSettingsSection / makeDeleteConfirm と同じ理由）。
    var statusEl = el('div', 'status');
    statusEl.setAttribute('data-status', 'client-add');
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    box.appendChild(statusEl);

    function close() {
      box.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      urlField.classList.remove('invalid');
      App.clearStatus(statusEl);
    }

    cancel.addEventListener('click', function () { close(); });

    urlInput.addEventListener('input', function () {
      var v = this.value.trim();
      if (v !== '' && validSiteUrl(v)) urlField.classList.remove('invalid');
    });

    box.addEventListener('submit', async function (e) {
      e.preventDefault();
      App.clearStatus(statusEl);
      App.clearStatus(listStatus);

      var url = urlInput.value.trim();
      var urlOk = url !== '' && validSiteUrl(url);
      urlField.classList.toggle('invalid', !urlOk);
      if (!urlOk) return;

      var checked = box.querySelector('input[name="' + versionName + '"]:checked');
      var body = { site_url: url, ec_cube_version: checked ? checked.value : '4' };
      var appName = nameInput.value.trim();
      if (appName !== '') body.app_name = appName;

      submit.disabled = true;
      cancel.disabled = true;
      trigger.disabled = true;
      var original = submit.textContent;
      submit.textContent = '追加中…';

      var res = await authFetch(
        'POST', '/v1/account/organizations/' + encodeURIComponent(org.id) + '/clients', body);

      if (res.status === 401) { requireLogin(); return; }

      if (!res.ok) {
        submit.disabled = false;
        cancel.disabled = false;
        trigger.disabled = false;
        submit.textContent = original;
        App.setStatus(statusEl, 'err',
          addErrorMessage(res, 'Client を追加できませんでした。入力内容をご確認ください。'));
        if (res.data && res.data.field === 'site_url') urlField.classList.add('invalid');
        return;
      }

      // 再読込でこのカードごと描き直す。完了メッセージは一覧側に出す。
      // 再取得に失敗したときは書かない（makeDeleteConfirm と同じ理由）。
      if (!(await loadSites())) {
        // loadSites は失敗時に既存カードを残すので、このフォームも「追加中…」のまま画面に残る。
        // Client は作成済みのため、入力を保ったまま submit を戻すと二重作成を招く。
        // フォームを閉じて入力を初期化し、次に開けるよう trigger とボタンだけ戻す。
        // 失敗の理由は loadSites が一覧側に出しているのでここでは触らない。
        close();
        box.reset();
        submit.disabled = false;
        cancel.disabled = false;
        trigger.disabled = false;
        submit.textContent = original;
        return;
      }
      App.setStatus(listStatus, 'ok',
        '「' + siteLabel(org) + '」に Client を追加しました。'
          + '新しい Client ID / Client Secret を確認し、アプリケーションに設定してください。');
    });

    return { box: box, close: close };
  }

  function makeSiteCard(org, parent) {
    // ルートのクラス名は .client-item のまま。EcAuth 側の結合 E2E
    // （website_signup_flow.spec.ts）がこのセレクタでカードを掴んでおり、
    // 1 カード = 1 サイトという単位も変わっていないため。
    var item = el('div', 'client-item' + (org.is_sandbox ? ' child' : ''));
    item.setAttribute('data-org-id', String(org.id));

    var head = el('div', 'ci-head');
    var name = el('div', 'ci-name');
    name.appendChild(el('span', 'obadge ' + (org.is_sandbox ? 'sand' : 'prod'), org.is_sandbox ? 'テスト' : '本番'));
    // 見出しは組織コード。組織名（申込時の会社名）はアカウント内の全サイトで同じ値になるため
    // サイトの識別に使えない。組織コードは接続先ホスト（https://{組織コード}.ec-auth.io）
    // そのものであり、最初のアプリケーションのドメインから導出されるので実質の識別子になる。
    name.appendChild(el('span', 'ci-code', siteLabel(org)));
    head.appendChild(name);

    var headActions = el('div', 'ci-actions');

    var addClientBtn = el('button', 'icon-btn client-add-btn', '+ Client を追加');
    addClientBtn.type = 'button';
    addClientBtn.setAttribute('aria-expanded', 'false');
    addClientBtn.setAttribute('aria-label', siteLabel(org) + ' に Client を追加');
    // 本番サイトの Client は上限（max_sites）の枠を使う。押しても 422 になる状態では無効化し、
    // 理由はサイト追加フォーム側のヒント（syncAddForm）と同じ文言で示す。
    if (!org.is_sandbox && !canAddProductionClient()) {
      addClientBtn.disabled = true;
      addClientBtn.title = '本番サイトは上限の ' + maxSites + ' 件に達しています。';
    }
    headActions.appendChild(addClientBtn);

    var del = el('button', 'icon-btn site-del', '削除');
    del.type = 'button';
    del.setAttribute('aria-expanded', 'false');
    del.setAttribute('aria-label', siteLabel(org) + ' を削除');
    headActions.appendChild(del);
    head.appendChild(headActions);
    item.appendChild(head);

    if (org.name) item.appendChild(el('div', 'ci-owner', org.name));
    if (org.is_sandbox && parent) {
      item.appendChild(el('div', 'ci-parent',
        '本番サイト「' + siteLabel(parent) + '」のテストサイトです。'));
    }

    var clients = org.clients || [];
    clients.forEach(function (client) {
      var block = el('div', 'ci-client');
      block.setAttribute('data-client-id', String(client.id));
      // Client が 1 件だけなら見出しは要らない。複数ある場合だけ、どの Client の設定かを見出しで示す。
      if (clients.length > 1) block.appendChild(el('div', 'ci-client-name', client.app_name || client.client_id));
      block.appendChild(makeCodeRow('Client ID', client.client_id));
      block.appendChild(makeSecretRow(client));
      SECTIONS.forEach(function (s) { block.appendChild(makeSettingsSection(client, s)); });
      item.appendChild(block);
    });

    var clientAdd = makeClientAddForm(org, addClientBtn);
    item.appendChild(clientAdd.box);
    closers.push(clientAdd.close);

    var deleteConfirm = makeDeleteConfirm(org, del);
    item.appendChild(deleteConfirm.box);
    closers.push(deleteConfirm.close);

    addClientBtn.addEventListener('click', function () {
      if (!clientAdd.box.hidden) { clientAdd.close(); return; }
      // 他のカードの追加フォーム・削除確認は閉じる（どのサイトへの操作か読み取りにくくなるため）。
      closeAllConfirms();
      clientAdd.box.hidden = false;
      addClientBtn.setAttribute('aria-expanded', 'true');
      clientAdd.box.querySelector('.ca-url').focus();
    });

    del.addEventListener('click', function () {
      if (!deleteConfirm.box.hidden) { deleteConfirm.close(); return; }
      // 他のカードの確認は閉じる。2 つ開いていると、どちらを消すのか読み取りにくい。
      closeAllConfirms();
      deleteConfirm.box.hidden = false;
      del.setAttribute('aria-expanded', 'true');
    });

    return item;
  }

  function renderSites(orgs) {
    sitesEl.textContent = '';
    closers = [];
    if (!orgs.length) {
      App.setStatus(listStatus, 'info',
        '登録済みのサイトがありません。下の「サイトを追加」から登録してください。');
      return;
    }
    orderSites(orgs).forEach(function (entry) {
      sitesEl.appendChild(makeSiteCard(entry.org, entry.parent));
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

  // --- サイト追加 ---

  /**
   * 本番サイト配下の Client 数。上限（max_sites）はこの数を数え、テストサイト配下の Client は
   * 含めない（サーバの production_site_count と同じ単位。EcAuthDocs#121 項目 3）。
   */
  function productionCount() {
    return organizations.reduce(function (sum, o) {
      return o.is_sandbox ? sum : sum + (o.clients || []).length;
    }, 0);
  }

  /** 本番サイトに Client をこれ以上足せるか（サイト追加の本番と同じ枠を使う）。 */
  function canAddProductionClient() {
    return productionCount() < maxSites;
  }

  /** テストサイトをまだ持たない本番サイト。テストサイトの追加先候補になる。 */
  function sandboxCandidates() {
    var taken = {};
    organizations.forEach(function (o) {
      if (o.is_sandbox && o.parent_organization_id != null) taken[o.parent_organization_id] = true;
    });
    return organizations.filter(function (o) { return !o.is_sandbox && !taken[o.id]; });
  }

  function selectedKind() { return kindSandbox.checked ? 'sandbox' : 'production'; }

  function selectedVersion() {
    var checked = addForm.querySelector('input[name="add_version"]:checked');
    return checked ? checked.value : '4';
  }

  /*
   * 一覧の状態に合わせて、フォームで選べる範囲を絞る。
   *
   * 上限到達もテスト枠の埋まり具合も一覧を数えないと分からないので、送信して 422 を
   * 受け取ってから気づくのではなく、選ぶ前に理由を出す。
   */
  function syncAddForm() {
    var used = productionCount();
    siteUsage.textContent = used + ' / ' + maxSites + ' 件';

    var canAddProduction = used < maxSites;
    var candidates = sandboxCandidates();

    kindProduction.disabled = !canAddProduction;
    kindSandbox.disabled = candidates.length === 0;

    // 選べない種別が選ばれたままだと、送っても必ず弾かれる。選べる方へ寄せる。
    if (kindProduction.checked && !canAddProduction && candidates.length > 0) kindSandbox.checked = true;
    if (kindSandbox.checked && candidates.length === 0 && canAddProduction) kindProduction.checked = true;

    var isSandbox = selectedKind() === 'sandbox';
    addParentField.style.display = isSandbox ? '' : 'none';
    if (isSandbox) {
      var previous = addParent.value;
      addParent.textContent = '';
      candidates.forEach(function (o) {
        var option = document.createElement('option');
        option.value = String(o.id);
        option.textContent = siteLabel(o);
        addParent.appendChild(option);
      });
      // 再描画前に選んでいた本番サイトが候補に残っていれば、選択を維持する。
      var kept = candidates.some(function (o) { return String(o.id) === previous; });
      if (kept) addParent.value = previous;
    }

    var hints = [];
    if (!canAddProduction) {
      hints.push('本番サイトは上限の ' + maxSites + ' 件に達しています。'
        + '不要なサイトを削除するか、サポートにお問い合わせください。');
    }
    if (candidates.length === 0) {
      hints.push(used === 0
        ? 'テストサイトは本番サイトに紐づけて登録します。先に本番サイトを追加してください。'
        : 'すべての本番サイトにテストサイトが登録済みです。'
            + '作り直す場合は既存のテストサイトを削除してから追加してください。');
    }
    addKindHint.textContent = hints.join(' ');

    // どちらの種別も選べない状態では入力させない（送信先が決まらないため）。
    var blocked = !canAddProduction && candidates.length === 0;
    addBtn.disabled = blocked;
    addUrl.disabled = blocked;
  }

  /*
   * サイト URL の検証。backend（OrganizationProvisioningService.ValidateHttpsAndParseSiteUrl）と
   * 条件を揃える: 絶対 URL としてパースでき、スキームが https で、ホストが空でないこと。
   */
  function validSiteUrl(value) {
    try {
      var url = new URL(value);
      return url.protocol === 'https:' && !!url.hostname;
    } catch (e) {
      return false;
    }
  }

  /*
   * 追加エラーの文言。error_description は申込フォームと共用のため、マイページの文脈に
   * 合わないものだけ差し替える。
   */
  // fallback: error_description の無い応答に出す既定文言。サイト追加（新しい Organization）と
  // Client 追加（既存 Organization への追加）で処理種別が違うため、呼び出し側が渡す。
  function addErrorMessage(res, fallback) {
    var data = res.data || {};
    if (res.networkError) {
      return 'ネットワークエラーが発生しました。時間をおいて再度お試しください。';
    }
    // ホストの占有は Client の allowed_rp_ids 単位で判定され、`www.` の有無だけが違う URL も
    // 同じホストとして扱われるため、ここに来る。申込向けの「別のサイト URL でお申し込みください」
    // では原因が読み取れない。
    // 409（並行追加の競合）は「時間をおいて再度」が正しいので差し替えない。
    if (res.status === 422 && data.error === 'organization_already_exists') {
      return 'このドメインは既に別のサイトとして登録されています。'
        + '「www.」の有無だけが違う URL も同じサイトとして扱われます。登録済みのサイトをご確認ください。';
    }
    return descriptionOf(res) || fallback || 'サイトを追加できませんでした。入力内容をご確認ください。';
  }

  [kindProduction, kindSandbox].forEach(function (radio) {
    radio.addEventListener('change', syncAddForm);
  });

  addUrl.addEventListener('input', function () {
    var v = this.value.trim();
    if (v !== '' && validSiteUrl(v)) addUrlField.classList.remove('invalid');
  });

  addForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    App.clearStatus(addStatus);
    App.clearStatus(listStatus);

    var url = addUrl.value.trim();
    var urlOk = url !== '' && validSiteUrl(url);
    addUrlField.classList.toggle('invalid', !urlOk);
    if (!urlOk) return;

    var body = { site_url: url, ec_cube_version: selectedVersion() };
    if (selectedKind() === 'sandbox') {
      if (!addParent.value) {
        App.setStatus(addStatus, 'err', '紐づける本番サイトを選んでください。');
        return;
      }
      body.is_sandbox = true;
      body.parent_organization_id = Number(addParent.value);
    }

    addBtn.disabled = true;
    var original = addBtn.textContent;
    addBtn.textContent = '追加中…';

    var res = await authFetch('POST', '/v1/account/organizations', body);

    addBtn.textContent = original;

    if (res.status === 401) { requireLogin(); return; }

    if (!res.ok) {
      addBtn.disabled = false;
      App.setStatus(addStatus, 'err', addErrorMessage(res));
      // サーバが指摘したフィールドを画面上でも赤くする。
      if (res.data && res.data.field === 'site_url') addUrlField.classList.add('invalid');
      return;
    }

    addUrl.value = '';
    addUrlField.classList.remove('invalid');
    // 上限・親候補・一覧は追加で変わる。再読込して syncAddForm に反映させる
    // （addBtn の disabled もそこで決まる）。
    // 再取得に失敗したときは完了メッセージを書かない。loadSites がフォームごと隠すため
    // 見えない場所に成功状態が残り、次に一覧が復帰したときに古いメッセージが出てしまう。
    // 失敗の理由は loadSites が一覧側に出している。
    if (!(await loadSites())) return;
    App.setStatus(addStatus, 'ok',
      'サイトを追加しました。上の一覧から Client ID / Client Secret を確認し、'
        + 'EC-CUBE プラグインに設定してください。');
  });

  /*
   * サイト一覧を取り直して描画する。
   *
   * 戻り値は「画面が最新の一覧を映しているか」。追加・削除の後に完了メッセージを出す
   * 判断に使う。取得に失敗したときは古いカードを残したままエラーを出すので、呼び出し側が
   * 成否を見ずに完了メッセージを書くと、削除済みのカードが残ったまま「削除しました」と
   * 表示され、エラーの理由まで消える（App.setStatus は className ごと差し替えるため）。
   */
  async function loadSites() {
    var res = await authFetch('GET', '/v1/account/organizations');
    if (res.status === 401) { requireLogin(); return false; }
    if (!res.ok || !res.data) {
      hide(loading); show(appView);
      App.setStatus(listStatus, 'err', 'サイト情報の取得に失敗しました。時間をおいて再度お試しください。');
      // 上限も親候補も分からない状態では、追加しても弾かれるだけなのでフォームは出さない。
      hide(addCard);
      return false;
    }
    hide(loading); show(appView); show(addCard);

    organizations = res.data.organizations || [];
    maxSites = typeof res.data.max_sites === 'number' ? res.data.max_sites : 0;
    renderSites(organizations);
    syncAddForm();
    return true;
  }

  // --- お支払い（EcAuthDocs#119）---

  var BILLING_PATH = '/v1/account/billing';
  var billingCard = App.$('#billing-card');
  var billingNotice = App.$('#billing-notice');
  var billingPayment = App.$('#billing-payment');
  var billingEstimate = App.$('#billing-estimate');
  var billingStatus = App.$('#billing-status');

  /*
   * 請求しない理由（サーバの IBillingService.ExemptReasons）。organization_not_billable は
   * テストサイト・内部用・対象月前に削除したサイトをまとめたものなので、テストサイトだけ
   * 理由を具体的に書く。
   */
  function exemptLabel(reason, org) {
    switch (reason) {
      case 'first_month': return '初月無料';
      case 'organization_not_billable': return org.is_sandbox ? 'テストサイトは無料' : '請求対象外';
      case 'client_exempt':
      case 'account_exempt': return '請求対象外';
      default: return '請求対象外';
    }
  }

  function yen(n) { return Number(n || 0).toLocaleString('ja-JP') + ' 円'; }

  // 日時は JST で出す（請求の月の区切りも JST のため）。
  function jstParts(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var parts = {};
    new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    return parts;
  }
  function jstDate(iso) {
    var p = jstParts(iso);
    return p ? p.year + '/' + p.month + '/' + p.day : '';
  }
  function jstDateTime(iso) {
    var p = jstParts(iso);
    return p ? p.month + '/' + p.day + ' ' + p.hour + ':' + p.minute : '';
  }
  function monthLabel(yearMonth) {
    var m = /^(\d{4})-(\d{2})$/.exec(yearMonth || '');
    return m ? m[1] + ' 年 ' + Number(m[2]) + ' 月' : '当月';
  }

  /*
   * Checkout / Customer Portal の URL を作らせて移る。移る間はボタンを押せないままにする
   * （戻る前に 2 回押すと Checkout Session が 2 つできる）。
   */
  async function goToStripe(btn, path) {
    App.clearStatus(billingStatus);
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '移動中…';

    var res = await authFetch('POST', path);
    if (res.status === 401) { requireLogin(); return; }

    var url = res.ok && res.data && typeof res.data.url === 'string' ? res.data.url : '';
    if (/^https:\/\//.test(url)) {
      window.location.href = url;
      return;
    }

    btn.disabled = false;
    btn.textContent = original;
    // Portal は支払い方法が無いと 409（Webhook の反映前に別タブで外した等）。登録ボタンに戻す。
    if (res.status === 409) {
      renderPayment({ payment_method_registered: false });
      App.setStatus(billingStatus, 'err',
        descriptionOf(res) || '支払い方法が登録されていません。登録してからお試しください。');
      return;
    }
    App.setStatus(billingStatus, 'err', res.networkError
      ? 'ネットワークエラーが発生しました。時間をおいて再度お試しください。'
      : (descriptionOf(res) || 'お支払いの画面を開けませんでした。時間をおいて再度お試しください。'));
  }

  function renderPayment(data) {
    billingPayment.textContent = '';
    var registered = !!data.payment_method_registered;

    var state = el('p', 'bill-state');
    state.appendChild(document.createTextNode('支払い方法: '));
    state.appendChild(el('strong', registered ? 'bill-ok' : 'bill-none', registered ? '登録済み' : '未登録'));
    if (registered && data.payment_method_registered_at) {
      state.appendChild(document.createTextNode('（' + jstDate(data.payment_method_registered_at) + ' 登録）'));
    }
    billingPayment.appendChild(state);

    billingPayment.appendChild(el('p', 'bill-note', registered
      ? 'カードの変更や請求書の確認は、Stripe の画面で行います。'
      : '無料枠を超えた分の利用料は、前月分を毎月初めにご登録のクレジットカードへ請求します。カードの登録は Stripe の画面で行います。'));

    var btn = el('button', registered ? 'btn secondary small' : 'btn primary small',
      registered ? '支払い情報を管理' : '支払い方法を登録');
    btn.type = 'button';
    btn.id = registered ? 'billing-portal-btn' : 'billing-checkout-btn';
    btn.addEventListener('click', function () {
      goToStripe(btn, BILLING_PATH + (registered ? '/portal' : '/checkout'));
    });
    billingPayment.appendChild(btn);
  }

  function makeClientRow(client, org) {
    var tr = document.createElement('tr');
    tr.appendChild(el('td', 'bill-app', client.app_name || client.client_id));
    tr.appendChild(el('td', 'num', String(client.monthly_active_users)));
    tr.appendChild(el('td', 'num', String(client.free_tier_mau)));
    tr.appendChild(el('td', 'num', String(client.billable_units)));
    var amount = el('td', 'num');
    if (client.is_billable) {
      amount.textContent = yen(client.amount_jpy);
    } else {
      amount.appendChild(el('span', 'bill-exempt', exemptLabel(client.exempt_reason, org)));
      // 請求しない Client も、料金表どおりならいくらだったかを参考に見せる。
      if (client.list_price_jpy > 0) {
        amount.appendChild(el('span', 'bill-list', '通常 ' + yen(client.list_price_jpy)));
      }
    }
    tr.appendChild(amount);
    return tr;
  }

  function makeOrgBreakdown(org) {
    var box = el('div', 'bill-org');
    box.setAttribute('data-org-id', String(org.organization_id));

    var head = el('div', 'bill-org-head');
    head.appendChild(el('span', 'obadge ' + (org.is_sandbox ? 'sand' : 'prod'), org.is_sandbox ? 'テスト' : '本番'));
    head.appendChild(el('span', 'ci-code', org.code));
    head.appendChild(el('span', 'bill-amt', yen(org.amount_jpy)));
    box.appendChild(head);

    var table = el('table', 'bill-table');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    [['アプリ', ''], ['MAU', 'num'], ['無料枠', 'num'], ['超過', 'num'], ['金額', 'num']].forEach(function (h) {
      hr.appendChild(el('th', h[1], h[0]));
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    (org.clients || []).forEach(function (c) { tbody.appendChild(makeClientRow(c, org)); });
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  function makeTotalRow(label, value, cls) {
    var row = el('div', 'bill-row' + (cls ? ' ' + cls : ''));
    row.appendChild(el('span', 'bill-label', label));
    row.appendChild(el('span', 'bill-value', value));
    return row;
  }

  function renderEstimate(est) {
    billingEstimate.textContent = '';
    billingEstimate.appendChild(el('h3', 'bill-h', monthLabel(est.year_month) + 'の見込み額'));
    if (est.as_of) {
      billingEstimate.appendChild(el('p', 'bill-note',
        jstDateTime(est.as_of) + ' 時点の利用状況から計算しています。月末までに増えることがあります。'));
    }

    var plan = est.plan || {};
    if (plan.exempt) {
      billingEstimate.appendChild(el('p', 'bill-exempt-all', 'お客様のアカウントは請求対象外のため、利用料はかかりません。'));
      return;
    }

    var totals = el('div', 'bill-totals');
    if (est.discount_jpy > 0) {
      totals.appendChild(makeTotalRow('小計', yen(est.subtotal_jpy)));
      totals.appendChild(makeTotalRow(
        plan.discount_percent ? '割引（' + plan.discount_percent + '%）' : '割引',
        '−' + yen(est.discount_jpy), 'bill-discount'));
    }
    var total = makeTotalRow('合計', yen(est.total_jpy), 'bill-total');
    total.appendChild(el('span', 'bill-tax', '（税抜・別途消費税）'));
    totals.appendChild(total);
    billingEstimate.appendChild(totals);
    billingEstimate.appendChild(el('p', 'bill-note', '金額は税抜です。請求時に消費税（10%）を加えます。'));

    var orgs = est.organizations || [];
    if (orgs.length === 0) return;

    var details = el('details', 'bill-detail');
    details.appendChild(el('summary', null, 'サイト別の内訳'));
    var custom = orgs.some(function (o) {
      return (o.clients || []).some(function (c) { return c.custom_pricing; });
    });
    if (custom) {
      details.appendChild(el('p', 'bill-note', 'お客様向けの個別の料金表で計算しています。'));
    }
    orgs.forEach(function (o) { details.appendChild(makeOrgBreakdown(o)); });
    billingEstimate.appendChild(details);
  }

  /*
   * Checkout から戻った印（?billing=...）を読み取り、URL からは消す。再読み込みや
   * ブックマークで「登録しました」が繰り返し出ないようにするため。
   */
  function takeBillingOutcome() {
    var params = new URLSearchParams(window.location.search);
    var outcome = params.get('billing');
    if (outcome === null) return null;
    params.delete('billing');
    var query = params.toString();
    window.history.replaceState(null, '',
      window.location.pathname + (query ? '?' + query : '') + window.location.hash);
    return outcome;
  }

  /*
   * 一覧とは別に取る。失敗してもサイト一覧の表示は止めない。
   * 404 は課金 API が無効（Billing:Enabled=false）なのでカードごと出さない。
   * Checkout から戻った直後は refresh=1 で Stripe と同期させる（Webhook より先に描画されるため）。
   */
  async function loadBilling(outcome) {
    var path = BILLING_PATH + (outcome === 'setup_complete' ? '?refresh=1' : '');
    var res = await authFetch('GET', path);
    if (res.status === 401) { requireLogin(); return; }
    if (res.status === 404) { hide(billingCard); return; }
    show(billingCard);
    if (!res.ok || !res.data || !res.data.estimate) {
      App.setStatus(billingStatus, 'err', 'お支払い情報の取得に失敗しました。時間をおいて再度お試しください。');
      return;
    }

    renderPayment(res.data);
    renderEstimate(res.data.estimate);

    if (outcome === 'setup_complete') {
      if (res.data.payment_method_registered) {
        App.setStatus(billingNotice, 'ok', '支払い方法を登録しました。');
      } else {
        App.setStatus(billingNotice, 'info',
          '登録の反映に時間がかかっています。しばらくしてからページを再読み込みしてください。');
      }
    } else if (outcome === 'setup_cancelled') {
      App.setStatus(billingNotice, 'info', '支払い方法の登録を取り消しました。');
    }
  }

  // --- 初期化 ---
  (function init() {
    var token = sessionStorage.getItem(AT_KEY);
    if (!token) { requireLogin(); return; }
    var outcome = takeBillingOutcome();
    loadSites();
    loadBilling(outcome);
  })();
})();

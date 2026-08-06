/*
 * マイページ: OAuth2(PKCE) public client。
 * 未認証 → パスキー認証(accounts)へ誘導。認証済 → GET /v1/account/organizations を表示。
 *
 * 画面の単位は Client ではなく **サイト（Organization）**。1 サイト = 1 Organization で、
 * Client はその配下にぶら下がる（申込もマイページからの追加も Client を 1 つ作る）。
 * organizations は各 Organization の clients[] を内包するため一覧はこの 1 本で足り、
 * 加えて「本番 / テストの対応」（parent_organization_id）と「本番の登録上限」（max_sites）を
 * 返す。サイト追加フォームはこの 2 つが無いと選択肢も残枠も出せないので、
 * 旧 GET /v1/account/clients は使わない。
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
    // そのものであり、サイトのドメインから導出されるので実質の識別子になる。
    name.appendChild(el('span', 'ci-code', siteLabel(org)));
    head.appendChild(name);

    var del = el('button', 'icon-btn site-del', '削除');
    del.type = 'button';
    del.setAttribute('aria-expanded', 'false');
    del.setAttribute('aria-label', siteLabel(org) + ' を削除');
    head.appendChild(del);
    item.appendChild(head);

    if (org.name) item.appendChild(el('div', 'ci-owner', org.name));
    if (org.is_sandbox && parent) {
      item.appendChild(el('div', 'ci-parent',
        '本番サイト「' + siteLabel(parent) + '」のテストサイトです。'));
    }

    var clients = org.clients || [];
    clients.forEach(function (client) {
      var block = el('div', 'ci-client');
      // 通常は 1 サイト 1 Client。複数ある場合だけ、どの Client の設定かを見出しで示す。
      if (clients.length > 1) block.appendChild(el('div', 'ci-client-name', client.app_name || client.client_id));
      block.appendChild(makeCodeRow('Client ID', client.client_id));
      block.appendChild(makeSecretRow(client));
      SECTIONS.forEach(function (s) { block.appendChild(makeSettingsSection(client, s)); });
      item.appendChild(block);
    });

    var deleteConfirm = makeDeleteConfirm(org, del);
    item.appendChild(deleteConfirm.box);
    closers.push(deleteConfirm.close);

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

  /** 本番サイトの登録数。上限（max_sites）はこの数だけを数え、テストサイトは含めない。 */
  function productionCount() {
    return organizations.filter(function (o) { return !o.is_sandbox; }).length;
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
  function addErrorMessage(res) {
    var data = res.data || {};
    if (res.networkError) {
      return 'ネットワークエラーが発生しました。時間をおいて再度お試しください。';
    }
    // 導出後の組織コードが既存サイトと同じになるケース（`www.` の有無だけが違う URL など）も
    // ここに来る。申込向けの「別のサイト URL でお申し込みください」では原因が読み取れない。
    // 409（並行追加の競合）は「時間をおいて再度」が正しいので差し替えない。
    if (res.status === 422 && data.error === 'organization_already_exists') {
      return 'このドメインは既に別のサイトとして登録されています。'
        + '「www.」の有無だけが違う URL も同じサイトとして扱われます。登録済みのサイトをご確認ください。';
    }
    return descriptionOf(res) || 'サイトを追加できませんでした。入力内容をご確認ください。';
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

  // --- 初期化 ---
  (function init() {
    var token = sessionStorage.getItem(AT_KEY);
    if (!token) { requireLogin(); return; }
    loadSites();
  })();
})();

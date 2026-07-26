/*
 * app.js — 申込フォーム / マイページ共通ヘルパー。
 * window.ECAUTH.apiBaseUrl（baseof.html が hugo.toml の apiBaseUrl を注入）を使う。
 */
(function (global) {
  'use strict';

  var apiBaseUrl = (global.ECAUTH && global.ECAUTH.apiBaseUrl) || '';

  function api(path) {
    return apiBaseUrl.replace(/\/$/, '') + path;
  }

  // JSON を POST し、{ ok, status, data } を返す（例外は投げず結果で表現）
  async function postJson(path, body) {
    try {
      var res = await fetch(api(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body || {})
      });
      var data = null;
      try { data = await res.json(); } catch (e) { /* 空ボディ許容 */ }
      return { ok: res.ok, status: res.status, data: data };
    } catch (e) {
      return { ok: false, status: 0, data: null, networkError: true };
    }
  }

  function $(sel, root) { return (root || document).querySelector(sel); }

  // 常に textContent で描画する（XSS 回避）。サーバ由来の文字列を渡しても安全。
  function setStatus(el, type, text) {
    if (!el) return;
    el.className = 'status show ' + type;
    el.textContent = text;
  }
  // リンクやボタンを含むリッチなステータスが必要な場合に DOM ノードを差し込む。
  function setStatusNode(el, type, node) {
    if (!el) return;
    el.className = 'status show ' + type;
    el.textContent = '';
    el.appendChild(node);
  }
  function clearStatus(el) { if (el) el.className = 'status'; }

  function validEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || '').trim());
  }

  // URL クエリからトークンを取得（パスには載せない運用のためクエリのみ）
  function queryParam(name) {
    return new URLSearchParams(global.location.search).get(name);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
  }

  global.EcAuthApp = {
    api: api,
    postJson: postJson,
    $: $,
    setStatus: setStatus,
    setStatusNode: setStatusNode,
    clearStatus: clearStatus,
    validEmail: validEmail,
    queryParam: queryParam,
    copyText: copyText
  };
})(window);

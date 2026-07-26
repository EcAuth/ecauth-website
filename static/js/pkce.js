/*
 * pkce.js — PKCE (RFC 7636 / S256) の code_verifier / code_challenge 生成。
 * Web Crypto (crypto.subtle) を使用。HTTPS/localhost でのみ利用可。
 */
(function (global) {
  'use strict';

  function base64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 43〜128 文字の code_verifier（32バイト乱数 → base64url = 43文字）
  function createVerifier() {
    var random = new Uint8Array(32);
    crypto.getRandomValues(random);
    return base64url(random);
  }

  async function challengeFromVerifier(verifier) {
    var data = new TextEncoder().encode(verifier);
    var digest = await crypto.subtle.digest('SHA-256', data);
    return base64url(new Uint8Array(digest));
  }

  async function create() {
    var verifier = createVerifier();
    var challenge = await challengeFromVerifier(verifier);
    return { verifier: verifier, challenge: challenge, method: 'S256' };
  }

  global.EcAuthPkce = { create: create };
})(window);

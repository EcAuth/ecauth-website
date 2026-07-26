/* 申込フォーム: POST {apiBaseUrl}/api/signup/request */
(function () {
  'use strict';
  var App = window.EcAuthApp;
  var form = App.$('#signup-form');
  var statusEl = App.$('#status');
  var btn = App.$('#submit-btn');
  if (!form) return;

  var fEmail = App.$('#f-email'), fOrg = App.$('#f-org'), fContact = App.$('#f-contact');
  var fProd = App.$('#f-prod'), fTest = App.$('#f-test'), fSiteRequired = App.$('#f-site-required');
  var fVersion = App.$('#f-version');

  function val(sel) { return App.$(sel).value.trim(); }

  /*
   * サイト URL の検証。backend（SignupService.ValidateHttpsAndGetHost）と条件を揃える:
   * 絶対 URL としてパースでき、スキームが https で、ホストが空でないこと。
   * 組織コードはこのホスト名から導出されるため、http や相対 URL は受け付けられない。
   */
  function validSiteUrl(value) {
    if (!value) return true; // 空欄は「未入力」であり形式エラーではない（必須判定は別で行う）
    try {
      var url = new URL(value);
      return url.protocol === 'https:' && !!url.hostname;
    } catch (e) {
      return false;
    }
  }

  function selectedVersion() {
    var checked = form.querySelector('input[name="ec_cube_version"]:checked');
    return checked ? checked.value : '';
  }

  function validate() {
    var emailOk = App.validEmail(App.$('#email').value);
    // backend（ValidateOrganizationName）は 1〜100 文字を必須とする。
    var org = val('#org');
    var orgOk = org.length >= 1 && org.length <= 100;
    var contactOk = val('#contact') !== '';
    var prod = val('#prod'), test = val('#test');
    var prodOk = validSiteUrl(prod);
    var testOk = validSiteUrl(test);
    // backend（ValidateSiteUrls）は本番・テストのいずれか一方を必須とする。
    var siteRequiredOk = prod !== '' || test !== '';

    fEmail.classList.toggle('invalid', !emailOk);
    fOrg.classList.toggle('invalid', !orgOk);
    fContact.classList.toggle('invalid', !contactOk);
    fProd.classList.toggle('invalid', !prodOk);
    fTest.classList.toggle('invalid', !testOk);
    // 「いずれか必須」は形式エラーが無いときだけ出す（同時に出すと原因が分かりにくい）。
    fSiteRequired.classList.toggle('invalid', prodOk && testOk && !siteRequiredOk);

    return emailOk && orgOk && contactOk && prodOk && testOk && siteRequiredOk;
  }

  App.$('#email').addEventListener('input', function () {
    if (App.validEmail(this.value)) fEmail.classList.remove('invalid');
  });
  App.$('#org').addEventListener('input', function () {
    var v = this.value.trim();
    if (v.length >= 1 && v.length <= 100) fOrg.classList.remove('invalid');
  });
  App.$('#contact').addEventListener('input', function () {
    if (this.value.trim()) fContact.classList.remove('invalid');
  });
  App.$('#prod').addEventListener('input', function () {
    if (validSiteUrl(this.value.trim())) fProd.classList.remove('invalid');
    if (this.value.trim()) fSiteRequired.classList.remove('invalid');
  });
  App.$('#test').addEventListener('input', function () {
    if (validSiteUrl(this.value.trim())) fTest.classList.remove('invalid');
    if (this.value.trim()) fSiteRequired.classList.remove('invalid');
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    App.clearStatus(statusEl);
    if (!validate()) return;

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '送信中…';

    // 未入力の URL は空文字で送る（backend の NormalizeOptionalUrl が null 扱いする）。
    var res = await App.postJson('/api/signup/request', {
      email: val('#email'),
      organization_name: val('#org'),
      contact_name: val('#contact'),
      production_site_url: val('#prod'),
      test_site_url: val('#test'),
      ec_cube_version: selectedVersion()
    });

    btn.textContent = original;

    if (res.networkError) {
      btn.disabled = false;
      App.setStatus(statusEl, 'err', 'ネットワークエラーが発生しました。時間をおいて再度お試しください。');
      return;
    }

    if (res.status === 202 || res.ok) {
      form.reset();
      App.setStatus(statusEl, 'ok',
        '確認メールを送信しました。メール内のリンクから登録を完了してください。（メールが届かない場合は迷惑メールフォルダもご確認ください）');
      return;
    }

    // エラー: サーバの error_description を textContent で安全表示
    btn.disabled = false;
    var d = res.data || {};
    var msg = d.error_description || '送信に失敗しました。入力内容をご確認ください。';
    if (res.status === 409) msg = d.error_description || 'このメールアドレスは既に登録されています。';
    App.setStatus(statusEl, 'err', msg);
    // サーバが指摘したフィールドを画面上でも赤くする（error_description だけでは
    // どの入力欄の問題か分からないため）。backend（SignupService）が field に返しうるのは
    // email / organization_name / production_site_url / test_site_url / ec_cube_version
    // の 5 つ（contact_name は返さない）。
    var fieldMap = {
      email: fEmail,
      organization_name: fOrg,
      production_site_url: fProd,
      test_site_url: fTest,
      ec_cube_version: fVersion
    };
    if (fieldMap[d.field]) fieldMap[d.field].classList.add('invalid');
  });
})();

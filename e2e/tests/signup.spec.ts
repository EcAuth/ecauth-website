import { test, expect, Page } from '@playwright/test';
import { ApiMock, installApiMock } from './helpers/mock';

/**
 * 申込フォーム（/signup/ → POST {apiBaseUrl}/api/signup/request）。
 *
 * 検証対象は static/js/signup.js。バックエンドは横取りしてスタブする。
 *
 * backend（SignupService.RequestAsync）の必須条件と揃っていることが要:
 *   - production_site_url / test_site_url のいずれか一方は必須
 *   - サイト URL は https:// の絶対 URL（組織コードをホスト名から導出するため）
 *   - ec_cube_version は "2" / "4" / "other"
 * ここがずれるとフォームは常に 422 になるため、送信ボディを明示的に固定する。
 */
const PATH = '/api/signup/request';

/** 必須項目を最小限だけ埋めるヘルパ（各テストの主眼以外をノイズにしないため）。 */
async function fillRequired(
  page: Page,
  overrides: Partial<Record<'email' | 'org' | 'contact' | 'prod', string>> = {}
) {
  await page.fill('#email', overrides.email ?? 'user@example.com');
  await page.fill('#org', overrides.org ?? 'サンプル株式会社');
  await page.fill('#contact', overrides.contact ?? '山田 太郎');
  await page.fill('#prod', overrides.prod ?? 'https://shop.example.com');
}

let mock: ApiMock;

test.beforeEach(async ({ page }) => {
  mock = await installApiMock(page);
});

test.afterEach(async () => {
  // 想定外のエンドポイントを叩いていないこと（配線ミスの早期検出）。
  expect(mock.unhandled).toEqual([]);
});

test('必須項目が空なら API を呼ばずにバリデーションエラーを表示する', async ({ page }) => {
  await page.goto('/signup/');

  await page.click('#submit-btn');

  await expect(page.locator('#f-email')).toHaveClass(/invalid/);
  await expect(page.locator('#f-org')).toHaveClass(/invalid/);
  await expect(page.locator('#f-contact')).toHaveClass(/invalid/);
  // .field.invalid .err-msg が display:block になる
  await expect(page.locator('#email-err')).toBeVisible();
  await expect(page.locator('#org-err')).toBeVisible();
  await expect(page.locator('#contact-err')).toBeVisible();
  expect(mock.countTo(PATH)).toBe(0);
});

test('メール形式が不正なら API を呼ばず、修正すると invalid が外れる', async ({ page }) => {
  await page.goto('/signup/');

  await fillRequired(page, { email: 'not-an-email' });
  await page.click('#submit-btn');

  await expect(page.locator('#f-email')).toHaveClass(/invalid/);
  await expect(page.locator('#f-contact')).not.toHaveClass(/invalid/);
  expect(mock.countTo(PATH)).toBe(0);

  await page.fill('#email', 'user@example.com');
  await expect(page.locator('#f-email')).not.toHaveClass(/invalid/);
});

test('サイト URL が両方とも空なら API を呼ばず「いずれか必須」を表示する', async ({ page }) => {
  await page.goto('/signup/');

  // サイト URL を意図的に両方とも空のままにする（fillRequired は #prod を埋めるので使わない）。
  await page.fill('#email', 'user@example.com');
  await page.fill('#org', 'サンプル株式会社');
  await page.fill('#contact', '山田 太郎');
  await page.click('#submit-btn');

  await expect(page.locator('#site-required-err')).toBeVisible();
  await expect(page.locator('#f-prod')).not.toHaveClass(/invalid/);
  await expect(page.locator('#f-test')).not.toHaveClass(/invalid/);
  expect(mock.countTo(PATH)).toBe(0);

  // どちらかを入力すれば解消する
  await page.fill('#test', 'https://test.example.com');
  await expect(page.locator('#site-required-err')).toBeHidden();
});

test('テストサイト URL だけでも申し込める（本番未構築のケース）', async ({ page }) => {
  mock.on(PATH, { status: 202, body: { message: 'ok' } });

  await page.goto('/signup/');
  await page.fill('#email', 'user@example.com');
  await page.fill('#org', 'サンプル株式会社');
  await page.fill('#contact', '山田 太郎');
  await page.fill('#test', 'https://test.example.com');
  await page.click('#submit-btn');

  await expect(page.locator('#status')).toHaveClass(/ok/);
  expect(mock.lastCallTo(PATH)?.json).toMatchObject({
    production_site_url: '',
    test_site_url: 'https://test.example.com',
  });
});

test('https:// でないサイト URL は API を呼ばずに弾く', async ({ page }) => {
  await page.goto('/signup/');

  await fillRequired(page, { prod: 'http://shop.example.com' });
  await page.click('#submit-btn');

  await expect(page.locator('#f-prod')).toHaveClass(/invalid/);
  await expect(page.locator('#prod-err')).toBeVisible();
  expect(mock.countTo(PATH)).toBe(0);

  // https に直せば invalid が外れる
  await page.fill('#prod', 'https://shop.example.com');
  await expect(page.locator('#f-prod')).not.toHaveClass(/invalid/);
});

test('URL として解釈できない文字列も弾く', async ({ page }) => {
  await page.goto('/signup/');

  await fillRequired(page, { prod: 'shop.example.com' });
  await page.click('#submit-btn');

  await expect(page.locator('#f-prod')).toHaveClass(/invalid/);
  expect(mock.countTo(PATH)).toBe(0);
});

test('テストサイト URL の形式エラーも独立して弾く', async ({ page }) => {
  await page.goto('/signup/');

  await fillRequired(page);
  await page.fill('#test', 'ftp://test.example.com');
  await page.click('#submit-btn');

  await expect(page.locator('#f-test')).toHaveClass(/invalid/);
  await expect(page.locator('#f-prod')).not.toHaveClass(/invalid/);
  expect(mock.countTo(PATH)).toBe(0);
});

test('202 で完了メッセージを表示し、フォームをリセットする', async ({ page }) => {
  mock.on(PATH, { status: 202, body: { message: '受け付けました' } });

  await page.goto('/signup/');
  await page.fill('#email', 'user@example.com');
  await page.fill('#org', 'サンプル株式会社');
  await page.fill('#contact', '山田 太郎');
  await page.fill('#prod', 'https://shop.example.com');
  await page.fill('#test', 'https://test.example.com');
  await page.click('#submit-btn');

  const status = page.locator('#status');
  await expect(status).toHaveClass(/ok/);
  await expect(status).toContainText('確認メールを送信しました');

  // 送信ボディが API 契約（snake_case）どおりであること
  expect(mock.lastCallTo(PATH)?.json).toEqual({
    email: 'user@example.com',
    organization_name: 'サンプル株式会社',
    contact_name: '山田 太郎',
    production_site_url: 'https://shop.example.com',
    test_site_url: 'https://test.example.com',
    ec_cube_version: '4',
  });

  // 二重送信を防ぐためボタンは無効のまま、入力はクリアされる
  await expect(page.locator('#submit-btn')).toBeDisabled();
  await expect(page.locator('#email')).toHaveValue('');
  await expect(page.locator('#org')).toHaveValue('');
  await expect(page.locator('#contact')).toHaveValue('');
  await expect(page.locator('#prod')).toHaveValue('');
  await expect(page.locator('#test')).toHaveValue('');
});

test('EC-CUBE バージョンは既定が 4 系で、選択すると送信値が変わる', async ({ page }) => {
  mock.on(PATH, { status: 202, body: { message: 'ok' } });

  await page.goto('/signup/');
  await expect(page.locator('input[name="ec_cube_version"][value="4"]')).toBeChecked();

  await fillRequired(page);
  await page.locator('input[name="ec_cube_version"][value="2"]').check();
  await page.click('#submit-btn');

  await expect(page.locator('#status')).toHaveClass(/ok/);
  // backend の ValidateEcCubeVersion が受理する値（"2" / "4" / "other"）であること
  expect(mock.lastCallTo(PATH)?.json?.ec_cube_version).toBe('2');
});

test('組織名が空なら API を呼ばない（backend が 1〜100 文字を必須とする）', async ({ page }) => {
  await page.goto('/signup/');

  await fillRequired(page, { org: '' });
  await page.click('#submit-btn');

  await expect(page.locator('#f-org')).toHaveClass(/invalid/);
  await expect(page.locator('#org-err')).toBeVisible();
  expect(mock.countTo(PATH)).toBe(0);

  // 入力すれば invalid が外れる
  await page.fill('#org', 'サンプル株式会社');
  await expect(page.locator('#f-org')).not.toHaveClass(/invalid/);
});

test('組織名が 100 文字を超えるなら API を呼ばない', async ({ page }) => {
  await page.goto('/signup/');

  // maxlength=100 を JS で回避して送られるケースを想定し、JS 側でも上限を検証する。
  await fillRequired(page);
  await page.locator('#org').evaluate((el, v) => {
    (el as HTMLInputElement).value = v;
  }, 'あ'.repeat(101));
  await page.click('#submit-btn');

  await expect(page.locator('#f-org')).toHaveClass(/invalid/);
  expect(mock.countTo(PATH)).toBe(0);
});

test('サーバが指摘したフィールドを画面上でも赤くする', async ({ page }) => {
  mock.on(PATH, {
    status: 409,
    body: {
      error: 'organization_already_exists',
      error_description: 'このドメインは既に EcAuth に登録されています。',
      field: 'production_site_url',
    },
  });

  await page.goto('/signup/');
  await fillRequired(page);
  await page.click('#submit-btn');

  await expect(page.locator('#status')).toHaveClass(/err/);
  await expect(page.locator('#f-prod')).toHaveClass(/invalid/);
  await expect(page.locator('#f-test')).not.toHaveClass(/invalid/);
});

// backend（SignupService）が field に返しうる値と、対応する入力欄の対応表。
// 対応漏れがあると「エラーは出るがどの欄か分からない」状態になる。
const FIELD_TO_INPUT: Array<[string, string]> = [
  ['email', '#f-email'],
  ['organization_name', '#f-org'],
  ['production_site_url', '#f-prod'],
  ['test_site_url', '#f-test'],
  ['ec_cube_version', '#f-version'],
];

for (const [field, selector] of FIELD_TO_INPUT) {
  test(`サーバの field="${field}" が ${selector} に反映される`, async ({ page }) => {
    mock.on(PATH, {
      status: 422,
      body: { error: 'invalid_request', error_description: 'エラーです。', field },
    });

    await page.goto('/signup/');
    await fillRequired(page);
    await page.click('#submit-btn');

    await expect(page.locator('#status')).toHaveClass(/err/);
    await expect(page.locator(selector)).toHaveClass(/invalid/);
  });
}

test('未知の field が返ってもエラー表示は壊れない', async ({ page }) => {
  mock.on(PATH, {
    status: 422,
    body: { error: 'invalid_request', error_description: '不明なエラーです。', field: 'contact_name' },
  });

  await page.goto('/signup/');
  await fillRequired(page);
  await page.click('#submit-btn');

  await expect(page.locator('#status')).toHaveText('不明なエラーです。');
});

test('409 はサーバの error_description をそのまま表示し、再送信できる状態に戻す', async ({ page }) => {
  mock.on(PATH, {
    status: 409,
    body: { error: 'conflict', error_description: 'このメールアドレスは既にご利用中です。', field: 'email' },
  });

  await page.goto('/signup/');
  await fillRequired(page, { email: 'dup@example.com' });
  await page.click('#submit-btn');

  const status = page.locator('#status');
  await expect(status).toHaveClass(/err/);
  await expect(status).toHaveText('このメールアドレスは既にご利用中です。');
  await expect(page.locator('#submit-btn')).toBeEnabled();
  await expect(page.locator('#submit-btn')).toHaveText('申し込む');
});

test('422 はサーバのエラー文言を表示する', async ({ page }) => {
  mock.on(PATH, {
    status: 422,
    body: { error: 'invalid_request', error_description: 'メールアドレスの形式が正しくありません。', field: 'email' },
  });

  await page.goto('/signup/');
  await fillRequired(page);
  await page.click('#submit-btn');

  await expect(page.locator('#status')).toHaveText('メールアドレスの形式が正しくありません。');
  await expect(page.locator('#submit-btn')).toBeEnabled();
});

test('error_description が無いエラーでも既定文言でフォールバックする', async ({ page }) => {
  mock.on(PATH, { status: 500, body: {} });

  await page.goto('/signup/');
  await fillRequired(page);
  await page.click('#submit-btn');

  await expect(page.locator('#status')).toHaveText('送信に失敗しました。入力内容をご確認ください。');
});

test('ネットワーク断はネットワークエラーとして案内し、再送信できる状態に戻す', async ({ page }) => {
  mock.on(PATH, { abort: 'failed' });

  await page.goto('/signup/');
  await fillRequired(page);
  await page.click('#submit-btn');

  const status = page.locator('#status');
  await expect(status).toHaveClass(/err/);
  await expect(status).toHaveText('ネットワークエラーが発生しました。時間をおいて再度お試しください。');
  await expect(page.locator('#submit-btn')).toBeEnabled();
});

test('error_description に HTML が含まれてもテキストとして描画する（XSS 回避）', async ({ page }) => {
  const payload = '<img src=x onerror="window.__xss=1">失敗しました';
  mock.on(PATH, { status: 422, body: { error: 'invalid_request', error_description: payload } });

  await page.goto('/signup/');
  await fillRequired(page);
  await page.click('#submit-btn');

  const status = page.locator('#status');
  await expect(status).toHaveText(payload);
  // textContent 描画なので要素にはならない
  expect(await status.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

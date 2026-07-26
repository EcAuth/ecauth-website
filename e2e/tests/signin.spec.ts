import { test, expect } from '@playwright/test';
import { ApiMock, installApiMock } from './helpers/mock';

/**
 * リカバリ導線（/signin/ → POST {apiBaseUrl}/api/account/magic-link/request）。
 *
 * 検証対象は static/js/signin.js。この画面の要点は
 * **email enumeration 対策として、結果に依らず常に同一文言を返すこと**。
 * 「登録されていません」等の分岐を後から足すと対策が壊れるため、テストで固定する。
 */
const PATH = '/api/account/magic-link/request';
const SAME_MESSAGE =
  'ご入力のメールアドレスが登録されている場合、ログイン用リンクを送信しました。メールをご確認ください。';
const CLIENTS_PATH = '/v1/account/clients';

let mock: ApiMock;

test.beforeEach(async ({ page }) => {
  mock = await installApiMock(page);
});

test.afterEach(async () => {
  expect(mock.unhandled).toEqual([]);
});

test('メール形式が不正なら API を呼ばない', async ({ page }) => {
  await page.goto('/signin/');

  await page.fill('#email', 'not-an-email');
  await page.click('#submit-btn');

  await expect(page.locator('#f-email')).toHaveClass(/invalid/);
  await expect(page.locator('#email-err')).toBeVisible();
  expect(mock.countTo(PATH)).toBe(0);
});

test('要求が受理されると同一文言を表示し、フォームをリセットする', async ({ page }) => {
  mock.on(PATH, { status: 200, body: { message: 'accepted' } });

  await page.goto('/signin/');
  await page.fill('#email', 'user@example.com');
  await page.click('#submit-btn');

  const status = page.locator('#status');
  await expect(status).toHaveClass(/ok/);
  await expect(status).toHaveText(SAME_MESSAGE);
  expect(mock.lastCallTo(PATH)?.json).toEqual({ email: 'user@example.com' });
  await expect(page.locator('#email')).toHaveValue('');
  // 再要求できるようボタンは戻す
  await expect(page.locator('#submit-btn')).toBeEnabled();
});

test('未登録メール（404）でも同一文言を返す（enumeration 対策）', async ({ page }) => {
  mock.on(PATH, { status: 404, body: { error: 'not_found', error_description: 'アカウントが存在しません。' } });

  await page.goto('/signin/');
  await page.fill('#email', 'unknown@example.com');
  await page.click('#submit-btn');

  const status = page.locator('#status');
  await expect(status).toHaveClass(/ok/);
  await expect(status).toHaveText(SAME_MESSAGE);
  // サーバの文言が漏れないこと
  await expect(status).not.toContainText('アカウントが存在しません');
});

test('レート制限（429）でも同一文言を返す（enumeration 対策）', async ({ page }) => {
  mock.on(PATH, { status: 429, body: { error: 'too_many_requests', error_description: '短時間に複数回要求されました。' } });

  await page.goto('/signin/');
  await page.fill('#email', 'user@example.com');
  await page.click('#submit-btn');

  const status = page.locator('#status');
  await expect(status).toHaveClass(/ok/);
  await expect(status).toHaveText(SAME_MESSAGE);
});

test('ネットワーク断のときだけエラーとして案内する', async ({ page }) => {
  mock.on(PATH, { abort: 'failed' });

  await page.goto('/signin/');
  await page.fill('#email', 'user@example.com');
  await page.click('#submit-btn');

  const status = page.locator('#status');
  await expect(status).toHaveClass(/err/);
  await expect(status).toHaveText('ネットワークエラーが発生しました。時間をおいて再度お試しください。');
});

test('「パスキーでログイン」はマイページへ戻す', async ({ page }) => {
  // 遷移先の /mypage/ は未認証状態（トークン未保存）なので API は呼ばれない。
  mock.on(CLIENTS_PATH, { status: 200, body: { clients: [] } });

  await page.goto('/signin/');
  await page.click('#passkey-login-link');

  await page.waitForURL('**/mypage/');
  await expect(page.locator('#login-view')).toBeVisible();
  expect(mock.countTo(CLIENTS_PATH)).toBe(0);
});

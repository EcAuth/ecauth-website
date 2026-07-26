import { test, expect } from '@playwright/test';
import { ADMIN_CLIENT_ID, API_BASE, ApiMock, installApiMock, stubAccountsPages } from './helpers/mock';

/**
 * 申込確認（/signup/confirm/?token= → POST {apiBaseUrl}/api/signup/confirm）。
 *
 * 検証対象は static/js/signup-confirm.js。とくに
 *   - トークンは GET では消費せず、ユーザー操作で POST すること（プリフェッチ誤消費の防止）
 *   - 登録トークンを accounts のパスキー登録ページへ **フラグメントで** 引き継ぐこと
 * を固定する。
 */
const PATH = '/api/signup/confirm';
const TOKEN = 'confirm-token-abcdef0123456789';

let mock: ApiMock;

test.beforeEach(async ({ page }) => {
  mock = await installApiMock(page);
  await stubAccountsPages(page);
});

test.afterEach(async () => {
  expect(mock.unhandled).toEqual([]);
});

test('token が無い URL ではボタンを無効化して案内する', async ({ page }) => {
  await page.goto('/signup/confirm/');

  await expect(page.locator('#status')).toHaveClass(/err/);
  await expect(page.locator('#status')).toContainText('URL が正しくありません');
  await expect(page.locator('#confirm-btn')).toBeDisabled();
  expect(mock.countTo(PATH)).toBe(0);
});

test('ページを開いただけではトークンを消費しない（ユーザー操作で初めて POST する）', async ({ page }) => {
  mock.on(PATH, { status: 200, body: { message: '申込を確定しました。', email: 'user@example.com', registration_token: 'reg-token' } });

  await page.goto(`/signup/confirm/?token=${TOKEN}`);
  await expect(page.locator('#confirm-btn')).toBeEnabled();
  expect(mock.countTo(PATH)).toBe(0);

  await page.click('#confirm-btn');
  await expect(page.locator('#status')).toHaveClass(/ok/);
  expect(mock.countTo(PATH)).toBe(1);
  expect(mock.lastCallTo(PATH)?.json).toEqual({ token: TOKEN });
});

test('確定に成功するとパスキー登録の導線を表示する', async ({ page }) => {
  mock.on(PATH, {
    status: 200,
    body: { message: '申込を確定しました。', email: 'user@example.com', registration_token: 'reg-token' },
  });

  await page.goto(`/signup/confirm/?token=${TOKEN}`);
  await expect(page.locator('#next-step')).toBeHidden();

  await page.click('#confirm-btn');

  const status = page.locator('#status');
  await expect(status).toHaveClass(/ok/);
  await expect(status).toHaveText('申込を確定しました。（user@example.com）');
  // 二重確定を防ぐため確定ボタンは消える
  await expect(page.locator('#confirm-btn')).toBeHidden();
  await expect(page.locator('#next-step')).toBeVisible();
  await expect(page.locator('#passkey-btn')).toBeVisible();
});

test('パスキー登録は accounts オリジンへ遷移し、登録トークンをフラグメントで渡す', async ({ page }) => {
  mock.on(PATH, {
    status: 200,
    body: { message: '申込を確定しました。', email: 'user@example.com', registration_token: 'reg-token-xyz' },
  });

  await page.goto(`/signup/confirm/?token=${TOKEN}`);
  await page.click('#confirm-btn');
  await expect(page.locator('#next-step')).toBeVisible();

  await page.click('#passkey-btn');
  await page.waitForURL(/\/passkey\/register/);

  const url = new URL(page.url());
  expect(url.origin).toBe(API_BASE);
  expect(url.pathname).toBe('/passkey/register');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: ADMIN_CLIENT_ID,
    email: 'user@example.com',
  });

  // 登録トークンはフラグメントにのみ載る（サーバへ送信されず、アクセスログ / Referer に残らない）。
  expect(new URLSearchParams(url.hash.replace(/^#/, '')).get('token')).toBe('reg-token-xyz');
  expect(url.search).not.toContain('reg-token-xyz');
});

test('registration_token が返らなければ登録へ進ませずエラーにする', async ({ page }) => {
  mock.on(PATH, { status: 200, body: { message: '申込を確定しました。', email: 'user@example.com' } });

  await page.goto(`/signup/confirm/?token=${TOKEN}`);
  await page.click('#confirm-btn');

  await expect(page.locator('#status')).toHaveClass(/err/);
  await expect(page.locator('#status')).toContainText('登録トークンを取得できませんでした');
  await expect(page.locator('#next-step')).toBeHidden();
});

test('期限切れ / 使用済みトークンはエラー表示のうえ再試行できる状態に戻す', async ({ page }) => {
  mock.on(PATH, {
    status: 400,
    body: { error: 'invalid_token', error_description: 'このリンクは既に使用されています。' },
  });

  await page.goto(`/signup/confirm/?token=${TOKEN}`);
  await page.click('#confirm-btn');

  await expect(page.locator('#status')).toHaveClass(/err/);
  await expect(page.locator('#status')).toHaveText('このリンクは既に使用されています。');
  await expect(page.locator('#confirm-btn')).toBeEnabled();
  await expect(page.locator('#next-step')).toBeHidden();
});

test('ネットワーク断は再試行できる状態に戻す', async ({ page }) => {
  mock.on(PATH, { abort: 'failed' });

  await page.goto(`/signup/confirm/?token=${TOKEN}`);
  await page.click('#confirm-btn');

  await expect(page.locator('#status')).toHaveText('ネットワークエラーが発生しました。時間をおいて再度お試しください。');
  await expect(page.locator('#confirm-btn')).toBeEnabled();
});

import { test, expect } from '@playwright/test';
import { AT_KEY, ApiMock, installApiMock, readSession } from './helpers/mock';

/**
 * マジックリンク着地（/signin/magic-link/?token= → POST {apiBaseUrl}/api/account/magic-link/verify）。
 *
 * 検証対象は static/js/signin-magic-link.js。
 * verify は認可コードではなく **アクセストークンを直接返す**（管理コンソールは public client で
 * /v1/token が PKCE 必須だが、マジックリンクはメール往復のため verifier を保持できない）。
 * したがってこの経路は /auth/callback を経由せず、受け取ったトークンを
 * マイページと同じ sessionStorage キーに置いて遷移する。
 */
const PATH = '/api/account/magic-link/verify';
const CLIENTS_PATH = '/v1/account/clients';
const TOKEN = 'magic-token-abcdef0123456789';

let mock: ApiMock;

test.beforeEach(async ({ page }) => {
  mock = await installApiMock(page);
  // 成功時は /mypage/ へ遷移し、マイページが一覧を取りにいく。
  mock.on(CLIENTS_PATH, { status: 200, body: { clients: [] } });
});

test.afterEach(async () => {
  expect(mock.unhandled).toEqual([]);
});

test('token が無い URL ではボタンを無効化して案内する', async ({ page }) => {
  await page.goto('/signin/magic-link/');

  await expect(page.locator('#status')).toHaveClass(/err/);
  await expect(page.locator('#status')).toContainText('URL が正しくありません');
  await expect(page.locator('#login-btn')).toBeDisabled();
  expect(mock.countTo(PATH)).toBe(0);
});

test('ページを開いただけではトークンを消費しない', async ({ page }) => {
  mock.on(PATH, { status: 200, body: { access_token: 'at-1', token_type: 'Bearer', expires_in: 3600 } });

  await page.goto(`/signin/magic-link/?token=${TOKEN}`);
  await expect(page.locator('#login-btn')).toBeEnabled();
  expect(mock.countTo(PATH)).toBe(0);
});

test('verify が返したアクセストークンを保存してマイページへ遷移する', async ({ page }) => {
  mock.on(PATH, {
    status: 200,
    body: { access_token: 'at-from-magic-link', id_token: 'id-token', token_type: 'Bearer', expires_in: 3600 },
  });

  await page.goto(`/signin/magic-link/?token=${TOKEN}`);
  await page.click('#login-btn');

  await page.waitForURL('**/mypage/');
  expect(mock.lastCallTo(PATH)?.json).toEqual({ token: TOKEN });
  // マイページと同じキーに置く（/auth/callback 経由と等価な状態にする）
  expect(await readSession(page, AT_KEY)).toBe('at-from-magic-link');
  // 認証済みとして扱われ、一覧取得が走る
  await expect(page.locator('#app-view')).toBeVisible();
  expect(mock.countTo(CLIENTS_PATH)).toBe(1);
});

test('遷移は replace で行い、消費済みトークンの URL に戻れないようにする', async ({ page }) => {
  mock.on(PATH, { status: 200, body: { access_token: 'at-1', token_type: 'Bearer', expires_in: 3600 } });

  await page.goto('/signin/');
  await page.goto(`/signin/magic-link/?token=${TOKEN}`);
  await page.click('#login-btn');
  await page.waitForURL('**/mypage/');

  // location.replace のため、戻ると magic-link ページではなく その前のページに戻る
  await page.goBack();
  await expect(page).toHaveURL(/\/signin\/$/);
});

test('access_token が返らなければログイン扱いにしない', async ({ page }) => {
  mock.on(PATH, { status: 200, body: { token_type: 'Bearer' } });

  await page.goto(`/signin/magic-link/?token=${TOKEN}`);
  await page.click('#login-btn');

  await expect(page.locator('#status')).toHaveClass(/err/);
  await expect(page).toHaveURL(/\/signin\/magic-link\//);
  expect(await readSession(page, AT_KEY)).toBeNull();
});

test('期限切れ / 使用済みトークンはエラー表示のうえ再試行できる状態に戻す', async ({ page }) => {
  mock.on(PATH, {
    status: 400,
    body: { error: 'invalid_token', error_description: 'このログインリンクは既に使用されています。' },
  });

  await page.goto(`/signin/magic-link/?token=${TOKEN}`);
  await page.click('#login-btn');

  await expect(page.locator('#status')).toHaveText('このログインリンクは既に使用されています。');
  await expect(page.locator('#login-btn')).toBeEnabled();
  expect(await readSession(page, AT_KEY)).toBeNull();
});

test('ネットワーク断は再試行できる状態に戻す', async ({ page }) => {
  mock.on(PATH, { abort: 'failed' });

  await page.goto(`/signin/magic-link/?token=${TOKEN}`);
  await page.click('#login-btn');

  await expect(page.locator('#status')).toHaveText('ネットワークエラーが発生しました。時間をおいて再度お試しください。');
  await expect(page.locator('#login-btn')).toBeEnabled();
});

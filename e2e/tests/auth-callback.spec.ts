import { test, expect } from '@playwright/test';
import {
  ADMIN_CLIENT_ID,
  AT_KEY,
  ApiMock,
  REDIRECT_URI,
  STATE_KEY,
  VERIFIER_KEY,
  installApiMock,
  readSession,
  seedSession,
} from './helpers/mock';

/**
 * OAuth2 コールバック（/auth/callback/?code= → POST {apiBaseUrl}/v1/token）。
 *
 * 検証対象は static/js/auth-callback.js。この経路のセキュリティ上の不変条件は 2 つ:
 *   1. state が開始時の値と一致すること（CSRF / 認可コード注入対策）
 *   2. code_verifier が必ず存在すること（PKCE ダウングレード防止）
 * どちらかが欠けたらトークン交換を **行わない**。この「リクエストが飛ばない」ことこそが
 * 守るべき性質なので、countTo(TOKEN_PATH) === 0 を明示的に確認する。
 */
const TOKEN_PATH = '/v1/token';
const CLIENTS_PATH = '/v1/account/clients';

const STATE = 'state-0123456789abcdef';
const VERIFIER = 'verifier-0123456789abcdefghijklmnopqrstuvwxyz';
const CODE = 'auth-code-abcdef';

let mock: ApiMock;

test.beforeEach(async ({ page }) => {
  mock = await installApiMock(page);
  mock.on(CLIENTS_PATH, { status: 200, body: { clients: [] } });
});

test.afterEach(async () => {
  expect(mock.unhandled).toEqual([]);
});

test('state と verifier が揃えば PKCE でトークン交換し、マイページへ遷移する', async ({ page }) => {
  await seedSession(page, { [STATE_KEY]: STATE, [VERIFIER_KEY]: VERIFIER });
  mock.on(TOKEN_PATH, {
    status: 200,
    body: { access_token: 'at-from-callback', id_token: 'id', token_type: 'Bearer', expires_in: 3600 },
  });

  await page.goto(`/auth/callback/?code=${CODE}&state=${STATE}`);
  await page.waitForURL('**/mypage/');

  // トークン交換は form-urlencoded で、PKCE の code_verifier を必ず含む
  expect(mock.lastCallTo(TOKEN_PATH)?.form).toEqual({
    grant_type: 'authorization_code',
    code: CODE,
    redirect_uri: REDIRECT_URI,
    client_id: ADMIN_CLIENT_ID,
    code_verifier: VERIFIER,
  });
  // client_secret は public client なので送らない
  expect(mock.lastCallTo(TOKEN_PATH)?.form).not.toHaveProperty('client_secret');

  expect(await readSession(page, AT_KEY)).toBe('at-from-callback');
  await expect(page.locator('#app-view')).toBeVisible();
});

test('state / verifier は交換後に破棄される（使い捨て）', async ({ page }) => {
  await seedSession(page, { [STATE_KEY]: STATE, [VERIFIER_KEY]: VERIFIER });
  mock.on(TOKEN_PATH, { status: 200, body: { access_token: 'at-1', token_type: 'Bearer' } });

  await page.goto(`/auth/callback/?code=${CODE}&state=${STATE}`);
  await page.waitForURL('**/mypage/');

  expect(await readSession(page, STATE_KEY)).toBeNull();
  expect(await readSession(page, VERIFIER_KEY)).toBeNull();
});

test('state が一致しなければトークン交換しない（認可コード注入対策）', async ({ page }) => {
  await seedSession(page, { [STATE_KEY]: STATE, [VERIFIER_KEY]: VERIFIER });
  mock.on(TOKEN_PATH, { status: 200, body: { access_token: 'should-not-be-issued' } });

  await page.goto(`/auth/callback/?code=${CODE}&state=attacker-state`);

  await expect(page.locator('#status')).toHaveClass(/err/);
  await expect(page.locator('#status')).toContainText('セッションが確認できませんでした');
  await expect(page.locator('#retry')).toBeVisible();
  expect(mock.countTo(TOKEN_PATH)).toBe(0);
  expect(await readSession(page, AT_KEY)).toBeNull();
});

test('state が保存されていなければトークン交換しない', async ({ page }) => {
  await seedSession(page, { [VERIFIER_KEY]: VERIFIER });
  mock.on(TOKEN_PATH, { status: 200, body: { access_token: 'should-not-be-issued' } });

  await page.goto(`/auth/callback/?code=${CODE}&state=${STATE}`);

  await expect(page.locator('#status')).toContainText('セッションが確認できませんでした');
  expect(mock.countTo(TOKEN_PATH)).toBe(0);
});

test('verifier が無ければトークン交換しない（PKCE ダウングレード防止）', async ({ page }) => {
  await seedSession(page, { [STATE_KEY]: STATE });
  mock.on(TOKEN_PATH, { status: 200, body: { access_token: 'should-not-be-issued' } });

  await page.goto(`/auth/callback/?code=${CODE}&state=${STATE}`);

  await expect(page.locator('#status')).toHaveClass(/err/);
  await expect(page.locator('#status')).toContainText('ログインセッションが確認できませんでした');
  expect(mock.countTo(TOKEN_PATH)).toBe(0);
  expect(await readSession(page, AT_KEY)).toBeNull();
});

test('code が無ければトークン交換しない', async ({ page }) => {
  await seedSession(page, { [STATE_KEY]: STATE, [VERIFIER_KEY]: VERIFIER });
  mock.on(TOKEN_PATH, { status: 200, body: { access_token: 'should-not-be-issued' } });

  await page.goto(`/auth/callback/?state=${STATE}`);

  await expect(page.locator('#status')).toContainText('認可コードがありません');
  expect(mock.countTo(TOKEN_PATH)).toBe(0);
});

test('認可サーバが error を返した場合はその内容を案内する', async ({ page }) => {
  await seedSession(page, { [STATE_KEY]: STATE, [VERIFIER_KEY]: VERIFIER });

  await page.goto('/auth/callback/?error=access_denied');

  await expect(page.locator('#status')).toHaveClass(/err/);
  await expect(page.locator('#status')).toContainText('access_denied');
  await expect(page.locator('#retry')).toBeVisible();
  expect(mock.countTo(TOKEN_PATH)).toBe(0);
});

test('トークン交換が失敗したらサーバの error_description を表示する', async ({ page }) => {
  await seedSession(page, { [STATE_KEY]: STATE, [VERIFIER_KEY]: VERIFIER });
  mock.on(TOKEN_PATH, {
    status: 400,
    body: { error: 'invalid_grant', error_description: '認可コードの有効期限が切れています。' },
  });

  await page.goto(`/auth/callback/?code=${CODE}&state=${STATE}`);

  await expect(page.locator('#status')).toHaveText('認可コードの有効期限が切れています。');
  await expect(page).toHaveURL(/\/auth\/callback\//);
  expect(await readSession(page, AT_KEY)).toBeNull();
});

test('ネットワーク断はネットワークエラーとして案内する', async ({ page }) => {
  await seedSession(page, { [STATE_KEY]: STATE, [VERIFIER_KEY]: VERIFIER });
  mock.on(TOKEN_PATH, { abort: 'failed' });

  await page.goto(`/auth/callback/?code=${CODE}&state=${STATE}`);

  await expect(page.locator('#status')).toHaveText('ネットワークエラーが発生しました。時間をおいて再度お試しください。');
  await expect(page.locator('#retry')).toBeVisible();
});

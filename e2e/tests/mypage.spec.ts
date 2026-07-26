import { test, expect, Locator, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  ADMIN_CLIENT_ID,
  API_BASE,
  AT_KEY,
  ApiMock,
  REDIRECT_URI,
  SECRET_MASK,
  STATE_KEY,
  VERIFIER_KEY,
  authorizationOf,
  installApiMock,
  readSession,
  seedSession,
  stubAccountsPages,
} from './helpers/mock';

/**
 * マイページ（/mypage/）。OAuth2(PKCE) public client として accounts の認証へ誘導し、
 * 認証済なら GET {apiBaseUrl}/v1/account/clients の結果を表示する。
 *
 * 検証対象は static/js/mypage.js。とくに client_secret の取り扱い
 *   - 一覧 API は secret を返さない（has_secret のみ）
 *   - 既定はマスク表示で、ユーザーが「表示」/「コピー」を押したときだけ
 *     POST .../secret/reveal で 1 件ずつ取得する
 * は、XSS 時の被害を 1 Client に限定するための設計なのでテストで固定する。
 */
const CLIENTS_PATH = '/v1/account/clients';
const PROD_ID = 11;
const SANDBOX_ID = 12;
const revealPath = (id: number) => `/v1/account/clients/${id}/secret/reveal`;
const regeneratePath = (id: number) => `/v1/account/clients/${id}/secret`;

const ACCESS_TOKEN = 'account-access-token';

const CLIENTS_BODY = {
  clients: [
    {
      id: PROD_ID,
      client_id: 'prod-client-id',
      has_secret: true,
      app_name: '本番サイト',
      is_sandbox: false,
      organization_code: 'shop-example-com',
      organization_name: 'サンプル株式会社',
      redirect_uris: ['https://shop.example.com/admin/ecauth/callback'],
    },
    {
      id: SANDBOX_ID,
      client_id: 'sandbox-client-id',
      has_secret: true,
      app_name: 'テストサイト',
      is_sandbox: true,
      organization_code: 'stg-shop-example-com',
      organization_name: 'サンプル株式会社',
      redirect_uris: [],
    },
  ],
};

function itemOf(page: Page, appName: string): Locator {
  return page.locator('.client-item').filter({ hasText: appName });
}
function secretRowOf(item: Locator): Locator {
  return item.locator('.secret-row').filter({ hasText: 'Client Secret' });
}
function idRowOf(item: Locator): Locator {
  return item.locator('.secret-row').filter({ hasText: 'Client ID' });
}

/** RFC 7636: BASE64URL(SHA256(ASCII(code_verifier))) */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

let mock: ApiMock;

test.beforeEach(async ({ page }) => {
  mock = await installApiMock(page);
});

test.afterEach(async () => {
  expect(mock.unhandled).toEqual([]);
});

test.describe('未認証', () => {
  test('トークンが無ければ API を呼ばずログイン導線を表示する', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });

    await page.goto('/mypage/');

    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#app-view')).toBeHidden();
    await expect(page.locator('#loading')).toBeHidden();
    expect(mock.countTo(CLIENTS_PATH)).toBe(0);
  });

  test('ログイン開始で PKCE を生成し、accounts の認証ページへ正しいパラメータで遷移する', async ({ page }) => {
    await stubAccountsPages(page);

    await page.goto('/mypage/');
    await page.click('#login-btn');
    await page.waitForURL(/\/passkey\/authenticate/);

    const url = new URL(page.url());
    expect(url.origin).toBe(API_BASE);
    expect(url.pathname).toBe('/passkey/authenticate');
    expect(url.searchParams.get('client_id')).toBe(ADMIN_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    // sessionStorage は ec-auth.io オリジンに紐づくため、同じタブで元のオリジンへ戻ってから読む。
    await page.goto('/mypage/');

    // 保存した verifier と URL の challenge が RFC 7636 の関係にあること
    const verifier = await readSession(page, VERIFIER_KEY);
    const state = await readSession(page, STATE_KEY);
    expect(verifier).toBeTruthy();
    expect(verifier!.length).toBeGreaterThanOrEqual(43);
    expect(url.searchParams.get('code_challenge')).toBe(s256(verifier!));
    // state は callback で突き合わせるため保存され、URL にも載る
    expect(state).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(state);
  });

  test('「パスキーが使えない方はこちら」はリカバリ導線へ送る', async ({ page }) => {
    await page.goto('/mypage/');
    await page.click('#login-view >> text=パスキーが使えない方はこちら');
    await expect(page).toHaveURL(/\/signin\/$/);
  });
});

test.describe('認証済', () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page, { [AT_KEY]: ACCESS_TOKEN });
  });

  test('アクセストークンを Bearer で送り、Client 一覧を表示する', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });

    await page.goto('/mypage/');

    await expect(page.locator('#app-view')).toBeVisible();
    await expect(page.locator('#login-view')).toBeHidden();
    await expect(page.locator('#loading')).toBeHidden();

    expect(authorizationOf(mock.lastCallTo(CLIENTS_PATH)!)).toBe(`Bearer ${ACCESS_TOKEN}`);
    await expect(page.locator('.client-item')).toHaveCount(2);

    const prod = itemOf(page, '本番サイト');
    await expect(prod.locator('.obadge')).toHaveText('本番');
    await expect(prod.locator('.obadge')).toHaveClass(/prod/);
    await expect(prod.locator('.ci-domain')).toHaveText('shop-example-com');
    await expect(idRowOf(prod).locator('code')).toHaveText('prod-client-id');

    const sandbox = itemOf(page, 'テストサイト');
    await expect(sandbox.locator('.obadge')).toHaveText('テスト');
    await expect(sandbox.locator('.obadge')).toHaveClass(/sand/);
    await expect(idRowOf(sandbox).locator('code')).toHaveText('sandbox-client-id');
  });

  test('client_secret は一覧では取得せず、既定でマスク表示する', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });

    await page.goto('/mypage/');
    await expect(page.locator('.client-item')).toHaveCount(2);

    await expect(secretRowOf(itemOf(page, '本番サイト')).locator('code')).toHaveText(SECRET_MASK);
    await expect(secretRowOf(itemOf(page, 'テストサイト')).locator('code')).toHaveText(SECRET_MASK);
    // 表示操作をしていない限り reveal は呼ばれない
    expect(mock.countTo(revealPath(PROD_ID))).toBe(0);
    expect(mock.countTo(revealPath(SANDBOX_ID))).toBe(0);
  });

  test('「表示」で該当 Client の secret だけを取得し、「隠す」で再びマスクする', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });
    mock.on(revealPath(PROD_ID), {
      status: 200,
      body: { id: PROD_ID, client_id: 'prod-client-id', client_secret: 'prod-secret-value' },
    });

    await page.goto('/mypage/');
    const prod = itemOf(page, '本番サイト');
    const row = secretRowOf(prod);

    await row.getByRole('button', { name: '表示' }).click();

    await expect(row.locator('code')).toHaveText('prod-secret-value');
    await expect(row.getByRole('button', { name: '隠す' })).toBeVisible();
    expect(mock.countTo(revealPath(PROD_ID))).toBe(1);
    // 他 Client の secret は取得されない（1 件ずつという設計の要）
    expect(mock.countTo(revealPath(SANDBOX_ID))).toBe(0);
    await expect(secretRowOf(itemOf(page, 'テストサイト')).locator('code')).toHaveText(SECRET_MASK);

    await row.getByRole('button', { name: '隠す' }).click();
    await expect(row.locator('code')).toHaveText(SECRET_MASK);

    // 2 回目の表示は取得済みの値を使い、再取得しない
    await row.getByRole('button', { name: '表示' }).click();
    await expect(row.locator('code')).toHaveText('prod-secret-value');
    expect(mock.countTo(revealPath(PROD_ID))).toBe(1);
  });

  test('reveal に失敗したらマスクのままエラーを表示する', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });
    mock.on(revealPath(PROD_ID), { status: 500, body: { error: 'server_error' } });

    await page.goto('/mypage/');
    const row = secretRowOf(itemOf(page, '本番サイト'));
    await row.getByRole('button', { name: '表示' }).click();

    await expect(page.locator('#list-status')).toHaveClass(/err/);
    await expect(page.locator('#list-status')).toContainText('Client Secret を取得できませんでした');
    await expect(row.locator('code')).toHaveText(SECRET_MASK);
    await expect(row.getByRole('button', { name: '表示' })).toBeEnabled();
  });

  test('「コピー」はマスクではなく取得した平文をクリップボードへ入れる', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });
    mock.on(revealPath(PROD_ID), {
      status: 200,
      body: { id: PROD_ID, client_id: 'prod-client-id', client_secret: 'prod-secret-value' },
    });

    await page.goto('/mypage/');
    const row = secretRowOf(itemOf(page, '本番サイト'));
    await row.getByRole('button', { name: 'コピー' }).click();

    await expect(row.getByRole('button', { name: 'コピー済' })).toBeVisible();
    expect(mock.countTo(revealPath(PROD_ID))).toBe(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('prod-secret-value');
    // コピーしても画面上はマスクのまま（肩越しの覗き見対策）
    await expect(row.locator('code')).toHaveText(SECRET_MASK);
  });

  test('Client ID はマスクせずそのままコピーできる', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });

    await page.goto('/mypage/');
    const row = idRowOf(itemOf(page, '本番サイト'));
    await row.getByRole('button', { name: 'コピー' }).click();

    await expect(row.getByRole('button', { name: 'コピー済' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('prod-client-id');
  });

  test('「再生成」は確認ダイアログの承諾後に実行し、新しい secret を全表示する', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });
    mock.on(regeneratePath(PROD_ID), {
      status: 200,
      body: { id: PROD_ID, client_id: 'prod-client-id', client_secret: 'regenerated-secret' },
    });

    let dialogMessage = '';
    page.on('dialog', (dialog) => {
      dialogMessage = dialog.message();
      return dialog.accept();
    });

    await page.goto('/mypage/');
    const row = secretRowOf(itemOf(page, '本番サイト'));
    await row.getByRole('button', { name: '再生成' }).click();

    // 生成直後は控えてもらうため全表示にする
    await expect(row.locator('code')).toHaveText('regenerated-secret');
    await expect(row.getByRole('button', { name: '隠す' })).toBeVisible();
    await expect(page.locator('#list-status')).toHaveClass(/ok/);
    await expect(page.locator('#list-status')).toContainText('再設定してください');
    expect(dialogMessage).toContain('既存の値は無効になり');
    expect(mock.countTo(regeneratePath(PROD_ID))).toBe(1);
    // 再生成後に改めて reveal する必要は無い
    expect(mock.countTo(revealPath(PROD_ID))).toBe(0);
  });

  test('確認ダイアログを取り消したら再生成しない', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });
    mock.on(regeneratePath(PROD_ID), { status: 200, body: { client_secret: 'should-not-be-issued' } });

    page.on('dialog', (dialog) => dialog.dismiss());

    await page.goto('/mypage/');
    const row = secretRowOf(itemOf(page, '本番サイト'));
    await row.getByRole('button', { name: '再生成' }).click();

    await expect(row.locator('code')).toHaveText(SECRET_MASK);
    expect(mock.countTo(regeneratePath(PROD_ID))).toBe(0);
  });

  test('secret 未設定の Client は「（未設定）」を表示し、取得を試みない', async ({ page }) => {
    mock.on(CLIENTS_PATH, {
      status: 200,
      body: {
        clients: [
          { ...CLIENTS_BODY.clients[0], has_secret: false },
        ],
      },
    });

    await page.goto('/mypage/');
    const row = secretRowOf(itemOf(page, '本番サイト'));

    await expect(row.locator('code')).toHaveText('（未設定）');
    await row.getByRole('button', { name: '表示' }).click();
    await row.getByRole('button', { name: 'コピー' }).click();
    await expect(row.locator('code')).toHaveText('（未設定）');
    expect(mock.countTo(revealPath(PROD_ID))).toBe(0);
  });

  test('管理対象が無ければ空一覧の案内を表示する', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: { clients: [] } });

    await page.goto('/mypage/');

    await expect(page.locator('#app-view')).toBeVisible();
    await expect(page.locator('#list-status')).toHaveClass(/info/);
    await expect(page.locator('#list-status')).toHaveText('表示できる Client がありません。');
    await expect(page.locator('.client-item')).toHaveCount(0);
  });

  test('一覧取得に失敗したらエラーを表示する（ログイン画面には戻さない）', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 500, body: { error: 'server_error' } });

    await page.goto('/mypage/');

    await expect(page.locator('#app-view')).toBeVisible();
    await expect(page.locator('#list-status')).toHaveClass(/err/);
    await expect(page.locator('#list-status')).toContainText('Client 情報の取得に失敗しました');
    // 一時的な障害でトークンを捨てない
    expect(await readSession(page, AT_KEY)).toBe(ACCESS_TOKEN);
  });

  test('401 ならトークンを破棄してログイン画面に戻す', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 401, body: { error: 'invalid_token' } });

    await page.goto('/mypage/');

    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#app-view')).toBeHidden();
    expect(await readSession(page, AT_KEY)).toBeNull();
  });

  test('操作中に 401 になったらログイン画面に戻す', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });
    mock.on(revealPath(PROD_ID), { status: 401, body: { error: 'invalid_token' } });

    await page.goto('/mypage/');
    await secretRowOf(itemOf(page, '本番サイト')).getByRole('button', { name: '表示' }).click();

    await expect(page.locator('#login-view')).toBeVisible();
    expect(await readSession(page, AT_KEY)).toBeNull();
  });

  test('ログアウトでトークンを破棄しログイン画面に戻す', async ({ page }) => {
    mock.on(CLIENTS_PATH, { status: 200, body: CLIENTS_BODY });

    await page.goto('/mypage/');
    await expect(page.locator('#app-view')).toBeVisible();

    await page.click('#logout-link');

    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#app-view')).toBeHidden();
    expect(await readSession(page, AT_KEY)).toBeNull();
    // reload 後に一覧を取りにいかない
    expect(mock.countTo(CLIENTS_PATH)).toBe(1);
  });

  test('app_name が無ければ organization_name → client_id の順にフォールバックする', async ({ page }) => {
    mock.on(CLIENTS_PATH, {
      status: 200,
      body: {
        clients: [
          { id: 21, client_id: 'c-1', has_secret: false, is_sandbox: false, organization_name: '組織名のみ' },
          { id: 22, client_id: 'c-2', has_secret: false, is_sandbox: true },
        ],
      },
    });

    await page.goto('/mypage/');

    await expect(page.locator('.client-item').nth(0).locator('.ci-name')).toContainText('組織名のみ');
    await expect(page.locator('.client-item').nth(1).locator('.ci-name')).toContainText('c-2');
  });

  test('Client 名に HTML が含まれてもテキストとして描画する（XSS 回避）', async ({ page }) => {
    mock.on(CLIENTS_PATH, {
      status: 200,
      body: {
        clients: [
          {
            id: 31,
            client_id: 'xss-client',
            has_secret: false,
            is_sandbox: false,
            app_name: '<img src=x onerror="window.__xss=1">',
            organization_code: '<script>window.__xss2=1</script>',
          },
        ],
      },
    });

    await page.goto('/mypage/');

    const item = page.locator('.client-item').first();
    await expect(item.locator('.ci-name')).toContainText('<img src=x onerror=');
    expect(await item.locator('img').count()).toBe(0);
    expect(await item.locator('script').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as { __xss2?: number }).__xss2)).toBeUndefined();
  });
});

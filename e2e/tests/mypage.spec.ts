import { test, expect, Locator, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  ADMIN_CLIENT_ID,
  API_BASE,
  AT_KEY,
  ApiMock,
  MockHandler,
  MockResponse,
  REDIRECT_URI,
  RecordedRequest,
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
 * 認証済なら GET {apiBaseUrl}/v1/account/organizations の結果を表示する。
 *
 * 画面の単位は Client ではなく**サイト（Organization）**。1 カード = 1 サイトで、
 * カード内にそのサイトの Client がぶら下がる。検証対象は static/js/mypage.js。
 *
 * とくに以下は設計上の要なのでテストで固定する:
 *   - client_secret は一覧 API では返らず（has_secret のみ）、ユーザーが「表示」/「コピー」を
 *     押したときだけ POST .../secret/reveal で 1 件ずつ取得する（XSS 時の被害を 1 Client に限定）
 *   - サイト追加は本番の登録上限（max_sites）と「本番 1 件につきテスト 1 件」に縛られる。
 *     送って 422 を受けてから気づくのではなく、選ぶ前に理由を出す
 *   - サイト削除は取り消せない。消えるサイトを列挙した確認ブロックを挟む
 */
const ORGANIZATIONS_PATH = '/v1/account/organizations';
const deletePath = (orgId: number) => `/v1/account/organizations/${orgId}/delete`;
const revealPath = (id: number) => `/v1/account/clients/${id}/secret/reveal`;
const regeneratePath = (id: number) => `/v1/account/clients/${id}/secret`;
const redirectUrisPath = (id: number) => `/v1/account/clients/${id}/redirect-uris`;
const allowedRpIdsPath = (id: number) => `/v1/account/clients/${id}/allowed-rp-ids`;

/** Organization.Id。カードの data-org-id と、削除・親指定の API パスに使う。 */
const PROD_ORG_ID = 101;
const SANDBOX_ORG_ID = 102;
const ADDED_ORG_ID = 103;
/** Client.Id。secret / redirect_uri / RP ID の API パスに使う。 */
const PROD_ID = 11;
const SANDBOX_ID = 12;

const ACCESS_TOKEN = 'account-access-token';

interface MockClient {
  id: number;
  client_id: string;
  has_secret: boolean;
  app_name?: string;
  redirect_uris: string[];
  allowed_rp_ids: string[];
}

interface MockOrganization {
  id: number;
  code: string;
  name: string;
  is_sandbox: boolean;
  parent_organization_id: number | null;
  role: string;
  created_at: string;
  clients: MockClient[];
}

function client(overrides: Partial<MockClient> & Pick<MockClient, 'id' | 'client_id'>): MockClient {
  return {
    has_secret: true,
    redirect_uris: [],
    allowed_rp_ids: [],
    ...overrides,
  };
}

function organization(
  overrides: Partial<MockOrganization> & Pick<MockOrganization, 'id' | 'code'>
): MockOrganization {
  return {
    // 実サーバは本番もテストも同じ組織名（申込時の組織名 / アカウントの表示名）を入れる。
    // 画面上の区別はバッジと組織コードで付く。
    name: 'サンプル株式会社',
    is_sandbox: false,
    parent_organization_id: null,
    role: 'owner',
    created_at: '2026-01-01T00:00:00+00:00',
    clients: [],
    ...overrides,
  };
}

const PROD_ORG = organization({
  id: PROD_ORG_ID,
  code: 'shop-example-com',
  clients: [
    client({
      id: PROD_ID,
      client_id: 'prod-client-id',
      app_name: '本番サイト',
      redirect_uris: ['https://shop.example.com/admin/ecauth/callback'],
      allowed_rp_ids: ['shop.example.com'],
    }),
  ],
});

const SANDBOX_ORG = organization({
  id: SANDBOX_ORG_ID,
  code: 'stg-shop-example-com',
  is_sandbox: true,
  parent_organization_id: PROD_ORG_ID,
  clients: [client({ id: SANDBOX_ID, client_id: 'sandbox-client-id', app_name: 'テストサイト' })],
});

/** GET /v1/account/organizations のレスポンス。production_site_count は本番だけを数える。 */
function listBody(organizations: MockOrganization[], maxSites = 10) {
  return {
    organizations,
    max_sites: maxSites,
    production_site_count: organizations.filter((o) => !o.is_sandbox).length,
  };
}

const DEFAULT_BODY = listBody([PROD_ORG, SANDBOX_ORG]);

/**
 * 一覧（GET）とサイト追加（POST）は**同じパス**で、ApiMock はパスだけでマッチする。
 * ここでメソッドを振り分ける。
 *
 * list に関数を渡すと呼び出しごとに評価されるので、追加・削除の後に別の一覧を返せる。
 * create を渡さなかったテストで POST が飛んだら 599 を返し、取りこぼさず画面に出す。
 */
function stubOrganizations(list: MockResponse | (() => MockResponse), create?: MockHandler): void {
  mock.on(ORGANIZATIONS_PATH, async (req) => {
    if (req.method === 'POST') {
      return create ? create(req) : { status: 599, body: { error: 'unexpected_post' } };
    }
    return typeof list === 'function' ? list() : list;
  });
}

/** 既定の一覧（本番 1 + テスト 1）を返すだけのスタブ。 */
function stubDefaultList(): void {
  stubOrganizations({ status: 200, body: DEFAULT_BODY });
}

function listCalls(): RecordedRequest[] {
  return mock.callsTo(ORGANIZATIONS_PATH).filter((c) => c.method === 'GET');
}

function createCalls(): RecordedRequest[] {
  return mock.callsTo(ORGANIZATIONS_PATH).filter((c) => c.method === 'POST');
}

/** サイトカードは Organization.Id で引く（組織名は本番・テストで同じになりうるため）。 */
function itemOf(page: Page, orgId: number): Locator {
  return page.locator(`.client-item[data-org-id="${orgId}"]`);
}

/** Client カード内の設定セクション（details）。data-section は mypage.js の SECTIONS[].key。 */
function sectionOf(item: Locator, key: 'redirect_uris' | 'allowed_rp_ids'): Locator {
  return item.locator(`.ci-settings[data-section="${key}"]`);
}

/** 畳まれている設定セクションを開いて返す。 */
async function openSection(item: Locator, key: 'redirect_uris' | 'allowed_rp_ids'): Promise<Locator> {
  const section = sectionOf(item, key);
  await section.locator('summary').click();
  await expect(section.locator('.row-list')).toBeVisible();
  return section;
}

/** 設定セクションの入力欄の値を表示順に取り出す。 */
function inputValuesOf(section: Locator): Promise<string[]> {
  return section.locator('.row-input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
}
function secretRowOf(item: Locator): Locator {
  return item.locator('.secret-row').filter({ hasText: 'Client Secret' });
}
function idRowOf(item: Locator): Locator {
  return item.locator('.secret-row').filter({ hasText: 'Client ID' });
}
/** カード内のサイト削除の確認ブロック。 */
function confirmOf(item: Locator): Locator {
  return item.locator('.site-confirm');
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
    stubDefaultList();

    await page.goto('/mypage/');

    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#app-view')).toBeHidden();
    await expect(page.locator('#loading')).toBeHidden();
    expect(mock.countTo(ORGANIZATIONS_PATH)).toBe(0);
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

  test('アクセストークンを Bearer で送り、サイト一覧を表示する', async ({ page }) => {
    stubDefaultList();

    await page.goto('/mypage/');

    await expect(page.locator('#app-view')).toBeVisible();
    await expect(page.locator('#login-view')).toBeHidden();
    await expect(page.locator('#loading')).toBeHidden();

    expect(authorizationOf(mock.lastCallTo(ORGANIZATIONS_PATH)!)).toBe(`Bearer ${ACCESS_TOKEN}`);
    await expect(page.locator('.client-item')).toHaveCount(2);

    const prod = itemOf(page, PROD_ORG_ID);
    await expect(prod.locator('.obadge')).toHaveText('本番');
    await expect(prod.locator('.obadge')).toHaveClass(/prod/);
    // 見出しは組織コード（= 接続先ホスト名）。組織名はアカウント内の全サイトで同じ値に
    // なるため、サイトの識別には使えない。
    await expect(prod.locator('.ci-code')).toHaveText('shop-example-com');
    await expect(prod.locator('.ci-owner')).toHaveText('サンプル株式会社');
    await expect(idRowOf(prod).locator('code')).toHaveText('prod-client-id');

    const sandbox = itemOf(page, SANDBOX_ORG_ID);
    await expect(sandbox.locator('.obadge')).toHaveText('テスト');
    await expect(sandbox.locator('.obadge')).toHaveClass(/sand/);
    await expect(sandbox.locator('.ci-code')).toHaveText('stg-shop-example-com');
    await expect(idRowOf(sandbox).locator('code')).toHaveText('sandbox-client-id');
  });

  test('テストサイトは紐づく本番サイトの直後に、従属を示して並べる', async ({ page }) => {
    // API は id 昇順で返すため、あとから足したテストサイトは親から離れた位置に来る。
    // 並べ直さないとどのテストがどの本番のものか読み取れない。
    const secondProd = organization({ id: 201, code: 'second-example-com' });
    const firstSandbox = organization({
      id: 202,
      code: 'stg-shop-example-com',
      is_sandbox: true,
      parent_organization_id: PROD_ORG_ID,
    });
    stubOrganizations({ status: 200, body: listBody([PROD_ORG, secondProd, firstSandbox]) });

    await page.goto('/mypage/');

    await expect(page.locator('.client-item')).toHaveCount(3);
    expect(
      await page.locator('.client-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-org-id')))
    ).toEqual([String(PROD_ORG_ID), '202', '201']);

    const sandbox = itemOf(page, 202);
    await expect(sandbox).toHaveClass(/child/);
    await expect(sandbox.locator('.ci-parent')).toContainText('shop-example-com');
    // 本番サイトのカードには従属の表記を出さない。
    await expect(itemOf(page, PROD_ORG_ID).locator('.ci-parent')).toHaveCount(0);
  });

  test('親が一覧に無いテストサイトも隠さず表示する', async ({ page }) => {
    // 本番を削除すればテストもカセード削除されるので本来生まれないが、
    // 隠すと利用者が消す手段を失うため、末尾に出して削除できるようにする。
    const orphan = organization({
      id: 301,
      code: 'orphan-example-com',
      is_sandbox: true,
      parent_organization_id: 999,
    });
    stubOrganizations({ status: 200, body: listBody([PROD_ORG, orphan]) });

    await page.goto('/mypage/');

    await expect(page.locator('.client-item')).toHaveCount(2);
    await expect(itemOf(page, 301)).toBeVisible();
    await expect(itemOf(page, 301).locator('.ci-parent')).toHaveCount(0);
    await expect(itemOf(page, 301).getByRole('button', { name: /削除/ })).toBeEnabled();
  });

  test('client_secret は一覧では取得せず、既定でマスク表示する', async ({ page }) => {
    stubDefaultList();

    await page.goto('/mypage/');
    await expect(page.locator('.client-item')).toHaveCount(2);

    await expect(secretRowOf(itemOf(page, PROD_ORG_ID)).locator('code')).toHaveText(SECRET_MASK);
    await expect(secretRowOf(itemOf(page, SANDBOX_ORG_ID)).locator('code')).toHaveText(SECRET_MASK);
    // 表示操作をしていない限り reveal は呼ばれない
    expect(mock.countTo(revealPath(PROD_ID))).toBe(0);
    expect(mock.countTo(revealPath(SANDBOX_ID))).toBe(0);
  });

  test('「表示」で該当 Client の secret だけを取得し、「隠す」で再びマスクする', async ({ page }) => {
    stubDefaultList();
    mock.on(revealPath(PROD_ID), {
      status: 200,
      body: { id: PROD_ID, client_id: 'prod-client-id', client_secret: 'prod-secret-value' },
    });

    await page.goto('/mypage/');
    const prod = itemOf(page, PROD_ORG_ID);
    const row = secretRowOf(prod);

    await row.getByRole('button', { name: '表示' }).click();

    await expect(row.locator('code')).toHaveText('prod-secret-value');
    await expect(row.getByRole('button', { name: '隠す' })).toBeVisible();
    expect(mock.countTo(revealPath(PROD_ID))).toBe(1);
    // 他 Client の secret は取得されない（1 件ずつという設計の要）
    expect(mock.countTo(revealPath(SANDBOX_ID))).toBe(0);
    await expect(secretRowOf(itemOf(page, SANDBOX_ORG_ID)).locator('code')).toHaveText(SECRET_MASK);

    await row.getByRole('button', { name: '隠す' }).click();
    await expect(row.locator('code')).toHaveText(SECRET_MASK);

    // 2 回目の表示は取得済みの値を使い、再取得しない
    await row.getByRole('button', { name: '表示' }).click();
    await expect(row.locator('code')).toHaveText('prod-secret-value');
    expect(mock.countTo(revealPath(PROD_ID))).toBe(1);
  });

  test('reveal に失敗したらマスクのままエラーを表示する', async ({ page }) => {
    stubDefaultList();
    mock.on(revealPath(PROD_ID), { status: 500, body: { error: 'server_error' } });

    await page.goto('/mypage/');
    const row = secretRowOf(itemOf(page, PROD_ORG_ID));
    await row.getByRole('button', { name: '表示' }).click();

    await expect(page.locator('#list-status')).toHaveClass(/err/);
    await expect(page.locator('#list-status')).toContainText('Client Secret を取得できませんでした');
    await expect(row.locator('code')).toHaveText(SECRET_MASK);
    await expect(row.getByRole('button', { name: '表示' })).toBeEnabled();
  });

  test('「コピー」はマスクではなく取得した平文をクリップボードへ入れる', async ({ page }) => {
    stubDefaultList();
    mock.on(revealPath(PROD_ID), {
      status: 200,
      body: { id: PROD_ID, client_id: 'prod-client-id', client_secret: 'prod-secret-value' },
    });

    await page.goto('/mypage/');
    const row = secretRowOf(itemOf(page, PROD_ORG_ID));
    await row.getByRole('button', { name: 'コピー' }).click();

    await expect(row.getByRole('button', { name: 'コピー済' })).toBeVisible();
    expect(mock.countTo(revealPath(PROD_ID))).toBe(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('prod-secret-value');
    // コピーしても画面上はマスクのまま（肩越しの覗き見対策）
    await expect(row.locator('code')).toHaveText(SECRET_MASK);
  });

  test('Client ID はマスクせずそのままコピーできる', async ({ page }) => {
    stubDefaultList();

    await page.goto('/mypage/');
    const row = idRowOf(itemOf(page, PROD_ORG_ID));
    await row.getByRole('button', { name: 'コピー' }).click();

    await expect(row.getByRole('button', { name: 'コピー済' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('prod-client-id');
  });

  test('「再生成」は確認ダイアログの承諾後に実行し、新しい secret を全表示する', async ({ page }) => {
    stubDefaultList();
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
    const row = secretRowOf(itemOf(page, PROD_ORG_ID));
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
    stubDefaultList();
    mock.on(regeneratePath(PROD_ID), { status: 200, body: { client_secret: 'should-not-be-issued' } });

    page.on('dialog', (dialog) => dialog.dismiss());

    await page.goto('/mypage/');
    const row = secretRowOf(itemOf(page, PROD_ORG_ID));
    await row.getByRole('button', { name: '再生成' }).click();

    await expect(row.locator('code')).toHaveText(SECRET_MASK);
    expect(mock.countTo(regeneratePath(PROD_ID))).toBe(0);
  });

  test('secret 未設定の Client は「（未設定）」を表示し、取得を試みない', async ({ page }) => {
    stubOrganizations({
      status: 200,
      body: listBody([
        organization({
          ...PROD_ORG,
          clients: [client({ ...PROD_ORG.clients[0], has_secret: false })],
        }),
      ]),
    });

    await page.goto('/mypage/');
    const row = secretRowOf(itemOf(page, PROD_ORG_ID));

    await expect(row.locator('code')).toHaveText('（未設定）');
    await row.getByRole('button', { name: '表示' }).click();
    await row.getByRole('button', { name: 'コピー' }).click();
    await expect(row.locator('code')).toHaveText('（未設定）');
    expect(mock.countTo(revealPath(PROD_ID))).toBe(0);
  });

  test('1 サイトに Client が複数あるときだけ、どの Client かを見出しで示す', async ({ page }) => {
    // 実運用では 1 サイト 1 Client。増えた場合に区別できなくならないための分岐を固定する。
    stubOrganizations({
      status: 200,
      body: listBody([
        organization({
          ...PROD_ORG,
          clients: [
            client({ id: PROD_ID, client_id: 'prod-client-id', app_name: '管理画面' }),
            client({ id: 13, client_id: 'second-client-id', app_name: 'フロント' }),
          ],
        }),
      ]),
    });

    await page.goto('/mypage/');
    const prod = itemOf(page, PROD_ORG_ID);

    await expect(prod.locator('.ci-client')).toHaveCount(2);
    await expect(prod.locator('.ci-client-name')).toHaveText(['管理画面', 'フロント']);
  });

  test('サイトが 1 件も無ければ追加を促す案内を表示する', async ({ page }) => {
    stubOrganizations({ status: 200, body: listBody([]) });

    await page.goto('/mypage/');

    await expect(page.locator('#app-view')).toBeVisible();
    await expect(page.locator('#list-status')).toHaveClass(/info/);
    await expect(page.locator('#list-status')).toContainText('登録済みのサイトがありません');
    await expect(page.locator('.client-item')).toHaveCount(0);
    // 追加フォームは出す（ここからしか登録できないため）。
    await expect(page.locator('#add-card')).toBeVisible();
  });

  test('一覧取得に失敗したらエラーを表示する（ログイン画面には戻さない）', async ({ page }) => {
    stubOrganizations({ status: 500, body: { error: 'server_error' } });

    await page.goto('/mypage/');

    await expect(page.locator('#app-view')).toBeVisible();
    await expect(page.locator('#list-status')).toHaveClass(/err/);
    await expect(page.locator('#list-status')).toContainText('サイト情報の取得に失敗しました');
    // 上限も親候補も分からない状態では、追加しても弾かれるだけなのでフォームは出さない。
    await expect(page.locator('#add-card')).toBeHidden();
    // 一時的な障害でトークンを捨てない
    expect(await readSession(page, AT_KEY)).toBe(ACCESS_TOKEN);
  });

  test('401 ならトークンを破棄してログイン画面に戻す', async ({ page }) => {
    stubOrganizations({ status: 401, body: { error: 'invalid_token' } });

    await page.goto('/mypage/');

    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#app-view')).toBeHidden();
    expect(await readSession(page, AT_KEY)).toBeNull();
  });

  test('操作中に 401 になったらログイン画面に戻す', async ({ page }) => {
    stubDefaultList();
    mock.on(revealPath(PROD_ID), { status: 401, body: { error: 'invalid_token' } });

    await page.goto('/mypage/');
    await secretRowOf(itemOf(page, PROD_ORG_ID)).getByRole('button', { name: '表示' }).click();

    await expect(page.locator('#login-view')).toBeVisible();
    expect(await readSession(page, AT_KEY)).toBeNull();
  });

  test('ログアウトでトークンを破棄しログイン画面に戻す', async ({ page }) => {
    stubDefaultList();

    await page.goto('/mypage/');
    await expect(page.locator('#app-view')).toBeVisible();

    await page.click('#logout-link');

    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#app-view')).toBeHidden();
    expect(await readSession(page, AT_KEY)).toBeNull();
    // reload 後に一覧を取りにいかない
    expect(listCalls()).toHaveLength(1);
  });

  test('組織名が無くても組織コードだけで表示できる', async ({ page }) => {
    stubOrganizations({
      status: 200,
      body: listBody([organization({ id: 21, code: 'code-only-example-com', name: '' })]),
    });

    await page.goto('/mypage/');

    await expect(itemOf(page, 21).locator('.ci-code')).toHaveText('code-only-example-com');
    await expect(itemOf(page, 21).locator('.ci-owner')).toHaveCount(0);
  });

  test('サイト名や組織コードに HTML が含まれてもテキストとして描画する（XSS 回避）', async ({ page }) => {
    stubOrganizations({
      status: 200,
      body: listBody([
        organization({
          id: 31,
          code: '<script>window.__xss2=1</script>',
          name: '<img src=x onerror="window.__xss=1">',
          clients: [client({ id: 32, client_id: 'xss-client', has_secret: false })],
        }),
      ]),
    });

    await page.goto('/mypage/');

    const item = itemOf(page, 31);
    await expect(item.locator('.ci-code')).toContainText('<script>');
    await expect(item.locator('.ci-owner')).toContainText('<img src=x onerror=');
    expect(await item.locator('img').count()).toBe(0);
    expect(await item.locator('script').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as { __xss2?: number }).__xss2)).toBeUndefined();
  });

  /**
   * サイト（Organization）の追加。
   *
   * 制約は 2 つあり、どちらも一覧を数えないと分からない:
   *   - 本番サイトは account.max_sites 件まで（テストサイトは数えない）
   *   - テストサイトは本番サイト 1 件につき 1 件まで
   * 送信して 422 を受けてから気づくのではなく、選ぶ前に理由を出すことを固定する。
   */
  test.describe('サイト追加', () => {
    test('本番サイトを追加し、一覧を取り直す', async ({ page }) => {
      const added = organization({
        id: ADDED_ORG_ID,
        code: 'added-example-jp',
        clients: [client({ id: 14, client_id: 'added-client-id' })],
      });
      let current = listBody([PROD_ORG, SANDBOX_ORG]);

      stubOrganizations(
        () => ({ status: 200, body: current }),
        () => {
          current = listBody([PROD_ORG, SANDBOX_ORG, added]);
          return {
            status: 201,
            body: {
              id: ADDED_ORG_ID,
              code: 'added-example-jp',
              name: 'サンプル株式会社',
              is_sandbox: false,
              parent_organization_id: null,
              client: { id: 14, client_id: 'added-client-id', has_secret: true },
            },
          };
        }
      );

      await page.goto('/mypage/');
      await expect(page.locator('#site-usage')).toHaveText('1 / 10 件');

      await page.fill('#add-url', 'https://added.example.jp/');
      await page.click('#add-btn');

      await expect(page.locator('#add-status')).toHaveClass(/ok/);
      await expect(page.locator('#add-status')).toContainText('サイトを追加しました');
      expect(createCalls()).toHaveLength(1);
      expect(createCalls()[0].json).toEqual({
        site_url: 'https://added.example.jp/',
        ec_cube_version: '4',
      });

      // 追加後は一覧を取り直し、残枠の表示も更新する。
      expect(listCalls()).toHaveLength(2);
      await expect(page.locator('.client-item')).toHaveCount(3);
      await expect(itemOf(page, ADDED_ORG_ID)).toBeVisible();
      await expect(page.locator('#site-usage')).toHaveText('2 / 10 件');
      // 入力欄は次の追加に備えて空にする。
      await expect(page.locator('#add-url')).toHaveValue('');
    });

    test('EC-CUBE のバージョンを選んで送る', async ({ page }) => {
      stubOrganizations({ status: 200, body: DEFAULT_BODY }, () => ({
        status: 201,
        body: { id: ADDED_ORG_ID, code: 'added-example-jp', is_sandbox: false },
      }));

      await page.goto('/mypage/');
      await page.fill('#add-url', 'https://added.example.jp/');
      await page.check('input[name="add_version"][value="2"]');
      await page.click('#add-btn');

      await expect(page.locator('#add-status')).toHaveClass(/ok/);
      expect(createCalls()[0].json).toMatchObject({ ec_cube_version: '2' });
    });

    test('テストサイトは紐づける本番サイトを選んで追加する', async ({ page }) => {
      const secondProd = organization({ id: 201, code: 'second-example-com' });
      stubOrganizations({ status: 200, body: listBody([PROD_ORG, SANDBOX_ORG, secondProd]) }, () => ({
        status: 201,
        body: { id: 202, code: 'stg-second-example-com', is_sandbox: true, parent_organization_id: 201 },
      }));

      await page.goto('/mypage/');

      // 本番サイトの選択欄はテストを選ぶまで出さない。
      await expect(page.locator('#f-add-parent')).toBeHidden();
      await page.check('#add-kind-sandbox');
      await expect(page.locator('#f-add-parent')).toBeVisible();

      // 既にテストサイトを持つ本番サイトは候補に出さない（送っても 422 になるため）。
      expect(
        await page.locator('#add-parent option').evaluateAll((els) =>
          els.map((e) => (e as HTMLOptionElement).value)
        )
      ).toEqual(['201']);
      await expect(page.locator('#add-parent option')).toContainText(['second-example-com']);

      await page.fill('#add-url', 'https://stg.second.example.com/');
      await page.click('#add-btn');

      await expect(page.locator('#add-status')).toHaveClass(/ok/);
      expect(createCalls()[0].json).toEqual({
        site_url: 'https://stg.second.example.com/',
        ec_cube_version: '4',
        is_sandbox: true,
        parent_organization_id: 201,
      });
    });

    test('種別を本番に戻すと親サイトの指定は送らない', async ({ page }) => {
      const secondProd = organization({ id: 201, code: 'second-example-com' });
      stubOrganizations({ status: 200, body: listBody([PROD_ORG, secondProd]) }, () => ({
        status: 201,
        body: { id: ADDED_ORG_ID, code: 'added-example-jp', is_sandbox: false },
      }));

      await page.goto('/mypage/');
      await page.check('#add-kind-sandbox');
      await expect(page.locator('#f-add-parent')).toBeVisible();
      await page.check('#add-kind-production');
      await expect(page.locator('#f-add-parent')).toBeHidden();

      await page.fill('#add-url', 'https://added.example.jp/');
      await page.click('#add-btn');

      await expect(page.locator('#add-status')).toHaveClass(/ok/);
      expect(createCalls()[0].json).toEqual({
        site_url: 'https://added.example.jp/',
        ec_cube_version: '4',
      });
    });

    test('https でない URL は送信せずその場で指摘する', async ({ page }) => {
      stubDefaultList();

      await page.goto('/mypage/');
      await page.fill('#add-url', 'http://insecure.example.jp/');
      await page.click('#add-btn');

      await expect(page.locator('#f-add-url')).toHaveClass(/invalid/);
      expect(createCalls()).toHaveLength(0);

      // 直せば警告は消える。
      await page.fill('#add-url', 'https://secure.example.jp/');
      await expect(page.locator('#f-add-url')).not.toHaveClass(/invalid/);
    });

    test('URL が空でも送信しない', async ({ page }) => {
      stubDefaultList();

      await page.goto('/mypage/');
      await page.click('#add-btn');

      await expect(page.locator('#f-add-url')).toHaveClass(/invalid/);
      expect(createCalls()).toHaveLength(0);
    });

    test('本番サイトが上限に達していたら本番を選べず、理由を出す', async ({ page }) => {
      stubOrganizations({ status: 200, body: listBody([PROD_ORG], 1) });

      await page.goto('/mypage/');

      await expect(page.locator('#site-usage')).toHaveText('1 / 1 件');
      await expect(page.locator('#add-kind-production')).toBeDisabled();
      await expect(page.locator('#add-kind-hint')).toContainText('上限の 1 件に達しています');
      // まだテストサイトは追加できるので、選択はそちらへ寄せる。
      await expect(page.locator('#add-kind-sandbox')).toBeChecked();
      await expect(page.locator('#f-add-parent')).toBeVisible();
      await expect(page.locator('#add-btn')).toBeEnabled();
    });

    test('すべての本番サイトにテストサイトがあればテストを選べない', async ({ page }) => {
      stubDefaultList();

      await page.goto('/mypage/');

      await expect(page.locator('#add-kind-sandbox')).toBeDisabled();
      await expect(page.locator('#add-kind-production')).toBeChecked();
      await expect(page.locator('#add-kind-hint')).toContainText('すべての本番サイトにテストサイトが登録済み');
      await expect(page.locator('#add-btn')).toBeEnabled();
    });

    test('サイトが 1 件も無ければテストサイトは選べない', async ({ page }) => {
      stubOrganizations({ status: 200, body: listBody([]) });

      await page.goto('/mypage/');

      await expect(page.locator('#add-kind-sandbox')).toBeDisabled();
      await expect(page.locator('#add-kind-hint')).toContainText('先に本番サイトを追加してください');
      await expect(page.locator('#add-btn')).toBeEnabled();
    });

    test('どちらの種別も選べないときは入力させない', async ({ page }) => {
      // 本番は上限、テストは追加先が無い状態。送れば必ず弾かれるので入力欄ごと止める。
      stubOrganizations({ status: 200, body: listBody([PROD_ORG, SANDBOX_ORG], 1) });

      await page.goto('/mypage/');

      await expect(page.locator('#add-kind-production')).toBeDisabled();
      await expect(page.locator('#add-kind-sandbox')).toBeDisabled();
      await expect(page.locator('#add-url')).toBeDisabled();
      await expect(page.locator('#add-btn')).toBeDisabled();
      await expect(page.locator('#add-kind-hint')).toContainText('上限の 1 件に達しています');
      await expect(page.locator('#add-kind-hint')).toContainText('すべての本番サイトにテストサイトが登録済み');
    });

    test('登録済みドメインのエラーはマイページ向けの文言に差し替える', async ({ page }) => {
      // サーバの文言は申込フォームと共用で「別のサイト URL でお申し込みください」。
      // マイページでは、自分の既存サイトと導出後の組織コードが衝突した場合もここに来るため、
      // 「www. の有無だけが違う URL も同じサイトとして扱われる」ことまで伝える。
      stubOrganizations({ status: 200, body: DEFAULT_BODY }, () => ({
        status: 422,
        body: {
          error: 'organization_already_exists',
          error_description: 'このドメインは既に EcAuth に登録されています。別のサイト URL でお申し込みください。',
          field: 'site_url',
        },
      }));

      await page.goto('/mypage/');
      await page.fill('#add-url', 'https://www.shop.example.com/');
      await page.click('#add-btn');

      const status = page.locator('#add-status');
      await expect(status).toHaveClass(/err/);
      await expect(status).toContainText('「www.」の有無だけが違う URL も同じサイトとして扱われます');
      await expect(status).not.toContainText('お申し込みください');
      // サーバが指摘したフィールドを画面上でも赤くする。
      await expect(page.locator('#f-add-url')).toHaveClass(/invalid/);
      // 入力は残し、直して再送できるようにする。
      await expect(page.locator('#add-url')).toHaveValue('https://www.shop.example.com/');
      await expect(page.locator('#add-btn')).toBeEnabled();
      // 失敗したので一覧は取り直さない。
      expect(listCalls()).toHaveLength(1);
    });

    test('削除済みドメインのエラーはサーバの文言をそのまま出す', async ({ page }) => {
      stubOrganizations({ status: 200, body: DEFAULT_BODY }, () => ({
        status: 422,
        body: {
          error: 'organization_deleted',
          error_description:
            'このドメインは削除済みのサイトで使用されています。同じドメインでの再登録はできません。',
          field: 'site_url',
        },
      }));

      await page.goto('/mypage/');
      await page.fill('#add-url', 'https://deleted.example.jp/');
      await page.click('#add-btn');

      await expect(page.locator('#add-status')).toHaveClass(/err/);
      await expect(page.locator('#add-status')).toHaveText(
        'このドメインは削除済みのサイトで使用されています。同じドメインでの再登録はできません。'
      );
    });

    test('並行追加の競合（409）は差し替えず、やり直しを促す文言のまま出す', async ({ page }) => {
      stubOrganizations({ status: 200, body: DEFAULT_BODY }, () => ({
        status: 409,
        body: {
          error: 'organization_already_exists',
          error_description: 'サイトの登録が競合しました。時間をおいて再度お試しください。',
          field: 'site_url',
        },
      }));

      await page.goto('/mypage/');
      await page.fill('#add-url', 'https://added.example.jp/');
      await page.click('#add-btn');

      await expect(page.locator('#add-status')).toHaveText(
        'サイトの登録が競合しました。時間をおいて再度お試しください。'
      );
    });

    test('サーバが理由を返さない失敗は汎用メッセージにする', async ({ page }) => {
      stubOrganizations({ status: 200, body: DEFAULT_BODY }, () => ({
        status: 500,
        body: { error: 'server_error' },
      }));

      await page.goto('/mypage/');
      await page.fill('#add-url', 'https://added.example.jp/');
      await page.click('#add-btn');

      await expect(page.locator('#add-status')).toHaveClass(/err/);
      await expect(page.locator('#add-status')).toContainText('サイトを追加できませんでした');
      await expect(page.locator('#add-btn')).toBeEnabled();
    });

    test('追加後の一覧再取得に失敗したら、見えない場所に完了メッセージを残さない', async ({ page }) => {
      // 再取得に失敗すると追加フォームごと隠れる（上限も親候補も分からないため）。
      // そこに成功状態を書くと、次に一覧が復帰したとき古いメッセージが出てしまう。
      let listFails = false;
      stubOrganizations(
        () => (listFails ? { status: 500, body: { error: 'server_error' } } : { status: 200, body: DEFAULT_BODY }),
        () => {
          listFails = true;
          return { status: 201, body: { id: ADDED_ORG_ID, code: 'added-example-jp', is_sandbox: false } };
        }
      );

      await page.goto('/mypage/');
      await page.fill('#add-url', 'https://added.example.jp/');
      await page.click('#add-btn');

      await expect(page.locator('#list-status')).toHaveClass(/err/);
      await expect(page.locator('#add-card')).toBeHidden();
      await expect(page.locator('#add-status')).not.toHaveClass(/ok/);
    });

    test('エラー文言に HTML が含まれてもテキストとして描画する（XSS 回避）', async ({ page }) => {
      stubOrganizations({ status: 200, body: DEFAULT_BODY }, () => ({
        status: 422,
        body: {
          error: 'invalid_site_url',
          error_description: '<img src=x onerror="window.__xss4=1">',
          field: 'site_url',
        },
      }));

      await page.goto('/mypage/');
      await page.fill('#add-url', 'https://added.example.jp/');
      await page.click('#add-btn');

      const status = page.locator('#add-status');
      await expect(status).toContainText('<img src=x onerror=');
      expect(await status.locator('img').count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __xss4?: number }).__xss4)).toBeUndefined();
    });

    test('追加中に 401 になったらログイン画面に戻す', async ({ page }) => {
      stubOrganizations({ status: 200, body: DEFAULT_BODY }, () => ({
        status: 401,
        body: { error: 'invalid_token' },
      }));

      await page.goto('/mypage/');
      await page.fill('#add-url', 'https://added.example.jp/');
      await page.click('#add-btn');

      await expect(page.locator('#login-view')).toBeVisible();
      expect(await readSession(page, AT_KEY)).toBeNull();
    });
  });

  /**
   * サイト（Organization）の削除。
   *
   * サイト URL の変更は提供しないため、付け替えは「追加 → 動作確認 → 旧サイト削除」で行う。
   * つまり削除は必須の導線だが、client_id もパスキーも失われ、同じドメインで登録し直すことも
   * できない。window.confirm では収まらないので、消えるサイトを列挙した確認ブロックを挟む。
   */
  test.describe('サイト削除', () => {
    test('確認ブロックを開くまで削除 API を呼ばない', async ({ page }) => {
      stubDefaultList();
      mock.on(deletePath(PROD_ORG_ID), { status: 200, body: { deleted_organization_ids: [PROD_ORG_ID] } });

      await page.goto('/mypage/');
      const prod = itemOf(page, PROD_ORG_ID);

      await expect(confirmOf(prod)).toBeHidden();
      await prod.getByRole('button', { name: /削除/ }).click();

      await expect(confirmOf(prod)).toBeVisible();
      expect(mock.countTo(deletePath(PROD_ORG_ID))).toBe(0);
    });

    test('本番サイトの確認には一緒に消えるテストサイトを列挙する', async ({ page }) => {
      stubDefaultList();

      await page.goto('/mypage/');
      const prod = itemOf(page, PROD_ORG_ID);
      await prod.getByRole('button', { name: /削除/ }).click();

      const confirm = confirmOf(prod);
      // どのサイトを消すのかは組織コードで示す（組織名は全サイトで同じ値になるため）。
      await expect(confirm.locator('.sc-title')).toContainText('「shop-example-com」を削除します');
      await expect(confirm.locator('.sc-list li')).toHaveText([
        'shop-example-com（本番サイト）',
        'stg-shop-example-com（テストサイト）',
      ]);
      await expect(confirm).toContainText('登録済みのパスキーもすべて無効になります');
      await expect(confirm).toContainText('同じドメインで登録し直すことはできません');

      // テストサイト側の確認には、そのサイトだけが並ぶ。
      const sandbox = itemOf(page, SANDBOX_ORG_ID);
      await sandbox.getByRole('button', { name: /削除/ }).click();
      await expect(confirmOf(sandbox).locator('.sc-list li')).toHaveText([
        'stg-shop-example-com（テストサイト）',
      ]);
    });

    test('別のカードの確認を開くと前の確認は閉じる', async ({ page }) => {
      stubDefaultList();

      await page.goto('/mypage/');
      await itemOf(page, PROD_ORG_ID).getByRole('button', { name: /削除/ }).click();
      await expect(confirmOf(itemOf(page, PROD_ORG_ID))).toBeVisible();

      await itemOf(page, SANDBOX_ORG_ID).getByRole('button', { name: /削除/ }).click();

      // 2 つ開いていると、どちらを消すのか読み取りにくい。
      await expect(confirmOf(itemOf(page, SANDBOX_ORG_ID))).toBeVisible();
      await expect(confirmOf(itemOf(page, PROD_ORG_ID))).toBeHidden();
    });

    test('「やめる」で確認を閉じ、API は呼ばない', async ({ page }) => {
      stubDefaultList();
      mock.on(deletePath(PROD_ORG_ID), { status: 200, body: { deleted_organization_ids: [PROD_ORG_ID] } });

      await page.goto('/mypage/');
      const prod = itemOf(page, PROD_ORG_ID);
      await prod.getByRole('button', { name: /削除/ }).click();
      await confirmOf(prod).getByRole('button', { name: 'やめる' }).click();

      await expect(confirmOf(prod)).toBeHidden();
      expect(mock.countTo(deletePath(PROD_ORG_ID))).toBe(0);
      await expect(page.locator('.client-item')).toHaveCount(2);
    });

    test('「削除する」で削除し、一覧を取り直して完了を伝える', async ({ page }) => {
      let current = listBody([PROD_ORG, SANDBOX_ORG]);
      stubOrganizations(() => ({ status: 200, body: current }));
      mock.on(deletePath(PROD_ORG_ID), () => {
        // 本番を消すと、紐づくテストサイトもサーバ側でカスケード削除される。
        current = listBody([]);
        return {
          status: 200,
          body: {
            deleted_organization_ids: [PROD_ORG_ID, SANDBOX_ORG_ID],
            deleted_at: '2026-08-06T00:00:00+00:00',
          },
        };
      });

      await page.goto('/mypage/');
      const prod = itemOf(page, PROD_ORG_ID);
      await prod.getByRole('button', { name: /削除/ }).click();
      await confirmOf(prod).getByRole('button', { name: '削除する' }).click();

      await expect(page.locator('#list-status')).toHaveClass(/ok/);
      await expect(page.locator('#list-status')).toContainText('テストサイトを含む 2 件');
      expect(mock.countTo(deletePath(PROD_ORG_ID))).toBe(1);
      expect(listCalls()).toHaveLength(2);
      await expect(page.locator('.client-item')).toHaveCount(0);
      // 削除で枠が空くので、残枠の表示も更新する。
      await expect(page.locator('#site-usage')).toHaveText('0 / 10 件');
    });

    test('テストサイトだけを削除したときは件数を添えない', async ({ page }) => {
      let current = listBody([PROD_ORG, SANDBOX_ORG]);
      stubOrganizations(() => ({ status: 200, body: current }));
      mock.on(deletePath(SANDBOX_ORG_ID), () => {
        current = listBody([PROD_ORG]);
        return { status: 200, body: { deleted_organization_ids: [SANDBOX_ORG_ID] } };
      });

      await page.goto('/mypage/');
      const sandbox = itemOf(page, SANDBOX_ORG_ID);
      await sandbox.getByRole('button', { name: /削除/ }).click();
      await confirmOf(sandbox).getByRole('button', { name: '削除する' }).click();

      await expect(page.locator('#list-status')).toHaveText('サイトを削除しました。');
      await expect(page.locator('.client-item')).toHaveCount(1);
      // テスト枠が空くので、テストサイトを再び選べるようになる。
      await expect(page.locator('#add-kind-sandbox')).toBeEnabled();
    });

    test('削除後の一覧再取得に失敗したら、完了ではなく取得エラーを残す', async ({ page }) => {
      // 削除自体は成功しているが、直後の再取得が落ちると画面は古い一覧のまま。
      // ここで「削除しました」を書くと、削除済みのカードが残ったまま完了と表示され、
      // しかも App.setStatus は className ごと差し替えるので取得エラーの理由まで消える。
      let listFails = false;
      stubOrganizations(() =>
        listFails ? { status: 500, body: { error: 'server_error' } } : { status: 200, body: DEFAULT_BODY }
      );
      mock.on(deletePath(PROD_ORG_ID), () => {
        listFails = true;
        return { status: 200, body: { deleted_organization_ids: [PROD_ORG_ID, SANDBOX_ORG_ID] } };
      });

      await page.goto('/mypage/');
      const prod = itemOf(page, PROD_ORG_ID);
      await prod.getByRole('button', { name: /削除/ }).click();
      await confirmOf(prod).getByRole('button', { name: '削除する' }).click();

      const status = page.locator('#list-status');
      await expect(status).toHaveClass(/err/);
      await expect(status).toContainText('サイト情報の取得に失敗しました');
      await expect(status).not.toContainText('削除しました');
      // 画面は古い一覧のまま。利用者から見て「消えていない」状態と表示が食い違わないこと。
      await expect(page.locator('.client-item')).toHaveCount(2);
    });

    test('削除に失敗したら確認ブロック内に理由を出し、やり直せる状態に戻す', async ({ page }) => {
      stubDefaultList();
      mock.on(deletePath(PROD_ORG_ID), {
        status: 404,
        body: { error: 'not_found', error_description: '対象のサイトが見つかりません。' },
      });

      await page.goto('/mypage/');
      const prod = itemOf(page, PROD_ORG_ID);
      await prod.getByRole('button', { name: /削除/ }).click();
      const confirm = confirmOf(prod);
      await confirm.getByRole('button', { name: '削除する' }).click();

      await expect(confirm.locator('[data-status="delete"]')).toHaveClass(/err/);
      await expect(confirm.locator('[data-status="delete"]')).toHaveText('対象のサイトが見つかりません。');
      await expect(confirm.getByRole('button', { name: '削除する' })).toBeEnabled();
      await expect(confirm.getByRole('button', { name: 'やめる' })).toBeEnabled();
      await expect(prod.getByRole('button', { name: /削除/ }).first()).toBeEnabled();
      // 一覧はそのまま（消えていない）。
      await expect(page.locator('.client-item')).toHaveCount(2);
      expect(listCalls()).toHaveLength(1);
    });

    test('削除中に 401 になったらログイン画面に戻す', async ({ page }) => {
      stubDefaultList();
      mock.on(deletePath(PROD_ORG_ID), { status: 401, body: { error: 'invalid_token' } });

      await page.goto('/mypage/');
      const prod = itemOf(page, PROD_ORG_ID);
      await prod.getByRole('button', { name: /削除/ }).click();
      await confirmOf(prod).getByRole('button', { name: '削除する' }).click();

      await expect(page.locator('#login-view')).toBeVisible();
      expect(await readSession(page, AT_KEY)).toBeNull();
    });
  });

  /**
   * Client 設定（redirect_uri / allowed_rp_ids）の編集。
   *
   * どちらの API も「配列を受け取ってリストごと全置換」する POST で、エラーは入力値ではなく
   * 「N 件目の…」という**位置**で返る（サーバが redirect_uri を反映するとログに user:pass@ が
   * 残るため）。したがって画面の行と送信配列の添字が 1:1 であることが仕様の要になる。
   * ここではその対応関係（順序・空欄の保持・削除後の詰め方）を固定する。
   */
  test.describe('Client 設定の編集', () => {
    test('現在値を行として表示し、既定では畳んでおく', async ({ page }) => {
      stubDefaultList();

      await page.goto('/mypage/');
      const prod = itemOf(page, PROD_ORG_ID);

      const uris = sectionOf(prod, 'redirect_uris');
      await expect(uris.locator('.ci-count')).toHaveText('1 件');
      // 主用途は client_id / secret のコピーなので、編集欄は開くまで出さない。
      await expect(uris.locator('.row-list')).toBeHidden();

      await openSection(prod, 'redirect_uris');
      await expect(uris.locator('.row-input')).toHaveValue('https://shop.example.com/admin/ecauth/callback');
      await expect(uris.locator('.row-no')).toHaveText('1');

      const rpIds = await openSection(prod, 'allowed_rp_ids');
      await expect(rpIds.locator('.ci-count')).toHaveText('1 件');
      await expect(rpIds.locator('.row-input')).toHaveValue('shop.example.com');
    });

    test('0 件でも入力できるよう空の行を 1 つ出す', async ({ page }) => {
      stubDefaultList();

      await page.goto('/mypage/');
      const sandbox = itemOf(page, SANDBOX_ORG_ID);

      await expect(sectionOf(sandbox, 'redirect_uris').locator('.ci-count')).toHaveText('0 件');
      const section = await openSection(sandbox, 'redirect_uris');
      await expect(section.locator('.list-row')).toHaveCount(1);
      await expect(section.locator('.row-input')).toHaveValue('');
    });

    test('行を追加して保存すると、表示順どおりの配列で全置換する', async ({ page }) => {
      stubDefaultList();
      mock.on(redirectUrisPath(PROD_ID), (req) => ({
        status: 200,
        body: {
          id: PROD_ID,
          client_id: 'prod-client-id',
          redirect_uris: (req.json as { redirect_uris: string[] }).redirect_uris,
        },
      }));

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'redirect_uris');

      await section.locator('.row-add').click();
      await expect(section.locator('.list-row')).toHaveCount(2);
      await section.locator('.row-input').nth(1).fill('https://shop.example.com/ecauth/callback');
      await section.getByRole('button', { name: '保存' }).click();

      await expect(section.locator('[data-status="section"]')).toHaveClass(/ok/);
      expect(mock.lastCallTo(redirectUrisPath(PROD_ID))!.json).toEqual({
        redirect_uris: [
          'https://shop.example.com/admin/ecauth/callback',
          'https://shop.example.com/ecauth/callback',
        ],
      });
      await expect(section.locator('.ci-count')).toHaveText('2 件');
    });

    test('行を削除すると番号を振り直し、他の行の入力途中の値は失わない', async ({ page }) => {
      stubOrganizations({
        status: 200,
        body: listBody([
          organization({
            ...PROD_ORG,
            clients: [
              client({
                ...PROD_ORG.clients[0],
                redirect_uris: [
                  'https://a.example.com/ecauth/callback',
                  'https://b.example.com/ecauth/callback',
                  'https://c.example.com/ecauth/callback',
                ],
              }),
            ],
          }),
        ]),
      });
      mock.on(redirectUrisPath(PROD_ID), (req) => ({
        status: 200,
        body: {
          id: PROD_ID,
          client_id: 'prod-client-id',
          redirect_uris: (req.json as { redirect_uris: string[] }).redirect_uris,
        },
      }));

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'redirect_uris');

      // 3 行目を編集してから 1 行目を消す（未保存の編集が消えないこと）。
      await section.locator('.row-input').nth(2).fill('https://z.example.com/ecauth/callback');
      await section.locator('.row-del').nth(0).click();

      await expect(section.locator('.list-row')).toHaveCount(2);
      await expect(section.locator('.row-no')).toHaveText(['1', '2']);
      expect(await inputValuesOf(section)).toEqual([
        'https://b.example.com/ecauth/callback',
        'https://z.example.com/ecauth/callback',
      ]);

      await section.getByRole('button', { name: '保存' }).click();
      await expect(section.locator('[data-status="section"]')).toHaveClass(/ok/);
      expect(mock.lastCallTo(redirectUrisPath(PROD_ID))!.json).toEqual({
        redirect_uris: ['https://b.example.com/ecauth/callback', 'https://z.example.com/ecauth/callback'],
      });
    });

    test('空欄の行も落とさずに送る（サーバのエラー位置と行番号を一致させるため）', async ({ page }) => {
      stubDefaultList();
      // 空要素はサーバ側が捨てるため、レスポンスは詰めた配列になる。
      mock.on(redirectUrisPath(SANDBOX_ID), {
        status: 200,
        body: {
          id: SANDBOX_ID,
          client_id: 'sandbox-client-id',
          redirect_uris: ['https://stg.shop.example.com/ecauth/callback'],
        },
      });

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, SANDBOX_ORG_ID), 'redirect_uris');

      // 1 行目は空のまま、2 行目にだけ入力する。
      await section.locator('.row-add').click();
      await section.locator('.row-input').nth(1).fill('https://stg.shop.example.com/ecauth/callback');
      await section.getByRole('button', { name: '保存' }).click();

      await expect(section.locator('[data-status="section"]')).toHaveClass(/ok/);
      expect(mock.lastCallTo(redirectUrisPath(SANDBOX_ID))!.json).toEqual({
        redirect_uris: ['', 'https://stg.shop.example.com/ecauth/callback'],
      });
      // 保存後はサーバが返した配列（空要素を落としたもの）で描き直す。
      await expect(section.locator('.list-row')).toHaveCount(1);
      await expect(section.locator('.ci-count')).toHaveText('1 件');
    });

    test('保存後はサーバが正規化した値で描き直す', async ({ page }) => {
      stubDefaultList();
      // 実サーバは小文字化・Punycode 化・重複の畳み込みを行う。
      mock.on(allowedRpIdsPath(PROD_ID), {
        status: 200,
        body: { id: PROD_ID, client_id: 'prod-client-id', allowed_rp_ids: ['shop.example.com'] },
      });

      page.on('dialog', (dialog) => dialog.accept());

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'allowed_rp_ids');

      await section.locator('.row-input').nth(0).fill('SHOP.Example.COM');
      await section.locator('.row-add').click();
      await section.locator('.row-input').nth(1).fill('shop.example.com');
      await section.getByRole('button', { name: '保存' }).click();

      await expect(section.locator('[data-status="section"]')).toHaveClass(/ok/);
      await expect(section.locator('.list-row')).toHaveCount(1);
      await expect(section.locator('.row-input')).toHaveValue('shop.example.com');
      await expect(section.locator('.ci-count')).toHaveText('1 件');
    });

    test('422 は error_description をそのまま出し、入力は保持して直せるようにする', async ({ page }) => {
      stubDefaultList();
      mock.on(redirectUrisPath(PROD_ID), {
        status: 422,
        body: {
          error: 'invalid_redirect_uri',
          error_description: '2 件目の redirect_uri は https:// で始まる正しい URL を指定してください。',
          field: 'redirect_uris',
        },
      });

      await page.goto('/mypage/');
      const prod = itemOf(page, PROD_ORG_ID);
      const section = await openSection(prod, 'redirect_uris');

      await section.locator('.row-add').click();
      await section.locator('.row-input').nth(1).fill('http://insecure.example.com/ecauth/callback');
      await section.getByRole('button', { name: '保存' }).click();

      const status = section.locator('[data-status="section"]');
      await expect(status).toHaveClass(/err/);
      await expect(status).toHaveText('2 件目の redirect_uri は https:// で始まる正しい URL を指定してください。');

      // 入力は消さない。「2 件目」がそのまま 2 行目を指し続けること。
      expect(await inputValuesOf(section)).toEqual([
        'https://shop.example.com/admin/ecauth/callback',
        'http://insecure.example.com/ecauth/callback',
      ]);
      await expect(section.locator('.row-no')).toHaveText(['1', '2']);
      // 件数は保存できていないので変わらない。
      await expect(section.locator('.ci-count')).toHaveText('1 件');
      // 操作していないセクションにはエラーを出さない。
      await expect(sectionOf(prod, 'allowed_rp_ids').locator('[data-status="section"]')).toBeHidden();
    });

    test('エラー文言に HTML が含まれてもテキストとして描画する（XSS 回避）', async ({ page }) => {
      stubDefaultList();
      mock.on(redirectUrisPath(PROD_ID), {
        status: 422,
        body: {
          error: 'invalid_redirect_uri',
          error_description: '<img src=x onerror="window.__xss3=1">',
          field: 'redirect_uris',
        },
      });

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'redirect_uris');
      await section.getByRole('button', { name: '保存' }).click();

      const status = section.locator('[data-status="section"]');
      await expect(status).toContainText('<img src=x onerror=');
      expect(await status.locator('img').count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __xss3?: number }).__xss3)).toBeUndefined();
    });

    test('RP ID の保存は確認ダイアログを挟み、取り消したら送らない', async ({ page }) => {
      stubDefaultList();
      mock.on(allowedRpIdsPath(PROD_ID), {
        status: 200,
        body: { id: PROD_ID, client_id: 'prod-client-id', allowed_rp_ids: [] },
      });

      let dialogMessage = '';
      page.on('dialog', (dialog) => {
        dialogMessage = dialog.message();
        return dialog.dismiss();
      });

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'allowed_rp_ids');
      await section.locator('.row-del').nth(0).click();
      await section.getByRole('button', { name: '保存' }).click();

      expect(dialogMessage).toContain('登録済みのパスキーは使えなくなり');
      expect(mock.countTo(allowedRpIdsPath(PROD_ID))).toBe(0);
    });

    test('redirect_uri の保存は確認ダイアログを挟まない', async ({ page }) => {
      stubDefaultList();
      mock.on(redirectUrisPath(PROD_ID), {
        status: 200,
        body: {
          id: PROD_ID,
          client_id: 'prod-client-id',
          redirect_uris: ['https://shop.example.com/admin/ecauth/callback'],
        },
      });

      let dialogCount = 0;
      page.on('dialog', (dialog) => {
        dialogCount += 1;
        return dialog.dismiss();
      });

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'redirect_uris');
      await section.getByRole('button', { name: '保存' }).click();

      await expect(section.locator('[data-status="section"]')).toHaveClass(/ok/);
      expect(dialogCount).toBe(0);
      expect(mock.countTo(redirectUrisPath(PROD_ID))).toBe(1);
    });

    test('「取り消し」で保存前の値に戻し、API は呼ばない', async ({ page }) => {
      stubDefaultList();

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'redirect_uris');

      await section.locator('.row-input').nth(0).fill('https://typo.example.com/');
      await section.locator('.row-add').click();
      await expect(section.locator('.list-row')).toHaveCount(2);

      await section.getByRole('button', { name: '取り消し' }).click();

      await expect(section.locator('.list-row')).toHaveCount(1);
      await expect(section.locator('.row-input')).toHaveValue('https://shop.example.com/admin/ecauth/callback');
      expect(mock.countTo(redirectUrisPath(PROD_ID))).toBe(0);
    });

    test('保存中はセクションの編集操作をロックする', async ({ page }) => {
      stubDefaultList();

      // 応答を保留し、リクエスト飛行中の画面状態を観測できるようにする。
      let release: () => void = () => {};
      const inFlight = new Promise<void>((resolve) => {
        release = resolve;
      });
      mock.on(redirectUrisPath(PROD_ID), async () => {
        await inFlight;
        return {
          status: 200,
          body: {
            id: PROD_ID,
            client_id: 'prod-client-id',
            redirect_uris: ['https://shop.example.com/admin/ecauth/callback'],
          },
        };
      });

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'redirect_uris');
      await section.locator('.row-save').click();

      // 送信ボディは「保存」を押した時点のスナップショット。飛行中に編集できてしまうと、
      // 送っていない変更が成功時の再描画で黙って消え、しかも「保存しました」と出る。
      await expect(section.locator('.row-save')).toBeDisabled();
      await expect(section.locator('.row-input').first()).toBeDisabled();
      await expect(section.locator('.row-del').first()).toBeDisabled();
      await expect(section.locator('.row-add')).toBeDisabled();
      await expect(section.locator('.row-cancel')).toBeDisabled();

      release();

      await expect(section.locator('[data-status="section"]')).toHaveClass(/ok/);
      await expect(section.locator('.row-save')).toBeEnabled();
      await expect(section.locator('.row-input').first()).toBeEnabled();
      await expect(section.locator('.row-del').first()).toBeEnabled();
      await expect(section.locator('.row-add')).toBeEnabled();
      await expect(section.locator('.row-cancel')).toBeEnabled();
    });

    test('保存中に 401 になったらログイン画面に戻す', async ({ page }) => {
      stubDefaultList();
      mock.on(redirectUrisPath(PROD_ID), { status: 401, body: { error: 'invalid_token' } });

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'redirect_uris');
      await section.getByRole('button', { name: '保存' }).click();

      await expect(page.locator('#login-view')).toBeVisible();
      expect(await readSession(page, AT_KEY)).toBeNull();
    });

    test('サーバが理由を返さない失敗は汎用メッセージにする', async ({ page }) => {
      stubDefaultList();
      mock.on(redirectUrisPath(PROD_ID), { status: 500, body: { error: 'server_error' } });

      await page.goto('/mypage/');
      const section = await openSection(itemOf(page, PROD_ORG_ID), 'redirect_uris');
      await section.getByRole('button', { name: '保存' }).click();

      await expect(section.locator('[data-status="section"]')).toHaveClass(/err/);
      await expect(section.locator('[data-status="section"]')).toContainText('保存に失敗しました');
      // 失敗しても編集を再開できる状態に戻ること。
      await expect(section.locator('.row-input').first()).toBeEnabled();
      await expect(section.locator('.row-add')).toBeEnabled();
      await expect(section.locator('.row-save')).toBeEnabled();
    });
  });
});

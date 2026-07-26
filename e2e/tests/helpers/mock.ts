import { Page, Request } from '@playwright/test';

/*
 * hugo の既定ポート（1313）はあえて避ける。EcAuth 側の結合スイート
 * （website_signup_flow.spec.ts）は 1313 に hugo server --tlsAuto（HTTPS）を立てるため、
 * 同じポートだと playwright.config.ts の reuseExistingServer が HTTPS のサーバを
 * 掴んでしまい、このスイート全体が不可解に落ちる。
 */
export const SITE_PORT = 1314;
export const SITE_BASE = `http://localhost:${SITE_PORT}`;

/**
 * スタブ API の配信元。誰も listen しないポートを指定し、全リクエストを page.route() で
 * 横取りする。SITE_BASE とポートが異なる = クロスオリジンなので、
 * 「apiBaseUrl を組み立てて別オリジンへ投げる」本番同等の性質を保ったまま検証できる。
 */
export const API_BASE = 'http://localhost:1399';

export const REDIRECT_URI = `${SITE_BASE}/auth/callback`;
export const ADMIN_CLIENT_ID = 'ecauth-admin-console';

/** mypage.js の MASK 定数と同じ値（U+2022 × 16）。 */
export const SECRET_MASK = '•'.repeat(16);

/** フロントが sessionStorage に使うキー（app.js / mypage.js / auth-callback.js と一致させる）。 */
export const AT_KEY = 'ecauth_at';
export const VERIFIER_KEY = 'ecauth_pkce_verifier';
export const STATE_KEY = 'ecauth_oauth_state';

/** 記録されたリクエスト 1 件。 */
export interface RecordedRequest {
  method: string;
  url: string;
  /** API_BASE を除いたパス（クエリを含まない）。例: /api/signup/request */
  path: string;
  headers: Record<string, string>;
  /** 生のリクエストボディ */
  raw: string | null;
  /** JSON ボディをパースしたもの（パースできなければ null） */
  json: Record<string, unknown> | null;
  /** application/x-www-form-urlencoded ボディをパースしたもの */
  form: Record<string, string> | null;
}

/** スタブが返すレスポンス。body がオブジェクトなら JSON として返す。 */
export interface MockResponse {
  status?: number;
  body?: unknown;
  contentType?: string;
  /** 指定するとレスポンスを返さずリクエストを失敗させる（ネットワーク断の再現）。 */
  abort?: 'failed' | 'connectionrefused' | 'timedout';
}

export type MockHandler = (req: RecordedRequest) => MockResponse | Promise<MockResponse>;

/** CORS プリフライト / 実レスポンスに付与するヘッダ（実サーバの SignupApiCors 相当）。 */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': SITE_BASE,
    'Access-Control-Allow-Headers': 'Content-Type,Accept,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}

function parseBody(raw: string | null, contentType: string): Pick<RecordedRequest, 'json' | 'form'> {
  if (!raw) {
    return { json: null, form: null };
  }
  if (contentType.includes('application/json')) {
    try {
      return { json: JSON.parse(raw) as Record<string, unknown>, form: null };
    } catch {
      return { json: null, form: null };
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return { json: null, form: Object.fromEntries(new URLSearchParams(raw)) };
  }
  return { json: null, form: null };
}

function record(request: Request): RecordedRequest {
  const headers = request.headers();
  const raw = request.postData();
  const url = request.url();
  return {
    method: request.method(),
    url,
    path: new URL(url).pathname,
    headers,
    raw,
    ...parseBody(raw, headers['content-type'] ?? ''),
  };
}

function matches(pattern: string | RegExp, path: string): boolean {
  return typeof pattern === 'string' ? pattern === path : pattern.test(path);
}

/**
 * EcAuth API のスタブ。パスごとにレスポンスを登録し、飛んできたリクエストを記録する。
 *
 * 登録の無いパスへのリクエストは 599 を返し unhandled に積む。テスト側は
 * expectNoUnhandled() で「想定外のエンドポイントを叩いていないこと」を確認できる。
 */
export class ApiMock {
  /** ハンドラが解決した（= OPTIONS 以外の）リクエストの記録。 */
  readonly calls: RecordedRequest[] = [];
  /** ハンドラ未登録のパスに飛んだリクエスト。 */
  readonly unhandled: RecordedRequest[] = [];

  private readonly handlers: Array<{ pattern: string | RegExp; handler: MockHandler }> = [];

  /**
   * パスに対するレスポンスを登録する。同じパスに複数登録した場合は後勝ち。
   * レスポンスは固定値でも、リクエストを見て組み立てる関数でもよい。
   */
  on(pattern: string | RegExp, response: MockResponse | MockHandler): this {
    const handler: MockHandler = typeof response === 'function' ? response : () => response;
    this.handlers.unshift({ pattern, handler });
    return this;
  }

  /** 指定パスへ飛んだリクエストを取り出す。 */
  callsTo(pattern: string | RegExp): RecordedRequest[] {
    return this.calls.filter((c) => matches(pattern, c.path));
  }

  /** 指定パスへ飛んだリクエスト数。 */
  countTo(pattern: string | RegExp): number {
    return this.callsTo(pattern).length;
  }

  /** 直近のリクエスト（無ければ undefined）。 */
  lastCallTo(pattern: string | RegExp): RecordedRequest | undefined {
    return this.callsTo(pattern).at(-1);
  }

  /** @internal */
  async resolve(req: RecordedRequest): Promise<MockResponse | null> {
    const entry = this.handlers.find((h) => matches(h.pattern, req.path));
    return entry ? entry.handler(req) : null;
  }
}

/**
 * page に API スタブを差し込む。navigation より前に呼ぶこと。
 */
export async function installApiMock(page: Page): Promise<ApiMock> {
  const mock = new ApiMock();

  await page.route(`${API_BASE}/**`, async (route) => {
    const req = record(route.request());

    // プリフライトは実サーバ同様に常に許可する（記録はしない）。
    if (req.method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders() });
      return;
    }

    const response = await mock.resolve(req);
    if (response === null) {
      mock.unhandled.push(req);
      await route.fulfill({
        status: 599,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'mock_not_configured', path: req.path }),
      });
      return;
    }

    mock.calls.push(req);

    if (response.abort) {
      await route.abort(response.abort);
      return;
    }

    const isString = typeof response.body === 'string';
    await route.fulfill({
      status: response.status ?? 200,
      contentType: response.contentType ?? (isString ? 'text/plain' : 'application/json'),
      headers: corsHeaders(),
      body: response.body === undefined ? '' : isString ? (response.body as string) : JSON.stringify(response.body),
    });
  });

  return mock;
}

/**
 * accounts オリジンのページ（/passkey/authenticate・/passkey/register）をスタブする。
 * 本物は EcAuth の Razor ビューで、このスイートの対象外。遷移したことだけを確認したいので、
 * 遷移先 URL を観測できるよう 200 の空ページで受ける。
 */
export async function stubAccountsPages(page: Page): Promise<void> {
  await page.route(`${API_BASE}/passkey/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body>accounts stub</body></html>',
    })
  );
}

/**
 * sessionStorage に初期値を入れる。addInitScript は遷移のたびに走るため、
 * 初回ドキュメントでのみ書き込む（ログアウト後の reload で復活させないため）。
 */
export async function seedSession(page: Page, values: Record<string, string>): Promise<void> {
  await page.addInitScript((seed) => {
    const GUARD = '__e2e_seeded';
    if (sessionStorage.getItem(GUARD)) {
      return;
    }
    sessionStorage.setItem(GUARD, '1');
    for (const [key, value] of Object.entries(seed as Record<string, string>)) {
      sessionStorage.setItem(key, value);
    }
  }, values);
}

/** ブラウザ側の sessionStorage を読み出す。 */
export async function readSession(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => sessionStorage.getItem(k), key);
}

/**
 * ヘッダ名の大文字小文字を吸収して Authorization ヘッダを取り出す。
 */
export function authorizationOf(req: RecordedRequest): string | undefined {
  const entry = Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'authorization');
  return entry?.[1];
}

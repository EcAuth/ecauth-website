import { defineConfig, devices } from '@playwright/test';
import { API_BASE, SITE_BASE, SITE_PORT } from './tests/helpers/mock';

/**
 * ecauth-website のフロント E2E。
 *
 * このスイートは **backend を必要としない**。EcAuth API（申込 / マジックリンク / Account /
 * token）はすべて page.route() で横取りしてスタブするため、ecauth-website 単体の PR で
 * 完結して回る。実 API との契約齟齬・実 WebAuthn・実 CORS は EcAuth リポジトリ側の
 * E2ETests/tests/specs/website_signup_flow.spec.ts（フル結合）が担当する。
 *
 * secure context について:
 *   マイページ / auth-callback は PKCE のために crypto.subtle を使う。crypto.subtle は
 *   secure context でしか使えないが、Chromium は localhost を「信頼できるオリジン」として
 *   扱うため、http://localhost:1313 でも isSecureContext=true になり TLS 無しで検証できる
 *   （本番相当のホスト名 ec-auth.io で試す場合は HTTPS が必須になる。結合スイート側で
 *   hugo server --tlsAuto を使っているのはこのため）。
 *
 * apiBaseUrl について:
 *   誰も listen しない別ポート（1399）を指定し、クロスオリジンのまま route で横取りする。
 *   同一オリジンにしてしまうと「apiBaseUrl を組み立ててクロスオリジンに投げている」という
 *   本番同等の性質が検証から抜け落ちるため、あえてポートを分けている。
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: SITE_BASE,
    trace: 'on-first-retry',
    screenshot: { mode: 'only-on-failure', fullPage: true },
    video: 'retain-on-failure',
    // マイページの「コピー」ボタン（navigator.clipboard）を検証するため。
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  outputDir: 'test-results/',
  webServer: {
    // hugo.toml の apiBaseUrl / authRedirectUri を env で上書きし、baseof.html が
    // window.ECAUTH に注入する値をテスト用に差し替える。
    command:
      `hugo server --bind 127.0.0.1 --port ${SITE_PORT}` +
      ` --baseURL ${SITE_BASE}/ --appendPort=false --disableFastRender`,
    url: `${SITE_BASE}/signup/`,
    cwd: '..',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      HUGO_PARAMS_APIBASEURL: API_BASE,
      HUGO_PARAMS_AUTHREDIRECTURI: `${SITE_BASE}/auth/callback`,
    },
  },
});

# ecauth-website

EcAuth サービス紹介 Web サイト。Hugo + Cloudflare Pages で構築。

## 開発コマンド

```bash
# ローカルプレビュー
hugo server

# ビルド
hugo --minify
```

## E2E テスト

申込・マイページ（`static/js/*.js`）のフロント E2E。`e2e/` に Playwright で置いている。

```bash
cd e2e
pnpm install
pnpm exec playwright install chromium
pnpm test        # playwright.config.ts の webServer が hugo server を自動起動する
pnpm typecheck
```

- **バックエンド不要**。EcAuth API（`/api/signup/*`・`/api/account/*`・`/v1/account/*`・`/v1/token`）は
  すべて `page.route()` でスタブする（`tests/helpers/mock.ts`）。このリポジトリ単体の PR で完結して回る。
- `apiBaseUrl` は誰も listen しない別ポート（`http://localhost:1399`）に向け、クロスオリジンのまま
  横取りする。同一オリジンにすると「apiBaseUrl を組み立てて別オリジンへ投げる」性質が検証から抜ける。
- PKCE（`crypto.subtle`）は secure context 必須だが、Chromium は `localhost` を信頼するため
  `http://localhost:1313` でも TLS 無しで検証できる。
- **実 API との契約齟齬・実 CORS・実 WebAuthn はこのスイートでは検出できない**。その層は EcAuth
  リポジトリの `E2ETests/tests/specs/website_signup_flow.spec.ts`（このサイトを hugo server で配信し、
  実バックエンドに通すフル結合）が担当する。フロントの DOM 構造（`id` / クラス名）を変えたときは
  そちらも壊れる可能性があるため両方確認すること。

## デプロイ

- main ブランチへの push で GitHub Actions が Cloudflare Pages にデプロイ
- PR 時はビルドのみ（デプロイしない）
- デプロイは E2E ジョブの成功が前提（`deploy.yml` の `needs: e2e`）

## ディレクトリ構成

- `content/` — Markdown コンテンツ
- `layouts/` — Hugo テンプレート（カスタムテーマ、外部テーマ不使用）
- `static/` — 静的アセット（CSS、画像、llms.txt）
- `e2e/` — Playwright E2E テスト（API はスタブ）
- `public/` — ビルド出力（.gitignore 対象）

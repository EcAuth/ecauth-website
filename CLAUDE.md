# ecauth-website

EcAuth サービス紹介 Web サイト。Hugo + Cloudflare Pages で構築。

## 開発コマンド

```bash
# ローカルプレビュー
hugo server

# ビルド
hugo --minify
```

## デプロイ

- main ブランチへの push で GitHub Actions が Cloudflare Pages にデプロイ
- PR 時はビルドのみ（デプロイしない）

## ディレクトリ構成

- `content/` — Markdown コンテンツ
- `layouts/` — Hugo テンプレート（カスタムテーマ、外部テーマ不使用）
- `static/` — 静的アセット（CSS、画像、llms.txt）
- `public/` — ビルド出力（.gitignore 対象）

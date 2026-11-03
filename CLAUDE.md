# mdvault の作業ルール

- **変更は `develop` ブランチで行い、`develop` に push する。`main` には直接 push しない。**
  `main` へは、CI がすべて成功した `develop` → `main` のプルリクエストを「Create a merge commit」でマージして反映する（docs/ci.md の「ブランチの運用」）
- コミットの作者は `sai103 <19669246+sai103@users.noreply.github.com>`。個人のメールアドレスをリポジトリに入れない（公開リポジトリ）
- セキュリティに関わる変更は `/mdvault-security-review` の手順で確認する。前提は docs/security.md
- push の前に `npx tsc`・`npm test`・（画面を変えたら）`npm run test:e2e` を実行する
- 機能を変えたら docs/manual.md・docs/test-scenarios.md も更新する

# Cloudflare 上での構成と運用

mdvault は Cloudflare の Free プランだけで動くように作っています。このファイルでは、Cloudflare 側で使っているもの・費用・デプロイ・運用上の注意をまとめます。
アプリ自体の仕組みは [README](../README.md#アーキテクチャ) を参照してください。

> 無料枠の数値は 2026 年時点の概要です。最新の値は Cloudflare 公式の料金ページで確認してください。

## 使っているサービス

| サービス | 用途 | 無料枠 |
| --- | --- | --- |
| Workers | API の処理（`src/index.ts`） | 1 日 10 万リクエスト、1 リクエストあたり CPU 時間 10ms |
| Workers 静的アセット | 画面ファイル（`public/`）の配信 | 無料 |
| D1 | すべてのデータ（ノート・履歴・デバイス） | ストレージ 5GB、1 日あたり読み取り 500 万行・書き込み 10 万行 |

KV・R2・Durable Objects などは使っていません。画像の添付を作るときは R2 を追加する想定です。

## 費用の目安

個人利用なら **0 円** の想定です。

- 自動保存は入力が止まってから 1 回だけ（既定 0.8 秒後）なので、書き込み回数は少なく済みます
- 無料枠を超えると、その日の残りはリクエストがエラーになります（自動で課金されることはありません）
- 独自ドメインを使う場合は、ドメイン代（年 1,000〜2,000 円程度）だけかかります

### CPU 時間 10ms の制限について

Workers の無料プランは 1 リクエストあたりの CPU 時間が 10ms までです。現在の処理（SHA-256 の計算と DB の読み書き）はこれに収まります。
パスワード認証を追加する場合、計算の重いハッシュ（PBKDF2・bcrypt など）は 10ms を超えるおそれがあるため、パスキー（WebAuthn）のほうが向いています。

## デプロイ

```bash
npm install
npx wrangler login
npx wrangler d1 create mdvault
# 出力された database_id を wrangler.jsonc の d1_databases[0].database_id に書く

npm run db:migrate                         # 本番 D1 にテーブル作成
openssl rand -base64 32                    # 長いランダム文字列を作る
npx wrangler secret put BOOTSTRAP_SECRET   # ↑ を貼り付け（16文字以上必須）
npm run deploy
```

`https://mdvault.<あなたのサブドメイン>.workers.dev` が発行されるので、そこにアクセスして最初のデバイスを登録します。

- `database_id` は公開されても、それだけではデータを読み書きできません（Cloudflare アカウントの認証が必要）
- 2 回目以降の更新は `npm run deploy` だけで反映されます。`migrations/` に新しいファイルが増えたときは、先に `npm run db:migrate` を実行してください

### 設定値とシークレット

| 種類 | 置き場所 | 反映方法 |
| --- | --- | --- |
| 数値の設定（[一覧](../README.md#設定)） | `wrangler.jsonc` の `vars` | `npm run deploy` |
| `BOOTSTRAP_SECRET` | Cloudflare のシークレット（ローカルは `.dev.vars`） | `npx wrangler secret put BOOTSTRAP_SECRET` |

シークレットは Git に入らず、ダッシュボードでも値は表示されません。

## 運用上の注意

- **Cloudflare アカウントに二段階認証（2FA）を設定する**。ダッシュボードや `wrangler` からは、デバイス承認と関係なく DB を読み書きできます。アカウントが最も強い鍵です。PC に残る `wrangler login` の認証情報も同様に扱ってください
- **Cloudflare Access を有効にすることを推奨**（下記）。アプリのデバイス登録画面は誰でも開けるため、他人が承認待ちの枠（既定 10 台）を埋めたり、無料枠のリクエスト数を使い切ったりできてしまいます。Access で弾いたリクエストは Worker まで届かないので、無料枠も消費しません
- **バックアップ**: D1 には無料プランでも 7 日分のポイントインタイム復元（Time Travel）がありますが、DB 全体の巻き戻しになります。定期的に書き出しておくと安心です

  ```bash
  npx wrangler d1 export mdvault --remote --output backup.sql
  ```

- **ログ**: `wrangler.jsonc` の `observability` が有効だと、リクエスト URL（ノートのパスや検索語）が Cloudflare のログに残ります。気になる場合は `false` にしてください
- **データの保管**: D1 は保存時に暗号化されますが、Cloudflare からは読める状態です。完全に秘密にしたい場合は、ブラウザ側で暗号化する設計が必要になります（検索が難しくなります）

### 全デバイスを失ったとき

承認済みデバイスが 0 台になればブートストラップが使えるようになります。`DEVICE_TTL_DAYS`（既定 90 日）待つか、次のコマンドでデバイスを全削除してください。

```bash
npx wrangler d1 execute mdvault --remote --command "DELETE FROM devices"
```

## さらに強くアクセスを制限したい場合（任意）

アプリ内のデバイス承認に加えて、Cloudflare 側の機能を重ねられます。

- **Cloudflare Access**（Zero Trust Free プラン、50 ユーザーまで無料）: アプリの前にログインを挟みます。
  Worker の Settings → Domains & Routes で、workers.dev の「Cloudflare Access」を有効にするだけでも使えます（画面の場所は Cloudflare 側の変更で変わることがあります）。
  メールのワンタイムコードや GitHub ログインなどで認証でき、WARP クライアントと組み合わせるとデバイスポスチャ（端末の状態）も確認できます
- **mTLS（クライアント証明書）**: 独自ドメインを Cloudflare に置いている場合、証明書を入れた端末からしか TLS 接続できないようにできます
- **レート制限ルール**: 独自ドメインを使う場合、WAF のレート制限ルールで大量アクセスを弾けます（無料プランでも 1 ルール使えます）

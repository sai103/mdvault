# Cloudflare 上での構成と運用

mdvault は Cloudflare の Free プランだけで動くように作っています。このファイルでは、Cloudflare 側で使っているもの・費用・デプロイ・運用上の注意をまとめます。
アプリ自体の仕組みは [README](../README.md#アーキテクチャ) を参照してください。

> 無料枠の数値は 2026 年時点の概要です。最新の値は Cloudflare 公式の料金ページで確認してください。

## 使っているサービス

| サービス | 用途 | 無料枠 |
| --- | --- | --- |
| Workers | API の処理（`src/index.ts`） | 1 日 10 万リクエスト、1 リクエストあたり CPU 時間 10ms |
| Workers 静的アセット | 画面ファイル（`public/`）の配信 | 無料 |
| D1 | ノート・履歴・デバイス・パスキー・画像のメタデータ | ストレージ 5GB、1 日あたり読み取り 500 万行・書き込み 10 万行 |
| R2 | 添付画像の本体（バケット `mdvault-files`） | ストレージ 10GB、1 か月あたり書き込み系 100 万回・読み取り系 1,000 万回、転送量は無料 |

KV・Durable Objects などは使っていません。

## 費用の目安

個人利用なら **0 円** の想定です。

- 自動保存は入力が止まってから 1 回だけ（既定 0.8 秒後）なので、書き込み回数は少なく済みます
- Workers・D1 は、無料枠を超えるとその日の残りはリクエストがエラーになります（自動で課金されることはありません）
- **R2 は無料枠を超えると課金されます**（ストレージは 1GB あたり月 0.015 ドル程度）。画像 1 枚あたりの上限は既定で 10MB（`MAX_ATTACHMENT_MB`）なので、10GB に届くのは数千枚規模です。使用量はダッシュボードの R2 の画面で確認できます
- R2 を初めて使うときは、無料枠の範囲でも支払い方法（クレジットカードなど）の登録を求められる場合があります
- 独自ドメインを使う場合は、ドメイン代（年 1,000〜2,000 円程度）だけかかります

### CPU 時間 10ms の制限について

Workers の無料プランは 1 リクエストあたりの CPU 時間が 10ms までです。現在の処理（SHA-256 の計算、パスキーの署名検証、DB の読み書き）はこれに収まる想定です。
署名の検証は Workers の WebCrypto で行うので軽い処理です。パスワード認証にしなかったのは、計算の重いハッシュ（PBKDF2・bcrypt など）が 10ms を超えるおそれがあるためです。

> 10ms の制限はローカルの `wrangler dev` では再現されません。本番で CPU 時間超過のエラー（Error 1102）が出る場合は、ダッシュボードの Worker のログで確認してください。

Worker のサイズは圧縮後約 130KB です（無料プランの上限は 3MB）。画像のアップロードは本体をそのまま R2 に保存するだけなので（形式の判定は先頭の数バイトだけ）、CPU 時間はほとんど使いません。

## デプロイ

初めてデプロイする場合は、**[docs/deploy.md](deploy.md)** の手順に沿って進めてください（アカウント作成から最初のログイン、更新・削除の方法、うまくいかないときの対処まで）。

経験者向けのコマンドの要約:

```bash
npm ci
npx wrangler login
npx wrangler d1 create mdvault --binding DB                 # database_id を wrangler.jsonc に自動で書き込む
npx wrangler r2 bucket create mdvault-files --binding FILES # 事前にダッシュボードで R2 を有効にしておく
npm run db:migrate
npm run deploy                                              # 初回は workers.dev のサブドメインを登録
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # 合言葉を作って保存しておく
npx wrangler secret put BOOTSTRAP_SECRET                    # ↑ を貼り付け（16 文字以上）
```

- `--binding` を付けないと、`wrangler.jsonc` に別の名前の設定が追加されてしまうので注意
- `database_id` は公開されても、それだけではデータを読み書きできません（Cloudflare アカウントの認証が必要）
- 2 回目以降は `npm run db:migrate` → `npm run deploy` です（[更新するとき](deploy.md#更新するとき)）

### 設定値とシークレット

| 種類 | 置き場所 | 反映方法 |
| --- | --- | --- |
| 設定値（[一覧](../README.md#設定)） | `wrangler.jsonc` の `vars` | `npm run deploy` |
| `BOOTSTRAP_SECRET` | Cloudflare のシークレット（ローカルは `.dev.vars`） | `npx wrangler secret put BOOTSTRAP_SECRET` |

シークレットは Git に入らず、ダッシュボードでも値は表示されません。

## 運用上の注意

- **Cloudflare アカウントに二段階認証（2FA）を設定する**。ダッシュボードや `wrangler` からは、デバイス承認と関係なく DB を読み書きできます。アカウントが最も強い鍵です。PC に残る `wrangler login` の認証情報も同様に扱ってください
- **Cloudflare Access を有効にすることを推奨**（下記）。アプリのデバイス登録画面は誰でも開けるため、他人が承認待ちの枠（既定 10 台）を埋めたり、無料枠のリクエスト数を使い切ったりできてしまいます。Access で弾いたリクエストは Worker まで届かないので、無料枠も消費しません
- **バックアップ**: D1 には無料プランでも 7 日分のポイントインタイム復元（Time Travel）がありますが、DB 全体の巻き戻しになります。定期的に書き出しておくと安心です

  ```bash
  npx wrangler d1 export mdvault --remote --output backup.sql
  ```

  画像の本体は R2 にあるので、D1 のバックアップには含まれません。R2 には巻き戻し機能もありません。画像もバックアップしたい場合は、
  ダッシュボードで R2 の API トークンを作り、S3 互換のツール（[rclone](https://rclone.org/) など）でバケットを手元にコピーしてください

- **ログ**: `wrangler.jsonc` の `observability` が有効だと、リクエスト URL（ノートのパスや検索語）が Cloudflare のログに残ります。気になる場合は `false` にしてください
- **データの保管**: D1・R2 は保存時に暗号化されますが、Cloudflare からは読める状態です。完全に秘密にしたい場合は、ブラウザ側で暗号化する設計が必要になります（検索が難しくなります）

### デバイスやパスキーをすべて失ったとき

Cloudflare アカウントでログインした `wrangler` から DB を直接操作して復旧します。

**承認済みデバイスをすべて失った**（パスキーは手元にある）とき: 承認済みデバイスが 0 台になればブートストラップが使えるようになります。
`DEVICE_TTL_DAYS`（既定 90 日）待つか、次のコマンドでデバイスを全削除してください。ブートストラップで承認した後、手元のパスキーでログインします。

```bash
npx wrangler d1 execute mdvault --remote --command "DELETE FROM devices; DELETE FROM sessions"
```

**パスキーをすべて失った**とき: パスキーが 0 個になると、承認済みデバイスで新しいパスキーを登録できるようになります。

```bash
npx wrangler d1 execute mdvault --remote --command "DELETE FROM passkeys; DELETE FROM sessions"
```

どちらも失ったときは、両方のコマンドを実行してから最初の 1 台と同じ手順（ブートストラップ → パスキー登録）でやり直します。
ノートと画像のデータは消えません。

## さらに強くアクセスを制限したい場合（任意）

アプリ内のデバイス承認とパスキーに加えて、Cloudflare 側の機能を重ねられます。

- **Cloudflare Access**（Zero Trust Free プラン、50 ユーザーまで無料）: アプリの前にさらにログインを挟みます。
  Worker の Settings → Domains & Routes で、workers.dev の「Cloudflare Access」を有効にするだけでも使えます（画面の場所は Cloudflare 側の変更で変わることがあります）。
  メールのワンタイムコードや GitHub ログインなどで認証でき、WARP クライアントと組み合わせるとデバイスポスチャ（端末の状態）も確認できます
- **mTLS（クライアント証明書）**: 独自ドメインを Cloudflare に置いている場合、証明書を入れた端末からしか TLS 接続できないようにできます
- **レート制限ルール**: 独自ドメインを使う場合、WAF のレート制限ルールで大量アクセスを弾けます（無料プランでも 1 ルール使えます）

# mdvault

Cloudflare 上で動く、個人用の Obsidian 風 Markdown ノートアプリ（MVP）。

- **Cloudflare Workers + 静的アセット + D1** だけで構成。個人利用なら無料枠に収まります
- **デバイス承認制**: 承認済みのデバイス（ブラウザ）からしかノートを読み書きできません

## 機能（MVP）

| 機能 | 内容 |
| --- | --- |
| ノート | 作成・編集（自動保存）・リネーム・削除。`/` 区切りでフォルダ |
| 表示 | 編集 / 分割 / 閲覧 の切替（`Ctrl+E`）、GFM（表・チェックボックス等） |
| `[[wikilink]]` | `[[ノート名]]` `[[ノート名\|別名]]` `[[ノート名#見出し]]`。存在しないリンクはクリックで新規作成 |
| リンク補完 | `[[` と入力すると候補を表示（↑↓ / Enter） |
| バックリンク・アウトライン | 右サイドバーに表示 |
| 検索 | サイドバーで全文検索、`Ctrl+P` でクイックスイッチャー（なければ作成） |
| 競合検出 | 別デバイスで先に更新されていたら、上書きか再読込かを選べる |
| 履歴 | 🕘 から過去の版を表示・復元。編集前の内容（10分ごと）、他デバイスでの上書き前、復元前の内容を、ノートごとに最新50件まで保存 |
| ゴミ箱 | ♻ から削除したノートを復元 |
| モバイル | スマホ幅ではサイドバーがドロワーになる |

ショートカット: `Ctrl/Cmd+P` 切替、`Ctrl/Cmd+S` 即時保存、`Ctrl/Cmd+E` 編集/閲覧、`Alt+N` 新規ノート

## デバイス制限のしくみ

1. 新しいブラウザでアクセスすると「デバイス登録」画面になる。登録すると、ランダムなトークンが
   `HttpOnly; Secure; SameSite=Strict` の Cookie（有効期限400日）に保存され、そのデバイスは**承認待ち**になる。
   サーバーにはトークンの SHA-256 ハッシュだけが保存される
2. 画面に 6 桁のペアリングコードが出るので、**承認済みデバイス**の「⚙ デバイス管理」でそのコードを入力して承認する
3. 最初の 1 台は、`BOOTSTRAP_SECRET` を入力して自分で承認する（ブートストラップ）。
   **承認済みデバイスが 1 台もないときだけ使える**ので、シークレットが漏れても既存の環境には入れない。
   1時間に10回失敗するとロックされる
4. 不要になったデバイスは「デバイス管理」で削除すればすぐにアクセスできなくなる
5. **90 日間使われなかった承認済みデバイスは自動で削除**される（紛失した端末が残り続けないように）

### 全デバイスを失ったとき

承認済みデバイスが 0 台になればブートストラップが使えるようになります。90 日待つか、次のコマンドでデバイスを全削除してください
（Cloudflare アカウントでログインした `wrangler` が必要）。

```bash
npx wrangler d1 execute mdvault --remote --command "DELETE FROM devices"
```

`/api/*` はすべて Worker を通り、承認済みデバイスの Cookie がなければ 401 を返します。
HTML/JS/CSS 自体は公開されていますが、ノートのデータは返しません。

> Cookie を消したりブラウザを変えたりすると別デバイス扱いになり、再承認が必要です。

## セットアップ

```bash
npm install

# ローカル開発
cp .dev.vars.example .dev.vars   # BOOTSTRAP_SECRET を設定
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

## デプロイ

```bash
npx wrangler login
npx wrangler d1 create mdvault
# 出力された database_id を wrangler.jsonc の d1_databases[0].database_id に書く

npm run db:migrate                         # 本番 D1 にテーブル作成
openssl rand -base64 32                    # 長いランダム文字列を作る
npx wrangler secret put BOOTSTRAP_SECRET   # ↑ を貼り付け（16文字以上必須）
npm run deploy
```

`https://mdvault.<あなたのサブドメイン>.workers.dev` が発行されるので、そこにアクセスして最初のデバイスを登録します。

## 費用の目安

すべて Cloudflare の Free プランで動きます（2026年時点の無料枠の概要。最新は公式の料金ページを確認してください）。

- Workers: 1日 10 万リクエスト
- D1: ストレージ 5GB、1日あたり 読み取り 500 万行 / 書き込み 10 万行
- 静的アセットの配信は無料

自動保存は入力が止まってから 0.8 秒後に 1 回なので、個人利用で上限に届くことはまずありません。

## 運用上の注意

- **Cloudflare アカウントに二段階認証（2FA）を設定する**。ダッシュボードや `wrangler` からはデバイス承認と関係なく DB を読み書きできるため、アカウントが最も強い鍵になる
- **Cloudflare Access を有効にすることを推奨**（下記）。アプリのデバイス登録画面は誰でも開けるため、
  他人が承認待ちの枠（最大10台）を埋めたり、無料枠のリクエスト数を使い切ったりできてしまう。Access で弾けば Worker まで届かない
- **バックアップ**: D1 は無料プランでも 7 日分のポイントインタイム復元（Time Travel）があるが、DB 全体の巻き戻しになる。
  定期的に `npx wrangler d1 export mdvault --remote --output backup.sql` で書き出しておくと安心
- **ログ**: `wrangler.jsonc` の `observability` が有効だと、リクエスト URL（ノートのパスや検索語）が Cloudflare のログに残る。気になる場合は `false` にする
- **セキュリティヘッダー**: 静的ファイルには `public/_headers`、API には Worker で CSP などを付けている。
  外部の画像（`https:`）は表示できるが、外部スクリプトは読み込めない

## さらに強くデバイスを制限したい場合（任意）

アプリ内の承認制に加えて、Cloudflare 側の機能を重ねられます。

- **Cloudflare Access**（Zero Trust Free プラン、50 ユーザーまで無料）: アプリの前にログインを挟む。
  Worker の Settings → Domains & Routes で workers.dev の「Cloudflare Access」を有効にするだけでも使える。
  メールのワンタイムコードや GitHub ログインなどで認証でき、WARP クライアントと組み合わせるとデバイスポスチャ（端末状態）の確認も可能
- **mTLS（クライアント証明書）**: 独自ドメインを Cloudflare に置いている場合、証明書を入れた端末からしか TLS 接続できないようにできる

## 構成

```
src/index.ts            Worker（API・デバイス認証）
public/                 フロントエンド（ビルド不要の素の JS）
  vendor/               marked / DOMPurify（npm run vendor で node_modules からコピー）
migrations/             D1 スキーマ
wrangler.jsonc          Cloudflare 設定
```

## MVP で未対応のもの / 次の候補

- 画像・添付ファイル（R2 を使うと無料枠 10GB）
- リネーム時に他ノートの `[[リンク]]` を自動で書き換える
- 空フォルダ、フォルダのリネーム、ドラッグ&ドロップ
- タグ一覧、デイリーノート、グラフビュー
- Obsidian の Vault（.md ファイル群）のインポート / エクスポート
- オフライン対応（PWA）
- エディタを CodeMirror にしてライブプレビュー化

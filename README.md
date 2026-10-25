# mdvault

Cloudflare 上で動く、個人用の Obsidian 風 Markdown ノートアプリ（MVP）。

- **Cloudflare Workers + 静的アセット + D1** だけで構成。個人利用なら無料枠に収まります
- **デバイス承認制**: 承認済みのデバイス（ブラウザ）からしかノートを読み書きできません

Cloudflare 側の構成・費用・デプロイ・運用については [docs/cloudflare.md](docs/cloudflare.md) を参照してください。

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

全デバイスを失ったときの復旧方法は [docs/cloudflare.md](docs/cloudflare.md#全デバイスを失ったとき) を参照してください。

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

## 設定

数値の設定はすべて `wrangler.jsonc` の `vars` にあります。変更したら `npm run deploy` で反映されます
（ローカルでは `wrangler dev` を再起動）。値が未設定または不正（0 以下・数値でない）のときは、API がその設定名を含むエラーを返します。

| 設定 | 既定値 | 内容 |
| --- | --- | --- |
| `DEVICE_TTL_DAYS` | 90 | この日数使われなかった承認済みデバイスを自動で削除 |
| `COOKIE_MAX_AGE_DAYS` | 400 | デバイス Cookie の有効期限（ブラウザ側の上限が 400 日） |
| `MAX_PENDING_DEVICES` | 10 | 同時に存在できる承認待ちデバイスの数 |
| `PENDING_DEVICE_TTL_HOURS` | 24 | 承認されなかったデバイスを削除するまでの時間 |
| `BOOTSTRAP_MAX_FAILURES_PER_HOUR` | 10 | ブートストラップの失敗がこの回数に達すると 1 時間ロック |
| `APPROVAL_POLL_SECONDS` | 5 | 承認待ち画面が承認状態を確認する間隔 |
| `AUTOSAVE_DELAY_MS` | 800 | 入力が止まってから自動保存するまでの時間 |
| `MAX_NOTE_CHARS` | 1000000 | 1 ノートの最大文字数（D1 の 1 行の上限は 2MB） |
| `MAX_LINKS_PER_NOTE` | 500 | 1 ノートから記録する `[[リンク]]` の最大数 |
| `REVISION_INTERVAL_MINUTES` | 10 | 通常の編集で履歴を残す最短間隔 |
| `MAX_REVISIONS_PER_NOTE` | 50 | ノートごとに残す履歴の数 |

`BOOTSTRAP_SECRET` だけはシークレットなので `vars` ではなく `wrangler secret put`（ローカルは `.dev.vars`）で設定します。
以下の説明に出てくる数値は既定値です。

## デプロイ

Cloudflare へのデプロイ手順は [docs/cloudflare.md](docs/cloudflare.md#デプロイ) を参照してください。

## アーキテクチャ

バックエンドは Cloudflare Workers 上で動く **TypeScript のファイル 1 つ（`src/index.ts`）** と、DB の **D1（SQLite）** だけです。
フレームワークは使っていません。常時起動のサーバーはなく、リクエストが来たときだけ処理が動きます。
フロントエンドはビルド不要の素の JavaScript です。

### リクエストの流れ

```
ブラウザ
  │
  ▼
Cloudflare Workers（mdvault）
  ├─ /api/* 以外 → 静的ファイル（public/ の HTML・JS・CSS）をそのまま返す
  └─ /api/*      → src/index.ts が処理
                     ├─ ① 書き込み系のリクエストは x-mdv ヘッダーを確認（CSRF 対策）
                     ├─ ② Cookie からデバイスを特定（トークンの SHA-256 で devices 表を検索）
                     ├─ ③ 承認済みでなければ 401（登録・状態確認・ブートストラップだけは通す）
                     └─ ④ 各 API の処理 → D1（SQLite）を読み書き
```

振り分けは `wrangler.jsonc` の `run_worker_first: ["/api/*"]` で決めています。
画面のファイル自体は誰でも取得できますが、データは必ず ③ のチェックを通ります。

### API

| 分類 | エンドポイント | 内容 |
| --- | --- | --- |
| デバイス（未承認でも可） | `GET /api/device` | 自分の状態・ペアリングコード・画面用の設定 |
| | `POST /api/device/register` | 登録して Cookie を発行（承認待ち） |
| | `POST /api/device/bootstrap` | 合言葉で承認（承認済みが 0 台のときだけ） |
| デバイス管理 | `GET /api/devices` / `POST /api/devices/approve` / `DELETE /api/devices` | 一覧・コードで承認・削除 |
| ノート | `GET /api/notes` | 全ノートのパス一覧 |
| | `GET` / `PUT` / `DELETE /api/note` | 取得・保存（競合検出つき）・削除 |
| | `POST /api/note/rename` | リネーム |
| リンク・検索 | `GET /api/backlinks` / `GET /api/search` | バックリンク・全文検索 |
| 履歴 | `GET /api/revisions` / `GET /api/revision` / `POST /api/note/restore` / `GET /api/trash` | 版の一覧・中身・復元・ゴミ箱 |

GET 以外のリクエストには `x-mdv: 1` ヘッダーが必要です。

### DB のテーブル

| テーブル | 中身 |
| --- | --- |
| `notes` | ノート本体。パス（例 `folder/Note.md`）・本文・作成日時・更新日時 |
| `links` | どのノートがどのノートに `[[リンク]]` しているか。保存のたびに本文から作り直す |
| `note_revisions` | 過去の版（編集前・上書き前・削除時・復元前） |
| `devices` | 登録デバイス。トークンのハッシュ・名前・状態・ペアリングコード・最終アクセス |
| `auth_failures` | ブートストラップの失敗時刻 |

定義は `migrations/` にあります。テーブルを変えるときは新しい番号の SQL ファイルを追加し、
`npm run db:migrate:local`（本番は `npm run db:migrate`）で適用します。

### 設計のポイント

- **フォルダはパス文字列で表す**: フォルダ用のテーブルはなく、`Projects/Idea.md` の `/` から画面側でツリーを組み立てる。そのため中身が空のフォルダは作れない
- **保存はノート単位で本文を丸ごと送る**（差分ではない）。ノート本体・リンク・履歴の書き込みは `DB.batch` でまとめて実行する
- **競合は更新日時で検出**: 保存時に「読んだときの `updated_at`」を送り、DB の値と違えば 409 を返す
- **リンクは Obsidian と同じ解決方法**: 大文字小文字を区別せず、`.md` は省略可。フルパスで一致しなければファイル名で探す。コードブロック内の `[[...]]` は無視する
- **検索は SQL の `LIKE`**: 全文検索用のインデックスは使っていないので、ノートが数千件を超えると遅くなる可能性がある。その場合は SQLite の全文検索機能（FTS5）への切り替えが候補
- **Markdown の表示はブラウザ側**: marked で HTML にし、DOMPurify で無害化してから表示する（XSS 対策）
- **セキュリティヘッダー**: 静的ファイルには `public/_headers`、API には Worker で CSP などを付けている。外部の画像（`https:`）は表示できるが、外部スクリプトは読み込めない
- **設定は `wrangler.jsonc` の `vars`、合言葉は `wrangler secret` で渡す**

### ディレクトリ構成

```
src/index.ts            Worker（API・デバイス認証）
public/                 フロントエンド（ビルド不要の素の JS）
  index.html / app.js / style.css
  _headers              静的ファイルに付けるセキュリティヘッダー
  vendor/               marked / DOMPurify（npm run vendor で node_modules からコピー。git 管理外）
migrations/             D1 のスキーマ（番号順に適用）
docs/cloudflare.md      Cloudflare 側の構成・費用・デプロイ・運用
wrangler.jsonc          Worker・D1・設定値（vars）
.dev.vars.example       ローカル用シークレットの見本
```

## MVP で未対応のもの / 次の候補

- 画像・添付ファイル（R2 を追加する想定）
- リネーム時に他ノートの `[[リンク]]` を自動で書き換える
- 空フォルダ、フォルダのリネーム、ドラッグ&ドロップ
- タグ一覧、デイリーノート、グラフビュー
- Obsidian の Vault（.md ファイル群）のインポート / エクスポート
- オフライン対応（PWA）
- エディタを CodeMirror にしてライブプレビュー化

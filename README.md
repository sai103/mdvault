# mdvault

Cloudflare 上で動く、個人用の Obsidian 風 Markdown ノートアプリ（MVP）。

- **Cloudflare Workers + 静的アセット + D1** だけで構成。個人利用なら無料枠に収まります
- **デバイス承認 + パスキー**: 承認済みのデバイス（ブラウザ）で、パスキー（指紋・顔認証・PIN）でログインしたときだけノートを読み書きできます

Cloudflare 側の構成・費用・デプロイ・運用については [docs/cloudflare.md](docs/cloudflare.md)、
セキュリティの前提・権限表・検査方法については [docs/security.md](docs/security.md) を参照してください。

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
| 画像 | 貼り付け・ドラッグ&ドロップ・📎 で添付。`![[画像.png]]`（`\|300` で幅指定）と `![](attachments/画像.png)` の両方で表示。🖼 で一覧・挿入・削除（どのノートでも使われていない画像がわかる） |
| モバイル | スマホ幅ではサイドバーがドロワーになる |

ショートカット: `Ctrl/Cmd+P` 切替、`Ctrl/Cmd+S` 即時保存、`Ctrl/Cmd+E` 編集/閲覧、`Alt+N` 新規ノート

## アクセス制限のしくみ

ノートを読み書きするには、**承認済みのデバイス**であることと、**パスキーでログインしている**ことの両方が必要です。

### デバイス承認

1. 新しいブラウザでアクセスすると「デバイス登録」画面になる。登録すると、ランダムなトークンが
   `HttpOnly; Secure; SameSite=Strict` の Cookie（有効期限400日）に保存され、そのデバイスは**承認待ち**になる。
   サーバーにはトークンの SHA-256 ハッシュだけが保存される
2. 画面に 6 桁のペアリングコードが出るので、**ログイン済みのデバイス**の「⚙ デバイスとパスキー」でそのコードを入力して承認する
3. 最初の 1 台は、`BOOTSTRAP_SECRET` を入力して自分で承認する（ブートストラップ）。
   **承認済みデバイスが 1 台もないときだけ使える**ので、シークレットが漏れても既存の環境には入れない。
   1時間に10回失敗するとロックされる
4. 不要になったデバイスは「⚙ デバイスとパスキー」で削除すればすぐにアクセスできなくなる
5. **90 日間使われなかった承認済みデバイスは自動で削除**される（紛失した端末が残り続けないように）

> Cookie を消したりブラウザを変えたりすると別デバイス扱いになり、再承認が必要です。

### パスキーでのログイン

1. **最初のパスキー**: パスキーが 1 つも登録されていなければ、承認されたデバイスにパスキー登録画面が出る。
   登録するとそのままログイン状態になる
2. **2 台目以降のデバイス**: 承認されるとパスキーのログイン画面が出る。iCloud キーチェーンや Google パスワードマネージャーで
   同期されたパスキー、または別の端末（QR コード）や USB セキュリティキーでログインする。
   承認されただけのデバイスは、新しいパスキーを登録できない
3. ログインすると、デバイスに紐づいたセッション Cookie が発行される（ログインのたびに新しいものに替わる）。
   **14 日間操作がなければ再ログイン**が必要（使っている間は自動で延長）。使い続けていても **90 日で再ログイン**
4. **デバイスの承認・削除、パスキーの追加・削除**の前には、もう一度パスキーでの本人確認を求める（直近 5 分以内に確認していれば不要）。
   Cookie を盗まれても、自分のパスキーやデバイスを追加されて居座られないようにするため
5. 「⚙ デバイスとパスキー」でパスキーの追加・削除、ログアウトができる。
   パスキーを削除すると、そのパスキーでログインしていたセッションはすべて無効になる。**最後の 1 つは削除できない**
6. パスキーは「本人確認あり」（指紋・顔認証・PIN）を必須にしている。サーバーには公開鍵だけが保存される

デバイスやパスキーをすべて失ったときの復旧方法は [docs/cloudflare.md](docs/cloudflare.md#デバイスやパスキーをすべて失ったとき) を参照してください。

### サーバー側のチェック

`/api/*` はすべて Worker を通り、承認済みデバイスの Cookie と有効なセッションの両方がなければ 401 を返します。
HTML/JS/CSS 自体は公開されていますが、ノートのデータは返しません。
Cookie は HTTPS では `__Host-mdv_device` / `__Host-mdv_session`（`HttpOnly; Secure; SameSite=Strict`）、ローカル開発の HTTP では `mdv_device` / `mdv_session` です。
どの状態で何ができるかの一覧（権限表）は [docs/security.md](docs/security.md#4-権限表) にあります。

## セットアップ

```bash
npm install

# ローカル開発
cp .dev.vars.example .dev.vars   # BOOTSTRAP_SECRET を設定
npm run db:migrate:local
npm run dev                      # http://localhost:8787（D1・R2 はローカルで再現される）

# テスト・検査（push すると GitHub Actions でも実行される）
npx tsc                          # 型チェック
npm test                         # 認可・セキュリティのテスト（Workers と同じランタイムで実行）
npm run audit                    # 本番で使う依存パッケージの既知の脆弱性
```

Claude Code では `/mdvault-security-review` でこのアプリ向けのセキュリティレビューを実行できます（手順は `.claude/skills/mdvault-security-review/SKILL.md`）。

## 設定

設定値はすべて `wrangler.jsonc` の `vars` にあります。変更したら `npm run deploy` で反映されます
（ローカルでは `wrangler dev` を再起動）。値が未設定または不正（数値の設定は 0 以下・数値でない、文字列の設定は空）のときは、API がその設定名を含むエラーを返します。

| 設定 | 既定値 | 内容 |
| --- | --- | --- |
| `DEVICE_TTL_DAYS` | 90 | この日数使われなかった承認済みデバイスを自動で削除 |
| `COOKIE_MAX_AGE_DAYS` | 400 | デバイス・セッション Cookie の有効期限（ブラウザ側の上限が 400 日。セッションの期限はサーバー側で管理） |
| `MAX_PENDING_DEVICES` | 10 | 同時に存在できる承認待ちデバイスの数 |
| `PENDING_DEVICE_TTL_HOURS` | 24 | 承認されなかったデバイスを削除するまでの時間 |
| `BOOTSTRAP_MAX_FAILURES_PER_HOUR` | 10 | ブートストラップの失敗がこの回数に達すると 1 時間ロック |
| `APPROVAL_POLL_SECONDS` | 5 | 承認待ち画面が承認状態を確認する間隔 |
| `SESSION_IDLE_TIMEOUT_DAYS` | 14 | パスキーでログインした後、この日数操作がなければ再ログイン |
| `SESSION_ABSOLUTE_TIMEOUT_DAYS` | 90 | 使い続けていても、ログインからこの日数で再ログイン |
| `REAUTH_WINDOW_MINUTES` | 5 | デバイスの承認・削除、パスキーの追加・削除の前に求める本人確認の有効時間 |
| `PASSKEY_CHALLENGE_TTL_SECONDS` | 300 | パスキーの登録・ログイン開始から完了までの制限時間 |
| `AUTOSAVE_DELAY_MS` | 800 | 入力が止まってから自動保存するまでの時間 |
| `MAX_NOTE_CHARS` | 1000000 | 1 ノートの最大文字数（D1 の 1 行の上限は 2MB） |
| `MAX_LINKS_PER_NOTE` | 500 | 1 ノートから記録する `[[リンク]]` の最大数 |
| `REVISION_INTERVAL_MINUTES` | 10 | 通常の編集で履歴を残す最短間隔 |
| `MAX_REVISIONS_PER_NOTE` | 50 | ノートごとに残す履歴の数 |
| `MAX_ATTACHMENT_MB` | 10 | 添付画像 1 ファイルの最大サイズ（MB） |
| `ATTACHMENT_FOLDER` | `"attachments"` | 添付画像を保存するフォルダ（文字列） |

`BOOTSTRAP_SECRET` だけはシークレットなので `vars` ではなく `wrangler secret put`（ローカルは `.dev.vars`）で設定します。
以下の説明に出てくる数値は既定値です。

## デプロイ

Cloudflare へのデプロイ手順は [docs/cloudflare.md](docs/cloudflare.md#デプロイ) を参照してください。

## アーキテクチャ

バックエンドは Cloudflare Workers 上で動く **TypeScript（`src/` の 4 ファイル）** と、DB の **D1（SQLite）**、画像を置く **R2** だけです。
Web フレームワークは使っていません。パスキーの検証には [SimpleWebAuthn](https://simplewebauthn.dev/) を使っています。常時起動のサーバーはなく、リクエストが来たときだけ処理が動きます。
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
                     ├─ ④ セッション Cookie を確認（src/passkey.ts）
                     │     ログインしていなければ 401（パスキーの登録・ログインだけは通す）
                     └─ ⑤ 各 API の処理 → D1（SQLite）を読み書き。画像の本体は R2
```

振り分けは `wrangler.jsonc` の `run_worker_first: ["/api/*"]` で決めています。
画面のファイル自体は誰でも取得できますが、データは必ず ③ と ④ のチェックを通ります。

パスキーの登録・ログインは次の流れです（WebAuthn）。

```
ブラウザ                                  Worker
  │ POST /api/passkey/…/options ───────→ │ チャレンジ（乱数）を作り、デバイスに紐づけて保存
  │ ←───────────────────── options ────── │
  │ OS のパスキー画面（指紋・顔認証・PIN）
  │ POST /api/passkey/…/verify ────────→ │ チャレンジ・オリジン・本人確認・署名を検証
  │ ←──────────── セッション Cookie ───── │ （チャレンジは使い捨て）
```

### API

| 分類 | エンドポイント | 内容 |
| --- | --- | --- |
| デバイス（未承認でも可） | `GET /api/device` | 自分の状態・ペアリングコード・画面用の設定 |
| | `POST /api/device/register` | 登録して Cookie を発行（承認待ち） |
| | `POST /api/device/bootstrap` | 合言葉で承認（承認済みが 0 台のときだけ） |
| パスキー（承認済みデバイス） | `POST /api/passkey/register/options` / `…/verify` | パスキーの登録（ログイン中、またはパスキーが 0 個のときだけ） |
| | `POST /api/passkey/login/options` / `…/verify` | パスキーでログインしてセッション Cookie を発行 |
| | `POST /api/logout` | ログアウト |
| ここから先はログイン中のみ | | |
| デバイス管理 | `GET /api/devices` / `POST /api/devices/approve` / `DELETE /api/devices` | 一覧・コードで承認・削除 |
| パスキー管理 | `GET /api/passkeys` / `DELETE /api/passkeys` | 一覧・削除（最後の 1 つは削除不可） |
| ノート | `GET /api/notes` | 全ノートのパス一覧 |
| | `GET` / `PUT` / `DELETE /api/note` | 取得・保存（競合検出つき）・削除 |
| | `POST /api/note/rename` | リネーム |
| リンク・検索 | `GET /api/backlinks` / `GET /api/search` | バックリンク・全文検索 |
| 履歴 | `GET /api/revisions` / `GET /api/revision` / `POST /api/note/restore` / `GET /api/trash` | 版の一覧・中身・復元・ゴミ箱 |
| 画像 | `GET /api/attachments`（`?refs=1` で参照数つき） / `POST /api/attachments?name=…` / `DELETE /api/attachments` | 一覧・アップロード（本文が画像そのもの）・削除 |
| | `GET /api/attachment?path=…` | 画像の取得（`<img>` から読み込む） |

GET 以外のリクエストには `x-mdv: 1` ヘッダーが必要です。
本人確認が必要な操作で確認から時間がたっていると `403` と `{"code": "reauth_required"}` を返し、画面がパスキーでの確認を求めてから同じリクエストをやり直します。

### DB のテーブル

| テーブル | 中身 |
| --- | --- |
| `notes` | ノート本体。パス（例 `folder/Note.md`）・本文・作成日時・更新日時 |
| `links` | どのノートがどのノートに `[[リンク]]` しているか。保存のたびに本文から作り直す |
| `note_revisions` | 過去の版（編集前・上書き前・削除時・復元前） |
| `devices` | 登録デバイス。トークンのハッシュ・名前・状態・ペアリングコード・最終アクセス |
| `auth_failures` | ブートストラップの失敗時刻 |
| `passkeys` | パスキーの公開鍵・署名カウンタ・名前・最終使用日時 |
| `sessions` | ログイン中のセッション。トークンのハッシュ・デバイス・使ったパスキー・期限 |
| `webauthn_challenges` | 発行中のチャレンジ（デバイス・用途ごとに 1 つ、使い捨て） |
| `attachments` | 添付画像のパス・形式・サイズ・アップロード日時（本体は R2 に同じパスで保存） |

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
- **画像は R2、一覧用のメタデータは D1**: R2 のキーと D1 の `path` は同じ。アップロード時は R2 に書いてから D1 に記録し、D1 に書けなければ R2 からも消す
- **画像の形式はファイル先頭のバイト列で判定**: ファイル名や Content-Type は信用しない。PNG / JPEG / GIF / WebP / AVIF だけを受け付け、拡張子も実際の形式に合わせる。SVG はスクリプトを含められるので受け付けない
- **画像もログイン中しか取得できない**: `<img>` の読み込みにも Cookie が付くので、ノートと同じチェックを通る。レスポンスには `sandbox` 付きの CSP を付けている
- **画像の参照は Obsidian と同じ**: `![[ファイル名]]` はファイル名だけで探す（重複したらフルパス）。同名のファイルは `名前 1.png` のように番号を付けて保存する。「使用中かどうか」はファイル名が本文に含まれるかで判定する簡易的なもの
- **画像の URL にはアップロード日時を付ける**（`&v=…`）: 同じ URL の中身は変わらないので、ブラウザに長期間キャッシュさせている
- **セッションはデバイスとパスキーの両方に紐づく**: デバイスかパスキーのどちらかを削除すると、そのセッションも無効になる
- **パスキーのユーザーは 1 人**: 個人用なのでユーザー ID は固定。同じ認証器に重複して登録されないよう、登録済みのパスキーは除外して作成する
- **設定は `wrangler.jsonc` の `vars`、合言葉は `wrangler secret` で渡す**

### ディレクトリ構成

```
src/index.ts            Worker の入口（ルーティング・デバイス認証・ノート API）
src/passkey.ts          パスキーの登録・ログインとセッション
src/attachments.ts      画像のアップロード・取得・削除（R2）
src/common.ts           設定値の読み込み・Cookie・ハッシュなどの共通処理
public/                 フロントエンド（ビルド不要の素の JS）
  index.html / app.js / style.css
  _headers              静的ファイルに付けるセキュリティヘッダー
  vendor/               marked / DOMPurify / SimpleWebAuthn（npm run vendor で node_modules からコピー。git 管理外）
migrations/             D1 のスキーマ（番号順に適用）
tests/                  認可・セキュリティのテスト（vitest + @cloudflare/vitest-pool-workers）
docs/cloudflare.md      Cloudflare 側の構成・費用・デプロイ・運用
docs/security.md        セキュリティの前提・脅威モデル・権限表・対策・検査方法・残存リスク
docs/security-review/   セキュリティレビューの記録
.claude/skills/         Claude Code 用のスキル（mdvault-security-review）
.github/workflows/      CI（型チェック・テスト・依存パッケージの脆弱性チェック）
wrangler.jsonc          Worker・D1・R2・設定値（vars）
.dev.vars.example       ローカル用シークレットの見本
```

## MVP 表記について

現在は MVP（最小限の機能で動かしてみる段階）です。**必要な機能がそろったら、README・画面・コードなど全体から「MVP」という表記を外します。**
「必要な機能」は、下の「未対応のもの / 次の候補」から必須とするものを決めて判断します。

## MVP で未対応のもの / 次の候補

- 画像以外の添付ファイル（PDF など）、画像の圧縮・リサイズ
- リネーム時に他ノートの `[[リンク]]` を自動で書き換える
- 空フォルダ、フォルダのリネーム、ドラッグ&ドロップ
- タグ一覧、デイリーノート、グラフビュー
- Obsidian の Vault（.md ファイル群）のインポート / エクスポート
- オフライン対応（PWA）
- エディタを CodeMirror にしてライブプレビュー化

## ライセンス

[0BSD](LICENSE)（BSD Zero Clause License）です。著作権表示も不要で、利用・改変・再配布・販売を含めて自由に使えます。無保証です。

デプロイ時に `public/vendor/` へコピーされるライブラリは、それぞれのライセンスに従います（marked: MIT、DOMPurify: MPL-2.0 または Apache-2.0、SimpleWebAuthn: MIT）。

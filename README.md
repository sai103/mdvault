# mdvault

Cloudflare 上で動く、個人用の Obsidian 風 Markdown ノートアプリ。

- **Cloudflare Workers + 静的アセット + D1 + R2** だけで構成。個人利用なら無料枠に収まります
- **デバイス承認 + パスキー**: 承認済みのデバイス（ブラウザ）で、パスキー（指紋・顔認証・PIN）でログインしたときだけノートを読み書きできます
- **Obsidian の Vault と行き来できる**: `[[リンク]]`・`![[埋め込み]]`・`#タグ`・frontmatter・テンプレートの書き方は Obsidian と同じ。Vault を zip で取り込み・書き出しできます

| 手順書 | 内容 |
| --- | --- |
| [docs/local-development.md](docs/local-development.md) | 自分の PC で動かす（Cloudflare のアカウント不要） |
| [docs/deploy.md](docs/deploy.md) | Cloudflare に公開する（初めての人向け） |
| [docs/cloudflare.md](docs/cloudflare.md) | Cloudflare 側の構成・費用・運用・復旧 |
| [docs/security.md](docs/security.md) | セキュリティの前提・権限表・対策・検査方法 |

## 機能

| 機能 | 内容 |
| --- | --- |
| エディタ | CodeMirror による Markdown の色分け。カーソルのない行では `#` や `**`、`[[ ]]` を隠して読みやすく表示（ライブプレビュー。設定で切り替え）。Enter でリストを続ける、`Ctrl+F` で検索 |
| 表示 | 編集 / 分割 / 閲覧 の切替（`Ctrl+E`）。GFM（表・チェックボックス等）。プレビューのチェックボックスを押すと本文の `[ ]` / `[x]` が切り替わる。frontmatter は表で表示 |
| `[[リンク]]` | `[[ノート]]` `[[ノート\|別名]]` `[[ノート#見出し]]`。`[[` で補完。存在しないリンクはクリックで新規作成。エディタでは `Ctrl`/`Cmd` + クリックで開く |
| 埋め込み | `![[ノート]]` `![[ノート#見出し]]` で別のノートを埋め込み、`![[画像.png\|300]]` で画像（幅指定） |
| 名前の変更 | ノート・フォルダの名前を変える・移動すると、**リンクしている他のノートの `[[リンク]]` も自動で書き換わる**（書き換え前の内容は履歴に残る） |
| フォルダ | 空のフォルダを作れる。「⋯」や右クリックで名前の変更・削除（中のノートはゴミ箱へ）。ドラッグ&ドロップで移動 |
| タグ | 本文の `#タグ`（`#親/子` も可）と frontmatter の `tags`。サイドバーに一覧、クリックで絞り込み。`#` で補完 |
| 検索 | 全文検索（複数の語は AND、`"語句"`、`tag:タグ`、`path:フォルダ`）。ファイル名に一致するものを上位に、一致箇所を強調。`Ctrl+P` でクイックスイッチャー |
| 今日のノート | 📅（`Alt+D`）で `daily/YYYY-MM-DD` を開く。テンプレートがあればそれで作る |
| テンプレート | `templates` フォルダのノートを 📄 から挿入。`{{title}}` `{{date}}` `{{time}}` `{{date:YYYY年MM月DD日}}` が使える |
| グラフビュー | 🕸 でノートのつながりを図にする（全体 / 開いているノートの周り）。クリックで開く |
| 画像 | 貼り付け・ドラッグ&ドロップ・📎 で添付。大きい写真は自動で縮小し、位置情報などの EXIF も取り除く。🖼 で一覧（どのノートでも使われていない画像がわかる） |
| 暗号化 | 🔒 でノートを 1 つずつ暗号化（ブラウザの中で暗号化し、サーバーには暗号文だけを保存）。開くときにパスフレーズを入力する |
| 履歴・ゴミ箱 | 🕘 で過去の版を表示・復元、♻ で削除したノートを復元 |
| 自動バックアップ | 毎日 1 回、全ノートを自動で保存（30 日分）。🗄 から日付を選び、ノートを 1 件ずつ元に戻せる |
| 取り込み・書き出し | ⇅ で Obsidian の Vault（zip）を取り込み、全ノート・画像を zip で書き出し |
| オフライン | ホーム画面に追加できる（PWA）。一度開いたノートはオフラインでも読め、オフライン中の編集は端末に残して、接続が戻ったら送る |
| 表示の設定 | 🎨 でテーマ（端末に合わせる / ライト / ダーク）・文字の大きさ・エディタの文字（通常 / 等幅） |
| 競合検出 | 別デバイスで先に更新されていたら、上書きか再読込かを選べる |
| モバイル | スマホ幅ではサイドバーがドロワーになる |

ショートカット: `Ctrl/Cmd+P` 切替、`Ctrl/Cmd+S` 即時保存、`Ctrl/Cmd+E` 編集/閲覧、`Ctrl/Cmd+Shift+F` 検索、`Alt+N` 新規ノート、`Alt+D` 今日のノート

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
   パスキーを削除すると、そのパスキーでログインしていたセッションはすべて無効になる。**最後の 1 つは削除できない**。
   ログアウトすると、この端末に残したノートのキャッシュと下書きも消える
6. パスキーは「本人確認あり」（指紋・顔認証・PIN）を必須にしている。サーバーには公開鍵だけが保存される

デバイスやパスキーをすべて失ったときの復旧方法は [docs/cloudflare.md](docs/cloudflare.md#デバイスやパスキーをすべて失ったとき) を参照してください。

### サーバー側のチェック

`/api/*` はすべて Worker を通り、承認済みデバイスの Cookie と有効なセッションの両方がなければ 401 を返します。
HTML/JS/CSS 自体は公開されていますが、ノートのデータは返しません。
Cookie は HTTPS では `__Host-mdv_device` / `__Host-mdv_session`（`HttpOnly; Secure; SameSite=Strict`）、ローカル開発の HTTP では `mdv_device` / `mdv_session` です。
どの状態で何ができるかの一覧（権限表）は [docs/security.md](docs/security.md#4-権限表) にあります。

### ノートの暗号化

- 🔒 を押してパスフレーズ（8 文字以上）を決めると、そのノートはブラウザの中で暗号化（AES-GCM、鍵はパスフレーズから PBKDF2-SHA256 で作る）され、サーバーには暗号文だけが保存される。保存のたびに暗号化し直す
- 開くときはパスフレーズを入力する。「このタブを開いている間は覚えておく」を選ぶと、タブを閉じるまで他の暗号化ノートも開ける（どこにも保存しない）
- **パスフレーズを忘れると、誰にも元に戻せない**
- 暗号化したノートは、全文検索・タグ・バックリンク・グラフの対象外になる。名前を変えても、中の `[[リンク]]` は書き換わらない
- 暗号化するときに、それまでの履歴（暗号化前の内容）を消せる。**暗号化する前の自動バックアップや書き出したファイルには、暗号化前の内容が残る**

## セットアップ

自分の PC で動かす手順（必要なもの・Windows / macOS / Linux 別のコマンド・最初のログイン・うまくいかないとき）は
**[docs/local-development.md](docs/local-development.md)** にあります。Cloudflare のアカウントは不要です。概要は次のとおりです（Node.js 22 以上が必要）。

```bash
npm ci
cp .dev.vars.example .dev.vars   # Windows の PowerShell では Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                      # http://localhost:8787 を開く（IP アドレスではパスキーが使えない）
npm run db:reset:local           # ローカルのデータを全部消してやり直す

# テスト・検査（push すると GitHub Actions でも実行される）
npx tsc                          # 型チェック
npm test                         # Worker のテスト（認可・セキュリティ・各機能。Workers と同じランタイムで実行）
npm run test:e2e                 # 画面の E2E テスト（Chromium。初回は npx playwright install chromium）
npm run audit                    # 本番で使う依存パッケージの既知の脆弱性
```

Claude Code では `/mdvault-security-review` でこのアプリ向けのセキュリティレビューを実行できます（手順は `.claude/skills/mdvault-security-review/SKILL.md`）。

## 設定

設定値はすべて `wrangler.jsonc` の `vars` にあります。変更したら `npm run deploy` で反映されます
（ローカルでは `npm run dev` を起動し直す）。値が未設定または不正（数値の設定は 0 以下・数値でない、文字列の設定は空）のときは、API がその設定名を含むエラーを返します。

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
| `MAX_TAGS_PER_NOTE` | 100 | 1 ノートから記録する `#タグ` の最大数 |
| `REVISION_INTERVAL_MINUTES` | 10 | 通常の編集で履歴を残す最短間隔 |
| `MAX_REVISIONS_PER_NOTE` | 50 | ノートごとに残す履歴の数 |
| `MAX_NOTES_PER_BULK_OPERATION` | 500 | フォルダの名前変更・削除、取り込み 1 回で扱えるノートの数 |
| `DAILY_NOTE_FOLDER` | `"daily"` | 「今日のノート」を作るフォルダ（ファイル名は `YYYY-MM-DD`） |
| `TEMPLATE_FOLDER` | `"templates"` | テンプレートを置くフォルダ |
| `DAILY_NOTE_TEMPLATE` | `"daily"` | 「今日のノート」に使うテンプレート名（`TEMPLATE_FOLDER` の中。なければ空のノート） |
| `ENCRYPTION_PBKDF2_ITERATIONS` | 600000 | ノートを暗号化するとき、パスフレーズから鍵を作る計算の回数（ブラウザで計算する。暗号文に記録されるので、変えても既存のノートは開ける） |
| `BACKUP_RETENTION_DAYS` | 30 | 毎日の自動バックアップを残す日数 |
| `MAX_ATTACHMENT_MB` | 10 | 添付画像 1 ファイルの最大サイズ（MB） |
| `IMAGE_MAX_DIMENSION` | 2560 | これより大きい写真は、アップロード前にブラウザで縮小する（長い辺のピクセル数） |
| `IMAGE_QUALITY_PERCENT` | 85 | 縮小した JPEG / WebP の画質 |
| `ATTACHMENT_FOLDER` | `"attachments"` | 添付画像を保存するフォルダ |

自動バックアップの時刻は `wrangler.jsonc` の `triggers.crons` です（既定は UTC 18:17 = 日本時間 3:17）。
`BOOTSTRAP_SECRET` だけはシークレットなので `vars` ではなく `wrangler secret put`（ローカルは `.dev.vars`）で設定します。
以下の説明に出てくる数値は既定値です。

## デプロイ

Cloudflare へのデプロイ手順は **[docs/deploy.md](docs/deploy.md)** にあります。Cloudflare を初めて使う人向けに、アカウントの作成から最初のログインまでを順に説明しています。
費用・運用上の注意は [docs/cloudflare.md](docs/cloudflare.md) を参照してください。

## アーキテクチャ

バックエンドは Cloudflare Workers 上で動く **TypeScript（`src/`）** と、DB の **D1（SQLite）**、画像とバックアップを置く **R2** だけです。
Web フレームワークは使っていません。常時起動のサーバーはなく、リクエストが来たとき（と毎日のバックアップ）だけ処理が動きます。
画面は素の JavaScript（`client/`）を esbuild で 1 つのファイル（`public/build/app.js`）にまとめています。

主なライブラリ: [CodeMirror 6](https://codemirror.net/)（エディタ）、[marked](https://marked.js.org/)（Markdown）、[DOMPurify](https://github.com/cure53/DOMPurify)（無害化）、
[SimpleWebAuthn](https://simplewebauthn.dev/)（パスキー）、[fflate](https://github.com/101arrowz/fflate)（zip）。

### リクエストの流れ

```
ブラウザ（Service Worker がアプリと読み込んだノートをキャッシュ）
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
                     └─ ⑤ 各 API の処理 → D1（SQLite）を読み書き。画像の本体とバックアップは R2

毎日 1 回（Cron Trigger）→ src/backup.ts が全ノートを gzip にして R2 に保存し、古いものを消す
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
| ノート | `GET /api/notes` | 全ノートのパス（暗号化の有無つき）とフォルダの一覧 |
| | `GET` / `PUT` / `DELETE /api/note` | 取得・保存（競合検出つき）・削除 |
| | `POST /api/note/rename` | 名前の変更・移動（リンクしているノートを書き換える） |
| フォルダ | `POST /api/folders` / `POST /api/folder/rename` / `DELETE /api/folder` | 作成・名前の変更（中のノートを移動しリンクを書き換える）・削除（中のノートはゴミ箱へ） |
| リンク・タグ・検索 | `GET /api/backlinks` / `GET /api/links` / `GET /api/tags` / `GET /api/search` | バックリンク・全リンク（グラフ用）・タグの一覧・全文検索 |
| 履歴 | `GET` / `DELETE /api/revisions` / `GET /api/revision` / `POST /api/note/restore` / `GET /api/trash` | 版の一覧・削除（暗号化したとき）・中身・復元・ゴミ箱 |
| 画像 | `GET /api/attachments`（`?refs=1` で参照数つき） / `POST /api/attachments?name=…`（`?path=…` で元のパスのまま） / `DELETE /api/attachments` | 一覧・アップロード（本文が画像そのもの）・削除 |
| | `GET /api/attachment?path=…` | 画像の取得（`<img>` から読み込む） |
| 取り込み・書き出し | `POST /api/import/notes` / `GET /api/export` | ノートをまとめて取り込む・全ノートとフォルダ・画像の一覧 |
| バックアップ | `GET /api/backups` / `POST /api/backups` / `GET /api/backup?key=…` | 一覧・今すぐ作成・中身（gzip のまま） |

GET 以外のリクエストには `x-mdv: 1` ヘッダーが必要です。
本人確認が必要な操作で確認から時間がたっていると `403` と `{"code": "reauth_required"}` を返し、画面がパスキーでの確認を求めてから同じリクエストをやり直します。

### DB のテーブル

| テーブル | 中身 |
| --- | --- |
| `notes` | ノート本体。パス（例 `folder/Note.md`）・本文・作成日時・更新日時 |
| `folders` | 明示的に作ったフォルダ（空でも表示するため） |
| `links` | どのノートがどのノートに `[[リンク]]` しているか。保存のたびに本文から作り直す |
| `tags` | どのノートにどの `#タグ` があるか。保存のたびに本文から作り直す |
| `note_revisions` | 過去の版（編集前・上書き前・削除時・復元前・リンク書き換え前・取り込みで上書きされる前） |
| `devices` | 登録デバイス。トークンのハッシュ・名前・状態・ペアリングコード・最終アクセス |
| `auth_failures` | ブートストラップの失敗時刻 |
| `passkeys` | パスキーの公開鍵・署名カウンタ・名前・最終使用日時 |
| `sessions` | ログイン中のセッション。トークンのハッシュ・デバイス・使ったパスキー・期限・最後の本人確認 |
| `webauthn_challenges` | 発行中のチャレンジ（デバイス・用途ごとに 1 つ、使い捨て） |
| `attachments` | 添付画像のパス・形式・サイズ・アップロード日時（本体は R2 に同じパスで保存） |

定義は `migrations/` にあります。テーブルを変えるときは新しい番号の SQL ファイルを追加し、
`npm run db:migrate:local`（本番は `npm run db:migrate`）で適用します。

R2 のバケット（`mdvault-files`）には、画像（`attachments/…` など、ノートと同じパス）と、自動バックアップ（`_mdvault/backups/YYYY-MM-DD.json.gz`）が入ります。
`_mdvault/` はアプリ用の領域で、画像の API からは読み書きできません。

### 設計のポイント

- **保存はノート単位で本文を丸ごと送る**（差分ではない）。ノート本体・リンク・タグ・履歴の書き込みは `DB.batch` でまとめて実行する
- **競合は更新日時で検出**: 保存時に「読んだときの `updated_at`」を送り、DB の値と違えば 409 を返す
- **リンクは Obsidian と同じ解決方法**: 大文字小文字を区別せず、`.md` は省略可。フルパスで一致しなければファイル名で探す。コードブロック内の `[[...]]` は無視する。サーバー（`src/markdown.ts`）と画面（`client/state.js`）は同じ規則
- **名前の変更でリンクを書き換える**: 移動するノートを指していたリンクだけを、元の書き方（ファイル名かフルパスか、`.md` の有無）に合わせて書き換える。ファイル名だけでは別のノートを指してしまう場合はフルパスにする。見出し（`#`）と別名（`|`）は残す
- **フォルダは「ノートのパス」と「明示的に作ったフォルダ」の両方から表示する**: 空のフォルダは `folders` テーブルにだけある
- **検索は SQL の `LIKE`** に、ファイル名の一致などで順位を付けている。日本語の 2 文字の語（「設計」など）も探せるよう、全文検索用のインデックス（FTS5 の trigram は 3 文字以上が必要）は使っていない。ノートが数千件を超えると遅くなる可能性がある
- **Markdown の表示はブラウザ側**: marked で HTML にし、DOMPurify で無害化してから表示する（XSS 対策）。`#タグ` と埋め込みは、無害化した後に要素を作って差し込む
- **エディタは Shadow DOM の中**: CodeMirror は見た目を付けるためにページへ `<style>` を追加するが、CSP（`style-src 'self'`）で止められる。Shadow DOM の中では CSP の対象外の方法（constructable stylesheet）で付けるので、CSP を緩めずに使える。エディタの見た目は `public/editor.css`
- **暗号化はブラウザの中だけ**: パスフレーズも鍵もサーバーに送らない。暗号文の先頭には Obsidian のコメント記法（`%%…%%`）の目印を付けるので、Obsidian で開いても目印は表示されない
- **オフライン**: Service Worker（`public/sw.js`）が、画面のファイルとノートの読み取り API をネットワーク優先でキャッシュする。保存できなかった変更は `localStorage` に下書きとして残し、接続が戻ったとき（と 10 秒ごと）に送る。ログアウトすると両方とも消す
- **重い処理はブラウザで**: zip の作成・展開、画像の縮小、暗号化はブラウザで行う（Workers の無料プランは CPU 時間 10ms のため）
- **セキュリティヘッダー**: 静的ファイルには `public/_headers`、API には Worker で CSP などを付けている。外部の画像（`https:`）は表示できるが、外部スクリプトは読み込めない
- **画像は R2、一覧用のメタデータは D1**: R2 のキーと D1 の `path` は同じ。アップロード時は R2 に書いてから D1 に記録し、D1 に書けなければ R2 からも消す
- **画像の形式はファイル先頭のバイト列で判定**: ファイル名や Content-Type は信用しない。PNG / JPEG / GIF / WebP / AVIF だけを受け付ける。SVG はスクリプトを含められるので受け付けない
- **画像もログイン中しか取得できない**: `<img>` の読み込みにも Cookie が付くので、ノートと同じチェックを通る。レスポンスには `sandbox` 付きの CSP を付けている
- **画像の URL にはアップロード日時を付ける**（`&v=…`）: 同じ URL の中身は変わらないので、ブラウザに長期間キャッシュさせている
- **セッションはデバイスとパスキーの両方に紐づく**: デバイスかパスキーのどちらかを削除すると、そのセッションも無効になる
- **パスキーのユーザーは 1 人**: 個人用なのでユーザー ID は固定。同じ認証器に重複して登録されないよう、登録済みのパスキーは除外して作成する
- **設定は `wrangler.jsonc` の `vars`、合言葉は `wrangler secret` で渡す**

### ディレクトリ構成

```
src/                    Worker（サーバー側）
  index.ts              入口（ルーティング・デバイス認証・毎日のバックアップ）
  notes.ts              ノート・フォルダ・リンクの書き換え・検索・タグ・取り込み・書き出し
  markdown.ts           本文の解析（リンク・タグの抽出、リンクの書き換え）
  passkey.ts            パスキーの登録・ログインとセッション
  attachments.ts        画像のアップロード・取得・削除（R2）
  backup.ts             自動バックアップ（R2）
  common.ts             設定値の読み込み・Cookie・ハッシュなどの共通処理
client/                 画面のコード（npm run build で public/build/app.js にまとめる）
  main.js               入口（各機能をつなぐ）
  notes.js              ノートを開く・保存する（下書き・暗号化を含む）
  editor.js             エディタ（CodeMirror）
  render.js             プレビュー（marked + DOMPurify、埋め込み、タグ）
  tree.js / search.js / history.js / attachments.js / vault.js / daily.js / graph.js / prefs.js / auth.js / pwa.js / crypto.js
public/                 そのまま配信するファイル
  index.html / style.css / editor.css
  sw.js                 Service Worker（オフライン）
  manifest.webmanifest / icons/   PWA（ホーム画面に追加）
  _headers              静的ファイルに付けるセキュリティヘッダー
  build/                npm run build で作るファイル（Git 管理外。同梱ライブラリのライセンス表記 app.js.LEGAL.txt も）
migrations/             D1 のスキーマ（番号順に適用）
tests/                  Worker のテスト（vitest + @cloudflare/vitest-pool-workers）
e2e/                    画面の E2E テスト（Playwright）
scripts/                ビルド・開発サーバー・E2E 用サーバー・ローカルデータの削除
docs/                   手順書・セキュリティ方針・レビューの記録
.claude/skills/         Claude Code 用のスキル（mdvault-security-review）
.github/                CI（型チェック・テスト・E2E・依存パッケージ・秘密情報）と Dependabot
wrangler.jsonc          Worker・D1・R2・Cron・設定値（vars）
.dev.vars.example       ローカル用シークレットの見本
```

## 今後の候補

- 画像以外の添付ファイル（PDF など）
- 複数のノートを同時に開く（タブ・分割表示）
- ノートの一部（ブロック）への参照 `[[ノート#^id]]`
- 暗号化したノートの中のリンクの書き換え

## ライセンス

[0BSD](LICENSE)（BSD Zero Clause License）です。著作権表示も不要で、利用・改変・再配布・販売を含めて自由に使えます。無保証です。

`npm run build` で `public/build/app.js` にまとめるライブラリは、それぞれのライセンスに従います（CodeMirror・marked・SimpleWebAuthn・fflate: MIT、DOMPurify: MPL-2.0 または Apache-2.0）。
ビルド時に、まとめたすべてのライブラリのライセンス本文を `public/build/THIRD_PARTY_LICENSES.txt` に書き出し、アプリと一緒に配信します（`/build/THIRD_PARTY_LICENSES.txt`）。

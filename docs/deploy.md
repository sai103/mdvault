# Cloudflare へのデプロイ手順（初めての人向け）

mdvault を Cloudflare に公開して、スマートフォンや外出先の PC からも使えるようにする手順です。
Cloudflare を使ったことがない人でも、上から順に進めれば終わるように書いています。

- **所要時間**: 30 分ほど
- **費用**: 個人利用なら 0 円の想定。ただし画像の保存先（R2）を有効にするときに、クレジットカードなどの登録を求められる場合があります（無料枠を超えなければ請求はありません）。詳しくは [docs/cloudflare.md](cloudflare.md#費用の目安)
- **完成すると**: `https://mdvault.<あなたが決める名前>.workers.dev` でアプリが開けるようになります

> コマンドは、mdvault のフォルダで実行します（ターミナル・PowerShell で `cd mdvault` してから）。
> ここに出てくるコマンドは Windows / macOS / Linux で共通です（違うところは個別に書いています）。

## 全体の流れ

| # | やること | 場所 |
| --- | --- | --- |
| 0 | 手元の PC の準備 | PC |
| 1 | Cloudflare のアカウントを作る | ブラウザ |
| 2 | R2（画像の保存先）を有効にする | ブラウザ |
| 3 | Wrangler で Cloudflare にログインする | PC |
| 4 | データベース（D1）を作る | PC |
| 5 | 画像の保存先（R2 バケット）を作る | PC |
| 6 | データベースにテーブルを作る | PC |
| 7 | アプリを公開する（デプロイ） | PC |
| 8 | 合言葉（`BOOTSTRAP_SECRET`）を設定する | PC |
| 9 | 公開したアプリに最初のログインをする | ブラウザ |
| 10 | 公開後にやっておくこと | ブラウザ |

---

## 0. 手元の PC の準備

[docs/local-development.md](local-development.md) の **1〜3**（Node.js 22 以上のインストール、ソースコードの取得、`npm ci`）を済ませてください。
できれば 4〜7 まで進めて、ローカルで一度動かしておくと安心です（デプロイには必須ではありません）。

ほかに用意するもの:

- **パスワードマネージャー**（またはメモを安全に保管できる場所）: 手順 8 で作る合言葉を保存します
- **パスキーを使える端末**: Windows Hello、Mac の Touch ID、スマートフォンなど

## 1. Cloudflare のアカウントを作る

1. ブラウザで <https://dash.cloudflare.com/sign-up> を開き、メールアドレスとパスワードで登録する
2. 届いた確認メールのリンクを開く
3. **二段階認証（2FA）を有効にする**: ダッシュボード右上のアカウントのアイコンから「プロフィール」（My Profile）を開き、「認証」（Authentication）の項目で設定します

> **2FA は必ず設定してください。** Cloudflare のアカウントに入られると、アプリのパスキーと関係なく、すべてのノートを読み書きできてしまいます。

ドメイン（独自の URL）を持っていなくても大丈夫です。`workers.dev` という Cloudflare の URL を無料で使います。

## 2. R2（画像の保存先）を有効にする

画像の添付に使う R2 は、最初に一度だけダッシュボードで有効にする必要があります。

1. ダッシュボードの左のメニューから「R2 Object Storage」を開く（見つからなければ、上部の検索欄で「R2」と検索）
2. 案内に従って R2 を有効にする（支払い方法の登録を求められたら登録する）

無料枠は、保存 10GB・書き込み系 1 か月 100 万回・読み取り系 1 か月 1,000 万回で、転送量は無料です。
**R2 は無料枠を超えると課金されます**（Workers や D1 は止まるだけで課金されません）。個人のノートの画像なら、まず届きません。

画面の名前や場所は Cloudflare 側の変更で変わることがあります。

## 3. Wrangler で Cloudflare にログインする

Wrangler は Cloudflare を操作するコマンドで、`npm ci` で一緒に入っています。

```bash
npx wrangler login
```

ブラウザが開き、Wrangler にアカウントの操作を許可するか聞かれるので「Allow」（許可）を押します。ターミナルに `Successfully logged in.` と出れば完了です。

確認:

```bash
npx wrangler whoami
```

自分のメールアドレスとアカウント名が表示されれば OK です。

- ブラウザが自動で開かないときは、ターミナルに表示された URL を自分でブラウザに貼り付けます
- ログイン情報は PC に保存されます。**他人と共有している PC では作業しないでください**（このログイン情報でもすべてのデータを操作できます）

## 4. データベース（D1）を作る

```bash
npx wrangler d1 create mdvault --binding DB
```

`✅ Successfully created DB 'mdvault'` のように表示されます。
`--binding DB` を付けているので、作られたデータベースの ID（`database_id`）が `wrangler.jsonc` に自動で書き込まれます。

確認: `wrangler.jsonc` の `d1_databases` の `database_id` が `00000000-0000-…` 以外の値になっていれば OK です。

- `wrangler.jsonc` は、このとき Wrangler によってインデントなどが整形し直されます（中身とコメントは変わりません）
- **`--binding DB` を付け忘れないでください。** 付けないと「設定ファイルに追加しますか？」と聞かれ、そのまま進めると別の名前の設定が増えて、アプリがデータベースを見つけられなくなります。付け忘れた場合は「うまくいかないとき」を参照
- `database_id` は Git に入って公開されても問題ありません（ID だけではデータを読み書きできません）

## 5. 画像の保存先（R2 バケット）を作る

```bash
npx wrangler r2 bucket create mdvault-files --binding FILES
```

`✅ Created bucket 'mdvault-files' …` と表示されれば OK です。こちらも `--binding FILES` を付けてください（理由は手順 4 と同じです）。

## 6. データベースにテーブルを作る

```bash
npm run db:migrate
```

`About to apply 5 migration(s) … continue?` と聞かれたら `y` を押します。表の各行に ✅ が付けば完了です。

## 7. アプリを公開する（デプロイ）

```bash
npm run deploy
```

**初めてのときだけ**、`workers.dev` のサブドメイン（URL の一部になる名前）を登録するか聞かれます。

1. `Would you like to register a workers.dev subdomain now?` → `y`
2. 好きな名前を入力する（例: `taro-notes`）。Cloudflare 全体で重複しない名前が必要です
   - URL に含まれるので、知られて困る情報（本名・メールアドレスなど）は避けてください

最後に次のように表示されれば公開完了です。この URL を控えておきます。

```
Deployed mdvault triggers
  https://mdvault.taro-notes.workers.dev
```

> サブドメインを登録した直後は、URL が使えるようになるまで数分かかることがあります。

## 8. 合言葉（BOOTSTRAP_SECRET）を設定する

最初の 1 台を承認するための合言葉を作り、Cloudflare に保存します。

### 8-1. 合言葉を作る

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

ランダムな文字列（43 文字）が表示されます。**パスワードマネージャーなどに保存してください。** 手順 9 で使い、デバイスをすべて失ったときの復旧にも使います。

### 8-2. Cloudflare に保存する

```bash
npx wrangler secret put BOOTSTRAP_SECRET
```

`Enter a secret value:` と聞かれるので、8-1 の文字列を貼り付けて Enter を押します。
**貼り付けても画面には何も表示されません**（見えないようにしているだけです）。`✨ Success! Uploaded secret BOOTSTRAP_SECRET` と出れば完了です。公開中のアプリにすぐ反映されます。

- 合言葉は Git にもダッシュボードにも表示されません。忘れた場合は、新しく作って同じコマンドで上書きできます
- `.dev.vars`（ローカル用）の値は本番では使われません。本番用には必ず新しく作ってください

## 9. 公開したアプリに最初のログインをする

1. 手順 7 の URL（`https://mdvault.〜.workers.dev`）をブラウザで開く
2. デバイス名を確認して「このデバイスを登録」
3. 承認待ちの画面で「最初の1台の場合（ブートストラップ）」を開き、手順 8 の合言葉を貼り付けて「承認する」
4. パスキーの登録画面で「パスキーを登録」を押し、指紋・顔認証・PIN などを行う
5. ノートの画面が開けば完了です

### 2 台目以降のデバイス（スマートフォンなど）

1. 2 台目で同じ URL を開き、「このデバイスを登録」→ 6 桁のコードが表示される
2. 1 台目で「⚙ デバイスとパスキー」を開き、2 台目の行にそのコードを入力して「承認」（パスキーでの確認を求められます）
3. 2 台目にパスキーのログイン画面が出るので、ログインする
   - iCloud キーチェーンや Google パスワードマネージャーで同期されたパスキーなら、そのまま使えます
   - 同期されていない場合は、1 台目の近くで QR コードを使ってログインするか、ログイン後に「パスキーを追加」で 2 台目用のパスキーを登録します

## 10. 公開後にやっておくこと

どれも推奨です。理由は [docs/cloudflare.md](cloudflare.md#運用上の注意) と [docs/security.md](security.md) にあります。

- [ ] **Cloudflare Access を有効にする**: アプリの前にもう一段ログインを挟み、知らない人がアプリの画面に届かないようにします。Worker の設定画面（Settings → Domains & Routes）で、workers.dev の「Cloudflare Access」を有効にします（無料。画面の場所は変わることがあります）
- [ ] **2FA が有効になっているか確認する**（手順 1）
- [ ] **バックアップの方法を決める**: `npx wrangler d1 export mdvault --remote --output backup.sql` でノートを書き出せます（`backup.sql` には全ノートが入るので、扱いに注意。`.gitignore` 済み）
- [ ] **ログの扱いを決める**: ノートのパスや検索語が Cloudflare のログに残ります。不要なら `wrangler.jsonc` の `observability` を `false` にしてデプロイし直します

---

## 更新するとき

GitHub のコードが新しくなったら、次の順に実行します。

```bash
git pull
npm ci
npm run db:migrate   # 新しいテーブルの変更がなければ「No migrations to apply!」と出るだけ
npm test             # 任意。問題がないか確認する
npm run deploy
```

設定値（`wrangler.jsonc` の `vars`）を変えたときも `npm run deploy` で反映されます。設定の一覧は [README](../README.md#設定) にあります。

## うまくいかないとき

| 症状 | 対処 |
| --- | --- |
| `You are not authenticated` / `Not logged in` | 手順 3 の `npx wrangler login` をやり直す |
| `wrangler login` でブラウザが開いても先に進まない | ログインの結果は PC の中（`localhost`）に戻ってくる仕組みです。リモートの PC や一部の WSL 環境では届かないことがあるので、ブラウザを使える PC で直接作業してください |
| `d1 create` で「同じ名前のデータベースがある」 | 以前に作ったものが残っています。`npx wrangler d1 list` で `mdvault` の ID を確認し、`wrangler.jsonc` の `database_id` に手で書き込む |
| `--binding` を付け忘れて、`wrangler.jsonc` に `mdvault` や `mdvault_files` という名前の設定が増えた | 増えたほうのブロックを削除し、元からある `"binding": "DB"`（または `"FILES"`）のほうの `database_id` に新しい ID を書く |
| R2 のコマンドで「R2 を有効にしてください」という趣旨のエラー（`code: 10042` など） | 手順 2 をやり直す |
| `r2 bucket create` で「同じ名前のバケットがある」 | 以前に作ったものが残っています。そのまま次の手順へ進んで問題ありません |
| `npm run db:migrate` でデータベースが見つからないという趣旨のエラー（`Couldn't find a D1 DB …` など） | `wrangler.jsonc` の `database_id` が `00000000-…` のままか、別のアカウントの ID です。手順 4 を確認する |
| デプロイで `You need to register a workers.dev subdomain` | 質問に `y` で答えて名前を登録する。ダッシュボードの「Workers & Pages」からも登録できます |
| 公開した URL を開くとエラーページや「見つかりません」と出る | サブドメインの登録直後は反映に数分かかります。少し待ってから開き直す |
| 画面に「BOOTSTRAP_SECRET が未設定か短すぎます」 | 手順 8 をやり直す（16 文字以上が必要） |
| 「シークレットが違います」 | 8-1 で保存した文字列を、前後に空白が入らないように貼り付け直す。1 時間に 10 回間違えると 1 時間ロックされます |
| 「承認済みのデバイスがあるため使えません」 | 合言葉は、承認済みのデバイスが 1 台もないときだけ使えます。承認済みのデバイスから 6 桁のコードで承認してください |
| 画面に「接続できません: internal error」 | 手順 6 を忘れている可能性があります。`npm run db:migrate` を実行する。直らなければ、ダッシュボードの Worker の「ログ」（Logs）でエラーを確認する |
| ダッシュボードのログに `Error 1102`（CPU 時間の超過） | 無料プランの 1 回あたり 10ms の制限を超えています。どの操作で起きたかを記録して、Issue などで報告してください |
| デバイスやパスキーをすべて失った | [docs/cloudflare.md の復旧手順](cloudflare.md#デバイスやパスキーをすべて失ったとき) |

## 使うのをやめるとき（削除）

**削除するとノートと画像は元に戻せません。** 必要なら先にバックアップを取ってください。

```bash
npx wrangler d1 export mdvault --remote --output backup.sql   # ノートのバックアップ（任意）
npx wrangler delete                                          # アプリ（Worker）を削除
npx wrangler d1 delete mdvault                               # データベースを削除
npx wrangler r2 bucket delete mdvault-files                  # 画像の保存先を削除
```

それぞれ確認を求められたら `y` で答えます。R2 のバケットは、中に画像が残っていると削除できません。先にダッシュボードの R2 の画面でバケットを開き、中身を削除してから実行してください。

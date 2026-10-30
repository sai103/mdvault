# ローカル開発環境の構築

自分の PC だけで mdvault を動かす手順です。**Cloudflare のアカウントは不要**です。
Worker の実行環境（workerd）と D1・R2 は、Wrangler がローカルで再現します。データは PC の中（`.wrangler/state/`）にだけ保存されます。

Cloudflare へのデプロイは [docs/deploy.md](deploy.md) を参照してください。

## 1. 必要なもの

| もの | バージョン | 備考 |
| --- | --- | --- |
| OS | Windows 10 / 11（x64）、macOS、Linux（x64 / arm64） | Wrangler の実行環境の対応範囲。Windows の ARM 版は非対応 |
| Node.js | **22 以上** | npm も一緒に入る（npm 10 以上） |
| Git | 最近のもの | |
| ブラウザ | Chrome / Edge / Safari / Firefox の最新版 | パスキーを使うため |
| パスキーを保存できるもの | どれか 1 つ | Windows Hello、Mac の Touch ID・iCloud キーチェーン、Google パスワードマネージャー、スマートフォン（QR コードで連携）、USB セキュリティキーなど |

### Node.js のインストール

すでに入っている場合は、バージョンが 22 以上か確認してください。

```bash
node -v   # v22.x.x 以上
npm -v    # 10.x.x 以上
```

入っていない、または古い場合:

- **Windows**（PowerShell）: `winget install OpenJS.NodeJS.LTS`、または [nodejs.org](https://nodejs.org/) の LTS 版のインストーラー
- **macOS**: `brew install node`、または [nodejs.org](https://nodejs.org/) のインストーラー
- **Linux**: ディストリビューションのパッケージは古いことが多いので、[nodejs.org](https://nodejs.org/) の手順か、fnm・nvm などのバージョン管理ツールを使う

リポジトリには `.node-version`（22）を置いているので、fnm などは自動でこのバージョンを使います。

> **Windows で `npm.ps1 を読み込むことができません` と出る場合**: PowerShell のスクリプト実行が制限されています。
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行するか、`npm` の代わりに `npm.cmd` と入力してください。

## 2. ソースコードを取得する

```bash
git clone https://github.com/sai103/mdvault.git
cd mdvault
```

## 3. 依存パッケージをインストールする

```bash
npm ci
```

`package-lock.json` のとおりのバージョンが入ります。`.npmrc` に `legacy-peer-deps=true` を設定済みなので、追加のオプションは不要です。

## 4. ローカル用のシークレットを用意する

最初の 1 台を承認するための合言葉（`BOOTSTRAP_SECRET`）を、見本からコピーして作ります。

```bash
# macOS / Linux
cp .dev.vars.example .dev.vars
```

```powershell
# Windows（PowerShell）
Copy-Item .dev.vars.example .dev.vars
```

中身は `BOOTSTRAP_SECRET=local-dev-secret-change-me` です。ローカルではこのままでも動きます（16 文字以上が必要）。
`.dev.vars` は `.gitignore` に入っているので Git には入りません。**本番の合言葉をここに書かないでください。**

## 5. ローカルの DB を作る

```bash
npm run db:migrate:local
```

`migrations/` の SQL が順番に適用され、`.wrangler/state/` にローカルの D1 が作られます。
`About to apply 6 migration(s) … continue?` と聞かれたら `y` を押します。

## 6. 起動する

```bash
npm run dev
```

画面のコード（`client/`）を `public/build/app.js` にまとめてから、Wrangler が起動します。
`Ready on http://localhost:8787` と出たら、ブラウザで **http://localhost:8787** を開きます。止めるときは `Ctrl + C` です。

> **`127.0.0.1` や `192.168.x.x` ではなく、必ず `localhost` で開いてください。** パスキーはドメイン名に結びつく仕組みで、IP アドレスでは作れません。
> また、パスキーなどのブラウザの機能は HTTPS か `localhost` でしか使えません。

## 7. 最初のログイン

1. 「このデバイスを登録」を押す
2. 承認待ちの画面で「最初の1台の場合（ブートストラップ）」を開き、`.dev.vars` の `BOOTSTRAP_SECRET` の値を入力して「承認する」
3. パスキーの登録画面で「パスキーを登録」を押し、OS の画面で指紋・顔認証・PIN などを行う
4. ノートの画面が開けば完了

ローカルで作ったパスキーは `localhost` 用で、本番のものとは別です。不要になったら、OS やパスワードマネージャーのパスキー一覧から削除できます。

2 台目のデバイスを試したい場合は、別のブラウザ（またはシークレットウィンドウ）で開くと別デバイスとして扱われます。

## 8. 開発の進め方

- **サーバーのコード（`src/`）を変更**すると、Wrangler が自動で Worker を再読み込みします
- **画面のコード（`client/`）を変更**すると、自動で `public/build/app.js` が作り直されます。ブラウザを再読み込みしてください
- **`public/` の HTML・CSS を変更**したら、ブラウザを再読み込みします
- 画面が古いまま変わらないときは、Service Worker のキャッシュが残っていることがあります。ブラウザの開発者ツールの「Application」→「Service Workers」で「Update on reload」をオンにするか、スーパーリロード（`Ctrl + Shift + R`）してください
- **設定（`wrangler.jsonc` の `vars`）を変更**したら、`npm run dev` を止めて起動し直します
- **一時的に設定を変えて試す**: `npm run dev -- --var 設定名:値` で起動します（例: 本人確認の有効時間を短くして試す `npm run dev -- --var REAUTH_WINDOW_MINUTES:0.1`）
- **毎日の自動バックアップを試す**: ローカルでは自動では動きません。`npm run dev` を起動したまま、別のターミナルで `curl "http://localhost:8787/cdn-cgi/local/scheduled"` を実行します（画面の 🗄 の「今すぐバックアップ」でも作れます）
- **DB のテーブルを変更**するときは、`migrations/` に新しい番号の SQL を追加して `npm run db:migrate:local` を実行します
- **画面のファイルだけを作る**: `npm run build`（`npm run dev` と `npm run deploy` は自動で実行します）

## 9. テストと検査

```bash
npx tsc            # 型チェック
npm test           # Worker のテスト（認可・セキュリティ・各機能）
npm run test:e2e   # 画面の E2E テスト（ブラウザで実際に操作する）
npm run audit      # 本番で使う依存パッケージの既知の脆弱性
```

- `npm test` は、開発サーバーとは別の、テスト専用の一時的な D1・R2 を使います。`npm run dev` を起動していなくても動き、ローカルのデータにも影響しません
- `npm run test:e2e` は、テスト用のサーバー（ポート 8788、データは `.wrangler/e2e/`）を自分で起動して、Chromium で画面を操作します。パスキーは Chromium の仮想認証器で代用します。
  初めて実行する前に、テスト用のブラウザを入れてください: `npx playwright install chromium`（Linux で必要なライブラリが足りない場合は `npx playwright install --with-deps chromium`）
  - 失敗したときは `test-results/` に画面の様子（スクリーンショット・操作の記録）が残ります。`npx playwright show-trace test-results/…/trace.zip` で見られます
同じ内容が GitHub に push したときにも自動で実行されます（`.github/workflows/ci.yml`）。

セキュリティの確認方法の詳細は [docs/security.md](security.md) を参照してください。

## 10. ローカルのデータ

ノート・デバイス・パスキー・画像は、すべて `.wrangler/state/` に保存されます（Git には入りません）。

### 中身を見る

**`npm run dev` を止めてから**実行してください（起動中だと応答しないことがあります）。

```bash
npx wrangler d1 execute mdvault --local --command "SELECT path, updated_at FROM notes"
```

### 全部消して最初からやり直す

```bash
npm run db:reset:local
```

`.wrangler/state/` を削除してテーブルを作り直します。ブラウザの Cookie は残りますが、サーバー側にデバイスがなくなるので、次に開いたときは登録画面から始まります。

## 11. スマートフォンなど他の端末から試す

`npm run dev` は、この PC の中（`localhost`）からの接続だけを受け付けます。
`npm run dev -- --ip 0.0.0.0` で起動すれば、同じ Wi-Fi の端末から `http://<PC の IP アドレス>:8787` で開けますが、HTTPS でも `localhost` でもないため、**パスキーが使えず、ログインできません**（画面にもその旨が表示されます）。

他の端末から試したい場合は、次のどちらかにします。

- **Cloudflare にデプロイする**（[docs/deploy.md](deploy.md)）。無料枠で動きます。こちらがおすすめです
- **一時的に HTTPS のトンネルを張る**（この手順は動作を確認していません）: Cloudflare の `cloudflared` をインストールし、`npm run dev` を起動したまま `cloudflared tunnel --url http://localhost:8787` を実行すると、`https://〜.trycloudflare.com` の URL が発行されます。パスキーはその URL に結びつくので、トンネルを張り直して URL が変わると、もう一度登録が必要です
  - **トンネルを張っている間は、ローカルの開発サーバーがインターネットに公開されます。** デバイス承認とパスキーで守られてはいますが、使い終わったらすぐに止めてください

## 12. うまくいかないとき

| 症状 | 原因と対処 |
| --- | --- |
| `npm ci` で `ERESOLVE` や `Cannot read properties of null (reading 'edgesOut')` | npm の依存解決の問題。リポジトリ直下の `.npmrc` があるか確認し、npm を 10 以上にする |
| `wrangler` が起動しない・`Unsupported engine` | Node.js が古い。22 以上にする |
| `Address already in use`（8787 番ポートが使用中） | 別の開発サーバーが動いている。止めるか、`npm run dev -- --port 8788` で別のポートを使う（開く URL も変わる） |
| 画面に「接続できません: internal error」、ターミナルに `no such table: 〜` | DB を作っていない。`npm run db:migrate:local` を実行してから `npm run dev` を起動し直す |
| 「BOOTSTRAP_SECRET が未設定か短すぎます」 | `.dev.vars` がない、または値が 16 文字未満。作ってから `npm run dev` を起動し直す |
| 「wrangler.jsonc の vars.〜 が未設定か不正です」 | `wrangler.jsonc` の該当する設定を確認する（数値は 0 より大きく、文字列は空でないこと） |
| 「承認済みのデバイスがあるため使えません」でブートストラップできない | 以前に承認したデバイスが残っている（Cookie を消した、別のブラウザで開いたなど）。ローカルなら `npm run db:reset:local` で最初からやり直すのが簡単 |
| 「IP アドレス（127.0.0.1）ではパスキーを使えません」「〜 is an invalid domain」 | `http://localhost:8787` で開き直す |
| 「パスキーは HTTPS か localhost でしか使えません」 | 他の端末から IP アドレスで開いている。「11. スマートフォンなど他の端末から試す」を参照 |
| パスキーの登録・ログインの画面が出ない、失敗する | Linux ではパソコン自体にパスキーを保存できないことが多いので、スマートフォン（QR コード）や USB セキュリティキー、パスワードマネージャーを使う |
| 「このブラウザはパスキーに対応していません」 | ブラウザを最新版にする |
| 画面が真っ白・`/build/app.js` が見つからない | `public/build/` がない。`npm run build` を実行する（`npm run dev` なら自動） |
| 画面を変更したのに反映されない | Service Worker のキャッシュ。スーパーリロード（`Ctrl + Shift + R`）する。「8. 開発の進め方」も参照 |
| `npm run test:e2e` で `Executable doesn't exist` | テスト用のブラウザが入っていない。`npx playwright install chromium` |
| `npm run test:e2e` で `Address already in use`（8788） | 前回のテスト用サーバーが残っている。止めるか、PC を再起動する |
| `wrangler d1 execute --local` が終わらない | `npm run dev` を止めてから実行する |
| ターミナルに `Unable to fetch the Request.cf object!` と出る | インターネットに接続できないときの警告。ローカルでの動作には影響しない |

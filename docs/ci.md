# CI（自動チェック）の解説

mdvault では、GitHub に push したときやプルリクエストを作ったときに、**GitHub Actions** がコードを自動で検査します。これを CI（継続的インテグレーション）と呼びます。
この資料では、CI が何を・いつ・どのように確認しているか、失敗したときにどうすればよいかを説明します。

| ファイル | 内容 |
| --- | --- |
| `.github/workflows/ci.yml` | CI の本体（何を実行するか） |
| `.github/dependabot.yml` | 依存パッケージの更新を自動で提案する設定 |
| `.gitleaksignore` | 秘密情報の検査で、誤検知として除外するもの |
| `playwright.config.mjs` | 画面の E2E テストの設定 |
| `vitest.config.mts` | Worker のテストの設定 |

テストの中身（どの機能をどのテストで確かめているか）は [test-scenarios.md](test-scenarios.md) を参照してください。

## 1. 全体像

```
push（main）／プルリクエスト
        │
        ▼
┌─────────────────────── GitHub Actions（3 つのジョブが同時に動く） ───────────────────────┐
│                                                                                              │
│  ① 型チェック・Worker のテスト・依存パッケージ   ② 画面の E2E テスト        ③ 秘密情報の混入   │
│     tsc → npm test → npm audit → build           Chromium で画面を操作       gitleaks          │
│     （約 30 秒）                                 （約 2〜3 分）              （約 10 秒）       │
│                                                                                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
すべて成功 → ✅（プルリクエストならマージしてよい）／ どれか失敗 → ❌（原因を直す）
```

- **CI はデプロイしません。** 検査だけを行い、Cloudflare には何も送りません。本番への反映は、これまでどおり手元で `npm run deploy` を実行します（[deploy.md](deploy.md)）
- 3 つのジョブは互いに独立していて、並行して動きます。1 つが失敗しても、他のジョブは最後まで実行されます

### いつ動くか

| きっかけ | 動くか |
| --- | --- |
| `develop` ブランチへの push | 動く |
| プルリクエストの作成・更新（`develop` → `main`、Dependabot のものを含む） | 動く |
| `main` へのマージ | 動く（念のため、マージした後の状態をもう一度確認する） |
| それ以外のブランチへの push だけ | 動かない（プルリクエストを作ると動く） |
| 手動での実行 | 設定していない |

## ブランチの運用

```
develop ──●──●──●───────●──●──→   普段の作業・Dependabot の更新はここ（push のたびに CI）
              \           \
               プルリクエスト  プルリクエスト（CI がすべて成功したらマージ）
                 \           \
main ─────────────●───────────●──→   常に CI を通った状態。デプロイと git clone はここから
```

| ブランチ | 役割 | 直接 push |
| --- | --- | --- |
| `main` | 安定版。CI を通ったものだけが入る。デプロイ（`npm run deploy`）と、[deploy.md](deploy.md)・[local-development.md](local-development.md) の `git clone` はここを使う。GitHub の既定のブランチ | **しない**（ブランチ保護で禁止する） |
| `develop` | 作業用。変更はすべてここに push する。Dependabot の更新もここに来る | する |

### 普段の流れ

1. `develop` で変更して push する → CI が動く
2. CI がすべて成功したら、GitHub で `develop` → `main` のプルリクエストを作る（いくつかの変更をまとめてもよい）
3. プルリクエストの CI がすべて成功したら、**「Create a merge commit」でマージする**
4. 本番に反映するときは、`main` を取得してからデプロイする（`git checkout main && git pull && npm run deploy`）

> マージは「Squash and merge」ではなく「Create a merge commit」を使います。Squash すると main と develop の履歴が別物になり、次のプルリクエストで同じ変更が何度も差分に出たり、競合したりするためです。

### main のブランチ保護を設定する（最初に 1 回）

GitHub の設定画面で行います。公開リポジトリなら無料です。

1. リポジトリの **Settings** → 左の **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**
2. 次のように設定する

   | 項目 | 設定 |
   | --- | --- |
   | Ruleset Name | `main を保護`（任意） |
   | Enforcement status | **Active** |
   | Bypass list | **空のまま**（管理者の自分も含め、誰も例外にしない） |
   | Target branches | **Add target** → **Include default branch**（main） |
   | Restrict deletions | オン（main を消せないようにする） |
   | Require a pull request before merging | オン。「Required approvals」は **0**（1 人で運用するため。自分のプルリクエストは自分で承認できない） |
   | Require status checks to pass | オン。**Add checks** で次の 3 つを追加する: `型チェック・Worker のテスト・依存パッケージ`、`画面の E2E テスト（Chromium）`、`秘密情報の混入（gitleaks）` |
   | Block force pushes | オン（履歴の書き換えを禁止する） |

3. **Create** を押す

設定すると、`main` への直接の push は拒否され、CI が 1 つでも失敗しているプルリクエストはマージできなくなります。

> 「Add checks」の候補に出てくるのは、一度でも実行されたジョブの名前です。出てこないときは、`develop` に push して CI を 1 回動かしてから設定してください。

## 2. ジョブ①: 型チェック・Worker のテスト・依存パッケージ

サーバー側（Worker）のコードと、依存パッケージを確認します。上から順に実行し、**どれかが失敗した時点で止まります。**

| 順 | コマンド | 確認していること | 失敗する例 |
| --- | --- | --- | --- |
| 1 | `npm ci` | `package-lock.json` のとおりに依存パッケージを入れる | lock ファイルと `package.json` が食い違っている |
| 2 | `npx tsc` | TypeScript の型チェック | 型が合わない（ライブラリの更新で名前が変わった など） |
| 3 | `npm test` | Worker のテスト 231 件（vitest + Cloudflare の Workers 実行環境） | 認可・CSRF・セッション・入力の検証・リンクの書き換え・検索・バックアップなどの不具合 |
| 4 | `npm run audit` | **本番で使う**依存パッケージに既知の脆弱性がないか（`npm audit --omit=dev`） | marked・DOMPurify・SimpleWebAuthn などに脆弱性が公表された |
| 5 | `npm run build` | 画面のコード（`client/`）を 1 つのファイルにまとめられるか | import の間違い、存在しないファイルの参照 |

### Worker のテストのしくみ

- `@cloudflare/vitest-pool-workers` を使い、本番と同じ Workers の実行環境（workerd）の中でテストします
- D1・R2 は、テストごとに作られる一時的なものを使います。Cloudflare のアカウントやインターネット上のサービスは使いません
- 主なテストファイル:
  - `tests/authz.test.ts`: **権限表**（どの API を、未登録・承認待ち・承認済み・ログイン中の誰が使えるか）、CSRF 対策、本人確認のし直し、セッションの期限、Cookie の属性、ブートストラップ、画像のアップロードの検証、レスポンスヘッダー
  - `tests/notes.test.ts`: リンクの解析と書き換え、フォルダ、タグと検索、取り込み・書き出し、バックアップ

## 3. ジョブ②: 画面の E2E テスト

実際のブラウザ（Chromium）で画面を操作して、利用者と同じ流れで動くかを確認します。

| 順 | コマンド | 内容 |
| --- | --- | --- |
| 1 | `npm ci` | 依存パッケージを入れる |
| 2 | `npx playwright install --with-deps chromium` | テスト用の Chromium と、必要な OS のライブラリを入れる |
| 3 | `npm run test:e2e` | E2E テスト 31 件（Playwright） |
| 4 | （失敗したときだけ）結果の保存 | 画面の記録を `playwright-report` として 7 日間保存する |

### しくみ

```
playwright test
  ├─ テスト用サーバー 1（ポート 8788、データ .wrangler/e2e-8788/）… 画面のビルドもここで行う
  │     └─ e2e/app.spec.js        主要な機能・XSS・オフライン・ログアウト（16 件）
  └─ テスト用サーバー 2（ポート 8789、データ .wrangler/e2e-8789/）
        └─ e2e/scenarios.spec.js  使いかたマニュアルに沿ったシナリオ（15 件）
```

- テスト用サーバーは `scripts/e2e-server.mjs` が起動します。中身はローカル開発と同じ `wrangler dev` で、データは毎回作り直します
- 2 つのテストファイルは、別々のサーバー（別々のデータ）で、それぞれ「最初の 1 台」の登録から始めます
- **パスキー**は、Chromium の「仮想認証器」（指紋や顔認証の代わりに、自動で応答するテスト用の仕組み）で代用します
- テスト用サーバーだけ、本人確認のし直しの有効時間を **3 秒**にしています（本番は 5 分）。デバイスの承認などで本人確認が求められることを短時間で確かめるためです
- どのテストファイルも、最後に**ページのエラーと CSP 違反が 1 件もないこと**を確認します。画面の見た目が正しくても、裏でエラーが出ていれば失敗にします

## 4. ジョブ③: 秘密情報の混入（gitleaks）

パスワード・API キー・秘密鍵のような文字列が、誤ってリポジトリに入っていないかを確認します。**このリポジトリは公開されている**ため、特に重要な検査です。

- [gitleaks](https://github.com/gitleaks/gitleaks)（v8.30.1）を Docker で実行します
- **Git の履歴全体**を調べます（`fetch-depth: 0`）。最新のファイルから消しても、過去のコミットに残っていれば見つかります
- 見つかった値そのものはログに出しません（`--redact`）。見つかった**場所**（ファイル・行・ルール・コミット）だけを、GitHub の画面に注釈として表示します

### 誤検知のとき

テスト用のダミーの値などが、秘密情報らしく見えて検出されることがあります（誤検知）。

1. 注釈に出たファイル・行を見て、**本当に秘密情報ではないか**を確かめる
2. 秘密情報だった場合 → 下の「秘密情報を push してしまったとき」へ
3. 誤検知の場合 → 今のファイルでは、検出されない書き方に直す。過去のコミットに残っているものは `.gitleaksignore` に 1 行ずつ追加し、**理由をコメントで書く**

```
# 理由（例: E2E テストの「間違った合言葉」の例。実在しない値）
<コミットの SHA>:<ファイル>:<ルール>:<行>
```

ファイルやルールごとまとめて除外することはしません（本物の秘密情報まで見逃すため）。

### 秘密情報を push してしまったとき

公開リポジトリに一度 push した値は、**すでに漏れたものとして扱います**。コミットを消しても、誰かが取得済みかもしれないからです。

1. その値を**すぐに無効化・変更する**（例: `BOOTSTRAP_SECRET` なら `npx wrangler secret put BOOTSTRAP_SECRET` で新しい値に。Cloudflare の API トークンなら Cloudflare の画面で削除して作り直す）
2. 漏れた値で何かされていないか確認する（デバイスの一覧に知らない端末がないか など）
3. その後で、ファイルから値を取り除く

## 5. CI 自体の安全対策

CI は、プルリクエストのコード（他人が書いたものかもしれない）を実行します。そのため、CI に強い権限を持たせないようにしています。

| 対策 | 内容 |
| --- | --- |
| 最小権限 | `permissions: contents: read`。CI はリポジトリを**読むだけ**で、書き込み・リリース・Issue の操作はできない |
| 認証情報を残さない | `actions/checkout` の `persist-credentials: false`。取得したコードの中に GitHub のトークンを残さない |
| 秘密情報を使わない | CI は Cloudflare のトークンなどのシークレットを一切使わない。漏れて困るものが CI の中にない |
| 本番に触れない | テストはすべてローカルのテスト用サーバーに対して行う。本番の URL にはアクセスしない |
| 計測の送信を止める | `WRANGLER_SEND_METRICS: "false"`。Wrangler の利用状況の送信を止める |
| 時間の上限 | ジョブごとに 10〜20 分。止まったままのジョブが動き続けない |
| バージョンの固定 | `npm ci` で lock ファイルどおりに入れる。gitleaks もバージョンを指定する |

## 6. Dependabot（依存パッケージの自動更新）

依存パッケージの新しいバージョンが出ると、Dependabot が**更新のプルリクエストを自動で作ります**。そのプルリクエストでも CI が動くので、更新しても壊れないかがわかります。

| 対象 | 頻度 | 内容 |
| --- | --- | --- |
| npm のパッケージ | 毎週 | 同時に開くプルリクエストは 5 件まで。CodeMirror 関連（`codemirror` グループ）と開発用ツール（`dev-tools` グループ）はまとめて 1 件にする |
| GitHub Actions | 毎月 | `actions/checkout` などのバージョン |

### Dependabot のプルリクエストの扱いかた

1. CI が**すべて成功**しているか確認する
2. 成功していれば、内容（どのパッケージが、どのバージョンからどのバージョンに）を確認して **develop に**マージする（main には、次の develop → main のプルリクエストでまとめて入る）。メジャーバージョン（先頭の数字）が上がるものは、変更点（Release notes）にも目を通す
3. 失敗していれば、原因を調べる。多いのは次の 2 つ
   - **ライブラリの使いかたが変わった**（例: 型の名前が変わった）→ コードを直す
   - **他のパッケージがまだ新しいバージョンに対応していない** → 対応を待つ。必要なら `dependabot.yml` の `ignore` で一時的に除外する

### 現在の除外設定

| パッケージ | 除外している更新 | 理由 |
| --- | --- | --- |
| vitest | メジャーバージョンの更新 | Worker のテストに使う `@cloudflare/vitest-pool-workers` が vitest 4 にしか対応していないため。対応したら除外を外す |

### 開発用ツールの脆弱性について

`package.json` の `overrides` で、開発用ツールが内部で使う一部のパッケージ（undici・sharp・zod）を、脆弱性を修正したバージョンに固定しています。上流のツールが修正版を使うようになったら、`overrides` を外します（[security.md](security.md) の残存リスク）。

## 7. 結果の見かた

### GitHub の画面で

- **コミットの一覧**: コミットの横に ✅（成功）・❌（失敗）・🟡（実行中）が付きます
- **プルリクエスト**: 下の方の「Checks」に 3 つのジョブの結果が出ます。❌ のものの「Details」から詳細を開けます
- **Actions タブ**: すべての実行の履歴が見られます

### 失敗したとき

1. ❌ のジョブを開き、赤くなっているステップを確認する
2. E2E テストと gitleaks は、「Annotations」（注釈）に失敗したテストの名前・エラーの内容・ファイルと行を表示します。それ以外は、赤いステップを開いてログを読みます
3. E2E テストが失敗したときは、実行結果のページの下にある **Artifacts** から `playwright-report` をダウンロードし、展開して `index.html` を開くと、失敗したときの画面や操作の記録が見られます

| 失敗したジョブ・ステップ | よくある原因 | 手元での確認 |
| --- | --- | --- |
| ① `npm ci` | `package.json` を変えたが lock ファイルを更新していない | `npm install` を実行して `package-lock.json` もコミットする |
| ① `npx tsc` | 型のエラー | `npx tsc` |
| ① `npm test` | サーバー側の不具合、テストの期待値が古い | `npm test` |
| ① `npm run audit` | 本番の依存パッケージに脆弱性が公表された | `npm run audit` の表示に従い、パッケージを更新する |
| ① `npm run build` | 画面のコードの import の間違い | `npm run build` |
| ② `npm run test:e2e` | 画面の不具合、CSP 違反、ページのエラー | `npm run test:e2e`（[local-development.md](local-development.md) の「9. テストと検査」） |
| ③ gitleaks | 秘密情報らしき文字列 | 上の「4. 秘密情報の混入」 |

> CI のテスト用ブラウザは、手元のものより新しいことがあります。新しい Chromium だけが報告するエラーで失敗することもあるので、手元で再現しないときは CI の注釈の内容をよく読んでください。

## 8. 手元で同じ検査をする

push する前に、手元で同じ検査をしておくと、CI での失敗を減らせます。

```bash
npx tsc            # ①型チェック
npm test           # ①Worker のテスト
npm run audit      # ①本番の依存パッケージの脆弱性
npm run build      # ①画面のビルド
npm run test:e2e   # ②画面の E2E テスト（初回は npx playwright install chromium）
```

gitleaks（③）は Docker が必要です。Docker がある場合は次のコマンドで同じ検査ができます。

```bash
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 git /repo --redact --no-banner --verbose
```

## 9. 費用

**無料です。** このリポジトリは公開（public）なので、GitHub Actions の標準のマシン（`ubuntu-latest`）は時間の制限なく無料で使えます。Dependabot も無料です。

> リポジトリを非公開（private）に戻した場合は、GitHub の無料プランで**月 2,000 分**までの制限がかかります。時間はジョブごとに分単位で切り上げて数えるため、1 回の CI は 3 つのジョブの合計で約 5 分になり、月に 400 回程度の実行まで無料の範囲に収まります。

## 10. CI を変更するとき

- `.github/workflows/ci.yml` を変更したら、`develop` に push して CI が動くことを確認してから main へのプルリクエストを作ります
- ジョブの名前（`name:`）を変えたら、ブランチ保護の「Require status checks to pass」の 3 つの名前も変えます（古い名前のままだと、マージできなくなります）
- **権限を広げない**: `permissions` に書き込みの権限を足す、シークレットを使う、本番にアクセスする、といった変更は、セキュリティの観点で慎重に検討します（[security.md](security.md)、`/mdvault-security-review`）
- 新しい Action を使うときは、信頼できる提供元（`actions/` や公式のもの）を選び、バージョンを指定します
- テストを追加したら [test-scenarios.md](test-scenarios.md) の表も更新します

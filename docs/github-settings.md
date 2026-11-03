# GitHub の設定

GitHub の画面で手作業で行った設定の一覧と、その手順です。
ファイル（`.github/workflows/ci.yml`・`.github/dependabot.yml` など）で管理している設定は Git に残りますが、ここに書いた設定は **GitHub の画面にしか残りません**。リポジトリを作り直すとき、新しいプロジェクトで同じ運用をするとき、設定が変わっていないか確かめるときに使います。

Cloudflare 側の設定は [cloudflare.md](cloudflare.md)・[deploy.md](deploy.md) を参照してください。

## 一覧

| 設定 | 場所 | 状態 | 目的 |
| --- | --- | --- | --- |
| [リポジトリの公開](#1-リポジトリの公開) | リポジトリ → Settings → General | ✅ Public | 公開リポジトリなら GitHub Actions・ブランチ保護・Secret Protection が無料 |
| [既定のブランチ](#2-ブランチ) | リポジトリ → Settings → General | ✅ `main` | `git clone` で安定版の main が取得されるように |
| [develop ブランチ](#2-ブランチ) | — | ✅ 作成済み | 普段の作業用 |
| [main のブランチ保護](#3-main-のブランチ保護ruleset) | リポジトリ → Settings → Rules → Rulesets | ✅ 設定済み（2026-11-03、API で確認） | CI を通ったものだけを main に入れる |
| [Secret Protection・Push protection](#4-secret-protectionpush-protection) | リポジトリ → Settings → Advanced Security | ✅ オン（2026-11-03、画面で確認） | 秘密情報を含む push を受け付ける時点で拒否する |
| [Dependabot alerts・security updates](#5-dependabot) | リポジトリ → Settings → Advanced Security | ⚠️ **要確認**（2026-11-03 時点で無効だった） | 脆弱性が公表されたらすぐに通知し、修正のプルリクエストを作る |
| [メールアドレスを公開しない](#6-メールアドレスを公開しないアカウントの設定) | アカウント → Settings → Emails | ⚠️ **要確認**（2026-11-04 のマージで個人のアドレスが使われた） | コミットに個人のメールアドレスを入れない |
| [PC の Git のメールアドレス](#6-メールアドレスを公開しないアカウントの設定) | PC ごと（`git config`） | PC ごとに設定 | 同上 |
| [さらに強化するための設定](#9-さらに強化するための設定推奨) | アカウント・リポジトリの各所 | 未設定（推奨） | 2FA・CodeQL・Actions の権限・脆弱性の報告の窓口など。無料・有料に分けて記載 |

> 「Settings」には 2 種類あります。**リポジトリの Settings** はリポジトリの画面の上のタブ（Code・Issues・Pull requests… の右端の ⚙ Settings）、**アカウントの Settings** は右上のアイコン → Settings です。

## 1. リポジトリの公開

**リポジトリ → Settings → General → 一番下の Danger Zone → Change repository visibility**

- 現在は **Public**（公開）です
- 公開リポジトリでは、GitHub Actions の標準のマシン・ブランチ保護（Rulesets）・Secret Protection・Dependabot が無料で使えます
- **非公開（Private）に変える場合の影響**:
  - GitHub Actions は無料プランで月 2,000 分まで（[ci.md](ci.md) の「9. 費用」）
  - Rulesets（ブランチ保護）は、無料プランの非公開リポジトリでは効かなくなる
  - Secret Protection は有料になる
- 公開しているので、**コミットの内容・作者・コミットメッセージは誰でも見られます**。秘密情報や個人情報を入れないこと（[security.md](security.md)、[6 章](#6-メールアドレスを公開しないアカウントの設定)）

## 2. ブランチ

| ブランチ | 役割 | 設定 |
| --- | --- | --- |
| `main` | 安定版。デプロイと `git clone` はここから | **既定のブランチ**（Settings → General → Default branch）。ブランチ保護あり |
| `develop` | 普段の作業・Dependabot の更新 | 保護なし（自由に push できる） |

運用の流れは [ci.md](ci.md#ブランチの運用) を参照してください。

### マージのしかた

develop → main のプルリクエストは **「Create a merge commit」** でマージします（ブランチ保護で、これしか選べないようにしています）。
Squash でマージすると main と develop の履歴が別物になり、次のプルリクエストで競合しやすくなるためです。

マージした後は、develop を main に合わせておきます（マージのコミットを develop にも入れる）。

```bash
git checkout develop
git pull origin main   # main のマージのコミットを取り込む（早送りになる）
git push origin develop
```

## 3. main のブランチ保護（Ruleset）

**リポジトリ → Settings → Rules → Rulesets → New ruleset → New branch ruleset**

- 左に「Rules」がない場合は、`https://github.com/sai103/mdvault/settings/rules` を直接開くか、左の **Branches** → **Add branch ruleset** から開けます

### 設定している内容

| 項目 | 設定 | 理由 |
| --- | --- | --- |
| Ruleset Name | `main を保護` | マージできないときの理由として画面に表示される |
| Enforcement status | **Active** | |
| Bypass list | **空** | 管理者の自分も含め、誰も例外にしない |
| Target branches | **Include default branch**（main） | ⚠️ これを忘れると、どのブランチにも効かない |
| Restrict deletions | オン | main を消せないようにする |
| Require a pull request before merging | オン。Required approvals は **0** | 1 人で運用するため（自分のプルリクエストは自分で承認できない） |
| Allowed merge methods | **Merge だけ** | Squash・Rebase でのマージを防ぐ（[2 章](#マージのしかた)） |
| Require status checks to pass | オン。次の 3 つを追加し、それぞれの提供元を **GitHub Actions** にする | CI がすべて成功したものだけをマージできる |
| Require branches to be up to date before merging | オフ | develop → main だけの運用なので不要 |
| Block force pushes | オン | 履歴の書き換えを禁止する |

必須にしているチェック（名前は 1 文字でも違うとマージできなくなるので、貼り付けて入力する。括弧は全角）:

```
型チェック・Worker のテスト・依存パッケージ
```
```
画面の E2E テスト（Chromium）
```
```
秘密情報の混入（gitleaks）
```

- 「Add checks」を押しても候補が出ないときは、検索欄に名前を貼り付けると出ます。一度も実行されていないジョブは出ないので、先に develop に push して CI を動かしておきます
- 提供元を「Any source」のままにすると、GitHub Actions 以外の連携アプリが同じ名前で「成功」を送っても通ってしまいます。**GitHub Actions** を選びます
- 候補に出る `.github/dependabot.yml` は追加しません（テストではありません）
- **ci.yml のジョブの名前（`name:`）を変えたら、ここの 3 つの名前も変えます**。古い名前のままだと、ずっと「未完了」になり、マージできなくなります

### 効いているかの確かめかた

- develop → main のプルリクエストを作ると、CI の実行中は「Merging is blocked」と表示され、3 つとも成功するとマージできるようになる
- API でも確認できる: `gh api repos/sai103/mdvault/rules/branches/main` に `pull_request`・`required_status_checks`・`non_fast_forward`・`deletion` が出ていれば、main に効いている（空の `[]` なら Target branches の設定漏れ）

### Rulesets の画面が使えない場合（従来のブランチ保護）

**Settings → Branches → Add classic branch protection rule** でも、同じ内容を設定できます。

| 項目 | 設定 |
| --- | --- |
| Branch name pattern | `main` |
| Require a pull request before merging | オン。「Require approvals」は**オフ** |
| Require status checks to pass before merging | オン。上の 3 つのジョブを追加する |
| Do not allow bypassing the above settings | オン |
| Allow force pushes・Allow deletions | オフのまま |

## 4. Secret Protection・Push protection

**リポジトリ → Settings → Advanced Security**（表示によっては **Code security**）→ **Secret Protection**

| 項目 | 設定 |
| --- | --- |
| Secret Protection | **有効**（ボタンが「Disable」と表示されていれば有効） |
| Push protection | **On** |

- **Push protection**: AWS・GitHub・Cloudflare などの**決まった形式のトークン**を含む push を、GitHub が受け付ける時点で拒否します。拒否された push は公開されません
- 自分で決めた合言葉（`BOOTSTRAP_SECRET` の値など）のように形の決まっていないものは対象外です。これは CI の gitleaks で検査します（[ci.md](ci.md) の「4. 秘密情報の混入」）
- CI の gitleaks は push の**後**に動くので、見つかった時点で develop には公開されています。push protection は push の**前**に止める、二重の対策です
- 公開リポジトリでは、GitHub はトークンを発行した会社（パートナー）にも検出を通知します（トークンが自動で無効にされることがあります）

### push が拒否されたとき

1. 拒否のメッセージに出ているファイル・行を確認する
2. **本物の秘密情報なら**、コミットから取り除いてから push し直す（`git commit --amend` や `git rebase` で、そのコミットを作り直す）。値はまだ公開されていないが、念のため無効にしておくと安全
3. **テスト用のダミーなど誤検知なら**、メッセージにある URL から理由を選んで許可できる。ただし、まずは検出されない書き方に直すことを検討する

## 5. Dependabot

**リポジトリ → Settings → Advanced Security**（または **Code security**）

| 項目 | 設定 | 内容 |
| --- | --- | --- |
| Dependency graph | オン | 下の 2 つに必要 |
| **Dependabot alerts** | **オンにする** | 使っているパッケージに脆弱性が公表されたら、すぐに通知する |
| **Dependabot security updates** | **オンにする** | 脆弱性を修正する更新のプルリクエストを自動で作る |
| Dependabot version updates | `.github/dependabot.yml` で設定済み | 週 1 回（npm）・月 1 回（GitHub Actions）、新しいバージョンへの更新を develop に提案する |

> **2026-11-03 時点では Dependabot alerts が無効でした**（API が「Dependabot alerts are disabled」を返した）。オンになっているか確認してください。

- 通知の受け取りかたは、アカウント → Settings → **Notifications** の「Dependabot alerts」で選べます（メール・GitHub の画面）
- Dependabot security updates のプルリクエストは、既定のブランチ（main）に向けて作られることがあります。その場合は、develop に取り込んでから develop → main のプルリクエストで反映するか、内容を確認してそのまま main にマージします（CI とブランチ保護は同じように効きます）

## 6. メールアドレスを公開しない（アカウントの設定）

公開リポジトリでは、**コミットの作者のメールアドレスは誰でも見られます**。

### GitHub の画面での操作（アカウント全体に効く）

**アカウント → Settings → Emails**

| 項目 | 設定 | 効果 |
| --- | --- | --- |
| **Keep my email addresses private** | オン | GitHub の画面でのマージ・ファイル編集のコミットに、個人のアドレスの代わりに `19669246+sai103@users.noreply.github.com` を使う |
| **Block command line pushes that expose my email** | オン | 個人のアドレスで作ったコミットの push を拒否する（PC の設定を忘れたときの保険） |

- **リポジトリごとではなく、アカウントのすべてのリポジトリ**に効きます（今後作るものも含む）
- 過去のコミットは変わりません
- noreply のアドレスの数字（`19669246`）はアカウントごとに決まっています。この画面の「Keep my email addresses private」の説明文に表示されます

> **2026-11-03〜04 の 4 件のマージのコミット**（#8・#9・#10・#11）には、個人のアドレスが入っています。履歴を書き換えないと消せず、書き換えても GitHub のプルリクエストの記録には残るため、そのままにしています。

### PC で作るコミット（PC ごとに 1 回）

PC の `git commit` には上の設定は効きません。PC ごとに次を実行します。

```bash
git config --global user.email "19669246+sai103@users.noreply.github.com"
git config --global user.name "sai103"
```

確認: `git config --global user.email`

## 7. ファイルで管理している設定（参考）

GitHub の画面ではなく、リポジトリのファイルで管理している設定です。変更は develop で行います。

| ファイル | 内容 | 解説 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | CI（型チェック・テスト・E2E・gitleaks）。権限は読み取りだけ | [ci.md](ci.md) |
| `.github/dependabot.yml` | 依存パッケージの更新の提案（develop 向け） | [ci.md](ci.md) の「6. Dependabot」 |
| `.gitleaksignore` | gitleaks の誤検知の除外（1 件ずつ理由を書く） | [ci.md](ci.md) の「4. 秘密情報の混入」 |
| `CLAUDE.md` | Claude Code で作業するときのルール（develop で作業する、など） | |
| `SECURITY.md` | 脆弱性の報告のしかた（Private vulnerability reporting で非公開に報告してもらう） | [9-1](#脆弱性への対応) |

## 8. 新しいリポジトリで同じ運用にするとき

1. リポジトリを作る（Public）。既定のブランチは `main`
2. `.github/` のファイルをコピーする。`ci.yml` のジョブの中身はプロジェクトに合わせる
3. `develop` ブランチを作って push し、CI を 1 回動かす（[3 章](#3-main-のブランチ保護ruleset)のチェックの候補に名前が出るように）
4. [3 章](#3-main-のブランチ保護ruleset): main のブランチ保護
5. [4 章](#4-secret-protectionpush-protection): Secret Protection・Push protection
6. [5 章](#5-dependabot): Dependabot alerts・security updates
7. [6 章](#6-メールアドレスを公開しないアカウントの設定)は、アカウントの設定なので 1 回だけでよい（新しい PC では `git config` だけ行う）

## 9. さらに強化するための設定（推奨）

ここまでの設定に加えて、やっておくとよい設定です。**まだ設定していないもの**なので、上から順に確認してください。
「無料」は、このリポジトリのような**公開リポジトリ・個人アカウント**で無料という意味です。

### 9-1. 無料でできるもの

#### アカウントを守る（最優先）

GitHub のアカウントを乗っ取られると、ブランチ保護を外す・コードを書き換える・秘密情報を読む、などすべてができてしまいます。リポジトリの設定よりも先に確認してください。

| 設定 | 場所 | 内容 |
| --- | --- | --- |
| **2 要素認証（2FA）** | アカウント → Settings → **Password and authentication** | パスワードに加えて、もう 1 つの確認を必須にする。**パスキー**か**セキュリティキー**がおすすめ（フィッシングに強い）。認証アプリ（TOTP）も可。SMS は避ける |
| パスキーでのサインイン | 同上 → **Passkeys** | パスワードなしでサインインできる。2FA も兼ねる |
| **リカバリーコードの保管** | 同上 → **Recovery options** | 2FA の端末をなくしたときの唯一の手段。パスワードマネージャーなど安全な場所に保存する |
| 使っていないセッションの終了 | アカウント → Settings → **Sessions** | 覚えのないブラウザ・場所のセッションを終了する |
| **アクセストークンの整理** | アカウント → Settings → **Developer settings → Personal access tokens** | 使っていないトークンを削除する。作るときは **Fine-grained**（リポジトリと権限を絞れる）を選び、**有効期限**を付ける |
| **連携アプリの整理** | アカウント → Settings → **Applications**（Authorized OAuth Apps・Authorized GitHub Apps・Installed GitHub Apps） | 使っていない連携を外す。Claude などの GitHub App は、**Repository access** を必要なリポジトリだけに絞る |
| SSH キーの整理 | アカウント → Settings → **SSH and GPG keys** | 使っていない PC のキーを削除する |
| セキュリティログの確認 | アカウント → Settings → **Security log** | サインイン・トークンの作成・設定の変更などの記録。ときどき覚えのない操作がないか見る |

#### 個人情報を守る

| 設定 | 場所 | 内容 |
| --- | --- | --- |
| メールアドレスを公開しない | [6 章](#6-メールアドレスを公開しないアカウントの設定) | 設定済みか確認する |
| プロフィールの公開情報 | アカウント → Settings → **Public profile** | 名前・場所・所属・SNS など、公開して困るものを外す。「Public email」は「Don't show my email address」にする |
| 活動の公開範囲 | 同上 → **Contributions & activity** | 「Make profile private and hide activity」で、プロフィールの活動の記録を非公開にできる（リポジトリ自体は公開のまま） |
| コミットの日時 | — | コミットの日時（タイムゾーンを含む）は公開されます。気になる場合は、作業する時間帯から生活リズムが推測されることを意識する |

#### 脆弱性への対応

| 設定 | 場所 | 内容 |
| --- | --- | --- |
| Dependabot alerts・security updates | [5 章](#5-dependabot) | 設定済みか確認する |
| **Private vulnerability reporting** | リポジトリ → Settings → **Advanced Security**（または Code security）→ Private vulnerability reporting | 他の人がこのアプリの脆弱性を見つけたとき、公開の Issue ではなく、**非公開で報告できる**窓口を作る。報告の受け付けかたは `SECURITY.md` に書いてある |
| **CodeQL（Code scanning）の Default setup** | 同上 → **Code scanning → CodeQL analysis → Set up → Default** | GitHub がコードを解析し、XSS・インジェクションなどの危険な書き方を見つける（JavaScript・TypeScript・GitHub Actions の設定を対象）。結果はリポジトリの **Security** タブに出る。プルリクエストごとと週 1 回実行される。ファイルの追加は不要 |
| Copilot Autofix | CodeQL を有効にすると使える | CodeQL の指摘に、修正の案を自動で付ける |
| Dependency review（任意） | `.github/workflows/` に `actions/dependency-review-action` を使うジョブを追加する（ファイルの変更が必要） | プルリクエストで、脆弱性のあるパッケージや確認していないライセンスのパッケージが**追加される**ときに止める。今は `npm run audit` とビルドのライセンスの確認で同じ役割をしているので、必須ではない |

> CodeQL は GitHub Actions の時間を使いますが、公開リポジトリなので無料です。CI とは別に動くので、ブランチ保護の必須のチェックに加える必要はありません（加えると、CodeQL の結果待ちでマージが遅くなる）。

#### GitHub Actions を守る

**リポジトリ → Settings → Actions → General**

| 項目 | 推奨 | 理由 |
| --- | --- | --- |
| Actions permissions | **Allow sai103, and select non-sai103, actions and reusable workflows**（`sai103` の部分はアカウント名） を選び、「**Allow actions created by GitHub**」だけをオンにする | このリポジトリが使う Action は `actions/checkout`・`actions/setup-node`・`actions/upload-artifact`（すべて GitHub 製）だけ。知らない Action が追加されても動かないようにする。gitleaks は Action ではなく Docker で実行しているので影響しない |
| Fork pull request workflows from outside collaborators | **Require approval for all external contributors** | 他の人がプルリクエストを出したとき、CI を動かす前に自分の承認を必要にする（悪意のあるコードを CI で実行されないように） |
| **Workflow permissions** | **Read repository contents and packages permissions** | CI に渡すトークンの既定の権限を読み取りだけにする（`ci.yml` でも `contents: read` にしているが、二重に絞る） |
| Allow GitHub Actions to create and approve pull requests | **オフ** | CI が勝手にプルリクエストを作成・承認できないようにする |

#### リポジトリの設定

| 設定 | 場所 | 推奨 | 理由 |
| --- | --- | --- | --- |
| **develop の保護** | リポジトリ → Settings → Rules → Rulesets → New branch ruleset | 対象を `develop`（Add target → Include by pattern → `develop`）にして、**Restrict deletions** と **Block force pushes** だけをオン。プルリクエストや CI は必須にしない | develop を消したり、履歴を書き換えたりできないようにする。push は今までどおりできる |
| マージの方法 | リポジトリ → Settings → **General → Pull Requests** | 「Allow merge commits」だけをオン。「Allow squash merging」「Allow rebase merging」はオフ | ブランチ保護と同じ方針を、リポジトリ全体にも適用する（Dependabot のプルリクエストなども含む） |
| ⚠️ Automatically delete head branches | 同上 | **オフのまま** | オンにすると、develop → main のマージのたびに **develop が削除される** |
| 使わない機能を止める | リポジトリ → Settings → **General → Features** | Wikis・Projects・Discussions など使っていないものをオフ | 誰でも書き込める場所を減らす。Issues は、不具合の報告を受けたいならオンのまま |

#### コミットへの署名（任意・上級）

| 設定 | 場所 | 内容 |
| --- | --- | --- |
| コミットへの署名 | アカウント → Settings → **SSH and GPG keys → New SSH key**（Key type: **Signing Key**）と、PC の `git config --global gpg.format ssh`・`user.signingkey`・`commit.gpgsign true` | 自分の PC で作ったコミットに署名し、GitHub に「Verified」と表示させる。なりすましのコミットと区別できる |
| Vigilant mode | アカウント → Settings → **SSH and GPG keys → Flag unsigned commits as unverified** | 署名のない自分名義のコミットに「Unverified」と表示する |

> ⚠️ ブランチ保護の「**Require signed commits**」は、今の運用では**オンにしないでください**。Claude Code など署名をしない環境で作ったコミットが develop から main に入れなくなり、マージできなくなります。使う場合は、すべての作業環境で署名を設定してからにします。

### 9-2. 有料のもの

個人で使う公開リポジトリには**どれも不要**です。リポジトリを非公開にする場合や、組織で使う場合に検討します。
料金は 2026 年時点の目安で、変わることがあります。契約の前に [GitHub の料金ページ](https://github.com/pricing) で確認してください。

| プラン・製品 | 目安の料金 | できること | このリポジトリで必要になる場面 |
| --- | --- | --- | --- |
| **GitHub Pro**（個人） | 月 4 ドル程度 | 非公開リポジトリでの**ブランチ保護（Rulesets）**・必須のレビュー、Actions の時間の追加（月 3,000 分） | リポジトリを非公開にして、ブランチ保護を続けたいとき |
| **GitHub Team**（組織） | 1 人あたり月 4 ドル程度 | 組織での非公開リポジトリのブランチ保護、メンバーの権限管理、**組織全体で 2FA を必須**にする設定 | 複数人で開発するとき |
| **GitHub Secret Protection**（Team・Enterprise に追加） | コミットする人 1 人あたり月 19 ドル程度 | 非公開リポジトリでの秘密情報の検出・push protection、**自分で決めた形式の検出（Custom patterns）**、検出したトークンが今も使えるかの確認（validity checks）、AI による形の決まっていないパスワードの検出 | 非公開にするとき、または `BOOTSTRAP_SECRET` のような独自の秘密情報も GitHub 側で検出したいとき（今は CI の gitleaks で代わりにしている） |
| **GitHub Code Security**（Team・Enterprise に追加） | コミットする人 1 人あたり月 30 ドル程度 | 非公開リポジトリでの CodeQL・Copilot Autofix、**dependency review**（プルリクエストで脆弱な依存の追加を止める）、組織全体のセキュリティの一覧 | 非公開にして、CodeQL を続けたいとき |
| **GitHub Enterprise** | 1 人あたり月 21 ドル程度〜 | SAML によるシングルサインオン、IP アドレスでの接続制限、監査ログの外部への送信など | 会社など大きな組織で使うとき |

> 公開リポジトリのままなら、Rulesets・Secret Protection（push protection を含む）・CodeQL・Dependabot・GitHub Actions はすべて**無料**です。非公開にすると、これらの多くが有料になるか使えなくなります（[1 章](#1-リポジトリの公開)）。

### 9-3. 確認のチェックリスト

半年に 1 回など、定期的に確認すると安心です。

- [ ] 2FA が有効で、リカバリーコードを安全に保管している
- [ ] 覚えのないセッション・トークン・SSH キー・連携アプリがない（[9-1](#アカウントを守る最優先)）
- [ ] Security log に覚えのない操作がない
- [ ] main のブランチ保護が効いている（`gh api repos/sai103/mdvault/rules/branches/main` が空でない）
- [ ] Secret Protection・Push protection・Dependabot alerts がオンになっている
- [ ] Security タブに未対応の通知（Dependabot・Code scanning・Secret scanning）が残っていない
- [ ] 最近のコミットの作者が noreply のアドレスになっている（`git log --format='%ae' -20 | sort -u`）

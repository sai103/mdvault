// 使いかたマニュアル（docs/manual.md）に沿ったシナリオテスト。テスト名の【n章】はマニュアルの章
// app.spec.js とは別のサーバー（別のデータ）で、最初の 1 台の登録から順に操作する。シナリオの一覧は docs/test-scenarios.md
// パスキーは Chromium の仮想認証器（DevTools プロトコル）で代用する
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const BOOTSTRAP_WORD = "e2e-bootstrap-secret-0123456789"; // scripts/e2e-server.mjs で設定した合言葉
const VIRTUAL_DEVICE = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true };

/** @type {import("@playwright/test").Page} */
let page;
let cdp, authenticatorId;
let currentTest = "";
const problems = []; // ページのエラーと CSP 違反（どのテストで起きたか）
const answers = [];  // prompt / confirm / alert に順番に答える値（true = OK、false = キャンセル、文字列 = 入力）

// ブラウザ（デバイス）を 1 つ用意する。ダイアログには answers の順に答え、エラーは problems に記録する
async function openBrowser(browser, label) {
  const context = await browser.newContext();
  const p = await context.newPage();
  p.on("pageerror", (e) => problems.push(`[${currentTest}] ${label} pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`[${currentTest}] ${label} ${m.text()}`); });
  p.on("dialog", (d) => {
    const a = answers.shift();
    if (a === false) d.dismiss();
    else d.accept(typeof a === "string" ? a : undefined);
  });
  const session = await context.newCDPSession(p);
  await send(session, "WebAuthn.enable");
  const { authenticatorId: id } = await send(session, "WebAuthn.addVirtualAuthenticator", { options: { ...VIRTUAL_DEVICE, automaticPresenceSimulation: true } });
  return { page: p, cdp: session, authenticatorId: id };
}

// DevTools プロトコルの呼び出し。応答がないときに、どの呼び出しで止まったかがわかるように時間を区切る
async function send(session, method, params = {}) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} が 15 秒以内に応答しませんでした`)), 15_000); });
  try { return await Promise.race([session.send(method, params), timeout]); } finally { clearTimeout(timer); }
}
const credentialsOf = async (session, id) => (await send(session, "WebAuthn.getCredentials", { authenticatorId: id })).credentials;

// 2 台目のデバイスで「このデバイスを登録」まで進め、6 桁のコードを返す
async function registerDevice(p, name) {
  await p.goto("/");
  await p.fill("#device-name", name);
  await p.click("#register-btn");
  await expect(p.locator("#pair-code")).toHaveText(/^\d{6}$/);
  return (await p.locator("#pair-code").textContent()).trim();
}

const editorText = () => page.evaluate(() => document.querySelector("#editor").mdvEditor.getValue());
const setEditor = (text) => page.evaluate((t) => {
  const ed = document.querySelector("#editor").mdvEditor;
  ed.replaceRange(0, ed.getValue().length, t);
}, text);
const saved = () => expect(page.locator("#status")).toHaveText(/保存済み|リンクを書き換えました/);
const openNote = async (name) => {
  await page.keyboard.press("Control+p");
  await page.fill("#switcher-input", name);
  await page.keyboard.press("Enter");
  await expect(page.locator("#title")).toHaveValue(name);
};
const writeNote = async (name, text) => { await openNote(name); await setEditor(text); await saved(); };
const apiGet = (path) => page.evaluate((p) => fetch(p).then((r) => r.json()), path);
// 他のデバイスからの書き込みの代わり（画面を通さずに API を呼ぶ）
const apiSend = (method, path, body) => page.evaluate(([m, p, b]) => fetch(p, {
  method: m, headers: { "content-type": "application/json", "x-mdv": "1" }, body: JSON.stringify(b),
}).then((r) => r.json()), [method, path, body]);
const notePaths = async () => (await apiGet("/api/notes")).notes.map((n) => n.path);
const openDevicesDialog = async () => { await page.click("#open-devices"); await expect(page.locator("#devices")).toBeVisible(); };
// ダイアログを閉じ、開いたままのものがないことを確かめる（閉じたつもりで次の操作がふさがれないように）
const closeDialog = async () => { await page.keyboard.press("Escape"); await expect(page.locator("dialog[open]")).toHaveCount(0); };

test.beforeAll(async ({ browser }) => {
  ({ page, cdp, authenticatorId } = await openBrowser(browser, "main"));
});

test.beforeEach(({}, info) => { currentTest = info.title; });

test.afterAll(() => {
  // シナリオ全体を通して、スクリプトのエラーや CSP 違反がないこと
  expect(problems).toEqual([]);
});

// ---------------- 2・3 章: ログイン・デバイスの追加 ----------------

test("【2章】最初の 1 台: 合言葉を間違えると承認されず、正しい合言葉とパスキーの登録で使えるようになる", async () => {
  await page.goto("/");
  await expect(page.locator("#gate-none")).toBeVisible();
  await page.fill("#device-name", "自宅PC");
  await page.click("#register-btn");
  await expect(page.locator("#pair-code")).toHaveText(/^\d{6}$/);
  await page.click("#bootstrap-section summary");
  const bootstrapInput = page.locator("#secret");
  await bootstrapInput.fill("wrong-0123456789");
  await page.click("#bootstrap-btn");
  await expect(page.locator("#gate-error")).not.toBeEmpty();
  await expect(page.locator("#gate-pending")).toBeVisible();

  await bootstrapInput.fill(BOOTSTRAP_WORD);
  await page.click("#bootstrap-btn");
  await expect(page.locator("#gate-passkey-setup")).toBeVisible();
  await page.fill("#passkey-setup-name", "Windows Hello");
  await page.click("#passkey-setup-btn");
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#empty")).toBeVisible(); // まだノートがない
});

test("【3章】2 台目: 6 桁のコードで承認し、同期されたパスキーでログインできる。削除するとすぐに使えなくなる", async ({ browser }) => {
  const phone = await openBrowser(browser, "phone");
  const code = await registerDevice(phone.page, "スマートフォン");
  // 承認待ちの 2 台目には、ブートストラップは表示されない
  await expect(phone.page.locator("#bootstrap-section")).toBeHidden();

  await openDevicesDialog();
  const row = page.locator("#device-list tr", { hasText: "スマートフォン" });
  await expect(row).toContainText("承認待ち");
  await row.locator("input.code").fill(code);
  await row.locator('button:has-text("承認")').click();
  await expect(row).toContainText("承認済み");
  await closeDialog();

  // 承認されるとパスキーのログイン画面に進む（承認待ちの画面は数秒ごとに確認している）
  await expect(phone.page.locator("#gate-passkey-login")).toBeVisible({ timeout: 15_000 });
  // iCloud キーチェーンなどで同期されたパスキーの代わりに、1 台目の認証器のパスキーを写す
  // （署名の回数がずれないよう、1 台目が承認で署名した後に写す）
  const phoneId = phone.authenticatorId;
  for (const credential of await credentialsOf(cdp, authenticatorId)) await send(phone.cdp, "WebAuthn.addCredential", { authenticatorId: phoneId, credential });
  await phone.page.click("#passkey-login-btn");
  await expect(phone.page.locator("#app")).toBeVisible();
  // 同期されたパスキーと同じく、2 台目で増えた署名の回数を 1 台目にも反映する（古い回数の署名はサーバーが拒否する）
  for (const credential of await credentialsOf(phone.cdp, phoneId)) {
    await send(cdp, "WebAuthn.removeCredential", { authenticatorId, credentialId: credential.credentialId });
    await send(cdp, "WebAuthn.addCredential", { authenticatorId, credential });
  }

  // 1 台目から削除すると、2 台目は登録の画面に戻る
  await openDevicesDialog();
  answers.push(true);
  await page.locator("#device-list tr", { hasText: "スマートフォン" }).locator('button:has-text("削除")').click();
  await expect(page.locator("#device-list tr", { hasText: "スマートフォン" })).toHaveCount(0);
  await closeDialog();
  await phone.page.reload();
  await expect(phone.page.locator("#gate-none")).toBeVisible();
  await phone.page.context().close();
});

// ---------------- 5 章: ノートを書く ----------------

test("【5章】Alt+N でフォルダの中にノートを作り、自動保存・Ctrl+S で保存できる。Esc で名前の変更を取り消せる", async () => {
  answers.push("仕事/議事録");
  await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.keyboard.press("Alt+n");
  await expect(page.locator("#title")).toHaveValue("仕事/議事録");
  await expect(page.locator('#tree summary:has-text("仕事")')).toBeVisible();

  await setEditor("# 定例会\n\n- 予算の確認");
  await saved();
  expect((await apiGet("/api/note?path=" + encodeURIComponent("仕事/議事録.md"))).content).toBe("# 定例会\n\n- 予算の確認");
  await setEditor("# 定例会\n\n- 予算の確認\n- 次回の日程");
  await page.keyboard.press("Control+s");
  await expect.poll(async () => (await apiGet("/api/note?path=" + encodeURIComponent("仕事/議事録.md"))).content).toContain("次回の日程");

  await page.fill("#title", "別の名前");
  await page.locator("#title").press("Escape");
  await expect(page.locator("#title")).toHaveValue("仕事/議事録");
  expect(await notePaths()).toContain("仕事/議事録.md");
});

test("【5章・15章】他のデバイスと同時に編集したら確認が出て、上書きされた版は履歴から戻せる", async () => {
  await writeNote("共同編集", "最初の内容");
  // 他のデバイスが先に更新する
  const { updated_at } = await apiGet("/api/note?path=" + encodeURIComponent("共同編集.md"));
  await apiSend("PUT", "/api/note", { path: "共同編集.md", content: "他のデバイスの変更", base_updated_at: updated_at });

  // こちらでも編集すると競合する。「キャンセル」= この内容で上書き保存
  answers.push(false);
  await setEditor("こちらの変更");
  await expect.poll(async () => (await apiGet("/api/note?path=" + encodeURIComponent("共同編集.md"))).content).toBe("こちらの変更");

  // 上書きされた版（他のデバイスの変更）は履歴に残っている
  await page.click("#open-history");
  const rev = page.locator("#revision-list li", { hasText: "他デバイスで上書きされた版" });
  await expect(rev).toHaveCount(1);
  await rev.click();
  await expect(page.locator("#revision-preview")).toContainText("他のデバイスの変更");
  answers.push(true);
  await page.click("#restore-revision");
  await expect.poll(editorText).toBe("他のデバイスの変更");
  expect((await apiGet("/api/note?path=" + encodeURIComponent("共同編集.md"))).content).toBe("他のデバイスの変更");
});

// ---------------- 6・7 章: Markdown・リンク・埋め込み ----------------

test("【6章】表・取り消し線・コード・引用・frontmatter が表示される", async () => {
  await writeNote("書きかた", [
    "---", "tags: [見本]", "date: 2026-11-01", "---",
    "## 見出し", "", "~~取り消し~~ と **太字**", "", "> 引用", "",
    "| 列1 | 列2 |", "| --- | --- |", "| a | b |", "",
    "```", "const x = 1;", "```",
  ].join("\n"));
  const preview = page.locator("#preview");
  await expect(preview.locator("table.frontmatter")).toContainText("2026-11-01");
  await expect(preview.locator("h2")).toHaveText("見出し");
  await expect(preview.locator("del")).toHaveText("取り消し");
  await expect(preview.locator("strong")).toHaveText("太字");
  await expect(preview.locator("blockquote")).toContainText("引用");
  await expect(preview.locator("table:not(.frontmatter) td").first()).toHaveText("a");
  await expect(preview.locator("pre code")).toContainText("const x = 1;");
  // frontmatter の tags もタグとして扱われる
  await expect.poll(async () => (await apiGet("/api/tags")).tags.map((t) => t.tag)).toContain("見本");
});

test("【7章】別名・見出しへのリンク、見出しの埋め込み、バックリンク、アウトライン、未作成のノートへのリンク", async () => {
  await writeNote("リンク先", "# リンク先\n\n## 詳細\n\n詳細の本文\n\n## 別の節\n\n別の本文");
  await writeNote("リンク元", "[[リンク先|別名]] と [[リンク先#詳細]] と [[未作成ノート]]\n\n![[リンク先#詳細]]");
  const preview = page.locator("#preview");
  await expect(preview.locator("a.wikilink", { hasText: "別名" })).toHaveAttribute("data-target", "リンク先");
  await expect(preview.locator("a.wikilink.unresolved")).toHaveText("未作成ノート");
  // 見出しの埋め込みは、その節だけ
  const embed = preview.locator(".embed-note");
  await expect(embed).toContainText("詳細の本文");
  await expect(embed).not.toContainText("別の本文");

  // リンク先のバックリンクとアウトライン
  await preview.locator("a.wikilink", { hasText: "別名" }).click();
  await expect(page.locator("#title")).toHaveValue("リンク先");
  await expect(page.locator("#backlinks")).toContainText("リンク元");
  await expect(page.locator("#outline li")).toHaveText(["リンク先", "詳細", "別の節"]);

  // 未作成のノートへのリンクを開くと、そのノートになる（最初の保存で作られる）
  await page.locator("#backlinks a", { hasText: "リンク元" }).click();
  await expect(page.locator("#title")).toHaveValue("リンク元");
  await preview.locator("a.wikilink.unresolved").click();
  await expect(page.locator("#title")).toHaveValue("未作成ノート");
  await setEditor("作成した");
  await saved();
  expect(await notePaths()).toContain("未作成ノート.md");
});

// ---------------- 8 章: 整理 ----------------

test("【8章】右クリックで別のフォルダへ移動し、削除したノートをゴミ箱から復元できる", async () => {
  answers.push("整理/リンク元");
  await page.locator('#tree a.file:has-text("リンク元")').click({ button: "right" });
  await page.click('#context-menu button:has-text("名前の変更・移動")');
  await expect.poll(notePaths).toContain("整理/リンク元.md");
  expect(await notePaths()).not.toContain("リンク元.md");

  await openNote("整理/リンク元");
  answers.push(true);
  await page.click("#delete-note");
  await expect.poll(notePaths).not.toContain("整理/リンク元.md");
  await page.click("#open-trash");
  const row = page.locator("#trash-list tr", { hasText: "整理/リンク元" });
  await row.locator('button:has-text("復元")').click();
  await expect(page.locator("#title")).toHaveValue("整理/リンク元");
  expect(await notePaths()).toContain("整理/リンク元.md");
  // 復元したノートからのリンクも、もう一度バックリンクに出る
  await openNote("リンク先");
  await expect(page.locator("#backlinks")).toContainText("整理/リンク元");
});

// ---------------- 9・10 章: タグ・検索 ----------------

test("【9章・10章】AND・語句・tag:（子のタグを含む）・path: で検索でき、結果から開ける", async () => {
  await writeNote("果樹園/検索A", "りんご と みかん #果物/柑橘");
  await writeNote("検索B", "りんご だけ #果物");
  const search = async (q, count) => {
    await page.fill("#search", q);
    await expect(page.locator("#search-results a")).toHaveCount(count);
  };
  await search("りんご みかん", 1);
  await expect(page.locator("#search-results a")).toContainText("検索A");
  await expect(page.locator("#search-results mark").first()).toBeVisible(); // 一致した箇所の強調
  await search('"りんご だけ"', 1);
  await expect(page.locator("#search-results a")).toContainText("検索B");
  await search("tag:果物", 2);
  await search("tag:果物/柑橘", 1);
  await search("りんご path:果樹園", 1);
  await page.locator("#search-results a").click();
  await expect(page.locator("#title")).toHaveValue("果樹園/検索A");
  await page.locator("#search").press("Escape");
  await expect(page.locator("#search-results")).toBeHidden();
  await expect(page.locator("#tree")).toBeVisible();
});

// ---------------- 11 章: テンプレート ----------------

test("【11章】テンプレートの {{title}}・{{date}}・{{time:…}} が置き換わる", async () => {
  await writeNote("templates/議事録", "# {{title}}\n日付: {{date}}\n時刻: {{time:HH時}}");
  await openNote("会議メモ");
  await page.click("#insert-template");
  await page.click('#picker-list li:has-text("議事録")');
  await expect.poll(editorText).toMatch(/^# 会議メモ\n日付: \d{4}-\d{2}-\d{2}\n時刻: \d{2}時$/);
  await saved();
});

// ---------------- 12 章: 画像 ----------------

test("【12章】📎 で画像を添付し、一覧で使用状況を確認して、未使用になった画像を削除できる", async () => {
  await openNote("画像つき");
  // 小さな PNG を作る
  const png = Buffer.from(await page.evaluate(async () => {
    const c = Object.assign(document.createElement("canvas"), { width: 40, height: 30 });
    c.getContext("2d").fillRect(0, 0, 20, 15);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
  await page.setInputFiles("#file-input", { name: "図1.png", mimeType: "image/png", buffer: png });
  await expect.poll(editorText).toContain("![[図1.png]]");
  await saved();
  await expect(page.locator("#preview img.embed")).toHaveJSProperty("naturalWidth", 40);

  await page.click("#open-attachments");
  const card = page.locator(".attachment-card", { hasText: "図1" });
  await expect(card).toContainText("1 件のノートで使用");
  await closeDialog();

  // 本文から消すと「未使用」になり、削除できる
  await setEditor("画像を外した");
  await saved();
  await page.click("#open-attachments");
  await expect(card).toContainText("未使用");
  answers.push(true);
  await card.locator('button:has-text("削除")').click();
  await expect(page.locator("#attachment-list")).toContainText("画像はまだありません");
  await closeDialog();
});

// ---------------- 14 章: 暗号化 ----------------

test("【14章】暗号化したノートの暗号化を解除すると、サーバーに平文で保存される", async () => {
  await writeNote("金庫", "暗証番号のメモ");
  await page.click("#toggle-encrypt");
  await page.fill("#passphrase-1", "correct horse battery");
  await page.fill("#passphrase-2", "correct horse battery");
  answers.push(true); // 「暗号化しました」の案内
  await page.click('#passphrase-form button[value="ok"]');
  await expect.poll(async () => (await apiGet("/api/note?path=" + encodeURIComponent("金庫.md"))).content).toMatch(/^%%mdvault-encrypted v1%%/);
  // 暗号化したノートは検索に出ない
  await page.fill("#search", "暗証番号");
  await expect(page.locator("#search-results a")).toHaveCount(0);
  await page.locator("#search").press("Escape");

  answers.push(true); // 「暗号化を解除しますか？」
  await page.click("#toggle-encrypt");
  await expect.poll(async () => (await apiGet("/api/note?path=" + encodeURIComponent("金庫.md"))).content).toBe("暗証番号のメモ");
  await expect(page.locator("#toggle-encrypt")).toHaveAttribute("title", "このノートを暗号化");
});

// ---------------- 18・20 章: 表示・ショートカット ----------------

test("【18章・20章】Ctrl+E で編集と閲覧を切り替え、Ctrl+Shift+F で検索、Alt+D で今日のノート、エディタの文字を等幅にできる", async () => {
  await openNote("書きかた");
  await page.keyboard.press("Control+e");
  await expect(page.locator("#workspace")).toHaveClass(/mode-preview/);
  await page.keyboard.press("Control+e");
  await expect(page.locator("#workspace")).toHaveClass(/mode-edit/);
  await page.click('.modes button[data-mode="split"]');
  await expect(page.locator("#workspace")).toHaveClass(/mode-split/);

  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator("#search")).toBeFocused();
  await page.locator("#search").press("Escape");

  // Alt+D で今日のノート（テンプレート templates/daily がないときは、日付の見出しだけのノート）
  await page.keyboard.press("Alt+d");
  await expect(page.locator("#title")).toHaveValue(/^daily\/\d{4}-\d{2}-\d{2}$/);
  expect(await editorText()).toMatch(/^# \d{4}-\d{2}-\d{2}\s*$/);

  await page.click("#open-prefs");
  await page.selectOption('#prefs-form select[name="editorFont"]', "mono");
  await closeDialog();
  const font = await page.evaluate(() => getComputedStyle(document.querySelector("#editor").shadowRoot.querySelector(".cm-content")).fontFamily);
  expect(font).toMatch(/mono/i);
});

// ---------------- 19 章: デバイスとパスキーの管理 ----------------

test("【19章】心当たりのない承認待ちのデバイスを拒否できる", async ({ browser }) => {
  const stranger = await openBrowser(browser, "stranger");
  await registerDevice(stranger.page, "知らない端末");
  await openDevicesDialog();
  const row = page.locator("#device-list tr", { hasText: "知らない端末" });
  await expect(row).toContainText("承認待ち");
  answers.push(true);
  await row.locator('button:has-text("拒否")').click();
  await expect(row).toHaveCount(0);
  await closeDialog();
  await stranger.page.reload();
  await expect(stranger.page.locator("#gate-none")).toBeVisible();
  await stranger.page.context().close();
});

test("【19章】パスキーを追加でき、最後の 1 つは削除できない", async () => {
  await openDevicesDialog();
  // 1 つだけのときは削除できない
  await expect(page.locator("#passkey-list tr")).toHaveCount(1);
  await expect(page.locator('#passkey-list button:has-text("削除")')).toBeDisabled();

  // 2 つ目のパスキーは別の認証器（例: USB セキュリティキー）に作る。
  // 本人確認（既存のパスキーでの署名）は 1 つ目の認証器、作成は 2 つ目の認証器だけが応答するように切り替える
  const { authenticatorId: key } = await send(cdp, "WebAuthn.addVirtualAuthenticator", { options: { ...VIRTUAL_DEVICE, transport: "usb", automaticPresenceSimulation: false } });
  const switched = new Promise((resolve) => {
    cdp.once("WebAuthn.credentialAsserted", async () => {
      await send(cdp, "WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: false });
      await send(cdp, "WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: key, enabled: true });
      resolve();
    });
  });
  await page.waitForTimeout(3500); // E2E 用のサーバーは本人確認の有効時間が 3 秒。必ず本人確認から始まるようにする
  answers.push("セキュリティキー");
  await page.click("#add-passkey");
  await switched;
  await expect(page.locator("#passkey-list tr")).toHaveCount(2);
  await expect(page.locator("#passkey-list")).toContainText("セキュリティキー");
  expect(await credentialsOf(cdp, key)).toHaveLength(1);
  // 1 つ目の認証器に戻す
  await send(cdp, "WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: key, enabled: false });
  await send(cdp, "WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: true });

  // ログイン中ではない方（追加したもの）を削除すると、また 1 つに戻る
  answers.push(true);
  await page.locator("#passkey-list tr", { hasText: "セキュリティキー" }).locator('button:has-text("削除")').click();
  await expect(page.locator("#passkey-list tr")).toHaveCount(1);
  await expect(page.locator('#passkey-list button:has-text("削除")')).toBeDisabled();
  await send(cdp, "WebAuthn.removeVirtualAuthenticator", { authenticatorId: key });
  await closeDialog();
});

test("【19章・2章】ログアウトしてもデバイスの承認は残り、パスキーでログインし直すとノートが読める", async () => {
  await openDevicesDialog();
  await page.click("#logout");
  await expect(page.locator("#gate-passkey-login")).toBeVisible();
  // ログアウト中はノートを読めない
  const res = await page.evaluate(() => fetch("/api/notes").then((r) => r.status));
  expect(res).toBe(401);
  await page.click("#passkey-login-btn");
  await expect(page.locator("#app")).toBeVisible();
  await openNote("仕事/議事録");
  await expect.poll(editorText).toContain("次回の日程");
});

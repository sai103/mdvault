// 画面の E2E テスト。1 つのブラウザでログインし、上から順に機能を操作する
// パスキーは Chromium の仮想認証器（DevTools プロトコル）で代用する
import { expect, test } from "@playwright/test";
import { strToU8, unzipSync, zipSync } from "fflate";

test.describe.configure({ mode: "serial" });

/** @type {import("@playwright/test").Page} */
let page;
let cdp, authenticatorId;
const problems = []; // ページのエラーと CSP 違反
let currentTest = "";
const answers = [];  // prompt / confirm に順番に答える値（true = OK、false = キャンセル、文字列 = 入力）

const editorText = () => page.evaluate(() => document.querySelector("#editor").mdvEditor.getValue());
// エディタの内容を置き換える（キーボード入力の代わり。取り消しの履歴に残る通常の編集として扱われる）
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
const apiGet = (path) => page.evaluate((p) => fetch(p).then((r) => r.json()), path);

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`[${currentTest}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`[${currentTest}] ${m.text()}`); });
  // CSP 違反の詳細（どの要素・どのスクリプトか）も記録する
  await context.exposeBinding("__mdvCspViolation", (_src, detail) => problems.push(`[${currentTest}] CSP: ${detail}`));
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const t = e.target instanceof Element ? e.target.outerHTML.slice(0, 200) : String(e.target?.nodeName);
      window.__mdvCspViolation(`${e.effectiveDirective} sample=${e.sample} source=${e.sourceFile}:${e.lineNumber} target=${t}`);
    }, true);
  });
  page.on("dialog", (d) => {
    const a = answers.shift();
    if (a === false) d.dismiss();
    else d.accept(typeof a === "string" ? a : undefined);
  });
  cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  }));
});

test.beforeEach(({}, info) => { currentTest = info.title; });

test.afterAll(() => {
  // テスト全体を通して、スクリプトのエラーや CSP 違反がないこと
  expect(problems).toEqual([]);
});

test("最初のデバイスを登録し、パスキーでログインできる", async () => {
  await page.goto("/");
  await page.click("#register-btn");
  await expect(page.locator("#pair-code")).not.toBeEmpty();
  await page.click("#bootstrap-section summary");
  await page.fill("#secret", "e2e-bootstrap-secret-0123456789");
  await page.click("#bootstrap-btn");
  await page.click("#passkey-setup-btn");
  await expect(page.locator("#app")).toBeVisible();
});

test("ノートを作り、[[ でリンクを補完でき、プレビューに表示される", async () => {
  await page.keyboard.press("Control+p");
  await page.fill("#switcher-input", "Target");
  await page.keyboard.press("Enter");
  await expect(page.locator("#title")).toHaveValue("Target");
  await setEditor("# Target\n\n本文 #project/alpha\n\n- [ ] やること");
  await saved();

  await openNote("Index");
  await page.locator("#editor .cm-content").click();
  await page.keyboard.type("見出しへのリンク: [[Tar");
  await expect(page.locator("#editor .cm-tooltip-autocomplete")).toContainText("Target");
  // 候補が出た直後（75ms）の Enter は、誤操作防止のため CodeMirror が無視する
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  expect(await editorText()).toBe("見出しへのリンク: [[Target]]");
  await saved();
  await expect(page.locator("#preview a.wikilink")).toHaveText("Target");
  // カーソルのない行では [[ ]] が隠れる（ライブプレビュー）
  await page.keyboard.press("Enter");
  await expect(page.locator("#editor .cm-line").first()).toHaveText("見出しへのリンク: Target");
});

test("悪意のある Markdown でもスクリプトは実行されない（XSS）", async () => {
  await openNote("XSS");
  await setEditor([
    "<img src=x onerror=\"window.__xss=1\">",
    "<script>window.__xss=2</script>",
    "[link](javascript:window.__xss=3)",
    "<a href=\"#\" onclick=\"window.__xss=4\">a</a>",
    "[[x\" onmouseover=\"window.__xss=5]]",
    "<iframe src=\"javascript:window.__xss=6\"></iframe>",
    "<svg><script>window.__xss=7</script></svg>",
    "---", "title: \"<img src=x onerror=window.__xss=8>\"", "---",
  ].join("\n"));
  await saved();
  await page.locator("#preview a").first().hover().catch(() => {});
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  // 文字としては残ってよい。危険な要素・属性が残っていないこと
  const found = await page.evaluate(() => {
    const bad = [];
    for (const node of document.querySelectorAll("#preview *")) {
      if (/^(script|iframe|object|embed|style)$/i.test(node.tagName)) bad.push(node.tagName);
      for (const a of node.attributes) {
        if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) bad.push(`${node.tagName} ${a.name}=${a.value}`);
      }
    }
    return bad;
  });
  expect(found).toEqual([]);
});

test("タグの一覧から検索でき、プレビューのチェックボックスで本文が切り替わる", async () => {
  await openNote("Target");
  await page.click("#tags-panel summary");
  await page.click('#tag-list a:has-text("#project/alpha")');
  await expect(page.locator("#search")).toHaveValue("tag:project/alpha");
  await expect(page.locator("#search-results a")).toHaveCount(1);
  await page.fill("#search", "");
  await page.locator("#search").press("Escape");

  await page.locator('#preview input[type="checkbox"]').click();
  await expect.poll(editorText).toContain("- [x] やること");
  await saved();
});

test("ノートの名前を変えると、リンクしているノートが書き換わる", async () => {
  await page.fill("#title", "Projects/Renamed");
  await page.locator("#title").press("Enter");
  await expect(page.locator("#status")).toHaveText(/1 件のノートのリンクを書き換えました/);
  const { content } = await apiGet("/api/note?path=Index.md");
  expect(content).toContain("[[Renamed]]");
  await expect(page.locator('#tree summary:has-text("Projects")')).toBeVisible();
});

test("フォルダを作り、ドラッグ&ドロップで移動し、名前を変え、削除できる", async () => {
  answers.push("Archive");
  await page.click("#new-folder");
  await expect(page.locator('#tree summary:has-text("Archive")')).toBeVisible();
  // XSS ノートを Archive にドラッグ
  await page.locator('#tree a.file:has-text("XSS")').dragTo(page.locator('#tree summary:has-text("Archive")'));
  await expect.poll(async () => (await apiGet("/api/notes")).notes.map((n) => n.path)).toContain("Archive/XSS.md");
  // メニューから名前の変更
  answers.push("Old");
  await page.locator('#tree summary:has-text("Archive") .more').click();
  await page.click('#context-menu button:has-text("名前の変更")');
  await expect(page.locator('#tree summary:has-text("Old")')).toBeVisible();
  // 削除すると中のノートはゴミ箱へ
  answers.push(true);
  await page.locator('#tree summary:has-text("Old") .more').click();
  await page.click('#context-menu button:has-text("削除")');
  await expect(page.locator('#tree summary:has-text("Old")')).toHaveCount(0);
  await page.click("#open-trash");
  await expect(page.locator("#trash-list")).toContainText("Old/XSS");
  await page.keyboard.press("Escape");
});

test("テンプレートを作り、今日のノートに使われる", async () => {
  await openNote("templates/daily");
  await setEditor("# {{date:YYYY年MM月DD日}}\n\n## 予定\n");
  await saved();
  await page.click("#open-daily");
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await expect(page.locator("#title")).toHaveValue(`daily/${ymd}`);
  expect(await editorText()).toContain(`# ${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, "0")}月`);
  // 📄 から挿入
  await page.click("#insert-template");
  await page.click('#picker-list li:has-text("daily")');
  await expect.poll(editorText).toMatch(/## 予定[\s\S]*## 予定/);
  await saved();
});

test("ノートを暗号化すると、サーバーには暗号文だけが保存され、パスフレーズで開ける", async () => {
  await openNote("Secret");
  await setEditor("ひみつのメモ #private");
  await saved();
  await page.click("#toggle-encrypt");
  await page.fill("#passphrase-1", "correct horse battery");
  await page.fill("#passphrase-2", "correct horse battery");
  answers.push(true); // 「暗号化しました」の案内
  await page.click('#passphrase-form button[value="ok"]');
  await expect.poll(async () => (await apiGet("/api/note?path=Secret.md")).content).toMatch(/^%%mdvault-encrypted v1%%/);
  const { content } = await apiGet("/api/note?path=Secret.md");
  expect(content).not.toContain("ひみつ");
  const { revisions } = await apiGet("/api/revisions?path=Secret.md");
  expect(revisions).toHaveLength(0); // 暗号化前の履歴は消した
  // 開き直すとパスフレーズを聞かれる（タブを開き直すと覚えていない）
  await page.reload();
  await openNote("Secret");
  await expect(page.locator("#locked")).toBeVisible();
  await page.fill("#unlock-pass", "wrong passphrase");
  await page.click("#locked button");
  await expect(page.locator("#unlock-error")).toHaveText("パスフレーズが違います");
  await page.fill("#unlock-pass", "correct horse battery");
  await page.click("#locked button");
  await expect.poll(editorText).toBe("ひみつのメモ #private");
  await expect(page.locator('#tree a.file:has-text("Secret")')).toHaveText(/🔒/);
});

test("大きい写真はアップロード前に縮小される", async () => {
  await openNote("Photo");
  // 4000x3000 の JPEG を作って貼り付ける
  await page.evaluate(async () => {
    const c = Object.assign(document.createElement("canvas"), { width: 4000, height: 3000 });
    const g = c.getContext("2d");
    g.fillStyle = "#3a6"; g.fillRect(0, 0, 4000, 3000); g.fillStyle = "#fff"; g.fillRect(100, 100, 2000, 1000);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "big.jpg", { type: "image/jpeg" }));
    document.querySelector("#editor").shadowRoot.querySelector(".cm-content")
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(editorText).toContain("![[big.jpg]]");
  await expect(page.locator("#preview img.embed")).toHaveJSProperty("naturalWidth", 2560);
});

test("Vault を zip で書き出し、別の Vault の zip を取り込める", async () => {
  await page.click("#open-vault");
  const download = page.waitForEvent("download");
  await page.click("#vault-export");
  const file = await (await download).path();
  const names = Object.keys(unzipSync(new Uint8Array(await (await import("node:fs/promises")).readFile(file))));
  expect(names).toEqual(expect.arrayContaining(["Index.md", "Projects/Renamed.md", "attachments/big.jpg"]));

  const zip = zipSync({
    "MyVault/.obsidian/app.json": strToU8("{}"),
    "MyVault/Imported.md": strToU8("取り込んだノート [[Sub/Child]]"),
    "MyVault/Sub/Child.md": strToU8("子ノート #imported"),
    "MyVault/doc.pdf": strToU8("%PDF"),
  });
  await page.setInputFiles("#vault-import-file", { name: "vault.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await expect(page.locator("#vault-progress")).toContainText("ノート 2 件");
  await expect(page.locator("#vault-progress")).toContainText("MyVault");
  await page.click("#vault-import-start");
  await expect(page.locator("#vault-progress")).toContainText("新規 2 件");
  await page.keyboard.press("Escape");
  const notes = (await apiGet("/api/notes")).notes.map((n) => n.path);
  expect(notes).toEqual(expect.arrayContaining(["Imported.md", "Sub/Child.md"]));
  expect(notes.some((p) => p.includes(".obsidian"))).toBe(false);
});

test("自動バックアップから 1 件だけ元に戻せる", async () => {
  await openNote("Imported");
  await page.click("#open-backups");
  await page.click("#backup-now");
  await expect(page.locator("#backup-list li").first()).not.toHaveText(/まだありません/);
  await page.keyboard.press("Escape");
  // バックアップの後に書き換えてから、バックアップの内容に戻す
  await setEditor("書き換えた");
  await saved();
  await page.click("#open-backups");
  await page.locator("#backup-list li").first().click();
  await page.fill("#backup-filter", "Imported");
  await page.locator("#backup-notes li", { hasText: "Imported" }).click();
  answers.push(true);
  await page.click('#backup-preview button:has-text("この内容に戻す")');
  await expect.poll(editorText).toBe("取り込んだノート [[Sub/Child]]");
});

test("グラフビューにノートとリンクが表示される", async () => {
  await page.click("#open-graph");
  await expect(page.locator("#graph-info")).toHaveText(/ノート \d+ 件・リンク [1-9]\d* 本/);
  await page.keyboard.press("Escape");
});

test("本人確認が必要な操作（デバイスの承認）では、パスキーでの確認を求められる", async ({ browser }) => {
  // 別のブラウザで 2 台目を登録する
  const other = await (await browser.newContext()).newPage();
  await other.goto("/");
  await other.click("#register-btn");
  await expect(other.locator("#pair-code")).toHaveText(/^\d{6}$/);
  const code = (await other.locator("#pair-code").textContent()).trim();
  const signCount = async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials[0].signCount;
  const before = await signCount();
  // E2E 用のサーバーは本人確認の有効時間が 3 秒
  await page.waitForTimeout(3500);
  await page.click("#open-devices");
  await page.fill("#device-list input.code", code);
  await page.click('#device-list button:has-text("承認")');
  await expect(other.locator("#gate-passkey-login")).toBeVisible({ timeout: 15000 });
  expect(await signCount()).toBeGreaterThan(before); // パスキーで署名した（本人確認が行われた）
  await page.keyboard.press("Escape");
  await other.context().close();
});

test("表示の設定でテーマと文字の大きさを変えられる", async () => {
  await page.click("#open-prefs");
  await page.selectOption('#prefs-form select[name="theme"]', "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator('#prefs-form input[name="fontSize"]').fill("18");
  await expect(page.locator("#font-size-value")).toHaveText("18px");
  await page.keyboard.press("Escape");
});

test("オフラインでも一度開いたノートを読め、編集は接続が戻ってから保存される", async () => {
  await openNote("Index");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 }).catch(async () => { await page.reload(); });
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#title")).toHaveValue("Index");
  await setEditor("オフラインで書いた");
  await expect(page.locator("#status")).toHaveText(/オフライン/);
  await expect(page.locator("#offline-banner")).toBeVisible();
  await page.context().setOffline(false);
  await expect.poll(async () => (await apiGet("/api/note?path=Index.md")).content, { timeout: 20000 }).toBe("オフラインで書いた");
  await expect(page.locator("#offline-banner")).toBeHidden();
});

test("ログアウトすると、端末に残したノートのキャッシュが消える", async () => {
  await page.click("#open-devices");
  await page.click("#logout");
  await expect(page.locator("#gate-passkey-login")).toBeVisible();
  // ノート・一覧・画像は残っていない（ログイン状態の確認 /api/device は、開き直したときに改めて入る）
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const k of (await caches.keys()).filter((x) => x.startsWith("mdvault-data"))) {
      for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
    }
    return out;
  });
  expect(cached.filter((p) => p !== "/api/device")).toEqual([]);
});

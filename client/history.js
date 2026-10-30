// 履歴・ゴミ箱・自動バックアップ
import { api, settings } from "./api.js";
import { decrypt, isEncrypted, rememberedPassphrase } from "./crypto.js";
import { flushSave, openNote, refreshAll } from "./notes.js";
import { renderMarkdown } from "./render.js";
import { state } from "./state.js";
import { $, el, fmtSize, fmtTime, fuzzy, noteHref, stripMd } from "./util.js";

const REASONS = {
  edit: "編集前", overwrite: "他デバイスで上書きされた版", delete: "削除時", restore: "復元前",
  rename: "リンク書き換え前", import: "取り込みで上書きされる前",
};

// 暗号化された版は、このタブでパスフレーズを入力済みなら復号して表示する
async function showContent(container, content) {
  if (isEncrypted(content)) {
    const pass = rememberedPassphrase();
    if (!pass) return container.replaceChildren(el("p", { className: "muted", textContent: "🔒 暗号化されています（ノートを開いてパスフレーズを入力すると表示できます）" }));
    try { content = (await decrypt(content, pass)).text; } catch { return container.replaceChildren(el("p", { className: "muted", textContent: "🔒 この版は別のパスフレーズで暗号化されています" })); }
  }
  renderMarkdown(container, content);
}

// ---------------- 履歴 ----------------

export async function openHistory() {
  const cur = state.current;
  if (!cur) return;
  await flushSave();
  const { revisions } = await api("GET", "/api/revisions?path=" + encodeURIComponent(cur.path));
  $("#revision-preview").replaceChildren(el("p", {
    className: "muted",
    textContent: revisions.length ? "左の一覧から版を選んでください" : `まだ履歴がありません（編集すると${settings.revision_interval_minutes}分ごとに記録されます）`,
  }));
  $("#restore-revision").hidden = true;
  $("#revision-list").replaceChildren(...revisions.map((r) => {
    const li = el("li", {}, fmtTime(r.saved_at), el("small", { textContent: `${REASONS[r.reason] ?? r.reason} · ${r.size}文字` }));
    li.onclick = async () => {
      $("#revision-list").querySelectorAll("li").forEach((x) => x.classList.toggle("active", x === li));
      const rev = await api("GET", "/api/revision?id=" + r.id);
      await showContent($("#revision-preview"), rev.content);
      $("#restore-revision").hidden = false;
      $("#restore-revision").onclick = async () => {
        if (!confirm("この版に戻しますか？（現在の内容も履歴に残ります）")) return;
        await restoreRevision(r.id);
        $("#history").close();
      };
    };
    return li;
  }));
  $("#history").showModal();
}

async function restoreRevision(id) {
  await flushSave();
  const { path } = await api("POST", "/api/note/restore", { id });
  await refreshAll();
  state.current = null;
  history.replaceState(null, "", noteHref(path));
  await openNote(path);
}

// ---------------- ゴミ箱 ----------------

export async function openTrash() {
  const { trash } = await api("GET", "/api/trash");
  $("#trash-list").replaceChildren(...(trash.length ? trash.map((t) => el("tr", {},
    el("td", { textContent: stripMd(t.path) }),
    el("td", { textContent: fmtTime(t.deleted_at) }),
    el("td", {}, el("button", {
      textContent: "復元", className: "primary",
      onclick: () => restoreRevision(t.id).then(() => $("#trash").close(), (e) => alert(e.message)),
    }))))
    : [el("tr", {}, el("td", { colSpan: 3, className: "muted", textContent: "空です" }))]));
  if (!$("#trash").open) $("#trash").showModal();
}

// ---------------- 自動バックアップ ----------------

let loaded = null; // 開いているバックアップの中身

export async function openBackups() {
  const { backups, retention_days } = await api("GET", "/api/backups");
  $("#backup-retention").textContent = `毎日 1 回、自動で保存されます（${retention_days} 日分を保持）。`;
  $("#backup-list").replaceChildren(...(backups.length ? backups.map((b) => el("li", {
    onclick: (e) => loadBackup(b, e.currentTarget),
  }, b.date, el("small", { textContent: fmtSize(b.size) })))
    : [el("li", { className: "muted", textContent: "まだありません。「今すぐバックアップ」で作れます" })]));
  $("#backup-notes").replaceChildren();
  $("#backup-filter").hidden = true;
  $("#backup-preview").replaceChildren(el("p", { className: "muted", textContent: "左の一覧から日付を選ぶと、その日のノートを 1 件ずつ見て復元できます" }));
  if (!$("#backups").open) $("#backups").showModal();
}

async function loadBackup(b, li) {
  $("#backup-list").querySelectorAll("li").forEach((x) => x.classList.toggle("active", x === li));
  $("#backup-preview").replaceChildren(el("p", { className: "muted", textContent: "読み込み中…" }));
  // サーバーは gzip のまま返すので、ブラウザで展開する
  const res = await fetch("/api/backup?key=" + encodeURIComponent(b.key));
  if (!res.ok) return alert("読み込めませんでした");
  loaded = JSON.parse(await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text());
  $("#backup-filter").hidden = false;
  $("#backup-filter").value = "";
  drawBackupNotes();
  $("#backup-preview").replaceChildren(el("p", { className: "muted", textContent: `${b.date} 時点のノート ${loaded.notes.length} 件` }));
}

function drawBackupNotes() {
  const q = $("#backup-filter").value.trim().toLowerCase();
  const current = new Map(state.notes.map((n) => [n.path, n]));
  $("#backup-notes").replaceChildren(...loaded.notes.filter((n) => fuzzy(n.path.toLowerCase(), q)).slice(0, 300).map((n) => {
    const now = current.get(n.path);
    const label = !now ? "削除済み" : now.updated_at === n.updated_at ? "変更なし" : "現在と異なる";
    const li = el("li", {}, stripMd(n.path), el("small", { textContent: label }));
    li.onclick = async () => {
      $("#backup-notes").querySelectorAll("li").forEach((x) => x.classList.toggle("active", x === li));
      const box = el("article", { className: "markdown" });
      await showContent(box, n.content);
      $("#backup-preview").replaceChildren(
        el("div", { className: "dialog-actions" }, el("strong", { textContent: stripMd(n.path) }), el("button", {
          className: "primary", textContent: now ? "この内容に戻す" : "このノートを復元",
          onclick: () => restoreFromBackup(n),
        })), box);
    };
    return li;
  }));
}

// 現在の内容は履歴（他デバイスで上書きされた版）に残るので、元にも戻せる
async function restoreFromBackup(n) {
  const exists = state.notes.some((x) => x.path === n.path);
  if (!confirm(exists ? `「${stripMd(n.path)}」をバックアップの内容に戻しますか？（現在の内容は履歴に残ります）` : `「${stripMd(n.path)}」を復元しますか？`)) return;
  await flushSave();
  await api("PUT", "/api/note", { path: n.path, content: n.content });
  await refreshAll();
  $("#backups").close();
  state.current = null;
  history.replaceState(null, "", noteHref(n.path));
  await openNote(n.path);
}

export function setupHistory() {
  $("#open-history").onclick = () => openHistory().catch((e) => alert(e.message));
  $("#open-trash").onclick = () => openTrash().catch((e) => alert(e.message));
  $("#open-backups").onclick = () => openBackups().catch((e) => alert(e.message));
  $("#backup-filter").oninput = drawBackupNotes;
  $("#backup-now").onclick = async () => {
    $("#backup-now").disabled = true;
    try {
      const r = await api("POST", "/api/backups");
      alert(`バックアップしました（ノート ${r.notes} 件、${fmtSize(r.size)}）`);
      await openBackups();
    } catch (e) {
      alert(e.message);
    } finally {
      $("#backup-now").disabled = false;
    }
  };
}

// 画面の入口。各機能をつなぎ、ログインを確認してからノートを開く
import { setupAttachments, uploadImages, imageLinkText } from "./attachments.js";
import { checkLogin, setupDevices, setupGate } from "./auth.js";
import { setupDaily, openDailyNote } from "./daily.js";
import { closeMenu } from "./dialogs.js";
import { createEditor } from "./editor.js";
import { setupGraph } from "./graph.js";
import { setupHistory } from "./history.js";
import {
  closeCurrent, deleteNote, flushSave, moveNote, navigate, newNote, openLink, openNote, pathFromHash, refreshAll,
  renderPreview, scheduleSave, schedulePreview, setEditor, toggleEncryption, toggleTask, unlock,
} from "./notes.js";
import { applyPrefs, prefs, setupPrefs } from "./prefs.js";
import { registerServiceWorker, watchOnline } from "./pwa.js";
import { openSwitcher, setSearch, setupSearch, setupSwitcher } from "./search.js";
import { refreshAttachments, state } from "./state.js";
import { setupTree } from "./tree.js";
import { setupVault } from "./vault.js";
import { syncDrafts } from "./notes.js";
import { $, basename, noteHref, store, stripMd, toPath } from "./util.js";

// ---------------- エディタ ----------------

const editor = createEditor($("#editor"), {
  onChange() {
    if (!state.current || state.current.locked) return;
    scheduleSave();
    schedulePreview();
  },
  // [[ / ![[ / # の補完候補。ファイル名が重複するノート・画像はフルパスで挿入する
  completions(kind) {
    if (kind === "image") return state.attachments.map((a) => ({ label: basename(a.path), detail: a.path, insert: imageLinkText(a.path) }));
    if (kind === "tag") return state.tags.map((t) => ({ label: t.tag, detail: `${t.count}`, insert: t.tag }));
    const names = new Map();
    for (const n of state.notes) names.set(stripMd(basename(n.path)), (names.get(stripMd(basename(n.path))) ?? 0) + 1);
    return state.notes.map((n) => {
      const name = stripMd(basename(n.path));
      return { label: name, detail: n.path.includes("/") ? stripMd(n.path) : undefined, insert: names.get(name) > 1 ? stripMd(n.path) : name };
    });
  },
  onFiles: (files) => uploadImages(files),
  onOpenLink: openLink,
});
setEditor(editor);

// ---------------- プレビューのクリック ----------------

$("#preview").addEventListener("click", (e) => {
  const link = e.target.closest("a.wikilink");
  if (link) { e.preventDefault(); openLink(link.dataset.target); return; }
  const tag = e.target.closest("a.tag");
  if (tag) { e.preventDefault(); setSearch("tag:" + tag.dataset.tag); document.body.classList.add("show-sidebar"); return; }
  if (e.target.matches('input[type="checkbox"]')) {
    e.preventDefault();
    const boxes = [...$("#preview").querySelectorAll('input[type="checkbox"]')].filter((b) => !b.closest(".embed-note"));
    const i = boxes.indexOf(e.target);
    if (i >= 0) toggleTask(i);
  }
});

// ---------------- タイトル（名前の変更）・削除・暗号化 ----------------

$("#title").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  if (e.key === "Escape") { e.target.value = stripMd(state.current?.path ?? ""); e.target.blur(); }
});
$("#title").addEventListener("change", async () => {
  const cur = state.current;
  if (!cur) return;
  const to = toPath($("#title").value);
  if (to === cur.path) return;
  try {
    if (cur.updated_at === null) { // まだ保存していないノート
      cur.path = to;
      history.replaceState(null, "", noteHref(to));
    } else await moveNote(cur.path, to);
  } catch (e) {
    alert(e.message);
    $("#title").value = stripMd(cur.path);
  }
});
$("#delete-note").onclick = () => state.current && deleteNote(state.current.path).catch((e) => alert(e.message));
$("#toggle-encrypt").onclick = () => toggleEncryption().catch((e) => alert(e.message));
$("#locked").onsubmit = (e) => { e.preventDefault(); unlock($("#unlock-pass").value); };

// ---------------- 表示の切り替え・サイドバー ----------------

function setMode(mode) {
  const ws = $("#workspace");
  ws.classList.remove("mode-edit", "mode-split", "mode-preview");
  ws.classList.add("mode-" + mode);
  document.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  store.set("mode", mode);
  if (mode !== "edit") renderPreview();
}
document.querySelectorAll(".modes button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("#toggle-sidebar").onclick = () => document.body.classList.toggle(innerWidth < 800 ? "show-sidebar" : "hide-sidebar");
$("#toggle-right").onclick = () => document.body.classList.toggle(innerWidth < 800 ? "show-right" : "hide-right");
// モバイル: ドロワーの外をタップしたら閉じる
$(".main").addEventListener("click", (e) => {
  if (innerWidth < 800 && !e.target.closest(".toolbar")) document.body.classList.remove("show-sidebar", "show-right");
});
$("#new-note").onclick = () => newNote().catch((e) => alert(e.message));

// ---------------- キーボード ----------------

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape") closeMenu();
  if (mod && (e.key === "p" || e.key === "o")) { e.preventDefault(); openSwitcher(); }
  else if (mod && e.key === "s") { e.preventDefault(); flushSave(); }
  else if (mod && e.key === "e") { e.preventDefault(); setMode($("#workspace").classList.contains("mode-preview") ? "edit" : "preview"); }
  else if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) { e.preventDefault(); document.body.classList.add("show-sidebar"); $("#search").focus(); }
  else if (e.altKey && e.code === "KeyN") { e.preventDefault(); newNote(); }
  else if (e.altKey && e.code === "KeyD") { e.preventDefault(); openDailyNote().catch((err) => alert(err.message)); }
});

// ---------------- 保存のタイミング ----------------

window.addEventListener("beforeunload", (e) => { if (state.dirty) e.preventDefault(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });
window.addEventListener("hashchange", () => {
  const path = pathFromHash();
  if (path && path !== state.current?.path) openNote(path).catch((e) => alert(e.message));
});

// ---------------- 起動 ----------------

let started = false;
async function startApp() {
  if (started) return;
  started = true;
  $("#gate").hidden = true;
  $("#app").hidden = false;
  setMode(store.get("mode", innerWidth < 800 ? "edit" : "split"));
  watchOnline(() => syncDrafts().catch(() => {}));
  // オフラインで、まだキャッシュがないものは読めない。読めたものだけで続ける
  const results = await Promise.allSettled([refreshAll(), refreshAttachments()]);
  if (results.some((r) => r.status === "rejected")) $("#status").textContent = "一部を読み込めませんでした（オフライン？）";
  const path = pathFromHash() ?? store.get("lastNote", null);
  if (path && (state.notes.some((n) => n.path === path) || pathFromHash())) {
    history.replaceState(null, "", noteHref(path));
    await openNote(path);
  } else if (state.notes.length) navigate(state.notes[0].path);
  else closeCurrent();
}

applyPrefs();
editor.setLivePreview(prefs.livePreview);
setupGate(startApp);
setupDevices(flushSave);
setupTree();
setupSearch();
setupSwitcher();
setupHistory();
setupAttachments();
setupVault();
setupDaily();
setupGraph();
setupPrefs();
registerServiceWorker();

checkLogin().then((ok) => ok && startApp()).catch((e) => {
  $("#gate").hidden = false;
  $("#gate-error").textContent = "接続できません: " + e.message;
});

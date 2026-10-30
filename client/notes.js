// ノートを開く・保存する・名前を変える・削除する。オフライン中の下書きと、暗号化されたノートもここで扱う
import { api, isNetworkError, settings } from "./api.js";
import { decrypt, encrypt, forgetPassphrase, isEncrypted, newKey, rememberPassphrase, rememberedPassphrase } from "./crypto.js";
import { askPassphrase } from "./dialogs.js";
import { setOffline } from "./pwa.js";
import { headings, renderMarkdown, taskPositions } from "./render.js";
import { refreshNoteList, refreshTags, resolveLink, state } from "./state.js";
import { renderTree } from "./tree.js";
import { renderTagList } from "./search.js";
import { $, basename, dirname, el, noteHref, store, stripMd, toPath } from "./util.js";

/** @type {ReturnType<typeof import("./editor.js").createEditor>} */
let editor;
export const setEditor = (e) => { editor = e; };
export const getEditor = () => editor;

// ---------------- ルーティング ----------------

export const pathFromHash = () => {
  const h = location.hash.slice(2);
  return h ? h.split("/").map(decodeURIComponent).join("/") : null;
};
export const navigate = (path) => { location.hash = noteHref(path); };

export async function refreshAll() {
  await Promise.all([refreshNoteList(), refreshTags()]);
  renderTree();
  renderTagList();
  $("#empty").hidden = state.notes.length > 0 || !!state.current;
}

// ---------------- 開く ----------------

export async function openNote(path) {
  await flushSave();
  let note;
  try {
    note = await api("GET", "/api/note?path=" + encodeURIComponent(path));
  } catch (e) {
    if (e.status !== 404) throw e;
    note = { path, content: "", updated_at: null }; // 未作成のノート（最初の保存で作られる）
  }
  const current = { ...note, crypto: null, locked: false };
  let dirtyFromDraft = false;

  // オフライン中に保存できなかった変更がこの端末に残っていれば、それを使う
  const draft = store.get("draft:" + path, null);
  if (draft) {
    if (draft.base === note.updated_at || confirm("この端末に、保存できていない変更が残っています。\nただし、その後に他のデバイスでこのノートが更新されています。\n\nOK: この端末の変更で上書きする\nキャンセル: この端末の変更を捨てる")) {
      current.content = draft.content;
      current.updated_at = draft.base === note.updated_at ? note.updated_at : undefined; // undefined = 強制上書き
      dirtyFromDraft = true;
    } else {
      store.remove("draft:" + path);
    }
  }

  state.current = current;
  state.dirty = false;
  store.set("lastNote", path);
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) state.openFolders.add(parts.slice(0, i).join("/"));
  $("#title").value = stripMd(path);
  $("#empty").hidden = true;
  $("#workspace").hidden = false;
  document.title = `${stripMd(basename(path))} - mdvault`;
  setStatus(dirtyFromDraft ? "未保存（この端末の下書き）" : "");
  renderTree();
  loadBacklinks();
  if (innerWidth < 800) document.body.classList.remove("show-sidebar");

  if (isEncrypted(current.content)) {
    showLocked();
    const pass = rememberedPassphrase();
    if (pass) await unlock(pass, { silent: true });
  } else {
    showText(current.content);
  }
  if (dirtyFromDraft && !current.locked) scheduleSave();
}

function showText(text) {
  $("#locked").hidden = true;
  $("#workspace").classList.remove("is-locked");
  editor.setReadOnly(false);
  editor.setValue(text);
  updateLockButton();
  renderPreview();
}

// ---------------- 暗号化されたノート ----------------

function showLocked() {
  state.current.locked = true;
  $("#workspace").classList.add("is-locked");
  $("#locked").hidden = false;
  $("#unlock-pass").value = "";
  $("#unlock-error").textContent = "";
  editor.setReadOnly(true);
  editor.setValue("");
  $("#preview").replaceChildren();
  $("#outline").replaceChildren();
  updateLockButton();
}

export async function unlock(passphrase, { silent = false } = {}) {
  const cur = state.current;
  try {
    $("#unlock-error").textContent = "開いています…";
    const { text, crypto } = await decrypt(cur.content, passphrase);
    if (state.current !== cur) return;
    cur.crypto = crypto;
    cur.locked = false;
    if ($("#unlock-remember").checked || silent) rememberPassphrase(passphrase);
    showText(text);
  } catch (e) {
    $("#unlock-error").textContent = silent ? "" : e.message;
    if (silent) forgetPassphrase();
  }
}

function updateLockButton() {
  const cur = state.current;
  $("#toggle-encrypt").classList.toggle("active", !!cur?.crypto || !!cur?.locked);
  $("#toggle-encrypt").title = cur?.crypto || cur?.locked ? "暗号化を解除" : "このノートを暗号化";
}

export async function toggleEncryption() {
  const cur = state.current;
  if (!cur || cur.locked) return;
  if (!cur.crypto) {
    const answer = await askPassphrase({
      title: "このノートを暗号化",
      message: "ブラウザの中で暗号化し、サーバーには暗号文だけを保存します。パスフレーズを忘れると、誰にも（このアプリでも）元に戻せません。暗号化したノートは検索・タグ・バックリンクの対象外になり、名前を変えても中のリンクは書き換わりません。",
      confirm: true,
      option: { label: "これまでの履歴（暗号化前の内容）を削除する", checked: true },
    });
    if (!answer) return;
    setStatus("暗号化しています…");
    cur.crypto = await newKey(answer.passphrase);
    rememberPassphrase(answer.passphrase);
    state.dirty = true;
    await save();
    if (answer.option) await api("DELETE", "/api/revisions?path=" + encodeURIComponent(cur.path));
    alert("暗号化しました。\n\n注意: 暗号化する前に作られた自動バックアップや書き出したファイルには、暗号化前の内容が残っています。");
  } else {
    if (!confirm("暗号化を解除しますか？ サーバーには暗号化されていない内容が保存されます。")) return;
    cur.crypto = null;
    state.dirty = true;
    await save();
  }
  updateLockButton();
  await refreshAll();
}

// ---------------- 保存 ----------------

export function setStatus(s) { $("#status").textContent = s; }

export function scheduleSave() {
  if (!state.current || state.current.locked) return;
  state.dirty = true;
  setStatus("未保存");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, settings.autosave_delay_ms);
}

export async function flushSave() {
  clearTimeout(state.saveTimer);
  if (state.saving) await state.saving;
  if (state.dirty) await save();
}

// updated_at が undefined のノートは強制上書き（この端末の下書きを優先すると決めたとき）
export async function save(force = false) {
  const note = state.current;
  if (!note || !state.dirty || note.locked) return;
  if (state.saving) return state.saving.then(() => save(force));
  const text = editor.getValue();
  const isNew = note.updated_at === null;
  const wasEncrypted = isEncrypted(note.content);
  state.dirty = false;
  setStatus("保存中…");
  state.saving = (async () => {
    // 暗号化されたノートは、保存のたびにブラウザで暗号化してから送る
    const content = note.crypto ? await encrypt(text, note.crypto) : text;
    const base = force || note.updated_at === undefined ? {} : { base_updated_at: note.updated_at };
    try {
      const r = await api("PUT", "/api/note", { path: note.path, content, ...base });
      note.updated_at = r.updated_at;
      note.content = content;
      store.remove("draft:" + note.path);
      setOffline(false);
      setStatus(state.dirty ? "未保存" : "保存済み");
      // 新しいノート、または暗号化した・解除したときは一覧（🔒 の表示）を更新する
      if (isNew || wasEncrypted !== isEncrypted(content)) await refreshAll();
      else refreshTags().then(renderTagList);
    } catch (e) {
      state.dirty = true;
      if (isNetworkError(e)) {
        // つながらないときは、この端末に下書きとして残して、接続が戻ったら送る
        store.set("draft:" + note.path, { content, base: note.updated_at === undefined || force ? "force" : note.updated_at, at: Date.now() });
        setStatus("オフライン: この端末に保存しました");
        setOffline(true);
        retryLater();
        return;
      }
      if (e.status === 409) {
        state.saving = null;
        if (confirm("このノートは他のデバイスで更新されています。\nOK: サーバーの内容を読み込む（ここでの変更は破棄）\nキャンセル: この内容で上書き保存")) {
          state.dirty = false;
          store.remove("draft:" + note.path);
          state.current = null;
          return openNote(note.path);
        }
        return save(true);
      }
      setStatus("保存失敗: " + e.message);
    } finally {
      state.saving = null;
    }
  })();
  return state.saving;
}

// 送れなかった変更は、接続が戻ったとき（online イベント）に加えて、10 秒ごとにも送り直す
let retryTimer = 0;
function retryLater() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => syncDrafts().catch(() => {}), 10_000);
}

// 接続が戻ったら、開いているノートの変更を送り、ほかのノートの下書きも送る
export async function syncDrafts() {
  if (state.dirty) await save();
  for (const key of store.keys("draft:")) {
    const path = key.slice("draft:".length);
    if (path === state.current?.path) continue;
    const draft = store.get(key, null);
    if (!draft) continue;
    try {
      await api("PUT", "/api/note", { path, content: draft.content, ...(draft.base === "force" ? {} : { base_updated_at: draft.base }) });
      store.remove(key);
    } catch (e) {
      if (isNetworkError(e)) return retryLater();
      if (e.status === 409) setStatus(`「${stripMd(path)}」は他のデバイスでも更新されています。開いてどちらを残すか選んでください`);
    }
  }
}

// ---------------- プレビュー ----------------

let previewTimer = 0;
export function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
}

export function renderPreview() {
  clearTimeout(previewTimer);
  if (!state.current || state.current.locked) return;
  const content = editor.getValue();
  renderMarkdown($("#preview"), content);
  renderOutline(content);
}

function renderOutline(content) {
  const items = headings(content);
  $("#outline").replaceChildren(...items.map((h, i) => {
    const li = el("li", {
      textContent: h.text,
      onclick: () => {
        $("#preview").querySelectorAll("h1,h2,h3,h4,h5,h6")[i]?.scrollIntoView({ behavior: "smooth" });
        if (!$("#workspace").classList.contains("mode-preview")) editor.setCursor(h.offset);
      },
    });
    li.style.paddingLeft = (h.level - 1) * 12 + "px";
    return li;
  }));
}

// プレビューのチェックボックスを押したら、本文の [ ] / [x] を切り替える
export function toggleTask(index) {
  const task = taskPositions(editor.getValue())[index];
  if (!task || state.current?.locked) return;
  editor.replaceRange(task.pos, task.pos + 1, task.checked ? " " : "x");
}

export async function loadBacklinks() {
  const path = state.current?.path;
  if (!path) return;
  const { backlinks } = await api("GET", "/api/backlinks?path=" + encodeURIComponent(path)).catch(() => ({ backlinks: [] }));
  if (path !== state.current?.path) return;
  $("#backlinks").replaceChildren(...(backlinks.length
    ? backlinks.map(({ path: p }) => el("li", {}, el("a", { href: noteHref(p), textContent: stripMd(p) })))
    : [el("li", { className: "muted", textContent: "なし" })]));
}

export function openLink(target) {
  const t = target.split("#")[0].trim();
  if (!t) return;
  navigate(resolveLink(t) ?? toPath(t));
}

// ---------------- 作成・名前変更・削除 ----------------

export async function newNote(name, content = "") {
  name ??= prompt("ノート名（フォルダは / で区切る）", dirname(state.current?.path ?? "") ? dirname(state.current.path) + "/" : "");
  if (!name?.trim()) return;
  const path = toPath(name);
  if (!state.notes.some((n) => n.path === path)) {
    await api("PUT", "/api/note", { path, content, base_updated_at: null });
    await refreshAll();
  }
  navigate(path);
}

// ノートの名前変更・移動。リンクしている他のノートはサーバーが書き換える
export async function moveNote(from, to) {
  if (from === to) return;
  if (state.current?.path === from) await flushSave();
  const { updated } = await api("POST", "/api/note/rename", { from, to });
  store.remove("draft:" + from);
  if (state.current?.path === from) {
    state.current.path = to;
    history.replaceState(null, "", noteHref(to));
    store.set("lastNote", to);
    $("#title").value = stripMd(to);
  }
  await refreshAll();
  // 開いているノートのリンクが書き換わった場合は読み直す
  if (state.current && updated.includes(state.current.path)) {
    const path = state.current.path;
    state.current = null;
    await openNote(path);
  } else loadBacklinks();
  if (updated.length) setStatus(`${updated.length} 件のノートのリンクを書き換えました`);
}

export async function deleteNote(path) {
  if (!confirm(`「${stripMd(path)}」を削除しますか？（ゴミ箱から復元できます）`)) return;
  if (state.current?.path === path) {
    clearTimeout(state.saveTimer);
    state.dirty = false;
  }
  await api("DELETE", "/api/note?path=" + encodeURIComponent(path));
  store.remove("draft:" + path);
  if (state.current?.path === path) closeCurrent();
  await refreshAll();
}

export function closeCurrent() {
  state.current = null;
  $("#workspace").hidden = true;
  $("#outline").replaceChildren();
  $("#backlinks").replaceChildren();
  $("#title").value = "";
  $("#empty").hidden = false;
  history.replaceState(null, "", "#");
}

import { Marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const $ = (sel) => document.querySelector(sel);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// サーバー（wrangler.jsonc の vars）から受け取る設定
let settings = {};

const state = {
  notes: [],          // [{path, updated_at}]
  attachments: [],    // [{path, content_type, size, created_at}]
  current: null,      // {path, content, updated_at|null}
  dirty: false,
  saveTimer: 0,
  saving: null,
  openFolders: new Set(store.get("openFolders", [])),
};

// ---------------- API ----------------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "x-mdv": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) location.reload();
    throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  }
  return data;
}

// ---------------- デバイス承認・パスキーのゲート ----------------

async function boot() {
  const dev = await api("GET", "/api/device");
  settings = dev.settings;
  if (dev.status === "approved" && dev.auth === "ok") return startApp();
  $("#gate").hidden = false;
  $("#gate-none").hidden = dev.status !== "none";
  $("#gate-pending").hidden = dev.status !== "pending";
  $("#gate-passkey-setup").hidden = dev.auth !== "setup";
  $("#gate-passkey-login").hidden = dev.auth !== "login";
  if (dev.auth && !SimpleWebAuthnBrowser.browserSupportsWebAuthn()) {
    $("#gate-error").textContent = "このブラウザはパスキーに対応していません";
  }
  if (dev.status === "pending") {
    $("#pair-code").textContent = dev.pair_code;
    $("#bootstrap-section").hidden = !dev.bootstrap_available;
    setTimeout(boot, settings.approval_poll_seconds * 1000); // 他デバイスでの承認を待つ
  }
}

$("#device-name").value = guessDeviceName();
$("#register-btn").onclick = () => gateAction(() => api("POST", "/api/device/register", { name: $("#device-name").value }));
$("#bootstrap-btn").onclick = () => gateAction(() => api("POST", "/api/device/bootstrap", { secret: $("#secret").value }));
$("#passkey-setup-name").value = guessDeviceName();
$("#passkey-setup-btn").onclick = () => gateAction(() => registerPasskey($("#passkey-setup-name").value));
$("#passkey-login-btn").onclick = () => gateAction(loginWithPasskey);

// パスキーの作成・署名はブラウザ（OS）の画面で行い、結果をサーバーで検証する
async function registerPasskey(name) {
  const optionsJSON = await api("POST", "/api/passkey/register/options");
  const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON }).catch(passkeyError);
  await api("POST", "/api/passkey/register/verify", { response, name });
}

async function loginWithPasskey() {
  const optionsJSON = await api("POST", "/api/passkey/login/options");
  const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON }).catch(passkeyError);
  await api("POST", "/api/passkey/login/verify", { response });
}

function passkeyError(e) {
  if (e.name === "NotAllowedError") throw new Error("キャンセルされたか、時間切れになりました");
  if (e.name === "InvalidStateError") throw new Error("この認証器には既にパスキーが登録されています");
  throw e;
}

async function gateAction(fn) {
  $("#gate-error").textContent = "";
  try {
    await fn();
    $("#gate").hidden = true;
    await boot();
  } catch (e) {
    $("#gate-error").textContent = e.message;
  }
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return `${os} ${br}`.trim();
}

// ---------------- ノート一覧・リンク解決 ----------------

const stripMd = (p) => p.replace(/\.md$/i, "");
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const linkKey = (s) => stripMd(s).toLowerCase();

let resolveMap = new Map();
function rebuildResolveMap() {
  resolveMap = new Map();
  // フルパス一致を basename 一致より優先する
  for (const n of state.notes) if (!resolveMap.has(linkKey(basename(n.path)))) resolveMap.set(linkKey(basename(n.path)), n.path);
  for (const n of state.notes) resolveMap.set(linkKey(n.path), n.path);
}
const resolveLink = (target) => resolveMap.get(linkKey(target.split("#")[0].trim())) ?? null;

// 添付画像も Obsidian と同じく、ファイル名だけで参照できる（フルパスでも可）
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
let attachmentMap = new Map();
let attachmentVersions = new Map();
async function refreshAttachments() {
  state.attachments = (await api("GET", "/api/attachments")).attachments;
  attachmentVersions = new Map(state.attachments.map((a) => [a.path, a.created_at]));
  attachmentMap = new Map();
  for (const a of state.attachments) if (!attachmentMap.has(basename(a.path).toLowerCase())) attachmentMap.set(basename(a.path).toLowerCase(), a.path);
  for (const a of state.attachments) attachmentMap.set(a.path.toLowerCase(), a.path);
}
const resolveAttachment = (target) => attachmentMap.get(target.replace(/^\.?\//, "").toLowerCase()) ?? null;
// 同じ名前で上げ直したときに古い画像がキャッシュから表示されないよう、アップロード日時を付ける
const attachmentUrl = (path) =>
  "/api/attachment?path=" + encodeURIComponent(path) + (attachmentVersions.has(path) ? "&v=" + attachmentVersions.get(path) : "");

async function refreshNotes() {
  state.notes = (await api("GET", "/api/notes")).notes;
  rebuildResolveMap();
  renderTree();
  $("#empty").hidden = state.notes.length > 0 || !!state.current;
}

function renderTree() {
  const root = { folders: new Map(), files: [] };
  for (const n of state.notes) {
    const parts = n.path.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      if (!node.folders.has(dir)) node.folders.set(dir, { folders: new Map(), files: [] });
      node = node.folders.get(dir);
    }
    node.files.push(n.path);
  }
  const build = (node, prefix) => {
    const ul = document.createElement("ul");
    for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const full = prefix + name;
      const li = document.createElement("li");
      const details = document.createElement("details");
      details.open = state.openFolders.has(full);
      details.ontoggle = () => {
        details.open ? state.openFolders.add(full) : state.openFolders.delete(full);
        store.set("openFolders", [...state.openFolders]);
      };
      const summary = document.createElement("summary");
      summary.textContent = name;
      details.append(summary, build(child, full + "/"));
      li.append(details);
      ul.append(li);
    }
    for (const path of node.files.sort((a, b) => a.localeCompare(b))) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = noteHref(path);
      a.textContent = stripMd(basename(path));
      a.className = "file" + (state.current?.path === path ? " active" : "");
      li.append(a);
      ul.append(li);
    }
    return ul;
  };
  $("#tree").replaceChildren(build(root, ""));
}

// ---------------- ルーティング ----------------

const noteHref = (path) => "#/" + path.split("/").map(encodeURIComponent).join("/");
const pathFromHash = () => {
  const h = location.hash.slice(2);
  return h ? h.split("/").map(decodeURIComponent).join("/") : null;
};
const navigate = (path) => { location.hash = noteHref(path); };

window.addEventListener("hashchange", () => {
  const path = pathFromHash();
  if (path && path !== state.current?.path) openNote(path);
});

async function openNote(path) {
  await flushSave();
  try {
    const note = await api("GET", "/api/note?path=" + encodeURIComponent(path));
    state.current = note;
  } catch (e) {
    if (e.status !== 404) throw e;
    state.current = { path, content: "", updated_at: null }; // 未作成のノート（最初の保存で作られる）
  }
  state.dirty = false;
  store.set("lastNote", path);
  // 開いたノートの親フォルダを展開する
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) state.openFolders.add(parts.slice(0, i).join("/"));
  $("#editor").value = state.current.content;
  $("#title").value = stripMd(path);
  $("#empty").hidden = true;
  $("#workspace").hidden = false;
  document.title = `${stripMd(basename(path))} - mdvault`;
  setStatus("");
  renderPreview();
  renderTree();
  loadBacklinks();
  if (innerWidth < 800) document.body.classList.remove("show-sidebar");
}

// ---------------- 保存 ----------------

function setStatus(s) { $("#status").textContent = s; }

function scheduleSave() {
  state.dirty = true;
  setStatus("未保存");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, settings.autosave_delay_ms);
}

async function flushSave() {
  clearTimeout(state.saveTimer);
  if (state.saving) await state.saving;
  if (state.dirty) await save();
}

async function save(force = false) {
  if (!state.current || !state.dirty) return;
  if (state.saving) return state.saving.then(() => save(force));
  const note = state.current;
  const content = $("#editor").value;
  const isNew = note.updated_at === null;
  state.dirty = false;
  setStatus("保存中…");
  state.saving = (async () => {
    try {
      const r = await api("PUT", "/api/note", {
        path: note.path, content, ...(force ? {} : { base_updated_at: note.updated_at }),
      });
      note.updated_at = r.updated_at;
      note.content = content;
      setStatus(state.dirty ? "未保存" : "保存済み");
      if (isNew) await refreshNotes();
    } catch (e) {
      state.dirty = true;
      if (e.status === 409) {
        state.saving = null;
        if (confirm("このノートは他のデバイスで更新されています。\nOK: サーバーの内容を読み込む（ここでの変更は破棄）\nキャンセル: この内容で上書き保存")) {
          state.dirty = false;
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

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});

// ---------------- プレビュー ----------------

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  extensions: [{
    name: "wikilink",
    level: "inline",
    start: (src) => src.indexOf("[["),
    tokenizer(src) {
      const m = /^!?\[\[([^\]\n]+?)\]\]/.exec(src);
      if (!m) return;
      const [target, alias] = m[1].split("|");
      return { type: "wikilink", raw: m[0], target: target.trim(), text: (alias ?? target).trim(), alias: alias?.trim(), embed: m[0][0] === "!" };
    },
    renderer(t) {
      const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      if (t.embed && IMAGE_EXT.test(t.target)) {
        const path = resolveAttachment(t.target);
        if (!path) return `<span class="missing-embed">画像が見つかりません: ${esc(t.target)}</span>`;
        // ![[画像.png|300]] や ![[画像.png|300x200]] でサイズ指定（Obsidian と同じ）
        const size = /^(\d+)(?:x(\d+))?$/.exec(t.alias ?? "");
        const attrs = size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ""}` : "";
        return `<img class="embed" src="${esc(attachmentUrl(path))}" alt="${esc(size || !t.alias ? basename(path) : t.alias)}" loading="lazy"${attrs}>`;
      }
      const resolved = resolveLink(t.target);
      return `<a class="wikilink${resolved ? "" : " unresolved"}" data-target="${esc(t.target)}" href="${resolved ? noteHref(resolved) : "#"}">${esc(t.text)}</a>`;
    },
  }],
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  // ![](attachments/画像.png) のような相対パスの画像は添付ファイルとして表示する
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") ?? "";
    if (src && !/^(https?:|data:|\/api\/attachment\?)/i.test(src)) {
      let target = src;
      try { target = decodeURIComponent(src); } catch {}
      node.setAttribute("src", attachmentUrl(resolveAttachment(target) ?? target.replace(/^\.?\//, "")));
    }
  }
  if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") ?? "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

let previewTimer = 0;
function renderPreview() {
  clearTimeout(previewTimer);
  const content = $("#editor").value;
  $("#preview").innerHTML = DOMPurify.sanitize(marked.parse(content));
  renderOutline(content);
}

function renderOutline(content) {
  const items = [];
  let inCode = false, offset = 0;
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    const m = !inCode && /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) items.push({ level: m[1].length, text: m[2], offset });
    offset += line.length + 1;
  }
  $("#outline").replaceChildren(...items.map((h, i) => {
    const li = document.createElement("li");
    li.style.paddingLeft = (h.level - 1) * 12 + "px";
    li.textContent = h.text;
    li.onclick = () => {
      $("#preview").querySelectorAll("h1,h2,h3,h4,h5,h6")[i]?.scrollIntoView({ behavior: "smooth" });
      if (!$("#workspace").classList.contains("mode-preview")) {
        const ed = $("#editor");
        ed.focus();
        ed.setSelectionRange(h.offset, h.offset);
      }
    };
    return li;
  }));
}

async function loadBacklinks() {
  const path = state.current?.path;
  if (!path) return;
  const { backlinks } = await api("GET", "/api/backlinks?path=" + encodeURIComponent(path));
  if (path !== state.current?.path) return;
  $("#backlinks").replaceChildren(...(backlinks.length ? backlinks.map(({ path: p }) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = noteHref(p);
    a.textContent = stripMd(p);
    li.append(a);
    return li;
  }) : [Object.assign(document.createElement("li"), { className: "muted", textContent: "なし" })]));
}

$("#preview").addEventListener("click", (e) => {
  const a = e.target.closest("a.wikilink");
  if (!a) return;
  e.preventDefault();
  const target = a.dataset.target.split("#")[0].trim();
  navigate(resolveLink(target) ?? (target.endsWith(".md") ? target : target + ".md"));
});

// ---------------- エディタ ----------------

const editor = $("#editor");
editor.addEventListener("input", () => {
  if (!state.current) return;
  scheduleSave();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
  updateSuggest();
});

// [[ 入力時のリンク補完
const suggest = { items: [], index: 0, start: -1 };
function updateSuggest() {
  const before = editor.value.slice(0, editor.selectionStart);
  const m = /(!?)\[\[([^\]\n|#]*)$/.exec(before);
  if (!m) return hideSuggest();
  const q = m[2].toLowerCase();
  suggest.start = editor.selectionStart - m[2].length;
  const pool = m[1] ? state.attachments.map((a) => a.path) : state.notes.map((n) => n.path);
  suggest.items = pool.filter((p) => fuzzy(displayName(p).toLowerCase(), q)).slice(0, 8);
  suggest.index = 0;
  if (!suggest.items.length) return hideSuggest();
  renderSuggest();
}
function renderSuggest() {
  $("#suggest").hidden = false;
  $("#suggest").replaceChildren(...suggest.items.map((p, i) => {
    const li = document.createElement("li");
    li.textContent = displayName(p);
    li.className = i === suggest.index ? "active" : "";
    li.onmousedown = (e) => { e.preventDefault(); applySuggest(p); };
    return li;
  }));
}
function hideSuggest() { $("#suggest").hidden = true; suggest.items = []; }
// ノートは拡張子なし、画像は拡張子つきで表示・挿入する
const displayName = (p) => (IMAGE_EXT.test(p) ? p : stripMd(p));
function linkText(path) {
  const pool = IMAGE_EXT.test(path) ? state.attachments.map((a) => a.path) : state.notes.map((n) => n.path);
  const name = displayName(basename(path));
  // basename が重複する場合はフルパスで書く
  return pool.filter((p) => displayName(basename(p)) === name).length > 1 ? displayName(path) : name;
}
function applySuggest(path) {
  const text = linkText(path);
  const after = editor.value.slice(editor.selectionStart);
  const close = after.startsWith("]]") ? "" : "]]";
  editor.setRangeText(text + close, suggest.start, editor.selectionStart, "end");
  if (!close) editor.selectionStart = editor.selectionEnd = editor.selectionStart + 2;
  hideSuggest();
  editor.dispatchEvent(new Event("input"));
}
editor.addEventListener("keydown", (e) => {
  if (!$("#suggest").hidden && suggest.items.length) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      suggest.index = (suggest.index + (e.key === "ArrowDown" ? 1 : -1) + suggest.items.length) % suggest.items.length;
      return renderSuggest();
    }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return applySuggest(suggest.items[suggest.index]); }
    if (e.key === "Escape") return hideSuggest();
  }
  if (e.key === "Tab") { // Tab でインデント
    e.preventDefault();
    editor.setRangeText("\t", editor.selectionStart, editor.selectionEnd, "end");
    editor.dispatchEvent(new Event("input"));
  }
});
editor.addEventListener("blur", hideSuggest);

function fuzzy(text, q) {
  let i = 0;
  for (const c of text) if (c === q[i]) i++;
  return i === q.length;
}

// ---------------- ノート操作 ----------------

function toPath(name) {
  const p = name.trim().replace(/^\/+/, "");
  return p.toLowerCase().endsWith(".md") ? p : p + ".md";
}

async function newNote(name) {
  name ??= prompt("ノート名（フォルダは / で区切る）", dirname(state.current?.path ?? "") ? dirname(state.current.path) + "/" : "");
  if (!name?.trim()) return;
  const path = toPath(name);
  if (!state.notes.some((n) => n.path === path)) {
    await api("PUT", "/api/note", { path, content: "", base_updated_at: null });
    await refreshNotes();
  }
  navigate(path);
}

$("#new-note").onclick = () => newNote().catch((e) => alert(e.message));

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
    await flushSave();
    if (cur.updated_at !== null) await api("POST", "/api/note/rename", { from: cur.path, to });
    cur.path = to;
    history.replaceState(null, "", noteHref(to));
    store.set("lastNote", to);
    await refreshNotes();
    loadBacklinks();
  } catch (e) {
    alert(e.message);
    $("#title").value = stripMd(cur.path);
  }
});

$("#delete-note").onclick = async () => {
  const cur = state.current;
  if (!cur || !confirm(`「${stripMd(cur.path)}」を削除しますか？（ゴミ箱から復元できます）`)) return;
  clearTimeout(state.saveTimer);
  state.dirty = false;
  await api("DELETE", "/api/note?path=" + encodeURIComponent(cur.path));
  state.current = null;
  $("#workspace").hidden = true;
  $("#outline").replaceChildren();
  $("#backlinks").replaceChildren();
  $("#title").value = "";
  await refreshNotes();
  $("#empty").hidden = false;
  history.replaceState(null, "", "#");
};

// ---------------- 検索 ----------------

let searchTimer = 0;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $("#search-results").hidden = true; $("#tree").hidden = false; return; }
  searchTimer = setTimeout(async () => {
    const { results } = await api("GET", "/api/search?q=" + encodeURIComponent(q));
    $("#tree").hidden = true;
    $("#search-results").hidden = false;
    $("#search-results").replaceChildren(...(results.length ? results.map((r) => {
      const a = document.createElement("a");
      a.href = noteHref(r.path);
      const title = Object.assign(document.createElement("strong"), { textContent: stripMd(r.path) });
      const snip = Object.assign(document.createElement("small"), { textContent: r.snippet });
      a.append(title, snip);
      return a;
    }) : [Object.assign(document.createElement("p"), { className: "muted", textContent: "見つかりません" })]));
  }, 250);
});

// ---------------- クイックスイッチャー ----------------

const switcher = $("#switcher");
let switcherItems = [], switcherIndex = 0;
function openSwitcher() {
  $("#switcher-input").value = "";
  renderSwitcher();
  switcher.showModal();
}
function renderSwitcher() {
  const q = $("#switcher-input").value.trim().toLowerCase();
  switcherItems = state.notes.map((n) => n.path).filter((p) => fuzzy(stripMd(p).toLowerCase(), q)).slice(0, 30);
  switcherIndex = 0;
  drawSwitcher();
}
function drawSwitcher() {
  $("#switcher-list").replaceChildren(...switcherItems.map((p, i) => {
    const li = document.createElement("li");
    li.textContent = stripMd(p);
    li.className = i === switcherIndex ? "active" : "";
    li.onclick = () => { switcher.close(); navigate(p); };
    return li;
  }));
  const q = $("#switcher-input").value.trim();
  if (q && !state.notes.some((n) => n.path === toPath(q))) {
    const li = document.createElement("li");
    li.className = "create" + (switcherItems.length ? "" : " active");
    li.textContent = `＋ 「${q}」を作成`;
    li.onclick = () => { switcher.close(); newNote(q); };
    $("#switcher-list").append(li);
  }
}
$("#switcher-input").addEventListener("input", renderSwitcher);
$("#switcher-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = switcherItems.length || 1;
    switcherIndex = (switcherIndex + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    drawSwitcher();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const q = $("#switcher-input").value.trim();
    switcher.close();
    if (switcherItems.length && !(e.shiftKey && q)) navigate(switcherItems[switcherIndex]);
    else if (q) newNote(q);
  }
});
switcher.addEventListener("click", (e) => { if (e.target === switcher) switcher.close(); });
$("#open-switcher").onclick = openSwitcher;

// ---------------- デバイス管理 ----------------

async function openDevices() {
  const { devices, current } = await api("GET", "/api/devices");
  $("#device-list").replaceChildren(...devices.map((d) => {
    const tr = document.createElement("tr");
    const name = Object.assign(document.createElement("td"), { textContent: d.name + (d.id === current ? "（このデバイス）" : "") });
    name.title = d.user_agent ?? "";
    const status = Object.assign(document.createElement("td"), { textContent: d.status === "approved" ? "承認済み" : "承認待ち" });
    const seen = Object.assign(document.createElement("td"), { textContent: fmtTime(d.last_seen_at) });
    const actions = document.createElement("td");
    if (d.status === "pending") {
      const input = Object.assign(document.createElement("input"), { placeholder: "6桁コード", inputMode: "numeric", maxLength: 6, className: "code" });
      const ok = Object.assign(document.createElement("button"), { textContent: "承認", className: "primary" });
      ok.onclick = () => api("POST", "/api/devices/approve", { id: d.id, pair_code: input.value.trim() }).then(openDevices, (e) => alert(e.message));
      actions.append(input, ok);
    }
    const del = Object.assign(document.createElement("button"), { textContent: d.status === "pending" ? "拒否" : "削除", className: "danger" });
    del.onclick = async () => {
      const msg = d.id === current ? "このデバイスを削除すると、再承認するまでアクセスできなくなります。よろしいですか？" : `「${d.name}」を削除しますか？`;
      if (!confirm(msg)) return;
      await api("DELETE", "/api/devices?id=" + encodeURIComponent(d.id));
      d.id === current ? location.reload() : openDevices();
    };
    actions.append(del);
    tr.append(name, status, seen, actions);
    return tr;
  }));
  await renderPasskeys();
  if (!$("#devices").open) $("#devices").showModal();
}
$("#open-devices").onclick = () => openDevices().catch((e) => alert(e.message));

async function renderPasskeys() {
  const { passkeys, current } = await api("GET", "/api/passkeys");
  $("#passkey-list").replaceChildren(...passkeys.map((p) => {
    const tr = document.createElement("tr");
    const del = Object.assign(document.createElement("button"), { textContent: "削除", className: "danger", disabled: passkeys.length <= 1 });
    if (passkeys.length <= 1) del.title = "最後のパスキーは削除できません";
    del.onclick = async () => {
      const msg = p.id === current ? "ログイン中のパスキーです。削除するとログアウトします。よろしいですか？" : `「${p.name}」を削除しますか？`;
      if (!confirm(msg)) return;
      await api("DELETE", "/api/passkeys?id=" + encodeURIComponent(p.id)).catch((e) => alert(e.message));
      p.id === current ? location.reload() : renderPasskeys();
    };
    const actions = document.createElement("td");
    actions.append(del);
    tr.append(
      Object.assign(document.createElement("td"), { textContent: p.name + (p.id === current ? "（ログイン中）" : "") }),
      Object.assign(document.createElement("td"), { textContent: fmtTime(p.created_at) }),
      Object.assign(document.createElement("td"), { textContent: p.last_used_at ? fmtTime(p.last_used_at) : "-" }),
      actions,
    );
    return tr;
  }));
}

$("#add-passkey").onclick = async () => {
  const name = prompt("パスキーの名前", guessDeviceName());
  if (name === null) return;
  try {
    await flushSave();
    await registerPasskey(name);
    await renderPasskeys();
  } catch (e) {
    alert(e.message);
  }
};

$("#logout").onclick = async () => {
  await flushSave();
  await api("POST", "/api/logout");
  location.reload();
};

// ---------------- 履歴・ゴミ箱 ----------------

const fmtTime = (t) => new Date(t).toLocaleString();
const REASONS = { edit: "編集前", overwrite: "他デバイスで上書きされた版", delete: "削除時", restore: "復元前" };

async function openHistory() {
  const cur = state.current;
  if (!cur) return;
  await flushSave();
  const { revisions } = await api("GET", "/api/revisions?path=" + encodeURIComponent(cur.path));
  $("#revision-preview").replaceChildren(Object.assign(document.createElement("p"), {
    className: "muted", textContent: revisions.length ? "左の一覧から版を選んでください" : `まだ履歴がありません（編集すると${settings.revision_interval_minutes}分ごとに記録されます）`,
  }));
  $("#restore-revision").hidden = true;
  $("#revision-list").replaceChildren(...revisions.map((r) => {
    const li = document.createElement("li");
    li.append(fmtTime(r.saved_at), Object.assign(document.createElement("small"), { textContent: `${REASONS[r.reason] ?? r.reason} · ${r.size}文字` }));
    li.onclick = async () => {
      $("#revision-list").querySelectorAll("li").forEach((x) => x.classList.toggle("active", x === li));
      const rev = await api("GET", "/api/revision?id=" + r.id);
      $("#revision-preview").innerHTML = DOMPurify.sanitize(marked.parse(rev.content));
      $("#restore-revision").hidden = false;
      $("#restore-revision").onclick = async () => {
        if (!confirm("この版に戻しますか？（現在の内容も履歴に残ります）")) return;
        await restore(r.id);
        $("#history").close();
      };
    };
    return li;
  }));
  $("#history").showModal();
}

async function restore(id) {
  await flushSave();
  const { path } = await api("POST", "/api/note/restore", { id });
  await refreshNotes();
  state.current = null;
  history.replaceState(null, "", noteHref(path));
  await openNote(path);
}

async function openTrash() {
  const { trash } = await api("GET", "/api/trash");
  $("#trash-list").replaceChildren(...(trash.length ? trash.map((t) => {
    const tr = document.createElement("tr");
    const ok = Object.assign(document.createElement("button"), { textContent: "復元", className: "primary" });
    ok.onclick = () => restore(t.id).then(() => $("#trash").close(), (e) => alert(e.message));
    const actions = document.createElement("td");
    actions.append(ok);
    tr.append(
      Object.assign(document.createElement("td"), { textContent: stripMd(t.path) }),
      Object.assign(document.createElement("td"), { textContent: fmtTime(t.deleted_at) }),
      actions,
    );
    return tr;
  }) : [Object.assign(document.createElement("tr"), { innerHTML: '<td colspan="3" class="muted">空です</td>' })]));
  if (!$("#trash").open) $("#trash").showModal();
}

$("#open-history").onclick = () => openHistory().catch((e) => alert(e.message));

// ---------------- 画像の添付 ----------------

const EXT_BY_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };

// アップロードして、カーソル位置に ![[ファイル名]] を挿入する
async function uploadImages(files) {
  if (!state.current) return alert("先にノートを開いてください");
  const links = [];
  for (const file of files) {
    if (!EXT_BY_TYPE[file.type]) { alert(`「${file.name}」は対応していない形式です（PNG / JPEG / GIF / WebP / AVIF のみ）`); continue; }
    if (file.size > settings.max_attachment_mb * 1024 * 1024) { alert(`「${file.name}」は大きすぎます（上限 ${settings.max_attachment_mb}MB）`); continue; }
    setStatus(`アップロード中… ${file.name}`);
    try {
      // クリップボードからの貼り付けは "image.png" という名前になるので、Obsidian と同じ形式の名前を付ける
      const name = !file.name || /^image\.\w+$/i.test(file.name) ? `Pasted image ${timestamp()}.${EXT_BY_TYPE[file.type]}` : file.name;
      const res = await fetch("/api/attachments?name=" + encodeURIComponent(name), {
        method: "POST", headers: { "x-mdv": "1", "content-type": file.type }, body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      links.push(data.path);
    } catch (e) {
      alert(`「${file.name}」をアップロードできません: ${e.message}`);
    }
  }
  setStatus("");
  if (!links.length) return;
  await refreshAttachments();
  insertImageLinks(links);
}

function insertImageLinks(paths) {
  editor.focus();
  editor.setRangeText(paths.map((p) => `![[${linkText(p)}]]`).join("\n"), editor.selectionStart, editor.selectionEnd, "end");
  editor.dispatchEvent(new Event("input"));
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const imageFiles = (list) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
editor.addEventListener("paste", (e) => {
  const files = imageFiles(e.clipboardData?.files);
  if (!files.length) return;
  e.preventDefault();
  uploadImages(files);
});
editor.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
editor.addEventListener("drop", (e) => {
  const files = imageFiles(e.dataTransfer?.files);
  if (!files.length) return;
  e.preventDefault();
  uploadImages(files);
});
$("#attach-image").onclick = () => (state.current ? $("#file-input").click() : alert("先にノートを開いてください"));
$("#file-input").onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) uploadImages(files);
};

// 添付ファイルの一覧（どのノートからも参照されていない画像を探して削除できる）
async function openAttachments() {
  const { attachments } = await api("GET", "/api/attachments?refs=1");
  const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`);
  $("#attachment-list").replaceChildren(...(attachments.length ? attachments.map((a) => {
    const card = document.createElement("div");
    card.className = "attachment-card";
    const img = Object.assign(document.createElement("img"), { src: attachmentUrl(a.path), alt: basename(a.path), loading: "lazy" });
    const name = Object.assign(document.createElement("div"), { className: "attachment-name", textContent: basename(a.path), title: a.path });
    const meta = Object.assign(document.createElement("div"), {
      className: "attachment-meta" + (a.refs ? "" : " unused"),
      textContent: `${fmtSize(a.size)} · ${a.refs ? `${a.refs} 件のノートで使用` : "未使用"}`,
    });
    const actions = document.createElement("div");
    actions.className = "attachment-actions";
    if (state.current) {
      const insert = Object.assign(document.createElement("button"), { textContent: "挿入" });
      insert.onclick = () => { $("#attachments").close(); insertImageLinks([a.path]); };
      actions.append(insert);
    }
    const del = Object.assign(document.createElement("button"), { textContent: "削除", className: "danger" });
    del.onclick = async () => {
      const msg = a.refs ? `「${basename(a.path)}」は ${a.refs} 件のノートで使われています。削除すると表示されなくなります。削除しますか？` : `「${basename(a.path)}」を削除しますか？`;
      if (!confirm(msg)) return;
      try {
        await api("DELETE", "/api/attachments?path=" + encodeURIComponent(a.path));
        await refreshAttachments();
        renderPreview();
        await openAttachments();
      } catch (e) {
        alert(e.message);
      }
    };
    actions.append(del);
    card.append(img, name, meta, actions);
    return card;
  }) : [Object.assign(document.createElement("p"), { className: "muted", textContent: "画像はまだありません。ノートに貼り付けるか、ドラッグ&ドロップで追加できます。" })]));
  if (!$("#attachments").open) $("#attachments").showModal();
}
$("#open-attachments").onclick = () => openAttachments().catch((e) => alert(e.message));
$("#open-trash").onclick = () => openTrash().catch((e) => alert(e.message));

// ---------------- レイアウト ----------------

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
// モバイル: ドロワーの外をタップしたら閉じる
$(".main").addEventListener("click", (e) => {
  if (innerWidth < 800 && !e.target.closest(".toolbar")) document.body.classList.remove("show-sidebar", "show-right");
});
$("#toggle-right").onclick = () => document.body.classList.toggle(innerWidth < 800 ? "show-right" : "hide-right");

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === "p" || e.key === "o")) { e.preventDefault(); openSwitcher(); }
  else if (mod && e.key === "s") { e.preventDefault(); flushSave(); }
  else if (mod && e.key === "e") {
    e.preventDefault();
    setMode($("#workspace").classList.contains("mode-preview") ? "edit" : "preview");
  } else if (e.altKey && e.code === "KeyN") { e.preventDefault(); newNote(); }
});

async function startApp() {
  $("#app").hidden = false;
  setMode(store.get("mode", innerWidth < 800 ? "edit" : "split"));
  await Promise.all([refreshNotes(), refreshAttachments()]);
  const path = pathFromHash() ?? store.get("lastNote", null);
  if (path && (state.notes.some((n) => n.path === path) || pathFromHash())) {
    history.replaceState(null, "", noteHref(path));
    await openNote(path);
  } else if (state.notes.length) navigate(state.notes[0].path);
  else $("#workspace").hidden = true;
}

boot().catch((e) => {
  $("#gate").hidden = false;
  $("#gate-error").textContent = "接続できません: " + e.message;
});

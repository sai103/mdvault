// サイドバーのファイルツリー。フォルダの作成・名前変更・削除、ドラッグ&ドロップでの移動
import { api } from "./api.js";
import { contextMenu } from "./dialogs.js";
import { closeCurrent, deleteNote, moveNote, newNote, refreshAll, setStatus } from "./notes.js";
import { state } from "./state.js";
import { $, basename, el, noteHref, store, stripMd } from "./util.js";

const DRAG_TYPE = "application/x-mdvault";

function buildTree() {
  const root = { folders: new Map(), files: [] };
  const folderNode = (path) => {
    let node = root;
    for (const dir of path.split("/")) {
      if (!node.folders.has(dir)) node.folders.set(dir, { folders: new Map(), files: [] });
      node = node.folders.get(dir);
    }
    return node;
  };
  for (const f of state.folders) folderNode(f);
  for (const n of state.notes) {
    const dir = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
    (dir ? folderNode(dir) : root).files.push(n);
  }
  return root;
}

export function renderTree() {
  const build = (node, prefix) => {
    const ul = el("ul");
    for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const full = prefix + name;
      const summary = el("summary", { draggable: true },
        el("span", { className: "folder-name", textContent: name }),
        el("button", { className: "icon more", title: "フォルダのメニュー", textContent: "⋯", onclick: (e) => { e.preventDefault(); folderMenu(e, full); } }));
      summary.addEventListener("contextmenu", (e) => { e.preventDefault(); folderMenu(e, full); });
      dragSource(summary, { type: "folder", path: full });
      dropTarget(summary, full);
      const details = el("details", {
        open: state.openFolders.has(full),
        ontoggle: () => {
          details.open ? state.openFolders.add(full) : state.openFolders.delete(full);
          store.set("openFolders", [...state.openFolders]);
        },
      }, summary, build(child, full + "/"));
      ul.append(el("li", {}, details));
    }
    for (const n of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
      const a = el("a", {
        href: noteHref(n.path), draggable: true,
        className: "file" + (state.current?.path === n.path ? " active" : ""),
        textContent: (n.encrypted ? "🔒 " : "") + stripMd(basename(n.path)),
        title: n.path,
      });
      a.addEventListener("contextmenu", (e) => { e.preventDefault(); noteMenu(e, n.path); });
      dragSource(a, { type: "note", path: n.path });
      ul.append(el("li", {}, a));
    }
    return ul;
  };
  $("#tree").replaceChildren(build(buildTree(), ""));
}

// ---------------- ドラッグ&ドロップ ----------------

function dragSource(node, item) {
  node.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
    e.dataTransfer.effectAllowed = "move";
  });
}

// folder が "" ならいちばん上（ルート）
function dropTarget(node, folder) {
  node.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    node.classList.add("drop-target");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-target"));
  node.addEventListener("drop", (e) => {
    node.classList.remove("drop-target");
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const item = JSON.parse(raw);
    const to = (folder ? folder + "/" : "") + basename(item.path);
    run(item.type === "note" ? moveNote(item.path, to) : moveFolder(item.path, to));
  });
}

export function setupTree() {
  dropTarget($("#tree"), "");
  $("#new-folder").onclick = () => createFolder("");
}

const run = (p) => p.catch((e) => alert(e.message));

// ---------------- メニュー ----------------

function noteMenu(e, path) {
  contextMenu(e.clientX, e.clientY, [
    { label: "名前の変更・移動", action: () => { const to = prompt("新しい名前（フォルダは / で区切る）", stripMd(path)); if (to?.trim()) run(moveNote(path, to.trim().replace(/\.md$/i, "") + ".md")); } },
    { label: "削除", danger: true, action: () => run(deleteNote(path)) },
  ]);
}

function folderMenu(e, path) {
  const r = e.currentTarget?.getBoundingClientRect?.();
  contextMenu(r ? r.left : e.clientX, r ? r.bottom : e.clientY, [
    { label: "この中に新しいノート", action: () => { const name = prompt("ノート名", ""); if (name?.trim()) run(newNote(`${path}/${name.trim()}`)); } },
    { label: "この中に新しいフォルダ", action: () => createFolder(path) },
    { label: "名前の変更・移動", action: () => { const to = prompt("新しいフォルダ名（/ で区切ると移動）", path); if (to?.trim()) run(moveFolder(path, to.trim())); } },
    { label: "削除（中のノートはゴミ箱へ）", danger: true, action: () => run(deleteFolder(path)) },
  ]);
}

async function createFolder(parent) {
  const name = prompt(parent ? `「${parent}」の中に作るフォルダ名` : "フォルダ名（/ で区切ると階層を作れます）", "");
  if (!name?.trim()) return;
  const path = (parent ? parent + "/" : "") + name.trim().replace(/^\/+|\/+$/g, "");
  await run(api("POST", "/api/folders", { path }).then(() => {
    for (let i = 1; i <= path.split("/").length; i++) state.openFolders.add(path.split("/").slice(0, i).join("/"));
    return refreshAll();
  }));
}

async function moveFolder(from, to) {
  if (from === to) return;
  const { moved, updated } = await api("POST", "/api/folder/rename", { from, to });
  if (state.current?.path.startsWith(from + "/")) {
    const path = to + state.current.path.slice(from.length);
    state.current.path = path;
    history.replaceState(null, "", noteHref(path));
    $("#title").value = stripMd(path);
  }
  if (state.openFolders.has(from)) state.openFolders.add(to);
  await refreshAll();
  setStatus(`${moved} 件のノートを移動し、${updated.length} 件のノートのリンクを書き換えました`);
}

async function deleteFolder(path) {
  const count = state.notes.filter((n) => n.path.startsWith(path + "/")).length;
  if (!confirm(`フォルダ「${path}」を削除しますか？${count ? `\n中のノート ${count} 件はゴミ箱に移ります（1 件ずつ復元できます）。` : ""}`)) return;
  const inside = state.current?.path.startsWith(path + "/");
  await api("DELETE", "/api/folder?path=" + encodeURIComponent(path));
  if (inside) closeCurrent();
  await refreshAll();
}

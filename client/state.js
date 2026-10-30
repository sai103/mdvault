// 画面全体で共有する状態と、リンク・画像の解決
import { api } from "./api.js";
import { basename, linkKey, store } from "./util.js";

export const state = {
  notes: [],          // [{path, updated_at, encrypted}]
  folders: [],        // 明示的に作ったフォルダ（空でも表示する）
  attachments: [],    // [{path, content_type, size, created_at}]
  tags: [],           // [{tag, count}]
  current: null,      // 開いているノート {path, content, updated_at|null, crypto?}
  dirty: false,
  saveTimer: 0,
  saving: null,
  openFolders: new Set(store.get("openFolders", [])),
};

// ---- ノートへのリンク: フルパス一致を優先し、なければファイル名が一致する最初のノート（サーバーと同じ規則） ----
let resolveMap = new Map();
export function rebuildResolveMap() {
  resolveMap = new Map();
  const sorted = state.notes.map((n) => n.path).sort();
  for (const p of sorted) if (!resolveMap.has(linkKey(basename(p)))) resolveMap.set(linkKey(basename(p)), p);
  for (const p of sorted) resolveMap.set(linkKey(p), p);
}
export const resolveLink = (target) => resolveMap.get(linkKey(target.split("#")[0].trim())) ?? null;
export const noteByPath = (path) => state.notes.find((n) => n.path === path);

export async function refreshNoteList() {
  const data = await api("GET", "/api/notes");
  state.notes = data.notes;
  state.folders = data.folders;
  rebuildResolveMap();
}

// ---- 画像も Obsidian と同じく、ファイル名だけで参照できる（フルパスでも可） ----
let attachmentMap = new Map();
let attachmentVersions = new Map();
export async function refreshAttachments() {
  state.attachments = (await api("GET", "/api/attachments")).attachments;
  attachmentVersions = new Map(state.attachments.map((a) => [a.path, a.created_at]));
  attachmentMap = new Map();
  for (const a of state.attachments) if (!attachmentMap.has(basename(a.path).toLowerCase())) attachmentMap.set(basename(a.path).toLowerCase(), a.path);
  for (const a of state.attachments) attachmentMap.set(a.path.toLowerCase(), a.path);
}
// ./ や ../ で始まる相対パス（Obsidian の Markdown 記法のリンク）は、フルパス → ファイル名の順に探す
export function resolveAttachment(target) {
  const clean = target.replace(/^(\.\.?\/)+/, "").toLowerCase();
  return attachmentMap.get(clean) ?? attachmentMap.get(basename(clean)) ?? null;
}
// 同じ名前で上げ直したときに古い画像がキャッシュから表示されないよう、アップロード日時を付ける
export const attachmentUrl = (path) =>
  "/api/attachment?path=" + encodeURIComponent(path) + (attachmentVersions.has(path) ? "&v=" + attachmentVersions.get(path) : "");

export async function refreshTags() {
  state.tags = (await api("GET", "/api/tags")).tags;
}

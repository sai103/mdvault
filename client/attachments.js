// 画像の添付（貼り付け・ドラッグ&ドロップ・ファイル選択）と、画像の一覧
import { api, settings, upload } from "./api.js";
import { getEditor, renderPreview, setStatus } from "./notes.js";
import { attachmentUrl, refreshAttachments, state } from "./state.js";
import { $, basename, displayName, el, fmtSize, timestamp } from "./util.js";

const EXT_BY_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };

// 大きい写真はアップロード前に縮小する。JPEG / WebP は描き直すことで、位置情報などの EXIF も取り除く。
// GIF（アニメーション）と AVIF はそのまま送る
export async function prepareImage(file) {
  if (!/^image\/(jpeg|webp|png)$/.test(file.type)) return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return file; }
  const max = settings.image_max_dimension;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  if (file.type === "image/png" && scale === 1) { bitmap.close(); return file; }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((r) => canvas.toBlob(r, file.type, settings.image_quality_percent / 100));
  if (!blob) return file;
  return new File([blob], file.name, { type: blob.type });
}

// アップロードして、カーソル位置に ![[ファイル名]] を挿入する
export async function uploadImages(files) {
  if (!state.current || state.current.locked) return alert("先にノートを開いてください");
  const paths = [];
  for (const original of files) {
    if (!EXT_BY_TYPE[original.type]) { alert(`「${original.name}」は対応していない形式です（PNG / JPEG / GIF / WebP / AVIF のみ）`); continue; }
    setStatus(`準備中… ${original.name}`);
    const file = await prepareImage(original);
    if (file.size > settings.max_attachment_mb * 1024 * 1024) { alert(`「${original.name}」は大きすぎます（上限 ${settings.max_attachment_mb}MB）`); continue; }
    setStatus(`アップロード中… ${original.name}`);
    try {
      // クリップボードからの貼り付けは "image.png" という名前になるので、Obsidian と同じ形式の名前を付ける
      const name = !original.name || /^image\.\w+$/i.test(original.name) ? `Pasted image ${timestamp()}.${EXT_BY_TYPE[file.type]}` : original.name;
      paths.push((await upload("/api/attachments?name=" + encodeURIComponent(name), file, file.type)).path);
    } catch (e) {
      alert(`「${original.name}」をアップロードできません: ${e.message}`);
    }
  }
  setStatus("");
  if (!paths.length) return;
  await refreshAttachments();
  insertImageLinks(paths);
}

// ファイル名が重複するときはフルパスで書く
export function imageLinkText(path) {
  const name = basename(path);
  return state.attachments.filter((a) => basename(a.path) === name).length > 1 ? path : name;
}

function insertImageLinks(paths) {
  getEditor().insert(paths.map((p) => `![[${imageLinkText(p)}]]`).join("\n"));
}

// 一覧（どのノートからも参照されていない画像を探して削除できる）
export async function openAttachments() {
  const { attachments } = await api("GET", "/api/attachments?refs=1");
  $("#attachment-list").replaceChildren(...(attachments.length ? attachments.map((a) => el("div", { className: "attachment-card" },
    el("img", { src: attachmentUrl(a.path), alt: basename(a.path), loading: "lazy" }),
    el("div", { className: "attachment-name", textContent: displayName(basename(a.path)), title: a.path }),
    el("div", { className: "attachment-meta" + (a.refs ? "" : " unused"), textContent: `${fmtSize(a.size)} · ${a.refs ? `${a.refs} 件のノートで使用` : "未使用"}` }),
    el("div", { className: "attachment-actions" },
      state.current && !state.current.locked ? el("button", { textContent: "挿入", onclick: () => { $("#attachments").close(); insertImageLinks([a.path]); } }) : null,
      el("button", {
        textContent: "削除", className: "danger",
        onclick: async () => {
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
        },
      }))))
    : [el("p", { className: "muted", textContent: "画像はまだありません。ノートに貼り付けるか、ドラッグ&ドロップで追加できます。" })]));
  if (!$("#attachments").open) $("#attachments").showModal();
}

export function setupAttachments() {
  $("#attach-image").onclick = () => (state.current && !state.current.locked ? $("#file-input").click() : alert("先にノートを開いてください"));
  $("#file-input").onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) uploadImages(files);
  };
  $("#open-attachments").onclick = () => openAttachments().catch((e) => alert(e.message));
}

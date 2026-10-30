// Obsidian の Vault（.md と画像の zip）の取り込み・書き出し
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { api, settings, upload } from "./api.js";
import { flushSave, refreshAll } from "./notes.js";
import { attachmentUrl, refreshAttachments } from "./state.js";
import { $, IMAGE_EXT, el, today } from "./util.js";

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };

function progress(text) {
  $("#vault-progress").hidden = false;
  $("#vault-progress").textContent = text;
}

// ---------------- 書き出し ----------------

async function exportVault() {
  await flushSave();
  $("#vault-export").disabled = true;
  try {
    progress("ノートを読み込んでいます…");
    const data = await api("GET", "/api/export");
    const files = {};
    for (const f of data.folders) files[f + "/"] = new Uint8Array(0);
    for (const n of data.notes) files[n.path] = [strToU8(n.content), { mtime: new Date(n.updated_at) }];
    let i = 0;
    for (const a of data.attachments) {
      progress(`画像を読み込んでいます… ${++i} / ${data.attachments.length}`);
      const res = await fetch(attachmentUrl(a.path));
      // 画像はすでに圧縮されているので、zip では圧縮しない
      if (res.ok) files[a.path] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
    }
    progress("zip を作っています…");
    const zip = zipSync(files, { level: 6 });
    const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    el("a", { href: url, download: `mdvault-${today()}.zip` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    progress(`書き出しました（ノート ${data.notes.length} 件・画像 ${data.attachments.length} 件）。ファイルには全ノートが入っているので、保管場所に注意してください`);
  } catch (e) {
    progress("書き出せませんでした: " + e.message);
  } finally {
    $("#vault-export").disabled = false;
  }
}

// ---------------- 取り込み ----------------

let pending = null; // 展開したが、まだ取り込んでいない内容

async function readZip(file) {
  progress("zip を展開しています…");
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  let names = Object.keys(entries).map((n) => n.normalize("NFC"));
  const raw = new Map(Object.keys(entries).map((n) => [n.normalize("NFC"), entries[n]]));
  // Vault のフォルダごと zip にした場合（全部が 1 つのフォルダの下にある）は、そのフォルダを取り除く
  const roots = new Set(names.filter((n) => n.replace(/\/$/, "")).map((n) => n.split("/")[0]));
  const strip = roots.size === 1 && names.every((n) => n.includes("/")) ? [...roots][0] + "/" : "";
  const notes = [], images = [], folders = new Set(), skipped = [];
  for (const name of names) {
    const path = name.slice(strip.length);
    if (!path) continue;
    // Obsidian の設定・ゴミ箱・macOS の付属ファイル・隠しファイルは取り込まない
    if (path.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX")) continue;
    const data = raw.get(name);
    if (path.endsWith("/")) { folders.add(path.replace(/\/+$/, "")); continue; }
    if (/\.md$/i.test(path)) notes.push({ path, content: strFromU8(data) });
    else if (IMAGE_EXT.test(path)) images.push({ path, data });
    else skipped.push(path);
  }
  pending = { notes, images, folders: [...folders], skipped, strip };
  const summary = [
    `ノート ${notes.length} 件・画像 ${images.length} 件・フォルダ ${folders.size} 件を取り込めます。`,
    strip ? `（いちばん上のフォルダ「${strip.slice(0, -1)}」は取り除きます）` : "",
    skipped.length ? `\n取り込めないファイル ${skipped.length} 件（PDF など）はスキップします: ${skipped.slice(0, 5).join("、")}${skipped.length > 5 ? " …" : ""}` : "",
  ].join("");
  progress(summary);
  $("#vault-import-start").hidden = !(notes.length || images.length || folders.size);
  $("#vault-overwrite-row").hidden = $("#vault-import-start").hidden;
}

async function importPending() {
  if (!pending) return;
  const { notes, images, folders, skipped } = pending;
  const overwrite = $("#vault-overwrite").checked;
  $("#vault-import-start").disabled = true;
  const result = { created: 0, overwritten: 0, skipped: 0, images: 0, imageSkipped: 0, errors: [] };
  try {
    for (const f of folders) await api("POST", "/api/folders", { path: f }).catch((e) => result.errors.push(`${f}: ${e.message}`));
    // ノートはまとめて送る（件数と大きさで区切る）
    const max = settings.max_notes_per_bulk_operation;
    for (let i = 0; i < notes.length;) {
      const batch = [];
      let size = 0;
      while (i < notes.length && batch.length < Math.min(max, 100) && (size === 0 || size + notes[i].content.length < 5_000_000)) {
        size += notes[i].content.length;
        batch.push(notes[i++]);
      }
      progress(`ノートを取り込んでいます… ${i} / ${notes.length}`);
      const r = await api("POST", "/api/import/notes", { notes: batch, overwrite });
      result.created += r.created.length;
      result.overwritten += r.overwritten.length;
      result.skipped += r.skipped.length;
      result.errors.push(...r.errors.map((e) => `${e.path}: ${e.error}`));
    }
    // 画像は元のパスのまま保存する（ノートからのリンクが切れないように）。同じパスの画像がある場合はスキップ
    let n = 0;
    for (const img of images) {
      progress(`画像を取り込んでいます… ${++n} / ${images.length}`);
      const ext = img.path.slice(img.path.lastIndexOf(".") + 1).toLowerCase();
      try {
        await upload("/api/attachments?path=" + encodeURIComponent(img.path), new Blob([img.data]), IMAGE_TYPES[ext]);
        result.images++;
      } catch (e) {
        if (e.status === 409) result.imageSkipped++;
        else result.errors.push(`${img.path}: ${e.message}`);
      }
    }
  } catch (e) {
    result.errors.push(e.message);
  }
  pending = null;
  $("#vault-import-start").hidden = true;
  $("#vault-overwrite-row").hidden = true;
  $("#vault-import-start").disabled = false;
  await Promise.all([refreshAll(), refreshAttachments()]);
  progress([
    `取り込みました: ノート 新規 ${result.created} 件・上書き ${result.overwritten} 件・スキップ ${result.skipped} 件（同じ名前のノートがあったもの）、`,
    `画像 ${result.images} 件（同じパスの画像があってスキップ ${result.imageSkipped} 件）。`,
    skipped.length ? `\n取り込めない形式のファイル ${skipped.length} 件はスキップしました。` : "",
    result.errors.length ? `\nエラー ${result.errors.length} 件:\n${result.errors.slice(0, 10).join("\n")}` : "",
  ].join(""));
}

export function setupVault() {
  $("#open-vault").onclick = () => {
    pending = null;
    $("#vault-progress").hidden = true;
    $("#vault-import-start").hidden = true;
    $("#vault-overwrite-row").hidden = true;
    $("#vault").showModal();
  };
  $("#vault-export").onclick = exportVault;
  $("#vault-import-file").onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) readZip(file).catch((err) => progress("zip を読み込めませんでした: " + err.message));
  };
  $("#vault-import-start").onclick = importPending;
}

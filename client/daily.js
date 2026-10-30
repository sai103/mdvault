// 今日のノート（デイリーノート）とテンプレート
import { api, settings } from "./api.js";
import { pick } from "./dialogs.js";
import { getEditor, navigate, refreshAll } from "./notes.js";
import { state } from "./state.js";
import { $, basename, formatDate, stripMd, today } from "./util.js";

// {{title}} {{date}} {{time}} {{date:YYYY年MM月DD日}} {{time:HH:mm}} を置き換える（Obsidian のテンプレートと同じ書き方）
export function applyTemplate(text, title, now = new Date()) {
  return text
    .replace(/\{\{\s*title\s*\}\}/g, title)
    .replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/g, (_, fmt) => formatDate(fmt?.trim() || "YYYY-MM-DD", now))
    .replace(/\{\{\s*time(?::([^}]+))?\s*\}\}/g, (_, fmt) => formatDate(fmt?.trim() || "HH:mm", now));
}

const templates = () => state.notes.filter((n) => n.path.startsWith(settings.template_folder + "/") && !n.encrypted);

async function loadTemplate(path) {
  return (await api("GET", "/api/note?path=" + encodeURIComponent(path))).content;
}

export async function openDailyNote() {
  const date = today();
  const path = `${settings.daily_note_folder}/${date}.md`;
  if (!state.notes.some((n) => n.path === path)) {
    const tpl = `${settings.template_folder}/${settings.daily_note_template}.md`;
    const content = state.notes.some((n) => n.path === tpl) ? applyTemplate(await loadTemplate(tpl), date) : `# ${date}\n\n`;
    // 別の端末で同時に作られていた場合（409）は、そちらを開く
    await api("PUT", "/api/note", { path, content, base_updated_at: null }).catch((e) => { if (e.status !== 409) throw e; });
    await refreshAll();
  }
  navigate(path);
}

export async function insertTemplate() {
  if (!state.current || state.current.locked) return alert("先にノートを開いてください");
  const list = templates();
  if (!list.length) return alert(`テンプレートがありません。「${settings.template_folder}」フォルダにノートを作ると、テンプレートとして使えます。\n\n使える書き方: {{title}} {{date}} {{time}} {{date:YYYY年MM月DD日}}`);
  const path = await pick({
    title: "テンプレートを挿入",
    items: list.map((n) => ({ label: stripMd(n.path.slice(settings.template_folder.length + 1)), value: n.path })),
  });
  if (!path) return;
  getEditor().insert(applyTemplate(await loadTemplate(path), stripMd(basename(state.current.path))));
}

export function setupDaily() {
  $("#open-daily").onclick = () => openDailyNote().catch((e) => alert(e.message));
  $("#insert-template").onclick = () => insertTemplate().catch((e) => alert(e.message));
}

// 表示の設定（テーマ・文字の大きさ・エディタ）。端末ごとに保存する
import { getEditor } from "./notes.js";
import { $, store } from "./util.js";

const DEFAULTS = { theme: "system", fontSize: 15, editorFont: "sans", livePreview: true };

export const prefs = { ...DEFAULTS, ...store.get("prefs", {}) };

export function applyPrefs() {
  const root = document.documentElement;
  if (prefs.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  root.style.setProperty("--font-size", prefs.fontSize + "px");
  root.dataset.editorFont = prefs.editorFont;
  getEditor()?.setLivePreview(prefs.livePreview);
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  $('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1e1e1e" : "#ffffff");
}

export function setupPrefs() {
  const form = $("#prefs-form");
  $("#open-prefs").onclick = () => {
    form.theme.value = prefs.theme;
    form.fontSize.value = prefs.fontSize;
    form.editorFont.value = prefs.editorFont;
    form.livePreview.checked = prefs.livePreview;
    $("#font-size-value").textContent = prefs.fontSize + "px";
    $("#prefs").showModal();
  };
  form.addEventListener("input", () => {
    Object.assign(prefs, {
      theme: form.theme.value,
      fontSize: Number(form.fontSize.value),
      editorFont: form.editorFont.value,
      livePreview: form.livePreview.checked,
    });
    $("#font-size-value").textContent = prefs.fontSize + "px";
    store.set("prefs", prefs);
    applyPrefs();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyPrefs);
}

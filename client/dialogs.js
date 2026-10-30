// 汎用のダイアログ・メニュー
import { $, el, fuzzy } from "./util.js";

/**
 * パスフレーズを入力させる（prompt() は入力が見えてしまうので使わない）
 * @returns {Promise<{ passphrase: string, option: boolean } | null>}
 */
export function askPassphrase({ title, message, confirm = false, option = null }) {
  const dlg = $("#passphrase-dialog");
  $("#passphrase-title").textContent = title;
  $("#passphrase-message").textContent = message ?? "";
  const p1 = $("#passphrase-1"), p2 = $("#passphrase-2");
  p1.value = p2.value = "";
  $("#passphrase-2-row").hidden = !confirm;
  $("#passphrase-option-row").hidden = !option;
  if (option) { $("#passphrase-option-label").textContent = option.label; $("#passphrase-option").checked = option.checked; }
  $("#passphrase-error").textContent = "";
  dlg.showModal();
  p1.focus();
  return new Promise((resolve) => {
    const form = $("#passphrase-form");
    const done = (value) => { form.onsubmit = null; dlg.onclose = null; if (dlg.open) dlg.close(); resolve(value); };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (e.submitter?.value === "cancel") return done(null);
      if (p1.value.length < 8) { $("#passphrase-error").textContent = "8 文字以上にしてください"; return; }
      if (confirm && p1.value !== p2.value) { $("#passphrase-error").textContent = "確認用の入力が一致しません"; return; }
      done({ passphrase: p1.value, option: $("#passphrase-option").checked });
    };
    dlg.onclose = () => done(null);
  });
}

/**
 * 一覧から 1 つ選ばせる（入力で絞り込み）
 * @param {{ title: string, placeholder?: string, items: { label: string, detail?: string, value: any }[] }} opts
 */
export function pick({ title, placeholder, items }) {
  const dlg = $("#picker");
  const input = $("#picker-input");
  const list = $("#picker-list");
  $("#picker-title").textContent = title;
  input.placeholder = placeholder ?? "入力して絞り込み";
  input.value = "";
  let shown = [], index = 0;
  return new Promise((resolve) => {
    const done = (v) => { dlg.onclose = null; if (dlg.open) dlg.close(); resolve(v); };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = items.filter((i) => fuzzy(i.label.toLowerCase(), q)).slice(0, 50);
      index = Math.min(index, Math.max(0, shown.length - 1));
      list.replaceChildren(...(shown.length ? shown.map((it, i) => el("li", {
        className: i === index ? "active" : "", onclick: () => done(it.value),
      }, it.label, it.detail ? el("small", { textContent: it.detail }) : null)) : [el("li", { className: "muted", textContent: "見つかりません" })]));
    };
    input.oninput = () => { index = 0; draw(); };
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        index = (index + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(shown.length, 1);
        draw();
      } else if (e.key === "Enter" && shown[index]) { e.preventDefault(); done(shown[index].value); }
    };
    dlg.onclose = () => done(null);
    dlg.onclick = (e) => { if (e.target === dlg) done(null); };
    draw();
    dlg.showModal();
    input.focus();
  });
}

/** 右クリック・「⋯」のメニュー。items: [{ label, action, danger? }] */
export function contextMenu(x, y, items) {
  const menu = $("#context-menu");
  menu.replaceChildren(...items.map((it) => el("button", {
    textContent: it.label, className: it.danger ? "danger" : "",
    onclick: () => { closeMenu(); it.action(); },
  })));
  menu.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, w - rect.width - 8) + "px";
  menu.style.top = Math.min(y, h - rect.height - 8) + "px";
  setTimeout(() => document.addEventListener("pointerdown", outside, { once: true }));
  function outside(e) { if (!menu.contains(e.target)) closeMenu(); else document.addEventListener("pointerdown", outside, { once: true }); }
}
export function closeMenu() { $("#context-menu").hidden = true; }

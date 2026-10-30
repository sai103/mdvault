// 全文検索・クイックスイッチャー・タグの一覧
import { api } from "./api.js";
import { navigate, newNote } from "./notes.js";
import { state } from "./state.js";
import { $, el, fuzzy, highlight, noteHref, stripMd, toPath } from "./util.js";

// ---------------- 全文検索 ----------------

let searchTimer = 0;
export function setupSearch() {
  $("#search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });
  $("#search").addEventListener("keydown", (e) => { if (e.key === "Escape") setSearch(""); });
  $("#search-help").onclick = () => alert("検索のしかた\n\n・空白で区切ると、すべての語を含むノート（AND）\n・\"…\" で語句をそのまま検索\n・tag:タグ名 でタグ（子のタグも含む）\n・path:文字列 でパス（フォルダ名など）\n\n例: 設計 tag:work path:projects");
}

export function setSearch(q) {
  $("#search").value = q;
  runSearch();
  if (q) $("#search").focus();
}

async function runSearch() {
  const q = $("#search").value.trim();
  if (!q) { $("#search-results").hidden = true; $("#tree").hidden = false; return; }
  const { results, words } = await api("GET", "/api/search?q=" + encodeURIComponent(q)).catch((e) => ({ results: [], words: [], error: e.message }));
  if ($("#search").value.trim() !== q) return;
  $("#tree").hidden = true;
  $("#search-results").hidden = false;
  $("#search-results").replaceChildren(
    el("p", { className: "muted small", textContent: `${results.length} 件${results.length >= 50 ? "（上位 50 件）" : ""}` }),
    ...results.map((r) => el("a", { href: noteHref(r.path) },
      el("strong", {}, ...highlight(stripMd(r.path), words)),
      el("small", {}, ...highlight(r.snippet, words)))));
}

// ---------------- タグ ----------------

export function renderTagList() {
  $("#tag-count").textContent = state.tags.length ? `（${state.tags.length}）` : "";
  $("#tag-list").replaceChildren(...(state.tags.length
    ? state.tags.map((t) => el("li", {}, el("a", {
      href: "#", textContent: "#" + t.tag, onclick: (e) => { e.preventDefault(); setSearch("tag:" + t.tag); },
    }), el("span", { className: "muted", textContent: String(t.count) })))
    : [el("li", { className: "muted", textContent: "本文に #タグ と書くとここに出ます" })]));
}

// ---------------- クイックスイッチャー（Ctrl+P） ----------------

let items = [], index = 0;
export function openSwitcher() {
  $("#switcher-input").value = "";
  draw();
  $("#switcher").showModal();
}

function draw() {
  const q = $("#switcher-input").value.trim().toLowerCase();
  items = state.notes.map((n) => n.path).filter((p) => fuzzy(stripMd(p).toLowerCase(), q)).slice(0, 30);
  index = Math.min(index, Math.max(items.length - 1, 0));
  const list = items.map((p, i) => el("li", {
    textContent: stripMd(p), className: i === index ? "active" : "",
    onclick: () => { $("#switcher").close(); navigate(p); },
  }));
  const raw = $("#switcher-input").value.trim();
  if (raw && !state.notes.some((n) => n.path === toPath(raw))) {
    list.push(el("li", {
      className: "create" + (items.length ? "" : " active"), textContent: `＋ 「${raw}」を作成`,
      onclick: () => { $("#switcher").close(); newNote(raw); },
    }));
  }
  $("#switcher-list").replaceChildren(...list);
}

export function setupSwitcher() {
  $("#switcher-input").addEventListener("input", () => { index = 0; draw(); });
  $("#switcher-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length || 1;
      index = (index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = $("#switcher-input").value.trim();
      $("#switcher").close();
      if (items.length && !(e.shiftKey && q)) navigate(items[index]);
      else if (q) newNote(q);
    }
  });
  $("#switcher").addEventListener("click", (e) => { if (e.target === $("#switcher")) $("#switcher").close(); });
  $("#open-switcher").onclick = openSwitcher;
}

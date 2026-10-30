// 画面全体で使う小さな道具

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 要素を作る。props は DOM のプロパティ（textContent など。innerHTML は使わない）、children は要素か文字列
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// 端末ごとの設定・表示状態（失われても困らないものだけ。プライベートウィンドウなどでは使えないことがある）
export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  remove(k) { try { localStorage.removeItem(k); } catch {} },
  keys(prefix) { try { return Object.keys(localStorage).filter((k) => k.startsWith(prefix)); } catch { return []; } },
};

// ---- パス ----
export const stripMd = (p) => p.replace(/\.md$/i, "");
export const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const linkKey = (s) => stripMd(s).toLowerCase();
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
// ノートは拡張子なし、画像は拡張子つきで表示する
export const displayName = (p) => (IMAGE_EXT.test(p) ? p : stripMd(p));
export function toPath(name) {
  const p = name.trim().replace(/^\/+/, "");
  return p.toLowerCase().endsWith(".md") ? p : p + ".md";
}
export const noteHref = (path) => "#/" + path.split("/").map(encodeURIComponent).join("/");

// ---- 表示 ----
export const fmtTime = (t) => new Date(t).toLocaleString();
export const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.ceil(n / 1024))}KB`);
const pad = (n) => String(n).padStart(2, "0");
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const timestamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
// テンプレート用: YYYY MM DD HH mm ss を置き換える
export const formatDate = (fmt, d = new Date()) => fmt
  .replace(/YYYY/g, d.getFullYear()).replace(/MM/g, pad(d.getMonth() + 1)).replace(/DD/g, pad(d.getDate()))
  .replace(/HH/g, pad(d.getHours())).replace(/mm/g, pad(d.getMinutes())).replace(/ss/g, pad(d.getSeconds()));

// 入力した文字が順番どおりに含まれていれば一致（あいまい検索）
export function fuzzy(text, q) {
  let i = 0;
  for (const c of text) if (c === q[i]) i++;
  return i === q.length;
}

// 文字列中の語を <mark> で囲んだ要素の配列にする（innerHTML を使わない）
export function highlight(text, words) {
  const lower = text.toLowerCase();
  const ranges = [];
  for (const w of words.map((x) => x.toLowerCase()).filter(Boolean)) {
    for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) ranges.push([i, i + w.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    out.push(text.slice(pos, s), el("mark", { textContent: text.slice(s, e) }));
    pos = e;
  }
  out.push(text.slice(pos));
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

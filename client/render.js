// Markdown のプレビュー。marked で HTML にし、必ず DOMPurify で無害化してから表示する
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { api } from "./api.js";
import { isEncrypted, rememberedPassphrase, decrypt } from "./crypto.js";
import { attachmentUrl, resolveAttachment, resolveLink } from "./state.js";
import { IMAGE_EXT, basename, el, noteHref, stripMd } from "./util.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  extensions: [{
    name: "wikilink",
    level: "inline",
    start: (src) => src.indexOf("[["),
    tokenizer(src) {
      const m = /^!?\[\[([^\]\n]+?)\]\]/.exec(src);
      if (!m) return;
      const [targetPart, alias] = m[1].split("|");
      const [target, heading] = targetPart.split("#");
      return { type: "wikilink", raw: m[0], target: target.trim(), heading: heading?.trim(), alias: alias?.trim(), embed: m[0][0] === "!" };
    },
    renderer(t) {
      const label = t.alias ?? (t.heading ? `${t.target} > ${t.heading}` : t.target);
      if (t.embed && IMAGE_EXT.test(t.target)) {
        const path = resolveAttachment(t.target);
        if (!path) return `<span class="missing-embed">画像が見つかりません: ${esc(t.target)}</span>`;
        // ![[画像.png|300]] や ![[画像.png|300x200]] でサイズ指定（Obsidian と同じ）
        const size = /^(\d+)(?:x(\d+))?$/.exec(t.alias ?? "");
        const attrs = size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ""}` : "";
        return `<img class="embed" src="${esc(attachmentUrl(path))}" alt="${esc(size || !t.alias ? basename(path) : t.alias)}" loading="lazy"${attrs}>`;
      }
      if (t.embed) {
        // ![[ノート]] / ![[ノート#見出し]]: 表示した後に中身を読み込む（hydrateEmbeds）
        return `<div class="embed-note" data-target="${esc(t.target)}" data-heading="${esc(t.heading ?? "")}">${esc(label)}</div>`;
      }
      const resolved = t.target ? resolveLink(t.target) : null;
      return `<a class="wikilink${resolved || !t.target ? "" : " unresolved"}" data-target="${esc(t.target)}" data-heading="${esc(t.heading ?? "")}" href="${resolved ? noteHref(resolved) : "#"}">${esc(label)}</a>`;
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
      node.setAttribute("src", attachmentUrl(resolveAttachment(target) ?? target.replace(/^(\.\.?\/)+/, "")));
    }
  }
  if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") ?? "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  // チェックボックスはプレビューから切り替えられるようにする
  if (node.tagName === "INPUT" && node.getAttribute("type") === "checkbox") node.removeAttribute("disabled");
});

// 先頭の YAML（frontmatter）を取り出す
export function splitFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
  if (!m) return { props: [], body: content };
  const props = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([^:#\s][^:]*):\s*(.*)$/.exec(line);
    if (kv) props.push([kv[1].trim(), kv[2].trim()]);
    else if (/^\s*-\s+/.test(line) && props.length) props[props.length - 1][1] += (props[props.length - 1][1] ? ", " : "") + line.replace(/^\s*-\s+/, "");
  }
  return { props, body: content.slice(m[0].length) };
}

/** Markdown を container に表示する。depth は埋め込みの深さ（無限に埋め込まないため） */
export function renderMarkdown(container, content, { depth = 0, chain = [] } = {}) {
  const { props, body } = splitFrontmatter(content);
  container.innerHTML = DOMPurify.sanitize(marked.parse(body));
  if (props.length) {
    container.prepend(el("table", { className: "frontmatter" },
      ...props.map(([k, v]) => el("tr", {}, el("th", { textContent: k }), el("td", { textContent: v })))));
  }
  linkifyTags(container);
  hydrateEmbeds(container, depth, chain);
}

// 本文中の #タグ をリンクにする（コード・リンクの中は除く）。要素を作って差し込むので HTML としては解釈されない
function linkifyTags(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("code, pre, a, .frontmatter") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes("#")) targets.push(n);
  const re = /(^|[\s(（、。,])#([\p{L}\p{N}_\-/]+)/gu;
  for (const node of targets) {
    const text = node.nodeValue;
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (/^\d+$/.test(m[2])) continue;
      const start = m.index + m[1].length;
      parts.push(text.slice(last, start), el("a", { className: "tag", href: "#", textContent: "#" + m[2], dataset: { tag: m[2].toLowerCase() } }));
      last = start + 1 + m[2].length;
    }
    if (!parts.length) continue;
    parts.push(text.slice(last));
    node.replaceWith(...parts);
  }
}

// ![[ノート]] の中身を読み込んで表示する。暗号化されたノートは、このタブでパスフレーズを入力済みなら表示する
async function hydrateEmbeds(root, depth, chain) {
  for (const box of root.querySelectorAll(".embed-note")) {
    const target = box.dataset.target;
    const heading = box.dataset.heading;
    const path = resolveLink(target);
    const title = el("div", { className: "embed-title" }, el("a", { href: path ? noteHref(path) : "#", textContent: stripMd(basename(path ?? target)) + (heading ? ` > ${heading}` : "") }));
    if (!path) { box.replaceChildren(el("span", { className: "missing-embed", textContent: `ノートが見つかりません: ${target}` })); continue; }
    if (depth >= 2 || chain.includes(path)) { box.replaceChildren(title, el("p", { className: "muted", textContent: "（これ以上は埋め込みません）" })); continue; }
    try {
      let { content } = await api("GET", "/api/note?path=" + encodeURIComponent(path));
      if (isEncrypted(content)) {
        const pass = rememberedPassphrase();
        if (!pass) throw new Error("🔒 暗号化されたノートです");
        content = (await decrypt(content, pass)).text;
      }
      const inner = el("div", { className: "embed-body markdown" });
      renderMarkdown(inner, heading ? sectionOf(content, heading) : content, { depth: depth + 1, chain: [...chain, path] });
      box.replaceChildren(title, inner);
    } catch (e) {
      box.replaceChildren(title, el("p", { className: "muted", textContent: e.message }));
    }
  }
}

// 見出しから、次の同じかそれより上のレベルの見出しまで
export function sectionOf(content, heading) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => { const m = /^(#{1,6})\s+(.*)$/.exec(l); return m && m[2].trim().toLowerCase() === heading.toLowerCase(); });
  if (start < 0) return content;
  const level = /^(#{1,6})/.exec(lines[start])[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

// 見出しの一覧（アウトライン用）。offset は本文中の位置
export function headings(content) {
  const items = [];
  let inCode = false, offset = 0;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
    const m = !inCode && /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) items.push({ level: m[1].length, text: m[2], offset });
    offset += line.length + 1;
  }
  return items;
}

// 本文中の n 番目のチェックボックス（- [ ] / - [x]）の位置。コードブロックの中は数えない
export function taskPositions(content) {
  const out = [];
  let inCode = false, offset = 0;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
    const m = !inCode && /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(line);
    if (m) out.push({ pos: offset + m[1].length, checked: m[2] !== " " });
    offset += line.length + 1;
  }
  return out;
}

// ノート本文の解析（リンク・タグの抽出、リンクの書き換え）。DB に触れない純粋な関数だけを置く

// ブラウザ側で暗号化したノートの先頭（Obsidian のコメント記法なので、Obsidian で開いても本文には表示されない）
export const ENCRYPTED_MARKER = "%%mdvault-encrypted v1%%";
export const isEncrypted = (content: string) => content.startsWith(ENCRYPTED_MARKER);

// Obsidian と同様、リンクは大文字小文字を区別せず、".md" は省略可能
export const stripMd = (s: string) => s.replace(/\.md$/i, "");
export const linkKey = (s: string) => stripMd(s).toLowerCase();
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

type Segment = { code: boolean; text: string };

// 本文をコード（``` / ~~~ のブロックと `インライン`）とそれ以外に分ける。リンクやタグはコードの外だけを見る
export function splitCode(content: string): Segment[] {
  const segments: Segment[] = [];
  const re = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)|`[^`\n]+`/g;
  let last = 0;
  for (const m of content.matchAll(re)) {
    const start = m.index + (m[1] ?? "").length;
    if (start > last) segments.push({ code: false, text: content.slice(last, start) });
    segments.push({ code: true, text: content.slice(start, m.index + m[0].length) });
    last = m.index + m[0].length;
  }
  if (last < content.length) segments.push({ code: false, text: content.slice(last) });
  return segments;
}

const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;

// [[ノート]]・[[ノート#見出し]]・[[ノート|別名]]・![[画像]] のリンク先（正規化したキー）
export function extractLinks(content: string): Set<string> {
  const keys = new Set<string>();
  if (isEncrypted(content)) return keys;
  for (const seg of splitCode(content)) {
    if (seg.code) continue;
    for (const m of seg.text.matchAll(WIKILINK)) {
      const target = m[2].split("|")[0].split("#")[0].trim();
      if (target) keys.add(linkKey(target));
    }
  }
  return keys;
}

// リンク先を書き換える。rewrite がリンク先の新しい文字列を返したものだけ置き換え、見出し・別名は残す
export function rewriteLinks(content: string, rewrite: (target: string) => string | null): string {
  if (isEncrypted(content)) return content;
  return splitCode(content).map((seg) => seg.code ? seg.text : seg.text.replace(WIKILINK, (all, bang: string, inner: string) => {
    const pipe = inner.indexOf("|");
    const targetPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe) : "";
    const hash = targetPart.indexOf("#");
    const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const heading = hash >= 0 ? targetPart.slice(hash) : "";
    if (!target) return all;
    const next = rewrite(target);
    return next === null ? all : `${bang}[[${next}${heading}${alias}]]`;
  })).join("");
}

// #タグ（本文）と、先頭の YAML（frontmatter）の tags。Obsidian と同じく、数字だけのものはタグにしない
export function extractTags(content: string): Set<string> {
  const tags = new Set<string>();
  if (isEncrypted(content)) return tags;
  const add = (raw: string) => {
    const tag = raw.trim().replace(/^["']|["']$/g, "").replace(/^#/, "").toLowerCase();
    if (tag && /^[\p{L}\p{N}_\-/]+$/u.test(tag) && !/^\d+$/.test(tag)) tags.add(tag);
  };
  let body = content;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
  if (fm) {
    body = content.slice(fm[0].length);
    const lines = fm[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^(tags|tag)\s*:\s*(.*)$/i.exec(lines[i]);
      if (!m) continue;
      const value = m[2].trim();
      if (value.startsWith("[")) value.replace(/^\[|\]$/g, "").split(",").forEach(add);
      else if (value) value.split(/[\s,]+/).forEach(add);
      else for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) add(lines[j].replace(/^\s*-\s+/, ""));
    }
  }
  for (const seg of splitCode(body)) {
    if (seg.code) continue;
    for (const m of seg.text.matchAll(/(^|[\s(（、。,])#([\p{L}\p{N}_\-/]+)/gu)) add(m[2]);
  }
  return tags;
}

// リンクの文字列がどのノートを指すか（クライアントと同じ規則: フルパス一致を優先し、なければファイル名が一致する最初のノート）
export function makeResolver(paths: string[]): (target: string) => string | null {
  const full = new Map<string, string>();
  const base = new Map<string, string>();
  for (const p of [...paths].sort()) {
    full.set(linkKey(p), p);
    if (!base.has(linkKey(basename(p)))) base.set(linkKey(basename(p)), p);
  }
  return (target) => full.get(linkKey(target)) ?? base.get(linkKey(target)) ?? null;
}

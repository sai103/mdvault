// CodeMirror 6 によるエディタ。Markdown の色分けと、カーソルのない行では記号（# や ** など）を隠す「ライブプレビュー」風の表示
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
// markdown() は HTML・CSS・JavaScript の解析器も読み込んで大きくなるので、Markdown の部分だけを使う
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, LanguageSupport, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, drawSelection, dropCursor, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// 色はすべて CSS 変数で指定する（テーマの切り替えに追従させるため）
const highlightStyle = HighlightStyle.define([
  { tag: t.heading1, class: "cm-h cm-h1" },
  { tag: t.heading2, class: "cm-h cm-h2" },
  { tag: t.heading3, class: "cm-h cm-h3" },
  { tag: [t.heading4, t.heading5, t.heading6], class: "cm-h" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, class: "cm-md-link" },
  { tag: t.url, class: "cm-md-url" },
  { tag: t.monospace, class: "cm-md-code" },
  { tag: t.quote, class: "cm-md-quote" },
  { tag: t.processingInstruction, class: "cm-md-mark" },
  { tag: t.contentSeparator, class: "cm-md-mark" },
]);

const WIKILINK = /!?\[\[([^\]\n]+?)\]\]/g;
const HIDE_MARKS = new Set(["HeaderMark", "EmphasisMark", "StrikethroughMark"]);

// カーソルがある行を除いて、Markdown の記号を隠す
// 先頭の YAML（frontmatter）の終わりの位置。なければ 0
function frontmatterEnd(state) {
  const head = state.sliceDoc(0, Math.min(state.doc.length, 20000));
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(head);
  return m ? m[0].trimEnd().length : 0;
}

function livePreview(view) {
  const { state } = view;
  const fmEnd = frontmatterEnd(state);
  const activeLines = new Set();
  for (const r of state.selection.ranges) {
    for (let l = state.doc.lineAt(r.from).number; l <= state.doc.lineAt(r.to).number; l++) activeLines.add(l);
  }
  const isActive = (pos) => activeLines.has(state.doc.lineAt(pos).number);
  const decos = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        if (node.from < fmEnd || isActive(node.from)) return;
        if (HIDE_MARKS.has(node.name) || (node.name === "CodeMark" && node.node.parent?.name === "InlineCode")) {
          let end = node.to;
          if (node.name === "HeaderMark" && state.sliceDoc(end, end + 1) === " ") end++;
          if (end > node.from) decos.push(Decoration.replace({}).range(node.from, end));
        }
      },
    });
    // [[リンク]]: 色を付け、カーソルのない行では [[ ]] と（別名があれば）リンク先を隠す
    const text = state.sliceDoc(from, to);
    for (const m of text.matchAll(WIKILINK)) {
      const start = from + m.index;
      const end = start + m[0].length;
      const inCode = /Code|Comment/.test(tree.resolveInner(start, 1).name);
      if (inCode || start < fmEnd) continue;
      decos.push(Decoration.mark({ class: "cm-wikilink", attributes: { "data-target": m[1].split("|")[0] } }).range(start, end));
      if (isActive(start)) continue;
      const open = m[0].startsWith("!") ? 3 : 2;
      const pipe = m[1].indexOf("|");
      decos.push(Decoration.replace({}).range(start, start + open + (pipe >= 0 ? pipe + 1 : 0)));
      decos.push(Decoration.replace({}).range(end - 2, end));
    }
  }
  // frontmatter は Markdown として解釈させない（見出しなどの見た目にしない）
  if (fmEnd) {
    for (let l = 1; l <= state.doc.lineAt(fmEnd).number; l++) decos.push(Decoration.line({ class: "cm-frontmatter" }).range(state.doc.line(l).from));
  }
  return Decoration.set(decos, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = livePreview(view); }
  update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = livePreview(u.view); }
}, { decorations: (v) => v.decorations });

/**
 * @param {HTMLElement} parent
 * @param {{
 *   onChange: () => void,
 *   completions: (kind: "note" | "image" | "tag") => { label: string, detail?: string, insert: string }[],
 *   onFiles: (files: File[]) => void,
 *   onOpenLink: (target: string) => void,
 * }} opts
 */
export function createEditor(parent, opts) {
  const readOnly = new Compartment();
  const preview = new Compartment();
  // setValue で作り直しても設定が保たれるよう、現在の値を覚えておく
  let readOnlyOn = false;
  let livePreviewOn = true;

  // [[ でノート、![[ で画像、# でタグを補完する
  const completionSource = (ctx) => {
    const link = ctx.matchBefore(/!?\[\[[^\]\n|#]*$/);
    if (link) {
      const image = link.text.startsWith("!");
      return {
        from: link.from + (image ? 3 : 2),
        options: opts.completions(image ? "image" : "note").map((o) => ({
          label: o.label, detail: o.detail,
          apply: (view, _c, from, to) => {
            const close = view.state.sliceDoc(to, to + 2) === "]]" ? "" : "]]";
            view.dispatch({ changes: { from, to, insert: o.insert + close }, selection: { anchor: from + o.insert.length + 2 } });
          },
        })),
      };
    }
    const tag = ctx.matchBefore(/(?:^|\s)#[\p{L}\p{N}_\-/]*$/u);
    if (tag && (ctx.explicit || tag.text.trim().length > 1)) {
      const start = tag.from + tag.text.indexOf("#") + 1;
      return { from: start, options: opts.completions("tag").map((o) => ({ label: o.label, detail: o.detail, apply: o.insert })) };
    }
    return null;
  };

  const imageFiles = (list) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

  const extensions = () => [
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    new LanguageSupport(markdownLanguage),
    syntaxHighlighting(highlightStyle),
    preview.of(livePreviewOn ? livePreviewPlugin : []),
    closeBrackets(),
    autocompletion({ override: [completionSource], icons: false }),
    search({ top: true }),
    highlightSelectionMatches(),
    placeholder("ここに Markdown を書く。[[ でリンク、![[ で画像、# でタグを補完"),
    readOnly.of(EditorState.readOnly.of(readOnlyOn)),
    // Enter でリストや引用の記号を続ける、Backspace で記号を消す
    keymap.of([{ key: "Enter", run: insertNewlineContinueMarkup }, { key: "Backspace", run: deleteMarkupBackward }]),
    keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
    EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange(); }),
    EditorView.domEventHandlers({
      paste(e) {
        const files = imageFiles(e.clipboardData?.files);
        if (!files.length) return false;
        e.preventDefault();
        opts.onFiles(files);
        return true;
      },
      drop(e, view) {
        const files = imageFiles(e.dataTransfer?.files);
        if (!files.length) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos !== null) view.dispatch({ selection: { anchor: pos } });
        opts.onFiles(files);
        return true;
      },
      // Ctrl / Cmd を押しながらクリックでリンク先を開く
      mousedown(e) {
        const link = e.target.closest?.(".cm-wikilink");
        if (!link || !(e.ctrlKey || e.metaKey)) return false;
        e.preventDefault();
        opts.onOpenLink(link.dataset.target ?? link.closest("[data-target]")?.dataset.target ?? "");
        return true;
      },
    }),
  ];

  // CodeMirror はページに <style> を追加して見た目を付けるが、CSP（style-src 'self'）で止められる。
  // Shadow DOM の中なら、CSP の対象外の方法（constructable stylesheet）で付けるので、エディタを Shadow DOM に入れる
  const shadow = parent.attachShadow({ mode: "open" });
  shadow.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/editor.css" }));
  const view = new EditorView({ parent: shadow, root: shadow, state: EditorState.create({ doc: "", extensions: extensions() }) });

  const api = {
    view,
    getValue: () => view.state.doc.toString(),
    // ノートを開いたとき。取り消し（Ctrl+Z）の履歴もリセットする
    setValue(doc) {
      view.setState(EditorState.create({ doc, extensions: extensions() }));
    },
    // カーソル位置に挿入する（選択範囲は置き換える）
    insert(text) {
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
      view.focus();
    },
    // 本文を差し替える（プレビューのチェックボックスなど）。取り消しの履歴には残す
    replaceRange(from, to, text) {
      view.dispatch({ changes: { from, to, insert: text } });
    },
    focus: () => view.focus(),
    setCursor(pos) {
      view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
    },
    setReadOnly(on) {
      readOnlyOn = on;
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(on)) });
    },
    setLivePreview(on) {
      livePreviewOn = on;
      view.dispatch({ effects: preview.reconfigure(on ? livePreviewPlugin : []) });
    },
  };
  // 画面の E2E テストから内容を読み書きするため
  parent.mdvEditor = api;
  return api;
}

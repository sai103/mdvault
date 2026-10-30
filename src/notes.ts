import { HttpError, body, json, settings, type Env } from "./common";
import { basename, extractLinks, extractTags, isEncrypted, linkKey, makeResolver, rewriteLinks, stripMd, ENCRYPTED_MARKER } from "./markdown";

type Note = { path: string; content: string; updated_at: number };
type Reason = "edit" | "overwrite" | "delete" | "restore" | "rename" | "import";

// ログイン中のみ呼ばれる。ノート関連のルートでなければ null を返す
export async function handleNotesApi(route: string, req: Request, url: URL, env: Env): Promise<Response | null> {
  switch (route) {
    case "GET /api/notes": {
      const [notes, folders] = await env.DB.batch([
        env.DB.prepare("SELECT path, updated_at, instr(content, ?) = 1 AS encrypted FROM notes ORDER BY path").bind(ENCRYPTED_MARKER),
        env.DB.prepare("SELECT path FROM folders ORDER BY path"),
      ]);
      return json({
        notes: (notes.results as { path: string; updated_at: number; encrypted: number }[]).map((n) => ({ ...n, encrypted: !!n.encrypted })),
        folders: (folders.results as { path: string }[]).map((f) => f.path),
      });
    }
    case "GET /api/note": {
      const path = checkPath(url.searchParams.get("path"));
      const note = await env.DB.prepare("SELECT path, content, updated_at FROM notes WHERE path = ?").bind(path).first();
      if (!note) throw new HttpError(404, "not found");
      return json(note);
    }
    case "PUT /api/note":
      return saveNote(req, env);
    case "DELETE /api/note": {
      const path = checkPath(url.searchParams.get("path"));
      const note = await getNote(env, path);
      if (!note) throw new HttpError(404, "not found");
      await env.DB.batch(deleteStatements(env, note));
      return json({ ok: true });
    }
    case "POST /api/note/rename": {
      const { from, to } = await body<{ from: string; to: string }>(req);
      const result = await moveNotes(env, [[checkPath(from), checkPath(to)]]);
      return json({ path: checkPath(to), ...result });
    }
    case "POST /api/note/restore":
      return restoreRevision(req, env);

    // ---- フォルダ ----
    case "POST /api/folders": {
      const { path: raw } = await body<{ path: string }>(req);
      const path = checkFolderPath(raw);
      await env.DB.prepare("INSERT OR IGNORE INTO folders (path, created_at) VALUES (?, ?)").bind(path, Date.now()).run();
      return json({ path });
    }
    case "POST /api/folder/rename":
      return renameFolder(req, env);
    case "DELETE /api/folder": {
      const path = checkFolderPath(url.searchParams.get("path"));
      const { results } = await env.DB.prepare("SELECT path, content, updated_at FROM notes WHERE substr(path, 1, ?) = ?")
        .bind(path.length + 1, path + "/").all<Note>();
      if (results.length > settings(env).MAX_NOTES_PER_BULK_OPERATION) throw tooMany(env);
      // 中のノートはゴミ箱から 1 つずつ復元できる
      await env.DB.batch([
        ...results.flatMap((n) => deleteStatements(env, n)),
        env.DB.prepare("DELETE FROM folders WHERE path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/'").bind(path),
      ]);
      return json({ deleted: results.length });
    }

    // ---- 履歴・ゴミ箱 ----
    case "GET /api/revisions": {
      const path = checkPath(url.searchParams.get("path"));
      const { results } = await env.DB.prepare(
        "SELECT id, reason, saved_at, created_at, length(content) AS size FROM note_revisions WHERE path = ? ORDER BY id DESC",
      ).bind(path).all();
      return json({ revisions: results });
    }
    case "DELETE /api/revisions": {
      // ノートを暗号化したとき、暗号化前の内容が残った履歴を消す
      const path = checkPath(url.searchParams.get("path"));
      const r = await env.DB.prepare("DELETE FROM note_revisions WHERE path = ?").bind(path).run();
      return json({ deleted: r.meta.changes });
    }
    case "GET /api/revision": {
      const rev = await env.DB.prepare("SELECT id, path, content, reason, saved_at FROM note_revisions WHERE id = ?")
        .bind(Number(url.searchParams.get("id"))).first();
      if (!rev) throw new HttpError(404, "not found");
      return json(rev);
    }
    case "GET /api/trash": {
      // 削除された後、同じパスで作り直されていないノート
      const { results } = await env.DB.prepare(
        `SELECT r.id, r.path, r.created_at AS deleted_at FROM note_revisions r
           WHERE r.reason = 'delete' AND r.path NOT IN (SELECT path FROM notes)
             AND r.id = (SELECT max(id) FROM note_revisions WHERE path = r.path AND reason = 'delete')
           ORDER BY r.id DESC`,
      ).all();
      return json({ trash: results });
    }

    // ---- リンク・タグ・検索 ----
    case "GET /api/backlinks": {
      const path = checkPath(url.searchParams.get("path"));
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT src AS path FROM links WHERE dst IN (?, ?) AND src != ? ORDER BY src",
      ).bind(linkKey(path), linkKey(basename(path)), path).all();
      return json({ backlinks: results });
    }
    case "GET /api/links": {
      // グラフビュー用。dst はリンクの文字列を正規化したもの（どのノートを指すかは画面側で解決する）
      const { results } = await env.DB.prepare("SELECT src, dst FROM links").all();
      return json({ links: results });
    }
    case "GET /api/tags": {
      const { results } = await env.DB.prepare("SELECT tag, count(*) AS count FROM tags GROUP BY tag ORDER BY tag").all();
      return json({ tags: results });
    }
    case "GET /api/search":
      return search(url, env);

    // ---- 取り込み・書き出し ----
    case "POST /api/import/notes":
      return importNotes(req, env);
    case "GET /api/export": {
      const [notes, folders, attachments] = await env.DB.batch([
        env.DB.prepare("SELECT path, content, created_at, updated_at FROM notes ORDER BY path"),
        env.DB.prepare("SELECT path FROM folders ORDER BY path"),
        env.DB.prepare("SELECT path, content_type, size, created_at FROM attachments ORDER BY path"),
      ]);
      return json({
        notes: notes.results,
        folders: (folders.results as { path: string }[]).map((f) => f.path),
        attachments: attachments.results,
      });
    }
  }
  return null;
}

// ---------------- 保存・復元 ----------------

async function saveNote(req: Request, env: Env): Promise<Response> {
  const { path: rawPath, content, base_updated_at } = await body<{ path: string; content: string; base_updated_at?: number | null }>(req);
  const path = checkPath(rawPath);
  checkContent(env, content);
  const s = settings(env);

  const existing = await getNote(env, path);
  // 楽観的ロック: 他のデバイスで先に更新されていたら上書きしない（base_updated_at 省略時は強制上書き）
  const force = base_updated_at === undefined;
  if (!force && (existing?.updated_at ?? null) !== base_updated_at) {
    throw new HttpError(409, "他のデバイスで更新されています");
  }

  // 上書き前の内容を版として残す。自動保存のたびに残さないよう、通常の編集は一定間隔ごと
  const revisions: D1PreparedStatement[] = [];
  if (existing && existing.content && existing.content !== content) {
    const last = await env.DB.prepare("SELECT max(created_at) AS t FROM note_revisions WHERE path = ?").bind(path).first<number>("t");
    if (force) revisions.push(...revisionStatements(env, path, existing.content, "overwrite", existing.updated_at));
    else if (!last || Date.now() - last >= s.REVISION_INTERVAL_MINUTES * 60 * 1000) revisions.push(...revisionStatements(env, path, existing.content, "edit", existing.updated_at));
  }

  const now = Date.now();
  await env.DB.batch([...revisions, upsertStatement(env, path, content, now), ...indexStatements(env, path, content)]);
  return json({ path, updated_at: now });
}

// 過去の版（またはゴミ箱のノート）を復元する。復元前の内容も版として残す
async function restoreRevision(req: Request, env: Env): Promise<Response> {
  const { id } = await body<{ id: number }>(req);
  const rev = await env.DB.prepare("SELECT path, content FROM note_revisions WHERE id = ?").bind(id).first<{ path: string; content: string }>();
  if (!rev) throw new HttpError(404, "not found");
  const existing = await getNote(env, rev.path);
  const now = Date.now();
  await env.DB.batch([
    ...(existing && existing.content !== rev.content ? revisionStatements(env, rev.path, existing.content, "restore", existing.updated_at) : []),
    upsertStatement(env, rev.path, rev.content, now),
    ...indexStatements(env, rev.path, rev.content),
  ]);
  return json({ path: rev.path, updated_at: now });
}

// ---------------- 移動（リネーム）とリンクの書き換え ----------------

// ノートを移動し、移動したノートを指している [[リンク]] を新しいパスに書き換える。書き換える前の内容は履歴（rename）に残す
async function moveNotes(env: Env, moves: [string, string][]): Promise<{ updated: string[] }> {
  moves = moves.filter(([from, to]) => from !== to);
  if (!moves.length) return { updated: [] };
  const moved = new Map(moves);
  const { results } = await env.DB.prepare("SELECT path FROM notes").all<{ path: string }>();
  const oldPaths = results.map((r) => r.path);
  const existing = new Set(oldPaths);
  for (const [from, to] of moves) {
    if (!existing.has(from)) throw new HttpError(404, `ノートがありません: ${from}`);
    if (existing.has(to) && !moved.has(to)) throw new HttpError(409, `同じ名前のノートが既にあります: ${to}`);
  }
  const newPaths = oldPaths.map((p) => moved.get(p) ?? p);
  if (new Set(newPaths).size !== newPaths.length) throw new HttpError(409, "移動先の名前が重複しています");
  const resolveOld = makeResolver(oldPaths);
  const resolveNew = makeResolver(newPaths);

  // 移動するノートを指している可能性があるノート（フルパスかファイル名でリンクしている）
  const keys = [...new Set(moves.flatMap(([from]) => [linkKey(from), linkKey(basename(from))]))];
  const { results: referrers } = await env.DB.prepare(
    "SELECT path, content, updated_at FROM notes WHERE path IN (SELECT DISTINCT src FROM links WHERE dst IN (SELECT value FROM json_each(?)))",
  ).bind(JSON.stringify(keys)).all<Note>();

  const rewrite = (target: string): string | null => {
    const to = moved.get(resolveOld(target) ?? "");
    if (!to) return null;
    // 元の書き方（フルパスかファイル名か、.md の有無）に合わせる。ファイル名だけでは別のノートを指してしまう場合はフルパスにする
    const usesPath = target.includes("/");
    let next = usesPath ? stripMd(to) : stripMd(basename(to));
    if (!usesPath && resolveNew(next) !== to) next = stripMd(to);
    if (/\.md$/i.test(target)) next += ".md";
    return next === target ? null : next;
  };

  const now = Date.now();
  const statements: D1PreparedStatement[] = moves.flatMap(([from, to]) => [
    env.DB.prepare("UPDATE notes SET path = ?, updated_at = ? WHERE path = ?").bind(to, now, from),
    env.DB.prepare("UPDATE links SET src = ? WHERE src = ?").bind(to, from),
    env.DB.prepare("UPDATE tags SET src = ? WHERE src = ?").bind(to, from),
    env.DB.prepare("UPDATE note_revisions SET path = ? WHERE path = ?").bind(to, from),
  ]);
  const updated: string[] = [];
  for (const note of referrers) {
    const content = rewriteLinks(note.content, rewrite);
    if (content === note.content) continue;
    const path = moved.get(note.path) ?? note.path;
    updated.push(path);
    statements.push(
      ...revisionStatements(env, path, note.content, "rename", note.updated_at),
      env.DB.prepare("UPDATE notes SET content = ?, updated_at = ? WHERE path = ?").bind(content, now, path),
      ...indexStatements(env, path, content),
    );
  }
  await env.DB.batch(statements);
  return { updated };
}

async function renameFolder(req: Request, env: Env): Promise<Response> {
  const { from: rawFrom, to: rawTo } = await body<{ from: string; to: string }>(req);
  const from = checkFolderPath(rawFrom);
  const to = checkFolderPath(rawTo);
  if (from === to) return json({ path: to, updated: [] });
  if (to.startsWith(from + "/")) throw new HttpError(400, "フォルダを自分の中には移動できません");
  const prefixQuery = "SELECT path FROM notes WHERE substr(path, 1, ?1) = ?2 UNION SELECT path FROM folders WHERE path = ?3 OR substr(path, 1, ?1) = ?2";
  const target = await env.DB.prepare(prefixQuery + " LIMIT 1").bind(to.length + 1, to + "/", to).first();
  if (target) throw new HttpError(409, `同じ名前のフォルダが既にあります: ${to}`);

  const { results } = await env.DB.prepare("SELECT path FROM notes WHERE substr(path, 1, ?) = ?").bind(from.length + 1, from + "/").all<{ path: string }>();
  if (results.length > settings(env).MAX_NOTES_PER_BULK_OPERATION) throw tooMany(env);
  const { updated } = await moveNotes(env, results.map((r) => [r.path, to + r.path.slice(from.length)]));
  await env.DB.batch([
    env.DB.prepare("UPDATE folders SET path = ?2 || substr(path, length(?1) + 1) WHERE path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/'")
      .bind(from, to),
    env.DB.prepare("INSERT OR IGNORE INTO folders (path, created_at) VALUES (?, ?)").bind(to, Date.now()),
  ]);
  return json({ path: to, moved: results.length, updated });
}

// ---------------- 検索 ----------------

// 複数の語はすべて含むもの（AND）。"…" で語句、tag:名前 でタグ、path:文字列 でパスを絞り込む
async function search(url: URL, env: Env): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const words: string[] = [];
  const conditions: string[] = [];
  const binds: unknown[] = [];
  const like = (s: string) => `%${s.toLowerCase().replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  for (const m of q.matchAll(/(tag|path):("[^"]+"|\S+)|"([^"]+)"|(\S+)/g)) {
    const value = (m[2] ?? "").replace(/^"|"$/g, "");
    if (m[1] === "tag") {
      const tag = value.replace(/^#/, "").toLowerCase();
      const n = binds.length;
      conditions.push(`path IN (SELECT src FROM tags WHERE tag = ?${n + 1} OR substr(tag, 1, ?${n + 2}) = ?${n + 3})`);
      binds.push(tag, tag.length + 1, tag + "/");
    } else if (m[1] === "path") {
      conditions.push(`lower(path) LIKE ?${binds.length + 1} ESCAPE '\\'`);
      binds.push(like(value));
    } else {
      const word = m[3] ?? m[4];
      words.push(word);
      // 暗号化されたノートは本文では検索しない（暗号文に一致してしまうため）
      const w = binds.length + 1, marker = binds.length + 2;
      conditions.push(`(lower(path) LIKE ?${w} ESCAPE '\\' OR (instr(content, ?${marker}) != 1 AND lower(content) LIKE ?${w} ESCAPE '\\'))`);
      binds.push(like(word), ENCRYPTED_MARKER);
    }
  }
  if (!conditions.length) return json({ results: [], words: [] });
  const { results } = await env.DB.prepare(
    `SELECT path, content, updated_at FROM notes WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT 200`,
  ).bind(...binds).all<Note>();

  // ファイル名に含まれる語ほど上位にする。同点なら新しい順
  const lower = words.map((w) => w.toLowerCase());
  const scored = results.map((n) => {
    const name = basename(n.path).toLowerCase();
    const content = isEncrypted(n.content) ? "" : n.content;
    const text = content.toLowerCase();
    let score = 0;
    for (const w of lower) {
      if (name.includes(w)) score += 100;
      else if (n.path.toLowerCase().includes(w)) score += 30;
      score += Math.min(text.split(w).length - 1, 20);
    }
    const first = lower.length ? Math.min(...lower.map((w) => text.indexOf(w)).filter((i) => i >= 0), Infinity) : Infinity;
    const at = Number.isFinite(first) ? Math.max(0, first - 40) : 0;
    const snippet = isEncrypted(n.content) ? "（暗号化されたノート）" : content.slice(at, at + 160).replace(/\s+/g, " ");
    return { path: n.path, updated_at: n.updated_at, score, snippet };
  });
  scored.sort((a, b) => b.score - a.score || b.updated_at - a.updated_at);
  return json({ results: scored.slice(0, 50), words });
}

// ---------------- 取り込み ----------------

// Obsidian の Vault などからまとめて取り込む。画面側で zip を展開し、何回かに分けて送る
async function importNotes(req: Request, env: Env): Promise<Response> {
  const { notes, overwrite } = await body<{ notes: { path: string; content: string }[]; overwrite?: boolean }>(req);
  if (!Array.isArray(notes)) throw new HttpError(400, "notes must be an array");
  if (notes.length > settings(env).MAX_NOTES_PER_BULK_OPERATION) throw tooMany(env);
  const created: string[] = [], overwritten: string[] = [], skipped: string[] = [];
  const errors: { path: string; error: string }[] = [];
  const statements: D1PreparedStatement[] = [];
  const now = Date.now();
  for (const n of notes) {
    let path: string;
    try {
      path = checkPath(n?.path);
      checkContent(env, n.content);
    } catch (e) {
      errors.push({ path: String(n?.path), error: (e as Error).message });
      continue;
    }
    const existing = await getNote(env, path);
    if (existing) {
      if (!overwrite || existing.content === n.content) { skipped.push(path); continue; }
      statements.push(...revisionStatements(env, path, existing.content, "import", existing.updated_at));
      overwritten.push(path);
    } else created.push(path);
    statements.push(upsertStatement(env, path, n.content, now), ...indexStatements(env, path, n.content));
  }
  if (statements.length) await env.DB.batch(statements);
  return json({ created, overwritten, skipped, errors });
}

// ---------------- 共通 ----------------

async function getNote(env: Env, path: string): Promise<Note | null> {
  return env.DB.prepare("SELECT path, content, updated_at FROM notes WHERE path = ?").bind(path).first<Note>();
}

function upsertStatement(env: Env, path: string, content: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO notes (path, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT (path) DO UPDATE SET content = ?2, updated_at = ?3`,
  ).bind(path, content, now);
}

// 削除したノートはゴミ箱（reason = 'delete' の版）から復元できる
function deleteStatements(env: Env, note: Note): D1PreparedStatement[] {
  return [
    ...revisionStatements(env, note.path, note.content, "delete", note.updated_at),
    env.DB.prepare("DELETE FROM notes WHERE path = ?").bind(note.path),
    env.DB.prepare("DELETE FROM links WHERE src = ?").bind(note.path),
    env.DB.prepare("DELETE FROM tags WHERE src = ?").bind(note.path),
  ];
}

export function revisionStatements(env: Env, path: string, content: string, reason: Reason, savedAt: number): D1PreparedStatement[] {
  return [
    env.DB.prepare("INSERT INTO note_revisions (path, content, reason, saved_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(path, content, reason, savedAt, Date.now()),
    env.DB.prepare(
      "DELETE FROM note_revisions WHERE path = ?1 AND id NOT IN (SELECT id FROM note_revisions WHERE path = ?1 ORDER BY id DESC LIMIT ?2)",
    ).bind(path, settings(env).MAX_REVISIONS_PER_NOTE),
  ];
}

// バックリンク・グラフ用のリンクと、タグを本文から作り直す
function indexStatements(env: Env, path: string, content: string): D1PreparedStatement[] {
  const s = settings(env);
  return [
    env.DB.prepare("DELETE FROM links WHERE src = ?").bind(path),
    ...[...extractLinks(content)].slice(0, s.MAX_LINKS_PER_NOTE)
      .map((dst) => env.DB.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)").bind(path, dst)),
    env.DB.prepare("DELETE FROM tags WHERE src = ?").bind(path),
    ...[...extractTags(content)].slice(0, s.MAX_TAGS_PER_NOTE)
      .map((tag) => env.DB.prepare("INSERT OR IGNORE INTO tags (src, tag) VALUES (?, ?)").bind(path, tag)),
  ];
}

function checkContent(env: Env, content: unknown): asserts content is string {
  if (typeof content !== "string") throw new HttpError(400, "content must be a string");
  if (content.length > settings(env).MAX_NOTE_CHARS) throw new HttpError(413, "ノートが大きすぎます");
}

const tooMany = (env: Env) => new HttpError(413, `一度に扱えるノートは ${settings(env).MAX_NOTES_PER_BULK_OPERATION} 件までです`);

// パスの各部分が空・"."・".." でなく、使えない文字を含まないこと
function validSegments(path: string): boolean {
  return !path.startsWith("/") && !/[\\:*?"<>|\x00-\x1f]/.test(path) && path.split("/").every((seg) => seg && seg !== "." && seg !== ".." && seg.trim() === seg);
}

export function checkPath(p: unknown): string {
  if (typeof p !== "string") throw new HttpError(400, "path is required");
  const path = p.normalize("NFC").trim();
  if (!(path.length > 3 && path.length <= 512 && path.endsWith(".md") && validSegments(path))) throw new HttpError(400, `不正なパス: ${path}`);
  return path;
}

export function checkFolderPath(p: unknown): string {
  if (typeof p !== "string") throw new HttpError(400, "path is required");
  const path = p.normalize("NFC").trim().replace(/\/+$/, "");
  if (!(path.length > 0 && path.length <= 400 && validSegments(path) && !path.startsWith("_mdvault"))) throw new HttpError(400, `不正なフォルダ名: ${path}`);
  return path;
}

import {
  DAY, HttpError, body, getCookie, json, randomHex, setCookie, settings, sha256, timingSafeEqual, type Device, type Env,
} from "./common";
import { currentSession, handlePasskeyApi, passkeyCount } from "./passkey";

const COOKIE = "mdv_device";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, url, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleApi(req: Request, url: URL, env: Env): Promise<Response> {
  // CSRF 対策: 状態を変えるリクエストにはカスタムヘッダを必須にする（SameSite=Strict と併用）
  if (req.method !== "GET" && req.headers.get("x-mdv") !== "1") throw new HttpError(403, "missing header");

  const device = await currentDevice(req, env);
  const route = `${req.method} ${url.pathname}`;

  // ---- 未承認でも使えるエンドポイント ----
  switch (route) {
    case "GET /api/device": {
      const s = settings(env);
      const client = {
        autosave_delay_ms: s.AUTOSAVE_DELAY_MS,
        approval_poll_seconds: s.APPROVAL_POLL_SECONDS,
        revision_interval_minutes: s.REVISION_INTERVAL_MINUTES,
      };
      if (device?.status === "approved") {
        // auth: ok = ログイン済み / login = パスキーでログインが必要 / setup = 最初のパスキーを登録する
        const auth = (await currentSession(req, env, device)) ? "ok" : (await passkeyCount(env)) === 0 ? "setup" : "login";
        return json({ status: "approved", id: device.id, name: device.name, auth, settings: client });
      }
      const bootstrap_available = (await approvedCount(env)) === 0;
      return json(
        device
          ? { status: device.status, id: device.id, name: device.name, pair_code: device.pair_code, bootstrap_available, settings: client }
          : { status: "none", bootstrap_available, settings: client },
      );
    }
    case "POST /api/device/register":
      return registerDevice(req, env);
    case "POST /api/device/bootstrap":
      return bootstrap(req, env, device);
  }

  if (!device || device.status !== "approved") throw new HttpError(401, "device not approved");

  // ---- 承認済みデバイス: パスキーの登録・ログイン ----
  const session = await currentSession(req, env, device);
  const passkeyResponse = await handlePasskeyApi(route, req, url, env, device, session);
  if (passkeyResponse) return passkeyResponse;

  if (!session) throw new HttpError(401, "login required");

  // ---- 承認済みデバイス + パスキーでログイン済み ----
  switch (route) {
    case "GET /api/devices": {
      await pruneStaleDevices(env);
      const { results } = await env.DB.prepare(
        "SELECT id, name, user_agent, status, pair_code, created_at, last_seen_at FROM devices ORDER BY status DESC, created_at",
      ).all();
      return json({ devices: results, current: device.id });
    }
    case "POST /api/devices/approve": {
      const { id, pair_code } = await body<{ id: string; pair_code: string }>(req);
      const r = await env.DB.prepare(
        "UPDATE devices SET status = 'approved', pair_code = NULL WHERE id = ? AND status = 'pending' AND pair_code = ?",
      ).bind(id, pair_code).run();
      if (!r.meta.changes) throw new HttpError(400, "ペアリングコードが一致しません");
      return json({ ok: true });
    }
    case "DELETE /api/devices": {
      const id = url.searchParams.get("id") ?? "";
      await env.DB.batch([
        env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(id),
      ]);
      return json({ ok: true });
    }

    case "GET /api/notes": {
      const { results } = await env.DB.prepare("SELECT path, updated_at FROM notes ORDER BY path").all();
      return json({ notes: results });
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
      const note = await env.DB.prepare("SELECT content, updated_at FROM notes WHERE path = ?").bind(path).first<{ content: string; updated_at: number }>();
      if (!note) throw new HttpError(404, "not found");
      // 削除したノートはゴミ箱（reason = 'delete' の版）から復元できる
      await env.DB.batch([
        ...revisionStatements(env, path, note.content, "delete", note.updated_at),
        env.DB.prepare("DELETE FROM notes WHERE path = ?").bind(path),
        env.DB.prepare("DELETE FROM links WHERE src = ?").bind(path),
      ]);
      return json({ ok: true });
    }
    case "POST /api/note/rename":
      return renameNote(req, env);
    case "POST /api/note/restore":
      return restoreRevision(req, env);
    case "GET /api/revisions": {
      const path = checkPath(url.searchParams.get("path"));
      const { results } = await env.DB.prepare(
        "SELECT id, reason, saved_at, created_at, length(content) AS size FROM note_revisions WHERE path = ? ORDER BY id DESC",
      ).bind(path).all();
      return json({ revisions: results });
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
    case "GET /api/backlinks": {
      const path = checkPath(url.searchParams.get("path"));
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT src AS path FROM links WHERE dst IN (?, ?) AND src != ? ORDER BY src",
      ).bind(linkKey(path), linkKey(basename(path)), path).all();
      return json({ backlinks: results });
    }
    case "GET /api/search": {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return json({ results: [] });
      const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      const { results } = await env.DB.prepare(
        `SELECT path, substr(content, max(instr(lower(content), lower(?1)) - 40, 1), 120) AS snippet
           FROM notes WHERE path LIKE ?2 ESCAPE '\\' OR content LIKE ?2 ESCAPE '\\'
           ORDER BY updated_at DESC LIMIT 50`,
      ).bind(q, like).all();
      return json({ results });
    }
  }
  throw new HttpError(404, "no such endpoint");
}

// ---------------- デバイス認証 ----------------

async function currentDevice(req: Request, env: Env): Promise<Device | null> {
  const token = getCookie(req, COOKIE);
  if (!token) return null;
  const device = await env.DB.prepare(
    "SELECT id, name, status, pair_code, last_seen_at FROM devices WHERE token_hash = ?",
  ).bind(await sha256(token)).first<Device>();
  if (device?.status === "approved" && Date.now() - device.last_seen_at > settings(env).DEVICE_TTL_DAYS * DAY) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(device.id),
      env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(device.id),
    ]);
    return null;
  }
  if (device && Date.now() - device.last_seen_at > 5 * 60 * 1000) {
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), device.id).run();
  }
  return device;
}

async function registerDevice(req: Request, env: Env): Promise<Response> {
  const { name } = await body<{ name?: string }>(req);
  const s = settings(env);
  const now = Date.now();
  await env.DB.prepare("DELETE FROM devices WHERE status = 'pending' AND created_at < ?").bind(now - s.PENDING_DEVICE_TTL_HOURS * 60 * 60 * 1000).run();
  const pending = await env.DB.prepare("SELECT count(*) AS n FROM devices WHERE status = 'pending'").first<number>("n");
  if ((pending ?? 0) >= s.MAX_PENDING_DEVICES) throw new HttpError(429, "承認待ちのデバイスが多すぎます");

  const token = randomHex(32);
  const id = crypto.randomUUID();
  const pairCode = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await env.DB.prepare(
    "INSERT INTO devices (id, token_hash, name, user_agent, status, pair_code, created_at, last_seen_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
  ).bind(id, await sha256(token), (name || "名称未設定").slice(0, 64), req.headers.get("user-agent")?.slice(0, 256) ?? null, pairCode, now, now).run();

  return json({ status: "pending", id, pair_code: pairCode }, 200, { "set-cookie": setCookie(req, env, COOKIE, token) });
}

async function pruneStaleDevices(env: Env): Promise<void> {
  const cutoff = Date.now() - settings(env).DEVICE_TTL_DAYS * DAY;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE device_id IN (SELECT id FROM devices WHERE status = 'approved' AND last_seen_at < ?)").bind(cutoff),
    env.DB.prepare("DELETE FROM devices WHERE status = 'approved' AND last_seen_at < ?").bind(cutoff),
  ]);
}

async function approvedCount(env: Env): Promise<number> {
  await pruneStaleDevices(env);
  return (await env.DB.prepare("SELECT count(*) AS n FROM devices WHERE status = 'approved'").first<number>("n")) ?? 0;
}

// 最初の1台（または全デバイスを失ったとき）用: シークレットで自分自身を承認する。
// 承認済みデバイスが1台でもあれば使えないので、シークレットが漏れても入られない。
async function bootstrap(req: Request, env: Env, device: Device | null): Promise<Response> {
  if (!device) throw new HttpError(400, "先にデバイスを登録してください");
  if ((await approvedCount(env)) > 0) throw new HttpError(403, "承認済みのデバイスがあるため使えません。承認済みデバイスから承認してください");
  if (!env.BOOTSTRAP_SECRET || env.BOOTSTRAP_SECRET.length < 16) throw new HttpError(500, "BOOTSTRAP_SECRET が未設定か短すぎます");

  const hourAgo = Date.now() - 60 * 60 * 1000;
  await env.DB.prepare("DELETE FROM auth_failures WHERE ts < ?").bind(hourAgo).run();
  const failures = await env.DB.prepare("SELECT count(*) AS n FROM auth_failures").first<number>("n");
  if ((failures ?? 0) >= settings(env).BOOTSTRAP_MAX_FAILURES_PER_HOUR) throw new HttpError(429, "失敗が多すぎます。1時間後に再試行してください");

  const { secret } = await body<{ secret?: string }>(req);
  if (!(await timingSafeEqual(secret ?? "", env.BOOTSTRAP_SECRET))) {
    await env.DB.prepare("INSERT INTO auth_failures (ts) VALUES (?)").bind(Date.now()).run();
    throw new HttpError(403, "シークレットが違います");
  }
  await env.DB.prepare("UPDATE devices SET status = 'approved', pair_code = NULL WHERE id = ?").bind(device.id).run();
  return json({ ok: true });
}

// ---------------- ノート ----------------

async function saveNote(req: Request, env: Env): Promise<Response> {
  const { path: rawPath, content, base_updated_at } = await body<{ path: string; content: string; base_updated_at?: number | null }>(req);
  const path = checkPath(rawPath);
  if (typeof content !== "string") throw new HttpError(400, "content must be a string");
  const s = settings(env);
  if (content.length > s.MAX_NOTE_CHARS) throw new HttpError(413, "ノートが大きすぎます");

  const existing = await env.DB.prepare("SELECT content, updated_at FROM notes WHERE path = ?").bind(path)
    .first<{ content: string; updated_at: number }>();
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
  await env.DB.batch([
    ...revisions,
    env.DB.prepare(
      `INSERT INTO notes (path, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (path) DO UPDATE SET content = ?2, updated_at = ?3`,
    ).bind(path, content, now),
    ...linkStatements(env, path, content),
  ]);
  return json({ path, updated_at: now });
}

async function renameNote(req: Request, env: Env): Promise<Response> {
  const { from: rawFrom, to: rawTo } = await body<{ from: string; to: string }>(req);
  const from = checkPath(rawFrom);
  const to = checkPath(rawTo);
  if (from === to) return json({ path: to });
  if (await env.DB.prepare("SELECT 1 FROM notes WHERE path = ?").bind(to).first()) throw new HttpError(409, "同名のノートが既にあります");
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE notes SET path = ?, updated_at = ? WHERE path = ?").bind(to, Date.now(), from),
    env.DB.prepare("UPDATE links SET src = ? WHERE src = ?").bind(to, from),
    env.DB.prepare("UPDATE note_revisions SET path = ? WHERE path = ?").bind(to, from),
  ]);
  if (!r[0].meta.changes) throw new HttpError(404, "not found");
  return json({ path: to });
}

// 過去の版（またはゴミ箱のノート）を復元する。復元前の内容も版として残す
async function restoreRevision(req: Request, env: Env): Promise<Response> {
  const { id } = await body<{ id: number }>(req);
  const rev = await env.DB.prepare("SELECT path, content FROM note_revisions WHERE id = ?").bind(id).first<{ path: string; content: string }>();
  if (!rev) throw new HttpError(404, "not found");
  const existing = await env.DB.prepare("SELECT content, updated_at FROM notes WHERE path = ?").bind(rev.path)
    .first<{ content: string; updated_at: number }>();
  const now = Date.now();
  await env.DB.batch([
    ...(existing && existing.content !== rev.content ? revisionStatements(env, rev.path, existing.content, "restore", existing.updated_at) : []),
    env.DB.prepare(
      `INSERT INTO notes (path, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (path) DO UPDATE SET content = ?2, updated_at = ?3`,
    ).bind(rev.path, rev.content, now),
    ...linkStatements(env, rev.path, rev.content),
  ]);
  return json({ path: rev.path, updated_at: now });
}

function revisionStatements(env: Env, path: string, content: string, reason: string, savedAt: number): D1PreparedStatement[] {
  return [
    env.DB.prepare("INSERT INTO note_revisions (path, content, reason, saved_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(path, content, reason, savedAt, Date.now()),
    env.DB.prepare(
      "DELETE FROM note_revisions WHERE path = ?1 AND id NOT IN (SELECT id FROM note_revisions WHERE path = ?1 ORDER BY id DESC LIMIT ?2)",
    ).bind(path, settings(env).MAX_REVISIONS_PER_NOTE),
  ];
}

function linkStatements(env: Env, path: string, content: string): D1PreparedStatement[] {
  const targets = new Set<string>();
  // コードブロック内のリンクは無視
  const text = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of text.matchAll(/!?\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[1].split("|")[0].split("#")[0].trim();
    if (target) targets.add(linkKey(target));
  }
  return [
    env.DB.prepare("DELETE FROM links WHERE src = ?").bind(path),
    ...[...targets].slice(0, settings(env).MAX_LINKS_PER_NOTE).map((dst) => env.DB.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)").bind(path, dst)),
  ];
}

// Obsidian と同様、リンクは大文字小文字を区別せず、".md" は省略可能
const linkKey = (s: string) => s.replace(/\.md$/i, "").toLowerCase();
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function checkPath(p: unknown): string {
  if (typeof p !== "string") throw new HttpError(400, "path is required");
  const path = p.normalize("NFC").trim();
  const ok =
    path.length > 3 &&
    path.length <= 512 &&
    path.endsWith(".md") &&
    !path.startsWith("/") &&
    !/[\\:*?"<>|\x00-\x1f]/.test(path) &&
    path.split("/").every((seg) => seg && seg !== "." && seg !== "..");
  if (!ok) throw new HttpError(400, `不正なパス: ${path}`);
  return path;
}

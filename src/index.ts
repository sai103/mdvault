interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOOTSTRAP_SECRET: string;
}

type Device = {
  id: string;
  name: string;
  status: "pending" | "approved";
  pair_code: string | null;
  last_seen_at: number;
};

const COOKIE = "mdv_device";
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // ブラウザの上限 (400日)
const MAX_PENDING = 10;
const PENDING_TTL = 24 * 60 * 60 * 1000;
const MAX_FAILURES_PER_HOUR = 10;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

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
    case "GET /api/device":
      return json(
        device
          ? { status: device.status, id: device.id, name: device.name, pair_code: device.status === "pending" ? device.pair_code : null }
          : { status: "none" },
      );
    case "POST /api/device/register":
      return registerDevice(req, env);
    case "POST /api/device/bootstrap":
      return bootstrap(req, env, device);
  }

  if (!device || device.status !== "approved") throw new HttpError(401, "device not approved");

  // ---- 承認済みデバイスのみ ----
  switch (route) {
    case "GET /api/devices": {
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
      await env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(id).run();
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
      await env.DB.batch([
        env.DB.prepare("DELETE FROM notes WHERE path = ?").bind(path),
        env.DB.prepare("DELETE FROM links WHERE src = ?").bind(path),
      ]);
      return json({ ok: true });
    }
    case "POST /api/note/rename":
      return renameNote(req, env);
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
  if (device && Date.now() - device.last_seen_at > 5 * 60 * 1000) {
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), device.id).run();
  }
  return device;
}

async function registerDevice(req: Request, env: Env): Promise<Response> {
  const { name } = await body<{ name?: string }>(req);
  const now = Date.now();
  await env.DB.prepare("DELETE FROM devices WHERE status = 'pending' AND created_at < ?").bind(now - PENDING_TTL).run();
  const pending = await env.DB.prepare("SELECT count(*) AS n FROM devices WHERE status = 'pending'").first<number>("n");
  if ((pending ?? 0) >= MAX_PENDING) throw new HttpError(429, "承認待ちのデバイスが多すぎます");

  const token = randomHex(32);
  const id = crypto.randomUUID();
  const pairCode = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await env.DB.prepare(
    "INSERT INTO devices (id, token_hash, name, user_agent, status, pair_code, created_at, last_seen_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
  ).bind(id, await sha256(token), (name || "名称未設定").slice(0, 64), req.headers.get("user-agent")?.slice(0, 256) ?? null, pairCode, now, now).run();

  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return json({ status: "pending", id, pair_code: pairCode }, 200, {
    "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${secure}`,
  });
}

// 最初の1台（または全デバイスを失ったとき）用: シークレットで自分自身を承認する
async function bootstrap(req: Request, env: Env, device: Device | null): Promise<Response> {
  if (!device) throw new HttpError(400, "先にデバイスを登録してください");
  if (!env.BOOTSTRAP_SECRET || env.BOOTSTRAP_SECRET.length < 16) throw new HttpError(500, "BOOTSTRAP_SECRET が未設定か短すぎます");

  const hourAgo = Date.now() - 60 * 60 * 1000;
  await env.DB.prepare("DELETE FROM auth_failures WHERE ts < ?").bind(hourAgo).run();
  const failures = await env.DB.prepare("SELECT count(*) AS n FROM auth_failures").first<number>("n");
  if ((failures ?? 0) >= MAX_FAILURES_PER_HOUR) throw new HttpError(429, "失敗が多すぎます。1時間後に再試行してください");

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
  if (content.length > 1_000_000) throw new HttpError(413, "ノートが大きすぎます");

  const existing = await env.DB.prepare("SELECT updated_at FROM notes WHERE path = ?").bind(path).first<number>("updated_at");
  // 楽観的ロック: 他のデバイスで先に更新されていたら上書きしない
  if (base_updated_at !== undefined && (existing ?? null) !== base_updated_at) {
    throw new HttpError(409, "他のデバイスで更新されています");
  }

  const now = Date.now();
  await env.DB.batch([
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
  ]);
  if (!r[0].meta.changes) throw new HttpError(404, "not found");
  return json({ path: to });
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
    ...[...targets].slice(0, 500).map((dst) => env.DB.prepare("INSERT OR IGNORE INTO links (src, dst) VALUES (?, ?)").bind(path, dst)),
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

// ---------------- ユーティリティ ----------------

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  // 長さの違いを漏らさないよう、ハッシュ同士を比較する
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

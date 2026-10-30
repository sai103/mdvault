import {
  DAY, HttpError, body, getCookie, json, randomHex, setCookie, settings, sha256, textSetting, timingSafeEqual, type Device, type Env,
} from "./common";
import { currentSession, handlePasskeyApi, passkeyCount, requireRecentAuth } from "./passkey";
import { handleAttachmentApi } from "./attachments";
import { createBackup, handleBackupApi, pruneBackups } from "./backup";
import { handleNotesApi } from "./notes";

const COOKIE = "mdv_device";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, url, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },

  // 毎日の自動バックアップ（wrangler.jsonc の triggers.crons）
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(createBackup(env).then(() => pruneBackups(env)));
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
        max_attachment_mb: s.MAX_ATTACHMENT_MB,
        image_max_dimension: s.IMAGE_MAX_DIMENSION,
        image_quality_percent: s.IMAGE_QUALITY_PERCENT,
        encryption_pbkdf2_iterations: s.ENCRYPTION_PBKDF2_ITERATIONS,
        max_notes_per_bulk_operation: s.MAX_NOTES_PER_BULK_OPERATION,
        attachment_folder: textSetting(env, "ATTACHMENT_FOLDER"),
        daily_note_folder: textSetting(env, "DAILY_NOTE_FOLDER"),
        template_folder: textSetting(env, "TEMPLATE_FOLDER"),
        daily_note_template: textSetting(env, "DAILY_NOTE_TEMPLATE"),
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

  const response = (await handleAttachmentApi(route, req, url, env)) ?? (await handleNotesApi(route, req, url, env)) ??
    (await handleBackupApi(route, url, env));
  if (response) return response;

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
      requireRecentAuth(env, session);
      const { id, pair_code } = await body<{ id: string; pair_code: string }>(req);
      // 期限切れ（PENDING_DEVICE_TTL_HOURS を過ぎた）承認待ちデバイスは承認できない
      const r = await env.DB.prepare(
        "UPDATE devices SET status = 'approved', pair_code = NULL WHERE id = ? AND status = 'pending' AND pair_code = ? AND created_at >= ?",
      ).bind(id, pair_code, Date.now() - settings(env).PENDING_DEVICE_TTL_HOURS * 60 * 60 * 1000).run();
      if (!r.meta.changes) throw new HttpError(400, "ペアリングコードが一致しません");
      return json({ ok: true });
    }
    case "DELETE /api/devices": {
      requireRecentAuth(env, session);
      const id = url.searchParams.get("id") ?? "";
      await env.DB.batch([
        env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(id),
      ]);
      return json({ ok: true });
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
  // 「承認済みが 0 台」の確認と承認を 1 つの SQL で行い、同時に 2 台がブートストラップしても 1 台しか通らないようにする
  const r = await env.DB.prepare(
    "UPDATE devices SET status = 'approved', pair_code = NULL WHERE id = ? AND NOT EXISTS (SELECT 1 FROM devices WHERE status = 'approved')",
  ).bind(device.id).run();
  if (!r.meta.changes) throw new HttpError(403, "承認済みのデバイスがあるため使えません。承認済みデバイスから承認してください");
  return json({ ok: true });
}

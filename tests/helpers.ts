import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";

// 本番と同じく HTTPS の URL で呼ぶ（Cookie は __Host- 付きになる）
export const BASE = "https://mdvault.example.com";

// テストで使う利用者の状態。権限表（docs/security.md）の「主体」と同じ
export type Role = "anonymous" | "pending" | "approved" | "loggedIn";
export const ROLES: Role[] = ["anonymous", "pending", "approved", "loggedIn"];

const TOKENS = {
  pending: { device: "pending-device-token" },
  approved: { device: "approved-device-token" },
  loggedIn: { device: "login-device-token", session: "login-session-token" },
} as const;

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TABLES = ["notes", "links", "note_revisions", "devices", "auth_failures", "passkeys", "sessions", "webauthn_challenges", "attachments"];

// 全テーブルを空にして、各ロールのデバイス・パスキー・セッションを作る
export async function seed(): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    ...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare("INSERT INTO devices (id, token_hash, name, status, pair_code, created_at, last_seen_at) VALUES (?, ?, 'pending', 'pending', '123456', ?, ?)")
      .bind("dev-pending", await sha256(TOKENS.pending.device), now, now),
    env.DB.prepare("INSERT INTO devices (id, token_hash, name, status, created_at, last_seen_at) VALUES (?, ?, 'approved', 'approved', ?, ?)")
      .bind("dev-approved", await sha256(TOKENS.approved.device), now, now),
    env.DB.prepare("INSERT INTO devices (id, token_hash, name, status, created_at, last_seen_at) VALUES (?, ?, 'login', 'approved', ?, ?)")
      .bind("dev-login", await sha256(TOKENS.loggedIn.device), now, now),
    env.DB.prepare("INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES ('pk-1', 'AA', 0, '[]', 'key 1', ?)").bind(now),
    env.DB.prepare("INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES ('pk-2', 'AA', 0, '[]', 'key 2', ?)").bind(now),
    env.DB.prepare("INSERT INTO sessions (token_hash, device_id, passkey_id, created_at, expires_at, verified_at) VALUES (?, 'dev-login', 'pk-1', ?, ?, ?)")
      .bind(await sha256(TOKENS.loggedIn.session), now, now + 86_400_000, now),
  ]);
}

export function cookieFor(role: Role): string {
  if (role === "anonymous") return "";
  const t = TOKENS[role];
  return [`__Host-mdv_device=${t.device}`, "session" in t ? `__Host-mdv_session=${t.session}` : ""].filter(Boolean).join("; ");
}

type Options = { body?: unknown; raw?: BodyInit; headers?: Record<string, string>; csrfHeader?: boolean };

export async function call(role: Role, method: string, path: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const cookie = cookieFor(role);
  if (cookie) headers.cookie = cookie;
  if (method !== "GET" && opts.csrfHeader !== false) headers["x-mdv"] = "1";
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(new Request(BASE + path, {
    method,
    headers,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  }));
}

// 1x1 の PNG
export const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
export const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

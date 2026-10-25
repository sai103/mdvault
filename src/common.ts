// 設定値はすべて wrangler.jsonc の vars で定義する
const SETTING_KEYS = [
  "DEVICE_TTL_DAYS",
  "COOKIE_MAX_AGE_DAYS",
  "MAX_PENDING_DEVICES",
  "PENDING_DEVICE_TTL_HOURS",
  "BOOTSTRAP_MAX_FAILURES_PER_HOUR",
  "APPROVAL_POLL_SECONDS",
  "SESSION_IDLE_TIMEOUT_DAYS",
  "SESSION_ABSOLUTE_TIMEOUT_DAYS",
  "REAUTH_WINDOW_MINUTES",
  "PASSKEY_CHALLENGE_TTL_SECONDS",
  "AUTOSAVE_DELAY_MS",
  "MAX_NOTE_CHARS",
  "MAX_LINKS_PER_NOTE",
  "REVISION_INTERVAL_MINUTES",
  "MAX_REVISIONS_PER_NOTE",
  "MAX_ATTACHMENT_MB",
] as const;
export type Settings = Record<(typeof SETTING_KEYS)[number], number>;
// 文字列の設定値
const TEXT_SETTING_KEYS = ["ATTACHMENT_FOLDER"] as const;
type TextSettingKey = (typeof TEXT_SETTING_KEYS)[number];

export interface Env extends Partial<Record<keyof Settings | TextSettingKey, unknown>> {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  BOOTSTRAP_SECRET: string;
}

export type Device = {
  id: string;
  name: string;
  status: "pending" | "approved";
  pair_code: string | null;
  last_seen_at: number;
};

export const DAY = 24 * 60 * 60 * 1000;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000",
};

export class HttpError extends Error {
  // code は画面側で処理を分けたいエラーにだけ付ける（例: reauth_required）
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers },
  });

export function settings(env: Env): Settings {
  const s = {} as Settings;
  for (const key of SETTING_KEYS) {
    const v = Number(env[key]);
    if (env[key] === undefined || env[key] === "" || !Number.isFinite(v) || v <= 0) {
      throw new HttpError(500, `wrangler.jsonc の vars.${key} が未設定か不正です`);
    }
    s[key] = v;
  }
  return s;
}

export function textSetting(env: Env, key: TextSettingKey): string {
  const v = env[key];
  if (typeof v !== "string" || !v.trim()) throw new HttpError(500, `wrangler.jsonc の vars.${key} が未設定か不正です`);
  return v.trim();
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

// HTTPS では __Host- を付ける（Secure・Path=/・Domain なしが強制され、他のサブドメインから Cookie を上書きされない）
const cookieName = (req: Request, name: string) => (new URL(req.url).protocol === "https:" ? `__Host-${name}` : name);

export function getCookie(req: Request, baseName: string): string | null {
  const name = cookieName(req, baseName);
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// 有効期限はサーバー側で管理するので、Cookie 自体は長めに持たせる（maxAgeSeconds = 0 で削除）
export function setCookie(req: Request, env: Env, baseName: string, value: string, maxAgeSeconds?: number): string {
  const maxAge = maxAgeSeconds ?? Math.round(settings(env).COOKIE_MAX_AGE_DAYS * DAY / 1000);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName(req, baseName)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  // 長さの違いを漏らさないよう、ハッシュ同士を比較する
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

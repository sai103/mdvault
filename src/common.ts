// 設定値はすべて wrangler.jsonc の vars で定義する
const SETTING_KEYS = [
  "DEVICE_TTL_DAYS",
  "COOKIE_MAX_AGE_DAYS",
  "MAX_PENDING_DEVICES",
  "PENDING_DEVICE_TTL_HOURS",
  "BOOTSTRAP_MAX_FAILURES_PER_HOUR",
  "APPROVAL_POLL_SECONDS",
  "SESSION_IDLE_TIMEOUT_DAYS",
  "PASSKEY_CHALLENGE_TTL_SECONDS",
  "AUTOSAVE_DELAY_MS",
  "MAX_NOTE_CHARS",
  "MAX_LINKS_PER_NOTE",
  "REVISION_INTERVAL_MINUTES",
  "MAX_REVISIONS_PER_NOTE",
] as const;
export type Settings = Record<(typeof SETTING_KEYS)[number], number>;

export interface Env extends Partial<Record<keyof Settings, unknown>> {
  DB: D1Database;
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
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
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

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// 有効期限はサーバー側で管理するので、Cookie 自体は長めに持たせる（maxAgeSeconds = 0 で削除）
export function setCookie(req: Request, env: Env, name: string, value: string, maxAgeSeconds?: number): string {
  const maxAge = maxAgeSeconds ?? Math.round(settings(env).COOKIE_MAX_AGE_DAYS * DAY / 1000);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
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

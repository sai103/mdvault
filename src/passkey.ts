import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import { DAY, HttpError, body, getCookie, json, randomHex, setCookie, settings, sha256, type Device, type Env } from "./common";

const SESSION_COOKIE = "mdv_session";
const RP_NAME = "mdvault";
// 個人用なのでユーザーは 1 人。同じ認証器に同じユーザーのパスキーが重複して作られないよう固定値にする
const USER_ID = isoUint8Array.fromUTF8String("mdvault-owner");

type Passkey = { id: string; public_key: string; counter: number; transports: string | null };
export type Session = { token_hash: string; passkey_id: string; verified_at: number };

// ---------------- セッション ----------------

// パスキーでログインしたセッション。デバイスに紐づき、パスキーが削除されると無効になる。
// 操作がなければ SESSION_IDLE_TIMEOUT_DAYS、使い続けていても SESSION_ABSOLUTE_TIMEOUT_DAYS で切れる
export async function currentSession(req: Request, env: Env, device: Device): Promise<Session | null> {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const now = Date.now();
  const session = await env.DB.prepare(
    `SELECT s.token_hash, s.passkey_id, s.verified_at, s.expires_at FROM sessions s JOIN passkeys p ON p.id = s.passkey_id
      WHERE s.token_hash = ? AND s.device_id = ? AND s.expires_at > ? AND s.created_at > ?`,
  ).bind(await sha256(token), device.id, now, now - settings(env).SESSION_ABSOLUTE_TIMEOUT_DAYS * DAY)
    .first<Session & { expires_at: number }>();
  if (!session) return null;
  // 使っている間は期限を延長する（一定期間操作がなければ再ログイン）
  const ttl = settings(env).SESSION_IDLE_TIMEOUT_DAYS * DAY;
  if (session.expires_at - now < ttl / 2) {
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(now + ttl, session.token_hash).run();
  }
  return session;
}

// ログインのたびに新しいトークンを発行し、それまでのセッションは消す（セッション固定攻撃の対策）
async function createSession(req: Request, env: Env, device: Device, passkeyId: string, previous: Session | null): Promise<string> {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR token_hash = ?").bind(now, previous?.token_hash ?? ""),
    env.DB.prepare("INSERT INTO sessions (token_hash, device_id, passkey_id, created_at, expires_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256(token), device.id, passkeyId, now, now + settings(env).SESSION_IDLE_TIMEOUT_DAYS * DAY, now),
  ]);
  return setCookie(req, env, SESSION_COOKIE, token);
}

// デバイスの承認・削除、パスキーの追加・削除の前に呼ぶ。セッションを盗まれても、これらの操作で居座られないようにする
export function requireRecentAuth(env: Env, session: Session): void {
  if (Date.now() - session.verified_at > settings(env).REAUTH_WINDOW_MINUTES * 60 * 1000) {
    throw new HttpError(403, "この操作の前に、パスキーで本人確認してください", "reauth_required");
  }
}

export async function passkeyCount(env: Env): Promise<number> {
  return (await env.DB.prepare("SELECT count(*) AS n FROM passkeys").first<number>("n")) ?? 0;
}

// ---------------- API ----------------

// 承認済みデバイスから呼ばれる。パスキー関連のルートでなければ null を返す
export async function handlePasskeyApi(
  route: string, req: Request, url: URL, env: Env, device: Device, session: Session | null,
): Promise<Response | null> {
  // RP ID はアクセスしているホスト名（workers.dev のサブドメインや独自ドメイン）
  const rp = { rpID: url.hostname, origin: url.origin };

  switch (route) {
    // パスキーの登録: ログイン中、またはパスキーがまだ 1 つもないとき（初回・リセット後）だけ
    case "POST /api/passkey/register/options": {
      await requireSessionOrNoPasskeys(env, session);
      const { results } = await env.DB.prepare("SELECT id, transports FROM passkeys").all<Pick<Passkey, "id" | "transports">>();
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rp.rpID,
        userID: USER_ID,
        userName: RP_NAME,
        attestationType: "none",
        excludeCredentials: results.map((p) => ({ id: p.id, transports: parseTransports(p.transports) })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
      await saveChallenge(env, device, "register", options.challenge);
      return json(options);
    }
    case "POST /api/passkey/register/verify": {
      await requireSessionOrNoPasskeys(env, session);
      const { response, name } = await body<{ response: RegistrationResponseJSON; name?: string }>(req);
      const expectedChallenge = await takeChallenge(env, device, "register");
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      }).catch((e: Error) => {
        throw new HttpError(400, `パスキーを検証できません: ${e.message}`);
      });
      if (!result.verified) throw new HttpError(400, "パスキーを検証できません");
      const { credential } = result.registrationInfo;
      await env.DB.prepare(
        "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        credential.id,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        (name || "パスキー").slice(0, 64),
        Date.now(),
      ).run();
      // 初回登録ならそのままログイン状態にする
      return json({ ok: true }, 200, session ? {} : { "set-cookie": await createSession(req, env, device, credential.id, null) });
    }

    case "POST /api/passkey/login/options": {
      const { results } = await env.DB.prepare("SELECT id, transports FROM passkeys").all<Pick<Passkey, "id" | "transports">>();
      if (!results.length) throw new HttpError(400, "パスキーが登録されていません");
      const options = await generateAuthenticationOptions({
        rpID: rp.rpID,
        allowCredentials: results.map((p) => ({ id: p.id, transports: parseTransports(p.transports) })),
        userVerification: "required",
      });
      await saveChallenge(env, device, "login", options.challenge);
      return json(options);
    }
    case "POST /api/passkey/login/verify": {
      const { response } = await body<{ response: AuthenticationResponseJSON }>(req);
      const expectedChallenge = await takeChallenge(env, device, "login");
      const passkey = await env.DB.prepare("SELECT id, public_key, counter, transports FROM passkeys WHERE id = ?")
        .bind(response?.id ?? "").first<Passkey>();
      if (!passkey) throw new HttpError(400, "このパスキーは登録されていません");
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: isoBase64URL.toBuffer(passkey.public_key),
          counter: passkey.counter,
          transports: parseTransports(passkey.transports),
        },
      }).catch((e: Error) => {
        throw new HttpError(400, `パスキーを検証できません: ${e.message}`);
      });
      if (!result.verified) throw new HttpError(400, "パスキーを検証できません");
      await env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
        .bind(result.authenticationInfo.newCounter, Date.now(), passkey.id).run();
      return json({ ok: true }, 200, { "set-cookie": await createSession(req, env, device, passkey.id, session) });
    }

    case "POST /api/logout": {
      if (session) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.token_hash).run();
      return json({ ok: true }, 200, { "set-cookie": setCookie(req, env, SESSION_COOKIE, "", 0) });
    }
  }

  // ---- ここから先はログイン中のみ ----
  if (!session) return null;
  switch (route) {
    case "GET /api/passkeys": {
      const { results } = await env.DB.prepare("SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at").all();
      return json({ passkeys: results, current: session.passkey_id });
    }
    case "DELETE /api/passkeys": {
      requireRecentAuth(env, session);
      // 最後の 1 つを消すと、承認済みデバイスなら誰でも新しいパスキーを登録できてしまうので禁止
      if ((await passkeyCount(env)) <= 1) throw new HttpError(409, "最後のパスキーは削除できません");
      const id = url.searchParams.get("id") ?? "";
      await env.DB.batch([
        env.DB.prepare("DELETE FROM passkeys WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM sessions WHERE passkey_id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }
  return null;
}

// 最初のパスキーは承認済みデバイスなら登録できる。2 つ目以降はログイン中かつ最近本人確認したときだけ
async function requireSessionOrNoPasskeys(env: Env, session: Session | null): Promise<void> {
  if (session) return requireRecentAuth(env, session);
  if ((await passkeyCount(env)) > 0) throw new HttpError(401, "パスキーでログインしてください");
}

async function saveChallenge(env: Env, device: Device, kind: "register" | "login", challenge: string): Promise<void> {
  const expiresAt = Date.now() + settings(env).PASSKEY_CHALLENGE_TTL_SECONDS * 1000;
  await env.DB.prepare("INSERT OR REPLACE INTO webauthn_challenges (device_id, kind, challenge, expires_at) VALUES (?, ?, ?, ?)")
    .bind(device.id, kind, challenge, expiresAt).run();
}

// チャレンジは使い捨て（検証の成否にかかわらず削除する）
async function takeChallenge(env: Env, device: Device, kind: "register" | "login"): Promise<string> {
  const row = await env.DB.prepare(
    "DELETE FROM webauthn_challenges WHERE device_id = ? AND kind = ? RETURNING challenge, expires_at",
  ).bind(device.id, kind).first<{ challenge: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) throw new HttpError(400, "チャレンジの有効期限が切れました。もう一度やり直してください");
  return row.challenge;
}

function parseTransports(s: string | null): AuthenticatorTransportFuture[] | undefined {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}

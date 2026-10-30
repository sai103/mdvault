// サーバーとのやり取り
import { clearOfflineData } from "./pwa.js";

// サーバー（wrangler.jsonc の vars）から受け取る設定。GET /api/device で入る
export const settings = {};

let reauth = null;
// 本人確認（パスキー）を求められたときの処理。auth.js が登録する
export const setReauthHandler = (fn) => { reauth = fn; };

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(method, path, body, retried = false) {
  const res = await fetch(path, {
    method,
    headers: { "x-mdv": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // ログインが切れた・デバイスが削除された: 端末に残したノートのキャッシュを消してから最初の画面へ
    if (res.status === 401) {
      await clearOfflineData();
      location.reload();
    }
    // デバイスの承認やパスキーの追加などの前は、パスキーでの本人確認を求められる
    if (data.code === "reauth_required" && !retried && reauth) {
      await reauth();
      return api(method, path, body, true);
    }
    throw new ApiError(data.error || res.statusText, res.status, data.code);
  }
  return data;
}

// 画像など JSON でない本文を送る
export async function upload(path, blob, contentType) {
  const res = await fetch(path, { method: "POST", headers: { "x-mdv": "1", "content-type": contentType }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || res.statusText, res.status, data.code);
  return data;
}

// fetch がネットワークに届かなかったか（オフライン）
export const isNetworkError = (e) => e instanceof TypeError || (e instanceof ApiError && e.status === 503 && e.code === "offline");

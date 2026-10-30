// ノート単位の暗号化。ブラウザの中だけで暗号化・復号し、サーバーには暗号文だけを送る
// 形式: 1 行目に目印（Obsidian のコメント記法）、2 行目に JSON（すべて base64）
import { settings } from "./api.js";

export const MARKER = "%%mdvault-encrypted v1%%";
export const isEncrypted = (content) => content.startsWith(MARKER);

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// パスフレーズから AES-GCM の鍵を作る（PBKDF2-SHA256。回数が多いほど総当たりに強いが、開くのに時間がかかる）
export async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// 新しく暗号化を始めるときの鍵（ノートごとに別の salt）
export async function newKey(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = settings.encryption_pbkdf2_iterations;
  return { key: await deriveKey(passphrase, salt, iterations), salt, iterations };
}

// 保存のたびに新しい IV で暗号化する（鍵は使い回す）
export async function encrypt(text, { key, salt, iterations }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  const payload = { v: 1, kdf: "PBKDF2-SHA256", iter: iterations, salt: b64(salt), iv: b64(iv), data: b64(data) };
  return `${MARKER}\n${JSON.stringify(payload)}\n%%このノートは mdvault で暗号化されています。パスフレーズがないと読めません%%\n`;
}

export function parse(content) {
  const line = content.slice(MARKER.length).trimStart().split("\n")[0];
  const p = JSON.parse(line);
  if (p.v !== 1) throw new Error("対応していない形式です");
  return { salt: unb64(p.salt), iv: unb64(p.iv), data: unb64(p.data), iterations: p.iter };
}

// 復号して、本文と鍵（次の保存で使う）を返す。パスフレーズが違えば例外
export async function decrypt(content, passphrase) {
  const { salt, iv, data, iterations } = parse(content);
  const key = await deriveKey(passphrase, salt, iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return { text: dec.decode(plain), crypto: { key, salt, iterations } };
  } catch {
    throw new Error("パスフレーズが違います");
  }
}

// このタブを開いている間だけ覚えておくパスフレーズ（保存はしない）。別のノートを開くときに再入力を省く
let remembered = null;
export const rememberPassphrase = (p) => { remembered = p; };
export const rememberedPassphrase = () => remembered;
export const forgetPassphrase = () => { remembered = null; };

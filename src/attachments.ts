import { HttpError, json, settings, textSetting, type Env } from "./common";

// 受け付ける画像形式。ファイル名や Content-Type ではなく、先頭のバイト列で判定する
// （SVG はスクリプトを含められるので受け付けない）
const IMAGE_TYPES: { type: string; ext: string; exts: string[]; match: (b: Uint8Array) => boolean }[] = [
  { type: "image/png", ext: "png", exts: ["png"], match: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: "image/jpeg", ext: "jpg", exts: ["jpg", "jpeg"], match: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { type: "image/gif", ext: "gif", exts: ["gif"], match: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a" },
  { type: "image/webp", ext: "webp", exts: ["webp"], match: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  { type: "image/avif", ext: "avif", exts: ["avif"], match: (b) => ascii(b, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(b, 8, 12)) },
];

type Attachment = { path: string; content_type: string; size: number; created_at: number };

// ログイン中のみ呼ばれる。添付ファイルのルートでなければ null を返す
export async function handleAttachmentApi(route: string, req: Request, url: URL, env: Env): Promise<Response | null> {
  switch (route) {
    case "GET /api/attachments": {
      const { results } = await env.DB.prepare("SELECT path, content_type, size, created_at FROM attachments ORDER BY created_at DESC")
        .all<Attachment>();
      if (url.searchParams.get("refs") !== "1" || !results.length) return json({ attachments: results });
      // 何個のノートから参照されているか（ファイル名が本文に含まれるかで判定）
      const counts = await env.DB.batch(results.map((a) =>
        env.DB.prepare("SELECT count(*) AS n FROM notes WHERE instr(content, ?) > 0").bind(basename(a.path))));
      return json({ attachments: results.map((a, i) => ({ ...a, refs: (counts[i].results[0] as { n: number }).n })) });
    }
    case "POST /api/attachments":
      return upload(req, url, env);
    case "DELETE /api/attachments": {
      const path = url.searchParams.get("path") ?? "";
      const r = await env.DB.prepare("DELETE FROM attachments WHERE path = ?").bind(path).run();
      if (!r.meta.changes) throw new HttpError(404, "not found");
      await env.FILES.delete(path);
      return json({ ok: true });
    }
    case "GET /api/attachment": {
      const path = url.searchParams.get("path") ?? "";
      const object = await env.FILES.get(path, { onlyIf: req.headers });
      if (!object) throw new HttpError(404, "not found");
      const headers = new Headers({
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
        // 画面側は URL にアップロード日時（v=）を付けるので、同じ URL の中身は変わらない
        "cache-control": "private, max-age=31536000, immutable",
        etag: object.httpEtag,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      });
      // If-None-Match が一致した場合は本文なし（304）
      if (!("body" in object)) return new Response(null, { status: 304, headers });
      return new Response(object.body, { headers });
    }
  }
  return null;
}

async function upload(req: Request, url: URL, env: Env): Promise<Response> {
  const maxBytes = settings(env).MAX_ATTACHMENT_MB * 1024 * 1024;
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge(env);
  const data = new Uint8Array(await req.arrayBuffer());
  if (data.byteLength > maxBytes) throw tooLarge(env);
  if (!data.byteLength) throw new HttpError(400, "ファイルが空です");

  const image = IMAGE_TYPES.find((t) => t.match(data));
  if (!image) throw new HttpError(415, "対応していない形式です（PNG / JPEG / GIF / WebP / AVIF のみ）");

  const path = await uniquePath(env, textSetting(env, "ATTACHMENT_FOLDER"), fileName(url.searchParams.get("name"), image));
  await env.FILES.put(path, data, { httpMetadata: { contentType: image.type } });
  try {
    await env.DB.prepare("INSERT INTO attachments (path, content_type, size, created_at) VALUES (?, ?, ?, ?)")
      .bind(path, image.type, data.byteLength, Date.now()).run();
  } catch (e) {
    await env.FILES.delete(path); // メタデータを書けなかったら本体も消す
    throw e;
  }
  return json({ path, content_type: image.type, size: data.byteLength });
}

// 元のファイル名を安全な形にする。名前がない（クリップボードからの貼り付けなど）ときは Obsidian と同じ形式にする
function fileName(raw: string | null, image: (typeof IMAGE_TYPES)[number]): string {
  let name = basename((raw ?? "").normalize("NFC")).replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
  if (!name || /^image\.\w+$/i.test(name)) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    name = `Pasted image ${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  }
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (image.exts.includes(ext)) return `${name.slice(0, dot).slice(0, 100)}.${ext}`;
  // 拡張子を実際の形式に合わせる（別の画像形式の拡張子なら付け替え、それ以外なら後ろに付ける）
  const stem = IMAGE_TYPES.some((t) => t.exts.includes(ext)) ? name.slice(0, dot) : name;
  return `${stem.slice(0, 100)}.${image.ext}`;
}

// 同名があれば "名前 1.png", "名前 2.png" … にする
async function uniquePath(env: Env, folder: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, dot);
  const ext = name.slice(dot);
  const prefix = `${folder.replace(/^\/+|\/+$/g, "")}/${stem}`;
  const { results } = await env.DB.prepare("SELECT path FROM attachments WHERE substr(path, 1, ?) = ?")
    .bind(prefix.length, prefix).all<{ path: string }>();
  const taken = new Set(results.map((r) => r.path));
  for (let i = 0; ; i++) {
    const path = `${prefix}${i ? ` ${i}` : ""}${ext}`;
    if (!taken.has(path)) return path;
  }
}

const tooLarge = (env: Env) => new HttpError(413, `ファイルが大きすぎます（上限 ${settings(env).MAX_ATTACHMENT_MB}MB）`);
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

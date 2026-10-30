import { DAY, HttpError, json, settings, type Env } from "./common";

// 自動バックアップは画像と同じ R2 バケットの、この下に置く（画像の API からは読み書きできない）
export const SYSTEM_PREFIX = "_mdvault/";
const PREFIX = `${SYSTEM_PREFIX}backups/`;
const KEY = /^_mdvault\/backups\/\d{4}-\d{2}-\d{2}\.json\.gz$/;

// 全ノート（暗号化されたものは暗号文のまま）・フォルダ・画像の一覧を gzip した JSON にして保存する。同じ日に複数回実行したら上書き
export async function createBackup(env: Env, now = new Date()): Promise<{ key: string; size: number; notes: number }> {
  const [notes, folders, attachments] = await env.DB.batch([
    env.DB.prepare("SELECT path, content, created_at, updated_at FROM notes ORDER BY path"),
    env.DB.prepare("SELECT path FROM folders ORDER BY path"),
    env.DB.prepare("SELECT path, content_type, size, created_at FROM attachments ORDER BY path"),
  ]);
  const data = JSON.stringify({
    version: 1,
    created_at: now.getTime(),
    notes: notes.results,
    folders: (folders.results as { path: string }[]).map((f) => f.path),
    attachments: attachments.results,
  });
  const gz = await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const key = `${PREFIX}${now.toISOString().slice(0, 10)}.json.gz`;
  await env.FILES.put(key, gz, { httpMetadata: { contentType: "application/gzip" } });
  return { key, size: gz.byteLength, notes: notes.results.length };
}

// BACKUP_RETENTION_DAYS より古いバックアップを消す（ファイル名の日付で判断）
export async function pruneBackups(env: Env, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - settings(env).BACKUP_RETENTION_DAYS * DAY).toISOString().slice(0, 10);
  const old = (await listBackups(env)).filter((b) => b.date < cutoff).map((b) => b.key);
  if (old.length) await env.FILES.delete(old);
  return old.length;
}

async function listBackups(env: Env): Promise<{ key: string; date: string; size: number }[]> {
  const items: { key: string; date: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: PREFIX, cursor });
    for (const o of page.objects) if (KEY.test(o.key)) items.push({ key: o.key, date: o.key.slice(PREFIX.length, PREFIX.length + 10), size: o.size });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return items.sort((a, b) => b.date.localeCompare(a.date));
}

// ログイン中のみ呼ばれる
export async function handleBackupApi(route: string, url: URL, env: Env): Promise<Response | null> {
  switch (route) {
    case "GET /api/backups":
      return json({ backups: await listBackups(env), retention_days: settings(env).BACKUP_RETENTION_DAYS });
    case "POST /api/backups":
      return json(await createBackup(env));
    case "GET /api/backup": {
      // 中身は gzip のまま返す（展開は画面側で行う）
      const key = url.searchParams.get("key") ?? "";
      if (!KEY.test(key)) throw new HttpError(400, "不正なバックアップ名です");
      const object = await env.FILES.get(key);
      if (!object) throw new HttpError(404, "not found");
      return new Response(object.body, {
        headers: {
          "content-type": "application/gzip",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    }
  }
  return null;
}

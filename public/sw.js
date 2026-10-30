// mdvault の Service Worker: オフラインでもアプリを開き、一度開いたノートを読めるようにする
// - 画面のファイル: ネットワーク優先（更新をすぐ反映）、つながらなければキャッシュ
// - ノートなどの読み取り API: ネットワーク優先、つながらなければ最後に取得した内容
// - 画像: URL に日時が付いていて中身が変わらないので、キャッシュ優先
// - 書き込み（GET 以外）はキャッシュしない
const SHELL = "mdvault-shell-v1";
const DATA = "mdvault-data-v1";
const SHELL_FILES = ["/", "/style.css", "/editor.css", "/build/app.js", "/manifest.webmanifest", "/icons/icon-192.png"];
const CACHED_API = /^\/api\/(device|notes|note|attachments|tags|links|backlinks)$/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== DATA) await caches.delete(key);
    await self.clients.claim();
  })());
});

// ログアウト時などに、端末に残したノートのキャッシュを消す
self.addEventListener("message", (e) => {
  if (e.data === "clear-data") e.waitUntil(caches.delete(DATA).then(() => e.source?.postMessage("data-cleared")));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    throw new Error("offline");
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname === "/api/attachment") {
    e.respondWith(caches.open(DATA).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (CACHED_API.test(url.pathname)) {
    e.respondWith(networkFirst(req, DATA).catch(() => new Response(JSON.stringify({ error: "オフラインです", code: "offline" }), {
      status: 503, headers: { "content-type": "application/json" },
    })));
    return;
  }
  if (url.pathname.startsWith("/api/")) return;
  // 画面のファイル。ページの移動（/#/ノート など）はすべて index.html
  const shellReq = req.mode === "navigate" ? new Request("/") : req;
  e.respondWith(networkFirst(shellReq, SHELL));
});

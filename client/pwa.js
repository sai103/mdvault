// PWA（ホーム画面に追加・オフラインでの閲覧）
import { $ } from "./util.js";

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("Service Worker を登録できません", e));
}

// 端末に残したノート・画像のキャッシュを消す（ログアウト時、ログインが切れたとき）
export async function clearOfflineData() {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("mdvault-data")).map((k) => caches.delete(k)));
  } catch {}
}

// オフラインの表示。navigator.onLine だけでは分からないこと（つながっていても届かない）があるので、
// 保存に失敗したときにも表示する
export function setOffline(on) {
  document.body.classList.toggle("offline", on);
  $("#offline-banner").hidden = !on;
}

export function watchOnline(onBackOnline) {
  const update = () => {
    setOffline(!navigator.onLine);
    if (navigator.onLine) onBackOnline();
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

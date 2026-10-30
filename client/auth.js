// デバイス承認・パスキー・デバイス管理
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, setReauthHandler, settings } from "./api.js";
import { forgetPassphrase } from "./crypto.js";
import { clearOfflineData } from "./pwa.js";
import { $, el, fmtTime, store } from "./util.js";

// パスキーの作成・署名はブラウザ（OS）の画面で行い、結果をサーバーで検証する
export async function registerPasskey(name) {
  const optionsJSON = await api("POST", "/api/passkey/register/options");
  const response = await startRegistration({ optionsJSON }).catch(passkeyError);
  await api("POST", "/api/passkey/register/verify", { response, name });
}

export async function loginWithPasskey() {
  const optionsJSON = await api("POST", "/api/passkey/login/options");
  const response = await startAuthentication({ optionsJSON }).catch(passkeyError);
  await api("POST", "/api/passkey/login/verify", { response });
}
setReauthHandler(loginWithPasskey);

function passkeyError(e) {
  if (e.name === "NotAllowedError") throw new Error("キャンセルされたか、時間切れになりました");
  if (e.name === "InvalidStateError") throw new Error("この認証器には既にパスキーが登録されています");
  throw e;
}

// パスキーはドメイン名に結びつき、HTTPS か localhost でしか使えない
function passkeyEnvironmentProblem() {
  if (/^(\d+\.){3}\d+$|^\[[0-9a-f:.]+\]$/i.test(location.hostname)) {
    return `IP アドレス（${location.hostname}）ではパスキーを使えません。この PC で開発しているなら http://localhost${location.port ? ":" + location.port : ""} で開いてください`;
  }
  if (!window.isSecureContext) return "パスキーは HTTPS か localhost でしか使えません";
  if (!browserSupportsWebAuthn()) return "このブラウザはパスキーに対応していません";
  return "";
}

export function guessDeviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return `${os} ${br}`.trim();
}

// ---------------- 最初の画面（デバイス登録・承認待ち・パスキー） ----------------

let pollTimer = 0;
let onLoggedIn = () => {};

/** ログイン済みなら true。そうでなければ最初の画面を表示して false */
export async function checkLogin() {
  clearTimeout(pollTimer);
  const dev = await api("GET", "/api/device");
  Object.assign(settings, dev.settings);
  if (dev.status === "approved" && dev.auth === "ok") return true;
  $("#gate").hidden = false;
  $("#gate-none").hidden = dev.status !== "none";
  $("#gate-pending").hidden = dev.status !== "pending";
  $("#gate-passkey-setup").hidden = dev.auth !== "setup";
  $("#gate-passkey-login").hidden = dev.auth !== "login";
  // 登録の前から出しておく（承認まで進んでからパスキーで失敗しないように）
  const problem = passkeyEnvironmentProblem();
  if (problem) $("#gate-error").textContent = problem;
  if (dev.status === "pending") {
    $("#pair-code").textContent = dev.pair_code;
    $("#bootstrap-section").hidden = !dev.bootstrap_available;
    // 他デバイスでの承認を待つ。別の画面に進んだら（checkLogin がもう一度呼ばれたら）止める
    pollTimer = setTimeout(async () => {
      if (await checkLogin()) { $("#gate").hidden = true; onLoggedIn(); }
    }, settings.approval_poll_seconds * 1000);
  }
  return false;
}

export function setupGate(handler) {
  onLoggedIn = handler;
  const action = async (fn) => {
    $("#gate-error").textContent = "";
    try {
      await fn();
      $("#gate").hidden = true;
      if (await checkLogin()) onLoggedIn();
    } catch (e) {
      $("#gate-error").textContent = e.message;
    }
  };
  $("#device-name").value = guessDeviceName();
  $("#passkey-setup-name").value = guessDeviceName();
  $("#register-btn").onclick = () => action(() => api("POST", "/api/device/register", { name: $("#device-name").value }));
  $("#bootstrap-btn").onclick = () => action(() => api("POST", "/api/device/bootstrap", { secret: $("#secret").value }));
  $("#passkey-setup-btn").onclick = () => action(() => registerPasskey($("#passkey-setup-name").value));
  $("#passkey-login-btn").onclick = () => action(loginWithPasskey);
}

// ---------------- デバイスとパスキー ----------------

export async function openDevices() {
  const { devices, current } = await api("GET", "/api/devices");
  $("#device-list").replaceChildren(...devices.map((d) => {
    const actions = el("td");
    if (d.status === "pending") {
      const input = el("input", { placeholder: "6桁コード", inputMode: "numeric", maxLength: 6, className: "code" });
      actions.append(input, el("button", {
        textContent: "承認", className: "primary",
        onclick: () => api("POST", "/api/devices/approve", { id: d.id, pair_code: input.value.trim() }).then(openDevices, (e) => alert(e.message)),
      }));
    }
    actions.append(el("button", {
      textContent: d.status === "pending" ? "拒否" : "削除", className: "danger",
      onclick: async () => {
        const msg = d.id === current ? "このデバイスを削除すると、再承認するまでアクセスできなくなります。よろしいですか？" : `「${d.name}」を削除しますか？`;
        if (!confirm(msg)) return;
        await api("DELETE", "/api/devices?id=" + encodeURIComponent(d.id)).catch((e) => alert(e.message));
        d.id === current ? location.reload() : openDevices();
      },
    }));
    return el("tr", {},
      el("td", { textContent: d.name + (d.id === current ? "（このデバイス）" : ""), title: d.user_agent ?? "" }),
      el("td", { textContent: d.status === "approved" ? "承認済み" : "承認待ち" }),
      el("td", { textContent: fmtTime(d.last_seen_at) }),
      actions);
  }));
  await renderPasskeys();
  if (!$("#devices").open) $("#devices").showModal();
}

async function renderPasskeys() {
  const { passkeys, current } = await api("GET", "/api/passkeys");
  $("#passkey-list").replaceChildren(...passkeys.map((p) => el("tr", {},
    el("td", { textContent: p.name + (p.id === current ? "（ログイン中）" : "") }),
    el("td", { textContent: fmtTime(p.created_at) }),
    el("td", { textContent: p.last_used_at ? fmtTime(p.last_used_at) : "-" }),
    el("td", {}, el("button", {
      textContent: "削除", className: "danger", disabled: passkeys.length <= 1,
      title: passkeys.length <= 1 ? "最後のパスキーは削除できません" : "",
      onclick: async () => {
        const msg = p.id === current ? "ログイン中のパスキーです。削除するとログアウトします。よろしいですか？" : `「${p.name}」を削除しますか？`;
        if (!confirm(msg)) return;
        await api("DELETE", "/api/passkeys?id=" + encodeURIComponent(p.id)).catch((e) => alert(e.message));
        p.id === current ? location.reload() : renderPasskeys();
      },
    })))));
}

export function setupDevices(flushSave) {
  $("#open-devices").onclick = () => openDevices().catch((e) => alert(e.message));
  $("#add-passkey").onclick = async () => {
    const name = prompt("パスキーの名前", guessDeviceName());
    if (name === null) return;
    try {
      await flushSave();
      await registerPasskey(name);
      await renderPasskeys();
    } catch (e) {
      alert(e.message);
    }
  };
  $("#logout").onclick = async () => {
    const drafts = store.keys("draft:");
    if (drafts.length && !confirm(`まだ保存できていない変更が ${drafts.length} 件あります。ログアウトすると失われます。続けますか？`)) return;
    await flushSave().catch(() => {});
    await api("POST", "/api/logout");
    // この端末に残したノートのキャッシュ・下書き・パスフレーズを消す
    await clearOfflineData();
    for (const k of drafts) store.remove(k);
    forgetPassphrase();
    location.reload();
  };
}

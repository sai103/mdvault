// 認可マトリクスのテスト。docs/security.md の「権限表」と対応させること
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PNG, ROLES, call, seed, sha256, type Role } from "./helpers";

beforeEach(seed);

// 必要な権限: public = 誰でも / device = 承認済みデバイス / session = 承認済みデバイス + パスキーでログイン中
type Level = "public" | "device" | "session";
const allowed: Record<Level, Role[]> = {
  public: ["anonymous", "pending", "approved", "loggedIn"],
  device: ["approved", "loggedIn"],
  session: ["loggedIn"],
};

const ENDPOINTS: [Level, string, string, { body?: unknown; raw?: BodyInit; headers?: Record<string, string> }?][] = [
  ["public", "GET", "/api/device"],
  ["public", "POST", "/api/device/register", { body: { name: "x" } }],
  ["device", "POST", "/api/passkey/login/options"],
  ["device", "POST", "/api/passkey/login/verify", { body: { response: { id: "x" } } }],
  ["device", "POST", "/api/logout"],
  ["session", "GET", "/api/notes"],
  ["session", "GET", "/api/note?path=a.md"],
  ["session", "PUT", "/api/note", { body: { path: "a.md", content: "x" } }],
  ["session", "DELETE", "/api/note?path=a.md"],
  ["session", "POST", "/api/note/rename", { body: { from: "a.md", to: "b.md" } }],
  ["session", "POST", "/api/note/restore", { body: { id: 1 } }],
  ["session", "GET", "/api/revisions?path=a.md"],
  ["session", "GET", "/api/revision?id=1"],
  ["session", "GET", "/api/trash"],
  ["session", "GET", "/api/backlinks?path=a.md"],
  ["session", "GET", "/api/search?q=x"],
  ["session", "GET", "/api/devices"],
  ["session", "POST", "/api/devices/approve", { body: { id: "dev-pending", pair_code: "000000" } }],
  ["session", "DELETE", "/api/devices?id=none"],
  ["session", "GET", "/api/passkeys"],
  ["session", "DELETE", "/api/passkeys?id=none"],
  ["session", "GET", "/api/attachments"],
  ["session", "POST", "/api/attachments?name=a.png", { raw: PNG, headers: { "content-type": "image/png" } }],
  ["session", "DELETE", "/api/attachments?path=none"],
  ["session", "GET", "/api/attachment?path=none"],
];

describe("認可マトリクス", () => {
  for (const [level, method, path, opts] of ENDPOINTS) {
    for (const role of ROLES) {
      const ok = allowed[level].includes(role);
      it(`${method} ${path} — ${role} は${ok ? "通る" : "401"}`, async () => {
        const res = await call(role, method, path, opts);
        if (ok) expect([401, 403]).not.toContain(res.status);
        else expect(res.status).toBe(401);
      });
    }
  }

  it("パスキーがあるとき、ログインしていない承認済みデバイスはパスキーを登録できない", async () => {
    expect((await call("approved", "POST", "/api/passkey/register/options")).status).toBe(401);
    expect((await call("loggedIn", "POST", "/api/passkey/register/options")).status).toBe(200);
  });

  it("パスキーが 0 個なら、承認済みデバイスは最初のパスキーを登録できる", async () => {
    await env.DB.exec("DELETE FROM passkeys");
    expect((await call("approved", "POST", "/api/passkey/register/options")).status).toBe(200);
  });

  it("未知のエンドポイントは未ログインでは 401、ログイン中は 404", async () => {
    expect((await call("anonymous", "GET", "/api/unknown")).status).toBe(401);
    expect((await call("loggedIn", "GET", "/api/unknown")).status).toBe(404);
  });
});

describe("CSRF 対策", () => {
  for (const [, method, path, opts] of ENDPOINTS.filter(([, m]) => m !== "GET")) {
    it(`${method} ${path} は x-mdv ヘッダーなしだと 403`, async () => {
      const res = await call("loggedIn", method, path, { ...opts, csrfHeader: false });
      expect(res.status).toBe(403);
    });
  }
});

describe("本人確認のし直し（reauth）", () => {
  const SENSITIVE: [string, string, { body?: unknown }?][] = [
    ["POST", "/api/devices/approve", { body: { id: "dev-pending", pair_code: "123456" } }],
    ["DELETE", "/api/devices?id=dev-approved"],
    ["DELETE", "/api/passkeys?id=pk-2"],
    ["POST", "/api/passkey/register/options"],
  ];
  for (const [method, path, opts] of SENSITIVE) {
    it(`${method} ${path} は最後の本人確認から時間がたつと reauth_required`, async () => {
      await env.DB.exec("UPDATE sessions SET verified_at = 0");
      const res = await call("loggedIn", method, path, opts);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "reauth_required" });
    });
    it(`${method} ${path} は本人確認の直後なら通る`, async () => {
      expect((await call("loggedIn", method, path, opts)).status).toBe(200);
    });
  }
});

describe("セッション", () => {
  it("期限（操作なし）を過ぎたセッションは無効", async () => {
    await env.DB.exec("UPDATE sessions SET expires_at = 1");
    expect((await call("loggedIn", "GET", "/api/notes")).status).toBe(401);
  });

  it("使い続けていても、絶対期限を過ぎたセッションは無効", async () => {
    await env.DB.exec("UPDATE sessions SET created_at = 1");
    expect((await call("loggedIn", "GET", "/api/notes")).status).toBe(401);
  });

  it("ログインに使ったパスキーを削除するとセッションは無効", async () => {
    await env.DB.exec("DELETE FROM passkeys WHERE id = 'pk-1'");
    expect((await call("loggedIn", "GET", "/api/notes")).status).toBe(401);
  });

  it("別のデバイスのセッション Cookie は使えない", async () => {
    const res = await call("approved", "GET", "/api/notes", { headers: { cookie: "__Host-mdv_device=approved-device-token; __Host-mdv_session=login-session-token" } });
    expect(res.status).toBe(401);
  });

  it("デバイスを削除すると、そのデバイスのセッションも消える", async () => {
    await call("loggedIn", "DELETE", "/api/devices?id=dev-login");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sessions").first("n")).toBe(0);
  });

  it("ログアウトでセッションが消え、Cookie も削除される", async () => {
    const res = await call("loggedIn", "POST", "/api/logout");
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-mdv_session=; .*Max-Age=0/);
    expect((await call("loggedIn", "GET", "/api/notes")).status).toBe(401);
  });

  it("長期間使われていない承認済みデバイスは未登録扱い", async () => {
    await env.DB.exec("UPDATE devices SET last_seen_at = 1 WHERE id = 'dev-login'");
    expect(await (await call("loggedIn", "GET", "/api/device")).json()).toMatchObject({ status: "none" });
  });
});

describe("デバイス登録・承認", () => {
  it("Cookie は __Host- 付き・HttpOnly・Secure・SameSite=Strict", async () => {
    const cookie = (await call("anonymous", "POST", "/api/device/register", { body: { name: "x" } })).headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-mdv_device=[0-9a-f]{64}; Path=\//);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("サーバーにはトークンのハッシュだけを保存する", async () => {
    const cookie = (await call("anonymous", "POST", "/api/device/register", { body: { name: "hash" } })).headers.get("set-cookie") ?? "";
    const token = /mdv_device=([0-9a-f]+)/.exec(cookie)![1];
    const row = await env.DB.prepare("SELECT token_hash FROM devices WHERE name = 'hash'").first<string>("token_hash");
    expect(row).toBe(await sha256(token));
    expect(row).not.toBe(token);
  });

  it("承認待ちの数には上限がある", async () => {
    const max = Number(env.MAX_PENDING_DEVICES);
    for (let i = 1; i < max; i++) await call("anonymous", "POST", "/api/device/register", { body: { name: `p${i}` } });
    expect((await call("anonymous", "POST", "/api/device/register", { body: { name: "over" } })).status).toBe(429);
  });

  it("ペアリングコードが違うと承認できない", async () => {
    const res = await call("loggedIn", "POST", "/api/devices/approve", { body: { id: "dev-pending", pair_code: "000000" } });
    expect(res.status).toBe(400);
  });

  it("期限切れの承認待ちデバイスは承認できない", async () => {
    await env.DB.exec("UPDATE devices SET created_at = 1 WHERE id = 'dev-pending'");
    const res = await call("loggedIn", "POST", "/api/devices/approve", { body: { id: "dev-pending", pair_code: "123456" } });
    expect(res.status).toBe(400);
  });
});

describe("ブートストラップ", () => {
  const SECRET = "test-bootstrap-secret-0123456789";

  it("承認済みデバイスがあれば、正しいシークレットでも使えない", async () => {
    const res = await call("pending", "POST", "/api/device/bootstrap", { body: { secret: SECRET } });
    expect(res.status).toBe(403);
  });

  it("承認済みデバイスが 0 台なら使え、2 台目は通らない", async () => {
    await env.DB.exec("DELETE FROM devices WHERE status = 'approved'");
    expect((await call("pending", "POST", "/api/device/bootstrap", { body: { secret: SECRET } })).status).toBe(200);
    const cookie = (await call("anonymous", "POST", "/api/device/register", { body: { name: "second" } })).headers.get("set-cookie") ?? "";
    const second = cookie.split(";")[0];
    const res = await call("anonymous", "POST", "/api/device/bootstrap", { body: { secret: SECRET }, headers: { cookie: second } });
    expect(res.status).toBe(403);
  });

  it("失敗が続くとロックされる", async () => {
    await env.DB.exec("DELETE FROM devices WHERE status = 'approved'");
    const max = Number(env.BOOTSTRAP_MAX_FAILURES_PER_HOUR);
    for (let i = 0; i < max; i++) {
      expect((await call("pending", "POST", "/api/device/bootstrap", { body: { secret: "wrong" } })).status).toBe(403);
    }
    expect((await call("pending", "POST", "/api/device/bootstrap", { body: { secret: SECRET } })).status).toBe(429);
  });
});

describe("入力の検証", () => {
  for (const path of ["../a.md", "/a.md", "a.txt", "a/../b.md", "a\\b.md", "a:b.md"]) {
    it(`不正なパス ${path} は 400`, async () => {
      expect((await call("loggedIn", "PUT", "/api/note", { body: { path, content: "x" } })).status).toBe(400);
    });
  }

  it("ノートの最大文字数を超えると 413", async () => {
    const content = "a".repeat(Number(env.MAX_NOTE_CHARS) + 1);
    expect((await call("loggedIn", "PUT", "/api/note", { body: { path: "big.md", content } })).status).toBe(413);
  });

  it("検索語の % や _ はワイルドカードとして扱わない", async () => {
    await call("loggedIn", "PUT", "/api/note", { body: { path: "a.md", content: "abc" } });
    const { results } = await (await call("loggedIn", "GET", "/api/search?q=%25")).json<{ results: unknown[] }>();
    expect(results).toHaveLength(0);
  });

  it("壊れた JSON は 400", async () => {
    expect((await call("loggedIn", "PUT", "/api/note", { raw: "{", headers: { "content-type": "application/json" } })).status).toBe(400);
  });
});

describe("画像のアップロード", () => {
  const upload = (name: string, data: BodyInit, type = "image/png") =>
    call("loggedIn", "POST", "/api/attachments?name=" + encodeURIComponent(name), { raw: data, headers: { "content-type": type } });

  it("SVG は拡張子を偽装しても拒否する", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await upload("evil.png", svg)).status).toBe(415);
  });

  it("形式はファイルの中身で判定し、拡張子を合わせる", async () => {
    const { JPEG_HEAD } = await import("./helpers");
    expect(await (await upload("photo.png", JPEG_HEAD)).json()).toMatchObject({ path: "attachments/photo.jpg", content_type: "image/jpeg" });
  });

  it("ファイル名のパス区切りは取り除く", async () => {
    expect(await (await upload("../../x.png", PNG)).json()).toMatchObject({ path: "attachments/x.png" });
  });

  it("上限サイズを超えると 413", async () => {
    const big = new Uint8Array(Number(env.MAX_ATTACHMENT_MB) * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await upload("big.png", big)).status).toBe(413);
  });

  it("画像のレスポンスには nosniff と sandbox 付き CSP を付ける", async () => {
    const { path } = await (await upload("a.png", PNG)).json<{ path: string }>();
    const res = await call("loggedIn", "GET", "/api/attachment?path=" + encodeURIComponent(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("レスポンスヘッダー", () => {
  it("API のレスポンスにはセキュリティヘッダーとキャッシュ禁止を付ける", async () => {
    const res = await call("anonymous", "GET", "/api/device");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("想定外のエラーでは内部情報を返さない", async () => {
    const res = await call("loggedIn", "POST", "/api/note/restore", { body: { id: "not-a-number' OR 1=1 --" } });
    expect(res.status).toBe(404);
  });

  it("HTTP（ローカル開発）では Cookie に __Host- を付けない", async () => {
    const { exports } = await import("cloudflare:workers");
    const res = await exports.default.fetch(new Request("http://localhost/api/device/register", {
      method: "POST", headers: { "x-mdv": "1", "content-type": "application/json" }, body: "{}",
    }));
    expect(res.headers.get("set-cookie")).toMatch(/^mdv_device=/);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });
});


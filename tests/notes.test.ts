// ノートまわりの機能（リンクの書き換え・フォルダ・タグ・検索・取り込み・バックアップ）のテスト
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { extractLinks, extractTags, rewriteLinks, splitCode } from "../src/markdown";
import { PNG, call, seed } from "./helpers";

beforeEach(seed);

const put = (path: string, content: string) => call("loggedIn", "PUT", "/api/note", { body: { path, content } });
const get = async (path: string) => (await (await call("loggedIn", "GET", "/api/note?path=" + encodeURIComponent(path))).json<{ content: string }>()).content;
const jsonOf = async <T>(res: Response) => (await res.json()) as T;

describe("本文の解析", () => {
  it("コードブロックとインラインコードを分ける", () => {
    const parts = splitCode("a `b` c\n```js\n[[x]]\n```\nd ~~~ e");
    expect(parts.filter((p) => p.code).map((p) => p.text)).toEqual(["`b`", "```js\n[[x]]\n```"]);
  });

  it("リンクはコードの中を無視し、見出し・別名を取り除いて正規化する", () => {
    const links = extractLinks("[[Note]] [[Dir/B#見出し|別名]] ![[img.png]] `[[code]]`\n```\n[[block]]\n```");
    expect([...links].sort()).toEqual(["dir/b", "img.png", "note"]);
  });

  it("タグは本文の #タグ と frontmatter の tags（配列・リスト・空白区切り）", () => {
    expect([...extractTags("---\ntags: [a, \"B\"]\n---\n本文 #c #親/子 #123 x#no `#code`")].sort()).toEqual(["a", "b", "c", "親/子"]);
    expect([...extractTags("---\ntags:\n  - x\n  - y\n---\n")].sort()).toEqual(["x", "y"]);
    expect([...extractTags("---\ntags: p q\n---\n# 見出し は タグではない")].sort()).toEqual(["p", "q"]);
  });

  it("リンクの書き換えは見出し・別名・埋め込みを保ち、コードの中は変えない", () => {
    const out = rewriteLinks("[[A]] [[A#h|x]] ![[A]] `[[A]]` [[B]]", (t) => (t === "A" ? "Z" : null));
    expect(out).toBe("[[Z]] [[Z#h|x]] ![[Z]] `[[A]]` [[B]]");
  });
});

describe("リネームでリンクを書き換える", () => {
  it("ファイル名・フルパス・見出し・別名・埋め込みのリンクを新しい名前にし、元の内容は履歴に残す", async () => {
    await put("B.md", "# B");
    await put("A.md", "[[B]] [[B#h|別名]] ![[B]] [[B.md]] `[[B]]`");
    const res = await jsonOf<{ updated: string[] }>(await call("loggedIn", "POST", "/api/note/rename", { body: { from: "B.md", to: "dir/C.md" } }));
    expect(res.updated).toEqual(["A.md"]);
    expect(await get("A.md")).toBe("[[C]] [[C#h|別名]] ![[C]] [[C.md]] `[[B]]`");
    const { revisions } = await jsonOf<{ revisions: { reason: string }[] }>(await call("loggedIn", "GET", "/api/revisions?path=A.md"));
    expect(revisions.map((r) => r.reason)).toContain("rename");
    const { backlinks } = await jsonOf<{ backlinks: { path: string }[] }>(await call("loggedIn", "GET", "/api/backlinks?path=dir/C.md"));
    expect(backlinks.map((b) => b.path)).toEqual(["A.md"]);
  });

  it("新しいファイル名が他のノートと重複するときはフルパスで書く", async () => {
    await put("a/Same.md", "x");
    await put("c/Other.md", "y");
    await put("Index.md", "[[Other]]");
    await call("loggedIn", "POST", "/api/note/rename", { body: { from: "c/Other.md", to: "c/Same.md" } });
    expect(await get("Index.md")).toBe("[[c/Same]]");
  });

  it("自分自身へのリンクも書き換わる。リンクしていないノートは変えない", async () => {
    await put("Self.md", "[[Self]]");
    await put("Untouched.md", "[[Other]]");
    await call("loggedIn", "POST", "/api/note/rename", { body: { from: "Self.md", to: "Renamed.md" } });
    expect(await get("Renamed.md")).toBe("[[Renamed]]");
    expect(await get("Untouched.md")).toBe("[[Other]]");
  });

  it("移動先に同名のノートがあれば 409", async () => {
    await put("x.md", "1");
    await put("y.md", "2");
    expect((await call("loggedIn", "POST", "/api/note/rename", { body: { from: "x.md", to: "y.md" } })).status).toBe(409);
  });
});

describe("フォルダ", () => {
  it("空のフォルダを作れて、一覧に出る", async () => {
    await call("loggedIn", "POST", "/api/folders", { body: { path: "empty/sub" } });
    expect(await jsonOf<{ folders: string[] }>(await call("loggedIn", "GET", "/api/notes"))).toMatchObject({ folders: ["empty/sub"] });
  });

  it("フォルダの名前変更で中のノート・サブフォルダが移動し、フルパスのリンクが書き換わる", async () => {
    await put("proj/x.md", "x");
    await put("proj/sub/y.md", "[[x]]");
    await put("Other.md", "[[proj/x]] [[proj/sub/y|Y]]");
    await call("loggedIn", "POST", "/api/folders", { body: { path: "proj/empty" } });
    const res = await jsonOf<{ moved: number }>(await call("loggedIn", "POST", "/api/folder/rename", { body: { from: "proj", to: "work" } }));
    expect(res.moved).toBe(2);
    const { notes, folders } = await jsonOf<{ notes: { path: string }[]; folders: string[] }>(await call("loggedIn", "GET", "/api/notes"));
    expect(notes.map((n) => n.path).sort()).toEqual(["Other.md", "work/sub/y.md", "work/x.md"]);
    expect(folders.sort()).toEqual(["work", "work/empty"]);
    expect(await get("Other.md")).toBe("[[work/x]] [[work/sub/y|Y]]");
    expect(await get("work/sub/y.md")).toBe("[[x]]");
  });

  it("自分の中への移動は 400、既にある名前への変更は 409", async () => {
    await put("p/a.md", "a");
    await put("q/b.md", "b");
    expect((await call("loggedIn", "POST", "/api/folder/rename", { body: { from: "p", to: "p/in" } })).status).toBe(400);
    expect((await call("loggedIn", "POST", "/api/folder/rename", { body: { from: "p", to: "q" } })).status).toBe(409);
  });

  it("フォルダを削除すると、中のノートはゴミ箱に入る", async () => {
    await put("trash/a.md", "a");
    await put("trash/b/c.md", "c");
    await put("keep.md", "k");
    expect(await jsonOf(await call("loggedIn", "DELETE", "/api/folder?path=trash"))).toEqual({ deleted: 2 });
    const { trash } = await jsonOf<{ trash: { path: string }[] }>(await call("loggedIn", "GET", "/api/trash"));
    expect(trash.map((t) => t.path).sort()).toEqual(["trash/a.md", "trash/b/c.md"]);
  });

  it("アプリ用の名前（_mdvault）や不正な名前のフォルダは作れない", async () => {
    for (const path of ["_mdvault", "../x", "a//b", "a/ b"]) {
      expect((await call("loggedIn", "POST", "/api/folders", { body: { path } })).status).toBe(400);
    }
  });
});

describe("タグと検索", () => {
  beforeEach(async () => {
    await put("projects/Alpha.md", "---\ntags: [work]\n---\nalpha の設計メモ #design/ui");
    await put("Beta.md", "beta 設計 設計 #design");
    await put("日記.md", "今日は設計をしなかった");
    await put("Secret.md", "%%mdvault-encrypted v1%%\n設計");
  });

  it("タグの一覧と件数", async () => {
    const { tags } = await jsonOf<{ tags: { tag: string; count: number }[] }>(await call("loggedIn", "GET", "/api/tags"));
    expect(tags).toEqual([{ tag: "design", count: 1 }, { tag: "design/ui", count: 1 }, { tag: "work", count: 1 }]);
  });

  const search = async (q: string) =>
    (await jsonOf<{ results: { path: string }[] }>(await call("loggedIn", "GET", "/api/search?q=" + encodeURIComponent(q)))).results.map((r) => r.path);

  it("複数の語はすべて含むものだけ（AND）", async () => {
    expect(await search("設計 alpha")).toEqual(["projects/Alpha.md"]);
  });

  it("tag: は子のタグも含む。path: でパスを絞り込む", async () => {
    expect((await search("tag:design")).sort()).toEqual(["Beta.md", "projects/Alpha.md"]);
    expect(await search("tag:work")).toEqual(["projects/Alpha.md"]);
    expect(await search("設計 path:projects")).toEqual(["projects/Alpha.md"]);
  });

  it("ファイル名に含まれるものを上位にし、暗号化されたノートの本文は検索しない", async () => {
    await put("設計の方針.md", "x");
    const results = await search("設計");
    expect(results[0]).toBe("設計の方針.md");
    expect(results).not.toContain("Secret.md");
  });

  it("ノート一覧で暗号化されたノートがわかる", async () => {
    const { notes } = await jsonOf<{ notes: { path: string; encrypted: boolean }[] }>(await call("loggedIn", "GET", "/api/notes"));
    expect(notes.find((n) => n.path === "Secret.md")?.encrypted).toBe(true);
    expect(notes.find((n) => n.path === "Beta.md")?.encrypted).toBe(false);
  });
});

describe("取り込み・書き出し", () => {
  it("新規は作成、既存はスキップ（overwrite なら上書きして履歴に残す）、不正なパスは報告する", async () => {
    await put("exists.md", "old");
    const first = await jsonOf(await call("loggedIn", "POST", "/api/import/notes", {
      body: { notes: [{ path: "new.md", content: "[[exists]] #tag" }, { path: "exists.md", content: "new" }, { path: "../bad.md", content: "x" }] },
    }));
    expect(first).toMatchObject({ created: ["new.md"], skipped: ["exists.md"], overwritten: [] });
    expect((first as { errors: unknown[] }).errors).toHaveLength(1);
    expect(await get("exists.md")).toBe("old");

    const second = await jsonOf(await call("loggedIn", "POST", "/api/import/notes", { body: { notes: [{ path: "exists.md", content: "new" }], overwrite: true } }));
    expect(second).toMatchObject({ overwritten: ["exists.md"] });
    expect(await get("exists.md")).toBe("new");
    const { revisions } = await jsonOf<{ revisions: { reason: string }[] }>(await call("loggedIn", "GET", "/api/revisions?path=exists.md"));
    expect(revisions[0].reason).toBe("import");
    // 取り込んだノートのリンクとタグも記録される
    const { backlinks } = await jsonOf<{ backlinks: { path: string }[] }>(await call("loggedIn", "GET", "/api/backlinks?path=exists.md"));
    expect(backlinks.map((b) => b.path)).toEqual(["new.md"]);
  });

  it("一度に取り込めるノートの数には上限がある", async () => {
    const notes = Array.from({ length: Number(env.MAX_NOTES_PER_BULK_OPERATION) + 1 }, (_, i) => ({ path: `n${i}.md`, content: "" }));
    expect((await call("loggedIn", "POST", "/api/import/notes", { body: { notes } })).status).toBe(413);
  });

  it("画像は元のパスのまま取り込め、同じパスは 409、アプリ用の領域には置けない", async () => {
    const up = (path: string) => call("loggedIn", "POST", "/api/attachments?path=" + encodeURIComponent(path), { raw: PNG, headers: { "content-type": "image/png" } });
    expect(await jsonOf(await up("assets/pic.png"))).toMatchObject({ path: "assets/pic.png" });
    expect((await up("assets/pic.png")).status).toBe(409);
    expect((await up("_mdvault/backups/x.png")).status).toBe(400);
    expect((await up("../x.png")).status).toBe(400);
    expect((await up("doc.pdf")).status).toBe(400);
  });

  it("書き出しで全ノート・フォルダ・画像の一覧が得られる", async () => {
    await put("a.md", "A");
    await call("loggedIn", "POST", "/api/folders", { body: { path: "empty" } });
    const data = await jsonOf<{ notes: { path: string; content: string }[]; folders: string[] }>(await call("loggedIn", "GET", "/api/export"));
    expect(data.notes).toMatchObject([{ path: "a.md", content: "A" }]);
    expect(data.folders).toEqual(["empty"]);
  });
});

describe("バックアップ", () => {
  const list = async () => (await jsonOf<{ backups: { key: string; date: string }[] }>(await call("loggedIn", "GET", "/api/backups"))).backups;

  it("手動でバックアップを作り、中身（gzip の JSON）を取得できる", async () => {
    await put("a.md", "hello");
    const { key, notes } = await jsonOf<{ key: string; notes: number }>(await call("loggedIn", "POST", "/api/backups"));
    expect(key).toMatch(/^_mdvault\/backups\/\d{4}-\d{2}-\d{2}\.json\.gz$/);
    expect(notes).toBe(1);
    expect((await list()).map((b) => b.key)).toEqual([key]);
    const res = await call("loggedIn", "GET", "/api/backup?key=" + encodeURIComponent(key));
    const text = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(text)).toMatchObject({ version: 1, notes: [{ path: "a.md", content: "hello" }] });
  });

  it("毎日の自動実行（scheduled）で作られ、保持日数より古いものは消える", async () => {
    await env.FILES.put("_mdvault/backups/2000-01-01.json.gz", "old");
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "17 18 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const keys = (await list()).map((b) => b.key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("2000-01-01");
  });

  it("バックアップは画像の API からは読めず、不正な名前は 400", async () => {
    const { key } = await jsonOf<{ key: string }>(await call("loggedIn", "POST", "/api/backups"));
    expect((await call("loggedIn", "GET", "/api/attachment?path=" + encodeURIComponent(key))).status).toBe(404);
    expect((await call("loggedIn", "GET", "/api/backup?key=" + encodeURIComponent("attachments/a.png"))).status).toBe(400);
  });
});

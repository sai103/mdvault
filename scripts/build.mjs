// 画面のコード（client/）とライブラリを public/build/app.js にまとめる（Windows・macOS・Linux 共通）
// --watch を付けると、client/ を変更するたびに作り直す
import * as esbuild from "esbuild";
import { bundledPackages, writeLicenses } from "./licenses.mjs";

const options = {
  entryPoints: ["client/main.js"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  outfile: "public/build/app.js",
  minify: true,
  sourcemap: true,
  // ライブラリのソースにある @license などのコメントは app.js.LEGAL.txt に書き出す
  legalComments: "linked",
  metafile: true,
  logLevel: "info",
};
// Worker（src/）に含まれるライブラリ。wrangler deploy と同じ解決のしかたで、ファイルは書き出さずに調べる
async function workerPackages() {
  const r = await esbuild.build({
    entryPoints: ["src/index.ts"], bundle: true, write: false, metafile: true, logLevel: "silent",
    format: "esm", platform: "neutral", target: ["es2022"], conditions: ["workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"], external: ["cloudflare:*", "node:*"],
  });
  return bundledPackages(r.metafile);
}

// ライブラリのライセンス本文（THIRD_PARTY_LICENSES.txt）も一緒に書き出す。画面の「表示の設定」からリンクしている
const licenses = {
  name: "licenses",
  setup(b) {
    b.onEnd(async (r) => {
      if (!r.metafile) return;
      writeLicenses([
        { title: "画面（ブラウザで動く app.js）", packages: bundledPackages(r.metafile) },
        { title: "サーバー（Cloudflare Workers で動くコード）", packages: await workerPackages() },
      ], "public/build/THIRD_PARTY_LICENSES.txt");
    });
  },
};
options.plugins = [licenses];

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

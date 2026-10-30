// 画面のコード（client/）とライブラリを public/build/app.js にまとめる（Windows・macOS・Linux 共通）
// --watch を付けると、client/ を変更するたびに作り直す
import * as esbuild from "esbuild";
import { writeLicenses } from "./licenses.mjs";

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
// ライブラリのライセンス本文（THIRD_PARTY_LICENSES.txt）も一緒に書き出す
const licenses = { name: "licenses", setup(b) { b.onEnd((r) => { if (r.metafile) writeLicenses(r.metafile, "public/build/THIRD_PARTY_LICENSES.txt"); }); } };
options.plugins = [licenses];

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

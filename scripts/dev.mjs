// npm run dev: 画面のコードを監視して作り直しながら、wrangler dev を起動する。引数は wrangler dev にそのまま渡す
import { spawn } from "node:child_process";
import * as esbuild from "esbuild";
import { writeLicenses } from "./licenses.mjs";

const ctx = await esbuild.context({
  entryPoints: ["client/main.js"], bundle: true, format: "esm", target: ["es2022"],
  outfile: "public/build/app.js", sourcemap: true, legalComments: "linked", logLevel: "info", metafile: true,
  plugins: [{ name: "licenses", setup(b) { b.onEnd((r) => { if (r.metafile) writeLicenses(r.metafile, "public/build/THIRD_PARTY_LICENSES.txt"); }); } }],
});
await ctx.rebuild();
await ctx.watch();

const wrangler = spawn("npx", ["wrangler", "dev", ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
const stop = () => { wrangler.kill(); ctx.dispose(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
wrangler.on("exit", (code) => { ctx.dispose(); process.exit(code ?? 0); });

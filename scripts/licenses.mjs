// 画面のファイルにまとめたライブラリのライセンス本文を 1 つのファイルに書き出す（MIT などは再配布時に著作権表示が必要）
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeLicenses(metafile, outfile) {
  const packages = new Map();
  // 実際に出力に含まれたもの（使われずに取り除かれたものは除く）
  const used = Object.values(metafile.outputs).flatMap((o) => Object.entries(o.inputs ?? {}).filter(([, i]) => i.bytesInOutput > 0).map(([f]) => f));
  for (const input of used) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
    if (!m || packages.has(m[1])) continue;
    const dir = join("node_modules", m[1]);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^(license|licence|copying)/i.test(f));
    packages.set(m[1], { version: pkg.version, license: pkg.license, text: file ? readFileSync(join(dir, file), "utf8").trim() : "(ライセンスファイルなし)" });
  }
  const body = [...packages].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, p]) => `${"=".repeat(72)}\n${name}@${p.version} (${p.license})\n${"=".repeat(72)}\n${p.text}\n`).join("\n");
  writeFileSync(outfile, `mdvault の画面（app.js）に含まれるライブラリのライセンス\n\n${body}`);
  return packages.size;
}


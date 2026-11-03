// 同梱するライブラリのライセンス本文を 1 つのファイルに書き出す（MIT などは再配布時に著作権表示とライセンス本文が必要）
// 対象は、画面のファイル（app.js）と、Worker（wrangler deploy がまとめるサーバーのコード）に実際に含まれたもの
// ライセンスファイルがないもの・確認していない種類のライセンスのものが入ったら、ビルドを失敗させる
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 同梱してよいと確認したライセンス（表記さえすれば、このリポジトリの 0BSD と一緒に配布できるもの）
// 新しい種類が出てきたら、条件（ソースの公開義務・NOTICE の掲載など）を確認してから追加する
const ALLOWED = new Set(["MIT", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "(MPL-2.0 OR Apache-2.0)"]);
// ライセンス本文・NOTICE のファイル（LICENSE、LICENSE.md、LICENSE-MPL、NOTICE など）
const LICENSE_FILE = /^(license|licence|copying|notice)/i;

/** esbuild の metafile から、出力に実際に含まれたパッケージ（使われずに取り除かれたものは除く）を集める */
export function bundledPackages(metafile) {
  const names = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const [file, input] of Object.entries(output.inputs ?? {})) {
      if (!input.bytesInOutput) continue;
      const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file.replaceAll("\\", "/"));
      if (m) names.add(m[1]);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function describe(name) {
  const dir = join("node_modules", name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  if (!files.length) throw new Error(`${name}: ライセンスファイルがありません。同梱してよいか確認してください`);
  if (!ALLOWED.has(pkg.license)) throw new Error(`${name}: 確認していないライセンス（${pkg.license}）です。条件を確認して scripts/licenses.mjs の ALLOWED に追加してください`);
  return { name, version: pkg.version, license: pkg.license, texts: files.map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8").trim() })) };
}

/**
 * @param {{ title: string, packages: string[] }[]} sections
 * @returns {number} 書き出したパッケージの数
 */
export function writeLicenses(sections, outfile) {
  const line = "=".repeat(72);
  const parts = ["mdvault に含まれるライブラリのライセンス", "", "mdvault 自身のコードは 0BSD です。以下のライブラリは、それぞれのライセンスに従います。", ""];
  let count = 0;
  for (const { title, packages } of sections) {
    const list = packages.map(describe);
    count += list.length;
    parts.push(line, `■ ${title}（${list.length} 件）`, line, "", ...list.map((p) => `- ${p.name}@${p.version} (${p.license})`), "");
    for (const p of list) {
      parts.push(line, `${p.name}@${p.version} (${p.license})`, line);
      for (const t of p.texts) parts.push(...(p.texts.length > 1 ? [`--- ${t.file} ---`] : []), t.text, "");
    }
  }
  writeFileSync(outfile, parts.join("\n"));
  return count;
}

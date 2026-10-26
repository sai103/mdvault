// 画面で使うライブラリを node_modules から public/vendor/ にコピーする（Windows・macOS・Linux 共通）
import { copyFileSync, mkdirSync } from "node:fs";

const FILES = {
  "marked.js": "node_modules/marked/lib/marked.esm.js",
  "purify.js": "node_modules/dompurify/dist/purify.es.mjs",
  "simplewebauthn.js": "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js",
};

mkdirSync("public/vendor", { recursive: true });
for (const [name, from] of Object.entries(FILES)) copyFileSync(from, `public/vendor/${name}`);

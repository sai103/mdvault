// 画面の E2E テスト用のサーバー。開発用とは別のデータ（.wrangler/e2e）を毎回作り直して起動する
import { execSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = process.env.E2E_PORT ?? "8788";
const PERSIST = ".wrangler/e2e";
const shell = process.platform === "win32";

rmSync(PERSIST, { recursive: true, force: true });
execSync("node scripts/build.mjs", { stdio: "inherit" });
execSync(`npx wrangler d1 migrations apply mdvault --local --persist-to ${PERSIST}`, { stdio: "inherit", env: { ...process.env, CI: "1" } });
const dev = spawn("npx", [
  "wrangler", "dev", "--port", PORT, "--persist-to", PERSIST,
  "--var", "BOOTSTRAP_SECRET:e2e-bootstrap-secret-0123456789",
  // 本人確認のし直しを試すため、有効時間を短くする（3 秒）
  "--var", "REAUTH_WINDOW_MINUTES:0.05",
], { stdio: "inherit", shell });
const stop = () => dev.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
dev.on("exit", (code) => process.exit(code ?? 0));

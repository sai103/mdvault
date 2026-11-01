// 画面の E2E テスト（npm run test:e2e）。ローカルの wrangler dev に対して、Chromium で実行する
// テストのファイルごとに別のサーバー（別のデータ）を使う。どちらも「最初の 1 台」の登録から始めるため
import { defineConfig, devices } from "@playwright/test";

const SUITES = [
  { name: "app", testMatch: "app.spec.js", port: 8788 },              // 主要な機能とセキュリティ
  { name: "scenarios", testMatch: "scenarios.spec.js", port: 8789 },  // 使いかたマニュアル（docs/manual.md）に沿ったシナリオ
];

export default defineConfig({
  testDir: "e2e",
  // 1 つのアプリ（同じデータ）に対して順番に操作するので、並列にしない
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["github"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    // 別の場所にある Chromium を使う場合（例: Playwright のバージョンと合うブラウザを入れられない環境）
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  projects: SUITES.map(({ name, testMatch, port }) => ({ name, testMatch, use: { baseURL: `http://localhost:${port}` } })),
  // 順番に起動する。画面のファイルのビルドは 1 つ目だけが行う
  webServer: SUITES.map(({ port }, i) => ({
    command: "node scripts/e2e-server.mjs",
    env: { E2E_PORT: String(port), ...(i > 0 ? { E2E_SKIP_BUILD: "1" } : {}) },
    url: `http://localhost:${port}/api/device`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
  })),
});

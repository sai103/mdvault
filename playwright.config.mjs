// 画面の E2E テスト（npm run test:e2e）。ローカルの wrangler dev に対して、Chromium で実行する
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // 1 つのアプリ（同じデータ）に対して順番に操作するので、並列にしない
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    baseURL: "http://localhost:8788",
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    // 別の場所にある Chromium を使う場合（例: Playwright のバージョンと合うブラウザを入れられない環境）
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://localhost:8788/api/device",
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
  },
});

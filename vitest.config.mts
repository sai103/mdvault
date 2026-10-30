import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Worker を本番と同じランタイム（workerd）で動かしてテストする。D1・R2 はテストごとのローカル環境
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          BOOTSTRAP_SECRET: "test-bootstrap-secret-0123456789",
        },
      },
    }),
  ],
  // e2e/ は Playwright（npm run test:e2e）で実行する
  test: { include: ["tests/**/*.test.ts"], setupFiles: ["./tests/setup.ts"] },
}));

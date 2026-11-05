import { defineConfig, devices } from "@playwright/test";

/**
 * E2E с имитацией Telegram: сервер поднимается из собранного API и раздаёт собранную Mini App.
 * Нужны TEST_DATABASE_URL и предварительный `pnpm build`.
 */
const PORT = 3998;
export const BOT_TOKEN = "123456:E2E-token-abcdefghijklmnopqrstuvwxyz";

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Pixel 7"], launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } },
  webServer: {
    command: "node ../apps/api/dist/main.js",
    port: PORT,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://kf:kf@localhost:5432/kf_test",
      BOT_TOKEN,
      BOT_USERNAME: "kf_e2e_bot",
      SESSION_SECRET: "e".repeat(40),
      WEB_DIST: "../apps/web/dist",
      LOG_LEVEL: "warn",
    },
  },
});

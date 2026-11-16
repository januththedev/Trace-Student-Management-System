import { defineConfig, devices } from "@playwright/test";
import { e2eEnv } from "./tests/e2e/environment";
import { fontResponsesPath } from "./tests/e2e/cache-fonts";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "tests/e2e/.artifacts/results",
  reporter: [["list"], ["html", { outputFolder: "tests/e2e/.artifacts/report", open: "never" }]],
  use: {
    baseURL: "http://localhost:3100", trace: "retain-on-failure", screenshot: "only-on-failure", reducedMotion: "reduce",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"], defaultBrowserType: "chromium", viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `pnpm exec tsx tests/e2e/prepare-server.ts && ${process.env.T2T_E2E_IPV4_FONTS === "1" ? "pnpm exec tsx tests/e2e/ipv4-dev-server.ts" : "pnpm dev tests/e2e/.artifacts/app --port 3100"}`,
    // Static readiness does not query tables before globalSetup creates/migrates them.
    url: "http://localhost:3100/offline.html",
    reuseExistingServer: false,
    timeout: 300_000,
    env: { ...e2eEnv, NEXT_TELEMETRY_DISABLED: "1", ...(process.env.T2T_E2E_CACHED_FONTS === "1" ? { NEXT_FONT_GOOGLE_MOCKED_RESPONSES: fontResponsesPath } : {}) },
  },
});


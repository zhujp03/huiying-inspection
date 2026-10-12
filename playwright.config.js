import { defineConfig } from "@playwright/test";

const adminPort = Number(process.env.ADMIN_PORT || 4174);
const contractPort = Number(process.env.CONTRACT_PORT || 8787);
const adminOrigin = `http://127.0.0.1:${adminPort}`;
const contractOrigin = `http://127.0.0.1:${contractPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // H5 本地全流程回归使用独立配置与独立 webServer（junde_test + 本地磁盘存储）：
  // tests/e2e/h5-local/playwright.config.js；此处排除，避免被 Admin fixture 套件误采集。
  testIgnore: "**/h5-local/**",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: "list",
  use: { baseURL: adminOrigin, headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: [
    { command: `CONTRACT_PORT=${contractPort} ADMIN_ORIGIN=${adminOrigin} node tests/fixtures/contract-server.mjs`, url: `${contractOrigin}/api/me`, reuseExistingServer: true },
    { command: `VITE_API_BASE_URL=${contractOrigin} VITE_TENCENT_MAP_KEY= npm --prefix apps/admin run dev -- --host 127.0.0.1 --port ${adminPort}`, url: adminOrigin, reuseExistingServer: true },
  ],
});

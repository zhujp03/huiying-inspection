// H5 本地全流程浏览器回归（独立于 Admin e2e 配置）：
// 真实 H5 构建产物 + 真实 API（本地磁盘存储）+ 真实 junde_test PostgreSQL。
// 运行：npx playwright test --config tests/e2e/h5-local/playwright.config.js
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    headless: true,
    viewport: { width: 420, height: 860 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server.mjs",
    cwd: here,
    url: "http://127.0.0.1:5199/healthz",
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

// CORS Origin 策略：生产只精确允许 ADMIN_ORIGIN；开发/测试额外允许本机来源
// （localhost/127.0.0.1 任意端口），保证本机 Admin dev server 不受 .env 域名占位值影响。
import { describe, expect, it } from "vitest";
import { buildApp } from "../../apps/api/src/app.js";

const baseConfig = { API_REQUEST_TIMEOUT_MS: 12000, ADMIN_ORIGIN: "https://dev-admin.example.cn" };

async function allowOrigin(config, origin) {
  const app = buildApp({ config, pool: null, logger: false });
  await app.ready();
  const response = await app.inject({ method: "OPTIONS", url: "/health/live", headers: { origin, "access-control-request-method": "POST" } });
  await app.close();
  return response.headers["access-control-allow-origin"];
}

describe("CORS origin policy", () => {
  it("development allows the configured admin origin and localhost origins, rejects third parties", async () => {
    const config = { ...baseConfig, NODE_ENV: "development" };
    expect(await allowOrigin(config, "https://dev-admin.example.cn")).toBe("https://dev-admin.example.cn");
    expect(await allowOrigin(config, "http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(await allowOrigin(config, "http://localhost:4173")).toBe("http://localhost:4173");
    expect(await allowOrigin(config, "https://evil.example.com")).toBeUndefined();
    expect(await allowOrigin(config, "")).toBeUndefined(); // 小程序 wx.request 不带 Origin
  });

  it("production allows only the configured admin origin", async () => {
    const config = { ...baseConfig, NODE_ENV: "production" };
    expect(await allowOrigin(config, "https://dev-admin.example.cn")).toBe("https://dev-admin.example.cn");
    expect(await allowOrigin(config, "http://127.0.0.1:5173")).toBeUndefined();
    expect(await allowOrigin(config, "https://evil.example.com")).toBeUndefined();
  });
});

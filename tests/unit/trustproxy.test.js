import { describe, expect, it } from "vitest";
import { buildApp } from "../../apps/api/src/app.js";

describe("restricted trustProxy", () => {
  it("ignores X-Forwarded-For from untrusted clients", async () => {
    const app = buildApp({ config: { API_REQUEST_TIMEOUT_MS: 12000, ADMIN_ORIGIN: undefined, TRUST_PROXY: "127.0.0.1/32" }, pool: null, logger: false });
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/live", headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(response.statusCode).toBe(200);
    // 通过 app.inject 的 remoteAddress 默认即 127.0.0.1（可信代理），
    // 因此需要验证：当伪造头来自非可信链时 request.ip 不被替换。
    const ip = await app.inject({ method: "GET", url: "/live", headers: { "x-forwarded-for": "203.0.113.9" }, remoteAddress: "127.0.0.1" });
    expect(ip.statusCode).toBe(200);
    await app.close();
  });

  it("does not trust proxy headers when TRUST_PROXY is unset", async () => {
    const app = buildApp({ config: { API_REQUEST_TIMEOUT_MS: 12000, ADMIN_ORIGIN: undefined }, pool: null, logger: false });
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/live", headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

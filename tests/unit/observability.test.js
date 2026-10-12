import { describe, expect, it } from "vitest";
import { buildApp } from "../../apps/api/src/app.js";

const config = { API_REQUEST_TIMEOUT_MS: 12000, ADMIN_ORIGIN: undefined };

describe("observability endpoints", () => {
  it("serves /health/live and /health/ready alongside legacy aliases", async () => {
    const app = buildApp({ config, pool: null, logger: false });
    await app.ready();
    for (const path of ["/live", "/health/live"]) {
      const live = await app.inject({ method: "GET", url: path });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ status: "ok" });
    }
    for (const path of ["/ready", "/health/ready"]) {
      const ready = await app.inject({ method: "GET", url: path });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().error.code).toBe("DATABASE_UNAVAILABLE");
    }
    await app.close();
  });

  it("exposes Prometheus metrics without leaking request bodies or sensitive labels", async () => {
    const app = buildApp({ config, pool: null, logger: false });
    await app.ready();
    await app.inject({ method: "GET", url: "/live" });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    const body = metrics.body;
    expect(body).toContain("# TYPE http_requests_total counter");
    expect(body).toContain('http_requests_total{status="2xx_3xx"');
    expect(body).toContain("process_rss_bytes");
    expect(body).toContain("event_loop_delay_seconds");
    // 指标不允许携带请求体、密码、验证码或对象 Key。
    expect(body).not.toMatch(/password|smsCode|captchaTicket|storage_key|authorization/i);
    await app.close();
  });
});

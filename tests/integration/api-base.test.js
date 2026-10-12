import { describe, expect, it } from "vitest";
import { buildApp } from "../../apps/api/src/app.js";
import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();


const config = { API_REQUEST_TIMEOUT_MS: 12000, ADMIN_ORIGIN: undefined };

describe("Fastify production base", () => {
  it("serves liveness and reports an unavailable database without a fake ready state", async () => {
    const app = buildApp({ config, pool: null, logger: false });
    await app.ready();
    const live = await app.inject({ method: "GET", url: "/live" });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().error).toMatchObject({ code: "DATABASE_UNAVAILABLE", retryable: true });
    expect(ready.json().error.requestId).toBeTruthy();
    const auth = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "user", password: "password-123" } });
    expect(auth.statusCode).toBe(503);
    expect(auth.json().error.code).toBe("AUTH_NOT_CONFIGURED");
    await app.close();
  });
});

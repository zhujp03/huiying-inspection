import { describe, expect, it, vi } from "vitest";
import { createCosCredentialProvider, createCosProvider } from "../../apps/api/src/storage/cos.js";

// 可编程时钟（与现有 cos.test.js 一致：clock() 返回 Date），
// 用于把“剩余有效期”推进到续期阈值附近。
const makeClock = (start) => {
  let now = start;
  return { now: () => new Date(now), advance: (milliseconds) => { now += milliseconds; }, };
};

const assumeRoleResponse = (tmpSecretId, token, expiredTime) => new Response(JSON.stringify({
  Response: { Credentials: { TmpSecretId: tmpSecretId, TmpSecretKey: "tmp-secret-key", Token: token }, ExpiredTime: expiredTime },
}), { status: 200 });

const renewingConfig = {
  COS_REGION: "ap-shanghai", COS_EVIDENCE_BUCKET: "evidence-1250000000",
  COS_ROLE_ARN: "qcs::cam::uin/10001:roleName/junde-cos-staging",
  COS_ASSUME_ROLE_SECRET_ID: "AKID_BASE", COS_ASSUME_ROLE_SECRET_KEY: "base-secret",
  COS_STS_DURATION_SECONDS: 3600, COS_STS_REFRESH_BEFORE_SECONDS: 300,
  COS_UPLOAD_TTL_SECONDS: 300, COS_PREVIEW_TTL_SECONDS: 120,
};

describe("renewing COS credential provider", () => {
  it("obtains temporary credentials via CAM AssumeRole and signs upload targets with them", async () => {
    const clock = makeClock(Date.parse("2026-07-24T00:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValue(assumeRoleResponse("AKID_TMP_1", "token-1", 1784851200 + 3600));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createCosCredentialProvider(renewingConfig, clock.now, { info() {}, warn() {} });
    const credentials = await provider.getCredentials();
    expect(credentials).toMatchObject({ secretId: "AKID_TMP_1", secretKey: "tmp-secret-key", token: "token-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sts.tencentcloudapi.com");
    const body = JSON.parse(options.body);
    expect(body.RoleArn).toBe(renewingConfig.COS_ROLE_ARN);
    expect(body.DurationSeconds).toBe(3600);
    expect(options.headers.authorization).toMatch(/TC3-HMAC-SHA256 Credential=AKID_BASE/);
    // 未到续期阈值：再次获取只读缓存，不再调用供应商。
    const again = await provider.getCredentials();
    expect(again.token).toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("refreshes exactly once when credentials are about to expire, even under concurrency", async () => {
    const start = Date.parse("2026-07-24T00:00:00.000Z");
    const clock = makeClock(start);
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount += 1;
      // 每次续期都返回“从现在起 1 小时”的有效期，让时钟推进能真实触发阈值刷新。
      return assumeRoleResponse(`AKID_TMP_${callCount}`, `token-${callCount}`, Math.floor((start + 3600_000) / 1000));
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createCosCredentialProvider(renewingConfig, clock.now, { info() {}, warn() {} });
    await provider.getCredentials();
    expect(callCount).toBe(1);
    // 推进到距过期只剩 60 秒（低于 300 秒续期阈值）。
    clock.advance(3540_000);
    const concurrent = await Promise.all([provider.getCredentials(), provider.getCredentials(), provider.getCredentials()]);
    for (const credentials of concurrent) expect(credentials.token).toBe("token-2");
    // 单飞：三个并发请求只触发一次 AssumeRole。
    expect(callCount).toBe(2);
    vi.unstubAllGlobals();
  });

  it("serves still-valid cached credentials when a refresh fails, then 503s after real expiry", async () => {
    const start = Date.parse("2026-07-24T00:00:00.000Z");
    const clock = makeClock(start);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(assumeRoleResponse("AKID_TMP_1", "token-1", Math.floor((start + 3600_000) / 1000)))
      .mockRejectedValue(new TypeError("sts down"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createCosCredentialProvider(renewingConfig, clock.now, { info() {}, warn() {} });
    await provider.getCredentials();
    clock.advance(3540_000);
    const stillValid = await provider.getCredentials();
    expect(stillValid.token).toBe("token-1");
    clock.advance(120_000); // 旧凭证真正过期
    await expect(provider.getCredentials()).rejects.toMatchObject({ code: "COS_CREDENTIAL_REFRESH_FAILED", statusCode: 503, retryable: true });
    vi.unstubAllGlobals();
  });

  it("signs the post policy with the refreshed temporary credentials after renewal", async () => {
    const start = Date.parse("2026-07-24T00:00:00.000Z");
    const clock = makeClock(start);
    const fetchMock = vi.fn().mockImplementation(async () => assumeRoleResponse("AKID_TMP_FRESH", "token-fresh", Math.floor((start + 3600_000) / 1000)));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createCosProvider(renewingConfig, clock.now, { info() {}, warn() {} });
    await provider.assertReady();
    const target = provider.createPostTarget({ key: "attempts/a/receipts/b/x", sizeBytes: 100, uploadNonce: "nonce", contentType: "image/jpeg" });
    expect(target.formData["q-ak"]).toBe("AKID_TMP_FRESH");
    expect(target.formData["x-cos-security-token"]).toBe("token-fresh");
    const policy = JSON.parse(Buffer.from(target.formData.policy, "base64").toString("utf8"));
    expect(policy.conditions).toContainEqual({ "q-ak": "AKID_TMP_FRESH" });
    vi.unstubAllGlobals();
  });

  it("never leaks the base long-term secret id or key into the signed form data", async () => {
    const start = Date.parse("2026-07-24T00:00:00.000Z");
    const clock = makeClock(start);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => assumeRoleResponse("AKID_TMP_1", "token-1", Math.floor((start + 3600_000) / 1000))));
    const provider = createCosProvider(renewingConfig, clock.now, { info() {}, warn() {} });
    await provider.assertReady();
    const target = provider.createPostTarget({ key: "attempts/a/x", sizeBytes: 1, uploadNonce: "n", contentType: "image/jpeg" });
    const serialised = JSON.stringify(target);
    expect(serialised).not.toContain("AKID_BASE");
    expect(serialised).not.toContain("base-secret");
    vi.unstubAllGlobals();
  });
});

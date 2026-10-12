import { describe, expect, it, vi } from "vitest";
import { createConfiguredProviders, createSandboxProviders, createTencentCaptchaProvider, createTencentSmsProvider, missingProviders, tc3Sign } from "../../apps/api/src/auth/providers.js";

describe("TC3 request signing", () => {
  it("produces the documented Tencent Cloud TC3-HMAC-SHA256 header shape", () => {
    const target = tc3Sign({
      method: "POST", host: "captcha.tencentcloudapi.com", service: "captcha", action: "DescribeCaptchaMiniResult", version: "2019-07-22",
      region: "", secretId: "AKID_TEST", secretKey: "secret-key", now: new Date("2026-07-24T00:00:00.000Z"), payload: { CaptchaType: 9, Ticket: "t" },
    });
    expect(target.url).toBe("https://captcha.tencentcloudapi.com");
    expect(target.headers["x-tc-action"]).toBe("DescribeCaptchaMiniResult");
    expect(target.headers["x-tc-version"]).toBe("2019-07-22");
    expect(target.headers["x-tc-timestamp"]).toBe("1784851200");
    expect(target.headers.authorization).toMatch(/^TC3-HMAC-SHA256 Credential=AKID_TEST\/2026-07-24\/captcha\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
  });
});

const captchaConfig = {
  CAPTCHA_APP_ID: "2026",
  CAPTCHA_APP_SECRET_KEY: "app-secret-key-only-for-body",
  CAPTCHA_API_SECRET_ID: "AKID_API_SIGN",
  CAPTCHA_API_SECRET_KEY: "api-secret-key-only-for-tc3",
};

describe("Tencent CAPTCHA provider", () => {
  it("rejects a missing ticket without calling the supplier", async () => {
    const provider = createTencentCaptchaProvider(captchaConfig);
    await expect(provider.verifyCaptcha({ ticket: "", randstr: "r" })).rejects.toMatchObject({ code: "CAPTCHA_TICKET_MISSING", statusCode: 422, retryable: false });
  });

  it("uses API credentials for TC3 signing, AppSecretKey only in the body, and never sends UserAgent/Randstr", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ Response: { CaptchaCode: 1, CaptchaMsg: "success", RequestId: "req-123" } }), { status: 200 })));
    const provider = createTencentCaptchaProvider(captchaConfig, { debug() {} });
    const result = await provider.verifyCaptcha({ ticket: "ticket-value", randstr: "", ip: "127.0.0.1", deviceFingerprint: "device-fingerprint-value" });
    expect(result).toMatchObject({ requestId: "req-123", captchaCode: 1 });
    expect(result.requestId).not.toBe("ticket-value");
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://captcha.tencentcloudapi.com");
    const body = JSON.parse(options.body);
    // 请求体：AppSecretKey 必须来自 CAPTCHA_APP_SECRET_KEY，且不等于 API SecretKey。
    expect(body).toMatchObject({ CaptchaType: 9, Ticket: "ticket-value", UserIp: "127.0.0.1", CaptchaAppId: 2026, AppSecretKey: "app-secret-key-only-for-body" });
    expect(body.AppSecretKey).not.toBe(captchaConfig.CAPTCHA_API_SECRET_KEY);
    // 只发送官方支持字段：不得出现 UserAgent、Randstr、deviceFingerprint 或未定义字段。
    expect(Object.keys(body).sort()).toEqual(["AppSecretKey", "CaptchaAppId", "CaptchaType", "Ticket", "UserIp"]);
    expect(body).not.toHaveProperty("UserAgent");
    expect(body).not.toHaveProperty("Randstr");
    // 签名头：Credential 必须使用 CAPTCHA_API_SECRET_ID；签名不得由 AppSecretKey 生成。
    expect(options.headers.authorization).toContain(`Credential=${captchaConfig.CAPTCHA_API_SECRET_ID}/`);
    expect(options.headers.authorization).not.toContain("app-secret-key-only-for-body");
    vi.unstubAllGlobals();
  });

  it("refuses to verify when the AppSecretKey equals the API SecretKey", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ Response: { CaptchaCode: 1 } }), { status: 200 })));
    const provider = createTencentCaptchaProvider({ ...captchaConfig, CAPTCHA_APP_SECRET_KEY: captchaConfig.CAPTCHA_API_SECRET_KEY }, { debug() {} });
    await expect(provider.verifyCaptcha({ ticket: "t", randstr: "" })).rejects.toMatchObject({ code: "CAPTCHA_CONFIG_INVALID", statusCode: 503, retryable: false });
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each([
    ["0", /十进制正整数/], ["-5", /十进制正整数/], ["12.5", /十进制正整数/], ["abc", /十进制正整数/], ["9007199254740992", /十进制正整数/],
  ])("rejects invalid CAPTCHA_APP_ID %s", (appId, pattern) => {
    expect(() => createTencentCaptchaProvider({ ...captchaConfig, CAPTCHA_APP_ID: appId })).toThrow(pattern);
    expect(() => createConfiguredProviders({ NODE_ENV: "production", ...captchaConfig, CAPTCHA_APP_ID: appId, SMS_SECRET_ID: "x", SMS_SECRET_KEY: "x", SMS_SDK_APP_ID: "1", SMS_SIGN_NAME: "签", SMS_TEMPLATE_IDS: { registration: "1", passwordReset: "2" } })).toThrow(pattern);
  });

  it("rejects an empty CAPTCHA_APP_ID as missing supplier config in production", () => {
    expect(() => createConfiguredProviders({ NODE_ENV: "production", ...captchaConfig, CAPTCHA_APP_ID: "", SMS_SECRET_ID: "x", SMS_SECRET_KEY: "x", SMS_SDK_APP_ID: "1", SMS_SIGN_NAME: "签", SMS_TEMPLATE_IDS: { registration: "1", passwordReset: "2" } })).toThrow(/生产环境必须配置真实认证供应商/);
  });

  it.each([
    [1, "passed"], [7, "cancelled"], [8, "invalid"], [10, "invalid"], [15, "expired"], [16, "invalid"], [21, "invalid"], [25, "invalid"], [26, "invalid"], [31, "invalid"], [100, "invalid"],
  ])("classifies CaptchaCode %s as %s", async (code, failureKind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ Response: { CaptchaCode: code, RequestId: `req-${code}` } }), { status: 200 })));
    const provider = createTencentCaptchaProvider(captchaConfig, { debug() {} });
    if (failureKind === "passed") {
      const result = await provider.verifyCaptcha({ ticket: "t", randstr: "" });
      expect(result.requestId).toBe(`req-${code}`);
    } else {
      const expectedCode = failureKind === "expired" ? "CAPTCHA_EXPIRED" : failureKind === "cancelled" ? "CAPTCHA_CANCELLED" : "CAPTCHA_REJECTED";
      await expect(provider.verifyCaptcha({ ticket: "t", randstr: "" })).rejects.toMatchObject({ code: expectedCode, statusCode: 422, failureKind });
    }
    vi.unstubAllGlobals();
  });

  it("classifies a supplier rejection as a terminal business rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ Response: { CaptchaCode: 0 } }), { status: 200 })));
    const provider = createTencentCaptchaProvider(captchaConfig, { debug() {} });
    await expect(provider.verifyCaptcha({ ticket: "bad", randstr: "r" })).rejects.toMatchObject({ code: "CAPTCHA_REJECTED", statusCode: 422, retryable: false });
    vi.unstubAllGlobals();
  });

  it("returns a retryable 503 when the supplier is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    const provider = createTencentCaptchaProvider(captchaConfig, { debug() {} });
    await expect(provider.verifyCaptcha({ ticket: "t", randstr: "r" })).rejects.toMatchObject({ code: "PROVIDER_NETWORK", statusCode: 503, retryable: true });
    vi.unstubAllGlobals();
  });
});

describe("Tencent SMS provider", () => {
  it("sends through SendSms and returns the provider message id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ Response: { SendStatusSet: [{ Code: "Ok", MessageId: "msg-1" }] } }), { status: 200 })));
    const provider = createTencentSmsProvider({ SMS_SECRET_ID: "AKID", SMS_SECRET_KEY: "k", SMS_SDK_APP_ID: "1400000000", SMS_SIGN_NAME: "君德测试", SMS_TEMPLATE_IDS: { registration: "12345" } }, { debug() {} });
    const result = await provider.sendSms({ phone: "+8613800000000", code: "123456", purpose: "registration" });
    expect(result.messageId).toBe("msg-1");
    const [url, options] = fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({ SmsSdkAppId: "1400000000", SignName: "君德测试", TemplateId: "12345", TemplateParamSet: ["123456"], PhoneNumberSet: ["+8613800000000"] });
    vi.unstubAllGlobals();
  });

  it("never logs the full phone number or the code", async () => {
    const logged = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ Response: { SendStatusSet: [{ Code: "Ok", MessageId: "m" }] } }), { status: 200 })));
    const provider = createTencentSmsProvider({ SMS_SECRET_ID: "AKID", SMS_SECRET_KEY: "k", SMS_SDK_APP_ID: "1400000000", SMS_SIGN_NAME: "签", SMS_TEMPLATE_IDS: { registration: "1" } }, { debug: (entry) => logged.push(JSON.stringify(entry)) });
    await provider.sendSms({ phone: "+8613800000000", code: "654321", purpose: "registration" });
    const text = logged.join("");
    expect(text).not.toContain("13800000000");
    expect(text).not.toContain("654321");
    expect(text).toContain("+86****00");
    vi.unstubAllGlobals();
  });

  it("classifies a permanent template rejection as terminal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ Response: { SendStatusSet: [{ Code: "FailedOperation.TemplateIdNotFound", Message: "模板不存在" }] } }), { status: 200 })));
    const provider = createTencentSmsProvider({ SMS_SECRET_ID: "AKID", SMS_SECRET_KEY: "k", SMS_SDK_APP_ID: "1400000000", SMS_SIGN_NAME: "签", SMS_TEMPLATE_IDS: { registration: "1" } }, { debug() {} });
    await expect(provider.sendSms({ phone: "+8613800000000", code: "123456", purpose: "registration" })).rejects.toMatchObject({ statusCode: 422, retryable: false });
    vi.unstubAllGlobals();
  });
});

describe("sandbox providers", () => {
  it("only accepts whitelisted phones in non-production", async () => {
    const provider = createSandboxProviders({ SMS_SANDBOX_WHITELIST_PHONES: "+8613800000000", NODE_ENV: "development" }, { warn() {} });
    const sent = await provider.sendSms({ phone: "+8613800000000", code: "111111", purpose: "registration" });
    expect(sent.messageId).toMatch(/^sandbox-/);
    await expect(provider.sendSms({ phone: "+8613900000000", code: "111111", purpose: "registration" })).rejects.toMatchObject({ code: "SMS_WHITELIST_REJECTED", statusCode: 422, retryable: false });
  });

  it("refuses to start without a whitelist", () => {
    expect(() => createSandboxProviders({ SMS_SANDBOX_WHITELIST_PHONES: "" })).toThrow(/SMS_SANDBOX_WHITELIST_PHONES/);
  });

  it("generateCode returns the fixed code so the delivered code matches the stored challenge", async () => {
    const provider = createSandboxProviders({ SMS_SANDBOX_WHITELIST_PHONES: "+8613800000000", SMS_SANDBOX_FIXED_CODE: "246810" }, { warn() {} });
    expect(await provider.generateCode()).toBe("246810");
    const randomless = createSandboxProviders({ SMS_SANDBOX_WHITELIST_PHONES: "+8613800000000" }, { warn() {} });
    expect(await randomless.generateCode()).toBeNull();
  });
});

describe("provider selection", () => {
  it("returns missing providers (503) when nothing is configured outside production", () => {
    const providers = createConfiguredProviders({ NODE_ENV: "development" });
    expect(providers.provider).toBeUndefined();
  });

  it("fails closed in production without real supplier keys", () => {
    expect(() => createConfiguredProviders({ NODE_ENV: "production", CAPTCHA_APP_ID: "", SMS_SECRET_ID: "" })).toThrow(/生产环境必须配置真实认证供应商/);
    expect(() => createConfiguredProviders({ NODE_ENV: "production", ...captchaConfig, SMS_SECRET_ID: "" })).toThrow(/生产环境必须配置真实认证供应商/);
  });

  it("fails closed when CAPTCHA AppSecretKey is reused as the API SecretKey", () => {
    expect(() => createConfiguredProviders({ NODE_ENV: "production", ...captchaConfig, CAPTCHA_APP_SECRET_KEY: captchaConfig.CAPTCHA_API_SECRET_KEY, SMS_SECRET_ID: "x", SMS_SECRET_KEY: "x", SMS_SDK_APP_ID: "1", SMS_SIGN_NAME: "签", SMS_TEMPLATE_IDS: { registration: "1" } })).toThrow(/禁止复用同一值/);
  });

  it("composes exactly the configured providers without spread override (four combinations)", async () => {
    const smsConfig = { SMS_SECRET_ID: "AKID", SMS_SECRET_KEY: "k", SMS_SDK_APP_ID: "1400000000", SMS_SIGN_NAME: "签", SMS_TEMPLATE_IDS: { registration: "1" } };
    // 仅 CAPTCHA：真实 verifyCaptcha 生效，sendSms 为 503 缺配。
    const onlyCaptcha = createConfiguredProviders({ NODE_ENV: "development", ...captchaConfig });
    expect(typeof onlyCaptcha.verifyCaptcha).toBe("function");
    await expect(onlyCaptcha.sendSms({ phone: "+8613800000000", code: "1" })).rejects.toMatchObject({ code: "SUPPLIER_NOT_CONFIGURED", statusCode: 503 });
    // 仅 SMS：真实 sendSms 生效，verifyCaptcha 为 503 缺配。
    const onlySms = createConfiguredProviders({ NODE_ENV: "development", ...smsConfig });
    await expect(onlySms.verifyCaptcha({ ticket: "t" })).rejects.toMatchObject({ code: "SUPPLIER_NOT_CONFIGURED", statusCode: 503 });
    // 全部配置：两者都真实。
    const both = createConfiguredProviders({ NODE_ENV: "development", ...captchaConfig, ...smsConfig });
    expect(both.provider).toBe("tencent");
    // 全部缺失：两者都 503。
    const none = createConfiguredProviders({ NODE_ENV: "development" });
    await expect(none.verifyCaptcha({ ticket: "t" })).rejects.toMatchObject({ code: "SUPPLIER_NOT_CONFIGURED", statusCode: 503 });
    await expect(none.sendSms({ phone: "+8613800000000", code: "1" })).rejects.toMatchObject({ code: "SUPPLIER_NOT_CONFIGURED", statusCode: 503 });
  });

  it("forbids sandbox mode in production", () => {
    expect(() => createConfiguredProviders({ NODE_ENV: "production", AUTH_PROVIDER_MODE: "sandbox", SMS_SANDBOX_WHITELIST_PHONES: "+8613800000000" })).toThrow(/sandbox is forbidden in production/);
  });

  it("returns observable 503 from missingProviders", async () => {
    const providers = missingProviders();
    await expect(providers.verifyCaptcha({ ticket: "t" })).rejects.toMatchObject({ code: "SUPPLIER_NOT_CONFIGURED", statusCode: 503, retryable: true });
    await expect(providers.sendSms({ phone: "+8613800000000" })).rejects.toMatchObject({ code: "SUPPLIER_NOT_CONFIGURED", statusCode: 503, retryable: true });
  });

  it("degrades to 503 stubs in production when AUTH_SELF_SERVICE=disabled", async () => {
    const providers = createConfiguredProviders({ NODE_ENV: "production", AUTH_SELF_SERVICE: "disabled" });
    expect(providers.provider).toBeUndefined();
    await expect(providers.verifyCaptcha({ ticket: "t" })).rejects.toMatchObject({ code: "SUPPLIER_NOT_CONFIGURED", statusCode: 503, retryable: true });
    await expect(providers.sendSms({ phone: "+8613800000000" })).rejects.toMatchObject({ code: "SUPPLIER_NOT_CONFIGURED", statusCode: 503, retryable: true });
  });
});

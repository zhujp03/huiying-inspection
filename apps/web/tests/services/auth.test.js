// B 类端点契约测试：services/auth（8 函数 + login/logout 会话语义 + 401 统一处理）。
// 依据：docs/web/module-contracts.md §3.1 与 §7 端点映射总表；method/path 以
// packages/contracts/endpoint-registry.js 为真源；请求体形状对照小程序
// apps/miniapp/miniprogram/services/api.js:56-63（只读参照，逐字来源）。
// 零域名（R0 / testing §6）：每个端点用例断言 fetch 第一参为字符串、逐字等于
// registry 构造出的同源相对路径（以 /api 开头、不含 scheme/host）。
//
// TDD 红灯基线：apps/web/src/** 尚未实现（第 2 段落地），本文件全部用例预期
// 因模块不存在（Cannot find module → apps/web/src/**）而失败——这是预期，不是 bug。
// 加载纪律：loadSrc 一律在 it 体内 await；钩子只做环境复位，禁止在钩子里
// 让 loadSrc 的失败被 vitest 归并（否则逐用例的模块不存在型失败会被合并计数）。
import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

const SESSION_SAMPLE = { accessToken: "sample-token", user: { id: "user-1", status: "approved_active" } };
const LOGIN_RESULT_SAMPLE = { accessToken: "t2", user: { id: "user-2", status: "approved_active" } };

let fetchMock;

const stubJson = (body, status = 200) => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
};

// 兼容 fetch(url) 与 fetch(url, init) 两种调用形态，逐次解析请求参数；raw 保留第一参原值。
const callsOf = () =>
  fetchMock.mock.calls.map(([raw, init]) => ({
    raw,
    url: String(raw),
    method: String(init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
  }));

// 零域名断言（R0 / testing §6）：fetch 第一参必须是字符串，且逐字等于期望的同源相对路径。
const assertRelativeUrl = (call, expectedPath) => {
  assert.equal(typeof call.raw, "string", "零域名 R0：fetch 第一参必须是字符串相对路径，不得传 URL 对象或绝对地址");
  assert.equal(call.url, expectedPath, "零域名 R0：请求地址必须逐字等于 /api 开头的同源相对路径（无 scheme/host）");
};

const assertJsonHeaders = (call) => {
  assert.equal(call.headers.get("accept"), "application/json");
  assert.equal(call.headers.get("content-type"), "application/json");
};

// 会话种入：仅在 it 体内调用（红灯期失败即模块不存在型）。
const seedSession = async () => {
  (await loadSrc("store/session.js")).saveSession({ ...SESSION_SAMPLE, user: { ...SESSION_SAMPLE.user } });
};

// 兜底清理：红灯期 src 模块不存在，忽略模块不存在型错误（其余错误照常抛出）；
// 绿态下正常清会话与用户缓存，保证用例间互不串扰。
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  try {
    (await loadSrc("store/session.js")).clearSessionAndUserCache();
  } catch (error) {
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load url/.test(String(error?.message ?? error))) throw error;
  }
});

describe("services/auth 端点契约（零域名 + Bearer + method/path/body 逐字对齐 registry）", () => {
  it("login：POST /api/auth/login，body=实参 credentials，Bearer 三件套，成功后响应写入会话并原样返回", async () => {
    await seedSession();
    stubJson(LOGIN_RESULT_SAMPLE);
    const auth = await loadSrc("services/auth.js");
    const credentials = { username: "sample-user", password: "sample-password-1" };
    const result = await auth.login(credentials);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.login.pattern);
    assert.equal(call.method, endpointRegistry.auth.login.method);
    assert.deepEqual(call.body, credentials);
    assert.equal(call.headers.get("authorization"), "Bearer sample-token");
    assertJsonHeaders(call);
    assert.deepEqual(result, LOGIN_RESULT_SAMPLE);
    const session = await loadSrc("store/session.js");
    assert.deepEqual(session.getSession(), LOGIN_RESULT_SAMPLE);
  });

  it("logout：POST /api/auth/logout，成功后清空会话", async () => {
    await seedSession();
    stubJson({});
    const auth = await loadSrc("services/auth.js");
    await auth.logout();
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.logout.pattern);
    assert.equal(call.method, endpointRegistry.auth.logout.method);
    const session = await loadSrc("store/session.js");
    assert.equal(session.getSession(), null);
  });

  it("requestRegisterCode：POST /api/auth/register/phone-code，body=实参 payload", async () => {
    await seedSession();
    stubJson({ phoneChallengeId: "phone-challenge-1", resendAfterSeconds: 60 });
    const auth = await loadSrc("services/auth.js");
    const payload = { phone: "13800000000", captchaTicket: "sample-captcha-ticket", captchaRandstr: "sample-randstr" };
    await auth.requestRegisterCode(payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.registerPhoneCode.pattern);
    assert.equal(call.method, endpointRegistry.auth.registerPhoneCode.method);
    assert.deepEqual(call.body, payload);
  });

  it("register：POST /api/auth/register，body=实参 payload", async () => {
    await seedSession();
    stubJson({});
    const auth = await loadSrc("services/auth.js");
    const payload = {
      username: "sample-user",
      phone: "13800000000",
      password: "sample-password-1",
      confirmPassword: "sample-password-1",
      phoneChallengeId: "phone-challenge-1",
      smsCode: "123456",
    };
    await auth.register(payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.register.pattern);
    assert.equal(call.method, endpointRegistry.auth.register.method);
    assert.deepEqual(call.body, payload);
  });

  it("resubmitRegistration：POST /api/auth/registration/resubmit，body=实参 payload", async () => {
    await seedSession();
    stubJson({});
    const auth = await loadSrc("services/auth.js");
    const payload = { phoneChallengeId: "phone-challenge-2", smsCode: "654321" };
    await auth.resubmitRegistration(payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.registrationResubmit.pattern);
    assert.equal(call.method, endpointRegistry.auth.registrationResubmit.method);
    assert.deepEqual(call.body, payload);
  });

  it("requestPasswordCode：POST /api/auth/password-resets/code，body=实参 payload", async () => {
    await seedSession();
    stubJson({ phoneChallengeId: "phone-challenge-3", resendAfterSeconds: 60 });
    const auth = await loadSrc("services/auth.js");
    const payload = { phone: "13900000000", captchaTicket: "sample-captcha-ticket-2", captchaRandstr: "sample-randstr-2" };
    await auth.requestPasswordCode(payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.passwordCode.pattern);
    assert.equal(call.method, endpointRegistry.auth.passwordCode.method);
    assert.deepEqual(call.body, payload);
  });

  it("verifyPasswordCode：POST /api/auth/password-resets/verify，body=实参 payload", async () => {
    await seedSession();
    stubJson({ resetToken: "reset-token-1" });
    const auth = await loadSrc("services/auth.js");
    const payload = { phoneChallengeId: "phone-challenge-3", smsCode: "111111" };
    const result = await auth.verifyPasswordCode(payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.passwordVerify.pattern);
    assert.equal(call.method, endpointRegistry.auth.passwordVerify.method);
    assert.deepEqual(call.body, payload);
    assert.deepEqual(result, { resetToken: "reset-token-1" });
  });

  it("completePasswordReset：POST /api/auth/password-resets/complete，body=实参 payload", async () => {
    await seedSession();
    stubJson({});
    const auth = await loadSrc("services/auth.js");
    const payload = { resetToken: "reset-token-1", password: "new-password-1", confirmPassword: "new-password-1" };
    await auth.completePasswordReset(payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.passwordComplete.pattern);
    assert.equal(call.method, endpointRegistry.auth.passwordComplete.method);
    assert.deepEqual(call.body, payload);
  });

  it("login 收到 401 → kind=session、文案固定、会话被清空（R05/R86）", async () => {
    await seedSession();
    stubJson({ error: { code: "AUTH_INVALID" } }, 401);
    const auth = await loadSrc("services/auth.js");
    await assert.rejects(
      auth.login({ username: "sample-user", password: "sample-password-1" }),
      { name: "BusinessError", kind: "session", message: "登录已失效，请重新登录", retryable: false },
    );
    const session = await loadSrc("store/session.js");
    assert.equal(session.getSession(), null);
  });

  it("logout 服务端 500 → 仍清空会话，且 rejects kind=service（retryable）", async () => {
    await seedSession();
    stubJson({}, 500);
    const auth = await loadSrc("services/auth.js");
    await assert.rejects(
      auth.logout(),
      { kind: "service", message: "服务暂时不可用，请稍后重试", retryable: true },
    );
    const session = await loadSrc("store/session.js");
    assert.equal(session.getSession(), null);
  });

  it("login：无会话时不携带 authorization 头", async () => {
    stubJson(LOGIN_RESULT_SAMPLE);
    const auth = await loadSrc("services/auth.js");
    await auth.login({ username: "sample-user", password: "sample-password-1" });
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.login.pattern);
    assert.equal(call.headers.get("authorization"), null);
  });

  it("register：无会话时不携带 authorization 头", async () => {
    stubJson({});
    const auth = await loadSrc("services/auth.js");
    await auth.register({ username: "sample-user", phone: "13800000000", password: "sample-password-1", confirmPassword: "sample-password-1", phoneChallengeId: "phone-challenge-1", smsCode: "123456" });
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.register.pattern);
    assert.equal(call.headers.get("authorization"), null);
  });

  it("verifyPasswordCode：无会话时不携带 authorization 头", async () => {
    stubJson({ resetToken: "reset-token-1" });
    const auth = await loadSrc("services/auth.js");
    await auth.verifyPasswordCode({ phoneChallengeId: "phone-challenge-3", smsCode: "111111" });
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.auth.passwordVerify.pattern);
    assert.equal(call.headers.get("authorization"), null);
  });
});

// B 类端点契约测试：services/uploads（uploadToSignedTarget）+ services/public-config（loadPublicConfig）。
// 依据：docs/web/module-contracts.md §3.5/§3.6；uploadToSignedTarget 目标为服务端下发的
// 对象存储预签名 URL（无 registry 条目，inventory §3.c），校验分支对照小程序
// apps/miniapp/miniprogram/services/api.js:97-108；loadPublicConfig 对照 app.js:24-42
// （5 秒超时、无 Bearer、非 200/非对象/网络失败一律返回 null）。
// 零域名（R0 / testing §6）：loadPublicConfig 断言 fetch 第一参为字符串、逐字等于
// "/api/public/client-config"；uploadToSignedTarget 的预签名绝对 URL 是服务端下发
// 的运行时数据（R0 唯一例外），断言 fetch 第一参逐字等于传入的 url 样例。
// services/captcha 的 obtainCaptchaTicket 无网络端点，不在本文件范围。
//
// TDD 红灯基线：apps/web/src/** 尚未实现（第 2 段落地），本文件全部用例预期
// 因模块不存在（Cannot find module → apps/web/src/**）而失败——这是预期，不是 bug。
// 加载纪律：loadSrc 一律在 it 体内 await（含 fake timers 用例：先 loadSrc 再 useFakeTimers）。
import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

const SESSION_SAMPLE = { accessToken: "sample-token", user: { id: "user-config-1", status: "approved_active" } };

let fetchMock;

const stubJson = (body, status = 200) => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
};

const stubFetch = (implementation) => {
  fetchMock = vi.fn(implementation);
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

const validTargetSample = () => ({
  url: "https://storage.sample.local/presigned/sample-object",
  method: "POST",
  fileFieldName: "file",
  formData: { key: "sample-object" },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

const sampleFile = () => new File(["sample-receipt-bytes"], "sample-receipt.jpg", { type: "image/jpeg" });

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

describe("services/uploads（uploadToSignedTarget）契约", () => {
  it("method 非 POST → 立即 reject kind=upload、文案固定、retryable=false，且 fetch 未被调用", async () => {
    stubJson({});
    const uploads = await loadSrc("services/uploads.js");
    const target = { ...validTargetSample(), method: "PUT" };
    await assert.rejects(
      uploads.uploadToSignedTarget(target, sampleFile()),
      { name: "BusinessError", kind: "upload", message: "上传链接已失效，请重新上传", retryable: false },
    );
    assert.equal(fetchMock.mock.calls.length, 0, "参数校验失败不得发起任何网络请求");
  });

  it("expiresAt 已过期 → 立即 reject kind=upload，且 fetch 未被调用", async () => {
    stubJson({});
    const uploads = await loadSrc("services/uploads.js");
    const target = { ...validTargetSample(), expiresAt: new Date(Date.now() - 1000).toISOString() };
    await assert.rejects(
      uploads.uploadToSignedTarget(target, sampleFile()),
      { kind: "upload", message: "上传链接已失效，请重新上传", retryable: false },
    );
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("缺 fileFieldName → 立即 reject kind=upload，且 fetch 未被调用", async () => {
    stubJson({});
    const uploads = await loadSrc("services/uploads.js");
    const target = validTargetSample();
    delete target.fileFieldName;
    await assert.rejects(
      uploads.uploadToSignedTarget(target, sampleFile()),
      { kind: "upload", message: "上传链接已失效，请重新上传", retryable: false },
    );
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it("预签名端点返回非 2xx → reject 文案「暂时无法上传小票，请重试」（retryable）", async () => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "ACCESS_DENIED" } }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const uploads = await loadSrc("services/uploads.js");
    await assert.rejects(
      uploads.uploadToSignedTarget(validTargetSample(), sampleFile()),
      { kind: "upload", message: "暂时无法上传小票，请重试", retryable: true },
    );
  });

  it("网络失败（fetch reject）→ reject 文案「暂时无法上传小票，请检查网络后重试」（retryable）", async () => {
    stubFetch(async () => {
      throw new Error("network unreachable");
    });
    const uploads = await loadSrc("services/uploads.js");
    await assert.rejects(
      uploads.uploadToSignedTarget(validTargetSample(), sampleFile()),
      { kind: "upload", message: "暂时无法上传小票，请检查网络后重试", retryable: true },
    );
  });

  it("2xx 且带 ETag 响应头 → resolve { etag }，且 fetch 收到原样预签名 url 与 POST（R0 例外：运行时下发的绝对 URL）", async () => {
    const target = validTargetSample();
    fetchMock = vi.fn(async () => new Response(null, { status: 200, headers: { ETag: '"etag-1"' } }));
    vi.stubGlobal("fetch", fetchMock);
    const uploads = await loadSrc("services/uploads.js");
    const result = await uploads.uploadToSignedTarget(target, sampleFile());
    assert.deepEqual(result, { etag: '"etag-1"' });
    const [call] = callsOf();
    assert.equal(typeof call.raw, "string", "直传目标必须是字符串 URL（服务端下发 url 原样透传）");
    assert.equal(call.url, target.url, "必须直传服务端下发的预签名 url 原样（无 registry 条目，R0 运行时数据例外）");
    assert.equal(call.method, "POST");
  });
});

describe("services/public-config（loadPublicConfig）契约", () => {
  it("200 + 对象 → resolve 该对象；GET /api/public/client-config；即使有会话也不带 Bearer", async () => {
    (await loadSrc("store/session.js")).saveSession({ ...SESSION_SAMPLE, user: { ...SESSION_SAMPLE.user } });
    const sampleConfig = { captchaAppId: "sample-captcha-app-id", features: { authSelfService: true, receiptOcr: true } };
    stubJson(sampleConfig);
    const publicConfig = await loadSrc("services/public-config.js");
    const result = await publicConfig.loadPublicConfig();
    const [call] = callsOf();
    assert.equal(typeof call.raw, "string", "零域名 R0：fetch 第一参必须是字符串相对路径");
    assert.equal(call.url, endpointRegistry.public.clientConfig.pattern, "零域名 R0：必须逐字等于同源相对路径 /api/public/client-config");
    assert.equal(call.method, endpointRegistry.public.clientConfig.method);
    assert.equal(call.headers.get("authorization"), null, "契约 §3.6：client-config 无 Bearer");
    assert.deepEqual(result, sampleConfig);
  });

  it("200 + 非对象响应 → 返回 null（不抛错）", async () => {
    stubJson("sample-config-text");
    const publicConfig = await loadSrc("services/public-config.js");
    assert.equal(await publicConfig.loadPublicConfig(), null);
  });

  it("非 200 → 返回 null（不抛错）", async () => {
    stubJson({}, 503);
    const publicConfig = await loadSrc("services/public-config.js");
    assert.equal(await publicConfig.loadPublicConfig(), null);
  });

  it("网络失败（fetch reject）→ 返回 null（不抛错）", async () => {
    stubFetch(async () => {
      throw new Error("network unreachable");
    });
    const publicConfig = await loadSrc("services/public-config.js");
    assert.equal(await publicConfig.loadPublicConfig(), null);
  });

  it("5 秒超时 → 返回 null（不抛错）", async () => {
    const publicConfig = await loadSrc("services/public-config.js");
    vi.useFakeTimers();
    stubFetch(() => new Promise(() => {}));
    const promise = publicConfig.loadPublicConfig();
    await vi.advanceTimersByTimeAsync(5000);
    assert.equal(await promise, null);
  });
});

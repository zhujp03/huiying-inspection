// B 类端点契约测试：services/receipts（7 函数）。
// 依据：docs/web/module-contracts.md §3.4 与 §7 端点映射总表；method/path 以
// packages/contracts/endpoint-registry.js 为真源；请求体形状对照小程序
// apps/miniapp/miniprogram/services/api.js:87-93（只读参照，逐字来源）：
// initialize/complete body={fileMeta,revision}；deleteReceiptAttachment 为
// DELETE 带 body={dishHandling,revision}；OCR create/apply 携带 idempotencyKey。
// 零域名（R0 / testing §6）：每个端点用例断言 fetch 第一参为字符串、逐字等于
// registry 构造出的同源相对路径（registry item 的 path() 产物即相对路径字面量）。
//
// TDD 红灯基线：apps/web/src/** 尚未实现（第 2 段落地），本文件全部用例预期
// 因模块不存在（Cannot find module → apps/web/src/**）而失败——这是预期，不是 bug。
// 加载纪律：loadSrc 一律在 it 体内 await，禁止依赖钩子里的加载。
import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

const ATTEMPT_ID = "attempt-sample-1";
const ATTACHMENT_ID = "receipt-attachment-1";
const JOB_ID = "receipt-ocr-job-1";

// 响应体均满足 contracts.generated.js 的校验器（assertReceiptList/assertReceiptUploadInit/
// assertReceiptMutation/assertReceiptOcrJob/assertReceiptOcrApply），第 2 段实现后 validate 必须放行。
const UPLOAD_TARGET_SAMPLE = {
  url: "https://storage.sample.local/presigned/sample-receipt",
  method: "POST",
  fileFieldName: "file",
  formData: { key: "sample-receipt" },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const INIT_FILE_META_SAMPLE = {
  clientFileId: "client-file-1",
  fileName: "sample-receipt.jpg",
  contentType: "image/jpeg",
  sizeBytes: 4096,
};
const COMPLETE_FILE_META_SAMPLE = { clientFileId: "client-file-1", etag: '"etag-1"' };

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
  (await loadSrc("store/session.js")).saveSession({
    accessToken: "sample-token",
    user: { id: "user-1", status: "approved_active" },
  });
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

describe("services/receipts 端点契约（零域名 + Bearer + method/path/body 逐字对齐 registry）", () => {
  it("listReceiptAttachments：GET drafts.receiptAttachments(:attemptId)，返回整包列表响应", async () => {
    await seedSession();
    stubJson({ items: [], revision: 3 });
    const receipts = await loadSrc("services/receipts.js");
    const result = await receipts.listReceiptAttachments(ATTEMPT_ID);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.receiptAttachments.path(ATTEMPT_ID));
    assert.equal(call.method, endpointRegistry.drafts.receiptAttachments.method);
    assert.deepEqual(result, { items: [], revision: 3 });
  });

  it("initializeReceiptUpload：POST drafts.receiptUploads(:attemptId)，body={fileMeta,revision}（Bearer 三件套）", async () => {
    await seedSession();
    stubJson({ attachment: { id: ATTACHMENT_ID }, uploadTarget: UPLOAD_TARGET_SAMPLE, revision: 3 });
    const receipts = await loadSrc("services/receipts.js");
    const result = await receipts.initializeReceiptUpload(ATTEMPT_ID, INIT_FILE_META_SAMPLE, 3);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.receiptUploads.path(ATTEMPT_ID));
    assert.equal(call.method, endpointRegistry.drafts.receiptUploads.method);
    assert.deepEqual(call.body, { fileMeta: INIT_FILE_META_SAMPLE, revision: 3 });
    assert.equal(call.headers.get("authorization"), "Bearer sample-token");
    assertJsonHeaders(call);
    assert.deepEqual(result, { attachment: { id: ATTACHMENT_ID }, uploadTarget: UPLOAD_TARGET_SAMPLE, revision: 3 });
  });

  it("completeReceiptUpload：POST drafts.receiptComplete(:attemptId,:attachmentId)，body={fileMeta,revision}", async () => {
    await seedSession();
    stubJson({ revision: 4 });
    const receipts = await loadSrc("services/receipts.js");
    const result = await receipts.completeReceiptUpload(ATTEMPT_ID, ATTACHMENT_ID, COMPLETE_FILE_META_SAMPLE, 3);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.receiptComplete.path(ATTEMPT_ID, ATTACHMENT_ID));
    assert.equal(call.method, endpointRegistry.drafts.receiptComplete.method);
    assert.deepEqual(call.body, { fileMeta: COMPLETE_FILE_META_SAMPLE, revision: 3 });
    assert.deepEqual(result, { revision: 4 });
  });

  it("deleteReceiptAttachment：DELETE drafts.receiptAttachment(:attemptId,:attachmentId) 且携带 body={dishHandling,revision}", async () => {
    await seedSession();
    stubJson({ revision: 5 });
    const receipts = await loadSrc("services/receipts.js");
    const result = await receipts.deleteReceiptAttachment(ATTEMPT_ID, ATTACHMENT_ID, "keep_as_manual", 4);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.receiptAttachment.path(ATTEMPT_ID, ATTACHMENT_ID));
    assert.equal(call.method, endpointRegistry.drafts.receiptAttachment.method);
    assert.deepEqual(call.body, { dishHandling: "keep_as_manual", revision: 4 });
    assert.deepEqual(result, { revision: 5 });
  });

  it("createReceiptOcrJob：POST drafts.receiptOcrJobs(:attemptId)，body={attachmentIds,idempotencyKey,revision}", async () => {
    await seedSession();
    stubJson({ id: JOB_ID, status: "queued" });
    const receipts = await loadSrc("services/receipts.js");
    const result = await receipts.createReceiptOcrJob(ATTEMPT_ID, [ATTACHMENT_ID], "ocr-idempotency-key-1", 5);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.receiptOcrJobs.path(ATTEMPT_ID));
    assert.equal(call.method, endpointRegistry.drafts.receiptOcrJobs.method);
    assert.deepEqual(call.body, { attachmentIds: [ATTACHMENT_ID], idempotencyKey: "ocr-idempotency-key-1", revision: 5 });
    assert.deepEqual(result, { id: JOB_ID, status: "queued" });
  });

  it("getReceiptOcrJob：GET drafts.receiptOcrJob(:attemptId,:jobId)", async () => {
    await seedSession();
    stubJson({ id: JOB_ID, status: "succeeded" });
    const receipts = await loadSrc("services/receipts.js");
    const result = await receipts.getReceiptOcrJob(ATTEMPT_ID, JOB_ID);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.receiptOcrJob.path(ATTEMPT_ID, JOB_ID));
    assert.equal(call.method, endpointRegistry.drafts.receiptOcrJob.method);
    assert.deepEqual(result, { id: JOB_ID, status: "succeeded" });
  });

  it("applyReceiptOcrJob：POST drafts.receiptOcrApply(:attemptId,:jobId)，body={idempotencyKey,revision}（revision 取实参 dishRevision）", async () => {
    await seedSession();
    stubJson({ job: { id: JOB_ID, status: "succeeded" }, dishes: [], revision: 6 });
    const receipts = await loadSrc("services/receipts.js");
    const result = await receipts.applyReceiptOcrJob(ATTEMPT_ID, JOB_ID, "ocr-apply-key-1", 5);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.receiptOcrApply.path(ATTEMPT_ID, JOB_ID));
    assert.equal(call.method, endpointRegistry.drafts.receiptOcrApply.method);
    assert.deepEqual(call.body, { idempotencyKey: "ocr-apply-key-1", revision: 5 });
    assert.deepEqual(result, { job: { id: JOB_ID, status: "succeeded" }, dishes: [], revision: 6 });
  });
});

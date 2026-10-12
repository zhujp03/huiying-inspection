// B 类端点契约测试：services/drafts（12 函数 + 401 会话失效）。
// 依据：docs/web/module-contracts.md §3.3 与 §7 端点映射总表；method/path 以
// packages/contracts/endpoint-registry.js 为真源；请求体形状对照小程序
// apps/miniapp/miniprogram/services/api.js:77-86,94-95（只读参照，逐字来源）。
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
const QUESTION_ID = "question-sample-1";
const EDIT_SESSION_ID = "edit-session-sample-1";
const EVIDENCE_ID = "evidence-attachment-1";

// 响应体均满足 contracts.generated.js 的校验器（assertQuestionnaire/assertRevision/
// assertEditSession/assertUploadInit/assertSubmit），第 2 段实现后 validate 必须放行。
const UPLOAD_TARGET_SAMPLE = {
  url: "https://storage.sample.local/presigned/sample-object",
  method: "POST",
  fileFieldName: "file",
  formData: { key: "sample-object" },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const QUESTIONNAIRE_SAMPLE = {
  attempt: { id: ATTEMPT_ID, status: "in_progress", revision: 2 },
  questionnaireVersion: { id: "qv-sample-1" },
  questions: [],
  answers: {},
};

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

describe("services/drafts 端点契约（零域名 + Bearer + method/path/body 逐字对齐 registry）", () => {
  it("getDraft：GET /api/questionnaires/secret/drafts/:attemptId，响应经问卷校验器后原样返回", async () => {
    await seedSession();
    stubJson(QUESTIONNAIRE_SAMPLE);
    const drafts = await loadSrc("services/drafts.js");
    const result = await drafts.getDraft(ATTEMPT_ID);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.byId.path(ATTEMPT_ID));
    assert.equal(call.method, endpointRegistry.drafts.byId.method);
    assert.deepEqual(result, QUESTIONNAIRE_SAMPLE);
  });

  it("saveAnswer：PUT drafts.answer(:attemptId,:questionId)，body=实参 answer（Bearer 三件套）", async () => {
    await seedSession();
    stubJson({ revision: 3 });
    const drafts = await loadSrc("services/drafts.js");
    const answer = { answer: "scored", revision: 2 };
    const result = await drafts.saveAnswer(ATTEMPT_ID, QUESTION_ID, answer);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.answer.path(ATTEMPT_ID, QUESTION_ID));
    assert.equal(call.method, endpointRegistry.drafts.answer.method);
    assert.deepEqual(call.body, answer);
    assert.equal(call.headers.get("authorization"), "Bearer sample-token");
    assertJsonHeaders(call);
    assert.deepEqual(result, { revision: 3 });
  });

  it("createEditSession：POST drafts.editSessions(:attemptId,:questionId)，body=实参 payload", async () => {
    await seedSession();
    stubJson({ id: EDIT_SESSION_ID });
    const drafts = await loadSrc("services/drafts.js");
    const payload = { baseAnswerRevision: 2, targetAnswer: "unscored" };
    const result = await drafts.createEditSession(ATTEMPT_ID, QUESTION_ID, payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.editSessions.path(ATTEMPT_ID, QUESTION_ID));
    assert.equal(call.method, endpointRegistry.drafts.editSessions.method);
    assert.deepEqual(call.body, payload);
    assert.deepEqual(result, { id: EDIT_SESSION_ID });
  });

  it("updateEditSession：PATCH drafts.editSession(:attemptId,:questionId,:editSessionId)，body=实参 payload", async () => {
    await seedSession();
    stubJson({});
    const drafts = await loadSrc("services/drafts.js");
    const payload = { draftIssueRemark: "sample-remark", revision: 3 };
    await drafts.updateEditSession(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID, payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.editSession.path(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID));
    assert.equal(call.method, endpointRegistry.drafts.editSession.method);
    assert.deepEqual(call.body, payload);
  });

  it("initEvidenceUpload：POST drafts.evidenceUploads(...)，body=实参 payload", async () => {
    await seedSession();
    stubJson({ attachmentId: EVIDENCE_ID, uploadTarget: UPLOAD_TARGET_SAMPLE });
    const drafts = await loadSrc("services/drafts.js");
    const payload = { contentType: "image/jpeg", sizeBytes: 2048 };
    const result = await drafts.initEvidenceUpload(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID, payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.evidenceUploads.path(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID));
    assert.equal(call.method, endpointRegistry.drafts.evidenceUploads.method);
    assert.deepEqual(call.body, payload);
    assert.deepEqual(result, { attachmentId: EVIDENCE_ID, uploadTarget: UPLOAD_TARGET_SAMPLE });
  });

  it("completeEvidenceUpload：POST drafts.evidenceComplete(...:attachmentId/complete)，body=实参 payload", async () => {
    await seedSession();
    stubJson({});
    const drafts = await loadSrc("services/drafts.js");
    const payload = { uploadToken: "upload-token-1", sizeBytes: 2048, durationSeconds: null };
    await drafts.completeEvidenceUpload(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID, EVIDENCE_ID, payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.evidenceComplete.path(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID, EVIDENCE_ID));
    assert.equal(call.method, endpointRegistry.drafts.evidenceComplete.method);
    assert.deepEqual(call.body, payload);
  });

  it("removeEvidence：DELETE drafts.evidence(...:attachmentId)", async () => {
    await seedSession();
    stubJson({});
    const drafts = await loadSrc("services/drafts.js");
    await drafts.removeEvidence(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID, EVIDENCE_ID);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.evidence.path(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID, EVIDENCE_ID));
    assert.equal(call.method, endpointRegistry.drafts.evidence.method);
  });

  it("confirmIssue：POST drafts.confirmEdit(...)，body=实参 payload", async () => {
    await seedSession();
    stubJson({});
    const drafts = await loadSrc("services/drafts.js");
    const payload = { answer: "unscored", revision: 3 };
    await drafts.confirmIssue(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID, payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.confirmEdit.path(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID));
    assert.equal(call.method, endpointRegistry.drafts.confirmEdit.method);
    assert.deepEqual(call.body, payload);
  });

  it("cancelIssue：POST drafts.cancelEdit(...)", async () => {
    await seedSession();
    stubJson({});
    const drafts = await loadSrc("services/drafts.js");
    await drafts.cancelIssue(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.cancelEdit.path(ATTEMPT_ID, QUESTION_ID, EDIT_SESSION_ID));
    assert.equal(call.method, endpointRegistry.drafts.cancelEdit.method);
  });

  it("saveDishes：PUT drafts.dishes(:attemptId)，body=实参 payload", async () => {
    await seedSession();
    stubJson({ revision: 4 });
    const drafts = await loadSrc("services/drafts.js");
    const payload = { dishes: [{ name: "sample-dish", fulfillmentStatus: "ordered" }], revision: 3 };
    const result = await drafts.saveDishes(ATTEMPT_ID, payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.dishes.path(ATTEMPT_ID));
    assert.equal(call.method, endpointRegistry.drafts.dishes.method);
    assert.deepEqual(call.body, payload);
    assert.deepEqual(result, { revision: 4 });
  });

  it("saveOtherRecords：PUT drafts.otherRecords(:attemptId)，body=实参 data", async () => {
    await seedSession();
    stubJson({ revision: 5 });
    const drafts = await loadSrc("services/drafts.js");
    const data = { highlight: "sample-highlight", suggestion: "sample-suggestion", revision: 4 };
    const result = await drafts.saveOtherRecords(ATTEMPT_ID, data);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.otherRecords.path(ATTEMPT_ID));
    assert.equal(call.method, endpointRegistry.drafts.otherRecords.method);
    assert.deepEqual(call.body, data);
    assert.deepEqual(result, { revision: 5 });
  });

  it("submitQuestionnaire：POST drafts.submit(:attemptId)，body=实参 payload", async () => {
    await seedSession();
    stubJson({ status: "submitted" });
    const drafts = await loadSrc("services/drafts.js");
    const payload = { submitToken: "submit-token-1", assignmentRevision: 5, confirmation: true };
    const result = await drafts.submitQuestionnaire(ATTEMPT_ID, payload);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.drafts.submit.path(ATTEMPT_ID));
    assert.equal(call.method, endpointRegistry.drafts.submit.method);
    assert.deepEqual(call.body, payload);
    assert.deepEqual(result, { status: "submitted" });
  });

  it("getDraft 收到 401 → kind=session、会话被清空（R05/R86）", async () => {
    await seedSession();
    stubJson({ error: { code: "AUTH_INVALID" } }, 401);
    const drafts = await loadSrc("services/drafts.js");
    await assert.rejects(
      drafts.getDraft("attempt-unauthorized-1"),
      { name: "BusinessError", kind: "session", message: "登录已失效，请重新登录", retryable: false },
    );
    const session = await loadSrc("store/session.js");
    assert.equal(session.getSession(), null);
  });
});

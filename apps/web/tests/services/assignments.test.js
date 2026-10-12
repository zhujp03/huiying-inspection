// B 类端点契约测试：services/assignments（5 函数 + 任务列表短时缓存 R09/R10
// + 并发去重 R11 + 12 秒超时 + 401 会话失效）。
// 依据：docs/web/module-contracts.md §3.2 与 §7 端点映射总表；method/path 以
// packages/contracts/endpoint-registry.js 为真源；函数行为对照小程序
// apps/miniapp/miniprogram/services/api.js:64-76（只读参照，逐字来源）。
// 零域名（R0 / testing §6）：每个端点用例断言 fetch 第一参为字符串、逐字等于
// registry 构造出的同源相对路径（registry item 的 path() 产物即相对路径字面量）。
//
// TDD 红灯基线：apps/web/src/** 尚未实现（第 2 段落地），本文件全部用例预期
// 因模块不存在（Cannot find module → apps/web/src/**）而失败——这是预期，不是 bug。
// 加载纪律：loadSrc 一律在 it 体内 await（含 fake timers 用例：先 loadSrc 再 useFakeTimers）。
import { describe, it, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

let fetchMock;

const seedSession = async (userId) => {
  (await loadSrc("store/session.js")).saveSession({ accessToken: "sample-token", user: { id: userId, status: "approved_active" } });
};

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

// 零域名断言（R0 / testing §6）：fetch 第一参必须是字符串，且逐字等于期望的同源相对路径。
const assertRelativeUrl = (call, expectedPath) => {
  assert.equal(typeof call.raw, "string", "零域名 R0：fetch 第一参必须是字符串相对路径，不得传 URL 对象或绝对地址");
  assert.equal(call.url, expectedPath, "零域名 R0：请求地址必须逐字等于 /api 开头的同源相对路径（无 scheme/host）");
};

const assertJsonHeaders = (call) => {
  assert.equal(call.headers.get("accept"), "application/json");
  assert.equal(call.headers.get("content-type"), "application/json");
};

// 响应体均满足 contracts.generated.js 的校验器（assertAssignmentList/assertAssignment/
// assertStart/assertQuestionnaire），第 2 段实现后 validate 必须放行。
const MINE_SAMPLE = { items: [{ id: "assignment-mine-1", status: "assigned" }] };
const ASSIGNMENT_SAMPLE = { id: "assignment-sample-1", status: "assigned", storeName: "sample-store" };
const LOCATION_SAMPLE = { latitude: 31.2304, longitude: 121.4737, accuracy: 25, capturedAt: "2026-10-10T10:00:00+08:00" };
const START_SAMPLE = { attempt: { id: "attempt-start-1", revision: 0 }, questionnaireVersion: { id: "qv-start-1" } };
const QUESTIONNAIRE_SAMPLE = {
  attempt: { id: "attempt-sample-1", status: "in_progress", revision: 2 },
  questionnaireVersion: { id: "qv-sample-1" },
  questions: [],
  answers: {},
};

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  try {
    (await loadSrc("store/session.js")).clearSessionAndUserCache();
  } catch (error) {
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load url/.test(String(error?.message ?? error))) throw error;
  }
});

describe("services/assignments 端点契约（零域名 + Bearer + method/path/body 逐字对齐 registry）", () => {
  it("getMyAssignments：GET /api/assignments/mine，Bearer 三件套，结果返回 items 数组", async () => {
    await seedSession("user-assignments-1");
    stubJson(MINE_SAMPLE);
    const assignments = await loadSrc("services/assignments.js");
    const result = await assignments.getMyAssignments();
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.assignments.mine.pattern);
    assert.equal(call.method, endpointRegistry.assignments.mine.method);
    assert.equal(call.headers.get("authorization"), "Bearer sample-token");
    assertJsonHeaders(call);
    assert.deepEqual(result, MINE_SAMPLE.items);
  });

  it("getAssignment：GET /api/assignments/:id，路径参数替换为实参 id，Bearer 三件套", async () => {
    await seedSession("user-assignments-1");
    stubJson(ASSIGNMENT_SAMPLE);
    const assignments = await loadSrc("services/assignments.js");
    const result = await assignments.getAssignment("assignment-sample-1");
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.assignments.byId.path("assignment-sample-1"));
    assert.equal(call.method, endpointRegistry.assignments.byId.method);
    assert.equal(call.headers.get("authorization"), "Bearer sample-token");
    assertJsonHeaders(call);
    assert.deepEqual(result, ASSIGNMENT_SAMPLE);
  });

  it("checkIn：POST /api/assignments/:id/check-in，body=实参 location", async () => {
    await seedSession("user-assignments-1");
    stubJson({ result: "accepted" });
    const assignments = await loadSrc("services/assignments.js");
    const result = await assignments.checkIn("assignment-sample-1", LOCATION_SAMPLE);
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.assignments.checkIn.path("assignment-sample-1"));
    assert.equal(call.method, endpointRegistry.assignments.checkIn.method);
    assert.deepEqual(call.body, LOCATION_SAMPLE);
    assert.deepEqual(result, { result: "accepted" });
  });

  it("startAssignment：POST /api/assignments/:id/start，响应经校验器后原样返回", async () => {
    await seedSession("user-assignments-1");
    stubJson(START_SAMPLE);
    const assignments = await loadSrc("services/assignments.js");
    const result = await assignments.startAssignment("assignment-sample-1");
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.assignments.start.path("assignment-sample-1"));
    assert.equal(call.method, endpointRegistry.assignments.start.method);
    assert.deepEqual(result, START_SAMPLE);
  });

  it("getQuestionnaire：GET /api/assignments/:id/questionnaire，响应经校验器后原样返回", async () => {
    await seedSession("user-assignments-1");
    stubJson(QUESTIONNAIRE_SAMPLE);
    const assignments = await loadSrc("services/assignments.js");
    const result = await assignments.getQuestionnaire("assignment-sample-1");
    const [call] = callsOf();
    assertRelativeUrl(call, endpointRegistry.assignments.questionnaire.path("assignment-sample-1"));
    assert.equal(call.method, endpointRegistry.assignments.questionnaire.method);
    assert.deepEqual(result, QUESTIONNAIRE_SAMPLE);
  });

  it("任务列表两次调用命中缓存：fetch 仅 1 次且两次结果一致（R09/R10）", async () => {
    await seedSession("user-cache-1");
    stubJson({ items: [{ id: "assignment-cache-1", status: "assigned" }] });
    const assignments = await loadSrc("services/assignments.js");
    const first = await assignments.getMyAssignments();
    const second = await assignments.getMyAssignments();
    assert.equal(fetchMock.mock.calls.length, 1, "缓存命中时第二次调用不得再发请求");
    assert.deepEqual(second, first);
    assert.deepEqual(first, [{ id: "assignment-cache-1", status: "assigned" }]);
  });

  it("任务列表 {force:true} 跳过缓存：第二次重新发起请求（fetch 共 2 次）（R09）", async () => {
    await seedSession("user-force-1");
    stubJson({ items: [{ id: "assignment-force-1", status: "in_progress" }] });
    const assignments = await loadSrc("services/assignments.js");
    const first = await assignments.getMyAssignments();
    const second = await assignments.getMyAssignments({ force: true });
    assert.equal(fetchMock.mock.calls.length, 2, "force 调用必须绕过缓存重新请求");
    assert.deepEqual(second, first);
  });

  it("同 id 的 getAssignment 并发调用复用同一进行中请求：fetch 仅 1 次（R11）", async () => {
    await seedSession("user-dedupe-1");
    const assignments = await loadSrc("services/assignments.js");
    let releaseFetch;
    stubFetch(() => new Promise((resolve) => { releaseFetch = resolve; }));
    const first = assignments.getAssignment("assignment-dedupe-1");
    const second = assignments.getAssignment("assignment-dedupe-1");
    for (let i = 0; i < 5 && fetchMock.mock.calls.length === 0; i += 1) await Promise.resolve();
    assert.equal(fetchMock.mock.calls.length, 1, "进行中的同 id 请求必须合并为一次网络调用");
    releaseFetch(new Response(JSON.stringify({ id: "assignment-dedupe-1", status: "assigned" }), { status: 200 }));
    const [left, right] = await Promise.all([first, second]);
    assert.deepEqual(left, { id: "assignment-dedupe-1", status: "assigned" });
    assert.deepEqual(right, left);
  });

  it("getAssignment 请求 12 秒未返回 → kind=timeout、文案固定（retryable）（R87）", async () => {
    await seedSession("user-timeout-1");
    const assignments = await loadSrc("services/assignments.js");
    vi.useFakeTimers();
    stubFetch(() => new Promise(() => {}));
    const pending = assert.rejects(
      assignments.getAssignment("assignment-timeout-1"),
      { kind: "timeout", message: "请求超时，请检查网络后重试", retryable: true },
    );
    await vi.advanceTimersByTimeAsync(12000);
    await pending;
  });

  it("getAssignment 收到 401 → kind=session、会话被清空（R05/R86）", async () => {
    await seedSession("user-unauthorized-1");
    stubJson({ error: { code: "AUTH_INVALID" } }, 401);
    const assignments = await loadSrc("services/assignments.js");
    await assert.rejects(
      assignments.getAssignment("assignment-unauthorized-1"),
      { name: "BusinessError", kind: "session", message: "登录已失效，请重新登录", retryable: false },
    );
    const session = await loadSrc("store/session.js");
    assert.equal(session.getSession(), null);
  });
});

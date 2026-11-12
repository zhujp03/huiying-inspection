// 其他记录/提交页对齐 H5（WEB/pages/OtherPage.jsx）：任务 revision 严格化 + 提交错误三态分流。
// 1) load：assignmentRevision 只取任务 revision，非整数报「任务信息已过期」，绝不兜底 attempt revision；
// 2) saveRecords：只认 saved.assignmentRevision，缺失保留旧值（绝不回退 saved.revision）；
// 3) requireFreshAssignment：revision 非整数拦截提交（不发请求、清 token、refresh_required）；
// 4) handleSubmitError 优先级：已提交终态 > 可重试（保 token）> 需换 token（清 token+刷新）> 终态失败；
// 5) WXML：refresh_required 提供「刷新」按钮重跑 load。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const mini = join(repoRoot, "apps/miniapp/miniprogram");

const SESSION_KEY = "junde:session";
const DRAFT_KEY = "junde:survey:user-1:assignment-1:attempt-1:qv-1";
const ASSIGNMENT_URL = "https://api.test/api/assignments/assignment-1";
const DRAFT_URL = "https://api.test/api/questionnaires/secret/drafts/attempt-1";
const OTHER_RECORDS_URL = `${DRAFT_URL}/other-records`;
const SUBMIT_URL = "https://api.test/api/questionnaires/secret/attempt-1/submit";
const onLoadOptions = { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "5" };

afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; });

function memoryWx(overrides = {}) {
  const storage = new Map();
  const wx = {
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ""),
    setStorageSync: (key, value) => { storage.set(key, value); },
    removeStorageSync: (key) => { storage.delete(key); },
    // secureUuid 的确定性随机源：同一批调用产出同一 token，便于断言「同 token 重试」。
    getRandomValues: (bytes) => { for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 3) % 256; },
    request: () => ({}),
    showToast: vi.fn(),
    redirectTo: vi.fn(),
    ...overrides,
  };
  storage.set(SESSION_KEY, { accessToken: "token", user: { id: "user-1" } });
  return { wx, storage };
}

function assignmentPayload(revision) {
  const payload = { id: "assignment-1", status: "in_progress" };
  if (revision !== undefined) payload.revision = revision;
  return payload;
}

function draftPayload() {
  return {
    attempt: { id: "attempt-1", status: "in_progress", revision: 5 },
    questionnaireVersion: { id: "qv-1" },
    questions: [],
    answers: {},
    otherRecords: {},
  };
}

function ok(options, data) { options.success({ statusCode: 200, data }); }
function failWith(options, statusCode, data) { options.success({ statusCode, data }); }

function defaultRoute(options) {
  if (options.url === ASSIGNMENT_URL) ok(options, assignmentPayload(9));
  else if (options.url === DRAFT_URL) ok(options, draftPayload());
  // 每条请求都必须应答：api.js 的模块级 pending Map 按 dedupeKey 复用在途请求，
  // 任何未应答请求都会让同 token 的后续用例复用旧 promise 而挂起。
  else if (options.url === SUBMIT_URL) ok(options, { status: "submitted", submittedAt: "2026-11-10T10:00:00+08:00" });
}

const PAGE_PATH = "../../apps/miniapp/miniprogram/pages/other/index.js";

async function loadOtherPage(tag) {
  let pageConfig;
  globalThis.Page = (config) => { pageConfig = config; };
  await import(`${PAGE_PATH}?${tag}`);
  return pageConfig;
}

function makeContext(pageConfig, extras = {}) {
  const data = JSON.parse(JSON.stringify(pageConfig.data));
  return { ...pageConfig, data, setData(patch) { Object.assign(this.data, patch); }, ...extras };
}

async function setup(tag, route = defaultRoute) {
  const requests = [];
  const { wx, storage } = memoryWx({
    request: (options) => { requests.push(options); route(options); return {}; },
  });
  globalThis.wx = wx;
  globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
  const pageConfig = await loadOtherPage(tag);
  const context = makeContext(pageConfig);
  return { pageConfig, context, wx, storage, requests };
}

async function loadReady(tag, route = defaultRoute) {
  const suite = await setup(tag, route);
  await suite.pageConfig.onLoad.call(suite.context, onLoadOptions);
  return suite;
}

const submitRequests = (requests) => requests.filter((options) => options.url === SUBMIT_URL);

describe("其他页 load：任务 revision 严格化（对齐 OtherPage load）", () => {
  it("assignment.revision 非整数时报「任务信息已过期」，绝不兜底 attempt revision", async () => {
    const { pageConfig, context } = await setup("parity-other-load-strict", (options) => {
      if (options.url === ASSIGNMENT_URL) ok(options, assignmentPayload(undefined));
      else if (options.url === DRAFT_URL) ok(options, draftPayload());
    });
    await pageConfig.onLoad.call(context, onLoadOptions);
    expect(context.data.message).toBe("任务信息已过期，请刷新后重试");
    expect(context.data.loading).toBe(false);
    expect(context.assignmentRevision).toBeUndefined();
  });

  it("assignment.revision 为整数时采用任务 revision（不用 attempt revision）", async () => {
    const { context } = await loadReady("parity-other-load-int");
    expect(context.assignmentRevision).toBe(9);
    expect(context.routeMeta.revision).toBe(5);
    expect(context.data.loading).toBe(false);
  });
});

describe("其他页 saveRecords：assignmentRevision 只认服务端返回", () => {
  it("saved.assignmentRevision 存在时优先采用", async () => {
    const { pageConfig, context } = await loadReady("parity-other-save-pref", (options) => {
      if (options.url === OTHER_RECORDS_URL) ok(options, { revision: 12, assignmentRevision: 10 });
      else defaultRoute(options);
    });
    await pageConfig.saveRecords.call(context);
    expect(context.assignmentRevision).toBe(10);
  });

  it("saved.assignmentRevision 缺失时保留旧值，绝不回退 saved.revision", async () => {
    const { pageConfig, context } = await loadReady("parity-other-save-keep", (options) => {
      if (options.url === OTHER_RECORDS_URL) ok(options, { revision: 12, assignmentRevision: null });
      else defaultRoute(options);
    });
    await pageConfig.saveRecords.call(context);
    expect(context.assignmentRevision).toBe(9);
  });
});

describe("其他页 requireFreshAssignment：非整数 revision 拦截提交", () => {
  it("非整数：返回 false、清 token、refresh_required；submit/submitWithExistingToken 均不发请求", async () => {
    const { pageConfig, context, requests } = await loadReady("parity-other-guard-block");
    context.assignmentRevision = "9";
    context.submitToken = "t-1";
    expect(pageConfig.requireFreshAssignment.call(context)).toBe(false);
    expect(context.submitToken ?? null).toBeNull();
    expect(context.data.submitState).toBe("refresh_required");
    expect(context.data.message).toBe("任务信息已过期，请刷新后重试");
    await pageConfig.submit.call(context);
    expect(submitRequests(requests)).toHaveLength(0);
    context.submitToken = "t-2";
    await pageConfig.submitWithExistingToken.call(context);
    expect(submitRequests(requests)).toHaveLength(0);
    expect(context.submitToken ?? null).toBeNull();
  });

  it("整数 revision 放行：submit 正常发出且载荷带任务 revision（≠ attempt revision）", async () => {
    const { pageConfig, context, requests } = await loadReady("parity-other-guard-pass");
    expect(pageConfig.requireFreshAssignment.call(context)).toBe(true);
    expect(context.data.submitState).toBe("draft");
    await pageConfig.submit.call(context);
    const submits = submitRequests(requests);
    expect(submits).toHaveLength(1);
    expect(submits[0].data.assignmentRevision).toBe(9);
  });
});

describe("其他页 handleSubmitError：提交错误三态分流（对齐 OtherPage handleSubmitError）", () => {
  it("409 QUESTIONNAIRE_SUBMITTED：清草稿与 token，toast 后回任务详情（带 source）", async () => {
    const { pageConfig, context, wx, storage } = await setup("parity-other-submitted", (options) => {
      if (options.url === SUBMIT_URL) failWith(options, 409, { error: { code: "QUESTIONNAIRE_SUBMITTED", message: "问卷已提交" } });
      else defaultRoute(options);
    });
    await pageConfig.onLoad.call(context, onLoadOptions);
    storage.set(DRAFT_KEY, { revision: 5, synced: true, suggestion: "草稿" });
    await pageConfig.submit.call(context);
    expect(storage.has(DRAFT_KEY)).toBe(false);
    expect(context.submitToken ?? null).toBeNull();
    expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "该任务已提交" }));
    expect(wx.redirectTo).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/pages/task/index?assignmentId=assignment-1&source=") }));
  });

  it("409 SUBMIT_PROCESSING（retryable）：保留 token 同 token 重试，重试成功进入 submitted", async () => {
    let submitOk = false;
    const { pageConfig, context, requests } = await setup("parity-other-retryable-retry", (options) => {
      if (options.url === SUBMIT_URL) {
        if (submitOk) ok(options, { status: "submitted", submittedAt: "2026-11-10T10:00:00+08:00" });
        else failWith(options, 409, { error: { code: "SUBMIT_PROCESSING", message: "提交处理中，请稍候", retryable: true } });
        return;
      }
      defaultRoute(options);
    });
    await pageConfig.onLoad.call(context, onLoadOptions);
    await pageConfig.submit.call(context);
    const token = context.submitToken;
    expect(token).toBeTruthy();
    expect(context.data.submitState).toBe("retryable_failed");
    expect(context.data.message).toBe("提交处理中，请稍候，可以重试提交");
    submitOk = true;
    await pageConfig.submitWithExistingToken.call(context);
    const submits = submitRequests(requests);
    expect(submits).toHaveLength(2);
    expect(submits[0].data.submitToken).toBe(token);
    expect(submits[1].data.submitToken).toBe(token);
    expect(context.data.submitState).toBe("submitted");
  });

  it("409 requiresNewToken（TASK_OVERDUE）：清 token 转 refresh_required，刷新后回 draft 可重新提交", async () => {
    let submitOk = false;
    const { pageConfig, context, requests } = await setup("parity-other-refresh-required", (options) => {
      if (options.url === SUBMIT_URL) {
        if (submitOk) ok(options, { status: "submitted", submittedAt: "2026-11-10T10:00:00+08:00" });
        else failWith(options, 409, { error: { code: "TASK_OVERDUE", message: "任务已逾期，无法提交", requiresNewToken: true } });
        return;
      }
      defaultRoute(options);
    });
    await pageConfig.onLoad.call(context, onLoadOptions);
    await pageConfig.submit.call(context);
    expect(context.submitToken ?? null).toBeNull();
    expect(context.data.submitState).toBe("refresh_required");
    expect(context.data.message).toBe("任务已逾期，无法提交");
    // 「刷新」按钮入口 retryLoad 即透传 load()（fire-and-forget）；此处 await load 验证刷新后回 draft。
    await pageConfig.load.call(context);
    expect(context.data.submitState).toBe("draft");
    expect(context.data.message).toBe("");
    submitOk = true;
    await pageConfig.submit.call(context);
    expect(context.data.submitState).toBe("submitted");
    expect(submitRequests(requests)[1].data.assignmentRevision).toBe(9);
  });

  it("requiresNewToken 且无 message：回退默认文案「任务信息已更新，请刷新后重试」", async () => {
    const { pageConfig, context } = await loadReady("parity-other-refresh-default");
    pageConfig.handleSubmitError.call(context, { requiresNewToken: true });
    expect(context.data.submitState).toBe("refresh_required");
    expect(context.data.message).toBe("任务信息已更新，请刷新后重试");
  });

  it("其它错误（403）：清 token 转 terminal_failed，用 error.message", async () => {
    const { pageConfig, context } = await setup("parity-other-terminal-403", (options) => {
      if (options.url === SUBMIT_URL) failWith(options, 403, {});
      else defaultRoute(options);
    });
    await pageConfig.onLoad.call(context, onLoadOptions);
    await pageConfig.submit.call(context);
    expect(context.submitToken ?? null).toBeNull();
    expect(context.data.submitState).toBe("terminal_failed");
    expect(context.data.message).toBe("你没有权限进行此操作");
  });

  it("terminal 无 message 回退「提交未完成」；优先级 questionnaire_submitted > retryable > requiresNewToken", async () => {
    const { pageConfig, context, wx } = await loadReady("parity-other-priority");
    pageConfig.handleSubmitError.call(context, {});
    expect(context.data.submitState).toBe("terminal_failed");
    expect(context.data.message).toBe("提交未完成");
    // questionnaire_submitted 压过 retryable：走回任务详情而非可重试态。
    pageConfig.handleSubmitError.call(context, { kind: "questionnaire_submitted", retryable: true, message: "x" });
    expect(wx.redirectTo).toHaveBeenCalled();
    expect(context.data.submitState).not.toBe("retryable_failed");
    // retryable 压过 requiresNewToken：token 保留。
    context.submitToken = "t-keep";
    pageConfig.handleSubmitError.call(context, { retryable: true, requiresNewToken: true, message: "y" });
    expect(context.submitToken).toBe("t-keep");
    expect(context.data.submitState).toBe("retryable_failed");
    expect(context.data.message).toBe("y，可以重试提交");
  });
});

describe("其他页静态契约（WXML 刷新按钮 / 兜底链删除 / 现有链路不变）", () => {
  const pageJs = readFileSync(join(mini, "pages/other/index.js"), "utf8");
  const pageWxml = readFileSync(join(mini, "pages/other/index.wxml"), "utf8");

  it("refresh_required 时消息区提供「刷新」按钮，点击 retryLoad；wxml 无用户可见工程信息", () => {
    expect(pageWxml).toContain(`wx:if="{{submitState === 'refresh_required'}}"`);
    expect(pageWxml).toContain(`bindtap="retryLoad"`);
    expect(pageWxml).toContain(">刷新</button>");
    for (const pattern of [/\/api\//i, /revision/i, /submit\s*token/i, /attempt\s*id/i, /409\s*Conflict/i]) {
      expect(pattern.test(pageWxml)).toBe(false);
    }
  });

  it("页面含守卫与错误分流实现标记；revision 兜底链已删除", () => {
    expect(pageJs).toContain("requireFreshAssignment");
    expect(pageJs).toContain("handleSubmitError");
    expect(pageJs).toContain("任务信息已过期，请刷新后重试");
    expect(pageJs).toContain("任务信息已更新，请刷新后重试");
    expect(pageJs).not.toContain("?? this.routeMeta.revision");
    expect(pageJs).not.toContain("?? saved.revision");
    expect(pageJs).not.toContain("?? result.assignment?.revision ?? meta.revision");
  });

  it("locked/确认弹窗/得分预览链路保持不变", () => {
    expect(pageJs).toContain("locked()");
    expect(pageJs).toContain("openConfirmModal");
    expect(pageJs).toContain("fetchConfirmScore");
    expect(pageJs).toContain("confirmModalSubmit");
  });
});

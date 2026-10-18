// 小程序适配批次路 B：问题页编辑会话恢复 + 断点续答回读锁定测试。
// mock 全局 wx/getApp 后加载真实 Page 配置：wx.request 按 url+method 分流
// （POST edit-sessions=创建/恢复、POST cancel=取消、POST confirm=确认、PATCH edit-sessions/:id=暂存）。
// 注意：cancel/confirm 的真实 URL 均含 "/edit-sessions" 子串，分流取首个命中，
// 因此 /cancel、/confirm 等更具体的路由必须排在 /edit-sessions 之前，否则被遮蔽成死路由。
import { afterEach, describe, expect, it, vi } from "vitest";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mergeData(pageConfig, overrides = {}) {
  const data = JSON.parse(JSON.stringify(pageConfig.data));
  Object.assign(data, overrides);
  return data;
}
function makeContext(pageConfig, data, extras = {}) {
  return { ...pageConfig, data, setData(patch) { Object.assign(this.data, patch); }, ...extras };
}

const question = {
  id: "q-1",
  type: "issue",
  title: "问题记录",
  evidence: { imageMaxCount: 3, imageRequired: true, audioRequired: false, audioMaxDurationSeconds: 10 },
};

// 回读附件契约：[{id,type,mimeType,sizeBytes,durationSeconds,status,previewUrl,previewExpiresAt}]，仅 status='active'。
const imageAttachment = { id: "att-1", type: "image", mimeType: "image/jpeg", sizeBytes: 1024, durationSeconds: null, status: "active", previewUrl: "https://cos.test/p1", previewExpiresAt: "2026-12-31T00:00:00Z" };
const audioAttachment = { id: "att-2", type: "audio", mimeType: "audio/mpeg", sizeBytes: 2048, durationSeconds: 5, status: "active", previewUrl: "https://cos.test/a1", previewExpiresAt: "2026-12-31T00:00:00Z" };

function questionnairePayload({ attachments = [], remark = "" } = {}) {
  return {
    attempt: { id: "attempt-1", revision: 2 },
    questionnaireVersion: { id: "qv-1" },
    questions: [question],
    answers: { "q-1": { answer: "unscored", remark, revision: 1, attachments } },
  };
}

function installWxRouter(routes = []) {
  const requests = [];
  globalThis.wx = {
    getStorageSync: () => null,
    request: (options) => {
      requests.push({ url: options.url, method: options.method, data: options.data });
      const route = routes.find((entry) => options.url.includes(entry.match) && options.method === entry.method);
      if (!route) return options.success({ statusCode: 200, data: {} });
      if (route.status >= 400) options.success({ statusCode: route.status, data: route.body || { error: { code: "EDIT_SESSION_CLOSED", message: "会话已关闭" } } });
      else options.success({ statusCode: route.status, data: route.body });
    },
    navigateBack: vi.fn(),
    redirectTo: vi.fn(),
    showToast: vi.fn(),
    chooseMedia: vi.fn(),
    getRecorderManager: () => ({ onStop: vi.fn(), start: vi.fn(), stop: vi.fn() }),
    createInnerAudioContext: vi.fn(() => ({ play: vi.fn(), destroy: vi.fn() })),
    uploadFile: vi.fn(),
  };
  // 正常链路（问卷 navigateTo 问题页）的页面栈：保存/取消后原生返回问卷。
  // 同任务校验依赖父页 route 与业务 ID；fallbackUrl 兜底由 redirectTo 承接。
  globalThis.getCurrentPages = () => [
    { route: "pages/survey/index", options: { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "2" } },
    { route: "pages/issue/index", options: {} },
  ];
  return requests;
}
function installApp() {
  globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
}
const onLoadOptions = { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", questionId: "q-1", revision: "2", target: "unscored" };
const countCancel = (requests) => requests.filter((r) => r.method === "POST" && r.url.includes("/cancel")).length;
// 每个用例用唯一静态 query 导入页面模块（vite 动态 import 需静态可分析，且 query 不同才能重新执行 Page()）。

describe("问题页编辑会话回读恢复（断点续写）", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("恢复场景：既有 open 会话优先，remark 取会话备注，附件按类型回填含回读 active 附件", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-adapt-r1");
    // 后端恢复语义：撞 open 唯一索引时直接返回既有会话（draftIssueRemark 非空，activeAttachments 与回读重叠）。
    installWxRouter([
      { match: "/questionnaire", method: "GET", status: 200, body: questionnairePayload({ attachments: [imageAttachment, audioAttachment], remark: "旧说明" }) },
      { match: "/edit-sessions", method: "POST", status: 200, body: { id: "edit-existing", status: "open", draftIssueRemark: "会话中的说明", activeAttachments: [imageAttachment, audioAttachment] } },
    ]);
    installApp();
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    await pageConfig.onLoad.call(context, onLoadOptions);
    await flush();
    expect(context.data.loading).toBe(false);
    expect(context.data.error).toBe("");
    expect(context.data.editSessionId).toBe("edit-existing");
    expect(context.data.remark).toBe("会话中的说明");
    expect(context.data.images).toHaveLength(1);
    expect(context.data.images[0]).toMatchObject({ id: "att-1", type: "image", status: "active", previewUrl: "https://cos.test/p1" });
    expect(context.data.audios).toHaveLength(1);
    expect(context.data.audios[0]).toMatchObject({ id: "att-2", type: "audio", status: "active", previewUrl: "https://cos.test/a1" });
  });

  it("activeAttachments 为空数组时回填空数组不报错，draftIssueRemark 为空时 remark 回退回读备注", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-adapt-r2");
    installWxRouter([
      { match: "/questionnaire", method: "GET", status: 200, body: questionnairePayload({ attachments: [], remark: "旧说明" }) },
      { match: "/edit-sessions", method: "POST", status: 200, body: { id: "edit-new", status: "open", draftIssueRemark: null, activeAttachments: [] } },
    ]);
    installApp();
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    await pageConfig.onLoad.call(context, onLoadOptions);
    await flush();
    expect(context.data.loading).toBe(false);
    expect(context.data.error).toBe("");
    expect(context.data.editSessionId).toBe("edit-new");
    expect(context.data.images).toEqual([]);
    expect(context.data.audios).toEqual([]);
    expect(context.data.remark).toBe("旧说明");
  });
});

describe("问题页保存计数口径（unscored 证据判定）", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("active（回读）与 staged_ready（本会话）附件均通过校验，发起 PATCH+confirm 并返回", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-adapt-c1");
    const requests = installWxRouter();
    installApp();
    const context = makeContext(pageConfig, mergeData(pageConfig, {
      meta: { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 2 },
      question: { ...question, evidence: { imageMaxCount: 3, imageRequired: true, audioRequired: true, audioMaxDurationSeconds: 10 } },
      editSessionId: "edit-1", target: "unscored", remark: "说明",
      images: [{ id: "att-1", type: "image", status: "active" }],
      audios: [{ id: "att-2", type: "audio", status: "staged_ready" }],
    }), {});
    await pageConfig.save.call(context);
    await flush();
    expect(requests.some((r) => r.method === "PATCH" && r.url.includes("/edit-sessions/edit-1"))).toBe(true);
    expect(requests.some((r) => r.method === "POST" && r.url.includes("/confirm"))).toBe(true);
    expect(globalThis.wx.navigateBack).toHaveBeenCalledTimes(1);
    expect(context.data.saving).toBe(false);
  });

  it("存在 uploading 附件时阻止保存并提示等待", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-adapt-c2");
    const requests = installWxRouter();
    installApp();
    const context = makeContext(pageConfig, mergeData(pageConfig, {
      meta: { attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 2 },
      question,
      editSessionId: "edit-1", target: "unscored", remark: "说明",
      images: [{ id: "att-1", type: "image", status: "active" }, { id: "local-1", type: "image", status: "uploading" }],
      audios: [],
    }), {});
    await pageConfig.save.call(context);
    await flush();
    expect(globalThis.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "请等待附件上传完成" }));
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
    expect(requests.some((r) => r.url.includes("/confirm"))).toBe(false);
  });

  it("照片选填：全部照片 failed（或无照片）+ 说明非空可保存（历史 imageRequired 不再强制）", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-adapt-c3");
    const requests = installWxRouter();
    installApp();
    const context = makeContext(pageConfig, mergeData(pageConfig, {
      meta: { attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 2 },
      question,
      editSessionId: "edit-1", target: "unscored", remark: "说明",
      images: [{ id: "local-1", type: "image", status: "failed" }],
      audios: [],
    }), {});
    await pageConfig.save.call(context);
    await flush();
    // 2026-10：问题照片全面选填——无成功照片不再阻断保存，PATCH/confirm 正常发出。
    expect(requests.some((r) => r.method === "PATCH")).toBe(true);
    expect(requests.some((r) => r.url.includes("/confirm"))).toBe(true);
  });
});

describe("问题页返回键尽力取消编辑会话", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("未 settled 时 onUnload 发出 cancel 请求，失败（409）不抛异常", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-adapt-u1");
    const requests = installWxRouter([
      { match: "/questionnaire", method: "GET", status: 200, body: questionnairePayload({}) },
      { match: "/cancel", method: "POST", status: 409 },
      { match: "/edit-sessions", method: "POST", status: 200, body: { id: "edit-open", status: "open", draftIssueRemark: null, activeAttachments: [] } },
    ]);
    installApp();
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    await pageConfig.onLoad.call(context, onLoadOptions);
    await flush();
    expect(context.data.editSessionId).toBe("edit-open");
    pageConfig.onUnload.call(context);
    await flush();
    await flush();
    expect(countCancel(requests)).toBe(1);
  });

  it("save 成功后（settled）onUnload 不再发起 cancel", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-adapt-u2");
    const requests = installWxRouter([
      { match: "/questionnaire", method: "GET", status: 200, body: questionnairePayload({}) },
      { match: "/confirm", method: "POST", status: 200, body: {} },
      { match: "/edit-sessions", method: "POST", status: 200, body: { id: "edit-open", status: "open", draftIssueRemark: null, activeAttachments: [] } },
    ]);
    installApp();
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    await pageConfig.onLoad.call(context, onLoadOptions);
    await flush();
    // 聚焦会话生命周期：关掉证据必填，避免 save 被计数校验拦截。
    context.data.question = { ...context.data.question, evidence: { imageMaxCount: 3, imageRequired: false, audioRequired: false, audioMaxDurationSeconds: 10 } };
    context.data.remark = "说明";
    await pageConfig.save.call(context);
    await flush();
    expect(countCancel(requests)).toBe(0);
    pageConfig.onUnload.call(context);
    await flush();
    expect(countCancel(requests)).toBe(0);
    expect(globalThis.wx.navigateBack).toHaveBeenCalledTimes(1);
  });

  it("cancel 成功后（settled）onUnload 不重复取消", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-adapt-u3");
    const requests = installWxRouter([
      { match: "/questionnaire", method: "GET", status: 200, body: questionnairePayload({}) },
      { match: "/cancel", method: "POST", status: 200, body: {} },
      { match: "/edit-sessions", method: "POST", status: 200, body: { id: "edit-open", status: "open", draftIssueRemark: null, activeAttachments: [] } },
    ]);
    installApp();
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    await pageConfig.onLoad.call(context, onLoadOptions);
    await flush();
    await pageConfig.cancel.call(context);
    await flush();
    expect(countCancel(requests)).toBe(1);
    pageConfig.onUnload.call(context);
    await flush();
    expect(countCancel(requests)).toBe(1);
    expect(globalThis.wx.navigateBack).toHaveBeenCalledTimes(1);
  });

  it("loading 失败页（editSessionId 为空）onUnload 不发任何请求", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-adapt-u4");
    const requests = installWxRouter();
    installApp();
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    await pageConfig.onLoad.call(context, {});
    await flush();
    expect(context.data.error).toBe("未找到题目，请返回问卷重试");
    pageConfig.onUnload.call(context);
    await flush();
    expect(requests).toHaveLength(0);
  });
});

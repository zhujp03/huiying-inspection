// 问题编辑页 H5 对齐回归（IssuePage）：mock 全局 wx/getApp/Page 后加载真实页面配置，
// 直接驱动 onLoad/stageFile/remark/toggleRecord/onUnload/play 断言行为；WXML/JS 源码做静态断言。
// 覆盖：①revision 以服务端为准并随 complete 单调推进（并发乱序只前进）
// ②local- 临时 id 用实例计数器防撞 ③确认按钮就地校验（remarkMissing）
// ④录音 onError 复位/onUnload 丢弃在录音频 ⑤播放 onError 提示 ⑥WXML 提示文案与禁词护栏。
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";

const issueDir = resolve(import.meta.dirname, "../../apps/miniapp/miniprogram/pages/issue");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mergeData(pageConfig, overrides = {}) {
  const data = JSON.parse(JSON.stringify(pageConfig.data));
  Object.assign(data, overrides);
  return data;
}
function makeContext(pageConfig, data, extras = {}) {
  return { ...pageConfig, data, setData(patch) { Object.assign(this.data, patch); }, ...extras };
}

const question = { id: "q-1", type: "issue", evidence: { imageMaxCount: 3, audioRequired: false, audioMaxDurationSeconds: 10 } };
const uploadTarget = { url: "https://cos.test/bucket", method: "POST", fileFieldName: "file", formData: { key: "x" }, expiresAt: "2030-01-01T00:00:00Z" };

function questionnairePayload({ revision = 2, remark = "" } = {}) {
  return {
    attempt: { id: "attempt-1", revision },
    questionnaireVersion: { id: "qv-1" },
    questions: [question],
    answers: { "q-1": { answer: "unscored", remark, revision: 1, attachments: [] } },
  };
}

// wx.request 分流 mock：具体路由（/cancel、/confirm、/complete）必须排在 /edit-sessions、
// /evidence-uploads 之前（URL 互相包含）；route.defer=true 时挂起，用例手动放行以模拟并发乱序；
// route.body 为函数时按请求动态生成响应。
function installWx(routes = []) {
  const requests = [];
  const pending = [];
  globalThis.wx = {
    getStorageSync: () => null,
    request: (options) => {
      requests.push({ url: options.url, method: options.method, data: options.data });
      const route = routes.find((entry) => options.url.includes(entry.match) && options.method === entry.method);
      if (!route) return options.success({ statusCode: 200, data: {} });
      if (route.defer) { pending.push({ route, options }); return; }
      options.success({ statusCode: route.status || 200, data: typeof route.body === "function" ? route.body(options) : route.body });
    },
    uploadFile: (options) => { options.success({ statusCode: 200, header: { ETag: "etag-1" } }); return { onProgressUpdate() {} }; },
    showToast: vi.fn(),
    getRecorderManager: () => ({ onStop: vi.fn(), onError: vi.fn(), start: vi.fn(), stop: vi.fn() }),
    createInnerAudioContext: vi.fn(() => ({ play: vi.fn(), destroy: vi.fn(), onError: vi.fn() })),
  };
  globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
  return { requests, pending, showToast: globalThis.wx.showToast };
}

const onLoadOptions = { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", questionId: "q-1", revision: "2", target: "unscored" };
// 上传链路由（顺序敏感）：/complete 先于 /evidence-uploads（complete URL 同时含两者子串）。
const uploadRoutes = ({ initBody, completeBody, deferComplete = false } = {}) => [
  { match: "/complete", method: "POST", body: completeBody, defer: deferComplete },
  { match: "/evidence-uploads", method: "POST", body: initBody },
];
const readyBody = (revision) => ({ status: "staged_ready", revision });
const initBody = (options) => ({ attachmentId: options.data.type === "image" ? "att-i" : "att-a", uploadToken: "tok-1", uploadTarget });

function stagedContext(pageConfig, overrides = {}) {
  return makeContext(pageConfig, mergeData(pageConfig, {
    meta: { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 2 },
    question, editSessionId: "edit-1", target: "unscored", remark: "说明",
    images: [], audios: [],
    ...overrides,
  }), {});
}

describe("onLoad：revision 以服务端为准 + remarkMissing 初值", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("服务端 attempt.revision 覆盖 URL 旧值写入 meta（建会话前）", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-r1");
    installWx([
      { match: "/questionnaire", method: "GET", body: questionnairePayload({ revision: 5 }) },
      { match: "/edit-sessions", method: "POST", body: { id: "edit-1", status: "open", draftIssueRemark: "", activeAttachments: [] } },
    ]);
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    await pageConfig.onLoad.call(context, onLoadOptions);
    await flush();
    expect(context.data.loading).toBe(false);
    expect(context.data.meta.revision).toBe(5);
    expect(context.data.editSessionId).toBe("edit-1");
  });

  it("恢复非空备注时 remarkMissing=false，恢复空备注（unscored）时 true", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-r2");
    installWx([
      { match: "/questionnaire", method: "GET", body: questionnairePayload({ revision: 2, remark: "" }) },
      { match: "/edit-sessions", method: "POST", body: { id: "edit-1", status: "open", draftIssueRemark: "", activeAttachments: [] } },
    ]);
    const empty = makeContext(pageConfig, mergeData(pageConfig), {});
    await pageConfig.onLoad.call(empty, onLoadOptions);
    await flush();
    expect(empty.data.remarkMissing).toBe(true);

    const filled = makeContext(pageConfig, mergeData(pageConfig), {});
    filled.setData({ target: "unscored" });
    installWx([
      { match: "/questionnaire", method: "GET", body: questionnairePayload({ revision: 2, remark: "" }) },
      { match: "/edit-sessions", method: "POST", body: { id: "edit-2", status: "open", draftIssueRemark: "会话中的说明", activeAttachments: [] } },
    ]);
    await pageConfig.onLoad.call(filled, onLoadOptions);
    await flush();
    expect(filled.data.remark).toBe("会话中的说明");
    expect(filled.data.remarkMissing).toBe(false);
  });
});

describe("stageFile：complete 推进 revision（只前进不回退）", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("complete 返回更大 revision 时推进 meta.revision，附件 staged_ready", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-s1");
    installWx(uploadRoutes({ initBody, completeBody: readyBody(7) }));
    const context = stagedContext(pageConfig);
    await pageConfig.stageFile.call(context, { type: "image", path: "/tmp/p.png", size: 1024 });
    await flush();
    expect(context.data.meta.revision).toBe(7);
    expect(context.data.images[0]).toMatchObject({ id: "att-i", status: "staged_ready", progressLabel: "上传成功" });
  });

  it("complete revision 不大于当前值时不回退", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-s2");
    installWx(uploadRoutes({ initBody, completeBody: readyBody(1) }));
    const context = stagedContext(pageConfig);
    await pageConfig.stageFile.call(context, { type: "image", path: "/tmp/p.png", size: 1024 });
    await flush();
    expect(context.data.meta.revision).toBe(2);
    expect(context.data.images[0]).toMatchObject({ id: "att-i", status: "staged_ready" });
  });

  it("第二链完成携带乱序旧值时读最新 meta，revision 只前进不回退", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-s3");
    // services/api 的 request() 按 method:url 在途去重：同会话并发 stageFile 共享同一 init/complete
    // 请求，因此"读到最新值"用连续两链验证——第二链完成返回旧值 3 时，若读旧快照（2）会错误推进到 3。
    installWx(uploadRoutes({ initBody, completeBody: readyBody(5) }));
    const context = stagedContext(pageConfig);
    await pageConfig.stageFile.call(context, { type: "image", path: "/tmp/p.png", size: 1024 });
    await flush();
    expect(context.data.meta.revision).toBe(5);
    installWx(uploadRoutes({ initBody, completeBody: readyBody(3) }));
    await pageConfig.stageFile.call(context, { type: "image", path: "/tmp/p2.png", size: 1024 });
    await flush();
    expect(context.data.meta.revision).toBe(5);
  });
});

describe("stageFile：临时 id 用实例计数器防撞", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("连续两次入队生成互不冲突的 local- 临时 id", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-t1");
    installWx(); // 无路由：init 返回空对象未过校验 → 两项都落 failed，保留各自临时 id
    const context = stagedContext(pageConfig);
    await pageConfig.stageFile.call(context, { type: "image", path: "/tmp/p.png", size: 1024 });
    await pageConfig.stageFile.call(context, { type: "image", path: "/tmp/p2.png", size: 1024 });
    await flush();
    expect(context.data.images.map((item) => item.id)).toEqual(["local-1", "local-2"]);
    expect(context.data.images.every((item) => item.status === "failed")).toBe(true);
  });

  it("源码使用 evidenceSeq 计数器（不再按数组长度生成临时 id），isSafeInteger 恰好两处", () => {
    const source = readFileSync(join(issueDir, "index.js"), "utf8");
    expect(source).toContain("this.evidenceSeq");
    expect(source).not.toContain("local-${this.data.images.length");
    expect(source.match(/Number\.isSafeInteger/g)).toHaveLength(2);
  });
});

describe("确认按钮就地校验（remarkMissing）", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("remark 输入驱动 remarkMissing；target=scored 恒为 false", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-c1");
    installWx();
    const context = stagedContext(pageConfig, { remark: "" });
    pageConfig.remark.call(context, { detail: { value: "" } });
    expect(context.data.remarkMissing).toBe(true);
    pageConfig.remark.call(context, { detail: { value: "发现问题" } });
    expect(context.data.remarkMissing).toBe(false);
    context.data.target = "scored";
    pageConfig.remark.call(context, { detail: { value: "" } });
    expect(context.data.remarkMissing).toBe(false);
  });
});

describe("录音健壮性（onError 复位 / onUnload 丢弃在录音频）", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("onError 只绑定一次，触发后复位录音态并提示", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-rec1");
    const recorder = { onStop: vi.fn(), onError: vi.fn(), start: vi.fn(), stop: vi.fn() };
    installWx();
    globalThis.wx.getRecorderManager = () => recorder;
    const context = stagedContext(pageConfig, { audios: [] });
    pageConfig.toggleRecord.call(context);
    pageConfig.toggleRecord.call(context); // 停止
    pageConfig.toggleRecord.call(context); // 再开
    expect(recorder.onError).toHaveBeenCalledTimes(1);
    recorder.onError.mock.calls[0][0]();
    expect(context.data.recording).toBe(false);
    expect(globalThis.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "录音失败，请重试" }));
  });

  it("onUnload 正在录音则 recorder.stop 并置 unloaded；onStop 丢弃录音不上传", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-rec2");
    const recorder = { onStop: vi.fn(), onError: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const { requests } = installWx();
    globalThis.wx.getRecorderManager = () => recorder;
    const context = stagedContext(pageConfig, { audios: [], editSessionId: "" });
    pageConfig.toggleRecord.call(context);
    expect(recorder.start).toHaveBeenCalledTimes(1);
    pageConfig.onUnload.call(context);
    expect(context.unloaded).toBe(true);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    // 卸载后 onStop 仍会触发：录音必须被丢弃（不上传、零网络请求）。
    recorder.onStop.mock.calls[0][0]({ duration: 2000, tempFilePath: "/tmp/a.mp3", fileSize: 2048 });
    expect(context.data.recording).toBe(false);
    expect(context.data.audios).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("录音失败提示与卸载丢弃标记落位源码", () => {
    const source = readFileSync(join(issueDir, "index.js"), "utf8");
    expect(source).toContain("录音失败，请重试");
    expect(source).toContain("this.unloaded");
  });
});

describe("播放失败提示（单例 onError 只绑一次）", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("onError 只绑定一次，触发提示；多次播放仍复用单例", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?parity-play1");
    const audio = { play: vi.fn(), destroy: vi.fn(), onError: vi.fn() };
    installWx();
    globalThis.wx.createInnerAudioContext = vi.fn(() => audio);
    const context = stagedContext(pageConfig, { audios: [{ id: "a-1", type: "audio", path: "/tmp/a.mp3" }] });
    pageConfig.play.call(context, { currentTarget: { dataset: { id: "a-1" } } });
    pageConfig.play.call(context, { currentTarget: { dataset: { id: "a-1" } } });
    expect(globalThis.wx.createInnerAudioContext).toHaveBeenCalledTimes(1);
    expect(audio.onError).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
    audio.onError.mock.calls[0][0]();
    expect(globalThis.wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "音频播放失败，请重试" }));
  });
});

describe("WXML/JS 静态契约（提示文案 / 就地校验绑定 / 禁词护栏）", () => {
  const wxml = readFileSync(join(issueDir, "index.wxml"), "utf8");
  const js = readFileSync(join(issueDir, "index.js"), "utf8");

  it("确认按钮就地禁用绑定与提示文案，save 兜底 toast 保留", () => {
    expect(wxml).toContain('disabled="{{saving || remarkMissing}}"');
    expect(wxml).toContain("请填写问题说明后再确认");
    expect(js).toContain("请填写问题说明");
  });

  it("照片/音频区提示文案与 H5 对齐", () => {
    expect(wxml).toContain("每题最多 {{question.evidence.imageMaxCount || 4}} 张，单张不超过 10MB");
    expect(wxml).toContain("每题最多 3 段，每段至少 1 秒");
  });

  it("WXML 不含用户可见工程禁词（与 frontend-contract 同规则）", () => {
    const forbidden = [/\/api\//i, /HTTP\s*\d/i, /assignment[_ ]?id/i, /attempt[_ ]?id/i, /storage[_ ]?key/i, /stack\s*trace/i, /409\s*Conflict/i, /submit\s*token/i, /revision/i];
    for (const pattern of forbidden) expect(pattern.test(wxml)).toBe(false);
  });
});

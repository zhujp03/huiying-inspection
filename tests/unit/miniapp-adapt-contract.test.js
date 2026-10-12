// 微信小程序适配批次 A 契约测试：
// 1) 任务详情新字段（消费小票/问卷截止）展示与 wxml 静态契约；
// 2) 提交链路任务版本号来源锁定（主来源为任务详情，而非草稿）；
// 3) 录音/图片证据 mime 与后端白名单对齐（静态）；
// 4) 服务端分类下发与问卷页消费对齐（静态）。
// 行为用例 mock wx 后加载真实 Page 配置；静态用例直接读源码断言。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// presentation.js 按设备本地时区格式化；测试固定时区保证断言稳定。
process.env.TZ = "Asia/Shanghai";

const root = resolve(import.meta.dirname, "../..");
const mini = join(root, "apps/miniapp/miniprogram");
const read = (relative) => readFileSync(join(mini, relative), "utf8");
const readRepo = (relative) => readFileSync(join(root, relative), "utf8");

function mergeData(pageConfig, overrides = {}) {
  const data = JSON.parse(JSON.stringify(pageConfig.data));
  Object.assign(data, overrides);
  return data;
}
function makeContext(pageConfig, data, extras = {}) {
  return { ...pageConfig, data, setData(patch) { Object.assign(this.data, patch); }, ...extras };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("任务详情新字段展示（消费小票/问卷截止）", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; });

  it("问卷截止时间在 JS 层格式化为「8月11日 周二 19:32」风格，receiptRequired 透传保留", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/task/index.js?task-adapt-1");
    globalThis.wx = { getStorageSync: () => null, request: (options) => options.success({ statusCode: 200, data: {
      id: "assignment-1", status: "in_progress", revision: 7, receiptRequired: true,
      questionnaireDeadlineAt: "2026-08-11T19:32:00+08:00",
      startsAt: "2026-08-11T11:32:00+08:00", dueAt: "2026-08-11T12:03:00+08:00",
    } }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { assignmentId: "assignment-1" }), { unloaded: false });
    await pageConfig.load.call(context);
    const task = context.data.task;
    expect(task.receiptRequired).toBe(true);
    expect(task.questionnaireDeadlineLabel).toBe("8月11日 周二 19:32");
  });

  it("receiptRequired 为 false、问卷截止为 null 时 label 为空串（对应行不渲染）", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/task/index.js?task-adapt-2");
    globalThis.wx = { getStorageSync: () => null, request: (options) => options.success({ statusCode: 200, data: {
      id: "assignment-2", status: "assigned", receiptRequired: false, questionnaireDeadlineAt: null,
    } }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { assignmentId: "assignment-2" }), { unloaded: false });
    await pageConfig.load.call(context);
    const task = context.data.task;
    expect(task.receiptRequired).toBe(false);
    expect(task.questionnaireDeadlineLabel).toBe("");
  });

  it("两字段整体缺失时同样空串兜底，不产生 undefined 渲染", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/task/index.js?task-adapt-3");
    globalThis.wx = { getStorageSync: () => null, request: (options) => options.success({ statusCode: 200, data: {
      id: "assignment-3", status: "assigned",
    } }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { assignmentId: "assignment-3" }), { unloaded: false });
    await pageConfig.load.call(context);
    expect(context.data.task.questionnaireDeadlineLabel).toBe("");
  });
});

describe("任务页新字段 wxml 静态契约", () => {
  const wxml = read("pages/task/index.wxml");

  it("本次要求卡片包含消费小票行，仅 receiptRequired 为真时渲染", () => {
    expect(wxml).toContain('wx:if="{{task.receiptRequired}}"');
    expect(wxml).toContain("消费小票");
    expect(wxml).toContain("需上传消费小票");
  });

  it("问卷截止行绑定 JS 格式化字段且非空才渲染，ISO 原始字段不得进入 wxml", () => {
    expect(wxml).toContain("问卷截止");
    expect(wxml).toContain("{{task.questionnaireDeadlineLabel}}");
    expect(wxml).not.toContain("questionnaireDeadlineAt");
  });

  it("wxml 不含工程禁词（与 frontend-contract 可见文件禁令同源）", () => {
    for (const pattern of [/revision/i, /attempt[_ ]?id/i, /assignment[_ ]?id/i, /\/api\//i, /submit\s*token/i]) {
      expect(pattern.test(wxml), `禁词 ${pattern}`).toBe(false);
    }
  });
});

describe("提交链路任务版本号来源锁定（主来源为任务详情）", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; });

  it("load 取任务 revision:7（草稿 attempt.revision:3 不覆盖），submit 回传 7", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/other/index.js?other-adapt-1");
    const submitPayloads = [];
    const drafts = new Map();
    globalThis.wx = {
      getStorageSync: (key) => (key === "junde:session" ? { accessToken: "token", user: { id: "user-1" } } : drafts.get(key) || ""),
      setStorageSync: (key, value) => drafts.set(key, value),
      removeStorageSync: (key) => drafts.delete(key),
      request: (options) => {
        if (options.url.includes("/api/assignments/")) {
          options.success({ statusCode: 200, data: { id: "assignment-1", status: "in_progress", revision: 7 } });
        } else if (options.url.includes("/api/questionnaires/secret/drafts/") && options.method === "PUT") {
          // 保存其他记录：刻意不下发 assignmentRevision，验证任务详情来源不被覆盖。
          options.success({ statusCode: 200, data: { revision: 4 } });
        } else if (options.url.includes("/api/questionnaires/secret/drafts/")) {
          options.success({ statusCode: 200, data: {
            attempt: { id: "attempt-1", status: "in_progress", revision: 3 },
            questionnaireVersion: { id: "qv-1" },
            questions: [], answers: {}, otherRecords: {},
          } });
        } else if (options.url.includes("/submit")) {
          submitPayloads.push(options.data);
          options.success({ statusCode: 200, data: { status: "submitted", submittedAt: "2026-08-11T20:00:00+08:00" } });
        } else {
          options.fail({ errMsg: `unexpected request ${options.url}` });
        }
      },
      showToast: vi.fn(),
      showModal: (options) => options.success({ confirm: true }),
      navigateBack: vi.fn(),
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { highlight: "闪光点" }), {
      routeMeta: { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 3 },
    });
    await pageConfig.load.call(context);
    expect(context.assignmentRevision).toBe(7);
    expect(context.assignmentRevision).not.toBe(3);
    // load 会用服务端 otherRecords 重置表单，闪光点需在 load 之后、提交确认之前填写。
    context.setData({ highlight: "闪光点" });
    await pageConfig.confirm.call(context);
    await flush();
    expect(submitPayloads).toHaveLength(1);
    expect(submitPayloads[0].assignmentRevision).toBe(7);
    expect(submitPayloads[0].assignmentRevision).not.toBe(3);
  });
});

describe("录音证据 mime 与后端白名单对齐（静态）", () => {
  const issueJs = read("pages/issue/index.js");
  const routes = readRepo("apps/api/src/batch3/routes.js");

  it("问题页录音固定 mp3，且音频/图片 mime 映射完整", () => {
    expect(issueJs).toContain('format: "mp3"');
    expect(issueJs).toContain('"audio/mpeg"');
    expect(issueJs).toContain('endsWith(".png") ? "image/png" : "image/jpeg"');
  });

  it("小程序产出 mime 全部落在后端白名单内（白名单收窄立即红）", () => {
    const line = routes.split("\n").find((entry) => entry.includes("const validMime"));
    expect(line, "后端 validMime 行必须存在").toBeTruthy();
    const match = line.match(/const validMime = body\.type === "image" \? \[([^\]]*)\] : \[([^\]]*)\]/);
    expect(match, "validMime 行须为 image/audio 两个数组字面量").toBeTruthy();
    const parse = (raw) => raw.split(",").map((entry) => entry.trim().replaceAll('"', "")).filter(Boolean);
    const imageWhitelist = parse(match[1]);
    const audioWhitelist = parse(match[2]);
    for (const mime of ["image/jpeg", "image/png"]) expect(imageWhitelist, `image 白名单缺 ${mime}`).toContain(mime);
    expect(audioWhitelist, "audio 白名单缺 audio/mpeg").toContain("audio/mpeg");
  });
});

describe("服务端分类下发与问卷页消费契约（静态）", () => {
  const surveyJs = read("pages/survey/index.js");
  const surveyWxml = read("pages/survey/index.wxml");
  const routes = readRepo("apps/api/src/batch3/routes.js");

  it("survey 页以服务端分类替换兜底，FALLBACK_CATEGORIES 仅作异常降级", () => {
    expect(surveyJs).toContain("applyCategories");
    expect(surveyJs).toContain("Array.isArray(result.categories) && result.categories.length");
    expect(surveyJs).toContain("? result.categories : FALLBACK_CATEGORIES");
  });

  it("applyCategories 按服务端结构消费 item.id，模板按 item.id/item.label 渲染", () => {
    const apply = surveyJs.slice(surveyJs.indexOf("applyCategories("), surveyJs.indexOf("async load()"));
    expect(apply).toContain("item.id");
    expect(surveyWxml).toContain('wx:key="id"');
    expect(surveyWxml).toContain("{{item.label}}");
    expect(surveyWxml).toContain("{{item.id}}");
  });

  it("后端下发的分类结构与前端消费一致（{id,label}）", () => {
    expect(routes).toContain("categories: categories.rows.map((item) => ({ id: item.code, label: item.name }))");
  });
});

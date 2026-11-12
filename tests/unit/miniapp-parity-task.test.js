// 任务详情页「继续填写」对齐 H5 TaskPage.continueDraft：
// attempt 已 submitted（聚合状态滞后窗口）时不得进问卷——toast「该任务已提交」后单次重拉聚合刷新终态。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeContext(pageConfig, data, extras = {}) {
  return { ...pageConfig, data, setData(patch) { Object.assign(this.data, patch); }, ...extras };
}

describe("任务详情页 continueDraft 已提交拦截（对齐 H5 TaskPage）", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; });

  function installWx() {
    globalThis.wx = { getStorageSync: () => null, showToast: vi.fn(), navigateTo: vi.fn() };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    return globalThis.wx;
  }

  function makeTask(status) {
    return {
      status,
      attempt: { id: `attempt-${status}`, status, revision: 2 },
      questionnaireVersion: { id: "qv-1" },
    };
  }

  it("attempt.status=submitted 时 toast「该任务已提交」并重拉聚合，不进问卷", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/task/index.js?parity-task-submitted");
    const wx = installWx();
    const context = makeContext(pageConfig, { assignmentId: "assignment-1", navigating: false, task: makeTask("submitted") }, { load: vi.fn(), unloaded: false });
    pageConfig.continueDraft.call(context);
    await flush();
    expect(wx.showToast).toHaveBeenCalledTimes(1);
    expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "该任务已提交", icon: "none" }));
    expect(context.load).toHaveBeenCalledTimes(1);
    expect(wx.navigateTo).not.toHaveBeenCalled();
    expect(context.data.navigating).toBe(false);
  });

  it("attempt.status 非 submitted 时维持原路径：锁 navigating 并带参进问卷", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/task/index.js?parity-task-draft");
    const wx = installWx();
    const context = makeContext(pageConfig, { assignmentId: "assignment-1", navigating: false, task: makeTask("draft") }, { load: vi.fn(), unloaded: false });
    pageConfig.continueDraft.call(context);
    expect(wx.navigateTo).toHaveBeenCalledTimes(1);
    const url = wx.navigateTo.mock.calls[0][0].url;
    expect(url).toContain("/pages/survey/index?");
    expect(url).toContain("attemptId=attempt-draft");
    expect(url).toContain("revision=2");
    expect(context.data.navigating).toBe(true);
    expect(wx.showToast).not.toHaveBeenCalled();
    expect(context.load).not.toHaveBeenCalled();
  });
});

describe("任务详情页既有展示不被回归（消费小票/问卷截止）", () => {
  it("页面仍渲染消费小票与问卷截止，源码仍含 submitted 拦截与终态文案", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const wxml = readFileSync(resolve(repoRoot, "apps/miniapp/miniprogram/pages/task/index.wxml"), "utf8");
    expect(wxml).toContain("消费小票");
    expect(wxml).toContain("问卷截止");
    const js = readFileSync(resolve(repoRoot, "apps/miniapp/miniprogram/pages/task/index.js"), "utf8");
    expect(js).toContain("questionnaireDeadlineLabel");
    expect(js).toContain('attempt.status === "submitted"');
    expect(js).toContain("该任务已提交");
  });
});

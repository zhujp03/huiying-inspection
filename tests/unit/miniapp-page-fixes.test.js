// 小程序页面行为修复测试：mock 全局 wx/getApp 后加载真实 Page 配置，
// 直接调用生命周期/事件方法断言 data 与副作用。不拉起微信开发者工具。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBudgetLabel, formatTimeRange, mapAssignmentStatus } from "../../apps/miniapp/miniprogram/utils/presentation.js";
import { join, resolve } from "node:path";

// presentation.js 按设备本地时区格式化；测试固定时区保证断言稳定。
process.env.TZ = "Asia/Shanghai";

function mergeData(pageConfig, overrides = {}) {
  const data = JSON.parse(JSON.stringify(pageConfig.data));
  Object.assign(data, overrides);
  return data;
}
function makeContext(pageConfig, data, extras = {}) {
  return { ...pageConfig, data, setData(patch) { Object.assign(this.data, patch); }, ...extras };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// 每个用例用唯一静态 query 导入页面模块（vite 动态 import 需静态可分析，且 query 不同才能重新执行 Page()）。

describe("展示字段纯函数（预算/状态/时间窗）", () => {
  it("预算按分转元展示，0 或缺失表示未设置", () => {
    expect(formatBudgetLabel(123400)).toBe("¥1234.00");
    expect(formatBudgetLabel(5)).toBe("¥0.05");
    expect(formatBudgetLabel(0)).toBe("未设置");
    expect(formatBudgetLabel(undefined)).toBe("未设置");
    expect(formatBudgetLabel("100")).toBe("未设置");
    expect(formatBudgetLabel(-1)).toBe("未设置");
  });

  it("任务状态映射为中文终态文案", () => {
    expect(mapAssignmentStatus("assigned").statusText).toBe("待开始");
    expect(mapAssignmentStatus("in_progress").statusText).toBe("进行中");
    expect(mapAssignmentStatus("overdue").statusText).toBe("已逾期");
    expect(mapAssignmentStatus("submitted").statusText).toBe("已提交");
    expect(mapAssignmentStatus("cancelled").statusText).toBe("已取消");
  });

  it("时间窗由 startsAt/dueAt 格式化为区间，缺失降级为待确认", () => {
    expect(formatTimeRange("2026-08-11T11:32:00+08:00", "2026-08-11T12:03:00+08:00")).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
    expect(formatTimeRange(undefined, undefined)).toBe("时间待确认");
  });
});

describe("登录页自助开关与冷启动会话恢复", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; });

  function installWx({ session, assignmentOk = true }) {
    const requests = [];
    globalThis.wx = {
      getStorageSync: (key) => (key === "junde:session" ? session : ""),
      setStorageSync: () => {},
      removeStorageSync: () => {},
      request: (options) => {
        requests.push(options.url);
        if (assignmentOk) options.success({ statusCode: 200, data: { items: [{ id: "assignment-1" }] } });
        else options.success({ statusCode: 500, data: {} });
      },
      switchTab: vi.fn(),
      reLaunch: vi.fn(),
      showToast: vi.fn(),
      showModal: vi.fn(),
    };
    return { requests, switchTab: globalThis.wx.switchTab };
  }
  function installApp(features) {
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test", session: null, publicConfig: { captchaAppId: "2026", features } } });
  }

  it("authSelfService=true 时 selfServiceEnabled=true，false 或缺失时为 false", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/login/index.js?login-page-1");
    installWx({ session: null });
    installApp({ authSelfService: true });
    const on = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(on, {});
    expect(on.data.selfServiceEnabled).toBe(true);

    installApp({ authSelfService: false });
    const off = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(off, {});
    expect(off.data.selfServiceEnabled).toBe(false);

    installApp(undefined);
    const missing = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(missing, {});
    expect(missing.data.selfServiceEnabled).toBe(false);
  });

  it("已有会话且探测成功时冷启动直接进入首页，且同一实例只跳一次", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/login/index.js?login-page-2");
    const { requests, switchTab } = installWx({ session: { accessToken: "token", user: { id: "user-1" } } });
    installApp({ authSelfService: true });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(context, {});
    await flush();
    expect(requests.some((url) => url.includes("/api/assignments/mine"))).toBe(true);
    expect(switchTab).toHaveBeenCalledTimes(1);
    expect(switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/pages/home/index") }));
    // 防跳转循环：同一实例重复探测不再发起请求、不再跳转。
    await context.probeExistingSession();
    await flush();
    expect(requests.filter((url) => url.includes("/api/assignments/mine"))).toHaveLength(1);
    expect(switchTab).toHaveBeenCalledTimes(1);
  });

  it("无本地会话时留在登录页且不发起探测请求", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/login/index.js?login-page-3");
    const { requests, switchTab } = installWx({ session: null });
    installApp({ authSelfService: true });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(context, {});
    await flush();
    expect(requests).toHaveLength(0);
    expect(switchTab).not.toHaveBeenCalled();
  });

  it("探测失败（服务不可用）时不跳转、且不再重试", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/login/index.js?login-page-4");
    // 独立 userId：避免命中前一个用例写入模块级任务列表缓存导致探测被短路。
    const { requests, switchTab } = installWx({ session: { accessToken: "token", user: { id: "user-probe-fail" } }, assignmentOk: false });
    installApp({ authSelfService: true });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(context, {});
    await flush();
    expect(switchTab).not.toHaveBeenCalled();
    await context.probeExistingSession();
    await flush();
    expect(requests.filter((url) => url.includes("/api/assignments/mine"))).toHaveLength(1);
  });

  it("带特定进入参数（如忘记密码）时不做冷启动跳转", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/login/index.js?login-page-5");
    const { requests, switchTab } = installWx({ session: { accessToken: "token", user: { id: "user-1" } } });
    installApp({ authSelfService: true });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(context, { mode: "forgot" });
    await flush();
    expect(requests).toHaveLength(0);
    expect(switchTab).not.toHaveBeenCalled();
  });
});

describe("问题页录音与音频播放", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; });


  it("多次开始录音只注册一次 onStop", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-page-1");
    const recorder = { onStop: vi.fn(), start: vi.fn(), stop: vi.fn() };
    globalThis.wx = { getRecorderManager: () => recorder, showToast: vi.fn() };
    globalThis.getApp = () => ({ globalData: {} });
    const context = makeContext(pageConfig, mergeData(pageConfig, { audios: [], recording: false, question: { evidence: { audioMaxDurationSeconds: 10 } } }), {});
    pageConfig.toggleRecord.call(context);
    pageConfig.toggleRecord.call(context); // stop
    // 模拟 onStop 触发：录音过短只提示，不进入上传；recording 复位为 false。
    recorder.onStop.mock.calls[0][0]({ duration: 500, tempFilePath: "/tmp/a.mp3", fileSize: 100 });
    expect(context.data.recording).toBe(false);
    pageConfig.toggleRecord.call(context); // 再次开始
    expect(recorder.onStop).toHaveBeenCalledTimes(1);
    expect(recorder.start).toHaveBeenCalledTimes(2);
  });

  it("play 复用同一个 InnerAudioContext，onUnload 时销毁", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/issue/index.js?issue-page-2");
    const audio = { play: vi.fn(), destroy: vi.fn() };
    const createInnerAudioContext = vi.fn(() => audio);
    globalThis.wx = { createInnerAudioContext };
    globalThis.getApp = () => ({ globalData: {} });
    const context = makeContext(pageConfig, mergeData(pageConfig, { audios: [{ id: "audio-1", path: "/tmp/a.mp3" }] }), {});
    pageConfig.play.call(context, { currentTarget: { dataset: { id: "audio-1" } } });
    pageConfig.play.call(context, { currentTarget: { dataset: { id: "audio-1" } } });
    expect(createInnerAudioContext).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(2);
    pageConfig.onUnload.call(context);
    expect(audio.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("任务详情加载格式化", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; });


  it("新字段到位时生成完整展示字段", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/task/index.js?task-page-1");
    // getStorageSync：services/api 的 request 在发请求前会读取本地会话。
    globalThis.wx = { getStorageSync: () => null, request: (options) => options.success({ statusCode: 200, data: {
      id: "assignment-1", status: "in_progress", storeName: "门店", storeAddress: "上海市静安区 1 号",
      startsAt: "2026-08-11T11:32:00+08:00", dueAt: "2026-08-11T12:03:00+08:00", budgetLimitCents: 123400,
      dishRequirements: [{ id: "d1", plannedName: "招牌菜", quantity: 1, required: true }], specialInstruction: "保持安静",
    } }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { assignmentId: "assignment-1" }), { unloaded: false });
    await pageConfig.load.call(context);
    const task = context.data.task;
    expect(task.statusLabel).toBe("进行中");
    expect(task.address).toBe("上海市静安区 1 号");
    expect(task.windowLabel).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
    expect(task.budgetLabel).toBe("¥1234.00");
    expect(task.dishRequirements).toHaveLength(1);
    expect(task.specialInstruction).toBe("保持安静");
  });

  it("新字段缺失时安全兜底，不产生 undefined 渲染", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/task/index.js?task-page-2");
    globalThis.wx = { getStorageSync: () => null, request: (options) => options.success({ statusCode: 200, data: { id: "assignment-2", status: "assigned" } }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { assignmentId: "assignment-2" }), { unloaded: false });
    await pageConfig.load.call(context);
    const task = context.data.task;
    expect(task.statusLabel).toBe("待开始");
    expect(task.address).toBe("");
    expect(task.budgetLabel).toBe("未设置");
    expect(Array.isArray(task.dishRequirements)).toBe(true);
    expect(task.dishRequirements).toHaveLength(0);
    expect(task.specialInstruction).toBe("");
  });
});

describe("runtime-config 生成器防呆（本机地址不得进入发布配置）", () => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const scriptPath = join(repoRoot, "scripts/generate-miniapp-runtime-config.mjs");
  const generatedPath = join(repoRoot, "apps/miniapp/miniprogram/runtime-config.generated.js");
  const snapshot = readFileSync(generatedPath, "utf8");

  afterEach(() => { writeFileSync(generatedPath, snapshot); });

  function runGenerator(envBody) {
    const envFile = join(mkdtempSync(join(tmpdir(), "runtime-config-test-")), ".env");
    writeFileSync(envFile, envBody);
    return spawnSync(process.execPath, [scriptPath], { env: { ...process.env, ENV_FILE: envFile }, encoding: "utf8" });
  }

  it("发布目标下 localhost 的 https 地址也拒绝（退出非零且不写生成物）", () => {
    const result = runGenerator("MINIAPP_API_BASE_URL=https://localhost:8443\nNODE_ENV=production\n");
    expect(result.status).not.toBe(0);
    expect(readFileSync(generatedPath, "utf8")).toBe(snapshot);
  });

  it("发布目标下 127.0.0.1 地址同样拒绝", () => {
    const result = runGenerator("MINIAPP_API_BASE_URL=https://127.0.0.1\nNODE_ENV=production\n");
    expect(result.status).not.toBe(0);
  });

  it("NODE_ENV=development 时显式允许本机地址并输出警告", () => {
    const result = runGenerator("MINIAPP_API_BASE_URL=http://127.0.0.1:3000\nNODE_ENV=development\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("本机地址");
  });
});

describe("消费小票 409 已提交终态与在途上传取消", () => {
  afterEach(() => { delete globalThis.wx; delete globalThis.getApp; });


  it("小票列表返回 QUESTIONNAIRE_SUBMITTED 409 时给出终态提示并锁定重试", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?dishes-page-1");
    globalThis.wx = { getStorageSync: () => null, request: (options) => options.success({ statusCode: 409, data: { error: { code: "QUESTIONNAIRE_SUBMITTED", message: "问卷已提交" } } }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { receipts: [], pendingReceipts: [] }), { routeMeta: { attemptId: "attempt-1" }, updateRevision() {} });
    await pageConfig.loadReceipts.call(context);
    expect(context.data.receiptError).toContain("任务已提交");
    expect(context.data.receiptLocked).toBe(true);
  });

  it("removePending 后在途上传完成不再回填列表", async () => {
    let pageConfig;
    globalThis.Page = (config) => { pageConfig = config; };
    await import("../../apps/miniapp/miniprogram/pages/dishes/index.js?dishes-page-2");
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const uploadTarget = { method: "POST", url: "https://cos.test/bucket", fileFieldName: "file", formData: { key: "x" }, expiresAt };
    globalThis.wx = {
      getStorageSync: () => null,
      request: (options) => {
        if (options.url.includes("uploads") && options.method === "POST") {
          options.success({ statusCode: 200, data: { attachment: { id: "att-1" }, uploadTarget, revision: 2 } });
        } else {
          options.success({ statusCode: 200, data: { revision: 3, attachment: { id: "att-1" }, items: [] } });
        }
      },
      uploadFile: (options) => { options.success({ statusCode: 200, header: { ETag: "etag-1" } }); return { onProgressUpdate() {} }; },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const pending = { clientFileId: "client-1", localPath: "/tmp/r.jpg", sizeBytes: 10, mimeType: "image/jpeg", fileName: "r.jpg", status: "uploading", progressPercent: 1 };
    const context = makeContext(pageConfig, mergeData(pageConfig, { receipts: [], pendingReceipts: [pending] }), {
      routeMeta: { attemptId: "attempt-1", revision: 1 },
      persistLocal() {},
      refreshReceiptProjection() {},
    });
    const inFlight = pageConfig.uploadPending.call(context, "client-1");
    pageConfig.removePending.call(context, { currentTarget: { dataset: { id: "client-1" } } });
    await inFlight;
    await flush();
    expect(context.data.pendingReceipts).toHaveLength(0);
    expect(context.data.receipts).toHaveLength(0);
  });
});

// 探店员端导航来源修复回归：mock 全局 wx/getApp/getCurrentPages 后加载真实 Page 配置，
// 直接断言导航副作用（switchTab/navigateTo/redirectTo/navigateBack 的目标 URL）。
// 覆盖：登录/定位完成后进首页、任务返回随来源（首页/日程）、任务保留为问卷父页、
// 菜品/其他/问题页仅在同任务父页在栈时原生返回（否则 redirectTo 规范父页）、
// 隐私与定位从「我的」进入后返回「我的」。不拉起微信开发者工具。
import { afterEach, describe, expect, it, vi } from "vitest";

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

// 页面栈 mock：stack 最后一项是当前页。
function installPageStack(stack) {
  globalThis.getCurrentPages = () => stack;
}
const surveyParent = (assignmentId = "assignment-1", attemptId = "attempt-1") => (
  { route: "pages/survey/index", options: { assignmentId, attemptId, questionnaireVersionId: "qv-1", revision: "3" } }
);

async function loadPage(path, query) {
  let pageConfig;
  globalThis.Page = (config) => { pageConfig = config; };
  await import(`${path}?${query}`);
  return pageConfig;
}

function baseWx({ session = null } = {}) {
  return {
    getStorageSync: (key) => (key === "junde:session" ? session : ""),
    setStorageSync: () => {},
    removeStorageSync: () => {},
    request: (options) => options.success({ statusCode: 200, data: { items: [] } }),
    switchTab: vi.fn(),
    navigateTo: vi.fn(),
    redirectTo: vi.fn(),
    navigateBack: vi.fn(),
    reLaunch: vi.fn(),
    showToast: vi.fn(),
  };
}

describe("登录/定位完成去向（首页而非日程）", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("登录成功（approved_active）仍先进定位说明页（隐私/授权策略保留），完成去向由 location 页承接", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/login/index.js", "nav-login-1");
    const requests = [];
    globalThis.wx = {
      ...baseWx(),
      request: (options) => {
        requests.push(options);
        if (options.url.includes("/api/auth/login")) options.success({ statusCode: 200, data: { accessToken: "token", user: { id: "user-1", status: "approved_active" } } });
        else options.success({ statusCode: 200, data: { items: [] } });
      },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test", publicConfig: { captchaAppId: "2026", features: {} } } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { username: "InspectorOne", password: "A-secure-pass" }), {});
    await pageConfig.submitLogin.call(context);
    await flush();
    expect(context.data.step).toBe("form");
    expect(requests.some((request) => request.url.includes("/api/auth/login"))).toBe(true);
    expect(globalThis.wx.redirectTo).toHaveBeenCalledTimes(1);
    expect(globalThis.wx.redirectTo).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/location/index" }));
  });

  it("定位说明页默认（登录/直达）完成后 switchTab 首页，文案为「进入首页」", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/location/index.js", "nav-location-1");
    globalThis.wx = baseWx();
    globalThis.getApp = () => ({ globalData: {} });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(context, {});
    expect(context.data.source).toBe("");
    expect(context.data.continueLabel).toBe("进入首页");
    pageConfig.continue.call(context);
    expect(globalThis.wx.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/home/index" }));
  });

  it("定位说明页从「我的」进入（source=profile）后返回「我的」，文案为「返回我的」；非法来源归默认", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/location/index.js", "nav-location-2");
    globalThis.wx = baseWx();
    globalThis.getApp = () => ({ globalData: {} });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(context, { source: "profile" });
    expect(context.data.source).toBe("profile");
    expect(context.data.continueLabel).toBe("返回我的");
    pageConfig.continue.call(context);
    expect(globalThis.wx.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/profile/index" }));

    const hostile = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(hostile, { source: "https://evil.example" });
    expect(hostile.data.source).toBe("");
    pageConfig.continue.call(hostile);
    expect(globalThis.wx.switchTab).toHaveBeenLastCalledWith(expect.objectContaining({ url: "/pages/home/index" }));
  });

  it("「我的」页隐私入口携 source=profile 进入定位说明页", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/profile/index.js", "nav-profile-1");
    globalThis.wx = { ...baseWx({ session: { accessToken: "token", user: { id: "user-1", status: "approved_active" } } }), navigateTo: vi.fn() };
    globalThis.getApp = () => ({ globalData: {} });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.openPrivacy.call(context);
    expect(globalThis.wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/location/index?source=profile" }));
  });
});

describe("任务返回随来源（首页/日程）与问卷父页保留", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("source=home 时返回首页、文案「返回首页」；缺省/非法回落日程、文案「返回日程」", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/task/index.js", "nav-task-1");
    globalThis.wx = { ...baseWx(), getStorageSync: () => null, request: (options) => options.success({ statusCode: 200, data: { id: "assignment-1", status: "assigned" } }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });

    const fromHome = makeContext(pageConfig, mergeData(pageConfig), { unloaded: true });
    pageConfig.onLoad.call(fromHome, { assignmentId: "assignment-1", source: "home" });
    expect(fromHome.data.originLabel).toBe("返回首页");
    pageConfig.backToSchedule.call(fromHome);
    expect(globalThis.wx.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: "/pages/home/index" }));

    const fromSchedule = makeContext(pageConfig, mergeData(pageConfig), { unloaded: true });
    pageConfig.onLoad.call(fromSchedule, { assignmentId: "assignment-1", source: "https://evil.example" });
    expect(fromSchedule.data.originLabel).toBe("返回日程");
    pageConfig.backToSchedule.call(fromSchedule);
    expect(globalThis.wx.switchTab).toHaveBeenLastCalledWith(expect.objectContaining({ url: "/pages/schedule/index" }));

    const noSource = makeContext(pageConfig, mergeData(pageConfig), { unloaded: true });
    pageConfig.onLoad.call(noSource, { assignmentId: "assignment-1" });
    pageConfig.backToSchedule.call(noSource);
    expect(globalThis.wx.switchTab).toHaveBeenLastCalledWith(expect.objectContaining({ url: "/pages/schedule/index" }));
  });

  it("开始/继续进入问卷改为 navigateTo 且携 4 参 + source（任务保留为父页，不再 redirectTo 销毁）", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/task/index.js", "nav-task-2");
    globalThis.wx = baseWx();
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.onLoad.call(context, { assignmentId: "assignment-1", source: "home" });
    context.unloaded = false;
    pageConfig.openSurvey.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 3 });
    expect(globalThis.wx.navigateTo).toHaveBeenCalledTimes(1);
    expect(globalThis.wx.redirectTo).not.toHaveBeenCalled();
    const url = globalThis.wx.navigateTo.mock.calls[0][0].url;
    expect(url).toContain("/pages/survey/index?assignmentId=assignment-1&attemptId=attempt-1&questionnaireVersionId=qv-1&revision=3");
    expect(url).toContain("source=home");
  });
});

describe("任务页子页导航锁生命周期（navigateTo 后任务页存活）", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  async function taskContext(query, wxOverrides = {}) {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/task/index.js", query);
    globalThis.wx = { ...baseWx(), ...wxOverrides };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, {
      assignmentId: "assignment-1",
      task: { attempt: { id: "attempt-1", revision: 2 }, questionnaireVersion: { id: "qv-1" } },
    }), {});
    pageConfig.onLoad.call(context, { assignmentId: "assignment-1", source: "home" });
    context.unloaded = false;
    await flush(); // 首次聚合加载完成（loading 复位），onShow 的重拉条件才成立
    return context;
  }

  it("继续填写 → 返回（onShow）复位导航锁并可再次继续填写", async () => {
    const context = await taskContext("nav-task-lock-1");
    context.continueDraft.call(context);
    expect(context.data.navigating).toBe(true);
    expect(globalThis.wx.navigateTo).toHaveBeenCalledTimes(1);
    // 模拟从问卷原生返回：onShow 触发（任务页存活），锁复位 + 聚合重拉。
    const loadSpy = vi.spyOn(context, "load");
    context.onShow.call(context);
    expect(context.data.navigating).toBe(false);
    // 第二次继续填写不再被锁拦截。
    context.continueDraft.call(context);
    expect(globalThis.wx.navigateTo).toHaveBeenCalledTimes(2);
    expect(loadSpy).toHaveBeenCalled();
  });

  it("开始成功进入问卷（phase=navigating）后返回：阶段复位为 idle，可重新开始", async () => {
    const context = await taskContext("nav-task-lock-2");
    context.setData({ phase: "navigating", phaseText: "问卷已准备好，正在打开…" });
    context.onShow.call(context);
    expect(context.data.phase).toBe("idle");
    expect(context.data.phaseText).toBe("开始时将重新定位");
    expect(context.data.navigating).toBe(false);
  });

  it("navigateTo 失败（如超出页面栈）放行导航锁，不永久禁用继续填写/开始", async () => {
    const context = await taskContext("nav-task-lock-3", {
      navigateTo: vi.fn((options) => options.fail && options.fail(new Error("exceed max page stack size"))),
    });
    context.setData({ phase: "navigating" });
    context.openSurvey.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 2 });
    expect(context.data.navigating).toBe(false);
    expect(context.data.phase).toBe("idle");
  });

  it("活动开始阶段（定位/打卡中）onShow 不复位（前后台切换不得放行重入）", async () => {
    const context = await taskContext("nav-task-lock-4");
    context.setData({ phase: "checking_in", navigating: false });
    context.onShow.call(context);
    expect(context.data.phase).toBe("checking_in");
    expect(context.data.navigating).toBe(false);
    context.setData({ phase: "locating" });
    context.onShow.call(context);
    expect(context.data.phase).toBe("locating");
  });
});

describe("首页/日程进入任务携带来源", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("首页 goTask 携 source=home", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/home/index.js", "nav-home-1");
    globalThis.wx = { ...baseWx({ session: { accessToken: "token", user: { id: "user-1", status: "approved_active" } } }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { task: { id: "assignment-9" } }), {});
    pageConfig.goTask.call(context);
    const url = globalThis.wx.navigateTo.mock.calls[0][0].url;
    expect(url).toContain("/pages/task/index?assignmentId=assignment-9");
    expect(url).toContain("source=home");
  });

  it("日程 goTask 携 source=schedule", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/schedule/index.js", "nav-schedule-1");
    globalThis.wx = { ...baseWx({ session: { accessToken: "token", user: { id: "user-1", status: "approved_active" } } }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    pageConfig.goTask.call(context, { currentTarget: { dataset: { id: "assignment-8" } } });
    const url = globalThis.wx.navigateTo.mock.calls[0][0].url;
    expect(url).toContain("/pages/task/index?assignmentId=assignment-8");
    expect(url).toContain("source=schedule");
  });
});

describe("问卷/问题/菜品/其他页的同任务父页返回", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; delete globalThis.getCurrentPages; });

  it("问卷向菜品/问题页传递 source 与当前分类", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/survey/index.js", "nav-survey-1");
    globalThis.wx = baseWx();
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { category: "service", questions: [], answers: {} }), {});
    await pageConfig.onLoad.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "3", source: "home" });
    expect(context.source).toBe("home");

    pageConfig.openIssue.call(context, "q-1", "unscored");
    const issueUrl = globalThis.wx.navigateTo.mock.calls[0][0].url;
    expect(issueUrl).toContain("/pages/issue/index?assignmentId=assignment-1&attemptId=attempt-1&questionnaireVersionId=qv-1&revision=3&questionId=q-1&target=unscored");
    expect(issueUrl).toContain("category=service");
    expect(issueUrl).toContain("source=home");

    context.routeMeta = { ...context.routeMeta, revision: 3 };
    globalThis.wx.navigateTo.mockClear();
    // 全题完成才可进菜品（这里绕过守卫直接构造完成态）。
    context.data.questions = [{ id: "q-1", category: "service", number: 1 }];
    context.data.answers = { "q-1": { answer: "scored" } };
    pageConfig.dishes.call(context);
    const dishesUrl = globalThis.wx.navigateTo.mock.calls[0][0].url;
    expect(dishesUrl).toContain("/pages/dishes/index?assignmentId=assignment-1&attemptId=attempt-1&questionnaireVersionId=qv-1&revision=3");
    expect(dishesUrl).toContain("source=home");
  });

  it("问题页兜底返回问卷的规范 URL 携 4 参 + source + category（直达/重载不丢来源链与分类）", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/issue/index.js", "nav-issue-fallback-1");
    globalThis.wx = baseWx();
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, {
      meta: { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 2 },
    }), {});
    await pageConfig.onLoad.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "2", questionId: "q-1", source: "home", category: "service" });
    // 无合法父页（直达进入）→ redirectTo 规范问卷，且保留来源与分类。
    installPageStack([{ route: "pages/issue/index", options: {} }]);
    pageConfig.backToSurvey.call(context);
    expect(globalThis.wx.redirectTo).toHaveBeenCalledTimes(1);
    const url = globalThis.wx.redirectTo.mock.calls[0][0].url;
    expect(url).toContain("/pages/survey/index?assignmentId=assignment-1&attemptId=attempt-1&questionnaireVersionId=qv-1&revision=2");
    expect(url).toContain("source=home");
    expect(url).toContain("category=service");
    // 来源白名单：非法 source 归空串（问卷页按默认日程处理），不透传任意值。
    const hostile = makeContext(pageConfig, mergeData(pageConfig, {
      meta: { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 2 },
    }), {});
    await pageConfig.onLoad.call(hostile, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "2", questionId: "q-1", source: "https://evil.example", category: "service" });
    globalThis.wx.redirectTo.mockClear();
    installPageStack([{ route: "pages/issue/index", options: {} }]);
    pageConfig.backToSurvey.call(hostile);
    expect(globalThis.wx.redirectTo.mock.calls[0][0].url).toContain("&source=&category=service");
  });

  it("问题页保存成功：同任务问卷在栈 → 原生返回；无父页（直达）→ redirectTo 携 4 参 + 分类", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/issue/index.js", "nav-issue-1");
    globalThis.wx = {
      ...baseWx(),
      request: (options) => {
        if (options.url.includes("/confirm")) options.success({ statusCode: 200, data: {} });
        else options.success({ statusCode: 200, data: {} });
      },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, {
      meta: { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 2 },
      question: { id: "q-1", evidence: { imageMaxCount: 3, imageRequired: false, audioRequired: false, audioMaxDurationSeconds: 10 } },
      editSessionId: "edit-1", target: "scored", remark: "", images: [], audios: [],
    }), {});
    context.surveyCategory = "service";

    installPageStack([surveyParent(), { route: "pages/issue/index", options: {} }]);
    await pageConfig.save.call(context);
    await flush();
    expect(globalThis.wx.navigateBack).toHaveBeenCalledTimes(1);
    expect(globalThis.wx.redirectTo).not.toHaveBeenCalled();

    globalThis.wx.navigateBack.mockClear();
    installPageStack([{ route: "pages/issue/index", options: {} }]);
    await pageConfig.save.call(context);
    await flush();
    expect(globalThis.wx.navigateBack).not.toHaveBeenCalled();
    expect(globalThis.wx.redirectTo).toHaveBeenCalledTimes(1);
    const fallbackUrl = globalThis.wx.redirectTo.mock.calls[0][0].url;
    expect(fallbackUrl).toContain("/pages/survey/index?assignmentId=assignment-1&attemptId=attempt-1&questionnaireVersionId=qv-1&revision=2");
    expect(fallbackUrl).toContain("category=service");
  });

  it("问题页保存：父页是「别的任务」的问卷 → 不原生返回，redirectTo 本任务规范问卷", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/issue/index.js", "nav-issue-2");
    globalThis.wx = { ...baseWx(), request: (options) => options.success({ statusCode: 200, data: {} }) };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, {
      meta: { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 2 },
      question: { id: "q-1", evidence: { imageMaxCount: 3, imageRequired: false, audioRequired: false, audioMaxDurationSeconds: 10 } },
      editSessionId: "edit-1", target: "scored", remark: "", images: [], audios: [],
    }), {});
    installPageStack([surveyParent("assignment-other", "attempt-other"), { route: "pages/issue/index", options: {} }]);
    await pageConfig.save.call(context);
    await flush();
    expect(globalThis.wx.navigateBack).not.toHaveBeenCalled();
    expect(globalThis.wx.redirectTo).toHaveBeenCalledTimes(1);
    expect(globalThis.wx.redirectTo.mock.calls[0][0].url).toContain("assignmentId=assignment-1&attemptId=attempt-1");
  });

  it("菜品页回问卷：同任务父页 → 原生返回；无父页 → redirectTo 携 category=product", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/dishes/index.js", "nav-dishes-1");
    globalThis.wx = baseWx();
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig), {});
    context.routeMeta = { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 3 };

    installPageStack([surveyParent(), { route: "pages/dishes/index", options: {} }]);
    pageConfig.routeToSurvey.call(context, false);
    expect(globalThis.wx.navigateBack).toHaveBeenCalledTimes(1);
    expect(globalThis.wx.redirectTo).not.toHaveBeenCalled();

    globalThis.wx.navigateBack.mockClear();
    installPageStack([{ route: "pages/dishes/index", options: {} }]);
    pageConfig.routeToSurvey.call(context, false);
    expect(globalThis.wx.navigateBack).not.toHaveBeenCalled();
    const url = globalThis.wx.redirectTo.mock.calls[0][0].url;
    expect(url).toContain("/pages/survey/index?assignmentId=assignment-1&attemptId=attempt-1&questionnaireVersionId=qv-1&revision=3");
    expect(url).toContain("category=product");

    // 全题守卫强制替换（replace=true）始终 redirectTo（业务规则保留）。
    pageConfig.routeToSurvey.call(context, true);
    expect(globalThis.wx.redirectTo).toHaveBeenCalledTimes(2);
  });

  it("其他记录页返回：同任务菜品页在栈 → 原生返回（先保存）；无父页 → redirectTo 规范菜品页（携来源）", async () => {
    const pageConfig = await loadPage("../../apps/miniapp/miniprogram/pages/other/index.js", "nav-other-1");
    const drafts = new Map();
    globalThis.wx = {
      ...baseWx(),
      getStorageSync: (key) => (key === "junde:session" ? { accessToken: "token", user: { id: "user-1" } } : drafts.get(key) || ""),
      setStorageSync: (key, value) => drafts.set(key, value),
      request: (options) => {
        if (options.url.includes("/api/assignments/")) options.success({ statusCode: 200, data: { id: "assignment-1", status: "in_progress", revision: 7 } });
        else if (options.url.includes("/api/questionnaires/secret/drafts/") && options.method === "PUT") options.success({ statusCode: 200, data: { revision: 4 } });
        else options.success({ statusCode: 200, data: { attempt: { id: "attempt-1", status: "in_progress", revision: 3 }, questionnaireVersion: { id: "qv-1" }, questions: [], answers: {}, otherRecords: {} } });
      },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const context = makeContext(pageConfig, mergeData(pageConfig, { highlight: "闪光点" }), {
      routeMeta: { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 3 },
    });
    await pageConfig.onLoad.call(context, { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "3", source: "home" });
    expect(context.source).toBe("home");

    installPageStack([{ route: "pages/dishes/index", options: { assignmentId: "assignment-1", attemptId: "attempt-1" } }, { route: "pages/other/index", options: {} }]);
    await pageConfig.back.call(context);
    await flush();
    expect(globalThis.wx.navigateBack).toHaveBeenCalledTimes(1);
    expect(globalThis.wx.redirectTo).not.toHaveBeenCalled();

    globalThis.wx.navigateBack.mockClear();
    installPageStack([{ route: "pages/other/index", options: {} }]);
    await pageConfig.back.call(context);
    await flush();
    expect(globalThis.wx.navigateBack).not.toHaveBeenCalled();
    expect(globalThis.wx.redirectTo).toHaveBeenCalledTimes(1);
    const fallbackUrl = globalThis.wx.redirectTo.mock.calls[0][0].url;
    expect(fallbackUrl).toContain("/pages/dishes/index?assignmentId=assignment-1&attemptId=attempt-1&questionnaireVersionId=qv-1&revision=4");
    expect(fallbackUrl).toContain("source=home");
  });
});

// 问卷页 Survey + 草稿存储对齐 H5（WEB/pages/SurveyPage.jsx / WEB/store/survey.js）：
// 1) store.advanceDraftRevision「部分同步」语义（补发未完时仅推进 revision，synced 不动）；
// 2) load 互斥（进行中直接 return，finally 复位）；
// 3) 补发：按题号升序；成功前草稿保持 synced:false；conflict 停发并出横幅；其它失败继续；
// 4) score 与待补发集合联动（空 → markDraftSynced，非空 → advance；失败入集合）；
// 5) 网络恢复自动补发（onNetworkStatusChange 注册 / offNetworkStatusChange 注销同一回调）。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const mini = join(repoRoot, "apps/miniapp/miniprogram");
const flush = () => new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
const until = async (condition, timeoutMs = 1000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: condition not met within timeout");
    await flush();
  }
};

const SESSION_KEY = "junde:session";
const DRAFT_INDEX_KEY = "junde:draft-index";
const draftKey = "junde:survey:user-1:assignment-1:attempt-1:qv-1";
const QUESTIONNAIRE_URL = "https://api.test/api/assignments/assignment-1/questionnaire";
const answerUrl = (questionId) => `https://api.test/api/questionnaires/secret/drafts/attempt-1/answers/${questionId}`;
const scoredLocal = { answer: "scored", remark: "", attachments: [] };
const onLoadOptions = { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: "5" };

function memoryWx(overrides = {}) {
  const storage = new Map();
  const wx = {
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ""),
    setStorageSync: (key, value) => { storage.set(key, value); },
    removeStorageSync: (key) => { storage.delete(key); },
    request: () => ({}),
    showToast: vi.fn(), redirectTo: vi.fn(), navigateTo: vi.fn(), showModal: vi.fn(),
    onNetworkStatusChange: vi.fn(), offNetworkStatusChange: vi.fn(),
    ...overrides,
  };
  storage.set(SESSION_KEY, { accessToken: "token", user: { id: "user-1" } });
  return { wx, storage };
}

function questionnairePayload(revision, { answers = {}, questions = [] } = {}) {
  return {
    attempt: { id: "attempt-1", status: "in_progress", revision },
    questionnaireVersion: { id: "qv-1" },
    questions,
    answers,
    otherRecords: {},
  };
}

function ok(options, data) { options.success({ statusCode: 200, data }); }
function failWith(options, statusCode, data) { options.success({ statusCode, data }); }

function seedDraft(storage, answers) {
  storage.set(draftKey, { revision: 5, synced: false, answers });
}

async function loadSurveyPage(tag) {
  let pageConfig;
  globalThis.Page = (config) => { pageConfig = config; };
  const path = "../../apps/miniapp/miniprogram/pages/survey/index.js";
  await import(`${path}?${tag}`);
  return pageConfig;
}

function makeContext(pageConfig, extras = {}) {
  const data = JSON.parse(JSON.stringify(pageConfig.data));
  return { ...pageConfig, data, setData(patch) { Object.assign(this.data, patch); }, ...extras };
}

describe("store/survey.js advanceDraftRevision（对齐 WEB store/survey.js）", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; });
  const meta = { assignmentId: "assignment-1", attemptId: "attempt-1", questionnaireVersionId: "qv-1", revision: 3 };

  it("仅推进 revision：synced 保持 false，answers 等字段不动", async () => {
    const { wx, storage } = memoryWx();
    globalThis.wx = wx;
    const store = await import("../../apps/miniapp/miniprogram/store/survey.js?parity-adv-1");
    store.saveDraft(meta, { answers: { q1: scoredLocal } });
    store.advanceDraftRevision(meta, 4);
    const draft = storage.get(draftKey);
    expect(draft.revision).toBe(4);
    expect(draft.synced).toBe(false);
    expect(draft.answers).toEqual({ q1: scoredLocal });
  });

  it("synced 不动：已同步草稿推进 revision 后仍为 true", async () => {
    const { wx, storage } = memoryWx();
    globalThis.wx = wx;
    const store = await import("../../apps/miniapp/miniprogram/store/survey.js?parity-adv-2");
    store.markDraftSynced(meta, 4);
    store.advanceDraftRevision(meta, 5);
    const draft = storage.get(draftKey);
    expect(draft.revision).toBe(5);
    expect(draft.synced).toBe(true);
  });

  it("登记草稿键到 draft-index（结构与 markDraftSynced 一致）", async () => {
    const { wx, storage } = memoryWx();
    globalThis.wx = wx;
    const store = await import("../../apps/miniapp/miniprogram/store/survey.js?parity-adv-3");
    store.advanceDraftRevision(meta, 4);
    expect(storage.get(DRAFT_INDEX_KEY)).toEqual({ "user-1": [draftKey] });
    expect(storage.get(draftKey).revision).toBe(4);
  });
});

describe("问卷页 load 互斥（对齐 SurveyPage loadInProgressRef）", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; });

  it("load 进行中再次调用：不触发 setData、不发新请求；结束后互斥复位可重入", async () => {
    let resolveFirstGet;
    const requests = [];
    const { wx } = memoryWx({
      request: (options) => {
        requests.push(options);
        if (options.url === QUESTIONNAIRE_URL && requests.length === 1) {
          resolveFirstGet = () => ok(options, questionnairePayload(5));
          return {};
        }
        ok(options, options.method === "PUT" ? { revision: 6 } : questionnairePayload(5));
        return {};
      },
    });
    globalThis.wx = wx;
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const pageConfig = await loadSurveyPage("parity-survey-mutex");
    const context = makeContext(pageConfig);
    let setDataCount = 0;
    const baseSetData = context.setData;
    context.setData = function (patch) { setDataCount += 1; baseSetData.call(this, patch); };
    const first = pageConfig.onLoad.call(context, onLoadOptions);
    const snapshot = { setDataCount, requests: requests.length };
    expect(snapshot.requests).toBe(1);
    expect(snapshot.setDataCount).toBeGreaterThan(0);
    await pageConfig.load.call(context); // 进行中：应直接 return
    expect(setDataCount).toBe(snapshot.setDataCount);
    expect(requests.length).toBe(1);
    resolveFirstGet();
    await first;
    expect(context.data.loading).toBe(false);
    await pageConfig.load.call(context); // 已复位：可再次加载
    await flush();
    expect(requests.length).toBe(2);
    expect(context.data.loading).toBe(false);
  });

  it("load 失败（服务 500）后互斥在 finally 复位：可重试加载", async () => {
    const requests = [];
    const { wx } = memoryWx({
      request: (options) => {
        requests.push(options);
        if (requests.length === 1) failWith(options, 500, {});
        else ok(options, questionnairePayload(5));
        return {};
      },
    });
    globalThis.wx = wx;
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const pageConfig = await loadSurveyPage("parity-survey-mutex-retry");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions);
    expect(requests.length).toBe(1);
    expect(context.data.error).toBeTruthy();
    expect(context.data.loading).toBe(false);
    await pageConfig.load.call(context);
    await flush();
    expect(requests.length).toBe(2);
    expect(context.data.loading).toBe(false);
    expect(context.data.error).toBe("");
  });
});

describe("问卷页补发链路（对齐 SurveyPage pendingQuestionOrder / pendingResyncRef）", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; });

  it("补发前不整体置已同步；按题号升序补发；每成功一题 advance，全部完成才 markDraftSynced", async () => {
    const { wx, storage } = memoryWx();
    seedDraft(storage, { q3: scoredLocal, q2: scoredLocal }); // 插入序 q3 在前，题号 q2=2 < q3=3
    const questions = [
      { id: "q1", category: "environment", number: 1 },
      { id: "q2", category: "environment", number: 2 },
      { id: "q3", category: "environment", number: 3 },
    ];
    const puts = [];
    let resolveSecondPut;
    let putCount = 0;
    globalThis.wx = {
      ...wx,
      request: (options) => {
        if (options.method === "PUT") {
          puts.push(options.url);
          putCount += 1;
          if (putCount === 1) ok(options, { revision: 6 });
          else resolveSecondPut = () => ok(options, { revision: 7 });
          return {};
        }
        ok(options, questionnairePayload(5, { questions }));
        return {};
      },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const pageConfig = await loadSurveyPage("parity-survey-resync-order");
    const context = makeContext(pageConfig);
    const loading = pageConfig.onLoad.call(context, onLoadOptions);
    await until(() => puts.length === 2);
    // 补发顺序按题号升序（合并产出的插入序是 [q3, q2]）。
    expect(puts[0]).toBe(answerUrl("q2"));
    expect(puts[1]).toBe(answerUrl("q3"));
    // 首题成功、次题在途：草稿 revision 已推进但整体保持未同步。
    const mid = storage.get(draftKey);
    expect(mid.synced).toBe(false);
    expect(mid.revision).toBe(6);
    expect(context.pendingResync.has("q3")).toBe(true);
    resolveSecondPut();
    await loading;
    expect(context.pendingResync.size).toBe(0);
    const draft = storage.get(draftKey);
    expect(draft.revision).toBe(7);
    expect(draft.synced).toBe(true);
    expect(draft.answers.q2).toEqual(scoredLocal);
    expect(draft.answers.q3).toEqual(scoredLocal);
    expect(context.data.syncMessage).toBe("");
  });

  it("补发遇 conflict：显示冲突横幅并立即停止补发，草稿保持未同步", async () => {
    const { wx, storage } = memoryWx();
    seedDraft(storage, { q9: scoredLocal, q2: scoredLocal }); // 题号 q2=2 < q9=9
    const questions = [
      { id: "q2", category: "environment", number: 2 },
      { id: "q9", category: "environment", number: 9 },
    ];
    const puts = [];
    globalThis.wx = {
      ...wx,
      request: (options) => {
        if (options.method === "PUT") {
          puts.push(options.url);
          failWith(options, 409, { error: { message: "内容已更新，请刷新后重试" } });
          return {};
        }
        ok(options, questionnairePayload(5, { questions }));
        return {};
      },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const pageConfig = await loadSurveyPage("parity-survey-resync-conflict");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions);
    expect(puts).toEqual([answerUrl("q2")]); // q9 不再发请求
    expect(context.data.conflict).toBe(true);
    expect(context.data.syncMessage).toBe("内容已更新，请刷新后重试");
    expect(storage.get(draftKey).synced).toBe(false);
    expect(context.pendingResync.has("q9")).toBe(true);
  });

  it("补发其它失败：保留本地草稿继续下一题，成功的题推进 revision；未冲突则清空 syncMessage", async () => {
    const { wx, storage } = memoryWx();
    seedDraft(storage, { q3: scoredLocal, q2: scoredLocal });
    const questions = [
      { id: "q2", category: "environment", number: 2 },
      { id: "q3", category: "environment", number: 3 },
    ];
    const puts = [];
    globalThis.wx = {
      ...wx,
      request: (options) => {
        if (options.method === "PUT") {
          puts.push(options.url);
          if (options.url === answerUrl("q2")) failWith(options, 500, {});
          else ok(options, { revision: 6 });
          return {};
        }
        ok(options, questionnairePayload(5, { questions }));
        return {};
      },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const pageConfig = await loadSurveyPage("parity-survey-resync-partial");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions);
    expect(puts).toEqual([answerUrl("q2"), answerUrl("q3")]);
    // q2 失败留在待补发集合，草稿保持未同步；q3 成功推进 revision；无冲突则横幅清空。
    expect(context.pendingResync.has("q2")).toBe(true);
    expect(context.pendingResync.has("q3")).toBe(false);
    const draft = storage.get(draftKey);
    expect(draft.revision).toBe(6);
    expect(draft.synced).toBe(false);
    expect(context.data.syncMessage).toBe("");
    expect(context.data.conflict).toBe(false);
  });
});

describe("问卷页 score 联动待补发集合（对齐 SurveyPage score）", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; });

  it("仍有待补发题时 score 成功：仅 advanceDraftRevision，草稿保持 synced:false", async () => {
    const { wx, storage } = memoryWx();
    seedDraft(storage, { q9: scoredLocal });
    const questions = [
      { id: "q2", category: "environment", number: 2 },
      { id: "q9", category: "environment", number: 9 },
    ];
    globalThis.wx = {
      ...wx,
      request: (options) => {
        if (options.method === "PUT") {
          if (options.url === answerUrl("q9")) { failWith(options, 500, {}); return {}; }
          ok(options, { revision: 6 });
          return {};
        }
        ok(options, questionnairePayload(5, { questions }));
        return {};
      },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const pageConfig = await loadSurveyPage("parity-survey-score-advance");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions); // q9 补发失败 → 留在集合
    expect(context.pendingResync.has("q9")).toBe(true);
    await pageConfig.score.call(context, { currentTarget: { dataset: { id: "q2" } } });
    expect(context.data.syncMessage).toBe("已保存");
    expect(context.routeMeta.revision).toBe(6);
    const draft = storage.get(draftKey);
    expect(draft.revision).toBe(6);
    expect(draft.synced).toBe(false);
    expect(draft.answers.q9).toEqual(scoredLocal);
    expect(draft.answers.q2).toEqual(scoredLocal);
    expect(context.pendingResync.has("q9")).toBe(true);
  });

  it("无待补发题时 score 成功：markDraftSynced 置 synced:true", async () => {
    const { wx, storage } = memoryWx();
    const questions = [{ id: "q1", category: "environment", number: 1 }];
    globalThis.wx = {
      ...wx,
      request: (options) => {
        if (options.method === "PUT") { ok(options, { revision: 6 }); return {}; }
        ok(options, questionnairePayload(5, { questions }));
        return {};
      },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const pageConfig = await loadSurveyPage("parity-survey-score-synced");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions);
    await pageConfig.score.call(context, { currentTarget: { dataset: { id: "q1" } } });
    expect(context.data.syncMessage).toBe("已保存");
    const draft = storage.get(draftKey);
    expect(draft.revision).toBe(6);
    expect(draft.synced).toBe(true);
    expect(context.pendingResync.size).toBe(0);
  });

  it("score 保存失败：该题进入待补发集合，界面回滚且草稿保持 synced:false", async () => {
    const { wx, storage } = memoryWx();
    const questions = [{ id: "q1", category: "environment", number: 1 }];
    globalThis.wx = {
      ...wx,
      request: (options) => {
        if (options.method === "PUT") { failWith(options, 500, {}); return {}; }
        ok(options, questionnairePayload(5, { questions }));
        return {};
      },
    };
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    const pageConfig = await loadSurveyPage("parity-survey-score-fail");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions);
    await pageConfig.score.call(context, { currentTarget: { dataset: { id: "q1" } } });
    expect(context.pendingResync.has("q1")).toBe(true);
    expect(context.data.answers.q1).toBeUndefined(); // 回滚到点击前
    expect(context.data.syncMessage).toBe("保存失败，请重试");
    expect(storage.get(draftKey).synced).toBe(false);
  });
});

describe("问卷页网络恢复自动补发（对齐 SurveyPage online 监听）", () => {
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.wx; delete globalThis.getApp; delete globalThis.Page; });

  function installRouter(requests, { failsFirstGet = false } = {}) {
    const { wx } = memoryWx({
      request: (options) => {
        requests.push(options);
        if (options.url === QUESTIONNAIRE_URL && failsFirstGet && requests.length === 1) failWith(options, 500, {});
        else ok(options, options.method === "PUT" ? { revision: 6 } : questionnairePayload(5));
        return {};
      },
    });
    globalThis.wx = wx;
    globalThis.getApp = () => ({ globalData: { apiBase: "https://api.test" } });
    return wx;
  }

  it("onLoad 注册一次监听：isConnected=false 不触发 load，true 触发 load 重拉", async () => {
    const requests = [];
    const wx = installRouter(requests);
    const pageConfig = await loadSurveyPage("parity-survey-online-register");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions);
    expect(wx.onNetworkStatusChange).toHaveBeenCalledTimes(1);
    const listener = wx.onNetworkStatusChange.mock.calls[0][0];
    expect(requests.length).toBe(1);
    listener({ isConnected: false });
    await flush();
    expect(requests.length).toBe(1);
    listener({ isConnected: true });
    await until(() => requests.length === 2);
    await flush();
    expect(context.data.loading).toBe(false);
  });

  it("onUnload 以同一回调注销；卸载后 isConnected=true 不再触发 load", async () => {
    const requests = [];
    const wx = installRouter(requests);
    const pageConfig = await loadSurveyPage("parity-survey-online-unload");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions);
    const listener = wx.onNetworkStatusChange.mock.calls[0][0];
    pageConfig.onUnload.call(context);
    expect(wx.offNetworkStatusChange).toHaveBeenCalledTimes(1);
    expect(wx.offNetworkStatusChange.mock.calls[0][0]).toBe(listener);
    listener({ isConnected: true });
    await flush();
    expect(requests.length).toBe(1);
    expect(context.unloaded).toBe(true);
  });

  it("onHide 被盖住期间网络恢复不重拉；onShow 回前台正常重拉", async () => {
    const requests = [];
    const wx = installRouter(requests);
    const pageConfig = await loadSurveyPage("parity-survey-online-hide");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions);
    expect(requests.length).toBe(1);
    const listener = wx.onNetworkStatusChange.mock.calls[0][0];
    pageConfig.onHide.call(context);
    listener({ isConnected: true });
    await flush();
    expect(requests.length).toBe(1); // 被盖住期间网络恢复：不重新加载
    await pageConfig.onShow.call(context); // 返回问卷页：onShow 正常重拉
    await until(() => requests.length === 2);
    await flush();
    expect(context.data.loading).toBe(false);
  });

  it("wx.offNetworkStatusChange 不存在时 onUnload 不抛错", async () => {
    const requests = [];
    const wx = installRouter(requests);
    delete wx.offNetworkStatusChange;
    const pageConfig = await loadSurveyPage("parity-survey-online-nooff");
    const context = makeContext(pageConfig);
    await pageConfig.onLoad.call(context, onLoadOptions);
    expect(() => pageConfig.onUnload.call(context)).not.toThrow();
    expect(context.unloaded).toBe(true);
  });
});

describe("问卷页/草稿存储对齐静态契约", () => {
  const surveyJs = readFileSync(join(mini, "pages/survey/index.js"), "utf8");
  const storeJs = readFileSync(join(mini, "store/survey.js"), "utf8");

  it("页面含互斥/补发顺序/网络恢复/卸载防护的实现标记", () => {
    expect(surveyJs).toContain("loadInProgress");
    expect(surveyJs).toContain("pendingQuestionOrder");
    expect(surveyJs).toContain("advanceDraftRevision");
    expect(surveyJs).toContain("wx.onNetworkStatusChange");
    expect(surveyJs).toContain("wx.offNetworkStatusChange");
    expect(surveyJs).toContain("this.unloaded = true");
    expect(surveyJs).toContain("内容已更新，请刷新后重试");
  });

  it("store 含 advanceDraftRevision 且草稿隔离五要素未被削弱（frontend-contract 守卫）", () => {
    expect(storeJs).toContain("advanceDraftRevision");
    for (const identity of ["userId", "assignmentId", "attemptId", "questionnaireVersionId", "revision"]) {
      expect(storeJs).toContain(identity);
    }
  });
});

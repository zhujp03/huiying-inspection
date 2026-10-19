// C 类纯逻辑测试：router/nav-history.js（history.state 条目身份 + 光标的导航日志）
// 与 store/survey-view.js（会话级分类记忆）。以桩模拟 sessionStorage/history/performance，
// 重点覆盖「真实历史语义」：多步 go(-2)/go(2) 不得丢弃 forward 记录（相邻关系保持）、
// push 后 forward 分支按浏览器语义作废、replace 原位改写、整页文档往返（healthz 场景）、
// 真刷新、存储不可用降级。
// 模块为导航修复新增，不在 contract-paths 钉定的 24 项清单内，按相对路径直载。
import { beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import * as nav from "../../src/router/nav-history.js";
import * as surveyView from "../../src/store/survey-view.js";

let backing;
// 浏览器桩：location.hash 赋值等价「压入未标记新条目」（state 清空）；replaceState 合并写。
// back/forward/go 沿 entries 光标移动（模拟真实浏览器跨条目 state 还原）。
function installBrowser({ navType = "navigate", hash = "#/home", state = null } = {}) {
  const browser = { entries: [{ hash, state }], index: 0 };
  globalThis.window = {
    location: {
      get hash() { return browser.entries[browser.index].hash; },
      set hash(value) {
        browser.entries = browser.entries.slice(0, browser.index + 1);
        browser.entries.push({ hash: value, state: null });
        browser.index += 1;
      },
    },
  };
  globalThis.history = {
    get state() { return browser.entries[browser.index].state; },
    replaceState(next) { browser.entries[browser.index].state = next; },
    back() { if (browser.index > 0) browser.index -= 1; },
    forward() { if (browser.index < browser.entries.length - 1) browser.index += 1; },
    go(delta) {
      browser.index = Math.min(Math.max(browser.index + delta, 0), browser.entries.length - 1);
    },
  };
  globalThis.performance = { getEntriesByType: (type) => (type === "navigation" ? [{ type: navType }] : []) };
  return {
    get state() { return browser.entries[browser.index].state; },
    get entries() { return browser.entries; },
    get index() { return browser.index; },
    back: () => globalThis.history.back(),
    forward: () => globalThis.history.forward(),
    go: (delta) => globalThis.history.go(delta),
  };
}
const logHashes = () => JSON.parse(backing.get("junde:nav-log")).list.map((entry) => entry.hash);
const logCursor = () => JSON.parse(backing.get("junde:nav-log")).cursor;

beforeEach(() => {
  backing = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
  };
});

describe("router/nav-history.js（文档装载语义）", () => {
  it("首开/外链（navigate）：只信当前条目；跨文档往返（back_forward，healthz 场景）同样截断", () => {
    const browser = installBrowser({ navType: "navigate", hash: "#/profile" });
    nav.initNavLog();
    globalThis.window.location.hash = "#/help";
    nav.syncNavLogOnHashChange();
    assert.deepEqual(logHashes(), ["#/profile", "#/help"]);
    const helpId = JSON.parse(backing.get("junde:nav-log")).list[1].id;
    // 整页离开（/healthz）再整页回到同一 #/help：条目身份被浏览器保留，但相邻历史已变。
    installBrowser({ navType: "back_forward", hash: "#/help", state: { jundeNavId: helpId } });
    nav.initNavLog();
    assert.deepEqual(logHashes(), ["#/help"]);
    assert.equal(nav.previousNavEntry(), null, "相邻条目未知（可能是 /healthz），不得声称 profile 为父页");
    assert.equal(browser.state.jundeNavId, helpId);
  });

  it("真刷新（reload）：既有链与光标延续", () => {
    installBrowser({ navType: "navigate", hash: "#/home" });
    nav.initNavLog();
    globalThis.window.location.hash = "#/task?a=1";
    nav.syncNavLogOnHashChange();
    assert.equal(nav.previousNavEntry(), "#/home");
    const snapshot = JSON.parse(backing.get("junde:nav-log"));
    installBrowser({ navType: "reload", hash: "#/task?a=1", state: { jundeNavId: snapshot.list[1].id } });
    nav.initNavLog();
    assert.deepEqual(logHashes(), ["#/home", "#/task?a=1"]);
    assert.equal(logCursor(), 1);
    assert.equal(nav.previousNavEntry(), "#/home");
  });
});

describe("router/nav-history.js（光标语义：多步跳转保持相邻关系）", () => {
  function buildHomeTaskSurvey(browser) {
    nav.initNavLog(); // H
    globalThis.window.location.hash = "#/task?assignmentId=a&source=home"; // T
    nav.syncNavLogOnHashChange();
    globalThis.window.location.hash = "#/survey?attemptId=t"; // S
    nav.syncNavLogOnHashChange();
    assert.deepEqual(logHashes(), ["#/home", "#/task?assignmentId=a&source=home", "#/survey?attemptId=t"]);
    return browser;
  }

  it("审查反例：go(-2) 后 go(2) —— forward 记录保留，survey 的相邻父页仍是同来源任务", () => {
    const browser = buildHomeTaskSurvey(installBrowser({ hash: "#/home" }));
    browser.go(-2); // 回 Home（真实 history 跨条目还原其 state 身份）
    nav.syncNavLogOnHashChange();
    browser.go(2); // 前进到 Survey
    nav.syncNavLogOnHashChange();
    assert.deepEqual(logHashes(), ["#/home", "#/task?assignmentId=a&source=home", "#/survey?attemptId=t"], "后退不得丢弃 forward 记录");
    assert.equal(logCursor(), 2);
    assert.equal(nav.previousNavEntry(), "#/task?assignmentId=a&source=home", "相邻父页必须是任务条目，而非 Home");
    assert.equal(nav.navEntryIsPage(nav.previousNavEntry(), "/task", { assignmentId: "a" }), true);
  });

  it("后退后再前进逐条返回：光标随已知身份移动", () => {
    const browser = buildHomeTaskSurvey(installBrowser({ hash: "#/home" }));
    browser.back();
    nav.syncNavLogOnHashChange();
    assert.deepEqual(logHashes(), ["#/home", "#/task?assignmentId=a&source=home", "#/survey?attemptId=t"]);
    assert.equal(logCursor(), 1);
    assert.equal(nav.previousNavEntry(), "#/home");
    browser.forward();
    nav.syncNavLogOnHashChange();
    assert.equal(logCursor(), 2);
    assert.equal(nav.previousNavEntry(), "#/task?assignmentId=a&source=home");
  });

  it("后退后 push 新条目：丢弃 forward 分支（与浏览器语义一致）", () => {
    const browser = buildHomeTaskSurvey(installBrowser({ hash: "#/home" }));
    browser.go(-2);
    nav.syncNavLogOnHashChange();
    globalThis.window.location.hash = "#/help";
    nav.syncNavLogOnHashChange();
    assert.deepEqual(logHashes(), ["#/home", "#/help"]);
    assert.equal(logCursor(), 1);
  });

  it("未知身份条目（被 32 条上限挤出等）按新前进降级，不假设邻接", () => {
    const browser = buildHomeTaskSurvey(installBrowser({ hash: "#/home" }));
    browser.go(-1); // 回 Task
    nav.syncNavLogOnHashChange();
    // 模拟一个「身份未知」的前进条目（state 未标记，如同外部脚本/异常路径造出的条目）。
    browser.go(1);
    browser.entries[browser.index].state = null;
    nav.syncNavLogOnHashChange();
    assert.equal(logHashes()[logHashes().length - 1], "#/survey?attemptId=t");
    assert.equal(logCursor(), logHashes().length - 1);
  });

  it("已标记但被挤出日志的旧条目（原生后退）：降级为单例证据，不伪造与光标条目的邻接", () => {
    // 审查反例：init #/help → 36 次应用 push（help 被挤出 32 条窗口）→ 物理后退回旧 help。
    const browser = installBrowser({ hash: "#/help" });
    nav.initNavLog();
    const helpId = JSON.parse(backing.get("junde:nav-log")).list[0].id;
    for (let index = 1; index <= 36; index += 1) {
      globalThis.window.location.hash = `#/task?assignmentId=a${index}`;
      nav.recordNavPush(`#/task?assignmentId=a${index}`);
    }
    assert.ok(JSON.parse(backing.get("junde:nav-log")).list.every((item) => item.id !== helpId), "help 已被挤出");
    // 原生后退到仍物理存在的旧 help 条目（state 身份被浏览器保留）。
    browser.go(-36);
    assert.equal(browser.state.jundeNavId, helpId);
    nav.syncNavLogOnHashChange();
    assert.deepEqual(logHashes(), ["#/help"], "不得当作与光标条目相邻的新 push");
    assert.equal(logCursor(), 0);
    assert.equal(nav.previousNavEntry(), null, "旧条目的真实父页从未记录：不得声称任何任务为父页");
    // 单例降级后 Help 的返回键走 replace 兜底（留在应用内），原生后退不再可能跳出。
  });

  it("recordNavPush 同步入栈并标记；hashchange 到来后 no-op；后退后 push 丢弃 forward 分支", () => {
    const browser = installBrowser({ hash: "#/home" });
    nav.initNavLog();
    // 与 App.navigate 一致的调用序：先改 hash（新物理条目、state 为空），再同步标记。
    globalThis.window.location.hash = "#/task?a=1";
    nav.recordNavPush("#/task?a=1");
    assert.deepEqual(logHashes(), ["#/home", "#/task?a=1"]);
    assert.equal(logCursor(), 1);
    assert.match(browser.state.jundeNavId, /^nav-/);
    // hashchange 到来时身份已在光标处：no-op（不重复入栈）。
    nav.syncNavLogOnHashChange();
    assert.deepEqual(logHashes(), ["#/home", "#/task?a=1"]);
    globalThis.window.location.hash = "#/survey?a=1";
    nav.recordNavPush("#/survey?a=1");
    assert.deepEqual(logHashes(), ["#/home", "#/task?a=1", "#/survey?a=1"]);
    // 后退后 push：forward 分支作废（与浏览器语义一致）。
    browser.back();
    nav.syncNavLogOnHashChange();
    globalThis.window.location.hash = "#/other";
    nav.recordNavPush("#/other");
    assert.deepEqual(logHashes(), ["#/home", "#/task?a=1", "#/other"]);
    assert.equal(logCursor(), 2);
  });

  it("recordNavReplace 原位改写光标条目，保留 forward 记录与相邻关系", () => {
    const browser = buildHomeTaskSurvey(installBrowser({ hash: "#/home" })); // 光标在 S
    // 问卷页把自身 URL 的分类同步进光标条目（survey 分类视图态，物理条目不变）。
    nav.recordNavReplace("#/survey?attemptId=t&category=service");
    assert.deepEqual(logHashes(), ["#/home", "#/task?assignmentId=a&source=home", "#/survey?attemptId=t&category=service"], "replace 不得丢弃 forward 记录");
    assert.equal(logCursor(), 2);
    assert.equal(nav.previousNavEntry(), "#/task?assignmentId=a&source=home");
    // replace 后后退再前进：相邻关系保持。
    browser.back();
    nav.syncNavLogOnHashChange();
    browser.forward();
    nav.syncNavLogOnHashChange();
    assert.equal(nav.previousNavEntry(), "#/task?assignmentId=a&source=home");
  });

  it("forgetCurrentNav 光标退一格；配对 sync 后不再重复后退", () => {
    const browser = buildHomeTaskSurvey(installBrowser({ hash: "#/home" }));
    nav.forgetCurrentNav();
    assert.equal(logCursor(), 1);
    assert.equal(nav.previousNavEntry(), "#/home");
    browser.back(); // 物理后退落在 Task（已知身份）
    nav.syncNavLogOnHashChange(); // 光标已在 1 → no-op
    assert.equal(logCursor(), 1);
    assert.equal(nav.previousNavEntry(), "#/home");
  });

  it("日志有界（≤32 条）：挤出最老条目后光标仍指向当前条目", () => {
    const browser = installBrowser({ hash: "#/page-0" });
    nav.initNavLog();
    for (let index = 1; index < 40; index += 1) {
      globalThis.window.location.hash = `#/page-${index}`;
      nav.recordNavPush(`#/page-${index}`);
    }
    assert.ok(logHashes().length <= 32, `日志应封顶 32 条，实际 ${logHashes().length}`);
    assert.equal(logHashes()[logHashes().length - 1], "#/page-39");
    assert.equal(logCursor(), logHashes().length - 1);
    assert.equal(nav.previousNavEntry(), "#/page-38");
  });

  it("存储不可用：全部操作静默，previous 恒为 null（按无父页处理）", () => {
    const browser = installBrowser({ hash: "#/home" });
    globalThis.sessionStorage = {
      getItem: () => { throw new Error("quota"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => {},
    };
    assert.doesNotThrow(() => nav.initNavLog());
    assert.equal(nav.previousNavEntry(), null);
    browser.entries[browser.index] = { hash: "#/task?a=1", state: null };
    assert.doesNotThrow(() => nav.syncNavLogOnHashChange());
    assert.doesNotThrow(() => nav.recordNavPush("#/x"));
    assert.doesNotThrow(() => nav.recordNavReplace("#/y"));
    assert.doesNotThrow(() => nav.forgetCurrentNav());
    assert.equal(nav.previousNavEntry(), null);
  });

  it("nextNavEntry（问题页返回证据）：survey→issue 后退回 survey，光标后的 forward 条目即来路", () => {
    const browser = buildHomeTaskSurvey(installBrowser({ hash: "#/home" }));
    assert.equal(nav.nextNavEntry(), null, "链尾无前进条目");
    // openIssue：应用内 push 到问题页（与 App.navigate 一致：先改 hash 再同步标记），
    // 再原生后退回问卷——确认/取消返回与浏览器后退共用同一日志语义。
    globalThis.window.location.hash = "#/issue?assignmentId=a&attemptId=t&questionId=q1&target=unscored";
    nav.recordNavPush("#/issue?assignmentId=a&attemptId=t&questionId=q1&target=unscored");
    browser.back();
    nav.syncNavLogOnHashChange();
    assert.equal(logCursor(), 2);
    assert.equal(nav.nextNavEntry(), "#/issue?assignmentId=a&attemptId=t&questionId=q1&target=unscored", "后退不得丢弃 forward 记录，来路可证");
    assert.equal(nav.previousNavEntry(), "#/task?assignmentId=a&source=home", "previous 仍是任务父页，不能作为返回证据");
    // 问题页兜底 replace（无父页证据）：goBack 停在问题页条目上原位改写为问卷，
    // 改写后 forward 相邻不再可证（恢复降级为不滚动）。
    browser.forward(); // 回到问题页（已知身份，光标随动）
    nav.syncNavLogOnHashChange();
    assert.equal(logCursor(), 3);
    nav.recordNavReplace("#/survey?attemptId=t&category=service");
    assert.equal(nav.nextNavEntry(), null);
  });

  it("nextNavEntry：前进 push 截断 forward 分支后为 null；存储不可用静默", () => {
    const browser = buildHomeTaskSurvey(installBrowser({ hash: "#/home" }));
    globalThis.window.location.hash = "#/issue?questionId=q1";
    nav.recordNavPush("#/issue?questionId=q1");
    browser.back();
    nav.syncNavLogOnHashChange();
    globalThis.window.location.hash = "#/survey?attemptId=other"; // 自任务重进：push 截断 forward
    nav.recordNavPush("#/survey?attemptId=other");
    assert.equal(nav.nextNavEntry(), null, "旧问题页条目已按 push 语义作废，不得当作返回证据");
    globalThis.sessionStorage = {
      getItem: () => { throw new Error("quota"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => {},
    };
    assert.doesNotThrow(() => nav.nextNavEntry());
    assert.equal(nav.nextNavEntry(), null);
  });
});

describe("router/nav-history.js（业务校验纯函数）", () => {
  it("navEntryIsPage：路径一致且指定参数全等才算同页（同任务父页校验）", () => {
    const entry = "#/survey?assignmentId=a1&attemptId=t1&questionnaireVersionId=qv1&revision=3&category=product";
    assert.equal(nav.navEntryIsPage(entry, "/survey", { assignmentId: "a1", attemptId: "t1" }), true);
    assert.equal(nav.navEntryIsPage(entry, "/survey", { assignmentId: "a1", attemptId: "other" }), false);
    assert.equal(nav.navEntryIsPage(entry, "/dishes", { assignmentId: "a1", attemptId: "t1" }), false);
    assert.equal(nav.navEntryIsPage("#/profile", "/profile"), true);
    assert.equal(nav.navEntryIsPage(null, "/survey", {}), false);
  });

  it("sanitizeTaskSource 白名单：仅 home/schedule 生效，其余一律 schedule（非法值带不出应用）", () => {
    assert.equal(nav.sanitizeTaskSource("home"), "home");
    assert.equal(nav.sanitizeTaskSource("schedule"), "schedule");
    for (const hostile of ["profile", "", "javascript:alert(1)", "https://evil.example", null, undefined]) {
      assert.equal(nav.sanitizeTaskSource(hostile), "schedule");
    }
  });
});

describe("store/survey-view.js（会话级分类记忆，不进草稿身份）", () => {
  it("remember/recall 按 attemptId 隔离，空参安全", () => {
    surveyView.rememberSurveyCategory("attempt-1", "service");
    surveyView.rememberSurveyCategory("attempt-2", "product");
    assert.equal(surveyView.recallSurveyCategory("attempt-1"), "service");
    assert.equal(surveyView.recallSurveyCategory("attempt-2"), "product");
    assert.equal(surveyView.recallSurveyCategory("attempt-3"), "");
    assert.equal(surveyView.recallSurveyCategory(""), "");
    assert.doesNotThrow(() => surveyView.rememberSurveyCategory("", "service"));
  });

  it("存储不可用时读写均不抛出", () => {
    globalThis.sessionStorage = {
      getItem: () => { throw new Error("quota"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => {},
    };
    assert.doesNotThrow(() => surveyView.rememberSurveyCategory("attempt-1", "service"));
    assert.equal(surveyView.recallSurveyCategory("attempt-1"), "");
  });
});

describe("store/survey-view.js（问题页返回锚点：attempt+问卷版本隔离，读后即清）", () => {
  const ANCHOR = {
    questionId: "q-8",
    offsetTop: 312,
    category: "environment",
    expandedIds: ["q-5", "q-8"],
  };
  const keyOf = (attemptId, versionId) => `junde:survey-return:${attemptId}:${versionId}`;

  it("remember/recall 原样往返；forget 后读不到（恢复恰好一次的存储前提）", () => {
    surveyView.rememberSurveyReturnAnchor("at-1", "qv-1", ANCHOR);
    assert.deepEqual(surveyView.recallSurveyReturnAnchor("at-1", "qv-1"), ANCHOR);
    surveyView.forgetSurveyReturnAnchor("at-1", "qv-1");
    assert.equal(surveyView.recallSurveyReturnAnchor("at-1", "qv-1"), null);
    assert.equal(backing.has(keyOf("at-1", "qv-1")), false, "读后即清：键不得残留");
  });

  it("键按 attempt+问卷版本隔离：其他任务/其他版本读不到（防跨任务滚动劫持）", () => {
    surveyView.rememberSurveyReturnAnchor("at-1", "qv-1", ANCHOR);
    assert.equal(surveyView.recallSurveyReturnAnchor("at-2", "qv-1"), null);
    assert.equal(surveyView.recallSurveyReturnAnchor("at-1", "qv-2"), null);
    // 空参安全：不写入、不抛出。
    assert.doesNotThrow(() => surveyView.rememberSurveyReturnAnchor("", "qv-1", ANCHOR));
    assert.doesNotThrow(() => surveyView.rememberSurveyReturnAnchor("at-1", "", ANCHOR));
    assert.doesNotThrow(() => surveyView.rememberSurveyReturnAnchor("at-1", "qv-1", null));
    assert.equal(surveyView.recallSurveyReturnAnchor("", "qv-1"), null);
    assert.equal(surveyView.recallSurveyReturnAnchor("at-1", ""), null);
    assert.equal(backing.has(keyOf("at-1", "qv-1")), true, "空参调用不影响既有锚点");
  });

  it("坏值安全降级：非法 JSON、缺字段、类型不符一律 recall 为 null", () => {
    const cases = [
      "{not-json",
      "null",
      "[]",
      '"string"',
      JSON.stringify({ offsetTop: 10, category: "c", expandedIds: [] }),
      JSON.stringify({ questionId: "q-1", category: "c", expandedIds: [] }),
      JSON.stringify({ questionId: "q-1", offsetTop: "312", category: "c", expandedIds: [] }),
      JSON.stringify({ questionId: "q-1", offsetTop: Number.NaN, category: "c", expandedIds: [] }),
      JSON.stringify({ questionId: "q-1", offsetTop: 10, expandedIds: [] }),
      JSON.stringify({ questionId: "q-1", offsetTop: 10, category: 7, expandedIds: [] }),
      JSON.stringify({ questionId: "q-1", offsetTop: 10, category: "c" }),
      JSON.stringify({ questionId: "q-1", offsetTop: 10, category: "c", expandedIds: ["ok", ""] }),
      JSON.stringify({ questionId: "q-1", offsetTop: 10, category: "c", expandedIds: "q-5" }),
      JSON.stringify({ questionId: "", offsetTop: 10, category: "c", expandedIds: [] }),
    ];
    for (const [index, raw] of cases.entries()) {
      backing.set(keyOf("at-bad", "qv-1"), raw);
      assert.equal(surveyView.recallSurveyReturnAnchor("at-bad", "qv-1"), null, `case ${index}: ${raw}`);
    }
  });

  it("空 expandedIds/category 合法（锚点恢复的最小形态）；forget 空参不抛出", () => {
    const minimal = { questionId: "q-1", offsetTop: -40, category: "", expandedIds: [] };
    surveyView.rememberSurveyReturnAnchor("at-min", "qv-1", minimal);
    assert.deepEqual(surveyView.recallSurveyReturnAnchor("at-min", "qv-1"), minimal);
    assert.doesNotThrow(() => surveyView.forgetSurveyReturnAnchor("", "qv-1"));
    assert.doesNotThrow(() => surveyView.forgetSurveyReturnAnchor("at-min", ""));
  });

  it("存储不可用时读写清均不抛出，recall 恒为 null", () => {
    globalThis.sessionStorage = {
      getItem: () => { throw new Error("quota"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("quota"); },
    };
    assert.doesNotThrow(() => surveyView.rememberSurveyReturnAnchor("at-1", "qv-1", ANCHOR));
    assert.equal(surveyView.recallSurveyReturnAnchor("at-1", "qv-1"), null);
    assert.doesNotThrow(() => surveyView.forgetSurveyReturnAnchor("at-1", "qv-1"));
  });
});

// T3 任务与提交语义：TaskPage「继续填写」已提交守卫静态契约（风格对齐 score-wipe.test.js）。
//
// 背景：assignment 聚合状态滞后于 attempt 终态的窗口内，task.attempt.status 可能已是 submitted
// 而页面仍渲染「继续填写」；原实现有 attempt 即 replace 进问卷，用户会落在一个必然 409 的页面。
// 契约：continueDraft 命中 attempt.status === "submitted" 时不导航，toast「该任务已提交」，
// 并单次 load 重拉聚合（聚合状态翻转为 submitted 后页面显示既有「任务已提交」终态卡）；
// 守卫路径禁止 setInterval/setTimeout 轮询式自动刷新（防「无限刷新」）；navigating 防重保留。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// apps/web/tests/rules → 仓库根需上跳四级（与 submit-semantics.test.js 的 ../../../.. 同口径）。
const root = resolve(import.meta.dirname, "../../../..");
const taskPage = readFileSync(join(root, "apps/web/src/pages/TaskPage.jsx"), "utf8");

// continueDraft 函数切片：函数声明起，到下一个两级缩进的关闭 `};` 为止
// （函数体内行缩进均 ≥4 空格，`\n  };` 只会命中函数自身的关闭行）。
const fnStart = taskPage.indexOf("const continueDraft = () => {");
const fnEnd = taskPage.indexOf("\n  };", Math.max(fnStart, 0) + 1);
const continueDraft = fnStart >= 0 && fnEnd > fnStart ? taskPage.slice(fnStart, fnEnd + "\n  };".length) : "";

// 守卫分支切片：submitted 条件行起，到四空格缩进的关闭 `}` 行之前为止。
const guardStart = continueDraft.indexOf('if (current.attempt?.status === "submitted") {');
const guardEnd = continueDraft.indexOf("\n    }", Math.max(guardStart, 0) + 1);
const guardBranch = guardStart >= 0 && guardEnd > guardStart ? continueDraft.slice(guardStart, guardEnd) : "";

describe("继续填写已提交守卫契约（apps/web/src/pages/TaskPage.jsx continueDraft）", () => {
  it("continueDraft 切片提取有效且守卫分支存在", () => {
    expect(fnStart).toBeGreaterThanOrEqual(0);
    expect(continueDraft).toContain("const continueDraft = () => {");
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardBranch).toContain('current.attempt?.status === "submitted"');
  });

  it("守卫路径不导航：不调用 openSurvey / replace", () => {
    expect(guardBranch).not.toContain("openSurvey");
    expect(guardBranch).not.toMatch(/\breplace\(/);
    expect(guardBranch).toContain("return;");
  });

  it("守卫路径 toast 提示并单次 load 重拉聚合", () => {
    expect(guardBranch).toContain('toast("该任务已提交")');
    expect(guardBranch).toContain("load(assignmentIdRef.current)");
  });

  it("禁止轮询式自动刷新，navigating 防重保留", () => {
    expect(continueDraft).not.toContain("setInterval");
    expect(guardBranch).not.toContain("setTimeout");
    expect(continueDraft).toContain("navigatingRef.current");
  });
});

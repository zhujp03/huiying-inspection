// H5 提交语义静态契约（OtherPage.jsx 源码字符串扫描，风格对齐 score-wipe.test.js / strict-mode-unloaded-guard.test.js）。
//
// 背景（本批次 T2 修订，2026-10-11）：
// 1. 提交 body 的 assignmentRevision 必须是任务（audit_assignments）的 revision——后端
//    POST /api/questionnaires/secret/:id/submit 以 Number(assignmentRow.revision) !== body.assignmentRevision
//    判 409 SUBMIT_STATE_INVALID。问卷 attempt 的 revision（routeMeta.revision / saved.revision）
//    绝不能兜底进提交 body（旧三级兜底 `?? result.assignment?.revision ?? nextMeta.revision` 等已废除）。
// 2. 409 三态映射（session 分支已在 handleSessionError 优先处理）：SUBMIT_PROCESSING{retryable:true} →
//    保 token 进 retryable_failed 同 token 续试；TASK_OVERDUE{requiresNewToken:true} → 清 token 进
//    refresh_required，错误条提供手动「刷新」；QUESTIONNAIRE_SUBMITTED → 已提交终态跳任务详情；
//    其余 → 终态失败清 token。
// 3. 幂等语义（dedupeKey 含 submitToken，r67-r99.test.js R79）不受本修订影响，既有断言保持不动。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// apps/web/tests/rules → 仓库根需上跳四级（r67-r99.test.js 同目录；score-wipe.test.js 在 tests/ 下为三级）。
const root = resolve(import.meta.dirname, "../../../..");
const src = readFileSync(join(root, "apps/web/src/pages/OtherPage.jsx"), "utf8");

// 提取共用三态映射函数 handleSubmitError 的函数体切片（从声明到下一个同级 const 声明），供分支切片断言。
const handlerStart = src.indexOf("const handleSubmitError");
const handlerEnd = src.indexOf("const submitWithExistingToken");
const handler = handlerStart >= 0 && handlerEnd > handlerStart ? src.slice(handlerStart, handlerEnd) : "";

describe("OtherPage 提交链 assignmentRevision 契约（audit_assignments.revision 口径）", () => {
  it("load() 直接取任务 revision 且防御非整数；废除 result.assignment / attempt revision 兜底", () => {
    expect(src).toContain("assignmentRevisionRef.current = assignment.revision;");
    expect(src, "任务 revision 非整数必须走加载失败路径，绝不带病进入提交链").toContain(
      "if (!Number.isInteger(assignment.revision)) throw",
    );
    expect(src, "getDraft 响应从无 assignment 字段，该兜底恒 undefined 必须移除").not.toContain("result.assignment?.revision");
    expect(src, "attempt revision 绝不能兜底进任务 revision").not.toContain("?? nextMeta.revision");
  });

  it("saveRecords() 只认服务端 assignmentRevision，废除 saved.revision（attempt revision）兜底", () => {
    expect(src).toContain("assignmentRevisionRef.current = saved.assignmentRevision ?? assignmentRevisionRef.current;");
    expect(src, "PUT other-records 响应只有 attempt revision，绝不能兜底进任务 revision").not.toContain("?? saved.revision");
  });

  it("两条提交路径 body 一律 assignmentRevisionRef.current，且非整数守卫先行（不发请求、不回退 attempt revision）", () => {
    const bodyAssignments = src.match(/assignmentRevision: assignmentRevisionRef\.current\s*,/g) || [];
    expect(bodyAssignments.length, "submit 与 submitWithExistingToken 两处提交 body 各恰一处，且无任何 ?? 兜底").toBe(2);
    expect(src, "提交 body 不得出现任何 ?? 兜底（旧 routeMeta attempt revision 兜底已废除）").not.toMatch(
      /assignmentRevision:\s*[\w$.]+\s*\?\?/,
    );
    expect((src.match(/if \(!requireFreshAssignment\(\)\) return;/g) || []).length, "两条提交路径都必须先过 revision 守卫").toBe(2);
    expect(src, "守卫失败提示文案钉死").toContain("任务信息已过期，请刷新后重试");
  });
});

describe("OtherPage 提交错误三态映射（handleSubmitError）", () => {
  it("分支齐备且优先级正确：已提交终态 > 可重试 > 需刷新换 token > 终态失败", () => {
    expect(handler, "缺少共用三态映射函数 handleSubmitError").toBeTruthy();
    const submittedAt = handler.indexOf('kind === "questionnaire_submitted"');
    const retryableAt = handler.indexOf("retryable === true");
    const newTokenAt = handler.indexOf("requiresNewToken === true");
    const terminalAt = handler.indexOf("terminal_failed");
    expect(submittedAt, "缺少 questionnaire_submitted 分支").toBeGreaterThanOrEqual(0);
    expect(retryableAt, "retryable 分支必须排在已提交终态之后").toBeGreaterThan(submittedAt);
    expect(newTokenAt, "requiresNewToken 分支必须排在可重试之后").toBeGreaterThan(retryableAt);
    expect(terminalAt, "终态失败必须排在最后兜底").toBeGreaterThan(newTokenAt);
  });

  it("questionnaire_submitted → 已提交终态：清草稿、清 token、toast 并跳任务详情", () => {
    const branch = handler.slice(handler.indexOf('kind === "questionnaire_submitted"'), handler.indexOf("retryable === true"));
    expect(branch).toContain("clearDraft(");
    expect(branch).toContain("submitTokenRef.current = null;");
    expect(branch).toContain('toast("该任务已提交")');
    expect(branch).toContain("/task?assignmentId=");
  });

  it("retryable=true → 保 token 进 retryable_failed（分支内不清 token），消息拼「可以重试提交」", () => {
    const branch = handler.slice(handler.indexOf("retryable === true"), handler.indexOf("requiresNewToken === true"));
    expect(branch).toContain('setSubmitState("retryable_failed")');
    expect(branch, "可重试失败必须保留原 token 同 token 续试").not.toContain("submitTokenRef.current = null");
    expect(branch).toContain("，可以重试提交");
  });

  it("requiresNewToken=true → 清 token 进 refresh_required，错误条提供手动「刷新」（retryLoad），不自动循环", () => {
    const branch = handler.slice(handler.indexOf("requiresNewToken === true"), handler.indexOf("terminal_failed"));
    expect(branch).toContain("submitTokenRef.current = null;");
    expect(branch).toContain('setSubmitState("refresh_required")');
    expect(src, "错误条必须提供手动触发的「刷新」按钮（复用 retryLoad）").toContain('onClick={retryLoad}>刷新</button>');
  });

  it("其余 → 终态失败：清 token 进 terminal_failed", () => {
    // 以处理器内最后一次「清 token」为切片起点：若终态兜底分支丢失清 token，
    // 切片会落在 requiresNewToken 分支，setSubmitState("terminal_failed") 不在其中而失败。
    const branch = handler.slice(handler.lastIndexOf("submitTokenRef.current = null;"));
    expect(branch).toContain('setSubmitState("terminal_failed")');
    expect(branch).toContain('setMessage(submitError?.message || "提交未完成")');
  });
});

describe("OtherPage refresh_required 不破坏既有状态机", () => {
  it("locked/busy/viewState 口径不变，data-submit-state 直读 submitState", () => {
    expect(src).toContain('const locked = () => ["submitting", "processing", "submitted"].includes(latestRef.current.submitState);');
    expect(src).toContain('const busy = saving || ["submitting", "processing"].includes(submitState);');
    expect(src).toContain("data-submit-state={submitState}");
  });

  it("两个提交 catch 统一走 handleSessionError（session 优先）→ handleSubmitError（三态映射）", () => {
    expect((src.match(/handleSubmitError\(submitError\);/g) || []).length).toBe(2);
    expect((src.match(/if \(handleSessionError\(submitError\)\) return;/g) || []).length).toBe(2);
  });
});

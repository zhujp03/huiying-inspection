import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const source = readFileSync(join(root, "apps/api/src/batch3/routes.js"), "utf8");

// 按路由注册语句切片；切片起点/终点不存在时立即失败，避免切片写错静默通过。
const sliceBetween = (start, end) => {
  const from = source.indexOf(start);
  expect(from, `切片起点未命中：${start}`).not.toBe(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `切片终点未命中：${end}`).not.toBe(-1);
  return source.slice(from, to);
};

describe("answer 二值协议后端静态契约（apps/api/src/batch3/routes.js）", () => {
  it("提交事务占用校验循环对 unscored 兜底要求 issue_remark 非空", () => {
    const submit = sliceBetween(
      'app.post("/api/questionnaires/secret/:id/submit"',
      'app.put("/api/questionnaires/secret/drafts/:id/answers/:questionId"'
    );
    expect(submit).toContain('answer.answer === "unscored"');
    expect(submit).toContain("issue_remark");
    expect(submit).toContain("ISSUE_REMARK_REQUIRED");
    expect(submit).toContain("不得分说明不能为空");
  });

  it("confirm 路由仍保留 ISSUE_REMARK_REQUIRED 校验（既有能力未回退）", () => {
    const confirm = sliceBetween(
      'app.post("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/confirm"',
      'app.post("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/cancel"'
    );
    expect(confirm).toContain("ISSUE_REMARK_REQUIRED");
  });

  it("PATCH edit-sessions 路由不校验 ISSUE_REMARK_REQUIRED（草稿可暂存语义）", () => {
    const patch = sliceBetween(
      'app.patch("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId"',
      'app.post("/api/questionnaires/secret/drafts/:id/questions/:questionId/edit-sessions/:editSessionId/confirm"'
    );
    expect(patch).not.toContain("ISSUE_REMARK_REQUIRED");
  });
});

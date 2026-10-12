import { describe, expect, it } from "vitest";
import { AssignmentExtendSchema } from "../../packages/contracts/index.js";

const iso = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

describe("assignment extend contract (dual window)", () => {
  it("accepts both dueAt and questionnaireDeadlineAt", () => {
    const dueAt = iso(30);
    const questionnaireDeadlineAt = iso(60);
    const parsed = AssignmentExtendSchema.parse({ revision: 3, reason: "暴雨延迟到店", dueAt, questionnaireDeadlineAt });
    expect(parsed).toMatchObject({ revision: 3, reason: "暴雨延迟到店", dueAt, questionnaireDeadlineAt });
  });

  it("accepts dueAt only (legacy execution-window body)", () => {
    const dueAt = iso(30);
    const parsed = AssignmentExtendSchema.parse({ revision: 0, reason: "探店员时间冲突", dueAt });
    expect(parsed.dueAt).toBe(dueAt);
  });

  it("accepts questionnaireDeadlineAt only", () => {
    const questionnaireDeadlineAt = iso(90);
    const parsed = AssignmentExtendSchema.parse({ revision: 2, reason: "问卷补录", questionnaireDeadlineAt });
    expect(parsed.questionnaireDeadlineAt).toBe(questionnaireDeadlineAt);
  });

  it("rejects an empty extension body with the refine message", () => {
    const result = AssignmentExtendSchema.safeParse({ revision: 1, reason: "无时间字段" });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.message === "请至少填写一项延期时间")).toBe(true);
  });

  it("requires reason", () => {
    const result = AssignmentExtendSchema.safeParse({ revision: 1, dueAt: iso(30) });
    expect(result.success).toBe(false);
  });

  it("requires revision", () => {
    const result = AssignmentExtendSchema.safeParse({ reason: "缺少版本号", dueAt: iso(30) });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO dueAt", () => {
    const result = AssignmentExtendSchema.safeParse({ revision: 1, reason: "格式错误", dueAt: "明天下午" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO questionnaireDeadlineAt", () => {
    const result = AssignmentExtendSchema.safeParse({ revision: 1, reason: "格式错误", questionnaireDeadlineAt: "下周五" });
    expect(result.success).toBe(false);
  });
});

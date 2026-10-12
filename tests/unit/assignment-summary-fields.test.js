import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AssignmentSummarySchema } from "../../packages/contracts/index.js";

const root = resolve(import.meta.dirname, "../..");
const routesSource = readFileSync(join(root, "apps/api/src/batch2/routes.js"), "utf8");

const validSummary = {
  id: "a0000000-0000-0000-0000-000000000001",
  businessNo: "A-TEST0001",
  name: "测试活动",
  storeName: "测试门店",
  storeAddress: "测试地址",
  budgetLimitCents: 10000,
  specialInstruction: "",
  dishRequirements: [],
  taskType: "secret",
  status: "assigned",
  revision: 3,
  receiptRequired: true,
  questionnaireDeadlineAt: "2026-01-02T03:04:05.000Z",
  startsAt: "2026-01-01T00:00:00.000Z",
  dueAt: "2026-01-03T00:00:00.000Z",
  submittedAt: null,
  cancelReason: null,
  hasAttempt: false,
};

describe("任务摘要三字段契约（revision / receiptRequired / questionnaireDeadlineAt）", () => {
  it("AssignmentSummarySchema 接受含三个新字段的完整合法样例", () => {
    const parsed = AssignmentSummarySchema.parse(validSummary);
    expect(parsed.revision).toBe(3);
    expect(parsed.receiptRequired).toBe(true);
    expect(parsed.questionnaireDeadlineAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("revision 必填：缺失时 parse 抛错", () => {
    const missing = { ...validSummary };
    delete missing.revision;
    expect(() => AssignmentSummarySchema.parse(missing)).toThrow();
  });

  it("receiptRequired 必须为 boolean：字符串类型 parse 抛错", () => {
    expect(() => AssignmentSummarySchema.parse({ ...validSummary, receiptRequired: "yes" })).toThrow();
  });

  it("assignmentSummary 输出三个新映射（静态断言 batch2/routes.js）", () => {
    expect(routesSource).toContain("revision: Number(assignment.revision)");
    expect(routesSource).toContain("receiptRequired: Boolean(assignment.receipt_required)");
    expect(routesSource).toContain("questionnaireDeadlineAt: assignment.questionnaire_deadline_at ? assignment.questionnaire_deadline_at.toISOString() : null");
  });
});

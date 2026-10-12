import { describe, expect, it } from "vitest";
import { firstIncompleteQuestion, isBlankExtraDish, validateDish } from "../../apps/miniapp/miniprogram/utils/business.js";

describe("mini-program dish completion", () => {
  const ordered = {
    requirementId: "requirement-one",
    required: true,
    allowSubstitution: true,
    actualName: "招牌菜",
    fulfillmentStatus: "ordered",
    substitutionReason: "",
    unavailableReason: "",
    evaluation: "",
    fullySatisfied: true,
  };

  it("accepts evaluation or satisfaction and becomes incomplete after satisfaction is cancelled", () => {
    expect(validateDish(ordered)).toBe("");
    expect(validateDish({ ...ordered, fullySatisfied: false })).toContain("评价或选择全部满意");
    expect(validateDish({ ...ordered, fullySatisfied: false, evaluation: "温度合适" })).toBe("");
  });

  it("enforces substituted, unavailable, skipped and extra conditions", () => {
    expect(validateDish({ ...ordered, fulfillmentStatus: "substituted", substitutionReason: "原菜售罄" })).toBe("");
    expect(validateDish({ ...ordered, fulfillmentStatus: "substituted", allowSubstitution: false })).toContain("不允许替代");
    expect(validateDish({ ...ordered, fulfillmentStatus: "unavailable", actualName: "", evaluation: "", fullySatisfied: false, unavailableReason: "当日售罄" })).toBe("");
    expect(validateDish({ ...ordered, required: false, fulfillmentStatus: "skipped", actualName: "", evaluation: "", fullySatisfied: false })).toBe("");
    expect(validateDish({ ...ordered, requirementId: null, required: false, fulfillmentStatus: "extra" })).toBe("");
  });

  it("requires an empty extra row to be completed or explicitly removed", () => {
    expect(isBlankExtraDish({ fulfillmentStatus: "extra", actualName: " ", evaluation: "", fullySatisfied: false })).toBe(true);
    expect(isBlankExtraDish({ fulfillmentStatus: "extra", actualName: "加点甜品", evaluation: "", fullySatisfied: false })).toBe(false);
  });
});

describe("questionnaire continuation guard", () => {
  const questions = [
    { id: "one", number: 1, evidence: {} },
    { id: "two", number: 2, evidence: { imageRequired: true } },
  ];

  it("finds missing answers, remarks and required evidence", () => {
    const completeQuestions = Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1), number: index + 1, evidence: {} }));
    const completeAnswers = Object.fromEntries(completeQuestions.map((question) => [question.id, { answer: "scored" }]));
    // 题量不设上限后，两道题也是合法题库：直接返回第一道未答题
    expect(firstIncompleteQuestion(questions, {})?.number).toBe(1);
    expect(firstIncompleteQuestion(completeQuestions, { ...completeAnswers, "2": { answer: "unscored", remark: " " } })?.number).toBe(2);
    expect(firstIncompleteQuestion(completeQuestions, { ...completeAnswers, "2": { answer: "unscored", remark: "有问题", attachments: [] } })?.number).toBeUndefined();
    completeQuestions[1].evidence = { imageRequired: true };
    expect(firstIncompleteQuestion(completeQuestions, { ...completeAnswers, "2": { answer: "unscored", remark: "有问题", attachments: [] } })?.number).toBe(2);
    expect(firstIncompleteQuestion(completeQuestions, { ...completeAnswers, "2": { answer: "unscored", remark: "有问题", attachments: [{ type: "image", status: "active" }] } })).toBeUndefined();
    // 题号出现缺口时仍兜底报缺号（防御异常状态）
    expect(firstIncompleteQuestion([{ id: "a", number: 1, evidence: {} }, { id: "b", number: 3, evidence: {} }], {})?.number).toBe(2);
  });

  it("detects numbering gaps beyond 50 questions", () => {
    // 题量不设上限后，缺号兜底必须覆盖 >50 的题号
    const wide = Array.from({ length: 60 }, (_, index) => ({ id: String(index + 1), number: index + 1, evidence: {} })).filter((question) => question.number !== 55);
    expect(firstIncompleteQuestion(wide, {})?.number).toBe(55);
  });
});

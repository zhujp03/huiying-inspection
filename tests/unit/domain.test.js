import { describe, expect, it } from "vitest";
import { accountLanding, applyScoreWipe, createSecureToken, draftCacheKey, evidenceComplete, evidenceConfigValid, locationBusinessMessage, nextSubmitState, passwordResetStep, questionnairePublishCheck, selectQuestionnaireEntry, tokenAfterSubmitResult, validateDish } from "../../packages/domain/index.js";

const assignment = (id, status = "assigned") => ({ id, taskType: "secret", status });

describe("questionnaire entry", () => {
  it("distinguishes zero, one and multiple executable assignments", () => {
    expect(selectQuestionnaireEntry([]).kind).toBe("empty");
    expect(selectQuestionnaireEntry([assignment("a")]).kind).toBe("single");
    expect(selectQuestionnaireEntry([assignment("a"), assignment("b", "in_progress")]).kind).toBe("multiple");
  });
  it("does not expose overdue, submitted or overt assignments as executable", () => {
    expect(selectQuestionnaireEntry([assignment("a", "overdue"), assignment("b", "submitted"), { ...assignment("c"), taskType: "overt" }]).kind).toBe("empty");
  });
});

describe("account states", () => {
  it.each([["pending_approval", "pending"], ["rejected", "rejected"], ["disabled", "disabled"], ["approved_active", "business"]])("projects %s", (status, landing) => expect(accountLanding(status)).toBe(landing));
});

describe("scoped drafts", () => {
  it("isolates two users and two assignments", () => {
    const base = { attemptId: "attempt", questionnaireVersionId: "version" };
    expect(draftCacheKey({ ...base, userId: "user-a", assignmentId: "one" })).not.toBe(draftCacheKey({ ...base, userId: "user-b", assignmentId: "one" }));
    expect(draftCacheKey({ ...base, userId: "user-a", assignmentId: "one" })).not.toBe(draftCacheKey({ ...base, userId: "user-a", assignmentId: "two" }));
    expect(draftCacheKey({ ...base, userId: "user-a", assignmentId: "one", attemptId: "attempt-two" })).not.toBe(draftCacheKey({ ...base, userId: "user-a", assignmentId: "one" }));
    expect(draftCacheKey({ ...base, userId: "user-a", assignmentId: "one", questionnaireVersionId: "version-two" })).not.toBe(draftCacheKey({ ...base, userId: "user-a", assignmentId: "one" }));
  });
});

describe("dish rules", () => {
  const base = { requirementId: "requirement", required: true, allowSubstitution: false, actualName: "招牌菜", fulfillmentStatus: "ordered", evaluation: "", fullySatisfied: true };
  it("prevents required dishes from being skipped", () => expect(validateDish({ ...base, fulfillmentStatus: "skipped" })).toContain("必点菜品不能跳过"));
  it("requires substitution fields and permission", () => expect(validateDish({ ...base, fulfillmentStatus: "substituted", actualName: "", substitutionReason: "" }).length).toBeGreaterThan(1));
  it("requires an unavailable reason and empty actual name", () => expect(validateDish({ ...base, fulfillmentStatus: "unavailable", unavailableReason: "" }).length).toBeGreaterThan(0));
  it("becomes incomplete when satisfaction is toggled off with no evaluation", () => expect(validateDish({ ...base, fullySatisfied: false })).toContain("请填写评价或选择全部满意"));
});

describe("submit state and token", () => {
  it("locks submitted forever and preserves retryable transitions", () => {
    expect(nextSubmitState("draft", "begin")).toBe("submitting");
    expect(nextSubmitState("retryable_failed", "begin")).toBe("submitting");
    expect(nextSubmitState("submitted", "begin")).toBe("submitted");
  });
  it("creates UUID tokens from secure random bytes", () => {
    let seed = 0;
    const token = createSecureToken((bytes) => bytes.forEach((_, index) => { bytes[index] = seed++; }));
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("reuses a token for processing/retryable failures and replaces it after terminal failure", () => {
    expect(tokenAfterSubmitResult("same-token", "processing").token).toBe("same-token");
    expect(tokenAfterSubmitResult("same-token", "retryable_failed").token).toBe("same-token");
    expect(tokenAfterSubmitResult("old-token", "terminal_failed").token).toBeNull();
  });
});

describe("evidence edit sessions", () => {
  it("counts active and staged-ready evidence but excludes uploading, failed and pending removal", () => {
    const base = { remark: "现场有问题", imageRequired: true, audioRequired: true };
    expect(evidenceComplete({ ...base, attachments: [{ type: "image", status: "staged_ready" }, { type: "audio", status: "active" }] }).complete).toBe(true);
    expect(evidenceComplete({ ...base, attachments: [{ type: "image", status: "uploading" }, { type: "audio", status: "active" }] }).reason).toBe("image");
    expect(evidenceComplete({ ...base, attachments: [{ type: "image", status: "active", pendingRemoval: true }, { type: "audio", status: "active" }] }).reason).toBe("image");
  });
  it("enforces parent-child evidence configuration", () => {
    expect(evidenceConfigValid({ evidenceRequired: true, imageRequired: false, audioRequired: false })).toBe(false);
    expect(evidenceConfigValid({ evidenceRequired: true, imageRequired: true, audioRequired: true })).toBe(true);
    expect(evidenceConfigValid({ evidenceRequired: false, imageRequired: true, audioRequired: false })).toBe(false);
  });
});

describe("questionnaire publication", () => {
  const questions = Array.from({ length: 50 }, (_, index) => ({ number: index + 1, category: index < 20 ? "environment" : index < 42 ? "service" : "product", enabled: true, evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false } }));
  it("requires contiguous numbering and categories from the active set", () => {
    expect(questionnairePublishCheck(questions, ["environment", "service", "product"]).valid).toBe(true);
    expect(questionnairePublishCheck(questions.slice(1), ["environment", "service", "product"]).numberingValid).toBe(false);
    expect(questionnairePublishCheck(questions, ["environment", "service", "product"]).categoriesValid).toBe(true);
    // 分类被停用后（active set 里没有 product）→ 分类校验失败
    expect(questionnairePublishCheck(questions, ["environment", "service"]).categoriesValid).toBe(false);
    // 未传启用分类集合时跳过分类校验
    expect(questionnairePublishCheck(questions).categoriesValid).toBe(true);
    // 1 题也可发布（1..N 连续）
    expect(questionnairePublishCheck([{ number: 1, category: "environment", enabled: true, evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false } }], ["environment"]).valid).toBe(true);
    // 题量不设上限：60 题连续编号可发布
    expect(questionnairePublishCheck(Array.from({ length: 60 }, (_, index) => ({ number: index + 1, category: "environment", enabled: true, evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false } })), ["environment"]).valid).toBe(true);
  });
});

describe("score wipe 分数清零题", () => {
  const question = (overrides) => ({ evidence: { evidenceRequired: false, imageRequired: false, audioRequired: false }, ...overrides });
  const wipeQuestion = (id, category) => ({ id, category, maxScore: 2, scoreWipe: true });
  const answer = (questionId, answer, awardedScore) => ({ questionId, answer, awardedScore });

  it("publishCheck rejects two scoreWipe questions in the same enabled category", () => {
    const questions = [question({ number: 1, category: "environment", scoreWipe: true }), question({ number: 2, category: "environment", scoreWipe: true }), question({ number: 3, category: "service" })];
    const result = questionnairePublishCheck(questions, ["environment", "service"]);
    expect(result.scoreWipeValid).toBe(false);
    expect(result.scoreWipeConflicts).toContain("environment");
    expect(result.valid).toBe(false);
  });
  it("publishCheck allows one scoreWipe question per category across different categories", () => {
    const questions = [question({ number: 1, category: "environment", scoreWipe: true }), question({ number: 2, category: "service", scoreWipe: true })];
    const result = questionnairePublishCheck(questions, ["environment", "service"]);
    expect(result.scoreWipeValid).toBe(true);
    expect(result.scoreWipeConflicts).toEqual([]);
    expect(result.valid).toBe(true);
  });
  it("publishCheck ignores disabled scoreWipe questions", () => {
    const questions = [question({ number: 1, category: "environment", scoreWipe: true }), question({ number: 2, category: "environment", scoreWipe: true, enabled: false })];
    const result = questionnairePublishCheck(questions, ["environment"]);
    expect(result.scoreWipeValid).toBe(true);
  });
  it("publishCheck treats a missing scoreWipe field as false", () => {
    const result = questionnairePublishCheck([question({ number: 1, category: "environment" }), question({ number: 2, category: "environment" })], ["environment"]);
    expect(result.scoreWipeValid).toBe(true);
    expect(result.scoreWipeConflicts).toEqual([]);
  });
  it("applyScoreWipe zeroes the whole wiped category and keeps other categories intact", () => {
    const questions = [wipeQuestion("q1", "environment"), { id: "q2", category: "environment", maxScore: 3 }, { id: "q3", category: "service", maxScore: 4 }];
    const answers = [answer("q1", "unscored", 0), answer("q2", "scored", 3), answer("q3", "scored", 4)];
    const result = applyScoreWipe(questions, answers);
    expect(result.wipedCategories).toContain("environment");
    expect(result.totalScore).toBe(4);
  });
  it("applyScoreWipe keeps the plain sum when the wipe question is scored", () => {
    const questions = [wipeQuestion("q1", "environment"), { id: "q2", category: "environment", maxScore: 3 }];
    const answers = [answer("q1", "scored", 2), answer("q2", "scored", 3)];
    expect(applyScoreWipe(questions, answers).totalScore).toBe(5);
  });
  it("applyScoreWipe does not trigger when the wipe question is unanswered", () => {
    const questions = [wipeQuestion("q1", "environment"), { id: "q2", category: "environment", maxScore: 3 }];
    const answers = [answer("q2", "scored", 3)];
    const result = applyScoreWipe(questions, answers);
    expect(result.wipedCategories).toEqual([]);
    expect(result.totalScore).toBe(3);
  });
  it("awardedFor returns zero inside wiped categories and the awarded score elsewhere", () => {
    const questions = [wipeQuestion("q1", "environment"), { id: "q2", category: "environment", maxScore: 3 }, { id: "q3", category: "service", maxScore: 4 }];
    const answers = [answer("q1", "unscored", 0), answer("q2", "scored", 3), answer("q3", "scored", 4)];
    const result = applyScoreWipe(questions, answers);
    expect(result.awardedFor(questions[0])).toBe(0);
    expect(result.awardedFor(questions[1])).toBe(0);
    expect(result.awardedFor(questions[2])).toBe(4);
  });
  it("applyScoreWipe equals a plain sum when no wipe question exists", () => {
    const questions = [{ id: "q1", category: "environment", maxScore: 2 }, { id: "q2", category: "service", maxScore: 4 }];
    const answers = [answer("q1", "scored", 2), answer("q2", "scored", 4)];
    expect(applyScoreWipe(questions, answers).totalScore).toBe(6);
  });
});

describe("password and location projections", () => {
  it("requires a new captcha after server invalidates the third failed code", () => expect(passwordResetStep({ step: "code" }, { type: "code_invalidated" })).toEqual({ step: "captcha", invalidated: true }));
  it.each([["outside_radius", "当前距离门店较远，请到店后重试"], ["stale", "定位结果已过期，请重新定位"], ["low_accuracy", "定位精度不足，请移动到较开阔位置后重试"], ["accepted", "现场位置已通过"]])("maps %s", (result, message) => expect(locationBusinessMessage(result)).toBe(message));
});

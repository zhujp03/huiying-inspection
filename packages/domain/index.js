import { ASSIGNMENT_STATUS, USER_STATUS } from "../contracts/index.js";

export function draftCacheKey({ userId, assignmentId, attemptId, questionnaireVersionId }) {
  if (![userId, assignmentId, attemptId, questionnaireVersionId].every(Boolean)) throw new Error("Scoped draft identity is incomplete");
  return `junde:survey:${encodeURIComponent(userId)}:${encodeURIComponent(assignmentId)}:${encodeURIComponent(attemptId)}:${encodeURIComponent(questionnaireVersionId)}`;
}

export function selectQuestionnaireEntry(assignments) {
  const executable = assignments.filter((item) => item.taskType === "secret" && [ASSIGNMENT_STATUS.ASSIGNED, ASSIGNMENT_STATUS.IN_PROGRESS].includes(item.status));
  if (executable.length === 0) return { kind: "empty", assignments: [] };
  if (executable.length === 1) return { kind: "single", assignment: executable[0] };
  return { kind: "multiple", assignments: executable };
}

export function accountLanding(status) {
  if (status === USER_STATUS.APPROVED) return "business";
  if (status === USER_STATUS.PENDING) return "pending";
  if (status === USER_STATUS.REJECTED) return "rejected";
  if (status === USER_STATUS.DISABLED) return "disabled";
  return "login";
}

export function validateDish(dish) {
  const errors = [];
  const status = dish.fulfillmentStatus;
  if (dish.required && status === "skipped") errors.push("必点菜品不能跳过");
  if (status === "substituted") {
    if (!dish.allowSubstitution) errors.push("该菜品不允许替代");
    if (!dish.actualName?.trim()) errors.push("请填写实际菜名");
    if (!dish.substitutionReason?.trim()) errors.push("请填写替代原因");
  }
  if (status === "unavailable") {
    if (dish.actualName?.trim()) errors.push("售罄菜品不填写实际菜名");
    if (!dish.unavailableReason?.trim()) errors.push("请填写售罄原因");
  }
  if (status === "skipped" && dish.required) errors.push("必点菜品不能标记为未点");
  if (status === "extra" && dish.requirementId) errors.push("额外菜品不能关联任务菜品要求");
  if (["ordered", "substituted", "extra"].includes(status)) {
    if (!dish.actualName?.trim()) errors.push("请填写实际菜名");
    if (!dish.fullySatisfied && !dish.evaluation?.trim()) errors.push("请填写评价或选择全部满意");
  }
  return errors;
}

export function validateDishes(dishes) {
  return dishes.flatMap((dish, index) => validateDish(dish).map((message) => ({ index, message })));
}

export function nextSubmitState(current, event) {
  if (current === "submitted") return "submitted";
  if (event === "begin") return current === "draft" || current === "retryable_failed" ? "submitting" : current;
  if (event === "processing") return "processing";
  if (event === "succeeded") return "submitted";
  if (event === "retryable_failed") return "retryable_failed";
  if (event === "terminal_failed") return "terminal_failed";
  return current;
}

export function createSecureToken(randomValues) {
  const bytes = new Uint8Array(16);
  randomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function evidenceComplete({ remark, imageRequired, audioRequired, attachments }) {
  if (!remark?.trim()) return { complete: false, reason: "remark" };
  const usable = attachments.filter((item) => ["active", "staged_ready"].includes(item.status) && !item.pendingRemoval);
  if (imageRequired && !usable.some((item) => item.type === "image")) return { complete: false, reason: "image" };
  if (audioRequired && !usable.some((item) => item.type === "audio")) return { complete: false, reason: "audio" };
  return { complete: true, reason: null };
}

export function evidenceConfigValid({ evidenceRequired, imageRequired, audioRequired }) {
  if (!evidenceRequired) return !imageRequired && !audioRequired;
  return imageRequired || audioRequired;
}

export function questionnairePublishCheck(questions, categoryCodes) {
  // 分类动态化：categoryCodes（启用分类的 code 数组）由调用方传入；未传时跳过分类校验。
  const enabled = questions.filter((question) => question.enabled !== false);
  const numbers = enabled.map((question) => question.number);
  const numberingValid = numbers.length >= 1 && new Set(numbers).size === numbers.length && numbers.every((number, index) => number === index + 1);
  const categoriesValid = !categoryCodes || enabled.every((question) => categoryCodes.includes(question.category));
  const evidenceValid = enabled.every((question) => evidenceConfigValid(question.evidence));
  // 分数清零题：同一启用分类至多一道 scoreWipe 题（未传字段视为 false）；停用题不参与冲突检测。
  const seenWipeCategories = new Set();
  const scoreWipeConflicts = [];
  for (const question of enabled) {
    if (!question.scoreWipe) continue;
    if (seenWipeCategories.has(question.category)) {
      if (!scoreWipeConflicts.includes(question.category)) scoreWipeConflicts.push(question.category);
    } else {
      seenWipeCategories.add(question.category);
    }
  }
  const scoreWipeValid = scoreWipeConflicts.length === 0;
  return { valid: numberingValid && categoriesValid && evidenceValid && scoreWipeValid, numberingValid, categoriesValid, evidenceValid, scoreWipeValid, scoreWipeConflicts };
}

export function applyScoreWipe(questions, answers) {
  // 分数清零计分口径：某分类存在 scoreWipe 题且该题作答 unscored 时，该分类（启用题）全部按 0 分计。
  // wipedCategories：被清零的分类 code 集合；awardedFor(question)：wiped 分类中的题返回 0，否则取其作答 awardedScore（未作答回 0）。
  // totalScore：对全部 answers 求和，但 answer 对应启用题且其分类被清零时贡献记 0；
  // answer 对应题不在启用题集合（如停用题残留作答）时照常计入 awardedScore，与现状口径一致。
  const wipedCategories = new Set(questions.filter((question) => question.scoreWipe && answers.some((answer) => answer.questionId === question.id && answer.answer === "unscored")).map((question) => question.category));
  const awardedFor = (question) => {
    if (wipedCategories.has(question.category)) return 0;
    return answers.find((answer) => answer.questionId === question.id)?.awardedScore ?? 0;
  };
  const totalScore = answers.reduce((sum, answer) => {
    const question = questions.find((item) => item.id === answer.questionId);
    if (question && wipedCategories.has(question.category)) return sum;
    return sum + answer.awardedScore;
  }, 0);
  return { wipedCategories: [...wipedCategories], awardedFor, totalScore };
}

export function passwordResetStep(state, event) {
  if (event.type === "code_sent") return { step: "code", invalidated: false };
  if (event.type === "code_invalidated") return { step: "captcha", invalidated: true };
  if (event.type === "code_verified") return { step: "password", invalidated: false };
  if (event.type === "completed") return { step: "login", invalidated: false };
  return state;
}

export function locationBusinessMessage(result) {
  return ({
    accepted: "现场位置已通过",
    outside_radius: "当前距离门店较远，请到店后重试",
    stale: "定位结果已过期，请重新定位",
    low_accuracy: "定位精度不足，请移动到较开阔位置后重试",
    rejected: "当前位置未通过，请重新定位",
  })[result] || "暂时无法确认位置，请稍后重试";
}

export function tokenAfterSubmitResult(token, result) {
  if (result === "succeeded") return { token, locked: true };
  if (result === "retryable_failed" || result === "processing") return { token, locked: false };
  if (result === "terminal_failed") return { token: null, locked: false };
  return { token, locked: false };
}

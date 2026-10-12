// utils/business.js（module-contracts §5.2；小程序 utils/business.js:1-53 同名同语义）
//
// 语义：
// - secureUuid()：安全随机 UUIDv4（crypto.getRandomValues）；无安全随机源 →
//   throw new Error("SECURE_RANDOM_UNAVAILABLE")（R59/R79 的 id/token 生成器）。
// - validateDish(dish)：菜品状态机校验（R54 九条分支按序短路），返回错误文案或 ""。
// - firstIncompleteQuestion(questions, answers)：缺号兜底 + 逐题检查（R40）。
// - isBlankExtraDish(dish)：空白额外菜判定（R74 返回拦截依据）。

export function secureUuid() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else throw new Error("SECURE_RANDOM_UNAVAILABLE");
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateDish(dish) {
  const status = dish.fulfillmentStatus;
  if (dish.required && status === "skipped") return "必点菜品不能选择未点";
  if (status === "ordered" && (dish.substitutionReason?.trim() || dish.unavailableReason?.trim())) return "已点菜品不能保留替代或售罄原因";
  if (status === "substituted" && !dish.allowSubstitution) return "该菜品不允许替代";
  if (status === "substituted" && (!dish.actualName?.trim() || !dish.substitutionReason?.trim())) return "请填写替代菜名和替代原因";
  if (status === "unavailable" && (dish.actualName?.trim() || dish.evaluation?.trim() || dish.fullySatisfied || !dish.unavailableReason?.trim())) return "售罄时请清空实际菜名和评价，并填写售罄原因";
  if (status === "skipped" && (dish.actualName?.trim() || dish.evaluation?.trim() || dish.fullySatisfied)) return "未点菜品不填写实际菜名和评价";
  if (status === "extra" && dish.requirementId) return "额外菜品状态不正确";
  if (["ordered", "substituted", "extra"].includes(status) && !dish.actualName?.trim()) return "请填写实际菜名";
  if (["ordered", "substituted", "extra"].includes(status) && !dish.fullySatisfied && !dish.evaluation?.trim()) return "请填写评价或选择全部满意";
  return "";
}

export function firstIncompleteQuestion(questions, answers) {
  const numbers = new Set(questions.map((question) => question.number));
  // 缺号兜底：题量不设上限，遍历范围按实际题目的最大题号推导
  const maxNumber = questions.reduce((max, question) => Math.max(max, question.number), 0);
  for (let number = 1; number <= maxNumber; number += 1) {
    // 缺号兜底：分类动态化后不再按题号猜分类，落在第一道题的分类上
    if (!numbers.has(number)) return { number, category: questions[0]?.category || "environment" };
  }
  return questions.find((question) => {
    const answer = answers?.[question.id];
    if (!answer || !["scored", "unscored"].includes(answer.answer)) return true;
    if (answer.answer !== "unscored") return false;
    if (!answer.remark?.trim()) return true;
    const attachments = (answer.attachments || []).filter((item) => item.status === "active" && !item.pendingRemoval);
    if (question.evidence?.imageRequired && !attachments.some((item) => item.type === "image")) return true;
    if (question.evidence?.audioRequired && !attachments.some((item) => item.type === "audio")) return true;
    return false;
  });
}

export function isBlankExtraDish(dish) {
  return dish.fulfillmentStatus === "extra"
    && !dish.actualName?.trim()
    && !dish.evaluation?.trim()
    && !dish.substitutionReason?.trim()
    && !dish.unavailableReason?.trim()
    && !dish.fullySatisfied;
}

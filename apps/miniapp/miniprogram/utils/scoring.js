// 提交前预览计分（与服务端提交落库 packages/domain applyScoreWipe 严格同口径，单元测试以
// domain.applyScoreWipe 为权威逐例对账）：
// - 分母 = 当前启用题满分之和；启用题必须有作答（缺失 → null，调用方呈现「暂时无法计算」）；
// - 清零题作答 unscored 时其分类内全部启用题计 0 分；
// - 分子使用服务端持久化的 awardedScore（草稿 DTO answers[].awardedScore），不从 max 推导；
// - 停用题残留作答（orphan）照常计入分子（与 domain.applyScoreWipe/提交端点一致）；
// - 满分为 0：服务端提交行约束 max_score>0 使其不可提交，预览按 null 处理（绝不显示 Infinity/100%）。
export function computeSurveyScore(questions, answers) {
  const enabled = (questions || []).filter((question) => question && question.id);
  if (!enabled.length) return null;
  const answerMap = {};
  for (const [questionId, answer] of Object.entries(answers || {})) {
    if (answer && (answer.answer === "scored" || answer.answer === "unscored")) answerMap[questionId] = answer;
  }
  let maxScore = 0;
  for (const question of enabled) {
    const max = Number(question.score == null ? 0 : question.score);
    if (!Number.isFinite(max) || max < 0) return null;
    maxScore += max;
    if (!answerMap[question.id]) return null;
  }
  if (maxScore <= 0) return null;
  const awardedOf = (answer) => {
    const value = Number(answer.awardedScore);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  const enabledIds = new Set(enabled.map((question) => question.id));
  const wipedCategories = new Set(
    enabled.filter((question) => question.isScoreWipe && answerMap[question.id].answer === "unscored").map((question) => question.category),
  );
  let totalScore = 0;
  for (const question of enabled) {
    if (wipedCategories.has(question.category)) continue;
    totalScore += awardedOf(answerMap[question.id]);
  }
  for (const [questionId, answer] of Object.entries(answerMap)) {
    if (enabledIds.has(questionId)) continue;
    totalScore += awardedOf(answer);
  }
  return { totalScore, maxScore, percent: Math.round((totalScore / maxScore) * 100) };
}

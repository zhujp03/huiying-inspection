// store/survey-view.js — 问卷页视图态（非草稿）：当前选中分类的会话级记忆。
//
// 用途：分类选择原本只存在于 SurveyPage 组件 state，Issue 往返 / 浏览器后退 /
// 刷新导致的重挂载都会丢失。这里按 attemptId 隔离记住「用户当前选中的分类」，
// 返回问卷时校验后还原（服务端分类列表到达后仍需落在有效分类上，R33）。
//
// 边界：刻意不进入草稿存储（store/survey.js 的键与内容均不受影响，草稿身份
// 仍是 userId+assignment+attempt+版本），不改 API 契约；sessionStorage 与
// 浏览器历史的生命周期一致，换 tab/新会话自然复位。

const CATEGORY_KEY_PREFIX = "junde:survey-category:";

export function rememberSurveyCategory(attemptId, categoryId) {
  if (!attemptId || !categoryId) return;
  try {
    sessionStorage.setItem(CATEGORY_KEY_PREFIX + String(attemptId), String(categoryId));
  } catch { /* 存储不可用：仅退化为不记忆，不影响作答 */ }
}

export function recallSurveyCategory(attemptId) {
  if (!attemptId) return "";
  try {
    return String(sessionStorage.getItem(CATEGORY_KEY_PREFIX + String(attemptId)) || "");
  } catch {
    return "";
  }
}

// —— 返回锚点（问题页往返的滚动/展开恢复）——
//
// 离开问卷进入问题页（openIssue）前捕获：锚点题 id + 题卡视口偏移 + 当前分类 + 已展开题
// 集合。问卷重挂载（保存确认/取消返回与浏览器后退共用同一条重挂载链）后按「光标后的
// forward 条目确为同任务问题页」消费一次：展开态随首帧恢复，列表就绪后按题卡元素相对
// 定位回滚（对上方高度变化稳健，不直录直放 scrollY）。键按 attempt+问卷版本隔离；读后
// 即清，重载/再进入不重放；坏值/存储不可用一律安全降级为不恢复。sessionStorage 生命
// 周期与分类记忆一致（换 tab/新会话自然复位）。
const RETURN_KEY_PREFIX = "junde:survey-return:";

const returnKey = (attemptId, questionnaireVersionId) =>
  `${RETURN_KEY_PREFIX}${String(attemptId)}:${String(questionnaireVersionId)}`;

export function rememberSurveyReturnAnchor(attemptId, questionnaireVersionId, anchor) {
  if (!attemptId || !questionnaireVersionId) return;
  if (!anchor || typeof anchor.questionId !== "string" || !anchor.questionId) return;
  try {
    sessionStorage.setItem(returnKey(attemptId, questionnaireVersionId), JSON.stringify(anchor));
  } catch { /* 存储不可用：仅退化为不恢复，不影响作答 */ }
}

// 读侧逐字段校验（写入方虽是仓库内唯一调用点，仍防御会话里残留的旧版/坏值）。
export function recallSurveyReturnAnchor(attemptId, questionnaireVersionId) {
  if (!attemptId || !questionnaireVersionId) return null;
  try {
    const raw = sessionStorage.getItem(returnKey(attemptId, questionnaireVersionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (typeof parsed.questionId !== "string" || !parsed.questionId) return null;
    if (typeof parsed.offsetTop !== "number" || !Number.isFinite(parsed.offsetTop)) return null;
    if (typeof parsed.category !== "string") return null;
    if (!Array.isArray(parsed.expandedIds) || parsed.expandedIds.some((id) => typeof id !== "string" || !id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function forgetSurveyReturnAnchor(attemptId, questionnaireVersionId) {
  if (!attemptId || !questionnaireVersionId) return;
  try {
    sessionStorage.removeItem(returnKey(attemptId, questionnaireVersionId));
  } catch { /* 存储不可用：无键可清即无副作用 */ }
}

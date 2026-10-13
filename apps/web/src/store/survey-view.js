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

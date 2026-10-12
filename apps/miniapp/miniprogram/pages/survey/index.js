import { getQuestionnaire, saveAnswer } from "../../services/api.js";
import { markDraftSynced, peekDraft, saveDraft as saveLocalDraft } from "../../store/survey.js";
import { mergeSurveyAnswers } from "../../store/survey-merge.js";
import { firstIncompleteQuestion } from "../../utils/business.js";

// 分类由服务端动态下发（管理员可扩展）；此处仅作接口异常时的兜底展示。
const FALLBACK_CATEGORIES = [
  { id: "environment", label: "环境卫生" }, { id: "service", label: "为客服务" }, { id: "product", label: "产品品质" },
];

Page({
  data: { categories: FALLBACK_CATEGORIES, category: FALLBACK_CATEGORIES[0].id, isLastCategory: false, meta: null, questions: [], visible: [], answers: {}, expanded: {}, answeredCount: 0, loading: true, error: "", syncMessage: "" },
  async onLoad(options) {
    if (!options.assignmentId || !options.attemptId || !options.questionnaireVersionId) { this.setData({ loading: false, error: "未找到问卷，请从任务详情重新进入" }); return; }
    this.routeMeta = { assignmentId: options.assignmentId, attemptId: options.attemptId, questionnaireVersionId: options.questionnaireVersionId, revision: Number(options.revision || 0) };
    // 路由指定的分类要等服务端分类列表返回后再校验（分类可由管理员扩展）
    this.pendingCategory = options.category || "";
    await this.load();
  },
  async onShow() { if (this.routeMeta && !this.data.loading) await this.load(); },
  // 用服务端分类列表替换兜底：路由指定的分类有效则优先，否则落在当前有效分类或第一个分类上。
  applyCategories(result) {
    const categories = Array.isArray(result.categories) && result.categories.length ? result.categories : FALLBACK_CATEGORIES;
    let category = this.data.category;
    if (this.pendingCategory && categories.some((item) => item.id === this.pendingCategory)) category = this.pendingCategory;
    if (!categories.some((item) => item.id === category)) category = categories[0].id;
    this.pendingCategory = "";
    return { categories, category };
  },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const result = await getQuestionnaire(this.routeMeta.assignmentId);
      if (result.attempt.status === "submitted") { wx.showToast({ title: "该任务已提交，不能回看问卷内容", icon: "none" }); wx.redirectTo({ url: `/pages/task/index?assignmentId=${encodeURIComponent(this.routeMeta.assignmentId)}` }); return; }
      if (result.attempt.id !== this.routeMeta.attemptId || result.questionnaireVersion.id !== this.routeMeta.questionnaireVersionId) throw new Error("问卷信息已更新，请从任务详情重新进入");
      const meta = { ...this.routeMeta, revision: result.attempt.revision };
      const serverAnswers = result.answers || {};
      const rawLocal = peekDraft(meta);
      const merged = mergeSurveyAnswers({ serverAnswers, serverRevision: meta.revision, rawLocal });
      const answers = merged.answers;
      const conflict = merged.conflict;
      this.routeMeta = meta;
      const dishes = result.dishes || [];
      const highlight = result.otherRecords?.highlight || "";
      const suggestion = result.otherRecords?.suggestion || "";
      const categoryState = this.applyCategories(result);
      if (conflict) {
        // 冲突时不覆盖本地待同步草稿；保留本地值供用户重试，只更新页面视图。
        this.setData({ meta, questions: result.questions, answers, ...categoryState, conflict: true, loading: false, syncMessage: "内容已更新，请刷新后重试" });
        this.project();
        return;
      }
      saveLocalDraft(meta, { answers, dishes, highlight, suggestion });
      markDraftSynced(meta, meta.revision);
      this.setData({ meta, questions: result.questions, answers, ...categoryState, conflict: false, loading: false, syncMessage: "" });
      this.project();
      // 逐项补发：同 revision 合并后仍有本地未同步的得分答案时，按顺序重新保存到服务端。
      if (merged.pendingResync.length > 0) {
        for (const questionId of merged.pendingResync) {
          try {
            const saved = await saveAnswer(meta.attemptId, questionId, { answer: "scored", revision: this.routeMeta.revision });
            this.routeMeta = { ...this.routeMeta, revision: saved.revision };
            markDraftSynced(this.routeMeta, saved.revision);
            this.setData({ meta: this.routeMeta, syncMessage: "正在恢复未保存的答案…" });
          } catch { /* 单题补发失败保留本地草稿，下次进入再补发 */ }
        }
        this.setData({ syncMessage: "" });
      }
    } catch (error) { this.setData({ loading: false, error: error.message }); }
  },
  retry() { this.setData({ conflict: false }); this.load(); },
  project() {
    const visible = this.data.questions.filter((item) => item.category === this.data.category).map((item) => ({ ...item, isScoreWipe: Boolean(item.isScoreWipe), current: this.data.answers[item.id] || null, expanded: Boolean(this.data.expanded[item.id]) }));
    const lastCategory = this.data.categories[this.data.categories.length - 1];
    // 只统计当前题目集合内的答案：题目被管理员停用/删除后，遗留答案不再虚增完成数
    const questionIds = new Set(this.data.questions.map((item) => item.id));
    this.setData({ visible, answeredCount: Object.keys(this.data.answers).filter((id) => questionIds.has(id)).length, isLastCategory: Boolean(lastCategory) && this.data.category === lastCategory.id });
  },
  selectCategory(event) { this.setData({ category: event.currentTarget.dataset.id }); this.project(); },
  toggleExpand(event) { const id = event.currentTarget.dataset.id; this.setData({ expanded: { ...this.data.expanded, [id]: !this.data.expanded[id] } }); this.project(); },
  async score(event) {
    const id = event.currentTarget.dataset.id;
    const current = this.data.answers[id];
    if (current?.answer === "unscored") { this.openIssue(id, "scored"); return; }
    const previous = current;
    const answers = { ...this.data.answers, [id]: { answer: "scored", remark: "", attachments: [] } };
    this.setData({ answers, syncMessage: "正在保存…" }); saveLocalDraft(this.routeMeta, { answers }); this.project();
    try {
      const result = await saveAnswer(this.routeMeta.attemptId, id, { answer: "scored", revision: this.routeMeta.revision });
      this.routeMeta = { ...this.routeMeta, revision: result.revision }; markDraftSynced(this.routeMeta, result.revision); this.setData({ meta: this.routeMeta, syncMessage: "已保存" });
    } catch (error) { const reverted = { ...answers }; previous ? reverted[id] = previous : delete reverted[id]; this.setData({ answers: reverted, syncMessage: "保存失败，请重试" }); this.project(); wx.showToast({ title: error.message, icon: "none" }); }
  },
  issue(event) {
    const id = event.currentTarget.dataset.id;
    const question = this.data.questions.find((item) => item.id === id);
    if (!question?.isScoreWipe) { this.openIssue(id, "unscored"); return; }
    wx.showModal({ title: "分数清零确认", content: "确认存在该严重问题？确认后本类目全部题目不得分。", confirmText: "确认", success: (result) => { if (result.confirm) this.openIssue(id, "unscored"); } });
  },
  openIssue(questionId, target) { const meta = this.routeMeta; wx.navigateTo({ url: `/pages/issue/index?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}&questionId=${encodeURIComponent(questionId)}&target=${target}` }); },
  dishes() {
    const missing = firstIncompleteQuestion(this.data.questions, this.data.answers);
    if (missing) { this.setData({ category: missing.category }); this.project(); wx.showToast({ title: `请先完成第 ${missing.number} 题`, icon: "none" }); return; }
    const meta = this.routeMeta;
    wx.navigateTo({ url: `/pages/dishes/index?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}` });
  },
});

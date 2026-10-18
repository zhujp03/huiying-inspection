import { getAssignment, getDraft, saveOtherRecords, submitQuestionnaire } from "../../services/api.js";
import { clearDraft, getDraft as getLocalDraft, markDraftSynced, saveDraft as saveLocalDraft } from "../../store/survey.js";
import { backToParentOrRedirect, sanitizeSource } from "../../utils/navigation.js";
import { computeSurveyScore } from "../../utils/scoring.js";
import { secureUuid } from "../../utils/business.js";

// 2026-10 变更：闪光点编辑移至第二步（dishes 其他照片页），本页只保留「其他建议」与提交；
// 提交前的不可逆确认改为自定义 WXML 弹窗（不再 wx.showModal），展示当前问卷得分百分比
// 与「问卷提交后无法再次修改」警示；取消关闭弹窗并保留全部编辑，可继续修改后再提交。
Page({
  data: {
    meta: null,
    suggestion: "",
    submitState: "draft",
    message: "",
    submittedAt: "",
    loading: true,
    saving: false,
    focusField: "",
    keyboardOpen: false,
    confirmOpen: false,
    // 提交确认弹窗的得分预览：null=无法计算（绝不虚构 100%）。
    confirmScore: null,
    statusBarHeight: 20,
    navBarHeight: 44,
  },

  async onLoad(options) {
    this.setData(navigationMetrics());
    if (!options.assignmentId || !options.attemptId || !options.questionnaireVersionId) {
      this.setData({ loading: false, message: "未找到当前问卷，请从任务详情重新进入" });
      return;
    }
    this.routeMeta = {
      assignmentId: options.assignmentId,
      attemptId: options.attemptId,
      questionnaireVersionId: options.questionnaireVersionId,
      revision: Number(options.revision || 0),
    };
    // 任务链来源（其他照片页写入）：只读回跳任务详情时原样带回。
    this.source = sanitizeSource(options.source);
    await this.load();
  },

  async load() {
    this.setData({ loading: true, message: "" });
    try {
      const assignment = await getAssignment(this.routeMeta.assignmentId);
      if (assignment.status === "submitted") {
        wx.showToast({ title: "该任务已提交", icon: "none" });
        wx.redirectTo({ url: `/pages/task/index?assignmentId=${encodeURIComponent(this.routeMeta.assignmentId)}&source=${this.source || ""}` });
        return;
      }
      const result = await getDraft(this.routeMeta.attemptId);
      if (result.attempt.id !== this.routeMeta.attemptId || result.questionnaireVersion.id !== this.routeMeta.questionnaireVersionId) {
        throw new Error("问卷信息已更新，请从任务详情重新进入");
      }
      if (["submitting", "processing", "submitted"].includes(result.attempt.status)) {
        wx.showToast({ title: result.attempt.status === "submitted" ? "该任务已提交" : "问卷正在提交", icon: "none" });
        wx.redirectTo({ url: `/pages/task/index?assignmentId=${encodeURIComponent(this.routeMeta.assignmentId)}&source=${this.source || ""}` });
        return;
      }
      const meta = { ...this.routeMeta, revision: result.attempt.revision };
      const local = getLocalDraft(meta);
      const useLocal = local.synced === false;
      const records = useLocal ? local : (result.otherRecords || {});
      if (!useLocal) {
        saveLocalDraft(meta, { suggestion: records.suggestion || "" });
        markDraftSynced(meta, meta.revision);
      }
      this.routeMeta = meta;
      this.assignmentRevision = assignment.revision ?? result.assignment?.revision ?? meta.revision;
      this.dirty = useLocal;
      this.setData({
        meta,
        suggestion: records.suggestion || "",
        submitState: "draft",
        message: result.attempt.status === "failed" ? "上次提交未完成，请检查内容后重新提交" : "",
        submittedAt: result.attempt.submittedAt || "",
        loading: false,
      });
    } catch (error) {
      this.setData({ message: error.message, loading: false });
    }
  },

  retryLoad() { this.load(); },

  input(event) {
    const field = event.currentTarget.dataset.field;
    if (["retryable_failed", "terminal_failed"].includes(this.data.submitState)) this.submitToken = null;
    this.dirty = true;
    this.setData({ [field]: event.detail.value, submitState: "draft", message: "" });
    this.persistLocal();
  },

  keyboard(event) { this.setData({ keyboardOpen: Number(event.detail.height || 0) > 0 }); },

  // 弹窗内容区阻止冒泡（catchtap 目标），点遮罩才触发取消。
  noop() {},

  // 返回其他照片：仅当紧邻父页确为同任务其他照片页才原生返回；直达进入/无关栈不算证据，
  // 此时 redirectTo 携全量参数的规范页，绝不落到无关任务或退出小程序。
  async back() {
    if (this.locked()) return;
    const saved = await this.saveRecords();
    if (!saved) return;
    backToParentOrRedirect({
      parentRoute: "pages/dishes/index",
      meta: { assignmentId: this.routeMeta.assignmentId, attemptId: this.routeMeta.attemptId },
      fallbackUrl: `${routeUrl("/pages/dishes/index", this.routeMeta)}&source=${this.source || ""}`,
    });
  },

  // 提交入口：可重试失败带 token 直接重放；否则保存后先弹应用内确认弹窗（含得分预览）。
  async confirm() {
    if (this.locked()) return;
    if (this.data.submitState === "retryable_failed" && this.submitToken) {
      await this.retrySubmit();
      return;
    }
    await this.openConfirmModal();
  },

  // 弹窗得分预览：保存同步后重新拉取当前问卷（启用题+作答，含停用题残留），用与服务端
  // 提交落库一致的计分口径（domain.applyScoreWipe：持久化 awardedScore + 清零 + orphan）
  // 计算百分比；拉取失败/0 满分/作答缺失 → confirmScore=null，弹窗禁用确认并给出
  // 「重新获取得分」可恢复入口（绝不虚构 100%）。取消后编辑全部保留。
  async fetchConfirmScore() {
    try {
      const result = await getDraft(this.routeMeta.attemptId);
      if (result.attempt.id !== this.routeMeta.attemptId) return;
      const score = computeSurveyScore(result.questions, result.answers || {});
      this.setData({ confirmScore: score || null });
    } catch { /* 拉取失败保持「无法计算」占位 */ }
  },

  async openConfirmModal() {
    const saved = await this.saveRecords();
    if (!saved) return;
    this.confirmGuard = false; // 同步 guard：防 setData 批量提交前的重复确认点击
    this.setData({ confirmOpen: true, confirmScore: null });
    await this.fetchConfirmScore();
  },

  confirmModalRetryScore() {
    if (this.locked() || !this.data.confirmOpen) return;
    this.fetchConfirmScore();
  },

  confirmModalCancel() {
    if (this.locked()) return;
    // 取消/关闭弹窗：编辑全部保留（数据仍在 data 与本地草稿），可继续修改后再提交。
    this.confirmGuard = false;
    this.setData({ confirmOpen: false, confirmScore: null });
  },

  confirmModalSubmit() {
    if (this.locked() || this.confirmGuard || !this.data.confirmScore) return;
    this.confirmGuard = true;
    this.setData({ confirmOpen: false });
    this.submit();
  },

  async saveRecords() {
    if (this.data.saving) return null;
    const suggestion = this.data.suggestion.trim();
    this.setData({ saving: true, message: "" });
    saveLocalDraft(this.routeMeta, { suggestion });
    try {
      // 只写建议：闪光点由第二步编辑与持久化，此处不带 highlights/suggestion 以外的键，
      // 服务端按「键缺省不改动」语义保留第二步已保存的闪光点。
      const saved = await saveOtherRecords(this.routeMeta.attemptId, { suggestion, revision: this.routeMeta.revision });
      const meta = { ...this.routeMeta, revision: saved.revision };
      markDraftSynced(meta, saved.revision);
      this.routeMeta = meta;
      this.assignmentRevision = saved.assignmentRevision ?? this.assignmentRevision ?? saved.revision;
      this.dirty = false;
      this.setData({ meta, suggestion });
      return saved;
    } catch (error) {
      this.setData({ message: `${error.message}，请重试` });
      wx.showToast({ title: error.message, icon: "none", duration: 3000 });
      return null;
    } finally {
      this.setData({ saving: false });
    }
  },

  async submit() {
    if (this.locked()) return;
    if (!this.submitToken) {
      try { this.submitToken = secureUuid(); }
      catch { this.setData({ message: "当前环境不支持安全提交，请升级微信后重试" }); return; }
    }
    this.setData({ submitState: "submitting", message: "正在安全提交，请勿关闭页面" });
    try {
      const result = await submitQuestionnaire(this.routeMeta.attemptId, {
        submitToken: this.submitToken,
        assignmentRevision: this.assignmentRevision ?? this.routeMeta.revision,
        confirmation: true,
      });
      if (result.status === "processing") {
        this.setData({ submitState: "processing", message: "问卷正在处理，请稍候" });
        this.poll();
        return;
      }
      this.complete(result);
    } catch (error) {
      if (error.retryable) {
        this.setData({ submitState: "retryable_failed", message: `${error.message}，可以重试提交` });
      } else {
        this.submitToken = null;
        this.setData({ submitState: "terminal_failed", message: error.message });
      }
    }
  },

  async retrySubmit() {
    if (this.data.submitState === "retryable_failed" || this.data.submitState === "processing") await this.submitWithExistingToken();
  },

  async submitWithExistingToken() {
    if (!this.submitToken) { this.setData({ submitState: "draft" }); return; }
    this.setData({ submitState: "submitting", message: "正在确认提交结果…" });
    try {
      const result = await submitQuestionnaire(this.routeMeta.attemptId, {
        submitToken: this.submitToken,
        assignmentRevision: this.assignmentRevision ?? this.routeMeta.revision,
        confirmation: true,
      });
      if (result.status === "processing") {
        this.setData({ submitState: "processing", message: "问卷正在处理，请稍候" });
        this.poll();
      } else this.complete(result);
    } catch (error) {
      if (error.retryable) this.setData({ submitState: "retryable_failed", message: `${error.message}，可以重试提交` });
      else { this.submitToken = null; this.setData({ submitState: "terminal_failed", message: error.message }); }
    }
  },

  poll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.submitWithExistingToken(), 2500);
  },

  complete(result) {
    clearTimeout(this.pollTimer);
    clearDraft(this.routeMeta);
    this.dirty = false;
    this.setData({ submitState: "submitted", submittedAt: result.submittedAt || "", message: "提交成功", confirmOpen: false });
  },

  locked() { return ["submitting", "processing", "submitted"].includes(this.data.submitState); },

  persistLocal() {
    if (!this.routeMeta) return;
    try { saveLocalDraft(this.routeMeta, { suggestion: this.data.suggestion }); } catch { /* Session errors are handled by the next API request. */ }
  },

  onUnload() {
    clearTimeout(this.pollTimer);
    if (this.dirty && this.data.submitState !== "submitted") this.persistLocal();
  },

  done() { wx.switchTab({ url: "/pages/schedule/index" }); },
});

function routeUrl(path, meta) {
  return `${path}?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}`;
}

function navigationMetrics() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const menu = wx.getMenuButtonBoundingClientRect?.();
    const statusBarHeight = info.statusBarHeight || 20;
    const navBarHeight = menu ? Math.max(44, (menu.top - statusBarHeight) * 2 + menu.height) : 44;
    return { statusBarHeight, navBarHeight };
  } catch { return { statusBarHeight: 20, navBarHeight: 44 }; }
}

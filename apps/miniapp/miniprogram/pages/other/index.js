import { getAssignment, getDraft, saveOtherRecords, submitQuestionnaire } from "../../services/api.js";
import { clearDraft, getDraft as getLocalDraft, markDraftSynced, saveDraft as saveLocalDraft } from "../../store/survey.js";
import { secureUuid } from "../../utils/business.js";

Page({
  data: {
    meta: null,
    highlight: "",
    suggestion: "",
    submitState: "draft",
    message: "",
    submittedAt: "",
    loading: true,
    saving: false,
    focusField: "",
    highlightError: "",
    keyboardOpen: false,
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
    await this.load();
  },

  async load() {
    this.setData({ loading: true, message: "" });
    try {
      const assignment = await getAssignment(this.routeMeta.assignmentId);
      if (assignment.status === "submitted") {
        wx.showToast({ title: "该任务已提交", icon: "none" });
        wx.redirectTo({ url: `/pages/task/index?assignmentId=${encodeURIComponent(this.routeMeta.assignmentId)}` });
        return;
      }
      const result = await getDraft(this.routeMeta.attemptId);
      if (result.attempt.id !== this.routeMeta.attemptId || result.questionnaireVersion.id !== this.routeMeta.questionnaireVersionId) {
        throw new Error("问卷信息已更新，请从任务详情重新进入");
      }
      if (["submitting", "processing", "submitted"].includes(result.attempt.status)) {
        wx.showToast({ title: result.attempt.status === "submitted" ? "该任务已提交" : "问卷正在提交", icon: "none" });
        wx.redirectTo({ url: `/pages/task/index?assignmentId=${encodeURIComponent(this.routeMeta.assignmentId)}` });
        return;
      }
      const meta = { ...this.routeMeta, revision: result.attempt.revision };
      const local = getLocalDraft(meta);
      const useLocal = local.synced === false;
      const records = useLocal ? local : (result.otherRecords || {});
      if (!useLocal) {
        saveLocalDraft(meta, { highlight: records.highlight || "", suggestion: records.suggestion || "" });
        markDraftSynced(meta, meta.revision);
      }
      this.routeMeta = meta;
      this.assignmentRevision = assignment.revision ?? result.assignment?.revision ?? meta.revision;
      this.dirty = useLocal;
      this.setData({
        meta,
        highlight: records.highlight || "",
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
    this.setData({ [field]: event.detail.value, submitState: "draft", ...(field === "highlight" ? { highlightError: "", message: "" } : {}) });
    this.persistLocal();
  },

  keyboard(event) { this.setData({ keyboardOpen: Number(event.detail.height || 0) > 0 }); },

  async back() {
    if (this.locked()) return;
    const saved = await this.saveRecords();
    if (!saved) return;
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: routeUrl("/pages/dishes/index", this.routeMeta) });
  },

  async confirm() {
    if (this.locked()) return;
    if (this.data.submitState === "retryable_failed" && this.submitToken) {
      await this.retrySubmit();
      return;
    }
    if (!this.data.highlight.trim()) {
      this.setData({ highlightError: "请填写闪光点", focusField: "highlight", message: "" }, () => {
        wx.pageScrollTo({ selector: "#highlight-field", duration: 220 });
      });
      return;
    }
    const saved = await this.saveRecords();
    if (!saved) return;
    wx.showModal({
      title: "确认提交问卷？",
      content: "提交后将无法回看或修改本次问卷，请确认所有内容已经完成。",
      confirmText: "确认提交",
      confirmColor: "#f26445",
      cancelText: "取消",
      success: (result) => { if (result.confirm) this.submit(); },
    });
  },

  async saveRecords() {
    if (this.data.saving) return null;
    const highlight = this.data.highlight.trim();
    const suggestion = this.data.suggestion.trim();
    this.setData({ saving: true, message: "" });
    saveLocalDraft(this.routeMeta, { highlight, suggestion });
    try {
      const saved = await saveOtherRecords(this.routeMeta.attemptId, { highlight, suggestion, revision: this.routeMeta.revision });
      const meta = { ...this.routeMeta, revision: saved.revision };
      markDraftSynced(meta, saved.revision);
      this.routeMeta = meta;
      this.assignmentRevision = saved.assignmentRevision ?? this.assignmentRevision ?? saved.revision;
      this.dirty = false;
      this.setData({ meta, highlight, suggestion });
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
    this.setData({ submitState: "submitted", submittedAt: result.submittedAt || "", message: "提交成功" });
  },

  locked() { return ["submitting", "processing", "submitted"].includes(this.data.submitState); },

  persistLocal() {
    if (!this.routeMeta) return;
    try { saveLocalDraft(this.routeMeta, { highlight: this.data.highlight, suggestion: this.data.suggestion }); } catch { /* Session errors are handled by the next API request. */ }
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

import { checkIn, getAssignment, startAssignment } from "../../services/api.js";
import { formatBudgetLabel, formatSubmittedAt, formatTimeRange, mapAssignmentStatus } from "../../utils/presentation.js";

const PHASE_TEXT = {
  locating: "正在获取现场位置…",
  checking_in: "正在核对是否到达门店…",
  starting: "位置已通过，正在创建问卷…",
  navigating: "问卷已准备好，正在打开…",
};
const ACTIVE_PHASES = ["locating", "checking_in", "starting", "navigating"];

function checkinMessage(result) {
  return ({
    accepted: "现场位置已通过",
    outside_radius: "当前距离门店较远，请到店后重试",
    stale: "定位结果已过期，请重新定位",
    low_accuracy: "定位精度不足，请移动到较开阔位置后重试",
    rejected: "当前位置未通过，请重新定位",
  })[result] || "暂时无法确认位置，请稍后重试";
}

Page({
  data: {
    assignmentId: "", task: null,
    loading: true, loadSlow: false, error: "", errorBlocking: false, retrying: false,
    phase: "idle", phaseText: "开始时将重新定位", startFailed: "", navigating: false,
  },
  onLoad(options) {
    // onUnload 防护：页面离开后异步回调不得继续 setData。
    this.unloaded = false;
    if (!options.assignmentId) { this.setData({ loading: false, error: "未找到对应任务，请从日程重新进入", errorBlocking: true }); return; }
    this.setData({ assignmentId: options.assignmentId });
    // 加载超过 800ms 才提示，避免瞬间闪烁。
    this.slowTimer = setTimeout(() => { if (!this.unloaded && this.data.loading) this.setData({ loadSlow: true }); }, 800);
    this.load();
  },
  onUnload() {
    this.unloaded = true;
    if (this.slowTimer) clearTimeout(this.slowTimer);
  },
  async load() {
    this.setData({ loading: true, error: "", errorBlocking: false, loadSlow: false });
    try {
      const raw = await getAssignment(this.data.assignmentId);
      if (this.unloaded) return;
      // 展示字段只在 JS 生成：提交时间格式化（本地时区，无效降级）；后端新增的
      // 门店地址/预算/时间窗/菜品要求同样在此归一，缺失时给出安全兜底。
      this.setData({ task: {
        ...raw,
        submittedAtLabel: raw.submittedAt ? formatSubmittedAt(raw.submittedAt) : "",
        statusLabel: mapAssignmentStatus(raw.status).statusText,
        address: raw.storeAddress || "",
        windowLabel: formatTimeRange(raw.startsAt, raw.dueAt),
        questionnaireDeadlineLabel: raw.questionnaireDeadlineAt ? formatSubmittedAt(raw.questionnaireDeadlineAt) : "",
        budgetLabel: formatBudgetLabel(raw.budgetLimitCents),
        dishRequirements: Array.isArray(raw.dishRequirements) ? raw.dishRequirements : [],
        specialInstruction: raw.specialInstruction || "",
      } });
    } catch (error) {
      if (this.unloaded) return;
      this.setData({ error: error.message, errorBlocking: !this.data.task });
    } finally {
      if (!this.unloaded) this.setData({ loading: false, retrying: false });
    }
  },
  retry() { if (this.data.retrying) return; this.setData({ retrying: true }); this.load(); },
  backToSchedule() { wx.switchTab({ url: "/pages/schedule/index" }); },
  continueDraft() {
    const { task, assignmentId, navigating } = this.data;
    if (!task?.attempt?.id || navigating) return; // 防重复跳转
    this.setData({ navigating: true });
    this.openSurvey({ assignmentId, attemptId: task.attempt.id, questionnaireVersionId: task.questionnaireVersion.id, revision: task.attempt.revision });
  },
  // 阶段顺序固定：wx.getLocation → checkIn → startAssignment → redirectTo 问卷。
  // 每个阶段只有一次活动请求；活动阶段禁止再次触发。
  start() {
    const { task, phase } = this.data;
    if (ACTIVE_PHASES.includes(phase) || this.data.navigating) return;
    if (["submitted", "overdue", "cancelled"].includes(task?.status)) return;
    this.setData({ phase: "locating", phaseText: PHASE_TEXT.locating, startFailed: "" });
    wx.getLocation({
      type: "gcj02", isHighAccuracy: true, highAccuracyExpireTime: 5000,
      success: async (location) => {
        if (this.unloaded) return;
        this.setData({ phase: "checking_in", phaseText: PHASE_TEXT.checking_in });
        try {
          const sample = { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy, capturedAt: new Date().toISOString() };
          const result = await checkIn(this.data.assignmentId, sample);
          if (result.result !== "accepted") {
            this.setData({ phase: "failed", startFailed: checkinMessage(result.result) });
            return;
          }
          this.setData({ phase: "starting", phaseText: PHASE_TEXT.starting });
          const started = await startAssignment(this.data.assignmentId);
          if (this.unloaded) return;
          this.setData({ phase: "navigating", phaseText: PHASE_TEXT.navigating });
          this.openSurvey({ assignmentId: this.data.assignmentId, attemptId: started.attempt.id, questionnaireVersionId: started.questionnaireVersion.id, revision: started.attempt.revision });
        } catch (error) {
          if (this.unloaded) return;
          this.setData({ phase: "failed", startFailed: error.message });
        }
      },
      fail: () => {
        if (this.unloaded) return;
        this.setData({ phase: "failed", startFailed: "未能获取位置，请检查定位权限后重试" });
        wx.showModal({ title: "需要位置权限", content: "你仍可查看任务说明，但开始探店需要获取最新位置。", confirmText: "打开设置", success: (res) => res.confirm && wx.openSetting() });
      },
    });
  },
  openSurvey(meta) { wx.redirectTo({ url: `/pages/survey/index?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}` }); },
});

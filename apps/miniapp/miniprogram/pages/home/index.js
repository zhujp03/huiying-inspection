import { getMyAssignments } from "../../services/api.js";
import { requireApprovedSession } from "../../utils/auth.js";
import { projectAssignmentForDisplay } from "../../utils/presentation.js";
import { getDraft } from "../../store/survey.js";

// 本地草稿答题进度（中断恢复的位置感）：只统计与当前 revision 匹配的草稿。
function draftProgressOf(assignment) {
  if (!assignment?.hasAttempt || !assignment?.attempt || !assignment?.questionnaireVersion) return "";
  try {
    const draft = getDraft({
      assignmentId: assignment.id,
      attemptId: assignment.attempt.id,
      questionnaireVersionId: assignment.questionnaireVersion.id,
      revision: assignment.attempt.revision,
    });
    const answered = draft?.answers ? Object.keys(draft.answers).length : 0;
    if (answered <= 0) return "";
    const total = Number(assignment.questionnaireVersion.questionCount) || 0;
    return total > 0 ? `已完成 ${Math.min(answered, total)} / ${total} 题` : `已答 ${answered} 题`;
  } catch { return ""; } // 草稿读取失败不影响首页展示
}

// 下一项任务优先级：in_progress > assigned；同级按 dueAt 从早到晚。
// overdue/submitted/cancelled 不作为“下一项可执行任务”。
function pickNextExecutable(items) {
  const executable = items
    .filter((item) => ["assigned", "in_progress"].includes(item.status))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "in_progress" ? -1 : 1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });
  if (!executable[0]) return null;
  const task = projectAssignmentForDisplay(executable[0]);
  const draftProgressText = draftProgressOf(executable[0]);
  return draftProgressText ? { ...task, draftProgressText } : task;
}

Page({
  data: {
    loading: true, error: "", task: null, refreshing: false, navigating: false,
    counts: { assigned: 0, inProgress: 0, overdue: 0 },
  },
  onShow() { if (requireApprovedSession()) this.load(); },
  async load() {
    // 首次加载显示骨架；已有内容时后台刷新不清空页面。
    this.setData({ loading: !this.data.task, error: "" });
    try {
      const result = await getMyAssignments();
      const items = result.items;
      this.setData({
        task: pickNextExecutable(items),
        counts: {
          assigned: items.filter((item) => item.status === "assigned").length,
          inProgress: items.filter((item) => item.status === "in_progress").length,
          overdue: items.filter((item) => item.status === "overdue").length,
        },
      });
    } catch (error) {
      // 业务/网络错误自带中文文案；未预期的前端异常只记 Console，不把英文开发错误展示给探店员。
      console.error("首页任务加载失败", error);
      this.setData({ error: error?.kind ? error.message : "暂时无法加载任务，请重试" });
    } finally { this.setData({ loading: false, refreshing: false }); }
  },
  retry() { if (this.data.refreshing) return; this.setData({ refreshing: true }); this.load(); },
  goTask() {
    if (this.data.navigating || !this.data.task) return;
    this.setData({ navigating: true });
    wx.navigateTo({
      url: `/pages/task/index?assignmentId=${encodeURIComponent(this.data.task.id)}`,
      complete: () => this.setData({ navigating: false }),
    });
  },
  goSchedule() { wx.switchTab({ url: "/pages/schedule/index" }); },
});

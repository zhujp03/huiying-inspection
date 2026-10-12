// utils/presentation.js（module-contracts §5.1；小程序 utils/presentation.js:10-104 同名同语义）
// 展示语义明细以 inventory §7 为准（设备本地时区；原始 ISO 时间不得直接进模板）。
//
// 语义（R90-R93）：纯展示工具，所有时间/日期/状态展示字段只在这里生成。
// 无副作用、不依赖平台 API，可在 Node 中单独测试。
// 时间使用设备本地时区（new Date 解析），不依赖 Intl。

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad(number) {
  return String(number).padStart(2, "0");
}

/** 安全解析日期：无效输入返回 null（禁止出现 Invalid Date 展示）。 */
export function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hhmm(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 日期标题，例如「8月11日 周二」。无效返回「时间待确认」。 */
export function formatDateHeading(value) {
  const date = safeDate(value);
  if (!date) return "时间待确认";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
}

/** 时间区间，例如「19:32–20:03」。同天短格式；跨天时只给开始时刻（截止日期由 displayDueDate 单独展示）。 */
export function formatTimeRange(startIso, endIso) {
  const start = safeDate(startIso);
  if (!start) return "时间待确认";
  const end = safeDate(endIso);
  if (!end) return `${hhmm(start)} 起`;
  return isSameDay(start, end) ? `${hhmm(start)}–${hhmm(end)}` : `${hhmm(start)} 开始`;
}

/** 提交时间，例如「8月11日 周二 19:32」。 */
export function formatSubmittedAt(value) {
  const date = safeDate(value);
  if (!date) return "时间待确认";
  return `${formatDateHeading(date)} ${hhmm(date)}`;
}

/** 预算展示：分转元保留两位；0 或缺失表示「未设置」。 */
export function formatBudgetLabel(cents) {
  if (!Number.isInteger(cents) || cents <= 0) return "未设置";
  return `¥${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

const STATUS_PRESENTATION = {
  assigned: { statusText: "待开始", statusTone: "primary", actionText: "查看任务" },
  in_progress: { statusText: "进行中", statusTone: "dark", actionText: "继续填写" },
  overdue: { statusText: "已逾期", statusTone: "warning", actionText: "查看详情" },
  submitted: { statusText: "已提交", statusTone: "neutral", actionText: "查看状态" },
  cancelled: { statusText: "已取消", statusTone: "muted", actionText: "查看详情" },
};

/** 状态展示字段：statusText / statusTone / actionText / isActionable。 */
export function mapAssignmentStatus(status) {
  return STATUS_PRESENTATION[status] || { statusText: "状态待确认", statusTone: "muted", actionText: "查看详情", isActionable: true };
}

export function taskTypeText(taskType) {
  return taskType === "secret" ? "暗访" : taskType === "overt" ? "明察" : "";
}

/**
 * 把服务端任务转成只用于显示的字段。原始 ISO（startsAt/dueAt/submittedAt）不得直接进入视图层。
 * isActionable：可进入任务详情查看（页面可再按区域收紧，例如问卷入口的 submitted/overdue 只读不绑 tap）。
 */
export function projectAssignmentForDisplay(assignment) {
  const status = mapAssignmentStatus(assignment.status);
  const start = safeDate(assignment.startsAt);
  const end = safeDate(assignment.dueAt);
  const crossDay = Boolean(start && end && !isSameDay(start, end));
  return {
    id: assignment.id,
    storeName: assignment.storeName || "门店待确认",
    name: assignment.name || "任务待确认",
    taskTypeText: taskTypeText(assignment.taskType) || "任务",
    displayDate: formatDateHeading(assignment.startsAt),
    displayTime: formatTimeRange(assignment.startsAt, assignment.dueAt),
    displayDueDate: crossDay ? formatDateHeading(assignment.dueAt) : "",
    displaySubmittedAt: formatSubmittedAt(assignment.submittedAt),
    statusText: status.statusText,
    statusTone: status.statusTone,
    actionText: status.actionText,
    isActionable: ["assigned", "in_progress", "overdue", "submitted", "cancelled"].includes(assignment.status),
  };
}

/** 按日期标题分组（保持服务端顺序，同一日期内按原顺序展示）。 */
export function groupAssignmentsByDate(assignments) {
  const groups = [];
  const index = new Map();
  for (const item of assignments) {
    const display = projectAssignmentForDisplay(item);
    if (!index.has(display.displayDate)) {
      index.set(display.displayDate, { dateHeading: display.displayDate, items: [] });
      groups.push(index.get(display.displayDate));
    }
    index.get(display.displayDate).items.push(display);
  }
  return groups;
}

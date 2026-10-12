import { describe, expect, it } from "vitest";
import {
  formatDateHeading, formatSubmittedAt, formatTimeRange, groupAssignmentsByDate,
  mapAssignmentStatus, projectAssignmentForDisplay, safeDate,
} from "../../apps/miniapp/miniprogram/utils/presentation.js";

// 用本地时区构造时间，避免 CI 时区差异。
const localIso = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();

describe("safeDate", () => {
  it("returns null for invalid input instead of Invalid Date", () => {
    expect(safeDate(null)).toBeNull();
    expect(safeDate("")).toBeNull();
    expect(safeDate("not-a-date")).toBeNull();
    expect(safeDate(undefined)).toBeNull();
  });
  it("parses valid ISO", () => {
    expect(safeDate(localIso(2026, 8, 11, 19, 32))).not.toBeNull();
  });
});

describe("formatTimeRange", () => {
  it("formats same-day range as HH:mm–HH:mm", () => {
    expect(formatTimeRange(localIso(2026, 8, 11, 19, 32), localIso(2026, 8, 11, 20, 3))).toBe("19:32–20:03");
  });
  it("formats cross-day range with start time only", () => {
    expect(formatTimeRange(localIso(2026, 8, 11, 23, 0), localIso(2026, 8, 12, 0, 30))).toBe("23:00 开始");
  });
  it("degrades safely for invalid dates", () => {
    expect(formatTimeRange(null, localIso(2026, 8, 11, 20, 3))).toBe("时间待确认");
    expect(formatTimeRange("garbage", localIso(2026, 8, 11, 20, 3))).toBe("时间待确认");
    expect(formatTimeRange(localIso(2026, 8, 11, 19, 32), "garbage")).toBe("19:32 起");
  });
});

describe("formatDateHeading / formatSubmittedAt", () => {
  it("formats local date heading without ISO", () => {
    // 2026-08-11 是周二（与视觉契约示例一致）。
    expect(formatDateHeading(localIso(2026, 8, 11, 19, 32))).toBe("8月11日 周二");
  });
  it("formats submitted time in local time", () => {
    expect(formatSubmittedAt(localIso(2026, 8, 11, 19, 32))).toBe("8月11日 周二 19:32");
  });
  it("degrades safely", () => {
    expect(formatDateHeading("bad")).toBe("时间待确认");
    expect(formatSubmittedAt(null)).toBe("时间待确认");
  });
});

describe("mapAssignmentStatus", () => {
  it("maps every business status with tone and action text", () => {
    expect(mapAssignmentStatus("assigned")).toMatchObject({ statusText: "待开始", statusTone: "primary", actionText: "查看任务" });
    expect(mapAssignmentStatus("in_progress")).toMatchObject({ statusText: "进行中", statusTone: "dark", actionText: "继续填写" });
    expect(mapAssignmentStatus("overdue")).toMatchObject({ statusText: "已逾期", statusTone: "warning", actionText: "查看详情" });
    expect(mapAssignmentStatus("submitted")).toMatchObject({ statusText: "已提交", statusTone: "neutral" });
    expect(mapAssignmentStatus("cancelled")).toMatchObject({ statusText: "已取消", statusTone: "muted" });
  });
  it("falls back for unknown status", () => {
    expect(mapAssignmentStatus("weird")).toMatchObject({ statusText: "状态待确认", statusTone: "muted" });
  });
});

describe("projectAssignmentForDisplay", () => {
  const base = { id: "a1", storeName: "真实门店", name: "真实任务", taskType: "secret", status: "assigned", startsAt: localIso(2026, 8, 11, 19, 32), dueAt: localIso(2026, 8, 11, 20, 3) };
  it("produces display fields without raw ISO", () => {
    const d = projectAssignmentForDisplay(base);
    expect(d.storeName).toBe("真实门店");
    expect(d.displayDate).toBe("8月11日 周二");
    expect(d.displayTime).toBe("19:32–20:03");
    expect(d.displayDueDate).toBe("");
    expect(d.taskTypeText).toBe("暗访");
    expect(d.isActionable).toBe(true);
  });
  it("adds displayDueDate only when crossing days", () => {
    const d = projectAssignmentForDisplay({ ...base, startsAt: localIso(2026, 8, 11, 23, 0), dueAt: localIso(2026, 8, 12, 0, 30) });
    expect(d.displayTime).toBe("23:00 开始");
    expect(d.displayDueDate).toBe("8月12日 周三");
  });
  it("degrades invalid dates", () => {
    const d = projectAssignmentForDisplay({ ...base, startsAt: "", dueAt: "bad" });
    expect(d.displayDate).toBe("时间待确认");
    expect(d.displayTime).toBe("时间待确认");
  });
  it("keeps submitted display time formatted", () => {
    const d = projectAssignmentForDisplay({ ...base, status: "submitted", submittedAt: localIso(2026, 8, 11, 21, 0) });
    expect(d.displaySubmittedAt).toBe("8月11日 周二 21:00");
  });
});

describe("groupAssignmentsByDate", () => {
  it("groups by date heading preserving order", () => {
    const groups = groupAssignmentsByDate([
      { id: "a", status: "assigned", taskType: "secret", storeName: "A", name: "任务A", startsAt: localIso(2026, 8, 11, 19, 0), dueAt: localIso(2026, 8, 11, 20, 0) },
      { id: "b", status: "assigned", taskType: "secret", storeName: "B", name: "任务B", startsAt: localIso(2026, 8, 12, 9, 0), dueAt: localIso(2026, 8, 12, 10, 0) },
      { id: "c", status: "in_progress", taskType: "secret", storeName: "C", name: "任务C", startsAt: localIso(2026, 8, 11, 21, 0), dueAt: localIso(2026, 8, 11, 22, 0) },
    ]);
    expect(groups.map((g) => g.dateHeading)).toEqual(["8月11日 周二", "8月12日 周三"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "c"]);
  });
});

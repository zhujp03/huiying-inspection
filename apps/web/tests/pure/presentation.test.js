import { describe, expect, it } from "vitest";
import { loadSrc } from "../helpers/contract-paths.js";

// H5 镜像模块：utils/presentation.js（契约 docs/web/module-contracts.md §5.1）。
// 期望值全部硬编码，逐条对照小程序源码 apps/miniapp/miniprogram/utils/presentation.js（只读校准）。
const presentation = await loadSrc("utils/presentation.js");

const {
  safeDate, formatDateHeading, formatTimeRange, formatSubmittedAt, formatBudgetLabel,
  mapAssignmentStatus, taskTypeText, projectAssignmentForDisplay, groupAssignmentsByDate,
} = presentation;

// 用本地时区构造时间，避免 CI 时区漂移（与 tests/unit/presentation.test.js:8 同法）。2026-08-11 是周二。
const localIso = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();

describe("safeDate（presentation.js:10-14）", () => {
  it("无效输入返回 null，杜绝 Invalid Date 上屏", () => {
    expect(safeDate(null)).toBeNull();
    expect(safeDate("")).toBeNull();
    expect(safeDate("not-a-date")).toBeNull();
    expect(safeDate(undefined)).toBeNull();
  });
  it("合法 ISO 解析为 Date 且时间值有效", () => {
    const parsed = safeDate(localIso(2026, 8, 11, 19, 32));
    expect(parsed).toBeInstanceOf(Date);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });
});

describe("formatDateHeading（presentation.js:23-27）", () => {
  it("输出「M月D日 周X」，2026-08-11 是周二", () => {
    expect(formatDateHeading(localIso(2026, 8, 11, 19, 32))).toBe("8月11日 周二");
  });
  it("无效输入降级为「时间待确认」", () => {
    expect(formatDateHeading("bad")).toBe("时间待确认");
    expect(formatDateHeading(null)).toBe("时间待确认");
  });
});

describe("formatTimeRange（presentation.js:30-36）", () => {
  it("同天区间用 en dash「HH:mm–HH:mm」", () => {
    expect(formatTimeRange(localIso(2026, 8, 11, 19, 32), localIso(2026, 8, 11, 20, 3))).toBe("19:32–20:03");
  });
  it("跨天只给开始时刻「HH:mm 开始」", () => {
    expect(formatTimeRange(localIso(2026, 8, 11, 23, 0), localIso(2026, 8, 12, 0, 30))).toBe("23:00 开始");
  });
  it("end 无效降级「HH:mm 起」", () => {
    expect(formatTimeRange(localIso(2026, 8, 11, 19, 32), "garbage")).toBe("19:32 起");
  });
  it("start 无效返回「时间待确认」", () => {
    expect(formatTimeRange(null, localIso(2026, 8, 11, 20, 3))).toBe("时间待确认");
    expect(formatTimeRange("garbage", localIso(2026, 8, 11, 20, 3))).toBe("时间待确认");
  });
});

describe("formatSubmittedAt（presentation.js:39-43）", () => {
  it("输出「M月D日 周X HH:mm」", () => {
    expect(formatSubmittedAt(localIso(2026, 8, 11, 19, 32))).toBe("8月11日 周二 19:32");
  });
  it("无效输入降级为「时间待确认」", () => {
    expect(formatSubmittedAt(null)).toBe("时间待确认");
    expect(formatSubmittedAt("nope")).toBe("时间待确认");
  });
});

describe("formatBudgetLabel（presentation.js:46-49）", () => {
  it("非正整数/0/缺失 →「未设置」", () => {
    expect(formatBudgetLabel(0)).toBe("未设置");
    expect(formatBudgetLabel(-100)).toBe("未设置");
    expect(formatBudgetLabel(null)).toBe("未设置");
    expect(formatBudgetLabel(undefined)).toBe("未设置");
    expect(formatBudgetLabel(12.5)).toBe("未设置");
    expect(formatBudgetLabel(NaN)).toBe("未设置");
  });
  it("正整数分转元，保留两位小数", () => {
    expect(formatBudgetLabel(1234)).toBe("¥12.34");
    expect(formatBudgetLabel(1999)).toBe("¥19.99");
    expect(formatBudgetLabel(105)).toBe("¥1.05");
    expect(formatBudgetLabel(10000)).toBe("¥100.00");
  });
});

describe("mapAssignmentStatus（presentation.js:51-62）", () => {
  it("五态逐字映射 statusText/statusTone/actionText", () => {
    expect(mapAssignmentStatus("assigned")).toEqual({ statusText: "待开始", statusTone: "primary", actionText: "查看任务" });
    expect(mapAssignmentStatus("in_progress")).toEqual({ statusText: "进行中", statusTone: "dark", actionText: "继续填写" });
    expect(mapAssignmentStatus("overdue")).toEqual({ statusText: "已逾期", statusTone: "warning", actionText: "查看详情" });
    expect(mapAssignmentStatus("submitted")).toEqual({ statusText: "已提交", statusTone: "neutral", actionText: "查看状态" });
    expect(mapAssignmentStatus("cancelled")).toEqual({ statusText: "已取消", statusTone: "muted", actionText: "查看详情" });
  });
  it("未知值返回「状态待确认」muted 且 isActionable 为 true", () => {
    expect(mapAssignmentStatus("weird")).toEqual({ statusText: "状态待确认", statusTone: "muted", actionText: "查看详情", isActionable: true });
    expect(mapAssignmentStatus(undefined)).toEqual({ statusText: "状态待确认", statusTone: "muted", actionText: "查看详情", isActionable: true });
  });
});

describe("taskTypeText（presentation.js:64）", () => {
  it("secret→暗访、overt→明察、其他→空串", () => {
    expect(taskTypeText("secret")).toBe("暗访");
    expect(taskTypeText("overt")).toBe("明察");
    expect(taskTypeText("other")).toBe("");
    expect(taskTypeText(undefined)).toBe("");
  });
});

describe("projectAssignmentForDisplay（presentation.js:70-89）", () => {
  const sampleAssignment = {
    id: "a1", storeName: "真实门店", name: "真实任务", taskType: "secret", status: "assigned",
    startsAt: localIso(2026, 8, 11, 19, 32), dueAt: localIso(2026, 8, 11, 20, 3),
  };

  it("同天任务投影：displayDate/displayTime/displayDueDate 为空串/displaySubmittedAt 降级", () => {
    const view = projectAssignmentForDisplay(sampleAssignment);
    expect(view.displayDate).toBe("8月11日 周二");
    expect(view.displayTime).toBe("19:32–20:03");
    expect(view.displayDueDate).toBe("");
    expect(view.displaySubmittedAt).toBe("时间待确认");
    expect(view.taskTypeText).toBe("暗访");
    expect(view.storeName).toBe("真实门店");
    expect(view.statusText).toBe("待开始");
  });

  it("跨天任务补充 displayDueDate「8月12日 周三」，displayTime 只给开始", () => {
    const view = projectAssignmentForDisplay({
      ...sampleAssignment,
      startsAt: localIso(2026, 8, 11, 23, 0), dueAt: localIso(2026, 8, 12, 0, 30),
    });
    expect(view.displayTime).toBe("23:00 开始");
    expect(view.displayDueDate).toBe("8月12日 周三");
  });

  it("submittedAt 存在时按「M月D日 周X HH:mm」展示", () => {
    const view = projectAssignmentForDisplay({ ...sampleAssignment, status: "submitted", submittedAt: localIso(2026, 8, 11, 21, 0) });
    expect(view.displaySubmittedAt).toBe("8月11日 周二 21:00");
  });

  it("taskType 未知兜底「任务」、storeName 缺失兜底「门店待确认」、无效日期降级", () => {
    const view = projectAssignmentForDisplay({ ...sampleAssignment, taskType: "vip", storeName: "", startsAt: "", dueAt: "bad" });
    expect(view.taskTypeText).toBe("任务");
    expect(view.storeName).toBe("门店待确认");
    expect(view.displayDate).toBe("时间待确认");
    expect(view.displayTime).toBe("时间待确认");
  });

  it("五态 isActionable 全为 true，未知状态为 false", () => {
    for (const status of ["assigned", "in_progress", "overdue", "submitted", "cancelled"]) {
      expect(projectAssignmentForDisplay({ ...sampleAssignment, status }).isActionable).toBe(true);
    }
    expect(projectAssignmentForDisplay({ ...sampleAssignment, status: "weird" }).isActionable).toBe(false);
  });

  it("投影只含展示字段，原始 ISO 不外泄（presentation.js:67,75-88）", () => {
    const view = projectAssignmentForDisplay(sampleAssignment);
    expect(Object.keys(view).sort()).toEqual([
      "actionText", "displayDate", "displayDueDate", "displaySubmittedAt", "displayTime", "id",
      "isActionable", "name", "statusText", "statusTone", "storeName", "taskTypeText",
    ]);
    const serialized = JSON.stringify(view);
    expect(serialized.includes("startsAt")).toBe(false);
    expect(serialized.includes("dueAt")).toBe(false);
    expect(serialized.includes("submittedAt")).toBe(false);
  });
});

describe("groupAssignmentsByDate（presentation.js:92-104）", () => {
  it("按 displayDate 分组并保持原序，同日任务保持插入顺序", () => {
    const groups = groupAssignmentsByDate([
      { id: "a", status: "assigned", taskType: "secret", storeName: "门店A", name: "任务A", startsAt: localIso(2026, 8, 11, 19, 0), dueAt: localIso(2026, 8, 11, 20, 0) },
      { id: "b", status: "assigned", taskType: "secret", storeName: "门店B", name: "任务B", startsAt: localIso(2026, 8, 12, 9, 0), dueAt: localIso(2026, 8, 12, 10, 0) },
      { id: "c", status: "in_progress", taskType: "secret", storeName: "门店C", name: "任务C", startsAt: localIso(2026, 8, 11, 21, 0), dueAt: localIso(2026, 8, 11, 22, 0) },
    ]);
    expect(groups.map((group) => group.dateHeading)).toEqual(["8月11日 周二", "8月12日 周三"]);
    expect(groups[0].items.map((item) => item.id)).toEqual(["a", "c"]);
    expect(groups[1].items.map((item) => item.id)).toEqual(["b"]);
  });
  it("空数组返回空数组", () => {
    expect(groupAssignmentsByDate([])).toEqual([]);
  });
});

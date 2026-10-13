import { describe, expect, it } from "vitest";
import ExcelJS, { ValueType } from "exceljs";
import {
  buildSubmissionExportFileName, buildSubmissionExportModel, buildSubmissionWorkbook,
  EXPORT_SUBMISSION_SCORES_MISSING, formatShanghaiDateTime, reconstructScoreRows,
} from "../../apps/worker/src/submission-export.js";

const questionId = (n) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
// 逐题得分行（submission_question_scores 形态；awarded_score 为提交时清零后的最终值）
const scoreRow = (n, { category, text, answer = "scored", awarded, max, wipe = false, categoryName = null } = {}) => ({
  question_id: questionId(n), question_key: `k${n}`, question_number: n, question_text: text, category,
  category_name: categoryName, answer, awarded_score: awarded, max_score: max, is_score_wipe: wipe,
});
// 基础提交行（submission_versions 形态 + 联查元数据）：两分类各一题，满分 10 得 7
const baseSubmission = (overrides = {}) => ({
  id: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", total_score: 7, max_score: 10, issue_count: 1,
  task_name: "秋季暗访任务", business_no: "JD-20261001-001", store_name: "静态测试门店", brand_name: "测试品牌",
  region_name: "测试区域", inspector_name: "测试探店员", questionnaire_name: "暗访问卷", version_number: 3,
  submitted_at: new Date("2026-10-09T05:30:00Z"), visit_at: new Date("2026-10-09T03:00:00Z"),
  answer_snapshot_json: [], dish_snapshot_json: [], other_snapshot_json: { highlight: "主动补位", suggestion: null },
  evidence_snapshot_json: [], receipt_snapshot_json: [], ...overrides,
});
const baseScoreRows = () => [
  scoreRow(1, { category: "env-x", text: "环境检查题", awarded: 2, max: 5, categoryName: "环境卫生" }),
  scoreRow(2, { category: "svc-x", text: "服务检查题", answer: "unscored", awarded: 0, max: 5, categoryName: "为客服务" }),
];
const baseRemarks = () => ({ [questionId(2)]: "迎宾不及时" });

const buildModel = (overrides = {}) => buildSubmissionExportModel({
  submission: baseSubmission(overrides.submission || {}),
  scoreRows: overrides.scoreRows || baseScoreRows(),
  scoreSource: overrides.scoreSource || "recorded",
  remarks: overrides.remarks || baseRemarks(),
});

async function workbookOf(model) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildSubmissionWorkbook(model));
  return workbook;
}
// 全表非空单元格文本（合并从属单元格 round-trip 后会解析为主格值，必须按类型跳过）
const sheetText = (sheet, columns = 7) => {
  const values = [];
  for (let row = 1; row <= sheet.rowCount; row += 1) for (let column = 1; column <= columns; column += 1) {
    const cell = sheet.getRow(row).getCell(column);
    if (cell.type === ValueType.Merge) continue;
    const value = cell.value;
    if (value !== null && value !== undefined && value !== "") values.push(String(value));
  }
  return values.join("\n");
};
// 仅收集主格（跳过合并从属格）的逐格文本
const cellValues = (sheet, columns = 7) => {
  const values = [];
  for (let row = 1; row <= sheet.rowCount; row += 1) for (let column = 1; column <= columns; column += 1) {
    const cell = sheet.getRow(row).getCell(column);
    if (cell.type === ValueType.Merge) continue;
    const value = cell.value;
    if (value !== null && value !== undefined && value !== "") values.push(String(value));
  }
  return values;
};
// 表体表头行定位（避免把行号写死进断言）
const findRowByFirstCell = (sheet, value) => {
  for (let row = 1; row <= sheet.rowCount; row += 1) if (sheet.getRow(row).getCell(1).value === value) return row;
  return -1;
};

describe("submission export workbook", () => {
  it("renders header info, dynamic category scores and reconciled totals", async () => {
    const model = buildModel();
    const workbook = await workbookOf(model);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["暗访评估表"]);
    const sheet = workbook.getWorksheet("暗访评估表");
    // 标题 = 问卷名 + 版本（动态，不含任何硬编码公司/题库内容）
    expect(sheet.getCell("A1").value).toBe("暗访问卷·暗访评估表（V3）");
    // 信息行：品牌/门店/任务编号 + 到店时间（打卡）与提交时间分列展示
    expect(sheet.getCell("A2").value).toBe("品牌");
    expect(sheet.getCell("B2").value).toBe("测试品牌");
    expect(sheet.getCell("D2").value).toBe("门店");
    expect(sheet.getCell("E2").value).toBe("静态测试门店");
    expect(sheet.getCell("B5").value).toBe("2026-10-09 11:00"); // UTC 03:00 → 上海 11:00
    expect(sheet.getCell("E5").value).toBe("2026-10-09 13:30"); // UTC 05:30 → 上海 13:30
    // 分类成绩块：动态分类名 + 原始分/得分率分列
    const scoreHeaderRow = findRowByFirstCell(sheet, "分类成绩");
    expect(sheet.getRow(scoreHeaderRow).getCell(3).value).toBe("得分（原始）");
    expect(sheet.getRow(scoreHeaderRow + 1).getCell(1).value).toBe("环境卫生");
    expect(sheet.getRow(scoreHeaderRow + 1).getCell(2).value).toBe(5);
    expect(sheet.getRow(scoreHeaderRow + 1).getCell(3).value).toBe(2);
    expect(sheet.getRow(scoreHeaderRow + 1).getCell(4).value).toBe(40);
    expect(sheet.getRow(scoreHeaderRow + 2).getCell(1).value).toBe("为客服务");
    expect(sheet.getRow(scoreHeaderRow + 2).getCell(3).value).toBe(0);
    // 总评对账：与提交权威 total/max 一致
    const totalRow = findRowByFirstCell(sheet, "总评");
    expect(sheet.getRow(totalRow).getCell(2).value).toBe(10);
    expect(sheet.getRow(totalRow).getCell(3).value).toBe(7);
    expect(sheet.getRow(totalRow).getCell(4).value).toBe(70);
  });

  it("renders the assessment table with merged category labels, subtotals, deduction colors and explanations", async () => {
    const model = buildModel();
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    expect(["序号", "评估说明", "探员答案", "分值", "扣分", "得分"].map((title, index) => sheet.getRow(headerRow).getCell(index + 2).value)).toEqual(["序号", "评估说明", "探员答案", "分值", "扣分", "得分"]);
    // 绿色表头
    expect(sheet.getRow(headerRow).getCell(1).fill.fgColor.argb).toBe("FFC6E0B4");
    // 题目行：分类标签在首列、不得分红色标注、扣分=分值-得分
    const q1Row = headerRow + 1;
    expect(sheet.getRow(q1Row).getCell(1).value).toBe("环境卫生");
    expect(sheet.getRow(q1Row).getCell(3).value).toBe("环境检查题");
    expect(sheet.getRow(q1Row).getCell(4).value).toBe("得分");
    expect(sheet.getRow(q1Row).getCell(6).value).toBe(3);
    // 分类小计黄底 + 扣分说明引用题号与探员原始备注
    const subtotalRow = headerRow + 2;
    expect(sheet.getRow(subtotalRow).getCell(1).value).toBe("环境卫生小计");
    expect(sheet.getRow(subtotalRow).getCell(1).fill.fgColor.argb).toBe("FFFFF2CC");
    const explanationRow = subtotalRow + 1;
    const explanation = sheet.getRow(explanationRow).getCell(3).value;
    expect(explanation).toContain("第 1 题「环境检查题」扣 3 分。");
    expect(sheet.getRow(explanationRow).getCell(1).value).toBe("环境卫生扣分说明");
    // 第二分类块：不得分红色标注；扣分说明引用题号与探员原始备注
    const svcLabelRow = explanationRow + 1;
    expect(sheet.getRow(svcLabelRow).getCell(1).value).toBe("为客服务");
    expect(sheet.getRow(svcLabelRow).getCell(4).value).toBe("不得分");
    expect(sheet.getRow(svcLabelRow).getCell(4).font.color.argb).toBe("FFC00000");
    expect(sheet.getRow(svcLabelRow).getCell(6).value).toBe(5);
    expect(sheet.getRow(svcLabelRow).getCell(6).font.color.argb).toBe("FFC00000");
    const svcExplanation = sheet.getRow(svcLabelRow + 2).getCell(3).value;
    expect(svcExplanation).toContain("第 2 题「服务检查题」扣 5 分");
    expect(svcExplanation).toContain("探员备注：迎宾不及时");
  });

  it("marks category wipe explicitly with trigger, zero scores and pre-wipe explanation", async () => {
    const scoreRows = [
      scoreRow(1, { category: "env-x", text: "环境卫生清零题", answer: "unscored", awarded: 0, max: 5, wipe: true, categoryName: "环境卫生" }),
      scoreRow(2, { category: "env-x", text: "环境普通题", awarded: 0, max: 5, categoryName: "环境卫生" }),
      scoreRow(3, { category: "svc-x", text: "服务检查题", awarded: 6, max: 6, categoryName: "为客服务" }),
    ];
    const submission = baseSubmission({ total_score: 6, max_score: 16, issue_count: 1 });
    const model = buildSubmissionExportModel({ submission, scoreRows, scoreSource: "recorded", remarks: { [questionId(1)]: "发现过期食材" } });
    expect(model.categories[0]).toMatchObject({ wiped: true, sumAwarded: 0, sumMax: 10, sumDeduction: 10 });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    let wipeFont = null;
    for (let row = 1; row <= sheet.rowCount; row += 1) {
      const cell = sheet.getRow(row).getCell(3);
      if (String(cell.value ?? "").includes("此大项分数直接清零")) wipeFont = cell.font;
    }
    const joined = sheetText(sheet);
    expect(joined).toContain("清零：第 1 题「环境卫生清零题」被判不得分");
    // 说明按单行长度分段成格，拼接后语义完整
    expect(joined.replace(/\n/g, "")).toContain("清零前合计 5 分不计");
    expect(joined).toContain("此大项分数直接清零");
    // 清零触发说明行红字；扣分说明引用探员原始备注
    expect(wipeFont.color.argb).toBe("FFC00000");
    expect(joined).toContain("探员备注：发现过期食材");
  });

  it("supports arbitrary category names and order without hardcoded Q/S/C", async () => {
    const scoreRows = [
      scoreRow(1, { category: "night-x", text: "夜场题一", awarded: 4, max: 4, categoryName: "Y-夜场运营" }),
      scoreRow(2, { category: "special-x", text: "特殊题一", awarded: 3, max: 6, categoryName: "X-专项检查" }),
      scoreRow(3, { category: "special-x", text: "特殊题二", awarded: 0, max: 2, answer: "unscored", categoryName: "X-专项检查" }),
    ];
    const model = buildSubmissionExportModel({ submission: baseSubmission({ total_score: 7, max_score: 12, issue_count: 1 }), scoreRows });
    expect(model.categories.map((category) => category.name)).toEqual(["Y-夜场运营", "X-专项检查"]);
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    // 多题分类的标签纵向合并：续行 A 列无值
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    expect(sheet.getRow(headerRow + 1).getCell(1).value).toBe("Y-夜场运营");
    const specialFirstRow = headerRow + 4; // 夜场 1 题 + 小计 + 扣分说明之后
    expect(sheet.getRow(specialFirstRow).getCell(1).value).toBe("X-专项检查");
    expect(sheet.getRow(specialFirstRow + 1).getCell(1).type).toBe(ValueType.Merge); // 纵向合并的续行
    const values = [];
    for (let row = 1; row <= sheet.rowCount; row += 1) for (let column = 1; column <= 7; column += 1) {
      const value = sheet.getRow(row).getCell(column).value;
      if (value !== null && value !== undefined && value !== "") values.push(String(value));
    }
    expect(values).toContain("Y-夜场运营小计");
    expect(values).toContain("X-专项检查小计");
    expect(values.join("\n")).not.toMatch(/Q-品质|S-服务|C-环境|西部马华|将道/);
  });

  it("falls back to the raw category code when the category name is unavailable", async () => {
    const model = buildModel({ scoreRows: [scoreRow(1, { category: "legacy-ops", text: "历史分类题", awarded: 7, max: 10 })], submission: { total_score: 7, max_score: 10, issue_count: 0 } });
    expect(model.categories[0].name).toBe("legacy-ops");
  });

  it("prints zero-max categories with an em-dash rate instead of dividing by zero", async () => {
    const model = buildModel({
      scoreRows: [
        scoreRow(1, { category: "env-x", text: "普通题", awarded: 0, max: 0, categoryName: "环境卫生" }),
        scoreRow(2, { category: "svc-x", text: "服务题", awarded: 7, max: 10, categoryName: "为客服务" }),
      ],
      submission: { total_score: 7, max_score: 10, issue_count: 0 },
    });
    expect(model.categories[0].rate).toBeNull();
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    const scoreHeaderRow = findRowByFirstCell(sheet, "分类成绩");
    expect(sheet.getRow(scoreHeaderRow + 1).getCell(4).value).toBe("—");
    expect(sheet.getRow(scoreHeaderRow + 1).getCell(2).value).toBe(0);
  });

  it("wraps long question text with sufficient row height", async () => {
    const longText = "营业时间内菜单菜品均正常供应，收银、传菜、迎宾与保洁等各岗位服务动作保持标准，".repeat(3);
    const model = buildModel({ scoreRows: [scoreRow(1, { category: "env-x", text: longText, awarded: 7, max: 10 })], submission: { total_score: 7, max_score: 10, issue_count: 0 } });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    expect(sheet.getRow(headerRow + 1).height).toBeGreaterThan(60);
    expect(sheet.getRow(headerRow + 1).getCell(3).alignment.wrapText).toBe(true);
  });

  it("omits optional sheets and shows placeholders when fields are missing", async () => {
    const model = buildModel({
      submission: { brand_name: null, visit_at: null, other_snapshot_json: {}, dish_snapshot_json: [], evidence_snapshot_json: [], receipt_snapshot_json: [] },
    });
    const workbook = await workbookOf(model);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["暗访评估表"]);
    const sheet = workbook.getWorksheet("暗访评估表");
    const joined = sheetText(sheet);
    expect(joined).toContain("未记录"); // 到店时间缺失，绝不出现 1900 占位
    expect(joined).not.toMatch(/1900/);
    expect(joined).toContain("改善建议\n未填写");
    expect(joined).toContain("闪光点\n未填写");
    expect(joined).toContain("未统计（系统暂无历史失分统计能力）");
    expect(sheet.getCell("B2").value).toBe("—"); // 品牌缺失
  });

  it("adds dish and attachment metadata sheets only when snapshots have content", async () => {
    const submission = baseSubmission({
      dish_snapshot_json: [
        { id: "d1", planned_name: "招牌烤鸭", actual_name: "招牌烤鸭", quantity: 1, unit_price_cents: 26800, line_total_cents: 26800, fulfillment_status: "ordered", evaluation: "温度适宜", fully_satisfied: true, instruction_snapshot: "记录温度" },
        { id: "d2", planned_name: "桂花糖藕", actual_name: null, quantity: null, planned_quantity: 1, unit_price_cents: null, line_total_cents: null, fulfillment_status: "unavailable", unavailable_reason: "晚市售罄", evaluation: null, fully_satisfied: false },
      ],
      evidence_snapshot_json: [
        { id: "e1", question_id: questionId(2), type: "image" },
        { id: "e2", question_id: questionId(2), type: "audio", duration_seconds: 12 },
      ],
      receipt_snapshot_json: [{ id: "r1", display_order: 1 }],
    });
    const workbook = await workbookOf(buildModel({ submission }));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["暗访评估表", "菜品记录", "附件清单"]);
    const dishSheet = workbook.getWorksheet("菜品记录");
    expect(dishSheet.getRow(2).getCell(6).value).toBe(268); // 26800 分 → 268.00 元
    expect(dishSheet.getRow(2).getCell(8).value).toContain("温度适宜");
    expect(dishSheet.getRow(3).getCell(5).value).toBe("已售罄");
    expect(dishSheet.getRow(3).getCell(8).value).toContain("售罄原因：晚市售罄");
    // 缺失单价/小计展示 —（绝不把空值折算成 0.00）
    expect(dishSheet.getRow(3).getCell(6).value).toBe("—");
    expect(dishSheet.getRow(3).getCell(7).value).toBe("—");
    const attachmentSheet = workbook.getWorksheet("附件清单");
    const attachmentText = [];
    for (let row = 1; row <= attachmentSheet.rowCount; row += 1) for (let column = 1; column <= 4; column += 1) attachmentText.push(String(attachmentSheet.getRow(row).getCell(column).value ?? ""));
    expect(attachmentText.join("\n")).toContain("题目证据（照片）");
    expect(attachmentText.join("\n")).toContain("消费小票");
    // 仅元数据：不含存储密钥/签名 URL
    expect(attachmentText.join("\n")).not.toMatch(/storage|http|signature/);
  });

  it("prints one page wide with auto page breaks and a repeated table header", async () => {
    const workbook = await workbookOf(buildModel());
    const sheet = workbook.getWorksheet("暗访评估表");
    expect(sheet.pageSetup.orientation).toBe("portrait");
    expect(sheet.pageSetup.fitToPage).toBe(true);
    expect(sheet.pageSetup.fitToWidth).toBe(1);
    expect(sheet.pageSetup.fitToHeight).toBe(0); // 纵向自动分页，不强制两页塞下
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    expect(sheet.pageSetup.printTitlesRow).toBe(`${headerRow}:${headerRow}`);
  });

  it("names the file by store/inspector/date/short submission id with safe characters", () => {
    const model = buildModel();
    expect(buildSubmissionExportFileName(model)).toBe("暗访评估_静态测试门店_测试探店员_2026-10-09_aaaaaaaa.xlsx");
    const odd = buildModel({ submission: { store_name: '危险/门店:名*称?', inspector_name: "  ", visit_at: null, submitted_at: new Date("2026-01-02T16:03:00Z"), id: "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb" } });
    expect(buildSubmissionExportFileName(odd)).toBe("暗访评估_危险 门店 名 称_未知探店员_2026-01-03_bbbbbbbb.xlsx");
  });
});

describe("submission export model reconciliation", () => {
  // 失败必须带稳定错误码（worker 落 failure_code 供排查），而非含糊的空文件
  const expectErrorCode = (fn, code) => {
    try { fn(); } catch (error) { expect(error.code).toBe(code); return; }
    throw new Error("expected the model builder to throw");
  };
  it("rejects inconsistent scoring data instead of exporting fake totals", () => {
    expectErrorCode(() => buildSubmissionExportModel({ submission: baseSubmission({ total_score: 1 }), scoreRows: baseScoreRows() }), EXPORT_SUBMISSION_SCORES_MISSING);
    expectErrorCode(() => buildModel({ submission: { max_score: 12 } }), EXPORT_SUBMISSION_SCORES_MISSING);
    expectErrorCode(() => buildSubmissionExportModel({ submission: baseSubmission(), scoreRows: [] }), EXPORT_SUBMISSION_SCORES_MISSING);
  });

  it("keeps positive out-of-category residual scores as an explicit adjustment note", async () => {
    // 停用题残留作答：total 比启用题分类合计多 3，对账行显式说明而非静默吞掉
    const model = buildModel({ submission: { total_score: 5 } });
    expect(model.totals.deltaAwarded).toBe(3);
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    expect(sheetText(sheet)).toContain("分类外历史得分调整 +3");
    // 总评仍展示权威提交总分 5（含分类外 3 分），而非分类合计 2
    const totalRow = findRowByFirstCell(sheet, "总评");
    expect(sheet.getRow(totalRow).getCell(3).value).toBe(5);
  });
});

describe("historical score reconstruction", () => {
  it("replays submit-time scoring (including wipe) from immutable snapshots", () => {
    const questions = [
      { id: questionId(1), question_key: "k1", question_number: 1, category: "env", text: "清零题", max_score: 5, is_score_wipe: true },
      { id: questionId(2), question_key: "k2", question_number: 2, category: "env", text: "普通题", max_score: 5, is_score_wipe: false },
    ];
    const answers = [
      { question_id: questionId(1), answer: "unscored", awarded_score: 0, issue_remark: "过期食材" },
      { question_id: questionId(2), answer: "scored", awarded_score: 5, issue_remark: "" },
    ];
    const rows = reconstructScoreRows(questions, answers);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ answer: "unscored", awarded_score: 0, max_score: 5, is_score_wipe: true });
    // 普通题原始作答 scored/5 被清零为 0，与提交时口径一致
    expect(rows[1]).toMatchObject({ answer: "scored", awarded_score: 0, max_score: 5 });
    const model = buildSubmissionExportModel({
      submission: baseSubmission({ total_score: 0, max_score: 10, issue_count: 1, other_snapshot_json: { highlight: "服务佳", suggestion: "无" } }),
      scoreRows: rows, scoreSource: "reconstructed", remarks: Object.fromEntries(answers.map((answer) => [answer.question_id, answer.issue_remark])),
    });
    expect(model.categories[0]).toMatchObject({ wiped: true, sumAwarded: 0, sumDeduction: 10 });
    expect(model.meta.scoreSource).toBe("reconstructed");
  });

  it("keeps enabled-only scope and lets residual disabled answers surface as reconciliation delta", () => {
    const questions = [{ id: questionId(1), question_key: "k1", question_number: 1, category: "env", text: "启用题", max_score: 5, is_score_wipe: false }];
    const answers = [
      { question_id: questionId(1), answer: "scored", awarded_score: 5, issue_remark: "" },
      { question_id: questionId(9), answer: "scored", awarded_score: 3, issue_remark: "" }, // 停用题残留
    ];
    const rows = reconstructScoreRows(questions, answers);
    expect(rows).toHaveLength(1);
    const model = buildSubmissionExportModel({ submission: baseSubmission({ total_score: 8, max_score: 5 }), scoreRows: rows, scoreSource: "reconstructed" });
    expect(model.totals).toMatchObject({ sumAwarded: 5, deltaAwarded: 3 });
  });
});

describe("shanghai time formatting", () => {
  it("converts UTC instants to Asia/Shanghai and rejects invalid values", () => {
    expect(formatShanghaiDateTime(new Date("2026-10-09T16:05:00Z"))).toBe("2026-10-10 00:05"); // 跨日归上海日期
    expect(formatShanghaiDateTime(new Date("2026-10-09T15:59:00Z"))).toBe("2026-10-09 23:59");
    expect(formatShanghaiDateTime(null)).toBeNull();
    expect(formatShanghaiDateTime(new Date("not-a-date"))).toBeNull();
  });
});

describe("snapshot validation for historical reconstruction", () => {
  // 复核复现用例：启用题 a/b 各满分 5，快照只有 a 的作答——绝不允许把 b 默认成“得分”
  const questions = [
    { id: "q-a", question_key: "ka", question_number: 1, category: "env", text: "题A", max_score: 5, is_score_wipe: false },
    { id: "q-b", question_key: "kb", question_number: 2, category: "env", text: "题B", max_score: 5, is_score_wipe: false },
  ];
  const expectScoresMissing = (fn) => {
    try { fn(); } catch (error) { expect(error.code).toBe(EXPORT_SUBMISSION_SCORES_MISSING); return; }
    throw new Error("expected reconstruction to fail closed");
  };

  it("fails when a required enabled question has no saved answer", () => {
    expectScoresMissing(() => reconstructScoreRows(questions, [{ question_id: "q-a", answer: "unscored", awarded_score: 0 }]));
  });

  it("fails on invalid answer values and invalid awarded scores", () => {
    expectScoresMissing(() => reconstructScoreRows(questions, [
      { question_id: "q-a", answer: "scored", awarded_score: 5 },
      { question_id: "q-b", answer: "maybe", awarded_score: 5 },
    ]));
    expectScoresMissing(() => reconstructScoreRows(questions, [
      { question_id: "q-a", answer: "scored", awarded_score: 5 },
      { question_id: "q-b", answer: "scored", awarded_score: -1 },
    ]));
    expectScoresMissing(() => reconstructScoreRows(questions, [
      { question_id: "q-a", answer: "scored", awarded_score: 5 },
      { question_id: "q-b", answer: "scored", awarded_score: 2.5 },
    ]));
    expectScoresMissing(() => reconstructScoreRows(questions, [
      { question_id: "q-a", answer: "scored", awarded_score: 5 },
      { question_id: "q-b", answer: "unscored", awarded_score: 6 }, // 超过满分
    ]));
    expectScoresMissing(() => reconstructScoreRows(questions, [
      { question_id: "q-a", answer: "scored", awarded_score: 5 },
      { question_id: "q-b", answer: "unscored" }, // 缺分值
    ]));
  });

  it("rejects null/empty/boolean awarded scores instead of coercing them to zero/one", () => {
    // 复核复现：awarded_score null + expectedTotalScore 0 绝不允许产出“成功”的零分行
    for (const awarded_score of [null, "", false, true]) {
      expectScoresMissing(() => reconstructScoreRows(
        [{ id: "q-a", question_key: "ka", question_number: 1, category: "env", text: "题A", max_score: 5, is_score_wipe: false }],
        [{ question_id: "q-a", answer: "unscored", awarded_score }],
        { expectedTotalScore: 0 },
      ));
    }
    // 合法保存的 JSON 整数不受影响
    expect(() => reconstructScoreRows(
      [{ id: "q-a", question_key: "ka", question_number: 1, category: "env", text: "题A", max_score: 5, is_score_wipe: false }],
      [{ question_id: "q-a", answer: "scored", awarded_score: 5 }],
      { expectedTotalScore: 5 },
    )).not.toThrow();
  });

  it("fails on duplicate answers for the same enabled question and on non-array snapshots", () => {
    expectScoresMissing(() => reconstructScoreRows(questions, [
      { question_id: "q-a", answer: "scored", awarded_score: 5 },
      { question_id: "q-a", answer: "scored", awarded_score: 5 },
      { question_id: "q-b", answer: "scored", awarded_score: 5 },
    ]));
    expectScoresMissing(() => reconstructScoreRows(questions, "corrupt"));
    expectScoresMissing(() => reconstructScoreRows(questions, null));
  });

  it("replays a complete valid snapshot with wipe semantics and real category display names", () => {
    const wipeQuestions = [
      { id: "w1", question_key: "w1", question_number: 1, category: "env", text: "清零题", max_score: 5, is_score_wipe: true },
      { id: "w2", question_key: "w2", question_number: 2, category: "env", text: "普通题", max_score: 5, is_score_wipe: false },
      { id: "s1", question_key: "s1", question_number: 3, category: "svc", text: "服务题", max_score: 6, is_score_wipe: false },
    ];
    const answers = [
      { question_id: "w1", answer: "unscored", awarded_score: 0 },
      { question_id: "w2", answer: "scored", awarded_score: 5 },
      { question_id: "s1", answer: "scored", awarded_score: 6 },
    ];
    const rows = reconstructScoreRows(wipeQuestions, answers, { categoryNames: new Map([["env", "环境卫生"], ["svc", "为客服务"]]) });
    expect(rows.map((row) => [row.category_name, row.answer, row.awarded_score])).toEqual([
      ["环境卫生", "unscored", 0],
      ["环境卫生", "scored", 0], // 清零：原答对也被按 0 分计
      ["为客服务", "scored", 6],
    ]);
    // 快照重放总分与提交落库一致时才允许重建
    expect(() => reconstructScoreRows(wipeQuestions, answers, { expectedTotalScore: 6 })).not.toThrow();
    expectScoresMissing(() => reconstructScoreRows(wipeQuestions, answers, { expectedTotalScore: 11 }));
  });
});

describe("long explanation layout", () => {
  it("splits a 20-deduction category with long remarks into bounded rows without text loss", async () => {
    const remark = "实际问题说明".repeat(40); // 280 字
    const scoreRows = Array.from({ length: 20 }, (_, index) => scoreRow(index + 1, { category: "env-x", text: `检查题${index + 1}`, answer: "unscored", awarded: 0, max: 5, categoryName: "环境卫生" }));
    const model = buildSubmissionExportModel({
      submission: baseSubmission({ total_score: 0, max_score: 100, issue_count: 20 }),
      scoreRows,
      remarks: Object.fromEntries(scoreRows.map((row) => [row.question_id, remark])),
    });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    // 任何一行都不超过 Excel 行高上限（409.5 磅），杜绝整块被裁剪
    for (let row = 1; row <= sheet.rowCount; row += 1) expect(sheet.getRow(row).height ?? 20).toBeLessThanOrEqual(400);
    const values = cellValues(sheet);
    // 每条扣分说明按单行长度拆成连续格子，拼回后与原文逐字一致（跨引擎可见、零截断）
    for (let n = 1; n <= 20; n += 1) {
      const fullLine = `第 ${n} 题「检查题${n}」扣 5 分——探员备注：${remark}。`;
      const start = values.findIndex((value) => value.startsWith(`第 ${n} 题「检查题${n}」扣 5 分`));
      expect(start).toBeGreaterThanOrEqual(0);
      const segments = [];
      for (let index = start; index < values.length; index += 1) {
        segments.push(values[index]);
        if (values[index].endsWith("。")) break;
      }
      expect(segments.join("")).toBe(fullLine);
      expect(Math.max(...segments.map((segment) => segment.length))).toBeLessThanOrEqual(44);
    }
  });

  it("hard-splits a single extreme remark across continuation cells with zero loss", async () => {
    const megaRemark = "超长备注".repeat(500); // 2000 字
    const model = buildModel({
      scoreRows: [scoreRow(1, { category: "env-x", text: "检查题", answer: "unscored", awarded: 0, max: 10, categoryName: "环境卫生" })],
      submission: { total_score: 0, max_score: 10, issue_count: 1 },
      remarks: { [questionId(1)]: megaRemark },
    });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    for (let row = 1; row <= sheet.rowCount; row += 1) expect(sheet.getRow(row).height ?? 20).toBeLessThanOrEqual(400);
    const values = cellValues(sheet);
    const fullLine = `第 1 题「检查题」扣 10 分——探员备注：${megaRemark}。`;
    const start = values.findIndex((value) => value.startsWith("第 1 题「检查题」扣 10 分"));
    expect(start).toBeGreaterThanOrEqual(0);
    // 说明被拆到多个续行格子，拼回后与原文逐字一致
    const segments = [];
    for (let index = start; index < values.length; index += 1) {
      segments.push(values[index]);
      if (values[index].endsWith("。")) break;
    }
    expect(segments.join("")).toBe(fullLine);
    expect(segments.every((segment) => segment.length <= 380)).toBe(true);
  });
});

describe("question continuation layout", () => {
  it("anchors answer/deduction styling on the FIRST question row when long text spans continuation rows", async () => {
    const longText = "门店服务标准检查条目内容较长，".repeat(50); // 750 字符 > 单行容量 572 → 拆两段
    const model = buildModel({
      scoreRows: [scoreRow(1, { category: "env-x", text: longText, answer: "unscored", awarded: 0, max: 5, categoryName: "环境卫生" })],
      submission: { total_score: 0, max_score: 5, issue_count: 1 },
      remarks: { [questionId(1)]: "长题干不得分" },
    });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    const firstRow = headerRow + 1;
    const secondRow = firstRow + 1;
    // 数值与答案在首行且红字/居中样式正确
    expect(sheet.getRow(firstRow).getCell(2).value).toBe(1);
    expect(sheet.getRow(firstRow).getCell(4).value).toBe("不得分");
    expect(sheet.getRow(firstRow).getCell(4).font.color.argb).toBe("FFC00000");
    expect(sheet.getRow(firstRow).getCell(6).value).toBe(5);
    expect(sheet.getRow(firstRow).getCell(6).font.color.argb).toBe("FFC00000");
    for (const column of [2, 4, 6]) expect(sheet.getRow(firstRow).getCell(column).alignment.horizontal).toBe("center");
    // 题干分段零丢失：首行 + 续行拼回原文
    expect(String(sheet.getRow(firstRow).getCell(3).value) + String(sheet.getRow(secondRow).getCell(3).value)).toBe(longText);
    // 续行不再重复数值/答案
    expect(sheet.getRow(secondRow).getCell(2).value ?? null).toBeNull();
    expect(sheet.getRow(secondRow).getCell(4).value ?? null).toBeNull();
    expect(sheet.getRow(secondRow).getCell(6).value ?? null).toBeNull();
  });
});

describe("long metadata wrapping", () => {
  it("wraps long title/info values/category names with sufficient row heights", async () => {
    const longQuestionnaire = "超长问卷名称用于验证标题换行".repeat(6);
    const longStore = "门店名称特别长的大型购物中心分店名称测试".repeat(2);
    const longTask = "任务名称很长很长".repeat(8);
    const longCategory = "售后服务与客户关怀体验评估分类";
    const model = buildSubmissionExportModel({
      submission: baseSubmission({ questionnaire_name: longQuestionnaire, store_name: longStore, task_name: longTask, total_score: 5, max_score: 5, issue_count: 0 }),
      scoreRows: [scoreRow(1, { category: "svc-long", text: "短题目", awarded: 5, max: 5, categoryName: longCategory })],
    });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    // 标题：换行 + 行高覆盖 15pt 字号的多行标题
    expect(sheet.getCell("A1").alignment.wrapText).toBe(true);
    const titleLines = Math.ceil(String(sheet.getCell("A1").value).length / 44);
    expect(sheet.getRow(1).height).toBeGreaterThanOrEqual(titleLines * 20);
    // 信息行：值单元格可换行，行高覆盖最长值（任务名称在 E:G，约 12 字/行）
    expect(sheet.getCell("B4").alignment.wrapText).toBe(true);
    expect(sheet.getCell("E4").alignment.wrapText).toBe(true);
    expect(sheet.getRow(4).height).toBeGreaterThanOrEqual(Math.ceil(longTask.length / 12) * 15);
    // 分类成绩块：长分类名换行且行高覆盖（A 列约 6 字/行）
    const scoreHeaderRow = findRowByFirstCell(sheet, "分类成绩");
    expect(sheet.getCell(`A${scoreHeaderRow + 1}`).alignment.wrapText).toBe(true);
    expect(sheet.getRow(scoreHeaderRow + 1).height).toBeGreaterThanOrEqual(Math.ceil(longCategory.length / 6) * 15);
    // 表体：单题分类的合并 A 标签所在首行行高足以容纳长分类名
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    expect(sheet.getRow(headerRow + 1).getCell(1).value).toBe(longCategory);
    expect(sheet.getRow(headerRow + 1).height).toBeGreaterThanOrEqual(Math.ceil(longCategory.length / 6) * 15);
  });
});

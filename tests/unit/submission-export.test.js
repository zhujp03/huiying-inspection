import { describe, expect, it } from "vitest";
import ExcelJS, { ValueType } from "exceljs";
import {
  assignCategoryLetters, buildSubmissionExportFileName, buildSubmissionExportModel, buildSubmissionWorkbook,
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
  scoreRow(1, { category: "product", text: "环境检查题", awarded: 2, max: 5, categoryName: "产品品质" }),
  scoreRow(2, { category: "service", text: "服务检查题", answer: "unscored", awarded: 0, max: 5, categoryName: "为客服务" }),
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
const sheetText = (sheet, columns = 11) => {
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
const cellValues = (sheet, columns = 11) => {
  const values = [];
  for (let row = 1; row <= sheet.rowCount; row += 1) for (let column = 1; column <= columns; column += 1) {
    const cell = sheet.getRow(row).getCell(column);
    if (cell.type === ValueType.Merge) continue;
    const value = cell.value;
    if (value !== null && value !== undefined && value !== "") values.push(String(value));
  }
  return values;
};
// 按首列文本定位行号（避免把行号写死进断言）
const findRowByFirstCell = (sheet, value) => {
  for (let row = 1; row <= sheet.rowCount; row += 1) if (sheet.getRow(row).getCell(1).value === value) return row;
  return -1;
};
const findRowContaining = (sheet, needle, column) => {
  for (let row = 1; row <= sheet.rowCount; row += 1) if (String(sheet.getRow(row).getCell(column).value ?? "").includes(needle)) return row;
  return -1;
};

describe("submission export workbook", () => {
  it("renders template header, compact score matrix and reconciled totals", async () => {
    const model = buildModel();
    const workbook = await workbookOf(model);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["暗访评估表", "作答明细"]);
    const sheet = workbook.getWorksheet("暗访评估表");
    // 标题 = 参考模板标题 + 实际问卷名与版本
    expect(sheet.getCell("A1").value).toBe("神秘顾客暗访评估表（暗访问卷·V3）");
    expect(sheet.getCell("A1").font.size).toBe(16);
    // 信息行：品牌/门店（行3）+ 暗访日期/暗访时段（行5）；值带参考模板下划线
    expect(sheet.getCell("A3").value).toBe("品牌名称：");
    expect(sheet.getCell("B3").value).toBe("测试品牌");
    expect(sheet.getCell("E3").value).toBe("门店名称：");
    expect(sheet.getCell("F3").value).toBe("静态测试门店");
    expect(sheet.getCell("A5").value).toBe("暗访日期：");
    expect(sheet.getCell("B5").value).toBe("2026-10-09"); // UTC 03:00 → 上海 11:00 的打卡日期
    expect(sheet.getCell("E5").value).toBe("暗访时段：");
    expect(sheet.getCell("F5").value).toBe("11:00"); // 打卡时刻，绝不臆测「午餐/晚餐」
    expect(sheet.getCell("B3").border.bottom.style).toBe("thin");
    expect(sheet.getCell("F3").border.bottom.style).toBe("thin");
    // 右上分项成绩/总评矩阵：2 分类右对齐（矩阵起点 I 列），表头「分项成绩」随真实宽度合并
    expect(sheet.getCell("I3").value).toBe("分项成绩");
    expect(sheet.getCell("K3").value).toBe("总评");
    expect(sheet.getCell("I4").value).toBe("Q");
    expect(sheet.getCell("J4").value).toBe("S");
    expect(sheet.getCell("I5").value).toBe(40);
    expect(sheet.getCell("J5").value).toBe(0);
    expect(sheet.getCell("K4").value).toBe(70); // 权威 total/max = 7/10 → 70（百分制）
    expect(sheet.getCell("K4").fill.fgColor.argb).toBe("FFFCE4D6"); // 参考模板浅桃总评
    expect(sheet.getCell("K4").font.color.argb).toBe("FFFF0000"); // 总评红字
    expect(sheet.getCell("I5").fill.fgColor.argb).toBe("FFFFFFCC"); // 分类浅黄
    // 参考模板边框口径：标题/信息标签完全无边框，信息值只有下边框；矩阵行高 20
    expect(sheet.getCell("A1").border?.top?.style).toBeUndefined();
    expect(sheet.getCell("A3").border?.bottom?.style).toBeUndefined();
    expect(sheet.getCell("A3").border?.left?.style).toBeUndefined();
    expect(sheet.getCell("E3").border?.bottom?.style).toBeUndefined();
    expect(sheet.getCell("B3").border.bottom.style).toBe("thin");
    expect(sheet.getCell("B3").border.top?.style).toBeUndefined();
    expect(sheet.getCell("B3").border.left?.style).toBeUndefined();
    expect(sheet.getCell("B3").border.right?.style).toBeUndefined();
    expect(sheet.getCell("F5").border.bottom.style).toBe("thin");
    expect(sheet.getCell("F5").border.top?.style).toBeUndefined();
    expect(sheet.getCell("B3").font.size).toBe(11);
    expect(sheet.getCell("F3").font.size).toBe(11);
    expect(sheet.getCell("A3").font.size).toBe(11);
    expect(sheet.getRow(4).height).toBe(20);
  });

  it("renders the six-column assessment table with merged category labels, subtotals and deduction colors", async () => {
    const model = buildModel();
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    // 逻辑六列：A 维度 / B 序号 / C:H 评估说明（合并）/ I 分值 / J 扣分 / K 得分；不再有探员答案列
    expect(sheet.getRow(headerRow).getCell(1).value).toBe("评估维度");
    expect(sheet.getRow(headerRow).getCell(2).value).toBe("序号");
    expect(sheet.getRow(headerRow).getCell(3).value).toBe("评估说明");
    expect(sheet.getRow(headerRow).getCell(9).value).toBe("分值");
    expect(sheet.getRow(headerRow).getCell(10).value).toBe("扣分");
    expect(sheet.getRow(headerRow).getCell(11).value).toBe("得分");
    expect(sheet.getRow(headerRow).getCell(4).type).toBe(ValueType.Merge); // C:H 合并表头
    expect(sheet.getRow(headerRow).getCell(1).fill.fgColor.argb).toBe("FFCCFFCC"); // 参考模板表头绿
    // 网格宽度对标参考模板 A:K
    expect(sheet.getColumn(1).width).toBe(11.7);
    expect(sheet.getColumn(2).width).toBe(6.7);
    expect(sheet.getColumn(11).width).toBe(8.8);
    // 题目行：A=Q-产品品质（首行），B=Q1（分类内重置编号），J 扣分红字
    const q1Row = headerRow + 1;
    expect(sheet.getRow(q1Row).getCell(1).value).toBe("Q-产品品质");
    expect(sheet.getRow(q1Row).getCell(2).value).toBe("Q1");
    expect(sheet.getRow(q1Row).getCell(3).value).toBe("环境检查题");
    expect(sheet.getRow(q1Row).getCell(9).value).toBe(5);
    expect(sheet.getRow(q1Row).getCell(10).value).toBe(3);
    expect(sheet.getRow(q1Row).getCell(10).font.color.argb).toBe("FFFF0000");
    expect(sheet.getRow(q1Row).getCell(11).value).toBe(2);
    // 分类小计行：浅黄底、字母小计、权威逐题合计
    const subtotalRow = q1Row + 1;
    expect(sheet.getRow(subtotalRow).getCell(2).value).toBe("Q小计");
    expect(sheet.getRow(subtotalRow).getCell(2).fill.fgColor.argb).toBe("FFFFFFCC");
    expect(sheet.getRow(subtotalRow).getCell(9).value).toBe(5);
    expect(sheet.getRow(subtotalRow).getCell(10).value).toBe(3);
    expect(sheet.getRow(subtotalRow).getCell(11).value).toBe(2);
    // 分类标签纵向合并贯穿题目区与小计行
    expect(sheet.getCell(q1Row, 1).isMerged).toBe(true);
    // 扣分说明块：A=Q-扣分说明、B=题号、C:K=探员原始备注（蓝色）；块保留 3 行
    const explanationRow = subtotalRow + 1;
    expect(sheet.getRow(explanationRow).getCell(1).value).toBe("Q-扣分说明");
    expect(sheet.getRow(explanationRow).getCell(2).value).toBe("Q1");
    expect(String(sheet.getRow(explanationRow).getCell(3).value)).toContain("扣 3 分");
    expect(sheet.getRow(explanationRow + 2).getCell(3).value ?? null).toBeNull(); // 保留空白行
    // 第二分类：不得分题扣分红字；小计后进入 S-扣分说明，探员备注蓝色原样展示
    const svcLabelRow = explanationRow + 3;
    expect(sheet.getRow(svcLabelRow).getCell(1).value).toBe("S-为客服务");
    expect(sheet.getRow(svcLabelRow).getCell(2).value).toBe("S1");
    expect(sheet.getRow(svcLabelRow).getCell(10).value).toBe(5);
    expect(sheet.getRow(svcLabelRow).getCell(10).font.color.argb).toBe("FFFF0000");
    expect(sheet.getRow(svcLabelRow + 1).getCell(2).value).toBe("S小计");
    const remarkRow = svcLabelRow + 2; // S 小计后进入 S-扣分说明
    expect(sheet.getRow(remarkRow).getCell(1).value).toBe("S-扣分说明");
    expect(sheet.getRow(remarkRow).getCell(2).value).toBe("S1");
    expect(sheet.getRow(remarkRow).getCell(3).value).toBe("迎宾不及时");
    expect(sheet.getRow(remarkRow).getCell(3).font.color.argb).toBe("FF0070C0"); // 探员原始备注蓝色
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
    expect(joined).toContain("清零：A1「环境卫生清零题」被判不得分"); // 触发题用导出表内可见的分类编号
    // 说明按单行长度分段成格，拼接后语义完整
    expect(joined.replace(/\n/g, "")).toContain("清零前合计 5 分不计");
    expect(joined).toContain("此大项分数直接清零");
    // 清零触发说明行红字；探员原始备注蓝色展示
    expect(wipeFont.color.argb).toBe("FFFF0000");
    expect(joined).toContain("发现过期食材");
    const remarkCellRow = findRowContaining(sheet, "发现过期食材", 3);
    expect(sheet.getRow(remarkCellRow).getCell(3).font.color.argb).toBe("FF0070C0");
  });

  it("shows the static wipe rule only when the questionnaire really configures a wipe question", async () => {
    // 未触发清零：仅展示静态规则说明（来自真实 is_score_wipe 配置，不臆测触发结果）
    const model = buildModel({
      scoreRows: [
        scoreRow(1, { category: "product", text: "普通题一", awarded: 5, max: 5, wipe: true, categoryName: "产品品质" }),
        scoreRow(2, { category: "service", text: "服务题", awarded: 2, max: 5, categoryName: "为客服务" }),
      ],
      submission: { total_score: 7, max_score: 10, issue_count: 0 },
    });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    const joined = sheetText(sheet);
    expect(joined).toContain("Q1 被判不得分时，此大项分数直接清零"); // product → Q1，可见编号
    expect(joined).not.toContain("清零：Q1");
    // 无清零题配置的分类：完全没有清零文案
    const noWipeModel = buildModel({
      scoreRows: [scoreRow(1, { category: "product", text: "普通题一", awarded: 5, max: 5, categoryName: "产品品质" })],
      submission: { total_score: 5, max_score: 5, issue_count: 0 },
    });
    const noWipeWorkbook = await workbookOf(noWipeModel);
    expect(sheetText(noWipeWorkbook.getWorksheet("暗访评估表"))).not.toContain("清零");
  });

  it("assigns deterministic non-conflicting letters: known Q/S/C mapping, custom categories get unused letters", () => {
    expect(assignCategoryLetters([
      { code: "service" }, { code: "custom-a" }, { code: "product" }, { code: "environment" }, { code: "custom-b" },
    ])).toEqual(["S", "A", "Q", "C", "B"]); // product/service/environment 固定 Q/S/C；自定义按字母表顺延且不冲突
    expect(assignCategoryLetters([{ code: "custom-1" }, { code: "custom-2" }])).toEqual(["A", "B"]);
    // 反例回归：自定义分类先出现时，后到的已知分类仍拿固定字母（environment 永远是 C），
    // 自定义分类让位改取其他未用字母——确定性且无冲突
    expect(assignCategoryLetters([
      { code: "custom1" }, { code: "custom2" }, { code: "custom3" }, { code: "environment" }, { code: "product" }, { code: "service" },
    ])).toEqual(["A", "B", "D", "C", "Q", "S"]);
  });

  it("supports arbitrary category names and counts without assuming fixed three categories", async () => {
    const scoreRows = [
      scoreRow(1, { category: "night-x", text: "夜场题一", awarded: 4, max: 4, categoryName: "夜场运营" }),
      scoreRow(2, { category: "special-x", text: "特殊题一", awarded: 3, max: 6, categoryName: "专项检查" }),
      scoreRow(3, { category: "special-x", text: "特殊题二", awarded: 0, max: 2, answer: "unscored", categoryName: "专项检查" }),
    ];
    const model = buildSubmissionExportModel({ submission: baseSubmission({ total_score: 7, max_score: 12, issue_count: 1 }), scoreRows });
    expect(model.categories.map((category) => category.name)).toEqual(["夜场运营", "专项检查"]);
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    // 多题分类的标签纵向合并：续行 A 列无独立值；编号按分类字母重置
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    expect(sheet.getRow(headerRow + 1).getCell(1).value).toBe("A-夜场运营");
    expect(sheet.getRow(headerRow + 1).getCell(2).value).toBe("A1");
    const specialFirstRow = headerRow + 6; // 夜场 1 题 + 小计 + 3 行扣分说明块之后
    expect(sheet.getRow(specialFirstRow).getCell(1).value).toBe("B-专项检查");
    expect(sheet.getRow(specialFirstRow).getCell(2).value).toBe("B1");
    expect(sheet.getRow(specialFirstRow + 1).getCell(2).value).toBe("B2");
    expect(sheet.getRow(specialFirstRow + 1).getCell(1).type).toBe(ValueType.Merge); // 纵向合并的续行
    const values = cellValues(sheet);
    expect(values).toContain("A小计");
    expect(values).toContain("B小计");
    // 矩阵：2 分类右对齐 I:J，总评为权威 58%（7/12）
    expect(sheet.getCell("I4").value).toBe("A");
    expect(sheet.getCell("J4").value).toBe("B");
    expect(sheet.getCell("I5").value).toBe(100); // 夜场 4/4
    expect(sheet.getCell("J5").value).toBe(38); // 专项 3/8
    expect(sheet.getCell("K4").value).toBe(58);
    const joined = sheetText(sheet);
    expect(joined).not.toMatch(/西部马华/); // 绝无参考样例的真实门店/品牌数据
  });

  it("maps the known questionnaire categories onto the reference Q/S/C letters", async () => {
    const workbook = await workbookOf(buildModel());
    const sheet = workbook.getWorksheet("暗访评估表");
    expect(sheet.getCell("I4").value).toBe("Q"); // product → Q
    expect(sheet.getCell("J4").value).toBe("S"); // service → S
  });

  it("widens the matrix header and outline to the real width when there are more than three categories", async () => {
    const scoreRows = ["a-x", "b-x", "c-x", "d-x", "e-x"].map((category, index) => scoreRow(index + 1, { category, text: `分类题${index + 1}`, awarded: 5, max: 5, categoryName: `分类${index + 1}` }));
    const model = buildSubmissionExportModel({ submission: baseSubmission({ total_score: 25, max_score: 25, issue_count: 0 }), scoreRows });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    // 5 分类：矩阵两排（G:J + J），表头「分项成绩」合并与外沿描边都从 G 起，不再固定 H
    expect(sheet.getCell("G3").value).toBe("分项成绩");
    expect(sheet.getCell("G3").border.left.style).toBe("medium");
    expect(sheet.getCell("G4").value).toBe("A");
    expect(sheet.getCell("J4").value).toBe("D");
    expect(sheet.getCell("J6").value).toBe("E");
    expect(sheet.getCell("G5").value).toBe(100);
    expect(sheet.getCell("J7").value).toBe(100);
    expect(sheet.getCell("K4").value).toBe(100);
  });

  it("falls back to the raw category code when the category name is unavailable", () => {
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
    // 矩阵值：2 分类右对齐 I:J；0 满分分类得率为 —；另一分类 70
    expect(sheet.getCell("I4").value).toBe("A");
    expect(sheet.getCell("J4").value).toBe("B");
    expect(sheet.getCell("I5").value).toBe("—");
    expect(sheet.getCell("J5").value).toBe(70);
  });

  it("keeps short questions at reference 20pt and splits long text across continuation rows without clipping", async () => {
    const longText = "营业时间内菜单菜品均正常供应，收银、传菜、迎宾与保洁等各岗位服务动作保持标准，".repeat(3);
    const model = buildModel({
      scoreRows: [
        scoreRow(1, { category: "env-x", text: "短题干检查题", awarded: 7, max: 10 }),
        scoreRow(2, { category: "svc-x", text: longText, awarded: 3, max: 5 }),
      ],
      submission: { total_score: 10, max_score: 15, issue_count: 0 },
    });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    // 参考模板密度：常规短题单行 20 磅，不再被双重保守系数抬高
    expect(sheet.getRow(headerRow + 1).height).toBe(20);
    expect(sheet.getRow(headerRow + 1).getCell(3).alignment.wrapText).toBe(true);
    // 长题干按 30 字切段续行：每行 20 磅、全部 ≤ 上限，拼接后与原文逐字一致（零截断、可读）
    let joined = "";
    for (let currentRow = findRowContaining(sheet, "营业时间内", 3); ; currentRow += 1) {
      const segment = String(sheet.getRow(currentRow).getCell(3).value ?? "");
      if (!segment) break;
      joined += segment;
      const height = sheet.getRow(currentRow).height ?? 20;
      expect(height).toBeGreaterThanOrEqual(20);
      expect(height).toBeLessThanOrEqual(400);
    }
    expect(joined).toBe(longText);
    // 小计行高固定 20（参考模板）
    const subtotalRow = [...Array(sheet.rowCount).keys()].map((index) => index + 1).find((row) => sheet.getRow(row).getCell(2).value === "A小计");
    expect(sheet.getRow(subtotalRow).height).toBe(20);
  });

  it("keeps the inspector answer labels and remarks on the supplemental answer sheet", async () => {
    const workbook = await workbookOf(buildModel());
    const answerSheet = workbook.getWorksheet("作答明细");
    const text = sheetText(answerSheet, 6);
    expect(text).toContain("得分"); // scored 题答案标签
    expect(text).toContain("不得分"); // unscored 题答案标签
    expect(text).toContain("迎宾不及时"); // 探员原始备注完整保留
    expect(text).toContain("S-为客服务");
    expect(text).toContain("S1");
    // 每道题都有答案标签行
    const rows = [];
    for (let row = 2; row <= answerSheet.rowCount; row += 1) rows.push(answerSheet.getRow(row).getCell(2).value);
    expect(rows).toEqual(["Q1", "S1"]);
  });

  it("splits long question text and remarks on the answer sheet into bounded continuation rows", async () => {
    const longText = "门店服务标准检查条目内容较长，".repeat(12); // 168 字 → 多段
    const longRemark = "超长探员备注说明".repeat(30); // 240 字 → 多段
    const model = buildModel({
      scoreRows: [scoreRow(1, { category: "env-x", text: longText, answer: "unscored", awarded: 0, max: 5, categoryName: "环境卫生" })],
      submission: { total_score: 0, max_score: 5, issue_count: 1 },
      remarks: { [questionId(1)]: longRemark },
    });
    const workbook = await workbookOf(model);
    const answerSheet = workbook.getWorksheet("作答明细");
    let joinedText = "";
    let joinedRemark = "";
    for (let row = 2; row <= answerSheet.rowCount; row += 1) {
      const height = answerSheet.getRow(row).height ?? 20;
      expect(height).toBeGreaterThanOrEqual(20);
      expect(height).toBeLessThanOrEqual(400); // 单行高上限，杜绝截断
      joinedText += String(answerSheet.getRow(row).getCell(3).value ?? "");
      joinedRemark += String(answerSheet.getRow(row).getCell(6).value ?? "");
    }
    expect(joinedText).toBe(longText); // 题干零丢失
    expect(joinedRemark).toBe(longRemark); // 备注零丢失
    // 数值只在首行
    expect(answerSheet.getRow(2).getCell(4).value).toBe("不得分");
    expect(answerSheet.getRow(2).getCell(5).value).toBe(5);
    expect(answerSheet.getRow(3).getCell(4).value ?? null).toBeNull();
  });

  it("sizes answer-sheet rows from EVERY wrapped cell (short question + long packed remark)", async () => {
    // 回归：行高曾只按题干段计算，较窄的备注列换行更多行被行高截断（首尾不可见）
    const longRemark = "合成演示超长备注：该题干现场情况说明特别长，".repeat(4); // 132 字，打包进单个备注格需多行
    const model = buildModel({
      scoreRows: [scoreRow(1, { category: "env-x", text: "短题干", awarded: 0, max: 5, categoryName: "环境卫生" })],
      submission: { total_score: 0, max_score: 5, issue_count: 1 },
      remarks: { [questionId(1)]: longRemark },
    });
    const workbook = await workbookOf(model);
    const answerSheet = workbook.getWorksheet("作答明细");
    const remarkCell = String(answerSheet.getRow(2).getCell(6).value ?? "");
    expect(remarkCell).toBe(longRemark); // 备注打包在首行备注格
    // 行高必须覆盖备注列的换行行数（宽 40 单位 ≈ 20 字/行 → 7 行），而非题干的 1 行 20 磅
    const expectedLines = Math.ceil([...longRemark].reduce((sum, ch) => sum + (ch.codePointAt(0) > 255 ? 2 : 1), 0) / 34);
    expect(answerSheet.getRow(2).height).toBeGreaterThanOrEqual(expectedLines * 15);
    expect(answerSheet.getRow(2).height).toBeLessThanOrEqual(400);
  });

  it("keeps the reconstruction note row tall enough for wrapping in the answer sheet", async () => {
    const questions = [{ id: questionId(1), question_key: "k1", question_number: 1, category: "env", text: "启用题", max_score: 5, is_score_wipe: false }];
    const answers = [{ question_id: questionId(1), answer: "scored", awarded_score: 5, issue_remark: "" }];
    const rows = reconstructScoreRows(questions, answers);
    const model = buildSubmissionExportModel({ submission: baseSubmission({ total_score: 5, max_score: 5, issue_count: 0 }), scoreRows: rows, scoreSource: "reconstructed" });
    const workbook = await workbookOf(model);
    const answerSheet = workbook.getWorksheet("作答明细");
    const noteRow = [...Array(answerSheet.rowCount).keys()].map((index) => index + 1).find((row) => String(answerSheet.getRow(row).getCell(3).value ?? "").includes("逐题得分由提交快照"));
    expect(noteRow).toBeGreaterThan(0);
    expect(answerSheet.getRow(noteRow).height).toBeGreaterThan(20); // 说明在备注前可完整换行，不再硬编码 20
  });

  it("splits emoji/mixed text at code-point boundaries and preserves newlines (real XLSX roundtrip)", async () => {
    const remark = "超".repeat(36) + "😀" + "尾".repeat(50); // 切段边界恰落在 emoji 代理对上
    const model = buildModel({
      scoreRows: [scoreRow(1, { category: "env-x", text: "检查题", answer: "unscored", awarded: 0, max: 10, categoryName: "环境卫生" })],
      submission: { total_score: 0, max_score: 10, issue_count: 1 },
      remarks: { [questionId(1)]: remark },
    });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    // 扣分说明块（每行一段）：读回拼接后与原文逐字一致，且全程无 U+FFFD 替换符
    const segments = [];
    for (let row = findRowContaining(sheet, "超超超", 3); ; row += 1) {
      const value = sheet.getRow(row).getCell(3).value;
      if (value === null || value === undefined || value === "") break;
      segments.push(String(value));
    }
    expect(segments.join("")).toBe(remark);
    expect(sheetText(sheet)).not.toContain("�");
    // 换行零丢失：wrapSegments 以段界承载换行，join("\n") 复原原文（含前导/连续/尾随空行）
    const { wrapSegments: split } = await import("../../apps/worker/src/submission-export.js");
    expect(split("a\n\nb", 37, 1).join("\n")).toBe("a\n\nb");
    expect(split("\nabc\n", 37, 1).join("\n")).toBe("\nabc\n");
    // emoji 完整落在单段内（不被劈成代理对）
    expect(split(remark, 37, 1).join("")).toBe(remark);
    expect(split(remark, 37, 1).some((segment) => segment.includes("�"))).toBe(false);
  });

  it("keeps technical reconstruction wording off the main report and notes it on the answer sheet", async () => {
    const questions = [
      { id: questionId(1), question_key: "k1", question_number: 1, category: "env", text: "清零题", max_score: 5, is_score_wipe: true },
      { id: questionId(2), question_key: "k2", question_number: 2, category: "env", text: "普通题", max_score: 5, is_score_wipe: false },
    ];
    const answers = [
      { question_id: questionId(1), answer: "unscored", awarded_score: 0, issue_remark: "过期食材" },
      { question_id: questionId(2), answer: "scored", awarded_score: 5, issue_remark: "" },
    ];
    const rows = reconstructScoreRows(questions, answers);
    const model = buildSubmissionExportModel({
      submission: baseSubmission({ total_score: 0, max_score: 10, issue_count: 1 }),
      scoreRows: rows, scoreSource: "reconstructed",
      remarks: Object.fromEntries(answers.map((answer) => [answer.question_id, answer.issue_remark])),
    });
    const workbook = await workbookOf(model);
    const mainText = sheetText(workbook.getWorksheet("暗访评估表"));
    const answerText = sheetText(workbook.getWorksheet("作答明细"), 6);
    expect(mainText).not.toContain("逐题得分由提交快照"); // 主报表不写实现性说明
    expect(answerText).toContain("逐题得分由提交快照与固定版本题目重建"); // 技术口径在补充页
  });

  it("omits optional sheets and shows placeholders when fields are missing", async () => {
    const model = buildModel({
      submission: { brand_name: null, visit_at: null, other_snapshot_json: {}, dish_snapshot_json: [], evidence_snapshot_json: [], receipt_snapshot_json: [] },
    });
    const workbook = await workbookOf(model);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["暗访评估表", "作答明细"]);
    const sheet = workbook.getWorksheet("暗访评估表");
    const joined = sheetText(sheet);
    expect(joined).toContain("未记录"); // 打卡缺失 → 日期回退提交日期（有标注）、时段为未记录，绝不出现 1900 占位
    expect(joined).toContain("（提交日期）"); // 回退口径显式标注
    expect(joined).not.toMatch(/1900/);
    expect(joined).toContain("改善建议：\n未填写");
    expect(joined).toContain("闪光点\n未填写");
    expect(joined).toContain("未统计（系统暂无历史失分统计能力）");
    expect(sheet.getCell("B3").value).toBe("—"); // 品牌缺失
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
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["暗访评估表", "作答明细", "菜品记录", "附件清单"]);
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
    // 关联位置用主表/作答明细一致的可见分类编号（service → S1），不再用全局题号
    expect(attachmentText.join("\n")).toContain("S1");
    expect(attachmentText.join("\n")).not.toContain("第 2 题");
    // 仅元数据：不含存储密钥/签名 URL
    expect(attachmentText.join("\n")).not.toMatch(/storage|http|signature/);
  });

  it("includes highlight-only photos in the attachment sheet gate (zero evidence / zero receipts)", async () => {
    // 只有闪光点照片（无题目证据、无小票）也必须出现附件清单页：元数据引用（编号）照旧，
    // 不含存储密钥/签名 URL；闪光点正文逐条完整展示（full text，绝不截断）。
    const highlightText = `服务 ${"非常主动".repeat(30)}`;
    const model = buildModel({
      submission: {
        total_score: 10, max_score: 10, issue_count: 0,
        other_snapshot_json: { highlight: "", suggestion: "无", highlights: [
          { id: "hl-1", sort_order: 1, text: highlightText, photos: [{ id: "hlp-1", display_order: 1, storage_key: "attempts/x/highlight-photos/a/b", status: "ready" }] },
        ] },
        evidence_snapshot_json: [], receipt_snapshot_json: [],
      },
    });
    expect(model.highlights[0].text).toBe(highlightText);
    expect(model.highlights[0].photos.length).toBe(1);
    const workbook = await workbookOf(model);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toContain("附件清单");
    const attachmentSheet = workbook.getWorksheet("附件清单");
    const text = sheetText(attachmentSheet, 4);
    expect(text).toContain("闪光点照片");
    expect(text).toContain("闪光点1");
    expect(text).toContain("hlp-1".slice(-8)); // 附件编号引用（后 8 位），与其他附件同款
    expect(text).not.toMatch(/storage|http|signature/);
    // 长文字按行切段续行（内容零丢失）：首段与尾段都必须出现（不截断）
    const main = sheetText(workbook.getWorksheet("暗访评估表"));
    expect(main).toContain(`闪光点1：${highlightText.slice(0, 20)}`);
    expect(main).toContain(highlightText.slice(-20));
  });

  it("labels attachment positions with per-category numbers for mixed-category submissions", async () => {
    const model = buildModel({
      scoreRows: [
        scoreRow(1, { category: "product", text: "品质题", awarded: 5, max: 5, categoryName: "产品品质" }),
        scoreRow(2, { category: "service", text: "服务题", awarded: 5, max: 5, categoryName: "为客服务" }),
        scoreRow(3, { category: "environment", text: "环境题", awarded: 0, max: 5, categoryName: "环境卫生" }),
      ],
      submission: {
        total_score: 10, max_score: 15, issue_count: 1,
        evidence_snapshot_json: [
          { id: "e-q1", question_id: questionId(1), type: "image" },
          { id: "e-q2", question_id: questionId(2), type: "image" },
          { id: "e-q3", question_id: questionId(3), type: "audio", duration_seconds: 5 },
        ],
      },
    });
    const workbook = await workbookOf(model);
    const attachmentSheet = workbook.getWorksheet("附件清单");
    const text = sheetText(attachmentSheet, 4);
    expect(text).toContain("Q1"); // product → Q1
    expect(text).toContain("S1"); // service → S1
    expect(text).toContain("C1"); // environment → C1
    expect(text).not.toMatch(/第 \d+ 题/); // 不再出现全局题号
  });

  it("keeps user-controlled spreadsheet text as plain strings (no formula injection)", async () => {
    const hostile = '=SUM(A1:A2)'; const hostile2 = "+cmd|' /C calc'!A0";
    const model = buildModel({
      scoreRows: [scoreRow(1, { category: "env-x", text: hostile, awarded: 7, max: 10 }), scoreRow(2, { category: "svc-x", text: hostile2, answer: "unscored", awarded: 0, max: 5 })],
      remarks: { [questionId(2)]: hostile },
      submission: { total_score: 7, max_score: 15, issue_count: 1, other_snapshot_json: { highlight: hostile, suggestion: hostile2 } },
    });
    const workbook = await workbookOf(model);
    for (const sheetName of ["暗访评估表", "作答明细"]) {
      const sheet = workbook.getWorksheet(sheetName);
      for (let row = 1; row <= sheet.rowCount; row += 1) for (let column = 1; column <= 11; column += 1) {
        // 任何用户可控文本都不允许变成公式单元格
        expect(sheet.getRow(row).getCell(column).type).not.toBe(ValueType.Formula);
      }
    }
    const text = sheetText(workbook.getWorksheet("暗访评估表"));
    expect(text).toContain("=SUM(A1:A2)"); // 原文零丢失
    expect(text).toContain("+cmd|' /C calc'!A0");
  });

  it("carries the reference branding: worksheet logo, company header and odd/even footers", async () => {
    const workbook = await workbookOf(buildModel());
    const sheet = workbook.getWorksheet("暗访评估表");
    expect(sheet.headerFooter.differentOddEven).toBe(true);
    expect(sheet.headerFooter.oddHeader).toContain("北京将道管理咨询服务有限公司");
    expect(sheet.headerFooter.evenHeader).toContain("北京将道管理咨询服务有限公司");
    expect(sheet.headerFooter.oddFooter).toContain("将道价值观");
    expect(sheet.headerFooter.evenFooter).toContain("将道行为准则");
    // 页眉 Logo 以真实浮动图片写入（ExcelJS 无页眉图片能力），Logo PNG（约 127KB）已嵌入产物
    const buffer = await buildSubmissionWorkbook(buildModel());
    expect(buffer.byteLength).toBeGreaterThan(100_000);
  });

  it("prints one page wide with auto page breaks and a repeated table header", async () => {
    const workbook = await workbookOf(buildModel());
    const sheet = workbook.getWorksheet("暗访评估表");
    expect(sheet.pageSetup.orientation).toBe("portrait");
    expect(sheet.pageSetup.paperSize).toBe(9);
    expect(sheet.pageSetup.fitToPage).toBe(true);
    expect(sheet.pageSetup.fitToWidth).toBe(1);
    expect(sheet.pageSetup.fitToHeight).toBe(0); // 纵向自动分页，不强制塞下
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

  it("keeps positive out-of-category residual scores as an explicit adjustment note and authoritative raw total", async () => {
    // 停用题残留作答：total 比启用题分类合计多 3，成绩记录显式说明而非静默吞掉
    const model = buildModel({ submission: { total_score: 5 } });
    expect(model.totals.deltaAwarded).toBe(3);
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    const recordRow = findRowByFirstCell(sheet, "评估信息");
    expect(recordRow).toBeGreaterThan(0);
    expect(sheetText(sheet)).toContain("分类外历史得分调整 +3");
    // 成绩记录保留权威原始总分 5（含分类外 3 分），而非分类合计 2
    expect(sheetText(sheet)).toContain("原始总分 5/10 分");
    // 矩阵总评为权威总分率 50%（5/10）
    expect(sheet.getCell("K4").value).toBe(50);
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
    // 20 条备注都完整出现：按单行长度切段连续成格，拼回后与原文逐字一致（零截断、零丢失）
    const joinedSegments = values.filter((value) => value.includes("实际问题说明")).join("");
    expect(joinedSegments).toBe(remark.repeat(20));
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
    // 备注被拆到多个续行格子，拼回后与原文逐字一致（末段可能只剩一两个字，按字符集收集）
    const segments = values.filter((value) => /^[超长备注]+$/.test(value));
    expect(segments.join("")).toBe(megaRemark);
    expect(segments.every((segment) => segment.length <= 380)).toBe(true);
  });
});

describe("question continuation layout", () => {
  it("anchors numbers on the FIRST question row when long text spans continuation rows", async () => {
    const longText = "门店服务标准检查条目内容较长，".repeat(50); // 750 字符 → 拆多段
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
    // 分值/扣分/得分锚定首行且红字/居中样式正确
    expect(sheet.getRow(firstRow).getCell(2).value).toBe("A1");
    expect(sheet.getRow(firstRow).getCell(9).value).toBe(5);
    expect(sheet.getRow(firstRow).getCell(10).value).toBe(5);
    expect(sheet.getRow(firstRow).getCell(10).font.color.argb).toBe("FFFF0000");
    expect(sheet.getRow(firstRow).getCell(11).value).toBe(0);
    for (const column of [2, 9, 10, 11]) expect(sheet.getRow(firstRow).getCell(column).alignment.horizontal).toBe("center");
    // 题干分段零丢失：首行 + 续行拼回原文
    expect(String(sheet.getRow(firstRow).getCell(3).value) + String(sheet.getRow(secondRow).getCell(3).value)).toBe(longText);
    // 续行不再重复数值
    expect(sheet.getRow(secondRow).getCell(2).value ?? null).toBeNull();
    expect(sheet.getRow(secondRow).getCell(9).value ?? null).toBeNull();
    expect(sheet.getRow(secondRow).getCell(10).value ?? null).toBeNull();
    expect(sheet.getRow(secondRow).getCell(11).value ?? null).toBeNull();
  });
});

describe("long metadata wrapping", () => {
  it("wraps long title/info values/category names with sufficient row heights", async () => {
    const longQuestionnaire = "超长问卷名称用于验证标题换行".repeat(6);
    const longStore = "门店名称特别长的大型购物中心分店名称测试".repeat(2);
    const longCategory = "售后服务与客户关怀体验评估分类";
    const model = buildSubmissionExportModel({
      submission: baseSubmission({ questionnaire_name: longQuestionnaire, store_name: longStore, total_score: 5, max_score: 5, issue_count: 0 }),
      scoreRows: [scoreRow(1, { category: "svc-long", text: "短题目", awarded: 5, max: 5, categoryName: longCategory })],
    });
    const workbook = await workbookOf(model);
    const sheet = workbook.getWorksheet("暗访评估表");
    // 标题：换行 + 行高覆盖 16pt 字号的多行标题
    expect(sheet.getCell("A1").alignment.wrapText).toBe(true);
    const titleLines = Math.ceil(String(sheet.getCell("A1").value).length / 44);
    expect(sheet.getRow(1).height).toBeGreaterThanOrEqual(titleLines * 22);
    // 信息行：门店名换行且行高覆盖（F 列约 8 字/行）
    expect(sheet.getCell("F3").alignment.wrapText).toBe(true);
    expect(sheet.getRow(3).height).toBeGreaterThanOrEqual(Math.ceil(longStore.length / 8) * 15);
    // 表体：单题分类的合并 A 标签所在首行行高足以容纳长分类名（A 列约 6 字/行）
    const headerRow = findRowByFirstCell(sheet, "评估维度");
    expect(String(sheet.getRow(headerRow + 1).getCell(1).value)).toContain(longCategory);
    expect(sheet.getRow(headerRow + 1).height).toBeGreaterThanOrEqual(Math.ceil(`A-${longCategory}`.length / 6) * 15);
  });
});

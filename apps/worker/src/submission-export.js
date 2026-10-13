// 单份问卷导出（暗访评估表 XLSX）：把一次 submission_versions 提交渲染成 PDF 同构的评估表工作簿。
// 结构与 dashboard-export 一致：纯函数不触 DB/COS，便于单测重读校验；
// DB 取数 + 范围校验收敛在 loadSubmissionExportModel（worker 唯一入口）。
// 数据口径：
//   - 逐题得分优先取 submission_question_scores 提交时物化的不可变明细（awarded_score 已含分数清零）；
//   - 0028 之前的历史提交无明细时，用提交快照(answer_snapshot_json) × 固定版本题目(已发布版本不可删)
//     重放提交时计分（domain.applyScoreWipe）。快照必须完整、唯一、合法地覆盖每道启用题
//     （作答取值合法、分值为不超过满分的非负整数），且重放总分与提交落库总分一致，
//     否则显式失败——绝不给缺失作答默认“得分”或伪造分数凑对账；
//   - 分类汇总/总评必须与提交落库的权威 total_score/max_score 对账，停用题残留作答等
//     分类外得分单列调整行说明，不静默吞差异。
import ExcelJS from "exceljs";
import { applyScoreWipe } from "../../../packages/domain/index.js";
import { XLSX_CONTENT_TYPE } from "./dashboard-export.js";

export { XLSX_CONTENT_TYPE };

const exportError = (code, message) => Object.assign(new Error(message), { code });
export const EXPORT_SUBMISSION_REQUIRED = "EXPORT_SUBMISSION_REQUIRED";
export const EXPORT_SUBMISSION_NOT_FOUND = "EXPORT_SUBMISSION_NOT_FOUND";
export const EXPORT_SUBMISSION_SCORES_MISSING = "EXPORT_SUBMISSION_SCORES_MISSING";

// 业务时区固定为项目约定 Asia/Shanghai：提交时间是 timestamptz，展示/文件名都按门店本地时区格式化
const TIME_ZONE = "Asia/Shanghai";
const dateTimeParts = new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const isValidDate = (value) => value instanceof Date && !Number.isNaN(value.getTime()) && value.getUTCFullYear() <= 9999;

export function formatShanghaiDateTime(value) {
  if (!isValidDate(value)) return null;
  const parts = Object.fromEntries(dateTimeParts.formatToParts(value).map((part) => [part.type, part.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour; // zh-CN 午夜可能输出 24
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

export function formatShanghaiDate(value) {
  const formatted = formatShanghaiDateTime(value);
  return formatted ? formatted.slice(0, 10) : null;
}

// 文件名片段安全化：去掉路径/Excel 非法字符与换行，限长，空值回退占位
const safeFileNamePart = (value, fallback) => {
  const cleaned = String(value ?? "").replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
  return cleaned || fallback;
};

export function buildSubmissionExportFileName(model) {
  const meta = model.meta;
  const date = formatShanghaiDate(meta.visitAt) || formatShanghaiDate(meta.submittedAt) || "未知日期";
  const parts = ["暗访评估", safeFileNamePart(meta.storeName, "未知门店"), safeFileNamePart(meta.inspectorName, "未知探店员"), date, safeFileNamePart(String(meta.submissionId || "").replace(/-/g, "").slice(0, 8), "未知编号")];
  return `${parts.join("_")}.xlsx`;
}

const ANSWER_LABELS = { scored: "得分", unscored: "不得分" };
const DISH_STATUS_LABELS = { ordered: "已点", substituted: "已替代", unavailable: "已售罄", skipped: "未点", extra: "额外菜品" };
// 分→元；缺失（null/undefined/空串）保持缺失（展示 —），绝不把空值折算成 0.00
const centsToYuan = (cents) => (cents === null || cents === undefined || cents === "" ? null : Number.isInteger(Number(cents)) ? Number(cents) / 100 : null);
const rateOf = (score, max) => (Number(max) > 0 ? Math.round((Number(score) / Number(max)) * 100) : null);
const dash = (value, formatter = (item) => item) => (value === null || value === undefined || value === "" ? "—" : formatter(value));

// 0028 之前的历史提交安全重建：提交快照（权威作答）× 固定版本启用题，重放提交时计分口径
// （含分数清零）。启用题作答必须完整、唯一、合法（scored/unscored，分值为 ≤ 满分的非负整数），
// 缺失/重复/非法一律显式失败，绝不默认补“得分”；expectedTotalScore（提交落库权威总分）用于
// 校验快照与这份提交确实对应（重放含停用题残留作答的总分必须精确相等）。
export function reconstructScoreRows(questions, snapshotAnswers, { categoryNames = new Map(), expectedTotalScore } = {}) {
  const answers = Array.isArray(snapshotAnswers) ? snapshotAnswers : null;
  if (!answers) throw exportError(EXPORT_SUBMISSION_SCORES_MISSING, "提交作答快照缺失或格式异常，无法安全重建逐题得分");
  const enabledIds = new Set(questions.map((question) => question.id));
  const answerByQuestion = new Map();
  for (const answer of answers) {
    if (!answer || typeof answer.question_id !== "string" || !enabledIds.has(answer.question_id)) continue; // 停用题残留作答不进逐题行，只参与总分重放
    if (answerByQuestion.has(answer.question_id)) throw exportError(EXPORT_SUBMISSION_SCORES_MISSING, "提交作答快照存在重复作答，无法安全重建逐题得分");
    answerByQuestion.set(answer.question_id, answer);
  }
  for (const question of questions) {
    const answer = answerByQuestion.get(question.id);
    const awarded = answer?.awarded_score;
    // 分值必须是真实保存的 JSON 整数：Number() 会把 null/""/false 折算成 0、true 折算成 1，
    // 那类值一律拒绝（fail closed），绝不静默折算成零分
    const valid = Boolean(answer) && (answer.answer === "scored" || answer.answer === "unscored")
      && typeof awarded === "number" && Number.isInteger(awarded) && awarded >= 0 && awarded <= Number(question.max_score);
    if (!valid) throw exportError(EXPORT_SUBMISSION_SCORES_MISSING, "提交作答快照缺少启用题作答或分值异常，无法安全重建逐题得分，已停止导出");
  }
  const wipe = applyScoreWipe(
    questions.map((question) => ({ id: question.id, category: question.category, maxScore: Number(question.max_score), scoreWipe: Boolean(question.is_score_wipe) })),
    answers.map((answer) => ({ questionId: String(answer?.question_id ?? ""), answer: answer?.answer, awardedScore: Number(answer?.awarded_score) })),
  );
  if (expectedTotalScore !== undefined && wipe.totalScore !== Number(expectedTotalScore)) {
    throw exportError(EXPORT_SUBMISSION_SCORES_MISSING, "提交作答快照重放总分与提交记录总分不一致，无法安全重建逐题得分");
  }
  return questions.map((question) => {
    const answer = answerByQuestion.get(question.id);
    return {
      question_id: question.id, question_key: question.question_key, question_number: Number(question.question_number), question_text: question.text,
      category: question.category, category_name: categoryNames.get(question.category) || null, answer: answer.answer,
      awarded_score: wipe.awardedFor({ id: question.id, category: question.category }), max_score: Number(question.max_score),
      is_score_wipe: Boolean(question.is_score_wipe),
    };
  });
}

// 归一化逐题行并按分类分组（分类顺序 = 题目顺序中首次出现的顺序，天然支持任意分类名/顺序）。
// 清零判定：优先 is_score_wipe 标记；兜底「scored 题 awarded=0 且 max>0」——正常 scored 必得满分，
// 该形态只可能来自清零（is_score_wipe 联查缺失时的保险丝）。
export function buildSubmissionExportModel({ submission, scoreRows, scoreSource, remarks = {} }) {
  if (!scoreRows.length) throw exportError(EXPORT_SUBMISSION_SCORES_MISSING, "这份提交缺少逐题得分数据，且无法从提交快照安全重建，已停止导出");
  const sorted = [...scoreRows].sort((left, right) => Number(left.question_number) - Number(right.question_number) || String(left.question_key).localeCompare(String(right.question_key)));
  const categoryOrder = [];
  const byCategory = new Map();
  for (const row of sorted) {
    const code = String(row.category ?? "");
    if (!byCategory.has(code)) { byCategory.set(code, []); categoryOrder.push(code); }
    byCategory.get(code).push(row);
  }
  const categories = categoryOrder.map((code) => {
    const rows = byCategory.get(code).map((row) => {
      const max = Number(row.max_score);
      const awarded = Number(row.awarded_score);
      return {
        questionId: row.question_id, key: row.question_key, number: Number(row.question_number), text: String(row.question_text ?? ""),
        answer: row.answer, answerLabel: ANSWER_LABELS[row.answer] || "—",
        maxScore: max, awardedScore: awarded, deduction: Math.max(0, max - awarded),
        remark: String(remarks[row.question_id] ?? "").trim(),
        wipeTrigger: Boolean(row.is_score_wipe), categoryName: row.category_name || null,
      };
    });
    const wipeRow = rows.find((row) => row.wipeTrigger && row.answer === "unscored")
      || rows.find((row) => row.answer === "unscored" && rows.some((other) => other !== row && other.answer === "scored" && other.awardedScore === 0 && other.maxScore > 0));
    const wiped = Boolean(wipeRow) || rows.some((row) => row.answer === "scored" && row.awardedScore === 0 && row.maxScore > 0);
    const sumMax = rows.reduce((sum, row) => sum + row.maxScore, 0);
    const sumAwarded = rows.reduce((sum, row) => sum + row.awardedScore, 0);
    return {
      code, name: rows[0].categoryName || code, rows, wiped, wipeQuestion: wipeRow || null,
      sumMax, sumAwarded, sumDeduction: Math.max(0, sumMax - sumAwarded), rate: rateOf(sumAwarded, sumMax),
    };
  });
  const sumAwarded = categories.reduce((sum, category) => sum + category.sumAwarded, 0);
  const sumMax = categories.reduce((sum, category) => sum + category.sumMax, 0);
  const totalScore = Number(submission.total_score);
  const maxScore = Number(submission.max_score);
  // 对账：分类外得分只允许 ≥0（停用题残留作答等历史口径），满分必须一致；负差/满分不平即数据不一致，显式失败
  const deltaAwarded = totalScore - sumAwarded;
  const deltaMax = maxScore - sumMax;
  if (deltaAwarded < 0 || deltaMax !== 0) throw exportError(EXPORT_SUBMISSION_SCORES_MISSING, "逐题得分与提交总分不一致，无法安全导出这份提交");
  const evidence = Array.isArray(submission.evidence_snapshot_json) ? submission.evidence_snapshot_json : [];
  const receipts = Array.isArray(submission.receipt_snapshot_json) ? submission.receipt_snapshot_json : [];
  return {
    meta: {
      submissionId: submission.id, taskName: submission.task_name, businessNo: submission.business_no,
      storeName: submission.store_name, brandName: submission.brand_name, regionName: submission.region_name,
      inspectorName: submission.inspector_name, questionnaireName: submission.questionnaire_name,
      versionLabel: `V${submission.version_number}`, submittedAt: submission.submitted_at, visitAt: submission.visit_at,
      totalScore, maxScore, issueCount: Number(submission.issue_count), scoreSource,
    },
    categories,
    totals: { sumAwarded, sumMax, deltaAwarded, overallRate: rateOf(totalScore, maxScore) },
    highlight: String(submission.other_snapshot_json?.highlight ?? "").trim(),
    suggestion: String(submission.other_snapshot_json?.suggestion ?? "").trim(),
    dishes: Array.isArray(submission.dish_snapshot_json) ? submission.dish_snapshot_json : [],
    attachments: { evidence, receipts },
  };
}

// —— 样式常量（对标参考 PDF：绿色表头、黄色小计、红色扣分/清零、细边框）——
const GREEN_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6E0B4" } };
const YELLOW_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
const LABEL_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF1F3" } };
const RED_FONT = { color: { argb: "FFC00000" } };
const BOLD = { bold: true };
const THIN = { style: "thin", color: { argb: "FF8EA08E" } };
const BOX = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const wrapStyle = { vertical: "middle", wrapText: true };
const centerStyle = { vertical: "middle", horizontal: "center", wrapText: true };

const decorate = (sheet, rowNumber, columns, { fill, font, alignment } = {}) => {
  for (let column = 1; column <= columns; column += 1) {
    const cell = sheet.getRow(rowNumber).getCell(column);
    cell.border = BOX;
    if (fill) cell.fill = fill;
    if (font) cell.font = font;
    if (alignment) cell.alignment = alignment;
  }
};

// —— 长文本换行拆分：Excel 单行高上限 409.5 磅，长说明必须拆成多行展示，绝不截断 ——
// 每行可容纳的中文字符数按「列宽 ÷ 2」保守估算；wrapSegments 把文本切成若干段（每格一段），
// 段内保留显式换行，超长段落按行硬切，保证任何文本都不超过单行高上限且内容零丢失。
const LINE_HEIGHT = 15;
const MAX_ROW_HEIGHT = 400;
// 行高估算的字数折减系数（相对换行拆分用的每行字数）
const HEIGHT_WIDTH_FACTOR = 0.55;
const QUESTION_CHARS_PER_LINE = 26; // C 列宽 58
// 扣分说明/页脚走 C:G 合并单元格：LibreOffice 对合并单元格的换行文本会按固定行数截断（与行高无关），
// 因此这两处按单行长度（≈44 个中文字符）切段、每段独占一行，任何引擎下都完整可见、零截断
const NOTE_CHARS_PER_LINE = 44;
const wrapSegments = (text, charsPerLine, maxLinesPerRow) => {
  const perRow = charsPerLine * maxLinesPerRow;
  const segments = [];
  let current = "";
  let currentLines = 0;
  const pushCurrent = () => { if (current) { segments.push(current); current = ""; currentLines = 0; } };
  for (const paragraph of String(text ?? "").split("\n")) {
    const lines = Math.max(1, Math.ceil(paragraph.length / charsPerLine));
    if (lines > maxLinesPerRow) {
      pushCurrent();
      for (let offset = 0; offset < paragraph.length; offset += perRow) segments.push(paragraph.slice(offset, offset + perRow));
      continue;
    }
    if (currentLines + lines > maxLinesPerRow) pushCurrent();
    current += (current ? "\n" : "") + paragraph;
    currentLines += lines;
  }
  pushCurrent();
  return segments.length ? segments : [""];
};
const rowHeightFor = (text, charsPerLine) => {
  // 行高按「可用字数 × 0.55」保守估算：不同渲染引擎（Excel/WPS/LibreOffice）的中文字体度量差异很大
  // （LibreOffice 回退字体行高约为 Excel 的 1.4 倍），行高必须按最不利引擎预留，任何引擎下都不视觉截断
  const lines = String(text ?? "").split("\n").reduce((sum, segment) => sum + Math.max(1, Math.ceil(segment.length / (charsPerLine * HEIGHT_WIDTH_FACTOR))), 0) || 1;
  return Math.min(MAX_ROW_HEIGHT, Math.max(20, lines * LINE_HEIGHT + 5));
};

// 扣分说明行：清零分类先给触发与结果，再逐题列出扣分与探员原始备注（不合并、不截断）
const deductionExplanationLines = (category) => {
  const lines = [];
  if (category.wiped && category.wipeQuestion) {
    // 清零前合计 = 该分类原始作答的应得分数（scored 题满分、unscored 题 0 分），全被清零扣除
    const preWipe = category.rows.reduce((sum, row) => sum + (row.answer === "scored" ? row.maxScore : 0), 0);
    lines.push(`清零：第 ${category.wipeQuestion.number} 题「${category.wipeQuestion.text}」被判不得分，本分类全部题目按 0 分计（清零前合计 ${preWipe} 分不计）。`);
  }
  for (const row of category.rows.filter((item) => item.deduction > 0)) {
    lines.push(`第 ${row.number} 题「${row.text}」扣 ${row.deduction} 分${row.remark ? `——探员备注：${row.remark}` : ""}。`);
  }
  return lines.length ? lines : ["无扣分"];
};

export async function buildSubmissionWorkbook(model) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "汇盈探店管理台";
  workbook.created = new Date();
  const meta = model.meta;
  const sheet = workbook.addWorksheet("暗访评估表", { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } } });
  sheet.columns = [{ width: 14 }, { width: 7 }, { width: 58 }, { width: 12 }, { width: 9 }, { width: 9 }, { width: 9 }];

  // —— 表头：报表标题/问卷/版本 + 品牌/门店/区域/任务/探店员/到店与提交时间 ——
  const title = `${meta.questionnaireName || "神秘顾客暗访"}·暗访评估表（${meta.versionLabel}）`;
  sheet.mergeCells("A1:G1");
  sheet.getCell("A1").value = title;
  sheet.getCell("A1").font = { bold: true, size: 15 };
  sheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  // 15pt 字号的行高按 20pt/行预留，长问卷标题换行不截断
  sheet.getRow(1).height = Math.max(26, Math.ceil(title.length / 44) * 20 + 6);
  // 信息行：A=标签1 / B:C=值1 / D=标签2 / E:G=值2，两列布局；长值换行不截断
  const infoRows = [
    ["品牌", dash(meta.brandName), "门店", dash(meta.storeName)],
    ["区域", dash(meta.regionName), "探店员", dash(meta.inspectorName)],
    ["任务编号", dash(meta.businessNo), "任务名称", dash(meta.taskName)],
    ["到店时间", formatShanghaiDateTime(meta.visitAt) || "未记录", "提交时间", formatShanghaiDateTime(meta.submittedAt) || "未记录"],
    ["问卷版本", meta.versionLabel, "不得分题数", `${meta.issueCount} 题`],
  ];
  let row = 1;
  for (const [label1, value1, label2, value2] of infoRows) {
    row += 1;
    sheet.getCell(`A${row}`).value = label1;
    sheet.mergeCells(`B${row}:C${row}`);
    sheet.getCell(`B${row}`).value = value1;
    sheet.getCell(`D${row}`).value = label2;
    sheet.mergeCells(`E${row}:G${row}`);
    sheet.getCell(`E${row}`).value = value2;
    decorate(sheet, row, 7);
    sheet.getCell(`A${row}`).alignment = centerStyle;
    sheet.getCell(`D${row}`).alignment = centerStyle;
    sheet.getCell(`B${row}`).alignment = wrapStyle; // 长品牌/区域/任务编号换行
    sheet.getCell(`E${row}`).alignment = wrapStyle; // 长门店/探店员/任务名称换行
    sheet.getRow(row).height = Math.max(rowHeightFor(value1, 29), rowHeightFor(value2, 12));
  }

  // —— 分类成绩块（动态分类；原始分与得分率分列；清零分类在说明列显式标注）——
  row += 2;
  sheet.getCell(`A${row}`).value = "分类成绩";
  sheet.getCell(`B${row}`).value = "满分";
  sheet.getCell(`C${row}`).value = "得分（原始）";
  sheet.getCell(`D${row}`).value = "得分率(%)";
  sheet.mergeCells(`E${row}:G${row}`);
  sheet.getCell(`E${row}`).value = "计分说明";
  decorate(sheet, row, 7, { fill: LABEL_FILL, font: BOLD, alignment: centerStyle });
  for (const category of model.categories) {
    row += 1;
    const note = category.wiped && category.wipeQuestion ? `清零：第 ${category.wipeQuestion.number} 题判定不得分，本分类按 0 分计` : "";
    sheet.getCell(`A${row}`).value = category.name;
    sheet.getCell(`A${row}`).alignment = wrapStyle; // 长分类名在窄 A 列内换行
    sheet.getCell(`B${row}`).value = category.sumMax;
    sheet.getCell(`C${row}`).value = category.sumAwarded;
    sheet.getCell(`D${row}`).value = category.rate ?? "—";
    sheet.mergeCells(`E${row}:G${row}`);
    sheet.getCell(`E${row}`).value = note;
    decorate(sheet, row, 7);
    sheet.getCell(`E${row}`).alignment = wrapStyle;
    if (category.wiped) sheet.getCell(`E${row}`).font = RED_FONT;
    // 行高同时覆盖计分说明与分类名（A 列宽 14 ≈ 6 个中文字符/行）
    sheet.getRow(row).height = Math.max(rowHeightFor(note, 12), rowHeightFor(category.name, 6));
  }
  row += 1;
  // 总评说明：分类外历史调整、快照重建来源均如实标注，不静默
  const notes = [];
  if (model.totals.deltaAwarded > 0) notes.push(`含分类外历史得分调整 +${model.totals.deltaAwarded}（停用题残留作答等，未计入分类小计）`);
  if (meta.scoreSource === "reconstructed") notes.push("逐题得分由提交快照与固定版本重建");
  if (!notes.length) notes.push(`共 ${model.categories.length} 个分类，不得分 ${meta.issueCount} 题`);
  const adjustmentNote = notes.join("；");
  sheet.getCell(`A${row}`).value = "总评";
  sheet.getCell(`B${row}`).value = meta.maxScore;
  sheet.getCell(`C${row}`).value = meta.totalScore;
  sheet.getCell(`D${row}`).value = model.totals.overallRate ?? "—";
  sheet.mergeCells(`E${row}:G${row}`);
  sheet.getCell(`E${row}`).value = adjustmentNote;
  decorate(sheet, row, 7, { fill: YELLOW_FILL, font: BOLD });
  sheet.getCell(`E${row}`).alignment = wrapStyle;
  sheet.getRow(row).height = rowHeightFor(adjustmentNote, 12);

  // —— 评估明细表体：动态分类/题目顺序；分类标签纵向合并；小计黄底；扣分红色；清零触发红字说明 ——
  row += 2;
  const tableHeaderRow = row;
  for (const [index, title] of ["评估维度", "序号", "评估说明", "探员答案", "分值", "扣分", "得分"].entries()) {
    sheet.getRow(row).getCell(index + 1).value = title;
  }
  decorate(sheet, row, 7, { fill: GREEN_FILL, font: BOLD, alignment: centerStyle });
  sheet.getRow(row).height = 22;
  // 长文本写入 C 列的工具：首段写入当前行，超出单行高上限的后续段落到续行（仅 C 列，内容零丢失）
  const writeWrappedColumnC = (text) => {
    const segments = wrapSegments(text, QUESTION_CHARS_PER_LINE, 22);
    sheet.getRow(row).getCell(3).value = segments[0];
    sheet.getRow(row).getCell(3).alignment = wrapStyle;
    sheet.getRow(row).height = rowHeightFor(segments[0], QUESTION_CHARS_PER_LINE);
    for (const segment of segments.slice(1)) {
      row += 1;
      decorate(sheet, row, 7);
      sheet.getRow(row).getCell(3).value = segment;
      sheet.getRow(row).getCell(3).alignment = wrapStyle;
      sheet.getRow(row).height = rowHeightFor(segment, QUESTION_CHARS_PER_LINE);
    }
  };
  for (const category of model.categories) {
    const firstRow = row + 1;
    for (const question of category.rows) {
      row += 1;
      const questionRow = row; // 数值/答案在首行；长题干的续行只放文本，样式必须锚定首行而非 mutable row
      sheet.getRow(questionRow).getCell(1).value = category.rows[0] === question ? category.name : null;
      sheet.getRow(questionRow).getCell(2).value = question.number;
      sheet.getRow(questionRow).getCell(4).value = question.answerLabel;
      sheet.getRow(questionRow).getCell(5).value = question.maxScore;
      sheet.getRow(questionRow).getCell(6).value = question.deduction;
      sheet.getRow(questionRow).getCell(7).value = question.awardedScore;
      decorate(sheet, questionRow, 7);
      sheet.getRow(questionRow).getCell(1).alignment = centerStyle;
      writeWrappedColumnC(question.text);
      [2, 4, 5, 6, 7].forEach((column) => { sheet.getRow(questionRow).getCell(column).alignment = centerStyle; });
      if (question.deduction > 0) sheet.getRow(questionRow).getCell(6).font = RED_FONT;
      if (question.answer === "unscored") sheet.getRow(questionRow).getCell(4).font = RED_FONT;
    }
    if (category.wiped && category.wipeQuestion) {
      row += 1;
      sheet.getRow(row).getCell(2).value = "*";
      decorate(sheet, row, 7);
      sheet.getRow(row).getCell(2).alignment = centerStyle;
      const wipeNoteStartRow = row;
      writeWrappedColumnC(`发现「${category.wipeQuestion.text}」被判不得分，此大项分数直接清零。`);
      for (let noteRow = wipeNoteStartRow; noteRow <= row; noteRow += 1) sheet.getRow(noteRow).getCell(3).font = RED_FONT;
    }
    // 分类标签纵向合并只覆盖题目区（含清零说明行）；小计/扣分说明行与参考 PDF 一致用 A:B 放行标签。
    // 单题分类的合并高度即首行行高，长分类名需要把首行行高一起抬高（A 列宽 14 ≈ 6 个中文字符/行）
    sheet.getRow(firstRow).height = Math.max(sheet.getRow(firstRow).height ?? 20, rowHeightFor(category.name, 6));
    sheet.mergeCells(`A${firstRow}:A${row}`);
    row += 1;
    sheet.mergeCells(`A${row}:B${row}`);
    sheet.getRow(row).getCell(1).value = `${category.name}小计`;
    sheet.getRow(row).getCell(5).value = category.sumMax;
    sheet.getRow(row).getCell(6).value = category.sumDeduction;
    sheet.getRow(row).getCell(7).value = category.sumAwarded;
    decorate(sheet, row, 7, { fill: YELLOW_FILL, font: BOLD });
    sheet.getRow(row).getCell(1).alignment = { vertical: "middle", horizontal: "right" };
    [5, 6, 7].forEach((column) => { sheet.getRow(row).getCell(column).alignment = centerStyle; });
    if (category.sumDeduction > 0) sheet.getRow(row).getCell(6).font = { bold: true, ...RED_FONT };
    // 扣分说明块：每条说明独立成段，按单行长度续行成块，绝不截断、不缩字号
    row += 1;
    const explanationSegments = deductionExplanationLines(category).flatMap((line) => wrapSegments(line, NOTE_CHARS_PER_LINE, 1));
    sheet.mergeCells(`A${row}:B${row}`);
    sheet.getRow(row).getCell(1).value = `${category.name}扣分说明`;
    sheet.mergeCells(`C${row}:G${row}`);
    sheet.getRow(row).getCell(3).value = explanationSegments[0];
    decorate(sheet, row, 7);
    sheet.getRow(row).getCell(1).alignment = { vertical: "middle", horizontal: "right", wrapText: true };
    sheet.getRow(row).getCell(3).alignment = wrapStyle;
    sheet.getRow(row).height = rowHeightFor(explanationSegments[0], NOTE_CHARS_PER_LINE);
    for (const segment of explanationSegments.slice(1)) {
      row += 1;
      sheet.mergeCells(`A${row}:B${row}`);
      sheet.mergeCells(`C${row}:G${row}`);
      sheet.getRow(row).getCell(3).value = segment;
      decorate(sheet, row, 7);
      sheet.getRow(row).getCell(3).alignment = wrapStyle;
      sheet.getRow(row).height = rowHeightFor(segment, NOTE_CHARS_PER_LINE);
    }
  }

  // —— 页脚：闪光点 / 未改善连续失分项（无真实历史失分统计能力，如实标注未统计）/ 改善建议 ——
  const footerBlocks = [
    ["闪光点", model.highlight || "未填写"],
    ["未改善连续失分项", "未统计（系统暂无历史失分统计能力）"],
    ["改善建议", model.suggestion || "未填写"],
  ];
  for (const [label, value] of footerBlocks) {
    const segments = wrapSegments(value, NOTE_CHARS_PER_LINE, 1);
    for (const [index, segment] of segments.entries()) {
      row += 1;
      sheet.mergeCells(`A${row}:B${row}`);
      sheet.getRow(row).getCell(1).value = index === 0 ? label : "";
      sheet.mergeCells(`C${row}:G${row}`);
      sheet.getRow(row).getCell(3).value = segment;
      decorate(sheet, row, 7);
      sheet.getRow(row).getCell(1).fill = LABEL_FILL;
      sheet.getRow(row).getCell(1).alignment = centerStyle;
      sheet.getRow(row).getCell(3).alignment = wrapStyle;
      sheet.getRow(row).height = rowHeightFor(segment, NOTE_CHARS_PER_LINE);
    }
  }
  // 打印体验：横向一页、纵向自动分页，表体表头跨页重复
  sheet.pageSetup.printTitlesRow = `${tableHeaderRow}:${tableHeaderRow}`;

  // —— 菜品记录页：保留提交时的菜品明细与评价（仅快照中实际存储的字段）——
  if (model.dishes.length) {
    const dishSheet = workbook.addWorksheet("菜品记录", { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    dishSheet.columns = [{ width: 6 }, { width: 20 }, { width: 20 }, { width: 7 }, { width: 10 }, { width: 11 }, { width: 11 }, { width: 44 }];
    for (const [index, title] of ["序号", "计划菜品", "实际菜品", "数量", "状态", "单价（元）", "小计（元）", "评价 / 说明"].entries()) {
      dishSheet.getRow(1).getCell(index + 1).value = title;
    }
    decorate(dishSheet, 1, 8, { fill: GREEN_FILL, font: BOLD, alignment: centerStyle });
    const statusNotes = {
      substituted: (dish) => `替代原因：${dish.substitution_reason || "未填写"}`,
      unavailable: (dish) => `售罄原因：${dish.unavailable_reason || "未填写"}`,
    };
    model.dishes.forEach((dish, index) => {
      const rowNumber = index + 2;
      const noteParts = [statusNotes[dish.fulfillment_status]?.(dish), dish.evaluation, dish.fully_satisfied ? "全部满意" : null, dish.instruction_snapshot ? `要求：${dish.instruction_snapshot}` : null].filter(Boolean).join("；");
      dishSheet.getRow(rowNumber).getCell(1).value = index + 1;
      dishSheet.getRow(rowNumber).getCell(2).value = dish.planned_name || "—";
      dishSheet.getRow(rowNumber).getCell(3).value = dish.actual_name || "—";
      dishSheet.getRow(rowNumber).getCell(4).value = dish.quantity ?? dish.planned_quantity ?? "—";
      dishSheet.getRow(rowNumber).getCell(5).value = DISH_STATUS_LABELS[dish.fulfillment_status] || dish.fulfillment_status;
      dishSheet.getRow(rowNumber).getCell(6).value = dash(centsToYuan(dish.unit_price_cents));
      dishSheet.getRow(rowNumber).getCell(6).numFmt = "#,##0.00";
      dishSheet.getRow(rowNumber).getCell(7).value = dash(centsToYuan(dish.line_total_cents));
      dishSheet.getRow(rowNumber).getCell(7).numFmt = "#,##0.00";
      dishSheet.getRow(rowNumber).getCell(8).value = noteParts || "—";
      decorate(dishSheet, rowNumber, 8);
      dishSheet.getRow(rowNumber).getCell(8).alignment = wrapStyle;
      dishSheet.getRow(rowNumber).height = rowHeightFor(noteParts, 20);
    });
  }

  // —— 附件清单页：仅元数据（类型/关联位置/数量/编号引用），不嵌入文件、不含签名 URL 与存储密钥 ——
  const evidenceByType = new Map();
  for (const item of model.attachments.evidence) {
    const type = item.type === "audio" ? "audio" : "image";
    const list = evidenceByType.get(type) || [];
    list.push(item);
    evidenceByType.set(type, list);
  }
  if (evidenceByType.size || model.attachments.receipts.length) {
    const attachmentSheet = workbook.addWorksheet("附件清单", { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    attachmentSheet.columns = [{ width: 18 }, { width: 30 }, { width: 8 }, { width: 60 }];
    for (const [index, title] of ["类型", "关联位置", "数量", "附件编号"].entries()) {
      attachmentSheet.getRow(1).getCell(index + 1).value = title;
    }
    decorate(attachmentSheet, 1, 4, { fill: GREEN_FILL, font: BOLD, alignment: centerStyle });
    const questionNumberById = new Map(model.categories.flatMap((category) => category.rows).map((item) => [item.questionId, item.number]));
    let attachmentRow = 1;
    const attachmentLine = (type, position, items) => {
      attachmentRow += 1;
      const references = items.map((item) => String(item.id).slice(-8)).join(", ");
      attachmentSheet.getRow(attachmentRow).getCell(1).value = type;
      attachmentSheet.getRow(attachmentRow).getCell(2).value = position;
      attachmentSheet.getRow(attachmentRow).getCell(3).value = items.length;
      attachmentSheet.getRow(attachmentRow).getCell(4).value = references;
      decorate(attachmentSheet, attachmentRow, 4);
      attachmentSheet.getRow(attachmentRow).getCell(4).alignment = wrapStyle;
      attachmentSheet.getRow(attachmentRow).height = rowHeightFor(references, 27);
    };
    for (const [type, items] of evidenceByType) {
      const positions = [...new Set(items.map((item) => `第 ${questionNumberById.get(item.question_id) ?? "?"} 题`))].join("、");
      attachmentLine(type === "image" ? "题目证据（照片）" : "题目证据（录音）", positions, items);
    }
    if (model.attachments.receipts.length) attachmentLine("消费小票", "小票照片", model.attachments.receipts);
  }
  return workbook.xlsx.writeBuffer();
}

// worker 入口：按 job 校验提交存在性 + 快照范围（与列表/详情一致的层级区域范围），取数并组装模型。
// 范围快照是创建任务时捕获的 user_data_scopes 行；范围层级 region→市→省 与 batch5 详情端点同口径。
export async function loadSubmissionExportModel(pool, job) {
  const request = job.filters_json || {};
  const submissionId = request.submissionId;
  if (!submissionId) throw exportError(EXPORT_SUBMISSION_REQUIRED, "导出任务未绑定提交记录，拒绝生成汇总文件");
  const result = await pool.query(`SELECT submission.id,submission.submitted_at,submission.total_score,submission.max_score,submission.issue_count,
      submission.questionnaire_version_id,submission.answer_snapshot_json,submission.dish_snapshot_json,submission.other_snapshot_json,
      submission.evidence_snapshot_json,submission.receipt_snapshot_json,
      campaign.name task_name,assignment.business_no,store.name store_name,brand.name brand_name,region.name region_name,
      inspector.display_name inspector_name,template.name questionnaire_name,version.version_number,
      (SELECT max(checkin.captured_at) FROM audit_checkins checkin WHERE checkin.assignment_id=submission.assignment_id
        AND checkin.inspector_id=submission.submitted_by AND checkin.result='accepted' AND checkin.captured_at<=submission.submitted_at) visit_at
    FROM submission_versions submission
    JOIN audit_campaigns campaign ON campaign.id=submission.campaign_id
    JOIN audit_assignments assignment ON assignment.id=submission.assignment_id
    JOIN stores store ON store.id=campaign.store_id
    LEFT JOIN brands brand ON brand.id=store.brand_id
    JOIN regions region ON region.id=store.region_id
    JOIN users inspector ON inspector.id=submission.submitted_by
    JOIN questionnaire_versions version ON version.id=submission.questionnaire_version_id
    JOIN questionnaire_templates template ON template.id=version.template_id
    WHERE submission.id=$1 AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS scope(scope_type text,region_id uuid,store_id uuid)
      WHERE scope.scope_type='all' OR (scope.scope_type='region' AND (scope.region_id=region.id OR scope.region_id=region.parent_id OR scope.region_id=(SELECT parent_id FROM regions WHERE id=region.parent_id))) OR (scope.scope_type='store' AND scope.store_id=store.id))`,
  [submissionId, JSON.stringify(job.scope_snapshot_json || [])]);
  const submission = result.rows[0];
  // 不存在与越权同口径显式失败：绝不回退为空文件或汇总导出
  if (!submission) throw exportError(EXPORT_SUBMISSION_NOT_FOUND, "提交记录不存在或已超出导出任务的数据范围");
  const scores = await pool.query(`SELECT score.question_id,score.question_key,score.question_number,score.question_text,score.category,
      cat.name category_name,score.answer,score.awarded_score,score.max_score,q.is_score_wipe
    FROM submission_question_scores score
    LEFT JOIN question_categories cat ON cat.code=score.category
    LEFT JOIN questions q ON q.id=score.question_id AND q.version_id=$2
    WHERE score.submission_id=$1 ORDER BY score.question_number,score.question_key`, [submission.id, submission.questionnaire_version_id]);
  let rows = scores.rows;
  let scoreSource = "recorded";
  if (!rows.length) {
    const snapshotRows = Array.isArray(submission.answer_snapshot_json) ? submission.answer_snapshot_json : [];
    const questions = await pool.query("SELECT id,question_key,question_number,category,text,max_score,is_score_wipe FROM questions WHERE version_id=$1 AND enabled ORDER BY question_number", [submission.questionnaire_version_id]);
    if (!snapshotRows.length || !questions.rows.length) throw exportError(EXPORT_SUBMISSION_SCORES_MISSING, "这份提交缺少逐题得分数据，且无法从提交快照安全重建，已停止导出");
    // 重建行补齐真实分类展示名（与 recorded 路径同源），并以权威总分校验快照确实属于这份提交
    const categoryNames = new Map((await pool.query("SELECT code,name FROM question_categories")).rows.map((row) => [row.code, row.name]));
    rows = reconstructScoreRows(questions.rows, snapshotRows, { categoryNames, expectedTotalScore: Number(submission.total_score) });
    scoreSource = "reconstructed";
  }
  const remarks = Object.fromEntries((Array.isArray(submission.answer_snapshot_json) ? submission.answer_snapshot_json : []).map((answer) => [answer.question_id, answer.issue_remark ?? ""]));
  return buildSubmissionExportModel({ submission, scoreRows: rows, scoreSource, remarks });
}

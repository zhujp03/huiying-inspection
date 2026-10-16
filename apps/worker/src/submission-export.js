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
import { readFileSync } from "node:fs";
import { applyScoreWipe } from "../../../packages/domain/index.js";
import { XLSX_CONTENT_TYPE } from "./dashboard-export.js";

export { XLSX_CONTENT_TYPE };

// 模板品牌 Logo（公开的企业标识，仅样式资产、不含业务数据）；缺失时静默降级为无 Logo
const LOGO_PATH = new URL("./assets/jiangdao-logo.png", import.meta.url);

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

// —— 样式常量（对标用户 XLSX 参考模板：幼圆字体、浅绿表头、浅黄小计、浅桃总评、
//      红色扣分/清零提示、蓝色探员原始备注、黑色细边框 + 区块中粗描边）——
const TEMPLATE_FONT = "幼圆";
const HEADER_GREEN = { type: "pattern", pattern: "solid", fgColor: { argb: "FFCCFFCC" } };
const SUBTOTAL_YELLOW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFCC" } };
const OVERALL_PEACH = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4D6" } };
const RED_FONT = { color: { argb: "FFFF0000" } };
const BLUE_FONT = { color: { argb: "FF0070C0" } };
const BOLD = { bold: true };
const THIN = { style: "thin", color: { argb: "FF000000" } };
const MEDIUM = { style: "medium", color: { argb: "FF000000" } };
// 模板品牌（公开的企业署名/页脚文案，非业务数据；与参考模板 odd/even 页脚一一对应）
const BRAND = Object.freeze({
  companyName: "北京将道管理咨询服务有限公司",
  footerOdd: "将道价值观：诚信、敬业、利他、传承、创新、不器",
  footerEven: "将道行为准则：温、良、恭、俭、让",
});

// 物理网格 A:K（列宽对标参考模板）；逻辑六列：A=评估维度 B=序号 C:H=评估说明 I=分值 J=扣分 K=得分
const GRID_WIDTHS = [11.7, 6.7, 7.3, 8.8, 11.7, 16.2, 16.5, 8.8, 8.8, 8.8, 8.8];
const GRID_COLUMNS = GRID_WIDTHS.length;
const COL_CATEGORY = 1;
const COL_LABEL = 2;
const COL_TEXT = 3;
const COL_TEXT_END = 8;
const COL_MAX = 9;
const COL_DEDUCTION = 10;
const COL_AWARDED = 11;

const cellBorder = (overrides = {}) => {
  const border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  for (const [side, style] of Object.entries(overrides)) {
    if (style === null) delete border[side]; // null = 该侧无边框（如信息值单元格只留下划线）
    else border[side] = style;
  }
  return border;
};
const wrapStyle = { vertical: "middle", wrapText: true };
const centerStyle = { vertical: "middle", horizontal: "center", wrapText: true };
const rightStyle = { vertical: "middle", horizontal: "right", wrapText: true };

// 统一写格：默认细边框 + 幼圆 10 号；显式边框键覆盖为 medium 等样式；
// border === false 表示完全无边框（参考模板的标题/信息标签无任何边框）
const setCell = (sheet, rowNumber, column, value, { fill, font, alignment, border } = {}) => {
  const cell = sheet.getRow(rowNumber).getCell(column);
  cell.value = value;
  if (border !== false) cell.border = cellBorder(border);
  cell.font = { name: TEMPLATE_FONT, size: 10, ...(font ?? {}) };
  if (fill) cell.fill = fill;
  if (alignment) cell.alignment = alignment;
  return cell;
};
// 区间风格化（合并区域的从属格也要有边框/填充，LibreOffice 才画得完整）
const styleRange = (sheet, rowNumber, columnStart, columnEnd, options = {}) => {
  for (let column = columnStart; column <= columnEnd; column += 1) setCell(sheet, rowNumber, column, null, options);
};
// 区块描边：给 [rowStart,rowEnd]×[columnStart,columnEnd] 的外沿加 medium 边（内沿仍是 thin）
const outlineBlock = (sheet, rowStart, rowEnd, columnStart, columnEnd) => {
  for (let row = rowStart; row <= rowEnd; row += 1) {
    sheet.getRow(row).getCell(columnStart).border = cellBorder({ ...(sheet.getRow(row).getCell(columnStart).border ?? {}), left: MEDIUM });
    sheet.getRow(row).getCell(columnEnd).border = cellBorder({ ...(sheet.getRow(row).getCell(columnEnd).border ?? {}), right: MEDIUM });
  }
  for (let column = columnStart; column <= columnEnd; column += 1) {
    sheet.getRow(rowStart).getCell(column).border = cellBorder({ ...(sheet.getRow(rowStart).getCell(column).border ?? {}), top: MEDIUM });
    sheet.getRow(rowEnd).getCell(column).border = cellBorder({ ...(sheet.getRow(rowEnd).getCell(column).border ?? {}), bottom: MEDIUM });
  }
};

// —— 长文本换行拆分：Excel 单行高上限 409.5 磅，长说明必须拆成多行展示，绝不截断 ——
// wrapSegments 把文本切成若干段（每格一段），段内保留显式换行，超长段落按行硬切，内容零丢失。
const LINE_HEIGHT = 15;
const MAX_ROW_HEIGHT = 400;
// 宽度度量：全角/中日韩字符按 2 个宽度单位、半角按 1 个单位（对齐 Excel 列宽单位），
// 按码点遍历（emoji 等代理对算一个字形）；行高估算与换行切段都以宽度单位计——
// 「A-环境卫生」这类半半全全混合标签才不会被高估
const textWidthUnits = (text) => {
  let sum = 0;
  for (const ch of String(text ?? "")) sum += (ch.codePointAt(0) ?? 0) > 255 ? 2 : 1;
  return sum;
};
// C:H 合计列宽 69.3 单位：切段保守取 30 个中文字符（60 单位），即使 LibreOffice 回退字体
// 度量偏宽 ~15%（60×1.15≈69）仍单行呈现——参考模板风格的常规短题恒为 20 磅单行
const QUESTION_CHARS_PER_LINE = 30;
// 扣分说明/页脚走 C:K 合并单元格（合计列宽 86.9 单位；15% 度量放大约 75 单位 → 37 个中文字符）
const NOTE_CHARS_PER_LINE = 37;
export const wrapSegments = (text, charsPerLine, maxLinesPerRow) => {
  const perRow = charsPerLine * maxLinesPerRow;
  const segments = [];
  let current = "";
  let currentLines = 0;
  const pushCurrent = () => { if (current) { segments.push(current); current = ""; currentLines = 0; } };
  for (const paragraph of String(text ?? "").split("\n")) {
    if (paragraph === "") { pushCurrent(); segments.push(""); continue; } // 空行独占一段，保住前导/连续/尾随换行（零丢失）
    const lines = Math.max(1, Math.ceil(textWidthUnits(paragraph) / (charsPerLine * 2)));
    if (lines > maxLinesPerRow) {
      pushCurrent();
      const codePoints = Array.from(paragraph); // 按码点切段：绝不劈开 emoji 等代理对（UTF-16 下标切分会产生 U+FFFD）
      for (let offset = 0; offset < codePoints.length; offset += perRow) segments.push(codePoints.slice(offset, offset + perRow).join(""));
      continue;
    }
    if (currentLines + lines > maxLinesPerRow) pushCurrent();
    current += (current ? "\n" : "") + paragraph;
    currentLines += lines;
  }
  pushCurrent();
  return segments.length ? segments : [""];
};
// 行高估算：capacityUnits 为该单元格每行的可容纳宽度单位（≈Excel 列宽）。切段单元格的每段
// 保证 ≤ 切段容量（本身含保守余量），短文本恒为参考模板的 20 磅单行；纯换行单元格传入
// 略小于真实列宽的容量（如 A 列 11.7 传 10）留字体度量余量
const rowHeightFor = (text, capacityUnits) => {
  const lines = String(text ?? "").split("\n").reduce((sum, segment) => sum + Math.max(1, Math.ceil(textWidthUnits(segment) / Math.max(1, capacityUnits))), 0) || 1;
  return Math.min(MAX_ROW_HEIGHT, Math.max(20, lines * LINE_HEIGHT + 5));
};

// 分类字母编号：已知分类固定映射（产品→Q、服务→S、环境→C，与参考模板一致）。先为清单内出现的
// 已知分类占住固定字母，再为自定义分类按 A..Z 顺序取首个未用字母——已知分类无论排在第几位都拿到
// 固定字母（如 environment 永远是 C），自定义分类确定性且绝不与已分配字母冲突；
// 极端超过 26 个分类时回退 X1/X2…，仍保证确定且不冲突。
const KNOWN_CATEGORY_LETTERS = Object.freeze({ product: "Q", service: "S", environment: "C" });
const LETTER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function assignCategoryLetters(categories) {
  const reserved = new Set(categories.map((category) => KNOWN_CATEGORY_LETTERS[category.code]).filter(Boolean));
  const used = new Set(reserved);
  return categories.map((category, index) => {
    const known = KNOWN_CATEGORY_LETTERS[category.code];
    if (known && reserved.has(known)) return known;
    const letter = LETTER_ALPHABET.split("").find((candidate) => !used.has(candidate)) ?? `X${index + 1}`;
    used.add(letter);
    return letter;
  });
}

// 清零提示行：仅当真实问卷配置了清零题（is_score_wipe）时展示，绝不从样例文案推断清零规则。
// 未触发 → 静态规则说明；触发 → 给出触发题、清零结果与清零前合计（= scored 题满分之和，全被清零扣除）。
// 触发题一律用导出表内可见的分类编号（如 Q3/C20），便于在成品里对照查找
const wipeNoteFor = (category, labelByQuestionId) => {
  const labelOf = (row) => labelByQuestionId.get(row.questionId) ?? `第 ${row.number} 题`;
  if (category.wiped && category.wipeQuestion) {
    const preWipe = category.rows.reduce((sum, row) => sum + (row.answer === "scored" ? row.maxScore : 0), 0);
    return { triggered: true, text: `清零：${labelOf(category.wipeQuestion)}「${category.wipeQuestion.text}」被判不得分，此大项分数直接清零（清零前合计 ${preWipe} 分不计）。` };
  }
  const configured = category.rows.find((row) => row.wipeTrigger);
  if (configured) return { triggered: false, text: `${labelOf(configured)} 被判不得分时，此大项分数直接清零。` };
  return null;
};

// 扣分说明块行：每条扣分一行（B=题号、C:K=说明）；有探员原始备注时蓝色原样展示，
// 无备注则简短标注扣分值——绝不编造说明文字；块不足 3 行时保留空白行（与参考模板一致，便于手写补记）
const deductionBlockLines = (category, labelByQuestionId) => category.rows
  .filter((row) => row.deduction > 0)
  .map((row) => {
    const remark = row.remark;
    return {
      label: labelByQuestionId.get(row.questionId) ?? "",
      segments: wrapSegments(remark || `扣 ${row.deduction} 分`, NOTE_CHARS_PER_LINE, 1),
      color: remark ? BLUE_FONT : null,
    };
  });

export async function buildSubmissionWorkbook(model) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "汇盈探店管理台";
  workbook.created = new Date();
  const meta = model.meta;
  // 页眉右侧公司署名 + 奇偶页脚品牌文案（ExcelJS 不支持页眉图片 &G，Logo 用工作表左上角真实浮动图片呈现）
  const headerFooter = {
    differentOddEven: true,
    oddHeader: `&R&"${TEMPLATE_FONT}"&10&B&K7F7F7F${BRAND.companyName}`,
    evenHeader: `&R&"${TEMPLATE_FONT}"&10&B&K7F7F7F${BRAND.companyName}`,
    oddFooter: `&L&"${TEMPLATE_FONT}"&10&B&K7F7F7F${BRAND.footerOdd}`,
    evenFooter: `&L&"${TEMPLATE_FONT}"&10&B&K7F7F7F${BRAND.footerEven}`,
  };
  const sheet = workbook.addWorksheet("暗访评估表", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.25, right: 0.25, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 } },
    headerFooter,
    properties: { defaultRowHeight: 20 }, // 参考模板默认行高 20
  });
  sheet.columns = GRID_WIDTHS.map((width) => ({ width }));
  // 模板 Logo（约 51.5×40.2pt ≈ 69×54px）：锚定 A1 左上角，随工作表对普通用户可见、可打印
  try {
    const imageId = workbook.addImage({ buffer: readFileSync(LOGO_PATH), extension: "png" });
    sheet.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 69, height: 54 } });
  } catch {
    // Logo 资产缺失时静默降级（导出流程不因此失败）
  }

  const letters = assignCategoryLetters(model.categories);
  const labelByQuestionId = new Map();
  for (const [index, category] of model.categories.entries()) {
    for (const [questionIndex, question] of category.rows.entries()) labelByQuestionId.set(question.questionId, `${letters[index]}${questionIndex + 1}`);
  }

  // —— 表头（对标参考模板）：标题行 + 品牌/门店两列信息（值带下划线）+ 右上紧凑分项成绩/总评矩阵 ——
  // 写入纪律：ExcelJS 在 mergeCells 之后再写从属格会把主格值/样式冲掉——因此所有合并区域都是
  // 「先写满值与样式、最后才 merge」，绝不写已合并的格子。
  // 参考模板中标题与信息标签完全无边框，信息值只有下边框。
  const title = `神秘顾客暗访评估表（${meta.questionnaireName || "问卷"}·${meta.versionLabel}）`;
  const mergeRowAfterWrite = (rowNumber, columnStart, columnEnd) => sheet.mergeCells(rowNumber, columnStart, rowNumber, columnEnd);
  setCell(sheet, 1, 1, title, { border: false, font: { size: 16, ...BOLD }, alignment: { horizontal: "center", vertical: "middle", wrapText: true } });
  mergeRowAfterWrite(1, 1, GRID_COLUMNS);
  // 16pt 字号的行高按 22pt/行预留；行高同时容纳左上角浮动 Logo（约 40.5pt）
  sheet.getRow(1).height = Math.max(42, Math.ceil(title.length / 44) * 22 + 6);
  sheet.getRow(2).height = 6;

  const visitDateLabel = formatShanghaiDate(meta.visitAt)
    || (formatShanghaiDate(meta.submittedAt) ? `${formatShanghaiDate(meta.submittedAt)}（提交日期）` : "未记录");
  // 暗访时段：只用已落库的真实打卡时刻（Asia/Shanghai），没有打卡绝不臆测「午餐/晚餐」
  const visitPeriod = meta.visitAt ? formatShanghaiDateTime(meta.visitAt)?.slice(11, 16) || "未记录" : "未记录";
  // 值单元格只留下边框 = 参考模板的信息下划线；标签 11 号无边框、值 11 号居中
  const infoUnderline = { top: null, left: null, right: null, bottom: THIN };
  const infoRow = (rowNumber, label1, value1, chars1, label2, value2, chars2) => {
    setCell(sheet, rowNumber, 1, label1, { border: false, font: { size: 11, ...BOLD }, alignment: { vertical: "middle" } });
    setCell(sheet, rowNumber, 2, value1, { font: { size: 11 }, alignment: centerStyle, border: infoUnderline });
    setCell(sheet, rowNumber, 3, null, { border: infoUnderline });
    mergeRowAfterWrite(rowNumber, 2, 3);
    setCell(sheet, rowNumber, 5, label2, { border: false, font: { size: 11, ...BOLD }, alignment: { vertical: "middle" } });
    setCell(sheet, rowNumber, 6, value2, { font: { size: 11 }, alignment: centerStyle, border: infoUnderline });
    sheet.getRow(rowNumber).height = Math.max(rowHeightFor(String(value1), chars1), rowHeightFor(String(value2), chars2), 20);
  };

  // —— 右上分项成绩/总评矩阵：分类每 4 个一排横向展示（3 分类时与参考模板完全一致，H:J+K），
  //      数值为百分制得分率；总评为系统权威 total/max 得分率（红字浅桃底）——
  const MATRIX_PAIR_CAPACITY = 4;
  const pairCount = Math.max(1, Math.ceil(model.categories.length / MATRIX_PAIR_CAPACITY));
  const matrixHeaderRow = 3;
  // 矩阵实际起点列随分类数左扩（4/5 分类从 G 起），表头合并与外沿描边必须覆盖真实宽度
  const matrixStartColumn = 11 - Math.min(model.categories.length, MATRIX_PAIR_CAPACITY);
  const matrixHeaderOptions = { alignment: centerStyle, font: { size: 11, ...BOLD } };
  setCell(sheet, matrixHeaderRow, matrixStartColumn, "分项成绩", matrixHeaderOptions);
  for (let column = matrixStartColumn + 1; column <= 10; column += 1) setCell(sheet, matrixHeaderRow, column, null, matrixHeaderOptions);
  mergeRowAfterWrite(matrixHeaderRow, matrixStartColumn, 10);
  setCell(sheet, matrixHeaderRow, 11, "总评", matrixHeaderOptions);
  const overallOptions = { fill: OVERALL_PEACH, alignment: centerStyle, font: { size: 11, ...BOLD, ...RED_FONT } };
  // 纵向合并的总评格：先合并，再写主格值/样式，从属格只补样式（绝不写从属格的值——ExcelJS 会冲掉主格值）
  sheet.mergeCells(4, 11, 3 + 2 * pairCount, 11);
  setCell(sheet, 4, 11, model.totals.overallRate ?? "—", overallOptions);
  const styleOnlyCell = (rowNumber, column, options) => {
    const cell = sheet.getRow(rowNumber).getCell(column);
    if (options.fill) cell.fill = options.fill;
    if (options.font) cell.font = { name: TEMPLATE_FONT, size: 10, ...options.font };
    if (options.alignment) cell.alignment = options.alignment;
  };
  for (let extra = 5; extra <= 3 + 2 * pairCount; extra += 1) styleOnlyCell(extra, 11, overallOptions);
  for (let pair = 0; pair < pairCount; pair += 1) {
    const lettersRow = 4 + 2 * pair;
    const valuesRow = lettersRow + 1;
    const start = pair * MATRIX_PAIR_CAPACITY;
    const slice = model.categories.slice(start, start + MATRIX_PAIR_CAPACITY);
    const firstColumn = 11 - slice.length; // 右对齐：3 分类 → H:J，与参考模板一致
    for (let column = firstColumn; column <= 10; column += 1) {
      const offset = column - firstColumn;
      setCell(sheet, lettersRow, column, slice[offset] ? letters[start + offset] : null, { alignment: centerStyle });
      setCell(sheet, valuesRow, column, slice[offset] ? slice[offset].rate ?? "—" : null, { fill: SUBTOTAL_YELLOW, alignment: centerStyle });
    }
    sheet.getRow(lettersRow).height = 20;
    sheet.getRow(valuesRow).height = 20;
  }
  // 左侧信息两行（品牌/门店 + 暗访日期/暗访时段）
  infoRow(3, "品牌名称：", dash(meta.brandName), 12, "门店名称：", dash(meta.storeName), 14);
  infoRow(5, "暗访日期：", visitDateLabel, 12, "暗访时段：", visitPeriod, 14);
  // 矩阵外沿中粗描边（覆盖矩阵真实宽度）；左信息行与矩阵之间的行保持无框留白
  outlineBlock(sheet, matrixHeaderRow, 3 + 2 * pairCount, matrixStartColumn, 11);
  let row = 3 + 2 * pairCount + 1;
  sheet.getRow(row).height = 6;

  // —— 表体：逻辑六列（A 维度 / B 序号 / C:H 评估说明 / I 分值 / J 扣分 / K 得分）——
  row += 1;
  const tableHeaderRow = row;
  const headerCellOptions = { fill: HEADER_GREEN, alignment: centerStyle };
  setCell(sheet, row, COL_CATEGORY, "评估维度", headerCellOptions);
  setCell(sheet, row, COL_LABEL, "序号", headerCellOptions);
  setCell(sheet, row, COL_TEXT, "评估说明", headerCellOptions);
  for (let column = COL_TEXT + 1; column <= COL_TEXT_END; column += 1) setCell(sheet, row, column, null, headerCellOptions);
  mergeRowAfterWrite(row, COL_TEXT, COL_TEXT_END);
  setCell(sheet, row, COL_MAX, "分值", headerCellOptions);
  setCell(sheet, row, COL_DEDUCTION, "扣分", headerCellOptions);
  setCell(sheet, row, COL_AWARDED, "得分", headerCellOptions);
  sheet.getRow(row).height = 22;
  // 长题干写入 C:H 合并列的工具：首段写入当前行，超出单行高上限的后续段落到续行（仅文本列，内容零丢失）。
  // 返回本次占用的起始行，便于调用方对整段（如清零提示）统一上色
  const writeQuestionText = (text) => {
    const startRow = row;
    const segments = wrapSegments(text, QUESTION_CHARS_PER_LINE, 22);
    const writeSegmentRow = (segment) => {
      setCell(sheet, row, COL_TEXT, segment, { alignment: wrapStyle });
      for (let column = COL_TEXT + 1; column <= COL_TEXT_END; column += 1) setCell(sheet, row, column, null, { alignment: wrapStyle });
      mergeRowAfterWrite(row, COL_TEXT, COL_TEXT_END);
      sheet.getRow(row).height = rowHeightFor(segment, 69);
    };
    writeSegmentRow(segments[0]);
    for (const segment of segments.slice(1)) {
      row += 1;
      styleRange(sheet, row, 1, GRID_COLUMNS, {});
      writeSegmentRow(segment);
    }
    return startRow;
  };

  const tableStartRow = tableHeaderRow;
  for (const [categoryIndex, category] of model.categories.entries()) {
    const letter = letters[categoryIndex];
    const categoryLabel = `${letter}-${category.name}`;
    const categoryFirstRow = row + 1;
    // 分类块上沿中粗线（第一个分类的上沿即表体顶部，由表头行统一承担）
    if (categoryIndex > 0) for (let column = 1; column <= GRID_COLUMNS; column += 1) sheet.getRow(categoryFirstRow).getCell(column).border = cellBorder({ top: MEDIUM });
    // 题目行：B=分类内重置编号（Q1/S1/C1…），C:H=题干（长题干续行），I=分值，J=扣分（红），K=得分
    for (const question of category.rows) {
      row += 1;
      const questionRow = row; // 数值锚定首行；长题干续行只放文本
      setCell(sheet, questionRow, COL_CATEGORY, category.rows[0] === question ? categoryLabel : null, { alignment: centerStyle });
      setCell(sheet, questionRow, COL_LABEL, labelByQuestionId.get(question.questionId), { alignment: centerStyle });
      writeQuestionText(question.text);
      setCell(sheet, questionRow, COL_MAX, question.maxScore, { alignment: centerStyle });
      setCell(sheet, questionRow, COL_DEDUCTION, question.deduction > 0 ? question.deduction : null, { alignment: centerStyle, font: question.deduction > 0 ? RED_FONT : undefined });
      setCell(sheet, questionRow, COL_AWARDED, question.awardedScore, { alignment: centerStyle });
    }
    // 清零提示行（仅真实配置了清零题的分类才有）：B=“*”，C:H 说明（触发的清零结果红字）
    const wipeNote = wipeNoteFor(category, labelByQuestionId);
    if (wipeNote) {
      row += 1;
      setCell(sheet, row, COL_LABEL, "*", { alignment: centerStyle, font: wipeNote.triggered ? RED_FONT : undefined });
      const wipeStartRow = writeQuestionText(wipeNote.text);
      for (let noteRow = wipeStartRow; noteRow <= row; noteRow += 1) {
        if (wipeNote.triggered) sheet.getCell(noteRow, COL_TEXT).font = { name: TEMPLATE_FONT, size: 10, ...RED_FONT };
      }
    }
    // 分类标签纵向合并贯穿题目区与小计行（与参考模板 A8:A21 一致）；长分类名抬高首行行高
    // （A 列宽 11.7 ≈ 5.8 个中文字符/行，容量取 5 留字体度量余量）
    sheet.getRow(categoryFirstRow).height = Math.max(sheet.getRow(categoryFirstRow).height ?? 20, rowHeightFor(categoryLabel, 10));
    // 小计行：B=分类字母小计，整行浅黄；J=扣分合计（红粗），K=得分合计（权威逐题合计）
    row += 1;
    const subtotalRow = row;
    sheet.getRow(subtotalRow).height = 20; // 参考模板小计行高
    const subtotalOptions = { fill: SUBTOTAL_YELLOW };
    setCell(sheet, subtotalRow, COL_LABEL, `${letter}小计`, { ...subtotalOptions, alignment: rightStyle });
    for (let column = COL_TEXT; column <= COL_TEXT_END; column += 1) setCell(sheet, subtotalRow, column, null, subtotalOptions);
    mergeRowAfterWrite(subtotalRow, COL_TEXT, COL_TEXT_END);
    setCell(sheet, subtotalRow, COL_MAX, category.sumMax, { ...subtotalOptions, alignment: centerStyle });
    setCell(sheet, subtotalRow, COL_DEDUCTION, category.sumDeduction, { ...subtotalOptions, alignment: centerStyle, font: category.sumDeduction > 0 ? { ...BOLD, ...RED_FONT } : undefined });
    setCell(sheet, subtotalRow, COL_AWARDED, category.sumAwarded, { ...subtotalOptions, alignment: centerStyle });
    sheet.mergeCells(categoryFirstRow, COL_CATEGORY, subtotalRow, COL_CATEGORY);
    // 扣分说明块：A=分类字母扣分说明，B=题号，C:K=探员原始备注（蓝色）/扣分值；块不足 3 行保留空行。
    // 先把「每条扣分的每段说明」平铺成块行（标签只在首段行），再统一落格
    row += 1;
    const deductionStartRow = row;
    const deductionBlockRows = deductionBlockLines(category, labelByQuestionId)
      .flatMap((line) => line.segments.map((segment, segmentIndex) => ({ label: segmentIndex === 0 ? line.label : null, text: segment, color: line.color })));
    const deductionRowCount = Math.max(3, deductionBlockRows.length);
    for (let blockRow = 0; blockRow < deductionRowCount; blockRow += 1) {
      const currentRow = deductionStartRow + blockRow;
      const layout = deductionBlockRows[blockRow] ?? null;
      styleRange(sheet, currentRow, 1, GRID_COLUMNS, {});
      setCell(sheet, currentRow, COL_LABEL, layout?.label ?? null, { alignment: centerStyle, font: layout?.color ? { ...BLUE_FONT } : undefined });
      setCell(sheet, currentRow, COL_TEXT, layout?.text ?? null, { alignment: wrapStyle, font: layout?.color ? { ...BLUE_FONT } : undefined });
      for (let column = COL_TEXT + 1; column <= GRID_COLUMNS; column += 1) setCell(sheet, currentRow, column, null, { alignment: wrapStyle });
      mergeRowAfterWrite(currentRow, COL_TEXT, GRID_COLUMNS);
      sheet.getRow(currentRow).height = rowHeightFor(String(layout?.text ?? ""), 87);
    }
    row = deductionStartRow + deductionRowCount - 1;
    setCell(sheet, deductionStartRow, COL_CATEGORY, `${letter}-扣分说明`, { alignment: centerStyle });
    sheet.mergeCells(deductionStartRow, COL_CATEGORY, row, COL_CATEGORY);
    sheet.getRow(deductionStartRow).height = Math.max(sheet.getRow(deductionStartRow).height ?? 20, rowHeightFor(`${letter}-扣分说明`, 10));
    // 分类块下沿中粗线
    for (let column = 1; column <= GRID_COLUMNS; column += 1) sheet.getRow(row).getCell(column).border = cellBorder({ bottom: MEDIUM });
  }
  // 表体整体外沿中粗描边 + 「评估说明 | 分值」之间的中粗竖线（与参考模板一致）
  outlineBlock(sheet, tableStartRow, row, 1, GRID_COLUMNS);
  for (let borderRow = tableStartRow; borderRow <= row; borderRow += 1) {
    sheet.getRow(borderRow).getCell(COL_MAX).border = cellBorder({ ...(sheet.getRow(borderRow).getCell(COL_MAX).border ?? {}), left: MEDIUM });
  }

  // —— 评估信息（小补充记录）：任务/探店员身份 + 权威原始总分/满分与分类外历史调整，保持报表
  //      风格贴近参考模板（不写实现性说明文字）；重建来源等技术口径放到「作答明细」补充页说明行 ——
  row += 2;
  const recordNotes = [
    `任务 ${dash(meta.taskName)}（编号 ${dash(meta.businessNo)}）；探店员 ${dash(meta.inspectorName)}；区域 ${dash(meta.regionName)}。`,
    `原始总分 ${meta.totalScore}/${meta.maxScore} 分（总得分率 ${model.totals.overallRate ?? "—"}%）；右上分项成绩/总评为百分制得分率，表体与小计均为原始分。`,
  ];
  if (model.totals.deltaAwarded > 0) recordNotes.push(`含分类外历史得分调整 +${model.totals.deltaAwarded}（停用题残留作答等，未计入分类小计）。`);
  recordNotes.push(`不得分 ${meta.issueCount} 题。`);
  // 每条说明独立成段（段内超长再续行），避免句子在任意位置被截断跨格
  const recordSegments = recordNotes.flatMap((note) => wrapSegments(note, NOTE_CHARS_PER_LINE, 1));
  for (const [index, segment] of recordSegments.entries()) {
    row += 1;
    styleRange(sheet, row, 1, GRID_COLUMNS, {});
    setCell(sheet, row, COL_CATEGORY, index === 0 ? "评估信息" : null, { alignment: centerStyle });
    setCell(sheet, row, COL_LABEL, segment, { alignment: wrapStyle });
    for (let column = COL_LABEL + 1; column <= GRID_COLUMNS; column += 1) setCell(sheet, row, column, null, { alignment: wrapStyle });
    mergeRowAfterWrite(row, COL_LABEL, GRID_COLUMNS);
    sheet.getRow(row).height = rowHeightFor(segment, 87);
  }
  outlineBlock(sheet, row - recordSegments.length + 1, row, 1, GRID_COLUMNS);

  // —— 页脚（对标参考模板）：闪光点 / 未改善连续失分项（系统暂无历史失分统计能力，如实标注）/ 改善建议 ——
  const footerBlock = (label, text, minimumRows) => {
    row += 1;
    sheet.getRow(row).height = 6;
    row += 1;
    const segments = wrapSegments(text, NOTE_CHARS_PER_LINE, 1);
    const blockRowCount = Math.max(minimumRows, segments.length);
    const blockStart = row;
    for (let blockRow = 0; blockRow < blockRowCount; blockRow += 1) {
      const currentRow = blockStart + blockRow;
      styleRange(sheet, currentRow, 1, GRID_COLUMNS, { alignment: wrapStyle });
      setCell(sheet, currentRow, COL_TEXT, segments[blockRow] ?? null, { alignment: wrapStyle });
      for (let column = COL_TEXT + 1; column <= GRID_COLUMNS; column += 1) setCell(sheet, currentRow, column, null, { alignment: wrapStyle });
      mergeRowAfterWrite(currentRow, COL_TEXT, GRID_COLUMNS);
      sheet.getRow(currentRow).height = rowHeightFor(String(segments[blockRow] ?? ""), 87);
    }
    setCell(sheet, blockStart, COL_CATEGORY, label, { alignment: centerStyle });
    sheet.mergeCells(blockStart, COL_CATEGORY, blockStart + blockRowCount - 1, COL_CATEGORY);
    outlineBlock(sheet, blockStart, blockStart + blockRowCount - 1, 1, GRID_COLUMNS);
    row = blockStart + blockRowCount - 1;
  };
  footerBlock("闪光点", model.highlight || "未填写", 3);
  // 未改善连续失分项：全宽标签行 + 保留内容行（当前系统没有历史失分统计，绝不编造历史数据）
  row += 1;
  sheet.getRow(row).height = 6;
  row += 1;
  const noImprovementStart = row;
  styleRange(sheet, row, 1, GRID_COLUMNS, { alignment: wrapStyle, border: { top: MEDIUM, left: MEDIUM, right: MEDIUM } });
  setCell(sheet, row, 1, "未改善连续失分项：", { alignment: wrapStyle, border: { top: MEDIUM, left: MEDIUM, right: MEDIUM } });
  mergeRowAfterWrite(row, 1, GRID_COLUMNS);
  row += 1;
  const noImprovementText = "未统计（系统暂无历史失分统计能力）";
  const noImprovementSegments = wrapSegments(noImprovementText, NOTE_CHARS_PER_LINE, 1);
  for (let blockRow = 0; blockRow < Math.max(3, noImprovementSegments.length); blockRow += 1) {
    styleRange(sheet, row, 1, GRID_COLUMNS, { alignment: wrapStyle });
    setCell(sheet, row, COL_LABEL, noImprovementSegments[blockRow] ?? null, { alignment: wrapStyle });
    for (let column = COL_LABEL + 1; column <= GRID_COLUMNS; column += 1) setCell(sheet, row, column, null, { alignment: wrapStyle });
    mergeRowAfterWrite(row, COL_LABEL, GRID_COLUMNS);
    sheet.getRow(row).height = rowHeightFor(String(noImprovementSegments[blockRow] ?? ""), 87);
    row += 1;
  }
  outlineBlock(sheet, noImprovementStart, row - 1, 1, GRID_COLUMNS);
  footerBlock("改善建议：", model.suggestion || "未填写", 3);

  // 打印体验：横向一页、纵向自然分页，表体表头跨页重复；避免孤行标题与空白尾页
  sheet.pageSetup.printTitlesRow = `${tableHeaderRow}:${tableHeaderRow}`;

  // —— 作答明细页：主表不再带「探员答案」列，探员原始作答标签与备注在此完整保留（绝不丢弃）。
  //      长题干/长备注与主表同口径切段续行（单格撑到行高上限会截断），每段一行、行高 20 ——
  const ANSWER_TEXT_CHARS_PER_LINE = 26; // 题干列宽 60 单位，留字体度量余量约 26 个中文字符/行
  const ANSWER_REMARK_CHARS_PER_LINE = 17; // 备注列宽 40 单位，留字体度量余量约 17 个中文字符/行
  const answerSheet = workbook.addWorksheet("作答明细", { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  answerSheet.properties.defaultRowHeight = 20; // 参考模板默认行高 20
  answerSheet.columns = [{ width: 14 }, { width: 8 }, { width: 60 }, { width: 10 }, { width: 8 }, { width: 40 }];
  for (const [index, title] of ["评估维度", "题号", "评估说明", "探员答案", "扣分", "探员备注"].entries()) {
    answerSheet.getRow(1).getCell(index + 1).value = title;
  }
  for (let column = 1; column <= 6; column += 1) setCell(answerSheet, 1, column, answerSheet.getRow(1).getCell(column).value, { fill: HEADER_GREEN, alignment: centerStyle });
  answerSheet.getRow(1).height = 20;
  let answerRowNumber = 1;
  for (const [categoryIndex, category] of model.categories.entries()) {
    for (const question of category.rows) {
      const textSegments = wrapSegments(question.text, ANSWER_TEXT_CHARS_PER_LINE, 22);
      const remarkSegments = wrapSegments(question.remark || "", ANSWER_REMARK_CHARS_PER_LINE, 22);
      const segmentCount = Math.max(textSegments.length, remarkSegments.length, 1);
      const firstAnswerRow = answerRowNumber + 1;
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        answerRowNumber += 1;
        setCell(answerSheet, answerRowNumber, 1, segmentIndex === 0 ? `${letters[categoryIndex]}-${category.name}` : null, { alignment: centerStyle });
        setCell(answerSheet, answerRowNumber, 2, segmentIndex === 0 ? labelByQuestionId.get(question.questionId) : null, { alignment: centerStyle });
        setCell(answerSheet, answerRowNumber, 3, textSegments[segmentIndex] ?? null, { alignment: wrapStyle });
        setCell(answerSheet, answerRowNumber, 4, segmentIndex === 0 ? question.answerLabel : null, { alignment: centerStyle });
        setCell(answerSheet, answerRowNumber, 5, segmentIndex === 0 && question.deduction > 0 ? question.deduction : null, { alignment: centerStyle });
        setCell(answerSheet, answerRowNumber, 6, remarkSegments[segmentIndex] ?? null, { alignment: wrapStyle });
        // 行高必须同时容纳本行每一个换行单元格：题干列（宽 60，度量余量取 52）与备注列（宽 40，取 34）
        answerSheet.getRow(answerRowNumber).height = Math.max(
          rowHeightFor(textSegments[segmentIndex] ?? "", 52),
          rowHeightFor(remarkSegments[segmentIndex] ?? "", 34),
        );
      }
      // 长分类名抬高首行行高（维度列宽 14 ≈ 6-7 个中文字符/行，容量取 5 留余量）
      answerSheet.getRow(firstAnswerRow).height = Math.max(answerSheet.getRow(firstAnswerRow).height ?? 20, rowHeightFor(`${letters[categoryIndex]}-${category.name}`, 10));
    }
  }
  if (meta.scoreSource === "reconstructed") {
    // 技术口径说明放补充页，主报表保持参考模板风格的简洁业务文案；行高按说明列容量计算防止换行截断
    const reconstructionNote = "逐题得分由提交快照与固定版本题目重建（历史提交无逐题物化明细）。";
    answerRowNumber += 1;
    setCell(answerSheet, answerRowNumber, 1, "说明", { alignment: centerStyle });
    setCell(answerSheet, answerRowNumber, 3, reconstructionNote, { alignment: wrapStyle });
    setCell(answerSheet, answerRowNumber, 6, null, { alignment: wrapStyle });
    answerSheet.getRow(answerRowNumber).height = rowHeightFor(reconstructionNote, 52);
  }

  // —— 菜品记录页：保留提交时的菜品明细与评价（仅快照中实际存储的字段）——
  if (model.dishes.length) {
    const dishSheet = workbook.addWorksheet("菜品记录", { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    dishSheet.properties.defaultRowHeight = 20; // 参考模板默认行高 20
    dishSheet.columns = [{ width: 6 }, { width: 20 }, { width: 20 }, { width: 7 }, { width: 10 }, { width: 11 }, { width: 11 }, { width: 44 }];
    for (const [index, title] of ["序号", "计划菜品", "实际菜品", "数量", "状态", "单价（元）", "小计（元）", "评价 / 说明"].entries()) {
      dishSheet.getRow(1).getCell(index + 1).value = title;
    }
    for (let column = 1; column <= 8; column += 1) setCell(dishSheet, 1, column, dishSheet.getRow(1).getCell(column).value, { fill: HEADER_GREEN, alignment: centerStyle });
    dishSheet.getRow(1).height = 20;
    model.dishes.forEach((dish, index) => {
      const rowNumber = index + 2;
      const noteParts = [dish.substitution_reason ? `替代原因：${dish.substitution_reason}` : null, dish.unavailable_reason ? `售罄原因：${dish.unavailable_reason}` : null, dish.evaluation, dish.fully_satisfied ? "全部满意" : null, dish.instruction_snapshot ? `要求：${dish.instruction_snapshot}` : null].filter(Boolean).join("；");
      setCell(dishSheet, rowNumber, 1, index + 1, { alignment: centerStyle });
      setCell(dishSheet, rowNumber, 2, dish.planned_name || "—", {});
      setCell(dishSheet, rowNumber, 3, dish.actual_name || "—", {});
      setCell(dishSheet, rowNumber, 4, dish.quantity ?? dish.planned_quantity ?? "—", { alignment: centerStyle });
      setCell(dishSheet, rowNumber, 5, DISH_STATUS_LABELS[dish.fulfillment_status] || dish.fulfillment_status, { alignment: centerStyle });
      setCell(dishSheet, rowNumber, 6, dash(centsToYuan(dish.unit_price_cents)), { alignment: centerStyle });
      dishSheet.getRow(rowNumber).getCell(6).numFmt = "#,##0.00";
      setCell(dishSheet, rowNumber, 7, dash(centsToYuan(dish.line_total_cents)), { alignment: centerStyle });
      dishSheet.getRow(rowNumber).getCell(7).numFmt = "#,##0.00";
      setCell(dishSheet, rowNumber, 8, noteParts || "—", { alignment: wrapStyle });
      dishSheet.getRow(rowNumber).height = rowHeightFor(noteParts, 40);
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
    attachmentSheet.properties.defaultRowHeight = 20; // 参考模板默认行高 20
    attachmentSheet.columns = [{ width: 18 }, { width: 30 }, { width: 8 }, { width: 60 }];
    for (const [index, title] of ["类型", "关联位置", "数量", "附件编号"].entries()) {
      attachmentSheet.getRow(1).getCell(index + 1).value = title;
    }
    for (let column = 1; column <= 4; column += 1) setCell(attachmentSheet, 1, column, attachmentSheet.getRow(1).getCell(column).value, { fill: HEADER_GREEN, alignment: centerStyle });
    attachmentSheet.getRow(1).height = 20;
    let attachmentRow = 1;
    const attachmentLine = (type, position, items) => {
      attachmentRow += 1;
      const references = items.map((item) => String(item.id).slice(-8)).join(", ");
      setCell(attachmentSheet, attachmentRow, 1, type, { alignment: centerStyle });
      setCell(attachmentSheet, attachmentRow, 2, position, {});
      setCell(attachmentSheet, attachmentRow, 3, items.length, { alignment: centerStyle });
      setCell(attachmentSheet, attachmentRow, 4, references, { alignment: wrapStyle });
      attachmentSheet.getRow(attachmentRow).height = rowHeightFor(references, 55);
    };
    for (const [type, items] of evidenceByType) {
      const positions = [...new Set(items.map((item) => labelByQuestionId.get(item.question_id) ?? "未知题目"))].join("、");
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

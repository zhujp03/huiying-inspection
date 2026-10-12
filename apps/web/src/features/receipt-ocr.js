// features/receipt-ocr.js（module-contracts §6.1；小程序 features/receipt-ocr.js:1-89 同名同语义）
//
// 常量钉值（契约 §6.1；测试断言逐字钉定）：
export const MAX_RECEIPTS = 9;                    // 小票上限（R61）
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // 单文件 10MB（R62）
export const MAX_MONEY_CENTS = 999999999;          // 金额上限（R56/R57）
export const OCR_POLL_DELAYS = [1000, 2000, 3000, 5000]; // 轮询退避封顶（R69）
//
// 函数语义（R56-R71）：
// - readyReceiptCount(receipts)：status==="ready" 且 origin!=="local" 计数。
// - occupiedReceiptCount(receipts, pending)：已占格数（本地项无 attachmentId 或未落服务端 id 时占格）。
// - validateReceiptFiles(occupied, files)：张数超 9 → 「最多只能上传 9 张消费小票」；
//   类型/大小 → 「请选择 10MB 以内的图片」；通过返回 ""（R61/R62）。
// - parseYuanToCents(raw)：元→分；空串→null；格式错/超上限 throw（R56）。
// - formatCentsToYuan(cents)：null/undefined→""；非法 throw；否则两位小数。
// - nextPollDelay(attempt)：按 OCR_POLL_DELAYS 封顶取值（R69）。
// - ocrStatusView(job)：状态→{label,tone,terminal}（R71 文案映射）。
// - applyOcrDishesOnce(state, jobId, incomingDishes)：同 job 幂等；required 菜校验
//   （缺失或改名 → throw「菜品要求已更新，请刷新后重试」）；成功替换并登记 appliedJobIds（R70）。
// - markDishEdited(dish, field, value)：置 manuallyModified 并从 reviewFields 移除该字段（R70 边注）。
// - deriveLineTotal(quantity, unitPriceCents, explicitLineTotalCents)：显式优先；否则
//   数量×单价精确推算并置 priceDerived；超限 throw（R57）。
// - requiredReviewMessage(dish)：reviewFields 含 actualName/quantity → 「请核对菜名和数量后再继续」。
// - receiptDeletionOptions(attachment)：按 dishImpact/appliedDishCount 给删除选项序列（R66）。

export function readyReceiptCount(receipts) {
  return receipts.filter((item) => item.status === "ready" && item.origin !== "local").length;
}

export function occupiedReceiptCount(receipts, pending) {
  const remoteIds = new Set(receipts.map((item) => item.id));
  return receipts.length + pending.filter((item) => !item.attachmentId || !remoteIds.has(item.attachmentId)).length;
}

export function validateReceiptFiles(occupied, files) {
  if (occupied + files.length > MAX_RECEIPTS) return "最多只能上传 9 张消费小票";
  for (const file of files) {
    const path = String(file.tempFilePath || file.path || "");
    const type = String(file.fileType || file.type || "").toLowerCase();
    const isImage = ["image", "image/jpeg", "image/png", "jpg", "jpeg", "png"].includes(type) || /\.(jpe?g|png)$/i.test(path);
    if (!isImage || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_RECEIPT_BYTES) return "请选择 10MB 以内的图片";
  }
  return "";
}

export function parseYuanToCents(raw) {
  const value = String(raw ?? "").trim();
  if (value === "") return null;
  const match = value.match(/^(0|[1-9]\d{0,6})(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("请输入正确的金额，最多保留两位小数");
  const cents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_MONEY_CENTS) throw new Error("金额超出可填写范围");
  return cents;
}

export function formatCentsToYuan(cents) {
  if (cents === null || cents === undefined) return "";
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_MONEY_CENTS) throw new Error("金额数据暂时无法使用");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function nextPollDelay(attempt) {
  return OCR_POLL_DELAYS[Math.min(Math.max(0, attempt), OCR_POLL_DELAYS.length - 1)];
}

export function ocrStatusView(job) {
  if (!job) return { label: "尚未识别", tone: "idle", terminal: true };
  if (job.status === "queued") return { label: "正在排队识别", tone: "working", terminal: false };
  if (job.status === "processing") return { label: "正在识别小票", tone: "working", terminal: false };
  if (job.status === "succeeded") return { label: `已识别 ${job.recognizedDishCount} 道菜`, tone: "success", terminal: true };
  if (job.status === "partial") return { label: `已带入 ${job.recognizedDishCount} 道菜，请核对标记内容`, tone: "review", terminal: true };
  return { label: "暂时无法识别这张小票，您仍可以手动填写菜品", tone: "failed", terminal: true };
}

export function applyOcrDishesOnce(state, jobId, incomingDishes) {
  const appliedJobIds = new Set(state.appliedJobIds || []);
  if (appliedJobIds.has(jobId)) return { ...state, applied: false };
  const required = new Map((state.dishes || []).filter((dish) => dish.requirementId).map((dish) => [dish.requirementId, dish.plannedName]));
  for (const [requirementId, plannedName] of required) {
    const next = incomingDishes.find((dish) => dish.requirementId === requirementId);
    if (!next || next.plannedName !== plannedName) throw new Error("菜品要求已更新，请刷新后重试");
  }
  appliedJobIds.add(jobId);
  return { ...state, dishes: incomingDishes, appliedJobIds: [...appliedJobIds], applied: true };
}

export function markDishEdited(dish, field, value) {
  const reviewFields = (dish.reviewFields || []).filter((item) => item !== field);
  return { ...dish, [field]: value, manuallyModified: true, reviewFields };
}

export function deriveLineTotal(quantity, unitPriceCents, explicitLineTotalCents) {
  if (explicitLineTotalCents !== null && explicitLineTotalCents !== undefined) return { lineTotalCents: explicitLineTotalCents, priceDerived: false };
  if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isInteger(unitPriceCents)) return { lineTotalCents: null, priceDerived: false };
  const lineTotalCents = quantity * unitPriceCents;
  if (!Number.isSafeInteger(lineTotalCents) || lineTotalCents > MAX_MONEY_CENTS) throw new Error("金额超出可填写范围");
  return { lineTotalCents, priceDerived: true };
}

export function requiredReviewMessage(dish) {
  const requiredFields = new Set(["actualName", "quantity"]);
  return (dish.reviewFields || []).some((field) => requiredFields.has(field)) ? "请核对菜名和数量后再继续" : "";
}

export function receiptDeletionOptions(attachment) {
  if (!attachment || attachment.dishImpact === "none" || attachment.appliedDishCount === 0) return ["keep_as_manual"];
  if (attachment.dishImpact === "removable_auto_rows") return ["remove_unmodified_ocr_rows", "keep_as_manual"];
  return ["keep_as_manual"];
}

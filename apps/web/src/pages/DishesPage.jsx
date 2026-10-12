// DishesPage — dishes 菜品与小票·第二步（inventory §1.9；rules R15/R16/R31/R40/R51-R75/R89）。
// 语义真源：apps/miniapp/miniprogram/pages/dishes/index.js（433 行）逐函数移植。
// 区块 ↔ inventory §1.9 a 对照：自定义导航（保存并回问卷）/ 三步流程条（第二步 active）/
// 加载与错误态 / 消费小票区（标题+必传星+计数、加载/错误提示、小票网格[服务端瓦片/待传瓦片/添加]、
// OCR 面板（门控 receiptOcr）、OCR 错误条）/ 菜品列表（主行+业务标签+任务行+条件字段+折叠区+
// 折叠摘要+错误条+删除）/ 添加菜品 / 页面级校验错误 / 底部上一步/下一步。
// PM 钉定 Web 适配点（本页）：
// 1) 小票选图：隐藏 <input type="file" accept="image/jpeg,image/png" multiple>；类型判定
//    file.type/name 后缀（.png→image/png 否则 image/jpeg）；文件名取 file.name 兜底 "receipt.jpg"；
//    预览用 URL.createObjectURL——v1 选择「行内全屏遮罩放大」而非 window.open（部分浏览器拦截弹窗），
//    单张移除/上传完成时即时 revoke（页面卸载不统一 revoke：SPA 内重挂载恢复待传项需沿用同一 blob URL）。
//    上传走 uploadToSignedTarget（FormData 直传），onProgress 更新「正在上传 N%」。
// 2) 取消上传（R64）：cancelledUploads 集合（utils/upload-queue.createCancelledUploads）登记后放弃
//    回填、不中断传输；uploading/confirming 项移除按钮禁用；重试先解除登记。
// 3) 删除小票二选一（R66）：wx.showActionSheet → 两步 window.confirm 组合：先 confirm
//    「是否同时移除未修改的识别菜品？」确定→remove_unmodified_ocr_rows；取消→再 confirm
//    「保留菜品，转为手工记录？」确定→keep_as_manual；任一步取消即中止。
// 4) 生命周期：onHide/onUnload persistLocal → useEffect cleanup（dirty||有待传||有恢复 jobId 才写；
//    OCR 轮询定时器清理）；从 other 返回 dishes = 组件重挂载，load() 恢复 pendingReceipts/recovery/轮询。
// 5) 401：捕获 kind=session → toast + redirectToLogin()。
// 6) wx.pageScrollTo(selector) → scrollIntoView；wx.navigateBack/redirectTo → context.back(fallback)/replace。
import React, { useEffect, useRef, useState } from "react";
import { Button, Card, FlowSteps, Muted, PageNav, SectionHeading } from "../design/components.jsx";
import { useApp } from "./app-context.jsx";
import { getAssignment } from "../services/assignments.js";
import { getDraft, saveDishes } from "../services/drafts.js";
import {
  applyReceiptOcrJob, completeReceiptUpload, createReceiptOcrJob, deleteReceiptAttachment,
  getReceiptOcrJob, initializeReceiptUpload, listReceiptAttachments,
} from "../services/receipts.js";
import { uploadToSignedTarget } from "../services/uploads.js";
import { getDraft as getLocalDraft, markDraftSynced, saveDraft } from "../store/survey.js";
import {
  applyOcrDishesOnce, deriveLineTotal, formatCentsToYuan, markDishEdited, nextPollDelay,
  occupiedReceiptCount, ocrStatusView, parseYuanToCents, readyReceiptCount,
  receiptDeletionOptions, requiredReviewMessage, validateReceiptFiles,
} from "../features/receipt-ocr.js";
import { firstIncompleteQuestion, isBlankExtraDish, secureUuid, validateDish } from "../utils/business.js";
import { isReceiptOcrEnabled } from "../utils/feature-flags.js";
import { createCancelledUploads } from "../utils/upload-queue.js";

const ALL_STATUSES = [
  { value: "ordered", label: "已点" }, { value: "substituted", label: "替代" },
  { value: "unavailable", label: "售罄" }, { value: "skipped", label: "未点" },
  { value: "extra", label: "额外菜品" },
];
const RECEIPT_STATUS_LABELS = { uploading: "上传中", ready: "上传完成", failed: "上传失败", local_selected: "等待上传", confirming: "正在确认" };

// 待传小票的 File 运行时缓存（模块级）：persistLocal 脱敏会剔除 File，重挂载恢复的待传项
// 重传时由此取回文件；生命周期与 blob URL 一致（SPA 会话内有效，整页刷新后失效）。
const receiptFileCache = new Map();

// hash 路由查询参数（Web 适配：页面自读，等价 miniapp onLoad(options)）。
function routeQuery() {
  const raw = String((typeof window !== "undefined" ? window.location.hash : "") || "").replace(/^#/, "");
  return new URLSearchParams(raw.split("?")[1] || "");
}

export function DishesPage() {
  const { publicConfig, navigate, back, replace, toast, redirectToLogin } = useApp();
  const [meta, setMeta] = useState(null);
  const [dishes, setDishes] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [pendingReceipts, setPendingReceipts] = useState([]);
  const [receiptRequired, setReceiptRequired] = useState(false);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState("");
  const [receiptLocked, setReceiptLocked] = useState(false);
  const [readyCount, setReadyCount] = useState(0);
  const [canAddReceipt, setCanAddReceipt] = useState(true);
  const [ocrJob, setOcrJobState] = useState(null);
  const [ocrView, setOcrView] = useState(() => ocrStatusView(null));
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [validationMessage, setValidationMessage] = useState("");
  const [focusDishId, setFocusDishId] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  // 异步闭包内读取最新值（等价 miniapp this.data）；卸载后异步回调不再写状态。
  const latestRef = useRef({});
  const routeMetaRef = useRef(null);
  const recoveryRef = useRef({ jobId: null, applyKey: null, appliedJobId: null });
  const dirtyRef = useRef(false);
  const unloadedRef = useRef(false);
  const pageVisibleRef = useRef(false);
  const ocrTimerRef = useRef(null);
  const applyingJobIdRef = useRef(null);
  const cancelledUploadsRef = useRef(null);
  if (!cancelledUploadsRef.current) cancelledUploadsRef.current = createCancelledUploads();
  // blob URL 登记表（url → clientFileId）：移除/上传完成时按 id 回收。
  const objectUrlsRef = useRef(new Map());
  // 选图（PM 适配点 1）：添加小票（可多选）与失败小票换图（单选）各一个隐藏 input。
  const fileInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const replaceTargetRef = useRef(null);

  latestRef.current = { dishes, receipts, pendingReceipts, receiptBusy, saving, ocrBusy, meta };

  // ---------- 基础投影与序列化（等价 miniapp 底部工具函数） ----------

  const applyDishes = (next) => { latestRef.current.dishes = next; setDishes(next); };
  const applyReceipts = (next) => { latestRef.current.receipts = next; setReceipts(next); };
  const applyPending = (next) => { latestRef.current.pendingReceipts = next; setPendingReceipts(next); };
  const applyReceiptBusy = (value) => { latestRef.current.receiptBusy = value; setReceiptBusy(value); };

  const persistLocal = () => {
    if (!routeMetaRef.current) return;
    try {
      saveDraft(routeMetaRef.current, {
        dishes: latestRef.current.dishes.map((dish, index) => serialiseDish(dish, index)),
        receiptRecovery: {
          pendingReceipts: latestRef.current.pendingReceipts.map(stripPendingSecrets),
          jobId: recoveryRef.current?.jobId || null,
          applyKey: recoveryRef.current?.applyKey || null,
          appliedJobId: recoveryRef.current?.appliedJobId || null,
        },
      });
    } catch { /* R72：存储异常静默，由下一次鉴权请求处理会话丢失 */ }
  };

  const refreshReceiptProjection = () => {
    const nextReady = readyReceiptCount(latestRef.current.receipts);
    setReadyCount(nextReady);
    setCanAddReceipt(occupiedReceiptCount(latestRef.current.receipts, latestRef.current.pendingReceipts) < 9);
  };

  const setReceiptState = (items) => {
    applyReceipts(items.map(projectReceipt));
    refreshReceiptProjection();
  };

  const mergeReceipt = (attachment) => {
    setReceiptState([...latestRef.current.receipts.filter((item) => item.id !== attachment.id), attachment].sort((a, b) => a.displayOrder - b.displayOrder));
  };

  const updatePending = (next) => {
    applyPending(latestRef.current.pendingReceipts.map((item) => (item.clientFileId === next.clientFileId ? projectPendingReceipt(next) : item)));
    persistLocal();
    refreshReceiptProjection();
  };

  const updateRevision = (revision) => {
    if (!Number.isInteger(revision) || !routeMetaRef.current) return;
    routeMetaRef.current = { ...routeMetaRef.current, revision };
    setMeta(routeMetaRef.current);
  };

  const acceptServerDishes = (serverDishes) => {
    dirtyRef.current = true;
    applyDishes(serverDishes.map((dish) => projectDish(enrichDish(dish, latestRef.current.dishes))));
    persistLocal();
  };

  const patchDish = (id, patch, showError = false, replaceMode = false) => {
    dirtyRef.current = true;
    applyDishes(latestRef.current.dishes.map((dish) => (dish.id === id
      ? projectDish(replaceMode
        ? { ...patch, showError: Boolean(showError || dish.showError) }
        : { ...dish, ...patch, showError: Boolean(showError || dish.showError) })
      : dish)));
    setValidationMessage("");
    persistLocal();
  };

  const scrollToId = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const scrollToSelector = (selector) => document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });

  // R89：含技术词（URL/token/revision/堆栈等）的错误文案换兜底文案。
  const safeMessageOf = (fallback) => (error) => safeMessage(error, fallback);

  const handleSessionError = (loadError) => {
    if (loadError?.kind !== "session" || unloadedRef.current) return false;
    toast(loadError.message);
    redirectToLogin();
    return true;
  };

  // ---------- 导航（等价 miniapp routeToSurvey/closeSubmitted/routeUrl） ----------

  const routeToSurvey = (forceReplace) => {
    const url = `${routeUrl("/survey", routeMetaRef.current)}&category=product`;
    // §4.3 返回栈兜底：有历史则 back，无历史则 replace。
    if (!forceReplace && window.history.length > 1) back(url);
    else replace(url);
  };

  const closeSubmitted = () => {
    toast("该问卷已关闭编辑");
    replace(`/task?assignmentId=${encodeURIComponent(routeMetaRef.current.assignmentId)}`);
  };

  const stopOcrPolling = () => {
    if (ocrTimerRef.current) clearTimeout(ocrTimerRef.current);
    ocrTimerRef.current = null;
  };

  // ---------- 加载链（等价 miniapp load，js:49-76） ----------

  const load = async () => {
    stopOcrPolling();
    setLoading(true);
    setError("");
    setValidationMessage("");
    try {
      const assignment = await getAssignment(routeMetaRef.current.assignmentId);
      if (unloadedRef.current) return;
      // R31/R76：已提交终态不可再编辑。
      if (assignment.status === "submitted") { closeSubmitted(); return; }
      const result = await getDraft(routeMetaRef.current.attemptId);
      if (unloadedRef.current) return;
      if (result.attempt.id !== routeMetaRef.current.attemptId || result.questionnaireVersion.id !== routeMetaRef.current.questionnaireVersionId) {
        throw new Error("问卷信息已更新，请从任务详情重新进入");
      }
      if (["submitting", "processing", "submitted"].includes(result.attempt.status)) { closeSubmitted(); return; }
      // R40：进菜品页全题守卫，命中回问卷（category=product）。
      const missing = firstIncompleteQuestion(result.questions, result.answers || {});
      if (missing) { toast(`请先完成第 ${missing.number} 题`); routeToSurvey(true); return; }

      const nextMeta = { ...routeMetaRef.current, revision: result.attempt.revision };
      const local = getLocalDraft(nextMeta);
      const serverDishes = buildServerDishes(result);
      // R52：本地未同步且非空时本地优先。
      const useLocal = local.synced === false && local.dishes?.length;
      const nextDishes = (useLocal ? local.dishes : serverDishes).map((dish) => projectDish(enrichDish(dish, result.dishRequirements || [])));
      const recovery = local.receiptRecovery || {};
      const nextPending = (recovery.pendingReceipts || []).filter((item) => item.localPath).map(projectPendingReceipt);
      if (!useLocal) {
        saveDraft(nextMeta, { dishes: nextDishes.map((dish, index) => serialiseDish(dish, index)) });
        markDraftSynced(nextMeta, nextMeta.revision);
      }
      routeMetaRef.current = nextMeta;
      // R51 边注：首访（服务端无 dishes）也置脏，确保落本地草稿。
      dirtyRef.current = Boolean(useLocal) || !(result.dishes || []).length;
      recoveryRef.current = { jobId: recovery.jobId || null, applyKey: recovery.applyKey || null, appliedJobId: recovery.appliedJobId || null };
      latestRef.current.dishes = nextDishes;
      latestRef.current.pendingReceipts = nextPending;
      if (unloadedRef.current) return;
      setMeta(nextMeta);
      applyDishes(nextDishes);
      applyPending(nextPending);
      setReceiptRequired(Boolean(assignment.receiptRequired));
      setLoading(false);
      await loadReceipts();
      // R68：存在恢复任务则续走应用/轮询（重挂载恢复入口）。
      if (!unloadedRef.current && recoveryRef.current.jobId) await resumeOcr();
    } catch (loadError) {
      if (unloadedRef.current) return;
      if (handleSessionError(loadError)) return;
      setLoading(false);
      setError(safeMessage(loadError, "暂时无法加载菜品记录，请重试"));
    }
  };

  // ---------- 小票列表（等价 miniapp loadReceipts，js:78-91） ----------

  const loadReceipts = async () => {
    setReceiptLoading(true);
    setReceiptError("");
    try {
      const result = await listReceiptAttachments(routeMetaRef.current.attemptId);
      if (unloadedRef.current) return;
      updateRevision(result.revision);
      setReceiptState(result.items);
    } catch (loadError) {
      if (unloadedRef.current) return;
      if (handleSessionError(loadError)) return;
      // R67：409 QUESTIONNAIRE_SUBMITTED 终态 → 固定文案 + 锁定重试入口。
      if (loadError?.kind === "questionnaire_submitted") {
        setReceiptError(loadError.message);
        setReceiptLocked(true);
        return;
      }
      setReceiptError(safeMessage(loadError, "暂时无法加载消费小票，请重试"));
      refreshReceiptProjection();
    } finally {
      if (!unloadedRef.current) setReceiptLoading(false);
    }
  };

  // ---------- 菜品行输入（等价 miniapp input/moneyInput/moneyBlur/quantityInput/quantityBlur/blur） ----------

  const input = (id, field, value) => {
    const dish = latestRef.current.dishes.find((item) => item.id === id);
    if (!dish) return;
    // R70 边注：OCR 来源行经 markDishEdited 标记已人工修改并移出待核对字段。
    const next = dish.source === "ocr" ? markDishEdited(dish, field, value) : { ...dish, [field]: value };
    patchDish(id, next, dish.showError, true);
  };

  const blur = (id) => {
    if (focusDishId === id) setFocusDishId("");
  };

  const moneyInput = (id, field, value) => {
    const dish = latestRef.current.dishes.find((item) => item.id === id);
    if (!dish) return;
    const next = markDishEdited(dish, field, value);
    patchDish(id, { ...next, amountError: "" }, dish.showError, true);
  };

  const moneyBlur = (id, field) => {
    const centsField = field === "unitPriceYuan" ? "unitPriceCents" : "lineTotalCents";
    const dish = latestRef.current.dishes.find((item) => item.id === id);
    if (!dish) return;
    try {
      // R56：失焦才解析归一（输入过程只清错误态）。
      const cents = parseYuanToCents(dish[field]);
      const patch = {
        [centsField]: cents,
        [field]: formatCentsToYuan(cents),
        amountError: "",
        manuallyModified: dish.source === "ocr" || dish.manuallyModified,
        reviewFields: (dish.reviewFields || []).filter((item) => item !== centsField),
      };
      if (centsField === "lineTotalCents") patch.priceDerived = false;
      else if (dish.lineTotalCents === null || dish.priceDerived) {
        // R57：单价变化仅当行总价为空或原为推导值时联动重算。
        const derived = deriveLineTotal(Number(dish.quantity), cents, null);
        Object.assign(patch, derived, { lineTotalYuan: formatCentsToYuan(derived.lineTotalCents) });
      }
      patchDish(id, patch, dish.showError);
    } catch (moneyError) {
      patchDish(id, { amountError: moneyError.message }, true);
    }
  };

  const quantityInput = (id, value) => {
    const dish = latestRef.current.dishes.find((item) => item.id === id);
    if (!dish) return;
    // R58：输入过程不校验，仅清错误并登记修改。
    patchDish(id, {
      quantityInput: value,
      manuallyModified: dish.source === "ocr" || dish.manuallyModified,
      reviewFields: (dish.reviewFields || []).filter((item) => item !== "quantity"),
      amountError: "",
    }, dish.showError);
  };

  const quantityBlur = (id) => {
    const dish = latestRef.current.dishes.find((item) => item.id === id);
    if (!dish) return;
    const quantity = Number(dish.quantityInput);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999) {
      patchDish(id, { amountError: "请输入 1 到 999 的整数数量" }, true);
      return;
    }
    try {
      const derived = dish.priceDerived ? deriveLineTotal(quantity, dish.unitPriceCents, null) : {};
      patchDish(id, {
        quantity,
        quantityInput: String(quantity),
        ...derived,
        ...(derived.lineTotalCents !== undefined ? { lineTotalYuan: formatCentsToYuan(derived.lineTotalCents) } : {}),
        amountError: "",
      }, dish.showError);
    } catch (quantityError) {
      patchDish(id, { amountError: quantityError.message }, true);
    }
  };

  // R55：状态切换字段清理（逐字对齐 miniapp status，js:146-157）。
  const status = (id, value) => {
    const dish = latestRef.current.dishes.find((item) => item.id === id);
    const option = dish?.statusOptions?.find((item) => item.value === value);
    if (!dish || !option) return;
    const patch = { fulfillmentStatus: option.value, manuallyModified: dish.source === "ocr" || dish.manuallyModified };
    if (option.value === "ordered") Object.assign(patch, { actualName: dish.actualName || dish.plannedName || "", substitutionReason: "", unavailableReason: "" });
    if (option.value === "substituted") patch.unavailableReason = "";
    if (["unavailable", "skipped"].includes(option.value)) Object.assign(patch, { actualName: "", substitutionReason: "", evaluation: "", fullySatisfied: false });
    if (option.value === "skipped") patch.unavailableReason = "";
    patchDish(id, patch, true);
  };

  const satisfied = (id) => {
    const dish = latestRef.current.dishes.find((item) => item.id === id);
    if (dish) patchDish(id, { fullySatisfied: !dish.fullySatisfied, manuallyModified: dish.source === "ocr" || dish.manuallyModified }, true);
  };

  // 纯视图切换：不置脏、不触发草稿保存（miniapp js:164 注释）。
  const toggleFold = (id) => {
    applyDishes(latestRef.current.dishes.map((dish) => (dish.id === id ? { ...dish, foldOpen: !dish.foldOpen } : dish)));
  };

  // ---------- 添加/删除菜品（R59/R60） ----------

  const add = () => {
    try {
      const id = secureUuid();
      const dish = projectDish({ id, requirementId: null, plannedName: "", actualName: "", quantity: 1, unitPriceCents: null, lineTotalCents: null, fulfillmentStatus: "extra", substitutionReason: "", unavailableReason: "", evaluation: "", fullySatisfied: false, required: false, allowSubstitution: false, source: "manual", manuallyModified: false, priceDerived: false, reviewFields: [], showError: false });
      dirtyRef.current = true;
      latestRef.current.dishes = [...latestRef.current.dishes, dish];
      applyDishes(latestRef.current.dishes);
      setFocusDishId(id);
      setValidationMessage("");
      persistLocal();
      setTimeout(() => scrollToId(`dish-${id}`), 0);
    } catch {
      toast("当前环境不支持安全创建记录");
    }
  };

  const remove = (id) => {
    const dish = latestRef.current.dishes.find((item) => item.id === id);
    if (!dish || dish.requirementId) return;
    // R60：删除确认文案区分 OCR/手工来源。
    const content = dish.source === "ocr"
      ? "菜品将从最终填写记录中删除，小票原始识别结果仍由系统保留。"
      : "已填写的菜名和评价会一起删除。";
    if (!window.confirm(`删除这道菜品？\n${content}`)) return;
    dirtyRef.current = true;
    applyDishes(latestRef.current.dishes.filter((item) => item.id !== id));
    setValidationMessage("");
    persistLocal();
  };

  // ---------- 小票选择与上传（R61-R64） ----------

  const trackObjectUrl = (url, clientFileId) => {
    objectUrlsRef.current.set(url, clientFileId);
    return url;
  };

  const releaseObjectUrl = (clientFileId) => {
    objectUrlsRef.current.forEach((ownerId, url) => {
      if (ownerId === clientFileId) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(url);
      }
    });
    receiptFileCache.delete(clientFileId);
  };

  const chooseReceipts = () => {
    if (latestRef.current.receiptBusy || !canAddReceipt) return;
    fileInputRef.current?.click();
  };

  const onFilesChosen = (event) => {
    const inputEl = event.target;
    const chosen = Array.from(inputEl.files || []);
    inputEl.value = ""; // 允许重复选择同一文件
    const remaining = 9 - occupiedReceiptCount(latestRef.current.receipts, latestRef.current.pendingReceipts);
    const files = chosen.slice(0, Math.max(0, remaining));
    if (!files.length) return;
    // R61/R62：整批校验（张数/类型/10MB），失败 toast 后整批拒绝。
    const validation = validateReceiptFiles(occupiedReceiptCount(latestRef.current.receipts, latestRef.current.pendingReceipts), files.map((file) => ({ tempFilePath: file.name, type: file.type, size: file.size })));
    if (validation) { toast(validation); return; }
    const pending = files.map((file) => {
      const clientFileId = secureUuid();
      const item = projectPendingReceipt({
        clientFileId,
        localPath: trackObjectUrl(URL.createObjectURL(file), clientFileId),
        sizeBytes: file.size,
        mimeType: receiptMime(file),
        fileName: receiptName(file),
        status: "local_selected",
        progressPercent: 0,
        message: "等待上传",
      });
      item.file = file;
      receiptFileCache.set(clientFileId, file);
      return item;
    });
    applyPending([...latestRef.current.pendingReceipts, ...pending]);
    setReceiptError("");
    persistLocal();
    refreshReceiptProjection();
    // R63：串行上传（receiptBusy 互斥保证逐张走完链路）。
    const runSerial = async () => {
      for (const item of pending) await uploadPending(item.clientFileId);
    };
    runSerial();
  };

  const uploadPending = async (clientFileId) => {
    const pending = latestRef.current.pendingReceipts.find((item) => item.clientFileId === clientFileId);
    if (!pending || latestRef.current.receiptBusy) return;
    applyReceiptBusy(true);
    try {
      let current = { ...pending, status: "uploading", message: "准备上传", progressPercent: 1 };
      updatePending(current);
      let target = current.uploadTarget;
      if (!target) {
        const init = await initializeReceiptUpload(routeMetaRef.current.attemptId, fileMeta(current), routeMetaRef.current.revision);
        if (unloadedRef.current) return;
        // R64：等待期间被移除 → 放弃回填，避免已删除的小票复活。
        if (cancelledUploadsRef.current.has(clientFileId)) return;
        updateRevision(init.revision);
        mergeReceipt(init.attachment);
        current = { ...current, attachmentId: init.attachment.id, uploadTarget: init.uploadTarget };
        target = init.uploadTarget;
        updatePending(current);
      }
      const file = current.file || receiptFileCache.get(clientFileId);
      const uploaded = await uploadToSignedTarget(target, file, (progress) => updatePending({ ...current, status: "uploading", progressPercent: progress, message: `正在上传 ${progress}%` }));
      if (unloadedRef.current) return;
      if (cancelledUploadsRef.current.has(clientFileId)) return;
      current = { ...current, status: "confirming", progressPercent: 100, message: "正在确认上传" };
      updatePending(current);
      const completed = await completeReceiptUpload(routeMetaRef.current.attemptId, current.attachmentId, { ...fileMeta(current), etag: uploaded.etag }, routeMetaRef.current.revision);
      if (unloadedRef.current) return;
      if (cancelledUploadsRef.current.has(clientFileId)) return;
      updateRevision(completed.revision);
      if (completed.attachment) mergeReceipt(completed.attachment);
      if (completed.items) setReceiptState(completed.items);
      releaseObjectUrl(clientFileId);
      applyPending(latestRef.current.pendingReceipts.filter((item) => item.clientFileId !== clientFileId));
      setReceiptError("");
      persistLocal();
      refreshReceiptProjection();
    } catch (uploadError) {
      if (unloadedRef.current) return;
      if (handleSessionError(uploadError)) return;
      // R63：任一步失败置 failed + safeMessage（R89 过滤）。
      const failed = latestRef.current.pendingReceipts.find((item) => item.clientFileId === clientFileId);
      if (failed) updatePending({ ...failed, status: "failed", message: safeMessage(uploadError, "暂时无法上传小票，请重试") });
    } finally {
      applyReceiptBusy(false);
      if (!unloadedRef.current) refreshReceiptProjection();
    }
  };

  // R64：重试先解除取消登记（唯一复活通道）。
  const retryUpload = (clientFileId) => {
    cancelledUploadsRef.current.delete(clientFileId);
    uploadPending(clientFileId);
  };

  // R64：移除待传项 = 登记取消 + 立即移除（不中断在途传输）。
  const removePending = (clientFileId) => {
    cancelledUploadsRef.current.add(clientFileId);
    releaseObjectUrl(clientFileId);
    applyPending(latestRef.current.pendingReceipts.filter((item) => item.clientFileId !== clientFileId));
    persistLocal();
    refreshReceiptProjection();
  };

  // R65：失败小票换图——先删旧附件（keep_as_manual，采纳 dishes）再走完整上传链。
  const replaceFailedReceipt = (attachmentId) => {
    const attachment = latestRef.current.receipts.find((item) => item.id === attachmentId);
    if (!attachment?.canRetry || latestRef.current.receiptBusy) return;
    replaceTargetRef.current = attachmentId;
    replaceInputRef.current?.click();
  };

  const onReplaceFileChosen = (event) => {
    const inputEl = event.target;
    const file = (inputEl.files || [])[0];
    inputEl.value = "";
    const attachmentId = replaceTargetRef.current;
    replaceTargetRef.current = null;
    const attachment = latestRef.current.receipts.find((item) => item.id === attachmentId);
    if (!file || !attachment?.canRetry || latestRef.current.receiptBusy) return;
    const run = async () => {
      // R62：换图与新增同源校验——删除旧附件之前先校验新图（占用按换图语义 −1，
      // 等价小程序 js:251）；不满足则整批拒绝，不发任何请求、不动旧附件。
      const validation = validateReceiptFiles(
        Math.max(0, occupiedReceiptCount(latestRef.current.receipts, latestRef.current.pendingReceipts) - 1),
        [{ tempFilePath: file.name, type: file.type, size: file.size }],
      );
      if (validation) { toast(validation); return; }
      applyReceiptBusy(true);
      setReceiptError("");
      try {
        const removed = await deleteReceiptAttachment(routeMetaRef.current.attemptId, attachment.id, "keep_as_manual", routeMetaRef.current.revision);
        if (unloadedRef.current) return;
        updateRevision(removed.revision);
        setReceiptState(removed.items || latestRef.current.receipts.filter((item) => item.id !== attachment.id));
        if (removed.dishes) acceptServerDishes(removed.dishes);
        const clientFileId = secureUuid();
        const pending = projectPendingReceipt({
          clientFileId,
          localPath: trackObjectUrl(URL.createObjectURL(file), clientFileId),
          sizeBytes: file.size,
          mimeType: receiptMime(file),
          fileName: receiptName(file),
          status: "local_selected",
          progressPercent: 0,
          message: "等待上传",
        });
        pending.file = file;
        receiptFileCache.set(clientFileId, file);
        applyPending([...latestRef.current.pendingReceipts, pending]);
        persistLocal();
        applyReceiptBusy(false);
        await uploadPending(pending.clientFileId);
      } catch (replaceError) {
        if (unloadedRef.current) return;
        if (handleSessionError(replaceError)) return;
        setReceiptError(safeMessage(replaceError, "暂时无法重新上传小票，请重试"));
      } finally {
        applyReceiptBusy(false);
        if (!unloadedRef.current) refreshReceiptProjection();
      }
    };
    run();
  };

  // PM 适配点 1：预览（服务端 + 待传合集）走行内全屏遮罩。
  const previewReceipt = (url) => {
    if (!url) return;
    setPreviewUrl(url);
  };

  // ---------- 删除小票（R66） ----------

  const deleteReceipt = (attachmentId) => {
    const attachment = latestRef.current.receipts.find((item) => item.id === attachmentId);
    if (!attachment?.canDelete || latestRef.current.receiptBusy) return;
    const choices = receiptDeletionOptions(attachment);
    if (choices.length === 1) {
      const content = attachment.appliedDishCount ? "已带入的菜品会保留并转为手工记录。" : "删除后需要重新选择图片才能恢复。";
      if (window.confirm(`删除这张消费小票？\n${content}`)) confirmDeleteReceipt(attachment, choices[0]);
      return;
    }
    // PM 适配点 3：ActionSheet 双选项 → 两步 window.confirm 组合，任一步取消即中止。
    if (window.confirm("是否同时移除未修改的识别菜品？")) {
      confirmDeleteReceipt(attachment, "remove_unmodified_ocr_rows");
    } else if (window.confirm("保留菜品，转为手工记录？")) {
      confirmDeleteReceipt(attachment, "keep_as_manual");
    }
  };

  const confirmDeleteReceipt = async (attachment, dishHandling) => {
    if (!dishHandling) return;
    applyReceiptBusy(true);
    setReceiptError("");
    try {
      const result = await deleteReceiptAttachment(routeMetaRef.current.attemptId, attachment.id, dishHandling, routeMetaRef.current.revision);
      if (unloadedRef.current) return;
      updateRevision(result.revision);
      setReceiptState(result.items || latestRef.current.receipts.filter((item) => item.id !== attachment.id));
      if (result.dishes) acceptServerDishes(result.dishes);
    } catch (deleteError) {
      if (unloadedRef.current) return;
      if (handleSessionError(deleteError)) return;
      setReceiptError(safeMessage(deleteError, "暂时无法删除小票，请重试"));
    } finally {
      applyReceiptBusy(false);
    }
  };

  // ---------- OCR（R15/R16/R68-R71） ----------

  const setOcrJob = (job) => {
    const view = ocrStatusView(job);
    setOcrJobState(job);
    setOcrView(view);
    // R71：failed 文案同时进入 ocrError；其余状态清空 ocrError。
    setOcrError(job.status === "failed" ? view.label : "");
  };

  const startOcr = async () => {
    if (latestRef.current.ocrBusy) return;
    const attachmentIds = latestRef.current.receipts.filter((item) => item.status === "ready").map((item) => item.id);
    if (!attachmentIds.length) { toast("请先完成消费小票上传"); return; }
    try {
      stopOcrPolling();
      setOcrBusy(true);
      setOcrError("");
      const idempotencyKey = secureUuid();
      const job = await createReceiptOcrJob(routeMetaRef.current.attemptId, attachmentIds, idempotencyKey, routeMetaRef.current.revision);
      if (unloadedRef.current) return;
      // R68：恢复元数据随草稿持久化。
      recoveryRef.current = { jobId: job.id, applyKey: secureUuid(), appliedJobId: null };
      setOcrJob(job);
      persistLocal();
      if (["succeeded", "partial"].includes(job.status)) await applyOcr(job);
      else if (["queued", "processing"].includes(job.status)) scheduleOcrPoll(0);
    } catch (ocrStartError) {
      if (unloadedRef.current) return;
      if (handleSessionError(ocrStartError)) return;
      setOcrError(safeMessage(ocrStartError, "暂时无法开始识别，请重试"));
    } finally {
      setOcrBusy(false);
    }
  };

  const resumeOcr = async () => {
    if (!recoveryRef.current?.jobId || latestRef.current.ocrBusy || !pageVisibleRef.current) return;
    try {
      const job = await getReceiptOcrJob(routeMetaRef.current.attemptId, recoveryRef.current.jobId);
      if (unloadedRef.current) return;
      setOcrJob(job);
      if (["succeeded", "partial"].includes(job.status)) await applyOcr(job);
      else if (["queued", "processing"].includes(job.status)) scheduleOcrPoll(0);
    } catch (resumeError) {
      if (unloadedRef.current) return;
      if (handleSessionError(resumeError)) return;
      setOcrError(safeMessage(resumeError, "暂时无法恢复识别进度，请重试"));
    }
  };

  // R69：退避轮询；离开页面暂停（pageVisible=false 回调直接返回不发请求）。
  const scheduleOcrPoll = (attempt) => {
    stopOcrPolling();
    if (!pageVisibleRef.current || !recoveryRef.current?.jobId) return;
    ocrTimerRef.current = setTimeout(async () => {
      if (!pageVisibleRef.current) return;
      try {
        const job = await getReceiptOcrJob(routeMetaRef.current.attemptId, recoveryRef.current.jobId);
        if (unloadedRef.current) return;
        setOcrJob(job);
        if (["succeeded", "partial"].includes(job.status)) await applyOcr(job);
        else if (["queued", "processing"].includes(job.status)) scheduleOcrPoll(attempt + 1);
      } catch (pollError) {
        if (unloadedRef.current) return;
        if (handleSessionError(pollError)) return;
        setOcrError("识别进度暂时中断，请点击恢复");
      }
    }, nextPollDelay(attempt));
  };

  // R70：同 job 幂等 + 必点保护；成功后整体替换行并推进 revision。
  const applyOcr = async (job) => {
    if (recoveryRef.current.appliedJobId === job.id || applyingJobIdRef.current === job.id) return;
    applyingJobIdRef.current = job.id;
    setOcrBusy(true);
    try {
      const result = await applyReceiptOcrJob(routeMetaRef.current.attemptId, job.id, recoveryRef.current.applyKey || secureUuid(), routeMetaRef.current.revision);
      if (unloadedRef.current) return;
      const applied = applyOcrDishesOnce({
        dishes: latestRef.current.dishes.map((dish, index) => serialiseDish(dish, index)),
        appliedJobIds: recoveryRef.current.appliedJobId ? [recoveryRef.current.appliedJobId] : [],
      }, job.id, result.dishes);
      updateRevision(result.revision);
      if (applied.applied) acceptServerDishes(applied.dishes);
      recoveryRef.current = { ...recoveryRef.current, appliedJobId: job.id };
      setOcrJob(result.job);
      persistLocal();
    } catch (applyError) {
      if (unloadedRef.current) return;
      if (handleSessionError(applyError)) return;
      setOcrError(safeMessage(applyError, "识别结果暂时无法带入，请重试"));
    } finally {
      applyingJobIdRef.current = null;
      setOcrBusy(false);
    }
  };

  const restoreOcr = () => { resumeOcr(); };

  const continueManual = () => {
    setOcrError("");
    scrollToSelector(".dish-list");
  };

  // ---------- 保存与导航（R73/R74/R75） ----------

  const showDishError = (id, message) => {
    applyDishes(latestRef.current.dishes.map((dish) => (dish.id === id ? projectDish({ ...dish, showError: true, foldOpen: true }) : dish)));
    setValidationMessage(message);
    scrollToId(`dish-${id}`);
  };

  const saveAndNavigate = async (destination) => {
    if (latestRef.current.saving) return;
    const serialised = latestRef.current.dishes.map((dish, index) => serialiseDish(dish, index));
    setSaving(true);
    setValidationMessage("");
    // R75：先存本地（synced=false），服务端成功才 markDraftSynced。
    saveDraft(routeMetaRef.current, { dishes: serialised });
    try {
      const result = await saveDishes(routeMetaRef.current.attemptId, { dishes: serialised, revision: routeMetaRef.current.revision });
      if (unloadedRef.current) return;
      updateRevision(result.revision);
      markDraftSynced(routeMetaRef.current, result.revision);
      dirtyRef.current = false;
      if (destination === "survey") routeToSurvey(false);
      else navigate(routeUrl("/other", routeMetaRef.current));
    } catch (saveError) {
      if (unloadedRef.current) return;
      if (handleSessionError(saveError)) return;
      const message = safeMessage(saveError, "暂时无法保存菜品，请重试");
      setValidationMessage(message);
      toast(message);
    } finally {
      setSaving(false);
    }
  };

  // R74：空白额外菜品阻断保存。
  const goBackToSurvey = () => {
    const blank = latestRef.current.dishes.find(isBlankExtraDish);
    if (blank) { showDishError(blank.id, "请补全这道额外菜品，或点击删除"); return; }
    saveAndNavigate("survey");
  };

  // R73：五道校验按固定顺序短路，全过才保存跳转。
  const goNext = () => {
    if (receiptRequired && readyReceiptCount(latestRef.current.receipts) < 1) {
      setValidationMessage("该任务要求上传至少一张消费小票");
      scrollToSelector(".receipt-section");
      return;
    }
    if (latestRef.current.pendingReceipts.some((item) => ["local_selected", "uploading", "confirming"].includes(item.status))) {
      setValidationMessage("请等待小票上传完成，或删除未完成的图片");
      return;
    }
    const review = latestRef.current.dishes.find((dish) => requiredReviewMessage(dish));
    if (review) { showDishError(review.id, requiredReviewMessage(review)); return; }
    const amountInvalid = latestRef.current.dishes.find((dish) => dish.amountError);
    if (amountInvalid) { showDishError(amountInvalid.id, amountInvalid.amountError); return; }
    const invalid = latestRef.current.dishes
      .map((dish) => ({ id: dish.id, message: validateDish(dish) }))
      .find((item) => item.message);
    if (invalid) {
      applyDishes(latestRef.current.dishes.map((dish) => projectDish({ ...dish, showError: true, foldOpen: true })));
      showDishError(invalid.id, invalid.message);
      return;
    }
    saveAndNavigate("other");
  };

  const retry = () => { load(); };
  const retryReceipts = () => { loadReceipts(); };

  // ---------- 生命周期（onLoad / onUnload 等价，PM 适配点 4） ----------

  useEffect(() => {
    // StrictMode 双挂载：重挂载恢复 false；真实卸载仍由 cleanup 置 true。
    unloadedRef.current = false;
    const params = routeQuery();
    const assignmentId = params.get("assignmentId") || "";
    const attemptId = params.get("attemptId") || "";
    const questionnaireVersionId = params.get("questionnaireVersionId") || "";
    if (!assignmentId || !attemptId || !questionnaireVersionId) {
      setLoading(false);
      setError("未找到菜品记录，请从问卷重新进入");
      return () => { unloadedRef.current = true; };
    }
    routeMetaRef.current = {
      assignmentId,
      attemptId,
      questionnaireVersionId,
      revision: Number(params.get("revision") || 0),
    };
    pageVisibleRef.current = true;
    load();
    return () => {
      // R72/PM 适配点 4：onUnload 等价——停轮询；脏/有待传/有恢复任务才写草稿（脱敏后）。
      unloadedRef.current = true;
      pageVisibleRef.current = false;
      stopOcrPolling();
      if (dirtyRef.current || latestRef.current.pendingReceipts.length || recoveryRef.current?.jobId) persistLocal();
      // 仅回收已不属于任何待传项的 blob URL（重挂载恢复需沿用存留项的 URL）。
      const aliveIds = new Set(latestRef.current.pendingReceipts.map((item) => item.clientFileId));
      objectUrlsRef.current.forEach((ownerId, url) => {
        if (!aliveIds.has(ownerId)) URL.revokeObjectURL(url);
      });
      objectUrlsRef.current = new Map();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // R16：OCR 门控渲染期重求值（publicConfig 异步晚到时随 context 更新补显面板）。
  const ocrEnabled = isReceiptOcrEnabled(publicConfig);
  const viewState = loading ? "loading" : error ? "error" : "ready";

  return (
    <div className="app-page app-page--flat" data-page="dishes" data-state={viewState} data-receipt-locked={receiptLocked ? "true" : "false"}>
      <PageNav title="菜品记录" onBack={goBackToSurvey} />
      {/* 三步流程条：第 2 步 active（§1.9 a） */}
      <FlowSteps current="dishes" />

      {loading ? (
        <Card><Muted>正在加载菜品要求…</Muted></Card>
      ) : error ? (
        <Card>
          <div className="inline-error">{error}</div>
          {routeMetaRef.current ? (
            <div style={{ marginTop: 12 }}>
              <Button onClick={retry}>重新加载</Button>
            </div>
          ) : null}
        </Card>
      ) : (
        <>
          {/* ---------- 消费小票区（§1.9 a.3） ---------- */}
          <Card className="receipt-section">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
              <SectionHeading>{receiptRequired ? <span><span className="required">*</span> 消费小票</span> : "消费小票"}</SectionHeading>
              <Muted>最多 9 张图片，每张不超过 10MB</Muted>
            </div>
            <div style={{ marginTop: 2, fontSize: 12, color: "#70747b" }}>{readyCount} 张已完成</div>

            {receiptLoading ? <div style={{ marginTop: 8, fontSize: 13, color: "#70747b" }}>正在加载消费小票…</div> : null}
            {receiptError ? (
              <div className="error-bar" role="alert" style={{ marginTop: 8 }}>
                <span>{receiptError}</span>
                {!receiptLocked ? <button type="button" className="error-bar__retry" onClick={retryReceipts}>重试</button> : null}
              </div>
            ) : null}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 10 }}>
              {receipts.map((receipt, index) => (
                <div key={receipt.id} className="card" style={{ margin: 0, aspectRatio: "3 / 4", padding: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => previewReceipt(receipt.previewUrl)}
                    disabled={!receipt.previewUrl}
                    aria-label={`查看第${index + 1}张消费小票`}
                    style={{ flex: 1, border: "none", padding: 0, background: "#f2f3f5", borderRadius: 6, cursor: receipt.previewUrl ? "pointer" : "default", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#b7bac0" }}
                  >
                    {receipt.previewUrl ? <img src={receipt.previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (receipt.status === "failed" ? "上传失败" : "正在处理")}
                  </button>
                  <div style={{ fontSize: 11, color: "#70747b", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{receipt.statusLabel}</span>
                    <span style={{ display: "flex", gap: 4 }}>
                      {receipt.status === "failed" && receipt.canRetry ? (
                        <Button variant="link" small disabled={receiptBusy} onClick={() => replaceFailedReceipt(receipt.id)}>重新选择</Button>
                      ) : null}
                      {receipt.canDelete ? (
                        <button type="button" aria-label={`删除第${index + 1}张消费小票`} disabled={receiptBusy} onClick={() => deleteReceipt(receipt.id)} style={{ border: "none", background: "none", color: "#e45136", cursor: receiptBusy ? "default" : "pointer", padding: 0, fontSize: 14 }}>×</button>
                      ) : null}
                    </span>
                  </div>
                </div>
              ))}

              {pendingReceipts.map((receipt, index) => (
                <div key={receipt.clientFileId} className="card" style={{ margin: 0, aspectRatio: "3 / 4", padding: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => previewReceipt(receipt.localPath)}
                    aria-label={`查看待上传消费小票${index + 1}`}
                    style={{ flex: 1, border: "none", padding: 0, background: "#f2f3f5", borderRadius: 6, cursor: "pointer", overflow: "hidden" }}
                  >
                    <img src={receipt.localPath} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  </button>
                  <div style={{ fontSize: 11, color: "#70747b" }}>
                    <span>{receipt.statusLabel}</span>
                    <span style={{ marginLeft: 4 }}>{receipt.progressText}</span>
                  </div>
                  {["uploading", "confirming"].includes(receipt.status) ? (
                    <div style={{ height: 3, background: "#e8e9eb", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${receipt.progressPercent}%`, height: "100%", background: "#f25f42" }} />
                    </div>
                  ) : null}
                  {receipt.status === "failed" ? (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                      <span className="inline-error" style={{ flex: 1 }}>{receipt.message}</span>
                      <Button variant="link" small onClick={() => retryUpload(receipt.clientFileId)}>重试</Button>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    aria-label="移除待上传消费小票"
                    disabled={receipt.status === "uploading" || receipt.status === "confirming"}
                    onClick={() => removePending(receipt.clientFileId)}
                    style={{ border: "none", background: "none", color: "#70747b", cursor: receipt.status === "uploading" || receipt.status === "confirming" ? "default" : "pointer", padding: 0, fontSize: 14, alignSelf: "flex-end" }}
                  >×</button>
                </div>
              ))}

              {canAddReceipt ? (
                <button
                  type="button"
                  disabled={receiptBusy}
                  onClick={chooseReceipts}
                  aria-label="选择消费小票图片"
                  style={{ aspectRatio: "3 / 4", border: "1px dashed #dedfe2", borderRadius: 6, background: "#f7f7f7", cursor: receiptBusy ? "default" : "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, color: "#b7bac0" }}
                >
                  <span style={{ fontSize: 22 }}>＋</span>
                  <span style={{ fontSize: 12 }}>添加小票</span>
                </button>
              ) : null}
            </div>

            {/* PM 适配点 1：隐藏 file input（添加可多选；换图单选） */}
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png" multiple style={{ display: "none" }} onChange={onFilesChosen} />
            <input ref={replaceInputRef} type="file" accept="image/jpeg,image/png" style={{ display: "none" }} onChange={onReplaceFileChosen} />

            {/* OCR 面板（R15：门控 receiptOcr；R16：渲染期重求值配置晚到补显） */}
            {ocrEnabled ? (
              <Card data-gate="receiptOcr" style={{ marginTop: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <SectionHeading>小票菜品识别</SectionHeading>
                  <Muted>{ocrView.label}</Muted>
                </div>
                <div style={{ marginTop: 8 }}>
                  {!ocrJob || ocrJob.status === "failed" ? (
                    <Button small disabled={ocrBusy || readyCount === 0} onClick={startOcr}>
                      {ocrJob && ocrJob.status === "failed" ? "重新识别" : "识别并带入菜品"}
                    </Button>
                  ) : ocrError ? (
                    <Button small disabled={ocrBusy} onClick={restoreOcr}>恢复识别</Button>
                  ) : null}
                </div>
              </Card>
            ) : null}
            {ocrError ? (
              <div className="error-bar" role="alert" style={{ marginTop: 8 }}>
                <span>{ocrError}</span>
                <button type="button" className="error-bar__retry" onClick={continueManual}>继续手工填写</button>
              </div>
            ) : null}
          </Card>

          {/* ---------- 菜品列表（§1.9 a.4） ---------- */}
          <Card className="dish-list" style={{ marginTop: 8 }}>
            <SectionHeading>菜品记录</SectionHeading>
            {dishes.length === 0 ? <div style={{ marginTop: 8 }}><Muted>暂无菜品，请在下方添加。</Muted></div> : null}
            {dishes.map((dish, index) => (
              <div
                key={dish.id}
                id={`dish-${dish.id}`}
                className={dish.error ? "dish-block dish-block--error" : "dish-block"}
                style={{ padding: "12px 0", borderBottom: "1px solid #e8e9eb" }}
              >
                <div style={{ fontSize: 12, color: "#70747b" }}>第{index + 1}道菜</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                  {dish.active ? (
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      value={dish.actualName}
                      placeholder="输入菜品名称"
                      aria-label={`第${index + 1}道菜的实际菜名`}
                      autoFocus={focusDishId === dish.id}
                      onChange={(event) => input(dish.id, "actualName", event.target.value)}
                      onBlur={() => blur(dish.id)}
                    />
                  ) : (
                    <div className="input" style={{ flex: 1, background: "#f7f7f7", color: "#b7bac0" }}>
                      {dish.fulfillmentStatus === "unavailable" ? "售罄，不填写实际菜名" : "未点，不填写实际菜名"}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                  {/* R53：状态选项按 requirementId/required/allowSubstitution 推导；额外行禁用 */}
                  <select
                    className="select"
                    style={{ width: 110 }}
                    value={dish.statusOptions.some((option) => option.value === dish.fulfillmentStatus) ? dish.fulfillmentStatus : dish.statusOptions[0]?.value}
                    disabled={!dish.requirementId}
                    onChange={(event) => status(dish.id, event.target.value)}
                    aria-label={`第${index + 1}道菜的菜品状态`}
                  >
                    {dish.statusOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <span className="tag">{dish.requirementLabel}</span>
                  {dish.active ? (
                    <button
                      type="button"
                      className={`chip ${dish.fullySatisfied ? "chip--active" : ""}`}
                      title={dish.satisfactionText}
                      aria-label={`第${index + 1}道菜，${dish.satisfactionText}，点击切换`}
                      onClick={() => satisfied(dish.id)}
                    >
                      {dish.fullySatisfied ? "☺ 满意" : "☹ 未满意"}
                    </button>
                  ) : null}
                </div>

                {/* 业务标签行（§1.9 a.4） */}
                <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                  {dish.fromReceipt ? <span className="tag">来自小票</span> : null}
                  {dish.needsReview ? <span className="tag">请核对</span> : null}
                  {dish.priceDerived ? <span className="tag">系统推算</span> : null}
                  {dish.manuallyModified ? <span className="tag">已人工修改</span> : null}
                </div>

                {dish.plannedName ? (
                  <div style={{ marginTop: 6, fontSize: 13, color: "#70747b" }}>
                    任务菜品：{dish.plannedName}
                    {dish.instruction ? <span style={{ marginLeft: 6 }}>{dish.instruction}</span> : null}
                  </div>
                ) : null}

                {dish.fulfillmentStatus === "substituted" ? (
                  <label className="field" style={{ marginTop: 6 }}>
                    <span className="field__label"><span className="required">*</span> 替代原因</span>
                    <textarea
                      className="textarea"
                      value={dish.substitutionReason}
                      placeholder="说明原菜品和替代原因"
                      aria-label={`第${index + 1}道菜的替代原因`}
                      onChange={(event) => input(dish.id, "substitutionReason", event.target.value)}
                    />
                  </label>
                ) : null}
                {dish.fulfillmentStatus === "unavailable" ? (
                  <label className="field" style={{ marginTop: 6 }}>
                    <span className="field__label"><span className="required">*</span> 售罄原因</span>
                    <textarea
                      className="textarea"
                      value={dish.unavailableReason}
                      placeholder="记录现场告知的售罄原因"
                      aria-label={`第${index + 1}道菜的售罄原因`}
                      onChange={(event) => input(dish.id, "unavailableReason", event.target.value)}
                    />
                  </label>
                ) : null}

                {dish.foldOpen ? (
                  <>
                    {dish.active ? (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 8 }}>
                        <label className="field">
                          <span className="field__label">数量</span>
                          <input
                            className="input"
                            inputMode="numeric"
                            value={dish.quantityInput}
                            aria-label={`第${index + 1}道菜的数量`}
                            onChange={(event) => quantityInput(dish.id, event.target.value)}
                            onBlur={() => quantityBlur(dish.id)}
                          />
                        </label>
                        <label className="field">
                          <span className="field__label">单价（元）</span>
                          <input
                            className="input"
                            inputMode="decimal"
                            value={dish.unitPriceYuan}
                            placeholder="选填"
                            aria-label={`第${index + 1}道菜的单价`}
                            onChange={(event) => moneyInput(dish.id, "unitPriceYuan", event.target.value)}
                            onBlur={() => moneyBlur(dish.id, "unitPriceYuan")}
                          />
                        </label>
                        <label className="field">
                          <span className="field__label">行总价（元）</span>
                          <input
                            className="input"
                            inputMode="decimal"
                            value={dish.lineTotalYuan}
                            placeholder="选填"
                            aria-label={`第${index + 1}道菜的行总价`}
                            onChange={(event) => moneyInput(dish.id, "lineTotalYuan", event.target.value)}
                            onBlur={() => moneyBlur(dish.id, "lineTotalYuan")}
                          />
                        </label>
                      </div>
                    ) : null}
                    {dish.active ? (
                      <textarea
                        className="textarea"
                        style={{ marginTop: 8 }}
                        value={dish.evaluation}
                        placeholder="记录上菜时间、外观、温度、味道、份量、口感和其他现场观察"
                        aria-label={`第${index + 1}道菜的评价`}
                        onChange={(event) => input(dish.id, "evaluation", event.target.value)}
                      />
                    ) : null}
                  </>
                ) : null}

                {dish.active && !dish.foldOpen ? (
                  <button type="button" className="list-row" style={{ marginTop: 8 }} onClick={() => toggleFold(dish.id)} aria-label={`展开第${index + 1}道菜的数量价格与评价`}>
                    <span>数量 ×{dish.quantity} · 单价 ¥{dish.unitPriceYuan} · 合计 ¥{dish.lineTotalYuan}</span>
                    <span>核对修改 ⌄</span>
                  </button>
                ) : null}

                {dish.error || dish.amountError ? <div className="inline-error" role="alert" style={{ marginTop: 6 }}>{dish.error || dish.amountError}</div> : null}

                {/* R60：仅额外菜品（无 requirementId）可删除 */}
                {!dish.requirementId ? (
                  <Button variant="link" small onClick={() => remove(dish.id)}>删除这道菜品</Button>
                ) : null}
              </div>
            ))}

            <Button variant="outline" block style={{ marginTop: 10 }} disabled={saving} onClick={add}>+ 点击添加其他菜品</Button>
          </Card>

          {validationMessage ? <div className="inline-error" role="alert" style={{ marginTop: 8 }}>{validationMessage}</div> : null}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 8, marginTop: 8 }}>
            <Button variant="outline" disabled={saving} onClick={goBackToSurvey}>{saving ? "保存中…" : "上一步：答题"}</Button>
            <Button disabled={saving} onClick={goNext}>下一步：其他记录</Button>
          </div>
        </>
      )}

      {/* PM 适配点 1：小票全屏预览遮罩（行内放大，替代 wx.previewImage/window.open） */}
      {previewUrl ? (
        <div
          role="dialog"
          aria-label="消费小票预览"
          onClick={() => setPreviewUrl("")}
          style={{ position: "fixed", inset: 0, background: "rgba(20,21,24,.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, cursor: "zoom-out", padding: 16 }}
        >
          <img src={previewUrl} alt="消费小票" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 }} />
        </div>
      ) : null}
    </div>
  );
}

/* ---------- 模块级投影/序列化/工具（等价 miniapp index.js:401-433，Web 适配点见注释） ---------- */

// R51：服务端 dishes 空时按 dishRequirements 派生初始行。
function buildServerDishes(result) {
  if (result.dishes?.length) return result.dishes;
  return (result.dishRequirements || []).map((item) => ({ id: item.recordId || secureUuid(), requirementId: item.id, plannedName: item.plannedName || item.dishName || "", actualName: item.plannedName || item.dishName || "", quantity: item.quantity || 1, unitPriceCents: null, lineTotalCents: null, fulfillmentStatus: "ordered", substitutionReason: "", unavailableReason: "", evaluation: "", fullySatisfied: false, required: Boolean(item.required), allowSubstitution: Boolean(item.allowSubstitution), instruction: item.instruction || "", source: "manual", manuallyModified: false, priceDerived: false, reviewFields: [] }));
}

// 行数据与要求（或现有行）富化匹配：缺失字段以参照补齐（miniapp js:405-409）。
function enrichDish(dish, requirements) {
  const requirement = requirements.find((item) => item.id === dish.requirementId || item.requirementId === dish.requirementId);
  if (!requirement) return dish;
  return { ...dish, plannedName: dish.plannedName || requirement.plannedName || requirement.dishName || "", quantity: dish.quantity || requirement.quantity || 1, required: Boolean(requirement.required), allowSubstitution: Boolean(requirement.allowSubstitution), instruction: requirement.instruction || dish.instruction || "" };
}

// R53：状态选项推导 + 折叠规则 + 派生视图字段（miniapp js:410-419）。
function projectDish(dish) {
  const statusOptions = dish.requirementId
    ? ALL_STATUSES.filter((item) => item.value !== "extra" && (!dish.required || item.value !== "skipped") && (dish.allowSubstitution || item.value !== "substituted"))
    : ALL_STATUSES.filter((item) => item.value === "extra");
  const statusIndex = Math.max(0, statusOptions.findIndex((item) => item.value === dish.fulfillmentStatus));
  const active = ["ordered", "substituted", "extra"].includes(dish.fulfillmentStatus);
  const reviewFields = dish.reviewFields || [];
  // 折叠规则：数量单价齐备且无需核对、无评价的菜品默认收起为摘要行；foldOpen 纯视图不进草稿。
  const foldOpen = dish.foldOpen ?? !(active && reviewFields.length === 0 && dish.unitPriceCents != null && Number(dish.quantity) > 0 && !dish.evaluation?.trim());
  return {
    ...dish,
    source: dish.source || "manual",
    manuallyModified: Boolean(dish.manuallyModified),
    priceDerived: Boolean(dish.priceDerived),
    reviewFields,
    quantityInput: dish.quantityInput ?? String(dish.quantity || 1),
    unitPriceYuan: dish.unitPriceYuan ?? formatCentsToYuan(dish.unitPriceCents),
    lineTotalYuan: dish.lineTotalYuan ?? formatCentsToYuan(dish.lineTotalCents),
    statusOptions,
    statusIndex,
    statusLabel: statusOptions[statusIndex]?.label || "状态待确认",
    requirementLabel: dish.requirementId ? (dish.required ? "必点" : "建议") : "额外菜品",
    active,
    foldOpen,
    error: dish.showError ? (dish.amountError || requiredReviewMessage(dish) || validateDish(dish)) : "",
    satisfactionText: dish.fullySatisfied ? "已选择全部满意" : "未选择全部满意",
    fromReceipt: dish.source === "ocr",
    needsReview: reviewFields.length > 0,
  };
}

// R75 序列化规则：非 active 行 actualName/evaluation 空串、fullySatisfied 仅 active、
// substituted/unavailable 仅输出各自原因、sortOrder 下标+1。
function serialiseDish(dish, index = 0) {
  const active = ["ordered", "substituted", "extra"].includes(dish.fulfillmentStatus);
  return {
    id: dish.id,
    requirementId: dish.requirementId || null,
    sortOrder: index + 1,
    plannedName: dish.plannedName || null,
    actualName: active ? dish.actualName?.trim() || "" : "",
    quantity: Number(dish.quantity || 1),
    unitPriceCents: dish.unitPriceCents ?? null,
    lineTotalCents: dish.lineTotalCents ?? null,
    fulfillmentStatus: dish.fulfillmentStatus,
    substitutionReason: dish.fulfillmentStatus === "substituted" ? dish.substitutionReason?.trim() || "" : "",
    unavailableReason: dish.fulfillmentStatus === "unavailable" ? dish.unavailableReason?.trim() || "" : "",
    evaluation: active ? dish.evaluation?.trim() || "" : "",
    fullySatisfied: active && Boolean(dish.fullySatisfied),
    required: Boolean(dish.required),
    allowSubstitution: Boolean(dish.allowSubstitution),
    source: dish.source || "manual",
    manuallyModified: Boolean(dish.manuallyModified),
    priceDerived: Boolean(dish.priceDerived),
    reviewFields: dish.reviewFields || [],
  };
}

function projectReceipt(item) {
  return { ...item, origin: "server", statusLabel: RECEIPT_STATUS_LABELS[item.status] || "状态待确认", progressText: `${item.progressPercent}%` };
}

function projectPendingReceipt(item) {
  return { ...item, origin: "local", statusLabel: RECEIPT_STATUS_LABELS[item.status] || "等待上传", progressText: `${item.progressPercent || 0}%` };
}

// R72：pendingReceipts 持久化脱敏——剔除 uploadTarget 与运行时 File（Web 侧新增 file 字段）。
function stripPendingSecrets(item) {
  const { uploadTarget, file, ...safe } = item;
  return safe;
}

function fileMeta(item) {
  return { clientFileId: item.clientFileId, fileName: item.fileName, mimeType: item.mimeType, sizeBytes: item.sizeBytes };
}

// PM 适配点 1：png（file.type 或 .png 后缀）→ image/png，否则 image/jpeg。
function receiptMime(file) {
  return String(file.type || "").toLowerCase() === "image/png" || String(file.name || "").toLowerCase().endsWith(".png")
    ? "image/png"
    : "image/jpeg";
}

function receiptName(file) {
  return String(file.name || "").split("/").pop() || "receipt.jpg";
}

// R89：技术词过滤。
function safeMessage(error, fallback) {
  return typeof error?.message === "string" && !/\/api\/|http\s*\d|token|revision|stack|provider|request.?id/i.test(error.message)
    ? error.message
    : fallback;
}

function routeUrl(path, meta) {
  return `${path}?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}`;
}

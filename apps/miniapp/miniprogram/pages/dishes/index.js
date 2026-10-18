import {
  applyReceiptOcrJob, completeHighlightPhotoUpload, completeReceiptUpload, createReceiptOcrJob,
  deleteHighlightPhoto, deleteReceiptAttachment, getAssignment, getDraft, getReceiptOcrJob,
  initHighlightPhotoUpload, initializeReceiptUpload, listReceiptAttachments, saveDishes,
  saveOtherRecords, uploadToSignedTarget,
} from "../../services/api.js";
import { getDraft as getLocalDraft, markDraftSynced, saveDraft as saveLocalDraft } from "../../store/survey.js";
import { parentIsPage, sanitizeSource } from "../../utils/navigation.js";
import { firstIncompleteQuestion, isBlankExtraDish, secureUuid, validateDish } from "../../utils/business.js";
import {
  applyOcrDishesOnce, deriveLineTotal, formatCentsToYuan, markDishEdited, nextPollDelay,
  occupiedReceiptCount, ocrStatusView, parseYuanToCents, readyReceiptCount,
  receiptDeletionOptions, requiredReviewMessage, validateReceiptFiles,
} from "../../features/receipt-ocr.js";

const ALL_STATUSES = [
  { value: "ordered", label: "已点" }, { value: "substituted", label: "替代" },
  { value: "unavailable", label: "售罄" }, { value: "skipped", label: "未点" },
  { value: "extra", label: "额外菜品" },
];
const RECEIPT_STATUS_LABELS = { uploading: "上传中", ready: "上传完成", failed: "上传失败", local_selected: "等待上传", confirming: "正在确认" };
// 闪光点有界上限（与服务端 contracts HIGHLIGHT_ENTRY_LIMIT/HIGHLIGHT_PHOTO_LIMIT 对齐）。
const HIGHLIGHT_ENTRY_LIMIT = 5;
const HIGHLIGHT_PHOTO_LIMIT = 4;
// 待传闪光点照片的临时文件缓存（条目 id → [clientFileId]，页面实例级；persistLocal 已脱敏）。

Page({
  data: {
    meta: null, dishes: [], receipts: [], pendingReceipts: [], receiptRequired: false,
    highlights: [], highlightBusy: false, dishEnabled: false, highlightEntryLimit: 5, highlightPhotoLimit: 4,
    receiptLoading: false, receiptBusy: false, receiptError: "", readyCount: 0, canAddReceipt: true,
    ocrEnabled: false, ocrJob: null, ocrView: ocrStatusView(null), ocrBusy: false, ocrError: "",
    saving: false, loading: true, error: "", validationMessage: "", focusDishId: "",
    statusBarHeight: 20, navBarHeight: 44,
  },

  // OCR 入口显隐由服务端 client-config（features.receiptOcr）动态下发：
  // publicConfig 是启动后异步到达的，页面可能先于它渲染，因此 onLoad/onShow 都重新求值；
  // 配置未到达前保守隐藏，手动填写菜品流程不受任何影响。
  syncOcrEntry() {
    const enabled = Boolean(getApp()?.globalData?.publicConfig?.features?.receiptOcr);
    if (this.data.ocrEnabled !== enabled) this.setData({ ocrEnabled: enabled });
    // 菜品区块显隐（features.dishRecords，默认关）：关闭时菜品不渲染、不校验、不保存，
    // 历史菜品行原样留在服务端，也绝不因隐藏流程阻断前进/提交。
    const dishEnabled = getApp()?.globalData?.publicConfig?.features?.dishRecords === true;
    if (this.data.dishEnabled !== dishEnabled) this.setData({ dishEnabled });
  },

  async onLoad(options) {
    this.setData(navigationMetrics());
    this.syncOcrEntry();
    if (!options.assignmentId || !options.attemptId || !options.questionnaireVersionId) {
      this.setData({ loading: false, error: "未找到菜品记录，请从问卷重新进入" }); return;
    }
    this.routeMeta = { assignmentId: options.assignmentId, attemptId: options.attemptId, questionnaireVersionId: options.questionnaireVersionId, revision: Number(options.revision || 0) };
    // 任务链来源（问卷写入）：只读回跳任务详情时原样带回。
    this.source = sanitizeSource(options.source);
    this.pageVisible = true;
    await this.load();
  },

  async load() {
    this.stopOcrPolling();
    this.setData({ loading: true, error: "", validationMessage: "" });
    try {
      const assignment = await getAssignment(this.routeMeta.assignmentId);
      if (assignment.status === "submitted") return this.closeSubmitted();
      const result = await getDraft(this.routeMeta.attemptId);
      if (result.attempt.id !== this.routeMeta.attemptId || result.questionnaireVersion.id !== this.routeMeta.questionnaireVersionId) throw new Error("问卷信息已更新，请从任务详情重新进入");
      if (["submitting", "processing", "submitted"].includes(result.attempt.status)) return this.closeSubmitted();
      const missing = firstIncompleteQuestion(result.questions, result.answers || {});
      if (missing) { wx.showToast({ title: `请先完成第 ${missing.number} 题`, icon: "none", duration: 3000 }); this.routeToSurvey(true); return; }

      const meta = { ...this.routeMeta, revision: result.attempt.revision };
      const local = getLocalDraft(meta);
      const serverDishes = buildServerDishes(result);
      const useLocal = local.synced === false && local.dishes?.length;
      const dishes = (useLocal ? local.dishes : serverDishes).map((dish) => projectDish(enrichDish(dish, result.dishRequirements || [])));
      const recovery = local.receiptRecovery || {};
      const pendingReceipts = (recovery.pendingReceipts || []).filter((item) => item.localPath).map(projectPendingReceipt);
      // 闪光点：本地未同步优先；否则采用服务端结构化条目；无结构化条目时按旧单条
      // highlight 字符串兜底为一条未持久化条目（首次保存落库，历史数据不丢）。
      // synced 标志是 dishes/highlights 共用语义：两边都以服务端为准才整体置已同步。
      const useLocalHighlights = local.synced === false && Array.isArray(local.highlights);
      const highlights = useLocalHighlights ? local.highlights.map(rehydrateHighlight) : buildServerHighlights(result.otherRecords || {});
      if (!useLocal) saveLocalDraft(meta, { dishes: dishes.map(serialiseDish) });
      if (!useLocalHighlights) saveLocalDraft(meta, { highlights: highlights.map(serializeHighlight) });
      if (!useLocal && !useLocalHighlights) markDraftSynced(meta, meta.revision);
      this.routeMeta = meta;
      this.dirty = Boolean(useLocal) || !(result.dishes || []).length;
      this.recovery = { jobId: recovery.jobId || null, applyKey: recovery.applyKey || null, appliedJobId: recovery.appliedJobId || null };
      this.setData({ meta, dishes, pendingReceipts, highlights, receiptRequired: Boolean(assignment.receiptRequired), loading: false });
      await this.loadReceipts();
      if (this.recovery.jobId) await this.resumeOcr();
    } catch (error) { this.setData({ loading: false, error: safeMessage(error, "暂时无法加载菜品记录，请重试") }); }
  },

  async loadReceipts() {
    this.setData({ receiptLoading: true, receiptError: "" });
    try {
      const result = await listReceiptAttachments(this.routeMeta.attemptId);
      this.updateRevision(result.revision);
      this.setReceiptState(result.items);
    } catch (error) {
      // attempt 已提交后（如提交与浏览并发）小票列表接口返回 409 终态：
      // 给出固定文案并锁定重试入口，不把冲突当普通失败裸报错。
      if (error.kind === "questionnaire_submitted") { this.setData({ receiptError: error.message, receiptLocked: true }); return; }
      this.setData({ receiptError: safeMessage(error, "暂时无法加载消费小票，请重试") });
      this.refreshReceiptProjection();
    } finally { this.setData({ receiptLoading: false }); }
  },

  retry() { this.load(); },
  retryReceipts() { this.loadReceipts(); },

  input(event) {
    const { id, field } = event.currentTarget.dataset;
    const dish = this.data.dishes.find((item) => item.id === id);
    if (!dish) return;
    const next = dish.source === "ocr" ? markDishEdited(dish, field, event.detail.value) : { ...dish, [field]: event.detail.value };
    this.patchDish(id, next, dish.showError, true);
  },

  moneyInput(event) {
    const { id, field } = event.currentTarget.dataset;
    const dish = this.data.dishes.find((item) => item.id === id);
    if (!dish) return;
    const next = markDishEdited(dish, field, event.detail.value);
    this.patchDish(id, { ...next, amountError: "" }, dish.showError, true);
  },

  moneyBlur(event) {
    const { id, field } = event.currentTarget.dataset;
    const centsField = field === "unitPriceYuan" ? "unitPriceCents" : "lineTotalCents";
    const dish = this.data.dishes.find((item) => item.id === id);
    if (!dish) return;
    try {
      const cents = parseYuanToCents(dish[field]);
      let patch = { [centsField]: cents, [field]: formatCentsToYuan(cents), amountError: "", manuallyModified: dish.source === "ocr" || dish.manuallyModified, reviewFields: (dish.reviewFields || []).filter((item) => item !== centsField) };
      if (centsField === "lineTotalCents") patch.priceDerived = false;
      else if (dish.lineTotalCents === null || dish.priceDerived) Object.assign(patch, deriveLineTotal(Number(dish.quantity), cents, null), { lineTotalYuan: formatCentsToYuan(deriveLineTotal(Number(dish.quantity), cents, null).lineTotalCents) });
      this.patchDish(id, patch, dish.showError);
    } catch (error) { this.patchDish(id, { amountError: error.message }, true); }
  },

  quantityInput(event) {
    const dish = this.data.dishes.find((item) => item.id === event.currentTarget.dataset.id);
    if (!dish) return;
    const value = event.detail.value;
    this.patchDish(dish.id, { quantityInput: value, manuallyModified: dish.source === "ocr" || dish.manuallyModified, reviewFields: (dish.reviewFields || []).filter((item) => item !== "quantity"), amountError: "" }, dish.showError);
  },

  quantityBlur(event) {
    const dish = this.data.dishes.find((item) => item.id === event.currentTarget.dataset.id);
    if (!dish) return;
    const quantity = Number(dish.quantityInput);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999) { this.patchDish(dish.id, { amountError: "请输入 1 到 999 的整数数量" }, true); return; }
    try {
      const derived = dish.priceDerived ? deriveLineTotal(quantity, dish.unitPriceCents, null) : {};
      this.patchDish(dish.id, { quantity, quantityInput: String(quantity), ...derived, ...(derived.lineTotalCents !== undefined ? { lineTotalYuan: formatCentsToYuan(derived.lineTotalCents) } : {}), amountError: "" }, dish.showError);
    } catch (error) { this.patchDish(dish.id, { amountError: error.message }, true); }
  },

  blur(event) { if (this.data.focusDishId === event.currentTarget.dataset.id) this.setData({ focusDishId: "" }); },

  status(event) {
    const id = event.currentTarget.dataset.id;
    const dish = this.data.dishes.find((item) => item.id === id);
    const option = dish?.statusOptions?.[Number(event.detail.value)];
    if (!dish || !option) return;
    const patch = { fulfillmentStatus: option.value, manuallyModified: dish.source === "ocr" || dish.manuallyModified };
    if (option.value === "ordered") Object.assign(patch, { actualName: dish.actualName || dish.plannedName || "", substitutionReason: "", unavailableReason: "" });
    if (option.value === "substituted") patch.unavailableReason = "";
    if (["unavailable", "skipped"].includes(option.value)) Object.assign(patch, { actualName: "", substitutionReason: "", evaluation: "", fullySatisfied: false });
    if (option.value === "skipped") patch.unavailableReason = "";
    this.patchDish(id, patch, true);
  },

  satisfied(event) {
    const dish = this.data.dishes.find((item) => item.id === event.currentTarget.dataset.id);
    if (dish) this.patchDish(dish.id, { fullySatisfied: !dish.fullySatisfied, manuallyModified: dish.source === "ocr" || dish.manuallyModified }, true);
  },

  // 纯视图切换：展开/收起数量价格与评价区，不改变脏标记、不触发草稿保存。
  toggleFold(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ dishes: this.data.dishes.map((dish) => dish.id === id ? { ...dish, foldOpen: !dish.foldOpen } : dish) });
  },

  add() {
    try {
      const id = secureUuid();
      const dish = projectDish({ id, requirementId: null, plannedName: "", actualName: "", quantity: 1, unitPriceCents: null, lineTotalCents: null, fulfillmentStatus: "extra", substitutionReason: "", unavailableReason: "", evaluation: "", fullySatisfied: false, required: false, allowSubstitution: false, source: "manual", manuallyModified: false, priceDerived: false, reviewFields: [], showError: false });
      this.dirty = true;
      this.setData({ dishes: [...this.data.dishes, dish], focusDishId: id, validationMessage: "" }, () => { this.persistLocal(); wx.pageScrollTo({ selector: `#dish-${id}`, duration: 240 }); });
    } catch { wx.showToast({ title: "当前环境不支持安全创建记录，请升级微信", icon: "none" }); }
  },

  remove(event) {
    const id = event.currentTarget.dataset.id;
    const dish = this.data.dishes.find((item) => item.id === id);
    if (!dish || dish.requirementId) return;
    wx.showModal({ title: "删除这道菜品？", content: dish.source === "ocr" ? "菜品将从最终填写记录中删除，小票原始识别结果仍由系统保留。" : "已填写的菜名和评价会一起删除。", confirmText: "删除", confirmColor: "#e45136", success: (result) => {
      if (!result.confirm) return;
      this.dirty = true; this.setData({ dishes: this.data.dishes.filter((item) => item.id !== id), validationMessage: "" }); this.persistLocal();
    } });
  },

  chooseReceipts() {
    if (this.data.receiptBusy || !this.data.canAddReceipt) return;
    const remaining = 9 - occupiedReceiptCount(this.data.receipts, this.data.pendingReceipts);
    wx.chooseMedia({ count: remaining, mediaType: ["image"], sourceType: ["album", "camera"], success: async (result) => {
      const files = await inspectReceiptFiles(result.tempFiles || []);
      const validation = validateReceiptFiles(occupiedReceiptCount(this.data.receipts, this.data.pendingReceipts), files);
      if (validation) { wx.showToast({ title: validation, icon: "none", duration: 3000 }); return; }
      const pending = files.map((file) => projectPendingReceipt({ clientFileId: secureUuid(), localPath: file.tempFilePath, sizeBytes: file.size, mimeType: receiptMime(file), fileName: receiptName(file.tempFilePath), status: "local_selected", progressPercent: 0, message: "等待上传" }));
      this.setData({ pendingReceipts: [...this.data.pendingReceipts, ...pending], receiptError: "" }); this.persistLocal(); this.refreshReceiptProjection();
      for (const item of pending) await this.uploadPending(item.clientFileId);
    }, fail: (error) => { if (!String(error.errMsg || "").includes("cancel")) wx.showToast({ title: "暂时无法选择图片，请重试", icon: "none" }); } });
  },

  async uploadPending(clientFileId) {
    const pending = this.data.pendingReceipts.find((item) => item.clientFileId === clientFileId);
    if (!pending || this.data.receiptBusy) return;
    this.setData({ receiptBusy: true });
    try {
      let current = { ...pending, status: "uploading", message: "准备上传", progressPercent: 1 };
      this.updatePending(current);
      let target = current.uploadTarget;
      if (!target) {
        const init = await initializeReceiptUpload(this.routeMeta.attemptId, fileMeta(current), this.routeMeta.revision);
        // 用户可能在等待期间移除该图片：取消后放弃回填，避免已删除的小票复活。
        if (this.cancelledUploads?.has(clientFileId)) return;
        this.updateRevision(init.revision);
        this.mergeReceipt(init.attachment);
        current = { ...current, attachmentId: init.attachment.id, uploadTarget: init.uploadTarget };
        target = init.uploadTarget; this.updatePending(current);
      }
      const uploaded = await uploadToSignedTarget(target, current.localPath, (progress) => this.updatePending({ ...current, status: "uploading", progressPercent: progress, message: `正在上传 ${progress}%` }));
      if (this.cancelledUploads?.has(clientFileId)) return;
      current = { ...current, status: "confirming", progressPercent: 100, message: "正在确认上传" }; this.updatePending(current);
      const completed = await completeReceiptUpload(this.routeMeta.attemptId, current.attachmentId, { ...fileMeta(current), etag: uploaded.etag }, this.routeMeta.revision);
      if (this.cancelledUploads?.has(clientFileId)) return;
      this.updateRevision(completed.revision);
      if (completed.attachment) this.mergeReceipt(completed.attachment);
      if (completed.items) this.setReceiptState(completed.items);
      this.setData({ pendingReceipts: this.data.pendingReceipts.filter((item) => item.clientFileId !== clientFileId), receiptError: "" });
      this.persistLocal(); this.refreshReceiptProjection();
    } catch (error) {
      const current = this.data.pendingReceipts.find((item) => item.clientFileId === clientFileId);
      if (current) this.updatePending({ ...current, status: "failed", message: safeMessage(error, "暂时无法上传小票，请重试") });
    } finally { this.setData({ receiptBusy: false }); this.refreshReceiptProjection(); }
  },

  retryUpload(event) { const id = event.currentTarget.dataset.id; this.cancelledUploads?.delete(id); this.uploadPending(id); },
  // 移除待上传图片时登记取消：仍在途的上传完成回调检查该集合后放弃回填。
  removePending(event) {
    const id = event.currentTarget.dataset.id;
    this.cancelledUploads = this.cancelledUploads || new Set();
    this.cancelledUploads.add(id);
    this.setData({ pendingReceipts: this.data.pendingReceipts.filter((item) => item.clientFileId !== id) });
    this.persistLocal(); this.refreshReceiptProjection();
  },

  replaceFailedReceipt(event) {
    const attachment = this.data.receipts.find((item) => item.id === event.currentTarget.dataset.id);
    if (!attachment?.canRetry || this.data.receiptBusy) return;
    wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], success: async (result) => {
      const files = await inspectReceiptFiles(result.tempFiles || []);
      if (!files.length) return;
      const validation = validateReceiptFiles(Math.max(0, occupiedReceiptCount(this.data.receipts, this.data.pendingReceipts) - 1), files);
      if (validation) { wx.showToast({ title: validation, icon: "none" }); return; }
      this.setData({ receiptBusy: true, receiptError: "" });
      try {
        const removed = await deleteReceiptAttachment(this.routeMeta.attemptId, attachment.id, "keep_as_manual", this.routeMeta.revision);
        this.updateRevision(removed.revision); this.setReceiptState(removed.items || this.data.receipts.filter((item) => item.id !== attachment.id));
        if (removed.dishes) this.acceptServerDishes(removed.dishes);
        const file = files[0];
        const pending = projectPendingReceipt({ clientFileId: secureUuid(), localPath: file.tempFilePath, sizeBytes: file.size, mimeType: receiptMime(file), fileName: receiptName(file.tempFilePath), status: "local_selected", progressPercent: 0, message: "等待上传" });
        this.setData({ pendingReceipts: [...this.data.pendingReceipts, pending] }); this.persistLocal();
        this.setData({ receiptBusy: false }); await this.uploadPending(pending.clientFileId);
      } catch (error) { this.setData({ receiptError: safeMessage(error, "暂时无法重新上传小票，请重试") }); }
      finally { this.setData({ receiptBusy: false }); this.refreshReceiptProjection(); }
    } });
  },

  previewReceipt(event) {
    const current = event.currentTarget.dataset.url;
    const urls = [...this.data.receipts.map((item) => item.previewUrl), ...this.data.pendingReceipts.map((item) => item.localPath)].filter(Boolean);
    if (current) wx.previewImage({ current, urls });
  },

  deleteReceipt(event) {
    const attachment = this.data.receipts.find((item) => item.id === event.currentTarget.dataset.id);
    if (!attachment?.canDelete || this.data.receiptBusy) return;
    const choices = receiptDeletionOptions(attachment);
    if (choices.length === 1) {
      wx.showModal({ title: "删除这张消费小票？", content: attachment.appliedDishCount ? "已带入的菜品会保留并转为手工记录。" : "删除后需要重新选择图片才能恢复。", confirmText: "删除", confirmColor: "#e45136", success: (result) => { if (result.confirm) this.confirmDeleteReceipt(attachment, choices[0]); } });
      return;
    }
    wx.showActionSheet({ itemList: ["同时移除未修改的识别菜品", "保留菜品，转为手工记录"], success: (result) => this.confirmDeleteReceipt(attachment, choices[result.tapIndex]) });
  },

  async confirmDeleteReceipt(attachment, dishHandling) {
    if (!dishHandling) return;
    this.setData({ receiptBusy: true, receiptError: "" });
    try {
      const result = await deleteReceiptAttachment(this.routeMeta.attemptId, attachment.id, dishHandling, this.routeMeta.revision);
      this.updateRevision(result.revision);
      this.setReceiptState(result.items || this.data.receipts.filter((item) => item.id !== attachment.id));
      if (result.dishes) this.acceptServerDishes(result.dishes);
    } catch (error) { this.setData({ receiptError: safeMessage(error, "暂时无法删除小票，请重试") }); }
    finally { this.setData({ receiptBusy: false }); }
  },

  async startOcr() {
    if (this.data.ocrBusy) return;
    const attachmentIds = this.data.receipts.filter((item) => item.status === "ready").map((item) => item.id);
    if (!attachmentIds.length) { wx.showToast({ title: "请先完成消费小票上传", icon: "none" }); return; }
    try {
      this.stopOcrPolling(); this.setData({ ocrBusy: true, ocrError: "" });
      const idempotencyKey = secureUuid();
      const job = await createReceiptOcrJob(this.routeMeta.attemptId, attachmentIds, idempotencyKey, this.routeMeta.revision);
      this.recovery = { jobId: job.id, applyKey: secureUuid(), appliedJobId: null };
      this.setOcrJob(job); this.persistLocal();
      if (["succeeded", "partial"].includes(job.status)) await this.applyOcr(job);
      else if (["queued", "processing"].includes(job.status)) this.scheduleOcrPoll(0);
    } catch (error) { this.setData({ ocrError: safeMessage(error, "暂时无法开始识别，请重试") }); }
    finally { this.setData({ ocrBusy: false }); }
  },

  async resumeOcr() {
    if (!this.recovery?.jobId || this.data.ocrBusy || !this.pageVisible) return;
    try {
      const job = await getReceiptOcrJob(this.routeMeta.attemptId, this.recovery.jobId);
      this.setOcrJob(job);
      if (["succeeded", "partial"].includes(job.status)) await this.applyOcr(job);
      else if (["queued", "processing"].includes(job.status)) this.scheduleOcrPoll(0);
    } catch (error) { this.setData({ ocrError: safeMessage(error, "暂时无法恢复识别进度，请重试") }); }
  },

  scheduleOcrPoll(attempt) {
    this.stopOcrPolling();
    if (!this.pageVisible || !this.recovery?.jobId) return;
    this.ocrTimer = setTimeout(async () => {
      if (!this.pageVisible) return;
      try {
        const job = await getReceiptOcrJob(this.routeMeta.attemptId, this.recovery.jobId);
        this.setOcrJob(job);
        if (["succeeded", "partial"].includes(job.status)) await this.applyOcr(job);
        else if (["queued", "processing"].includes(job.status)) this.scheduleOcrPoll(attempt + 1);
      } catch (error) { this.setData({ ocrError: safeMessage(error, "识别进度暂时中断，请点击恢复") }); }
    }, nextPollDelay(attempt));
  },

  async applyOcr(job) {
    if (this.recovery.appliedJobId === job.id || this.applyingJobId === job.id) return;
    this.applyingJobId = job.id; this.setData({ ocrBusy: true });
    try {
      const result = await applyReceiptOcrJob(this.routeMeta.attemptId, job.id, this.recovery.applyKey || secureUuid(), this.routeMeta.revision);
      const applied = applyOcrDishesOnce({ dishes: this.serialiseDishes(), appliedJobIds: this.recovery.appliedJobId ? [this.recovery.appliedJobId] : [] }, job.id, result.dishes);
      this.updateRevision(result.revision);
      if (applied.applied) this.acceptServerDishes(applied.dishes);
      this.recovery.appliedJobId = job.id; this.setOcrJob(result.job); this.persistLocal();
    } catch (error) { this.setData({ ocrError: safeMessage(error, "识别结果暂时无法带入，请重试") }); }
    finally { this.applyingJobId = null; this.setData({ ocrBusy: false }); }
  },

  restoreOcr() { this.resumeOcr(); },
  continueManual() { this.setData({ ocrError: "" }); wx.pageScrollTo({ selector: ".dish-list", duration: 240 }); },
  setOcrJob(job) { this.setData({ ocrJob: job, ocrView: ocrStatusView(job), ocrError: job.status === "failed" ? ocrStatusView(job).label : "" }); },
  stopOcrPolling() { if (this.ocrTimer) clearTimeout(this.ocrTimer); this.ocrTimer = null; },

  async back() {
    // 菜品区块隐藏时不检查空白菜品——历史数据不阻断返回。
    if (this.data.dishEnabled) {
      const blank = this.data.dishes.find(isBlankExtraDish);
      if (blank) { this.showDishError(blank.id, "请补全这道额外菜品，或点击删除"); return; }
    }
    await this.saveAndNavigate("survey");
  },

  async next() {
    if (this.data.receiptRequired && readyReceiptCount(this.data.receipts) < 1) { this.setData({ validationMessage: "该任务要求上传至少一张消费小票" }); wx.pageScrollTo({ selector: ".receipt-section", duration: 240 }); return; }
    if (this.data.pendingReceipts.some((item) => ["local_selected", "uploading", "confirming"].includes(item.status))) { this.setData({ validationMessage: "请等待小票上传完成，或删除未完成的图片" }); return; }
    // 闪光点：在途照片先等传完；有照片无文字可恢复地拦下（补文字或删除该条均可通过）。
    const uploadingHighlight = this.data.highlights.flatMap((entry) => entry.pending || []).find((item) => ["local_selected", "uploading", "confirming"].includes(item.status));
    if (uploadingHighlight) { this.setData({ validationMessage: "请等待闪光点照片上传完成，或移除未完成的图片" }); return; }
    const textMissing = this.data.highlights.find((entry) => !(entry.text || "").trim() && (entry.photos || []).length > 0);
    if (textMissing) { this.setData({ validationMessage: "请为已添加照片的闪光点填写文字，或删除该条闪光点" }); wx.pageScrollTo({ selector: `#highlight-${textMissing.id}`, duration: 240 }); return; }
    // 菜品区块隐藏时跳过全部菜品校验（历史数据不阻断前进）。
    if (this.data.dishEnabled) {
      const review = this.data.dishes.find((dish) => requiredReviewMessage(dish));
      if (review) { this.showDishError(review.id, requiredReviewMessage(review)); return; }
      const amountInvalid = this.data.dishes.find((dish) => dish.amountError);
      if (amountInvalid) { this.showDishError(amountInvalid.id, amountInvalid.amountError); return; }
      const invalid = this.data.dishes.map((dish) => ({ id: dish.id, message: validateDish(dish) })).find((item) => item.message);
      if (invalid) { this.setData({ dishes: this.data.dishes.map((dish) => projectDish({ ...dish, showError: true, foldOpen: true })) }); this.showDishError(invalid.id, invalid.message); return; }
    }
    await this.saveAndNavigate("other");
  },

  async saveAndNavigate(destination) {
    if (this.data.saving) return;
    const dishes = this.serialiseDishes();
    this.setData({ saving: true, validationMessage: "" }); saveLocalDraft(this.routeMeta, { dishes, highlights: this.data.highlights.map(serializeHighlight) });
    try {
      // 闪光点整组落库（条目 id 即服务端行 id；空白条目服务端忽略，不产生脏行）。
      await this.persistHighlightsToServer();
      if (this.data.dishEnabled) {
        const result = await saveDishes(this.routeMeta.attemptId, { dishes, revision: this.routeMeta.revision });
        this.updateRevision(result.revision); markDraftSynced(this.routeMeta, result.revision);
      } else {
        markDraftSynced(this.routeMeta, this.routeMeta.revision);
      }
      this.dirty = false;
      if (destination === "survey") this.routeToSurvey(false); else wx.navigateTo({ url: `${routeUrl("/pages/other/index", this.routeMeta)}&source=${this.source || ""}` });
    } catch (error) { const message = safeMessage(error, "暂时无法保存，请重试"); this.setData({ validationMessage: message }); wx.showToast({ title: message, icon: "none", duration: 3000 }); }
    finally { this.setData({ saving: false }); }
  },

  // ---------- 闪光点编辑器（0..5 条，每条文字 + 选填照片 ≤4 张） ----------

  // 常规保存过滤完全空白条目（默认空白编辑器被忽略、零条可提交）；
  // 传图前保存用 includeIds 强制带上目标条目（此刻它文字为空且无照片，但必须先落库）。
  async persistHighlightsToServer(options = {}) {
    const includeIds = options.includeIds || [];
    const payload = this.data.highlights
      .filter((entry) => (entry.text || "").trim() || (entry.photos || []).length || (entry.pending || []).length || includeIds.includes(entry.id))
      .map((entry) => ({ id: entry.id, text: (entry.text || "").trim() }));
    if (!payload.length) return null;
    const saved = await saveOtherRecords(this.routeMeta.attemptId, { highlights: payload, revision: this.routeMeta.revision });
    this.updateRevision(saved.revision);
    this.setData({ highlights: this.data.highlights.map((entry) => ({ ...entry, persisted: payload.some((item) => item.id === entry.id) })) });
    this.persistLocal();
    return saved;
  },

  addHighlight() {
    if (this.data.highlights.length >= HIGHLIGHT_ENTRY_LIMIT) return;
    this.dirty = true;
    this.setData({ highlights: [...this.data.highlights, { id: secureUuid(), text: "", persisted: false, photos: [], pending: [] }], validationMessage: "" }, () => this.persistLocal());
  },

  removeHighlight(event) {
    const id = event.currentTarget.dataset.id;
    const entry = this.data.highlights.find((item) => item.id === id);
    if (!entry) return;
    const run = () => {
      this.dirty = true;
      this.setData({ highlights: this.data.highlights.filter((item) => item.id !== id), validationMessage: "" });
      this.persistLocal();
    };
    const hasContent = (entry.text || "").trim() || (entry.photos || []).length || (entry.pending || []).length;
    if (!hasContent) { run(); return; }
    wx.showModal({ title: "删除这条闪光点？", content: "已附照片会一起删除。", confirmText: "删除", confirmColor: "#e45136", success: (result) => { if (result.confirm) run(); } });
  },

  inputHighlight(event) {
    const id = event.currentTarget.dataset.id;
    this.dirty = true;
    this.setData({ highlights: this.data.highlights.map((entry) => (entry.id === id ? { ...entry, text: event.detail.value } : entry)), validationMessage: "" });
    this.persistLocal();
  },

  chooseHighlightPhoto(event) {
    const id = event.currentTarget.dataset.id;
    const entry = this.data.highlights.find((item) => item.id === id);
    if (!entry || this.data.highlightBusy) return;
    const remaining = HIGHLIGHT_PHOTO_LIMIT - (entry.photos || []).length - (entry.pending || []).length;
    if (remaining <= 0) return wx.showToast({ title: `每条闪光点最多上传 ${HIGHLIGHT_PHOTO_LIMIT} 张照片`, icon: "none" });
    wx.chooseMedia({ count: remaining, mediaType: ["image"], sourceType: ["album", "camera"], success: async (result) => {
      const files = (result.tempFiles || []).filter((file) => file.size <= 10 * 1024 * 1024);
      if (!files.length) return wx.showToast({ title: "单个文件不能超过 10MB", icon: "none" });
      if (files.length < (result.tempFiles || []).length) wx.showToast({ title: "超过 10MB 的图片已忽略", icon: "none" });
      try {
        // 照片必须挂到已落库条目：目标条目（此刻文字为空且无照片）先随整组强制落库。
        if (this.data.highlights.some((item) => !item.persisted || item.id === id)) {
          this.setData({ highlightBusy: true });
          await this.persistHighlightsToServer({ includeIds: [id] });
          this.setData({ highlightBusy: false });
        }
      } catch (error) {
        this.setData({ highlightBusy: false, validationMessage: safeMessage(error, "暂时无法保存闪光点，请重试") });
        wx.showToast({ title: safeMessage(error, "暂时无法保存闪光点，请重试"), icon: "none", duration: 3000 });
        return;
      }
      const pending = files.map((file) => ({ clientFileId: secureUuid(), localPath: file.tempFilePath, sizeBytes: file.size, mimeType: receiptMime(file), fileName: receiptName(file.tempFilePath), status: "local_selected", progressPercent: 0, message: "等待上传" }));
      this.dirty = true;
      this.setData({ highlights: this.data.highlights.map((entry) => (entry.id === id ? { ...entry, pending: [...(entry.pending || []), ...pending] } : entry)) });
      this.persistLocal();
      for (const item of pending) await this.uploadHighlightPhoto(id, item.clientFileId);
    }, fail: (error) => { if (!String(error.errMsg || "").includes("cancel")) wx.showToast({ title: "暂时无法选择图片，请重试", icon: "none" }); } });
  },

  async uploadHighlightPhoto(highlightId, clientFileId) {
    const entry = this.data.highlights.find((item) => item.id === highlightId);
    const pending = entry?.pending?.find((item) => item.clientFileId === clientFileId);
    if (!entry || !pending || this.data.highlightBusy) return;
    this.setData({ highlightBusy: true });
    const updatePending = (patch) => this.setData({ highlights: this.data.highlights.map((item) => (item.id === highlightId ? { ...item, pending: item.pending.map((pending) => (pending.clientFileId === clientFileId ? { ...pending, ...patch } : pending)) } : item)) });
    const markReadyAndCleanup = (readyPhoto, revision) => {
      if (revision !== undefined) this.updateRevision(revision);
      this.setData({ highlights: this.data.highlights.map((item) => (item.id === highlightId ? { ...item, persisted: true, photos: [...(item.photos || []), { id: readyPhoto.id, previewUrl: readyPhoto.previewUrl, status: "ready" }], pending: item.pending.filter((pending) => pending.clientFileId !== clientFileId) } : item)), validationMessage: "" });
      this.persistLocal();
    };
    try {
      // 重试语义与 H5 镜像：verifyPending 且已知 attachmentId（202）只重放 complete；确定性
      // 失败清标记走全链重 init；attachmentId 未知时绝不调 complete，只重试受保护的 init。
      const replayVerify = Boolean(pending.verifyPending && pending.attachmentId);
      if (replayVerify) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (this.cancelledHighlightUploads?.has(clientFileId)) return;
        const current = { ...pending, status: "confirming", progressPercent: 100, message: "正在确认上传" };
        updatePending(current);
        const completed = await completeHighlightPhotoUpload(this.routeMeta.attemptId, highlightId, current.attachmentId, { fileMeta: { clientFileId, fileName: current.fileName, mimeType: current.mimeType, sizeBytes: current.sizeBytes }, revision: this.routeMeta.revision });
        if (this.cancelledHighlightUploads?.has(clientFileId)) return;
        if (completed.status === "verifying") {
          updatePending({ ...current, status: "failed", verifyPending: true, message: "照片确认仍在进行，请稍候点击重试" });
          return;
        }
        markReadyAndCleanup(completed.photo, completed.revision);
        return;
      }
      const mustReinit = pending.status === "failed" || !pending.uploadTarget;
      let current = { ...pending, status: "uploading", message: "准备上传", progressPercent: 1 };
      updatePending(current);
      let target = current.uploadTarget;
      if (mustReinit || !target) {
        const init = await initHighlightPhotoUpload(this.routeMeta.attemptId, highlightId, { fileMeta: { clientFileId, fileName: current.fileName, mimeType: current.mimeType, sizeBytes: current.sizeBytes }, revision: this.routeMeta.revision });
        if (this.cancelledHighlightUploads?.has(clientFileId)) return;
        this.updateRevision(init.revision);
        current = { ...current, attachmentId: init.attachmentId, uploadTarget: init.uploadTarget, initReadyPhoto: init.uploadTarget ? null : init.photo };
        target = init.uploadTarget;
        updatePending(current);
      }
      if (!target) {
        const readyPhoto = current.initReadyPhoto || { id: current.attachmentId, previewUrl: null };
        markReadyAndCleanup(readyPhoto);
        return;
      }
      const uploaded = await uploadToSignedTarget(target, current.localPath, (progress) => updatePending({ ...current, status: "uploading", progressPercent: progress, message: `正在上传 ${progress}%` }));
      if (this.cancelledHighlightUploads?.has(clientFileId)) return;
      current = { ...current, status: "confirming", progressPercent: 100, message: "正在确认上传" };
      updatePending(current);
      const completed = await completeHighlightPhotoUpload(this.routeMeta.attemptId, highlightId, current.attachmentId, { fileMeta: { clientFileId, fileName: current.fileName, mimeType: current.mimeType, sizeBytes: current.sizeBytes, etag: uploaded.etag }, revision: this.routeMeta.revision });
      if (this.cancelledHighlightUploads?.has(clientFileId)) return;
      if (completed.status === "verifying") {
        updatePending({ ...current, status: "failed", verifyPending: true, message: "照片确认仍在进行，请稍候点击重试" });
        return;
      }
      markReadyAndCleanup(completed.photo, completed.revision);
    } catch (error) {
      // 与 H5 镜像：verifyPending 仅对瞬时/显式 pending 保留（retryable 或「照片确认仍在进行」）；
      // 确定性失败（校验失败/STALE/不匹配）清标记让下一次重试重新 init 恢复；attachmentId
      // 未知时同样清标记——只重试受保护的 init，绝不凭空调 complete。
      const current = this.data.highlights.find((item) => item.id === highlightId)?.pending?.find((item) => item.clientFileId === clientFileId);
      if (current) {
        const transient = error?.kind === "network" || error?.kind === "timeout" || error?.retryable === true;
        const verifyStillPending = Boolean(current.verifyPending && current.attachmentId) && transient;
        updatePending({ ...current, status: "failed", verifyPending: verifyStillPending, message: safeMessage(error, "暂时无法上传照片，请重试") });
      }
    } finally { this.setData({ highlightBusy: false }); }
  },

  retryHighlightUpload(event) {
    const { id, fileId } = event.currentTarget.dataset;
    this.cancelledHighlightUploads = this.cancelledHighlightUploads || new Set();
    this.cancelledHighlightUploads.delete(fileId);
    this.uploadHighlightPhoto(id, fileId);
  },

  // 移除待传照片：init 已建立服务端附件时必须走删除端点释放 1..4 槽位并入队对象清理；
  // init 未完成的纯本地项仅本地移除。取消登记防在途回填复活。
  async removeHighlightPending(event) {
    const { id, fileId } = event.currentTarget.dataset;
    this.cancelledHighlightUploads = this.cancelledHighlightUploads || new Set();
    this.cancelledHighlightUploads.add(fileId);
    const pending = this.data.highlights.find((entry) => entry.id === id)?.pending?.find((item) => item.clientFileId === fileId);
    const dropLocal = () => {
      this.setData({ highlights: this.data.highlights.map((entry) => (entry.id === id ? { ...entry, pending: (entry.pending || []).filter((pending) => pending.clientFileId !== fileId) } : entry)) });
      this.persistLocal();
    };
    if (!pending?.attachmentId) { dropLocal(); return; }
    if (this.data.highlightBusy) return;
    this.setData({ highlightBusy: true });
    try {
      const result = await deleteHighlightPhoto(this.routeMeta.attemptId, id, pending.attachmentId, { revision: this.routeMeta.revision });
      this.updateRevision(result.revision);
      dropLocal();
    } catch (error) {
      const current = this.data.highlights.find((entry) => entry.id === id)?.pending?.find((item) => item.clientFileId === fileId);
      if (current) this.setData({ highlights: this.data.highlights.map((entry) => (entry.id === id ? { ...entry, pending: entry.pending.map((pending) => (pending.clientFileId === fileId ? { ...pending, status: "failed", message: safeMessage(error, "暂时无法移除照片，请重试") } : pending)) } : entry)) });
      wx.showToast({ title: safeMessage(error, "暂时无法移除照片，请重试"), icon: "none", duration: 3000 });
    } finally { this.setData({ highlightBusy: false }); }
  },

  async deleteHighlightPhotoItem(event) {
    const { id, photoId } = event.currentTarget.dataset;
    if (!this.data.highlights.find((entry) => entry.id === id) || this.data.highlightBusy) return;
    this.setData({ highlightBusy: true });
    try {
      const result = await deleteHighlightPhoto(this.routeMeta.attemptId, id, photoId, { revision: this.routeMeta.revision });
      this.updateRevision(result.revision);
      this.setData({ highlights: this.data.highlights.map((entry) => (entry.id === id ? { ...entry, photos: (entry.photos || []).filter((photo) => photo.id !== photoId) } : entry)) });
      this.persistLocal();
    } catch (error) { wx.showToast({ title: safeMessage(error, "暂时无法删除照片，请重试"), icon: "none", duration: 3000 }); }
    finally { this.setData({ highlightBusy: false }); }
  },

  showDishError(id, message) { this.setData({ dishes: this.data.dishes.map((dish) => dish.id === id ? projectDish({ ...dish, showError: true, foldOpen: true }) : dish), validationMessage: message }, () => wx.pageScrollTo({ selector: `#dish-${id}`, duration: 240 })); },
  patchDish(id, patch, showError = false, replace = false) { this.dirty = true; this.setData({ dishes: this.data.dishes.map((dish) => dish.id === id ? projectDish(replace ? { ...patch, showError: Boolean(showError || dish.showError) } : { ...dish, ...patch, showError: Boolean(showError || dish.showError) }) : dish), validationMessage: "" }); this.persistLocal(); },
  acceptServerDishes(dishes) { this.dirty = true; this.setData({ dishes: dishes.map((dish) => projectDish(enrichDish(dish, this.data.dishes))) }); this.persistLocal(); },
  persistLocal() { if (!this.routeMeta) return; try { saveLocalDraft(this.routeMeta, { dishes: this.serialiseDishes(), highlights: this.data.highlights.map(serializeHighlight), receiptRecovery: { pendingReceipts: this.data.pendingReceipts.map(stripPendingSecrets), ...this.recovery } }); } catch { /* The next authenticated request handles session loss. */ } },
  serialiseDishes() { return this.data.dishes.map(serialiseDish); },
  updatePending(next) { this.setData({ pendingReceipts: this.data.pendingReceipts.map((item) => item.clientFileId === next.clientFileId ? projectPendingReceipt(next) : item) }); this.persistLocal(); this.refreshReceiptProjection(); },
  mergeReceipt(attachment) { this.setReceiptState([...this.data.receipts.filter((item) => item.id !== attachment.id), attachment].sort((a, b) => a.displayOrder - b.displayOrder)); },
  setReceiptState(receipts) { this.setData({ receipts: receipts.map(projectReceipt) }); this.refreshReceiptProjection(); },
  refreshReceiptProjection() { const readyCount = readyReceiptCount(this.data.receipts); this.setData({ readyCount, canAddReceipt: occupiedReceiptCount(this.data.receipts, this.data.pendingReceipts) < 9 }); },
  updateRevision(revision) { if (!Number.isInteger(revision)) return; this.routeMeta = { ...this.routeMeta, revision }; this.setData({ meta: this.routeMeta }); },
  // 返回问卷：仅当紧邻父页确为同任务问卷才原生返回（问卄件仍存活，分类不丢）；
  // 直达进入/无关栈不算证据，此时 redirectTo 携全量参数的规范问卷页（R40 固定 category=product）。
  routeToSurvey(replace) { const url = `${routeUrl("/pages/survey/index", this.routeMeta)}&category=product&source=${this.source || ""}`; if (!replace && parentIsPage("pages/survey/index", { assignmentId: this.routeMeta.assignmentId, attemptId: this.routeMeta.attemptId })) wx.navigateBack(); else wx.redirectTo({ url }); },
  closeSubmitted() { wx.showToast({ title: "该问卷已关闭编辑", icon: "none" }); wx.redirectTo({ url: `/pages/task/index?assignmentId=${encodeURIComponent(this.routeMeta.assignmentId)}&source=${this.source || ""}` }); },
  onShow() { this.pageVisible = true; this.syncOcrEntry(); if (!this.data.loading && this.recovery?.jobId && !this.data.ocrView?.terminal) this.resumeOcr(); },
  onHide() { this.pageVisible = false; this.stopOcrPolling(); this.persistLocal(); },
  onUnload() { this.pageVisible = false; this.stopOcrPolling(); if (this.dirty || this.data.pendingReceipts.length || this.recovery?.jobId) this.persistLocal(); },
});

function buildServerDishes(result) {
  if (result.dishes?.length) return result.dishes;
  return (result.dishRequirements || []).map((item) => ({ id: item.recordId || secureUuid(), requirementId: item.id, plannedName: item.plannedName || item.dishName || "", actualName: item.plannedName || item.dishName || "", quantity: item.quantity || 1, unitPriceCents: null, lineTotalCents: null, fulfillmentStatus: "ordered", substitutionReason: "", unavailableReason: "", evaluation: "", fullySatisfied: false, required: Boolean(item.required), allowSubstitution: Boolean(item.allowSubstitution), instruction: item.instruction || "", source: "manual", manuallyModified: false, priceDerived: false, reviewFields: [] }));
}
function enrichDish(dish, requirements) {
  const requirement = requirements.find((item) => item.id === dish.requirementId || item.requirementId === dish.requirementId);
  if (!requirement) return dish;
  return { ...dish, plannedName: dish.plannedName || requirement.plannedName || requirement.dishName || "", quantity: dish.quantity || requirement.quantity || 1, required: Boolean(requirement.required), allowSubstitution: Boolean(requirement.allowSubstitution), instruction: requirement.instruction || dish.instruction || "" };
}
function projectDish(dish) {
  const statusOptions = dish.requirementId ? ALL_STATUSES.filter((item) => item.value !== "extra" && (!dish.required || item.value !== "skipped") && (dish.allowSubstitution || item.value !== "substituted")) : ALL_STATUSES.filter((item) => item.value === "extra");
  const statusIndex = Math.max(0, statusOptions.findIndex((item) => item.value === dish.fulfillmentStatus));
  const active = ["ordered", "substituted", "extra"].includes(dish.fulfillmentStatus);
  const reviewFields = dish.reviewFields || [];
  // 折叠规则：数量单价已齐备（多为小票识别带入）且无需核对、无评价的菜品收起为摘要行，
  // 点击摘要可展开核对修改；foldOpen 是纯视图状态，不进入草稿序列化。
  const foldOpen = dish.foldOpen ?? !(active && reviewFields.length === 0 && dish.unitPriceCents != null && Number(dish.quantity) > 0 && !dish.evaluation?.trim());
  return { ...dish, source: dish.source || "manual", manuallyModified: Boolean(dish.manuallyModified), priceDerived: Boolean(dish.priceDerived), reviewFields, quantityInput: dish.quantityInput ?? String(dish.quantity || 1), unitPriceYuan: dish.unitPriceYuan ?? formatCentsToYuan(dish.unitPriceCents), lineTotalYuan: dish.lineTotalYuan ?? formatCentsToYuan(dish.lineTotalCents), statusOptions, statusIndex, statusLabel: statusOptions[statusIndex]?.label || "状态待确认", requirementLabel: dish.requirementId ? (dish.required ? "必点" : "建议") : "额外菜品", active, foldOpen, error: dish.showError ? (dish.amountError || requiredReviewMessage(dish) || validateDish(dish)) : "", satisfactionText: dish.fullySatisfied ? "已选择全部满意" : "未选择全部满意", fromReceipt: dish.source === "ocr", needsReview: reviewFields.length > 0 };
}
function serialiseDish(dish, index = 0) {
  const active = ["ordered", "substituted", "extra"].includes(dish.fulfillmentStatus);
  return { id: dish.id, requirementId: dish.requirementId || null, sortOrder: index + 1, plannedName: dish.plannedName || null, actualName: active ? dish.actualName?.trim() || "" : "", quantity: Number(dish.quantity || 1), unitPriceCents: dish.unitPriceCents ?? null, lineTotalCents: dish.lineTotalCents ?? null, fulfillmentStatus: dish.fulfillmentStatus, substitutionReason: dish.fulfillmentStatus === "substituted" ? dish.substitutionReason?.trim() || "" : "", unavailableReason: dish.fulfillmentStatus === "unavailable" ? dish.unavailableReason?.trim() || "" : "", evaluation: active ? dish.evaluation?.trim() || "" : "", fullySatisfied: active && Boolean(dish.fullySatisfied), required: Boolean(dish.required), allowSubstitution: Boolean(dish.allowSubstitution), source: dish.source || "manual", manuallyModified: Boolean(dish.manuallyModified), priceDerived: Boolean(dish.priceDerived), reviewFields: dish.reviewFields || [] };
}
function projectReceipt(item) { return { ...item, origin: "server", statusLabel: RECEIPT_STATUS_LABELS[item.status] || "状态待确认", progressText: `${item.progressPercent}%` }; }
function projectPendingReceipt(item) { return { ...item, origin: "local", statusLabel: RECEIPT_STATUS_LABELS[item.status] || "等待上传", progressText: `${item.progressPercent || 0}%` }; }
// 闪光点条目序列化（进本地草稿）：pending 照片脱敏（剔除 uploadTarget），临时路径保留供恢复展示。
function serializeHighlight(entry) {
  return {
    id: entry.id,
    text: entry.text || "",
    persisted: Boolean(entry.persisted),
    photos: (entry.photos || []).map((photo) => ({ id: photo.id, previewUrl: photo.previewUrl || null, status: "ready" })),
    pending: (entry.pending || []).map(({ uploadTarget, initReadyPhoto, ...safe }) => safe),
  };
}
function rehydrateHighlight(entry) {
  return {
    id: entry.id,
    text: entry.text || "",
    persisted: Boolean(entry.persisted),
    photos: Array.isArray(entry.photos) ? entry.photos : [],
    pending: (Array.isArray(entry.pending) ? entry.pending : []).filter((item) => item.localPath),
  };
}
// 服务端结构化闪光点 → 编辑器条目；无结构化条目时按旧单条 highlight 字符串兜底为
// 一条未持久化条目（首次保存落库；零闪光点时返回单条空白编辑器由用户自行增删）。
function buildServerHighlights(otherRecords) {
  const serverEntries = Array.isArray(otherRecords?.highlights) ? otherRecords.highlights : [];
  if (serverEntries.length) {
    return serverEntries.map((item) => ({
      id: item.id,
      text: item.text || "",
      persisted: true,
      photos: (Array.isArray(item.photos) ? item.photos : []).map((photo) => ({ id: photo.id, previewUrl: photo.previewUrl || null, status: "ready" })),
      pending: [],
    }));
  }
  const legacy = String(otherRecords?.highlight || "").trim();
  if (!legacy) return [{ id: secureUuid(), text: "", persisted: false, photos: [], pending: [] }];
  return [{ id: secureUuid(), text: legacy, persisted: false, photos: [], pending: [] }];
}
function stripPendingSecrets(item) { const { uploadTarget, ...safe } = item; return safe; }
function fileMeta(item) { return { clientFileId: item.clientFileId, fileName: item.fileName, mimeType: item.mimeType, sizeBytes: item.sizeBytes }; }
function receiptMime(file) { return String(file.detectedType || "").toLowerCase() === "png" || String(file.tempFilePath).toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg"; }
function receiptName(path) { return String(path).split("/").pop() || "receipt.jpg"; }
function inspectReceiptFiles(files) { return Promise.all(files.map((file) => new Promise((resolve) => wx.getImageInfo({ src: file.tempFilePath, success: (info) => resolve({ ...file, fileType: info.type, detectedType: info.type }), fail: () => resolve(file) })))); }
function safeMessage(error, fallback) { return typeof error?.message === "string" && !/\/api\/|http\s*\d|token|revision|stack|provider|request.?id/i.test(error.message) ? error.message : fallback; }
function routeUrl(path, meta) { return `${path}?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}`; }
function navigationMetrics() { try { const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); const menu = wx.getMenuButtonBoundingClientRect?.(); const statusBarHeight = info.statusBarHeight || 20; const navBarHeight = menu ? Math.max(44, (menu.top - statusBarHeight) * 2 + menu.height) : 44; return { statusBarHeight, navBarHeight }; } catch { return { statusBarHeight: 20, navBarHeight: 44 }; } }

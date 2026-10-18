import { cancelIssue, completeEvidenceUpload, confirmIssue, createEditSession, getQuestionnaire, initEvidenceUpload, removeEvidence, updateEditSession, uploadToSignedTarget } from "../../services/api.js";
import { backToParentOrRedirect, sanitizeSource } from "../../utils/navigation.js";
import { secureUuid } from "../../utils/business.js";

Page({
  data: { meta: null, question: null, editSessionId: "", target: "unscored", remark: "", images: [], audios: [], recording: false, saving: false, loading: true, error: "" },
  async onLoad(options) {
    if (!options.assignmentId || !options.attemptId || !options.questionnaireVersionId || !options.questionId) { this.setData({ loading: false, error: "未找到题目，请返回问卷重试" }); return; }
    const meta = { assignmentId: options.assignmentId, attemptId: options.attemptId, questionnaireVersionId: options.questionnaireVersionId, revision: Number(options.revision || 0) };
    // 问卷写入的来源与当前分类：异常路径（父页缺失）redirectTo 重建问卷时保持来源链与选中分类。
    this.source = sanitizeSource(options.source);
    this.surveyCategory = options.category || "";
    this.setData({ meta, target: options.target || "unscored" });
    try {
      const draft = await getQuestionnaire(meta.assignmentId);
      const question = draft.questions.find((item) => item.id === options.questionId);
      if (!question) throw new Error("题目已更新，请刷新问卷后重试");
      const current = draft.answers?.[question.id];
      const session = await createEditSession(meta.attemptId, question.id, { baseAnswerRevision: current?.revision || 0, targetAnswer: this.data.target });
      const attachments = session.activeAttachments || current?.attachments || [];
      this.setData({ question, editSessionId: session.id, remark: session.draftIssueRemark ?? current?.remark ?? "", images: attachments.filter((item) => item.type === "image"), audios: attachments.filter((item) => item.type === "audio"), loading: false });
    } catch (error) { this.setData({ loading: false, error: error.message }); }
  },
  remark(event) { this.setData({ remark: event.detail.value }); },
  chooseImage() {
    // 问题照片所有题可选、选填；上限默认 4 张（服务端未配置 imageMaxCount 时同值）。
    const maxCount = this.data.question.evidence.imageMaxCount || 4;
    const remaining = maxCount - this.data.images.length;
    if (remaining <= 0) return this.message(`每题最多上传 ${maxCount} 张照片`);
    wx.chooseMedia({ count: remaining, mediaType: ["image"], sourceType: ["camera", "album"], success: (result) => result.tempFiles.forEach((file) => this.stageFile({ type: "image", path: file.tempFilePath, size: file.size })) });
  },
  toggleRecord() {
    const recorder = wx.getRecorderManager();
    // 全局 recorder 是单例，onStop 只在首次使用时注册一次，避免每次开始录音都追加监听导致重复上传。
    if (!this.recorderBound) {
      this.recorderBound = true;
      recorder.onStop((result) => { this.setData({ recording: false }); if (result.duration < 1000) this.message("录音至少需要 1 秒"); else this.stageFile({ type: "audio", path: result.tempFilePath, size: result.fileSize, durationSeconds: Math.ceil(result.duration / 1000) }); });
    }
    if (!this.data.recording) {
      if (this.data.audios.length >= 3) return this.message("每题最多上传 3 段音频");
      const maxSeconds = this.data.question.evidence.audioMaxDurationSeconds || 10;
      recorder.start({ duration: maxSeconds * 1000, format: "mp3" }); this.setData({ recording: true });
    } else recorder.stop();
  },
  async stageFile(file) {
    if (file.size > 10 * 1024 * 1024) return this.message("单个文件不能超过 10MB");
    const tempId = `local-${this.data.images.length + this.data.audios.length}`;
    const clientFileId = file.clientFileId || secureUuid();
    this.append(file.type, { id: tempId, clientFileId, type: file.type, path: file.path, size: file.size, durationSeconds: file.durationSeconds, status: "uploading", progressLabel: "正在上传" });
    try {
      const init = await initEvidenceUpload(this.data.meta.attemptId, this.data.question.id, this.data.editSessionId, { clientFileId, type: file.type, mimeType: evidenceMime(file), sizeBytes: file.size, durationSeconds: file.durationSeconds });
      await uploadToSignedTarget(init.uploadTarget, file.path);
      const completed = await completeEvidenceUpload(this.data.meta.attemptId, this.data.question.id, this.data.editSessionId, init.attachmentId, { uploadToken: init.uploadToken, sizeBytes: file.size, durationSeconds: file.durationSeconds });
      if (completed.status !== "staged_ready") throw new Error("附件尚未确认，请重试");
      this.replace(file.type, tempId, { ...completed, id: init.attachmentId, clientFileId, type: file.type, path: file.path, size: file.size, durationSeconds: file.durationSeconds, status: "staged_ready", progressLabel: "上传成功" });
    } catch (error) { this.replace(file.type, tempId, { id: tempId, type: file.type, path: file.path, status: "failed", progressLabel: error.message }); }
  },
  retryUpload(event) { const item = [...this.data.images, ...this.data.audios].find((entry) => entry.id === event.currentTarget.dataset.id); if (item) { this.removeLocal(item.type, item.id); this.stageFile({ type: item.type, path: item.path, size: item.size || 0, durationSeconds: item.durationSeconds }); } },
  async deleteEvidence(event) { const { id, type } = event.currentTarget.dataset; const item = [...this.data.images, ...this.data.audios].find((entry) => entry.id === id); if (!item) return; if (!id.startsWith("local-")) { try { await removeEvidence(this.data.meta.attemptId, this.data.question.id, this.data.editSessionId, id); } catch (error) { return this.message(error.message); } } this.removeLocal(type, id); },
  play(event) { const item = this.data.audios.find((entry) => entry.id === event.currentTarget.dataset.id); if (!item?.path && !item?.previewUrl) return; // 音频实例复用单例，页面卸载时统一销毁，避免每次播放泄漏一个 InnerAudioContext。
    this.audio = this.audio || wx.createInnerAudioContext(); this.audio.src = item.path || item.previewUrl; this.audio.play(); },
  onUnload() { if (this.audio) { this.audio.destroy(); this.audio = null; } if (!this.sessionSettled && this.data.editSessionId) cancelIssue(this.data.meta.attemptId, this.data.question.id, this.data.editSessionId).catch(() => {}); },
  // 返回问卷：紧邻父页确为同任务问卷才原生返回；直达进入/无关栈不算证据，
  // 此时 redirectTo 携全量参数（含分类）的规范问卷页，绝不落到无关任务或空栈报错。
  backToSurvey() {
    const meta = this.data.meta;
    if (!meta) return;
    const category = this.surveyCategory ? `&category=${encodeURIComponent(this.surveyCategory)}` : "";
    backToParentOrRedirect({
      parentRoute: "pages/survey/index",
      meta: { assignmentId: meta.assignmentId, attemptId: meta.attemptId },
      fallbackUrl: `/pages/survey/index?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}&source=${this.source || ""}${category}`,
    });
  },
  async save() {
    if (this.data.target === "unscored") {
      // 问题照片选填：历史 imageRequired 配置不再作为确认门槛；音频要求保持既有口径。
      if (!this.data.remark.trim()) return this.message("请填写问题说明");
      if (this.data.question.evidence.audioRequired && !this.data.audios.some((item) => ["active", "staged_ready"].includes(item.status))) return this.message("请先上传成功的问题音频");
      if ([...this.data.images, ...this.data.audios].some((item) => item.status === "uploading")) return this.message("请等待附件上传完成");
    }
    this.setData({ saving: true });
    try {
      await updateEditSession(this.data.meta.attemptId, this.data.question.id, this.data.editSessionId, { draftIssueRemark: this.data.target === "unscored" ? this.data.remark.trim() : "", revision: this.data.meta.revision });
      await confirmIssue(this.data.meta.attemptId, this.data.question.id, this.data.editSessionId, { answer: this.data.target, revision: this.data.meta.revision });
      this.sessionSettled = true; this.backToSurvey();
    } catch (error) { this.message(error.message); }
    finally { this.setData({ saving: false }); }
  },
  async cancel() { if (!this.data.editSessionId) return this.backToSurvey(); try { await cancelIssue(this.data.meta.attemptId, this.data.question.id, this.data.editSessionId); this.sessionSettled = true; this.backToSurvey(); } catch (error) { this.message(error.message); } },
  append(type, item) { const field = type === "image" ? "images" : "audios"; this.setData({ [field]: [...this.data[field], item] }); },
  replace(type, id, item) { const field = type === "image" ? "images" : "audios"; this.setData({ [field]: this.data[field].map((entry) => entry.id === id ? item : entry) }); },
  removeLocal(type, id) { const field = type === "image" ? "images" : "audios"; this.setData({ [field]: this.data[field].filter((entry) => entry.id !== id) }); },
  message(title) { wx.showToast({ title, icon: "none", duration: 3000 }); },
});

// 附件真实类型：按临时文件扩展名区分 png/jpeg（相机/相册可能返回 png），音频为 mp3。
function evidenceMime(file) {
  if (file.type === "audio") return "audio/mpeg";
  return String(file.path || "").toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

import { API, assertAssignment, assertAssignmentList, assertEditSession, assertObject, assertQuestionnaire, assertReceiptList, assertReceiptMutation, assertReceiptOcrApply, assertReceiptOcrJob, assertReceiptUploadInit, assertRevision, assertStart, assertSubmit, assertUploadInit } from "./contracts.generated.js";
import { clearSessionAndUserCache, getSession, saveSession } from "../store/session.js";
import { createAssignmentCache } from "../store/assignments-cache.js";

const pending = new Map();
const TIMEOUT_MS = 12000;
// 任务列表短时缓存：按 userId 隔离，默认 15 秒；登录/退出/401 清空。
const assignmentCache = createAssignmentCache();

export class BusinessError extends Error {
  constructor(kind, message, details = {}) { super(message); this.name = "BusinessError"; this.kind = kind; this.retryable = Boolean(details.retryable); this.requiresNewToken = Boolean(details.requiresNewToken); }
}

function presentError(statusCode, payload) {
  const code = payload?.error?.code;
  if (code === "SMS_CODE_INVALIDATED" || code === "SMS_CODE_ATTEMPTS_EXHAUSTED") return new BusinessError("sms_invalidated", "验证码已失效，请重新发送并完成人机验证");
  if (code === "QUESTIONNAIRE_SUBMITTED") return new BusinessError("questionnaire_submitted", "任务已提交，小票不可再查看或修改");
  if (code === "CAPTCHA_EXPIRED") return new BusinessError("captcha_rejected", "验证已过期，请重新验证");
  if (code === "CAPTCHA_REJECTED" || code === "CAPTCHA_CANCELLED") return new BusinessError("captcha_rejected", "验证未通过，请重新验证");
  if (statusCode === 401) return new BusinessError("session", "登录已失效，请重新登录");
  if (statusCode === 403) return new BusinessError("forbidden", "你没有权限进行此操作");
  // 409 的具体原因由服务端给出（未到开始时间 / 需先打卡 / 内容已更新等），直接透出后端中文文案。
  if (statusCode === 409) return new BusinessError("conflict", payload?.error?.message || "内容已更新，请刷新后重试", { requiresNewToken: payload?.error?.requiresNewToken });
  if (statusCode >= 500) return new BusinessError("service", "服务暂时不可用，请稍后重试", { retryable: true });
  if (code === "RECEIPT_LIMIT_EXCEEDED") return new BusinessError("validation", "最多只能上传 9 张消费小票");
  if (code === "RECEIPT_FILE_INVALID") return new BusinessError("validation", "请选择 10MB 以内的图片");
  return new BusinessError("validation", "操作未完成，请检查填写内容");
}

function request({ url, method = "GET", data, validate = assertObject, dedupeKey }) {
  const key = dedupeKey || `${method}:${url}`;
  if (pending.has(key)) return pending.get(key);
  const promise = new Promise((resolve, reject) => {
    const session = getSession();
    const task = wx.request({
      url: `${getApp().globalData.apiBase}${url}`, method, data,
      timeout: TIMEOUT_MS,
      header: { Accept: "application/json", "Content-Type": "application/json", ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}) },
      success(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = presentError(response.statusCode, response.data);
          if (error.kind === "session") { clearSessionAndUserCache(); assignmentCache.clear(); setTimeout(() => wx.reLaunch({ url: "/pages/login/index" }), 0); }
          reject(error); return;
        }
        try { resolve(validate ? validate(response.data) : response.data); }
        catch { reject(new BusinessError("contract", "服务返回的数据暂时无法使用，请稍后重试")); }
      },
      fail(error) { reject(new BusinessError(error.errMsg?.includes("timeout") ? "timeout" : "network", error.errMsg?.includes("timeout") ? "请求超时，请检查网络后重试" : "暂时无法连接服务，请检查网络后重试", { retryable: true })); },
    });
    if (!task) reject(new BusinessError("network", "暂时无法连接服务，请稍后重试", { retryable: true }));
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export async function login(credentials) { const result = await request({ url: API.auth.login, method: "POST", data: credentials }); saveSession(result); getApp().globalData.session = result; assignmentCache.clear(); return result; }
export async function logout() { try { await request({ url: API.auth.logout, method: "POST" }); } finally { clearSessionAndUserCache(); assignmentCache.clear(); } }
export function requestRegisterCode(payload) { return request({ url: API.auth.registerPhoneCode, method: "POST", data: payload }); }
export function register(payload) { return request({ url: API.auth.register, method: "POST", data: payload }); }
export function resubmitRegistration(payload) { return request({ url: API.auth.registrationResubmit, method: "POST", data: payload }); }
export function requestPasswordCode(payload) { return request({ url: API.auth.passwordCode, method: "POST", data: payload }); }
export function verifyPasswordCode(payload) { return request({ url: API.auth.passwordVerify, method: "POST", data: payload }); }
export function completePasswordReset(payload) { return request({ url: API.auth.passwordComplete, method: "POST", data: payload }); }
// 任务列表：默认最多 15 秒短时缓存（按当前账号隔离）；force 跳过缓存。
// 并发请求由 request() 的 pending Map 复用；登录/退出/401 清空缓存。
export function getMyAssignments({ force = false } = {}) {
  const userId = getSession()?.user?.id;
  const cached = assignmentCache.get(userId, { force });
  if (cached) return Promise.resolve(cached.items);
  const promise = request({ url: API.assignments.mine, validate: assertAssignmentList }).then((items) => { assignmentCache.set(userId, items); return items; });
  return promise;
}
export function getAssignment(assignmentId) { return request({ url: API.assignments.byId(assignmentId), validate: assertAssignment }); }
export function checkIn(assignmentId, location) { return request({ url: API.assignments.checkIn(assignmentId), method: "POST", data: location, dedupeKey: `checkin:${assignmentId}` }); }
export function startAssignment(assignmentId) { return request({ url: API.assignments.start(assignmentId), method: "POST", validate: assertStart, dedupeKey: `start:${assignmentId}` }); }
export function getQuestionnaire(assignmentId) { return request({ url: API.assignments.questionnaire(assignmentId), validate: assertQuestionnaire }); }
export function getDraft(attemptId) { return request({ url: API.drafts.byId(attemptId), validate: assertQuestionnaire }); }
export function saveAnswer(attemptId, questionId, answer) { return request({ url: API.drafts.answer(attemptId, questionId), method: "PUT", data: answer, validate: assertRevision, dedupeKey: `answer:${attemptId}:${questionId}` }); }
export function createEditSession(attemptId, questionId, payload) { return request({ url: API.drafts.editSessions(attemptId, questionId), method: "POST", data: payload, validate: assertEditSession }); }
export function updateEditSession(attemptId, questionId, editSessionId, payload) { return request({ url: API.drafts.editSession(attemptId, questionId, editSessionId), method: "PATCH", data: payload }); }
export function initEvidenceUpload(attemptId, questionId, editSessionId, payload) { return request({ url: API.drafts.evidenceUploads(attemptId, questionId, editSessionId), method: "POST", data: payload, validate: assertUploadInit }); }
export function completeEvidenceUpload(attemptId, questionId, editSessionId, attachmentId, payload) { return request({ url: API.drafts.evidenceComplete(attemptId, questionId, editSessionId, attachmentId), method: "POST", data: payload }); }
export function removeEvidence(attemptId, questionId, editSessionId, attachmentId) { return request({ url: API.drafts.evidence(attemptId, questionId, editSessionId, attachmentId), method: "DELETE" }); }
export function confirmIssue(attemptId, questionId, editSessionId, payload) { return request({ url: API.drafts.confirmEdit(attemptId, questionId, editSessionId), method: "POST", data: payload }); }
export function cancelIssue(attemptId, questionId, editSessionId) { return request({ url: API.drafts.cancelEdit(attemptId, questionId, editSessionId), method: "POST" }); }
export function saveDishes(attemptId, payload) { return request({ url: API.drafts.dishes(attemptId), method: "PUT", data: payload, validate: assertRevision, dedupeKey: `dishes:${attemptId}` }); }
export function listReceiptAttachments(attemptId) { return request({ url: API.drafts.receiptAttachments(attemptId), validate: assertReceiptList, dedupeKey: `receipt-list:${attemptId}` }); }
export function initializeReceiptUpload(attemptId, fileMeta, revision) { return request({ url: API.drafts.receiptUploads(attemptId), method: "POST", data: { fileMeta, revision }, validate: assertReceiptUploadInit, dedupeKey: `receipt-init:${attemptId}:${fileMeta.clientFileId}` }); }
export function completeReceiptUpload(attemptId, attachmentId, fileMeta, revision) { return request({ url: API.drafts.receiptComplete(attemptId, attachmentId), method: "POST", data: { fileMeta, revision }, validate: assertReceiptMutation, dedupeKey: `receipt-complete:${attemptId}:${attachmentId}` }); }
export function deleteReceiptAttachment(attemptId, attachmentId, dishHandling, revision) { return request({ url: API.drafts.receiptAttachment(attemptId, attachmentId), method: "DELETE", data: { dishHandling, revision }, validate: assertReceiptMutation, dedupeKey: `receipt-delete:${attemptId}:${attachmentId}` }); }
export function createReceiptOcrJob(attemptId, attachmentIds, idempotencyKey, revision) { return request({ url: API.drafts.receiptOcrJobs(attemptId), method: "POST", data: { attachmentIds, idempotencyKey, revision }, validate: assertReceiptOcrJob, dedupeKey: `receipt-ocr-create:${attemptId}:${idempotencyKey}` }); }
export function getReceiptOcrJob(attemptId, jobId) { return request({ url: API.drafts.receiptOcrJob(attemptId, jobId), validate: assertReceiptOcrJob, dedupeKey: `receipt-ocr-get:${attemptId}:${jobId}` }); }
export function applyReceiptOcrJob(attemptId, jobId, idempotencyKey, dishRevision) { return request({ url: API.drafts.receiptOcrApply(attemptId, jobId), method: "POST", data: { idempotencyKey, revision: dishRevision }, validate: assertReceiptOcrApply, dedupeKey: `receipt-ocr-apply:${attemptId}:${jobId}:${idempotencyKey}` }); }
export function saveOtherRecords(attemptId, data) { return request({ url: API.drafts.otherRecords(attemptId), method: "PUT", data, validate: assertRevision, dedupeKey: `other:${attemptId}` }); }
export function submitQuestionnaire(attemptId, payload) { return request({ url: API.drafts.submit(attemptId), method: "POST", data: payload, validate: assertSubmit, dedupeKey: `submit:${attemptId}:${payload.submitToken}` }); }

export function uploadToSignedTarget({ url, method, fileFieldName, formData, expiresAt }, filePath, onProgress) {
  return new Promise((resolve, reject) => {
    if (method !== "POST" || !url || !fileFieldName || !formData || new Date(expiresAt) <= new Date()) { reject(new BusinessError("upload", "上传链接已失效，请重新上传")); return; }
    const task = wx.uploadFile({
      url, filePath, name: fileFieldName, formData, timeout: TIMEOUT_MS,
      success: (response) => response.statusCode >= 200 && response.statusCode < 300 ? resolve({ etag: response.header?.ETag || response.header?.etag || null }) : reject(new BusinessError("upload", "暂时无法上传小票，请重试", { retryable: true })),
      fail: () => reject(new BusinessError("upload", "暂时无法上传小票，请检查网络后重试", { retryable: true })),
    });
    if (!task) { reject(new BusinessError("upload", "暂时无法上传小票，请稍后重试", { retryable: true })); return; }
    task.onProgressUpdate?.((progress) => onProgress?.(Math.max(0, Math.min(100, Number(progress.progress) || 0))));
  });
}

// services/receipts.js（module-contracts §3.4；小程序 api.js:87-93 同名同语义）
// 端点映射（registry drafts 组小票七端点；:id = attemptId，URL 一律经条目 .path(...) 构建）：
//   listReceiptAttachments → GET    drafts.receiptAttachments(:attemptId)
//   initializeReceiptUpload→ POST   drafts.receiptUploads(:attemptId)，body={fileMeta,revision}
//   completeReceiptUpload  → POST   drafts.receiptComplete(:attemptId,:attachmentId)，body={fileMeta,revision}
//   deleteReceiptAttachment→ DELETE drafts.receiptAttachment(:attemptId,:attachmentId)，body={dishHandling,revision}
//   createReceiptOcrJob    → POST   drafts.receiptOcrJobs(:attemptId)，body={attachmentIds,idempotencyKey,revision}
//   getReceiptOcrJob       → GET    drafts.receiptOcrJob(:attemptId,:jobId)
//   applyReceiptOcrJob     → POST   drafts.receiptOcrApply(:attemptId,:jobId)，body={idempotencyKey,revision:dishRevision}
// dedupeKey（R11，对齐小程序 api.js:87-93）：receipt-list:{id}、receipt-init:{id}:{clientFileId}、
// receipt-complete:{id}:{attachmentId}、receipt-delete:{id}:{attachmentId}、
// receipt-ocr-create:{id}:{key}、receipt-ocr-get:{id}:{jobId}、receipt-ocr-apply:{id}:{jobId}:{key}。
// R67：列表收 QUESTIONNAIRE_SUBMITTED 409 → kind questionnaire_submitted（presentError 固定文案）。
import { request } from "../adapters/http.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

// ---------- 契约校验器（R88，等价小程序 contracts.generated.js 对应断言） ----------
function assertObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
  return value;
}

function assertId(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function assertRevision(value) {
  assertObject(value);
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new Error("response.revision must be a non-negative integer");
  return value;
}

function assertReceiptList(value) {
  assertObject(value);
  if (!Array.isArray(value.items)) throw new Error("receipt list.items must be an array");
  return assertRevision(value);
}

function assertReceiptUploadInit(value) {
  assertObject(value);
  assertObject(value.attachment);
  assertId(value.attachment.id, "attachment.id");
  assertObject(value.uploadTarget);
  return assertRevision(value);
}

function assertReceiptOcrJob(value) {
  assertObject(value);
  assertId(value.id, "OCR job.id");
  if (typeof value.status !== "string") throw new Error("OCR job.status must be a string");
  return value;
}

function assertReceiptOcrApply(value) {
  assertObject(value);
  assertReceiptOcrJob(value.job);
  if (!Array.isArray(value.dishes)) throw new Error("OCR apply dishes must be an array");
  return assertRevision(value);
}

export function listReceiptAttachments(attemptId) {
  return request({ url: endpointRegistry.drafts.receiptAttachments.path(attemptId), validate: assertReceiptList, dedupeKey: `receipt-list:${attemptId}` });
}

export function initializeReceiptUpload(attemptId, fileMeta, revision) {
  return request({ url: endpointRegistry.drafts.receiptUploads.path(attemptId), method: "POST", data: { fileMeta, revision }, validate: assertReceiptUploadInit, dedupeKey: `receipt-init:${attemptId}:${fileMeta.clientFileId}` });
}

export function completeReceiptUpload(attemptId, attachmentId, fileMeta, revision) {
  return request({ url: endpointRegistry.drafts.receiptComplete.path(attemptId, attachmentId), method: "POST", data: { fileMeta, revision }, validate: assertRevision, dedupeKey: `receipt-complete:${attemptId}:${attachmentId}` });
}

export function deleteReceiptAttachment(attemptId, attachmentId, dishHandling, revision) {
  return request({ url: endpointRegistry.drafts.receiptAttachment.path(attemptId, attachmentId), method: "DELETE", data: { dishHandling, revision }, validate: assertRevision, dedupeKey: `receipt-delete:${attemptId}:${attachmentId}` });
}

export function createReceiptOcrJob(attemptId, attachmentIds, idempotencyKey, revision) {
  return request({ url: endpointRegistry.drafts.receiptOcrJobs.path(attemptId), method: "POST", data: { attachmentIds, idempotencyKey, revision }, validate: assertReceiptOcrJob, dedupeKey: `receipt-ocr-create:${attemptId}:${idempotencyKey}` });
}

export function getReceiptOcrJob(attemptId, jobId) {
  return request({ url: endpointRegistry.drafts.receiptOcrJob.path(attemptId, jobId), validate: assertReceiptOcrJob, dedupeKey: `receipt-ocr-get:${attemptId}:${jobId}` });
}

export function applyReceiptOcrJob(attemptId, jobId, idempotencyKey, dishRevision) {
  return request({ url: endpointRegistry.drafts.receiptOcrApply.path(attemptId, jobId), method: "POST", data: { idempotencyKey, revision: dishRevision }, validate: assertReceiptOcrApply, dedupeKey: `receipt-ocr-apply:${attemptId}:${jobId}:${idempotencyKey}` });
}

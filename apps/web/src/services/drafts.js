// services/drafts.js（module-contracts §3.3；小程序 api.js:77-86,94-95 同名同语义）
// 端点映射（registry drafts 组；:id = attemptId，URL 一律经条目 .path(...) 构建）：
//   getDraft              → GET   drafts.byId(:attemptId)
//   saveAnswer            → PUT   drafts.answer(:attemptId,:questionId)
//   createEditSession     → POST  drafts.editSessions(:attemptId,:questionId)
//   updateEditSession     → PATCH drafts.editSession(:attemptId,:questionId,:editSessionId)
//   initEvidenceUpload    → POST  drafts.evidenceUploads(:attemptId,:questionId,:editSessionId)
//   completeEvidenceUpload→ POST  drafts.evidenceComplete(:attemptId,:questionId,:editSessionId,:attachmentId)
//   removeEvidence        → DELETE drafts.evidence(:attemptId,:questionId,:editSessionId,:attachmentId)
//   confirmIssue          → POST  drafts.confirmEdit(:attemptId,:questionId,:editSessionId)
//   cancelIssue           → POST  drafts.cancelEdit(:attemptId,:questionId,:editSessionId)
//   saveDishes            → PUT   drafts.dishes(:attemptId)
//   saveOtherRecords      → PUT   drafts.otherRecords(:attemptId)
//   initHighlightPhotoUpload     → POST  drafts.highlightPhotoUploads(:attemptId,:highlightId)
//   completeHighlightPhotoUpload → POST  drafts.highlightPhotoComplete(:attemptId,:highlightId,:attachmentId)
//   deleteHighlightPhoto         → DELETE drafts.highlightPhoto(:attemptId,:highlightId,:attachmentId)
//   submitQuestionnaire   → POST  drafts.submit(:attemptId)
// dedupeKey（R11/R79）：answer:{a}:{q}、dishes:{a}、other:{a}、submit:{a}:{payload.submitToken}
// （同 token 幂等重放依赖此键）；token 更换 dedupeKey 随之变化（R78）。
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

function assertQuestionnaire(value) {
  assertObject(value);
  assertObject(value.attempt);
  assertId(value.attempt.id, "attempt.id");
  assertRevision(value.attempt);
  assertObject(value.questionnaireVersion);
  assertId(value.questionnaireVersion.id, "questionnaireVersion.id");
  if (!Array.isArray(value.questions) || !value.answers || typeof value.answers !== "object" || Array.isArray(value.answers)) throw new Error("questionnaire payload is invalid");
  return value;
}

function assertEditSession(value) {
  assertObject(value);
  assertId(value.id, "edit session.id");
  return value;
}

function assertUploadInit(value) {
  assertObject(value);
  assertId(value.attachmentId, "attachmentId");
  assertObject(value.uploadTarget);
  return value;
}

function assertSubmit(value) {
  assertObject(value);
  if (typeof value.status !== "string") throw new Error("submit response.status must be a string");
  return value;
}

export function getDraft(attemptId) {
  return request({ url: endpointRegistry.drafts.byId.path(attemptId), validate: assertQuestionnaire });
}

export function saveAnswer(attemptId, questionId, answer) {
  return request({ url: endpointRegistry.drafts.answer.path(attemptId, questionId), method: "PUT", data: answer, validate: assertRevision, dedupeKey: `answer:${attemptId}:${questionId}` });
}

export function createEditSession(attemptId, questionId, payload) {
  return request({ url: endpointRegistry.drafts.editSessions.path(attemptId, questionId), method: "POST", data: payload, validate: assertEditSession });
}

export function updateEditSession(attemptId, questionId, editSessionId, payload) {
  return request({ url: endpointRegistry.drafts.editSession.path(attemptId, questionId, editSessionId), method: "PATCH", data: payload });
}

export function initEvidenceUpload(attemptId, questionId, editSessionId, payload) {
  // 显式 dedupeKey（含本次上传链的 clientFileId）：并发选择多张图片时各链 init 互不合并——
  // 默认按 URL 合并把两个不同文件的 init 合成同一授权，第二张必然直传 413；同 clientFileId
  // 的真正重复点击仍会合并（保留防抖语义）。
  return request({ url: endpointRegistry.drafts.evidenceUploads.path(attemptId, questionId, editSessionId), method: "POST", data: payload, dedupeKey: `evidence-init:${attemptId}:${questionId}:${editSessionId}:${payload.clientFileId}`, validate: assertUploadInit });
}

export function completeEvidenceUpload(attemptId, questionId, editSessionId, attachmentId, payload) {
  return request({ url: endpointRegistry.drafts.evidenceComplete.path(attemptId, questionId, editSessionId, attachmentId), method: "POST", data: payload });
}

export function removeEvidence(attemptId, questionId, editSessionId, attachmentId) {
  return request({ url: endpointRegistry.drafts.evidence.path(attemptId, questionId, editSessionId, attachmentId), method: "DELETE" });
}

export function confirmIssue(attemptId, questionId, editSessionId, payload) {
  return request({ url: endpointRegistry.drafts.confirmEdit.path(attemptId, questionId, editSessionId), method: "POST", data: payload });
}

export function cancelIssue(attemptId, questionId, editSessionId) {
  return request({ url: endpointRegistry.drafts.cancelEdit.path(attemptId, questionId, editSessionId), method: "POST" });
}

export function saveDishes(attemptId, payload) {
  return request({ url: endpointRegistry.drafts.dishes.path(attemptId), method: "PUT", data: payload, validate: assertRevision, dedupeKey: `dishes:${attemptId}` });
}

export function saveOtherRecords(attemptId, data) {
  return request({ url: endpointRegistry.drafts.otherRecords.path(attemptId), method: "PUT", data, validate: assertRevision, dedupeKey: `other:${attemptId}` });
}

// 闪光点照片三步直传（init → 直传 → complete），响应与消费小票同构：
// init/complete 返回 { photo, uploadTarget?/revision }，删除返回 { revision }。
function assertHighlightUploadInit(value) {
  assertObject(value);
  assertObject(value.photo);
  assertId(value.photo.id, "photo.id");
  // ready 幂等重放返回 uploadTarget:null（对象已校验落位，无凭据可发）；其余形态必须带可用的直传目标。
  if (value.photo.status === "ready") {
    if (value.uploadTarget !== null) throw new Error("ready replay must carry uploadTarget:null");
  } else {
    assertObject(value.uploadTarget);
  }
  return assertRevision(value);
}

function assertHighlightPhotoView(value) {
  assertObject(value);
  // 终态：{ photo, revision }；中间态（服务端校验租约被占用，202）：{ id, status:"verifying", revision }。
  if (value.status === "verifying") {
    assertId(value.id, "verifying.id");
    return assertRevision(value);
  }
  assertObject(value.photo);
  assertId(value.photo.id, "photo.id");
  return assertRevision(value);
}

export function initHighlightPhotoUpload(attemptId, highlightId, payload) {
  // 与 evidence init 同理：dedupeKey 含 clientFileId，并发多张照片的 init 互不合并。
  return request({ url: endpointRegistry.drafts.highlightPhotoUploads.path(attemptId, highlightId), method: "POST", data: payload, dedupeKey: `highlight-photo-init:${attemptId}:${highlightId}:${payload.fileMeta.clientFileId}`, validate: assertHighlightUploadInit });
}

export function completeHighlightPhotoUpload(attemptId, highlightId, attachmentId, payload) {
  return request({ url: endpointRegistry.drafts.highlightPhotoComplete.path(attemptId, highlightId, attachmentId), method: "POST", data: payload, validate: assertHighlightPhotoView });
}

export function deleteHighlightPhoto(attemptId, highlightId, attachmentId, payload) {
  return request({ url: endpointRegistry.drafts.highlightPhoto.path(attemptId, highlightId, attachmentId), method: "DELETE", data: payload, validate: assertRevision });
}

export function submitQuestionnaire(attemptId, payload) {
  return request({ url: endpointRegistry.drafts.submit.path(attemptId), method: "POST", data: payload, validate: assertSubmit, dedupeKey: `submit:${attemptId}:${payload.submitToken}` });
}

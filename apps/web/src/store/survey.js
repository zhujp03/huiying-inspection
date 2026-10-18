// store/survey.js（module-contracts §4.3；小程序 store/survey.js:1-40 同名同语义）
// 草稿键：junde:survey:{userId}:{assignmentId}:{attemptId}:{questionnaireVersionId}
//（各段 encodeURIComponent；任一要素缺失 → throw new Error("DRAFT_SCOPE_MISSING")）。
//
// 语义（R34/R35 配套）：
// - getDraft(meta)：无值或 revision 不匹配 → 空骨架 { answers:{}, dishes:[], highlight:"",
//   suggestion:"", receiptRecovery:{pendingReceipts:[],jobId:null,applyKey:null,appliedJobId:null},
//   revision: meta.revision }；否则返回存值。
// - peekDraft(meta)：读原始值（不做 revision 过滤），非对象返回 null。
// - saveDraft(meta, patch)：合并 + synced:false + savedAt + registerDraftKey。
// - markDraftSynced(meta, revision)：写 synced:true 与新 revision + registerDraftKey。
// - advanceDraftRevision(meta, revision)：仅推进 revision（synced 不动）——单题补发成功
//   但草稿仍有未补发题时的"部分同步"语义，补发全部完成才允许 markDraftSynced。
// - clearDraft(meta)：删键（R85）。
import { readStorage, writeStorage, removeStorage } from "../adapters/storage.js";
import { getSession, registerDraftKey } from "./session.js";

function identity(meta) {
  const userId = getSession()?.user?.id;
  if (!userId || !meta?.assignmentId || !meta?.attemptId || !meta?.questionnaireVersionId) throw new Error("DRAFT_SCOPE_MISSING");
  return { userId, key: `junde:survey:${encodeURIComponent(userId)}:${encodeURIComponent(meta.assignmentId)}:${encodeURIComponent(meta.attemptId)}:${encodeURIComponent(meta.questionnaireVersionId)}` };
}

export function getDraft(meta) {
  const { key } = identity(meta);
  const value = readStorage(key);
  if (!value || value.revision !== meta.revision) return { answers: {}, dishes: [], highlight: "", suggestion: "", highlights: [], receiptRecovery: { pendingReceipts: [], jobId: null, applyKey: null, appliedJobId: null }, revision: meta.revision };
  return value;
}

// 读取本地草稿原始值（不做 revision 过滤），用于判断"本地未同步但服务端 revision
// 已前进"的冲突场景；草稿键已由 identity 保证 userId+assignment+attempt+版本隔离。
export function peekDraft(meta) {
  const { key } = identity(meta);
  const value = readStorage(key);
  return value && typeof value === "object" ? value : null;
}

export function saveDraft(meta, patch) {
  const { userId, key } = identity(meta);
  const next = { ...getDraft(meta), ...patch, revision: meta.revision, synced: false, savedAt: new Date().toISOString() };
  writeStorage(key, next);
  registerDraftKey(userId, key);
  return next;
}

export function markDraftSynced(meta, revision) {
  const nextMeta = { ...meta, revision };
  const { userId, key } = identity(nextMeta);
  const current = readStorage(key) || {};
  writeStorage(key, { ...current, revision, synced: true });
  registerDraftKey(userId, key);
}

export function advanceDraftRevision(meta, revision) {
  const nextMeta = { ...meta, revision };
  const { userId, key } = identity(nextMeta);
  const current = readStorage(key) || {};
  writeStorage(key, { ...current, revision });
  registerDraftKey(userId, key);
}

export function clearDraft(meta) {
  const { key } = identity(meta);
  removeStorage(key);
}

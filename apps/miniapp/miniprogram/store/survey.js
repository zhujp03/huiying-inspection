import { getSession, registerDraftKey } from "./session.js";

function identity(meta) {
  const userId = getSession()?.user?.id;
  if (!userId || !meta?.assignmentId || !meta?.attemptId || !meta?.questionnaireVersionId) throw new Error("DRAFT_SCOPE_MISSING");
  return { userId, key: `junde:survey:${encodeURIComponent(userId)}:${encodeURIComponent(meta.assignmentId)}:${encodeURIComponent(meta.attemptId)}:${encodeURIComponent(meta.questionnaireVersionId)}` };
}

export function getDraft(meta) {
  const { key } = identity(meta);
  const value = wx.getStorageSync(key);
  if (!value || value.revision !== meta.revision) return { answers: {}, dishes: [], highlight: "", suggestion: "", receiptRecovery: { pendingReceipts: [], jobId: null, applyKey: null, appliedJobId: null }, revision: meta.revision };
  return value;
}

// 读取本地草稿原始值（不做 revision 过滤），用于判断“本地未同步但服务端 revision
// 已前进”的冲突场景；草稿键已由 identity 保证 userId+assignment+attempt+版本隔离。
export function peekDraft(meta) {
  const { key } = identity(meta);
  const value = wx.getStorageSync(key);
  return value && typeof value === "object" ? value : null;
}

export function saveDraft(meta, patch) {
  const { userId, key } = identity(meta);
  const next = { ...getDraft(meta), ...patch, revision: meta.revision, synced: false, savedAt: new Date().toISOString() };
  wx.setStorageSync(key, next);
  registerDraftKey(userId, key);
  return next;
}

export function markDraftSynced(meta, revision) {
  const nextMeta = { ...meta, revision };
  const { userId, key } = identity(nextMeta);
  const current = wx.getStorageSync(key) || {};
  wx.setStorageSync(key, { ...current, revision, synced: true });
  registerDraftKey(userId, key);
}

export function clearDraft(meta) { const { key } = identity(meta); wx.removeStorageSync(key); }

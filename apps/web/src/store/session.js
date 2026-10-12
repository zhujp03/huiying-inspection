// store/session.js（module-contracts §4.1；小程序 store/session.js:1-20 同名同语义）
// 存储键：junde:session（整包）；草稿索引：junde:draft-index。
//
// 语义（R01/R05）：
// - getSession() 无值返回 null；saveSession(session) 整包写入。
// - clearSessionAndUserCache()：按 junde:draft-index 中当前用户的键逐个删草稿 →
//   删该用户索引项 → 删会话 → 清内存会话（globalData 职责由模块内变量承担）。
// - registerDraftKey(userId, key) 去重登记草稿键索引。
// - 持久化一律经 adapters/storage。
import { readStorage, writeStorage, removeStorage } from "../adapters/storage.js";

const SESSION_KEY = "junde:session";
const DRAFT_INDEX_KEY = "junde:draft-index";
// 内部实现（PM 钉定，为 services 层 R10 缓存失效预留）：会话写入代次。
// saveSession 每次写入单调递增 epoch（模块计数器+Date.now 组合字符串，连续两次必不同）；
// clearSessionAndUserCache 删除该键。不进任何导出面。
const CACHE_EPOCH_KEY = "junde:cache-epoch";
let cacheEpochCounter = 0;
let memorySession = null; // 等价小程序 getApp().globalData.session

export function getSession() {
  return readStorage(SESSION_KEY) || null;
}

export function saveSession(session) {
  writeStorage(SESSION_KEY, session);
  memorySession = session;
  cacheEpochCounter += 1;
  writeStorage(CACHE_EPOCH_KEY, `${cacheEpochCounter}:${Date.now()}`);
  return session;
}

export function clearSessionAndUserCache() {
  const session = getSession();
  const index = readStorage(DRAFT_INDEX_KEY) || {};
  (index[session?.user?.id] || []).forEach((key) => removeStorage(key));
  if (session?.user?.id) {
    delete index[session.user.id];
    writeStorage(DRAFT_INDEX_KEY, index);
  }
  removeStorage(SESSION_KEY);
  removeStorage(CACHE_EPOCH_KEY);
  memorySession = null;
}

export function registerDraftKey(userId, key) {
  const index = readStorage(DRAFT_INDEX_KEY) || {};
  index[userId] = Array.from(new Set([...(index[userId] || []), key]));
  writeStorage(DRAFT_INDEX_KEY, index);
}

const SESSION_KEY = "junde:session";
const DRAFT_INDEX_KEY = "junde:draft-index";

export function getSession() { return wx.getStorageSync(SESSION_KEY) || null; }
export function saveSession(session) { wx.setStorageSync(SESSION_KEY, session); return session; }

export function clearSessionAndUserCache() {
  const session = getSession();
  const index = wx.getStorageSync(DRAFT_INDEX_KEY) || {};
  (index[session?.user?.id] || []).forEach((key) => wx.removeStorageSync(key));
  if (session?.user?.id) { delete index[session.user.id]; wx.setStorageSync(DRAFT_INDEX_KEY, index); }
  wx.removeStorageSync(SESSION_KEY);
  getApp().globalData.session = null;
}

export function registerDraftKey(userId, key) {
  const index = wx.getStorageSync(DRAFT_INDEX_KEY) || {};
  index[userId] = Array.from(new Set([...(index[userId] || []), key]));
  wx.setStorageSync(DRAFT_INDEX_KEY, index);
}

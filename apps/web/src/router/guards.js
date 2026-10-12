// router/guards.js（module-contracts §6.2；小程序 utils/auth.js:3-8 + api.js:42 + login/index.js:58-66）
//
// 语义（R02/R03/R05）：
// - requireApprovedSession(session)：session?.user?.status === "approved_active" 且
//   session.accessToken → { ok: true, session }（session 同对象）；否则 { ok: false, redirect: "/login" }。
//   （wx.reLaunch 改为纯判定，redirect 由调用方执行。）
// - coldStartRoute(session)：approved 会话 → "/home"；否则 "/login"（冷启动探测分流）。
// - handleUnauthorized()：清会话与用户缓存（clearSessionAndUserCache；任务缓存经
//   junde:cache-epoch 失效），返回 "/login" 供路由层跳转（401 统一链路）。
import { clearSessionAndUserCache } from "../store/session.js";

export function requireApprovedSession(session) {
  if (session?.user?.status === "approved_active" && session.accessToken) return { ok: true, session };
  return { ok: false, redirect: "/login" };
}

export function coldStartRoute(session) {
  return requireApprovedSession(session).ok ? "/home" : "/login";
}

export function handleUnauthorized() {
  clearSessionAndUserCache();
  return "/login";
}

import { getSession } from "../store/session.js";

export function requireApprovedSession() {
  const session = getSession();
  if (session?.user?.status === "approved_active" && session.accessToken) return session;
  wx.reLaunch({ url: "/pages/login/index" });
  return null;
}

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { API, AdminLoginRequestSchema, AdminSessionSchema } from "../../../../packages/contracts/index.js";
import { request, setCsrfToken } from "../api/client.js";

const AdminAuthContext = createContext(null);

// 会话恢复以服务端会话 cookie 为唯一权威：每次冷加载都探测一次 /api/me。
// 匿名访问返回 401 是预期内的认证信号（回登录页），不代表应用故障；
// 有效 cookie（含旧版本会话、新标签页、无任何本地提示）都能直接恢复并进入深链接页面。
// 本地不再保存任何「已登录」提示——sessionStorage/localStorage 都不作为登录态依据。
export function AdminAuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let active = true;
    request(API.auth.me, { schema: AdminSessionSchema })
      .then((result) => { if (active) { setCsrfToken(result.csrfToken); setSession(result); } })
      .catch(() => { if (active) setCsrfToken(null); })
      .finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  }, []);

  const value = useMemo(() => ({
    session,
    restoring,
    async login(credentials) {
      const body = AdminLoginRequestSchema.parse(credentials);
      const result = await request(API.auth.adminLogin, { method: "POST", body, schema: AdminSessionSchema });
      setCsrfToken(result.csrfToken);
      setSession(result);
    },
    async logout() {
      try { await request(API.auth.adminLogout, { method: "POST" }); } finally {
        setCsrfToken(null);
        setSession(null);
      }
    },
    expire() {
      setCsrfToken(null);
      setSession(null);
    },
  }), [session, restoring]);

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const value = useContext(AdminAuthContext);
  if (!value) throw new Error("AdminAuthProvider is required");
  return value;
}

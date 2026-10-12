import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { API, AdminLoginRequestSchema, AdminSessionSchema } from "../../../../packages/contracts/index.js";
import { request, setCsrfToken } from "../api/client.js";

const AdminAuthContext = createContext(null);
const SESSION_HINT = "junde:admin-session";

export function AdminAuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(() => sessionStorage.getItem(SESSION_HINT) === "active");

  useEffect(() => {
    if (!restoring) return undefined;
    let active = true;
    request(API.auth.me, { schema: AdminSessionSchema })
      .then((result) => { if (active) { setCsrfToken(result.csrfToken); setSession(result); } })
      .catch(() => sessionStorage.removeItem(SESSION_HINT))
      .finally(() => active && setRestoring(false));
    return () => { active = false; };
  }, [restoring]);

  const value = useMemo(() => ({
    session,
    restoring,
    async login(credentials) {
      const body = AdminLoginRequestSchema.parse(credentials);
      const result = await request(API.auth.adminLogin, { method: "POST", body, schema: AdminSessionSchema });
      sessionStorage.setItem(SESSION_HINT, "active");
      setCsrfToken(result.csrfToken);
      setSession(result);
    },
    async logout() {
      try { await request(API.auth.adminLogout, { method: "POST" }); } finally {
        sessionStorage.removeItem(SESSION_HINT);
        setCsrfToken(null);
        setSession(null);
      }
    },
    expire() {
      sessionStorage.removeItem(SESSION_HINT);
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

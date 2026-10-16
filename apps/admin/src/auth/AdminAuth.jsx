import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { API, AdminLoginRequestSchema, AdminSessionSchema } from "../../../../packages/contracts/index.js";
import { notifyAuthChange, request, setAuthenticatedUser, setCsrfToken } from "../api/client.js";

const AdminAuthContext = createContext(null);

// 会话恢复以服务端会话 cookie 为唯一权威：每次冷加载都探测一次 /api/me，三类结果分开处理：
//   200            → 恢复会话（含旧版本会话、新标签页、无任何本地提示）；
//   401            → 预期内的匿名信号（回登录页），不代表应用故障；
//   网络/超时/5xx   → 服务暂不可用：给出可重试的恢复失败页，绝不误判成「未登录」让用户盲填表单。
// 本地不再保存任何「已登录」提示——sessionStorage/localStorage 都不作为登录态依据。
// 会话过期采用「遮罩保活」：expire() 保留旧会话供被不透明遮罩覆盖的工作台渲染（编辑器草稿不丢），
// 重新登录同一账号即恢复现场；换账号登录则按用户重挂隔离，绝不向前账号之外泄露页面数据。
export function AdminAuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [shielded, setShielded] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const sessionRef = useRef(null);
  sessionRef.current = session;
  // 认证操作序号 + 在途请求控制器：新的认证意图（登录/登出/过期）会取消被取代的在途认证请求
  // （如迟到的登出 clear-cookie 不得落在新登录之后），其结算也因序号失配而不再清除新会话/推进代际。
  const authOpRef = useRef({ seq: 0, controller: null });
  const beginAuthOp = useCallback(() => {
    authOpRef.current.controller?.abort();
    authOpRef.current.seq += 1;
    const controller = new AbortController();
    authOpRef.current.controller = controller;
    return { seq: authOpRef.current.seq, controller };
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setRestoreError(null);
    request(API.auth.me, { schema: AdminSessionSchema, signal: controller.signal })
      .then((result) => { if (active) { setAuthenticatedUser(result.user.id); setCsrfToken(result.csrfToken); setShielded(null); setSession(result); } })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        // 迟到的成功/失败响应（认证代际已切换）：静默丢弃，新认证流程拥有本标签状态。
        if (error?.kind === "stale") return;
        // 真过期（服务端明确 401）才是匿名信号；网络/超时/服务不可用保留错误供重试。
        if (error?.kind === "session") { setCsrfToken(null); setShielded(null); setSession(null); }
        else { setCsrfToken(null); setRestoreError(error); }
      })
      .finally(() => { if (active) setRestoring(false); });
    return () => { active = false; controller.abort(); };
  }, [restoreAttempt]);

  const login = useCallback(async (credentials) => {
    const { controller } = beginAuthOp();
    const body = AdminLoginRequestSchema.parse(credentials);
    const result = await request(API.auth.adminLogin, { method: "POST", body, schema: AdminSessionSchema, signal: controller.signal });
    // client 侧已在登录成功响应时推进认证代际（以服务端 cookie 变化为准，不等渲染）；
    // 这里再推进一次保持语义显式：此后旧会话的迟到 401/403 一律视为 stale。
    notifyAuthChange();
    setAuthenticatedUser(result.user.id);
    setCsrfToken(result.csrfToken);
    // 显式登录：遮罩态交还给新会话——同一账号恢复现场（key 不变，数据屏按 epoch 重拉），
    // 换账号由 key 重挂隔离。
    setShielded(null);
    setSession(result);
  }, []);

  const logout = useCallback(async () => {
    const { seq, controller } = beginAuthOp();
    try {
      // 登出失败（网络/超时）不阻断本地登出：服务端会话由闲置/绝对时限兜底。
      await request(API.auth.adminLogout, { method: "POST", signal: controller.signal });
    } catch { /* 忽略：下方仍按序号结算 */ } finally {
      // 被新的认证意图取代（如登出在途时过期并重新登录）：不推进代际、不清除新会话。
      if (authOpRef.current.seq !== seq) return;
      notifyAuthChange();
      setAuthenticatedUser(null);
      setCsrfToken(null);
      // 主动退出：被遮罩的界面一并卸载，不留任何已登录内容。
      setShielded(null);
      setSession(null);
    }
  }, []);

  const expire = useCallback(() => {
    beginAuthOp(); // 取消在途认证请求（如迟到的登出），并使旧认证操作的结算失配
    notifyAuthChange(); // 旧会话的迟到响应（含在途变更的 401/403）自此视为 stale，不得遮罩新登录或重放写入
    setCsrfToken(null);
    const current = sessionRef.current;
    if (current) setShielded(current);
    setSession(null);
  }, []);

  const restore = useCallback(() => setRestoreAttempt((value) => value + 1), []);

  const value = useMemo(() => ({
    // 消费方（工作台）在遮罩期继续拿到旧会话渲染，界面不可交互、被遮罩完全覆盖。
    session: session || shielded,
    authExpired: Boolean(!session && shielded),
    restoring,
    restoreError,
    restore,
    login,
    logout,
    expire,
  }), [session, shielded, restoring, restoreError, restore, login, logout, expire]);

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const value = useContext(AdminAuthContext);
  if (!value) throw new Error("AdminAuthProvider is required");
  return value;
}

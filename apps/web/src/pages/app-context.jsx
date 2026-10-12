// 页面共享上下文（第 3 段）：
// App.jsx 为 Provider，value = { publicConfig, session, navigate(to), back(fallback),
// replace(to), toast(message), redirectToLogin() }。
// 无全局订阅：session/publicConfig 由 App 在路由变化与自身状态更新时重读/透传（inventory §4.2）。
import { createContext, useContext } from "react";

export const AppContext = createContext(null);

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp 必须在 App 的 Provider 内使用");
  return context;
}

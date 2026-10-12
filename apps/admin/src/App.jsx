import { AdminWorkbench } from "./surfaces/AdminWorkbench.jsx";
import { AdminAuthProvider, useAdminAuth } from "./auth/AdminAuth.jsx";
import { AdminLogin } from "./pages/AdminLogin.jsx";

export function App() {
  return <AdminAuthProvider><ProtectedAdmin /></AdminAuthProvider>;
}

function ProtectedAdmin() {
  const { session, restoring } = useAdminAuth();
  if (restoring) return <main className="admin-login-page"><p className="business-loading">正在恢复登录状态…</p></main>;
  if (!session) return <AdminLogin />;
  return <AdminWorkbench />;
}

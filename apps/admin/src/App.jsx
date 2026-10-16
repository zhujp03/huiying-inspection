import { AdminWorkbench } from "./surfaces/AdminWorkbench.jsx";
import { AdminAuthProvider, useAdminAuth } from "./auth/AdminAuth.jsx";
import { AdminLogin } from "./pages/AdminLogin.jsx";

export function App() {
  return <AdminAuthProvider><ProtectedAdmin /></AdminAuthProvider>;
}

function ProtectedAdmin() {
  const { session, authExpired, restoring, restoreError, restore } = useAdminAuth();
  if (restoring) return <main className="admin-login-page"><p className="business-loading">正在恢复登录状态…</p></main>;
  // 初始恢复失败（网络中断/服务不可用/超时）：可重试的恢复页，绝不当作「未登录」。
  if (!session && restoreError) {
    return <main className="admin-login-page"><section className="admin-login-card"><div className="admin-login-heading"><div><h1>无法恢复登录状态</h1></div></div><p className="form-message" role="alert">{restoreError.message}</p><button className="admin-primary" onClick={restore}>重试</button></section></main>;
  }
  if (!session) return <AdminLogin />;
  // 会话过期遮罩：工作台保持挂载（编辑器草稿不丢），被不透明遮罩完全覆盖并禁用交互；
  // 在遮罩上重新登录——同一账号恢复现场继续编辑，换账号则按用户 key 重挂，绝不跨账号泄露数据。
  // 内层容器两种状态同构（恒为 host > layer > Workbench），过期/恢复切换不重挂工作台。
  return (
    <div className="admin-app-host">
      <div className={`admin-shielded-layer${authExpired ? " is-shielded" : ""}`} {...(authExpired ? { inert: true, "aria-hidden": true } : {})}>
        <AdminWorkbench key={session.user.id} />
      </div>
      {authExpired && <div className="admin-reauth-overlay"><AdminLogin expired /></div>}
    </div>
  );
}

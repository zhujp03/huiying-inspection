import { useState } from "react";
import { LockKey, ShieldCheck, User } from "@phosphor-icons/react";
import { useAdminAuth } from "../auth/AdminAuth.jsx";

export function AdminLogin({ expired = false } = {}) {
  const { login } = useAdminAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    if (!username.trim() || !password) return setMessage("请输入管理员账号和密码");
    setPending(true);
    setMessage("");
    try { await login({ username, password }); }
    catch (error) { setMessage(error.message); }
    finally { setPending(false); }
  };

  return <main className={`admin-login-page${expired ? " is-expired" : ""}`}><section className="admin-login-card"><div className="admin-login-brand"><span>汇</span><div><strong>汇盈探店</strong><small>运营管理中心</small></div></div><div className="admin-login-heading"><ShieldCheck size={30} weight="duotone" /><div><h1>{expired ? "登录已过期，请重新登录" : "管理员登录"}</h1><p>{expired ? "重新登录后可继续当前页面未保存的编辑内容（同一账号）。" : "登录后仅显示你有权访问的门店和功能。"}</p></div></div><form onSubmit={submit}><label><span>管理员账号</span><div><User size={19} /><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></div></label><label><span>密码</span><div><LockKey size={19} /><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div></label>{message && <p className="form-message" role="alert">{message}</p>}<button className="admin-primary" disabled={pending}>{pending ? "正在登录…" : "登录"}</button></form><p className="admin-login-note">账号权限和可见范围由管理方统一配置。</p></section></main>;
}

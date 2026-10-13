// ProfilePage — 我的（tab，inventory §1.5；rules R02 守卫在 App 壳 / R97 五态映射 / R08 退出登录）。
// 语义真源：apps/miniapp/miniprogram/pages/profile/index.js。
// PM 钉定 Web 适配点 3：退出确认用 window.confirm（v1），文案对齐小程序 showModal
// 「退出后需要重新输入账号和密码。」（按钮 退出/取消 对应 confirm 的 确定/取消）。
import React, { useRef, useState } from "react";
import { Button, Card, Muted, StatusBadge } from "../design/components.jsx";
import { useApp } from "./app-context.jsx";
import { logout } from "../services/auth.js";

// R97：五态徽章映射（含未知态兜底）
const STATUS_PRESENTATION = {
  pending_approval: { text: "申请正在审核中", tone: "warning" },
  approved_active: { text: "已启用", tone: "primary" },
  rejected: { text: "申请未通过", tone: "warning" },
  disabled: { text: "已停用", tone: "muted" },
};

export function ProfilePage() {
  const { session, navigate, toast, redirectToLogin } = useApp();
  const user = session?.user;
  const status = STATUS_PRESENTATION[user?.status] || { text: "账号状态待确认", tone: "muted" };
  const displayName = user?.displayName || "探店员"; // R97 缺省
  const avatarInitial = (user?.displayName || "探").trim().slice(0, 1).toUpperCase() || "探";

  const [loggingOut, setLoggingOut] = useState(false);
  const loggingOutRef = useRef(false);

  // 账号安全入口（策略性隐藏，对齐小程序 wxml wx:if="{{false}}"，R97）：逻辑保留——
  // openSecurity 会弹「如需修改密码，请退出登录后使用「忘记密码」重新设置。」，
  // 确认后 navigate("/login?mode=forgot")；当前无 UI 入口。

  const confirmLogout = async () => {
    if (loggingOutRef.current) return; // R08：退出进行中防重复
    // PM 适配点 3：window.confirm（v1），未确认弹窗不退出
    if (!window.confirm("退出后需要重新输入账号和密码。")) return;
    loggingOutRef.current = true;
    setLoggingOut(true);
    try {
      await logout(); // services 层 finally 已清会话与任务缓存（R08/R10）
    } catch (error) {
      toast(error?.message || "退出失败，请稍后重试");
    } finally {
      loggingOutRef.current = false;
      setLoggingOut(false);
      redirectToLogin(); // R08：无论成败跳登录
    }
  };

  return (
    <div className="app-page" data-page="profile">
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div style={{ width: 52, height: 52, borderRadius: "50%", background: "#eef0f2", color: "#5f6369", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700 }}>
            {avatarInitial}
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{displayName}</div>
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
              <Muted>探店员</Muted>
              <StatusBadge tone={status.tone}>{status.text}</StatusBadge>
            </div>
          </div>
        </div>
      </Card>
      <Card flush>
        <div className="list-row" onClick={() => navigate("/location?source=profile")} role="button">
          <span className="list-row__label">隐私与定位</span><span className="list-chevron">›</span>
        </div>
        <div className="list-row" onClick={() => navigate("/help")} role="button">
          <span className="list-row__label">填写帮助</span><span className="list-chevron">›</span>
        </div>
        {/* 账号安全入口：策略性隐藏（对齐小程序 wxml wx:if="{{false}}"，R97） */}
      </Card>
      <div style={{ marginTop: 12 }}>
        <Button variant="outline" block disabled={loggingOut} onClick={confirmLogout}>退出登录</Button>
      </div>
    </div>
  );
}

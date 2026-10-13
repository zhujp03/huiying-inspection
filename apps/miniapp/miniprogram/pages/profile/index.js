import { logout } from "../../services/api.js";
import { getSession } from "../../store/session.js";
import { requireApprovedSession } from "../../utils/auth.js";

const statusPresentation = {
  pending_approval: { text: "申请正在审核中", tone: "warning" },
  approved_active: { text: "已启用", tone: "primary" },
  rejected: { text: "申请未通过", tone: "warning" },
  disabled: { text: "已停用", tone: "muted" },
};

Page({
  data: { displayName: "", avatarInitial: "", statusText: "", statusTone: "", loggingOut: false },
  onShow() {
    if (!requireApprovedSession()) return;
    const user = getSession()?.user;
    const status = statusPresentation[user?.status] || { text: "账号状态待确认", tone: "muted" };
    this.setData({
      displayName: user?.displayName || "探店员",
      avatarInitial: (user?.displayName || "探").trim().slice(0, 1).toUpperCase() || "探",
      statusText: status.text,
      statusTone: status.tone,
    });
  },
  openSecurity() {
    // 第一阶段不提供登录态内改密码接口；明确引导走忘记密码流程。
    wx.showModal({
      title: "账号安全",
      content: "如需修改密码，请退出登录后使用「忘记密码」重新设置。",
      confirmText: "去设置",
      cancelText: "知道了",
      success: (result) => { if (result.confirm) wx.reLaunch({ url: "/pages/login/index?mode=forgot" }); },
    });
  },
  // source=profile：定位说明页完成/返回时回到「我的」（原生返回同样落回本页）。
  openPrivacy() { wx.navigateTo({ url: "/pages/location/index?source=profile", fail: () => wx.showToast({ title: "暂时无法打开定位说明", icon: "none" }) }); },
  openHelp() { wx.navigateTo({ url: "/pages/help/index", fail: () => wx.showToast({ title: "暂时无法打开填写帮助", icon: "none" }) }); },
  // 退出登录：先确认，退出期间防重复；API 失败仍按会话安全逻辑跳转并给出明确反馈。
  confirmLogout() {
    if (this.data.loggingOut) return;
    wx.showModal({
      title: "确认退出登录？",
      content: "退出后需要重新输入账号和密码。",
      confirmText: "退出",
      cancelText: "取消",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ loggingOut: true });
        try {
          await logout();
        } catch (error) {
          wx.showToast({ title: error.message || "退出失败，请稍后重试", icon: "none", duration: 3000 });
        } finally {
          wx.reLaunch({ url: "/pages/login/index" });
        }
      },
    });
  },
});

import { requireApprovedSession } from "../../utils/auth.js";
import { sanitizeSource } from "../../utils/navigation.js";

Page({
  data: { status: "idle", message: "位置仅用于判断是否到店打卡，不持续记录轨迹。", source: "", continueLabel: "进入首页" },
  onLoad(options) {
    requireApprovedSession();
    // 来源白名单：profile（「我的」进入）→ 返回我的；登录链路/直达 → 完成后进首页。
    // 定位说明与授权策略不变；完成去向不再固定日程。
    const source = sanitizeSource(options.source) === "profile" ? "profile" : "";
    this.setData({ source, continueLabel: source === "profile" ? "返回我的" : "进入首页" });
  },
  locate() {
    this.setData({ status: "loading", message: "正在获取当前位置…" });
    wx.getLocation({
      type: "gcj02",
      isHighAccuracy: true,
      success: () => { getApp().globalData.locationStatus = "ready"; this.setData({ status: "ready", message: "定位可用。开始任务时还会重新获取最新位置。" }); },
      fail: () => this.setData({ status: "blocked", message: "未能获取位置，你仍可查看任务说明，但不能开始探店。" })
    });
  },
  openSettings() { wx.openSetting(); },
  continue() { wx.switchTab({ url: this.data.source === "profile" ? "/pages/profile/index" : "/pages/home/index" }); }
});

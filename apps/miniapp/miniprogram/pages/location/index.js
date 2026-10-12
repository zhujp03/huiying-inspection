import { requireApprovedSession } from "../../utils/auth.js";

Page({
  data: { status: "idle", message: "位置仅用于判断是否到店打卡，不持续记录轨迹。" },
  onLoad() { requireApprovedSession(); },
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
  continue() { wx.switchTab({ url: "/pages/schedule/index" }); }
});

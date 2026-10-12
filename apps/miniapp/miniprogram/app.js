import { getSession } from "./store/session.js";
import { createCaptchaAdapter } from "./services/captcha-host.js";
import { API } from "./services/contracts.generated.js";
import { RUNTIME_CONFIG } from "./runtime-config.generated.js";

const DEVELOP_FALLBACK_API_BASE = "http://127.0.0.1:3000";

App({
  onLaunch() {
    const envVersion = wx.getAccountInfoSync?.().miniProgram?.envVersion || "develop";
    // API Origin 由 release:prepare 生成（runtime-config.generated.js，公开值）；
    // 开发环境且未生成时回退到本机地址。用户不再修改源码域名映射。
    this.globalData.apiBase = RUNTIME_CONFIG.apiBase || (envVersion === "develop" ? DEVELOP_FALLBACK_API_BASE : "");
    this.globalData.session = getSession();
    // 初始化行为验证 Adapter：登录/注册/找回密码页通过 captcha-host 注册插件组件
    // 实现；组件缺失、加载失败或用户取消时由 obtainCaptchaTicket 转成业务错误。
    this.globalData.captchaAdapter = createCaptchaAdapter();
    this.globalData.publicConfig = null;
    this.loadPublicConfig();
  },
  // 公开客户端配置（CaptchaAppId/地图公开 Key/功能开关）；失败时登录页可重试。
  // AUTH_SELF_SERVICE=disabled 时 captchaAppId 允许为 null，配置整体仍然有效
  // （features.receiptOcr 等功能开关与其无关），故只校验返回是对象。
  loadPublicConfig() {
    if (!this.globalData.apiBase) return Promise.resolve(null);
    return new Promise((resolve) => {
      wx.request({
        url: `${this.globalData.apiBase}${API.public.clientConfig}`,
        method: "GET", timeout: 5000,
        success: (response) => {
          if (response.statusCode === 200 && response.data && typeof response.data === "object") {
            this.globalData.publicConfig = response.data;
            resolve(response.data);
            return;
          }
          this.globalData.publicConfig = null;
          resolve(null);
        },
        fail: () => { this.globalData.publicConfig = null; resolve(null); },
      });
    });
  },
  globalData: { apiBase: "", session: null, locationStatus: "unknown", captchaAdapter: null, publicConfig: null },
});

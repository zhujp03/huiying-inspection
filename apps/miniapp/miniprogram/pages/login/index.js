import { BusinessError, completePasswordReset, getMyAssignments, login, register, requestPasswordCode, requestRegisterCode, resubmitRegistration, verifyPasswordCode } from "../../services/api.js";
import { obtainCaptchaTicket } from "../../services/captcha.js";
import { registerCaptchaHost } from "../../services/captcha-host.js";
import { resolveCaptchaAppId } from "../../services/captcha-config.js";
import { getSession } from "../../store/session.js";

Page({
  data: {
    mode: "login", step: "form", username: "", phone: "", password: "", confirmPassword: "", smsCode: "",
    challengeId: "", resetToken: "", pending: false, accountStatus: "", rejectedReason: "", countdown: 0,
    captchaAppId: "", captchaUnavailable: false, maskedPhone: "",
    showPassword: false, focusField: "", selfServiceEnabled: false,
    headTitle: "探店员工作台", headSub: "欢迎回来", submitText: "登录",
    statusTitle: "", statusDesc: "",
  },
  onLoad(options) {
    // 支持从「我的 → 账号安全」带 mode=forgot 进入忘记密码流程。
    const entryMode = options?.mode && ["login", "register", "forgot", "resubmit"].includes(options.mode) ? options.mode : "";
    if (entryMode) this.setData({ mode: entryMode, step: "form" });
    // 自助注册/找回/重新提交入口统一由服务端开关（features.authSelfService）驱动，
    // 开关关闭时入口与表单整体隐藏，被拒状态页只提示联系管理员。
    this.setData({ captchaAppId: resolveCaptchaAppId(), selfServiceEnabled: this.resolveSelfService() });
    if (!this.data.captchaAppId) this.retryPublicConfig();
    this.updateView();
    // 已登录冷启动：首页是登录页，会话仍有效时直接进入工作台；仅探测一次，
    // 失败（网络/会话失效）不再重试，避免跳转循环。
    this.sessionProbeDone = false;
    if (!entryMode || entryMode === "login") this.probeExistingSession();
    // 把腾讯验证码插件组件（plugin://captcha/t-captcha）注册为全局 adapter 的
    // 一次性实现；组件缺失、加载失败、用户关闭都转成业务错误，绝不让客户端
    // 自造票据。
    this.captchaNeedsRefresh = false;
    registerCaptchaHost({
      verify: () => new Promise((resolve, reject) => {
        this.captchaResolve = resolve;
        this.captchaReject = reject;
        const component = this.selectComponent("#tcaptcha");
        if (!component || typeof component.show !== "function") {
          this.clearCaptchaPending();
          reject(new BusinessError("captcha", "行为验证组件暂未就绪，请稍后重试"));
          return;
        }
        // 后端拒绝（票据过期/校验失败）后，下一次展示前先做受控 refresh；
        // 用户主动关闭不循环刷新。
        const open = () => component.show();
        if (this.captchaNeedsRefresh && typeof component.refresh === "function") {
          this.captchaNeedsRefresh = false;
          try { component.refresh(); } catch { /* refresh 失败仍继续展示 */ }
        }
        open();
      }),
    });
  },
  resolveSelfService() {
    return Boolean(getApp()?.globalData?.publicConfig?.features?.authSelfService);
  },
  // 冷启动会话探测：有效会话直接进工作台；无会话或校验失败留在登录页，且只探测一次。
  async probeExistingSession() {
    if (this.sessionProbeDone) return;
    this.sessionProbeDone = true;
    if (!getSession()?.accessToken) return;
    try {
      await getMyAssignments();
      if (!this.data.mode || (this.data.mode === "login" && this.data.step === "form")) wx.switchTab({ url: "/pages/home/index" });
    } catch { /* 会话无效或网络失败：留在登录页，由用户手动登录，不循环重试 */ }
  },
  async retryPublicConfig() {
    // 加载失败进入明确终态（不得永久显示加载中）；功能开关与验证码同源刷新。
    const loaded = await getApp().loadPublicConfig?.();
    const patch = { captchaUnavailable: true };
    if (loaded?.captchaAppId) { patch.captchaAppId = loaded.captchaAppId; patch.captchaUnavailable = false; }
    patch.selfServiceEnabled = this.resolveSelfService();
    this.setData(patch);
  },
  onUnload() {
    if (this.timer) clearInterval(this.timer);
    // 未完成的验证 Promise 必须被拒绝，不能留下永久 pending。
    const reject = this.captchaReject;
    this.clearCaptchaPending();
    if (reject) reject(new BusinessError("captcha_cancel", "已取消行为验证，请重试"));
  },
  clearCaptchaPending() { this.captchaResolve = null; this.captchaReject = null; },
  onCaptchaReady() {
    // 插件加载完成；只更新状态，不产生票据。
    this.setData({ captchaReady: true });
  },
  onCaptchaVerify(event) {
    // 腾讯验证码 2.1.4：verify 事件 detail = { ret, ticket }；只有 ret === 0 且
    // ticket 非空才视为验证成功，否则按失败处理，绝不把空票据发给后端。
    const detail = event?.detail || {};
    const resolve = this.captchaResolve;
    const reject = this.captchaReject;
    this.clearCaptchaPending();
    if (!resolve || !reject) return;
    if (Number(detail.ret) === 0 && typeof detail.ticket === "string" && detail.ticket.length > 0) {
      resolve({ ticket: detail.ticket, randstr: detail.randstr || "" });
    } else {
      reject(new BusinessError("captcha", "验证未通过，请重试"));
    }
  },
  onCaptchaClose() {
    const reject = this.captchaReject;
    this.clearCaptchaPending();
    if (reject) reject(new BusinessError("captcha_cancel", "已取消行为验证，请重试"));
  },
  onCaptchaError() {
    const reject = this.captchaReject;
    this.clearCaptchaPending();
    if (reject) reject(new BusinessError("captcha", "行为验证加载失败，请稍后重试"));
  },
  // ---------- 页面切换 ----------
  goLogin() { this.setMode({ currentTarget: { dataset: { mode: "login" } } }); },
  setMode(event) {
    this.setData({ mode: event.currentTarget.dataset.mode, step: "form", accountStatus: "", smsCode: "", challengeId: "", resetToken: "", maskedPhone: "" });
    this.updateView();
  },
  changePhone() { this.setData({ step: "form", smsCode: "", challengeId: "", maskedPhone: "" }); this.updateView(); },
  togglePassword() { this.setData({ showPassword: !this.data.showPassword }); },
  onInputFocus(event) { this.setData({ focusField: event.currentTarget.dataset.field }); },
  onInputBlur() { this.setData({ focusField: "" }); },
  onInput(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },
  // 派生文案集中计算（方案 2 契约文案）
  updateView() {
    const { mode, step, accountStatus, rejectedReason, maskedPhone } = this.data;
    let headTitle = "", headSub = "", submitText = "";
    if (step === "sms") {
      headTitle = "输入短信验证码";
      headSub = `验证码已发送至 ${maskedPhone || "****"}`;
      submitText = mode === "register" ? "验证并提交申请" : mode === "resubmit" ? "验证并重新提交申请" : "验证短信验证码";
    } else if (mode === "login") {
      headTitle = "探店员工作台"; headSub = "欢迎回来"; submitText = "登录";
    } else if (mode === "register") {
      headTitle = "注册探店员账号"; headSub = "提交后需等待管理员审核"; submitText = "获取短信验证码";
    } else if (mode === "resubmit") {
      headTitle = "修改并重新提交申请"; headSub = "提交后需等待管理员审核"; submitText = "获取短信验证码";
    } else if (step === "password") {
      headTitle = "设置新密码"; headSub = "输入新密码完成重置"; submitText = "重置密码";
    } else {
      headTitle = "重置登录密码"; headSub = "验证绑定手机号后可以设置新密码"; submitText = "获取短信验证码";
    }
    let statusTitle = "", statusDesc = "";
    if (step === "status") {
      statusTitle = accountStatus === "pending_approval" ? "申请正在审核中" : accountStatus === "rejected" ? "注册申请未通过" : "账号已停用";
      statusDesc = accountStatus === "pending_approval" ? "审核通过后才能登录并接受任务"
        : accountStatus === "rejected" ? (rejectedReason || "请修改申请资料后重新提交。")
        : "请联系管理方确认账号状态";
    }
    this.setData({ headTitle, headSub, submitText, statusTitle, statusDesc });
  },
  // ---------- 提交流程 ----------
  async submitLogin() {
    if (!this.data.username.trim() || !this.data.password) return this.message("请完整填写账号信息");
    await this.pending(async () => {
      const session = await login({ username: this.data.username, password: this.data.password });
      const status = session.user?.status;
      if (status === "approved_active") wx.redirectTo({ url: "/pages/location/index" });
      else this.setData({ step: "status", accountStatus: status, rejectedReason: session.user?.rejectedReason || "" });
      this.updateView();
    });
  },
  async sendRegisterCode() {
    if (!/^1\d{10}$/.test(this.data.phone)) return this.message("请输入正确的手机号");
    if (this.data.password.length < 10 || this.data.password !== this.data.confirmPassword) return this.message("密码至少 10 个字符，且两次输入必须一致");
    await this.pending(async () => {
      const captcha = await obtainCaptchaTicket("register");
      const result = await requestRegisterCode({ phone: this.data.phone, captchaTicket: captcha.ticket, captchaRandstr: captcha.randstr });
      this.setData({ challengeId: result.phoneChallengeId, step: "sms", maskedPhone: maskPhone(this.data.phone) });
      this.startCountdown(result.resendAfterSeconds || 60);
      this.updateView();
    });
  },
  async submitRegister() {
    if (!/^\d{6}$/.test(this.data.smsCode)) return this.message("请输入 6 位短信验证码");
    await this.pending(async () => {
      await register({ username: this.data.username, phone: this.data.phone, password: this.data.password, confirmPassword: this.data.confirmPassword, phoneChallengeId: this.data.challengeId, smsCode: this.data.smsCode });
      this.setData({ step: "status", accountStatus: "pending_approval" });
      this.updateView();
    });
  },
  async sendResetCode() {
    if (!/^1\d{10}$/.test(this.data.phone)) return this.message("请输入正确的手机号");
    await this.pending(async () => {
      const captcha = await obtainCaptchaTicket("password_reset");
      const result = await requestPasswordCode({ phone: this.data.phone, captchaTicket: captcha.ticket, captchaRandstr: captcha.randstr });
      this.setData({ challengeId: result.phoneChallengeId, step: "sms", maskedPhone: maskPhone(this.data.phone) });
      this.startCountdown(result.resendAfterSeconds || 60);
      this.updateView();
      this.message("若该手机号已绑定账号，将发送验证码");
    });
  },
  async verifyResetCode() {
    if (!/^\d{6}$/.test(this.data.smsCode)) return this.message("请输入 6 位短信验证码");
    await this.pending(async () => {
      const result = await verifyPasswordCode({ phoneChallengeId: this.data.challengeId, smsCode: this.data.smsCode });
      this.setData({ resetToken: result.resetToken, step: "password", smsCode: "" });
      this.updateView();
    });
  },
  async resetPassword() {
    if (this.data.password.length < 10 || this.data.password !== this.data.confirmPassword) return this.message("密码至少 10 个字符，且两次输入必须一致");
    await this.pending(async () => {
      await completePasswordReset({ resetToken: this.data.resetToken, password: this.data.password, confirmPassword: this.data.confirmPassword });
      this.setData({ mode: "login", step: "form", password: "", confirmPassword: "", resetToken: "" });
      this.updateView();
      this.message("密码已重置，请重新登录");
    });
  },
  async sendResubmitCode() {
    if (!/^1\d{10}$/.test(this.data.phone)) return this.message("请输入正确的手机号");
    await this.pending(async () => {
      const captcha = await obtainCaptchaTicket("registration_resubmit");
      const result = await requestRegisterCode({ phone: this.data.phone, captchaTicket: captcha.ticket, captchaRandstr: captcha.randstr });
      this.setData({ challengeId: result.phoneChallengeId, step: "sms", maskedPhone: maskPhone(this.data.phone) });
      this.startCountdown(result.resendAfterSeconds || 60);
      this.updateView();
    });
  },
  async submitResubmit() {
    if (!/^\d{6}$/.test(this.data.smsCode)) return this.message("请输入 6 位短信验证码");
    await this.pending(async () => {
      await resubmitRegistration({ phoneChallengeId: this.data.challengeId, smsCode: this.data.smsCode });
      this.setData({ mode: "login", step: "status", accountStatus: "pending_approval", smsCode: "", challengeId: "" });
      this.updateView();
    });
  },
  resubmit() { this.setData({ mode: "resubmit", step: "form", phone: "", smsCode: "", challengeId: "" }); this.updateView(); },
  submit() {
    if (this.data.mode === "login") return this.submitLogin();
    if (this.data.mode === "register") return this.data.step === "sms" ? this.submitRegister() : this.sendRegisterCode();
    if (this.data.mode === "resubmit") return this.data.step === "sms" ? this.submitResubmit() : this.sendResubmitCode();
    if (this.data.step === "form") return this.sendResetCode();
    if (this.data.step === "sms") return this.verifyResetCode();
    return this.resetPassword();
  },
  resend() { if (this.data.countdown > 0) return; this.setData({ step: "form", smsCode: "", challengeId: "" }); this.updateView(); this.submit(); },
  startCountdown(seconds) { if (this.timer) clearInterval(this.timer); this.setData({ countdown: seconds }); this.timer = setInterval(() => { const next = this.data.countdown - 1; this.setData({ countdown: Math.max(0, next) }); if (next <= 0) { clearInterval(this.timer); this.timer = null; } }, 1000); },
  async pending(work) {
    if (this.data.pending) return;
    this.setData({ pending: true });
    try { await work(); }
    catch (error) {
      // 后端拒绝票据或短信失效时，下一次展示验证码前执行受控 refresh；用户主动
      // 关闭（captcha_cancel）不循环刷新。
      if (error.kind === "captcha_rejected" || error.kind === "sms_invalidated") this.captchaNeedsRefresh = true;
      if (error.kind === "sms_invalidated") this.setData({ step: "form", smsCode: "", challengeId: "" });
      this.message(error.message);
    }
    finally { this.setData({ pending: false }); }
  },
  message(title) { wx.showToast({ title, icon: "none", duration: 3000 }); },
});

function maskPhone(phone) { return String(phone || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2"); }

// LoginPage — login 登录/注册/找回/重交（首屏，inventory §1.1）。
// 语义真源：apps/miniapp/miniprogram/pages/login/index.js（253 行）逐函数移植；
// 规则：R03 冷启动探测 / R06 登录流转 / R07 状态文案 / R12 配置重拉 / R13 自助门控 /
//       R17-R18 验证码链 / R19-R21 本地校验 / R22 倒计时 / R23 忘记密码三步 / R24 被拒重交。
//
// PM 钉定 Web 适配点（默认选择）：
// 1) 验证码桥（方案#2，R0 零域名不加载任何外部验证码 SDK）：构建 adapter 时探测
//    globalThis.TencentCaptcha——存在则把 new TencentCaptcha(captchaAppId, callback) 的
//    show/回调包装成 Promise（ticket/randstr 契约不变，R18：组件缺失/用户关闭/失败全部
//    reject BusinessError kind=captcha 或 captcha_cancel）；不存在则 adapter=undefined →
//    services/captcha.obtainCaptchaTicket 抛 kind=captcha → 页面进入 captchaUnavailable 终态卡
//    （R12 降级：重新加载 = loadPublicConfig + 复查 captchaAppId，仍无则停留终态）。
//    captchaNeedsRefresh（R18）：kind 为 captcha_rejected/sms_invalidated 时下次展示前受控
//    refresh（无真实 SDK 时等价于重新走探测）。
// 4) kind=session 的 BusinessError → context.redirectToLogin()（services 层 401 已清会话，R05）。
import React, { useEffect, useRef, useState } from "react";
import {
  Button, Card, Field, Muted, PasswordInput, SectionHeading, TextInput,
} from "../design/components.jsx";
import { useApp } from "./app-context.jsx";
import {
  login, register, requestPasswordCode, requestRegisterCode,
  resubmitRegistration, verifyPasswordCode, completePasswordReset,
} from "../services/auth.js";
import { obtainCaptchaTicket } from "../services/captcha.js";
import { loadPublicConfig } from "../services/public-config.js";
import { getMyAssignments } from "../services/assignments.js";
import { getSession } from "../store/session.js";
import { isSelfServiceEnabled } from "../utils/feature-flags.js";
import { BusinessError } from "../utils/errors.js";

const MODES = ["login", "register", "forgot", "resubmit"];

export function LoginPage({ initialMode = "" }) {
  const { publicConfig, replace, toast, redirectToLogin } = useApp();

  // URL ?mode= 白名单（R24：非法值忽略，落回 login）
  const [mode, setMode] = useState(MODES.includes(initialMode) ? initialMode : "login");
  const [step, setStep] = useState("form");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [pending, setPending] = useState(false);
  const [accountStatus, setAccountStatus] = useState("");
  const [rejectedReason, setRejectedReason] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [captchaUnavailable, setCaptchaUnavailable] = useState(false);
  const [maskedPhone, setMaskedPhone] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // R12 本地重拉结果：null=未重拉（用 App 级 publicConfig）；否则以重拉到的 captchaAppId 为准
  const [retriedConfig, setRetriedConfig] = useState(null);

  const pendingRef = useRef(false);
  const timerRef = useRef(null);
  const captchaNeedsRefreshRef = useRef(false); // R18/R22：后端拒票后下次展示前受控 refresh
  const pendingCaptchaRejectRef = useRef(null); // 卸载时 reject 未决验证 Promise（R18）
  const probeDoneRef = useRef(false);
  const bootstrappedRef = useRef(false);
  // 异步闭包内读取最新派生值（等价 miniapp this.data）
  const latestRef = useRef({});
  // App 级配置优先（配置晚到可自愈终态），页面 R12 重拉结果补位
  const captchaAppId = publicConfig?.captchaAppId || retriedConfig?.appId || "";
  // PM 适配点 1：宿主 = captchaAppId + globalThis.TencentCaptcha 同时就绪（R0 不加载外部脚本）
  const captchaReady = Boolean(captchaAppId) && typeof globalThis.TencentCaptcha === "function";
  latestRef.current = { mode, step, captchaAppId };

  const selfServiceEnabled = isSelfServiceEnabled(publicConfig); // R13：严格 === true，未到达保守隐藏

  // ---------- 视图派生（沿用骨架 LoginHeadTitle 文案表） ----------
  const statusView = `status-${accountStatus === "pending_approval" ? "pending" : accountStatus === "rejected" ? "rejected" : "disabled"}`;
  const view = step === "status"
    ? statusView
    : mode === "login"
      ? "login-form"
      : !selfServiceEnabled
        ? `${mode}-form`
        : captchaReady
          ? `${mode}-${step}`
          : captchaUnavailable
            ? "captcha-unavailable"
            : "captcha-loading";

  // ---------- 验证码桥（PM 适配点 1） ----------
  const buildCaptchaAdapter = () => {
    const appId = latestRef.current.captchaAppId;
    // SDK 缺失或 appId 缺失 → adapter=undefined → obtainCaptchaTicket 抛 kind=captcha（R17）
    if (!appId || typeof globalThis.TencentCaptcha !== "function") return undefined;
    const Captcha = globalThis.TencentCaptcha;
    return ({ scene }) => new Promise((resolve, reject) => {
      let settled = false;
      const settle = (work) => {
        if (settled) return;
        settled = true;
        pendingCaptchaRejectRef.current = null;
        work();
      };
      let instance = null;
      try {
        instance = new Captcha(appId, (result) => {
          // R18：ret===0 且 ticket 非空才 resolve；ret===2 视为用户关闭（captcha_cancel）；其余按失败
          if (Number(result?.ret) === 0 && typeof result?.ticket === "string" && result.ticket) {
            settle(() => resolve({ ticket: result.ticket, randstr: result.randstr || "" }));
          } else if (Number(result?.ret) === 2) {
            settle(() => reject(new BusinessError("captcha_cancel", "已取消行为验证，请重试")));
          } else {
            settle(() => reject(new BusinessError("captcha", "验证未通过，请重试")));
          }
        });
      } catch {
        settle(() => reject(new BusinessError("captcha", "行为验证组件暂未就绪，请稍后重试")));
        return;
      }
      if (!instance || typeof instance.show !== "function") {
        settle(() => reject(new BusinessError("captcha", "行为验证组件暂未就绪，请稍后重试")));
        return;
      }
      // 卸载等价物：未决 Promise 必须可被 reject，不留永久 pending（R18）
      pendingCaptchaRejectRef.current = (error) => settle(() => reject(error));
      // captchaNeedsRefresh（R18/R22）：后端拒票（captcha_rejected/sms_invalidated）后，
      // 下次展示前先受控 refresh；用户主动关闭不触发。
      if (captchaNeedsRefreshRef.current && typeof instance.refresh === "function") {
        captchaNeedsRefreshRef.current = false;
        try { instance.refresh(); } catch { /* refresh 失败仍继续展示 */ }
      }
      try {
        instance.show();
      } catch {
        settle(() => reject(new BusinessError("captcha", "行为验证加载失败，请稍后重试")));
      }
    });
  };

  const captchaHostReady = () => {
    const current = latestRef.current;
    return Boolean(current.captchaAppId) && typeof globalThis.TencentCaptcha === "function";
  };

  // ---------- 公共配置重拉（R12） ----------
  const retryPublicConfig = async () => {
    const loaded = await loadPublicConfig();
    setRetriedConfig({ appId: loaded?.captchaAppId || null });
    // 复查 captchaAppId；宿主 SDK 仍缺失同样视为不可用 → 停留终态（PM 适配点 1：无真实 SDK 时重拉等价于重新探测）
    if (loaded?.captchaAppId && typeof globalThis.TencentCaptcha === "function") setCaptchaUnavailable(false);
    else setCaptchaUnavailable(true); // 明确终态，不永久 loading
  };

  // ---------- 冷启动会话探测（R03） ----------
  const probeExistingSession = async () => {
    if (probeDoneRef.current) return; // 仅探测一次，失败不重试，避免跳转循环
    probeDoneRef.current = true;
    if (!getSession()?.accessToken) return;
    try {
      await getMyAssignments();
      // 成功且仍处于登录表单步才跳转（避免打断进行中的注册/找回流程）
      const current = latestRef.current;
      if ((!current.mode || current.mode === "login") && current.step === "form") replace("/home");
    } catch { /* 会话无效或网络失败：留在登录页 */ }
  };

  // ---------- 生命周期（onLoad / onUnload 等价） ----------
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    // R12：captchaAppId 缺失时自动重拉一次（App 级配置可能尚未到达或无此字段）
    if (!publicConfig?.captchaAppId) retryPublicConfig();
    // R03：仅无入口 mode 或 mode=login 时探测
    if (!initialMode || initialMode === "login") probeExistingSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // PM 适配点 1：appId 已到但宿主 SDK 缺失（R0 不加载外部脚本）→ 验证码链确定不可用，
    // 直接进 R12 终态卡；SDK 晚到时 captchaReady 派生为真会自愈回表单。
    if (publicConfig?.captchaAppId && typeof globalThis.TencentCaptcha !== "function") {
      setCaptchaUnavailable(true);
    }
  }, [publicConfig]);

  useEffect(() => () => {
    // onUnload 等价：清倒计时；未决验证 Promise reject（captcha_cancel），不留永久 pending（R18）
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const rejectPending = pendingCaptchaRejectRef.current;
    pendingCaptchaRejectRef.current = null;
    if (rejectPending) rejectPending(new BusinessError("captcha_cancel", "已取消行为验证，请重试"));
  }, []);

  // ---------- 倒计时（R22） ----------
  const startCountdown = (seconds) => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCountdown(seconds);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
  };

  useEffect(() => {
    if (countdown === 0 && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, [countdown]);

  // ---------- pending 防重包装（等价 miniapp pending(work)，R19-R24 错误分流） ----------
  const runPending = async (work) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await work();
    } catch (error) {
      // R18/R22：后端拒票或短信失效 → 下次展示验证码前受控 refresh；用户取消不循环刷新
      if (error?.kind === "captcha_rejected" || error?.kind === "sms_invalidated") captchaNeedsRefreshRef.current = true;
      if (error?.kind === "sms_invalidated") {
        setStep("form");
        setSmsCode("");
        setChallengeId("");
      }
      if (error?.kind === "session") {
        // PM 适配点 4：services 层 401 已清会话，这里统一跳登录（R05）
        toast(error.message);
        redirectToLogin();
      } else if (error?.kind === "captcha" && !captchaHostReady()) {
        // PM 适配点 1：验证码宿主不可用 → R12 明确终态卡
        setCaptchaUnavailable(true);
      } else {
        // 错误统一 toast（R86 文案已由 services 层映射内置）
        toast(error?.message || "操作未完成，请检查填写内容");
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  // ---------- 模式切换（等价 miniapp setMode / goLogin / resubmit / changePhone） ----------
  const switchMode = (nextMode) => {
    setMode(nextMode);
    setStep("form");
    setAccountStatus("");
    setSmsCode("");
    setChallengeId("");
    setResetToken("");
    setMaskedPhone("");
  };

  const resubmit = () => {
    setMode("resubmit");
    setStep("form");
    setPhone("");
    setSmsCode("");
    setChallengeId("");
  };

  const changePhone = () => {
    setStep("form");
    setSmsCode("");
    setChallengeId("");
    setMaskedPhone("");
  };

  // ---------- 提交流程（逐函数对齐 miniapp js:151-234） ----------
  const submitLogin = () => {
    if (!username.trim() || !password) {
      toast("请完整填写账号信息"); // R19：不发请求、不进入 pending
      return;
    }
    runPending(async () => {
      const session = await login({ username, password });
      const status = session?.user?.status;
      if (status === "approved_active") {
        replace("/location"); // R06：redirectTo 等价 replace
      } else {
        setStep("status");
        setAccountStatus(status);
        setRejectedReason(session?.user?.rejectedReason || ""); // R07
      }
    });
  };

  const sendCode = (scene) => runPending(async () => {
    const captcha = await obtainCaptchaTicket(scene, buildCaptchaAdapter());
    // register / registration_resubmit 复用注册发码端点；password_reset 走找回端点（R23/R24）
    const payload = { phone, captchaTicket: captcha.ticket, captchaRandstr: captcha.randstr };
    const result = scene === "password_reset"
      ? await requestPasswordCode(payload)
      : await requestRegisterCode(payload);
    setChallengeId(result.phoneChallengeId);
    setStep("sms");
    setMaskedPhone(maskPhone(phone));
    startCountdown(result.resendAfterSeconds || 60); // R22
    if (scene === "password_reset") toast("若该手机号已绑定账号，将发送验证码"); // R23
  });

  const sendRegisterCode = () => {
    if (!/^1\d{10}$/.test(phone)) {
      toast("请输入正确的手机号"); // R20
      return;
    }
    if (password.length < 10 || password !== confirmPassword) {
      toast("密码至少 10 个字符，且两次输入必须一致"); // R20
      return;
    }
    sendCode("register");
  };

  const sendResubmitCode = () => {
    if (!/^1\d{10}$/.test(phone)) {
      toast("请输入正确的手机号"); // R20
      return;
    }
    sendCode("registration_resubmit"); // R24：专用 captcha 场景，复用注册发码端点
  };

  const sendResetCode = () => {
    if (!/^1\d{10}$/.test(phone)) {
      toast("请输入正确的手机号"); // R20
      return;
    }
    sendCode("password_reset");
  };

  const submitRegister = () => {
    if (!/^\d{6}$/.test(smsCode)) {
      toast("请输入 6 位短信验证码"); // R21
      return;
    }
    runPending(async () => {
      await register({ username, phone, password, confirmPassword, phoneChallengeId: challengeId, smsCode });
      setStep("status");
      setAccountStatus("pending_approval");
    });
  };

  const submitResubmit = () => {
    if (!/^\d{6}$/.test(smsCode)) {
      toast("请输入 6 位短信验证码"); // R21
      return;
    }
    runPending(async () => {
      await resubmitRegistration({ phoneChallengeId: challengeId, smsCode });
      // R24：回 login + status/pending_approval
      setMode("login");
      setStep("status");
      setAccountStatus("pending_approval");
      setSmsCode("");
      setChallengeId("");
    });
  };

  const verifyResetCode = () => {
    if (!/^\d{6}$/.test(smsCode)) {
      toast("请输入 6 位短信验证码"); // R21
      return;
    }
    runPending(async () => {
      const result = await verifyPasswordCode({ phoneChallengeId: challengeId, smsCode });
      setResetToken(result.resetToken);
      setStep("password");
      setSmsCode("");
    });
  };

  const resetPassword = () => {
    if (password.length < 10 || password !== confirmPassword) {
      toast("密码至少 10 个字符，且两次输入必须一致"); // R20
      return;
    }
    runPending(async () => {
      await completePasswordReset({ resetToken, password, confirmPassword });
      setMode("login");
      setStep("form");
      setPassword("");
      setConfirmPassword("");
      setResetToken("");
      toast("密码已重置，请重新登录"); // R23
    });
  };

  const submit = () => {
    if (mode === "login") return submitLogin();
    if (mode === "register") return step === "sms" ? submitRegister() : sendRegisterCode();
    if (mode === "resubmit") return step === "sms" ? submitResubmit() : sendResubmitCode();
    if (step === "form") return sendResetCode();
    if (step === "sms") return verifyResetCode();
    return resetPassword();
  };

  // R22：countdown>0 忽略重发；归零重发=清 smsCode/challengeId 回表单重走发码链路
  const resend = () => {
    if (countdown > 0) return;
    setSmsCode("");
    setChallengeId("");
    setStep("form");
    if (mode === "register") sendRegisterCode();
    else if (mode === "resubmit") sendResubmitCode();
    else if (mode === "forgot") sendResetCode();
  };

  // ---------- 渲染 ----------
  const inSelfService = mode !== "login" && selfServiceEnabled;

  return (
    <div className="app-page app-page--flat" data-page="login" data-view={view}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 40 }}>
        <div style={{ width: 46, height: 46, borderRadius: 8, background: "#f25f42", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700 }}>汇</div>
        <div style={{ marginTop: 9, fontSize: 18, fontWeight: 700, color: "#26272a" }}>汇盈探店</div>
      </div>

      {step === "status" ? (
        <LoginStatusBlock
          accountStatus={accountStatus}
          rejectedReason={rejectedReason}
          selfServiceEnabled={selfServiceEnabled}
          onResubmit={resubmit}
          onBackLogin={() => switchMode("login")}
        />
      ) : (
        <>
          {mode !== "login" ? (
            <div style={{ marginTop: 24 }}>
              <Button variant="link" onClick={() => switchMode("login")}>返回登录</Button>
            </div>
          ) : null}
          <div style={{ marginTop: 32 }}>
            <LoginHeadTitle view={view} />
          </div>
          {mode === "login" ? (
            <Card>
              <Field label="用户名">
                <TextInput placeholder="请输入用户名" value={username} onChange={(event) => setUsername(event.target.value)} />
              </Field>
              <Field label="密码">
                <PasswordInput
                  placeholder="请输入密码（10-64 字符）"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  showPassword={showPassword}
                  onTogglePassword={() => setShowPassword((v) => !v)}
                />
              </Field>
              <div style={{ marginTop: 14 }}>
                <Button block disabled={pending} onClick={submitLogin}>登录</Button>
              </div>
              {/* 门控：authSelfService 关闭时以下入口不可见（rules R13） */}
              {selfServiceEnabled ? (
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
                  <Button variant="link" small onClick={() => switchMode("forgot")}>忘记密码</Button>
                  <Button variant="link" small onClick={() => switchMode("register")}>注册探店员账号</Button>
                </div>
              ) : null}
            </Card>
          ) : !inSelfService ? null : captchaReady ? (
            <div data-gate="authSelfService">
              <Card>
                {step === "form" ? (
                  <>
                    <Field label="手机号" required>
                      <TextInput type="tel" maxLength={11} placeholder="请输入手机号" value={phone} onChange={(event) => setPhone(event.target.value)} />
                    </Field>
                    {mode !== "forgot" ? (
                      <Field label="用户名" required>
                        <TextInput placeholder="请输入用户名" value={username} onChange={(event) => setUsername(event.target.value)} />
                      </Field>
                    ) : null}
                    {mode === "register" ? (
                      <>
                        <Field label="密码" required>
                          <PasswordInput
                            placeholder="请输入密码（10-64 字符）"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            showPassword={showPassword}
                            onTogglePassword={() => setShowPassword((v) => !v)}
                          />
                        </Field>
                        <Field label="确认密码" required>
                          <PasswordInput
                            placeholder="请再次输入密码"
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            showPassword={showPassword}
                            onTogglePassword={() => setShowPassword((v) => !v)}
                          />
                        </Field>
                      </>
                    ) : null}
                    <div style={{ marginTop: 14 }}>
                      <Button block disabled={pending} onClick={submit}>获取短信验证码</Button>
                    </div>
                  </>
                ) : step === "sms" ? (
                  <>
                    <Muted>验证码已发送至 {maskedPhone || "****"}</Muted>
                    <Field label="短信验证码" required>
                      <TextInput type="tel" maxLength={6} placeholder="6 位数字验证码" value={smsCode} onChange={(event) => setSmsCode(event.target.value)} />
                    </Field>
                    <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
                      <Button block disabled={pending} onClick={submit}>
                        {mode === "register" ? "验证并提交申请" : mode === "resubmit" ? "验证并重新提交申请" : "验证短信验证码"}
                      </Button>
                      <Button block variant="outline" disabled={countdown > 0 || pending} onClick={resend}>
                        {countdown > 0 ? `重新发送（${countdown}s）` : "重新发送"}
                      </Button>
                      <Button block variant="link" onClick={changePhone}>更换手机号</Button>
                    </div>
                  </>
                ) : (
                  <>
                    <Field label="密码" required>
                      <PasswordInput
                        placeholder="请输入密码（10-64 字符）"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        showPassword={showPassword}
                        onTogglePassword={() => setShowPassword((v) => !v)}
                      />
                    </Field>
                    <Field label="确认密码" required>
                      <PasswordInput
                        placeholder="请再次输入密码"
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        showPassword={showPassword}
                        onTogglePassword={() => setShowPassword((v) => !v)}
                      />
                    </Field>
                    <div style={{ marginTop: 14 }}>
                      <Button block disabled={pending} onClick={resetPassword}>重置密码</Button>
                    </div>
                  </>
                )}
              </Card>
              {/* 行为验证码挂载点：Web 桥经 globalThis.TencentCaptcha 构建（ticket/randstr 契约不变） */}
              <div data-captcha-mount style={{ display: "none" }} />
            </div>
          ) : captchaUnavailable ? (
            <Card>
              <SectionHeading>行为验证暂不可用</SectionHeading>
              <Muted>网络异常导致行为验证未能加载，请重试。</Muted>
              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                <Button disabled={pending} onClick={retryPublicConfig}>重新加载</Button>
                <Button variant="outline" onClick={() => switchMode("login")}>返回登录</Button>
              </div>
            </Card>
          ) : (
            <Card>
              <Muted>行为验证加载中…</Muted>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function LoginHeadTitle({ view: currentView }) {
  const titles = {
    "login-form": ["欢迎回来", "请输入账号信息登录"],
    "register-form": ["注册探店员账号", "填写资料提交审核"],
    "register-sms": ["输入短信验证码", "验证手机号完成注册"],
    "forgot-form": ["找回密码", "验证手机号后重置密码"],
    "forgot-sms": ["输入短信验证码", "验证手机号"],
    "forgot-password": ["设置新密码", "密码至少 10 个字符"],
    "resubmit-form": ["修改并重新提交", "更新注册资料"],
    "resubmit-sms": ["输入短信验证码", "验证手机号完成重交"],
  };
  const [title, sub] = titles[currentView] || ["", ""];
  return (
    <div>
      <div style={{ fontSize: 21, fontWeight: 700, color: "#26272a" }}>{title}</div>
      <div style={{ marginTop: 4, fontSize: 13, color: "#70747b" }}>{sub}</div>
    </div>
  );
}

function LoginStatusBlock({ accountStatus, rejectedReason, selfServiceEnabled, onResubmit, onBackLogin }) {
  // R07 三种状态文案；R13：被拒且自助关闭 → 固定引导文案，无重交按钮
  const isPending = accountStatus === "pending_approval";
  const isRejected = accountStatus === "rejected";
  const title = isPending ? "申请正在审核中" : isRejected ? "注册申请未通过" : "账号已停用";
  const desc = isPending
    ? "审核通过后才能登录并接受任务"
    : isRejected
      ? (selfServiceEnabled ? (rejectedReason || "请修改申请资料后重新提交。") : "资料需修改，请联系管理员重新开放提交。")
      : "请联系管理方确认账号状态";
  return (
    <div style={{ marginTop: 24 }}>
      <SectionHeading>{title}</SectionHeading>
      <Muted>{desc}</Muted>
      <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
        {isRejected && selfServiceEnabled ? <Button onClick={onResubmit}>修改并重新提交</Button> : null}
        <Button variant="outline" onClick={onBackLogin}>返回登录</Button>
      </div>
    </div>
  );
}

function maskPhone(value) {
  return String(value || "").replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

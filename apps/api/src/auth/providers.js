// Auth provider adapters: Tencent CAPTCHA (DescribeCaptchaMiniResult) and Tencent
// Cloud SMS (SendSms), plus an explicit non-production sandbox for staging
// whitelist testing. Production startup fails when the required provider
// configuration is missing; nothing here ever fakes supplier success in
// production paths.
import { createHmac, createHash } from "node:crypto";

const hmacSha256 = (key, value) => createHmac("sha256", key).update(value).digest();
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

// Tencent Cloud TC3-HMAC-SHA256 request signing (shared by CAPTCHA and SMS).
export function tc3Sign({ method, host, service, action, version, region = "", secretId, secretKey, payload, now = new Date() }) {
  const timestamp = Math.floor(now.getTime() / 1000);
  const date = new Date(now).toISOString().slice(0, 10);
  const body = JSON.stringify(payload ?? {});
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    method, "/", "", canonicalHeaders, signedHeaders, sha256Hex(body),
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256", String(timestamp), credentialScope, sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacSha256(secretSigning, stringToSign).toString("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = {
    "content-type": contentType,
    host,
    "x-tc-action": action,
    "x-tc-version": version,
    "x-tc-timestamp": String(timestamp),
    authorization,
    ...(region ? { "x-tc-region": region } : {}),
  };
  return { url: `https://${host}`, body, headers };
}

const providerError = (code, message, statusCode = 503, retryable = true, failureKind = null) => Object.assign(new Error(message), { code, statusCode, retryable, ...(failureKind ? { failureKind } : {}) });
const maskPhone = (phone) => (phone?.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-2)}` : "****");
const maskTicket = (ticket) => (ticket ? `${ticket.slice(0, 8)}…` : null);

const jsonRequest = async (url, headers, body, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON response */ }
    if (!response.ok) {
      const message = json?.Response?.Error?.Message || json?.Response?.Error?.Code || `provider http ${response.status}`;
      const code = json?.Response?.Error?.Code || `PROVIDER_HTTP_${response.status}`;
      throw providerError(code, message, 503, true);
    }
    return json;
  } catch (error) {
    if (error?.name === "AbortError") throw providerError("PROVIDER_TIMEOUT", "供应商请求超时", 503, true);
    if (error?.code && error?.statusCode) throw error;
    throw providerError("PROVIDER_NETWORK", "无法连接供应商服务", 503, true);
  } finally {
    clearTimeout(timer);
  }
};

// CAPTCHA_APP_ID 必须是十进制正整数，转换后是安全整数。
export function validateCaptchaAppId(appId) {
  if (typeof appId !== "string" || !/^\d+$/.test(appId)) return null;
  const value = Number(appId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// 腾讯验证码 CaptchaCode 业务分类（DescribeCaptchaMiniResult）：
//   1   验证通过（无风险）
//   7   用户主动取消
//   15  票据过期
//   其余（0/8/10/16/21/25/26/31/100 等）为验证未通过/票据无效/服务拒绝
export function classifyCaptchaCode(code) {
  const value = Number(code);
  if (value === 1) return { outcome: "passed" };
  if (value === 7) return { outcome: "rejected", failureKind: "cancelled" };
  if (value === 15) return { outcome: "rejected", failureKind: "expired" };
  return { outcome: "rejected", failureKind: "invalid" };
}

// --- Tencent CAPTCHA --------------------------------------------------------
// 密钥职责分离（禁止复用同一个值）：
//   CAPTCHA_APP_ID            公开应用 ID（CaptchaAppId，小程序也可持有）
//   CAPTCHA_APP_SECRET_KEY    验证码 AppSecretKey（仅服务端，DescribeCaptchaMiniResult 请求体）
//   CAPTCHA_API_SECRET_ID/KEY 腾讯云 API 凭据（仅服务端，TC3-HMAC-SHA256 签名）
export function createTencentCaptchaProvider(config, logger = console) {
  const appId = validateCaptchaAppId(config.CAPTCHA_APP_ID);
  if (!appId) throw new Error("CAPTCHA_APP_ID 必须是十进制正整数且为安全整数");
  const appSecretKey = config.CAPTCHA_APP_SECRET_KEY;
  const apiSecretId = config.CAPTCHA_API_SECRET_ID;
  const apiSecretKey = config.CAPTCHA_API_SECRET_KEY;
  const region = config.CAPTCHA_REGION || "";
  const timeoutMs = Number(config.CAPTCHA_TIMEOUT_MS || 8000);
  const host = "captcha.tencentcloudapi.com";
  return Object.freeze({
    provider: "tencent_captcha",
    async verifyCaptcha({ ticket, randstr, purpose, ip }) {
      if (!ticket) throw providerError("CAPTCHA_TICKET_MISSING", "缺少人机验证票据", 422, false, "invalid");
      if (!apiSecretId || !apiSecretKey || !appSecretKey) throw providerError("CAPTCHA_NOT_CONFIGURED", "人机验证服务尚未配置", 503, true);
      if (appSecretKey === apiSecretKey) throw providerError("CAPTCHA_CONFIG_INVALID", "验证码 AppSecretKey 与 API SecretKey 禁止复用同一值", 503, false);
      // 小程序插件票据使用 DescribeCaptchaMiniResult（CaptchaType=9）二次校验。
      // 请求体只发送官方支持字段：CaptchaType/Ticket/UserIp/CaptchaAppId/AppSecretKey；
      // 不发送 UserAgent、Randstr 或任何未定义字段。
      // TC3 签名使用 API 凭据；AppSecretKey 只出现在请求体字段中。
      const target = tc3Sign({
        method: "POST", host, service: "captcha", action: "DescribeCaptchaMiniResult", version: "2019-07-22",
        region, secretId: apiSecretId, secretKey: apiSecretKey, now: new Date(),
        payload: {
          CaptchaType: 9, // 微信小程序验证码
          Ticket: ticket, UserIp: ip || "",
          CaptchaAppId: appId, AppSecretKey: appSecretKey,
        },
      });
      const json = await jsonRequest(target.url, target.headers, target.body, timeoutMs);
      const response = json?.Response || {};
      const { outcome, failureKind } = classifyCaptchaCode(response.CaptchaCode);
      logger.debug?.({ captchaCode: response.CaptchaCode, requestId: response.RequestId || null, ticketPrefix: maskTicket(ticket), purpose }, "captcha provider result");
      if (outcome === "passed") {
        // 返回腾讯 RequestId 与结果码；绝不返回完整 ticket。
        return { requestId: response.RequestId || null, captchaCode: Number(response.CaptchaCode) };
      }
      const code = failureKind === "expired" ? "CAPTCHA_EXPIRED" : failureKind === "cancelled" ? "CAPTCHA_CANCELLED" : "CAPTCHA_REJECTED";
      const message = failureKind === "expired" ? "验证已过期，请重新验证" : "验证未通过，请重试";
      throw providerError(code, message, 422, failureKind === "expired", failureKind);
    },
  });
}

// --- Tencent Cloud SMS ------------------------------------------------------
export function createTencentSmsProvider(config, logger = console) {
  const secretId = config.SMS_SECRET_ID;
  const secretKey = config.SMS_SECRET_KEY;
  const sdkAppId = config.SMS_SDK_APP_ID;
  const signName = config.SMS_SIGN_NAME;
  const templateIds = typeof config.SMS_TEMPLATE_IDS === "object" && config.SMS_TEMPLATE_IDS ? config.SMS_TEMPLATE_IDS : {};
  const timeoutMs = Number(config.SMS_TIMEOUT_MS || 8000);
  const host = "sms.tencentcloudapi.com";
  return Object.freeze({
    provider: "tencent_sms",
    async sendSms({ phone, code, purpose }) {
      const templateId = templateIds[purpose];
      if (!secretId || !sdkAppId || !signName || !templateId) throw providerError("SMS_NOT_CONFIGURED", "短信服务尚未配置", 503, true);
      const target = tc3Sign({
        method: "POST", host, service: "sms", action: "SendSms", version: "2021-01-11",
        region: "", secretId, secretKey, now: new Date(),
        payload: {
          SmsSdkAppId: String(sdkAppId), SignName: signName, TemplateId: String(templateId),
          TemplateParamSet: [String(code)], PhoneNumberSet: [String(phone)], SessionContext: `purpose:${purpose}`,
        },
      });
      const json = await jsonRequest(target.url, target.headers, target.body, timeoutMs);
      const status = json?.Response?.SendStatusSet?.[0] || {};
      logger.debug?.({ smsCode: status.Code, maskedPhone: maskPhone(phone), purpose, messageId: status.MessageId || null }, "sms provider result");
      if (status.Code === "Ok") return { messageId: status.MessageId || null };
      const message = status.Message || "短信发送失败";
      const failureCode = `SMS_SEND_REJECTED_${status.Code || "UNKNOWN"}`.slice(0, 100);
      // 供应商明确拒绝（模板未过审、签名不匹配、号段受限等）不可通过重试解决，
      // 归类为终态业务失败；余额/频率限制类错误保留可重试。
      const permanent = /Template|Sign|InvalidParameter|MissingParameter|Unauthorized/i.test(String(status.Code || ""));
      throw providerError(failureCode, message, permanent ? 422 : 503, !permanent);
    },
  });
}

// --- Sandbox（仅非生产、显式白名单） ----------------------------------------
export function createSandboxProviders(config, logger = console) {
  const whitelist = new Set(String(config.SMS_SANDBOX_WHITELIST_PHONES || "").split(",").map((item) => item.trim()).filter(Boolean));
  const fixedCode = String(config.SMS_SANDBOX_FIXED_CODE || "").match(/^\d{6}$/) ? config.SMS_SANDBOX_FIXED_CODE : null;
  if (whitelist.size === 0) throw new Error("AUTH_PROVIDER_MODE=sandbox requires SMS_SANDBOX_WHITELIST_PHONES with at least one E.164 phone");
  return Object.freeze({
    provider: "sandbox",
    // 固定验证码让沙箱“投递的验证码”与 challenge 存储的摘要一致（测试确定性）。
    async generateCode() { return fixedCode || null; },
    async verifyCaptcha({ ticket }) {
      if (!ticket) throw providerError("CAPTCHA_TICKET_MISSING", "缺少人机验证票据", 422, false, "invalid");
      // 沙箱只记录票据，不向真实供应商发起调用；生产环境禁止使用该模式。
      logger.warn?.({ ticketPrefix: maskTicket(ticket) }, "sandbox captcha accepted (non-production only)");
      return { requestId: `sandbox:${ticket.slice(0, 16)}`, captchaCode: 1 };
    },
    async sendSms({ phone, code, purpose }) {
      if (!whitelist.has(String(phone))) throw providerError("SMS_WHITELIST_REJECTED", "该手机号不在测试白名单内", 422, false);
      // 沙箱不真正发送短信；验证码只打印到本地开发输出，绝不写入业务日志或返回给客户端。
      process.stdout.write(`SANDBOX_SMS ${purpose} ${maskPhone(phone)} code=${fixedCode || code}\n`);
      return { messageId: `sandbox-${Date.now()}` };
    },
  });
}

// --- 选择与注入 -------------------------------------------------------------
// 显式组合，禁止用对象展开互相覆盖：只配置 CAPTCHA 时真实 verifyCaptcha 必须生效，
// 只配置 SMS 时真实 sendSms 必须生效；缺失的一侧返回可观察 503。
export function createConfiguredProviders(config, logger = console) {
  const mode = config.AUTH_PROVIDER_MODE || "tencent";
  if (mode === "sandbox") {
    if (config.NODE_ENV === "production") throw new Error("AUTH_PROVIDER_MODE=sandbox is forbidden in production");
    return createSandboxProviders(config, logger);
  }
  // CAPTCHA_APP_ID 只要填写就必须是十进制正整数（非数字/零/负数/超大均失败）。
  if (config.CAPTCHA_APP_ID && !validateCaptchaAppId(config.CAPTCHA_APP_ID)) {
    throw new Error("CAPTCHA_APP_ID 必须是十进制正整数且为安全整数");
  }
  const hasCaptcha = Boolean(config.CAPTCHA_APP_ID && config.CAPTCHA_APP_SECRET_KEY && config.CAPTCHA_API_SECRET_ID && config.CAPTCHA_API_SECRET_KEY);
  if (hasCaptcha && config.CAPTCHA_APP_SECRET_KEY === config.CAPTCHA_API_SECRET_KEY) {
    throw new Error("CAPTCHA_APP_SECRET_KEY 与 CAPTCHA_API_SECRET_KEY 禁止复用同一值（职责分离）");
  }
  const hasSms = Boolean(config.SMS_SECRET_ID && config.SMS_SECRET_KEY && config.SMS_SDK_APP_ID && config.SMS_SIGN_NAME && config.SMS_TEMPLATE_IDS);
  if (config.NODE_ENV === "production" && config.AUTH_SELF_SERVICE !== "disabled" && (!hasCaptcha || !hasSms)) {
    const missing = [hasCaptcha ? null : "CAPTCHA_APP_ID/CAPTCHA_APP_SECRET_KEY/CAPTCHA_API_SECRET_ID/CAPTCHA_API_SECRET_KEY", hasSms ? null : "SMS_SECRET_ID/SMS_SECRET_KEY/SMS_SDK_APP_ID/SMS_SIGN_NAME/SMS_TEMPLATE_IDS"].filter(Boolean);
    throw new Error(`生产环境必须配置真实认证供应商：${missing.join("、")}`);
  }
  const missing = missingProviders();
  // createTencentCaptchaProvider 内部会校验 CAPTCHA_APP_ID（非数字/零/负数/超大均抛错）。
  const captcha = hasCaptcha ? createTencentCaptchaProvider(config, logger) : null;
  const sms = hasSms ? createTencentSmsProvider(config, logger) : null;
  const composed = {
    provider: hasCaptcha && hasSms ? "tencent" : hasCaptcha ? "tencent_captcha_only" : hasSms ? "tencent_sms_only" : undefined,
    verifyCaptcha: captcha ? captcha.verifyCaptcha : missing.verifyCaptcha,
    sendSms: sms ? sms.sendSms : missing.sendSms,
  };
  if (captcha?.generateCode) composed.generateCode = captcha.generateCode;
  if (sms?.generateCode) composed.generateCode = sms.generateCode;
  return Object.freeze(composed);
}

export function missingProviders() {
  return Object.freeze({
    async verifyCaptcha() { throw providerError("SUPPLIER_NOT_CONFIGURED", "认证服务暂未配置", 503, true); },
    async sendSms() { throw providerError("SUPPLIER_NOT_CONFIGURED", "认证服务暂未配置", 503, true); },
  });
}

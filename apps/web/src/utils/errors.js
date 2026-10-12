// utils/errors.js（module-contracts §5.3；小程序 api.js:10-28 等价移植）
//
// 语义（R86 完整映射表——码判断先于状态码，命中即返回）：
// - BusinessError(kind, message, details = {})：name="BusinessError"、retryable、
//   requiresNewToken 均由 details 布尔化。
// - presentError(statusCode, payload) 优先级：
//   SMS_CODE_INVALIDATED/ATTEMPTS_EXHAUSTED→sms_invalidated；
//   QUESTIONNAIRE_SUBMITTED→questionnaire_submitted；CAPTCHA_EXPIRED→captcha_rejected；
//   CAPTCHA_REJECTED/CANCELLED→captcha_rejected；401→session（触发 R05）；403→forbidden；
//   409→conflict（透传 payload.error.message，兜底「内容已更新，请刷新后重试」，retryable/requiresNewToken 均布尔透传，R84）；
//   ≥500→service（retryable）；RECEIPT_LIMIT_EXCEEDED/RECEIPT_FILE_INVALID→validation；兜底→validation。

/** 业务错误（api.js:10-12 等价） */
export class BusinessError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = "BusinessError";
    this.kind = kind;
    this.retryable = Boolean(details.retryable);
    this.requiresNewToken = Boolean(details.requiresNewToken);
  }
}

/** 错误码→文案完整映射（R86 表序，api.js:14-28 行序一致） */
export function presentError(statusCode, payload) {
  const code = payload?.error?.code;
  if (code === "SMS_CODE_INVALIDATED" || code === "SMS_CODE_ATTEMPTS_EXHAUSTED") return new BusinessError("sms_invalidated", "验证码已失效，请重新发送并完成人机验证");
  if (code === "QUESTIONNAIRE_SUBMITTED") return new BusinessError("questionnaire_submitted", "任务已提交，小票不可再查看或修改");
  if (code === "CAPTCHA_EXPIRED") return new BusinessError("captcha_rejected", "验证已过期，请重新验证");
  if (code === "CAPTCHA_REJECTED" || code === "CAPTCHA_CANCELLED") return new BusinessError("captcha_rejected", "验证未通过，请重新验证");
  if (statusCode === 401) return new BusinessError("session", "登录已失效，请重新登录");
  if (statusCode === 403) return new BusinessError("forbidden", "你没有权限进行此操作");
  // 409 的具体原因由服务端给出（未到开始时间 / 需先打卡 / 内容已更新等），直接透出后端中文文案；
  // retryable（SUBMIT_PROCESSING）与 requiresNewToken（TASK_OVERDUE）双标志布尔透传，页面提交三态分流的唯一依据。
  if (statusCode === 409) return new BusinessError("conflict", payload?.error?.message || "内容已更新，请刷新后重试", { retryable: payload?.error?.retryable, requiresNewToken: payload?.error?.requiresNewToken });
  if (statusCode >= 500) return new BusinessError("service", "服务暂时不可用，请稍后重试", { retryable: true });
  if (code === "RECEIPT_LIMIT_EXCEEDED") return new BusinessError("validation", "最多只能上传 9 张消费小票");
  if (code === "RECEIPT_FILE_INVALID") return new BusinessError("validation", "请选择 10MB 以内的图片");
  return new BusinessError("validation", "操作未完成，请检查填写内容");
}

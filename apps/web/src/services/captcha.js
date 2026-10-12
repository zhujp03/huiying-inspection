// services/captcha.js（module-contracts §3.7；小程序 services/captcha.js:3-13 + captcha-host.js:12-24）
// 无网络端点（客户端验证码链）。Web 验证码方案由页面桥注入 adapter，ticket/randstr 契约不变。
//
// 语义（R17/R18）：
// - obtainCaptchaTicket(scene, adapter) → Promise<{ ticket, randstr }>；
//   scene ∈ register / password_reset / registration_resubmit（登录本身不需要验证码）。
// - adapter 非函数（宿主缺失/加载失败）→ BusinessError(kind=captcha,「行为验证服务暂时不可用，请稍后重试」)；
//   返回的 ticket 空/非字符串 → BusinessError(kind=captcha,「行为验证未完成，请重试」)；
//   成功返回 { ticket, randstr: ticket.randstr || "" }（randstr 允许空串）。
// - kind 三分工：captcha=客户端获取失败（本模块）；captcha_cancel=用户取消（页面桥）；
//   captcha_rejected=服务端拒票（utils/errors.presentError 映射）。
import { BusinessError } from "../utils/errors.js";

export async function obtainCaptchaTicket(scene, adapter) {
  if (typeof adapter !== "function") {
    throw new BusinessError("captcha", "行为验证服务暂时不可用，请稍后重试");
  }
  const ticket = await adapter({ scene });
  if (!ticket || typeof ticket.ticket !== "string" || !ticket.ticket) {
    throw new BusinessError("captcha", "行为验证未完成，请重试");
  }
  return { ticket: ticket.ticket, randstr: ticket.randstr || "" };
}

import { BusinessError } from "./api.js";

export async function obtainCaptchaTicket(scene) {
  const adapter = getApp().globalData.captchaAdapter;
  if (typeof adapter !== "function") throw new BusinessError("captcha", "行为验证服务暂时不可用，请稍后重试");
  const ticket = await adapter({ scene });
  // 小程序插件 2.1.4 的 verify 事件只保证 ret===0 + ticket 非空（见登录页
  // onCaptchaVerify）；randstr 仅 Web 场景存在，允许为空。
  if (!ticket?.ticket || typeof ticket.ticket !== "string" || ticket.ticket.length === 0) {
    throw new BusinessError("captcha", "行为验证未完成，请重试");
  }
  return { ticket: ticket.ticket, randstr: ticket.randstr || "" };
}

// CAPTCHA 宿主桥：页面把腾讯验证码插件组件（plugin://captcha/t-captcha）注册为
// 一次性 verify 实现；app.js 用它初始化全局 captchaAdapter。任何 Secret 都不
// 进入小程序包，客户端只取得可交给后端二次校验的 ticket。
import { BusinessError } from "./api.js";

let registeredHost = null;

export function registerCaptchaHost(host) {
  registeredHost = host;
}

export function createCaptchaAdapter() {
  return async ({ scene }) => {
    const host = registeredHost;
    if (!host || typeof host.verify !== "function") {
      throw new BusinessError("captcha", "行为验证服务暂时不可用，请稍后重试");
    }
    const ticket = await host.verify(scene);
    if (!ticket || typeof ticket !== "object" || !ticket.ticket) {
      throw new BusinessError("captcha", "行为验证未完成，请重试");
    }
    return ticket;
  };
}

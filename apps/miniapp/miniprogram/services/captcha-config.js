// 腾讯验证码公共配置：CaptchaAppId 由公开配置接口（GET /api/public/client-config）
// 在运行时下发；小程序包内不再包含任何占位值或密钥。
// 任何 AppSecretKey / API SecretId / API SecretKey 都绝对不允许出现在小程序包中，
// 它们只存在于服务端（apps/api 的 CAPTCHA_APP_SECRET_KEY / CAPTCHA_API_SECRET_*）。
export function resolveCaptchaAppId() {
  return getApp()?.globalData?.publicConfig?.captchaAppId || "";
}

// services/auth.js（module-contracts §3.1；小程序 api.js:56-63 同名同语义）
// 端点映射（packages/contracts/endpoint-registry.js auth 组）：
//   login               → POST auth.login                （/api/auth/login）
//   logout              → POST auth.logout               （/api/auth/logout）
//   requestRegisterCode → POST auth.registerPhoneCode    （/api/auth/register/phone-code）
//   register            → POST auth.register             （/api/auth/register）
//   resubmitRegistration→ POST auth.registrationResubmit （/api/auth/registration/resubmit）
//   requestPasswordCode → POST auth.passwordCode         （/api/auth/password-resets/code）
//   verifyPasswordCode  → POST auth.passwordVerify       （/api/auth/password-resets/verify）
//   completePasswordReset→ POST auth.passwordComplete    （/api/auth/password-resets/complete）
//
// 会话语义（R06/R08/R10）：login 成功 saveSession(result)（任务缓存经 cache-epoch 失效）；
// logout 无论成败（try/finally 语义）清会话与用户缓存；其余六个函数纯端点转发。
import { request } from "../adapters/http.js";
import { saveSession, clearSessionAndUserCache } from "../store/session.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

export function login(credentials) {
  return request({ url: endpointRegistry.auth.login.path(), method: "POST", data: credentials }).then((result) => {
    saveSession(result);
    return result;
  });
}

export function logout() {
  return request({ url: endpointRegistry.auth.logout.path(), method: "POST" }).finally(() => {
    clearSessionAndUserCache();
  });
}

export function requestRegisterCode(payload) {
  return request({ url: endpointRegistry.auth.registerPhoneCode.path(), method: "POST", data: payload });
}

export function register(payload) {
  return request({ url: endpointRegistry.auth.register.path(), method: "POST", data: payload });
}

export function resubmitRegistration(payload) {
  return request({ url: endpointRegistry.auth.registrationResubmit.path(), method: "POST", data: payload });
}

export function requestPasswordCode(payload) {
  return request({ url: endpointRegistry.auth.passwordCode.path(), method: "POST", data: payload });
}

export function verifyPasswordCode(payload) {
  return request({ url: endpointRegistry.auth.passwordVerify.path(), method: "POST", data: payload });
}

export function completePasswordReset(payload) {
  return request({ url: endpointRegistry.auth.passwordComplete.path(), method: "POST", data: payload });
}

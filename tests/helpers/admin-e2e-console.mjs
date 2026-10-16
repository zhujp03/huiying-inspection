import { expect } from "@playwright/test";

// Admin e2e 控制台分类器：
// 会话恢复以服务端 cookie 为唯一权威——匿名冷加载对 /api/me 的探测返回 401 是预期内的认证信号，
// 浏览器会为其记录 console error（开发态 StrictMode 探测两次，即两条）。豁免与「实际观测到的
// /api/me 401 响应」一一对应：只豁免同文本 console error 中等量的条目，并且要求整个页面生命周期
// 内除 /api/me 外没有其他任何 401 响应——其他端点的 401 一律视为断言失败，不做文本级泛化豁免。
//
// 例外（显式 opt-in）：会话过期恢复用例中，任意受保护端点的 401 正是「过期→登录遮罩」流程的
// 触发信号（allowSession401: true 时与其他 401 同口径豁免）；注入式失败（403 CSRF 拒绝、
// 断连、503、注入式坏响应的契约校验日志等）会产生资源加载/诊断类 console error（allowHttpFailures: n 豁免等量该类文本）。
const EXPECTED_401_TEXT = "Failed to load resource: the server responded with a status of 401 (Unauthorized)";

export function attachBusinessConsoleCollector(page, { allowSession401 = false, allowHttpFailures = 0 } = {}) {
  const messages = [];
  const other401Urls = [];
  let anonymousMe401Count = 0;
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) messages.push(message.text()); });
  page.on("response", (response) => {
    let pathname = "";
    try { pathname = new URL(response.url()).pathname; } catch { /* 忽略无法解析的 URL */ }
    if (response.status() !== 401) return;
    if (pathname === "/api/me") anonymousMe401Count += 1;
    else if (allowSession401) anonymousMe401Count += 1; // 过期恢复用例：业务端点 401 与 /api/me 同为预期信号
    else other401Urls.push(response.url());
  });
  let httpFailuresRemaining = allowHttpFailures;
  return {
    messages,
    async expectClean() {
      const remaining = [];
      let toConsume = anonymousMe401Count;
      for (const text of messages) {
        if (toConsume > 0 && text === EXPECTED_401_TEXT) { toConsume -= 1; continue; }
        if (httpFailuresRemaining > 0 && /Failed to load resource|net::|Response contract validation failed/.test(text)) { httpFailuresRemaining -= 1; continue; }
        remaining.push(text);
      }
      expect(remaining).toEqual([]);
      // 精确性兜底：除 /api/me 探测（或显式声明会话过期用例）外不允许任何 401 响应混入干净用例。
      expect(other401Urls).toEqual([]);
      return remaining;
    },
  };
}

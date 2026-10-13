import { expect } from "@playwright/test";

// Admin e2e 控制台分类器：
// 会话恢复以服务端 cookie 为唯一权威——匿名冷加载对 /api/me 的探测返回 401 是预期内的认证信号，
// 浏览器会为其记录 console error（开发态 StrictMode 探测两次，即两条）。豁免与「实际观测到的
// /api/me 401 响应」一一对应：只豁免同文本 console error 中等量的条目，并且要求整个页面生命周期
// 内除 /api/me 外没有其他任何 401 响应——其他端点的 401 一律视为断言失败，不做文本级泛化豁免。
const EXPECTED_401_TEXT = "Failed to load resource: the server responded with a status of 401 (Unauthorized)";

export function attachBusinessConsoleCollector(page) {
  const messages = [];
  const other401Urls = [];
  let anonymousMe401Count = 0;
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) messages.push(message.text()); });
  page.on("response", (response) => {
    let pathname = "";
    try { pathname = new URL(response.url()).pathname; } catch { /* 忽略无法解析的 URL */ }
    if (response.status() !== 401) return;
    if (pathname === "/api/me") anonymousMe401Count += 1;
    else other401Urls.push(response.url());
  });
  return {
    messages,
    async expectClean() {
      const remaining = [];
      let toConsume = anonymousMe401Count;
      for (const text of messages) {
        if (toConsume > 0 && text === EXPECTED_401_TEXT) { toConsume -= 1; continue; }
        remaining.push(text);
      }
      expect(remaining).toEqual([]);
      // 精确性兜底：除 /api/me 探测外不允许任何 401 响应混入干净用例。
      expect(other401Urls).toEqual([]);
      return remaining;
    },
  };
}

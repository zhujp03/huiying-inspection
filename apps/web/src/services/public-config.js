// services/public-config.js（module-contracts §3.6；小程序 app.js:24-42 直连移植）
// 端点映射：public.clientConfig → GET /api/public/client-config（同源相对路径，
// URL 经 registry 条目 .path() 构建，R0）。
//
// 语义（R12）：
// - 5 秒超时；无 Bearer、无 dedupe（不走 adapters/http 的会话注入）。
// - 非 200 / 响应非对象 / 任何异常（含网络失败与超时）→ 返回 null（不抛错）。
// - 200 且响应为对象 → 原样返回。配置仅内存态、无持久化。
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

const TIMEOUT_MS = 5000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function loadPublicConfig() {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, TIMEOUT_MS);
    fetch(endpointRegistry.public.clientConfig.path(), {
      method: "GET",
      headers: { Accept: "application/json" },
      // 公开配置无会话语义：同样不带浏览器 cookie（同宿主 Admin cookie 串扰防护）。
      credentials: "omit",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status < 200 || response.status >= 300) {
          resolve(null);
          return;
        }
        let parsed = null;
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
        resolve(isPlainObject(parsed) ? parsed : null);
      })
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timer));
  });
}

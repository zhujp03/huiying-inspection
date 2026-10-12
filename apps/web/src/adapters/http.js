// adapters/http.js（module-contracts §2.1）
// 平台数据面：HTTP 运输层。等价小程序 services/api.js request()（api.js:30-54）。
// 零域名（rules.md R0）：请求 URL 即同源相对路径本身（以 /api 开头），由服务层经
// packages/contracts/endpoint-registry.js 条目的 .path(...) 构建；本模块不拼接任何
// base/origin、不读取任何构建期注入的 API 地址变量。
//
// 语义（R04/R05/R11/R87/R88）：
// - request({ url, method = "GET", data, validate, dedupeKey })；超时 12000ms；
//   请求头恒带 Accept/Content-Type: application/json，会话存在（session.accessToken）
//   时注入 Authorization: Bearer <token>。
// - 非 2xx → utils/errors.presentError；kind=session（401）时调 router/guards 的
//   handleUnauthorized()（清会话与用户缓存，任务缓存经 junde:cache-epoch 失效）。
// - 2xx → validate(parsed)（缺省按非 null 对象校验）；校验器抛错 → BusinessError("contract", …)。
// - 网络失败：超时 → kind timeout「请求超时，请检查网络后重试」；其他 → kind network
//   「暂时无法连接服务，请检查网络后重试」；均 retryable。
// - dedupe：模块级 pending Map，key = 显式 dedupeKey 或 `${method}:${url}`；进行中的
//   同 key 请求复用同一 Promise，settle 后删除——只合并并发、不缓存结果。
import { BusinessError, presentError } from "../utils/errors.js";
import { getSession } from "../store/session.js";
import { handleUnauthorized } from "../router/guards.js";

const pending = new Map();
const TIMEOUT_MS = 12000;

function assertObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
  return value;
}

// 204 / 空 body 兜底：解析失败按 null 交给校验器判定。
async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function request({ url, method = "GET", data, validate, dedupeKey }) {
  const key = dedupeKey || `${method}:${url}`;
  if (pending.has(key)) return pending.get(key);
  const promise = new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new BusinessError("timeout", "请求超时，请检查网络后重试", { retryable: true }));
    }, TIMEOUT_MS);
    const session = getSession();
    fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      },
      body: data === undefined ? (method === "GET" || method === "HEAD" ? undefined : "{}") : JSON.stringify(data),
      // H5 探员端只认 bearer：显式不带浏览器凭据（cookie）。本机 H5(5174) 与 Admin 后台同宿主，
      // admin 的 junde_admin_session cookie（path=/api，cookie 不分端口）会随同源 /api 请求自动携带，
      // 服务端对 bearer+cookie 并存故意拒绝（AUTH_AMBIGUOUS）；omit 保证同浏览器双端登录互不干扰。
      credentials: "omit",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status < 200 || response.status >= 300) {
          const error = presentError(response.status, await parseJson(response));
          if (error.kind === "session") handleUnauthorized();
          reject(error);
          return;
        }
        try {
          resolve((validate || assertObject)(await parseJson(response)));
        } catch {
          reject(new BusinessError("contract", "服务返回的数据暂时无法使用，请稍后重试"));
        }
      })
      .catch((error) => {
        reject(
          error?.name === "AbortError"
            ? new BusinessError("timeout", "请求超时，请检查网络后重试", { retryable: true })
            : new BusinessError("network", "暂时无法连接服务，请检查网络后重试", { retryable: true }),
        );
      })
      .finally(() => clearTimeout(timer));
  }).finally(() => {
    pending.delete(key);
  });
  pending.set(key, promise);
  return promise;
}

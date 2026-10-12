import { ApiErrorSchema, parseResponse } from "../../../../packages/contracts/index.js";

const DEFAULT_TIMEOUT_MS = 12000;
let csrfToken = null;

export function setCsrfToken(value) { csrfToken = value || null; }

export class BusinessApiError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = "BusinessApiError";
    this.kind = kind;
    this.retryable = Boolean(options.retryable);
    this.requiresNewToken = Boolean(options.requiresNewToken);
  }
}

function apiBase() {
  const value = import.meta.env.VITE_API_BASE_URL;
  if (!value) return "";
  return value.replace(/\/$/, "");
}

function businessError(status, payload) {
  const parsed = ApiErrorSchema.safeParse(payload);
  const code = parsed.success ? parsed.data.error.code : "UNKNOWN";
  const flags = parsed.success ? parsed.data.error : {};
  if (status === 401) return new BusinessApiError("session", "登录已失效，请重新登录");
  if (status === 403) return new BusinessApiError("forbidden", (parsed.success && parsed.data.error.message) || "你没有权限进行此操作");
  if (status === 409) return new BusinessApiError("conflict", code === "TASK_OVERDUE" ? "任务已逾期，请先延期后再继续" : "内容已更新，请刷新后重试", flags);
  if (status >= 500) return new BusinessApiError("service", "服务暂时不可用，请稍后重试", { retryable: true });
  const issueMessage = parsed.success ? parsed.data.error.issues?.[0]?.message : null;
  return new BusinessApiError("validation", issueMessage || (parsed.success && parsed.data.error.message ? parsed.data.error.message : "操作未完成，请检查填写内容"), flags);
}

export async function request(path, { method = "GET", body, schema, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      method,
      credentials: "include",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) && csrfToken ? { "X-CSRF-Token": csrfToken, "Idempotency-Key": crypto.randomUUID() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw businessError(response.status, payload);
    if (!schema) return payload;
    try {
      return parseResponse(schema, payload);
    } catch (error) {
      if (import.meta.env.DEV) console.error("Response contract validation failed", error);
      throw new BusinessApiError("contract", "服务返回的数据暂时无法使用，请稍后重试");
    }
  } catch (error) {
    if (error instanceof BusinessApiError) throw error;
    if (error?.name === "AbortError") throw new BusinessApiError("timeout", "请求超时，请检查网络后重试", { retryable: true });
    if (import.meta.env.DEV) console.error("Admin request failed", error);
    throw new BusinessApiError("network", "暂时无法连接服务，请检查网络后重试", { retryable: true });
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

import { API, AdminSessionSchema, ApiErrorSchema, parseResponse } from "../../../../packages/contracts/index.js";

const DEFAULT_TIMEOUT_MS = 12000;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
let csrfToken = null;

export function setCsrfToken(value) { csrfToken = value || null; }

// —— 认证代际栅栏与会话身份 ——
// 内存代际是唯一权威（任何环境、含禁用存储时都有效）；localStorage 只作为跨标签的单调标记
// 增强（读取时做 max 合并、写入失败即忽略），不依赖「读+增+写」的原子性。每次认证身份变化
// （登录/登出/会话过期）推进代际；请求在发出时记下代际，响应回来（无论成功/失败，也无论
// JSON 解析前后）若代际已变，该响应属于「旧身份的迟到回调」：一律按 stale 丢弃——不落数据、
// 不设令牌、不触发过期遮罩、绝不重放旧写入。只存单调计数器与内存中的登录用户 id，绝不持久化令牌/口令。
let memoryGeneration = 0;
let authenticatedUserId = null; // 仅内存：有效恢复/登录成功时记录，主动登出清除
const AUTH_GENERATION_KEY = "junde-admin-auth-generation";
function readAuthGeneration() {
  try {
    const stored = Number(window.localStorage.getItem(AUTH_GENERATION_KEY));
    if (Number.isFinite(stored) && stored > memoryGeneration) memoryGeneration = stored; // 吸收其他标签页的推进
  } catch { /* 存储不可用：本标签内存代际依旧完整有效 */ }
  return memoryGeneration;
}
function advanceAuthGeneration() {
  const next = readAuthGeneration() + 1; // max(本地, 其他标签) + 1：并发推进也严格递增
  memoryGeneration = next;
  try { window.localStorage.setItem(AUTH_GENERATION_KEY, String(next)); } catch { /* 同上 */ }
  return next;
}
// 认证身份切换时调用：登录请求成功、登出、会话过期。渲染层（AdminAuth）与 client 自身
// （认证端点成功响应）都会触发，保证竞态窗口以「服务端 cookie 变化」为准而非 React 渲染时机。
export function notifyAuthChange() {
  advanceAuthGeneration();
}
// 记录/清除当前登录用户（仅内存）：供 CSRF 刷新核对「刷新到的会话是否仍是发起请求的那个用户」。
export function setAuthenticatedUser(userId) { authenticatedUserId = userId || null; }
// 认证端点：成功响应即代表服务端 cookie 已经/即将变化，立刻推进代际。
const AUTH_TRANSITION_PATHS = new Set([API.auth.adminLogin, API.auth.adminLogout, API.auth.login, API.auth.logout]);

// BusinessApiError 携带稳定业务码（code）与 HTTP 状态（status）：调用方按码精确分流
// （REVISION_CONFLICT 走冲突对照、STORE_CONFLICT 走唯一编号对账、CSRF_INVALID 走安全重试），
// 不再依赖错误文案猜测；message 优先采用服务端返回的原始文案。
export class BusinessApiError extends Error {
  constructor(kind, message, options = {}) {
    super(message);
    this.name = "BusinessApiError";
    this.kind = kind;
    this.code = options.code || null;
    this.status = options.status || null;
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
  const serverMessage = parsed.success && parsed.data.error.message ? parsed.data.error.message : null;
  if (status === 401) return new BusinessApiError("session", serverMessage || "登录已失效，请重新登录", { code, status, ...flags });
  if (status === 403) return new BusinessApiError("forbidden", serverMessage || "你没有权限进行此操作", { code, status, ...flags });
  // 409 透传服务端消息（如「该门店已被探店任务引用，无法删除，可改为停用」），
  // 不再用泛化的「内容已更新」遮蔽具体业务限制。
  if (status === 409) return new BusinessApiError("conflict", serverMessage || "内容已更新，请刷新后重试", { code, status, ...flags });
  if (status >= 500) return new BusinessApiError("service", serverMessage || "服务暂时不可用，请稍后重试", { code, status, retryable: true });
  const issueMessage = parsed.success ? parsed.data.error.issues?.[0]?.message : null;
  return new BusinessApiError("validation", issueMessage || serverMessage || "操作未完成，请检查填写内容", { code, status, ...flags });
}

// 单飞刷新 CSRF（按 代际+归属 键控，新代际绝不复用旧探测）：CSRF 拒绝发生在任何业务写入之前，
// 属于「确定未落库」的安全失败，刷新令牌后允许对这一类失败精确重试一次；其余错误绝不自动重放。
// 会话身份核对：cookie 可能在本标签之外被更换（其他标签/外部调用）而本标签代际未知，
// 刷新到的 /api/me 归属必须是发起请求时的用户，且采纳令牌前再核对一次代际+归属，否则 fail closed。
let csrfRefresh = null; // { generation, owner, promise }
function refreshCsrfToken(expectedOwner) {
  const generation = readAuthGeneration();
  if (csrfRefresh && csrfRefresh.generation === generation && csrfRefresh.owner === expectedOwner) return csrfRefresh.promise;
  const promise = request(API.auth.me, { schema: AdminSessionSchema })
    .then((result) => {
      if (result.user?.id !== expectedOwner) {
        throw Object.assign(new BusinessApiError("session", "登录身份已变化，请重新登录后再试", { code: "SESSION_OWNER_CHANGED" }), { ownerChanged: true });
      }
      if (readAuthGeneration() !== generation || authenticatedUserId !== expectedOwner) {
        throw Object.assign(new BusinessApiError("stale", "该响应已过期，已忽略", { code: "STALE_RESPONSE" }), { stale: true });
      }
      setCsrfToken(result.csrfToken);
      return result.csrfToken;
    })
    .finally(() => { if (csrfRefresh && csrfRefresh.promise === promise) csrfRefresh = null; }); // 只清自己的缓存
  csrfRefresh = { generation, owner: expectedOwner, promise };
  return promise;
}

// 单飞探测当前 cookie 的真实身份（按 代际+归属 键控，新代际绝不复用被丢弃的旧探测）：
// 401 可能针对的是已被其他标签/外部操作更换的旧凭证。探测结果三态：
//   { id }   → cookie 仍有效（换人了或未失效）→ 该 401 按 stale 处理；
//   null     → 确认匿名 → 维持过期恢复流；
//   undefined→ 探测自身被栅栏丢弃（身份未知）→ 调用方必须按代际复核 fail closed。
let meProbe = null; // { generation, owner, promise }
function probeCurrentUser() {
  const generation = readAuthGeneration();
  const owner = authenticatedUserId;
  if (meProbe && meProbe.generation === generation && meProbe.owner === owner) return meProbe.promise;
  const promise = request(API.auth.me, { schema: AdminSessionSchema })
    .then((result) => ({ id: result.user.id }))
    .catch((error) => (error?.kind === "stale" ? undefined : null))
    .finally(() => { if (meProbe && meProbe.promise === promise) meProbe = null; }); // 只清自己的缓存
  meProbe = { generation, owner, promise };
  return promise;
}

export async function request(path, options = {}) {
  const { method = "GET", body, schema, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const authGeneration = readAuthGeneration();
  const requestOwner = authenticatedUserId;
  let effectiveGeneration = authGeneration;
  let stale = false;
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
    // 认证切换端点：仅当本响应自身未过期（期间没有发生更新的认证）时才推进代际并生效——
    // 迟到的旧登录/旧登出响应既不能推进代际，也不能替换更晚完成的认证。
    const alreadyStale = readAuthGeneration() !== authGeneration;
    if (response.ok && AUTH_TRANSITION_PATHS.has(path) && !alreadyStale) effectiveGeneration = advanceAuthGeneration();
    stale = alreadyStale;
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    // JSON 解析的等待窗口内身份可能再次变化：采纳任何数据/令牌前重新核对。
    if (!stale && readAuthGeneration() !== effectiveGeneration) stale = true;
    if (!response.ok) {
      const error = businessError(response.status, payload);
      if (stale) {
        // 旧身份的迟到响应：绝不触发过期遮罩，也绝不允许其触发刷新/重放。
        error.stale = true;
        if (error.kind === "session") error.kind = "stale";
        throw error;
      }
      if (error.kind === "session" && path !== API.auth.me) {
        // 401 核对当前 cookie 真实身份：仍有效（其他标签已换人登录）→ 按 stale 处理，
        // 不遮罩新登录、不重放；确实匿名 → 维持可恢复的过期恢复流。
        const current = await probeCurrentUser();
        // 探测等待期间身份可能再次切换（新登录使本请求过期），或探测自身被栅栏丢弃（身份未知）：
        // 一律以最新代际复核后 fail closed，绝不把旧身份的 401 交给调用方触发过期遮罩。
        if (readAuthGeneration() !== authGeneration || current === undefined || current) {
          error.stale = true;
          error.kind = "stale";
          throw error;
        }
      }
      if (error.code === "CSRF_INVALID" && MUTATION_METHODS.has(method) && !options.csrfRetried && readAuthGeneration() === authGeneration) {
        try {
          await refreshCsrfToken(requestOwner);
          // 等待刷新期间身份可能已切换：重放前核对代际与归属，
          // 旧请求的请求体绝不在新身份下重放。
          if (readAuthGeneration() !== authGeneration || authenticatedUserId !== requestOwner) {
            error.stale = true;
            error.kind = "stale";
            throw error;
          }
          if (csrfToken && readAuthGeneration() === authGeneration && authenticatedUserId === requestOwner) {
            return request(path, { ...options, csrfRetried: true });
          }
        } catch (refreshError) {
          // 身份易主或会话失效：fail closed 交还给调用方进入可恢复的重认证，绝不重放。
          if (refreshError?.ownerChanged || refreshError?.kind === "session") throw refreshError;
          /* 其他刷新失败：按原错误返回 */
        }
      }
      throw error;
    }
    if (stale) {
      // 迟到的成功响应（如跨账号登录后返回的旧 /api/me）：丢弃，不落数据、不设令牌。
      throw new BusinessApiError("stale", "该响应已过期，已忽略", { code: "STALE_RESPONSE" });
    }
    if (!schema) return payload;
    try {
      return parseResponse(schema, payload);
    } catch (error) {
      if (import.meta.env.DEV) console.error("Response contract validation failed", error);
      throw new BusinessApiError("contract", "服务返回的数据暂时无法使用，请稍后重试", { code: "CONTRACT_MISMATCH", status: response.status });
    }
  } catch (error) {
    if (error instanceof BusinessApiError) {
      // 分类前核对新鲜度：等待期间身份切换的任何错误一律按 stale 交付，
      // 调用方据此跳过过期遮罩、对账导航与重试，绝不把旧身份的错误当新身份的状态。
      if (!error.stale && readAuthGeneration() !== effectiveGeneration) {
        error.stale = true;
        if (error.kind === "session") error.kind = "stale";
      }
      throw error;
    }
    if (error?.name === "AbortError") {
      // 卸载/依赖变化引发的中止是常规控制流（历史上就不进控制台），保持静默；身份切换时按 stale 交付。
      const timeoutError = new BusinessApiError("timeout", "请求超时，请检查网络后重试", { retryable: true });
      if (readAuthGeneration() !== effectiveGeneration) { timeoutError.stale = true; timeoutError.kind = "stale"; }
      throw timeoutError;
    }
    const networkError = new BusinessApiError("network", "暂时无法连接服务，请检查网络后重试", { retryable: true });
    const staleTransport = readAuthGeneration() !== effectiveGeneration;
    if (staleTransport) { networkError.stale = true; networkError.kind = "stale"; }
    if (import.meta.env.DEV && !staleTransport) console.error("Admin request failed", error);
    throw networkError;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

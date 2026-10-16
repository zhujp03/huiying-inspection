import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ZodError } from "zod";
import { databaseReady } from "./db/pool.js";
import { createPasswordService } from "./auth/passwords.js";
import { missingProviders } from "./auth/providers.js";
import { createMetrics, renderMetrics } from "./observability/metrics.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerCampaignCleanupRoutes } from "./admin/campaign-cleanup.js";
import { registerBatch2Routes } from "./batch2/routes.js";
import { registerBatch3Routes } from "./batch3/routes.js";
import { registerBatch4Routes } from "./batch4/routes.js";
import { registerBatch5Routes } from "./batch5/routes.js";
import { registerStatsRoutes } from "./stats/routes.js";
import { createStorageProvider } from "./storage/index.js";
import { registerLocalStorageRoutes } from "./storage/routes.js";
import { registerRenderStaticRoutes } from "./render-static.js";
import { publicClientConfig } from "./config.js";

const errorBody = (code, message, requestId, options = {}) => ({ error: { code, message, requestId, ...options } });

export function buildApp({ config, pool, providers, storage, staticDirs, logger = true } = {}) {
  // 受限 trustProxy：只信任显式配置的反向代理 CIDR，不允许任意客户端伪造
  // X-Forwarded-For 改变 request.ip（限流与打卡 IP 绑定都依赖它）。
  const trustProxy = config.TRUST_PROXY ? String(config.TRUST_PROXY).split(",").map((item) => item.trim()).filter(Boolean) : false;
  const app = Fastify({ logger: logger ? { redact: ["req.headers.authorization", "req.headers.cookie", "req.body.password", "req.body.smsCode", "req.body.captchaTicket", "req.body.captchaRandstr"] } : false, requestIdHeader: "x-request-id", genReqId: () => randomUUID(), requestTimeout: config.API_REQUEST_TIMEOUT_MS, connectionTimeout: 2000, bodyLimit: 1024 * 1024, trustProxy });
  const metrics = createMetrics();
  const startedAt = Date.now();
  app.register(cookie);
  // @fastify/cors v11 默认只允许 GET/HEAD/POST，会拦截 PATCH/PUT/DELETE 的预检；
  // 显式放开全部 HTTP 方法，否则后台的编辑/删除类请求会被浏览器 CORS 预检直接拒绝。
  // Origin 策略：生产只精确允许 ADMIN_ORIGIN；开发/测试额外允许本机来源
  // （localhost/127.0.0.1 任意端口），使本机 Admin dev server 不受 .env 域名占位值影响；
  // 小程序 wx.request 不带 Origin，不需要 CORS 头。
  const adminOrigin = config.ADMIN_ORIGIN || "";
  const corsOrigin = (origin, cb) => {
    if (!origin) return cb(null, false);
    if (origin === adminOrigin) return cb(null, true);
    const localhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (config.NODE_ENV !== "production" && localhostOrigin) return cb(null, true);
    return cb(null, false);
  };
  app.register(cors, { origin: corsOrigin, credentials: true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });
  app.decorate("jundeCos", storage || createStorageProvider(config));
  app.addHook("onRequest", (request, _reply, done) => { request.requestStartAt = performance.now(); done(); });
  app.addHook("onResponse", (request, reply, done) => {
    const started = Number(request.requestStartAt || performance.now());
    metrics.requestEnd(started, reply.statusCode, request.routeOptions?.url || request.url);
    done();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      // 校验失败返回具体字段与原因，前端直接展示首个 issue 的 message，便于用户修正。
      const issues = error.issues.map((issue) => ({ path: issue.path.join(".") || "(root)", message: issue.message }));
      return reply.code(422).send(errorBody("VALIDATION_FAILED", issues[0]?.message || "提交内容不符合要求", request.id, { issues }));
    }
    if (error?.statusCode) {
      if (error.retryable) reply.header("Retry-After", "1");
      return reply.code(error.statusCode).send(errorBody(error.code || "REQUEST_FAILED", error.message, request.id, { retryable: Boolean(error.retryable), requiresNewToken: Boolean(error.requiresNewToken) }));
    }
    if (error?.code === "AUTH_BUSY") return reply.header("Retry-After", "1").code(503).send(errorBody("AUTH_BUSY", "服务繁忙，请稍后重试", request.id, { retryable: true }));
    if (["DATABASE_BUSY", "40001", "40P01", "55P03", "ETIMEDOUT"].includes(error?.code) || /timeout exceeded when trying to connect|connection timeout/i.test(error?.message || "")) return reply.header("Retry-After", "1").code(503).send(errorBody("DATABASE_BUSY", "服务繁忙，请稍后重试", request.id, { retryable: true }));
    request.log.error({ err: error, requestId: request.id }, "request failed");
    return reply.code(500).send(errorBody("INTERNAL_ERROR", "服务暂时不可用，请稍后重试", request.id, { retryable: true }));
  });
  // 健康检查：/health/live 与 /health/ready 为规范路径；/live、/ready 为兼容别名。
  const live = async () => ({ status: "ok" });
  const ready = async (request, reply) => {
    try {
      if (await databaseReady(pool)) return { status: "ready" };
    } catch (error) { request.log.warn({ err: error }, "database readiness failed"); }
    return reply.code(503).send(errorBody("DATABASE_UNAVAILABLE", "服务暂未就绪", request.id, { retryable: true }));
  };
  app.get("/health/live", live);
  app.get("/live", live);
  app.get("/health/ready", ready);
  app.get("/ready", ready);
  // 公开客户端配置：只返回 CaptchaAppId、地图公开 Key 和功能开关。
  // 任何包含 SECRET/TOKEN/PASSWORD/DATABASE/COS_ROLE_ARN 的字段绝不出现。
  // AUTH_SELF_SERVICE=disabled 时自助注册/找回休眠：captchaAppId 允许为 null；
  // 其余字段（如 tencentMapKey）在生产仍必须完整，否则 503。
  app.get("/api/public/client-config", async (request, reply) => {
    const payload = publicClientConfig(config);
    const exempt = config.AUTH_SELF_SERVICE === "disabled" ? new Set(["captchaAppId"]) : new Set();
    const missing = Object.entries(payload).filter(([key, value]) => (value === null || value === undefined) && !exempt.has(key)).map(([key]) => key);
    if (config.NODE_ENV === "production" && missing.length > 0) {
      return reply.code(503).send(errorBody("PUBLIC_CONFIG_INCOMPLETE", "客户端公开配置尚未完整配置", request.id, { retryable: true }));
    }
    reply.header("cache-control", "public, max-age=300");
    return payload;
  });
  app.get("/metrics", async (request, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return renderMetrics({ pool, metrics, startedAt });
  });
  registerAuthRoutes(app, { pool, config, passwordService: createPasswordService({ maxConcurrency: config.AUTH_HASH_MAX_CONCURRENCY, maxQueue: config.AUTH_HASH_MAX_QUEUE }), providers: providers || missingProviders() });
  registerCampaignCleanupRoutes(app, { pool, config });
  registerBatch2Routes(app, { pool, config });
  registerBatch3Routes(app, { pool, cos: app.jundeCos });
  registerBatch4Routes(app, { pool, cos: app.jundeCos, config });
  registerBatch5Routes(app, { pool, cos: app.jundeCos });
  registerStatsRoutes(app, { pool });
  // 本地磁盘形态专属签名路由（multipart 上限只作用于该路由；COS 形态不注册、不存在这些端点）。
  if (config.STORAGE_PROVIDER === "local") registerLocalStorageRoutes(app, { config, storage: app.jundeCos });
  // Render 单实例部署目标：API 同域托管 H5（/）与 Admin（/admin/）静态产物；其余部署形态不注册。
  if (config.DEPLOYMENT_TARGET === "render") registerRenderStaticRoutes(app, staticDirs);
  return app;
}

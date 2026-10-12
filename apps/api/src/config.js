// 统一配置契约：根目录 .env 是唯一人工配置来源（见 .env.example）。
// 生产环境缺少任何强制类别时启动失败关闭；错误只输出变量名，不输出值。
import path from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // 部署目标：留空 = 既有行为（生产禁止本地存储）；render = 单实例 Render Node 服务
  // （唯一允许 生产+本地磁盘存储 的显式 opt-in，静态托管/统一 supervisor 也随之启用）。
  DEPLOYMENT_TARGET: z.preprocess((value) => (typeof value === "string" && !value.trim() ? undefined : value), z.enum(["render"]).optional()),
  // Render 平台注入的服务公网 URL（https）；仅服务端用于派生四个公开 Origin 的默认值，
  // 显式配置的 Origin 优先。绝不进入前端源码/产物（零域名规则不变）。
  RENDER_EXTERNAL_URL: z.preprocess((value) => (typeof value === "string" && !value.trim() ? undefined : value), z.string().url().optional()),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // 逗号分隔的可信反向代理 CIDR；只有来自这些地址的 X-Forwarded-For 才被信任。
  TRUST_PROXY: z.string().trim().optional(),

  // 公网来源（production 必须为 HTTPS 且非 localhost）
  PUBLIC_API_ORIGIN: z.string().trim().optional(),
  MINIAPP_API_BASE_URL: z.string().trim().optional(),
  ADMIN_ORIGIN: z.string().url().optional(),
  // 探员端 H5 站点来源（既有运维变量；render 目标下与 API 同源，一并进入运行时校验）。
  WEB_ORIGIN: z.string().trim().optional(),
  TENCENT_MAP_KEY: z.string().trim().optional(),

  DATABASE_URL: z.string().trim().optional(),
  // 文件存储形态：cos（默认，私有腾讯云 COS）| local（本地磁盘，仅 development/test；
  // 生产启动失败关闭，切换方法见 .env.local.example 与 README「本地存储 / 云上切换」）。
  STORAGE_PROVIDER: z.enum(["local", "cos"]).default("cos"),
  // 本地存储根目录（API 与 worker 必须同一目录；相对路径以仓库根——npm 脚本运行目录——解析）。
  LOCAL_STORAGE_DIR: z.string().trim().optional(),
  // 本地签名授权有效期：上传直传与预览/下载各自独立（秒），有上下界防呆。
  LOCAL_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  LOCAL_PREVIEW_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  // 宿主机脚本（preflight/deploy/backup/migrate）使用的数据库地址：本机自建 PG 时指向
  // 127.0.0.1:5432；未提供时脚本回退 DATABASE_URL。运行时 api/worker 永远只用 DATABASE_URL。
  DATABASE_HOST_URL: z.string().trim().optional(),
  API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(12000),
  API_HANDLER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(10).default(10),
  DATABASE_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(2000),
  MAX_ASSIGNMENTS_PER_CAMPAIGN: z.coerce.number().int().min(1).max(500).default(500),

  AUTH_TOKEN_HMAC_KEY: z.string().min(32).optional(),
  PHONE_ENCRYPTION_KEY_BASE64: z.string().min(43).optional(),
  AUTH_HASH_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  AUTH_HASH_MAX_QUEUE: z.coerce.number().int().min(0).max(100).default(8),
  AUTH_PROVIDER_MODE: z.enum(["tencent", "sandbox"]).default("tencent"),
  AUTH_SELF_SERVICE: z.enum(["enabled", "disabled"]).optional(),

  // 腾讯验证码四类密钥职责分离（禁止复用同一值）：
  //   CAPTCHA_APP_ID           公开的应用 ID（可进入小程序，用于 CaptchaAppId）
  //   CAPTCHA_APP_SECRET_KEY   验证码 AppSecretKey（仅服务端，用于票据校验请求体）
  //   CAPTCHA_API_SECRET_ID/KEY 腾讯云 API 凭据（仅服务端，用于 TC3-HMAC-SHA256 签名）
  CAPTCHA_APP_ID: z.string().trim().optional(),
  CAPTCHA_APP_SECRET_KEY: z.string().trim().optional(),
  CAPTCHA_API_SECRET_ID: z.string().trim().optional(),
  CAPTCHA_API_SECRET_KEY: z.string().trim().optional(),
  CAPTCHA_REGION: z.string().trim().optional(),
  CAPTCHA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),

  SMS_SECRET_ID: z.string().trim().optional(),
  SMS_SECRET_KEY: z.string().trim().optional(),
  SMS_SDK_APP_ID: z.string().trim().optional(),
  SMS_SIGN_NAME: z.string().trim().optional(),
  SMS_TEMPLATE_IDS: z.string().optional(),
  SMS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
  SMS_SANDBOX_WHITELIST_PHONES: z.string().optional(),
  SMS_SANDBOX_FIXED_CODE: z.string().regex(/^\d{6}$/).optional(),

  ATTACHMENT_VERIFY_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  ATTACHMENT_VERIFY_QUEUE_MAX: z.coerce.number().int().min(0).max(100).default(8),

  // 私有 COS：renewing（AssumeRole）为唯一长期运行模式；static STS 仅测试/一次性运维。
  COS_REGION: z.string().trim().optional(),
  COS_EVIDENCE_BUCKET: z.string().trim().optional(),
  COS_EXPORT_BUCKET: z.string().trim().optional(),
  COS_BACKUP_BUCKET: z.string().trim().optional(),
  COS_ROLE_ARN: z.string().trim().optional(),
  COS_ASSUME_ROLE_SECRET_ID: z.string().trim().optional(),
  COS_ASSUME_ROLE_SECRET_KEY: z.string().trim().optional(),
  COS_STS_DURATION_SECONDS: z.coerce.number().int().min(900).max(7200).default(3600),
  COS_STS_REFRESH_BEFORE_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  COS_STS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
  COS_STS_SECRET_ID: z.string().trim().optional(),
  COS_STS_SECRET_KEY: z.string().trim().optional(),
  COS_STS_TOKEN: z.string().trim().optional(),
  COS_STS_EXPIRES_AT: z.string().datetime().optional(),
  COS_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(300).default(300),
  COS_PREVIEW_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),

  // 小票 OCR 功能开关（三态，默认关闭）：
  //   none    纯手动填写，无需任何 OCR 资源（2C2G 单机可部署）
  //   tencent 腾讯云通用印刷体识别 GeneralBasicOCR（按量付费，密钥 OCR_SECRET_ID/KEY）
  //   paddle  自托管 PaddleOCR sidecar（逃生舱，--profile ocr，需 4C8G+）
  OCR_PROVIDER: z.enum(["none", "tencent", "paddle"]).default("none"),
  OCR_SECRET_ID: z.string().trim().optional(),
  OCR_SECRET_KEY: z.string().trim().optional(),
  OCR_REGION: z.string().trim().optional(),
  // 空白值视为未设置（.env 中 `OCR_SERVICE_URL=` 留空是 none/tencent 形态的合法写法）。
  OCR_SERVICE_URL: z.preprocess((value) => (typeof value === "string" && !value.trim() ? undefined : value), z.string().url().optional()),
  OCR_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(90000),
  OCR_MODEL_VERSION: z.string().trim().min(1).max(100).optional(),
  OCR_PARSER_VERSION: z.string().trim().min(1).max(100).default("receipt-parser-v1"),
  OCR_JOB_LEASE_SECONDS: z.coerce.number().int().min(60).max(600).default(300),
  OCR_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).max(300000).default(30000),
  OCR_WORKER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  OCR_WORKER_CLAIM_LIMIT: z.coerce.number().int().min(1).max(64).default(4),
  OCR_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  OCR_MAX_QUEUED_JOBS: z.coerce.number().int().min(10).max(10000).default(500),

  RETENTION_POLICY_VERSION: z.string().trim().min(1).max(100).default("phase1-v1"),
  OBJECT_RECONCILIATION_SAMPLE_SIZE: z.coerce.number().int().min(1).max(10000).default(100),
  BACKUP_PREFIX: z.string().trim().min(1).max(64).default("postgres"),
});

const PLACEHOLDER_PATTERN = /YOUR_|change-me|example\.com|example\.cn/i;
const isLocalhost = (value) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(value);
const httpsOrigin = (value) => /^https:\/\//i.test(value);

// 供一致性测试使用：Schema 声明的全部运行时字段。
export const runtimeConfigSchema = ConfigSchema;

const requiredProduction = (config, name, value, message = null) => {
  if (!value) throw new Error(`生产环境必须配置 ${name}`);
  if (PLACEHOLDER_PATTERN.test(String(value))) throw new Error(`生产环境 ${name} 不允许使用占位值`);
  if (message) message(config, name, value);
};

export function loadConfig(environment = process.env) {
  const config = ConfigSchema.parse(environment);

  // 模型版本默认值按 provider 区分：记录 provider+模型保证历史 job 可复现
  // （paddle=PP-OCRv6_small；tencent=GeneralBasicOCR 固定模型族）。
  if (!config.OCR_MODEL_VERSION) {
    config.OCR_MODEL_VERSION = config.OCR_PROVIDER === "tencent" ? "tencent-general-basic" : "PP-OCRv6_small";
  }

  if (config.SMS_TEMPLATE_IDS) {
    try {
      const parsed = JSON.parse(config.SMS_TEMPLATE_IDS);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be a JSON object");
      for (const [purpose, templateId] of Object.entries(parsed)) {
        if (!["registration", "passwordReset"].includes(purpose) || typeof templateId !== "string" || !templateId) throw new Error(`invalid template id for ${purpose}`);
      }
      config.SMS_TEMPLATE_IDS = parsed;
    } catch (error) {
      throw new Error(`SMS_TEMPLATE_IDS 必须是 JSON 对象 {"registration":"模板ID","passwordReset":"模板ID"}：${error.message}`);
    }
  }

  // render 部署目标：以平台注入的 RENDER_EXTERNAL_URL（https）作为四个公开 Origin 的服务端默认值；
  // 显式配置优先。仅服务端消费，零域名规则不变（不进入前端源码/产物）。
  if (config.DEPLOYMENT_TARGET === "render" && config.RENDER_EXTERNAL_URL) {
    let origin = String(config.RENDER_EXTERNAL_URL).trim().replace(/\/+$/, "");
    if (!/^https:\/\//i.test(origin)) throw new Error("RENDER_EXTERNAL_URL 必须是 https 公网来源");
    for (const key of ["PUBLIC_API_ORIGIN", "MINIAPP_API_BASE_URL", "ADMIN_ORIGIN", "WEB_ORIGIN"]) {
      if (!config[key]) config[key] = origin;
    }
  }

  if (config.NODE_ENV === "production") {
    // 存储形态：生产默认禁止本地磁盘存储（持久卷/签名/备份/归档能力都以 COS 为准）。
    // 唯一例外：显式 DEPLOYMENT_TARGET=render 的单实例部署（持久磁盘挂载 /var/data），
    // 且必须满足下方 render 专属门（HTTPS 公网来源、真实 DB/密钥/地图 Key、绝对本地存储路径）。
    if (config.STORAGE_PROVIDER === "local" && config.DEPLOYMENT_TARGET !== "render") {
      throw new Error("生产环境禁止 STORAGE_PROVIDER=local 本地磁盘存储；请使用 STORAGE_PROVIDER=cos 并配置 COS_* 参数（单实例 Render 部署需显式 DEPLOYMENT_TARGET=render）");
    }
    if (config.STORAGE_PROVIDER === "local") {
      // render+local 专属门：本地存储必须是 /var/data 下的绝对路径（持久磁盘挂载点）。
      // 先做词汇规范化（解析 .. 与多余分隔符）再判定包含关系，`/var/data/../../tmp`
      // 这类逃逸写法一律拒绝；启动期 assertReady 还会校验挂载父目录存在/可写并做
      // realpath 包含复核（见 storage/local.js），与这里的判定同源。
      const localDir = String(config.LOCAL_STORAGE_DIR || "").trim();
      // POSIX 保留恰好两个前导斜杠（//var/...），先归一为单斜杠再 resolve，防止双斜杠形态绕过前缀判定。
      const resolvedDir = localDir ? path.resolve(localDir.replace(/^\/{2,}/, "/")) : "";
      if (!localDir || !resolvedDir.startsWith("/var/data/")) {
        throw new Error("生产环境 DEPLOYMENT_TARGET=render 且 STORAGE_PROVIDER=local 时 LOCAL_STORAGE_DIR 必须是 /var/data/ 下的绝对路径（Render 持久磁盘挂载点）");
      }
      config.LOCAL_STORAGE_DIR = resolvedDir;
      // render 目标：H5 与 Admin 同源托管于 API，WEB_ORIGIN 一并要求 HTTPS 公网来源。
      requiredProduction(config, "WEB_ORIGIN", config.WEB_ORIGIN, (c, key, value) => {
        if (!httpsOrigin(value) || isLocalhost(value)) throw new Error(`生产环境 ${key} 必须是 HTTPS 公网来源且不能是 localhost`);
      });
      // render 目标必须能确定公网来源：RENDER_EXTERNAL_URL 或四个 Origin 显式齐全（下方既有循环兜底）。
      if (!config.RENDER_EXTERNAL_URL) {
        const missingOrigins = ["PUBLIC_API_ORIGIN", "MINIAPP_API_BASE_URL", "ADMIN_ORIGIN", "WEB_ORIGIN"].filter((name) => !config[name]);
        if (missingOrigins.length > 0) throw new Error(`生产环境 DEPLOYMENT_TARGET=render 需要配置 RENDER_EXTERNAL_URL 或以下变量：${missingOrigins.join("、")}`);
      }
    }
    // 通用
    requiredProduction(config, "HOST", config.HOST);
    requiredProduction(config, "PORT", config.PORT);
    requiredProduction(config, "LOG_LEVEL", config.LOG_LEVEL);
    // 公网来源：必须 HTTPS、非 localhost、非占位值
    for (const name of ["PUBLIC_API_ORIGIN", "MINIAPP_API_BASE_URL", "ADMIN_ORIGIN"]) {
      requiredProduction(config, name, config[name], (c, key, value) => {
        if (!httpsOrigin(value) || isLocalhost(value)) throw new Error(`生产环境 ${key} 必须是 HTTPS 公网来源且不能是 localhost`);
      });
    }
    requiredProduction(config, "TENCENT_MAP_KEY", config.TENCENT_MAP_KEY);
    // 数据库
    requiredProduction(config, "DATABASE_URL", config.DATABASE_URL);
    // 认证密钥
    requiredProduction(config, "AUTH_TOKEN_HMAC_KEY", config.AUTH_TOKEN_HMAC_KEY);
    requiredProduction(config, "PHONE_ENCRYPTION_KEY_BASE64", config.PHONE_ENCRYPTION_KEY_BASE64);
    // 自助注册/找回开关：生产必须显式声明（enabled=以下密钥必填；disabled=必须全空）
    requiredProduction(config, "AUTH_SELF_SERVICE", config.AUTH_SELF_SERVICE);
    if (config.AUTH_SELF_SERVICE === "enabled") {
      // 验证码四键
      for (const name of ["CAPTCHA_APP_ID", "CAPTCHA_APP_SECRET_KEY", "CAPTCHA_API_SECRET_ID", "CAPTCHA_API_SECRET_KEY"]) requiredProduction(config, name, config[name]);
      if (config.CAPTCHA_APP_SECRET_KEY === config.CAPTCHA_API_SECRET_KEY) throw new Error("生产环境 CAPTCHA_APP_SECRET_KEY 与 CAPTCHA_API_SECRET_KEY 禁止复用同一值");
      // 短信（两个模板都必须存在）
      for (const name of ["SMS_SECRET_ID", "SMS_SECRET_KEY", "SMS_SDK_APP_ID", "SMS_SIGN_NAME"]) requiredProduction(config, name, config[name]);
      if (!config.SMS_TEMPLATE_IDS?.registration || !config.SMS_TEMPLATE_IDS?.passwordReset) throw new Error("生产环境必须配置 SMS_TEMPLATE_IDS 的 registration 与 passwordReset 两个模板");
    } else {
      // disabled：相关键必须全部留空；错误只列变量名，绝不输出值。
      const nonEmpty = ["CAPTCHA_APP_ID", "CAPTCHA_APP_SECRET_KEY", "CAPTCHA_API_SECRET_ID", "CAPTCHA_API_SECRET_KEY", "SMS_SECRET_ID", "SMS_SECRET_KEY", "SMS_SDK_APP_ID", "SMS_SIGN_NAME", "SMS_TEMPLATE_IDS"].filter((name) => config[name]);
      if (nonEmpty.length > 0) throw new Error(`生产环境 AUTH_SELF_SERVICE=disabled 时以下变量必须留空：${nonEmpty.join("、")}`);
    }
    // COS：cos 形态要求三个不同私有桶 + renewing 凭证并禁止 static STS；local（render）形态
    // 相关键必须全部留空——挂着无效的 COS 配置会误导排障，按「disabled 必须留空」同款失败关闭。
    if (config.STORAGE_PROVIDER === "local") {
      const nonEmptyCos = ["COS_REGION", "COS_EVIDENCE_BUCKET", "COS_EXPORT_BUCKET", "COS_BACKUP_BUCKET", "COS_ROLE_ARN", "COS_ASSUME_ROLE_SECRET_ID", "COS_ASSUME_ROLE_SECRET_KEY", "COS_STS_SECRET_ID", "COS_STS_SECRET_KEY", "COS_STS_TOKEN", "COS_STS_EXPIRES_AT"].filter((name) => config[name]);
      if (nonEmptyCos.length > 0) throw new Error(`生产环境 STORAGE_PROVIDER=local 时以下 COS 变量必须留空：${nonEmptyCos.join("、")}`);
    } else {
      for (const name of ["COS_REGION", "COS_EVIDENCE_BUCKET", "COS_EXPORT_BUCKET", "COS_BACKUP_BUCKET", "COS_ROLE_ARN", "COS_ASSUME_ROLE_SECRET_ID", "COS_ASSUME_ROLE_SECRET_KEY"]) requiredProduction(config, name, config[name]);
      const buckets = [config.COS_EVIDENCE_BUCKET, config.COS_EXPORT_BUCKET, config.COS_BACKUP_BUCKET];
      if (new Set(buckets).size !== 3) throw new Error("生产环境 COS 三桶（证据/导出/备份）必须互不相同");
      if (config.COS_STS_SECRET_ID || config.COS_STS_SECRET_KEY || config.COS_STS_TOKEN) throw new Error("生产环境禁止使用一次性静态 COS STS（COS_STS_*）；必须使用 COS_ROLE_ARN 可续期凭证");
    }
    // OCR 功能开关：生产必须显式声明（同 AUTH_SELF_SERVICE 模式，必须有意选择；
    // Schema 默认值 none 只服务开发/测试，不能替生产做决定）。
    requiredProduction(config, "OCR_PROVIDER", environment.OCR_PROVIDER);
    if (config.OCR_PROVIDER === "none") {
      // none：纯手动填写形态，OCR 服务地址与腾讯 OCR 密钥必须全部留空（功能彻底关闭）。
      const nonEmpty = ["OCR_SERVICE_URL", "OCR_SECRET_ID", "OCR_SECRET_KEY"].filter((name) => config[name]);
      if (nonEmpty.length > 0) throw new Error(`生产环境 OCR_PROVIDER=none 时以下变量必须留空：${nonEmpty.join("、")}`);
    } else if (config.OCR_PROVIDER === "tencent") {
      // tencent：腾讯云 OCR 密钥对必填且非占位值；OCR_SERVICE_URL 必须留空（不混用 sidecar）。
      for (const name of ["OCR_SECRET_ID", "OCR_SECRET_KEY"]) requiredProduction(config, name, config[name]);
      if (config.OCR_SERVICE_URL) throw new Error("生产环境 OCR_PROVIDER=tencent 时 OCR_SERVICE_URL 必须留空");
    } else {
      // paddle：保留原有全部校验（必填、占位值、私网地址）；腾讯密钥必须留空。
      requiredProduction(config, "OCR_SERVICE_URL", config.OCR_SERVICE_URL, (c, key, value) => {
        if (isLocalhost(value)) throw new Error(`生产环境 ${key} 必须是私网 OCR 地址，不能是 localhost 公网配置`);
      });
      const nonEmpty = ["OCR_SECRET_ID", "OCR_SECRET_KEY"].filter((name) => config[name]);
      if (nonEmpty.length > 0) throw new Error(`生产环境 OCR_PROVIDER=paddle 时以下变量必须留空：${nonEmpty.join("、")}`);
    }
    // 供应商模式
    if (config.AUTH_PROVIDER_MODE !== "tencent") throw new Error("生产环境 AUTH_PROVIDER_MODE 必须是 tencent");
  }
  return Object.freeze(config);
}

// 公开客户端配置（不含任何 Secret）：供 GET /api/public/client-config 使用。
// receiptOcr 由 OCR_PROVIDER 开关决定，经 client-config 动态下发；小程序入口显隐
// 随之变化，开启 OCR 无需小程序重新发版。
// authSelfService 由 AUTH_SELF_SERVICE 开关决定（enabled=true；disabled/未设置=false），
// 控制小程序端自助注册/找回密码入口显隐，同样免发版。
export function publicClientConfig(config) {
  return {
    captchaAppId: config.CAPTCHA_APP_ID || null,
    tencentMapKey: config.TENCENT_MAP_KEY || null,
    features: {
      receiptOcr: (config.OCR_PROVIDER || "none") !== "none",
      authSelfService: config.AUTH_SELF_SERVICE === "enabled",
    },
  };
}

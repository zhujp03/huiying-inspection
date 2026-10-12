// 配置单一来源一致性测试：
//   1. .env.example 中的运行时字段必须存在于 Config Schema；
//   2. 代码里读取的 config.X 必须存在于 Config Schema；
//   3. Schema 的生产强制字段必须在 .env.example 有说明；
//   4. production 失败关闭负例（缺任意强制类别必须抛错，且不输出值）；
//   5. OCR_PROVIDER 三态（none/tencent/paddle）分支校验与 features.receiptOcr 出口。
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig, publicClientConfig, runtimeConfigSchema } from "../../apps/api/src/config.js";

const root = resolve(import.meta.dirname, "../..");
const schemaKeys = new Set(Object.keys(runtimeConfigSchema.shape));
// 运维专用变量白名单（不进入运行时 Schema，但必须在 .env.example 有文档）。
const opsOnlyWhitelist = new Set(["ENV_FILE", "BACKUP_EXECUTION_CONFIRM", "CADDY_EMAIL", "WEB_ORIGIN", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]); // 探员端 H5 站点（Caddy 消费，同 CADDY_EMAIL；2026-10-10 PM 裁决）

function parseDotEnv(text) {
  const names = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) names.push(match[1]);
  }
  return names;
}

const exampleText = readFileSync(join(root, ".env.example"), "utf8");
const exampleKeys = new Set(parseDotEnv(exampleText));

function scanConfigReferences(dir) {
  const found = new Set();
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(entry.name)) {
        const source = readFileSync(full, "utf8");
        for (const match of source.matchAll(/config\.([A-Z][A-Z0-9_]+)/g)) found.add(match[1]);
      }
    }
  };
  walk(dir);
  return found;
}

describe("config single source of truth", () => {
  it("every runtime field in .env.example exists in the Config Schema", () => {
    const unknown = [...exampleKeys].filter((key) => !schemaKeys.has(key) && !opsOnlyWhitelist.has(key));
    expect(unknown).toEqual([]);
  });

  it("every config.X reference in API/Worker/ops code exists in the Config Schema", () => {
    const referenced = scanConfigReferences(join(root, "apps/api/src"));
    for (const dir of ["apps/worker/src", "ops"]) scanConfigReferences(join(root, dir)).forEach((key) => referenced.add(key));
    // 运行时访问的字段必须在 Schema 中声明；schema 里已声明但未引用的字段允许存在。
    const missing = [...referenced].filter((key) => !schemaKeys.has(key));
    expect(missing).toEqual([]);
  });

  it("production mandatory fields are documented in .env.example", () => {
    const mandatory = [
      "NODE_ENV", "HOST", "PORT", "LOG_LEVEL", "PUBLIC_API_ORIGIN", "MINIAPP_API_BASE_URL", "ADMIN_ORIGIN", "TENCENT_MAP_KEY",
      "DATABASE_URL", "DATABASE_HOST_URL", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB",
      "AUTH_TOKEN_HMAC_KEY", "PHONE_ENCRYPTION_KEY_BASE64", "AUTH_SELF_SERVICE",
      "CAPTCHA_APP_ID", "CAPTCHA_APP_SECRET_KEY", "CAPTCHA_API_SECRET_ID", "CAPTCHA_API_SECRET_KEY",
      "SMS_SECRET_ID", "SMS_SECRET_KEY", "SMS_SDK_APP_ID", "SMS_SIGN_NAME", "SMS_TEMPLATE_IDS",
      "COS_REGION", "COS_EVIDENCE_BUCKET", "COS_EXPORT_BUCKET", "COS_BACKUP_BUCKET", "COS_ROLE_ARN", "COS_ASSUME_ROLE_SECRET_ID", "COS_ASSUME_ROLE_SECRET_KEY",
      "OCR_PROVIDER", "OCR_SERVICE_URL", "OCR_SECRET_ID", "OCR_SECRET_KEY", "OCR_REGION", "RETENTION_POLICY_VERSION", "BACKUP_PREFIX",
    ];
    const undocumented = mandatory.filter((key) => !exampleKeys.has(key));
    expect(undocumented).toEqual([]);
  });

  it("fails closed in production when any mandatory category is missing, without printing values", () => {
    const base = {
      NODE_ENV: "production", HOST: "0.0.0.0", PORT: "8787", LOG_LEVEL: "info",
      PUBLIC_API_ORIGIN: "https://api.junde-audit.cn", MINIAPP_API_BASE_URL: "https://api.junde-audit.cn", ADMIN_ORIGIN: "https://admin.junde-audit.cn",
      TENCENT_MAP_KEY: "map-key", DATABASE_URL: "postgresql://u:p@db/junde", AUTH_TOKEN_HMAC_KEY: "k".repeat(32), PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
      CAPTCHA_APP_ID: "2026", CAPTCHA_APP_SECRET_KEY: "app-secret", CAPTCHA_API_SECRET_ID: "api-id", CAPTCHA_API_SECRET_KEY: "api-key",
      SMS_SECRET_ID: "s", SMS_SECRET_KEY: "s", SMS_SDK_APP_ID: "1", SMS_SIGN_NAME: "签", SMS_TEMPLATE_IDS: JSON.stringify({ registration: "1", passwordReset: "2" }),
      COS_REGION: "ap-shanghai", COS_EVIDENCE_BUCKET: "ev", COS_EXPORT_BUCKET: "ex", COS_BACKUP_BUCKET: "bk",
      COS_ROLE_ARN: "arn", COS_ASSUME_ROLE_SECRET_ID: "a", COS_ASSUME_ROLE_SECRET_KEY: "b",
      OCR_PROVIDER: "paddle", OCR_SERVICE_URL: "http://ocr:8080", AUTH_PROVIDER_MODE: "tencent", AUTH_SELF_SERVICE: "enabled",
    };
    expect(() => loadConfig({ ...base, DATABASE_URL: "" })).toThrow(/生产环境必须配置 DATABASE_URL/);
    expect(() => loadConfig({ ...base, CAPTCHA_APP_ID: "" })).toThrow(/生产环境必须配置 CAPTCHA_APP_ID/);
    expect(() => loadConfig({ ...base, SMS_TEMPLATE_IDS: JSON.stringify({ registration: "1" }) })).toThrow(/registration 与 passwordReset 两个模板/);
    expect(() => loadConfig({ ...base, COS_EXPORT_BUCKET: base.COS_EVIDENCE_BUCKET })).toThrow(/三桶.*互不相同/);
    expect(() => loadConfig({ ...base, COS_STS_SECRET_ID: "static", COS_STS_SECRET_KEY: "x", COS_STS_TOKEN: "t", COS_STS_EXPIRES_AT: "2026-01-01T00:00:00Z" })).toThrow(/禁止使用一次性静态 COS STS/);
    expect(() => loadConfig({ ...base, PUBLIC_API_ORIGIN: "http://localhost:8787" })).toThrow(/HTTPS 公网来源/);
    expect(() => loadConfig({ ...base })).not.toThrow();
    expect(() => loadConfig({ ...base, PUBLIC_API_ORIGIN: "https://api.example.cn" })).toThrow(/不允许使用占位值/);
    expect(() => loadConfig({ ...base, AUTH_PROVIDER_MODE: "sandbox" })).toThrow(/AUTH_PROVIDER_MODE 必须是 tencent/);
    expect(() => loadConfig({ ...base, OCR_SERVICE_URL: "http://localhost:8080" })).toThrow(/不能是 localhost/);
    // AUTH_SELF_SERVICE：生产必须显式声明；disabled 时相关键必须全部留空。
    expect(() => loadConfig({ ...base, AUTH_SELF_SERVICE: undefined })).toThrow(/AUTH_SELF_SERVICE/);
    const disabled = { ...base, AUTH_SELF_SERVICE: "disabled", CAPTCHA_APP_ID: "", CAPTCHA_APP_SECRET_KEY: "", CAPTCHA_API_SECRET_ID: "", CAPTCHA_API_SECRET_KEY: "", SMS_SECRET_ID: "", SMS_SECRET_KEY: "", SMS_SDK_APP_ID: "", SMS_SIGN_NAME: "", SMS_TEMPLATE_IDS: "" };
    expect(() => loadConfig(disabled)).not.toThrow();
    expect(() => loadConfig({ ...disabled, SMS_SECRET_ID: "x" })).toThrow(/必须留空/);
    expect(() => loadConfig({ ...disabled, CAPTCHA_APP_ID: "2026" })).toThrow(/必须留空/);
    // 错误信息只含变量名，不得包含任何值。
    try { loadConfig({ ...base, DATABASE_URL: "" }); } catch (error) { expect(error.message).not.toContain("postgresql"); }
  });

  describe("OCR_PROVIDER three-state switch", () => {
    const base = {
      NODE_ENV: "production", HOST: "0.0.0.0", PORT: "8787", LOG_LEVEL: "info",
      PUBLIC_API_ORIGIN: "https://api.junde-audit.cn", MINIAPP_API_BASE_URL: "https://api.junde-audit.cn", ADMIN_ORIGIN: "https://admin.junde-audit.cn",
      TENCENT_MAP_KEY: "map-key", DATABASE_URL: "postgresql://u:p@db/junde", AUTH_TOKEN_HMAC_KEY: "k".repeat(32), PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
      COS_REGION: "ap-shanghai", COS_EVIDENCE_BUCKET: "ev", COS_EXPORT_BUCKET: "ex", COS_BACKUP_BUCKET: "bk",
      COS_ROLE_ARN: "arn", COS_ASSUME_ROLE_SECRET_ID: "a", COS_ASSUME_ROLE_SECRET_KEY: "b",
      AUTH_PROVIDER_MODE: "tencent", AUTH_SELF_SERVICE: "disabled",
    };
    const empty = { OCR_SERVICE_URL: "", OCR_SECRET_ID: "", OCR_SECRET_KEY: "" };

    it("requires an explicit declaration in production (same as AUTH_SELF_SERVICE)", () => {
      expect(() => loadConfig({ ...base, ...empty })).toThrow(/生产环境必须配置 OCR_PROVIDER/);
    });

    it("none: pure manual mode; OCR service URL and Tencent keys must all be empty", () => {
      const none = { ...base, ...empty, OCR_PROVIDER: "none" };
      expect(() => loadConfig(none)).not.toThrow();
      expect(() => loadConfig({ ...none, OCR_SERVICE_URL: "http://ocr:8080" })).toThrow(/OCR_PROVIDER=none 时以下变量必须留空/);
      expect(() => loadConfig({ ...none, OCR_SECRET_ID: "id", OCR_SECRET_KEY: "key" })).toThrow(/OCR_PROVIDER=none 时以下变量必须留空/);
      expect(publicClientConfig(loadConfig(none)).features.receiptOcr).toBe(false);
    });

    it("tencent: key pair required and non-placeholder; OCR_SERVICE_URL must be empty", () => {
      expect(() => loadConfig({ ...base, ...empty, OCR_PROVIDER: "tencent" })).toThrow(/必须配置 OCR_SECRET_ID/);
      expect(() => loadConfig({ ...base, ...empty, OCR_PROVIDER: "tencent", OCR_SECRET_ID: "YOUR_ID", OCR_SECRET_KEY: "k" })).toThrow(/不允许使用占位值/);
      expect(() => loadConfig({ ...base, ...empty, OCR_PROVIDER: "tencent", OCR_SECRET_ID: "id", OCR_SECRET_KEY: "key" })).not.toThrow();
      expect(() => loadConfig({ ...base, ...empty, OCR_PROVIDER: "tencent", OCR_SECRET_ID: "id", OCR_SECRET_KEY: "key", OCR_SERVICE_URL: "http://ocr:8080" })).toThrow(/OCR_PROVIDER=tencent 时 OCR_SERVICE_URL 必须留空/);
      const config = loadConfig({ ...base, ...empty, OCR_PROVIDER: "tencent", OCR_SECRET_ID: "id", OCR_SECRET_KEY: "key" });
      expect(config.OCR_MODEL_VERSION).toBe("tencent-general-basic");
      expect(publicClientConfig(config).features.receiptOcr).toBe(true);
    });

    it("paddle: keeps every legacy validation; Tencent keys must be empty", () => {
      expect(() => loadConfig({ ...base, ...empty, OCR_PROVIDER: "paddle" })).toThrow(/生产环境必须配置 OCR_SERVICE_URL/);
      expect(() => loadConfig({ ...base, ...empty, OCR_PROVIDER: "paddle", OCR_SERVICE_URL: "http://localhost:8080" })).toThrow(/不能是 localhost/);
      expect(() => loadConfig({ ...base, ...empty, OCR_PROVIDER: "paddle", OCR_SERVICE_URL: "https://api.example.cn" })).toThrow(/不允许使用占位值/);
      expect(() => loadConfig({ ...base, ...empty, OCR_PROVIDER: "paddle", OCR_SERVICE_URL: "http://ocr:8080", OCR_SECRET_ID: "id" })).toThrow(/OCR_PROVIDER=paddle 时以下变量必须留空/);
      const config = loadConfig({ ...base, ...empty, OCR_PROVIDER: "paddle", OCR_SERVICE_URL: "http://ocr:8080" });
      expect(config.OCR_MODEL_VERSION).toBe("PP-OCRv6_small");
      expect(publicClientConfig(config).features.receiptOcr).toBe(true);
    });
  });

  // publicClientConfig 只消费 4 个字段，用最小 plain-object 构造即可（无需过 loadConfig）。
  describe("publicClientConfig features.authSelfService passthrough", () => {
    const base = { CAPTCHA_APP_ID: "2026", TENCENT_MAP_KEY: "map-key", OCR_PROVIDER: "none" };

    it("enabled: authSelfService is true", () => {
      expect(publicClientConfig({ ...base, AUTH_SELF_SERVICE: "enabled" }).features.authSelfService).toBe(true);
    });

    it("disabled: authSelfService is false", () => {
      expect(publicClientConfig({ ...base, AUTH_SELF_SERVICE: "disabled" }).features.authSelfService).toBe(false);
    });

    it("unset: authSelfService defaults to false", () => {
      expect(publicClientConfig({ ...base }).features.authSelfService).toBe(false);
    });

    it("receiptOcr two-state passthrough is unaffected by authSelfService", () => {
      const features = (provider, selfService) => publicClientConfig({ ...base, OCR_PROVIDER: provider, AUTH_SELF_SERVICE: selfService }).features;
      expect(features("tencent", "enabled").receiptOcr).toBe(true);
      expect(features("none", "enabled").receiptOcr).toBe(false);
      expect(features("tencent", "disabled").receiptOcr).toBe(true);
      expect(features("none", undefined).receiptOcr).toBe(false);
    });
  });
});

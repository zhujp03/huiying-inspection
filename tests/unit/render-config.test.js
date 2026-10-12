// Render 部署目标（DEPLOYMENT_TARGET=render）配置门测试：
// 生产 + 本地磁盘存储仅在显式 render 目标下放行（缺省仍拒绝）；/var/data 绝对路径、
// HTTPS 公网来源（RENDER_EXTERNAL_URL 派生或显式齐全）、真实 DB/密钥/地图 Key 全部失败关闭；
// cos 生产行为与 OCR none / 自助休眠形态不变。
import { describe, expect, it } from "vitest";
import { loadConfig, publicClientConfig } from "../../apps/api/src/config.js";
import { createStorageProvider } from "../../apps/api/src/storage/index.js";

const renderBase = {
  NODE_ENV: "production", DEPLOYMENT_TARGET: "render", STORAGE_PROVIDER: "local",
  LOCAL_STORAGE_DIR: "/var/data/storage", HOST: "0.0.0.0", PORT: "10000",
  RENDER_EXTERNAL_URL: "https://junde-app.onrender.com",
  TENCENT_MAP_KEY: "render-smoke-map-key-0123456789", DATABASE_URL: "postgresql://u:p@db.internal:5432/junde",
  AUTH_TOKEN_HMAC_KEY: "k".repeat(32), PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"),
  OCR_PROVIDER: "none", AUTH_SELF_SERVICE: "disabled", AUTH_PROVIDER_MODE: "tencent",
};

describe("render deployment target config gates", () => {
  it("production + local without an explicit target stays rejected (default behavior preserved)", () => {
    expect(() => loadConfig({ NODE_ENV: "production", STORAGE_PROVIDER: "local", HOST: "0.0.0.0" })).toThrow(/STORAGE_PROVIDER=local/);
    // 空字符串目标视同未声明。
    expect(() => loadConfig({ NODE_ENV: "production", STORAGE_PROVIDER: "local", HOST: "0.0.0.0", DEPLOYMENT_TARGET: "" })).toThrow(/STORAGE_PROVIDER=local/);
  });

  it("accepts render + local with RENDER_EXTERNAL_URL and derives the four https origins", () => {
    const config = loadConfig(renderBase);
    const origins = new Set([config.PUBLIC_API_ORIGIN, config.MINIAPP_API_BASE_URL, config.ADMIN_ORIGIN, config.WEB_ORIGIN]);
    expect(origins.size).toBe(1);
    expect(config.PUBLIC_API_ORIGIN).toBe("https://junde-app.onrender.com");
    expect(publicClientConfig(config).features).toEqual({ receiptOcr: false, authSelfService: false });
  });

  it("accepts explicit origins without RENDER_EXTERNAL_URL and rejects missing ones", () => {
    const explicit = { ...renderBase, PUBLIC_API_ORIGIN: "https://junde-app.onrender.com", MINIAPP_API_BASE_URL: "https://junde-app.onrender.com", ADMIN_ORIGIN: "https://junde-app.onrender.com", WEB_ORIGIN: "https://junde-app.onrender.com" };
    delete explicit.RENDER_EXTERNAL_URL;
    expect(() => loadConfig(explicit)).not.toThrow();
    const missing = { ...explicit, WEB_ORIGIN: "" };
    expect(() => loadConfig(missing)).toThrow(/WEB_ORIGIN/);
  });

  it("rejects non-https or localhost origins in the render target", () => {
    expect(() => loadConfig({ ...renderBase, RENDER_EXTERNAL_URL: "http://junde-app.onrender.com" })).toThrow(/https/);
    const explicit = { ...renderBase, RENDER_EXTERNAL_URL: undefined, PUBLIC_API_ORIGIN: "http://localhost:3000", MINIAPP_API_BASE_URL: "http://localhost:3000", ADMIN_ORIGIN: "http://localhost:3000", WEB_ORIGIN: "http://localhost:3000" };
    expect(() => loadConfig(explicit)).toThrow(/HTTPS 公网来源|localhost/);
  });

  it("requires LOCAL_STORAGE_DIR to be an absolute path under /var/data", () => {
    expect(() => loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: ".local-storage" })).toThrow(/\/var\/data\//);
    expect(() => loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "/tmp/storage" })).toThrow(/\/var\/data\//);
    expect(() => loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "/var/data" })).toThrow(/\/var\/data\//);
    expect(() => loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "/var/data/storage" })).not.toThrow();
    expect(() => loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "" })).toThrow(/\/var\/data\//);
  });

  it("normalizes LOCAL_STORAGE_DIR before containment so ..-escapes cannot pass", () => {
    // 词法规范化后再判包含：/var/data/../../tmp 解析为 /tmp，必须拒绝。
    expect(() => loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "/var/data/../../tmp" })).toThrow(/\/var\/data\//);
    expect(() => loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "/var/data/../var/data/../../etc" })).toThrow(/\/var\/data\//);
    // 形如 /var/data/../x 的写法解析后落在 /var 之下（不在挂载点内），同样拒绝。
    expect(() => loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "/var/data/../var/data/storage" })).toThrow(/\/var\/data\//);
    // 等价写法（多余分隔符/内部 .. 回到 /var/data 之下）放行，并输出规范化路径供构造器/启动同源使用。
    expect(loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "/var/data/storage/" }).LOCAL_STORAGE_DIR).toBe("/var/data/storage");
    expect(loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "//var/data/storage" }).LOCAL_STORAGE_DIR).toBe("/var/data/storage");
    expect(loadConfig({ ...renderBase, LOCAL_STORAGE_DIR: "/var/data/inner/../storage" }).LOCAL_STORAGE_DIR).toBe("/var/data/storage");
  });

  it("rejects leftover COS credentials in the render + local shape (fail-closed hygiene)", () => {
    expect(() => loadConfig({ ...renderBase, COS_REGION: "ap-shanghai" })).toThrow(/COS 变量必须留空/);
    expect(() => loadConfig({ ...renderBase, COS_STS_TOKEN: "t" })).toThrow(/COS 变量必须留空/);
  });

  it("production + cos keeps every existing check regardless of deployment target", () => {
    const cosBase = {
      NODE_ENV: "production", HOST: "0.0.0.0", PORT: "8787", LOG_LEVEL: "info",
      PUBLIC_API_ORIGIN: "https://api.junde-audit.cn", MINIAPP_API_BASE_URL: "https://api.junde-audit.cn", ADMIN_ORIGIN: "https://admin.junde-audit.cn",
      TENCENT_MAP_KEY: "map-key", DATABASE_URL: "postgresql://u:p@db/junde", AUTH_TOKEN_HMAC_KEY: "k".repeat(32),
      PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
      COS_REGION: "ap-shanghai", COS_EVIDENCE_BUCKET: "ev", COS_EXPORT_BUCKET: "ex", COS_BACKUP_BUCKET: "bk",
      COS_ROLE_ARN: "arn", COS_ASSUME_ROLE_SECRET_ID: "a", COS_ASSUME_ROLE_SECRET_KEY: "b",
      OCR_PROVIDER: "none", AUTH_SELF_SERVICE: "disabled", AUTH_PROVIDER_MODE: "tencent",
    };
    expect(() => loadConfig(cosBase)).not.toThrow();
    expect(() => loadConfig({ ...cosBase, COS_EXPORT_BUCKET: "ev" })).toThrow(/三桶.*互不相同/);
    expect(() => loadConfig({ ...cosBase, PUBLIC_API_ORIGIN: "http://localhost:8787" })).toThrow(/HTTPS 公网来源/);
    // cos 形态不允许借 render 目标绕过任何既有门：本地存储禁令只在 provider=local 分支生效。
    expect(() => loadConfig({ ...cosBase, AUTH_PROVIDER_MODE: "sandbox" })).toThrow(/AUTH_PROVIDER_MODE 必须是 tencent/);
  });

  it("local storage provider construction honors the same deployment decision", () => {
    const productionEnv = { NODE_ENV: "production", STORAGE_PROVIDER: "local", LOCAL_STORAGE_DIR: "/var/data/storage", AUTH_TOKEN_HMAC_KEY: "k".repeat(32) };
    expect(() => createStorageProvider(loadConfig(productionEnv))).toThrow(/DEPLOYMENT_TARGET=render/);
    const provider = createStorageProvider(loadConfig(renderBase));
    expect(provider.configured).toBe(true);
    expect(provider.localStorageRoot).toBe("/var/data/storage");
    expect(provider.backupConfigured).toBe(false);
  });
});

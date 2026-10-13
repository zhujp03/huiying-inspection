// Render 单实例形态运行时冒烟（真实构建产物 + 真实 API + 真实 junde_test + 真实本地磁盘文件）：
//   Part1：真实生产配置（NODE_ENV=production + DEPLOYMENT_TARGET=render + /var/data 路径 +
//          RENDER_EXTERNAL_URL 派生 Origin）通过 loadConfig 全部生产门；
//   Part2：test 环境运行时冒烟——静态托管（/ 与 /admin/）、未知 API JSON 404、健康检查走真实库、
//          client-config 形态开关、签名直传→本地磁盘落盘→校验。
// 只允许 junde_test（保险丝）；不写业务表（无 TRUNCATE/种子），不触开发库。
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { loadConfig, publicClientConfig } from "../../apps/api/src/config.js";
import { createStorageProvider } from "../../apps/api/src/storage/index.js";
import { assertSafeKey } from "../../apps/api/src/storage/local.js";
import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

assertIntegrationTestDatabase();

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it : it.skip;
const webDist = path.resolve(process.cwd(), "apps", "web", "dist");
const adminDist = path.resolve(process.cwd(), "apps", "admin", "dist");
const distsBuilt = existsSync(path.join(webDist, "index.html")) && existsSync(path.join(adminDist, "index.html"));

const PNG_BYTES = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(320, 0x55)]);
const multipartBody = (fields, file, boundary) => {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="e.png"\r\nContent-Type: image/png\r\n\r\n`));
  chunks.push(file);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
};

let root = "";

describe.sequential("render deployment smoke", () => {
  it("passes the genuine production gate for the render + local shape", () => {
    const config = loadConfig({
      NODE_ENV: "production", DEPLOYMENT_TARGET: "render", STORAGE_PROVIDER: "local",
      LOCAL_STORAGE_DIR: "/var/data/storage", HOST: "0.0.0.0", PORT: "10000",
      RENDER_EXTERNAL_URL: "https://junde-app.onrender.com",
      TENCENT_MAP_KEY: "render-smoke-map-key-0123456789", DATABASE_URL: "postgresql://u:p@db.internal:5432/junde",
      AUTH_TOKEN_HMAC_KEY: "k".repeat(32), PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"),
      OCR_PROVIDER: "none", AUTH_SELF_SERVICE: "disabled", AUTH_PROVIDER_MODE: "tencent",
    });
    expect(config.PUBLIC_API_ORIGIN).toBe("https://junde-app.onrender.com");
    expect(config.ADMIN_ORIGIN).toBe("https://junde-app.onrender.com");
    expect(config.WEB_ORIGIN).toBe("https://junde-app.onrender.com");
    expect(config.MINIAPP_API_BASE_URL).toBe("https://junde-app.onrender.com");
    expect(config.LOCAL_STORAGE_DIR).toBe("/var/data/storage");
    expect(publicClientConfig(config).features).toEqual({ receiptOcr: false, authSelfService: false });
  });

  test("serves built H5/Admin, keeps API 404s JSON, and completes a signed upload to local disk", async (ctx) => {
    // 前置 REQUIRED 门（独立命令）：npm run build:render && npm run verify:render —— 产物缺失或
    // 基错误时本运行时冒烟显式 skip（不计通过），verify:render 在部署链路里失败关闭。
    if (!distsBuilt) {
      console.warn("render smoke: dists missing — run npm run build:render && npm run verify:render; skipping (reported as skipped, not passed)");
      return ctx.skip();
    }
    const adminIndex = await readFile(path.join(adminDist, "index.html"), "utf8");
    if (!adminIndex.includes("/admin/assets/")) {
      console.warn("render smoke: apps/admin/dist 不是 --base /admin/ 产物（build:admin 会覆盖）——先运行 npm run build:render && npm run verify:render; skipping (reported as skipped, not passed)");
      return ctx.skip();
    }
    root = await mkdtemp(path.join(tmpdir(), "junde-render-smoke-"));
    const config = loadConfig({
      NODE_ENV: "test", DEPLOYMENT_TARGET: "render", STORAGE_PROVIDER: "local", LOCAL_STORAGE_DIR: root,
      HOST: "127.0.0.1", PORT: "10000", OCR_PROVIDER: "none", AUTH_SELF_SERVICE: "disabled",
      AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
      AUTH_TOKEN_HMAC_KEY: "render-smoke-key-render-smoke-key-", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 5).toString("base64"),
      PUBLIC_API_ORIGIN: "http://127.0.0.1:10000", TENCENT_MAP_KEY: "render-smoke-map-key-0123456789",
    });
    const cos = createStorageProvider(config);
    await cos.assertReady();
    const pool = new pg.Pool({ connectionString, max: 3 });
    const app = buildApp({ config, pool, providers: { verifyCaptcha: async () => true, sendSms: async () => ({}) }, storage: cos, logger: false });

    // 健康检查走真实 junde_test。
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("ready");

    // 静态托管：H5 根入口 + Admin 308/入口 + 资产。
    const web = await app.inject({ method: "GET", url: "/" });
    expect(web.statusCode).toBe(200);
    expect(web.headers["content-type"]).toContain("text/html");
    expect(web.body).toContain("<div id=\"root\"");
    const adminRedirect = await app.inject({ method: "GET", url: "/admin" });
    expect(adminRedirect.statusCode).toBe(308);
    expect(adminRedirect.headers.location).toBe("/admin/");
    const admin = await app.inject({ method: "GET", url: "/admin/" });
    expect(admin.statusCode).toBe(200);
    expect(admin.body).toContain("/admin/assets/");
    const adminAsset = admin.body.match(/\/admin\/assets\/index-[^"]+\.js/)?.[0];
    expect(adminAsset, "admin index must reference its hashed asset").toBeTruthy();
    const assetResponse = await app.inject({ method: "GET", url: adminAsset });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["content-type"]).toContain("text/javascript");

    // Admin 客户端路由深链接（真实构建产物）：无扩展名页面路径回退 Admin index.html（未知页面
    // 由前端渲染友好 404），带扩展名的缺失资源严格 404（不用 index 冒充构建缺口）。
    const deepLink = await app.inject({ method: "GET", url: "/admin/campaigns/campaign-one" });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.headers["content-type"]).toContain("text/html");
    expect(deepLink.headers["cache-control"]).toBe("no-cache");
    expect(deepLink.body).toContain("/admin/assets/");
    const unknownAdminPage = await app.inject({ method: "GET", url: "/admin/some/where" });
    expect(unknownAdminPage.statusCode).toBe(200);
    expect(unknownAdminPage.headers["content-type"]).toContain("text/html");
    expect(unknownAdminPage.body).toContain("/admin/assets/");
    const missingAdminAsset = await app.inject({ method: "GET", url: "/admin/assets/missing.js" });
    expect(missingAdminAsset.statusCode).toBe(404);
    expect(missingAdminAsset.body).not.toContain("/admin/assets/");

    // 未知 API 不被静态回退遮蔽。
    const apiNotFound = await app.inject({ method: "GET", url: "/api/not-exist" });
    expect(apiNotFound.statusCode).toBe(404);
    expect(apiNotFound.json().error.code).toBe("ROUTE_NOT_FOUND");

    // client-config：形态开关（OCR 关闭、自助休眠）与公开地图 Key 下发。
    const clientConfig = await app.inject({ method: "GET", url: "/api/public/client-config" });
    expect(clientConfig.statusCode).toBe(200);
    expect(clientConfig.json().features).toEqual({ receiptOcr: false, authSelfService: false });
    expect(clientConfig.json().tencentMapKey).toBe("render-smoke-map-key-0123456789");

    // 签名直传 → 本地磁盘落盘 → 完成校验（与线上形态同一代码路径）。
    const key = `attempts/smoke/question-evidence/11111111-2222-7333-8444-555555555555/${cos.newObjectSuffix()}`;
    const target = cos.createPostTarget({ key, sizeBytes: PNG_BYTES.length, uploadNonce: "smoke-nonce", contentType: "image/png" });
    expect(new URL(target.url).pathname).toBe("/api/local-storage/objects");
    const upload = await app.inject({
      method: "POST", url: new URL(target.url).pathname,
      headers: { "content-type": `multipart/form-data; boundary=----smoke` },
      payload: multipartBody(target.formData, PNG_BYTES, "----smoke"),
    });
    expect(upload.statusCode, upload.body).toBe(204);
    await expect(stat(path.join(root, key))).resolves.toMatchObject({ size: PNG_BYTES.length });
    await expect(cos.verifyObject({ key, uploadNonce: "smoke-nonce", expectedSizeBytes: PNG_BYTES.length, type: "image", declaredContentType: "image/png" })).resolves.toMatchObject({ sizeBytes: PNG_BYTES.length });
    assertSafeKey(root, key, ["attempts/"]); // 签名授权子树约束仍然生效
    const stored = await readFile(path.join(root, key));
    expect(stored.equals(PNG_BYTES)).toBe(true);

    await app.close();
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }, 30_000);
});

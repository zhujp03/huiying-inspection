// H5 浏览器回归专用启动器（playwright webServer）：
// 1) 只允许 junde_test（保险丝在 shared.mjs，绝不指向 junde 开发库）；
// 2) 构建真实 H5 产物（apps/web/dist，vite build）；
// 3) 进程内启动真实 API（buildApp + 本地磁盘存储 + junde_test 连接池），监听 127.0.0.1:3941；
// 4) 127.0.0.1:5199 提供静态产物并把 /api 反代到 API——复刻 vite dev 代理形态，
//    使浏览器同源 /api 请求与 Admin cookie（127.0.0.1, path=/api）串扰场景真实可复现。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../../apps/api/src/app.js";
import { loadConfig } from "../../../apps/api/src/config.js";
import { createPool } from "../../../apps/api/src/db/pool.js";
import { createStorageProvider } from "../../../apps/api/src/storage/index.js";
import { H5_API_PORT, H5_WEB_PORT, H5_TEST_AUTH_KEY, H5_TEST_PHONE_KEY, testDatabaseUrl } from "./shared.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
process.chdir(repoRoot);

const databaseUrl = testDatabaseUrl();
const storageRoot = join(repoRoot, "test-results", "h5-local-storage");
const distDir = join(repoRoot, "apps", "web", "dist");

// 1) 构建 H5 产物（每次运行都重建，保证回归的是当前源码）。
console.log("[h5-local] building apps/web dist ...");
const build = spawnSync("npm", ["--prefix", "apps/web", "run", "build"], { stdio: "inherit" });
if (build.status !== 0) throw new Error("apps/web build failed");
if (!existsSync(join(distDir, "index.html"))) throw new Error("apps/web/dist/index.html missing after build");

// 2) 真实 API（本地磁盘存储形态）。
const config = loadConfig({
  NODE_ENV: "test", STORAGE_PROVIDER: "local", OCR_PROVIDER: "none",
  AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: H5_TEST_AUTH_KEY, PHONE_ENCRYPTION_KEY_BASE64: H5_TEST_PHONE_KEY,
  PUBLIC_API_ORIGIN: `http://127.0.0.1:${H5_API_PORT}`, LOCAL_STORAGE_DIR: storageRoot,
});
const providers = { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "h5-local-e2e" }) };
const pool = createPool({ ...config, DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: 5 });
const storage = createStorageProvider(config);
await storage.assertReady();
const app = buildApp({ config, pool, providers, storage });
await app.listen({ host: "127.0.0.1", port: H5_API_PORT });
console.log(`[h5-local] api listening on 127.0.0.1:${H5_API_PORT} (storage root: ${storageRoot})`);

// 3) 静态产物 + /api 反代。
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
const webServer = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent((req.url || "/").split("?")[0]);
    if (path === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
    if (path === "/api" || path.startsWith("/api/")) {
      const proxied = httpRequest({ host: "127.0.0.1", port: H5_API_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${H5_API_PORT}` } }, (upstream) => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
      });
      proxied.on("error", () => { res.writeHead(502, { "content-type": "application/json" }); res.end('{"error":{"code":"PROXY_UNAVAILABLE","message":"api unreachable"}}'); });
      req.pipe(proxied);
      return;
    }
    const requested = normalize(path === "/" ? "/index.html" : path);
    let filePath = join(distDir, requested);
    if (!filePath.startsWith(distDir)) filePath = join(distDir, "index.html"); // 防目录逃逸
    let body;
    try {
      body = await readFile(filePath);
    } catch {
      filePath = join(distDir, "index.html"); // hash 路由：未知路径回退 index
      body = await readFile(filePath);
    }
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`h5-local server error: ${error?.message || error}`);
  }
});
await new Promise((resolve) => webServer.listen(H5_WEB_PORT, "127.0.0.1", resolve));
console.log(`[h5-local] web (dist + /api proxy) listening on 127.0.0.1:${H5_WEB_PORT}`);

const shutdown = async () => { await app.close().catch(() => {}); webServer.close(); await pool?.end().catch(() => {}); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

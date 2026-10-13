// Render 静态托管路由测试（fake dist 目录注入，无需真实前端构建）：
// / 与 /admin/ 资产服务、/admin 308、未注册 /api 与 /health 保持 JSON 404 不被 index 遮蔽、
// 缺失扩展名资源 404、hash 路由回退、目录逃逸拒绝、非 GET 拒绝、缓存头；
// 非 render 目标不注册任何静态路由（既有行为不变）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";

const WEB_INDEX = '<!doctype html><html><body><div id="root">web-h5-marker</div><script src="/assets/web.js"></script></body></html>';
const ADMIN_INDEX = '<!doctype html><html><body><div id="root">admin-panel-marker</div><script src="/admin/assets/admin.js"></script></body></html>';
const WEB_JS = "console.log('web')";
const ADMIN_JS = "console.log('admin')";

let root = "";
let webDist = "";
let adminDist = "";

const renderConfig = loadConfig({ NODE_ENV: "test", DEPLOYMENT_TARGET: "render", STORAGE_PROVIDER: "cos" });
const plainConfig = loadConfig({ NODE_ENV: "test" });

async function buildWithDists() {
  return buildApp({ config: renderConfig, pool: null, logger: false, staticDirs: { webDist, adminDist } });
}

describe.sequential("render static hosting", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "junde-render-static-"));
    webDist = path.join(root, "web");
    adminDist = path.join(root, "admin");
    // 哨兵文件：位于 web dist 之外，任何目录逃逸都不得读到它。
    await writeFile(path.join(root, "secret.txt"), "top-secret");
    await mkdir(path.join(webDist, "assets"), { recursive: true });
    await mkdir(path.join(adminDist, "assets"), { recursive: true });
    await writeFile(path.join(webDist, "index.html"), WEB_INDEX);
    await writeFile(path.join(webDist, "assets", "web.js"), WEB_JS);
    await writeFile(path.join(adminDist, "index.html"), ADMIN_INDEX);
    await writeFile(path.join(adminDist, "assets", "admin.js"), ADMIN_JS);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves the admin app under /admin/ with a 308 from /admin and hashed-asset caching", async () => {
    const app = await buildWithDists();
    const redirect = await app.inject({ method: "GET", url: "/admin" });
    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe("/admin/");

    const index = await app.inject({ method: "GET", url: "/admin/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(index.body).toContain("admin-panel-marker");

    const asset = await app.inject({ method: "GET", url: "/admin/assets/admin.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.body).toBe(ADMIN_JS);

    const head = await app.inject({ method: "HEAD", url: "/admin/assets/admin.js" });
    expect(head.statusCode).toBe(200);
    await app.close();
  });

  // Admin 回退规则：无扩展名的客户端页面路径回退 index（未知页面由前端渲染友好 404 页）；
  // 带扩展名的缺失资源严格 404（构建缺口不遮掩），路径穿越/编码逃逸严格 404。
  it("serves the admin app shell for extension-less page paths but never for missing assets or traversal", async () => {
    const app = await buildWithDists();
    const missingAsset = await app.inject({ method: "GET", url: "/admin/assets/missing.js" });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.body).not.toContain("admin-panel-marker");

    // 未知页面路径：应用壳可达，前端路由负责渲染友好 404（资源文件不受影响）。
    const unknownPage = await app.inject({ method: "GET", url: "/admin/some/where" });
    expect(unknownPage.statusCode).toBe(200);
    expect(unknownPage.headers["content-type"]).toContain("text/html");
    expect(unknownPage.body).toContain("admin-panel-marker");

    for (const url of ["/admin/assets/missing.css", "/admin/missing.txt", "/admin/assets/missing", "/admin/..%2F..%2Fsecret.txt", "/admin/%2e%2e/secret.txt"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain("admin-panel-marker");
    }
    await app.close();
  });

  // Admin 客户端路由深链接回退：带 ID 的详情/编辑屏与全部已知路由命中 index；POST 不回退。
  it("falls back to the admin index for real client route paths only", async () => {
    const app = await buildWithDists();
    const deepLinks = [
      "/admin/overview", "/admin/dashboard/", "/admin/campaigns", "/admin/campaigns/new",
      "/admin/campaigns/campaign-one", "/admin/campaigns/campaign-one/edit", "/admin/campaigns/campaign-one/assignments/assignment-one/edit",
      "/admin/users", "/admin/users/new", "/admin/users/user-inspector-one/edit",
      "/admin/stores/store-one/edit", "/admin/questionnaires/version-one", "/admin/questionnaires/new",
      "/admin/submissions/submission-one", "/admin/exports", "/admin/audits",
    ];
    for (const url of deepLinks) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["content-type"], url).toContain("text/html");
      expect(response.headers["cache-control"], url).toBe("no-cache");
      expect(response.body, url).toContain("admin-panel-marker");
    }
    // 非 GET 方法不回退（保持 JSON 404）。
    const post = await app.inject({ method: "POST", url: "/admin/overview", payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.json().error.code).toBe("ROUTE_NOT_FOUND");
    await app.close();
  });

  it("serves the H5 app at / with hash-routing fallback but 404 for missing extension assets", async () => {
    const app = await buildWithDists();
    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("web-h5-marker");

    const asset = await app.inject({ method: "GET", url: "/assets/web.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe(WEB_JS);
    expect(asset.headers["cache-control"]).toContain("immutable");

    const fallback = await app.inject({ method: "GET", url: "/some/spa/route" });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toContain("web-h5-marker");

    const missingJs = await app.inject({ method: "GET", url: "/assets/missing.js" });
    expect(missingJs.statusCode).toBe(404);
    expect(missingJs.body).not.toContain("web-h5-marker");
    await app.close();
  });

  it("does not mask unknown /api or /health paths with static content", async () => {
    const app = await buildWithDists();
    for (const url of ["/api/not-exist", "/api/", "/health/unknown"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      const body = response.body;
      expect(body.startsWith("{"), url).toBe(true);
      expect(body).not.toContain("web-h5-marker");
      expect(body).not.toContain("admin-panel-marker");
    }
    const apiNotFound = await app.inject({ method: "GET", url: "/api/not-exist" });
    expect(apiNotFound.json().error.code).toBe("ROUTE_NOT_FOUND");
    await app.close();
  });

  it("blocks path traversal out of the dist roots", async () => {
    const app = await buildWithDists();
    for (const url of ["/admin/..%2F..%2Fsecret.txt", "/..%2Fsecret.txt", "/%2e%2e/secret.txt", "/admin/../secret.txt"]) {
      const response = await app.inject({ method: "GET", url });
      expect([404, 400]).toContain(response.statusCode);
      expect(response.body).not.toContain("top-secret");
    }
    await app.close();
    // 兜底：哨兵文件仍在原处且未被改动。
    expect(await readFile(path.join(root, "secret.txt"), "utf8")).toBe("top-secret");
  });

  it("rejects non-GET/HEAD methods on the static area with JSON 404", async () => {
    const app = await buildWithDists();
    const post = await app.inject({ method: "POST", url: "/some/spa/route", payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.json().error.code).toBe("ROUTE_NOT_FOUND");
    await app.close();
  });

  it("fails startup when built assets are missing", async () => {
    expect(() => buildApp({ config: renderConfig, pool: null, logger: false, staticDirs: { webDist, adminDist: path.join(root, "missing") } })).toThrow(/build:render/);
    expect(() => buildApp({ config: renderConfig, pool: null, logger: false, staticDirs: { webDist: path.join(root, "missing"), adminDist } })).toThrow(/build:render/);
  });

  it("registers no static routes without the render deployment target (existing behavior)", async () => {
    const app = buildApp({ config: plainConfig, pool: null, logger: false });
    const rootResponse = await app.inject({ method: "GET", url: "/" });
    expect(rootResponse.statusCode).toBe(404);
    expect(rootResponse.body).not.toContain("web-h5-marker");
    const adminResponse = await app.inject({ method: "GET", url: "/admin/" });
    expect(adminResponse.statusCode).toBe(404);
    // 未注册 /api 路径保持 Fastify 默认 404 形态（不经过 render JSON 改写）。
    const apiResponse = await app.inject({ method: "GET", url: "/api/not-exist" });
    expect(apiResponse.statusCode).toBe(404);
    expect(apiResponse.json().message).toContain("not found");
    await app.close();
  });
});

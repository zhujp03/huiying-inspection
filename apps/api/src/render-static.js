// Render 单实例部署目标（DEPLOYMENT_TARGET=render）专属的静态前端托管：
//   /         → 探员端 H5 构建产物（apps/web/dist，hash 路由，未命中且无扩展名的 GET 回退 index）
//   /admin/   → 管理后台构建产物（apps/admin/dist，vite --base /admin/，/admin 308 到 /admin/）
// 安全边界：
//   - 只服务两个 dist 目录内的文件（resolve + realpath 双重前缀校验，拒绝目录逃逸/符号链接逃逸）；
//     项目根、.env、本地证据目录（/var/data）绝不在可服务范围内。
//   - 不遮蔽 API：未注册的 /api、/health、/metrics 等路径一律 JSON 404，不回退 index；
//     带扩展名的缺失资源（如构建缺口的 .js/.css）返回 404，不用 index 冒充。
//   - 无新依赖：内置 MIME 表 + node:fs 流式读取；hashed 资源 immutable 长缓存，index no-cache。
import { createReadStream, existsSync } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
  ".woff": "font/woff", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

const defaultDist = (segment) => resolve(process.cwd(), "apps", segment, "dist");
const notFound = (message) => Object.assign(new Error(message), { code: "STATIC_NOT_FOUND", statusCode: 404 });

function resolveWithin(distRoot, urlPath) {
  if (urlPath.includes("\0")) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // 畸形百分号编码直接视为未命中
  }
  if (decoded.includes("\0")) return null;
  const target = resolve(distRoot, `.${sep}${decoded.replace(/^\/+/, "")}`);
  const rootWithSep = distRoot.endsWith(sep) ? distRoot : distRoot + sep;
  if (target !== distRoot && !target.startsWith(rootWithSep)) return null;
  return target;
}

// 命中已存在的文件则返回流信息；resolve 逃逸/符号链接逃逸一律视为未命中（由调用方 404）。
async function statWithin(distRoot, urlPath) {
  const target = resolveWithin(distRoot, urlPath);
  if (!target) return null;
  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
    const real = await realpath(target);
    const realRoot = await realpath(distRoot);
    const realRootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (real !== realRoot && !real.startsWith(realRootWithSep)) return null;
    return { target, size: info.size };
  } catch {
    return null;
  }
}

function sendFile(reply, { target, size }, contentType) {
  reply.header("content-type", contentType || MIME[extname(target).toLowerCase()] || "application/octet-stream");
  if (contentType?.includes("text/html")) reply.header("cache-control", "no-cache");
  reply.header("content-length", size);
  // pathToFileURL 规避特殊字符路径的流式读取边界。
  return reply.send(createReadStream(pathToFileURL(target)));
}

async function sendIndex(reply, distRoot) {
  const found = await statWithin(distRoot, "index.html");
  if (!found) throw notFound("前端入口缺失");
  reply.header("cache-control", "no-cache");
  return sendFile(reply, found, "text/html; charset=utf-8");
}

export function registerRenderStaticRoutes(app, { webDist = defaultDist("web"), adminDist = defaultDist("admin") } = {}) {
  // 构建缺失在启动期失败关闭（buildCommand 先于 startCommand 执行，正常部署不会走到这里）。
  for (const [label, dir] of [["H5", webDist], ["Admin", adminDist]]) {
    if (!existsSync(join(dir, "index.html"))) {
      throw new Error(`Render 静态资源缺失：${label} 构建产物不存在（${dir}）。请先运行 npm run build:render 再启动服务。`);
    }
  }

  const api404 = (request, reply) => reply.code(404).send({ error: { code: "ROUTE_NOT_FOUND", message: `Route ${request.method}:${request.url} not found`, requestId: request.id } });

  // Admin：/admin 308 到 /admin/（目录语义）；入口 only——Admin 无路由器，不把 index 冒充任意路径。
  app.get("/admin", (_request, reply) => reply.redirect("/admin/", 308));
  app.get("/admin/", (_request, reply) => sendIndex(reply, adminDist));
  app.get("/admin/index.html", (_request, reply) => sendIndex(reply, adminDist));
  app.get("/admin/*", async (request, reply) => {
    const relative = String(request.params["*"] || "");
    const found = await statWithin(adminDist, relative);
    if (!found) throw notFound("静态资源不存在");
    // vite hashed 资源长缓存；其余（如 favicon）短缓存。
    reply.header("cache-control", relative.startsWith(`assets${sep}`) || relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300");
    return sendFile(reply, found);
  });

  // H5：根入口；hash 路由只有 / 一个入口，其余未注册路径走 notFound 回退（见下）。
  app.get("/", (_request, reply) => sendIndex(reply, webDist));

  app.setNotFoundHandler(async (request, reply) => {
    const urlPath = (request.url || "/").split("?")[0];
    // API/健康/指标/管理面未注册路径绝不回退 index：保持 JSON 404（不遮蔽未知 API 端点）。
    if (!["GET", "HEAD"].includes(request.method)) return api404(request, reply);
    if (urlPath === "/api" || urlPath.startsWith("/api/") || urlPath === "/health" || urlPath.startsWith("/health/")
      || urlPath === "/live" || urlPath === "/ready" || urlPath === "/metrics" || urlPath.startsWith("/admin")) {
      return api404(request, reply);
    }
    // H5 区域：真实存在的资源文件直出；带扩展名的缺失资源 404（不用 index 冒充）；
    // 无扩展名的未知路径回退 H5 index（hash 路由由前端处理）。
    const found = await statWithin(webDist, urlPath);
    if (found) {
      reply.header("cache-control", urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300");
      return sendFile(reply, found);
    }
    if (extname(urlPath)) return api404(request, reply);
    return sendIndex(reply, webDist);
  });
}

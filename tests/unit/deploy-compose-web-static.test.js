// 部署配置静态断言：H5(web) 生产托管接入 compose 层（2026-10-11 批次）。
//   1. compose caddy 服务把 apps/web/dist 只读挂载到 /srv/web，并注入 WEB_ORIGIN（失败关闭）；
//   2. caddy healthcheck 必须同时校验 admin 与 web 两份产物的 index.html 存在——
//      Docker 对不存在的 bind mount 源目录会静默创建空目录，healthcheck 弥补该盲区；
//   3. Admin 既有挂载与注入不回归；
//   4. Caddyfile web 站点 route 钉序：/api/* 反代必须先于 try_files（SPA 回退防吞 API）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const composeText = readFileSync(join(root, "ops/docker/docker-compose.production.yml"), "utf8");
const caddyfileText = readFileSync(join(root, "ops/docker/Caddyfile"), "utf8");
// caddy 是最后一个 service：取其服务块（到顶层 networks: 为止）做锚定断言，防止误匹配其他服务的同名片段。
const caddyBlock = composeText.slice(composeText.indexOf("\n  caddy:"), composeText.indexOf("\nnetworks:"));

describe("production compose serves web (H5) static bundle", () => {
  it("mounts apps/web/dist read-only at /srv/web", () => {
    expect(composeText).toContain("../../apps/web/dist:/srv/web:ro");
  });

  it("injects WEB_ORIGIN with fail-closed empty default", () => {
    expect(composeText).toContain("WEB_ORIGIN: ${WEB_ORIGIN:-}");
  });

  it("caddy healthcheck requires both admin and web index.html (catches unbuilt bundles)", () => {
    expect(caddyBlock).toContain("/srv/admin/index.html");
    expect(caddyBlock).toContain("/srv/web/index.html");
    expect(caddyBlock).toMatch(/healthcheck:\s*\n\s*test:/);
  });

  it("keeps admin mount and ADMIN_ORIGIN injection intact", () => {
    expect(composeText).toContain("../../apps/admin/dist:/srv/admin:ro");
    expect(composeText).toContain("ADMIN_ORIGIN: ${ADMIN_ORIGIN:-}");
  });
});

describe("Caddyfile web site", () => {
  it("contains root * /srv/web", () => {
    expect(caddyfileText).toContain("root * /srv/web");
  });

  it("pins reverse_proxy /api/* before try_files in the web route block", () => {
    const lines = caddyfileText.split("\n");
    const proxyIndex = lines.findIndex((line) => line.includes("reverse_proxy /api/*"));
    const tryFilesAfterProxy = lines.findIndex((line, index) => index > proxyIndex && line.includes("try_files"));
    expect(proxyIndex).toBeGreaterThan(-1);
    expect(tryFilesAfterProxy).toBeGreaterThan(proxyIndex);
  });
});

// Render 静态产物校验（npm run verify:render， REQUIRED 检查，失败即非零）：
//   - apps/web/dist/index.html 存在且引用自身 hashed 资产；
//   - apps/admin/dist/index.html 存在且以 /admin/assets/ 为基（--base /admin/ 产物，
//     build:admin 的平铺产物会被判失败——Render 必须使用 build:render）；
//   - 两份 index 均不得包含 API 域名字面量（零域名规则对 render 产物同样生效）。
// 该检查是 Render 冒烟的前置门：backend 测试遇到缺失/错误基的产物时显式 skip（不计通过）。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) console.log(`[verify:render] PASS ${label}`);
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const webIndex = join(repoRoot, "apps", "web", "dist", "index.html");
const adminIndex = join(repoRoot, "apps", "admin", "dist", "index.html");

check("web dist index exists", existsSync(webIndex), webIndex);
check("admin dist index exists", existsSync(adminIndex), adminIndex);

if (existsSync(webIndex)) {
  const html = await readFile(webIndex, "utf8");
  const asset = html.match(/assets\/index-[^"']+\.js/);
  check("web index references its hashed asset", Boolean(asset));
  check("web index exists on disk", asset ? existsSync(join(repoRoot, "apps", "web", "dist", asset[0])) : false);
  check("web index has no api domain literal", !/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/[^"']*/g, "")), "found protocol-prefixed literal");
}
if (existsSync(adminIndex)) {
  const html = await readFile(adminIndex, "utf8");
  const asset = html.match(/\/admin\/assets\/index-[^"']+\.js/);
  check("admin index is a --base /admin/ build (references /admin/assets/…)", Boolean(asset), "missing /admin/assets/ prefix — run npm run build:render");
  const adminAssetRelative = asset ? asset[0].replace(/^\/admin\//, "") : ""; // dist 内相对路径 assets/…
  check("admin index exists on disk", adminAssetRelative ? existsSync(join(repoRoot, "apps", "admin", "dist", adminAssetRelative)) : false);
  check("admin index has no api domain literal", !/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/[^"']*/g, "")), "found protocol-prefixed literal");
}

if (failures.length > 0) {
  console.error(`[verify:render] FAIL (${failures.length}):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("[verify:render] PASS");

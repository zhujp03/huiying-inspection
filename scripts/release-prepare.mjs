// release:prepare — 发布准备：生成小程序 API Origin、构建 Admin、生成契约、
// 泄密扫描与占位值检查。--check-example 模式用 .env.example 验证生成逻辑，
// 不产生 production PASS。
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkExample = process.argv.includes("--check-example");
const failures = [];
const run = (name, args, cwd = root, viaNpm = false) => {
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = viaNpm ? spawnSync("npm", args, { cwd, encoding: "utf8", stdio: "inherit" }) : spawnSync(process.execPath, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) failures.push(name);
  return result.status === 0;
};

// 1) Node 24 运行时检查
if (!/^v24\./.test(process.version)) failures.push(`Node 24 必需（当前 ${process.version}）`);

// 2) 读取根目录 .env（check-example 用 .env.example；ENV_FILE 可指向其它环境文件）
const envPath = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : resolve(root, ".env");
let env = {};
if (checkExample) {
  env = parseEnv(readFileSync(resolve(root, ".env.example"), "utf8"));
} else if (existsSync(envPath)) {
  env = parseEnv(readFileSync(envPath, "utf8"));
} else {
  failures.push("缺少根目录 .env：请先 cp .env.example .env 并填写（或用 --check-example 验证生成逻辑）");
}

// 3) 生成小程序 API Origin（公开值）
if (!run("generate-miniapp-runtime-config", [resolve(root, "scripts/generate-miniapp-runtime-config.mjs"), ...(checkExample ? ["--check-example"] : [])])) {
  failures.push("生成小程序运行时配置失败");
}
// 发布包安全：生成产物只允许 https 公网 Origin；本机 http 仅限开发环境，不得进入 release 包。
// check-example 模式不写产物（磁盘保留开发值），改校验 .env.example 的公开值本身。
{
  const generatedApiBase = checkExample
    ? (env.MINIAPP_API_BASE_URL || "").trim()
    : (readFileSync(join(root, "apps/miniapp/miniprogram/runtime-config.generated.js"), "utf8").match(/apiBase:\s*"([^"]*)"/) || [])[1] || "";
  if (generatedApiBase && !/^https:\/\//i.test(generatedApiBase)) {
    failures.push(`小程序 API Origin 必须是 https 公网地址（当前 ${generatedApiBase}；本机 http 仅限开发环境）`);
  }
}

// 4) 生成/检查 API 契约
if (!run("contracts:generate", ["run", "contracts:generate"], root, true)) failures.push("生成 API 契约失败");

// 5) 构建 Admin（公开白名单：VITE_TENCENT_MAP_KEY 等由根 .env 提供）
const adminBuild = spawnSync("npm", ["--prefix", "apps/admin", "run", "build"], { cwd: root, encoding: "utf8", env: { ...process.env, VITE_TENCENT_MAP_KEY: env.TENCENT_MAP_KEY || "", VITE_API_BASE_URL: env.PUBLIC_API_ORIGIN || "" }, stdio: "inherit" });
if (adminBuild.status !== 0) failures.push("Admin 构建失败");

// 6) 泄密扫描：小程序与 Admin 构建产物不得出现 Secret/密码/数据库 URL/COS 永久凭证
const scanTargets = [
  join(root, "apps/miniapp/miniprogram"),
  join(root, "apps/admin/dist"),
  join(root, "apps/miniapp/miniprogram/runtime-config.generated.js"),
];
const secretPatterns = [
  // (?!\{\{) 排除 WXML 数据绑定（如 password="{{!showPassword}}"），只匹配字面量 Secret；
  // 真实密钥不会以 {{...}} 模板绑定形式出现在包内，检测能力不因此减弱。
  /(app_secret_key|api_secret_key|secret_id|secret_key|password)\s*[:=]\s*["'](?!\{\{)[^"']{8,}["']/i,
  /DATABASE_URL\s*[:=]\s*["']?postgres/,
  /COS_STS_SECRET|COS_ASSUME_ROLE_SECRET/,
  /AKID[A-Za-z0-9]{8,}/,
];
const scanPath = (target) => {
  const stat = statSync(target);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target)) {
      const full = join(target, entry);
      if (entry === "node_modules" || entry === "fixtures") continue;
      scanPath(full);
    }
    return;
  }
  if (!/\.(js|json|css|html|wxml|wxss)$/.test(target)) return;
  const source = readFileSync(target, "utf8");
  for (const pattern of secretPatterns) {
    if (pattern.test(source)) { failures.push(`泄密扫描命中 ${pattern} → ${target}`); break; }
  }
  if (/YOUR_|change-me|YOUR_TENCENT/i.test(source) && !target.includes("runtime-config.generated.js")) failures.push(`占位值扫描命中 → ${target}`);
};
scanTargets.forEach((target) => { if (existsSync(target)) scanPath(target); });

// 7) 微信项目唯一性
if (!run("check-wechat-project", [resolve(root, "scripts/check-wechat-project.mjs")])) failures.push("微信项目唯一性检查失败");

// 8) 摘要（只显示字段是否存在与非敏感信息）
console.log("\n=== 构建摘要（不含任何值） ===");
console.log(`  MINIAPP_API_BASE_URL: ${env.MINIAPP_API_BASE_URL ? "已配置" : "未配置"}`);
console.log(`  TENCENT_MAP_KEY: ${env.TENCENT_MAP_KEY ? "已配置" : "未配置"}`);
console.log(`  check-example 模式: ${checkExample}`);

if (failures.length > 0) {
  console.error("\nrelease:prepare FAILED:");
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log("\nrelease:prepare PASS");
process.exit(0);

function parseEnv(text) {
  const result = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

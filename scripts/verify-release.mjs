// verify:release — single fail-closed release gate.
//
// Chains: runtime check → production-source scan → contract drift check →
// frontend unit/build → PostgreSQL migrate/seed/integration (requires
// DATABASE_URL) → backend integration (requires DATABASE_URL) → P1 preflight
// (requires P1_PLAN_PATH) → admin E2E → miniapp native E2E (requires WeChat
// DevTools CLI).
//
// Unlike a plain test runner, this script FAILS CLOSED: when a mandatory
// environment input is missing (DATABASE_URL, P1_PLAN_PATH, WeChat DevTools)
// it runs everything it can, prints an explicit missing-items list, and
// exits non-zero. It never silently skips a gate and returns 0.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const wechatCli = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";

const env = process.env;
// 避免与本机其它进程（如用户代理/限流服务）占用默认端口冲突。
if (!env.CONTRACT_PORT) env.CONTRACT_PORT = "8799";
if (!env.ADMIN_PORT) env.ADMIN_PORT = "4184";
const results = [];
const missing = [];

const run = (name, args, options = {}) => {
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = spawnSync(npm, ["run", ...args], { cwd: root, env, encoding: "utf8", stdio: "inherit", timeout: options.timeout || 30 * 60 * 1000 });
  const passed = result.status === 0;
  results.push({ name, passed, signal: result.signal });
  return passed;
};

const checkRuntime = run("check:runtime", ["check:runtime"]);
const sourceScan = run("test:production-source", ["test:production-source"]);
const contractCheck = run("contracts:check", ["contracts:check"]);
const frontend = run("test:frontend", ["test:frontend"]);

let postgres = null;
if (env.DATABASE_URL) {
  const migrated = run("db:migrate", ["db:migrate"], { timeout: 20 * 60 * 1000 });
  const seeded = run("db:seed", ["db:seed"], { timeout: 20 * 60 * 1000 });
  const postgresTests = run("test:backend:postgres", ["test:backend:postgres"]);
  const backendTests = run("test:backend", ["test:backend"]);
  postgres = migrated && seeded && postgresTests && backendTests;
} else {
  missing.push("DATABASE_URL（PostgreSQL 17 空库/升级迁移、种子和 test:backend:postgres / test:backend 必须的真实数据库）");
  postgres = null;
}

let p1 = null;
if (env.P1_PLAN_PATH && existsSync(env.P1_PLAN_PATH)) {
  p1 = run("preflight:p1", ["preflight:p1"]);
} else {
  missing.push("P1_PLAN_PATH（仓库外、授权、含 100 探店员/20 管理员身份与全部 P1 基数的 staging 计划，preflight:p1 必读）");
  p1 = null;
}

let adminE2e = run("test:admin:e2e", ["test:admin:e2e"]);

let miniappNative = null;
let receiptNative = null;
let realApiFlow = null;
if (existsSync(wechatCli)) {
  miniappNative = run("test:miniapp:native", ["test:miniapp:native"]);
  receiptNative = run("test:miniapp:receipt-native", ["test:miniapp:receipt-native"]);
  // 真实 API 小程序流程：小程序直连本机真实 API + 真实 PostgreSQL 17（独立库），
  // 需要微信开发者工具与本地 postgres:17；失败即门禁失败（不静默跳过）。
  realApiFlow = run("test:miniapp:real-api", ["test:miniapp:real-api"]);
} else {
  missing.push("微信开发者工具 CLI（/Applications/wechatwebdevtools.app，test:miniapp:native / test:miniapp:receipt-native / test:miniapp:real-api 必须的真机/工具环境）");
}

console.log("\n\n========== verify:release 汇总 ==========");
for (const result of results) console.log(`  [${result.passed ? "PASS" : "FAIL"}${result.signal ? ` (${result.signal})` : ""}] ${result.name}`);
if (missing.length > 0) {
  console.log("\n缺少强制验收环境（必须补齐后重跑，不能视为通过）：");
  missing.forEach((item) => console.log(`  - ${item}`));
  console.log("\nverify:release: BLOCKED（存在缺项）");
  process.exit(1);
}
if (results.some((result) => !result.passed)) {
  console.log("\nverify:release: FAIL（存在失败步骤）");
  process.exit(1);
}
console.log("\nverify:release: PASS");
process.exit(0);

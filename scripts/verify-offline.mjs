// verify:offline — 离线发布门禁：不依赖任何云服务/真机，缺环境即失败关闭。
// 覆盖：runtime、契约漂移、production source 扫描、单元/契约、Admin 构建与
// fixture E2E、小程序 fixture 原生回归（默认跳过，--with-native 才执行）、微信项目唯一性、Compose 静态校验、
// release:prepare --check-example、Markdown 结构与链接检查。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 避免与本机其它进程（如用户代理/限流服务）占用默认端口冲突。
if (!process.env.CONTRACT_PORT) process.env.CONTRACT_PORT = "8799";
if (!process.env.ADMIN_PORT) process.env.ADMIN_PORT = "4184";
const results = [];
const missing = [];
const run = (name, args, viaNpm = false) => {
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = viaNpm ? spawnSync("npm", args, { cwd: root, encoding: "utf8", stdio: "inherit", timeout: 25 * 60 * 1000 }) : spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", stdio: "inherit", timeout: 25 * 60 * 1000 });
  results.push({ name, passed: result.status === 0 });
  return result.status === 0;
};

run("check:runtime", ["run", "check:runtime"], true);
run("contracts:check", ["run", "contracts:check"], true);
run("test:production-source", ["run", "test:production-source"], true);
run("frontend contract + unit + admin build", ["run", "test:frontend"], true);
run("wechat project uniqueness", [resolve(root, "scripts/check-wechat-project.mjs")]);
run("release:prepare --check-example", [resolve(root, "scripts/release-prepare.mjs"), "--check-example"]);

// 小程序 fixture 原生回归（需要微信开发者工具）：默认跳过，--with-native 才执行。
// 开发者工具链式启动在本环境偶发静默退出：每个步骤允许一次重试（重试仍失败才判 FAIL）。
const withNative = process.argv.includes("--with-native");
const wechatCli = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const runWithRetry = (name, script) => {
  const first = results.length;
  if (!run(name, [resolve(root, script)])) {
    process.stdout.write(`${name} 首次失败，重试一次（开发者工具链式启动抖动）\n`);
    results.length = first; // 移除失败记录
    run(name, [resolve(root, script)]);
  }
};
if (withNative) {
  if (existsSync(wechatCli)) {
    runWithRetry("miniapp native fixture", "tests/e2e/miniapp-native.cjs");
    runWithRetry("miniapp receipt native fixture", "tests/e2e/miniapp-receipt-native.cjs");
  } else {
    missing.push("微信开发者工具 CLI（miniapp fixture 原生回归必需）");
  }
} else {
  process.stdout.write("已跳过 DevTools native fixture（移交用户手动实测），如需包含请加 --with-native\n");
}

// Admin fixture E2E（Playwright + 契约服务）
run("admin e2e (fixture)", ["run", "test:admin:e2e"], true);

// web（H5 探员端）：套件全量 + 构建 + dist 产物零域名扫描
run("web unit + build + artifact scan", ["run", "test:web"], true);

// Docker/Compose 静态配置检查
const composeFile = resolve(root, "ops/docker/docker-compose.production.yml");
if (existsSync(composeFile)) {
  const compose = spawnSync("docker", ["compose", "-f", composeFile, "config", "--quiet"], { encoding: "utf8", timeout: 60000 });
  results.push({ name: "docker compose config", passed: compose.status === 0 });
  if (compose.status !== 0) process.stdout.write(compose.stderr);
} else {
  missing.push("docker-compose.production.yml 缺失");
}

// Markdown 结构与链接检查：清单 = 仓库现行核心文档（根目录规格 + docs/ 主文档）。
const mdFailures = [];
for (const file of ["README.md", "BACKEND_DESIGN.md", "project_boundary.md", "assignment_spec.md", "STATE_MACHINE_OVERVIEW.md", "video_replication_spec.md", "design-qa.md", "docs/DEPLOYMENT.md", "docs/traceability-matrix.md", "docs/task-time-fields-design.md", "docs/evidence-limits-design.md", "docs/user-management-design.md", "docs/admin-layout-fix-design.md", "docs/sms-captcha-setup.md"]) {
  const path = join(root, file);
  if (!existsSync(path)) { mdFailures.push(`${file} 缺失`); continue; }
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1];
    if (/^https?:\/\//.test(target)) continue;
    const resolved = resolve(dirname(path), target);
    if (!existsSync(resolved)) mdFailures.push(`${file} 断链: ${target}`);
  }
}
results.push({ name: "markdown structure & links", passed: mdFailures.length === 0 });
mdFailures.forEach((failure) => process.stdout.write(`  - ${failure}\n`));

console.log("\n========== verify:offline 汇总 ==========");
for (const result of results) console.log(`  [${result.passed ? "PASS" : "FAIL"}] ${result.name}`);
if (missing.length > 0) {
  console.log("\n缺少强制环境（不能视为通过）：");
  missing.forEach((item) => console.log(`  - ${item}`));
  console.log("\nverify:offline: BLOCKED");
  process.exit(1);
}
if (results.some((result) => !result.passed)) {
  console.log("\nverify:offline: FAIL（存在失败步骤）");
  process.exit(1);
}
console.log("\nverify:offline: PASS");
process.exit(0);

// preflight:production — 生产预检：读取根目录 .env，校验全部生产强制类别，
// 检查数据库连接/migration、OCR ready、部署文件完整性。不改变任何云资源。
// 缺少任何强制项 → 非零退出并只列变量名，不输出值。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../apps/api/src/config.js";
import { createOcrClient } from "../apps/worker/src/ocr-client.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : resolve(root, ".env");
if (!existsSync(envPath)) {
  console.error("preflight:production: 缺少根目录 .env（cp .env.example .env 并填写）");
  process.exit(1);
}
const env = parseEnv(readFileSync(envPath, "utf8"));

// 1) 严格配置校验（production 失败关闭）
const config = loadConfig({ ...env, NODE_ENV: "production" });
console.log("preflight:production: 配置校验 PASS（全部强制类别已配置）");

const failures = [];

// 2) 数据库连接与 migration 完整性：独立子进程 + OS 级硬超时（15s），
// 任何原因导致 pg 挂起都不会拖住预检。宿主机脚本优先使用 DATABASE_HOST_URL
// （同机自建 PG 的 127.0.0.1:5432 回环地址），缺省回退容器内地址 DATABASE_URL。
const databaseUrl = config.DATABASE_HOST_URL || config.DATABASE_URL;
const dbCheckScript = `
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.PREFLIGHT_DATABASE_URL, max: 1, connectionTimeoutMillis: 8000 });
try {
  const client = await pool.connect();
  const version = await client.query("SHOW server_version");
  const migrationCount = await client.query("SELECT count(*)::int count FROM schema_migrations");
  console.log(JSON.stringify({ ok: true, serverVersion: version.rows[0].server_version, migrationCount: migrationCount.rows[0].count, migrationFiles: process.env.PREFLIGHT_MIGRATION_FILES }));
  client.release();
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error.message).split("\\n")[0] }));
} finally {
  await pool.end().catch(() => {});
  process.exit(0);
}
`;
const migrationFiles = readdirSync(resolve(root, "db/migrations")).filter((name) => name.endsWith(".sql")).length;
const dbResult = await new Promise((resolvePromise) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", dbCheckScript], {
    env: { ...process.env, PREFLIGHT_DATABASE_URL: databaseUrl, PREFLIGHT_MIGRATION_FILES: String(migrationFiles) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise({ ok: false, error: "数据库检查超时（15s）" }); }, 15000);
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("exit", () => { clearTimeout(timer); try { resolvePromise(JSON.parse(output.trim().split("\n").pop())); } catch { resolvePromise({ ok: false, error: `数据库检查异常：${output.slice(0, 200)}` }); } });
  child.on("error", (error) => { clearTimeout(timer); resolvePromise({ ok: false, error: error.message }); });
});
if (dbResult.ok) {
  console.log(`preflight:production: PostgreSQL ${dbResult.serverVersion}，migration ${dbResult.migrationCount}/${dbResult.migrationFiles}`);
  if (Number(dbResult.migrationCount) !== Number(dbResult.migrationFiles)) failures.push(`数据库 migration 不完整（${dbResult.migrationCount}/${dbResult.migrationFiles}）`);
} else {
  failures.push(`数据库连接失败：${dbResult.error}`);
}

  // 3) OCR 按 OCR_PROVIDER 分支（none/tencent 不做任何网络探活）：
  //    none    纯手动填写形态，OCR 功能关闭 → 跳过 /ready 探活；
  //    tencent 仅校验 OCR 密钥存在（不发真实请求、不产生计费）；
  //    paddle  保留原有 sidecar /ready 探活。
  if (config.OCR_PROVIDER === "none") {
    console.log("preflight:production: OCR_PROVIDER=none（小票识别功能关闭），跳过 OCR 探活");
  } else if (config.OCR_PROVIDER === "tencent") {
    if (!config.OCR_SECRET_ID || !config.OCR_SECRET_KEY) failures.push("OCR_SECRET_ID/OCR_SECRET_KEY 缺失（OCR_PROVIDER=tencent 需要）");
    else console.log("preflight:production: 腾讯云 OCR 密钥已配置（未发起真实请求）");
  } else {
    const ocr = createOcrClient(config);
    if (!ocr.configured) failures.push("OCR_SERVICE_URL 未配置");
    else {
      try {
        const response = await fetch(`${config.OCR_SERVICE_URL}/ready`, { signal: AbortSignal.timeout(8000) });
        if (response.ok) console.log("preflight:production: OCR sidecar ready");
        else failures.push(`OCR /ready 返回 ${response.status}`);
      } catch { failures.push("OCR sidecar 不可达"); }
    }
  }

  // 4) 部署文件完整性（Dockerfile.ocr 仅 paddle sidecar 形态需要）
  const deployFiles = ["ops/docker/docker-compose.production.yml", "ops/docker/Caddyfile", "ops/docker/Dockerfile.api"];
  if (config.OCR_PROVIDER === "paddle") deployFiles.push("ops/docker/Dockerfile.ocr");
  for (const file of deployFiles) {
    if (!existsSync(resolve(root, file))) failures.push(`${file} 缺失`);
  }

  // 5) 公开客户端配置（AUTH_SELF_SERVICE=disabled 时验证码休眠，不要求 CAPTCHA_APP_ID；
  //    此时 loadConfig 已强制 CAPTCHA_*/SMS_* 密钥留空）
  if (config.AUTH_SELF_SERVICE !== "disabled" && !config.CAPTCHA_APP_ID) failures.push("CAPTCHA_APP_ID 缺失（公开配置接口需要）");
  if (!config.TENCENT_MAP_KEY) failures.push("TENCENT_MAP_KEY 缺失（公开配置接口需要）");

  // 6) Caddy 生产入口依赖：Admin 静态产物与证书邮箱
  if (!existsSync(resolve(root, "apps/admin/dist/index.html"))) failures.push("apps/admin/dist/index.html 缺失（先运行 npm run release:prepare 构建 Admin）");
  if (!env.CADDY_EMAIL || /example\.|change-me|YOUR_/i.test(env.CADDY_EMAIL)) failures.push("CADDY_EMAIL 缺失或为占位值（Caddy ACME 证书申请邮箱）");

  if (failures.length > 0) {
    console.error("\npreflight:production FAILED:");
    failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exit(1);
  }
console.log("preflight:production: PASS（未改变任何云资源）");
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

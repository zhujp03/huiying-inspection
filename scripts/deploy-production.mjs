// deploy:production — 生产部署：先跑 preflight:production（失败关闭，不改变外部
// 状态），检测是否已有 super_admin（没有则输出唯一 TTY bootstrap 命令），再执行
// docker compose 部署。需要 DEPLOY_CONFIRM=yes 显式确认。
// 本脚本不购买资源、不修改腾讯云 IAM、不创建收费服务；缺少外部资源时在变更
// 外部状态前失败关闭。
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.DEPLOY_CONFIRM !== "yes" && !process.argv.includes("--yes")) {
  console.error("deploy:production: 需要 DEPLOY_CONFIRM=yes（或 --yes）显式确认");
  process.exit(1);
}

// 1) 预检失败关闭（不改变外部状态）
const preflight = spawnSync(process.execPath, [resolve(root, "scripts/preflight-production.mjs")], { cwd: root, encoding: "utf8", stdio: "inherit", timeout: 120000 });
if (preflight.status !== 0) {
  console.error("deploy:production: 预检未通过，未改变任何外部状态");
  process.exit(1);
}

// 2) 首个管理员安全检测：不创建默认账号；没有首管时输出唯一 TTY 命令。
const envPath = process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : resolve(root, ".env");
const env = parseEnv(readFileSync(envPath, "utf8"));
(async () => {
  // 宿主机脚本优先使用 DATABASE_HOST_URL（同机自建 PG 的 127.0.0.1 回环地址），缺省回退 DATABASE_URL。
  const pool = new pg.Pool({ connectionString: env.DATABASE_HOST_URL || env.DATABASE_URL, max: 1, connectionTimeoutMillis: 8000 });
  try {
    const superAdmin = await pool.query(`SELECT count(*)::int count FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'super_admin' AND ur.revoked_at IS NULL`);
    if (superAdmin.rows[0].count === 0) {
      console.log("\n部署后请在安全 TTY 创建首个超级管理员（本脚本不会创建默认账号）：");
      console.log("  npm run admin:bootstrap");
      console.log("（该命令交互式读取两次密码，密码不会写入 .env、命令行、日志或镜像）\n");
    } else {
      console.log("deploy:production: 已存在 super_admin，跳过 bootstrap 提示");
    }
  } catch (error) {
    console.error(`deploy:production: 无法检查 super_admin：${error.message.split("\n")[0]}`);
    process.exit(1);
  } finally {
    await pool.end();
  }

  // 3) 构建并启动生产 Compose（--env-file 注入根目录 .env：Caddy 域名/证书邮箱与
  // ${VAR} 插值只从这一处读取；环境变量不会以明文出现在命令行）
  const compose = spawnSync("docker", ["compose", "--env-file", envPath, "-f", resolve(root, "ops/docker/docker-compose.production.yml"), "up", "-d", "--build"], { cwd: root, encoding: "utf8", stdio: "inherit", timeout: 30 * 60 * 1000 });
  if (compose.status !== 0) {
    console.error("deploy:production: docker compose 启动失败");
    process.exit(1);
  }
  console.log("deploy:production: PASS（健康检查与日志轮换由 Compose 定义）");
  process.exit(0);
})();

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

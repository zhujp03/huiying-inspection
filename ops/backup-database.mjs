import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../apps/api/src/config.js";
import { createStorageProvider } from "../apps/api/src/storage/index.js";

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${stderr.slice(0, 500)}`)));
});
const fileSha256 = async (path) => new Promise((resolve, reject) => {
  const digest = createHash("sha256");
  createReadStream(path).on("data", (chunk) => digest.update(chunk)).on("error", reject).on("end", () => resolve(digest.digest("hex")));
});

if (process.env.BACKUP_EXECUTION_CONFIRM !== "yes") throw new Error("Set BACKUP_EXECUTION_CONFIRM=yes to create a database backup.");
const config = loadConfig();
// 宿主机备份脚本优先使用 DATABASE_HOST_URL（127.0.0.1 回环），缺省回退 DATABASE_URL。
const databaseUrl = config.DATABASE_HOST_URL || config.DATABASE_URL;
if (!databaseUrl || !config.COS_BACKUP_BUCKET) throw new Error("DATABASE_URL and COS_BACKUP_BUCKET are required.");
const prefix = (process.env.BACKUP_PREFIX || "postgres").replace(/^\/+|\/+$/g, "");
if (!/^[a-zA-Z0-9/_-]+$/.test(prefix)) throw new Error("BACKUP_PREFIX contains unsupported characters.");
const workspace = await mkdtemp(join(tmpdir(), "junde-pg-backup-"));
const output = join(workspace, "database.dump");
try {
  await run("pg_dump", ["--dbname", databaseUrl, "--format=custom", "--no-owner", "--no-privileges", "--file", output]);
  await run("pg_restore", ["--list", output]);
  const metadata = await stat(output);
  if (!metadata.size) throw new Error("pg_dump produced an empty backup.");
  const sha256 = await fileSha256(output);
  const key = `${prefix}/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${sha256.slice(0, 16)}.dump`;
  const cos = createStorageProvider(config);
  if (!cos.backupConfigured) throw new Error("备份目标未配置：本地存储形态（STORAGE_PROVIDER=local）不提供数据库备份上传，请切换 STORAGE_PROVIDER=cos 并配置 COS_BACKUP_BUCKET。");
  await cos.putBackupObject({ key, body: createReadStream(output), contentLength: metadata.size, sha256 });
  const remote = await cos.headBackupObject(key);
  if (remote.sizeBytes !== metadata.size || remote.sha256 !== sha256) throw new Error("Backup object verification failed.");
  // 记录备份完成（metrics 的 backup_age_seconds 数据源），不保存敏感值。
  const { default: pg } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const recorder = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  try { await recorder.query("INSERT INTO system_job_runs (id,job,status,completed_at,heartbeat_at,detail_json) VALUES ($1,'database_backup','completed',now(),now(),$2)", [randomUUID(), JSON.stringify({ key, sizeBytes: metadata.size })]); }
  finally { await recorder.end(); }
  process.stdout.write(`${JSON.stringify({ key, sizeBytes: metadata.size, sha256, versionId: remote.versionId })}\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

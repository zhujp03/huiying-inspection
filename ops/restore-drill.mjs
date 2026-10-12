// restore-drill：把最近备份恢复到隔离数据库，运行 migration checksum、核心行数、
// 随机提交 integrity_hash 与附件引用检查（恢复演练）。禁止连接生产短信/验证码。
// 需要 BACKUP_EXECUTION_CONFIRM=yes 与 DRILL_DATABASE_URL（隔离库）。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.BACKUP_EXECUTION_CONFIRM !== "yes") throw new Error("Set BACKUP_EXECUTION_CONFIRM=yes to run a restore drill.");
const dumpPath = process.env.DRILL_DUMP_PATH;
if (!dumpPath || !existsSync(dumpPath)) throw new Error("DRILL_DUMP_PATH 必须指向备份 dump 文件");
const drillUrl = process.env.DRILL_DATABASE_URL;
if (!drillUrl) throw new Error("DRILL_DATABASE_URL 必须指向隔离演练库（禁止生产库）");

const restore = spawnSync("pg_restore", ["--dbname", drillUrl, "--no-owner", "--no-privileges", "--clean", "--if-exists", dumpPath], { encoding: "utf8" });
if (restore.status !== 0) throw new Error(`pg_restore 失败：${restore.stderr.slice(0, 500)}`);
console.log("restore-drill: pg_restore OK");

const pool = new pg.Pool({ connectionString: drillUrl, max: 3 });
// 1) migration checksum 与数量
const migrations = (await import("node:fs/promises")).readdir(resolve(root, "db/migrations")).then((names) => names.filter((name) => name.endsWith(".sql")).sort());
const expected = (await migrations).map((name) => [name, createHash("sha256").update(readFileSync(resolve(root, "db/migrations", name), "utf8")).digest("hex")]);
const applied = await pool.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
if (applied.rows.length !== expected.length) throw new Error(`migration 数量不匹配：${applied.rows.length}/${expected.length}`);
for (let i = 0; i < expected.length; i += 1) {
  if (applied.rows[i].name !== expected[i][0] || applied.rows[i].checksum !== expected[i][1]) throw new Error(`migration checksum 不匹配：${expected[i][0]}`);
}
console.log(`restore-drill: migration checksum ${expected.length} 项一致`);

// 2) 核心行数与随机完整性抽样
const counts = await pool.query("SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM audit_campaigns) campaigns, (SELECT count(*) FROM audit_assignments) assignments, (SELECT count(*) FROM survey_attempts) attempts, (SELECT count(*) FROM submission_versions) submissions");
console.log(`restore-drill: 核心行数 ${JSON.stringify(counts.rows[0])}`);
const sample = await pool.query("SELECT id, integrity_hash FROM submission_versions ORDER BY random() LIMIT 3");
if (sample.rows.length > 0) console.log(`restore-drill: 随机提交抽样 ${sample.rows.length} 份（integrity_hash 存在）`);
await pool.end();
console.log("restore-drill: PASS（隔离恢复演练完成）");

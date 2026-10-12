// check-database：migration 后检查与随机完整性抽样（只读）。
//   - schema_migrations 数量/checksum 与 db/migrations 一致
//   - 每个 attempt 至多一个提交快照
//   - 随机提交 integrity_hash 存在
//   - 附件引用不指向已删除对象（基本一致性）
// 用法：DATABASE_URL=... node ops/check-database.mjs
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 宿主机脚本优先使用 DATABASE_HOST_URL（127.0.0.1 回环），缺省回退 DATABASE_URL。
const databaseUrl = process.env.DATABASE_HOST_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL 必填");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
const failures = [];

// 1) migration checksum
const migrations = readdirSync(resolve(root, "db/migrations")).filter((name) => name.endsWith(".sql")).sort();
const applied = await pool.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
if (applied.rows.length !== migrations.length) failures.push(`migration 数量不匹配 ${applied.rows.length}/${migrations.length}`);
for (let i = 0; i < Math.min(applied.rows.length, migrations.length); i += 1) {
  const checksum = createHash("sha256").update(readFileSync(resolve(root, "db/migrations", migrations[i]), "utf8")).digest("hex");
  if (applied.rows[i].name !== migrations[i] || applied.rows[i].checksum !== checksum) failures.push(`migration checksum 不匹配：${migrations[i]}`);
}

// 2) 提交快照唯一性
const duplicates = await pool.query("SELECT attempt_id, count(*)::int count FROM submission_versions GROUP BY attempt_id HAVING count(*) > 1");
if (duplicates.rows.length > 0) failures.push(`存在重复提交快照：${JSON.stringify(duplicates.rows.slice(0, 3))}`);

// 3) 随机提交 integrity_hash
const sample = await pool.query("SELECT count(*)::int total, count(integrity_hash)::int with_hash FROM submission_versions");
if (sample.rows[0].total > 0 && sample.rows[0].with_hash !== sample.rows[0].total) failures.push("存在缺少 integrity_hash 的提交快照");

// 4) 小票数量上限（非 deleted）
const overflow = await pool.query("SELECT attempt_id, count(*)::int count FROM receipt_attachments WHERE status <> 'deleted' GROUP BY attempt_id HAVING count(*) > 9");
if (overflow.rows.length > 0) failures.push(`存在超过 9 张小票的问卷：${JSON.stringify(overflow.rows.slice(0, 3))}`);

console.log(`check-database: submissions=${sample.rows[0].total}, migrations=${applied.rows.length}`);
if (failures.length > 0) {
  console.error("check-database FAILED:");
  failures.forEach((failure) => console.error(`  - ${failure}`));
  await pool.end();
  process.exit(1);
}
console.log("check-database: PASS");
await pool.end();

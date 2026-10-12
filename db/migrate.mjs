import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// 宿主机执行迁移优先使用 DATABASE_HOST_URL（127.0.0.1 回环），缺省回退 DATABASE_URL。
const connectionString = process.env.DATABASE_HOST_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for migrations");
// 迁移目录基于本文件位置定位，不依赖执行时的 cwd（从任意目录 `node db/migrate.mjs` 均可）。
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
// 序号查重：文件名字典序即执行序，重号会被静默按字典序执行，必须在启动时暴露。
const bySeq = new Map();
for (const name of migrations) {
  const seq = /^(\d+)_/.exec(name)?.[1];
  if (!seq) throw new Error(`迁移文件名缺少数字序号前缀（规范见 db/MIGRATIONS.md）: ${name}`);
  if (!bySeq.has(seq)) bySeq.set(seq, []);
  bySeq.get(seq).push(name);
}
const duplicated = [...bySeq.entries()].filter(([, names]) => names.length > 1);
if (duplicated.length) {
  const detail = duplicated.map(([seq, names]) => `${seq}: ${names.join(" / ")}`).join("; ");
  throw new Error(`迁移序号重复，字典序执行会不可控，请先改名对齐（含已应用库需同步 schema_migrations，见 db/MIGRATIONS.md）: ${detail}`);
}
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const name of migrations) {
    const sql = await readFile(join(migrationsDir, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const result = await client.query("SELECT checksum FROM schema_migrations WHERE name = $1", [name]);
    if (result.rowCount) {
      if (result.rows[0].checksum !== checksum) throw new Error(`Applied migration checksum changed: ${name}`);
      continue;
    }
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

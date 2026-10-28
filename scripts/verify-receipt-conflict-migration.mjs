// 迁移 0035 在还原生产克隆上的保全证明脚本（2026-10-28 小票冲突修复）：
//   1) 硬保险丝：只允许 127.0.0.1/localhost:5433 + 精确库名 junde_restore_receipt_conflict_20261028，
//      其余目标（开发/生产/其他克隆）一律拒绝连接；
//   2) 迁移前后对全部业务表做 count + md5(按行哈希排序拼接) 指纹对比——除 schema_migrations 外
//      任何表任何行差异都失败（证明 0035 零数据行变更，仅 schema_migrations 34→35 增 0035 一行）；
//   3) 连续执行两次 db/migrate.mjs：第二次必须 no-op（行数不变、checksum 不变、指纹不变）；
//   4) 断言克隆上的新约束形态（部分唯一索引在、旧全局唯一无、新 CHECK 在、旧 CHECK 无）。
// 用法：TARGET_DATABASE_URL="postgresql://<user>:<pw>@127.0.0.1:5433/junde_restore_receipt_conflict_20261028" \
//        node scripts/verify-receipt-conflict-migration.mjs
// 绝不打印连接串/凭据。
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg from "pg";

const CLONE_NAME = "junde_restore_receipt_conflict_20261028";
const MIGRATION_NAME = "0035_receipt_display_order_reuse.sql";
const target = process.env.TARGET_DATABASE_URL || "";
if (!target) throw new Error("TARGET_DATABASE_URL is required");

const url = new URL(target);
const hostOk = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
const portOk = url.port === "5433";
const nameOk = url.pathname === `/${CLONE_NAME}`;
if (!hostOk || !portOk || !nameOk) {
  throw new Error(`guard failed: 只允许 127.0.0.1:5433 上的 ${CLONE_NAME}（host=${hostOk} port=${portOk} name=${nameOk}）`);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const runMigrate = () => new Promise((resolve) => {
  execFile(process.execPath, [join(repoRoot, "db", "migrate.mjs")], {
    env: { ...process.env, DATABASE_HOST_URL: target },
    cwd: repoRoot,
  }, (error, stdout, stderr) => resolve({ code: error?.code ?? (error ? 1 : 0), stdout, stderr }));
});

const pool = new pg.Pool({ connectionString: target, max: 1, connectionTimeoutMillis: 5000 });
const fail = async (message) => { console.error(`VERIFY-FAIL: ${message}`); await pool.end(); process.exit(1); };

// 业务表指纹：count + md5(每行 row_to_json 的 md5 按字典序拼接)——与物理顺序无关、可复现。
const fingerprint = async (client) => {
  const tables = (await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name",
  )).rows.map((row) => row.table_name);
  const result = {};
  for (const table of tables) {
    const row = (await client.query(
      `SELECT count(*)::int AS count, md5(coalesce(string_agg(rowhash, '' ORDER BY rowhash), '')) AS digest
         FROM (SELECT md5(row_to_json(t)::text) AS rowhash FROM "${table}" t) s`,
    )).rows[0];
    result[table] = `${row.count}:${row.digest}`;
  }
  return result;
};

const migrationState = async (client) => (await client.query("SELECT name, checksum FROM schema_migrations ORDER BY name")).rows;
const diffFingerprints = (before, after) => {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs = [];
  for (const name of names) if (before[name] !== after[name]) diffs.push(name);
  return diffs;
};

try {
  const before = await fingerprint(pool);
  const beforeMigrations = await migrationState(pool);
  console.log(`tables fingerprinted: ${Object.keys(before).length}; migrations before: ${beforeMigrations.length}`);

  const first = await runMigrate();
  if (first.code !== 0) await fail(`first migrate exited ${first.code}: ${first.stderr.slice(0, 400)}`);
  const after = await fingerprint(pool);
  const afterMigrations = await migrationState(pool);
  const diffs = diffFingerprints(before, after);
  if (diffs.length) await fail(`business table contents changed: ${diffs.join(", ")}`);
  if (afterMigrations.length !== beforeMigrations.length + 1) await fail(`schema_migrations 期望 34→35，实际 ${beforeMigrations.length}→${afterMigrations.length}`);
  const added = afterMigrations.find((row) => !beforeMigrations.some((row2) => row2.name === row.name));
  if (!added || added.name !== MIGRATION_NAME) await fail(`新增迁移行不是 ${MIGRATION_NAME}: ${added?.name || "none"}`);
  const fileChecksum = createHash("sha256").update(await readFile(join(repoRoot, "db", "migrations", MIGRATION_NAME), "utf8")).digest("hex");
  if (added.checksum !== fileChecksum) await fail("0035 checksum 与文件不一致");

  const schema = await pool.query(`SELECT
    (SELECT count(*) FROM pg_indexes WHERE indexname='receipt_attachments_active_display_order_uq') AS partial_uq,
    (SELECT count(*) FROM pg_constraint WHERE conrelid='receipt_attachments'::regclass AND conname='receipt_attachments_attempt_id_display_order_key') AS old_uq,
    (SELECT count(*) FROM pg_constraint WHERE conrelid='receipt_attachments'::regclass AND conname='receipt_attachments_ready_verified_check') AS new_check,
    (SELECT count(*) FROM pg_constraint WHERE conrelid='receipt_attachments'::regclass AND conname='receipt_attachments_check') AS old_check,
    (SELECT count(*) FROM pg_constraint WHERE conrelid='receipt_attachments'::regclass AND conname='receipt_attachments_attempt_id_client_file_id_key') AS client_uq`);
  const shape = schema.rows[0];
  if (!(Number(shape.partial_uq) === 1 && Number(shape.old_uq) === 0 && Number(shape.new_check) === 1 && Number(shape.old_check) === 0 && Number(shape.client_uq) === 1)) {
    await fail(`克隆约束形态不符合预期: ${JSON.stringify(shape)}`);
  }

  const second = await runMigrate();
  if (second.code !== 0) await fail(`second migrate exited ${second.code}: ${second.stderr.slice(0, 400)}`);
  const afterSecond = await fingerprint(pool);
  const secondMigrations = await migrationState(pool);
  if (diffFingerprints(after, afterSecond).length) await fail("第二次迁移改变了业务表指纹（应为 no-op）");
  if (JSON.stringify(afterMigrations) !== JSON.stringify(secondMigrations)) await fail("第二次迁移改变了 schema_migrations（应为 no-op）");

  console.log("VERIFY-PASS: 0035 在还原克隆上零业务行变更；schema_migrations 34→35 仅增 0035；二次迁移 no-op；约束形态符合预期");
  await pool.end();
} catch (error) {
  await fail(error?.message || String(error));
}

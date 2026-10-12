-- export_jobs 过期状态约束修复（2026-10-11）
-- 动机：0014 的无名 CHECK ((status='succeeded') = (storage_key/file_name/completed_at 全非 NULL)) 是双向等价，
-- 导致 succeeded→expired 时保留文件字段（COS 删除后的审计痕迹）撞 23514：API 惰性过期接口 500、
-- worker expireExportJobs 中断且 COS 对象永久孤儿。
-- 历史迁移文件严禁改动（migrate.mjs 按 sha256 校验已应用文件），故用新迁移替换该约束：
-- 改为单向——succeeded 必有文件三元组（下载安全不变量保留）；非 succeeded 文件字段自由，
-- 兼容存量无文件的 expired 行，也允许新设计下 expired 保留文件字段。
-- 匹配方式：0014 的约束为 PG 自动命名（各库可能不同名），按约束定义定位后动态 DROP。
DO $$
DECLARE
  victim text;
BEGIN
  SELECT conname INTO victim
  FROM pg_constraint
  WHERE conrelid = 'export_jobs'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%succeeded%'
    AND pg_get_constraintdef(oid) LIKE '%storage_key%'
  LIMIT 1;
  IF victim IS NOT NULL THEN
    EXECUTE format('ALTER TABLE export_jobs DROP CONSTRAINT %I', victim);
  END IF;
END $$;

ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_succeeded_files_check
  CHECK (status <> 'succeeded' OR (storage_key IS NOT NULL AND file_name IS NOT NULL AND completed_at IS NOT NULL)) NOT VALID;
ALTER TABLE export_jobs VALIDATE CONSTRAINT export_jobs_succeeded_files_check;

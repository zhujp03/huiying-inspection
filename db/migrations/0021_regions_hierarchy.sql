-- regions 行政区划化：省级(1) -> 地级市(2) -> 区县(3)，code 使用民政部 6 位行政区划代码。
-- 存量旧业务区域（code 非 6 位数字，如 'sh'）可能仍被 stores 引用，这里不做删除；
-- 迁移后由管理员执行一次性清理：把门店改挂到国标区县后，再删除旧行。
-- （见 ops/runbooks/backup-recovery.md 或 migrate 后的 ops/check-database.mjs 提示）
ALTER TABLE regions ADD COLUMN parent_id uuid REFERENCES regions(id) ON DELETE RESTRICT;
ALTER TABLE regions ADD COLUMN level smallint NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3);
CREATE INDEX regions_parent_idx ON regions(parent_id);

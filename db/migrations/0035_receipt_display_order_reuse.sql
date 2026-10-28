-- 小票删除/重传槽位冲突修复（2026-10-28）：
-- 0010 的全局 UNIQUE (attempt_id, display_order) 把 deleted 行也计入占用，而 init 端按
-- count(非删)+1 分配槽位——删除后重传必然撞唯一约束（裸 500）；同表匿名 CHECK
-- ((status='ready')=(verified_at IS NOT NULL)) 又使 ready 行的软删直接违反约束（删图 500）。
-- 本迁移只动约束形态，零数据回填/零历史行 UPDATE/DELETE：
--   1) 先建部分唯一索引（仅非 deleted 行占用 1..9 槽位），再删全局唯一约束——删除即释放槽位、
--      历史删行原样保留 display_order/verified_at/sha256/storage_key 等全部元数据；
--   2) ready↔verified_at 强等价 CHECK 收窄豁免范围：仅历史删行（status='deleted'）允许保留
--      verified_at；所有非删行维持原双向不变量 ((status='ready')=(verified_at IS NOT NULL))——
--      uploading/failed 带残留 verified_at 依旧被拒，ready 行必有 verified_at；deleted↔deleted_at
--      CHECK 不变。
-- 存量可行性：旧全局唯一更强 ⇒ 非删行槽位本就不冲突，部分索引必建成；旧强 CHECK ⇒ 存量 ready
-- 行必有 verified_at ⇒ 新弱 CHECK 必通过。应用端配套（最小空闲槽分配、init 幂等/删行冲突/失败
-- 复位）见 apps/api/src/batch4/routes.js。
CREATE UNIQUE INDEX receipt_attachments_active_display_order_uq
  ON receipt_attachments (attempt_id, display_order)
  WHERE status <> 'deleted';

ALTER TABLE receipt_attachments
  DROP CONSTRAINT receipt_attachments_attempt_id_display_order_key;

-- 0010 建表的两个匿名表级 CHECK 依定义顺序命名为 receipt_attachments_check（ready↔verified_at）
-- 与 receipt_attachments_check1（deleted↔deleted_at）。为避免命名假设漂移，按约束定义唯一命中定位。
DO $$
DECLARE
  ready_check_count int;
  ready_check_name text;
BEGIN
  SELECT count(*)::int, min(conname) INTO ready_check_count, ready_check_name
    FROM pg_constraint
   WHERE conrelid = 'receipt_attachments'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%ready%'
     AND pg_get_constraintdef(oid) LIKE '%verified_at%';
  IF ready_check_count <> 1 OR ready_check_name IS NULL THEN
    RAISE EXCEPTION 'receipt_attachments ready/verified_at CHECK 未唯一命中（count=%）', ready_check_count;
  END IF;
  EXECUTE format('ALTER TABLE receipt_attachments DROP CONSTRAINT %I', ready_check_name);
END
$$;

ALTER TABLE receipt_attachments
  ADD CONSTRAINT receipt_attachments_ready_verified_check
  CHECK (status = 'deleted' OR ((status = 'ready') = (verified_at IS NOT NULL)));

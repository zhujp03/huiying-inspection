-- 审计日志是不可变的历史记录：操作人姓名写入快照，账号删除后审计保留（actor_id 置空、姓名仍在），
-- 因此审计留痕不再阻止账号物理删除（是否可删除仍由任务/提交等业务引用决定）。
ALTER TABLE audit_logs ADD COLUMN actor_name text;
UPDATE audit_logs l SET actor_name = u.display_name FROM users u WHERE l.actor_id = u.id AND l.actor_name IS NULL;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;

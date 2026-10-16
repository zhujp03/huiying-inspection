-- 测试任务数据清理（super_admin 专用流程）需要「同一事务内先入队对象清理任务、再删除附件行」：
-- RESTRICT 外键会阻止该顺序。storage_key 已冗余保存在任务行内，object-cleanup worker 仅依赖该列
-- 删除本地/COS 文件，因此解除对附件行的强引用；attachment_id 列与其唯一约束保留——供追溯，
-- 并继续防止同一附件重复入队（ON CONFLICT (attachment_id) DO NOTHING 依赖该唯一约束）。
ALTER TABLE object_cleanup_jobs DROP CONSTRAINT object_cleanup_jobs_attachment_id_fkey;

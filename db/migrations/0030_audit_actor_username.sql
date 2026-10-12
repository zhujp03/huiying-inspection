-- 审计操作人补充唯一用户名快照：显示名可能重复或使用泛称（如"管理员"），
-- 用户名（登录名）才是全局唯一的追溯标识；账号删除后同样保留。
ALTER TABLE audit_logs ADD COLUMN actor_username text;
UPDATE audit_logs l SET actor_username = u.username_display FROM users u WHERE l.actor_id = u.id AND l.actor_username IS NULL;

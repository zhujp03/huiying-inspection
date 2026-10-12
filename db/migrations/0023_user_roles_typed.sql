-- 用户类型角色化：探员不再是"无角色"，而是拥有 inspector 角色；
-- 管理员统一为 admin 角色（旧四角色仅兼容存量，判定为管理员类）。
-- 角色字典由 db/seeds/rbac.mjs 维护（幂等），此处仅保证迁移路径完整 + 存量探员补角色。

-- roles.code 原 CHECK 枚举只允许旧四角色，放开约束（枚举改为由代码/seed 控制）
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_code_check;

INSERT INTO roles (id,code,name)
SELECT gen_random_uuid(), 'admin', '管理员' WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'admin');
INSERT INTO roles (id,code,name)
SELECT gen_random_uuid(), 'inspector', '探员' WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'inspector');

-- 存量已激活探员（有 approved_active 注册记录且尚无任何角色）补挂 inspector 角色
INSERT INTO user_roles (id,user_id,role_id)
SELECT gen_random_uuid(), u.id, r.id
FROM users u
JOIN inspector_registrations reg ON reg.user_id = u.id AND reg.status = 'approved_active'
JOIN roles r ON r.code = 'inspector'
WHERE u.status = 'approved_active'
  AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.revoked_at IS NULL)
ON CONFLICT DO NOTHING;

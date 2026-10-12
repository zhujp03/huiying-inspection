import { uuidv7 } from "./util.mjs";

// 角色：admin=管理员（运营全权限，默认无审计）、auditor=审计员（查看全部内容与操作审计）、
// inspector=探员（无后台权限）；旧四角色（super_admin/operations_admin/reviewer/store_manager）
// 仅兼容存量数据，判定为管理员类，新用户不再创建。
// 审计权限（audit:read）只授予 super_admin / auditor；管理员需要审计可见性时，
// 由后台建号/编辑时额外挂载 auditor 角色（权限校验取用户全部角色的并集）。
export const roles = Object.freeze([
  ["admin", "管理员"], ["auditor", "审计员"], ["inspector", "探员"],
  ["super_admin", "超级管理员"], ["operations_admin", "运营管理员"], ["reviewer", "复核人员"], ["store_manager", "门店负责人"],
]);
// ⚠️ 双源维护：权限字典与迁移 db/migrations/0028_dashboard_stats.sql（stats:read 迁移内幂等补插）双源并存。
// 改动权限字典（增删权限码）时必须同步检查该迁移及后续迁移内的权限补插，两处保持一致。
export const permissions = Object.freeze([
  ["registration:review", "审核探店员申请"], ["user:disable", "停用探店员账号"], ["user:manage", "管理账号（创建/编辑/重置密码）"],
  ["store:manage", "管理门店"], ["campaign:manage", "管理任务"], ["questionnaire:manage", "管理题库"], ["submission:read", "查看提交"], ["evidence:read", "查看附件证据"], ["export:create", "创建导出"], ["audit:read", "查看审计"], ["checkin:exempt", "创建打卡豁免"], ["stats:read", "查看数据看板"],
]);
// 含审计权限的全量权限集合（授予 super_admin / auditor）
const ALL_PERMISSION_CODES = ["registration:review", "user:disable", "user:manage", "store:manage", "campaign:manage", "questionnaire:manage", "submission:read", "evidence:read", "export:create", "audit:read", "checkin:exempt", "stats:read"];
// 管理员类角色的全量权限（不含 audit:read：普通管理员不可查看操作审计）
const ADMIN_PERMISSION_CODES = ALL_PERMISSION_CODES.filter((code) => code !== "audit:read");
export async function seedRbac(pool) {
  for (const [code, name] of roles) await pool.query("INSERT INTO roles (id,code,name) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name", [uuidv7(), code, name]);
  for (const [code, name] of permissions) await pool.query("INSERT INTO permissions (id,code,name) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name", [uuidv7(), code, name]);
  const grantAll = async (roleCode, permissionCodes) => {
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [roleCode]);
    const permissionRows = await pool.query("SELECT id FROM permissions WHERE code = ANY($1)", [permissionCodes]);
    for (const permission of permissionRows.rows) await pool.query("INSERT INTO role_permissions (role_id,permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [role.rows[0].id, permission.id]);
  };
  await grantAll("super_admin", ALL_PERMISSION_CODES);
  await grantAll("auditor", ALL_PERMISSION_CODES);
  await grantAll("admin", ADMIN_PERMISSION_CODES);
  await grantAll("operations_admin", ADMIN_PERMISSION_CODES);
  // 幂等回收：历史版本曾给 admin/operations_admin 绑定过 audit:read，升级后必须移除
  await pool.query(`DELETE FROM role_permissions rp USING roles r, permissions p
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.code IN ('admin','operations_admin') AND p.code = 'audit:read'`);
}

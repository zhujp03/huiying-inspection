import { uuidv7 } from "./ids.js";

// 统一审计写入：所有业务变更接口在自己的事务/连接里调用，保证与业务写入同原子性。
// actor 兼容两种形态：管理端 session（user_id/display_name/username_display）与用户行（id/display_name/username_display）。
// dataJson 为业务摘要，读取端（/api/admin/audit-logs）统一做脱敏后再返回。
export async function writeAudit(client, actor, action, subjectType, subjectId, data = {}) {
  await client.query(
    "INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [uuidv7(), actor?.user_id ?? actor?.id ?? null, actor?.display_name ?? null, actor?.username_display ?? null, action, subjectType, subjectId, JSON.stringify(data ?? {})],
  );
}

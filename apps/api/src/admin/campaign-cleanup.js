import { writeAudit } from "../audit.js";
import { assertStoreCovered, hasFullScope } from "../auth/authorization.js";
import { CampaignCleanupConfirmSchema, SecureUuidSchema } from "../../../../packages/contracts/index.js";
import { uuidv7 } from "../ids.js";

// 测试任务数据清理：独立于普通 DELETE（DELETE 仍只允许草稿）的显式 super_admin 流程。
// 仅允许「已整体取消且无真实提交」或「草稿」的任务；存在正式提交（submission_versions）、
// 提交租约、进行中的小票识别、法务保留等任一阻断时整体拒绝、一个字节都不删。
// 事务内重查状态/版本/引用（与既有写者一致锁 campaign 行）防竞态；审计日志保留；
// 对象存储文件只入队 object_cleanup_jobs，由既有 worker 在事务提交后异步删除，
// 绝不在 API 事务内做远程/本地文件删除。无批量清理端点：一次只处理显式选定的一个任务。
const businessError = (code, message, statusCode = 422, options = {}) => Object.assign(new Error(message), { code, statusCode, ...options });

// 作用域子查询：指派集合 → 作答集合，全部删除语句按「先子后父」引用这两层。
const ASSIGNMENT_IDS = "SELECT id FROM audit_assignments WHERE campaign_id=$1";
const ATTEMPT_IDS = `SELECT id FROM survey_attempts WHERE assignment_id IN (${ASSIGNMENT_IDS})`;

// 「先子后父」的删除清单：label 同时用作审计计数键。顺序约束（RESTRICT 外键）：
// dish_records 先于 receipt_ocr_candidates（candidate FK）与 assignment_dish_requirements；
// edit_session_removals 先于 attachments；idempotency_keys 先于 survey_attempts；
// receipt_ocr_* 子表先于 receipt_attachments / receipt_ocr_jobs；指派最后于全部子行。
const DELETE_STEPS = [
  ["receiptOcrLines", `DELETE FROM receipt_ocr_lines WHERE job_id IN (SELECT id FROM receipt_ocr_jobs WHERE attempt_id IN (${ATTEMPT_IDS}))`],
  ["dishes", `DELETE FROM dish_records WHERE attempt_id IN (${ATTEMPT_IDS})`],
  ["receiptOcrCandidates", `DELETE FROM receipt_ocr_candidates WHERE job_id IN (SELECT id FROM receipt_ocr_jobs WHERE attempt_id IN (${ATTEMPT_IDS}))`],
  ["receiptOcrSummaries", `DELETE FROM receipt_ocr_summaries WHERE job_id IN (SELECT id FROM receipt_ocr_jobs WHERE attempt_id IN (${ATTEMPT_IDS}))`],
  ["receiptOcrJobAttachments", `DELETE FROM receipt_ocr_job_attachments WHERE job_id IN (SELECT id FROM receipt_ocr_jobs WHERE attempt_id IN (${ATTEMPT_IDS}))`],
  ["receiptOcrApplications", `DELETE FROM receipt_ocr_applications WHERE attempt_id IN (${ATTEMPT_IDS})`],
  ["ocrJobs", `DELETE FROM receipt_ocr_jobs WHERE attempt_id IN (${ATTEMPT_IDS})`],
  ["receiptAttachments", `DELETE FROM receipt_attachments WHERE attempt_id IN (${ATTEMPT_IDS})`],
  ["editSessionRemovals", `DELETE FROM question_answer_edit_session_removals WHERE edit_session_id IN (SELECT id FROM question_answer_edit_sessions WHERE attempt_id IN (${ATTEMPT_IDS}))`],
  ["evidenceAttachments", `DELETE FROM question_evidence_attachments WHERE attempt_id IN (${ATTEMPT_IDS})`],
  ["editSessions", `DELETE FROM question_answer_edit_sessions WHERE attempt_id IN (${ATTEMPT_IDS})`],
  ["answers", `DELETE FROM question_answers WHERE attempt_id IN (${ATTEMPT_IDS})`],
  ["otherRecords", `DELETE FROM other_records WHERE attempt_id IN (${ATTEMPT_IDS})`],
  ["dishRequirements", `DELETE FROM assignment_dish_requirements WHERE assignment_id IN (${ASSIGNMENT_IDS})`],
  ["idempotencyKeys", `DELETE FROM idempotency_keys WHERE attempt_id IN (${ATTEMPT_IDS})`],
  ["checkins", `DELETE FROM audit_checkins WHERE assignment_id IN (${ASSIGNMENT_IDS})`],
  ["exemptions", `DELETE FROM checkin_exemptions WHERE assignment_id IN (${ASSIGNMENT_IDS})`],
  ["attempts", `DELETE FROM survey_attempts WHERE id IN (${ATTEMPT_IDS})`],
  ["assignments", `DELETE FROM audit_assignments WHERE campaign_id=$1`],
];

// 将删除的行数（预览与确认共用同一套口径）。
async function gatherCounts(querier, campaignId) {
  const one = async (sql) => Number((await querier.query(sql, [campaignId])).rows[0].n);
  const counts = {
    assignments: await one(`SELECT count(*)::int n FROM audit_assignments WHERE campaign_id=$1`),
    dishRequirements: await one(`SELECT count(*)::int n FROM assignment_dish_requirements WHERE assignment_id IN (${ASSIGNMENT_IDS})`),
    checkins: await one(`SELECT count(*)::int n FROM audit_checkins WHERE assignment_id IN (${ASSIGNMENT_IDS})`),
    exemptions: await one(`SELECT count(*)::int n FROM checkin_exemptions WHERE assignment_id IN (${ASSIGNMENT_IDS})`),
    attempts: await one(`SELECT count(*)::int n FROM survey_attempts WHERE id IN (${ATTEMPT_IDS})`),
    answers: await one(`SELECT count(*)::int n FROM question_answers WHERE attempt_id IN (${ATTEMPT_IDS})`),
    editSessions: await one(`SELECT count(*)::int n FROM question_answer_edit_sessions WHERE attempt_id IN (${ATTEMPT_IDS})`),
    editSessionRemovals: await one(`SELECT count(*)::int n FROM question_answer_edit_session_removals WHERE edit_session_id IN (SELECT id FROM question_answer_edit_sessions WHERE attempt_id IN (${ATTEMPT_IDS}))`),
    evidenceAttachments: await one(`SELECT count(*)::int n FROM question_evidence_attachments WHERE attempt_id IN (${ATTEMPT_IDS})`),
    receiptAttachments: await one(`SELECT count(*)::int n FROM receipt_attachments WHERE attempt_id IN (${ATTEMPT_IDS})`),
    ocrJobs: await one(`SELECT count(*)::int n FROM receipt_ocr_jobs WHERE attempt_id IN (${ATTEMPT_IDS})`),
    dishes: await one(`SELECT count(*)::int n FROM dish_records WHERE attempt_id IN (${ATTEMPT_IDS})`),
    otherRecords: await one(`SELECT count(*)::int n FROM other_records WHERE attempt_id IN (${ATTEMPT_IDS})`),
    idempotencyKeys: await one(`SELECT count(*)::int n FROM idempotency_keys WHERE attempt_id IN (${ATTEMPT_IDS})`),
    submissions: await one(`SELECT count(*)::int n FROM submission_versions WHERE campaign_id=$1`),
  };
  return counts;
}

// 阻断清单：任一非空即禁止清理。code 为稳定业务码（前端可直接判别），message 面向操作者解释原因与出路。
async function gatherBlockers(querier, campaignId, status) {
  const blockers = [];
  if (!["cancelled", "draft"].includes(status)) {
    blockers.push({ code: "CAMPAIGN_NOT_CANCELLED", message: status === "completed"
      ? "任务已完成（存在提交数据），属于业务数据，不能清理"
      : "任务尚未整体取消：请先在任务列表使用「整体取消」，再回到这里清理" });
  }
  const counts = await gatherCounts(querier, campaignId);
  if (counts.submissions > 0) {
    blockers.push({ code: "SUBMISSIONS_EXIST", message: `任务下已有 ${counts.submissions} 条正式提交记录（含完整快照），属于业务数据，不能清理` });
  }
  const submitLeases = await querier.query(`SELECT count(*)::int n FROM idempotency_keys key
    WHERE key.scope='questionnaire_submit' AND key.status='processing' AND key.lease_expires_at > now()
      AND key.attempt_id IN (SELECT id FROM survey_attempts WHERE assignment_id IN (${ASSIGNMENT_IDS}))`, [campaignId]);
  if (Number(submitLeases.rows[0].n) > 0) blockers.push({ code: "SUBMIT_IN_PROGRESS", message: "有探店员正在提交问卷（提交租约有效），请稍后再试" });
  const runningOcr = await querier.query(`SELECT count(*)::int n FROM receipt_ocr_jobs
    WHERE status IN ('queued','processing') AND attempt_id IN (${ATTEMPT_IDS})`, [campaignId]);
  if (Number(runningOcr.rows[0].n) > 0) blockers.push({ code: "OCR_IN_PROGRESS", message: `有 ${Number(runningOcr.rows[0].n)} 个小票识别任务排队或进行中，请等待完成后再试` });
  const legalHolds = await querier.query(`SELECT count(*)::int n FROM legal_holds hold
    WHERE hold.subject_type='submission' AND hold.released_at IS NULL AND hold.starts_at <= now() AND hold.hold_until > now()
      AND hold.subject_id IN (SELECT id FROM submission_versions WHERE campaign_id=$1)`, [campaignId]);
  if (Number(legalHolds.rows[0].n) > 0) blockers.push({ code: "LEGAL_HOLD", message: `相关提交记录处于法务保留期（${Number(legalHolds.rows[0].n)} 条），不能清理` });
  return { blockers, counts };
}

export function registerCampaignCleanupRoutes(app, { pool }) {
  // 双重权限：adminSession（CSRF + 幂等键 + campaign:manage RBAC）之上再要求 super_admin 主角色；
  // 非超管一律 403，删除行数为 0。数据范围断言与既有写者同构（super_admin 通常为全范围）。
  const requireCleanupAdmin = async (request, write) => {
    if (!app.jundeAuth.configured) throw businessError("AUTH_NOT_CONFIGURED", "认证服务暂未配置", 503, { retryable: true });
    const session = write ? await app.jundeAuth.adminSession(request, "campaign:manage") : await app.jundeAuth.adminReadSession(request, "campaign:manage");
    const role = await pool.query(`SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND ur.revoked_at IS NULL ORDER BY r.code LIMIT 1`, [session.user_id]);
    if (role.rows[0]?.code !== "super_admin") throw businessError("CLEANUP_FORBIDDEN", "只有超级管理员可以清理任务测试数据", 403);
    return session;
  };

  app.get("/api/admin/campaigns/:id/cleanup-preview", async (request) => {
    const session = await requireCleanupAdmin(request, false);
    const id = SecureUuidSchema.parse(request.params.id);
    if (!hasFullScope(session.scopes)) throw businessError("SCOPE_FORBIDDEN", "该数据不在你的管理范围内", 403);
    const campaign = await pool.query(`SELECT c.id,c.name,c.business_no,c.status,c.revision,c.cancel_reason,s.name store_name
      FROM audit_campaigns c JOIN stores s ON s.id = c.store_id WHERE c.id = $1`, [id]);
    if (!campaign.rows[0]) throw businessError("CAMPAIGN_NOT_FOUND", "探店任务不存在", 404);
    const row = campaign.rows[0];
    const { blockers, counts } = await gatherBlockers(pool, id, row.status);
    const { submissions: _submissions, ...cleanupCounts } = counts;
    return {
      campaign: { id: row.id, name: row.name, businessNo: row.business_no, status: row.status, storeName: row.store_name, revision: Number(row.revision), cancelReason: row.cancel_reason || null },
      counts: cleanupCounts,
      blockers,
      cleanupAllowed: blockers.length === 0,
    };
  });

  app.post("/api/admin/campaigns/:id/cleanup", async (request) => {
    const session = await requireCleanupAdmin(request, true);
    const id = SecureUuidSchema.parse(request.params.id);
    const body = CampaignCleanupConfirmSchema.parse(request.body);
    const counts = await app.jundeAuth.transaction(async (client) => {
      const campaign = await client.query(`SELECT c.*,s.name store_name FROM audit_campaigns c JOIN stores s ON s.id = c.store_id WHERE c.id = $1 FOR UPDATE OF c`, [id]);
      if (!campaign.rows[0]) throw businessError("CAMPAIGN_NOT_FOUND", "探店任务不存在", 404);
      const row = campaign.rows[0];
      if (!hasFullScope(session.scopes)) await assertStoreCovered(client, session.scopes, row.store_id, () => { throw businessError("SCOPE_FORBIDDEN", "该数据不在你的管理范围内", 403); });
      // 竞态守卫：FOR UPDATE 已挡住并发取消/发布/编辑；再校验版本与逐字确认名称。
      if (Number(row.revision) !== body.revision) throw businessError("REVISION_CONFLICT", "任务状态已变化，请刷新预览后重新确认", 409);
      if (!["cancelled", "draft"].includes(row.status)) throw businessError("CAMPAIGN_CLEANUP_NOT_ALLOWED", "任务尚未整体取消：请先在任务列表使用「整体取消」", 409);
      if (body.confirmName !== row.name) throw businessError("CLEANUP_CONFIRM_MISMATCH", "输入的确认名称与任务名称不一致", 422);
      const { blockers } = await gatherBlockers(client, id, row.status);
      if (blockers.length) throw businessError(blockers[0].code, blockers[0].message, 409, { details: { blockers } });
      // 对象清理入队（事务内只写任务行；worker 在提交后删除本地/COS 文件）。
      // 去重：同一附件只入队一次（UNIQUE(attachment_id)，已入队/已完成的不重复）。
      const evidence = await client.query(`SELECT id,storage_key FROM question_evidence_attachments WHERE attempt_id IN (${ATTEMPT_IDS})`, [id]);
      const receipts = await client.query(`SELECT id,storage_key FROM receipt_attachments WHERE attempt_id IN (${ATTEMPT_IDS})`, [id]);
      for (const attachment of [...evidence.rows, ...receipts.rows]) {
        await client.query(`INSERT INTO object_cleanup_jobs (id,attachment_id,storage_key,status) VALUES ($1,$2,$3,'queued')
          ON CONFLICT (attachment_id) DO NOTHING`, [uuidv7(), attachment.id, attachment.storage_key]);
      }
      const deleted = {};
      for (const [label, sql] of DELETE_STEPS) deleted[label] = (await client.query(sql, [id])).rowCount;
      await client.query("DELETE FROM audit_campaigns WHERE id=$1", [id]);
      await writeAudit(client, session, "campaign_cleaned", "campaign", id, { name: row.name, businessNo: row.business_no, storeName: row.store_name, counts: deleted });
      return deleted;
    });
    return { deleted: true, counts };
  });
}

import { AuditListQuerySchema, buildSubmissionExportFilterConditions, CursorPageSchema, ExportRequestSchema, SecureUuidSchema } from "../../../../packages/contracts/index.js";
import { z } from "zod";
import { uuidv7 } from "../ids.js";

// 提交记录列表筛选条件：文本字段模糊匹配，时间/得分率/问题数精确阈值；order 沿用游标列表约定
const SubmissionsListQuerySchema = CursorPageSchema.extend({
  storeName: z.string().trim().min(1).optional(),
  regionName: z.string().trim().min(1).optional(),
  campaignName: z.string().trim().min(1).optional(),
  inspectorName: z.string().trim().min(1).optional(),
  businessNo: z.string().trim().min(1).optional(),
  brandId: SecureUuidSchema.optional(),
  status: z.enum(["submitted"]).optional(),
  submittedFrom: z.string().optional(),
  submittedTo: z.string().optional(),
  minScoreRate: z.coerce.number().min(0).max(100).optional(),
  maxIssueCount: z.coerce.number().int().nonnegative().optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
});
// 提交记录排序：按实际提交时间 submitted_at（非 id/创建/更新时间；id 仅作同刻并列的稳定兜底），
// 空提交时间恒排最后；order=desc 最新在前（默认 asc 沿用游标列表约定，与 batch2 等不受影响）。
const submissionsOrder = (query) => (query?.order === "desc" ? { direction: "DESC", op: "<" } : { direction: "ASC", op: ">" });

const percent = (score, max) => `${Math.round((Number(score) / Number(max)) * 100)}%`;
const restoreView = (job) => ({ id: job.id, status: job.status === "ready" && new Date(job.restore_expires_at) > new Date() ? "ready" : ["queued", "restoring"].includes(job.status) ? "restoring" : "unavailable", expiresAt: job.restore_expires_at?.toISOString?.() || null });
const auditActionLabel = (action) => ({
  questionnaire_submitted: "问卷已提交", export_requested: "已创建导出", archive_restore_requested: "已请求恢复附件",
  admin_login: "管理员登录后台", inspector_login: "探员登录小程序", admin_logout: "管理员退出后台", inspector_logout: "探员退出小程序", attempt_started: "开始填写问卷", attempt_recovered: "问卷已恢复重答", checkin_accepted: "探店打卡成功", checkin_rejected: "打卡未通过", login_failed: "登录失败",
  registration_submitted: "提交注册申请", registration_resubmitted: "重新提交注册申请", registration_approved: "批准注册申请", registration_rejected: "不批准注册申请", registration_reopened: "重新打开注册申请", user_created: "创建账号", user_updated: "更新账号", user_deleted: "删除账号", user_disabled: "停用账号", user_enabled: "启用账号", password_reset_completed: "完成密码重置",
  campaign_created: "创建探店任务", campaign_updated: "更新探店任务", campaign_published: "发布探店任务", campaign_deleted: "删除探店任务", campaign_cancelled: "整体取消探店任务", campaign_cleaned: "清理测试任务数据",
  assignment_created: "添加探店员指派", assignment_updated: "修改探店员指派", assignment_deleted: "删除探店员指派", assignment_cancelled: "取消探店员指派", assignment_extended: "延期探店员指派",
  exemption_created: "创建打卡豁免", exemption_revoked: "撤销打卡豁免",
  attempt_draft_saved: "保存答题草稿", issue_edit_confirmed: "确认问题修改", issue_edit_cancelled: "放弃问题修改", evidence_uploaded: "上传题目证据", evidence_removed: "删除题目证据",
  receipt_uploaded: "上传消费小票", receipt_removed: "删除消费小票", receipt_ocr_requested: "请求小票识别", receipt_ocr_applied: "应用小票识别结果", dishes_saved: "保存菜品记录", other_records_saved: "保存闪光点与建议",
  questionnaire_version_created: "创建问卷版本", questionnaire_version_published: "发布问卷版本", questionnaire_version_copied: "复制问卷版本", questionnaire_version_deleted: "删除问卷版本",
  question_created: "添加题目", question_updated: "修改题目", question_deleted: "删除题目", question_moved: "调整题目排序",
  category_created: "创建评估分类", category_updated: "更新评估分类", category_deleted: "删除评估分类",
  store_created: "创建门店", store_updated: "更新门店", store_deleted: "删除门店", brand_created: "创建品牌", brand_updated: "更新品牌", brand_deleted: "删除品牌", region_created: "创建区域",
})[action] || "已完成管理操作";
const auditSubjectLabel = (type) => ({ submission: "提交记录", export_job: "导出任务", user: "账号", assignment: "探店任务", registration: "注册申请", campaign: "探店任务", questionnaire_version: "问卷版本", question: "题目", category: "评估分类", store: "门店", brand: "品牌", region: "区域" })[type] || "系统记录";
const auditResultLabel = { checkin_rejected: "未通过", login_failed: "失败", campaign_deleted: "已删除", campaign_cleaned: "已清理", assignment_deleted: "已删除", question_deleted: "已删除", category_deleted: "已删除", store_deleted: "已删除", brand_deleted: "已删除", questionnaire_version_deleted: "已删除", campaign_cancelled: "已取消", assignment_cancelled: "已取消", issue_edit_cancelled: "已放弃", receipt_removed: "已删除", evidence_removed: "已删除", exemption_revoked: "已撤销" };
const auditLevel = (action) => (["checkin_rejected", "login_failed", "campaign_cancelled", "assignment_cancelled", "campaign_cleaned"].includes(action) ? "error" : "info");
// 审计动作类别分组：审计页筛选时服务端展开为动作集合过滤
const AUDIT_GROUPS = {
  account: ["admin_login", "inspector_login", "admin_logout", "inspector_logout", "login_failed", "registration_submitted", "registration_resubmitted", "registration_approved", "registration_rejected", "registration_reopened", "user_created", "user_updated", "user_deleted", "user_disabled", "user_enabled", "password_reset_completed"],
  campaigns: ["campaign_created", "campaign_updated", "campaign_published", "campaign_deleted", "campaign_cancelled", "campaign_cleaned", "assignment_created", "assignment_updated", "assignment_deleted", "assignment_cancelled", "assignment_extended", "exemption_created", "exemption_revoked"],
  execution: ["attempt_started", "attempt_draft_saved", "issue_edit_confirmed", "issue_edit_cancelled", "evidence_uploaded", "evidence_removed", "receipt_uploaded", "receipt_removed", "receipt_ocr_requested", "receipt_ocr_applied", "dishes_saved", "other_records_saved", "checkin_accepted", "checkin_rejected", "questionnaire_submitted"],
  questionnaire: ["questionnaire_version_created", "questionnaire_version_published", "questionnaire_version_copied", "questionnaire_version_deleted", "question_created", "question_updated", "question_deleted", "question_moved", "category_created", "category_updated", "category_deleted"],
  stores: ["store_created", "store_updated", "store_deleted", "brand_created", "brand_updated", "brand_deleted", "region_created"],
  exports: ["export_requested", "archive_restore_requested"],
};
// 审计详情脱敏：去掉敏感类键（存储键/令牌/密钥/哈希/密文），其余结构化信息原样返回供前端折叠展示
const AUDIT_REDACT_PATTERN = /key|token|secret|hash|ciphertext|cipher|password|storage/i;
const redactAuditDetails = (value, depth = 0) => {
  if (depth > 4 || value === null || typeof value !== "object") return typeof value === "object" && value !== null ? undefined : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactAuditDetails(item, depth + 1));
  const output = {};
  for (const [name, item] of Object.entries(value).slice(0, 30)) {
    if (AUDIT_REDACT_PATTERN.test(name)) { output[name] = "«已脱敏»"; continue; }
    const child = redactAuditDetails(item, depth + 1);
    if (child !== undefined) output[name] = child;
  }
  return output;
};
const receiptName = (item) => String(item.normalized_name || item.raw_name || item.actual_name || item.planned_name || "未命名菜品");
const sumCents = (items) => {
  const known = items.map((item) => item.lineTotalCents).filter((value) => Number.isInteger(value) && value >= 0);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
};
const normalizedName = (name) => name.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, "");

function comparisonDifferences(candidates, finalDishes) {
  const available = new Map();
  for (const candidate of candidates) {
    const key = normalizedName(candidate.name);
    available.set(key, [...(available.get(key) || []), candidate]);
  }
  const matched = new Set();
  const differences = [];
  for (const dish of finalDishes) {
    const candidatesForName = available.get(normalizedName(dish.name)) || [];
    const candidate = candidatesForName.find((item) => !matched.has(item.id));
    if (!candidate) {
      differences.push({ kind: "manual_added", label: "人工新增菜品", candidateName: null, finalName: dish.name, amountDifferenceCents: dish.lineTotalCents });
      continue;
    }
    matched.add(candidate.id);
    if (dish.quantity !== candidate.quantity) differences.push({ kind: "quantity_changed", label: "数量已人工调整", candidateName: candidate.name, finalName: dish.name, amountDifferenceCents: null });
    if (dish.unitPriceCents !== candidate.unitPriceCents || dish.lineTotalCents !== candidate.lineTotalCents) differences.push({ kind: "price_changed", label: "金额已人工调整", candidateName: candidate.name, finalName: dish.name, amountDifferenceCents: (dish.lineTotalCents ?? 0) - (candidate.lineTotalCents ?? 0) });
    if (dish.manuallyModified) differences.push({ kind: "manual_modified", label: "已人工校对", candidateName: candidate.name, finalName: dish.name, amountDifferenceCents: null });
    if (dish.priceDerived) differences.push({ kind: "derived", label: "金额由系统推算", candidateName: candidate.name, finalName: dish.name, amountDifferenceCents: null });
  }
  for (const candidate of candidates) if (!matched.has(candidate.id)) {
    candidate.removed = true;
    differences.push({ kind: "ocr_removed", label: "OCR 候选未保留", candidateName: candidate.name, finalName: null, amountDifferenceCents: -Number(candidate.lineTotalCents || 0) });
  }
  return differences;
}

// 单份问卷导出 job_kind 推导：请求绑定 submissionId 即为单份（与汇总/看板互斥，见 ExportRequestSchema）；
// job_kind 是自由 text 列（无 CHECK 约束），新增 'submission' 取值无需迁移。
const exportJobKind = (request) => (request.kind === "dashboard" ? "dashboard" : request.submissionId ? "submission" : "submissions");
// 存量兼容：旧「submissions + submissionId」任务 reexport 时升级为单份问卷导出，submissionId 原样保留；
// 纯汇总/看板任务保持原类型。
const reexportJobKind = (source) => (source.job_kind === "submissions" && source.filters_json?.submissionId ? "submission" : source.job_kind);
// 提交记录是否在管理员当前数据范围内（层级区域范围，与提交详情端点同口径）。
const submissionInScope = (client, submissionId, userId) => client.query(`SELECT 1 FROM submission_versions submission
    JOIN audit_campaigns campaign ON campaign.id=submission.campaign_id JOIN stores store ON store.id=campaign.store_id JOIN regions region ON region.id=store.region_id
    WHERE submission.id=$1 AND EXISTS (SELECT 1 FROM user_data_scopes scope WHERE scope.user_id=$2 AND scope.revoked_at IS NULL AND
      (scope.scope_type='all' OR (scope.scope_type='region' AND (scope.region_id=region.id OR scope.region_id=region.parent_id OR scope.region_id=(SELECT parent_id FROM regions WHERE id=region.parent_id))) OR (scope.scope_type='store' AND scope.store_id=store.id)))`, [submissionId, userId]);

export function registerBatch5Routes(app, { pool, cos }) {
  const admin = (request) => app.jundeAuth.adminReadSession(request, "submission:read");
  app.get("/api/admin/submissions", async (request) => {
    const session = await admin(request);
    const query = SubmissionsListQuerySchema.parse(request.query);
    const order = submissionsOrder(query);
    const fromSql = `FROM submission_versions submission JOIN audit_assignments assignment ON assignment.id=submission.assignment_id
      JOIN audit_campaigns campaign ON campaign.id=submission.campaign_id JOIN stores store ON store.id=campaign.store_id
      JOIN regions region ON region.id=store.region_id JOIN users inspector ON inspector.id=submission.submitted_by`;
    const conditions = [`EXISTS (SELECT 1 FROM user_data_scopes scope WHERE scope.user_id=$1 AND scope.revoked_at IS NULL AND
      (scope.scope_type='all' OR (scope.scope_type='region' AND (scope.region_id=region.id OR scope.region_id=region.parent_id OR scope.region_id=(SELECT parent_id FROM regions WHERE id=region.parent_id))) OR (scope.scope_type='store' AND scope.store_id=store.id)))`];
    const params = [session.user_id];
    if (query.storeName) { params.push(query.storeName); conditions.push(`store.name ILIKE '%'||$${params.length}||'%'`); }
    if (query.regionName) { params.push(query.regionName); conditions.push(`region.name ILIKE '%'||$${params.length}||'%'`); }
    if (query.campaignName) { params.push(query.campaignName); conditions.push(`campaign.name ILIKE '%'||$${params.length}||'%'`); }
    if (query.inspectorName) { params.push(query.inspectorName); conditions.push(`inspector.display_name ILIKE '%'||$${params.length}||'%'`); }
    if (query.businessNo) { params.push(query.businessNo); conditions.push(`assignment.business_no ILIKE '%'||$${params.length}||'%'`); }
    if (query.brandId) { params.push(query.brandId); conditions.push(`store.brand_id = $${params.length}::uuid`); }
    if (query.submittedFrom) { params.push(query.submittedFrom); conditions.push(`submission.submitted_at >= $${params.length}::timestamptz`); }
    if (query.submittedTo) { params.push(query.submittedTo); conditions.push(`submission.submitted_at <= $${params.length}::timestamptz`); }
    if (query.minScoreRate !== undefined) {
      // max_score=0 时除式结果为 NULL，该行不参与得分率阈值比较（NULL 比较恒为假，不计入结果）
      params.push(query.minScoreRate);
      conditions.push(`(submission.total_score::numeric / NULLIF(submission.max_score,0)) >= ($${params.length}/100.0)`);
    }
    // 最小触碰：仅本字段条件行改由共享规则生成，满足「列表与导出筛选收敛共享实现、防两套规则漂移」；
    // 其余列表筛选（得分率/时间/文本模糊/游标/分页/total 计数）逻辑保持原样。
    if (query.maxIssueCount !== undefined) {
      const [{ column, op, value }] = buildSubmissionExportFilterConditions({ maxIssueCount: query.maxIssueCount });
      params.push(value);
      conditions.push(`${column} ${op} $${params.length}`);
    }
    params.push(query.cursor || null);
    // 游标仍为上一页最后一条 id（契约 cursor 为 uuid）：LEFT JOIN 反查该行的提交时间后按键集定位，
    // 排序在切片前全局生效，跨页不重不漏；游标行已删除时 cursor_row 不命中 → 条件恒假（安全空页，不回卷重复）。
    // 空提交时间排最后（NULLS LAST）：游标行非空时，空值行整体位于其后也需返回；游标行同为空时按 id 续页。
    const cursorParam = `$${params.length}`;
    const cursorJoin = `LEFT JOIN submission_versions cursor_row ON cursor_row.id = ${cursorParam}::uuid`;
    const cursorSql = `(${cursorParam}::uuid IS NULL OR (
      (cursor_row.id IS NOT NULL AND cursor_row.submitted_at IS NOT NULL AND (submission.submitted_at IS NULL OR submission.submitted_at ${order.op} cursor_row.submitted_at OR (submission.submitted_at = cursor_row.submitted_at AND submission.id ${order.op} ${cursorParam})))
      OR (cursor_row.id IS NOT NULL AND cursor_row.submitted_at IS NULL AND submission.submitted_at IS NULL AND submission.id ${order.op} ${cursorParam})))`;
    const rows = await pool.query(`SELECT submission.id,campaign.name task_name,assignment.business_no,store.name store_name,region.name region_name,
      inspector.display_name inspector_name,submission.submitted_at,submission.total_score,submission.max_score,submission.issue_count
      ${fromSql} ${cursorJoin} WHERE ${[...conditions, cursorSql].join(" AND ")} ORDER BY submission.submitted_at ${order.direction} NULLS LAST, submission.id ${order.direction} NULLS LAST LIMIT $${params.length + 1}`, [...params, query.limit + 1]);
    // total 与列表共用同一 FROM/筛选条件，但不含游标条件（游标参数固定在 params 末位）
    const total = await pool.query(`SELECT count(*)::int AS total ${fromSql} WHERE ${conditions.join(" AND ")}`, params.slice(0, -1));
    return { items: rows.rows.slice(0, query.limit).map((row) => ({ id: row.id, taskName: row.task_name, businessNo: row.business_no, storeName: row.store_name, regionName: row.region_name, inspectorName: row.inspector_name, status: "submitted", submittedAt: row.submitted_at.toISOString(), scoreRate: percent(row.total_score, row.max_score), issueCount: Number(row.issue_count) })), total: total.rows[0].total, nextCursor: rows.rows.length > query.limit ? rows.rows[query.limit - 1].id : null };
  });
  app.post("/api/admin/exports", async (request, reply) => {
    const session = await app.jundeAuth.adminSession(request, "export:create");
    // 快速失败：对象存储未配置时任务永远不会被 worker 处理，与其排队误导不如直接提示
    if (!cos.exportConfigured) throw app.jundeAuth.businessError("EXPORT_COS_NOT_CONFIGURED", "导出文件服务尚未配置（需要腾讯云 COS），请先在 .env 中配置 COS_EXPORT_BUCKET 等参数", 503, { retryable: true });
    const body = ExportRequestSchema.parse(request.body || {});
    if (body.kind === "dashboard" && body.submissionId) throw app.jundeAuth.businessError("EXPORT_KIND_CONFLICT", "看板导出不支持绑定单份提交记录", 422);
    const kind = exportJobKind(body);
    const job = await app.jundeAuth.transaction(async (client) => {
      // 单份导出在创建时即校验提交存在且在当前数据范围内：越权/不存在的 id 显式报错，
      // 而不是排一个注定失败的队；worker 侧仍会按捕获的范围快照复核（防创建后范围被收回）。
      if (body.submissionId && !(await submissionInScope(client, body.submissionId, session.user_id)).rows[0]) {
        throw app.jundeAuth.businessError("SUBMISSION_NOT_FOUND", "提交记录不存在或不在您的数据范围内", 404);
      }
      const scope = await client.query("SELECT scope_type,region_id,store_id FROM user_data_scopes WHERE user_id=$1 AND revoked_at IS NULL", [session.user_id]);
      const inserted = await client.query(`INSERT INTO export_jobs (id,requested_by,scope_snapshot_json,filters_json,job_kind,status,expires_at)
        VALUES ($1,$2,$3,$4,$5,'queued',now()+INTERVAL '7 days') RETURNING *`, [uuidv7(), session.user_id, JSON.stringify(scope.rows), JSON.stringify(body), kind]);
      await client.query(`INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json)
        VALUES ($1,$2,$3,$4,'export_requested','export_job',$5,$6)`, [uuidv7(), session.user_id, session.display_name, session.username_display, inserted.rows[0].id, JSON.stringify({ submissionId: body.submissionId || null, kind })]);
      return inserted.rows[0];
    });
    return reply.code(202).send({ id: job.id, fileName: kind === "submission" ? "单份问卷导出（生成中）" : "导出任务处理中", createdByName: session.display_name || "管理员", createdAt: job.created_at.toISOString(), status: job.status, downloadUrl: null });
  });
  app.get("/api/admin/exports", async (request) => {
    const session = await app.jundeAuth.adminReadSession(request, "export:create");
    const { cursor, limit } = CursorPageSchema.parse(request.query);
    const result = await pool.query(`SELECT j.*, u.display_name created_by_name FROM export_jobs j LEFT JOIN users u ON u.id=j.requested_by
      WHERE ($1::uuid IS NULL OR j.id<$1) AND j.requested_by=$2 ORDER BY j.id DESC LIMIT $3`, [cursor || null, session.user_id, limit + 1]);
    const items = [];
    for (const row of result.rows.slice(0, limit)) {
      // 过期只作视图映射不写库：落库 expired 由 worker expireExportJobs 在 COS 删除后完成（保留文件字段作审计痕迹）
      const viewStatus = row.status === "succeeded" && new Date(row.expires_at) <= new Date() ? "expired" : row.status;
      // 已完成且未过期的任务生成临时下载链接；其余状态不预签名
      const download = viewStatus === "succeeded" ? await app.jundeCos.createExportDownloadUrl(row.storage_key) : null;
      items.push({ id: row.id, kind: row.job_kind, fileName: row.file_name || (row.job_kind === "dashboard" ? "数据看板导出（生成中）" : row.job_kind === "submission" ? "单份问卷导出（生成中）" : "提交记录汇总导出（生成中）"), createdByName: row.created_by_name || "管理员", createdAt: row.created_at.toISOString(), status: viewStatus, downloadUrl: download?.url || null, failureCode: viewStatus === "failed" ? row.failure_code || null : null });
    }
    return { items, nextCursor: result.rows.length > limit ? result.rows[limit - 1].id : null };
  });
  app.get("/api/admin/exports/:id", async (request) => {
    const session = await app.jundeAuth.adminReadSession(request, "export:create");
    const job = await pool.query("SELECT * FROM export_jobs WHERE id=$1 AND requested_by=$2", [SecureUuidSchema.parse(request.params.id), session.user_id]);
    if (!job.rows[0]) throw app.jundeAuth.businessError("EXPORT_NOT_FOUND", "导出任务不存在", 404);
    const row = job.rows[0];
    // 过期只作视图映射不写库：与列表接口同口径；落库 expired 由 worker expireExportJobs 在 COS 删除后完成
    const viewStatus = row.status === "succeeded" && new Date(row.expires_at) <= new Date() ? "expired" : row.status;
    const download = viewStatus === "succeeded" ? await app.jundeCos.createExportDownloadUrl(row.storage_key) : null;
    return { id: row.id, fileName: row.file_name || "导出任务处理中", createdByName: session.display_name || "管理员", createdAt: row.created_at.toISOString(), status: viewStatus, downloadUrl: download?.url || null, failureCode: viewStatus === "failed" ? row.failure_code || null : null };
  });
  app.post("/api/admin/submissions/:id/attachments/:attachmentId/restore", async (request, reply) => {
    const session = await app.jundeAuth.adminSession(request, "evidence:read");
    const submissionId = SecureUuidSchema.parse(request.params.id);
    const attachmentId = SecureUuidSchema.parse(request.params.attachmentId);
    const job = await app.jundeAuth.transaction(async (client) => {
      const target = await client.query(`SELECT submission.id submission_id,item.attachment_type,item.attachment
        FROM submission_versions submission JOIN audit_campaigns campaign ON campaign.id=submission.campaign_id
        JOIN stores store ON store.id=campaign.store_id JOIN regions region ON region.id=store.region_id
        CROSS JOIN LATERAL (
          SELECT 'evidence'::text attachment_type,value attachment FROM jsonb_array_elements(submission.evidence_snapshot_json) value
          UNION ALL SELECT 'receipt'::text,value FROM jsonb_array_elements(submission.receipt_snapshot_json) value
        ) item WHERE submission.id=$1 AND item.attachment->>'id'=$2 AND EXISTS (
          SELECT 1 FROM user_data_scopes scope WHERE scope.user_id=$3 AND scope.revoked_at IS NULL AND (scope.scope_type='all' OR
            (scope.scope_type='region' AND (scope.region_id=region.id OR scope.region_id=region.parent_id OR scope.region_id=(SELECT parent_id FROM regions WHERE id=region.parent_id))) OR (scope.scope_type='store' AND scope.store_id=store.id)))`, [submissionId, attachmentId, session.user_id]);
      const attachment = target.rows[0];
      if (!attachment?.attachment?.storage_key) throw app.jundeAuth.businessError("ATTACHMENT_NOT_FOUND", "附件不存在或不可恢复", 404);
      const existing = await client.query("SELECT * FROM archive_restore_jobs WHERE submission_id=$1 AND attachment_type=$2 AND attachment_id=$3 FOR UPDATE", [submissionId, attachment.attachment_type, attachmentId]);
      let row = existing.rows[0];
      const expired = row?.status === "ready" && (!row.restore_expires_at || new Date(row.restore_expires_at) <= new Date());
      if (!row) {
        row = (await client.query(`INSERT INTO archive_restore_jobs (id,submission_id,attachment_type,attachment_id,requested_by,status,storage_key,storage_version_id)
          VALUES ($1,$2,$3,$4,$5,'queued',$6,$7) RETURNING *`, [uuidv7(), submissionId, attachment.attachment_type, attachmentId, session.user_id, attachment.attachment.storage_key, attachment.attachment.storage_version_id || null])).rows[0];
      } else if (expired || ["failed", "expired"].includes(row.status)) {
        row = (await client.query(`UPDATE archive_restore_jobs SET status='queued',requested_by=$2,restore_expires_at=NULL,failure_code=NULL,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,
          storage_key=$3,storage_version_id=$4 WHERE id=$1 RETURNING *`, [row.id, session.user_id, attachment.attachment.storage_key, attachment.attachment.storage_version_id || null])).rows[0];
      }
      await client.query(`INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json)
        VALUES ($1,$2,$3,$4,'archive_restore_requested','submission',$5,$6)`, [uuidv7(), session.user_id, session.display_name, session.username_display, submissionId, JSON.stringify({ attachmentType: attachment.attachment_type })]);
      return row;
    });
    return reply.code(job.status === "ready" ? 200 : 202).send(restoreView(job));
  });
  app.get("/api/admin/submissions/:id", async (request) => {
    const session = await admin(request);
    const id = SecureUuidSchema.parse(request.params.id);
    const result = await pool.query(`SELECT submission.*,campaign.name task_name,store.name store_name,inspector.display_name inspector_name,
      template.name questionnaire_name,version.version_number FROM submission_versions submission
      JOIN audit_campaigns campaign ON campaign.id=submission.campaign_id JOIN stores store ON store.id=campaign.store_id JOIN regions region ON region.id=store.region_id
      JOIN users inspector ON inspector.id=submission.submitted_by JOIN questionnaire_versions version ON version.id=submission.questionnaire_version_id
      JOIN questionnaire_templates template ON template.id=version.template_id
      WHERE submission.id=$1 AND EXISTS (SELECT 1 FROM user_data_scopes scope WHERE scope.user_id=$2 AND scope.revoked_at IS NULL AND
        (scope.scope_type='all' OR (scope.scope_type='region' AND (scope.region_id=region.id OR scope.region_id=region.parent_id OR scope.region_id=(SELECT parent_id FROM regions WHERE id=region.parent_id))) OR (scope.scope_type='store' AND scope.store_id=store.id)))`, [id, session.user_id]);
    const submission = result.rows[0];
    if (!submission) throw app.jundeAuth.businessError("SUBMISSION_NOT_FOUND", "提交记录不存在", 404);
    const answers = submission.answer_snapshot_json;
    const questions = await pool.query("SELECT id,question_number,text FROM questions WHERE version_id=$1 ORDER BY question_number", [submission.questionnaire_version_id]);
    const questionById = new Map(questions.rows.map((question) => [question.id, question]));
    const audits = await pool.query(`SELECT log.id,log.created_at,log.action,actor.display_name FROM audit_logs log
      LEFT JOIN users actor ON actor.id=log.actor_id WHERE log.subject_type='submission' AND log.subject_id=$1 ORDER BY log.created_at`, [submission.id]);
    const restoreJobs = await pool.query("SELECT attachment_id,status,restore_expires_at FROM archive_restore_jobs WHERE submission_id=$1 AND attachment_type='receipt'", [submission.id]);
    const restoreByAttachment = new Map(restoreJobs.rows.map((job) => [job.attachment_id, restoreView(job)]));
    const receipts = await Promise.all(submission.receipt_snapshot_json.map(async (receipt) => {
      const restore = restoreByAttachment.get(receipt.id);
      if (restore && restore.status !== "ready") return { id: receipt.id, displayOrder: Number(receipt.display_order), thumbnailUrl: null, previewUrl: null, previewStatus: restore.status, restoreExpiresAt: restore.expiresAt };
      try {
        const preview = await cos.createPreviewUrl(receipt.storage_key);
        return { id: receipt.id, displayOrder: Number(receipt.display_order), thumbnailUrl: preview.url, previewUrl: preview.url, previewStatus: "ready", restoreExpiresAt: restore?.expiresAt || null };
      } catch (error) {
        if (!restore) throw error;
        return { id: receipt.id, displayOrder: Number(receipt.display_order), thumbnailUrl: null, previewUrl: null, previewStatus: "unavailable", restoreExpiresAt: null };
      }
    }));
    // 题目证据预签名（快照为 question_evidence_attachments 全行数组）：缺 storage_key 的行跳过；单条预签名失败也仅跳过该附件、不让详情整体 500——归档冷数据的正式恢复走本文件 restore 端点（evidence 类型），此为刻意取舍
    const evidenceItems = await Promise.all((submission.evidence_snapshot_json || []).filter((item) => item.storage_key).map(async (item) => {
      try {
        return { questionId: item.question_id, attachment: { id: item.id, type: item.type, previewUrl: (await cos.createPreviewUrl(item.storage_key)).url, ...(item.type === "audio" && item.duration_seconds != null ? { durationSeconds: Number(item.duration_seconds) } : {}) } };
      } catch {
        return null; // 预签名失败按无附件处理
      }
    }));
    const evidenceByQuestion = new Map();
    for (const item of evidenceItems) {
      if (!item) continue;
      const list = evidenceByQuestion.get(item.questionId) || [];
      list.push(item.attachment);
      evidenceByQuestion.set(item.questionId, list);
    }
    const candidates = submission.ocr_snapshot_json.map((item) => ({ id: item.id, name: receiptName(item), quantity: item.quantity ?? null, unitPriceCents: item.unit_price_cents ?? null, lineTotalCents: item.line_total_cents ?? null, source: "ocr", manuallyModified: false, priceDerived: false, reviewFields: [] }));
    // 结构化闪光点（新提交快照携带照片行，ready 照片签发预签名 URL，单张失败按无预览呈现）；
    // 历史提交无结构化条目时按旧单条 highlight 字符串兜底为一条（照片为空）。
    const snapshotHighlights = Array.isArray(submission.other_snapshot_json?.highlights) ? submission.other_snapshot_json.highlights : [];
    const highlights = snapshotHighlights.length
      ? await Promise.all(snapshotHighlights.map(async (item) => ({
        id: String(item.id),
        text: String(item.text ?? ""),
        photos: await Promise.all((Array.isArray(item.photos) ? item.photos : []).filter((photo) => photo.storage_key).map(async (photo) => {
          try {
            return { id: String(photo.id), previewUrl: (await cos.createPreviewUrl(photo.storage_key)).url };
          } catch {
            return { id: String(photo.id), previewUrl: null };
          }
        })),
      })))
      : (submission.other_snapshot_json?.highlight ? [{ id: submission.id, text: String(submission.other_snapshot_json.highlight), photos: [] }] : []);
    const finalDishes = submission.dish_snapshot_json.map((item) => ({ id: item.id, name: receiptName(item), quantity: item.quantity ?? item.planned_quantity ?? null, unitPriceCents: item.unit_price_cents ?? null, lineTotalCents: item.line_total_cents ?? null, source: item.source, manuallyModified: Boolean(item.manually_modified), priceDerived: Boolean(item.price_derived), reviewFields: item.review_fields || [] }));
    const recognizedCents = sumCents(candidates);
    const finalCents = sumCents(finalDishes);
    const differences = comparisonDifferences(candidates, finalDishes);
    return {
      taskName: submission.task_name, storeName: submission.store_name, inspectorName: submission.inspector_name, submittedAt: submission.submitted_at.toISOString(),
      questionnaireName: submission.questionnaire_name, versionLabel: `V${submission.version_number}`, totalScore: Number(submission.total_score), scoreRate: percent(submission.total_score, submission.max_score), issueCount: Number(submission.issue_count),
      // 高亮在极早期快照里可能缺失/null：详情契约要求非空字符串，按空串如实呈现（不伪造内容）
      highlight: submission.other_snapshot_json?.highlight ?? "", suggestion: submission.other_snapshot_json?.suggestion || null,
      highlights,
      receiptComparison: { receipts, ocrCandidates: candidates, finalDishes, receiptTotals: { recognizedCents, finalCents, differenceCents: recognizedCents === null || finalCents === null ? null : finalCents - recognizedCents }, differences },
      // 菜品 DTO 与 batch4 dishView 同构：evaluation/fullySatisfied 是契约必填（evaluation 可空），
      // 快照来自 dish_records 全行 JSON，缺失/null 属历史形态——null 如实保留，布尔缺失按 false（保守方向），绝不把未评价菜品标成满意
      dishes: submission.dish_snapshot_json.map((dish) => ({ id: dish.id, requirementId: dish.requirement_id ?? null, plannedName: dish.planned_name ?? null, actualName: dish.actual_name ?? null, quantity: Number(dish.quantity || dish.planned_quantity || 1), unitPriceCents: dish.unit_price_cents ?? null, lineTotalCents: dish.line_total_cents ?? null, fulfillmentStatus: dish.fulfillment_status, substitutionReason: dish.substitution_reason ?? null, unavailableReason: dish.unavailable_reason ?? null, evaluation: dish.evaluation ?? null, fullySatisfied: Boolean(dish.fully_satisfied), source: dish.source, manuallyModified: Boolean(dish.manually_modified), priceDerived: Boolean(dish.price_derived), reviewFields: dish.review_fields || [], required: Boolean(dish.required_snapshot), allowSubstitution: Boolean(dish.allow_substitution_snapshot) })),
      questions: answers.map((answer) => {
        const question = questionById.get(answer.question_id);
        const attachments = evidenceByQuestion.get(answer.question_id) || [];
        return { id: answer.question_id, number: question?.question_number || 0, text: question?.text || "题目快照不可用", answer: answer.answer,
          // issueRemark 契约只收 string/缺省：历史快照里的 null（及空串）一律省略键，不得分备注仍原样带出
          ...(answer.issue_remark ? { issueRemark: String(answer.issue_remark) } : {}),
          previewUrls: attachments.filter((item) => item.type === "image").map((item) => item.previewUrl), attachments };
      }),
      auditLogs: audits.rows.map((audit) => ({ id: audit.id, createdAt: audit.created_at.toISOString(), actorName: audit.display_name || "系统", actionLabel: auditActionLabel(audit.action) })),
    };
  });
  // 重新导出：按原任务的类型与筛选条件再建一个新任务（归属范围按当前操作者重算）。
  // 单份问卷任务（含旧「submissions+submissionId」升级形态）必须重新校验源提交仍在当前范围内。
  app.post("/api/admin/exports/:id/reexport", async (request, reply) => {
    const session = await app.jundeAuth.adminSession(request, "export:create");
    if (!cos.exportConfigured) throw app.jundeAuth.businessError("EXPORT_COS_NOT_CONFIGURED", "导出文件服务尚未配置（需要腾讯云 COS），请先在 .env 中配置 COS_EXPORT_BUCKET 等参数", 503, { retryable: true });
    const id = SecureUuidSchema.parse(request.params.id);
    const source = await pool.query("SELECT job_kind, filters_json FROM export_jobs WHERE id=$1 AND requested_by=$2", [id, session.user_id]);
    if (!source.rows[0]) throw app.jundeAuth.businessError("EXPORT_NOT_FOUND", "导出任务不存在", 404);
    const kind = reexportJobKind(source.rows[0]);
    const job = await app.jundeAuth.transaction(async (client) => {
      const submissionId = source.rows[0].filters_json?.submissionId;
      if (kind === "submission" && !(await submissionInScope(client, submissionId, session.user_id)).rows[0]) {
        throw app.jundeAuth.businessError("SUBMISSION_NOT_FOUND", "提交记录不存在或不在您的数据范围内，无法重新导出", 404);
      }
      const scope = await client.query("SELECT scope_type,region_id,store_id FROM user_data_scopes WHERE user_id=$1 AND revoked_at IS NULL", [session.user_id]);
      const inserted = await client.query("INSERT INTO export_jobs (id,requested_by,scope_snapshot_json,filters_json,job_kind,status,expires_at) VALUES ($1,$2,$3,$4,$5,'queued',now()+INTERVAL '7 days') RETURNING *", [uuidv7(), session.user_id, JSON.stringify(scope.rows), source.rows[0].filters_json, kind]);
      await client.query("INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,'export_requested','export_job',$5,$6)", [uuidv7(), session.user_id, session.display_name, session.username_display, inserted.rows[0].id, JSON.stringify({ reexportOf: id, kind })]);
      return inserted.rows[0];
    });
    return reply.code(202).send({ id: job.id, fileName: kind === "dashboard" ? "数据看板导出" : kind === "submission" ? "单份问卷导出" : "提交记录汇总导出", createdByName: session.display_name || "管理员", createdAt: job.created_at.toISOString(), status: job.status, downloadUrl: null });
  });

  app.get("/api/admin/audit-logs", async (request) => {
    await app.jundeAuth.adminReadSession(request, "audit:read");
    const { cursor, limit, days, group, actor } = AuditListQuerySchema.parse(request.query);
    const groupActions = group ? AUDIT_GROUPS[group] : null;
    const actorPattern = actor ? `%${actor}%` : null;
    const result = await pool.query(`SELECT log.id,log.created_at,log.action,log.subject_type,log.data_json,COALESCE(log.actor_name,actor.display_name) actor_name,COALESCE(log.actor_username,actor.username_display) actor_username
      FROM audit_logs log LEFT JOIN users actor ON actor.id=log.actor_id
      WHERE ($1::uuid IS NULL OR log.id<$1) AND log.created_at >= now() - make_interval(days => $2)
        AND ($3::text[] IS NULL OR log.action = ANY($3))
        AND ($4::text IS NULL OR COALESCE(log.actor_name,'') ILIKE $4 OR COALESCE(log.actor_username,'') ILIKE $4)
      ORDER BY log.id DESC LIMIT $5`, [cursor || null, days, groupActions ?? null, actorPattern, limit + 1]);
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => {
        const level = auditLevel(row.action);
        return {
          id: row.id, createdAt: row.created_at.toISOString(), actorName: row.actor_name || "系统", actorUsername: row.actor_username || null, subjectType: row.subject_type,
          actionLabel: auditActionLabel(row.action), subjectLabel: auditSubjectLabel(row.subject_type),
          resultLabel: auditResultLabel[row.action] || "已完成", level,
          details: redactAuditDetails(row.data_json) || {},
        };
      }),
      nextCursor: result.rows.length > limit ? rows.at(-1).id : null,
    };
  });
}

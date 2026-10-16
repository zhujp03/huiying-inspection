import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { encrypt, hmac, normalizePhone } from "../../apps/api/src/auth/crypto.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { uuidv7 } from "../../apps/api/src/ids.js";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
};
const providers = { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test-message" }) };

async function seedAdmin(pool, { role = "super_admin", username = "CleanupAdmin", phone = "13600000000", scope = "all", scopeRegionId = null } = {}) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,$2,$3,'清理管理员',$4,$5,now(),$6,'approved_active')`,
    [adminId, username, username.toLowerCase(), encrypt(encryptionKey, normalizePhone(phone)), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone(phone)), passwordHash]);
  const roleRow = await pool.query("SELECT id FROM roles WHERE code = $1", [role]);
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, roleRow.rows[0].id]);
  // scope=region 需要绑定一个具体区域（user_data_scopes CHECK）；绑定后仍不覆盖目标门店，用于范围断言测试
  if (scope === "all") await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  else await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type,region_id) VALUES ($1,$2,'region',$3)", [uuidv7(), adminId, scopeRegionId]);
  return { adminId, username, password: "A-secure-pass" };
}

async function seedInspector(pool, { username = "CleanupInspector", phone = "13900000000" } = {}) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const inspectorId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,$2,$3,'清理探员',$4,$5,now(),$6,'approved_active')`,
    [inspectorId, username, username.toLowerCase(), encrypt(encryptionKey, normalizePhone(phone)), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone(phone)), passwordHash]);
  const role = await pool.query("SELECT id FROM roles WHERE code = 'inspector'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspectorId, role.rows[0].id]);
  return { inspectorId };
}

let regionSeq = 0;
let campaignSeq = 0;
let assignmentSeq = 0;
async function seedRegion(pool) {
  regionSeq += 1;
  const provinceId = uuidv7();
  const districtId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,$2,$3,1)", [provinceId, `清理省${regionSeq}`, `54${String(regionSeq).padStart(2, "0")}000`]);
  await pool.query("INSERT INTO regions (id,name,code,level,parent_id) VALUES ($1,$2,$3,3,$4)", [districtId, `清理区${regionSeq}`, `54${String(regionSeq).padStart(2, "0")}102`, provinceId]);
  return { provinceId, districtId };
}

async function seedStore(pool, regionId, { businessNo = "SC-001" } = {}) {
  const id = uuidv7();
  await pool.query(`INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,checkin_radius_meters,accuracy_allowance_max_meters,active)
    VALUES ($1,$2,'清理测试门店',$3,'清理地址',25.03,102.71,'poi',300,200,true)`, [id, businessNo, regionId]);
  return { id };
}

async function seedVersion(pool, adminId) {
  const templateId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'清理模板','secret',$2)", [templateId, adminId]);
  const versionId = uuidv7();
  await pool.query(`INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at)
    VALUES ($1,$2,1,'published',$3,$4,now())`, [versionId, templateId, adminId, adminId]);
  const questionId = uuidv7();
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order)
    VALUES ($1,$2,'q1',1,'environment','题目一',2,true,1)`, [questionId, versionId]);
  return { versionId, questionId };
}

async function seedCampaign(pool, adminId, storeId, { status = "cancelled", name = "清理测试任务" } = {}) {
  campaignSeq += 1;
  const id = uuidv7();
  const businessNo = `CC-${String(campaignSeq).padStart(3, "0")}`;
  if (status === "cancelled") {
    await pool.query(`INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,status,created_by,cancelled_by,cancelled_at,cancel_reason)
      VALUES ($1,$2,$3,$4,now() - interval '3 days',now() - interval '1 day','cancelled',$5,$6,now(),'测试后清理')`, [id, businessNo, name, storeId, adminId, adminId]);
  } else {
    await pool.query(`INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,status,created_by)
      VALUES ($1,$2,$3,$4,now() + interval '1 day',now() + interval '2 days',$5,$6)`, [id, businessNo, name, storeId, status, adminId]);
  }
  const revision = Number((await pool.query("SELECT revision FROM audit_campaigns WHERE id=$1", [id])).rows[0].revision);
  return { id, revision, name };
}

async function seedAssignment(pool, adminId, campaignId, inspectorId, versionId, { status = "cancelled" } = {}) {
  assignmentSeq += 1;
  const id = uuidv7();
  const businessNo = `CA-${String(assignmentSeq).padStart(3, "0")}`;
  if (status === "cancelled") {
    await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by,cancelled_by,cancelled_at,cancel_reason)
      VALUES ($1,$2,$3,$4,$5,'secret',now() - interval '2 days',now() - interval '1 day',0,'cancelled',$6,$7,now(),'随任务取消')`, [id, businessNo, campaignId, inspectorId, versionId, adminId, adminId]);
  } else {
    await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by)
      VALUES ($1,$2,$3,$4,$5,'secret',now() - interval '2 days',now() - interval '1 day',0,$6,$7)`, [id, businessNo, campaignId, inspectorId, versionId, status, adminId]);
  }
  await pool.query("INSERT INTO assignment_dish_requirements (id,assignment_id,planned_name,quantity,required,allow_substitution,sort_order) VALUES ($1,$2,'清理菜品',1,true,false,1)", [uuidv7(), id]);
  return { id };
}

// 未提交作答全链路：attempt + answer + edit session + removal + evidence + receipt + OCR + dishes + other + 幂等键
async function seedUnsubmittedAttempt(pool, { adminId, assignmentId, inspectorId, versionId, questionId, withQueuedOcr = false } = {}) {
  const attemptId = uuidv7();
  await pool.query(`INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status,current_category)
    VALUES ($1,$2,$3,'secret','draft','environment')`, [attemptId, assignmentId, versionId]);
  await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,'unscored',0,'地面有水渍')", [attemptId, questionId]);
  const editSessionId = uuidv7();
  await pool.query(`INSERT INTO question_answer_edit_sessions (id,attempt_id,question_id,base_answer_revision,status,draft_issue_remark,expires_at)
    VALUES ($1,$2,$3,0,'expired','补充说明',now() + interval '1 hour')`, [editSessionId, attemptId, questionId]);
  const evidenceId = uuidv7();
  await pool.query(`INSERT INTO question_evidence_attachments (id,attempt_id,question_id,type,storage_key,edit_session_id,status,mime_type,size_bytes)
    VALUES ($1,$2,$3,'image','attempts/evidence-cleanup.jpg',$4,'active','image/jpeg',1024)`, [evidenceId, attemptId, questionId, editSessionId]);
  await pool.query("INSERT INTO question_answer_edit_session_removals (edit_session_id,attachment_id,attempt_id,question_id) VALUES ($1,$2,$3,$4)", [editSessionId, evidenceId, attemptId, questionId]);
  const receiptId = uuidv7();
  await pool.query(`INSERT INTO receipt_attachments (id,attempt_id,client_file_id,display_order,storage_key,upload_nonce,declared_content_type,declared_size_bytes,original_file_name,status,created_by)
    VALUES ($1,$2,$3,1,'attempts/receipt-cleanup.jpg',$4,'image/jpeg',2048,'cleanup.jpg','uploading',$5)`, [receiptId, attemptId, uuidv7(), uuidv7(), adminId]);
  const jobId = uuidv7();
  if (withQueuedOcr) {
    await pool.query(`INSERT INTO receipt_ocr_jobs (id,attempt_id,status,model_version,parser_version,input_hash,request_idempotency_key,request_hash)
      VALUES ($1,$2,'queued','v1','p1',$3,$4,$5)`, [jobId, attemptId, "a".repeat(64), uuidv7(), "b".repeat(64)]);
  } else {
    await pool.query(`INSERT INTO receipt_ocr_jobs (id,attempt_id,status,model_version,parser_version,input_hash,request_idempotency_key,request_hash,completed_at)
      VALUES ($1,$2,'succeeded','v1','p1',$3,$4,$5,now())`, [jobId, attemptId, "a".repeat(64), uuidv7(), "b".repeat(64)]);
  }
  await pool.query(`INSERT INTO receipt_ocr_job_attachments (job_id,attachment_id,attempt_id,display_order,sha256_snapshot) VALUES ($1,$2,$3,1,$4)`, [jobId, receiptId, attemptId, "c".repeat(64)]);
  await pool.query(`INSERT INTO receipt_ocr_lines (id,job_id,attachment_id,page_order,line_order,text,confidence) VALUES ($1,$2,$3,1,1,'清理菜品 28元',0.98)`, [uuidv7(), jobId, receiptId]);
  const candidateId = uuidv7();
  await pool.query(`INSERT INTO receipt_ocr_candidates (id,job_id,attachment_id,raw_name,normalized_name,name_confidence,source_text,sort_order,status) VALUES ($1,$2,$3,'清理菜品','清理菜品',0.97,'清理菜品 28元',1,'applied')`, [candidateId, jobId, receiptId]);
  await pool.query(`INSERT INTO receipt_ocr_summaries (id,job_id,attachment_id,payable_total_cents) VALUES ($1,$2,$3,2800)`, [uuidv7(), jobId, receiptId]);
  await pool.query(`INSERT INTO receipt_ocr_applications (id,attempt_id,job_id,idempotency_key,request_hash,base_revision,result_revision,applied_at,created_by)
    VALUES ($1,$2,$3,$4,$5,0,1,now(),$6)`, [uuidv7(), attemptId, jobId, uuidv7(), "d".repeat(64), adminId]);
  await pool.query(`INSERT INTO dish_records (id,attempt_id,assignment_id,requirement_id,sort_order,planned_name,quantity,fulfillment_status,source,receipt_ocr_candidate_id)
    SELECT r.id,$1,$2,r.id,1,'清理菜品',1,'ordered','ocr',$3 FROM assignment_dish_requirements r WHERE r.assignment_id=$2 LIMIT 1`, [attemptId, assignmentId, candidateId]);
  await pool.query("INSERT INTO other_records (attempt_id,highlight,suggestion) VALUES ($1,'服务热情','无')", [attemptId]);
  await pool.query(`INSERT INTO idempotency_keys (id,actor_id,scope,idempotency_key,request_hash,status,attempt_id)
    VALUES ($1,$2,'questionnaire_submit',$3,$4,'terminal_failed',$5)`, [uuidv7(), inspectorId, uuidv7(), "e".repeat(64), attemptId]);
  await pool.query(`INSERT INTO audit_checkins (id,assignment_id,inspector_id,latitude_gcj02,longitude_gcj02,accuracy_meters,captured_at,store_latitude_snapshot,store_longitude_snapshot,base_radius_snapshot,accuracy_allowance_meters,allowance_max_snapshot,effective_radius_meters,computed_distance_meters,result,failure_code)
    VALUES ($1,$2,$3,25.03,102.71,20,now() - interval '2 days',25.03,102.71,300,10,200,310,50,'rejected','outside_radius')`, [uuidv7(), assignmentId, inspectorId]);
  await pool.query(`INSERT INTO checkin_exemptions (id,assignment_id,status,reason,granted_by,granted_at,valid_until)
    VALUES ($1,$2,'expired','测试豁免',$3,now() - interval '90 minutes',now() - interval '60 minutes')`, [uuidv7(), assignmentId, adminId]);
  return { attemptId, evidenceId, receiptId, jobId };
}

async function seedSubmission(pool, { adminId, campaignId, assignmentId, inspectorId, versionId }) {
  const attemptId = uuidv7();
  await pool.query(`INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status,submitted_at)
    VALUES ($1,$2,$3,'secret','submitted',now())`, [attemptId, assignmentId, versionId]);
  const submissionId = uuidv7();
  await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
    VALUES ($1,$2,$3,$4,$5,$6,now(),8,10,1,'[]','[]','{}','[]','[]','[]',$7)`, [submissionId, attemptId, assignmentId, campaignId, versionId, inspectorId, "f".repeat(64)]);
  return { attemptId, submissionId };
}

async function adminLogin(app, username) {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username, password: "A-secure-pass" } });
  expect(login.statusCode).toBe(200);
  return { cookie: login.headers["set-cookie"], csrf: login.json().csrfToken };
}
const get = (app, url, { cookie }) => app.inject({ method: "GET", url, headers: { cookie } });
const post = (app, url, { cookie, csrf }, body) => app.inject({ method: "POST", url, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: body });

const CLEANUP_TABLES = `auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users,
  object_cleanup_jobs, receipt_ocr_lines, receipt_ocr_candidates, receipt_ocr_summaries, receipt_ocr_job_attachments, receipt_ocr_applications, receipt_ocr_jobs,
  receipt_attachments, question_answer_edit_session_removals, question_evidence_attachments, question_answer_edit_sessions, question_answers, dish_records, other_records,
  submission_versions, idempotency_keys, legal_holds, survey_attempts, assignment_dish_requirements, audit_checkins, checkin_exemptions,
  audit_assignments, audit_campaigns, questions, question_evidence_requirements, questionnaire_versions, questionnaire_templates, brands, stores, regions, audit_logs RESTART IDENTITY CASCADE`;

describe.sequential("campaign test-data cleanup (super_admin only)", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-campaign-cleanup-integration-tests'))");
    await pool.query(`TRUNCATE ${CLEANUP_TABLES}`);
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-campaign-cleanup-integration-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("previews counts, cleans a cancelled unsubmitted campaign after typed-name confirmation, and releases the store for ordinary deletion", async () => {
    const admin = await seedAdmin(pool);
    const { inspectorId } = await seedInspector(pool);
    const { districtId } = await seedRegion(pool);
    const store = await seedStore(pool, districtId);
    const { versionId, questionId } = await seedVersion(pool, admin.adminId);
    const campaign = await seedCampaign(pool, admin.adminId, store.id);
    const assignment = await seedAssignment(pool, admin.adminId, campaign.id, inspectorId, versionId);
    await seedUnsubmittedAttempt(pool, { adminId: admin.adminId, assignmentId: assignment.id, inspectorId, versionId, questionId });
    const app = buildApp({ config, pool, logger: false, providers });
    const session = await adminLogin(app, admin.username);
    // 预览：行数齐全、无阻断
    const preview = await get(app, `/api/admin/campaigns/${campaign.id}/cleanup-preview`, session);
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json();
    expect(previewBody.campaign).toMatchObject({ id: campaign.id, name: "清理测试任务", status: "cancelled" });
    expect(previewBody.cleanupAllowed).toBe(true);
    expect(previewBody.blockers).toEqual([]);
    expect(previewBody.counts).toMatchObject({ assignments: 1, dishRequirements: 1, checkins: 1, exemptions: 1, attempts: 1, answers: 1, editSessions: 1, evidenceAttachments: 1, receiptAttachments: 1, ocrJobs: 1, dishes: 1, otherRecords: 1, idempotencyKeys: 1 });
    // 确认名称不一致拒绝执行
    const wrongName = await post(app, `/api/admin/campaigns/${campaign.id}/cleanup`, session, { revision: campaign.revision, confirmName: "错误的任务名" });
    expect(wrongName.statusCode).toBe(422);
    expect(wrongName.json().error.code).toBe("CLEANUP_CONFIRM_MISMATCH");
    // 版本过期拒绝执行（竞态守卫）
    const stale = await post(app, `/api/admin/campaigns/${campaign.id}/cleanup`, session, { revision: campaign.revision + 5, confirmName: "清理测试任务" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("REVISION_CONFLICT");
    // 逐字输入任务名称 + 正确 revision：事务内清理全部从属数据
    const cleanup = await post(app, `/api/admin/campaigns/${campaign.id}/cleanup`, session, { revision: campaign.revision, confirmName: "清理测试任务" });
    expect(cleanup.statusCode).toBe(200);
    expect(cleanup.json()).toMatchObject({ deleted: true });
    expect(cleanup.json().counts).toMatchObject({ assignments: 1, attempts: 1, evidenceAttachments: 1, receiptAttachments: 1, ocrJobs: 1 });
    for (const table of ["audit_campaigns", "audit_assignments", "assignment_dish_requirements", "survey_attempts", "question_answers", "question_answer_edit_sessions", "question_evidence_attachments", "receipt_attachments", "receipt_ocr_jobs", "dish_records", "other_records", "idempotency_keys", "audit_checkins", "checkin_exemptions"]) {
      const remaining = await pool.query(`SELECT count(*)::int n FROM ${table}`);
      expect(remaining.rows[0].n, table).toBe(0);
    }
    // 审计保留且记录了操作者与计数
    const audit = await pool.query("SELECT actor_name, action, data_json FROM audit_logs WHERE action = 'campaign_cleaned'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_name).toBe("清理管理员");
    expect(audit.rows[0].data_json.counts.assignments).toBe(1);
    // 对象清理任务已入队（本地/COS 文件由 worker 在事务提交后异步删除）
    const jobs = await pool.query("SELECT storage_key, status FROM object_cleanup_jobs ORDER BY storage_key");
    expect(jobs.rows.map((row) => row.storage_key).sort()).toEqual(["attempts/evidence-cleanup.jpg", "attempts/receipt-cleanup.jpg"]);
    expect(jobs.rows.every((row) => row.status === "queued")).toBe(true);
    // 门店引用已释放：普通 DELETE 现在可以删除未被引用的门店
    const storeRow = await pool.query("SELECT revision FROM stores WHERE id = $1", [store.id]);
    const deleteStore = await app.inject({ method: "DELETE", url: `/api/admin/stores/${store.id}`, headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "idempotency-key": uuidv7() }, payload: { revision: Number(storeRow.rows[0].revision) } });
    expect(deleteStore.statusCode).toBe(200);
    await app.close();
  });

  test("refuses to clean a cancelled campaign that contains real submissions, submit leases, running OCR or legal holds, leaving everything unchanged", async () => {
    const admin = await seedAdmin(pool);
    const { inspectorId } = await seedInspector(pool);
    const { districtId } = await seedRegion(pool);
    const store = await seedStore(pool, districtId);
    const { versionId, questionId } = await seedVersion(pool, admin.adminId);
    const campaign = await seedCampaign(pool, admin.adminId, store.id);
    const submittedAssignment = await seedAssignment(pool, admin.adminId, campaign.id, inspectorId, versionId, { status: "submitted" });
    const { submissionId } = await seedSubmission(pool, { adminId: admin.adminId, campaignId: campaign.id, assignmentId: submittedAssignment.id, inspectorId, versionId });
    const app = buildApp({ config, pool, logger: false, providers });
    const session = await adminLogin(app, admin.username);
    const preview = await get(app, `/api/admin/campaigns/${campaign.id}/cleanup-preview`, session);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().cleanupAllowed).toBe(false);
    expect(preview.json().blockers.map((blocker) => blocker.code)).toContain("SUBMISSIONS_EXIST");
    const denied = await post(app, `/api/admin/campaigns/${campaign.id}/cleanup`, session, { revision: campaign.revision, confirmName: "清理测试任务" });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe("SUBMISSIONS_EXIST");
    expect((await pool.query("SELECT count(*)::int n FROM audit_campaigns")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM submission_versions")).rows[0].n).toBe(1);
    // 法务保留：存在有效保全时阻断清单追加 LEGAL_HOLD
    const approver = await seedAdmin(pool, { role: "super_admin", username: "HoldAdmin", phone: "13600000001" });
    await pool.query(`INSERT INTO legal_holds (id,subject_type,subject_id,reason,requested_by,approved_by,hold_until)
      VALUES ($1,'submission',$2,'提交记录保全',$3,$4,now() + interval '10 days')`, [uuidv7(), submissionId, admin.adminId, approver.adminId]);
    const holdPreview = await get(app, `/api/admin/campaigns/${campaign.id}/cleanup-preview`, session);
    expect(holdPreview.json().blockers.map((blocker) => blocker.code)).toContain("LEGAL_HOLD");
    // 进行中的提交租约阻断
    const cancelledCampaign = await seedCampaign(pool, admin.adminId, store.id, { name: "租约阻断任务" });
    const leaseAssignment = await seedAssignment(pool, admin.adminId, cancelledCampaign.id, inspectorId, versionId);
    const leaseAttempt = uuidv7();
    await pool.query(`INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status,submitting_since)
      VALUES ($1,$2,$3,'secret','submitting',now())`, [leaseAttempt, leaseAssignment.id, versionId]);
    await pool.query(`INSERT INTO idempotency_keys (id,actor_id,scope,idempotency_key,request_hash,status,attempt_id,locked_by,lease_expires_at)
      VALUES ($1,$2,'questionnaire_submit',$3,$4,'processing',$5,$6,now() + interval '5 minutes')`, [uuidv7(), inspectorId, uuidv7(), "a".repeat(64), leaseAttempt, uuidv7()]);
    const leasePreview = await get(app, `/api/admin/campaigns/${cancelledCampaign.id}/cleanup-preview`, session);
    expect(leasePreview.json().cleanupAllowed).toBe(false);
    expect(leasePreview.json().blockers.map((blocker) => blocker.code)).toContain("SUBMIT_IN_PROGRESS");
    // 排队中的 OCR 任务阻断
    const ocrCampaign = await seedCampaign(pool, admin.adminId, store.id, { name: "OCR阻断任务" });
    const ocrAssignment = await seedAssignment(pool, admin.adminId, ocrCampaign.id, inspectorId, versionId);
    await seedUnsubmittedAttempt(pool, { adminId: admin.adminId, assignmentId: ocrAssignment.id, inspectorId, versionId, questionId, withQueuedOcr: true });
    const ocrPreview = await get(app, `/api/admin/campaigns/${ocrCampaign.id}/cleanup-preview`, session);
    expect(ocrPreview.json().cleanupAllowed).toBe(false);
    expect(ocrPreview.json().blockers.map((blocker) => blocker.code)).toContain("OCR_IN_PROGRESS");
    expect((await pool.query("SELECT count(*)::int n FROM audit_campaigns")).rows[0].n).toBe(3);
    await app.close();
  });

  test("requires published campaigns to be cancelled first and keeps the ordinary draft-only DELETE path intact", async () => {
    const admin = await seedAdmin(pool);
    const { inspectorId } = await seedInspector(pool);
    const { districtId } = await seedRegion(pool);
    const store = await seedStore(pool, districtId);
    const { versionId } = await seedVersion(pool, admin.adminId);
    const published = await seedCampaign(pool, admin.adminId, store.id, { status: "published", name: "进行中任务" });
    await seedAssignment(pool, admin.adminId, published.id, inspectorId, versionId, { status: "assigned" });
    const app = buildApp({ config, pool, logger: false, providers });
    const session = await adminLogin(app, admin.username);
    const preview = await get(app, `/api/admin/campaigns/${published.id}/cleanup-preview`, session);
    expect(preview.json().cleanupAllowed).toBe(false);
    expect(preview.json().blockers.map((blocker) => blocker.code)).toContain("CAMPAIGN_NOT_CANCELLED");
    const denied = await post(app, `/api/admin/campaigns/${published.id}/cleanup`, session, { revision: published.revision, confirmName: "进行中任务" });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe("CAMPAIGN_CLEANUP_NOT_ALLOWED");
    expect((await pool.query("SELECT count(*)::int n FROM audit_campaigns")).rows[0].n).toBe(1);
    // 已发布任务不能走普通 DELETE（既有保护不变）
    const ordinary = await app.inject({ method: "DELETE", url: `/api/admin/campaigns/${published.id}`, headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "idempotency-key": uuidv7() }, payload: { revision: published.revision } });
    expect(ordinary.statusCode).toBe(409);
    expect(ordinary.json().error.code).toBe("CAMPAIGN_DELETE_NOT_ALLOWED");
    await app.close();
  });

  test("denies non-super_admin roles with zero deletes and requires full data scope", async () => {
    const admin = await seedAdmin(pool, { role: "operations_admin", username: "OpsAdmin" });
    const { provinceId } = await seedRegion(pool);
    const superAdmin = await seedAdmin(pool, { username: "ScopeSuper", phone: "13600000002", scope: "region", scopeRegionId: provinceId });
    const { inspectorId } = await seedInspector(pool);
    const { districtId } = await seedRegion(pool);
    const store = await seedStore(pool, districtId);
    const { versionId, questionId } = await seedVersion(pool, superAdmin.adminId);
    const campaign = await seedCampaign(pool, superAdmin.adminId, store.id);
    const assignment = await seedAssignment(pool, superAdmin.adminId, campaign.id, inspectorId, versionId);
    await seedUnsubmittedAttempt(pool, { adminId: superAdmin.adminId, assignmentId: assignment.id, inspectorId, versionId, questionId });
    const app = buildApp({ config, pool, logger: false, providers });
    const opsSession = await adminLogin(app, "OpsAdmin");
    const deniedPreview = await get(app, `/api/admin/campaigns/${campaign.id}/cleanup-preview`, opsSession);
    expect(deniedPreview.statusCode).toBe(403);
    expect(deniedPreview.json().error.code).toBe("CLEANUP_FORBIDDEN");
    const deniedCleanup = await post(app, `/api/admin/campaigns/${campaign.id}/cleanup`, opsSession, { revision: campaign.revision, confirmName: "清理测试任务" });
    expect(deniedCleanup.statusCode).toBe(403);
    // 范围受限的 super_admin 同样拒绝（防越权清理范围外数据）
    const scopeSession = await adminLogin(app, "ScopeSuper");
    const scopeDenied = await get(app, `/api/admin/campaigns/${campaign.id}/cleanup-preview`, scopeSession);
    expect(scopeDenied.statusCode).toBe(403);
    expect(scopeDenied.json().error.code).toBe("SCOPE_FORBIDDEN");
    expect((await pool.query("SELECT count(*)::int n FROM audit_campaigns")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM audit_assignments")).rows[0].n).toBe(1);
    await app.close();
  });
});

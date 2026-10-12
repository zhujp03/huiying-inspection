import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

// PM-4：failed→draft 恢复出口的集成测试（前半段 recoverStaleSubmissions 把过期 submitting 置为 failed 已由 batch2 覆盖）。
// createAssignment/createAdminApp/insertQuestionSet/createExecutableAssignment 是
// tests/integration/batch2.postgres.test.js 文件内 helper 的最小副本：该文件不导出 helper，且本任务禁改现有文件。

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it.sequential : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", API_REQUEST_TIMEOUT_MS: 12000, AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
};

async function createAssignment() {
  const userId = uuidv7();
  const regionId = uuidv7();
  const storeId = uuidv7();
  const templateId = uuidv7();
  const versionId = uuidv7();
  const campaignId = uuidv7();
  const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() + 60_000);
  const dueAt = new Date(Date.now() + 3_600_000);
  // 手机号必须用真实加密格式：用户列表接口会对密文解密做脱敏，占位假密文会导致 500
  const { encrypt, hmac: phoneHmac, normalizePhone } = await import("../../apps/api/src/auth/crypto.js");
  const phoneKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const normalizedPhone = normalizePhone("13800000010");
  await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,'BatchTwo','batchtwo','批次二用户',$3,$4,now(),$2,'approved_active')", [userId, await createPasswordService().hash("a-secure-password"), encrypt(phoneKey, normalizedPhone), phoneHmac(config.AUTH_TOKEN_HMAC_KEY, normalizedPhone)]);
  const provinceId = uuidv7(); const cityId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-001','测试门店',$2,'测试地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, userId]);
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'测试题库','secret',$2)", [templateId, userId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, userId]);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-001','测试任务',$2,$3,$4,$5,'draft',$6)", [campaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), userId]);
  await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,questionnaire_deadline_at,budget_limit_cents,status,created_by) VALUES ($1,'A-001',$2,$3,$4,'secret',$5,$6,$7,0,'draft',$8)", [assignmentId, campaignId, userId, versionId, startsAt, dueAt, new Date(Date.now() + 7_200_000), userId]);
  return { userId, regionId, cityId, versionId, campaignId, assignmentId };
}

async function createAdminApp(storage) {
  // 导出创建接口要求 cos.exportConfigured；测试替身默认视为已配置
  storage = { exportConfigured: true, ...storage };
  const setup = await createAssignment();
  const superAdmin = await pool.query("SELECT id FROM roles WHERE code = 'super_admin'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), setup.userId, superAdmin.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), setup.userId]);
  const app = buildApp({ config, pool, storage, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test" }) } });
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
  expect(login.statusCode).toBe(200);
  return { ...setup, app, headers: { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken, "idempotency-key": uuidv7() } };
}

async function insertQuestionSet(versionId) {
  for (let number = 1; number <= 50; number += 1) {
    const category = number <= 20 ? "environment" : number <= 42 ? "service" : "product";
    const id = uuidv7();
    await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,sort_order) VALUES ($1,$2,$3,$4,$5,$6,2,$4)", [id, versionId, `question-${number}`, number, category, `第 ${number} 题`]);
    await pool.query("INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count) VALUES ($1,false,false,false,0,0)", [id]);
  }
}

async function createExecutableAssignment(app, headers, versionId, userId, regionId, window = {}) {
  await insertQuestionSet(versionId);
  expect((await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers, payload: { revision: 0 } })).statusCode).toBe(200);
  const startsAt = window.startsAt || new Date(Date.now() - 60_000).toISOString();
  const dueAt = window.dueAt || new Date(Date.now() + 30 * 60_000).toISOString();
  const store = await pool.query("SELECT id FROM stores WHERE region_id=$1", [regionId]);
  const campaign = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "现场任务", storeId: store.rows[0].id, startsAt, dueAt, questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "现场执行" } });
  expect(campaign.statusCode).toBe(201);
  const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/assignments`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { inspectorId: userId, questionnaireVersionId: versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: false, specialInstruction: "", campaignRevision: 0 } });
  expect(assignment.statusCode).toBe(201);
  const published = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 1 } });
  expect(published.statusCode, published.body).toBe(200);
  const current = await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [assignment.json().id]);
  return { campaignId: campaign.json().campaign.id, assignmentId: assignment.json().id, assignmentRevision: Number(current.rows[0].revision) };
}

describe.sequential("PostgreSQL submit recovery exits", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-postgres-integration-tests'))");
    await pool.query("TRUNCATE object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,survey_attempts,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,question_categories,brands,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    // 分类种子（code 与生产迁移一致，直接插题的用例依赖这些 code）
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-postgres-integration-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("resets a failed attempt back to a draft exactly once when the inspector reopens it", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    expect(login.statusCode).toBe(200);
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    expect((await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } })).statusCode).toBe(200);
    const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
    const before = await pool.query("SELECT status,revision FROM survey_attempts WHERE id=$1", [attemptId]);
    expect(before.rows[0].status).toBe("draft");
    const previousRevision = Number(before.rows[0].revision);
    // 模拟 worker recoverStaleSubmissions 的 failed 产物；额外保留 submit_token 残留
    // （schema 约束 survey_attempts_check1 要求 failed 时 submitting_since 必为 NULL，线上 worker 也会一并清空），
    // 以验证路由重置能把旧提交凭据也一并清掉。
    await pool.query("UPDATE survey_attempts SET status='failed',submit_token=$2,submitting_since=NULL WHERE id=$1", [attemptId, uuidv7()]);
    const reopened = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json().attempt).toMatchObject({ id: attemptId, status: "draft", revision: previousRevision + 1 });
    expect(reopened.json().questions).toHaveLength(50);
    const recovered = await pool.query("SELECT status,submit_token,submitting_since,revision FROM survey_attempts WHERE id=$1", [attemptId]);
    expect(recovered.rows[0]).toMatchObject({ status: "draft", revision: String(previousRevision + 1) });
    expect(recovered.rows[0].submit_token).toBeNull();
    expect(recovered.rows[0].submitting_since).toBeNull();
    const audits = await pool.query("SELECT data_json FROM audit_logs WHERE action='attempt_recovered' AND subject_type='assignment' AND subject_id=$1", [assignmentId]);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].data_json).toMatchObject({ attemptId });
    // 重置只发生一次：attempt 已是 draft，再次打开不再自增 revision，也不再追加恢复审计。
    const again = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().attempt).toMatchObject({ status: "draft", revision: previousRevision + 1 });
    expect((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE action='attempt_recovered' AND subject_type='assignment' AND subject_id=$1", [assignmentId])).rows[0].n).toBe(1);
    await app.close();
  });

  test("treats a failed attempt as draft on submit, passing the state gate and reporting incompleteness", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    expect(login.statusCode).toBe(200);
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    expect((await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } })).statusCode).toBe(200);
    const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
    await pool.query("UPDATE survey_attempts SET status='failed' WHERE id=$1", [attemptId]);
    // GET /api/assignments/:id 的响应（assignmentSummary）不暴露 assignment revision，沿用 batch2 的直查方式。
    const assignmentRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [assignmentId])).rows[0].revision);
    const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspectorHeaders, payload: { submitToken: uuidv7(), assignmentRevision, confirmation: true } });
    // createExecutableAssignment 经 insertQuestionSet 生成 50 道启用必答题，本场景未保存任何答案：
    // failed 视同 draft 使状态门放行（不再 409 SUBMIT_STATE_INVALID），提交落在完整性校验 422 SUBMIT_INCOMPLETE。
    expect(submit.statusCode, submit.body).toBe(422);
    expect(submit.json().error.code).toBe("SUBMIT_INCOMPLETE");
    await app.close();
  });
});

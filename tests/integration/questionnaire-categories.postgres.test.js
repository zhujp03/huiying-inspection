import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

// T5：作答端分类入口 = 本问卷版本中存在启用题目的分类聚合（停用分类不影响已发布问卷作答）。
// createAssignment/createAdminApp/createExecutableAssignment 是
// tests/integration/batch2.postgres.test.js 文件内 helper 的最小副本（经 submit-recovery.postgres.test.js 同例）：
// 该文件不导出 helper，且本任务禁改现有文件。

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

async function insertQuestions(versionId, questions) {
  for (const { number, category } of questions) {
    const id = uuidv7();
    await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,sort_order) VALUES ($1,$2,$3,$4,$5,$6,2,$4)", [id, versionId, `question-${number}`, number, category, `第 ${number} 题`]);
    await pool.query("INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count) VALUES ($1,false,false,false,0,0)", [id]);
  }
}

async function createExecutableAssignment(app, headers, versionId, userId, regionId, questions) {
  await insertQuestions(versionId, questions);
  expect((await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers, payload: { revision: 0 } })).statusCode).toBe(200);
  const startsAt = new Date(Date.now() - 60_000).toISOString();
  const dueAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const store = await pool.query("SELECT id FROM stores WHERE region_id=$1", [regionId]);
  const campaign = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "现场任务", storeId: store.rows[0].id, startsAt, dueAt, questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "现场执行" } });
  expect(campaign.statusCode).toBe(201);
  const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/assignments`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { inspectorId: userId, questionnaireVersionId: versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: false, specialInstruction: "", campaignRevision: 0 } });
  expect(assignment.statusCode).toBe(201);
  const published = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 1 } });
  expect(published.statusCode, published.body).toBe(200);
  return { campaignId: campaign.json().campaign.id, assignmentId: assignment.json().id };
}

// 完整链路：发布版本 → 建任务发布 → 探员登录 → 打卡 → 开始 → 可 GET 问卷
async function bootstrapAndStart(questions) {
  const { app, headers, versionId, userId, regionId } = await createAdminApp();
  const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId, questions);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
  expect(login.statusCode).toBe(200);
  const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
  expect((await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } })).statusCode).toBe(200);
  const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
  return { app, headers, versionId, assignmentId, attemptId, inspectorHeaders };
}

const categoryIds = (response) => response.json().categories.map((item) => item.id);
const baseQuestions = () => [{ number: 1, category: "environment" }, { number: 2, category: "service" }, { number: 3, category: "product" }];

describe.sequential("PostgreSQL questionnaire category aggregation", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-postgres-integration-tests'))");
    await pool.query("TRUNCATE object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,survey_attempts,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,question_categories,brands,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    // 分类种子（code 与生产迁移一致，直接插题的用例依赖这些 code）；active 走表默认 true
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-postgres-integration-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("aggregates categories only from enabled questions of this version", async () => {
    // 无启用题目的分类（hygiene，active）不得出现在作答端
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'hygiene','卫生消毒',4)", [uuidv7()]);
    const { app, assignmentId, attemptId, inspectorHeaders } = await bootstrapAndStart(baseQuestions());
    const fromAssignment = await app.inject({ method: "GET", url: `/api/assignments/${assignmentId}/questionnaire`, headers: inspectorHeaders });
    expect(fromAssignment.statusCode, fromAssignment.body).toBe(200);
    expect(categoryIds(fromAssignment)).toEqual(["environment", "service", "product"]);
    // drafts 端点与 assignments 端点同口径
    const fromDrafts = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(fromDrafts.statusCode, fromDrafts.body).toBe(200);
    expect(categoryIds(fromDrafts)).toEqual(["environment", "service", "product"]);
    await app.close();
  });

  test("deactivating a category after publish does not remove it from the questionnaire", async () => {
    const { app, assignmentId, attemptId, inspectorHeaders } = await bootstrapAndStart(baseQuestions());
    expect(categoryIds(await app.inject({ method: "GET", url: `/api/assignments/${assignmentId}/questionnaire`, headers: inspectorHeaders }))).toEqual(["environment", "service", "product"]);
    // 发布后管理员停用 service 分类：已发布问卷的作答入口不得收窄（否则题目不可达 + 提交仍要求作答 = 死锁）
    await pool.query("UPDATE question_categories SET active=false WHERE code='service'");
    const fromAssignment = await app.inject({ method: "GET", url: `/api/assignments/${assignmentId}/questionnaire`, headers: inspectorHeaders });
    expect(fromAssignment.statusCode, fromAssignment.body).toBe(200);
    expect(categoryIds(fromAssignment)).toEqual(["environment", "service", "product"]);
    const fromDrafts = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(fromDrafts.statusCode, fromDrafts.body).toBe(200);
    expect(categoryIds(fromDrafts)).toEqual(["environment", "service", "product"]);
    await app.close();
  });

  test("disabling a question removes its category from the questionnaire", async () => {
    const { app, versionId, assignmentId, inspectorHeaders } = await bootstrapAndStart(baseQuestions());
    // environment 的唯一题目停用后，该分类不再有启用题目 → 入口消失
    await pool.query("UPDATE questions SET enabled=false WHERE version_id=$1 AND category='environment'", [versionId]);
    const fromAssignment = await app.inject({ method: "GET", url: `/api/assignments/${assignmentId}/questionnaire`, headers: inspectorHeaders });
    expect(fromAssignment.statusCode, fromAssignment.body).toBe(200);
    expect(categoryIds(fromAssignment)).toEqual(["service", "product"]);
    await app.close();
  });

  test("orders categories by sort_order regardless of question insertion order", async () => {
    // beta sort_order=5 在前，alpha sort_order=10 在后；题目插入顺序相反（alpha 题号 1 先插）
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'beta','贝塔',5),($2,'alpha','阿尔法',10)", [uuidv7(), uuidv7()]);
    const { app, assignmentId, inspectorHeaders } = await bootstrapAndStart([{ number: 1, category: "alpha" }, { number: 2, category: "beta" }]);
    const fromAssignment = await app.inject({ method: "GET", url: `/api/assignments/${assignmentId}/questionnaire`, headers: inspectorHeaders });
    expect(fromAssignment.statusCode, fromAssignment.body).toBe(200);
    // 默认三分类本版本无题不出现；顺序按 sort_order 而非题目插入顺序
    expect(categoryIds(fromAssignment)).toEqual(["beta", "alpha"]);
    await app.close();
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { runObjectCleanupJobs } from "../../apps/worker/src/object-cleanup.js";
import { runReceiptOcrJobs } from "../../apps/worker/src/receipt-ocr.js";
import { recoverStaleSubmissions } from "../../apps/worker/src/submission-recovery.js";
import { runExportJobs } from "../../apps/worker/src/export-jobs.js";
import { runArchiveRestoreJobs } from "../../apps/worker/src/archive-restores.js";
import { runRetention } from "../../apps/worker/src/retention.js";
import { runObjectReconciliation } from "../../apps/worker/src/object-reconciliation.js";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it.sequential : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", API_REQUEST_TIMEOUT_MS: 12000, AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  // 本套件覆盖小票 OCR job 全链路（fake OCR 客户端），显式声明 paddle 形态以绕开 none 守卫。
  OCR_PROVIDER: "paddle",
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

describe.sequential("PostgreSQL Batch 2 constraints", () => {
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

  test("rejects an invalid evidence configuration in the database", async () => {
    const { versionId } = await createAssignment();
    const questionId = uuidv7();
    await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,sort_order) VALUES ($1,$2,'environment-01',1,'environment','环境整洁',2,1)", [questionId, versionId]);
    await expect(pool.query("INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required) VALUES ($1,false,true)", [questionId])).rejects.toMatchObject({ code: "23514" });
  });

  test("allows at most one active check-in exemption per assignment", async () => {
    const { assignmentId, userId } = await createAssignment();
    const validUntil = new Date(Date.now() + 10 * 60_000);
    await pool.query("INSERT INTO checkin_exemptions (id,assignment_id,status,reason,granted_by,valid_until) VALUES ($1,$2,'active','定位服务异常',$3,$4)", [uuidv7(), assignmentId, userId, validUntil]);
    await expect(pool.query("INSERT INTO checkin_exemptions (id,assignment_id,status,reason,granted_by,valid_until) VALUES ($1,$2,'active','再次创建',$3,$4)", [uuidv7(), assignmentId, userId, validUntil])).rejects.toMatchObject({ code: "23505" });
  });

  test("creates, lists, and revision-updates a store through the admin Cookie and CSRF guard", async () => {
    const { app, headers, regionId } = await createAdminApp();
    const brand = await app.inject({ method: "POST", url: "/api/admin/brands", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "测试品牌", active: true } });
    expect(brand.statusCode, brand.body).toBe(201);
    const brandId = brand.json().brand.id;
    const payload = { businessNo: "S-002", name: "第二门店", brandId, regionId, address: "第二地址", latitudeGcj02: 31.22, longitudeGcj02: 121.47, coordinateSource: "manual_adjusted", radiusMeters: 300, accuracyAllowanceMaxMeters: 100, locationVerified: true, active: true };
    const created = await app.inject({ method: "POST", url: "/api/admin/stores", headers: { ...headers, "idempotency-key": uuidv7() }, payload });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().store).toMatchObject({ businessNo: "S-002", brandId, brandName: "测试品牌", cityName: "上海市", locationVerified: true, revision: 0 });
    const listed = await app.inject({ method: "GET", url: "/api/admin/stores", headers: { cookie: headers.cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toContainEqual(expect.objectContaining({ id: created.json().store.id, name: "第二门店" }));
    const updated = await app.inject({ method: "PATCH", url: `/api/admin/stores/${created.json().store.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { ...payload, name: "第二门店（校准）", revision: 0 } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().store).toMatchObject({ name: "第二门店（校准）", revision: 1 });
    await app.close();
  });

  test("manages brands and filters stores by brand and city", async () => {
    const { app, headers, regionId, cityId } = await createAdminApp();
    const conflict = await app.inject({ method: "POST", url: "/api/admin/brands", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "肯德基", active: true } });
    expect(conflict.statusCode, conflict.body).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/admin/brands", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "德合斋", active: true } });
    expect(second.statusCode).toBe(201);
    const duplicated = await app.inject({ method: "POST", url: "/api/admin/brands", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "肯德基", active: true } });
    expect(duplicated.statusCode).toBe(409);
    const brands = await app.inject({ method: "GET", url: "/api/admin/brands", headers: { cookie: headers.cookie } });
    expect(brands.json().items).toHaveLength(2);
    const brandId = conflict.json().brand.id;
    const otherBrandId = second.json().brand.id;
    const storePayload = { businessNo: "S-010", name: "甘露园肯德基", brandId, regionId, address: "测试地址", latitudeGcj02: 31.22, longitudeGcj02: 121.47, coordinateSource: "poi", radiusMeters: 300, accuracyAllowanceMaxMeters: 100, locationVerified: true, active: true };
    const created = await app.inject({ method: "POST", url: "/api/admin/stores", headers: { ...headers, "idempotency-key": uuidv7() }, payload: storePayload });
    expect(created.statusCode, created.body).toBe(201);
    // 停用品牌后不能再用于新门店
    await app.inject({ method: "PATCH", url: `/api/admin/brands/${otherBrandId}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "德合斋", active: false, revision: 0 } });
    const inactiveUse = await app.inject({ method: "POST", url: "/api/admin/stores", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { ...storePayload, businessNo: "S-011", brandId: otherBrandId } });
    expect(inactiveUse.statusCode).toBe(422);
    // 品牌筛选
    const byBrand = await app.inject({ method: "GET", url: `/api/admin/stores?brandId=${brandId}`, headers: { cookie: headers.cookie } });
    expect(byBrand.json().items.map((item) => item.name)).toEqual(["甘露园肯德基"]);
    const byOtherBrand = await app.inject({ method: "GET", url: `/api/admin/stores?brandId=${otherBrandId}`, headers: { cookie: headers.cookie } });
    expect(byOtherBrand.json().items).toEqual([]);
    // 城市筛选（区县静安区的上级是地级市区域；种子门店与新建门店同城）
    const byCity = await app.inject({ method: "GET", url: `/api/admin/stores?cityRegionId=${cityId}`, headers: { cookie: headers.cookie } });
    expect(byCity.json().items.map((item) => item.name).sort()).toEqual(["测试门店", "甘露园肯德基"].sort());
    const byEmptyCity = await app.inject({ method: "GET", url: `/api/admin/stores?cityRegionId=${uuidv7()}`, headers: { cookie: headers.cookie } });
    expect(byEmptyCity.json().items).toEqual([]);
    // 被引用的品牌不能删除
    const deleteReferenced = await app.inject({ method: "DELETE", url: `/api/admin/brands/${brandId}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 0 } });
    expect(deleteReferenced.statusCode).toBe(409);
    // 未被引用的品牌可以删除
    const deleteUnused = await app.inject({ method: "DELETE", url: `/api/admin/brands/${otherBrandId}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 1 } });
    expect(deleteUnused.statusCode, deleteUnused.body).toBe(200);
    await app.close();
  });

  test("manages question categories and gates questionnaire publish on active categories", async () => {
    const { app, headers } = await createAdminApp();
    // 内置种子分类
    const seeded = await app.inject({ method: "GET", url: "/api/admin/question-categories", headers: { cookie: headers.cookie } });
    expect(seeded.statusCode).toBe(200);
    const seedCodes = seeded.json().items.map((item) => item.code);
    expect(seedCodes).toEqual(expect.arrayContaining(["environment", "service", "product"]));
    // 新增
    const created = await app.inject({ method: "POST", url: "/api/admin/question-categories", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "口味", active: true } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().category).toMatchObject({ name: "口味", active: true, questionCount: 0 });
    expect(created.json().category.code).toMatch(/^cat_/);
    const newCode = created.json().category.code;
    // 重名 409
    const duplicated = await app.inject({ method: "POST", url: "/api/admin/question-categories", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "口味", active: true } });
    expect(duplicated.statusCode).toBe(409);
    // 用新分类创建问卷
    const version = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "口味问卷", questions: [{ number: 1, category: newCode, text: "菜品口味评价", maxScore: 2 }] } });
    expect(version.statusCode, version.body).toBe(201);
    const versionId = version.json().version.id;
    // 未知分类 422
    const invalid = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "坏分类问卷", questions: [{ number: 1, category: "not-a-category", text: "无效分类", maxScore: 2 }] } });
    expect(invalid.statusCode).toBe(422);
    // 发布成功（题目引用了启用分类）
    const published = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 0 } });
    expect(published.statusCode, published.body).toBe(200);
    // 被题目引用的分类不能删除
    const deleteReferenced = await app.inject({ method: "DELETE", url: `/api/admin/question-categories/${created.json().category.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 0 } });
    expect(deleteReferenced.statusCode).toBe(409);
    // 未被引用的分类可以删除
    const spare = await app.inject({ method: "POST", url: "/api/admin/question-categories", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "临时分类", active: true } });
    expect(spare.statusCode).toBe(201);
    const deleteSpare = await app.inject({ method: "DELETE", url: `/api/admin/question-categories/${spare.json().category.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 0 } });
    expect(deleteSpare.statusCode, deleteSpare.body).toBe(200);
    await app.close();
  });

  test("publishes only a complete 50-question version and copies its immutable question configuration", async () => {
    const { app, headers, versionId } = await createAdminApp();
    const rejected = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers, payload: { revision: 0 } });
    expect(rejected.statusCode).toBe(422);
    expect((await pool.query("SELECT status FROM questionnaire_versions WHERE id=$1", [versionId])).rows[0].status).toBe("draft");
    await insertQuestionSet(versionId);
    const published = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 0 } });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().version).toMatchObject({ id: versionId, status: "published", revision: 1 });
    for (let copyNumber = 2; copyNumber <= 4; copyNumber += 1) {
      const copied = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/copy`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: {} });
      expect(copied.statusCode, copied.body).toBe(201);
      expect(copied.json().version).toMatchObject({ id: expect.any(String), status: "draft", versionLabel: `V${copyNumber}` });
      const copiedQuestions = await pool.query("SELECT question_number,question_key,category FROM questions WHERE version_id=$1 ORDER BY question_number", [copied.json().version.id]);
      expect(copiedQuestions.rows).toHaveLength(50);
      expect(copiedQuestions.rows[0]).toMatchObject({ question_number: 1, question_key: "question-1", category: "environment" });
      expect(copiedQuestions.rows[49]).toMatchObject({ question_number: 50, question_key: "question-50", category: "product" });
    }
    await app.close();
  });

  test("creates a draft campaign, assigns one inspector, stores budget in cents, and publishes only after all guards pass", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    await insertQuestionSet(versionId);
    expect((await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers, payload: { revision: 0 } })).statusCode).toBe(200);
    const startsAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const dueAt = new Date(Date.now() + 70 * 60_000).toISOString();
    const store = await pool.query("SELECT id FROM stores WHERE region_id=$1", [regionId]);
    const created = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "正式任务", storeId: store.rows[0].id, startsAt, dueAt, questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "请按要求执行" } });
    expect(created.statusCode, created.body).toBe(201);
    const campaign = created.json().campaign;
    const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.id}/assignments`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { inspectorId: userId, questionnaireVersionId: versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 12.34, receiptRequired: true, specialInstruction: "单人要求", campaignRevision: 0 } });
    expect(assignment.statusCode, assignment.body).toBe(201);
    const dishes = await app.inject({ method: "PUT", url: `/api/admin/assignments/${assignment.json().id}/dish-requirements`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: assignment.json().revision, items: [{ plannedName: "招牌菜", quantity: 2, required: true, allowSubstitution: false }] } });
    expect(dishes.statusCode, dishes.body).toBe(200);
    expect((await pool.query("SELECT budget_limit_cents FROM audit_assignments WHERE id=$1", [assignment.json().id])).rows[0].budget_limit_cents).toBe(1234);
    const published = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.id}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 1 } });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().campaign).toMatchObject({ status: "published", revision: 2, assignmentCount: 1 });
    const assigned = await pool.query("SELECT status FROM audit_assignments WHERE id=$1", [assignment.json().id]);
    expect(assigned.rows[0].status).toBe("assigned");
    await app.close();
  });

  test("updates and deletes only a revision-current draft assignment", async () => {
    const { app, headers, versionId, userId, campaignId, assignmentId } = await createAdminApp();
    const campaign = await pool.query("SELECT starts_at,due_at FROM audit_campaigns WHERE id=$1", [campaignId]);
    const updated = await app.inject({ method: "PATCH", url: `/api/admin/assignments/${assignmentId}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: {
      inspectorId: userId, questionnaireVersionId: versionId, taskType: "secret", startsAt: campaign.rows[0].starts_at.toISOString(), dueAt: campaign.rows[0].due_at.toISOString(), budgetLimit: 9.99, receiptRequired: true, specialInstruction: "调整后的说明", campaignRevision: 0, revision: 0,
    } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ id: assignmentId, status: "draft", revision: 1 });
    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/assignments/${assignmentId}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 1 } });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((await pool.query("SELECT id FROM audit_assignments WHERE id=$1", [assignmentId])).rows).toHaveLength(0);
    await app.close();
  });

  test("cancels a published assignment and recomputes the parent task", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const current = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const cancelled = await app.inject({ method: "POST", url: `/api/admin/assignments/${current.assignmentId}/cancel`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: current.assignmentRevision, reason: "探店员临时无法到店" } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ assignment: { status: "cancelled" }, campaign: { status: "completed" } });
    await app.close();
  });

  test("extends an overdue assignment and persists the required reason", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const overdue = await createExecutableAssignment(app, headers, versionId, userId, regionId, { startsAt: new Date(Date.now() - 20 * 60_000).toISOString(), dueAt: new Date(Date.now() - 60_000).toISOString() });
    const futureCampaignDueAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    await pool.query("UPDATE audit_campaigns SET due_at=$2,questionnaire_deadline_at=$3 WHERE id=$1", [overdue.campaignId, futureCampaignDueAt, new Date(Date.now() + 4 * 60 * 60_000).toISOString()]);
    const extended = await app.inject({ method: "POST", url: `/api/admin/assignments/${overdue.assignmentId}/extend`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: overdue.assignmentRevision, dueAt: new Date(Date.now() + 30 * 60_000).toISOString(), reason: "暴雨导致到店延迟" } });
    expect(extended.statusCode, extended.body).toBe(200);
    expect(extended.json()).toMatchObject({ assignment: { status: "assigned" }, campaign: { status: "published" } });
    const extensionAudit = await pool.query("SELECT last_extension_reason FROM audit_assignments WHERE id=$1", [overdue.assignmentId]);
    expect(extensionAudit.rows[0].last_extension_reason).toBe("暴雨导致到店延迟");
    await app.close();
  });

  test("returns only the inspector's assignment, records a server-accepted GCJ-02 check-in, and rejects a guessed assignment ID", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    expect(login.statusCode).toBe(200);
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    const mine = await app.inject({ method: "GET", url: "/api/assignments/mine", headers: inspectorHeaders });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items).toEqual([expect.objectContaining({ id: assignmentId, status: "assigned" })]);
    const checkin = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString(), inRange: false } });
    expect(checkin.statusCode, checkin.body).toBe(200);
    expect(checkin.json()).toMatchObject({ result: "accepted" });
    expect(checkin.json().validUntil).toBeTruthy();
    const guessed = await app.inject({ method: "GET", url: `/api/assignments/${uuidv7()}`, headers: inspectorHeaders });
    expect(guessed.statusCode).toBe(404);
    await app.close();
  });

  test("creates exactly one attempt under 20 concurrent starts, consumes the check-in, and protects the draft owner", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    expect((await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } })).statusCode).toBe(200);
    const starts = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })));
    expect(starts.every((response) => response.statusCode === 200), starts.map((response) => response.body)).toBe(true);
    const attemptIds = new Set(starts.map((response) => response.json().attempt.id));
    expect(attemptIds.size).toBe(1);
    const attemptId = [...attemptIds][0];
    expect((await pool.query("SELECT count(*)::int count FROM survey_attempts WHERE assignment_id=$1", [assignmentId])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM audit_checkins WHERE assignment_id=$1 AND consumed_at IS NOT NULL", [assignmentId])).rows[0].count).toBe(1);
    const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json().questions).toHaveLength(50);
    const saved = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/answers/${draft.json().questions[0].id}`, headers: inspectorHeaders, payload: { answer: "scored", revision: 0 } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().revision).toBe(1);
    const guessed = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${uuidv7()}`, headers: inspectorHeaders });
    expect(guessed.statusCode).toBe(404);
    await app.close();
  });

  test("opens at most one edit session under contention and confirms an unscored answer atomically", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const started = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders });
    const attemptId = started.json().attempt.id;
    const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    const questionId = draft.json().questions[0].id;
    const sessions = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } })));
    // T4 恢复语义：争用不再以 409 分流——全部 200 且收敛到同一 open 会话；
    // "至多一个编辑会话"不变量由 (attempt_id,question_id) open 唯一索引保证，此处以 DB 行数复核。
    expect(sessions.every((response) => response.statusCode === 200), sessions.filter((response) => response.statusCode !== 200).map((response) => response.body)).toBe(true);
    const sessionIds = new Set(sessions.map((response) => response.json().id));
    expect(sessionIds.size).toBe(1);
    const editSessionId = [...sessionIds][0];
    expect((await pool.query("SELECT count(*)::int count FROM question_answer_edit_sessions WHERE attempt_id=$1 AND question_id=$2 AND status='open'", [attemptId, questionId])).rows[0].count).toBe(1);
    expect((await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${editSessionId}`, headers: inspectorHeaders, payload: { draftIssueRemark: "入口地面有水渍", revision: 0 } })).statusCode).toBe(200);
    const confirmed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${editSessionId}/confirm`, headers: inspectorHeaders, payload: { answer: "unscored", revision: 0 } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().revision).toBe(1);
    const answer = await pool.query("SELECT answer,issue_remark FROM question_answers WHERE attempt_id=$1 AND question_id=$2", [attemptId, questionId]);
    expect(answer.rows[0]).toMatchObject({ answer: "unscored", issue_remark: "入口地面有水渍" });
    await app.close();
  });

  test("leases evidence completion outside the transaction and finalizes it exactly once", async () => {
    const storage = {
      newObjectSuffix: () => "test-object", createPostTarget: ({ key }) => ({ method: "POST", url: "https://private.example.test", fileFieldName: "file", formData: { key }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      verifyObject: async ({ expectedSizeBytes }) => ({ sizeBytes: expectedSizeBytes, mimeType: "image/jpeg", sha256: "a".repeat(64), storageVersionId: "version-one", durationSeconds: null }),
    };
    const { app, headers, versionId, userId, regionId } = await createAdminApp(storage);
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const started = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders });
    const attemptId = started.json().attempt.id;
    const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    const questionId = draft.json().questions[0].id;
    await pool.query("UPDATE question_evidence_requirements SET evidence_required=true,image_required=true,image_min_count=1 WHERE question_id=$1", [questionId]);
    const edit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    const editSessionId = edit.json().id;
    const clientFileId = uuidv7();
    const initialized = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${editSessionId}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId, type: "image", mimeType: "image/jpeg", sizeBytes: 100 } });
    expect(initialized.statusCode, initialized.body).toBe(201);
    const completeUrl = `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${editSessionId}/evidence-uploads/${initialized.json().attachmentId}/complete`;
    const completed = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: "POST", url: completeUrl, headers: inspectorHeaders, payload: { uploadToken: initialized.json().uploadToken, sizeBytes: 100 } })));
    expect(completed.every((response) => [200, 202].includes(response.statusCode)), completed.map((response) => response.body)).toBe(true);
    const attachment = await pool.query("SELECT status,sha256 FROM question_evidence_attachments WHERE id=$1", [initialized.json().attachmentId]);
    expect(attachment.rows[0]).toMatchObject({ status: "staged_ready", sha256: "a".repeat(64) });
    const attempt = await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId]);
    expect(Number(attempt.rows[0].revision)).toBe(1);
    await app.close();
  });

  test("applies evidence removals only when the edit session is confirmed and cleans staged files on cancel", async () => {
    const storage = {
      newObjectSuffix: () => "test-object", createPostTarget: ({ key }) => ({ method: "POST", url: "https://private.example.test", fileFieldName: "file", formData: { key }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      verifyObject: async ({ expectedSizeBytes }) => ({ sizeBytes: expectedSizeBytes, mimeType: "image/jpeg", sha256: "b".repeat(64), storageVersionId: "version-two", durationSeconds: null }),
      createPreviewUrl: async () => ({ url: "https://private.example.test/preview", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    };
    const { app, headers, versionId, userId, regionId } = await createAdminApp(storage);
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
    const questionId = (await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders })).json().questions[0].id;
    await pool.query("UPDATE question_evidence_requirements SET evidence_required=true,image_required=true,image_min_count=1 WHERE question_id=$1", [questionId]);
    const first = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    const firstId = first.json().id;
    const initialized = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${firstId}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 100 } });
    expect((await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${firstId}/evidence-uploads/${initialized.json().attachmentId}/complete`, headers: inspectorHeaders, payload: { uploadToken: initialized.json().uploadToken, sizeBytes: 100 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${firstId}`, headers: inspectorHeaders, payload: { draftIssueRemark: "地面湿滑", revision: 1 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${firstId}/confirm`, headers: inspectorHeaders, payload: { answer: "unscored", revision: 1 } })).statusCode).toBe(200);
    expect((await pool.query("SELECT status FROM question_evidence_attachments WHERE id=$1", [initialized.json().attachmentId])).rows[0].status).toBe("active");
    const second = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    expect(second.json().activeAttachments).toHaveLength(1);
    const replacement = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${second.json().id}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 101 } });
    expect((await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${second.json().id}/evidence-uploads/${replacement.json().attachmentId}/complete`, headers: inspectorHeaders, payload: { uploadToken: replacement.json().uploadToken, sizeBytes: 101 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${second.json().id}/evidence/${initialized.json().attachmentId}`, headers: inspectorHeaders })).json()).toMatchObject({ status: "pending_removal" });
    expect((await pool.query("SELECT status FROM question_evidence_attachments WHERE id=$1", [initialized.json().attachmentId])).rows[0].status).toBe("active");
    expect((await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${second.json().id}`, headers: inspectorHeaders, payload: { draftIssueRemark: "地面湿滑", revision: 3 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${second.json().id}/confirm`, headers: inspectorHeaders, payload: { answer: "unscored", revision: 3 } })).statusCode).toBe(200);
    expect((await pool.query("SELECT status FROM question_evidence_attachments WHERE id=$1", [initialized.json().attachmentId])).rows[0].status).toBe("deleted");
    expect((await pool.query("SELECT status FROM question_evidence_attachments WHERE id=$1", [replacement.json().attachmentId])).rows[0].status).toBe("active");
    const third = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 1, targetAnswer: "unscored" } });
    const abandoned = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${third.json().id}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 102 } });
    expect((await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${third.json().id}/cancel`, headers: inspectorHeaders })).statusCode).toBe(200);
    expect((await pool.query("SELECT status,cleanup_after FROM question_evidence_attachments WHERE id=$1", [abandoned.json().attachmentId])).rows[0]).toMatchObject({ status: "deleted" });
    expect((await pool.query("SELECT cleanup_after FROM question_evidence_attachments WHERE id=$1", [abandoned.json().attachmentId])).rows[0].cleanup_after).toBeTruthy();
    const deletedKeys = [];
    expect(await runObjectCleanupJobs({ pool, cos: { deleteObject: async (key) => deletedKeys.push(key) } })).toBeGreaterThan(0);
    expect(deletedKeys).toHaveLength(2);
    expect((await pool.query("SELECT count(*)::int count FROM object_cleanup_jobs WHERE status='succeeded'")).rows[0].count).toBe(2);
    await app.close();
  });

  test("keeps receipt uploads bounded and persists stable dish and other-record drafts", async () => {
    const storage = {
      newObjectSuffix: () => "receipt-object", createPostTarget: ({ key }) => ({ method: "POST", url: "https://private.example.test", fileFieldName: "file", formData: { key }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      verifyObject: async ({ expectedSizeBytes }) => ({ sizeBytes: expectedSizeBytes, mimeType: "image/jpeg", sha256: "a".repeat(64), storageVersionId: "receipt-version", durationSeconds: null }),
      createPreviewUrl: async () => ({ url: "https://private.example.test/preview", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    };
    const { app, headers, versionId, userId, regionId } = await createAdminApp(storage);
    const executable = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    expect((await app.inject({ method: "PUT", url: `/api/admin/assignments/${executable.assignmentId}/dish-requirements`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: executable.assignmentRevision, items: [{ plannedName: "招牌菜", quantity: 1, required: true, allowSubstitution: false }] } })).statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${executable.assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${executable.assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
    const initialDraft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(initialDraft.json().dishes).toHaveLength(1);
    let revision = initialDraft.json().attempt.revision;
    const upload = async (clientFileId, fileName, sizeBytes) => app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/uploads`, headers: inspectorHeaders, payload: { fileMeta: { clientFileId, fileName, mimeType: "image/jpeg", sizeBytes, sha256: "a".repeat(64) }, revision } });
    const firstClientFileId = uuidv7();
    const first = await upload(firstClientFileId, "receipt-1.jpg", 100);
    expect(first.statusCode, first.body).toBe(201);
    revision = first.json().revision;
    const confirmed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/${first.json().attachment.id}/complete`, headers: inspectorHeaders, payload: { fileMeta: { clientFileId: firstClientFileId, fileName: "receipt-1.jpg", mimeType: "image/jpeg", sizeBytes: 100, sha256: "a".repeat(64) }, revision } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    revision = confirmed.json().revision;
    for (let index = 2; index <= 9; index += 1) {
      const created = await upload(uuidv7(), `receipt-${index}.jpg`, 100 + index);
      expect(created.statusCode, created.body).toBe(201);
      revision = created.json().revision;
    }
    const tenth = await upload(uuidv7(), "receipt-10.jpg", 200);
    expect(tenth.statusCode).toBe(422);
    const receipts = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments`, headers: inspectorHeaders });
    expect(receipts.json().items).toHaveLength(9);
    const dish = initialDraft.json().dishes[0];
    const savedDishes = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/dishes`, headers: inspectorHeaders, payload: { revision, dishes: [{ ...dish, actualName: "招牌菜", quantity: 1, fulfillmentStatus: "ordered", evaluation: "口味佳", fullySatisfied: false, source: "manual", manuallyModified: true, priceDerived: false, reviewFields: [] }] } });
    expect(savedDishes.statusCode, savedDishes.body).toBe(200);
    revision = savedDishes.json().revision;
    expect((await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers: inspectorHeaders, payload: { highlight: "服务热情", suggestion: "继续保持", revision } })).statusCode).toBe(200);
    await app.close();
  });

  test("runs a leased receipt OCR job and applies its candidates exactly once", async () => {
    const storage = {
      newObjectSuffix: () => "ocr-object", createPostTarget: ({ key }) => ({ method: "POST", url: "https://private.example.test", fileFieldName: "file", formData: { key }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      verifyObject: async ({ expectedSizeBytes }) => ({ sizeBytes: expectedSizeBytes, mimeType: "image/jpeg", sha256: "c".repeat(64), storageVersionId: "ocr-version", durationSeconds: null }),
      createPreviewUrl: async () => ({ url: "https://private.example.test/preview", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      readObject: async () => Buffer.from("receipt-bytes"),
    };
    const { app, headers, versionId, userId, regionId } = await createAdminApp(storage);
    const executable = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    expect((await app.inject({ method: "PUT", url: `/api/admin/assignments/${executable.assignmentId}/dish-requirements`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: executable.assignmentRevision, items: [{ plannedName: "招牌菜", quantity: 1, required: true, allowSubstitution: false }] } })).statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${executable.assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${executable.assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
    const clientFileId = uuidv7();
    const initialized = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/uploads`, headers: inspectorHeaders, payload: { fileMeta: { clientFileId, fileName: "receipt.jpg", mimeType: "image/jpeg", sizeBytes: 100, sha256: "c".repeat(64) }, revision: 0 } });
    const completed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/${initialized.json().attachment.id}/complete`, headers: inspectorHeaders, payload: { fileMeta: { clientFileId, fileName: "receipt.jpg", mimeType: "image/jpeg", sizeBytes: 100, sha256: "c".repeat(64) }, revision: initialized.json().revision } });
    expect(completed.statusCode, completed.body).toBe(200);
    const created = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-ocr-jobs`, headers: inspectorHeaders, payload: { attachmentIds: [initialized.json().attachment.id], idempotencyKey: uuidv7(), revision: completed.json().revision } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ id: expect.any(String), status: "queued" });
    const queuedJobs = await pool.query("SELECT id,status,next_attempt_at<=now() ready FROM receipt_ocr_jobs");
    expect(queuedJobs.rows).toContainEqual(expect.objectContaining({ id: created.json().id, status: "queued", ready: true }));
    expect(await runReceiptOcrJobs({ pool, cos: storage, ocr: { recognize: async () => [{ text: "招牌菜 1x12.34 12.34", confidence: 0.91, boundingBox: [[0, 0], [1, 1]] }] } })).toMatchObject({ claimed: 1, completed: 1 });
    const job = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-ocr-jobs/${created.json().id}`, headers: inspectorHeaders });
    expect(job.json()).toMatchObject({ status: "succeeded", recognizedDishCount: 1, reviewFieldCount: 0 });
    const applyKey = uuidv7();
    const applied = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-ocr-jobs/${created.json().id}/apply`, headers: inspectorHeaders, payload: { idempotencyKey: applyKey, revision: completed.json().revision } });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().dishes).toContainEqual(expect.objectContaining({ plannedName: "招牌菜", actualName: "招牌菜", source: "ocr" }));
    const replay = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-ocr-jobs/${created.json().id}/apply`, headers: inspectorHeaders, payload: { idempotencyKey: applyKey, revision: completed.json().revision } });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().revision).toBe(applied.json().revision);
    await app.close();
  });

  test("submits one immutable questionnaire snapshot once, exposes its read-only comparison, and locks later draft writes", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
    const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    let revision = draft.json().attempt.revision;
    for (const question of draft.json().questions) {
      const saved = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/answers/${question.id}`, headers: inspectorHeaders, payload: { answer: "scored", revision } });
      expect(saved.statusCode, saved.body).toBe(200);
      revision = saved.json().revision;
    }
    expect((await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers: inspectorHeaders, payload: { highlight: "员工服务热情", suggestion: "继续保持", revision } })).statusCode).toBe(200);
    const assignment = await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [assignmentId]);
    const token = uuidv7();
    const submissionRequests = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspectorHeaders, payload: { submitToken: token, assignmentRevision: Number(assignment.rows[0].revision), confirmation: true } })));
    expect(submissionRequests.every((response) => [200, 409, 503].includes(response.statusCode)), submissionRequests.map((response) => response.body)).toBe(true);
    const submitted = submissionRequests.find((response) => response.statusCode === 200);
    expect(submitted).toBeTruthy();
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().status).toBe("submitted");
    const snapshot = await pool.query("SELECT * FROM submission_versions WHERE attempt_id=$1", [attemptId]);
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].answer_snapshot_json).toHaveLength(50);
    // 数据看板逐题得分明细与提交同事务物化（每道启用题一行）
    const scoreFacts = await pool.query("SELECT count(*)::int n FROM submission_question_scores WHERE submission_id=$1", [snapshot.rows[0].id]);
    expect(scoreFacts.rows[0].n).toBe(50);
    const detail = await app.inject({ method: "GET", url: `/api/admin/submissions/${snapshot.rows[0].id}`, headers: { cookie: headers.cookie } });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().receiptComparison).toMatchObject({ receipts: [], ocrCandidates: [], finalDishes: [], receiptTotals: { recognizedCents: null, finalCents: null, differenceCents: null }, differences: [] });
    expect(detail.json().auditLogs).toContainEqual(expect.objectContaining({ actionLabel: "问卷已提交", actorName: "批次二用户" }));
    const replay = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspectorHeaders, payload: { submitToken: token, assignmentRevision: Number(assignment.rows[0].revision), confirmation: true } });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(submitted.json());
    expect((await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers: inspectorHeaders, payload: { highlight: "改写", suggestion: "", revision: revision + 1 } })).statusCode).toBe(409);
    await app.close();
  });

  test("exports only the captured data scope through a leased private-object job", async () => {
    const uploaded = [];
    const storage = {
      putExportObject: async (object) => uploaded.push(object), deleteExportObject: async () => {},
      createExportDownloadUrl: async () => ({ url: "https://private.example.test/export", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    };
    const { app, headers, assignmentId, campaignId, versionId, userId } = await createAdminApp(storage);
    const attemptId = uuidv7();
    const submissionId = uuidv7();
    const questionId = uuidv7();
    await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
    await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
      VALUES ($1,$2,$3,$4,$5,$6,now(),80,100,2,'[]','[]','{}','[]','[]','[]',$7)`, [submissionId, attemptId, assignmentId, campaignId, versionId, userId, "a".repeat(64)]);
    // 单份问卷导出需要逐题得分且分类合计与 total/max 一致：补一题明细（80/100）
    await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,sort_order) VALUES ($1,$2,'b2-exp-key',1,'product','测试任务评估题',100,1)", [questionId, versionId]);
    await pool.query("INSERT INTO submission_question_scores (id,submission_id,question_id,question_key,question_number,question_text,category,answer,awarded_score,max_score) VALUES ($1,$2,$3,'b2-exp-key',1,'测试任务评估题','product','scored',80,100)", [uuidv7(), submissionId, questionId]);
    const requested = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId } });
    expect(requested.statusCode, requested.body).toBe(202);
    await pool.query("UPDATE user_data_scopes SET revoked_at=now() WHERE user_id=$1", [userId]);
    expect(await runExportJobs({ pool, cos: storage })).toMatchObject({ claimed: 1, completed: 1 });
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].contentType).toContain("spreadsheetml");
    // 单份导出产物为真实 xlsx（非改名 CSV）：重读工作簿校验任务名进入评估表标题
    const { workbookOf } = await import("../helpers/export-workbook.mjs");
    const workbook = await workbookOf(uploaded[0]);
    expect(workbook.getWorksheet("暗访评估表").getCell("A1").value).toContain("测试题库");
    await pool.query("UPDATE user_data_scopes SET revoked_at=NULL WHERE user_id=$1", [userId]);
    const state = await app.inject({ method: "GET", url: `/api/admin/exports/${requested.json().id}`, headers });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ status: "succeeded", downloadUrl: "https://private.example.test/export" });
    await app.close();
  });

  test("creates one scoped archive restore job and exposes ready only after its worker lease finishes", async () => {
    const calls = [];
    const storage = {
      requestArchiveRestore: async (request) => calls.push(request),
      archiveRestoreStatus: async () => ({ status: "ready", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    };
    const { app, headers, assignmentId, campaignId, versionId, userId } = await createAdminApp(storage);
    const attemptId = uuidv7();
    const submissionId = uuidv7();
    const attachmentId = uuidv7();
    await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
    await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
      VALUES ($1,$2,$3,$4,$5,$6,now(),80,100,2,'[]','[]','{}',$7,'[]','[]',$8)`, [submissionId, attemptId, assignmentId, campaignId, versionId, userId, JSON.stringify([{ id: attachmentId, storage_key: "attempts/archive/evidence.jpg", storage_version_id: "version-1" }]), "b".repeat(64)]);
    const endpoint = `/api/admin/submissions/${submissionId}/attachments/${attachmentId}/restore`;
    const created = await app.inject({ method: "POST", url: endpoint, headers: { ...headers, "idempotency-key": uuidv7() } });
    expect(created.statusCode, created.body).toBe(202);
    expect(created.json()).toMatchObject({ status: "restoring" });
    expect(await runArchiveRestoreJobs({ pool, cos: storage })).toMatchObject({ claimed: 1, ready: 1 });
    expect(calls).toEqual([{ key: "attempts/archive/evidence.jpg", storageVersionId: "version-1" }]);
    const replay = await app.inject({ method: "POST", url: endpoint, headers: { ...headers, "idempotency-key": uuidv7() } });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ status: "ready" });
    await app.close();
  });

  test("projects immutable OCR and final-dish snapshots with archive-aware receipt previews", async () => {
    const storage = { createPreviewUrl: async () => ({ url: "https://private.example.test/receipt-preview", expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
    const { app, headers, assignmentId, campaignId, versionId, userId } = await createAdminApp(storage);
    const attemptId = uuidv7();
    const submissionId = uuidv7();
    const receiptId = uuidv7();
    const candidateId = uuidv7();
    await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
    await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
      VALUES ($1,$2,$3,$4,$5,$6,now(),80,100,2,'[]',$7,'{}','[]',$8,$9,$10)`, [
      submissionId, attemptId, assignmentId, campaignId, versionId, userId,
      JSON.stringify([{ id: uuidv7(), planned_name: "酸菜鱼", actual_name: "酸菜鱼", quantity: 2, unit_price_cents: 1234, line_total_cents: 2468, source: "ocr", manually_modified: true, price_derived: false, review_fields: [] }, { id: uuidv7(), planned_name: "甜品", actual_name: "甜品", quantity: 1, unit_price_cents: 800, line_total_cents: 800, source: "manual", manually_modified: true, price_derived: false, review_fields: [] }]),
      JSON.stringify([{ id: receiptId, display_order: 1, storage_key: "attempts/archive/receipt.jpg" }]),
      JSON.stringify([{ id: candidateId, raw_name: "酸菜鱼", quantity: 1, unit_price_cents: 1234, line_total_cents: 1234 }]), "c".repeat(64),
    ]);
    await pool.query(`INSERT INTO archive_restore_jobs (id,submission_id,attachment_type,attachment_id,requested_by,status,storage_key)
      VALUES ($1,$2,'receipt',$3,$4,'restoring',$5)`, [uuidv7(), submissionId, receiptId, userId, "attempts/archive/receipt.jpg"]);
    const detailUrl = `/api/admin/submissions/${submissionId}`;
    const restoring = await app.inject({ method: "GET", url: detailUrl, headers: { cookie: headers.cookie } });
    expect(restoring.statusCode, restoring.body).toBe(200);
    expect(restoring.json().receiptComparison).toMatchObject({
      receipts: [{ id: receiptId, previewStatus: "restoring", previewUrl: null, thumbnailUrl: null }],
      receiptTotals: { recognizedCents: 1234, finalCents: 3268, differenceCents: 2034 },
      differences: expect.arrayContaining([expect.objectContaining({ kind: "quantity_changed" }), expect.objectContaining({ kind: "manual_added", finalName: "甜品" })]),
    });
    await pool.query("UPDATE archive_restore_jobs SET status='ready',restore_expires_at=now()+INTERVAL '1 hour' WHERE submission_id=$1", [submissionId]);
    const ready = await app.inject({ method: "GET", url: detailUrl, headers: { cookie: headers.cookie } });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.json().receiptComparison.receipts[0]).toMatchObject({ previewStatus: "ready", previewUrl: "https://private.example.test/receipt-preview" });
    await app.close();
  });

  test("lists redacted audit records for an authorized administrator", async () => {
    const { app, headers, userId } = await createAdminApp();
    await pool.query("INSERT INTO audit_logs (id,actor_id,action,subject_type,subject_id,data_json) VALUES ($1,$2,'export_requested','export_job',$3,$4)", [uuidv7(), userId, uuidv7(), JSON.stringify({ storageKey: "must-not-be-returned" })]);
    const response = await app.inject({ method: "GET", url: "/api/admin/audit-logs?limit=20", headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toContainEqual(expect.objectContaining({ actorName: "批次二用户", actionLabel: "已创建导出", subjectLabel: "导出任务", resultLabel: "已完成" }));
    expect(response.body).not.toContain("must-not-be-returned");
    await app.close();
  });

  test("audits admin login, lists export jobs, and scopes audit logs to the last 30 days", async () => {
    const { app, headers } = await createAdminApp();
    // 登录成功写审计（createAdminApp 内已通过真实登录路由进入）
    const loginAudit = await pool.query("SELECT count(*)::int n FROM audit_logs WHERE action='admin_login'");
    expect(loginAudit.rows[0].n).toBeGreaterThanOrEqual(1);
    // 创建导出后，导出中心列表接口可见（此前该接口 404）
    const created = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { kind: "submissions" } });
    expect(created.statusCode, created.body).toBe(202);
    const list = await app.inject({ method: "GET", url: "/api/admin/exports", headers: { cookie: headers.cookie } });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toContainEqual(expect.objectContaining({ status: "queued", createdByName: "批次二用户" }));
    // 重新导出：按原任务参数再建一个任务
    const reexported = await app.inject({ method: "POST", url: `/api/admin/exports/${created.json().id}/reexport`, headers: { ...headers, "idempotency-key": uuidv7() } });
    expect(reexported.statusCode, reexported.body).toBe(202);
    const relisted = await app.inject({ method: "GET", url: "/api/admin/exports", headers: { cookie: headers.cookie } });
    expect(relisted.json().items.filter((item) => item.kind === "submissions")).toHaveLength(2);
    // 审计列表（默认近30天）包含登录与导出动作的中文标签
    const audits = await app.inject({ method: "GET", url: "/api/admin/audit-logs?limit=50", headers: { cookie: headers.cookie } });
    expect(audits.statusCode, audits.body).toBe(200);
    const labels = audits.json().items.map((item) => item.actionLabel);
    expect(labels).toContain("管理员登录后台");
    expect(labels).toContain("已创建导出");
    await app.close();
  });

  test("restricts audit visibility to super admins and auditors only", async () => {
    const { app, headers } = await createAdminApp();
    const stamp = String(Date.now()).slice(-6);
    const createAccount = async (index, kind) => {
      const payload = { kind, username: `Audit${kind}${index}`, displayName: `审计测试${index}`, phone: `139${stamp}${String(index).padStart(2, "0")}`, password: "weak-pass-5" };
      const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: { ...headers, "idempotency-key": uuidv7() }, payload });
      expect(created.statusCode, created.body).toBe(201);
      const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: payload.username, password: "weak-pass-5" } });
      expect(login.statusCode, login.body).toBe(200);
      return { cookie: login.headers["set-cookie"] };
    };
    const plainAdmin = await createAccount(1, "admin");
    const auditor = await createAccount(3, "auditor");
    // 普通管理员：无 audit:read → 403
    const denied = await app.inject({ method: "GET", url: "/api/admin/audit-logs?limit=5", headers: { cookie: plainAdmin.cookie } });
    expect(denied.statusCode).toBe(403);
    // 审计员：200
    const allowed = await app.inject({ method: "GET", url: "/api/admin/audit-logs?limit=5", headers: { cookie: auditor.cookie } });
    expect(allowed.statusCode, allowed.body).toBe(200);
    // 审计员在管理员列表中只出现一次，且带审计员角色标识
    const admins = await app.inject({ method: "GET", url: "/api/admin/users?kind=admin", headers: { cookie: headers.cookie } });
    expect(admins.statusCode, admins.body).toBe(200);
    const auditorRows = admins.json().items.filter((item) => item.username === `Auditauditor3`);
    expect(auditorRows).toHaveLength(1);
    expect(auditorRows[0].roleCode).toBe("auditor");
    await app.close();
  });

  test("keeps expired user records while an active legal hold exists, then purges them after release", async () => {
    const { userId } = await createAssignment();
    const approverId = uuidv7();
    await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,'HoldApprover','holdapprover','保全审批人','cipher','hold-approver',now(),'hash','approved_active')", [approverId]);
    const sessionId = uuidv7();
    const resetId = uuidv7();
    await pool.query(`INSERT INTO auth_sessions (id,user_id,token_hmac,kind,session_version,idle_expires_at,absolute_expires_at,created_at)
      VALUES ($1,$2,$3,'inspector',0,now()-INTERVAL '31 days',now()-INTERVAL '31 days',now()-INTERVAL '31 days')`, [sessionId, userId, `session-${sessionId}`]);
    await pool.query(`INSERT INTO password_reset_tokens (id,user_id,token_hmac,expires_at,created_at)
      VALUES ($1,$2,$3,now()-INTERVAL '31 days',now()-INTERVAL '31 days')`, [resetId, userId, `reset-${resetId}`]);
    const holdId = uuidv7();
    await pool.query(`INSERT INTO legal_holds (id,subject_type,subject_id,reason,requested_by,approved_by,hold_until)
      VALUES ($1,'user',$2,'有效法律保全',$2,$3,now()+INTERVAL '1 day')`, [holdId, userId, approverId]);
    expect(await runRetention({ pool, policyVersion: "hold-active" })).toMatchObject({ sessions: 0, resetTokens: 0, completed: true });
    expect((await pool.query("SELECT id FROM auth_sessions WHERE id=$1", [sessionId])).rows).toHaveLength(1);
    await pool.query("UPDATE legal_holds SET released_at=now(),released_by=$2,release_reason='保全结束' WHERE id=$1", [holdId, approverId]);
    expect(await runRetention({ pool, policyVersion: "hold-released" })).toMatchObject({ sessions: 1, resetTokens: 1, completed: true });
    expect((await pool.query("SELECT id FROM auth_sessions WHERE id=$1", [sessionId])).rows).toHaveLength(0);
  });

  test("records a daily version-aware COS reconciliation and surfaces mismatches without mutating evidence", async () => {
    const { userId, assignmentId, versionId } = await createAssignment();
    const attemptId = uuidv7();
    const attachmentId = uuidv7();
    const sha256 = "d".repeat(64);
    await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
    await pool.query(`INSERT INTO receipt_attachments (id,attempt_id,client_file_id,display_order,storage_key,storage_version_id,upload_nonce,declared_content_type,declared_size_bytes,original_file_name,mime_type,size_bytes,sha256,status,verified_at,created_by)
      VALUES ($1,$2,$3,1,'attempts/reconcile.jpg','version-reconcile',$4,'image/jpeg',12,'reconcile.jpg','image/jpeg',12,$5,'ready',now(),$6)`, [attachmentId, attemptId, uuidv7(), uuidv7(), sha256, userId]);
    const verified = [];
    const cos = { verifyStoredObject: async (input) => { verified.push(input); return { sizeBytes: 12, sha256, storageVersionId: "version-reconcile" }; } };
    await expect(runObjectReconciliation({ pool, cos, policyVersion: "reconcile-v1", sampleSize: 10 })).resolves.toMatchObject({ status: "succeeded", sampled: 1, matched: 1, mismatches: 0 });
    expect(verified).toEqual([{ key: "attempts/reconcile.jpg", storageVersionId: "version-reconcile", expectedSizeBytes: 12, expectedSha256: sha256 }]);
    await expect(runObjectReconciliation({ pool, cos, policyVersion: "reconcile-v1", sampleSize: 10 })).resolves.toEqual({ skipped: "already_completed" });
    await expect(runObjectReconciliation({ pool, cos: { verifyStoredObject: async () => { throw Object.assign(new Error("missing"), { code: "NoSuchKey" }); } }, policyVersion: "reconcile-v2", sampleSize: 10 })).resolves.toMatchObject({ status: "failed", sampled: 1, matched: 0, mismatches: 1 });
    expect((await pool.query("SELECT status,error_code FROM object_reconciliation_runs WHERE policy_version='reconcile-v2'")).rows[0]).toMatchObject({ status: "failed", error_code: "OBJECT_RECONCILIATION_MISMATCH" });
    expect((await pool.query("SELECT status FROM receipt_attachments WHERE id=$1", [attachmentId])).rows[0].status).toBe("ready");
  });

  test("recovers expired submit leases to a snapshot replay or a retryable draft", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
    await pool.query("UPDATE survey_attempts SET status='submitting',submit_token=$2,submitting_since=now()-INTERVAL '2 minutes' WHERE id=$1", [attemptId, uuidv7()]);
    const keyId = uuidv7();
    await pool.query(`INSERT INTO idempotency_keys (id,actor_id,scope,idempotency_key,request_hash,attempt_id,status,locked_by,locked_at,lease_expires_at)
      VALUES ($1,$2,'questionnaire_submit',$3,$4,$5,'processing',$6,now()-INTERVAL '2 minutes',now()-INTERVAL '1 minute')`, [keyId, userId, uuidv7(), "d".repeat(64), attemptId, uuidv7()]);
    expect(await recoverStaleSubmissions({ pool })).toBe(1);
    expect((await pool.query("SELECT status FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].status).toBe("failed");
    expect((await pool.query("SELECT status,failure_code FROM idempotency_keys WHERE id=$1", [keyId])).rows[0]).toMatchObject({ status: "retryable_failed", failure_code: "SUBMIT_RECOVERY_REQUIRED" });
    await app.close();
  });

  test("persists an overdue submit token as terminal even if the assignment is later extended", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
    await pool.query("UPDATE audit_assignments SET due_at=now()-INTERVAL '1 minute',questionnaire_deadline_at=now()-INTERVAL '30 seconds' WHERE id=$1", [assignmentId]);
    const assignmentRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [assignmentId])).rows[0].revision);
    const token = uuidv7();
    const first = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspectorHeaders, payload: { submitToken: token, assignmentRevision, confirmation: true } });
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe("TASK_OVERDUE");
    expect((await pool.query("SELECT status,failure_code FROM idempotency_keys WHERE actor_id=$1 AND idempotency_key=$2", [userId, token])).rows[0]).toMatchObject({ status: "terminal_failed", failure_code: "TASK_OVERDUE" });
    await pool.query("UPDATE audit_assignments SET status='in_progress',due_at=now()+INTERVAL '1 hour' WHERE id=$1", [assignmentId]);
    const replay = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspectorHeaders, payload: { submitToken: token, assignmentRevision, confirmation: true } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("TASK_OVERDUE");
    await app.close();
  });

  test("allows exactly one active exemption under 20 concurrent admin requests", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId, assignmentRevision } = await createExecutableAssignment(app, headers, versionId, userId, regionId);
    const attempts = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: "POST", url: `/api/admin/assignments/${assignmentId}/check-in-exemptions`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { assignmentRevision, reason: "定位服务异常", validForMinutes: 10 } })));
    expect(attempts.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(attempts.filter((response) => response.statusCode === 409)).toHaveLength(19);
    const active = await pool.query("SELECT count(*)::int count FROM checkin_exemptions WHERE assignment_id=$1 AND status='active'", [assignmentId]);
    expect(active.rows[0].count).toBe(1);
    await app.close();
  });

  test("advances an overdue assignment and its campaign atomically when the task is read", async () => {
    const { app, headers, versionId, userId, regionId } = await createAdminApp();
    const { assignmentId } = await createExecutableAssignment(app, headers, versionId, userId, regionId, { startsAt: new Date(Date.now() - 20 * 60_000).toISOString(), dueAt: new Date(Date.now() - 60_000).toISOString() });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "BatchTwo", password: "a-secure-password" } });
    const mine = await app.inject({ method: "GET", url: "/api/assignments/mine", headers: { authorization: `Bearer ${login.json().accessToken}` } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items).toContainEqual(expect.objectContaining({ id: assignmentId, status: "overdue" }));
    const campaign = await pool.query("SELECT c.status FROM audit_campaigns c JOIN audit_assignments a ON a.campaign_id=c.id WHERE a.id=$1", [assignmentId]);
    expect(campaign.rows[0].status).toBe("in_progress");
    await app.close();
  });

  // 门店详情 GET（Admin 深链接/刷新编辑页用）：与列表同权限、同数据范围断言、同行业结构。
  test("store detail GET returns the authorized store row and 404 for unknown ids", async () => {
    const { app, headers } = await createAdminApp();
    const storeId = (await pool.query("SELECT id FROM stores LIMIT 1")).rows[0].id;
    const detail = await app.inject({ method: "GET", url: `/api/admin/stores/${storeId}`, headers: { cookie: headers.cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().store).toMatchObject({ id: storeId, businessNo: "S-001", name: "测试门店", locationVerified: true });
    expect(Number.isInteger(detail.json().store.revision)).toBe(true);
    expect(detail.json().store).toHaveProperty("latitudeGcj02");

    const missing = await app.inject({ method: "GET", url: `/api/admin/stores/${uuidv7()}`, headers: { cookie: headers.cookie } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("STORE_NOT_FOUND");

    const unauthenticated = await app.inject({ method: "GET", url: `/api/admin/stores/${storeId}` });
    expect(unauthenticated.statusCode).toBe(401);
    await app.close();
  });

  // 门店详情 GET 数据范围/角色负向回归：区域范围管理员可读自己覆盖的门店，范围外统一 403
  // （与列表静默过滤/PATCH 断言一致，不泄漏存在性）；无 store:manage 的登录态 403。
  test("store detail GET enforces data scopes and role permissions", async () => {
    const { createPasswordService } = await import("../../apps/api/src/auth/passwords.js");
    const { encrypt, hmac: phoneHmac, normalizePhone } = await import("../../apps/api/src/auth/crypto.js");
    const passwordHash = await createPasswordService().hash("a-secure-password");
    const phoneKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
    const phone = normalizePhone("13811112222");

    const inProvince = uuidv7(); const inCity = uuidv7(); const inDistrict = uuidv7();
    const outProvince = uuidv7(); const outCity = uuidv7(); const outDistrict = uuidv7();
    await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'辖内省','120000',1)", [inProvince]);
    await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'辖内市','120100',$2,2)", [inCity, inProvince]);
    await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'辖内区','120106',$2,3)", [inDistrict, inCity]);
    await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'辖外省','980000',1)", [outProvince]);
    await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'辖外市','980100',$2,2)", [outCity, outProvince]);
    await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'辖外区','980106',$2,3)", [outDistrict, outCity]);
    const inStore = uuidv7(); const outStore = uuidv7();
    await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source) VALUES ($1,'IN-1','辖内门店',$2,'地址',31.1,121.1,'poi')", [inStore, inDistrict]);
    await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source) VALUES ($1,'OUT-1','辖外门店',$2,'地址',31.2,121.2,'poi')", [outStore, outDistrict]);

    // 区域范围管理员（省级三层覆盖辖内区）
    const scopedAdmin = uuidv7();
    await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
      VALUES ($1,'ScopedAdmin','scopedadmin','范围管理员',$3,$4,now(),$2,'approved_active')`, [scopedAdmin, passwordHash, encrypt(phoneKey, phone), phoneHmac(config.AUTH_TOKEN_HMAC_KEY, phone)]);
    const adminRole = await pool.query("SELECT id FROM roles WHERE code = 'admin'");
    await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), scopedAdmin, adminRole.rows[0].id]);
    await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type,region_id) VALUES ($1,$2,'region',$3)", [uuidv7(), scopedAdmin, inProvince]);

    // 探员（已登录但没有 store:manage，也不是 admin 会话）
    const inspector = uuidv7();
    await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
      VALUES ($1,'PlainInspector','plaininspector','普通探员',$3,$4,now(),$2,'approved_active')`, [inspector, passwordHash, encrypt(phoneKey, normalizePhone("13833334444")), phoneHmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13833334444"))]);
    const inspectorRole = await pool.query("SELECT id FROM roles WHERE code = 'inspector'");
    await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspector, inspectorRole.rows[0].id]);

    const app = buildApp({ config, pool, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({}) } });
    const scopedLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "ScopedAdmin", password: "a-secure-password" } });
    expect(scopedLogin.statusCode).toBe(200);
    const scopedHeaders = { cookie: scopedLogin.headers["set-cookie"] };

    const own = await app.inject({ method: "GET", url: `/api/admin/stores/${inStore}`, headers: scopedHeaders });
    expect(own.statusCode).toBe(200);
    expect(own.json().store).toMatchObject({ id: inStore, name: "辖内门店" });

    const foreign = await app.inject({ method: "GET", url: `/api/admin/stores/${outStore}`, headers: scopedHeaders });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("SCOPE_FORBIDDEN");

    const inspectorLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "PlainInspector", password: "a-secure-password" } });
    expect(inspectorLogin.statusCode).toBe(200);
    const forbidden = await app.inject({ method: "GET", url: `/api/admin/stores/${inStore}`, headers: { authorization: `Bearer ${inspectorLogin.json().accessToken}` } });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});

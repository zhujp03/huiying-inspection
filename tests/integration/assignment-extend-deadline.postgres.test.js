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
const test = connectionString ? it.sequential : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
};
const providers = { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test-message" }) };

const MIN = 60_000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const ADMIN_PASSWORD = "A-secure-pass";
const INSPECTOR_PASSWORD = "A-secure-pass";
const CAMPAIGN_NAME = "延期双窗口任务";

async function seedWorld() {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash(ADMIN_PASSWORD);
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  const inspectorId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'ExtendAdmin','extendadmin','延期管理员',$2,$3,now(),$5,'approved_active'),($4,'ExtendInspector','extendinspector','延期探员',$6,$7,now(),$5,'approved_active')`,
    [adminId, encrypt(encryptionKey, normalizePhone("13600000021")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13600000021")), inspectorId, passwordHash, encrypt(encryptionKey, normalizePhone("13800000021")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13800000021"))]);
  const adminRole = await pool.query("SELECT id FROM roles WHERE code = 'admin'");
  const inspectorRole = await pool.query("SELECT id FROM roles WHERE code = 'inspector'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, adminRole.rows[0].id]);
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspectorId, inspectorRole.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-021','延期测试门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  return { adminId, inspectorId, storeId };
}

async function adminHeaders(app) {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "ExtendAdmin", password: ADMIN_PASSWORD } });
  expect(login.statusCode, login.body).toBe(200);
  return { cookie: login.headers["set-cookie"], csrf: login.json().csrfToken };
}

async function inspectorHeaders(app) {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ExtendInspector", password: INSPECTOR_PASSWORD } });
  expect(login.statusCode, login.body).toBe(200);
  return { authorization: `Bearer ${login.json().accessToken}` };
}

// 完整真实链路：新问卷版本（1 道评分题）→ 建任务 → 指派 → 发布（assigned）
async function createPublishedAssignment(app, headers, world, window = {}) {
  const templateId = uuidv7(); const versionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'延期测试问卷','secret',$2)", [templateId, world.adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, world.adminId]);
  await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES (gen_random_uuid(),$1,'q1',1,'environment','门店整洁',2,true,1)", [versionId]);
  const versionPublished = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { cookie: headers.cookie, "x-csrf-token": headers.csrf, "idempotency-key": uuidv7() }, payload: { revision: 0 } });
  expect(versionPublished.statusCode, versionPublished.body).toBe(200);
  const startsAt = window.startsAt || iso(-20 * MIN);
  const dueAt = window.dueAt || iso(2 * 60 * MIN);
  const questionnaireDeadlineAt = window.questionnaireDeadlineAt || iso(2 * 60 * MIN);
  const campaign = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { cookie: headers.cookie, "x-csrf-token": headers.csrf, "idempotency-key": uuidv7() }, payload: { name: CAMPAIGN_NAME, storeId: world.storeId, startsAt, dueAt, questionnaireDeadlineAt, commonInstruction: "" } });
  expect(campaign.statusCode, campaign.body).toBe(201);
  const campaignId = campaign.json().campaign.id;
  const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/assignments`, headers: { cookie: headers.cookie, "x-csrf-token": headers.csrf, "idempotency-key": uuidv7() }, payload: { inspectorId: world.inspectorId, questionnaireVersionId: versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: false, specialInstruction: "", campaignRevision: 0 } });
  expect(assignment.statusCode, assignment.body).toBe(201);
  const assignmentId = assignment.json().id;
  const published = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/publish`, headers: { cookie: headers.cookie, "x-csrf-token": headers.csrf, "idempotency-key": uuidv7() }, payload: { revision: 1 } });
  expect(published.statusCode, published.body).toBe(200);
  const row = await pool.query("SELECT revision,status,questionnaire_deadline_at FROM audit_assignments WHERE id=$1", [assignmentId]);
  return { campaignId, assignmentId, revision: Number(row.rows[0].revision), status: row.rows[0].status, questionnaireDeadlineAt: row.rows[0].questionnaire_deadline_at };
}

async function checkInAndStart(app, inspector, assignmentId) {
  const checkin = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspector, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
  expect(checkin.statusCode, checkin.body).toBe(200);
  expect(checkin.json()).toMatchObject({ result: "accepted" });
  const start = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspector });
  expect(start.statusCode, start.body).toBe(200);
  return start.json().attempt.id;
}

// 探员真实查询动作触发服务端逾期推进（advanceCampaignOverdue 的最真实入口）
async function advanceOverdueViaMine(app, inspector) {
  const mine = await app.inject({ method: "GET", url: "/api/assignments/mine", headers: inspector });
  expect(mine.statusCode, mine.body).toBe(200);
}

const assignmentRow = async (assignmentId) => (await pool.query("SELECT status,revision,due_at,questionnaire_deadline_at,started_at FROM audit_assignments WHERE id=$1", [assignmentId])).rows[0];

// 答题（1 道评分题）+ 亮点 → 提交，断言 200 submitted
async function answerAndSubmit(app, inspector, attemptId, assignmentId) {
  const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspector });
  expect(draft.statusCode, draft.body).toBe(200);
  const questionId = draft.json().questions[0].id;
  const saved = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/answers/${questionId}`, headers: inspector, payload: { answer: "scored", revision: draft.json().attempt.revision } });
  expect(saved.statusCode, saved.body).toBe(200);
  const others = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers: inspector, payload: { highlight: "服务周到，环境干净", suggestion: "", revision: saved.json().revision } });
  expect(others.statusCode, others.body).toBe(200);
  const row = await assignmentRow(assignmentId);
  const submitted = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspector, payload: { submitToken: uuidv7(), assignmentRevision: Number(row.revision), confirmation: true } });
  expect(submitted.statusCode, submitted.body).toBe(200);
  expect(submitted.json()).toMatchObject({ status: "submitted" });
}

const extendAssignment = (app, headers, assignmentId, payload) => app.inject({ method: "POST", url: `/api/admin/assignments/${assignmentId}/extend`, headers: { cookie: headers.cookie, "x-csrf-token": headers.csrf, "idempotency-key": uuidv7() }, payload });

describe.sequential("assignment extend dual window", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-assignment-extend-deadline-tests'))");
    await pool.query("TRUNCATE audit_logs, idempotency_keys, submission_versions, object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,survey_attempts,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,question_categories,brands,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-assignment-extend-deadline-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("recovers a started overdue assignment by extending the questionnaire deadline, then the inspector submits successfully", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const admin = await adminHeaders(app);
    const headers = { cookie: admin.cookie, csrf: admin.csrf };
    const created = await createPublishedAssignment(app, headers, world);
    const inspector = await inspectorHeaders(app);
    const attemptId = await checkInAndStart(app, inspector, created.assignmentId);

    // 已开始（in_progress、started_at 落库）后把两个窗口都拨到过去
    await pool.query("UPDATE audit_assignments SET due_at=$2,questionnaire_deadline_at=$2 WHERE id=$1", [created.assignmentId, iso(-5 * MIN)]);
    // 缺陷复现：问卷截止已过 → 提交被拒
    const blocked = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspector, payload: { submitToken: uuidv7(), assignmentRevision: Number((await assignmentRow(created.assignmentId)).revision), confirmation: true } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("TASK_OVERDUE");
    // 探员查询触发逾期推进 → in_progress 因问卷截止过期转 overdue
    await advanceOverdueViaMine(app, inspector);
    expect((await assignmentRow(created.assignmentId)).status).toBe("overdue");

    // 只延问卷最终截止时间 → 恢复 in_progress
    const newDeadline = iso(90 * MIN);
    const extended = await extendAssignment(app, headers, created.assignmentId, { questionnaireDeadlineAt: newDeadline, revision: Number((await assignmentRow(created.assignmentId)).revision), reason: "问卷收尾补录" });
    expect(extended.statusCode, extended.body).toBe(200);
    expect(extended.json().assignment).toMatchObject({ status: "in_progress" });
    const recovered = await assignmentRow(created.assignmentId);
    expect(recovered.status).toBe("in_progress");
    expect(new Date(recovered.questionnaire_deadline_at).toISOString()).toBe(newDeadline);
    expect(new Date(recovered.due_at).getTime()).toBeLessThan(Date.now()); // due_at 未被改动

    const audit = await pool.query("SELECT data_json FROM audit_logs WHERE action='assignment_extended' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [created.assignmentId]);
    expect(audit.rows[0].data_json).toMatchObject({ campaignId: created.campaignId, campaignName: CAMPAIGN_NAME, dueAt: null, questionnaireDeadlineAt: newDeadline, reason: "问卷收尾补录", recoveredFromOverdue: true });

    // 恢复后探员补录并提交成功（本任务核心验收）
    await answerAndSubmit(app, inspector, attemptId, created.assignmentId);
    expect((await assignmentRow(created.assignmentId)).status).toBe("submitted");
    await app.close();
  });

  test("recovers a not-started overdue assignment by extending dueAt only and keeps the questionnaire deadline untouched", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const admin = await adminHeaders(app);
    const headers = { cookie: admin.cookie, csrf: admin.csrf };
    const created = await createPublishedAssignment(app, headers, world);
    const originalDeadline = created.questionnaireDeadlineAt;
    // 未开始（assigned）：只把执行截止拨到过去
    await pool.query("UPDATE audit_assignments SET due_at=$2 WHERE id=$1", [created.assignmentId, iso(-5 * MIN)]);
    const inspector = await inspectorHeaders(app);
    await advanceOverdueViaMine(app, inspector);
    expect((await assignmentRow(created.assignmentId)).status).toBe("overdue");

    const newDueAt = iso(90 * MIN);
    const extended = await extendAssignment(app, headers, created.assignmentId, { dueAt: newDueAt, revision: Number((await assignmentRow(created.assignmentId)).revision), reason: "暴雨导致到店延迟" });
    expect(extended.statusCode, extended.body).toBe(200);
    expect(extended.json().assignment).toMatchObject({ status: "assigned" });
    const recovered = await assignmentRow(created.assignmentId);
    expect(recovered.status).toBe("assigned");
    expect(new Date(recovered.due_at).toISOString()).toBe(newDueAt);
    expect(new Date(recovered.questionnaire_deadline_at).toISOString()).toBe(new Date(originalDeadline).toISOString()); // 问卷截止未动

    const audit = await pool.query("SELECT data_json FROM audit_logs WHERE action='assignment_extended' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [created.assignmentId]);
    expect(audit.rows[0].data_json).toMatchObject({ dueAt: newDueAt, questionnaireDeadlineAt: null, reason: "暴雨导致到店延迟", recoveredFromOverdue: true });
    await app.close();
  });

  test("rejects a dueAt-only extension for a started assignment whose questionnaire deadline has passed", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const admin = await adminHeaders(app);
    const headers = { cookie: admin.cookie, csrf: admin.csrf };
    const created = await createPublishedAssignment(app, headers, world);
    const inspector = await inspectorHeaders(app);
    await checkInAndStart(app, inspector, created.assignmentId);
    await pool.query("UPDATE audit_assignments SET due_at=$2,questionnaire_deadline_at=$2 WHERE id=$1", [created.assignmentId, iso(-5 * MIN)]);
    await advanceOverdueViaMine(app, inspector);
    expect((await assignmentRow(created.assignmentId)).status).toBe("overdue");

    const rejected = await extendAssignment(app, headers, created.assignmentId, { dueAt: iso(90 * MIN), revision: Number((await assignmentRow(created.assignmentId)).revision), reason: "只延执行窗口" });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("ASSIGNMENT_EXTENSION_INVALID");
    expect(rejected.json().error.message).toContain("问卷");
    const after = await assignmentRow(created.assignmentId);
    expect(after.status).toBe("overdue"); // 拒绝后状态不变
    expect(new Date(after.due_at).getTime()).toBeLessThan(Date.now());
    await app.close();
  });

  test("rejects a questionnaire-deadline-only extension for a not-started overdue assignment", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const admin = await adminHeaders(app);
    const headers = { cookie: admin.cookie, csrf: admin.csrf };
    const created = await createPublishedAssignment(app, headers, world);
    await pool.query("UPDATE audit_assignments SET due_at=$2 WHERE id=$1", [created.assignmentId, iso(-5 * MIN)]);
    const inspector = await inspectorHeaders(app);
    await advanceOverdueViaMine(app, inspector);
    expect((await assignmentRow(created.assignmentId)).status).toBe("overdue");

    const rejected = await extendAssignment(app, headers, created.assignmentId, { questionnaireDeadlineAt: iso(90 * MIN), revision: Number((await assignmentRow(created.assignmentId)).revision), reason: "只延问卷截止" });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.code).toBe("ASSIGNMENT_EXTENSION_INVALID");
    expect(rejected.json().error.message).toContain("执行");
    expect((await assignmentRow(created.assignmentId)).status).toBe("overdue");
    await app.close();
  });

  test("rejects an extension body without any time field (contract refine)", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const admin = await adminHeaders(app);
    const headers = { cookie: admin.cookie, csrf: admin.csrf };
    const created = await createPublishedAssignment(app, headers, world);
    const rejected = await extendAssignment(app, headers, created.assignmentId, { revision: created.revision, reason: "没有任何时间" });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.message).toContain("至少填写一项");
    await app.close();
  });

  test("rejects an extension without reason", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const admin = await adminHeaders(app);
    const headers = { cookie: admin.cookie, csrf: admin.csrf };
    const created = await createPublishedAssignment(app, headers, world);
    const rejected = await extendAssignment(app, headers, created.assignmentId, { revision: created.revision, dueAt: iso(90 * MIN) });
    expect(rejected.statusCode).toBe(422);
    await app.close();
  });

  test("rejects extension for submitted and cancelled assignments", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const admin = await adminHeaders(app);
    const headers = { cookie: admin.cookie, csrf: admin.csrf };
    const inspector = await inspectorHeaders(app);
    // 已提交：走完 提交 → extend 409
    const submittedTask = await createPublishedAssignment(app, headers, world);
    const attemptId = await checkInAndStart(app, inspector, submittedTask.assignmentId);
    await answerAndSubmit(app, inspector, attemptId, submittedTask.assignmentId);
    const submittedRejected = await extendAssignment(app, headers, submittedTask.assignmentId, { dueAt: iso(120 * MIN), revision: Number((await assignmentRow(submittedTask.assignmentId)).revision), reason: "已提交不能延期" });
    expect(submittedRejected.statusCode).toBe(409);
    // 已取消：取消 → extend 409
    const cancelledTask = await createPublishedAssignment(app, headers, world);
    const cancelled = await app.inject({ method: "POST", url: `/api/admin/assignments/${cancelledTask.assignmentId}/cancel`, headers: { cookie: headers.cookie, "x-csrf-token": headers.csrf, "idempotency-key": uuidv7() }, payload: { revision: cancelledTask.revision, reason: "探员临时无法到店" } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const cancelledRejected = await extendAssignment(app, headers, cancelledTask.assignmentId, { dueAt: iso(120 * MIN), revision: Number((await assignmentRow(cancelledTask.assignmentId)).revision), reason: "已取消不能延期" });
    expect(cancelledRejected.statusCode).toBe(409);
    await app.close();
  });

  test("validates extension windows against the campaign and current time", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const admin = await adminHeaders(app);
    const headers = { cookie: admin.cookie, csrf: admin.csrf };
    const created = await createPublishedAssignment(app, headers, world); // campaign due_at = now+2h
    const revision = Number((await assignmentRow(created.assignmentId)).revision);
    // dueAt 超出父执行窗口
    const beyondCampaign = await extendAssignment(app, headers, created.assignmentId, { dueAt: iso(3 * 60 * MIN), revision, reason: "超过父任务截止" });
    expect(beyondCampaign.statusCode).toBe(422);
    expect(beyondCampaign.json().error.code).toBe("ASSIGNMENT_EXTENSION_INVALID");
    // questionnaireDeadlineAt 早于当前时间
    const pastDeadline = await extendAssignment(app, headers, created.assignmentId, { questionnaireDeadlineAt: iso(-5 * MIN), revision, reason: "问卷截止在过去" });
    expect(pastDeadline.statusCode).toBe(422);
    // 两项同填但问卷截止早于执行截止
    const crossed = await extendAssignment(app, headers, created.assignmentId, { dueAt: iso(120 * MIN), questionnaireDeadlineAt: iso(60 * MIN), revision, reason: "问卷截止早于执行截止" });
    expect(crossed.statusCode).toBe(422);
    expect((await assignmentRow(created.assignmentId)).status).toBe("assigned");
    await app.close();
  });

  test("keeps the legacy dueAt-only body working for a not-started assigned assignment (backward compatibility)", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const admin = await adminHeaders(app);
    const headers = { cookie: admin.cookie, csrf: admin.csrf };
    const created = await createPublishedAssignment(app, headers, world);
    const originalDeadline = created.questionnaireDeadlineAt;
    const newDueAt = iso(90 * MIN);
    const extended = await extendAssignment(app, headers, created.assignmentId, { dueAt: newDueAt, revision: created.revision, reason: "旧版客户端延期" });
    expect(extended.statusCode, extended.body).toBe(200);
    expect(extended.json().assignment).toMatchObject({ status: "assigned" });
    const after = await assignmentRow(created.assignmentId);
    expect(new Date(after.due_at).toISOString()).toBe(newDueAt);
    expect(new Date(after.questionnaire_deadline_at).toISOString()).toBe(new Date(originalDeadline).toISOString());
    const audit = await pool.query("SELECT data_json FROM audit_logs WHERE action='assignment_extended' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [created.assignmentId]);
    expect(audit.rows[0].data_json).toMatchObject({ dueAt: newDueAt, questionnaireDeadlineAt: null, recoveredFromOverdue: false });
    await app.close();
  });
});

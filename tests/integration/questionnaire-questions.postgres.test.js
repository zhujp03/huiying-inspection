import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
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

async function seedAdmin(pool) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const adminId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'AdminOne','adminone','测试管理员','cipher','lookup',now(),$2,'approved_active')`,
    [adminId, passwordHash]);
  const role = await pool.query("SELECT id FROM roles WHERE code = 'admin'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, role.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
}

async function adminApp() {
  const app = buildApp({ config, pool, logger: false, providers });
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "AdminOne", password: "A-secure-pass" } });
  expect(login.statusCode).toBe(200);
  return { app, headers: { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken } };
}

async function createDraft(app, headers, questions) {
  const created = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "题目管理问卷", questions } });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().version.id;
}

async function listQuestions(app, headers, versionId) {
  const result = await app.inject({ method: "GET", url: `/api/admin/questionnaire-versions/${versionId}/questions`, headers });
  expect(result.statusCode).toBe(200);
  return result.json().items;
}

// 三题交错分类：环境、为客、环境——用于验证「新增插入到同分类最后一题之后」的重排逻辑。
const interleaved = () => [
  { number: 1, category: "environment", text: "环境题一" },
  { number: 2, category: "service", text: "服务题一" },
  { number: 3, category: "environment", text: "环境题二" },
];

// 为「已作答题不可删除」用例准备：草稿版本 + 指派 + 尝试 + 一条已作答记录。
async function seedAnsweredQuestion(versionId, questionId) {
  const userId = uuidv7();
  const regionId = uuidv7();
  const storeId = uuidv7();
  const campaignId = uuidv7();
  const assignmentId = uuidv7();
  const attemptId = uuidv7();
  await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,'Inspector','inspector','探员','cipher-inspector','lookup-inspector',now(),$2,'approved_active')", [userId, await createPasswordService().hash("a-secure-password")]);
  const provinceId = uuidv7();
  const cityId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-Q','问卷测试门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, userId]);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-Q','问卷任务',$2,now(),now()+interval '1 hour',now()+interval '2 hour','draft',$3)", [campaignId, storeId, userId]);
  await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,questionnaire_deadline_at,budget_limit_cents,status,created_by) VALUES ($1,'A-Q',$2,$3,$4,'secret',now(),now()+interval '1 hour',now()+interval '2 hour',0,'in_progress',$5)", [assignmentId, campaignId, userId, versionId, userId]);
  await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
  await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score) VALUES ($1,$2,'scored',0)", [attemptId, questionId]);
}

describe.sequential("questionnaire question management", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-questionnaire-questions-tests'))");
    await pool.query("TRUNCATE questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, survey_attempts, question_answers, question_answer_edit_sessions, question_evidence_attachments, checkin_exemptions, audit_checkins, assignment_dish_requirements, audit_assignments, audit_campaigns, brands, stores, regions, auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    await seedAdmin(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-questionnaire-questions-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("adds a question after the last question of its category and renumbers", async () => {
    const { app, headers } = await adminApp();
    const versionId = await createDraft(app, headers, interleaved());
    const added = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/questions`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { category: "environment", text: "新增环境题", maxScore: 3 } });
    expect(added.statusCode, added.body).toBe(201);
    const rows = await listQuestions(app, headers, versionId);
    // 展示顺序不变（新增环境题排在同分类最后一题「环境题二」之后 = 全局末尾），题号整体 1..N
    expect(rows.map((row) => [row.number, row.category])).toEqual([[1, "environment"], [2, "service"], [3, "environment"], [4, "environment"]]);
    expect(rows[3]).toMatchObject({ text: "新增环境题", maxScore: 3, enabled: true });
    // 原有题目的 question_key 保持不变（重排只动 sort_order 与 question_number）
    const keys = await pool.query("SELECT question_number,question_key FROM questions WHERE version_id=$1 ORDER BY question_number", [versionId]);
    expect(keys.rows.map((row) => row.question_key)).toEqual(["q1", "q2", "q3", expect.stringMatching(/^q_/)]);
    await app.close();
  });

  test("deletes a middle question and renumbers the rest", async () => {
    const { app, headers } = await adminApp();
    const versionId = await createDraft(app, headers, interleaved());
    const rows = await listQuestions(app, headers, versionId);
    const target = rows.find((row) => row.category === "service");
    const wrongRevision = await app.inject({ method: "DELETE", url: `/api/admin/questionnaire-versions/${versionId}/questions/${target.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: target.revision + 5 } });
    expect(wrongRevision.statusCode).toBe(409);
    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/questionnaire-versions/${versionId}/questions/${target.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: target.revision } });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const after = await listQuestions(app, headers, versionId);
    expect(after.map((row) => [row.number, row.text])).toEqual([[1, "环境题一"], [2, "环境题二"]]);
    const versionRow = await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [versionId]);
    const published = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: Number(versionRow.rows[0].revision) } });
    expect(published.statusCode, published.body).toBe(200);
    await app.close();
  });

  test("moves a question within its category and no-ops at the edge", async () => {
    const { app, headers } = await adminApp();
    const versionId = await createDraft(app, headers, interleaved());
    const rows = await listQuestions(app, headers, versionId);
    // 服务分类只有一题：上移为无操作
    const service = rows.find((row) => row.category === "service");
    const noOp = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/questions/${service.id}/move`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: service.revision, direction: "up" } });
    expect(noOp.statusCode, noOp.body).toBe(200);
    expect(noOp.json().question.number).toBe(service.number);
    // 环境第二题上移：与第一道环境题交换
    const second = rows.filter((row) => row.category === "environment")[1];
    const moved = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/questions/${second.id}/move`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: second.revision, direction: "up" } });
    expect(moved.statusCode, moved.body).toBe(200);
    const after = await listQuestions(app, headers, versionId);
    expect(after.map((row) => [row.number, row.text])).toEqual([[1, "环境题二"], [2, "环境题一"], [3, "服务题一"]]);
    await app.close();
  });

  test("toggling a question keeps enabled numbering contiguous", async () => {
    const { app, headers } = await adminApp();
    const versionId = await createDraft(app, headers, [
      { number: 1, category: "environment", text: "环境题一" },
      { number: 2, category: "environment", text: "环境题二" },
      { number: 3, category: "service", text: "服务题一" },
    ]);
    const rows = await listQuestions(app, headers, versionId);
    const second = rows[1];
    const disabled = await app.inject({ method: "PATCH", url: `/api/admin/questionnaire-versions/${versionId}/questions/${second.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: second.revision, enabled: false } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    let after = await listQuestions(app, headers, versionId);
    // 启用题保持 1..M 连续，停用题编号排在其后
    expect(after.map((row) => [row.number, row.enabled, row.text])).toEqual([[1, true, "环境题一"], [2, true, "服务题一"], [3, false, "环境题二"]]);
    const versionRow = await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [versionId]);
    const published = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: Number(versionRow.rows[0].revision) } });
    expect(published.statusCode, published.body).toBe(200);
    await app.close();
  });

  test("rejects structure changes on a published version", async () => {
    const { app, headers } = await adminApp();
    const versionId = await createDraft(app, headers, interleaved());
    const versionRow = await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [versionId]);
    const published = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: Number(versionRow.rows[0].revision) } });
    expect(published.statusCode).toBe(200);
    const rows = await listQuestions(app, headers, versionId);
    const first = rows[0];
    const added = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/questions`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { category: "environment", text: "冻结后新增" } });
    expect(added.statusCode).toBe(409);
    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/questionnaire-versions/${versionId}/questions/${first.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: first.revision } });
    expect(deleted.statusCode).toBe(409);
    const moved = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/questions/${first.id}/move`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: first.revision, direction: "down" } });
    expect(moved.statusCode).toBe(409);
    await app.close();
  });

  test("publishes more than 50 questions", async () => {
    const { app, headers } = await adminApp();
    const questions = Array.from({ length: 60 }, (_, index) => ({ number: index + 1, category: index < 20 ? "environment" : index < 42 ? "service" : "product", text: `第 ${index + 1} 题` }));
    const versionId = await createDraft(app, headers, questions);
    const versionRow = await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [versionId]);
    const published = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: Number(versionRow.rows[0].revision) } });
    expect(published.statusCode, published.body).toBe(200);
    const added = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/questions`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { category: "product", text: "第 61 题" } });
    expect(added.statusCode).toBe(409);
    await app.close();
  });

  test("rejects deleting a question that already has answers, but allows disabling", async () => {
    const { app, headers } = await adminApp();
    const versionId = await createDraft(app, headers, interleaved());
    const rows = await listQuestions(app, headers, versionId);
    const target = rows[0];
    await seedAnsweredQuestion(versionId, target.id);
    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/questionnaire-versions/${versionId}/questions/${target.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: target.revision } });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error?.code ?? deleted.json().code).toBe("QUESTION_DELETE_NOT_ALLOWED");
    const disabled = await app.inject({ method: "PATCH", url: `/api/admin/questionnaire-versions/${versionId}/questions/${target.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: Number((await pool.query("SELECT revision FROM questions WHERE id=$1", [target.id])).rows[0].revision), enabled: false } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    await app.close();
  });
});

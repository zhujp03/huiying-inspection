import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

// 分数清零题端到端：提交计分落库（batch3 applyScoreWipe → submission_versions/submission_question_scores）
// 与管理端语义（发布守卫/copy 保真/PATCH 开关，batch2 scoreWipe）。
// createAdminApp/createExecutableAssignment 是 tests/integration/submit-recovery.postgres.test.js
// 文件内 helper 的最小副本：该文件不导出 helper，且本任务禁改现有文件。

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", API_REQUEST_TIMEOUT_MS: 12000, AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
};

// 三题问卷：环境清零题(2) + 环境普通题(3) + 服务普通题(5)，满分 10。
const scoreWipeQuestions = () => [
  { number: 1, category: "environment", text: "环境清零题", maxScore: 2, scoreWipe: true },
  { number: 2, category: "environment", text: "环境普通题", maxScore: 3 },
  { number: 3, category: "service", text: "服务普通题", maxScore: 5 },
];

// 管理员兼探员（super_admin 同时覆盖题目/任务两端权限）+ 区域/门店，返回已登录的 admin 会话。
async function createAdminApp() {
  const userId = uuidv7();
  const regionId = uuidv7();
  const storeId = uuidv7();
  // 手机号必须用真实加密格式：用户列表接口会对密文解密做脱敏，占位假密文会导致 500
  const { encrypt, hmac: phoneHmac, normalizePhone } = await import("../../apps/api/src/auth/crypto.js");
  const phoneKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const normalizedPhone = normalizePhone("13800000010");
  await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,'WipeAdmin','wipeadmin','清零管理员',$3,$4,now(),$2,'approved_active')", [userId, await createPasswordService().hash("a-secure-password"), encrypt(phoneKey, normalizedPhone), phoneHmac(config.AUTH_TOKEN_HMAC_KEY, normalizedPhone)]);
  const superAdmin = await pool.query("SELECT id FROM roles WHERE code = 'super_admin'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), userId, superAdmin.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), userId]);
  const provinceId = uuidv7(); const cityId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-WIPE','清零测试门店',$2,'测试地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, userId]);
  // 导出创建接口要求 cos.exportConfigured；测试替身默认视为已配置
  const app = buildApp({ config, pool, storage: { exportConfigured: true }, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test" }) } });
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "WipeAdmin", password: "a-secure-password" } });
  expect(login.statusCode).toBe(200);
  return { userId, regionId, app, headers: { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken, "idempotency-key": uuidv7() } };
}

async function createDraft(app, headers, questions, name) {
  const created = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name, questions } });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().version.id;
}

async function listQuestions(app, headers, versionId) {
  const result = await app.inject({ method: "GET", url: `/api/admin/questionnaire-versions/${versionId}/questions`, headers });
  expect(result.statusCode).toBe(200);
  return result.json().items;
}

async function publishVersion(app, headers, versionId) {
  const versionRow = await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [versionId]);
  return app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: Number(versionRow.rows[0].revision) } });
}

// 发布版本 → 建任务/指派并发布 → 探员登录/打卡/开卷，返回提交所需的全部句柄。
async function executableAttempt(app, headers, versionId, inspectorId, regionId) {
  expect((await publishVersion(app, headers, versionId)).statusCode).toBe(200);
  const startsAt = new Date(Date.now() - 60_000).toISOString();
  const dueAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const store = await pool.query("SELECT id FROM stores WHERE region_id=$1", [regionId]);
  const campaign = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "清零现场任务", storeId: store.rows[0].id, startsAt, dueAt, questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "现场执行" } });
  expect(campaign.statusCode, campaign.body).toBe(201);
  const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/assignments`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { inspectorId, questionnaireVersionId: versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: false, specialInstruction: "", campaignRevision: 0 } });
  expect(assignment.statusCode, assignment.body).toBe(201);
  const campaignPublished = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 1 } });
  expect(campaignPublished.statusCode, campaignPublished.body).toBe(200);
  const assignmentId = assignment.json().id;
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "WipeAdmin", password: "a-secure-password" } });
  expect(login.statusCode).toBe(200);
  const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
  expect((await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } })).statusCode).toBe(200);
  const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
  // GET /api/assignments/:id 的响应不暴露 assignment revision，沿用 batch2 集成测试的直查方式；
  // 打卡会把任务推入 in_progress 并推高 revision，必须在 start 之后读取才能与提交时的 revision 对上。
  const assignmentRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [assignmentId])).rows[0].revision);
  return { assignmentId, assignmentRevision, attemptId, inspectorHeaders };
}

// 作答直插 question_answers（awarded_score 即「作答时原始值」），补齐提交必填的亮点记录后走真实提交接口。
async function saveAnswersAndSubmit(app, inspectorHeaders, attemptId, assignmentRevision, answers) {
  for (const item of answers) {
    await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,$3,$4,$5)", [attemptId, item.questionId, item.answer, item.awardedScore, item.remark ?? ""]);
  }
  await pool.query("INSERT INTO other_records (attempt_id,highlight) VALUES ($1,$2)", [attemptId, "服务讲解细致，环境整洁"]);
  const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspectorHeaders, payload: { submitToken: uuidv7(), assignmentRevision, confirmation: true } });
  expect(submit.statusCode, submit.body).toBe(200);
  return submit.json();
}

function questionMap(rows) {
  return new Map(rows.map((row) => [row.question_id, row]));
}

describe.sequential("questionnaire score wipe", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-score-wipe-tests'))");
    await pool.query("TRUNCATE submission_question_scores, submission_versions, receipt_ocr_candidates, receipt_ocr_jobs, receipt_attachments, dish_records, other_records, idempotency_keys, audit_logs, question_answer_edit_session_removals, question_evidence_attachments, question_answer_edit_sessions, question_answers, survey_attempts, checkin_exemptions, audit_checkins, assignment_dish_requirements, audit_assignments, audit_campaigns, question_evidence_requirements, questions, questionnaire_versions, questionnaire_templates, question_categories, brands, stores, regions, auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    // 分类种子（code 与生产迁移一致）：发布守卫消息与分类展示名断言依赖这些 name
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-score-wipe-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("wipe triggered: unscored wipe question zeroes its whole category but keeps other categories", async () => {
    const { userId, regionId, app, headers } = await createAdminApp();
    const versionId = await createDraft(app, headers, scoreWipeQuestions(), "清零触发问卷");
    const { attemptId, assignmentRevision, inspectorHeaders } = await executableAttempt(app, headers, versionId, userId, regionId);
    const rows = await listQuestions(app, headers, versionId);
    const wipe = rows.find((row) => row.scoreWipe);
    const envNormal = rows.find((row) => row.category === "environment" && !row.scoreWipe);
    const service = rows.find((row) => row.category === "service");
    const response = await saveAnswersAndSubmit(app, inspectorHeaders, attemptId, assignmentRevision, [
      { questionId: wipe.id, answer: "unscored", awardedScore: 0, remark: "设备故障无法评分" },
      { questionId: envNormal.id, answer: "scored", awardedScore: 3 },
      { questionId: service.id, answer: "scored", awardedScore: 5 },
    ]);
    expect(response).toMatchObject({ status: "submitted" });
    const submission = await pool.query("SELECT id,total_score,max_score,issue_count,answer_snapshot_json FROM submission_versions WHERE attempt_id=$1", [attemptId]);
    expect(submission.rows).toHaveLength(1);
    expect(submission.rows[0]).toMatchObject({ total_score: 5, max_score: 10, issue_count: 1 });
    // 逐题得分明细：被清零分类两行 awarded_score 均 0（普通题 answer 仍记 scored），未清零分类照常计满分
    const scores = await pool.query("SELECT question_id,answer,awarded_score,max_score FROM submission_question_scores WHERE submission_id=$1", [submission.rows[0].id]);
    expect(scores.rows).toHaveLength(3);
    const scoreByQuestion = questionMap(scores.rows);
    expect(scoreByQuestion.get(wipe.id)).toMatchObject({ answer: "unscored", awarded_score: 0, max_score: 2 });
    expect(scoreByQuestion.get(envNormal.id)).toMatchObject({ answer: "scored", awarded_score: 0, max_score: 3 });
    expect(scoreByQuestion.get(service.id)).toMatchObject({ answer: "scored", awarded_score: 5, max_score: 5 });
    // 快照保留 question_answers 原始行：环境普通题 awarded_score 仍是作答时的 3，未被清零改写
    const snapshotByQuestion = questionMap(submission.rows[0].answer_snapshot_json);
    expect(snapshotByQuestion.get(envNormal.id)).toMatchObject({ answer: "scored", awarded_score: 3 });
    expect(snapshotByQuestion.get(wipe.id)).toMatchObject({ answer: "unscored", awarded_score: 0, issue_remark: "设备故障无法评分" });
    await app.close();
  });

  test("wipe not triggered: scored wipe question keeps the legacy full-score accounting", async () => {
    const { userId, regionId, app, headers } = await createAdminApp();
    const versionId = await createDraft(app, headers, scoreWipeQuestions(), "清零基线问卷");
    const { attemptId, assignmentRevision, inspectorHeaders } = await executableAttempt(app, headers, versionId, userId, regionId);
    const rows = await listQuestions(app, headers, versionId);
    const wipe = rows.find((row) => row.scoreWipe);
    const envNormal = rows.find((row) => row.category === "environment" && !row.scoreWipe);
    const service = rows.find((row) => row.category === "service");
    await saveAnswersAndSubmit(app, inspectorHeaders, attemptId, assignmentRevision, [
      { questionId: wipe.id, answer: "scored", awardedScore: 2 },
      { questionId: envNormal.id, answer: "scored", awardedScore: 3 },
      { questionId: service.id, answer: "scored", awardedScore: 5 },
    ]);
    const submission = await pool.query("SELECT id,total_score,max_score,issue_count FROM submission_versions WHERE attempt_id=$1", [attemptId]);
    expect(submission.rows).toHaveLength(1);
    expect(submission.rows[0]).toMatchObject({ total_score: 10, max_score: 10, issue_count: 0 });
    const scores = await pool.query("SELECT question_id,answer,awarded_score,max_score FROM submission_question_scores WHERE submission_id=$1", [submission.rows[0].id]);
    const scoreByQuestion = questionMap(scores.rows);
    expect(scoreByQuestion.get(wipe.id)).toMatchObject({ answer: "scored", awarded_score: 2, max_score: 2 });
    expect(scoreByQuestion.get(envNormal.id)).toMatchObject({ answer: "scored", awarded_score: 3, max_score: 3 });
    expect(scoreByQuestion.get(service.id)).toMatchObject({ answer: "scored", awarded_score: 5, max_score: 5 });
    await app.close();
  });

  test("publish guard: two scoreWipe questions in one category are rejected with the category display name", async () => {
    const { app, headers } = await createAdminApp();
    const versionId = await createDraft(app, headers, [
      { number: 1, category: "environment", text: "环境清零题一", maxScore: 2, scoreWipe: true },
      { number: 2, category: "environment", text: "环境清零题二", maxScore: 3, scoreWipe: true },
      { number: 3, category: "service", text: "服务普通题", maxScore: 5 },
    ], "清零冲突问卷");
    const published = await publishVersion(app, headers, versionId);
    expect(published.statusCode, published.body).toBe(422);
    expect(published.json().error.code).toBe("QUESTIONNAIRE_PUBLISH_GUARD");
    // 冲突分类以展示名进入消息（scoreWipeConflicts.join("、")），证明守卫因清零冲突而非其他原因拦截；
    // HTTP 错误封套只透传 retryable/requiresNewToken，details.check 本体由 tests/unit/domain.test.js 覆盖。
    expect(published.json().error.message).toContain("环境卫生");
    expect(published.json().error.message).toContain("已有多道分数清零题");
    // 守卫拦截后版本保持草稿
    const status = await pool.query("SELECT status FROM questionnaire_versions WHERE id=$1", [versionId]);
    expect(status.rows[0].status).toBe("draft");
    await app.close();
  });

  test("copy preserves the scoreWipe flag per question into the new draft", async () => {
    const { app, headers } = await createAdminApp();
    const versionId = await createDraft(app, headers, scoreWipeQuestions(), "清零复制问卷");
    expect((await publishVersion(app, headers, versionId)).statusCode).toBe(200);
    const copied = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/copy`, headers: { ...headers, "idempotency-key": uuidv7() } });
    expect(copied.statusCode, copied.body).toBe(201);
    expect(copied.json().version).toMatchObject({ status: "draft" });
    const items = await listQuestions(app, headers, copied.json().version.id);
    expect(items.map((row) => [row.text, row.scoreWipe, row.maxScore])).toEqual([
      ["环境清零题", true, 2],
      ["环境普通题", false, 3],
      ["服务普通题", false, 5],
    ]);
    await app.close();
  });

  test("PATCH toggles scoreWipe on a draft question and back off", async () => {
    const { app, headers } = await createAdminApp();
    const versionId = await createDraft(app, headers, scoreWipeQuestions().map(({ scoreWipe: _scoreWipe, ...question }) => question), "清零开关问卷");
    let items = await listQuestions(app, headers, versionId);
    expect(items.map((row) => row.scoreWipe)).toEqual([false, false, false]);
    const target = items[1];
    const enabled = await app.inject({ method: "PATCH", url: `/api/admin/questionnaire-versions/${versionId}/questions/${target.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: target.revision, scoreWipe: true } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().question).toMatchObject({ scoreWipe: true });
    items = await listQuestions(app, headers, versionId);
    expect(items.find((row) => row.id === target.id).scoreWipe).toBe(true);
    // 用开启后的新 revision 再关掉，验证开关可取消
    const current = items.find((row) => row.id === target.id);
    const disabled = await app.inject({ method: "PATCH", url: `/api/admin/questionnaire-versions/${versionId}/questions/${target.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: current.revision, scoreWipe: false } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().question).toMatchObject({ scoreWipe: false });
    items = await listQuestions(app, headers, versionId);
    expect(items.find((row) => row.id === target.id).scoreWipe).toBe(false);
    await app.close();
  });
});

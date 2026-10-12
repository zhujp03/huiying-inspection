import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "vitest";
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
const storage = {
  newObjectSuffix: () => "test-object",
  createPostTarget: ({ key }) => ({ method: "POST", url: "https://private.example.test", fileFieldName: "file", formData: { key }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  verifyObject: async ({ expectedSizeBytes }) => ({ sizeBytes: expectedSizeBytes, mimeType: "image/jpeg", sha256: "a".repeat(64), storageVersionId: "version-one", durationSeconds: null }),
  createPreviewUrl: async (key) => ({ url: `https://preview.example/${key}`, expiresAt: "2030-01-01T00:00:00.000Z" }),
};

async function seedWorld(pool) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  const inspectorId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'AdminOne','adminone','管理员',$2,$3,now(),$4,'approved_active'),($5,'InspectorOne','inspectorone','探员',$6,$7,now(),$4,'approved_active')`,
    [adminId, encrypt(encryptionKey, normalizePhone("13600000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13600000000")), passwordHash, inspectorId, encrypt(encryptionKey, normalizePhone("13800000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13800000000"))]);
  const adminRole = await pool.query("SELECT id FROM roles WHERE code = 'admin'");
  const inspectorRole = await pool.query("SELECT id FROM roles WHERE code = 'inspector'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, adminRole.rows[0].id]);
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspectorId, inspectorRole.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-001','测试门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  // 问卷：单题带图片证据要求（image_min_count=1，audio 不要求）
  const templateId = uuidv7(); const versionId = uuidv7(); const questionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'测试问卷','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES ($1,$2,'q1',1,'environment','测试题',2,true,1)`, [questionId, versionId]);
  await pool.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
    VALUES ($1,true,true,false,1,0,3,10)`, [questionId]);
  const campaignId = uuidv7(); const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-001','测试任务',$2,$3,$4,$5,'published',$6)", [campaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), adminId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by)
    VALUES ($1,'A-001',$2,$3,$4,'secret',$5,$6,0,'assigned',$7)`, [assignmentId, campaignId, inspectorId, versionId, startsAt, dueAt, adminId]);
  return { adminId, inspectorId, questionId, assignmentId };
}

async function inspectorAttempt(app, assignmentId) {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } });
  const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
  await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
  const started = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders });
  return { inspectorHeaders, attemptId: started.json().attempt.id };
}

const createEditSession = (app, { attemptId, questionId, headers, baseAnswerRevision }) => app.inject({
  method: "POST",
  url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions`,
  headers,
  payload: { baseAnswerRevision, targetAnswer: "unscored" },
});

// 上传一张图片并 complete 到 staged_ready（complete 使 attempt revision +1，返回最新 revision）。
async function stageImage(app, { attemptId, questionId, editSessionId, headers, sizeBytes }) {
  const init = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${editSessionId}/evidence-uploads`, headers, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes } });
  expect(init.statusCode, init.body).toBe(201);
  const completed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${editSessionId}/evidence-uploads/${init.json().attachmentId}/complete`, headers, payload: { uploadToken: init.json().uploadToken, sizeBytes } });
  expect(completed.statusCode, completed.body).toBe(200);
  return { attachmentId: init.json().attachmentId, uploadToken: init.json().uploadToken };
}

// 完整确认链：开编辑会话 → 上传图片 staged_ready → PATCH 说明 → confirm unscored（附件转 active）。
// 返回 { editSessionId, attachmentId, answerRevision }（confirm 后的 attempt revision）。
async function confirmUnscoredWithImage(app, { attemptId, questionId, headers, remark, sizeBytes }) {
  const created = await createEditSession(app, { attemptId, questionId, headers, baseAnswerRevision: 0 });
  expect(created.statusCode, created.body).toBe(200);
  const editSessionId = created.json().id;
  const { attachmentId } = await stageImage(app, { attemptId, questionId, editSessionId, headers, sizeBytes });
  const attemptRevision = Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision);
  const patched = await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${editSessionId}`, headers, payload: { draftIssueRemark: remark, revision: attemptRevision } });
  expect(patched.statusCode, patched.body).toBe(200);
  const confirmed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${editSessionId}/confirm`, headers, payload: { answer: "unscored", revision: attemptRevision } });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  // create 的 baseAnswerRevision 校验的是答案行 revision（confirm 时首次 INSERT 默认 0），不是 attempt revision
  const answerRevision = Number((await pool.query("SELECT revision FROM question_answers WHERE attempt_id=$1 AND question_id=$2", [attemptId, questionId])).rows[0].revision);
  return { editSessionId, attachmentId, answerRevision };
}

const attachmentCount = async (attemptId, questionId) => Number((await pool.query("SELECT count(*)::int count FROM question_evidence_attachments WHERE attempt_id=$1 AND question_id=$2", [attemptId, questionId])).rows[0].count);

describe.sequential("edit session recovery", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-edit-session-recovery-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-edit-session-recovery-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("re-creating on the same question recovers the existing open session instead of 409", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const first = await createEditSession(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, baseAnswerRevision: 0 });
    expect(first.statusCode, first.body).toBe(200);
    const firstSession = first.json();
    // PATCH 写入说明后刷新重进：恢复路径必须带回已保存的说明
    expect((await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${firstSession.id}`, headers: inspectorHeaders, payload: { draftIssueRemark: "地面有水渍", revision: 0 } })).statusCode).toBe(200);
    const again = await createEditSession(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, baseAnswerRevision: 0 });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(firstSession.id);
    expect(again.json().status).toBe("open");
    expect(again.json().draftIssueRemark).toBe("地面有水渍");
    expect(again.json().activeAttachments).toEqual(firstSession.activeAttachments);
    // 数据库仍只有一个 open 会话
    expect(Number((await pool.query("SELECT count(*)::int count FROM question_answer_edit_sessions WHERE attempt_id=$1 AND question_id=$2 AND status='open'", [attemptId, world.questionId])).rows[0].count)).toBe(1);
    await app.close();
  });

  test("creating after an explicit cancel starts a fresh session", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const first = await createEditSession(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, baseAnswerRevision: 0 });
    expect(first.statusCode, first.body).toBe(200);
    const firstSessionId = first.json().id;
    const cancelled = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${firstSessionId}/cancel`, headers: inspectorHeaders });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const second = await createEditSession(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, baseAnswerRevision: 0 });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().status).toBe("open");
    expect(second.json().id).not.toBe(firstSessionId);
    await app.close();
  });

  test("cancelling a new session leaves the confirmed answer and active attachments untouched", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const { attachmentId, answerRevision } = await confirmUnscoredWithImage(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, remark: "地面有水渍", sizeBytes: 100 });
    const reopened = await createEditSession(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, baseAnswerRevision: answerRevision });
    expect(reopened.statusCode, reopened.body).toBe(200);
    const cancelled = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${reopened.json().id}/cancel`, headers: inspectorHeaders });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(draft.statusCode, draft.body).toBe(200);
    const answer = draft.json().answers[world.questionId];
    expect(answer.answer).toBe("unscored");
    expect(answer.remark).toBe("地面有水渍");
    expect(answer.attachments).toHaveLength(1);
    expect(answer.attachments[0]).toMatchObject({ id: attachmentId, type: "image", status: "active", previewUrl: expect.stringContaining("https://preview.example/") });
    expect((await pool.query("SELECT status FROM question_evidence_attachments WHERE id=$1", [attachmentId])).rows[0].status).toBe("active");
    await app.close();
  });

  test("recovery returns already-confirmed active attachments without duplicating attachment rows", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const { attachmentId, answerRevision } = await confirmUnscoredWithImage(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, remark: "地面有水渍", sizeBytes: 100 });
    const reopened = await createEditSession(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, baseAnswerRevision: answerRevision });
    expect(reopened.statusCode, reopened.body).toBe(200);
    const reopenedSession = reopened.json();
    // 二次 create 撞 open 唯一索引 → 恢复：active 附件恰为已确认附件，且不产生新的附件行
    const again = await createEditSession(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, baseAnswerRevision: answerRevision });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(reopenedSession.id);
    expect(again.json().activeAttachments).toHaveLength(1);
    expect(again.json().activeAttachments[0]).toMatchObject({ id: attachmentId, type: "image", mimeType: "image/jpeg", sizeBytes: 100, status: "active" });
    expect(await attachmentCount(attemptId, world.questionId)).toBe(1);
    await app.close();
  });

  test("expired open sessions still start fresh and sweep their staged evidence", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const first = await createEditSession(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, baseAnswerRevision: 0 });
    expect(first.statusCode, first.body).toBe(200);
    const firstSessionId = first.json().id;
    const staged = await stageImage(app, { attemptId, questionId: world.questionId, editSessionId: firstSessionId, headers: inspectorHeaders, sizeBytes: 100 });
    // 把 open 会话改到过去 → 下次 create 应清扫过期会话并废弃其 staged 证据，开出新会话（现行为，固化防回退）。
    // CHECK (expires_at > created_at)：同时回拨 created_at。
    await pool.query("UPDATE question_answer_edit_sessions SET created_at=now()-INTERVAL '1 hour', expires_at=now()-INTERVAL '1 second' WHERE id=$1", [firstSessionId]);
    const second = await createEditSession(app, { attemptId, questionId: world.questionId, headers: inspectorHeaders, baseAnswerRevision: 0 });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().id).not.toBe(firstSessionId);
    const oldSession = (await pool.query("SELECT status FROM question_answer_edit_sessions WHERE id=$1", [firstSessionId])).rows[0];
    expect(oldSession.status).toBe("expired");
    const stagedRow = (await pool.query("SELECT status FROM question_evidence_attachments WHERE id=$1", [staged.attachmentId])).rows[0];
    expect(stagedRow.status).toBe("deleted");
    expect(Number((await pool.query("SELECT count(*)::int count FROM object_cleanup_jobs WHERE attachment_id=$1", [staged.attachmentId])).rows[0].count)).toBe(1);
    await app.close();
  });
});

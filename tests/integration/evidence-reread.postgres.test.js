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
let previewCalls = 0;
const storage = {
  newObjectSuffix: () => "test-object",
  createPostTarget: ({ key }) => ({ method: "POST", url: "https://private.example.test", fileFieldName: "file", formData: { key }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  verifyObject: async ({ expectedSizeBytes }) => ({ sizeBytes: expectedSizeBytes, mimeType: "image/jpeg", sha256: "a".repeat(64), storageVersionId: "version-one", durationSeconds: null }),
  createPreviewUrl: async (key) => {
    previewCalls += 1;
    return { url: `https://preview.example/${key}`, expiresAt: "2030-01-01T00:00:00.000Z" };
  },
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
  // 问卷：两道题都要求图片证据（q1 用于确认 active，q2 用于验证 staged 不回读）
  const templateId = uuidv7(); const versionId = uuidv7(); const questionOne = uuidv7(); const questionTwo = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'测试问卷','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES
    ($1,$2,'q1',1,'environment','测试题一',2,true,1),($3,$2,'q2',2,'environment','测试题二',2,true,2)`, [questionOne, versionId, questionTwo]);
  await pool.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
    VALUES ($1,true,true,false,1,0,3,10),($2,true,true,false,1,0,3,10)`, [questionOne, questionTwo]);
  const campaignId = uuidv7(); const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-001','测试任务',$2,$3,$4,$5,'published',$6)", [campaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), adminId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by)
    VALUES ($1,'A-001',$2,$3,$4,'secret',$5,$6,0,'assigned',$7)`, [assignmentId, campaignId, inspectorId, versionId, startsAt, dueAt, adminId]);
  return { adminId, inspectorId, questionOne, questionTwo, assignmentId };
}

async function inspectorAttempt(app, assignmentId) {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } });
  const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
  await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
  const started = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders });
  return { inspectorHeaders, attemptId: started.json().attempt.id };
}

async function openEditSessionWithUpload(app, { attemptId, questionId, headers, baseAnswerRevision, sizeBytes }) {
  const edit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions`, headers, payload: { baseAnswerRevision, targetAnswer: "unscored" } });
  expect(edit.statusCode, edit.body).toBe(200);
  const editSessionId = edit.json().id;
  const init = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${questionId}/edit-sessions/${editSessionId}/evidence-uploads`, headers, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes } });
  expect(init.statusCode, init.body).toBe(201);
  return { editSessionId, attachmentId: init.json().attachmentId, uploadToken: init.json().uploadToken };
}

describe.sequential("evidence reread", () => {
  beforeEach(async () => {
    previewCalls = 0;
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-evidence-reread-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-evidence-reread-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("draft and assignment questionnaire return confirmed evidence attachments", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    // q2 先落一条 scored 作答，保证 staged-only 题在 answers 中有条目，专测「staged 附件不回读」
    const savedTwo = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/answers/${world.questionTwo}`, headers: inspectorHeaders, payload: { answer: "scored", revision: 0 } });
    expect(savedTwo.statusCode, savedTwo.body).toBe(200);
    // q1：init → complete（staged_ready，attempt revision 变 2）→ 留言 → confirm unscored（附件变 active）
    const confirmedSession = await openEditSessionWithUpload(app, { attemptId, questionId: world.questionOne, headers: inspectorHeaders, baseAnswerRevision: 0, sizeBytes: 100 });
    const completed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${confirmedSession.editSessionId}/evidence-uploads/${confirmedSession.attachmentId}/complete`, headers: inspectorHeaders, payload: { uploadToken: confirmedSession.uploadToken, sizeBytes: 100 } });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().status).toBe("staged_ready");
    expect((await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${confirmedSession.editSessionId}`, headers: inspectorHeaders, payload: { draftIssueRemark: "地面有水渍", revision: 2 } })).statusCode).toBe(200);
    const confirm = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${confirmedSession.editSessionId}/confirm`, headers: inspectorHeaders, payload: { answer: "unscored", revision: 2 } });
    expect(confirm.statusCode, confirm.body).toBe(200);
    // q2：仅 init（staged_uploading），不 complete（q2 作答 revision 仍为 0）
    await openEditSessionWithUpload(app, { attemptId, questionId: world.questionTwo, headers: inspectorHeaders, baseAnswerRevision: 0, sizeBytes: 101 });

    const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(draft.statusCode, draft.body).toBe(200);
    const draftAnswers = draft.json().answers;
    expect(draftAnswers[world.questionOne].attachments).toHaveLength(1);
    const attachment = draftAnswers[world.questionOne].attachments[0];
    expect(attachment.id).toBe(confirmedSession.attachmentId);
    expect(attachment).toMatchObject({ type: "image", status: "active", mimeType: "image/jpeg", sizeBytes: 100, previewUrl: expect.stringContaining("https://preview.example/"), previewExpiresAt: "2030-01-01T00:00:00.000Z" });
    expect(attachment).not.toHaveProperty("storage_key");
    expect(attachment).not.toHaveProperty("storageKey");
    expect(draftAnswers[world.questionTwo].attachments).toEqual([]);
    expect(previewCalls).toBe(1);

    const byAssignment = await app.inject({ method: "GET", url: `/api/assignments/${world.assignmentId}/questionnaire`, headers: inspectorHeaders });
    expect(byAssignment.statusCode, byAssignment.body).toBe(200);
    const assignmentAnswers = byAssignment.json().answers;
    expect(assignmentAnswers[world.questionOne].attachments).toHaveLength(1);
    expect(assignmentAnswers[world.questionOne].attachments[0]).toMatchObject({ id: confirmedSession.attachmentId, type: "image", status: "active", mimeType: "image/jpeg", sizeBytes: 100, previewUrl: expect.stringContaining("https://preview.example/"), previewExpiresAt: "2030-01-01T00:00:00.000Z" });
    expect(assignmentAnswers[world.questionTwo].attachments).toEqual([]);
    expect(previewCalls).toBe(2);
    await app.close();
  });

  test("does not request preview urls when the attempt has no active attachments", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const savedOne = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/answers/${world.questionOne}`, headers: inspectorHeaders, payload: { answer: "scored", revision: 0 } });
    expect(savedOne.statusCode, savedOne.body).toBe(200);
    const savedTwo = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/answers/${world.questionTwo}`, headers: inspectorHeaders, payload: { answer: "scored", revision: 1 } });
    expect(savedTwo.statusCode, savedTwo.body).toBe(200);
    const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json().answers[world.questionOne].attachments).toEqual([]);
    expect(draft.json().answers[world.questionTwo].attachments).toEqual([]);
    expect(previewCalls).toBe(0);
    await app.close();
  });
});

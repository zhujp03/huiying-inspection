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
  // webm complete 分支专用（routes.js 对 audio/webm 附件改走 readObject 自校验）：用例内按需覆写。
  readObject: async () => { throw new Error("readObject stub 未在本用例配置"); },
};

// 构造指定长度的文件头 Buffer：webm 用 EBML 魔数，错档用 ID3（mp3 头，webm 分支应判魔数不符）。
const ebmlBuffer = (sizeBytes) => { const buffer = Buffer.alloc(sizeBytes); buffer[0] = 0x1a; buffer[1] = 0x45; buffer[2] = 0xdf; buffer[3] = 0xa3; return buffer; };
const id3Buffer = (sizeBytes) => { const buffer = Buffer.alloc(sizeBytes); buffer.write("ID3", 0, "ascii"); return buffer; };

async function seedWorld(pool, { imageMaxCount = 2, audioMaxDurationSeconds = 5 } = {}) {
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
  // 区域（省市区三级）与门店
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-001','测试门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  // 问卷：1 题带证据配置
  const templateId = uuidv7(); const versionId = uuidv7(); const questionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'测试问卷','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES ($1,$2,'q1',1,'environment','测试题',2,true,1)`, [questionId, versionId]);
  await pool.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
    VALUES ($1,true,true,true,1,1,$2,$3)`, [questionId, imageMaxCount, audioMaxDurationSeconds]);
  // 任务与分配
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

describe.sequential("evidence limits", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-evidence-limits-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-evidence-limits-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("draft questionnaire exposes the uniform photo cap 4 and stored audio limits", async () => {
    // 2026-10：问题照片有效上限统一为 4（存量 image_max_count 列不再作为有效上限下发）；
    // 录音时长仍按题目存储配置逐题下发。
    const world = await seedWorld(pool, { imageMaxCount: 2, audioMaxDurationSeconds: 5 });
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().questions[0].evidence).toMatchObject({ imageRequired: true, audioRequired: true, imageMaxCount: 4, audioMaxDurationSeconds: 5 });
    await app.close();
  });

  test("admits four photos under the uniform cap regardless of stored limit 3; audio limits stay per-question", async () => {
    // 2026-10：存量 image_max_count=3 不再作为有效上限；现行策略 4 张放行、第 5 张拒绝。
    const world = await seedWorld(pool, { imageMaxCount: 3, audioMaxDurationSeconds: 10 });
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const edit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    const editSessionId = edit.json().id;
    // 4 张图片全部成功（统一上限 4）
    for (let index = 0; index < 4; index += 1) {
      const upload = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${editSessionId}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 100 + index } });
      expect(upload.statusCode, upload.body).toBe(201);
    }
    // 第 5 张被拒
    const fifth = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${editSessionId}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 200 } });
    expect(fifth.statusCode).toBe(422);
    expect(fifth.json().error.code).toBe("EVIDENCE_LIMIT_EXCEEDED");
    // 11 秒录音被拒（上限 10 秒）
    const longAudio = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${editSessionId}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "audio", mimeType: "audio/mpeg", sizeBytes: 300, durationSeconds: 11 } });
    expect(longAudio.statusCode).toBe(422);
    expect(longAudio.json().error.code).toBe("EVIDENCE_LIMIT_EXCEEDED");
    // 10 秒以内录音成功
    const okAudio = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${editSessionId}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "audio", mimeType: "audio/mpeg", sizeBytes: 301, durationSeconds: 10 } });
    expect(okAudio.statusCode, okAudio.body).toBe(201);
    await app.close();
  });

  test("存量超限照片保留可确认；新增一律被 init 拦截（2026-10 照片选填兼容语义）", async () => {
    const world = await seedWorld(pool, { imageMaxCount: 1, audioMaxDurationSeconds: 10 });
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const edit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    const editSessionId = edit.json().id;
    // 绕过上传接口直接插入 4 张 active 附件：模拟历史累计存量（统一上限 4 的满额）。
    await pool.query(`INSERT INTO question_evidence_attachments (id,attempt_id,question_id,type,storage_key,edit_session_id,status,client_file_id,upload_nonce,declared_content_type,declared_size_bytes)
      SELECT gen_random_uuid(),$1,$2,'image','legacy-' || n,$3,'active',gen_random_uuid(),gen_random_uuid(),'image/jpeg',100 + n
      FROM generate_series(1,4) n`, [attemptId, world.questionId, editSessionId]);
    // 新增第 5 张：init 是张数上限的唯一强制点 → 422
    const fifth = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${editSessionId}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: 102 } });
    expect(fifth.statusCode).toBe(422);
    expect(fifth.json().error.code).toBe("EVIDENCE_LIMIT_EXCEEDED");
    // 存量 2 张保留：确认（无 image_min_count 强制、不再按存量数拒绝）与提交均放行
    await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${editSessionId}`, headers: inspectorHeaders, payload: { draftIssueRemark: "照片超限测试", revision: 0 } });
    const confirmed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${editSessionId}/confirm`, headers: inspectorHeaders, payload: { answer: "unscored", revision: 0 } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await app.close();
  });

  test("init accepts audio/webm (bare and with codecs suffix) and keeps ogg rejected and image untouched", async () => {
    const world = await seedWorld(pool, { imageMaxCount: 2, audioMaxDurationSeconds: 10 });
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const edit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    const editSessionId = edit.json().id;
    const uploadUrl = `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${editSessionId}/evidence-uploads`;
    // Chrome/Android MediaRecorder 裸 audio/webm → 201
    const bareWebm = await app.inject({ method: "POST", url: uploadUrl, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "audio", mimeType: "audio/webm", sizeBytes: 300, durationSeconds: 5 } });
    expect(bareWebm.statusCode, bareWebm.body).toBe(201);
    // Chrome 实际产出的 "audio/webm;codecs=opus"（base mime 归一化后命中白名单）→ 201
    const codecsWebm = await app.inject({ method: "POST", url: uploadUrl, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "audio", mimeType: "audio/webm;codecs=opus", sizeBytes: 301, durationSeconds: 5 } });
    expect(codecsWebm.statusCode, codecsWebm.body).toBe(201);
    // 不在白名单的 audio/ogg → 422 EVIDENCE_FILE_INVALID
    const ogg = await app.inject({ method: "POST", url: uploadUrl, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "audio", mimeType: "audio/ogg", sizeBytes: 302, durationSeconds: 5 } });
    expect(ogg.statusCode).toBe(422);
    expect(ogg.json().error.code).toBe("EVIDENCE_FILE_INVALID");
    // image 白名单行为不变：image/png 正常
    const png = await app.inject({ method: "POST", url: uploadUrl, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/png", sizeBytes: 400 } });
    expect(png.statusCode, png.body).toBe(201);
    await app.close();
  });

  test("complete verifies webm magic and declared size, failing attachments keep failed status, mp4 path still routes verifyObject", async () => {
    const world = await seedWorld(pool, { imageMaxCount: 2, audioMaxDurationSeconds: 10 });
    const app = buildApp({ config, pool, logger: false, providers, storage });
    const { inspectorHeaders, attemptId } = await inspectorAttempt(app, world.assignmentId);
    const edit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    const editSessionId = edit.json().id;
    const uploadUrl = `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionId}/edit-sessions/${editSessionId}/evidence-uploads`;
    const initAudio = async (mimeType, sizeBytes) => {
      const initialized = await app.inject({ method: "POST", url: uploadUrl, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "audio", mimeType, sizeBytes, durationSeconds: 5 } });
      expect(initialized.statusCode, initialized.body).toBe(201);
      return initialized.json();
    };
    const completeAudio = (attachment, sizeBytes) => app.inject({
      method: "POST",
      url: `${uploadUrl}/${attachment.attachmentId}/complete`,
      headers: inspectorHeaders,
      payload: { uploadToken: attachment.uploadToken, sizeBytes, durationSeconds: 5 },
    });
    const attachmentStatus = async (attachmentId) => (await pool.query("SELECT status FROM question_evidence_attachments WHERE id=$1", [attachmentId])).rows[0].status;

    // webm：EBML 魔数 + 长度一致 → staged_ready
    storage.readObject = async () => ebmlBuffer(512);
    const webm = await initAudio("audio/webm;codecs=opus", 512);
    const webmDone = await completeAudio(webm, 512);
    expect(webmDone.statusCode, webmDone.body).toBe(200);
    expect(webmDone.json().status).toBe("staged_ready");
    // webm 分支的 sha256 由服务端对对象实体计算（区别于 cos.verifyObject 注入值），落库必须是 64 位小写十六进制
    expect((await pool.query("SELECT sha256 FROM question_evidence_attachments WHERE id=$1", [webm.attachmentId])).rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);

    // webm：错误魔数（ID3，长度一致）→ 422 且附件置 failed
    storage.readObject = async () => id3Buffer(513);
    const wrongMagic = await initAudio("audio/webm", 513);
    const wrongMagicDone = await completeAudio(wrongMagic, 513);
    expect(wrongMagicDone.statusCode).toBe(422);
    expect(wrongMagicDone.json().error.code).toBe("EVIDENCE_FILE_INVALID");
    expect(await attachmentStatus(wrongMagic.attachmentId)).toBe("failed");

    // webm：长度与 declared_size_bytes 不符 → 422 且附件置 failed
    storage.readObject = async () => ebmlBuffer(999);
    const wrongSize = await initAudio("audio/webm", 514);
    const wrongSizeDone = await completeAudio(wrongSize, 514);
    expect(wrongSizeDone.statusCode).toBe(422);
    expect(wrongSizeDone.json().error.code).toBe("EVIDENCE_FILE_INVALID");
    expect(await attachmentStatus(wrongSize.attachmentId)).toBe("failed");

    // iOS mp4 路径：仍走 cos.verifyObject（stub 记录调用），不被 webm 分支劫持 → staged_ready
    let verifyObjectCalls = 0;
    const originalVerifyObject = storage.verifyObject;
    const originalReadObject = storage.readObject;
    storage.verifyObject = async (args) => {
      verifyObjectCalls += 1;
      return { sizeBytes: Number(args.expectedSizeBytes), mimeType: args.declaredContentType, sha256: "c".repeat(64), storageVersionId: "mp4-version", durationSeconds: null };
    };
    try {
      const mp4 = await initAudio("audio/mp4", 515);
      const mp4Done = await completeAudio(mp4, 515);
      expect(mp4Done.statusCode, mp4Done.body).toBe(200);
      expect(mp4Done.json().status).toBe("staged_ready");
      expect(verifyObjectCalls).toBe(1);
    } finally {
      storage.verifyObject = originalVerifyObject;
      storage.readObject = originalReadObject;
    }
    await app.close();
  });
});

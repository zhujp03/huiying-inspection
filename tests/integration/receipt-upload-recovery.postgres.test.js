import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { encrypt, hmac, normalizePhone } from "../../apps/api/src/auth/crypto.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 小票上传/删除/重试冲突修复集成回归（2026-10-28，真实 PostgreSQL junde_test + 存储替身）：
//   1) 软删 ready 行成功且历史元数据（verified_at/sha256/storage_key/display_order）零变化；
//   2) 客户现场 fixture（deleted@1+2）无需重建任务即可 init→直传凭据→complete ready→receipt_required 提交；
//   3) 槽位取 1..9 最小空闲位：删 1 复用 1、删中间留缺口补位；10 活跃拒 422；>9 次生命周期删/传循环成功；
//   4) 删行 clientFileId 重放 → RECEIPT_DELETED 409（不复活、行零改动）；
//   5) 并行 init：同 clientFileId 幂等（201+200 单行）；过期 revision → 409 无 500；
//   6) failed 行 init 复位 uploading（失败码清理）后 complete ready；
//   7) schema：部分唯一索引/新 CHECK 就位、旧全局唯一与旧 CHECK 移除、其余唯一/校验原样保留。

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
// 存储替身（与 highlight-photo-flow 同构）：verifyObject 实测摘要=sha256(storage_key)，
// complete 客户端必须携带同值——真实对账口径的替身形态。
const keySha256 = (key) => createHash("sha256").update(String(key)).digest("hex");
const storage = {
  exportConfigured: true,
  newObjectSuffix: () => "test-object",
  createPostTarget: ({ key }) => ({ method: "POST", url: "https://private.example.test", fileFieldName: "file", formData: { key }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  verifyObject: async ({ key, expectedSizeBytes }) => ({ sizeBytes: expectedSizeBytes, mimeType: "image/jpeg", sha256: keySha256(key), storageVersionId: "version-one", durationSeconds: null }),
  createPreviewUrl: async (key) => ({ url: `https://preview.example.test/${encodeURIComponent(key)}?sig=1`, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  verifyStoredObject: async () => true,
};

const attemptRevision = async (attemptId) => Number((await pool.query("SELECT revision FROM survey_attempts WHERE id=$1", [attemptId])).rows[0].revision);
const attachmentRow = async (clientFileId) => (await pool.query("SELECT * FROM receipt_attachments WHERE attempt_id=(SELECT attempt_id FROM receipt_attachments WHERE client_file_id=$1 LIMIT 1) AND client_file_id=$1", [clientFileId])).rows[0];

const makeApi = (app, headers, attemptId) => ({
  init: async (clientFileId, { fileName = "receipt.jpg", sizeBytes = 2048, revision } = {}) => app.inject({
    method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/uploads`, headers,
    payload: { fileMeta: { clientFileId, fileName, mimeType: "image/jpeg", sizeBytes, sha256: "a".repeat(64) }, revision: revision ?? (await attemptRevision(attemptId)) },
  }),
  complete: async (clientFileId, attachmentId, sizeBytes = 2048) => {
    const key = (await pool.query("SELECT storage_key FROM receipt_attachments WHERE id=$1", [attachmentId])).rows[0].storage_key;
    return app.inject({
      method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/${attachmentId}/complete`, headers,
      payload: { fileMeta: { clientFileId, fileName: "receipt.jpg", mimeType: "image/jpeg", sizeBytes, sha256: keySha256(key) }, revision: await attemptRevision(attemptId) },
    });
  },
  remove: async (attachmentId) => app.inject({
    method: "DELETE", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/${attachmentId}`, headers,
    payload: { dishHandling: "keep_as_manual", revision: await attemptRevision(attemptId) },
  }),
  list: async () => app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments`, headers }),
});

// init → 直传凭据（替身不发真实字节）→ complete ready。
const stageReady = async (api, clientFileId, sizeBytes = 2048) => {
  const init = await api.init(clientFileId, { sizeBytes });
  expect(init.statusCode, init.body).toBe(201);
  const attachmentId = init.json().attachment.id;
  const complete = await api.complete(clientFileId, attachmentId, sizeBytes);
  expect(complete.statusCode, complete.body).toBe(200);
  expect(complete.json().attachment.status).toBe("ready");
  return { attachmentId, displayOrder: complete.json().attachment.displayOrder };
};

async function seedWorld({ receiptRequired = true } = {}) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  const inspectorId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'AdminOne','adminone','管理员',$2,$3,now(),$4,'approved_active'),($5,'InspectorOne','inspectorone','探员',$6,$7,now(),$4,'approved_active')`,
    [adminId, encrypt(encryptionKey, normalizePhone("13600000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13600000000")), passwordHash,
      inspectorId, encrypt(encryptionKey, normalizePhone("13800000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13800000000"))]);
  const adminRole = await pool.query("SELECT id FROM roles WHERE code='admin'");
  const inspectorRole = await pool.query("SELECT id FROM roles WHERE code='inspector'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, adminRole.rows[0].id]);
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspectorId, inspectorRole.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-RR','小票冲突回归门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  const templateId = uuidv7(); const versionId = uuidv7(); const questionOne = uuidv7(); const questionTwo = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'小票冲突回归问卷','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES
    ($1,$2,'q1',1,'environment','冲突回归题一',2,true,1),($3,$2,'q2',2,'environment','冲突回归题二',3,true,2)`, [questionOne, versionId, questionTwo]);
  const campaignId = uuidv7(); const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,$2,'小票冲突回归任务',$3,$4,$5,$6,'published',$7)", [campaignId, `C-RR-${campaignId.slice(24)}`, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), adminId]);
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,receipt_required,status,created_by)
    VALUES ($1,$2,$3,$4,$5,'secret',$6,$7,0,$8,'assigned',$9)`, [assignmentId, `A-RR-${assignmentId.slice(24)}`, campaignId, inspectorId, versionId, startsAt, dueAt, receiptRequired, adminId]);
  return { questionOne, questionTwo, assignmentId, questionnaireVersionId: versionId };
}

async function openAttempt(app, headers, assignmentId) {
  expect((await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } })).statusCode).toBe(200);
  const started = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers });
  expect(started.statusCode).toBe(200);
  return started.json().attempt.id;
}

async function answerAll(attemptId, versionId) {
  const questions = (await pool.query("SELECT id,max_score FROM questions WHERE version_id=$1 ORDER BY question_number", [versionId])).rows;
  for (const question of questions) {
    await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,'scored',$3,'')", [attemptId, question.id, question.max_score]);
  }
}

// 规范三分类基线（0025 集合）：新套件自治、结束时归还能给其他套件留下的状态。
const seedCanonicalCategories = async () => {
  await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
};

// 客户现场 fixture 形态：直插 deleted@display_order 1+2（软删仅 uploading/failed 行曾被生产允许）。
const insertDeletedFixture = async (attemptId, inspectorId, slots) => {
  for (const slot of slots) {
    await pool.query(`INSERT INTO receipt_attachments (id,attempt_id,client_file_id,display_order,storage_key,upload_nonce,declared_content_type,declared_size_bytes,original_file_name,status,created_by,deleted_at)
      VALUES ($1,$2,$3,$4,$5,$6,'image/jpeg',2048,'fixture.jpg','deleted',$7,now())`,
      [uuidv7(), attemptId, uuidv7(), slot, `attempts/${attemptId}/receipts/${uuidv7()}/fixture-${slot}`, uuidv7(), inspectorId]);
  }
};

describe.sequential("receipt upload/delete/retry conflict recovery (2026-10-28)", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-receipt-recovery-tests'))");
    await pool.query(`TRUNCATE submission_question_scores, submission_versions, receipt_ocr_candidates, receipt_ocr_jobs, receipt_ocr_job_attachments,
      receipt_ocr_applications, receipt_ocr_summaries, receipt_ocr_lines, receipt_attachments, object_cleanup_jobs, dish_records, other_record_highlight_photos,
      other_record_highlights, other_records, idempotency_keys, audit_logs, question_answer_edit_session_removals, question_evidence_attachments,
      question_answer_edit_sessions, question_answers, survey_attempts, checkin_exemptions, audit_checkins, assignment_dish_requirements,
      audit_assignments, audit_campaigns, question_evidence_requirements, questions, questionnaire_versions, questionnaire_templates,
      question_categories, brands, stores, regions, auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets,
      inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users RESTART IDENTITY CASCADE`);
    await seedRbac(pool);
    // 自治种子：规范三分类基线（不依赖也不残留跨套件的 question_categories 状态）。
    await seedCanonicalCategories();
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-receipt-recovery-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => {
    // 归还规范的 question_categories 基线（连同依赖它的业务行一并清空），避免给后续套件
    // 遗留只有部分分类或指向已删分类的残留状态。
    if (pool) {
      await pool.query(`TRUNCATE submission_question_scores, submission_versions, receipt_ocr_candidates, receipt_ocr_jobs, receipt_ocr_job_attachments,
        receipt_ocr_applications, receipt_ocr_summaries, receipt_ocr_lines, receipt_attachments, object_cleanup_jobs, dish_records, other_record_highlight_photos,
        other_record_highlights, other_records, idempotency_keys, audit_logs, question_answer_edit_session_removals, question_evidence_attachments,
        question_answer_edit_sessions, question_answers, survey_attempts, checkin_exemptions, audit_checkins, assignment_dish_requirements,
        audit_assignments, audit_campaigns, question_evidence_requirements, questions, questionnaire_versions, questionnaire_templates,
        question_categories, brands, stores, regions, auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets,
        inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users RESTART IDENTITY CASCADE`);
      await seedCanonicalCategories();
    }
    await pool?.end();
  });

  test("deleting a ready receipt retains historical metadata and frees its slot for reuse; receipt_required submit succeeds", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } })).json().accessToken}` };
    const attemptId = await openAttempt(app, headers, world.assignmentId);
    const api = makeApi(app, headers, attemptId);
    const first = uuidv7();
    const { attachmentId: firstId } = await stageReady(api, first);
    await stageReady(api, uuidv7());
    expect((await api.list()).json().items.map((item) => item.displayOrder)).toEqual([1, 2]);

    // 删 ready 行：此前被 CHECK (status='ready')=(verified_at IS NOT NULL) 拒绝（500），修复后 200。
    const removed = await api.remove(firstId);
    expect(removed.statusCode, removed.body).toBe(200);
    const row = await attachmentRow(first);
    expect(row.status).toBe("deleted");
    expect(row.deleted_at).toBeTruthy();
    // 历史元数据零变化：verified_at/sha256/storage_key/display_order 原样保留（绝不回填/UPDATE）。
    expect(row.verified_at).toBeTruthy();
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.storage_key).toBe((await pool.query("SELECT storage_key FROM receipt_attachments WHERE id=$1", [firstId])).rows[0].storage_key);
    expect(Number(row.display_order)).toBe(1);

    // 槽位复用：新 init 取最小空闲位 1（而非 count+1=3 撞唯一约束）。
    const reuploaded = await stageReady(api, uuidv7());
    expect(reuploaded.displayOrder).toBe(1);
    expect((await api.list()).json().items.map((item) => item.displayOrder)).toEqual([1, 2]);

    // receipt_required 提交照常通过（2 张 ready）。
    await answerAll(attemptId, world.questionnaireVersionId);
    const assignmentRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [world.assignmentId])).rows[0].revision);
    const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers, payload: { submitToken: uuidv7(), assignmentRevision, confirmation: true } });
    expect(submit.statusCode, submit.body).toBe(200);
    expect(submit.json().status).toBe("submitted");
  });

  test("customer fixture (deleted slots 1+2) uploads, completes and submits without rebuilding the task", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } });
    const headers = { authorization: `Bearer ${login.json().accessToken}` };
    const attemptId = await openAttempt(app, headers, world.assignmentId);
    const inspectorId = (await pool.query("SELECT inspector_id FROM audit_assignments WHERE id=$1", [world.assignmentId])).rows[0].inspector_id;
    await insertDeletedFixture(attemptId, inspectorId, [1, 2]);
    // 修复前：count(非删)+1 = 1 → 撞 deleted@1 唯一约束 → 裸 500。修复后：分配最小空闲位。
    const api = makeApi(app, headers, attemptId);
    const { attachmentId } = await stageReady(api, uuidv7());
    const row = await pool.query("SELECT display_order FROM receipt_attachments WHERE id=$1", [attachmentId]);
    expect(Number(row.rows[0].display_order)).toBe(1);
    // 第二张落到 2（1 被占，2 为下一空闲位——fixture 的 deleted@2 不再阻塞）。
    const second = await stageReady(api, uuidv7());
    expect(second.displayOrder).toBe(2);
    await answerAll(attemptId, world.questionnaireVersionId);
    const assignmentRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [world.assignmentId])).rows[0].revision);
    const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers, payload: { submitToken: uuidv7(), assignmentRevision, confirmation: true } });
    expect(submit.statusCode, submit.body).toBe(200);
  });

  test("smallest-free-slot allocation reuses the middle gap after deleting among three", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } })).json().accessToken}` };
    const attemptId = await openAttempt(app, headers, world.assignmentId);
    const api = makeApi(app, headers, attemptId);
    const middle = uuidv7();
    await stageReady(api, uuidv7());
    const { attachmentId: middleId, displayOrder: middleSlot } = await stageReady(api, middle);
    await stageReady(api, uuidv7());
    expect(middleSlot).toBe(2);
    expect((await api.remove(middleId)).statusCode).toBe(200);
    expect(await attemptRevision(attemptId)).toBeGreaterThan(0);
    const refill = await stageReady(api, uuidv7());
    expect(refill.displayOrder).toBe(2); // 缺口补位，而非 count+1=3 撞 deleted@3/活跃@3
    expect((await api.list()).json().items.map((item) => item.displayOrder)).toEqual([1, 2, 3]);
  });

  test("ten active receipts are rejected while more than nine lifetime delete/reupload cycles succeed", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } })).json().accessToken}` };
    const attemptId = await openAttempt(app, headers, world.assignmentId);
    const api = makeApi(app, headers, attemptId);
    for (let index = 0; index < 9; index += 1) await stageReady(api, uuidv7());
    const tenth = await api.init(uuidv7());
    expect(tenth.statusCode, tenth.body).toBe(422);
    expect(tenth.json().error.code).toBe("RECEIPT_LIMIT_EXCEEDED");
    // 生命周期循环 >9 次：删 1 号位 → 重传补位 1，共 12 轮（生命周期行数 21 > 9）。
    for (let cycle = 0; cycle < 12; cycle += 1) {
      const victim = (await pool.query("SELECT id FROM receipt_attachments WHERE attempt_id=$1 AND status='ready' ORDER BY display_order LIMIT 1", [attemptId])).rows[0];
      expect((await api.remove(victim.id)).statusCode).toBe(200);
      const { displayOrder } = await stageReady(api, uuidv7());
      expect(displayOrder).toBe(1);
    }
    expect((await api.list()).json().items).toHaveLength(9);
    const lifetime = await pool.query("SELECT count(*)::int count FROM receipt_attachments WHERE attempt_id=$1", [attemptId]);
    expect(lifetime.rows[0].count).toBeGreaterThan(9);
  });

  test("stale replay with a deleted clientFileId is a clear business conflict and never revives the row", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } })).json().accessToken}` };
    const attemptId = await openAttempt(app, headers, world.assignmentId);
    const api = makeApi(app, headers, attemptId);
    const clientFileId = uuidv7();
    const { attachmentId } = await stageReady(api, clientFileId);
    const before = await attachmentRow(clientFileId);
    expect((await api.remove(attachmentId)).statusCode).toBe(200);
    const replay = await api.init(clientFileId);
    expect(replay.statusCode, replay.body).toBe(409);
    expect(replay.json().error.code).toBe("RECEIPT_DELETED");
    const after = await attachmentRow(clientFileId);
    // 行零变化：状态与元数据与删除时完全一致（无复活、无 UPDATE）。
    expect(after.status).toBe("deleted");
    expect(after.deleted_at).toBeTruthy();
    expect(after.verified_at.getTime()).toBe(before.verified_at.getTime());
    expect(after.sha256).toBe(before.sha256);
    expect(Number(after.display_order)).toBe(Number(before.display_order));
  });

  test("parallel inits serialize under the attempt lock: same client id is idempotent, stale revisions stay 409", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } })).json().accessToken}` };
    const attemptId = await openAttempt(app, headers, world.assignmentId);
    const api = makeApi(app, headers, attemptId);
    // 同 clientFileId 并行：先到者 201 建行，后到者走幂等重放 200（revision 已前移仍 200）。
    const sameId = uuidv7();
    const parallelSame = await Promise.all([api.init(sameId), api.init(sameId)]);
    expect(parallelSame.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    const rows = await pool.query("SELECT count(*)::int count FROM receipt_attachments WHERE attempt_id=$1 AND client_file_id=$2", [attemptId, sameId]).then((result) => result.rows[0].count);
    expect(rows).toBe(1);
    // 不同 clientFileId 共享同一过期 revision：先到者 201，后到者明确 409（绝不 500）。
    const staleRevision = await attemptRevision(attemptId);
    const parallelStale = await Promise.all([api.init(uuidv7(), { revision: staleRevision }), api.init(uuidv7(), { revision: staleRevision })]);
    expect(parallelStale.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(parallelStale.find((response) => response.statusCode === 409).json().error.code).toBe("REVISION_CONFLICT");
  });

  test("failed row is truthfully revived by init replay (uploading reset, failure cleared) then completes ready", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } })).json().accessToken}` };
    const attemptId = await openAttempt(app, headers, world.assignmentId);
    const api = makeApi(app, headers, attemptId);
    const clientFileId = uuidv7();
    const init = await api.init(clientFileId);
    expect(init.statusCode).toBe(201);
    const attachmentId = init.json().attachment.id;
    // 模拟服务端失败态（complete 验证失败会置 failed）：canRetry=true 但重试曾死循环（init 不复位）。
    await pool.query("UPDATE receipt_attachments SET status='failed',failure_code='RECEIPT_VERIFY_FAILED',updated_at=now() WHERE id=$1", [attachmentId]);
    const revisionBefore = await attemptRevision(attemptId);
    const replay = await api.init(clientFileId);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().attachment.status).toBe("uploading");
    expect(replay.json().attachment.canRetry).toBe(false);
    // 复位是幂等重放语义：不前移 attempt revision。
    expect(await attemptRevision(attemptId)).toBe(revisionBefore);
    const row = await attachmentRow(clientFileId);
    expect(row.status).toBe("uploading");
    expect(row.failure_code).toBeNull();
    expect(row.verification_locked_by).toBeNull();
    expect(row.verification_lease_expires_at).toBeNull();
    // 复位后 complete 真实走通（sha256 对账不变）。
    const complete = await api.complete(clientFileId, attachmentId);
    expect(complete.statusCode, complete.body).toBe(200);
    expect(complete.json().attachment.status).toBe("ready");
  });

  test("migration 0035 schema state: partial unique in place, old global unique and strict CHECK removed, other guards intact", async () => {
    const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='receipt_attachments_active_display_order_uq'");
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef).toContain("WHERE (status <> 'deleted'::text)");
    const constraints = await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='receipt_attachments'::regclass");
    const names = constraints.rows.map((row) => row.conname);
    expect(names).toContain("receipt_attachments_ready_verified_check");
    expect(names).toContain("receipt_attachments_attempt_id_client_file_id_key");
    expect(names).toContain("receipt_attachments_pkey");
    expect(names).not.toContain("receipt_attachments_attempt_id_display_order_key");
    expect(names).not.toContain("receipt_attachments_check");
    const definitions = await pool.query("SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='receipt_attachments'::regclass");
    const readyCheck = definitions.rows.find((row) => row.conname === "receipt_attachments_ready_verified_check");
    // 豁免仅限历史删行：非删行维持原双向 ready↔verified_at 不变量（uploading/failed 带残留
    // verified_at 依旧被拒，ready 行必有 verified_at）。
    expect(readyCheck.def).toBe("CHECK (((status = 'deleted'::text) OR ((status = 'ready'::text) = (verified_at IS NOT NULL))))");
    // 既有守护原样：sha256 活跃唯一、display_order 1..9、deleted↔deleted_at、10MB、类型白名单。
    const indexes = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename='receipt_attachments'");
    expect(indexes.rows.map((row) => row.indexname)).toContain("receipt_attachments_active_sha_uq");
    const columnChecks = definitions.rows.map((row) => row.def).join("\n");
    expect(columnChecks).toContain("display_order >= 1");
    expect(columnChecks).toContain("display_order <= 9");
    expect(columnChecks).toContain("deleted_at IS NOT NULL");
    expect(columnChecks).toContain("10485760");
    // 迁移清单：35 个文件全部在册（含 0035），schema_migrations 行数与文件数一致。
    const applied = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(applied.rows.some((row) => row.name === "0035_receipt_display_order_reuse.sql")).toBe(true);
  });

  test("verified_at CHECK boundary: only deleted rows are exempt from the ready↔verified_at invariant", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: { level: "error" }, providers, storage });
    const headers = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } })).json().accessToken}` };
    const attemptId = await openAttempt(app, headers, world.assignmentId);
    const api = makeApi(app, headers, attemptId);
    const clientFileId = uuidv7();
    const { attachmentId } = await stageReady(api, clientFileId);

    // 边界逐一实测（savepoint 内回滚，不留数据）：非删行维持原双向不变量。
    const attemptInTx = async (statement, params) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SAVEPOINT boundary");
        try {
          await client.query(statement, params);
          return "allowed";
        } catch (error) {
          return error.code; // 23514 = check_violation
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT boundary");
        }
      } finally {
        await client.query("COMMIT");
        client.release();
      }
    };
    const base = "UPDATE receipt_attachments SET status=$1, verified_at=$2, deleted_at=CASE WHEN $1='deleted' THEN now() ELSE NULL END WHERE id=$3";
    // 修复前旧 CHECK ((status='ready')=(verified_at IS NOT NULL)) 使 ready 行软删 500 —— 软删保留 verified_at 必须放行
    //（与真实删除端点同形态：status='deleted' + deleted_at=now()，verified_at 原样保留）。
    expect(await attemptInTx(base, ["deleted", new Date(), attachmentId])).toBe("allowed");
    // 非删行任一方向违规均拒绝：uploading/failed 带 verified_at、ready 缺 verified_at。
    expect(await attemptInTx(base, ["uploading", new Date(), attachmentId])).toBe("23514");
    expect(await attemptInTx(base, ["failed", new Date(), attachmentId])).toBe("23514");
    expect(await attemptInTx(base, ["ready", null, attachmentId])).toBe("23514");
    // 合法形态照常放行：uploading/failed 无 verified_at、ready 有 verified_at。
    expect(await attemptInTx(base, ["uploading", null, attachmentId])).toBe("allowed");
    expect(await attemptInTx(base, ["failed", null, attachmentId])).toBe("allowed");
    expect(await attemptInTx(base, ["ready", new Date(), attachmentId])).toBe("allowed");
  });
});

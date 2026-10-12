// 本地磁盘存储 × PostgreSQL 全流程集成测试（只允许 junde_test 等测试库）：
// 探员登录 → 打卡 → 开始 → 证据/小票真实 multipart 直传落盘 → 服务端校验就绪 →
// OCR 关闭语义 → 提交问卷 → 管理员查看证据 → worker 本地导出真实 CSV → 下载 →
// 过期清理真实删除 → API/worker「重启」（新 provider 实例）后文件仍在 → 清理任务真实删除。
// 全程不 mock 存储：磁盘文件、数据库行、签名授权都是真实产物。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { encrypt, hmac, normalizePhone } from "../../apps/api/src/auth/crypto.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createStorageProvider } from "../../apps/api/src/storage/index.js";
import { runObjectCleanupJobs } from "../../apps/worker/src/object-cleanup.js";
import { expireExportJobs, runExportJobs } from "../../apps/worker/src/export-jobs.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { uuidv7 } from "../../apps/api/src/ids.js";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;

let root = "";
let config = null;
const providers = { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test-message" }) };

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(97, 0x11)]);
const receiptSha256 = () => createHash("sha256").update(JPEG_BYTES).digest("hex");

const multipartBody = (fields, file, boundary) => {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
};

// 真实直传：走 init 返回的签名 uploadTarget（本地形态指向 /api/local-storage/objects）。
const postToSignedTarget = async (app, uploadTarget, file) => {
  const target = new URL(uploadTarget.url);
  return app.inject({
    method: uploadTarget.method,
    url: `${target.pathname}${target.search}`,
    headers: { "content-type": `multipart/form-data; boundary=----jundeintegration` },
    payload: multipartBody(uploadTarget.formData, file, "----jundeintegration"),
  });
};

async function seedWorld(db) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  const inspectorId = uuidv7();
  await db.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'AdminOne','adminone','管理员',$2,$3,now(),$4,'approved_active'),($5,'InspectorOne','inspectorone','探员',$6,$7,now(),$4,'approved_active')`,
    [adminId, encrypt(encryptionKey, normalizePhone("13600000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13600000000")), passwordHash, inspectorId, encrypt(encryptionKey, normalizePhone("13800000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13800000000"))]);
  const adminRole = await db.query("SELECT id FROM roles WHERE code = 'admin'");
  const inspectorRole = await db.query("SELECT id FROM roles WHERE code = 'inspector'");
  await db.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, adminRole.rows[0].id]);
  await db.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspectorId, inspectorRole.rows[0].id]);
  await db.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await db.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await db.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await db.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await db.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-001','测试门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  // 两题都要求图片证据；q1 走“不得分+证据”，q2 走“得分”。
  const templateId = uuidv7(); const versionId = uuidv7(); const questionOne = uuidv7(); const questionTwo = uuidv7();
  await db.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'本地存储测试问卷','secret',$2)", [templateId, adminId]);
  await db.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await db.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES
    ($1,$2,'q1',1,'environment','证据题',2,true,1),($3,$2,'q2',2,'environment','普通题',3,true,2)`, [questionOne, versionId, questionTwo]);
  await db.query(`INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count,image_max_count,audio_max_duration_seconds)
    VALUES ($1,true,true,false,1,0,3,10),($2,false,false,false,0,0,3,10)`, [questionOne, questionTwo]);
  const campaignId = uuidv7(); const assignmentId = uuidv7();
  const startsAt = new Date(Date.now() - 60_000); const dueAt = new Date(Date.now() + 3_600_000);
  await db.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-001','本地存储测试任务',$2,$3,$4,$5,'published',$6)", [campaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), adminId]);
  await db.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,receipt_required,status,created_by)
    VALUES ($1,'A-001',$2,$3,$4,'secret',$5,$6,0,true,'assigned',$7)`, [assignmentId, campaignId, inspectorId, versionId, startsAt, dueAt, adminId]);
  return { adminId, inspectorId, questionOne, questionTwo, campaignId, assignmentId };
}

let databaseLock = null;

describe.sequential("local storage full flow (postgres)", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "junde-local-flow-"));
    config = loadConfig({
      NODE_ENV: "test", STORAGE_PROVIDER: "local", OCR_PROVIDER: "none",
      AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
      AUTH_TOKEN_HMAC_KEY: "integration-local-key-integration-local-key",
      PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
      PUBLIC_API_ORIGIN: "http://127.0.0.1:3000",
      LOCAL_STORAGE_DIR: root,
    });
  });

  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-local-storage-flow-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions, question_answer_edit_session_removals, receipt_attachments, receipt_ocr_jobs, receipt_ocr_job_attachments, receipt_ocr_candidates, receipt_ocr_applications, export_jobs, object_cleanup_jobs, submission_versions, submission_question_scores, audit_logs, idempotency_keys, dish_records, other_records, audit_checkins, checkin_exemptions RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-local-storage-flow-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => {
    await pool?.end();
    await rm(root, { recursive: true, force: true });
  });

  test("submit a full assignment with real evidence and receipt, then export and download via local storage", async () => {
    const world = await seedWorld(pool);
    const cos = createStorageProvider(config);
    await cos.assertReady();
    const app = buildApp({ config, pool, logger: false, providers, storage: cos });

    // ---- 探员登录 → 打卡 → 开始 ----
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } });
    expect(login.statusCode, login.body).toBe(200);
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    const checkin = await app.inject({ method: "POST", url: `/api/assignments/${world.assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    expect(checkin.statusCode, checkin.body).toBe(200);
    const started = await app.inject({ method: "POST", url: `/api/assignments/${world.assignmentId}/start`, headers: inspectorHeaders });
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = started.json().attempt.id;

    // ---- q1 证据：init → 真实 multipart 直传 → complete → staged_ready ----
    const edit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    expect(edit.statusCode, edit.body).toBe(200);
    const editSessionId = edit.json().id;
    const evidenceInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${editSessionId}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: JPEG_BYTES.length } });
    expect(evidenceInit.statusCode, evidenceInit.body).toBe(201);
    const evidenceUpload = await postToSignedTarget(app, evidenceInit.json().uploadTarget, { filename: "evidence.jpg", contentType: "image/jpeg", data: JPEG_BYTES });
    expect(evidenceUpload.statusCode, evidenceUpload.body).toBe(204);
    const evidenceComplete = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${editSessionId}/evidence-uploads/${evidenceInit.json().attachmentId}/complete`, headers: inspectorHeaders, payload: { uploadToken: evidenceInit.json().uploadToken, sizeBytes: JPEG_BYTES.length } });
    expect(evidenceComplete.statusCode, evidenceComplete.body).toBe(200);
    expect(evidenceComplete.json().status).toBe("staged_ready");

    // ---- 答题：q2 得分；q1 留言后按 unscored 确认（证据转 active） ----
    const scored = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/answers/${world.questionTwo}`, headers: inspectorHeaders, payload: { answer: "scored", revision: evidenceComplete.json().revision } });
    expect(scored.statusCode, scored.body).toBe(200);
    const patch = await app.inject({ method: "PATCH", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${editSessionId}`, headers: inspectorHeaders, payload: { draftIssueRemark: "现场证据", revision: scored.json().revision } });
    expect(patch.statusCode, patch.body).toBe(200);
    const confirmed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${editSessionId}/confirm`, headers: inspectorHeaders, payload: { answer: "unscored", revision: scored.json().revision } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    // 草稿里的 previewUrl 是本地签名 URL：真实 GET 得到上传的原始字节。
    const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}`, headers: inspectorHeaders });
    expect(draft.statusCode, draft.body).toBe(200);
    const previewUrl = draft.json().answers[world.questionOne].attachments[0].previewUrl;
    expect(previewUrl).toContain("/api/local-storage/objects");
    const previewResponse = await app.inject({ method: "GET", url: new URL(previewUrl).pathname + new URL(previewUrl).search });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.rawPayload.equals(JPEG_BYTES)).toBe(true);

    // ---- 小票：init → 真实直传 → complete（sha256 服务端复核）→ ready ----
    const receiptFileMeta = { clientFileId: uuidv7(), fileName: "receipt.jpg", mimeType: "image/jpeg", sizeBytes: JPEG_BYTES.length, sha256: receiptSha256() };
    const receiptInit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/uploads`, headers: inspectorHeaders, payload: { fileMeta: receiptFileMeta, revision: confirmed.json().revision } });
    expect(receiptInit.statusCode, receiptInit.body).toBe(201);
    const receiptUpload = await postToSignedTarget(app, receiptInit.json().uploadTarget, { filename: "receipt.jpg", contentType: "image/jpeg", data: JPEG_BYTES });
    expect(receiptUpload.statusCode, receiptUpload.body).toBe(204);
    const receiptAttachmentId = receiptInit.json().attachment.id;
    const receiptComplete = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/${receiptAttachmentId}/complete`, headers: inspectorHeaders, payload: { fileMeta: receiptFileMeta, revision: receiptInit.json().revision } });
    expect(receiptComplete.statusCode, receiptComplete.body).toBe(200);
    expect(receiptComplete.json().attachment.status).toBe("ready");

    // ---- OCR 关闭：创建识别任务失败关闭（503 OCR_NOT_CONFIGURED），手工填写不受影响 ----
    const ocrCreate = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-ocr-jobs`, headers: inspectorHeaders, payload: { attachmentIds: [receiptAttachmentId], idempotencyKey: uuidv7(), revision: receiptComplete.json().revision } });
    expect(ocrCreate.statusCode).toBe(503);
    expect(ocrCreate.json().error.code).toBe("OCR_NOT_CONFIGURED");

    // ---- 闪光点 → 提交 ----
    const other = await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attemptId}/other-records`, headers: inspectorHeaders, payload: { highlight: "本地存储全流程跑通", suggestion: "", revision: receiptComplete.json().revision } });
    expect(other.statusCode, other.body).toBe(200);
    const submitted = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspectorHeaders, payload: { submitToken: uuidv7(), assignmentRevision: Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [world.assignmentId])).rows[0].revision), confirmation: true } });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().status).toBe("submitted");

    // ---- 提交后重放保护：同一有效签名授权改写字节被 409 拒绝，原始小票与 DB sha256 不变 ----
    const tamperedReplay = await postToSignedTarget(app, receiptInit.json().uploadTarget, { filename: "receipt.jpg", contentType: "image/jpeg", data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(JPEG_BYTES.length - 4, 0xee)]) });
    expect(tamperedReplay.statusCode).toBe(409);
    expect(tamperedReplay.json().error.code).toBe("STORAGE_OBJECT_EXISTS");
    const receiptAfterReplay = await pool.query("SELECT sha256 FROM receipt_attachments WHERE id=$1", [receiptAttachmentId]);
    expect(receiptAfterReplay.rows[0].sha256).toBe(receiptSha256());
    const identicalReplay = await postToSignedTarget(app, receiptInit.json().uploadTarget, { filename: "receipt.jpg", contentType: "image/jpeg", data: JPEG_BYTES });
    expect(identicalReplay.statusCode).toBe(204); // 同字节重放幂等：原件不动
    expect((await pool.query("SELECT sha256 FROM receipt_attachments WHERE id=$1", [receiptAttachmentId])).rows[0].sha256).toBe(receiptSha256());

    // ---- 管理员查看提交详情：小票/证据预览全部是可用的本地签名 URL ----
    const adminLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "AdminOne", password: "A-secure-pass" } });
    expect(adminLogin.statusCode, adminLogin.body).toBe(200);
    const adminHeaders = { cookie: adminLogin.headers["set-cookie"], "x-csrf-token": adminLogin.json().csrfToken };
    const submissions = await app.inject({ method: "GET", url: "/api/admin/submissions", headers: adminHeaders });
    expect(submissions.statusCode, submissions.body).toBe(200);
    expect(submissions.json().total).toBe(1);
    const submissionId = submissions.json().items[0].id;
    const detail = await app.inject({ method: "GET", url: `/api/admin/submissions/${submissionId}`, headers: adminHeaders });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().receiptComparison.receipts[0].previewStatus).toBe("ready");
    const adminPreview = await app.inject({ method: "GET", url: new URL(detail.json().receiptComparison.receipts[0].previewUrl).pathname + new URL(detail.json().receiptComparison.receipts[0].previewUrl).search });
    expect(adminPreview.statusCode).toBe(200);
    expect(adminPreview.rawPayload.equals(JPEG_BYTES)).toBe(true);

    // ---- worker 本地导出：真实 CSV 文件 + 真实下载 ----
    const exportCreate = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...adminHeaders, "idempotency-key": uuidv7() }, payload: { kind: "submissions", filters: {} } });
    expect(exportCreate.statusCode, exportCreate.body).toBe(202);
    const exportRun = await runExportJobs({ pool, cos, limit: 5 });
    expect(exportRun.completed).toBe(1);
    const exportList = await app.inject({ method: "GET", url: "/api/admin/exports", headers: adminHeaders });
    expect(exportList.statusCode, exportList.body).toBe(200);
    const exportRow = exportList.json().items[0];
    expect(exportRow.status).toBe("succeeded");
    expect(exportRow.downloadUrl).toContain("/api/local-storage/objects");
    const download = await app.inject({ method: "GET", url: new URL(exportRow.downloadUrl).pathname + new URL(exportRow.downloadUrl).search });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    const csvText = download.rawPayload.toString("utf8");
    expect(csvText).toContain("本地存储测试任务");
    expect(csvText).toContain("测试门店");
    expect(csvText).toContain("探员");

    // ---- API/worker「重启」：全新 provider 实例读取同一目录，文件与校验和仍在 ----
    const restarted = createStorageProvider({ ...config, LOCAL_STORAGE_DIR: root });
    const receiptRow = await pool.query("SELECT storage_key,size_bytes,sha256 FROM receipt_attachments WHERE id=$1", [receiptAttachmentId]);
    expect(receiptRow.rows[0].sha256).toBe(receiptSha256());
    const diskBytes = await readFile(path.join(root, receiptRow.rows[0].storage_key));
    expect(diskBytes.equals(JPEG_BYTES)).toBe(true);
    await expect(restarted.verifyStoredObject({ key: receiptRow.rows[0].storage_key, expectedSizeBytes: Number(receiptRow.rows[0].size_bytes), expectedSha256: receiptRow.rows[0].sha256 })).resolves.toMatchObject({ sizeBytes: JPEG_BYTES.length });

    // ---- 过期清理：真实删除导出文件（succeeded → expired 先删文件再落库） ----
    await pool.query("UPDATE export_jobs SET expires_at=now()-INTERVAL '1 second'");
    const expired = await expireExportJobs({ pool, cos, limit: 10 });
    expect(expired.expired).toBeGreaterThanOrEqual(1);
    const exportKeyRow = await pool.query("SELECT storage_key FROM export_jobs WHERE status='expired' LIMIT 1");
    await expect(stat(path.join(root, exportKeyRow.rows[0].storage_key))).rejects.toMatchObject({ code: "ENOENT" });
    const relisted = await app.inject({ method: "GET", url: "/api/admin/exports", headers: adminHeaders });
    expect(relisted.json().items[0].status).toBe("expired");

    // ---- 提交后小票只读：删除请求应被拒绝（submission-readonly 语义仍生效） ----
    const receiptDelete = await app.inject({ method: "DELETE", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/${receiptAttachmentId}`, headers: inspectorHeaders, payload: { dishHandling: "keep_as_manual", revision: 0 } });
    expect(receiptDelete.statusCode, receiptDelete.body).toBe(409);
    // 磁盘上的小票文件仍然存在（只读锁定不删文件）。
    await expect(stat(path.join(root, receiptRow.rows[0].storage_key))).resolves.toBeTruthy();

    await app.close();
  });

  test("worker cleanup removes discarded evidence files from local disk", async () => {
    const world = await seedWorld(pool);
    const cos = createStorageProvider(config);
    const app = buildApp({ config, pool, logger: false, providers, storage: cos });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${world.assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const started = await app.inject({ method: "POST", url: `/api/assignments/${world.assignmentId}/start`, headers: inspectorHeaders });
    const attemptId = started.json().attempt.id;

    const edit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions`, headers: inspectorHeaders, payload: { baseAnswerRevision: 0, targetAnswer: "unscored" } });
    const editSessionId = edit.json().id;
    const init = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${editSessionId}/evidence-uploads`, headers: inspectorHeaders, payload: { clientFileId: uuidv7(), type: "image", mimeType: "image/jpeg", sizeBytes: JPEG_BYTES.length } });
    const upload = await postToSignedTarget(app, init.json().uploadTarget, { filename: "e.jpg", contentType: "image/jpeg", data: JPEG_BYTES });
    expect(upload.statusCode).toBe(204);
    const storageKeyRow = await pool.query("SELECT storage_key FROM question_evidence_attachments WHERE id=$1", [init.json().attachmentId]);
    const storageKey = storageKeyRow.rows[0].storage_key;
    await expect(stat(path.join(root, storageKey))).resolves.toMatchObject({ size: JPEG_BYTES.length });

    // 取消编辑会话：staged 附件废弃并排队清理；worker 跑一遍后磁盘文件真实消失。
    const cancelled = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/questions/${world.questionOne}/edit-sessions/${editSessionId}/cancel`, headers: inspectorHeaders });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const queued = await pool.query("SELECT count(*)::int count FROM object_cleanup_jobs WHERE storage_key=$1 AND status='queued'", [storageKey]);
    expect(queued.rows[0].count).toBe(1);
    await expect(stat(path.join(root, storageKey))).resolves.toBeTruthy();
    await runObjectCleanupJobs({ pool, cos, limit: 10 });
    await expect(stat(path.join(root, storageKey))).rejects.toMatchObject({ code: "ENOENT" });
    const jobRow = await pool.query("SELECT status FROM object_cleanup_jobs WHERE storage_key=$1", [storageKey]);
    expect(jobRow.rows[0].status).toBe("succeeded");
    await app.close();
  });
});

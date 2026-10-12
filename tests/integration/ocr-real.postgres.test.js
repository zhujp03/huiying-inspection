// 真实 PaddleOCR 集成测试：真实 PostgreSQL 17 + 真实 OCR sidecar（PP-OCRv6_small）。
// 需要 DATABASE_URL（真实 PG17）与 OCR_SERVICE_URL（私网/本机 sidecar，本机可用
// docker 运行 junde-ocr:amd64-verify 并映射端口）。
// 上传/完成部分使用 storage 替身（真实 COS 密钥缺失时的边界），OCR 推理与 worker
// 领取/租约/候选落库全部走真实代码路径。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { createOcrClient } from "../../apps/worker/src/ocr-client.js";
import { runReceiptOcrJobs } from "../../apps/worker/src/receipt-ocr.js";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

const connectionString = process.env.DATABASE_URL;
const ocrServiceUrl = process.env.OCR_SERVICE_URL;
// 真实小票样图：由本测试在启动时生成（中文文本 + 金额），侧car 必须真实识别出内容。
const sampleReceiptPath = fileURLToPath(new URL("../../tests/fixtures/ocr-sample-receipt.png", import.meta.url));
const test = connectionString && ocrServiceUrl ? it : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", API_REQUEST_TIMEOUT_MS: 12000, AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  OCR_PROVIDER: "paddle", OCR_SERVICE_URL: ocrServiceUrl, OCR_REQUEST_TIMEOUT_MS: 120000, OCR_MODEL_VERSION: "PP-OCRv6_small", OCR_PARSER_VERSION: "receipt-parser-v1",
};

const storage = {
  newObjectSuffix: () => "real-ocr-object", createPostTarget: ({ key }) => ({ method: "POST", url: "https://private.example.test", fileFieldName: "file", formData: { key }, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  verifyObject: async ({ expectedSizeBytes }) => ({ sizeBytes: expectedSizeBytes, mimeType: "image/jpeg", sha256: "c".repeat(64), storageVersionId: "real-ocr-version", durationSeconds: null }),
  createPreviewUrl: async () => ({ url: "https://private.example.test/preview", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  readObject: async () => readFileSync(sampleReceiptPath),
};

describe.sequential("Real PaddleOCR integration", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-real-ocr-tests'))");
    await pool.query("TRUNCATE object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,survey_attempts,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-real-ocr-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("runs the real PP-OCRv6 worker against the real sidecar and persists recognized candidates", async () => {
    const userId = uuidv7();
    const regionId = uuidv7();
    const storeId = uuidv7();
    const templateId = uuidv7();
    const versionId = uuidv7();
    const campaignId = uuidv7();
    const assignmentId = uuidv7();
    // 统一复用一个执行窗口，避免各请求独立取 Date.now() 导致毫秒级漂移越界。
    const windowStart = new Date(Date.now() - 60_000);
    const windowEnd = new Date(Date.now() + 30 * 60_000);
    await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,'RealOcr','realocr','真实OCR用户','cipher','lookup',now(),$2,'approved_active')", [userId, await createPasswordService().hash("a-secure-password")]);
    await pool.query("INSERT INTO regions (id,name,code) VALUES ($1,'上海','sh')", [regionId]);
    await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-OCR','真实OCR门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, userId]);
    await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'真实OCR题库','secret',$2)", [templateId, userId]);
    await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, userId]);
    await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,status,created_by) VALUES ($1,'C-OCR','真实OCR任务',$2,$3,$4,'draft',$5)", [campaignId, storeId, windowStart, windowEnd, userId]);
    await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by) VALUES ($1,'A-OCR',$2,$3,$4,'secret',$5,$6,0,'draft',$7)", [assignmentId, campaignId, userId, versionId, windowStart, windowEnd, userId]);
    const superAdmin = await pool.query("SELECT id FROM roles WHERE code = 'super_admin'");
    await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), userId, superAdmin.rows[0].id]);
    await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), userId]);
    for (let number = 1; number <= 50; number += 1) {
      const id = uuidv7();
      await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,sort_order) VALUES ($1,$2,$3,$4,$5,$6,2,$4)", [id, versionId, `q-${number}`, number, number <= 20 ? "environment" : number <= 42 ? "service" : "product", `第 ${number} 题`]);
      await pool.query("INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count) VALUES ($1,false,false,false,0,0)", [id]);
    }
    const app = buildApp({ config, pool, storage, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test" }) } });
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "RealOcr", password: "a-secure-password" } });
    const headers = { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken, "idempotency-key": uuidv7() };
    const publishResponse = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers, payload: { revision: 0 } });
    expect(publishResponse.statusCode, publishResponse.body).toBe(200);
    const campaign = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name: "真实OCR任务", storeId, startsAt: windowStart.toISOString(), dueAt: windowEnd.toISOString(), questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "真实OCR" } });
    const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/assignments`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { inspectorId: userId, questionnaireVersionId: versionId, taskType: "secret", startsAt: windowStart.toISOString(), dueAt: windowEnd.toISOString(), budgetLimit: 0, receiptRequired: true, specialInstruction: "", campaignRevision: 0 } });
    expect((await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 1 } })).statusCode).toBe(200);
    const inspectorLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "RealOcr", password: "a-secure-password" } });
    const inspectorHeaders = { authorization: `Bearer ${inspectorLogin.json().accessToken}` };
    await app.inject({ method: "POST", url: `/api/assignments/${assignment.json().id}/check-in`, headers: inspectorHeaders, payload: { latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() } });
    const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignment.json().id}/start`, headers: inspectorHeaders })).json().attempt.id;
    const clientFileId = uuidv7();
    const initialized = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/uploads`, headers: inspectorHeaders, payload: { fileMeta: { clientFileId, fileName: "receipt.jpg", mimeType: "image/jpeg", sizeBytes: 100, sha256: "c".repeat(64) }, revision: 0 } });
    const completed = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-attachments/${initialized.json().attachment.id}/complete`, headers: inspectorHeaders, payload: { fileMeta: { clientFileId, fileName: "receipt.jpg", mimeType: "image/jpeg", sizeBytes: 100, sha256: "c".repeat(64) }, revision: initialized.json().revision } });
    expect(completed.statusCode, completed.body).toBe(200);
    const created = await app.inject({ method: "POST", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-ocr-jobs`, headers: inspectorHeaders, payload: { attachmentIds: [initialized.json().attachment.id], idempotencyKey: uuidv7(), revision: completed.json().revision } });
    expect(created.statusCode, created.body).toBe(201);

    // 真实 worker + 真实 PaddleOCR sidecar：领取租约、真实推理、候选落库。
    const ocr = createOcrClient(config);
    expect(ocr.configured).toBe(true);
    const outcome = await runReceiptOcrJobs({ pool, cos: storage, ocr, leaseSeconds: 300, limit: 4, maxConcurrency: 2 });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ claimed: 1, completed: 1 });
    const job = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attemptId}/receipt-ocr-jobs/${created.json().id}`, headers: inspectorHeaders });
    expect(job.json().status).toBe("succeeded");
    expect(job.json().recognizedDishCount).toBeGreaterThan(0);
    const lines = await pool.query("SELECT count(*)::int count FROM receipt_ocr_lines WHERE job_id=$1", [created.json().id]);
    expect(lines.rows[0].count).toBeGreaterThan(0);
    const candidates = await pool.query("SELECT normalized_name, quantity, unit_price_cents, line_total_cents FROM receipt_ocr_candidates WHERE job_id=$1 ORDER BY sort_order", [created.json().id]);
    expect(candidates.rows.length).toBeGreaterThan(0);
    await app.close();
  }, 240_000);
});

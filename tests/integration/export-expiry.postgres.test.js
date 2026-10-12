import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { expireExportJobs, runExportJobs } from "../../apps/worker/src/export-jobs.js";

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
  const normalizedPhone = normalizePhone("13800000011");
  await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,'ExpiryFlow','expiryflow','过期导出用户',$3,$4,now(),$2,'approved_active')", [userId, await createPasswordService().hash("a-secure-password"), encrypt(phoneKey, normalizedPhone), phoneHmac(config.AUTH_TOKEN_HMAC_KEY, normalizedPhone)]);
  const provinceId = uuidv7(); const cityId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-001','测试门店',$2,'测试地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, userId]);
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'测试题库','secret',$2)", [templateId, userId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, userId]);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-001','测试任务',$2,$3,$4,$5,'draft',$6)", [campaignId, storeId, startsAt, dueAt, new Date(Date.now() + 7_200_000), userId]);
  await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,questionnaire_deadline_at,budget_limit_cents,status,created_by) VALUES ($1,'A-001',$2,$3,$4,'secret',$5,$6,$7,0,'draft',$8)", [assignmentId, campaignId, userId, versionId, startsAt, dueAt, new Date(Date.now() + 7_200_000), userId]);
  return { userId, regionId, cityId, storeId, versionId, campaignId, assignmentId };
}

async function createAdminApp(storage) {
  // 导出创建接口要求 cos.exportConfigured；测试替身默认视为已配置
  storage = { exportConfigured: true, ...storage };
  const setup = await createAssignment();
  const superAdmin = await pool.query("SELECT id FROM roles WHERE code = 'super_admin'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), setup.userId, superAdmin.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), setup.userId]);
  const app = buildApp({ config, pool, storage, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test" }) } });
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "ExpiryFlow", password: "a-secure-password" } });
  expect(login.statusCode).toBe(200);
  return { ...setup, app, headers: { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken, "idempotency-key": uuidv7() } };
}

// 一条最小提交（导出主链路的行来源），约束同批次二：attempt/assignment/campaign 成组
async function insertSubmission({ storeId, versionId, userId }, index) {
  const campaignId = uuidv7();
  const assignmentId = uuidv7();
  const attemptId = uuidv7();
  const submissionId = uuidv7();
  const startsAt = new Date(Date.now() - 3_600_000);
  const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,$2,'测试任务',$3,$4,$5,$5,'draft',$6)", [campaignId, `C-EXP-${index}`, storeId, startsAt, dueAt, userId]);
  await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,questionnaire_deadline_at,budget_limit_cents,status,created_by) VALUES ($1,$2,$3,$4,$5,'secret',$6,$7,$7,0,'draft',$8)", [assignmentId, `A-EXP-${index}`, campaignId, userId, versionId, startsAt, dueAt, userId]);
  await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
  await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
    VALUES ($1,$2,$3,$4,$5,$6,now(),80,100,1,'[]','[]','{}','[]','[]','[]',$7)`, [submissionId, attemptId, assignmentId, campaignId, versionId, userId, "a".repeat(64)]);
  return submissionId;
}

// 直插一条 succeeded 行（含全文件字段，满足单向/双向约束）；storageKey 须全局唯一（UNIQUE）
async function insertSucceededJob(userId, storageKey, expiredAt) {
  const id = uuidv7();
  await pool.query(`INSERT INTO export_jobs (id,requested_by,scope_snapshot_json,filters_json,job_kind,status,storage_key,file_name,completed_at,expires_at)
    VALUES ($1,$2,$3,$4,'submissions','succeeded',$5,'提交记录导出.csv',now(),$6)`,
  [id, userId, JSON.stringify([{ scope_type: "all" }]), JSON.stringify({ kind: "submissions", filters: {} }), storageKey, expiredAt]);
  return id;
}

// fake COS：记录 deleteExportObject 收到的 key；failKeys 中的 key 抛非 404 错误
const fakeCos = (failKeys = new Set()) => {
  const uploaded = [];
  const deleted = [];
  return {
    uploaded,
    deleted,
    putExportObject: async (object) => uploaded.push(object),
    // worker 以 storage_key 字符串调用（与 apps/worker/src/export-jobs.js 的调用形态一致）
    deleteExportObject: async (key) => {
      if (failKeys.has(key)) throw Object.assign(new Error("cos internal error"), { code: "COS_INTERNAL_ERROR" });
      deleted.push(key);
    },
    createExportDownloadUrl: async () => ({ url: "https://private.example.test/export", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  };
};

describe.sequential("PostgreSQL export expiry", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-postgres-integration-tests'))");
    await pool.query("TRUNCATE export_jobs,audit_logs,submission_question_scores,submission_versions,survey_attempts,object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,question_categories,brands,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    // 分类种子（survey_attempts.current_category 默认 'environment' 有 FK 依赖）
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-postgres-integration-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("过期导出全链路：列表/详情视图 expired 且不写库，worker 清 COS 后落 expired 并保留文件字段，二次执行幂等", async () => {
    const cos = fakeCos();
    const { app, headers, storeId, versionId, userId } = await createAdminApp(cos);
    const submissionId = await insertSubmission({ storeId, versionId, userId }, 1);
    const requested = await app.inject({ method: "POST", url: "/api/admin/exports", headers, payload: { submissionId } });
    expect(requested.statusCode, requested.body).toBe(202);
    const jobId = requested.json().id;
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });

    const stored = await pool.query("SELECT status,storage_key FROM export_jobs WHERE id=$1", [jobId]);
    expect(stored.rows[0]).toMatchObject({ status: "succeeded" });
    const storageKey = stored.rows[0].storage_key;
    expect(storageKey).toBeTruthy();

    const before = await app.inject({ method: "GET", url: `/api/admin/exports/${jobId}`, headers });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({ status: "succeeded", downloadUrl: "https://private.example.test/export" });

    // 模拟时间流逝（仅改 expires_at，不改状态）
    await pool.query("UPDATE export_jobs SET expires_at=now()-INTERVAL '1 hour' WHERE id=$1", [jobId]);

    // 列表视图：显示 expired、不预签名下载链接，且不写库（DB 行仍 succeeded）
    const list = await app.inject({ method: "GET", url: "/api/admin/exports", headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items[0]).toMatchObject({ id: jobId, status: "expired", downloadUrl: null });
    let row = await pool.query("SELECT status FROM export_jobs WHERE id=$1", [jobId]);
    expect(row.rows[0].status).toBe("succeeded");

    // 详情视图同口径
    const detail = await app.inject({ method: "GET", url: `/api/admin/exports/${jobId}`, headers });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ status: "expired", downloadUrl: null });
    row = await pool.query("SELECT status FROM export_jobs WHERE id=$1", [jobId]);
    expect(row.rows[0].status).toBe("succeeded");

    // worker 过期清理：COS 收到该 key，DB 落 expired 且文件字段保留（审计痕迹，单向新约束）
    expect(await expireExportJobs({ pool, cos })).toMatchObject({ expired: 1 });
    expect(cos.deleted).toEqual([storageKey]);
    row = await pool.query("SELECT status,storage_key,file_name FROM export_jobs WHERE id=$1", [jobId]);
    expect(row.rows[0]).toMatchObject({ status: "expired" });
    expect(row.rows[0].storage_key).toBe(storageKey);
    expect(row.rows[0].file_name).toBeTruthy();

    // 幂等：二次执行不再重复删除，视图仍 expired 无下载链接
    expect(await expireExportJobs({ pool, cos })).toMatchObject({ expired: 0 });
    expect(cos.deleted).toEqual([storageKey]);
    const after = await app.inject({ method: "GET", url: `/api/admin/exports/${jobId}`, headers });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json()).toMatchObject({ status: "expired", downloadUrl: null });
    await app.close();
  });

  test("单 job COS 删除失败不阻断：失败行保持 succeeded 待下轮重试，其余照常过期，导出主流程不受影响", async () => {
    const keyA = `exports/${uuidv7()}/failed-key.csv`;
    const keyB = `exports/${uuidv7()}/ok-key.csv`;
    const cos = fakeCos(new Set([keyA]));
    const { app, userId } = await createAdminApp(cos);
    const jobA = await insertSucceededJob(userId, keyA, new Date(Date.now() - 3_600_000));
    const jobB = await insertSucceededJob(userId, keyB, new Date(Date.now() - 1_800_000));

    // A 删除失败被逐 job 捕获：函数正常返回，B 成功过期
    expect(await expireExportJobs({ pool, cos })).toMatchObject({ expired: 1, failed: 1 });
    expect(cos.deleted).toEqual([keyB]);
    const rows = await pool.query("SELECT id,status FROM export_jobs WHERE id=ANY($1)", [[jobA, jobB]]);
    expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.status]))).toEqual({ [jobA]: "succeeded", [jobB]: "expired" });

    // 导出主流程未被阻断：新的 queued 任务照常被处理
    await pool.query(`INSERT INTO export_jobs (id,requested_by,scope_snapshot_json,filters_json,job_kind,status,expires_at)
      VALUES ($1,$2,$3,$4,'submissions','queued',now()+INTERVAL '7 days')`, [uuidv7(), userId, JSON.stringify([{ scope_type: "all" }]), JSON.stringify({ kind: "submissions", filters: {} })]);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    await app.close();
  });

  test("expired 任务可重新导出：filters_json 原样复制仍有效，新任务跑完 succeeded", async () => {
    const cos = fakeCos();
    const { app, headers, storeId, versionId, userId } = await createAdminApp(cos);
    const submissionId = await insertSubmission({ storeId, versionId, userId }, 2);
    // 直插一条已过期行（无文件字段，兼容存量形态）
    const expiredId = uuidv7();
    await pool.query(`INSERT INTO export_jobs (id,requested_by,scope_snapshot_json,filters_json,job_kind,status,expires_at)
      VALUES ($1,$2,$3,$4,'submissions','expired',now()-INTERVAL '1 hour')`,
    [expiredId, userId, JSON.stringify([{ scope_type: "all" }]), JSON.stringify({ kind: "submissions", submissionId })]);

    const reexport = await app.inject({ method: "POST", url: `/api/admin/exports/${expiredId}/reexport`, headers });
    expect(reexport.statusCode, reexport.body).toBe(202);
    const newJobId = reexport.json().id;
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    expect(cos.uploaded[0].body.toString("utf8")).toContain("测试任务");
    const detail = await app.inject({ method: "GET", url: `/api/admin/exports/${newJobId}`, headers });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ status: "succeeded" });
    await app.close();
  });
});

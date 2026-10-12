import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { runExportJobs } from "../../apps/worker/src/export-jobs.js";

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
  const normalizedPhone = normalizePhone("13800000010");
  await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,'FilterDirection','filterdirection','筛选方向用户',$3,$4,now(),$2,'approved_active')", [userId, await createPasswordService().hash("a-secure-password"), encrypt(phoneKey, normalizedPhone), phoneHmac(config.AUTH_TOKEN_HMAC_KEY, normalizedPhone)]);
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
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "FilterDirection", password: "a-secure-password" } });
  expect(login.statusCode).toBe(200);
  return { ...setup, app, headers: { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken, "idempotency-key": uuidv7() } };
}

// 最短路径种子：同一 store/inspector（探店员唯一 user）下每条提交各建一组 campaign+assignment+attempt。
// 约束所致：audit_assignments(campaign_id,inspector_id)、survey_attempts.assignment_id、
// submission_versions.attempt_id 均唯一，无法在同一 campaign 下落多条提交；方向断言只依赖行集与 store/region 归属，与 campaign 身份无关。
async function insertSubmission({ storeId, versionId, userId }, issueCount, index) {
  const campaignId = uuidv7();
  const assignmentId = uuidv7();
  const attemptId = uuidv7();
  const submissionId = uuidv7();
  const startsAt = new Date(Date.now() - 3_600_000);
  const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,$2,'测试任务',$3,$4,$5,$5,'draft',$6)", [campaignId, `C-FD-${index}`, storeId, startsAt, dueAt, userId]);
  await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,questionnaire_deadline_at,budget_limit_cents,status,created_by) VALUES ($1,$2,$3,$4,$5,'secret',$6,$7,$7,0,'draft',$8)", [assignmentId, `A-FD-${index}`, campaignId, userId, versionId, startsAt, dueAt, userId]);
  await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
  await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
    VALUES ($1,$2,$3,$4,$5,$6,now(),80,100,$7,'[]','[]','{}','[]','[]','[]',$8)`, [submissionId, attemptId, assignmentId, campaignId, versionId, userId, issueCount, "a".repeat(64)]);
  return submissionId;
}

// CSV 解析：首列提交时间、末列不得分数；种子数据不含逗号，按行 split 即可
function csvIssueCounts(body) {
  const lines = body.toString("utf8").replace(/^\ufeff/, "").split("\r\n").filter((line) => line.length > 0);
  return { header: lines[0], counts: lines.slice(1).map((line) => Number(line.split(",").at(-1).replaceAll('"', ""))).sort((a, b) => a - b) };
}

const fakeCos = () => {
  const uploaded = [];
  return {
    uploaded,
    putExportObject: async (object) => uploaded.push(object),
    deleteExportObject: async () => {},
    createExportDownloadUrl: async () => ({ url: "https://private.example.test/export", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  };
};

describe.sequential("PostgreSQL export filter direction", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-postgres-integration-tests'))");
    await pool.query("TRUNCATE export_jobs,audit_logs,submission_question_scores,submission_versions,survey_attempts,object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,question_categories,brands,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-postgres-integration-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("列表与导出在同一 maxIssueCount 阈值下集合一致（含恰好等于阈值的边界行）", async () => {
    const cos = fakeCos();
    const { app, headers, storeId, versionId, userId } = await createAdminApp(cos);
    for (const [index, issueCount] of [0, 2, 3].entries()) await insertSubmission({ storeId, versionId, userId }, issueCount, index);
    const list = await app.inject({ method: "GET", url: "/api/admin/submissions?maxIssueCount=2", headers: { cookie: headers.cookie } });
    expect(list.statusCode, list.body).toBe(200);
    const listed = list.json().items.map((item) => item.issueCount).sort((a, b) => a - b);
    expect(listed).toEqual([0, 2]);
    expect(list.json().total).toBe(2);
    const requested = await app.inject({ method: "POST", url: "/api/admin/exports", headers, payload: { filters: { maxIssueCount: 2 } } });
    expect(requested.statusCode, requested.body).toBe(202);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    const exported = csvIssueCounts(cos.uploaded[0].body);
    expect(exported.counts).toEqual(listed);
    // 边界：issue_count 恰等于阈值的行两侧都包含
    expect(exported.counts).toContain(2);
    expect(exported.counts).not.toContain(3);
    await app.close();
  });

  test("零结果：阈值 0 下无匹配行时列表为空、导出 CSV 仅表头", async () => {
    const cos = fakeCos();
    const { app, headers, storeId, versionId, userId } = await createAdminApp(cos);
    for (const [index, issueCount] of [2, 3].entries()) await insertSubmission({ storeId, versionId, userId }, issueCount, index);
    const list = await app.inject({ method: "GET", url: "/api/admin/submissions?maxIssueCount=0", headers: { cookie: headers.cookie } });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toEqual([]);
    expect(list.json().total).toBe(0);
    const requested = await app.inject({ method: "POST", url: "/api/admin/exports", headers, payload: { filters: { maxIssueCount: 0 } } });
    expect(requested.statusCode, requested.body).toBe(202);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    const exported = csvIssueCounts(cos.uploaded[0].body);
    expect(exported.counts).toEqual([]);
    expect(exported.header).toContain("提交时间");
    expect(exported.header).toContain("不得分数");
    await app.close();
  });

  test("legacy：存量任务 filters_json 带旧键 issueCountAtLeast 时同义按 <= 处理", async () => {
    const cos = fakeCos();
    const { app, headers, storeId, versionId, userId } = await createAdminApp(cos);
    for (const [index, issueCount] of [0, 2, 3].entries()) await insertSubmission({ storeId, versionId, userId }, issueCount, index);
    // 模拟 reexport 原样复制/存量排队任务：不经过当前 schema 校验，直接落旧键
    await pool.query(`INSERT INTO export_jobs (id,requested_by,scope_snapshot_json,filters_json,job_kind,status,expires_at)
      VALUES ($1,$2,$3,$4,'submissions','queued',now()+INTERVAL '7 days')`, [uuidv7(), userId, JSON.stringify([{ scope_type: "all" }]), JSON.stringify({ kind: "submissions", filters: { issueCountAtLeast: 2 } })]);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    const exported = csvIssueCounts(cos.uploaded[0].body);
    expect(exported.counts).toEqual([0, 2]);
    await app.close();
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { expireExportJobs, runExportJobs } from "../../apps/worker/src/export-jobs.js";
import { XLSX_CONTENT_TYPE } from "../../apps/worker/src/dashboard-export.js";
import { EXPORT_SUBMISSION_NOT_FOUND, EXPORT_SUBMISSION_REQUIRED, EXPORT_SUBMISSION_SCORES_MISSING, formatShanghaiDateTime } from "../../apps/worker/src/submission-export.js";
import { workbookOf } from "../helpers/export-workbook.mjs";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

// 单份问卷导出端到端：详情页 POST {submissionId} → 队列 → worker 产出真实 xlsx。
// 覆盖：提交绑定与隔离（同探员两份提交/两个版本）、历史版本保留、创建与 worker 双侧范围校验
// （含层级区域范围）、缺失历史评分显式失败、reexport 原样保留 submissionId、汇总 CSV/本地存储不受影响。

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it.sequential : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", API_REQUEST_TIMEOUT_MS: 12000, AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
};

const STORE_COORDS = { latitude: 31.2304, longitude: 121.4737 };

// 手机号全文件自增序列：phones 唯一约束下多账号互不冲突（138 000 00001 起）
let phoneSequence = 0;
async function insertUser(username, displayName) {
  const userId = uuidv7();
  const { encrypt, hmac: phoneHmac, normalizePhone } = await import("../../apps/api/src/auth/crypto.js");
  const phoneKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  phoneSequence += 1;
  const normalizedPhone = normalizePhone(`138000${String(phoneSequence).padStart(5, "0")}`);
  await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,$2,$3,$4,$5,$6,now(),$7,'approved_active')",
    [userId, username, username, displayName, encrypt(phoneKey, normalizedPhone), phoneHmac(config.AUTH_TOKEN_HMAC_KEY, normalizedPhone), await createPasswordService().hash("a-secure-password")]);
  return userId;
}

async function grantSuperAdmin(userId) {
  const superAdmin = await pool.query("SELECT id FROM roles WHERE code = 'super_admin'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), userId, superAdmin.rows[0].id]);
}

// 城市下新增区 + 门店（同坐标便于打卡通过），返回区域/门店 id
async function insertStore(name, businessNo, createdBy, cityId) {
  const regionId = uuidv7();
  const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,$2,$3,$4,3)", [regionId, `${name}区`, businessNo, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,$2,$3,$4,'测试地址',$5,$6,'poi',now(),$7)", [storeId, businessNo, `${name}店`, regionId, STORE_COORDS.latitude, STORE_COORDS.longitude, createdBy]);
  return { regionId, storeId };
}

// 基础世界：超管（范围 all）+ 探员 + 省市区/门店；返回已登录的 admin 会话与探员凭据。
// app 与 worker 共用同一 fake COS（成功状态接口需要 createExportDownloadUrl）。
async function createWorld(cos = fakeCos()) {
  const adminId = await insertUser("expadmin", "导出超管");
  const inspectorId = await insertUser("expinspector", "导出探员");
  await grantSuperAdmin(adminId);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  // 省市区种子：同链路下可插多门店
  const provinceId = uuidv7(); const cityId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  const storeA = await insertStore("导出甲", "S-EXP-A", adminId, cityId);
  const app = buildApp({ config, pool, storage: cos, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test" }) } });
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "expadmin", password: "a-secure-password" } });
  expect(login.statusCode, login.body).toBe(200);
  const inspectorLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "expinspector", password: "a-secure-password" } });
  expect(inspectorLogin.statusCode, inspectorLogin.body).toBe(200);
  return {
    adminId, inspectorId, app, cos, storeA, cityId,
    headers: { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken, "idempotency-key": uuidv7() },
    inspectorHeaders: { authorization: `Bearer ${inspectorLogin.json().accessToken}` },
  };
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

// 发布版本 → 任务/指派发布 → 探员打卡开卷；answerSpec: [{questionId, answer, awardedScore, remark}]
async function submitQuestionnaire(app, { headers, inspectorHeaders, inspectorId, versionId, storeId, name, answerSpec, dishes = [], highlight = "环境整洁，服务主动" }) {
  expect((await publishVersion(app, headers, versionId)).statusCode).toBe(200);
  const startsAt = new Date(Date.now() - 60_000).toISOString();
  const dueAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const campaign = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name, storeId, startsAt, dueAt, questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "现场执行" } });
  expect(campaign.statusCode, campaign.body).toBe(201);
  const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/assignments`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { inspectorId, questionnaireVersionId: versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: false, specialInstruction: "", campaignRevision: 0 } });
  expect(assignment.statusCode, assignment.body).toBe(201);
  expect((await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 1 } })).statusCode).toBe(200);
  const assignmentId = assignment.json().id;
  expect((await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: STORE_COORDS.latitude, longitude: STORE_COORDS.longitude, accuracy: 10, capturedAt: new Date().toISOString() } })).statusCode).toBe(200);
  const attemptId = (await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders })).json().attempt.id;
  const assignmentRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [assignmentId])).rows[0].revision);
  for (const item of answerSpec) {
    await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,$3,$4,$5)", [attemptId, item.questionId, item.answer, item.awardedScore, item.remark ?? ""]);
  }
  await pool.query("INSERT INTO other_records (attempt_id,highlight,suggestion) VALUES ($1,$2,$3)", [attemptId, highlight, "高峰期加派人手"]);
  const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspectorHeaders, payload: { submitToken: uuidv7(), assignmentRevision, confirmation: true } });
  expect(submit.statusCode, submit.body).toBe(200);
  const submission = await pool.query("SELECT id FROM submission_versions WHERE attempt_id=$1", [attemptId]);
  return { submissionId: submission.rows[0].id, assignmentId, campaignId: campaign.json().campaign.id, attemptId };
}

// 直插一份最小提交（不经探员全流程）：复用版本现有题目，落一题满分明细使 total/max 可对账
async function insertBareSubmission({ storeId, versionId, userId, index }) {
  const campaignId = uuidv7();
  const assignmentId = uuidv7();
  const attemptId = uuidv7();
  const submissionId = uuidv7();
  const startsAt = new Date(Date.now() - 3_600_000);
  const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,$2,'直插任务',$3,$4,$5,$5,'draft',$6)", [campaignId, `C-EXP2-${index}`, storeId, startsAt, dueAt, userId]);
  await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,questionnaire_deadline_at,budget_limit_cents,status,created_by) VALUES ($1,$2,$3,$4,$5,'secret',$6,$7,$7,0,'draft',$8)", [assignmentId, `A-EXP2-${index}`, campaignId, userId, versionId, startsAt, dueAt, userId]);
  await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
  await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
    VALUES ($1,$2,$3,$4,$5,$6,now(),5,5,0,'[]','[]','{}','[]','[]','[]',$7)`, [submissionId, attemptId, assignmentId, campaignId, versionId, userId, "b".repeat(64)]);
  const question = (await pool.query("SELECT id,question_key,question_number,text,max_score,category FROM questions WHERE version_id=$1 ORDER BY question_number LIMIT 1", [versionId])).rows[0];
  await pool.query("INSERT INTO submission_question_scores (id,submission_id,question_id,question_key,question_number,question_text,category,answer,awarded_score,max_score) VALUES ($1,$2,$3,$4,$5,$6,$7,'scored',5,$8)",
    [uuidv7(), submissionId, question.id, question.question_key, question.question_number, question.text, question.category, question.max_score]);
  return submissionId;
}

// fake COS：与 export-expiry 同款（记录上传/删除）
const fakeCos = () => {
  const uploaded = [];
  const deleted = [];
  return {
    uploaded, deleted, exportConfigured: true,
    putExportObject: async (object) => uploaded.push(object),
    deleteExportObject: async (key) => deleted.push(key),
    createExportDownloadUrl: async () => ({ url: "https://private.example.test/export", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  };
};

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const sheetText = (sheet, columns = 11) => {
  const values = [];
  for (let row = 1; row <= sheet.rowCount; row += 1) for (let column = 1; column <= columns; column += 1) {
    const value = sheet.getRow(row).getCell(column).value;
    if (value !== null && value !== undefined && value !== "") values.push(String(value));
  }
  return values.join("\n");
};

describe.sequential("PostgreSQL single-submission export", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-submission-export-tests'))");
    await pool.query("TRUNCATE export_jobs,audit_logs,submission_question_scores,submission_versions,survey_attempts,object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,question_categories,brands,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-submission-export-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("全链路：详情发起 → 队列 → worker 产出真实 xlsx（含清零、对账、打卡时间、文件名）", async () => {
    const cos = fakeCos();
    const { app, headers, inspectorHeaders, adminId, inspectorId, storeA } = await createWorld(cos);
    const versionId = await createDraft(app, headers, [
      { number: 1, category: "environment", text: "环境清零题", maxScore: 2, scoreWipe: true },
      { number: 2, category: "environment", text: "环境普通题", maxScore: 3 },
      { number: 3, category: "service", text: "服务检查题", maxScore: 5 },
    ], "导出评估问卷");
    const rows = await listQuestions(app, headers, versionId);
    const wipe = rows.find((row) => row.scoreWipe);
    const envNormal = rows.find((row) => row.category === "environment" && !row.scoreWipe);
    const service = rows.find((row) => row.category === "service");
    const { submissionId } = await submitQuestionnaire(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId: storeA.storeId, name: "导出现场任务",
      answerSpec: [
        { questionId: wipe.id, answer: "unscored", awardedScore: 0, remark: "发现过期食材" },
        { questionId: envNormal.id, answer: "scored", awardedScore: 3 },
        { questionId: service.id, answer: "scored", awardedScore: 5 },
      ],
    });
    const requested = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId } });
    expect(requested.statusCode, requested.body).toBe(202);
    expect(requested.json()).toMatchObject({ status: "queued", fileName: "单份问卷导出（生成中）", downloadUrl: null });
    const jobId = requested.json().id;
    const jobRow = await pool.query("SELECT job_kind,scope_snapshot_json,filters_json FROM export_jobs WHERE id=$1", [jobId]);
    expect(jobRow.rows[0].job_kind).toBe("submission");
    expect(jobRow.rows[0].filters_json.submissionId).toBe(submissionId);
    expect(jobRow.rows[0].scope_snapshot_json).toEqual([expect.objectContaining({ scope_type: "all" })]);

    const queued = await app.inject({ method: "GET", url: `/api/admin/exports/${jobId}`, headers });
    expect(queued.json().status).toBe("queued");
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    const stored = await pool.query("SELECT status,storage_key,file_name FROM export_jobs WHERE id=$1", [jobId]);
    expect(stored.rows[0].status).toBe("succeeded");
    expect(stored.rows[0].storage_key).toMatch(/^exports\/.*\.xlsx$/);
    expect(stored.rows[0].file_name).toContain("导出甲店");
    expect(stored.rows[0].file_name).toContain("导出探员");
    expect(stored.rows[0].file_name).toMatch(/\.xlsx$/);
    expect(cos.uploaded).toHaveLength(1);
    expect(cos.uploaded[0].contentType).toBe(XLSX_CONTENT_TYPE);

    const workbook = await workbookOf(cos.uploaded[0]);
    expect(workbook.worksheets[0].name).toBe("暗访评估表");
    const sheet = workbook.getWorksheet("暗访评估表");
    expect(String(sheet.getCell("A1").value)).toContain("导出评估问卷");
    expect(String(sheet.getCell("A1").value)).toContain("V1");
    const text = sheetText(sheet);
    // 清零触发与结果显式标注；探员备注进入扣分说明（蓝色原样）；对账后总评 5/10 → 50%
    expect(text).toContain("清零：C1「环境清零题」被判不得分"); // environment → C，触发题用可见编号
    expect(text).toContain("此大项分数直接清零");
    expect(text).toContain("发现过期食材");
    expect(text).toContain("闪光点\n闪光点1：环境整洁，服务主动");
    expect(text).toContain("改善建议：\n高峰期加派人手");
    // 右上矩阵总评 = 权威得分率 50%（5/10）；成绩记录保留原始分与满分
    expect(sheet.getCell("K4").value).toBe(50);
    expect(text).toContain("原始总分 5/10 分");
    const recordRow = [...range(1, sheet.rowCount)].find((row) => sheet.getRow(row).getCell(1).value === "评估信息");
    expect(recordRow).toBeGreaterThan(0);
    // 打卡时间进入表头（accepted checkin captured_at 的日期与时刻），且不会出现 1900 占位
    expect(sheet.getCell("B5").value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sheet.getCell("F5").value).toMatch(/^\d{2}:\d{2}$/);
    expect(text).not.toMatch(/1900/);
    const succeeded = await app.inject({ method: "GET", url: `/api/admin/exports/${jobId}`, headers });
    expect(succeeded.json()).toMatchObject({ status: "succeeded", downloadUrl: "https://private.example.test/export" });
    // 审计日志绑定单份提交
    const audit = await pool.query("SELECT data_json FROM audit_logs WHERE action='export_requested' ORDER BY created_at DESC LIMIT 1");
    expect(audit.rows[0].data_json).toMatchObject({ submissionId, kind: "submission" });
    await app.close();
  });

  test("同探员两份提交互相隔离，且导出保持提交时的历史问卷版本", async () => {
    const cos = fakeCos();
    const { app, headers, inspectorHeaders, inspectorId, storeA } = await createWorld(cos);
    // V1：旧题面 → 提交一份；copy 出 V2 改题面 → 再提交一份（同一探员）
    const version1 = await createDraft(app, headers, [{ number: 1, category: "service", text: "历史版本旧题面", maxScore: 5 }], "历史隔离问卷");
    const submitted1 = await submitQuestionnaire(app, {
      headers, inspectorHeaders, inspectorId, versionId: version1, storeId: storeA.storeId, name: "历史任务一",
      answerSpec: [{ questionId: (await listQuestions(app, headers, version1))[0].id, answer: "scored", awardedScore: 5 }],
    });
    const copied = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${version1}/copy`, headers: { ...headers, "idempotency-key": uuidv7() } });
    expect(copied.statusCode, copied.body).toBe(201);
    const version2 = copied.json().version.id;
    const question2 = (await listQuestions(app, headers, version2))[0];
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/questionnaire-versions/${version2}/questions/${question2.id}`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: question2.revision, text: "历史版本新题面" } });
    expect(patched.statusCode, patched.body).toBe(200);
    const submitted2 = await submitQuestionnaire(app, {
      headers, inspectorHeaders, inspectorId, versionId: version2, storeId: storeA.storeId, name: "历史任务二",
      answerSpec: [{ questionId: (await listQuestions(app, headers, version2))[0].id, answer: "unscored", awardedScore: 0, remark: "新题面不得分" }],
    });
    expect(submitted1.submissionId).not.toBe(submitted2.submissionId);

    // 明确导出第一份：只含旧题面与 V1，绝不混入第二份的新题面
    const requested = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId: submitted1.submissionId } });
    expect(requested.statusCode, requested.body).toBe(202);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    const workbook = await workbookOf(cos.uploaded[0]);
    const text = sheetText(workbook.getWorksheet("暗访评估表"));
    expect(String(workbook.getWorksheet("暗访评估表").getCell("A1").value)).toContain("V1");
    expect(text).toContain("历史版本旧题面");
    expect(text).toContain("历史任务一");
    expect(text).not.toContain("历史版本新题面");
    expect(text).not.toContain("历史任务二");
    expect(text).not.toContain("新题面不得分");
    await app.close();
  });

  test("创建时校验范围（含层级区域），worker 侧按快照复核并显式失败越权任务", async () => {
    const cos = fakeCos();
    const { app, headers, inspectorHeaders, adminId, inspectorId, storeA, cityId } = await createWorld(cos);
    const versionId = await createDraft(app, headers, [{ number: 1, category: "service", text: "范围检查题", maxScore: 5 }], "范围问卷");
    // 乙店直插一份提交（另一区域链）
    const provinceB = uuidv7(); const cityB = uuidv7();
    await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'乙省','100000',1)", [provinceB]);
    await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'乙市','100100',$2,2)", [cityB, provinceB]);
    const storeB = await insertStore("导出乙", "S-EXP-B", adminId, cityB);
    const versionB = await createDraft(app, headers, [{ number: 1, category: "service", text: "乙店题目", maxScore: 5 }], "乙店问卷");
    const submissionB = await insertBareSubmission({ storeId: storeB.storeId, versionId: versionB, userId: adminId, index: 1 });

    // 甲店提交走真实流程
    const { submissionId: submissionA } = await submitQuestionnaire(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId: storeA.storeId, name: "范围任务",
      answerSpec: [{ questionId: (await listQuestions(app, headers, versionId))[0].id, answer: "scored", awardedScore: 5 }],
    });

    // 1) 不存在的 id 显式 404
    const missing = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId: uuidv7() } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("SUBMISSION_NOT_FOUND");
    // 2) dashboard 与 submissionId 冲突
    const conflict = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId: submissionA, kind: "dashboard", dashboardFilters: { from: "2026-01-01", to: "2026-02-01" } } });
    // （dashboardFilters 先过 ExportRequestSchema 校验，冲突在 superRefine 之后的业务门拒绝）
    expect(conflict.statusCode).toBe(422);
    // 3) 门店乙负责人（store scope）看不到甲店提交，但可导出自己门店的
    const scopedAdmin = await insertUser("expscoped", "乙店管理员");
    await grantSuperAdmin(scopedAdmin);
    await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type,store_id) VALUES ($1,$2,'store',$3)", [uuidv7(), scopedAdmin, storeB.storeId]);
    const scopedLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "expscoped", password: "a-secure-password" } });
    const scopedHeaders = { cookie: scopedLogin.headers["set-cookie"], "x-csrf-token": scopedLogin.json().csrfToken, "idempotency-key": uuidv7() };
    // 乙店管理员导出甲店提交：404（不泄露越权对象存在性）；导出乙店提交：202
    const outOfScope = await app.inject({ method: "POST", url: "/api/admin/exports", headers: scopedHeaders, payload: { submissionId: submissionA } });
    expect(outOfScope.statusCode).toBe(404);
    const inScope = await app.inject({ method: "POST", url: "/api/admin/exports", headers: scopedHeaders, payload: { submissionId: submissionB } });
    expect(inScope.statusCode, inScope.body).toBe(202);
    // 4) 层级区域范围：市级（甲店区域的父级）scope 命中
    const regionAdmin = await insertUser("expregion", "市级管理员");
    await grantSuperAdmin(regionAdmin);
    await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type,region_id) VALUES ($1,$2,'region',$3)", [uuidv7(), regionAdmin, cityId]);
    const regionLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "expregion", password: "a-secure-password" } });
    const regionHeaders = { cookie: regionLogin.headers["set-cookie"], "x-csrf-token": regionLogin.json().csrfToken, "idempotency-key": uuidv7() };
    const hierarchical = await app.inject({ method: "POST", url: "/api/admin/exports", headers: regionHeaders, payload: { submissionId: submissionA } });
    expect(hierarchical.statusCode, hierarchical.body).toBe(202);

    // 5) worker 侧复核：把甲店提交的 job 快照改成乙店 store scope → 显式失败，不产出文件
    const tamperedId = uuidv7();
    await pool.query(`INSERT INTO export_jobs (id,requested_by,scope_snapshot_json,filters_json,job_kind,status,expires_at)
      VALUES ($1,$2,$3,$4,'submission','queued',now()+INTERVAL '7 days')`,
    [tamperedId, adminId, JSON.stringify([{ scope_type: "store", store_id: storeB.storeId }]), JSON.stringify({ kind: "submissions", submissionId: submissionA })]);
    // 6) 缺 submissionId 的 submission 任务同样显式失败
    const noTargetId = uuidv7();
    await pool.query(`INSERT INTO export_jobs (id,requested_by,scope_snapshot_json,filters_json,job_kind,status,expires_at)
      VALUES ($1,$2,$3,$4,'submission','queued',now()+INTERVAL '7 days')`,
    [noTargetId, adminId, JSON.stringify([{ scope_type: "all" }]), JSON.stringify({ kind: "submissions" })]);
    const outcome = await runExportJobs({ pool, cos, limit: 10 });
    expect(outcome).toMatchObject({ claimed: 4, completed: 2, failed: 2 });
    const failed = await pool.query("SELECT id,failure_code FROM export_jobs WHERE status='failed' ORDER BY created_at");
    expect(Object.fromEntries(failed.rows.map((row) => [row.id, row.failure_code]))).toEqual({ [tamperedId]: EXPORT_SUBMISSION_NOT_FOUND, [noTargetId]: EXPORT_SUBMISSION_REQUIRED });
    // 失败任务不产出文件：成功的两单分别为乙店管理员（乙店）与市级管理员（甲店）的导出
    expect(cos.uploaded).toHaveLength(2);
    const firstWorkbook = await workbookOf(cos.uploaded[0]);
    expect(sheetText(firstWorkbook.getWorksheet("暗访评估表"))).toContain("乙店题目");
    const secondWorkbook = await workbookOf(cos.uploaded[1]);
    expect(sheetText(secondWorkbook.getWorksheet("暗访评估表"))).toContain("范围检查题");
    await app.close();
  });

  test("缺失历史评分的提交显式失败，不产出空报表", async () => {
    const cos = fakeCos();
    const { app, headers, adminId, storeA } = await createWorld(cos);
    const versionId = uuidv7();
    const templateId = uuidv7();
    await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'无分题库','secret',$2)", [templateId, adminId]);
    await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_at,published_by) VALUES ($1,$2,1,'published',$3,now(),$3)", [versionId, templateId, adminId]);
    const submissionId = uuidv7();
    const campaignId = uuidv7();
    const assignmentId = uuidv7();
    const attemptId = uuidv7();
    await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,'C-NOSCORE','无分任务',$2,now(),now()+INTERVAL '1 hour',now()+INTERVAL '2 hour','draft',$3)", [campaignId, storeA.storeId, adminId]);
    await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by) VALUES ($1,'A-NOSCORE',$2,$3,$4,'secret',now(),now()+INTERVAL '1 hour',0,'draft',$5)", [assignmentId, campaignId, adminId, versionId, adminId]);
    await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
    await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
      VALUES ($1,$2,$3,$4,$5,$6,now(),80,100,0,'[]','[]','{}','[]','[]','[]',$7)`, [submissionId, attemptId, assignmentId, campaignId, versionId, adminId, "c".repeat(64)]);
    const requested = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId } });
    expect(requested.statusCode, requested.body).toBe(202);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    const job = await pool.query("SELECT status,failure_code,file_name FROM export_jobs WHERE id=$1", [requested.json().id]);
    expect(job.rows[0]).toMatchObject({ status: "failed", failure_code: EXPORT_SUBMISSION_SCORES_MISSING, file_name: null });
    expect(cos.uploaded).toHaveLength(0);
    // 详情状态接口可见失败并可重新发起
    const state = await app.inject({ method: "GET", url: `/api/admin/exports/${requested.json().id}`, headers });
    expect(state.json().status).toBe("failed");
    expect(state.json().downloadUrl).toBeNull();
    await app.close();
  });

  test("reexport 原样保留 submissionId 并按当前范围重校验", async () => {
    const cos = fakeCos();
    const { app, headers, inspectorHeaders, adminId, inspectorId, storeA } = await createWorld();
    const versionId = await createDraft(app, headers, [{ number: 1, category: "service", text: "重导检查题", maxScore: 5 }], "重导问卷");
    const { submissionId } = await submitQuestionnaire(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId: storeA.storeId, name: "重导任务",
      answerSpec: [{ questionId: (await listQuestions(app, headers, versionId))[0].id, answer: "scored", awardedScore: 5 }],
    });
    const first = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId } });
    expect(first.statusCode).toBe(202);
    // 手工把首个任务打成 expired（模拟 7 天过期后的重新生成路径）
    await pool.query("UPDATE export_jobs SET status='expired',expires_at=now()-INTERVAL '1 hour' WHERE id=$1", [first.json().id]);
    const reexport = await app.inject({ method: "POST", url: `/api/admin/exports/${first.json().id}/reexport`, headers: { ...headers, "idempotency-key": uuidv7() } });
    expect(reexport.statusCode, reexport.body).toBe(202);
    expect(reexport.json().fileName).toBe("单份问卷导出");
    const newJob = await pool.query("SELECT job_kind,filters_json,requested_by FROM export_jobs WHERE id=$1", [reexport.json().id]);
    expect(newJob.rows[0].job_kind).toBe("submission");
    expect(newJob.rows[0].filters_json.submissionId).toBe(submissionId);
    // 范围收回后 reexport 重新校验当前范围并拒绝
    await pool.query("UPDATE user_data_scopes SET revoked_at=now() WHERE user_id=$1", [adminId]);
    const denied = await app.inject({ method: "POST", url: `/api/admin/exports/${first.json().id}/reexport`, headers: { ...headers, "idempotency-key": uuidv7() } });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe("SUBMISSION_NOT_FOUND");
    await pool.query("UPDATE user_data_scopes SET revoked_at=NULL WHERE user_id=$1", [adminId]);
    // 新任务跑完产出真实 xlsx
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    const workbook = await workbookOf(cos.uploaded[0]);
    expect(sheetText(workbook.getWorksheet("暗访评估表"))).toContain("重导检查题");
    await app.close();
  });

  test("汇总 CSV 与看板链路不受影响，7 天过期清理照常", async () => {
    const cos = fakeCos();
    const { app, headers, inspectorHeaders, adminId, inspectorId, storeA } = await createWorld();
    const versionId = await createDraft(app, headers, [{ number: 1, category: "service", text: "汇总链路题", maxScore: 5 }], "汇总问卷");
    await submitQuestionnaire(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId: storeA.storeId, name: "汇总任务",
      answerSpec: [{ questionId: (await listQuestions(app, headers, versionId))[0].id, answer: "scored", awardedScore: 5 }],
    });
    // 不带 submissionId：仍是 CSV 汇总导出
    const summary = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { filters: {} } });
    expect(summary.statusCode).toBe(202);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    expect(cos.uploaded).toHaveLength(1);
    expect(cos.uploaded[0].key.endsWith(".csv")).toBe(true);
    const csvBody = cos.uploaded[0].body.toString("utf8");
    expect(csvBody.startsWith("﻿")).toBe(true);
    expect(csvBody).toContain("提交时间");
    expect(csvBody).toContain("汇总任务");
    // 过期清理链路对 xlsx 单份任务同样生效
    const single = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId: (await pool.query("SELECT id FROM submission_versions LIMIT 1")).rows[0].id } });
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    await pool.query("UPDATE export_jobs SET expires_at=now()-INTERVAL '1 hour' WHERE id=$1", [single.json().id]);
    expect(await expireExportJobs({ pool, cos })).toMatchObject({ expired: 1 });
    expect(cos.deleted).toHaveLength(1);
    expect(cos.deleted[0].endsWith(".xlsx")).toBe(true);
    const expiredRow = await pool.query("SELECT status FROM export_jobs WHERE id=$1", [single.json().id]);
    expect(expiredRow.rows[0].status).toBe("expired");
    await app.close();
  });

  test("本地存储适配器：xlsx 以真实文件落盘并可签名下载（与 COS 同接口）", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = await mkdtemp(path.join(tmpdir(), "junde-submission-export-"));
    try {
      const { createLocalStorageProvider } = await import("../../apps/api/src/storage/local.js");
      const storage = createLocalStorageProvider({ ...config, STORAGE_PROVIDER: "local", LOCAL_STORAGE_DIR: root, PUBLIC_API_ORIGIN: "http://127.0.0.1:9", HOST: "127.0.0.1", PORT: "9" });
      await storage.assertReady();
      // 直接复用 worker 的产出：构造模型 → 构建工作簿 → putExportObject
      const { buildSubmissionWorkbook, buildSubmissionExportModel } = await import("../../apps/worker/src/submission-export.js");
      const submissionId = uuidv7();
      const model = buildSubmissionExportModel({
        submission: { id: submissionId, total_score: 5, max_score: 10, issue_count: 0, task_name: "本地任务", business_no: "L-1", store_name: "本地门店", brand_name: null, region_name: "本地区域", inspector_name: "本地探员", questionnaire_name: "本地问卷", version_number: 1, submitted_at: new Date(), visit_at: null, other_snapshot_json: { highlight: "好" }, dish_snapshot_json: [], evidence_snapshot_json: [], receipt_snapshot_json: [] },
        scoreRows: [{ question_id: uuidv7(), question_key: "k1", question_number: 1, question_text: "本地题目", category: "product", category_name: "产品品质", answer: "scored", awarded_score: 5, max_score: 10, is_score_wipe: false }],
      });
      const key = `exports/${submissionId}/worker.xlsx`;
      await storage.putExportObject({ key, body: Buffer.from(await buildSubmissionWorkbook(model)), contentType: XLSX_CONTENT_TYPE });
      const stored = await readFile(path.join(root, "exports", submissionId, "worker.xlsx"));
      expect(stored.slice(0, 2).toString("latin1")).toBe("PK"); // 真实 zip/xlsx，而非改名 CSV
      const meta = JSON.parse(await readFile(path.join(root, "meta", `${key}.json`), "utf8"));
      expect(meta.contentType).toBe(XLSX_CONTENT_TYPE);
      const download = await storage.createExportDownloadUrl(key);
      expect(download.url).toContain("operation=download");
      await storage.deleteExportObject(key);
      await expect(readFile(path.join(root, "exports", submissionId, "worker.xlsx"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  test("历史快照重建：删除物化得分行后导出仍成功（真实分类名、清零语义、重建标注）", async () => {
    const cos = fakeCos();
    const { app, headers, inspectorHeaders, inspectorId, storeA } = await createWorld(cos);
    const versionId = await createDraft(app, headers, [
      { number: 1, category: "environment", text: "历史清零题", maxScore: 2, scoreWipe: true },
      { number: 2, category: "environment", text: "历史普通题", maxScore: 3 },
      { number: 3, category: "service", text: "历史服务题", maxScore: 5 },
    ], "历史重建问卷");
    const rows = await listQuestions(app, headers, versionId);
    const wipe = rows.find((row) => row.scoreWipe);
    const envNormal = rows.find((row) => row.category === "environment" && !row.scoreWipe);
    const service = rows.find((row) => row.category === "service");
    const { submissionId } = await submitQuestionnaire(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId: storeA.storeId, name: "历史重建任务",
      answerSpec: [
        { questionId: wipe.id, answer: "unscored", awardedScore: 0, remark: "过期食材" },
        { questionId: envNormal.id, answer: "scored", awardedScore: 3 },
        { questionId: service.id, answer: "scored", awardedScore: 5 },
      ],
    });
    // 模拟 0028 之前的存量提交：物化逐题明细不存在，只有提交快照 + 固定版本题目
    await pool.query("DELETE FROM submission_question_scores WHERE submission_id=$1", [submissionId]);
    const requested = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId } });
    expect(requested.statusCode, requested.body).toBe(202);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    const workbook = await workbookOf(cos.uploaded[0]);
    const text = sheetText(workbook.getWorksheet("暗访评估表"));
    // 真实分类展示名（question_categories）进入重建结果；清零语义与快照备注原样保留
    expect(text).toContain("环境卫生");
    expect(text).toContain("为客服务");
    expect(text).toContain("清零：C1「历史清零题」被判不得分");
    // 清零前合计 = 环境分类内 scored 题满分（第 2 题 3 分），非全分类满分
    expect(text.replace(/\n/g, "")).toContain("清零前合计 3 分不计");
    expect(text).toContain("过期食材");
    // 重建来源等技术口径在「作答明细」补充页说明行，主报表保持参考模板风格的业务文案
    const answerText = sheetText(workbook.getWorksheet("作答明细"), 6);
    expect(answerText).toContain("逐题得分由提交快照与固定版本题目重建");
    expect(text).not.toContain("逐题得分由提交快照");
    const totalSheet = workbook.getWorksheet("暗访评估表");
    expect(totalSheet.getCell("K4").value).toBe(50);
    expect(text).toContain("原始总分 5/10 分");
    await app.close();
  });

  test("快照残缺或重放总分不符时显式失败，绝不默认补答案或凑对账", async () => {
    const cos = fakeCos();
    const { app, headers, inspectorHeaders, inspectorId, storeA } = await createWorld(cos);
    const versionId = await createDraft(app, headers, [
      { number: 1, category: "service", text: "双题之一", maxScore: 5 },
      { number: 2, category: "service", text: "双题之二", maxScore: 5 },
    ], "残缺快照问卷");
    const questionRows = await listQuestions(app, headers, versionId);
    const { submissionId } = await submitQuestionnaire(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId: storeA.storeId, name: "残缺快照任务",
      answerSpec: [
        { questionId: questionRows[0].id, answer: "scored", awardedScore: 5 },
        { questionId: questionRows[1].id, answer: "scored", awardedScore: 5 },
      ],
    });
    await pool.query("DELETE FROM submission_question_scores WHERE submission_id=$1", [submissionId]);
    // 残缺快照：只保留第一题作答 → 缺第二题，必须失败而不是默认补“得分”
    await pool.query("UPDATE submission_versions SET answer_snapshot_json=$2::jsonb WHERE id=$1",
      [submissionId, JSON.stringify([{ question_id: questionRows[0].id, answer: "scored", awarded_score: 5, issue_remark: "" }])]);
    const first = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId } });
    expect(first.statusCode).toBe(202);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect((await pool.query("SELECT failure_code FROM export_jobs WHERE id=$1", [first.json().id])).rows[0].failure_code).toBe(EXPORT_SUBMISSION_SCORES_MISSING);
    // 完整快照但重放总分与落库总分不一致（快照与提交不对应）→ 同样失败
    await pool.query("UPDATE submission_versions SET answer_snapshot_json=$2::jsonb, total_score=7 WHERE id=$1",
      [submissionId, JSON.stringify([
        { question_id: questionRows[0].id, answer: "scored", awarded_score: 5, issue_remark: "" },
        { question_id: questionRows[1].id, answer: "scored", awarded_score: 5, issue_remark: "" },
      ])]);
    const second = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId } });
    expect(second.statusCode).toBe(202);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect((await pool.query("SELECT failure_code FROM export_jobs WHERE id=$1", [second.json().id])).rows[0].failure_code).toBe(EXPORT_SUBMISSION_SCORES_MISSING);
    expect(cos.uploaded).toHaveLength(0);
    await app.close();
  });

  test("暗访日期/时段只取本探员不晚于提交时间的打卡；提交后的新打卡不改变旧报告", async () => {
    const cos = fakeCos();
    const { app, headers, inspectorHeaders, adminId, inspectorId, storeA } = await createWorld(cos);
    const versionId = await createDraft(app, headers, [{ number: 1, category: "service", text: "打卡时间题", maxScore: 5 }], "打卡时间问卷");
    const { submissionId, assignmentId } = await submitQuestionnaire(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId: storeA.storeId, name: "打卡时间任务",
      answerSpec: [{ questionId: (await listQuestions(app, headers, versionId))[0].id, answer: "scored", awardedScore: 5 }],
    });
    const submittedAt = (await pool.query("SELECT submitted_at FROM submission_versions WHERE id=$1", [submissionId])).rows[0].submitted_at;
    const firstCheckin = (await pool.query("SELECT max(captured_at) AS t FROM audit_checkins WHERE assignment_id=$1 AND inspector_id=$2 AND result='accepted'", [assignmentId, inspectorId])).rows[0].t;
    expect(firstCheckin).toBeTruthy();
    // 任务被复用/恢复后出现更晚的合格打卡：不得影响这份提交的暗访日期/时段
    await pool.query(`INSERT INTO audit_checkins (id,assignment_id,inspector_id,latitude_gcj02,longitude_gcj02,accuracy_meters,captured_at,received_at,
        store_latitude_snapshot,store_longitude_snapshot,base_radius_snapshot,accuracy_allowance_meters,allowance_max_snapshot,effective_radius_meters,result,valid_until)
      VALUES ($1,$2,$3,31.2304,121.4737,10,$4,now(),31.2304,121.4737,300,0,200,300,'accepted',$5)`,
    [uuidv7(), assignmentId, inspectorId, new Date(submittedAt.getTime() + 3_600_000), new Date(submittedAt.getTime() + 7_200_000)]);
    const requested = await app.inject({ method: "POST", url: "/api/admin/exports", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { submissionId } });
    expect(requested.statusCode, requested.body).toBe(202);
    expect(await runExportJobs({ pool, cos })).toMatchObject({ claimed: 1, completed: 1 });
    const workbook = await workbookOf(cos.uploaded[0]);
    const exportSheet = workbook.getWorksheet("暗访评估表");
    // 暗访日期 = 打卡日；暗访时段 = 打卡精确时刻（HH:MM），绝不臆测时段名称
    expect(exportSheet.getCell("B5").value).toBe(formatShanghaiDateTime(firstCheckin).slice(0, 10));
    expect(exportSheet.getCell("F5").value).toBe(formatShanghaiDateTime(firstCheckin).slice(11, 16));
    expect(exportSheet.getCell("F5").value).not.toBe(formatShanghaiDateTime(new Date(submittedAt.getTime() + 3_600_000)).slice(11, 16));
    await app.close();
  });
});
import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { monthRange } from "../../apps/api/src/stats/queries.js";
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

async function createUser(pool, username, roleCode, scopeType = "all") {
  const passwordHash = await createPasswordService().hash("A-secure-pass");
  const userId = uuidv7();
  await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,$2,$3,$2,'cipher',$3,now(),$4,'approved_active')", [userId, username, username.toLowerCase(), passwordHash]);
  const role = await pool.query("SELECT id FROM roles WHERE code=$1", [roleCode]);
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), userId, role.rows[0].id]);
  if (scopeType) await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,$3)", [uuidv7(), userId, scopeType]);
  return userId;
}

async function loginAdmin(app, username) {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username, password: "A-secure-pass" } });
  expect(login.statusCode).toBe(200);
  return { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken };
}

// 两家门店（同城不同区）+ 一份两题问卷（环境 2 分 / 为客 2 分）：
// 门店甲 7 月全对（总分 4），门店乙 8 月服务题不得分（总分 2）。
async function seedDashboardData(pool, ownerId) {
  const brandId = uuidv7();
  await pool.query("INSERT INTO brands (id,name,active) VALUES ($1,'测试品牌',true)", [brandId]);
  const provinceId = uuidv7();
  const cityId = uuidv7();
  const districtA = uuidv7();
  const districtB = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'云南省','530000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'昆明市','530100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'盘龙区','530102',$2,3)", [districtA, cityId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'五华区','530103',$2,3)", [districtB, cityId]);
  const storeA = uuidv7();
  const storeB = uuidv7();
  await pool.query("INSERT INTO stores (id,business_no,name,brand_id,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by,active) VALUES ($1,'S-A','门店甲',$2,$3,'地址',25.05,102.71,'poi',now(),$4,true)", [storeA, brandId, districtA, ownerId]);
  await pool.query("INSERT INTO stores (id,business_no,name,brand_id,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by,active) VALUES ($1,'S-B','门店乙',$2,$3,'地址',25.04,102.70,'poi',now(),$4,true)", [storeB, brandId, districtB, ownerId]);
  const versionId = uuidv7();
  const templateId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'看板题库','secret',$2)", [templateId, ownerId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, ownerId]);
  return { brandId, cityId, districtA, districtB, storeA, storeB, versionId };
}

describe("month range", () => {
  it("builds an inclusive month list", () => {
    expect(monthRange("2026-07-15", "2026-07-20")).toEqual(["2026-07"]);
    expect(monthRange("2026-11-02", "2027-02-10")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
});

describe.sequential("dashboard stats", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-dashboard-stats-tests'))");
    await pool.query("TRUNCATE submission_question_scores, submission_versions, survey_attempts, question_answers, question_evidence_requirements, questions, questionnaire_versions, questionnaire_templates, export_jobs, audit_logs, checkin_exemptions, audit_checkins, assignment_dish_requirements, audit_assignments, audit_campaigns, brands, stores, regions, auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_data_scopes, user_roles, role_permissions, permissions, roles, users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-dashboard-stats-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("aggregates trend, store, category and question rates with scope filtering", async () => {
    const ownerId = await createUser(pool, "Owner", "admin");
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await loginAdmin(app, "Owner");
    const data = await seedDashboardData(pool, ownerId);
    const envQuestion = uuidv7();
    const serviceQuestion = uuidv7();
    await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES ($1,$2,'q1',1,'environment','环境是否整洁',2,true,1),($3,$2,'q2',2,'service','迎宾是否主动',2,true,2)", [envQuestion, data.versionId, serviceQuestion]);
    const submission = async (storeId, submittedAt, envScored, serviceScored) => {
      const campaignId = uuidv7();
      const assignmentId = uuidv7();
      const attemptId = uuidv7();
      const submissionId = uuidv7();
      const inspectorId = uuidv7();
      const suffix = storeId.replaceAll("-", "").slice(-12);
      await pool.query("INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,$2,$2,$2,'c',$2,now(),$3,'approved_active')", [inspectorId, `inspector-${suffix}`, "x"]);
      await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,$2,'看板任务',$3,$4,$5,$5,'completed',$6)", [campaignId, `C-${suffix}`, storeId, new Date("2026-07-01"), new Date("2026-08-31"), ownerId]);
      await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,questionnaire_deadline_at,budget_limit_cents,status,created_by) VALUES ($1,$2,$3,$4,$5,'secret',$6,$7,$7,0,'submitted',$8)", [assignmentId, `A-${suffix}`, campaignId, inspectorId, data.versionId, new Date("2026-07-01"), new Date("2026-08-31"), ownerId]);
      await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status,submitted_at) VALUES ($1,$2,$3,'secret','submitted',$4)", [attemptId, assignmentId, data.versionId, submittedAt]);
      const answers = [[envQuestion, envScored], [serviceQuestion, serviceScored]];
      for (const [questionId, scored] of answers) {
        await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,$3,$4,$5)", [attemptId, questionId, scored ? "scored" : "unscored", scored ? 2 : 0, scored ? "" : "现场不达标"]);
      }
      const total = (envScored ? 2 : 0) + (serviceScored ? 2 : 0);
      await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,4,$9,'[]','[]','{}','[]','[]','[]',$10)`, [submissionId, attemptId, assignmentId, campaignId, data.versionId, inspectorId, submittedAt, total, envScored && serviceScored ? 0 : 1, "a".repeat(64)]);
      return submissionId;
    };
    const submissionA = await submission(data.storeA, new Date("2026-07-15T10:00:00+08:00"), true, true);
    const submissionB = await submission(data.storeB, new Date("2026-08-10T10:00:00+08:00"), true, false);

    // 回填 SQL 与 0026 迁移一致（幂等，可重跑）
    const runBackfill = () => pool.query(`INSERT INTO submission_question_scores (id, submission_id, question_id, question_key, question_number, question_text, category, answer, awarded_score, max_score)
      SELECT gen_random_uuid(), sv.id, q.id, q.question_key, q.question_number, q.text, q.category, qa.answer, qa.awarded_score, q.max_score
      FROM submission_versions sv
      JOIN question_answers qa ON qa.attempt_id = sv.attempt_id
      JOIN questions q ON q.id = qa.question_id AND q.version_id = sv.questionnaire_version_id AND q.enabled
      ON CONFLICT (submission_id, question_id) DO NOTHING`);
    await runBackfill();
    expect((await pool.query("SELECT count(*)::int n FROM submission_question_scores")).rows[0].n).toBe(4);

    const stats = await app.inject({ method: "GET", url: "/api/admin/stats/dashboard?from=2026-07-01&to=2026-08-31", headers });
    expect(stats.statusCode, stats.body).toBe(200);
    const body = stats.json();
    expect(body.months).toEqual(["2026-07", "2026-08"]);
    expect(body.trend).toEqual([
      { month: "2026-07", submissions: 1, score: 100 },
      { month: "2026-08", submissions: 1, score: 50 },
    ]);
    expect(body.stores.map((row) => [row.storeName, row.overall, row.submissions])).toEqual([["门店甲", 100, 1], ["门店乙", 50, 1]]);
    expect(body.stores[1].monthly).toEqual([{ month: "2026-07", score: null }, { month: "2026-08", score: 50 }]);
    expect(body.categories.map((category) => category.code)).toEqual(["environment", "service", "product"]);
    expect(body.storeCategories.map((row) => row.storeName)).toEqual(["门店甲", "门店乙"]);
    expect(body.storeCategories[1].rates).toEqual([{ category: "environment", rate: 100 }, { category: "service", rate: 0 }, { category: "product", rate: null }]);
    // 考核点按平均得分率升序（薄弱优先），差值 = 最后一月 - 前一月
    expect(body.questions.map((row) => [row.key, row.overallRate, row.delta])).toEqual([["k2", 50, -100], ["k1", 100, 0]]);

    // 鉴权模型与 submissions 一致：权限与数据范围解耦——范围受限管理员通过权限门
    // （authorizeAdmin 只判权限并携带 scopes），由查询内的 user_data_scopes EXISTS 过滤数据：
    // store 范围管理员只看到范围内门店乙的提交，范围外门店甲不可见。
    const scopedId = await createUser(pool, "Scoped", "admin", null);
    await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type,store_id) VALUES ($1,$2,'store',$3)", [uuidv7(), scopedId, data.storeB]);
    const scopedHeaders = await loginAdmin(app, "Scoped");
    const scoped = await app.inject({ method: "GET", url: "/api/admin/stats/dashboard?from=2026-07-01&to=2026-08-31", headers: scopedHeaders });
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(scoped.json().stores.map((row) => row.storeName)).toEqual(["门店乙"]);

    // 无 stats:read 权限（reviewer 未绑定任何权限）→ 403
    await createUser(pool, "Reviewer", "reviewer");
    const reviewerHeaders = await loginAdmin(app, "Reviewer");
    const forbidden = await app.inject({ method: "GET", url: "/api/admin/stats/dashboard", headers: reviewerHeaders });
    expect(forbidden.statusCode).toBe(403);

    // 回填幂等：重跑不产生重复行
    await runBackfill();
    const restored = await pool.query("SELECT count(*)::int n FROM submission_question_scores");
    expect(restored.rows[0].n).toBe(4);
    await app.close();
  });
});

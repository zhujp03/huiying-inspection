import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { SubmissionDetailSchema } from "../../packages/contracts/index.js";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

// 管理端提交详情契约回归（真实 HTTP API × 前端同一份 SubmissionDetailSchema）：
// 曾因 dishes DTO 漏掉 evaluation/fullySatisfied、issueRemark 输出 null 导致整份详情
// 在前端契约校验失败（页面只剩报错、导出入口被隐藏）。这里用真实库里的提交快照
// （正常/替代/售罄/额外菜品、有无备注的题目）逐一断言 safeParse 通过，且 DTO 不篡改快照语义。

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it.sequential : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", API_REQUEST_TIMEOUT_MS: 12000, AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
};

const STORE_COORDS = { latitude: 31.2304, longitude: 121.4737 };

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

async function createStoreWithRegion(createdBy) {
  const provinceId = uuidv7(); const cityId = uuidv7();
  const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'契约测试区','310104',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-DC-A','契约测试店',$2,'测试地址',$3,$4,'poi',now(),$5)", [storeId, regionId, STORE_COORDS.latitude, STORE_COORDS.longitude, createdBy]);
  return { storeId, cityId, regionId };
}

async function createWorld() {
  const adminId = await insertUser("dcadmin", "契约超管");
  const inspectorId = await insertUser("dcinspector", "契约探员");
  await grantSuperAdmin(adminId);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  const { storeId, cityId } = await createStoreWithRegion(adminId);
  const app = buildApp({ config, pool, storage: fakeCos(), logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test" }) } });
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "dcadmin", password: "a-secure-password" } });
  expect(login.statusCode, login.body).toBe(200);
  const inspectorLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "dcinspector", password: "a-secure-password" } });
  expect(inspectorLogin.statusCode, inspectorLogin.body).toBe(200);
  return {
    adminId, inspectorId, app, storeId, cityId,
    headers: { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken, "idempotency-key": uuidv7() },
    inspectorHeaders: { authorization: `Bearer ${inspectorLogin.json().accessToken}` },
  };
}

const fakeCos = () => ({
  exportConfigured: true,
  putExportObject: async () => {},
  deleteExportObject: async () => {},
  createExportDownloadUrl: async () => ({ url: "https://private.example.test/export", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  createPreviewUrl: async () => ({ url: "https://private.example.test/preview" }),
});

async function createPublishedVersion(app, headers, name) {
  const created = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { ...headers, "idempotency-key": uuidv7() }, payload: {
    name, questions: [
      { number: 1, category: "service", text: "契约服务题", maxScore: 5 },
      { number: 2, category: "service", text: "契约扣分题", maxScore: 5 },
    ],
  } });
  expect(created.statusCode, created.body).toBe(201);
  const versionId = created.json().version.id;
  const versionRow = await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [versionId]);
  const published = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: Number(versionRow.rows[0].revision) } });
  expect(published.statusCode, published.body).toBe(200);
  return versionId;
}

// 真实探员全流程提交；dishPlan 描述提交时要落库的菜品形态（validateDishes 合法输入）
async function submitWithDishes(app, { headers, inspectorHeaders, inspectorId, versionId, storeId, name, dishPlan, remarkOnQuestion2 = true }) {
  const startsAt = new Date(Date.now() - 60_000).toISOString();
  const dueAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const campaign = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers, "idempotency-key": uuidv7() }, payload: { name, storeId, startsAt, dueAt, questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "契约测试" } });
  expect(campaign.statusCode, campaign.body).toBe(201);
  const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/assignments`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { inspectorId, questionnaireVersionId: versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: false, specialInstruction: "", campaignRevision: 0 } });
  expect(assignment.statusCode, assignment.body).toBe(201);
  const assignmentId = assignment.json().id;
  // 菜品要求直插（本测试聚焦详情契约，不走指派编辑接口）；开卷时 attempt 会据此生成 dish_records
  const requirements = dishPlan.filter((dish) => dish.requirement);
  for (const [index, dish] of requirements.entries()) {
    await pool.query("INSERT INTO assignment_dish_requirements (id,assignment_id,planned_name,quantity,required,allow_substitution,max_unit_price_cents,instruction,sort_order) VALUES ($1,$2,$3,1,$4,$5,NULL,'',$6)",
      [uuidv7(), assignmentId, dish.plannedName, dish.required ?? true, dish.allowSubstitution ?? true, index + 1]);
  }
  const published = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaign.json().campaign.id}/publish`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 1 } });
  expect(published.statusCode, published.body).toBe(200);
  const checkin = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/check-in`, headers: inspectorHeaders, payload: { latitude: STORE_COORDS.latitude, longitude: STORE_COORDS.longitude, accuracy: 10, capturedAt: new Date().toISOString() } });
  expect(checkin.statusCode, checkin.body).toBe(200);
  const started = await app.inject({ method: "POST", url: `/api/assignments/${assignmentId}/start`, headers: inspectorHeaders });
  expect(started.statusCode, started.body).toBe(200);
  const attemptId = started.json().attempt.id;
  const assignmentRevision = Number((await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [assignmentId])).rows[0].revision);
  const questions = await pool.query("SELECT id,question_number,max_score FROM questions WHERE version_id=$1 ORDER BY question_number", [versionId]);
  for (const question of questions.rows) {
    const unscored = question.question_number === 2 && remarkOnQuestion2;
    await pool.query("INSERT INTO question_answers (attempt_id,question_id,answer,awarded_score,issue_remark) VALUES ($1,$2,$3,$4,$5)",
      [attemptId, question.id, unscored ? "unscored" : "scored", unscored ? 0 : question.max_score, unscored ? "现场确实没做到" : ""]);
  }
  await pool.query("INSERT INTO other_records (attempt_id,highlight,suggestion) VALUES ($1,$2,$3)", [attemptId, "环境整洁", "保持"]);
  // 按计划把开卷生成的 dish_records 调整成目标形态（服务端提交校验用 validateDishes，输入必须合法）
  const dishes = (await pool.query("SELECT * FROM dish_records WHERE attempt_id=$1 ORDER BY sort_order", [attemptId])).rows;
  let requirementIndex = 0;
  for (const dish of dishPlan) {
    if (dish.extra) {
      await pool.query(`INSERT INTO dish_records (id,attempt_id,assignment_id,sort_order,actual_name,quantity,unit_price_cents,line_total_cents,fulfillment_status,fully_satisfied,source,manually_modified,price_derived,review_fields)
        VALUES ($1,$2,$3,$4,$5,1,$6,$7,'extra',true,'manual',true,false,'[]'::jsonb)`,
      [uuidv7(), attemptId, assignmentId, dishes.length + 1, dish.actualName, dish.unitPriceCents ?? null, dish.lineTotalCents ?? null]);
      continue;
    }
    const row = dishes[requirementIndex];
    requirementIndex += 1;
    await pool.query("UPDATE dish_records SET actual_name=$2,quantity=1,unit_price_cents=$3,line_total_cents=$4,fulfillment_status=$5,substitution_reason=$6,unavailable_reason=$7,evaluation=$8,fully_satisfied=$9 WHERE id=$1",
      [row.id, dish.actualName, dish.unitPriceCents ?? null, dish.lineTotalCents ?? null, dish.fulfillmentStatus, dish.substitutionReason ?? null, dish.unavailableReason ?? null, dish.evaluation ?? null, dish.fullySatisfied]);
  }
  const submit = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attemptId}/submit`, headers: inspectorHeaders, payload: { submitToken: uuidv7(), assignmentRevision, confirmation: true } });
  expect(submit.statusCode, submit.body).toBe(200);
  return (await pool.query("SELECT id FROM submission_versions WHERE attempt_id=$1", [attemptId])).rows[0].id;
}

const dishDetailOf = (detail, name) => detail.dishes.find((dish) => dish.plannedName === name || dish.actualName === name);

describe.sequential("PostgreSQL admin submission detail contract", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-submission-detail-contract-tests'))");
    await pool.query("TRUNCATE export_jobs,audit_logs,submission_question_scores,submission_versions,survey_attempts,object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,question_categories,brands,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    // 与导出集成测试同款分类种子（survey_attempts.current_category 默认值引用 environment 分类）
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-submission-detail-contract-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("含替代/售罄/额外菜品的真实提交通过前端同一份 SubmissionDetailSchema", async () => {
    const { app, headers, inspectorHeaders, inspectorId, storeId } = await createWorld();
    const versionId = await createPublishedVersion(app, headers, "契约问卷");
    const submissionId = await submitWithDishes(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId, name: "契约任务",
      dishPlan: [
        // 正常已点：评价非空 + 全部满意
        { requirement: true, plannedName: "招牌烤鸭", actualName: "招牌烤鸭", fulfillmentStatus: "ordered", evaluation: "温度适宜，口感良好", fullySatisfied: true },
        // 替代：必须带替代原因
        { requirement: true, plannedName: "蟹粉豆腐", actualName: "菌菇豆腐", fulfillmentStatus: "substituted", substitutionReason: "蟹粉当日缺货", evaluation: "口感清淡", fullySatisfied: false, allowSubstitution: true },
        // 售罄：无实际菜名，evaluation 为 NULL、fullySatisfied false（未评价不等于满意）
        { requirement: true, plannedName: "桂花糖藕", actualName: null, fulfillmentStatus: "unavailable", unavailableReason: "晚市已售罄", evaluation: null, fullySatisfied: false },
        // 额外菜品：不关联任务要求（requirementId 为空），手工新增
        { extra: true, actualName: "酒酿圆子", unitPriceCents: 3800, lineTotalCents: 3800 },
      ],
    });
    const response = await app.inject({ method: "GET", url: `/api/admin/submissions/${submissionId}`, headers });
    expect(response.statusCode, response.body).toBe(200);
    const payload = response.json();
    // 与 apps/admin 完全相同的解析路径：任何契约偏差都会让详情页整页失败
    const parsed = SubmissionDetailSchema.safeParse(payload);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    // DTO 忠实还原快照语义：原因/评价/满意位不被篡改
    expect(dishDetailOf(parsed.data, "招牌烤鸭")).toMatchObject({ evaluation: "温度适宜，口感良好", fullySatisfied: true, substitutionReason: null, unavailableReason: null });
    expect(dishDetailOf(parsed.data, "蟹粉豆腐")).toMatchObject({ actualName: "菌菇豆腐", fulfillmentStatus: "substituted", substitutionReason: "蟹粉当日缺货", fullySatisfied: false });
    expect(dishDetailOf(parsed.data, "桂花糖藕")).toMatchObject({ actualName: null, fulfillmentStatus: "unavailable", unavailableReason: "晚市已售罄", evaluation: null, fullySatisfied: false });
    // 额外菜品：无要求关联，状态 extra 原样带出
    expect(parsed.data.dishes).toHaveLength(4);
    expect(dishDetailOf(parsed.data, "酒酿圆子")).toMatchObject({ requirementId: null, plannedName: null, actualName: "酒酿圆子", fulfillmentStatus: "extra", fullySatisfied: true });
    // 不得分题备注原样带出；得分题无备注键
    const scored = parsed.data.questions.find((question) => question.number === 1);
    const unscored = parsed.data.questions.find((question) => question.number === 2);
    expect(scored.issueRemark).toBeUndefined();
    expect(unscored.issueRemark).toBe("现场确实没做到");
    await app.close();
  });

  test("无菜品提交与历史快照的 null 备注/缺失可选值都通过契约", async () => {
    const { app, headers, inspectorHeaders, inspectorId, adminId, storeId } = await createWorld();
    const versionId = await createPublishedVersion(app, headers, "无菜契约问卷");
    // 1) 真实全流程、无任何菜品记录
    const submissionId = await submitWithDishes(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId, name: "无菜任务",
      dishPlan: [], remarkOnQuestion2: false,
    });
    const response = await app.inject({ method: "GET", url: `/api/admin/submissions/${submissionId}`, headers });
    expect(response.statusCode, response.body).toBe(200);
    const noDish = SubmissionDetailSchema.safeParse(response.json());
    expect(noDish.error?.issues ?? []).toEqual([]);
    expect(noDish.success).toBe(true);
    expect(noDish.data.questions.every((question) => question.issueRemark === undefined)).toBe(true);

    // 2) 历史快照形态：issue_remark=null、缺 substitution/unavailable/required 等键的旧 dish 快照
    const legacySubmissionId = await submitWithDishes(app, {
      headers, inspectorHeaders, inspectorId, versionId, storeId, name: "历史快照任务",
      dishPlan: [
        { requirement: true, plannedName: "老菜品", actualName: "老菜品", fulfillmentStatus: "ordered", evaluation: null, fullySatisfied: true },
      ],
    });
    await pool.query(`UPDATE submission_versions SET
        answer_snapshot_json = (SELECT jsonb_agg(CASE WHEN value->>'issue_remark' IS NULL THEN value ELSE jsonb_set(value, '{issue_remark}', 'null') END) FROM jsonb_array_elements(answer_snapshot_json) value),
        dish_snapshot_json = (
          SELECT jsonb_agg(value - 'substitution_reason' - 'unavailable_reason' - 'required_snapshot' - 'allow_substitution_snapshot' - 'unit_price_cents' - 'line_total_cents' - 'review_fields')
          FROM jsonb_array_elements(dish_snapshot_json) value
        )
      WHERE id=$1`, [legacySubmissionId]);
    const legacyResponse = await app.inject({ method: "GET", url: `/api/admin/submissions/${legacySubmissionId}`, headers });
    expect(legacyResponse.statusCode, legacyResponse.body).toBe(200);
    const legacy = SubmissionDetailSchema.safeParse(legacyResponse.json());
    expect(legacy.error?.issues ?? []).toEqual([]);
    expect(legacy.success).toBe(true);
    // null 备注按缺省处理；未评价菜品的 evaluation 保持 null、fullySatisfied 不会被迫成 true
    expect(legacy.data.questions.every((question) => question.issueRemark === undefined)).toBe(true);
    const legacyDish = legacy.data.dishes[0];
    expect(legacyDish).toMatchObject({ plannedName: "老菜品", evaluation: null, fullySatisfied: true, substitutionReason: null, unavailableReason: null, unitPriceCents: null, lineTotalCents: null });
    // 可选布尔缺省按保守方向（false），绝不把历史行标成已满足之外的含义
    expect(legacyDish.required).toBe(false);
    expect(legacyDish.allowSubstitution).toBe(false);
    await app.close();
  });
});

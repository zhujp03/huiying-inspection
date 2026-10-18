import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 管理列表全局排序回归：门店按店号自然序（数字段数值序 2<9<10，前导零数值相等由店号文本/id 兜底），
// 提交记录按实际 submitted_at（非 id/创建时间，同刻并列以 id 定序，空值恒排最后）。
// 两个列表都必须「先全局排序、再游标切片」：跨页不重不漏，且筛选/total/授权范围不受影响。

assertIntegrationTestDatabase();

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it.sequential : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", API_REQUEST_TIMEOUT_MS: 12000, AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
};

// 手机号全文件自增序列：phones 唯一约束下多账号互不冲突（138 000 00101 起）
let phoneSequence = 100;
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

// 基础世界：超管（范围 all）+ 探员 + 省市区种子与已登录 admin 会话
async function createWorld() {
  const adminId = await insertUser("orderadmin", "排序超管");
  const inspectorId = await insertUser("orderinspector", "排序探员");
  const superAdmin = await pool.query("SELECT id FROM roles WHERE code = 'super_admin'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, superAdmin.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  const provinceId = uuidv7(); const cityId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  const app = buildApp({ config, pool, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test" }) } });
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "orderadmin", password: "a-secure-password" } });
  expect(login.statusCode, login.body).toBe(200);
  return { adminId, inspectorId, app, cityId, headers: { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken, "idempotency-key": uuidv7() } };
}

// 区县 + 门店（区域 code 用店号保证唯一）；brandId 可空表示未分品牌
async function insertStore(cityId, createdBy, name, businessNo, brandId = null) {
  const regionId = uuidv7();
  const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,$2,$3,$4,3)", [regionId, `${name}区域`, `REG-${businessNo}`, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,brand_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,$2,$3,$4,$5,'测试地址',31.2304,121.4737,'poi',now(),$6)", [storeId, businessNo, name, regionId, brandId, createdBy]);
  return { regionId, storeId };
}

async function insertBrand(name) {
  const brandId = uuidv7();
  await pool.query("INSERT INTO brands (id,name,active) VALUES ($1,$2,true)", [brandId, name]);
  return brandId;
}

// 最小问卷版本（提交外键所需）
async function insertVersion(createdBy, name) {
  const templateId = uuidv7();
  const versionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,$2,'secret',$3)", [templateId, name, createdBy]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, createdBy]);
  return versionId;
}

// 直插一份最小提交（不经探员全流程）：submittedAt 显式指定，用于构造与 id/创建顺序不同的提交时间序
let submissionSequence = 0;
async function insertSubmission({ storeId, versionId, userId, submittedAt, name }) {
  submissionSequence += 1;
  const campaignId = uuidv7();
  const assignmentId = uuidv7();
  const attemptId = uuidv7();
  const submissionId = uuidv7();
  const startsAt = new Date(Date.now() - 3_600_000);
  const dueAt = new Date(Date.now() + 3_600_000);
  await pool.query("INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,questionnaire_deadline_at,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$6,'draft',$7)", [campaignId, `C-ORD-${String(submissionSequence).padStart(3, "0")}`, name, storeId, startsAt, dueAt, userId]);
  await pool.query("INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by) VALUES ($1,$2,$3,$4,$5,'secret',$6,$7,0,'draft',$8)", [assignmentId, `A-ORD-${String(submissionSequence).padStart(3, "0")}`, campaignId, userId, versionId, startsAt, dueAt, userId]);
  await pool.query("INSERT INTO survey_attempts (id,assignment_id,questionnaire_version_id,mode,status) VALUES ($1,$2,$3,'secret','draft')", [attemptId, assignmentId, versionId]);
  await pool.query(`INSERT INTO submission_versions (id,attempt_id,assignment_id,campaign_id,questionnaire_version_id,submitted_by,submitted_at,total_score,max_score,issue_count,answer_snapshot_json,dish_snapshot_json,other_snapshot_json,evidence_snapshot_json,receipt_snapshot_json,ocr_snapshot_json,integrity_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,5,5,0,'[]','[]','{}','[]','[]','[]',$8)`, [submissionId, attemptId, assignmentId, campaignId, versionId, userId, submittedAt, "d".repeat(64)]);
  return submissionId;
}

// 游标翻页收集全部行（每页 limit 条，cursor=上一页最后一条 id，与 usePagedRemote 相同的取法）
async function collectAllPages(app, headers, basePath, limit) {
  const joiner = basePath.includes("?") ? "&" : "?";
  const collected = [];
  const pages = [];
  let cursor = null;
  for (;;) {
    const url = `${basePath}${joiner}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.items.length, `page at cursor=${cursor}`).toBeLessThanOrEqual(limit);
    pages.push(body.items.map((row) => row.businessNo ?? row.id));
    collected.push(...body.items);
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
    expect(collected.length, "游标翻页不得超过 50 页（防死循环）").toBeLessThanOrEqual(50 * limit);
  }
  return { collected, pages, total: collected.length };
}

describe("admin list global ordering", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-admin-list-ordering-tests'))");
    await pool.query("TRUNCATE export_jobs,audit_logs,submission_question_scores,submission_versions,survey_attempts,object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,question_categories,brands,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-admin-list-ordering-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("门店列表按店号自然序全局排序且游标跨页不重不漏", async () => {
    const { app, headers, cityId, adminId } = await createWorld();
    // 乱序插入：字典序会把 S-10/S-11 排在 S-2 前；S-007 与 S-7 数值相等需店号文本兜底
    const businessNos = ["S-10", "S-9", "S-2", "S-007", "S-7", "S-11", "A-1", "B20", "B3"];
    for (const [index, businessNo] of businessNos.entries()) await insertStore(cityId, adminId, `自然序门店${index}`, businessNo);
    // 期望序与前端 store-cascade.compareBusinessNoNatural / SQL businessNoSortKey 同语义：
    // 数值段升序（2<7<9<10<11），S-007 与 S-7 键相同按店号文本（"0"<"7"）
    const expected = ["A-1", "B3", "B20", "S-2", "S-007", "S-7", "S-9", "S-10", "S-11"];
    const { collected, pages } = await collectAllPages(app, headers, "/api/admin/stores", 3);
    expect(collected.map((row) => row.businessNo)).toEqual(expected);
    // 三页切片：每页 3 条，页间边界处全局序保持（跨页不重不漏）
    expect(pages).toEqual([["A-1", "B3", "B20"], ["S-2", "S-007", "S-7"], ["S-9", "S-10", "S-11"]]);
    await app.close();
  });

  test("门店列表 order=desc 为自然序倒序且带品牌筛选的分页同样全局有序", async () => {
    const { app, headers, cityId, adminId } = await createWorld();
    const brandId = await insertBrand("自然序品牌");
    // 筛选组：页界恰好落在数值 2|7 与 9|10 之间，逐页拼接后必须仍是全局自然序
    for (const businessNo of ["BX-9", "BX-10", "BX-2", "BX-007", "BX-7", "BX-1"]) await insertStore(cityId, adminId, `品牌门店${businessNo}`, businessNo, brandId);
    // 组外噪声门店（不得进入品牌筛选结果）
    await insertStore(cityId, adminId, "他牌门店", "BX-0");
    const filtered = await collectAllPages(app, headers, `/api/admin/stores?brandId=${brandId}`, 2);
    expect(filtered.collected.map((row) => row.businessNo)).toEqual(["BX-1", "BX-2", "BX-007", "BX-7", "BX-9", "BX-10"]);
    expect(filtered.pages).toEqual([["BX-1", "BX-2"], ["BX-007", "BX-7"], ["BX-9", "BX-10"]]);
    // desc = 同一键的精确倒序（cursor 语义随方向翻转，跨页同样不重不漏）
    const all = await collectAllPages(app, headers, "/api/admin/stores?order=desc", 4);
    expect(all.collected.map((row) => row.businessNo)).toEqual(["BX-10", "BX-9", "BX-7", "BX-007", "BX-2", "BX-1", "BX-0"]);
    await app.close();
  });

  test("提交记录按实际 submitted_at 倒序（非 id/创建顺序）分页不重不漏", async () => {
    const { app, headers, cityId, adminId, inspectorId } = await createWorld();
    const versionId = await insertVersion(adminId, "排序题库");
    const { storeId } = await insertStore(cityId, adminId, "提交甲店", "SUB-A");
    // 创建（id/uuidv7）顺序与其提交时间刻意相反/交错：id 更大不等于提交更晚
    const earlyId = await insertSubmission({ storeId, versionId, userId: inspectorId, submittedAt: "2026-03-05T12:00:00+00:00", name: "最早提交的任务" }); // id 最小、提交最晚
    const midId = await insertSubmission({ storeId, versionId, userId: inspectorId, submittedAt: "2026-03-05T10:00:00+00:00", name: "最晚提交的任务" }); // id 次小、提交最早
    const lateId = await insertSubmission({ storeId, versionId, userId: inspectorId, submittedAt: "2026-03-05T11:00:00+00:00", name: "中间提交的任务" });
    const tieOne = await insertSubmission({ storeId, versionId, userId: inspectorId, submittedAt: "2026-03-05T10:30:00+00:00", name: "同刻提交甲" });
    const tieTwo = await insertSubmission({ storeId, versionId, userId: inspectorId, submittedAt: "2026-03-05T10:30:00+00:00", name: "同刻提交乙" });
    // 同刻并列以 id 定序（desc 取 id 更大者在前）
    const [tieFirst, tieSecond] = [tieOne, tieTwo].sort((a, b) => (a < b ? 1 : -1));
    const expectedDesc = [earlyId, lateId, tieFirst, tieSecond, midId]; // 12:00, 11:00, 10:30×2(id 降序), 10:00
    // id（uuidv7 创建）序的倒序与提交时间序不同：证明排序键是 submitted_at 而非 id
    const idDesc = [tieTwo, tieOne, lateId, midId, earlyId];
    expect(idDesc).not.toEqual(expectedDesc);

    const paged = await collectAllPages(app, headers, "/api/admin/submissions?order=desc", 2);
    expect(paged.collected.map((row) => row.id)).toEqual(expectedDesc);
    expect(paged.pages.length).toBe(3);
    // total 为全量计数且翻页期间保持
    const firstPage = await app.inject({ method: "GET", url: "/api/admin/submissions?order=desc&limit=2", headers });
    expect(firstPage.json().total).toBe(5);
    const withCursor = await app.inject({ method: "GET", url: `/api/admin/submissions?order=desc&limit=2&cursor=${encodeURIComponent(expectedDesc[1])}`, headers });
    expect(withCursor.json().total).toBe(5);
    expect(withCursor.json().items.map((row) => row.id)).toEqual(expectedDesc.slice(2, 4));
    await app.close();
  });

  test("提交记录默认 asc 按提交时间升序（空值最后）、筛选分页与 total 保持", async () => {
    const { app, headers, cityId, adminId, inspectorId } = await createWorld();
    const versionId = await insertVersion(adminId, "升序题库");
    const storeA = await insertStore(cityId, adminId, "升序甲店", "ASC-A");
    const storeB = await insertStore(cityId, adminId, "升序乙店", "ASC-B");
    const ascThird = await insertSubmission({ storeId: storeA.storeId, versionId, userId: inspectorId, submittedAt: "2026-04-05T12:00:00+00:00", name: "升序丙" });
    const ascFirst = await insertSubmission({ storeId: storeA.storeId, versionId, userId: inspectorId, submittedAt: "2026-04-05T08:00:00+00:00", name: "升序甲" });
    const ascSecond = await insertSubmission({ storeId: storeB.storeId, versionId, userId: inspectorId, submittedAt: "2026-04-05T10:00:00+00:00", name: "升序乙" });
    // 默认（无 order 参数）保持 asc 语义，但排序键为实际提交时间（最早在前）
    const asc = await collectAllPages(app, headers, "/api/admin/submissions", 2);
    expect(asc.collected.map((row) => row.id)).toEqual([ascFirst, ascSecond, ascThird]);
    // 文本筛选 + 游标分页：过滤先行、排序全局，total 为筛选后计数
    const filtered = await collectAllPages(app, headers, `/api/admin/submissions?storeName=${encodeURIComponent("升序甲店")}`, 1);
    expect(filtered.collected.map((row) => row.id)).toEqual([ascFirst, ascThird]);
    const filteredTotal = await app.inject({ method: "GET", url: `/api/admin/submissions?storeName=${encodeURIComponent("升序甲店")}&limit=1&order=desc`, headers });
    expect(filteredTotal.json().total).toBe(2);
    expect(filteredTotal.json().items.map((row) => row.id)).toEqual([ascThird]);
    await app.close();
  });
});

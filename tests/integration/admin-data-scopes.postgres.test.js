import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
const PASSWORD = "A-secure-pass";

async function seedUser(pool, { username, phone, role = "admin", scopeType = null, regionId = null, storeId = null }) {
  const passwordHash = await createPasswordService().hash(PASSWORD);
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const userId = uuidv7();
  const normalized = normalizePhone(phone);
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,$2,$3,$4,$5,$6,now(),$7,'approved_active')`,
    [userId, username, username.toLowerCase(), username, encrypt(encryptionKey, normalized), hmac(config.AUTH_TOKEN_HMAC_KEY, normalized), passwordHash]);
  const roleRow = await pool.query("SELECT id FROM roles WHERE code = $1", [role]);
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), userId, roleRow.rows[0].id]);
  if (scopeType) await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type,region_id,store_id) VALUES ($1,$2,$3,$4,$5)", [uuidv7(), userId, scopeType, regionId, storeId]);
  return { userId, username };
}

async function loginAdmin(app, username) {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username, password: PASSWORD } });
  expect(login.statusCode, login.body).toBe(200);
  return { cookie: login.headers["set-cookie"], "x-csrf-token": login.json().csrfToken };
}

// 世界观：省P→市C→区县D（门店A/C）、省P2→市C2→区县D2（门店B，范围外）；
// 三个管理员：AllAdmin(all)、RegionAdmin(省级P，三层覆盖区县D)、StoreAdmin(门店C)。
async function seedWorld() {
  const province = uuidv7(); const city = uuidv7(); const district = uuidv7();
  const otherProvince = uuidv7(); const otherCity = uuidv7(); const otherDistrict = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'范围省','110000',1)", [province]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'范围市','110100',$2,2)", [city, province]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'范围区','110106',$2,3)", [district, city]);
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'外省','990000',1)", [otherProvince]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'外市','990100',$2,2)", [otherCity, otherProvince]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'外区','990106',$2,3)", [otherDistrict, otherCity]);
  const brandId = uuidv7();
  await pool.query("INSERT INTO brands (id,name,active) VALUES ($1,'测试品牌',true)", [brandId]);
  const allAdmin = await seedUser(pool, { username: "AllAdmin", phone: "13600000001", scopeType: "all" });
  const regionAdmin = await seedUser(pool, { username: "RegionAdmin", phone: "13600000002", scopeType: "region", regionId: province });
  const storeAdmin = await seedUser(pool, { username: "StoreAdmin", phone: "13600000003", scopeType: "store", storeId: uuidv7() });
  const insertStore = async (id, businessNo, name, regionId) => pool.query(
    `INSERT INTO stores (id,business_no,name,brand_id,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by,active)
     VALUES ($1,$2,$3,$4,$5,'测试地址',31.2304,121.4737,'poi',now(),$6,true)`, [id, businessNo, name, brandId, regionId, allAdmin.userId]);
  const storeA = uuidv7(); const storeB = uuidv7(); const storeC = uuidv7();
  await insertStore(storeA, "S-A", "门店A", district);
  await insertStore(storeB, "S-B", "门店B", otherDistrict);
  await insertStore(storeC, "S-C", "门店C", district);
  // 门店C 的 id 已随种子生成，这里补挂 store 管理员的范围
  await pool.query("UPDATE user_data_scopes SET store_id=$2 WHERE user_id=$1 AND scope_type='store'", [storeAdmin.userId, storeC]);
  const inspector = await seedUser(pool, { username: "InspOne", phone: "13800000010", role: "inspector" });
  const templateId = uuidv7(); const versionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'范围题库','secret',$2)", [templateId, allAdmin.userId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, allAdmin.userId]);
  await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,sort_order) VALUES ($1,$2,'q1',1,'environment','环境是否整洁',2,1)", [uuidv7(), versionId]);
  return { province, city, district, otherDistrict, brandId, storeA, storeB, storeC, inspectorId: inspector.userId, allAdmin, regionAdmin, storeAdmin, versionId };
}

// 发布一份含单个指派的探店任务（复用 batch2 的发布前置：门店 active+已校准、暗访指派、问卷已发布）
async function seedPublishedCampaign(app, headers, world, name, storeId) {
  const versionStatus = await pool.query("SELECT status,revision FROM questionnaire_versions WHERE id=$1", [world.versionId]);
  if (versionStatus.rows[0].status === "draft") {
    const version = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${world.versionId}/publish`, headers: { ...headers.all, "idempotency-key": uuidv7() }, payload: { revision: Number(versionStatus.rows[0].revision) } });
    expect(version.statusCode, version.body).toBe(200);
  }
  const startsAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const dueAt = new Date(Date.now() + 70 * 60_000).toISOString();
  const created = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers.all, "idempotency-key": uuidv7() }, payload: { name, storeId, startsAt, dueAt, questionnaireDeadlineAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), commonInstruction: "范围测试" } });
  expect(created.statusCode, created.body).toBe(201);
  const campaignId = created.json().campaign.id;
  const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/assignments`, headers: { ...headers.all, "idempotency-key": uuidv7() }, payload: { inspectorId: world.inspectorId, questionnaireVersionId: world.versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: false, specialInstruction: "", campaignRevision: 0 } });
  expect(assignment.statusCode, assignment.body).toBe(201);
  const published = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/publish`, headers: { ...headers.all, "idempotency-key": uuidv7() }, payload: { revision: 1 } });
  expect(published.statusCode, published.body).toBe(200);
  const current = await pool.query("SELECT revision,due_at FROM audit_assignments WHERE id=$1", [assignment.json().id]);
  return { campaignId, assignmentId: assignment.json().id, assignmentRevision: Number(current.rows[0].revision), dueAt };
}

describe.sequential("admin data scopes", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-admin-data-scopes-tests'))");
    await pool.query("TRUNCATE audit_logs,object_reconciliation_runs,retention_runs,legal_holds,object_cleanup_jobs,question_answer_edit_session_removals,question_evidence_attachments,question_answer_edit_sessions,question_answers,survey_attempts,checkin_exemptions,audit_checkins,assignment_dish_requirements,audit_assignments,audit_campaigns,question_evidence_requirements,questions,questionnaire_versions,questionnaire_templates,question_categories,brands,stores,regions,auth_sessions,password_reset_tokens,phone_verification_challenges,rate_limit_buckets,inspector_registrations,user_roles,role_permissions,user_data_scopes,roles,permissions,users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
    await pool.query("INSERT INTO question_categories (id,code,name,sort_order) VALUES ($1,'environment','环境卫生',1),($2,'service','为客服务',2),($3,'product','产品品质',3)", [uuidv7(), uuidv7(), uuidv7()]);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-admin-data-scopes-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("region 管理员：门店与任务列表只含覆盖范围，范围内可建任务，范围外 403", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = { all: await loginAdmin(app, "AllAdmin"), region: await loginAdmin(app, "RegionAdmin") };
    await seedPublishedCampaign(app, headers, world, "范围任务A", world.storeA);
    await seedPublishedCampaign(app, headers, world, "范围外任务B", world.storeB);

    const stores = await app.inject({ method: "GET", url: "/api/admin/stores", headers: { cookie: headers.region.cookie } });
    expect(stores.statusCode).toBe(200);
    // uuidv7 低位纯随机：同毫秒生成的门店 id 顺序不定，断言两侧排序后比较
    expect(stores.json().items.map((item) => item.name).sort()).toEqual(["门店A", "门店C"]);

    const campaigns = await app.inject({ method: "GET", url: "/api/admin/campaigns", headers: { cookie: headers.region.cookie } });
    expect(campaigns.statusCode).toBe(200);
    expect(campaigns.json().items.map((item) => item.name)).toEqual(["范围任务A"]);

    const inScope = await seedPublishedCampaign(app, headers, world, "新建范围任务", world.storeC);
    expect(inScope.campaignId).toBeTruthy();

    const forgedCreate = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers.region, "idempotency-key": uuidv7() }, payload: { name: "伪造任务", storeId: world.storeB, startsAt: new Date(Date.now() + 60_000).toISOString(), dueAt: new Date(Date.now() + 3_600_000).toISOString(), questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "" } });
    expect(forgedCreate.statusCode).toBe(403);
    expect(forgedCreate.json().error.code).toBe("SCOPE_FORBIDDEN");
    await app.close();
  });

  test("region 管理员：范围外 campaign 详情与 assignment 操作 403，范围内操作成功", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = { all: await loginAdmin(app, "AllAdmin"), region: await loginAdmin(app, "RegionAdmin") };
    const inside = await seedPublishedCampaign(app, headers, world, "范围任务A", world.storeA);
    const outside = await seedPublishedCampaign(app, headers, world, "范围外任务B", world.storeB);

    const detail = await app.inject({ method: "GET", url: `/api/admin/campaigns/${outside.campaignId}`, headers: { cookie: headers.region.cookie } });
    expect(detail.statusCode).toBe(403);
    expect(detail.json().error.code).toBe("SCOPE_FORBIDDEN");

    const forgedExtend = await app.inject({ method: "POST", url: `/api/admin/assignments/${outside.assignmentId}/extend`, headers: { ...headers.region, "idempotency-key": uuidv7() }, payload: { revision: outside.assignmentRevision, dueAt: new Date(Date.now() + 30 * 60_000).toISOString(), reason: "伪造延期" } });
    expect(forgedExtend.statusCode).toBe(403);
    expect(forgedExtend.json().error.code).toBe("SCOPE_FORBIDDEN");

    const forgedCancel = await app.inject({ method: "POST", url: `/api/admin/assignments/${outside.assignmentId}/cancel`, headers: { ...headers.region, "idempotency-key": uuidv7() }, payload: { revision: outside.assignmentRevision, reason: "伪造取消" } });
    expect(forgedCancel.statusCode).toBe(403);

    const extended = await app.inject({ method: "POST", url: `/api/admin/assignments/${inside.assignmentId}/extend`, headers: { ...headers.region, "idempotency-key": uuidv7() }, payload: { revision: inside.assignmentRevision, dueAt: new Date(Date.now() + 30 * 60_000).toISOString(), reason: "范围内延期" } });
    expect(extended.statusCode, extended.body).toBe(200);

    const unchanged = await pool.query("SELECT due_at,last_extension_reason FROM audit_assignments WHERE id=$1", [outside.assignmentId]);
    expect(unchanged.rows[0].last_extension_reason).toBeNull();
    expect(new Date(unchanged.rows[0].due_at).toISOString()).toBe(outside.dueAt);
    await app.close();
  });

  test("store 管理员：门店列表仅范围门店，范围外 campaign 403，新建门店 403", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = { all: await loginAdmin(app, "AllAdmin"), store: await loginAdmin(app, "StoreAdmin") };
    const inside = await seedPublishedCampaign(app, headers, world, "门店C任务", world.storeC);
    const outsideA = await seedPublishedCampaign(app, headers, world, "门店A任务", world.storeA);

    const stores = await app.inject({ method: "GET", url: "/api/admin/stores", headers: { cookie: headers.store.cookie } });
    expect(stores.statusCode).toBe(200);
    expect(stores.json().items.map((item) => item.name)).toEqual(["门店C"]);

    const campaigns = await app.inject({ method: "GET", url: "/api/admin/campaigns", headers: { cookie: headers.store.cookie } });
    expect(campaigns.json().items.map((item) => item.name)).toEqual(["门店C任务"]);

    const outOfScopeA = await app.inject({ method: "GET", url: `/api/admin/campaigns/${outsideA.campaignId}`, headers: { cookie: headers.store.cookie } });
    expect(outOfScopeA.statusCode).toBe(403);
    expect(outOfScopeA.json().error.code).toBe("SCOPE_FORBIDDEN");

    const newStore = await app.inject({ method: "POST", url: "/api/admin/stores", headers: { ...headers.store, "idempotency-key": uuidv7() }, payload: { businessNo: "S-NEW", name: "越权新店", brandId: world.brandId, regionId: world.district, address: "新地址", latitudeGcj02: 31.23, longitudeGcj02: 121.47, coordinateSource: "manual_adjusted", radiusMeters: 300, accuracyAllowanceMaxMeters: 100, locationVerified: true, active: true } });
    expect(newStore.statusCode).toBe(403);
    expect(newStore.json().error.code).toBe("SCOPE_FORBIDDEN");
    await app.close();
  });

  test("all 管理员：全量可见可写（防过滤误伤 all 的回归）", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = { all: await loginAdmin(app, "AllAdmin") };
    await seedPublishedCampaign(app, headers, world, "范围任务A", world.storeA);
    await seedPublishedCampaign(app, headers, world, "范围外任务B", world.storeB);

    const stores = await app.inject({ method: "GET", url: "/api/admin/stores", headers: { cookie: headers.all.cookie } });
    expect(stores.json().items.map((item) => item.name).sort()).toEqual(["门店A", "门店B", "门店C"]);

    const campaigns = await app.inject({ method: "GET", url: "/api/admin/campaigns", headers: { cookie: headers.all.cookie } });
    expect(campaigns.json().items.map((item) => item.name).sort()).toEqual(["范围任务A", "范围外任务B"]);

    const created = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers.all, "idempotency-key": uuidv7() }, payload: { name: "全量任务", storeId: world.storeB, startsAt: new Date(Date.now() + 60_000).toISOString(), dueAt: new Date(Date.now() + 3_600_000).toISOString(), questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "" } });
    expect(created.statusCode, created.body).toBe(201);
    await app.close();
  });

  test("伪造绕过：region 管理员直接对范围外资源操作仍 403", async () => {
    const world = await seedWorld();
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = { all: await loginAdmin(app, "AllAdmin"), region: await loginAdmin(app, "RegionAdmin") };
    const outside = await seedPublishedCampaign(app, headers, world, "范围外任务B", world.storeB);

    const directCreate = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { ...headers.region, "idempotency-key": uuidv7() }, payload: { name: "直连伪造", storeId: world.storeB, startsAt: new Date(Date.now() + 60_000).toISOString(), dueAt: new Date(Date.now() + 3_600_000).toISOString(), questionnaireDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(), commonInstruction: "" } });
    expect(directCreate.statusCode).toBe(403);
    expect(directCreate.json().error.code).toBe("SCOPE_FORBIDDEN");

    const extendBypass = await app.inject({ method: "POST", url: `/api/admin/assignments/${outside.assignmentId}/extend`, headers: { ...headers.region, "idempotency-key": uuidv7() }, payload: { revision: outside.assignmentRevision, dueAt: new Date(Date.now() + 30 * 60_000).toISOString(), reason: "带正确 revision 的伪造延期" } });
    expect(extendBypass.statusCode).toBe(403);
    expect(extendBypass.json().error.code).toBe("SCOPE_FORBIDDEN");
    await app.close();
  });
});

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

async function seedAdmin(pool, { username = "AdminOne", phone = "13600000000" } = {}) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,$2,$3,'测试管理员',$4,$5,now(),$6,'approved_active')`,
    [adminId, username, username.toLowerCase(), encrypt(encryptionKey, normalizePhone(phone)), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone(phone)), passwordHash]);
  const role = await pool.query("SELECT id FROM roles WHERE code = 'admin'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, role.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  return { adminId, passwordHash, username, password: "A-secure-pass" };
}

async function seedInspector(pool, { username = "InspectorOne", phone = "13900000000" } = {}) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const inspectorId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,$2,$3,'测试探员',$4,$5,now(),$6,'approved_active')`,
    [inspectorId, username, username.toLowerCase(), encrypt(encryptionKey, normalizePhone(phone)), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone(phone)), passwordHash]);
  const role = await pool.query("SELECT id FROM roles WHERE code = 'inspector'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspectorId, role.rows[0].id]);
  return { inspectorId, username, password: "A-secure-pass" };
}

async function seedRegion(pool) {
  const provinceId = uuidv7();
  const districtId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'测试省','530000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,level,parent_id) VALUES ($1,'测试区','530102',3,$2)", [districtId, provinceId]);
  return { provinceId, districtId };
}

async function seedStore(pool, regionId) {
  const id = uuidv7();
  await pool.query(`INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,checkin_radius_meters,accuracy_allowance_max_meters,active)
    VALUES ($1,'S-001','测试门店',$2,'测试地址',25.03,102.71,'poi',300,200,true)`, [id, regionId]);
  const revision = (await pool.query("SELECT revision FROM stores WHERE id=$1", [id])).rows[0].revision;
  return { id, revision: Number(revision) };
}

async function seedTemplateAndVersion(pool, adminId) {
  const templateId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'测试模板','secret',$2)", [templateId, adminId]);
  const versionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, adminId]);
  const revision = (await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [versionId])).rows[0].revision;
  return { templateId, versionId, revision: Number(revision) };
}

async function seedCampaign(pool, adminId, storeId, { status = "draft", revisionOverride } = {}) {
  const id = uuidv7();
  await pool.query(`INSERT INTO audit_campaigns (id,business_no,name,store_id,starts_at,due_at,status,created_by)
    VALUES ($1,'C-001','测试任务',$2,now() + interval '1 day',now() + interval '2 days',$3,$4)`, [id, storeId, status, adminId]);
  if (revisionOverride !== undefined) await pool.query("UPDATE audit_campaigns SET revision=$2 WHERE id=$1", [id, revisionOverride]);
  const revision = (await pool.query("SELECT revision FROM audit_campaigns WHERE id=$1", [id])).rows[0].revision;
  return { id, revision: Number(revision) };
}

async function seedAssignment(pool, adminId, campaignId, inspectorId, versionId) {
  const id = uuidv7();
  await pool.query(`INSERT INTO audit_assignments (id,business_no,campaign_id,inspector_id,questionnaire_version_id,task_type,starts_at,due_at,budget_limit_cents,status,created_by)
    VALUES ($1,'A-001',$2,$3,$4,'secret',now() + interval '1 day',now() + interval '2 days',0,'draft',$5)`, [id, campaignId, inspectorId, versionId, adminId]);
  await pool.query("INSERT INTO assignment_dish_requirements (id,assignment_id,planned_name,quantity,required,allow_substitution,sort_order) VALUES ($1,$2,'招牌菜',1,true,false,1)", [uuidv7(), id]);
  const revision = (await pool.query("SELECT revision FROM audit_assignments WHERE id=$1", [id])).rows[0].revision;
  return { id, revision: Number(revision) };
}

async function adminHeaders(app, username = "AdminOne") {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username, password: "A-secure-pass" } });
  expect(login.statusCode).toBe(200);
  return { cookie: login.headers["set-cookie"], csrf: login.json().csrfToken };
}

const del = (app, url, { cookie, csrf }, body) => app.inject({ method: "DELETE", url, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: body });


describe.sequential("entity deletion (guarded, zero-error) and login access", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-delete-entities-integration-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, assignment_dish_requirements, audit_assignments, audit_campaigns, brands, stores, questions, question_evidence_requirements, questionnaire_versions, questionnaire_templates, regions RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-delete-entities-integration-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("deletes an unreferenced store", async () => {
    const admin = await seedAdmin(pool);
    const region = await seedRegion(pool);
    const store = await seedStore(pool, region.districtId);
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await adminHeaders(app);
    const response = await del(app, `/api/admin/stores/${store.id}`, headers, { revision: store.revision });
    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toBe(true);
    const remaining = await pool.query("SELECT 1 FROM stores WHERE id=$1", [store.id]);
    expect(remaining.rowCount).toBe(0);
    await app.close();
  });

  test("refuses to delete a store referenced by a campaign with a readable message", async () => {
    const admin = await seedAdmin(pool);
    const region = await seedRegion(pool);
    const store = await seedStore(pool, region.districtId);
    await seedCampaign(pool, admin.adminId, store.id);
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await adminHeaders(app);
    const response = await del(app, `/api/admin/stores/${store.id}`, headers, { revision: store.revision });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("已被探店任务引用");
    const remaining = await pool.query("SELECT 1 FROM stores WHERE id=$1", [store.id]);
    expect(remaining.rowCount).toBe(1);
    await app.close();
  });

  test("store delete: revision mismatch and missing store", async () => {
    const admin = await seedAdmin(pool);
    const region = await seedRegion(pool);
    const store = await seedStore(pool, region.districtId);
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await adminHeaders(app);
    const conflict = await del(app, `/api/admin/stores/${store.id}`, headers, { revision: store.revision + 1 });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.message).toBe("内容已更新，请刷新后重试");
    const missing = await del(app, `/api/admin/stores/${uuidv7()}`, headers, { revision: 0 });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  test("deletes a draft questionnaire version; rejects published and referenced ones", async () => {
    const admin = await seedAdmin(pool);
    const { versionId, revision } = await seedTemplateAndVersion(pool, admin.adminId);
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await adminHeaders(app);
    const ok = await del(app, `/api/admin/questionnaire-versions/${versionId}`, headers, { revision });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().deleted).toBe(true);
    const gone = await pool.query("SELECT 1 FROM questionnaire_versions WHERE id=$1", [versionId]);
    expect(gone.rowCount).toBe(0);
    // published 版本拒绝
    const second = await seedTemplateAndVersion(pool, admin.adminId);
    await pool.query("UPDATE questionnaire_versions SET status='published',published_at=now(),published_by=$2 WHERE id=$1", [second.versionId, admin.adminId]);
    const published = await del(app, `/api/admin/questionnaire-versions/${second.versionId}`, headers, { revision: 0 });
    expect(published.statusCode).toBe(409);
    expect(published.json().error.message).toContain("已发布版本不能删除");
    // 被分配引用的草稿版本拒绝
    const third = await seedTemplateAndVersion(pool, admin.adminId);
    const inspector = await seedInspector(pool);
    const region = await seedRegion(pool);
    const store = await seedStore(pool, region.districtId);
    const campaign = await seedCampaign(pool, admin.adminId, store.id);
    await seedAssignment(pool, admin.adminId, campaign.id, inspector.inspectorId, third.versionId);
    const referenced = await del(app, `/api/admin/questionnaire-versions/${third.versionId}`, headers, { revision: third.revision });
    expect(referenced.statusCode).toBe(409);
    expect(referenced.json().error.message).toContain("已被指派使用");
    await app.close();
  });

  test("deletes a draft campaign and cascades its draft assignments", async () => {
    const admin = await seedAdmin(pool);
    const inspector = await seedInspector(pool);
    const region = await seedRegion(pool);
    const store = await seedStore(pool, region.districtId);
    const campaign = await seedCampaign(pool, admin.adminId, store.id);
    const { versionId } = await seedTemplateAndVersion(pool, admin.adminId);
    const assignment = await seedAssignment(pool, admin.adminId, campaign.id, inspector.inspectorId, versionId);
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await adminHeaders(app);
    const response = await del(app, `/api/admin/campaigns/${campaign.id}`, headers, { revision: campaign.revision });
    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toBe(true);
    const campaignGone = await pool.query("SELECT 1 FROM audit_campaigns WHERE id=$1", [campaign.id]);
    const assignmentGone = await pool.query("SELECT 1 FROM audit_assignments WHERE id=$1", [assignment.id]);
    const dishGone = await pool.query("SELECT 1 FROM assignment_dish_requirements WHERE assignment_id=$1", [assignment.id]);
    expect(campaignGone.rowCount).toBe(0);
    expect(assignmentGone.rowCount).toBe(0);
    expect(dishGone.rowCount).toBe(0);
    await app.close();
  });

  test("refuses to delete a published campaign", async () => {
    const admin = await seedAdmin(pool);
    const region = await seedRegion(pool);
    const store = await seedStore(pool, region.districtId);
    const campaign = await seedCampaign(pool, admin.adminId, store.id, { status: "published" });
    await pool.query("UPDATE audit_campaigns SET published_at=now(),published_by=$2 WHERE id=$1", [campaign.id, admin.adminId]);
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await adminHeaders(app);
    const response = await del(app, `/api/admin/campaigns/${campaign.id}`, headers, { revision: campaign.revision });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("不能删除");
    const remaining = await pool.query("SELECT 1 FROM audit_campaigns WHERE id=$1", [campaign.id]);
    expect(remaining.rowCount).toBe(1);
    await app.close();
  });

  test("deletes an unreferenced inspector including roles and scopes", async () => {
    const admin = await seedAdmin(pool);
    const inspector = await seedInspector(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await adminHeaders(app);
    const response = await del(app, `/api/admin/users/${inspector.inspectorId}`, headers, { revision: 0 });
    expect(response.statusCode).toBe(200);
    const userGone = await pool.query("SELECT 1 FROM users WHERE id=$1", [inspector.inspectorId]);
    const roleGone = await pool.query("SELECT 1 FROM user_roles WHERE user_id=$1", [inspector.inspectorId]);
    expect(userGone.rowCount).toBe(0);
    expect(roleGone.rowCount).toBe(0);
    await app.close();
  });

  test("refuses to delete an inspector referenced by an assignment", async () => {
    const admin = await seedAdmin(pool);
    const inspector = await seedInspector(pool);
    const region = await seedRegion(pool);
    const store = await seedStore(pool, region.districtId);
    const campaign = await seedCampaign(pool, admin.adminId, store.id);
    const { versionId } = await seedTemplateAndVersion(pool, admin.adminId);
    await seedAssignment(pool, admin.adminId, campaign.id, inspector.inspectorId, versionId);
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await adminHeaders(app);
    const response = await del(app, `/api/admin/users/${inspector.inspectorId}`, headers, { revision: 0 });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("已参与业务数据");
    const remaining = await pool.query("SELECT 1 FROM users WHERE id=$1", [inspector.inspectorId]);
    expect(remaining.rowCount).toBe(1);
    await app.close();
  });

  test("cannot delete your own account", async () => {
    const admin = await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const headers = await adminHeaders(app);
    const response = await del(app, `/api/admin/users/${admin.adminId}`, headers, { revision: 0 });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toBe("不能删除自己的账号");
    await app.close();
  });

  test("deleting an admin reassigns business attribution to the operator instead of blocking", async () => {
    // 业务记录属于组织：创建过门店/任务/问卷的管理员可以被删除，归属字段移交给执行删除的操作者
    const creator = await seedAdmin(pool, { username: "Creator", phone: "13600000011" });
    const operator = await seedAdmin(pool, { username: "Operator", phone: "13600000012" });
    const region = await seedRegion(pool);
    const store = await seedStore(pool, region.districtId);
    await pool.query("UPDATE stores SET location_verified_by=$2 WHERE id=$1", [store.id, creator.adminId]);
    const campaign = await seedCampaign(pool, creator.adminId, store.id);
    await seedTemplateAndVersion(pool, creator.adminId);
    const app = buildApp({ config, pool, logger: false, providers });
    const operatorLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "Operator", password: "A-secure-pass" } });
    expect(operatorLogin.statusCode).toBe(200);
    const opHeaders = { cookie: operatorLogin.headers["set-cookie"], csrf: operatorLogin.json().csrfToken };
    await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "Creator", password: "A-secure-pass" } });
    const creatorRevision = (await pool.query("SELECT session_version revision FROM users WHERE id=$1", [creator.adminId])).rows[0].revision;
    const response = await del(app, `/api/admin/users/${creator.adminId}`, opHeaders, { revision: Number(creatorRevision) });
    expect(response.statusCode, response.body).toBe(200);
    const attribution = await pool.query(`SELECT (SELECT count(*)::int FROM stores WHERE location_verified_by=$1) store_taken,
      (SELECT count(*)::int FROM audit_campaigns WHERE created_by=$1) campaign_taken,
      (SELECT count(*)::int FROM users WHERE id=$2) creator_gone`, [operator.adminId, creator.adminId]);
    expect(attribution.rows[0]).toMatchObject({ store_taken: 1, campaign_taken: 1, creator_gone: 0 });
    // 历史审计保留：操作人姓名快照仍在，actor_id 已置空
    const audits = await pool.query("SELECT actor_name, actor_id FROM audit_logs WHERE actor_name = '测试管理员' AND subject_id = $1", [creator.adminId]);
    expect(audits.rows.length).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  test("探店员账号登录后台被明确拒绝", async () => {
    await seedAdmin(pool);
    await seedInspector(pool, { username: "InspOne", phone: "13900000001" });
    const app = buildApp({ config, pool, logger: false, providers });
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "InspOne", password: "A-secure-pass" } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.message).toContain("没有后台管理权限");
    await app.close();
  });

  test("管理员账号可以登录小程序端", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "AdminOne", password: "A-secure-pass" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().accessToken).toBeTruthy();
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${login.json().accessToken}` } });
    expect(me.statusCode).toBe(200);
    await app.close();
  });

  test("管理员登录后台仍然正常", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "AdminOne", password: "A-secure-pass" } });
    expect(login.statusCode).toBe(200);
    await app.close();
  });
});

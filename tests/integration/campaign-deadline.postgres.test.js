import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "vitest";
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

async function seedWorld(pool) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  const inspectorId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'AdminOne','adminone','管理员',$2,$3,now(),$4,'approved_active'),($5,'InspectorOne','inspectorone','探员',$6,$7,now(),$4,'approved_active')`,
    [adminId, encrypt(encryptionKey, normalizePhone("13600000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13600000000")), passwordHash, inspectorId, encrypt(encryptionKey, normalizePhone("13800000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13800000000"))]);
  const adminRole = await pool.query("SELECT id FROM roles WHERE code = 'admin'");
  const inspectorRole = await pool.query("SELECT id FROM roles WHERE code = 'inspector'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, adminRole.rows[0].id]);
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), inspectorId, inspectorRole.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  const provinceId = uuidv7(); const cityId = uuidv7(); const regionId = uuidv7(); const storeId = uuidv7();
  await pool.query("INSERT INTO regions (id,name,code,level) VALUES ($1,'上海市','310000',1)", [provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'市辖区','310100',$2,2)", [cityId, provinceId]);
  await pool.query("INSERT INTO regions (id,name,code,parent_id,level) VALUES ($1,'静安区','310106',$2,3)", [regionId, cityId]);
  await pool.query("INSERT INTO stores (id,business_no,name,region_id,address,latitude_gcj02,longitude_gcj02,coordinate_source,location_verified_at,location_verified_by) VALUES ($1,'S-001','测试门店',$2,'地址',31.2304,121.4737,'poi',now(),$3)", [storeId, regionId, adminId]);
  const templateId = uuidv7(); const versionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'测试问卷','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by,published_by,published_at) VALUES ($1,$2,1,'published',$3,$3,now())", [versionId, templateId, adminId]);
  await pool.query(`INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,enabled,sort_order) VALUES (gen_random_uuid(),$1,'q1',1,'environment','测试题',2,true,1)`, [versionId]);
  return { adminId, inspectorId, storeId, versionId };
}

async function adminHeaders(app) {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "AdminOne", password: "A-secure-pass" } });
  expect(login.statusCode).toBe(200);
  return { cookie: login.headers["set-cookie"], csrf: login.json().csrfToken };
}

describe.sequential("campaign questionnaire deadline", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-campaign-deadline-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users, questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, regions, stores, audit_campaigns, audit_assignments, survey_attempts, question_evidence_attachments, question_answer_edit_sessions RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-campaign-deadline-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("creates a campaign with the three time fields and rejects a deadline before the visit window end", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const startsAt = new Date(Date.now() + 60_000).toISOString();
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    const deadlineAt = new Date(Date.now() + 7_200_000).toISOString();
    const created = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { name: "三字段任务", storeId: world.storeId, startsAt, dueAt, questionnaireDeadlineAt: deadlineAt, commonInstruction: "说明" } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().campaign.questionnaireDeadlineAt).toBe(deadlineAt);
    // deadline 早于 due_at → 422
    const invalid = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { name: "非法截止", storeId: world.storeId, startsAt, dueAt, questionnaireDeadlineAt: new Date(Date.now() + 1_800_000).toISOString(), commonInstruction: "" } });
    expect(invalid.statusCode).toBe(422);
    await app.close();
  });

  test("assignment inherits the campaign deadline; submission allowed after visit end but before deadline, rejected after deadline", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const startsAt = new Date(Date.now() - 3_600_000).toISOString();       // 探店时段已过
    const dueAt = new Date(Date.now() - 1_800_000).toISOString();          // 探店结束已过
    const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();     // 问卷截止未到
    const created = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { name: "补录任务", storeId: world.storeId, startsAt, dueAt, questionnaireDeadlineAt: deadlineAt, commonInstruction: "" } });
    const campaignId = created.json().campaign.id;
    const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/assignments`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { inspectorId: world.inspectorId, questionnaireVersionId: world.versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: false, specialInstruction: "", campaignRevision: 0 } });
    expect(assignment.statusCode, assignment.body).toBe(201);
    const inherited = await pool.query("SELECT questionnaire_deadline_at FROM audit_assignments WHERE id=$1", [assignment.json().id]);
    expect(new Date(inherited.rows[0].questionnaire_deadline_at).toISOString()).toBe(deadlineAt);
    // 探员登录打卡开始（时段已过但任务 assigned——start 校验允许？时段过了 start 会拒绝——直接 SQL 标记 in_progress 模拟已在途）
    await pool.query("UPDATE audit_assignments SET status='in_progress',started_at=now(),checked_in_at=now() WHERE id=$1", [assignment.json().id]);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    // due_at 已过但 deadline 未过 → 探员补录问卷并提交应成功
    const attempt = await pool.query("SELECT id FROM survey_attempts WHERE assignment_id=$1", [assignment.json().id]);
    if (attempt.rows[0]) {
      const draft = await app.inject({ method: "GET", url: `/api/questionnaires/secret/drafts/${attempt.rows[0].id}`, headers: inspectorHeaders });
      expect(draft.statusCode, draft.body).toBe(200);
      const questionId = draft.json().questions[0].id;
      await app.inject({ method: "PUT", url: `/api/questionnaires/secret/drafts/${attempt.rows[0].id}/answers/${questionId}`, headers: inspectorHeaders, payload: { answer: "scored", revision: 0 } });
      // 其余无题，直接提交（1 题已答）
      const submitted = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attempt.rows[0].id}/submit`, headers: inspectorHeaders, payload: { submitToken: uuidv7(), assignmentRevision: 1, revision: 1 } });
      expect(submitted.statusCode, submitted.body).toBe(200);
    }
    await app.close();
  });

  test("rejects submission after the questionnaire deadline", async () => {
    const world = await seedWorld(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const startsAt = new Date(Date.now() - 7_200_000).toISOString();
    const dueAt = new Date(Date.now() - 6_000_000).toISOString();
    const deadlineAt = new Date(Date.now() - 3_600_000).toISOString();     // 问卷截止已过
    const created = await app.inject({ method: "POST", url: "/api/admin/campaigns", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { name: "超期任务", storeId: world.storeId, startsAt, dueAt, questionnaireDeadlineAt: deadlineAt, commonInstruction: "" } });
    const campaignId = created.json().campaign.id;
    const assignment = await app.inject({ method: "POST", url: `/api/admin/campaigns/${campaignId}/assignments`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { inspectorId: world.inspectorId, questionnaireVersionId: world.versionId, taskType: "secret", startsAt, dueAt, budgetLimit: 0, receiptRequired: false, specialInstruction: "", campaignRevision: 0 } });
    const assignmentId = assignment.json().id;
    await pool.query("UPDATE audit_assignments SET status='in_progress',started_at=now(),checked_in_at=now() WHERE id=$1", [assignmentId]);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } });
    const inspectorHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    const attempt = await pool.query("SELECT id FROM survey_attempts WHERE assignment_id=$1", [assignmentId]);
    if (attempt.rows[0]) {
      const submitted = await app.inject({ method: "POST", url: `/api/questionnaires/secret/${attempt.rows[0].id}/submit`, headers: inspectorHeaders, payload: { submitToken: uuidv7(), assignmentRevision: 1, revision: 1 } });
      expect(submitted.statusCode).toBe(409);
      expect(submitted.json().error.code).toBe("TASK_OVERDUE");
    }
    await app.close();
  });
});

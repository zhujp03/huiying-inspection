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

async function seedAdmin(pool) {
  const passwords = createPasswordService();
  const passwordHash = await passwords.hash("A-secure-pass");
  const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
  const adminId = uuidv7();
  await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
    VALUES ($1,'AdminOne','adminone','测试管理员',$2,$3,now(),$4,'approved_active')`,
    [adminId, encrypt(encryptionKey, normalizePhone("13600000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13600000000")), passwordHash]);
  const role = await pool.query("SELECT id FROM roles WHERE code = 'admin'");
  await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, role.rows[0].id]);
  await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
  return { adminId, username: "AdminOne", password: "A-secure-pass" };
}

async function adminHeaders(app) {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "AdminOne", password: "A-secure-pass" } });
  expect(login.statusCode).toBe(200);
  return { cookie: login.headers["set-cookie"], csrf: login.json().csrfToken };
}

const fullQuestions = () => Array.from({ length: 50 }, (_, index) => ({ number: index + 1, category: index < 20 ? "environment" : index < 42 ? "service" : "product", text: `第 ${index + 1} 题检查内容`, maxScore: 2 }));

describe.sequential("questionnaire creation", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-questionnaire-create-tests'))");
    await pool.query("TRUNCATE questionnaire_templates, questionnaire_versions, questions, question_evidence_requirements, auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-questionnaire-create-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("creates a questionnaire draft with questions", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const created = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { name: "暗访问卷", questions: fullQuestions() } });
    expect(created.statusCode).toBe(201);
    const versionId = created.json().version.id;
    const questions = await pool.query("SELECT question_number,category,text FROM questions WHERE version_id=$1 ORDER BY question_number", [versionId]);
    expect(questions.rows.length).toBe(50);
    expect(questions.rows[0]).toMatchObject({ question_number: 1, category: "environment" });
    const versions = await pool.query("SELECT status,version_number FROM questionnaire_versions WHERE id=$1", [versionId]);
    expect(versions.rows[0]).toMatchObject({ status: "draft", version_number: 1 });
    await app.close();
  });

  test("rejects duplicate question numbers", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const created = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { name: "重复题号", questions: [{ number: 1, category: "environment", text: "题A" }, { number: 1, category: "service", text: "题B" }] } });
    expect(created.statusCode).toBe(422);
    await app.close();
  });

  test("edits question text and score on a draft, then freezes after publish", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const created = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { name: "可编辑问卷", questions: fullQuestions() } });
    const versionId = created.json().version.id;
    const question = await pool.query("SELECT id,revision FROM questions WHERE version_id=$1 AND question_number=1", [versionId]);
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/questionnaire-versions/${versionId}/questions/${question.rows[0].id}`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { revision: Number(question.rows[0].revision), text: "改过的题目", maxScore: 3 } });
    expect(patched.statusCode).toBe(200);
    const updated = await pool.query("SELECT text,max_score FROM questions WHERE id=$1", [question.rows[0].id]);
    expect(updated.rows[0]).toMatchObject({ text: "改过的题目", max_score: 3 });
    // 发布
    const versionRow = await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [versionId]);
    const published = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { revision: Number(versionRow.rows[0].revision) } });
    expect(published.statusCode).toBe(200);
    // 发布后不能再改
    const frozen = await app.inject({ method: "PATCH", url: `/api/admin/questionnaire-versions/${versionId}/questions/${question.rows[0].id}`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { revision: 1, text: "禁止修改" } });
    expect(frozen.statusCode).toBe(409);
    await app.close();
  });

  test("publishes questionnaires with fewer than 50 questions", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    // 3 题版本可直接发布（不再要求恰好 50 题）
    const created = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { name: "三题问卷", questions: [{ number: 1, category: "environment", text: "第一题" }, { number: 2, category: "service", text: "第二题" }, { number: 3, category: "product", text: "第三题" }] } });
    const versionId = created.json().version.id;
    const versionRow = await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [versionId]);
    const published = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${versionId}/publish`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { revision: Number(versionRow.rows[0].revision) } });
    expect(published.statusCode, published.body).toBe(200);
    // 非连续题号（跳号）仍拒绝
    const skipped = await app.inject({ method: "POST", url: "/api/admin/questionnaire-versions", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { name: "跳号问卷", questions: [{ number: 1, category: "environment", text: "第一题" }, { number: 3, category: "service", text: "第三题" }] } });
    const skippedVersionId = skipped.json().version.id;
    const skippedRow = await pool.query("SELECT revision FROM questionnaire_versions WHERE id=$1", [skippedVersionId]);
    const skippedPublish = await app.inject({ method: "POST", url: `/api/admin/questionnaire-versions/${skippedVersionId}/publish`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { revision: Number(skippedRow.rows[0].revision) } });
    expect(skippedPublish.statusCode).toBe(422);
    await app.close();
  });
});

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

async function adminHeaders(app, username = "AdminOne") {
  const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username, password: "A-secure-pass" } });
  expect(login.statusCode).toBe(200);
  return { cookie: login.headers["set-cookie"], csrf: login.json().csrfToken };
}

describe.sequential("user management", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-user-mgmt-integration-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-user-mgmt-integration-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("creates an inspector that can log in immediately (no approval needed)", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { kind: "inspector", username: "NewInspector", displayName: "新探员", phone: "13900000000", password: "weak-pass-123" } });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "NewInspector", password: "weak-pass-123" } });
    expect(login.statusCode).toBe(200);
    const user = await pool.query("SELECT status FROM users WHERE username_normalized = 'newinspector'");
    expect(user.rows[0].status).toBe("approved_active");
    await app.close();
  });

  test("creates an admin that can log in and manage users", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { kind: "admin", username: "SecondAdmin", displayName: "二号管理员", phone: "13700000000", password: "another-pass" } });
    expect(created.statusCode).toBe(201);
    const secondLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "SecondAdmin", password: "another-pass" } });
    expect(secondLogin.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/admin/users?kind=admin", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBe(2);
    expect(list.json().items).toEqual([expect.objectContaining({ roleCode: "admin", scopeLabel: "全部" }), expect.objectContaining({ roleCode: "admin", scopeLabel: "全部" })]);
    await app.close();
  });

  test("rejects duplicate username or phone with 409", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const first = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { kind: "inspector", username: "DupUser", displayName: "重复用户", phone: "13911111111", password: "weak-pass-1" } });
    expect(first.statusCode).toBe(201);
    const dupUsername = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { kind: "inspector", username: "DupUser", displayName: "重复用户2", phone: "13922222222", password: "weak-pass-2" } });
    expect(dupUsername.statusCode).toBe(409);
    const dupPhone = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { kind: "inspector", username: "AnotherUser", displayName: "重复手机", phone: "13911111111", password: "weak-pass-3" } });
    expect(dupPhone.statusCode).toBe(409);
    await app.close();
  });

  test("resets a password and invalidates the old session", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { kind: "inspector", username: "ResetTarget", displayName: "重置目标", phone: "13933333333", password: "old-pass-123" } });
    const targetId = created.json().user.id;
    const beforeLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ResetTarget", password: "old-pass-123" } });
    const oldToken = beforeLogin.json().accessToken;
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/users/${targetId}`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { password: "new-pass-456" } });
    expect(patched.statusCode).toBe(200);
    const oldSession = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${oldToken}` } });
    expect(oldSession.statusCode).toBe(401);
    const newLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ResetTarget", password: "new-pass-456" } });
    expect(newLogin.statusCode).toBe(200);
    await app.close();
  });

  test("disabling a user revokes sessions; the actor cannot disable themselves", async () => {
    const { adminId } = await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const selfDisable = await app.inject({ method: "PATCH", url: `/api/admin/users/${adminId}`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { status: "disabled" } });
    expect(selfDisable.statusCode).toBe(422);
    const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { kind: "inspector", username: "DisableTarget", displayName: "停用目标", phone: "13944444444", password: "weak-pass-4" } });
    const targetId = created.json().user.id;
    const beforeLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "DisableTarget", password: "weak-pass-4" } });
    const token = beforeLogin.json().accessToken;
    const disabled = await app.inject({ method: "PATCH", url: `/api/admin/users/${targetId}`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { status: "disabled" } });
    expect(disabled.statusCode).toBe(200);
    const session = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(session.statusCode).toBe(401);
    await app.close();
  });

  test("cannot demote the last remaining admin", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const admins = await app.inject({ method: "GET", url: "/api/admin/users?kind=admin", headers: { cookie } });
    expect(admins.json().items.length).toBe(1);
    const onlyAdmin = admins.json().items[0];
    const demote = await app.inject({ method: "PATCH", url: `/api/admin/users/${onlyAdmin.id}`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { kind: "inspector" } });
    expect(demote.statusCode).toBe(422);
    await app.close();
  });

  test("writes audit logs for account operations", async () => {
    await seedAdmin(pool);
    const app = buildApp({ config, pool, logger: false, providers });
    const { cookie, csrf } = await adminHeaders(app);
    const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { kind: "inspector", username: "AuditTarget", displayName: "审计目标", phone: "13955555555", password: "weak-pass-5" } });
    const targetId = created.json().user.id;
    await app.inject({ method: "PATCH", url: `/api/admin/users/${targetId}`, headers: { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7() }, payload: { password: "changed-pass-1" } });
    const logs = await pool.query("SELECT action,subject_type,data_json FROM audit_logs ORDER BY created_at");
    // admin_login：登录成功现在也会写审计（管理员登录后台）
    expect(logs.rows.map((row) => row.action)).toEqual(["admin_login", "user_created", "user_updated"]);
    expect(logs.rows[1].data_json.kind).toBe("inspector");
    await app.close();
  });
});

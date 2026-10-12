import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { encrypt, hmac, normalizePhone } from "../../apps/api/src/auth/crypto.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";

import { assertIntegrationTestDatabase } from "../helpers/test-database-guard.mjs";

// 集成测试会清空业务表：误指向开发库时立即失败而不是清空数据。
assertIntegrationTestDatabase();

const connectionString = process.env.DATABASE_URL;
const test = connectionString ? it : it.skip;
const pool = connectionString ? new pg.Pool({ connectionString, max: 10 }) : null;
let databaseLock = null;
const config = {
  NODE_ENV: "test", API_REQUEST_TIMEOUT_MS: 12000, AUTH_HASH_MAX_CONCURRENCY: 2, AUTH_HASH_MAX_QUEUE: 8,
  AUTH_TOKEN_HMAC_KEY: "auth-test-key-auth-test-key-auth-test-key", PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
};

describe.sequential("PostgreSQL authentication", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-postgres-integration-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-postgres-integration-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("registers through a sent challenge, then creates and revokes an inspector bearer session", async () => {
    let sentCode;
    const app = buildApp({ config, pool, logger: false, providers: { verifyCaptcha: async () => ({ requestId: "tencent-req-abc123", captchaCode: 1 }), sendSms: async ({ code }) => { sentCode = code; return { messageId: "test-message" }; } } });
    const phoneCode = await app.inject({ method: "POST", url: "/api/auth/register/phone-code", payload: { phone: "13800000000", captchaTicket: "test-ticket", captchaRandstr: "test-randstr", deviceFingerprint: "device-fingerprint" } });
    expect(phoneCode.statusCode, phoneCode.body).toBe(200);
    const challenge = phoneCode.json();
    expect(challenge.phoneChallengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sentCode).toMatch(/^\d{6}$/);
    // 数据库只保存腾讯 RequestId，绝不保存完整 ticket。
    const stored = await pool.query("SELECT captcha_verification_id FROM phone_verification_challenges WHERE id = $1", [challenge.phoneChallengeId]);
    expect(stored.rows[0].captcha_verification_id).toBe("tencent-req-abc123");
    expect(stored.rows[0].captcha_verification_id).not.toBe("test-ticket");
    const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "InspectorOne", phone: "13800000000", password: "A-secure-pass", confirmPassword: "A-secure-pass", phoneChallengeId: challenge.phoneChallengeId, smsCode: sentCode } });
    expect(registration.statusCode).toBe(201);
    const pending = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().user.status).toBe("pending_approval");
    expect(pending.json().accessToken).toBeTruthy();
    const pendingMe = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${pending.json().accessToken}` } });
    expect(pendingMe.statusCode).toBe(200);
    expect(pendingMe.json().user.status).toBe("pending_approval");
    const user = await pool.query("SELECT id FROM users WHERE username_normalized = 'inspectorone'");
    await pool.query("UPDATE users SET status = 'approved_active' WHERE id = $1", [user.rows[0].id]);
    const active = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "InspectorOne", password: "A-secure-pass" } });
    expect(active.statusCode).toBe(200);
    const token = active.json().accessToken;
    expect(token).toBeTruthy();
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.status).toBe("approved_active");
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(204);
    const expired = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(expired.statusCode).toBe(401);
    await app.close();
  });

  test("requires an admin cookie, CSRF token and idempotency key to approve exactly once", async () => {
    const passwords = createPasswordService();
    const adminId = uuidv7();
    const inspectorId = uuidv7();
    const passwordHash = await passwords.hash("A-secure-pass");
    const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
    await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
      VALUES ($1,'AdminOne','adminone','管理员',$2,'phone-admin',now(),$3,'approved_active'),($4,'InspectorTwo','inspectortwo','探店员',$5,'phone-inspector',now(),$3,'pending_approval')`, [adminId, encrypt(encryptionKey, normalizePhone("13600000000")), passwordHash, inspectorId, encrypt(encryptionKey, normalizePhone("13800000000"))]);
    const role = await pool.query("SELECT id FROM roles WHERE code = 'super_admin'");
    await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, role.rows[0].id]);
    await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);
    const registrationId = uuidv7();
    await pool.query("INSERT INTO inspector_registrations (id,user_id,status) VALUES ($1,$2,'pending_approval')", [registrationId, inspectorId]);
    const app = buildApp({ config, pool, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test-message" }) } });
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { username: "AdminOne", password: "A-secure-pass" } });
    expect(login.statusCode).toBe(200);
    const csrfToken = login.json().csrfToken;
    const cookie = login.headers["set-cookie"];
    const registrations = await app.inject({ method: "GET", url: "/api/admin/inspector-registrations", headers: { cookie } });
    expect(registrations.statusCode).toBe(200);
    expect(registrations.json().items[0]).toMatchObject({ id: registrationId, maskedPhone: "138****0000" });
    const headers = { cookie, "x-csrf-token": csrfToken, "idempotency-key": uuidv7() };
    const approval = await app.inject({ method: "POST", url: `/api/admin/inspector-registrations/${registrationId}/approve`, headers, payload: { revision: 0 } });
    expect(approval.statusCode).toBe(200);
    const stale = await app.inject({ method: "POST", url: `/api/admin/inspector-registrations/${registrationId}/approve`, headers: { ...headers, "idempotency-key": uuidv7() }, payload: { revision: 0 } });
    expect(stale.statusCode).toBe(409);
    const inspectors = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } });
    expect(inspectors.statusCode).toBe(200);
    expect(inspectors.json().items).toEqual([expect.objectContaining({ id: inspectorId, roleCode: "inspector" })]);
    const user = await pool.query("SELECT status FROM users WHERE id = $1", [inspectorId]);
    expect(user.rows[0].status).toBe("approved_active");
    await app.close();
  });

  test("issues a restricted bearer session and requires a new SMS challenge before a rejected application is resubmitted", async () => {
    let sentCode;
    const passwords = createPasswordService();
    const id = uuidv7();
    const encryptionKey = Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64");
    await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
      VALUES ($1,'RejectedUser','rejecteduser','被拒绝用户',$2,$3,now(),$4,'rejected')`, [id, encrypt(encryptionKey, normalizePhone("13800000000")), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13800000000")), await passwords.hash("A-secure-pass")]);
    const previousRegistrationId = uuidv7();
    await pool.query("INSERT INTO inspector_registrations (id,user_id,status,rejection_reason) VALUES ($1,$2,'rejected','资料需补充')", [previousRegistrationId, id]);
    const app = buildApp({ config, pool, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async ({ code }) => { sentCode = code; return { messageId: "test-message" }; } } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "RejectedUser", password: "A-secure-pass" } });
    expect(login.statusCode).toBe(200);
    const token = login.json().accessToken;
    expect(token).toBeTruthy();
    const codeResponse = await app.inject({ method: "POST", url: "/api/auth/register/phone-code", payload: { phone: "13800000000", captchaTicket: "test-ticket", captchaRandstr: "test-randstr" } });
    expect(codeResponse.statusCode).toBe(200);
    const resubmit = await app.inject({ method: "POST", url: "/api/auth/registration/resubmit", headers: { authorization: `Bearer ${token}` }, payload: { phoneChallengeId: codeResponse.json().phoneChallengeId, smsCode: sentCode } });
    expect(resubmit.statusCode).toBe(200);
    const registrations = await pool.query("SELECT status,previous_registration_id FROM inspector_registrations WHERE user_id = $1 ORDER BY submitted_at", [id]);
    expect(registrations.rows).toEqual([
      expect.objectContaining({ status: "rejected", previous_registration_id: null }),
      expect.objectContaining({ status: "pending_approval", previous_registration_id: previousRegistrationId }),
    ]);
    await app.close();
  });

  test("consumes a password reset token once and revokes previous sessions", async () => {
    let sentCode;
    const passwordHash = await createPasswordService().hash("old-secure-password");
    const id = uuidv7();
    await pool.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
      VALUES ($1,'ResetUser','resetuser','重置用户','cipher-reset',$2,now(),$3,'approved_active')`, [id, hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone("13800000000")), passwordHash]);
    const app = buildApp({ config, pool, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async ({ code }) => { sentCode = code; return { messageId: "test-message" }; } } });
    const codeResponse = await app.inject({ method: "POST", url: "/api/auth/password-resets/code", payload: { phone: "13800000000", captchaTicket: "test-ticket", captchaRandstr: "test-randstr", deviceFingerprint: "device-fingerprint" } });
    expect(codeResponse.statusCode).toBe(200);
    const verified = await app.inject({ method: "POST", url: "/api/auth/password-resets/verify", payload: { phoneChallengeId: codeResponse.json().phoneChallengeId, smsCode: sentCode } });
    expect(verified.statusCode).toBe(200);
    const complete = await app.inject({ method: "POST", url: "/api/auth/password-resets/complete", payload: { resetToken: verified.json().resetToken, password: "New-secure-pass", confirmPassword: "New-secure-pass" } });
    expect(complete.statusCode).toBe(204);
    const reused = await app.inject({ method: "POST", url: "/api/auth/password-resets/complete", payload: { resetToken: verified.json().resetToken, password: "New-secure-pass", confirmPassword: "New-secure-pass" } });
    expect(reused.statusCode).toBe(409);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ResetUser", password: "New-secure-pass" } });
    expect(login.statusCode).toBe(200);
    await app.close();
  });

  test("enforces PostgreSQL SMS rate limits without an in-memory counter", async () => {
    const app = buildApp({ config, pool, logger: false, providers: { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test-message" }) } });
    const request = { method: "POST", url: "/api/auth/register/phone-code", payload: { phone: "13800000000", captchaTicket: "test-ticket", captchaRandstr: "test-randstr", deviceFingerprint: "device-fingerprint" } };
    expect((await app.inject(request)).statusCode).toBe(200);
    const limited = await app.inject(request);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    await app.close();
  });
});

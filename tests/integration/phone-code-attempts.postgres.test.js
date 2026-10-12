import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../../apps/api/src/app.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";

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
const providers = { verifyCaptcha: async () => true, sendSms: async () => ({ messageId: "test-message" }), generateCode: async () => "246810" };
const CORRECT_CODE = "246810";
const WRONG_CODE = "000000";

// 注意：payload 的 phone 必须与 challenge 的手机号一致，否则 expectedPhone 校验
// 先于码比较抛 SMS_CODE_INVALID，到不了错误计数分支。
const registerPayload = (challengeId, phone, overrides = {}) => ({
  username: "CodeAttemptUser", phone, password: "A-secure-pass", confirmPassword: "A-secure-pass",
  phoneChallengeId: challengeId, smsCode: CORRECT_CODE, ...overrides,
});

async function beginChallenge(app, phone) {
  const response = await app.inject({ method: "POST", url: "/api/auth/register/phone-code", payload: { phone, captchaTicket: "test-ticket", captchaRandstr: "test-randstr" } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().phoneChallengeId;
}

async function wrongAttempt(app, challengeId, phone) {
  const response = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(challengeId, phone, { smsCode: WRONG_CODE }) });
  expect([422, 409]).toContain(response.statusCode);
  return response;
}

const challengeRow = async (challengeId) => (await pool.query("SELECT failed_attempts, invalidated_at, consumed_at FROM phone_verification_challenges WHERE id = $1", [challengeId])).rows[0];

describe.sequential("phone verification code attempt counting", () => {
  beforeEach(async () => {
    if (!pool) return;
    databaseLock = await pool.connect();
    await databaseLock.query("SELECT pg_advisory_lock(hashtext('junde-phone-code-attempts-tests'))");
    await pool.query("TRUNCATE auth_sessions, password_reset_tokens, phone_verification_challenges, rate_limit_buckets, inspector_registrations, user_roles, role_permissions, user_data_scopes, roles, permissions, users RESTART IDENTITY CASCADE");
    await seedRbac(pool);
  });
  afterEach(async () => {
    if (!databaseLock) return;
    await databaseLock.query("SELECT pg_advisory_unlock(hashtext('junde-phone-code-attempts-tests'))");
    databaseLock.release();
    databaseLock = null;
  });
  afterAll(async () => { await pool?.end(); });

  test("persists failed attempts: third wrong code exhausts, fourth (even correct) is invalidated", async () => {
    const app = buildApp({ config, pool, logger: false, providers });
    const phone = "13800000000";
    const challengeId = await beginChallenge(app, phone);
    const first = await wrongAttempt(app, challengeId, phone);
    expect(first.statusCode).toBe(422);
    expect(first.json().error.code).toBe("SMS_CODE_INVALID");
    const second = await wrongAttempt(app, challengeId, phone);
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe("SMS_CODE_INVALID");
    const third = await wrongAttempt(app, challengeId, phone);
    expect(third.statusCode).toBe(422);
    expect(third.json().error.code).toBe("SMS_CODE_ATTEMPTS_EXHAUSTED");
    const row = await challengeRow(challengeId);
    expect(Number(row.failed_attempts)).toBe(3);
    expect(row.invalidated_at).not.toBeNull();
    const fourth = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(challengeId, phone) });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error.code).toBe("SMS_CODE_INVALIDATED");
    await app.close();
  });

  test("resending invalidates the old challenge; a fresh code completes registration", async () => {
    const app = buildApp({ config, pool, logger: false, providers });
    const phone = "13800000001";
    const oldChallengeId = await beginChallenge(app, phone);
    await wrongAttempt(app, oldChallengeId, phone);
    await wrongAttempt(app, oldChallengeId, phone);
    await pool.query("TRUNCATE rate_limit_buckets");
    const newChallengeId = await beginChallenge(app, phone);
    const oldCorrect = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(oldChallengeId, phone, { username: "ResendOldCorrect" }) });
    expect(oldCorrect.statusCode).toBe(409);
    expect(oldCorrect.json().error.code).toBe("SMS_CODE_INVALIDATED");
    const oldWrong = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(oldChallengeId, phone, { username: "ResendOldWrong", smsCode: WRONG_CODE }) });
    expect(oldWrong.statusCode).toBe(409);
    expect(oldWrong.json().error.code).toBe("SMS_CODE_INVALIDATED");
    const success = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(newChallengeId, phone, { username: "ResendNewUser" }) });
    expect(success.statusCode).toBe(201);
    await app.close();
  });

  test("concurrent wrong codes cannot bypass the limit; concurrent correct codes admit exactly one", async () => {
    const app = buildApp({ config, pool, logger: false, providers });
    const phone = "13800000002";
    const challengeId = await beginChallenge(app, phone);
    const wrongResults = await Promise.all([0, 1, 2].map((i) => app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(challengeId, phone, { username: `ConcurrentWrong${i}`, smsCode: WRONG_CODE }) })));
    for (const response of wrongResults) {
      expect(response.statusCode).toBe(422);
      expect(["SMS_CODE_INVALID", "SMS_CODE_ATTEMPTS_EXHAUSTED"]).toContain(response.json().error.code);
    }
    const row = await challengeRow(challengeId);
    expect(Number(row.failed_attempts)).toBe(3);
    expect(row.invalidated_at).not.toBeNull();
    const afterExhaust = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(challengeId, phone, { username: "ConcurrentAfterExhaust" }) });
    expect(afterExhaust.statusCode).toBe(409);
    expect(afterExhaust.json().error.code).toBe("SMS_CODE_INVALIDATED");
    await pool.query("TRUNCATE rate_limit_buckets");
    const freshPhone = "13800000003";
    const freshChallengeId = await beginChallenge(app, freshPhone);
    const correctResults = await Promise.all([
      app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(freshChallengeId, freshPhone, { username: "ConcurrentCorrectA" }) }),
      app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(freshChallengeId, freshPhone, { username: "ConcurrentCorrectB" }) }),
    ]);
    const statuses = correctResults.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = correctResults.find((response) => response.statusCode === 409);
    expect(loser.json().error.code).toBe("SMS_CODE_INVALIDATED");
    await app.close();
  });

  test("business rollback keeps the challenge unconsumed and uncounted", async () => {
    const app = buildApp({ config, pool, logger: false, providers });
    const phone = "13800000004";
    // 冲突用户用另一手机号注册：冲突只落在 username_normalized 唯一约束上，
    // 保证「换用户名重试同码」场景下挑战手机号本身仍然可用。
    const holderPhone = "13800000009";
    const existing = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(await beginChallenge(app, holderPhone), holderPhone, { username: "ConflictHolder", password: "B-secure-pass", confirmPassword: "B-secure-pass" }) });
    expect(existing.statusCode).toBe(201);
    await pool.query("TRUNCATE rate_limit_buckets");
    const challengeId = await beginChallenge(app, phone);
    const conflict = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(challengeId, phone, { username: "ConflictHolder" }) });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("REGISTRATION_CONFLICT");
    const row = await challengeRow(challengeId);
    expect(row.consumed_at).toBeNull();
    expect(Number(row.failed_attempts)).toBe(0);
    const retry = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(challengeId, phone, { username: "RetryAfterConflict" }) });
    expect(retry.statusCode).toBe(201);
    await app.close();
  });

  test("a correct code can only be consumed once", async () => {
    const app = buildApp({ config, pool, logger: false, providers });
    const phone = "13800000005";
    const challengeId = await beginChallenge(app, phone);
    const first = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(challengeId, phone, { username: "ConsumeOnce" }) });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerPayload(challengeId, phone, { username: "ConsumeReplay" }) });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("SMS_CODE_INVALIDATED");
    await app.close();
  });
});

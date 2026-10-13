import { z } from "zod";
import { AdminLoginRequestSchema, CursorPageSchema, IdempotencyKeySchema, LoginRequestSchema, PasswordResetCompleteRequestSchema, PhoneCodeRequestSchema, PhoneCodeVerifyRequestSchema, RegisterRequestSchema, RegistrationDecisionSchema, RegistrationResubmitSchema, SecureUuidSchema, UserCreateSchema, UserUpdateSchema } from "../../../../packages/contracts/index.js";
import { code, decrypt, encrypt, hmac, normalizePhone, normalizeUsername, opaqueToken, safeEqual } from "./crypto.js";
import { uuidv7 } from "../ids.js";
import { writeAudit } from "../audit.js";
import { authorizeAdmin } from "./authorization.js";
import { consumeRateLimit } from "./rate-limit.js";

const now = () => new Date();
const addMinutes = (minutes) => new Date(Date.now() + minutes * 60_000);
const businessError = (code, message, statusCode = 422, options = {}) => Object.assign(new Error(message), { code, statusCode, ...options });
// disable/enable 不做乐观并发控制，revision 可选；审批路由仍用 RegistrationDecisionSchema（revision 必填）。
const UserStatusChangeSchema = z.object({ reason: z.string().trim().min(1).max(1000).optional() });
// scopeLabel：按角色与数据范围返回有信息量的文案——super_admin/无显式范围的管理员为全部数据，
// 区域/门店范围给出具体名称，探员只看自己的任务。
const scopeLabelFor = async (db, userId, role) => {
  if (!role) return "本人任务数据";
  if (role === "super_admin") return "全部数据";
  const scope = await db.query(`SELECT s.scope_type,region.name region_name,store.name store_name FROM user_data_scopes s
    LEFT JOIN regions region ON region.id = s.region_id LEFT JOIN stores store ON store.id = s.store_id
    WHERE s.user_id = $1 AND s.revoked_at IS NULL ORDER BY s.granted_at DESC LIMIT 1`, [userId]);
  const row = scope.rows[0];
  if (row?.scope_type === "region") return row.region_name ? `${row.region_name}区域数据` : "指定区域数据";
  if (row?.scope_type === "store") return row.store_name ? `${row.store_name}门店数据` : "指定门店数据";
  return "全部数据";
};
const publicUser = async (db, row, role) => ({ id: row.id, displayName: row.display_name, status: row.status, ...(role ? { role, scopeLabel: await scopeLabelFor(db, row.id, role) } : {}) });

export function registerAuthRoutes(app, { pool, config, passwordService, providers }) {
  const configured = Boolean(pool && config.AUTH_TOKEN_HMAC_KEY && config.PHONE_ENCRYPTION_KEY_BASE64);
  const key = configured ? Buffer.from(config.PHONE_ENCRYPTION_KEY_BASE64, "base64") : null;
  if (key && key.length !== 32) throw new Error("PHONE_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  const tokenHash = (value) => hmac(config.AUTH_TOKEN_HMAC_KEY, value);
  const phoneHash = (phone) => hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone(phone));
  const unavailable = async () => { throw businessError("AUTH_NOT_CONFIGURED", "认证服务暂未配置", 503, { retryable: true }); };
  const transaction = async (work) => {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  };
  const createSession = async (client, user, kind, role = null) => {
    const rawToken = opaqueToken();
    const csrfToken = kind === "admin" ? opaqueToken() : null;
    const idleMinutes = kind === "admin" ? 30 : 12 * 60;
    const absoluteMinutes = kind === "admin" ? 12 * 60 : 30 * 24 * 60;
    await client.query(`INSERT INTO auth_sessions (id, user_id, token_hmac, kind, session_version, csrf_secret_hash, idle_expires_at, absolute_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [uuidv7(), user.id, tokenHash(rawToken), kind, user.session_version, csrfToken ? tokenHash(csrfToken) : null, addMinutes(idleMinutes), addMinutes(absoluteMinutes)]);
    return { rawToken, csrfToken, session: { user: await publicUser(client, user, role), ...(["inspector", "application_status"].includes(kind) ? { accessToken: rawToken } : {}), ...(kind === "admin" ? { csrfToken } : {}) } };
  };
  const requireConfigured = (handler) => configured ? handler : unavailable;
  const beginCode = async (purpose, request) => {
    const body = PhoneCodeRequestSchema.parse(request.body);
    const phone = normalizePhone(body.phone);
    const phoneLimit = await consumeRateLimit(pool, { scope: `sms:${purpose}:phone`, key: phone, secret: config.AUTH_TOKEN_HMAC_KEY, limit: 1, windowSeconds: 60 });
    const ipLimit = await consumeRateLimit(pool, { scope: `sms:${purpose}:ip`, key: request.ip, secret: config.AUTH_TOKEN_HMAC_KEY, limit: 20, windowSeconds: 60 });
    if (!phoneLimit || !ipLimit) throw businessError("RATE_LIMITED", "操作过于频繁，请稍后重试", 429, { retryable: true });
    const verified = await providers.verifyCaptcha({ ticket: body.captchaTicket, randstr: body.captchaRandstr, purpose, ip: request.ip });
    if (!verified) throw businessError("CAPTCHA_REJECTED", "验证未通过，请重试", 422);
    if (purpose === "password_reset") {
      const user = await pool.query("SELECT id FROM users WHERE phone_lookup_hmac = $1", [phoneHash(phone)]);
      if (!user.rows[0]) return { message: "如该手机号已注册，验证码已发送" };
    }
    // 验证码默认由密码学安全随机数生成；沙箱 Provider 可通过 generateCode 提供
    // 固定验证码（仅测试环境），确保“投递的验证码”与“存储的摘要”始终一致。
    const rawCode = typeof providers.generateCode === "function" ? await providers.generateCode() : code();
    const challenge = await transaction(async (client) => {
      await client.query(`UPDATE phone_verification_challenges SET invalidated_at = now() WHERE purpose = $1 AND phone_lookup_hmac = $2 AND consumed_at IS NULL AND invalidated_at IS NULL`, [purpose, phoneHash(phone)]);
      const row = { id: uuidv7(), phoneCiphertext: encrypt(key, phone), phoneLookup: phoneHash(phone), codeHash: tokenHash(rawCode) };
      // captcha_verification_id 只保存腾讯 RequestId（脱敏），绝不保存完整 ticket。
      await client.query(`INSERT INTO phone_verification_challenges (id,purpose,phone_lookup_hmac,phone_ciphertext,code_hmac,expires_at,resend_available_at,delivery_status,captcha_provider,captcha_verification_id,created_ip_hmac)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)`, [row.id, purpose, row.phoneLookup, row.phoneCiphertext, row.codeHash, addMinutes(5), addMinutes(1), verified.provider || "configured", verified.requestId || null, tokenHash(request.ip)]);
      return row;
    });
    try {
      const delivery = await providers.sendSms({ phone, code: rawCode, purpose });
      await pool.query("UPDATE phone_verification_challenges SET delivery_status = 'sent', provider_message_id = $2 WHERE id = $1 AND delivery_status = 'pending'", [challenge.id, delivery?.messageId || null]);
    } catch (error) {
      await pool.query("UPDATE phone_verification_challenges SET delivery_status = 'send_failed', invalidated_at = now() WHERE id = $1", [challenge.id]);
      throw businessError("SMS_UNAVAILABLE", "验证码暂时无法发送，请稍后重试", 503, { retryable: true });
    }
    return { phoneChallengeId: challenge.id, message: "验证码已发送，请注意查收" };
  };
  const verifyChallenge = async (client, { purpose, challengeId, rawCode, expectedPhone = null }) => {
    const result = await client.query("SELECT * FROM phone_verification_challenges WHERE id = $1 FOR UPDATE", [challengeId]);
    const challenge = result.rows[0];
    if (!challenge || challenge.purpose !== purpose || challenge.delivery_status !== "sent" || challenge.consumed_at || challenge.invalidated_at || new Date(challenge.expires_at) <= now()) throw businessError("SMS_CODE_INVALIDATED", "验证码已失效，请重新获取", 409);
    if (expectedPhone && challenge.phone_lookup_hmac !== phoneHash(expectedPhone)) throw businessError("SMS_CODE_INVALID", "验证码不正确", 422);
    if (!safeEqual(challenge.code_hmac, tokenHash(rawCode))) {
      throw Object.assign(businessError("SMS_CODE_INVALID", "验证码不正确", 422), { challengeFailure: challenge.id });
    }
    await client.query("UPDATE phone_verification_challenges SET consumed_at = now() WHERE id = $1", [challenge.id]);
    return challenge;
  };
  // 独立连接记录错误计数：业务事务回滚后（challenge 行锁已释放）才能执行，
  // 否则另一连接 UPDATE 同一行会被行锁阻塞。WHERE 防止对已消费/已失效 challenge 计数；
  // UPDATE 自身失败必须向上抛（fail-closed），不得静默放行。
  const recordChallengeFailure = async (challengeId) => {
    const result = await pool.query(`UPDATE phone_verification_challenges SET failed_attempts = failed_attempts + 1,
      invalidated_at = CASE WHEN failed_attempts + 1 >= max_attempts THEN now() ELSE invalidated_at END
      WHERE id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL
      RETURNING failed_attempts, max_attempts`, [challengeId]);
    const row = result.rows[0];
    if (!row) throw businessError("SMS_CODE_INVALIDATED", "验证码已失效，请重新获取", 409);
    return row.failed_attempts >= row.max_attempts
      ? businessError("SMS_CODE_ATTEMPTS_EXHAUSTED", "验证码已失效，请重新获取", 422)
      : businessError("SMS_CODE_INVALID", "验证码不正确", 422);
  };
  const transactionWithChallenge = async (work) => {
    try { return await transaction(work); }
    catch (error) {
      if (!error.challengeFailure) throw error;
      throw await recordChallengeFailure(error.challengeFailure);
    }
  };

  app.post("/api/auth/register/phone-code", requireConfigured(async (request) => beginCode("registration", request)));
  app.post("/api/auth/password-resets/code", requireConfigured(async (request) => beginCode("password_reset", request)));
  app.post("/api/auth/register", requireConfigured(async (request, reply) => {
    const body = RegisterRequestSchema.parse(request.body);
    const passwordHash = await passwordService.hash(body.password);
    try {
      await transactionWithChallenge(async (client) => {
        await verifyChallenge(client, { purpose: "registration", challengeId: body.phoneChallengeId, rawCode: body.smsCode, expectedPhone: body.phone });
        const id = uuidv7();
        await client.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
          VALUES ($1,$2,$3,$2,$4,$5,now(),$6,'pending_approval')`, [id, body.username, normalizeUsername(body.username), encrypt(key, normalizePhone(body.phone)), phoneHash(body.phone), passwordHash]);
        await client.query("INSERT INTO inspector_registrations (id,user_id,status) VALUES ($1,$2,'pending_approval')", [uuidv7(), id]);
        await writeAudit(client, { id, display_name: body.username, username_display: body.username }, "registration_submitted", "registration", id, { username: body.username });
      });
    } catch (error) {
      if (error.code === "23505") throw businessError("REGISTRATION_CONFLICT", "提交未完成，请检查后重试", 409);
      throw error;
    }
    return reply.code(201).send({ message: "申请已提交，请等待审核" });
  }));
  const login = (admin) => requireConfigured(async (request, reply) => {
    const body = (admin ? AdminLoginRequestSchema : LoginRequestSchema).parse(request.body);
    const loginLimit = await consumeRateLimit(pool, { scope: `login:${admin ? "admin" : "inspector"}:ip`, key: request.ip, secret: config.AUTH_TOKEN_HMAC_KEY, limit: 20, windowSeconds: 60 });
    if (!loginLimit) throw businessError("RATE_LIMITED", "操作过于频繁，请稍后重试", 429, { retryable: true });
    const result = await pool.query("SELECT * FROM users WHERE username_normalized = $1", [normalizeUsername(body.username)]);
    const user = result.rows[0];
    const passwordOk = user ? await passwordService.verify(user.password_hash, body.password) : false;
    if (!user || !passwordOk) {
      // 审计：已知账号密码错误记为失败事件（用户名不存在的探测不记录，避免噪音）
      if (user && !passwordOk) {
        try {
          await pool.query("INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,'login_failed','user',$5,$6)",
            [uuidv7(), user.id, user.display_name, body.username, user.id, JSON.stringify({ admin, username: body.username })]);
        } catch { /* 审计写入失败不影响登录报错 */ }
      }
      throw businessError("INVALID_CREDENTIALS", "用户名或密码不正确", 401);
    }
    let role = null;
    if (admin) {
      const roleResult = await pool.query(`SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND ur.revoked_at IS NULL ORDER BY r.code LIMIT 1`, [user.id]);
      role = roleResult.rows[0]?.code;
      // 状态异常或没有角色时保持统一 401（防枚举）；持有探员等非管理员角色的账号明确提示无权限。
      if (user.status !== "approved_active" || !role) throw businessError("INVALID_CREDENTIALS", "用户名或密码不正确", 401);
      if (!ADMIN_ROLE_CODES.includes(role)) throw businessError("ADMIN_ACCESS_DENIED", "该账号没有后台管理权限，请使用探店员小程序", 403);
    }
    if (!admin && user.status === "disabled") throw businessError("ACCOUNT_DISABLED", "账号已停用，请联系管理员", 403);
    const kind = admin ? "admin" : user.status === "approved_active" ? "inspector" : "application_status";
    const session = await transaction(async (client) => {
      await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
      // 审计：登录成功（动作名区分端侧，操作审计页展示「管理员登录后台/探员登录小程序」）
      await client.query("INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,$5,'user',$6,'{}'::jsonb)",
        [uuidv7(), user.id, user.display_name, body.username, admin ? "admin_login" : "inspector_login", user.id]);
      const created = await createSession(client, user, kind, role);
      // 登录响应与 /api/me 保持一致：携带权限集合（前端菜单按 audit:read 等权限显隐）
      if (admin) {
        const perms = await client.query(`SELECT DISTINCT p.code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
          WHERE ur.user_id = $1 AND ur.revoked_at IS NULL`, [user.id]);
        created.session.user.permissions = perms.rows.map((row) => row.code);
      }
      return created;
    });
    if (admin) reply.setCookie("junde_admin_session", session.rawToken, { httpOnly: true, sameSite: "strict", secure: config.NODE_ENV === "production", path: "/api", maxAge: 30 * 60 });
    return session.session;
  });
  app.post("/api/auth/login", login(false));
  app.post("/api/admin/auth/login", login(true));
  const sessionFor = async (request, allowAdmin = true) => {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const cookie = request.cookies.junde_admin_session;
    if (bearer && cookie) throw businessError("AUTH_AMBIGUOUS", "登录状态无效，请重新登录", 400);
    const raw = bearer || (allowAdmin ? cookie : null);
    if (!raw) throw businessError("SESSION_EXPIRED", "登录已失效，请重新登录", 401);
    const result = await pool.query(`SELECT s.*, u.id user_id, u.display_name, u.username_display, u.status user_status, u.session_version current_session_version
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hmac = $1 AND s.revoked_at IS NULL AND s.idle_expires_at > now() AND s.absolute_expires_at > now()`, [tokenHash(raw)]);
    const session = result.rows[0];
    if (!session || session.session_version !== session.current_session_version) throw businessError("SESSION_EXPIRED", "登录已失效，请重新登录", 401);
    // 滑动续期：每次有效请求刷新闲置窗口（admin 30 分钟，探店员 12 小时），
    // 持续操作不掉线；absolute_expires_at 仍为绝对上限兜底。
    const idleMinutes = session.kind === "admin" ? 30 : 12 * 60;
    await pool.query("UPDATE auth_sessions SET idle_expires_at = now() + make_interval(mins => $2), last_seen_at = now() WHERE id = $1", [session.id, idleMinutes]);
    return session;
  };
  app.get("/api/me", requireConfigured(async (request) => {
    const session = await sessionFor(request);
    const roleResult = session.kind === "admin" ? await pool.query(`SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND ur.revoked_at IS NULL ORDER BY r.code LIMIT 1`, [session.user_id]) : { rows: [] };
    const role = roleResult.rows[0]?.code;
    const csrfToken = session.kind === "admin" ? opaqueToken() : null;
    if (csrfToken) await pool.query("UPDATE auth_sessions SET csrf_secret_hash = $2,last_seen_at = now() WHERE id = $1", [session.id, tokenHash(csrfToken)]);
    // 权限集合（用户全部角色的权限并集）：前端菜单按权限显隐（如 audit:read 控制操作审计入口）
    const permissions = session.kind === "admin"
      ? (await pool.query(`SELECT DISTINCT p.code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
          WHERE ur.user_id = $1 AND ur.revoked_at IS NULL`, [session.user_id])).rows.map((row) => row.code)
      : [];
    return { user: { id: session.user_id, displayName: session.display_name, status: session.user_status, ...(role ? { role, scopeLabel: await scopeLabelFor(pool, session.user_id, role) } : {}), ...(session.kind === "admin" ? { permissions } : {}) }, ...(csrfToken ? { csrfToken } : {}) };
  }));
  const logout = requireConfigured(async (request, reply) => {
    const session = await sessionFor(request);
    await pool.query("UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL", [session.id]);
    // 审计：区分端侧记录主动退出
    try {
      await writeAudit(pool, session, session.kind === "admin" ? "admin_logout" : "inspector_logout", "user", session.user_id);
    } catch { /* 审计写入失败不影响登出 */ }
    reply.clearCookie("junde_admin_session", { path: "/api" });
    return reply.code(204).send();
  });
  app.post("/api/auth/logout", logout);
  app.post("/api/admin/auth/logout", logout);
  app.post("/api/auth/registration/resubmit", requireConfigured(async (request) => {
    const body = RegistrationResubmitSchema.parse(request.body);
    const session = await sessionFor(request, false);
    if (session.kind !== "application_status" || session.user_status !== "rejected") throw businessError("REGISTRATION_NOT_REJECTED", "当前申请无法重新提交", 409);
    await transactionWithChallenge(async (client) => {
      const challenge = await verifyChallenge(client, { purpose: "registration", challengeId: body.phoneChallengeId, rawCode: body.smsCode });
      const user = await client.query("SELECT phone_lookup_hmac FROM users WHERE id = $1 FOR UPDATE", [session.user_id]);
      if (!user.rows[0] || user.rows[0].phone_lookup_hmac !== challenge.phone_lookup_hmac) throw businessError("SMS_CODE_INVALID", "验证码不正确", 422);
      const registration = await client.query("SELECT id FROM inspector_registrations WHERE user_id = $1 AND status = 'rejected' ORDER BY submitted_at DESC LIMIT 1 FOR UPDATE", [session.user_id]);
      if (!registration.rows[0]) throw businessError("REGISTRATION_NOT_REJECTED", "当前申请无法重新提交", 409);
      await client.query("UPDATE users SET status = 'pending_approval' WHERE id = $1 AND status = 'rejected'", [session.user_id]);
      await client.query("INSERT INTO inspector_registrations (id,user_id,status,previous_registration_id) VALUES ($1,$2,'pending_approval',$3)", [uuidv7(), session.user_id, registration.rows[0].id]);
      await writeAudit(client, session, "registration_resubmitted", "registration", registration.rows[0].id);
    });
    return { message: "申请已重新提交，请等待审核" };
  }));
  const adminReadSession = async (request, permission) => {
    const session = await sessionFor(request);
    if (session.kind !== "admin") throw businessError("FORBIDDEN", "你没有权限进行此操作", 403);
    const authorization = await authorizeAdmin(pool, { userId: session.user_id, permission });
    if (!authorization.allowed) throw businessError("FORBIDDEN", "你没有权限进行此操作", 403);
    // 数据范围随会话带出（user_data_scopes 行数组）：列表查询静默过滤、写操作断言 403。
    session.scopes = authorization.scopes;
    return session;
  };
  const adminSession = async (request, permission) => {
    const session = await adminReadSession(request, permission);
    const suppliedCsrf = request.headers["x-csrf-token"];
    if (typeof suppliedCsrf !== "string" || !safeEqual(session.csrf_secret_hash, tokenHash(suppliedCsrf))) throw businessError("CSRF_INVALID", "操作未完成，请刷新后重试", 403);
    IdempotencyKeySchema.parse(request.headers["idempotency-key"]);
    return session;
  };
  app.get("/api/admin/inspector-registrations", requireConfigured(async (request) => {
    await adminReadSession(request, "registration:review");
    const { cursor, limit } = CursorPageSchema.parse(request.query);
    // order=desc 取最新（id 为 uuidv7 时间有序）；默认 asc 保持既有行为，未知值按 asc。
    const order = request.query.order === "desc" ? { sql: "DESC", op: "<" } : { sql: "ASC", op: ">" };
    const result = await pool.query(`SELECT r.id,r.user_id,r.status,r.submitted_at,r.revision,u.display_name,u.username_display,u.phone_ciphertext
      FROM inspector_registrations r JOIN users u ON u.id = r.user_id
      WHERE ($1::uuid IS NULL OR r.id ${order.op} $1) ORDER BY r.id ${order.sql} LIMIT $2`, [cursor || null, limit + 1]);
    const rows = result.rows.slice(0, limit).map((row) => {
      const phone = decrypt(key, row.phone_ciphertext).replace(/^\+86/, "");
      return { id: row.id, userId: row.user_id, displayName: row.display_name, username: row.username_display, maskedPhone: `${phone.slice(0, 3)}****${phone.slice(-4)}`, appliedAt: row.submitted_at.toISOString(), status: row.status, revision: Number(row.revision) };
    });
    return { items: rows, nextCursor: result.rows.length > limit ? rows.at(-1).id : null };
  }));
  // 用户类型判定：有 user_roles 即带角色；admin 类角色 = 管理员/审计员，inspector = 探员。
  const ADMIN_ROLE_CODES = ["admin", "auditor", "super_admin", "operations_admin", "reviewer", "store_manager"];
  const roleKindFor = (code) => (ADMIN_ROLE_CODES.includes(code) ? "admin" : "inspector");
  const userRowFor = (row) => ({
    id: row.id,
    username: row.username_display,
    displayName: row.display_name,
    maskedPhone: row.phone_display === null ? null : `${row.phone_display.slice(0, 3)}****${row.phone_display.slice(-4)}`,
    roleCode: row.role_code,
    scopeType: row.scope_type || null,
    scopeLabel: row.scope_type === "all" ? "全部" : row.scope_type === "region" ? row.scope_region_name : row.scope_store_name || null,
    regionId: row.scope_region_id || null,
    storeId: row.scope_store_id || null,
    source: row.registration_id ? "registration" : "manual",
    status: row.status,
    revision: Number(row.revision),
  });
  app.get("/api/admin/users", requireConfigured(async (request) => {
    await adminReadSession(request, "user:manage");
    const kind = request.query.kind === "admin" ? "admin" : request.query.kind === "inspector" ? "inspector" : null;
    const { cursor, limit } = CursorPageSchema.parse(request.query);
    // 一个用户可能同时持有多个角色（如管理员+审计）：用 EXISTS 过滤 + 子查询取主角色，避免 JOIN 产生重复行
    const roleFilter = kind === "admin" ? `r.code = ANY($3)` : `r.code = 'inspector'`;
    const primaryRole = kind === "admin"
      ? `(SELECT r2.code FROM user_roles ur2 JOIN roles r2 ON r2.id = ur2.role_id WHERE ur2.user_id = u.id AND ur2.revoked_at IS NULL AND r2.code = ANY($3) ORDER BY r2.code LIMIT 1)`
      : `(SELECT r2.code FROM user_roles ur2 JOIN roles r2 ON r2.id = ur2.role_id WHERE ur2.user_id = u.id AND ur2.revoked_at IS NULL AND r2.code = 'inspector' LIMIT 1)`;
    const roleParams = kind === "admin" ? [ADMIN_ROLE_CODES] : null;
    // order=desc 取最新（id 为 uuidv7 时间有序）；默认 asc 保持既有行为，未知值按 asc。
    const order = request.query.order === "desc" ? { sql: "DESC", op: "<" } : { sql: "ASC", op: ">" };
    const result = await pool.query(`SELECT u.id,u.username_display,u.display_name,u.status,u.session_version revision,u.phone_ciphertext,${primaryRole} role_code,
        s.scope_type,s.region_id scope_region_id,s.store_id scope_store_id,region.name scope_region_name,store.name scope_store_name,reg.id registration_id
      FROM users u
      LEFT JOIN user_data_scopes s ON s.user_id = u.id AND s.revoked_at IS NULL
      LEFT JOIN regions region ON region.id = s.region_id
      LEFT JOIN stores store ON store.id = s.store_id
      LEFT JOIN inspector_registrations reg ON reg.user_id = u.id AND reg.status = 'approved_active'
      WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND ${roleFilter})
        AND ($1::uuid IS NULL OR u.id ${order.op} $1) ORDER BY u.id ${order.sql} LIMIT $2`,
      [cursor || null, limit + 1, ...(roleParams || [])]);
    const rows = result.rows.slice(0, limit).map((row) => {
      let phone_display = null;
      try {
        phone_display = decrypt(key, row.phone_ciphertext).replace(/^\+86/, "");
      } catch {
        phone_display = null;
      }
      return userRowFor({ ...row, phone_display });
    });
    return { items: rows, nextCursor: result.rows.length > limit ? rows.at(-1).id : null };
  }));
  // 用户详情（Admin 深链接/刷新编辑页用）：与列表同权限（user:manage），行结构与列表一致；
  // 主角色优先取管理类角色（与 kind=admin 列表的主角色语义一致），探员回退 inspector。
  app.get("/api/admin/users/:id", requireConfigured(async (request) => {
    await adminReadSession(request, "user:manage");
    const id = SecureUuidSchema.parse(request.params.id);
    const primaryRole = `(SELECT r2.code FROM user_roles ur2 JOIN roles r2 ON r2.id = ur2.role_id WHERE ur2.user_id = u.id AND ur2.revoked_at IS NULL ORDER BY CASE WHEN r2.code = 'inspector' THEN 1 ELSE 0 END, r2.code LIMIT 1)`;
    const result = await pool.query(`SELECT u.id,u.username_display,u.display_name,u.status,u.session_version revision,u.phone_ciphertext,${primaryRole} role_code,
        s.scope_type,s.region_id scope_region_id,s.store_id scope_store_id,region.name scope_region_name,store.name scope_store_name,reg.id registration_id
      FROM users u
      LEFT JOIN user_data_scopes s ON s.user_id = u.id AND s.revoked_at IS NULL
      LEFT JOIN regions region ON region.id = s.region_id
      LEFT JOIN stores store ON store.id = s.store_id
      LEFT JOIN inspector_registrations reg ON reg.user_id = u.id AND reg.status = 'approved_active'
      WHERE u.id = $1 LIMIT 1`, [id]);
    if (!result.rows[0]) throw businessError("USER_NOT_FOUND", "账号不存在或已被删除", 404);
    let phone_display = null;
    try {
      phone_display = decrypt(key, result.rows[0].phone_ciphertext).replace(/^\+86/, "");
    } catch {
      phone_display = null;
    }
    return { user: userRowFor({ ...result.rows[0], phone_display }) };
  }));
  app.post("/api/admin/users", requireConfigured(async (request, reply) => {
    const session = await adminSession(request, "user:manage");
    const body = UserCreateSchema.parse(request.body);
    const existing = await pool.query("SELECT 1 FROM users WHERE username_normalized = $1 OR phone_lookup_hmac = $2", [normalizeUsername(body.username), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizePhone(body.phone))]);
    if (existing.rows[0]) throw businessError("USER_CONFLICT", "用户名或手机号已存在", 409);
    const role = await pool.query("SELECT id FROM roles WHERE code = $1", [body.kind === "admin" ? "admin" : body.kind === "auditor" ? "auditor" : "inspector"]);
    if (!role.rows[0]) throw businessError("ROLE_NOT_FOUND", "角色不存在", 422);
    const passwordHash = await passwordService.hash(body.password);
    const id = uuidv7();
    const normalizedPhone = normalizePhone(body.phone);
    await transaction(async (client) => {
      await client.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
        VALUES ($1,$2,$3,$4,$5,$6,now(),$7,'approved_active')`,
        [id, body.username, normalizeUsername(body.username), body.displayName, encrypt(key, normalizedPhone), hmac(config.AUTH_TOKEN_HMAC_KEY, normalizedPhone), passwordHash]);
      await client.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), id, role.rows[0].id]);
      if (body.kind !== "inspector") {
        const scopeType = body.scopeType || "all";
        await client.query(`INSERT INTO user_data_scopes (id,user_id,scope_type,region_id,store_id) VALUES ($1,$2,$3,$4,$5)`,
          [uuidv7(), id, scopeType, scopeType === "region" ? body.regionId : null, scopeType === "store" ? body.storeId : null]);
      }
      await client.query(`INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,'user_created','user',$5,$6)`,
        [uuidv7(), session.user_id, session.display_name, session.username_display, id, JSON.stringify({ kind: body.kind, username: body.username, scopeType: body.scopeType || (body.kind !== "inspector" ? "all" : null) })]);
    });
    return reply.code(201).send({ user: { id, username: body.username, displayName: body.displayName, kind: body.kind } });
  }));
  app.patch("/api/admin/users/:id", requireConfigured(async (request) => {
    const session = await adminSession(request, "user:manage");
    const body = UserUpdateSchema.parse(request.body);
    const id = SecureUuidSchema.parse(request.params.id);
    const changed = await transaction(async (client) => {
      const current = await client.query(`SELECT u.id,u.status,u.session_version revision,u.username_display,ur.role_id,r.code role_code FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        LEFT JOIN roles r ON r.id = ur.role_id WHERE u.id = $1 FOR UPDATE OF u`, [id]);
      if (!current.rows[0]) throw businessError("USER_NOT_FOUND", "用户不存在", 404);
      const target = current.rows[0];
      const targetKind = roleKindFor(target.role_code);
      // 保护规则：不能停用/降级自己；不能移除最后一名管理员
      const demotingOrDisablingAdmin = targetKind === "admin" && (body.status === "disabled" || body.kind === "inspector");
      if (demotingOrDisablingAdmin) {
        if (id === session.user_id) throw businessError("SELF_PROTECTED", "不能停用或降级自己的账号", 422);
        const adminCount = await client.query(`SELECT count(*)::int n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.revoked_at IS NULL AND r.code = ANY($1) AND ur.user_id <> $2`, [ADMIN_ROLE_CODES, id]);
        if (adminCount.rows[0].n === 0) throw businessError("LAST_ADMIN_PROTECTED", "不能移除最后一名管理员", 422);
      }
      if (body.password) {
        const passwordHash = await passwordService.hash(body.password);
        await client.query("UPDATE users SET password_hash = $2,password_changed_at = now(),session_version = session_version + 1 WHERE id = $1", [id, passwordHash]);
      }
      if (body.displayName !== undefined) await client.query("UPDATE users SET display_name = $2 WHERE id = $1", [id, body.displayName]);
      if (body.status !== undefined && target.status !== body.status) {
        await client.query("UPDATE users SET status = $2, disabled_at = CASE WHEN $2 = 'disabled' THEN now() ELSE NULL END, session_version = session_version + 1 WHERE id = $1", [id, body.status]);
        if (body.status === "disabled") await client.query("UPDATE auth_sessions SET revoked_at = now(),revoke_reason = 'disabled' WHERE user_id = $1 AND revoked_at IS NULL", [id]);
      }
      if (body.kind !== undefined && body.kind !== targetKind) {
        const newRole = await client.query("SELECT id FROM roles WHERE code = $1", [body.kind === "admin" ? "admin" : body.kind === "auditor" ? "auditor" : "inspector"]);
        if (!newRole.rows[0]) throw businessError("ROLE_NOT_FOUND", "角色不存在", 422);
        await client.query("UPDATE user_roles SET revoked_at = now(),revoked_by = $2 WHERE user_id = $1 AND revoked_at IS NULL", [id, session.user_id]);
        await client.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), id, newRole.rows[0].id]);
        if (body.kind !== "inspector" && !targetKind) {
          const scopeType = body.scopeType || "all";
          await client.query(`INSERT INTO user_data_scopes (id,user_id,scope_type,region_id,store_id) VALUES ($1,$2,$3,$4,$5)`,
            [uuidv7(), id, scopeType, scopeType === "region" ? body.regionId : null, scopeType === "store" ? body.storeId : null]);
        }
      }
      if (body.kind === "admin" && body.scopeType !== undefined) {
        await client.query("UPDATE user_data_scopes SET revoked_at = now(),revoked_by = $2 WHERE user_id = $1 AND revoked_at IS NULL", [id, session.user_id]);
        const scopeType = body.scopeType;
        await client.query(`INSERT INTO user_data_scopes (id,user_id,scope_type,region_id,store_id) VALUES ($1,$2,$3,$4,$5)`,
          [uuidv7(), id, scopeType, scopeType === "region" ? body.regionId : null, scopeType === "store" ? body.storeId : null]);
      }
      const fields = Object.keys(body).filter((name) => name !== "password");
      await client.query(`INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,'user_updated','user',$5,$6)`,
        [uuidv7(), session.user_id, session.display_name, session.username_display, id, JSON.stringify({ changed: fields, passwordReset: Boolean(body.password) })]);
      return { id, kind: body.kind || targetKind };
    });
    return { user: changed };
  }));
  app.delete("/api/admin/users/:id", async (request) => {
    const session = await adminSession(request, "user:manage");
    const id = SecureUuidSchema.parse(request.params.id);
    if (id === session.user_id) throw businessError("SELF_PROTECTED", "不能删除自己的账号", 422);
    await transaction(async (client) => {
      const current = await client.query(`SELECT u.id,u.status,u.session_version revision,u.username_display,ur.role_id,r.code role_code FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        LEFT JOIN roles r ON r.id = ur.role_id WHERE u.id = $1 FOR UPDATE OF u`, [id]);
      if (!current.rows[0]) throw businessError("USER_NOT_FOUND", "用户不存在", 404);
      const target = current.rows[0];
      if (roleKindFor(target.role_code) === "admin") {
        const adminCount = await client.query(`SELECT count(*)::int n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.revoked_at IS NULL AND r.code = ANY($1) AND ur.user_id <> $2`, [ADMIN_ROLE_CODES, id]);
        if (adminCount.rows[0].n === 0) throw businessError("LAST_ADMIN_PROTECTED", "不能删除最后一名管理员", 422);
      }
      // 只有「主体关系」才阻止删除：被指派的探店任务、提交记录、注册申请——记录本身就是关于这个人的。
      // created_by/published_by/granted_by 等归属字段只代表「谁操作的」，业务记录属于组织而非个人：
      // 删除账号时这些归属统一移交给当前操作者，不作为删除障碍（审计日志同理：快照保留、actor_id 置空）。
      const subject = await client.query(`SELECT EXISTS(
        SELECT 1 FROM audit_assignments WHERE inspector_id = $1
        UNION ALL SELECT 1 FROM submission_versions WHERE submitted_by = $1
        UNION ALL SELECT 1 FROM inspector_registrations WHERE user_id = $1
      ) AS referenced`, [id]);
      if (subject.rows[0].referenced) throw businessError("USER_DELETE_NOT_ALLOWED", "该账号已参与业务数据（有探店任务、提交记录或注册申请），无法删除，可改为停用", 409);
      const takeovers = [
        ["inspector_registrations", "reviewed_by"], ["user_roles", "granted_by"], ["user_data_scopes", "granted_by"],
        ["stores", "location_verified_by"], ["questionnaire_templates", "created_by"], ["questionnaire_versions", "created_by"], ["questionnaire_versions", "published_by"],
        ["audit_campaigns", "created_by"], ["audit_campaigns", "published_by"], ["audit_campaigns", "cancelled_by"],
        ["audit_assignments", "created_by"], ["audit_assignments", "assigned_by"], ["audit_assignments", "cancelled_by"], ["audit_assignments", "last_extended_by"],
        ["checkin_exemptions", "granted_by"], ["checkin_exemptions", "revoked_by"],
        ["export_jobs", "requested_by"], ["archive_restore_jobs", "requested_by"],
        ["legal_holds", "requested_by"], ["legal_holds", "approved_by"], ["legal_holds", "released_by"],
        ["receipt_attachments", "created_by"], ["receipt_ocr_applications", "created_by"], ["idempotency_keys", "actor_id"],
      ];
      for (const [table, column] of takeovers) {
        await client.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [id, session.user_id]);
      }
      try {
        await client.query("DELETE FROM auth_sessions WHERE user_id=$1", [id]);
        await client.query("DELETE FROM user_roles WHERE user_id=$1", [id]);
        await client.query("DELETE FROM user_data_scopes WHERE user_id=$1", [id]);
        await client.query("DELETE FROM users WHERE id=$1", [id]);
      } catch (error) {
        if (error.code === "23503") throw businessError("USER_DELETE_NOT_ALLOWED", "该账号已参与业务数据，无法删除，可改为停用", 409);
        throw error;
      }
      await client.query(`INSERT INTO audit_logs (id,actor_id,actor_name,actor_username,action,subject_type,subject_id,data_json) VALUES ($1,$2,$3,$4,'user_deleted','user',$5,$6)`,
        [uuidv7(), session.user_id, session.display_name, session.username_display, id, JSON.stringify({ username: target.username_display })]);
    });
    return { deleted: true };
  });
  const registrationTransition = (nextStatus, requiresReason = false) => requireConfigured(async (request) => {
    const session = await adminSession(request, "registration:review");
    const body = RegistrationDecisionSchema.parse(request.body);
    if (requiresReason && !body.reason) throw businessError("REASON_REQUIRED", "请填写处理原因", 422);
    const allowedCurrent = nextStatus === "approved_active" || nextStatus === "rejected" ? "pending_approval" : "rejected";
    const changed = await transaction(async (client) => {
      const result = await client.query(`UPDATE inspector_registrations SET status = $1,rejection_reason = $2,reviewed_at = now(),reviewed_by = $3,revision = revision + 1
        WHERE id = $4 AND status = $5 AND revision = $6 RETURNING user_id,revision,status`, [nextStatus, nextStatus === "rejected" ? body.reason : null, session.user_id, request.params.id, allowedCurrent, body.revision]);
      if (!result.rows[0]) throw businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      await client.query("UPDATE users SET status = $2, disabled_at = CASE WHEN $2 = 'disabled' THEN now() ELSE NULL END WHERE id = $1", [result.rows[0].user_id, nextStatus]);
      // 审批通过后自动挂 inspector 角色（手动建号已直接挂角色；注册通道在此补齐）
      if (nextStatus === "approved_active") {
        await client.query(`INSERT INTO user_roles (id,user_id,role_id)
          SELECT gen_random_uuid(),$1,id FROM roles WHERE code='inspector' AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=$1 AND ur.revoked_at IS NULL)`, [result.rows[0].user_id]);
      }
      return result.rows[0];
    });
    return { registration: changed };
  });
  app.post("/api/admin/inspector-registrations/:id/approve", registrationTransition("approved_active"));
  app.post("/api/admin/inspector-registrations/:id/reject", registrationTransition("rejected", true));
  app.post("/api/admin/inspector-registrations/:id/reopen", registrationTransition("pending_approval"));
  app.post("/api/admin/users/:id/disable", requireConfigured(async (request) => {
    const session = await adminSession(request, "user:disable");
    const body = UserStatusChangeSchema.parse(request.body);
    const result = await transaction(async (client) => {
      const user = await client.query("UPDATE users SET status = 'disabled',disabled_at = now(),session_version = session_version + 1 WHERE id = $1 AND status = 'approved_active' RETURNING id", [request.params.id]);
      if (!user.rows[0]) throw businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      await client.query("UPDATE auth_sessions SET revoked_at = now(),revoke_reason = 'disabled' WHERE user_id = $1 AND revoked_at IS NULL", [request.params.id]);
      await client.query("UPDATE inspector_registrations SET status = 'disabled',reviewed_at = now(),reviewed_by = $2,revision = revision + 1 WHERE user_id = $1 AND status = 'approved_active'", [request.params.id, session.user_id]);
      await writeAudit(client, session, "user_disabled", "user", user.rows[0].id, { reason: body.reason || null });
      return user.rows[0];
    });
    return { user: result };
  }));
  app.post("/api/admin/users/:id/enable", requireConfigured(async (request) => {
    const session = await adminSession(request, "user:disable");
    UserStatusChangeSchema.parse(request.body);
    const result = await transaction(async (client) => {
      const user = await client.query("UPDATE users SET status = 'approved_active',disabled_at = NULL WHERE id = $1 AND status = 'disabled' RETURNING id", [request.params.id]);
      if (!user.rows[0]) throw businessError("REVISION_CONFLICT", "内容已更新，请刷新后重试", 409);
      await client.query("UPDATE inspector_registrations SET status = 'approved_active',reviewed_at = now(),reviewed_by = $2,revision = revision + 1 WHERE user_id = $1 AND status = 'disabled'", [request.params.id, session.user_id]);
      await writeAudit(client, session, "user_enabled", "user", user.rows[0].id);
      return user.rows[0];
    });
    return { user: result };
  }));
  app.post("/api/auth/password-resets/verify", requireConfigured(async (request) => {
    const body = PhoneCodeVerifyRequestSchema.parse(request.body);
    return transactionWithChallenge(async (client) => {
      const challenge = await verifyChallenge(client, { purpose: "password_reset", challengeId: body.phoneChallengeId, rawCode: body.smsCode });
      const userResult = await client.query("SELECT id FROM users WHERE phone_lookup_hmac = $1", [challenge.phone_lookup_hmac]);
      if (!userResult.rows[0]) throw businessError("RESET_UNAVAILABLE", "无法完成密码重置，请重新开始", 422);
      const resetToken = opaqueToken();
      await client.query("UPDATE password_reset_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL", [userResult.rows[0].id]);
      await client.query("INSERT INTO password_reset_tokens (id,user_id,token_hmac,expires_at) VALUES ($1,$2,$3,$4)", [uuidv7(), userResult.rows[0].id, tokenHash(resetToken), addMinutes(10)]);
      return { resetToken };
    });
  }));
  app.post("/api/auth/password-resets/complete", requireConfigured(async (request, reply) => {
    const body = PasswordResetCompleteRequestSchema.parse(request.body);
    const passwordHash = await passwordService.hash(body.password);
    await transaction(async (client) => {
      const result = await client.query("SELECT * FROM password_reset_tokens WHERE token_hmac = $1 FOR UPDATE", [tokenHash(body.resetToken)]);
      const token = result.rows[0];
      if (!token || token.consumed_at || new Date(token.expires_at) <= now()) throw businessError("RESET_TOKEN_INVALID", "重置链接已失效，请重新开始", 409);
      await client.query("UPDATE password_reset_tokens SET consumed_at = now() WHERE id = $1", [token.id]);
      await client.query("UPDATE users SET password_hash = $2,password_changed_at = now(),password_version = password_version + 1,session_version = session_version + 1 WHERE id = $1", [token.user_id, passwordHash]);
      await client.query("UPDATE auth_sessions SET revoked_at = now(),revoke_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL", [token.user_id]);
      await writeAudit(client, { id: token.user_id }, "password_reset_completed", "user", token.user_id);
    });
    return reply.code(204).send();
  }));
  app.decorate("jundeAuth", Object.freeze({ configured, transaction, businessError, sessionFor, adminReadSession, adminSession }));
}

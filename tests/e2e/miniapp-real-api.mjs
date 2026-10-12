// 真实 API 小程序流程：小程序（微信开发者工具）直连本机真实 Fastify API + 真实
// PostgreSQL 17。不使用 tests/fixtures/contract-server.mjs。
// 边界：人机验证插件组件在 fixture 副本中被剥离，测试在页面内注入 sandbox 票据
// （后端仍以真实 Provider 校验票据）；上传/COS 不在本流程覆盖。
// 流程：真实 HTTP 注册（sandbox 短信）→ 真实管理员审批 → 真实分配发布 →
// 小程序 UI 登录 → 定位页 → 日程页展示真实任务 → 任务详情发起真实打卡
// （开发者工具模拟定位在门店外，验证服务端范围拒绝的负向真实路径）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { createPasswordService } from "../../apps/api/src/auth/passwords.js";
import { uuidv7 } from "../../apps/api/src/ids.js";
import { seedRbac } from "../../db/seeds/rbac.mjs";
import { fileURLToPath } from "node:url";
import { deriveRealApiTestDatabaseUrl, loadRootEnvFile, postgresAdminUrl } from "./real-api-database.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// 连接串只经环境变量/根 .env 流转（存在才加载，不打印）：源码绝不内嵌凭证。
// 测试靶必须是回环主机上的独立 junde_realapi 库（派生+双闸校验），显式指向
// 源 junde / 生产 / 云端库一律失败关闭（deriveRealApiTestDatabaseUrl 强制）。
loadRootEnvFile(join(projectRoot, ".env"));
const DB_URL = deriveRealApiTestDatabaseUrl({
  databaseUrl: process.env.REAL_API_DATABASE_URL || process.env.DATABASE_URL,
  adminDatabaseUrl: process.env.REAL_API_ADMIN_DATABASE_URL || process.env.DATABASE_URL,
});
const API_PORT = Number(process.env.REAL_API_PORT || 3000);
const FIXED_CODE = "246810";
const WHITELIST = "+8613800138000";
const { createRequire } = await import("node:module");
const requireFromRoot = createRequire(join(projectRoot, "package.json"));
const automator = requireFromRoot("miniprogram-automator");
requireFromRoot("./tests/e2e/automator-compat.cjs");
const { prepareMiniappProjectForFixture, stopDevTools } = requireFromRoot("./tests/e2e/prepare-miniapp-fixture.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (url, options = {}) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  return { status: response.status, body, headers: response.headers };
};

// ---- 1. 准备真实数据库（独立库，避免污染本地自动化库） ----
// 管理连接由同一凭证派生（server 级 db=postgres），主机回环校验在 helper 内完成。
const adminPool = new pg.Pool({ connectionString: postgresAdminUrl(process.env.REAL_API_ADMIN_DATABASE_URL || process.env.DATABASE_URL), max: 1 });
await adminPool.query("DROP DATABASE IF EXISTS junde_realapi");
await adminPool.query("CREATE DATABASE junde_realapi");
await adminPool.end();

const pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
// 直接执行 db/migrations 全部迁移（与 npm run db:migrate 相同语义）
const { readdir, readFile } = await import("node:fs/promises");
const { createHash } = await import("node:crypto");
const migrations = (await readdir(join(projectRoot, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort();
const migrationClient = await pool.connect();
await migrationClient.query("BEGIN");
await migrationClient.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
for (const name of migrations) {
  const sql = await readFile(join(projectRoot, "db/migrations", name), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const exists = await migrationClient.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
  if (exists.rowCount) continue;
  await migrationClient.query(sql);
  await migrationClient.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)", [name, checksum]);
}
await migrationClient.query("COMMIT");
migrationClient.release();
await seedRbac(pool);

const AUTH_KEY = "realapi-test-key-realapi-test-key-1234";
const ENC_KEY = Buffer.alloc(32, 9).toString("base64");

// 管理员（TTY bootstrap 的测试等价物：真实 Argon2 哈希 + 真实角色）
const adminId = uuidv7();
await pool.query(
  "INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status) VALUES ($1,'RealApiAdmin','realapiadmin','真实管理员','cipher','lookup',now(),$2,'approved_active')",
  [adminId, await createPasswordService().hash("admin-secure-password-1")],
);
const role = await pool.query("SELECT id FROM roles WHERE code='super_admin'");
await pool.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), adminId, role.rows[0].id]);
await pool.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), adminId]);

// ---- 2. 启动真实 API ----
// 清理上一轮被强杀可能遗留的 API 孤儿进程，避免端口占用导致误连旧实例。
spawnSync("lsof", ["-ti", String(API_PORT)], { shell: true });
try {
  const { execSync } = await import("node:child_process");
  try { execSync(`lsof -ti:${API_PORT} | xargs kill -9 2>/dev/null || true`); } catch { /* 无占用 */ }
} catch { /* 无 lsof */ }
await sleep(1000);
const apiEnv = {
  ...process.env,
  NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(API_PORT),
  DATABASE_URL: DB_URL,
  AUTH_TOKEN_HMAC_KEY: AUTH_KEY, PHONE_ENCRYPTION_KEY_BASE64: ENC_KEY,
  AUTH_PROVIDER_MODE: "sandbox",
  SMS_SANDBOX_WHITELIST_PHONES: WHITELIST, SMS_SANDBOX_FIXED_CODE: FIXED_CODE,
  ADMIN_ORIGIN: "http://127.0.0.1:4184",
};
const api = spawn(process.execPath, [join(projectRoot, "apps/api/src/server.js")], { env: apiEnv, stdio: ["ignore", "pipe", "pipe"] });
let apiLog = "";
api.stdout.on("data", (chunk) => { apiLog += chunk; });
api.stderr.on("data", (chunk) => { apiLog += chunk; });
const apiBase = `http://127.0.0.1:${API_PORT}`;
let ready = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const health = await json(`${apiBase}/health/ready`);
    if (health.status === 200) { ready = true; break; }
  } catch { /* 未就绪 */ }
  await sleep(500);
}
assert.ok(ready, `real API did not become ready:\n${apiLog.slice(-800)}`);

const results = [];
const record = (name, passed, detail = "") => { results.push({ name, passed, detail }); console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };

try {
  // ---- 3. 真实注册（HTTP 全链路：sandbox 票据校验 → 短信投递 → 账号创建） ----
  const registerCode = await json(`${apiBase}/api/auth/register/phone-code`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "13800138000", captchaTicket: "sandbox-realapi-ticket", captchaRandstr: "sandbox-randstr", deviceFingerprint: "realapi-device-fingerprint" }),
  });
  record("register phone-code (real API)", registerCode.status === 200, JSON.stringify(registerCode.body));
  const phoneChallengeId = registerCode.body.phoneChallengeId;
  const registered = await json(`${apiBase}/api/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "realinspector1", phone: "13800138000", password: "inspector-password-1", confirmPassword: "inspector-password-1", phoneChallengeId, smsCode: FIXED_CODE }),
  });
  record("register (real API + real SMS challenge)", registered.status === 201, JSON.stringify(registered.body));

  // ---- 4. 真实管理员审批 ----
  const adminLogin = await json(`${apiBase}/api/admin/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "RealApiAdmin", password: "admin-secure-password-1" }),
  });
  record("admin login (real API)", adminLogin.status === 200);
  const cookie = adminLogin.headers.get("set-cookie").split(";")[0];
  const csrf = adminLogin.body.csrfToken;
  const adminHeaders = { cookie, "x-csrf-token": csrf, "idempotency-key": uuidv7(), "content-type": "application/json" };
  const registrations = await json(`${apiBase}/api/admin/inspector-registrations`, { headers: adminHeaders });
  const pending = registrations.body.items.find((item) => item.username === "realinspector1");
  record("registration listed for admin", Boolean(pending), JSON.stringify(pending));
  const approved = await json(`${apiBase}/api/admin/inspector-registrations/${pending.id}/approve`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ revision: pending.revision }),
  });
  record("approve registration (real API)", approved.status === 200);

  // ---- 5. 真实门店/题库/任务分配 ----
  const store = await json(`${apiBase}/api/admin/stores`, { headers: adminHeaders });
  record("stores listed (real API)", store.status === 200);
  let storeId = store.body.items.find((item) => item.name === "真实联调门店")?.id;
  if (!storeId) {
    const regionId = uuidv7();
    await pool.query("INSERT INTO regions (id,name,code) VALUES ($1,'上海','sh')", [regionId]);
    const createdStore = await json(`${apiBase}/api/admin/stores`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ name: "真实联调门店", businessNo: "S-REALAPI", regionId, address: "上海市测试路1号", latitudeGcj02: 31.2304, longitudeGcj02: 121.4737, providerPoiId: null, coordinateSource: "manual_adjusted", radiusMeters: 300, accuracyAllowanceMaxMeters: 200, locationVerified: true, active: true }),
    });
    record("create store (real API)", createdStore.status === 201, JSON.stringify(createdStore.body));
    storeId = createdStore.body.store?.id || createdStore.body.id;
  }
  // 题库版本（50 题）——通过真实 API 发布需要题目；用 SQL 种子创建后走真实发布接口。
  const templateId = uuidv7(); const versionId = uuidv7();
  await pool.query("INSERT INTO questionnaire_templates (id,name,mode,created_by) VALUES ($1,'真实联调题库','secret',$2)", [templateId, adminId]);
  await pool.query("INSERT INTO questionnaire_versions (id,template_id,version_number,status,created_by) VALUES ($1,$2,1,'draft',$3)", [versionId, templateId, adminId]);
  for (let number = 1; number <= 50; number += 1) {
    const id = uuidv7();
    await pool.query("INSERT INTO questions (id,version_id,question_key,question_number,category,text,max_score,sort_order) VALUES ($1,$2,$3,$4,$5,$6,2,$4)", [id, versionId, `q-${number}`, number, number <= 20 ? "environment" : number <= 42 ? "service" : "product", `第 ${number} 题`]);
    await pool.query("INSERT INTO question_evidence_requirements (question_id,evidence_required,image_required,audio_required,image_min_count,audio_min_count) VALUES ($1,false,false,false,0,0)", [id]);
  }
  const versionPublish = await json(`${apiBase}/api/admin/questionnaire-versions/${versionId}/publish`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ revision: 0 }),
  });
  record("publish questionnaire version (real API)", versionPublish.status === 200, JSON.stringify(versionPublish.body));
  const inspectorId = (await pool.query("SELECT id FROM users WHERE username_normalized='realinspector1'")).rows[0].id;
  const windowStart = new Date(Date.now() - 60_000).toISOString();
  const windowEnd = new Date(Date.now() + 3_600_000).toISOString();
  const campaign = await json(`${apiBase}/api/admin/campaigns`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ name: "真实联调任务", storeId, startsAt: windowStart, dueAt: windowEnd, commonInstruction: "真实联调" }),
  });
  record("create campaign (real API)", campaign.status === 201);
  const assignment = await json(`${apiBase}/api/admin/campaigns/${campaign.body.campaign.id}/assignments`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ inspectorId, questionnaireVersionId: versionId, taskType: "secret", startsAt: windowStart, dueAt: windowEnd, budgetLimit: 0, receiptRequired: true, specialInstruction: "", dishRequirements: [], campaignRevision: 0 }),
  });
  record("create assignment (real API)", assignment.status === 201);
  const campaignPublish = await json(`${apiBase}/api/admin/campaigns/${campaign.body.campaign.id}/publish`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ revision: 1 }),
  });
  record("publish campaign (real API)", campaignPublish.status === 200, JSON.stringify(campaignPublish.body));

  // ---- 6. 小程序 UI 直连真实 API ----
  const fixture = await prepareMiniappProjectForFixture();
  let miniProgram = null;
  for (let attempt = 0; attempt < 3 && !miniProgram; attempt += 1) {
    await stopDevTools();
    try {
      miniProgram = await automator.launch({ cliPath: "/Applications/wechatwebdevtools.app/Contents/MacOS/cli", projectPath: fixture.projectPath, trustProject: true, timeout: 300000 });
    } catch (error) {
      console.log(`devtools launch attempt ${attempt + 1} failed: ${String(error.message).slice(0, 120)}`);
      await sleep(10000);
    }
  }
  assert.ok(miniProgram, "unable to launch WeChat DevTools for the real-API flow");
  const exceptions = [];
  miniProgram.on("exception", (entry) => exceptions.push(entry));
  await miniProgram.callWxMethod("setStorageSync", "junde:session", { accessToken: "placeholder", user: { id: "x", displayName: "x", status: "approved_active" } });
  await miniProgram.evaluate(() => { getApp().globalData.apiBase = "http://127.0.0.1:3000"; getApp().globalData.session = null; });

  const openLogin = await miniProgram.reLaunch("/pages/login/index");
  await sleep(1500);
  const loginData = await miniProgram.evaluate(() => {
    const page = getCurrentPages().slice(-1)[0];
    return { route: page.route, mode: page.data.mode, step: page.data.step };
  });
  record("miniapp login page against real API base", loginData.route === "pages/login/index" && loginData.mode === "login", JSON.stringify(loginData));

  // UI 登录（真实 API）
  await miniProgram.evaluate(({ username, password }) => {
    const page = getCurrentPages().slice(-1)[0];
    page.setData({ username, password });
    page.submitLogin();
  }, { username: "realinspector1", password: "inspector-password-1" });
  await sleep(2500);
  const afterLogin = await miniProgram.evaluate(() => {
    const page = getCurrentPages().slice(-1)[0];
    return { route: page.route, step: page.data.step, accountStatus: page.data.accountStatus };
  });
  record("miniapp login via real API (approved_active → location page)", afterLogin.route === "pages/location/index", JSON.stringify(afterLogin));

  // 日程页展示真实分配
  const schedule = await miniProgram.reLaunch("/pages/schedule/index");
  await sleep(2500);
  const scheduleState = await miniProgram.evaluate(() => {
    const page = getCurrentPages().slice(-1)[0];
    return { route: page.route, loading: page.data.loading, error: page.data.error, count: (page.data.tasks || []).length };
  });
  record("miniapp schedule shows the real assignment", scheduleState.route === "pages/schedule/index" && scheduleState.loading === false && scheduleState.count >= 1 && !scheduleState.error, JSON.stringify(scheduleState));

  // 任务详情 + 真实打卡（开发者工具模拟定位在门店外 → 服务端负向真实路径）
  const tasks = await json(`${apiBase}/api/assignments/mine`, { headers: { authorization: `Bearer ${await sessionTokenOf(pool, "realinspector1")}` } });
  const realAssignment = tasks.body.items[0];
  const taskPage = await miniProgram.reLaunch(`/pages/task/index?assignmentId=${realAssignment.id}`);
  await sleep(2500);
  const taskState = await miniProgram.evaluate(() => {
    const page = getCurrentPages().slice(-1)[0];
    return { route: page.route, loading: page.data.loading, error: page.data.error, assignmentId: page.data.assignmentId };
  });
  record("miniapp task detail from real API", taskState.route === "pages/task/index" && !taskState.error && taskState.assignmentId === realAssignment.id, JSON.stringify(taskState));

  // 打卡 UI 路径：DevTools 模拟定位不受控，只断言页面进入打卡流程且无异常；
  // 服务端距离判定（正/负路径）用真实 API 直接验证。
  await miniProgram.evaluate(() => { const page = getCurrentPages().slice(-1)[0]; if (page.start) page.start(); });
  await sleep(2500);
  const afterCheckin = await miniProgram.evaluate(() => {
    const page = getCurrentPages().slice(-1)[0];
    return { route: page.route, locationMessage: page.data.locationMessage || "", error: page.data.error || "" };
  });
  record("miniapp enters the real check-in flow without exceptions", !afterCheckin.error && (afterCheckin.locationMessage || "").length > 0, JSON.stringify(afterCheckin));
  const inspectorToken = await sessionTokenOf(pool, "realinspector1");
  const inspectorAuth = { authorization: `Bearer ${inspectorToken}`, "content-type": "application/json" };
  const farCheckin = await json(`${apiBase}/api/assignments/${realAssignment.id}/check-in`, {
    method: "POST", headers: inspectorAuth,
    body: JSON.stringify({ latitude: 39.9088, longitude: 116.3975, accuracy: 10, capturedAt: new Date().toISOString() }),
  });
  record("real API check-in negative (Beijing coords vs Shanghai store)", farCheckin.body.result === "outside_radius", JSON.stringify(farCheckin.body));
  const nearCheckin = await json(`${apiBase}/api/assignments/${realAssignment.id}/check-in`, {
    method: "POST", headers: inspectorAuth,
    body: JSON.stringify({ latitude: 31.2304, longitude: 121.4737, accuracy: 10, capturedAt: new Date().toISOString() }),
  });
  record("real API check-in positive (store coords)", nearCheckin.body.result === "accepted", JSON.stringify(nearCheckin.body));
  const checkins = await pool.query("SELECT result, COUNT(*)::int count FROM audit_checkins GROUP BY result ORDER BY result");
  record("server recorded both real check-in attempts", checkins.rows.some((r) => r.result === "outside_radius") && checkins.rows.some((r) => r.result === "accepted"), JSON.stringify(checkins.rows));

  record("no miniapp runtime exceptions", exceptions.length === 0, `exceptions=${exceptions.length}`);
  await miniProgram.disconnect();
  await fixture.cleanup();
} finally {
  api.kill("SIGTERM");
  await pool.end();
  try { await stopDevTools(); } catch { /* 忽略 */ }
}

const passed = results.filter((r) => r.passed).length;
console.log(`\nreal API miniapp flow: ${passed}/${results.length} passed`);
if (passed !== results.length) { console.error(results.filter((r) => !r.passed).map((r) => r.name)); process.exitCode = 1; }

async function sessionTokenOf(pool, username) {
  // 真实登录换取会话 token（走真实 API 而不是直接查库）
  const login = await json(`${apiBase}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "inspector-password-1" }),
  });
  return login.body.accessToken;
}
